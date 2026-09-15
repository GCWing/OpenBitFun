//! Configuration service implementation
//!
//! Provides comprehensive configuration management functionality.

use super::manager::{
    validate_current_config_value, validate_openbitfun_product_identity, ConfigManager,
    ConfigManagerSettings, ConfigStatistics,
};
use super::types::*;
use crate::util::errors::*;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::{watch, RwLock};

/// Configuration service.
pub struct ConfigService {
    manager: Arc<RwLock<ConfigManager>>,
    runtime_ai_models: Arc<RwLock<BTreeMap<String, AIModelConfig>>>,
    local_changes: watch::Sender<()>,
}

/// Configuration import/export format.
#[derive(Debug, Clone, Serialize)]
pub struct ConfigExport {
    pub product_id: String,
    pub format_version: u32,
    pub config: GlobalConfig,
    pub export_timestamp: String,
    pub version: String,
}

pub const CURRENT_CONFIG_EXPORT_FORMAT_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigExportWire {
    product_id: String,
    format_version: u32,
    config: serde_json::Value,
    export_timestamp: String,
    version: String,
}

impl<'de> Deserialize<'de> for ConfigExport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ConfigExportWire::deserialize(deserializer)?;
        validate_current_config_value(&wire.config, "Configuration export payload")
            .map_err(serde::de::Error::custom)?;
        let config = serde_json::from_value(wire.config).map_err(serde::de::Error::custom)?;
        let export = Self {
            product_id: wire.product_id,
            format_version: wire.format_version,
            config,
            export_timestamp: wire.export_timestamp,
            version: wire.version,
        };
        validate_config_export(&export).map_err(serde::de::Error::custom)?;
        Ok(export)
    }
}

fn validate_config_export(export: &ConfigExport) -> OpenBitFunResult<()> {
    validate_openbitfun_product_identity(&export.product_id, "Configuration export")?;
    if export.format_version != CURRENT_CONFIG_EXPORT_FORMAT_VERSION {
        return Err(OpenBitFunError::validation(format!(
            "Configuration export format_version must be {CURRENT_CONFIG_EXPORT_FORMAT_VERSION}, found {}",
            export.format_version
        )));
    }
    validate_current_config_value(
        &serde_json::to_value(&export.config)?,
        "Configuration export payload",
    )
}

/// Configuration import result.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigImportResult {
    pub success: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Configuration health status.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigHealthStatus {
    pub healthy: bool,
    pub total_providers: usize,
    pub config_directory: std::path::PathBuf,
    pub warnings: Vec<String>,
    pub message: String,
    pub last_modified: chrono::DateTime<chrono::Utc>,
}

impl ConfigService {
    /// Creates a new configuration service.
    pub async fn new() -> OpenBitFunResult<Self> {
        let settings = ConfigManagerSettings::default();
        Self::with_settings(settings).await
    }

    /// Creates a configuration service with custom settings.
    pub async fn with_settings(settings: ConfigManagerSettings) -> OpenBitFunResult<Self> {
        let manager = ConfigManager::new(settings).await?;

        Ok(Self {
            manager: Arc::new(RwLock::new(manager)),
            runtime_ai_models: Arc::new(RwLock::new(BTreeMap::new())),
            local_changes: watch::channel(()).0,
        })
    }

    /// Gets a configuration value (supports dot-paths).
    pub async fn get_config<T>(&self, path: Option<&str>) -> OpenBitFunResult<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let manager = self.manager.read().await;

        if let Some(path) = path {
            manager.get(path)
        } else {
            let config = manager.get_config();
            serde_json::from_value(serde_json::to_value(config)?)
                .map_err(|e| OpenBitFunError::config(format!("Failed to serialize config: {}", e)))
        }
    }

    pub async fn install_runtime_ai_model(&self, model: AIModelConfig) -> OpenBitFunResult<()> {
        if model.id.trim().is_empty() {
            return Err(OpenBitFunError::validation(
                "Runtime model id is required".to_string(),
            ));
        }
        self.runtime_ai_models
            .write()
            .await
            .insert(model.id.clone(), model);
        Ok(())
    }

    pub async fn get_runtime_ai_model(&self, model_id: &str) -> Option<AIModelConfig> {
        self.runtime_ai_models.read().await.get(model_id).cloned()
    }

    pub async fn get_effective_ai_config(&self) -> OpenBitFunResult<AIConfig> {
        let mut ai: AIConfig = self.get_config(Some("ai")).await?;
        for runtime_model in self.runtime_ai_models.read().await.values() {
            if let Some(model) = ai
                .models
                .iter_mut()
                .find(|model| model.id == runtime_model.id)
            {
                *model = runtime_model.clone();
            } else {
                ai.models.push(runtime_model.clone());
            }
        }
        Ok(ai)
    }

    pub async fn remove_runtime_ai_model(&self, model_id: &str) {
        self.runtime_ai_models.write().await.remove(model_id);
    }

    /// Subscribe to successful persisted user mutations. Account sync consumes
    /// this signal so individual UI/CLI mutation adapters cannot forget to mark
    /// settings dirty. Cloud applies and reloads do not echo back as local edits.
    pub fn subscribe_local_changes(&self) -> watch::Receiver<()> {
        self.local_changes.subscribe()
    }

    /// Sets a configuration value (supports dot-paths).
    ///
    /// When the path touches AI models / default model slots / agent-model
    /// mappings, runs [`Self::reconcile_models`] afterwards so the config can
    /// never end up referencing a disabled or deleted model.
    pub async fn set_config<T>(&self, path: &str, value: T) -> OpenBitFunResult<()>
    where
        T: serde::Serialize,
    {
        {
            let mut manager = self.manager.write().await;
            manager.set(path, value).await?;
        }
        self.after_config_change(path).await;
        Ok(())
    }

    /// Reads, modifies, validates, and persists a section under one write lock.
    /// Use this for mutations of lists/maps or partial changes to a settings
    /// object; taking a snapshot with get_config before set_config can discard
    /// a concurrent save. The closure must not perform IO or await other work.
    pub async fn update_config<T, R>(
        &self,
        path: &str,
        update: impl FnOnce(&mut T) -> OpenBitFunResult<R>,
    ) -> OpenBitFunResult<R>
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let (result, changed) = {
            let mut manager = self.manager.write().await;
            let before: serde_json::Value = manager.get(path)?;
            let mut value: T = serde_json::from_value(before.clone())?;
            let result = update(&mut value)?;
            let after = serde_json::to_value(value)?;
            let changed = before != after;
            if changed {
                manager.set(path, after).await?;
            }
            (result, changed)
        };
        if changed {
            self.after_config_change(path).await;
        }
        Ok(result)
    }

    async fn after_config_change(&self, path: &str) {
        let model_configuration_changed = Self::path_touches_models(path);
        if model_configuration_changed {
            if let Err(e) = self.reconcile_models("set_config").await {
                warn!(
                    "Model reconcile after set_config failed: path={}, error={}",
                    path, e
                );
            }
            super::global::GlobalConfigManager::broadcast_update(
                super::global::ConfigUpdateEvent::ModelConfigurationUpdated,
            )
            .await;
        }
        #[cfg(feature = "web-tools")]
        if Self::path_touches_web_search(path) {
            self.refresh_web_search_runtime().await;
        }
        self.local_changes.send_replace(());
    }

    #[cfg(feature = "web-tools")]
    async fn refresh_web_search_runtime(&self) {
        match self.get_config::<AIConfig>(Some("ai")).await {
            Ok(ai_config) => {
                crate::service::web_search::refresh_global_web_search_runtime(&ai_config).await;
            }
            Err(error) => {
                warn!("Failed to refresh WebSearch runtime from config: {error}");
            }
        }
    }

    /// Atomically replaces one JSON configuration value when its current value
    /// still matches the caller's snapshot. The read, comparison, and persisted
    /// write share the existing manager write lock.
    #[cfg(any(test, feature = "mcp-runtime"))]
    pub(crate) async fn compare_and_set_json_config(
        &self,
        path: &str,
        expected: Option<serde_json::Value>,
        replacement: serde_json::Value,
    ) -> OpenBitFunResult<bool> {
        let mut manager = self.manager.write().await;
        let current = match manager.get::<serde_json::Value>(path) {
            Ok(value) => Some(value),
            Err(OpenBitFunError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };
        if current != expected {
            return Ok(false);
        }
        manager.set(path, replacement).await?;
        self.local_changes.send_replace(());
        Ok(true)
    }

    fn path_touches_models(path: &str) -> bool {
        path.is_empty()
            || path == "ai"
            || path.starts_with("ai.models")
            || path.starts_with("ai.default_models")
            || path.starts_with("ai.agent_model_defaults")
            || path.starts_with("ai.task_models")
    }

    #[cfg(feature = "web-tools")]
    fn path_touches_web_search(path: &str) -> bool {
        path.is_empty() || path == "ai" || path.starts_with("ai.web_search")
    }

    /// Resets configuration.
    ///
    /// When the reset target touches AI models (or is a global reset),
    /// triggers [`Self::reconcile_models`] so default-slot / agent-model
    /// references can never linger pointing at a now-missing model.
    pub async fn reset_config(&self, path: Option<&str>) -> OpenBitFunResult<()> {
        {
            let mut manager = self.manager.write().await;
            manager.reset(path).await?;
        }

        let needs_reconcile = match path {
            None => true,
            Some(p) => Self::path_touches_models(p),
        };
        if needs_reconcile {
            if let Err(e) = self.reconcile_models("reset_config").await {
                warn!(
                    "Model reconcile after reset_config failed: path={:?}, error={}",
                    path, e
                );
            }
            super::global::GlobalConfigManager::broadcast_update(
                super::global::ConfigUpdateEvent::ModelConfigurationUpdated,
            )
            .await;
        }

        #[cfg(feature = "web-tools")]
        if path.is_none_or(Self::path_touches_web_search) {
            self.refresh_web_search_runtime().await;
        }

        self.local_changes.send_replace(());

        Ok(())
    }

    /// Validates configuration.
    pub async fn validate_config(&self) -> OpenBitFunResult<ConfigValidationResult> {
        let manager = self.manager.read().await;
        let mut result = manager.validate_config().await?;
        result
            .diagnostics
            .extend(manager.load_diagnostics().iter().cloned());
        Ok(result)
    }

    pub async fn load_diagnostics(&self) -> Vec<ConfigDiagnostic> {
        self.manager.read().await.load_diagnostics().to_vec()
    }

    /// Exports configuration.
    pub async fn export_config(&self) -> OpenBitFunResult<ConfigExport> {
        let manager = self.manager.read().await;
        let config_value = manager.export_config()?;
        let config: GlobalConfig = serde_json::from_value(config_value)?;

        Ok(ConfigExport {
            product_id: openbitfun_core_types::product_identity::product_id().to_string(),
            format_version: CURRENT_CONFIG_EXPORT_FORMAT_VERSION,
            config,
            export_timestamp: chrono::Utc::now().to_rfc3339(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    /// Imports a complete current-format OpenBitFun configuration export.
    pub async fn import_config(
        &self,
        export: ConfigExport,
    ) -> OpenBitFunResult<ConfigImportResult> {
        if let Err(error) = validate_config_export(&export) {
            return Ok(ConfigImportResult {
                success: false,
                errors: vec![error.to_string()],
                warnings: Vec::new(),
            });
        }
        let config_data = serde_json::to_value(export.config)?;
        let import_result = {
            let mut manager = self.manager.write().await;
            manager.import_config(config_data).await
        };

        match import_result {
            Ok(_) => {
                super::global::GlobalConfigManager::broadcast_update(
                    super::global::ConfigUpdateEvent::ModelConfigurationUpdated,
                )
                .await;
                #[cfg(feature = "web-tools")]
                self.refresh_web_search_runtime().await;
                self.local_changes.send_replace(());
                Ok(ConfigImportResult {
                    success: true,
                    errors: Vec::new(),
                    warnings: Vec::new(),
                })
            }
            Err(e) => Ok(ConfigImportResult {
                success: false,
                errors: vec![e.to_string()],
                warnings: Vec::new(),
            }),
        }
    }

    /// Returns configuration statistics.
    pub async fn get_statistics(&self) -> ConfigStatistics {
        let manager = self.manager.read().await;
        manager.get_statistics()
    }

    /// Runs a health check.
    pub async fn health_check(&self) -> OpenBitFunResult<ConfigHealthStatus> {
        let manager = self.manager.read().await;
        let stats = manager.get_statistics();
        let validation_result = manager.validate_config().await?;

        let mut warnings = Vec::new();

        for warning in &validation_result.warnings {
            warnings.push(format!("{}: {}", warning.path, warning.message));
        }

        if stats.total_ai_models == 0 {
            warnings.push("No AI models configured".to_string());
        }

        let config = manager.get_config();
        if config.ai.default_models.primary.is_none() {
            warnings.push("Primary model not configured".to_string());
        }

        if !stats.config_directory.exists() {
            return Ok(ConfigHealthStatus {
                healthy: false,
                total_providers: stats.providers_count,
                config_directory: stats.config_directory,
                warnings,
                message: "Configuration directory does not exist".to_string(),
                last_modified: stats.last_modified,
            });
        }

        let healthy = validation_result.valid && stats.total_ai_models > 0;

        Ok(ConfigHealthStatus {
            healthy,
            total_providers: stats.providers_count,
            config_directory: stats.config_directory,
            warnings,
            message: if healthy {
                "Configuration system is healthy".to_string()
            } else {
                "Configuration system has issues".to_string()
            },
            last_modified: stats.last_modified,
        })
    }

    /// Reloads configuration.
    pub async fn reload(&self) -> OpenBitFunResult<()> {
        {
            let mut manager = self.manager.write().await;
            manager.reload().await?;
        }

        info!("Configuration reloaded");

        super::global::GlobalConfigManager::broadcast_update(
            super::global::ConfigUpdateEvent::ModelConfigurationUpdated,
        )
        .await;
        #[cfg(feature = "web-tools")]
        self.refresh_web_search_runtime().await;
        Ok(())
    }

    /// Creates a configuration backup.
    pub async fn create_backup(&self) -> OpenBitFunResult<std::path::PathBuf> {
        let manager = self.manager.read().await;
        manager.create_backup().await
    }

    /// Registers a configuration provider.
    pub async fn register_provider(&self, provider: Box<dyn ConfigProvider>) {
        let mut manager = self.manager.write().await;
        manager.register_provider(provider);
    }

    /// Returns all AI model configurations.
    pub async fn get_ai_models(&self) -> OpenBitFunResult<Vec<AIModelConfig>> {
        let config: GlobalConfig = self.get_config(None).await?;
        Ok(config.ai.models)
    }

    /// Adds an AI model configuration.
    pub async fn add_ai_model(&self, model: AIModelConfig) -> OpenBitFunResult<()> {
        self.update_config("ai.models", |models: &mut Vec<AIModelConfig>| {
            models.push(model);
            Ok(())
        })
        .await
    }

    /// Updates an AI model configuration.
    pub async fn update_ai_model(
        &self,
        model_id: &str,
        model: AIModelConfig,
    ) -> OpenBitFunResult<()> {
        self.update_config("ai.models", |models: &mut Vec<AIModelConfig>| {
            let existing = models
                .iter_mut()
                .find(|m| m.id == model_id)
                .ok_or_else(|| {
                    OpenBitFunError::config(format!("AI model '{}' not found", model_id))
                })?;
            *existing = model;
            Ok(())
        })
        .await
    }

    /// Deletes an AI model configuration.
    pub async fn delete_ai_model(&self, model_id: &str) -> OpenBitFunResult<()> {
        self.update_config("ai.models", |models: &mut Vec<AIModelConfig>| {
            let original_len = models.len();
            models.retain(|m| m.id != model_id);
            if models.len() == original_len {
                return Err(OpenBitFunError::config(format!(
                    "AI model '{}' not found",
                    model_id
                )));
            }
            Ok(())
        })
        .await
    }

    /// Atomically upserts a pure speech-recognition model, selects it as the
    /// speech default, and switches voice input to the cloud provider.
    pub async fn save_cloud_speech_config(
        &self,
        request: SaveCloudSpeechConfigRequest,
    ) -> OpenBitFunResult<SaveCloudSpeechConfigResult> {
        let name = request.name.trim();
        let base_url = request.base_url.trim().trim_end_matches('/');
        let model_name = request.model_name.trim();
        let api_key = request.api_key.trim();
        if name.is_empty() || base_url.is_empty() || model_name.is_empty() || api_key.is_empty() {
            return Err(OpenBitFunError::validation(
                "Cloud speech name, base URL, model name, and API key are required".to_string(),
            ));
        }
        if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
            return Err(OpenBitFunError::validation(
                "Cloud speech base URL must use http or https".to_string(),
            ));
        }

        let request_url = request
            .request_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if base_url.ends_with("/audio/transcriptions") {
                    base_url.to_string()
                } else {
                    format!("{base_url}/audio/transcriptions")
                }
            });
        if !request_url.starts_with("http://") && !request_url.starts_with("https://") {
            return Err(OpenBitFunError::validation(
                "Cloud speech request URL must use http or https".to_string(),
            ));
        }

        let mut manager = self.manager.write().await;
        let mut config = manager.get_config().clone();
        let model_id = request
            .config_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("speech_cloud_{}", uuid::Uuid::new_v4().simple()));
        let existing_index = config
            .ai
            .models
            .iter()
            .position(|model| model.id == model_id);
        let created = existing_index.is_none();
        let existing_metadata = existing_index
            .and_then(|index| config.ai.models[index].metadata.clone())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let mut metadata = existing_metadata;
        metadata.insert(
            "speech_provider_preset".to_string(),
            serde_json::Value::String(request.preset.trim().to_string()),
        );
        let model = AIModelConfig {
            id: model_id.clone(),
            name: name.to_string(),
            provider: "openai".to_string(),
            model_name: model_name.to_string(),
            base_url: base_url.to_string(),
            request_url: Some(request_url),
            api_key: api_key.to_string(),
            context_window: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
            enabled: true,
            category: ModelCategory::SpeechRecognition,
            capabilities: vec![ModelCapability::SpeechRecognition],
            recommended_for: vec!["voice_input".to_string()],
            metadata: Some(serde_json::Value::Object(metadata)),
            auth: AuthConfig::ApiKey,
            ..AIModelConfig::default()
        };
        match existing_index {
            Some(index) => config.ai.models[index] = model,
            None => config.ai.models.push(model),
        }
        config.ai.default_models.speech_recognition = Some(model_id.clone());
        config.app.ai_experience.voice_input.provider = "cloud".to_string();
        config.app.ai_experience.voice_input.model_id = model_id.clone();

        // The caller may be updating an existing model id. Reconcile all
        // capability-specific slots before the single persistence operation so
        // replacing a text model with a speech-only model cannot leave primary,
        // fast, or agent references pointing at a non-text runtime target.
        super::normalization::reconcile_model_references(&mut config);
        manager.set("", &config).await?;
        drop(manager);

        super::global::GlobalConfigManager::broadcast_update(
            super::global::ConfigUpdateEvent::ModelConfigurationUpdated,
        )
        .await;

        self.local_changes.send_replace(());
        Ok(SaveCloudSpeechConfigResult { model_id, created })
    }

    /// Bring `ai.default_models`, `ai.agent_model_defaults`, and
    /// `ai.task_models` back into a consistent state with `ai.models`.
    ///
    /// This is the single integrity guard the rest of the system relies on:
    /// - invalid task-model selectors are reset to their defaults;
    /// - `default_models.primary` / `.fast` are repointed to the first enabled
    ///   model when their current target is missing or disabled (or cleared
    ///   when no enabled model exists at all);
    /// - optional capability slots such as `default_models.image_understanding`
    ///   are kept pointed at an enabled model with the matching capability, or
    ///   cleared when no matching model is available;
    /// - on every change, a [`ConfigUpdateEvent::ModelsReconciled`] is
    ///   broadcast so [`SessionManager`](crate::agentic::session::SessionManager)
    ///   and the AI client cache can react in lockstep.
    ///
    /// `caller` is logged for diagnostics (e.g. `set_config`, `update_ai_model`).
    pub async fn reconcile_models(&self, caller: &str) -> OpenBitFunResult<ReconcileModelsReport> {
        let reconciliation = {
            // Reconciliation writes a full config snapshot. Keep its read and
            // write under one lock so unrelated saves (such as voice keys)
            // cannot be overwritten by the snapshot we read earlier.
            let mut manager = self.manager.write().await;
            let mut config = manager.get_config().clone();
            let reconciliation = super::normalization::reconcile_model_references(&mut config);
            if !reconciliation.is_noop() {
                manager.set("", &config).await?;
            }
            reconciliation
        };

        let report = ReconcileModelsReport {
            invalidated_model_ids: reconciliation.invalidated_model_ids,
            default_models_changed: reconciliation.default_models_changed,
            task_models_changed: reconciliation.task_models_changed,
            agent_model_defaults_changed: reconciliation.agent_model_defaults_changed,
        };

        if report.is_noop() {
            log::debug!("Reconcile ({caller}): no changes");
        } else {
            info!(
                "Reconcile ({caller}): invalidated={:?}, default_changed={}, task_models_changed={}, agent_defaults_changed={}",
                report.invalidated_model_ids,
                report.default_models_changed,
                report.task_models_changed,
                report.agent_model_defaults_changed
            );
            super::global::GlobalConfigManager::broadcast_update(
                super::global::ConfigUpdateEvent::ModelsReconciled {
                    invalidated_model_ids: report.invalidated_model_ids.clone(),
                    default_models_changed: report.default_models_changed,
                    task_models_changed: report.task_models_changed,
                    agent_model_defaults_changed: report.agent_model_defaults_changed,
                },
            )
            .await;
        }

        Ok(report)
    }
}

#[async_trait::async_trait]
impl openbitfun_runtime_ports::ConfigReadPort for ConfigService {
    async fn get_config_value(
        &self,
        key: &str,
    ) -> openbitfun_runtime_ports::PortResult<Option<serde_json::Value>> {
        self.get_config::<serde_json::Value>(Some(key))
            .await
            .map(Some)
            .map_err(|error| {
                openbitfun_runtime_ports::PortError::new(
                    openbitfun_runtime_ports::PortErrorKind::Backend,
                    error.to_string(),
                )
            })
    }
}

/// Outcome of [`ConfigService::reconcile_models`].
#[derive(Debug, Clone, Default)]
pub struct ReconcileModelsReport {
    pub invalidated_model_ids: Vec<String>,
    pub default_models_changed: bool,
    pub task_models_changed: bool,
    pub agent_model_defaults_changed: bool,
}

impl ReconcileModelsReport {
    pub fn is_noop(&self) -> bool {
        self.invalidated_model_ids.is_empty()
            && !self.default_models_changed
            && !self.task_models_changed
            && !self.agent_model_defaults_changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::PathManager;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn model(id: &str, enabled: bool, category: ModelCategory) -> AIModelConfig {
        let capabilities = if matches!(category, ModelCategory::Multimodal) {
            vec![
                ModelCapability::TextChat,
                ModelCapability::ImageUnderstanding,
            ]
        } else {
            vec![ModelCapability::TextChat]
        };

        AIModelConfig {
            id: id.to_string(),
            name: format!("Provider {id}"),
            provider: "openai".to_string(),
            model_name: id.to_string(),
            base_url: "https://example.com/v1".to_string(),
            enabled,
            category,
            capabilities,
            ..Default::default()
        }
    }

    fn runtime_model(id: &str, key: &str) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: "SDK fixture".to_string(),
            provider: "openai".to_string(),
            model_name: "fixture-model".to_string(),
            base_url: "http://127.0.0.1:43123/v1".to_string(),
            api_key: key.to_string(),
            enabled: true,
            category: ModelCategory::GeneralChat,
            capabilities: vec![ModelCapability::TextChat],
            ..AIModelConfig::default()
        }
    }

    async fn test_service(name: &str) -> (ConfigService, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let user_root = dir.path().join(name);
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));

        let service = ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(path_manager),
            auto_save: true,
            backup_count: 0,
        })
        .await
        .expect("config service");

        (service, dir)
    }

    fn realtime_voice_fixture() -> VoiceCallConfig {
        VoiceCallConfig {
            api_key: "fixture-realtime-voice-key".to_string(),
            voice: "fixture-voice".to_string(),
            speed: 12,
            loudness: -8,
            microphone_device_id: "fixture-controller-microphone".to_string(),
            ..Default::default()
        }
    }

    async fn restart_test_service(dir: &tempfile::TempDir, name: &str) -> ConfigService {
        ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                dir.path().join(name),
            ))),
            auto_save: true,
            backup_count: 0,
        })
        .await
        .expect("restart config service")
    }

    fn current_export(config: GlobalConfig) -> ConfigExport {
        ConfigExport {
            product_id: openbitfun_core_types::product_identity::product_id().to_string(),
            format_version: CURRENT_CONFIG_EXPORT_FORMAT_VERSION,
            config,
            export_timestamp: "2026-09-04T00:00:00Z".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    async fn race_config_operations<A: std::future::Future, B: std::future::Future>(
        service: &ConfigService,
        first: A,
        second: B,
    ) -> (A::Output, B::Output) {
        use std::future::poll_fn;
        use std::task::Poll;

        let manager = service.manager.write().await;
        let mut first = std::pin::pin!(first);
        let mut second = std::pin::pin!(second);
        poll_fn(|cx| {
            assert!(first.as_mut().poll(cx).is_pending());
            assert!(second.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(manager);
        tokio::join!(first, second)
    }

    #[tokio::test]
    async fn concurrent_model_additions_keep_both_credentials_after_restart() {
        let name = "concurrent-model-additions";
        let (service, dir) = test_service(name).await;
        let (first, second) = race_config_operations(
            &service,
            service.add_ai_model(runtime_model("first", "first-fixture-key")),
            service.add_ai_model(runtime_model("second", "second-fixture-key")),
        )
        .await;
        first.unwrap();
        second.unwrap();

        let restarted = restart_test_service(&dir, name).await;
        let models = restarted.get_ai_models().await.unwrap();
        assert_eq!(models.len(), 2);
        assert!(models
            .iter()
            .any(|m| m.id == "first" && m.api_key == "first-fixture-key"));
        assert!(models
            .iter()
            .any(|m| m.id == "second" && m.api_key == "second-fixture-key"));
    }

    #[tokio::test]
    async fn concurrent_model_delete_and_update_do_not_resurrect_deleted_credentials() {
        let name = "concurrent-model-delete-update";
        let (service, dir) = test_service(name).await;
        service
            .add_ai_model(runtime_model("keep", "old-fixture-key"))
            .await
            .unwrap();
        service
            .add_ai_model(runtime_model("remove", "deleted-fixture-key"))
            .await
            .unwrap();
        let (deleted, updated) = race_config_operations(
            &service,
            service.delete_ai_model("remove"),
            service.update_ai_model("keep", runtime_model("keep", "new-fixture-key")),
        )
        .await;
        deleted.unwrap();
        updated.unwrap();

        let restarted = restart_test_service(&dir, name).await;
        let models = restarted.get_ai_models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "keep");
        assert_eq!(models[0].api_key, "new-fixture-key");
    }

    #[tokio::test]
    async fn failed_config_writes_cannot_leak_into_a_later_successful_save() {
        for reset in [false, true] {
            let name = "failed-config-write";
            let (service, dir) = test_service(name).await;
            service
                .set_config("app.voice_call", realtime_voice_fixture())
                .await
                .unwrap();
            service
                .add_ai_model(runtime_model("keep", "fixture-model-key"))
                .await
                .unwrap();
            let before: serde_json::Value = service.get_config(None).await.unwrap();
            let changes = service.subscribe_local_changes();
            let config_file = dir.path().join(name).join("config/app.json");
            let preserved = config_file.with_extension("preserved.json");
            tokio::fs::rename(&config_file, &preserved).await.unwrap();
            // Replacing a directory with a file fails on every supported OS,
            // without relying on permissions (which root can bypass in CI).
            tokio::fs::create_dir(&config_file).await.unwrap();

            let result = if reset {
                service.reset_config(None).await
            } else {
                service
                    .set_config("app.voice_call.api_key", "unsaved-fixture-key")
                    .await
            };
            assert!(result.is_err());
            assert!(
                !changes.has_changed().unwrap(),
                "Failed writes must not trigger account uploads"
            );
            let after: serde_json::Value = service.get_config(None).await.unwrap();
            assert_eq!(after, before, "A failed write changed the in-memory config");

            tokio::fs::remove_dir(&config_file).await.unwrap();
            tokio::fs::rename(&preserved, &config_file).await.unwrap();
            service.set_config("editor.font_size", 18).await.unwrap();
            let restarted = restart_test_service(&dir, name).await;
            let saved: GlobalConfig = restarted.get_config(None).await.unwrap();
            assert_eq!(
                saved.app.voice_call.api_key,
                realtime_voice_fixture().api_key
            );
            assert_eq!(saved.ai.models[0].api_key, "fixture-model-key");
            assert_eq!(saved.editor.font_size, 18);
        }
    }

    #[tokio::test]
    async fn explicit_backups_are_distinct_even_when_requested_together() {
        let (service, _dir) = test_service("concurrent-backups").await;
        service
            .add_ai_model(runtime_model("keep", "fixture-model-key"))
            .await
            .unwrap();
        let (first, second, third) = tokio::join!(
            service.create_backup(),
            service.create_backup(),
            service.create_backup(),
        );
        let backups = [first.unwrap(), second.unwrap(), third.unwrap()];
        assert_eq!(
            backups
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        for backup in backups {
            let saved: GlobalConfig =
                serde_json::from_slice(&tokio::fs::read(backup).await.unwrap()).unwrap();
            assert_eq!(saved.ai.models[0].api_key, "fixture-model-key");
        }
    }

    #[tokio::test]
    async fn imports_still_honor_explicit_deletions_and_default_elision_in_backups() {
        for typed_export in [false, true] {
            let (service, _dir) = test_service("import-explicit-deletions").await;
            // A raw backup intentionally omits these default values. Restoring
            // it must still reset them to the declared defaults.
            let backup = service.create_backup().await.unwrap();
            let raw_backup: serde_json::Value =
                serde_json::from_slice(&tokio::fs::read(backup).await.unwrap()).unwrap();
            let mut local = GlobalConfig::default();
            local.mcp_servers =
                Some(serde_json::json!({"mcpServers": {"fixture": {"command": "fixture"}}}));
            local.acp_clients =
                Some(serde_json::json!({"acpClients": {"fixture": {"command": "fixture"}}}));
            local.app.keybindings = Some(serde_json::json!({"version": 1, "overrides": {}}));
            local.plugin = vec![PluginDeclarationConfig::Spec("fixture-plugin".to_string())];
            local
                .ai
                .agent_profiles
                .insert("fixture-profile".to_string(), AgentProfileConfig::default());
            local.ai.agent_model_defaults.subagents.builtin.insert(
                "fixture-override".to_string(),
                SubagentModelSelection::Inherit,
            );
            local.memories.use_memories = true;
            local.ai.allow_tool_json_repair = false;
            local.ai.max_rounds = 42;
            local.app.notifications.enabled = false;
            service.set_config("", &local).await.unwrap();

            let mut incoming = if typed_export {
                serde_json::to_value(GlobalConfig::default()).unwrap()
            } else {
                raw_backup
            };
            incoming["ai"]["review_teams"] = serde_json::json!({});
            incoming["ai"]["agent_model_defaults"]["subagents"]["builtin"] = serde_json::json!({});
            incoming["workspace"]["exclude_patterns"] = serde_json::json!([]);
            let export = current_export(serde_json::from_value(incoming).unwrap());
            let result = service.import_config(export).await.unwrap();
            assert!(result.success, "{:?}", result.errors);
            let saved: GlobalConfig = service.get_config(None).await.unwrap();
            assert!(saved.mcp_servers.is_none());
            assert!(saved.acp_clients.is_none());
            assert!(saved.app.keybindings.is_none());
            assert!(saved.plugin.is_empty());
            assert!(saved.ai.agent_profiles.is_empty());
            assert!(saved.ai.review_teams.is_empty());
            assert!(!saved
                .ai
                .agent_model_defaults
                .subagents
                .builtin
                .contains_key("fixture-override"));
            assert!(!saved
                .ai
                .agent_model_defaults
                .subagents
                .builtin
                .contains_key("GeneralPurpose"));
            assert!(saved.workspace.exclude_patterns.is_empty());
            assert!(!saved.memories.use_memories);
            assert!(saved.ai.allow_tool_json_repair);
            assert_eq!(saved.ai.max_rounds, GlobalConfig::default().ai.max_rounds);
            assert!(saved.app.notifications.enabled);
        }
    }

    #[tokio::test]
    async fn config_export_round_trip_covers_persisted_preference_groups() {
        use serde_json::json;

        let (source, _source_dir) = test_service("sync-coverage-source").await;
        let (target, target_dir) = test_service("sync-coverage-target").await;
        let mut changes = source.subscribe_local_changes();
        let fixtures = vec![
            ("app.language", json!("en-US")),
            ("app.prevent_sleep", json!(true)),
            ("app.notifications.enabled", json!(false)),
            ("app.logging.include_sensitive_diagnostics", json!(true)),
            ("app.sidebar.width", json!(280)),
            ("app.right_panel.width", json!(420)),
            ("app.flow_chat.show_permission_mode_control", json!(false)),
            ("app.hooks.project_hooks_enabled", json!(true)),
            (
                "app.keybindings",
                json!({"version": 1, "overrides": {"session.new": {"key": "n", "alt": true}}}),
            ),
            (
                "app.user_tool_groups",
                json!({"version": 1, "groups": [{"id": "tools", "name": "Tools", "toolNames": ["Read"]}]}),
            ),
            (
                "app.user_skill_groups",
                json!({"version": 1, "groups": [{"id": "skills", "name": "Skills", "skillKeys": ["user::fixture"]}]}),
            ),
            (
                "app.ai_experience.quick_actions",
                json!([{"id": "fixture", "label": "Fixture", "prompt": "Check changes", "enabled": false}]),
            ),
            (
                "app.voice_call",
                serde_json::to_value(realtime_voice_fixture()).unwrap(),
            ),
            ("editor.font_size", json!(18)),
            ("editor.format_on_save", json!(true)),
            ("terminal.font_size", json!(17)),
            ("terminal.terminal_panel_position", json!("bottom")),
            ("workspace.exclude_patterns", json!(["**/fixture-cache/**"])),
            (
                "ai.models",
                serde_json::to_value(vec![runtime_model("fixture-model", "fixture-model-key")])
                    .unwrap(),
            ),
            ("ai.default_models.primary", json!("fixture-model")),
            (
                "ai.agent_profiles",
                json!({"fixture-profile": {"profile_id": "fixture-profile", "added_tools": ["Read"], "disabled_user_skills": ["user::fixture"]}}),
            ),
            (
                "ai.skill_settings.globally_disabled_user_skills",
                json!(["user::fixture"]),
            ),
            ("ai.subagent_max_concurrency", json!(3)),
            ("ai.stream_idle_timeout_secs", json!(123)),
            ("ai.web_search.provider", json!("tavily")),
            ("ai.allow_tool_json_repair", json!(false)),
            ("ai.enable_context_compression_prefetch", json!(false)),
            ("tool_permissions.interaction.auto_approve_ask", json!(true)),
            ("memories.use_memories", json!(true)),
            (
                "mcp_servers",
                json!({"mcpServers": {"fixture": {"command": "fixture", "env": {"TOKEN": "fixture-mcp-key"}}}}),
            ),
            (
                "acp_clients",
                json!({"acpClients": {"fixture": {"command": "fixture"}}}),
            ),
            (
                "plugin",
                json!([{"spec": "fixture-package@1.0.0", "options": {"enabled": true}}]),
            ),
            ("appearance.selection", json!("fixture-appearance")),
            (
                "font",
                json!({"uiSize": {"level": "custom", "customPx": 17}}),
            ),
        ];
        for (path, value) in &fixtures {
            source.set_config(path, value).await.unwrap();
            assert!(
                changes.has_changed().unwrap(),
                "Missing configuration change signal: {path}"
            );
            changes.borrow_and_update();
        }
        // Use the serialized wire payload, not a typed in-memory shortcut.
        let payload = serde_json::to_string(&source.export_config().await.unwrap()).unwrap();
        let target_changes = target.subscribe_local_changes();
        let result = target
            .import_config(serde_json::from_str(&payload).unwrap())
            .await
            .unwrap();
        assert!(result.success, "{:?}", result.errors);
        assert!(
            target_changes.has_changed().unwrap(),
            "Explicit import must notify local changes"
        );
        drop(target);
        let restarted = restart_test_service(&target_dir, "sync-coverage-target").await;
        for (path, expected) in fixtures {
            let actual: serde_json::Value = restarted.get_config(Some(path)).await.unwrap();
            // Agent profile defaults are materialized by serde; compare their
            // complete source representation just like all other sections.
            let source_value: serde_json::Value = source.get_config(Some(path)).await.unwrap();
            assert_eq!(
                actual, source_value,
                "Settings lost in export/import/restart: {path}"
            );
            if path != "ai.agent_profiles" && path != "ai.models" {
                assert_eq!(
                    actual, expected,
                    "Setting was dropped before export: {path}"
                );
            }
        }
        let mut source_config =
            serde_json::to_value(source.export_config().await.unwrap().config).unwrap();
        let mut target_config =
            serde_json::to_value(restarted.export_config().await.unwrap().config).unwrap();
        source_config
            .as_object_mut()
            .unwrap()
            .remove("last_modified");
        target_config
            .as_object_mut()
            .unwrap()
            .remove("last_modified");
        assert_eq!(
            source_config, target_config,
            "Full settings document must round-trip"
        );
    }

    #[tokio::test]
    async fn wrong_product_export_is_rejected_without_changing_config() {
        let (service, _dir) = test_service("wrong-product-export").await;
        let voice = realtime_voice_fixture();
        service.set_config("app.voice_call", &voice).await.unwrap();
        let before: serde_json::Value = service.get_config(None).await.unwrap();

        let mut export = current_export(GlobalConfig::default());
        export.product_id = "another-product".to_string();
        let imported = service.import_config(export).await.unwrap();
        assert!(!imported.success);
        assert!(imported.errors[0].contains("product_id"));

        let after: serde_json::Value = service.get_config(None).await.unwrap();
        assert_eq!(after, before);
    }

    #[tokio::test]
    async fn realtime_voice_survives_model_reconciliation_racing_a_save() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;

        let name = "realtime-voice-reconcile-race";
        let (service, dir) = test_service(name).await;
        let voice = realtime_voice_fixture();
        let mut manager = service.manager.write().await;
        // Model-list writes reconcile in the same manager transaction. Race a
        // subsequent explicit reconciliation with an unrelated credential save
        // to prove even a no-op full snapshot cannot lose that save.
        manager
            .set(
                "ai.models",
                vec![runtime_model("configured-model", "fixture-model-key")],
            )
            .await
            .unwrap();

        let mut reconcile = std::pin::pin!(service.reconcile_models("realtime-voice-test"));
        let mut save = std::pin::pin!(service.set_config("app.voice_call", &voice));
        // Queue reconciliation before the save. Both operations must retain the
        // same manager lock through any persistence they perform.
        poll_fn(|cx| {
            assert!(reconcile.as_mut().poll(cx).is_pending());
            assert!(save.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(manager);
        let (reconciled, saved) = tokio::join!(reconcile, save);
        assert!(reconciled.unwrap().is_noop());
        saved.unwrap();

        let restarted = restart_test_service(&dir, name).await;
        let config: GlobalConfig = restarted.get_config(None).await.unwrap();
        assert_eq!(config.app.voice_call.api_key, voice.api_key);
        assert_eq!(
            config.ai.default_models.primary.as_deref(),
            Some("configured-model")
        );
    }

    #[tokio::test]
    async fn current_export_is_an_authoritative_replacement() {
        let name = "current-account-export";
        let (service, dir) = test_service(name).await;
        service
            .set_config("app.voice_call", realtime_voice_fixture())
            .await
            .unwrap();

        let mut incoming = GlobalConfig::default();
        incoming.ai.models = vec![runtime_model("cloud-model", "fixture-cloud-model-key")];
        let imported = service
            .import_config(current_export(incoming))
            .await
            .unwrap();
        assert!(imported.success, "{:?}", imported.errors);

        drop(service);
        let config: GlobalConfig = restart_test_service(&dir, name)
            .await
            .get_config(None)
            .await
            .unwrap();
        assert!(config.app.voice_call.api_key.is_empty());
        assert_eq!(config.ai.models.len(), 1);
        assert_eq!(config.ai.models[0].id, "cloud-model");
        assert_eq!(config.ai.models[0].api_key, "fixture-cloud-model-key");
    }

    #[tokio::test]
    async fn realtime_voice_import_updates_keys_and_backs_up_the_previous_file() {
        let name = "realtime-voice-account-update";
        let (service, dir) = test_service(name).await;
        service
            .set_config("app.voice_call", realtime_voice_fixture())
            .await
            .unwrap();
        let config_dir = service.get_statistics().await.config_directory;
        let original = tokio::fs::read_to_string(config_dir.join("app.json"))
            .await
            .unwrap();

        let mut incoming = GlobalConfig::default();
        incoming.app.voice_call = VoiceCallConfig {
            api_key: "fixture-updated-voice-key".to_string(),
            voice: "fixture-updated-voice".to_string(),
            ..Default::default()
        };
        let imported = service
            .import_config(current_export(incoming))
            .await
            .unwrap();
        assert!(imported.success, "{:?}", imported.errors);

        let backup = std::fs::read_dir(config_dir.join("backups"))
            .unwrap()
            .map(Result::unwrap)
            .find(|entry| entry.file_name().to_string_lossy().contains("pre-import"))
            .expect("pre-import backup");
        assert_eq!(
            tokio::fs::read_to_string(backup.path()).await.unwrap(),
            original
        );

        drop(service);
        let restarted = restart_test_service(&dir, name).await;
        let voice: VoiceCallConfig = restarted.get_config(Some("app.voice_call")).await.unwrap();
        assert_eq!(voice.api_key, "fixture-updated-voice-key");
        assert_eq!(voice.voice, "fixture-updated-voice");
        assert!(voice.microphone_device_id.is_empty());
    }

    #[tokio::test]
    async fn realtime_voice_export_and_backup_preserve_credentials() {
        let name = "realtime-voice-backup-restore";
        let (service, dir) = test_service(name).await;
        let voice = realtime_voice_fixture();
        service.set_config("app.voice_call", &voice).await.unwrap();
        service
            .add_ai_model(runtime_model("configured-model", "fixture-model-key"))
            .await
            .unwrap();
        let export = service.export_config().await.unwrap();
        let backup = service.create_backup().await.unwrap();
        let backup: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(backup).await.unwrap()).unwrap();
        assert_eq!(export.config.app.voice_call.api_key, voice.api_key);
        assert_eq!(backup["app"]["voice_call"]["api_key"], voice.api_key);

        service.reset_config(Some("app.voice_call")).await.unwrap();
        let restored = service.import_config(export).await.unwrap();
        assert!(restored.success, "{:?}", restored.errors);
        let restored_voice: VoiceCallConfig =
            service.get_config(Some("app.voice_call")).await.unwrap();
        assert_eq!(restored_voice.api_key, voice.api_key);

        drop(service);
        let restarted = restart_test_service(&dir, name).await;
        let config: GlobalConfig = restarted.get_config(None).await.unwrap();
        assert_eq!(config.ai.models[0].api_key, "fixture-model-key");
        assert_eq!(
            serde_json::to_value(config.app.voice_call).unwrap(),
            serde_json::to_value(voice).unwrap()
        );
    }

    #[tokio::test]
    async fn realtime_voice_explicit_import_save_and_reset_can_clear_credentials() {
        let name = "realtime-voice-explicit-clear";
        let (service, dir) = test_service(name).await;
        for operation in ["import", "save", "reset"] {
            service
                .set_config("app.voice_call", realtime_voice_fixture())
                .await
                .unwrap();
            match operation {
                "import" => {
                    let imported = service
                        .import_config(current_export(GlobalConfig::default()))
                        .await
                        .unwrap();
                    assert!(imported.success, "{:?}", imported.errors);
                }
                "save" => {
                    service
                        .set_config(
                            "app.voice_call",
                            VoiceCallConfig {
                                enabled: false,
                                ..Default::default()
                            },
                        )
                        .await
                        .unwrap();
                }
                _ => service.reset_config(Some("app.voice_call")).await.unwrap(),
            }
            let restarted = restart_test_service(&dir, name).await;
            let voice: VoiceCallConfig =
                restarted.get_config(Some("app.voice_call")).await.unwrap();
            assert!(voice.api_key.is_empty(), "operation={operation}");
        }
    }

    #[tokio::test]
    async fn identity_metadata_is_protected_during_normal_mutations() {
        let name = "protected-config-metadata";
        let (service, dir) = test_service(name).await;
        let voice = realtime_voice_fixture();
        service.set_config("app.voice_call", &voice).await.unwrap();
        service
            .add_ai_model(runtime_model("keep", "fixture-model-key"))
            .await
            .unwrap();
        service
            .add_ai_model(runtime_model("remove", "fixture-removed-key"))
            .await
            .unwrap();
        service
            .update_ai_model("keep", runtime_model("keep", "fixture-updated-model-key"))
            .await
            .unwrap();
        service.delete_ai_model("remove").await.unwrap();
        for (path, value) in [
            ("product_id", serde_json::json!("another-product")),
            ("schema_version", serde_json::json!(2)),
            ("version", serde_json::json!("tampered-build")),
            ("last_modified", serde_json::json!(0)),
        ] {
            let error = service.set_config(path, value).await.unwrap_err();
            assert!(error.to_string().contains("managed by OpenBitFun"));
        }

        drop(service);
        let restarted = restart_test_service(&dir, name).await;
        let config: GlobalConfig = restarted.get_config(None).await.unwrap();
        assert_eq!(config.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(config.app.voice_call.api_key, voice.api_key);
        assert_eq!(config.ai.models.len(), 1);
        assert_eq!(config.ai.models[0].id, "keep");
        assert_eq!(config.ai.models[0].api_key, "fixture-updated-model-key");
    }

    #[tokio::test]
    async fn realtime_voice_survives_reload_racing_a_save() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;

        let name = "realtime-voice-reload-race";
        let (service, dir) = test_service(name).await;
        let voice = realtime_voice_fixture();
        let manager = service.manager.write().await;
        let mut reload = std::pin::pin!(service.reload());
        let mut save = std::pin::pin!(service.set_config("app.voice_call", &voice));
        poll_fn(|cx| {
            assert!(reload.as_mut().poll(cx).is_pending());
            assert!(save.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(manager);
        let (reloaded, saved) = tokio::join!(reload, save);
        reloaded.unwrap();
        saved.unwrap();

        let restarted = restart_test_service(&dir, name).await;
        let config: VoiceCallConfig = restarted.get_config(Some("app.voice_call")).await.unwrap();
        assert_eq!(config.api_key, voice.api_key);
        let in_memory: VoiceCallConfig = service.get_config(Some("app.voice_call")).await.unwrap();
        assert_eq!(in_memory.api_key, voice.api_key);
    }

    #[tokio::test]
    async fn realtime_voice_invalid_import_keeps_memory_and_disk_unchanged() {
        let (service, _dir) = test_service("realtime-voice-invalid-import").await;
        service
            .set_config("app.voice_call", realtime_voice_fixture())
            .await
            .unwrap();
        let config_dir = service.get_statistics().await.config_directory;
        let before = tokio::fs::read_to_string(config_dir.join("app.json"))
            .await
            .unwrap();
        let mut invalid = serde_json::to_value(current_export(GlobalConfig::default())).unwrap();
        invalid["config"]["app"]["voice_call"]["api_key"] = serde_json::Value::Null;
        let error = serde_json::from_value::<ConfigExport>(invalid)
            .expect_err("malformed current exports must be rejected before import");
        assert!(error.to_string().contains("expected a string"));
        assert_eq!(
            tokio::fs::read_to_string(config_dir.join("app.json"))
                .await
                .unwrap(),
            before
        );
        let voice: VoiceCallConfig = service.get_config(Some("app.voice_call")).await.unwrap();
        assert_eq!(voice.api_key, realtime_voice_fixture().api_key);
        assert!(!config_dir.join("backups").exists());
    }

    #[tokio::test]
    async fn runtime_ai_model_is_effective_but_never_persisted() {
        let (service, _dir) = test_service("runtime-overlay-test").await;

        service
            .install_runtime_ai_model(runtime_model("sdk:openai:fixture", "fixture-secret"))
            .await
            .unwrap();
        let runtime = service
            .get_runtime_ai_model("sdk:openai:fixture")
            .await
            .unwrap();
        assert_eq!(runtime.api_key, "fixture-secret");
        let effective_ai = service.get_effective_ai_config().await.unwrap();
        assert!(effective_ai
            .models
            .iter()
            .any(|model| model.id == "sdk:openai:fixture"));
        let persisted: GlobalConfig = service.get_config(None).await.unwrap();
        assert!(!persisted
            .ai
            .models
            .iter()
            .any(|model| model.id == "sdk:openai:fixture"));
        let persisted_models: Vec<AIModelConfig> =
            service.get_config(Some("ai.models")).await.unwrap();
        assert!(!persisted_models
            .iter()
            .any(|model| model.id == "sdk:openai:fixture"));
        let persisted_ai: AIConfig = service.get_config(Some("ai")).await.unwrap();
        assert!(!persisted_ai
            .models
            .iter()
            .any(|model| model.id == "sdk:openai:fixture"));

        let export = service.export_config().await.unwrap();
        let export_json = serde_json::to_string(&export).unwrap();
        assert!(!export_json.contains("sdk:openai:fixture"));
        assert!(!export_json.contains("fixture-secret"));

        service
            .reconcile_models("runtime-overlay-test")
            .await
            .unwrap();
        service
            .add_ai_model(model("persisted", true, ModelCategory::GeneralChat))
            .await
            .unwrap();
        let app_file = service
            .get_statistics()
            .await
            .config_directory
            .join("app.json");
        let disk = tokio::fs::read_to_string(app_file).await.unwrap();
        assert!(!disk.contains("sdk:openai:fixture"));
        assert!(!disk.contains("fixture-secret"));

        let backup = service.create_backup().await.unwrap();
        let backup_text = tokio::fs::read_to_string(backup).await.unwrap();
        assert!(!backup_text.contains("sdk:openai:fixture"));
        assert!(!backup_text.contains("fixture-secret"));

        service.remove_runtime_ai_model("sdk:openai:fixture").await;
        let effective = service.get_effective_ai_config().await.unwrap();
        assert!(!effective
            .models
            .iter()
            .any(|model| model.id == "sdk:openai:fixture"));
        assert!(service
            .get_runtime_ai_model("sdk:openai:fixture")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn runtime_ai_model_overlays_a_persisted_duplicate_for_effective_reads() {
        let (service, _dir) = test_service("runtime-overlay-duplicate-test").await;
        service
            .add_ai_model(runtime_model("sdk:openai:duplicate", "persisted-secret"))
            .await
            .unwrap();
        service
            .install_runtime_ai_model(runtime_model("sdk:openai:duplicate", "runtime-secret"))
            .await
            .unwrap();

        let effective = service.get_effective_ai_config().await.unwrap();
        let matches = effective
            .models
            .iter()
            .filter(|model| model.id == "sdk:openai:duplicate")
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].api_key, "runtime-secret");

        let persisted: AIConfig = service.get_config(Some("ai")).await.unwrap();
        let persisted = persisted
            .models
            .iter()
            .find(|model| model.id == "sdk:openai:duplicate")
            .unwrap();
        assert_eq!(persisted.api_key, "persisted-secret");
    }

    #[tokio::test]
    async fn review_team_policy_config_survives_service_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            dir.path().join("review-team-concurrency"),
        ));
        let settings = || ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 0,
        };

        let service = ConfigService::with_settings(settings())
            .await
            .expect("config service should start");
        service
            .set_config(
                "ai.review_teams.default",
                serde_json::json!({
                    "max_retries_per_role": 2,
                    "max_parallel_reviewers": 1,
                    "max_queue_wait_seconds": 45,
                    "allow_provider_capacity_queue": false,
                    "allow_bounded_auto_retry": true,
                    "auto_retry_elapsed_guard_seconds": 240,
                }),
            )
            .await
            .expect("review team concurrency config should save");

        let persisted: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(path_manager.app_config_file())
                .await
                .expect("review team config should be persisted"),
        )
        .expect("persisted config should be valid JSON");
        let persisted_team = &persisted["ai"]["review_teams"]["default"];
        assert_eq!(persisted_team["max_retries_per_role"], serde_json::json!(2));
        assert_eq!(
            persisted_team["max_parallel_reviewers"],
            serde_json::json!(1)
        );
        assert_eq!(
            persisted_team["max_queue_wait_seconds"],
            serde_json::json!(45)
        );
        assert_eq!(
            persisted_team["allow_provider_capacity_queue"],
            serde_json::json!(false)
        );
        assert_eq!(
            persisted_team["allow_bounded_auto_retry"],
            serde_json::json!(true)
        );
        assert_eq!(
            persisted_team["auto_retry_elapsed_guard_seconds"],
            serde_json::json!(240)
        );

        drop(service);
        let reloaded_service = ConfigService::with_settings(settings())
            .await
            .expect("config service should reload");
        let reloaded: serde_json::Value = reloaded_service
            .get_config(Some("ai.review_teams.default"))
            .await
            .expect("review team config should be readable after reload");
        assert_eq!(reloaded["max_retries_per_role"], serde_json::json!(2));
        assert_eq!(reloaded["max_parallel_reviewers"], serde_json::json!(1));
        assert_eq!(reloaded["max_queue_wait_seconds"], serde_json::json!(45));
        assert_eq!(
            reloaded["allow_provider_capacity_queue"],
            serde_json::json!(false)
        );
        assert_eq!(
            reloaded["allow_bounded_auto_retry"],
            serde_json::json!(true)
        );
        assert_eq!(
            reloaded["auto_retry_elapsed_guard_seconds"],
            serde_json::json!(240)
        );
    }

    #[tokio::test]
    async fn compare_and_set_json_config_rejects_a_stale_snapshot() {
        let (service, _dir) = test_service("config-cas").await;
        assert!(service
            .compare_and_set_json_config(
                "mcp_servers",
                None,
                serde_json::json!({ "mcpServers": { "first": {} } }),
            )
            .await
            .unwrap());
        assert!(!service
            .compare_and_set_json_config(
                "mcp_servers",
                None,
                serde_json::json!({ "mcpServers": { "stale": {} } }),
            )
            .await
            .unwrap());
        let current = service
            .get_config::<serde_json::Value>(Some("mcp_servers"))
            .await
            .unwrap();
        assert!(current["mcpServers"].get("first").is_some());
        assert!(current["mcpServers"].get("stale").is_none());
    }

    #[tokio::test]
    async fn startup_rejects_structured_telemetry_without_mutating_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let user_root = dir.path().join("structured-telemetry-compatibility");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));
        path_manager
            .initialize_user_directories()
            .await
            .expect("user directories");

        let mut config = GlobalConfig::default();
        config
            .ai
            .models
            .push(model("configured-model", true, ModelCategory::GeneralChat));
        let mut config_value = serde_json::to_value(config).expect("serialize config");
        config_value["app"]["telemetry"] = serde_json::json!({
            "version": 2,
            "level": "basic",
            "sensitive_content_consent": false,
        });
        let original = serde_json::to_string_pretty(&config_value).expect("format config");
        tokio::fs::write(path_manager.app_config_file(), &original)
            .await
            .expect("seed config");

        let error = match ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 5,
        })
        .await
        {
            Ok(_) => panic!("structured telemetry is not a current OpenBitFun config"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("expected a boolean"), "{error}");
        assert_eq!(
            tokio::fs::read_to_string(path_manager.app_config_file())
                .await
                .expect("original config"),
            original
        );
        assert!(!path_manager.user_config_dir().join("backups").exists());
    }

    #[tokio::test]
    async fn startup_recovers_speech_generation_fields_without_mutating_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let user_root = dir.path().join("speech-startup-repair");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));
        path_manager
            .initialize_user_directories()
            .await
            .expect("user directories");
        let mut config = GlobalConfig::default();
        config.ai.models.push(AIModelConfig {
            id: "speech".to_string(),
            name: "Qwen ASR".to_string(),
            provider: "openai".to_string(),
            model_name: "qwen-asr".to_string(),
            base_url: "https://example.com/v1".to_string(),
            api_key: "secret".to_string(),
            enabled: true,
            category: ModelCategory::SpeechRecognition,
            capabilities: vec![ModelCapability::SpeechRecognition],
            context_window: Some(0),
            max_tokens: Some(0),
            ..Default::default()
        });
        config.ai.default_models.speech_recognition = Some("speech".to_string());
        let original = serde_json::to_string_pretty(&config).expect("serialize config");
        tokio::fs::write(path_manager.app_config_file(), &original)
            .await
            .expect("seed config");

        let service = ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 5,
        })
        .await
        .expect("legacy speech fields should recover");
        let models = service.get_ai_models().await.unwrap();
        assert!(models[0].enabled);
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[0].max_tokens, None);
        assert!(service
            .load_diagnostics()
            .await
            .iter()
            .any(|d| d.path.ends_with("context_window")));
        assert_eq!(
            tokio::fs::read_to_string(path_manager.app_config_file())
                .await
                .expect("original config"),
            original
        );
        assert!(!path_manager.user_config_dir().join("backups").exists());
    }

    #[tokio::test]
    async fn malformed_json_fails_startup_and_preserves_the_original() {
        let dir = tempfile::tempdir().expect("tempdir");
        let user_root = dir.path().join("invalid-json-recovery");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));
        path_manager
            .initialize_user_directories()
            .await
            .expect("user directories");
        let broken = "{\"ai\": {\"models\": [";
        tokio::fs::write(path_manager.app_config_file(), broken)
            .await
            .expect("seed broken config");

        let error = match ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 5,
        })
        .await
        {
            Ok(_) => panic!("malformed JSON must fail startup"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("Failed to parse config file"));

        assert_eq!(
            tokio::fs::read_to_string(path_manager.app_config_file())
                .await
                .expect("original config"),
            broken
        );
        assert!(!path_manager.user_config_dir().join("backups").exists());
    }

    #[tokio::test]
    async fn cloud_speech_save_updates_all_owned_fields_in_one_persisted_config() {
        let test_name = "atomic-cloud-speech";
        let (service, dir) = test_service(test_name).await;
        let result = service
            .save_cloud_speech_config(SaveCloudSpeechConfigRequest {
                config_id: Some("speech-cloud".to_string()),
                preset: "qwen".to_string(),
                name: "Qwen ASR".to_string(),
                base_url: "https://example.com/v1/".to_string(),
                request_url: None,
                model_name: "qwen-asr".to_string(),
                api_key: "secret".to_string(),
            })
            .await
            .expect("speech config should save");
        assert!(result.created);

        let path_manager = PathManager::with_user_root_for_tests(dir.path().join(test_name));
        let persisted: GlobalConfig = serde_json::from_slice(
            &tokio::fs::read(path_manager.app_config_file())
                .await
                .expect("persisted config"),
        )
        .expect("valid persisted config");
        let model = persisted
            .ai
            .models
            .iter()
            .find(|model| model.id == "speech-cloud")
            .expect("speech model");
        assert_eq!(model.context_window, None);
        assert_eq!(model.max_tokens, None);
        assert_eq!(
            model.request_url.as_deref(),
            Some("https://example.com/v1/audio/transcriptions")
        );
        assert_eq!(
            persisted.ai.default_models.speech_recognition.as_deref(),
            Some("speech-cloud")
        );
        assert_eq!(persisted.app.ai_experience.voice_input.provider, "cloud");
        assert_eq!(
            persisted.app.ai_experience.voice_input.model_id,
            "speech-cloud"
        );
    }

    #[tokio::test]
    async fn cloud_speech_save_reconciles_text_references_when_reusing_a_model_id() {
        let (service, _dir) = test_service("cloud-speech-reused-id").await;
        service
            .set_config(
                "ai.models",
                vec![model("reused-model", true, ModelCategory::GeneralChat)],
            )
            .await
            .expect("text model should save");

        let before: GlobalConfig = service.get_config(None).await.expect("config before save");
        assert_eq!(
            before.ai.default_models.primary.as_deref(),
            Some("reused-model")
        );
        assert_eq!(before.ai.default_models.fast, None);

        let result = service
            .save_cloud_speech_config(SaveCloudSpeechConfigRequest {
                config_id: Some("reused-model".to_string()),
                preset: "custom".to_string(),
                name: "Speech replacement".to_string(),
                base_url: "https://example.com/v1".to_string(),
                request_url: None,
                model_name: "speech-model".to_string(),
                api_key: "secret".to_string(),
            })
            .await
            .expect("speech replacement should save");
        assert!(!result.created);

        let after: GlobalConfig = service.get_config(None).await.expect("config after save");
        assert_eq!(after.ai.default_models.primary, None);
        assert_eq!(after.ai.default_models.fast, None);
        assert_eq!(
            after.ai.default_models.speech_recognition.as_deref(),
            Some("reused-model")
        );
        assert_ne!(
            after.ai.task_models.session_title.fixed_model_id(),
            Some("reused-model")
        );
        assert_ne!(
            after.ai.task_models.git_commit.fixed_model_id(),
            Some("reused-model")
        );
    }

    #[tokio::test]
    async fn clearing_fast_model_persists_unset_and_resolves_to_primary() {
        let test_name = "clear-fast-model";
        let (service, dir) = test_service(test_name).await;
        service
            .set_config(
                "ai.models",
                vec![
                    model("first-text", true, ModelCategory::GeneralChat),
                    model("primary-text", true, ModelCategory::GeneralChat),
                ],
            )
            .await
            .expect("models should save");
        service
            .set_config(
                "ai.default_models",
                &DefaultModelsConfig {
                    primary: Some("primary-text".to_string()),
                    fast: None,
                    ..Default::default()
                },
            )
            .await
            .expect("defaults should save");

        let current: GlobalConfig = service.get_config(None).await.expect("current config");
        assert_eq!(current.ai.default_models.fast, None);
        assert_eq!(
            current.ai.resolve_model_selection("fast").as_deref(),
            Some("primary-text")
        );

        let path_manager = PathManager::with_user_root_for_tests(dir.path().join(test_name));
        let persisted: GlobalConfig = serde_json::from_slice(
            &tokio::fs::read(path_manager.app_config_file())
                .await
                .expect("persisted config"),
        )
        .expect("valid persisted config");
        assert_eq!(persisted.ai.default_models.fast, None);
    }

    #[tokio::test]
    async fn set_config_rejects_invalid_reasoning_and_rolls_back() {
        let (service, _dir) = test_service("invalid-reasoning-set").await;
        let valid_models = vec![model("stable-model", true, ModelCategory::GeneralChat)];
        service
            .set_config("ai.models", &valid_models)
            .await
            .expect("valid models should save");

        let invalid_models = vec![AIModelConfig {
            reasoning: Some(openbitfun_core_types::ReasoningConfig {
                presets: vec![openbitfun_core_types::ReasoningPreset {
                    id: "bad-budget".to_string(),
                    actions: vec![openbitfun_core_types::ReasoningPresetAction::BudgetTokens {
                        value: 0,
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..model("invalid-model", true, ModelCategory::GeneralChat)
        }];

        let error = service
            .set_config("ai.models", &invalid_models)
            .await
            .expect_err("invalid reasoning must be rejected");
        assert!(error
            .to_string()
            .contains("budget_tokens value must be greater than 0"));

        let persisted_models: Vec<AIModelConfig> = service
            .get_config(Some("ai.models"))
            .await
            .expect("models should remain readable");
        assert_eq!(persisted_models.len(), 1);
        assert_eq!(persisted_models[0].id, "stable-model");
    }

    #[tokio::test]
    async fn import_config_rejects_duplicate_reasoning_presets() {
        let (service, _dir) = test_service("invalid-reasoning-import").await;
        let mut config = GlobalConfig::default();
        config.ai.models.push(AIModelConfig {
            reasoning: Some(openbitfun_core_types::ReasoningConfig {
                presets: vec![
                    openbitfun_core_types::ReasoningPreset {
                        id: "same".to_string(),
                        actions: vec![openbitfun_core_types::ReasoningPresetAction::Toggle {
                            enabled: true,
                        }],
                        ..Default::default()
                    },
                    openbitfun_core_types::ReasoningPreset {
                        id: "same".to_string(),
                        actions: vec![openbitfun_core_types::ReasoningPresetAction::Toggle {
                            enabled: false,
                        }],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }),
            ..model("duplicate-model", true, ModelCategory::GeneralChat)
        });

        let result = service
            .import_config(current_export(config))
            .await
            .expect("import should return a structured result");

        assert!(!result.success);
        assert!(result
            .errors
            .join(" ")
            .contains("duplicate preset ID 'same'"));
    }

    #[tokio::test]
    async fn reconcile_models_repairs_image_understanding_default_to_capable_model() {
        let (service, _dir) = test_service("vision-default-repair").await;
        let models = vec![
            model("text-model", true, ModelCategory::GeneralChat),
            model("disabled-vision", false, ModelCategory::Multimodal),
            model("active-vision", true, ModelCategory::Multimodal),
        ];

        service
            .set_config("ai.models", &models)
            .await
            .expect("models should save");
        service
            .set_config(
                "ai.default_models",
                &DefaultModelsConfig {
                    primary: Some("text-model".to_string()),
                    image_understanding: Some("disabled-vision".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("defaults should save");

        let defaults: DefaultModelsConfig = service
            .get_config(Some("ai.default_models"))
            .await
            .expect("defaults should load");
        assert_eq!(defaults.primary.as_deref(), Some("text-model"));
        assert_eq!(
            defaults.image_understanding.as_deref(),
            Some("active-vision"),
            "vision default must not fall back to a text-only model"
        );
    }

    #[tokio::test]
    async fn reconcile_models_resets_invalid_agent_model_defaults() {
        let (service, _dir) = test_service("agent-model-defaults-repair").await;
        service
            .set_config(
                "ai.models",
                &vec![model("old-model", true, ModelCategory::GeneralChat)],
            )
            .await
            .expect("initial model should save");
        service
            .set_config(
                "ai.agent_model_defaults",
                &AgentModelDefaultsConfig {
                    mode: "old-model".to_string(),
                    subagents: SubagentModelDefaultsConfig {
                        default_selection: SubagentModelSelection::fixed("old-model"),
                        builtin: HashMap::from([(
                            "Explore".to_string(),
                            SubagentModelSelection::fixed("old-model"),
                        )]),
                        fork: SubagentModelSelection::fixed("old-model"),
                    },
                },
            )
            .await
            .expect("agent model defaults should save");

        service
            .set_config(
                "ai.models",
                &vec![model("new-model", true, ModelCategory::GeneralChat)],
            )
            .await
            .expect("model replacement should reconcile defaults");

        let defaults: AgentModelDefaultsConfig = service
            .get_config(Some("ai.agent_model_defaults"))
            .await
            .expect("agent model defaults should load");
        assert_eq!(defaults.mode, "primary");
        assert_eq!(
            defaults.subagents.default_selection,
            SubagentModelSelection::fixed("fast")
        );
        assert_eq!(
            defaults.subagents.builtin,
            HashMap::from([(
                "ResearchSpecialist".to_string(),
                SubagentModelSelection::Inherit,
            )])
        );
        assert_eq!(defaults.subagents.fork, SubagentModelSelection::Inherit);
    }

    #[tokio::test]
    async fn appearance_selection_round_trips_through_the_typed_config() {
        let (service, _dir) = test_service("appearance-selection").await;

        service
            .set_config("appearance.selection", "openbitfun-dark")
            .await
            .expect("appearance selection should save");

        let selection: String = service
            .get_config(Some("appearance.selection"))
            .await
            .expect("appearance selection should load");
        assert_eq!(selection, "openbitfun-dark");

        let export: GlobalConfig = service
            .get_config(None)
            .await
            .expect("full config should load");
        let serialized = serde_json::to_value(export).expect("config should serialize");
        assert_eq!(serialized["appearance"]["selection"], "openbitfun-dark");
        assert!(serialized.get("theme").is_none());
        assert!(serialized.get("themes").is_none());
    }

    #[tokio::test]
    async fn raw_import_rejects_retired_skip_confirmation_without_mutating_disk() {
        let (service, _dir) = test_service("retired-skip-confirmation-raw-import").await;
        let config_dir = service.get_statistics().await.config_directory;
        let before = tokio::fs::read_to_string(config_dir.join("app.json"))
            .await
            .expect("current config");
        let mut raw_export = serde_json::to_value(current_export(GlobalConfig::default()))
            .expect("default export should serialize");
        let raw_object = raw_export["config"]
            .as_object_mut()
            .expect("default config should serialize as an object");
        raw_object
            .get_mut("ai")
            .and_then(serde_json::Value::as_object_mut)
            .expect("default config should include an AI object")
            .insert(
                "skip_tool_confirmation".to_string(),
                serde_json::Value::Bool(true),
            );

        let error = serde_json::from_value::<ConfigExport>(raw_export)
            .expect_err("retired fields must be rejected before typed import");
        assert!(
            error.to_string().contains("ai.skip_tool_confirmation"),
            "{error}"
        );
        assert_eq!(
            tokio::fs::read_to_string(config_dir.join("app.json"))
                .await
                .expect("current config"),
            before
        );
        assert!(!config_dir.join("backups").exists());
    }

    #[tokio::test]
    async fn startup_rejects_removed_model_reasoning_fields_without_mutating_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let user_root = dir.path().join("legacy-model-reasoning-startup");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));
        let settings = || ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 0,
        };

        let initial_service = ConfigService::with_settings(settings())
            .await
            .expect("initial config service");
        drop(initial_service);

        let mut raw_config =
            serde_json::to_value(GlobalConfig::default()).expect("default config should serialize");
        raw_config["version"] = serde_json::json!(env!("CARGO_PKG_VERSION"));
        raw_config["ai"]["models"] = serde_json::json!([{
            "id": "legacy-model",
            "name": "Legacy model",
            "provider": "responses",
            "model_name": "gpt-test",
            "base_url": "https://example.com/v1",
            "api_key": "key",
            "enabled": true,
            "reasoning_mode": "enabled",
            "reasoning_effort": "high"
        }]);
        let original =
            serde_json::to_string_pretty(&raw_config).expect("retired config should serialize");
        tokio::fs::write(path_manager.app_config_file(), &original)
            .await
            .expect("retired config should be written");

        let error = match ConfigService::with_settings(settings()).await {
            Ok(_) => panic!("retired reasoning fields must fail startup"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("ai.models[0].reasoning_mode"),
            "{error}"
        );
        assert_eq!(
            tokio::fs::read_to_string(path_manager.app_config_file())
                .await
                .expect("retired config should remain"),
            original
        );
        assert!(!path_manager.user_config_dir().join("backups").exists());
    }

    #[tokio::test]
    async fn startup_disables_invalid_reasoning_model_without_mutating_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let user_root = dir.path().join("invalid-reasoning-startup");
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));
        let settings = || ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 0,
        };

        let initial_service = ConfigService::with_settings(settings())
            .await
            .expect("initial config service");
        drop(initial_service);

        let mut raw_config =
            serde_json::to_value(GlobalConfig::default()).expect("default config should serialize");
        raw_config["version"] = serde_json::json!(env!("CARGO_PKG_VERSION"));
        raw_config["ai"]["models"] = serde_json::json!([{
            "id": "invalid-model",
            "name": "Invalid model",
            "provider": "responses",
            "model_name": "gpt-5.4",
            "base_url": "https://api.openai.com/v1/responses",
            "api_key": "key",
            "enabled": true,
            "reasoning": {
                "catalog": { "source": "disabled" },
                "default_preset": "missing",
                "presets": []
            }
        }]);
        tokio::fs::write(
            path_manager.app_config_file(),
            serde_json::to_string_pretty(&raw_config).expect("invalid config should serialize"),
        )
        .await
        .expect("invalid config should be written");

        let original = tokio::fs::read(path_manager.app_config_file())
            .await
            .unwrap();
        let service = ConfigService::with_settings(settings()).await.unwrap();
        let models = service.get_ai_models().await.unwrap();
        assert_eq!(models.len(), 1);
        assert!(!models[0].enabled);
        assert_eq!(models[0].api_key, "key");
        assert_eq!(
            models[0]
                .reasoning
                .as_ref()
                .unwrap()
                .default_preset
                .as_deref(),
            Some("missing")
        );
        assert!(service.load_diagnostics().await.iter().any(|d| d
            .message
            .contains("default preset 'missing' is not available")));
        assert_eq!(
            tokio::fs::read(path_manager.app_config_file())
                .await
                .unwrap(),
            original
        );
    }
}
