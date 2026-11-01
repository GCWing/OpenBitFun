//! Shared file logging initialization for CLI modes.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::Local;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

use crate::config::CliConfig;

const FLASHGREP_LOG_TARGET_PREFIX: &str = "flashgrep";
const CLI_LOGS_DIR_NAME: &str = "cli-logs";
const SESSION_DIR_FORMAT: &str = "%Y%m%dT%H%M%S";
const ROTATED_LOG_TIME_FORMAT: &str = "%Y-%m-%d_%H-%M-%S";
const MAX_LOG_FILE_SIZE: u64 = 10 * 1024 * 1024;
const ROTATED_LOG_KEEP_COUNT: usize = 2;

pub(crate) const DEFAULT_LOG_LEVEL: tracing::Level = tracing::Level::DEBUG;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliLogPaths {
    pub session_log_dir: PathBuf,
    pub app_log_path: PathBuf,
    pub ai_log_path: PathBuf,
    pub flashgrep_log_path: PathBuf,
    pub plugin_host_log_path: PathBuf,
}

static ACTIVE_LOG_PATHS: OnceLock<CliLogPaths> = OnceLock::new();

struct RotatingFile {
    dir: PathBuf,
    file_name: String,
    path: PathBuf,
    max_size: u64,
    current_size: u64,
    inner: Option<File>,
    buffer: Vec<u8>,
}

impl RotatingFile {
    fn new(
        dir: impl AsRef<Path>,
        file_name: impl Into<String>,
        max_size: u64,
    ) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        let file_name = file_name.into();
        let path = dir.join(&file_name).with_extension("log");

        let mut rotator = Self {
            dir,
            file_name,
            path,
            max_size,
            current_size: 0,
            inner: None,
            buffer: Vec::new(),
        };

        rotator.open_file()?;
        if rotator.current_size >= rotator.max_size {
            rotator.rotate()?;
        }
        rotator.remove_old_files(ROTATED_LOG_KEEP_COUNT)?;

        Ok(rotator)
    }

    fn open_file(&mut self) -> std::io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.current_size = file.metadata()?.len();
        self.inner = Some(file);
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        if let Some(mut file) = self.inner.take() {
            let _ = file.flush();
        }

        if self.path.exists() {
            self.remove_old_files(ROTATED_LOG_KEEP_COUNT.saturating_sub(1))?;
            self.rename_file_to_dated()?;
        }

        self.open_file()
    }

    fn remove_old_files(&self, keep_count: usize) -> std::io::Result<()> {
        let mut files = fs::read_dir(&self.dir)?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                let old_file_name = path.file_name()?.to_string_lossy().into_owned();

                if old_file_name.starts_with(&self.file_name)
                    && old_file_name != format!("{}.log", self.file_name)
                {
                    let date = old_file_name
                        .strip_prefix(&self.file_name)?
                        .strip_prefix('_')?
                        .strip_suffix(".log")?;
                    Some((path, date.to_string()))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        files.sort_by(|a, b| a.1.cmp(&b.1));

        if files.len() > keep_count {
            for (old_log_path, _) in files.iter().take(files.len() - keep_count) {
                fs::remove_file(old_log_path)?;
            }
        }

        Ok(())
    }

    fn rename_file_to_dated(&self) -> std::io::Result<()> {
        let to = self.dir.join(format!(
            "{}_{}.log",
            self.file_name,
            Local::now().format(ROTATED_LOG_TIME_FORMAT)
        ));

        if to.is_file() {
            let mut to_bak = to.clone();
            to_bak.set_file_name(format!(
                "{}.bak",
                to_bak.file_name().unwrap().to_string_lossy()
            ));
            fs::rename(&to, to_bak)?;
        }

        fs::rename(&self.path, &to)
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }

        if self.inner.is_none() {
            self.open_file()?;
        }

        if self.current_size != 0 && self.current_size + self.buffer.len() as u64 > self.max_size {
            self.rotate()?;
        }

        if let Some(file) = self.inner.as_mut() {
            file.write_all(&self.buffer)?;
            self.current_size += self.buffer.len() as u64;
            file.flush()?;
        }

        self.buffer.clear();
        Ok(())
    }
}

#[derive(Clone)]
struct SharedRotatingWriter {
    inner: Arc<Mutex<RotatingFile>>,
}

impl SharedRotatingWriter {
    fn new(inner: RotatingFile) -> Self {
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }
}

impl Write for SharedRotatingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| std::io::Error::other("log writer lock poisoned"))?;
        let written = guard.write(buf)?;
        guard.flush()?;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner
            .lock()
            .map_err(|_| std::io::Error::other("log writer lock poisoned"))?
            .flush()
    }
}

pub(crate) fn default_log_level(verbose: bool) -> tracing::Level {
    if verbose {
        tracing::Level::TRACE
    } else {
        DEFAULT_LOG_LEVEL
    }
}

pub(crate) fn resolve_logs_root() -> PathBuf {
    CliConfig::config_dir()
        .ok()
        .map(|d| d.join(CLI_LOGS_DIR_NAME))
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join(format!(
                    "{}-cli",
                    openbitfun_core_types::product_identity::data_namespace()
                ))
                .join(CLI_LOGS_DIR_NAME)
        })
}

pub(crate) fn create_session_log_dir(logs_root: &Path) -> PathBuf {
    let timestamp = Local::now().format(SESSION_DIR_FORMAT).to_string();
    let session_dir = logs_root.join(timestamp);
    fs::create_dir_all(&session_dir).ok();
    session_dir
}

pub(crate) fn build_log_paths(session_log_dir: &Path) -> CliLogPaths {
    CliLogPaths {
        session_log_dir: session_log_dir.to_path_buf(),
        app_log_path: session_log_dir.join("app.log"),
        ai_log_path: session_log_dir.join("ai.log"),
        flashgrep_log_path: session_log_dir.join("flashgrep.log"),
        plugin_host_log_path: session_log_dir.join("plugin-host.log"),
    }
}

pub(crate) fn active_plugin_host_log_path() -> Option<PathBuf> {
    ACTIVE_LOG_PATHS
        .get()
        .map(|paths| paths.plugin_host_log_path.clone())
}

fn create_rotating_writer(
    session_log_dir: &Path,
    file_name: &str,
) -> std::io::Result<SharedRotatingWriter> {
    RotatingFile::new(session_log_dir, file_name, MAX_LOG_FILE_SIZE).map(SharedRotatingWriter::new)
}

fn is_ai_target(target: &str) -> bool {
    target.starts_with("ai")
}

fn is_flashgrep_target(target: &str) -> bool {
    target.starts_with(FLASHGREP_LOG_TARGET_PREFIX)
}

fn is_app_target(target: &str) -> bool {
    !is_ai_target(target) && !is_flashgrep_target(target)
}

fn matches_target_rule(target: &str, rule: &str) -> bool {
    target == rule
        || target
            .strip_prefix(rule)
            .is_some_and(|suffix| suffix.starts_with("::"))
}

fn level_rank(level: tracing::Level) -> u8 {
    match level {
        tracing::Level::ERROR => 1,
        tracing::Level::WARN => 2,
        tracing::Level::INFO => 3,
        tracing::Level::DEBUG => 4,
        tracing::Level::TRACE => 5,
    }
}

fn target_override_rank(target: &str) -> Option<u8> {
    if matches_target_rule(target, "ignore")
        || matches_target_rule(target, "ignore::walk")
        || matches_target_rule(target, "globset")
        || matches_target_rule(target, "tracing")
        || matches_target_rule(target, "opentelemetry_sdk")
        || matches_target_rule(target, "opentelemetry-otlp")
    {
        return Some(0);
    }

    if matches_target_rule(target, "html5ever")
        || matches_target_rule(target, "selectors")
        || matches_target_rule(target, "notify")
    {
        return Some(level_rank(tracing::Level::WARN));
    }

    if matches_target_rule(target, "openbitfun_core::agentic::events::queue")
        || matches_target_rule(target, "openbitfun_core::agentic::events::router")
        || matches_target_rule(target, "openbitfun_agent_runtime::event_queue")
        || matches_target_rule(target, "openbitfun_agent_runtime::event_router")
    {
        return Some(level_rank(tracing::Level::DEBUG));
    }

    if matches_target_rule(target, "hyper_util")
        || matches_target_rule(target, "h2")
        || matches_target_rule(target, "portable_pty")
        || matches_target_rule(target, "russh")
    {
        return Some(level_rank(tracing::Level::INFO));
    }

    if matches_target_rule(target, "grep_searcher") {
        return Some(level_rank(tracing::Level::WARN));
    }

    None
}

fn allowed_level_rank_for_target(target: &str, default_level: tracing::Level) -> u8 {
    let default_rank = level_rank(default_level);
    target_override_rank(target)
        .map(|override_rank| default_rank.min(override_rank))
        .unwrap_or(default_rank)
}

fn is_enabled_for_target(metadata: &tracing::Metadata<'_>, default_level: tracing::Level) -> bool {
    // Overrides only reduce verbosity. Reject disabled levels before scanning targets.
    if level_rank(*metadata.level()) > level_rank(default_level) {
        return false;
    }
    let allowed_rank = allowed_level_rank_for_target(metadata.target(), default_level);

    allowed_rank != 0 && level_rank(*metadata.level()) <= allowed_rank
}

fn build_file_layer<S, F>(
    writer: SharedRotatingWriter,
    target_filter: F,
    default_level: tracing::Level,
) -> impl tracing_subscriber::Layer<S> + Send + Sync
where
    S: tracing::Subscriber + for<'span> tracing_subscriber::registry::LookupSpan<'span>,
    F: Fn(&str) -> bool + Send + Sync + 'static,
{
    tracing_subscriber::fmt::layer()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_filter(
            filter_fn(move |metadata| {
                target_filter(metadata.target()) && is_enabled_for_target(metadata, default_level)
            })
            // Let the log facade skip disabled TRACE records at their source, including
            // the tokenizer normalizer's per-character logging on the routing hot path.
            .with_max_level_hint(default_level),
        )
}

pub(crate) fn init_file_logging_at(
    session_log_dir: &Path,
    log_level: tracing::Level,
) -> CliLogPaths {
    fs::create_dir_all(session_log_dir).ok();
    let paths = build_log_paths(session_log_dir);
    let _ = ACTIVE_LOG_PATHS.set(paths.clone());

    let app_writer = create_rotating_writer(session_log_dir, "app");
    let ai_writer = create_rotating_writer(session_log_dir, "ai");
    let flashgrep_writer = create_rotating_writer(session_log_dir, "flashgrep");

    if let (Ok(app_writer), Ok(ai_writer), Ok(flashgrep_writer)) =
        (app_writer, ai_writer, flashgrep_writer)
    {
        tracing_subscriber::registry()
            .with(build_file_layer(app_writer, is_app_target, log_level))
            .with(build_file_layer(ai_writer, is_ai_target, log_level))
            .with(build_file_layer(
                flashgrep_writer,
                is_flashgrep_target,
                log_level,
            ))
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_max_level(log_level)
            .with_target(true)
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
    }

    paths
}

pub(crate) fn init_file_logging(log_level: tracing::Level) -> CliLogPaths {
    let logs_root = resolve_logs_root();
    let session_log_dir = create_session_log_dir(&logs_root);
    init_file_logging_at(&session_log_dir, log_level)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Subscriber;

    fn file_subscriber(
        dir: &Path,
        level: tracing::Level,
    ) -> impl tracing::Subscriber + Send + Sync {
        tracing_subscriber::registry()
            .with(build_file_layer(
                create_rotating_writer(dir, "app").expect("app writer"),
                is_app_target,
                level,
            ))
            .with(build_file_layer(
                create_rotating_writer(dir, "ai").expect("ai writer"),
                is_ai_target,
                level,
            ))
            .with(build_file_layer(
                create_rotating_writer(dir, "flashgrep").expect("flashgrep writer"),
                is_flashgrep_target,
                level,
            ))
    }

    #[test]
    fn file_filters_advertise_effective_max_level() {
        // The log facade uses this hint to skip disabled per-character tokenizer
        // TRACE records before entering the subscriber's target filters.
        for level in [
            tracing::Level::ERROR,
            tracing::Level::WARN,
            tracing::Level::INFO,
            default_log_level(false),
            default_log_level(true),
        ] {
            let temp = tempfile::tempdir().expect("tempdir");
            let subscriber = file_subscriber(temp.path(), level);
            assert_eq!(subscriber.max_level_hint(), Some(level.into()));
        }
    }

    #[test]
    fn file_filters_preserve_verbose_levels_and_split_targets() {
        for verbose in [false, true] {
            let temp = tempfile::tempdir().expect("tempdir");
            let subscriber = file_subscriber(temp.path(), default_log_level(verbose));
            tracing::subscriber::with_default(subscriber, || {
                tracing::debug!(target: "tokenizers::normalizer", "app-debug");
                tracing::trace!(target: "tokenizers::normalizer", "app-trace");
                tracing::debug!(target: "ai::client", "ai-debug");
                tracing::trace!(target: "ai::client", "ai-trace");
                tracing::debug!(target: "flashgrep::search", "search-debug");
                tracing::trace!(target: "flashgrep::search", "search-trace");
                tracing::debug!(target: "h2::codec", "hidden-h2-debug");
                tracing::info!(target: "h2::codec", "h2-info");
                tracing::error!(target: "ignore::walk", "hidden-ignore-error");
            });

            for (file, prefix) in [("app", "app"), ("ai", "ai"), ("flashgrep", "search")] {
                let content =
                    fs::read_to_string(temp.path().join(format!("{file}.log"))).expect("read log");
                assert!(content.contains(&format!("{prefix}-debug")));
                assert_eq!(content.contains(&format!("{prefix}-trace")), verbose);
                assert!(!content.contains("hidden-"));
                for other in ["app", "ai", "search"] {
                    if other != prefix {
                        assert!(!content.contains(&format!("{other}-debug")));
                    }
                }
                assert_eq!(content.contains("h2-info"), file == "app");
            }
        }
    }

    #[test]
    fn target_rules_require_exact_names_or_module_boundaries() {
        for (target, rule, expected) in [
            ("h2", "h2", true),
            ("h2::codec", "h2", true),
            ("h2_codec", "h2", false),
            ("h2:codec", "h2", false),
            ("h2x::codec", "h2", false),
            ("h", "h2", false),
            ("", "h2", false),
            ("", "", true),
            ("::child", "", true),
            ("child", "", false),
        ] {
            assert_eq!(matches_target_rule(target, rule), expected, "{target:?}");
        }
    }

    #[test]
    fn create_session_log_dir_creates_timestamped_subdirectory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let session_dir = create_session_log_dir(temp.path());

        assert!(session_dir.exists());
        assert_eq!(session_dir.parent(), Some(temp.path()));
        assert_eq!(session_dir.file_name().unwrap().to_string_lossy().len(), 15);
    }

    #[test]
    fn build_log_paths_uses_split_log_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = build_log_paths(temp.path());

        assert_eq!(paths.app_log_path, temp.path().join("app.log"));
        assert_eq!(paths.ai_log_path, temp.path().join("ai.log"));
        assert_eq!(paths.flashgrep_log_path, temp.path().join("flashgrep.log"));
        assert_eq!(
            paths.plugin_host_log_path,
            temp.path().join("plugin-host.log")
        );
    }

    #[test]
    fn create_rotating_writer_creates_expected_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        create_rotating_writer(temp.path(), "app").expect("app writer");
        create_rotating_writer(temp.path(), "ai").expect("ai writer");
        create_rotating_writer(temp.path(), "flashgrep").expect("flashgrep writer");

        assert!(temp.path().join("app.log").exists());
        assert!(temp.path().join("ai.log").exists());
        assert!(temp.path().join("flashgrep.log").exists());
    }

    #[test]
    fn target_filter_rules_match_desktop_defaults() {
        assert_eq!(
            allowed_level_rank_for_target(
                "openbitfun_core::agentic::events::queue",
                tracing::Level::TRACE,
            ),
            level_rank(tracing::Level::DEBUG)
        );
        assert_eq!(
            allowed_level_rank_for_target(
                "openbitfun_agent_runtime::event_queue",
                tracing::Level::TRACE,
            ),
            level_rank(tracing::Level::DEBUG)
        );
        assert_eq!(
            allowed_level_rank_for_target("grep_searcher", tracing::Level::TRACE),
            level_rank(tracing::Level::WARN)
        );
        assert_eq!(
            allowed_level_rank_for_target("html5ever::tokenizer::char_ref", tracing::Level::TRACE,),
            level_rank(tracing::Level::WARN)
        );
        assert_eq!(
            allowed_level_rank_for_target("selectors::matching", tracing::Level::TRACE),
            level_rank(tracing::Level::WARN)
        );
        assert_eq!(
            allowed_level_rank_for_target("notify", tracing::Level::TRACE),
            level_rank(tracing::Level::WARN)
        );
        assert_eq!(
            allowed_level_rank_for_target(
                "openbitfun_core::agentic::events::queue",
                tracing::Level::ERROR,
            ),
            level_rank(tracing::Level::ERROR)
        );
    }

    #[test]
    fn rotating_file_keep_some_removes_old_archives() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(temp.path().join("app.log"), "current").expect("write active");
        fs::write(temp.path().join("app_2026-06-01_10-00-00.log"), "1").expect("write old 1");
        fs::write(temp.path().join("app_2026-06-01_10-00-01.log"), "2").expect("write old 2");
        fs::write(temp.path().join("app_2026-06-01_10-00-02.log"), "3").expect("write old 3");

        let _rotator = RotatingFile::new(temp.path(), "app", MAX_LOG_FILE_SIZE).expect("rotator");

        assert!(!temp.path().join("app_2026-06-01_10-00-00.log").exists());
        assert!(temp.path().join("app_2026-06-01_10-00-01.log").exists());
        assert!(temp.path().join("app_2026-06-01_10-00-02.log").exists());
    }
}
