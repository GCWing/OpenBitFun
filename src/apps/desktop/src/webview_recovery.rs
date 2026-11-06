use serde::{Deserialize, Serialize};
use std::time::Duration;

const RENDERER_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
const RESTART_FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryAction {
    Reload,
    Restart,
    Block,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RecoveryHistory {
    last_renderer_failure_ms: Option<u64>,
    restart_attempts_ms: Vec<u64>,
}

fn decide_recovery(history: &mut RecoveryHistory, now_ms: u64) -> RecoveryAction {
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

mod cef {
    use super::{decide_recovery, RecoveryAction, RecoveryHistory};
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::Manager;
    use tauri_plugin_dialog::{
        DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
    };
    const RECOVERY_STATE_FILE: &str = "webview-recovery.json";
    const DUPLICATE_EVENT_GUARD: Duration = Duration::from_secs(2);

    static RECOVERY_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
    static RECOVERY_CONTEXT: OnceLock<RecoveryContext> = OnceLock::new();

    struct RecoveryContext {
        history: Mutex<RecoveryHistory>,
        state_path: PathBuf,
    }

    pub(super) fn initialize(app: &tauri::AppHandle) {
        let directory = if std::env::var_os("OPENBITFUN_USER_ROOT").is_some() {
            Ok(openbitfun_core::infrastructure::get_path_manager_arc().user_data_dir())
        } else {
            app.path().app_data_dir()
        };
        let state_path = match directory {
            Ok(directory) => directory.join(RECOVERY_STATE_FILE),
            Err(error) => {
                log::warn!("Failed to resolve WebView recovery state path: {error}");
                return;
            }
        };
        let context = RECOVERY_CONTEXT.get_or_init(|| RecoveryContext {
            history: Mutex::new(load_history(&state_path)),
            state_path,
        });
        prune_expired_restart_attempts(context);
    }

    pub(super) fn handle_failure(app: &tauri::AppHandle) {
        if RECOVERY_IN_PROGRESS.swap(true, Ordering::SeqCst) {
            log::warn!("Ignored duplicate Chromium renderer failure while recovery is active");
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
            let action = decide_recovery(&mut history, now_ms);
            if let Err(error) = save_history(&context.state_path, &history) {
                log::warn!("Failed to persist WebView recovery history: {}", error);
            }
            action
        };

        log::warn!("Chromium renderer failed: action={action:?}");
        match action {
            RecoveryAction::Reload => {
                let reload_result = app
                    .get_webview("main")
                    .ok_or_else(|| "main window not found".to_string())
                    .and_then(|window| window.reload().map_err(|error| error.to_string()));
                if let Err(error) = reload_result {
                    log::warn!("Chromium recovery reload failed: {}", error);
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
            let action = super::restart_or_block(&mut history, now_ms);
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
        log::warn!("Requesting controlled application restart for Chromium recovery");
        request_controlled_restart(app, "webview_recovery_restart");
    }

    fn show_escape_dialog(app: tauri::AppHandle) {
        log::error!("Automatic Chromium recovery budget exhausted; requesting user action");
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
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        serde_json::to_writer(file.as_file_mut(), history).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        file.persist(path).map_err(|error| error.to_string())?;
        Ok(())
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

pub(crate) fn observe(
    app: &tauri::AppHandle,
) -> impl Fn(tauri_runtime_cef::FrameEvent) + Send + Sync + 'static {
    cef::initialize(app);
    let app = app.clone();
    move |event| {
        if matches!(
            event.kind,
            tauri_runtime_cef::FrameEventKind::RendererTerminated
        ) && !crate::desktop_exit_in_progress()
        {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || cef::handle_failure(&app));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE_MS: u64 = 60_000;

    #[test]
    fn first_main_renderer_failure_reloads() {
        let mut history = RecoveryHistory::default();

        assert_eq!(decide_recovery(&mut history, 0), RecoveryAction::Reload);
    }

    #[test]
    fn repeated_main_renderer_failure_within_window_restarts() {
        let mut history = RecoveryHistory::default();
        assert_eq!(decide_recovery(&mut history, 0), RecoveryAction::Reload);

        assert_eq!(
            decide_recovery(&mut history, 5 * MINUTE_MS,),
            RecoveryAction::Restart
        );
    }

    #[test]
    fn renderer_failure_after_window_gets_a_new_reload_attempt() {
        let mut history = RecoveryHistory::default();
        assert_eq!(decide_recovery(&mut history, 0), RecoveryAction::Reload);

        assert_eq!(
            decide_recovery(&mut history, RENDERER_FAILURE_WINDOW.as_millis() as u64 + 1,),
            RecoveryAction::Reload
        );
    }

    #[test]
    fn second_automatic_restart_within_window_is_blocked() {
        let mut history = RecoveryHistory::default();
        assert_eq!(restart_or_block(&mut history, 0), RecoveryAction::Restart);

        assert_eq!(
            restart_or_block(&mut history, RESTART_FAILURE_WINDOW.as_millis() as u64 - 1),
            RecoveryAction::Block
        );
    }

    #[test]
    fn automatic_restart_budget_recovers_after_window() {
        let mut history = RecoveryHistory::default();
        assert_eq!(restart_or_block(&mut history, 0), RecoveryAction::Restart);

        assert_eq!(
            restart_or_block(&mut history, RESTART_FAILURE_WINDOW.as_millis() as u64 + 1),
            RecoveryAction::Restart
        );
    }

    #[test]
    fn failed_reload_respects_existing_restart_budget() {
        let mut history = RecoveryHistory::default();
        assert_eq!(restart_or_block(&mut history, 0), RecoveryAction::Restart);

        assert_eq!(
            restart_or_block(&mut history, MINUTE_MS),
            RecoveryAction::Block
        );
    }
}
