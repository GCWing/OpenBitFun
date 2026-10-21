//! Host boundary for desktop cards.
//!
//! Core owns the card contract and validation; the desktop adapter owns card
//! persistence, native windows, data refresh, and due notifications. Hosts that
//! cannot show windows outside the main surface never register a handler, so
//! the DesktopCard tool stays hidden there.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const DESKTOP_CARD_STORE_VERSION: u32 = 1;
pub const DESKTOP_CARD_MAX_CARDS: usize = 30;
pub const DESKTOP_CARD_MIN_WIDTH: f64 = 180.0;
pub const DESKTOP_CARD_MAX_WIDTH: f64 = 640.0;
pub const DESKTOP_CARD_MIN_HEIGHT: f64 = 96.0;
pub const DESKTOP_CARD_MAX_HEIGHT: f64 = 720.0;
pub const DESKTOP_CARD_MIN_REFRESH_SECONDS: u64 = 30;
pub const DESKTOP_CARD_MAX_REFRESH_SECONDS: u64 = 86_400;
pub const DESKTOP_CARD_DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 20;
pub const DESKTOP_CARD_MAX_COMMAND_TIMEOUT_SECONDS: u64 = 120;

const MAX_TITLE_CHARS: usize = 80;
const MAX_SUBTITLE_CHARS: usize = 160;
const MAX_NOTE_CHARS: usize = 4_000;
const MAX_CHECKLIST_ITEMS: usize = 50;
const MAX_CHECKLIST_ITEM_CHARS: usize = 300;
const MAX_METRIC_ITEMS: usize = 12;
const MAX_CUSTOM_HTML_BYTES: usize = 96 * 1024;
const MAX_DATA_BYTES: usize = 64 * 1024;
const MAX_URL_CHARS: usize = 2_048;
const MAX_COMMAND_CHARS: usize = 4_000;
const MAX_HEADERS: usize = 16;

pub const DESKTOP_CARD_ICONS: &[&str] = &[
    "activity",
    "alarm",
    "bell",
    "calendar",
    "check",
    "clock",
    "cloud",
    "code",
    "dollar",
    "flag",
    "git-pull-request",
    "globe",
    "info",
    "list",
    "note",
    "package",
    "rocket",
    "server",
    "star",
    "sun",
    "terminal",
    "timer",
    "trending-up",
    "zap",
];

pub const DESKTOP_CARD_TONES: &[&str] =
    &["neutral", "accent", "info", "success", "warning", "danger"];

const METRIC_FORMATS: &[&str] = &[
    "text",
    "number",
    "percent",
    "currency",
    "datetime",
    "relativeTime",
];

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardOrigin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DesktopCardSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DesktopCardPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardChecklistItem {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardMetricItem {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    /// JSON Pointer into the card data, for example `/current/temperature_2m`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digits: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    /// Maps the resolved value (as text) to a tone, for example `{"MERGED":"success"}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone_map: Option<BTreeMap<String, String>>,
    /// Colors positive numbers as success and negative numbers as danger.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sign_tone: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint_path: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub emphasis: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DesktopCardTemplateKind {
    #[serde(rename_all = "camelCase")]
    Countdown {
        target_at_ms: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default = "default_true")]
        notify: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notified_at_ms: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Checklist {
        #[serde(default)]
        items: Vec<DesktopCardChecklistItem>,
    },
    #[serde(rename_all = "camelCase")]
    Note { text: String },
    #[serde(rename_all = "camelCase")]
    Progress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status_path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Metrics {
        #[serde(default)]
        items: Vec<DesktopCardMetricItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        layout: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    CronJob { job_id: String },
    #[serde(rename_all = "camelCase")]
    Custom { html: String },
}

impl DesktopCardTemplateKind {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Countdown { .. } => "countdown",
            Self::Checklist { .. } => "checklist",
            Self::Note { .. } => "note",
            Self::Progress { .. } => "progress",
            Self::Metrics { .. } => "metrics",
            Self::CronJob { .. } => "cronJob",
            Self::Custom { .. } => "custom",
        }
    }

    pub fn default_size(&self) -> DesktopCardSize {
        let (width, height) = match self {
            Self::Countdown { .. } => (260.0, 150.0),
            Self::Checklist { .. } => (280.0, 260.0),
            Self::Note { .. } => (280.0, 200.0),
            Self::Progress { .. } => (280.0, 150.0),
            Self::Metrics { .. } => (300.0, 210.0),
            Self::CronJob { .. } => (280.0, 170.0),
            Self::Custom { .. } => (320.0, 240.0),
        };
        DesktopCardSize { width, height }
    }
}

/// Templates written by a newer build stay intact instead of failing the store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesktopCardTemplate {
    Known(DesktopCardTemplateKind),
    Unknown(Value),
}

impl DesktopCardTemplate {
    pub fn known(&self) -> Option<&DesktopCardTemplateKind> {
        match self {
            Self::Known(kind) => Some(kind),
            Self::Unknown(_) => None,
        }
    }

    pub fn kind(&self) -> String {
        match self {
            Self::Known(kind) => kind.kind().to_string(),
            Self::Unknown(value) => value
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopCardDataParse {
    #[default]
    Json,
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DesktopCardDataSourceKind {
    #[serde(rename_all = "camelCase")]
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
        interval_seconds: u64,
        #[serde(default)]
        parse: DesktopCardDataParse,
    },
    #[serde(rename_all = "camelCase")]
    Command {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        interval_seconds: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_seconds: Option<u64>,
        #[serde(default)]
        parse: DesktopCardDataParse,
    },
}

impl DesktopCardDataSourceKind {
    pub fn interval_seconds(&self) -> u64 {
        match self {
            Self::Http {
                interval_seconds, ..
            }
            | Self::Command {
                interval_seconds, ..
            } => *interval_seconds,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesktopCardDataSource {
    Known(DesktopCardDataSourceKind),
    Unknown(Value),
}

impl DesktopCardDataSource {
    pub fn known(&self) -> Option<&DesktopCardDataSourceKind> {
        match self {
            Self::Known(kind) => Some(kind),
            Self::Unknown(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardDataSnapshot {
    pub fetched_at_ms: i64,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// stderr of a command that still exited successfully; partial failures
    /// inside a script often surface only here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCardRecord {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    pub template: DesktopCardTemplate,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source: Option<DesktopCardDataSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<DesktopCardSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<DesktopCardPosition>,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default = "default_true")]
    pub always_on_top: bool,
    #[serde(default)]
    pub origin: DesktopCardOrigin,
    #[serde(default)]
    pub created_at_ms: i64,
    #[serde(default)]
    pub updated_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_data: Option<DesktopCardDataSnapshot>,
    /// Fields written by newer builds survive a rewrite by this build.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Validated fields for a new card. The host assigns id, timestamps, and placement.
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopCardDraft {
    pub title: String,
    pub subtitle: Option<String>,
    pub icon: Option<String>,
    pub accent: Option<String>,
    pub template: DesktopCardTemplateKind,
    pub data: Value,
    pub data_source: Option<DesktopCardDataSourceKind>,
    pub link: Option<String>,
    pub size: Option<DesktopCardSize>,
    pub always_on_top: bool,
}

/// Validated update. `Some(None)` clears an optional field.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DesktopCardPatch {
    pub title: Option<String>,
    pub subtitle: Option<Option<String>>,
    pub icon: Option<Option<String>>,
    pub accent: Option<Option<String>>,
    pub template: Option<DesktopCardTemplateKind>,
    pub data: Option<Value>,
    pub data_merge: Option<Map<String, Value>>,
    pub data_source: Option<Option<DesktopCardDataSourceKind>>,
    pub link: Option<Option<String>>,
    pub size: Option<DesktopCardSize>,
    pub always_on_top: Option<bool>,
}

impl DesktopCardPatch {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// Applies the patch to a stored record. The caller re-validates sizes and
    /// timestamps that depend on host state.
    pub fn apply_to(&self, record: &mut DesktopCardRecord) {
        if let Some(title) = &self.title {
            record.title = title.clone();
        }
        if let Some(subtitle) = &self.subtitle {
            record.subtitle = subtitle.clone();
        }
        if let Some(icon) = &self.icon {
            record.icon = icon.clone();
        }
        if let Some(accent) = &self.accent {
            record.accent = accent.clone();
        }
        if let Some(template) = &self.template {
            record.template = DesktopCardTemplate::Known(template.clone());
        }
        if let Some(data) = &self.data {
            record.data = data.clone();
        }
        if let Some(merge) = &self.data_merge {
            if !record.data.is_object() {
                record.data = Value::Object(Map::new());
            }
            if let Some(object) = record.data.as_object_mut() {
                for (key, value) in merge {
                    if value.is_null() {
                        object.remove(key);
                    } else {
                        object.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        if let Some(data_source) = &self.data_source {
            let changed = record
                .data_source
                .as_ref()
                .and_then(DesktopCardDataSource::known)
                != data_source.as_ref();
            record.data_source = data_source.clone().map(DesktopCardDataSource::Known);
            if changed {
                record.last_data = None;
            }
        }
        if let Some(link) = &self.link {
            record.link = link.clone();
        }
        if let Some(size) = self.size {
            record.size = Some(size);
        }
        if let Some(always_on_top) = self.always_on_top {
            record.always_on_top = always_on_top;
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DesktopCardHostRequest {
    Create {
        draft: DesktopCardDraft,
        origin: DesktopCardOrigin,
    },
    Update {
        card_id: String,
        patch: DesktopCardPatch,
    },
    List,
    Get {
        card_id: String,
    },
    Show {
        card_id: String,
    },
    Hide {
        card_id: String,
    },
    Delete {
        card_id: String,
    },
    Refresh {
        card_id: String,
    },
}

impl DesktopCardHostRequest {
    pub fn action(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Update { .. } => "update",
            Self::List => "list",
            Self::Get { .. } => "get",
            Self::Show { .. } => "show",
            Self::Hide { .. } => "hide",
            Self::Delete { .. } => "delete",
            Self::Refresh { .. } => "refresh",
        }
    }
}

pub type DesktopCardFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;
pub type DesktopCardHandler =
    Arc<dyn Fn(DesktopCardHostRequest) -> DesktopCardFuture + Send + Sync>;

static DESKTOP_CARD_HANDLER: OnceLock<DesktopCardHandler> = OnceLock::new();

pub fn set_desktop_card_handler(handler: DesktopCardHandler) {
    let _ = DESKTOP_CARD_HANDLER.set(handler);
}

pub fn desktop_card_host_available() -> bool {
    DESKTOP_CARD_HANDLER.get().is_some()
}

pub async fn invoke_desktop_card_host(request: DesktopCardHostRequest) -> Result<Value, String> {
    let Some(handler) = DESKTOP_CARD_HANDLER.get() else {
        return Err("Desktop cards are available only in the OpenBitFun desktop app".to_string());
    };
    handler(request).await
}

/// Shell that runs command data sources on this computer, as shown to the model.
pub fn desktop_card_command_shell_label() -> &'static str {
    if cfg!(windows) {
        "Windows PowerShell 5.1 (powershell.exe -NoProfile -NonInteractive -Command)"
    } else {
        "/bin/sh -c (no login profile)"
    }
}

/// argv for a command data source. Profiles are skipped so an unattended
/// refresh never runs content the user did not approve; PowerShell output is
/// forced to UTF-8 like ExecCommand so non-ASCII output survives, and progress
/// records are silenced because they would otherwise reach stderr as CLIXML.
pub fn desktop_card_command_argv(command: &str) -> Vec<String> {
    use tool_runtime::exec_command::{exec_command_argv_for_isolated_shell, ExecCommandShellKind};
    if cfg!(windows) {
        exec_command_argv_for_isolated_shell(
            "powershell.exe",
            ExecCommandShellKind::PowerShell,
            &format!("$ProgressPreference='SilentlyContinue';\n{command}"),
        )
    } else {
        exec_command_argv_for_isolated_shell("/bin/sh", ExecCommandShellKind::Sh, command)
    }
}

/// JSON Pointers a template reads from the card data, with the field that declares each.
pub fn desktop_card_template_paths(template: &DesktopCardTemplateKind) -> Vec<(String, String)> {
    let mut paths = Vec::new();
    match template {
        DesktopCardTemplateKind::Progress {
            value_path,
            max_path,
            status_path,
            ..
        } => {
            for (field, path) in [
                ("valuePath", value_path),
                ("maxPath", max_path),
                ("statusPath", status_path),
            ] {
                if let Some(path) = path {
                    paths.push((field.to_string(), path.clone()));
                }
            }
        }
        DesktopCardTemplateKind::Metrics { items, .. } => {
            for item in items {
                if let Some(path) = &item.path {
                    paths.push((format!("metric `{}` path", item.label), path.clone()));
                }
                if let Some(path) = &item.hint_path {
                    paths.push((format!("metric `{}` hintPath", item.label), path.clone()));
                }
            }
        }
        _ => {}
    }
    paths
}

fn char_len(value: &str) -> usize {
    value.chars().count()
}

fn required_text(field: &str, value: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if char_len(trimmed) > max_chars {
        return Err(format!("{field} must be at most {max_chars} characters"));
    }
    Ok(trimmed.to_string())
}

fn optional_text(
    field: &str,
    value: Option<&str>,
    max_chars: usize,
) -> Result<Option<String>, String> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if char_len(value) > max_chars => {
            Err(format!("{field} must be at most {max_chars} characters"))
        }
        Some(value) => Ok(Some(value.to_string())),
        None => Ok(None),
    }
}

pub fn validate_icon(icon: Option<&str>) -> Result<Option<String>, String> {
    match icon.map(str::trim).filter(|value| !value.is_empty()) {
        Some(icon) if DESKTOP_CARD_ICONS.contains(&icon) => Ok(Some(icon.to_string())),
        Some(icon) => Err(format!(
            "icon `{icon}` is not supported; use one of: {}",
            DESKTOP_CARD_ICONS.join(", ")
        )),
        None => Ok(None),
    }
}

pub fn validate_tone(field: &str, tone: Option<&str>) -> Result<Option<String>, String> {
    match tone.map(str::trim).filter(|value| !value.is_empty()) {
        Some(tone) if DESKTOP_CARD_TONES.contains(&tone) => Ok(Some(tone.to_string())),
        Some(tone) => Err(format!(
            "{field} `{tone}` is not supported; use one of: {}",
            DESKTOP_CARD_TONES.join(", ")
        )),
        None => Ok(None),
    }
}

pub fn validate_web_url(field: &str, url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() || char_len(url) > MAX_URL_CHARS {
        return Err(format!(
            "{field} must be a non-empty URL of at most {MAX_URL_CHARS} characters"
        ));
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!("{field} must use http:// or https://"));
    }
    Ok(url.to_string())
}

fn validate_pointer(field: &str, pointer: Option<&str>) -> Result<Option<String>, String> {
    match pointer {
        Some("") => Ok(Some(String::new())),
        Some(pointer) if pointer.starts_with('/') => Ok(Some(pointer.to_string())),
        Some(pointer) => Err(format!(
            "{field} `{pointer}` must be a JSON Pointer such as `/items/0/price` (or empty for the whole value)"
        )),
        None => Ok(None),
    }
}

pub fn validate_data(data: &Value) -> Result<(), String> {
    let size = serde_json::to_vec(data)
        .map(|bytes| bytes.len())
        .unwrap_or(0);
    if size > MAX_DATA_BYTES {
        return Err(format!(
            "card data must be at most {} KiB when serialized",
            MAX_DATA_BYTES / 1024
        ));
    }
    Ok(())
}

pub fn validate_size(size: DesktopCardSize) -> Result<DesktopCardSize, String> {
    if !size.width.is_finite() || !size.height.is_finite() {
        return Err("card width and height must be finite numbers".to_string());
    }
    if !(DESKTOP_CARD_MIN_WIDTH..=DESKTOP_CARD_MAX_WIDTH).contains(&size.width) {
        return Err(format!(
            "card width must be between {DESKTOP_CARD_MIN_WIDTH} and {DESKTOP_CARD_MAX_WIDTH}"
        ));
    }
    if !(DESKTOP_CARD_MIN_HEIGHT..=DESKTOP_CARD_MAX_HEIGHT).contains(&size.height) {
        return Err(format!(
            "card height must be between {DESKTOP_CARD_MIN_HEIGHT} and {DESKTOP_CARD_MAX_HEIGHT}"
        ));
    }
    Ok(size)
}

pub fn clamp_size(size: DesktopCardSize) -> DesktopCardSize {
    let width = if size.width.is_finite() {
        size.width
    } else {
        DESKTOP_CARD_MIN_WIDTH
    };
    let height = if size.height.is_finite() {
        size.height
    } else {
        DESKTOP_CARD_MIN_HEIGHT
    };
    DesktopCardSize {
        width: width.clamp(DESKTOP_CARD_MIN_WIDTH, DESKTOP_CARD_MAX_WIDTH),
        height: height.clamp(DESKTOP_CARD_MIN_HEIGHT, DESKTOP_CARD_MAX_HEIGHT),
    }
}

pub fn validate_template(
    template: DesktopCardTemplateKind,
) -> Result<DesktopCardTemplateKind, String> {
    match template {
        DesktopCardTemplateKind::Countdown {
            target_at_ms,
            started_at_ms,
            message,
            notify,
            notified_at_ms,
        } => {
            if target_at_ms <= 0 {
                return Err("countdown targetAtMs must be a positive epoch timestamp".to_string());
            }
            Ok(DesktopCardTemplateKind::Countdown {
                target_at_ms,
                started_at_ms,
                message: optional_text(
                    "countdown message",
                    message.as_deref(),
                    MAX_SUBTITLE_CHARS,
                )?,
                notify,
                notified_at_ms,
            })
        }
        DesktopCardTemplateKind::Checklist { items } => {
            if items.len() > MAX_CHECKLIST_ITEMS {
                return Err(format!(
                    "checklist supports at most {MAX_CHECKLIST_ITEMS} items"
                ));
            }
            let mut seen = std::collections::HashSet::new();
            let mut normalized = Vec::with_capacity(items.len());
            for (index, item) in items.into_iter().enumerate() {
                let text =
                    required_text("checklist item text", &item.text, MAX_CHECKLIST_ITEM_CHARS)?;
                let mut id = item.id.trim().to_string();
                if id.is_empty() || !seen.insert(id.clone()) {
                    id = format!("item-{}", index + 1);
                    while !seen.insert(id.clone()) {
                        id.push('x');
                    }
                }
                normalized.push(DesktopCardChecklistItem {
                    id,
                    text,
                    done: item.done,
                });
            }
            Ok(DesktopCardTemplateKind::Checklist { items: normalized })
        }
        DesktopCardTemplateKind::Note { text } => {
            if char_len(&text) > MAX_NOTE_CHARS {
                return Err(format!(
                    "note text must be at most {MAX_NOTE_CHARS} characters"
                ));
            }
            Ok(DesktopCardTemplateKind::Note { text })
        }
        DesktopCardTemplateKind::Progress {
            value,
            max,
            value_path,
            max_path,
            status,
            status_path,
        } => {
            if value.is_some_and(|value| !value.is_finite())
                || max.is_some_and(|max| !max.is_finite() || max <= 0.0)
            {
                return Err("progress value must be finite and max must be positive".to_string());
            }
            if value.is_none() && value_path.is_none() {
                return Err(
                    "progress requires template.value or template.valuePath, for example {\"kind\":\"progress\",\"valuePath\":\"/done\",\"maxPath\":\"/total\"}"
                        .to_string(),
                );
            }
            Ok(DesktopCardTemplateKind::Progress {
                value,
                max,
                value_path: validate_pointer("progress valuePath", value_path.as_deref())?,
                max_path: validate_pointer("progress maxPath", max_path.as_deref())?,
                status: optional_text("progress status", status.as_deref(), MAX_SUBTITLE_CHARS)?,
                status_path: validate_pointer("progress statusPath", status_path.as_deref())?,
            })
        }
        DesktopCardTemplateKind::Metrics { items, layout } => {
            if items.is_empty() || items.len() > MAX_METRIC_ITEMS {
                return Err(format!(
                    "metrics requires template.items with 1 to {MAX_METRIC_ITEMS} entries inside the template object (not in data), for example {{\"kind\":\"metrics\",\"items\":[{{\"label\":\"Stars\",\"path\":\"/stars\",\"format\":\"number\"}}]}}"
                ));
            }
            if let Some(layout) = layout.as_deref() {
                if !matches!(layout, "list" | "grid") {
                    return Err("metrics layout must be list or grid".to_string());
                }
            }
            let mut normalized = Vec::with_capacity(items.len());
            for item in items {
                if item.value.is_none() && item.path.is_none() {
                    return Err(format!(
                        "metric `{}` requires value (static) or path (JSON Pointer into the card data, such as /stars)",
                        item.label.trim()
                    ));
                }
                if let Some(format) = item.format.as_deref() {
                    if !METRIC_FORMATS.contains(&format) {
                        return Err(format!(
                            "metric format `{format}` is not supported; use one of: {}",
                            METRIC_FORMATS.join(", ")
                        ));
                    }
                }
                if item.digits.is_some_and(|digits| digits > 8) {
                    return Err("metric digits must be at most 8".to_string());
                }
                if let Some(tone_map) = &item.tone_map {
                    for tone in tone_map.values() {
                        validate_tone("metric toneMap value", Some(tone))?;
                    }
                }
                normalized.push(DesktopCardMetricItem {
                    label: required_text("metric label", &item.label, MAX_TITLE_CHARS)?,
                    path: validate_pointer("metric path", item.path.as_deref())?,
                    hint_path: validate_pointer("metric hintPath", item.hint_path.as_deref())?,
                    tone: validate_tone("metric tone", item.tone.as_deref())?,
                    hint: optional_text("metric hint", item.hint.as_deref(), MAX_SUBTITLE_CHARS)?,
                    ..item
                });
            }
            Ok(DesktopCardTemplateKind::Metrics {
                items: normalized,
                layout,
            })
        }
        DesktopCardTemplateKind::CronJob { job_id } => Ok(DesktopCardTemplateKind::CronJob {
            job_id: required_text("cronJob jobId", &job_id, 200)?,
        }),
        DesktopCardTemplateKind::Custom { html } => {
            if html.trim().is_empty() {
                return Err("custom html must not be empty".to_string());
            }
            if html.len() > MAX_CUSTOM_HTML_BYTES {
                return Err(format!(
                    "custom html must be at most {} KiB",
                    MAX_CUSTOM_HTML_BYTES / 1024
                ));
            }
            Ok(DesktopCardTemplateKind::Custom { html })
        }
    }
}

pub fn validate_data_source(
    source: DesktopCardDataSourceKind,
) -> Result<DesktopCardDataSourceKind, String> {
    let check_interval = |interval: u64| {
        if (DESKTOP_CARD_MIN_REFRESH_SECONDS..=DESKTOP_CARD_MAX_REFRESH_SECONDS).contains(&interval)
        {
            Ok(interval)
        } else {
            Err(format!(
                "dataSource intervalSeconds must be between {DESKTOP_CARD_MIN_REFRESH_SECONDS} and {DESKTOP_CARD_MAX_REFRESH_SECONDS}"
            ))
        }
    };
    match source {
        DesktopCardDataSourceKind::Http {
            url,
            headers,
            interval_seconds,
            parse,
        } => {
            if headers.len() > MAX_HEADERS {
                return Err(format!("dataSource supports at most {MAX_HEADERS} headers"));
            }
            for (name, value) in &headers {
                if name.trim().is_empty()
                    || !name
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
                {
                    return Err(format!("dataSource header name `{name}` is invalid"));
                }
                if value.contains(['\r', '\n']) {
                    return Err(format!("dataSource header `{name}` must be a single line"));
                }
            }
            Ok(DesktopCardDataSourceKind::Http {
                url: validate_web_url("dataSource url", &url)?,
                headers,
                interval_seconds: check_interval(interval_seconds)?,
                parse,
            })
        }
        DesktopCardDataSourceKind::Command {
            command,
            cwd,
            interval_seconds,
            timeout_seconds,
            parse,
        } => {
            let command = required_text("dataSource command", &command, MAX_COMMAND_CHARS)?;
            if let Some(timeout) = timeout_seconds {
                if timeout == 0 || timeout > DESKTOP_CARD_MAX_COMMAND_TIMEOUT_SECONDS {
                    return Err(format!(
                        "dataSource timeoutSeconds must be between 1 and {DESKTOP_CARD_MAX_COMMAND_TIMEOUT_SECONDS}"
                    ));
                }
            }
            Ok(DesktopCardDataSourceKind::Command {
                command,
                cwd: optional_text("dataSource cwd", cwd.as_deref(), MAX_URL_CHARS)?,
                interval_seconds: check_interval(interval_seconds)?,
                timeout_seconds,
                parse,
            })
        }
    }
}

pub fn validate_title(title: &str) -> Result<String, String> {
    required_text("title", title, MAX_TITLE_CHARS)
}

pub fn validate_subtitle(subtitle: Option<&str>) -> Result<Option<String>, String> {
    optional_text("subtitle", subtitle, MAX_SUBTITLE_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record_json() -> Value {
        json!({
            "id": "card-1",
            "title": "Deploy",
            "template": { "kind": "note", "text": "hello" },
            "createdAtMs": 1,
            "updatedAtMs": 1
        })
    }

    #[test]
    fn legacy_minimal_record_gets_defaults() {
        let record: DesktopCardRecord = serde_json::from_value(record_json()).unwrap();
        assert!(record.visible);
        assert!(record.always_on_top);
        assert!(record.position.is_none());
        assert_eq!(record.template.kind(), "note");
    }

    #[test]
    fn unknown_fields_and_templates_survive_round_trip() {
        let mut value = record_json();
        value["template"] = json!({ "kind": "hologram", "beam": 3 });
        value["dataSource"] = json!({ "kind": "satellite", "orbit": "leo" });
        value["futureField"] = json!({ "nested": true });
        let record: DesktopCardRecord = serde_json::from_value(value.clone()).unwrap();
        assert!(record.template.known().is_none());
        assert_eq!(record.template.kind(), "hologram");
        assert!(record
            .data_source
            .as_ref()
            .and_then(DesktopCardDataSource::known)
            .is_none());
        let written = serde_json::to_value(&record).unwrap();
        for (key, original) in value.as_object().unwrap() {
            assert_eq!(&written[key], original, "field {key} changed");
        }
    }

    #[test]
    fn countdown_defaults_to_notify() {
        let template: DesktopCardTemplateKind =
            serde_json::from_value(json!({ "kind": "countdown", "targetAtMs": 42 })).unwrap();
        assert!(matches!(
            template,
            DesktopCardTemplateKind::Countdown { notify: true, .. }
        ));
    }

    #[test]
    fn patch_merges_data_and_clears_snapshot_when_source_changes() {
        let mut record: DesktopCardRecord = serde_json::from_value(record_json()).unwrap();
        record.data = json!({ "a": 1, "b": 2 });
        record.last_data = Some(DesktopCardDataSnapshot {
            fetched_at_ms: 1,
            value: json!({}),
            error: None,
            warning: None,
        });
        let mut merge = Map::new();
        merge.insert("b".to_string(), Value::Null);
        merge.insert("c".to_string(), json!(3));
        DesktopCardPatch {
            data_merge: Some(merge),
            data_source: Some(Some(DesktopCardDataSourceKind::Http {
                url: "https://example.com".to_string(),
                headers: BTreeMap::new(),
                interval_seconds: 60,
                parse: DesktopCardDataParse::Json,
            })),
            ..Default::default()
        }
        .apply_to(&mut record);
        assert_eq!(record.data, json!({ "a": 1, "c": 3 }));
        assert!(record.last_data.is_none());
    }

    #[test]
    fn validation_rejects_unsafe_or_out_of_range_values() {
        assert!(validate_web_url("link", "file:///etc/passwd").is_err());
        assert!(validate_web_url("link", "javascript:alert(1)").is_err());
        assert!(validate_icon(Some("skull")).is_err());
        assert!(validate_size(DesktopCardSize {
            width: 10.0,
            height: 200.0
        })
        .is_err());
        assert!(validate_data_source(DesktopCardDataSourceKind::Command {
            command: "date".to_string(),
            cwd: None,
            interval_seconds: 5,
            timeout_seconds: None,
            parse: DesktopCardDataParse::Text,
        })
        .is_err());
        assert!(validate_template(DesktopCardTemplateKind::Metrics {
            items: vec![DesktopCardMetricItem {
                label: "Price".to_string(),
                path: Some("price".to_string()),
                ..Default::default()
            }],
            layout: None,
        })
        .is_err());
    }

    #[test]
    fn snapshots_written_before_warnings_still_load_and_round_trip() {
        let legacy = json!({ "fetchedAtMs": 5, "value": { "n": 1 }, "error": "boom" });
        let snapshot: DesktopCardDataSnapshot = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(snapshot.warning, None);
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), legacy);

        let with_warning = DesktopCardDataSnapshot {
            warning: Some("rate limited".to_string()),
            ..snapshot
        };
        assert_eq!(
            serde_json::to_value(&with_warning).unwrap()["warning"],
            "rate limited"
        );
    }

    #[test]
    fn command_argv_skips_profiles_on_every_platform() {
        let argv = desktop_card_command_argv("echo hi");
        if cfg!(windows) {
            assert_eq!(
                argv[..4],
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command"
                ]
            );
            assert!(argv[4].starts_with("[Console]::OutputEncoding"));
            assert!(argv[4].contains("$ProgressPreference='SilentlyContinue';"));
            assert!(argv[4].ends_with("echo hi"));
        } else {
            assert_eq!(argv, ["/bin/sh", "-c", "echo hi"]);
        }
        assert!(
            desktop_card_command_shell_label().contains(if cfg!(windows) {
                "PowerShell"
            } else {
                "/bin/sh"
            })
        );
    }

    #[test]
    fn template_paths_cover_metrics_and_progress_bindings() {
        let metrics = DesktopCardTemplateKind::Metrics {
            items: vec![
                DesktopCardMetricItem {
                    label: "Stars".to_string(),
                    path: Some("/stars".to_string()),
                    hint_path: Some("/updated".to_string()),
                    ..Default::default()
                },
                DesktopCardMetricItem {
                    label: "Static".to_string(),
                    value: Some(json!(1)),
                    ..Default::default()
                },
            ],
            layout: None,
        };
        let paths = desktop_card_template_paths(&metrics)
            .into_iter()
            .map(|(_, path)| path)
            .collect::<Vec<_>>();
        assert_eq!(paths, ["/stars", "/updated"]);

        let progress = DesktopCardTemplateKind::Progress {
            value: None,
            max: None,
            value_path: Some("/done".to_string()),
            max_path: Some("/total".to_string()),
            status: None,
            status_path: None,
        };
        assert_eq!(desktop_card_template_paths(&progress).len(), 2);
        assert!(desktop_card_template_paths(&DesktopCardTemplateKind::Note {
            text: "x".to_string()
        })
        .is_empty());
    }

    #[test]
    fn checklist_ids_are_made_unique() {
        let template = validate_template(DesktopCardTemplateKind::Checklist {
            items: vec![
                DesktopCardChecklistItem {
                    id: "a".to_string(),
                    text: "one".to_string(),
                    done: false,
                },
                DesktopCardChecklistItem {
                    id: "a".to_string(),
                    text: "two".to_string(),
                    done: true,
                },
            ],
        })
        .unwrap();
        let DesktopCardTemplateKind::Checklist { items } = template else {
            panic!("checklist expected");
        };
        assert_ne!(items[0].id, items[1].id);
    }
}
