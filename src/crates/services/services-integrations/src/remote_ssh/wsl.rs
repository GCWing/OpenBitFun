//! Native WSL transport. Linux paths and commands are interpreted in the named
//! distribution; the Windows host is only responsible for launching wsl.exe.

use super::types::{ServerInfo, WslDistributions, WslWorkspaceConfig};
use anyhow::{anyhow, Context};
use openbitfun_services_core::process_manager;
use std::process::{Output, Stdio};
use std::time::Duration;

pub(crate) const EXECUTABLE: &str = "wsl.exe";

/// Force `wsl.exe` to emit its own diagnostics as UTF-8 instead of UTF-16LE.
///
/// WSL writes host-side notices (for example the "localhost proxy is not
/// mirrored into WSL" warning) and `WSL_E_*` errors as UTF-16LE on stderr while
/// Linux process output stays UTF-8. Without this switch every stderr read mixes
/// both encodings, so UTF-8 consumers see replacement characters and
/// `container_exists` cannot tell an empty stderr from a diagnostic.
pub(crate) const UTF8_ENV: (&str, &str) = ("WSL_UTF8", "1");

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
            .env(UTF8_ENV.0, UTF8_ENV.1)
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

/// Whether stderr carries an actual command diagnostic.
///
/// `wsl.exe` writes its own host notices to the same stderr stream as the guest
/// command (for example the "localhost proxy is not mirrored into WSL" warning
/// emitted on every start). Callers that treat any stderr output as failure must
/// ignore those notices, otherwise every WSL workspace operation looks broken.
pub(crate) fn stderr_reports_failure(stderr: &str) -> bool {
    stderr
        .lines()
        .map(str::trim)
        .any(|line| !line.is_empty() && !is_host_notice(line))
}

/// `wsl.exe` prefixes its own messages with `wsl: `. Guest diagnostics never do.
fn is_host_notice(line: &str) -> bool {
    line.strip_prefix("wsl:").is_some_and(|rest| {
        rest.starts_with(' ') || rest.starts_with(':') || rest.is_empty()
    })
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

#[cfg(all(test, windows))]
mod issue_repro_tests {
    //! Reproduces https://github.com/GCWing/OpenBitFun/issues/3435 against a real
    //! distribution. Run with OPENBITFUN_TEST_WSL_DISTRO and `--ignored`.

    #[tokio::test]
    #[ignore = "requires Windows and an initialized WSL distribution"]
    async fn wsl_workspace_file_browsing_reports_missing_paths_without_failing() {
        let distribution =
            std::env::var("OPENBITFUN_TEST_WSL_DISTRO").expect("Set OPENBITFUN_TEST_WSL_DISTRO");
        let root = tempfile::tempdir().unwrap();
        let manager = super::super::SSHConnectionManager::new(root.path().into());
        let mut config: super::super::SSHConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "wsl-browse", "name": "WSL browse", "host": "wsl.invalid", "port": 0,
            "username": "", "auth": { "type": "PrivateKey", "keyPath": "" },
            "wsl": { "distribution": distribution }
        }))
        .unwrap();
        config.wsl.as_mut().unwrap().distribution = distribution.clone();
        let result = manager.connect(config.clone()).await.unwrap();
        assert!(result.success, "connect failed: {:?}", result.error);
        manager.save_connection(&config).await.unwrap();

        let home = result.server_info.as_ref().unwrap().home_dir.clone();

        // The browser starts by listing the workspace root. WSL's launcher
        // notices must not turn that listing into a failure.
        let entries = manager.container_read_dir(&config.id, &home).await.unwrap();
        assert!(
            !entries.is_empty(),
            "home directory listing should return entries"
        );
        assert!(
            entries.iter().all(|entry| !entry.name.contains('\u{fffd}')),
            "listing must not contain replacement characters"
        );

        // A missing child path must read as "absent", not as a hard error.
        let missing = format!("{home}/openbitfun-missing-{}", uuid::Uuid::new_v4());
        assert!(
            !manager.container_exists(&config.id, &missing).await.unwrap(),
            "a missing path must report absent instead of failing"
        );

        manager.disconnect(&config.id).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires Windows and an initialized WSL distribution"]
    async fn wsl_workspace_stderr_carries_only_guest_diagnostics() {
        use tokio::io::AsyncReadExt;

        let distribution =
            std::env::var("OPENBITFUN_TEST_WSL_DISTRO").expect("Set OPENBITFUN_TEST_WSL_DISTRO");
        let root = tempfile::tempdir().unwrap();
        let manager = super::super::SSHConnectionManager::new(root.path().into());
        let config: super::super::SSHConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "wsl-stderr", "name": "WSL stderr", "host": "wsl.invalid", "port": 0,
            "username": "", "auth": { "type": "PrivateKey", "keyPath": "" },
            "wsl": { "distribution": distribution }
        }))
        .unwrap();
        assert!(manager.connect(config.clone()).await.unwrap().success);
        manager.save_connection(&config).await.unwrap();

        // The guest writes one diagnostic to stderr. WSL's launcher notices share
        // that stream, so the caller must see the diagnostic alone, as valid UTF-8.
        let transport = manager
            .open_workspace_stdio(&config.id, "printf 'guest-only' >&2")
            .await
            .unwrap();
        let (_stdin, _stdout, mut stderr, _control, completion) = transport.into_parts();
        let mut diagnostic = String::new();
        stderr
            .read_to_string(&mut diagnostic)
            .await
            .expect("stderr must stay valid UTF-8 for workspace consumers");
        completion.wait().await;
        assert_eq!(diagnostic, "guest-only");

        manager.disconnect(&config.id).await.unwrap();
    }
}
