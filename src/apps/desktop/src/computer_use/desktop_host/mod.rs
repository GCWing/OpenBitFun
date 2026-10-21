//! Desktop ComputerUseHost: scoped observations and platform-native capture/input providers.

mod screenshot;
use screenshot::PointerMap;
mod background_guard;
mod foreground;
#[cfg(any(target_os = "linux", test))]
mod linux_launch;
mod observation;
pub(crate) mod shared_preview;
pub(crate) mod sharing;
mod state;
#[cfg(target_os = "windows")]
mod windows_launch;
use state::ComputerUseSessionMutableState;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use state::{CachedInteractiveView, CachedVisualMarkView};

use async_trait::async_trait;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use log::debug;
use openbitfun_core::agentic::tools::computer_use_host::{
    ActionRecord, AppInfo, AppSelector, AppShortcutsSnapshot, AppStateSnapshot, AppWaitPredicate,
    AppWindowInfo, ComputerScreenshot, ComputerUseDisplayInfo, ComputerUseHost,
    ComputerUseInteractionState, ComputerUseLastMutationKind, ComputerUsePermissionSnapshot,
    ComputerUseScreenshotParams, ComputerUseScreenshotRefinement, ComputerUseSessionSnapshot,
    InteractiveActionResult, InteractiveClickParams, InteractiveScrollParams,
    InteractiveTypeTextParams, InteractiveView, InteractiveViewOpts, LoopDetectionResult,
    UiElementLocateQuery, UiElementLocateResult, VisualActionResult, VisualClickParams,
    VisualMarkView, VisualMarkViewOpts,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use openbitfun_core::agentic::tools::computer_use_host::{
    ComputerUseForegroundApplication, ComputerUsePointerGlobal,
};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use screenshots::Screen;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Error text when `click_needs_fresh_screenshot` blocks `click` or Enter `key_chord` (single source of truth).
const STALE_CAPTURE_TOOL_MESSAGE: &str = "[STALE_CAPTURE] Observe the authorized target with screenshot or get_app_state before sending coordinate input. Use the returned screenshot_id; input is rejected after target or geometry changes.";

static SCREENSHOT_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// How long `open_app` waits for a freshly activated app to show up in
/// LaunchServices before giving up on resolving its pid.
#[cfg(target_os = "macos")]
const OPEN_APP_SETTLE_MS: u64 = 3_000;
/// How long `open_app` waits for the app to put a window on screen. Cold
/// Electron launches routinely need several seconds; reporting `window_count:
/// 0` too early would send the agent down a false "app is broken" path.
#[cfg(target_os = "macos")]
const OPEN_APP_WINDOW_WAIT_MS: u64 = 8_000;
#[cfg(target_os = "macos")]
const OPEN_APP_POLL_INTERVAL_MS: u64 = 150;

/// How long an `open_app` AppleScript may run before it is killed.
///
/// `activate` sends an AppleEvent to the target app and waits for it to answer.
/// A hung or busy app simply does not answer, and macOS's default AppleEvent
/// timeout is **120 seconds** — during which `open_app` occupies a blocking
/// thread and the agent has no idea anything is wrong. An app that has not
/// acknowledged activation in a few seconds is not going to.
#[cfg(target_os = "macos")]
const OSASCRIPT_TIMEOUT_MS: u64 = 10_000;

/// Run `osascript -e <script>`, killing it if it outlives `timeout_ms`.
///
/// `Command::output()` has no timeout, so a wedged AppleEvent blocks until
/// macOS gives up. Polling `try_wait` lets us bound it. Output here is a bundle
/// id or an error line, far below the pipe buffer, so draining after exit
/// cannot deadlock — and a child that did fill the buffer would stop making
/// progress and get killed by this same deadline.
#[cfg(target_os = "macos")]
fn run_osascript_bounded(script: &str, timeout_ms: u64) -> std::io::Result<std::process::Output> {
    use std::process::Stdio;

    let mut child = openbitfun_core::util::process_manager::create_command("/usr/bin/osascript")
        .args(["-e", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait()? {
            // Exited: `wait_with_output` below returns the recorded status.
            Some(_) => break,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("osascript did not finish within {}ms", timeout_ms),
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    child.wait_with_output()
}

/// Quote a string as an AppleScript literal.
///
/// App names reach us from the model and can contain quotes or backslashes;
/// interpolating them raw would let a name break out of the string and change
/// what the script does.
#[cfg(target_os = "macos")]
fn applescript_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

#[cfg(test)]
mod visual_grid_tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder;
    use image::{DynamicImage, Rgb, RgbImage};
    use openbitfun_core::agentic::tools::computer_use_host::ComputerUseImageContentRect;

    #[test]
    fn detects_regular_grid_rect_from_synthetic_screenshot() {
        let mut img = RgbImage::from_pixel(420, 360, Rgb([245, 245, 245]));
        let left = 60u32;
        let top = 40u32;
        let size = 280u32;
        for i in 0..15u32 {
            let pos = i * (size - 1) / 14;
            for d in 0..2 {
                let x = left + pos + d;
                if x < left + size {
                    for y in top..top + size {
                        img.put_pixel(x, y, Rgb([25, 25, 25]));
                    }
                }
                let y = top + pos + d;
                if y < top + size {
                    for x in left..left + size {
                        img.put_pixel(x, y, Rgb([25, 25, 25]));
                    }
                }
            }
        }

        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 92)
            .encode_image(&DynamicImage::ImageRgb8(img))
            .expect("encode synthetic grid");
        let shot = ComputerScreenshot {
            capture_frame: None,
            screenshot_id: Some("test-shot".to_string()),
            bytes,
            mime_type: "image/jpeg".to_string(),
            image_width: 420,
            image_height: 360,
            native_width: 420,
            native_height: 360,
            display_origin_x: 0,
            display_origin_y: 0,
            vision_scale: 1.0,
            pointer_image_x: None,
            pointer_image_y: None,
            screenshot_crop_center: None,
            point_crop_half_extent_native: None,
            navigation_native_rect: None,
            quadrant_navigation_click_ready: false,
            image_content_rect: Some(ComputerUseImageContentRect {
                left: 0,
                top: 0,
                width: 420,
                height: 360,
            }),
            image_global_bounds: None,
            ui_tree_text: None,
            implicit_confirmation_crop_applied: false,
            auxiliary_windows: Vec::new(),
        };

        let (x0, y0, width, height) =
            super::ax_orchestration::detect_regular_grid_rect_from_screenshot(&shot, 15, 15)
                .expect("detect grid");
        assert!((x0 - left as i32).abs() <= 6, "x0={x0}");
        assert!((y0 - top as i32).abs() <= 6, "y0={y0}");
        assert!((width as i32 - size as i32).abs() <= 12, "width={width}");
        assert!((height as i32 - size as i32).abs() <= 12, "height={height}");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_applescript_tests {
    use super::*;

    /// Compile an AppleScript source **without running it**. `osacompile`
    /// reports the same syntax errors `osascript` would, so this checks that a
    /// template is valid AppleScript with no side effects.
    fn compiles(script: &str) -> Result<(), String> {
        let out = std::process::Command::new("/usr/bin/osacompile")
            .args(["-o", "/dev/null", "-e", script])
            .output()
            .map_err(|e| format!("spawn osacompile: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// The bug that motivated this test: the frontmost-app lookup embedded a
    /// `try … end try` **block** in expression position. AppleScript rejects
    /// that at compile time, so the command always exited non-zero and the
    /// caller silently saw `None` — for every call, forever. Nothing in the
    /// build or the test suite noticed, because an AppleScript template is just
    /// a string until something runs it.
    ///
    /// Every AppleScript this module generates now has to compile.
    #[test]
    fn every_generated_applescript_compiles() {
        // Includes the names that exercise `applescript_quote`: a quote, a
        // backslash and CJK. Asserting the *escaped* form compiles is what
        // proves the escaping is genuine AppleScript rather than a plausible
        // guess about its string-literal syntax.
        for name in ["Safari", "a\"b", "a\\b", "飞书", "Visual Studio Code"] {
            for t in [
                format!("id of application {}", applescript_quote(name)),
                format!("tell application {} to activate", applescript_quote(name)),
            ] {
                assert!(compiles(&t).is_ok(), "template failed to compile: {t}");
            }
        }
    }

    #[test]
    fn applescript_compile_check_actually_rejects_bad_syntax() {
        // Guards the guard: if `compiles` ever silently passed everything, the
        // test above would be worthless. This is the exact broken spelling.
        let broken = r#"tell application "System Events"
  return (try (bundle identifier of p as text) on error "" end try)
end tell"#;
        assert!(compiles(broken).is_err());
    }

    /// A wedged AppleEvent must not pin a blocking thread for macOS's 120s
    /// default. `delay` inside osascript is a real hang from our side: the
    /// process is alive and unresponsive, exactly like an app that never
    /// acknowledges activation.
    #[test]
    fn a_hung_applescript_is_killed_at_the_deadline() {
        let started = std::time::Instant::now();
        let err = run_osascript_bounded("delay 30", 700)
            .expect_err("a 30s script under a 700ms budget must not succeed");

        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut, "{err}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "returned after {:?} — the deadline did not take effect",
            started.elapsed()
        );
    }

    /// The bounded runner must stay a drop-in for the normal path: same stdout,
    /// same exit status.
    #[test]
    fn a_normal_applescript_still_returns_its_output() {
        let out = run_osascript_bounded("return \"ok\"", OSASCRIPT_TIMEOUT_MS).expect("should run");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }

    #[test]
    fn applescript_quote_escapes_quotes_and_backslashes() {
        // App names come from the model, so a name containing a quote must not
        // be able to terminate the literal and change what the script does.
        assert_eq!(applescript_quote("Safari"), "\"Safari\"");
        assert_eq!(applescript_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(applescript_quote("a\\b"), "\"a\\\\b\"");
        assert_eq!(applescript_quote("飞书"), "\"飞书\"");
    }

    #[test]
    fn quoted_app_names_stay_inside_the_literal() {
        // `" to activate` + a payload would otherwise become script code.
        let hostile = "X\" to activate\ntell application \"Calculator";
        let script = format!(
            "tell application {} to activate",
            applescript_quote(hostile)
        );
        assert!(
            !script.contains("tell application \"Calculator\""),
            "injected tell survived quoting: {script}"
        );
    }

    /// The foreground lookup must return a real app in a GUI session. Ignored
    /// by default because it needs a logged-in window server.
    #[test]
    #[ignore]
    fn frontmost_application_resolves_in_a_gui_session() {
        let app = DesktopComputerUseHost::macos_foreground_application()
            .expect("a GUI session always has a frontmost application");
        assert!(app.process_id.unwrap_or(0) > 0);
        assert!(
            app.name.is_some() || app.bundle_id.is_some(),
            "frontmost app must be identifiable: {app:?}"
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_foreground_tests {
    use super::*;

    #[test]
    fn foreground_app_reports_executable_separately_from_window_title() {
        let app = DesktopComputerUseHost::windows_foreground_application(
            "Search".to_string(),
            4242,
            Some("explorer.exe".to_string()),
        );

        assert_eq!(app.name.as_deref(), Some("Search"));
        assert_eq!(app.process_name.as_deref(), Some("explorer.exe"));
        assert_eq!(app.process_id, Some(4242));
    }

    #[test]
    fn foreground_app_falls_back_to_title_only_when_process_lookup_fails() {
        let app = DesktopComputerUseHost::windows_foreground_application(
            "Search".to_string(),
            4242,
            None,
        );

        assert_eq!(app.name.as_deref(), Some("Search"));
        assert_eq!(app.process_name, None);
    }

    #[test]
    fn foreground_app_drops_empty_title_and_empty_executable() {
        let app = DesktopComputerUseHost::windows_foreground_application(
            String::new(),
            0,
            Some(String::new()),
        );

        assert_eq!(app.name, None);
        assert_eq!(app.process_name, None);
    }
}

pub struct DesktopComputerUseHost {
    state: Mutex<ComputerUseSessionMutableState>,
}

impl std::fmt::Debug for DesktopComputerUseHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopComputerUseHost")
            .finish_non_exhaustive()
    }
}

impl Default for DesktopComputerUseHost {
    fn default() -> Self {
        Self::new()
    }
}

impl DesktopComputerUseHost {
    fn state_for_scope(
        &self,
        scope: &openbitfun_agent_tools::computer_use_control::ObservationScope,
    ) -> OpenBitFunResult<std::sync::MutexGuard<'_, ComputerUseSessionMutableState>> {
        crate::computer_use::control_session::validate_observation_scope(scope)
            .map_err(OpenBitFunError::tool)?;
        let mut state = self.state.lock().map_err(|_| {
            OpenBitFunError::tool("[CONTROL_FAILED] Observation cache lock poisoned")
        })?;
        state.synchronize(scope);
        Ok(state)
    }

    pub fn new() -> Self {
        Self {
            state: Mutex::new(ComputerUseSessionMutableState::new()),
        }
    }

    fn next_screenshot_id() -> String {
        let seq = SCREENSHOT_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("shot_{}_{}", ms, seq)
    }

    /// Best-effort foreground app + pointer; safe to call from `spawn_blocking`.
    fn collect_session_snapshot_sync() -> ComputerUseSessionSnapshot {
        #[cfg(target_os = "macos")]
        {
            Self::session_snapshot_macos()
        }
        #[cfg(target_os = "windows")]
        {
            Self::session_snapshot_windows()
        }
        #[cfg(target_os = "linux")]
        {
            return Self::session_snapshot_linux();
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            ComputerUseSessionSnapshot::default()
        }
    }

    #[cfg(target_os = "macos")]
    fn session_snapshot_macos() -> ComputerUseSessionSnapshot {
        let pointer = macos::quartz_mouse_location()
            .ok()
            .map(|(x, y)| ComputerUsePointerGlobal { x, y });
        let foreground = Self::macos_foreground_application();
        ComputerUseSessionSnapshot {
            foreground_application: foreground,
            pointer_global: pointer,
        }
    }

    /// Launch (or re-front) a macOS app and report enough identity for the
    /// agent to keep working with it.
    ///
    /// Three things the previous implementation got wrong, each of which cost
    /// the agent a long recovery detour:
    ///
    /// 1. It reported only a pid. The name the caller launches by, the
    ///    executable name and the bundle id are frequently three different
    ///    strings (`Lark` / `Feishu` / `com.electron.lark`), so every follow-up
    ///    `tell process "…"` or `open -a …` guessed wrong.
    /// 2. It slept a flat `delay 1` and declared success, whether or not a
    ///    window ever appeared.
    /// 3. `activate` does not reopen a window for an app that is already
    ///    running with none — the usual state for an Electron client the user
    ///    closed earlier. The result was `success: true` with an empty screen.
    ///
    /// Resolve the bundle identity, open with the session's activation policy,
    /// poll for a window, and re-open the bundle when the poll comes up empty.
    #[cfg(target_os = "macos")]
    fn open_app_macos(
        name: String,
        background: bool,
    ) -> OpenBitFunResult<openbitfun_core::agentic::tools::computer_use_host::OpenAppResult> {
        use crate::computer_use::macos_bg_input::{
            pid_for_bundle_id_macos, running_app_identity_macos,
        };
        use openbitfun_core::agentic::tools::computer_use_host::OpenAppResult;

        let failure = |err: String| OpenAppResult {
            app_name: name.clone(),
            success: false,
            process_id: None,
            error_message: Some(err),
            bundle_id: None,
            process_name: None,
            window_count: None,
            launch_path: None,
        };

        // Discovery returns bundle identifiers as well as names. A running
        // bundle need not be registered in LaunchServices (for example a
        // freshly built app), and an existing window needs no launch at all.
        let running_pid = pid_for_bundle_id_macos(&name);
        if background {
            if let Some(pid) = running_pid {
                let window_count = crate::computer_use::macos_ax_ui::window_count_for_pid(pid);
                if window_count.is_some_and(|count| count > 0) {
                    let (process_name, bundle_id) =
                        running_app_identity_macos(pid).unwrap_or((None, None));
                    return Ok(OpenAppResult {
                        app_name: name,
                        success: true,
                        process_id: Some(pid),
                        error_message: None,
                        bundle_id,
                        process_name,
                        window_count,
                        launch_path: Some("already_running".into()),
                    });
                }
            }
        }
        let bundle_id = running_pid.map(|_| name.clone()).or_else(|| {
            ["application", "application id"]
                .into_iter()
                .find_map(|specifier| {
                    run_osascript_bounded(
                        &format!("id of {specifier} {}", applescript_quote(&name)),
                        OSASCRIPT_TIMEOUT_MS,
                    )
                    .ok()
                    .filter(|o| o.status.success())
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .filter(|s| !s.is_empty())
                })
        });

        crate::computer_use::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
        let opened = if background {
            let mut command =
                openbitfun_core::util::process_manager::create_command("/usr/bin/open");
            command.arg("-g");
            if std::path::Path::new(&name).is_absolute() {
                // A caller-provided app path stays authoritative even before
                // LaunchServices has registered that bundle identifier.
                command.args(["-a", &name]);
            } else if let Some(bundle) = bundle_id.as_deref() {
                command.args(["-b", bundle]);
            } else {
                command.args(["-a", &name]);
            }
            command.output()
        } else {
            run_osascript_bounded(
                &format!("tell application {} to activate", applescript_quote(&name)),
                OSASCRIPT_TIMEOUT_MS,
            )
        };
        let activate = match opened {
            Ok(out) => out,
            // A timeout is a real outcome, not an internal error: the app is
            // installed but not answering. Report it as a failed launch the
            // agent can act on rather than bubbling an opaque io error.
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                return Ok(failure(format!(
                    "'{}' did not respond to activation within {}s — it may be hung or showing a modal dialog. \
Inspect its process and current application state before choosing another operation.",
                    name,
                    OSASCRIPT_TIMEOUT_MS / 1000
                )));
            }
            Err(e) => return Err(OpenBitFunError::tool(format!("open_app osascript: {}", e))),
        };
        if !activate.status.success() {
            return Ok(failure(
                String::from_utf8_lossy(&activate.stderr).trim().to_string(),
            ));
        }

        let mut launch_path = if background {
            "open_background"
        } else {
            "activate"
        };
        // Resolving by bundle id beats "whoever is frontmost right now" —
        // activation is asynchronous, so the frontmost app during the first
        // poll ticks is often still the previous one.
        let mut pid = Self::poll_for_app_pid(bundle_id.as_deref(), OPEN_APP_SETTLE_MS);
        let mut window_count = Self::poll_for_window(pid, OPEN_APP_WINDOW_WAIT_MS);

        // Alive but windowless: `open -b` asks the app to reopen its main
        // window (AppKit `applicationShouldHandleReopen:`), which `activate`
        // alone never triggers.
        if window_count == Some(0) {
            if let Some(bid) = bundle_id.as_deref() {
                crate::computer_use::control_session::input_allowed()
                    .map_err(OpenBitFunError::tool)?;
                let mut command =
                    openbitfun_core::util::process_manager::create_command("/usr/bin/open");
                if background {
                    command.arg("-g");
                }
                let reopened = command
                    .args(["-b", bid])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if reopened {
                    launch_path = if background {
                        "reopen_background"
                    } else {
                        "reopen_bundle"
                    };
                    pid = Self::poll_for_app_pid(Some(bid), OPEN_APP_WINDOW_WAIT_MS).or(pid);
                    window_count = Self::poll_for_window(pid, OPEN_APP_WINDOW_WAIT_MS);
                }
            }
        }

        let (localized_name, resolved_bundle) = pid
            .and_then(running_app_identity_macos)
            .unwrap_or((None, None));

        Ok(OpenAppResult {
            app_name: name,
            success: true,
            process_id: pid,
            error_message: None,
            bundle_id: resolved_bundle.or(bundle_id),
            process_name: localized_name,
            window_count,
            launch_path: Some(launch_path.to_string()),
        })
    }

    /// Poll for the launched bundle. Never report the user's foreground app
    /// as the launch target when application identity could not be resolved.
    #[cfg(target_os = "macos")]
    fn poll_for_app_pid(bundle_id: Option<&str>, budget_ms: u64) -> Option<i32> {
        use crate::computer_use::macos_bg_input::pid_for_bundle_id_macos;
        let bundle_id = bundle_id?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
        loop {
            let found = pid_for_bundle_id_macos(bundle_id);
            if found.is_some() {
                return found;
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(OPEN_APP_POLL_INTERVAL_MS));
        }
    }

    /// Poll until the app owns at least one window, or the budget expires.
    /// Returns the final observed count so callers can report `Some(0)` — a
    /// windowless-but-alive app is a real state, not a failure to measure.
    #[cfg(target_os = "macos")]
    fn poll_for_window(pid: Option<i32>, budget_ms: u64) -> Option<usize> {
        use crate::computer_use::macos_ax_ui::window_count_for_pid;
        let pid = pid?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
        let mut last = window_count_for_pid(pid);
        while last.unwrap_or(0) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(OPEN_APP_POLL_INTERVAL_MS));
            last = window_count_for_pid(pid);
        }
        last
    }

    /// Identity of the frontmost macOS application, read from `NSWorkspace`.
    ///
    /// This used to shell out to `osascript`. That spelling embedded a
    /// `try … end try` **block** in expression position, which AppleScript
    /// rejects at compile time (`-2741`), so the command always exited
    /// non-zero and this function always returned `None`. Because
    /// `describe_screen` derives its target app from this value, the text-only
    /// observation path was permanently blind: it reported
    /// `foreground_application: null` and `ax_tree_text: null` on every call,
    /// and the agent could only conclude its own output was being truncated.
    #[cfg(target_os = "macos")]
    fn macos_foreground_application() -> Option<ComputerUseForegroundApplication> {
        let app = crate::computer_use::macos_bg_input::frontmost_app_identity_macos()?;
        Some(ComputerUseForegroundApplication {
            name: app.name.clone(),
            // `localizedName` is the app's user-visible name ("飞书"), which on
            // localised or re-branded bundles differs from both the executable
            // name ("Feishu") and the bundle name ("Lark"). Callers that need
            // to address the process by name should prefer `bundle_id`.
            process_name: app.name,
            bundle_id: app.bundle_id,
            process_id: Some(app.pid),
        })
    }

    #[cfg(target_os = "windows")]
    fn session_snapshot_windows() -> ComputerUseSessionSnapshot {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetCursorPos, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        };

        unsafe {
            let mut pt = POINT::default();
            let pointer = if GetCursorPos(&mut pt).is_ok() {
                Some(ComputerUsePointerGlobal {
                    x: pt.x as f64,
                    y: pt.y as f64,
                })
            } else {
                None
            };

            let hwnd = GetForegroundWindow();
            let foreground = if hwnd.is_invalid() {
                None
            } else {
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let mut buf = [0u16; 512];
                let n = GetWindowTextW(hwnd, &mut buf) as usize;
                let title = if n > 0 {
                    String::from_utf16_lossy(&buf[..n.min(512)])
                } else {
                    String::new()
                };
                let exe_basename = if pid == 0 {
                    None
                } else {
                    crate::computer_use::windows_list_apps::exe_basename_for_pid(pid)
                };
                Some(Self::windows_foreground_application(
                    title,
                    pid,
                    exe_basename,
                ))
            };

            ComputerUseSessionSnapshot {
                foreground_application: foreground,
                pointer_global: pointer,
            }
        }
    }

    /// Build the Windows foreground-app identity from the window title and the
    /// owning process's executable basename.
    ///
    /// `name` stays the window title; `process_name` carries the *process*
    /// identity. Callers that classify the frontmost app (browser detection)
    /// must match on `process_name`: window titles collide with app names by
    /// substring (a "Search" window contains "arc"). When the process cannot be
    /// opened (access denied, exited), `process_name` is `None` and callers see
    /// the pre-existing title-only shape.
    #[cfg(target_os = "windows")]
    fn windows_foreground_application(
        title: String,
        pid: u32,
        exe_basename: Option<String>,
    ) -> ComputerUseForegroundApplication {
        ComputerUseForegroundApplication {
            name: if title.is_empty() { None } else { Some(title) },
            process_name: exe_basename.filter(|s| !s.is_empty()),
            bundle_id: None,
            process_id: Some(pid as i32),
        }
    }

    #[cfg(target_os = "linux")]
    fn session_snapshot_linux() -> ComputerUseSessionSnapshot {
        // Best-effort: no standard API across Wayland/X11 without extra deps.
        ComputerUseSessionSnapshot::default()
    }

    /// Best-effort current mouse position in global screen coordinates.
    pub(super) fn current_mouse_position() -> (f64, f64) {
        #[cfg(target_os = "macos")]
        {
            macos::quartz_mouse_location().unwrap_or((0.0, 0.0))
        }
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
            unsafe {
                let mut pt = POINT::default();
                if GetCursorPos(&mut pt).is_ok() {
                    (pt.x as f64, pt.y as f64)
                } else {
                    (0.0, 0.0)
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            use enigo::Mouse;
            match Self::run_enigo_job(|e| {
                e.location()
                    .map_err(|err| OpenBitFunError::tool(format!("pointer location: {}", err)))
            }) {
                Ok((x, y)) => (x as f64, y as f64),
                Err(_) => (0.0, 0.0),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            (0.0, 0.0)
        }
    }
}

mod ax_orchestration;
/// macOS Accessibility / screen-capture permission FFI and main-thread /
/// Objective-C exception dispatch helpers. See `desktop_host/macos.rs`.
#[cfg(target_os = "macos")]
mod macos;
mod pointer_input;
mod settle;

impl DesktopComputerUseHost {
    /// Enumerate the registered keyboard shortcuts in `app`'s menu bar.
    /// Read-only counterpart to `key_chord` / `app_key_chord` (which only
    /// **send** keys). Unlike `get_app_state_inner`, macOS does not need
    /// the app to be frontmost — `AXMenuBar` is queryable from any running
    /// app's AX element — while Windows resolves a (not-necessarily-
    /// foreground) top-level window owned by the target pid.
    pub(crate) async fn get_app_shortcuts_inner(
        &self,
        app: AppSelector,
    ) -> OpenBitFunResult<AppShortcutsSnapshot> {
        #[cfg(target_os = "macos")]
        {
            // Same `[PERMISSION_DENIED]` contract as `get_app_state_inner`
            // — without Accessibility trust, `AXMenuBar` silently returns
            // nothing rather than erroring, which would look like "this
            // app has no shortcuts" instead of "OpenBitFun lacks permission".
            macos::require_ax_trust_for("After granting, retry `desktop.get_app_shortcuts`.")?;
            let pid = resolve_pid_macos(self, &app).await?;
            let (shortcuts, menu_items_without_shortcut) =
                crate::computer_use::control_session::spawn_blocking(move || {
                    macos::catch_objc(|| {
                        crate::computer_use::macos_ax_shortcuts::dump_app_menu_shortcuts(pid)
                    })
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;

            let captured_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(AppShortcutsSnapshot {
                app: app_info_for_pid(self, pid).await,
                shortcuts,
                menu_items_without_shortcut,
                captured_at_ms,
            })
        }
        #[cfg(target_os = "windows")]
        {
            let pid = resolve_pid(self, &app).await? as u32;
            let hwnd_isize =
                crate::computer_use::windows_list_apps::find_default_window_for_pid(pid)
                    .map(|h| h.0 as isize)
                    .ok_or_else(|| {
                        OpenBitFunError::tool(format!(
                            "APP_NOT_FOUND: no visible top-level window for pid={} (app={:?})",
                            pid, app
                        ))
                    })?;

            let (shortcuts, menu_items_without_shortcut) =
                crate::computer_use::control_session::spawn_blocking(move || {
                    let hwnd =
                        windows::Win32::Foundation::HWND(hwnd_isize as *mut std::ffi::c_void);
                    crate::computer_use::windows_ax_shortcuts::get_app_menu_shortcuts(hwnd)
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;

            let captured_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Ok(AppShortcutsSnapshot {
                app: app_info_for_pid(self, pid as i32).await,
                shortcuts,
                menu_items_without_shortcut,
                captured_at_ms,
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = app;
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }
}

#[cfg(target_os = "macos")]
fn require_macos_background_input() -> OpenBitFunResult<()> {
    if crate::computer_use::macos_bg_input::supports_background_input() {
        return Ok(());
    }
    Err(OpenBitFunError::tool(
        "[BACKGROUND_INPUT_UNAVAILABLE] macOS Accessibility permission is required for background app input. Grant OpenBitFun in System Settings -> Privacy & Security -> Accessibility, then retry desktop.meta/capabilities or desktop.get_app_state.".to_string(),
    ))
}

#[async_trait]
impl ComputerUseHost for DesktopComputerUseHost {
    async fn dispatch_app_input(
        &self,
        app: AppSelector,
        action: openbitfun_core::agentic::tools::computer_use_host::AppInputAction,
    ) -> OpenBitFunResult<()> {
        self.dispatch_app_input_impl(app, action).await
    }

    async fn settle_after_input(
        &self,
        app: AppSelector,
        policy: openbitfun_core::agentic::tools::computer_use_host::AppInputSettlePolicy,
    ) -> OpenBitFunResult<openbitfun_core::agentic::tools::computer_use_host::AppInputSettle> {
        self.settle_after_input_impl(app, policy).await
    }

    fn capture_scope(&self) -> Option<&'static str> {
        let target = crate::computer_use::control_session::snapshot().target?;
        if target.starts_with("pid:") && target.contains("/window:") {
            Some("window")
        } else if target.starts_with("portal:") {
            Some("authorized_portal_stream")
        } else {
            None
        }
    }

    fn validate_observation(&self, id: &str) -> OpenBitFunResult<()> {
        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        let pid = scope
            .target
            .as_deref()
            .and_then(|target| {
                target
                    .strip_prefix("pid:")
                    .or_else(|| target.strip_prefix("atspi:"))
            })
            .and_then(|target| target.split('/').next())
            .and_then(|pid| pid.parse::<i32>().ok())
            .ok_or_else(|| {
                OpenBitFunError::tool(
                    "[OBSERVATION_TARGET_REQUIRED] Prepare the observed application before input",
                )
            })?;
        self.state_for_scope(&scope)?
            .observations
            .validate_application(pid, id)
            .map_err(OpenBitFunError::tool)
    }

    async fn prepare_control_target(&self, mut app: AppSelector) -> OpenBitFunResult<()> {
        app.validate_window_target()
            .map_err(OpenBitFunError::tool)?;
        if app.is_empty() {
            if let Some(pid) = crate::computer_use::control_session::snapshot()
                .target
                .as_deref()
                .and_then(|t| t.strip_prefix("pid:"))
                .and_then(|t| t.split('/').next())
                .and_then(|p| p.parse::<i32>().ok())
            {
                app = AppSelector::by_pid(pid);
            }
        }
        // A same-owner mode transition keeps its exact window identity even
        // though native capture resources and observation IDs are renewed.
        if app.window_id.is_none() {
            if let Some(target) = crate::computer_use::control_session::snapshot().target {
                if let Some((pid, window)) = foreground::parse_native_target(&target) {
                    if app.pid == Some(pid) {
                        app.window_id = Some(window);
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            let pid = resolve_pid_macos(self, &app).await?;
            let requested_window = app.window_id.or_else(|| {
                crate::computer_use::control_session::snapshot()
                    .target
                    .as_deref()
                    .and_then(foreground::parse_native_target)
                    .filter(|(bound_pid, _)| *bound_pid == pid)
                    .map(|(_, window)| window)
            });
            let window_id = requested_window
                .map(u32::try_from)
                .transpose()
                .map_err(|_| {
                    OpenBitFunError::tool(
                        "[INVALID_PARAMS] window_id exceeds the macOS window ID range",
                    )
                })?;
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::macos_capture::ensure_capture(pid, window_id)
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?
            .map_err(OpenBitFunError::tool)?;
        }
        #[cfg(target_os = "windows")]
        {
            let (pid, window) = self.windows_target(&app).await?;
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::control_session::bind_target(format!(
                    "pid:{pid}/window:{window}"
                ))
                .map_err(OpenBitFunError::tool)?;
                crate::computer_use::windows_wgc_capture::ensure_window_capture(
                    windows::Win32::Foundation::HWND(window as *mut _),
                )
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        }
        #[cfg(target_os = "linux")]
        {
            if app.window_id.is_some() {
                return Err(OpenBitFunError::tool("[WINDOW_TARGET_UNSUPPORTED] This host uses AT-SPI app selectors and portal-selected capture, not native window IDs"));
            }
            if !app.is_empty() {
                crate::computer_use::linux_control_ax::bind_app_selector(&app).await?;
            }
        }
        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        drop(self.state_for_scope(&scope)?);
        Ok(())
    }

    async fn activate_app(&self, _app: AppSelector) -> OpenBitFunResult<()> {
        crate::computer_use::control_session::spawn_blocking(Self::activate_prepared_window)
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?
    }

    async fn start_control(
        &self,
        owner: &str,
        request: openbitfun_core::agentic::tools::computer_use_host::ControlStartRequest,
    ) -> OpenBitFunResult<openbitfun_core::agentic::tools::computer_use_host::ControlSnapshot> {
        let snapshot = crate::computer_use::control_session::start(owner, request.mode)
            .map_err(OpenBitFunError::tool)?;
        let scope =
            openbitfun_agent_tools::computer_use_control::ObservationScope::from_control(&snapshot);
        drop(self.state_for_scope(&scope)?);
        // Background AT-SPI actions need no portal or window picker. The
        // compositor's consent is required only for a portal capture/seat session.
        #[cfg(target_os = "linux")]
        if request.mode != openbitfun_agent_tools::computer_use_control::ControlMode::Background {
            if let Err(error) = crate::computer_use::linux_control::start_session(
                request.mode
                    == openbitfun_agent_tools::computer_use_control::ControlMode::Foreground,
            )
            .await
            {
                let _ = crate::computer_use::control_session::stop_checked(
                    Some(owner),
                    Some(snapshot.generation),
                    &error,
                );
                return Err(OpenBitFunError::tool(error));
            }
        }
        Ok(crate::computer_use::control_session::snapshot())
    }

    fn control_snapshot(
        &self,
    ) -> openbitfun_core::agentic::tools::computer_use_host::ControlSnapshot {
        crate::computer_use::control_session::snapshot()
    }
    async fn stop_control(
        &self,
        owner: &str,
    ) -> OpenBitFunResult<openbitfun_core::agentic::tools::computer_use_host::ControlSnapshot> {
        crate::computer_use::control_session::stop(Some(owner), "agent_stopped")
            .map_err(OpenBitFunError::tool)
    }
    async fn stop_control_generation(
        &self,
        owner: &str,
        generation: u64,
    ) -> OpenBitFunResult<openbitfun_core::agentic::tools::computer_use_host::ControlSnapshot> {
        crate::computer_use::control_session::stop_checked(
            Some(owner),
            Some(generation),
            "task_cancelled",
        )
        .map_err(OpenBitFunError::tool)
    }
    async fn acquire_control_action(
        &self,
        owner: &str,
        action: &str,
    ) -> OpenBitFunResult<
        Option<Box<dyn openbitfun_core::agentic::tools::computer_use_host::ComputerUseActionLease>>,
    > {
        let policy =
            openbitfun_agent_tools::computer_use_control::ControlActionPolicy::for_action(action)
                .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "[CONTROL_ACTION_INVALID] Unknown ComputerUse action: {action}"
                ))
            })?;
        if !policy.lease {
            return Ok(None);
        }
        crate::computer_use::control_session::acquire(owner, action)
            .map(Some)
            .map_err(OpenBitFunError::tool)
    }

    async fn permission_snapshot(&self) -> OpenBitFunResult<ComputerUsePermissionSnapshot> {
        use openbitfun_agent_tools::computer_use_permissions::ComputerPermissionKind as Kind;
        let status = crate::computer_use::permissions::status().await;
        Ok(ComputerUsePermissionSnapshot {
            accessibility_granted: status.usable(Kind::Accessibility),
            screen_capture_granted: status.usable(Kind::ScreenRecording),
            platform_note: Some(
                status
                    .permissions
                    .iter()
                    .map(|permission| permission.detail.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
        })
    }

    fn computer_use_interaction_state(&self) -> ComputerUseInteractionState {
        let (has_capture, click_needs_fresh, pending_verify, last_mutation, preferred_display_id) = {
            let s = self.state.lock().unwrap();
            (
                s.observations.latest_image().is_some(),
                s.click_needs_fresh_screenshot,
                s.pending_verify_screenshot,
                s.last_mutation_kind.clone(),
                s.preferred_display_id,
            )
        };

        let (mouse_x, mouse_y) = Self::current_mouse_position();
        let displays = Self::enumerate_displays(preferred_display_id, mouse_x, mouse_y);
        let active_display_id = preferred_display_id.or_else(|| {
            displays
                .iter()
                .find(|d| d.has_pointer)
                .map(|d| d.display_id)
                .or_else(|| displays.iter().find(|d| d.is_primary).map(|d| d.display_id))
        });

        let click_ready = has_capture && !click_needs_fresh;
        let recommended_next_action =
            (!has_capture || click_needs_fresh || pending_verify).then(|| "screenshot".to_string());

        // `interaction_state` rides on *every* ComputerUse result, and the
        // display list is the bulk of it. On a single-screen machine it is pure
        // repetition: `active_display_id` already names the only screen, and
        // there is nothing to disambiguate. It earns its bytes only when the
        // model actually has to choose, so send it only then — `list_displays`
        // and `describe_screen` still report the full list on demand.
        let displays = if displays.len() > 1 {
            displays
        } else {
            Vec::new()
        };

        ComputerUseInteractionState {
            click_ready,
            enter_ready: !click_needs_fresh,
            requires_fresh_screenshot_before_click: click_needs_fresh,
            requires_fresh_screenshot_before_enter: click_needs_fresh,
            recommend_screenshot_to_verify_last_action: pending_verify,
            // Native capture_scope carries window/portal identity; the old enum cannot.
            last_screenshot_kind: None,
            last_mutation,
            recommended_next_action,
            displays,
            active_display_id,
        }
    }

    async fn request_accessibility_permission(&self) -> OpenBitFunResult<()> {
        #[cfg(target_os = "macos")]
        {
            crate::computer_use::control_session::spawn_blocking(macos::request_ax_prompt)
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
        }
        Ok(())
    }

    async fn request_screen_capture_permission(&self) -> OpenBitFunResult<()> {
        #[cfg(target_os = "macos")]
        {
            crate::computer_use::control_session::spawn_blocking(|| {
                let _ = macos::request_screen_capture();
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
        }
        Ok(())
    }

    async fn screenshot_display(
        &self,
        params: ComputerUseScreenshotParams,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        self.screenshot_display_impl(params).await
    }

    async fn screenshot_peek_full_display(&self) -> OpenBitFunResult<ComputerScreenshot> {
        self.screenshot_peek_full_display_impl().await
    }

    async fn read_screen_text(
        &self,
    ) -> OpenBitFunResult<Vec<openbitfun_core::agentic::tools::computer_use_host::OcrTextMatch>>
    {
        self.read_screen_text_impl().await
    }

    async fn ocr_find_text_matches(
        &self,
        text_query: &str,
        region_native: Option<openbitfun_core::agentic::tools::computer_use_host::OcrRegionNative>,
    ) -> OpenBitFunResult<Vec<openbitfun_core::agentic::tools::computer_use_host::OcrTextMatch>>
    {
        self.ocr_find_text_matches_impl(text_query, region_native)
            .await
    }

    async fn accessibility_hit_at_global_point(
        &self,
        gx: f64,
        gy: f64,
    ) -> OpenBitFunResult<
        Option<openbitfun_core::agentic::tools::computer_use_host::OcrAccessibilityHit>,
    > {
        #[cfg(target_os = "macos")]
        {
            let pid = resolve_pid_macos(self, &AppSelector::default()).await?;
            let hit = crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::macos_ax_ui::accessibility_hit_at_global_point_for_pid(
                    pid, gx, gy,
                )
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
            return Ok(hit);
        }
        #[cfg(target_os = "windows")]
        {
            let (pid, hwnd) = self.windows_target(&AppSelector::default()).await?;
            return crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::windows_ax_ui::accessibility_hit_at_global_point_for_window(
                    hwnd, pid as u32, gx, gy,
                )
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
        }
        #[cfg(target_os = "linux")]
        {
            let _ = (gx, gy);
            Ok(None)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (gx, gy);
            Ok(None)
        }
    }

    async fn ocr_preview_crop_jpeg(
        &self,
        gx: f64,
        gy: f64,
        half_extent_native: u32,
    ) -> OpenBitFunResult<Vec<u8>> {
        self.ocr_preview_crop_jpeg_impl(gx, gy, half_extent_native)
            .await
    }

    fn last_screenshot_refinement(&self) -> Option<ComputerUseScreenshotRefinement> {
        None
    }

    async fn locate_ui_element_screen_center(
        &self,
        query: UiElementLocateQuery,
    ) -> OpenBitFunResult<UiElementLocateResult> {
        #[cfg(target_os = "macos")]
        {
            macos::require_ax_trust_for(
                "Observe an accessible application before locating its controls.",
            )?;
            let pid = resolve_pid_macos(self, &AppSelector::default()).await?;
            return crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::macos_ax_ui::locate_ui_element_center_for_pid(pid, &query)
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
        }
        #[cfg(target_os = "windows")]
        {
            let (pid, hwnd) = self.windows_target(&AppSelector::default()).await?;
            return crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::windows_ax_ui::locate_ui_element_center_for_window(
                    hwnd, pid as u32, &query,
                )
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?;
        }
        #[cfg(target_os = "linux")]
        {
            return crate::computer_use::linux_ax_ui::locate_ui_element_center(query).await;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Err(OpenBitFunError::tool(
                "Native UI element (accessibility) lookup is not available on this platform."
                    .to_string(),
            ))
        }
    }

    async fn enumerate_ui_tree_text(&self) -> Option<String> {
        #[cfg(target_os = "macos")]
        {
            const UI_TREE_MAX_ELEMENTS: usize = 50;
            let pid = resolve_pid_macos(self, &AppSelector::default())
                .await
                .ok()?;
            crate::computer_use::control_session::spawn_blocking(move || {
                // AX tree traversal can throw `NSException` from a misbehaving
                // frontmost app; the @try/@catch wrapper turns that into a
                // missing UI-tree text rather than crashing the whole process.
                macos::catch_objc(|| {
                    Ok(
                        crate::computer_use::macos_ax_ui::enumerate_ui_tree_text_for_pid(
                            pid,
                            UI_TREE_MAX_ELEMENTS,
                        ),
                    )
                })
                .unwrap_or_else(|e| {
                    debug!("UI-tree enumeration suppressed by ObjC catch: {}", e);
                    None
                })
            })
            .await
            .unwrap_or(None)
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    async fn open_app(
        &self,
        app_name: &str,
    ) -> OpenBitFunResult<openbitfun_core::agentic::tools::computer_use_host::OpenAppResult> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        use openbitfun_core::agentic::tools::computer_use_host::OpenAppResult;
        let name = app_name.to_string();
        crate::computer_use::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
        let background = crate::computer_use::control_session::snapshot().mode
            == openbitfun_agent_tools::computer_use_control::ControlMode::Background;

        #[cfg(target_os = "macos")]
        {
            let result = crate::computer_use::control_session::spawn_blocking(
                move || -> OpenBitFunResult<OpenAppResult> {
                    Self::open_app_macos(name, background)
                },
            )
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            return Ok(result);
        }

        #[cfg(target_os = "windows")]
        {
            let result = crate::computer_use::control_session::spawn_blocking(
                move || -> OpenBitFunResult<OpenAppResult> {
                    windows_launch::open(name, background)
                },
            )
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            return Ok(result);
        }

        #[cfg(target_os = "linux")]
        {
            if background {
                return Err(OpenBitFunError::tool("[BACKGROUND_LAUNCH_UNSUPPORTED] This Linux host cannot request application launch without compositor activation. Already-running applications remain available through list_apps and AT-SPI."));
            }
            return linux_launch::open(&name).await;
        }

        #[allow(unreachable_code)]
        Err(OpenBitFunError::tool(
            "open_app is not supported on this platform.".to_string(),
        ))
    }

    fn map_image_coords_to_pointer_f64(&self, x: i32, y: i32) -> OpenBitFunResult<(f64, f64)> {
        self.map_image_coords_to_pointer_f64_impl(x, y)
    }

    fn map_image_coords_to_pointer(&self, x: i32, y: i32) -> OpenBitFunResult<(i32, i32)> {
        let (gx, gy) = self.map_image_coords_to_pointer_f64(x, y)?;
        Ok((gx.round() as i32, gy.round() as i32))
    }

    fn map_normalized_coords_to_pointer_f64(&self, x: i32, y: i32) -> OpenBitFunResult<(f64, f64)> {
        self.map_normalized_coords_to_pointer_f64_impl(x, y)
    }

    fn map_normalized_coords_to_pointer(&self, x: i32, y: i32) -> OpenBitFunResult<(i32, i32)> {
        let (gx, gy) = self.map_normalized_coords_to_pointer_f64(x, y)?;
        Ok((gx.round() as i32, gy.round() as i32))
    }

    async fn mouse_move_global_f64(&self, gx: f64, gy: f64) -> OpenBitFunResult<()> {
        self.mouse_move_global_f64_impl(gx, gy).await
    }

    async fn mouse_move(&self, x: i32, y: i32) -> OpenBitFunResult<()> {
        self.mouse_move_global_f64(x as f64, y as f64).await
    }

    async fn pointer_move_relative(&self, dx: i32, dy: i32) -> OpenBitFunResult<()> {
        self.pointer_move_relative_impl(dx, dy).await
    }

    async fn mouse_click(&self, button: &str) -> OpenBitFunResult<()> {
        self.mouse_click_impl(button).await
    }

    async fn mouse_click_authoritative(&self, button: &str) -> OpenBitFunResult<()> {
        self.mouse_click_authoritative_impl(button).await
    }

    async fn mouse_down(&self, button: &str) -> OpenBitFunResult<()> {
        self.mouse_down_impl(button).await
    }

    async fn mouse_up(&self, button: &str) -> OpenBitFunResult<()> {
        self.mouse_up_impl(button).await
    }

    /// Press-drag-release gesture. The desktop host performs a **background**
    /// (non-disruptive) drag where supported: macOS posts `bg_drag` to the
    /// frontmost app's pid, Windows posts `post_drag_screen` to the foreground
    /// window. When the background path is unavailable it falls back to the
    /// foreground composite gesture (visible cursor movement).
    async fn drag(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        button: &str,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        self.drag_impl(from, to, button, duration_ms).await
    }

    async fn scroll(&self, delta_x: i32, delta_y: i32) -> OpenBitFunResult<()> {
        self.scroll_impl(delta_x, delta_y).await
    }

    async fn key_chord(&self, keys: Vec<String>) -> OpenBitFunResult<()> {
        self.key_chord_impl(keys).await
    }

    async fn type_text(&self, text: &str) -> OpenBitFunResult<()> {
        self.type_text_impl(text).await
    }

    async fn wait_ms(&self, ms: u64) -> OpenBitFunResult<()> {
        crate::computer_use::control_session::wait(ms)
            .await
            .map_err(OpenBitFunError::tool)?;
        ComputerUseHost::computer_use_record_mutation(self, ComputerUseLastMutationKind::Wait);
        Ok(())
    }

    async fn computer_use_session_snapshot(&self) -> ComputerUseSessionSnapshot {
        crate::computer_use::control_session::spawn_blocking(Self::collect_session_snapshot_sync)
            .await
            .unwrap_or_else(|_| ComputerUseSessionSnapshot::default())
    }

    fn computer_use_after_screenshot(&self) {
        // Transition is handled centrally in screenshot_display via transition_after_screenshot.
    }

    fn computer_use_after_pointer_mutation(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.transition_after_pointer_mutation();
            // Default attribution: bare pointer mutations are pointer moves.
            // Specific mutation kinds (Scroll, KeyChord, TypeText, Drag) are
            // re-recorded by their own `computer_use_record_mutation` call
            // so the most recent kind wins.
            s.record_mutation(ComputerUseLastMutationKind::PointerMove);
        }
    }

    fn computer_use_record_mutation(&self, kind: ComputerUseLastMutationKind) {
        if let Ok(mut s) = self.state.lock() {
            s.record_mutation(kind);
        }
    }

    fn computer_use_after_click(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.transition_after_click();
        }
    }

    fn computer_use_after_committed_ui_action(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.transition_after_committed_ui_action();
        }
    }

    fn computer_use_trust_pointer_after_ocr_move(&self) {
        if let Ok(mut s) = self.state.lock() {
            // `mouse_move` already set click_needs; OCR globals are authoritative like AX.
            s.click_needs_fresh_screenshot = false;
        }
    }

    fn computer_use_trust_pointer_after_text_input(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.click_needs_fresh_screenshot = false;
        }
    }

    fn computer_use_waive_fresh_capture_guard(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.click_needs_fresh_screenshot = false;
            s.pending_verify_screenshot = false;
        }
    }

    fn computer_use_guard_click_allowed(&self) -> OpenBitFunResult<()> {
        let s = self
            .state
            .lock()
            .map_err(|e| OpenBitFunError::tool(format!("lock: {}", e)))?;
        if s.click_needs_fresh_screenshot {
            return Err(OpenBitFunError::tool(
                STALE_CAPTURE_TOOL_MESSAGE.to_string(),
            ));
        }
        Ok(())
    }

    fn computer_use_guard_click_allowed_relaxed(&self) -> OpenBitFunResult<()> {
        // For AX-based click_element: we only require that no pointer mutation
        // happened since the last known state (i.e. we moved the pointer ourselves
        // inside click_element, so the flag is not set). No fine-screenshot needed.
        // This is intentionally permissive — AX coordinates are authoritative.
        Ok(())
    }

    fn record_action(&self, action_type: &str, action_params: &str, success: bool) {
        if let Ok(mut s) = self.state.lock() {
            s.optimizer
                .record_action(action_type.to_string(), action_params.to_string(), success);
        }
    }

    fn update_screenshot_hash(&self, hash: u64) {
        if let Ok(mut s) = self.state.lock() {
            s.optimizer.update_screenshot_hash(hash);
        }
    }

    fn detect_action_loop(&self) -> LoopDetectionResult {
        if let Ok(s) = self.state.lock() {
            s.optimizer.detect_loop()
        } else {
            LoopDetectionResult {
                is_loop: false,
                pattern_length: 0,
                repetitions: 0,
                suggestion: String::new(),
            }
        }
    }

    fn get_action_history(&self) -> Vec<ActionRecord> {
        if let Ok(s) = self.state.lock() {
            s.optimizer.get_history()
        } else {
            vec![]
        }
    }

    async fn list_displays(&self) -> OpenBitFunResult<Vec<ComputerUseDisplayInfo>> {
        let preferred = self.state.lock().ok().and_then(|s| s.preferred_display_id);
        let (mx, my) = Self::current_mouse_position();
        Ok(Self::enumerate_displays(preferred, mx, my))
    }

    async fn focus_display(&self, display_id: Option<u32>) -> OpenBitFunResult<()> {
        if let Some(id) = display_id {
            // Validate against the actual list of attached screens; rejecting
            // unknown ids early gives the model a clean error to recover from
            // (rather than silently capturing the wrong display later).
            let known = Screen::all()
                .map(|all| all.iter().any(|s| s.display_info.id == id))
                .unwrap_or(false);
            if !known {
                return Err(OpenBitFunError::tool(format!(
                    "focus_display: unknown display_id {} (call desktop.list_displays first)",
                    id
                )));
            }
        }
        if let Ok(mut s) = self.state.lock() {
            s.preferred_display_id = display_id;
            // Pinning a new display invalidates any cached screenshot taken
            // from the old one — drop it so the next screenshot path picks
            // a fresh frame from the chosen screen.
            if display_id.is_some() {
                s.click_needs_fresh_screenshot = true;
            }
        }
        Ok(())
    }

    fn focused_display_id(&self) -> Option<u32> {
        self.state.lock().ok().and_then(|s| s.preferred_display_id)
    }

    // ── Codex-style AX-first desktop automation ─────────────────────────
    //
    // These override the trait defaults (which return "not available")
    // with real macOS implementations on macOS, and keep the defaults on
    // other platforms via cfg-gating.

    fn supports_background_input(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            crate::computer_use::macos_bg_input::supports_background_input()
        }
        #[cfg(target_os = "windows")]
        {
            // Semantic UIA and targeted window messages; SendInput remains foreground-only.
            true
        }
        #[cfg(target_os = "linux")]
        {
            true // AT-SPI semantic input; arbitrary background coordinates remain unsupported.
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            false
        }
    }

    fn supports_ax_tree(&self) -> bool {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            true
        }
        #[cfg(target_os = "windows")]
        {
            // Windows uses UI Automation (UIA) for the AX tree.
            true
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            false
        }
    }

    async fn list_windows(&self, app: Option<AppSelector>) -> OpenBitFunResult<Vec<AppWindowInfo>> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let filter = if let Some(app) = app.filter(|app| !app.is_empty()) {
                app.validate_window_target()
                    .map_err(OpenBitFunError::tool)?;
                Some((resolve_pid(self, &app).await?, app.window_id))
            } else {
                None
            };
            let windows = tokio::task::spawn_blocking(|| {
                #[cfg(target_os = "macos")]
                {
                    crate::computer_use::macos_list_apps::list_windows()
                }
                #[cfg(target_os = "windows")]
                {
                    Ok::<_, OpenBitFunError>(crate::computer_use::windows_list_apps::list_windows())
                }
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            Ok(windows
                .into_iter()
                .filter(|window| {
                    filter.is_none_or(|(pid, id)| {
                        window.pid == pid && id.is_none_or(|id| window.window_id == id)
                    })
                })
                .collect())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = app;
            Err(OpenBitFunError::tool("[WINDOW_DISCOVERY_UNSUPPORTED] This host exposes AT-SPI applications and portal-selected surfaces; use list_apps and get_app_state"))
        }
    }

    async fn list_apps(&self, include_hidden: bool) -> OpenBitFunResult<Vec<AppInfo>> {
        #[cfg(target_os = "macos")]
        {
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::macos_list_apps::list_running_apps(include_hidden)
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?
        }
        #[cfg(target_os = "windows")]
        {
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::windows_list_apps::list_running_apps(include_hidden)
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?
        }
        #[cfg(target_os = "linux")]
        {
            let _ = include_hidden;
            crate::computer_use::linux_control_ax::list_apps().await
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = include_hidden;
            Err(OpenBitFunError::tool(
                "[CONTROL_UNSUPPORTED] No application enumeration provider",
            ))
        }
    }

    async fn get_app_state(
        &self,
        app: AppSelector,
        max_depth: u32,
        focus_window_only: bool,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        // Preserve image-bearing observations for existing callers.
        self.get_app_state_inner(app, max_depth, focus_window_only, true)
            .await
    }

    async fn get_app_state_with_options(
        &self,
        app: AppSelector,
        max_depth: u32,
        focus_window_only: bool,
        include_image: bool,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        self.get_app_state_inner(app, max_depth, focus_window_only, include_image)
            .await
    }

    fn supports_app_shortcuts(&self) -> bool {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            true
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            false
        }
    }

    async fn get_app_shortcuts(&self, app: AppSelector) -> OpenBitFunResult<AppShortcutsSnapshot> {
        self.get_app_shortcuts_inner(app).await
    }

    async fn app_wait_for(
        &self,
        app: AppSelector,
        pred: AppWaitPredicate,
        timeout_ms: u32,
        poll_ms: u32,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        self.app_wait_for_impl(app, pred, timeout_ms, poll_ms).await
    }

    fn supports_interactive_view(&self) -> bool {
        cfg!(any(target_os = "macos", target_os = "windows"))
    }

    fn supports_visual_mark_view(&self) -> bool {
        cfg!(any(target_os = "macos", target_os = "windows"))
    }

    async fn build_interactive_view(
        &self,
        app: AppSelector,
        opts: InteractiveViewOpts,
    ) -> OpenBitFunResult<InteractiveView> {
        self.build_interactive_view_impl(app, opts).await
    }

    async fn interactive_click(
        &self,
        app: AppSelector,
        params: InteractiveClickParams,
    ) -> OpenBitFunResult<InteractiveActionResult> {
        self.interactive_click_impl(app, params).await
    }

    async fn build_visual_mark_view(
        &self,
        app: AppSelector,
        opts: VisualMarkViewOpts,
    ) -> OpenBitFunResult<VisualMarkView> {
        self.build_visual_mark_view_impl(app, opts).await
    }

    async fn visual_click(
        &self,
        app: AppSelector,
        params: VisualClickParams,
    ) -> OpenBitFunResult<VisualActionResult> {
        self.visual_click_impl(app, params).await
    }

    async fn interactive_type_text(
        &self,
        app: AppSelector,
        params: InteractiveTypeTextParams,
    ) -> OpenBitFunResult<InteractiveActionResult> {
        self.interactive_type_text_impl(app, params).await
    }

    async fn interactive_scroll(
        &self,
        app: AppSelector,
        params: InteractiveScrollParams,
    ) -> OpenBitFunResult<InteractiveActionResult> {
        self.interactive_scroll_impl(app, params).await
    }
}

/// Linux Computer Use is a **legacy compatibility layer** only: basic
/// Unsupported legacy operations must identify the available Linux providers;
/// semantic AT-SPI input and portal foreground input have separate capabilities.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) const LINUX_LEGACY_AX_UNAVAILABLE: &str = "[CONTROL_CAPABILITY_UNSUPPORTED] This operation has no Linux provider. Linux supports portal capture/foreground input and AT-SPI node activation/EditableText; select an advertised capability.";

#[cfg(target_os = "windows")]
fn app_selector_is_unspecified(app: &AppSelector) -> bool {
    app.is_empty()
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn control_target_pid() -> Option<i32> {
    crate::computer_use::control_session::snapshot()
        .target
        .as_deref()
        .and_then(|t| t.strip_prefix("pid:"))
        .and_then(|t| t.split('/').next())
        .and_then(|pid| pid.parse().ok())
}

/// Resolve an `AppSelector` to a concrete `pid`, cross-platform.
///
/// macOS: `pid > bundle_id > name`. Windows: `pid > name` (exact, then
/// substring); empty selector resolves to the foreground window's pid.
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn resolve_pid(host: &DesktopComputerUseHost, app: &AppSelector) -> OpenBitFunResult<i32> {
    #[cfg(target_os = "macos")]
    {
        resolve_pid_macos(host, app).await
    }
    #[cfg(target_os = "windows")]
    {
        if app_selector_is_unspecified(app) {
            return Ok(
                control_target_pid().unwrap_or_else(DesktopComputerUseHost::windows_foreground_pid)
            );
        }
        if let Some(pid) = app.pid {
            return Ok(pid);
        }
        let apps = host.list_apps(true).await?;
        if let Some(name) = app.name.as_deref() {
            let needle = name.to_lowercase();
            if let Some(p) = apps
                .iter()
                .find(|a| a.name.to_lowercase() == needle)
                .and_then(|a| a.pid)
            {
                return Ok(p);
            }
            let mut candidates: Vec<&AppInfo> = apps
                .iter()
                .filter(|a| a.name.to_lowercase().contains(&needle))
                .collect();
            candidates.sort_by_key(|a| a.name.len());
            if let Some(p) = candidates.first().and_then(|a| a.pid) {
                return Ok(p);
            }
        }
        Err(OpenBitFunError::tool(format!("APP_NOT_FOUND: {:?}", app)))
    }
}

/// Resolve an `AppSelector` to a concrete `pid` on macOS. Resolution
/// precedence (Codex parity): `pid > bundle_id > name`.
#[cfg(target_os = "macos")]
async fn resolve_pid_macos(
    host: &DesktopComputerUseHost,
    app: &AppSelector,
) -> OpenBitFunResult<i32> {
    if let Some(pid) = app.pid {
        return Ok(pid);
    }
    if app.is_empty() {
        return control_target_pid()
            .or_else(crate::computer_use::macos_bg_input::frontmost_pid_macos)
            .ok_or_else(|| {
                OpenBitFunError::tool(
                    "[TARGET_REQUIRED] No current application; select one from list_apps",
                )
            });
    }
    let apps = host.list_apps(true).await?;
    if let Some(bid) = app.bundle_id.as_deref() {
        let needle = bid.to_lowercase();
        if let Some(p) = apps
            .iter()
            .find(|a| {
                a.bundle_id
                    .as_deref()
                    .map(|s| s.to_lowercase() == needle)
                    .unwrap_or(false)
            })
            .and_then(|a| a.pid)
        {
            return Ok(p);
        }
    }
    if let Some(name) = app.name.as_deref() {
        let needle = name.to_lowercase();
        // 1) Exact match against the localized application name (what the
        //    Dock / Spotlight shows, e.g. "OpenBitFun").
        if let Some(p) = apps
            .iter()
            .find(|a| a.name.to_lowercase() == needle)
            .and_then(|a| a.pid)
        {
            return Ok(p);
        }
        // 2) Exact match against the bundle id's last segment (e.g. user
        //    asks for "OpenBitFun" but `list_apps` returned name="openbitfun-desktop"
        //    with bundle_id="ai.openbitfun.desktop"). This keeps us aligned with
        //    Codex, which is robust to "Cursor" vs "com.todesktop....Cursor".
        if let Some(p) = apps
            .iter()
            .find(|a| {
                a.bundle_id
                    .as_deref()
                    .and_then(|b| b.rsplit('.').next())
                    .map(|seg| seg.to_lowercase() == needle)
                    .unwrap_or(false)
            })
            .and_then(|a| a.pid)
        {
            return Ok(p);
        }
        // 3) Substring match on either `name` or `bundle_id` (case-
        //    insensitive). Pick the shortest matching name to avoid
        //    accidentally targeting "Visual Studio Code Helper (GPU)".
        let mut candidates: Vec<&AppInfo> = apps
            .iter()
            .filter(|a| {
                a.name.to_lowercase().contains(&needle)
                    || a.bundle_id
                        .as_deref()
                        .map(|b| b.to_lowercase().contains(&needle))
                        .unwrap_or(false)
            })
            .collect();
        candidates.sort_by_key(|a| a.name.len());
        if let Some(p) = candidates.first().and_then(|a| a.pid) {
            return Ok(p);
        }
    }
    Err(OpenBitFunError::tool(format!("APP_NOT_FOUND: {:?}", app)))
}

/// Best-effort `AppInfo` for `pid`, looked up from `list_apps`. Falls
/// back to a bare pid-only `AppInfo` when the process no longer has a
/// matching entry (e.g. it exited between resolution and this lookup) —
/// `get_app_shortcuts` should never fail just because the display name
/// couldn't be resolved.
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn app_info_for_pid(host: &DesktopComputerUseHost, pid: i32) -> AppInfo {
    host.list_apps(true)
        .await
        .ok()
        .and_then(|apps| apps.into_iter().find(|a| a.pid == Some(pid)))
        .unwrap_or(AppInfo {
            name: String::new(),
            bundle_id: None,
            pid: Some(pid),
            running: true,
            last_used_ms: None,
            launch_count: 0,
        })
}
