#![recursion_limit = "256"]
#![allow(non_snake_case)]
//! OpenBitFun Desktop - Tauri-based desktop application with TransportAdapter architecture
//!
//! The reqwest HTTP/2 and MCP transport type graph exceeds rustc's default
//! trait-evaluation recursion budget when desktop tasks require `Send`.
//!
//! Concretely, dropping the limit back to 128 fails with `overflow evaluating
//! the requirement Vec<slab::Entry<h2::…::Slot<h2::…::recv::Event>>>: Send`.
//! The chain runs ~15 frames through h2's own internals (`Slab` → `Buffer` →
//! `Recv` → `Actions` → `Inner` → `Arc<Mutex<_>>` → `RecvStream` → hyper's
//! `Incoming`), into the MCP remote transport, then out through roughly ten
//! nested `async fn` bodies from `agentic::coordination::scheduler` to the
//! `tokio::spawn` in `api::remote_connect_api`.
//!
//! Most of that depth is in third-party types, so `Box::pin`-ing one of our own
//! futures does not collapse it; only erasing a mid-chain future to
//! `Pin<Box<dyn Future + Send>>` would, at the cost of an allocation and dynamic
//! dispatch on the dialog-turn path. Raising the budget is the mechanism rustc
//! itself suggests, costs nothing at runtime, and is re-checked whenever this
//! attribute is touched.

pub mod api;
pub mod appearance;
mod builtin_browser_host;
pub mod computer_use;
pub mod crash_diagnostics;
mod embedded_relay_host;
pub mod frontend_workbench;
pub mod logging;
pub mod macos_menubar;
mod openbitfun_control_host;
pub mod runtime;
pub mod sleep_prevention;
pub mod startup_trace;
pub mod tray;
mod webview_recovery;
mod window_state_support;

use openbitfun_agent_runtime::sdk::{attach_session_event_cursor, SessionEventJournal};
use openbitfun_core::agentic::tools::computer_use_capability::set_computer_use_desktop_available;
use openbitfun_core::agentic::tools::computer_use_host::ComputerUseHostRef;
use openbitfun_core::infrastructure::ai::AIClientFactory;
use openbitfun_core::infrastructure::{get_path_manager_arc, try_get_path_manager_arc};
use openbitfun_core::service::search::get_global_workspace_search_service;
use openbitfun_core::service::session_projection_store::{
    runtime_event_log_dir, FileSessionProjectionStore,
};
use openbitfun_core::util::{elapsed_ms, TimingCollector};
use openbitfun_events::AgenticEvent;
use openbitfun_transport::{TauriTransportAdapter, TransportAdapter};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;

// Re-export API
pub use api::*;

use api::acp_client_api::*;
use api::clipboard_file_api::*;
use api::commands::*;
use api::computer_use_api::*;
use api::config_api::*;
use api::cron_api::*;
use api::custom_agent_api::{
    create_custom_agent, delete_custom_agent, get_custom_agent_detail, reload_custom_agents,
    update_custom_agent,
};
use api::diff_api::*;
use api::external_hooks_api::*;
use api::external_sources_api::*;
use api::git_agent_api::*;
use api::git_api::*;
use api::i18n_api::*;
use api::mcp_api::*;
use api::review_platform_api::*;
use api::runtime_api::*;
use api::search_api::*;
use api::session_api::*;
use api::skill_api::*;
use api::snapshot_service::*;
use api::speech_api::*;
use api::subagent_api::*;
use api::system_api::*;
use api::tool_api::*;
use startup_trace::{DesktopStartupTrace, DesktopStartupTraceSnapshot};

pub(crate) const PLUGIN_HOST_LAUNCH_POLICY: openbitfun_core::plugin_host::PluginHostLaunchPolicy =
    openbitfun_core::plugin_host::PluginHostLaunchPolicy::Enabled;

pub(crate) fn ensure_rustls_crypto_provider() {
    openbitfun_core::service::remote_connect::ensure_rustls_crypto_provider();
}

/// Agentic Coordinator state
#[derive(Clone)]
pub struct CoordinatorState {
    pub coordinator: Arc<openbitfun_core::agentic::coordination::ConversationCoordinator>,
}

/// Dialog scheduler state (primary entry point for user messages)
#[derive(Clone)]
pub struct SchedulerState {
    pub scheduler: Arc<openbitfun_core::agentic::coordination::DialogScheduler>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebdriverBridgeResultRequest {
    payload: serde_json::Value,
}

#[cfg(target_os = "macos")]
static MAIN_WINDOW_HIDDEN_ON_MACOS: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
static MAIN_WINDOW_CLOSE_PENDING_ON_MACOS: AtomicBool = AtomicBool::new(false);

const MAIN_WINDOW_CLOSE_REQUESTED_EVENT: &str = "openbitfun_main_window_close_requested";
const BROWSER_WEBVIEW_PAGE_LOAD_EVENT: &str = "browser-webview-page-load";

#[cfg(target_os = "windows")]
fn show_fatal_startup_error(message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title = "OpenBitFun startup error"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let message = message
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        let _ = MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_fatal_startup_error(message: &str) {
    eprintln!("OpenBitFun startup error: {message}");
}
const CRON_DESKTOP_START_FALLBACK_DELAY: Duration = Duration::from_secs(120);
pub(crate) const MAIN_WINDOW_DEFAULT_WIDTH: f64 = 1200.0;
pub(crate) const MAIN_WINDOW_DEFAULT_HEIGHT: f64 = 800.0;
pub(crate) const MAIN_WINDOW_MIN_WIDTH: f64 = 800.0;
pub(crate) const MAIN_WINDOW_MIN_HEIGHT: f64 = 600.0;

// Toolbar mode temporarily morphs the main window into a compact floating
// surface. Its geometry must never replace the normal main-window geometry
// restored on the next process start.
static MAIN_WINDOW_USES_TRANSIENT_GEOMETRY: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
const MAIN_WINDOW_CLOSE_FALLBACK_HIDE_MS: u64 = 2_500;

// ─── Close-button behavior ────────────────────────────────────────────────────
// The close-button behavior is owned by the frontend; the Rust window-event
// handler only emits a notification event and the frontend decides what to do.
// No per-platform caching needed here.

#[cfg(target_os = "macos")]
pub(crate) fn mark_main_window_hidden_on_macos(hidden: bool) {
    MAIN_WINDOW_HIDDEN_ON_MACOS.store(hidden, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
pub(crate) fn cancel_main_window_close_request_on_macos() {
    MAIN_WINDOW_CLOSE_PENDING_ON_MACOS.store(false, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
fn begin_main_window_close_request_on_macos() -> bool {
    MAIN_WINDOW_CLOSE_PENDING_ON_MACOS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

#[cfg(target_os = "macos")]
fn take_main_window_close_request_on_macos() -> bool {
    MAIN_WINDOW_CLOSE_PENDING_ON_MACOS
        .compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

#[cfg(target_os = "macos")]
fn hide_main_window_on_macos(app: &tauri::AppHandle, reason: &str) -> Result<(), String> {
    let Some(main_window) = app.get_webview_window("main") else {
        mark_main_window_hidden_on_macos(false);
        return Err("Main window not found".to_string());
    };

    main_window.hide().map_err(|error| {
        mark_main_window_hidden_on_macos(false);
        log::warn!(
            "Failed to hide main window on macOS close request: reason={}, error={}",
            reason,
            error
        );
        format!("Failed to hide main window: {}", error)
    })?;

    mark_main_window_hidden_on_macos(true);
    log::info!(
        "Main window close requested on macOS; hid window instead of exiting: reason={}",
        reason
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn show_main_window_on_macos(app: &tauri::AppHandle, reason: &str) {
    cancel_main_window_close_request_on_macos();

    let Some(main_window) = app.get_webview_window("main") else {
        log::warn!(
            "Failed to show main window on macOS reopen event: reason={}, error=main window not found",
            reason
        );
        return;
    };

    let _ = main_window.unminimize();
    if let Err(error) = main_window.show() {
        mark_main_window_hidden_on_macos(false);
        log::warn!(
            "Failed to show main window on macOS reopen event: reason={}, error={}",
            reason,
            error
        );
        return;
    }

    mark_main_window_hidden_on_macos(false);
    if let Err(error) = main_window.set_focus() {
        log::warn!(
            "Failed to focus main window on macOS reopen event: reason={}, error={}",
            reason,
            error
        );
    }
}

#[tauri::command]
async fn hide_main_window_after_close_request(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if take_main_window_close_request_on_macos() {
            hide_main_window_on_macos(&app, "frontend_ack")?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }

    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn show_main_window_for_secondary_launch(
    app: &tauri::AppHandle,
    attempt: &str,
) -> Result<(), String> {
    let Some(main_window) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };

    #[cfg(target_os = "macos")]
    {
        cancel_main_window_close_request_on_macos();
        mark_main_window_hidden_on_macos(false);
    }

    main_window
        .unminimize()
        .map_err(|error| format!("failed to unminimize main window: {}", error))?;
    if let Err(error) = window_state_support::repair_for_activation(&main_window) {
        log::warn!(
            "Failed to repair main window geometry from secondary launch: {}",
            error
        );
    }
    main_window
        .show()
        .map_err(|error| format!("failed to show main window: {}", error))?;
    main_window
        .set_focus()
        .map_err(|error| format!("failed to focus main window: {}", error))?;

    log::info!(
        "Main window shown from secondary launch: attempt={}",
        attempt
    );
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn handle_secondary_launch(app: &tauri::AppHandle) {
    if let Err(error) = show_main_window_for_secondary_launch(app, "immediate") {
        log::warn!(
            "Failed to show main window from secondary launch immediately: {}",
            error
        );

        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            if let Err(error) = show_main_window_for_secondary_launch(&app_handle, "retry") {
                log::warn!(
                    "Failed to show main window from secondary launch retry: {}",
                    error
                );
            }
        });
    }
}

pub(crate) fn e2e_storage_guard_enabled() -> bool {
    std::env::var("OPENBITFUN_E2E_STORAGE_GUARD")
        .ok()
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

fn persist_main_window_state(app: &tauri::AppHandle, reason: &str) -> Result<(), String> {
    window_state_support::save(app, reason)
}

pub(crate) fn save_main_window_state(app: &tauri::AppHandle, reason: &str) {
    if MAIN_WINDOW_USES_TRANSIENT_GEOMETRY.load(Ordering::SeqCst) {
        log::debug!(
            "Skipped saving transient main window geometry: reason={}",
            reason
        );
        return;
    }

    if let Err(error) = persist_main_window_state(app, reason) {
        log::warn!(
            "Failed to save main window state: reason={}, error={}",
            reason,
            error
        );
    }
}

pub(crate) fn set_main_window_transient_geometry(
    app: &tauri::AppHandle,
    transient: bool,
) -> Result<(), String> {
    if transient {
        if MAIN_WINDOW_USES_TRANSIENT_GEOMETRY.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Capture the latest normal bounds before toolbar mode starts resizing
        // the shared native window.
        persist_main_window_state(app, "transient_geometry_enter_capture").map_err(|error| {
            format!(
                "Failed to save main window state before transient geometry: {}",
                error
            )
        })?;
        MAIN_WINDOW_USES_TRANSIENT_GEOMETRY.store(true, Ordering::SeqCst);
        return Ok(());
    }

    MAIN_WINDOW_USES_TRANSIENT_GEOMETRY.store(false, Ordering::SeqCst);
    persist_main_window_state(app, "transient_geometry_exit_persist").map_err(|error| {
        format!(
            "Failed to save restored main window state after transient geometry: {}",
            error
        )
    })
}

pub(crate) fn restore_main_window_state(window: &tauri::WebviewWindow) -> bool {
    window_state_support::restore(window)
}

#[tauri::command]
async fn webdriver_bridge_result(request: WebdriverBridgeResultRequest) -> Result<(), String> {
    log::debug!("webdriver_bridge_result command invoked");
    openbitfun_webdriver::handle_bridge_result(request.payload)
}

#[tauri::command]
fn get_startup_native_trace(
    state: tauri::State<'_, DesktopStartupTrace>,
) -> DesktopStartupTraceSnapshot {
    state.snapshot()
}

/// Tauri application entry point
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let startup_started = Instant::now();
    let startup_trace_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| format!("desktop-{}", duration.as_millis()))
        .unwrap_or_else(|_| "desktop-unknown".to_string());
    let mut startup_timings = TimingCollector::default();
    let in_debug = cfg!(debug_assertions) || std::env::var("DEBUG").unwrap_or_default() == "1";
    let log_config = logging::LogConfig::new(in_debug);
    let log_targets = logging::build_log_targets(&log_config);
    let session_log_dir = log_config.session_log_dir.clone();
    if let Err(error) = logging::install_early_file_logging(&session_log_dir) {
        eprintln!(
            "Warning: Failed to install early startup logging: {}",
            error
        );
    }
    let native_startup_trace_path = logging::native_startup_trace_path(&session_log_dir);
    let startup_trace = match DesktopStartupTrace::new_persisted(
        startup_trace_id.clone(),
        startup_started,
        &native_startup_trace_path,
    ) {
        Ok(trace) => trace,
        Err(error) => {
            log::warn!("Native startup trace persistence is unavailable: {}", error);
            DesktopStartupTrace::new(startup_trace_id.clone(), startup_started)
        }
    };
    startup_trace.record_phase("native_process_start", "native");
    crash_diagnostics::initialize_run_state(session_log_dir.clone(), &startup_trace_id);
    setup_panic_hook();

    // Install the rustls ring CryptoProvider as the process-level default early,
    // so that all subsequent TLS operations (relay_client, reqwest, tokio-tungstenite)
    // reuse the same provider instead of each attempting their own install_default().
    ensure_rustls_crypto_provider();

    eprintln!("=== OpenBitFun Desktop Starting ===");

    if let Err(error) = openbitfun_core::agentic::system::select_agentic_system_profile(
        openbitfun_core::agentic::system::DeliveryProfile::Desktop,
    ) {
        log::error!("Failed to select Desktop agent profile: {}", error);
        show_fatal_startup_error(&format!(
            "OpenBitFun could not select its Desktop agent profile and cannot continue.\n\n{error}\n\nSee early-startup.log for details."
        ));
        return;
    }

    let step_started = Instant::now();
    if let Err(e) = openbitfun_core::service::config::initialize_global_config().await {
        log::error!("Failed to initialize global config service: {}", e);
        show_fatal_startup_error(&format!(
            "OpenBitFun could not initialize its configuration and cannot continue.\n\n{e}\n\nSee early-startup.log for details."
        ));
        return;
    }
    if let Ok(config_service) = openbitfun_core::service::config::get_global_config_service().await
    {
        for diagnostic in config_service.load_diagnostics().await {
            log::warn!(
                "Startup configuration diagnostic: code={}, path={}, recoverability={:?}",
                diagnostic.code,
                diagnostic.path,
                diagnostic.recoverability
            );
        }
    }
    startup_timings.record_elapsed("initialize_global_config", step_started);
    startup_trace.record_elapsed_step("native_pre_tauri", "initialize_global_config", step_started);

    let step_started = Instant::now();
    match openbitfun_core::plugin_host::initialize_configured_plugin_host_with_log_file(
        PLUGIN_HOST_LAUNCH_POLICY,
        Some(session_log_dir.join("plugin-host.log")),
    )
    .await
    {
        Ok(openbitfun_core::plugin_host::PluginHostStartup::Disabled) => {}
        Ok(status) => log::info!("Plugin host initialization completed: {:?}", status),
        Err(error) => {
            log::error!("Failed to initialize configured plugin host: {}", error);
            openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
                "Desktop startup",
                None,
                error,
            )
            .await;
        }
    }
    startup_timings.record_elapsed("initialize_plugin_host", step_started);
    startup_trace.record_elapsed_step("native_pre_tauri", "initialize_plugin_host", step_started);

    // The three steps below only depend on the global config service (initialized
    // above) and write to disjoint global singletons, so they can run concurrently:
    // - initialize_global_i18n_service: reads config, sets the global i18n singleton
    // - resolve_runtime_log_level: reads config, returns a value
    // - AIClientFactory::initialize_global: reads config, sets GLOBAL_AI_CLIENT_FACTORY
    let (
        i18n_duration_ms,
        (startup_log_level, log_level_duration_ms),
        (ai_factory_result, ai_factory_duration_ms),
    ) = {
        use openbitfun_core::service::config::get_global_config_service;
        use openbitfun_core::service::i18n::initialize_global_i18n_service;

        // Initialize global I18nService so bot/remote-connect language is always in sync.
        let i18n_task = async {
            let step_started = Instant::now();
            match get_global_config_service().await {
                Ok(config_service) => {
                    if let Err(e) = initialize_global_i18n_service(Some(config_service)).await {
                        log::error!("Failed to initialize global I18nService: {}", e);
                    }
                }
                Err(e) => {
                    log::error!("Failed to get config service for I18nService init: {}", e);
                }
            }
            elapsed_ms(step_started)
        };

        let log_level_task = async {
            let step_started = Instant::now();
            let level = resolve_runtime_log_level(log_config.level).await;
            (level, elapsed_ms(step_started))
        };

        let ai_factory_task = async {
            let step_started = Instant::now();
            let result = AIClientFactory::initialize_global().await;
            (result, elapsed_ms(step_started))
        };

        tokio::join!(i18n_task, log_level_task, ai_factory_task)
    };

    startup_timings.push_duration("initialize_global_i18n_service", i18n_duration_ms);
    startup_trace.record_step(
        "native_step_end",
        "native_pre_tauri",
        "initialize_global_i18n_service",
        i18n_duration_ms,
    );
    startup_trace.record_step(
        "native_step_end",
        "native_pre_tauri",
        "resolve_runtime_log_level",
        log_level_duration_ms,
    );
    startup_timings.push_duration(
        "initialize_global_ai_client_factory",
        ai_factory_duration_ms,
    );
    startup_trace.record_step(
        "native_step_end",
        "native_pre_tauri",
        "initialize_global_ai_client_factory",
        ai_factory_duration_ms,
    );
    if let Err(e) = ai_factory_result {
        log::error!("Failed to initialize global AIClientFactory: {}", e);
        return;
    }

    let step_started = Instant::now();
    let (coordinator, scheduler, event_queue, event_router, ai_client_factory, token_usage_service) =
        match init_agentic_system().await {
            Ok(state) => state,
            Err(e) => {
                log::error!("Failed to initialize agentic system: {}", e);
                return;
            }
        };
    startup_timings.record_elapsed("init_agentic_system", step_started);
    startup_trace.record_elapsed_step("native_pre_tauri", "init_agentic_system", step_started);

    let step_started = Instant::now();
    if let Err(e) = init_function_agents(ai_client_factory.clone()).await {
        log::error!("Failed to initialize function agents: {}", e);
        return;
    }
    startup_timings.record_elapsed("init_function_agents", step_started);
    startup_trace.record_elapsed_step("native_pre_tauri", "init_function_agents", step_started);

    let step_started = Instant::now();
    let workspace_search_enabled =
        openbitfun_core::service::search::workspace_search_feature_enabled().await;
    startup_trace.record_elapsed_step(
        "native_pre_tauri",
        "workspace_search_feature_enabled",
        step_started,
    );
    let step_started = Instant::now();
    let startup_flashgrep_path = configure_workspace_search_daemon_env();
    startup_trace.record_elapsed_step(
        "native_pre_tauri",
        "configure_workspace_search_daemon_env",
        step_started,
    );

    let step_started = Instant::now();
    let app_state = match AppState::new_async(token_usage_service).await {
        Ok(state) => state,
        Err(e) => {
            log::error!("Failed to initialize AppState: {}", e);
            return;
        }
    };
    startup_timings.record_elapsed("initialize_app_state", step_started);
    startup_trace.record_elapsed_step("native_pre_tauri", "initialize_app_state", step_started);

    // A Turn that is still executing exists nowhere durable but this log: the
    // persisted Session record stores a running Turn as idle so a restart never
    // revives work. Without it, a client returning to this device after the
    // process restarted is served a Turn frozen at the last checkpoint.
    let session_event_journal = Arc::new(match try_get_path_manager_arc() {
        Ok(path_manager) => SessionEventJournal::new().with_store(Arc::new(
            FileSessionProjectionStore::new(runtime_event_log_dir(&path_manager)),
        )),
        Err(error) => {
            log::warn!("Runtime event log disabled: application paths unavailable: {error}");
            SessionEventJournal::new()
        }
    });
    let step_started = Instant::now();
    let desktop_runtime = match runtime::DesktopRuntimeContext::build(
        coordinator.clone(),
        scheduler.clone(),
        app_state.token_usage_service.clone(),
        app_state.workspace_service.clone(),
        app_state.ssh_manager.clone(),
        app_state.acp_client_service.clone(),
        session_event_journal.clone(),
    ) {
        Ok(runtime) => runtime,
        Err(error) => {
            log::error!("Failed to initialize Desktop Agent Runtime: {}", error);
            return;
        }
    };
    startup_timings.record_elapsed("initialize_desktop_agent_runtime", step_started);
    startup_trace.record_elapsed_step(
        "native_pre_tauri",
        "initialize_desktop_agent_runtime",
        step_started,
    );

    let coordinator_state = CoordinatorState {
        coordinator: coordinator.clone(),
    };

    let scheduler_state = SchedulerState {
        scheduler: scheduler.clone(),
    };

    let terminal_state = api::terminal_api::TerminalState::new();

    let path_manager = get_path_manager_arc();
    let frontend_workbench = Arc::new(frontend_workbench::FrontendWorkbenchManager::new(
        &path_manager.user_data_dir(),
    ));

    let mut builder = tauri::Builder::default();
    let frontend_protocol_manager = Arc::clone(&frontend_workbench);
    builder = builder.register_uri_scheme_protocol(
        frontend_workbench::FRONTEND_PROTOCOL_SCHEME,
        move |_context, request| frontend_protocol_manager.protocol_response(request),
    );

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    {
        // The isolated embedded-WebDriver app must be able to run alongside a
        // developer's normal OpenBitFun instance. Its storage root and automation
        // port are already test-scoped, so joining the product single-instance
        // group would make the E2E child exit before WebDriver can attach.
        if !logging::is_embedded_webdriver_mode() {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                log::info!(
                    "Existing OpenBitFun Desktop instance received launch request: args_count={}, cwd={}",
                    args.len(),
                    cwd
                );
                handle_secondary_launch(app);
            }));
        }
    }

    let app = builder
        .plugin(logging::build_log_command_plugin())
        .plugin(logging::build_log_handoff_plugin(log_targets))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("OpenBitFun")
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The desktop owns validated snapshots and atomic writes. Do not install
        // window-state: its exit hook can overwrite repairs with stale cached data.
        .manage(window_state_support::MainWindowState::default())
        .manage(app_state)
        .manage(sleep_prevention::SleepPreventionState::default())
        .manage(desktop_runtime)
        .manage(coordinator_state)
        .manage(scheduler_state)
        .manage(path_manager)
        .manage(coordinator)
        .manage(scheduler)
        .manage(terminal_state)
        .manage(Arc::clone(&frontend_workbench))
        .manage(startup_trace.clone())
        .on_page_load(|webview, payload| {
            let label = webview.label();
            if label.starts_with("embedded-browser-view-")
                || label.starts_with("embedded-browser-panel-view-")
            {
                let event = match payload.event() {
                    tauri::webview::PageLoadEvent::Started => "started",
                    tauri::webview::PageLoadEvent::Finished => "finished",
                };
                let url = payload.url().to_string();
                api::browser_api::update_browser_target_url(label, &url);
                openbitfun_core::agentic::tools::browser_control::builtin_browser::publish_builtin_browser_page_load(
                    label,
                    event,
                    &url,
                );
                let _ = webview.emit_to(
                    "main",
                    BROWSER_WEBVIEW_PAGE_LOAD_EVENT,
                    serde_json::json!({
                        "label": label,
                        "event": event,
                        "url": url,
                    }),
                );
            }
        })
        .setup(move |app| {
            let setup_started = Instant::now();
            startup_trace.record_phase("tauri_setup_start", "native_setup");
            #[cfg(target_os = "macos")]
            {
                app.on_menu_event(|app, event| {
                    let event_name =
                        crate::macos_menubar::menu_event_name_for_id(event.id().as_ref());

                    if let Some(event_name) = event_name {
                        let _ = app.emit(event_name, ());
                    }
                });
            }

            let step_started = Instant::now();
            logging::register_runtime_log_state(startup_log_level, session_log_dir.clone());
            crash_diagnostics::log_previous_unexpected_exit_if_any();
            startup_trace.record_elapsed_step(
                "native_setup",
                "register_runtime_log_state_and_crash_diagnostics",
                step_started,
            );
            startup_trace.record_logging_ready_and_stop_persistence();

            let bundled_frontend = if cfg!(debug_assertions) {
                let development_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../..")
                    .join("dist");
                #[cfg(debug_assertions)]
                let development_dist = if std::env::var("OPENBITFUN_E2E_STORAGE_GUARD").as_deref() == Ok("1")
                    && std::env::var("OPENBITFUN_E2E_PACKAGED_FRONTEND").as_deref() == Ok("1")
                {
                    std::env::var_os("OPENBITFUN_E2E_FRONTEND_DIR").map(PathBuf::from).unwrap_or(development_dist)
                } else { development_dist };
                development_dist
                    .join("index.html")
                    .is_file()
                    .then_some(development_dist)
            } else {
                app.path()
                    .resolve("frontend/dist", tauri::path::BaseDirectory::Resource)
                    .ok()
                    .filter(|path| path.join("index.html").is_file())
            };
            if let Some(bundled_frontend) = bundled_frontend {
                if let Err(error) =
                    frontend_workbench.initialize(app.handle(), &bundled_frontend)
                {
                    log::error!(
                        "Failed to initialize the external frontend workbench: path={}, error={}",
                        bundled_frontend.display(),
                        error
                    );
                }
            } else {
                log::warn!(
                    "External frontend bundle is unavailable; Creative frontend editing will remain disabled"
                );
            }

            // Ensure the Tauri NSIS registry install-location key points to the
            // actual install directory, so that auto-updates respect the custom
            // install path chosen during initial installation.
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let step_started = Instant::now();

                if let Ok(exe) = std::env::current_exe() {
                    if let Some(install_dir) = exe.parent() {
                        let dir_str = install_dir.to_string_lossy();
                        let need_update =
                            match std::process::Command::new("reg")
                                .args([
                                    "query",
                                    r"HKCU\Software\OpenBitFun Team\OpenBitFun",
                                    "/ve",
                                ])
                                .creation_flags(CREATE_NO_WINDOW)
                                .output()
                            {
                                Ok(output) => {
                                    let stdout = String::from_utf8_lossy(&output.stdout);
                                    !stdout.contains(dir_str.as_ref())
                                }
                                Err(_) => true,
                            };
                        if need_update {
                            let _ = std::process::Command::new("reg")
                                .args([
                                    "add",
                                    r"HKCU\Software\OpenBitFun Team\OpenBitFun",
                                    "/ve",
                                    "/d",
                                    &dir_str,
                                    "/f",
                                ])
                                .creation_flags(CREATE_NO_WINDOW)
                                .status();
                            log::info!(
                                "Synced Tauri install-location registry to: {}",
                                install_dir.display()
                            );
                        }
                    }
                }
                startup_trace.record_elapsed_step(
                    "native_setup",
                    "sync_install_location_registry",
                    step_started,
                );
            }
            for step in startup_timings.steps() {
                log::debug!(
                    "Desktop startup step completed: step={}, duration_ms={}",
                    step.name,
                    step.duration_ms
                );
            }

            if workspace_search_enabled {
                let step_started = Instant::now();
                let flashgrep_path = startup_flashgrep_path.clone().or_else(|| {
                    let binary_names =
                        openbitfun_core::service::search::workspace_search_daemon_binary_names();
                    for binary_name in binary_names {
                        let primary = format!("flashgrep/{}", binary_name);
                        if let Ok(path) = app
                            .path()
                            .resolve(&primary, tauri::path::BaseDirectory::Resource)
                        {
                            if path.exists() {
                                return Some(path);
                            }
                        }
                    }

                    if let Ok(resource_dir) = app.path().resource_dir() {
                        for binary_name in binary_names {
                            for candidate in [
                                resource_dir.join("flashgrep").join(binary_name),
                                resource_dir.join("resources").join("flashgrep").join(binary_name),
                                resource_dir.join(binary_name),
                            ] {
                                if candidate.exists() {
                                    return Some(candidate);
                                }
                            }
                        }
                    }

                    None
                });
                if let Some(path) = flashgrep_path {
                    std::env::set_var("FLASHGREP_DAEMON_BIN", &path);
                    log::info!(
                        "Workspace search daemon startup check passed: path={}",
                        path.display()
                    );
                } else {
                    log::warn!(
                        "Workspace search daemon startup check failed: {}",
                        openbitfun_core::service::search::workspace_search_daemon_missing_hint()
                    );
                }
                startup_trace.record_elapsed_step(
                    "native_setup",
                    "resolve_workspace_search_daemon",
                    step_started,
                );
            }

            // Register bundled mobile-web resource path for remote connect.
            // tauri.conf.json maps "../../mobile-web/dist" -> "mobile-web/dist",
            // so the primary candidate is "mobile-web/dist". Additional fallbacks
            // handle legacy or non-standard bundle layouts.
            {
                let step_started = Instant::now();
                let candidates = ["mobile-web/dist", "mobile-web", "dist"];
                let mut found = false;
                for candidate in &candidates {
                    if let Ok(p) = app
                        .path()
                        .resolve(candidate, tauri::path::BaseDirectory::Resource)
                    {
                        if p.join("index.html").exists() {
                            log::info!("Found bundled mobile-web at: {}", p.display());
                            api::remote_connect_api::set_mobile_web_resource_path(p);
                            found = true;
                            break;
                        }
                    }
                }
                if !found {
                    // Last resort: scan the resource root for any index.html
                    if let Ok(res_dir) = app.path().resource_dir() {
                        for sub in &["mobile-web/dist", "mobile-web", "dist", ""] {
                            let p = if sub.is_empty() {
                                res_dir.clone()
                            } else {
                                res_dir.join(sub)
                            };
                            if p.join("index.html").exists() {
                                log::info!(
                                    "Found mobile-web via resource root scan: {}",
                                    p.display()
                                );
                                api::remote_connect_api::set_mobile_web_resource_path(p);
                                break;
                            }
                        }
                    }
                }
                startup_trace.record_elapsed_step(
                    "native_setup",
                    "resolve_mobile_web_resource",
                    step_started,
                );
            }

            let app_handle = app.handle().clone();
            let workspace_startup_bootstrap_snapshot = {
                let app_state: tauri::State<'_, api::app_state::AppState> = app.state();
                let startup_trace_state: tauri::State<'_, startup_trace::DesktopStartupTrace> =
                    app.state();
                // Cap how long a slow-disk workspace snapshot may delay window creation;
                // on timeout the frontend falls back to the existing
                // `initialize_workspace_startup_state` command path.
                const WORKSPACE_STARTUP_SNAPSHOT_TIMEOUT: std::time::Duration =
                    std::time::Duration::from_secs(4);
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        match tokio::time::timeout(
                            WORKSPACE_STARTUP_SNAPSHOT_TIMEOUT,
                            prepare_workspace_startup_bootstrap_snapshot(
                                &app_state,
                                &app_handle,
                                &startup_trace_state,
                            ),
                        )
                        .await
                        {
                            Ok(snapshot) => snapshot,
                            Err(_) => {
                                log::warn!(
                                    "Workspace startup bootstrap snapshot timed out after {:?}; frontend will fall back to the initialize_workspace_startup_state command",
                                    WORKSPACE_STARTUP_SNAPSHOT_TIMEOUT
                                );
                                None
                            }
                        }
                    })
                })
                .and_then(|snapshot| {
                    serde_json::to_value(snapshot)
                        .map_err(|error| {
                            log::warn!(
                                "Failed to serialize workspace startup bootstrap snapshot, frontend will fall back to startup command: {}",
                                error
                            );
                            error
                        })
                        .ok()
                })
            };
            let window_started = Instant::now();
            startup_trace.record_phase("main_window_create_start", "native_window");
            appearance::create_main_window(
                &app_handle,
                &startup_trace_id,
                &startup_trace,
                workspace_startup_bootstrap_snapshot,
                Arc::clone(&frontend_workbench),
            );
            let window_duration_ms = elapsed_ms(window_started);
            startup_trace.record_step(
                "native_step_end",
                "native_window",
                "create_main_window",
                window_duration_ms,
            );
            log::debug!(
                "Desktop startup step completed: step=create_main_window, duration_ms={}",
                window_duration_ms
            );
            let webdriver_started = Instant::now();
            openbitfun_webdriver::maybe_start(app_handle.clone());
            builtin_browser_host::install(app_handle.clone());
            openbitfun_control_host::install(app_handle.clone());
            startup_trace.record_elapsed_step(
                "native_setup",
                "maybe_start_webdriver",
                webdriver_started,
            );
            let window_phase_duration_ms = elapsed_ms(setup_started);
            let since_process_start_ms = elapsed_ms(startup_started);
            startup_trace.record_step(
                "native_step_end",
                "native_setup",
                "tauri_setup_until_main_window_created",
                window_phase_duration_ms,
            );
            startup_trace.record_phase("tauri_setup_window_phase_end", "native_setup");
            log::debug!(
                "Desktop startup timing: phase=tauri_setup_until_main_window_created, duration_ms={}, since_process_start_ms={}",
                window_phase_duration_ms,
                since_process_start_ms
            );

            #[cfg(target_os = "macos")]
            {
                let app_handle_for_menu = app.handle().clone();
                let app_state: tauri::State<'_, api::app_state::AppState> = app.state();
                let config_service = app_state.config_service.clone();
                let workspace_path = app_state.workspace_path.clone();
                let macos_edit_menu_mode = app_state.macos_edit_menu_mode.clone();

                tokio::spawn(async move {
                    let language = config_service
                        .get_config::<String>(Some("app.language"))
                        .await
                        .unwrap_or_else(|_| "zh-CN".to_string());

                    let has_workspace = workspace_path.read().await.is_some();
                    let mode = if has_workspace {
                        crate::macos_menubar::MenubarMode::Workspace
                    } else {
                        crate::macos_menubar::MenubarMode::Startup
                    };
                    let edit_mode = *macos_edit_menu_mode.read().await;

                    let _ = crate::macos_menubar::set_macos_menubar_with_mode(
                        &app_handle_for_menu,
                        &language,
                        mode,
                        edit_mode,
                    );
                });
            }

            let transport = Arc::new(TauriTransportAdapter::new(app_handle.clone()));

            let step_started = Instant::now();
            start_event_loop_with_transport(
                event_queue,
                event_router,
                transport,
                session_event_journal.clone(),
            );
            startup_trace.record_elapsed_step(
                "native_setup",
                "start_event_loop_with_transport",
                step_started,
            );

            // Eagerly initialize the remote connect service so previously
            // paired bots start listening immediately on app startup.
            let step_started = Instant::now();
            api::remote_connect_api::init_on_startup();
            startup_trace.record_elapsed_step(
                "native_setup",
                "remote_connect_init_on_startup",
                step_started,
            );

            // Reattach to a browser that is already running with remote
            // debugging on, so a OpenBitFun restart does not drop the connection.
            let step_started = Instant::now();
            api::browser_control_api::init_on_startup();
            startup_trace.record_elapsed_step(
                "native_setup",
                "browser_control_init_on_startup",
                step_started,
            );

            {
                let step_started = Instant::now();
                let _terminal_state: tauri::State<'_, api::terminal_api::TerminalState> =
                    app.state();
                let terminal_state_inner = api::terminal_api::TerminalState::new();
                let app_handle_clone = app_handle.clone();
                tokio::spawn(async move {
                    api::terminal_api::start_terminal_event_loop(
                        terminal_state_inner,
                        app_handle_clone,
                    );
                });
                startup_trace.record_elapsed_step(
                    "native_setup",
                    "spawn_terminal_event_loop",
                    step_started,
                );
            }

            let step_started = Instant::now();
            init_mcp_servers(app_handle.clone());
            startup_trace.record_elapsed_step("native_setup", "init_mcp_servers", step_started);
            let step_started = Instant::now();
            init_acp_clients(app_handle.clone());
            startup_trace.record_elapsed_step("native_setup", "init_acp_clients", step_started);

            let step_started = Instant::now();
            init_services(app_handle.clone(), startup_log_level);
            api::remote_connect_api::set_account_app_handle(app_handle.clone());
            sleep_prevention::spawn_config_listener(app_handle.clone());
            startup_trace.record_elapsed_step("native_setup", "init_services", step_started);

            let step_started = Instant::now();
            logging::spawn_log_cleanup_task();
            startup_trace.record_elapsed_step("native_setup", "spawn_log_cleanup_task", step_started);

            let step_started = Instant::now();
            startup_trace.record_elapsed_step("native_setup", "setup_tray_deferred", step_started);

            let setup_duration_ms = elapsed_ms(setup_started);
            let since_process_start_ms = elapsed_ms(startup_started);
            startup_trace.record_step(
                "native_step_end",
                "native_setup",
                "tauri_setup",
                setup_duration_ms,
            );
            startup_trace.record_phase("tauri_setup_end", "native_setup");
            log::debug!(
                "Desktop startup timing: phase=tauri_setup, duration_ms={}, since_process_start_ms={}",
                setup_duration_ms,
                since_process_start_ms
            );
            log::info!("OpenBitFun Desktop started successfully");
            Ok(())
        })
        .on_window_event({
            move |window, event| {
                if window.label() == "main"
                    && !MAIN_WINDOW_USES_TRANSIENT_GEOMETRY.load(Ordering::SeqCst)
                    && matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_))
                {
                    window_state_support::remember_normal(window);
                }
                if window.label() == "main"
                    && matches!(event, tauri::WindowEvent::CloseRequested { .. })
                {
                    save_main_window_state(window.app_handle(), "close_requested");
                }

                if let tauri::WindowEvent::CloseRequested { api: _api, .. } = event {
                    if window.label() == "main" {
                        #[cfg(target_os = "macos")]
                        {
                            _api.prevent_close();
                            if !begin_main_window_close_request_on_macos() {
                                return;
                            }

                            if let Err(error) = window.emit(MAIN_WINDOW_CLOSE_REQUESTED_EVENT, ()) {
                                log::warn!(
                                    "Failed to emit macOS main window close request event: {}",
                                    error
                                );
                            }

                            let app_handle = window.app_handle().clone();
                            tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    MAIN_WINDOW_CLOSE_FALLBACK_HIDE_MS,
                                ))
                                .await;

                                if take_main_window_close_request_on_macos() {
                                    if let Err(error) =
                                        hide_main_window_on_macos(&app_handle, "frontend_timeout")
                                    {
                                        log::warn!(
                                            "macOS close fallback hide failed after frontend timeout: {}",
                                            error
                                        );
                                    }
                                }
                            });
                        }
                    }
                }

                #[cfg(not(target_os = "macos"))]
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if window.label() == "main" {
                        // Prevent the OS from closing the window; let the frontend
                        // decide whether to minimize to tray, show a dialog, or quit.
                        api.prevent_close();
                        if let Err(error) = window.emit(MAIN_WINDOW_CLOSE_REQUESTED_EVENT, ()) {
                            log::warn!(
                                "Failed to emit main window close request event: {}",
                                error
                            );
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            appearance::show_main_window,
            frontend_workbench::frontend_update_candidate_ready,
            frontend_workbench::frontend_update_candidate_failed,
            frontend_workbench::get_frontend_update_status,
            frontend_workbench::confirm_frontend_update,
            frontend_workbench::rollback_frontend_update,
            hide_main_window_after_close_request,
            api::agentic_api::create_session,
            api::agentic_api::update_session_mode,
            api::agentic_api::update_session_model,
            api::agentic_api::update_session_permission_mode,
            api::agentic_api::update_active_turn_permission_mode,
            api::agentic_api::get_session_permission_mode,
            api::agentic_api::reload_session_context,
            api::agentic_api::update_session_title,
            api::agentic_api::ensure_coordinator_session,
            api::agentic_api::start_dialog_turn,
            api::agentic_api::compact_session,
            api::agentic_api::activate_session_goal,
            api::agentic_api::get_session_thread_goal,
            api::agentic_api::clear_session_thread_goal,
            api::agentic_api::set_session_thread_goal_status,
            api::agentic_api::update_session_thread_goal_objective,
            api::agentic_api::ensure_assistant_bootstrap,
            api::agentic_api::run_init_agents_md,
            api::agentic_api::cancel_dialog_turn,
            api::agentic_api::interrupt_dialog_turn,
            api::agentic_api::recover_interrupted_dialog_turn,
            api::agentic_api::steer_dialog_turn,
            api::agentic_api::control_deep_review_queue,
            api::agentic_api::cancel_session,
            api::agentic_api::set_subagent_timeout,
            api::agentic_api::control_background_command,
            api::agentic_api::send_background_command_input,
            api::agentic_api::read_background_command_output,
            api::agentic_api::list_background_command_activities,
            api::agentic_api::delete_session,
            api::agentic_api::restore_session,
            api::agentic_api::restore_session_view,
            api::agentic_api::load_session_event_backfill,
            api::agentic_api::load_session_turn_window,
            api::agentic_api::restore_session_with_turns,
            api::agentic_api::reset_memory,
            api::agentic_api::get_memory_paths,
            api::agentic_api::set_session_memory_mode,
            webdriver_bridge_result,
            get_startup_native_trace,
            api::agentic_api::list_sessions,
            api::agentic_api::list_pending_permission_requests,
            api::agentic_api::subscribe_permission_requests,
            api::agentic_api::respond_permission,
            api::agentic_api::respond_permission_batch,
            api::agentic_api::list_project_permission_grants,
            api::agentic_api::remove_project_permission_grant,
            api::agentic_api::clear_project_permission_grants,
            api::agentic_api::list_project_permission_audit,
            api::agentic_api::get_project_permission_rules,
            api::agentic_api::save_project_permission_rules,
            api::agentic_api::cancel_tool,
            api::agentic_api::generate_session_title,
            api::agentic_api::get_available_modes,
            api::agentic_api::get_default_review_team_definition,
            api::btw_api::btw_ask_stream,
            api::btw_api::btw_cancel,
            api::editor_ai_api::editor_ai_stream,
            api::editor_ai_api::editor_ai_cancel,
            get_external_hook_catalog,
            get_external_hook_import_snapshot,
            plan_external_hook_import_command,
            apply_external_hook_import_command,
            mutate_external_hook_import_command,
            get_external_source_snapshot,
            get_workspace_reference_snapshot,
            plan_external_mcp_import_command,
            apply_external_mcp_import_command,
            reveal_external_source_location,
            get_external_source_control_snapshot,
            apply_external_source_control_action_command,
            get_external_ecosystem_awareness_command,
            acknowledge_external_ecosystems_command,
            update_external_integration_policy_command,
            set_external_source_enabled_command,
            set_external_source_conflict_choice_command,
            get_native_prompt_command_conflicts_command,
            set_native_prompt_command_conflict_choice_command,
            expand_external_prompt_command_command,
            set_external_tool_target_decision_command,
            set_external_tool_targets_enabled_command,
            set_external_tool_conflict_choice_command,
            set_external_subagent_activation_command,
            set_external_subagents_enabled_command,
            set_external_subagent_model_binding_command,
            choose_external_subagent_conflict_command,
            set_external_mcp_server_decision_command,
            set_external_mcp_servers_enabled_command,
            choose_external_mcp_conflict_command,
            api::context_upload_api::upload_image_contexts,
            get_all_tools_info,
            get_chat_mcp_catalog,
            get_readonly_tools_info,
            get_tool_info,
            validate_tool_input,
            execute_tool,
            submit_user_answers,
            initialize_workspace_startup_state,
            get_available_tools,
            report_ide_control_result,
            openbitfun_control_host::mark_openbitfun_control_surface_ready,
            openbitfun_control_host::mark_openbitfun_control_surface_unready,
            openbitfun_control_host::product_control_invoke,
            openbitfun_control_host::report_openbitfun_control_result,
            get_health_status,
            get_statistics,
            test_ai_connection,
            test_ai_config_connection,
            list_ai_models_by_config,
            list_subscription_accounts,
            start_subscription_login,
            get_subscription_login_status,
            cancel_subscription_login,
            logout_subscription_account,
            refresh_subscription_account,
            initialize_ai,
            refresh_model_client,
            get_app_state,
            update_app_status,
            update_workspace_info,
            appearance::show_agent_companion_desktop_pet,
            appearance::hide_agent_companion_desktop_pet,
            appearance::resize_agent_companion_desktop_pet,
            list_agent_companion_pets,
            import_agent_companion_pet_package,
            delete_agent_companion_pet_package,
            read_file_content,
            write_file_content,
            reset_workspace_persona_files,
            check_path_exists,
            get_file_metadata,
            get_file_editor_sync_hash,
            rename_file,
            export_local_file_to_path,
            reveal_in_explorer,
            get_file_tree,
            explorer_get_file_tree,
            get_directory_children,
            explorer_get_children,
            get_directory_children_paginated,
            explorer_get_children_paginated,
            search_files,
            search_filenames,
            search_file_contents,
            search_get_repo_status,
            search_build_index,
            search_rebuild_index,
            start_search_filenames_stream,
            start_search_file_contents_stream,
            cancel_search,
            delete_file,
            delete_directory,
            create_file,
            create_directory,
            compress_path,
            decompress_path,
            list_directory_files,
            start_file_watch,
            stop_file_watch,
            get_watched_paths,
            get_clipboard_files,
            api::browser_file_drop_api::resolve_browser_dropped_file_paths,
            paste_files,
            get_config,
            get_configs,
            computer_use_get_status,
            computer_use_request_permissions,
            computer_use_open_system_settings,
            set_config,
            save_cloud_speech_config,
            get_web_search_credential_status,
            save_web_search_credential,
            clear_web_search_credential,
            reset_config,
            export_config,
            import_config,
            validate_config,
            reload_config,
            get_global_config_health,
            get_runtime_logging_info,
            export_diagnostics_bundle,
            append_flow_chat_diagnostics,
            get_runtime_capabilities,
            speech_list_models,
            speech_download_model,
            speech_cancel_model_download,
            speech_delete_model,
            speech_verify_model,
            speech_start_input_session,
            speech_append_audio_chunk,
            speech_finish_input_session,
            speech_cancel_input_session,
            speech_start_realtime_session,
            speech_append_realtime_audio,
            speech_commit_realtime_audio,
            speech_send_realtime_tool_result,
            speech_speak_realtime_text,
            speech_cancel_realtime_response,
            speech_close_realtime_session,
            speech_get_realtime_config,
            speech_save_realtime_config,
            get_agent_profile_configs,
            get_agent_profile_config,
            set_agent_profile_config,
            reset_agent_profile_config,
            list_subagents,
            list_visible_subagents,
            list_manageable_subagents,
            get_custom_agent_detail,
            create_custom_agent,
            update_custom_agent,
            delete_custom_agent,
            reload_custom_agents,
            get_subagent_detail,
            delete_subagent,
            create_subagent,
            update_subagent,
            reload_subagents,
            list_agent_tool_names,
            update_subagent_config,
            get_skill_configs,
            get_global_skill_settings,
            get_mode_skill_configs,
            list_skill_market,
            search_skill_market,
            download_skill_market,
            set_global_skill_disabled,
            set_mode_skill_disabled,
            replace_mode_skill_selection,
            reset_mode_skill_selection,
            validate_skill_path,
            add_skill,
            delete_skill,
            git_is_repository,
            git_get_repository_trust,
            git_trust_repository,
            git_get_repository_basic,
            git_resolve_revision,
            git_get_repository,
            review_platform_get_workspace_snapshot,
            review_platform_get_workspace_context,
            review_platform_get_pull_request_detail,
            review_platform_get_pull_request_review_target,
            review_platform_get_issue,
            review_platform_get_pull_request_review_target_by_identity,
            review_platform_get_pull_request_detail_page,
            review_platform_get_pull_request_ci_log,
            review_platform_update_auth_token,
            review_platform_clear_auth_token,
            git_get_status,
            git_get_branches,
            git_get_enhanced_branches,
            git_get_commits,
            git_add_files,
            git_commit,
            git_push,
            git_pull,
            git_checkout_branch,
            git_create_branch,
            git_delete_branch,
            git_get_diff,
            git_get_changed_files,
            git_reset_files,
            git_reset_to_commit,
            git_get_file_content,
            git_get_graph,
            git_cherry_pick,
            git_cherry_pick_abort,
            git_cherry_pick_continue,
            git_list_worktrees,
            git_add_worktree,
            git_remove_worktree,
            api::worktree_api::worktree_list,
            api::worktree_api::worktree_list_projects,
            api::worktree_api::worktree_create,
            api::worktree_api::worktree_create_branch,
            api::worktree_api::worktree_promote,
            api::worktree_api::worktree_remove,
            api::worktree_api::worktree_recreate,
            api::worktree_api::worktree_bind_session,
            generate_commit_message,
            quick_commit_message,
            save_git_repo_history,
            load_git_repo_history,
            preview_commit_message,
            compute_diff,
            apply_patch,
            save_merged_diff_content,
            rollback_session,
            rollback_session_to_turn,
            accept_session,
            accept_file,
            reject_file,
            get_session_files,
            get_session_turns,
            get_turn_files,
            get_file_diff,
            get_operation_diff,
            get_session_file_diff_stats,
            get_operation_summary,
            get_session_operations,
            accept_operation,
            reject_operation,
            get_session_stats,
            get_snapshot_system_stats,
            get_snapshot_sessions,
            check_git_isolation,
            get_file_change_history,
            get_all_modified_files,
            get_baseline_snapshot_diff,
            // Session persistence API
            list_persisted_sessions,
            search_session_content,
            search_referenceable_sessions,
            list_persisted_sessions_page,
            get_session_lineage,
            load_session_turns,
            get_session_usage_report,
            save_session_turn,
            save_session_metadata,
            export_session_transcript,
            delete_persisted_session,
            touch_session_activity,
            load_persisted_session_metadata,
            fork_session,
            archive_session,
            unarchive_session,
            archive_all_sessions,
            list_archived_sessions,
            delete_all_archived_sessions,
            initialize_mcp_servers,
            api::mcp_api::initialize_mcp_servers_non_destructive,
            get_mcp_servers,
            api::mcp_api::list_mcp_resources,
            api::mcp_api::read_mcp_resource,
            api::mcp_api::list_mcp_prompts,
            api::mcp_api::get_mcp_prompt,
            start_mcp_server,
            stop_mcp_server,
            restart_mcp_server,
            get_mcp_server_status,
            load_mcp_json_config,
            save_mcp_json_config,
            get_mcp_tool_ui_uri,
            fetch_mcp_app_resource,
            send_mcp_app_message,
            submit_mcp_interaction_response,
            update_mcp_remote_auth,
            clear_mcp_remote_auth,
            api::mcp_api::delete_mcp_server,
            api::mcp_api::start_mcp_remote_oauth,
            api::mcp_api::get_mcp_remote_oauth_session,
            api::mcp_api::cancel_mcp_remote_oauth,
            initialize_acp_clients,
            get_acp_clients,
            probe_acp_client_requirements,
            predownload_acp_client_adapter,
            install_acp_client_cli,
            stop_acp_client,
            load_acp_json_config,
            save_acp_json_config,
            submit_acp_permission_response,
            create_acp_flow_session,
            start_acp_dialog_turn,
            cancel_acp_dialog_turn,
            get_acp_session_options,
            get_acp_session_commands,
            set_acp_session_model,
            set_acp_session_config_option,
            get_global_config_status,
            get_model_configs,
            get_ai_model_catalog,
            project_ai_model_reasoning_catalog,
            get_models_dev_catalog_status,
            refresh_models_dev_catalog_now,
            reveal_models_dev_cache_directory,
            get_recent_workspaces,
            remove_recent_workspace,
            cleanup_invalid_workspaces,
            get_opened_workspaces,
            open_workspace,
            open_remote_workspace,
            create_assistant_workspace,
            get_primary_assistant_workspace,
            set_primary_assistant_workspace,
            delete_assistant_workspace,
            reset_assistant_workspace,
            close_workspace,
            set_active_workspace,
            reorder_opened_workspaces,
            get_current_workspace,
            scan_workspace_info,
            list_cron_jobs,
            create_cron_job,
            update_cron_job,
            delete_cron_job,
            notify_cron_host_ready,
            api::config_api::canonicalize_agent_profile_configs,
            api::terminal_api::terminal_get_shells,
            api::terminal_api::terminal_create,
            api::terminal_api::terminal_get,
            api::terminal_api::terminal_list,
            api::terminal_api::terminal_close,
            api::terminal_api::terminal_write,
            api::terminal_api::terminal_resize,
            api::terminal_api::terminal_signal,
            api::terminal_api::terminal_ack,
            api::terminal_api::terminal_execute,
            api::terminal_api::terminal_send_command,
            api::terminal_api::terminal_has_shell_integration,
            api::terminal_api::terminal_shutdown_all,
            api::terminal_api::terminal_get_history,
            get_system_info,
            get_app_version,
            check_for_updates,
            install_update,
            api::update_api::download_update,
            api::update_api::get_pending_update,
            api::update_api::install_pending_update,
            api::system_api::open_html_file_in_browser,
            restart_app,
            send_system_notification,
            api::system_api::quit_app,
            api::system_api::minimize_to_tray,
            api::system_api::initialize_tray_after_startup,
            api::system_api::startup_window_control,
            api::system_api::set_main_window_transient_geometry,
            api::system_api::toggle_main_window_fullscreen,
            sleep_prevention::get_prevent_sleep_enabled,
            sleep_prevention::set_prevent_sleep_enabled,
            check_command_exists,
            check_commands_exist,
            run_system_command,
            set_macos_edit_menu_mode,
            i18n_get_current_language,
            i18n_set_language,
            i18n_get_supported_languages,
            i18n_get_config,
            i18n_set_config,
            // Remote Connect
            api::remote_connect_api::remote_connect_get_device_info,
            api::remote_connect_api::remote_connect_get_lan_ip,
            api::remote_connect_api::remote_connect_get_lan_network_info,
            api::remote_connect_api::remote_connect_get_methods,
            api::remote_connect_api::remote_connect_start,
            api::remote_connect_api::remote_connect_stop,
            api::remote_connect_api::remote_connect_stop_bot,
            api::remote_connect_api::remote_connect_status,
            api::remote_connect_api::remote_connect_get_form_state,
            api::remote_connect_api::remote_connect_set_form_state,
            api::remote_connect_api::remote_connect_configure_bot,
            api::remote_connect_api::remote_connect_weixin_qr_start,
            api::remote_connect_api::remote_connect_weixin_qr_poll,
            api::remote_connect_api::remote_connect_get_bot_verbose_mode,
            api::remote_connect_api::remote_connect_set_bot_verbose_mode,
            // Account API
            api::account_identity_api::account_github_start,
            api::account_identity_api::account_github_poll,
            api::account_identity_api::account_github_info,
            api::remote_connect_api::account_login,
            api::remote_connect_api::account_status,
            api::remote_connect_api::account_logout,
            api::remote_connect_api::account_connect_devices,
            api::remote_connect_api::account_online_devices,
            api::remote_connect_api::account_execute_on_device,
            api::remote_connect_api::account_get_credential_hint,
            api::remote_connect_api::account_token_expired,
            api::remote_connect_api::account_list_devices,
            api::remote_connect_api::account_delete_device,
            api::remote_connect_api::account_device_rpc,
            // OpenBitFun Page API
            api::pages_api::page_publish,
            api::pages_api::page_save_version,
            api::pages_api::page_list,
            api::pages_api::page_list_versions,
            api::pages_api::page_create_open_link,
            api::pages_api::page_deploy,
            api::pages_api::page_delete_version,
            api::pages_api::page_update,
            api::pages_api::page_unpublish,
            api::pages_api::page_delete,
            api::peer_host_invoke::peer_host_invoke_complete,
            api::peer_host_invoke::peer_control_attach,
            api::peer_host_invoke::peer_control_detach,
            api::peer_host_invoke::peer_mode_ping,
            api::peer_host_invoke::peer_controller_set_active,
            // MiniApp API
            api::miniapp_api::list_miniapps,
            api::miniapp_api::get_miniapp,
            api::miniapp_api::create_miniapp,
            api::miniapp_api::update_miniapp,
            api::miniapp_api::delete_miniapp,
            api::miniapp_api::get_miniapp_versions,
            api::miniapp_api::rollback_miniapp,
            api::miniapp_api::get_miniapp_storage,
            api::miniapp_api::set_miniapp_storage,
            api::miniapp_api::grant_miniapp_workspace,
            api::miniapp_api::grant_miniapp_path,
            api::miniapp_api::miniapp_runtime_status,
            api::miniapp_api::miniapp_worker_call,
            api::miniapp_api::miniapp_host_call,
            api::canvas_api::load_canvas_artifact,
            api::canvas_api::load_canvas_state,
            api::canvas_api::report_canvas_runtime_error,
            api::canvas_api::report_canvas_runtime_ready,
            api::canvas_api::save_canvas_state,
            api::miniapp_api::miniapp_worker_stop,
            api::miniapp_api::miniapp_worker_list_running,
            api::miniapp_api::miniapp_install_deps,
            api::miniapp_api::miniapp_recompile,
            api::miniapp_api::miniapp_dialog_message,
            api::miniapp_api::miniapp_import_from_path,
            api::miniapp_api::miniapp_sync_from_fs,
            api::miniapp_api::miniapp_create_draft,
            api::miniapp_api::miniapp_get_draft,
            api::miniapp_api::miniapp_sync_draft_from_fs,
            api::miniapp_api::miniapp_set_draft_permissions,
            api::miniapp_api::miniapp_permission_diff_for_draft,
            api::miniapp_api::miniapp_apply_draft,
            api::miniapp_api::miniapp_discard_draft,
            api::miniapp_api::get_miniapp_draft_storage,
            api::miniapp_api::set_miniapp_draft_storage,
            api::miniapp_api::miniapp_draft_worker_call,
            api::miniapp_api::miniapp_draft_host_call,
            api::miniapp_api::miniapp_draft_worker_stop,
            api::miniapp_api::miniapp_get_customization_metadata,
            api::miniapp_api::miniapp_decline_builtin_update,
            api::miniapp_market_api::miniapp_market_browse,
            api::market_image_api::market_image_load,
            api::miniapp_market_api::miniapp_market_get_listing,
            api::miniapp_market_api::miniapp_market_capture_window,
            api::miniapp_market_api::miniapp_market_set_rating,
            api::miniapp_market_api::miniapp_market_set_favorite,
            api::miniapp_market_api::miniapp_market_list_submissions,
            api::miniapp_market_api::miniapp_market_withdraw_submission,
            api::miniapp_market_api::miniapp_market_installed_status,
            api::miniapp_market_api::miniapp_market_installed_origins,
            api::miniapp_market_api::miniapp_market_install,
            api::miniapp_market_api::miniapp_market_import_package,
            api::miniapp_market_api::miniapp_market_inspect_package,
            api::miniapp_market_api::miniapp_market_submit_installed,
            api::appearance_market_api::appearance_market_browse,
            api::appearance_market_api::appearance_market_get_listing,
            api::appearance_market_api::appearance_market_download_release,
            api::appearance_market_api::appearance_market_list_submissions,
            api::appearance_market_api::appearance_market_submit_package,
            api::appearance_market_api::appearance_market_withdraw_submission,
            api::appearance_market_api::appearance_market_list_review_submissions,
            api::appearance_market_api::appearance_market_get_review_submission,
            api::appearance_market_api::appearance_market_review_submission,
            api::miniapp_api::miniapp_ai_complete,
            api::miniapp_api::miniapp_ai_chat,
            api::miniapp_api::miniapp_ai_cancel,
            api::miniapp_api::miniapp_ai_list_models,
            api::miniapp_agent_api::miniapp_agent_ensure_session,
            api::miniapp_agent_api::miniapp_agent_run,
            api::miniapp_agent_api::miniapp_agent_cancel,
            api::miniapp_agent_api::miniapp_agent_turn_text,
            api::miniapp_agent_api::miniapp_agent_cancel_stale_runs,
            api::miniapp_export_api::miniapp_render_slide_page,
            // Browser API (embedded webview)
            api::browser_api::browser_webview_eval,
            api::browser_api::browser_webview_create,
            api::browser_api::browser_webview_navigate,
            api::browser_api::browser_webview_reload,
            api::browser_api::browser_webview_set_bounds,
            api::browser_api::browser_webview_capture_preview,
            api::browser_api::browser_webview_set_agent_target_state,
            api::browser_api::browser_get_url,
            api::html_preview_api::html_preview_create,
            api::html_preview_api::html_preview_release,
            // Browser Control API (CDP-based user browser control)
            api::browser_control_api::browser_control_list_browsers,
            api::browser_control_api::browser_control_get_status,
            api::browser_control_api::browser_control_launch,
            api::browser_control_api::browser_control_enable_default_cdp,
            api::browser_control_api::browser_control_restart_with_cdp,
            api::browser_control_api::browser_control_disconnect,
            // Insights API
            api::insights_api::generate_insights,
            api::insights_api::get_latest_insights,
            api::insights_api::load_insights_report,
            api::insights_api::has_insights_data,
            api::insights_api::cancel_insights_generation,
            // Token usage statistics API
            api::token_usage_api::get_token_usage_statistics,
            // SSH Remote API
            api::ssh_api::ssh_list_saved_connections,
            api::ssh_api::ssh_save_connection,
            api::ssh_api::ssh_delete_connection,
            api::ssh_api::ssh_has_stored_password,
            api::ssh_api::ssh_connect,
            api::ssh_api::ssh_test_connection,
            api::ssh_api::ssh_list_docker_containers,
            api::ssh_api::ssh_list_wsl_distributions,
            api::ssh_api::ssh_disconnect,
            api::ssh_api::ssh_disconnect_all,
            api::ssh_api::ssh_is_connected,
            api::ssh_api::ssh_get_server_info,
            api::ssh_api::ssh_get_config,
            api::ssh_api::ssh_list_config_hosts,
            api::ssh_api::remote_read_file,
            api::ssh_api::remote_write_file,
            api::ssh_api::remote_exists,
            api::ssh_api::remote_read_dir,
            api::ssh_api::remote_get_tree,
            api::ssh_api::remote_create_dir,
            api::ssh_api::remote_remove,
            api::ssh_api::remote_rename,
            api::ssh_api::remote_download_to_local_path,
            api::ssh_api::remote_upload_from_local_path,
            api::ssh_api::cancel_transfer,
            api::ssh_api::remote_execute,
            api::ssh_api::remote_open_workspace,
            api::ssh_api::remote_close_workspace,
            api::ssh_api::remote_remove_workspace,
            api::ssh_api::remote_get_workspace_info,
            // Remote port forwarding (local `-L` mappings, user-driven)
            api::ssh_api::ssh_start_port_forward,
            api::ssh_api::ssh_stop_port_forward,
            api::ssh_api::ssh_list_port_forwards,
            api::ssh_api::ssh_list_remote_listening_ports,
            // Detached task dispatch (controller-side SSH transport)
            api::dispatch_api::dispatch_list_targets,
            api::dispatch_api::dispatch_probe_target,
            api::dispatch_api::dispatch_install_cli_start,
            api::dispatch_api::dispatch_install_cli_poll,
            api::dispatch_api::dispatch_install_cli_cancel,
            api::dispatch_api::dispatch_provision_target,
            api::dispatch_api::dispatch_sync_model_config,
            api::dispatch_api::dispatch_submit,
            api::dispatch_api::dispatch_status,
            api::dispatch_api::dispatch_cancel,
            api::dispatch_api::dispatch_sync_result,
            api::dispatch_api::dispatch_list_jobs,
            api::dispatch_api::dispatch_answer,
            api::dispatch_api::dispatch_append,
            api::dispatch_api::dispatch_continue,
            api::dispatch_api::dispatch_query,
            api::dispatch_api::dispatch_load_transcript,
            api::dispatch_api::dispatch_save_transcript,
            // Relay self-deploy API
            // Announcement / feature-demo / tips API
            api::announcement_api::get_pending_announcements,
            api::announcement_api::mark_announcement_seen,
            api::announcement_api::dismiss_announcement,
            api::announcement_api::never_show_announcement,
            api::announcement_api::trigger_announcement,
            api::announcement_api::get_announcement_tips,
            // Debug API (no-op stubs in release builds)
            api::debug_api::debug_devtools_available,
            api::debug_api::debug_element_picked,
            api::debug_api::debug_open_devtools,
            api::debug_api::debug_close_devtools,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => {
            app.run(|app_handle, event| match event {
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if !PROCESS_EXIT_CLEANUP_COMPLETE.load(Ordering::Acquire) {
                        api.prevent_exit();
                        request_desktop_exit(app_handle, code.unwrap_or(0), "tauri_exit_requested");
                    }
                }
                tauri::RunEvent::Exit => {
                    perform_process_exit_cleanup_emergency();
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    let reason = if has_visible_windows {
                        "dock_reopen_with_visible_aux_window"
                    } else {
                        "dock_reopen_no_visible_windows"
                    };
                    show_main_window_on_macos(app_handle, reason);
                }
                _ => {}
            });
        }
        Err(e) => {
            log::error!("Error while running tauri application: {}", e);
        }
    }
}

async fn init_agentic_system() -> anyhow::Result<(
    Arc<openbitfun_core::agentic::coordination::ConversationCoordinator>,
    Arc<openbitfun_core::agentic::coordination::DialogScheduler>,
    Arc<openbitfun_core::agentic::events::EventQueue>,
    Arc<openbitfun_core::agentic::events::EventRouter>,
    Arc<AIClientFactory>,
    Arc<openbitfun_core::service::token_usage::TokenUsageService>,
)> {
    use openbitfun_core::agentic::*;

    let ai_client_factory = AIClientFactory::get_global().await?;

    let event_queue = Arc::new(events::EventQueue::new(Default::default()));
    let event_router = Arc::new(events::EventRouter::new());

    let path_manager = try_get_path_manager_arc()?;
    let persistence_manager = Arc::new(persistence::PersistenceManager::new(path_manager.clone())?);

    let context_store = Arc::new(session::SessionContextStore::new());
    let context_compressor = Arc::new(session::ContextCompressor::new(Default::default()));

    let session_manager = Arc::new(session::SessionManager::new(
        context_store,
        persistence_manager,
        Default::default(),
    ));

    let tool_registry = tools::registry::get_global_tool_registry();
    let tool_state_manager = Arc::new(tools::pipeline::ToolStateManager::new(event_queue.clone()));
    let permission_request_manager =
        openbitfun_core::product_runtime::core_permission_request_manager()
            .map_err(anyhow::Error::msg)?;

    let computer_use_host: ComputerUseHostRef =
        Arc::new(computer_use::DesktopComputerUseHost::new());
    set_computer_use_desktop_available(true);

    let tool_pipeline = Arc::new(
        tools::pipeline::ToolPipeline::new(
            tool_registry,
            tool_state_manager,
            Some(computer_use_host),
        )
        .with_permission_request_manager(permission_request_manager),
    );

    let stream_processor = Arc::new(execution::StreamProcessor::new(event_queue.clone()));
    let round_executor = Arc::new(execution::RoundExecutor::new(
        stream_processor,
        event_queue.clone(),
        tool_pipeline.clone(),
    ));

    let execution_config = execution::execution_engine_config_from_global_config().await;

    let execution_engine = Arc::new(execution::ExecutionEngine::new(
        round_executor,
        event_queue.clone(),
        session_manager.clone(),
        context_compressor,
        execution_config,
    ));

    let runtime_ownership = Arc::new(
        openbitfun_core::runtime_ownership::CoreRuntimeOwnership::embedded(
            path_manager.as_ref(),
            "desktop",
        ),
    );
    let coordinator = Arc::new(coordination::ConversationCoordinator::new(
        session_manager.clone(),
        execution_engine,
        tool_pipeline,
        event_queue.clone(),
        event_router.clone(),
        runtime_ownership,
    ));
    coordinator.set_terminal_port(
        openbitfun_core::product_runtime::CoreRuntimeServicesProvider::terminal_port(),
    );
    coordinator.set_remote_exec_port(
        openbitfun_core::product_runtime::CoreRuntimeServicesProvider::remote_exec_port(),
    );

    coordination::ConversationCoordinator::set_global(coordinator.clone());

    // Initialize token usage service and register subscriber
    let token_usage_service = Arc::new(
        openbitfun_core::service::token_usage::TokenUsageService::new(path_manager.clone())
            .await
            .map_err(|e| anyhow::anyhow!("Failed to initialize token usage service: {}", e))?,
    );
    let token_usage_subscriber = Arc::new(
        openbitfun_core::service::token_usage::TokenUsageSubscriber::new(
            token_usage_service.clone(),
        ),
    );
    event_router.subscribe_internal("token_usage".to_string(), token_usage_subscriber);
    event_router.subscribe_internal(
        "session_context_usage".to_string(),
        Arc::new(
            openbitfun_core::agentic::session::SessionContextUsageSubscriber::new(
                session_manager.clone(),
            ),
        ),
    );
    event_router.subscribe_internal(
        "thread_goal_tokens".to_string(),
        Arc::new(openbitfun_core::agentic::goal_mode::ThreadGoalTokenSubscriber),
    );

    log::info!("Token usage service initialized and subscriber registered");

    // Create the DialogScheduler and wire up the outcome notification channel
    let scheduler =
        coordination::DialogScheduler::new(coordinator.clone(), session_manager.clone());
    coordinator.set_scheduler_notifier(scheduler.outcome_sender());
    coordinator.set_round_injection_source(scheduler.round_injection_monitor());
    coordination::set_global_scheduler(scheduler.clone());
    api::remote_connect_api::set_dialog_scheduler(scheduler.clone());

    let cron_service = openbitfun_core::service::cron::CronService::new(
        path_manager.clone(),
        coordinator.clone(),
        scheduler.clone(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("Failed to initialize cron service: {}", e))?;
    openbitfun_core::service::cron::set_global_cron_service(cron_service.clone());
    let cron_subscriber = Arc::new(openbitfun_core::service::cron::CronEventSubscriber::new(
        cron_service.clone(),
    ));
    event_router.subscribe_internal("cron_jobs".to_string(), cron_subscriber);
    {
        let cron_service_for_fallback = cron_service.clone();
        // Desktop cron runs can emit FlowChat events immediately. Prefer the
        // frontend readiness handshake, but keep a fallback so cron is not left
        // disabled if the web host never reaches the ready path.
        tokio::spawn(async move {
            tokio::time::sleep(CRON_DESKTOP_START_FALLBACK_DELAY).await;
            log::info!(
                "Ensuring cron service is started after desktop fallback delay: delay_seconds={}",
                CRON_DESKTOP_START_FALLBACK_DELAY.as_secs()
            );
            cron_service_for_fallback.start();
        });
    }

    log::info!("Cron service initialized and waiting for desktop host readiness");
    log::info!("Agentic system initialized");
    Ok((
        coordinator,
        scheduler,
        event_queue,
        event_router,
        ai_client_factory,
        token_usage_service,
    ))
}

async fn init_function_agents(ai_client_factory: Arc<AIClientFactory>) -> anyhow::Result<()> {
    let _ = openbitfun_core::function_agents::git_func_agent::GitFunctionAgent::new(
        ai_client_factory.clone(),
    );

    Ok(())
}

fn init_mcp_servers(app_handle: tauri::AppHandle) {
    tokio::spawn(async move {
        let _ = app_handle;
    });
}

fn init_acp_clients(app_handle: tauri::AppHandle) {
    tokio::spawn(async move {
        let state: tauri::State<'_, api::AppState> = app_handle.state();
        if let Some(service) = state.acp_client_service.as_ref() {
            if let Err(error) = service.initialize_all().await {
                log::warn!("Failed to initialize ACP clients: {}", error);
            }
        }
    });
}

fn setup_panic_hook() {
    std::panic::set_hook(Box::new(move |panic_info| {
        let thread = std::thread::current();
        let thread_name = thread.name().map(str::to_string);
        let thread_id = format!("{:?}", thread.id());
        let is_main_thread = thread_name.as_deref() == Some("main") || thread_name.is_none(); // unnamed threads in simple test contexts

        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());

        let message = panic_info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| {
                panic_info
                    .payload()
                    .downcast_ref::<String>()
                    .map(String::as_str)
            })
            .unwrap_or("unknown panic message");

        log::error!(
            "Application panic at {} (thread={:?}, id={}, main={}): {}",
            location,
            thread_name,
            thread_id,
            is_main_thread,
            message,
        );
        crate::crash_diagnostics::write_panic_report(
            location.clone(),
            message.to_string(),
            thread_name.clone(),
            thread_id,
        );

        // Known wry bug: WKWebView.URL() returns nil after navigating to an
        // invalid address, causing url_from_webview to panic on unwrap().
        // This is non-fatal — the webview is still alive — so we log and
        // continue instead of killing the process.
        // See: https://github.com/tauri-apps/wry/pull/1554
        if location.contains("wry") && location.contains("wkwebview") {
            log::warn!("Suppressed non-fatal wry/wkwebview panic, application continues");
            return;
        }

        if message.contains("WSAStartup") || message.contains("10093") || message.contains("hyper")
        {
            log::error!("Network-related crash detected, possible solutions:");
            log::error!("  1) Restart the application");
            log::error!("  2) Check Windows network service status");
            log::error!("  3) Run as administrator");
        }

        // ── Recovery strategy ──────────────────────────────────────────
        // Main-thread panics are unrecoverable — the event loop is gone.
        // Spawned-thread panics only kill that thread; the rest of the
        // application can continue.  We log a clear message and skip the
        // hard exit so the user isn't forced to restart.
        if !is_main_thread {
            log::warn!(
                "Non-main thread panicked — application will continue. \
                 The affected feature may be degraded until the next restart."
            );
            return;
        }

        perform_process_exit_cleanup_emergency();
        std::process::exit(1);
    }));
}

static PROCESS_EXIT_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);
static PROCESS_EXIT_CLEANUP_COMPLETE: AtomicBool = AtomicBool::new(false);
static DESKTOP_EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
static PROCESS_EXIT_CLEANUP_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();

pub(crate) async fn perform_process_exit_cleanup() -> bool {
    let notify = PROCESS_EXIT_CLEANUP_NOTIFY.get_or_init(tokio::sync::Notify::new);
    if PROCESS_EXIT_CLEANUP_STARTED.swap(true, Ordering::AcqRel) {
        loop {
            let notified = notify.notified();
            if PROCESS_EXIT_CLEANUP_COMPLETE.load(Ordering::Acquire) {
                return false;
            }
            notified.await;
        }
    }

    log::info!("Desktop process graceful shutdown started");
    match openbitfun_core::plugin_host::shutdown_configured_plugin_host().await {
        Ok(Some(report)) => log::info!(
            "Desktop plugin host shutdown completed: generation={}, disposition={:?}, rpc_completed={}, exit_code={:?}, duration_ms={}",
            report.generation,
            report.disposition,
            report.rpc_completed,
            report.exit_code,
            report.duration_ms
        ),
        Ok(None) => log::debug!("Desktop plugin host shutdown skipped: host not started"),
        Err(error) => log::warn!("Desktop plugin host shutdown failed: {}", error),
    }
    if let Some(search_service) = get_global_workspace_search_service() {
        search_service.shutdown_blocking();
    }
    openbitfun_core::util::process_manager::cleanup_all_processes();
    api::remote_connect_api::cleanup_on_exit();
    PROCESS_EXIT_CLEANUP_COMPLETE.store(true, Ordering::Release);
    notify.notify_waiters();
    log::info!("Desktop process graceful shutdown completed");
    true
}

pub(crate) fn request_desktop_exit(app: &tauri::AppHandle, exit_code: i32, reason: &'static str) {
    if DESKTOP_EXIT_REQUESTED.swap(true, Ordering::AcqRel) {
        return;
    }
    save_main_window_state(app, reason);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        perform_process_exit_cleanup().await;
        crash_diagnostics::mark_clean_shutdown(reason);
        log::info!(
            "Desktop exit authorized after graceful shutdown: reason={}, exit_code={}",
            reason,
            exit_code
        );
        app.exit(exit_code);
    });
}

pub(crate) fn perform_process_exit_cleanup_emergency() -> bool {
    if PROCESS_EXIT_CLEANUP_COMPLETE.load(Ordering::Acquire) {
        return false;
    }
    log::warn!("Desktop emergency process cleanup started");
    if let Some(search_service) = get_global_workspace_search_service() {
        search_service.shutdown_blocking();
    }
    openbitfun_core::util::process_manager::cleanup_all_processes();
    api::remote_connect_api::cleanup_on_exit();
    true
}

fn configure_workspace_search_daemon_env() -> Option<std::path::PathBuf> {
    let path = openbitfun_core::service::search::resolve_workspace_search_daemon_program_path();
    if let Some(path) = path.as_ref() {
        std::env::set_var("FLASHGREP_DAEMON_BIN", path);
    }
    path
}

/// Deliver one event to the WebView and, when peer controllers are attached,
/// fan it out to paired devices. Text chunks arrive here already coalesced by
/// `TextChunkCoalescer`.
async fn deliver_event_to_webview(
    transport: &TauriTransportAdapter,
    event: AgenticEvent,
    session_event_journal: &SessionEventJournal,
) {
    let cursor = session_event_journal.record(&event);
    let Some(mut projected) = openbitfun_events::project_agentic_frontend_event(event) else {
        log::warn!("Unhandled AgenticEvent type in desktop delivery");
        return;
    };
    if let Some(cursor) = cursor {
        attach_session_event_cursor(&mut projected.payload, cursor);
    }

    if let Err(e) = transport
        .emit_generic(&projected.event_name, projected.payload.clone())
        .await
    {
        log::error!("Failed to emit event: {:?}", e);
    }

    if !api::peer_host_invoke::attached_controllers().is_empty() {
        api::remote_connect_api::fanout_peer_device_event(projected.event_name, projected.payload);
    }
}

/// Update the rate EMA from a flush that produced `flushed_chars` characters.
///
/// `arm_time` is when the flushed window was armed (the first buffered chunk).
/// When there is a recorded previous flush, the elapsed interval is measured
/// from that point so that an idle gap longer than `RATE_EMA_RESET_MS` resets
/// the estimate instead of blending the old stream's rate into the new one.
fn update_rate_after_flush(
    rate_ema: &mut f64,
    flushed_chars: usize,
    arm_time: tokio::time::Instant,
    last_flush_time: &mut Option<tokio::time::Instant>,
) {
    let now = tokio::time::Instant::now();
    let elapsed = last_flush_time
        .map(|t| now - t)
        .unwrap_or_else(|| arm_time.elapsed());
    *rate_ema = crate::api::event_coalescer::update_rate_ema(*rate_ema, flushed_chars, elapsed);
    *last_flush_time = Some(now);
}

/// Flush all buffered chunks as merged events and feed the flushed content
/// volume back into the rate estimate that sizes the next window.
async fn flush_coalesced<D, F>(
    deliver: &mut D,
    coalescer: &mut crate::api::event_coalescer::TextChunkCoalescer,
    rate_ema: &mut f64,
    arm_time: tokio::time::Instant,
    last_flush_time: &mut Option<tokio::time::Instant>,
) where
    D: FnMut(AgenticEvent) -> F,
    F: std::future::Future<Output = ()>,
{
    let flushed_chars = coalescer.buffered_chars();
    update_rate_after_flush(rate_ema, flushed_chars, arm_time, last_flush_time);
    for event in coalescer.flush() {
        deliver(event).await;
    }
}

/// Drive the agentic event queue: route raw events to internal subscribers,
/// coalesce streamed text chunks, and deliver merged events through `deliver`.
///
/// Scheduling contract:
/// - The coalescing window is armed as soon as the first chunk is buffered
///   (even while the queue is still being drained), so the window counts from
///   the first chunk, not from the end of the drain.
/// - The window timer is only polled at the outer `select!`. Under sustained
///   load the queue may stay non-empty and the drain loop never exits, so an
///   expired deadline is also honored inside the drain: the buffered text is
///   flushed in place before processing continues. Text therefore waits at
///   most one window regardless of queue pressure.
async fn event_loop_driver<D, F>(
    event_queue: Arc<openbitfun_core::agentic::events::EventQueue>,
    event_router: Arc<openbitfun_core::agentic::events::EventRouter>,
    mut deliver: D,
) where
    D: FnMut(AgenticEvent) -> F,
    F: std::future::Future<Output = ()>,
{
    use crate::api::event_coalescer::{
        next_flush_deadline, next_window, TextChunkCoalescer, INITIAL_RATE_EMA_CPS,
    };
    use tokio::time::{sleep_until, Instant};

    let mut coalescer = TextChunkCoalescer::new();
    let mut flush_deadline: Option<Instant> = None;
    // Instant at which the current `flush_deadline` was armed. Kept in sync
    // with the deadline so flushes can measure the actual window elapsed.
    let mut flush_arm_time: Option<Instant> = None;
    // Instant of the previous flush. Used to detect idle gaps that should
    // reset the stream-rate EMA.
    let mut last_flush_time: Option<Instant> = None;
    // Measured stream rate (chars/sec), blended per window flush. Starts at
    // the reference rate so the first window matches the previous fixed
    // 50ms behavior.
    let mut rate_ema = INITIAL_RATE_EMA_CPS;
    let mut last_window = next_window(rate_ema);

    loop {
        let window_timer = async {
            match flush_deadline {
                Some(deadline) => sleep_until(deadline).await,
                // No buffered chunks: wait for the queue without a timer.
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            _ = event_queue.wait_for_events() => {
                loop {
                    let batch = event_queue.dequeue_configured_batch().await;
                    if batch.is_empty() {
                        break;
                    }

                    for envelope in batch {
                        // Route to internal subscribers (e.g. RemoteSessionStateTracker)
                        // sequentially so that text chunks are appended in order.
                        // Internal routing stays on the raw events; only the
                        // WebView / peer delivery below is coalesced.
                        if let Err(e) = event_router.route(envelope.clone()).await {
                            log::warn!("Internal event routing failed: {:?}", e);
                        }

                        // A non-chunk event flushes pending text immediately.
                        // Capture the flushed volume and the arm time before the
                        // coalescer drains, then feed it into the rate estimate
                        // through the same path as a timer-driven flush.
                        let pre_flush_chars = coalescer.buffered_chars();
                        let arm_time = flush_arm_time;
                        let pushed = coalescer.push(envelope.event);
                        let did_flush = !pushed.is_empty();

                        for event in pushed {
                            deliver(event).await;
                        }

                        if did_flush && pre_flush_chars > 0 {
                            if let Some(arm) = arm_time {
                                update_rate_after_flush(
                                    &mut rate_ema,
                                    pre_flush_chars,
                                    arm,
                                    &mut last_flush_time,
                                );
                            }
                        }

                        // Arm the coalescing window as soon as the first chunk
                        // is buffered so the window counts while the drain is
                        // still running; clear a stale deadline when a flush
                        // (e.g. a non-chunk event) drained the buffer.
                        if coalescer.is_pending() && flush_deadline.is_none() {
                            last_window = next_window(rate_ema);
                        }
                        let now = Instant::now();
                        let new_deadline = next_flush_deadline(
                            coalescer.is_pending(),
                            flush_deadline,
                            now,
                            last_window,
                        );
                        // Keep the arm time in sync with the deadline: record
                        // it when the window is armed, clear it when drained.
                        match (flush_deadline, new_deadline) {
                            (None, Some(_)) => flush_arm_time = Some(now),
                            (Some(_), None) => flush_arm_time = None,
                            _ => {}
                        }
                        flush_deadline = new_deadline;
                    }

                    // The window timer is only polled at the outer select, but
                    // the queue may stay non-empty under sustained load. Honor
                    // an expired deadline here so the throttle semantics hold
                    // (text waits at most one window) no matter how busy the
                    // queue is.
                    if flush_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                        let arm_time = flush_arm_time
                            .expect("arm_time must be set when a deadline is armed");
                        flush_deadline = None;
                        flush_arm_time = None;
                        flush_coalesced(
                            &mut deliver,
                            &mut coalescer,
                            &mut rate_ema,
                            arm_time,
                            &mut last_flush_time,
                        )
                        .await;
                    }
                }
            }
            _ = window_timer => {
                let arm_time = flush_arm_time
                    .expect("arm_time must be set when a deadline is armed");
                flush_deadline = None;
                flush_arm_time = None;
                flush_coalesced(
                    &mut deliver,
                    &mut coalescer,
                    &mut rate_ema,
                    arm_time,
                    &mut last_flush_time,
                )
                .await;
            }
        }
    }
}

fn start_event_loop_with_transport(
    event_queue: Arc<openbitfun_core::agentic::events::EventQueue>,
    event_router: Arc<openbitfun_core::agentic::events::EventRouter>,
    transport: Arc<TauriTransportAdapter>,
    session_event_journal: Arc<SessionEventJournal>,
) {
    tokio::spawn(async move {
        event_loop_driver(event_queue, event_router, |event| {
            let transport = transport.clone();
            let session_event_journal = session_event_journal.clone();
            async move {
                deliver_event_to_webview(&transport, event, &session_event_journal).await;
            }
        })
        .await;
    });
}

fn init_services(app_handle: tauri::AppHandle, default_log_level: log::LevelFilter) {
    use openbitfun_core::{infrastructure, service};

    spawn_runtime_log_level_listener(default_log_level);
    spawn_workspace_search_feature_listener(app_handle.clone());

    tokio::spawn(async move {
        let transport = Arc::new(TauriTransportAdapter::new(app_handle.clone()));
        let emitter = create_event_emitter(transport);
        let workspace_identity_watch_service = {
            let app_state: tauri::State<'_, api::app_state::AppState> = app_handle.state();
            app_state.workspace_identity_watch_service.clone()
        };

        service::snapshot::initialize_snapshot_event_emitter(emitter.clone());

        openbitfun_core::service::initialize_file_watch_service(emitter.clone());

        if let Err(e) = workspace_identity_watch_service
            .set_event_emitter(emitter.clone())
            .await
        {
            log::error!(
                "Failed to initialize workspace identity watch service: {}",
                e
            );
        }

        let event_system = infrastructure::events::get_global_event_system();
        event_system.set_emitter(emitter).await;
    });
}

async fn resolve_runtime_log_level(default_level: log::LevelFilter) -> log::LevelFilter {
    use openbitfun_core::service::config::get_global_config_service;

    if let Ok(config_service) = get_global_config_service().await {
        if let Ok(config_level) = config_service
            .get_config::<String>(Some("app.logging.level"))
            .await
        {
            if let Some(level) = logging::parse_log_level(&config_level) {
                return level;
            }
            log::warn!(
                "Invalid app.logging.level '{}', falling back to default={}",
                config_level,
                logging::level_to_str(default_level)
            );
        }
    }

    default_level
}

fn spawn_runtime_log_level_listener(default_level: log::LevelFilter) {
    use openbitfun_core::service::config::{subscribe_config_updates, ConfigUpdateEvent};

    tokio::spawn(async move {
        if let Some(mut receiver) = subscribe_config_updates() {
            loop {
                match receiver.recv().await {
                    Ok(ConfigUpdateEvent::LogLevelUpdated { new_level }) => {
                        if let Some(level) = logging::parse_log_level(&new_level) {
                            logging::apply_runtime_log_level(level, "config_update_event");
                            if let Err(error) =
                                openbitfun_core::plugin_host::set_configured_plugin_host_log_level(
                                    logging::level_to_str(level),
                                )
                                .await
                            {
                                log::warn!("Failed to update plugin host log level: {}", error);
                            }
                        } else {
                            log::warn!(
                                "Received invalid log level from config update event: {}",
                                new_level
                            );
                        }
                    }
                    Ok(ConfigUpdateEvent::ConfigReloaded) => {
                        let level = resolve_runtime_log_level(default_level).await;
                        logging::apply_runtime_log_level(level, "config_reloaded");
                        if let Err(error) =
                            openbitfun_core::plugin_host::set_configured_plugin_host_log_level(
                                logging::level_to_str(level),
                            )
                            .await
                        {
                            log::warn!("Failed to update plugin host log level: {}", error);
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        log::warn!("Log-level listener channel closed, stopping listener");
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("Log-level listener lagged by {} messages", n);
                    }
                }
            }
        } else {
            log::warn!("Config update subscription unavailable for log-level listener");
        }
    });
}

fn create_event_emitter(
    transport: Arc<TauriTransportAdapter>,
) -> Arc<dyn openbitfun_core::infrastructure::events::EventEmitter> {
    use openbitfun_transport::TransportEmitter;
    let inner: Arc<dyn openbitfun_core::infrastructure::events::EventEmitter> =
        Arc::new(TransportEmitter::new(transport));
    let inner = api::remote_connect_api::wrap_peer_aware_emitter(inner);
    api::miniapp_agent_api::wrap_miniapp_agent_context_cleanup_emitter(inner)
}

fn spawn_workspace_search_feature_listener(app_handle: tauri::AppHandle) {
    use openbitfun_core::service::config::{subscribe_config_updates, ConfigUpdateEvent};

    let app_state: tauri::State<'_, api::AppState> = app_handle.state();
    let workspace_search_service = app_state.workspace_search_service.clone();
    let workspace_path = app_state.workspace_path.clone();

    tokio::spawn(async move {
        let mut feature_enabled =
            openbitfun_core::service::search::workspace_search_feature_enabled().await;

        let Some(mut receiver) = subscribe_config_updates() else {
            log::warn!("Config update subscription unavailable for workspace search listener");
            return;
        };

        loop {
            match receiver.recv().await {
                Ok(ConfigUpdateEvent::AppUpdated) | Ok(ConfigUpdateEvent::ConfigReloaded) => {
                    let next_enabled =
                        openbitfun_core::service::search::workspace_search_feature_enabled().await;

                    if next_enabled == feature_enabled {
                        continue;
                    }

                    if !next_enabled {
                        workspace_search_service.stop_all_daemons().await;
                        log::info!(
                            "Workspace search feature disabled; stopped flashgrep daemon and cleared sessions"
                        );
                        feature_enabled = false;
                        continue;
                    }

                    let resolved_path = configure_workspace_search_daemon_env();
                    if !openbitfun_core::service::search::workspace_search_daemon_available() {
                        log::warn!(
                            "Workspace search feature enabled but daemon is unavailable: path={:?}, hint={}",
                            resolved_path.as_ref().map(|path| path.display().to_string()),
                            openbitfun_core::service::search::workspace_search_daemon_missing_hint()
                        );
                        feature_enabled = true;
                        continue;
                    }

                    let current_workspace = workspace_path.read().await.clone();
                    if let Some(current_workspace) = current_workspace {
                        let workspace_str = current_workspace.to_string_lossy().to_string();
                        if !openbitfun_core::service::remote_ssh::workspace_state::is_remote_path(
                            workspace_str.trim(),
                        )
                        .await
                        {
                            match workspace_search_service.open_repo(&current_workspace).await {
                                Ok(_) => {
                                    workspace_search_service.schedule_auto_index(
                                        &current_workspace,
                                        openbitfun_core::service::search::WorkspaceSearchAutoIndexPriority::Focused,
                                    ).await;
                                    log::info!(
                                        "Workspace search feature enabled; warmed current workspace: path={}",
                                        current_workspace.display()
                                    );
                                }
                                Err(error) => {
                                    log::warn!(
                                        "Workspace search feature enabled but failed to warm current workspace: path={}, error={}",
                                        current_workspace.display(),
                                        error
                                    );
                                }
                            }
                        }
                    }

                    feature_enabled = true;
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    log::warn!("Workspace search feature listener channel closed");
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("Workspace search feature listener lagged by {} messages", n);
                }
            }
        }
    });
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod event_loop_driver_tests {
    use super::*;
    use openbitfun_core::agentic::events::{EventQueue, EventQueueConfig, EventRouter};

    fn text_chunk(text: &str) -> AgenticEvent {
        AgenticEvent::TextChunk {
            session_id: "s".to_string(),
            turn_id: "t".to_string(),
            round_id: "r".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: text.to_string(),
        }
    }

    /// Regression test for the P1 scheduling issue: the window timer is only
    /// polled at the outer `select!`, so a drain loop that never finds an
    /// empty queue (sustained producer load) must still honor the deadline
    /// in place. The first flush must happen ~one window after the first
    /// chunk, and further windows must keep firing while the queue stays
    /// non-empty.
    ///
    /// Setup: the producer enqueues one chunk per millisecond and delivery
    /// stalls one millisecond per event, so the drain loop never sees an
    /// empty queue. The paused clock steps 1ms at a time so producer and
    /// driver advance deterministically.
    #[tokio::test(start_paused = true)]
    async fn flush_timer_fires_while_queue_stays_non_empty() {
        let queue = Arc::new(EventQueue::new(EventQueueConfig {
            max_queue_size: 10000,
            batch_size: 10,
        }));
        let router = Arc::new(EventRouter::new());
        let received: Arc<tokio::sync::Mutex<Vec<AgenticEvent>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let producer_queue = queue.clone();
        let producer = tokio::spawn(async move {
            for i in 0..1000 {
                producer_queue
                    .enqueue(text_chunk(&format!("chunk{i} ")), None)
                    .await
                    .expect("enqueue should succeed");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });

        let driver_queue = queue.clone();
        let driver_received = received.clone();
        let driver = tokio::spawn(async move {
            event_loop_driver(driver_queue, router, |event| {
                let received = driver_received.clone();
                async move {
                    received.lock().await.push(event);
                    // Slow delivery down so the drain never finds the queue
                    // empty while the producer keeps enqueueing.
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await;
        });

        let mut first_flush_at_ms: Option<u128> = None;
        for step in 0..300 {
            tokio::time::advance(Duration::from_millis(1)).await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            if first_flush_at_ms.is_none() && !received.lock().await.is_empty() {
                first_flush_at_ms = Some(step as u128 + 1);
            }
        }

        let first = first_flush_at_ms.expect(
            "expected a flush within the first window; with the drain loop never \
             exiting, the deadline must still be honored in place",
        );
        // First chunk lands at ~1ms; the initial window is 50ms, so the first
        // flush must land around 51ms. 40..=120 is a generous bound that still
        // fails if the deadline only starts after the drain loop exits.
        assert!(
            (40..=120).contains(&first),
            "first flush at {first}ms, expected ~50ms after the first chunk"
        );

        let total = received.lock().await.len();
        assert!(
            total >= 3,
            "expected multiple window flushes during sustained drain, got {total}"
        );

        driver.abort();
        producer.abort();
    }

    /// Under sustained drain, merged text must stay a growing prefix of the
    /// produced stream: no chunk is dropped and none is duplicated.
    #[tokio::test(start_paused = true)]
    async fn sustained_drain_does_not_lose_or_duplicate_text() {
        let queue = Arc::new(EventQueue::new(EventQueueConfig {
            max_queue_size: 10000,
            batch_size: 10,
        }));
        let router = Arc::new(EventRouter::new());
        let received: Arc<tokio::sync::Mutex<Vec<AgenticEvent>>> =
            Arc::new(tokio::sync::Mutex::new(Vec::new()));

        let producer_queue = queue.clone();
        let producer = tokio::spawn(async move {
            for i in 0..1000 {
                producer_queue
                    .enqueue(text_chunk(&format!("x{i} ")), None)
                    .await
                    .expect("enqueue should succeed");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });

        let driver_queue = queue.clone();
        let driver_received = received.clone();
        let driver = tokio::spawn(async move {
            event_loop_driver(driver_queue, router, |event| {
                let received = driver_received.clone();
                async move {
                    received.lock().await.push(event);
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await;
        });

        for _ in 0..300 {
            tokio::time::advance(Duration::from_millis(1)).await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
        }

        let events = received.lock().await;
        assert!(
            events.len() >= 3,
            "expected multiple flushes, got {}",
            events.len()
        );
        // Each merged event carries only the chunks of its own window; the
        // frontend appends them to the same text item. Concatenated, they must
        // reproduce the producer's chunk sequence exactly: contiguous, no
        // loss, no duplication, no reordering.
        let mut joined = String::new();
        for event in events.iter() {
            if let AgenticEvent::TextChunk { text, .. } = event {
                joined.push_str(text);
            }
        }
        let numbers: Vec<u32> = joined
            .split_whitespace()
            .map(|word| {
                word.strip_prefix('x')
                    .and_then(|n| n.parse::<u32>().ok())
                    .unwrap_or_else(|| panic!("unexpected chunk payload: {word:?}"))
            })
            .collect();
        for (index, number) in numbers.iter().enumerate() {
            assert_eq!(
                *number as usize, index,
                "chunk sequence must be contiguous: got x{number} at position {index}"
            );
        }

        driver.abort();
        producer.abort();
    }
}
