//! Linux application launch, separate from opening documents/URLs.
//! A GUI process outlives its launch request; never wait for that process to exit.
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::OpenAppResult;
use std::process::Stdio;

fn result(name: &str, pid: Option<u32>, path: &str) -> OpenAppResult {
    OpenAppResult {
        app_name: name.into(),
        success: true,
        process_id: pid.and_then(|pid| i32::try_from(pid).ok()),
        error_message: None,
        bundle_id: None,
        process_name: None,
        window_count: None,
        launch_path: Some(path.into()),
    }
}

pub(super) async fn open(name: &str) -> OpenBitFunResult<OpenAppResult> {
    if name.trim().is_empty() || name.contains('\0') || name.starts_with('-') {
        return Err(OpenBitFunError::tool(
            "[APP_REQUIRED] Use an executable name/path or desktop application ID",
        ));
    }
    if !name.ends_with(".desktop") {
        let mut command = openbitfun_services_core::process_manager::create_tokio_command(name);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match command.spawn() {
            Ok(mut child) => {
                let pid = child.id();
                // Reap asynchronously; the app must remain running after the
                // control action ends. No shell or guessed command-line split.
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Ok(result(name, pid, "executable_spawn"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !name.contains('/') => {}
            Err(error) => {
                return Err(OpenBitFunError::tool(format!(
                    "[APP_LAUNCH_FAILED] {error}"
                )))
            }
        }
    }
    let (program, args) = desktop_launcher(name);
    let mut command = openbitfun_services_core::process_manager::create_tokio_command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().map_err(|error| OpenBitFunError::tool(format!(
        "[APP_LAUNCH_UNAVAILABLE] {program}: {error}. Use an installed executable name/path or a desktop application ID; xdg-open is not an application launcher."
    )))?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| OpenBitFunError::tool("[APP_LAUNCH_OUTCOME_UNKNOWN] The desktop launcher did not finish. Inspect list_apps before retrying; the application may already have started."))?
        .map_err(|error| OpenBitFunError::tool(format!("[APP_LAUNCH_OUTCOME_UNKNOWN] {error}; inspect list_apps before retrying")))?;
    if !output.status.success() {
        return Err(OpenBitFunError::tool(format!(
            "[APP_LAUNCH_FAILED] {program}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    // A launcher PID is not the task application's PID.
    Ok(result(name, None, program))
}

fn desktop_launcher(name: &str) -> (&'static str, Vec<&str>) {
    if name.ends_with(".desktop") && name.contains('/') {
        ("gio", vec!["launch", "--", name])
    } else {
        ("gtk-launch", vec!["--", name])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_files_and_ids_are_literal_launcher_arguments() {
        assert_eq!(
            desktop_launcher("org.gnome.Calculator.desktop"),
            ("gtk-launch", vec!["--", "org.gnome.Calculator.desktop"])
        );
        assert_eq!(
            desktop_launcher("/tmp/My App.desktop"),
            ("gio", vec!["launch", "--", "/tmp/My App.desktop"])
        );
        assert_eq!(
            desktop_launcher("name;echo bad"),
            ("gtk-launch", vec!["--", "name;echo bad"])
        );
        let launched = result("app", None, "gtk-launch");
        assert!(launched.process_id.is_none());
        assert!(launched.window_count.is_none());
    }

    #[tokio::test]
    async fn invalid_names_fail_before_process_creation() {
        for name in ["", " ", "--help", "bad\0name"] {
            assert!(open(name)
                .await
                .unwrap_err()
                .to_string()
                .contains("APP_REQUIRED"));
        }
    }
}
