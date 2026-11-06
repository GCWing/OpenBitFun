use super::{ChatMode, ChatView};
use openbitfun_runtime_ports::DialogQueueRequest;
use std::time::{Duration, Instant};

impl ChatMode {
    pub(super) fn refresh_message_queue(
        &mut self,
        view: &mut ChatView,
        runtime: &tokio::runtime::Handle,
        request: Option<DialogQueueRequest>,
    ) {
        if self.pending_message_queue.is_some() {
            return;
        }
        view.message_queue_loading();
        let generation = view.message_queue_generation();
        let agent = self.agent.clone();
        let handle = runtime.spawn(async move {
            match tokio::time::timeout(
                std::time::Duration::from_secs(15),
                agent.message_queue(request),
            )
            .await
            {
                Ok(result) => {
                    result.map_err(|error| format!("{error}. Refresh before trying again."))
                }
                Err(_) => {
                    Err("Queue reply timed out; outcome unknown. Refresh before retrying.".into())
                }
            }
        });
        self.pending_message_queue = Some(super::PendingMessageQueue { generation, handle });
    }
    pub(super) fn poll_message_queue(
        &mut self,
        view: &mut ChatView,
        runtime: &tokio::runtime::Handle,
    ) -> bool {
        if self.pending_message_queue.is_none()
            && view.message_queue_can_auto_refresh()
            && Instant::now() >= self.next_message_queue_refresh
        {
            self.refresh_message_queue(view, runtime, None);
            return true;
        }
        if !self
            .pending_message_queue
            .as_ref()
            .is_some_and(|p| p.handle.is_finished())
        {
            return false;
        }
        let pending = self
            .pending_message_queue
            .take()
            .expect("finished task exists");
        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(pending.handle)
        })
        .unwrap_or_else(|_| Err("Queue request stopped; refresh before retrying.".into()));
        self.next_message_queue_refresh = Instant::now() + Duration::from_secs(2);
        if view.message_queue_visible() && view.message_queue_generation() == pending.generation {
            view.update_message_queue(result);
            return true;
        }
        // A popup may have been closed and reopened while the old call was pending.
        // Its reply is fenced out; schedule a fresh read for the new generation.
        if view.message_queue_visible() {
            self.next_message_queue_refresh = Instant::now();
        }
        false
    }
}
