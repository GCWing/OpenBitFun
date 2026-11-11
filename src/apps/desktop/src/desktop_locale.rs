//! Native desktop UI strings that bypass the web-ui i18n system.
//!
//! These are OS-level strings (menus, native dialogs, tray, window titles,
//! sleep-prevention reasons) set by the Tauri host before or outside the
//! frontend i18n pipeline. They are localized here per app language.

use tauri::AppHandle;

/// Localized native strings for the desktop host.
pub struct DesktopNativeLabels {
    pub webview_recovery_message: &'static str,
    pub webview_recovery_title: &'static str,
    pub webview_recovery_restart_button: &'static str,
    pub startup_error_title: &'static str,
    pub startup_agent_profile_error: &'static str,
    pub startup_config_error: &'static str,
    pub startup_appstate_error: &'static str,
    pub tray_tooltip: &'static str,
    pub sleep_prevention_reason: &'static str,
    pub agent_companion_window_title: &'static str,
    pub frontend_review_title: &'static str,
}

impl DesktopNativeLabels {
    pub fn for_language(language: &str) -> Self {
        match language {
            "fr-FR" | "fr" => DesktopNativeLabels {
                webview_recovery_message: "L'affichage d'OpenBitFun a cessé de répondre et la récupération automatique a été mise en pause pour éviter une boucle de redémarrage. Redémarrer OpenBitFun maintenant ?",
                webview_recovery_title: "Récupération de l'affichage OpenBitFun",
                webview_recovery_restart_button: "Redémarrer OpenBitFun",
                startup_error_title: "Erreur de démarrage OpenBitFun",
                startup_agent_profile_error: "OpenBitFun n'a pas pu sélectionner son profil d'agent Desktop et ne peut pas continuer.\n\n{error}\n\nConsultez early-startup.log pour plus de détails.",
                startup_config_error: "OpenBitFun n'a pas pu initialiser sa configuration et ne peut pas continuer.\n\n{e}\n\nConsultez early-startup.log pour plus de détails.",
                startup_appstate_error: "OpenBitFun n'a pas pu initialiser l'état de son application et ne peut pas continuer.\n\n{e}\n\nConsultez {path} pour plus de détails.",
                tray_tooltip: "OpenBitFun",
                sleep_prevention_reason: "La prévention du sommeil est activée dans OpenBitFun",
                agent_companion_window_title: "Compagnon agent OpenBitFun",
                frontend_review_title: "Revoir la mise à jour du frontend OpenBitFun",
            },
            "zh-CN" => DesktopNativeLabels {
                webview_recovery_message: "OpenBitFun 的显示已停止响应，自动恢复已暂停以避免重启循环。现在重启 OpenBitFun？",
                webview_recovery_title: "OpenBitFun 显示恢复",
                webview_recovery_restart_button: "重启 OpenBitFun",
                startup_error_title: "OpenBitFun 启动错误",
                startup_agent_profile_error: "OpenBitFun 无法选择其 Desktop 智能体配置文件，无法继续。\n\n{error}\n\n请参阅 early-startup.log 了解详情。",
                startup_config_error: "OpenBitFun 无法初始化其配置，无法继续。\n\n{e}\n\n请参阅 early-startup.log 了解详情。",
                startup_appstate_error: "OpenBitFun 无法初始化其应用状态，无法继续。\n\n{e}\n\n请参阅 {path} 了解详情。",
                tray_tooltip: "OpenBitFun",
                sleep_prevention_reason: "已在 OpenBitFun 中启用防止睡眠",
                agent_companion_window_title: "OpenBitFun 智能体伴侣",
                frontend_review_title: "审查 OpenBitFun 前端更新",
            },
            _ => DesktopNativeLabels {
                webview_recovery_message: "OpenBitFun's display stopped responding and automatic recovery was paused to avoid a restart loop. Restart OpenBitFun now?",
                webview_recovery_title: "OpenBitFun display recovery",
                webview_recovery_restart_button: "Restart OpenBitFun",
                startup_error_title: "OpenBitFun startup error",
                startup_agent_profile_error: "OpenBitFun could not select its Desktop agent profile and cannot continue.\n\n{error}\n\nSee early-startup.log for details.",
                startup_config_error: "OpenBitFun could not initialize its configuration and cannot continue.\n\n{e}\n\nSee early-startup.log for details.",
                startup_appstate_error: "OpenBitFun could not initialize its application state and cannot continue.\n\n{e}\n\nSee {path} for details.",
                tray_tooltip: "OpenBitFun",
                sleep_prevention_reason: "Prevent sleep is enabled in OpenBitFun",
                agent_companion_window_title: "OpenBitFun Agent Companion",
                frontend_review_title: "Review OpenBitFun frontend update",
            },
        }
    }

    /// Read the current app language from state and return localized labels.
    /// Falls back to English if the language is not yet available.
    pub fn for_app(app: &AppHandle) -> Self {
        let language = app
            .try_state::<crate::api::app_state::AppState>()
            .and_then(|state| {
                let config = state.config_service.clone();
                std::thread::spawn(move || {
                    tauri::async_runtime::block_on(async {
                        config.get_config::<String>(Some("app.language")).await
                    })
                })
                .join()
                .ok()
                .flatten()
            })
            .unwrap_or_default();
        Self::for_language(&language)
    }
}
