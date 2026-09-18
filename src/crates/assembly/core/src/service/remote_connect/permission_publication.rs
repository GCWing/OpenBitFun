//! Bridge runtime permission authority into the existing controller mailbox invalidation.
use std::collections::BTreeSet;
use std::sync::Arc;

use super::host_stream::HostStreamHub;

pub(super) fn start(hub: &Arc<HostStreamHub>) {
    let manager = match crate::product_runtime::core_permission_request_manager() {
        Ok(manager) => manager,
        Err(error) => {
            log::error!("Unable to subscribe to runtime permission changes: {error}");
            return;
        }
    };
    // Subscribe before taking the initial snapshot so startup cannot miss a request.
    let mut changes = manager.subscribe();
    let mut closed = hub.subscribe_closed();
    let weak = Arc::downgrade(hub);
    tokio::spawn(async move {
        let mut previous = BTreeSet::new();
        loop {
            if *closed.borrow() {
                break;
            }
            let snapshot = manager.interactive_pending_snapshot();
            let current = snapshot
                .requests
                .iter()
                .map(|request| request.session_id.clone())
                .collect();
            let sessions = affected_sessions(&previous, &current);
            let Some(hub) = weak.upgrade() else {
                break;
            };
            let events = sessions.into_iter().map(|session_id| {
                (session_id.clone(), "session-interaction-changed".to_string(),
                    serde_json::json!({"sessionId": session_id, "permissionsRevision": snapshot.revision}))
            }).collect::<Vec<_>>();
            if !events.is_empty() {
                tokio::select! {
                    biased;
                    _ = closed.changed() => break,
                    result = hub.append_batch(events) => if let Err(error) = result {
                        log::error!("Unable to publish permission mailbox invalidation: {error}");
                    }
                }
            }
            drop(hub);
            previous = current;
            tokio::select! {
                biased;
                _ = closed.changed() => break,
                event = changes.recv() => match event {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    });
}

// Removed requests must invalidate their old session too. Rebuilding from the
// live snapshot on every notification also recovers from a lagged broadcast;
// no request payloads or credentials are copied into the host stream.
fn affected_sessions(previous: &BTreeSet<String>, current: &BTreeSet<String>) -> BTreeSet<String> {
    previous
        .union(current)
        .filter(|session| !session.is_empty())
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn initial_pending_requests_invalidate_their_sessions() {
        assert_eq!(
            affected_sessions(&sessions(&[]), &sessions(&["a", "b"])),
            sessions(&["a", "b"])
        );
    }

    #[test]
    fn reply_or_cancellation_invalidates_the_now_empty_mailbox() {
        assert_eq!(
            affected_sessions(&sessions(&["a"]), &sessions(&[])),
            sessions(&["a"])
        );
    }

    #[test]
    fn lag_recovery_invalidates_removed_and_current_sessions_without_empty_routes() {
        assert_eq!(
            affected_sessions(&sessions(&["a", "b"]), &sessions(&["b", "c", ""])),
            sessions(&["a", "b", "c"])
        );
    }
}
