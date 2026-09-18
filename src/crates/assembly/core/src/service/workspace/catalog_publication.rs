//! Host-local workspace catalog invalidation for product surfaces.
//!
//! The opened/recent workspace lists are owned by [`WorkspaceService`] and can
//! change without the rendering surface asking for it: a remote controller
//! (mobile web, IM bot, Peer Device Mode) opens or creates a workspace on this
//! host, or another surface of the same host does. Surfaces that cache the
//! catalog must be told to re-read it, otherwise the host UI keeps showing the
//! list from its last own operation while the Runtime already works in a
//! workspace it never displays.
//!
//! This publication is a hint, not a payload. Consumers re-read the catalog
//! through their normal commands; the revision only lets them ignore hints
//! they already applied.

use super::service::WorkspaceService;
use crate::infrastructure::events::EventEmitter;
use log::warn;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinHandle;

/// Event name delivered to host UI surfaces (and mirrored to attached Peer
/// Mode controllers by the host adapter).
pub const WORKSPACE_CATALOG_CHANGED_EVENT: &str = "workspace-catalog-changed";

/// Metadata writes from one runtime operation are coalesced into one hint.
const CATALOG_PUBLICATION_COALESCE: Duration = Duration::from_millis(75);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCatalogChangedEvent {
    /// Monotonic per-process catalog revision; equal revisions carry no change.
    pub revision: u64,
}

/// Forward workspace catalog revisions to `emitter` until the emitter task is
/// aborted or the catalog channel closes. The revision current at start is the
/// baseline and is not announced: the surface bootstraps the catalog itself.
pub fn start_workspace_catalog_publication(emitter: Arc<dyn EventEmitter>) -> JoinHandle<()> {
    publish_catalog_revisions(WorkspaceService::subscribe_catalog_changes(), emitter)
}

fn publish_catalog_revisions(
    mut changes: tokio::sync::watch::Receiver<u64>,
    emitter: Arc<dyn EventEmitter>,
) -> JoinHandle<()> {
    let mut published = *changes.borrow_and_update();
    tokio::spawn(async move {
        loop {
            if changes.changed().await.is_err() {
                break;
            }
            tokio::time::sleep(CATALOG_PUBLICATION_COALESCE).await;
            let revision = *changes.borrow_and_update();
            if revision == published {
                continue;
            }
            published = revision;
            let payload = match serde_json::to_value(WorkspaceCatalogChangedEvent { revision }) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!("Unable to serialize workspace catalog change hint: {error}");
                    continue;
                }
            };
            if let Err(error) = emitter.emit(WORKSPACE_CATALOG_CHANGED_EVENT, payload).await {
                warn!("Unable to publish workspace catalog change hint: {error}");
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingEmitter {
        events: Mutex<Vec<(String, serde_json::Value)>>,
    }

    #[async_trait::async_trait]
    impl EventEmitter for RecordingEmitter {
        async fn emit(&self, event_name: &str, payload: serde_json::Value) -> anyhow::Result<()> {
            self.events
                .lock()
                .expect("recording emitter lock")
                .push((event_name.to_string(), payload));
            Ok(())
        }
    }

    fn revisions(emitter: &RecordingEmitter) -> Vec<u64> {
        emitter
            .events
            .lock()
            .expect("recording emitter lock")
            .iter()
            .map(|(name, payload)| {
                assert_eq!(name, WORKSPACE_CATALOG_CHANGED_EVENT);
                serde_json::from_value::<WorkspaceCatalogChangedEvent>(payload.clone())
                    .expect("catalog hint payload")
                    .revision
            })
            .collect()
    }

    async fn settle() {
        tokio::time::sleep(CATALOG_PUBLICATION_COALESCE * 4).await;
    }

    fn bump(sender: &tokio::sync::watch::Sender<u64>) {
        sender.send_modify(|revision| *revision += 1);
    }

    #[tokio::test]
    async fn coalesces_catalog_writes_into_one_hint_and_skips_the_baseline() {
        let (sender, receiver) = tokio::sync::watch::channel(10u64);
        let emitter = Arc::new(RecordingEmitter::default());
        let task = publish_catalog_revisions(receiver, emitter.clone());
        settle().await;
        assert!(
            revisions(&emitter).is_empty(),
            "baseline must not be announced"
        );

        bump(&sender);
        bump(&sender);
        bump(&sender);
        settle().await;
        assert_eq!(
            revisions(&emitter),
            vec![13],
            "one runtime operation yields one hint carrying the latest revision"
        );

        bump(&sender);
        settle().await;
        assert_eq!(revisions(&emitter), vec![13, 14]);

        drop(sender);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("publication stops when the catalog channel closes")
            .expect("publication task completes");
    }

    #[test]
    fn hint_payload_uses_camel_case_wire_shape() {
        let payload = serde_json::to_value(WorkspaceCatalogChangedEvent { revision: 7 })
            .expect("serialize catalog hint");
        assert_eq!(payload, serde_json::json!({ "revision": 7 }));
    }
}
