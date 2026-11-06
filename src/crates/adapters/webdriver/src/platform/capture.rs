use std::time::Duration;

use serde_json::{json, Value};
use tauri::Webview;

use super::{call_devtools, types::PrintOptions};
use crate::server::response::WebDriverErrorResponse;

pub async fn take_screenshot(
    webview: Webview,
    timeout_ms: u64,
) -> Result<String, WebDriverErrorResponse> {
    capture(
        &webview,
        "Page.captureScreenshot",
        json!({ "format": "png", "fromSurface": true }),
        timeout_ms,
    )
    .await
}

pub async fn print_page(
    webview: Webview,
    timeout_ms: u64,
    options: &PrintOptions,
) -> Result<String, WebDriverErrorResponse> {
    const CM_PER_INCH: f64 = 2.54;
    let inches = |value: Option<f64>, default| value.unwrap_or(default) / CM_PER_INCH;
    capture(
        &webview,
        "Page.printToPDF",
        json!({
            "landscape": options.orientation.as_deref() == Some("landscape"),
            "scale": options.scale.unwrap_or(1.0),
            "printBackground": options.background.unwrap_or(false),
            "paperWidth": inches(options.page_width, 21.0),
            "paperHeight": inches(options.page_height, 29.7),
            "marginTop": inches(options.margin_top, 1.0),
            "marginBottom": inches(options.margin_bottom, 1.0),
            "marginLeft": inches(options.margin_left, 1.0),
            "marginRight": inches(options.margin_right, 1.0),
            "preferCSSPageSize": options.shrink_to_fit == Some(false),
            "pageRanges": options.page_ranges.as_deref().unwrap_or_default().join(","),
        }),
        timeout_ms,
    )
    .await
}

async fn capture(
    webview: &Webview,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> Result<String, WebDriverErrorResponse> {
    let reply = call_devtools(webview, method, params, Duration::from_millis(timeout_ms))
        .await
        .map_err(WebDriverErrorResponse::unknown_error)?;
    reply
        .get("data")
        .and_then(Value::as_str)
        .filter(|data| !data.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| WebDriverErrorResponse::unknown_error(format!("{method}: missing data")))
}
