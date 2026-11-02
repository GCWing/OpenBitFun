//! Native WSL transport. Linux paths and commands are interpreted in the named
//! distribution; the Windows host is only responsible for launching wsl.exe.

use super::transport::WorkspaceReader;
use super::types::{ServerInfo, WslDistributions, WslWorkspaceConfig};
use anyhow::{anyhow, Context};
use openbitfun_services_core::process_manager;
use std::pin::Pin;
use std::process::{Output, Stdio};
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, ReadBuf};

pub(crate) const EXECUTABLE: &str = "wsl.exe";

pub(crate) fn validate(config: &WslWorkspaceConfig) -> anyhow::Result<()> {
    if config.distribution.trim().is_empty()
        || config.distribution.contains(['\0', '\r', '\n'])
        || config
            .user
            .as_deref()
            .is_some_and(|user| user.contains(['\0', '\r', '\n']))
    {
        anyhow::bail!("WSL requires a valid distribution name and Linux user");
    }
    Ok(())
}

pub(crate) fn ensure_supported() -> anyhow::Result<()> {
    if !cfg!(windows) {
        anyhow::bail!("Native WSL workspaces require a Windows OpenBitFun host");
    }
    Ok(())
}

pub(crate) fn validate_cwd(cwd: Option<&str>) -> anyhow::Result<()> {
    if let Some(cwd) = cwd {
        if cwd != "~" && !cwd.starts_with('/') || cwd.contains('\0') {
            anyhow::bail!(
                "WSL workspace directories must be absolute POSIX paths inside the distribution"
            );
        }
    }
    Ok(())
}

pub(crate) fn shell_args(config: &WslWorkspaceConfig, cwd: Option<&str>) -> Vec<String> {
    let mut args = vec!["--distribution".into(), config.distribution.clone()];
    if let Some(user) = config
        .user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.extend(["--user".into(), user.into()]);
    }
    // Never inherit a Windows cwd (including controller paths) in Linux.
    args.extend(["--cd".into(), cwd.unwrap_or("~").into()]);
    args
}

pub(crate) fn exec_args(config: &WslWorkspaceConfig, command: &str) -> Vec<String> {
    let mut args = shell_args(config, None);
    args.extend([
        "--exec".into(),
        "/bin/sh".into(),
        "-lc".into(),
        command.into(),
    ]);
    args
}

async fn output(args: &[String], timeout: Duration) -> anyhow::Result<Output> {
    ensure_supported()?;
    tokio::time::timeout(
        timeout,
        process_manager::create_tokio_command(EXECUTABLE)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("WSL command timed out"))?
    .context("Failed to start wsl.exe; install WSL and a Linux distribution on the Windows host")
}

// WSL's Windows-side listing/errors can be UTF-16LE. Linux process stdout
// remains binary and must never pass through this decoder.
fn decode_cli_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().skip(1).step_by(2).any(|b| *b == 0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

fn distribution_names(bytes: &[u8]) -> Vec<String> {
    decode_cli_output(bytes)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Prefixes `wsl.exe` uses for messages about the Windows host itself.
const HOST_DIAGNOSTIC_PREFIXES: [&str; 2] = ["wsl:", "wsl.exe:"];

fn is_host_diagnostic(line: &str) -> bool {
    let line = line.trim_start();
    HOST_DIAGNOSTIC_PREFIXES.iter().any(|prefix| {
        line.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    })
}

#[derive(Debug, Default)]
pub(super) struct StderrDiagnostics {
    pub(super) workspace: String,
    host: String,
}

impl StderrDiagnostics {
    /// Prefer the Linux command's error, but retain host launch failures when
    /// there is no Linux diagnostic. Host messages are not always warnings.
    pub(super) fn failure_detail(&self) -> &str {
        if !self.workspace.is_empty() {
            &self.workspace
        } else if !self.host.is_empty() {
            &self.host
        } else {
            "no stderr output"
        }
    }
}

/// Separate Linux stderr from the Windows-host messages interleaved by WSL.
/// UTF-16LE lines must consume the entire two-byte LF code unit, otherwise the
/// next line is misaligned. Searching by code unit also avoids splitting a
/// character such as U+4E0A at its low byte. Linux stderr remains UTF-8.
pub(super) fn stderr_diagnostics(mut bytes: &[u8]) -> StderrDiagnostics {
    let mut diagnostics = StderrDiagnostics::default();
    while !bytes.is_empty() {
        let prefix = bytes.split(|byte| *byte == b'\n').next().unwrap_or(bytes);
        let utf16 = prefix.starts_with(&[0xff, 0xfe])
            || prefix.iter().skip(1).step_by(2).any(|byte| *byte == 0);
        let newline = if utf16 {
            bytes
                .chunks_exact(2)
                .position(|pair| pair == [b'\n', 0])
                .map(|index| (index * 2, 2))
        } else {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| (index, 1))
        };
        let (end, delimiter_len) = newline.unwrap_or((bytes.len(), 0));
        let line = decode_cli_output(&bytes[..end]);
        bytes = &bytes[end + delimiter_len..];
        let line = line.trim_matches(|character| matches!(character, '\0' | '\r' | '\u{feff}'));
        if line.trim().is_empty() {
            continue;
        }
        let target = if utf16 || is_host_diagnostic(line) {
            &mut diagnostics.host
        } else {
            &mut diagnostics.workspace
        };
        if !target.is_empty() {
            target.push('\n');
        }
        target.push_str(line);
    }
    diagnostics
}

/// Streaming counterpart of [`stderr_diagnostics`] for the workspace stdio path.
///
/// A stdio transport hands stderr to the consumer while the command runs, so
/// host messages have to be dropped as the stream flows instead of after the
/// process exits. Lines are classified with the same rules as the buffered
/// path: UTF-16LE lines and `wsl:` / `wsl.exe:` lines describe the Windows
/// host, everything else is Linux stderr and is forwarded as UTF-8.
pub(super) fn streamed_stderr(reader: WorkspaceReader) -> WorkspaceReader {
    Box::pin(StreamedStderr {
        inner: reader,
        pending: Vec::new(),
        ready: Vec::new(),
        ready_at: 0,
        eof: false,
    })
}

/// Longest single stderr line buffered before it is forwarded as it stands.
///
/// `wsl.exe` host messages are short; the cap only keeps a command that never
/// writes a newline from buffering without bound.
const MAX_PENDING_STDERR_LINE: usize = 64 * 1024;

struct StreamedStderr {
    inner: WorkspaceReader,
    /// Bytes of the line currently being assembled.
    pending: Vec<u8>,
    /// Decoded Linux diagnostics waiting for the consumer.
    ready: Vec<u8>,
    ready_at: usize,
    eof: bool,
}

impl StreamedStderr {
    /// Split one buffered line off `pending`.
    ///
    /// Returns `None` while the current line is incomplete, except at the end
    /// of the stream, where the last line arrives without a delimiter. Mirrors
    /// [`stderr_diagnostics`], including consuming the whole two-byte LF code
    /// unit of UTF-16LE so the next line stays aligned.
    fn take_line(&mut self, end_of_stream: bool) -> Option<StreamedLine> {
        if self.pending.is_empty() {
            return None;
        }
        let prefix = self
            .pending
            .split(|byte| *byte == b'\n')
            .next()
            .unwrap_or(&self.pending);
        let utf16 = prefix.starts_with(&[0xff, 0xfe])
            || prefix.iter().skip(1).step_by(2).any(|byte| *byte == 0);
        let delimiter = if utf16 {
            self.pending
                .chunks_exact(2)
                .position(|pair| pair == [b'\n', 0])
                .map(|index| (index * 2, 2))
        } else {
            self.pending
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| (index, 1))
        };
        let (end, delimiter_len) = match delimiter {
            Some(delimiter) => delimiter,
            None if end_of_stream => (self.pending.len(), 0),
            None => return None,
        };
        let bytes = self.pending[..end].to_vec();
        self.pending.drain(..end + delimiter_len);
        Some(StreamedLine {
            bytes,
            utf16,
            terminated: delimiter_len > 0,
        })
    }

    /// Forward an over-long unterminated line instead of buffering forever.
    fn flush_oversized_line(&mut self) {
        if self.pending.len() <= MAX_PENDING_STDERR_LINE {
            return;
        }
        let bytes = std::mem::take(&mut self.pending);
        let utf16 = bytes.starts_with(&[0xff, 0xfe])
            || bytes.iter().skip(1).step_by(2).any(|byte| *byte == 0);
        self.queue(&StreamedLine {
            bytes,
            utf16,
            terminated: false,
        });
    }

    /// Queue one line when it belongs to the Linux side.
    ///
    /// The line keeps its own terminator: the last diagnostic of a command that
    /// wrote no trailing newline must not gain one.
    fn queue(&mut self, line: &StreamedLine) {
        if line.utf16 {
            return;
        }
        let decoded = decode_cli_output(&line.bytes);
        let text = decoded.trim_matches(|character| matches!(character, '\0' | '\r' | '\u{feff}'));
        if text.trim().is_empty() || is_host_diagnostic(text) {
            return;
        }
        self.ready.extend_from_slice(text.as_bytes());
        if line.terminated {
            self.ready.push(b'\n');
        }
    }
}

/// One line split out of the streamed `wsl.exe` stderr.
struct StreamedLine {
    bytes: Vec<u8>,
    utf16: bool,
    terminated: bool,
}

impl AsyncRead for StreamedStderr {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        loop {
            if this.ready_at < this.ready.len() {
                let take = (this.ready.len() - this.ready_at).min(buf.remaining());
                if take == 0 {
                    return Poll::Ready(Ok(()));
                }
                buf.put_slice(&this.ready[this.ready_at..this.ready_at + take]);
                this.ready_at += take;
                if this.ready_at == this.ready.len() {
                    this.ready.clear();
                    this.ready_at = 0;
                }
                return Poll::Ready(Ok(()));
            }
            let end_of_stream = this.eof;
            if let Some(line) = this.take_line(end_of_stream) {
                this.queue(&line);
                continue;
            }
            if end_of_stream {
                return Poll::Ready(Ok(()));
            }
            let mut chunk = [0u8; 4096];
            let mut chunk_buf = ReadBuf::new(&mut chunk);
            match this.inner.as_mut().poll_read(cx, &mut chunk_buf) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Ready(Ok(())) => {
                    if chunk_buf.filled().is_empty() {
                        this.eof = true;
                    } else {
                        this.pending.extend_from_slice(chunk_buf.filled());
                        this.flush_oversized_line();
                    }
                }
            }
        }
    }
}

fn check_output(output: &Output) -> anyhow::Result<()> {
    if !output.status.success() {
        let mut detail = decode_cli_output(&output.stderr);
        if detail.trim().is_empty() {
            detail = decode_cli_output(&output.stdout);
        }
        anyhow::bail!("WSL command failed ({}): {}", output.status, detail.trim());
    }
    Ok(())
}

pub async fn list_distributions() -> anyhow::Result<WslDistributions> {
    if !cfg!(windows) {
        return Ok(WslDistributions {
            supported: false,
            distributions: Vec::new(),
        });
    }
    let result = output(
        &["--list".into(), "--quiet".into()],
        Duration::from_secs(15),
    )
    .await?;
    check_output(&result)?;
    Ok(WslDistributions {
        supported: true,
        distributions: distribution_names(&result.stdout),
    })
}

pub(crate) async fn is_running(config: &WslWorkspaceConfig) -> bool {
    let Ok(result) = output(
        &["--list".into(), "--running".into(), "--quiet".into()],
        Duration::from_secs(3),
    )
    .await
    else {
        return false;
    };
    result.status.success() && distribution_names(&result.stdout).contains(&config.distribution)
}

pub(crate) async fn probe(
    config: &WslWorkspaceConfig,
    timeout: Duration,
) -> anyhow::Result<ServerInfo> {
    validate(config)?;
    let result = output(
        &exec_args(config, "uname -s && hostname && printf '%s\\n' \"$HOME\""),
        timeout,
    )
    .await?;
    check_output(&result)?;
    let text = String::from_utf8(result.stdout)
        .context("WSL returned invalid UTF-8 system information")?;
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 3 || lines[0] != "Linux" || lines[1].is_empty() || !lines[2].starts_with('/')
    {
        anyhow::bail!(
            "WSL distribution '{}' did not return valid Linux system information",
            config.distribution
        );
    }
    Ok(ServerInfo {
        os_type: lines[0].into(),
        hostname: lines[1].into(),
        home_dir: lines[2].into(),
    })
}

pub(crate) async fn signal(config: &WslWorkspaceConfig, command: &str) -> anyhow::Result<()> {
    let result = output(&exec_args(config, command), Duration::from_secs(3)).await?;
    check_output(&result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_cli_decodes_utf16_and_utf8_distribution_lists() {
        let names = "Ubuntu-24.04\r\n自定义 Linux\r\n";
        let utf16: Vec<_> = names.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(
            distribution_names(&utf16),
            vec!["Ubuntu-24.04", "自定义 Linux"]
        );
        assert_eq!(
            distribution_names(names.as_bytes()),
            distribution_names(&utf16)
        );
        assert_eq!(
            distribution_names(&[&[0xff, 0xfe][..], &utf16].concat()),
            distribution_names(&utf16)
        );
    }

    /// `wsl.exe` reports host conditions on the same stderr stream as the Linux
    /// command, in UTF-16LE, so the two encodings have to be told apart per line.
    #[test]
    fn wsl_stderr_diagnostics_drop_host_messages_and_keep_linux_output() {
        let mut mixed: Vec<u8> =
            "wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
        mixed.extend_from_slice(b"ls: cannot access '/home/x': No such file or directory\n");

        assert_eq!(
            stderr_diagnostics(&mixed).workspace,
            "ls: cannot access '/home/x': No such file or directory"
        );
        assert_eq!(stderr_diagnostics(&[]).workspace, "");
        assert_eq!(
            stderr_diagnostics(b"wsl.exe: WSL2 is not installed\n").failure_detail(),
            "wsl.exe: WSL2 is not installed"
        );
    }

    #[test]
    fn wsl_stderr_preserves_utf16_line_boundaries_and_linux_unicode() {
        for host in [
            "wsl: first warning\r\nwsl: second warning\r\n",
            "wsl: 上次启动警告\r\n",
            "wsl: warning\r\n    additional host detail\r\n",
        ] {
            for bom in [false, true] {
                let mut stderr = if bom { vec![0xff, 0xfe] } else { Vec::new() };
                stderr.extend(host.encode_utf16().flat_map(u16::to_le_bytes));
                stderr.extend_from_slice("cat: /workspace/文件: Permission denied\n".as_bytes());
                stderr.extend(
                    "wsl.exe: final warning\r\n"
                        .encode_utf16()
                        .flat_map(u16::to_le_bytes),
                );
                stderr.extend_from_slice(b"second Linux diagnostic");
                let diagnostics = stderr_diagnostics(&stderr);
                assert_eq!(
                    diagnostics.workspace,
                    "cat: /workspace/文件: Permission denied\nsecond Linux diagnostic"
                );
                assert!(diagnostics.host.contains("final warning"));
                assert!(!diagnostics.workspace.contains('\0'));
            }
        }
    }

    #[test]
    fn wsl_stderr_keeps_host_errors_without_a_trailing_newline() {
        let stderr = "wsl: Failed to start distribution"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let diagnostics = stderr_diagnostics(&stderr);
        assert!(diagnostics.workspace.is_empty());
        assert_eq!(
            diagnostics.failure_detail(),
            "wsl: Failed to start distribution"
        );
        assert_eq!(
            stderr_diagnostics(b"\r\n").failure_detail(),
            "no stderr output"
        );
    }

    /// A stdio transport hands stderr to the consumer while the command runs, so
    /// host messages have to be dropped during the stream instead of after it.
    /// Writing one byte at a time keeps line boundaries, the two-byte UTF-16LE
    /// LF, and the final unterminated line on read boundaries.
    #[tokio::test]
    async fn wsl_streamed_stderr_forwards_linux_diagnostics_only() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut stream: Vec<u8> = "wsl: 检测到 localhost 代理配置，但未镜像到 WSL。\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        stream.extend_from_slice("cat: /workspace/文件: Permission denied\n".as_bytes());
        stream.extend_from_slice("wsl: 上次启动警告\r\n".as_bytes());
        stream.extend_from_slice(b"second Linux diagnostic");

        let (mut writer, reader) = tokio::io::duplex(8);
        let write = tokio::spawn(async move {
            for byte in stream {
                writer.write_all(&[byte]).await.unwrap();
            }
            writer.shutdown().await.unwrap();
        });
        let reader: WorkspaceReader = Box::pin(reader);
        let mut output = String::new();
        streamed_stderr(reader)
            .read_to_string(&mut output)
            .await
            .unwrap();
        write.await.unwrap();
        assert_eq!(
            output,
            "cat: /workspace/文件: Permission denied\nsecond Linux diagnostic"
        );
    }

    /// A command that never writes a newline must not buffer without bound, and
    /// its diagnostics must still arrive whole.
    #[tokio::test]
    async fn wsl_streamed_stderr_forwards_overlong_lines() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let payload = vec![b'x'; MAX_PENDING_STDERR_LINE + 1024];
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let write = tokio::spawn({
            let payload = payload.clone();
            async move {
                writer.write_all(&payload).await.unwrap();
                writer.shutdown().await.unwrap();
            }
        });
        let reader: WorkspaceReader = Box::pin(reader);
        let mut output = String::new();
        streamed_stderr(reader)
            .read_to_string(&mut output)
            .await
            .unwrap();
        write.await.unwrap();
        assert_eq!(output.len(), payload.len());
        assert!(output.bytes().all(|byte| byte == b'x'));
    }

    #[test]
    fn wsl_args_preserve_target_user_paths_and_command_as_separate_arguments() {
        let config = WslWorkspaceConfig {
            distribution: "My Linux".into(),
            user: Some("dev".into()),
        };
        let command = "printf '%s' \"a b; $(whoami)\"";
        assert_eq!(
            exec_args(&config, command),
            vec![
                "--distribution",
                "My Linux",
                "--user",
                "dev",
                "--cd",
                "~",
                "--exec",
                "/bin/sh",
                "-lc",
                command
            ]
        );
        assert_eq!(
            shell_args(&config, Some("/home/dev/a b")),
            vec![
                "--distribution",
                "My Linux",
                "--user",
                "dev",
                "--cd",
                "/home/dev/a b"
            ]
        );
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn wsl_non_windows_host_refuses_without_spawning_a_process() {
        assert!(!list_distributions().await.unwrap().supported);
        let config = WslWorkspaceConfig {
            distribution: "Ubuntu".into(),
            user: None,
        };
        assert!(probe(&config, Duration::from_secs(1))
            .await
            .unwrap_err()
            .to_string()
            .contains("Windows OpenBitFun host"));
    }
    #[test]
    fn wsl_rejects_windows_and_relative_workspace_paths() {
        assert!(validate_cwd(Some(r"C:\Users\dev\project")).is_err());
        assert!(validate_cwd(Some("relative/project")).is_err());
        assert!(validate_cwd(Some("/home/dev/project")).is_ok());
        assert!(validate_cwd(Some("~")).is_ok());
        assert!(validate_cwd(None).is_ok());
    }

    fn workspace_config() -> super::super::SSHConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "wsl-test", "name": "WSL test", "host": "wsl.invalid", "port": 0,
            "username": "", "auth": { "type": "PrivateKey", "keyPath": "" },
            "wsl": { "distribution": "Ubuntu" }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn wsl_saved_profiles_survive_reload_without_credentials() {
        let root = tempfile::tempdir().unwrap();
        let manager = super::super::SSHConnectionManager::new(root.path().into());
        let mut config = workspace_config();
        manager.save_connection(&config).await.unwrap();
        config.id = "wsl-debian".into();
        config.wsl.as_mut().unwrap().distribution = "Debian".into();
        manager.save_connection(&config).await.unwrap();
        let restored = super::super::SSHConnectionManager::new(root.path().into());
        restored.load_saved_connections().await.unwrap();
        let saved = restored.get_saved_connections().await;
        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].wsl.as_ref().unwrap().distribution, "Ubuntu");
        assert_eq!(saved[1].wsl.as_ref().unwrap().distribution, "Debian");
        assert!(restored
            .load_stored_password("wsl-test")
            .await
            .unwrap()
            .is_none());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn wsl_connection_report_identifies_unsupported_target_and_keeps_profile() {
        let root = tempfile::tempdir().unwrap();
        let manager = super::super::SSHConnectionManager::new(root.path().into());
        let config = workspace_config();
        manager.save_connection(&config).await.unwrap();
        let report = manager.test_connection(&config).await;
        assert!(!report.success);
        assert_eq!(report.stages.len(), 1);
        assert_eq!(report.stages[0].id, "wsl");
        assert!(report.stages[0]
            .error
            .as_ref()
            .unwrap()
            .contains("Windows OpenBitFun host"));
        assert_eq!(manager.get_saved_connections().await.len(), 1);
        assert!(!manager.is_connected(&config.id).await);
        // Terminal transport selection must restore the saved target before
        // deciding between local WSL and SSH, including after a host restart.
        let error = manager
            .local_process_exec_spec(&config.id, "pwd", true)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Windows OpenBitFun host"));
    }

    /// Opt-in real Windows/WSL transport check. Set OPENBITFUN_TEST_WSL_DISTRO
    /// to an initialized distribution and run this test with --ignored.
    #[tokio::test]
    #[ignore = "requires Windows and an initialized WSL distribution"]
    async fn wsl_windows_workspace_transport() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        ensure_supported().unwrap();
        let distribution =
            std::env::var("OPENBITFUN_TEST_WSL_DISTRO").expect("Set OPENBITFUN_TEST_WSL_DISTRO");
        let root = tempfile::tempdir().unwrap();
        let manager = super::super::SSHConnectionManager::new(root.path().into());
        let mut config = workspace_config();
        config.wsl.as_mut().unwrap().distribution = distribution;
        let result = manager.connect(config.clone()).await.unwrap();
        assert!(result.success);
        assert_eq!(result.server_info.unwrap().os_type, "Linux");
        manager.save_connection(&config).await.unwrap();
        // The host interleaves its own wsl.exe messages into the command stderr
        // stream (the NAT localhost-proxy warning, for one). Listing and
        // existence probes must still read the Linux side correctly, including
        // the `/home` directory the workspace picker opens first.
        manager
            .container_read_dir(&config.id, "/home")
            .await
            .unwrap();
        let remote_dir = format!("/tmp/openbitfun-wsl-dir-{}", uuid::Uuid::new_v4());
        manager
            .container_mkdir(&config.id, &remote_dir, false)
            .await
            .unwrap();
        assert!(manager
            .container_read_dir(&config.id, &remote_dir)
            .await
            .unwrap()
            .is_empty());
        assert!(manager
            .container_exists(&config.id, &remote_dir)
            .await
            .unwrap());
        assert!(!manager
            .container_exists(&config.id, &format!("{remote_dir}/missing"))
            .await
            .unwrap());
        manager
            .execute_command(&config.id, &format!("rmdir -- '{}'", remote_dir))
            .await
            .unwrap();
        let remote_path = format!("/tmp/openbitfun-wsl-{}", uuid::Uuid::new_v4());
        let bytes = b"binary\0payload\n\xff\xfe";
        manager
            .container_write_file(&config.id, &remote_path, bytes)
            .await
            .unwrap();
        let read_result = manager.container_read_file(&config.id, &remote_path).await;
        manager
            .execute_command(&config.id, &format!("rm -- '{}'", remote_path))
            .await
            .unwrap();
        assert_eq!(read_result.unwrap(), bytes);
        let transport = manager
            .open_workspace_stdio(&config.id, "cat; printf diagnostic >&2; exit 7")
            .await
            .unwrap();
        let (mut stdin, mut stdout, mut stderr, _, completion) = transport.into_parts();
        stdin.write_all(bytes).await.unwrap();
        stdin.shutdown().await.unwrap();
        let mut read = Vec::new();
        stdout.read_to_end(&mut read).await.unwrap();
        let mut diagnostic = String::new();
        stderr.read_to_string(&mut diagnostic).await.unwrap();
        assert_eq!(read, bytes);
        assert_eq!(diagnostic, "diagnostic");
        assert_eq!(completion.wait().await.exit_code, Some(7));
        let transport = manager
            .open_workspace_stdio(&config.id, "sleep 60")
            .await
            .unwrap();
        let (_stdin, _stdout, _stderr, control, completion) = transport.into_parts();
        control.kill().await.unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(5), completion.wait())
            .await
            .unwrap();
        assert_ne!(exit.exit_code, Some(0));
        manager.disconnect(&config.id).await.unwrap();
        manager.ensure_connected(&config.id).await.unwrap();
        assert!(manager.is_shell_workspace(&config.id).await);
        manager.disconnect(&config.id).await.unwrap();
    }
}
