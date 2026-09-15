//! Unified configuration system type definitions
//!
//! Defines all configuration-related types shared between backend and frontend.

use openbitfun_core_types::{product_identity, WorktreeSettings};
pub use openbitfun_core_types::{ReasoningConfig, ReasoningPreset, ReasoningPresetAction};
use openbitfun_product_domains::tool_permissions::{PermissionRule, ToolPermissionConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn deserialize_agent_profiles<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, AgentProfileConfig>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<serde_json::Map<String, serde_json::Value>>::deserialize(deserializer)?;
    let migrated =
        crate::agent_identity_migration::canonicalize_agent_profile_keys(&raw.unwrap_or_default())
            .map_err(serde::de::Error::custom)?;
    migrated
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(id, value)| {
            serde_json::from_value(value)
                .map(|mut profile: AgentProfileConfig| {
                    profile.profile_id = id.clone();
                    (id, profile)
                })
                .map_err(serde::de::Error::custom)
        })
        .collect()
}

/// Web UI font preferences (settings → basics). Keys match `FontPreference` in the frontend (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontPreferenceSnapshot {
    pub ui_size: UiFontSizeSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiFontSizeSnapshot {
    pub level: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_px: Option<u32>,
}

/// Global configuration structure - matches the frontend `GlobalConfig` exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalConfig {
    /// Immutable product identity for this persisted document.
    pub product_id: String,
    pub app: AppConfig,
    pub editor: EditorConfig,
    pub terminal: TerminalConfig,
    pub workspace: WorkspaceConfig,
    pub ai: AIConfig,
    /// User-level static tool permission policy and interaction preferences.
    #[serde(default)]
    pub tool_permissions: ToolPermissionConfig,
    #[serde(default)]
    pub memories: MemoriesConfig,
    /// Project-scoped overlays stored in the shared config document.
    #[serde(default, skip_serializing_if = "ProjectConfig::is_empty")]
    pub project: ProjectConfig,
    /// MCP server configuration (stored uniformly; supports both JSON and structured formats).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<serde_json::Value>,
    /// ACP client configuration (stored as `{ "acpClients": { ... } }`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_clients: Option<serde_json::Value>,
    /// OpenCode-compatible plugin declarations loaded by the process-wide plugin host.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plugin: Vec<PluginDeclarationConfig>,
    /// Web UI appearance selection. The full package contract is owned by the frontend.
    pub appearance: AppearanceConfig,
    /// Web UI font size preferences (`get_config` / `set_config` path `font`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<FontPreferenceSnapshot>,
    /// Version of the persisted configuration schema. This is intentionally
    /// independent from the OpenBitFun application version stored in `version`.
    pub schema_version: u32,
    /// Application build that most recently wrote this document. Informational
    /// only; compatibility is determined by `schema_version`.
    pub version: String,
    #[serde(with = "chrono::serde::ts_milliseconds")]
    pub last_modified: chrono::DateTime<chrono::Utc>,
}

impl GlobalConfig {
    pub fn has_configured_plugins(&self) -> bool {
        self.plugin
            .iter()
            .any(PluginDeclarationConfig::has_non_empty_spec)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginDeclarationConfig {
    Spec(String),
    Detailed(PluginDeclarationDetails),
}

impl PluginDeclarationConfig {
    pub fn spec(&self) -> &str {
        match self {
            Self::Spec(spec) => spec,
            Self::Detailed(details) => &details.spec,
        }
    }

    fn has_non_empty_spec(&self) -> bool {
        !self.spec().trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDeclarationDetails {
    pub spec: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_directory: Option<String>,
}

/// Project-scoped configuration overlay.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectConfig {
    /// Project-level MCP server configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<serde_json::Value>,
}

impl ProjectConfig {
    fn is_empty(&self) -> bool {
        self.mcp_servers.is_none()
    }
}

/// App configuration.
fn default_close_button_behavior() -> String {
    "minimize_to_tray".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub language: String,
    pub auto_update: bool,
    pub telemetry: bool,
    pub startup_behavior: String,
    pub confirm_on_exit: bool,
    pub restore_windows: bool,
    /// Keep the local computer awake while the desktop application is running.
    pub prevent_sleep: bool,
    pub zoom_level: f64,
    #[serde(default)]
    pub logging: AppLoggingConfig,
    pub sidebar: SidebarConfig,
    pub right_panel: RightPanelConfig,
    pub notifications: NotificationConfig,
    #[serde(default)]
    pub flow_chat: AppFlowChatConfig,
    pub ai_experience: AIExperienceConfig,
    /// Controller-owned end-to-end realtime voice conversation settings.
    ///
    /// This is deliberately a sibling of `ai_experience`: generic AI
    /// experience mutations can be routed to a peer host, while the dedicated
    /// realtime speech commands always resolve this value on the controller.
    #[serde(default)]
    pub voice_call: VoiceCallConfig,
    /// User-defined keyboard shortcut overrides.
    /// Stored as opaque JSON so the backend remains schema-agnostic;
    /// the frontend owns the versioned format (StoredKeybindingsV1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keybindings: Option<serde_json::Value>,
    /// Global, user-defined groups used to organize Agent tool pickers.
    #[serde(default, skip_serializing_if = "UserToolGroupsConfig::is_empty")]
    pub user_tool_groups: UserToolGroupsConfig,
    /// Global, user-defined groups used to organize Skill pickers.
    #[serde(default, skip_serializing_if = "UserSkillGroupsConfig::is_empty")]
    pub user_skill_groups: UserSkillGroupsConfig,
    /// What happens when the window close button is clicked on Windows / Linux.
    /// Allowed values: "quit" | "minimize_to_tray" | "ask".
    #[serde(default = "default_close_button_behavior")]
    pub close_button_behavior: String,
    /// Native agent lifecycle hooks (Codex-compatible hooks.json).
    #[serde(default)]
    pub hooks: AgentHooksConfig,
    /// Defaults for opt-in managed Git worktrees.
    #[serde(default)]
    pub worktrees: WorktreeSettings,
}

/// Enablement gates for native agent hooks.
///
/// Hook declarations themselves live in `hooks.json` documents (user scope:
/// `config/hooks.json` next to this file; project scope:
/// `{project}/.openbitfun/config/hooks.json`), not in this settings document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AgentHooksConfig {
    /// Master switch for native agent hooks.
    pub enabled: bool,
    /// Whether project-scope hook files are honored. Disabled by default
    /// because project hook files execute commands from the checked-out
    /// repository; enable only for workspaces you trust.
    pub project_hooks_enabled: bool,
}

impl Default for AgentHooksConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            project_hooks_enabled: false,
        }
    }
}

/// Versioned user preference for grouping selectable Agent tools in the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserToolGroupsConfig {
    pub version: u32,
    pub groups: Vec<UserToolGroup>,
}

impl UserToolGroupsConfig {
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

impl Default for UserToolGroupsConfig {
    fn default() -> Self {
        Self {
            version: 1,
            groups: Vec::new(),
        }
    }
}

/// A user-defined group of canonical tool names.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserToolGroup {
    pub id: String,
    pub name: String,
    pub tool_names: Vec<String>,
}

/// Versioned user preference for grouping selectable Skills in the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillGroupsConfig {
    pub version: u32,
    pub groups: Vec<UserSkillGroup>,
}

impl UserSkillGroupsConfig {
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

impl Default for UserSkillGroupsConfig {
    fn default() -> Self {
        Self {
            version: 1,
            groups: Vec::new(),
        }
    }
}

/// A user-defined group of stable Skill keys.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillGroup {
    pub id: String,
    pub name: String,
    pub skill_keys: Vec<String>,
}

/// App logging configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppLoggingConfig {
    /// Runtime backend log level.
    /// Allowed values: trace, debug, info, warn, error, off.
    pub level: String,
    /// Whether diagnostic logs may include sensitive troubleshooting payloads.
    #[serde(default = "default_true")]
    pub include_sensitive_diagnostics: bool,
    /// Whether the local UI records detailed Flow Chat viewport diagnostics.
    #[serde(default)]
    pub flow_chat_diagnostics: bool,
    /// Per-request AI model exchange tracing configuration for developer diagnostics.
    #[serde(default)]
    pub model_exchange_tracing: ModelExchangeTracingConfig,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelExchangeTracingMode {
    #[default]
    Off,
    Full,
    UsageOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelExchangeTracingConfig {
    pub mode: ModelExchangeTracingMode,
}

/// FlowChat UI preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppFlowChatConfig {
    /// Explicit policy for choosing the default ChatInput mode.
    ///
    /// `None` is retained as a compatibility state: an older persisted
    /// `default_mode_id` remains fixed, while an untouched configuration
    /// follows the user's most recent explicit selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_mode_strategy: Option<ChatInputDefaultModeStrategy>,
    /// Optional fixed ChatInput mode id.
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub default_mode_id: Option<String>,
    /// Most recent mode explicitly selected from the ChatInput Harness control.
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub last_mode_id: Option<String>,
    /// Whether the chat input exposes the global permission-mode shortcut.
    ///
    /// The default is visible, but that value is omitted from persisted config
    /// so existing config files remain unchanged until the user hides it.
    #[serde(
        default = "default_show_permission_mode_control",
        skip_serializing_if = "is_permission_mode_control_visible"
    )]
    pub show_permission_mode_control: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatInputDefaultModeStrategy {
    FollowLast,
    Fixed,
}

fn default_show_permission_mode_control() -> bool {
    true
}

fn is_permission_mode_control_visible(value: &bool) -> bool {
    *value
}

impl Default for AppFlowChatConfig {
    fn default() -> Self {
        Self {
            default_mode_strategy: None,
            default_mode_id: None,
            last_mode_id: None,
            show_permission_mode_control: default_show_permission_mode_control(),
        }
    }
}

impl AppFlowChatConfig {
    /// Remove persisted references to an Agent mode that no longer exists.
    ///
    /// A missing strategy plus a fixed id is the legacy fixed-default shape.
    /// Keep that behavior after removing the id instead of silently changing
    /// the user's policy to follow-last.
    pub fn remove_mode_reference(&mut self, mode_id: &str) {
        if self.default_mode_id.as_deref() == Some(mode_id) {
            self.default_mode_id = None;
            self.default_mode_strategy
                .get_or_insert(ChatInputDefaultModeStrategy::Fixed);
        }
        if self.last_mode_id.as_deref() == Some(mode_id) {
            self.last_mode_id = None;
        }
    }
}

/// A user-defined quick action for the FlowChat post-coding actions menu.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiExperienceQuickAction {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub enabled: bool,
}

/// Local voice input preferences for the chat composer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VoiceInputConfig {
    pub enabled: bool,
    pub provider: String,
    pub model_id: String,
    pub default_language: String,
    pub max_recording_seconds: u32,
    pub microphone_device_id: String,
}

impl Default for VoiceInputConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: "local".to_string(),
            model_id: "sensevoice-small-int8".to_string(),
            default_language: "auto".to_string(),
            max_recording_seconds: 60,
            microphone_device_id: String::new(),
        }
    }
}

/// Controller-local full-duplex voice-call preferences.
///
/// The assistant stays off until the current controller explicitly enables it.
/// The API key crosses only the controller-local settings IPC; starting a
/// session resolves it in the Desktop adapter, so it is never forwarded to a
/// remote workspace or peer HostInvoke request. Session execution selected by
/// a voice tool call can still target a remote workspace or peer through the
/// normal Agent Runtime adapters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VoiceCallConfig {
    pub enabled: bool,
    pub provider: String,
    pub api_key: String,
    pub voice: String,
    pub speed: i32,
    pub loudness: i32,
    pub microphone_device_id: String,
}

impl Default for VoiceCallConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "volcengine".to_string(),
            api_key: String::new(),
            voice: "zh_female_vv_jupiter_bigtts".to_string(),
            speed: 0,
            loudness: 0,
            microphone_device_id: String::new(),
        }
    }
}

/// Domain request for atomically saving a cloud speech-recognition model and
/// selecting it for voice input. Text-generation fields are intentionally not
/// part of this contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SaveCloudSpeechConfigRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
    pub preset: String,
    pub name: String,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_url: Option<String>,
    pub model_name: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SaveCloudSpeechConfigResult {
    pub model_id: String,
    pub created: bool,
}

/// AI experience configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AIExperienceConfig {
    /// Whether to enable automatic AI-generated summaries for session titles.
    pub enable_session_title_generation: bool,
    /// Whether to enable AI analysis of work status on the FlowChat welcome page.
    pub enable_welcome_panel_ai_analysis: bool,
    /// Whether to enable visual mode.
    pub enable_visual_mode: bool,
    /// Whether to show the desktop Agent companion.
    pub enable_agent_companion: bool,
    /// Optional Petdex-compatible companion package selected by the user.
    #[serde(
        default = "default_agent_companion_pet",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_companion_pet: Option<AgentCompanionPetSelection>,
    /// Whether to enable flashgrep-backed accelerated workspace search.
    pub enable_workspace_search: bool,
    /// Local speech-to-text settings for the chat composer.
    pub voice_input: VoiceInputConfig,
    /// User-defined quick actions (post-coding menu); persisted for the web UI.
    #[serde(default = "default_quick_actions")]
    pub quick_actions: Vec<AiExperienceQuickAction>,
}

fn default_quick_actions() -> Vec<AiExperienceQuickAction> {
    [
        ("commit", "Commit", "Commit all current code changes"),
        (
            "create_pr",
            "Create PR",
            "Create a Pull Request for the current branch",
        ),
    ]
    .into_iter()
    .map(|(id, label, prompt)| AiExperienceQuickAction {
        id: id.to_string(),
        label: label.to_string(),
        prompt: prompt.to_string(),
        enabled: true,
    })
    .collect()
}

/// User-selected Agent companion pet package.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompanionPetSelection {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub source: String,
    pub package_path: String,
    pub spritesheet_path: String,
    pub spritesheet_mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprite_version_number: Option<u32>,
}

fn default_agent_companion_pet() -> Option<AgentCompanionPetSelection> {
    Some(AgentCompanionPetSelection {
        id: "blue-golden".to_string(),
        display_name: "困困".to_string(),
        description: Some(
            "A sweet, round-faced blue-golden shaded cat with wide bright eyes and soft silver-blue fur warmed by creamy-gold highlights.".to_string(),
        ),
        source: "preset".to_string(),
        package_path: "/agent-companion-pets/blue-golden".to_string(),
        spritesheet_path: "/agent-companion-pets/blue-golden/spritesheet.png".to_string(),
        spritesheet_mime_type: "image/png".to_string(),
        sprite_version_number: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SidebarConfig {
    pub width: u32,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RightPanelConfig {
    pub width: u32,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationConfig {
    pub enabled: bool,
    pub position: String,
    pub duration: u32,
    /// Whether to show a toast notification when a dialog turn completes while the window is not focused.
    #[serde(default = "default_true")]
    pub dialog_completion_notify: bool,
    /// Whether to show a toast notification when an approval request arrives while the window is not focused.
    #[serde(default = "default_true")]
    pub permission_request_notify: bool,
    /// Whether to show built-in tip cards on startup (can be disabled by the user).
    #[serde(default = "default_true")]
    pub enable_startup_tips: bool,
}

/// Web UI appearance configuration. Rust stores only the selected package id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceConfig {
    /// Selected appearance package ID or `system`.
    pub selection: String,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            selection: "system".to_string(),
        }
    }
}

/// Editor configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorConfig {
    pub font_size: u32,
    pub font_family: String,
    pub font_weight: String,
    pub line_height: f64,
    pub cursor_style: String,
    pub cursor_blinking: String,
    pub render_whitespace: String,
    pub render_line_highlight: String,
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub detect_indentation: bool,
    pub word_wrap: String,
    pub scroll_beyond_last_line: bool,
    pub smooth_scrolling: bool,
    pub line_numbers: String,
    pub minimap: MinimapConfig,
    pub auto_save: String,
    pub auto_save_delay: u32,
    pub format_on_save: bool,
    pub format_on_paste: bool,
    pub trim_auto_whitespace: bool,
    pub semantic_highlighting: bool,
    pub bracket_pair_colorization: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MinimapConfig {
    pub enabled: bool,
    pub side: String,
    pub size: String,
}

/// Terminal configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    /// Empty string means "auto-detect".
    pub default_shell: String,
    /// Terminal panel placement in the session layout: "right" or "bottom".
    pub terminal_panel_position: String,
    pub font_size: u32,
    pub font_family: String,
    pub cursor_blink: bool,
    pub cursor_style: String,
    pub scrollback: u32,
}

/// Workspace configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceConfig {
    pub exclude_patterns: Vec<String>,
    pub include_patterns: Vec<String>,
    pub watch_ignore: Vec<String>,
    /// Maximum file size in bytes.
    pub max_file_size: u64,
    pub encoding: String,
    pub line_ending: String,
    pub trim_trailing_whitespace: bool,
    pub insert_final_newline: bool,
}

/// Model capability type (a model can have multiple capabilities).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ModelCapability {
    /// Text chat (primary capability).
    TextChat,
    /// Image understanding (vision).
    ImageUnderstanding,
    /// Image generation.
    ImageGeneration,
    /// Embeddings (semantic vectors).
    Embedding,
    /// Search API (e.g. Perplexity).
    Search,
    /// Code specialized.
    CodeSpecialized,
    /// Function calling / tool use.
    FunctionCalling,
    /// Speech-to-text.
    SpeechRecognition,
}

pub const CURRENT_CONFIG_SCHEMA_VERSION: u32 = 1;

/// Model category (for UI display and filtering).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ModelCategory {
    /// General chat model.
    #[default]
    GeneralChat,
    /// Multimodal model (text + image understanding).
    Multimodal,
    /// Image generation model.
    ImageGeneration,
    /// Embedding / vector model.
    Embedding,
    /// Search-enhanced model.
    SearchEnhanced,
    /// Code-specialized model.
    CodeSpecialized,
    /// Speech recognition model.
    SpeechRecognition,
}

/// Default model configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct DefaultModelsConfig {
    /// Primary model ID (for complex tasks).
    pub primary: Option<String>,
    /// Fast model ID (for simple tasks). When unset, selection falls back to primary.
    pub fast: Option<String>,
    /// Search model.
    pub search: Option<String>,
    /// Image understanding model.
    pub image_understanding: Option<String>,
    /// Image generation model.
    pub image_generation: Option<String>,
    /// Speech recognition model.
    pub speech_recognition: Option<String>,
}

/// Model choice for a subagent created in the context of a parent session.
///
/// `Inherit` is intentionally distinct from a model ID so a user-configured
/// model named `inherit` can never be interpreted as a control value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[derive(Default)]
pub enum SubagentModelSelection {
    Fixed {
        model_id: String,
    },
    #[default]
    Inherit,
}

impl SubagentModelSelection {
    pub fn fixed(model_id: impl Into<String>) -> Self {
        Self::Fixed {
            model_id: model_id.into(),
        }
    }

    pub fn fixed_model_id(&self) -> Option<&str> {
        match self {
            Self::Fixed { model_id } => Some(model_id.as_str()),
            Self::Inherit => None,
        }
    }
}

/// Model defaults for subagents created through user-visible delegation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SubagentModelDefaultsConfig {
    /// Shared fallback for normal subagents without an explicit override.
    #[serde(rename = "default", default = "default_subagent_model_selection")]
    pub default_selection: SubagentModelSelection,
    /// Per-builtin defaults and user overrides. Missing entries use `default`.
    pub builtin: HashMap<String, SubagentModelSelection>,
    /// Default choice for a child created from the parent's context.
    pub fork: SubagentModelSelection,
}

impl Default for SubagentModelDefaultsConfig {
    fn default() -> Self {
        Self {
            default_selection: default_subagent_model_selection(),
            builtin: HashMap::from([
                (
                    "GeneralPurpose".to_string(),
                    SubagentModelSelection::fixed("primary"),
                ),
                (
                    "ResearchSpecialist".to_string(),
                    SubagentModelSelection::Inherit,
                ),
            ]),
            fork: SubagentModelSelection::Inherit,
        }
    }
}

fn default_subagent_model_selection() -> SubagentModelSelection {
    SubagentModelSelection::fixed("fast")
}

/// Defaults used when the product creates an agent session without an explicit
/// per-session model choice.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentModelDefaultsConfig {
    /// Shared model selector for future mode sessions.
    pub mode: String,
    /// User-visible delegated subagent model choices.
    pub subagents: SubagentModelDefaultsConfig,
}

impl AgentModelDefaultsConfig {
    pub fn builtin_subagent_selection(&self, agent_id: &str) -> SubagentModelSelection {
        self.subagents
            .builtin
            .get(agent_id)
            .cloned()
            .unwrap_or_else(|| self.subagents.default_selection.clone())
    }
}

impl Default for AgentModelDefaultsConfig {
    fn default() -> Self {
        Self {
            mode: "primary".to_string(),
            subagents: SubagentModelDefaultsConfig::default(),
        }
    }
}

/// Default review-team execution policy and membership configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ReviewTeamConfig {
    /// Additional reviewer subagent IDs configured by the user.
    pub extra_subagent_ids: Vec<String>,
    /// Default review depth used by the whole review team.
    pub strategy_level: String,
    /// Per-reviewer review depth overrides keyed by subagent ID.
    pub member_strategy_overrides: HashMap<String, String>,
    /// Optional timeout applied to reviewer Task calls. 0 disables the cap.
    pub reviewer_timeout_seconds: u64,
    /// Optional timeout applied to ReviewJudge Task calls. 0 disables the cap.
    pub judge_timeout_seconds: u64,
    /// Whether ReviewFixer may be launched by DeepReview.
    pub auto_fix_enabled: bool,
    /// Minimum number of target files that triggers same-role reviewer splitting.
    /// 0 disables file splitting.
    pub reviewer_file_split_threshold: usize,
    /// Maximum number of same-role reviewer instances per role when file splitting is active.
    pub max_same_role_instances: usize,
    /// Maximum retries for a failed same-role reviewer instance.
    pub max_retries_per_role: usize,
    /// Maximum number of review instances that may run at the same time.
    pub max_parallel_reviewers: usize,
    /// Seconds to wait for provider capacity before skipping unstarted work. 0 skips immediately.
    pub max_queue_wait_seconds: u64,
    /// Whether unstarted review work may wait for provider capacity.
    pub allow_provider_capacity_queue: bool,
    /// Whether bounded automatic retry is allowed after a reviewer failure.
    pub allow_bounded_auto_retry: bool,
    /// Elapsed-seconds guard that blocks bounded automatic retry after this delay.
    pub auto_retry_elapsed_guard_seconds: u64,
}

impl Default for ReviewTeamConfig {
    fn default() -> Self {
        Self {
            extra_subagent_ids: Vec::new(),
            strategy_level: "normal".to_string(),
            member_strategy_overrides: HashMap::new(),
            reviewer_timeout_seconds: 3600,
            judge_timeout_seconds: 2400,
            auto_fix_enabled: false,
            reviewer_file_split_threshold: 20,
            max_same_role_instances: 3,
            max_retries_per_role: 1,
            max_parallel_reviewers: 2,
            max_queue_wait_seconds: 1200,
            allow_provider_capacity_queue: true,
            allow_bounded_auto_retry: false,
            auto_retry_elapsed_guard_seconds: 180,
        }
    }
}

fn default_review_team_configs() -> HashMap<String, ReviewTeamConfig> {
    HashMap::from([("default".to_string(), ReviewTeamConfig::default())])
}

fn default_review_team_rate_limit_status() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

/// Model selection for a product-owned AI task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskModelSelection {
    Inherit,
    Fixed { model_id: String },
}

impl TaskModelSelection {
    pub fn fixed_model_id(&self) -> Option<&str> {
        match self {
            Self::Inherit => None,
            Self::Fixed { model_id } => Some(model_id),
        }
    }
}

fn default_task_model_selection() -> TaskModelSelection {
    TaskModelSelection::Fixed {
        model_id: "fast".to_string(),
    }
}

fn is_default_task_model_selection(selection: &TaskModelSelection) -> bool {
    *selection == default_task_model_selection()
}

/// Model selectors for small product-owned AI tasks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct TaskModelsConfig {
    #[serde(
        default = "default_task_model_selection",
        skip_serializing_if = "is_default_task_model_selection"
    )]
    pub session_title: TaskModelSelection,
    #[serde(
        default = "default_task_model_selection",
        skip_serializing_if = "is_default_task_model_selection"
    )]
    pub git_commit: TaskModelSelection,
}

impl Default for TaskModelsConfig {
    fn default() -> Self {
        Self {
            session_title: default_task_model_selection(),
            git_commit: default_task_model_selection(),
        }
    }
}

impl TaskModelsConfig {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// AI configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AIConfig {
    /// All configured models.
    pub models: Vec<AIModelConfig>,

    /// Model selectors for product-owned AI tasks.
    #[serde(default, skip_serializing_if = "TaskModelsConfig::is_default")]
    pub task_models: TaskModelsConfig,

    /// Default model configuration.
    #[serde(default)]
    pub default_models: DefaultModelsConfig,

    /// Default selectors for future mode and delegated-subagent sessions.
    #[serde(default)]
    pub agent_model_defaults: AgentModelDefaultsConfig,

    /// Shared agent-profile configuration.
    /// profile_id -> AgentProfileConfig
    #[serde(default, deserialize_with = "deserialize_agent_profiles")]
    pub agent_profiles: HashMap<String, AgentProfileConfig>,

    /// User-level Skill availability shared by every agent profile.
    #[serde(default)]
    pub skill_settings: SkillSettingsConfig,

    /// Review team configuration.
    /// team_id -> ReviewTeamConfig
    #[serde(default = "default_review_team_configs")]
    pub review_teams: HashMap<String, ReviewTeamConfig>,

    /// Runtime rate-limit snapshot for Review Team launches.
    #[serde(default = "default_review_team_rate_limit_status")]
    pub review_team_rate_limit_status: serde_json::Value,

    /// Maximum number of subagents that may execute concurrently.
    #[serde(default = "default_subagent_max_concurrency")]
    pub subagent_max_concurrency: usize,

    /// Maximum number of Swarm workers and reviewers that may execute concurrently.
    #[serde(default = "default_swarm_max_concurrency")]
    pub swarm_max_concurrency: usize,

    /// Scheduling policy for multiple subagent launch calls in the same model batch.
    #[serde(default = "default_subagent_batch_execution_policy")]
    pub subagent_batch_execution_policy: SubagentBatchExecutionPolicy,

    /// Global proxy configuration.
    pub proxy: ProxyConfig,

    /// Streaming idle timeout in seconds; `None` means wait indefinitely.
    #[serde(default = "default_stream_idle_timeout")]
    pub stream_idle_timeout_secs: Option<u64>,

    /// Time-to-first-token timeout in seconds while opening a streaming request;
    /// `None` means wait indefinitely.
    #[serde(default = "default_stream_ttft_timeout")]
    pub stream_ttft_timeout_secs: Option<u64>,

    /// Tool execution timeout in seconds; `None` means wait indefinitely.
    #[serde(default = "default_tool_execution_timeout")]
    pub tool_execution_timeout_secs: Option<u64>,

    /// Whether tools with deferred exposure load their schemas on demand.
    #[serde(default = "default_enable_deferred_tool_loading")]
    pub enable_deferred_tool_loading: bool,

    /// Speculatively summarize context before automatic compression is required.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub enable_context_compression_prefetch: bool,

    /// Allows broad JSON repair for non-Write tool arguments only after a
    /// provider confirms a normal tool-use completion.
    #[serde(default = "default_true")]
    pub allow_tool_json_repair: bool,

    /// Allow Computer use (desktop automation) when the desktop host is available (all session modes).
    #[serde(default)]
    pub computer_use_enabled: bool,

    /// Preferred browser for CDP browser control. Empty/default uses the system default browser.
    #[serde(default)]
    pub browser_control_preferred_browser: String,

    /// Provider-neutral WebSearch runtime configuration. Credentials are
    /// referenced by logical id and remain in the device-local encrypted vault.
    #[serde(default)]
    pub web_search: WebSearchConfig,

    /// Reattach to an already-running browser when OpenBitFun starts. Off by
    /// default: the browser forgets its approval when it restarts, so this can
    /// put an approval dialog in front of the user before they asked for the
    /// browser at all.
    #[serde(default)]
    pub browser_control_auto_connect_on_startup: bool,

    /// Maximum number of rounds per dialog turn before soft-pausing.
    /// Zero disables the fixed round limit.
    #[serde(default = "default_max_rounds")]
    pub max_rounds: usize,
}

fn default_web_search_provider() -> String {
    "exa_mcp_free".to_string()
}

fn default_exa_search_credential_id() -> String {
    "exa-search-api".to_string()
}

fn default_tavily_credential_id() -> String {
    "tavily-search-api".to_string()
}

fn default_openbitfun_search_http_credential_id() -> String {
    "openbitfun-search-http".to_string()
}

/// Non-secret WebSearch settings that are safe to persist and synchronize.
/// Unknown fields are retained so a newer provider configuration survives an
/// older OpenBitFun build reading and writing the document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WebSearchConfig {
    #[serde(default = "default_web_search_provider")]
    pub provider: String,
    #[serde(default)]
    pub providers: WebSearchProviderConfigs,
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            provider: default_web_search_provider(),
            providers: WebSearchProviderConfigs::default(),
            unknown: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct WebSearchProviderConfigs {
    pub exa_search_api: WebSearchCredentialProviderConfig,
    pub tavily: WebSearchCredentialProviderConfig,
    pub openbitfun_search_http: OpenBitFunSearchHttpConfig,
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for WebSearchProviderConfigs {
    fn default() -> Self {
        Self {
            exa_search_api: WebSearchCredentialProviderConfig {
                credential_id: default_exa_search_credential_id(),
                unknown: serde_json::Map::new(),
            },
            tavily: WebSearchCredentialProviderConfig {
                credential_id: default_tavily_credential_id(),
                unknown: serde_json::Map::new(),
            },
            openbitfun_search_http: OpenBitFunSearchHttpConfig::default(),
            unknown: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WebSearchCredentialProviderConfig {
    pub credential_id: String,
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for WebSearchCredentialProviderConfig {
    fn default() -> Self {
        Self {
            credential_id: String::new(),
            unknown: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenBitFunSearchHttpConfig {
    pub endpoint: String,
    pub auth: OpenBitFunSearchHttpAuthConfig,
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for OpenBitFunSearchHttpConfig {
    fn default() -> Self {
        Self {
            endpoint: String::new(),
            auth: OpenBitFunSearchHttpAuthConfig::default(),
            unknown: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenBitFunSearchHttpAuthConfig {
    /// `none`, `bearer`, or `header`. Kept as a string so unknown future modes
    /// round-trip and fail explicitly only when selected at runtime.
    pub mode: String,
    pub credential_id: String,
    pub header_name: String,
    #[serde(flatten)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
}

impl Default for OpenBitFunSearchHttpAuthConfig {
    fn default() -> Self {
        Self {
            mode: "none".to_string(),
            credential_id: default_openbitfun_search_http_credential_id(),
            header_name: String::new(),
            unknown: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubagentBatchExecutionPolicy {
    /// Preserve the tool-owned concurrency-safety decision.
    SafeOnly,
    /// Force multiple Task calls from the same model batch into parallel scheduling.
    #[default]
    ForceParallel,
    /// Treat all Task calls as serial even when a subagent is read-only.
    Serial,
}

/// Automatic memory subsystem configuration.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemoryExternalContextPolicy {
    /// Keep sessions that used external context tools, but clear those tool results in Phase 1.
    #[default]
    ClearToolResults,
    /// Keep sessions and tool results as-is.
    Allow,
    /// Mark sessions that used external context tools as polluted and skip extraction.
    SkipSession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct MemoriesConfig {
    /// Enables automatic Phase 1 extraction and Phase 2 consolidation.
    pub generate_memories: bool,
    /// Allows persistent BTW sessions to become memory-generation sources.
    pub generate_for_btw_sessions: bool,
    /// Enables prompt injection of the consolidated memory summary.
    pub use_memories: bool,
    /// Controls how sessions that used external context tools are handled.
    pub external_context_policy: MemoryExternalContextPolicy,
    /// Maximum number of stage-1 outputs selected for phase-2 consolidation.
    pub max_raw_memories_for_consolidation: usize,
    /// Maximum age in days for a stage-1 output to stay eligible for phase-2 reuse.
    pub max_unused_days: i64,
    /// Maximum age in days for a source session to be considered by Phase 1.
    pub max_rollout_age_days: i64,
    /// Maximum source sessions claimed for extraction per memory startup pass.
    pub max_rollouts_per_startup: usize,
    /// Maximum source sessions scanned while looking for extraction candidates per memory startup pass.
    pub max_rollouts_scan_limit: usize,
    /// Minimum idle time in hours before a source session can be extracted.
    pub min_rollout_idle_hours: i64,
    /// Maximum number of concurrent Phase 1 extraction jobs.
    pub phase1_max_concurrency: usize,
    /// Retry backoff after a failed Phase 1 extraction.
    pub phase1_retry_backoff_minutes: i64,
    /// Lease duration for claimed Phase 1 jobs.
    pub phase1_lease_seconds: i64,
    /// Lease duration for the global Phase 2 consolidation job.
    pub phase2_lease_seconds: i64,
    /// Phase-2 consolidation cooldown in seconds after a successful run.
    pub phase2_success_cooldown_seconds: i64,
    /// Phase-2 retry delay in seconds after a failed run.
    pub phase2_retry_delay_seconds: i64,
    /// Optional model selector for Phase 1 extraction.
    pub extract_model: Option<String>,
    /// Optional model selector for Phase 2 consolidation.
    pub consolidation_model: Option<String>,
}

impl AIConfig {
    /// Resolves a canonical configured model ID.
    ///
    /// Returns the model id only when the matched model is `enabled`. This is the
    /// single source of truth for "is this model usable right now?" and is the
    /// variant every runtime path (client factory, execution engine, etc.) should
    /// use. UI / migration code that needs to look up disabled entries should call
    /// [`Self::resolve_model_reference_any`] instead.
    pub fn resolve_model_reference(&self, model_id: &str) -> Option<String> {
        let mut matches = self.models.iter().filter(|m| m.enabled && m.id == model_id);
        let model = matches.next()?;
        (matches.next().is_none()).then(|| model.id.clone())
    }

    /// Resolves a canonical configured model ID regardless of `enabled` state.
    /// UI / migration only — never use this on the runtime model-selection path.
    pub fn resolve_model_reference_any(&self, model_id: &str) -> Option<String> {
        let mut matches = self.models.iter().filter(|m| m.id == model_id);
        let model = matches.next()?;
        (matches.next().is_none()).then(|| model.id.clone())
    }

    /// Returns true if the given reference points to a model that exists and is
    /// currently enabled.
    pub fn is_model_reference_active(&self, model_ref: &str) -> bool {
        self.resolve_model_reference(model_ref).is_some()
    }

    /// Returns the id of the first enabled model, if any. Used as a final
    /// fallback when a configured default points to a disabled / missing model.
    pub fn first_enabled_model_id(&self) -> Option<String> {
        self.models.iter().find(|m| m.enabled).map(|m| m.id.clone())
    }

    /// Resolves a model selector value.
    ///
    /// Special values:
    /// - `primary`: must resolve to a valid (enabled) primary model
    /// - `fast`: first tries the configured fast model, then falls back to primary
    ///
    /// Regular values must be canonical configured model IDs. All lookups require
    /// the target model to be enabled — disabled models are treated as if they did
    /// not exist.
    pub fn resolve_model_selection(&self, model_ref: &str) -> Option<String> {
        match model_ref {
            "primary" => self
                .default_models
                .primary
                .as_deref()
                .and_then(|value| self.resolve_model_reference(value)),
            "fast" => self
                .default_models
                .fast
                .as_deref()
                .and_then(|value| self.resolve_model_reference(value))
                .or_else(|| {
                    self.default_models
                        .primary
                        .as_deref()
                        .and_then(|value| self.resolve_model_reference(value))
                }),
            _ => self.resolve_model_reference(model_ref),
        }
    }
}

/// Shared agent-profile configuration.
///
/// Tool, skill, and delegation overrides owned by one Agent identity.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AgentProfileConfig {
    /// Canonical Agent ID (e.g. Standard, Creative, Claw, or a custom Agent ID).
    pub profile_id: String,

    /// Tools explicitly enabled by the user that are not part of the mode defaults.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added_tools: Vec<String>,

    /// Default tools explicitly disabled by the user.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_tools: Vec<String>,

    /// User-level skills disabled for this mode.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_user_skills: Vec<String>,

    /// User-level built-in skills explicitly enabled even though the mode default disables them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enabled_user_skills: Vec<String>,

    /// User-level subagent availability overrides for this shared profile.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub subagent_overrides: ParentSubagentOverrideConfig,

    /// Agent-level permission rules applied after project rules.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_permission_rules: Vec<PermissionRule>,

    /// Preserve fields written by newer versions during migration and updates.
    #[serde(flatten)]
    pub extensions: serde_json::Map<String, serde_json::Value>,
}

/// Skill availability configuration shared by every agent profile.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SkillSettingsConfig {
    /// User-level Skill keys disabled for every agent profile.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub globally_disabled_user_skills: Vec<String>,
    /// Project-level Skill keys, scoped to canonical local workspace roots.
    /// Remote workspace policy must be owned by its serving filesystem, not this local map.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub globally_disabled_project_skills: HashMap<String, Vec<String>>,
}

/// API view of a mode configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(default)]
pub struct AgentProfileView {
    pub profile_id: String,
    pub enabled_tools: Vec<String>,
    pub default_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_user_skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enabled_user_skills: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

/// Default streaming idle timeout between chunks.
fn default_stream_idle_timeout() -> Option<u64> {
    Some(600)
}

/// Default timeout while waiting for the first effective streamed output.
fn default_stream_ttft_timeout() -> Option<u64> {
    Some(600)
}

/// Default is no timeout (wait forever).
fn default_tool_execution_timeout() -> Option<u64> {
    None
}

fn default_enable_deferred_tool_loading() -> bool {
    true
}

fn default_subagent_max_concurrency() -> usize {
    5
}

fn default_swarm_max_concurrency() -> usize {
    16
}

fn default_memory_max_raw_memories_for_consolidation() -> usize {
    64
}

fn default_memory_max_unused_days() -> i64 {
    30
}

fn default_memory_max_rollout_age_days() -> i64 {
    10
}

fn default_memory_max_rollouts_per_startup() -> usize {
    2
}

fn default_memory_max_rollouts_scan_limit() -> usize {
    2_000
}

fn default_memory_min_rollout_idle_hours() -> i64 {
    6
}

fn default_memory_phase1_max_concurrency() -> usize {
    1
}

fn default_memory_phase1_retry_backoff_minutes() -> i64 {
    60
}

fn default_memory_phase1_lease_seconds() -> i64 {
    60 * 60
}

fn default_memory_phase2_lease_seconds() -> i64 {
    60 * 60
}

fn default_memory_phase2_success_cooldown_seconds() -> i64 {
    6 * 60 * 60
}

fn default_memory_phase2_retry_delay_seconds() -> i64 {
    60 * 60
}

fn default_subagent_batch_execution_policy() -> SubagentBatchExecutionPolicy {
    SubagentBatchExecutionPolicy::ForceParallel
}

pub const DEFAULT_MAX_ROUNDS: usize = 0;

fn default_max_rounds() -> usize {
    DEFAULT_MAX_ROUNDS
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSubagentOverrideState {
    Enabled,
    Disabled,
}

pub type ParentSubagentOverrideConfig = HashMap<String, AgentSubagentOverrideState>;
pub type AgentSubagentOverrideConfig = HashMap<String, ParentSubagentOverrideConfig>;

pub const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS: u32 = 128_128;
pub const MIN_MODEL_CONTEXT_WINDOW_TOKENS: u32 = 32_000;
pub const MAX_CONFIGURED_OUTPUT_TOKENS_RATIO_PERCENT: u32 = 40;
const AUTOMATIC_MAX_OUTPUT_TOKEN_TIERS: [u32; 5] = [8_000, 16_000, 24_000, 32_000, 64_000];

/// Chooses the largest supported output tier that does not exceed one quarter
/// of the model context window.
pub fn automatic_max_output_tokens(context_window: u32) -> u32 {
    let quarter_context = context_window / 4;
    AUTOMATIC_MAX_OUTPUT_TOKEN_TIERS
        .iter()
        .rev()
        .copied()
        .find(|tier| *tier <= quarter_context)
        .unwrap_or(quarter_context)
}

/// A configured output cap may use up to 40% of the model context window.
pub fn is_valid_configured_max_output_tokens(context_window: u32, max_tokens: u32) -> bool {
    max_tokens > 0
        && u64::from(max_tokens) * 100
            <= u64::from(context_window) * u64::from(MAX_CONFIGURED_OUTPUT_TOKENS_RATIO_PERCENT)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AIModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model_name: String,
    pub base_url: String,

    /// Computed actual request URL (auto-derived from base_url + provider format).
    /// Stored by the frontend when config is saved; falls back to base_url if absent.
    #[serde(default)]
    pub request_url: Option<String>,

    pub api_key: String,
    /// Context window size (total token limit for input + output).
    pub context_window: Option<u32>,
    /// Optional advanced override for the request output limit. When absent,
    /// OpenBitFun derives a tiered limit from the context window at runtime.
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub enabled: bool,
    /// Model category (primary category used for UI filtering).
    pub category: ModelCategory,
    /// Capability tags (multi-select).
    pub capabilities: Vec<ModelCapability>,
    /// Recommended use cases.
    #[serde(default)]
    pub recommended_for: Vec<String>,
    /// Additional metadata (JSON, for extensibility).
    pub metadata: Option<serde_json::Value>,

    /// Canonical model reasoning presets and default selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningConfig>,

    /// Whether to parse OpenAI-compatible text chunks containing `<think>...</think>` into
    /// streaming reasoning content.
    #[serde(default = "default_true")]
    pub inline_think_in_text: bool,

    /// Custom HTTP request headers.
    #[serde(default)]
    pub custom_headers: Option<std::collections::HashMap<String, String>>,

    /// Custom header mode: "replace" (default, full replacement) or "merge" (merge; apply
    /// defaults first, then custom).
    #[serde(default)]
    pub custom_headers_mode: Option<String>,

    /// Whether to skip SSL certificate verification (advanced; use only when necessary).
    #[serde(default)]
    pub skip_ssl_verify: bool,

    /// Custom request body (JSON string, used to override default request body fields).
    #[serde(default)]
    pub custom_request_body: Option<String>,

    /// Custom request body mode: "merge" (default) or "trim" (keep only essential runtime
    /// fields, then apply custom JSON).
    #[serde(default)]
    pub custom_request_body_mode: Option<String>,

    /// Authentication source for this model. Defaults to a static API key;
    /// selecting a CLI source causes the AI client
    /// factory to look up `~/.codex/auth.json` or `~/.gemini/...` at request
    /// time and inject the resolved Bearer token / extra headers.
    #[serde(default)]
    pub auth: AuthConfig,
}

/// Stable identity of the runtime-affecting parts of a concrete model config.
///
/// Credentials are deliberately excluded: rotating a secret must not require
/// the user to approve the same provider/model again. Endpoint, provider,
/// model, request options, and authentication source remain part of the
/// identity so an approved binding cannot silently drift to different runtime
/// behavior while retaining the same config id.
pub fn model_runtime_binding_fingerprint(model: &AIModelConfig) -> String {
    let mut value = serde_json::to_value(model).unwrap_or(serde_json::Value::Null);
    if let serde_json::Value::Object(fields) = &mut value {
        fields.remove("api_key");
    }

    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(fields) => {
                let mut entries = fields.into_iter().collect::<Vec<_>>();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, canonicalize(value)))
                        .collect(),
                )
            }
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            value => value,
        }
    }

    let canonical = serde_json::to_vec(&canonicalize(value)).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(canonical);
    hex::encode(hasher.finalize())
}

/// Subscription provider whose in-app OAuth tokens authenticate a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionProvider {
    Codex,
    Antigravity,
    Opencode,
    Grok,
    Hermes,
}

/// OpenCode API product selected for a subscription-authenticated model.
/// Zen and Go share one account credential but use different API namespaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodePlan {
    Zen,
    Go,
}

/// Where to obtain the runtime auth material for an `AIModelConfig`.
///
/// Stored on disk as `{"type":"api_key"}` or
/// `{"type":"subscription","provider":"codex"|"antigravity"|"opencode"|"grok"|"hermes"}`.
/// OpenCode models may additionally persist `"plan":"zen"|"go"`; an absent
/// plan selects the default Zen Chat Completions behavior.
/// Tokens live in the subscription auth store and are resolved at request time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthConfig {
    /// Use the inline `api_key` string (default).
    #[default]
    ApiKey,
    /// Use OpenBitFun in-app subscription OAuth for the named provider.
    Subscription {
        provider: SubscriptionProvider,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan: Option<OpenCodePlan>,
    },
}

pub use openbitfun_core_types::ProxyConfig;

/// Configuration change event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigChangeEvent {
    pub path: String,
    pub old_value: serde_json::Value,
    pub new_value: serde_json::Value,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    /// Event source: "user" | "system" | "migration".
    pub source: String,
}

/// Configuration validation result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigValidationResult {
    pub valid: bool,
    pub errors: Vec<ConfigValidationError>,
    pub warnings: Vec<ConfigValidationWarning>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<ConfigDiagnostic>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigDiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigDiagnosticRecoverability {
    None,
    AutoFix,
    ModelDisabled,
    DefaultsUsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigDiagnostic {
    pub path: String,
    pub message: String,
    pub code: String,
    pub severity: ConfigDiagnosticSeverity,
    pub recoverability: ConfigDiagnosticRecoverability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigValidationError {
    pub path: String,
    pub message: String,
    pub code: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigValidationWarning {
    pub path: String,
    pub message: String,
    pub code: String,
    pub severity: String,
}

impl Default for GlobalConfig {
    fn default() -> Self {
        Self {
            product_id: product_identity::product_id().to_string(),
            app: AppConfig::default(),
            editor: EditorConfig::default(),
            terminal: TerminalConfig::default(),
            workspace: WorkspaceConfig::default(),
            ai: AIConfig::default(),
            memories: MemoriesConfig::default(),
            project: ProjectConfig::default(),
            tool_permissions: ToolPermissionConfig::default(),
            mcp_servers: None,
            acp_clients: None,
            plugin: Vec::new(),
            appearance: AppearanceConfig::default(),
            font: None,
            schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
            version: env!("CARGO_PKG_VERSION").to_string(),
            last_modified: chrono::Utc::now(),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            language: "zh-CN".to_string(),
            auto_update: true,
            telemetry: false,
            startup_behavior: "lastWorkspace".to_string(),
            confirm_on_exit: true,
            restore_windows: true,
            prevent_sleep: false,
            zoom_level: 1.0,
            logging: AppLoggingConfig::default(),
            sidebar: SidebarConfig {
                width: 300,
                collapsed: false,
            },
            right_panel: RightPanelConfig {
                width: 400,
                collapsed: true,
            },
            notifications: NotificationConfig {
                enabled: true,
                position: "topRight".to_string(),
                duration: 5000,
                dialog_completion_notify: true,
                permission_request_notify: true,
                enable_startup_tips: true,
            },
            flow_chat: AppFlowChatConfig::default(),
            ai_experience: AIExperienceConfig::default(),
            voice_call: VoiceCallConfig::default(),
            keybindings: None,
            user_tool_groups: UserToolGroupsConfig::default(),
            user_skill_groups: UserSkillGroupsConfig::default(),
            close_button_behavior: default_close_button_behavior(),
            hooks: AgentHooksConfig::default(),
            worktrees: WorktreeSettings::default(),
        }
    }
}

impl Default for AppLoggingConfig {
    fn default() -> Self {
        Self {
            // Set to Debug in early development for easier diagnostics
            level: "debug".to_string(),
            include_sensitive_diagnostics: true,
            flow_chat_diagnostics: false,
            model_exchange_tracing: ModelExchangeTracingConfig::default(),
        }
    }
}

impl Default for ModelExchangeTracingConfig {
    fn default() -> Self {
        Self {
            mode: ModelExchangeTracingMode::Off,
        }
    }
}

impl Default for AIExperienceConfig {
    fn default() -> Self {
        Self {
            enable_session_title_generation: true,
            enable_welcome_panel_ai_analysis: false,
            enable_visual_mode: false,
            enable_agent_companion: true,
            agent_companion_pet: default_agent_companion_pet(),
            enable_workspace_search: false,
            voice_input: VoiceInputConfig::default(),
            quick_actions: default_quick_actions(),
        }
    }
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "Consolas, \"Courier New\", monospace".to_string(),
            font_weight: "normal".to_string(),
            line_height: 1.5,
            cursor_style: "line".to_string(),
            cursor_blinking: "smooth".to_string(),
            render_whitespace: "selection".to_string(),
            render_line_highlight: "line".to_string(),
            tab_size: 4,
            insert_spaces: true,
            detect_indentation: true,
            word_wrap: "off".to_string(),
            scroll_beyond_last_line: false,
            smooth_scrolling: true,
            line_numbers: "on".to_string(),
            minimap: MinimapConfig {
                enabled: true,
                side: "right".to_string(),
                size: "proportional".to_string(),
            },
            auto_save: "afterDelay".to_string(),
            auto_save_delay: 1000,
            format_on_save: true,
            format_on_paste: true,
            trim_auto_whitespace: true,
            semantic_highlighting: true,
            bracket_pair_colorization: true,
        }
    }
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            default_shell: String::new(),
            terminal_panel_position: "right".to_string(),
            font_size: 14,
            font_family: "Consolas, \"Courier New\", monospace".to_string(),
            cursor_blink: true,
            cursor_style: "block".to_string(),
            scrollback: 1000,
        }
    }
}

impl Default for WorkspaceConfig {
    fn default() -> Self {
        Self {
            exclude_patterns: vec![
                "**/node_modules/**".to_string(),
                "**/target/**".to_string(),
                "**/.git/**".to_string(),
                "**/dist/**".to_string(),
                "**/build/**".to_string(),
            ],
            include_patterns: vec!["**/*".to_string()],
            watch_ignore: vec![
                "**/node_modules/**".to_string(),
                "**/target/**".to_string(),
                "**/.git/**".to_string(),
            ],
            max_file_size: 50 * 1024 * 1024,
            encoding: "utf8".to_string(),
            line_ending: "auto".to_string(),
            trim_trailing_whitespace: true,
            insert_final_newline: true,
        }
    }
}

impl Default for AIConfig {
    fn default() -> Self {
        Self {
            models: vec![],
            task_models: TaskModelsConfig::default(),
            default_models: DefaultModelsConfig::default(),
            agent_model_defaults: AgentModelDefaultsConfig::default(),
            agent_profiles: std::collections::HashMap::new(),
            skill_settings: SkillSettingsConfig::default(),
            review_teams: default_review_team_configs(),
            review_team_rate_limit_status: default_review_team_rate_limit_status(),
            subagent_max_concurrency: default_subagent_max_concurrency(),
            swarm_max_concurrency: default_swarm_max_concurrency(),
            subagent_batch_execution_policy: default_subagent_batch_execution_policy(),
            proxy: ProxyConfig::default(),
            stream_idle_timeout_secs: default_stream_idle_timeout(),
            stream_ttft_timeout_secs: default_stream_ttft_timeout(),
            tool_execution_timeout_secs: default_tool_execution_timeout(),
            enable_deferred_tool_loading: default_enable_deferred_tool_loading(),
            enable_context_compression_prefetch: true,
            allow_tool_json_repair: true,
            computer_use_enabled: false,
            browser_control_preferred_browser: String::new(),
            web_search: WebSearchConfig::default(),
            browser_control_auto_connect_on_startup: false,
            max_rounds: default_max_rounds(),
        }
    }
}

impl Default for MemoriesConfig {
    fn default() -> Self {
        Self {
            generate_memories: false,
            generate_for_btw_sessions: false,
            use_memories: false,
            external_context_policy: MemoryExternalContextPolicy::ClearToolResults,
            max_raw_memories_for_consolidation: default_memory_max_raw_memories_for_consolidation(),
            max_unused_days: default_memory_max_unused_days(),
            max_rollout_age_days: default_memory_max_rollout_age_days(),
            max_rollouts_per_startup: default_memory_max_rollouts_per_startup(),
            max_rollouts_scan_limit: default_memory_max_rollouts_scan_limit(),
            min_rollout_idle_hours: default_memory_min_rollout_idle_hours(),
            phase1_max_concurrency: default_memory_phase1_max_concurrency(),
            phase1_retry_backoff_minutes: default_memory_phase1_retry_backoff_minutes(),
            phase1_lease_seconds: default_memory_phase1_lease_seconds(),
            phase2_lease_seconds: default_memory_phase2_lease_seconds(),
            phase2_success_cooldown_seconds: default_memory_phase2_success_cooldown_seconds(),
            phase2_retry_delay_seconds: default_memory_phase2_retry_delay_seconds(),
            extract_model: None,
            consolidation_model: None,
        }
    }
}

impl Default for AIModelConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            provider: String::new(),
            model_name: String::new(),
            base_url: String::new(),
            request_url: None,
            api_key: String::new(),
            context_window: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
            enabled: false,
            category: ModelCategory::GeneralChat,
            capabilities: vec![],
            recommended_for: vec![],
            metadata: None,
            reasoning: None,
            inline_think_in_text: true,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
            auth: AuthConfig::ApiKey,
        }
    }
}

impl Default for SidebarConfig {
    fn default() -> Self {
        Self {
            width: 300,
            collapsed: false,
        }
    }
}

impl Default for RightPanelConfig {
    fn default() -> Self {
        Self {
            width: 400,
            collapsed: true,
        }
    }
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            position: "topRight".to_string(),
            duration: 5000,
            dialog_completion_notify: true,
            permission_request_notify: true,
            enable_startup_tips: true,
        }
    }
}

impl Default for MinimapConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            side: "right".to_string(),
            size: "proportional".to_string(),
        }
    }
}

impl AIModelConfig {
    pub fn supports_capability(&self, capability: ModelCapability) -> bool {
        if self.capabilities.is_empty() {
            self.default_capabilities_for_category()
                .contains(&capability)
        } else {
            self.capabilities.contains(&capability)
        }
    }

    pub fn supports_text_generation(&self) -> bool {
        self.supports_capability(ModelCapability::TextChat)
    }

    /// Canonicalizes fields that only have meaning for text-generation
    /// requests. Returns the names of fields that were cleared.
    pub fn normalize_inapplicable_generation_fields(&mut self) -> Vec<&'static str> {
        if self.supports_text_generation() {
            return Vec::new();
        }

        let mut cleared = Vec::new();
        if self.context_window.take().is_some() {
            cleared.push("context_window");
        }
        if self.max_tokens.take().is_some() {
            cleared.push("max_tokens");
        }
        if self.temperature.take().is_some() {
            cleared.push("temperature");
        }
        if self.top_p.take().is_some() {
            cleared.push("top_p");
        }
        cleared
    }

    pub fn supports_image_understanding(&self) -> bool {
        self.supports_capability(ModelCapability::ImageUnderstanding)
    }

    fn default_capabilities_for_category(&self) -> Vec<ModelCapability> {
        match self.category {
            ModelCategory::GeneralChat => vec![ModelCapability::TextChat],
            ModelCategory::Multimodal => {
                vec![
                    ModelCapability::TextChat,
                    ModelCapability::ImageUnderstanding,
                ]
            }
            ModelCategory::ImageGeneration => vec![ModelCapability::ImageGeneration],
            ModelCategory::Embedding => vec![ModelCapability::Embedding],
            ModelCategory::SearchEnhanced => {
                vec![ModelCapability::TextChat, ModelCapability::Search]
            }
            ModelCategory::CodeSpecialized => {
                vec![ModelCapability::TextChat, ModelCapability::CodeSpecialized]
            }
            ModelCategory::SpeechRecognition => vec![ModelCapability::SpeechRecognition],
        }
    }

    /// Auto-completes missing capability information without rewriting explicit configuration.
    ///
    /// Important: we intentionally do not upgrade `category` or append inferred capabilities
    /// based on the model name here. Runtime behavior should follow explicit configuration.
    pub fn ensure_category_and_capabilities(&mut self) {
        if self.capabilities.is_empty() {
            self.capabilities = self.default_capabilities_for_category();
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn global_skill_settings_keep_legacy_values_and_project_scope_on_round_trip() {
        let legacy = r#"{"globally_disabled_user_skills":["user::home.agents::review"]}"#;
        let mut settings: super::SkillSettingsConfig = serde_json::from_str(legacy).unwrap();
        assert!(settings.globally_disabled_project_skills.is_empty());
        assert_eq!(
            serde_json::to_value(&settings).unwrap(),
            serde_json::from_str::<serde_json::Value>(legacy).unwrap()
        );
        settings.globally_disabled_project_skills.insert(
            "/workspace/a".into(),
            vec!["project::agents::review".into()],
        );
        let restored: super::SkillSettingsConfig =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            restored.globally_disabled_user_skills,
            ["user::home.agents::review"]
        );
        assert_eq!(
            restored.globally_disabled_project_skills["/workspace/a"],
            ["project::agents::review"]
        );
        assert!(!restored
            .globally_disabled_project_skills
            .contains_key("/workspace/b"));
    }

    #[test]
    fn companion_pet_legacy_selection_round_trip_preserves_missing_version() {
        let legacy = serde_json::json!({
            "id": "sample", "displayName": "Sample", "source": "user",
            "packagePath": "/pets/sample", "spritesheetPath": "/pets/sample/spritesheet.webp",
            "spritesheetMimeType": "image/webp"
        });
        let selection: super::AgentCompanionPetSelection =
            serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(selection.sprite_version_number, None);
        assert_eq!(serde_json::to_value(&selection).unwrap(), legacy);
        for version in [1, 2, 3] {
            let mut payload = legacy.clone();
            payload["spriteVersionNumber"] = serde_json::json!(version);
            let selection: super::AgentCompanionPetSelection =
                serde_json::from_value(payload.clone()).unwrap();
            assert_eq!(selection.sprite_version_number, Some(version));
            // Unknown future versions remain on disk; the renderer decides support.
            assert_eq!(serde_json::to_value(selection).unwrap(), payload);
        }
    }

    use super::{
        AIConfig, AIExperienceConfig, AIModelConfig, AgentModelDefaultsConfig, AgentProfileConfig,
        AgentProfileView, AppConfig, AppLoggingConfig, AuthConfig, ChatInputDefaultModeStrategy,
        EditorConfig, GlobalConfig, MemoryExternalContextPolicy, ModelExchangeTracingMode,
        NotificationConfig, OpenCodePlan, SubagentBatchExecutionPolicy, SubagentModelSelection,
        SubscriptionProvider, UserSkillGroupsConfig, UserToolGroupsConfig, WebSearchConfig,
    };
    use openbitfun_product_domains::tool_permissions::ToolPermissionConfig;

    fn current_global_config_with(overrides: serde_json::Value) -> serde_json::Value {
        let mut value =
            serde_json::to_value(GlobalConfig::default()).expect("default config should serialize");
        let root = value
            .as_object_mut()
            .expect("default config should serialize as an object");
        for (key, value) in overrides
            .as_object()
            .expect("config fixture overrides must be an object")
        {
            root.insert(key.clone(), value.clone());
        }
        value
    }

    #[test]
    fn legacy_app_config_defaults_realtime_voice_call() {
        let config: AppConfig = serde_json::from_value(serde_json::json!({}))
            .expect("legacy app config should deserialize");

        assert!(!config.voice_call.enabled);
        assert_eq!(config.voice_call.provider, "volcengine");
        assert!(config.voice_call.api_key.is_empty());
        assert_eq!(config.voice_call.voice, "zh_female_vv_jupiter_bigtts");
    }

    #[test]
    fn persisted_realtime_voice_call_enabled_survives_default_change() {
        let config: AppConfig = serde_json::from_value(serde_json::json!({
            "voice_call": {
                "enabled": true,
                "api_key": "legacy-controller-key"
            }
        }))
        .expect("saved realtime voice config should deserialize");

        assert!(config.voice_call.enabled);
        assert_eq!(config.voice_call.api_key, "legacy-controller-key");
        assert_eq!(config.voice_call.provider, "volcengine");
        assert_eq!(config.voice_call.voice, "zh_female_vv_jupiter_bigtts");
    }

    #[test]
    fn prevent_sleep_defaults_to_disabled() {
        assert!(!AppConfig::default().prevent_sleep);

        let config: AppConfig =
            serde_json::from_value(serde_json::json!({})).expect("empty app config should default");
        assert!(!config.prevent_sleep);
    }

    #[test]
    fn current_config_rejects_retired_flow_chat_font_data() {
        let value = current_global_config_with(serde_json::json!({
            "font": {
                "uiSize": {
                    "level": "large"
                },
                "flowChat": {
                    "mode": "independent",
                    "basePx": 20
                }
            }
        }));
        let error = super::validate_current_config_value(&value, "Configuration fixture")
            .expect_err("retired FlowChat font data must not enter the current runtime");
        assert!(error.to_string().contains("font.flowChat"));
    }

    #[test]
    fn subscription_auth_preserves_legacy_opencode_and_roundtrips_go_plan() {
        let legacy: AuthConfig = serde_json::from_value(serde_json::json!({
            "type": "subscription",
            "provider": "opencode"
        }))
        .expect("legacy OpenCode auth should deserialize");
        assert_eq!(
            legacy,
            AuthConfig::Subscription {
                provider: SubscriptionProvider::Opencode,
                plan: None,
            }
        );
        assert_eq!(
            serde_json::to_value(&legacy).expect("legacy auth should serialize"),
            serde_json::json!({
                "type": "subscription",
                "provider": "opencode"
            })
        );

        let go = AuthConfig::Subscription {
            provider: SubscriptionProvider::Opencode,
            plan: Some(OpenCodePlan::Go),
        };
        let serialized = serde_json::to_value(&go).expect("Go auth should serialize");
        assert_eq!(serialized["plan"], "go");
        assert_eq!(
            serde_json::from_value::<AuthConfig>(serialized).expect("Go auth should roundtrip"),
            go
        );
    }

    #[test]
    fn grok_subscription_auth_roundtrips_without_opencode_plan() {
        let grok = AuthConfig::Subscription {
            provider: SubscriptionProvider::Grok,
            plan: None,
        };
        let serialized = serde_json::to_value(&grok).expect("Grok auth should serialize");
        assert_eq!(
            serialized,
            serde_json::json!({
                "type": "subscription",
                "provider": "grok"
            })
        );
        assert_eq!(
            serde_json::from_value::<AuthConfig>(serialized).expect("Grok auth should deserialize"),
            grok
        );
    }

    #[test]
    fn hermes_subscription_auth_roundtrips_without_opencode_plan() {
        let hermes = AuthConfig::Subscription {
            provider: SubscriptionProvider::Hermes,
            plan: None,
        };
        let serialized = serde_json::to_value(&hermes).expect("Hermes auth should serialize");
        assert_eq!(
            serialized,
            serde_json::json!({
                "type": "subscription",
                "provider": "hermes"
            })
        );
        assert_eq!(
            serde_json::from_value::<AuthConfig>(serialized)
                .expect("Hermes auth should deserialize"),
            hermes
        );
    }

    #[test]
    fn plugin_config_defaults_to_empty_when_missing() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({})))
                .expect("current global config should apply optional plugin defaults");

        assert!(config.plugin.is_empty());
        assert!(!config.has_configured_plugins());
    }

    #[test]
    fn non_empty_plugin_config_requests_runtime_startup() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "plugin": [
                    "file:///C:/plugins/demo.mjs",
                    {
                        "spec": "@my-org/custom-plugin",
                        "options": { "mode": "strict" },
                        "baseDirectory": "C:/workspace"
                    }
                ]
            })))
            .expect("plugin config should deserialize");

        assert_eq!(config.plugin.len(), 2);
        assert!(config.has_configured_plugins());
    }

    #[test]
    fn empty_plugin_specs_do_not_request_runtime_startup() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "plugin": ["", "   ", { "spec": "" }]
            })))
            .expect("empty plugin declarations should deserialize");

        assert!(!config.has_configured_plugins());
    }

    #[test]
    fn permission_request_notifications_default_to_enabled() {
        assert!(NotificationConfig::default().permission_request_notify);

        let config: NotificationConfig = serde_json::from_value(serde_json::json!({}))
            .expect("empty notification config should default");
        assert!(config.permission_request_notify);
    }

    #[test]
    fn agent_profile_defaults_keep_all_collections_empty() {
        let config = AgentProfileConfig::default();
        assert!(config.profile_id.is_empty());
        assert!(config.added_tools.is_empty());
        assert!(config.removed_tools.is_empty());
        assert!(config.disabled_user_skills.is_empty());
        assert!(config.enabled_user_skills.is_empty());
        assert!(config.subagent_overrides.is_empty());
        assert!(config.tool_permission_rules.is_empty());

        let view = AgentProfileView::default();
        assert!(view.profile_id.is_empty());
        assert!(view.enabled_tools.is_empty());
        assert!(view.default_tools.is_empty());
        assert!(view.disabled_user_skills.is_empty());
        assert!(view.enabled_user_skills.is_empty());
    }

    #[test]
    fn legacy_agent_profile_defaults_permission_rules_and_omits_empty_field() {
        let config: AgentProfileConfig = serde_json::from_value(serde_json::json!({
            "profile_id": "Standard",
            "added_tools": ["read"]
        }))
        .expect("legacy agent profile should deserialize");

        assert!(config.tool_permission_rules.is_empty());
        let serialized = serde_json::to_value(config).expect("agent profile should serialize");
        assert!(serialized.get("tool_permission_rules").is_none());
    }

    #[test]
    fn current_global_config_defaults_optional_permission_settings() {
        let mut current = current_global_config_with(serde_json::json!({}));
        current
            .as_object_mut()
            .expect("current config object")
            .remove("tool_permissions");
        let config: GlobalConfig = serde_json::from_value(current)
            .expect("missing optional permission settings should use current defaults");

        assert_eq!(config.tool_permissions, ToolPermissionConfig::default());
    }

    #[test]
    fn missing_max_rounds_defaults_to_unlimited_and_explicit_limits_survive() {
        let mut default_value = current_global_config_with(serde_json::json!({}));
        default_value["ai"]
            .as_object_mut()
            .expect("current AI config")
            .remove("max_rounds");
        let defaulted: GlobalConfig = serde_json::from_value(default_value)
            .expect("current AI config should default an omitted optional limit");
        assert_eq!(defaulted.ai.max_rounds, 0);

        let limited: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "ai": { "max_rounds": 37 }
            })))
            .expect("explicit max rounds should deserialize");
        assert_eq!(limited.ai.max_rounds, 37);
    }

    #[test]
    fn user_tool_groups_default_to_version_one_without_persisted_groups() {
        let mut value = current_global_config_with(serde_json::json!({}));
        value["app"]
            .as_object_mut()
            .expect("current app config")
            .remove("user_tool_groups");
        let config: GlobalConfig = serde_json::from_value(value)
            .expect("current app config should default omitted tool groups");
        assert_eq!(config.app.user_tool_groups, UserToolGroupsConfig::default());

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert!(serialized["app"].get("user_tool_groups").is_none());
    }

    #[test]
    fn user_tool_groups_preserve_the_versioned_ui_shape() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "user_tool_groups": {
                        "version": 1,
                        "groups": [{
                            "id": "daily-code",
                            "name": "Daily code changes",
                            "toolNames": ["Read", "Edit"]
                        }]
                    }
                }
            })))
            .expect("user tool groups should deserialize");

        assert_eq!(
            config.app.user_tool_groups.groups[0].tool_names,
            vec!["Read".to_string(), "Edit".to_string()]
        );

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(
            serialized["app"]["user_tool_groups"]["groups"][0]["toolNames"],
            serde_json::json!(["Read", "Edit"])
        );
    }

    #[test]
    fn user_skill_groups_default_to_version_one_without_persisted_groups() {
        let mut value = current_global_config_with(serde_json::json!({}));
        value["app"]
            .as_object_mut()
            .expect("current app config")
            .remove("user_skill_groups");
        let config: GlobalConfig = serde_json::from_value(value)
            .expect("current app config should default omitted skill groups");
        assert_eq!(
            config.app.user_skill_groups,
            UserSkillGroupsConfig::default()
        );

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert!(serialized["app"].get("user_skill_groups").is_none());
    }

    #[test]
    fn user_skill_groups_preserve_the_versioned_ui_shape() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "user_skill_groups": {
                        "version": 1,
                        "groups": [{
                            "id": "daily-coding",
                            "name": "Daily coding",
                            "skillKeys": ["builtin::find-skills", "user::review"]
                        }]
                    }
                }
            })))
            .expect("user skill groups should deserialize");

        assert_eq!(
            config.app.user_skill_groups.groups[0].skill_keys,
            vec![
                "builtin::find-skills".to_string(),
                "user::review".to_string()
            ]
        );

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(
            serialized["app"]["user_skill_groups"]["groups"][0]["skillKeys"],
            serde_json::json!(["builtin::find-skills", "user::review"])
        );
    }

    #[test]
    fn global_config_preserves_project_mcp_servers() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "project": {
                    "mcp_servers": [
                        {
                            "id": "project-docs",
                            "name": "Project Docs",
                            "server_type": "local",
                            "command": "docs-mcp",
                            "args": []
                        }
                    ]
                }
            })))
            .expect("project scoped MCP config should deserialize");

        assert_eq!(
            config
                .project
                .mcp_servers
                .as_ref()
                .and_then(|value| value.as_array())
                .map(Vec::len),
            Some(1)
        );

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(
            serialized["project"]["mcp_servers"][0]["id"],
            "project-docs"
        );
    }

    #[test]
    fn global_config_preserves_terminal_panel_position() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "terminal": {
                    "terminal_panel_position": "bottom"
                }
            })))
            .expect("terminal panel position config should deserialize");

        assert_eq!(config.terminal.terminal_panel_position, "bottom");

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(serialized["terminal"]["terminal_panel_position"], "bottom");
    }

    #[test]
    fn global_config_serialization_uses_appearance_selection() {
        let serialized =
            serde_json::to_value(GlobalConfig::default()).expect("config should serialize");

        assert!(
            serialized.get("theme").is_none(),
            "Rust config must not export the removed GUI theme schema"
        );
        assert!(serialized.get("themes").is_none());
        assert_eq!(serialized["appearance"]["selection"], "system");
    }

    #[test]
    fn defaults_agent_companion_pet_to_blue_golden() {
        let config: AIExperienceConfig =
            serde_json::from_value(serde_json::json!({})).expect("empty config should default");

        let pet = config
            .agent_companion_pet
            .as_ref()
            .expect("default companion pet should be present");
        assert_eq!(pet.id, "blue-golden");
        assert_eq!(pet.display_name, "困困");
        assert_eq!(pet.package_path, "/agent-companion-pets/blue-golden");
        assert_eq!(
            pet.spritesheet_path,
            "/agent-companion-pets/blue-golden/spritesheet.png"
        );
        assert_eq!(pet.spritesheet_mime_type, "image/png");
    }

    #[test]
    fn preserves_selected_agent_companion_pet() {
        let config: AIExperienceConfig = serde_json::from_value(serde_json::json!({
            "enable_session_title_generation": true,
            "enable_welcome_panel_ai_analysis": false,
            "enable_visual_mode": false,
            "enable_agent_companion": true,
            "agent_companion_pet": {
                "id": "boxcat",
                "displayName": "Boxcat",
                "description": "A tiny cat tucked inside a cardboard box for cozy coding sessions.",
                "source": "preset",
                "packagePath": "/agent-companion-pets/boxcat",
                "spritesheetPath": "/agent-companion-pets/boxcat/spritesheet.webp",
                "spritesheetMimeType": "image/webp"
            }
        }))
        .expect("AI experience config with selected companion pet should deserialize");

        let pet = config
            .agent_companion_pet
            .as_ref()
            .expect("selected companion pet should be retained");
        assert_eq!(pet.id, "boxcat");
        assert_eq!(pet.display_name, "Boxcat");
        assert_eq!(pet.package_path, "/agent-companion-pets/boxcat");

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(serialized["agent_companion_pet"]["displayName"], "Boxcat");
        assert_eq!(
            serialized["agent_companion_pet"]["spritesheetPath"],
            "/agent-companion-pets/boxcat/spritesheet.webp"
        );
    }

    #[test]
    fn quick_action_defaults_do_not_replace_an_explicit_legacy_empty_list() {
        let absent: AIExperienceConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(absent.quick_actions.len(), 2);
        let cleared: AIExperienceConfig = serde_json::from_value(serde_json::json!({
            "quick_actions": []
        }))
        .unwrap();
        assert!(cleared.quick_actions.is_empty());
        let round_trip: AIExperienceConfig =
            serde_json::from_value(serde_json::to_value(cleared).unwrap()).unwrap();
        assert!(round_trip.quick_actions.is_empty());
    }

    #[test]
    fn ai_experience_quick_actions_round_trip_through_global_config() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "language": "en-US",
                    "auto_update": true,
                    "telemetry": true,
                    "startup_behavior": "default",
                    "confirm_on_exit": true,
                    "restore_windows": false,
                    "zoom_level": 100,
                    "sidebar": { "width": 260, "collapsed": false },
                    "right_panel": { "width": 400, "collapsed": true },
                    "notifications": {
                        "enabled": true,
                        "position": "top-right",
                        "duration": 4000,
                        "dialog_completion_notify": true,
                        "permission_request_notify": false,
                        "enable_startup_tips": true
                    },
                    "ai_experience": {
                        "enable_session_title_generation": true,
                        "enable_welcome_panel_ai_analysis": false,
                        "enable_visual_mode": false,
                        "enable_agent_companion": true,
                        "enable_workspace_search": false,
                        "quick_actions": [
                            {
                                "id": "custom_1",
                                "label": "Run tests",
                                "prompt": "Run the test suite",
                                "enabled": true
                            }
                        ]
                    }
                }
            })))
            .expect("minimal app config with quick_actions should deserialize");

        let actions = &config.app.ai_experience.quick_actions;
        assert!(!config.app.notifications.permission_request_notify);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].id, "custom_1");
        assert_eq!(actions[0].label, "Run tests");

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(
            serialized["app"]["ai_experience"]["quick_actions"][0]["id"],
            "custom_1"
        );
        assert_eq!(
            serialized["app"]["notifications"]["permission_request_notify"],
            false
        );
    }

    #[test]
    fn current_config_rejects_retired_app_session_config() {
        let value = current_global_config_with(serde_json::json!({
            "app": {
                "session_config": {
                    "default_mode": "cowork"
                }
            }
        }));
        let error = super::validate_current_config_value(&value, "Configuration fixture")
            .expect_err("retired app session config must not enter the current runtime");
        assert!(error.to_string().contains("app.session_config"));
    }

    #[test]
    fn app_flow_chat_default_mode_id_round_trips() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "flow_chat": {
                        "default_mode_id": "PlannerPlus"
                    }
                }
            })))
            .expect("flow chat config should deserialize");

        assert_eq!(
            config.app.flow_chat.default_mode_id.as_deref(),
            Some("PlannerPlus")
        );
        assert_eq!(config.app.flow_chat.default_mode_strategy, None);
        assert_eq!(config.app.flow_chat.last_mode_id, None);

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(
            serialized["app"]["flow_chat"]["default_mode_id"],
            "PlannerPlus"
        );
    }

    #[test]
    fn app_flow_chat_default_mode_preference_is_additive_and_round_trips() {
        let untouched: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": { "flow_chat": {} }
            })))
            .expect("flow chat config without a preference should deserialize");
        assert_eq!(untouched.app.flow_chat.default_mode_strategy, None);
        assert_eq!(untouched.app.flow_chat.default_mode_id, None);
        assert_eq!(untouched.app.flow_chat.last_mode_id, None);

        let configured: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "flow_chat": {
                        "default_mode_strategy": "follow_last",
                        "default_mode_id": "Ultimate",
                        "last_mode_id": "Creative"
                    }
                }
            })))
            .expect("flow chat mode preference should deserialize");
        assert_eq!(
            configured.app.flow_chat.default_mode_strategy,
            Some(ChatInputDefaultModeStrategy::FollowLast)
        );
        assert_eq!(
            configured.app.flow_chat.default_mode_id.as_deref(),
            Some("Ultimate")
        );
        assert_eq!(
            configured.app.flow_chat.last_mode_id.as_deref(),
            Some("Creative")
        );

        let serialized = serde_json::to_value(configured).expect("config should serialize");
        assert_eq!(
            serialized["app"]["flow_chat"]["default_mode_strategy"],
            "follow_last"
        );
        assert_eq!(serialized["app"]["flow_chat"]["last_mode_id"], "Creative");
    }

    #[test]
    fn removing_agent_mode_references_preserves_the_configured_default_policy() {
        let mut legacy_fixed = super::AppFlowChatConfig {
            default_mode_strategy: None,
            default_mode_id: Some("PlannerPlus".to_string()),
            last_mode_id: Some("PlannerPlus".to_string()),
            ..Default::default()
        };
        legacy_fixed.remove_mode_reference("PlannerPlus");
        assert_eq!(
            legacy_fixed.default_mode_strategy,
            Some(ChatInputDefaultModeStrategy::Fixed)
        );
        assert_eq!(legacy_fixed.default_mode_id, None);
        assert_eq!(legacy_fixed.last_mode_id, None);

        let mut follow_last = super::AppFlowChatConfig {
            default_mode_strategy: Some(ChatInputDefaultModeStrategy::FollowLast),
            default_mode_id: Some("PlannerPlus".to_string()),
            last_mode_id: Some("Creative".to_string()),
            ..Default::default()
        };
        follow_last.remove_mode_reference("PlannerPlus");
        assert_eq!(
            follow_last.default_mode_strategy,
            Some(ChatInputDefaultModeStrategy::FollowLast)
        );
        assert_eq!(follow_last.default_mode_id, None);
        assert_eq!(follow_last.last_mode_id.as_deref(), Some("Creative"));
    }

    #[test]
    fn app_flow_chat_permission_mode_control_defaults_to_visible_without_persisting_default() {
        let default_config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "flow_chat": {}
                }
            })))
            .expect("flow chat config without visibility preference should deserialize");

        assert!(default_config.app.flow_chat.show_permission_mode_control);
        let default_serialized =
            serde_json::to_value(&default_config).expect("config should serialize");
        assert!(default_serialized["app"]["flow_chat"]
            .get("show_permission_mode_control")
            .is_none());

        let hidden_config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "app": {
                    "flow_chat": {
                        "show_permission_mode_control": false
                    }
                }
            })))
            .expect("flow chat config with hidden permission control should deserialize");

        assert!(!hidden_config.app.flow_chat.show_permission_mode_control);
        let hidden_serialized =
            serde_json::to_value(&hidden_config).expect("config should serialize");
        assert_eq!(
            hidden_serialized["app"]["flow_chat"]["show_permission_mode_control"],
            false
        );
    }

    #[test]
    fn default_model_serialization_contains_no_retired_reasoning_fields() {
        let config = AIModelConfig::default();
        let value = serde_json::to_value(&config).expect("config should serialize");

        assert!(value.get("enable_thinking_process").is_none());
        assert!(value.get("reasoning_mode").is_none());
        assert!(value.get("reasoning_effort").is_none());
        assert!(value.get("thinking_budget_tokens").is_none());
        assert!(value.get("reasoning").is_none());
    }

    #[test]
    fn default_model_config_enables_inline_think_in_text() {
        let config = AIModelConfig::default();
        assert!(config.inline_think_in_text);
    }

    #[test]
    fn deserializes_missing_inline_think_in_text_as_enabled() {
        let config: AIModelConfig = serde_json::from_value(serde_json::json!({
            "id": "model_1",
            "name": "Provider",
            "provider": "openai",
            "model_name": "test-model",
            "base_url": "https://example.com/v1",
            "api_key": "key",
            "enabled": true
        }))
        .expect("config without inline_think_in_text should deserialize");

        assert!(config.inline_think_in_text);
    }

    #[test]
    fn default_ai_config_uses_generous_stream_timeouts() {
        let config = AIConfig::default();

        assert_eq!(config.stream_idle_timeout_secs, Some(600));
        assert_eq!(config.stream_ttft_timeout_secs, Some(600));
        assert!(config.enable_deferred_tool_loading);
        assert!(config.enable_context_compression_prefetch);
        assert!(config.allow_tool_json_repair);
        assert_eq!(config.subagent_max_concurrency, 5);
        assert_eq!(config.swarm_max_concurrency, 16);
        assert_eq!(
            config.subagent_batch_execution_policy,
            SubagentBatchExecutionPolicy::ForceParallel
        );
        let review_team = config
            .review_teams
            .get("default")
            .expect("default review team config should exist");
        assert_eq!(review_team.reviewer_timeout_seconds, 3600);
        assert_eq!(review_team.judge_timeout_seconds, 2400);
        assert!(!review_team.auto_fix_enabled);
        assert_eq!(review_team.strategy_level, "normal");
        assert!(review_team.member_strategy_overrides.is_empty());
        assert_eq!(config.review_team_rate_limit_status, serde_json::json!({}));
        assert_eq!(config.agent_model_defaults.mode, "primary");
        assert_eq!(
            config.agent_model_defaults.subagents.default_selection,
            SubagentModelSelection::fixed("fast")
        );
        assert_eq!(
            config
                .agent_model_defaults
                .subagents
                .builtin
                .get("GeneralPurpose"),
            Some(&SubagentModelSelection::fixed("primary"))
        );
        assert_eq!(
            config
                .agent_model_defaults
                .subagents
                .builtin
                .get("ResearchSpecialist"),
            Some(&SubagentModelSelection::Inherit)
        );
        assert_eq!(
            config.agent_model_defaults.subagents.fork,
            SubagentModelSelection::Inherit
        );
    }

    #[test]
    fn compression_prefetch_defaults_on_omits_default_and_preserves_opt_out() {
        let old: AIConfig = serde_json::from_value(serde_json::json!({"max_rounds": 42})).unwrap();
        assert!(old.enable_context_compression_prefetch);
        let mut payload = serde_json::to_value(&old).unwrap();
        assert!(payload.get("enable_context_compression_prefetch").is_none());
        payload["enable_context_compression_prefetch"] = serde_json::json!(true);
        let enabled: AIConfig = serde_json::from_value(payload).unwrap();
        assert!(enabled.enable_context_compression_prefetch);
        assert!(serde_json::to_value(&enabled)
            .unwrap()
            .get("enable_context_compression_prefetch")
            .is_none());
        let reloaded: AIConfig =
            serde_json::from_value(serde_json::to_value(enabled).unwrap()).unwrap();
        assert!(reloaded.enable_context_compression_prefetch);
        assert_eq!(reloaded.max_rounds, 42);
        let disabled: AIConfig = serde_json::from_value(serde_json::json!({
            "enable_context_compression_prefetch": false
        }))
        .unwrap();
        let payload = serde_json::to_value(disabled).unwrap();
        assert_eq!(payload["enable_context_compression_prefetch"], false);
        let reloaded: AIConfig = serde_json::from_value(payload).unwrap();
        assert!(!reloaded.enable_context_compression_prefetch);
    }

    #[test]
    fn subagent_model_selection_uses_a_tagged_persistent_shape() {
        let selection = SubagentModelSelection::fixed("fast");
        assert_eq!(
            serde_json::to_value(selection).expect("selection should serialize"),
            serde_json::json!({ "kind": "fixed", "model_id": "fast" })
        );

        let inherited: SubagentModelSelection = serde_json::from_value(serde_json::json!({
            "kind": "inherit"
        }))
        .expect("inherit selection should deserialize");
        assert_eq!(inherited, SubagentModelSelection::Inherit);
    }

    #[test]
    fn mode_model_selector_preserves_configured_ids_on_round_trip() {
        for (stored, expected) in [
            ("custom-selector", "custom-selector"),
            ("primary", "primary"),
            ("fast", "fast"),
            ("custom-model", "custom-model"),
        ] {
            let mut value = serde_json::to_value(GlobalConfig::default()).unwrap();
            value["ai"]["agent_model_defaults"]["mode"] = serde_json::json!(stored);
            let config: GlobalConfig = serde_json::from_value(value).unwrap();
            assert_eq!(config.ai.agent_model_defaults.mode, expected);
            let saved = serde_json::to_value(&config).unwrap();
            assert_eq!(saved["ai"]["agent_model_defaults"]["mode"], expected);
            let reloaded: GlobalConfig = serde_json::from_value(saved).unwrap();
            assert_eq!(reloaded.ai.agent_model_defaults.mode, expected);
        }
        let missing: AgentModelDefaultsConfig =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(missing.mode, "primary");
        assert!(serde_json::from_value::<AgentModelDefaultsConfig>(
            serde_json::json!({"mode": 42})
        )
        .is_err());
    }

    #[test]
    fn builtin_subagent_without_override_uses_the_shared_default() {
        let mut defaults = AgentModelDefaultsConfig::default();
        defaults.subagents.default_selection = SubagentModelSelection::fixed("primary");

        assert_eq!(
            defaults.builtin_subagent_selection("Explore"),
            SubagentModelSelection::fixed("primary")
        );
    }

    #[test]
    fn general_purpose_uses_primary_unless_explicitly_overridden() {
        let mut defaults = AgentModelDefaultsConfig::default();

        assert_eq!(
            defaults.builtin_subagent_selection("GeneralPurpose"),
            SubagentModelSelection::fixed("primary")
        );

        defaults.subagents.builtin.insert(
            "GeneralPurpose".to_string(),
            SubagentModelSelection::fixed("fast"),
        );
        assert_eq!(
            defaults.builtin_subagent_selection("GeneralPurpose"),
            SubagentModelSelection::fixed("fast")
        );
    }

    #[test]
    fn research_specialist_inherits_parent_unless_explicitly_overridden() {
        let mut defaults = AgentModelDefaultsConfig::default();

        assert_eq!(
            defaults.builtin_subagent_selection("ResearchSpecialist"),
            SubagentModelSelection::Inherit
        );

        defaults.subagents.builtin.insert(
            "ResearchSpecialist".to_string(),
            SubagentModelSelection::fixed("fast"),
        );
        assert_eq!(
            defaults.builtin_subagent_selection("ResearchSpecialist"),
            SubagentModelSelection::fixed("fast")
        );
    }

    #[test]
    fn editor_indentation_defaults_and_legacy_round_trip() {
        let defaults: EditorConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults.tab_size, 4);
        assert!(defaults.insert_spaces);
        assert!(defaults.detect_indentation);

        // Old explicit preferences must not be reset during an upgrade.
        let legacy = serde_json::json!({ "tab_size": 2, "insert_spaces": false });
        let config: EditorConfig = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(config.tab_size, 2);
        assert!(!config.insert_spaces);
        assert!(config.detect_indentation);
        let saved = serde_json::to_value(&config).unwrap();
        for (key, value) in legacy.as_object().unwrap() {
            assert_eq!(&saved[key], value);
        }
        let mut explicit = saved;
        explicit["detect_indentation"] = serde_json::json!(false);
        let config: EditorConfig = serde_json::from_value(explicit.clone()).unwrap();
        assert!(!config.detect_indentation);
        assert_eq!(serde_json::to_value(config).unwrap(), explicit);
    }

    #[test]
    fn current_editor_config_defaults_new_optional_visual_fields() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "editor": {
                    "font_size": 16,
                    "font_family": "Fixture Mono",
                    "line_height": 1.4
                }
            })))
            .expect("current editor config should default optional visual fields");

        assert_eq!(config.editor.font_size, 16);
        assert_eq!(config.editor.font_family, "Fixture Mono");
        assert_eq!(config.editor.font_weight, "normal");
        assert_eq!(config.editor.cursor_style, "line");
        assert_eq!(config.editor.cursor_blinking, "smooth");
        assert_eq!(config.editor.render_whitespace, "selection");
        assert_eq!(config.editor.render_line_highlight, "line");
        assert!(!config.editor.scroll_beyond_last_line);
        assert!(config.editor.smooth_scrolling);
        assert!(config.editor.semantic_highlighting);
        assert!(config.editor.bracket_pair_colorization);
    }

    #[test]
    fn editor_visual_fields_survive_a_persisted_round_trip() {
        let mut config = GlobalConfig::default();
        config.editor.font_weight = "bold".to_string();
        config.editor.cursor_style = "block-outline".to_string();
        config.editor.cursor_blinking = "solid".to_string();
        config.editor.render_whitespace = "all".to_string();
        config.editor.render_line_highlight = "gutter".to_string();
        config.editor.scroll_beyond_last_line = true;
        config.editor.smooth_scrolling = false;
        config.editor.semantic_highlighting = false;
        config.editor.bracket_pair_colorization = false;

        let restored: GlobalConfig = serde_json::from_value(
            serde_json::to_value(config).expect("editor config should serialize"),
        )
        .expect("editor config should deserialize");

        assert_eq!(restored.editor.font_weight, "bold");
        assert_eq!(restored.editor.cursor_style, "block-outline");
        assert_eq!(restored.editor.cursor_blinking, "solid");
        assert_eq!(restored.editor.render_whitespace, "all");
        assert_eq!(restored.editor.render_line_highlight, "gutter");
        assert!(restored.editor.scroll_beyond_last_line);
        assert!(!restored.editor.smooth_scrolling);
        assert!(!restored.editor.semantic_highlighting);
        assert!(!restored.editor.bracket_pair_colorization);
    }

    #[test]
    fn default_global_config_includes_enabled_memories_config() {
        let config = GlobalConfig::default();

        assert!(!config.memories.generate_memories);
        assert!(!config.memories.generate_for_btw_sessions);
        assert!(!config.memories.use_memories);
        assert_eq!(
            config.memories.external_context_policy,
            MemoryExternalContextPolicy::ClearToolResults
        );
        assert_eq!(config.memories.max_raw_memories_for_consolidation, 64);
        assert_eq!(config.memories.max_unused_days, 30);
        assert_eq!(config.memories.max_rollout_age_days, 10);
        assert_eq!(config.memories.max_rollouts_per_startup, 2);
        assert_eq!(config.memories.max_rollouts_scan_limit, 2_000);
        assert_eq!(config.memories.min_rollout_idle_hours, 6);
        assert_eq!(config.memories.phase1_max_concurrency, 1);
        assert_eq!(config.memories.phase1_retry_backoff_minutes, 60);
        assert_eq!(config.memories.phase1_lease_seconds, 60 * 60);
        assert_eq!(config.memories.phase2_lease_seconds, 60 * 60);
        assert_eq!(config.memories.phase2_success_cooldown_seconds, 6 * 60 * 60);
        assert_eq!(config.memories.phase2_retry_delay_seconds, 60 * 60);
        assert_eq!(config.memories.extract_model, None);
        assert_eq!(config.memories.consolidation_model, None);
    }

    #[test]
    fn deserializes_explicit_memories_config() {
        let config: GlobalConfig =
            serde_json::from_value(current_global_config_with(serde_json::json!({
                "memories": {
                    "generate_memories": false,
                    "generate_for_btw_sessions": true,
                    "use_memories": false,
                    "external_context_policy": "skip_session",
                    "max_raw_memories_for_consolidation": 12,
                    "max_unused_days": 7,
                    "max_rollout_age_days": 14,
                    "max_rollouts_per_startup": 8,
                    "max_rollouts_scan_limit": 200,
                    "min_rollout_idle_hours": 12,
                    "phase1_max_concurrency": 3,
                    "phase1_retry_backoff_minutes": 45,
                    "phase1_lease_seconds": 600,
                    "phase2_lease_seconds": 1200,
                    "phase2_success_cooldown_seconds": 7200,
                    "phase2_retry_delay_seconds": 300,
                    "extract_model": "extractor",
                    "consolidation_model": "consolidator"
                }
            })))
            .expect("global config with memories section should deserialize");

        assert!(!config.memories.generate_memories);
        assert!(config.memories.generate_for_btw_sessions);
        assert!(!config.memories.use_memories);
        assert_eq!(
            config.memories.external_context_policy,
            MemoryExternalContextPolicy::SkipSession
        );
        assert_eq!(config.memories.max_raw_memories_for_consolidation, 12);
        assert_eq!(config.memories.max_unused_days, 7);
        assert_eq!(config.memories.max_rollout_age_days, 14);
        assert_eq!(config.memories.max_rollouts_per_startup, 8);
        assert_eq!(config.memories.max_rollouts_scan_limit, 200);
        assert_eq!(config.memories.min_rollout_idle_hours, 12);
        assert_eq!(config.memories.phase1_max_concurrency, 3);
        assert_eq!(config.memories.phase1_retry_backoff_minutes, 45);
        assert_eq!(config.memories.phase1_lease_seconds, 600);
        assert_eq!(config.memories.phase2_lease_seconds, 1200);
        assert_eq!(config.memories.phase2_success_cooldown_seconds, 7200);
        assert_eq!(config.memories.phase2_retry_delay_seconds, 300);
        assert_eq!(config.memories.extract_model.as_deref(), Some("extractor"));
        assert_eq!(
            config.memories.consolidation_model.as_deref(),
            Some("consolidator")
        );
    }

    #[test]
    fn deserializes_missing_stream_timeouts_as_generous_defaults() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config without stream_idle_timeout_secs should deserialize");

        assert_eq!(config.stream_idle_timeout_secs, Some(600));
        assert_eq!(config.stream_ttft_timeout_secs, Some(600));
        assert!(config.allow_tool_json_repair);
        assert_eq!(config.subagent_max_concurrency, 5);
        assert_eq!(config.swarm_max_concurrency, 16);
        assert_eq!(
            config.subagent_batch_execution_policy,
            SubagentBatchExecutionPolicy::ForceParallel
        );
        assert!(config.review_teams.contains_key("default"));
    }

    #[test]
    fn task_models_default_to_fast() {
        let config = AIConfig::default();

        assert_eq!(
            config.task_models.session_title.fixed_model_id(),
            Some("fast")
        );
        assert_eq!(config.task_models.git_commit.fixed_model_id(), Some("fast"));
    }

    #[test]
    fn preserves_explicit_disabled_tool_json_repair() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "allow_tool_json_repair": false,
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config with an explicit JSON repair setting should deserialize");

        assert!(!config.allow_tool_json_repair);
    }

    #[test]
    fn deserializes_explicit_null_stream_ttft_timeout_as_none() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "proxy": {
                "enabled": false,
                "url": ""
            },
            "stream_ttft_timeout_secs": null
        }))
        .expect("config with explicit null stream_ttft_timeout_secs should deserialize");

        assert_eq!(config.stream_ttft_timeout_secs, None);
        assert_eq!(config.stream_idle_timeout_secs, Some(600));
    }

    #[test]
    fn app_logging_defaults_to_sensitive_diagnostics_enabled() {
        let config: AppLoggingConfig = serde_json::from_value(serde_json::json!({
            "level": "trace"
        }))
        .expect("logging config without sensitive preference should deserialize");

        assert!(config.include_sensitive_diagnostics);
        assert!(!config.flow_chat_diagnostics);
        assert_eq!(
            config.model_exchange_tracing.mode,
            ModelExchangeTracingMode::Off
        );
    }

    #[test]
    fn deserializes_explicit_subagent_max_concurrency() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "subagent_max_concurrency": 9,
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config with subagent_max_concurrency should deserialize");

        assert_eq!(config.subagent_max_concurrency, 9);
    }

    #[test]
    fn deserializes_explicit_swarm_max_concurrency() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "func_agent_models": {},
            "default_models": {},
            "agent_profiles": {},
            "swarm_max_concurrency": 24,
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config with swarm_max_concurrency should deserialize");

        assert_eq!(config.swarm_max_concurrency, 24);
    }

    #[test]
    fn deserializes_explicit_subagent_batch_execution_policy() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "subagent_batch_execution_policy": "force_parallel",
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config with subagent_batch_execution_policy should deserialize");

        assert_eq!(
            config.subagent_batch_execution_policy,
            SubagentBatchExecutionPolicy::ForceParallel
        );
    }

    #[test]
    fn deserializes_mode_profiles_with_null_entries() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {
                "Claw": null,
                "Cowork": {
                    "profile_id": "Cowork",
                    "removed_tools": ["shell"]
                }
            },
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config with null mode config entries should deserialize");

        assert!(!config.agent_profiles.contains_key("Claw"));
        assert_eq!(
            config
                .agent_profiles
                .get("Cowork")
                .expect("non-null mode config should be retained")
                .removed_tools,
            vec!["shell".to_string()]
        );
    }

    #[test]
    fn deserializes_explicit_default_review_team_config() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "review_teams": {
                "default": {
                    "extra_subagent_ids": ["ExtraReviewer"],
                    "reviewer_timeout_seconds": 120,
                    "judge_timeout_seconds": 90,
                    "strategy_level": "deep",
                    "member_strategy_overrides": {
                        "ReviewSecurity": "quick",
                        "ExtraReviewer": "normal"
                    },
                    "auto_fix_enabled": false
                }
            },
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("config with review_teams should deserialize");

        let review_team = config
            .review_teams
            .get("default")
            .expect("default review team config should be retained");
        assert_eq!(review_team.extra_subagent_ids, vec!["ExtraReviewer"]);
        assert_eq!(review_team.reviewer_timeout_seconds, 120);
        assert_eq!(review_team.judge_timeout_seconds, 90);
        assert_eq!(review_team.strategy_level, "deep");
        assert_eq!(
            review_team.member_strategy_overrides.get("ReviewSecurity"),
            Some(&"quick".to_string())
        );
        assert_eq!(
            review_team.member_strategy_overrides.get("ExtraReviewer"),
            Some(&"normal".to_string())
        );
        assert!(!review_team.auto_fix_enabled);

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        assert_eq!(
            serialized["review_teams"]["default"]["strategy_level"],
            "deep"
        );
        assert_eq!(
            serialized["review_teams"]["default"]["member_strategy_overrides"]["ReviewSecurity"],
            "quick"
        );
    }

    #[test]
    fn preserves_review_team_concurrency_fields_through_config_round_trip() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "default_models": {},
            "agent_profiles": {},
            "review_teams": {
                "default": {
                    "extra_subagent_ids": [],
                    "strategy_level": "normal",
                    "member_strategy_overrides": {},
                    "reviewer_timeout_seconds": 3600,
                    "judge_timeout_seconds": 2400,
                    "reviewer_file_split_threshold": 20,
                    "max_same_role_instances": 3,
                    "max_retries_per_role": 1,
                    "max_parallel_reviewers": 1,
                    "max_queue_wait_seconds": 0,
                    "allow_provider_capacity_queue": true,
                    "allow_bounded_auto_retry": false,
                    "auto_retry_elapsed_guard_seconds": 180
                }
            },
            "proxy": {
                "enabled": false,
                "url": ""
            }
        }))
        .expect("review team concurrency config should deserialize");

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        let stored = &serialized["review_teams"]["default"];
        assert_eq!(stored["max_retries_per_role"], serde_json::json!(1));
        assert_eq!(stored["max_parallel_reviewers"], serde_json::json!(1));
        assert_eq!(stored["max_queue_wait_seconds"], serde_json::json!(0));
        assert_eq!(
            stored["allow_provider_capacity_queue"],
            serde_json::json!(true)
        );
        assert_eq!(stored["allow_bounded_auto_retry"], serde_json::json!(false));
        assert_eq!(
            stored["auto_retry_elapsed_guard_seconds"],
            serde_json::json!(180)
        );
    }

    #[test]
    fn missing_review_team_concurrency_fields_use_product_defaults() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "review_teams": {
                "default": {
                    "strategy_level": "normal"
                }
            }
        }))
        .expect("legacy review team config should deserialize");

        let serialized = serde_json::to_value(&config).expect("config should serialize");
        let stored = &serialized["review_teams"]["default"];
        assert_eq!(stored["max_retries_per_role"], serde_json::json!(1));
        assert_eq!(stored["max_parallel_reviewers"], serde_json::json!(2));
        assert_eq!(stored["max_queue_wait_seconds"], serde_json::json!(1200));
        assert_eq!(
            stored["allow_provider_capacity_queue"],
            serde_json::json!(true)
        );
        assert_eq!(stored["allow_bounded_auto_retry"], serde_json::json!(false));
        assert_eq!(
            stored["auto_retry_elapsed_guard_seconds"],
            serde_json::json!(180)
        );
    }

    #[test]
    fn review_team_auxiliary_config_is_not_stored_inside_review_team_map() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": [],
            "review_teams": {
                "default": {
                    "strategy_level": "normal"
                }
            },
            "review_team_rate_limit_status": {
                "remaining": 2
            },
        }))
        .expect("review team auxiliary config should deserialize");

        assert!(config.review_teams.contains_key("default"));
        assert!(!config.review_teams.contains_key("rate_limit_status"));
        assert_eq!(
            config.review_team_rate_limit_status["remaining"],
            serde_json::json!(2)
        );
        let serialized =
            serde_json::to_value(&config).expect("review team auxiliary config should serialize");
        assert!(serialized["review_teams"]["rate_limit_status"].is_null());
    }

    #[test]
    fn legacy_ai_config_defaults_web_search_to_free_exa() {
        let config: AIConfig = serde_json::from_value(serde_json::json!({
            "models": []
        }))
        .expect("legacy AI config should deserialize");

        assert_eq!(config.web_search.provider, "exa_mcp_free");
        assert_eq!(
            config.web_search.providers.exa_search_api.credential_id,
            "exa-search-api"
        );
    }

    #[test]
    fn web_search_config_preserves_unknown_provider_and_fields() {
        let config: WebSearchConfig = serde_json::from_value(serde_json::json!({
            "provider": "future_search",
            "providers": {
                "exa_search_api": {
                    "credentialId": "exa-device-ref",
                    "futureOption": true
                },
                "future_search": {
                    "endpoint": "https://future.example/search"
                }
            },
            "selectionRevision": 7
        }))
        .expect("future WebSearch config should deserialize");

        let serialized = serde_json::to_value(config).expect("WebSearch config should serialize");
        assert_eq!(serialized["provider"], "future_search");
        assert_eq!(serialized["selectionRevision"], 7);
        assert_eq!(
            serialized["providers"]["exa_search_api"]["futureOption"],
            true
        );
        assert_eq!(
            serialized["providers"]["future_search"]["endpoint"],
            "https://future.example/search"
        );
    }
}

use serde_json::Value;

fn config_validation_message(message: String) -> String {
    message
}

pub fn validate_openbitfun_product_identity(
    persisted_product_id: &str,
    context: &str,
) -> Result<(), String> {
    let expected_product_id = product_identity::product_id();
    if persisted_product_id != expected_product_id {
        return Err(config_validation_message(format!(
            "{context} product_id must be '{expected_product_id}', found '{persisted_product_id}'"
        )));
    }

    Ok(())
}

pub fn validate_current_config_value(value: &Value, context: &str) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| config_validation_message(format!("{context} must be a JSON object")))?;
    let product_id = root
        .get("product_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            config_validation_message(format!(
                "{context} is missing required string field 'product_id'"
            ))
        })?;
    let schema_version = root
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            config_validation_message(format!(
                "{context} is missing required integer field 'schema_version'"
            ))
        })?;
    if schema_version != u64::from(CURRENT_CONFIG_SCHEMA_VERSION) {
        return Err(config_validation_message(format!(
            "{context} schema_version must be {CURRENT_CONFIG_SCHEMA_VERSION}, found {schema_version}"
        )));
    }
    root.get("version").and_then(Value::as_str).ok_or_else(|| {
        config_validation_message(format!(
            "{context} is missing required string field 'version'"
        ))
    })?;
    if !root.contains_key("last_modified") {
        return Err(config_validation_message(format!(
            "{context} is missing required field 'last_modified'"
        )));
    }
    validate_openbitfun_product_identity(product_id, context)?;
    reject_retired_config_fields(root, context)
}

fn retired_config_field(context: &str, path: &str) -> String {
    config_validation_message(format!(
        "{context} contains retired pre-OpenBitFun field '{path}'; use the explicit data migration tool instead"
    ))
}

fn reject_retired_config_fields(
    root: &serde_json::Map<String, Value>,
    context: &str,
) -> Result<(), String> {
    if let Some(app) = root.get("app").and_then(Value::as_object) {
        for field in ["session", "session_config"] {
            if app.contains_key(field) {
                return Err(retired_config_field(context, &format!("app.{field}")));
            }
        }
        if app
            .get("ai_experience")
            .and_then(Value::as_object)
            .is_some_and(|ai_experience| ai_experience.contains_key("agent_companion_display_mode"))
        {
            return Err(retired_config_field(
                context,
                "app.ai_experience.agent_companion_display_mode",
            ));
        }
    }
    if root
        .get("font")
        .and_then(Value::as_object)
        .is_some_and(|font| font.contains_key("flowChat"))
    {
        return Err(retired_config_field(context, "font.flowChat"));
    }

    let Some(ai) = root.get("ai").and_then(Value::as_object) else {
        return Ok(());
    };
    for field in ["agent_models", "skip_tool_confirmation"] {
        if ai.contains_key(field) {
            return Err(retired_config_field(context, &format!("ai.{field}")));
        }
    }
    if ai
        .get("review_teams")
        .and_then(Value::as_object)
        .is_some_and(|review_teams| review_teams.contains_key("rate_limit_status"))
    {
        return Err(retired_config_field(
            context,
            "ai.review_teams.rate_limit_status",
        ));
    }

    if let Some(models) = ai.get("models").and_then(Value::as_array) {
        for (index, model) in models.iter().enumerate() {
            let Some(model) = model.as_object() else {
                continue;
            };
            for field in [
                "enable_thinking_process",
                "reasoning_mode",
                "reasoning_effort",
                "thinking_budget_tokens",
            ] {
                if model.contains_key(field) {
                    return Err(retired_config_field(
                        context,
                        &format!("ai.models[{index}].{field}"),
                    ));
                }
            }
        }
    }

    Ok(())
}
