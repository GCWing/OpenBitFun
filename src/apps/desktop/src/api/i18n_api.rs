//! I18n API

use crate::api::app_state::AppState;
use log::{error, info, warn};
use openbitfun_core::service::i18n::{sync_global_i18n_service_locale, LocaleId, LocaleMetadata};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocaleMetadataResponse {
    pub id: String,
    pub name: String,
    #[serde(rename = "englishName")]
    pub english_name: String,
    #[serde(rename = "nativeName")]
    pub native_name: String,
    pub rtl: bool,
}

#[derive(Debug, Deserialize)]
pub struct SetLanguageRequest {
    pub language: String,
}

#[derive(Debug, Deserialize)]
pub struct TranslateRequest {
    pub key: String,
    pub args: Option<Value>,
}

pub(crate) async fn apply_language_runtime_effects(
    app: &tauri::AppHandle,
    _state: &AppState,
    language: &str,
) -> Result<(), String> {
    let Some(locale_id) = LocaleId::from_str(language) else {
        return Err(format!("Unsupported language: {language}"));
    };
    match sync_global_i18n_service_locale(locale_id).await {
        Ok(true) => {}
        Ok(false) => {
            warn!(
                "Global I18nService not initialized after language change: language={}",
                language
            );
        }
        Err(error) => {
            return Err(format!(
                "Failed to sync backend language runtime: language={language}, error={error}"
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let has_workspace = _state.workspace_id.read().await.is_some();
        let mode = if has_workspace {
            crate::macos_menubar::MenubarMode::Workspace
        } else {
            crate::macos_menubar::MenubarMode::Startup
        };
        let edit_mode = *_state.macos_edit_menu_mode.read().await;
        crate::macos_menubar::set_macos_menubar_with_mode(app, language, mode, edit_mode)
            .map_err(|error| format!("Failed to rebuild the localized menu: {error}"))?;
    }

    crate::tray::rebuild_tray_menu_public(app).await;
    Ok(())
}

#[tauri::command]
pub async fn i18n_get_current_language(state: State<'_, AppState>) -> Result<String, String> {
    let config_service = &state.config_service;

    match config_service
        .get_config::<String>(Some("app.language"))
        .await
    {
        Ok(language) => Ok(LocaleId::from_str(&language)
            .unwrap_or_default()
            .as_str()
            .to_string()),
        Err(_) => Ok("zh-CN".to_string()),
    }
}

#[tauri::command]
pub async fn i18n_set_language(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: SetLanguageRequest,
) -> Result<String, String> {
    let Some(locale_id) = LocaleId::from_str(&request.language) else {
        return Err(format!("Unsupported language: {}", request.language));
    };
    let language = locale_id.as_str().to_string();
    crate::openbitfun_control_host::configure_option_from_gui(
        &app,
        "setting.application.appearance",
        "language",
        Value::String(language.clone()),
    )
    .await
    .map_err(|error| {
        error!("Failed to set language: language={language}, error={error}");
        format!("Failed to set language: {error}")
    })?;
    info!("Language set to: {language}");
    Ok(format!("Language switched to: {language}"))
}

#[tauri::command]
pub async fn i18n_get_supported_languages() -> Result<Vec<LocaleMetadataResponse>, String> {
    Ok(LocaleMetadata::all()
        .into_iter()
        .map(|locale| LocaleMetadataResponse {
            id: locale.id.as_str().to_string(),
            name: locale.name,
            english_name: locale.english_name,
            native_name: locale.native_name,
            rtl: locale.rtl,
        })
        .collect())
}

#[tauri::command]
pub async fn i18n_get_config(state: State<'_, AppState>) -> Result<Value, String> {
    let config_service = &state.config_service;

    let current_language = match config_service
        .get_config::<String>(Some("app.language"))
        .await
    {
        Ok(language) => LocaleId::from_str(&language)
            .unwrap_or_default()
            .as_str()
            .to_string(),
        Err(_) => "zh-CN".to_string(),
    };

    Ok(serde_json::json!({
        "currentLanguage": current_language,
        "fallbackLanguage": "en-US",
        "autoDetect": false
    }))
}

#[tauri::command]
pub async fn i18n_set_config(
    _state: State<'_, AppState>,
    app: tauri::AppHandle,
    config: Value,
) -> Result<String, String> {
    if let Some(language) = config.get("currentLanguage").and_then(|v| v.as_str()) {
        let Some(locale_id) = LocaleId::from_str(language) else {
            return Err(format!("Unsupported language: {}", language));
        };

        crate::openbitfun_control_host::configure_option_from_gui(
            &app,
            "setting.application.appearance",
            "language",
            Value::String(locale_id.as_str().to_string()),
        )
        .await
        .map(|_| "i18n config saved".to_string())
        .map_err(|error| {
            error!("Failed to save i18n config: language={language}, error={error}");
            format!("Failed to save i18n config: {error}")
        })
    } else {
        Ok("i18n config saved (no language change)".to_string())
    }
}
