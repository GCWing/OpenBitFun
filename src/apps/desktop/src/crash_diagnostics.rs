//! Crash diagnostics and local support bundle export.

use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use std::backtrace::Backtrace;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use zip::write::SimpleFileOptions;

const RUN_STATE_FILE: &str = "run-state.json";
const CRASH_REPORT_FILE: &str = "crash-report.json";
const DIAGNOSTIC_METADATA_FILE: &str = "diagnostic-metadata.json";
const MAX_BUNDLED_LOG_SESSIONS: usize = 5;

static CURRENT_RUN_CONTEXT: OnceLock<RunContext> = OnceLock::new();
static PREVIOUS_UNEXPECTED_EXIT: OnceLock<Option<UnexpectedExitInfo>> = OnceLock::new();

#[derive(Debug, Clone)]
struct RunContext {
    logs_root: PathBuf,
    session_log_dir: PathBuf,
    run_state_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnexpectedExitInfo {
    pub detected: bool,
    pub started_at: Option<String>,
    pub session_log_dir: Option<String>,
    pub crash_report_path: Option<String>,
    pub category: UnexpectedExitCategory,
    pub notify_on_startup: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnexpectedExitCategory {
    Crash,
    UncleanShutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunState {
    app_version: String,
    pid: u32,
    started_at: String,
    updated_at: String,
    session_log_dir: String,
    clean_shutdown: bool,
    shutdown_at: Option<String>,
    exit_reason: Option<String>,
    startup_trace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CrashReport {
    app_version: String,
    pid: u32,
    crashed_at: String,
    session_log_dir: String,
    thread_name: Option<String>,
    thread_id: String,
    location: String,
    message: String,
    backtrace: String,
    os: String,
    arch: String,
    debug_assertions: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundleInfo {
    pub bundle_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticMetadata {
    exported_at: String,
    app_version: String,
    os: String,
    arch: String,
    debug_assertions: bool,
    current_pid: u32,
    current_log_info: crate::logging::RuntimeLoggingInfo,
    previous_unexpected_exit: Option<UnexpectedExitInfo>,
    platform_crash_report_hints: Vec<String>,
}

/// Ensures a single GUI instance owns this data root. Two instances sharing
/// one root corrupt controller state and workspace lifecycle (for example
/// LoopX worktrees removed out from under live tasks). File locks are
/// released by the OS when the holder dies, so a crashed instance never
/// blocks the next launch.
pub fn acquire_single_instance_lock(session_log_dir: &Path) -> Result<(), String> {
    let logs_root = session_log_dir.parent().unwrap_or(session_log_dir);
    let lock_path = logs_root.join(".bitfun-instance.lock");
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "failed to open the instance lock {}: {error}",
                lock_path.display()
            )
        })?;
    file.try_lock().map_err(|_| {
        format!(
            "another BitFun instance is already running for this data root (lock: {}); close that instance before starting a new one",
            lock_path.display()
        )
    })?;
    // Deliberately leak the handle: the lock must outlive every other use of
    // this data root for the whole process lifetime.
    std::mem::forget(file);
    Ok(())
}

pub fn initialize_run_state(session_log_dir: PathBuf, startup_trace_id: &str) {
    let logs_root = session_log_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| session_log_dir.clone());
    let run_state_path = logs_root.join(RUN_STATE_FILE);
    let previous = detect_previous_unexpected_exit(&run_state_path);
    let _ = PREVIOUS_UNEXPECTED_EXIT.set(previous);

    let context = RunContext {
        logs_root,
        session_log_dir: session_log_dir.clone(),
        run_state_path,
    };

    let state = RunState {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        started_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        session_log_dir: session_log_dir.to_string_lossy().to_string(),
        clean_shutdown: false,
        shutdown_at: None,
        exit_reason: None,
        startup_trace_id: startup_trace_id.to_string(),
    };

    if let Err(error) = write_json_file(&context.run_state_path, &state) {
        eprintln!("Warning: Failed to write run state: {}", error);
    }

    let _ = CURRENT_RUN_CONTEXT.set(context);
}

pub fn previous_unexpected_exit() -> Option<UnexpectedExitInfo> {
    PREVIOUS_UNEXPECTED_EXIT.get().cloned().flatten()
}

pub fn log_previous_unexpected_exit_if_any() {
    if let Some(info) = previous_unexpected_exit() {
        if info.notify_on_startup {
            log::warn!(
                "Previous desktop session ended unexpectedly: session_log_dir={:?}, crash_report_path={:?}, reason={}",
                info.session_log_dir,
                info.crash_report_path,
                info.reason
            );
        } else {
            log::info!(
                "Previous desktop session did not record a clean shutdown: session_log_dir={:?}, reason={}",
                info.session_log_dir,
                info.reason
            );
        }
    }
}

pub fn mark_clean_shutdown(reason: &str) {
    let Some(context) = CURRENT_RUN_CONTEXT.get() else {
        return;
    };

    let now = Utc::now().to_rfc3339();
    let mut state =
        read_json_file::<RunState>(&context.run_state_path).unwrap_or_else(|_| RunState {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            started_at: now.clone(),
            updated_at: now.clone(),
            session_log_dir: context.session_log_dir.to_string_lossy().to_string(),
            clean_shutdown: false,
            shutdown_at: None,
            exit_reason: None,
            startup_trace_id: String::new(),
        });
    state.updated_at = now.clone();
    state.clean_shutdown = true;
    state.shutdown_at = Some(now);
    state.exit_reason = Some(reason.to_string());

    if let Err(error) = write_json_file(&context.run_state_path, &state) {
        log::warn!("Failed to mark clean shutdown: {}", error);
    }
}

pub fn write_panic_report(
    location: String,
    message: String,
    thread_name: Option<String>,
    thread_id: String,
) {
    let Some(context) = CURRENT_RUN_CONTEXT.get() else {
        return;
    };

    let report = CrashReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        crashed_at: Utc::now().to_rfc3339(),
        session_log_dir: context.session_log_dir.to_string_lossy().to_string(),
        thread_name,
        thread_id,
        location,
        message,
        backtrace: Backtrace::force_capture().to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        debug_assertions: cfg!(debug_assertions),
    };

    let crash_report_path = context.session_log_dir.join(CRASH_REPORT_FILE);
    if let Err(error) = write_json_file(&crash_report_path, &report) {
        eprintln!("Warning: Failed to write panic report: {}", error);
    }
}

pub fn export_diagnostics_bundle() -> Result<DiagnosticsBundleInfo, String> {
    let context = CURRENT_RUN_CONTEXT
        .get()
        .cloned()
        .ok_or_else(|| "Crash diagnostics are not initialized".to_string())?;

    let diagnostics_dir = context.logs_root.join("diagnostics");
    fs::create_dir_all(&diagnostics_dir)
        .map_err(|error| format!("Failed to create diagnostics directory: {}", error))?;

    let filename = format!(
        "openbitfun-diagnostics-{}.zip",
        Local::now().format("%Y%m%dT%H%M%S")
    );
    let bundle_path = diagnostics_dir.join(filename);
    let file = File::create(&bundle_path)
        .map_err(|error| format!("Failed to create diagnostics bundle: {}", error))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let metadata = DiagnosticMetadata {
        exported_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        debug_assertions: cfg!(debug_assertions),
        current_pid: std::process::id(),
        current_log_info: crate::logging::get_runtime_logging_info(),
        previous_unexpected_exit: previous_unexpected_exit(),
        platform_crash_report_hints: platform_crash_report_hints(),
    };
    add_json_entry(&mut zip, DIAGNOSTIC_METADATA_FILE, &metadata, options)?;

    if context.run_state_path.exists() {
        add_file_entry(&mut zip, &context.run_state_path, RUN_STATE_FILE, options)?;
    }

    for session_dir in recent_session_dirs(&context.logs_root, MAX_BUNDLED_LOG_SESSIONS)? {
        let name = session_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown-session");
        add_directory_entries(
            &mut zip,
            &session_dir,
            &format!("sessions/{}", name),
            options,
        )?;
    }

    zip.finish()
        .map_err(|error| format!("Failed to finish diagnostics bundle: {}", error))?;

    Ok(DiagnosticsBundleInfo {
        bundle_path: bundle_path.to_string_lossy().to_string(),
    })
}

fn detect_previous_unexpected_exit(run_state_path: &Path) -> Option<UnexpectedExitInfo> {
    let state = read_json_file::<RunState>(run_state_path).ok()?;
    if state.clean_shutdown {
        return None;
    }

    let session_log_dir = if state.session_log_dir.is_empty() {
        None
    } else {
        Some(state.session_log_dir.clone())
    };
    let crash_report_path = session_log_dir
        .as_ref()
        .map(PathBuf::from)
        .map(|path| path.join(CRASH_REPORT_FILE))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string());

    let category = if crash_report_path.is_some() {
        UnexpectedExitCategory::Crash
    } else {
        UnexpectedExitCategory::UncleanShutdown
    };
    let notify_on_startup = matches!(category, UnexpectedExitCategory::Crash);
    let reason = match category {
        UnexpectedExitCategory::Crash => {
            "Previous run wrote a crash report before shutdown".to_string()
        }
        UnexpectedExitCategory::UncleanShutdown => {
            "Previous run state was not marked as clean shutdown".to_string()
        }
    };

    Some(UnexpectedExitInfo {
        detected: true,
        started_at: Some(state.started_at),
        session_log_dir,
        crash_report_path,
        category,
        notify_on_startup,
        reason,
    })
}

fn recent_session_dirs(logs_root: &Path, limit: usize) -> Result<Vec<PathBuf>, String> {
    let pattern = regex::Regex::new(r"^\d{8}T\d{6}$")
        .map_err(|error| format!("Invalid log session pattern: {}", error))?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(logs_root)
        .map_err(|error| format!("Failed to read logs directory: {}", error))?
    {
        let entry = entry.map_err(|error| format!("Failed to read logs entry: {}", error))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if pattern.is_match(name) {
            entries.push(path);
        }
    }

    entries.sort();
    entries.reverse();
    entries.truncate(limit);
    entries.reverse();
    Ok(entries)
}

fn add_directory_entries(
    zip: &mut zip::ZipWriter<File>,
    dir: &Path,
    archive_prefix: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    for entry in fs::read_dir(dir)
        .map_err(|error| format!("Failed to read directory {}: {}", dir.display(), error))?
    {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {}", error))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let archive_path = format!("{}/{}", archive_prefix, name);

        if path.is_dir() {
            add_directory_entries(zip, &path, &archive_path, options)?;
        } else if path.is_file() {
            add_file_entry(zip, &path, &archive_path, options)?;
        }
    }

    Ok(())
}

fn add_json_entry<T: Serialize>(
    zip: &mut zip::ZipWriter<File>,
    archive_path: &str,
    value: &T,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {}", archive_path, error))?;
    zip.start_file(normalize_archive_path(archive_path), options)
        .map_err(|error| {
            format!(
                "Failed to add {} to diagnostics bundle: {}",
                archive_path, error
            )
        })?;
    zip.write_all(&content).map_err(|error| {
        format!(
            "Failed to write {} to diagnostics bundle: {}",
            archive_path, error
        )
    })
}

fn add_file_entry(
    zip: &mut zip::ZipWriter<File>,
    source_path: &Path,
    archive_path: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    let mut file = File::open(source_path)
        .map_err(|error| format!("Failed to open {}: {}", source_path.display(), error))?;
    zip.start_file(normalize_archive_path(archive_path), options)
        .map_err(|error| {
            format!(
                "Failed to add {} to diagnostics bundle: {}",
                archive_path, error
            )
        })?;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read {}: {}", source_path.display(), error))?;
        if read == 0 {
            break;
        }
        zip.write_all(&buffer[..read]).map_err(|error| {
            format!(
                "Failed to write {} to diagnostics bundle: {}",
                archive_path, error
            )
        })?;
    }
    Ok(())
}

fn normalize_archive_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {}", parent.display(), error))?;
    }
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize {}: {}", path.display(), error))?;
    fs::write(path, content)
        .map_err(|error| format!("Failed to write {}: {}", path.display(), error))
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let content =
        fs::read(path).map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    serde_json::from_slice(&content)
        .map_err(|error| format!("Failed to parse {}: {}", path.display(), error))
}

fn platform_crash_report_hints() -> Vec<String> {
    match std::env::consts::OS {
        "macos" => vec![
            "~/Library/Logs/DiagnosticReports".to_string(),
            "Console.app Diagnostic Reports".to_string(),
        ],
        "windows" => vec![
            "Windows Error Reporting".to_string(),
            "Event Viewer > Windows Logs > Application".to_string(),
        ],
        "linux" => vec!["coredumpctl".to_string(), "systemd-coredump".to_string()],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn detects_previous_unclean_run_state_with_crash_report() {
        let temp_dir = std::env::temp_dir().join(format!(
            "openbitfun-crash-diagnostics-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        ));
        let session_dir = temp_dir.join("20260528T120000");
        fs::create_dir_all(&session_dir).expect("test session directory should be created");
        fs::write(session_dir.join(CRASH_REPORT_FILE), "{}")
            .expect("test crash report should be written");

        let run_state = RunState {
            app_version: "test".to_string(),
            pid: 123,
            started_at: "2026-05-28T12:00:00Z".to_string(),
            updated_at: "2026-05-28T12:00:01Z".to_string(),
            session_log_dir: session_dir.to_string_lossy().to_string(),
            clean_shutdown: false,
            shutdown_at: None,
            exit_reason: None,
            startup_trace_id: "test-trace".to_string(),
        };
        let run_state_path = temp_dir.join(RUN_STATE_FILE);
        write_json_file(&run_state_path, &run_state).expect("test run state should be written");

        let info = detect_previous_unexpected_exit(&run_state_path)
            .expect("unclean run state should be detected");
        assert!(info.detected);
        assert_eq!(
            info.session_log_dir.as_deref(),
            Some(session_dir.to_string_lossy().as_ref())
        );
        assert!(info.crash_report_path.is_some());
        assert_eq!(info.category, UnexpectedExitCategory::Crash);
        assert!(info.notify_on_startup);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn ignores_previous_clean_run_state() {
        let temp_dir = std::env::temp_dir().join(format!(
            "openbitfun-crash-diagnostics-clean-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&temp_dir).expect("test directory should be created");
        let run_state = RunState {
            app_version: "test".to_string(),
            pid: 123,
            started_at: "2026-05-28T12:00:00Z".to_string(),
            updated_at: "2026-05-28T12:00:01Z".to_string(),
            session_log_dir: temp_dir.to_string_lossy().to_string(),
            clean_shutdown: true,
            shutdown_at: Some("2026-05-28T12:00:02Z".to_string()),
            exit_reason: Some("test".to_string()),
            startup_trace_id: "test-trace".to_string(),
        };
        let run_state_path = temp_dir.join(RUN_STATE_FILE);
        write_json_file(&run_state_path, &run_state).expect("test run state should be written");

        assert!(detect_previous_unexpected_exit(&run_state_path).is_none());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn records_unclean_shutdown_without_startup_notification_when_no_crash_report() {
        let temp_dir = std::env::temp_dir().join(format!(
            "openbitfun-crash-diagnostics-unclean-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        ));
        let session_dir = temp_dir.join("20260528T120000");
        fs::create_dir_all(&session_dir).expect("test session directory should be created");

        let run_state = RunState {
            app_version: "test".to_string(),
            pid: 123,
            started_at: "2026-05-28T12:00:00Z".to_string(),
            updated_at: "2026-05-28T12:00:01Z".to_string(),
            session_log_dir: session_dir.to_string_lossy().to_string(),
            clean_shutdown: false,
            shutdown_at: None,
            exit_reason: None,
            startup_trace_id: "test-trace".to_string(),
        };
        let run_state_path = temp_dir.join(RUN_STATE_FILE);
        write_json_file(&run_state_path, &run_state).expect("test run state should be written");

        let info = detect_previous_unexpected_exit(&run_state_path)
            .expect("unclean run state should still be recorded");
        assert!(info.detected);
        assert!(info.crash_report_path.is_none());
        assert_eq!(info.category, UnexpectedExitCategory::UncleanShutdown);
        assert!(!info.notify_on_startup);

        let _ = fs::remove_dir_all(temp_dir);
    }
}
