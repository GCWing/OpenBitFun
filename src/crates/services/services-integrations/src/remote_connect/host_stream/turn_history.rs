//! Optional single-Turn snapshots over the existing encrypted stream RPC.
//! The source, replica and live stream keep their owners. A snapshot only pins
//! one source read across bounded packets; it is not an offline history cache.
use super::*;

const VERSION: u32 = 1;
/// Desktop controllers can receive a larger bounded snapshot packet, avoiding
/// another acknowledged RPC for ordinary tool-heavy Turns. Live pages retain
/// their smaller budget so background history cannot change event batching.
pub const MAX_TURN_HISTORY_PAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnHistoryRequest {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_turn: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<usize>,
}

impl TurnHistoryRequest {
    pub fn latest() -> Self {
        Self {
            version: VERSION,
            before_turn: None,
            snapshot_id: None,
            offset: 0,
            max_bytes: None,
        }
    }
}

/// Echoing version 1 accepts the controller's offer. An absent field is an
/// older host, so the controller must keep the ordinary stream-page reader.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TurnHistoryPage {
    pub version: u32,
    pub snapshot_id: String,
    pub turn_id: Option<String>,
    pub record_count: usize,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub before_turn: Option<usize>,
}

pub(super) struct TurnSnapshot {
    pub(super) device: String,
    pub(super) last_activity: Instant,
    bytes: usize,
    cursor: u64,
    before_turn: Option<usize>,
    turn_id: Option<String>,
    events: Vec<(StreamEvent, usize)>,
}

impl HostStreamHub {
    pub(super) async fn read_turn_history<F, Fut>(
        &self,
        device: &str,
        request: &StreamReadRequest,
        history: &TurnHistoryRequest,
        mut load: F,
    ) -> Result<StreamPage>
    where
        F: FnMut(Option<usize>) -> Fut,
        Fut: std::future::Future<Output = Result<HistoryBatch>>,
    {
        if history.version != VERSION {
            bail!("Unsupported Turn history version");
        }
        if request.stream_id.is_empty() || request.after.is_some() || request.before.is_some() {
            bail!("Turn history reads cannot use event cursors");
        }
        if history.snapshot_id.is_none() && history.offset != 0 {
            bail!("Turn history offset requires a snapshot");
        }
        let gate = self.source_gate(&request.stream_id).await;
        let _source = gate.lock().await;
        let cursor = {
            let mut state = self.lock();
            let log = state
                .streams
                .entry(request.stream_id.clone())
                .or_insert_with(Self::paged_log);
            // A materialized but empty legacy log has no positive revision yet.
            if log.latest() == 0 {
                log.next_seq = HISTORY_SEQUENCE_CEILING;
            }
            log.last_activity = Instant::now();
            if request.subscribe {
                log.subscribers
                    .insert(device.to_owned(), Instant::now() + SUBSCRIPTION_LEASE);
            }
            if request.epoch.is_some_and(|epoch| epoch != log.epoch) {
                // No stale snapshot content: the normal epoch fence tells the
                // reader to reopen, including after undo/import/host restart.
                return log.read(&request.stream_id, request);
            }
            if let Some(id) = &history.snapshot_id {
                return log.read_turn_snapshot(
                    device,
                    &request.stream_id,
                    id,
                    history.offset,
                    request.limit,
                    history.max_bytes,
                );
            }
            // Capture BEFORE IO. Controls may append while the source is read;
            // catch-up must still deliver them. Canonical record publication
            // shares this source gate, so subsequent revisions exceed this fence.
            log.latest()
        };
        let started = Instant::now();
        let batch = load(history.before_turn).await?;
        if history
            .before_turn
            .zip(batch.before)
            .is_some_and(|(old, next)| next >= old)
        {
            bail!("Turn history source did not advance");
        }
        let mut turn_id = None;
        let mut identities = HashSet::new();
        let mut events = Vec::with_capacity(batch.records.len());
        let mut bytes = 0;
        for mut payload in batch.records {
            if payload["sessionId"].as_str() != Some(request.stream_id.as_str()) {
                bail!("Turn snapshot session identity mismatch");
            }
            let turn = payload
                .pointer("/turn/turnId")
                .and_then(Value::as_str)
                .context("Turn snapshot identity missing")?
                .to_owned();
            if turn_id.as_ref().is_some_and(|selected| selected != &turn) {
                bail!("Turn history source returned more than one Turn");
            }
            turn_id = Some(turn);
            let id = payload["id"]
                .as_str()
                .context("Turn snapshot record identity missing")?
                .to_owned();
            if !identities.insert(id) {
                bail!("Duplicate Turn snapshot record");
            }
            // These records describe the same atomic source snapshot at the
            // receive fence. They do not allocate live event sequences. A later
            // live upsert/tombstone has a greater revision in the same replica.
            payload["revision"] = cursor.into();
            let size = estimate_bytes(&payload) + 48;
            bytes += size;
            events.push((
                StreamEvent {
                    seq: cursor,
                    event: "session-record".into(),
                    payload,
                },
                size,
            ));
        }
        if let Some(turn) = &turn_id {
            if !identities.contains(&format!("turn/{turn}")) {
                bail!("Turn snapshot root missing");
            }
        } else if batch.before.is_some() {
            bail!("Empty Turn history source did not exhaust history");
        }
        let id = format!(
            "{:016x}{:016x}",
            rand::random::<u64>(),
            rand::random::<u64>()
        );
        let mut state = self.lock();
        let log = state
            .streams
            .get_mut(&request.stream_id)
            .context("History stream expired")?;
        for record in identities {
            log.snapshot_record_turns
                .insert(record, turn_id.clone().unwrap());
        }
        log.turn_snapshots.insert(
            id.clone(),
            TurnSnapshot {
                device: device.to_owned(),
                last_activity: Instant::now(),
                bytes,
                cursor,
                before_turn: batch.before,
                turn_id,
                events,
            },
        );
        // Keep only reconstructable bounded state. As with the source's pending
        // Turn, one oversized Turn may exceed the budget; competing snapshots
        // are evicted explicitly and their readers receive a retryable error.
        let now = Instant::now();
        log.turn_snapshots.retain(|key, snapshot| {
            key == &id || now.duration_since(snapshot.last_activity) < STREAM_GRACE
        });
        while log.turn_snapshots.len() > 1
            && log
                .turn_snapshots
                .values()
                .map(|snapshot| snapshot.bytes)
                .sum::<usize>()
                > STREAM_BYTES_BUDGET
        {
            let oldest = log
                .turn_snapshots
                .iter()
                .filter(|(key, _)| *key != &id)
                .min_by_key(|(_, snapshot)| snapshot.last_activity)
                .map(|(key, _)| key.clone())
                .unwrap();
            log.turn_snapshots.remove(&oldest);
        }
        log::debug!(
            "Read single Turn history: stream_id={} records={} bytes={} has_more={} elapsed_ms={}",
            request.stream_id,
            log.turn_snapshots[&id].events.len(),
            bytes,
            batch.before.is_some(),
            started.elapsed().as_millis()
        );
        log.read_turn_snapshot(
            device,
            &request.stream_id,
            &id,
            0,
            request.limit,
            history.max_bytes,
        )
    }
}

impl StreamLog {
    fn read_turn_snapshot(
        &mut self,
        device: &str,
        stream: &str,
        id: &str,
        offset: usize,
        limit: Option<usize>,
        max_bytes: Option<usize>,
    ) -> Result<StreamPage> {
        let snapshot = self
            .turn_snapshots
            .get_mut(id)
            .context("Turn history snapshot expired; retry the read")?;
        if snapshot.device != device {
            bail!("Turn history snapshot belongs to another controller");
        }
        if offset > snapshot.events.len() {
            bail!("Invalid Turn history snapshot offset");
        }
        snapshot.last_activity = Instant::now();
        let mut bytes = 0;
        let mut events = Vec::new();
        let byte_budget = max_bytes
            .unwrap_or(PAGE_BYTES)
            .clamp(1, MAX_TURN_HISTORY_PAGE_BYTES);
        for (event, size) in snapshot.events.iter().skip(offset) {
            if !events.is_empty()
                && (events.len()
                    >= limit
                        .unwrap_or(DEFAULT_PAGE_EVENTS)
                        .clamp(1, MAX_PAGE_EVENTS)
                    || bytes + size > byte_budget)
            {
                break;
            }
            bytes += size;
            events.push(event.clone());
        }
        let end = offset + events.len();
        Ok(StreamPage {
            stream_id: stream.to_owned(),
            epoch: self.epoch,
            events,
            has_more: snapshot.before_turn.is_some(),
            cursor: snapshot.cursor,
            oldest_seq: snapshot.cursor,
            truncated: false,
            turn_history: Some(TurnHistoryPage {
                version: VERSION,
                snapshot_id: id.to_owned(),
                turn_id: snapshot.turn_id.clone(),
                record_count: snapshot.events.len(),
                offset,
                next_offset: (end < snapshot.events.len()).then_some(end),
                before_turn: snapshot.before_turn,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Quiet;
    impl HostStreamNotifier for Quiet {
        fn notify(&self, _: &str, _: Value) {}
    }
    fn request() -> StreamReadRequest {
        StreamReadRequest {
            stream_id: "s".into(),
            subscribe: true,
            turn_history: Some(TurnHistoryRequest::latest()),
            ..Default::default()
        }
    }
    pub(super) fn records(index: usize, items: usize) -> Vec<Value> {
        let turn = serde_json::json!({"turnId":format!("t{index}"),"sessionId":"s","turnIndex":index,"status":"completed"});
        let mut records =
            vec![serde_json::json!({"sessionId":"s","id":format!("turn/t{index}"),"turn":turn})];
        for item in 0..items {
            records.push(
                serde_json::json!({"sessionId":"s","id":format!("item/{index}-{item}"),"turn":turn,
                "round":{"id":format!("r{index}"),"turnId":format!("t{index}"),"roundIndex":0},
                "item":{"type":"text","data":{"id":format!("{index}-{item}"),"content":"body"}}}),
            );
        }
        records
    }
    fn continuation(page: &StreamPage) -> StreamReadRequest {
        let history = page.turn_history.as_ref().unwrap();
        StreamReadRequest {
            epoch: Some(page.epoch),
            turn_history: Some(TurnHistoryRequest {
                snapshot_id: Some(history.snapshot_id.clone()),
                offset: history.next_offset.unwrap(),
                ..TurnHistoryRequest::latest()
            }),
            ..request()
        }
    }

    #[tokio::test]
    async fn opens_only_the_last_turn_independently_of_total_history_size_or_live_event_order() {
        let hub = HostStreamHub::start(Arc::new(Quiet));
        hub.activate("s");
        hub.synchronize_records("s".into(), false, || async { Ok(records(0, 2)) })
            .await
            .unwrap();
        let reads = AtomicUsize::new(0);
        let first = hub
            .read_history("desktop", &request(), |before| {
                reads.fetch_add(1, Ordering::SeqCst);
                assert!(before.is_none());
                async {
                    Ok(HistoryBatch {
                        records: records(999, 1),
                        before: Some(999),
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(first.events.len(), 2);
        assert!(first
            .events
            .iter()
            .all(|event| event.payload["turn"]["turnIndex"] == 999));
        assert_eq!(first.turn_history.as_ref().unwrap().next_offset, None);
        assert!(first.has_more);
        // No source scan to fill 48/200 events, even for a two-record last Turn.
        let older_request = StreamReadRequest {
            epoch: Some(first.epoch),
            turn_history: Some(TurnHistoryRequest {
                before_turn: first.turn_history.as_ref().unwrap().before_turn,
                ..TurnHistoryRequest::latest()
            }),
            ..request()
        };
        let older = hub
            .read_history("desktop", &older_request, |before| {
                assert_eq!(before, Some(999));
                async {
                    Ok(HistoryBatch {
                        records: records(998, 1),
                        before: Some(998),
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(older.turn_history.unwrap().turn_id.as_deref(), Some("t998"));
    }

    #[tokio::test]
    async fn large_turn_packets_are_immutable_and_live_updates_and_deletions_resume_after_the_fence(
    ) {
        let hub = HostStreamHub::start(Arc::new(Quiet));
        let first = hub
            .read_history(
                "desktop",
                &StreamReadRequest {
                    limit: Some(2),
                    ..request()
                },
                |_| async {
                    Ok(HistoryBatch {
                        records: records(5, 5),
                        before: Some(5),
                    })
                },
            )
            .await
            .unwrap();
        assert_eq!(first.events.len(), 2);
        let mut changed = records(5, 4); // Delete the final item while the snapshot is in flight.
        changed[1]["item"]["data"]["content"] = "new live content".into();
        hub.synchronize_records("s".into(), false, || async { Ok(changed) })
            .await
            .unwrap();
        let second_request = continuation(&first);
        let second = hub
            .read_history("desktop", &second_request, |_| async {
                panic!("continuations never reread the source")
            })
            .await
            .unwrap();
        let retried = hub
            .read_history("desktop", &second_request, |_| async {
                panic!("retry is the same immutable packet")
            })
            .await
            .unwrap();
        assert_eq!(second, retried);
        assert_eq!(second.events.len(), 4);
        assert!(second
            .events
            .iter()
            .all(|event| event.payload["item"]["data"]["content"] == "body"));
        assert_eq!(second.cursor, first.cursor);
        assert_eq!(second.turn_history.unwrap().next_offset, None);
        let live = hub
            .read(
                "desktop",
                &StreamReadRequest {
                    stream_id: "s".into(),
                    after: Some(first.cursor),
                    epoch: Some(first.epoch),
                    subscribe: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(live.events.iter().all(|event| event.seq > first.cursor));
        assert!(live
            .events
            .iter()
            .any(|event| event.payload["item"]["data"]["content"] == "new live content"));
        assert!(live
            .events
            .iter()
            .any(|event| event.payload["id"] == "item/5-4" && event.payload["deleted"] == true));
    }

    #[tokio::test]
    async fn requested_byte_budget_batches_a_complete_turn_and_caps_larger_offers() {
        let hub = HostStreamHub::start(Arc::new(Quiet));
        let mut body = records(0, 2);
        for record in &mut body[1..] {
            record["item"]["data"]["content"] = "a".repeat(PAGE_BYTES * 2 / 3).into();
        }
        let mut read = request();
        read.turn_history.as_mut().unwrap().max_bytes = Some(MAX_TURN_HISTORY_PAGE_BYTES);
        let page = hub
            .read_history("desktop", &read, |_| {
                let records = body.clone();
                async {
                    Ok(HistoryBatch {
                        records,
                        before: Some(0),
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(page.events.len(), 3);
        assert_eq!(page.turn_history.as_ref().unwrap().next_offset, None);
        assert_eq!(page.turn_history.as_ref().unwrap().before_turn, Some(0));

        // An old controller retains its byte bound for the identical Turn.
        let legacy = hub
            .read_history("old", &request(), |_| {
                let records = body.clone();
                async {
                    Ok(HistoryBatch {
                        records,
                        before: None,
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(legacy.events.len(), 2);
        assert_eq!(legacy.turn_history.unwrap().next_offset, Some(2));

        read.turn_history.as_mut().unwrap().max_bytes = Some(usize::MAX);
        for record in &mut body[1..] {
            record["item"]["data"]["content"] = "b".repeat(MAX_TURN_HISTORY_PAGE_BYTES / 2).into();
        }
        let bounded = hub
            .read_history("large", &read, |_| {
                let records = body.clone();
                async {
                    Ok(HistoryBatch {
                        records,
                        before: None,
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(bounded.events.len(), 2);
        assert_eq!(bounded.turn_history.unwrap().next_offset, Some(2));
    }

    #[tokio::test]
    async fn packets_keep_byte_bounds_and_snapshots_are_controller_scoped_and_epoch_fenced() {
        let hub = HostStreamHub::start(Arc::new(Quiet));
        let mut body = records(0, 2);
        body[1]["item"]["data"]["content"] = "a".repeat(PAGE_BYTES).into();
        let first = hub
            .read_history("desktop", &request(), |_| {
                let records = body.clone();
                async {
                    Ok(HistoryBatch {
                        records,
                        before: None,
                    })
                }
            })
            .await
            .unwrap();
        assert_eq!(first.events.len(), 1);
        let next = continuation(&first);
        assert!(hub
            .read_history("other", &next, |_| async { unreachable!() })
            .await
            .is_err());
        let second = hub
            .read_history("desktop", &next, |_| async { unreachable!() })
            .await
            .unwrap();
        assert_eq!(second.events.len(), 1); // A single oversized event travels alone.
        assert!(hub.invalidate_paged_history("s").await);
        let stale = hub
            .read_history("desktop", &continuation(&second), |_| async {
                unreachable!()
            })
            .await
            .unwrap();
        assert_ne!(stale.epoch, first.epoch);
        assert!(stale.turn_history.is_none());
        assert!(stale.events.is_empty());
    }

    #[tokio::test]
    async fn live_publication_is_not_suppressed_by_a_snapshot_seen_by_only_one_controller() {
        let hub = HostStreamHub::start(Arc::new(Quiet));
        let snapshot = hub
            .read_history("a", &request(), |_| async {
                Ok(HistoryBatch {
                    records: records(0, 1),
                    before: None,
                })
            })
            .await
            .unwrap();
        hub.synchronize_records("s".into(), false, || async { Ok(records(0, 1)) })
            .await
            .unwrap();
        let live = hub
            .read(
                "b",
                &StreamReadRequest {
                    stream_id: "s".into(),
                    after: Some(snapshot.cursor),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(live.events.len(), 2);
        hub.unsubscribe("a", "s");
        assert!(hub.lock().streams["s"].turn_snapshots.is_empty());
    }

    #[test]
    fn legacy_wire_shapes_round_trip_without_new_fields_and_ignore_the_read_offer() {
        let old_turn = serde_json::json!({"version":1,"offset":0});
        let turn: TurnHistoryRequest = serde_json::from_value(old_turn.clone()).unwrap();
        assert_eq!(turn.max_bytes, None);
        assert_eq!(serde_json::to_value(turn).unwrap(), old_turn);
        #[derive(Deserialize)]
        struct LegacyTurnRequest {
            version: u32,
            offset: usize,
        }
        let legacy_turn: LegacyTurnRequest = serde_json::from_value(
            serde_json::to_value(TurnHistoryRequest {
                max_bytes: Some(MAX_TURN_HISTORY_PAGE_BYTES),
                ..TurnHistoryRequest::latest()
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!((legacy_turn.version, legacy_turn.offset), (1, 0));
        let old = serde_json::json!({"stream_id":"s","subscribe":true,"limit":48});
        let read: StreamReadRequest = serde_json::from_value(old.clone()).unwrap();
        assert!(read.turn_history.is_none());
        assert_eq!(serde_json::to_value(read).unwrap(), old);
        #[derive(Deserialize)]
        struct LegacyRequest {
            stream_id: String,
            limit: Option<usize>,
            subscribe: bool,
        }
        let offered = serde_json::to_value(StreamReadRequest {
            limit: Some(48),
            ..request()
        })
        .unwrap();
        let legacy: LegacyRequest = serde_json::from_value(offered).unwrap();
        assert_eq!(legacy.stream_id, "s");
        assert_eq!(legacy.limit, Some(48));
        assert!(legacy.subscribe);
        let old_page = serde_json::json!({"stream_id":"s","epoch":1,"events":[],"has_more":false,"cursor":1,"oldest_seq":1,"truncated":false});
        let page: StreamPage = serde_json::from_value(old_page.clone()).unwrap();
        assert!(page.turn_history.is_none());
        assert_eq!(serde_json::to_value(page).unwrap(), old_page);
    }
}
