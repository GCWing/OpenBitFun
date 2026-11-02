//! Durable routing facts. Callers own scope keys, eligibility and policy;
//! this service owns versioned, locked, atomic local persistence only.

use crate::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceBinding {
    pub resource_key: String,
    pub revision: u64,
}

fn decode_binding(value: Value) -> Result<ResourceBinding, String> {
    let binding: ResourceBinding = serde_json::from_value(value).map_err(|error| {
        format!("Invalid routing binding; existing data was preserved: {error}")
    })?;
    if binding.resource_key.is_empty() {
        return Err(
            "Invalid routing binding resource identity; existing data was preserved".into(),
        );
    }
    Ok(binding)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceCooldown {
    pub revision: u64,
    pub until: i64,
}

#[derive(Debug, Clone)]
pub struct RoutingStateStore {
    directory: PathBuf,
}

impl RoutingStateStore {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn path(&self, kind: &str, key: &str) -> PathBuf {
        let digest = format!("{:x}", Sha256::digest(key.as_bytes()));
        self.directory.join(kind).join(format!("{digest}.json"))
    }

    async fn read(&self, path: &Path) -> Result<Value, String> {
        let raw = JsonFileStore
            .read_optional::<Value>(path)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| json!({"version":1}));
        if raw.get("version").and_then(Value::as_u64) != Some(1) {
            return Err("Unsupported routing state version; existing data was preserved".into());
        }
        Ok(raw)
    }

    pub async fn binding(&self, scope: &str) -> Result<Option<ResourceBinding>, String> {
        let raw = self.read(&self.path("affinity", scope)).await?;
        raw.get("binding").cloned().map(decode_binding).transpose()
    }

    pub async fn bind(&self, scope: &str, binding: ResourceBinding) -> Result<(), String> {
        if binding.resource_key.is_empty() {
            return Err("Routing binding requires a resource identity".into());
        }
        let path = self.path("affinity", scope);
        let _guard = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|error| error.to_string())?;
        let mut raw = self.read(&path).await?;
        // Verify the old shape before changing it; unknown fields survive.
        if let Some(existing) = raw.get("binding") {
            let existing = decode_binding(existing.clone())?;
            if existing.resource_key == binding.resource_key && existing.revision > binding.revision
            {
                return Ok(());
            }
        }
        raw["binding"]["resource_key"] = json!(binding.resource_key);
        raw["binding"]["revision"] = json!(binding.revision);
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn cooldown(
        &self,
        scope: &str,
        resource: &str,
    ) -> Result<Option<ResourceCooldown>, String> {
        let key = serde_json::to_string(&(scope, resource)).map_err(|error| error.to_string())?;
        let raw = self.read(&self.path("cooldown", &key)).await?;
        raw.get("cooldown")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                format!("Invalid routing cooldown; existing data was preserved: {error}")
            })
    }

    /// Ignore stale epochs and never shorten a same-epoch block because a
    /// slower failure response arrives later. A new epoch supersedes the old.
    pub async fn extend_cooldown(
        &self,
        scope: &str,
        resource: &str,
        cooldown: ResourceCooldown,
    ) -> Result<(), String> {
        let key = serde_json::to_string(&(scope, resource)).map_err(|error| error.to_string())?;
        let path = self.path("cooldown", &key);
        let _guard = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|error| error.to_string())?;
        let mut raw = self.read(&path).await?;
        if let Some(existing) = raw.get("cooldown") {
            let existing: ResourceCooldown =
                serde_json::from_value(existing.clone()).map_err(|error| {
                    format!("Invalid routing cooldown; existing data was preserved: {error}")
                })?;
            if existing.revision > cooldown.revision
                || (existing.revision == cooldown.revision && existing.until >= cooldown.until)
            {
                return Ok(());
            }
        }
        raw["cooldown"]["revision"] = json!(cooldown.revision);
        raw["cooldown"]["until"] = json!(cooldown.until);
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bindings_survive_restart_and_scopes_and_readers_stay_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routing");
        let store = RoutingStateStore::new(path.clone());
        assert_eq!(store.binding("lineage-a").await.unwrap(), None);
        assert_eq!(store.cooldown("model", "seat").await.unwrap(), None);
        assert!(!path.exists());
        let binding = ResourceBinding {
            resource_key: "seat".into(),
            revision: 7,
        };
        store.bind("lineage-a", binding.clone()).await.unwrap();
        let restarted = RoutingStateStore::new(path);
        assert_eq!(restarted.binding("lineage-a").await.unwrap(), Some(binding));
        assert_eq!(restarted.binding("lineage-b").await.unwrap(), None);
        restarted
            .bind(
                "lineage-a",
                ResourceBinding {
                    resource_key: "seat".into(),
                    revision: 8,
                },
            )
            .await
            .unwrap();
        store
            .bind(
                "lineage-a",
                ResourceBinding {
                    resource_key: "seat".into(),
                    revision: 7,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            restarted
                .binding("lineage-a")
                .await
                .unwrap()
                .unwrap()
                .revision,
            8
        );
    }

    #[tokio::test]
    async fn competing_failures_keep_the_longest_current_epoch_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let first = RoutingStateStore::new(dir.path().into());
        let second = first.clone();
        let (a, b) = tokio::join!(
            first.extend_cooldown(
                "model",
                "seat",
                ResourceCooldown {
                    revision: 7,
                    until: 500
                }
            ),
            second.extend_cooldown(
                "model",
                "seat",
                ResourceCooldown {
                    revision: 7,
                    until: 200
                }
            )
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(
            first
                .cooldown("model", "seat")
                .await
                .unwrap()
                .unwrap()
                .until,
            500
        );
        first
            .extend_cooldown(
                "model",
                "seat",
                ResourceCooldown {
                    revision: 8,
                    until: 100,
                },
            )
            .await
            .unwrap();
        second
            .extend_cooldown(
                "model",
                "seat",
                ResourceCooldown {
                    revision: 7,
                    until: 999,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            first.cooldown("model", "seat").await.unwrap(),
            Some(ResourceCooldown {
                revision: 8,
                until: 100
            })
        );
        assert_eq!(first.cooldown("other-model", "seat").await.unwrap(), None);
    }

    #[tokio::test]
    async fn unknown_fields_survive_and_unreadable_or_future_state_is_not_reset() {
        let dir = tempfile::tempdir().unwrap();
        let store = RoutingStateStore::new(dir.path().into());
        let binding = ResourceBinding {
            resource_key: "seat".into(),
            revision: 1,
        };
        store.bind("scope", binding.clone()).await.unwrap();
        let path = store.path("affinity", "scope");
        let mut raw: Value = JsonFileStore.read_optional(&path).await.unwrap().unwrap();
        raw["future"] = json!({"keep":true});
        raw["binding"]["future"] = json!({"keep":true});
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .unwrap();
        store.bind("scope", binding.clone()).await.unwrap();
        assert_eq!(
            JsonFileStore
                .read_optional::<Value>(&path)
                .await
                .unwrap()
                .unwrap()["future"],
            raw["future"]
        );
        assert_eq!(
            JsonFileStore
                .read_optional::<Value>(&path)
                .await
                .unwrap()
                .unwrap()["binding"]["future"],
            raw["binding"]["future"]
        );
        for invalid in [
            b"broken".as_slice(),
            b"{\"version\":99}",
            b"{\"version\":1,\"binding\":{}}",
            b"{\"version\":1,\"binding\":{\"resource_key\":\"\",\"revision\":1}}",
        ] {
            tokio::fs::write(&path, invalid).await.unwrap();
            assert!(store.binding("scope").await.is_err());
            assert!(store.bind("scope", binding.clone()).await.is_err());
            assert_eq!(tokio::fs::read(&path).await.unwrap(), invalid);
        }
    }

    #[tokio::test]
    async fn cooldown_extensions_preserve_future_fields_and_reject_invalid_data() {
        let dir = tempfile::tempdir().unwrap();
        let store = RoutingStateStore::new(dir.path().into());
        store
            .extend_cooldown(
                "model",
                "seat",
                ResourceCooldown {
                    revision: 1,
                    until: 100,
                },
            )
            .await
            .unwrap();
        let key = serde_json::to_string(&("model", "seat")).unwrap();
        let path = store.path("cooldown", &key);
        let mut raw: Value = JsonFileStore.read_optional(&path).await.unwrap().unwrap();
        raw["future"] = json!(true);
        raw["cooldown"]["future"] = json!([1, 2]);
        JsonFileStore
            .write_atomic_strict(&path, &raw)
            .await
            .unwrap();
        store
            .extend_cooldown(
                "model",
                "seat",
                ResourceCooldown {
                    revision: 2,
                    until: 200,
                },
            )
            .await
            .unwrap();
        let after: Value = JsonFileStore.read_optional(&path).await.unwrap().unwrap();
        assert_eq!(after["future"], raw["future"]);
        assert_eq!(after["cooldown"]["future"], raw["cooldown"]["future"]);
        for invalid in [
            b"broken".as_slice(),
            b"{\"version\":99}",
            b"{\"version\":1,\"cooldown\":{}}",
        ] {
            tokio::fs::write(&path, invalid).await.unwrap();
            assert!(store.cooldown("model", "seat").await.is_err());
            assert!(store
                .extend_cooldown(
                    "model",
                    "seat",
                    ResourceCooldown {
                        revision: 3,
                        until: 300
                    }
                )
                .await
                .is_err());
            assert_eq!(tokio::fs::read(&path).await.unwrap(), invalid);
        }
    }
}
