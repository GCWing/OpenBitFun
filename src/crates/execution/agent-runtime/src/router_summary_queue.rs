//! Fair, bounded admission for background Router summaries.
//!
//! Product assembly supplies the work and owns provider calls, deadlines and
//! persistence. This queue coordinates admission: one pending snapshot per leaf
//! session, round-robin between root tasks, FIFO inside each root, and one running
//! item per leaf. Classifier calls can use unique request IDs as leaf identities.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Notify;

/// Shared by the execution host, never by an individual controller or turn.
pub struct RouterSummaryQueue<T> {
    concurrency: usize,
    max_pending_sessions: usize,
    max_pending_per_root: usize,
    state: Mutex<QueueState<T>>,
}

struct QueueState<T> {
    next_id: u64,
    entries: HashMap<u64, Entry<T>>,
    waiting: VecDeque<u64>,
    waiting_roots: VecDeque<String>,
    last_dispatched_root: Option<String>,
    /// Includes reserved work until its ticket consumes the snapshot.
    pending_by_session: HashMap<String, u64>,
    /// Includes reservations so a slow poll cannot exceed the concurrency cap.
    active: HashMap<String, (u64, String)>,
}

struct Entry<T> {
    root_session_id: String,
    session_id: String,
    work: T,
    reserved: bool,
    notify: Arc<Notify>,
}

/// Kept by the context owner while the ticket waits in a background task.
pub struct RouterSummaryUpdate<T> {
    queue: Weak<RouterSummaryQueue<T>>,
    id: u64,
}

/// Dropping this ticket, including a cancelled `start` future, removes its work.
pub struct RouterSummaryTicket<T> {
    queue: Arc<RouterSummaryQueue<T>>,
    id: u64,
    notify: Arc<Notify>,
    pending: bool,
}

/// Hold for the complete provider request. Drop releases admission immediately.
pub struct RouterSummaryPermit<T> {
    queue: Arc<RouterSummaryQueue<T>>,
    session_id: String,
    id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterSummaryQueueFull;

impl fmt::Display for RouterSummaryQueueFull {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Router summary queue is full")
    }
}

impl std::error::Error for RouterSummaryQueueFull {}

impl<T> RouterSummaryQueue<T> {
    pub fn new(concurrency: usize, max_pending_sessions: usize) -> Arc<Self> {
        assert!(
            concurrency > 0,
            "Router summary concurrency must be positive"
        );
        Arc::new(Self {
            concurrency,
            max_pending_sessions,
            // Leave room for unrelated conversations even when one root creates
            // many children. Only waiting work is capped: idle capacity is borrowed.
            max_pending_per_root: max_pending_sessions.div_ceil(4).clamp(1, 8),
            state: Mutex::new(QueueState {
                next_id: 0,
                entries: HashMap::new(),
                waiting: VecDeque::new(),
                waiting_roots: VecDeque::new(),
                last_dispatched_root: None,
                pending_by_session: HashMap::new(),
                active: HashMap::new(),
            }),
        })
    }

    /// A new generation replaces that session's waiting snapshot without moving
    /// its FIFO position. Its old ticket resolves to `None`; an already running
    /// request is never superseded here and must be cancelled by its owner.
    pub fn submit(
        self: &Arc<Self>,
        session_id: impl Into<String>,
        work: T,
    ) -> Result<(RouterSummaryUpdate<T>, RouterSummaryTicket<T>), RouterSummaryQueueFull> {
        let session_id = session_id.into();
        self.submit_for(session_id.clone(), session_id, work)
    }

    /// Scheduling uses the root task, while replacement and running exclusion
    /// continue to use the leaf session. Sibling contexts never replace each other.
    pub fn submit_for(
        self: &Arc<Self>,
        root_session_id: impl Into<String>,
        session_id: impl Into<String>,
        work: T,
    ) -> Result<(RouterSummaryUpdate<T>, RouterSummaryTicket<T>), RouterSummaryQueueFull> {
        let session_id = session_id.into();
        let mut state = self
            .state
            .lock()
            .expect("Router summary queue lock poisoned");
        let previous_id = state.pending_by_session.get(&session_id).copied();
        // Existing work retains its admitted root even if a caller's attribution
        // changes during recovery; changing roots must not evade waiting limits.
        let root_session_id = previous_id
            .and_then(|id| {
                state
                    .entries
                    .get(&id)
                    .map(|entry| entry.root_session_id.clone())
            })
            .or_else(|| state.active.get(&session_id).map(|(_, root)| root.clone()))
            .unwrap_or_else(|| root_session_id.into());
        let can_start =
            state.active.len() < self.concurrency && !state.active.contains_key(&session_id);
        let root_waiting = state
            .waiting
            .iter()
            .filter(|id| state.entries[*id].root_session_id == root_session_id)
            .count();
        if previous_id.is_none()
            && !can_start
            && (state.waiting.len() >= self.max_pending_sessions
                || root_waiting >= self.max_pending_per_root)
        {
            return Err(RouterSummaryQueueFull);
        }

        let id = state.next_id;
        state.next_id = id.checked_add(1).expect("Router summary ticket overflow");
        let previous = previous_id.and_then(|id| state.entries.remove(&id));
        let reserved = previous.as_ref().is_some_and(|entry| entry.reserved);
        let notify = Arc::new(Notify::new());
        state.entries.insert(
            id,
            Entry {
                root_session_id: root_session_id.clone(),
                session_id: session_id.clone(),
                work,
                reserved,
                notify: notify.clone(),
            },
        );
        state.pending_by_session.insert(session_id.clone(), id);
        if reserved {
            state.active.insert(session_id, (id, root_session_id));
            notify.notify_one();
        } else if let Some(previous_id) = previous_id {
            let position = state
                .waiting
                .iter_mut()
                .find(|queued_id| **queued_id == previous_id)
                .expect("Pending Router summary must retain its queue position");
            *position = id;
        } else {
            state.waiting.push_back(id);
            if !state.waiting_roots.contains(&root_session_id) {
                state.waiting_roots.push_back(root_session_id);
            }
        }
        state.dispatch(self.concurrency);
        drop(state);
        if let Some(previous) = previous {
            previous.notify.notify_one();
        }

        Ok((
            RouterSummaryUpdate {
                queue: Arc::downgrade(self),
                id,
            },
            RouterSummaryTicket {
                queue: self.clone(),
                id,
                notify,
                pending: true,
            },
        ))
    }

    pub fn available_permits(&self) -> usize {
        let state = self
            .state
            .lock()
            .expect("Router summary queue lock poisoned");
        self.concurrency - state.active.len()
    }

    fn cancel(&self, id: u64) {
        let mut state = self
            .state
            .lock()
            .expect("Router summary queue lock poisoned");
        let removed = state.entries.remove(&id);
        if let Some(entry) = &removed {
            state.pending_by_session.remove(&entry.session_id);
            if entry.reserved {
                state.active.remove(&entry.session_id);
            } else {
                state.waiting.retain(|queued_id| *queued_id != id);
                if !state
                    .waiting
                    .iter()
                    .any(|id| state.entries[id].root_session_id == entry.root_session_id)
                {
                    state
                        .waiting_roots
                        .retain(|root| *root != entry.root_session_id);
                }
            }
            state.dispatch(self.concurrency);
        }
        // Work may have its own destructor; run it outside the queue lock.
        drop(state);
        drop(removed);
    }
}

impl<T> QueueState<T> {
    fn dispatch(&mut self, concurrency: usize) {
        while self.active.len() < concurrency {
            let runnable_position = |root: &str| {
                self.waiting.iter().position(|id| {
                    let entry = &self.entries[id];
                    entry.root_session_id == root && !self.active.contains_key(&entry.session_id)
                })
            };
            // Rotate roots, not children. When a second root joins a previously
            // solitary busy root, it gets the next released slot. A root blocked
            // by its own running leaf cannot hold up other runnable work.
            let mut candidates =
                self.waiting_roots
                    .iter()
                    .enumerate()
                    .filter_map(|(root_index, root)| {
                        runnable_position(root).map(|position| {
                            (
                                root_index,
                                position,
                                Some(root) == self.last_dispatched_root.as_ref(),
                            )
                        })
                    });
            let first = candidates.next();
            let choice = first.and_then(|first| {
                if first.2 {
                    candidates
                        .find(|(_, _, is_last_root)| !is_last_root)
                        .or(Some(first))
                } else {
                    Some(first)
                }
            });
            let Some((root_index, index, _)) = choice else {
                break;
            };
            let root = self
                .waiting_roots
                .remove(root_index)
                .expect("Root queue position exists");
            let id = self.waiting.remove(index).expect("Queue position exists");
            if self
                .waiting
                .iter()
                .any(|id| self.entries[id].root_session_id == root)
            {
                self.waiting_roots.push_back(root.clone());
            }
            self.last_dispatched_root = Some(root.clone());
            let entry = self.entries.get_mut(&id).expect("Queued entry exists");
            entry.reserved = true;
            self.active.insert(entry.session_id.clone(), (id, root));
            entry.notify.notify_one();
        }
    }
}

impl<T> Clone for RouterSummaryUpdate<T> {
    fn clone(&self) -> Self {
        Self {
            queue: self.queue.clone(),
            id: self.id,
        }
    }
}

impl<T> RouterSummaryUpdate<T> {
    /// Replaces a waiting snapshot, including a reservation not yet consumed by
    /// `start`. Returns false once the request starts, is cancelled or replaced.
    pub fn update(&self, work: T) -> bool {
        let Some(queue) = self.queue.upgrade() else {
            return false;
        };
        let mut state = queue
            .state
            .lock()
            .expect("Router summary queue lock poisoned");
        let previous = state
            .entries
            .get_mut(&self.id)
            .map(|entry| std::mem::replace(&mut entry.work, work));
        drop(state);
        previous.is_some()
    }

    /// True until the background task consumes its queued snapshot.
    pub fn is_queued(&self) -> bool {
        self.queue.upgrade().is_some_and(|queue| {
            queue
                .state
                .lock()
                .expect("Router summary queue lock poisoned")
                .entries
                .contains_key(&self.id)
        })
    }
}

impl<T> RouterSummaryTicket<T> {
    /// Wait for admission and return the newest coalesced snapshot. A newer
    /// submission for this session can supersede this ticket while it waits.
    pub async fn start(mut self) -> Option<(T, RouterSummaryPermit<T>)> {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self
                    .queue
                    .state
                    .lock()
                    .expect("Router summary queue lock poisoned");
                let Some(entry) = state.entries.get(&self.id) else {
                    self.pending = false;
                    return None;
                };
                if entry.reserved {
                    let entry = state.entries.remove(&self.id).expect("Entry exists");
                    state.pending_by_session.remove(&entry.session_id);
                    self.pending = false;
                    return Some((
                        entry.work,
                        RouterSummaryPermit {
                            queue: self.queue.clone(),
                            session_id: entry.session_id,
                            id: self.id,
                        },
                    ));
                }
            }
            notified.await;
        }
    }
}

impl<T> Drop for RouterSummaryTicket<T> {
    fn drop(&mut self) {
        if self.pending {
            self.queue.cancel(self.id);
        }
    }
}

impl<T> Drop for RouterSummaryPermit<T> {
    fn drop(&mut self) {
        let mut state = self
            .queue
            .state
            .lock()
            .expect("Router summary queue lock poisoned");
        if state
            .active
            .get(&self.session_id)
            .is_some_and(|(id, _)| *id == self.id)
        {
            state.active.remove(&self.session_id);
            state.dispatch(self.queue.concurrency);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    /// Poll without advancing time or dropping a still-waiting ticket.
    fn ready<F: Future>(future: std::pin::Pin<&mut F>) -> Option<F::Output> {
        match future.poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(result) => Some(result),
            Poll::Pending => None,
        }
    }

    #[tokio::test]
    async fn fifo_coalesces_without_starving_another_session() {
        let queue = RouterSummaryQueue::new(1, 2);
        let (_, first) = queue.submit("active", 0).unwrap();
        let (_, active) = first.start().await.unwrap();
        let (a_update, a) = queue.submit("a", 1).unwrap();
        let (_, b) = queue.submit("b", 2).unwrap();
        assert!(a_update.update(3));
        let (a_update, a_new) = queue.submit("a", 4).unwrap();
        assert!(a.start().await.is_none());

        let mut a_new = pin!(a_new.start());
        let mut b = pin!(b.start());
        assert!(ready(a_new.as_mut()).is_none());
        assert!(ready(b.as_mut()).is_none());
        drop(active);
        let (work, permit) = ready(a_new.as_mut()).unwrap().unwrap();
        assert_eq!(work, 4);
        assert!(!a_update.is_queued());
        assert!(!a_update.update(5));
        assert!(ready(b.as_mut()).is_none());
        let (_, a_next) = queue.submit("a", 6).unwrap();
        drop(permit);
        let (work, permit) = ready(b.as_mut()).unwrap().unwrap();
        assert_eq!(work, 2);
        drop(permit);
        assert_eq!(a_next.start().await.unwrap().0, 6);
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn same_session_never_overlaps_and_does_not_block_others() {
        let queue = RouterSummaryQueue::new(2, 4);
        let (_, a) = queue.submit("a", 1).unwrap();
        let (_, a_running) = a.start().await.unwrap();
        let (_, a_next) = queue.submit("a", 2).unwrap();
        let mut a_next = pin!(a_next.start());
        assert!(ready(a_next.as_mut()).is_none());
        let (_, b) = queue.submit("b", 3).unwrap();
        let (_, b_running) = b.start().await.unwrap();
        assert_eq!(queue.available_permits(), 0);
        drop(b_running);
        assert_eq!(queue.available_permits(), 1);
        assert!(ready(a_next.as_mut()).is_none());
        drop(a_running);
        let (work, _permit) = ready(a_next.as_mut()).unwrap().unwrap();
        assert_eq!(work, 2);
    }

    #[tokio::test]
    async fn busy_root_children_rotate_with_other_roots_in_leaf_fifo_order() {
        let queue = RouterSummaryQueue::new(1, 16);
        let (_, active) = queue.submit_for("a", "a-0", 0).unwrap();
        let (_, active) = active.start().await.unwrap();
        let (_, a1) = queue.submit_for("a", "a-1", 1).unwrap();
        let (_, a2) = queue.submit_for("a", "a-2", 2).unwrap();
        let (_, b1) = queue.submit_for("b", "b-1", 3).unwrap();
        let (_, b2) = queue.submit_for("b", "b-2", 4).unwrap();
        let mut a1 = pin!(a1.start());
        let mut a2 = pin!(a2.start());
        let mut b1 = pin!(b1.start());
        let mut b2 = pin!(b2.start());

        drop(active);
        assert!(ready(a1.as_mut()).is_none());
        let (work, permit) = ready(b1.as_mut()).unwrap().unwrap();
        assert_eq!(work, 3);
        drop(permit);
        assert!(ready(b2.as_mut()).is_none());
        let (work, permit) = ready(a1.as_mut()).unwrap().unwrap();
        assert_eq!(work, 1);
        drop(permit);
        assert!(ready(a2.as_mut()).is_none());
        let (work, permit) = ready(b2.as_mut()).unwrap().unwrap();
        assert_eq!(work, 4);
        drop(permit);
        let (work, permit) = ready(a2.as_mut()).unwrap().unwrap();
        assert_eq!(work, 2);
        drop(permit);
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn one_root_borrows_idle_capacity_but_cannot_fill_the_waiting_queue() {
        let queue = RouterSummaryQueue::new(2, 8);
        let (_, a0) = queue.submit_for("a", "a-0", 0).unwrap();
        let (_, a1) = queue.submit_for("a", "a-1", 1).unwrap();
        assert_eq!(queue.available_permits(), 0);
        let (_, a2) = queue.submit_for("a", "a-2", 2).unwrap();
        let (_, a3) = queue.submit_for("a", "a-3", 3).unwrap();
        assert!(queue.submit_for("a", "a-4", 4).is_err());
        let (_, b0) = queue.submit_for("b", "b-0", 5).unwrap();
        let mut b0 = pin!(b0.start());
        drop(a0);
        let (work, permit) = ready(b0.as_mut()).unwrap().unwrap();
        assert_eq!(work, 5);
        drop(a2);
        let (_, a4) = queue.submit_for("a", "a-4", 4).unwrap();
        drop((a1, a3, a4, permit));
        assert_eq!(queue.available_permits(), 2);
    }

    #[tokio::test]
    async fn root_grouping_keeps_sibling_coalescing_and_attribution_separate() {
        let queue = RouterSummaryQueue::new(1, 8);
        let (_, active) = queue.submit_for("a", "a-0", 0).unwrap();
        let (_, old_a1) = queue.submit_for("a", "a-1", 1).unwrap();
        let (a2_update, a2) = queue.submit_for("a", "a-2", 2).unwrap();
        // A changed attribution must not move an existing leaf or bypass its root cap.
        let (_, a1) = queue.submit_for("unrelated", "a-1", 3).unwrap();
        assert!(old_a1.start().await.is_none());
        assert!(queue.submit_for("a", "a-3", 4).is_err());
        assert!(a2_update.update(5));
        let (_, b) = queue.submit_for("b", "b-0", 6).unwrap();
        let mut a1 = pin!(a1.start());
        let mut a2 = pin!(a2.start());
        let mut b = pin!(b.start());
        drop(active);
        let (work, permit) = ready(b.as_mut()).unwrap().unwrap();
        assert_eq!(work, 6);
        drop(permit);
        let (work, permit) = ready(a1.as_mut()).unwrap().unwrap();
        assert_eq!(work, 3);
        drop(permit);
        let (work, permit) = ready(a2.as_mut()).unwrap().unwrap();
        assert_eq!(work, 5);
        drop(permit);
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelling_a_roots_last_waiter_does_not_leave_a_phantom_group() {
        let queue = RouterSummaryQueue::new(1, 8);
        let (_, active) = queue.submit_for("a", "a-0", 0).unwrap();
        let (_, a1) = queue.submit_for("a", "a-1", 1).unwrap();
        let (_, b) = queue.submit_for("b", "b-0", 2).unwrap();
        let mut cancelled = Box::pin(b.start());
        assert!(ready(cancelled.as_mut()).is_none());
        drop(cancelled);
        drop(active);
        let (_, permit) = a1.start().await.unwrap();
        let (_, a2) = queue.submit_for("a", "a-2", 3).unwrap();
        let (_, b) = queue.submit_for("b", "b-1", 4).unwrap();
        let mut b = pin!(b.start());
        drop(permit);
        let (work, permit) = ready(b.as_mut()).unwrap().unwrap();
        assert_eq!(work, 4);
        drop((a2, permit));
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancellation_removes_queued_work_and_releases_reservations() {
        let queue = RouterSummaryQueue::new(1, 2);
        let (_, active) = queue.submit("active", 0).unwrap();
        let (cancelled_update, cancelled) = queue.submit("cancelled", 1).unwrap();
        let (_, next) = queue.submit("next", 2).unwrap();
        drop(cancelled);
        assert!(!cancelled_update.is_queued());
        drop(active);
        let (work, permit) = next.start().await.unwrap();
        assert_eq!(work, 2);
        drop(permit);
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelled_wait_future_frees_queue_capacity() {
        let queue = RouterSummaryQueue::new(1, 1);
        let (_, active) = queue.submit("active", 0).unwrap();
        let (_, queued) = queue.submit("queued", 1).unwrap();
        let mut waiting = Box::pin(queued.start());
        assert!(ready(waiting.as_mut()).is_none());
        assert!(queue.submit("another", 2).is_err());
        drop(waiting);
        let (_, another) = queue.submit("another", 2).unwrap();
        drop(active);
        assert_eq!(another.start().await.unwrap().0, 2);
    }

    #[tokio::test]
    async fn reserved_work_can_be_updated_or_superseded_before_start() {
        let queue = RouterSummaryQueue::new(1, 1);
        let (old_update, old) = queue.submit("session", 1).unwrap();
        assert!(old_update.update(2));
        let (new_update, new) = queue.submit("session", 3).unwrap();
        assert!(!old_update.update(4));
        assert!(old.start().await.is_none());
        assert_eq!(queue.available_permits(), 0);
        assert!(new_update.update(5));
        let (work, permit) = new.start().await.unwrap();
        assert_eq!(work, 5);
        assert!(!new_update.is_queued());
        drop(permit);
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn queue_bound_allows_coalescing_but_rejects_new_waiting_sessions() {
        let queue = RouterSummaryQueue::new(1, 1);
        let (_, active) = queue.submit("active", 0).unwrap();
        let (_, old) = queue.submit("queued", 1).unwrap();
        assert!(queue.submit("overflow", 2).is_err());
        let (_, latest) = queue.submit("queued", 3).unwrap();
        drop(old);
        assert!(queue.submit("overflow", 4).is_err());
        drop(active);
        assert_eq!(latest.start().await.unwrap().0, 3);
        assert_eq!(queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn zero_waiting_capacity_still_admits_available_concurrency() {
        let queue = RouterSummaryQueue::new(2, 0);
        let (_, a) = queue.submit("a", 1).unwrap();
        let (_, b) = queue.submit("b", 2).unwrap();
        assert!(queue.submit("c", 3).is_err());
        drop(a);
        let (_, c) = queue.submit("c", 4).unwrap();
        assert_eq!(c.start().await.unwrap().0, 4);
        drop(b);
        assert_eq!(queue.available_permits(), 2);
    }

    #[tokio::test]
    async fn superseded_waiter_is_woken_without_waiting_for_a_free_slot() {
        let queue = RouterSummaryQueue::new(1, 1);
        let (_, active) = queue.submit("active", 0).unwrap();
        let (_, old) = queue.submit("queued", 1).unwrap();
        let old_waiter = tokio::spawn(old.start());
        tokio::task::yield_now().await;
        let (_, latest) = queue.submit("queued", 2).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), old_waiter)
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        drop(active);
        assert_eq!(latest.start().await.unwrap().0, 2);
    }

    #[tokio::test]
    async fn aborted_running_task_releases_slot_and_wakes_next_session() {
        let queue = RouterSummaryQueue::new(1, 1);
        let (_, first) = queue.submit("first", 1).unwrap();
        let (started, barrier) = tokio::sync::oneshot::channel();
        let running = tokio::spawn(async move {
            let (_, _permit) = first.start().await.unwrap();
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        barrier.await.unwrap();
        let (_, next) = queue.submit("next", 2).unwrap();
        let next_waiter = tokio::spawn(next.start());
        tokio::task::yield_now().await;
        running.abort();
        assert!(running.await.unwrap_err().is_cancelled());
        let (work, permit) = tokio::time::timeout(std::time::Duration::from_secs(1), next_waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(work, 2);
        drop(permit);
        assert_eq!(queue.available_permits(), 1);
    }
}
