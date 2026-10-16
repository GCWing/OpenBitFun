use crate::string;
use openbitfun_miniapp_ipc::{self as ipc, launcher};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub(crate) struct ShellState {
    record: launcher::LaunchRecord,
    nonce: String,
    connection: tokio::sync::Mutex<Option<Connection>>,
}
#[derive(Clone)]
struct Connection {
    endpoint: ipc::Endpoint,
    instance_id: String,
    view_id: String,
}

async fn endpoint(record: &launcher::LaunchRecord) -> Result<ipc::Endpoint, String> {
    let path = ipc::endpoint_path(&record.data_dir);
    async fn read(path: &std::path::Path) -> Result<ipc::Endpoint, String> {
        let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        let endpoint: ipc::Endpoint = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            ipc::call(&endpoint, "ping", Value::Null),
        )
        .await
        .map_err(|_| "MiniApp host did not respond")??;
        Ok(endpoint)
    }
    if let Ok(endpoint) = read(&path).await {
        return Ok(endpoint);
    }
    let mut child =
        openbitfun_services_core::process_manager::create_command(&record.host_executable);
    child
        .arg("--miniapp-background")
        .env("OPENBITFUN_USER_ROOT", &record.user_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut process = child.spawn().map_err(|e| {
        format!(
            "Could not start OpenBitFun at {}: {e}",
            record.host_executable.display()
        )
    })?;
    // A detached native reaper does not keep the shell's Tokio runtime alive.
    std::thread::spawn(move || {
        let _ = process.wait();
    });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        if let Ok(endpoint) = read(&path).await {
            return Ok(endpoint);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "OpenBitFun did not become ready. Open the host application and retry.".into(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellRequest {
    operation: String,
    #[serde(default)]
    params: Value,
}

async fn host_call(state: &ShellState, method: &str, mut params: Value) -> Result<Value, String> {
    let connection = state
        .connection
        .lock()
        .await
        .clone()
        .ok_or("MiniApp host is not connected")?;
    if !params.is_object() {
        params = json!({});
    }
    params["instanceId"] = json!(connection.instance_id);
    params["viewId"] = json!(connection.view_id);
    params["nonce"] = json!(state.nonce);
    ipc::call(&connection.endpoint, method, params).await
}

#[tauri::command]
pub(crate) async fn miniapp_shell_call(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ShellState>,
    request: ShellRequest,
) -> Result<Value, String> {
    if window.label() != "miniapp-shell" {
        return Err("MiniApp Shell command is unavailable on this surface".into());
    }
    let params = request.params;
    match request.operation.as_str() {
        "bootstrap" => {
            let endpoint = endpoint(&state.record).await?;
            let value = ipc::call(
                &endpoint,
                "open",
                json!({"launchId":state.record.launch_id,"nonce":state.nonce,"shellCapabilities":[ipc::MINIAPP_CUSTOM_CHROME_CAPABILITY,ipc::MINIAPP_CHAT_SNAPSHOT_CAPABILITY]}),
            )
            .await?;
            if value["reused"] == true {
                app.exit(0);
                return Ok(value);
            }
            let instance_id = string(&value["instance"], "instanceId")?;
            let view_id = string(&value["view"], "viewId")?;
            *state.connection.lock().await = Some(Connection {
                endpoint,
                instance_id,
                view_id,
            });
            let title = value["app"]["chrome"]["titlebar"]["title"]
                .as_str()
                .or_else(|| {
                    value["app"]["i18n"]["locales"][value["locale"].as_str().unwrap_or("en-US")]
                        ["name"]
                        .as_str()
                })
                .or_else(|| value["app"]["name"].as_str())
                .unwrap_or(&state.record.name);
            window.set_title(title).map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            Ok(value)
        }
        "ready" | "tab" | "poll" | "permissions" | "chatSnapshot" => {
            host_call(&state, &request.operation, params).await
        }
        "close" => {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                host_call(&state, "close", json!({})),
            )
            .await;
            app.exit(0);
            Ok(Value::Null)
        }
        "windowState" => window_state(&window),
        #[cfg(target_os = "macos")]
        "titlebarDoubleClick" => {
            crate::window_chrome::double_click(&window).await?;
            window_state(&window)
        }
        "drag" => {
            window.start_dragging().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "resize" => {
            let direction = serde_json::from_value(params["direction"].clone())
                .map_err(|error| format!("Unsupported MiniApp resize direction: {error}"))?;
            window
                .as_ref()
                .window()
                .start_resize_dragging(direction)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "minimize" => {
            window.minimize().map_err(|e| e.to_string())?;
            window_state(&window)
        }
        "maximize" => {
            if window.is_fullscreen().map_err(|e| e.to_string())? {
                window.set_fullscreen(false).map_err(|e| e.to_string())?;
            } else {
                if window.is_maximized().map_err(|e| e.to_string())? {
                    window.unmaximize().map_err(|e| e.to_string())?;
                } else {
                    window.maximize().map_err(|e| e.to_string())?;
                }
            }
            window_state(&window)
        }
        "fullscreen" => {
            window
                .set_fullscreen(!window.is_fullscreen().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            window_state(&window)
        }
        "focus" => {
            window.show().map_err(|e| e.to_string())?;
            window.unminimize().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "rpc" => {
            let method = string(&params, "method")?;
            // Private host adapters cannot be requested by MiniApp content.
            if matches!(method.as_str(), "grantSelectedPath" | "authorizeLocal") {
                return Err("Private MiniApp host operation".into());
            }
            host_call(&state, "rpc", params).await
        }
        "local" => {
            let method = string(&params, "method")?;
            let args = params.get("params").cloned().unwrap_or(json!({}));
            host_call(
                &state,
                "rpc",
                json!({"method":"authorizeLocal","params":{"action":method,"sessionId":args.get("sessionId")}}),
            )
            .await?;
            match method.as_str() {
                "dialog.open" | "dialog.save" => {
                    let mut builder = app.dialog().file();
                    if let Some(title) = args["title"].as_str() {
                        builder = builder.set_title(title);
                    }
                    if let Some(path) = args["defaultPath"].as_str() {
                        let path = std::path::Path::new(path);
                        if path.is_dir() {
                            builder = builder.set_directory(path);
                        } else {
                            if let Some(parent) = path.parent() {
                                builder = builder.set_directory(parent);
                            }
                            if let Some(name) = path.file_name() {
                                builder = builder.set_file_name(name.to_string_lossy());
                            }
                        }
                    }
                    if let Some(filters) = args["filters"].as_array() {
                        for filter in filters {
                            let extensions: Vec<_> = filter["extensions"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(Value::as_str)
                                .collect();
                            builder = builder.add_filter(
                                filter["name"].as_str().unwrap_or("Files"),
                                &extensions,
                            );
                        }
                    }
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let multiple = args["multiple"] == true;
                    let directory = args["directory"] == true;
                    if method == "dialog.save" {
                        builder.save_file(move |path| {
                            let _ = tx.send(path.map(|path| vec![path]));
                        });
                    } else if multiple && directory {
                        builder.pick_folders(move |paths| {
                            let _ = tx.send(paths);
                        });
                    } else if multiple {
                        builder.pick_files(move |paths| {
                            let _ = tx.send(paths);
                        });
                    } else if directory {
                        builder.pick_folder(move |path| {
                            let _ = tx.send(path.map(|path| vec![path]));
                        });
                    } else {
                        builder.pick_file(move |path| {
                            let _ = tx.send(path.map(|path| vec![path]));
                        });
                    }
                    let Some(paths) = rx.await.map_err(|e| e.to_string())? else {
                        return Ok(Value::Null);
                    };
                    let paths: Vec<_> = paths
                        .into_iter()
                        .map(|path| {
                            path.into_path()
                                .map(|path| path.to_string_lossy().into_owned())
                                .map_err(|e| e.to_string())
                        })
                        .collect::<Result<_, _>>()?;
                    for path in &paths {
                        host_call(
                            &state,
                            "rpc",
                            json!({"method":"grantSelectedPath","params":{"path":path}}),
                        )
                        .await?;
                    }
                    if multiple {
                        Ok(json!(paths))
                    } else {
                        Ok(json!(paths.first()))
                    }
                }
                "dialog.message" => {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    app.dialog()
                        .message(args["message"].as_str().unwrap_or(""))
                        .title(args["title"].as_str().unwrap_or(&state.record.name))
                        .show(move |answer| {
                            let _ = tx.send(answer);
                        });
                    Ok(json!(rx.await.map_err(|e| e.to_string())?))
                }
                "system.openExternal" => {
                    let url = string(&args, "url")?;
                    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
                    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
                        return Err("Unsupported external URL scheme".into());
                    }
                    app.opener()
                        .open_url(url, None::<String>)
                        .map_err(|e| e.to_string())?;
                    Ok(Value::Null)
                }
                "system.revealInFolder" => {
                    app.opener()
                        .reveal_item_in_dir(string(&args, "path")?)
                        .map_err(|e| e.to_string())?;
                    Ok(Value::Null)
                }
                "notifications.system" => {
                    use tauri_plugin_notification::NotificationExt;
                    app.notification()
                        .builder()
                        .title(string(&args, "title")?)
                        .body(args["body"].as_str().unwrap_or(""))
                        .show()
                        .map_err(|e| e.to_string())?;
                    Ok(Value::Null)
                }
                // The browser owns clipboard/composer presentation after native permission validation.
                "clipboard.readText"
                | "clipboard.writeText"
                | "chat.claimComposer"
                | "chat.focusSession" => Ok(Value::Null),
                _ => Err("Unsupported MiniApp local adapter".into()),
            }
        }
        _ => Err("Unsupported MiniApp Shell operation".into()),
    }
}

fn window_state(window: &tauri::WebviewWindow) -> Result<Value, String> {
    Ok(json!({
        "maximized": window.is_maximized().map_err(|e| e.to_string())?,
        "fullscreen": window.is_fullscreen().map_err(|e| e.to_string())?,
    }))
}

pub(crate) async fn run(path: PathBuf) {
    let record = match launcher::read_record(&path) {
        Ok(record) => record,
        Err(error) => {
            crate::show_fatal_startup_error(&format!("MiniApp launcher failed: {error}"));
            return;
        }
    };
    // The private record is refreshed by host upgrades and app title changes;
    // the bundle's embedded record remains a stable bootstrap pointer.
    let central_path = launcher::launch_path(&record);
    let record = if central_path != path && central_path.is_file() {
        match launcher::read_record(&central_path) {
            Ok(current) if current.launch_id == record.launch_id => current,
            _ => {
                crate::show_fatal_startup_error(
                    "MiniApp launch record is incompatible. Recreate the system app in OpenBitFun.",
                );
                return;
            }
        }
    } else {
        record
    };
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.openbitfun.miniapp.{}", record.launch_id);
    context.config_mut().product_name = Some(record.name.clone());
    context.package_info_mut().name = record.name.clone();
    #[cfg(target_os = "linux")]
    {
        context.config_mut().app.enable_gtk_app_id = true;
    }
    #[cfg(target_os = "windows")]
    // SAFETY: set the process identity before creating any native windows.
    unsafe {
        if let Err(error) = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            &windows::core::HSTRING::from(context.config().identifier.as_str()),
        ) {
            eprintln!("MiniApp application identity failed: {error}");
            return;
        }
    }
    let title = record.name.clone();
    // Window/taskbar icons use the app's own resource. macOS Dock identity is
    // owned by the signed bundle's ICNS, with no Tauri development override.
    let icon = image::open(central_path.with_file_name("icon-256.png"))
        .or_else(|_| image::open(path.with_file_name("icon-256.png")))
        .map(|image| image.to_rgba8());
    context.set_default_window_icon(icon.ok().map(|icon| {
        let (width, height) = icon.dimensions();
        tauri::image::Image::new_owned(icon.into_raw(), width, height)
    }));
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ShellState {
            record,
            nonce: uuid::Uuid::new_v4().to_string(),
            connection: tokio::sync::Mutex::new(None),
        })
        .register_uri_scheme_protocol("openbitfun-miniapp", |_, request| {
            let (mime, body): (&str, Vec<u8>) = match request.uri().path() {
                "/titlebar.js" => (
                    "text/javascript",
                    include_bytes!("../../../shared/miniapp-chrome/titlebar.js").to_vec(),
                ),
                "/miniapp-chat.js" => (
                    "text/javascript",
                    include_bytes!("miniapp-chat.js").to_vec(),
                ),
                "/generated/chat-style-classes.js" => (
                    "text/javascript",
                    include_bytes!("generated/chat-style-classes.js").to_vec(),
                ),
                "/chat-styles.css" => (
                    "text/css",
                    include_bytes!("generated/chat-styles.css").to_vec(),
                ),
                "/chat-labels.json" => (
                    "application/json",
                    include_bytes!("chat-labels.json").to_vec(),
                ),
                "/titlebar.css" => (
                    "text/css",
                    include_bytes!("../../../shared/miniapp-chrome/titlebar.css").to_vec(),
                ),
                "/window-controls.css" => (
                    "text/css",
                    include_bytes!("../../../shared/miniapp-chrome/window-controls.css").to_vec(),
                ),
                "/labels.json" => (
                    "application/json",
                    include_bytes!("../../../shared/miniapp-chrome/labels.generated.json").to_vec(),
                ),
                "/icons.json" => (
                    "application/json",
                    include_bytes!("../../../shared/miniapp-chrome/icons.generated.json").to_vec(),
                ),
                "/appearance.css" => (
                    "text/css",
                    include_bytes!("../../../shared/miniapp-chrome/generated/theme.css").to_vec(),
                ),
                _ => (
                    "text/html; charset=utf-8",
                    include_bytes!("shell.html").to_vec(),
                ),
            };
            tauri::http::Response::builder()
                .header("Content-Type", mime)
                .body(body)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![miniapp_shell_call])
        .setup(move |app| {
            let config = crate::window_chrome::config();
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .title(&title)
                .initialization_script(format!(
                    "Object.defineProperty(window, '__MINIAPP_PLATFORM__', {{ value: '{}' }});",
                    std::env::consts::OS,
                ))
                .resizable(true)
                .visible(false)
                .inner_size(1050.0, 760.0)
                .min_inner_size(480.0, 360.0)
                .disable_drag_drop_handler()
                .build()?;
            // Native heartbeats survive hidden/minimized WebView timer suspension.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    let state = handle.state::<ShellState>();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        host_call(&state, "heartbeat", json!({})),
                    )
                    .await;
                }
            });
            Ok(())
        })
        .build(context);
    match result {
        Ok(app) => app.run(|handle, event| {
            let close_requested = match event {
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    api.prevent_close();
                    true
                }
                tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } => {
                    // Dock/menu Quit has the same lifetime effect as closing
                    // the window. Our final app.exit(0) must pass through.
                    api.prevent_exit();
                    true
                }
                _ => false,
            };
            if close_requested {
                let handle = handle.clone();
                // Do not block the native event loop or nest Tokio block_on.
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<ShellState>();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(1),
                        host_call(&state, "close", json!({})),
                    )
                    .await;
                    handle.exit(0);
                });
            }
        }),
        Err(error) => eprintln!("MiniApp window failed: {error}"),
    }
}
