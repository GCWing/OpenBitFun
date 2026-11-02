//! Detect and launch the user's default browser with CDP debug port enabled.

use anyhow::{anyhow, Result};
#[allow(unused_imports)]
use log::{debug, info};
use openbitfun_services_core::process_manager;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

/// Default CDP debug port.
pub const DEFAULT_CDP_PORT: u16 = 9222;

/// Build a `Command` that suppresses transient Windows console windows while
/// preserving normal process behavior on other platforms.
fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    process_manager::create_command(program)
}

/// Known browser identifiers and their executable paths per platform.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BrowserKind {
    Chrome,
    Edge,
    Chromium,
    Brave,
    Arc,
    Unknown(String),
}

impl std::fmt::Display for BrowserKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BrowserKind::Chrome => write!(f, "Google Chrome"),
            BrowserKind::Edge => write!(f, "Microsoft Edge"),
            BrowserKind::Chromium => write!(f, "Chromium"),
            BrowserKind::Brave => write!(f, "Brave Browser"),
            BrowserKind::Arc => write!(f, "Arc"),
            BrowserKind::Unknown(name) => write!(f, "{}", name),
        }
    }
}

/// Result of browser detection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserInfo {
    pub kind: BrowserKind,
    pub path: String,
    pub is_running: bool,
    pub cdp_available: bool,
}

/// Browser-level CDP endpoint published by a Chromium browser's user-approved
/// remote debugging flow. Unlike the legacy fixed-port endpoint, this points
/// at the user's real browser profile and the WebSocket handshake requires an
/// explicit approval in the browser.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserDebugEndpoint {
    pub port: u16,
    pub web_socket_url: String,
}

/// Cache for browser installation status to avoid repeated filesystem checks.
/// The cache is valid for the lifetime of the process since browser installations
/// don't change during a session.
static BROWSER_INSTALL_CACHE: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

pub struct BrowserLauncher;

#[derive(Debug, Clone, Default)]
pub struct BrowserLaunchOptions {
    pub user_data_dir: Option<PathBuf>,
    pub managed_profile_root: Option<PathBuf>,
    /// Wait for the user to enable guarded remote debugging in the browser's
    /// settings page. Product surfaces should opt into this only for an
    /// explicit setup action; ordinary agent connects should return guidance
    /// quickly instead of holding a tool call open.
    pub wait_for_user_profile_setup: bool,
    /// Bring the launched browser to the foreground. Off by default: browser
    /// control is background work, and activating the user's browser on every
    /// attach steals focus from whatever they were doing. Opt in only for a
    /// user-visible action such as restarting their browser from Settings.
    pub activate: bool,
}

impl BrowserLauncher {
    /// Check if a CDP debug port is already listening.
    pub async fn is_cdp_available(port: u16) -> bool {
        let url = format!("http://127.0.0.1:{}/json/version", port);
        crate::reqwest_client()
            .get(&url)
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Detect the user's default browser on the current platform.
    pub fn detect_default_browser() -> Result<BrowserKind> {
        #[cfg(target_os = "macos")]
        {
            Self::detect_default_browser_macos()
        }
        #[cfg(target_os = "windows")]
        {
            Self::detect_default_browser_windows()
        }
        #[cfg(target_os = "linux")]
        {
            Self::detect_default_browser_linux()
        }
    }

    #[cfg(target_os = "macos")]
    fn detect_default_browser_macos() -> Result<BrowserKind> {
        let output = silent_command("defaults")
            .args([
                "read",
                "com.apple.LaunchServices/com.apple.launchservices.secure",
                "LSHandlers",
            ])
            .output()
            .ok();

        if let Some(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if text.contains("com.google.chrome") {
                return Ok(BrowserKind::Chrome);
            } else if text.contains("com.microsoft.edgemac") {
                return Ok(BrowserKind::Edge);
            } else if text.contains("com.brave.browser") {
                return Ok(BrowserKind::Brave);
            } else if text.contains("company.thebrowser.browser") {
                return Ok(BrowserKind::Arc);
            }
        }

        // Fallback: check which browsers are installed
        let browsers = [
            ("/Applications/Google Chrome.app", BrowserKind::Chrome),
            ("/Applications/Microsoft Edge.app", BrowserKind::Edge),
            ("/Applications/Brave Browser.app", BrowserKind::Brave),
            ("/Applications/Arc.app", BrowserKind::Arc),
            ("/Applications/Chromium.app", BrowserKind::Chromium),
        ];

        for (path, kind) in &browsers {
            if std::path::Path::new(path).exists() {
                debug!("Found browser at {}", path);
                return Ok(kind.clone());
            }
        }

        Ok(BrowserKind::Chrome)
    }

    #[cfg(target_os = "windows")]
    fn detect_default_browser_windows() -> Result<BrowserKind> {
        let output = silent_command("reg")
            .args([
                "query",
                r"HKEY_CURRENT_USER\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
                "/v",
                "ProgId",
            ])
            .output()
            .ok();

        if let Some(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if text.contains("chrome") {
                return Ok(BrowserKind::Chrome);
            } else if text.contains("edge") {
                return Ok(BrowserKind::Edge);
            } else if text.contains("brave") {
                return Ok(BrowserKind::Brave);
            }
        }

        Ok(BrowserKind::Chrome)
    }

    #[cfg(target_os = "linux")]
    fn detect_default_browser_linux() -> Result<BrowserKind> {
        let output = silent_command("xdg-settings")
            .args(["get", "default-web-browser"])
            .output()
            .ok();

        if let Some(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if text.contains("chrome") || text.contains("google") {
                return Ok(BrowserKind::Chrome);
            } else if text.contains("edge") || text.contains("microsoft") {
                return Ok(BrowserKind::Edge);
            } else if text.contains("brave") {
                return Ok(BrowserKind::Brave);
            } else if text.contains("chromium") {
                return Ok(BrowserKind::Chromium);
            }
        }

        Ok(BrowserKind::Chrome)
    }

    /// Check whether a browser's executable (or app bundle) is present on disk.
    /// Results are cached for the process lifetime since browser installations
    /// don't change during a session.
    pub fn is_browser_installed(kind: &BrowserKind) -> bool {
        // Unknown browsers are never considered installed.
        if matches!(kind, BrowserKind::Unknown(_)) {
            return false;
        }

        let cache_key = format!("{:?}", kind);

        // Check cache first.
        {
            let cache = BROWSER_INSTALL_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(ref map) = *cache {
                if let Some(&cached) = map.get(&cache_key) {
                    return cached;
                }
            }
        }

        // Compute the result.
        let result = Self::check_browser_installed_impl(kind);

        // Store in cache.
        {
            let mut cache = BROWSER_INSTALL_CACHE
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let map = cache.get_or_insert_with(HashMap::new);
            map.insert(cache_key, result);
        }

        debug!("Browser {:?} installed: {}", kind, result);
        result
    }

    /// Internal implementation of browser installation check.
    fn check_browser_installed_impl(kind: &BrowserKind) -> bool {
        let exe = Self::browser_executable(kind);
        #[cfg(target_os = "macos")]
        {
            // On macOS, check the .app bundle instead of the inner executable
            let app_path = match kind {
                BrowserKind::Chrome => "/Applications/Google Chrome.app",
                BrowserKind::Edge => "/Applications/Microsoft Edge.app",
                BrowserKind::Brave => "/Applications/Brave Browser.app",
                BrowserKind::Arc => "/Applications/Arc.app",
                BrowserKind::Chromium => "/Applications/Chromium.app",
                BrowserKind::Unknown(_) => "",
            };
            if !app_path.is_empty() {
                return std::path::Path::new(app_path).exists();
            }
        }
        std::path::Path::new(&exe).exists()
    }

    /// Clear the browser installation cache. Useful for testing or when
    /// browser installations might have changed.
    pub fn clear_install_cache() {
        let mut cache = BROWSER_INSTALL_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *cache = None;
    }

    /// Parse a `BrowserKind` from the CDP `/json/version` "Browser" field.
    /// The field typically looks like `"HeadlessChrome/130.0..."` or
    /// `"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"`
    /// or `"Microsoft Edge/130.0..."`.
    pub fn browser_kind_from_cdp_version(version_str: &str) -> Option<BrowserKind> {
        let lower = version_str.to_ascii_lowercase();
        if lower.contains("edg") || lower.contains("edge") {
            Some(BrowserKind::Edge)
        } else if lower.contains("brave") {
            Some(BrowserKind::Brave)
        } else if lower.contains("chromium") {
            Some(BrowserKind::Chromium)
        } else if lower.contains("chrome") {
            Some(BrowserKind::Chrome)
        } else if lower.contains("arc") {
            Some(BrowserKind::Arc)
        } else {
            None
        }
    }

    pub fn browser_kind_from_config(value: &str) -> Option<BrowserKind> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "default" => None,
            "chrome" | "google-chrome" | "google_chrome" => Some(BrowserKind::Chrome),
            "edge" | "microsoft-edge" | "microsoft_edge" => Some(BrowserKind::Edge),
            "chromium" => Some(BrowserKind::Chromium),
            "brave" | "brave-browser" | "brave_browser" => Some(BrowserKind::Brave),
            "arc" => Some(BrowserKind::Arc),
            other => Some(BrowserKind::Unknown(other.to_string())),
        }
    }

    pub fn resolve_browser_kind(preferred_browser: Option<&str>) -> Result<BrowserKind> {
        if let Some(kind) = preferred_browser.and_then(Self::browser_kind_from_config) {
            Ok(kind)
        } else {
            Self::detect_default_browser()
        }
    }

    fn browser_profile_slug(kind: &BrowserKind) -> String {
        match kind {
            BrowserKind::Chrome => "chrome".to_string(),
            BrowserKind::Edge => "edge".to_string(),
            BrowserKind::Chromium => "chromium".to_string(),
            BrowserKind::Brave => "brave".to_string(),
            BrowserKind::Arc => "arc".to_string(),
            BrowserKind::Unknown(name) => name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() {
                        c.to_ascii_lowercase()
                    } else {
                        '-'
                    }
                })
                .collect::<String>()
                .trim_matches('-')
                .to_string(),
        }
    }

    pub fn managed_user_data_dir(base_user_data_dir: &Path, kind: &BrowserKind) -> PathBuf {
        base_user_data_dir
            .join("browser-control")
            .join(Self::browser_profile_slug(kind))
    }

    /// Return the browser's normal user-data directory. Browsers that expose
    /// approval-based remote debugging write `DevToolsActivePort` here.
    pub fn user_profile_data_dir(kind: &BrowserKind) -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            let home = dirs::home_dir()?;
            let application_support = home.join("Library").join("Application Support");
            let relative = match kind {
                BrowserKind::Chrome => Path::new("Google/Chrome"),
                BrowserKind::Edge => Path::new("Microsoft Edge"),
                BrowserKind::Chromium => Path::new("Chromium"),
                BrowserKind::Brave => Path::new("BraveSoftware/Brave-Browser"),
                BrowserKind::Arc => Path::new("Arc/User Data"),
                BrowserKind::Unknown(_) => return None,
            };
            return Some(application_support.join(relative));
        }

        #[cfg(target_os = "windows")]
        {
            let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
            let relative = match kind {
                BrowserKind::Chrome => Path::new("Google/Chrome/User Data"),
                BrowserKind::Edge => Path::new("Microsoft/Edge/User Data"),
                BrowserKind::Chromium => Path::new("Chromium/User Data"),
                BrowserKind::Brave => Path::new("BraveSoftware/Brave-Browser/User Data"),
                BrowserKind::Arc => Path::new("Arc/User Data"),
                BrowserKind::Unknown(_) => return None,
            };
            return Some(local_app_data.join(relative));
        }

        #[cfg(target_os = "linux")]
        {
            let config_root = std::env::var_os("CHROME_CONFIG_HOME")
                .or_else(|| std::env::var_os("XDG_CONFIG_HOME"))
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".config")))?;
            let relative = match kind {
                BrowserKind::Chrome => Path::new("google-chrome"),
                BrowserKind::Edge => Path::new("microsoft-edge"),
                BrowserKind::Chromium => Path::new("chromium"),
                BrowserKind::Brave => Path::new("BraveSoftware/Brave-Browser"),
                BrowserKind::Arc => Path::new("arc"),
                BrowserKind::Unknown(_) => return None,
            };
            return Some(config_root.join(relative));
        }
    }

    fn parse_devtools_active_port(contents: &str) -> Result<BrowserDebugEndpoint> {
        let mut lines = contents
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty());
        let raw_port = lines
            .next()
            .ok_or_else(|| anyhow!("DevToolsActivePort is missing its port"))?;
        let web_socket_path = lines
            .next()
            .ok_or_else(|| anyhow!("DevToolsActivePort is missing its WebSocket path"))?;
        let port = raw_port
            .parse::<u16>()
            .map_err(|_| anyhow!("DevToolsActivePort contains an invalid port"))?;
        if port == 0 {
            return Err(anyhow!("DevToolsActivePort contains port zero"));
        }
        if !web_socket_path.starts_with("/devtools/browser/")
            || web_socket_path.chars().any(char::is_whitespace)
        {
            return Err(anyhow!(
                "DevToolsActivePort contains an invalid browser WebSocket path"
            ));
        }

        Ok(BrowserDebugEndpoint {
            port,
            web_socket_url: format!("ws://127.0.0.1:{port}{web_socket_path}"),
        })
    }

    /// Discover a browser-level endpoint for the real user profile. This works
    /// for every supported Chromium browser that publishes `DevToolsActivePort`
    /// in its normal user-data directory. Malformed or stale files are treated
    /// as unavailable; the subsequent WebSocket connection is the source of truth.
    pub fn user_profile_debug_endpoint(kind: &BrowserKind) -> Option<BrowserDebugEndpoint> {
        let path = Self::user_profile_data_dir(kind)?.join("DevToolsActivePort");
        let contents = std::fs::read_to_string(&path).ok()?;
        match Self::parse_devtools_active_port(&contents) {
            Ok(endpoint) => {
                let address = std::net::SocketAddr::from(([127, 0, 0, 1], endpoint.port));
                if std::net::TcpStream::connect_timeout(&address, Duration::from_millis(150))
                    .is_ok()
                {
                    Some(endpoint)
                } else {
                    debug!(
                        "Ignoring stale browser DevToolsActivePort file at {}",
                        path.display()
                    );
                    None
                }
            }
            Err(error) => {
                debug!(
                    "Ignoring invalid browser DevToolsActivePort file at {}: {}",
                    path.display(),
                    error
                );
                None
            }
        }
    }

    pub fn user_profile_debugging_setup_url(kind: &BrowserKind) -> Option<&'static str> {
        match kind {
            BrowserKind::Chrome => Some("chrome://inspect/#remote-debugging"),
            BrowserKind::Edge => Some("edge://inspect/#remote-debugging"),
            _ => None,
        }
    }

    pub fn supports_default_cdp(kind: &BrowserKind) -> bool {
        // Chrome 144+ and current Edge document an inspect-page toggle that
        // starts approval-based remote debugging for the normal user profile.
        matches!(kind, BrowserKind::Chrome | BrowserKind::Edge)
    }

    fn default_cdp_preference_enabled(contents: &str) -> bool {
        serde_json::from_str::<serde_json::Value>(contents)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/devtools/remote_debugging/user-enabled")
                    .and_then(serde_json::Value::as_bool)
            })
            .unwrap_or(false)
    }

    /// Whether the browser's persistent, approval-based CDP preference is on.
    /// The endpoint is also accepted as proof because the browser may create it
    /// before its Local State update has been flushed to disk.
    pub fn is_default_cdp_enabled(kind: &BrowserKind) -> bool {
        if !Self::supports_default_cdp(kind) {
            return false;
        }
        if Self::user_profile_debug_endpoint(kind).is_some() {
            return true;
        }
        let Some(path) =
            Self::user_profile_data_dir(kind).map(|directory| directory.join("Local State"))
        else {
            return false;
        };
        std::fs::read_to_string(path)
            .ok()
            .is_some_and(|contents| Self::default_cdp_preference_enabled(&contents))
    }

    /// Open the browser's Remote debugging settings page.
    ///
    /// Chromium drops `chrome://` URLs handed to it on the command line and
    /// silently substitutes the New Tab Page, so spawning the executable with
    /// the settings URL looks to the user like "the browser opened and nothing
    /// happened". On macOS, create and focus the tab through the browser's
    /// AppleScript dictionary. This is more reliable than `open location`,
    /// especially while the browser is starting or has no open windows. Keep
    /// `open location` as a fallback for browser versions whose scripting
    /// dictionary does not expose tab creation. Other platforms have no
    /// equivalent, so the caller must hand the URL to the user instead.
    /// Returns whether the browser accepted one of the open requests.
    fn open_user_profile_debugging_setup(kind: &BrowserKind, setup_url: &str) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some(app_name) = Self::launch_app_name(kind) else {
                return false;
            };
            let app_name = app_name.replace('"', "\\\"");
            let setup_url = setup_url.replace('"', "\\\"");
            let scripts = [
                format!(
                    "tell application \"{app_name}\"\n\
                         activate\n\
                         if (count of windows) is 0 then make new window\n\
                         tell front window\n\
                           set setupTab to make new tab at end of tabs with properties {{URL:\"{setup_url}\"}}\n\
                           set active tab index to (count of tabs)\n\
                         end tell\n\
                       end tell"
                ),
                format!(
                    "tell application \"{app_name}\"\n\
                         activate\n\
                         open location \"{setup_url}\"\n\
                       end tell"
                ),
            ];

            for (attempt, script) in scripts.iter().enumerate() {
                match silent_command("osascript").args(["-e", script]).output() {
                    Ok(output) if output.status.success() => return true,
                    Ok(output) => {
                        debug!(
                            "Failed to open {} remote debugging settings (attempt {}): {}",
                            kind,
                            attempt + 1,
                            String::from_utf8_lossy(&output.stderr).trim()
                        );
                    }
                    Err(error) => {
                        debug!(
                            "Failed to run osascript for {} remote debugging settings (attempt {}): {}",
                            kind,
                            attempt + 1,
                            error
                        );
                    }
                }
            }
            false
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = setup_url;
            // Start the browser when it is not up yet so the user has somewhere
            // to paste the URL. Passing the URL itself would only reach the New
            // Tab Page, which is what made this flow look broken.
            if !Self::is_browser_running(kind) {
                let exe = Self::browser_executable(kind);
                if let Err(error) = silent_command(&exe).spawn() {
                    debug!(
                        "Failed to start {} for remote debugging setup: {}",
                        kind, error
                    );
                }
            }
            false
        }
    }

    async fn prepare_user_profile_connection(
        kind: &BrowserKind,
        wait_for_user_setup: bool,
    ) -> Result<LaunchResult> {
        if let Some(endpoint) = Self::user_profile_debug_endpoint(kind) {
            return Ok(LaunchResult::UserProfileReady { endpoint });
        }

        let setup_url = Self::user_profile_debugging_setup_url(kind)
            .ok_or_else(|| anyhow!("{} does not support guarded user-profile CDP", kind))?;
        let opened = Self::open_user_profile_debugging_setup(kind, setup_url);

        // An explicit Settings action waits up to one minute so the user can
        // tick the browser-owned consent checkbox; an ordinary agent connect
        // only waits for the normal-start fast path before returning guidance.
        let attempts = if wait_for_user_setup { 240 } else { 8 };
        for _ in 0..attempts {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if let Some(endpoint) = Self::user_profile_debug_endpoint(kind) {
                return Ok(LaunchResult::UserProfileReady { endpoint });
            }
        }

        let instructions = if opened {
            format!(
                "{kind} opened its Remote debugging settings. Turn on \"Allow remote debugging for this browser instance\" there; the browser remembers this preference for normal future starts. Then connect again and approve OpenBitFun's connection request. This guarded flow uses your current browser profile, including its existing tabs and login state."
            )
        } else {
            format!(
                "Open {setup_url} in {kind} and turn on \"Allow remote debugging for this browser instance\"; the browser remembers this preference for normal future starts. Then connect again and approve OpenBitFun's connection request. This guarded flow uses your current browser profile, including its existing tabs and login state."
            )
        };

        Ok(LaunchResult::UserProfileSetupRequired {
            browser: kind.to_string(),
            setup_url: setup_url.to_string(),
            opened,
            instructions,
        })
    }

    fn default_managed_profile_root() -> PathBuf {
        dirs::data_local_dir()
            .or_else(dirs::data_dir)
            .unwrap_or_else(std::env::temp_dir)
            .join("OpenBitFun")
    }

    fn ensure_managed_user_data_dir(kind: &BrowserKind, root: &Path) -> Result<PathBuf> {
        let dir = Self::managed_user_data_dir(root, kind);
        std::fs::create_dir_all(&dir)
            .map_err(|e| anyhow!("Failed to create browser control profile directory: {}", e))?;
        Ok(dir)
    }

    #[cfg(target_os = "macos")]
    fn launch_app_name(kind: &BrowserKind) -> Option<&'static str> {
        match kind {
            BrowserKind::Chrome => Some("Google Chrome"),
            BrowserKind::Edge => Some("Microsoft Edge"),
            BrowserKind::Brave => Some("Brave Browser"),
            BrowserKind::Arc => Some("Arc"),
            BrowserKind::Chromium => Some("Chromium"),
            BrowserKind::Unknown(_) => None,
        }
    }

    /// `open` arguments for launching a macOS browser instance.
    ///
    /// Without `-g`, `open` activates the application, so every launch pulled
    /// the user's browser in front of whatever they were doing. Background
    /// control therefore launches with `-g` and lets an explicit user-visible
    /// action opt back into activation.
    #[cfg(target_os = "macos")]
    fn macos_open_args(app_name: &str, browser_args: &[String], activate: bool) -> Vec<String> {
        let mut args = Vec::with_capacity(browser_args.len() + 5);
        if !activate {
            args.push("-g".to_string());
        }
        args.push("-n".to_string());
        args.push("-a".to_string());
        args.push(app_name.to_string());
        args.push("--args".to_string());
        args.extend(browser_args.iter().cloned());
        args
    }

    #[cfg(target_os = "macos")]
    fn spawn_macos_browser(
        kind: &BrowserKind,
        exe: &str,
        args: &[String],
        activate: bool,
    ) -> std::io::Result<std::process::Child> {
        if let Some(app_name) = Self::launch_app_name(kind) {
            let open_args = Self::macos_open_args(app_name, args, activate);
            silent_command("open").args(open_args).spawn()
        } else {
            silent_command(exe).args(args).spawn()
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn spawn_browser(
        _kind: &BrowserKind,
        exe: &str,
        args: &[String],
        _activate: bool,
    ) -> std::io::Result<std::process::Child> {
        silent_command(exe).args(args).spawn()
    }

    #[cfg(target_os = "macos")]
    fn spawn_browser(
        kind: &BrowserKind,
        exe: &str,
        args: &[String],
        activate: bool,
    ) -> std::io::Result<std::process::Child> {
        Self::spawn_macos_browser(kind, exe, args, activate)
    }

    /// Bring an already-running browser to the foreground.
    ///
    /// A browser-owned consent or approval prompt is only answerable from a
    /// visible window, so the flows that request one must surface the browser
    /// instead of leaving the user to hunt for a background window. Returns
    /// whether the request was accepted; platforms without a supported
    /// activation entry point report `false` and the caller keeps its normal
    /// guidance.
    pub fn activate_browser(kind: &BrowserKind) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some(app_name) = Self::launch_app_name(kind) else {
                return false;
            };
            match silent_command("open").args(["-a", app_name]).output() {
                Ok(output) if output.status.success() => true,
                Ok(output) => {
                    debug!(
                        "Could not activate {}: {}",
                        kind,
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                    false
                }
                Err(error) => {
                    debug!("Could not run open to activate {}: {}", kind, error);
                    false
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = kind;
            false
        }
    }

    /// Get the executable path or launch command for a browser kind.
    pub fn browser_executable(kind: &BrowserKind) -> String {
        #[cfg(target_os = "macos")]
        {
            match kind {
                BrowserKind::Chrome => {
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into()
                }
                BrowserKind::Edge => {
                    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into()
                }
                BrowserKind::Brave => {
                    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser".into()
                }
                BrowserKind::Arc => "/Applications/Arc.app/Contents/MacOS/Arc".into(),
                BrowserKind::Chromium => {
                    "/Applications/Chromium.app/Contents/MacOS/Chromium".into()
                }
                BrowserKind::Unknown(name) => name.clone(),
            }
        }

        #[cfg(target_os = "windows")]
        {
            Self::windows_browser_executable(kind)
        }

        #[cfg(target_os = "linux")]
        {
            match kind {
                BrowserKind::Chrome => "google-chrome".into(),
                BrowserKind::Edge => "microsoft-edge".into(),
                BrowserKind::Brave => "brave-browser".into(),
                BrowserKind::Chromium => "chromium-browser".into(),
                BrowserKind::Arc => "arc".into(),
                BrowserKind::Unknown(name) => name.clone(),
            }
        }
    }

    /// Windows: resolve a browser's executable path by probing common install
    /// locations (Program Files / Program Files (x86) / per-user LocalAppData)
    /// and then falling back to the registry "App Paths" entry.
    #[cfg(target_os = "windows")]
    fn windows_browser_executable(kind: &BrowserKind) -> String {
        let (rel_paths, app_paths_key, fallback_cmd) = match kind {
            BrowserKind::Chrome => (
                vec![r"Google\Chrome\Application\chrome.exe"],
                Some("chrome.exe"),
                "chrome.exe",
            ),
            BrowserKind::Edge => (
                vec![r"Microsoft\Edge\Application\msedge.exe"],
                Some("msedge.exe"),
                "msedge.exe",
            ),
            BrowserKind::Brave => (
                vec![r"BraveSoftware\Brave-Browser\Application\brave.exe"],
                Some("brave.exe"),
                "brave.exe",
            ),
            BrowserKind::Chromium => (
                vec![r"Chromium\Application\chrome.exe"],
                None,
                "chromium.exe",
            ),
            BrowserKind::Arc => (vec![r"Arc\Arc.exe"], None, "arc.exe"),
            BrowserKind::Unknown(name) => return name.clone(),
        };

        let env_roots = [
            std::env::var("ProgramFiles").ok(),
            std::env::var("ProgramFiles(x86)").ok(),
            std::env::var("ProgramW6432").ok(),
            std::env::var("LOCALAPPDATA").ok(),
        ];

        for root in env_roots.iter().flatten() {
            for rel in &rel_paths {
                let candidate = format!(r"{}\{}", root.trim_end_matches('\\'), rel);
                if std::path::Path::new(&candidate).exists() {
                    debug!("Found browser at {}", candidate);
                    return candidate;
                }
            }
        }

        // App Paths registry fallback: HKLM/HKCU \Software\Microsoft\Windows
        // \CurrentVersion\App Paths\<exe>  default value points to the .exe.
        if let Some(exe_name) = app_paths_key {
            for root in &["HKCU", "HKLM"] {
                let key = format!(
                    r"{}\Software\Microsoft\Windows\CurrentVersion\App Paths\{}",
                    root, exe_name
                );
                let output = silent_command("reg")
                    .args(["query", &key, "/ve"])
                    .output()
                    .ok();
                if let Some(out) = output {
                    let text = String::from_utf8_lossy(&out.stdout);
                    // Line looks like:  (Default)    REG_SZ    C:\Path\to\app.exe
                    for line in text.lines() {
                        let lower = line.to_ascii_lowercase();
                        if lower.contains("reg_sz") {
                            if let Some(idx) = lower.find("reg_sz") {
                                let value = line[idx + "REG_SZ".len()..].trim();
                                let unquoted = value.trim_matches('"').trim();
                                if !unquoted.is_empty() && std::path::Path::new(unquoted).exists() {
                                    debug!("Resolved {} via App Paths: {}", exe_name, unquoted);
                                    return unquoted.to_string();
                                }
                            }
                        }
                    }
                }
            }
        }

        fallback_cmd.into()
    }

    /// Launch the browser with the CDP debug port flag.
    /// Returns instructions if the browser is already running without CDP.
    pub async fn launch_with_cdp(kind: &BrowserKind, port: u16) -> Result<LaunchResult> {
        Self::launch_with_cdp_options(kind, port, BrowserLaunchOptions::default()).await
    }

    /// Same as [`launch_with_cdp`] but allows passing an isolated
    /// `--user-data-dir`. When the user is already running their main
    /// browser without CDP, an isolated profile lets us start a sibling
    /// instance with debugging enabled instead of asking them to quit.
    pub async fn launch_with_cdp_options(
        kind: &BrowserKind,
        port: u16,
        options: BrowserLaunchOptions,
    ) -> Result<LaunchResult> {
        if options.user_data_dir.is_none() {
            // Opportunistically reuse the real profile for any Chromium browser
            // that already publishes a browser-level endpoint. Chrome and Edge
            // additionally get a first-class setup flow when it is not enabled.
            if let Some(endpoint) = Self::user_profile_debug_endpoint(kind) {
                return Ok(LaunchResult::UserProfileReady { endpoint });
            }
            if Self::supports_default_cdp(kind) {
                return Self::prepare_user_profile_connection(
                    kind,
                    options.wait_for_user_profile_setup,
                )
                .await;
            }
        }

        if Self::is_cdp_available(port).await {
            info!("CDP already available on port {} for {}", port, kind);
            return Ok(LaunchResult::AlreadyConnected);
        }

        let exe = Self::browser_executable(kind);
        let profile_dir = match options.user_data_dir {
            Some(dir) => dir,
            None => {
                let root = options
                    .managed_profile_root
                    .unwrap_or_else(Self::default_managed_profile_root);
                Self::ensure_managed_user_data_dir(kind, &root)?
            }
        };
        let flag = format!("--remote-debugging-port={}", port);
        let profile_flag = format!("--user-data-dir={}", profile_dir.display());
        let mut extra: Vec<String> = vec![
            flag.clone(),
            profile_flag,
            "--no-first-run".to_string(),
            "--no-default-browser-check".to_string(),
        ];
        // This instance exists for background automation: keep its renderer and
        // timers running while the window is not focused or is occluded, so a
        // background-driven page still loads, animates, and captures.
        extra.extend(
            [
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
            ]
            .map(str::to_string),
        );

        info!(
            "Launching {} with CDP on port {} (user_data_dir={}, activate={})",
            kind,
            port,
            profile_dir.display(),
            options.activate
        );
        let result = Self::spawn_browser(kind, &exe, &extra, options.activate);

        match result {
            Ok(_child) => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;

                if Self::is_cdp_available(port).await {
                    Ok(LaunchResult::Launched)
                } else {
                    Ok(LaunchResult::LaunchedButCdpNotReady {
                        port,
                        message: format!(
                            "{} was launched but CDP is not yet responding on port {}. \
                             It may need a few more seconds to initialize.",
                            kind, port
                        ),
                    })
                }
            }
            Err(e) => Err(anyhow!("Failed to launch {}: {}", kind, e)),
        }
    }

    /// Restart is a user-initiated, visible action: the browser was just quit,
    /// so it comes back in the foreground instead of hiding behind the app the
    /// user clicked Restart in.
    pub async fn restart_with_cdp(kind: &BrowserKind, port: u16) -> Result<LaunchResult> {
        Self::launch_with_cdp_options(
            kind,
            port,
            BrowserLaunchOptions {
                activate: true,
                ..BrowserLaunchOptions::default()
            },
        )
        .await
    }

    #[allow(dead_code)]
    fn terminate_browser(kind: &BrowserKind) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            let app_name = match kind {
                BrowserKind::Chrome => "Google Chrome",
                BrowserKind::Edge => "Microsoft Edge",
                BrowserKind::Brave => "Brave Browser",
                BrowserKind::Arc => "Arc",
                BrowserKind::Chromium => "Chromium",
                BrowserKind::Unknown(name) => name.as_str(),
            };
            let script = format!(
                "tell application \"{}\" to quit",
                app_name.replace('"', "\\\"")
            );
            let output = silent_command("osascript")
                .args(["-e", &script])
                .output()
                .map_err(|e| anyhow!("Failed to quit {}: {}", kind, e))?;
            if output.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(anyhow!("Failed to quit {}: {}", kind, stderr.trim()))
        }

        #[cfg(target_os = "windows")]
        {
            let process_names: &[&str] = match kind {
                BrowserKind::Chrome => &["chrome.exe"],
                BrowserKind::Edge => &["msedge.exe"],
                BrowserKind::Brave => &["brave.exe"],
                BrowserKind::Arc => &["arc.exe"],
                BrowserKind::Chromium => &["chromium.exe", "chrome.exe"],
                BrowserKind::Unknown(_) => {
                    return Err(anyhow!("Unsupported browser kind for restart on Windows"))
                }
            };
            for process_name in process_names {
                let output = silent_command("taskkill")
                    .args(["/IM", process_name, "/F"])
                    .output()
                    .map_err(|e| anyhow!("Failed to terminate {}: {}", process_name, e))?;
                let stdout = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
                let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
                if output.status.success()
                    || stdout.contains("no instance")
                    || stdout.contains("not found")
                    || stderr.contains("no instance")
                    || stderr.contains("not found")
                {
                    continue;
                }
                return Err(anyhow!(
                    "Failed to terminate {}: {}{}",
                    process_name,
                    String::from_utf8_lossy(&output.stdout).trim(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(())
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = kind;
            Err(anyhow!(
                "Browser restart with CDP is not supported on this platform"
            ))
        }
    }

    #[allow(dead_code)]
    async fn wait_for_browser_exit(kind: &BrowserKind, timeout: Duration) -> Result<()> {
        let started = std::time::Instant::now();
        while Self::is_browser_running(kind) {
            if started.elapsed() >= timeout {
                return Err(anyhow!(
                    "Timed out waiting for {} to exit before restart",
                    kind
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Ok(())
    }

    /// Check if a browser process is currently running.
    #[allow(dead_code)]
    fn is_browser_running(kind: &BrowserKind) -> bool {
        // Per-platform process names.
        // macOS / Linux match against the executable filename via `pgrep -f`.
        // Windows must use the *.exe image name as it appears in `tasklist`.
        #[cfg(target_os = "macos")]
        let process_names: Vec<&str> = match kind {
            BrowserKind::Chrome => vec!["Google Chrome"],
            BrowserKind::Edge => vec!["Microsoft Edge"],
            BrowserKind::Brave => vec!["Brave Browser"],
            BrowserKind::Arc => vec!["Arc"],
            BrowserKind::Chromium => vec!["Chromium"],
            BrowserKind::Unknown(_) => return false,
        };

        #[cfg(target_os = "linux")]
        let process_names: Vec<&str> = match kind {
            BrowserKind::Chrome => vec!["chrome", "google-chrome"],
            BrowserKind::Edge => vec!["msedge", "microsoft-edge"],
            BrowserKind::Brave => vec!["brave", "brave-browser"],
            BrowserKind::Arc => vec!["arc"],
            BrowserKind::Chromium => vec!["chromium", "chromium-browser"],
            BrowserKind::Unknown(_) => return false,
        };

        #[cfg(target_os = "windows")]
        let process_names: Vec<&str> = match kind {
            BrowserKind::Chrome => vec!["chrome.exe"],
            BrowserKind::Edge => vec!["msedge.exe"],
            BrowserKind::Brave => vec!["brave.exe"],
            BrowserKind::Arc => vec!["arc.exe"],
            BrowserKind::Chromium => vec!["chrome.exe", "chromium.exe"],
            BrowserKind::Unknown(_) => return false,
        };

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            for name in &process_names {
                let output = silent_command("pgrep").args(["-f", name]).output().ok();
                if let Some(out) = output {
                    if out.status.success() && !out.stdout.is_empty() {
                        return true;
                    }
                }
            }
            false
        }

        #[cfg(target_os = "windows")]
        {
            for image in &process_names {
                let filter = format!("IMAGENAME eq {}", image);
                let output = silent_command("tasklist")
                    .args(["/FI", &filter, "/NH", "/FO", "CSV"])
                    .output()
                    .ok();
                if let Some(out) = output {
                    let text = String::from_utf8_lossy(&out.stdout);
                    // tasklist prints "INFO: No tasks ..." when nothing matches;
                    // otherwise the first CSV column contains the image name.
                    if text
                        .to_ascii_lowercase()
                        .contains(&image.to_ascii_lowercase())
                    {
                        return true;
                    }
                }
            }
            false
        }
    }
}

/// Result of a browser launch attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LaunchResult {
    AlreadyConnected,
    Launched,
    UserProfileReady {
        endpoint: BrowserDebugEndpoint,
    },
    UserProfileSetupRequired {
        browser: String,
        setup_url: String,
        /// Whether the settings page could be opened for the user. Platforms
        /// without a browser automation entry point can only show the URL.
        opened: bool,
        instructions: String,
    },
    LaunchedButCdpNotReady {
        port: u16,
        message: String,
    },
    BrowserRunningWithoutCdp {
        browser: String,
        executable: String,
        port: u16,
        instructions: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_kind_from_config_parses_known_values() {
        assert_eq!(
            BrowserLauncher::browser_kind_from_config("google-chrome"),
            Some(BrowserKind::Chrome)
        );
        assert_eq!(
            BrowserLauncher::browser_kind_from_config("microsoft_edge"),
            Some(BrowserKind::Edge)
        );
        assert_eq!(BrowserLauncher::browser_kind_from_config("default"), None);
    }

    #[test]
    fn browser_kind_from_cdp_version_prefers_edge_before_chrome() {
        assert_eq!(
            BrowserLauncher::browser_kind_from_cdp_version(
                "Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0"
            ),
            Some(BrowserKind::Edge)
        );
    }

    #[test]
    fn managed_user_data_dir_sanitizes_unknown_browser_name() {
        let root = PathBuf::from("/tmp/openbitfun-test");
        let dir = BrowserLauncher::managed_user_data_dir(
            &root,
            &BrowserKind::Unknown("Custom Browser!".to_string()),
        );
        assert_eq!(dir, root.join("browser-control").join("custom-browser"));
    }

    #[test]
    fn devtools_active_port_parser_accepts_guarded_browser_endpoint() {
        let endpoint = BrowserLauncher::parse_devtools_active_port(
            "62314\n/devtools/browser/598cf21d-ec63-45f3-abba-698f26a88807\n",
        )
        .expect("valid endpoint");

        assert_eq!(endpoint.port, 62314);
        assert_eq!(
            endpoint.web_socket_url,
            "ws://127.0.0.1:62314/devtools/browser/598cf21d-ec63-45f3-abba-698f26a88807"
        );
    }

    #[test]
    fn devtools_active_port_parser_rejects_non_browser_paths() {
        let error = BrowserLauncher::parse_devtools_active_port(
            "9222\nhttp://attacker.example/devtools/browser/token\n",
        )
        .expect_err("non-local path must be rejected");

        assert!(error.to_string().contains("invalid browser WebSocket path"));
    }

    #[test]
    fn guarded_real_profile_setup_is_available_for_chrome_and_edge() {
        assert!(BrowserLauncher::supports_default_cdp(&BrowserKind::Chrome));
        assert!(BrowserLauncher::supports_default_cdp(&BrowserKind::Edge));
        assert_eq!(
            BrowserLauncher::user_profile_debugging_setup_url(&BrowserKind::Chrome),
            Some("chrome://inspect/#remote-debugging")
        );
        assert_eq!(
            BrowserLauncher::user_profile_debugging_setup_url(&BrowserKind::Edge),
            Some("edge://inspect/#remote-debugging")
        );
        assert!(!BrowserLauncher::supports_default_cdp(&BrowserKind::Brave));
    }

    #[test]
    fn default_cdp_preference_reads_chromium_local_state_shape() {
        assert!(BrowserLauncher::default_cdp_preference_enabled(
            r#"{"devtools":{"remote_debugging":{"user-enabled":true}}}"#
        ));
        assert!(!BrowserLauncher::default_cdp_preference_enabled(
            r#"{"devtools":{"remote_debugging":{"user-enabled":false}}}"#
        ));
        assert!(!BrowserLauncher::default_cdp_preference_enabled("{}"));
    }

    #[test]
    fn browser_launch_does_not_activate_by_default() {
        assert!(!BrowserLaunchOptions::default().activate);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_background_launch_keeps_the_browser_out_of_the_foreground() {
        let browser_args = vec!["--remote-debugging-port=9222".to_string()];

        let background = BrowserLauncher::macos_open_args("Google Chrome", &browser_args, false);
        assert_eq!(
            background,
            vec![
                "-g".to_string(),
                "-n".to_string(),
                "-a".to_string(),
                "Google Chrome".to_string(),
                "--args".to_string(),
                "--remote-debugging-port=9222".to_string(),
            ]
        );

        let foreground = BrowserLauncher::macos_open_args("Google Chrome", &browser_args, true);
        assert!(!foreground.iter().any(|argument| argument == "-g"));
        assert!(foreground.contains(&"--args".to_string()));
    }
}
