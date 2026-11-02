//! Opt-in JSONL driver for the real ComputerUseTool, compiled only by devtools.
//! It narrows test scope; it does not grant or replace production authority.
use super::{
    ComputerUseHost, ComputerUseTool, DesktopComputerUseHost, StopOnExit, Tool, ToolResult,
    ToolUseContext, OWNER,
};
use base64::Engine;
use futures::FutureExt;
use openbitfun_core::agentic::tools::computer_use_host::AppInputAction;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy)]
struct Scope {
    pid: i32,
    window: Option<u64>,
}

fn normalize(mut input: Value, scope: Scope) -> Result<Value, String> {
    let object = input
        .as_object_mut()
        .ok_or("Probe input must be an object")?;
    let action = object
        .get("action")
        .and_then(Value::as_str)
        .ok_or("action is required")?
        .to_owned();
    if !matches!(
        action.as_str(),
        "start_control"
            | "stop_control"
            | "control_status"
            | "list_windows"
            | "get_app_state"
            | "get_app_shortcuts"
            | "describe_screen"
            | "screenshot"
            | "app_click"
            | "app_type_text"
            | "app_key_chord"
            | "app_scroll"
            | "app_drag"
            | "app_batch"
            | "app_wait_for"
    ) {
        return Err("PROBE_SCOPE_DENIED: Only target-scoped observation and app input are allowed; global input, activation, launch, clipboard and scripts are unavailable".into());
    }
    if object
        .get("mode")
        .is_some_and(|mode| mode.as_str() != Some("background"))
    {
        return Err("PROBE_SCOPE_DENIED: Only background mode is allowed".into());
    }
    if action == "start_control" {
        object.insert("mode".into(), json!("background"));
    }
    let mut selected_window = scope.window;
    if let Some(selector) = object.get("app") {
        let selector = selector
            .as_object()
            .ok_or("PROBE_SCOPE_DENIED: app must be a PID/window selector")?;
        if selector
            .keys()
            .any(|key| key != "pid" && key != "window_id")
            || selector
                .get("pid")
                .is_some_and(|pid| pid.as_i64() != Some(scope.pid as i64))
        {
            return Err("PROBE_SCOPE_DENIED: The process selected at startup cannot change".into());
        }
        if let Some(window) = selector.get("window_id") {
            let window = window
                .as_u64()
                .filter(|id| *id > 0 && *id <= u32::MAX as u64)
                .ok_or("PROBE_SCOPE_DENIED: window_id must be a positive macOS window ID")?;
            if scope.window.is_some_and(|allowed| allowed != window) {
                return Err(
                    "PROBE_SCOPE_DENIED: The window selected at startup cannot change".into(),
                );
            }
            selected_window = Some(window);
        }
    }
    let mut selector = json!({"pid":scope.pid});
    if let Some(window) = selected_window {
        selector["window_id"] = json!(window);
    }
    object.insert("app".into(), selector);
    // Even without a fixed startup window, observation must remain on the
    // selected/bound window rather than dump every document in that process.
    object.insert("focus_window_only".into(), json!(true));
    if action == "app_batch" {
        for step in object
            .get("steps")
            .and_then(Value::as_array)
            .ok_or("steps must be an array")?
        {
            // The production enum denies unknown fields and has no selector,
            // mode, activation or global-seat variant.
            let action: AppInputAction = serde_json::from_value(step.clone())
                .map_err(|error| format!("PROBE_SCOPE_DENIED: {error}"))?;
            action
                .validate()
                .map_err(|error| format!("PROBE_SCOPE_DENIED: {error}"))?;
        }
    }
    Ok(input)
}

fn write_json(value: &Value) -> Result<(), String> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, value).map_err(|error| error.to_string())?;
    writeln!(output)
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}

fn observation(results: Vec<ToolResult>, directory: Option<&PathBuf>, sequence: u64) -> Value {
    let mut contents = Vec::new();
    let mut images = Vec::new();
    for result in results {
        contents.push(result.content());
        if let ToolResult::Result {
            image_attachments: Some(attachments),
            ..
        } = result
        {
            for attachment in attachments {
                let mut image = json!({"mime_type":attachment.mime_type});
                let saved = directory.map(|directory| -> Result<PathBuf, String> {
                    let extension = match attachment.mime_type.as_str() {
                        "image/jpeg" => "jpg",
                        "image/png" => "png",
                        "image/webp" => "webp",
                        _ => return Err("Unsupported image MIME type".into()),
                    };
                    let path = directory.join(format!(
                        "probe-{}-{sequence}-{}.{}",
                        std::process::id(),
                        images.len(),
                        extension
                    ));
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&attachment.data_base64)
                        .map_err(|error| error.to_string())?;
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&path)
                        .map_err(|error| error.to_string())?;
                    file.write_all(&bytes).map_err(|error| error.to_string())?;
                    Ok(path)
                });
                match saved {
                    Some(Ok(path)) => image["path"] = json!(path),
                    other => {
                        image["data_base64"] = json!(attachment.data_base64);
                        if let Some(Err(error)) = other {
                            // Input may already have happened. A file-output
                            // problem must not masquerade as failed delivery.
                            image["save_error"] = json!(error);
                        }
                    }
                }
                images.push(image);
            }
        }
    }
    let failed = contents.iter().find(|body| {
        body.get("ok") == Some(&Value::Bool(false))
            || body.get("success") == Some(&Value::Bool(false))
    });
    let mut response = json!({"ok":failed.is_none(),"images":images});
    if let Some(body) = failed {
        response["error"] = body.get("error").cloned().unwrap_or_else(|| body.clone());
        response["input_may_have_been_submitted"] = json!(true);
    }
    let first = contents.first().cloned().unwrap_or(Value::Null);
    response["data"] = if first.get("ok") == Some(&Value::Bool(true)) && first.get("data").is_some()
    {
        first["data"].clone()
    } else {
        first
    };
    if contents.len() > 1 {
        response["results"] = json!(contents);
    }
    response
}

pub(super) async fn run() {
    if let Err(error) = run_inner().await {
        let _ = write_json(&json!({"event":"error","ok":false,"error":error}));
    }
}

async fn run_inner() -> Result<(), String> {
    let pid = std::env::var("OPENBITFUN_CUA_PROBE_PID")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
        .ok_or("OPENBITFUN_CUA_PROBE_PID must identify one explicit target process")?;
    let window = std::env::var("OPENBITFUN_CUA_PROBE_WINDOW_ID")
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .ok()
                .filter(|id| *id > 0 && *id <= u32::MAX as u64)
                .ok_or("Invalid OPENBITFUN_CUA_PROBE_WINDOW_ID")
        })
        .transpose()?;
    let seconds = std::env::var("OPENBITFUN_CUA_PROBE_TIMEOUT_SECS")
        .unwrap_or_else(|_| "600".into())
        .parse::<u64>()
        .ok()
        .filter(|seconds| (1..=1800).contains(seconds))
        .ok_or("OPENBITFUN_CUA_PROBE_TIMEOUT_SECS must be between 1 and 1800")?;
    let directory = std::env::var_os("OPENBITFUN_CUA_PROBE_OUTPUT_DIR").map(PathBuf::from);
    if let Some(directory) = &directory {
        if !directory.is_absolute() {
            return Err("OPENBITFUN_CUA_PROBE_OUTPUT_DIR must be absolute".into());
        }
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    let scope = Scope { pid, window };
    let identity = openbitfun_computer_use::test_support::ProcessIdentity::read(pid)?;
    let host = Arc::new(DesktopComputerUseHost::new());
    let mut context = ToolUseContext::for_tool_listing(None, None);
    context.session_id = Some(OWNER.into());
    context.computer_use_host = Some(host.clone());
    context.primary_model_facts.supports_image_inputs = true;
    context.primary_model_facts.api_format = "anthropic".into();
    let tool = ComputerUseTool::new();
    let _cleanup = StopOnExit;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if sender
                .blocking_send(line.map_err(|error| error.to_string()))
                .is_err()
            {
                break;
            }
        }
    });
    write_json(
        &json!({"event":"ready","pid":pid,"window_id":window,"mode":"background","timeout_seconds":seconds}),
    )?;
    let mut sequence = 0u64;
    let reason = loop {
        let line = match tokio::time::timeout_at(deadline, receiver.recv()).await {
            Ok(Some(line)) => line,
            Ok(None) => break "eof",
            Err(_) => break "deadline",
        };
        sequence += 1;
        let started = std::time::Instant::now();
        let parsed = line.and_then(|line| {
            serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())
        });
        let id = parsed
            .as_ref()
            .ok()
            .and_then(|request| request.get("id"))
            .cloned()
            .unwrap_or_else(|| json!(sequence));
        let input = parsed
            .and_then(|request| normalize(request.get("input").cloned().unwrap_or(request), scope));
        let action = input
            .as_ref()
            .ok()
            .and_then(|input| input.get("action"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut response = match input.and_then(|input| identity.validate().map(|_| input)) {
            Err(error) => json!({"ok":false,"error":error,"input_may_have_been_submitted":false}),
            Ok(input) => {
                let call =
                    std::panic::AssertUnwindSafe(tool.call_impl(&input, &context)).catch_unwind();
                match tokio::time::timeout_at(deadline, call).await {
                    Ok(Ok(Ok(results))) => observation(results, directory.as_ref(), sequence),
                    Ok(Ok(Err(error))) => {
                        json!({"ok":false,"error":error.to_string(),"input_may_have_been_submitted":true})
                    }
                    Ok(Err(_)) => {
                        let _ = host.stop_control(OWNER).await;
                        json!({"ok":false,"error":"PROBE_TOOL_PANIC: Control revoked; observe before deciding whether any input is needed","input_may_have_been_submitted":true})
                    }
                    Err(_) => {
                        write_json(
                            &json!({"id":id,"ok":false,"action":action,"elapsed_ms":started.elapsed().as_millis(),"input_may_have_been_submitted":true,"error":"PROBE_DEADLINE: Control cancelled; any already submitted input must not be repeated without observation"}),
                        )?;
                        break "deadline";
                    }
                }
            }
        };
        response["id"] = id;
        response["action"] = action;
        response["elapsed_ms"] = json!(started.elapsed().as_millis());
        write_json(&response)?;
    };
    let stopped = host
        .stop_control(OWNER)
        .await
        .map_err(|error| error.to_string())?;
    write_json(&json!({"event":"stopped","reason":reason,"state":stopped.state}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_enforces_startup_process_window_and_background_scope() {
        let scope = Scope {
            pid: 42,
            window: Some(17),
        };
        for input in [
            json!({"action":"click"}),
            json!({"action":"activate_app"}),
            json!({"action":"start_control","mode":"foreground"}),
            json!({"action":"get_app_state","app":{"pid":43}}),
            json!({"action":"app_click","app":{"pid":42,"window_id":18}}),
            json!({"action":"get_app_state","app":{"bundle_id":"untrusted"}}),
            json!({"action":"app_batch","steps":[{"action":"app_key_chord","keys":["return"],"app":{"pid":43}}]}),
        ] {
            assert!(normalize(input, scope).is_err());
        }
        let read = normalize(
            json!({"action":"get_app_state","focus_window_only":false}),
            scope,
        )
        .unwrap();
        assert_eq!(read["app"], json!({"pid":42,"window_id":17}));
        assert_eq!(read["focus_window_only"], true);
        assert_eq!(
            normalize(json!({"action":"start_control"}), scope).unwrap()["mode"],
            "background"
        );
    }
    #[test]
    fn probe_without_fixed_window_allows_same_process_window_reselection() {
        let scope = Scope {
            pid: 42,
            window: None,
        };
        let read = normalize(json!({"action":"list_windows"}), scope).unwrap();
        assert_eq!(read["app"], json!({"pid":42}));
        let read = normalize(
            json!({"action":"get_app_state","app":{"window_id":19}}),
            scope,
        )
        .unwrap();
        assert_eq!(read["app"], json!({"pid":42,"window_id":19}));
    }
}
