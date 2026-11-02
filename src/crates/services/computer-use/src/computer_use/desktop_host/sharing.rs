//! User-selected native sharing, built on the same capture and input provider
//! as ComputerUse. No separate browser, input loop or permission owner.
use super::*;
use openbitfun_agent_tools::computer_use_control::{ControlMode, ControlSnapshot, ShareTarget};

async fn native_targets() -> Result<Vec<ShareTarget>, String> {
    #[cfg(target_os = "macos")]
    {
        return tokio::task::spawn_blocking(
            crate::computer_use::macos_list_apps::list_share_targets,
        )
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        return Ok(crate::computer_use::windows_list_apps::list_share_targets());
    }
    #[cfg(target_os = "linux")]
    {
        let mut result = vec![ShareTarget {
            selection_id: String::new(),
            unavailable_reason: None,
            id: "portal:pending".into(),
            pid: None,
            window_id: None,
            application: "Desktop portal".into(),
            title: String::new(),
            bundle_id: None,
            background_pointer: false,
            background_semantic: false,
            selection_required: true,
        }];
        result.extend(
            crate::computer_use::linux_control_ax::list_apps()
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter_map(|app| {
                    app.pid.map(|pid| ShareTarget {
                        selection_id: String::new(),
                        unavailable_reason: None,
                        id: format!("atspi:{pid}"),
                        pid: Some(pid),
                        window_id: None,
                        application: app.name,
                        title: String::new(),
                        bundle_id: None,
                        background_pointer: false,
                        background_semantic: true,
                        selection_required: false,
                    })
                }),
        );
        return Ok(result);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Err("[CONTROL_UNSUPPORTED] No native sharing provider".into())
}

use crate::computer_use::process_identity::ProcessIdentity;
use std::{
    collections::{hash_map::RandomState, VecDeque},
    hash::{BuildHasher, Hasher},
    sync::{Mutex, OnceLock},
};
#[derive(Clone)]
struct Choice {
    target: ShareTarget,
    process: Option<ProcessIdentity>,
}
static CHOICES: OnceLock<Mutex<VecDeque<Choice>>> = OnceLock::new();

pub async fn targets() -> Result<Vec<ShareTarget>, String> {
    let mut targets = native_targets().await?;
    let result = tokio::task::spawn_blocking(move || {
        let mut choices = CHOICES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "[CONTROL_FAILED] Target inventory lock poisoned")?;
        for target in &mut targets {
            target.selection_id =
                format!("window_{:016x}", RandomState::new().build_hasher().finish());
            let process = target.pid.map(ProcessIdentity::read).transpose();
            match process {
                Ok(process) => choices.push_back(Choice {
                    target: target.clone(),
                    process,
                }),
                Err(error) => target.unavailable_reason = Some(error),
            }
        }
        // Bounded discovery references are distinct from input leases. Older
        // references are rejected, never resolved to a new process with its PID.
        while choices.len() > 512 {
            choices.pop_front();
        }
        Ok::<_, String>(targets)
    })
    .await
    .map_err(|e| e.to_string())?;
    result
}

impl NativeComputerUseHost {
    pub async fn share_selected_target(
        &self,
        generation: u64,
        target_id: &str,
        mode: ControlMode,
    ) -> Result<ControlSnapshot, String> {
        // Re-resolve the inventory at the authorization boundary. A title or
        // client-provided PID is not evidence that the original window exists.
        let choice = CHOICES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "[CONTROL_FAILED] Target inventory lock poisoned")?
            .iter()
            .find(|choice| choice.target.selection_id == target_id)
            .cloned()
            .ok_or(
                "[TARGET_WINDOW_UNAVAILABLE] Target selection expired; refresh the window list",
            )?;
        if let Some(process) = &choice.process {
            process.validate()?;
        }
        let target = choice.target;
        if let Some(reason) = target.unavailable_reason {
            return Err(reason);
        }
        if target.selection_required && mode == ControlMode::Background {
            return Err("[BACKGROUND_UNSUPPORTED] Portal input controls the foreground seat. Select an AT-SPI application for background semantic control, or explicitly choose foreground mode.".into());
        }
        let label = if target.title.is_empty() {
            target.application.clone()
        } else {
            format!("{} — {}", target.application, target.title)
        };
        let (started, mut lease) = crate::computer_use::control_session::begin_share(
            generation,
            target.id.clone(),
            label,
            mode,
            choice.process,
        )?;
        let result = self.prepare_shared_surface(&target, mode).await;
        if let Err(error) = result {
            let _ = crate::computer_use::control_session::stop_checked(
                None,
                Some(started.generation),
                &error,
            );
            lease.complete();
            return Err(error);
        }
        let current = crate::computer_use::control_session::snapshot();
        let snapshot = crate::computer_use::control_session::finish_share(
            started.generation,
            current.target_revision,
        )?;
        lease.complete();
        Ok(snapshot)
    }

    async fn prepare_shared_surface(
        &self,
        target: &ShareTarget,
        mode: ControlMode,
    ) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let _ = mode;
            let pid = target.pid.ok_or("[TARGET_REQUIRED] Missing process")?;
            let window = target
                .window_id
                .and_then(|id| u32::try_from(id).ok())
                .ok_or("[TARGET_REQUIRED] Missing window")?;
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::macos_capture::ensure_capture(pid, Some(window))
            })
            .await
            .map_err(|e| e.to_string())??;
            self.screenshot_for_app_pid(pid)
                .await
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            let _ = mode;
            let pid = target.pid.ok_or("[TARGET_REQUIRED] Missing process")?;
            let window = target
                .window_id
                .and_then(|id| isize::try_from(id).ok())
                .ok_or("[TARGET_REQUIRED] Missing window")?;
            self.screenshot_for_foreground_window(pid, window)
                .await
                .map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        if target.selection_required {
            crate::computer_use::linux_control::start_session(mode == ControlMode::Foreground)
                .await?;
            self.screenshot_display(Default::default())
                .await
                .map_err(|e| e.to_string())?;
        } else {
            self.get_app_state_inner(
                AppSelector::by_pid(target.pid.ok_or("[TARGET_REQUIRED] Missing process")?),
                8,
                false,
                false,
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
