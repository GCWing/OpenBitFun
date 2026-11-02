//! Pool editing uses the main configuration owner and its atomic mutation lock.
use super::{AIConfig, ConfigService};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
pub use openbitfun_config_contracts::model_pool::{ModelPoolDefinition, ModelPoolDocument};
use std::collections::HashSet;
use std::path::PathBuf;

fn generate_pool_id() -> String {
    const ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    loop {
        // UUID v4 uses the OS random source. Its first six bytes contain no
        // version/variant bits. Reject the remainder to avoid modulo bias.
        let random = uuid::Uuid::new_v4();
        let bytes = &random.as_bytes()[..6];
        if bytes.iter().any(|byte| *byte >= 252) {
            continue;
        }
        let suffix: String = bytes
            .iter()
            .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
            .collect();
        return format!("model-pool-{suffix}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::PathManager;
    use crate::service::config::manager::ConfigManagerSettings;
    use serde_json::json;
    use std::sync::Arc;

    fn draft(name: &str) -> ModelPoolDefinition {
        ModelPoolDefinition {
            id: String::new(),
            name: name.into(),
            strategy: "ordered".into(),
            member_model_ids: vec![],
            extensions: Default::default(),
        }
    }

    async fn service(path_manager: Arc<PathManager>) -> ConfigService {
        ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(path_manager),
            auto_save: true,
            backup_count: 0,
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn model_pool_create_retries_collisions_and_edit_keeps_identity() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Arc::new(PathManager::with_user_root_for_tests(dir.path().to_owned()));
        let service = service(paths.clone()).await;
        let existing = json!({"id":"model-pool-aaaaaa", "name":"Existing", "strategy":"ordered", "member_model_ids":[]});
        let unreadable = json!({"id":"model-pool-bbbbbb", "future_field":true});
        service
            .set_config(
                "ai.model_pools",
                json!({
                    "version":1, "pools":[existing.clone(), unreadable.clone()]
                }),
            )
            .await
            .unwrap();
        let store = service.model_pool_store().await;
        let mut candidates = [
            "model-pool-aaaaaa",
            "model-pool-bbbbbb",
            "model-pool-cccccc",
        ]
        .into_iter();
        let saved = store
            .save_with_id_generator(draft("Created"), || {
                candidates.next().expect("collision retry exhausted").into()
            })
            .await
            .unwrap();
        assert_eq!(saved.pools.len(), 3);
        assert_eq!(saved.pools[0], existing);
        assert_eq!(saved.pools[1], unreadable);
        let mut renamed = saved.get("model-pool-cccccc").unwrap();
        renamed.name = "Renamed".into();
        store
            .save_with_id_generator(renamed.clone(), || {
                panic!("editing must not generate an ID")
            })
            .await
            .unwrap();
        let reloaded = self::service(paths).await;
        let loaded = reloaded
            .model_pool_store()
            .await
            .get(&renamed.id)
            .await
            .unwrap();
        assert_eq!(loaded, renamed);
        store.delete(&renamed.id).await.unwrap();
        assert!(matches!(
            store.save(renamed).await,
            Err(OpenBitFunError::NotFound(_))
        ));
        assert_eq!(
            store.read().await.unwrap().pools,
            vec![existing, unreadable]
        );
    }

    #[tokio::test]
    async fn model_pool_concurrent_creates_allocate_under_the_write_lock() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(Arc::new(PathManager::with_user_root_for_tests(
            dir.path().to_owned(),
        )))
        .await;
        let store = service.model_pool_store().await;
        let mut first_ids = ["model-pool-aaaaaa", "model-pool-bbbbbb"].into_iter();
        let mut second_ids = first_ids.clone();
        let (first, second) = tokio::join!(
            store.save_with_id_generator(draft("First"), || first_ids.next().unwrap().into()),
            store.save_with_id_generator(draft("Second"), || second_ids.next().unwrap().into()),
        );
        first.unwrap();
        second.unwrap();
        let saved = store.read().await.unwrap();
        assert_eq!(saved.pools.len(), 2);
        let names: HashSet<_> = saved
            .pools
            .iter()
            .map(|pool| pool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, HashSet::from(["First", "Second"]));
        assert!(saved.get("model-pool-aaaaaa").is_ok());
        assert!(saved.get("model-pool-bbbbbb").is_ok());
    }
}

pub struct ModelPoolStore<'a> {
    service: &'a ConfigService,
    runtime_path: PathBuf,
}

impl<'a> ModelPoolStore<'a> {
    pub fn new(service: &'a ConfigService, directory: PathBuf) -> Self {
        Self {
            service,
            runtime_path: directory.join("model-pool-runtime.v1.json"),
        }
    }

    pub fn runtime_state_path(&self) -> PathBuf {
        self.runtime_path.clone()
    }

    pub async fn read(&self) -> OpenBitFunResult<ModelPoolDocument> {
        let document: ModelPoolDocument = self.service.get_config(Some("ai.model_pools")).await?;
        if document.version != 1 {
            return Err(OpenBitFunError::config(format!(
                "Unsupported model pool document version: {}",
                document.version
            )));
        }
        Ok(document)
    }

    pub async fn get(&self, id: &str) -> OpenBitFunResult<ModelPoolDefinition> {
        self.read()
            .await?
            .get(id)
            .map_err(OpenBitFunError::validation)
    }

    /// An empty draft ID creates a pool with a host-generated ID. A non-empty
    /// ID edits an existing pool; it must never recreate a deleted record.
    pub async fn save(&self, pool: ModelPoolDefinition) -> OpenBitFunResult<ModelPoolDocument> {
        self.save_with_id_generator(pool, generate_pool_id).await
    }

    async fn save_with_id_generator(
        &self,
        mut pool: ModelPoolDefinition,
        mut next_id: impl FnMut() -> String,
    ) -> OpenBitFunResult<ModelPoolDocument> {
        let creating = pool.id.is_empty();
        self.service
            .update_config::<AIConfig, _>("ai", |ai| {
                let ids: HashSet<_> = ai.models.iter().map(|model| model.id.as_str()).collect();
                let document = &mut ai.model_pools;
                Self::check_version(document)?;
                if creating {
                    // Allocation and insertion share the main configuration
                    // write lock, including creates from different controllers.
                    loop {
                        pool.id = next_id();
                        if !document.pools.iter().any(|value| {
                            value.get("id").and_then(serde_json::Value::as_str) == Some(&pool.id)
                        }) {
                            break;
                        }
                    }
                }
                pool.validate().map_err(OpenBitFunError::validation)?;
                let indices: Vec<_> = document
                    .pools
                    .iter()
                    .enumerate()
                    .filter(|(_, value)| {
                        value.get("id").and_then(serde_json::Value::as_str) == Some(&pool.id)
                    })
                    .map(|(index, _)| index)
                    .collect();
                if indices.len() > 1 {
                    return Err(OpenBitFunError::validation("Duplicate model pool ID"));
                }
                if !creating && indices.is_empty() {
                    return Err(OpenBitFunError::NotFound(format!(
                        "Model pool no longer exists: {}",
                        pool.id
                    )));
                }
                let old: Option<ModelPoolDefinition> = indices
                    .first()
                    .and_then(|i| serde_json::from_value(document.pools[*i].clone()).ok());
                for id in &pool.member_model_ids {
                    if !ids.contains(id.as_str())
                        && !old
                            .as_ref()
                            .is_some_and(|old| old.member_model_ids.contains(id))
                    {
                        return Err(OpenBitFunError::validation(format!(
                            "Unknown model pool member: {id}"
                        )));
                    }
                }
                if let Some(old) = old {
                    for (key, value) in old.extensions {
                        pool.extensions.entry(key).or_insert(value);
                    }
                }
                let value = serde_json::to_value(pool)?;
                if let Some(index) = indices.first() {
                    document.pools[*index] = value;
                } else {
                    document.pools.push(value);
                }
                Ok(document.clone())
            })
            .await
    }

    pub async fn delete(&self, id: &str) -> OpenBitFunResult<ModelPoolDocument> {
        self.service
            .update_config::<ModelPoolDocument, _>("ai.model_pools", |document| {
                Self::check_version(document)?;
                document.pools.retain(|value| {
                    value.get("id").and_then(serde_json::Value::as_str) != Some(id)
                });
                Ok(document.clone())
            })
            .await
    }

    fn check_version(document: &ModelPoolDocument) -> OpenBitFunResult<()> {
        if document.version != 1 {
            return Err(OpenBitFunError::validation(
                "Unsupported model pool version",
            ));
        }
        Ok(())
    }
}
