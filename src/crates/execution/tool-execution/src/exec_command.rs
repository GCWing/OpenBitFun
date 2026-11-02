use crate::background_command_output::BackgroundCommandOutputStatus;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;

pub const EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX: &str =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";
pub const EXEC_COMMAND_DEFAULT_YIELD_TIME_MS: u64 = 30_000;
pub const REMOTE_EXEC_SHELL_PROBE_TIMEOUT_MS: u64 = 3_000;

const REMOTE_NON_TTY_INTERRUPT_GRACE_SECONDS: u64 = 2;
const REMOTE_EXEC_ENV_SNAPSHOT_TIMEOUT_MS: u64 = 3_000;
const REMOTE_EXEC_ENV_SNAPSHOT_MAX_OUTPUT_CHARS: usize = 128 * 1024;
const REMOTE_EXEC_ENV_SNAPSHOT_CONTROL_YIELD_TIME_MS: u64 = 500;
const REMOTE_EXEC_ENV_SNAPSHOT_CONTROL_MAX_OUTPUT_CHARS: usize = 2_000;
const REMOTE_EXEC_ENV_SNAPSHOT_TTL: Duration = Duration::from_secs(10 * 60);
const REMOTE_ENV_SNAPSHOT_BEGIN: &str = "__OPENBITFUN_REMOTE_ENV_SNAPSHOT_BEGIN__";
const REMOTE_ENV_SNAPSHOT_END: &str = "__OPENBITFUN_REMOTE_ENV_SNAPSHOT_END__";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCommandControlAction {
    Interrupt,
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCommandControlOrigin {
    ModelTool,
    OutOfBand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCommandCompletionStatus {
    Exited,
    Interrupted,
    Killed,
    Pruned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecCommandCompletionSource {
    Process,
    OutOfBandControl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecCommandCompletion {
    pub status: ExecCommandCompletionStatus,
    pub source: ExecCommandCompletionSource,
}

#[derive(Debug, Clone)]
pub struct ExecCommandControlRequest {
    pub session_id: i32,
    pub action: ExecCommandControlAction,
    pub origin: ExecCommandControlOrigin,
    pub remote: bool,
    pub yield_time_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ExecCommandControlResponse {
    pub chunk_id: String,
    pub wall_time_seconds: f64,
    pub output: String,
    pub session_id: Option<i32>,
    pub exit_code: Option<i32>,
    pub original_output_chars: usize,
    pub action: ExecCommandControlAction,
    pub remote: bool,
    pub completion: Option<ExecCommandCompletion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCommandRunInput<'a> {
    pub cmd: &'a str,
    pub tty: bool,
    pub yield_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteStdinInput {
    pub session_id: i32,
    pub chars: String,
    pub append_enter: bool,
    pub yield_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCommandControlToolInput {
    pub session_id: i32,
    pub action: ExecCommandControlAction,
    pub yield_time_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecCommandResultFields {
    pub chunk_id: String,
    pub wall_time_seconds: f64,
    pub output: String,
    pub session_id: Option<i32>,
    pub exit_code: Option<i32>,
    pub original_output_chars: usize,
    pub completion: Option<ExecCommandCompletion>,
    pub remote: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCommandShellMetadata {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub invocation: String,
    pub pipeline_failure_policy: String,
    pub remote_env_snapshot_applied: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecCommandResultData {
    pub fields: ExecCommandResultFields,
    pub workdir: String,
    pub tty: bool,
    pub shell: ExecCommandShellMetadata,
}

#[derive(Debug, Clone)]
pub struct ExecCommandSessionNotFoundResult {
    pub data: Value,
    pub assistant_message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExecCommandLifecycleStatus {
    Running,
    Exited,
    Interrupted,
    Killed,
    Pruned,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ExecCommandShellKind {
    Bash,
    Zsh,
    Fish,
    PowerShell,
    PowerShellCore,
    Cmd,
    Sh,
    Ksh,
    Csh,
    Custom(String),
}

impl ExecCommandShellKind {
    pub fn from_executable(path: &str) -> Self {
        let name = std::path::Path::new(path)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or(path)
            .to_lowercase();

        match name.as_str() {
            "bash" => Self::Bash,
            "zsh" => Self::Zsh,
            "fish" => Self::Fish,
            "powershell" => Self::PowerShell,
            "pwsh" => Self::PowerShellCore,
            "cmd" => Self::Cmd,
            "sh" => Self::Sh,
            "ksh" => Self::Ksh,
            "csh" | "tcsh" => Self::Csh,
            _ => Self::Custom(name),
        }
    }

    fn uses_posix_invocation(&self) -> bool {
        matches!(
            self,
            Self::Bash
                | Self::Zsh
                | Self::Fish
                | Self::Sh
                | Self::Ksh
                | Self::Csh
                | Self::Custom(_)
        )
    }

    fn supports_pipefail(&self) -> bool {
        matches!(self, Self::Bash | Self::Zsh | Self::Ksh)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCommandRemoteShell {
    pub path: String,
    pub kind: ExecCommandShellKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecCommandRemoteEnvSnapshotCapturePolicy {
    pub timeout_ms: u64,
    pub max_output_chars: usize,
    pub stale_session_control_yield_time_ms: u64,
    pub stale_session_control_max_output_chars: usize,
    pub ttl: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCommandRemoteEnvSnapshot {
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ExecCommandRemoteEnvSnapshotCacheKey {
    connection_id: String,
    shell_path: String,
    shell_kind: String,
}

impl ExecCommandRemoteEnvSnapshotCacheKey {
    pub fn new(
        connection_id: impl Into<String>,
        shell_path: impl Into<String>,
        shell_kind: impl Into<String>,
    ) -> Self {
        Self {
            connection_id: connection_id.into(),
            shell_path: shell_path.into(),
            shell_kind: shell_kind.into(),
        }
    }
}

#[derive(Debug, Clone)]
struct CachedRemoteEnvSnapshot {
    captured_at: std::time::Instant,
    snapshot: ExecCommandRemoteEnvSnapshot,
}

#[derive(Debug, Default)]
pub struct ExecCommandRemoteEnvSnapshotCache {
    snapshots:
        tokio::sync::Mutex<HashMap<ExecCommandRemoteEnvSnapshotCacheKey, CachedRemoteEnvSnapshot>>,
}

impl ExecCommandRemoteEnvSnapshotCache {
    pub async fn get(
        &self,
        key: &ExecCommandRemoteEnvSnapshotCacheKey,
    ) -> Option<ExecCommandRemoteEnvSnapshot> {
        let policy = remote_exec_env_snapshot_capture_policy();
        self.snapshots
            .lock()
            .await
            .get(key)
            .filter(|entry| entry.captured_at.elapsed() <= policy.ttl)
            .map(|entry| entry.snapshot.clone())
    }

    pub async fn insert(
        &self,
        key: ExecCommandRemoteEnvSnapshotCacheKey,
        snapshot: ExecCommandRemoteEnvSnapshot,
    ) {
        self.snapshots.lock().await.insert(
            key,
            CachedRemoteEnvSnapshot {
                captured_at: std::time::Instant::now(),
                snapshot,
            },
        );
    }
}

pub fn exec_command_noninteractive_env() -> HashMap<String, String> {
    HashMap::from([
        ("NO_COLOR".to_string(), "1".to_string()),
        ("TERM".to_string(), "dumb".to_string()),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("LC_CTYPE".to_string(), "C.UTF-8".to_string()),
        ("COLORTERM".to_string(), String::new()),
        ("CLICOLOR".to_string(), "0".to_string()),
        ("PAGER".to_string(), "cat".to_string()),
        ("GIT_PAGER".to_string(), "cat".to_string()),
        ("GH_PAGER".to_string(), "cat".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("GIT_EDITOR".to_string(), "true".to_string()),
        ("OPENBITFUN_NONINTERACTIVE".to_string(), "1".to_string()),
    ])
}

pub fn exec_command_argv_for_shell(
    shell_path: impl Into<String>,
    shell_kind: ExecCommandShellKind,
    cmd: &str,
) -> Vec<String> {
    let shell = shell_path.into();
    if shell_kind.uses_posix_invocation() {
        let mut argv = vec![shell];
        argv.extend(
            exec_command_posix_shell_args(&shell_kind)
                .iter()
                .map(|arg| (*arg).to_string()),
        );
        argv.push(cmd.to_string());
        return argv;
    }

    match shell_kind {
        ExecCommandShellKind::PowerShell | ExecCommandShellKind::PowerShellCore => vec![
            shell,
            "-Command".to_string(),
            exec_command_powershell_command_with_utf8_output(cmd),
        ],
        ExecCommandShellKind::Cmd => vec![shell, "/c".to_string(), cmd.to_string()],
        _ => unreachable!("POSIX shell kinds returned earlier"),
    }
}

/// Builds argv for a reviewed one-shot command without loading shell profiles.
///
/// This is intentionally separate from [`exec_command_argv_for_shell`]: Agent
/// Exec keeps its login-shell and pipefail behavior, while reviewed expansion
/// must not execute undisclosed profile or autorun content before the command
/// the user approved.
pub fn exec_command_argv_for_isolated_shell(
    shell_path: impl Into<String>,
    shell_kind: ExecCommandShellKind,
    cmd: &str,
) -> Vec<String> {
    let shell = shell_path.into();
    match shell_kind {
        ExecCommandShellKind::PowerShell | ExecCommandShellKind::PowerShellCore => vec![
            shell,
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            exec_command_powershell_command_with_utf8_output(cmd),
        ],
        ExecCommandShellKind::Cmd => vec![
            shell,
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            cmd.to_string(),
        ],
        _ => vec![shell, "-c".to_string(), cmd.to_string()],
    }
}

pub fn exec_command_powershell_command_with_utf8_output(cmd: &str) -> String {
    let trimmed = cmd.trim_start();
    if trimmed.starts_with(EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX) {
        cmd.to_string()
    } else {
        format!("{EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX}{cmd}")
    }
}

pub fn exec_command_shell_invocation_for_model(
    shell_path: &str,
    shell_kind: ExecCommandShellKind,
) -> String {
    if shell_kind.uses_posix_invocation() {
        return format!(
            "`{shell_path} {} <cmd>`",
            exec_command_posix_shell_args(&shell_kind).join(" ")
        );
    }

    match shell_kind {
        ExecCommandShellKind::PowerShell | ExecCommandShellKind::PowerShellCore => {
            format!("`{shell_path} -Command <cmd>`")
        }
        ExecCommandShellKind::Cmd => format!("`{shell_path} /c <cmd>`"),
        _ => unreachable!("POSIX shell kinds returned earlier"),
    }
}

pub fn remote_exec_login_shell_command(
    workdir: &str,
    cmd: &str,
    shell_path: &str,
    shell_kind: ExecCommandShellKind,
    env_snapshot: Option<&ExecCommandRemoteEnvSnapshot>,
) -> String {
    let env_words = remote_command_env_words(merged_remote_exec_env(env_snapshot));
    let shell_args = remote_exec_shell_login_args(&shell_kind).join(" ");

    format!(
        "cd {} && env {} {} {} {}",
        exec_command_shell_escape(workdir),
        env_words,
        exec_command_shell_escape(shell_path),
        shell_args,
        exec_command_shell_escape(cmd)
    )
}

pub fn remote_exec_non_tty_control_wrapper(
    cmd: &str,
    shell_path: &str,
    shell_kind: ExecCommandShellKind,
) -> String {
    let escaped_shell = exec_command_shell_escape(shell_path);
    let escaped_cmd = exec_command_shell_escape(cmd);
    let shell_args = remote_exec_shell_login_args(&shell_kind).join(" ");
    format!(
        r#"__openbitfun_shell={escaped_shell}
__openbitfun_cmd={escaped_cmd}
if command -v setsid >/dev/null 2>&1; then
  setsid "$__openbitfun_shell" {shell_args} "$__openbitfun_cmd" &
else
  "$__openbitfun_shell" {shell_args} "$__openbitfun_cmd" &
fi
__openbitfun_child=$!
__openbitfun_pgid=$__openbitfun_child
__openbitfun_stop() {{
  __openbitfun_signal=${{1:-INT}}
  __openbitfun_exit=${{2:-130}}
  __openbitfun_grace=${{3:-{REMOTE_NON_TTY_INTERRUPT_GRACE_SECONDS}}}
  trap - INT TERM
  kill -"$__openbitfun_signal" "-$__openbitfun_pgid" 2>/dev/null || kill -"$__openbitfun_signal" "$__openbitfun_child" 2>/dev/null || true
  if [ "$__openbitfun_grace" -gt 0 ]; then
    sleep "$__openbitfun_grace"
  fi
  kill -KILL "-$__openbitfun_pgid" 2>/dev/null || kill -KILL "$__openbitfun_child" 2>/dev/null || true
  wait "$__openbitfun_child" 2>/dev/null || true
  exit "$__openbitfun_exit"
}}
trap '__openbitfun_stop INT 130 {REMOTE_NON_TTY_INTERRUPT_GRACE_SECONDS}' INT
trap '__openbitfun_stop KILL 137 0' TERM
wait "$__openbitfun_child"
__openbitfun_status=$?
trap - INT TERM
exit "$__openbitfun_status""#
    )
}

pub fn parse_remote_exec_shell_probe_output(stdout: &str) -> Option<ExecCommandRemoteShell> {
    stdout
        .lines()
        .map(str::trim)
        .find(|path| is_posix_compatible_remote_shell_path(path))
        .map(|path| ExecCommandRemoteShell {
            path: path.to_string(),
            kind: ExecCommandShellKind::from_executable(path),
        })
}

pub fn remote_exec_shell_probe_command() -> &'static str {
    concat!(
        "printf '%s\\n' \"${SHELL:-}\"; ",
        "getent passwd \"$(id -un)\" 2>/dev/null | cut -d: -f7; ",
        "command -v bash 2>/dev/null; ",
        "command -v zsh 2>/dev/null; ",
        "command -v sh 2>/dev/null"
    )
}

pub fn fallback_remote_exec_shell() -> ExecCommandRemoteShell {
    ExecCommandRemoteShell {
        path: "/bin/bash".to_string(),
        kind: ExecCommandShellKind::Bash,
    }
}

pub fn exec_command_posix_shell_args(shell_kind: &ExecCommandShellKind) -> &'static [&'static str] {
    if shell_kind.supports_pipefail() {
        &["-o", "pipefail", "-lc"]
    } else {
        &["-lc"]
    }
}

pub fn exec_command_pipeline_failure_policy(shell_kind: &ExecCommandShellKind) -> &'static str {
    if shell_kind.supports_pipefail() {
        "pipefail"
    } else {
        "last_command"
    }
}

pub fn remote_exec_shell_login_args(shell_kind: &ExecCommandShellKind) -> &'static [&'static str] {
    exec_command_posix_shell_args(shell_kind)
}

pub fn remote_exec_env_snapshot_capture_policy() -> ExecCommandRemoteEnvSnapshotCapturePolicy {
    ExecCommandRemoteEnvSnapshotCapturePolicy {
        timeout_ms: REMOTE_EXEC_ENV_SNAPSHOT_TIMEOUT_MS,
        max_output_chars: REMOTE_EXEC_ENV_SNAPSHOT_MAX_OUTPUT_CHARS,
        stale_session_control_yield_time_ms: REMOTE_EXEC_ENV_SNAPSHOT_CONTROL_YIELD_TIME_MS,
        stale_session_control_max_output_chars: REMOTE_EXEC_ENV_SNAPSHOT_CONTROL_MAX_OUTPUT_CHARS,
        ttl: REMOTE_EXEC_ENV_SNAPSHOT_TTL,
    }
}

pub fn remote_exec_env_snapshot_command(
    shell_path: &str,
    shell_kind: ExecCommandShellKind,
) -> String {
    let script = format!(
        "printf '%s\\n' {begin}; env; printf '%s\\n' {end}",
        begin = exec_command_shell_escape(REMOTE_ENV_SNAPSHOT_BEGIN),
        end = exec_command_shell_escape(REMOTE_ENV_SNAPSHOT_END)
    );
    format!(
        "{} {} {}",
        exec_command_shell_escape(shell_path),
        remote_exec_env_snapshot_shell_args(shell_kind).join(" "),
        exec_command_shell_escape(&script)
    )
}

pub fn remote_exec_env_snapshot_shell_args(
    shell_kind: ExecCommandShellKind,
) -> &'static [&'static str] {
    match shell_kind {
        ExecCommandShellKind::Bash | ExecCommandShellKind::Zsh => &["-lic"],
        _ => &["-lc"],
    }
}

pub fn parse_remote_exec_env_snapshot_output(output: &str) -> Option<ExecCommandRemoteEnvSnapshot> {
    let mut env = HashMap::new();
    let mut inside = false;
    let mut saw_end = false;

    for raw_line in output.lines() {
        let line = raw_line.trim_end_matches('\r');
        if !inside {
            if line == REMOTE_ENV_SNAPSHOT_BEGIN {
                inside = true;
            }
            continue;
        }

        if line == REMOTE_ENV_SNAPSHOT_END {
            saw_end = true;
            break;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if should_import_remote_exec_env_var(key, value) {
            env.insert(key.to_string(), value.to_string());
        }
    }

    (inside && saw_end).then_some(ExecCommandRemoteEnvSnapshot { env })
}

pub fn exec_command_shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn merged_remote_exec_env(
    env_snapshot: Option<&ExecCommandRemoteEnvSnapshot>,
) -> HashMap<String, String> {
    let mut env = env_snapshot
        .map(|snapshot| snapshot.env.clone())
        .unwrap_or_default();
    env.extend(exec_command_noninteractive_env());
    env
}

fn remote_command_env_words(env: HashMap<String, String>) -> String {
    let mut env: Vec<_> = env.into_iter().collect();
    env.sort_by(|(left, _), (right, _)| left.cmp(right));
    env.into_iter()
        .map(|(key, value)| exec_command_shell_escape(&format!("{key}={value}")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_plausible_remote_shell_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains('\0')
        && path.chars().all(|ch| !ch.is_control() || ch == '\t')
}

fn is_posix_compatible_remote_shell_path(path: &str) -> bool {
    is_plausible_remote_shell_path(path)
        && ExecCommandShellKind::from_executable(path).uses_posix_invocation()
}

fn should_import_remote_exec_env_var(key: &str, value: &str) -> bool {
    is_valid_remote_exec_env_var_name(key)
        && !is_volatile_remote_exec_env_var(key)
        && !value.contains('\0')
}

fn is_valid_remote_exec_env_var_name(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn is_volatile_remote_exec_env_var(key: &str) -> bool {
    matches!(
        key,
        "_" | "PWD" | "OLDPWD" | "SHLVL" | "TERM" | "COLUMNS" | "LINES"
    )
}

pub fn exec_command_session_id_from_input(input: &Value) -> Option<i32> {
    input.get("session_id").and_then(|value| {
        value
            .as_i64()
            .and_then(|id| i32::try_from(id).ok())
            .or_else(|| value.as_u64().and_then(|id| i32::try_from(id).ok()))
    })
}

pub fn exec_command_run_input_from_input(input: &Value) -> Option<ExecCommandRunInput<'_>> {
    Some(ExecCommandRunInput {
        cmd: input.get("cmd").and_then(Value::as_str)?,
        tty: input.get("tty").and_then(Value::as_bool).unwrap_or(false),
        yield_time_ms: exec_command_yield_time_ms_from_input(input),
    })
}

pub fn exec_command_run_input_validation_message(input: &Value) -> Option<&'static str> {
    let cmd = input.get("cmd").and_then(Value::as_str).unwrap_or_default();
    cmd.trim()
        .is_empty()
        .then_some("cmd is required for ExecCommand")
}

pub fn write_stdin_input_from_input(input: &Value) -> Option<WriteStdinInput> {
    Some(WriteStdinInput {
        session_id: exec_command_session_id_from_input(input)?,
        chars: input
            .get("chars")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        append_enter: input
            .get("append_enter")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        yield_time_ms: exec_command_yield_time_ms_from_input(input),
    })
}

pub fn write_stdin_input_validation_message(input: &Value) -> Option<&'static str> {
    exec_command_session_id_from_input(input)
        .is_none()
        .then_some("session_id is required for WriteStdin")
}

pub fn exec_command_control_tool_input_from_input(
    input: &Value,
) -> Option<ExecCommandControlToolInput> {
    Some(ExecCommandControlToolInput {
        session_id: exec_command_session_id_from_input(input)?,
        action: exec_command_control_action_from_input(input)?,
        yield_time_ms: input.get("yield_time_ms").and_then(Value::as_u64),
    })
}

pub fn exec_command_control_tool_input_validation_message(input: &Value) -> Option<&'static str> {
    if exec_command_session_id_from_input(input).is_none() {
        return Some("session_id is required for ExecControl");
    }
    if exec_command_control_action_from_input(input).is_none() {
        return Some("action must be either 'interrupt' or 'kill'");
    }
    None
}

pub fn exec_command_control_action_from_input(input: &Value) -> Option<ExecCommandControlAction> {
    match input.get("action").and_then(Value::as_str)?.trim() {
        "interrupt" => Some(ExecCommandControlAction::Interrupt),
        "kill" => Some(ExecCommandControlAction::Kill),
        _ => None,
    }
}

pub fn exec_command_control_action_name(action: ExecCommandControlAction) -> &'static str {
    match action {
        ExecCommandControlAction::Interrupt => "interrupt",
        ExecCommandControlAction::Kill => "kill",
    }
}

pub fn exec_command_completion_value(completion: ExecCommandCompletion) -> Value {
    json!({
        "status": exec_command_completion_status_name(completion.status),
        "source": exec_command_completion_source_name(completion.source),
    })
}

pub fn exec_command_shell_metadata_value(metadata: ExecCommandShellMetadata) -> Value {
    let mut value = json!({
        "name": metadata.name,
        "type": metadata.kind,
        "path": metadata.path,
        "invocation": metadata.invocation,
        "pipeline_failure_policy": metadata.pipeline_failure_policy,
    });
    if let Some(remote_env_snapshot_applied) = metadata.remote_env_snapshot_applied {
        value["remote_env_snapshot_applied"] = json!(remote_env_snapshot_applied);
    }
    value
}

pub fn exec_command_result_value(result: ExecCommandResultData) -> Value {
    let mut data = exec_command_result_fields_value(result.fields, true);
    data["workdir"] = json!(result.workdir);
    data["tty"] = json!(result.tty);
    data["shell"] = exec_command_shell_metadata_value(result.shell);
    data
}

pub fn write_stdin_result_value(fields: ExecCommandResultFields) -> Value {
    exec_command_result_fields_value(fields, true)
}

pub fn exec_control_result_value(
    fields: ExecCommandResultFields,
    action: ExecCommandControlAction,
) -> Value {
    let mut data = exec_command_result_fields_value(fields, false);
    data["action"] = json!(exec_command_control_action_name(action));
    data
}

pub fn exec_command_background_output_status(
    completion: Option<ExecCommandCompletion>,
) -> BackgroundCommandOutputStatus {
    match completion.map(|completion| completion.status) {
        Some(ExecCommandCompletionStatus::Interrupted) => {
            BackgroundCommandOutputStatus::Interrupted
        }
        Some(ExecCommandCompletionStatus::Killed) => BackgroundCommandOutputStatus::Killed,
        Some(ExecCommandCompletionStatus::Pruned) => BackgroundCommandOutputStatus::Pruned,
        Some(ExecCommandCompletionStatus::Exited) | None => BackgroundCommandOutputStatus::Exited,
    }
}

pub fn exec_command_lifecycle_status_name(status: ExecCommandLifecycleStatus) -> &'static str {
    match status {
        ExecCommandLifecycleStatus::Running => "running",
        ExecCommandLifecycleStatus::Exited => "exited",
        ExecCommandLifecycleStatus::Interrupted => "interrupted",
        ExecCommandLifecycleStatus::Killed => "killed",
        ExecCommandLifecycleStatus::Pruned => "pruned",
    }
}

pub fn exec_command_lifecycle_background_output_status(
    status: ExecCommandLifecycleStatus,
) -> BackgroundCommandOutputStatus {
    match status {
        ExecCommandLifecycleStatus::Running => BackgroundCommandOutputStatus::Running,
        ExecCommandLifecycleStatus::Exited => BackgroundCommandOutputStatus::Exited,
        ExecCommandLifecycleStatus::Interrupted => BackgroundCommandOutputStatus::Interrupted,
        ExecCommandLifecycleStatus::Killed => BackgroundCommandOutputStatus::Killed,
        ExecCommandLifecycleStatus::Pruned => BackgroundCommandOutputStatus::Pruned,
    }
}

fn exec_command_yield_time_ms_from_input(input: &Value) -> u64 {
    input
        .get("yield_time_ms")
        .and_then(Value::as_u64)
        .unwrap_or(EXEC_COMMAND_DEFAULT_YIELD_TIME_MS)
}

fn exec_command_result_fields_value(
    fields: ExecCommandResultFields,
    include_completion: bool,
) -> Value {
    let mut data = json!({
        "wall_time_seconds": fields.wall_time_seconds,
        "output": fields.output,
        "session_id": fields.session_id,
        "exit_code": fields.exit_code,
    });
    if include_completion {
        data["completion"] = fields
            .completion
            .map(exec_command_completion_value)
            .unwrap_or(Value::Null);
    }
    if fields.remote {
        data["remote"] = json!(true);
    }
    data
}

pub fn render_exec_response_for_assistant(
    data: &Value,
    status_lines: Vec<String>,
    wall_time_precision: usize,
) -> String {
    render_exec_response_for_assistant_with_notes(
        data,
        status_lines,
        Vec::new(),
        wall_time_precision,
    )
}

pub fn render_exec_response_for_assistant_with_notes(
    data: &Value,
    status_lines: Vec<String>,
    note_lines: Vec<String>,
    wall_time_precision: usize,
) -> String {
    let output = data.get("output").and_then(Value::as_str).unwrap_or("");
    let status = if status_lines.is_empty() {
        "Process status unavailable.".to_string()
    } else {
        status_lines.join("\n")
    };
    let wall_time = format!(
        "{:.precision$} seconds",
        data.get("wall_time_seconds")
            .and_then(Value::as_f64)
            .unwrap_or_default(),
        precision = wall_time_precision,
    );
    let note_section = if note_lines.is_empty() {
        String::new()
    } else {
        format!("<note>\n{}\n</note>\n", note_lines.join("\n"))
    };

    format!(
        "<status>\n{status}\n</status>\n<wall_time>\n{wall_time}\n</wall_time>\n{note_section}<output>\n{output}\n</output>"
    )
}

pub fn render_exec_command_response_for_assistant(data: &Value) -> String {
    let status_lines = completion_status_lines(data);
    let mut note_lines = Vec::new();

    if data.get("tty").and_then(Value::as_bool) == Some(false)
        && data
            .get("output")
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
    {
        note_lines.push(
            "No output was produced. In non-TTY mode, programs may block-buffer pipe output; use unbuffered flags/env vars or TTY mode if progressive output matters."
                .to_string(),
        );
    }

    render_exec_response_for_assistant_with_notes(data, status_lines, note_lines, 3)
}

pub fn render_write_stdin_response_for_assistant(data: &Value) -> String {
    render_exec_response_for_assistant(data, completion_status_lines(data), 4)
}

pub fn render_exec_control_response_for_assistant(
    data: &Value,
    action: ExecCommandControlAction,
) -> String {
    let mut status_lines = Vec::new();
    match action {
        ExecCommandControlAction::Interrupt => {
            status_lines.push("Sent interrupt to process.".to_string())
        }
        ExecCommandControlAction::Kill => status_lines.push("Sent kill to process.".to_string()),
    }
    if let Some(exit_code) = data.get("exit_code").and_then(Value::as_i64) {
        status_lines.push(format!("Process exited with code {exit_code}."));
    } else if let Some(session_id) = data.get("session_id").and_then(Value::as_i64) {
        status_lines.push(format!(
            "Process is still running. session_id: {session_id}"
        ));
    }
    render_exec_response_for_assistant(data, status_lines, 4)
}

pub fn write_stdin_session_not_found_result(
    session_id: i32,
    remote: bool,
) -> ExecCommandSessionNotFoundResult {
    let message = format!(
        "ExecCommand session {session_id} was not found. It may have already exited, been collected, or been pruned."
    );
    let mut data = json!({
        "status": "session_not_found",
        "message": message,
        "requested_session_id": session_id,
        "session_id": null,
        "exit_code": null,
        "output": "",
    });
    if remote {
        data["remote"] = json!(true);
    }

    ExecCommandSessionNotFoundResult {
        data,
        assistant_message: message,
    }
}

pub fn exec_control_session_not_found_result(
    session_id: i32,
    action: ExecCommandControlAction,
    remote: bool,
) -> ExecCommandSessionNotFoundResult {
    let action_name = exec_command_control_action_name(action);
    let message = format!(
        "No {action_name} was sent because ExecCommand session {session_id} was not found. It may have already exited, been collected, or been pruned."
    );
    let mut data = json!({
        "status": "session_not_found",
        "message": message,
        "requested_session_id": session_id,
        "session_id": null,
        "exit_code": null,
        "output": "",
        "action": action_name,
    });
    if remote {
        data["remote"] = json!(true);
    }

    ExecCommandSessionNotFoundResult {
        data,
        assistant_message: message,
    }
}

fn completion_status_lines(data: &Value) -> Vec<String> {
    let mut status_lines = Vec::new();
    let completion = data.get("completion");
    let completion_source = completion
        .and_then(|value| value.get("source"))
        .and_then(Value::as_str);
    let completion_status = completion
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str);

    if completion_source == Some("out_of_band_control") {
        match completion_status {
            Some("interrupted") => {
                status_lines.push("Process was interrupted externally.".to_string())
            }
            Some("killed") => status_lines.push("Process was terminated externally.".to_string()),
            Some(status) => {
                status_lines.push(format!("Process ended externally with status {status}."))
            }
            None => status_lines.push("Process ended externally.".to_string()),
        }
        if let Some(exit_code) = data.get("exit_code").and_then(Value::as_i64) {
            status_lines.push(format!("Process exited with code {exit_code}."));
        }
    } else if let Some(exit_code) = data.get("exit_code").and_then(Value::as_i64) {
        status_lines.push(format!("Process exited with code {exit_code}."));
    } else if let Some(session_id) = data.get("session_id").and_then(Value::as_i64) {
        status_lines.push(format!(
            "Process is still running. session_id: {session_id}"
        ));
    } else if completion_status == Some("exited") {
        // The process finished but the transport never reported a status. Say so
        // instead of leaving the caller with "Process status unavailable", and
        // never invent a code — an invented failure reads as a real one.
        status_lines
            .push("Process exited, but no exit code was reported by the transport.".to_string());
    }

    status_lines
}

fn exec_command_completion_status_name(status: ExecCommandCompletionStatus) -> &'static str {
    match status {
        ExecCommandCompletionStatus::Exited => "exited",
        ExecCommandCompletionStatus::Interrupted => "interrupted",
        ExecCommandCompletionStatus::Killed => "killed",
        ExecCommandCompletionStatus::Pruned => "pruned",
    }
}

fn exec_command_completion_source_name(source: ExecCommandCompletionSource) -> &'static str {
    match source {
        ExecCommandCompletionSource::Process => "process",
        ExecCommandCompletionSource::OutOfBandControl => "out_of_band_control",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_exec_response_with_xmlish_sections() {
        let data = json!({
            "wall_time_seconds": 0.0068,
            "output": "sh: 1: node: not found\r\n",
        });

        let rendered = render_exec_response_for_assistant(
            &data,
            vec!["Process exited with code 127.".to_string()],
            3,
        );

        assert_eq!(
            rendered,
            "<status>\nProcess exited with code 127.\n</status>\n<wall_time>\n0.007 seconds\n</wall_time>\n<output>\nsh: 1: node: not found\r\n\n</output>"
        );
    }

    #[test]
    fn renders_exec_response_with_note_section() {
        let data = json!({
            "wall_time_seconds": 30.0,
            "output": "",
        });

        let rendered = render_exec_response_for_assistant_with_notes(
            &data,
            vec!["Process is still running. session_id: 42".to_string()],
            vec!["No output was produced during this wait window.".to_string()],
            3,
        );

        assert_eq!(
            rendered,
            "<status>\nProcess is still running. session_id: 42\n</status>\n<wall_time>\n30.000 seconds\n</wall_time>\n<note>\nNo output was produced during this wait window.\n</note>\n<output>\n\n</output>"
        );
    }

    #[test]
    fn command_response_keeps_non_tty_empty_output_note() {
        let data = json!({
            "wall_time_seconds": 1.0,
            "output": "",
            "tty": false,
            "session_id": 7,
        });

        let rendered = render_exec_command_response_for_assistant(&data);

        assert!(rendered.contains("Process is still running. session_id: 7"));
        assert!(rendered.contains("programs may block-buffer pipe output"));
        assert!(rendered.contains("<output>\n\n</output>"));
    }

    #[test]
    fn command_response_says_an_exited_process_had_no_reported_exit_code() {
        let data = json!({
            "wall_time_seconds": 0.1,
            "output": "workspace output\n",
            "tty": false,
            "session_id": null,
            "exit_code": null,
            "completion": {
                "status": "exited",
                "source": "process"
            }
        });

        let rendered = render_exec_command_response_for_assistant(&data);

        assert!(rendered.contains("Process exited, but no exit code was reported"));
        assert!(
            !rendered.contains("Process status unavailable."),
            "a completed process is not an unknown state"
        );
        assert!(
            !rendered.contains("code -1"),
            "an unknown status must never be rendered as a failing exit code"
        );
    }

    #[test]
    fn write_stdin_response_reports_external_interrupt() {
        let data = json!({
            "wall_time_seconds": 1.25,
            "output": "partial",
            "exit_code": 130,
            "completion": {
                "status": "interrupted",
                "source": "out_of_band_control"
            }
        });

        let rendered = render_write_stdin_response_for_assistant(&data);

        assert!(rendered.contains("Process was interrupted externally."));
        assert!(rendered.contains("Process exited with code 130."));
        assert!(rendered.contains("<wall_time>\n1.2500 seconds\n</wall_time>"));
    }

    #[test]
    fn control_session_not_found_result_is_plain_assistant_text() {
        let result =
            exec_control_session_not_found_result(456, ExecCommandControlAction::Interrupt, true);

        assert_eq!(
            result.data.get("status").and_then(Value::as_str),
            Some("session_not_found")
        );
        assert_eq!(
            result
                .data
                .get("requested_session_id")
                .and_then(Value::as_i64),
            Some(456)
        );
        assert_eq!(
            result.data.get("remote").and_then(Value::as_bool),
            Some(true)
        );
        assert!(result.assistant_message.contains("No interrupt was sent"));
        assert!(!result.assistant_message.contains("<wall_time>"));
        assert!(!result.assistant_message.contains("<output>"));
    }

    #[test]
    fn completion_value_uses_stable_snake_case_shape() {
        let value = exec_command_completion_value(ExecCommandCompletion {
            status: ExecCommandCompletionStatus::Killed,
            source: ExecCommandCompletionSource::OutOfBandControl,
        });

        assert_eq!(
            value,
            json!({
                "status": "killed",
                "source": "out_of_band_control",
            })
        );
    }

    #[test]
    fn background_output_status_maps_terminal_completion_without_core_types() {
        assert_eq!(
            exec_command_background_output_status(Some(ExecCommandCompletion {
                status: ExecCommandCompletionStatus::Interrupted,
                source: ExecCommandCompletionSource::Process,
            })),
            BackgroundCommandOutputStatus::Interrupted
        );
        assert_eq!(
            exec_command_background_output_status(Some(ExecCommandCompletion {
                status: ExecCommandCompletionStatus::Pruned,
                source: ExecCommandCompletionSource::OutOfBandControl,
            })),
            BackgroundCommandOutputStatus::Pruned
        );
        assert_eq!(
            exec_command_background_output_status(None),
            BackgroundCommandOutputStatus::Exited
        );
    }

    #[test]
    fn shell_policy_builds_powershell_argv_with_single_utf8_prefix() {
        let argv = exec_command_argv_for_shell(
            "pwsh",
            ExecCommandShellKind::PowerShellCore,
            "Get-Content README.md",
        );

        assert_eq!(argv[1], "-Command");
        assert!(argv[2].starts_with(EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX));

        let script = format!("{EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX}Write-Output ok");
        let prefixed =
            exec_command_argv_for_shell("pwsh", ExecCommandShellKind::PowerShellCore, &script);

        assert_eq!(prefixed[2], script);
    }

    #[test]
    fn isolated_shell_policy_does_not_load_profiles() {
        let powershell = exec_command_argv_for_isolated_shell(
            "pwsh",
            ExecCommandShellKind::PowerShellCore,
            "Write-Output ok",
        );
        assert_eq!(
            &powershell[..4],
            ["pwsh", "-NoProfile", "-NonInteractive", "-Command"]
        );
        assert!(powershell[4].starts_with(EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX));

        assert_eq!(
            exec_command_argv_for_isolated_shell(
                "/usr/bin/fish",
                ExecCommandShellKind::Fish,
                "echo ok"
            ),
            ["/usr/bin/fish", "-c", "echo ok"]
        );
        assert_eq!(
            exec_command_argv_for_isolated_shell(
                "/usr/bin/nu",
                ExecCommandShellKind::Custom("nu".to_string()),
                "echo ok"
            ),
            ["/usr/bin/nu", "-c", "echo ok"]
        );
        assert_eq!(
            exec_command_argv_for_isolated_shell("cmd.exe", ExecCommandShellKind::Cmd, "echo ok"),
            ["cmd.exe", "/d", "/s", "/c", "echo ok"]
        );
    }

    #[test]
    fn supported_posix_shells_enable_pipefail() {
        for shell_kind in [
            ExecCommandShellKind::Bash,
            ExecCommandShellKind::Zsh,
            ExecCommandShellKind::Ksh,
        ] {
            let argv =
                exec_command_argv_for_shell("/bin/shell", shell_kind.clone(), "false | tail -n 1");
            assert_eq!(
                argv,
                ["/bin/shell", "-o", "pipefail", "-lc", "false | tail -n 1"]
            );
            assert_eq!(
                exec_command_pipeline_failure_policy(&shell_kind),
                "pipefail"
            );
        }
    }

    #[test]
    fn unsupported_posix_shells_keep_last_command_pipeline_status() {
        let argv =
            exec_command_argv_for_shell("/bin/sh", ExecCommandShellKind::Sh, "false | tail -n 1");

        assert_eq!(argv, ["/bin/sh", "-lc", "false | tail -n 1"]);
        assert_eq!(
            exec_command_pipeline_failure_policy(&ExecCommandShellKind::Sh),
            "last_command"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bash_pipefail_preserves_pipeline_success_and_failure() {
        for (command, expected_success) in [
            ("printf 'ok\\n' | tail -n 1", true),
            ("false | tail -n 1", false),
            ("true | false | tail -n 1", false),
        ] {
            let argv =
                exec_command_argv_for_shell("/bin/bash", ExecCommandShellKind::Bash, command);
            let status = std::process::Command::new(&argv[0])
                .args(&argv[1..])
                .status()
                .expect("bash pipeline should execute");

            assert_eq!(
                status.success(),
                expected_success,
                "unexpected status for {command:?}: {status:?}"
            );
        }
    }

    #[test]
    fn remote_login_shell_command_applies_snapshot_then_tool_env() {
        let snapshot = ExecCommandRemoteEnvSnapshot {
            env: HashMap::from([
                ("PATH".to_string(), "/home/me/.nvm/bin:/usr/bin".to_string()),
                ("TERM".to_string(), "xterm-256color".to_string()),
            ]),
        };

        let command = remote_exec_login_shell_command(
            "/home/me/project",
            "node --version",
            "/bin/bash",
            ExecCommandShellKind::Bash,
            Some(&snapshot),
        );

        assert!(command.starts_with("cd '/home/me/project' && env "));
        assert!(command.contains("'PATH=/home/me/.nvm/bin:/usr/bin'"));
        assert!(command.contains("'TERM=dumb'"));
        assert!(!command.contains("'TERM=xterm-256color'"));
        assert!(command.ends_with(" '/bin/bash' -o pipefail -lc 'node --version'"));
    }

    #[test]
    fn remote_non_tty_control_wrapper_preserves_interrupt_cleanup_contract() {
        let wrapper = remote_exec_non_tty_control_wrapper(
            "python3 -c 'print(1)'",
            "/bin/bash",
            ExecCommandShellKind::Bash,
        );

        assert!(wrapper
            .contains("setsid \"$__openbitfun_shell\" -o pipefail -lc \"$__openbitfun_cmd\" &"));
        assert!(wrapper.contains("trap '__openbitfun_stop INT 130 2' INT"));
        assert!(wrapper.contains("trap '__openbitfun_stop KILL 137 0' TERM"));
        assert!(wrapper.contains("__openbitfun_grace=${3:-2}"));
        assert!(wrapper.contains("kill -KILL \"-$__openbitfun_pgid\""));
        assert!(wrapper.contains("__openbitfun_cmd='python3 -c '\\''print(1)'\\'''"));
    }

    #[test]
    fn remote_shell_probe_and_env_snapshot_are_provider_neutral() {
        let shell = parse_remote_exec_shell_probe_output("\n/bin/zsh\n/usr/bin/bash\n")
            .expect("shell should parse");

        assert!(remote_exec_shell_probe_command().contains("${SHELL:-}"));
        assert!(remote_exec_shell_probe_command().contains("getent passwd"));
        assert!(remote_exec_shell_probe_command().contains("command -v bash"));
        assert_eq!(fallback_remote_exec_shell().path, "/bin/bash");
        assert_eq!(
            fallback_remote_exec_shell().kind,
            ExecCommandShellKind::Bash
        );
        assert_eq!(shell.path, "/bin/zsh");
        assert_eq!(shell.kind, ExecCommandShellKind::Zsh);
        assert_eq!(
            remote_exec_env_snapshot_shell_args(ExecCommandShellKind::Bash),
            &["-lic"]
        );
        assert_eq!(
            remote_exec_env_snapshot_shell_args(ExecCommandShellKind::Sh),
            &["-lc"]
        );

        let snapshot = parse_remote_exec_env_snapshot_output(
            "noise\r\n__OPENBITFUN_REMOTE_ENV_SNAPSHOT_BEGIN__\r\nPATH=/home/me/.nvm/bin:/usr/bin\r\nNVM_DIR=/home/me/.nvm\r\nPWD=/tmp\r\nBAD-NAME=value\r\n__OPENBITFUN_REMOTE_ENV_SNAPSHOT_END__\r\nmore noise",
        )
        .expect("snapshot should parse");

        assert_eq!(
            snapshot.env.get("PATH").map(String::as_str),
            Some("/home/me/.nvm/bin:/usr/bin")
        );
        assert_eq!(
            snapshot.env.get("NVM_DIR").map(String::as_str),
            Some("/home/me/.nvm")
        );
        assert!(!snapshot.env.contains_key("PWD"));
        assert!(!snapshot.env.contains_key("BAD-NAME"));
    }

    #[test]
    fn remote_env_snapshot_capture_policy_keeps_existing_bounds() {
        let policy = remote_exec_env_snapshot_capture_policy();

        assert_eq!(policy.timeout_ms, 3_000);
        assert_eq!(policy.max_output_chars, 128 * 1024);
        assert_eq!(policy.stale_session_control_yield_time_ms, 500);
        assert_eq!(policy.stale_session_control_max_output_chars, 2_000);
        assert_eq!(policy.ttl, Duration::from_secs(10 * 60));
    }

    #[tokio::test]
    async fn remote_env_snapshot_cache_owns_key_and_ttl_policy() {
        let cache = ExecCommandRemoteEnvSnapshotCache::default();
        let key = ExecCommandRemoteEnvSnapshotCacheKey::new("conn-1", "/bin/bash", "bash");
        let snapshot = ExecCommandRemoteEnvSnapshot {
            env: HashMap::from([("PATH".to_string(), "/usr/bin".to_string())]),
        };

        assert_eq!(cache.get(&key).await, None);

        cache.insert(key.clone(), snapshot.clone()).await;

        assert_eq!(cache.get(&key).await, Some(snapshot));
    }

    #[test]
    fn remote_shell_probe_preserves_unknown_shell_name_as_posix_compatible() {
        let shell = parse_remote_exec_shell_probe_output("\n/usr/local/bin/xonsh\n")
            .expect("shell should parse");

        assert_eq!(shell.path, "/usr/local/bin/xonsh");
        assert_eq!(
            shell.kind,
            ExecCommandShellKind::Custom("xonsh".to_string())
        );

        let argv = exec_command_argv_for_shell(shell.path, shell.kind, "echo ok");

        assert_eq!(argv, vec!["/usr/local/bin/xonsh", "-lc", "echo ok"]);
    }

    #[test]
    fn remote_shell_probe_skips_non_posix_shells() {
        let shell =
            parse_remote_exec_shell_probe_output("\n/usr/bin/pwsh\n/usr/bin/cmd\n/bin/sh\n")
                .expect("shell should parse");

        assert_eq!(shell.path, "/bin/sh");
        assert_eq!(shell.kind, ExecCommandShellKind::Sh);
        assert!(parse_remote_exec_shell_probe_output("\n/usr/bin/pwsh\n/usr/bin/cmd\n").is_none());
    }

    #[test]
    fn exec_command_input_policy_applies_defaults_without_trimming_command() {
        let input = json!({
            "cmd": "  echo ok  ",
        });

        let parsed = exec_command_run_input_from_input(&input).expect("cmd should parse");

        assert_eq!(parsed.cmd, "  echo ok  ");
        assert!(!parsed.tty);
        assert_eq!(parsed.yield_time_ms, EXEC_COMMAND_DEFAULT_YIELD_TIME_MS);
        assert_eq!(exec_command_run_input_validation_message(&input), None);

        let blank = json!({
            "cmd": "   ",
        });
        assert_eq!(
            exec_command_run_input_validation_message(&blank),
            Some("cmd is required for ExecCommand")
        );
    }

    #[test]
    fn write_stdin_input_policy_applies_poll_defaults() {
        let input = json!({
            "session_id": 7,
        });

        let parsed = write_stdin_input_from_input(&input).expect("stdin input should parse");

        assert_eq!(parsed.session_id, 7);
        assert_eq!(parsed.chars, "");
        assert!(!parsed.append_enter);
        assert_eq!(parsed.yield_time_ms, EXEC_COMMAND_DEFAULT_YIELD_TIME_MS);
        assert_eq!(write_stdin_input_validation_message(&input), None);

        let out_of_range = json!({
            "session_id": i64::from(i32::MAX) + 1,
        });
        assert!(write_stdin_input_from_input(&out_of_range).is_none());
        assert_eq!(
            write_stdin_input_validation_message(&out_of_range),
            Some("session_id is required for WriteStdin")
        );
    }

    #[test]
    fn exec_control_input_policy_keeps_wait_optional() {
        let input = json!({
            "session_id": 8,
            "action": "interrupt",
        });

        let parsed =
            exec_command_control_tool_input_from_input(&input).expect("control input should parse");

        assert_eq!(parsed.session_id, 8);
        assert_eq!(parsed.action, ExecCommandControlAction::Interrupt);
        assert_eq!(parsed.yield_time_ms, None);

        let with_wait = json!({
            "session_id": 8,
            "action": "kill",
            "yield_time_ms": 12,
        });
        let parsed = exec_command_control_tool_input_from_input(&with_wait)
            .expect("control input should parse");

        assert_eq!(parsed.action, ExecCommandControlAction::Kill);
        assert_eq!(parsed.yield_time_ms, Some(12));

        let invalid_action = json!({
            "session_id": 8,
            "action": "pause",
        });
        assert_eq!(
            exec_command_control_tool_input_validation_message(&invalid_action),
            Some("action must be either 'interrupt' or 'kill'")
        );
    }

    #[test]
    fn exec_command_result_builder_exposes_only_model_result_fields() {
        let data = exec_command_result_value(ExecCommandResultData {
            fields: ExecCommandResultFields {
                chunk_id: "chunk-1".to_string(),
                wall_time_seconds: 1.25,
                output: "done".to_string(),
                session_id: Some(42),
                exit_code: None,
                original_output_chars: 4,
                completion: Some(ExecCommandCompletion {
                    status: ExecCommandCompletionStatus::Interrupted,
                    source: ExecCommandCompletionSource::OutOfBandControl,
                }),
                remote: false,
            },
            workdir: "D:\\repo".to_string(),
            tty: false,
            shell: ExecCommandShellMetadata {
                name: "PowerShell Core".to_string(),
                kind: "powershell_core".to_string(),
                path: "pwsh".to_string(),
                invocation: "`pwsh -Command <cmd>`".to_string(),
                pipeline_failure_policy: "last_command".to_string(),
                remote_env_snapshot_applied: None,
            },
        });

        assert_eq!(
            data,
            json!({
                "wall_time_seconds": 1.25,
                "output": "done",
                "session_id": 42,
                "exit_code": null,
                "completion": {
                    "status": "interrupted",
                    "source": "out_of_band_control"
                },
                "workdir": "D:\\repo",
                "tty": false,
                "shell": {
                    "name": "PowerShell Core",
                    "type": "powershell_core",
                    "path": "pwsh",
                    "invocation": "`pwsh -Command <cmd>`",
                    "pipeline_failure_policy": "last_command"
                }
            })
        );
    }

    #[test]
    fn write_stdin_and_control_result_builders_preserve_remote_shape() {
        let fields = ExecCommandResultFields {
            chunk_id: "chunk-2".to_string(),
            wall_time_seconds: 0.5,
            output: "".to_string(),
            session_id: None,
            exit_code: Some(0),
            original_output_chars: 0,
            completion: None,
            remote: true,
        };

        let stdin_data = write_stdin_result_value(fields.clone());
        let control_data = exec_control_result_value(fields, ExecCommandControlAction::Kill);

        assert_eq!(
            stdin_data.get("remote").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            control_data.get("action").and_then(Value::as_str),
            Some("kill")
        );
        assert!(stdin_data.get("chunk_id").is_none());
        assert!(stdin_data.get("original_output_chars").is_none());
        assert!(control_data.get("chunk_id").is_none());
        assert!(control_data.get("original_output_chars").is_none());
        assert!(control_data.get("completion").is_none());
    }

    #[test]
    fn lifecycle_status_has_provider_neutral_names_and_background_statuses() {
        assert_eq!(
            exec_command_lifecycle_status_name(ExecCommandLifecycleStatus::Interrupted),
            "interrupted"
        );
        assert_eq!(
            exec_command_lifecycle_background_output_status(ExecCommandLifecycleStatus::Running),
            BackgroundCommandOutputStatus::Running
        );
        assert_eq!(
            exec_command_lifecycle_background_output_status(ExecCommandLifecycleStatus::Killed),
            BackgroundCommandOutputStatus::Killed
        );
    }
}
