//! Provider-neutral bot support for Remote Connect.
//!
//! Platform adapters and command routing remain in product assembly until their
//! concrete session/runtime dependencies are reduced to service ports.

mod command;
pub mod feishu;
pub mod inbound_files;
mod locale;
mod menu;
mod ownership;
pub mod remote_turn;
mod state;
pub mod telegram;
pub mod weixin;

use serde::{Deserialize, Serialize};
use std::sync::{Mutex as StdMutex, OnceLock};

pub use command::{parse_command, BotCommand};
pub use feishu::{FeishuBotApi, FeishuConfig};
pub use locale::{fmt_count, strings_for, BotLanguage, BotStrings};
pub use menu::{MenuItem, MenuItemStyle, MenuView};
pub use ownership::BotListenerLease;
pub use state::{
    BotAction, BotActionStyle, BotChatState, BotDisplayMode, BotInteractionHandler,
    BotInteractiveRequest, BotMessageSender, BotQuestion, BotQuestionOption, BotWorkspaceChoice,
    BotWorkspaceRef, PendingAction, RemoteBotTarget, RemoteDeviceTarget,
};
pub use telegram::{TelegramBotApi, TelegramConfig};
pub use weixin::{WeixinConfig, WeixinProviderClient};

/// Configuration for a bot-based connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "bot_type", rename_all = "snake_case")]
pub enum BotConfig {
    Feishu {
        app_id: String,
        app_secret: String,
    },
    Telegram {
        bot_token: String,
    },
    Weixin {
        ilink_token: String,
        base_url: String,
        bot_account_id: String,
    },
}

impl BotConfig {
    pub fn bot_type(&self) -> &'static str {
        match self {
            Self::Feishu { .. } => "feishu",
            Self::Telegram { .. } => "telegram",
            Self::Weixin { .. } => "weixin",
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        let valid = match self {
            Self::Feishu { app_id, app_secret } => {
                !app_id.trim().is_empty() && !app_secret.trim().is_empty()
            }
            Self::Telegram { bot_token } => !bot_token.trim().is_empty(),
            Self::Weixin {
                ilink_token,
                bot_account_id,
                ..
            } => !ilink_token.trim().is_empty() && !bot_account_id.trim().is_empty(),
        };
        anyhow::ensure!(valid, "Bot credentials are incomplete");
        Ok(())
    }
}

/// Read credentials supplied explicitly by the user on the executing product host.
/// Never return file contents or credential values in an error or management result.
pub async fn read_bot_credentials_file(path: std::path::PathBuf) -> anyhow::Result<BotConfig> {
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        anyhow::ensure!(
            path.is_absolute(),
            "credentialsFile must be an absolute path on the executing product host"
        );
        let metadata = std::fs::symlink_metadata(&path)?;
        anyhow::ensure!(
            metadata.file_type().is_file(),
            "Bot credentials must be supplied in a regular file"
        );
        let file = std::fs::File::open(&path)?;
        let metadata = file.metadata()?;
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= 16 * 1024,
            "Bot credential file is too large or not a regular file"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "Bot credential file must have owner-only permissions (chmod 600)"
            );
        }
        let mut bytes = Vec::new();
        file.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
        anyhow::ensure!(bytes.len() <= 16 * 1024, "Bot credential file is too large");
        let config: BotConfig = serde_json::from_slice(&bytes).map_err(|_| {
            anyhow::anyhow!("Invalid bot credential file; expected a BotConfig JSON object")
        })?;
        config.validate()?;
        Ok(config)
    })
    .await?
}

/// Pairing state for bot-based connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotPairingInfo {
    pub pairing_code: String,
    pub bot_type: String,
    pub bot_link: String,
    pub expires_at: i64,
}

/// Persisted bot connection — saved to disk so reconnect survives restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedBotConnection {
    #[serde(default)]
    pub account_user_id: String,
    pub bot_type: String,
    pub chat_id: String,
    pub config: BotConfig,
    pub chat_state: BotChatState,
    pub connected_at: i64,
}

/// Persisted remote-connect form values shown in the desktop dialog.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RemoteConnectFormState {
    pub telegram_bot_token: String,
    pub feishu_app_id: String,
    pub feishu_app_secret: String,
    /// Weixin iLink credentials after QR login (optional until user links WeChat).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub weixin_ilink_token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub weixin_base_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub weixin_bot_account_id: String,
}

/// All persisted bot connections (one per bot type at most).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BotPersistenceData {
    #[serde(default)]
    pub connections: Vec<SavedBotConnection>,
    #[serde(default)]
    pub form_state: RemoteConnectFormState,
    /// Global verbose mode setting for all bot connections.
    /// When true, the agent's intermediate thinking summaries (one short
    /// `[Thinking] …` line per `ThinkingEnd`) are forwarded to the user.
    /// Tool-call notifications are intentionally NOT sent even in verbose
    /// mode — they were too noisy for IM channels (especially WeChat where
    /// each line costs a `context_token` slot) without giving the user
    /// information they could act on.
    /// Defaults to `false` (concise mode).
    #[serde(default)]
    pub verbose_mode: bool,
    /// Explicitly stopped channels retain their credentials and chat state.
    /// Older records have no disabled channels and keep their restore behavior.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_bots: Vec<String>,
}

impl BotPersistenceData {
    pub fn upsert(&mut self, conn: SavedBotConnection) {
        self.connections.retain(|c| c.bot_type != conn.bot_type);
        self.connections.push(conn);
    }

    pub fn remove(&mut self, bot_type: &str) {
        self.connections.retain(|c| c.bot_type != bot_type);
    }

    pub fn get(&self, bot_type: &str) -> Option<&SavedBotConnection> {
        self.connections.iter().find(|c| c.bot_type == bot_type)
    }
}

// ── Shared workspace-file utilities ────────────────────────────────

/// File content read from the local workspace, ready to be sent over any channel.
#[derive(Clone)]
pub struct WorkspaceFileContent {
    pub name: String,
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
    pub size: u64,
}

/// Resolve a raw path (with or without `computer://` / `file://` prefix) to an
/// absolute `PathBuf`.
///
/// Absolute paths are passed through directly. Relative paths are resolved
/// against `workspace_root` when provided, and paths escaping that root are
/// rejected.
pub fn resolve_workspace_path(
    raw: &str,
    workspace_root: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    super::resolve_remote_workspace_path(raw, workspace_root)
}

/// Return the best-effort MIME type for a file based on its extension.
pub fn detect_mime_type(path: &std::path::Path) -> &'static str {
    super::detect_remote_mime_type(path)
}

/// Read a workspace file, resolving `computer://` prefixes.
///
/// `max_size` is the caller-specific byte limit (e.g. 50 MB for Telegram,
/// 30 MB for Feishu, 10 MB for mobile relay).
///
/// Returns an error when the file is missing, is a directory, or exceeds
/// `max_size`.
pub async fn read_workspace_file(
    raw_path: &str,
    max_size: u64,
    workspace_root: Option<&std::path::Path>,
) -> anyhow::Result<WorkspaceFileContent> {
    let content = super::read_remote_workspace_file(raw_path, max_size, workspace_root)
        .await
        .map_err(anyhow::Error::msg)?;

    Ok(WorkspaceFileContent {
        name: content.name,
        bytes: content.bytes,
        mime_type: content.mime_type,
        size: content.size,
    })
}

/// Get file metadata (name and size in bytes) without reading the full content.
/// Returns `None` if the path cannot be resolved, does not exist, or is not a
/// regular file.
pub fn get_file_metadata(
    raw_path: &str,
    workspace_root: Option<&std::path::Path>,
) -> Option<(String, u64)> {
    let abs = resolve_workspace_path(raw_path, workspace_root)?;
    if !abs.is_file() {
        return None;
    }
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let size = std::fs::metadata(&abs).ok()?.len();
    Some((name, size))
}

/// Format a byte count as a human-readable string (e.g. "1.4 MB", "320 KB").
pub fn format_file_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

// ── Downloadable file link extraction ──────────────────────────────

/// Extensions that are source-code / config files — excluded from download
/// when referenced via absolute paths (matches mobile-web `CODE_FILE_EXTENSIONS`).
const CODE_FILE_EXTENSIONS: &[&str] = &[
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "mts",
    "cts",
    "py",
    "pyw",
    "pyi",
    "rs",
    "go",
    "java",
    "kt",
    "kts",
    "scala",
    "groovy",
    "c",
    "cpp",
    "cc",
    "cxx",
    "h",
    "hpp",
    "hxx",
    "hh",
    "cs",
    "rb",
    "php",
    "swift",
    "vue",
    "svelte",
    "css",
    "scss",
    "less",
    "sass",
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "xml",
    "md",
    "mdx",
    "rst",
    "txt",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "sql",
    "graphql",
    "gql",
    "proto",
    "lock",
    "env",
    "ini",
    "cfg",
    "conf",
    "cj",
    "ets",
    "editorconfig",
    "gitignore",
    "log",
];

/// Extensions that should be treated as downloadable when referenced via
/// relative markdown links (matches mobile-web `DOWNLOADABLE_EXTENSIONS`).
const DOWNLOADABLE_EXTENSIONS: &[&str] = &[
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages",
    "numbers", "key", "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "ico", "tiff", "tif",
    "zip", "tar", "gz", "bz2", "7z", "rar", "dmg", "iso", "xz", "mp3", "wav", "ogg", "flac", "aac",
    "m4a", "wma", "mp4", "avi", "mkv", "mov", "webm", "wmv", "flv", "csv", "tsv", "sqlite", "db",
    "parquet", "epub", "mobi", "html", "htm", "apk", "ipa", "exe", "msi", "deb", "rpm", "ttf",
    "otf", "woff", "woff2",
];

/// Check whether a bare file path (no protocol prefix) should be treated as
/// a downloadable file based on its extension.
///
/// Absolute local file paths exclude source/config files. Relative links
/// are allowed when they point to known downloadable file types.
fn is_downloadable_by_extension(file_path: &str) -> bool {
    let ext = std::path::Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext.is_empty() {
        return false;
    }
    let is_absolute = file_path.starts_with('/')
        || (file_path.len() >= 3 && file_path.as_bytes().get(1) == Some(&b':'));
    if is_absolute {
        !CODE_FILE_EXTENSIONS.contains(&ext.as_str())
    } else {
        DOWNLOADABLE_EXTENSIONS.contains(&ext.as_str())
    }
}

/// Only file paths that can be resolved to existing files are returned.
/// Directories and missing paths are skipped. Duplicate paths are deduplicated
/// before returning.
pub fn extract_computer_file_paths(
    text: &str,
    workspace_root: Option<&std::path::Path>,
) -> Vec<String> {
    const PREFIX: &str = "computer://";
    let mut paths: Vec<String> = Vec::new();
    let mut search = text;

    while let Some(idx) = search.find(PREFIX) {
        let rest = &search[idx + PREFIX.len()..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '(' | ')' | '"' | '\''))
            .unwrap_or(rest.len());
        let raw_suffix = rest[..end].trim_end_matches(['.', ',', ';', ':', ')', ']']);
        if !raw_suffix.is_empty() {
            push_if_existing_file(&format!("{PREFIX}{raw_suffix}"), &mut paths, workspace_root);
        }
        search = &rest[end..];
    }

    paths
}

/// Try to resolve `file_path` and, if it exists as a regular file, push
/// its absolute path into `out` (deduplicating).
fn push_if_existing_file(
    file_path: &str,
    out: &mut Vec<String>,
    workspace_root: Option<&std::path::Path>,
) {
    if let Some(abs) = resolve_workspace_path(file_path, workspace_root) {
        let abs_str = abs.to_string_lossy().into_owned();
        if abs.exists() && abs.is_file() && !out.contains(&abs_str) {
            out.push(abs_str);
        }
    }
}

/// Extract deliverable references from rendered Markdown, without probing any
/// filesystem. The caller must resolve every reference through its origin session.
/// Code examples do not trigger uploads; image/link duplicates are delivered once.
pub fn extract_output_file_references(text: &str) -> Vec<String> {
    use pulldown_cmark::{Event, Parser, Tag, TagEnd};
    let mut references = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |reference: &str, image: bool| {
        let explicit = [
            "computer://",
            "file:",
            "openbitfun://runtime/",
            "openbitfun://current-session/",
        ]
        .iter()
        .any(|prefix| reference.starts_with(prefix));
        if !explicit
            && (reference.contains("://")
                || reference.starts_with('#')
                || reference.starts_with("//")
                || reference.starts_with("data:")
                || reference.starts_with("mailto:")
                || reference.starts_with("javascript:"))
        {
            return;
        }
        if !explicit && !image && !is_downloadable_by_extension(reference) {
            return;
        }
        let Ok(normalized) = super::file_projection::normalize_file_reference(reference) else {
            return;
        };
        let normalized = if explicit {
            normalized
        } else {
            urlencoding::decode(&normalized)
                .map(|path| path.into_owned())
                .unwrap_or(normalized)
        };
        if seen.insert(normalized.clone()) {
            references.push(normalized);
        }
    };
    let mut in_code = false;
    let mut link_depth: usize = 0;
    for event in Parser::new(text) {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Start(Tag::Link { dest_url, .. }) if !in_code => {
                add(&dest_url, false);
                link_depth += 1;
            }
            Event::Start(Tag::Image { dest_url, .. }) if !in_code => {
                add(&dest_url, true);
                link_depth += 1;
            }
            Event::End(TagEnd::Link | TagEnd::Image) => link_depth = link_depth.saturating_sub(1),
            Event::Text(text) if !in_code && link_depth == 0 => {
                for word in text.split_whitespace() {
                    let reference = word
                        .trim_start_matches(['(', '[', '<'])
                        .trim_end_matches(['.', ',', ';', ':', ')', ']', '>', '。', '，']);
                    if reference.starts_with("computer://")
                        || reference.starts_with("file://")
                        || reference.starts_with("openbitfun://")
                    {
                        add(reference, false);
                    }
                }
            }
            _ => {}
        }
    }
    references
}

/// Compatibility helper for callers that explicitly own a local workspace.
pub fn extract_downloadable_file_paths(
    text: &str,
    workspace_root: Option<&std::path::Path>,
) -> Vec<String> {
    let mut paths = Vec::new();
    for reference in extract_output_file_references(text) {
        push_if_existing_file(&reference, &mut paths, workspace_root);
    }
    paths
}

// ── Auto-push file delivery helpers ───────────────────────────────

/// One file to be auto-pushed to the IM peer alongside an agent reply.
#[derive(Debug, Clone)]
pub struct AutoPushFile {
    /// Absolute path on the desktop (already resolved).
    pub abs_path: String,
    /// User-visible filename (basename of `abs_path`).
    pub name: String,
    /// Plaintext file size in bytes (for size-limit checks and UI).
    pub size: u64,
}

/// Scan an agent reply for downloadable file references and resolve their
/// metadata so each platform adapter can push them directly to the user
/// without an intermediate "tap to download" prompt.
pub fn collect_auto_push_files(
    text: &str,
    workspace_root: Option<&std::path::Path>,
) -> Vec<AutoPushFile> {
    extract_downloadable_file_paths(text, workspace_root)
        .into_iter()
        .filter_map(|path| {
            get_file_metadata(&path, workspace_root).map(|(name, size)| AutoPushFile {
                abs_path: path,
                name,
                size,
            })
        })
        .collect()
}

/// Caption sent once before the first auto-pushed file.
pub fn auto_push_intro(language: BotLanguage, count: usize) -> String {
    let strings = locale::strings_for(language);
    if count <= 1 {
        strings.auto_push_intro_one.to_string()
    } else {
        locale::fmt_count(strings.auto_push_intro_many_fmt, count)
    }
}

/// Notice sent when a single file exceeds the platform's size limit and is skipped.
pub fn auto_push_skip_too_large_message(
    language: BotLanguage,
    file_name: &str,
    size: u64,
    limit: u64,
) -> String {
    let strings = locale::strings_for(language);
    strings
        .auto_push_skip_too_large_fmt
        .replace("{name}", file_name)
        .replace("{size}", &format_file_size(size))
        .replace("{limit}", &format_file_size(limit))
}

/// Notice sent when an upload/send call fails for a single file.
pub fn auto_push_failed_message(language: BotLanguage, file_name: &str, err: &str) -> String {
    let strings = locale::strings_for(language);
    strings
        .auto_push_failed_fmt
        .replace("{name}", file_name)
        .replace("{err}", err)
}

const REMOTE_CONNECT_PERSISTENCE_FILENAME: &str = "remote_connect_persistence.json";
static BOT_PERSISTENCE_LOCK: OnceLock<StdMutex<()>> = OnceLock::new();

fn bot_persistence_lock() -> std::sync::MutexGuard<'static, ()> {
    BOT_PERSISTENCE_LOCK
        .get_or_init(|| StdMutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn bot_persistence_path() -> Option<std::path::PathBuf> {
    super::product_home_dir().map(|home| home.join(REMOTE_CONNECT_PERSISTENCE_FILENAME))
}

fn bot_persistence_backup_path(path: &std::path::Path) -> std::path::PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| REMOTE_CONNECT_PERSISTENCE_FILENAME.to_string());
    path.with_file_name(format!("{file_name}.bak"))
}

fn load_bot_persistence_unlocked() -> BotPersistenceData {
    try_load_bot_persistence_unlocked().unwrap_or_else(|error| {
        log::error!("Bot persistence is unavailable; existing data was preserved: {error}");
        BotPersistenceData::default()
    })
}

fn try_load_bot_persistence_unlocked() -> anyhow::Result<BotPersistenceData> {
    let path = bot_persistence_path()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine bot persistence location"))?;
    load_bot_persistence_at(&path)
}

fn load_bot_persistence_at(path: &std::path::Path) -> anyhow::Result<BotPersistenceData> {
    match crate::remote_persistence::read_bot_persistence(path)? {
        Some(data) => Ok(serde_json::from_value(serde_json::to_value(data)?)?),
        None if bot_persistence_backup_path(path).exists() => {
            anyhow::bail!(
                "Bot persistence has an unfinished replacement; preserve the backup for recovery"
            )
        }
        None => Ok(BotPersistenceData::default()),
    }
}

pub fn try_load_bot_persistence() -> anyhow::Result<BotPersistenceData> {
    let _persistence = bot_persistence_lock();
    try_load_bot_persistence_unlocked()
}

fn write_bot_persistence_atomic(path: &std::path::Path, json: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "bot persistence path has no parent directory",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| REMOTE_CONNECT_PERSISTENCE_FILENAME.to_string());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce));
    let backup_path = bot_persistence_backup_path(path);

    let write_result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut temp = options.open(&temp_path)?;
        temp.write_all(json)?;
        temp.sync_all()?;
        drop(temp);

        // POSIX rename replaces atomically. On Windows std::fs::rename does
        // not replace an existing destination, so retain the old file as a
        // rollback backup until the new file is installed.
        if std::fs::rename(&temp_path, path).is_ok() {
            let _ = std::fs::remove_file(&backup_path);
            return Ok(());
        }

        if !path.exists() {
            return std::fs::rename(&temp_path, path);
        }
        if backup_path.exists() {
            std::fs::remove_file(&backup_path)?;
        }
        std::fs::rename(path, &backup_path)?;
        match std::fs::rename(&temp_path, path) {
            Ok(()) => {
                let _ = std::fs::remove_file(&backup_path);
                Ok(())
            }
            Err(install_error) => {
                let _ = std::fs::rename(&backup_path, path);
                Err(install_error)
            }
        }
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
}

fn save_bot_persistence_unlocked(data: &BotPersistenceData) {
    let Some(path) = bot_persistence_path() else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let owner_valid =
            serde_json::from_str::<crate::remote_persistence::BotPersistenceRecord>(&json)
                .is_ok_and(|value| value.validate().is_ok());
        if !owner_valid {
            log::error!("Failed to save bot persistence: owner validation failed");
        } else if let Err(e) = write_bot_persistence_atomic(&path, json.as_bytes()) {
            log::error!("Failed to save bot persistence: {e}");
        }
    }
}

pub fn load_bot_persistence() -> BotPersistenceData {
    let _persistence = bot_persistence_lock();
    load_bot_persistence_unlocked()
}

pub fn save_bot_persistence(data: &BotPersistenceData) {
    let _persistence = bot_persistence_lock();
    save_bot_persistence_unlocked(data);
}

/// Apply one read-modify-write transaction to the shared bot persistence
/// document. Individual platform loops run concurrently, so separate
/// `load`/`save` calls can otherwise overwrite another bot's update.
pub fn try_update_bot_persistence<R>(
    update: impl FnOnce(&mut BotPersistenceData) -> R,
) -> anyhow::Result<R> {
    let _persistence = bot_persistence_lock();
    let path = bot_persistence_path()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine bot persistence location"))?;
    update_bot_persistence_at(&path, update)
}

fn update_bot_persistence_at<R>(
    path: &std::path::Path,
    update: impl FnOnce(&mut BotPersistenceData) -> R,
) -> anyhow::Result<R> {
    // Desktop and daemon may own different providers in the same product home.
    // The process mutex alone cannot protect their shared persistence document.
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Missing persistence directory"))?;
    std::fs::create_dir_all(parent)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    let mut data = load_bot_persistence_at(path)?;
    let result = update(&mut data);
    let json = serde_json::to_vec_pretty(&data)?;
    serde_json::from_slice::<crate::remote_persistence::BotPersistenceRecord>(&json)?.validate()?;
    write_bot_persistence_atomic(path, &json)?;
    Ok(result)
}

pub fn update_bot_persistence(update: impl FnOnce(&mut BotPersistenceData)) {
    if let Err(error) = try_update_bot_persistence(update) {
        log::error!("Failed to update bot persistence; existing data was preserved: {error}");
    }
}

/// Remove persisted account-device context for every bot connection. This is
/// called as part of the desktop account epoch transition even when a bot is
/// between stop/restore and therefore has no live chat-state map to clear.
pub fn clear_persisted_bot_account_contexts() {
    update_bot_persistence(|data| {
        for connection in &mut data.connections {
            connection.chat_state.clear_delegated_identity();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        bot_persistence_backup_path, collect_auto_push_files, extract_downloadable_file_paths,
        resolve_workspace_path, write_bot_persistence_atomic,
    };
    use super::{
        load_bot_persistence_at, update_bot_persistence_at, RemoteConnectFormState,
        SavedBotConnection,
    };
    use serde::Deserialize;

    fn make_temp_workspace() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "openbitfun-remote-connect-test-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = base.join("workspace");
        let artifacts = workspace.join("artifacts");
        let report = artifacts.join("report.pptx");
        std::fs::create_dir_all(&artifacts).unwrap();
        std::fs::write(&report, b"ppt").unwrap();
        (base, workspace, report)
    }

    #[test]
    fn bot_management_legacy_roundtrip_and_disabled_restart_state() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("remote_connect_persistence.json");
        let legacy = serde_json::json!({
            "connections": [{"account_user_id":"account", "bot_type":"telegram", "chat_id":"chat", "config":{"bot_type":"telegram", "bot_token":"fixture-token"},
                "chat_state":{"chat_id":"chat", "paired":true,"current_workspace":null,"current_assistant":null,"current_session_id":"session"}, "connected_at":1}],
            "form_state":{"telegram_bot_token":"fixture-token"}, "verbose_mode":false
        });
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(load_bot_persistence_at(&path)
            .unwrap()
            .disabled_bots
            .is_empty());
        update_bot_persistence_at(&path, |data| data.disabled_bots.push("telegram".into()))
            .unwrap();
        let stopped = load_bot_persistence_at(&path).unwrap();
        assert_eq!(stopped.disabled_bots, ["telegram"]);
        assert_eq!(
            stopped.connections[0]
                .chat_state
                .current_session_id
                .as_deref(),
            Some("session")
        );
        assert_eq!(stopped.form_state.telegram_bot_token, "fixture-token");
        // A pre-field reader ignores the additive field and can still decode
        // the original connection and credentials.
        #[derive(Deserialize)]
        struct Legacy {
            connections: Vec<SavedBotConnection>,
            form_state: RemoteConnectFormState,
        }
        let old: Legacy = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(old.connections.len(), 1);
        assert_eq!(old.form_state.telegram_bot_token, "fixture-token");
        update_bot_persistence_at(&path, |data| data.disabled_bots.clear()).unwrap();
        assert!(load_bot_persistence_at(&path)
            .unwrap()
            .disabled_bots
            .is_empty());
    }

    #[test]
    fn bot_management_preserves_unreadable_records() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("remote_connect_persistence.json");
        let corrupt = br#"{"connections":[{"bot_type":"future-provider"}]}"#;
        std::fs::write(&path, corrupt).unwrap();
        assert!(update_bot_persistence_at(&path, |data| data.verbose_mode = true).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), corrupt);
    }

    #[test]
    fn bot_management_concurrent_writers_preserve_both_channels() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("remote_connect_persistence.json");
        let workers: Vec<_> = ["telegram", "weixin"]
            .into_iter()
            .map(|method| {
                let path = path.clone();
                std::thread::spawn(move || {
                    update_bot_persistence_at(&path, |data| data.disabled_bots.push(method.into()))
                        .unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let saved = load_bot_persistence_at(&path).unwrap();
        assert!(saved.disabled_bots.contains(&"telegram".into()));
        assert!(saved.disabled_bots.contains(&"weixin".into()));
    }

    #[test]
    fn bot_persistence_replaces_existing_file_via_same_directory_temp() {
        let root = tempfile::tempdir().expect("temporary persistence directory");
        let path = root.path().join("remote_connect_persistence.json");
        write_bot_persistence_atomic(&path, br#"{"version":1}"#)
            .expect("initial persistence write");
        write_bot_persistence_atomic(&path, br#"{"version":2}"#)
            .expect("replacement persistence write");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read installed persistence"),
            r#"{"version":2}"#
        );
        assert!(!bot_persistence_backup_path(&path).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("persistence metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn resolves_relative_paths_within_workspace_root() {
        let (base, workspace, report) = make_temp_workspace();

        let resolved =
            resolve_workspace_path("computer://artifacts/report.pptx", Some(&workspace)).unwrap();

        assert_eq!(resolved, std::fs::canonicalize(report).unwrap());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_relative_paths_that_escape_workspace_root() {
        let (base, workspace, _report) = make_temp_workspace();
        let secret = base.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();

        let resolved = resolve_workspace_path("computer://../secret.txt", Some(&workspace));

        assert!(resolved.is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    /// Regression: `[name.pptx](name.pptx)` style relative markdown links
    /// emitted by the agent must be auto-pushed when the active workspace
    /// (Pro mode `current_workspace` OR Assistant mode `current_assistant`)
    /// is known. Previously only `current_workspace` was consulted, so
    /// assistant-mode replies silently dropped attachments — see
    /// `BotChatState::active_workspace_path` and the per-platform
    /// `notify_files_ready` callers.
    #[test]
    fn collects_relative_pptx_link_against_assistant_workspace_root() {
        let (base, workspace, _report) = make_temp_workspace();
        let pptx = workspace.join("apple-vision-pro-keynote-style.pptx");
        std::fs::write(&pptx, b"pptx-bytes").unwrap();

        let text = "[apple-vision-pro-keynote-style.pptx](apple-vision-pro-keynote-style.pptx)";
        let files = collect_auto_push_files(text, Some(&workspace));

        assert_eq!(files.len(), 1, "relative pptx link must be auto-pushed");
        assert_eq!(files[0].name, "apple-vision-pro-keynote-style.pptx");
        assert_eq!(files[0].size, b"pptx-bytes".len() as u64);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn extracts_relative_computer_links_when_workspace_root_is_known() {
        let (base, workspace, _report) = make_temp_workspace();
        let text = "Download [deck](computer://artifacts/report.pptx)";

        let paths = extract_downloadable_file_paths(text, Some(&workspace));

        assert_eq!(paths.len(), 1);
        assert!(std::path::Path::new(&paths[0]).is_absolute());
        assert!(std::path::Path::new(&paths[0])
            .ends_with(std::path::Path::new("artifacts").join("report.pptx")));
        assert!(std::path::Path::new(&paths[0]).exists());
        let _ = std::fs::remove_dir_all(base);
    }
}

#[cfg(test)]
mod output_reference_tests {
    use super::extract_output_file_references;
    #[test]
    fn pelican_image_and_file_link_are_delivered_once_without_local_probing() {
        let text = "![Preview](computer://pelican-preview.png)\n- [Image](computer://pelican-preview.png)\n- [Animation](computer://pelican-bicycle.html)";
        assert_eq!(
            extract_output_file_references(text),
            ["pelican-preview.png", "pelican-bicycle.html"]
        );
    }
    #[test]
    fn real_markdown_handles_spaces_parentheses_reference_links_and_code_examples() {
        let text = "![Preview](<computer://output/预览 图(1).png>)\n[file][artifact]\n\n[artifact]: file:///workspace/result%20final.html\n\n`computer://secret.png`\n\n```md\n![example](computer://private.png)\n```\n\n![remote](https://example.com/photo.png)";
        assert_eq!(
            extract_output_file_references(text),
            ["output/预览 图(1).png", "/workspace/result final.html"]
        );
    }
    #[test]
    fn runtime_and_relative_images_are_retained_without_requiring_host_local_files() {
        assert_eq!(extract_output_file_references("![Result](images/new.png)\n[Report](openbitfun://current-session/artifacts/report.html)"),
            ["images/new.png", "openbitfun://current-session/artifacts/report.html"]);
    }
}
