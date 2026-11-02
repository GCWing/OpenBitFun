//! Validated desktop window persistence using the legacy window-state JSON shape.
//! This module owns the sample and writer: the old plugin re-sampled on save and
//! wrote its cache on exit even when automatic tracking was disabled.

mod geometry;
#[cfg(test)]
mod tests;

use geometry::{Desktop, Geometry};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

const STATE_FILE: &str = ".window-state.json";

#[derive(Default)]
pub(crate) struct MainWindowState {
    ready: AtomicBool,
    // Drag/resize only updates memory; disk writes stay at lifecycle boundaries.
    // Never hold either lock across native window calls.
    normal: Mutex<Option<Geometry>>,
    writes: Mutex<()>,
}

#[derive(Debug, Clone, Copy)]
struct Snapshot {
    geometry: Geometry,
    maximized: bool,
    minimized: bool,
    fullscreen: bool,
    visible: bool,
}

impl Snapshot {
    fn is_normal(self) -> bool {
        self.visible && !self.maximized && !self.minimized && !self.fullscreen
    }
}

#[derive(Debug)]
struct RestorePlan {
    geometry: Geometry,
    maximized: bool,
    fullscreen: bool,
    repair: bool,
}

fn restore_plan(document: &Value, desktop: &Desktop) -> RestorePlan {
    let entry = &document["main"];
    let maximized = entry["maximized"].as_bool().unwrap_or(false);
    let fullscreen = entry["fullscreen"].as_bool().unwrap_or(false);
    let saved = Geometry::read(entry, maximized);
    let valid = saved.filter(|geometry| desktop.valid(*geometry));
    RestorePlan {
        geometry: valid.unwrap_or_else(|| desktop.default_geometry(saved)),
        maximized,
        fullscreen,
        repair: entry.is_object() && valid.is_none(),
    }
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(STATE_FILE))
        .map_err(|error| error.to_string())
}

fn read_document(path: &Path) -> Result<(Value, Option<Vec<u8>>), String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((json!({}), None)),
        Err(error) => return Err(format!("Failed to read window state: {error}")),
    };
    let document: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid window state JSON; keeping original: {error}"))?;
    if !document.is_object() || document.get("main").is_some_and(|entry| !entry.is_object()) {
        return Err("Unrecognized window state shape; keeping original".into());
    }
    Ok((document, Some(bytes)))
}

fn update_document(document: &mut Value, geometry: Geometry, flags: Option<(bool, bool)>) {
    let entry = document
        .as_object_mut()
        .expect("validated document")
        .entry("main")
        .or_insert_with(|| json!({}));
    geometry.write(entry);
    let entry = entry.as_object_mut().expect("validated main entry");
    // Only fill missing legacy fields. Visibility and decorations remain surface
    // defaults, not startup instructions. Unknown fields/windows survive.
    for (key, value) in [
        ("visible", true),
        ("decorated", true),
        ("maximized", false),
        ("fullscreen", false),
    ] {
        entry.entry(key).or_insert(json!(value));
    }
    if let Some((maximized, fullscreen)) = flags {
        entry.insert("maximized".into(), json!(maximized));
        entry.insert("fullscreen".into(), json!(fullscreen));
    }
}

fn write_document(path: &Path, document: &Value, backup: Option<&[u8]>) -> Result<(), String> {
    let directory = path.parent().ok_or("Window state path has no parent")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    if let Some(original) = backup {
        let backup_path = directory.join(format!(
            ".window-state.invalid-{}.json",
            uuid::Uuid::new_v4()
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup_path)
            .map_err(|error| format!("Failed to preserve invalid window state: {error}"))?;
        file.write_all(original)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        log::warn!(
            "Preserved invalid window geometry before repair: backup={}",
            backup_path.display()
        );
    }
    // persist replaces atomically on Windows and Unix; a failure keeps the old file.
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, document).map_err(|error| error.to_string())?;
    file.flush()
        .and_then(|_| file.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    file.persist(path)
        .map_err(|error| format!("Failed to replace window state: {error}"))?;
    Ok(())
}

pub(crate) fn restore(window: &tauri::WebviewWindow) -> bool {
    match restore_inner(&window.as_ref().window()) {
        Ok(maximized) => maximized,
        Err(error) => {
            // The builder already supplied a safe centered default.
            log::warn!("Failed to restore main window state; using startup defaults: {error}");
            false
        }
    }
}

fn restore_inner(window: &tauri::Window) -> Result<bool, String> {
    let app = window.app_handle();
    let state = app.state::<MainWindowState>();
    let desktop = Desktop::read(window)?;
    let path = state_path(app)?;
    let (document, _) = read_document(&path)?;
    let plan = restore_plan(&document, &desktop);
    if plan.repair {
        log::warn!(
            "Repairing persisted main window geometry: saved_width={} saved_height={} restored={:?}",
            document["main"]["width"],
            document["main"]["height"],
            plan.geometry
        );
    }
    apply_geometry(window, plan.geometry, &desktop)?;
    *state.normal.lock().map_err(|error| error.to_string())? = Some(plan.geometry);
    if plan.repair {
        let _write = state.writes.lock().map_err(|error| error.to_string())?;
        let (mut document, original) = read_document(&path)?;
        update_document(&mut document, plan.geometry, None);
        if let Err(error) = write_document(&path, &document, original.as_deref()) {
            log::warn!(
                "Main window geometry repaired in memory but could not be persisted: {error}"
            );
        }
    }
    window
        .set_fullscreen(plan.fullscreen)
        .map_err(|error| error.to_string())?;
    state.ready.store(true, Ordering::Release);
    // Windows must not maximize a hidden undecorated window. Fullscreen takes
    // precedence for this launch; its saved maximize preference is kept on disk.
    Ok(plan.maximized && !plan.fullscreen)
}

fn apply_geometry(
    window: &tauri::Window,
    geometry: Geometry,
    desktop: &Desktop,
) -> Result<(), String> {
    window
        .set_size(tauri::PhysicalSize::new(geometry.width, geometry.height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))
        .map_err(|error| error.to_string())?;
    let (width, height) = desktop.minimum_size(geometry);
    window
        .set_min_size(Some(tauri::PhysicalSize::new(width, height)))
        .map_err(|error| error.to_string())
}

/// Retain normal bounds before maximize/minimize hides them. The caller excludes
/// toolbar mode; initialization/repair suppresses partial programmatic rectangles.
pub(crate) fn remember_normal(window: &tauri::Window) {
    let state = window.app_handle().state::<MainWindowState>();
    if !state.ready.load(Ordering::Acquire) {
        return;
    }
    let Ok(snapshot) = capture(window) else {
        return;
    };
    if !snapshot.is_normal() {
        return;
    }
    let Ok(desktop) = Desktop::read(window) else {
        return;
    };
    if desktop.valid(snapshot.geometry) {
        if let Ok(mut normal) = state.normal.lock() {
            *normal = Some(snapshot.geometry);
        }
    }
}

pub(crate) fn save(app: &tauri::AppHandle, reason: &str) -> Result<(), String> {
    let window = app.get_window("main").ok_or("Main window not found")?;
    let snapshot = capture(&window)?;
    let desktop = Desktop::read(&window)?;
    let state = app.state::<MainWindowState>();
    let mut normal = state.normal.lock().map_err(|error| error.to_string())?;
    if snapshot.is_normal() {
        if !desktop.valid(snapshot.geometry) {
            return Err(format!(
                "Rejected main window snapshot: reason={reason}, snapshot={snapshot:?}"
            ));
        }
        *normal = Some(snapshot.geometry);
    }
    let geometry = *normal;
    drop(normal);
    // No native calls under the writer lock. Persist exactly the sample validated.
    let path = state_path(app)?;
    let _write = state.writes.lock().map_err(|error| error.to_string())?;
    persist_snapshot(&path, snapshot, geometry, &desktop)
}

fn persist_snapshot(
    path: &Path,
    snapshot: Snapshot,
    normal: Option<Geometry>,
    desktop: &Desktop,
) -> Result<(), String> {
    if snapshot.is_normal() && !desktop.valid(snapshot.geometry) {
        return Err("Rejected invalid normal window geometry".into());
    }
    let (mut document, original) = read_document(path)?;
    let plan = restore_plan(&document, desktop);
    let geometry = if snapshot.is_normal() {
        snapshot.geometry
    } else {
        normal
            .filter(|geometry| desktop.valid(*geometry))
            .unwrap_or(plan.geometry)
    };
    update_document(
        &mut document,
        geometry,
        // Hiding to tray may change the native show command. The close boundary
        // already saved the visible window's preferences; keep those on exit.
        snapshot
            .visible
            .then_some((snapshot.maximized, snapshot.fullscreen)),
    );
    write_document(path, &document, original.as_deref().filter(|_| plan.repair))
}

pub(crate) fn repair_for_activation(window: &tauri::Window) -> Result<(), String> {
    if crate::MAIN_WINDOW_USES_TRANSIENT_GEOMETRY.load(Ordering::SeqCst) {
        return Ok(());
    }
    let snapshot = capture(window)?;
    if snapshot.minimized || snapshot.maximized || snapshot.fullscreen {
        return Ok(());
    }
    let desktop = Desktop::read(window)?;
    if desktop.valid(snapshot.geometry) {
        return Ok(());
    }
    log::warn!("Repairing main window geometry during activation: snapshot={snapshot:?}");
    let state = window.app_handle().state::<MainWindowState>();
    let normal = *state.normal.lock().map_err(|error| error.to_string())?;
    let geometry = normal
        .filter(|geometry| desktop.valid(*geometry))
        .unwrap_or_else(|| desktop.default_geometry(Some(snapshot.geometry)));
    state.ready.store(false, Ordering::Release);
    let result = apply_geometry(window, geometry, &desktop);
    state.ready.store(true, Ordering::Release);
    result?;
    *state.normal.lock().map_err(|error| error.to_string())? = Some(geometry);
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture(window: &tauri::Window) -> Result<Snapshot, String> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowPlacement, GetWindowRect, IsWindowVisible, WINDOWPLACEMENT,
        WINDOWPLACEMENT_FLAGS, WPF_RESTORETOMAXIMIZED,
    };
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = HWND(handle.0);
    let mut before = WINDOWPLACEMENT::default();
    before.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    let mut after = before;
    let mut client = RECT::default();
    let mut outer = RECT::default();
    // SAFETY: hwnd belongs to the live main window and output buffers outlive
    // the calls. Avoid Tao's cached maximized flag and unreliable rcNormalPosition
    // geometry. Refuse a sample spanning a native placement transition.
    unsafe {
        GetWindowPlacement(hwnd, &mut before).map_err(|error| error.to_string())?;
        GetClientRect(hwnd, &mut client).map_err(|error| error.to_string())?;
        GetWindowRect(hwnd, &mut outer).map_err(|error| error.to_string())?;
        GetWindowPlacement(hwnd, &mut after).map_err(|error| error.to_string())?;
    }
    if before.showCmd != after.showCmd
        || before.flags != after.flags
        || before.rcNormalPosition != after.rcNormalPosition
    {
        return Err(
            "Main window placement changed during snapshot; keeping last normal geometry".into(),
        );
    }
    let minimized = matches!(after.showCmd, 2 | 6 | 7 | 11);
    let maximized = after.showCmd == 3
        || (minimized && after.flags & WPF_RESTORETOMAXIMIZED != WINDOWPLACEMENT_FLAGS(0));
    Ok(Snapshot {
        geometry: Geometry {
            width: u32::try_from(i64::from(client.right) - i64::from(client.left))
                .map_err(|_| "Negative window client width")?,
            height: u32::try_from(i64::from(client.bottom) - i64::from(client.top))
                .map_err(|_| "Negative window client height")?,
            x: outer.left,
            y: outer.top,
        },
        maximized,
        minimized,
        fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
        visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
    })
}

#[cfg(not(target_os = "windows"))]
fn capture(window: &tauri::Window) -> Result<Snapshot, String> {
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    Ok(Snapshot {
        geometry: Geometry {
            width: size.width,
            height: size.height,
            x: position.x,
            y: position.y,
        },
        maximized: window.is_maximized().map_err(|error| error.to_string())?,
        minimized: window.is_minimized().map_err(|error| error.to_string())?,
        fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
        visible: window.is_visible().map_err(|error| error.to_string())?,
    })
}
