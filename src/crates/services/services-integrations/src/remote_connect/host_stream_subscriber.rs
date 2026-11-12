//! Controller-side reader of one host stream. No cache and no runtime work
//! live here: every page is fetched from the online host over encrypted device
//! RPC, and closing the subscriber only stops observing that host.
use super::{
    account::{AccountClient, AccountSession, StreamHint},
    host_stream::{StreamPage, StreamReadRequest, TurnHistoryRequest, MAX_TURN_HISTORY_PAGE_BYTES},
};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, oneshot};

const KEEPALIVE: Duration = Duration::from_secs(4 * 60);
/// Event budget of the first page of an open: enough to fill a transcript view,
/// so the session shows after one small read instead of a full 200-event /
/// 768 KiB page over the relay. Older pages follow in the background. Every
/// host honours `limit`. Transport pages are joined until their Turn membership
/// is complete; no transport budget is a presentation boundary.
const FIRST_PAGE_EVENTS: usize = 48;
const UNSUPPORTED_HOST_MESSAGE: &str = "The controlled device runs an older OpenBitFun version that does not support on-demand session streaming. Update OpenBitFun on that device to continue.";

#[derive(Deserialize)]
pub struct SessionEvent {
    pub session_id: String,
    pub event: String,
    pub payload: serde_json::Value,
}

/// Map an older host's "unknown command" rejection to an actionable message.
pub fn describe_stream_error(error: &anyhow::Error) -> String {
    let text = error.to_string();
    if text.contains("invalid RPC command")
        || text.contains("unknown variant")
        || text.contains("Could not parse device command")
    {
        UNSUPPORTED_HOST_MESSAGE.to_string()
    } else {
        text
    }
}

/// Host-facing calls of one subscriber. Production goes through encrypted
/// device RPC; tests substitute a scripted host.
#[async_trait::async_trait]
pub trait StreamTransport: Send + Sync {
    async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage>;
    async fn unsubscribe_stream(&self, stream_id: &str) -> Result<()>;
}

struct DeviceRpcTransport {
    account: AccountSession,
    relay: String,
    target: String,
    subscription_id: String,
    scoped_subscription: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl StreamTransport for DeviceRpcTransport {
    async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage> {
        let command = serde_json::json!({
            "cmd": "read_stream",
            "subscription_id": self.subscription_id,
            "stream_id": request.stream_id,
            "after": request.after,
            "before": request.before,
            "epoch": request.epoch,
            "limit": request.limit,
            "subscribe": request.subscribe,
            "turn_history": request.turn_history,
        });
        let response = AccountClient::new()
            .device_rpc(
                &self.relay,
                &self.account,
                &self.target,
                &command.to_string(),
            )
            .await?;
        let page = parse_stream_page(&response)?;
        let value: serde_json::Value = serde_json::from_str(&response)?;
        self.scoped_subscription.store(
            value["subscription_id"].as_str() == Some(&self.subscription_id),
            std::sync::atomic::Ordering::Release,
        );
        Ok(page)
    }

    async fn unsubscribe_stream(&self, stream_id: &str) -> Result<()> {
        // Old hosts share one lease across all readers on this device. A late
        // unscoped unsubscribe could silence the replacement reader, so leave
        // that lease to its existing expiry unless scoped cleanup was accepted.
        if !self
            .scoped_subscription
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        let command = serde_json::json!({"cmd":"unsubscribe_stream","stream_id":stream_id,"subscription_id":self.subscription_id});
        AccountClient::new()
            .device_rpc(
                &self.relay,
                &self.account,
                &self.target,
                &command.to_string(),
            )
            .await?;
        Ok(())
    }
}

/// Decode a `read_stream` answer; remote errors keep the host's own message so
/// an older host's rejection can be recognized by `describe_stream_error`.
pub fn parse_stream_page(response: &str) -> Result<StreamPage> {
    let value: serde_json::Value = serde_json::from_str(response)?;
    match value["resp"].as_str() {
        Some("stream_page") => Ok(serde_json::from_value(value)?),
        Some("error") => Err(anyhow!(
            "{}",
            value["message"].as_str().unwrap_or("Remote error")
        )),
        other => Err(anyhow!("unexpected stream response: {other:?}")),
    }
}

pub struct HostStreamSubscriber {
    older: mpsc::Sender<oneshot::Sender<Result<()>>>,
    worker: tokio::task::JoinHandle<()>,
    unsubscribe: Option<Box<dyn FnOnce() + Send>>,
}

#[derive(Clone)]
struct Reader {
    transport: Arc<dyn StreamTransport>,
    session_id: String,
    emit: Arc<dyn Fn(SessionEvent) -> Result<()> + Send + Sync>,
    epoch: u64,
    cursor: u64,
    oldest: u64,
    has_more: bool,
    /// Set only after a host acknowledges the optional Turn-history offer.
    turn_history: bool,
    before_turn: Option<usize>,
}

impl Reader {
    async fn read(&self, request: StreamReadRequest) -> Result<StreamPage> {
        let page = self.transport.read_stream(request).await?;
        if page.stream_id != self.session_id {
            bail!("stream page identity mismatch");
        }
        Ok(page)
    }

    /// A root's optional membership list proves which records form a whole
    /// Turn, even when live updates moved that root ahead of unchanged items.
    /// Old hosts have no such proof: finish their bounded pages before exposing
    /// history, rather than guessing from a header, count, or elapsed time.
    async fn read_history(&self, request: StreamReadRequest) -> Result<StreamPage> {
        let expected_epoch = request.epoch;
        let mut page = self.read(request).await?;
        if expected_epoch.is_some_and(|epoch| epoch != page.epoch) {
            return Ok(page);
        }
        if page.turn_history.is_some() {
            return self.join_turn_snapshot(page).await;
        }
        if self.turn_history && expected_epoch.is_some() {
            bail!("The host stopped supporting Turn history; reopen the session to retry");
        }
        let mut record_ids = HashSet::<String>::new();
        let mut turns = HashMap::<String, Option<(u64, Vec<String>)>>::new();
        let mut batches = Vec::new();
        loop {
            for event in &page.events {
                if event.event != "session-record" {
                    continue;
                }
                let payload = &event.payload;
                let Some(id) = payload["id"].as_str() else {
                    continue;
                };
                record_ids.insert(id.to_owned());
                let Some(turn_id) = payload.pointer("/turn/turnId").and_then(|id| id.as_str())
                else {
                    continue;
                };
                let membership = turns.entry(turn_id.to_owned()).or_default();
                if id == format!("turn/{turn_id}") {
                    if let Some(ids) = payload.get("turnRecordIds") {
                        let ids: Vec<String> = serde_json::from_value(ids.clone())
                            .context("Invalid history Turn membership")?;
                        if !ids.iter().any(|key| key == id) {
                            bail!("History Turn membership omitted its root");
                        }
                        let revision = payload["revision"].as_u64().unwrap_or(event.seq);
                        if membership.as_ref().is_none_or(|(old, _)| revision > *old) {
                            *membership = Some((revision, ids));
                        }
                    }
                }
            }
            let complete = !turns.is_empty()
                && turns.values().all(|membership| {
                    membership
                        .as_ref()
                        .is_some_and(|(_, ids)| ids.iter().all(|id| record_ids.contains(id)))
                });
            let missing_record = turns
                .values()
                .flatten()
                .any(|(_, ids)| ids.iter().any(|id| !record_ids.contains(id)));
            if complete || !page.has_more {
                if !complete && (page.truncated || missing_record) {
                    bail!("The host could not provide a complete history Turn; reopen the session to retry");
                }
                // Reads travel backwards; delivery stays chronological. This
                // also preserves ordering of runtime controls between records.
                for batch in batches.into_iter().rev() {
                    page.events.extend(batch);
                }
                return Ok(page);
            }
            let before = page
                .events
                .first()
                .map(|event| event.seq)
                .context("History page did not advance")?;
            let older = self
                .read(StreamReadRequest {
                    stream_id: self.session_id.clone(),
                    before: Some(before),
                    epoch: Some(page.epoch),
                    subscribe: true,
                    ..Default::default()
                })
                .await?;
            if older.epoch != page.epoch {
                bail!(
                    "Session history restarted while reading a Turn; reopen the session to retry"
                );
            }
            if older
                .events
                .first()
                .is_some_and(|event| event.seq >= before)
                || (older.events.is_empty() && older.has_more)
            {
                bail!("History page did not advance");
            }
            batches.push(page.events);
            // Forward catch-up starts at the snapshot with which this read
            // began. Later appends must still be delivered by catch_up.
            let cursor = page.cursor;
            page = older;
            page.cursor = cursor;
        }
    }

    async fn join_turn_snapshot(&self, mut page: StreamPage) -> Result<StreamPage> {
        let snapshot = page
            .turn_history
            .clone()
            .context("Turn history acknowledgement missing")?;
        if snapshot.version != 1 || snapshot.offset != 0 {
            bail!("Invalid Turn history acknowledgement");
        }
        let mut events = Vec::new();
        loop {
            let part = page
                .turn_history
                .as_ref()
                .context("Turn history continuation is unsupported")?;
            if part.version != snapshot.version
                || part.snapshot_id != snapshot.snapshot_id
                || part.turn_id != snapshot.turn_id
                || part.record_count != snapshot.record_count
                || part.before_turn != snapshot.before_turn
                || part.offset != events.len()
                || page.has_more != snapshot.before_turn.is_some()
            {
                bail!("Turn history snapshot changed during the read");
            }
            let next = part.next_offset;
            events.append(&mut page.events);
            if events.len() > snapshot.record_count {
                bail!("Turn history exceeded its record count");
            }
            let Some(offset) = next else {
                break;
            };
            if offset != events.len() || offset <= part.offset || offset >= snapshot.record_count {
                bail!("Turn history continuation did not advance");
            }
            let older = self
                .read(StreamReadRequest {
                    stream_id: self.session_id.clone(),
                    epoch: Some(page.epoch),
                    subscribe: true,
                    turn_history: Some(TurnHistoryRequest {
                        version: 1,
                        snapshot_id: Some(snapshot.snapshot_id.clone()),
                        offset,
                        before_turn: None,
                        max_bytes: Some(MAX_TURN_HISTORY_PAGE_BYTES),
                    }),
                    ..Default::default()
                })
                .await?;
            if older.epoch != page.epoch || older.cursor != page.cursor {
                bail!(
                    "Session history restarted while reading a Turn; reopen the session to retry"
                );
            }
            page = older;
        }
        if events.len() != snapshot.record_count {
            bail!("Incomplete Turn history snapshot");
        }
        let mut ids = HashSet::new();
        for event in &events {
            if event.event != "session-record"
                || event.payload["sessionId"].as_str() != Some(self.session_id.as_str())
                || event
                    .payload
                    .pointer("/turn/turnId")
                    .and_then(|id| id.as_str())
                    != snapshot.turn_id.as_deref()
                || event.payload["revision"].as_u64() != Some(page.cursor)
                || !event.payload["id"]
                    .as_str()
                    .is_some_and(|id| ids.insert(id))
            {
                bail!("Invalid Turn history snapshot record");
            }
        }
        if let Some(turn) = &snapshot.turn_id {
            if !ids.contains(format!("turn/{turn}").as_str()) {
                bail!("Turn history snapshot root missing");
            }
        } else if !events.is_empty() {
            bail!("Turn history snapshot identity missing");
        }
        page.events = events;
        page.turn_history = Some(super::host_stream::TurnHistoryPage {
            offset: 0,
            next_offset: None,
            ..snapshot
        });
        Ok(page)
    }

    fn emit_page(&self, page: &StreamPage, history: bool) -> Result<()> {
        for event in &page.events {
            let mut payload = event.payload.clone();
            if history && event.event == "session-record" {
                // Controller-local annotation: the frontend stages only replay
                // records, so an older read cannot hold up live output.
                payload["historyReplay"] = true.into();
            }
            (self.emit)(SessionEvent {
                session_id: self.session_id.clone(),
                event: event.event.clone(),
                payload,
            })?;
        }
        Ok(())
    }

    fn emit_ready(&self) -> Result<()> {
        self.emit_ready_kind(false)
    }

    fn emit_ready_kind(&self, live: bool) -> Result<()> {
        let mut payload = serde_json::json!({"sessionId":self.session_id,"hasMore":self.has_more,"oldestSeq":self.oldest,"cursor":self.cursor,"historyBatches":true});
        if live {
            // Controller-local recovery, not the end of an older history page.
            payload["live"] = true.into();
        }
        (self.emit)(SessionEvent {
            session_id: self.session_id.clone(),
            event: "relay://session-ready".into(),
            payload,
        })
    }

    /// Latest page first, like opening a chat at its bottom.
    async fn resync(&mut self) -> Result<()> {
        let started = std::time::Instant::now();
        let page = self
            .read_history(StreamReadRequest {
                stream_id: self.session_id.clone(),
                subscribe: true,
                limit: Some(FIRST_PAGE_EVENTS),
                turn_history: Some(TurnHistoryRequest {
                    max_bytes: Some(MAX_TURN_HISTORY_PAGE_BYTES),
                    ..TurnHistoryRequest::latest()
                }),
                ..Default::default()
            })
            .await?;
        self.epoch = page.epoch;
        self.cursor = page.cursor;
        self.oldest = page
            .events
            .first()
            .map(|event| event.seq)
            .unwrap_or(page.cursor + 1);
        self.has_more = page.has_more;
        self.turn_history = page.turn_history.is_some();
        self.before_turn = page
            .turn_history
            .as_ref()
            .and_then(|history| history.before_turn);
        log::debug!("Session first history ready: session_id={} turn_snapshot={} records={} has_more={} elapsed_ms={}",
            self.session_id, self.turn_history, page.events.len(), page.has_more, started.elapsed().as_millis());
        self.emit_page(&page, true)?;
        self.emit_ready()
    }

    /// Returns false when the host restarted the stream and a resync is needed.
    async fn catch_up(&mut self) -> Result<bool> {
        loop {
            let page = self
                .read(StreamReadRequest {
                    stream_id: self.session_id.clone(),
                    after: Some(self.cursor),
                    epoch: Some(self.epoch),
                    subscribe: true,
                    ..Default::default()
                })
                .await?;
            if page.epoch != self.epoch {
                return Ok(false);
            }
            self.emit_page(&page, false)?;
            if let Some(last) = page.events.last() {
                self.cursor = self.cursor.max(last.seq);
            }
            if !page.has_more {
                // The host's newest sequence may belong to an evicted control
                // event; adopt it so the next hint compares against it.
                self.cursor = self.cursor.max(page.cursor);
                return Ok(true);
            }
        }
    }

    /// Catch up after a hint, a reconnect or a keepalive tick. A host that
    /// restarted the stream is announced as a gap and replayed from its latest page.
    async fn refresh(&mut self) -> Result<()> {
        if self.catch_up().await? {
            return Ok(());
        }
        self.gap("host stream restarted")?;
        self.resync().await
    }

    async fn read_older_page(&self) -> Result<StreamPage> {
        self.read_history(StreamReadRequest {
            stream_id: self.session_id.clone(),
            before: (!self.turn_history).then_some(self.oldest),
            turn_history: self.turn_history.then(|| TurnHistoryRequest {
                max_bytes: Some(MAX_TURN_HISTORY_PAGE_BYTES),
                before_turn: self.before_turn,
                ..TurnHistoryRequest::latest()
            }),
            epoch: Some(self.epoch),
            subscribe: true,
            ..Default::default()
        })
        .await
    }

    fn apply_older_page(&mut self, page: StreamPage) -> Result<bool> {
        if page.epoch != self.epoch {
            return Ok(false);
        }
        if self.turn_history && page.turn_history.is_none() {
            bail!("The host stopped supporting Turn history; reopen the session to retry");
        }
        self.emit_page(&page, true)?;
        if let Some(first) = page.events.first() {
            self.oldest = first.seq;
        }
        self.has_more = page.has_more;
        self.before_turn = page
            .turn_history
            .as_ref()
            .and_then(|history| history.before_turn);
        self.emit_ready()?;
        Ok(true)
    }

    async fn load_older(&mut self) -> Result<bool> {
        if !self.has_more {
            return Ok(true);
        }
        let page = self.read_older_page().await?;
        self.apply_older_page(page)
    }

    /// Announce a restarted stream. A full replay from the latest page always
    /// follows, so `resync` tells the controller to rebuild its records from
    /// that replay: the new epoch carries no tombstones for what it dropped.
    /// Gaps appended by the host itself stay inside one epoch and omit it.
    fn gap(&self, reason: &str) -> Result<()> {
        (self.emit)(SessionEvent {
            session_id: self.session_id.clone(),
            event: "relay://session-gap".into(),
            payload: serde_json::json!({"sessionId":self.session_id,"reason":reason,"resync":true}),
        })
    }

    fn hint_is_new(&self, hint: &StreamHint, target: &str) -> bool {
        hint.source_device_id == target
            && hint.stream_id == self.session_id
            && (hint.epoch != self.epoch || hint.cursor > self.cursor)
    }
}

struct LiveRecovery {
    retry_at: Option<tokio::time::Instant>,
    delay: Duration,
}

impl Default for LiveRecovery {
    fn default() -> Self {
        Self {
            retry_at: None,
            delay: Duration::from_secs(1),
        }
    }
}

async fn retry_due(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

impl LiveRecovery {
    async fn refresh(&mut self, reader: &mut Reader, error: &(dyn Fn(String) + Send + Sync)) {
        let result = reader.refresh().await.and_then(|()| {
            if self.retry_at.is_some() {
                reader.emit_ready_kind(true)
            } else {
                Ok(())
            }
        });
        match result {
            Ok(()) => *self = Self::default(),
            Err(failure) => {
                self.retry_at = Some(tokio::time::Instant::now() + self.delay);
                self.delay = (self.delay * 2).min(Duration::from_secs(30));
                error(describe_stream_error(&failure));
            }
        }
    }
}

impl HostStreamSubscriber {
    pub async fn start(
        account: AccountSession,
        relay: String,
        target: String,
        session_id: String,
        emit: Arc<dyn Fn(SessionEvent) -> Result<()> + Send + Sync>,
        error: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self> {
        let hints = account.stream_hints();
        let transport = Arc::new(DeviceRpcTransport {
            account,
            relay,
            target: target.clone(),
            subscription_id: uuid::Uuid::new_v4().to_string(),
            scoped_subscription: std::sync::atomic::AtomicBool::new(false),
        });
        Self::start_with_transport(transport, hints, target, session_id, emit, error).await
    }

    /// Wire-independent entry point; `hints` carries decrypted stream hints for
    /// this account and `target` names the host device whose hints apply.
    pub async fn start_with_transport(
        transport: Arc<dyn StreamTransport>,
        mut hints: broadcast::Receiver<Option<StreamHint>>,
        target: String,
        session_id: String,
        emit: Arc<dyn Fn(SessionEvent) -> Result<()> + Send + Sync>,
        error: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self> {
        let mut reader = Reader {
            transport: transport.clone(),
            session_id: session_id.clone(),
            emit,
            epoch: 0,
            cursor: 0,
            oldest: 1,
            has_more: false,
            turn_history: false,
            before_turn: None,
        };
        // The first page is awaited so an unsupported or offline host fails the
        // open call instead of retrying silently in the background.
        reader
            .resync()
            .await
            .map_err(|error| anyhow!("{}", describe_stream_error(&error)))?;
        let (older, mut older_requests) = mpsc::channel::<oneshot::Sender<Result<()>>>(1);
        let worker = tokio::spawn(async move {
            let mut recovery = LiveRecovery::default();
            let mut keepalive = tokio::time::interval(KEEPALIVE);
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            keepalive.tick().await;
            loop {
                let wake = tokio::select! {
                    hint = hints.recv() => match hint {
                        Ok(Some(hint)) => {
                            if !reader.hint_is_new(&hint, &target) || recovery.retry_at.is_some() {
                                continue;
                            }
                            Wake::Refresh
                        }
                        Ok(None) | Err(broadcast::error::RecvError::Lagged(_)) => Wake::Refresh,
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                    _ = keepalive.tick() => Wake::Refresh,
                    _ = retry_due(recovery.retry_at) => Wake::Refresh,
                    request = older_requests.recv() => match request {
                        Some(reply) if !reply.is_closed() => Wake::Older(reply),
                        Some(_) => continue,
                        None => return,
                    },
                };
                match wake {
                    Wake::Refresh => {
                        recovery.refresh(&mut reader, error.as_ref()).await;
                    }
                    Wake::Older(reply) => {
                        // A large historical Turn may span several RPCs. Its
                        // immutable snapshot lets live catch-up keep running;
                        // no user message or approval waits behind those bytes.
                        let read = if reader.turn_history && reader.has_more {
                            let history_reader = reader.clone();
                            let page = history_reader.read_older_page();
                            tokio::pin!(page);
                            let result = loop {
                                tokio::select! {
                                    result = &mut page => break result,
                                    hint = hints.recv() => {
                                        let refresh = match hint {
                                            Ok(Some(hint)) => recovery.retry_at.is_none() && reader.hint_is_new(&hint, &target),
                                            Ok(None) | Err(broadcast::error::RecvError::Lagged(_)) => true,
                                            Err(broadcast::error::RecvError::Closed) => return,
                                        };
                                        if refresh {
                                            recovery.refresh(&mut reader, error.as_ref()).await;
                                            if reader.epoch != history_reader.epoch {
                                                break Err(anyhow!("Session history restarted during the older read"));
                                            }
                                        }
                                    }
                                    _ = retry_due(recovery.retry_at) => {
                                        recovery.refresh(&mut reader, error.as_ref()).await;
                                        if reader.epoch != history_reader.epoch {
                                            break Err(anyhow!("Session history restarted during the older read"));
                                        }
                                    }
                                    _ = keepalive.tick() => {
                                        recovery.refresh(&mut reader, error.as_ref()).await;
                                        if reader.epoch != history_reader.epoch {
                                            break Err(anyhow!("Session history restarted during the older read"));
                                        }
                                    }
                                }
                            };
                            result.and_then(|page| reader.apply_older_page(page))
                        } else {
                            reader.load_older().await
                        };
                        let result = match read {
                            Ok(true) => Ok(()),
                            Ok(false) => {
                                let _ = reader.gap("host stream restarted");
                                reader.resync().await.and(Err(anyhow!(
                                    "Session history restarted on the host; reloaded from its latest page"
                                )))
                            }
                            Err(error) => Err(error),
                        };
                        let _ = reply.send(result);
                        continue;
                    }
                };
            }
        });
        let unsubscribe = Box::new(move || {
            tokio::spawn(async move {
                if let Err(error) = transport.unsubscribe_stream(&session_id).await {
                    log::debug!("Host stream unsubscribe skipped: {error}");
                }
            });
        });
        Ok(Self {
            worker,
            older,
            unsubscribe: Some(unsubscribe),
        })
    }

    pub fn load_older(&self) -> impl std::future::Future<Output = Result<()>> + Send + 'static {
        let older = self.older.clone();
        async move {
            let (send, receive) = oneshot::channel();
            tokio::time::timeout(Duration::from_secs(120), async {
                older
                    .send(send)
                    .await
                    .map_err(|_| anyhow!("Session subscriber closed"))?;
                receive.await.context("Session subscriber closed")?
            })
            .await
            .context("Session history page timed out")?
        }
    }

    pub fn close(&mut self) {
        self.worker.abort();
        if let Some(unsubscribe) = self.unsubscribe.take() {
            unsubscribe();
        }
    }
}

impl Drop for HostStreamSubscriber {
    fn drop(&mut self) {
        self.close();
    }
}

enum Wake {
    Refresh,
    Older(oneshot::Sender<Result<()>>),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_connect::host_stream::{HostStreamHub, HostStreamNotifier};
    use std::sync::Mutex;

    /// A scripted host: a real `HostStreamHub` answering reads for one device,
    /// with hints re-broadcast the way `AccountSession::deliver_device_event`
    /// would after decrypting them.
    struct HubTransport {
        hub: Mutex<Arc<HostStreamHub>>,
        device: String,
        unsubscribed: Mutex<Vec<String>>,
        reads: Mutex<Vec<StreamReadRequest>>,
    }

    #[async_trait::async_trait]
    impl StreamTransport for HubTransport {
        async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage> {
            self.reads.lock().unwrap().push(request.clone());
            let hub = self.hub.lock().unwrap().clone();
            hub.read(&self.device, &request)
        }

        async fn unsubscribe_stream(&self, stream_id: &str) -> Result<()> {
            self.hub
                .lock()
                .unwrap()
                .unsubscribe(&self.device, stream_id);
            self.unsubscribed.lock().unwrap().push(stream_id.to_owned());
            Ok(())
        }
    }

    struct HintFanout(broadcast::Sender<Option<StreamHint>>, String);
    impl HostStreamNotifier for HintFanout {
        fn notify(&self, target_device_id: &str, payload: serde_json::Value) {
            let _ = self.0.send(Some(StreamHint {
                source_device_id: self.1.clone(),
                stream_id: payload["stream_id"].as_str().unwrap().to_owned(),
                epoch: payload["epoch"].as_u64().unwrap(),
                cursor: payload["cursor"].as_u64().unwrap(),
            }));
            let _ = target_device_id;
        }
    }

    struct Lab {
        hub: Arc<HostStreamHub>,
        transport: Arc<HubTransport>,
        hints: broadcast::Sender<Option<StreamHint>>,
        events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
        errors: Arc<Mutex<Vec<String>>>,
    }

    fn lab() -> Lab {
        let (hints, _) = broadcast::channel(16);
        let hub = HostStreamHub::start(Arc::new(HintFanout(hints.clone(), "desktop".into())));
        let transport = Arc::new(HubTransport {
            hub: Mutex::new(hub.clone()),
            device: "phone".into(),
            unsubscribed: Mutex::new(Vec::new()),
            reads: Mutex::new(Vec::new()),
        });
        Lab {
            hub,
            transport,
            hints,
            events: Arc::new(Mutex::new(Vec::new())),
            errors: Arc::new(Mutex::new(Vec::new())),
        }
    }

    impl Lab {
        async fn subscribe(&self, session: &str) -> Result<HostStreamSubscriber> {
            let events = self.events.clone();
            let errors = self.errors.clone();
            HostStreamSubscriber::start_with_transport(
                self.transport.clone(),
                self.hints.subscribe(),
                "desktop".into(),
                session.into(),
                Arc::new(move |event: SessionEvent| {
                    events.lock().unwrap().push((event.event, event.payload));
                    Ok(())
                }),
                Arc::new(move |error| errors.lock().unwrap().push(error)),
            )
            .await
        }

        fn events(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|(event, _)| event.clone())
                .collect()
        }

        async fn settle(&self) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    fn record(session: &str, turn: &str, status: &str) -> serde_json::Value {
        serde_json::json!({"sessionId":session,"id":format!("turn/{turn}"),"turnRecordIds":[format!("turn/{turn}")],"turn":{"turnId":turn,"sessionId":session,"status":status}})
    }

    struct ScriptedHistory {
        pages: Mutex<std::collections::VecDeque<StreamPage>>,
        reads: Mutex<Vec<StreamReadRequest>>,
    }
    #[async_trait::async_trait]
    impl StreamTransport for ScriptedHistory {
        async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage> {
            self.reads.lock().unwrap().push(request);
            self.pages
                .lock()
                .unwrap()
                .pop_front()
                .context("Unexpected history read")
        }
        async fn unsubscribe_stream(&self, _: &str) -> Result<()> {
            Ok(())
        }
    }
    fn history_page(seq: u64, records: Vec<serde_json::Value>, has_more: bool) -> StreamPage {
        use super::super::host_stream::StreamEvent;
        StreamPage {
            stream_id: "s".into(),
            epoch: 1,
            events: records
                .into_iter()
                .enumerate()
                .map(|(index, mut payload)| {
                    payload["revision"] = (seq + index as u64).into();
                    StreamEvent {
                        seq: seq + index as u64,
                        event: "session-record".into(),
                        payload,
                    }
                })
                .collect(),
            has_more,
            cursor: 100,
            oldest_seq: 1,
            truncated: false,
            turn_history: None,
        }
    }
    fn scripted_reader(
        pages: Vec<StreamPage>,
    ) -> (Reader, Arc<ScriptedHistory>, Arc<Mutex<Vec<SessionEvent>>>) {
        let transport = Arc::new(ScriptedHistory {
            pages: Mutex::new(pages.into()),
            reads: Mutex::new(Vec::new()),
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        (
            Reader {
                transport: transport.clone(),
                session_id: "s".into(),
                emit: Arc::new(move |event| {
                    output.lock().unwrap().push(event);
                    Ok(())
                }),
                epoch: 0,
                cursor: 0,
                oldest: 1,
                has_more: false,
                turn_history: false,
                before_turn: None,
            },
            transport,
            events,
        )
    }
    fn item(id: &str) -> serde_json::Value {
        serde_json::json!({"sessionId":"s","id":format!("item/{id}"),"turn":{"turnId":"one","sessionId":"s","status":"completed"},"round":{"id":"r","turnId":"one"},"item":{"type":"text","data":{"id":id}}})
    }

    #[tokio::test]
    async fn history_waits_for_all_members_even_when_the_terminal_root_arrived_first() {
        let mut root = record("s", "one", "completed");
        root["turnRecordIds"] = serde_json::json!(["turn/one", "item/a", "item/b", "item/c"]);
        let (mut reader, transport, events) = scripted_reader(vec![
            history_page(8, vec![root, item("c")], true),
            history_page(5, vec![item("b")], true),
            history_page(2, vec![item("a")], true),
        ]);
        reader.resync().await.unwrap();
        let reads = transport.reads.lock().unwrap();
        assert_eq!(
            reads.iter().map(|read| read.before).collect::<Vec<_>>(),
            vec![None, Some(8), Some(5)]
        );
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 5);
        assert_eq!(events[0].payload["id"], "item/a");
        assert_eq!(events[3].payload["id"], "item/c");
        assert_eq!(events[4].event, "relay://session-ready");
        assert_eq!(events[4].payload["hasMore"], true);
        assert_eq!(events[4].payload["oldestSeq"], 2);
        assert_eq!(events[4].payload["cursor"], 100);
    }

    #[tokio::test]
    async fn legacy_pages_without_membership_remain_readable_and_publish_once_complete() {
        let mut root = record("s", "one", "completed");
        root.as_object_mut().unwrap().remove("turnRecordIds");
        // Round trip the old wire shape, without inventing a new capability.
        let first: StreamPage = serde_json::from_value(
            serde_json::to_value(history_page(8, vec![root], true)).unwrap(),
        )
        .unwrap();
        let (mut reader, transport, events) = scripted_reader(vec![
            first,
            history_page(5, vec![item("b")], true),
            history_page(1, vec![item("a")], false),
        ]);
        reader.resync().await.unwrap();
        assert_eq!(transport.reads.lock().unwrap().len(), 3);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events.last().unwrap().payload["hasMore"], false);
        assert_eq!(events[0].payload["item"]["data"]["id"], "a");
    }

    #[tokio::test]
    async fn missing_members_and_failed_continuations_never_emit_partial_turns() {
        for has_more in [false, true] {
            let mut root = record("s", "one", "completed");
            root["turnRecordIds"] = serde_json::json!(["turn/one", "item/missing"]);
            let (mut reader, _, events) =
                scripted_reader(vec![history_page(8, vec![root], has_more)]);
            assert!(reader.resync().await.is_err());
            assert!(events.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn continuation_epoch_changes_and_stalled_cursors_never_publish_fragments() {
        for kind in ["epoch", "empty", "same-cursor"] {
            let mut root = record("s", "one", "completed");
            root["turnRecordIds"] = serde_json::json!(["turn/one", "item/a"]);
            let mut older = history_page(
                if kind == "same-cursor" { 8 } else { 2 },
                vec![item("a")],
                true,
            );
            if kind == "epoch" {
                older.epoch = 2;
            }
            if kind == "empty" {
                older.events.clear();
            }
            let (mut reader, _, events) =
                scripted_reader(vec![history_page(8, vec![root], true), older]);
            assert!(reader.resync().await.is_err(), "{kind}");
            assert!(events.lock().unwrap().is_empty(), "{kind}");
        }
    }

    #[tokio::test]
    async fn a_control_only_page_does_not_complete_an_empty_transcript() {
        let mut controls = history_page(8, vec![serde_json::json!({"sessionId":"s"})], true);
        controls.events[0].event = "session-interaction-changed".into();
        let (mut reader, transport, events) = scripted_reader(vec![
            controls,
            history_page(2, vec![record("s", "one", "completed")], true),
        ]);
        reader.resync().await.unwrap();
        assert_eq!(transport.reads.lock().unwrap().len(), 2);
        let events = events.lock().unwrap();
        assert_eq!(events[0].payload["id"], "turn/one");
        assert_eq!(events[2].event, "relay://session-ready");
    }

    #[tokio::test]
    async fn turn_snapshot_chunks_publish_once_and_reject_a_changed_snapshot_without_fragments() {
        for invalid in [false, true] {
            let mut first = history_page(8, vec![record("s", "one", "completed"), item("a")], true);
            let mut next = history_page(5, vec![item("b")], true);
            for (page, offset, next_offset) in [(&mut first, 0, Some(2)), (&mut next, 2, None)] {
                for event in &mut page.events {
                    event.seq = 100;
                    event.payload["revision"] = 100.into();
                }
                page.turn_history = Some(super::super::host_stream::TurnHistoryPage {
                    version: 1,
                    snapshot_id: "snapshot".into(),
                    turn_id: Some("one".into()),
                    record_count: 3,
                    offset,
                    next_offset,
                    before_turn: Some(1),
                });
            }
            if invalid {
                next.cursor += 1;
            }
            let (mut reader, transport, events) = scripted_reader(vec![first, next]);
            let result = reader.resync().await;
            if invalid {
                assert!(result.is_err());
                assert!(events.lock().unwrap().is_empty());
            } else {
                result.unwrap();
                assert_eq!(transport.reads.lock().unwrap().len(), 2);
                assert!(reader.turn_history);
                assert_eq!(reader.before_turn, Some(1));
                let emitted = events.lock().unwrap();
                assert_eq!(emitted.len(), 4);
                assert!(emitted[..3]
                    .iter()
                    .all(|event| event.payload["historyReplay"] == true));
                assert_eq!(emitted[3].event, "relay://session-ready");
            }
        }
    }

    #[tokio::test]
    async fn older_snapshot_io_does_not_block_live_catch_up_and_never_publishes_half_a_turn() {
        live_catch_up_during_older_snapshot(false).await;
    }

    #[tokio::test]
    async fn failed_live_read_retries_while_older_snapshot_io_is_blocked() {
        live_catch_up_during_older_snapshot(true).await;
    }

    async fn live_catch_up_during_older_snapshot(fail_once: bool) {
        tokio::time::pause();
        use super::super::host_stream::HistoryBatch;
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Transport {
            hub: Arc<HostStreamHub>,
            blocked: tokio::sync::Notify,
            release: tokio::sync::Notify,
            reads: AtomicUsize,
            failures_left: AtomicUsize,
        }
        #[async_trait::async_trait]
        impl StreamTransport for Transport {
            async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage> {
                if request
                    .turn_history
                    .as_ref()
                    .is_some_and(|history| history.offset > 0)
                {
                    self.blocked.notify_one();
                    self.release.notified().await;
                }
                if request.after.is_some()
                    && self
                        .failures_left
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                            left.checked_sub(1)
                        })
                        .is_ok()
                {
                    bail!("temporary lost live reply during history read");
                }
                self.hub
                    .read_history("controller", &request, |before| {
                        self.reads.fetch_add(1, Ordering::SeqCst);
                        async move {
                            if before.is_none() {
                                return Ok(HistoryBatch {
                                    records: vec![record("s", "latest", "inprogress")],
                                    before: Some(1),
                                });
                            }
                            assert_eq!(before, Some(1));
                            let mut records = vec![record("s", "one", "completed")];
                            records.extend((0..201).map(|index| item(&index.to_string())));
                            Ok(HistoryBatch {
                                records,
                                before: None,
                            })
                        }
                    })
                    .await
            }
            async fn unsubscribe_stream(&self, session: &str) -> Result<()> {
                self.hub.unsubscribe("controller", session);
                Ok(())
            }
        }
        let (hints, _) = broadcast::channel(16);
        let hub = HostStreamHub::start(Arc::new(HintFanout(hints.clone(), "desktop".into())));
        let transport = Arc::new(Transport {
            hub: hub.clone(),
            blocked: Default::default(),
            release: Default::default(),
            reads: AtomicUsize::new(0),
            failures_left: AtomicUsize::new(usize::from(fail_once)),
        });
        let events = Arc::new(Mutex::new(Vec::<SessionEvent>::new()));
        let live = Arc::new(tokio::sync::Notify::new());
        let output = events.clone();
        let live_signal = live.clone();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let failures = errors.clone();
        let subscriber = HostStreamSubscriber::start_with_transport(
            transport.clone(),
            hints.subscribe(),
            "desktop".into(),
            "s".into(),
            Arc::new(move |event| {
                if event.payload["id"] == "turn/latest" && event.payload["historyReplay"].is_null()
                {
                    live_signal.notify_one();
                }
                output.lock().unwrap().push(event);
                Ok(())
            }),
            Arc::new(move |error| failures.lock().unwrap().push(error)),
        )
        .await
        .unwrap();
        assert_eq!(transport.reads.load(Ordering::SeqCst), 1);
        assert_eq!(events.lock().unwrap().len(), 2); // Only latest + ready.
        let older = tokio::spawn(subscriber.load_older());
        tokio::time::timeout(Duration::from_secs(2), transport.blocked.notified())
            .await
            .unwrap();
        assert_eq!(events.lock().unwrap().len(), 2); // No older fragment escaped.
        hub.synchronize_records("s".into(), false, || async {
            Ok(vec![record("s", "latest", "completed")])
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), live.notified())
            .await
            .unwrap();
        assert!(!older.is_finished());
        // The completed record arrives even while the historical read is blocked.
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event.event == "session-record")
                .count(),
            2
        );
        transport.release.notify_one();
        older.await.unwrap().unwrap();
        let events = events.lock().unwrap();
        assert_eq!(events.last().unwrap().event, "relay://session-ready");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.payload["turn"]["turnId"] == "one")
                .count(),
            202
        );
        assert_eq!(transport.reads.load(Ordering::SeqCst), 2); // One source read per Turn, not per packet.
        assert_eq!(errors.lock().unwrap().len(), usize::from(fail_once));
    }

    #[tokio::test]
    async fn opening_reads_the_latest_page_from_the_host_and_reports_ready() {
        let lab = lab();
        let _subscriber = lab.subscribe("s").await.unwrap();
        assert_eq!(lab.events(), vec!["relay://session-ready"]);
        assert!(
            lab.hub.is_active("s"),
            "the first read materializes the stream"
        );
        assert_eq!(lab.hub.subscriber_count("s"), 1);
        let ready = &lab.events.lock().unwrap()[0].1;
        assert_eq!(ready["hasMore"], false);
        assert_eq!(ready["cursor"], 0);
    }

    #[tokio::test]
    async fn failed_live_read_retries_without_another_hint_and_keeps_its_cursor() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Flaky {
            inner: Arc<HubTransport>,
            failures: AtomicUsize,
        }
        #[async_trait::async_trait]
        impl StreamTransport for Flaky {
            async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage> {
                if request.after.is_some()
                    && self
                        .failures
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                            left.checked_sub(1)
                        })
                        .is_ok()
                {
                    bail!("temporary lost reply");
                }
                self.inner.read_stream(request).await
            }
            async fn unsubscribe_stream(&self, stream: &str) -> Result<()> {
                self.inner.unsubscribe_stream(stream).await
            }
        }
        tokio::time::pause();
        let lab = lab();
        let transport = Arc::new(Flaky {
            inner: lab.transport.clone(),
            failures: AtomicUsize::new(0),
        });
        let events = lab.events.clone();
        let errors = lab.errors.clone();
        let recovered = Arc::new(tokio::sync::Notify::new());
        let done = recovered.clone();
        let _subscriber = HostStreamSubscriber::start_with_transport(
            transport.clone(),
            lab.hints.subscribe(),
            "desktop".into(),
            "s".into(),
            Arc::new(move |event| {
                let ready = event.event == "relay://session-ready" && event.payload["live"] == true;
                events.lock().unwrap().push((event.event, event.payload));
                if ready {
                    done.notify_one();
                }
                Ok(())
            }),
            Arc::new(move |error| errors.lock().unwrap().push(error)),
        )
        .await
        .unwrap();
        transport.failures.store(2, Ordering::SeqCst);
        lab.hub
            .synchronize_records("s".into(), false, || async {
                Ok(vec![record("s", "last", "completed")])
            })
            .await
            .unwrap();
        // This is the final host change: recovery must not depend on another
        // token, another user action or the four-minute keepalive.
        tokio::time::timeout(Duration::from_secs(7), recovered.notified())
            .await
            .expect("the retry timer must catch up and report recovery");
        assert_eq!(lab.errors.lock().unwrap().len(), 2);
        let reads = lab.transport.reads.lock().unwrap();
        assert_eq!(reads.len(), 2);
        assert_eq!(reads[1].after, Some(0));
        assert!(reads[1].epoch.is_some());
        let events = lab.events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|(name, _)| name == "session-record")
                .count(),
            1
        );
        assert_eq!(events.last().unwrap().1["hasMore"], false);
    }

    #[tokio::test]
    async fn hints_pull_new_records_without_the_host_pushing_content() {
        let lab = lab();
        let _subscriber = lab.subscribe("s").await.unwrap();
        lab.hub
            .synchronize_records("s".into(), true, || async {
                Ok(vec![record("s", "one", "inprogress")])
            })
            .await
            .unwrap();
        lab.settle().await;
        assert_eq!(
            lab.events(),
            vec!["relay://session-ready", "session-record"]
        );
        let record_payload = lab.events.lock().unwrap()[1].1.clone();
        assert_eq!(record_payload["id"], "turn/one");
        assert_eq!(record_payload["revision"], 1);
        // Every byte of content was answered from a read, never carried in a hint.
        let reads = lab.transport.reads.lock().unwrap();
        assert_eq!(reads.len(), 2);
        assert_eq!(reads[1].after, Some(0));
        assert!(reads[1].subscribe);
        assert!(lab.errors.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stale_hints_and_other_streams_are_ignored() {
        let lab = lab();
        let _subscriber = lab.subscribe("s").await.unwrap();
        let reads_before = lab.transport.reads.lock().unwrap().len();
        let epoch = lab
            .hub
            .read(
                "phone",
                &StreamReadRequest {
                    stream_id: "s".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .epoch;
        lab.hints
            .send(Some(StreamHint {
                source_device_id: "desktop".into(),
                stream_id: "other".into(),
                epoch,
                cursor: 9,
            }))
            .unwrap();
        lab.hints
            .send(Some(StreamHint {
                source_device_id: "laptop".into(),
                stream_id: "s".into(),
                epoch,
                cursor: 9,
            }))
            .unwrap();
        lab.hints
            .send(Some(StreamHint {
                source_device_id: "desktop".into(),
                stream_id: "s".into(),
                epoch,
                cursor: 0,
            }))
            .unwrap();
        lab.settle().await;
        assert_eq!(lab.transport.reads.lock().unwrap().len(), reads_before);
    }

    #[tokio::test]
    async fn opening_reads_a_small_latest_page_first() {
        let lab = lab();
        let _subscriber = lab.subscribe("s").await.unwrap();
        let reads = lab.transport.reads.lock().unwrap().clone();
        assert_eq!(reads[0].limit, Some(super::FIRST_PAGE_EVENTS));
    }

    #[tokio::test]
    async fn opening_a_long_session_shows_whole_turns_and_pages_older_ones_after_them() {
        let lab = lab();
        lab.hub.activate("s");
        let mut records = Vec::new();
        for turn in 0..5 {
            records.push(record("s", &format!("t{turn}"), "completed"));
            for item in 0..19 {
                let mut body = record("s", &format!("t{turn}"), "completed");
                let id = format!("{turn}-{item}");
                body["id"] = serde_json::json!(format!("item/{id}"));
                body["round"] =
                    serde_json::json!({"id":format!("r{turn}"),"turnId":format!("t{turn}")});
                body["item"] = serde_json::json!({"type":"text","data":{"id":id}});
                records.push(body);
            }
        }
        lab.hub
            .synchronize_records("s".into(), true, || async { Ok(records) })
            .await
            .unwrap();
        let subscriber = lab.subscribe("s").await.unwrap();
        let ids = |lab: &Lab| -> Vec<String> {
            lab.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _)| event == "session-record")
                .map(|(_, payload)| payload["id"].as_str().unwrap().to_owned())
                .collect()
        };
        // 48 events run out inside t2; the page grows back to its header.
        let first = ids(&lab);
        assert_eq!(first.len(), 60);
        assert_eq!(first[0], "turn/t2");
        let ready = lab.events.lock().unwrap().last().unwrap().1.clone();
        assert_eq!(ready["hasMore"], true);
        // The older page brings only turns the first page does not touch.
        subscriber.load_older().await.unwrap();
        let all = ids(&lab);
        assert_eq!(all.len(), 100);
        assert_eq!(all[60], "turn/t0");
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), 100);
        let ready = lab.events.lock().unwrap().last().unwrap().1.clone();
        assert_eq!(ready["hasMore"], false);
    }

    #[tokio::test]
    async fn host_restart_is_announced_as_a_gap_and_replayed_from_the_latest_page() {
        let lab = lab();
        let _subscriber = lab.subscribe("s").await.unwrap();
        lab.hub
            .synchronize_records("s".into(), true, || async {
                Ok(vec![record("s", "one", "completed")])
            })
            .await
            .unwrap();
        lab.settle().await;
        assert_eq!(
            lab.events(),
            vec!["relay://session-ready", "session-record"]
        );
        // The host dropped and rebuilt the stream: a new epoch with fresh
        // sequences, reachable over the same device transport.
        lab.hub.close();
        let rebuilt =
            HostStreamHub::start(Arc::new(HintFanout(lab.hints.clone(), "desktop".into())));
        *lab.transport.hub.lock().unwrap() = rebuilt.clone();
        rebuilt.activate("s");
        rebuilt
            .synchronize_records("s".into(), true, || async {
                Ok(vec![
                    record("s", "one", "completed"),
                    record("s", "two", "completed"),
                ])
            })
            .await
            .unwrap();
        let page = rebuilt
            .read(
                "phone",
                &StreamReadRequest {
                    stream_id: "s".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        lab.hints
            .send(Some(StreamHint {
                source_device_id: "desktop".into(),
                stream_id: "s".into(),
                epoch: page.epoch,
                cursor: page.cursor,
            }))
            .unwrap();
        lab.settle().await;
        assert_eq!(
            lab.events(),
            vec![
                "relay://session-ready",
                "session-record",
                "relay://session-gap",
                "session-record",
                "session-record",
                "relay://session-ready",
            ]
        );
        let gap = lab.events.lock().unwrap()[2].1.clone();
        assert_eq!(gap["resync"], true);
        let ready = lab.events.lock().unwrap().last().unwrap().1.clone();
        assert_eq!(ready["cursor"], page.cursor);
        assert!(lab.errors.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn spurious_epoch_hint_without_a_host_change_is_a_plain_catch_up() {
        let lab = lab();
        let _subscriber = lab.subscribe("s").await.unwrap();
        let old_epoch = lab
            .hub
            .read(
                "phone",
                &StreamReadRequest {
                    stream_id: "s".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .epoch;
        lab.hints
            .send(Some(StreamHint {
                source_device_id: "desktop".into(),
                stream_id: "s".into(),
                epoch: old_epoch.wrapping_add(1),
                cursor: 0,
            }))
            .unwrap();
        lab.settle().await;
        assert_eq!(lab.events(), vec!["relay://session-ready"]);
        assert!(lab.errors.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn older_history_is_paged_backwards_on_demand() {
        let lab = lab();
        lab.hub.activate("s");
        let records: Vec<_> = (0..5)
            .map(|i| record("s", &format!("t{i}"), "completed"))
            .collect();
        lab.hub
            .synchronize_records("s".into(), true, || async { Ok(records) })
            .await
            .unwrap();
        // Pretend the first page only fits two events by reading with a limit.
        let events = lab.events.clone();
        let errors = lab.errors.clone();
        struct Limited(Arc<HubTransport>);
        #[async_trait::async_trait]
        impl StreamTransport for Limited {
            async fn read_stream(&self, mut request: StreamReadRequest) -> Result<StreamPage> {
                request.limit = Some(2);
                self.0.read_stream(request).await
            }
            async fn unsubscribe_stream(&self, stream_id: &str) -> Result<()> {
                self.0.unsubscribe_stream(stream_id).await
            }
        }
        let subscriber = HostStreamSubscriber::start_with_transport(
            Arc::new(Limited(lab.transport.clone())),
            lab.hints.subscribe(),
            "desktop".into(),
            "s".into(),
            Arc::new(move |event: SessionEvent| {
                events.lock().unwrap().push((event.event, event.payload));
                Ok(())
            }),
            Arc::new(move |error| errors.lock().unwrap().push(error)),
        )
        .await
        .unwrap();
        let ids = |lab: &Lab| -> Vec<String> {
            lab.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(event, _)| event == "session-record")
                .map(|(_, payload)| payload["id"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(ids(&lab), vec!["turn/t3", "turn/t4"]);
        subscriber.load_older().await.unwrap();
        assert_eq!(ids(&lab), vec!["turn/t3", "turn/t4", "turn/t1", "turn/t2"]);
        subscriber.load_older().await.unwrap();
        assert_eq!(
            ids(&lab),
            vec!["turn/t3", "turn/t4", "turn/t1", "turn/t2", "turn/t0"]
        );
        let ready = lab
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == "relay://session-ready")
            .last()
            .unwrap()
            .1
            .clone();
        assert_eq!(ready["hasMore"], false);
        // Exhausted history is a no-op, not an error.
        subscriber.load_older().await.unwrap();
    }

    #[tokio::test]
    async fn closing_unsubscribes_on_the_host() {
        let lab = lab();
        let mut subscriber = lab.subscribe("s").await.unwrap();
        subscriber.close();
        lab.settle().await;
        assert_eq!(
            *lab.transport.unsubscribed.lock().unwrap(),
            vec!["s".to_string()]
        );
        assert_eq!(lab.hub.subscriber_count("s"), 0);
    }

    #[tokio::test]
    async fn older_hosts_fail_the_open_call_with_an_upgrade_message() {
        struct Legacy;
        #[async_trait::async_trait]
        impl StreamTransport for Legacy {
            async fn read_stream(&self, _: StreamReadRequest) -> Result<StreamPage> {
                parse_stream_page(
                    r#"{"resp":"error","message":"invalid RPC command: unknown variant `read_stream`"}"#,
                )
            }
            async fn unsubscribe_stream(&self, _: &str) -> Result<()> {
                Ok(())
            }
        }
        let (hints, _) = broadcast::channel(1);
        let error = HostStreamSubscriber::start_with_transport(
            Arc::new(Legacy),
            hints.subscribe(),
            "desktop".into(),
            "s".into(),
            Arc::new(|_| Ok(())),
            Arc::new(|_| {}),
        )
        .await
        .err()
        .expect("legacy host must fail open");
        assert_eq!(error.to_string(), UNSUPPORTED_HOST_MESSAGE);
    }

    #[test]
    fn stream_page_parsing_keeps_remote_error_messages() {
        let error = parse_stream_page(r#"{"resp":"error","message":"boom"}"#).unwrap_err();
        assert_eq!(error.to_string(), "boom");
        assert!(parse_stream_page(r#"{"resp":"pong"}"#).is_err());
        let page = parse_stream_page(
            r#"{"resp":"stream_page","stream_id":"s","epoch":7,"events":[],"has_more":false,"cursor":0,"oldest_seq":1,"truncated":false}"#,
        )
        .unwrap();
        assert_eq!(page.epoch, 7);
    }
}
