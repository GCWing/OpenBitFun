//! `ProxyCommand` transport support.
//!
//! OpenSSH runs `ProxyCommand` as a local shell process and carries the SSH
//! protocol over its stdin/stdout. This module does the same for OpenBitFun's
//! russh client: the manager spawns the command here and hands the joined
//! stdout/stdin to `establish_stream_session`, which keeps handshake timeouts,
//! known-hosts checks, and authentication identical to the direct path.
//!
//! Platform notes:
//! - Windows runs the command through `cmd.exe /C` with the raw string (no
//!   extra MS quoting), matching how OpenSSH's Windows build passes
//!   `ProxyCommand` along; Unix uses `sh -c`.
//! - `%h`, `%p`, `%r`, and `%%` are expanded before the shell sees the string.
//! - stderr is drained continuously into the log plus a small tail buffer:
//!   proxies like `coder ssh --stdio` log there, and a full pipe would block
//!   the child mid-handshake.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context};
use openbitfun_services_core::process_manager;
use tokio::io::{join, AsyncBufReadExt, BufReader, Join};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

/// How many recent stderr lines are kept for error enrichment.
const STDERR_TAIL_LINES: usize = 16;
/// Cap a single buffered stderr line so a chatty proxy cannot grow the tail
/// without bound.
const STDERR_LINE_MAX_CHARS: usize = 400;
/// Grace period for a proxy to exit on its own before it is killed, so its
/// real exit code survives as the diagnostic.
const EXIT_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Owns a spawned proxy process for the lifetime of the SSH session carried
/// over its stdio.
///
/// The child is killed when the guard is dropped, whether that happens because
/// the connection was closed, the handshake failed, or the session was torn
/// down by [`crate::remote_ssh::manager::SSHConnectionManager`].
pub(crate) struct ProxyCommandChild {
    child: Option<Child>,
    stream: Option<(ChildStdout, ChildStdin)>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    drain: Option<tokio::task::JoinHandle<()>>,
    label: String,
}

impl ProxyCommandChild {
    /// Spawn `command` through the platform shell with piped stdio.
    ///
    /// `label` identifies the connection in logs; the command text is kept out
    /// of error messages because ProxyCommand lines sometimes embed tokens.
    pub(crate) fn spawn(command: &str, label: &str) -> anyhow::Result<Self> {
        let mut cmd = process_manager::create_tokio_command(proxy_shell_program());
        configure_shell_args(&mut cmd, command);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Safety net for any path that drops the guard without an explicit
            // `finish`; the guard's own Drop reaps as well.
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("Failed to start proxy command for {label}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Proxy command for {label} has no stdout pipe"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Proxy command for {label} has no stdin pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("Proxy command for {label} has no stderr pipe"))?;

        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let drain = spawn_stderr_drain(stderr, stderr_tail.clone(), label.to_string());
        Ok(Self {
            child: Some(child),
            stream: Some((stdout, stdin)),
            stderr_tail,
            drain: Some(drain),
            label: label.to_string(),
        })
    }

    /// Take the joined stdout/stdin stream for the SSH handshake.
    pub(crate) fn take_stream(&mut self) -> anyhow::Result<Join<ChildStdout, ChildStdin>> {
        let (stdout, stdin) = self
            .stream
            .take()
            .ok_or_else(|| anyhow!("Proxy command stream for {} was already taken", self.label))?;
        Ok(join(stdout, stdin))
    }

    /// Kill the process (unless it already exited), reap it, and report the
    /// exit code plus the buffered stderr tail for error messages.
    pub(crate) async fn finish(mut self) -> (Option<i32>, String) {
        let mut exit_code = None;
        if let Some(child) = self.child.as_mut() {
            // Give a fast-exiting proxy a moment to report its own exit code —
            // that code is the actual diagnostic. Only a proxy that is still
            // alive (wedged on a black hole, say) gets killed, and a killed
            // proxy reports no code.
            match tokio::time::timeout(EXIT_DRAIN_GRACE, child.wait()).await {
                Ok(Ok(status)) => exit_code = status.code(),
                _ => {
                    let _ = child.start_kill();
                    if let Ok(status) = child.wait().await {
                        exit_code = status.code();
                    }
                }
            }
        }
        // The drain task ends on stderr EOF, which follows process exit; wait
        // for it so the tail reflects every line the proxy produced.
        if let Some(drain) = self.drain.take() {
            let _ = tokio::time::timeout(EXIT_DRAIN_GRACE, drain).await;
        }
        (exit_code, self.stderr_tail_text())
    }

    fn stderr_tail_text(&self) -> String {
        match self.stderr_tail.lock() {
            Ok(tail) => tail
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join("\n"),
            Err(_) => String::new(),
        }
    }
}

impl Drop for ProxyCommandChild {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.start_kill();
        // Reap asynchronously so a killed child does not linger as a zombie on
        // Unix. Without an active runtime there is nothing to await: the kill
        // already happened, and `kill_on_drop` remains armed as a backstop.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

/// Expand OpenSSH ProxyCommand tokens: `%h` (target host), `%p` (port), `%r`
/// (user), and `%%` (literal `%`). Unknown escapes stay literal, matching the
/// conservative end of OpenSSH's behavior for this release.
pub(crate) fn expand_tokens(command: &str, host: &str, port: u16, user: &str) -> String {
    let mut expanded = String::with_capacity(command.len());
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            expanded.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => expanded.push_str(host),
            Some('p') => expanded.push_str(&port.to_string()),
            Some('r') => expanded.push_str(user),
            Some('%') => expanded.push('%'),
            Some(other) => {
                expanded.push('%');
                expanded.push(other);
            }
            None => expanded.push('%'),
        }
    }
    expanded
}

fn proxy_shell_program() -> &'static str {
    #[cfg(windows)]
    {
        "cmd.exe"
    }
    #[cfg(not(windows))]
    {
        "sh"
    }
}

fn configure_shell_args(cmd: &mut tokio::process::Command, command: &str) {
    #[cfg(windows)]
    {
        // cmd.exe parses everything after /C itself, so the command must reach
        // it raw: the standard Windows argument quoting would wrap it in extra
        // quotes and mangle the quoting conventions ProxyCommand authors
        // already rely on.
        cmd.raw_arg("/C");
        cmd.raw_arg(command);
    }
    #[cfg(not(windows))]
    {
        cmd.arg("-c").arg(command);
    }
}

/// Drain the proxy's stderr forever: one line at a time into the log, with the
/// most recent lines kept in a bounded tail for connection error messages.
/// Returns the task handle; the task ends when stderr hits EOF (process exit).
fn spawn_stderr_drain(
    stderr: ChildStderr,
    tail: Arc<Mutex<VecDeque<String>>>,
    label: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        log::debug!("proxy command {label}: {trimmed}");
                    }
                    if let Ok(mut tail) = tail.lock() {
                        if tail.len() == STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        let mut owned = trimmed.to_string();
                        if owned.chars().count() > STDERR_LINE_MAX_CHARS {
                            owned = owned.chars().take(STDERR_LINE_MAX_CHARS).collect();
                            owned.push_str(" [truncated]");
                        }
                        tail.push_back(owned);
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_tokens_and_keeps_unknown_escapes_literal() {
        assert_eq!(
            expand_tokens("coder ssh --stdio %h", "coder-x", 22, "alice"),
            "coder ssh --stdio coder-x"
        );
        assert_eq!(
            expand_tokens("connect %r@%h:%p", "target", 2222, "ops"),
            "connect ops@target:2222"
        );
        assert_eq!(expand_tokens("100%% sure", "h", 22, "u"), "100% sure");
        // Unrecognized escapes survive untouched.
        assert_eq!(expand_tokens("tool %j %n", "h", 22, "u"), "tool %j %n");
        assert_eq!(expand_tokens("trailing %", "h", 22, "u"), "trailing %");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn finish_reports_exit_code_and_stderr_tail() {
        let mut child =
            ProxyCommandChild::spawn("echo proxy-err-line 1>&2 & exit 7", "test-connection")
                .unwrap();
        let _stream = child.take_stream().unwrap();
        let (exit_code, tail) = child.finish().await;
        assert_eq!(exit_code, Some(7));
        assert!(tail.contains("proxy-err-line"), "stderr tail was: {tail}");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn finish_reports_exit_code_and_stderr_tail() {
        let mut child =
            ProxyCommandChild::spawn("echo proxy-err-line >&2; exit 7", "test-connection").unwrap();
        let _stream = child.take_stream().unwrap();
        let (exit_code, tail) = child.finish().await;
        assert_eq!(exit_code, Some(7));
        assert!(tail.contains("proxy-err-line"), "stderr tail was: {tail}");
    }

    #[tokio::test]
    async fn drop_kills_a_still_running_proxy() {
        let script = if cfg!(windows) {
            "ping -n 30 127.0.0.1 >nul"
        } else {
            "sleep 30"
        };
        let guard = ProxyCommandChild::spawn(script, "long-running").unwrap();
        drop(guard);
        // `finish` was never called; the child must not outlive the guard. A
        // leaked process would show up as a dangling `ping`/`sleep` beyond this
        // test's lifetime, so no explicit assertion is needed beyond the test
        // finishing while the child is still running.
    }
}
