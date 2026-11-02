//! `ProxyCommand` transport support.
//!
//! OpenSSH runs `ProxyCommand` as a local shell process and carries the SSH
//! protocol over its stdin/stdout. This module does the same for OpenBitFun's
//! russh client: the manager spawns the command here and hands the joined
//! stdout/stdin to `establish_stream_session`, which keeps handshake timeouts,
//! known-hosts checks, and authentication identical to the direct path.
//!
//! Platform notes:
//! - Unix runs `sh -c "exec <command>"` exactly like OpenSSH, so the proxy
//!   replaces the shell. The process is supervised by
//!   [`ProcessTreeChild`]: it leads its own process group and the whole group
//!   (including any grandchildren the proxy forks) is killed on shutdown.
//! - Windows runs the command through `cmd.exe /C` with the raw string (no
//!   extra MS quoting), matching how OpenSSH's Windows build passes
//!   `ProxyCommand` along. [`ProcessTreeChild`] assigns it to a Job object with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so closing the Job ends the tree.
//! - `%h`, `%p`, `%r`, and `%%` are expanded before the shell sees the string.
//!   Hosts and users containing shell metacharacters are rejected first
//!   (OpenSSH 9.6, CVE-2023-51385).
//! - stderr is drained continuously into the log plus a small tail buffer:
//!   proxies like `coder ssh --stdio` log there, and a full pipe would block
//!   the child mid-handshake.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context};
use openbitfun_services_core::process_manager;
use openbitfun_services_core::process_tree::ProcessTreeChild;
use tokio::io::{join, AsyncBufReadExt, BufReader, Join};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};

/// How many recent stderr lines are kept for error enrichment.
const STDERR_TAIL_LINES: usize = 16;
/// Cap a single buffered stderr line so a chatty proxy cannot grow the tail
/// without bound.
const STDERR_LINE_MAX_CHARS: usize = 400;
/// Grace period for a proxy to exit on its own before it is killed, so its
/// real exit code survives as the diagnostic.
const EXIT_DRAIN_GRACE: Duration = Duration::from_secs(2);
/// SIGTERM-to-SIGKILL grace when tearing down a proxy process group.
const TERMINATE_GRACE: Duration = Duration::from_millis(500);

/// Owns a spawned proxy process tree for the lifetime of the SSH session
/// carried over its stdio.
///
/// The tree is killed when the guard is dropped, whether that happens because
/// the connection was closed, the handshake failed, or the session was torn
/// down by [`crate::remote_ssh::manager::SSHConnectionManager`].
pub(crate) struct ProxyCommandChild {
    tree: Option<ProcessTreeChild>,
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
    pub(crate) async fn spawn(command: &str, label: &str) -> anyhow::Result<Self> {
        let mut cmd = process_manager::create_tokio_command(proxy_shell_program());
        configure_shell_args(&mut cmd, command);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut tree = ProcessTreeChild::spawn(&mut cmd)
            .await
            .with_context(|| format!("Failed to start proxy command for {label}"))?;
        let stdout = tree
            .take_stdout()
            .ok_or_else(|| anyhow!("Proxy command for {label} has no stdout pipe"))?;
        let stdin = tree
            .take_stdin()
            .ok_or_else(|| anyhow!("Proxy command for {label} has no stdin pipe"))?;
        let stderr = tree
            .take_stderr()
            .ok_or_else(|| anyhow!("Proxy command for {label} has no stderr pipe"))?;

        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let drain = spawn_stderr_drain(stderr, stderr_tail.clone(), label.to_string());
        Ok(Self {
            tree: Some(tree),
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

    /// Whether the proxy's direct child has exited.
    pub(crate) fn has_exited(&mut self) -> bool {
        self.tree
            .as_mut()
            .is_none_or(|tree| matches!(tree.try_wait(), Ok(Some(_)) | Err(_)))
    }

    /// Give the proxy a short grace to exit on its own, then tear down the
    /// whole process tree, reap it, and report the exit code plus the
    /// buffered stderr tail for error messages.
    pub(crate) async fn finish(self) -> (Option<i32>, String) {
        self.finish_with_grace(EXIT_DRAIN_GRACE).await
    }

    /// Tear the process tree down immediately and reap it.
    pub(crate) async fn shutdown(self) {
        let _ = self.finish_with_grace(Duration::ZERO).await;
    }

    async fn finish_with_grace(mut self, grace: Duration) -> (Option<i32>, String) {
        let mut exit_code = None;
        if let Some(mut tree) = self.tree.take() {
            // A fast-exiting proxy reports its own exit code — that code is
            // the actual diagnostic. A proxy that is still alive (wedged on a
            // black hole, say) gets killed and reports no code.
            if !grace.is_zero() {
                if let Ok(Ok(status)) = tokio::time::timeout(grace, tree.wait()).await {
                    exit_code = status.code();
                }
            }
            // Always clean up the process group / Job: the shell may have
            // exited while a forked helper still holds the pipes.
            if let Err(error) = tree.terminate(TERMINATE_GRACE).await {
                log::debug!(
                    "Proxy command cleanup for {} reported: {}",
                    self.label,
                    error
                );
            }
            if exit_code.is_none() {
                if let Ok(Some(status)) = tree.try_wait() {
                    // A signal-killed proxy has no code; only a real exit does.
                    exit_code = status.code();
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
        let Some(mut tree) = self.tree.take() else {
            return;
        };
        // Reap asynchronously so a killed child does not linger as a zombie on
        // Unix. Without an active runtime `ProcessTreeChild`'s own Drop still
        // kills the process group / closes the Job immediately.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = tree.terminate(Duration::ZERO).await;
            });
        }
    }
}

/// Characters OpenSSH 9.6+ accepts in a host or user that is substituted into
/// a shell command (CVE-2023-51385); anything else could be interpreted by
/// the shell.
fn is_shell_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | ':' | '%' | '[' | ']')
        })
}

/// Expand OpenSSH ProxyCommand tokens: `%h` (target host), `%p` (port), `%r`
/// (user), and `%%` (literal `%`). Unknown escapes stay literal, matching the
/// conservative end of OpenSSH's behavior for this release.
///
/// A host or user that is about to be substituted must consist of
/// `[A-Za-z0-9._-@:%\[\]]` only; anything else is rejected before expansion
/// so a crafted host name cannot inject shell syntax.
pub(crate) fn expand_tokens(
    command: &str,
    host: &str,
    port: u16,
    user: &str,
) -> anyhow::Result<String> {
    let mut expanded = String::with_capacity(command.len());
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            expanded.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => {
                if !is_shell_safe_token(host) {
                    anyhow::bail!(
                        "Host name contains characters that are not allowed in a ProxyCommand (%h); \
                         use only letters, digits, and . _ - @ : % [ ]"
                    );
                }
                expanded.push_str(host);
            }
            Some('p') => expanded.push_str(&port.to_string()),
            Some('r') => {
                if !is_shell_safe_token(user) {
                    anyhow::bail!(
                        "User name contains characters that are not allowed in a ProxyCommand (%r); \
                         use only letters, digits, and . _ - @ : % [ ]"
                    );
                }
                expanded.push_str(user);
            }
            Some('%') => expanded.push('%'),
            Some(other) => {
                expanded.push('%');
                expanded.push(other);
            }
            None => expanded.push('%'),
        }
    }
    Ok(expanded)
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
        // Same as OpenSSH's `sshconnect.c`: `exec` makes the proxy replace the
        // shell, so signals and exit status belong to the proxy itself.
        cmd.arg("-c").arg(format!("exec {command}"));
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
            expand_tokens("coder ssh --stdio %h", "coder-x", 22, "alice").unwrap(),
            "coder ssh --stdio coder-x"
        );
        assert_eq!(
            expand_tokens("connect %r@%h:%p", "target", 2222, "ops").unwrap(),
            "connect ops@target:2222"
        );
        assert_eq!(
            expand_tokens("100%% sure", "h", 22, "u").unwrap(),
            "100% sure"
        );
        // Unrecognized escapes survive untouched.
        assert_eq!(
            expand_tokens("tool %j %n", "h", 22, "u").unwrap(),
            "tool %j %n"
        );
        assert_eq!(
            expand_tokens("trailing %", "h", 22, "u").unwrap(),
            "trailing %"
        );
        assert_eq!(
            expand_tokens("nc %h %p", "[fe80::1%en0]", 22, "u").unwrap(),
            "nc [fe80::1%en0] 22"
        );
    }

    #[test]
    fn rejects_shell_metacharacters_in_substituted_host_and_user() {
        for host in [
            "host;rm -rf ~",
            "$(id)",
            "`id`",
            "a b",
            "a|b",
            "a&b",
            "a'b",
            "a\"b",
            "a\\b",
            "a\nb",
            "",
        ] {
            assert!(
                expand_tokens("nc %h %p", host, 22, "u").is_err(),
                "host {host:?} must be rejected"
            );
        }
        assert!(expand_tokens("connect %r@%h", "ok", 22, "bad;user").is_err());
        // Unused tokens are not validated: nothing is substituted.
        assert_eq!(
            expand_tokens("coder ssh --stdio fixed", "bad;host", 22, "bad user").unwrap(),
            "coder ssh --stdio fixed"
        );
        assert_eq!(
            expand_tokens("nc %h", "user@host-1.example_x:22", 22, "u").unwrap(),
            "nc user@host-1.example_x:22"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn finish_reports_exit_code_and_stderr_tail() {
        let mut child =
            ProxyCommandChild::spawn("echo proxy-err-line 1>&2 & exit 7", "test-connection")
                .await
                .unwrap();
        let _stream = child.take_stream().unwrap();
        let (exit_code, tail) = child.finish().await;
        assert_eq!(exit_code, Some(7));
        assert!(tail.contains("proxy-err-line"), "stderr tail was: {tail}");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn finish_reports_exit_code_and_stderr_tail() {
        // `exec` applies to the first command, so wrap the compound script in
        // its own shell the way a real ProxyCommand would.
        let mut child =
            ProxyCommandChild::spawn("sh -c 'echo proxy-err-line >&2; exit 7'", "test-connection")
                .await
                .unwrap();
        let _stream = child.take_stream().unwrap();
        let (exit_code, tail) = child.finish().await;
        assert_eq!(exit_code, Some(7));
        assert!(tail.contains("proxy-err-line"), "stderr tail was: {tail}");
    }

    #[cfg(unix)]
    async fn wait_for_pids(child: &ProxyCommandChild, count: usize) -> Vec<u32> {
        for _ in 0..200 {
            let pids: Vec<u32> = child
                .stderr_tail_text()
                .lines()
                .filter_map(|line| line.trim().parse().ok())
                .collect();
            if pids.len() >= count {
                return pids;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("proxy did not report its pids");
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        // `kill -0` succeeds for a live process (or an unreaped zombie).
        process_manager::create_command("kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    async fn assert_pids_gone(pids: &[u32]) {
        for _ in 0..200 {
            if pids.iter().all(|pid| !pid_is_alive(*pid)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let alive: Vec<_> = pids.iter().filter(|pid| pid_is_alive(**pid)).collect();
        panic!("proxy processes still alive: {alive:?}");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn drop_kills_a_still_running_proxy_and_its_grandchildren() {
        // The proxy shell forks a long-lived grandchild and reports both pids.
        let guard = ProxyCommandChild::spawn(
            "sh -c 'sleep 300 & echo $! >&2; echo $$ >&2; wait'",
            "long-running",
        )
        .await
        .unwrap();
        let pids = wait_for_pids(&guard, 2).await;
        assert!(pids.iter().all(|pid| pid_is_alive(*pid)));
        drop(guard);
        assert_pids_gone(&pids).await;
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn shutdown_kills_a_grandchild_that_outlives_the_proxy_shell() {
        // The direct child exits immediately but leaves a helper holding the
        // pipes; the process-group cleanup must still reach it.
        let guard =
            ProxyCommandChild::spawn("sh -c 'sleep 300 & echo $! >&2; exit 0'", "orphaning")
                .await
                .unwrap();
        let pids = wait_for_pids(&guard, 1).await;
        guard.shutdown().await;
        assert_pids_gone(&pids).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn drop_kills_a_still_running_proxy() {
        let mut guard = ProxyCommandChild::spawn("ping -n 30 127.0.0.1 >nul", "long-running")
            .await
            .unwrap();
        assert!(!guard.has_exited());
        guard.shutdown().await;
    }
}
