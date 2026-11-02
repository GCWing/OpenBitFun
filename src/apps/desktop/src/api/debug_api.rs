//! Debug API for desktop development.
//!
//! Provides element inspector, devtools control, and screenshot debugging.
//!
//! # Compilation guards
//! All public items in this module are guarded by `#[cfg(any(debug_assertions, feature = "devtools"))]`.
//! This ensures zero debug code is compiled into release builds intended for end users.

use serde::Deserialize;

#[cfg(any(debug_assertions, feature = "devtools"))]
use tauri::Manager;

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

/// Payload sent by the injected inspector script when user clicks an element.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugElementPickedRequest {
    pub tag_name: String,
    pub path: String,
    pub id: Option<String>,
    pub class_name: Option<String>,
    pub text_content: String,
    pub outer_html: String,
    pub computed_styles: serde_json::Value,
    pub css_variables: serde_json::Value,
    pub color_info: serde_json::Value,
    pub box_model: serde_json::Value,
    pub attributes: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Called by the injected inspector script when user clicks an element.
///
/// Logs the full element information as structured JSON so developers can
/// inspect tag, classes, computed styles, colors, box-model, etc.
#[tauri::command]
#[cfg(any(debug_assertions, feature = "devtools"))]
pub async fn debug_element_picked(request: DebugElementPickedRequest) -> Result<(), String> {
    let payload = serde_json::json!({
        "tag_name": request.tag_name,
        "path": request.path,
        "id": request.id,
        "class_name": request.class_name,
        "text_content": request.text_content,
        "outer_html_preview": request.outer_html,
        "computed_styles": request.computed_styles,
        "css_variables": request.css_variables,
        "color_info": request.color_info,
        "box_model": request.box_model,
        "attributes": request.attributes,
    });

    log::info!(
        target: "openbitfun::devtools",
        "Element picked: {}",
        serde_json::to_string_pretty(&payload).unwrap_or_default()
    );

    Ok(())
}

/// Report whether desktop debug commands are available in this build.
#[tauri::command]
#[cfg(any(debug_assertions, feature = "devtools"))]
pub async fn debug_devtools_available() -> Result<bool, String> {
    Ok(true)
}

/// Open the native webview DevTools window for the main window.
#[tauri::command]
#[cfg(any(debug_assertions, feature = "devtools"))]
pub async fn debug_open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    let webview = app.get_webview("main").ok_or("Main window not found")?;
    webview.open_devtools();
    Ok(())
}

/// Close the native webview DevTools window for the main window.
#[tauri::command]
#[cfg(any(debug_assertions, feature = "devtools"))]
pub async fn debug_close_devtools(app: tauri::AppHandle) -> Result<(), String> {
    let webview = app.get_webview("main").ok_or("Main window not found")?;
    webview.close_devtools();
    Ok(())
}

// ---------------------------------------------------------------------------
// No-op stubs for release builds (so the module always compiles)
// ---------------------------------------------------------------------------

#[tauri::command]
#[cfg(not(any(debug_assertions, feature = "devtools")))]
pub async fn debug_devtools_available() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
#[cfg(not(any(debug_assertions, feature = "devtools")))]
pub async fn debug_element_picked(_request: DebugElementPickedRequest) -> Result<(), String> {
    Err("DevTools not available in release builds".to_string())
}

#[tauri::command]
#[cfg(not(any(debug_assertions, feature = "devtools")))]
pub async fn debug_open_devtools(_app: tauri::AppHandle) -> Result<(), String> {
    Err("DevTools not available in release builds".to_string())
}

#[tauri::command]
#[cfg(not(any(debug_assertions, feature = "devtools")))]
pub async fn debug_close_devtools(_app: tauri::AppHandle) -> Result<(), String> {
    Err("DevTools not available in release builds".to_string())
}
