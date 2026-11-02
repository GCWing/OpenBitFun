//! Cancellation boundaries for account-owned remote RPC execution.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::watch;

/// Runs one RPC stage while its caller retains the current routing lease.
///
/// Only model mutation execution may finish after cancellation. Preparation,
/// ownership revalidation and replies must remain separate cancellable stages.
/// A mutation accepted by its first poll is drained in this task, preserving
/// task-local ownership and keeping the lease until its commit or failure ends.
pub async fn run_rpc_stage<F>(
    cancellation: &mut watch::Receiver<u64>,
    finish_started: bool,
    operation: F,
) -> Option<F::Output>
where
    F: Future,
{
    if cancellation.has_changed().unwrap_or(true) {
        return None;
    }
    let admitted = AtomicBool::new(false);
    let checkpoint = cancellation.clone();
    let execution = async {
        if checkpoint.has_changed().unwrap_or(true) {
            return None;
        }
        admitted.store(true, Ordering::Relaxed);
        Some(operation.await)
    };
    tokio::pin!(execution);
    tokio::select! {
        biased;
        _ = cancellation.changed() => {
            if finish_started && admitted.load(Ordering::Relaxed) {
                let _ = execution.await;
            }
            None
        }
        result = &mut execution => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::{Notify, RwLock};

    tokio::task_local! {
        static OWNER: u64;
    }

    #[tokio::test]
    async fn cancellation_before_admission_never_executes() {
        let (cancel, mut cancelled) = watch::channel(0);
        cancel.send_replace(1);
        let executed = AtomicBool::new(false);
        assert_eq!(
            run_rpc_stage(&mut cancelled, true, async {
                executed.store(true, Ordering::Relaxed);
            })
            .await,
            None
        );
        assert!(!executed.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn a_closed_owner_never_executes() {
        let (cancel, mut cancelled) = watch::channel(0);
        drop(cancel);
        let executed = AtomicBool::new(false);
        assert_eq!(
            run_rpc_stage(&mut cancelled, true, async {
                executed.store(true, Ordering::Relaxed);
            })
            .await,
            None
        );
        assert!(!executed.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn completed_execution_returns_its_result() {
        let (_cancel, mut cancelled) = watch::channel(0);
        assert_eq!(
            run_rpc_stage(&mut cancelled, true, async { 42 }).await,
            Some(42)
        );
    }

    async fn cancelled_write_retains_lease_and_owner(fails: bool) {
        let (cancel, mut cancelled) = watch::channel(0);
        let lifecycle = Arc::new(RwLock::new(()));
        let lease = lifecycle.clone().read_owned().await;
        let admitted = Arc::new(Notify::new());
        let finish = Arc::new(Notify::new());
        let committed = Arc::new(AtomicBool::new(false));
        let task_admitted = admitted.clone();
        let task_finish = finish.clone();
        let task_committed = committed.clone();
        let task = tokio::spawn(OWNER.scope(7, async move {
            let _lease = lease;
            let result = run_rpc_stage(&mut cancelled, true, async {
                assert_eq!(OWNER.get(), 7);
                task_admitted.notify_one();
                task_finish.notified().await;
                assert_eq!(OWNER.get(), 7);
                task_committed.store(true, Ordering::Relaxed);
                if fails {
                    Err("commit failed")
                } else {
                    Ok(())
                }
            })
            .await;
            assert!(
                result.is_none(),
                "a retired RPC cannot proceed to its reply"
            );
        }));
        admitted.notified().await;
        cancel.send_replace(1);
        // A replacement owner must wait, even after cancellation was observed.
        let replacement = lifecycle.write();
        tokio::pin!(replacement);
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(
                replacement.as_mut().poll(cx).is_pending()
            ))
            .await
        );
        assert!(!committed.load(Ordering::Relaxed));
        finish.notify_one();
        task.await.unwrap();
        let _replacement = replacement.await;
        assert!(committed.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn cancelled_model_write_finishes_before_replacement_without_replying() {
        cancelled_write_retains_lease_and_owner(false).await;
    }

    #[tokio::test]
    async fn cancelled_failed_write_finishes_before_replacement_without_replying() {
        cancelled_write_retains_lease_and_owner(true).await;
    }

    #[tokio::test]
    async fn retirement_after_execution_suppresses_ownership_checks_and_reply() {
        let (cancel, mut cancelled) = watch::channel(0);
        let result = run_rpc_stage(&mut cancelled, true, async {
            cancel.send_replace(1);
            42
        })
        .await;
        assert_eq!(result, Some(42));
        let replied = AtomicBool::new(false);
        assert_eq!(
            run_rpc_stage(&mut cancelled, false, async {
                replied.store(true, Ordering::Relaxed);
            })
            .await,
            None
        );
        assert!(!replied.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn other_stages_remain_cancellable() {
        let (cancel, mut cancelled) = watch::channel(0);
        let admitted = Arc::new(Notify::new());
        let task_admitted = admitted.clone();
        let task = tokio::spawn(async move {
            run_rpc_stage(&mut cancelled, false, async {
                task_admitted.notify_one();
                std::future::pending::<()>().await;
            })
            .await
        });
        admitted.notified().await;
        cancel.send_replace(1);
        assert_eq!(task.await.unwrap(), None);
    }
}
