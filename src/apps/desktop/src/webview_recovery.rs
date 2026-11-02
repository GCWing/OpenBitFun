#[cfg(any(target_os = "windows", test))]
use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", test))]
use std::time::Duration;

#[cfg(any(target_os = "windows", test))]
const RENDERER_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
#[cfg(any(target_os = "windows", test))]
const RESTART_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    BrowserExited,
    RendererExited,
    RendererUnresponsive,
    FrameRendererExited,
    Other,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryAction {
    Reload,
    Restart,
    Block,
    Observe,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RecoveryHistory {
    last_renderer_failure_ms: Option<u64>,
    restart_attempts_ms: Vec<u64>,
}

#[cfg(any(target_os = "windows", test))]
fn decide_recovery(
    history: &mut RecoveryHistory,
    failure: FailureKind,
    now_ms: u64,
) -> RecoveryAction {
    match failure {
        FailureKind::BrowserExited => restart_or_block(history, now_ms),
        FailureKind::RendererExited | FailureKind::RendererUnresponsive => {
            let should_reload = history.last_renderer_failure_ms.is_none_or(|previous| {
                now_ms.saturating_sub(previous) > RENDERER_FAILURE_WINDOW.as_millis() as u64
            });
            history.last_renderer_failure_ms = Some(now_ms);
            if should_reload {
                RecoveryAction::Reload
            } else {
                restart_or_block(history, now_ms)
            }
        }
        FailureKind::FrameRendererExited | FailureKind::Other => RecoveryAction::Observe,
    }
}

#[cfg(any(target_os = "windows", test))]
fn restart_or_block(history: &mut RecoveryHistory, now_ms: u64) -> RecoveryAction {
    let window_ms = RESTART_FAILURE_WINDOW.as_millis() as u64;
    history
        .restart_attempts_ms
        .retain(|attempt| now_ms.saturating_sub(*attempt) <= window_ms);
    if history.restart_attempts_ms.is_empty() {
        history.restart_attempts_ms.push(now_ms);
        RecoveryAction::Restart
    } else {
        RecoveryAction::Block
    }
}

#[cfg(any(target_os = "windows", test))]
fn restart_after_failed_reload(history: &mut RecoveryHistory, now_ms: u64) -> RecoveryAction {
    restart_or_block(history, now_ms)
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{decide_recovery, FailureKind, RecoveryAction, RecoveryHistory};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::Manager;
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    use webview2_com::ProcessFailedEventHandler;

    const RECOVERY_STATE_FILE: &str = "webview-recovery.json";
    const DUPLICATE_EVENT_GUARD: Duration = Duration::from_secs(2);

    static RECOVERY_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
    static RECOVERY_CONTEXT: OnceLock<RecoveryContext> = OnceLock::new();

    struct RecoveryContext {
        history: Mutex<RecoveryHistory>,
        state_path: PathBuf,
    }

    pub(super) fn install(window: &tauri::WebviewWindow) {
        let app = window.app_handle().clone();
        let state_path = match app.path().app_data_dir() {
            Ok(directory) => directory.join(RECOVERY_STATE_FILE),
            Err(error) => {
                log::warn!("Failed to resolve WebView recovery state path: {}", error);
                return;
            }
        };
        let context = RECOVERY_CONTEXT.get_or_init(|| RecoveryContext {
            history: Mutex::new(load_history(&state_path)),
            state_path,
        });
        prune_expired_restart_attempts(context);

        let app_for_handler = app.clone();
        if let Err(error) = window.with_webview(move |platform_webview| unsafe {
            let webview = match platform_webview.controller().CoreWebView2() {
                Ok(webview) => webview,
                Err(error) => {
                    log::warn!("Failed to access WebView2 for process recovery: {}", error);
                    return;
                }
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else {
                    log::warn!("WebView2 process failure did not include event arguments");
                    return Ok(());
                };
                let mut native_kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut native_kind)?;
                handle_failure(
                    &app_for_handler,
                    map_failure_kind(native_kind),
                    native_kind.0,
                );
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(error) = webview.add_ProcessFailed(&handler, &mut token) {
                log::warn!(
                    "Failed to register WebView2 process recovery handler: {}",
                    error
                );
            } else {
                log::info!("Registered WebView2 process recovery handler");
            }
        }) {
            log::warn!(
                "Failed to schedule WebView2 process recovery registration: {}",
                error
            );
        }
    }

    fn handle_failure(app: &tauri::AppHandle, failure: FailureKind, native_kind: i32) {
        if RECOVERY_IN_PROGRESS.swap(true, Ordering::SeqCst) {
            log::warn!(
                "Ignored duplicate WebView2 process failure while recovery is active: kind={}",
                native_kind
            );
            return;
        }

        let now_ms = current_time_ms();
        let Some(context) = RECOVERY_CONTEXT.get() else {
            RECOVERY_IN_PROGRESS.store(false, Ordering::SeqCst);
            return;
        };
        let action = {
            let mut history = match context.history.lock() {
                Ok(history) => history,
                Err(error) => {
                    log::error!("WebView recovery history lock poisoned: {}", error);
                    show_escape_dialog(app.clone());
                    return;
                }
            };
            let action = decide_recovery(&mut history, failure, now_ms);
            if let Err(error) = save_history(&context.state_path, &history) {
                log::warn!("Failed to persist WebView recovery history: {}", error);
            }
            action
        };

        log::warn!(
            "WebView2 process failure detected: kind={}, action={:?}",
            native_kind,
            action
        );
        match action {
            RecoveryAction::Reload => {
                let reload_result = app
                    .get_webview("main")
                    .ok_or_else(|| "main window not found".to_string())
                    .and_then(|window| window.reload().map_err(|error| error.to_string()));
                if let Err(error) = reload_result {
                    log::warn!("WebView2 recovery reload failed: {}", error);
                    handle_failed_reload(app, now_ms);
                    return;
                }
                std::thread::spawn(|| {
                    std::thread::sleep(DUPLICATE_EVENT_GUARD);
                    RECOVERY_IN_PROGRESS.store(false, Ordering::SeqCst);
                });
            }
            RecoveryAction::Restart => request_automatic_restart(app),
            RecoveryAction::Block => show_escape_dialog(app.clone()),
            RecoveryAction::Observe => RECOVERY_IN_PROGRESS.store(false, Ordering::SeqCst),
        }
    }

    fn handle_failed_reload(app: &tauri::AppHandle, now_ms: u64) {
        let Some(context) = RECOVERY_CONTEXT.get() else {
            show_escape_dialog(app.clone());
            return;
        };
        let action = {
            let mut history = match context.history.lock() {
                Ok(history) => history,
                Err(error) => {
                    log::error!("WebView recovery history lock poisoned: {}", error);
                    show_escape_dialog(app.clone());
                    return;
                }
            };
            let action = super::restart_after_failed_reload(&mut history, now_ms);
            if let Err(error) = save_history(&context.state_path, &history) {
                log::warn!("Failed to persist WebView recovery history: {}", error);
            }
            action
        };
        match action {
            RecoveryAction::Restart => request_automatic_restart(app),
            RecoveryAction::Block => show_escape_dialog(app.clone()),
            _ => unreachable!("failed reload only resolves to restart or block"),
        }
    }

    fn request_automatic_restart(app: &tauri::AppHandle) {
        log::warn!("Requesting controlled application restart for WebView2 recovery");
        request_controlled_restart(app, "webview_recovery_restart");
    }

    fn show_escape_dialog(app: tauri::AppHandle) {
        log::error!("Automatic WebView2 recovery budget exhausted; requesting user action");
        app.dialog()
            .message(
                "OpenBitFun's display stopped responding and automatic recovery was paused to avoid a restart loop. Restart OpenBitFun now?",
            )
            .title("OpenBitFun display recovery")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restart OpenBitFun".to_string(),
                "Exit".to_string(),
            ))
            .show_with_result(move |result| match result {
                MessageDialogResult::Ok | MessageDialogResult::Yes => {
                    request_user_restart(&app)
                }
                MessageDialogResult::Custom(label) if label == "Restart OpenBitFun" => {
                    request_user_restart(&app)
                }
                _ => {
                    crate::request_desktop_exit(&app, 1, "webview_recovery_exit");
                }
            });
    }

    fn request_user_restart(app: &tauri::AppHandle) {
        request_controlled_restart(app, "webview_recovery_user_restart");
    }

    fn request_controlled_restart(app: &tauri::AppHandle, reason: &'static str) {
        crate::save_main_window_state(app, reason);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::perform_process_exit_cleanup().await;
            crate::crash_diagnostics::mark_clean_shutdown(reason);
            log::info!(
                "Desktop restart authorized after graceful shutdown: reason={}",
                reason
            );
            app.request_restart();
        });
    }

    fn map_failure_kind(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> FailureKind {
        if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
            FailureKind::BrowserExited
        } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
            FailureKind::RendererExited
        } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
            FailureKind::RendererUnresponsive
        } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED {
            FailureKind::FrameRendererExited
        } else {
            FailureKind::Other
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn load_history(path: &Path) -> RecoveryHistory {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save_history(path: &Path, history: &RecoveryHistory) -> Result<(), String> {
        let Some(parent) = path.parent() else {
            return Err("recovery state path has no parent".to_string());
        };
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary_path = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec(history).map_err(|error| error.to_string())?;
        fs::write(&temporary_path, bytes).map_err(|error| error.to_string())?;
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary_path, path).map_err(|error| error.to_string())
    }

    #[test]
    fn recovery_state_save_replaces_existing_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("webview-recovery.json");
        let first = RecoveryHistory {
            last_renderer_failure_ms: Some(1),
            restart_attempts_ms: vec![2],
        };
        save_history(&state_path, &first).expect("first recovery state save");

        let second = RecoveryHistory {
            last_renderer_failure_ms: Some(3),
            restart_attempts_ms: vec![4],
        };
        save_history(&state_path, &second).expect("replacement recovery state save");

        let loaded = load_history(&state_path);
        assert_eq!(loaded.last_renderer_failure_ms, Some(3));
        assert_eq!(loaded.restart_attempts_ms, vec![4]);
    }

    fn prune_expired_restart_attempts(context: &RecoveryContext) {
        let now_ms = current_time_ms();
        let Ok(mut history) = context.history.lock() else {
            return;
        };
        let window_ms = super::RESTART_FAILURE_WINDOW.as_millis() as u64;
        history
            .restart_attempts_ms
            .retain(|attempt| now_ms.saturating_sub(*attempt) <= window_ms);
        if let Err(error) = save_history(&context.state_path, &history) {
            log::warn!("Failed to prune WebView recovery history: {}", error);
        }
    }
}

pub(crate) fn install(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    windows::install(window);

    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE_MS: u64 = 60_000;

    #[test]
    fn first_main_renderer_failure_reloads() {
        let mut history = RecoveryHistory::default();

        assert_eq!(
            decide_recovery(&mut history, FailureKind::RendererExited, 0),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn repeated_main_renderer_failure_within_window_restarts() {
        let mut history = RecoveryHistory::default();
        assert_eq!(
            decide_recovery(&mut history, FailureKind::RendererExited, 0),
            RecoveryAction::Reload
        );

        assert_eq!(
            decide_recovery(
                &mut history,
                FailureKind::RendererUnresponsive,
                5 * MINUTE_MS,
            ),
            RecoveryAction::Restart
        );
    }

    #[test]
    fn renderer_failure_after_window_gets_a_new_reload_attempt() {
        let mut history = RecoveryHistory::default();
        assert_eq!(
            decide_recovery(&mut history, FailureKind::RendererExited, 0),
            RecoveryAction::Reload
        );

        assert_eq!(
            decide_recovery(
                &mut history,
                FailureKind::RendererExited,
                RENDERER_FAILURE_WINDOW.as_millis() as u64 + 1,
            ),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn browser_exit_restarts_without_attempting_reload() {
        let mut history = RecoveryHistory::default();

        assert_eq!(
            decide_recovery(&mut history, FailureKind::BrowserExited, 0),
            RecoveryAction::Restart
        );
    }

    #[test]
    fn second_automatic_restart_within_window_is_blocked() {
        let mut history = RecoveryHistory::default();
        assert_eq!(
            decide_recovery(&mut history, FailureKind::BrowserExited, 0),
            RecoveryAction::Restart
        );

        assert_eq!(
            decide_recovery(
                &mut history,
                FailureKind::BrowserExited,
                RESTART_FAILURE_WINDOW.as_millis() as u64 - 1,
            ),
            RecoveryAction::Block
        );
    }

    #[test]
    fn automatic_restart_budget_recovers_after_window() {
        let mut history = RecoveryHistory::default();
        assert_eq!(
            decide_recovery(&mut history, FailureKind::BrowserExited, 0),
            RecoveryAction::Restart
        );

        assert_eq!(
            decide_recovery(
                &mut history,
                FailureKind::BrowserExited,
                RESTART_FAILURE_WINDOW.as_millis() as u64 + 1,
            ),
            RecoveryAction::Restart
        );
    }

    #[test]
    fn failed_reload_respects_existing_restart_budget() {
        let mut history = RecoveryHistory::default();
        assert_eq!(
            decide_recovery(&mut history, FailureKind::BrowserExited, 0),
            RecoveryAction::Restart
        );

        assert_eq!(
            restart_after_failed_reload(&mut history, MINUTE_MS),
            RecoveryAction::Block
        );
    }

    #[test]
    fn subordinate_process_failures_are_observed_without_disruption() {
        let mut history = RecoveryHistory::default();

        for failure in [FailureKind::FrameRendererExited, FailureKind::Other] {
            assert_eq!(
                decide_recovery(&mut history, failure, 0),
                RecoveryAction::Observe
            );
        }
    }
}
