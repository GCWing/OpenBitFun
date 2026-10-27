//! Configuration provider implementations
//!
//! Providers for different configuration sections, responsible for defaults, validation,
//! and change handling.

use super::types::*;
#[cfg(feature = "ai-adapter-runtime")]
use crate::infrastructure::ai::reasoning_catalog::{
    load_models_dev_reasoning_catalog_without_refresh, project_model_reasoning_catalog,
};
#[cfg(feature = "ai-adapter-runtime")]
use crate::infrastructure::ai::AIClient;
use crate::util::errors::*;
use async_trait::async_trait;
use log::{error, info};
#[cfg(any(feature = "ai-adapter-runtime", test))]
use openbitfun_core_types::ReasoningCatalogBinding;
#[cfg(test)]
use openbitfun_core_types::{ReasoningConfig, ReasoningPreset, ReasoningPresetAction};
use std::collections::HashMap;

fn serialize_default_config(section: &str, value: impl serde::Serialize) -> serde_json::Value {
    match serde_json::to_value(value) {
        Ok(serialized) => serialized,
        Err(err) => {
            error!(
                "Failed to serialize default config section: section={}, error={}",
                section, err
            );
            serde_json::Value::Object(serde_json::Map::new())
        }
    }
}

/// AI configuration provider.
pub struct AIConfigProvider;

fn ai_validation_error_location(message: &str) -> (String, String) {
    let model_field = if message.contains("Model name is required") {
        Some(("name", "MODEL_NAME_INVALID"))
    } else if message.contains("Model provider is required") {
        Some(("provider", "MODEL_PROVIDER_INVALID"))
    } else if message.contains("context_window") {
        Some(("context_window", "MODEL_CONTEXT_WINDOW_INVALID"))
    } else if message.contains("max_tokens") {
        Some(("max_tokens", "MODEL_MAX_TOKENS_INVALID"))
    } else if message.contains("max_images_per_request") {
        Some(("max_images_per_request", "MODEL_MAX_IMAGES_INVALID"))
    } else if message.contains("temperature") {
        Some(("temperature", "MODEL_TEMPERATURE_INVALID"))
    } else if message.contains("top_p") {
        Some(("top_p", "MODEL_TOP_P_INVALID"))
    } else if message.contains("reasoning config") {
        Some(("reasoning", "MODEL_REASONING_INVALID"))
    } else if message.contains("reasoning default preset") {
        Some((
            "reasoning.default_preset",
            "MODEL_REASONING_DEFAULT_INVALID",
        ))
    } else if message.contains("reasoning target") {
        Some(("reasoning", "MODEL_REASONING_TARGET_INVALID"))
    } else if message.contains("reasoning preset") {
        Some(("reasoning.presets", "MODEL_REASONING_PRESET_INVALID"))
    } else {
        None
    };

    if let Some((field, code)) = model_field {
        if let Some(index) = message
            .rsplit_once(" at index ")
            .and_then(|(_, suffix)| suffix.split(':').next())
            .and_then(|value| value.parse::<usize>().ok())
        {
            return (format!("ai.models[{index}].{field}"), code.to_string());
        }
    }

    if message.contains("stream_idle_timeout_secs") {
        return (
            "ai.stream_idle_timeout_secs".to_string(),
            "AI_STREAM_IDLE_TIMEOUT_INVALID".to_string(),
        );
    }
    if message.contains("stream_ttft_timeout_secs") {
        return (
            "ai.stream_ttft_timeout_secs".to_string(),
            "AI_STREAM_TTFT_TIMEOUT_INVALID".to_string(),
        );
    }
    if message.contains("session-title task model") {
        return (
            "ai.task_models.session_title".to_string(),
            "TASK_MODEL_INVALID".to_string(),
        );
    }
    if message.contains("Git commit task model") {
        return (
            "ai.task_models.git_commit".to_string(),
            "TASK_MODEL_INVALID".to_string(),
        );
    }
    for field in [
        "primary",
        "fast",
        "search",
        "image_understanding",
        "image_generation",
        "speech_recognition",
    ] {
        if message.contains(&format!("default_models.{field}")) {
            return (
                format!("ai.default_models.{field}"),
                "DEFAULT_MODEL_INVALID".to_string(),
            );
        }
    }
    if message.contains("agent_model_defaults") {
        return (
            "ai.agent_model_defaults".to_string(),
            "AGENT_MODEL_DEFAULT_INVALID".to_string(),
        );
    }

    ("ai".to_string(), "VALIDATION_ERROR".to_string())
}

fn ai_validation_warning_location(config: &GlobalConfig, message: &str) -> String {
    let Some(model_name) = message
        .strip_prefix("Model '")
        .and_then(|value| value.split_once("' has empty API key"))
        .map(|(name, _)| name)
    else {
        return "ai".to_string();
    };
    config
        .ai
        .models
        .iter()
        .position(|model| model.name == model_name)
        .map(|index| format!("ai.models[{index}].api_key"))
        .unwrap_or_else(|| "ai".to_string())
}

#[async_trait]
impl ConfigProvider for AIConfigProvider {
    fn name(&self) -> &str {
        "ai"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("ai", AIConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let mut warnings = Vec::new();

        if let Ok(ai_config) = serde_json::from_value::<AIConfig>(config.clone()) {
            #[cfg(feature = "ai-adapter-runtime")]
            let models_dev = if ai_config.models.iter().any(|model| {
                model.reasoning.as_ref().is_some_and(|reasoning| {
                    !matches!(reasoning.catalog, ReasoningCatalogBinding::Disabled)
                })
            }) {
                Some(load_models_dev_reasoning_catalog_without_refresh().await)
            } else {
                None
            };

            if let Some(stream_idle_timeout_secs) = ai_config.stream_idle_timeout_secs {
                if stream_idle_timeout_secs == 0 {
                    return Err(OpenBitFunError::validation(
                        "AI stream_idle_timeout_secs must be greater than 0".to_string(),
                    ));
                }
            }

            if let Some(stream_ttft_timeout_secs) = ai_config.stream_ttft_timeout_secs {
                if stream_ttft_timeout_secs == 0 {
                    return Err(OpenBitFunError::validation(
                        "AI stream_ttft_timeout_secs must be greater than 0".to_string(),
                    ));
                }
            }

            for (index, model) in ai_config.models.iter().enumerate() {
                openbitfun_config_contracts::normalization::validate_model_config(model, index)
                    .map_err(OpenBitFunError::validation)?;
                if !model.enabled {
                    continue;
                }
                if model.api_key.trim().is_empty() {
                    warnings.push(format!("Model '{}' has empty API key", model.name));
                }
                if model.supports_text_generation() {
                    if let Some(temperature) = model.temperature {
                        if !temperature.is_nan() && !(0.0..=2.0).contains(&temperature) {
                            warnings.push(format!(
                                "Model '{}' temperature should be between 0 and 2",
                                model.name
                            ));
                        }
                    }
                }
                #[cfg(feature = "ai-adapter-runtime")]
                if let Some(reasoning) = model.reasoning.as_ref() {
                    #[cfg(feature = "ai-adapter-runtime")]
                    if let Some(default_preset) = reasoning.default_preset.as_deref() {
                        #[cfg(feature = "ai-adapter-runtime")]
                        {
                            let projection = project_model_reasoning_catalog(
                                model,
                                models_dev
                                    .as_ref()
                                    .and_then(|snapshot| snapshot.catalog.as_deref()),
                            );
                            if projection.default_preset.as_deref() != Some(default_preset) {
                                return Err(OpenBitFunError::validation(format!(
                                    "Model '{}' reasoning default preset '{}' is not available at index {}",
                                    model.name, default_preset, index
                                )));
                            }
                        }
                    }

                    #[cfg(feature = "ai-adapter-runtime")]
                    {
                        let runtime_config = <crate::util::types::AIConfig as TryFrom<
                            AIModelConfig,
                        >>::try_from(model.clone())
                        .map_err(|message| {
                            OpenBitFunError::validation(format!(
                                "Model '{}' reasoning target is invalid at index {}: {}",
                                model.name, index, message
                            ))
                        })?;
                        let client = AIClient::new(runtime_config);
                        let projection = project_model_reasoning_catalog(
                            model,
                            models_dev
                                .as_ref()
                                .and_then(|snapshot| snapshot.catalog.as_deref()),
                        );
                        for preset in reasoning
                            .presets
                            .iter()
                            .filter(|preset| !preset.disabled && !preset.actions.is_empty())
                        {
                            let preset_id = preset.id.trim();
                            let descriptor = projection
                                .presets
                                .iter()
                                .find(|descriptor| descriptor.id == preset_id)
                                .ok_or_else(|| {
                                    OpenBitFunError::validation(format!(
                                        "Model '{}' reasoning preset '{}' is not available at index {}",
                                        model.name, preset_id, index
                                    ))
                                })?;
                            client.validate_reasoning_preset(descriptor).map_err(|error| {
                                OpenBitFunError::validation(format!(
                                    "Model '{}' reasoning preset '{}' is unsupported at index {}: {}",
                                    model.name, preset_id, index, error
                                ))
                            })?;
                        }
                    }
                }
            }

            let enabled_model_with_capability = |model_id: &str, capability: ModelCapability| {
                ai_config.models.iter().any(|model| {
                    model.enabled
                        && model.id == model_id
                        && model.supports_capability(capability.clone())
                })
            };
            for (field, model_id, capability) in [
                (
                    "primary",
                    ai_config.default_models.primary.as_deref(),
                    ModelCapability::TextChat,
                ),
                (
                    "fast",
                    ai_config.default_models.fast.as_deref(),
                    ModelCapability::TextChat,
                ),
                (
                    "search",
                    ai_config.default_models.search.as_deref(),
                    ModelCapability::Search,
                ),
                (
                    "image_understanding",
                    ai_config.default_models.image_understanding.as_deref(),
                    ModelCapability::ImageUnderstanding,
                ),
                (
                    "image_generation",
                    ai_config.default_models.image_generation.as_deref(),
                    ModelCapability::ImageGeneration,
                ),
                (
                    "speech_recognition",
                    ai_config.default_models.speech_recognition.as_deref(),
                    ModelCapability::SpeechRecognition,
                ),
            ] {
                if model_id.is_some_and(|model_id| {
                    !enabled_model_with_capability(model_id, capability.clone())
                }) {
                    return Err(OpenBitFunError::validation(format!(
                        "ai.default_models.{field} references unavailable or incapable model '{}'",
                        model_id.expect("checked above")
                    )));
                }
            }

            let valid_task_model = |model_id: &str| {
                matches!(model_id, "primary" | "fast")
                    || enabled_model_with_capability(model_id, ModelCapability::TextChat)
            };
            if let Some(model_id) = ai_config.task_models.session_title.fixed_model_id() {
                if !valid_task_model(model_id) {
                    return Err(OpenBitFunError::validation(format!(
                        "The session-title task model '{}' does not exist",
                        model_id
                    )));
                }
            }
            match &ai_config.task_models.git_commit {
                crate::service::config::types::TaskModelSelection::Inherit => {
                    return Err(OpenBitFunError::validation(
                        "The Git commit task model cannot inherit a session model".to_string(),
                    ));
                }
                crate::service::config::types::TaskModelSelection::Fixed { model_id }
                    if !valid_task_model(model_id) =>
                {
                    return Err(OpenBitFunError::validation(format!(
                        "The Git commit task model '{}' does not exist",
                        model_id
                    )));
                }
                crate::service::config::types::TaskModelSelection::Fixed { .. } => {}
            }

            if ai_config.agent_model_selections.is_none() {
                let validate_agent_selection = |path: &str,
                                                selection: &SubagentModelSelection|
                 -> OpenBitFunResult<()> {
                    if selection
                        .fixed_model_id()
                        .is_some_and(|model_id| !valid_task_model(model_id))
                    {
                        return Err(OpenBitFunError::validation(format!(
                            "ai.agent_model_defaults.{path} references unavailable or incapable model '{}'",
                            selection.fixed_model_id().expect("checked above")
                        )));
                    }
                    Ok(())
                };
                if !valid_task_model(&ai_config.agent_model_defaults.mode) {
                    return Err(OpenBitFunError::validation(format!(
                    "ai.agent_model_defaults.mode references unavailable or incapable model '{}'",
                    ai_config.agent_model_defaults.mode
                )));
                }
                validate_agent_selection(
                    "subagents.default",
                    &ai_config.agent_model_defaults.subagents.default_selection,
                )?;
                validate_agent_selection(
                    "subagents.fork",
                    &ai_config.agent_model_defaults.subagents.fork,
                )?;
                for (subagent_id, selection) in &ai_config.agent_model_defaults.subagents.builtin {
                    validate_agent_selection(
                        &format!("subagents.builtin.{subagent_id}"),
                        selection,
                    )?;
                }
            }
        } else {
            return Err(OpenBitFunError::validation(
                "Invalid AI config format".to_string(),
            ));
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(ai_config) = serde_json::from_value::<AIConfig>(new_config.clone()) {
            info!(
                "AI config changed: {} models configured",
                ai_config.models.len()
            );
            if let Some(text_chat_model) = ai_config.default_models.primary {
                info!("Primary model: {}", text_chat_model);
            }
            if let Some(fast_model) = ai_config.default_models.fast {
                info!("Fast model: {}", fast_model);
            }
        }
        Ok(())
    }
}

/// Web UI appearance selection provider.
pub struct AppearanceConfigProvider;

#[async_trait]
impl ConfigProvider for AppearanceConfigProvider {
    fn name(&self) -> &str {
        "appearance"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("appearance", AppearanceConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let warnings = Vec::new();

        if let Ok(appearance_config) = serde_json::from_value::<AppearanceConfig>(config.clone()) {
            if appearance_config.selection.trim().is_empty() {
                return Err(OpenBitFunError::validation(
                    "Appearance selection must not be empty".to_string(),
                ));
            }
        } else {
            return Err(OpenBitFunError::validation(
                "Invalid appearance config format".to_string(),
            ));
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(appearance_config) =
            serde_json::from_value::<AppearanceConfig>(new_config.clone())
        {
            info!(
                "Appearance config changed: selection = {}",
                appearance_config.selection
            );
        }
        Ok(())
    }
}

/// Editor configuration provider.
pub struct EditorConfigProvider;

#[async_trait]
impl ConfigProvider for EditorConfigProvider {
    fn name(&self) -> &str {
        "editor"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("editor", EditorConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let mut warnings = Vec::new();

        if let Ok(editor_config) = serde_json::from_value::<EditorConfig>(config.clone()) {
            if editor_config.font_size < 8 || editor_config.font_size > 72 {
                warnings.push("Font size should be between 8 and 72".to_string());
            }

            if editor_config.tab_size < 1 || editor_config.tab_size > 8 {
                warnings.push("Tab size should be between 1 and 8".to_string());
            }

            if editor_config.line_height < 1.0 || editor_config.line_height > 3.0 {
                warnings.push("Line height should be between 1.0 and 3.0".to_string());
            }
        } else {
            return Err(OpenBitFunError::validation(
                "Invalid editor config format".to_string(),
            ));
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(editor_config) = serde_json::from_value::<EditorConfig>(new_config.clone()) {
            info!(
                "Editor config changed: font_size={}",
                editor_config.font_size
            );
        }
        Ok(())
    }
}

/// Terminal configuration provider.
pub struct TerminalConfigProvider;

#[async_trait]
impl ConfigProvider for TerminalConfigProvider {
    fn name(&self) -> &str {
        "terminal"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("terminal", TerminalConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let mut warnings = Vec::new();

        if let Ok(terminal_config) = serde_json::from_value::<TerminalConfig>(config.clone()) {
            if terminal_config.font_size < 8 || terminal_config.font_size > 72 {
                warnings.push("Terminal font size should be between 8 and 72".to_string());
            }

            if terminal_config.scrollback > 100000 {
                warnings.push("Large scrollback buffer may impact performance".to_string());
            }

            if terminal_config.terminal_panel_position != "right"
                && terminal_config.terminal_panel_position != "bottom"
            {
                warnings.push(
                    "Terminal panel position should be either 'right' or 'bottom'".to_string(),
                );
            }
        } else {
            return Err(OpenBitFunError::validation(
                "Invalid terminal config format".to_string(),
            ));
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(terminal_config) = serde_json::from_value::<TerminalConfig>(new_config.clone()) {
            info!(
                "Terminal config changed: shell={}, font_size={}",
                terminal_config.default_shell, terminal_config.font_size
            );
        }
        Ok(())
    }
}

/// Workspace configuration provider.
pub struct WorkspaceConfigProvider;

#[async_trait]
impl ConfigProvider for WorkspaceConfigProvider {
    fn name(&self) -> &str {
        "workspace"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("workspace", WorkspaceConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let mut warnings = Vec::new();

        if let Ok(workspace_config) = serde_json::from_value::<WorkspaceConfig>(config.clone()) {
            if workspace_config.max_file_size > 1024 * 1024 * 1024 {
                warnings.push("Very large max file size may impact performance".to_string());
            }

            if workspace_config.exclude_patterns.is_empty() {
                warnings
                    .push("No exclude patterns defined, may scan unnecessary files".to_string());
            }
        } else {
            return Err(OpenBitFunError::validation(
                "Invalid workspace config format".to_string(),
            ));
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(workspace_config) = serde_json::from_value::<WorkspaceConfig>(new_config.clone())
        {
            info!(
                "Workspace config changed: {} exclude patterns",
                workspace_config.exclude_patterns.len()
            );
        }
        Ok(())
    }
}

/// App configuration provider.
pub struct AppConfigProvider;

#[async_trait]
impl ConfigProvider for AppConfigProvider {
    fn name(&self) -> &str {
        "app"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("app", AppConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let mut warnings = Vec::new();

        if let Ok(app_config) = serde_json::from_value::<AppConfig>(config.clone()) {
            if app_config.zoom_level < 0.5 || app_config.zoom_level > 3.0 {
                warnings.push("Zoom level should be between 0.5 and 3.0".to_string());
            }

            if app_config.sidebar.width < 200 || app_config.sidebar.width > 800 {
                warnings.push("Sidebar width should be between 200 and 800 pixels".to_string());
            }

            let valid_log_level = matches!(
                app_config.logging.level.to_lowercase().as_str(),
                "trace" | "debug" | "info" | "warn" | "error" | "off"
            );
            if !valid_log_level {
                return Err(OpenBitFunError::validation(format!(
                    "Invalid app.logging.level '{}': expected one of trace/debug/info/warn/error/off",
                    app_config.logging.level
                )));
            }
        } else {
            return Err(OpenBitFunError::validation(
                "Invalid app config format".to_string(),
            ));
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(app_config) = serde_json::from_value::<AppConfig>(new_config.clone()) {
            info!(
                "App config changed: language={}, zoom_level={}, log_level={}",
                app_config.language, app_config.zoom_level, app_config.logging.level
            );
        }
        Ok(())
    }
}

/// Media (image generation) service configuration provider.
pub struct MediaConfigProvider;

#[async_trait]
impl ConfigProvider for MediaConfigProvider {
    fn name(&self) -> &str {
        "media"
    }

    fn get_default_config(&self) -> serde_json::Value {
        serialize_default_config("media", MediaConfig::default())
    }

    async fn validate_config(&self, config: &serde_json::Value) -> OpenBitFunResult<Vec<String>> {
        let media = match serde_json::from_value::<MediaConfig>(config.clone()) {
            Ok(media) => media,
            Err(err) => {
                return Err(OpenBitFunError::validation(format!(
                    "Invalid media config format: {}",
                    err
                )))
            }
        };

        let mut warnings = Vec::new();
        for (index, service) in media.image_services.iter().enumerate() {
            if service.id.trim().is_empty() {
                return Err(OpenBitFunError::validation(format!(
                    "media.image_services[{index}]: service id is required"
                )));
            }
            if !service.enabled {
                continue;
            }
            // The subscription dialect discovers its model from the account's
            // catalog, so an empty field there is a supported choice.
            if service.model_name.trim().is_empty() && !service.dialect.requires_subscription() {
                warnings.push(format!(
                    "media.image_services[{index}]: model name is empty"
                ));
            }
            if service.base_url.trim().is_empty()
                && service.request_url.is_none()
                && !matches!(service.auth, AuthConfig::Subscription { .. })
            {
                warnings.push(format!("media.image_services[{index}]: base url is empty"));
            }
            let max_images = service.dialect.max_images_per_request();
            if let Some(n) = service.params.n {
                if n == 0 || n > max_images {
                    warnings.push(format!(
                        "media.image_services[{index}]: n must be between 1 and {max_images}"
                    ));
                }
            }
        }

        if let Some(default_id) = media.default_image_service.as_deref() {
            if media.enabled_image_service(default_id).is_none() {
                warnings.push(format!(
                    "media.default_image_service: '{default_id}' is not an enabled image service"
                ));
            }
        }

        Ok(warnings)
    }

    async fn on_config_changed(
        &self,
        _old_config: &serde_json::Value,
        new_config: &serde_json::Value,
    ) -> OpenBitFunResult<()> {
        if let Ok(media) = serde_json::from_value::<MediaConfig>(new_config.clone()) {
            info!(
                "Media config changed: image_services={}, default_image_service={:?}",
                media.image_services.len(),
                media.default_image_service
            );
        }
        Ok(())
    }
}

/// Configuration provider registry.
pub struct ConfigProviderRegistry {
    providers: HashMap<String, Box<dyn ConfigProvider>>,
}

impl ConfigProviderRegistry {
    /// Creates the default provider registry.
    pub fn new() -> Self {
        let mut registry = Self {
            providers: HashMap::new(),
        };

        registry.register(Box::new(AIConfigProvider));
        registry.register(Box::new(AppearanceConfigProvider));
        registry.register(Box::new(EditorConfigProvider));
        registry.register(Box::new(TerminalConfigProvider));
        registry.register(Box::new(WorkspaceConfigProvider));
        registry.register(Box::new(AppConfigProvider));
        registry.register(Box::new(MediaConfigProvider));

        registry
    }

    /// Registers a configuration provider.
    pub fn register(&mut self, provider: Box<dyn ConfigProvider>) {
        let name = provider.name().to_string();
        self.providers.insert(name, provider);
    }

    /// Gets a provider by name.
    pub fn get_provider(&self, name: &str) -> Option<&dyn ConfigProvider> {
        self.providers.get(name).map(Box::as_ref)
    }

    /// Returns all provider names.
    pub fn get_provider_names(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// Builds the default configuration.
    pub fn get_default_config(&self) -> GlobalConfig {
        GlobalConfig::default()
    }

    /// Validates the full configuration.
    pub async fn validate_config(
        &self,
        config: &GlobalConfig,
    ) -> OpenBitFunResult<ConfigValidationResult> {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        for provider_name in [
            "ai",
            "appearance",
            "editor",
            "terminal",
            "workspace",
            "app",
            "media",
        ] {
            let Some(provider) = self.get_provider(provider_name) else {
                continue;
            };
            let section_value = self.get_config_section(provider_name, config)?;
            match provider.validate_config(&section_value).await {
                Ok(provider_warnings) => {
                    warnings.extend(provider_warnings.into_iter().map(|msg| {
                        ConfigValidationWarning {
                            path: if provider_name == "ai" {
                                ai_validation_warning_location(config, &msg)
                            } else {
                                provider_name.to_string()
                            },
                            message: msg,
                            code: "VALIDATION_WARNING".to_string(),
                            severity: "warning".to_string(),
                        }
                    }))
                }
                Err(e) => {
                    let message = e.to_string();
                    let (path, code) = if provider_name == "ai" {
                        ai_validation_error_location(&message)
                    } else {
                        (provider_name.to_string(), "VALIDATION_ERROR".to_string())
                    };
                    errors.push(ConfigValidationError {
                        path,
                        message,
                        code,
                        severity: "error".to_string(),
                    });
                }
            }
        }

        Ok(ConfigValidationResult {
            valid: errors.is_empty(),
            diagnostics: errors
                .iter()
                .map(|error| ConfigDiagnostic {
                    path: error.path.clone(),
                    message: error.message.clone(),
                    code: error.code.clone(),
                    severity: ConfigDiagnosticSeverity::Error,
                    recoverability: ConfigDiagnosticRecoverability::None,
                })
                .chain(warnings.iter().map(|warning| ConfigDiagnostic {
                    path: warning.path.clone(),
                    message: warning.message.clone(),
                    code: warning.code.clone(),
                    severity: ConfigDiagnosticSeverity::Warning,
                    recoverability: ConfigDiagnosticRecoverability::None,
                }))
                .collect(),
            errors,
            warnings,
        })
    }

    /// Notifies providers of a configuration change.
    pub async fn notify_config_changed(
        &self,
        path: &str,
        old_config: &GlobalConfig,
        new_config: &GlobalConfig,
    ) -> OpenBitFunResult<()> {
        let provider_name = path.split('.').next().unwrap_or(path);

        if let Some(provider) = self.get_provider(provider_name) {
            let old_value = self.get_config_section(provider_name, old_config)?;
            let new_value = self.get_config_section(provider_name, new_config)?;

            provider.on_config_changed(&old_value, &new_value).await?;
        }

        Ok(())
    }

    /// Gets a specific configuration section.
    fn get_config_section(
        &self,
        section: &str,
        config: &GlobalConfig,
    ) -> OpenBitFunResult<serde_json::Value> {
        match section {
            "app" => Ok(serde_json::to_value(&config.app)?),
            "appearance" => Ok(serde_json::to_value(&config.appearance)?),
            "editor" => Ok(serde_json::to_value(&config.editor)?),
            "terminal" => Ok(serde_json::to_value(&config.terminal)?),
            "workspace" => Ok(serde_json::to_value(&config.workspace)?),
            "ai" => Ok(serde_json::to_value(&config.ai)?),
            "media" => Ok(serde_json::to_value(&config.media)?),
            _ => Err(OpenBitFunError::validation(format!(
                "Unknown config section: {}",
                section
            ))),
        }
    }
}

impl Default for ConfigProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_with_reasoning(reasoning: ReasoningConfig) -> AIModelConfig {
        AIModelConfig {
            id: "reasoning-model".to_string(),
            name: "Reasoning model".to_string(),
            provider: "responses".to_string(),
            model_name: "gpt-5.4".to_string(),
            base_url: "https://api.openai.com/v1/responses".to_string(),
            enabled: true,
            reasoning: Some(reasoning),
            ..AIModelConfig::default()
        }
    }

    async fn validate_reasoning(reasoning: ReasoningConfig) -> OpenBitFunResult<Vec<String>> {
        let mut config = AIConfig::default();
        config.models.push(model_with_reasoning(reasoning));
        AIConfigProvider
            .validate_config(&serde_json::to_value(config)?)
            .await
    }

    #[tokio::test]
    async fn rejects_a_model_context_window_smaller_than_32k() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            name: "Test model".to_string(),
            provider: "openai".to_string(),
            context_window: Some(MIN_MODEL_CONTEXT_WINDOW_TOKENS - 1),
            enabled: true,
            ..AIModelConfig::default()
        });
        let value = serde_json::to_value(config).expect("AI config should serialize");

        let error = AIConfigProvider
            .validate_config(&value)
            .await
            .expect_err("small context windows must be rejected");

        assert!(error
            .to_string()
            .contains("context_window must be at least 32000"));
    }

    #[tokio::test]
    async fn rejects_generation_fields_on_pure_speech_models() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            name: "Qwen ASR".to_string(),
            provider: "openai".to_string(),
            enabled: true,
            category: ModelCategory::SpeechRecognition,
            capabilities: vec![ModelCapability::SpeechRecognition],
            context_window: Some(0),
            max_tokens: Some(0),
            ..AIModelConfig::default()
        });

        let error = AIConfigProvider
            .validate_config(&serde_json::to_value(config).unwrap())
            .await
            .expect_err("current configs must not carry inapplicable generation fields");
        assert!(error.to_string().contains("context_window"), "{error}");
    }

    #[tokio::test]
    async fn mixed_text_and_speech_models_still_require_a_valid_context_window() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            name: "Mixed model".to_string(),
            provider: "openai".to_string(),
            enabled: true,
            capabilities: vec![
                ModelCapability::TextChat,
                ModelCapability::SpeechRecognition,
            ],
            context_window: Some(0),
            ..AIModelConfig::default()
        });

        let error = AIConfigProvider
            .validate_config(&serde_json::to_value(config).unwrap())
            .await
            .expect_err("text-capable models must retain generation validation");
        assert!(error
            .to_string()
            .contains("context_window must be at least"));
    }

    #[tokio::test]
    async fn registry_reports_precise_model_validation_paths_and_codes() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            id: "broken".to_string(),
            name: "Broken model".to_string(),
            provider: "openai".to_string(),
            enabled: true,
            context_window: Some(0),
            ..AIModelConfig::default()
        });

        let result = ConfigProviderRegistry::new()
            .validate_config(&GlobalConfig {
                ai: config,
                ..GlobalConfig::default()
            })
            .await
            .expect("validation result");

        assert_eq!(result.errors[0].path, "ai.models[0].context_window");
        assert_eq!(result.errors[0].code, "MODEL_CONTEXT_WINDOW_INVALID");
        assert_eq!(result.diagnostics[0].path, "ai.models[0].context_window");
    }

    #[tokio::test]
    async fn registry_reports_image_budget_validation_path() {
        let mut config = GlobalConfig::default();
        config.ai.models.push(AIModelConfig {
            id: "limited".into(),
            name: "Limited vision".into(),
            provider: "openai".into(),
            enabled: true,
            max_images_per_request: Some(0),
            ..AIModelConfig::default()
        });
        let result = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .unwrap();
        assert_eq!(result.errors[0].path, "ai.models[0].max_images_per_request");
        assert_eq!(result.errors[0].code, "MODEL_MAX_IMAGES_INVALID");
    }

    #[tokio::test]
    async fn rejects_default_and_agent_references_to_incapable_models() {
        let mut config = AIConfig::default();
        config.models.push(AIModelConfig {
            id: "speech".to_string(),
            name: "Speech".to_string(),
            provider: "openai".to_string(),
            enabled: true,
            category: ModelCategory::SpeechRecognition,
            capabilities: vec![ModelCapability::SpeechRecognition],
            ..AIModelConfig::default()
        });
        config.default_models.primary = Some("speech".to_string());

        let error = AIConfigProvider
            .validate_config(&serde_json::to_value(&config).unwrap())
            .await
            .expect_err("primary must reference an enabled text model");
        assert!(error.to_string().contains("default_models.primary"));

        config.default_models.primary = None;
        config.agent_model_defaults.mode = "speech".to_string();
        let error = AIConfigProvider
            .validate_config(&serde_json::to_value(config).unwrap())
            .await
            .expect_err("agent defaults must reference an enabled text model");
        assert!(error.to_string().contains("agent_model_defaults.mode"));
    }

    #[tokio::test]
    async fn rejects_invalid_canonical_reasoning_actions() {
        for (action, expected) in [
            (
                ReasoningPresetAction::BudgetTokens { value: 0 },
                "budget_tokens value must be greater than 0",
            ),
            (
                ReasoningPresetAction::RequestPatch {
                    body: serde_json::json!(["invalid"]),
                },
                "request_patch body must be a JSON object",
            ),
        ] {
            let error = validate_reasoning(ReasoningConfig {
                default_preset: Some("custom".to_string()),
                presets: vec![ReasoningPreset {
                    id: "custom".to_string(),
                    actions: vec![action],
                    ..ReasoningPreset::default()
                }],
                ..ReasoningConfig::default()
            })
            .await
            .expect_err("invalid reasoning schema must be rejected");

            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[cfg(feature = "ai-adapter-runtime")]
    #[tokio::test]
    async fn rejects_reasoning_actions_unsupported_by_the_configured_target() {
        let error = validate_reasoning(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Disabled,
            default_preset: Some("on".to_string()),
            presets: vec![ReasoningPreset {
                id: "on".to_string(),
                actions: vec![ReasoningPresetAction::Toggle { enabled: true }],
                ..ReasoningPreset::default()
            }],
        })
        .await
        .expect_err("Responses must reject a generic toggle action");

        assert!(error.to_string().contains("unsupported"), "{error}");
    }

    #[tokio::test]
    async fn rejects_duplicate_and_unavailable_default_presets() {
        let duplicate = validate_reasoning(ReasoningConfig {
            presets: vec![
                ReasoningPreset {
                    id: "same".to_string(),
                    actions: vec![ReasoningPresetAction::Toggle { enabled: true }],
                    ..ReasoningPreset::default()
                },
                ReasoningPreset {
                    id: "same".to_string(),
                    actions: vec![ReasoningPresetAction::Toggle { enabled: false }],
                    ..ReasoningPreset::default()
                },
            ],
            ..ReasoningConfig::default()
        })
        .await
        .expect_err("duplicate preset IDs must be rejected");
        assert!(duplicate.to_string().contains("duplicate preset ID 'same'"));

        let unavailable = validate_reasoning(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Disabled,
            default_preset: Some("missing".to_string()),
            ..ReasoningConfig::default()
        })
        .await
        .expect_err("missing default preset must be rejected");
        assert!(unavailable
            .to_string()
            .contains("default preset 'missing' is not available"));
    }

    #[cfg(feature = "ai-adapter-runtime")]
    #[tokio::test]
    async fn accepts_generated_models_dev_default_preset() {
        validate_reasoning(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Auto,
            default_preset: Some("high".to_string()),
            ..ReasoningConfig::default()
        })
        .await
        .expect("bundled models.dev preset should be valid");
    }

    #[tokio::test]
    async fn registry_runs_ai_validation() {
        let mut config = GlobalConfig::default();
        config.ai.models.push(model_with_reasoning(ReasoningConfig {
            presets: vec![ReasoningPreset {
                id: "bad".to_string(),
                actions: vec![ReasoningPresetAction::BudgetTokens { value: 0 }],
                ..ReasoningPreset::default()
            }],
            ..ReasoningConfig::default()
        }));

        let validation = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .expect("registry validation result");

        assert!(!validation.valid);
        assert_eq!(validation.errors[0].path, "ai.models[0].reasoning");
        assert!(validation.errors[0]
            .message
            .contains("budget_tokens value must be greater than 0"));
    }

    fn image_service(id: &str, enabled: bool) -> ImageServiceConfig {
        ImageServiceConfig {
            id: id.to_string(),
            name: id.to_string(),
            dialect: ImageDialect::OpenAiImages,
            base_url: "https://api.openai.com/v1".to_string(),
            model_name: "gpt-image-1".to_string(),
            api_key: "sk-test".to_string(),
            enabled,
            ..ImageServiceConfig::default()
        }
    }

    #[tokio::test]
    async fn media_validation_accepts_a_subscription_service_without_a_base_url() {
        let mut service = image_service("svc-a", true);
        service.base_url = String::new();
        service.api_key = String::new();
        service.auth = AuthConfig::Subscription {
            provider: SubscriptionProvider::Codex,
            plan: None,
            account_id: None,
        };
        let mut config = GlobalConfig::default();
        config.media.image_services.push(service);
        config.media.default_image_service = Some("svc-a".to_string());

        let validation = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .expect("registry validation result");

        assert!(validation.valid, "{:?}", validation.errors);
        assert!(validation.warnings.is_empty(), "{:?}", validation.warnings);
    }

    #[tokio::test]
    async fn media_validation_accepts_a_clean_section() {
        let mut config = GlobalConfig::default();
        config
            .media
            .image_services
            .push(image_service("svc-a", true));
        config.media.default_image_service = Some("svc-a".to_string());

        let validation = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .expect("registry validation result");

        assert!(validation.valid, "{:?}", validation.errors);
        assert!(validation.warnings.is_empty(), "{:?}", validation.warnings);
    }

    #[tokio::test]
    async fn media_validation_rejects_a_service_without_an_id() {
        let mut config = GlobalConfig::default();
        config.media.image_services.push(image_service("", true));

        let validation = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .expect("registry validation result");

        assert!(!validation.valid);
        assert_eq!(validation.errors[0].path, "media");
        assert!(validation.errors[0]
            .message
            .contains("service id is required"));
    }

    #[tokio::test]
    async fn media_validation_warns_on_a_dangling_default_pointer() {
        let mut config = GlobalConfig::default();
        config
            .media
            .image_services
            .push(image_service("svc-a", false));
        config.media.default_image_service = Some("missing".to_string());

        let validation = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .expect("registry validation result");

        assert!(validation.valid, "{:?}", validation.errors);
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.message.contains("default_image_service")));
    }

    #[tokio::test]
    async fn media_validation_warns_on_an_out_of_range_image_count() {
        let mut config = GlobalConfig::default();
        config.media.image_services.push(ImageServiceConfig {
            params: ImageGenerationParams {
                n: Some(MAX_IMAGES_PER_GENERATION_REQUEST + 1),
                ..ImageGenerationParams::default()
            },
            ..image_service("svc-a", true)
        });

        let validation = ConfigProviderRegistry::new()
            .validate_config(&config)
            .await
            .expect("registry validation result");

        assert!(validation.valid);
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.message.contains("n must be between")));
    }
}
