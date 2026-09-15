//! Execution-owned speculative work. Completion publication is the linearization
//! point: a failure observed before claim is discarded, a failure after claim is
//! returned to the caller. No event, persistence, or provider dependencies.

use std::future::Future;
use tokio::{sync::oneshot, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub const PREFETCH_LEAD_TOKENS: usize = 10_000;

pub fn in_prefetch_window(pressure: usize, input_limit: usize) -> bool {
    input_limit > PREFETCH_LEAD_TOKENS
        && pressure >= input_limit - PREFETCH_LEAD_TOKENS
        && pressure < input_limit
}

pub struct CompressionPrefetch<T, E> {
    receiver: oneshot::Receiver<Result<T, E>>,
    task: JoinHandle<()>,
    cancellation: CancellationToken,
}

pub enum PrefetchClaim<T, E> {
    Discarded,
    Ready(T),
    Waiting(CompressionPrefetch<T, E>),
}

impl<T: Send + 'static, E: Send + 'static> CompressionPrefetch<T, E> {
    pub fn spawn(
        parent: &CancellationToken,
        work: impl Future<Output = Result<T, E>> + Send + 'static,
    ) -> Self {
        let cancellation = parent.child_token();
        let worker_token = cancellation.clone();
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = worker_token.cancelled() => {}
                result = work => { let _ = sender.send(result); }
            }
        });
        Self {
            receiver,
            task,
            cancellation,
        }
    }

    /// A single synchronized observation latches the failure policy. Do not
    /// re-check completion after receiving Waiting.
    pub fn claim(mut self) -> PrefetchClaim<T, E> {
        match self.receiver.try_recv() {
            Ok(Ok(value)) => PrefetchClaim::Ready(value),
            Ok(Err(_)) | Err(oneshot::error::TryRecvError::Closed) => PrefetchClaim::Discarded,
            Err(oneshot::error::TryRecvError::Empty) => PrefetchClaim::Waiting(self),
        }
    }

    pub async fn wait(mut self) -> Result<Result<T, E>, oneshot::error::RecvError> {
        (&mut self.receiver).await
    }
}

impl<T, E> Drop for CompressionPrefetch<T, E> {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_prefetch_thresholds() {
        assert!(!in_prefetch_window(147_999, 158_000));
        assert!(in_prefetch_window(148_000, 158_000));
        assert!(!in_prefetch_window(158_000, 158_000));
        assert!(!in_prefetch_window(200_000, 158_000));
        assert!(!in_prefetch_window(1, 10_000));
    }

    #[tokio::test]
    async fn compression_prefetch_completed_failure_is_discarded() {
        let work = CompressionPrefetch::<(), &str>::spawn(&CancellationToken::new(), async {
            Err("failed")
        });
        // Joining a separate publication barrier would precede sender.send;
        // observing task completion guarantees the result was published.
        while !work.task.is_finished() {
            tokio::task::yield_now().await;
        }
        assert!(matches!(work.claim(), PrefetchClaim::Discarded));
    }

    #[tokio::test]
    async fn compression_prefetch_claim_latches_running_failure() {
        let (release, barrier) = oneshot::channel();
        let work = CompressionPrefetch::<(), &str>::spawn(&CancellationToken::new(), async {
            barrier.await.unwrap();
            Err("failed after claim")
        });
        let PrefetchClaim::Waiting(work) = work.claim() else {
            panic!("must claim pending work")
        };
        release.send(()).unwrap();
        assert_eq!(work.wait().await.unwrap(), Err("failed after claim"));
    }

    #[tokio::test]
    async fn compression_prefetch_drop_releases_pending_work() {
        let (sender, receiver) = oneshot::channel::<()>();
        let work = CompressionPrefetch::<(), ()>::spawn(&CancellationToken::new(), async move {
            let _sender = sender;
            std::future::pending().await
        });
        drop(work);
        assert!(receiver.await.is_err());
    }
}
