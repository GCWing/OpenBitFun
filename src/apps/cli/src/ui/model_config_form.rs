/// Model configuration form dialog
///
/// A multi-field input form for adding a new AI model configuration.
/// Supports Tab/Shift-Tab to navigate between fields, text input,
/// select fields (provider format), and toggle fields (booleans).
///
/// - Basic fields are always shown
/// - Default reasoning selects a catalog preset ID or Auto
/// - Ctrl+A toggles the Advanced Settings section which includes:
///   Skip SSL Verify, Custom Headers (JSON), Custom Headers Mode, Custom Request Body (JSON)
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use openbitfun_core_types::model::{ModelEditProjection, ModelMutation, SecretUpdate};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use openbitfun_core_types::ReasoningConfig;

use crate::ui::theme::{StyleKind, Theme};

/// Result of the model config form
#[derive(Debug, Clone)]
pub(crate) struct ModelFormResult {
    /// If set, this is an edit of an existing model (contains the model ID)
    pub editing_model_id: Option<String>,
    pub name: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    /// "openai" or "anthropic"
    pub provider_format: String,
    pub context_window: u32,
    pub max_tokens: u32,
    pub max_images_per_request: Option<usize>,
    pub reasoning_preset_options: Vec<String>,
    pub reasoning: Option<ReasoningConfig>,
    pub inline_think_in_text: bool,
    pub skip_ssl_verify: bool,
    /// JSON string for custom headers, empty if none
    pub custom_headers: String,
    /// "merge" or "replace"
    pub custom_headers_mode: String,
    /// JSON string for custom request body, empty if none
    pub custom_request_body: String,
}

fn reasoning_after_preset_selection(
    existing: Option<&ReasoningConfig>,
    initial_preset: Option<&str>,
    selected_preset: Option<&str>,
) -> Option<ReasoningConfig> {
    if selected_preset == initial_preset {
        return existing.cloned();
    }

    let mut reasoning = existing.cloned().unwrap_or_default();
    reasoning.default_preset = selected_preset.map(ToOwned::to_owned);
    Some(reasoning)
}

impl ModelFormResult {
    pub(crate) fn from_projection(projection: ModelEditProjection) -> Self {
        let model = projection.summary;
        Self {
            editing_model_id: Some(model.id),
            name: model.name,
            model_name: model.model_name,
            base_url: model.base_url,
            api_key: String::new(),
            provider_format: model.provider,
            context_window: model.context_window.unwrap_or(300_000),
            max_tokens: model.max_tokens.unwrap_or(8_192),
            max_images_per_request: model.max_images_per_request,
            reasoning_preset_options: projection.reasoning_preset_options,
            reasoning: projection.reasoning,
            inline_think_in_text: projection.inline_think_in_text,
            skip_ssl_verify: projection.skip_ssl_verify,
            custom_headers: String::new(),
            custom_headers_mode: projection.custom_headers_mode,
            custom_request_body: String::new(),
        }
    }

    pub(crate) fn to_mutation(&self, model_id: String) -> ModelMutation {
        let editing = self.editing_model_id.is_some();
        let required_secret = |value: &str| {
            if editing && value.is_empty() {
                SecretUpdate::Preserve
            } else {
                SecretUpdate::Replace(value.to_string())
            }
        };
        let optional_secret = |value: &str| {
            if value.is_empty() {
                if editing {
                    SecretUpdate::Preserve
                } else {
                    SecretUpdate::Clear
                }
            } else {
                SecretUpdate::Replace(value.to_string())
            }
        };
        ModelMutation {
            id: model_id,
            name: self.name.clone(),
            provider: self.provider_format.clone(),
            model_name: self.model_name.clone(),
            base_url: self.base_url.clone(),
            api_key: Some(required_secret(&self.api_key)),
            custom_headers: Some(optional_secret(&self.custom_headers)),
            custom_request_body: Some(optional_secret(&self.custom_request_body)),
            context_window: Some(self.context_window),
            max_tokens: Some(self.max_tokens),
            max_images_per_request: Some(self.max_images_per_request),
            enabled: true,
            reasoning: self.reasoning.clone(),
            inline_think_in_text: self.inline_think_in_text,
            skip_ssl_verify: self.skip_ssl_verify,
            custom_headers_mode: (!self.custom_headers_mode.is_empty())
                .then(|| self.custom_headers_mode.clone()),
        }
    }
}

/// Action returned by the form
#[derive(Debug, Clone)]
pub(crate) enum ModelFormAction {
    /// No action, key consumed
    None,
    /// User saved the form
    Save(ModelFormResult),
    /// User cancelled
    Cancel,
}

/// Which field is active
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormField {
    // ── Basic fields ──
    Name,
    ModelName,
    BaseUrl,
    ApiKey,
    ProviderFormat,
    ContextWindow,
    MaxTokens,
    MaxImagesPerRequest,
    DefaultReasoningPreset,
    // ── Advanced fields (Ctrl+A) ──
    SkipSslVerify,
    CustomHeaders,
    CustomHeadersMode,
    CustomRequestBody,
}

const PROVIDER_FORMATS: [&str; 2] = ["openai", "anthropic"];
const CUSTOM_HEADERS_MODES: [&str; 2] = ["merge", "replace"];

/// Model config form state
pub(super) struct ModelConfigFormState {
    visible: bool,

    // ── Field values ──
    name: String,
    model_name: String,
    base_url: String,
    api_key: String,
    provider_format_index: usize,
    context_window: String,
    max_tokens: String,
    max_images_per_request: String,
    reasoning_preset_options: Vec<String>,
    reasoning_preset_index: usize,
    initial_reasoning_preset: Option<String>,
    reasoning: Option<ReasoningConfig>,
    inline_think_in_text: bool,
    skip_ssl_verify: bool,
    custom_headers: String,
    custom_headers_mode_index: usize,
    custom_request_body: String,

    // ── UI state ──
    active_field: FormField,
    cursor: usize,
    scroll_offset: usize,
    visible_rows: usize,
    /// Whether the advanced settings section is expanded
    show_advanced: bool,

    /// Preset provider name (if from a template), shown in title
    provider_name: Option<String>,
    /// If editing an existing model, this holds the model ID
    editing_model_id: Option<String>,
}

impl ModelConfigFormState {
    pub(super) fn new() -> Self {
        Self {
            visible: false,
            name: String::new(),
            model_name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            provider_format_index: 0,
            context_window: "300000".into(),
            max_tokens: "8192".into(),
            max_images_per_request: String::new(),
            reasoning_preset_options: Vec::new(),
            reasoning_preset_index: 0,
            initial_reasoning_preset: None,
            reasoning: None,
            inline_think_in_text: true,
            skip_ssl_verify: false,
            custom_headers: String::new(),
            custom_headers_mode_index: 0, // "merge" by default
            custom_request_body: String::new(),
            active_field: FormField::Name,
            cursor: 0,
            scroll_offset: 0,
            visible_rows: 0,
            show_advanced: false,
            provider_name: None,
            editing_model_id: None,
        }
    }

    /// Show the form for a custom model (empty fields)
    pub(super) fn show_custom(&mut self) {
        self.visible = true;
        self.provider_name = None;
        self.editing_model_id = None;
        self.name.clear();
        self.model_name.clear();
        self.base_url = "https://".into();
        self.api_key.clear();
        self.provider_format_index = 0;
        self.context_window = "300000".into();
        self.max_tokens = "8192".into();
        self.max_images_per_request.clear();
        self.reasoning_preset_options.clear();
        self.reasoning_preset_index = 0;
        self.initial_reasoning_preset = None;
        self.reasoning = None;
        self.inline_think_in_text = true;
        self.skip_ssl_verify = false;
        self.custom_headers.clear();
        self.custom_headers_mode_index = 0; // "merge" by default
        self.custom_request_body.clear();
        self.active_field = FormField::Name;
        self.cursor = 0;
        self.scroll_offset = 0;
        self.show_advanced = false;
    }

    /// Show the form pre-filled from a provider template
    pub(super) fn show_from_provider(
        &mut self,
        provider_name: &str,
        base_url: &str,
        format: &str,
        default_model: &str,
    ) {
        self.visible = true;
        self.provider_name = Some(provider_name.to_string());
        self.editing_model_id = None;
        self.name = if default_model.is_empty() {
            String::new()
        } else {
            format!("{} - {}", provider_name, default_model)
        };
        self.model_name = default_model.to_string();
        self.base_url = base_url.to_string();
        self.api_key.clear();
        self.provider_format_index = PROVIDER_FORMATS
            .iter()
            .position(|&f| f == format)
            .unwrap_or(0);
        self.context_window = "300000".into();
        self.max_tokens = "8192".into();
        self.max_images_per_request.clear();
        self.reasoning_preset_options.clear();
        self.reasoning_preset_index = 0;
        self.initial_reasoning_preset = None;
        self.reasoning = None;
        self.inline_think_in_text = true;
        self.skip_ssl_verify = false;
        self.custom_headers.clear();
        self.custom_headers_mode_index = 0; // "merge" by default
        self.custom_request_body.clear();
        self.active_field = FormField::ApiKey;
        self.cursor = 0;
        self.scroll_offset = 0;
        self.show_advanced = false;
    }

    /// Show the form pre-filled for editing an existing model
    pub(super) fn show_for_edit(&mut self, model_id: &str, result: &ModelFormResult) {
        self.visible = true;
        self.editing_model_id = Some(model_id.to_string());
        self.provider_name = None;
        self.name = result.name.clone();
        self.model_name = result.model_name.clone();
        self.base_url = result.base_url.clone();
        self.api_key = result.api_key.clone();
        self.provider_format_index = PROVIDER_FORMATS
            .iter()
            .position(|&f| f == result.provider_format)
            .unwrap_or(0);
        self.context_window = result.context_window.to_string();
        self.max_tokens = result.max_tokens.to_string();
        self.max_images_per_request = result
            .max_images_per_request
            .map(|value| value.to_string())
            .unwrap_or_default();
        self.reasoning_preset_options = result.reasoning_preset_options.clone();
        let default_preset = result
            .reasoning
            .as_ref()
            .and_then(|reasoning| reasoning.default_preset.clone());
        self.reasoning_preset_index = default_preset
            .as_ref()
            .and_then(|preset| {
                self.reasoning_preset_options
                    .iter()
                    .position(|id| id == preset)
            })
            .map(|index| index + 1)
            .unwrap_or(0);
        self.initial_reasoning_preset = default_preset;
        self.reasoning = result.reasoning.clone();
        self.inline_think_in_text = result.inline_think_in_text;
        self.skip_ssl_verify = result.skip_ssl_verify;
        self.custom_headers = result.custom_headers.clone();
        self.custom_headers_mode_index = CUSTOM_HEADERS_MODES
            .iter()
            .position(|&m| m == result.custom_headers_mode)
            .unwrap_or(0);
        self.custom_request_body = result.custom_request_body.clone();
        self.active_field = FormField::Name;
        self.cursor = self.name.chars().count();
        self.scroll_offset = 0;
        // Auto-expand advanced if any advanced fields have non-default values
        self.show_advanced = self.skip_ssl_verify
            || !self.custom_headers.is_empty()
            || self.custom_headers_mode_index != 0
            || !self.custom_request_body.is_empty();
    }

    pub(super) fn hide(&mut self) {
        self.visible = false;
    }

    /// Reshow the model config form (for back navigation)
    pub(super) fn reshow(&mut self) {
        self.visible = true;
    }

    pub(super) fn is_visible(&self) -> bool {
        self.visible
    }

    // ── Dynamic field order ──

    /// Build the current field order based on toggle states.
    fn current_fields(&self) -> Vec<FormField> {
        let mut fields = vec![
            FormField::Name,
            FormField::ModelName,
            FormField::BaseUrl,
            FormField::ApiKey,
            FormField::ProviderFormat,
            FormField::ContextWindow,
            FormField::MaxTokens,
            FormField::MaxImagesPerRequest,
            FormField::DefaultReasoningPreset,
        ];
        if self.show_advanced {
            fields.push(FormField::SkipSslVerify);
            fields.push(FormField::CustomHeaders);
            fields.push(FormField::CustomHeadersMode);
            fields.push(FormField::CustomRequestBody);
        }
        fields
    }

    /// Build the list of display rows. Each field gets 2 rows (label + input),
    /// plus an extra separator row before the advanced section.
    fn display_rows(&self) -> Vec<DisplayRow> {
        let fields = self.current_fields();
        let mut rows = Vec::new();
        let mut advanced_header_shown = false;
        for &f in &fields {
            // Show the advanced separator before the first advanced field
            if !advanced_header_shown && self.is_advanced_field(f) {
                rows.push(DisplayRow::AdvancedHeader);
                advanced_header_shown = true;
            }
            rows.push(DisplayRow::Label(f));
            rows.push(DisplayRow::Input(f));
        }
        rows
    }

    fn is_advanced_field(&self, field: FormField) -> bool {
        matches!(
            field,
            FormField::SkipSslVerify
                | FormField::CustomHeaders
                | FormField::CustomHeadersMode
                | FormField::CustomRequestBody
        )
    }

    // ── Field buffer access ──

    fn active_buffer(&self) -> &str {
        match self.active_field {
            FormField::Name => &self.name,
            FormField::ModelName => &self.model_name,
            FormField::BaseUrl => &self.base_url,
            FormField::ApiKey => &self.api_key,
            FormField::ContextWindow => &self.context_window,
            FormField::MaxTokens => &self.max_tokens,
            FormField::MaxImagesPerRequest => &self.max_images_per_request,
            FormField::CustomHeaders => &self.custom_headers,
            FormField::CustomRequestBody => &self.custom_request_body,
            // Non-text fields
            FormField::ProviderFormat
            | FormField::CustomHeadersMode
            | FormField::DefaultReasoningPreset
            | FormField::SkipSslVerify => "",
        }
    }

    fn active_buffer_mut(&mut self) -> Option<&mut String> {
        match self.active_field {
            FormField::Name => Some(&mut self.name),
            FormField::ModelName => Some(&mut self.model_name),
            FormField::BaseUrl => Some(&mut self.base_url),
            FormField::ApiKey => Some(&mut self.api_key),
            FormField::ContextWindow => Some(&mut self.context_window),
            FormField::MaxTokens => Some(&mut self.max_tokens),
            FormField::MaxImagesPerRequest => Some(&mut self.max_images_per_request),
            FormField::CustomHeaders => Some(&mut self.custom_headers),
            FormField::CustomRequestBody => Some(&mut self.custom_request_body),
            _ => None,
        }
    }

    /// Is the active field a non-text field that uses special controls?
    fn is_non_text_field(&self) -> bool {
        matches!(
            self.active_field,
            FormField::ProviderFormat
                | FormField::CustomHeadersMode
                | FormField::DefaultReasoningPreset
                | FormField::SkipSslVerify
        )
    }

    /// Is the active field a boolean toggle?
    fn is_toggle_field(&self) -> bool {
        matches!(self.active_field, FormField::SkipSslVerify)
    }

    fn toggle_active_bool(&mut self) {
        match self.active_field {
            FormField::SkipSslVerify => {
                self.skip_ssl_verify = !self.skip_ssl_verify;
            }
            _ => {}
        }
    }

    // ── Navigation ──

    fn next_field(&mut self) {
        let fields = self.current_fields();
        let idx = fields
            .iter()
            .position(|f| *f == self.active_field)
            .unwrap_or(0);
        let next = (idx + 1).min(fields.len() - 1);
        self.active_field = fields[next];
        self.cursor = self.active_buffer().chars().count();
        self.ensure_field_visible();
    }

    fn prev_field(&mut self) {
        let fields = self.current_fields();
        let idx = fields
            .iter()
            .position(|f| *f == self.active_field)
            .unwrap_or(0);
        let prev = idx.saturating_sub(1);
        self.active_field = fields[prev];
        self.cursor = self.active_buffer().chars().count();
        self.ensure_field_visible();
    }

    fn ensure_field_visible(&mut self) {
        let rows = self.display_rows();
        // Find the Label row for the active field
        let label_row_idx = rows
            .iter()
            .position(|r| matches!(r, DisplayRow::Label(f) if *f == self.active_field))
            .unwrap_or(0);
        // Also ensure the Input row is visible (+1)
        let input_row_idx = (label_row_idx + 1).min(rows.len().saturating_sub(1));

        if label_row_idx < self.scroll_offset {
            self.scroll_offset = label_row_idx;
        } else if self.visible_rows > 0 && input_row_idx >= self.scroll_offset + self.visible_rows {
            self.scroll_offset = input_row_idx.saturating_sub(self.visible_rows - 1);
        }
    }

    // ── Validation ──

    fn validate(&self) -> Option<String> {
        if self.name.trim().is_empty() {
            return Some("Name is required".into());
        }
        if self.model_name.trim().is_empty() {
            return Some("Model name is required".into());
        }
        if self.base_url.trim().is_empty() {
            return Some("Base URL is required".into());
        }
        if self.editing_model_id.is_none() && self.api_key.trim().is_empty() {
            return Some("API Key is required".into());
        }
        if self.context_window.trim().parse::<u32>().is_err() {
            return Some("Context window must be a number".into());
        }
        if self.max_tokens.trim().parse::<u32>().is_err() {
            return Some("Max tokens must be a number".into());
        }
        if !self.max_images_per_request.trim().is_empty() {
            match self.max_images_per_request.trim().parse::<usize>() {
                Ok(0) => return Some("Max images per request must be greater than zero".into()),
                Ok(_) => {}
                Err(_) => return Some("Max images per request must be a positive number".into()),
            }
        }
        // Validate JSON fields if non-empty
        if !self.custom_headers.trim().is_empty()
            && serde_json::from_str::<serde_json::Value>(self.custom_headers.trim()).is_err()
        {
            return Some("Custom headers must be valid JSON".into());
        }
        if !self.custom_request_body.trim().is_empty()
            && serde_json::from_str::<serde_json::Value>(self.custom_request_body.trim()).is_err()
        {
            return Some("Custom request body must be valid JSON".into());
        }
        None
    }

    fn build_result(&self) -> ModelFormResult {
        let selected_reasoning_preset = self
            .reasoning_preset_index
            .checked_sub(1)
            .and_then(|index| self.reasoning_preset_options.get(index))
            .map(String::as_str);
        let reasoning = reasoning_after_preset_selection(
            self.reasoning.as_ref(),
            self.initial_reasoning_preset.as_deref(),
            selected_reasoning_preset,
        );

        ModelFormResult {
            editing_model_id: self.editing_model_id.clone(),
            name: self.name.trim().to_string(),
            model_name: self.model_name.trim().to_string(),
            base_url: self.base_url.trim().to_string(),
            api_key: self.api_key.trim().to_string(),
            provider_format: PROVIDER_FORMATS[self.provider_format_index].to_string(),
            context_window: self.context_window.trim().parse().unwrap_or(300_000),
            max_tokens: self.max_tokens.trim().parse().unwrap_or(8192),
            max_images_per_request: self.max_images_per_request.trim().parse().ok(),
            reasoning_preset_options: self.reasoning_preset_options.clone(),
            reasoning,
            inline_think_in_text: self.inline_think_in_text,
            skip_ssl_verify: self.skip_ssl_verify,
            custom_headers: self.custom_headers.trim().to_string(),
            custom_headers_mode: CUSTOM_HEADERS_MODES[self.custom_headers_mode_index].to_string(),
            custom_request_body: self.custom_request_body.trim().to_string(),
        }
    }

    // ── Key handling ──

    pub(super) fn handle_key_event(&mut self, key: KeyEvent) -> ModelFormAction {
        if !self.visible {
            return ModelFormAction::None;
        }

        match (key.code, key.modifiers) {
            (KeyCode::Esc, _) => {
                self.hide();
                ModelFormAction::Cancel
            }

            // Ctrl+S: save
            (KeyCode::Char('s'), KeyModifiers::CONTROL) => self.try_save(),

            // Ctrl+A: toggle advanced settings
            (KeyCode::Char('a'), KeyModifiers::CONTROL) => {
                self.show_advanced = !self.show_advanced;
                // If we were on an advanced field that's now hidden, move to a safe field
                if !self.show_advanced {
                    let fields = self.current_fields();
                    if !fields.contains(&self.active_field) {
                        self.active_field = *fields.last().unwrap_or(&FormField::Name);
                        self.cursor = self.active_buffer().chars().count();
                    }
                }
                ModelFormAction::None
            }

            // Tab: next field
            (KeyCode::Tab, KeyModifiers::NONE) => {
                self.next_field();
                ModelFormAction::None
            }

            // Shift-Tab: previous field
            (KeyCode::BackTab, _) => {
                self.prev_field();
                ModelFormAction::None
            }

            // Enter: toggle for boolean fields, next field for text, save on last
            (KeyCode::Enter, _) => {
                if self.is_toggle_field() {
                    self.toggle_active_bool();
                    ModelFormAction::None
                } else {
                    let fields = self.current_fields();
                    let idx = fields
                        .iter()
                        .position(|f| *f == self.active_field)
                        .unwrap_or(0);
                    if idx == fields.len() - 1 {
                        self.try_save()
                    } else {
                        self.next_field();
                        ModelFormAction::None
                    }
                }
            }

            // Space: toggle for boolean fields
            (KeyCode::Char(' '), _) if self.is_toggle_field() => {
                self.toggle_active_bool();
                ModelFormAction::None
            }

            // For select fields: Left/Right toggle options
            (KeyCode::Left, KeyModifiers::NONE)
                if matches!(self.active_field, FormField::ProviderFormat) =>
            {
                if self.provider_format_index > 0 {
                    self.provider_format_index -= 1;
                }
                ModelFormAction::None
            }
            (KeyCode::Right, KeyModifiers::NONE)
                if matches!(self.active_field, FormField::ProviderFormat) =>
            {
                if self.provider_format_index < PROVIDER_FORMATS.len() - 1 {
                    self.provider_format_index += 1;
                }
                ModelFormAction::None
            }

            (KeyCode::Left, KeyModifiers::NONE)
                if matches!(self.active_field, FormField::DefaultReasoningPreset) =>
            {
                self.reasoning_preset_index = self.reasoning_preset_index.saturating_sub(1);
                ModelFormAction::None
            }
            (KeyCode::Right, KeyModifiers::NONE)
                if matches!(self.active_field, FormField::DefaultReasoningPreset) =>
            {
                self.reasoning_preset_index = self
                    .reasoning_preset_index
                    .saturating_add(1)
                    .min(self.reasoning_preset_options.len());
                ModelFormAction::None
            }

            (KeyCode::Left, KeyModifiers::NONE)
                if matches!(self.active_field, FormField::CustomHeadersMode) =>
            {
                if self.custom_headers_mode_index > 0 {
                    self.custom_headers_mode_index -= 1;
                }
                ModelFormAction::None
            }
            (KeyCode::Right, KeyModifiers::NONE)
                if matches!(self.active_field, FormField::CustomHeadersMode) =>
            {
                if self.custom_headers_mode_index < CUSTOM_HEADERS_MODES.len() - 1 {
                    self.custom_headers_mode_index += 1;
                }
                ModelFormAction::None
            }

            // Up/Down: navigate fields
            (KeyCode::Up, KeyModifiers::NONE) => {
                self.prev_field();
                ModelFormAction::None
            }
            (KeyCode::Down, KeyModifiers::NONE) => {
                self.next_field();
                ModelFormAction::None
            }

            // Text editing keys for text fields only
            (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT)
                if !self.is_non_text_field() =>
            {
                let cursor = self.cursor;
                if let Some(buf) = self.active_buffer_mut() {
                    let byte_pos = char_to_byte(buf, cursor);
                    buf.insert(byte_pos, c);
                }
                self.cursor += 1;
                ModelFormAction::None
            }

            (KeyCode::Backspace, _) if !self.is_non_text_field() => {
                if self.cursor > 0 {
                    let cursor = self.cursor;
                    if let Some(buf) = self.active_buffer_mut() {
                        let byte_start = char_to_byte(buf, cursor - 1);
                        let byte_end = char_to_byte(buf, cursor);
                        buf.drain(byte_start..byte_end);
                    }
                    self.cursor -= 1;
                }
                ModelFormAction::None
            }

            (KeyCode::Left, KeyModifiers::NONE) if !self.is_non_text_field() => {
                self.cursor = self.cursor.saturating_sub(1);
                ModelFormAction::None
            }

            (KeyCode::Right, KeyModifiers::NONE) if !self.is_non_text_field() => {
                let max = self.active_buffer().chars().count();
                self.cursor = (self.cursor + 1).min(max);
                ModelFormAction::None
            }

            (KeyCode::Home, _) => {
                self.cursor = 0;
                ModelFormAction::None
            }

            (KeyCode::End, _) => {
                self.cursor = self.active_buffer().chars().count();
                ModelFormAction::None
            }

            _ => ModelFormAction::None,
        }
    }

    fn try_save(&mut self) -> ModelFormAction {
        if self.validate().is_some() {
            ModelFormAction::None
        } else {
            let result = self.build_result();
            self.hide();
            ModelFormAction::Save(result)
        }
    }

    // ── Rendering ──

    pub(super) fn render(&self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if !self.visible {
            return;
        }

        let popup_width = area.width.saturating_sub(4).min(72);
        // Dynamic height: content rows + 2 (validation + hint) + 2 (border)
        let content_rows = self.display_rows().len();
        let ideal_height = (content_rows as u16 + 4).max(14);
        let popup_height = ideal_height.min(area.height.saturating_sub(2)).min(30);
        if popup_width < 30 || popup_height < 10 {
            return;
        }

        let popup_x = area.x + (area.width.saturating_sub(popup_width)) / 2;
        let popup_y = area.y + (area.height.saturating_sub(popup_height)) / 2;
        let popup_area = Rect {
            x: popup_x,
            y: popup_y,
            width: popup_width,
            height: popup_height,
        };

        let title = if self.editing_model_id.is_some() {
            format!(" Edit Model \u{2015} {} ", self.name)
        } else {
            match &self.provider_name {
                Some(name) => format!(" Add Model \u{2015} {} ", name),
                None => " Add Model \u{2015} Custom ".to_string(),
            }
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(theme.style(StyleKind::Primary))
            .style(Style::default().bg(theme.background))
            .title(title);

        frame.render_widget(Clear, popup_area);
        frame.render_widget(block, popup_area);

        let inner = Rect {
            x: popup_area.x + 1,
            y: popup_area.y + 1,
            width: popup_area.width.saturating_sub(2),
            height: popup_area.height.saturating_sub(2),
        };

        if inner.height < 5 || inner.width < 20 {
            return;
        }

        // Reserve 2 rows at bottom: validation error + hint
        let content_height = inner.height.saturating_sub(2) as usize;

        let rows = self.display_rows();
        let total_rows = rows.len();

        let scroll_offset = if total_rows <= content_height {
            0
        } else {
            self.scroll_offset.min(total_rows - content_height)
        };

        let visible_end = (scroll_offset + content_height).min(total_rows);
        for (vi, row_idx) in (scroll_offset..visible_end).enumerate() {
            let y = inner.y + vi as u16;
            if y >= inner.y + inner.height.saturating_sub(2) {
                break;
            }

            let row_area = Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 1,
            };

            match &rows[row_idx] {
                DisplayRow::AdvancedHeader => {
                    let sep = "\u{2500}".repeat((inner.width as usize).saturating_sub(20));
                    let line = Line::from(vec![
                        Span::styled(
                            " ADVANCED ",
                            theme.style(StyleKind::Warning).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(sep, theme.style(StyleKind::Border)),
                    ]);
                    frame.render_widget(Paragraph::new(line), row_area);
                }
                DisplayRow::Label(field) => {
                    let is_active = *field == self.active_field;
                    let label_text = self.field_label(*field);
                    let label_style = if is_active {
                        theme.style(StyleKind::Primary).add_modifier(Modifier::BOLD)
                    } else {
                        theme.style(StyleKind::Info)
                    };
                    frame.render_widget(
                        Paragraph::new(Line::from(Span::styled(label_text, label_style))),
                        row_area,
                    );
                }
                DisplayRow::Input(field) => {
                    let is_active = *field == self.active_field;
                    self.render_field_input(frame, row_area, *field, is_active, theme);
                }
            }
        }

        // Validation error (if any)
        let error_y = inner.y + inner.height.saturating_sub(2);
        if let Some(err) = self.validate() {
            let err_area = Rect {
                x: inner.x,
                y: error_y,
                width: inner.width,
                height: 1,
            };
            frame.render_widget(
                Paragraph::new(Line::from(Span::styled(
                    format!(" \u{26A0} {}", err),
                    theme.style(StyleKind::Warning),
                ))),
                err_area,
            );
        }

        // Hint line
        let hint_y = inner.y + inner.height.saturating_sub(1);
        let hint_area = Rect {
            x: inner.x,
            y: hint_y,
            width: inner.width,
            height: 1,
        };
        let adv_hint = if self.show_advanced {
            "Ctrl+A: Hide advanced"
        } else {
            "Ctrl+A: Advanced"
        };
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!(
                    " Tab/\u{2191}\u{2193}: Switch  Ctrl+S: Save  {}  Esc: Cancel",
                    adv_hint
                ),
                theme.style(StyleKind::Muted),
            ))),
            hint_area,
        );
    }

    /// Render a mutable version (updates visible_rows)
    pub(super) fn render_mut(&mut self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if !self.visible {
            return;
        }
        // Must match the same dynamic height calculation as render()
        let content_rows = self.display_rows().len();
        let ideal_height = (content_rows as u16 + 4).max(14);
        let popup_height = ideal_height.min(area.height.saturating_sub(2)).min(30);
        let inner_height = popup_height.saturating_sub(2);
        self.visible_rows = inner_height.saturating_sub(2) as usize;
        self.render(frame, area, theme);
    }

    fn field_label(&self, field: FormField) -> &'static str {
        match field {
            FormField::Name => "Config Name *",
            FormField::ModelName => "Model Name *",
            FormField::BaseUrl => "Base URL *",
            FormField::ApiKey if self.editing_model_id.is_some() => {
                "API Key (leave blank to preserve)"
            }
            FormField::ApiKey => "API Key *",
            FormField::ProviderFormat => "Provider Format",
            FormField::ContextWindow => "Context Window",
            FormField::MaxTokens => "Max Output Tokens",
            FormField::MaxImagesPerRequest => "Max Images Per Request",
            FormField::DefaultReasoningPreset => "Default Reasoning Preset",
            FormField::SkipSslVerify => "Skip SSL Verify",
            FormField::CustomHeaders => "Custom Headers (JSON)",
            FormField::CustomHeadersMode => "Custom Headers Mode",
            FormField::CustomRequestBody => "Custom Request Body (JSON)",
        }
    }

    fn render_field_input(
        &self,
        frame: &mut Frame,
        area: Rect,
        field: FormField,
        is_active: bool,
        theme: &Theme,
    ) {
        match field {
            // ── Select field ──
            FormField::ProviderFormat => {
                let mut spans = vec![Span::styled("  ", Style::default())];
                for (i, &fmt) in PROVIDER_FORMATS.iter().enumerate() {
                    let selected = i == self.provider_format_index;
                    let style = if selected && is_active {
                        Style::default()
                            .bg(theme.primary)
                            .fg(theme.selection_foreground())
                            .add_modifier(Modifier::BOLD)
                    } else if selected {
                        theme.style(StyleKind::Primary).add_modifier(Modifier::BOLD)
                    } else {
                        theme.style(StyleKind::Muted)
                    };
                    let label = if selected {
                        format!(" [{}] ", fmt)
                    } else {
                        format!("  {}  ", fmt)
                    };
                    spans.push(Span::styled(label, style));
                }
                if is_active {
                    spans.push(Span::styled(
                        "  \u{2190}\u{2192} to change",
                        theme.style(StyleKind::Muted),
                    ));
                }
                frame.render_widget(Paragraph::new(Line::from(spans)), area);
            }

            FormField::DefaultReasoningPreset => {
                let selected = self
                    .reasoning_preset_index
                    .checked_sub(1)
                    .and_then(|index| self.reasoning_preset_options.get(index))
                    .map(String::as_str)
                    .unwrap_or("Auto");
                let style = if is_active {
                    Style::default()
                        .bg(theme.primary)
                        .fg(theme.selection_foreground())
                        .add_modifier(Modifier::BOLD)
                } else {
                    theme.style(StyleKind::Primary).add_modifier(Modifier::BOLD)
                };
                frame.render_widget(
                    Paragraph::new(Line::from(vec![
                        Span::styled("  ", Style::default()),
                        Span::styled(format!(" [{}] ", selected), style),
                        Span::styled(
                            "  \u{2190}\u{2192} to change",
                            theme.style(StyleKind::Muted),
                        ),
                    ])),
                    area,
                );
            }

            // ── Select field: Custom Headers Mode ──
            FormField::CustomHeadersMode => {
                let mut spans = vec![Span::styled("  ", Style::default())];
                for (i, &mode) in CUSTOM_HEADERS_MODES.iter().enumerate() {
                    let selected = i == self.custom_headers_mode_index;
                    let style = if selected && is_active {
                        Style::default()
                            .bg(theme.primary)
                            .fg(theme.selection_foreground())
                            .add_modifier(Modifier::BOLD)
                    } else if selected {
                        theme.style(StyleKind::Primary).add_modifier(Modifier::BOLD)
                    } else {
                        theme.style(StyleKind::Muted)
                    };
                    let label = if selected {
                        format!(" [{}] ", mode)
                    } else {
                        format!("  {}  ", mode)
                    };
                    spans.push(Span::styled(label, style));
                }
                if is_active {
                    spans.push(Span::styled(
                        "  \u{2190}\u{2192} to change",
                        theme.style(StyleKind::Muted),
                    ));
                }
                frame.render_widget(Paragraph::new(Line::from(spans)), area);
            }

            // ── Toggle (boolean) fields ──
            FormField::SkipSslVerify => {
                let value = match field {
                    FormField::SkipSslVerify => self.skip_ssl_verify,
                    _ => false,
                };

                let (indicator, ind_style) = if value {
                    (
                        "[\u{2713}] ON ",
                        if is_active {
                            Style::default()
                                .bg(theme.primary)
                                .fg(theme.selection_foreground())
                                .add_modifier(Modifier::BOLD)
                        } else {
                            Style::default()
                                .fg(Color::Green)
                                .add_modifier(Modifier::BOLD)
                        },
                    )
                } else {
                    (
                        "[ ] OFF",
                        if is_active {
                            Style::default()
                                .bg(theme.primary)
                                .fg(theme.selection_foreground())
                                .add_modifier(Modifier::BOLD)
                        } else {
                            theme.style(StyleKind::Muted)
                        },
                    )
                };

                let mut spans = vec![
                    Span::styled("    ", Style::default()),
                    Span::styled(indicator, ind_style),
                ];

                if is_active {
                    spans.push(Span::styled(
                        "  Space/Enter to toggle",
                        theme.style(StyleKind::Muted),
                    ));
                }

                // Warning for skip_ssl_verify
                if field == FormField::SkipSslVerify && value {
                    spans.push(Span::styled(
                        "  \u{26A0} Insecure",
                        theme.style(StyleKind::Warning),
                    ));
                }

                frame.render_widget(Paragraph::new(Line::from(spans)), area);
            }

            // ── Text input fields ──
            _ => {
                let value = match field {
                    FormField::Name => &self.name,
                    FormField::ModelName => &self.model_name,
                    FormField::BaseUrl => &self.base_url,
                    FormField::ApiKey => &self.api_key,
                    FormField::ContextWindow => &self.context_window,
                    FormField::MaxTokens => &self.max_tokens,
                    FormField::MaxImagesPerRequest => &self.max_images_per_request,
                    FormField::CustomHeaders => &self.custom_headers,
                    FormField::CustomRequestBody => &self.custom_request_body,
                    _ => "",
                };

                let is_password = matches!(field, FormField::ApiKey);
                let display_value: String = if is_password && !value.is_empty() {
                    let len = value.chars().count();
                    if len <= 4 {
                        "\u{2022}".repeat(len)
                    } else {
                        format!(
                            "{}{}",
                            "\u{2022}".repeat(len - 4),
                            &value[value.len().saturating_sub(4)..]
                        )
                    }
                } else {
                    value.to_string()
                };

                if is_active {
                    let cursor_pos = self.cursor;
                    let (before_raw, after_raw) = if is_password {
                        let display_len = display_value.chars().count();
                        let display_cursor = cursor_pos.min(display_len);
                        let before = display_value
                            .chars()
                            .take(display_cursor)
                            .collect::<String>();
                        let after = display_value
                            .chars()
                            .skip(display_cursor)
                            .collect::<String>();
                        (before, after)
                    } else {
                        let cursor_byte = char_to_byte(value, cursor_pos);
                        let before = value[..cursor_byte].to_string();
                        let after = value[cursor_byte..].to_string();
                        (before, after)
                    };

                    let cursor_char = if after_raw.is_empty() {
                        " ".to_string()
                    } else {
                        after_raw.chars().next().unwrap().to_string()
                    };

                    let after_cursor = if after_raw.len() > cursor_char.len() {
                        after_raw[cursor_char.len()..].to_string()
                    } else {
                        String::new()
                    };

                    let line = Line::from(vec![
                        Span::styled(
                            "  > ",
                            theme.style(StyleKind::Primary).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(before_raw, Style::default().fg(Color::White)),
                        Span::styled(
                            cursor_char,
                            Style::default().fg(Color::Black).bg(Color::White),
                        ),
                        Span::styled(after_cursor, Style::default().fg(Color::White)),
                    ]);
                    frame.render_widget(Paragraph::new(line), area);
                } else {
                    let is_empty = display_value.is_empty();
                    let display = if is_empty {
                        self.field_placeholder(field).to_string()
                    } else {
                        display_value
                    };

                    let style = if is_empty {
                        theme.style(StyleKind::Muted)
                    } else {
                        Style::default().fg(Color::White)
                    };

                    // JSON validation indicator for JSON fields
                    let json_hint = match field {
                        FormField::CustomHeaders | FormField::CustomRequestBody if !is_empty => {
                            if serde_json::from_str::<serde_json::Value>(value.trim()).is_ok() {
                                Some(("\u{2713}", Color::Green))
                            } else {
                                Some(("\u{2717}", Color::Red))
                            }
                        }
                        _ => None,
                    };

                    let mut spans = vec![
                        Span::styled("    ", Style::default()),
                        Span::styled(display, style),
                    ];
                    if let Some((mark, color)) = json_hint {
                        spans.push(Span::styled(
                            format!("  {}", mark),
                            Style::default().fg(color),
                        ));
                    }

                    let line = Line::from(spans);
                    frame.render_widget(Paragraph::new(line), area);
                }
            }
        }
    }

    fn field_placeholder(&self, field: FormField) -> &'static str {
        match field {
            FormField::Name => "e.g. My Model Config",
            FormField::ModelName => "e.g. gpt-4, claude-sonnet-4-5-20250929",
            FormField::BaseUrl => "https://api.example.com/v1/chat/completions",
            FormField::ApiKey if self.editing_model_id.is_some() => {
                "Leave blank to keep the configured key"
            }
            FormField::ApiKey => "Enter your API key",
            FormField::ProviderFormat => "",
            FormField::ContextWindow => "300000",
            FormField::MaxTokens => "8192",
            FormField::MaxImagesPerRequest => "Unlimited",
            FormField::DefaultReasoningPreset => "",
            FormField::SkipSslVerify => "",
            FormField::CustomHeaders => r#"e.g. {"X-Custom": "value"}"#,
            FormField::CustomHeadersMode => "",
            FormField::CustomRequestBody => r#"e.g. {"temperature": 1, "top_p": 0.95}"#,
        }
    }
}

// ── Display row types ──

#[derive(Debug, Clone)]
enum DisplayRow {
    /// Section separator for advanced settings
    AdvancedHeader,
    /// Field label
    Label(FormField),
    /// Field input
    Input(FormField),
}

// ── Helpers ──

fn char_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(i, _)| i)
        .unwrap_or(s.len())
}

#[cfg(test)]
mod tests {
    use super::reasoning_after_preset_selection;
    use openbitfun_core_types::{ReasoningConfig, ReasoningPreset, ReasoningPresetAction};

    #[test]
    fn unchanged_toggle_preserves_custom_reasoning_config() {
        let existing = ReasoningConfig {
            default_preset: Some("custom".to_string()),
            presets: vec![ReasoningPreset {
                id: "custom".to_string(),
                actions: vec![ReasoningPresetAction::RequestPatch {
                    body: serde_json::json!({"reasoning": {"effort": "high"}}),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        assert_eq!(
            reasoning_after_preset_selection(Some(&existing), Some("custom"), Some("custom")),
            Some(existing)
        );
    }

    #[test]
    fn choosing_a_preset_changes_only_the_default_id() {
        let reasoning =
            reasoning_after_preset_selection(None, None, Some("high")).expect("reasoning config");

        assert_eq!(reasoning.default_preset.as_deref(), Some("high"));
        assert!(reasoning.presets.is_empty());
    }

    #[test]
    fn disabling_thinking_returns_to_auto_without_dropping_presets() {
        let existing = ReasoningConfig {
            default_preset: Some("on".to_string()),
            presets: vec![
                ReasoningPreset {
                    id: "on".to_string(),
                    actions: vec![ReasoningPresetAction::Toggle { enabled: true }],
                    ..Default::default()
                },
                ReasoningPreset {
                    id: "custom".to_string(),
                    actions: vec![ReasoningPresetAction::Toggle { enabled: false }],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let disabled =
            reasoning_after_preset_selection(Some(&existing), Some("on"), None).expect("reasoning");
        assert_eq!(disabled.default_preset, None);
        assert_eq!(disabled.presets, existing.presets);
    }
}
