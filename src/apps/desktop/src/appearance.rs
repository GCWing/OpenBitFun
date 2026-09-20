//! Desktop appearance bootstrap and window creation.

use std::sync::{Arc, OnceLock, RwLock};
use std::time::Instant;

use dark_light::Mode;
use log::{debug, error, warn};
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::config::types::GlobalConfig;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl};

use crate::startup_trace::DesktopStartupTrace;

const AGENT_COMPANION_WINDOW_LABEL: &str = "agent-companion-pet";
const AGENT_COMPANION_WINDOW_MIN_SIZE: f64 = 96.0;
const AGENT_COMPANION_WINDOW_MAX_WIDTH: f64 = 360.0;
const AGENT_COMPANION_WINDOW_MAX_HEIGHT: f64 = 240.0;
const AGENT_COMPANION_WINDOW_MARGIN: i32 = 64;
const AGENT_COMPANION_WINDOW_EDGE_MARGIN: f64 = 8.0;
static AGENT_COMPANION_WINDOW_OPS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static AGENT_COMPANION_WINDOW_LAST_POSITION: OnceLock<RwLock<Option<tauri::LogicalPosition<f64>>>> =
    OnceLock::new();
static STARTUP_APPEARANCE_BOOTSTRAP_MANIFEST: OnceLock<StartupAppearanceBootstrapManifest> =
    OnceLock::new();

const STARTUP_APPEARANCE_BOOTSTRAP_JSON: &str =
    include_str!("generated/startup_appearance_bootstrap.json");

fn agent_companion_window_ops() -> &'static tokio::sync::Mutex<()> {
    AGENT_COMPANION_WINDOW_OPS.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn agent_companion_window_last_position() -> &'static RwLock<Option<tauri::LogicalPosition<f64>>> {
    AGENT_COMPANION_WINDOW_LAST_POSITION.get_or_init(|| RwLock::new(None))
}

fn remember_agent_companion_window_position(position: tauri::LogicalPosition<f64>) {
    match agent_companion_window_last_position().write() {
        Ok(mut last_position) => {
            *last_position = Some(position);
        }
        Err(error) => {
            warn!(
                "Failed to remember Agent companion window position: {}",
                error
            );
        }
    }
}

fn remembered_agent_companion_window_position() -> Option<tauri::LogicalPosition<f64>> {
    agent_companion_window_last_position()
        .read()
        .ok()
        .and_then(|position| *position)
}

fn work_area_for_agent_companion_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<(tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>)> {
    let monitor: Option<tauri::Monitor> = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let monitor = monitor?;
    let scale_factor = monitor.scale_factor();
    let area = monitor.work_area();
    Some((
        area.position.to_logical::<f64>(scale_factor),
        area.size.to_logical::<f64>(scale_factor),
    ))
}

fn clamp_agent_companion_window_position(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
) -> tauri::LogicalPosition<f64> {
    let Some((area_position, area_size)) = work_area_for_agent_companion_window(app, window) else {
        return position;
    };

    let min_x = area_position.x + AGENT_COMPANION_WINDOW_EDGE_MARGIN;
    let min_y = area_position.y + AGENT_COMPANION_WINDOW_EDGE_MARGIN;
    let max_x = area_position.x + area_size.width - size.width - AGENT_COMPANION_WINDOW_EDGE_MARGIN;
    let max_y =
        area_position.y + area_size.height - size.height - AGENT_COMPANION_WINDOW_EDGE_MARGIN;
    tauri::LogicalPosition::new(
        if max_x >= min_x {
            position.x.clamp(min_x, max_x)
        } else {
            area_position.x
        },
        if max_y >= min_y {
            position.y.clamp(min_y, max_y)
        } else {
            area_position.y
        },
    )
}

#[derive(Debug, Clone)]
pub struct AppearanceConfig {
    pub id: String,
    pub selection_id: Option<String>,
    pub bg_primary: String,
    pub bg_secondary: String,
    pub bg_scene: String,
    pub is_light: bool,
    pub text_primary: String,
    pub text_muted: String,
    pub accent_color: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupAppearanceBootstrapManifest {
    schema_version: u8,
    default_light_appearance_id: String,
    default_dark_appearance_id: String,
    appearances: Vec<StartupAppearanceBootstrapEntry>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupAppearanceBootstrapEntry {
    id: String,
    bg_primary: String,
    bg_secondary: String,
    bg_scene: String,
    is_light: bool,
    text_primary: String,
    text_muted: String,
    accent_color: String,
}

impl StartupAppearanceBootstrapEntry {
    fn to_appearance_config(&self, selection_id: Option<String>) -> AppearanceConfig {
        AppearanceConfig {
            id: self.id.clone(),
            selection_id,
            bg_primary: self.bg_primary.clone(),
            bg_secondary: self.bg_secondary.clone(),
            bg_scene: self.bg_scene.clone(),
            is_light: self.is_light,
            text_primary: self.text_primary.clone(),
            text_muted: self.text_muted.clone(),
            accent_color: self.accent_color.clone(),
        }
    }
}

#[derive(Debug, Clone)]
struct StartupBootstrapConfig {
    appearance: AppearanceConfig,
    locale: String,
    keybindings: Option<serde_json::Value>,
}

const MAX_BOOTSTRAP_KEYBINDINGS_JSON_BYTES: usize = 64 * 1024;
const MAX_BOOTSTRAP_WORKSPACE_STATE_JSON_BYTES: usize = 64 * 1024;

impl Default for AppearanceConfig {
    fn default() -> Self {
        let default_light_appearance_id = Self::startup_appearance_bootstrap_manifest()
            .default_light_appearance_id
            .as_str();
        let mut appearance = Self::get_builtin_appearance(default_light_appearance_id).expect(
            "startup appearance bootstrap manifest must include the default light appearance",
        );
        appearance.selection_id = None;
        appearance
    }
}

impl AppearanceConfig {
    pub fn get_builtin_appearance(appearance_id: &str) -> Option<Self> {
        Self::startup_appearance_bootstrap_manifest()
            .appearances
            .iter()
            .find(|appearance| appearance.id == appearance_id)
            .map(|appearance| appearance.to_appearance_config(Some(appearance_id.to_string())))
    }

    fn startup_appearance_bootstrap_manifest() -> &'static StartupAppearanceBootstrapManifest {
        STARTUP_APPEARANCE_BOOTSTRAP_MANIFEST.get_or_init(|| {
            let manifest: StartupAppearanceBootstrapManifest =
                serde_json::from_str(STARTUP_APPEARANCE_BOOTSTRAP_JSON)
                    .expect("startup appearance bootstrap manifest must be valid JSON");
            assert_eq!(
                manifest.schema_version, 1,
                "startup appearance bootstrap manifest version is unsupported"
            );
            manifest
        })
    }

    fn load_startup_bootstrap_config() -> StartupBootstrapConfig {
        let default_appearance = Self::default();
        let default = StartupBootstrapConfig {
            appearance: default_appearance.clone(),
            locale: "zh-CN".to_string(),
            keybindings: None,
        };
        let path_manager = match try_get_path_manager_arc() {
            Ok(pm) => pm,
            Err(e) => {
                debug!(
                    "Failed to create PathManager, using default appearance: {}",
                    e
                );
                return default;
            }
        };

        let config_file = path_manager.app_config_file();
        if !config_file.exists() {
            return default;
        }

        let config_content = match std::fs::read_to_string(&config_file) {
            Ok(content) => content,
            Err(e) => {
                debug!(
                    "Failed to read config file, using default appearance: {}",
                    e
                );
                return default;
            }
        };

        let config_value: serde_json::Value = match serde_json::from_str(&config_content) {
            Ok(value) => value,
            Err(e) => {
                debug!(
                    "Failed to parse config file, using default appearance: {}",
                    e
                );
                return default;
            }
        };

        let locale = config_value
            .pointer("/app/language")
            .and_then(|value| value.as_str())
            .or_else(|| {
                config_value
                    .pointer("/i18n/currentLanguage")
                    .and_then(|value| value.as_str())
            })
            .unwrap_or("zh-CN")
            .to_string();

        let appearance_selection = config_value
            .pointer("/appearance/selection")
            .and_then(|value| value.as_str())
            .unwrap_or("system")
            .to_string();

        let global_config: GlobalConfig = match serde_json::from_value(config_value) {
            Ok(config) => config,
            Err(e) => {
                debug!(
                    "Failed to parse config file, using default appearance: {}",
                    e
                );
                return StartupBootstrapConfig { locale, ..default };
            }
        };

        let resolved_id = Self::resolve_builtin_appearance_id(&appearance_selection);

        let appearance = match Self::get_builtin_appearance(resolved_id) {
            Some(mut config) => {
                config.selection_id = Some(appearance_selection.clone());
                config
            }
            None => {
                warn!(
                    "Unknown appearance ID: {}, using default appearance",
                    appearance_selection
                );
                default_appearance
            }
        };

        StartupBootstrapConfig {
            appearance,
            locale,
            keybindings: global_config.app.keybindings,
        }
    }

    /// Resolves the selected appearance for splash and window chrome.
    fn resolve_builtin_appearance_id(appearance_id: &str) -> &str {
        if appearance_id == "system" {
            let manifest = Self::startup_appearance_bootstrap_manifest();
            return match dark_light::detect() {
                Mode::Dark => manifest.default_dark_appearance_id.as_str(),
                Mode::Light | Mode::Default => manifest.default_light_appearance_id.as_str(),
            };
        }
        appearance_id
    }

    fn generate_init_script(
        &self,
        startup_trace_id: &str,
        bootstrap_config: &StartupBootstrapConfig,
        workspace_startup_state: Option<&serde_json::Value>,
    ) -> String {
        let appearance_mode = if self.is_light { "light" } else { "dark" };
        let startup_locale = &bootstrap_config.locale;
        let startup_locale_json =
            serde_json::to_string(&startup_locale).unwrap_or_else(|_| "\"zh-CN\"".to_string());
        let show_startup_window_controls = !cfg!(target_os = "macos");
        let native_sidebar_material = cfg!(any(target_os = "windows", target_os = "macos"));
        let startup_trace_id_json = serde_json::to_string(startup_trace_id)
            .unwrap_or_else(|_| "\"desktop-unknown\"".to_string());
        let bootstrap_log_level_json = serde_json::to_string(crate::logging::level_to_str(
            crate::logging::current_runtime_log_level(),
        ))
        .unwrap_or_else(|_| "\"warn\"".to_string());
        let perf_trace_enabled = cfg!(debug_assertions)
            || ((cfg!(feature = "devtools")
                || std::env::var_os("OPENBITFUN_PERF_TRACE").is_some())
                && std::env::var_os("OPENBITFUN_WEBDRIVER_PORT").is_some());
        let bootstrap_appearance_id_json =
            serde_json::to_string(&self.id).unwrap_or_else(|_| "\"openbitfun-light\"".to_string());
        let bootstrap_appearance_selection_json = self
            .selection_id
            .as_ref()
            .and_then(|selection| serde_json::to_string(selection).ok())
            .unwrap_or_else(|| "null".to_string());
        let bootstrap_keybindings_assignment = serde_json::to_string(&bootstrap_config.keybindings)
            .ok()
            .filter(|json| json.len() <= MAX_BOOTSTRAP_KEYBINDINGS_JSON_BYTES)
            .map(|json| format!("window.__OPENBITFUN_BOOTSTRAP_KEYBINDINGS__ = {json};"))
            .unwrap_or_default();
        let bootstrap_workspace_startup_state_assignment = workspace_startup_state
            .and_then(|state| serde_json::to_string(state).ok())
            .filter(|json| json.len() <= MAX_BOOTSTRAP_WORKSPACE_STATE_JSON_BYTES)
            .map(|json| {
                format!("window.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__ = {json};")
            })
            .unwrap_or_default();

        format!(
            r#"
            (function() {{
                window.__OPENBITFUN_STARTUP_TRACE_ID__ = {startup_trace_id_json};
                window.__OPENBITFUN_PERF_TRACE_ENABLED__ = {perf_trace_enabled};
                window.__OPENBITFUN_BOOTSTRAP_LOG_LEVEL__ = {bootstrap_log_level_json};
                window.__OPENBITFUN_BOOTSTRAP_LOCALE__ = {startup_locale_json};
                window.__OPENBITFUN_SHOW_STARTUP_WINDOW_CONTROLS__ = {show_startup_window_controls};
                window.__OPENBITFUN_BOOTSTRAP_APPEARANCE_ID__ = {bootstrap_appearance_id_json};
                window.__OPENBITFUN_BOOTSTRAP_APPEARANCE_SELECTION__ = {bootstrap_appearance_selection_json};
                {bootstrap_keybindings_assignment}
                {bootstrap_workspace_startup_state_assignment}
                function applyAppearance() {{
                    var root = document.documentElement;
                    if (!root) return false;
                    
                    root.setAttribute('data-openbitfun-appearance', '{id}');
                    root.setAttribute('data-openbitfun-appearance-mode', '{appearance_mode}');
                    root.setAttribute('data-openbitfun-design-system-root', '');
                    root.setAttribute('data-color-scheme', '{appearance_mode}');
                    root.setAttribute('data-contrast', 'standard');
                    root.setAttribute('data-density', 'compact');
                    if ({native_sidebar_material}) {{
                        root.setAttribute('data-openbitfun-native-material', 'sidebar');
                    }}
                    
                    root.style.setProperty('--openbitfun-color-surface-canvas', '{bg_primary}');
                    root.style.setProperty('--openbitfun-color-surface-panel', '{bg_secondary}');
                    root.style.setProperty('--openbitfun-color-surface-tertiary', '{bg_primary}');
                    root.style.setProperty('--openbitfun-color-surface-workbench', '{bg_primary}');
                    root.style.setProperty('--openbitfun-color-surface-scene', '{bg_scene}');
                    root.style.setProperty('--openbitfun-color-surface-chrome', '{bg_primary}');
                    root.style.setProperty('--openbitfun-color-content-primary', '{text_primary}');
                    root.style.setProperty('--openbitfun-color-content-muted', '{text_muted}');
                    root.style.setProperty('--openbitfun-color-accent-default', '{accent_color}');
                    root.style.backgroundColor = {native_sidebar_material} ? 'transparent' : '{bg_primary}';
                    
                    if (document.body) {{
                        document.body.style.backgroundColor = {native_sidebar_material} ? 'transparent' : '{bg_primary}';
                    }}
                    
                    return true;
                }}
                
                if (document.documentElement) {{
                    applyAppearance();
                }}
                
                if (document.readyState === 'loading') {{
                    document.addEventListener('DOMContentLoaded', applyAppearance);
                }} else {{
                    applyAppearance();
                }}
            }})();
            "#,
            id = self.id,
            appearance_mode = appearance_mode,
            bootstrap_appearance_id_json = bootstrap_appearance_id_json,
            bootstrap_appearance_selection_json = bootstrap_appearance_selection_json,
            bg_primary = self.bg_primary,
            bg_secondary = self.bg_secondary,
            bg_scene = self.bg_scene,
            text_primary = self.text_primary,
            text_muted = self.text_muted,
            accent_color = self.accent_color,
            startup_trace_id_json = startup_trace_id_json,
            perf_trace_enabled = perf_trace_enabled,
            bootstrap_log_level_json = bootstrap_log_level_json,
            startup_locale_json = startup_locale_json,
            show_startup_window_controls = show_startup_window_controls,
            bootstrap_keybindings_assignment = bootstrap_keybindings_assignment,
            bootstrap_workspace_startup_state_assignment =
                bootstrap_workspace_startup_state_assignment,
        )
    }

    pub fn to_tauri_color(&self) -> tauri::window::Color {
        let hex = self.bg_primary.trim_start_matches('#');
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(18);
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(18);
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(20);
        tauri::window::Color(r, g, b, 255)
    }
}

#[cfg(test)]
mod startup_appearance_tests {
    use super::{AppearanceConfig, StartupBootstrapConfig};

    #[test]
    fn startup_init_script_uses_only_appearance_bootstrap_contracts() {
        let appearance = AppearanceConfig {
            id: "test.appearance".to_string(),
            selection_id: Some("test.appearance".to_string()),
            bg_primary: "#101214".to_string(),
            bg_secondary: "#181a1d".to_string(),
            bg_scene: "#202328".to_string(),
            is_light: false,
            text_primary: "#f5f7fa".to_string(),
            text_muted: "#9aa1aa".to_string(),
            accent_color: "#60a5fa".to_string(),
        };
        let bootstrap = StartupBootstrapConfig {
            appearance: appearance.clone(),
            locale: "en-US".to_string(),
            keybindings: None,
        };

        let script = appearance.generate_init_script("trace-id", &bootstrap, None);

        assert!(script.contains("__OPENBITFUN_BOOTSTRAP_APPEARANCE_ID__"));
        assert!(script.contains("__OPENBITFUN_BOOTSTRAP_APPEARANCE_SELECTION__"));
        assert!(script.contains("data-openbitfun-appearance"));
        assert!(script.contains("data-openbitfun-appearance-mode"));
        assert!(script.contains("data-openbitfun-design-system-root"));
        assert!(script.contains("data-color-scheme"));
        assert!(script.contains("--openbitfun-color-surface-canvas"));
        assert!(script.contains("--openbitfun-color-surface-scene"));
        assert!(script.contains("--openbitfun-color-content-primary"));
        assert!(script.contains("--openbitfun-color-content-muted"));
        assert!(script.contains("--openbitfun-color-accent-default"));
        assert!(!script.contains("--openbitfun-appearance-token-"));
        let retired_bootstrap_global = ["__OPENBITFUN_BOOTSTRAP", "THEME"].join("_");
        let retired_background_token = ["--", "color-bg-"].concat();
        let retired_text_token = ["--", "color-text-"].concat();
        assert!(!script.contains(&retired_bootstrap_global));
        assert!(!script.contains("data-theme"));
        assert!(!script.contains(&retired_background_token));
        assert!(!script.contains(&retired_text_token));
    }

    #[test]
    fn startup_manifest_exposes_both_default_appearances() {
        let manifest = AppearanceConfig::startup_appearance_bootstrap_manifest();

        assert_eq!(manifest.schema_version, 1);
        assert!(
            AppearanceConfig::get_builtin_appearance(&manifest.default_light_appearance_id)
                .is_some()
        );
        assert!(
            AppearanceConfig::get_builtin_appearance(&manifest.default_dark_appearance_id)
                .is_some()
        );
    }
}

fn use_development_frontend() -> bool {
    #[cfg(debug_assertions)]
    {
        // Isolated E2E can exercise the production protocol using a debug
        // executable and dist assets, without launching a development server.
        !(std::env::var("OPENBITFUN_E2E_PACKAGED_FRONTEND").as_deref() == Ok("1")
            && std::env::var("OPENBITFUN_E2E_STORAGE_GUARD").as_deref() == Ok("1"))
    }
    #[cfg(not(debug_assertions))]
    {
        false
    }
}

pub fn create_main_window(
    app_handle: &tauri::AppHandle,
    startup_trace_id: &str,
    startup_trace: &DesktopStartupTrace,
    workspace_startup_state: Option<serde_json::Value>,
    frontend_workbench: Arc<crate::frontend_workbench::FrontendWorkbenchManager>,
) {
    let total_started_at = Instant::now();
    let (startup_page_ready, mut startup_page_ready_rx) = tokio::sync::watch::channel(false);
    let bootstrap_config = AppearanceConfig::load_startup_bootstrap_config();
    let appearance = bootstrap_config.appearance.clone();
    let bg_color = appearance.to_tauri_color();
    let init_script = appearance.generate_init_script(
        startup_trace_id,
        &bootstrap_config,
        workspace_startup_state.as_ref(),
    );
    startup_trace.record_step(
        "native_step_end",
        "native_window",
        "prepare_appearance",
        total_started_at.elapsed().as_millis(),
    );
    debug!(
        "Main window creation step completed: step=prepare_appearance duration_ms={}",
        total_started_at.elapsed().as_millis()
    );

    let main_url = if use_development_frontend() {
        app_url(app_handle, "")
    } else {
        frontend_workbench.active_frontend_url()
    };
    let main_url_kind = match &main_url {
        WebviewUrl::External(_) => "external",
        WebviewUrl::App(_) => "app",
        _ => "other",
    };

    #[cfg(not(debug_assertions))]
    let materialization_workbench = Arc::clone(&frontend_workbench);
    #[cfg(target_os = "macos")]
    let builder = {
        // Configure both Tao's native window and Wry's WebView. The builder's
        // traffic_light_position setter only configures Wry, so native window
        // lifecycle events otherwise restore the default button placement.
        let config = tauri::utils::config::WindowConfig {
            label: "main".into(),
            url: main_url,
            title_bar_style: tauri::TitleBarStyle::Overlay,
            hidden_title: true,
            // Native button center = inset + height / 2 - origin.y.
            // AppKit's 16pt button at y=6 needs 20.5 for the 45px toolbar.
            traffic_light_position: Some(tauri::utils::config::LogicalPosition {
                x: 12.0,
                y: 20.5,
            }),
            ..Default::default()
        };
        match tauri::WebviewWindowBuilder::from_config(app_handle, &config) {
            Ok(builder) => builder,
            Err(error) => {
                error!("Failed to configure main window: {}", error);
                return;
            }
        }
    };
    #[cfg(not(target_os = "macos"))]
    let builder = tauri::WebviewWindowBuilder::new(app_handle, "main", main_url);
    #[allow(unused_mut)]
    let mut builder = builder
        .title("OpenBitFun")
        .inner_size(
            crate::MAIN_WINDOW_DEFAULT_WIDTH,
            crate::MAIN_WINDOW_DEFAULT_HEIGHT,
        )
        .center()
        .resizable(true)
        .fullscreen(false)
        .visible(false)
        .background_color(bg_color)
        .accept_first_mouse(true)
        .initialization_script(&init_script)
        .on_page_load({
            let startup_trace_id = startup_trace_id.to_string();
            move |_window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let _ = startup_page_ready.send(true);
                }
                let event = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                debug!(
                    "Main window page load event: trace_id={}, event={}, url={}, since_create_start_ms={}",
                    startup_trace_id,
                    event,
                    payload.url(),
                    total_started_at.elapsed().as_millis()
                );
                #[cfg(not(debug_assertions))]
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    materialization_workbench.materialize_bundled_revision_in_background();
                }
            }
        });

    // The webview must be transparent for the OS material to reach the sidebar.
    // Scene backgrounds and the startup tint remain owned by the frontend.
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        builder = builder
            .transparent(true)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .effects(
                tauri::window::EffectsBuilder::new()
                    .effects([
                        tauri::window::Effect::Acrylic,
                        tauri::window::Effect::Sidebar,
                    ])
                    .build(),
            );
    }

    #[cfg(debug_assertions)]
    if !use_development_frontend() {
        // Product-path isolation alone does not isolate WKWebView storage.
        // This guarded test window keeps a private store across document
        // reloads and never opens the daily client's browser data store.
        builder = builder.incognito(true);
    }

    // On Windows, Tauri's native file-drop handler replaces WebView2's OLE drop
    // target and disables every HTML5 drag/drop interaction in the page. Keep
    // the browser handler there. The frontend keeps dropped File wrappers alive
    // briefly while the Desktop host resolves their original paths through
    // WebView2, without copying file contents. WKWebView/WebKitGTK do not have
    // that conflict, so their native handler remains enabled and supplies paths.
    #[cfg(target_os = "windows")]
    {
        builder = builder.disable_drag_drop_handler();
    }

    // The Desktop host arms each exact Creative preview/rollback transition.
    // Page-driven navigations remain blocked, including in development where
    // the initial Vite origin differs from the packaged-frontend protocol.
    let navigation_workbench = Arc::clone(&frontend_workbench);
    builder =
        builder.on_navigation(move |url| navigation_workbench.should_allow_main_navigation(url));

    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }

    let build_started_at = Instant::now();
    match builder.build() {
        Ok(window) => {
            #[cfg(target_os = "windows")]
            if let Err(error) = crate::window_webview_geometry::install(&window) {
                error!("Failed to install main WebView geometry protection: {error}");
            }
            let reapply_maximized = crate::restore_main_window_state(&window);
            crate::webview_recovery::install(&window);
            startup_trace.record_elapsed_step("native_window", "webview_build", build_started_at);
            debug!(
                "Main window creation step completed: step=build url_kind={} duration_ms={} total_duration_ms={}",
                main_url_kind,
                build_started_at.elapsed().as_millis(),
                total_started_at.elapsed().as_millis()
            );
            #[cfg(any(debug_assertions, feature = "devtools"))]
            {
                if std::env::var("OPENBITFUN_OPEN_DEVTOOLS")
                    .map(|v| v == "1")
                    .unwrap_or(false)
                {
                    window.open_devtools();
                }
            }

            // A transparent window shown before the document loads exposes bare
            // Acrylic: the frontend's startup tint does not exist yet. Keep the
            // native background transparent and delay only the initial reveal.
            let startup_trace = startup_trace.clone();
            tauri::async_runtime::spawn(async move {
                let ready = matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        startup_page_ready_rx.wait_for(|ready| *ready),
                    )
                    .await,
                    Ok(Ok(_))
                );
                if !ready {
                    // Keep a failed navigation observable instead of leaving an
                    // invisible process; normal startup always waits for the page.
                    warn!("Startup page did not finish loading before the window reveal watchdog");
                }
                let visible_window = window.clone();
                if let Err(error) = window.run_on_main_thread(move || {
                    show_main_window_for_startup(
                        &visible_window,
                        total_started_at,
                        &startup_trace,
                        reapply_maximized,
                    );
                }) {
                    warn!("Failed to schedule main window startup reveal: {}", error);
                }
            });
        }
        Err(e) => {
            error!(
                "Failed to create main window: error={} duration_ms={}",
                e,
                total_started_at.elapsed().as_millis()
            );
        }
    }
}

fn show_main_window_for_startup(
    window: &tauri::WebviewWindow,
    total_started_at: Instant,
    startup_trace: &DesktopStartupTrace,
    reapply_maximized: bool,
) {
    let show_started_at = Instant::now();
    if let Err(error) = window.show() {
        warn!("Failed to show main window during startup: {}", error);
        return;
    }
    startup_trace.record_elapsed_step("native_window", "show_window", show_started_at);
    debug!(
        "Main window startup show step completed: step=show duration_ms={} since_create_start_ms={}",
        show_started_at.elapsed().as_millis(),
        total_started_at.elapsed().as_millis()
    );

    let focus_started_at = Instant::now();
    if let Err(error) = window.set_focus() {
        warn!("Failed to focus main window during startup: {}", error);
    } else {
        startup_trace.record_elapsed_step("native_window", "focus_window", focus_started_at);
        debug!(
            "Main window startup show step completed: step=focus duration_ms={} since_create_start_ms={}",
            focus_started_at.elapsed().as_millis(),
            total_started_at.elapsed().as_millis()
        );
    }

    // Maximize only after the window is visible: maximizing a hidden
    // undecorated window on Windows is dropped on show and leaves a bogus
    // normal-placement rect behind (see `window_state_support`).
    if reapply_maximized {
        match window.is_maximized() {
            Ok(true) => {}
            Ok(false) => {
                if let Err(error) = window.maximize() {
                    log::warn!(
                        "Failed to re-apply persisted maximized state after main window show: {}",
                        error
                    );
                }
            }
            Err(error) => {
                log::warn!(
                    "Failed to query main window maximized state after show: {}",
                    error
                )
            }
        }
    }
}

fn development_frontend_url(
    dev_url: Option<&tauri::Url>,
    path: &str,
) -> Result<tauri::Url, String> {
    let base = dev_url.ok_or_else(|| "Tauri build.devUrl is not configured".to_string())?;
    if path.is_empty() {
        return Ok(base.clone());
    }
    base.join(path).map_err(|error| error.to_string())
}

fn app_url(app: &tauri::AppHandle, path: &str) -> WebviewUrl {
    if use_development_frontend() {
        match development_frontend_url(app.config().build.dev_url.as_ref(), path) {
            Ok(url) => {
                debug!("Development frontend URL resolved: {}", url);
                WebviewUrl::External(url)
            }
            Err(e) => {
                error!("Invalid dev URL, fallback to app URL: {}", e);
                WebviewUrl::App(path.into())
            }
        }
    } else {
        crate::frontend_workbench::custom_frontend_url(path)
    }
}

fn agent_companion_default_position(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Option<tauri::LogicalPosition<f64>> {
    let (area_position, area_size) = work_area_for_agent_companion_window(app, window)?;

    let monitor: Option<tauri::Monitor> = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let scale_factor = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let window_size = window
        .outer_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale_factor));
    let window_width = window_size
        .as_ref()
        .map(|size| size.width)
        .unwrap_or(AGENT_COMPANION_WINDOW_MIN_SIZE);
    let window_height = window_size
        .as_ref()
        .map(|size| size.height)
        .unwrap_or(AGENT_COMPANION_WINDOW_MIN_SIZE);
    let x =
        area_position.x + area_size.width - window_width - f64::from(AGENT_COMPANION_WINDOW_MARGIN);
    let y = area_position.y + area_size.height
        - window_height
        - f64::from(AGENT_COMPANION_WINDOW_MARGIN);

    Some(clamp_agent_companion_window_position(
        app,
        window,
        tauri::LogicalPosition::new(x, y),
        tauri::LogicalSize::new(window_width, window_height),
    ))
}

fn agent_companion_window_effective_size(window: &tauri::WebviewWindow) -> tauri::LogicalSize<f64> {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let size = window
        .outer_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale_factor))
        .unwrap_or_else(|| {
            tauri::LogicalSize::new(
                AGENT_COMPANION_WINDOW_MIN_SIZE,
                AGENT_COMPANION_WINDOW_MIN_SIZE,
            )
        });

    tauri::LogicalSize::new(
        size.width.clamp(
            AGENT_COMPANION_WINDOW_MIN_SIZE,
            AGENT_COMPANION_WINDOW_MAX_WIDTH,
        ),
        size.height.clamp(
            AGENT_COMPANION_WINDOW_MIN_SIZE,
            AGENT_COMPANION_WINDOW_MAX_HEIGHT,
        ),
    )
}

fn position_agent_companion_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some(position) = remembered_agent_companion_window_position()
        .or_else(|| agent_companion_default_position(app, window))
    else {
        return;
    };

    let size = agent_companion_window_effective_size(window);
    let position = clamp_agent_companion_window_position(app, window, position, size);

    if let Err(e) = window.set_position(position) {
        warn!("Failed to position Agent companion window: {}", e);
    } else {
        remember_agent_companion_window_position(position);
    }
}

fn resize_agent_companion_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) {
    if !width.is_finite() || !height.is_finite() {
        warn!(
            "Ignored invalid Agent companion window size: width={}, height={}",
            width, height
        );
        return;
    }

    let width = width.clamp(
        AGENT_COMPANION_WINDOW_MIN_SIZE,
        AGENT_COMPANION_WINDOW_MAX_WIDTH,
    );
    let height = height.clamp(
        AGENT_COMPANION_WINDOW_MIN_SIZE,
        AGENT_COMPANION_WINDOW_MAX_HEIGHT,
    );
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let size = agent_companion_window_effective_size(window);
    if (size.width - width).abs() < 0.5 && (size.height - height).abs() < 0.5 {
        return;
    }

    let old_position = window
        .outer_position()
        .ok()
        .map(|position| position.to_logical::<f64>(scale_factor));

    if let Err(e) = window.set_size(tauri::LogicalSize::new(width, height)) {
        warn!("Failed to resize Agent companion window: {}", e);
        return;
    }

    // Keep the bottom-right corner fixed when bubbles change height. If we cannot
    // read the previous geometry (e.g. transient platform errors), avoid snapping
    // back to the default corner — that would feel like the pet "jumped".
    if let Some(position) = old_position {
        let next_position = clamp_agent_companion_window_position(
            app,
            window,
            tauri::LogicalPosition::new(
                position.x + size.width - width,
                position.y + size.height - height,
            ),
            tauri::LogicalSize::new(width, height),
        );
        if let Err(e) = window.set_position(next_position) {
            warn!("Failed to position Agent companion window: {}", e);
        } else {
            remember_agent_companion_window_position(next_position);
        }
    }
}

#[tauri::command]
pub async fn show_agent_companion_desktop_pet(app: tauri::AppHandle) -> Result<(), String> {
    let started_at = Instant::now();
    let _guard = agent_companion_window_ops().lock().await;
    debug!("Agent companion window show requested");

    // Reuse any existing window: never destroy here. A previous implementation destroyed
    // whenever `is_visible` was false, which raced with another `show` that had built the
    // window but not called `show()` yet (or with `hide`), producing duplicate pets or
    // stuck windows.
    if let Some(window) = app.get_webview_window(AGENT_COMPANION_WINDOW_LABEL) {
        if let Err(e) = window.unminimize() {
            warn!("Failed to unminimize Agent companion window: {}", e);
        }
        position_agent_companion_window(&app, &window);
        window.show().map_err(|e| {
            error!("Failed to show Agent companion window: {}", e);
            format!("Failed to show Agent companion window: {}", e)
        })?;
        debug!(
            "Agent companion window reused: total_duration_ms={}",
            started_at.elapsed().as_millis()
        );
        return Ok(());
    }

    let url = app_url(&app, "?openbitfunWindow=agent-companion");
    let mut builder = tauri::WebviewWindowBuilder::new(&app, AGENT_COMPANION_WINDOW_LABEL, url)
        .title("OpenBitFun Agent Companion")
        .inner_size(
            AGENT_COMPANION_WINDOW_MIN_SIZE,
            AGENT_COMPANION_WINDOW_MIN_SIZE,
        )
        .max_inner_size(
            AGENT_COMPANION_WINDOW_MAX_WIDTH,
            AGENT_COMPANION_WINDOW_MAX_HEIGHT,
        )
        .min_inner_size(1.0, 1.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .accept_first_mouse(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .on_page_load({
            move |_window, payload| {
                let event = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                debug!(
                    "Agent companion window page load event: event={}, url={}, since_show_request_ms={}",
                    event,
                    payload.url(),
                    started_at.elapsed().as_millis()
                );
            }
        });

    builder = builder.disable_drag_drop_handler();

    let build_started_at = Instant::now();
    let window = builder.build().map_err(|e| {
        error!(
            "Failed to create Agent companion window: error={} duration_ms={}",
            e,
            build_started_at.elapsed().as_millis()
        );
        format!("Failed to create Agent companion window: {}", e)
    })?;
    debug!(
        "Agent companion window creation step completed: step=build duration_ms={} total_duration_ms={}",
        build_started_at.elapsed().as_millis(),
        started_at.elapsed().as_millis()
    );

    position_agent_companion_window(&app, &window);

    let show_started_at = Instant::now();
    window.show().map_err(|e| {
        error!("Failed to show Agent companion window: {}", e);
        format!("Failed to show Agent companion window: {}", e)
    })?;
    debug!(
        "Agent companion window shown: show_duration_ms={} total_duration_ms={}",
        show_started_at.elapsed().as_millis(),
        started_at.elapsed().as_millis()
    );

    Ok(())
}

#[tauri::command]
pub async fn resize_agent_companion_desktop_pet(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let _guard = agent_companion_window_ops().lock().await;
    if let Some(window) = app.get_webview_window(AGENT_COMPANION_WINDOW_LABEL) {
        let app_for_resize = app.clone();
        let window_for_resize = window.clone();
        window
            .run_on_main_thread(move || {
                resize_agent_companion_window(&app_for_resize, &window_for_resize, width, height);
            })
            .map_err(|e| {
                warn!("Failed to schedule Agent companion window resize: {}", e);
                format!("Failed to schedule Agent companion window resize: {}", e)
            })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hide_agent_companion_desktop_pet(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = agent_companion_window_ops().lock().await;
    if let Some(window) = app.get_webview_window(AGENT_COMPANION_WINDOW_LABEL) {
        if let Ok(scale_factor) = window.scale_factor() {
            if let Ok(position) = window.outer_position() {
                remember_agent_companion_window_position(position.to_logical::<f64>(scale_factor));
            }
        }
        window.destroy().map_err(|e| {
            error!("Failed to destroy Agent companion window: {}", e);
            format!("Failed to destroy Agent companion window: {}", e)
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let total_started_at = Instant::now();
    if let Some(main_window) = app.get_webview_window("main") {
        main_window
            .unminimize()
            .map_err(|error| error.to_string())?;
        if let Err(error) = crate::window_state_support::repair_for_activation(&main_window) {
            warn!(
                "Failed to repair main window geometry during activation: {}",
                error
            );
        }
        let step_started_at = Instant::now();
        main_window.show().map_err(|e| {
            error!("Failed to show main window: {}", e);
            format!("Failed to show main window: {}", e)
        })?;
        debug!(
            "Main window show step completed: step=show duration_ms={}",
            step_started_at.elapsed().as_millis()
        );

        #[cfg(target_os = "macos")]
        {
            crate::cancel_main_window_close_request_on_macos();
            crate::mark_main_window_hidden_on_macos(false);
        }

        let step_started_at = Instant::now();
        main_window.set_focus().map_err(|e| {
            error!("Failed to focus main window: {}", e);
            format!("Failed to focus main window: {}", e)
        })?;
        debug!(
            "Main window show step completed: step=focus duration_ms={}",
            step_started_at.elapsed().as_millis()
        );
    } else {
        error!("Main window not found");
        return Err("Main window not found".to_string());
    }

    debug!(
        "Main window shown: total_duration_ms={}",
        total_started_at.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(test)]
mod development_frontend_tests {
    use super::development_frontend_url;

    #[test]
    fn windows_use_the_configured_development_origin() {
        for origin in [
            "http://localhost:1422/",
            "http://localhost:1432/",
            "http://127.0.0.1:15432/app/",
        ] {
            let base = origin.parse().unwrap();
            assert_eq!(development_frontend_url(Some(&base), "").unwrap(), base);
            assert_eq!(
                development_frontend_url(Some(&base), "?openbitfunWindow=agent-companion")
                    .unwrap()
                    .as_str(),
                format!("{origin}?openbitfunWindow=agent-companion")
            );
        }
    }

    #[test]
    fn missing_development_url_does_not_choose_another_instance() {
        assert!(development_frontend_url(None, "")
            .unwrap_err()
            .contains("build.devUrl"));
    }
}
