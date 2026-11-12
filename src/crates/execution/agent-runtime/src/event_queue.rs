//! Provider-neutral runtime event queue.

use crate::event_bus::EventBusResult;
use log::{debug, trace, warn};
use openbitfun_agent_stream::StreamEventSink;
use openbitfun_events::{
    AgenticEvent, AgenticEventEnvelope as EventEnvelope, AgenticEventPriority as EventPriority,
};
use std::collections::{BinaryHeap, HashMap};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock as StdRwLock, Weak,
};
use tokio::sync::{broadcast, oneshot, Mutex, Notify};

const MIN_EVENT_BROADCAST_BUFFER: usize = 1024;
// Session-scoped protocol consumers can pause while servicing an RPC. Keep a
// separate, fixed burst budget instead of inheriting the much larger global
// event queue capacity for every active session.
const SESSION_EVENT_BROADCAST_BUFFER: usize = MIN_EVENT_BROADCAST_BUFFER;
const SLOW_EVENT_QUEUE_LATENCY_MS: u128 = 250;

struct SessionBroadcast {
    sender: broadcast::Sender<EventEnvelope>,
}

type SessionBroadcastMap = HashMap<String, Arc<SessionBroadcast>>;

/// Receiver for one session's bounded event stream.
///
/// Dropping the last receiver removes the channel immediately so inactive
/// sessions retain neither their broadcast buffer nor an entry on the enqueue
/// path.
pub struct SessionEventReceiver {
    receiver: Option<broadcast::Receiver<EventEnvelope>>,
    channel: Weak<SessionBroadcast>,
    session_id: String,
    channels: Weak<StdRwLock<SessionBroadcastMap>>,
    has_channels: Weak<AtomicBool>,
}

impl std::fmt::Debug for SessionEventReceiver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionEventReceiver")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl SessionEventReceiver {
    pub async fn recv(&mut self) -> Result<EventEnvelope, broadcast::error::RecvError> {
        self.receiver
            .as_mut()
            .expect("session event receiver used after drop")
            .recv()
            .await
    }
}

impl Drop for SessionEventReceiver {
    fn drop(&mut self) {
        // Decrement the Tokio receiver count before deciding whether this
        // channel still has an active consumer.
        drop(self.receiver.take());

        let (Some(channels), Some(channel), Some(has_channels)) = (
            self.channels.upgrade(),
            self.channel.upgrade(),
            self.has_channels.upgrade(),
        ) else {
            return;
        };
        let mut channels = channels
            .write()
            .expect("session event channels lock poisoned");
        let remove = channels.get(&self.session_id).is_some_and(|current| {
            Arc::ptr_eq(current, &channel) && current.sender.receiver_count() == 0
        });
        if remove {
            channels.remove(&self.session_id);
        }
        has_channels.store(!channels.is_empty(), Ordering::Release);
    }
}

/// Event queue configuration
#[derive(Debug, Clone)]
pub struct EventQueueConfig {
    pub max_queue_size: usize,
    pub batch_size: usize,
}

impl Default for EventQueueConfig {
    fn default() -> Self {
        Self {
            max_queue_size: 10000,
            batch_size: 10, // Reduce to 10 to reduce latency
        }
    }
}

/// Queue statistics
#[derive(Debug, Clone, Default)]
pub struct QueueStats {
    pub pending_events: usize,
    pub total_enqueued: u64,
    pub total_processed: u64,
}

/// Completion handle for an event that must enter the legacy dequeue stream
/// before a producer may publish dependent events.
pub struct LegacyDequeueAck {
    receiver: oneshot::Receiver<()>,
}

impl LegacyDequeueAck {
    pub async fn wait(self) -> EventBusResult<()> {
        self.receiver
            .await
            .map_err(|_| crate::event_bus::EventBusError::subscriber("legacy dequeue fence closed"))
    }
}

#[derive(Clone, Copy)]
enum LegacyQueuePolicy {
    BestEffort,
    RequireImmediateAck,
    AuthoritativeControl,
}

/// Turn lifecycle facts a consumer cannot reconstruct from later stream data.
/// Losing one leaves a projection running forever, or settled without the
/// durable history fence that makes it reconcile canonical content, until a
/// full reload. Text and tool stream data stay best-effort: a delivered
/// lifecycle fence repairs them. Each turn emits only a handful of these, so
/// admitting them past the data budget stays bounded.
fn is_turn_lifecycle_fact(event: &AgenticEvent) -> bool {
    matches!(
        event,
        AgenticEvent::DialogTurnStarted { .. }
            | AgenticEvent::DialogTurnCompleted { .. }
            | AgenticEvent::DialogTurnCancelled { .. }
            | AgenticEvent::DialogTurnFailed { .. }
            | AgenticEvent::SessionStateChanged { .. }
            | AgenticEvent::SessionHistoryChanged { .. }
    )
}

fn interrupted_control_identity(event: &AgenticEvent) -> Option<(&str, &str, u32)> {
    match event {
        AgenticEvent::DialogTurnInterrupted {
            session_id,
            turn_id,
            execution_generation,
            ..
        }
        | AgenticEvent::DialogTurnRecovered {
            session_id,
            turn_id,
            execution_generation,
        } => Some((session_id, turn_id, *execution_generation)),
        _ => None,
    }
}

fn authoritative_control_supersedes(authoritative: &AgenticEvent, pending: &AgenticEvent) -> bool {
    let AgenticEvent::DialogTurnInterrupted {
        session_id,
        turn_id,
        execution_generation,
        ..
    } = authoritative
    else {
        return false;
    };
    interrupted_control_identity(pending).is_some_and(
        |(pending_session_id, pending_turn_id, pending_generation)| {
            pending_session_id == session_id
                && (pending_turn_id != turn_id || pending_generation <= *execution_generation)
        },
    )
}

fn authoritative_control_is_stale(authoritative: &AgenticEvent, pending: &AgenticEvent) -> bool {
    let Some((session_id, turn_id, execution_generation)) =
        interrupted_control_identity(authoritative)
    else {
        return false;
    };
    interrupted_control_identity(pending).is_some_and(
        |(pending_session_id, pending_turn_id, pending_generation)| {
            pending_session_id == session_id
                && pending_turn_id == turn_id
                && pending_generation > execution_generation
        },
    )
}

fn is_reclaimable_stream_data(authoritative: &AgenticEvent, pending: &AgenticEvent) -> bool {
    let AgenticEvent::DialogTurnInterrupted {
        session_id,
        turn_id,
        ..
    } = authoritative
    else {
        return false;
    };
    matches!(
        pending,
        AgenticEvent::TextChunk {
            session_id: pending_session_id,
            turn_id: pending_turn_id,
            ..
        } | AgenticEvent::ThinkingChunk {
            session_id: pending_session_id,
            turn_id: pending_turn_id,
            ..
        } if pending_session_id == session_id && pending_turn_id == turn_id
    )
}

/// Event queue
///
/// Core functionality:
/// - Priority sorting (Critical > High > Normal > Low)
/// - Batch processing (reduce frontend pressure)
/// - Event driven (Notify mechanism)
pub struct EventQueue {
    /// Priority queue
    queue: Arc<Mutex<BinaryHeap<std::cmp::Reverse<EventEnvelope>>>>,

    /// Notifier (used to wake up waiting consumers)
    notify: Arc<Notify>,

    /// One-shot acknowledgements completed when a fenced event is removed
    /// from the legacy priority queue into a concrete delivery batch.
    legacy_dequeue_acks: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,

    /// Broadcast stream for non-consuming subscribers.
    broadcast_tx: broadcast::Sender<EventEnvelope>,

    /// Session-scoped streams for protocol consumers that require isolation
    /// from traffic produced by other sessions.
    session_broadcasts: Arc<StdRwLock<SessionBroadcastMap>>,

    /// Avoid locking the session channel map on the common TUI/GUI path when
    /// no protocol consumer is active.
    has_session_broadcasts: Arc<AtomicBool>,

    /// Configuration
    config: EventQueueConfig,

    /// Statistics
    stats: Arc<Mutex<QueueStats>>,
}

impl EventQueue {
    pub fn new(config: EventQueueConfig) -> Self {
        // Keep subscriber backlog capacity at least as large as the existing
        // dequeue queue budget so switching a consumer to broadcast does not
        // reduce the amount of burst traffic it can tolerate.
        let broadcast_capacity = config.max_queue_size.max(MIN_EVENT_BROADCAST_BUFFER);
        let (broadcast_tx, _) = broadcast::channel(broadcast_capacity);
        Self {
            queue: Arc::new(Mutex::new(BinaryHeap::new())),
            notify: Arc::new(Notify::new()),
            legacy_dequeue_acks: Arc::new(Mutex::new(HashMap::new())),
            broadcast_tx,
            session_broadcasts: Arc::new(StdRwLock::new(HashMap::new())),
            has_session_broadcasts: Arc::new(AtomicBool::new(false)),
            config,
            stats: Arc::new(Mutex::new(QueueStats::default())),
        }
    }

    /// Enqueue event
    pub async fn enqueue(
        &self,
        event: AgenticEvent,
        priority: Option<EventPriority>,
    ) -> EventBusResult<String> {
        self.enqueue_internal(event, priority, LegacyQueuePolicy::BestEffort)
            .await
            .map(|(event_id, _)| event_id)
    }

    /// Enqueue an ordering fence into the legacy dequeue stream.
    ///
    /// Unlike ordinary events, a fence fails closed when the legacy queue is
    /// full. Awaiting the returned acknowledgement guarantees that the fence
    /// is already part of the current delivery batch, so later higher-priority
    /// events cannot overtake it in the priority heap.
    pub async fn enqueue_with_legacy_dequeue_ack(
        &self,
        event: AgenticEvent,
        priority: Option<EventPriority>,
    ) -> EventBusResult<(String, LegacyDequeueAck)> {
        let (event_id, ack) = self
            .enqueue_internal(event, priority, LegacyQueuePolicy::RequireImmediateAck)
            .await?;
        Ok((
            event_id,
            ack.expect("legacy dequeue acknowledgement requested"),
        ))
    }

    /// Enqueue an authoritative control event without allowing the bounded
    /// best-effort data budget to discard or block it. The queue first
    /// coalesces older session recovery controls and reclaims same-turn stream
    /// chunks. A separate bounded reserve protects unrelated lifecycle events.
    ///
    /// Broadcast happens only after legacy storage succeeds, keeping the
    /// Desktop WebView and non-consuming subscribers on the same lifecycle.
    pub async fn enqueue_with_guaranteed_legacy_storage(
        &self,
        event: AgenticEvent,
        priority: Option<EventPriority>,
    ) -> EventBusResult<String> {
        self.enqueue_internal(event, priority, LegacyQueuePolicy::AuthoritativeControl)
            .await
            .map(|(event_id, _)| event_id)
    }

    async fn enqueue_internal(
        &self,
        event: AgenticEvent,
        priority: Option<EventPriority>,
        legacy_policy: LegacyQueuePolicy,
    ) -> EventBusResult<(String, Option<LegacyDequeueAck>)> {
        // A best-effort producer cannot know that the queue is full; never let
        // that silently discard a lifecycle fact (see `is_turn_lifecycle_fact`).
        let legacy_policy = match legacy_policy {
            LegacyQueuePolicy::BestEffort if is_turn_lifecycle_fact(&event) => {
                LegacyQueuePolicy::AuthoritativeControl
            }
            policy => policy,
        };
        let priority = priority.unwrap_or_else(|| event.default_priority());
        let envelope = EventEnvelope::new(event, priority);
        let event_id = envelope.id.clone();
        let require_legacy_ack = matches!(legacy_policy, LegacyQueuePolicy::RequireImmediateAck);
        let (mut ack_sender, ack) = if require_legacy_ack {
            let (sender, receiver) = oneshot::channel();
            (Some(sender), Some(LegacyDequeueAck { receiver }))
        } else {
            (None, None)
        };

        let (queue_len, queued) = {
            let mut queue = self.queue.lock().await;
            if matches!(legacy_policy, LegacyQueuePolicy::AuthoritativeControl) {
                if let Some(pending) = queue
                    .iter()
                    .map(|std::cmp::Reverse(pending)| pending)
                    .find(|pending| authoritative_control_is_stale(&envelope.event, &pending.event))
                {
                    return Ok((pending.id.clone(), None));
                }
                let mut retained = BinaryHeap::with_capacity(queue.len());
                let mut removed_ids = Vec::new();
                while let Some(std::cmp::Reverse(pending)) = queue.pop() {
                    if authoritative_control_supersedes(&envelope.event, &pending.event) {
                        removed_ids.push(pending.id);
                    } else {
                        retained.push(std::cmp::Reverse(pending));
                    }
                }
                *queue = retained;

                if queue.len() >= self.config.max_queue_size {
                    let reclaim_id = queue
                        .iter()
                        .map(|std::cmp::Reverse(pending)| pending)
                        .filter(|pending| {
                            is_reclaimable_stream_data(&envelope.event, &pending.event)
                        })
                        .max()
                        .map(|pending| pending.id.clone());
                    if let Some(reclaim_id) = reclaim_id {
                        queue.retain(|std::cmp::Reverse(pending)| pending.id != reclaim_id);
                        warn!(
                            "Event queue full, reclaiming same-turn legacy stream data for authoritative control: event_id={}, reclaimed_event_id={}",
                            event_id, reclaim_id
                        );
                        removed_ids.push(reclaim_id);
                    }
                }

                let control_reserve = self.config.max_queue_size.max(1);
                let mut pending_controls = queue
                    .iter()
                    .filter(|std::cmp::Reverse(pending)| {
                        matches!(pending.event, AgenticEvent::DialogTurnInterrupted { .. })
                    })
                    .count();
                while queue.len() >= self.config.max_queue_size
                    && pending_controls >= control_reserve
                {
                    let oldest_control_id = queue
                        .iter()
                        .map(|std::cmp::Reverse(pending)| pending)
                        .filter(|pending| {
                            matches!(pending.event, AgenticEvent::DialogTurnInterrupted { .. })
                        })
                        .min_by_key(|pending| pending.timestamp)
                        .map(|pending| pending.id.clone());
                    let Some(oldest_control_id) = oldest_control_id else {
                        break;
                    };
                    queue.retain(|std::cmp::Reverse(pending)| pending.id != oldest_control_id);
                    removed_ids.push(oldest_control_id);
                    pending_controls -= 1;
                }

                if !removed_ids.is_empty() {
                    let mut acknowledgements = self.legacy_dequeue_acks.lock().await;
                    for removed_id in removed_ids {
                        acknowledgements.remove(&removed_id);
                    }
                }
            }
            let queued = if queue.len() >= self.config.max_queue_size {
                match legacy_policy {
                    LegacyQueuePolicy::RequireImmediateAck => {
                        return Err(crate::event_bus::EventBusError::subscriber(
                            "legacy event queue is full",
                        ));
                    }
                    LegacyQueuePolicy::AuthoritativeControl => {
                        warn!(
                            "Event queue data capacity full, using bounded authoritative legacy control reserve: event_id={}, reserve_limit={}",
                            event_id, self.config.max_queue_size.max(1)
                        );
                        true
                    }
                    LegacyQueuePolicy::BestEffort => {
                        warn!(
                            "Event queue full, skipping legacy queue storage: event_id={}",
                            event_id
                        );
                        false
                    }
                }
            } else {
                true
            };
            if queued {
                if let Some(sender) = ack_sender.take() {
                    self.legacy_dequeue_acks
                        .lock()
                        .await
                        .insert(event_id.clone(), sender);
                }
                queue.push(std::cmp::Reverse(envelope.clone()));
            }
            (queue.len(), queued)
        };

        // Broadcast delivery is authoritative for non-consuming runtime
        // subscribers and must not depend on capacity in the legacy dequeue
        // buffer. Session-scoped subscribers receive only matching traffic so
        // an unrelated session cannot consume their bounded backlog.
        let session_channel = if self.has_session_broadcasts.load(Ordering::Acquire) {
            envelope.event.session_id().and_then(|session_id| {
                self.session_broadcasts
                    .read()
                    .expect("session event channels lock poisoned")
                    .get(session_id)
                    .cloned()
            })
        } else {
            None
        };
        if let Some(channel) = session_channel {
            let _ = channel.sender.send(envelope.clone());
        }
        let _ = self.broadcast_tx.send(envelope);

        {
            let mut stats = self.stats.lock().await;
            stats.total_enqueued += 1;
            stats.pending_events = queue_len;
        }

        if queued {
            self.notify.notify_one();
        }

        trace!(
            "Event enqueued: event_id={}, priority={:?}",
            event_id,
            priority
        );

        Ok((event_id, ack))
    }

    /// Dequeue batch of events
    pub async fn dequeue_batch(&self, max_size: usize) -> Vec<EventEnvelope> {
        let mut batch = Vec::new();
        let mut queue = self.queue.lock().await;

        let take_count = max_size.min(queue.len());

        for _ in 0..take_count {
            if let Some(std::cmp::Reverse(envelope)) = queue.pop() {
                batch.push(envelope);
            }
        }
        let remaining_queue_len = queue.len();
        drop(queue);

        if !batch.is_empty() {
            let mut acknowledgements = self.legacy_dequeue_acks.lock().await;
            for envelope in &batch {
                if let Some(sender) = acknowledgements.remove(&envelope.id) {
                    let _ = sender.send(());
                }
            }
        }

        if let Some((max_age_ms, event_id, priority)) = batch
            .iter()
            .filter_map(|envelope| {
                envelope
                    .timestamp
                    .elapsed()
                    .ok()
                    .map(|age| (age.as_millis(), envelope.id.as_str(), envelope.priority))
            })
            .max_by_key(|(age_ms, _, _)| *age_ms)
        {
            if max_age_ms >= SLOW_EVENT_QUEUE_LATENCY_MS {
                warn!(
                    "Slow agentic event queue delivery: max_age_ms={}, batch_size={}, remaining_queue_len={}, event_id={}, priority={:?}",
                    max_age_ms,
                    batch.len(),
                    remaining_queue_len,
                    event_id,
                    priority
                );
            }
        }

        // Update statistics
        if !batch.is_empty() {
            let mut stats = self.stats.lock().await;
            stats.total_processed += batch.len() as u64;
            stats.pending_events = remaining_queue_len;
        }

        batch
    }

    /// Dequeue a batch using the queue's configured batch size.
    pub async fn dequeue_configured_batch(&self) -> Vec<EventEnvelope> {
        self.dequeue_batch(self.config.batch_size).await
    }

    /// Subscribe to events without consuming them from the queue.
    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.broadcast_tx.subscribe()
    }

    /// Subscribe to one session before events enter the bounded receiver.
    pub fn subscribe_session(&self, session_id: &str) -> SessionEventReceiver {
        let existing = {
            let channels = self
                .session_broadcasts
                .read()
                .expect("session event channels lock poisoned");
            channels.get(session_id).map(|channel| {
                // Subscribe while holding the read lock so the last previous
                // receiver cannot remove this channel between lookup and the
                // Tokio receiver count increment.
                (channel.clone(), channel.sender.subscribe())
            })
        };
        if let Some((channel, receiver)) = existing {
            return self.session_receiver(session_id, &channel, receiver);
        }

        // Allocate outside the map lock. The second check below resolves a
        // concurrent first subscriber without holding the global enqueue path
        // while Tokio allocates the bounded channel.
        let (sender, candidate_receiver) = broadcast::channel(SESSION_EVENT_BROADCAST_BUFFER);
        let candidate = Arc::new(SessionBroadcast { sender });
        let (channel, receiver) = {
            let mut channels = self
                .session_broadcasts
                .write()
                .expect("session event channels lock poisoned");
            if let Some(channel) = channels.get(session_id).cloned() {
                let receiver = channel.sender.subscribe();
                (channel, receiver)
            } else {
                channels.insert(session_id.to_string(), candidate.clone());
                self.has_session_broadcasts.store(true, Ordering::Release);
                (candidate, candidate_receiver)
            }
        };
        self.session_receiver(session_id, &channel, receiver)
    }

    fn session_receiver(
        &self,
        session_id: &str,
        channel: &Arc<SessionBroadcast>,
        receiver: broadcast::Receiver<EventEnvelope>,
    ) -> SessionEventReceiver {
        SessionEventReceiver {
            receiver: Some(receiver),
            channel: Arc::downgrade(channel),
            session_id: session_id.to_string(),
            channels: Arc::downgrade(&self.session_broadcasts),
            has_channels: Arc::downgrade(&self.has_session_broadcasts),
        }
    }

    /// Clear all events for a session
    pub async fn clear_session(&self, session_id: &str) -> EventBusResult<()> {
        // Remove all events for this session from the queue
        let (queue_len, removed_ids) = {
            let mut queue = self.queue.lock().await;
            let mut new_queue = BinaryHeap::new();
            let mut removed_ids = Vec::new();

            while let Some(std::cmp::Reverse(envelope)) = queue.pop() {
                if envelope.event.session_id() != Some(session_id) {
                    new_queue.push(std::cmp::Reverse(envelope));
                } else {
                    removed_ids.push(envelope.id);
                }
            }

            *queue = new_queue;
            (queue.len(), removed_ids)
        };

        if !removed_ids.is_empty() {
            let mut acknowledgements = self.legacy_dequeue_acks.lock().await;
            for removed_id in removed_ids {
                acknowledgements.remove(&removed_id);
            }
        }

        // Update statistics: use the size obtained earlier
        {
            let mut stats = self.stats.lock().await;
            stats.pending_events = queue_len;
        }

        debug!("Cleared all events for session: session_id={}", session_id);

        Ok(())
    }

    /// Get queue statistics
    pub async fn stats(&self) -> QueueStats {
        self.stats.lock().await.clone()
    }

    /// Wait for events (used for consumers)
    pub async fn wait_for_events(&self) {
        self.notify.notified().await;
    }

    /// Get queue size
    pub async fn len(&self) -> usize {
        self.queue.lock().await.len()
    }

    /// Check if the queue is empty
    pub async fn is_empty(&self) -> bool {
        self.queue.lock().await.is_empty()
    }
}

#[async_trait::async_trait]
impl StreamEventSink for EventQueue {
    async fn enqueue(&self, event: AgenticEvent, priority: Option<EventPriority>) {
        let _ = EventQueue::enqueue(self, event, priority).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{EventQueue, EventQueueConfig};
    use openbitfun_events::{AgenticEvent, AgenticEventPriority};
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    #[tokio::test]
    async fn legacy_dequeue_ack_separates_later_high_priority_events() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 8,
            batch_size: 8,
        });
        queue
            .enqueue(
                AgenticEvent::SessionStateChanged {
                    session_id: "session".to_string(),
                    new_state: "old-data".to_string(),
                },
                Some(AgenticEventPriority::Normal),
            )
            .await
            .expect("old event should enqueue");
        let (_, acknowledgement) = queue
            .enqueue_with_legacy_dequeue_ack(
                AgenticEvent::DialogTurnRecovered {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                },
                Some(AgenticEventPriority::Normal),
            )
            .await
            .expect("fence should enqueue");
        let mut acknowledgement = Box::pin(acknowledgement.wait());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), &mut acknowledgement)
                .await
                .is_err(),
            "fence must not acknowledge before dequeue"
        );

        let batch = queue.dequeue_configured_batch().await;
        acknowledgement
            .await
            .expect("fence should acknowledge its delivery batch");
        assert_eq!(batch.len(), 2);
        assert!(matches!(
            &batch[0].event,
            AgenticEvent::SessionStateChanged { new_state, .. } if new_state == "old-data"
        ));
        assert!(matches!(
            &batch[1].event,
            AgenticEvent::DialogTurnRecovered {
                execution_generation: 1,
                ..
            }
        ));

        queue
            .enqueue(
                AgenticEvent::DialogTurnCancelled {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                },
                Some(AgenticEventPriority::Critical),
            )
            .await
            .expect("later event should enqueue");
        let next_batch = queue.dequeue_configured_batch().await;
        assert!(matches!(
            &next_batch[0].event,
            AgenticEvent::DialogTurnCancelled { .. }
        ));
    }

    #[tokio::test]
    async fn legacy_dequeue_fence_fails_before_broadcast_when_queue_is_full() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        let mut events = queue.subscribe();
        queue
            .enqueue(
                AgenticEvent::TextChunk {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    round_id: "round".to_string(),
                    attempt_id: None,
                    attempt_index: None,
                    text: "occupied".to_string(),
                },
                None,
            )
            .await
            .expect("first event should enqueue");
        events.recv().await.expect("first broadcast should arrive");

        let result = queue
            .enqueue_with_legacy_dequeue_ack(
                AgenticEvent::DialogTurnRecovered {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                },
                Some(AgenticEventPriority::Normal),
            )
            .await;

        assert!(result.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(1), events.recv())
                .await
                .is_err(),
            "a rejected fence must not be broadcast as recovered"
        );
    }

    #[tokio::test]
    async fn authoritative_legacy_control_bypasses_data_capacity_without_losing_delivery() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        let mut events = queue.subscribe();
        queue
            .enqueue(
                AgenticEvent::TextChunk {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    round_id: "round".to_string(),
                    attempt_id: None,
                    attempt_index: None,
                    text: "occupied".to_string(),
                },
                None,
            )
            .await
            .expect("first event should enqueue");
        events.recv().await.expect("first broadcast should arrive");

        tokio::time::timeout(
            Duration::from_millis(10),
            queue.enqueue_with_guaranteed_legacy_storage(
                AgenticEvent::DialogTurnInterrupted {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                    model_id: Some("model".to_string()),
                },
                Some(AgenticEventPriority::Critical),
            ),
        )
        .await
        .expect("authoritative control event must not wait for data capacity")
        .expect("authoritative control event should enqueue");
        assert_eq!(
            queue.len().await,
            1,
            "authoritative control should reclaim lower-priority data capacity"
        );
        assert!(matches!(
            events
                .recv()
                .await
                .expect("authoritative broadcast should arrive")
                .event,
            AgenticEvent::DialogTurnInterrupted { .. }
        ));

        queue
            .enqueue_with_guaranteed_legacy_storage(
                AgenticEvent::DialogTurnInterrupted {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 2,
                    model_id: Some("model".to_string()),
                },
                Some(AgenticEventPriority::Critical),
            )
            .await
            .expect("newer authoritative control event should enqueue");
        events
            .recv()
            .await
            .expect("newer authoritative broadcast should arrive");
        assert_eq!(
            queue.len().await,
            1,
            "a newer generation must replace the queued control event for the same turn"
        );

        queue
            .enqueue_with_guaranteed_legacy_storage(
                AgenticEvent::DialogTurnInterrupted {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                    model_id: Some("model".to_string()),
                },
                Some(AgenticEventPriority::Critical),
            )
            .await
            .expect("stale authoritative control should be ignored idempotently");
        assert_eq!(queue.len().await, 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(1), events.recv())
                .await
                .is_err(),
            "a stale generation must not be broadcast"
        );

        let delivered = queue.dequeue_configured_batch().await;
        assert!(matches!(
            &delivered[0].event,
            AgenticEvent::DialogTurnInterrupted {
                execution_generation: 2,
                ..
            }
        ));
        assert!(queue.dequeue_configured_batch().await.is_empty());
    }

    #[tokio::test]
    async fn authoritative_control_preserves_unrelated_lifecycle_events() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        queue
            .enqueue(
                AgenticEvent::SessionStateChanged {
                    session_id: "other-session".to_string(),
                    new_state: "idle".to_string(),
                },
                None,
            )
            .await
            .expect("lifecycle event should enqueue");
        queue
            .enqueue_with_guaranteed_legacy_storage(
                AgenticEvent::DialogTurnInterrupted {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                    model_id: Some("model".to_string()),
                },
                Some(AgenticEventPriority::Critical),
            )
            .await
            .expect("authoritative control should use its reserve");

        assert_eq!(queue.len().await, 2);
        assert!(matches!(
            queue.dequeue_configured_batch().await[0].event,
            AgenticEvent::DialogTurnInterrupted { .. }
        ));
        assert!(matches!(
            queue.dequeue_configured_batch().await[0].event,
            AgenticEvent::SessionStateChanged { .. }
        ));
    }

    #[tokio::test]
    async fn authoritative_control_reserve_is_bounded_across_distinct_turns() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        for index in 0..3 {
            queue
                .enqueue_with_guaranteed_legacy_storage(
                    AgenticEvent::DialogTurnInterrupted {
                        session_id: format!("session-{index}"),
                        turn_id: format!("turn-{index}"),
                        execution_generation: 1,
                        model_id: Some("model".to_string()),
                    },
                    Some(AgenticEventPriority::Critical),
                )
                .await
                .expect("authoritative control should remain bounded");
            assert_eq!(queue.len().await, 1);
        }

        let delivered = queue.dequeue_configured_batch().await;
        assert!(matches!(
            &delivered[0].event,
            AgenticEvent::DialogTurnInterrupted {
                session_id,
                turn_id,
                ..
            } if session_id == "session-2" && turn_id == "turn-2"
        ));
    }

    #[tokio::test]
    async fn authoritative_interruption_replaces_the_same_turn_recovery_fence() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        let (_, recovery_ack) = queue
            .enqueue_with_legacy_dequeue_ack(
                AgenticEvent::DialogTurnRecovered {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                },
                Some(AgenticEventPriority::Normal),
            )
            .await
            .expect("recovery fence should enqueue");

        queue
            .enqueue_with_guaranteed_legacy_storage(
                AgenticEvent::DialogTurnInterrupted {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                    model_id: Some("model".to_string()),
                },
                Some(AgenticEventPriority::Critical),
            )
            .await
            .expect("authoritative interruption should replace its recovery fence");

        assert_eq!(queue.len().await, 1);
        tokio::time::timeout(Duration::from_millis(10), recovery_ack.wait())
            .await
            .expect("superseded fence acknowledgement should close promptly")
            .expect_err("a superseded fence must not acknowledge delivery");
        let delivered = queue.dequeue_configured_batch().await;
        assert!(matches!(
            &delivered[0].event,
            AgenticEvent::DialogTurnInterrupted { .. }
        ));
    }

    #[tokio::test]
    async fn clearing_a_session_closes_its_pending_recovery_fence() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        let (_, recovery_ack) = queue
            .enqueue_with_legacy_dequeue_ack(
                AgenticEvent::DialogTurnRecovered {
                    session_id: "session".to_string(),
                    turn_id: "turn".to_string(),
                    execution_generation: 1,
                },
                Some(AgenticEventPriority::Normal),
            )
            .await
            .expect("recovery fence should enqueue");

        queue
            .clear_session("session")
            .await
            .expect("session events should clear");

        assert!(queue.is_empty().await);
        tokio::time::timeout(Duration::from_millis(10), recovery_ack.wait())
            .await
            .expect("cleared fence acknowledgement should close promptly")
            .expect_err("a cleared fence must not acknowledge delivery");
    }

    #[tokio::test]
    async fn full_legacy_queue_does_not_drop_broadcast_delivery() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 1,
            batch_size: 1,
        });
        let mut events = queue.subscribe();

        for session_id in ["first", "second"] {
            queue
                .enqueue(
                    AgenticEvent::TextChunk {
                        session_id: session_id.to_string(),
                        turn_id: "turn".to_string(),
                        round_id: "round".to_string(),
                        attempt_id: None,
                        attempt_index: None,
                        text: "data".to_string(),
                    },
                    None,
                )
                .await
                .expect("event should enqueue");
        }

        assert_eq!(queue.len().await, 1);
        assert_eq!(
            events
                .recv()
                .await
                .expect("first broadcast")
                .event
                .session_id(),
            Some("first")
        );
        assert_eq!(
            events
                .recv()
                .await
                .expect("second broadcast")
                .event
                .session_id(),
            Some("second")
        );
    }

    #[tokio::test]
    async fn full_queue_keeps_turn_lifecycle_facts_of_another_session() {
        let queue = EventQueue::new(EventQueueConfig {
            max_queue_size: 2,
            batch_size: 16,
        });
        let chunk = |session_id: &str, text: &str| AgenticEvent::TextChunk {
            session_id: session_id.to_string(),
            turn_id: "turn".to_string(),
            round_id: "round".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: text.to_string(),
        };
        // Another session floods the data budget.
        for text in ["flood-1", "flood-2"] {
            queue.enqueue(chunk("busy", text), None).await.unwrap();
        }
        // This session's last chunk is best-effort data and may be skipped...
        queue.enqueue(chunk("quiet", "tail"), None).await.unwrap();
        // ...but its settlement and history fence must reach the consumer.
        queue
            .enqueue(
                AgenticEvent::DialogTurnCompleted {
                    session_id: "quiet".to_string(),
                    turn_id: "turn".to_string(),
                    total_rounds: 1,
                    total_tools: 0,
                    duration_ms: 1,
                    partial_recovery_reason: None,
                    success: Some(true),
                    finish_reason: None,
                    has_final_response: Some(true),
                    background_delivery: None,
                },
                None,
            )
            .await
            .unwrap();
        queue
            .enqueue(
                AgenticEvent::SessionHistoryChanged {
                    session_id: "quiet".to_string(),
                    settled_turn_id: Some("turn".to_string()),
                },
                None,
            )
            .await
            .unwrap();

        let delivered = queue.dequeue_batch(16).await;
        let quiet: Vec<_> = delivered
            .iter()
            .filter(|envelope| envelope.event.session_id() == Some("quiet"))
            .map(|envelope| &envelope.event)
            .collect();
        assert!(quiet
            .iter()
            .any(|event| matches!(event, AgenticEvent::DialogTurnCompleted { .. })));
        assert!(quiet
            .iter()
            .any(|event| matches!(event, AgenticEvent::SessionHistoryChanged { .. })));
        assert!(!quiet
            .iter()
            .any(|event| matches!(event, AgenticEvent::TextChunk { .. })));
    }

    #[tokio::test]
    async fn default_sized_broadcast_preserves_bursts_above_legacy_1024_limit() {
        let queue = EventQueue::new(EventQueueConfig::default());
        let mut events = queue.subscribe();
        const EVENT_COUNT: usize = 2048;

        for index in 0..EVENT_COUNT {
            queue
                .enqueue(
                    AgenticEvent::SessionStateChanged {
                        session_id: "session".to_string(),
                        new_state: index.to_string(),
                    },
                    None,
                )
                .await
                .expect("event should enqueue");
        }

        for expected in 0..EVENT_COUNT {
            let envelope = events.recv().await.expect("burst event must be retained");
            assert!(matches!(
                envelope.event,
                AgenticEvent::SessionStateChanged { ref new_state, .. }
                    if new_state == &expected.to_string()
            ));
        }
    }

    #[test]
    fn concurrent_publishers_have_one_order_for_all_subscribers() {
        const EVENT_COUNT: usize = 64;
        let queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let mut first = queue.subscribe();
        let mut second = queue.subscribe();
        let barrier = Arc::new(Barrier::new(EVENT_COUNT));
        let mut publishers = Vec::with_capacity(EVENT_COUNT);

        for index in 0..EVENT_COUNT {
            let queue = queue.clone();
            let barrier = barrier.clone();
            publishers.push(std::thread::spawn(move || {
                barrier.wait();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("publisher runtime")
                    .block_on(async move {
                        queue
                            .enqueue(
                                AgenticEvent::SessionStateChanged {
                                    session_id: format!("event-{index}"),
                                    new_state: "idle".to_string(),
                                },
                                None,
                            )
                            .await
                            .expect("event should enqueue")
                    })
            }));
        }
        for publisher in publishers {
            publisher.join().expect("publisher should complete");
        }

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("subscriber runtime")
            .block_on(async move {
                let mut first_ids = Vec::with_capacity(EVENT_COUNT);
                let mut second_ids = Vec::with_capacity(EVENT_COUNT);
                for _ in 0..EVENT_COUNT {
                    first_ids.push(first.recv().await.expect("first broadcast").id);
                    second_ids.push(second.recv().await.expect("second broadcast").id);
                }
                assert_eq!(first_ids, second_ids);
            });
    }

    #[test]
    fn dropping_last_session_receiver_releases_its_channel() {
        let queue = EventQueue::new(EventQueueConfig::default());
        let receiver = queue.subscribe_session("session");
        assert_eq!(queue.session_broadcasts.read().unwrap().len(), 1);

        drop(receiver);

        assert!(queue.session_broadcasts.read().unwrap().is_empty());
    }
}
