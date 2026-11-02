//! Local operating-system action primitives.
//!
//! This module owns the concrete local OS command, clipboard, file/url open,
//! and script execution behavior used by product-level tools. Callers remain
//! responsible for product policy, user-facing envelopes, and tool routing.

use crate::process_manager;
use std::path::Path;

mod clipboard;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalSystemActionErrorKind {
    InvalidParams,
    NotAvailable,
    NotFound,
    Timeout,
    Internal,
    UnknownScriptType,
}

impl LocalSystemActionErrorKind {
    pub const fn stable_code(self) -> &'static str {
        match self {
            Self::InvalidParams => "INVALID_PARAMS",
            Self::NotAvailable => "NOT_AVAILABLE",
            Self::NotFound => "NOT_FOUND",
            Self::Timeout => "TIMEOUT",
            Self::Internal | Self::UnknownScriptType => "INTERNAL",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSystemActionError {
    kind: LocalSystemActionErrorKind,
    message: String,
    hints: Vec<String>,
}

impl LocalSystemActionError {
    pub fn kind(&self) -> LocalSystemActionErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub const fn stable_code(&self) -> &'static str {
        self.kind.stable_code()
    }

    pub fn hints(&self) -> &[String] {
        &self.hints
    }

    fn new(kind: LocalSystemActionErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            hints: Vec::new(),
        }
    }

    fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hints.push(hint.into());
        self
    }

    fn with_hints(mut self, hints: impl IntoIterator<Item = String>) -> Self {
        self.hints.extend(hints);
        self
    }
}

impl std::fmt::Display for LocalSystemActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LocalSystemActionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformOpenAppOutcome {
    pub via_command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOpenOutcome {
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunScriptRequest<'a> {
    pub script: &'a str,
    pub script_type: &'a str,
    pub timeout_ms: Option<u64>,
    pub max_output_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunScriptOutcome {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub script_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSystemInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub rust_target_family: &'static str,
    pub os_version: Option<String>,
    pub hostname: Option<String>,
    pub display_server: Option<String>,
    pub desktop_environment: Option<String>,
    pub script_types: Vec<&'static str>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LocalSystemProvider;

impl LocalSystemProvider {
    pub fn new() -> Self {
        Self
    }

    pub fn open_app_shell(
        &self,
        app_name: &str,
    ) -> Result<PlatformOpenAppOutcome, LocalSystemActionError> {
        let attempts = platform_open_attempts(app_name);
        let mut last_err: Option<String> = None;

        for (cmd, args) in &attempts {
            match process_manager::create_command(cmd).args(args).output() {
                Ok(out) if out.status.success() => {
                    return Ok(PlatformOpenAppOutcome {
                        via_command: cmd.clone(),
                    });
                }
                Ok(out) => {
                    last_err = Some(format!(
                        "{} exit={:?} stderr={}",
                        cmd,
                        out.status.code(),
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
                Err(e) => {
                    last_err = Some(format!("spawn {}: {}", cmd, e));
                }
            }
        }

        Err(LocalSystemActionError::new(
            LocalSystemActionErrorKind::Internal,
            format!(
                "open_app failed for '{}' across {} strategies: {}",
                app_name,
                attempts.len(),
                last_err.as_deref().unwrap_or("(no error)")
            ),
        ))
    }

    pub async fn run_script(
        &self,
        request: RunScriptRequest<'_>,
    ) -> Result<RunScriptOutcome, LocalSystemActionError> {
        let max_output_bytes = request
            .max_output_bytes
            .unwrap_or(16 * 1024)
            .clamp(1024, 256 * 1024) as usize;
        let timeout_ms = request.timeout_ms.filter(|timeout_ms| *timeout_ms > 0);
        let (program, args) = script_invocation(request.script_type, request.script)?;

        let started = std::time::Instant::now();
        let child = process_manager::create_tokio_command(&program)
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                LocalSystemActionError::new(
                    LocalSystemActionErrorKind::Internal,
                    format!(
                        "Failed to spawn run_script ({}): {}",
                        request.script_type, e
                    ),
                )
            })?;

        let wait = child.wait_with_output();
        let output = if let Some(timeout_ms) = timeout_ms {
            match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), wait).await {
                Err(_) => {
                    return Err(LocalSystemActionError::new(
                        LocalSystemActionErrorKind::Timeout,
                        format!(
                            "run_script timed out after {} ms (script_type={}); child process killed",
                            timeout_ms, request.script_type
                        ),
                    )
                    .with_hint(
                        "Increase 'timeout_ms', set it to 0, or omit it to wait without a timeout",
                    ));
                }
                Ok(Err(e)) => {
                    return Err(LocalSystemActionError::new(
                        LocalSystemActionErrorKind::Internal,
                        format!(
                            "Failed to wait for run_script ({}): {}",
                            request.script_type, e
                        ),
                    ));
                }
                Ok(Ok(o)) => o,
            }
        } else {
            wait.await.map_err(|e| {
                LocalSystemActionError::new(
                    LocalSystemActionErrorKind::Internal,
                    format!(
                        "Failed to wait for run_script ({}): {}",
                        request.script_type, e
                    ),
                )
            })?
        };

        let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let stdout_full = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr_full = String::from_utf8_lossy(&output.stderr).to_string();
        let (stdout, stdout_truncated) = truncate_with_marker(&stdout_full, max_output_bytes);
        let (stderr, stderr_truncated) = truncate_with_marker(&stderr_full, max_output_bytes);

        Ok(RunScriptOutcome {
            success: output.status.success(),
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            exit_code: output.status.code(),
            elapsed_ms,
            script_type: request.script_type.to_string(),
        })
    }

    pub fn system_info(&self) -> LocalSystemInfo {
        let mut script_types = vec!["shell"];
        if cfg!(target_os = "macos") {
            script_types.push("applescript");
        }
        if path_command_exists("bash") {
            script_types.push("bash");
        }
        if path_command_exists("pwsh") || path_command_exists("powershell") {
            script_types.push("powershell");
        }
        if cfg!(target_os = "windows") {
            script_types.push("cmd");
        }

        let (display_server, desktop_environment) = linux_session_info();

        LocalSystemInfo {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            rust_target_family: std::env::consts::FAMILY,
            os_version: read_os_version(),
            hostname: hostname().ok(),
            display_server,
            desktop_environment,
            script_types,
        }
    }

    pub async fn clipboard_read_text(&self) -> Result<String, LocalSystemActionError> {
        clipboard::read_text()
            .await
            .map_err(|error| error.with_hints(clipboard_install_hints()))
    }

    pub async fn clipboard_write_text(&self, text: &str) -> Result<(), LocalSystemActionError> {
        clipboard::write_text(text)
            .await
            .map_err(|error| error.with_hints(clipboard_install_hints()))
    }

    pub fn open_url(&self, url: &str) -> Result<LocalOpenOutcome, LocalSystemActionError> {
        if !(url.starts_with("http://")
            || url.starts_with("https://")
            || url.starts_with("file://")
            || url.starts_with("mailto:"))
        {
            return Err(LocalSystemActionError::new(
                LocalSystemActionErrorKind::InvalidParams,
                format!("Refusing to open URL with unsupported scheme: {}", url),
            )
            .with_hint(
                "Pass an http(s)://, file://, or mailto: URL. Use 'open_file' for local paths without a scheme.",
            ));
        }

        let (program, args) = open_url_command(url);
        let status = process_manager::create_command(&program)
            .args(&args)
            .status()
            .map_err(|e| {
                LocalSystemActionError::new(
                    LocalSystemActionErrorKind::Internal,
                    format!("Failed to spawn '{}': {}", program, e),
                )
            })?;
        if status.success() {
            Ok(LocalOpenOutcome { method: program })
        } else {
            Err(LocalSystemActionError::new(
                LocalSystemActionErrorKind::Internal,
                format!("'{}' exited with {:?}", program, status.code()),
            ))
        }
    }

    pub fn open_file(
        &self,
        path_str: &str,
        app_name: Option<&str>,
    ) -> Result<LocalOpenOutcome, LocalSystemActionError> {
        let path = Path::new(path_str);
        if !path.exists() {
            return Err(LocalSystemActionError::new(
                LocalSystemActionErrorKind::NotFound,
                format!("File does not exist: {}", path_str),
            )
            .with_hint("Check the absolute path; ~ is not expanded"));
        }

        let (program, args) = open_file_command(path_str, app_name);
        let status = process_manager::create_command(&program)
            .args(&args)
            .status()
            .map_err(|e| {
                LocalSystemActionError::new(
                    LocalSystemActionErrorKind::Internal,
                    format!("Failed to spawn '{}': {}", program, e),
                )
            })?;
        if status.success() {
            Ok(LocalOpenOutcome { method: program })
        } else {
            Err(LocalSystemActionError::new(
                LocalSystemActionErrorKind::Internal,
                format!("'{}' exited with {:?}", program, status.code()),
            ))
        }
    }
}

fn path_command_exists(name: &str) -> bool {
    let paths = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    let exts: Vec<String> = if cfg!(target_os = "windows") {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.BAT;.CMD;.COM".to_string())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&paths) {
        for ext in &exts {
            let mut candidate = dir.join(name);
            if !ext.is_empty() {
                let stem = candidate.file_name().map(|n| n.to_os_string());
                if let Some(mut stem) = stem {
                    stem.push(ext);
                    candidate.set_file_name(stem);
                }
            }
            if candidate.exists() {
                return true;
            }
        }
    }
    false
}

/// Truncate `s` to at most `max_bytes`, appending an explicit marker.
pub fn truncate_with_marker(s: &str, max_bytes: usize) -> (String, bool) {
    if s.len() <= max_bytes {
        return (s.to_string(), false);
    }
    let head_n = max_bytes.saturating_sub(64);
    let head = safe_str_slice(s, head_n);
    let omitted = s.len().saturating_sub(head_n);
    (
        format!("{}\n... [{} bytes omitted] ...\n", head, omitted),
        true,
    )
}

fn safe_str_slice(s: &str, n: usize) -> &str {
    if n >= s.len() {
        return s;
    }
    let mut cut = n;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}

fn platform_open_attempts(app_name: &str) -> Vec<(String, Vec<String>)> {
    let primary = platform_open_command(app_name);
    #[cfg(target_os = "linux")]
    {
        let mut attempts = vec![primary];
        let lower = app_name.to_lowercase();
        if attempts.iter().all(|(cmd, _)| cmd != &lower) {
            attempts.push((lower, vec![]));
        }
        attempts.push(("xdg-open".to_string(), vec![app_name.to_string()]));
        attempts
    }
    #[cfg(not(target_os = "linux"))]
    {
        vec![primary]
    }
}

fn platform_open_command(app_name: &str) -> (String, Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        (
            "open".to_string(),
            vec!["-a".to_string(), app_name.to_string()],
        )
    }
    #[cfg(target_os = "windows")]
    {
        (
            "cmd".to_string(),
            vec![
                "/C".to_string(),
                "start".to_string(),
                "".to_string(),
                app_name.to_string(),
            ],
        )
    }
    #[cfg(target_os = "linux")]
    {
        if path_command_exists("gtk-launch") {
            ("gtk-launch".to_string(), vec![app_name.to_string()])
        } else {
            (app_name.to_string(), vec![])
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        ("open".to_string(), vec![app_name.to_string()])
    }
}

fn open_url_command(url: &str) -> (String, Vec<String>) {
    match std::env::consts::OS {
        "macos" => ("open".to_string(), vec![url.to_string()]),
        "windows" => (
            "rundll32".to_string(),
            vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
        ),
        _ => ("xdg-open".to_string(), vec![url.to_string()]),
    }
}

fn open_file_command(path_str: &str, app_name: Option<&str>) -> (String, Vec<String>) {
    match (std::env::consts::OS, app_name) {
        ("macos", Some(app)) => (
            "open".to_string(),
            vec!["-a".to_string(), app.to_string(), path_str.to_string()],
        ),
        ("macos", None) => ("open".to_string(), vec![path_str.to_string()]),
        ("windows", _) => (
            "rundll32".to_string(),
            vec![
                "url.dll,FileProtocolHandler".to_string(),
                path_str.to_string(),
            ],
        ),
        _ => ("xdg-open".to_string(), vec![path_str.to_string()]),
    }
}

fn script_invocation(
    script_type: &str,
    script: &str,
) -> Result<(String, Vec<String>), LocalSystemActionError> {
    match script_type {
        "applescript" => {
            #[cfg(target_os = "macos")]
            {
                Ok((
                    "/usr/bin/osascript".to_string(),
                    vec!["-e".to_string(), script.to_string()],
                ))
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = script;
                Err(LocalSystemActionError::new(
                    LocalSystemActionErrorKind::NotAvailable,
                    "AppleScript is only available on macOS",
                )
                .with_hint(
                    "Use script_type='shell' (sh on Unix, PowerShell on Windows) or script_type='powershell'/'bash'",
                ))
            }
        }
        "shell" => {
            #[cfg(target_os = "windows")]
            {
                Ok(powershell_invocation(script))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(("sh".to_string(), vec!["-c".to_string(), script.to_string()]))
            }
        }
        "bash" => {
            if !path_command_exists("bash") {
                return Err(LocalSystemActionError::new(
                    LocalSystemActionErrorKind::NotAvailable,
                    "bash is not on PATH",
                )
                .with_hint(
                    "Install Git for Windows / WSL, or use script_type='shell' / 'powershell' / 'cmd'",
                ));
            }
            Ok(("bash".to_string(), vec!["-c".to_string(), script.to_string()]))
        }
        "powershell" => {
            let prog = if path_command_exists("pwsh") {
                "pwsh"
            } else if path_command_exists("powershell") {
                "powershell"
            } else {
                return Err(LocalSystemActionError::new(
                    LocalSystemActionErrorKind::NotAvailable,
                    "Neither pwsh nor powershell are on PATH",
                )
                .with_hint("Install PowerShell, or use script_type='shell' / 'bash'"));
            };
            Ok((
                prog.to_string(),
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!("[Console]::OutputEncoding=[Text.Encoding]::UTF8; {}", script),
                ],
            ))
        }
        "cmd" => {
            #[cfg(target_os = "windows")]
            {
                Ok((
                    "cmd".to_string(),
                    vec![
                        "/U".to_string(),
                        "/C".to_string(),
                        format!("chcp 65001>nul && {}", script),
                    ],
                ))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = script;
                Err(LocalSystemActionError::new(
                    LocalSystemActionErrorKind::NotAvailable,
                    "script_type='cmd' is only available on Windows",
                )
                .with_hint("Use script_type='shell' / 'bash' / 'powershell'"))
            }
        }
        other => Err(LocalSystemActionError::new(
            LocalSystemActionErrorKind::UnknownScriptType,
            format!(
                "Unknown script_type: '{}'. Valid: applescript (macOS), shell (OS default), bash, powershell, cmd (Windows)",
                other
            ),
        )),
    }
}

#[cfg(target_os = "windows")]
fn powershell_invocation(script: &str) -> (String, Vec<String>) {
    let prog = if path_command_exists("pwsh") {
        "pwsh"
    } else {
        "powershell"
    };
    (
        prog.to_string(),
        vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            format!(
                "[Console]::OutputEncoding=[Text.Encoding]::UTF8; {}",
                script
            ),
        ],
    )
}

fn clipboard_install_hints() -> Vec<String> {
    match std::env::consts::OS {
        "linux" => {
            #[cfg(target_os = "linux")]
            {
                let (server, _) = linux_session_info();
                match server.as_deref() {
                    Some("wayland") => vec![
                        "Wayland session detected - install wl-clipboard (e.g. `sudo apt install wl-clipboard` / `sudo dnf install wl-clipboard`)".to_string(),
                        "Run OpenBitFun inside the intended Wayland session; X11 fallback would address a different clipboard".to_string(),
                    ],
                    Some("x11") => vec![
                        "X11 session detected - install xclip (`sudo apt install xclip`) or xsel (`sudo apt install xsel`)".to_string(),
                    ],
                    _ => vec![
                        "Install wl-clipboard (Wayland) OR xclip/xsel (X11). Run `echo $XDG_SESSION_TYPE` to know which one applies.".to_string(),
                    ],
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                vec!["Install wl-clipboard (Wayland) or xclip/xsel (X11)".to_string()]
            }
        }
        _ => vec!["Make sure the system clipboard helper is available on this host".to_string()],
    }
}

fn linux_session_info() -> (Option<String>, Option<String>) {
    linux_session_info_impl()
}

#[cfg(target_os = "linux")]
fn linux_session_info_impl() -> (Option<String>, Option<String>) {
    let server = std::env::var("XDG_SESSION_TYPE")
        .ok()
        .filter(|s| !s.is_empty());
    let de = std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .or_else(|| std::env::var("DESKTOP_SESSION").ok())
        .filter(|s| !s.is_empty());
    (server, de)
}

#[cfg(not(target_os = "linux"))]
fn linux_session_info_impl() -> (Option<String>, Option<String>) {
    (None, None)
}

fn read_os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(format!("macOS {}", s))
        }
    }
    #[cfg(target_os = "windows")]
    {
        let out = process_manager::create_command("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
    #[cfg(target_os = "linux")]
    {
        let txt = std::fs::read_to_string("/etc/os-release").ok()?;
        for line in txt.lines() {
            if let Some(rest) = line.strip_prefix("PRETTY_NAME=") {
                return Some(rest.trim_matches('"').to_string());
            }
        }
        None
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

fn hostname() -> std::io::Result<String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            if !name.is_empty() {
                return Ok(name);
            }
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        if let Ok(name) = std::env::var("HOSTNAME") {
            if !name.is_empty() {
                return Ok(name);
            }
        }
        if let Ok(bytes) = std::fs::read("/etc/hostname") {
            let s = String::from_utf8_lossy(&bytes).trim().to_string();
            if !s.is_empty() {
                return Ok(s);
            }
        }
    }
    let out = process_manager::create_command("hostname").output()?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        clipboard_install_hints, path_command_exists, script_invocation, truncate_with_marker,
        LocalSystemActionError, LocalSystemActionErrorKind, LocalSystemProvider, RunScriptRequest,
    };

    #[test]
    fn path_command_exists_finds_shell_and_rejects_bogus_name() {
        #[cfg(unix)]
        assert!(
            path_command_exists("sh"),
            "sh must be on PATH on Unix hosts"
        );
        #[cfg(windows)]
        assert!(
            path_command_exists("cmd"),
            "cmd must be on PATH on Windows hosts"
        );
        assert!(!path_command_exists(
            "definitely-not-a-real-binary-openbitfun-xyz"
        ));
    }

    #[test]
    fn truncate_with_marker_preserves_utf8_boundaries() {
        let input = "alpha-中文-omega";
        let (truncated, was_truncated) = truncate_with_marker(input, 8);
        assert!(was_truncated);
        assert!(truncated.is_char_boundary(truncated.len()));
        assert!(truncated.contains("bytes omitted"));
    }

    #[test]
    fn clipboard_hints_are_never_empty() {
        assert!(!clipboard_install_hints().is_empty());
    }

    #[test]
    fn local_system_error_kind_exposes_stable_tool_codes() {
        let cases = [
            (LocalSystemActionErrorKind::InvalidParams, "INVALID_PARAMS"),
            (LocalSystemActionErrorKind::NotAvailable, "NOT_AVAILABLE"),
            (LocalSystemActionErrorKind::NotFound, "NOT_FOUND"),
            (LocalSystemActionErrorKind::Timeout, "TIMEOUT"),
            (LocalSystemActionErrorKind::Internal, "INTERNAL"),
            (LocalSystemActionErrorKind::UnknownScriptType, "INTERNAL"),
        ];

        for (kind, expected_code) in cases {
            assert_eq!(kind.stable_code(), expected_code);
            assert_eq!(
                LocalSystemActionError::new(kind, "test").stable_code(),
                expected_code
            );
        }
    }

    #[test]
    fn unsupported_url_scheme_is_rejected_before_spawn() {
        let err = LocalSystemProvider::new()
            .open_url("javascript:alert(1)")
            .expect_err("unsupported URL scheme must be rejected");
        assert_eq!(err.kind(), LocalSystemActionErrorKind::InvalidParams);
        assert!(!err.hints().is_empty());
    }

    #[test]
    fn missing_file_reports_not_found_before_spawn() {
        let err = LocalSystemProvider::new()
            .open_file(
                "__openbitfun_missing_file_for_local_system_provider_test__",
                None,
            )
            .expect_err("missing file must be rejected before spawning an opener");
        assert_eq!(err.kind(), LocalSystemActionErrorKind::NotFound);
        assert!(!err.hints().is_empty());
    }

    #[test]
    fn unknown_script_type_lists_valid_options() {
        let err = script_invocation("ruby", "puts 'hi'")
            .expect_err("unknown script type should not spawn anything");
        assert_eq!(err.kind(), LocalSystemActionErrorKind::UnknownScriptType);
        for must_have in ["applescript", "shell", "powershell", "cmd"] {
            assert!(err.message().contains(must_have));
        }
    }

    #[tokio::test]
    async fn shell_script_executes_and_captures_stdout() {
        let script = if cfg!(target_os = "windows") {
            "Write-Output 'hello-openbitfun'"
        } else {
            "echo hello-openbitfun"
        };
        let outcome = LocalSystemProvider::new()
            .run_script(RunScriptRequest {
                script,
                script_type: "shell",
                timeout_ms: Some(10_000),
                max_output_bytes: Some(16 * 1024),
            })
            .await
            .expect("shell run_script should succeed");
        assert!(
            outcome.success,
            "shell run_script stderr={}",
            outcome.stderr
        );
        assert!(outcome.stdout.contains("hello-openbitfun"));
    }

    #[tokio::test]
    async fn zero_timeout_means_wait_without_timeout() {
        let script = if cfg!(target_os = "windows") {
            "Write-Output 'zero-timeout-openbitfun'"
        } else {
            "echo zero-timeout-openbitfun"
        };
        let outcome = LocalSystemProvider::new()
            .run_script(RunScriptRequest {
                script,
                script_type: "shell",
                timeout_ms: Some(0),
                max_output_bytes: Some(16 * 1024),
            })
            .await
            .expect("timeout_ms=0 should wait without timeout");
        assert!(outcome.success);
        assert!(outcome.stdout.contains("zero-timeout-openbitfun"));
    }
}
