//! System API

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use crate::api::app_state::AppState;
use crate::startup_trace::DesktopStartupTrace;
use openbitfun_core::service::system;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Position, Size, State};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// Emitted during `install_update` download; matches `installUpdateWithProgress` / frontend listener.
const UPDATE_PROGRESS_EVENT: &str = "openbitfun-update-progress";

/// Updater origins, in configured (fallback) order. Kept in step with
/// `scripts/desktop-tauri-build.mjs`, which bakes the same pair into the bundle.
const GITHUB_UPDATER_ENDPOINT: &str = match option_env!("OPENBITFUN_UPDATER_PRIMARY_ENDPOINT") {
    Some(endpoint) => endpoint,
    None => "https://github.com/GCWing/OpenBitFun/releases/latest/download/latest-v1.json",
};
const OPENBITFUN_UPDATER_ENDPOINT: &str = match option_env!("OPENBITFUN_UPDATER_FALLBACK_ENDPOINT")
{
    Some(endpoint) => endpoint,
    None => "https://openbitfun.com/release/latest-v1.json",
};

/// Throughput probe settings, matching the CLI updater and the relay deploy
/// script (`src/apps/cli/src/self_update.rs`,
/// `src/apps/relay-server/release-download.sh`).
const PROBE_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);
const PROBE_BYTES: u64 = 4 * 1024 * 1024;
const HEALTHY_THROUGHPUT: u64 = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct UpdaterManifestInfo {
    version: String,
    package_url: String,
}

/// Keep GitHub first while its package clears the healthy floor. A slow or
/// unreachable GitHub package moves the mirror first only when the mirror has
/// synchronized the exact same latest version; a stale mirror must never hide
/// a new release.
///
/// Tauri walks `endpoints` and stops at the first that returns a usable
/// manifest, then downloads from the URL *inside that manifest*. `latest-v1.json`
/// is ~2 KB, so a reachable-but-crawling GitHub always wins the race to answer
/// and then pins an 80-160 MB download to itself — the mirror is only ever tried
/// when GitHub errors outright. We therefore probe the actual GitHub package.
///
/// Deliberately still routed through `Update::download`: minisign verification
/// lives inside it, so fetching bytes by hand and calling `Update::install`
/// would silently skip signature checking.
async fn updater_endpoints_by_policy() -> Vec<tauri::Url> {
    crate::ensure_rustls_crypto_provider();
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .read_timeout(PROBE_WINDOW)
        .build()
    {
        Ok(client) => client,
        Err(_) => return default_endpoints(),
    };

    // Probe the package each origin would actually serve, not its manifest.
    // `latest-v1.json` is ~2 KB, so probing it measures round-trip latency and
    // tells us nothing about an 80-160 MB transfer. Each manifest names its own
    // download URL, which is exactly the thing worth measuring.
    let platform = updater_platform_key();
    let (github_manifest, mirror_manifest) = tokio::join!(
        fetch_updater_manifest(&client, GITHUB_UPDATER_ENDPOINT, &platform),
        fetch_updater_manifest(&client, OPENBITFUN_UPDATER_ENDPOINT, &platform),
    );
    let Some(github_manifest) = github_manifest else {
        log::info!("GitHub updater metadata is unavailable; trying the OpenBitFun mirror first");
        return mirror_first_endpoints();
    };
    let github_speed = probe_endpoint_throughput(&client, &github_manifest.package_url).await;
    log::debug!(
        "Desktop updater GitHub probe: {} B/s from {}",
        github_speed,
        github_manifest.package_url
    );
    if prefer_mirror(&github_manifest, mirror_manifest.as_ref(), github_speed) {
        log::info!(
            "GitHub updater speed is {} KiB/s, under the {} KiB/s bar; trying the synchronized OpenBitFun mirror first.",
            github_speed / 1024,
            HEALTHY_THROUGHPUT / 1024
        );
        return mirror_first_endpoints();
    }
    if github_speed < HEALTHY_THROUGHPUT {
        log::info!(
            "GitHub updater speed is {} KiB/s but the mirror has not synchronized {}; keeping GitHub first to preserve latest-version correctness.",
            github_speed / 1024,
            github_manifest.version
        );
    }
    default_endpoints()
}

/// Tauri's `latest-v1.json` platform key for this host, e.g. `darwin-aarch64`.
/// Mirrors `scripts/generate-tauri-latest-json.mjs`.
fn updater_platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Read one updater manifest and return the download URL it advertises for this
/// platform. Cheap: the manifest is a couple of kilobytes.
async fn fetch_updater_manifest(
    client: &reqwest::Client,
    endpoint: &str,
    platform: &str,
) -> Option<UpdaterManifestInfo> {
    let manifest = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.get(endpoint).send(),
    )
    .await
    .ok()?
    .ok()?
    .error_for_status()
    .ok()?
    .json::<serde_json::Value>()
    .await
    .ok()?;
    let version = manifest.get("version")?.as_str()?.to_owned();
    let package_url = manifest
        .get("platforms")?
        .get(platform)?
        .get("url")?
        .as_str()
        .map(str::to_owned)?;
    Some(UpdaterManifestInfo {
        version,
        package_url,
    })
}

fn prefer_mirror(
    github: &UpdaterManifestInfo,
    mirror: Option<&UpdaterManifestInfo>,
    github_speed: u64,
) -> bool {
    github_speed < HEALTHY_THROUGHPUT
        && mirror.is_some_and(|candidate| candidate.version == github.version)
}

fn default_endpoints() -> Vec<tauri::Url> {
    [GITHUB_UPDATER_ENDPOINT, OPENBITFUN_UPDATER_ENDPOINT]
        .iter()
        .filter_map(|endpoint| endpoint.parse().ok())
        .collect()
}

fn mirror_first_endpoints() -> Vec<tauri::Url> {
    [OPENBITFUN_UPDATER_ENDPOINT, GITHUB_UPDATER_ENDPOINT]
        .iter()
        .filter_map(|endpoint| endpoint.parse().ok())
        .collect()
}

/// Bytes an origin delivers inside [`PROBE_WINDOW`], i.e. its throughput.
async fn probe_endpoint_throughput(client: &reqwest::Client, url: &str) -> u64 {
    use futures::StreamExt;

    let started = std::time::Instant::now();
    let request = client
        .get(url)
        .header(
            reqwest::header::RANGE,
            format!("bytes=0-{}", PROBE_BYTES - 1),
        )
        .send();
    let Ok(Ok(response)) = tokio::time::timeout(PROBE_WINDOW, request).await else {
        return 0;
    };
    if !response.status().is_success() {
        return 0;
    }

    let mut received: u64 = 0;
    let mut stream = response.bytes_stream();
    loop {
        let remaining = match PROBE_WINDOW.checked_sub(started.elapsed()) {
            Some(left) if !left.is_zero() => left,
            _ => break,
        };
        match tokio::time::timeout(remaining, stream.next()).await {
            Ok(Some(Ok(chunk))) => received += chunk.len() as u64,
            _ => break,
        }
        if received >= PROBE_BYTES {
            break;
        }
    }
    (received as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64
}

/// Build an updater whose endpoints are ordered by measured throughput.
/// Falls back to the bundled configuration if the builder rejects them.
pub(super) async fn ranked_updater(
    app: &AppHandle,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoints = updater_endpoints_by_policy().await;
    let builder = app.updater_builder();
    let builder = match builder.endpoints(endpoints) {
        Ok(builder) => builder,
        Err(error) => {
            log::warn!(
                "Updater endpoint ranking rejected, using bundled order: {}",
                error
            );
            app.updater_builder()
        }
    };
    crate::api::update_api::with_update_exit_cleanup(builder, app)
        .build()
        .map_err(|error| error.to_string())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgressPayload {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoResponse {
    pub platform: String,
    pub arch: String,
    pub os_version: Option<String>,
    #[serde(default)]
    pub home_dir: Option<String>,
}

#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfoResponse, String> {
    let info = system::get_system_info();

    Ok(SystemInfoResponse {
        platform: info.platform,
        arch: info.arch,
        os_version: info.os_version,
        home_dir: info.home_dir,
    })
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetAppVersionRequest {}

/// Returns the current application version (from `Cargo.toml` / bundle metadata).
#[tauri::command]
pub async fn get_app_version(
    app: AppHandle,
    request: GetAppVersionRequest,
) -> Result<String, String> {
    let _ = request;
    Ok(app.package_info().version.to_string())
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckForUpdatesRequest {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckForUpdatesResponse {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    pub release_date: Option<String>,
}

/// Checks the remote updater endpoint for a newer signed release (no download).
#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    request: CheckForUpdatesRequest,
) -> Result<CheckForUpdatesResponse, String> {
    let _ = request;
    let updater = ranked_updater(&app).await?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    match update {
        Some(u) => Ok(CheckForUpdatesResponse {
            update_available: true,
            current_version: u.current_version.clone(),
            latest_version: Some(u.version.clone()),
            release_notes: u.body.clone(),
            release_date: u.date.map(|d| d.to_string()),
        }),
        None => Ok(CheckForUpdatesResponse {
            update_available: false,
            current_version: app.package_info().version.to_string(),
            latest_version: None,
            release_notes: None,
            release_date: None,
        }),
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallUpdateRequest {}

/// Downloads and installs the latest update from the updater endpoint (re-checks remote).
#[tauri::command]
pub async fn install_update(app: AppHandle, request: InstallUpdateRequest) -> Result<(), String> {
    let _ = request;
    let updater = ranked_updater(&app).await?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        return Err("No update available".to_string());
    };
    let app_handle = app.clone();
    let progress = Arc::new(Mutex::new((0u64, None::<u64>)));
    let progress_chunk = Arc::clone(&progress);
    let app_chunk = app_handle.clone();
    let bytes = update
        .download(
            move |chunk_len, content_len| {
                let (downloaded, total) = {
                    let mut g = progress_chunk
                        .lock()
                        .expect("update progress mutex poisoned");
                    g.0 = g.0.saturating_add(chunk_len as u64);
                    g.1 = g.1.or(content_len);
                    (g.0, g.1)
                };
                let _ = app_chunk.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgressPayload { downloaded, total },
                );
            },
            {
                let app_done = app_handle.clone();
                let progress_done = Arc::clone(&progress);
                move || {
                    let (downloaded, total) = {
                        let g = progress_done
                            .lock()
                            .expect("update progress mutex poisoned");
                        (g.0, g.1)
                    };
                    let _ = app_done.emit(
                        UPDATE_PROGRESS_EVENT,
                        UpdateProgressPayload { downloaded, total },
                    );
                }
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || update.install(bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenHtmlFileInBrowserRequest {
    pub path: String,
}

fn is_html_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn open_html_file_in_browser(
    app: AppHandle,
    request: OpenHtmlFileInBrowserRequest,
) -> Result<(), String> {
    let path = Path::new(&request.path);

    if !is_html_file_path(path) {
        return Err("Only HTML files can be opened in the browser".to_string());
    }

    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Failed to read HTML file metadata: {}", error))?;
    if !metadata.is_file() {
        return Err("HTML path is not a file".to_string());
    }

    app.opener()
        .open_path(&request.path, None::<&str>)
        .map_err(|error| format!("Failed to open HTML file in browser: {}", error))
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestartAppRequest {}

/// Restarts the desktop application after an update has been installed.
#[tauri::command]
#[allow(unreachable_code)]
pub async fn restart_app(app: AppHandle, request: RestartAppRequest) -> Result<(), String> {
    let _ = request;
    crate::save_main_window_state(&app, "restart_app");
    crate::perform_process_exit_cleanup().await;
    crate::crash_diagnostics::mark_clean_shutdown("restart_app");
    log::info!("Desktop restart authorized after graceful shutdown");
    app.restart();
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCommandResponse {
    pub exists: bool,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandRequest {
    #[serde(default)]
    pub controller_local: bool,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<Vec<EnvVar>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutputResponse {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMacosEditMenuModeRequest {
    pub mode: crate::macos_menubar::EditMenuMode,
}

#[tauri::command]
pub async fn check_command_exists(command: String) -> Result<CheckCommandResponse, String> {
    let result = system::check_command(&command);

    Ok(CheckCommandResponse {
        exists: result.exists,
        path: result.path,
    })
}

#[tauri::command]
pub async fn check_commands_exist(
    commands: Vec<String>,
) -> Result<Vec<(String, CheckCommandResponse)>, String> {
    let cmd_refs: Vec<&str> = commands.iter().map(|s| s.as_str()).collect();
    let results = system::check_commands(&cmd_refs);

    Ok(results
        .into_iter()
        .map(|(name, result)| {
            (
                name,
                CheckCommandResponse {
                    exists: result.exists,
                    path: result.path,
                },
            )
        })
        .collect())
}

/// Runs a process on the controller. A remote workspace working directory is refused because this
/// command has no SSH transport: honouring it locally would run the process on the wrong machine.
#[tauri::command]
pub async fn run_system_command(
    request: RunCommandRequest,
) -> Result<CommandOutputResponse, String> {
    if request.workspace_id.is_some() || request.cwd.is_some() {
        let cwd = request.cwd.as_deref().unwrap_or_default();
        if openbitfun_core::service::workspace::remote_io_for_legacy_or_id(
            request.workspace_id.as_deref(),
            request.controller_local,
            cwd.trim(),
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err(format!(
                "run_system_command cannot execute '{}' in remote workspace directory '{}': this command spawns controller-local processes only; local filesystem fallback was not attempted",
                request.command, cwd
            ));
        }
    }

    let env_vars: Option<Vec<(String, String)>> = request
        .env
        .map(|vars| vars.into_iter().map(|v| (v.key, v.value)).collect());

    let env_ref: Option<&[(String, String)]> = env_vars.as_deref();

    let result = system::run_command(
        &request.command,
        &request.args,
        request.cwd.as_deref(),
        env_ref,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(CommandOutputResponse {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        success: result.success,
    })
}

#[tauri::command]
pub async fn set_macos_edit_menu_mode(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: SetMacosEditMenuModeRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let current_mode = *state.macos_edit_menu_mode.read().await;
        if current_mode == request.mode {
            return Ok(());
        }

        {
            let mut edit_mode = state.macos_edit_menu_mode.write().await;
            *edit_mode = request.mode;
        }

        let language = state
            .config_service
            .get_config::<String>(Some("app.language"))
            .await
            .unwrap_or_else(|_| "zh-CN".to_string());
        let menubar_mode = if state.workspace_id.read().await.is_some() {
            crate::macos_menubar::MenubarMode::Workspace
        } else {
            crate::macos_menubar::MenubarMode::Startup
        };

        crate::macos_menubar::set_macos_menubar_with_mode(
            &app,
            &language,
            menubar_mode,
            request.mode,
        )
        .map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&state, &app, &request);
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendNotificationRequest {
    pub title: String,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToggleMainWindowFullscreenRequest {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleMainWindowFullscreenResponse {
    pub is_fullscreen: bool,
    pub is_maximized: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupWindowControlAction {
    GetState,
    Minimize,
    ToggleMaximize,
    Close,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupWindowControlRequest {
    pub action: StartupWindowControlAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupWindowControlResponse {
    pub is_maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MainWindowFullscreenTransition {
    next_fullscreen: bool,
    should_apply_monitor_bounds_after_enter: bool,
    should_restore_maximized_after_exit: bool,
    next_restore_maximized_after_fullscreen: bool,
}

fn plan_main_window_fullscreen_transition(
    current_fullscreen: bool,
    current_maximized: bool,
    restore_maximized_after_fullscreen: bool,
    apply_maximized_fullscreen_monitor_bounds: bool,
) -> MainWindowFullscreenTransition {
    let next_fullscreen = !current_fullscreen;

    if next_fullscreen {
        MainWindowFullscreenTransition {
            next_fullscreen,
            should_apply_monitor_bounds_after_enter: current_maximized
                && apply_maximized_fullscreen_monitor_bounds,
            should_restore_maximized_after_exit: false,
            next_restore_maximized_after_fullscreen: current_maximized,
        }
    } else {
        MainWindowFullscreenTransition {
            next_fullscreen,
            should_apply_monitor_bounds_after_enter: false,
            should_restore_maximized_after_exit: restore_maximized_after_fullscreen,
            next_restore_maximized_after_fullscreen: false,
        }
    }
}

fn main_window_fullscreen_restore_maximized() -> &'static Mutex<bool> {
    static RESTORE_MAXIMIZED: OnceLock<Mutex<bool>> = OnceLock::new();
    RESTORE_MAXIMIZED.get_or_init(|| Mutex::new(false))
}

fn read_main_window_fullscreen_response(
    window: &tauri::WebviewWindow,
    fallback_fullscreen: bool,
    fallback_maximized: bool,
) -> ToggleMainWindowFullscreenResponse {
    ToggleMainWindowFullscreenResponse {
        is_fullscreen: window.is_fullscreen().unwrap_or(fallback_fullscreen),
        is_maximized: window.is_maximized().unwrap_or(fallback_maximized),
    }
}

// ─── Window / Tray behavior commands ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMainWindowTransientGeometryRequest {
    pub transient: bool,
}

/// Mark whether the shared main window currently uses toolbar-mode geometry.
///
/// Entering captures the latest normal bounds before the frontend resizes the
/// native window. Leaving persists the restored normal bounds. While transient
/// geometry is active, all process-exit save paths retain the captured normal
/// state instead of the floating-window state.
#[tauri::command]
pub async fn set_main_window_transient_geometry(
    app: tauri::AppHandle,
    request: SetMainWindowTransientGeometryRequest,
) -> Result<(), String> {
    crate::set_main_window_transient_geometry(&app, request.transient)
}

/// Immediately exit the application (used by the "ask" dialog when the user
/// chooses to quit rather than minimize to tray).
#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("Quit requested via quit_app command");
    crate::save_main_window_state(&app, "quit_app_command");
    crate::perform_process_exit_cleanup().await;
    crate::crash_diagnostics::mark_clean_shutdown("quit_app_command");
    log::info!("Desktop exit authorized after graceful shutdown: reason=quit_app_command");
    app.exit(0);
    Ok(())
}

/// Hide the main window so it lives only in the system tray (used by the "ask"
/// dialog when the user chooses to minimize instead of quitting).
#[tauri::command]
pub async fn minimize_to_tray(
    app: tauri::AppHandle,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<(), String> {
    if let Err(error) = crate::tray::setup_tray(&app, &startup_trace) {
        log::warn!("Failed to initialize tray before minimizing: {}", error);
    }
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
        log::info!("Main window minimized to tray via command");
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTrayUnreadCountRequest {
    pub count: u32,
}

#[tauri::command]
pub async fn set_tray_unread_count(
    app: tauri::AppHandle,
    request: SetTrayUnreadCountRequest,
) -> Result<(), String> {
    crate::tray::set_unread_count(&app, request.count)
}

/// Initialize the desktop tray after the startup shell has become interactive.
#[tauri::command]
pub async fn initialize_tray_after_startup(
    app: tauri::AppHandle,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<(), String> {
    crate::tray::setup_tray(&app, &startup_trace).map_err(|e| e.to_string())
}

/// Minimal startup-window controls used by the static pre-React splash.
#[tauri::command]
pub async fn startup_window_control(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
    app: tauri::AppHandle,
    request: StartupWindowControlRequest,
) -> Result<StartupWindowControlResponse, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("Main window not found".to_string());
    };

    let mut is_maximized = window.is_maximized().unwrap_or(false);
    match request.action {
        StartupWindowControlAction::GetState => {}
        StartupWindowControlAction::Minimize => {
            window.minimize().map_err(|error| {
                format!("Failed to minimize main window during startup: {}", error)
            })?;
        }
        StartupWindowControlAction::ToggleMaximize => {
            if is_maximized {
                window.unmaximize().map_err(|error| {
                    format!("Failed to restore main window during startup: {}", error)
                })?;
            } else {
                window.maximize().map_err(|error| {
                    format!("Failed to maximize main window during startup: {}", error)
                })?;
            }
            is_maximized = !is_maximized;
        }
        StartupWindowControlAction::Close => {
            let behavior = state
                .config_service
                .get_config::<String>(Some("app.close_button_behavior"))
                .await
                .unwrap_or_else(|_| "minimize_to_tray".to_string());

            if behavior == "quit" {
                log::info!("Quit requested from startup window control");
                crate::save_main_window_state(&app, "startup_window_control_quit");
                crate::perform_process_exit_cleanup().await;
                crate::crash_diagnostics::mark_clean_shutdown("startup_window_control");
                log::info!(
                    "Desktop exit authorized after graceful shutdown: reason=startup_window_control"
                );
                app.exit(0);
            } else {
                if let Err(error) = crate::tray::setup_tray(&app, &startup_trace) {
                    log::warn!("Failed to initialize tray before startup close: {}", error);
                }
                window.hide().map_err(|error| {
                    format!("Failed to hide main window during startup close: {}", error)
                })?;
                log::info!("Main window hidden from startup window control");
            }
        }
    }

    Ok(StartupWindowControlResponse { is_maximized })
}

/// Toggle OS-level fullscreen for the Desktop main window.
///
/// This is intentionally not the same as maximize: maximize fills the normal
/// work area, while fullscreen asks the OS to own the whole monitor surface.
/// This is also intentionally a Desktop shell adapter command, not a remote
/// workspace/session/runtime command; remote workspaces still run inside the
/// same local Desktop window, so fullscreen must not enter transport or core
/// product logic.
/// Keeping the transition in the desktop host avoids frontend code stitching
/// together `set_fullscreen` / `maximize` with visible JS turns.
///
/// Important: do not unmaximize before entering fullscreen. On Windows this
/// briefly restores the normal window bounds, which makes the window origin and
/// size visibly jump before the OS fullscreen transition starts. Fullscreen and
/// maximize are tracked separately so we can remember whether to restore the
/// maximized state after fullscreen exits without touching window geometry on
/// entry.
///
/// Windows note: Tauri/wry fullscreen does not always expand an undecorated
/// maximized window beyond the work area if we call `set_fullscreen(true)`
/// directly. The Windows path therefore keeps the window maximized, enters
/// fullscreen, then applies the current monitor's full bounds as a geometry
/// correction. Never reintroduce `unmaximize`, `hide`, or `show` in this enter
/// path: those expose a restore transition and make repeated F11 toggles feel
/// broken.
#[tauri::command]
pub async fn toggle_main_window_fullscreen(
    app: tauri::AppHandle,
    request: ToggleMainWindowFullscreenRequest,
) -> Result<ToggleMainWindowFullscreenResponse, String> {
    let _ = request;
    let Some(window) = app.get_webview_window("main") else {
        return Err("Main window not found".to_string());
    };

    let current_fullscreen = window
        .is_fullscreen()
        .map_err(|error| format!("Failed to read main window fullscreen state: {}", error))?;
    let current_maximized = window
        .is_maximized()
        .map_err(|error| format!("Failed to read main window maximize state: {}", error))?;
    let restore_maximized_after_fullscreen = *main_window_fullscreen_restore_maximized()
        .lock()
        .map_err(|_| "Main window fullscreen restore state is unavailable".to_string())?;

    let transition = plan_main_window_fullscreen_transition(
        current_fullscreen,
        current_maximized,
        restore_maximized_after_fullscreen,
        should_apply_maximized_fullscreen_monitor_bounds(),
    );

    if transition.next_fullscreen {
        if let Err(error) = window.set_fullscreen(true) {
            return Err(format!("Failed to enter main window fullscreen: {}", error));
        }

        if transition.should_apply_monitor_bounds_after_enter {
            apply_main_window_fullscreen_monitor_bounds(&app, &window)?;
        }

        *main_window_fullscreen_restore_maximized()
            .lock()
            .map_err(|_| "Main window fullscreen restore state is unavailable".to_string())? =
            transition.next_restore_maximized_after_fullscreen;

        return Ok(read_main_window_fullscreen_response(&window, true, false));
    }

    window
        .set_fullscreen(false)
        .map_err(|error| format!("Failed to exit main window fullscreen: {}", error))?;

    let mut restored_maximized = false;
    if transition.should_restore_maximized_after_exit {
        let is_already_maximized = window.is_maximized().unwrap_or(false);
        if !is_already_maximized {
            window.maximize().map_err(|error| {
                format!("Failed to restore maximize after fullscreen: {}", error)
            })?;
        }
        restored_maximized = true;
    }

    *main_window_fullscreen_restore_maximized()
        .lock()
        .map_err(|_| "Main window fullscreen restore state is unavailable".to_string())? =
        transition.next_restore_maximized_after_fullscreen;

    Ok(read_main_window_fullscreen_response(
        &window,
        false,
        restored_maximized,
    ))
}

fn apply_main_window_fullscreen_monitor_bounds(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Failed to read current monitor for fullscreen: {}", error))?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "Failed to resolve monitor for fullscreen".to_string())?;

    window
        .set_position(Position::Physical(*monitor.position()))
        .map_err(|error| format!("Failed to align fullscreen window position: {}", error))?;
    window
        .set_size(Size::Physical(*monitor.size()))
        .map_err(|error| format!("Failed to align fullscreen window size: {}", error))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn should_apply_maximized_fullscreen_monitor_bounds() -> bool {
    true
}

#[cfg(not(target_os = "windows"))]
fn should_apply_maximized_fullscreen_monitor_bounds() -> bool {
    false
}

/// Send an OS-level desktop notification (Windows toast / macOS notification center).
#[tauri::command]
pub async fn send_system_notification(
    app: tauri::AppHandle,
    request: SendNotificationRequest,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // The Tauri notification plugin drops notify-rust's response handle after
        // showing a Windows toast, so its body-click activation cannot be observed.
        return send_clickable_windows_notification(app, request);
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tauri_plugin_notification::NotificationExt;

        let mut builder = app.notification().builder().title(&request.title);
        if let Some(body) = &request.body {
            builder = builder.body(body);
        }
        builder.show().map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
fn send_clickable_windows_notification(
    app: tauri::AppHandle,
    request: SendNotificationRequest,
) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&request.title);
    if let Some(body) = &request.body {
        notification.body(body);
    }

    if should_use_configured_notification_app_id() {
        notification.app_id(&app.config().identifier);
    }

    let handle = notification.show().map_err(|error| error.to_string())?;
    // Waiting for a toast click is blocking; keep it off both the UI thread and
    // the async executor while retaining the response handle until dismissal.
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) =
            handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
                if !notification_response_activates_main_window(response) {
                    return;
                }

                let app_for_window = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    activate_main_window_from_notification(&app_for_window);
                }) {
                    log::warn!(
                        "Failed to schedule main window activation from notification: {}",
                        error
                    );
                }
            })
        {
            log::warn!("Failed to observe Windows notification response: {}", error);
        }
    });

    Ok(())
}

#[cfg(target_os = "windows")]
fn should_use_configured_notification_app_id() -> bool {
    use std::path::MAIN_SEPARATOR;

    // Match the Tauri plugin's development behavior. A Cargo-built executable
    // has no installed Windows shortcut that registers OpenBitFun's AppUserModelID.
    let Ok(executable) = tauri::utils::platform::current_exe() else {
        return false;
    };
    let Some(executable_dir) = executable.parent() else {
        return false;
    };
    let executable_dir = executable_dir.display().to_string();

    !executable_dir.ends_with(format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}debug").as_str())
        && !executable_dir
            .ends_with(format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}release").as_str())
}

#[cfg(target_os = "windows")]
fn notification_response_activates_main_window(
    response: &notify_rust::NotificationResponse,
) -> bool {
    matches!(
        response,
        notify_rust::NotificationResponse::Default
            | notify_rust::NotificationResponse::Action(_)
            | notify_rust::NotificationResponse::Reply(_)
    )
}

#[cfg(target_os = "windows")]
fn activate_main_window_from_notification(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Failed to activate main window from notification: main window not found");
        return;
    };

    if let Err(error) = window.unminimize() {
        log::warn!(
            "Failed to unminimize main window from notification: {}",
            error
        );
    }
    if let Err(error) = window.show() {
        log::warn!("Failed to show main window from notification: {}", error);
    }
    if let Err(error) = window.set_focus() {
        log::warn!("Failed to focus main window from notification: {}", error);
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn system_info_home_contract_accepts_legacy_and_reports_serving_host() {
        let legacy =
            serde_json::json!({"platform": "windows", "arch": "x86_64", "osVersion": null});
        let old: super::SystemInfoResponse = serde_json::from_value(legacy).unwrap();
        assert!(old.home_dir.is_none());
        let round_trip: super::SystemInfoResponse =
            serde_json::from_value(serde_json::to_value(old).unwrap()).unwrap();
        assert_eq!(round_trip.platform, "windows");
        assert!(round_trip.home_dir.is_none());

        let response = serde_json::to_value(super::get_system_info().await.unwrap()).unwrap();
        assert_eq!(
            response["homeDir"],
            serde_json::json!(super::system::get_system_info().home_dir)
        );
        assert!(response.get("home_dir").is_none());
    }

    #[test]
    fn startup_window_control_contract_exposes_the_native_maximize_state() {
        let request: super::StartupWindowControlRequest =
            serde_json::from_value(serde_json::json!({ "action": "get_state" }))
                .expect("get_state request");
        assert!(matches!(
            request.action,
            super::StartupWindowControlAction::GetState
        ));

        let response = super::StartupWindowControlResponse { is_maximized: true };
        assert_eq!(
            serde_json::to_value(response).expect("serialize response"),
            serde_json::json!({ "isMaximized": true })
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn notification_body_click_activates_main_window_but_dismissal_does_not() {
        use notify_rust::{CloseReason, NotificationResponse};

        assert!(super::notification_response_activates_main_window(
            &NotificationResponse::Default
        ));
        assert!(!super::notification_response_activates_main_window(
            &NotificationResponse::Closed(CloseReason::Dismissed)
        ));
    }

    /// The probe reads `platforms[<key>].url` out of `latest-v1.json`; if this key
    /// stops matching what scripts/generate-tauri-latest-json.mjs emits, every
    /// probe silently scores 0 and ranking degrades to the configured order.
    #[test]
    fn updater_platform_key_matches_latest_json_convention() {
        let key = super::updater_platform_key();
        let (os, arch) = key.split_once('-').expect("os-arch shape");
        assert!(
            matches!(os, "darwin" | "linux" | "windows"),
            "unexpected updater os segment: {os}"
        );
        assert!(
            matches!(arch, "x86_64" | "aarch64"),
            "unexpected updater arch segment: {arch}"
        );
        #[cfg(target_os = "macos")]
        assert!(
            key.starts_with("darwin-"),
            "macOS must map to darwin, got {key}"
        );
    }

    #[test]
    fn updater_uses_mirror_only_for_a_slow_github_and_the_same_release() {
        let github = UpdaterManifestInfo {
            version: "1.2.3".into(),
            package_url: "https://github.example/openbitfun.tar.gz".into(),
        };
        let synchronized_mirror = UpdaterManifestInfo {
            version: "1.2.3".into(),
            package_url: "https://mirror.example/openbitfun.tar.gz".into(),
        };
        let stale_mirror = UpdaterManifestInfo {
            version: "1.2.2".into(),
            package_url: "https://mirror.example/old.tar.gz".into(),
        };

        assert!(prefer_mirror(
            &github,
            Some(&synchronized_mirror),
            HEALTHY_THROUGHPUT - 1
        ));
        assert!(!prefer_mirror(
            &github,
            Some(&synchronized_mirror),
            HEALTHY_THROUGHPUT
        ));
        assert!(!prefer_mirror(
            &github,
            Some(&stale_mirror),
            HEALTHY_THROUGHPUT - 1
        ));
        assert!(!prefer_mirror(&github, None, HEALTHY_THROUGHPUT - 1));
    }

    use super::*;

    #[test]
    fn main_window_fullscreen_transition_enters_from_maximized_without_reusing_maximize_state() {
        let transition = plan_main_window_fullscreen_transition(false, true, false, true);

        assert!(transition.next_fullscreen);
        assert!(transition.should_apply_monitor_bounds_after_enter);
        assert!(transition.next_restore_maximized_after_fullscreen);
        assert!(!transition.should_restore_maximized_after_exit);
    }

    #[test]
    fn main_window_fullscreen_transition_exits_and_restores_previous_maximize_state() {
        let transition = plan_main_window_fullscreen_transition(true, false, true, true);

        assert!(!transition.next_fullscreen);
        assert!(!transition.should_apply_monitor_bounds_after_enter);
        assert!(!transition.next_restore_maximized_after_fullscreen);
        assert!(transition.should_restore_maximized_after_exit);
    }

    #[test]
    fn main_window_fullscreen_transition_can_enter_without_masking_geometry() {
        let transition = plan_main_window_fullscreen_transition(false, true, false, false);

        assert!(transition.next_fullscreen);
        assert!(!transition.should_apply_monitor_bounds_after_enter);
        assert!(transition.next_restore_maximized_after_fullscreen);
    }
}

#[cfg(test)]
mod remote_guard_tests {
    use super::{run_system_command, RunCommandRequest};
    use openbitfun_core::service::remote_ssh::workspace_state::init_remote_workspace_manager;

    const REMOTE_ROOT: &str = "/remote-audit-run-command";
    const CONNECTION_ID: &str = "remote-audit-run-command-connection";

    #[tokio::test]
    async fn run_system_command_refuses_remote_working_directory() {
        init_remote_workspace_manager()
            .register_remote_workspace(
                REMOTE_ROOT.to_string(),
                CONNECTION_ID.to_string(),
                "remote-audit-run-command".to_string(),
                "remote-audit-run-command.invalid".to_string(),
            )
            .await;

        let error = run_system_command(RunCommandRequest {
            controller_local: false,
            workspace_id: None,
            command: "git".to_string(),
            args: vec!["status".to_string()],
            cwd: Some(format!("{REMOTE_ROOT}/repo")),
            env: None,
        })
        .await
        .expect_err("remote working directory must be refused");

        assert!(error.starts_with("run_system_command cannot execute 'git'"));
        assert!(error.contains("local filesystem fallback was not attempted"));

        init_remote_workspace_manager()
            .unregister_remote_workspace(CONNECTION_ID, REMOTE_ROOT)
            .await;
    }
}
