use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::{ShellDetector, VERSION_PROBE_TIMEOUT_MS};

impl ShellDetector {
    pub(super) fn probe_powershell_version(path: &Path) -> Option<String> {
        Self::run_version_probe(path, &["-Version"])
    }

    pub(super) fn probe_shell_version(path: &Path) -> Option<String> {
        Self::run_version_probe(path, &["--version"])
    }

    fn run_version_probe(path: &Path, args: &[&str]) -> Option<String> {
        let mut command = Command::new(path);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().ok()?;
        let deadline = Instant::now() + Duration::from_millis(VERSION_PROBE_TIMEOUT_MS);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Err(_) => return None,
            }
        }
        let output = child.wait_with_output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8(output.stdout).ok().and_then(|value| {
            value
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(str::to_owned)
        })
    }
}
