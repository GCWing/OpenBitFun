//! Configuration manager implementation
//!
//! A complete configuration management system based on the Provider mechanism.

use super::normalization::{normalize_typed_config, reconcile_model_references};
use super::providers::ConfigProviderRegistry;
use super::types::*;
use crate::infrastructure::{try_get_path_manager_arc, PathManager};
use crate::util::errors::*;
use log::{debug, info, warn};
use openbitfun_config_contracts::protected_account_models::{
    account_guard_sources, preserve_account_guard_sources, protect_account_models,
    restore_account_models,
};
use openbitfun_core_types::{
    installer_config_handoff::{
        InstallerConfigHandoff, InstallerModelHandoff, INSTALLER_CONFIG_HANDOFF_FILE_NAME,
    },
    product_identity,
};
use openbitfun_services_core::json_store::JsonFileStore;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;

fn invalid_config_error(context: &str, result: &ConfigValidationResult) -> OpenBitFunError {
    let messages = result
        .errors
        .iter()
        .map(|error| format!("{}: {}", error.path, error.message))
        .collect::<Vec<_>>()
        .join(", ");
    OpenBitFunError::validation(format!("{context}: {messages}"))
}

pub(crate) fn validate_openbitfun_product_identity(
    value: &str,
    context: &str,
) -> OpenBitFunResult<()> {
    openbitfun_config_contracts::validate_openbitfun_product_identity(value, context)
        .map_err(OpenBitFunError::validation)
}

pub(crate) fn validate_current_config_value(value: &Value, context: &str) -> OpenBitFunResult<()> {
    openbitfun_config_contracts::validate_current_config_value(value, context)
        .map_err(OpenBitFunError::validation)
}

const INSTALLER_MODEL_ID: &str = "installer:default";
const INSTALLER_MODEL_CONTEXT_WINDOW: u32 = 300_000;

fn model_from_installer_handoff(model: InstallerModelHandoff) -> AIModelConfig {
    AIModelConfig {
        id: INSTALLER_MODEL_ID.to_string(),
        name: model.name,
        provider: model.provider,
        model_name: model.model_name,
        base_url: model.base_url,
        request_url: Some(model.request_url),
        api_key: model.api_key,
        context_window: Some(INSTALLER_MODEL_CONTEXT_WINDOW),
        enabled: true,
        category: ModelCategory::GeneralChat,
        capabilities: vec![ModelCapability::TextChat, ModelCapability::FunctionCalling],
        inline_think_in_text: false,
        custom_headers: model.custom_headers,
        custom_headers_mode: model.custom_headers_mode,
        skip_ssl_verify: model.skip_ssl_verify,
        custom_request_body: model.custom_request_body,
        ..AIModelConfig::default()
    }
}

fn reject_protected_metadata_path(path: &str) -> OpenBitFunResult<()> {
    if matches!(
        path,
        "product_id" | "schema_version" | "version" | "last_modified"
    ) {
        return Err(OpenBitFunError::validation(format!(
            "Configuration metadata '{path}' is managed by OpenBitFun and cannot be changed directly"
        )));
    }
    Ok(())
}

fn config_value_for_persistence(config: &GlobalConfig) -> OpenBitFunResult<Value> {
    let mut value = serde_json::to_value(config)
        .map_err(|e| OpenBitFunError::config(format!("Failed to serialize config: {}", e)))?;
    prune_default_ai_tool_argument_json_repair(&mut value);
    prune_default_ai_max_rounds(&mut value);
    if config.ai.user_question_timeout_secs == AIConfig::default().user_question_timeout_secs {
        if let Some(ai) = value.get_mut("ai").and_then(Value::as_object_mut) {
            ai.remove("user_question_timeout_secs");
        }
    }
    prune_default_memories_config(&mut value)?;
    prune_default_web_search_config(&mut value)?;
    protect_account_models(&mut value);
    Ok(value)
}

fn prune_default_ai_tool_argument_json_repair(config_value: &mut Value) {
    let Some(ai_config) = config_value.get_mut("ai").and_then(Value::as_object_mut) else {
        return;
    };

    if ai_config.get("allow_tool_json_repair") == Some(&Value::Bool(true)) {
        ai_config.remove("allow_tool_json_repair");
    }
}

fn prune_default_ai_max_rounds(config_value: &mut Value) {
    let Some(ai_config) = config_value.get_mut("ai").and_then(Value::as_object_mut) else {
        return;
    };

    if ai_config.get("max_rounds").and_then(Value::as_u64)
        == Some(crate::service::config::types::DEFAULT_MAX_ROUNDS as u64)
    {
        ai_config.remove("max_rounds");
    }
}

fn prune_default_memories_config(config_value: &mut Value) -> OpenBitFunResult<()> {
    let Some(config_object) = config_value.as_object_mut() else {
        return Ok(());
    };
    let Some(memories_value) = config_object.get_mut("memories") else {
        return Ok(());
    };

    let default_memories = serde_json::to_value(MemoriesConfig::default()).map_err(|e| {
        OpenBitFunError::config(format!(
            "Failed to serialize default memories config: {}",
            e
        ))
    })?;
    let Some(default_memories_object) = default_memories.as_object() else {
        return Ok(());
    };
    let Some(memories_object) = memories_value.as_object_mut() else {
        return Ok(());
    };

    memories_object.retain(|key, value| default_memories_object.get(key) != Some(value));

    if memories_object.is_empty() {
        config_object.remove("memories");
    }

    Ok(())
}

fn prune_default_web_search_config(config_value: &mut Value) -> OpenBitFunResult<()> {
    let Some(ai_config) = config_value.get_mut("ai").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    let Some(web_search) = ai_config
        .get_mut("web_search")
        .and_then(Value::as_object_mut)
    else {
        return Ok(());
    };

    let defaults = serde_json::to_value(WebSearchConfig::default()).map_err(|e| {
        OpenBitFunError::config(format!(
            "Failed to serialize default WebSearch config: {}",
            e
        ))
    })?;
    let defaults = defaults
        .as_object()
        .expect("WebSearchConfig serializes as an object");
    prune_matching_default_fields(web_search, defaults);

    if web_search.is_empty() {
        ai_config.remove("web_search");
    }
    Ok(())
}

fn prune_matching_default_fields(
    current: &mut serde_json::Map<String, Value>,
    defaults: &serde_json::Map<String, Value>,
) {
    for (key, default_value) in defaults {
        let should_remove = match current.get_mut(key) {
            Some(current_value) if current_value == default_value => true,
            Some(Value::Object(current_object)) => {
                let Value::Object(default_object) = default_value else {
                    continue;
                };
                prune_matching_default_fields(current_object, default_object);
                current_object.is_empty()
            }
            _ => false,
        };
        if should_remove {
            current.remove(key);
        }
    }
}

/// Configuration manager.
pub struct ConfigManager {
    config_dir: PathBuf,
    config: GlobalConfig,
    providers: ConfigProviderRegistry,
    config_file: PathBuf,
    path_manager: Arc<PathManager>,
    backup_count: usize,
    load_diagnostics: Vec<ConfigDiagnostic>,
    account_guard_sources: HashMap<String, Value>,
}

struct ConfigCandidate {
    config: GlobalConfig,
    guard_sources: HashMap<String, Value>,
    diagnostics: Vec<ConfigDiagnostic>,
}

/// Configuration manager settings.
#[derive(Debug, Clone)]
pub struct ConfigManagerSettings {
    pub path_manager: Option<Arc<PathManager>>,
    pub auto_save: bool,
    pub backup_count: usize,
}

impl Default for ConfigManagerSettings {
    fn default() -> Self {
        Self {
            path_manager: None,
            auto_save: true,
            backup_count: 5,
        }
    }
}

impl ConfigManager {
    /// Creates a new unified configuration manager.
    pub async fn new(settings: ConfigManagerSettings) -> OpenBitFunResult<Self> {
        let path_manager = match settings.path_manager {
            Some(path_manager) => path_manager,
            None => try_get_path_manager_arc()?,
        };

        path_manager.initialize_user_directories().await?;

        let config_dir = path_manager.user_config_dir();
        let config_file = path_manager.app_config_file();

        let providers = ConfigProviderRegistry::new();
        let backup_count = settings.backup_count;

        let mut manager = Self {
            config_dir,
            config: GlobalConfig::default(),
            providers,
            config_file,
            path_manager,
            backup_count,
            load_diagnostics: Vec::new(),
            account_guard_sources: HashMap::new(),
        };

        manager.load_or_create_config().await?;
        #[cfg(feature = "ai-adapter-runtime")]
        {
            openbitfun_ai_adapters::diagnostics::set_include_sensitive_diagnostics(
                manager.config.app.logging.include_sensitive_diagnostics,
            );
        }

        debug!("ConfigManager initialized at {:?}", manager.config_file);
        Ok(manager)
    }

    /// Returns the path manager.
    pub fn path_manager(&self) -> &Arc<PathManager> {
        &self.path_manager
    }

    /// Reloads from the same storage root while the service holds its write
    /// lock, so a concurrent save cannot be replaced by an older disk read.
    pub(crate) async fn reload(&mut self) -> OpenBitFunResult<()> {
        let settings = ConfigManagerSettings {
            path_manager: Some(self.path_manager.clone()),
            auto_save: true,
            backup_count: self.backup_count,
        };
        *self = Self::new(settings).await?;
        Ok(())
    }

    /// Loads or creates the configuration file.
    async fn load_or_create_config(&mut self) -> OpenBitFunResult<()> {
        if self.config_file.exists() {
            self.load_existing_config().await?;
        } else {
            self.create_default_config().await?;
        }

        if let Err(error) = self.consume_installer_config_handoff().await {
            warn!("Could not apply installer configuration handoff: {error}");
        }

        Ok(())
    }

    /// Creates the first config file using the already initialized defaults.
    async fn create_default_config(&mut self) -> OpenBitFunResult<()> {
        self.config
            .ai
            .set_model_selections(Default::default())
            .map_err(OpenBitFunError::validation)?;
        self.config.product_id = product_identity::product_id().to_string();
        self.config.schema_version = CURRENT_CONFIG_SCHEMA_VERSION;
        self.config.version = env!("CARGO_PKG_VERSION").to_string();
        self.config.last_modified = chrono::Utc::now();
        self.save_config().await?;
        debug!("Created default config file");
        Ok(())
    }

    async fn consume_installer_config_handoff(&mut self) -> OpenBitFunResult<()> {
        let handoff_file = self.config_dir.join(INSTALLER_CONFIG_HANDOFF_FILE_NAME);
        if !handoff_file.exists() {
            return Ok(());
        }

        let store = JsonFileStore;
        let _cross_process_lock = store
            .acquire_cross_process_lock(&handoff_file)
            .await
            .map_err(|error| OpenBitFunError::config(error.to_string()))?;
        let Some(handoff) = store
            .read_optional::<InstallerConfigHandoff>(&handoff_file)
            .await
            .map_err(|error| OpenBitFunError::config(error.to_string()))?
        else {
            return Ok(());
        };

        let mut config = self.config.clone();
        if let Some(language) = handoff.language {
            config.app.language = language;
        }
        if let Some(selection) = handoff.appearance_selection {
            config.appearance.selection = selection;
        }
        if let Some(model) = handoff.model {
            let model = model_from_installer_handoff(model);
            if let Some(existing) = config
                .ai
                .models
                .iter_mut()
                .find(|existing| existing.id == INSTALLER_MODEL_ID)
            {
                *existing = model;
            } else {
                config.ai.models.push(model);
            }
            config.ai.default_models.primary = Some(INSTALLER_MODEL_ID.to_string());
            config.ai.default_models.fast = Some(INSTALLER_MODEL_ID.to_string());
        }

        let mut diagnostics = normalize_typed_config(&mut config);
        diagnostics.extend(reconcile_model_references(&mut config).diagnostics);
        let validation_result = self.providers.validate_config(&config).await?;
        if !validation_result.valid {
            return Err(invalid_config_error(
                "Invalid installer configuration handoff",
                &validation_result,
            ));
        }

        config.product_id = product_identity::product_id().to_string();
        config.schema_version = CURRENT_CONFIG_SCHEMA_VERSION;
        config.version = env!("CARGO_PKG_VERSION").to_string();
        config.last_modified = chrono::Utc::now();
        self.persist_config(&config).await?;
        self.config = config;
        self.load_diagnostics.extend(diagnostics);

        match fs::remove_file(&handoff_file).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warn!(
                "Applied installer configuration but could not remove handoff file: path={}, error={}",
                handoff_file.display(),
                error
            ),
        }
        Ok(())
    }

    /// Loads an existing OpenBitFun config, with a narrow repair for the sparse
    /// document written by released standalone installers.
    async fn load_existing_config(&mut self) -> OpenBitFunResult<()> {
        let content = fs::read_to_string(&self.config_file)
            .await
            .map_err(|e| OpenBitFunError::config(format!("Failed to read config file: {}", e)))?;

        let mut config_value: Value = serde_json::from_str(&content).map_err(|error| {
            OpenBitFunError::config(format!("Failed to parse config file as JSON: {error}"))
        })?;
        if let Err(contract_error) =
            validate_current_config_value(&config_value, "Configuration file")
        {
            if let Some(config) = self
                .try_repair_sparse_installer_config(&content, &config_value)
                .await?
            {
                self.config = config;
                return Ok(());
            }
            return Err(contract_error);
        }

        let guard_sources = account_guard_sources(&config_value);
        let mut restored_value = config_value.clone();
        let mut diagnostics = restore_account_models(&mut restored_value);
        let mut config: GlobalConfig = serde_json::from_value(restored_value).map_err(|error| {
            OpenBitFunError::config(format!("Failed to deserialize config file: {error}"))
        })?;
        let migrated_selections = config
            .ai
            .migrate_model_selections()
            .map_err(OpenBitFunError::validation)?;
        diagnostics.extend(
            openbitfun_config_contracts::normalization::recover_persisted_config(&mut config),
        );
        let validation_result = self
            .validate_recovered_config(&mut config, &mut diagnostics)
            .await?;
        if !validation_result.valid {
            return Err(invalid_config_error(
                "Invalid configuration file",
                &validation_result,
            ));
        }

        if migrated_selections {
            // Add only the new selection record; recovery must not overwrite source data.
            config_value["ai"]["agent_model_selections"] =
                config.ai.agent_model_selections.clone().unwrap();
            let content = serde_json::to_string_pretty(&config_value)
                .map_err(|error| OpenBitFunError::config(error.to_string()))?;
            JsonFileStore
                .write_text_atomic_strict(&self.config_file, &content)
                .await
                .map_err(|error| {
                    OpenBitFunError::config(format!(
                        "Failed to persist model selection migration: {error}"
                    ))
                })?;
        }
        self.config = config;
        self.load_diagnostics = diagnostics;
        self.account_guard_sources = guard_sources;
        debug!("Loaded OpenBitFun config from file");
        Ok(())
    }

    // Catalog/provider-dependent reasoning checks cannot run in the offline
    // importer. Preserve unusable model records and surface a diagnostic while
    // allowing the remaining configuration to load. Each retry disables at
    // least one enabled model; unrelated validation errors remain errors.
    async fn validate_recovered_config(
        &self,
        config: &mut GlobalConfig,
        diagnostics: &mut Vec<super::types::ConfigDiagnostic>,
    ) -> OpenBitFunResult<super::types::ConfigValidationResult> {
        loop {
            let result = self.providers.validate_config(config).await?;
            let mut recovered = false;
            for error in &result.errors {
                let Some(index) = error
                    .path
                    .strip_prefix("ai.models[")
                    .and_then(|path| path.split_once(']'))
                    .and_then(|(index, _)| index.parse::<usize>().ok())
                else {
                    continue;
                };
                let Some(model) = config
                    .ai
                    .models
                    .get_mut(index)
                    .filter(|model| model.enabled)
                else {
                    continue;
                };
                model.enabled = false;
                diagnostics.push(super::types::ConfigDiagnostic {
                    path: error.path.clone(),
                    message: error.message.clone(),
                    code: "CONFIG_MODEL_DISABLED".into(),
                    severity: super::types::ConfigDiagnosticSeverity::Warning,
                    recoverability: super::types::ConfigDiagnosticRecoverability::ModelDisabled,
                });
                recovered = true;
            }
            if !recovered {
                return Ok(result);
            }
            diagnostics.extend(reconcile_model_references(config).diagnostics);
        }
    }

    async fn try_repair_sparse_installer_config(
        &mut self,
        content: &str,
        config_value: &Value,
    ) -> OpenBitFunResult<Option<GlobalConfig>> {
        let Some(root) = config_value.as_object() else {
            return Ok(None);
        };
        if !root
            .keys()
            .all(|key| matches!(key.as_str(), "app" | "ai" | "themes"))
        {
            return Ok(None);
        }
        let Some(app) = root.get("app").and_then(Value::as_object) else {
            return Ok(None);
        };
        let Some(language) = app.get("language").and_then(Value::as_str) else {
            return Ok(None);
        };

        let mut config = GlobalConfig::default();
        config.app.language = language.to_string();
        if let Some(themes) = root.get("themes") {
            let Some(selection) = themes.get("current").and_then(Value::as_str) else {
                return Ok(None);
            };
            config.appearance.selection = selection.to_string();
        }
        if let Some(ai) = root.get("ai") {
            let Ok(ai) = serde_json::from_value(ai.clone()) else {
                return Ok(None);
            };
            config.ai = ai;
        }

        config
            .ai
            .migrate_model_selections()
            .map_err(OpenBitFunError::validation)?;
        let mut diagnostics = normalize_typed_config(&mut config);
        diagnostics.extend(reconcile_model_references(&mut config).diagnostics);
        let validation_result = self.providers.validate_config(&config).await?;
        if !validation_result.valid {
            return Ok(None);
        }

        let backup = self
            .backup_raw_config(content, "installer-config-repair")
            .await?;
        self.persist_config(&config).await?;
        self.load_diagnostics = diagnostics;
        info!(
            "Repaired sparse installer configuration: config={}, backup={}",
            self.config_file.display(),
            backup.display()
        );
        Ok(Some(config))
    }

    /// Saves the configuration file.
    async fn save_config(&self) -> OpenBitFunResult<()> {
        self.persist_config(&self.config).await.map(|_| ())
    }

    fn persistence_value(&self, config: &GlobalConfig) -> OpenBitFunResult<Value> {
        let mut value = config_value_for_persistence(config)?;
        preserve_account_guard_sources(&mut value, &self.account_guard_sources);
        Ok(value)
    }

    async fn persist_config(
        &self,
        config: &GlobalConfig,
    ) -> OpenBitFunResult<HashMap<String, Value>> {
        let value = self.persistence_value(config)?;
        let content = serde_json::to_string_pretty(&value)
            .map_err(|e| OpenBitFunError::config(format!("Config serialization failed: {}", e)))?;

        if let Some(parent) = self.config_file.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).await.map_err(|e| {
                    OpenBitFunError::config(format!(
                        "Failed to create config directory {:?}: {}",
                        parent, e
                    ))
                })?;
            }
        }

        JsonFileStore
            .write_text_atomic_strict(&self.config_file, &content)
            .await
            .map_err(|e| {
                OpenBitFunError::config(format!(
                    "Failed to atomically write config file {:?}: {}",
                    self.config_file, e
                ))
            })?;
        Ok(account_guard_sources(&value))
    }

    async fn backup_raw_config(&self, content: &str, reason: &str) -> OpenBitFunResult<PathBuf> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S_%3f");
        let backup_dir = self.config_dir.join("backups");
        fs::create_dir_all(&backup_dir).await.map_err(|e| {
            OpenBitFunError::config(format!("Failed to create backup directory: {e}"))
        })?;
        let backup_file = backup_dir.join(format!(
            "app_{reason}_{timestamp}_{}.json",
            uuid::Uuid::new_v4().simple()
        ));
        fs::write(&backup_file, content)
            .await
            .map_err(|e| OpenBitFunError::config(format!("Failed to write config backup: {e}")))?;
        self.prune_backups(&backup_dir).await?;
        info!(
            "Created config backup: reason={}, path={}",
            reason,
            backup_file.display()
        );
        Ok(backup_file)
    }

    async fn prune_backups(&self, backup_dir: &std::path::Path) -> OpenBitFunResult<()> {
        if self.backup_count == 0 {
            return Ok(());
        }
        let mut entries = fs::read_dir(backup_dir).await.map_err(|e| {
            OpenBitFunError::config(format!("Failed to read backup directory: {e}"))
        })?;
        let mut files = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| OpenBitFunError::config(format!("Failed to enumerate backups: {e}")))?
        {
            let is_repair_backup = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("app_") && name.ends_with(".json"));
            if !is_repair_backup {
                continue;
            }
            let metadata = entry
                .metadata()
                .await
                .map_err(|e| OpenBitFunError::config(format!("Failed to inspect backup: {e}")))?;
            if metadata.is_file() {
                files.push((metadata.modified().ok(), entry.path()));
            }
        }
        files.sort_by_key(|(modified, _)| *modified);
        let remove_count = files.len().saturating_sub(self.backup_count);
        for (_, path) in files.into_iter().take(remove_count) {
            if let Err(error) = fs::remove_file(&path).await {
                warn!(
                    "Failed to prune old config backup: path={}, error={}",
                    path.display(),
                    error
                );
            }
        }
        Ok(())
    }

    /// Gets a configuration value (supports dot-paths).
    pub fn get<T>(&self, path: &str) -> OpenBitFunResult<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let value = self.get_value_by_path(path)?;
        serde_json::from_value(value).map_err(|e| {
            OpenBitFunError::config(format!(
                "Failed to deserialize config value at '{}': {}",
                path, e
            ))
        })
    }

    /// Sets a configuration value (supports dot-paths).
    pub async fn set<T>(&mut self, path: &str, value: T) -> OpenBitFunResult<()>
    where
        T: serde::Serialize,
    {
        let json_value = serde_json::to_value(value).map_err(|e| {
            OpenBitFunError::config(format!("Failed to serialize config value: {}", e))
        })?;

        reject_protected_metadata_path(path)?;
        if path == "ai.agent_model_defaults" || path.starts_with("ai.agent_model_defaults.") {
            return Err(OpenBitFunError::validation(
                "Legacy Agent model defaults are read-only; use ai.agent_model_selections",
            ));
        }
        if self.get::<serde_json::Value>(path).ok().as_ref() == Some(&json_value) {
            return Ok(());
        }
        // Typed writes use only the initialized selection area. A whole-area
        // replacement can explicitly repair malformed selections.
        if path == "ai.agent_model_selections" || path.starts_with("ai.agent_model_selections.") {
            let mut config = self.config.clone();
            let defaults = &mut config.ai;
            let mut selections = if path == "ai.agent_model_selections" {
                json_value
            } else {
                let mut value = serde_json::to_value(
                    defaults
                        .effective_model_selections()
                        .map_err(OpenBitFunError::validation)?,
                )?;
                let keys: Vec<&str> = path
                    .trim_start_matches("ai.agent_model_selections.")
                    .split('.')
                    .collect();
                let (last, parents) = keys
                    .split_last()
                    .ok_or_else(|| OpenBitFunError::validation("Missing selection path"))?;
                let mut target = &mut value;
                for key in parents {
                    target = target.get_mut(*key).ok_or_else(|| {
                        OpenBitFunError::validation("Invalid model selection path")
                    })?;
                }
                let object = target
                    .as_object_mut()
                    .ok_or_else(|| OpenBitFunError::validation("Invalid model selection path"))?;
                if json_value.is_null() {
                    object.remove(*last);
                } else {
                    object.insert((*last).into(), json_value);
                }
                value
            };
            let typed: openbitfun_config_contracts::model_pool::AgentModelSelections =
                serde_json::from_value(selections.take()).map_err(|e| {
                    OpenBitFunError::validation(format!("Invalid Agent model selections: {e}"))
                })?;
            validate_agent_model_selections(
                &config.ai,
                &typed,
                config.ai.effective_model_selections().ok().as_ref(),
            )?;
            config
                .ai
                .set_model_selections(typed)
                .map_err(OpenBitFunError::validation)?;
            return self
                .commit_candidate(
                    ConfigCandidate {
                        config,
                        guard_sources: self.account_guard_sources.clone(),
                        diagnostics: vec![],
                    },
                    Some(path),
                )
                .await;
        }
        let mut candidate = self.config_with_value(path, json_value)?;
        let config = &mut candidate.config;
        // Whole-document/AI replacements are ingestion boundaries, like import.
        // Ordinary field updates must not perform legacy migration.
        if path.is_empty() || path == "ai" {
            config
                .ai
                .migrate_model_selections()
                .map_err(OpenBitFunError::validation)?;
        }
        // Apply capability-driven canonicalization before validation and persistence.
        // Speech/embedding/image-only models must never carry text-generation sentinels.
        normalize_typed_config(config);
        if path.is_empty()
            || path == "ai"
            || path.starts_with("ai.models")
            || path.starts_with("ai.default_models")
            || path.starts_with("ai.agent_model_defaults")
            || path.starts_with("ai.task_models")
        {
            reconcile_model_references(config);
        }

        let validation_result = self.providers.validate_config(config).await?;
        if !validation_result.valid {
            return Err(invalid_config_error(
                "Invalid configuration update",
                &validation_result,
            ));
        }

        self.commit_candidate(candidate, Some(path)).await
    }

    /// Resets configuration (supports dot-paths).
    pub async fn reset(&mut self, path: Option<&str>) -> OpenBitFunResult<()> {
        let mut default_config = self.providers.get_default_config();
        default_config
            .ai
            .set_model_selections(Default::default())
            .map_err(OpenBitFunError::validation)?;
        let candidate = if let Some(path) = path {
            reject_protected_metadata_path(path)?;
            if path == "ai.agent_model_defaults" || path.starts_with("ai.agent_model_defaults.") {
                return Err(OpenBitFunError::validation(
                    "Legacy Agent model defaults are read-only; use ai.agent_model_selections",
                ));
            }
            let default_value = self.get_value_by_path_from_config(&default_config, path)?;
            self.config_with_value(path, default_value)?
        } else {
            ConfigCandidate {
                config: default_config,
                guard_sources: HashMap::new(),
                diagnostics: vec![],
            }
        };

        let validation_result = self.providers.validate_config(&candidate.config).await?;
        if !validation_result.valid {
            return Err(invalid_config_error(
                "Invalid configuration reset",
                &validation_result,
            ));
        }

        self.commit_candidate(candidate, path).await
    }

    async fn commit_candidate(
        &mut self,
        mut candidate: ConfigCandidate,
        path: Option<&str>,
    ) -> OpenBitFunResult<()> {
        openbitfun_config_contracts::channel_routing::validate_channel_routes(
            &candidate.config.ai.models,
        )
        .map_err(OpenBitFunError::config)?;
        openbitfun_config_contracts::account_pool::reconcile_account_pool_revisions(
            &self.config.ai.models,
            &mut candidate.config.ai.models,
            path.is_some(),
        )
        .map_err(OpenBitFunError::config)?;
        let previous_sources =
            std::mem::replace(&mut self.account_guard_sources, candidate.guard_sources);
        if let Err(error) = self.commit_config(candidate.config, path).await {
            self.account_guard_sources = previous_sources;
            return Err(error);
        }
        self.load_diagnostics
            .retain(|diagnostic| diagnostic.code != "SUBSCRIPTION_ACCOUNT_BINDING_UNSUPPORTED");
        for diagnostic in candidate.diagnostics {
            if !self.load_diagnostics.contains(&diagnostic) {
                self.load_diagnostics.push(diagnostic);
            }
        }
        Ok(())
    }

    /// Publish only a configuration that has reached disk. Failed writes must
    /// not change reads, runtime subscribers, or a subsequent unrelated save.
    async fn commit_config(
        &mut self,
        mut config: GlobalConfig,
        path: Option<&str>,
    ) -> OpenBitFunResult<()> {
        config.product_id = product_identity::product_id().to_string();
        config.schema_version = CURRENT_CONFIG_SCHEMA_VERSION;
        config.version = env!("CARGO_PKG_VERSION").to_string();
        config.last_modified = chrono::Utc::now();
        let guard_sources = self.persist_config(&config).await?;
        self.account_guard_sources = guard_sources;
        let old_config = std::mem::replace(&mut self.config, config);
        let paths = match path.filter(|path| !path.is_empty()) {
            Some(path) => vec![path.to_string()],
            None => self.providers.get_provider_names(),
        };
        for path in paths {
            // A subscriber failure cannot undo an already committed file. Keep
            // notifying the other providers and report the refresh failure.
            if let Err(error) = self.notify_config_changed(&path, &old_config).await {
                warn!(
                    "Configuration saved but change notification failed: path={}, error={}",
                    path, error
                );
            }
        }
        Ok(())
    }

    /// Returns the full configuration.
    pub fn get_config(&self) -> &GlobalConfig {
        &self.config
    }

    pub fn load_diagnostics(&self) -> &[ConfigDiagnostic] {
        &self.load_diagnostics
    }

    /// Validates configuration.
    pub async fn validate_config(&self) -> OpenBitFunResult<ConfigValidationResult> {
        self.providers.validate_config(&self.config).await
    }

    /// Exports configuration.
    pub fn export_config(&self) -> OpenBitFunResult<serde_json::Value> {
        let mut value = serde_json::to_value(&self.config)
            .map_err(|e| OpenBitFunError::config(format!("Failed to export config: {}", e)))?;
        protect_account_models(&mut value);
        preserve_account_guard_sources(&mut value, &self.account_guard_sources);
        Ok(value)
    }

    /// Imports configuration.
    pub async fn import_config(
        &mut self,
        mut config_data: serde_json::Value,
    ) -> OpenBitFunResult<()> {
        validate_current_config_value(&config_data, "Imported configuration")?;
        let imported_sources = account_guard_sources(&config_data);
        let diagnostics = restore_account_models(&mut config_data);
        let mut imported_config: GlobalConfig =
            serde_json::from_value(config_data).map_err(|e| {
                OpenBitFunError::config(format!("Failed to parse imported config: {}", e))
            })?;

        imported_config
            .ai
            .migrate_model_selections()
            .map_err(OpenBitFunError::validation)?;
        let validation_result = self.providers.validate_config(&imported_config).await?;
        if !validation_result.valid {
            return Err(invalid_config_error(
                "Invalid imported config",
                &validation_result,
            ));
        }

        // Imports replace the whole document. Keep the exact previous file
        // recoverable before a cloud apply or an explicit backup restore.
        let previous_content = fs::read_to_string(&self.config_file).await.map_err(|e| {
            OpenBitFunError::config(format!("Failed to read config before import backup: {e}"))
        })?;
        self.backup_raw_config(&previous_content, "pre-import")
            .await?;

        self.commit_candidate(
            ConfigCandidate {
                config: imported_config,
                guard_sources: imported_sources,
                diagnostics: diagnostics.clone(),
            },
            None,
        )
        .await?;
        self.load_diagnostics = diagnostics;

        info!("Successfully imported configuration");
        Ok(())
    }

    /// Creates a configuration backup.
    pub async fn create_backup(&self) -> OpenBitFunResult<PathBuf> {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_dir = self.config_dir.join("backups");

        if !backup_dir.exists() {
            fs::create_dir_all(&backup_dir).await.map_err(|e| {
                OpenBitFunError::config(format!("Failed to create backup directory: {}", e))
            })?;
        }

        let backup_file = backup_dir.join(format!(
            "config_backup_{}_{}.json",
            timestamp,
            uuid::Uuid::new_v4().simple()
        ));

        let content = serde_json::to_string_pretty(&self.persistence_value(&self.config)?)
            .map_err(|e| OpenBitFunError::config(format!("Failed to serialize backup: {}", e)))?;

        JsonFileStore
            .write_text_atomic_create_new(&backup_file, &content)
            .await
            .map_err(|e| OpenBitFunError::config(format!("Failed to write backup: {}", e)))?;

        info!("Created config backup: {:?}", backup_file);
        Ok(backup_file)
    }

    /// Registers a configuration provider.
    pub fn register_provider(&mut self, provider: Box<dyn ConfigProvider>) {
        self.providers.register(provider);
    }

    /// Returns configuration statistics.
    pub fn get_statistics(&self) -> ConfigStatistics {
        ConfigStatistics {
            total_ai_models: self.config.ai.models.len(),
            has_default_model: self.config.ai.default_models.primary.is_some(),
            config_directory: self.config_dir.clone(),
            providers_count: self.providers.get_provider_names().len(),
            last_modified: self.config.last_modified,
        }
    }

    /// Gets a configuration value by dot-path.
    fn get_value_by_path(&self, path: &str) -> OpenBitFunResult<serde_json::Value> {
        self.get_value_by_path_from_config(&self.config, path)
    }

    /// Gets a configuration value by dot-path from the given config.
    fn get_value_by_path_from_config(
        &self,
        config: &GlobalConfig,
        path: &str,
    ) -> OpenBitFunResult<serde_json::Value> {
        let config_value = serde_json::to_value(config)
            .map_err(|e| OpenBitFunError::config(format!("Failed to serialize config: {}", e)))?;

        if path.is_empty() {
            return Ok(config_value);
        }

        let keys: Vec<&str> = path.split('.').collect();
        let mut current = &config_value;

        for key in keys {
            current = current.get(key).ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Config path '{}' not found", path))
            })?;
        }

        Ok(current.clone())
    }

    /// Builds a candidate configuration without changing the committed value.
    fn config_with_value(
        &self,
        path: &str,
        value: serde_json::Value,
    ) -> OpenBitFunResult<ConfigCandidate> {
        if path.is_empty() {
            return self.parse_candidate(value);
        }

        let mut config_value = serde_json::to_value(&self.config)
            .map_err(|e| OpenBitFunError::config(format!("Failed to serialize config: {}", e)))?;

        let keys: Vec<&str> = path.split('.').filter(|k| !k.is_empty()).collect();
        if keys.is_empty() {
            return self.parse_candidate(value);
        }

        let last_key = keys.last().ok_or_else(|| {
            OpenBitFunError::config(format!("Config path '{}' does not contain any keys", path))
        })?;
        let parent_keys = &keys[..keys.len() - 1];

        let mut current = &mut config_value;
        for key in parent_keys {
            current = current.get_mut(key).ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Config path '{}' not found", path))
            })?;
        }

        if let Some(obj) = current.as_object_mut() {
            obj.insert(last_key.to_string(), value);
        } else {
            return Err(OpenBitFunError::config(format!(
                "Cannot set value at path '{}': parent is not an object",
                path
            )));
        }

        self.parse_candidate(config_value)
    }

    fn parse_candidate(&self, mut value: Value) -> OpenBitFunResult<ConfigCandidate> {
        let mut sources = self.account_guard_sources.clone();
        sources.extend(account_guard_sources(&value));
        let diagnostics = restore_account_models(&mut value);
        let config = serde_json::from_value(value).map_err(|e| {
            OpenBitFunError::config(format!("Failed to deserialize updated config: {e}"))
        })?;
        Ok(ConfigCandidate {
            config,
            guard_sources: sources,
            diagnostics,
        })
    }

    /// Notifies about a configuration change.
    async fn notify_config_changed(
        &self,
        path: &str,
        old_config: &GlobalConfig,
    ) -> OpenBitFunResult<()> {
        self.check_and_broadcast_app_change(path).await;
        self.check_and_broadcast_log_level_change(old_config).await;
        self.check_and_broadcast_sensitive_diagnostics_change(old_config)
            .await;

        self.providers
            .notify_config_changed(path, old_config, &self.config)
            .await
    }

    /// Detects and broadcasts app-scope configuration changes.
    async fn check_and_broadcast_app_change(&self, path: &str) {
        if path == "app" || path.starts_with("app.") {
            use super::global::{ConfigUpdateEvent, GlobalConfigManager};
            GlobalConfigManager::broadcast_update(ConfigUpdateEvent::AppUpdated).await;
        }
    }

    /// Detects and broadcasts runtime log-level changes.
    async fn check_and_broadcast_log_level_change(&self, old_config: &GlobalConfig) {
        let old_level = old_config.app.logging.level.trim().to_lowercase();
        let new_level = self.config.app.logging.level.trim().to_lowercase();

        if old_level != new_level {
            debug!(
                "App logging level change detected: {} -> {}",
                old_level, new_level
            );

            use super::global::{ConfigUpdateEvent, GlobalConfigManager};
            GlobalConfigManager::broadcast_update(ConfigUpdateEvent::LogLevelUpdated { new_level })
                .await;
        }
    }

    /// Detects and broadcasts runtime sensitive diagnostics changes.
    async fn check_and_broadcast_sensitive_diagnostics_change(&self, old_config: &GlobalConfig) {
        let old_include = old_config.app.logging.include_sensitive_diagnostics;
        let new_include = self.config.app.logging.include_sensitive_diagnostics;

        if old_include != new_include {
            debug!(
                "App logging sensitive diagnostics preference changed: {} -> {}",
                old_include, new_include
            );

            #[cfg(feature = "ai-adapter-runtime")]
            {
                openbitfun_ai_adapters::diagnostics::set_include_sensitive_diagnostics(new_include);
            }

            use super::global::{ConfigUpdateEvent, GlobalConfigManager};
            GlobalConfigManager::broadcast_update(
                ConfigUpdateEvent::LoggingSensitiveDiagnosticsUpdated {
                    include_sensitive_diagnostics: new_include,
                },
            )
            .await;
        }
    }
}

/// Configuration statistics.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigStatistics {
    pub total_ai_models: usize,
    pub has_default_model: bool,
    pub config_directory: PathBuf,
    pub providers_count: usize,
    pub last_modified: chrono::DateTime<chrono::Utc>,
}

#[cfg(test)]
mod tests {
    use super::{
        config_value_for_persistence, validate_current_config_value, ConfigManager,
        ConfigManagerSettings, INSTALLER_MODEL_ID,
    };
    use crate::infrastructure::PathManager;
    use crate::service::config::types::GlobalConfig;
    use openbitfun_core_types::installer_config_handoff::{
        InstallerConfigHandoff, InstallerModelHandoff, INSTALLER_CONFIG_HANDOFF_FILE_NAME,
    };
    use std::sync::Arc;

    fn manager_settings(path_manager: Arc<PathManager>) -> ConfigManagerSettings {
        ConfigManagerSettings {
            path_manager: Some(path_manager),
            auto_save: true,
            backup_count: 5,
        }
    }

    fn complete_installer_handoff() -> InstallerConfigHandoff {
        InstallerConfigHandoff {
            language: Some("en-US".to_string()),
            appearance_selection: Some("openbitfun-light".to_string()),
            model: Some(InstallerModelHandoff {
                name: "Installer model".to_string(),
                provider: "openai".to_string(),
                model_name: "fixture-model".to_string(),
                base_url: "https://example.com/v1".to_string(),
                request_url: "https://example.com/v1/chat/completions".to_string(),
                api_key: "fixture-secret".to_string(),
                custom_headers: None,
                custom_headers_mode: None,
                skip_ssl_verify: false,
                custom_request_body: None,
            }),
            ..InstallerConfigHandoff::default()
        }
    }

    #[test]
    fn user_question_timeout_default_is_readable_but_not_persisted() {
        let mut config = GlobalConfig::default();
        assert_eq!(
            serde_json::to_value(&config).unwrap()["ai"]["user_question_timeout_secs"],
            180
        );
        assert!(config_value_for_persistence(&config).unwrap()["ai"]
            .get("user_question_timeout_secs")
            .is_none());
        for timeout in [None, Some(0), Some(60), Some(180)] {
            config.ai.user_question_timeout_secs = timeout;
            let persisted = config_value_for_persistence(&config).unwrap();
            assert_eq!(
                persisted["ai"].get("user_question_timeout_secs").is_none(),
                timeout == Some(180)
            );
            let restored: GlobalConfig = serde_json::from_value(persisted).unwrap();
            assert_eq!(restored.ai.user_question_timeout_secs, timeout);
        }
    }

    #[test]
    fn current_config_contract_requires_openbitfun_identity_and_format() {
        let current = serde_json::to_value(GlobalConfig::default()).unwrap();
        validate_current_config_value(&current, "test config").unwrap();

        for (field, value, expected) in [
            (
                "product_id",
                serde_json::json!("other-product"),
                "product_id",
            ),
            ("schema_version", serde_json::json!(0), "schema_version"),
        ] {
            let mut invalid = current.clone();
            invalid[field] = value;
            let error = validate_current_config_value(&invalid, "test config").unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[test]
    fn current_config_contract_rejects_missing_identity_metadata() {
        let current = serde_json::to_value(GlobalConfig::default()).unwrap();
        for field in ["product_id", "schema_version", "version", "last_modified"] {
            let mut invalid = current.clone();
            invalid.as_object_mut().unwrap().remove(field);
            let error = validate_current_config_value(&invalid, "test config").unwrap_err();
            assert!(error.to_string().contains(field), "{error}");
        }
    }

    #[test]
    fn application_version_is_informational_metadata() {
        let mut current = serde_json::to_value(GlobalConfig::default()).unwrap();
        current["version"] = serde_json::json!("1.0.0-beta.1");
        validate_current_config_value(&current, "test config").unwrap();
    }

    #[tokio::test]
    async fn installer_handoff_is_applied_idempotently() {
        let temp = tempfile::tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("handoff"),
        ));
        path_manager.initialize_user_directories().await.unwrap();
        let handoff_path = path_manager
            .user_config_dir()
            .join(INSTALLER_CONFIG_HANDOFF_FILE_NAME);
        let handoff = complete_installer_handoff();

        for _ in 0..2 {
            tokio::fs::write(&handoff_path, serde_json::to_vec(&handoff).unwrap())
                .await
                .unwrap();
            let manager = ConfigManager::new(manager_settings(path_manager.clone()))
                .await
                .unwrap();
            assert_eq!(manager.config.app.language, "en-US");
            assert_eq!(manager.config.appearance.selection, "openbitfun-light");
            assert_eq!(
                manager
                    .config
                    .ai
                    .models
                    .iter()
                    .filter(|model| model.id == INSTALLER_MODEL_ID)
                    .count(),
                1
            );
            assert!(!handoff_path.exists());
        }
    }

    #[tokio::test]
    async fn account_pool_edits_advance_on_disk_and_reject_stale_writes() {
        use openbitfun_config_contracts::{
            AIModelConfig, AuthConfig, ModelCapability, SubscriptionProvider,
        };
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("pool"),
        ));
        let mut manager = ConfigManager::new(manager_settings(paths.clone()))
            .await
            .unwrap();
        let pool = AIModelConfig {
            id: "pool-model".into(),
            name: "Codex pool".into(),
            provider: "responses".into(),
            model_name: "fixture-model".into(),
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            enabled: true,
            capabilities: vec![ModelCapability::TextChat],
            auth: AuthConfig::SubscriptionPool {
                provider: SubscriptionProvider::Codex,
                accounts: vec!["codex".into(), "backup".into()],
                revision: 0,
            },
            ..Default::default()
        };
        manager.set("ai.models", vec![pool.clone()]).await.unwrap();
        let original_export = manager.export_config().unwrap();
        let mut edited = pool.clone();
        if let AuthConfig::SubscriptionPool { accounts, .. } = &mut edited.auth {
            accounts.reverse();
        }
        manager
            .set("ai.models", vec![edited.clone()])
            .await
            .unwrap();
        assert!(matches!(
            manager.get_config().ai.models[0].auth,
            AuthConfig::SubscriptionPool { revision: 1, .. }
        ));
        let mut restored = ConfigManager::new(manager_settings(paths)).await.unwrap();
        assert!(matches!(
            restored.get_config().ai.models[0].auth,
            AuthConfig::SubscriptionPool { revision: 1, .. }
        ));
        let before = tokio::fs::read(&restored.config_file).await.unwrap();
        assert!(restored
            .set("ai.models", vec![pool])
            .await
            .unwrap_err()
            .to_string()
            .contains("SUBSCRIPTION_ACCOUNT_POOL_CONFLICT"));
        assert_eq!(
            tokio::fs::read(&restored.config_file).await.unwrap(),
            before
        );
        if let AuthConfig::SubscriptionPool { revision, .. } = &mut edited.auth {
            *revision = 1;
        }
        if let AuthConfig::SubscriptionPool { accounts, .. } = &mut edited.auth {
            accounts.push("third".into());
        }
        restored.set("ai.models", vec![edited]).await.unwrap();
        assert!(matches!(
            restored.get_config().ai.models[0].auth,
            AuthConfig::SubscriptionPool { revision: 2, .. }
        ));
        restored.import_config(original_export).await.unwrap();
        assert!(
            matches!(&restored.get_config().ai.models[0].auth, AuthConfig::SubscriptionPool { accounts, revision: 3, .. } if accounts == &vec!["codex".to_string(), "backup".to_string()])
        );
        let backup = restored.create_backup().await.unwrap();
        let serialized: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(backup).await.unwrap()).unwrap();
        assert_eq!(
            serialized["ai"]["models"][0]["metadata"]["openbitfun_subscription_account_binding"]
                ["model"]["auth"]["revision"],
            3
        );
    }

    #[tokio::test]
    async fn account_guard_survives_restart_export_import_and_legacy_settings_writes() {
        use openbitfun_config_contracts::protected_account_models::{
            ACCOUNT_MODEL_GUARD_KEY, ACCOUNT_MODEL_GUARD_URL,
        };
        use openbitfun_config_contracts::{
            AIModelConfig, AuthConfig, ModelCapability, SubscriptionProvider,
        };
        let temp = tempfile::tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("guard"),
        ));
        let mut manager = ConfigManager::new(manager_settings(path_manager.clone()))
            .await
            .unwrap();
        let named = AIModelConfig {
            id: "protected-model".into(),
            name: "Protected model".into(),
            provider: "responses".into(),
            model_name: "fixture-model".into(),
            base_url: "https://chatgpt.com/backend-api/codex".into(),
            enabled: true,
            capabilities: vec![ModelCapability::TextChat],
            auth: AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: Some("codex-account-58134808-15a6-45db-ae33-2ad7d85cc570".into()),
            },
            ..AIModelConfig::default()
        };
        let mut config = manager.config.clone();
        config.ai.models = vec![named.clone()];
        config.ai.default_models.primary = Some(named.id.clone());
        manager
            .commit_config(config, Some("ai.models"))
            .await
            .unwrap();
        let file = path_manager.app_config_file();
        let persisted: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&file).await.unwrap()).unwrap();
        assert_eq!(
            persisted["ai"]["models"][0]["base_url"],
            ACCOUNT_MODEL_GUARD_URL
        );
        let legacy: GlobalConfig = serde_json::from_value(persisted).unwrap();
        assert!(matches!(legacy.ai.models[0].auth, AuthConfig::ApiKey));
        assert!(legacy.ai.models[0].enabled);
        // The legacy struct's opaque metadata preserves the nested source, even
        // while an unrelated settings write reserializes the entire document.
        let mut legacy_value = serde_json::to_value(legacy).unwrap();
        legacy_value["app"]["auto_update"] = serde_json::json!(false);
        let guard = &mut legacy_value["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY];
        guard["future_envelope_field"] = serde_json::json!({"keep":true});
        guard["model"]["future_model_option"] = serde_json::json!({"keep":42});
        guard["model"]["auth"]["plan"] = serde_json::Value::Null;
        guard["model"]["auth"]["future_auth_hint"] = serde_json::json!("keep");
        tokio::fs::write(&file, serde_json::to_vec(&legacy_value).unwrap())
            .await
            .unwrap();
        let before_read = tokio::fs::read(&file).await.unwrap();
        let mut loaded = ConfigManager::new(manager_settings(path_manager.clone()))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&loaded.config.ai.models[0]).unwrap(),
            serde_json::to_value(&named).unwrap()
        );
        assert_eq!(
            loaded.config.ai.default_models.primary.as_deref(),
            Some(named.id.as_str())
        );
        assert!(!loaded.config.app.auto_update);
        assert_eq!(tokio::fs::read(&file).await.unwrap(), before_read);
        loaded.set("app.auto_update", true).await.unwrap();
        let exported = loaded.export_config().unwrap();
        let guard = &exported["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY];
        assert_eq!(
            guard["future_envelope_field"],
            serde_json::json!({"keep":true})
        );
        assert_eq!(
            guard["model"]["future_model_option"],
            serde_json::json!({"keep":42})
        );
        assert_eq!(guard["model"]["auth"]["future_auth_hint"], "keep");
        loaded
            .set("ai.models", exported["ai"]["models"].clone())
            .await
            .unwrap();
        assert_eq!(loaded.config.ai.models[0].auth, named.auth);
        loaded.import_config(exported).await.unwrap();
        assert_eq!(loaded.config.ai.models[0].auth, named.auth);
        let backup = loaded.create_backup().await.unwrap();
        let backed_up: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(backup).await.unwrap()).unwrap();
        assert_eq!(
            backed_up["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]
                ["future_envelope_field"],
            serde_json::json!({"keep":true})
        );
        // A failed candidate must not leak either its account selection or its
        // opaque source fields into a later, otherwise unrelated save.
        let mut rejected = loaded.export_config().unwrap()["ai"]["models"].clone();
        let source = &mut rejected[0]["metadata"][ACCOUNT_MODEL_GUARD_KEY];
        source["model"]["auth"]["account_id"] =
            serde_json::json!("codex-account-28134808-15a6-45db-ae33-2ad7d85cc570");
        source["future_envelope_field"] = serde_json::json!({"keep":false});
        let blocked_path = temp.path().join("blocked-config");
        tokio::fs::create_dir(&blocked_path).await.unwrap();
        loaded.config_file = blocked_path;
        assert!(loaded.set("ai.models", rejected).await.is_err());
        loaded.config_file = file.clone();
        assert_eq!(loaded.config.ai.models[0].auth, named.auth);
        loaded.set("editor.font_size", 18).await.unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(file).await.unwrap()).unwrap();
        assert_eq!(
            saved["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["future_envelope_field"],
            serde_json::json!({"keep":true})
        );
    }

    #[tokio::test]
    async fn existing_config_recovers_semantics_without_rewriting_source() {
        let temp = tempfile::tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("recovery"),
        ));
        path_manager.initialize_user_directories().await.unwrap();
        let mut config = GlobalConfig::default();
        config.ai.stream_idle_timeout_secs = Some(0);
        config.ai.default_models.primary = Some("missing".into());
        config.ai.agent_model_defaults.subagents.default_selection =
            super::super::types::SubagentModelSelection::fixed("missing-model");
        config.app.logging.level = "invalid".into();
        config.ai.models.push(super::super::types::AIModelConfig {
            id: "broken".into(),
            name: "Broken".into(),
            provider: "openai".into(),
            enabled: true,
            context_window: Some(1),
            api_key: "retained-secret".into(),
            ..Default::default()
        });
        let original = serde_json::to_vec(&config).unwrap();
        tokio::fs::write(path_manager.app_config_file(), &original)
            .await
            .unwrap();
        let manager = ConfigManager::new(manager_settings(path_manager.clone()))
            .await
            .unwrap();
        assert!(!manager.config.ai.models[0].enabled);
        assert_eq!(manager.config.ai.models[0].api_key, "retained-secret");
        assert!(
            manager
                .providers
                .validate_config(&manager.config)
                .await
                .unwrap()
                .valid
        );
        assert!(!manager.load_diagnostics.is_empty());
        let migrated_bytes = tokio::fs::read(path_manager.app_config_file())
            .await
            .unwrap();
        let mut persisted: serde_json::Value = serde_json::from_slice(&migrated_bytes).unwrap();
        let selection = persisted["ai"]
            .as_object_mut()
            .unwrap()
            .remove("agent_model_selections")
            .unwrap();
        assert_eq!(
            selection["subagents"]["default"],
            serde_json::json!({"kind":"model", "model_ref":"missing-model"})
        );
        assert_eq!(
            persisted,
            serde_json::from_slice::<serde_json::Value>(&original).unwrap()
        );
        ConfigManager::new(manager_settings(path_manager.clone()))
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(path_manager.app_config_file())
                .await
                .unwrap(),
            migrated_bytes
        );
    }

    #[tokio::test]
    async fn config_ingestion_migrates_legacy_selections_before_publishing() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("ingestion"),
        ));
        let mut manager = ConfigManager::new(manager_settings(paths.clone()))
            .await
            .unwrap();
        for entry in ["import", "root", "ai"] {
            let mut legacy = GlobalConfig::default();
            legacy.ai.agent_model_defaults.mode = "fast".into();
            let document = serde_json::to_value(&legacy).unwrap();
            match entry {
                "import" => manager.import_config(document).await.unwrap(),
                "root" => manager.set("", document).await.unwrap(),
                _ => manager.set("ai", document["ai"].clone()).await.unwrap(),
            }
            assert_eq!(manager.config.ai.mode_model_reference().unwrap(), "fast");
            let disk: GlobalConfig =
                serde_json::from_slice(&tokio::fs::read(paths.app_config_file()).await.unwrap())
                    .unwrap();
            assert_eq!(disk.ai.mode_model_reference().unwrap(), "fast");
            assert_eq!(disk.ai.agent_model_defaults.mode, "fast");

            // Presence, including invalid data, remains authoritative at every boundary.
            let mut invalid = serde_json::to_value(&legacy).unwrap();
            invalid["ai"]["agent_model_selections"] = serde_json::Value::Null;
            match entry {
                "import" => manager.import_config(invalid).await.unwrap(),
                "root" => manager.set("", invalid).await.unwrap(),
                _ => manager.set("ai", invalid["ai"].clone()).await.unwrap(),
            }
            assert_eq!(
                manager.config.ai.agent_model_selections,
                Some(serde_json::Value::Null)
            );
            assert!(manager.config.ai.effective_model_selections().is_err());
        }
    }

    #[tokio::test]
    async fn fresh_and_reset_configs_persist_typed_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("defaults"),
        ));
        let mut manager = ConfigManager::new(manager_settings(paths.clone()))
            .await
            .unwrap();
        for reset in [None, Some("ai"), Some("ai.agent_model_selections")] {
            let disk: GlobalConfig =
                serde_json::from_slice(&tokio::fs::read(paths.app_config_file()).await.unwrap())
                    .unwrap();
            assert_eq!(
                disk.ai.effective_model_selections().unwrap(),
                Default::default()
            );
            manager
                .set(
                    "ai.agent_model_selections.subagents.builtin",
                    serde_json::json!({}),
                )
                .await
                .unwrap();
            manager.reset(reset).await.unwrap();
            assert_eq!(
                manager.config.ai.effective_model_selections().unwrap(),
                Default::default()
            );
        }
        let disk: GlobalConfig =
            serde_json::from_slice(&tokio::fs::read(paths.app_config_file()).await.unwrap())
                .unwrap();
        assert_eq!(
            disk.ai.effective_model_selections().unwrap(),
            Default::default()
        );
    }

    #[tokio::test]
    async fn ordinary_save_does_not_migrate_uninitialized_selections() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("no-migration"),
        ));
        let mut manager = ConfigManager::new(manager_settings(paths.clone()))
            .await
            .unwrap();
        // Simulate an internal initialization bug: reads must fail until an ingestion
        // boundary repairs it; unrelated writes must not silently convert old defaults.
        manager.config.ai.agent_model_selections = None;
        manager.set("app.language", "en-US").await.unwrap();
        assert!(manager.config.ai.agent_model_selections.is_none());
        let disk: GlobalConfig =
            serde_json::from_slice(&tokio::fs::read(paths.app_config_file()).await.unwrap())
                .unwrap();
        assert!(disk.ai.agent_model_selections.is_none());
        assert!(disk.ai.effective_model_selections().is_err());
    }

    #[tokio::test]
    async fn present_invalid_selections_survive_load_and_unrelated_save() {
        let temp = tempfile::tempdir().unwrap();
        let paths = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("invalid-selections"),
        ));
        paths.initialize_user_directories().await.unwrap();
        for invalid in [
            serde_json::json!(null),
            serde_json::json!({"mode":{"kind":"future"}}),
        ] {
            let mut document = serde_json::to_value(GlobalConfig::default()).unwrap();
            document["ai"]["agent_model_selections"] = invalid.clone();
            let original = serde_json::to_vec(&document).unwrap();
            tokio::fs::write(paths.app_config_file(), &original)
                .await
                .unwrap();
            let mut manager = ConfigManager::new(manager_settings(paths.clone()))
                .await
                .unwrap();
            assert!(manager.config.ai.effective_model_selections().is_err());
            assert_eq!(
                tokio::fs::read(paths.app_config_file()).await.unwrap(),
                original
            );
            manager.set("app.language", "en-US").await.unwrap();
            let saved: serde_json::Value =
                serde_json::from_slice(&tokio::fs::read(paths.app_config_file()).await.unwrap())
                    .unwrap();
            assert_eq!(saved["ai"]["agent_model_selections"], invalid);
            assert!(manager
                .reset(Some("ai.agent_model_defaults.mode"))
                .await
                .is_err());
            manager
                .reset(Some("ai.agent_model_selections"))
                .await
                .unwrap();
            assert!(manager.config.ai.effective_model_selections().is_ok());
        }
    }

    #[tokio::test]
    async fn sparse_installer_config_is_backed_up_and_repaired() {
        let temp = tempfile::tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("repair"),
        ));
        path_manager.initialize_user_directories().await.unwrap();
        let original = r#"{
  "app": { "language": "en-US" },
  "themes": { "current": "openbitfun-midnight" }
}"#;
        tokio::fs::write(path_manager.app_config_file(), original)
            .await
            .unwrap();

        let manager = ConfigManager::new(manager_settings(path_manager.clone()))
            .await
            .unwrap();
        assert_eq!(manager.config.app.language, "en-US");
        assert_eq!(manager.config.appearance.selection, "openbitfun-midnight");
        let persisted: GlobalConfig = serde_json::from_slice(
            &tokio::fs::read(path_manager.app_config_file())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            persisted.ai.effective_model_selections().unwrap(),
            Default::default()
        );
        assert_eq!(
            manager.config.schema_version,
            super::CURRENT_CONFIG_SCHEMA_VERSION
        );

        let mut backups = tokio::fs::read_dir(path_manager.user_config_dir().join("backups"))
            .await
            .unwrap();
        let backup = backups.next_entry().await.unwrap().unwrap().path();
        assert_eq!(tokio::fs::read_to_string(backup).await.unwrap(), original);
    }

    #[test]
    fn persistence_omits_default_memories_config() {
        let config = GlobalConfig::default();
        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        assert!(value.get("memories").is_none());
        assert!(value["ai"].get("agent_models").is_none());
        assert!(value["ai"].get("allow_tool_json_repair").is_none());
        assert!(value["ai"].get("max_rounds").is_none());
        assert!(value["ai"].get("task_models").is_none());
    }

    #[test]
    fn persistence_keeps_explicit_max_rounds() {
        let mut config = GlobalConfig::default();
        config.ai.max_rounds = 37;

        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        assert_eq!(value["ai"].get("max_rounds"), Some(&serde_json::json!(37)));
    }

    #[test]
    fn persistence_keeps_only_non_default_task_model_fields() {
        let mut config = GlobalConfig::default();
        config.ai.task_models.session_title =
            crate::service::config::types::TaskModelSelection::Inherit;

        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        assert_eq!(
            value["ai"].get("task_models"),
            Some(&serde_json::json!({
                "session_title": { "kind": "inherit" }
            }))
        );
    }

    #[test]
    fn persistence_keeps_disabled_tool_argument_json_repair() {
        let mut config = GlobalConfig::default();
        config.ai.allow_tool_json_repair = false;

        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        assert_eq!(
            value["ai"].get("allow_tool_json_repair"),
            Some(&serde_json::json!(false))
        );
    }

    #[test]
    fn persistence_keeps_only_non_default_memories_fields() {
        let mut config = GlobalConfig::default();
        config.memories.generate_memories = false;
        config.memories.generate_for_btw_sessions = true;
        config.memories.max_rollouts_per_startup = 12;

        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        let memories = value
            .get("memories")
            .and_then(|value| value.as_object())
            .expect("memories config should persist as an object");
        assert!(!memories.contains_key("generate_memories"));
        assert_eq!(
            value.get("memories"),
            Some(&serde_json::json!({
                "generate_for_btw_sessions": true,
                "max_rollouts_per_startup": 12
            }))
        );
    }

    #[test]
    fn persistence_omits_default_web_search_config_and_restores_defaults() {
        let config = GlobalConfig::default();
        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        assert!(value["ai"].get("web_search").is_none());

        let restored: GlobalConfig =
            serde_json::from_value(value).expect("default-sparse config should deserialize");
        assert_eq!(restored.ai.web_search, config.ai.web_search);
    }

    #[test]
    fn persistence_keeps_only_non_default_web_search_fields_and_unknown_extensions() {
        let mut config = GlobalConfig::default();
        let web_search = &mut config.ai.web_search;
        web_search.provider = "openbitfun_search_http".to_string();
        web_search
            .unknown
            .insert("selectionRevision".to_string(), serde_json::json!(7));
        web_search.providers.unknown.insert(
            "future_search".to_string(),
            serde_json::json!({ "endpoint": "https://future.example/search" }),
        );
        let http = &mut web_search.providers.openbitfun_search_http;
        http.endpoint = "https://search.example.com/search".to_string();
        http.auth.mode = "header".to_string();
        http.auth.header_name = "X-Search-Key".to_string();
        http.unknown
            .insert("futureHttpOption".to_string(), serde_json::json!(true));

        let value =
            config_value_for_persistence(&config).expect("config should serialize for persistence");

        assert_eq!(
            value["ai"].get("web_search"),
            Some(&serde_json::json!({
                "provider": "openbitfun_search_http",
                "providers": {
                    "openbitfun_search_http": {
                        "endpoint": "https://search.example.com/search",
                        "auth": {
                            "mode": "header",
                            "headerName": "X-Search-Key"
                        },
                        "futureHttpOption": true
                    },
                    "future_search": {
                        "endpoint": "https://future.example/search"
                    }
                },
                "selectionRevision": 7
            }))
        );

        let restored: GlobalConfig =
            serde_json::from_value(value).expect("sparse config should deserialize");
        assert_eq!(restored.ai.web_search, config.ai.web_search);
    }
}

fn validate_agent_model_selections(
    ai: &super::types::AIConfig,
    selections: &openbitfun_config_contracts::model_pool::AgentModelSelections,
    previous: Option<&openbitfun_config_contracts::model_pool::AgentModelSelections>,
) -> OpenBitFunResult<()> {
    use openbitfun_config_contracts::model_pool::AgentModelSelection;
    use openbitfun_core_types::model_pool::ModelSelection;
    let validate = |selection: &AgentModelSelection| -> OpenBitFunResult<()> {
        match selection {
            AgentModelSelection::Model { model_ref } => {
                let resolved = ai.resolve_model_selection(model_ref);
                if !resolved.as_ref().is_some_and(|id| {
                    ai.models.iter().any(|model| {
                        &model.id == id
                            && model.enabled
                            && model.supports_capability(super::types::ModelCapability::TextChat)
                    })
                }) {
                    return Err(OpenBitFunError::validation(format!(
                        "Unavailable text-chat model: {model_ref}"
                    )));
                }
            }
            AgentModelSelection::Pool { pool_id } => {
                let pool = ai
                    .model_pools
                    .get(pool_id)
                    .map_err(OpenBitFunError::validation)?;
                if pool.member_model_ids.is_empty() {
                    return Err(OpenBitFunError::validation(
                        "Cannot select an empty model pool",
                    ));
                }
            }
            AgentModelSelection::Inherit => {}
        }
        Ok(())
    };
    if previous.is_none_or(|old| old.mode != selections.mode) {
        validate(&match &selections.mode {
            ModelSelection::Model { model_ref } => AgentModelSelection::Model {
                model_ref: model_ref.clone(),
            },
            ModelSelection::Pool { pool_id } => AgentModelSelection::Pool {
                pool_id: pool_id.clone(),
            },
        })?;
    }
    if previous.is_none_or(|old| old.subagents.default != selections.subagents.default) {
        validate(&selections.subagents.default)?;
    }
    if previous.is_none_or(|old| old.subagents.fork != selections.subagents.fork) {
        validate(&selections.subagents.fork)?;
    }
    for (id, value) in &selections.subagents.builtin {
        if previous.is_none_or(|old| old.subagents.builtin.get(id) != Some(value)) {
            validate(value)?;
        }
    }
    Ok(())
}
