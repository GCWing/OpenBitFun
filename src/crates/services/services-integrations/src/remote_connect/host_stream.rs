//! Host-owned, in-memory streams read on demand by controllers.
//!
//! The Relay only forwards encrypted device messages. Session records, terminal
//! output notifications and host catalog invalidations live on the online host,
//! are materialized only while a controller is subscribed, and are read through
//! the pairwise-encrypted `read_stream` device RPC. Nothing here is persisted.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

/// Contains a separator rejected by runtime Session IDs, so control metadata
/// cannot alias a user's session.
pub const HOST_CATALOG_ID: &str = "@host/catalog";
/// `DeviceEvent` name carrying a stream change hint to a subscribed controller.
pub const HOST_STREAM_CHANGED_EVENT: &str = "host-stream-changed";
/// Advertised in `get_workspace_info.capabilities` by hosts serving `read_stream`.
pub const REMOTE_CAPABILITY_HOST_STREAM_V1: &str = "host_stream_v1";
/// Returned to controllers that still ask for a relay-stored session key.
pub const RELAY_SESSION_HISTORY_RETIRED_MESSAGE: &str = "Relay-stored session history has been retired; session content is now read directly from the online host. Update the controlling app to continue.";

/// One page is bounded by events and by bytes; a single oversized event still
/// travels alone. Bulk bytes use the relay's opaque payload lane, not the log.
pub const DEFAULT_PAGE_EVENTS: usize = 200;
pub const MAX_PAGE_EVENTS: usize = 500;
pub const PAGE_BYTES: usize = 768 * 1024;
const STREAM_BYTES_BUDGET: usize = 32 * 1024 * 1024;
const CONTROL_EVENT_LIMIT: usize = 512;
const SUBSCRIPTION_LEASE: Duration = Duration::from_secs(10 * 60);
const STREAM_GRACE: Duration = Duration::from_secs(5 * 60);
const NOTIFY_COALESCE: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StreamEvent {
    pub seq: u64,
    pub event: String,
    pub payload: Value,
}

/// One `read_stream` answer. `cursor` is the newest sequence the host holds;
/// forward reads continue after it, history reads continue before `events[0]`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StreamPage {
    pub stream_id: String,
    pub epoch: u64,
    pub events: Vec<StreamEvent>,
    pub has_more: bool,
    pub cursor: u64,
    pub oldest_seq: u64,
    /// Older history was evicted from host memory; `has_more=false` then means
    /// "unavailable", not "complete".
    pub truncated: bool,
}

/// A stream read request as carried by `RemoteCommand::ReadStream`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StreamReadRequest {
    pub stream_id: String,
    /// Read events after this sequence (forward catch-up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
    /// Read events before this sequence (history paging).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<u64>,
    /// Epoch the controller last observed; a different host epoch means resync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Keep (or start) receiving change hints for this stream.
    #[serde(default)]
    pub subscribe: bool,
}

/// Delivers an encrypted `DeviceEvent` hint to one subscribed device. Hosts own
/// pairwise encryption and their routing lease; the hub only names the target.
pub trait HostStreamNotifier: Send + Sync {
    fn notify(&self, target_device_id: &str, payload: Value);
}

struct RecordIndexEntry {
    hash: String,
    turn: String,
}

struct StreamLog {
    epoch: u64,
    next_seq: u64,
    events: BTreeMap<u64, (StreamEvent, usize)>,
    record_seq: HashMap<String, u64>,
    record_index: BTreeMap<String, RecordIndexEntry>,
    bytes: usize,
    truncated: bool,
    subscribers: HashMap<String, Instant>,
    last_activity: Instant,
}

impl StreamLog {
    fn new() -> Self {
        Self {
            epoch: fresh_epoch(),
            next_seq: 1,
            events: BTreeMap::new(),
            record_seq: HashMap::new(),
            record_index: BTreeMap::new(),
            bytes: 0,
            truncated: false,
            subscribers: HashMap::new(),
            last_activity: Instant::now(),
        }
    }

    fn append(&mut self, event: String, mut payload: Value) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        if event == "session-record" {
            payload["revision"] = Value::from(seq);
            if let Some(id) = payload["id"].as_str() {
                if let Some(previous) = self.record_seq.insert(id.to_owned(), seq) {
                    if let Some((_, size)) = self.events.remove(&previous) {
                        self.bytes -= size;
                    }
                }
            }
        }
        let size = estimate_bytes(&payload) + event.len() + 32;
        self.bytes += size;
        self.events.insert(
            seq,
            (
                StreamEvent {
                    seq,
                    event,
                    payload,
                },
                size,
            ),
        );
        self.evict();
        seq
    }

    /// Transient control events keep a bounded tail; records are evicted only
    /// when the whole stream outgrows its memory budget, oldest first.
    fn evict(&mut self) {
        let control: Vec<u64> = self
            .events
            .iter()
            .filter(|(_, (event, _))| event.event != "session-record")
            .map(|(seq, _)| *seq)
            .collect();
        if control.len() > CONTROL_EVENT_LIMIT {
            for seq in &control[..control.len() - CONTROL_EVENT_LIMIT] {
                if let Some((_, size)) = self.events.remove(seq) {
                    self.bytes -= size;
                }
            }
        }
        while self.bytes > STREAM_BYTES_BUDGET && self.events.len() > 1 {
            let Some((&seq, _)) = self.events.iter().next() else {
                break;
            };
            if let Some((event, size)) = self.events.remove(&seq) {
                self.bytes -= size;
                if let Some(id) = event.payload["id"].as_str() {
                    if self.record_seq.get(id) == Some(&seq) {
                        self.record_seq.remove(id);
                    }
                }
                self.truncated = true;
            }
        }
    }

    fn latest(&self) -> u64 {
        self.next_seq - 1
    }

    fn oldest(&self) -> u64 {
        self.events.keys().next().copied().unwrap_or(self.next_seq)
    }

    fn read(&self, stream_id: &str, request: &StreamReadRequest) -> Result<StreamPage> {
        if request.after.is_some() && request.before.is_some() {
            bail!("read_stream accepts either after or before, not both");
        }
        let limit = request
            .limit
            .unwrap_or(DEFAULT_PAGE_EVENTS)
            .clamp(1, MAX_PAGE_EVENTS);
        let mut events = Vec::new();
        let mut bytes = 0usize;
        let has_more = if let Some(after) = request.after {
            let mut iter = self.events.range(after + 1..).peekable();
            while let Some((_, (event, size))) = iter.peek() {
                if !events.is_empty() && (events.len() >= limit || bytes + size > PAGE_BYTES) {
                    break;
                }
                events.push((*event).clone());
                bytes += size;
                iter.next();
            }
            iter.peek().is_some()
        } else {
            let before = request.before.unwrap_or(u64::MAX);
            let mut iter = self.events.range(..before).rev().peekable();
            while let Some((_, (event, size))) = iter.peek() {
                if !events.is_empty() && (events.len() >= limit || bytes + size > PAGE_BYTES) {
                    break;
                }
                events.push((*event).clone());
                bytes += size;
                iter.next();
            }
            events.reverse();
            iter.peek().is_some()
        };
        Ok(StreamPage {
            stream_id: stream_id.to_owned(),
            epoch: self.epoch,
            events,
            has_more,
            cursor: self.latest(),
            oldest_seq: self.oldest(),
            truncated: self.truncated,
        })
    }
}

fn fresh_epoch() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    let random = u64::from(rand::random::<u32>());
    (nanos ^ (random << 20)).max(1)
}

fn estimate_bytes(value: &Value) -> usize {
    fn node(value: &Value) -> usize {
        match value {
            Value::String(text) => text.len() + 8,
            Value::Array(values) => values.iter().map(node).sum::<usize>() + 8,
            Value::Object(values) => values
                .iter()
                .map(|(key, value)| key.len() + node(value) + 8)
                .sum::<usize>()
                .saturating_add(8),
            _ => 8,
        }
    }
    node(value)
}

struct HubState {
    streams: HashMap<String, StreamLog>,
    dirty: HashSet<String>,
}

/// Account-scoped owner of every host stream while account routing is alive.
/// Streams exist only after a controller reads them and are dropped after a
/// grace period without subscribers; the host never keeps an offline history.
pub struct HostStreamHub {
    state: Arc<std::sync::Mutex<HubState>>,
    wake: Arc<tokio::sync::Notify>,
    source_gates: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    closed: tokio::sync::watch::Sender<bool>,
    workers: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl HostStreamHub {
    pub fn start(notifier: Arc<dyn HostStreamNotifier>) -> Arc<Self> {
        let state = Arc::new(std::sync::Mutex::new(HubState {
            streams: HashMap::new(),
            dirty: HashSet::new(),
        }));
        let wake = Arc::new(tokio::sync::Notify::new());
        let hub = Arc::new(Self {
            state: state.clone(),
            wake: wake.clone(),
            source_gates: Default::default(),
            closed: tokio::sync::watch::channel(false).0,
            workers: std::sync::Mutex::new(Vec::new()),
        });
        let mut closed = hub.closed.subscribe();
        let notify_state = state.clone();
        let notify_worker = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = closed.changed() => break,
                    _ = wake.notified() => {}
                }
                tokio::time::sleep(NOTIFY_COALESCE).await;
                let hints = {
                    let mut state = notify_state.lock().unwrap_or_else(|e| e.into_inner());
                    let now = Instant::now();
                    let dirty: Vec<String> = state.dirty.drain().collect();
                    let mut hints = Vec::new();
                    for stream_id in dirty {
                        let Some(log) = state.streams.get_mut(&stream_id) else {
                            continue;
                        };
                        log.subscribers.retain(|_, expires| *expires > now);
                        let payload = serde_json::json!({
                            "stream_id": stream_id,
                            "epoch": log.epoch,
                            "cursor": log.latest(),
                        });
                        for device in log.subscribers.keys() {
                            hints.push((device.clone(), payload.clone()));
                        }
                    }
                    hints
                };
                for (device, payload) in hints {
                    notifier.notify(&device, payload);
                }
            }
        });
        let mut closed = hub.closed.subscribe();
        let purge_state = state;
        let purge_worker = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = closed.changed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                }
                let mut state = purge_state.lock().unwrap_or_else(|e| e.into_inner());
                let now = Instant::now();
                state.streams.retain(|_, log| {
                    log.subscribers.retain(|_, expires| *expires > now);
                    !log.subscribers.is_empty()
                        || now.duration_since(log.last_activity) < STREAM_GRACE
                });
            }
        });
        *hub.workers.lock().unwrap_or_else(|e| e.into_inner()) = vec![notify_worker, purge_worker];
        hub
    }

    pub fn close(&self) {
        self.closed.send_replace(true);
        for worker in self
            .workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
        {
            worker.abort();
        }
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .streams
            .clear();
    }

    pub fn subscribe_closed(&self) -> tokio::sync::watch::Receiver<bool> {
        self.closed.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Streams currently materialized for at least one controller.
    pub fn active_stream_ids(&self) -> Vec<String> {
        self.lock().streams.keys().cloned().collect()
    }

    pub fn is_active(&self, stream_id: &str) -> bool {
        self.lock().streams.contains_key(stream_id)
    }

    /// Whether a read must be preceded by a full source synchronization: the
    /// stream is not materialized yet, or the controller's epoch is stale.
    pub fn needs_full_synchronization(&self, request: &StreamReadRequest) -> bool {
        let state = self.lock();
        match state.streams.get(&request.stream_id) {
            None => true,
            Some(log) => request.after.is_none() || request.epoch != Some(log.epoch),
        }
    }

    /// Materialize a stream so subsequent appends and synchronizations retain it.
    pub fn activate(&self, stream_id: &str) {
        let mut state = self.lock();
        state
            .streams
            .entry(stream_id.to_owned())
            .or_insert_with(StreamLog::new)
            .last_activity = Instant::now();
    }

    pub fn read(&self, source_device_id: &str, request: &StreamReadRequest) -> Result<StreamPage> {
        if request.stream_id.is_empty() {
            bail!("stream id is required");
        }
        let mut state = self.lock();
        let log = state
            .streams
            .entry(request.stream_id.clone())
            .or_insert_with(StreamLog::new);
        log.last_activity = Instant::now();
        if request.subscribe {
            log.subscribers.insert(
                source_device_id.to_owned(),
                Instant::now() + SUBSCRIPTION_LEASE,
            );
        }
        log.read(&request.stream_id, request)
    }

    pub fn unsubscribe(&self, source_device_id: &str, stream_id: &str) {
        let mut state = self.lock();
        if let Some(log) = state.streams.get_mut(stream_id) {
            log.subscribers.remove(source_device_id);
            log.last_activity = Instant::now();
        }
    }

    /// Presence is authoritative for who can still receive hints. A device that
    /// went offline is dropped now; it resubscribes on its next read.
    pub fn retain_online(&self, online_device_ids: &[String]) {
        let mut state = self.lock();
        for log in state.streams.values_mut() {
            log.subscribers
                .retain(|device, _| online_device_ids.iter().any(|id| id == device));
        }
    }

    pub fn subscriber_count(&self, stream_id: &str) -> usize {
        let now = Instant::now();
        self.lock()
            .streams
            .get(stream_id)
            .map(|log| {
                log.subscribers
                    .values()
                    .filter(|expires| **expires > now)
                    .count()
            })
            .unwrap_or(0)
    }

    /// Append to a materialized stream. Streams nobody reads are not created;
    /// the first read runs a full synchronization instead.
    pub async fn append(&self, stream_id: String, event: String, payload: Value) -> Result<()> {
        self.append_batch(vec![(stream_id, event, payload)]).await
    }

    pub async fn append_batch(&self, events: Vec<(String, String, Value)>) -> Result<()> {
        let mut state = self.lock();
        let mut changed = HashSet::new();
        for (stream_id, event, payload) in events {
            let Some(log) = state.streams.get_mut(&stream_id) else {
                continue;
            };
            log.append(event, payload);
            log.last_activity = Instant::now();
            changed.insert(stream_id);
        }
        if !changed.is_empty() {
            state.dirty.extend(changed);
            drop(state);
            self.wake.notify_one();
        }
        Ok(())
    }

    /// A source delivery gap is explicit; controllers reconcile from the
    /// runtime's authoritative view. It must never cancel host-owned work.
    pub async fn report_source_gap(&self, reason: &str) -> Result<()> {
        let sessions: Vec<String> = self
            .active_stream_ids()
            .into_iter()
            .filter(|id| id != HOST_CATALOG_ID && !id.starts_with("terminal-"))
            .collect();
        let events = sessions
            .into_iter()
            .map(|session| {
                let payload = serde_json::json!({"sessionId":session,"reason":reason});
                (session, "relay://session-gap".to_string(), payload)
            })
            .collect();
        self.append_batch(events).await
    }

    /// Diff the runtime's stable records into the stream. One source read at a
    /// time per session; the records themselves are loaded by the caller-provided
    /// future so hosts keep ownership of their session storage.
    pub async fn synchronize_records<F, Fut>(
        &self,
        session_id: String,
        full: bool,
        load: F,
    ) -> Result<()>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Vec<Value>>>,
    {
        if !self.is_active(&session_id) {
            return Ok(());
        }
        let gate = self
            .source_gates
            .lock()
            .await
            .entry(session_id.clone())
            .or_default()
            .clone();
        let _source = gate.lock().await;
        let records = load().await?;
        let changed = {
            let mut state = self.lock();
            let Some(log) = state.streams.get_mut(&session_id) else {
                return Ok(());
            };
            diff_records(log, &session_id, records, full)?
        };
        if changed {
            self.lock().dirty.insert(session_id);
            self.wake.notify_one();
        }
        Ok(())
    }
}

impl Drop for HostStreamHub {
    fn drop(&mut self) {
        self.close();
    }
}

/// Parent status changes get their own small header record; they must not
/// re-send every unchanged large tool body. Removed records become tombstones,
/// scoped to the loaded turns unless the load was a full snapshot.
fn diff_records(
    log: &mut StreamLog,
    session_id: &str,
    records: Vec<Value>,
    full: bool,
) -> Result<bool> {
    let mut changed = Vec::new();
    let mut present = HashSet::new();
    let mut scope = HashSet::new();
    for record in records {
        let id = record["id"]
            .as_str()
            .context("record identity missing")?
            .to_owned();
        present.insert(id.clone());
        let turn = record["turn"]["turnId"]
            .as_str()
            .context("record turn identity missing")?
            .to_owned();
        scope.insert(turn.clone());
        if record["sessionId"].as_str() != Some(session_id) {
            bail!("record session identity mismatch");
        }
        let body = record
            .get("item")
            .or_else(|| record.get("round"))
            .unwrap_or(&record["turn"]);
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(body)?));
        let old_hash = log.record_index.get(&id).map(|entry| entry.hash.as_str());
        if old_hash != Some(hash.as_str()) {
            log.record_index.insert(id, RecordIndexEntry { hash, turn });
            changed.push(record);
        }
    }
    let removed: Vec<String> = log
        .record_index
        .iter()
        .filter(|(id, entry)| !present.contains(*id) && (full || scope.contains(&entry.turn)))
        .map(|(id, _)| id.clone())
        .collect();
    for id in removed {
        log.record_index.remove(&id);
        changed.push(serde_json::json!({"sessionId":session_id,"id":id,"deleted":true}));
    }
    if changed.is_empty() {
        return Ok(false);
    }
    for record in changed {
        log.append("session-record".into(), record);
    }
    log.last_activity = Instant::now();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Recorder(std::sync::Mutex<Vec<(String, Value)>>);
    impl HostStreamNotifier for Recorder {
        fn notify(&self, target_device_id: &str, payload: Value) {
            self.0
                .lock()
                .unwrap()
                .push((target_device_id.to_owned(), payload));
        }
    }

    fn request(stream: &str) -> StreamReadRequest {
        StreamReadRequest {
            stream_id: stream.into(),
            subscribe: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn streams_materialize_on_first_read_and_notify_subscribers() {
        let recorder = Arc::new(Recorder(Default::default()));
        let hub = HostStreamHub::start(recorder.clone());
        hub.append("s".into(), "x".into(), Value::Null)
            .await
            .unwrap();
        assert!(!hub.is_active("s"), "unread streams are never materialized");
        let page = hub.read("phone", &request("s")).unwrap();
        assert_eq!(page.cursor, 0);
        assert!(page.events.is_empty());
        hub.append(
            "s".into(),
            "session-interaction-changed".into(),
            serde_json::json!({"sessionId":"s"}),
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        let hints = recorder.0.lock().unwrap().clone();
        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].0, "phone");
        assert_eq!(hints[0].1["stream_id"], "s");
        assert_eq!(hints[0].1["cursor"], 1);
        assert_eq!(hints[0].1["epoch"], page.epoch);
        let forward = hub
            .read(
                "phone",
                &StreamReadRequest {
                    after: Some(0),
                    epoch: Some(page.epoch),
                    ..request("s")
                },
            )
            .unwrap();
        assert_eq!(forward.events.len(), 1);
        assert_eq!(forward.events[0].seq, 1);
        assert!(!forward.has_more);
        hub.unsubscribe("phone", "s");
        assert_eq!(hub.subscriber_count("s"), 0);
        hub.retain_online(&[]);
    }

    #[tokio::test]
    async fn records_are_compacted_by_identity_and_paged_both_ways() {
        let hub = HostStreamHub::start(Arc::new(Recorder(Default::default())));
        hub.activate("s");
        let turn = |id: &str, status: &str| serde_json::json!({"sessionId":"s","id":format!("turn/{id}"),"turn":{"turnId":id,"sessionId":"s","status":status}});
        let mut item = serde_json::json!({"sessionId":"s","id":"item/tool","turn":{"turnId":"one","sessionId":"s","status":"inprogress"},"item":{"type":"tool","data":{"id":"tool","result":"x".repeat(256*1024)}}});
        hub.synchronize_records("s".into(), true, || async {
            Ok(vec![
                turn("one", "inprogress"),
                item.clone(),
                turn("two", "completed"),
            ])
        })
        .await
        .unwrap();
        let page = hub.read("d", &request("s")).unwrap();
        assert_eq!(page.events.len(), 3);
        assert_eq!(page.events[1].payload["revision"], 2);
        item["turn"]["status"] = serde_json::json!("completed");
        let updated = item.clone();
        hub.synchronize_records("s".into(), false, || async {
            Ok(vec![turn("one", "completed"), updated])
        })
        .await
        .unwrap();
        let forward = hub
            .read(
                "d",
                &StreamReadRequest {
                    after: Some(3),
                    ..request("s")
                },
            )
            .unwrap();
        assert_eq!(
            forward.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![4],
            "parent state must not retransmit large unchanged bodies or remove unrelated turns"
        );
        assert_eq!(forward.events[0].payload["id"], "turn/one");
        assert_eq!(forward.events[0].payload["turn"]["status"], "completed");
        hub.synchronize_records("s".into(), false, || async {
            Ok(vec![turn("one", "completed")])
        })
        .await
        .unwrap();
        let forward = hub
            .read(
                "d",
                &StreamReadRequest {
                    after: Some(4),
                    ..request("s")
                },
            )
            .unwrap();
        assert_eq!(forward.events.len(), 1);
        assert_eq!(forward.events[0].payload["deleted"], true);
        assert_eq!(forward.events[0].payload["id"], "item/tool");
        // Updated records leave their old sequence; a latest page holds each id once.
        let latest = hub.read("d", &request("s")).unwrap();
        let ids: Vec<_> = latest
            .events
            .iter()
            .map(|e| e.payload["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["turn/two", "turn/one", "item/tool"]);
        let history = hub
            .read(
                "d",
                &StreamReadRequest {
                    before: Some(latest.events[1].seq),
                    limit: Some(1),
                    ..request("s")
                },
            )
            .unwrap();
        assert_eq!(history.events.len(), 1);
        assert_eq!(history.events[0].payload["id"], "turn/two");
        assert!(!history.has_more);
        assert!(hub
            .read(
                "d",
                &StreamReadRequest {
                    after: Some(1),
                    before: Some(2),
                    ..request("s")
                }
            )
            .is_err());
    }

    #[tokio::test]
    async fn oversized_events_travel_alone_and_pages_stay_within_byte_budget() {
        let hub = HostStreamHub::start(Arc::new(Recorder(Default::default())));
        hub.activate("s");
        for _ in 0..3 {
            hub.append(
                "s".into(),
                "note".into(),
                serde_json::json!({"body": "x".repeat(PAGE_BYTES)}),
            )
            .await
            .unwrap();
        }
        let latest = hub.read("d", &request("s")).unwrap();
        assert_eq!(
            latest.events.len(),
            1,
            "an oversized event still travels alone"
        );
        assert_eq!(latest.events[0].seq, 3);
        assert!(latest.has_more);
        let forward = hub
            .read(
                "d",
                &StreamReadRequest {
                    after: Some(0),
                    ..request("s")
                },
            )
            .unwrap();
        assert_eq!(forward.events.len(), 1);
        assert_eq!(forward.events[0].seq, 1);
        assert!(forward.has_more);
    }

    #[tokio::test]
    async fn stale_epoch_and_missing_streams_require_full_synchronization() {
        let hub = HostStreamHub::start(Arc::new(Recorder(Default::default())));
        assert!(hub.needs_full_synchronization(&request("s")));
        let page = hub.read("d", &request("s")).unwrap();
        assert!(
            hub.needs_full_synchronization(&request("s")),
            "a latest-page read is a resync"
        );
        assert!(!hub.needs_full_synchronization(&StreamReadRequest {
            after: Some(0),
            epoch: Some(page.epoch),
            ..request("s")
        }));
        assert!(hub.needs_full_synchronization(&StreamReadRequest {
            after: Some(0),
            epoch: Some(page.epoch + 1),
            ..request("s")
        }));
        hub.synchronize_records("other".into(), true, || async {
            Ok(vec![
                serde_json::json!({"sessionId":"other","id":"turn/a","turn":{"turnId":"a"}}),
            ])
        })
        .await
        .unwrap();
        assert!(
            !hub.is_active("other"),
            "synchronizing an unread session must not retain it"
        );
    }

    #[tokio::test]
    async fn control_tail_and_memory_budget_are_bounded() {
        let hub = HostStreamHub::start(Arc::new(Recorder(Default::default())));
        hub.activate("terminal-1");
        for index in 0..(CONTROL_EVENT_LIMIT + 10) {
            hub.append(
                "terminal-1".into(),
                "terminal-output".into(),
                serde_json::json!({"cursor":index}),
            )
            .await
            .unwrap();
        }
        let page = hub.read("d", &request("terminal-1")).unwrap();
        assert_eq!(page.oldest_seq, 11);
        assert_eq!(page.cursor, (CONTROL_EVENT_LIMIT + 10) as u64);
        assert!(!page.truncated);
        hub.activate("s");
        let big = "y".repeat(4 * 1024 * 1024);
        for index in 0..12 {
            hub.append("s".into(), "session-record".into(), serde_json::json!({"sessionId":"s","id":format!("item/{index}"),"item":{"data":big}}))
                .await
                .unwrap();
        }
        let page = hub.read("d", &request("s")).unwrap();
        assert!(page.truncated);
        assert!(page.oldest_seq > 1);
        assert!(page.events.len() < 12);
        let first = hub
            .read(
                "d",
                &StreamReadRequest {
                    limit: Some(1),
                    ..request("s")
                },
            )
            .unwrap();
        assert_eq!(
            first.events.len(),
            1,
            "an oversized event still travels alone"
        );
    }
}
