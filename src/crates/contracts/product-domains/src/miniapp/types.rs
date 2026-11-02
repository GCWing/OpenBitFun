//! MiniApp types — data model and permissions (V2: ESM UI + Node Worker).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// ESM dependency for Import Map (browser UI).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EsmDep {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// NPM dependency for Worker (package.json).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NpmDep {
    pub name: String,
    pub version: String,
}

/// MiniApp source: UI layer (browser) + Worker layer (Node.js).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MiniAppSource {
    pub html: String,
    pub css: String,
    /// ESM module code running in the browser.
    #[serde(rename = "ui_js")]
    pub ui_js: String,
    #[serde(default, rename = "esm_dependencies")]
    pub esm_dependencies: Vec<EsmDep>,
    /// Node.js Worker logic (source/worker.js).
    #[serde(rename = "worker_js")]
    pub worker_js: String,
    #[serde(default, rename = "npm_dependencies")]
    pub npm_dependencies: Vec<NpmDep>,
}

/// Permissions manifest (resolved to policy for JS Worker).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MiniAppPermissions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs: Option<FsPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net: Option<NetPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<NodePermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationPermissions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<HostPermissions>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsPermissions {
    /// Path scopes: "{appdata}", "{workspace}", "{home}", or absolute paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellPermissions {
    /// Command allowlist (e.g. ["git", "ffmpeg"]). Empty = all forbidden.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetPermissions {
    /// Domain allowlist. "*" = all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
}

/// Node.js Worker permissions (memory, timeout).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodePermissions {
    #[serde(default = "default_node_enabled")]
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory_mb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

fn default_node_enabled() -> bool {
    true
}

/// AI permissions — controls access to the host application's AI client.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiPermissions {
    /// Whether AI access is enabled for this MiniApp.
    #[serde(default)]
    pub enabled: bool,
    /// Allowed model references (e.g. ["primary", "fast"] or specific model ids).
    /// Empty or absent means only "primary" is allowed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_models: Option<Vec<String>>,
    /// Maximum output tokens per single request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_per_request: Option<u32>,
    /// Maximum number of AI requests per minute (per app).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_per_minute: Option<u32>,
}

/// Full agent-run permissions for MiniApps.
///
/// Unlike `AiPermissions` (raw single-call LLM access), this grants the MiniApp the
/// ability to run complete host agent turns (agent loop with tools such as
/// WebSearch/WebFetch and skills) through the host agent bridge.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPermissions {
    /// Whether full agent-run access is enabled for this MiniApp.
    #[serde(default)]
    pub enabled: bool,
    /// Maximum number of agent runs per minute (per app). 0 / absent = unlimited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limit_per_minute: Option<u32>,
}

/// Host notification permissions for MiniApps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationPermissions {
    #[serde(default)]
    pub system: bool,
}

/// Trusted-host UI capabilities. Marketplace MiniApps default-deny every
/// capability in this group when the field is absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostPermissions {
    #[serde(default)]
    pub dialog: bool,
    #[serde(default)]
    pub clipboard_read: bool,
    #[serde(default)]
    pub clipboard_write: bool,
    #[serde(default)]
    pub open_external: bool,
    #[serde(default)]
    pub reveal_in_folder: bool,
    #[serde(default)]
    pub deck_render: bool,
    #[serde(default)]
    pub chat_composer: bool,
    #[serde(default)]
    pub system_info: bool,
}

/// Per-locale overrides for user-facing strings (gallery name / description / tags).
///
/// Lives optionally in `meta.json` as `i18n.locales[<locale-id>]`. Whichever fields are
/// present override the top-level `name`/`description`/`tags`; missing fields fall back
/// to the top-level value (which itself acts as the default / fallback locale).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MiniAppLocaleStrings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// MiniApp i18n bundle.
///
/// Map key is a locale id (e.g. `"zh-CN"`, `"en-US"`). The frontend picks the best
/// match using `currentLanguage → "en-US" → "zh-CN" → top-level name/description`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MiniAppI18n {
    #[serde(default)]
    pub locales: HashMap<String, MiniAppLocaleStrings>,
}

/// AI context for iteration (stored in meta, not in compiled HTML).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MiniAppAiContext {
    pub original_prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub iteration_history: Vec<String>,
}

/// Runtime lifecycle state persisted in meta.json.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MiniAppRuntimeState {
    /// Revision used for UI / source lifecycle changes.
    pub source_revision: String,
    /// Stable hash of the persisted MiniApp content, excluding version/runtime metadata.
    ///
    /// Direct file edits leave this value unchanged until the MiniApp is finalized,
    /// which lets the lifecycle distinguish a real content update from a recompile.
    pub content_hash: String,
    /// Revision derived from npm dependencies.
    pub deps_revision: String,
    /// Dependencies changed and need install before reliable worker startup.
    pub deps_dirty: bool,
    /// Worker should be restarted on next runtime use.
    pub worker_restart_required: bool,
    /// UI assets should be recompiled before next render.
    pub ui_recompile_required: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MiniAppRuntimeProfile {
    #[default]
    Compatibility,
    MarketStrict,
}

/// Full MiniApp entity (in-memory / API).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiniApp {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub version: u32,
    pub created_at: i64,
    pub updated_at: i64,

    pub source: MiniAppSource,
    /// Assembled HTML with Import Map + Runtime Adapter (generated by compiler).
    pub compiled_html: String,

    #[serde(default)]
    pub permissions: MiniAppPermissions,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_context: Option<MiniAppAiContext>,

    #[serde(default)]
    pub runtime: MiniAppRuntimeState,

    #[serde(default)]
    pub runtime_profile: MiniAppRuntimeProfile,

    /// Optional per-locale overrides for `name` / `description` / `tags`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n: Option<MiniAppI18n>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome: Option<crate::miniapp::chrome::MiniAppChrome>,
}

/// MiniApp metadata only (for list views; no source/compiled_html).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiniAppMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub version: u32,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub permissions: MiniAppPermissions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_context: Option<MiniAppAiContext>,
    #[serde(default)]
    pub runtime: MiniAppRuntimeState,
    #[serde(default)]
    pub runtime_profile: MiniAppRuntimeProfile,
    /// Optional per-locale overrides for `name` / `description` / `tags`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n: Option<MiniAppI18n>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome: Option<crate::miniapp::chrome::MiniAppChrome>,
}

impl From<&MiniApp> for MiniAppMeta {
    fn from(app: &MiniApp) -> Self {
        Self {
            id: app.id.clone(),
            name: app.name.clone(),
            description: app.description.clone(),
            icon: app.icon.clone(),
            category: app.category.clone(),
            tags: app.tags.clone(),
            version: app.version,
            created_at: app.created_at,
            updated_at: app.updated_at,
            permissions: app.permissions.clone(),
            ai_context: app.ai_context.clone(),
            runtime: app.runtime.clone(),
            runtime_profile: app.runtime_profile,
            i18n: app.i18n.clone(),
            chrome: app.chrome.clone(),
        }
    }
}

/// Path scope for permission policy resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathScope {
    AppData,
    Workspace,
    UserSelected,
    Home,
    Custom(Vec<std::path::PathBuf>),
}

impl PathScope {
    pub fn from_manifest_value(s: &str) -> Self {
        match s {
            "{appdata}" => PathScope::AppData,
            "{workspace}" => PathScope::Workspace,
            "{user-selected}" => PathScope::UserSelected,
            "{home}" => PathScope::Home,
            _ => PathScope::Custom(vec![std::path::PathBuf::from(s)]),
        }
    }
}
