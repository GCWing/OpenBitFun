//! Desktop presentation adapter for the portable MiniApp instance owner.
//! The shell branch never initializes AppState, the Agent runtime, or the main UI.
mod chat;
mod ipc;
mod launcher;
mod sdk;
mod system_install;

use crate::api::{app_state::AppState, miniapp_api};
use openbitfun_product_domains::miniapp::instances::*;
use openbitfun_services_core::process_manager::create_command;
use openbitfun_services_integrations::miniapp::instances::MiniAppInstances;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Listener, Manager};

pub(crate) use openbitfun_miniapp_ipc::launcher::launch_manifest;

/// Old shortcuts may still target the Desktop executable.
/// Delegate them to the installed lightweight shell before starting any runtime.
pub(crate) fn run_shell(manifest: std::path::PathBuf) -> Result<(), String> {
    let record = launcher::read_record(&manifest)?;
    #[cfg(target_os = "macos")]
    create_command("/usr/bin/open")
        .arg("-n")
        .arg(launcher::runtime_bundle(&record)?)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    create_command(launcher::shell_executable(&record.host_executable)?)
        .arg("--miniapp-launch")
        .arg(manifest)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Retain the old Desktop command name for installed clients. Shell commands
/// are now implemented exclusively by the independent window executable.
pub(crate) fn miniapp_shell_call(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("MiniApp Shell command is unavailable on this surface".into())
}

/// Arbitrate before initializing the Agent runtime. OS locks are released on
/// crash; the identity is the product data directory, independent of protocol/app.
pub(crate) async fn claim_host(background: bool) -> Result<Option<std::fs::File>, String> {
    let paths =
        openbitfun_core::infrastructure::try_get_path_manager_arc().map_err(|e| e.to_string())?;
    let directory = paths.user_data_dir().join("miniapp-desktop");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let owner = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("host.lock"))
        .map_err(|e| e.to_string())?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(70);
    loop {
        match owner.try_lock() {
            Ok(()) => return Ok(Some(owner)),
            Err(std::fs::TryLockError::Error(error)) => return Err(error.to_string()),
            Err(std::fs::TryLockError::WouldBlock) => {}
        }
        if let Ok(bytes) = tokio::fs::read(ipc::endpoint_path(&paths.user_data_dir())).await {
            if let Ok(endpoint) = serde_json::from_slice::<ipc::Endpoint>(&bytes) {
                if endpoint.protocol_version != MINIAPP_PRESENTATION_PROTOCOL {
                    return Err("The running OpenBitFun host uses an incompatible MiniApp protocol. Restart the host before opening this version.".into());
                }
                if let Ok(Ok(_)) = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    ipc::call(
                        &endpoint,
                        if background { "ping" } else { "showMain" },
                        json!({}),
                    ),
                )
                .await
                {
                    return Ok(None);
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "The existing OpenBitFun host did not become ready; its data was left untouched"
                    .into(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[derive(Default)]
pub(crate) struct DesktopMiniApps {
    pub instances: MiniAppInstances,
    shells: Mutex<HashMap<String, ShellLease>>,
    sessions: Mutex<HashMap<String, HashSet<String>>>,
    confirmed_transfers: Mutex<HashSet<String>>,
    launches: tokio::sync::Mutex<()>,
    operations: Mutex<HashMap<String, Arc<tokio::sync::RwLock<()>>>>,
    endpoint: Mutex<Option<ipc::Endpoint>>,
    socket_dir: Mutex<Option<tempfile::TempDir>>,
    worker_listeners: Mutex<HashSet<String>>,
}

impl DesktopMiniApps {
    fn operation_gate(&self, instance_id: &str) -> Arc<tokio::sync::RwLock<()>> {
        self.operations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(instance_id.to_owned())
            .or_default()
            .clone()
    }
}

struct ShellLease {
    instance_id: String,
    nonce: String,
    streams: HashSet<String>,
    events: VecDeque<Value>,
    sequence: u64,
    event_bytes: usize,
}

impl ShellLease {
    fn push(&mut self, event: &str, payload: Value) {
        self.sequence += 1;
        let item = json!({"sequence":self.sequence,"event":event,"payload":payload});
        self.event_bytes += item.to_string().len();
        self.events.push_back(item);
        while self.events.len() > 1024 || self.event_bytes > 4 * 1024 * 1024 {
            if let Some(item) = self.events.pop_front() {
                self.event_bytes = self.event_bytes.saturating_sub(item.to_string().len());
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "operation"
)]
pub(crate) enum PresentationRequest {
    Snapshot,
    ContentAction {
        request: MiniAppContentActionRequest,
    },
    Open {
        app_id: String,
        #[serde(default)]
        workspace_path: Option<String>,
        kind: MiniAppViewKind,
        #[serde(default)]
        icon_svg: Option<String>,
    },
    Install {
        app_id: String,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        icon_svg: Option<String>,
    },
    Installation {
        app_id: String,
    },
    Uninstall {
        app_id: String,
    },
    Ready {
        instance_id: String,
        view_id: String,
    },
    Heartbeat {
        instance_id: String,
        view_id: String,
    },
    Detach {
        instance_id: String,
        view_id: String,
    },
    Stop {
        instance_id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    instance: MiniAppInstance,
    view: MiniAppView,
}

fn changed(app: &tauri::AppHandle) {
    let snapshot = app.state::<DesktopMiniApps>().instances.snapshot();
    let _ = app.emit_to("main", "miniapp-instances-changed", snapshot);
}

async fn local_workspace(
    app: &tauri::AppHandle,
    path: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(path) = path.filter(|path| !path.is_empty()) {
        let state = app.state::<AppState>();
        let target =
            crate::api::path_target::resolve_desktop_path_target(&state, &path, None, None).await?;
        let local = target
            .as_local_path()
            .ok_or("Independent MiniApp presentation does not yet support remote workspaces")?;
        return std::fs::canonicalize(local)
            .map(|path| Some(path.to_string_lossy().into_owned()))
            .map_err(|e| e.to_string());
    }
    Ok(None)
}

async fn record(
    app: &tauri::AppHandle,
    app_id: &str,
    workspace_path: Option<String>,
) -> Result<launcher::LaunchRecord, String> {
    let state = app.state::<AppState>();
    let miniapp = state
        .miniapp_manager
        .get(app_id)
        .await
        .map_err(|e| e.to_string())?;
    let paths = state.miniapp_manager.path_manager();
    let root = paths.user_data_dir().join("miniapp-desktop/launchers");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("launch.json");
        if !path.is_file() {
            continue;
        }
        let mut existing = launcher::read_record(&path)?;
        if existing.app_id == app_id && existing.workspace_path == workspace_path {
            existing.host_executable = std::env::current_exe().map_err(|e| e.to_string())?;
            existing.name = miniapp.name;
            launcher::write_record(&existing)?;
            return Ok(existing);
        }
    }
    let record = launcher::LaunchRecord {
        protocol_version: 1,
        launch_id: uuid::Uuid::new_v4().to_string(),
        app_id: app_id.into(),
        workspace_path,
        data_dir: paths.user_data_dir(),
        user_root: paths.user_root_dir().to_path_buf(),
        host_executable: std::env::current_exe().map_err(|e| e.to_string())?,
        name: miniapp.name,
        extra: Default::default(),
    };
    launcher::write_record(&record)?;
    Ok(record)
}

async fn open_window(
    app: &tauri::AppHandle,
    record: launcher::LaunchRecord,
    icon_svg: Option<String>,
) -> Result<Ticket, String> {
    let icon_record = record.clone();
    tokio::task::spawn_blocking(move || launcher::prepare_icons(&icon_record, icon_svg.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    let host = app.state::<DesktopMiniApps>();
    let (instance, view) = host.instances.prepare(
        record.app_id.clone(),
        record.workspace_path.clone(),
        MiniAppViewKind::Window,
    )?;
    if let Some(lease) = host
        .shells
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(&view.view_id)
    {
        lease.push("focus", Value::Null);
        changed(app);
        return Ok(Ticket { instance, view });
    }
    // The main surface already asked before transferring an existing tab.
    if instance
        .primary_view
        .as_ref()
        .is_some_and(|view| view.kind == MiniAppViewKind::Tab)
    {
        host.confirmed_transfers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(view.view_id.clone());
    }
    let path = launcher::write_record(&record)?;
    #[cfg(target_os = "macos")]
    let spawn = {
        let native = tokio::task::spawn_blocking(move || launcher::runtime_bundle(&record))
            .await
            .map_err(|e| e.to_string())??;
        create_command("/usr/bin/open")
            .arg("-n")
            .arg(native)
            .spawn()
    };
    #[cfg(not(target_os = "macos"))]
    let spawn = create_command(launcher::shell_executable(&record.host_executable)?)
        .arg("--miniapp-launch")
        .arg(path)
        .spawn();
    let _ = path;
    let mut child = match spawn {
        Ok(child) => child,
        Err(error) => {
            let _ = host.instances.detach(&instance.instance_id, &view.view_id);
            return Err(error.to_string());
        }
    };
    // Reap launchers without making Tokio shutdown wait for an independent shell.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    changed(app);
    Ok(Ticket { instance, view })
}

pub(crate) async fn miniapp_presentation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: PresentationRequest,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("MiniApp presentation requires the main product surface".into());
    }
    presentation(&app, request).await
}

async fn presentation(
    app: &tauri::AppHandle,
    request: PresentationRequest,
) -> Result<Value, String> {
    let host = app.state::<DesktopMiniApps>();
    let result = match request {
        PresentationRequest::Snapshot => json!(host.instances.snapshot()),
        PresentationRequest::ContentAction { request } => {
            host.instances.get(&request.instance_id)?;
            return Err("MiniApp semantic content actions are not supported by this host".into());
        }
        PresentationRequest::Open {
            app_id,
            workspace_path,
            kind,
            icon_svg,
        } => {
            let workspace_path = local_workspace(app, workspace_path).await?;
            let _guard = host.launches.lock().await;
            let record = record(app, &app_id, workspace_path.clone()).await?;
            let ticket = if kind == MiniAppViewKind::Window {
                open_window(app, record, icon_svg).await?
            } else {
                let (instance, view) = host.instances.prepare(app_id, workspace_path, kind)?;
                Ticket { instance, view }
            };
            json!(ticket)
        }
        PresentationRequest::Install {
            app_id,
            workspace_path,
            icon_svg,
        } => {
            let workspace_path = local_workspace(app, workspace_path).await?;
            let _guard = host.launches.lock().await;
            let record = record(app, &app_id, workspace_path).await?;
            let path = tokio::task::spawn_blocking(move || {
                launcher::install(&record, icon_svg.as_deref())
            })
            .await
            .map_err(|e| e.to_string())??;
            json!({"path":path})
        }
        PresentationRequest::Installation { app_id } => {
            let _guard = host.launches.lock().await;
            let data_dir = app
                .state::<AppState>()
                .miniapp_manager
                .path_manager()
                .user_data_dir();
            let paths =
                tokio::task::spawn_blocking(move || system_install::status(&data_dir, &app_id))
                    .await
                    .map_err(|e| e.to_string())??;
            json!({"paths": paths})
        }
        PresentationRequest::Uninstall { app_id } => {
            let _guard = host.launches.lock().await;
            let data_dir = app
                .state::<AppState>()
                .miniapp_manager
                .path_manager()
                .user_data_dir();
            tokio::task::spawn_blocking(move || system_install::uninstall(&data_dir, &app_id))
                .await
                .map_err(|e| e.to_string())??;
            Value::Null
        }
        PresentationRequest::Ready {
            instance_id,
            view_id,
        } => {
            host.instances.ready(&instance_id, &view_id)?;
            Value::Null
        }
        PresentationRequest::Heartbeat {
            instance_id,
            view_id,
        } => json!(host.instances.touch(&instance_id, &view_id)?),
        PresentationRequest::Detach {
            instance_id,
            view_id,
        } => {
            close_view(app, &instance_id, &view_id).await?;
            json!(host.instances.snapshot())
        }
        PresentationRequest::Stop { instance_id } => {
            let _guard = host.launches.lock().await;
            stop_instance(app, &instance_id).await?;
            Value::Null
        }
    };
    changed(app);
    Ok(result)
}

/// Hold launches so a new view cannot attach between the last close
/// and cleanup. A late close from a transfer source cannot stop its destination.
async fn close_view(
    app: &tauri::AppHandle,
    instance_id: &str,
    view_id: &str,
) -> Result<(), String> {
    let host = app.state::<DesktopMiniApps>();
    let _guard = host.launches.lock().await;
    if host.instances.detach(instance_id, view_id).is_some() {
        stop_instance(app, instance_id).await?;
    }
    Ok(())
}

/// Serialize accepted shell starts before stopping their app-owned work. Tab
/// starts are drained by the explicit frontend close path before it detaches.
async fn stop_instance(app: &tauri::AppHandle, instance_id: &str) -> Result<(), String> {
    let host = app.state::<DesktopMiniApps>();
    let Ok(instance) = host.instances.get(instance_id) else {
        return Ok(());
    };
    let gate = host.operation_gate(instance_id);
    let _operations = gate.write().await;
    let miniapp = app
        .state::<AppState>()
        .miniapp_manager
        .get(&instance.app_id)
        .await
        .map_err(|e| e.to_string())?;
    if miniapp
        .permissions
        .agent
        .as_ref()
        .is_some_and(|permission| permission.enabled)
    {
        crate::api::miniapp_agent_api::miniapp_agent_cancel_stale_runs(
            app.state(),
            app.state(),
            crate::api::miniapp_agent_api::MiniAppAgentCancelStaleRunsRequest {
                app_id: instance.app_id.clone(),
            },
        )
        .await?;
    }
    miniapp_api::cancel_miniapp_streams(&instance.app_id);
    miniapp_api::miniapp_worker_stop(app.state(), instance.app_id).await?;
    host.sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(instance_id);
    host.instances.retire(instance_id);
    host.operations
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(instance_id);
    Ok(())
}

fn string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing MiniApp {key}"))
}

async fn dispatch(app: &tauri::AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let host = app.state::<DesktopMiniApps>();
    if method == "ping" {
        return Ok(json!({"hostEpoch":host.instances.snapshot().host_epoch}));
    }
    if method == "showMain" {
        crate::handle_secondary_launch(app);
        return Ok(Value::Null);
    }
    if method == "open" {
        let _guard = host.launches.lock().await;
        let launch_id = string(&params, "launchId")?;
        uuid::Uuid::parse_str(&launch_id).map_err(|_| "Invalid MiniApp launch identity")?;
        let path = app
            .state::<AppState>()
            .miniapp_manager
            .path_manager()
            .user_data_dir()
            .join("miniapp-desktop/launchers")
            .join(launch_id)
            .join("launch.json");
        let record = launcher::read_record(&path)?;
        if host
            .worker_listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(record.app_id.clone())
        {
            sdk::install_worker_events(app, &record.app_id);
        }
        let workspace = local_workspace(app, record.workspace_path.clone()).await?;
        let miniapp = miniapp_api::get_miniapp(
            app.state(),
            miniapp_api::GetMiniAppRequest {
                app_id: record.app_id.clone(),
                appearance_mode: Some(crate::appearance::AppearanceConfig::miniapp_mode().into()),
                workspace_path: workspace.clone(),
            },
        )
        .await?;
        if miniapp.compiled_html.trim().is_empty() {
            return Err("MiniApp document is empty; rebuild it in OpenBitFun".into());
        }
        let (instance, view) = host.instances.prepare(
            record.app_id.clone(),
            workspace.clone(),
            MiniAppViewKind::Window,
        )?;
        let nonce = string(&params, "nonce")?;
        {
            let mut shells = host.shells.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(existing) = shells.get_mut(&view.view_id) {
                if existing.nonce != nonce {
                    existing.push("focus", Value::Null);
                    return Ok(json!({"reused":true}));
                }
            } else {
                shells.insert(
                    view.view_id.clone(),
                    ShellLease {
                        instance_id: instance.instance_id.clone(),
                        nonce,
                        streams: HashSet::new(),
                        events: VecDeque::new(),
                        sequence: 0,
                        event_bytes: 0,
                    },
                );
            }
        }
        changed(app);
        let locale = crate::api::i18n_api::i18n_get_current_language(app.state()).await?;
        let catalog =
            include_str!("../../../../shared/miniapp-chrome/presentation-labels.generated.json");
        let catalog: Value = serde_json::from_str(catalog).map_err(|e| e.to_string())?;
        let shared_terms = match locale.as_str() {
            "zh-CN" => include_str!("../../../../shared/i18n/resources/shared/zh-CN/terms.json"),
            "zh-TW" => include_str!("../../../../shared/i18n/resources/shared/zh-TW/terms.json"),
            _ => include_str!("../../../../shared/i18n/resources/shared/en-US/terms.json"),
        };
        let shared_terms: Value = serde_json::from_str(shared_terms).map_err(|e| e.to_string())?;
        let mut ui = catalog.get(&locale).unwrap_or(&catalog["en-US"]).clone();
        for key in ["minimize", "maximize", "restore", "close"] {
            ui[key] = shared_terms["window"][key].clone();
        }

        let transfer_confirmed = host
            .confirmed_transfers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&view.view_id);
        return Ok(
            json!({"presentationCapabilities":[ipc::MINIAPP_CUSTOM_CHROME_CAPABILITY,ipc::MINIAPP_CHAT_SNAPSHOT_CAPABILITY],"transferConfirmed":transfer_confirmed,"instance":instance,"view":view,"app":miniapp,"hostEpoch":host.instances.snapshot().host_epoch,"locale":locale,"appearanceMode":crate::appearance::AppearanceConfig::miniapp_mode(),"ui":ui}),
        );
    }
    let instance_id = string(&params, "instanceId")?;
    let view_id = string(&params, "viewId")?;
    let nonce = string(&params, "nonce")?;
    {
        let shells = host.shells.lock().unwrap_or_else(|p| p.into_inner());
        let Some(lease) = shells.get(&view_id) else {
            return if method == "poll" {
                Ok(json!({"released":true}))
            } else {
                Err("MiniApp shell lease expired".into())
            };
        };
        if lease.nonce != nonce || lease.instance_id != instance_id {
            return Err("MiniApp shell identity mismatch".into());
        }
    }
    if method == "close" {
        close_view(app, &instance_id, &view_id).await?;
        host.shells
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&view_id);
        changed(app);
        return Ok(Value::Null);
    }
    if method == "poll" {
        let Ok(instance) = host.instances.get(&instance_id) else {
            return Ok(json!({"released":true}));
        };
        if !instance.accepts_view(&view_id) {
            return Ok(json!({"released":true}));
        }
        host.instances.touch(&instance_id, &view_id)?;
        let after = params.get("after").and_then(Value::as_u64).unwrap_or(0);
        let mut shells = host.shells.lock().unwrap_or_else(|p| p.into_inner());
        let lease = shells
            .get_mut(&view_id)
            .ok_or("MiniApp shell lease expired")?;
        let gap = lease
            .events
            .front()
            .and_then(|e| e["sequence"].as_u64())
            .is_some_and(|first| first > after + 1);
        let events: Vec<_> = lease
            .events
            .iter()
            .filter(|e| e["sequence"].as_u64().unwrap_or(0) > after)
            .cloned()
            .collect();
        return Ok(
            json!({"events":events,"cursor":lease.sequence,"resyncRequired":gap,"pendingView":instance.pending_view}),
        );
    }
    host.instances.touch(&instance_id, &view_id)?;
    match method {
        "heartbeat" => Ok(Value::Null),
        "ready" => {
            host.instances.ready(&instance_id, &view_id)?;
            changed(app);
            Ok(Value::Null)
        }
        "tab" => {
            let _guard = host.launches.lock().await;
            let instance = host.instances.touch(&instance_id, &view_id)?;
            let (instance, view) = host.instances.prepare(
                instance.app_id,
                instance.workspace_path,
                MiniAppViewKind::Tab,
            )?;
            crate::handle_secondary_launch(app);
            changed(app);
            Ok(json!(Ticket { instance, view }))
        }
        "permissions" => {
            let sessions = host
                .sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&instance_id)
                .cloned()
                .unwrap_or_default();
            let pending = crate::api::agentic_api::list_pending_permission_requests(app.state())?;
            let own: Vec<_> = pending
                .into_iter()
                .filter(|request| sessions.contains(&request.session_id))
                .collect();
            if let Some(request_id) = params.get("requestId").and_then(Value::as_str) {
                if !own.iter().any(|request| request.request_id == request_id) {
                    return Err("Permission request is not owned by this MiniApp instance".into());
                }
                let reply = string(&params, "reply")?;
                if !matches!(reply.as_str(), "once" | "reject") {
                    return Err("Unsupported MiniApp permission response".into());
                }
                crate::api::agentic_api::respond_permission(
                    app.state(),
                    serde_json::from_value(json!({"requestId":request_id,"reply":reply}))
                        .map_err(|e| e.to_string())?,
                )
                .await?;
            }
            Ok(json!(own))
        }
        "chatSnapshot" => {
            let gate = host.operation_gate(&instance_id);
            let _operation = gate.read().await;
            let instance = host.instances.touch(&instance_id, &view_id)?;
            chat::snapshot(app, &instance, &string(&params, "sessionId")?).await
        }
        "rpc" => {
            let gate = host.operation_gate(&instance_id);
            let _operation = gate.read().await;
            let instance = host.instances.touch(&instance_id, &view_id)?;
            sdk::call(
                app,
                &instance,
                &view_id,
                string(&params, "method")?,
                params.get("params").cloned().unwrap_or(json!({})),
            )
            .await
        }
        "contentAction" => {
            Err("MiniApp semantic content actions are not supported by this host".into())
        }
        _ => Err("Unsupported MiniApp shell operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_requests_use_the_public_camel_case_envelope() {
        let request: PresentationRequest = serde_json::from_value(
            json!({"operation":"open","appId":"notes","workspacePath":null,"kind":"window"}),
        )
        .unwrap();
        assert!(
            matches!(request, PresentationRequest::Open { app_id, icon_svg: None, .. } if app_id == "notes")
        );
        let request: PresentationRequest = serde_json::from_value(
            json!({"operation":"open","appId":"notes","kind":"window","iconSvg":"<svg/>"}),
        )
        .unwrap();
        assert!(
            matches!(request, PresentationRequest::Open { icon_svg: Some(svg), .. } if svg == "<svg/>")
        );
        let request: PresentationRequest =
            serde_json::from_value(json!({"operation":"ready","instanceId":"i","viewId":"v"}))
                .unwrap();
        assert!(matches!(request, PresentationRequest::Ready { view_id, .. } if view_id == "v"));
    }

    #[tokio::test]
    async fn worker_framework_storage_uses_host_owner_and_custom_handlers_still_win() {
        use openbitfun_product_domains::miniapp::runtime::{DetectedRuntime, RuntimeKind};
        use openbitfun_services_integrations::miniapp::worker::JsWorker;
        let output = openbitfun_services_core::process_manager::create_command("node")
            .arg("-p")
            .arg("process.execPath")
            .output()
            .expect("Node is required by the desktop development toolchain");
        assert!(output.status.success());
        let runtime = DetectedRuntime {
            kind: RuntimeKind::Node,
            path: String::from_utf8(output.stdout).unwrap().trim().into(),
            version: "test".into(),
        };
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("source")).unwrap();
        let worker_host = root.path().join("worker_host.cjs");
        std::fs::write(&worker_host, include_str!("../../resources/worker_host.js")).unwrap();
        let mut worker = JsWorker::spawn(
            &runtime,
            &worker_host,
            root.path(),
            "{}",
            "fixture".into(),
            None,
        )
        .await
        .unwrap();
        worker
            .call(
                "storage.set",
                json!({"key":"value","value":{"legacy":true}}),
                5000,
            )
            .await
            .unwrap();
        assert_eq!(
            worker
                .call("storage.get", json!({"key":"value"}), 5000)
                .await
                .unwrap(),
            json!({"legacy":true})
        );
        std::fs::write(root.path().join("storage.json"), "{corrupt").unwrap();
        assert!(worker
            .call("storage.set", json!({"key":"value","value":2}), 5000)
            .await
            .is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join("storage.json")).unwrap(),
            "{corrupt"
        );
        worker.kill().await;
        std::fs::write(
            root.path().join("source/worker.js"),
            "exports['storage.get'] = () => 'custom';",
        )
        .unwrap();
        let mut worker = JsWorker::spawn(
            &runtime,
            &worker_host,
            root.path(),
            "{}",
            "fixture".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            worker
                .call("storage.get", json!({"key":"value"}), 5000)
                .await
                .unwrap(),
            json!("custom")
        );
        worker.kill().await;
    }
}

async fn serve<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    app: tauri::AppHandle,
    mut stream: S,
    endpoint: ipc::Endpoint,
) {
    let request = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        ipc::read::<ipc::Request, _>(&mut stream),
    )
    .await;
    let response = match request {
        Ok(Ok(request)) if request.authorized(&endpoint) => {
            dispatch(&app, &request.method, request.params).await
        }
        _ => Err("MiniApp IPC authentication or protocol negotiation failed".into()),
    };
    let _ = ipc::write(&mut stream, &response).await;
}

pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let host = app.state::<DesktopMiniApps>();
    let dir = tempfile::Builder::new()
        .prefix("obf-miniapp-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(unix)]
    let address = dir.path().join("host.sock").to_string_lossy().into_owned();
    #[cfg(windows)]
    let address = format!("\\\\.\\pipe\\openbitfun-miniapp-{}", uuid::Uuid::new_v4());
    let endpoint = ipc::Endpoint {
        protocol_version: MINIAPP_PRESENTATION_PROTOCOL,
        address,
        token: format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
        host_epoch: host.instances.snapshot().host_epoch,
    };
    #[cfg(unix)]
    let listener = tokio::net::UnixListener::bind(&endpoint.address).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let first = tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .create(&endpoint.address)
        .map_err(|e| e.to_string())?;
    let data_dir = app
        .state::<AppState>()
        .miniapp_manager
        .path_manager()
        .user_data_dir();
    ipc::private_json(&ipc::endpoint_path(&data_dir), &endpoint)?;
    *host.endpoint.lock().unwrap_or_else(|p| p.into_inner()) = Some(endpoint.clone());
    *host.socket_dir.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        #[cfg(unix)]
        while let Ok((stream, _)) = listener.accept().await {
            tauri::async_runtime::spawn(serve(handle.clone(), stream, endpoint.clone()));
        }
        #[cfg(windows)]
        {
            let mut server = first;
            loop {
                if server.connect().await.is_err() {
                    break;
                }
                let next = match tokio::net::windows::named_pipe::ServerOptions::new()
                    .create(&endpoint.address)
                {
                    Ok(next) => next,
                    Err(_) => break,
                };
                tauri::async_runtime::spawn(serve(handle.clone(), server, endpoint.clone()));
                server = next;
            }
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let state = handle.state::<DesktopMiniApps>();
            if handle.get_webview_window("main").is_some() {
                state.instances.renew_committed_views(MiniAppViewKind::Tab);
            }
            {
                let _guard = state.launches.lock().await;
                // Expired/crashed shells and failed initial presentations must
                // obey the same final-view shutdown rule as an explicit close.
                for instance in state.instances.snapshot().instances {
                    if !instance.has_views() {
                        if let Err(error) = stop_instance(&handle, &instance.instance_id).await {
                            log::warn!(
                                "Failed to stop an unpresented MiniApp: instance_id={}, error={}",
                                instance.instance_id,
                                error
                            );
                        }
                    }
                }
            }
            let snapshot = state.instances.snapshot();
            state
                .shells
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|id, _| snapshot.instances.iter().any(|i| i.accepts_view(id)));
            let _ = handle.emit_to("main", "miniapp-instances-changed", snapshot);
        }
    });
    let handle = app.clone();
    app.listen("miniapp-deleted", move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let Some(app_id) = payload["id"].as_str() else {
            return;
        };
        let host = handle.state::<DesktopMiniApps>();
        for instance in host
            .instances
            .snapshot()
            .instances
            .into_iter()
            .filter(|instance| instance.app_id == app_id)
        {
            host.instances.retire(&instance.instance_id);
            host.sessions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&instance.instance_id);
        }
        miniapp_api::cancel_miniapp_streams(app_id);
        changed(&handle);
    });
    sdk::install_events(app);
    Ok(())
}
