use std::sync::Arc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_foundation::{ns_string, NSDictionary, NSError, NSString};
use objc2_web_kit::{WKContentWorld, WKWebView};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::runtime::script;
use crate::runtime::{BridgeError, BridgeResponse};
use crate::server::response::WebDriverErrorResponse;

pub(super) async fn evaluate_script<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    timeout_ms: u64,
    script: &str,
    args: &[Value],
    async_mode: bool,
    frame_context: &Value,
) -> Result<Value, WebDriverErrorResponse> {
    let user_script = script.to_owned();
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
    let frame_context_json = serde_json::to_string(frame_context).unwrap_or_else(|_| "[]".into());
    let (sender, receiver) = oneshot::channel::<Result<String, String>>();

    // SAFETY: Tauri runs this callback on the main thread with a live platform
    // webview, so the pointer is valid for the call and
    // `MainThreadMarker::new_unchecked` states a fact the runtime upholds. On
    // macOS that webview is always WKWebView-backed, making the cast sound.
    let result = webview.with_webview(move |platform_webview| unsafe {
        let wk_webview: &WKWebView = &*platform_webview.inner().cast();
        let ns_script = NSString::from_str(script::native_eval_script());
        let mtm = MainThreadMarker::new_unchecked();
        let arguments: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
            &[
                ns_string!("openbitfunScript"),
                ns_string!("openbitfunArguments"),
                ns_string!("openbitfunAsync"),
                ns_string!("openbitfunFrameContext"),
            ],
            &[
                &NSString::from_str(&user_script),
                &NSString::from_str(&args_json),
                if async_mode {
                    ns_string!("true")
                } else {
                    ns_string!("false")
                },
                &NSString::from_str(&frame_context_json),
            ],
        );
        let content_world = WKContentWorld::pageWorld(mtm);

        let sender = Arc::new(std::sync::Mutex::new(Some(sender)));
        let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            let response = if !error.is_null() {
                Err((&*error).localizedDescription().to_string())
            } else if result.is_null() {
                Ok("null".to_string())
            } else {
                ns_object_to_string(&*result)
                    .ok_or_else(|| "Script returned a non-string payload".to_string())
            };

            if let Ok(mut guard) = sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(response);
                }
            }
        });

        wk_webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            &ns_script,
            Some(&arguments),
            None,
            &content_world,
            Some(&block),
        );
    });

    if let Err(error) = result {
        return Err(WebDriverErrorResponse::javascript_error(
            format!("Failed to evaluate script: {error}"),
            None,
        ));
    }

    let response_payload = tokio::time::timeout(Duration::from_millis(timeout_ms), receiver)
        .await
        .map_err(|_| {
            WebDriverErrorResponse::timeout(format!("Script timed out after {timeout_ms}ms"))
        })?
        .map_err(|_| {
            WebDriverErrorResponse::unknown_error("Script response channel closed unexpectedly")
        })?
        .map_err(|error| WebDriverErrorResponse::javascript_error(error, None))?;

    let response: BridgeResponse = serde_json::from_str(&response_payload).map_err(|error| {
        WebDriverErrorResponse::unknown_error(format!("Invalid native script response: {error}"))
    })?;

    if response.ok {
        return Ok(response.value.unwrap_or(Value::Null));
    }

    let error = response.error.unwrap_or(BridgeError {
        message: Some("Unknown JavaScript error".into()),
        stack: None,
    });
    Err(WebDriverErrorResponse::javascript_error(
        error
            .message
            .unwrap_or_else(|| "Unknown JavaScript error".into()),
        error.stack,
    ))
}

unsafe fn ns_object_to_string(obj: &AnyObject) -> Option<String> {
    let class_name = obj.class().name().to_str().unwrap_or("");
    if !class_name.contains("String") {
        return None;
    }

    // SAFETY: the class-name check above established that `obj` is an NSString,
    // and `NSString` is a transparent wrapper over `AnyObject`, so the reborrow
    // keeps `obj`'s lifetime and points at a live object.
    let ns_string: &NSString = unsafe { &*std::ptr::from_ref::<AnyObject>(obj).cast::<NSString>() };
    Some(ns_string.to_string())
}
