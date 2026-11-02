use serde::Deserialize;

const MAX_BROWSER_DROP_FILES: usize = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveBrowserDroppedFilePathsRequest {
    token: String,
    file_count: usize,
}

fn validate_request(request: &ResolveBrowserDroppedFilePathsRequest) -> Result<(), String> {
    if request.token.is_empty()
        || request.token.len() > 128
        || !request
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid browser drop token".to_string());
    }
    if request.file_count == 0 || request.file_count > MAX_BROWSER_DROP_FILES {
        return Err(format!(
            "Browser drop file count must be between 1 and {MAX_BROWSER_DROP_FILES}"
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod windows {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use serde_json::{json, Value};
    use tokio::sync::oneshot;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    use super::ResolveBrowserDroppedFilePathsRequest;

    const DEVTOOLS_CALL_TIMEOUT: Duration = Duration::from_secs(5);
    const BROWSER_DROP_REGISTRY_KEY: &str = "__OPENBITFUN_BROWSER_DROP_FILES__";

    type DevToolsResult = Result<String, String>;
    type DevToolsResultSlot = Arc<Mutex<Option<oneshot::Sender<DevToolsResult>>>>;

    fn send_devtools_result(slot: &DevToolsResultSlot, result: DevToolsResult) {
        let Ok(mut sender) = slot.lock() else {
            return;
        };
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }

    async fn call_devtools_protocol_method(
        webview: &tauri::Webview,
        method: &str,
        parameters: Value,
    ) -> Result<Value, String> {
        let parameters = serde_json::to_string(&parameters)
            .map_err(|error| format!("Failed to serialize WebView2 parameters: {error}"))?;
        let method = method.to_string();
        let scheduled_method = method.clone();
        let (sender, receiver) = oneshot::channel();
        let result_slot = Arc::new(Mutex::new(Some(sender)));
        let scheduled_result_slot = Arc::clone(&result_slot);

        webview
            .with_webview(move |platform_webview| unsafe {
                let webview2 = match platform_webview.controller().CoreWebView2() {
                    Ok(webview2) => webview2,
                    Err(error) => {
                        send_devtools_result(
                            &scheduled_result_slot,
                            Err(format!("Failed to access WebView2: {error}")),
                        );
                        return;
                    }
                };

                let callback_result_slot = Arc::clone(&scheduled_result_slot);
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, result_json| {
                        let result = status
                            .map(|()| result_json)
                            .map_err(|error| format!("WebView2 DevTools call failed: {error}"));
                        send_devtools_result(&callback_result_slot, result);
                        Ok(())
                    },
                ));
                let method = HSTRING::from(scheduled_method);
                let parameters = HSTRING::from(parameters);
                if let Err(error) =
                    webview2.CallDevToolsProtocolMethod(&method, &parameters, &callback)
                {
                    send_devtools_result(
                        &scheduled_result_slot,
                        Err(format!("Failed to start WebView2 DevTools call: {error}")),
                    );
                }
            })
            .map_err(|error| format!("Failed to schedule WebView2 DevTools call: {error}"))?;

        let result_json = tokio::time::timeout(DEVTOOLS_CALL_TIMEOUT, receiver)
            .await
            .map_err(|_| format!("WebView2 DevTools call timed out: {method}"))?
            .map_err(|_| format!("WebView2 DevTools response channel closed: {method}"))??;

        serde_json::from_str(&result_json).map_err(|error| {
            format!("WebView2 DevTools returned invalid JSON for {method}: {error}")
        })
    }

    fn runtime_object_id(response: &Value, index: usize) -> Result<&str, String> {
        if let Some(exception) = response.get("exceptionDetails") {
            return Err(format!(
                "WebView2 could not access dropped file {index}: {exception}"
            ));
        }
        response
            .pointer("/result/objectId")
            .and_then(Value::as_str)
            .filter(|object_id| !object_id.is_empty())
            .ok_or_else(|| format!("WebView2 did not return dropped file {index}"))
    }

    fn dropped_file_path(response: &Value, index: usize) -> Result<String, String> {
        response
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("WebView2 did not expose a path for dropped file {index}"))
    }

    pub(super) async fn resolve(
        webview: &tauri::Webview,
        request: &ResolveBrowserDroppedFilePathsRequest,
    ) -> Result<Vec<String>, String> {
        let object_group = format!("openbitfun-browser-drop-{}", request.token);
        let token = serde_json::to_string(&request.token)
            .map_err(|error| format!("Failed to encode browser drop token: {error}"))?;

        let resolution = async {
            let mut paths = Vec::with_capacity(request.file_count);
            for index in 0..request.file_count {
                let expression =
                    format!("globalThis.{BROWSER_DROP_REGISTRY_KEY}?.get({token})?.[{index}]");
                let evaluated = call_devtools_protocol_method(
                    webview,
                    "Runtime.evaluate",
                    json!({
                        "expression": expression,
                        "objectGroup": object_group,
                        "returnByValue": false,
                        "silent": true,
                    }),
                )
                .await?;
                let object_id = runtime_object_id(&evaluated, index)?;
                let file_info = call_devtools_protocol_method(
                    webview,
                    "DOM.getFileInfo",
                    json!({ "objectId": object_id }),
                )
                .await?;
                paths.push(dropped_file_path(&file_info, index)?);
            }
            Ok(paths)
        }
        .await;

        if let Err(error) = call_devtools_protocol_method(
            webview,
            "Runtime.releaseObjectGroup",
            json!({ "objectGroup": object_group }),
        )
        .await
        {
            log::warn!("Failed to release browser drop object group: {error}");
        }

        resolution
    }

    #[cfg(test)]
    mod tests {
        use serde_json::json;

        use super::{dropped_file_path, runtime_object_id};

        #[test]
        fn parses_runtime_file_object_id() {
            let response = json!({
                "result": {
                    "type": "object",
                    "subtype": "file",
                    "objectId": "123.4.5"
                }
            });

            assert_eq!(runtime_object_id(&response, 0).unwrap(), "123.4.5");
        }

        #[test]
        fn rejects_runtime_results_without_a_file_object() {
            let response = json!({ "result": { "type": "undefined" } });

            assert!(runtime_object_id(&response, 2)
                .unwrap_err()
                .contains("dropped file 2"));
        }

        #[test]
        fn parses_non_empty_dropped_file_path() {
            let response = json!({ "path": "C:\\drop\\report.pdf" });

            assert_eq!(
                dropped_file_path(&response, 0).unwrap(),
                "C:\\drop\\report.pdf"
            );
        }
    }
}

#[tauri::command]
pub async fn resolve_browser_dropped_file_paths(
    webview: tauri::Webview,
    request: ResolveBrowserDroppedFilePathsRequest,
) -> Result<Vec<String>, String> {
    validate_request(&request)?;
    if webview.label() != "main" {
        return Err("Browser-dropped file paths can only be resolved for the main window".into());
    }

    #[cfg(target_os = "windows")]
    {
        windows::resolve(&webview, &request).await
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = webview;
        Err("Browser-dropped file path resolution is only available on Windows Desktop".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_request, ResolveBrowserDroppedFilePathsRequest};

    #[test]
    fn validates_browser_drop_request_bounds() {
        assert!(validate_request(&ResolveBrowserDroppedFilePathsRequest {
            token: "drop-token_1".into(),
            file_count: 1,
        })
        .is_ok());
        assert!(validate_request(&ResolveBrowserDroppedFilePathsRequest {
            token: "drop token".into(),
            file_count: 1,
        })
        .is_err());
        assert!(validate_request(&ResolveBrowserDroppedFilePathsRequest {
            token: "drop-token".into(),
            file_count: 0,
        })
        .is_err());
    }
}
