use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWatchEvent {
    pub path: String,
    pub kind: FileWatchEventKind,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileWatchEventKind {
    Create,
    Modify,
    Remove,
    Rename { from: String, to: String },
    Other,
}

/// Stable machine-readable reason for a native watcher failure.
///
/// Product surfaces switch on this code instead of matching error text, and
/// each platform reports only the codes its backend can actually produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileWatchFailureCode {
    /// The OS refused a new watch because a per-user watch quota is exhausted.
    /// Only inotify backends report this (`fs.inotify.max_user_watches`).
    WatchLimitExceeded,
    /// Any other backend failure: permissions, a missing root, or a watcher
    /// thread that could not start.
    BackendUnavailable,
}

/// One failed watch registration or a backend error observed after startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchFailure {
    pub code: FileWatchFailureCode,
    /// English diagnostic for logs and support reports. Not user-facing copy.
    pub detail: String,
    /// Platform remediation command, or `None` where the platform has none.
    /// Callers must show it verbatim: it is not translatable text.
    pub hint: Option<String>,
    /// Watched root the backend blamed, when it named one.
    pub path: Option<String>,
}

impl FileWatchFailure {
    pub fn backend_unavailable(detail: impl Into<String>, path: Option<String>) -> Self {
        Self {
            code: FileWatchFailureCode::BackendUnavailable,
            detail: detail.into(),
            hint: None,
            path,
        }
    }
}

/// Whether filesystem changes still reach product surfaces, and why not.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchStatus {
    pub healthy: bool,
    pub watched_paths: Vec<String>,
    /// Populated only while `healthy` is false.
    pub failure: Option<FileWatchFailure>,
}

#[derive(Debug, Clone)]
pub struct FileWatcherConfig {
    pub watch_recursively: bool,
    pub ignore_hidden_files: bool,
    /// Skip common dependency/build output directories for broad workspace watches.
    /// Semantic source roots such as Skill catalogs can disable this because names
    /// like `build` and `target` are valid source identifiers there.
    pub ignore_common_build_directories: bool,
    pub debounce_interval_ms: u64,
    pub max_events_per_interval: usize,
}

impl Default for FileWatcherConfig {
    fn default() -> Self {
        Self {
            watch_recursively: true,
            ignore_hidden_files: true,
            ignore_common_build_directories: true,
            debounce_interval_ms: 500,
            max_events_per_interval: 100,
        }
    }
}
