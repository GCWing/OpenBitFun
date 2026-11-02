//! Observation lifecycle shared by AX, UIA and AT-SPI providers.
use super::*;

impl NativeComputerUseHost {
    pub(crate) async fn get_app_state_inner(
        &self,
        app: AppSelector,
        max_depth: u32,
        focus_window_only: bool,
        capture_screenshot: bool,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        #[cfg(target_os = "linux")]
        if !app.is_empty() {
            crate::computer_use::linux_control_ax::bind_app_selector(&app).await?;
        }
        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        let mut snapshot = self
            .get_native_app_state_inner(app, max_depth, focus_window_only, capture_screenshot)
            .await?;
        let pid = snapshot.app.pid.ok_or_else(|| {
            OpenBitFunError::tool("[APP_IDENTITY_UNAVAILABLE] Observation has no process identity")
        })?;
        let mut state = self.state_for_scope(&scope)?;
        snapshot.observation_id = Some(
            state
                .observations
                .record_application(pid)
                .map_err(OpenBitFunError::tool)?,
        );
        // Native node indices were rebuilt, including same-content observations.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            state.interactive_view_cache.clear();
            state.visual_mark_cache.clear();
        }
        Ok(snapshot)
    }

    /// AX-only observations skip frame retrieval and JPEG encoding. They still
    /// rebuild node identities and obey the same control scope as image-bearing
    /// observations. Existing callers include pixels unless explicitly opted out.
    async fn get_native_app_state_inner(
        &self,
        app: AppSelector,
        max_depth: u32,
        focus_window_only: bool,
        capture_screenshot: bool,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        #[cfg(target_os = "macos")]
        {
            // Pre-flight: without Accessibility trust macOS silently truncates
            // the AX subtree to the top-level window/container (~7 nodes for
            // a Tauri WebView app), with no exception. The agent then has no
            // actionable widgets to act on. Fail fast with a structured
            // `[PERMISSION_DENIED]` error so the model can surface the issue
            // Permission requests remain an explicit user action in settings.
            macos::require_ax_trust_for(
                "After granting, retry `desktop.get_app_state` and the AX tree will include all WebView subtree nodes.",
            )?;
            let pid = resolve_pid_macos(self, &app).await?;
            let shared = crate::computer_use::control_session::snapshot();
            if shared.sharing.is_some()
                && !shared
                    .target
                    .as_deref()
                    .is_some_and(|target| target.starts_with(&format!("pid:{pid}/window:")))
            {
                return Err(OpenBitFunError::tool("[SHARED_TARGET_ONLY] Accessibility observation requires the shared application"));
            }
            let focus_window_only = focus_window_only || shared.sharing.is_some();
            debug!(
                "Computer Use AX observation started: pid={pid}, same_process={}",
                pid == std::process::id() as i32
            );
            let mut snap = crate::computer_use::control_session::spawn_blocking(move || {
                // Wrap in @try/@catch — AX APIs can throw NSException for
                // sandboxed / partially-loaded / dying processes, and an
                // unwound foreign exception aborts the whole openbitfun process
                // (`Rust cannot catch foreign exceptions, aborting`).
                // Only individual same-process AX messages go to main. The
                // walk must remain off-main to serve WebKit's synchronous IPC.
                macos::catch_objc_local(|| {
                    crate::computer_use::macos_ax_dump::dump_app_ax(
                        pid,
                        crate::computer_use::macos_ax_dump::DumpOpts {
                            max_depth,
                            focus_window_only,
                            ..Default::default()
                        },
                    )
                })
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            debug!(
                "Computer Use AX observation completed: pid={pid}, node_count={}",
                snap.nodes.len()
            );

            // Auto-attach focused-window screenshot. Failures are non-fatal —
            // worst case the model still has the AX tree.
            if capture_screenshot {
                let started = std::time::Instant::now();
                match self.screenshot_for_app_pid(pid).await {
                    Ok(shot) => {
                        debug!(
                            "computer_use.app_state: attached screenshot ({}x{} jpeg, {} bytes, {}ms)",
                            shot.image_width,
                            shot.image_height,
                            shot.bytes.len(),
                            started.elapsed().as_millis()
                        );
                        snap.screenshot = Some(shot);
                    }
                    Err(e) => {
                        snap.tree_text.push_str(&format!(
                            "\n[note] CAPTURE_UNAVAILABLE: {e}. Accessibility facts remain available; no substitute window was captured.\n"
                        ));
                    }
                }
            }
            Ok(snap)
        }
        #[cfg(target_os = "windows")]
        {
            let (_, hwnd_raw) = self.windows_target(&app).await?;

            let mut snap = crate::computer_use::control_session::spawn_blocking(move || {
                let hwnd = windows::Win32::Foundation::HWND(hwnd_raw as *mut std::ffi::c_void);
                crate::computer_use::windows_ax_ui::get_app_state_snapshot_for_window(
                    hwnd,
                    max_depth,
                    focus_window_only,
                )
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;

            let reg_pid = snap.app.pid.unwrap_or(0);

            // Auto-attach window screenshot (Codex parity). Failures are non-fatal.
            if capture_screenshot {
                let started = std::time::Instant::now();
                match self
                    .screenshot_for_foreground_window(reg_pid, hwnd_raw)
                    .await
                {
                    Ok(shot) => {
                        debug!(
                            "computer_use.app_state: attached window screenshot ({}x{}, {} bytes, {}ms)",
                            shot.image_width,
                            shot.image_height,
                            shot.bytes.len(),
                            started.elapsed().as_millis()
                        );
                        snap.screenshot = Some(shot);
                    }
                    Err(e) => {
                        snap.tree_text.push_str(&format!(
                            "\n[note] CAPTURE_UNAVAILABLE: {e}. Accessibility facts remain available; no substitute window was captured.\n"
                        ));
                    }
                }
            }

            Ok(snap)
        }
        #[cfg(target_os = "linux")]
        {
            let _ = capture_screenshot;
            crate::computer_use::linux_control_ax::snapshot(app, max_depth, focus_window_only).await
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (app, max_depth, focus_window_only, capture_screenshot);
            Err(OpenBitFunError::tool(
                "[CONTROL_UNSUPPORTED] No accessibility provider",
            ))
        }
    }
}
