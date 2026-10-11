//! Global configuration service singleton
//!
//! Provides a global configuration service instance with dynamic updates and synchronization.

use super::service::ConfigService;
use crate::util::errors::*;
use log::{debug, info};
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::RwLock;

/// Global configuration service singleton.
static GLOBAL_CONFIG_SERVICE: OnceLock<Arc<RwLock<Option<Arc<ConfigService>>>>> = OnceLock::new();

/// Configuration update notification channel.
static CONFIG_UPDATE_SENDER: OnceLock<tokio::sync::broadcast::Sender<ConfigUpdateEvent>> =
    OnceLock::new();

/// Configuration update events.
#[derive(Debug, Clone)]
pub enum ConfigUpdateEvent {
    /// AI model catalog, default slots, or agent-model defaults changed.
    /// Consumers that materialize model bindings should rebuild future-use
    /// projections without mutating already running sessions.
    ModelConfigurationUpdated,
    /// AI model configuration updated.
    AIModelUpdated {
        model_id: String,
        model_name: String,
    },
    /// Default AI model updated.
    DefaultAIModelUpdated {
        model_id: String,
        model_name: String,
    },
    /// Web UI appearance selection updated.
    AppearanceUpdated { appearance_id: String },
    /// Editor configuration updated.
    EditorUpdated,
    /// Terminal configuration updated.
    TerminalUpdated,
    /// Workspace configuration updated.
    WorkspaceUpdated,
    /// App configuration updated.
    AppUpdated,
    /// Configuration fully reloaded.
    ConfigReloaded,
    /// The models.dev reasoning catalog snapshot changed. Session owners use
    /// this to reconcile persisted reasoning preset selections.
    ReasoningCatalogUpdated,
    /// Runtime log level updated.
    LogLevelUpdated {
        /// New runtime log level.
        new_level: String,
    },
    /// Runtime sensitive diagnostics preference updated.
    LoggingSensitiveDiagnosticsUpdated {
        /// Whether logs may include prompts, payloads, and other sensitive diagnostics.
        include_sensitive_diagnostics: bool,
    },
    /// AI models / default-model slots / agent-model defaults were reconciled
    /// after a model became unavailable (disabled, deleted, or otherwise
    /// invalid). Emitted whenever the config layer had to silently rewrite
    /// `ai.default_models`, `ai.agent_model_defaults`, or `ai.task_models`
    /// so they only reference enabled models.
    ModelsReconciled {
        /// Model ids that just became unusable (disabled or deleted) and that
        /// any active session, default slot, or agent mapping was pointing at
        /// before this reconcile pass.
        invalidated_model_ids: Vec<String>,
        /// Whether `ai.default_models` was rewritten as part of the reconcile.
        default_models_changed: bool,
        /// Whether `ai.task_models` was rewritten as part of the reconcile.
        task_models_changed: bool,
        /// Whether `ai.agent_model_defaults` was rewritten as part of the reconcile.
        agent_model_defaults_changed: bool,
    },
}

/// Global configuration service manager.
pub struct GlobalConfigManager;

impl GlobalConfigManager {
    /// Initializes the global configuration service.
    pub async fn initialize() -> OpenBitFunResult<()> {
        if Self::is_initialized() {
            debug!("Global config service already initialized, skipping");
            return Ok(());
        }

        let (sender, _) = tokio::sync::broadcast::channel(100);
        CONFIG_UPDATE_SENDER.set(sender).map_err(|_| {
            OpenBitFunError::config("Failed to initialize config update sender".to_string())
        })?;

        let config_service = Arc::new(ConfigService::new().await?);
        let service_wrapper = Arc::new(RwLock::new(Some(Arc::clone(&config_service))));

        GLOBAL_CONFIG_SERVICE.set(service_wrapper).map_err(|_| {
            OpenBitFunError::config("Failed to initialize global config service".to_string())
        })?;

        #[cfg(feature = "web-tools")]
        {
            let ai_config = config_service.get_config(Some("ai")).await?;
            crate::service::web_search::refresh_global_web_search_runtime(&ai_config).await;
        }

        #[cfg(feature = "model-catalog")]
        crate::infrastructure::ai::reasoning_catalog::prepare_model_catalog();

        info!("Global config service initialized");

        Ok(())
    }

    /// Returns the global configuration service instance.
    pub async fn get_service() -> OpenBitFunResult<Arc<ConfigService>> {
        let service_wrapper = GLOBAL_CONFIG_SERVICE.get().ok_or_else(|| {
            OpenBitFunError::config("Global config service not initialized".to_string())
        })?;

        let service_guard = service_wrapper.read().await;
        service_guard
            .as_ref()
            .ok_or_else(|| OpenBitFunError::config("Global config service is None".to_string()))
            .map(Arc::clone)
    }

    /// Updates the global configuration service instance (used for configuration reload).
    pub async fn update_service(new_service: Arc<ConfigService>) -> OpenBitFunResult<()> {
        let service_wrapper = GLOBAL_CONFIG_SERVICE.get().ok_or_else(|| {
            OpenBitFunError::config("Global config service not initialized".to_string())
        })?;

        {
            let mut service_guard = service_wrapper.write().await;
            *service_guard = Some(Arc::clone(&new_service));
        }

        #[cfg(feature = "web-tools")]
        {
            let ai_config = new_service.get_config(Some("ai")).await?;
            crate::service::web_search::refresh_global_web_search_runtime(&ai_config).await;
        }

        Self::broadcast_update(ConfigUpdateEvent::ConfigReloaded).await;

        debug!("Global config service updated");
        Ok(())
    }

    /// Reloads configuration in-place.
    ///
    /// Re-reads the config from disk into the existing `ConfigService` instance,
    /// preserving the `Arc` pointer so that all holders (e.g. `AppState`) stay in sync.
    pub async fn reload() -> OpenBitFunResult<()> {
        let service = Self::get_service().await?;
        service.reload().await?;
        Self::broadcast_update(ConfigUpdateEvent::ConfigReloaded).await;
        Ok(())
    }

    /// Subscribes to configuration update events.
    pub fn subscribe_updates() -> Option<tokio::sync::broadcast::Receiver<ConfigUpdateEvent>> {
        CONFIG_UPDATE_SENDER.get().map(|sender| sender.subscribe())
    }

    /// Broadcasts a configuration update event.
    pub async fn broadcast_update(event: ConfigUpdateEvent) {
        if let Some(sender) = CONFIG_UPDATE_SENDER.get() {
            let _ = sender.send(event);
        }
    }

    /// Updates an AI model configuration and broadcasts an event.
    pub async fn update_ai_model(
        &self,
        model_id: &str,
        model: crate::service::config::types::AIModelConfig,
    ) -> OpenBitFunResult<()> {
        let model_name = model.name.clone();
        let service = Self::get_service().await?;
        service.update_ai_model(model_id, model).await?;

        Self::broadcast_update(ConfigUpdateEvent::AIModelUpdated {
            model_id: model_id.to_string(),
            model_name,
        })
        .await;

        Ok(())
    }

    /// Updates the Web UI appearance selection and broadcasts an event.
    pub async fn update_appearance(&self, appearance_id: &str) -> OpenBitFunResult<()> {
        let service = Self::get_service().await?;
        service
            .set_config("appearance.selection", appearance_id)
            .await?;
        let stored_appearance_id: String = service.get_config(Some("appearance.selection")).await?;

        Self::broadcast_update(ConfigUpdateEvent::AppearanceUpdated {
            appearance_id: stored_appearance_id,
        })
        .await;

        Ok(())
    }

    /// Returns whether the configuration service has been initialized.
    pub fn is_initialized() -> bool {
        GLOBAL_CONFIG_SERVICE.get().is_some()
    }
}

/// Convenience helper: get the global configuration service.
pub async fn get_global_config_service() -> OpenBitFunResult<Arc<ConfigService>> {
    GlobalConfigManager::get_service().await
}

/// Convenience helper: initialize the global configuration service.
pub async fn initialize_global_config() -> OpenBitFunResult<()> {
    GlobalConfigManager::initialize().await
}

/// Convenience helper: reload the global configuration.
pub async fn reload_global_config() -> OpenBitFunResult<()> {
    GlobalConfigManager::reload().await
}

/// Convenience helper: subscribe to configuration updates.
pub fn subscribe_config_updates() -> Option<tokio::sync::broadcast::Receiver<ConfigUpdateEvent>> {
    GlobalConfigManager::subscribe_updates()
}
