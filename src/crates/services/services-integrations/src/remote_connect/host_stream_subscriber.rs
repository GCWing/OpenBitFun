//! Controller-side reader of one host stream. No cache and no runtime work
//! live here: every page is fetched from the online host over encrypted device
//! RPC, and closing the subscriber only stops observing that host.
use super::{
    account::{AccountClient, AccountSession, StreamHint},
    host_stream::{StreamPage, StreamReadRequest},
};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio::sync::{broadcast, mpsc, oneshot};

const KEEPALIVE: Duration = Duration::from_secs(4 * 60);
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
}

#[async_trait::async_trait]
impl StreamTransport for DeviceRpcTransport {
    async fn read_stream(&self, request: StreamReadRequest) -> Result<StreamPage> {
        let command = serde_json::json!({
            "cmd": "read_stream",
            "stream_id": request.stream_id,
            "after": request.after,
            "before": request.before,
            "epoch": request.epoch,
            "limit": request.limit,
            "subscribe": request.subscribe,
        });
        let response = AccountClient::new()
            .device_rpc(
                &self.relay,
                &self.account,
                &self.target,
                &command.to_string(),
            )
            .await?;
        parse_stream_page(&response)
    }

    async fn unsubscribe_stream(&self, stream_id: &str) -> Result<()> {
        let command = serde_json::json!({"cmd":"unsubscribe_stream","stream_id":stream_id});
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

struct Reader {
    transport: Arc<dyn StreamTransport>,
    session_id: String,
    emit: Arc<dyn Fn(SessionEvent) -> Result<()> + Send + Sync>,
    epoch: u64,
    cursor: u64,
    oldest: u64,
    has_more: bool,
}

impl Reader {
    async fn read(&self, request: StreamReadRequest) -> Result<StreamPage> {
        let page = self.transport.read_stream(request).await?;
        if page.stream_id != self.session_id {
            bail!("stream page identity mismatch");
        }
        Ok(page)
    }

    fn emit_page(&self, page: &StreamPage) -> Result<()> {
        for event in &page.events {
            (self.emit)(SessionEvent {
                session_id: self.session_id.clone(),
                event: event.event.clone(),
                payload: event.payload.clone(),
            })?;
        }
        Ok(())
    }

    fn emit_ready(&self) -> Result<()> {
        (self.emit)(SessionEvent {
            session_id: self.session_id.clone(),
            event: "relay://session-ready".into(),
            payload: serde_json::json!({"sessionId":self.session_id,"hasMore":self.has_more,"oldestSeq":self.oldest,"cursor":self.cursor}),
        })
    }

    /// Latest page first, like opening a chat at its bottom.
    async fn resync(&mut self) -> Result<()> {
        let page = self
            .read(StreamReadRequest {
                stream_id: self.session_id.clone(),
                subscribe: true,
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
        self.emit_page(&page)?;
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
            self.emit_page(&page)?;
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

    async fn load_older(&mut self) -> Result<bool> {
        if !self.has_more {
            return Ok(true);
        }
        let page = self
            .read(StreamReadRequest {
                stream_id: self.session_id.clone(),
                before: Some(self.oldest),
                epoch: Some(self.epoch),
                subscribe: true,
                ..Default::default()
            })
            .await?;
        if page.epoch != self.epoch {
            return Ok(false);
        }
        self.emit_page(&page)?;
        if let Some(first) = page.events.first() {
            self.oldest = first.seq;
        }
        self.has_more = page.has_more;
        self.emit_ready()?;
        Ok(true)
    }

    fn gap(&self, reason: &str) -> Result<()> {
        (self.emit)(SessionEvent {
            session_id: self.session_id.clone(),
            event: "relay://session-gap".into(),
            payload: serde_json::json!({"sessionId":self.session_id,"reason":reason}),
        })
    }

    fn hint_is_new(&self, hint: &StreamHint, target: &str) -> bool {
        hint.source_device_id == target
            && hint.stream_id == self.session_id
            && (hint.epoch != self.epoch || hint.cursor > self.cursor)
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
        };
        // The first page is awaited so an unsupported or offline host fails the
        // open call instead of retrying silently in the background.
        reader
            .resync()
            .await
            .map_err(|error| anyhow!("{}", describe_stream_error(&error)))?;
        let (older, mut older_requests) = mpsc::channel::<oneshot::Sender<Result<()>>>(1);
        let worker = tokio::spawn(async move {
            let mut retry = 1u64;
            let mut keepalive = tokio::time::interval(KEEPALIVE);
            keepalive.tick().await;
            loop {
                let wake = tokio::select! {
                    hint = hints.recv() => match hint {
                        Ok(Some(hint)) => {
                            if !reader.hint_is_new(&hint, &target) {
                                continue;
                            }
                            Wake::Refresh
                        }
                        Ok(None) | Err(broadcast::error::RecvError::Lagged(_)) => Wake::Refresh,
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                    _ = keepalive.tick() => Wake::Refresh,
                    request = older_requests.recv() => match request {
                        Some(reply) if !reply.is_closed() => Wake::Older(reply),
                        Some(_) => continue,
                        None => return,
                    },
                };
                let result = match wake {
                    Wake::Refresh => reader.refresh().await,
                    Wake::Older(reply) => {
                        let result = match reader.load_older().await {
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
                match result {
                    Ok(()) => retry = 1,
                    Err(failure) => {
                        error(describe_stream_error(&failure));
                        tokio::time::sleep(Duration::from_secs(retry)).await;
                        retry = (retry * 2).min(30);
                    }
                }
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
        serde_json::json!({"sessionId":session,"id":format!("turn/{turn}"),"turn":{"turnId":turn,"sessionId":session,"status":status}})
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
