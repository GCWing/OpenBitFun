//! Tauri commands exposed to the frontend installer UI.

use super::extract::{self, ESTIMATED_INSTALL_SIZE};
use super::generated_locale_contract::INSTALLER_GENERATED_LOCALES;
use super::types::{
    ConnectionTestResult, DiskSpaceInfo, InstallOptions, InstallProgress, ModelConfig,
    RemoteModelInfo,
};
use super::MAIN_APP_EXE;
use openbitfun_core_types::{
    installer_config_handoff::{
        InstallerConfigHandoff, InstallerModelHandoff, INSTALLER_CONFIG_HANDOFF_FILE_NAME,
    },
    product_identity::{data_namespace, hidden_data_directory},
};
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tauri::{Emitter, Manager, Window};

#[cfg(target_os = "windows")]
#[derive(Default)]
struct WindowsInstallState {
    manufacturer_registered: bool,
    uninstall_registered: bool,
    desktop_shortcut_created: bool,
    start_menu_shortcut_created: bool,
}

const MIN_WINDOWS_APP_EXE_BYTES: u64 = 5 * 1024 * 1024;
const PAYLOAD_MANIFEST_FILE: &str = "payload-manifest.json";
const REQUIRED_PAYLOAD_FILES: [&str; 6] = [
    MAIN_APP_EXE,
    "frontend/dist/index.html",
    "mobile-web/dist/index.html",
    "resources/ext-host/extension-host.js",
    "resources/worker_host.js",
    "flashgrep/flashgrep-x86_64-pc-windows-msvc.exe",
];
const INSTALLER_STATE_FILE: &str = "installer-state.json";
const EMBEDDED_PAYLOAD_ZIP: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/embedded_payload.zip"));

#[cfg(target_os = "windows")]
fn create_windows_silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

static INSTALLER_APP_LANGUAGE_ALIASES_BY_PRIORITY: LazyLock<Vec<(&'static str, &'static str)>> =
    LazyLock::new(|| {
        let mut aliases = INSTALLER_GENERATED_LOCALES
            .iter()
            .flat_map(|language| {
                language
                    .aliases
                    .iter()
                    .map(move |alias| (language.code, *alias))
            })
            .collect::<Vec<_>>();
        // Keep script-specific aliases ahead of broad prefixes like `zh`.
        aliases.sort_by_key(|(_, alias)| std::cmp::Reverse(alias.len()));
        aliases
    });

#[derive(Debug, Clone, Deserialize)]
struct PayloadManifest {
    files: Vec<PayloadManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct PayloadManifestFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchContext {
    pub mode: String,
    pub preview_only: bool,
    pub uninstall_path: Option<String>,
    pub app_language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallPathValidation {
    pub install_path: String,
}

/// Matches Tauri NSIS detection via `UNINSTKEY` / `MANUPRODUCTKEY`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExistingInstallationResponse {
    pub detected: bool,
    pub install_location: Option<String>,
    pub display_version: Option<String>,
    pub uninstall_string: Option<String>,
    pub main_binary_present: bool,
    pub source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallerState {
    last_install_path: String,
}

/// Get the default installation path.
#[tauri::command]
pub(crate) fn get_default_install_path() -> String {
    let base = if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::data_local_dir()
                    .unwrap_or_else(|| PathBuf::from(["C:", "Program Files"].join("\\")))
            })
    } else if cfg!(target_os = "macos") {
        dirs::home_dir()
            .map(|h| h.join("Applications"))
            .unwrap_or_else(|| PathBuf::from("/Applications"))
    } else {
        dirs::home_dir()
            .map(|h| h.join(".local/share"))
            .unwrap_or_else(|| PathBuf::from("/opt"))
    };

    base.join("OpenBitFun").to_string_lossy().to_string()
}

/// Last successful install path if still valid, otherwise platform default.
#[tauri::command]
pub(crate) fn get_initial_install_path() -> String {
    #[cfg(target_os = "windows")]
    {
        use super::registry;
        if let Some(data) = registry::read_existing_install_from_uninstall_registry() {
            if let Ok(resolved) = prepare_install_target(Path::new(&data.install_location)) {
                return resolved.to_string_lossy().to_string();
            }
        }
        if let Some(from_reg) = registry::read_tauri_install_location() {
            if let Ok(resolved) = prepare_install_target(Path::new(&from_reg)) {
                return resolved.to_string_lossy().to_string();
            }
        }
    }
    if let Some(saved) = read_last_install_path() {
        if let Ok(resolved) = prepare_install_target(Path::new(&saved)) {
            return resolved.to_string_lossy().to_string();
        }
    }
    get_default_install_path()
}

/// Detect an existing OpenBitFun install (Tauri NSIS or this installer) via Add/Remove Programs registry.
#[tauri::command]
pub(crate) fn get_existing_installation() -> ExistingInstallationResponse {
    #[cfg(not(target_os = "windows"))]
    {
        return ExistingInstallationResponse {
            detected: false,
            install_location: None,
            display_version: None,
            uninstall_string: None,
            main_binary_present: false,
            source: None,
        };
    }
    #[cfg(target_os = "windows")]
    {
        use super::registry;
        if let Some(data) = registry::read_existing_install_from_uninstall_registry() {
            let loc = PathBuf::from(&data.install_location);
            let main_present = loc.join(MAIN_APP_EXE).is_file();
            return ExistingInstallationResponse {
                detected: true,
                install_location: Some(data.install_location),
                display_version: data.display_version,
                uninstall_string: data.uninstall_string,
                main_binary_present: main_present,
                source: Some(format!("uninstall_{}", data.hive)),
            };
        }
        if let Some(loc) = registry::read_tauri_install_location() {
            let pb = PathBuf::from(&loc);
            let main_present = pb.join(MAIN_APP_EXE).is_file();
            return ExistingInstallationResponse {
                detected: true,
                install_location: Some(loc),
                display_version: None,
                uninstall_string: None,
                main_binary_present: main_present,
                source: Some("manufacturer_key".to_string()),
            };
        }
        ExistingInstallationResponse {
            detected: false,
            install_location: None,
            display_version: None,
            uninstall_string: None,
            main_binary_present: false,
            source: None,
        }
    }
}

/// Run the uninstall command stored in Add/Remove Programs (NSIS or custom `uninstall.exe`), like NSIS maintenance.
#[tauri::command]
pub(crate) async fn launch_registered_uninstaller(
    uninstall_command: String,
    install_path: Option<String>,
) -> Result<(), String> {
    let s = uninstall_command.trim();
    if s.is_empty() {
        return Err("Empty uninstall command".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let install_path = install_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        launch_windows_registered_uninstaller(s, install_path.as_deref())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = install_path;
        let _ = s;
        Err("Uninstaller launch is only supported on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn launch_windows_registered_uninstaller(
    uninstall_command: &str,
    install_path: Option<&Path>,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    if let Some(install_path) = install_path {
        let uninstaller_path = install_path.join("uninstall.exe");
        if uninstaller_path.is_file() {
            std::process::Command::new(&uninstaller_path)
                .arg("--uninstall")
                .arg(install_path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| {
                    format!(
                        "Failed to start uninstaller '{}': {}",
                        uninstaller_path.display(),
                        e
                    )
                })?;
            return Ok(());
        }
    }

    let argv = parse_windows_command_line(uninstall_command)?;
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| "Registered uninstall command is empty".to_string())?;
    let program_path = PathBuf::from(program);
    if !program_path.is_file() {
        return Err(format!(
            "Registered uninstaller not found: {}",
            program_path.display()
        ));
    }

    std::process::Command::new(&program_path)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to start registered uninstaller '{}': {}",
                program_path.display(),
                e
            )
        })?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn parse_windows_command_line(command_line: &str) -> Result<Vec<String>, String> {
    use std::ffi::{c_void, OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    #[link(name = "shell32")]
    extern "system" {
        fn CommandLineToArgvW(lp_cmd_line: *const u16, p_num_args: *mut i32) -> *mut *mut u16;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    let wide: Vec<u16> = OsStr::new(command_line)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut argc = 0i32;
    let argv_ptr = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut argc) };
    if argv_ptr.is_null() || argc <= 0 {
        return Err("Failed to parse uninstall command line".to_string());
    }

    let args = unsafe {
        let argv = std::slice::from_raw_parts(argv_ptr, argc as usize);
        let parsed = argv
            .iter()
            .map(|arg_ptr| {
                let mut len = 0usize;
                while *arg_ptr.add(len) != 0 {
                    len += 1;
                }
                OsString::from_wide(std::slice::from_raw_parts(*arg_ptr, len))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        LocalFree(argv_ptr.cast::<c_void>());
        parsed
    };

    Ok(args)
}

/// Get available disk space for the given path.
#[tauri::command]
pub(crate) fn get_disk_space(path: String) -> Result<DiskSpaceInfo, String> {
    let path = PathBuf::from(&path);

    // Walk up to find an existing ancestor directory
    let check_path = find_existing_ancestor(&path);

    // Use std::fs metadata as a basic check. For actual disk space,
    // platform-specific APIs are needed.
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        let fallback_windows_root = format!("{}{}", "C:", std::path::MAIN_SEPARATOR);
        let wide_path: Vec<u16> = OsStr::new(
            check_path
                .to_str()
                .unwrap_or(fallback_windows_root.as_str()),
        )
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

        let mut free_bytes_available: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free_bytes: u64 = 0;

        unsafe {
            let result = windows_sys_get_disk_free_space(
                wide_path.as_ptr(),
                &mut free_bytes_available,
                &mut total_bytes,
                &mut total_free_bytes,
            );
            if result != 0 {
                return Ok(DiskSpaceInfo {
                    total: total_bytes,
                    available: free_bytes_available,
                    required: ESTIMATED_INSTALL_SIZE,
                    sufficient: free_bytes_available >= ESTIMATED_INSTALL_SIZE,
                });
            }
        }
    }

    // Fallback: assume sufficient space
    Ok(DiskSpaceInfo {
        total: 0,
        available: u64::MAX,
        required: ESTIMATED_INSTALL_SIZE,
        sufficient: true,
    })
}

#[cfg(target_os = "windows")]
unsafe fn windows_sys_get_disk_free_space(
    path: *const u16,
    free_bytes_available: *mut u64,
    total_bytes: *mut u64,
    total_free_bytes: *mut u64,
) -> i32 {
    // Link to kernel32.dll GetDiskFreeSpaceExW
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }
    // SAFETY: the caller supplies the same pointers accepted by this wrapper,
    // and the Windows API writes only to the three documented output pointers.
    unsafe { GetDiskFreeSpaceExW(path, free_bytes_available, total_bytes, total_free_bytes) }
}

#[tauri::command]
pub(crate) fn get_launch_context() -> LaunchContext {
    // Resolve preview before helpers that create the application's config directory.
    if crate::preview::is_enabled() {
        return LaunchContext {
            mode: "install".to_string(),
            preview_only: true,
            uninstall_path: None,
            app_language: None,
        };
    }
    let args: Vec<String> = std::env::args().collect();
    let app_language = read_saved_app_language();
    if let Some(idx) = args.iter().position(|arg| arg == "--uninstall") {
        let uninstall_path = args
            .get(idx + 1)
            .map(|p| p.to_string())
            .or_else(guess_uninstall_path_from_exe);
        return LaunchContext {
            mode: "uninstall".to_string(),
            preview_only: false,
            uninstall_path,
            app_language,
        };
    }

    if is_running_as_uninstall_binary() {
        return LaunchContext {
            mode: "uninstall".to_string(),
            preview_only: false,
            uninstall_path: guess_uninstall_path_from_exe(),
            app_language,
        };
    }

    LaunchContext {
        mode: "install".to_string(),
        preview_only: false,
        uninstall_path: None,
        app_language,
    }
}

/// Validate the installation path.
#[tauri::command]
pub(crate) fn validate_install_path(path: String) -> Result<InstallPathValidation, String> {
    let requested_path = PathBuf::from(&path);
    let install_path = prepare_install_target(&requested_path)?;
    Ok(InstallPathValidation {
        install_path: install_path.to_string_lossy().to_string(),
    })
}

/// Main installation command. Emits progress events to the frontend.
#[tauri::command]
pub(crate) async fn start_installation(
    window: Window,
    options: InstallOptions,
) -> Result<(), String> {
    let install_path = prepare_install_target(Path::new(&options.install_path))?;
    let install_dir_was_absent = !install_path.exists();
    #[cfg(target_os = "windows")]
    let mut windows_state = WindowsInstallState::default();

    let result: Result<(), String> = async {
        // Step 1: Create target directory
        emit_progress(&window, "prepare", 5, "Creating installation directory...");
        std::fs::create_dir_all(&install_path)
            .map_err(|e| format!("Failed to create directory: {}", e))?;

        // Step 2: Extract / copy application files
        emit_progress(&window, "extract", 15, "Extracting application files...");

        let mut extracted = false;
        let mut used_debug_placeholder = false;
        let mut installed_manifest: Option<PayloadManifest> = None;
        let mut checked_locations: Vec<String> = Vec::new();

        if embedded_payload_available() {
            checked_locations.push("embedded payload zip".to_string());
            preflight_validate_payload_zip_bytes(EMBEDDED_PAYLOAD_ZIP, "embedded payload zip")?;
            installed_manifest = Some(read_payload_manifest_from_zip_bytes(
                EMBEDDED_PAYLOAD_ZIP,
                "embedded payload zip",
            )?);
            extract::extract_zip_bytes_with_filter(
                EMBEDDED_PAYLOAD_ZIP,
                &install_path,
                should_install_payload_path,
            )
            .map_err(|e| format!("Embedded payload extraction failed: {}", e))?;
            extracted = true;
            log::info!("Extracted payload from embedded installer archive");
        }

        // Fallback to external payload locations for compatibility and local debug.
        let exe_dir = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf();

        if !extracted {
            for candidate in build_payload_candidates(&window, &exe_dir) {
                if candidate.is_zip {
                    checked_locations.push(format!("zip: {}", candidate.path.display()));
                    if !candidate.path.exists() {
                        continue;
                    }
                    preflight_validate_payload_zip_file(&candidate.path, &candidate.label)?;
                    installed_manifest = Some(read_payload_manifest_from_zip_file(
                        &candidate.path,
                        &candidate.label,
                    )?);
                    extract::extract_zip_with_filter(
                        &candidate.path,
                        &install_path,
                        should_install_payload_path,
                    )
                    .map_err(|e| format!("Extraction failed from {}: {}", candidate.label, e))?;
                    extracted = true;
                    log::info!("Extracted payload from {}", candidate.label);
                    break;
                }

                checked_locations.push(format!("dir: {}", candidate.path.display()));
                if !candidate.path.exists() {
                    continue;
                }
                preflight_validate_payload_dir(&candidate.path, &candidate.label)?;
                installed_manifest = Some(read_payload_manifest_from_dir(
                    &candidate.path,
                    &candidate.label,
                )?);
                extract::copy_directory_with_filter(
                    &candidate.path,
                    &install_path,
                    should_install_payload_path,
                )
                .map_err(|e| format!("File copy failed from {}: {}", candidate.label, e))?;
                extracted = true;
                log::info!("Copied payload from {}", candidate.label);
                break;
            }
        }

        if !extracted {
            if cfg!(debug_assertions) {
                // Development mode: create a placeholder to simplify local UI iteration.
                log::warn!("No payload found - running in development mode");
                let placeholder = install_path.join(MAIN_APP_EXE);
                if !placeholder.exists() {
                    std::fs::write(&placeholder, "placeholder")
                        .map_err(|e| format!("Failed to write placeholder: {}", e))?;
                }
                used_debug_placeholder = true;
            } else {
                return Err(format!(
                    "Installer payload is missing. Checked: {}",
                    checked_locations.join(" | ")
                ));
            }
        }

        if !used_debug_placeholder {
            let manifest = installed_manifest.as_ref().ok_or_else(|| {
                "Installer payload manifest was not retained after extraction".to_string()
            })?;
            verify_installed_payload(&install_path, manifest)?;
        }

        emit_progress(&window, "extract", 50, "Files extracted successfully");

        // Step 3: Windows-specific operations
        #[cfg(target_os = "windows")]
        {
            use super::registry;
            use super::shortcut;

            let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let uninstaller_path = install_path.join("uninstall.exe");
            std::fs::copy(&current_exe, &uninstaller_path)
                .map_err(|e| format!("Failed to create uninstaller executable: {}", e))?;
            let uninstall_command = format!("\"{}\"", uninstaller_path.display());

            emit_progress(&window, "registry", 60, "Registering application...");
            registry::register_tauri_install_location(&install_path)
                .map_err(|e| format!("Registry error: {}", e))?;
            windows_state.manufacturer_registered = true;
            registry::register_uninstall_entry(
                &install_path,
                env!("CARGO_PKG_VERSION"),
                &uninstall_command,
            )
            .map_err(|e| format!("Registry error: {}", e))?;
            windows_state.uninstall_registered = true;

            // Desktop shortcut
            if options.desktop_shortcut {
                emit_progress(&window, "shortcuts", 70, "Creating desktop shortcut...");
                shortcut::create_desktop_shortcut(&install_path)
                    .map_err(|e| format!("Shortcut error: {}", e))?;
                windows_state.desktop_shortcut_created = true;
            }

            // Start Menu
            if options.start_menu {
                emit_progress(&window, "shortcuts", 75, "Creating Start Menu entry...");
                shortcut::create_start_menu_shortcut(&install_path)
                    .map_err(|e| format!("Start Menu error: {}", e))?;
                windows_state.start_menu_shortcut_created = true;
            }
        }

        // Step 4: Pass startup preferences to the desktop configuration manager,
        // which remains the only writer of the canonical app.json.
        emit_progress(&window, "config", 92, "Applying startup preferences...");
        apply_first_launch_language(&options.app_language)
            .await
            .map_err(|e| format!("Failed to apply startup preferences: {}", e))
    }
    .await;

    if let Err(err) = result {
        #[cfg(target_os = "windows")]
        rollback_installation(&install_path, install_dir_was_absent, &windows_state);
        #[cfg(not(target_os = "windows"))]
        rollback_installation(&install_path, install_dir_was_absent);
        return Err(err);
    }

    persist_last_install_path(&install_path);
    emit_progress(&window, "complete", 100, "Installation complete!");

    Ok(())
}

/// Uninstall OpenBitFun (for the uninstaller companion).
#[tauri::command]
pub(crate) async fn uninstall(install_path: String) -> Result<(), String> {
    let install_path = PathBuf::from(&install_path);
    let uninstall_targets = collect_uninstall_targets(&install_path)?;

    #[cfg(target_os = "windows")]
    {
        use super::registry;
        use super::shortcut;

        let _ = shortcut::remove_desktop_shortcut();
        let _ = shortcut::remove_start_menu_shortcut();
        let _ = registry::remove_context_menu();
        let _ = registry::remove_from_path(&install_path);
        let _ = registry::remove_autostart_run_entry();
        let _ = registry::remove_tauri_install_location();
        let _ = registry::remove_uninstall_entry();
    }

    #[cfg(target_os = "windows")]
    {
        let current_exe = std::env::current_exe().ok();
        let running_uninstall_binary = current_exe
            .as_ref()
            .and_then(|exe| exe.file_stem().map(|s| s.to_string_lossy().to_string()))
            .map(|stem| stem.eq_ignore_ascii_case("uninstall"))
            .unwrap_or(false);

        let current_exe_parent = current_exe
            .as_ref()
            .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));
        let running_from_install_dir = current_exe_parent
            .as_ref()
            .map(|parent| windows_path_eq_case_insensitive(parent, &install_path))
            .unwrap_or(false);

        append_uninstall_runtime_log(&format!(
            "uninstall called: install_path='{}', current_exe='{}', running_uninstall_binary={}, running_from_install_dir={}",
            install_path.display(),
            current_exe
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "<unknown>".to_string()),
            running_uninstall_binary,
            running_from_install_dir
        ));

        let current_exe_path = current_exe.as_deref();
        remove_installed_targets(&install_path, &uninstall_targets, current_exe_path)?;

        if (running_uninstall_binary || running_from_install_dir)
            && current_exe_path
                .map(|exe| {
                    windows_path_eq_case_insensitive(exe, &install_path.join("uninstall.exe"))
                })
                .unwrap_or(false)
        {
            schedule_windows_self_uninstall_cleanup(current_exe_path.unwrap())?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    remove_installed_targets(&install_path, &uninstall_targets, None)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn schedule_windows_self_uninstall_cleanup(uninstall_exe_path: &Path) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let pid = std::process::id();
    let script_path = temp_dir.join(format!("{}-uninstall-{}.cmd", data_namespace(), pid));
    let log_path = temp_dir.join(format!(
        "{}-uninstall-cleanup-{}.log",
        data_namespace(),
        pid
    ));
    let fallback_log_name = format!("{}-uninstall-cleanup.log", data_namespace());

    let script = format!(
        r#"@echo off
setlocal enableextensions
set "TARGET=%~1"
set "LOG=%~2"
set "TARGET_DIR=%~dp1"
if "%TARGET%"=="" exit /b 2
if "%LOG%"=="" set "LOG=%TEMP%\{fallback_log_name}"
echo [%DATE% %TIME%] cleanup start > "%LOG%"
cd /d "%TEMP%"
for /L %%i in (1,1,30) do (
  if not exist "%TARGET%" (
    echo [%DATE% %TIME%] cleanup success on try %%i >> "%LOG%"
    exit /b 0
  )
  del /f /q "%TARGET%" >> "%LOG%" 2>&1
  if not exist "%TARGET%" (
    if not "%TARGET_DIR%"=="" rmdir "%TARGET_DIR%" >> "%LOG%" 2>&1
    echo [%DATE% %TIME%] cleanup success on try %%i >> "%LOG%"
    exit /b 0
  )
  timeout /t 1 /nobreak >nul
)
echo [%DATE% %TIME%] cleanup failed after retries >> "%LOG%"
exit /b 1
"#
    );

    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write cleanup script: {}", e))?;

    append_uninstall_runtime_log(&format!(
        "scheduled cleanup script='{}', target='{}', cleanup_log='{}'",
        script_path.display(),
        uninstall_exe_path.display(),
        log_path.display()
    ));

    let child = create_windows_silent_command("cmd")
        .arg("/C")
        .arg("call")
        .arg(&script_path)
        .arg(uninstall_exe_path)
        .arg(&log_path)
        .current_dir(&temp_dir)
        .spawn()
        .map_err(|e| format!("Failed to schedule uninstall cleanup: {}", e))?;

    append_uninstall_runtime_log(&format!("cleanup process spawned: pid={}", child.id()));

    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_path_eq_case_insensitive(a: &Path, b: &Path) -> bool {
    fn normalize(path: &Path) -> String {
        let mut s = path.to_string_lossy().replace('/', "\\").to_lowercase();
        while s.ends_with('\\') {
            s.pop();
        }
        s
    }
    normalize(a) == normalize(b)
}

#[cfg(target_os = "windows")]
fn append_uninstall_runtime_log(message: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let log_path = std::env::temp_dir().join(format!("{}-uninstall-runtime.log", data_namespace()));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        use std::io::Write;
        let _ = writeln!(file, "[{}] {}", ts, message);
    }
}

/// Launch the installed application.
#[tauri::command]
pub(crate) fn launch_application(install_path: String) -> Result<(), String> {
    let exe = if cfg!(target_os = "windows") {
        PathBuf::from(&install_path).join(MAIN_APP_EXE)
    } else if cfg!(target_os = "macos") {
        PathBuf::from(&install_path).join("OpenBitFun")
    } else {
        PathBuf::from(&install_path).join("openbitfun")
    };

    #[cfg(target_os = "windows")]
    create_windows_silent_command(&exe)
        .current_dir(&install_path)
        .spawn()
        .map_err(|e| format!("Failed to launch OpenBitFun: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    std::process::Command::new(&exe)
        .current_dir(&install_path)
        .spawn()
        .map_err(|e| format!("Failed to launch OpenBitFun: {}", e))?;

    Ok(())
}

/// Retain the old command as an explicit unsupported response for older clients.
#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LaunchLegacyDataMigratorRequest {}

#[tauri::command]
pub(crate) fn launch_legacy_data_migrator(
    request: LaunchLegacyDataMigratorRequest,
) -> Result<bool, String> {
    let _ = request;
    Err("Data Migrator is distributed separately. Download and run OpenBitFun Data Migrator to import legacy data.".to_string())
}

/// Close the installer window.
#[tauri::command]
pub(crate) fn close_installer(window: Window) {
    let _ = window.close();
}

/// Save theme preference for first launch (called after installation).
#[tauri::command]
pub(crate) async fn set_theme_preference(theme_preference: String) -> Result<(), String> {
    let allowed = [
        "system",
        "openbitfun-dark",
        "openbitfun-light",
        "openbitfun-midnight",
        "openbitfun-china-style",
        "openbitfun-china-night",
        "openbitfun-cyber",
        "openbitfun-slate",
        "openbitfun-tokyo-night",
    ];
    if !allowed.contains(&theme_preference.as_str()) {
        return Err("Unsupported theme preference".to_string());
    }

    let handoff_path = installer_config_handoff_path()?;
    apply_theme_preference_at(&handoff_path, &theme_preference).await
}

/// Save default model configuration for first launch (called after installation).
#[tauri::command]
pub(crate) async fn set_model_config(model_config: ModelConfig) -> Result<(), String> {
    apply_first_launch_model(&model_config).await
}

/// Validate model configuration connectivity from installer (same stack as desktop `test_ai_config_connection`).
#[tauri::command]
pub(crate) async fn test_model_config_connection(
    model_config: ModelConfig,
) -> Result<ConnectionTestResult, String> {
    let required_fields = [
        ("baseUrl", model_config.base_url.trim()),
        ("apiKey", model_config.api_key.trim()),
        ("modelName", model_config.model_name.trim()),
    ];
    for (field, value) in required_fields {
        if value.is_empty() {
            return Ok(ConnectionTestResult {
                success: false,
                response_time_ms: 0,
                model_response: None,
                message_code: None,
                error_details: Some(format!("Missing required field: {}", field)),
            });
        }
    }

    let ai_config = super::ai_config::ai_config_from_installer_model(&model_config)
        .map_err(|e| e.to_string())?;
    let model_name = ai_config.name.clone();
    let supports_image_input = super::ai_config::supports_image_input(&model_config);

    let ai_client = openbitfun_ai_adapters::AIClient::new(ai_config);

    match ai_client.test_connection().await {
        Ok(result) => {
            if !result.success {
                log::info!(
                    "Installer AI config connection test: model={}, success={}, response_time={}ms",
                    model_name,
                    result.success,
                    result.response_time_ms
                );
                return Ok(result.into());
            }

            if supports_image_input {
                match ai_client.test_image_input_connection().await {
                    Ok(image_result) => {
                        let response_time_ms =
                            result.response_time_ms + image_result.response_time_ms;

                        if !image_result.success {
                            let merged = ConnectionTestResult {
                                success: false,
                                response_time_ms,
                                model_response: image_result
                                    .model_response
                                    .or(result.model_response),
                                message_code: image_result.message_code.map(Into::into),
                                error_details: image_result.error_details,
                            };
                            log::info!(
                                "Installer AI config connection test: model={}, success={}, response_time={}ms",
                                model_name, merged.success, merged.response_time_ms
                            );
                            return Ok(merged);
                        }

                        let merged = ConnectionTestResult {
                            success: true,
                            response_time_ms,
                            model_response: image_result.model_response.or(result.model_response),
                            message_code: result.message_code.map(Into::into),
                            error_details: result.error_details,
                        };
                        log::info!(
                            "Installer AI config connection test: model={}, success={}, response_time={}ms",
                            model_name, merged.success, merged.response_time_ms
                        );
                        return Ok(merged);
                    }
                    Err(e) => {
                        log::error!(
                            "Installer multimodal image test failed unexpectedly: model={}, error={}",
                            model_name, e
                        );
                        return Err(format!("Connection test failed: {}", e));
                    }
                }
            }

            log::info!(
                "Installer AI config connection test: model={}, success={}, response_time={}ms",
                model_name,
                result.success,
                result.response_time_ms
            );
            Ok(result.into())
        }
        Err(e) => {
            log::error!(
                "Installer AI config connection test failed: model={}, error={}",
                model_name,
                e
            );
            Err(format!("Connection test failed: {}", e))
        }
    }
}

/// List remote models using the same discovery rules as the main app (installer-local HTTP).
#[tauri::command]
pub(crate) async fn list_model_config_models(
    model_config: ModelConfig,
) -> Result<Vec<RemoteModelInfo>, String> {
    if model_config.api_key.trim().is_empty() {
        return Err("API key is required".to_string());
    }
    if model_config.base_url.trim().is_empty() {
        return Err("Base URL is required".to_string());
    }
    let ai_config = super::ai_config::ai_config_from_installer_model(&model_config)
        .map_err(|e| e.to_string())?;
    let ai_client = openbitfun_ai_adapters::AIClient::new(ai_config);
    ai_client
        .list_models()
        .await
        .map(|models| models.into_iter().map(Into::into).collect())
        .map_err(|e| e.to_string())
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn storage_format(model: &ModelConfig) -> String {
    model.format.trim().to_ascii_lowercase()
}

/// Stored `request_url` aligned with settings `resolveRequestUrl` (no openbitfun_core).
fn resolve_stored_request_url(base_url: &str, format: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with('#') {
        return trimmed[..trimmed.len().saturating_sub(1)]
            .trim_end_matches('/')
            .to_string();
    }
    match format {
        "openai" => {
            if trimmed.ends_with("chat/completions") {
                trimmed.to_string()
            } else {
                format!("{}/chat/completions", trimmed)
            }
        }
        "responses" | "response" => {
            if trimmed.ends_with("responses") {
                trimmed.to_string()
            } else {
                format!("{}/responses", trimmed)
            }
        }
        "anthropic" => {
            if trimmed.ends_with("v1/messages") {
                trimmed.to_string()
            } else {
                format!("{}/v1/messages", trimmed)
            }
        }
        "gemini" | "google" => gemini_installer_base_url(trimmed).to_string(),
        _ => trimmed.to_string(),
    }
}

fn gemini_installer_base_url(url: &str) -> &str {
    let mut u = url;
    if let Some(pos) = u.find("/v1beta") {
        u = &u[..pos];
    }
    if let Some(pos) = u.find("/models/") {
        u = &u[..pos];
    }
    u.trim_end_matches('/')
}

fn parse_custom_request_body(raw: &Option<String>) -> Result<Option<Map<String, Value>>, String> {
    let Some(raw_value) = raw else {
        return Ok(None);
    };

    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let parsed: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("customRequestBody is invalid JSON: {}", e))?;
    let obj = parsed.as_object().ok_or_else(|| {
        "customRequestBody must be a JSON object (for example: {\"temperature\": 0.7})".to_string()
    })?;
    Ok(Some(obj.clone()))
}

fn emit_progress(window: &Window, step: &str, percent: u32, message: &str) {
    let progress = InstallProgress {
        step: step.to_string(),
        percent,
        message: message.to_string(),
    };
    let _ = window.emit("install-progress", &progress);
    log::info!("[{}%] {}: {}", percent, step, message);
}

fn guess_uninstall_path_from_exe() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .map(|p| p.to_string_lossy().to_string())
}

fn is_running_as_uninstall_binary() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_stem().map(|s| s.to_string_lossy().to_string()))
        .map(|stem| stem.eq_ignore_ascii_case("uninstall"))
        .unwrap_or(false)
}

fn embedded_payload_available() -> bool {
    option_env!("EMBEDDED_PAYLOAD_AVAILABLE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

#[derive(Debug)]
struct PayloadCandidate {
    label: String,
    path: PathBuf,
    is_zip: bool,
}

fn build_payload_candidates(window: &Window, exe_dir: &Path) -> Vec<PayloadCandidate> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = window.app_handle().path().resource_dir() {
        candidates.push(PayloadCandidate {
            label: "resource_dir/payload.zip".to_string(),
            path: resource_dir.join("payload.zip"),
            is_zip: true,
        });
        candidates.push(PayloadCandidate {
            label: "resource_dir/payload".to_string(),
            path: resource_dir.join("payload"),
            is_zip: false,
        });
        // Some bundle layouts keep runtime resources under a nested resources directory.
        candidates.push(PayloadCandidate {
            label: "resource_dir/resources/payload.zip".to_string(),
            path: resource_dir.join("resources").join("payload.zip"),
            is_zip: true,
        });
        candidates.push(PayloadCandidate {
            label: "resource_dir/resources/payload".to_string(),
            path: resource_dir.join("resources").join("payload"),
            is_zip: false,
        });
    }

    candidates.push(PayloadCandidate {
        label: "exe_dir/payload.zip".to_string(),
        path: exe_dir.join("payload.zip"),
        is_zip: true,
    });
    candidates.push(PayloadCandidate {
        label: "exe_dir/payload".to_string(),
        path: exe_dir.join("payload"),
        is_zip: false,
    });
    candidates.push(PayloadCandidate {
        label: "exe_dir/resources/payload.zip".to_string(),
        path: exe_dir.join("resources").join("payload.zip"),
        is_zip: true,
    });
    candidates.push(PayloadCandidate {
        label: "exe_dir/resources/payload".to_string(),
        path: exe_dir.join("resources").join("payload"),
        is_zip: false,
    });

    candidates
}

fn find_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    current
}

/// Actual install root is always under an `OpenBitFun` directory: `{user choice}/OpenBitFun`.
/// If the user already chose a path whose last segment is `OpenBitFun`, do not append again.
fn with_openbitfun_install_subdir(path: PathBuf) -> PathBuf {
    let already_openbitfun = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.eq_ignore_ascii_case("OpenBitFun"))
        .unwrap_or(false);
    if already_openbitfun {
        path
    } else {
        path.join("OpenBitFun")
    }
}

/// Stable codes for `validate_install_path` / `prepare_install_target`; localized in the frontend.
const INSTALL_PATH_ERR_PREFIX: &str = "INSTALL_PATH::";

fn prepare_install_target(requested_path: &Path) -> Result<PathBuf, String> {
    if !requested_path.is_absolute() {
        return Err(format!("{}not_absolute", INSTALL_PATH_ERR_PREFIX));
    }

    if requested_path.parent().is_none() {
        return Err(format!("{}filesystem_root", INSTALL_PATH_ERR_PREFIX));
    }

    if requested_path.exists() && !requested_path.is_dir() {
        return Err(format!("{}path_not_directory", INSTALL_PATH_ERR_PREFIX));
    }

    let install_path = with_openbitfun_install_subdir(requested_path.to_path_buf());

    if install_path.exists() {
        if !install_path.is_dir() {
            return Err(format!("{}path_not_directory", INSTALL_PATH_ERR_PREFIX));
        }
        if directory_has_entries(&install_path)? && !install_path.join(MAIN_APP_EXE).exists() {
            return Err(format!(
                "{}directory_must_be_empty_or_openbitfun",
                INSTALL_PATH_ERR_PREFIX
            ));
        }
    }

    let writable_dir = if install_path.exists() {
        install_path.clone()
    } else {
        find_existing_ancestor(&install_path)
    };
    let test_file = writable_dir.join(format!("{}_install_test", hidden_data_directory()));
    match std::fs::write(&test_file, "test") {
        Ok(_) => {
            let _ = std::fs::remove_file(&test_file);
            Ok(install_path)
        }
        Err(_) if install_path.exists() => {
            Err(format!("{}directory_not_writable", INSTALL_PATH_ERR_PREFIX))
        }
        Err(_) => Err(format!("{}parent_not_writable", INSTALL_PATH_ERR_PREFIX)),
    }
}

fn directory_has_entries(path: &Path) -> Result<bool, String> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|_| format!("{}inspect_directory_failed", INSTALL_PATH_ERR_PREFIX))?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|_| format!("{}inspect_directory_failed", INSTALL_PATH_ERR_PREFIX))?
        .is_some())
}

fn ensure_config_directory() -> Result<PathBuf, String> {
    let config_root = dirs::config_dir()
        .ok_or_else(|| "Failed to get user config directory".to_string())?
        .join(data_namespace())
        .join("config");
    std::fs::create_dir_all(&config_root)
        .map_err(|e| format!("Failed to create OpenBitFun config directory: {}", e))?;
    Ok(config_root)
}

fn installer_config_handoff_path() -> Result<PathBuf, String> {
    Ok(ensure_config_directory()?.join(INSTALLER_CONFIG_HANDOFF_FILE_NAME))
}

fn installer_state_path() -> Result<PathBuf, String> {
    Ok(ensure_config_directory()?.join(INSTALLER_STATE_FILE))
}

fn read_last_install_path() -> Option<String> {
    let state_path = installer_state_path().ok()?;
    if !state_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&state_path).ok()?;
    let state: InstallerState = serde_json::from_str(&content).ok()?;
    let trimmed = state.last_install_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn persist_last_install_path(install_path: &Path) {
    let Ok(state_path) = installer_state_path() else {
        log::warn!("Could not resolve installer state path");
        return;
    };
    let state = InstallerState {
        last_install_path: install_path.to_string_lossy().to_string(),
    };
    let body = match serde_json::to_string_pretty(&state) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("Failed to serialize installer state: {}", e);
            return;
        }
    };
    if let Err(e) = std::fs::write(&state_path, body) {
        log::warn!("Failed to write installer state: {}", e);
    }
}

fn read_saved_app_language() -> Option<String> {
    let config_directory = ensure_config_directory().ok()?;
    let handoff_path = config_directory.join(INSTALLER_CONFIG_HANDOFF_FILE_NAME);
    if let Ok(content) = std::fs::read_to_string(&handoff_path) {
        if let Ok(handoff) = serde_json::from_str::<InstallerConfigHandoff>(&content) {
            if let Some(language) = handoff.language.as_deref().and_then(normalize_app_language) {
                return Some(language.to_string());
            }
        }
    }

    let app_config_file = config_directory.join("app.json");
    if !app_config_file.exists() {
        return None;
    }

    let content = std::fs::read_to_string(&app_config_file).ok()?;
    let root: Value = serde_json::from_str(&content).ok()?;
    let lang = root.get("app")?.get("language")?.as_str()?;

    normalize_app_language(lang).map(str::to_string)
}

fn normalize_app_language(lang: &str) -> Option<&'static str> {
    // Always persist the canonical app locale id so the desktop app, web UI,
    // and installer do not have to handle mixed aliases from old configs.
    let normalized = lang.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    INSTALLER_APP_LANGUAGE_ALIASES_BY_PRIORITY
        .iter()
        .find_map(|(code, alias)| {
            let alias = alias.to_ascii_lowercase();
            (normalized == alias || normalized.starts_with(&format!("{alias}-"))).then_some(*code)
        })
}

async fn update_installer_handoff_at(
    handoff_path: &Path,
    update: impl FnOnce(&mut InstallerConfigHandoff),
) -> Result<(), String> {
    JsonFileStore
        .update_locked(handoff_path, InstallerConfigHandoff::default(), update)
        .await
        .map(|_| ())
        .map_err(|error| format!("Failed to write installer handoff: {error}"))
}

async fn apply_first_launch_language(app_language: &str) -> Result<(), String> {
    let handoff_path = installer_config_handoff_path()?;
    apply_first_launch_language_at(&handoff_path, app_language).await
}

async fn apply_first_launch_language_at(
    handoff_path: &Path,
    app_language: &str,
) -> Result<(), String> {
    let Some(app_language) = normalize_app_language(app_language) else {
        return Err("Unsupported app language".to_string());
    };

    update_installer_handoff_at(handoff_path, |handoff| {
        handoff.language = Some(app_language.to_string());
    })
    .await
}

async fn apply_theme_preference_at(
    handoff_path: &Path,
    theme_preference: &str,
) -> Result<(), String> {
    update_installer_handoff_at(handoff_path, |handoff| {
        handoff.appearance_selection = Some(theme_preference.to_string());
    })
    .await
}

async fn apply_first_launch_model(model: &ModelConfig) -> Result<(), String> {
    let handoff_path = installer_config_handoff_path()?;
    apply_first_launch_model_at(&handoff_path, model).await
}

async fn apply_first_launch_model_at(
    handoff_path: &Path,
    model: &ModelConfig,
) -> Result<(), String> {
    if model.provider.trim().is_empty()
        || model.api_key.trim().is_empty()
        || model.base_url.trim().is_empty()
        || model.model_name.trim().is_empty()
    {
        return Ok(());
    }

    let _ = parse_custom_request_body(&model.custom_request_body)?;
    let provider = storage_format(model);
    if provider.is_empty() {
        return Err("Model format is required".to_string());
    }
    let custom_headers = model.custom_headers.as_ref().and_then(|headers| {
        let headers = headers
            .iter()
            .filter_map(|(key, value)| {
                let key = key.trim();
                (!key.is_empty()).then(|| (key.to_string(), value.trim().to_string()))
            })
            .collect::<HashMap<_, _>>();
        (!headers.is_empty()).then_some(headers)
    });
    let custom_headers_mode = custom_headers.as_ref().and_then(|_| {
        let mode = model
            .custom_headers_mode
            .as_deref()
            .unwrap_or("merge")
            .trim()
            .to_ascii_lowercase();
        matches!(mode.as_str(), "merge" | "replace").then_some(mode)
    });
    let model_handoff = InstallerModelHandoff {
        name: model
            .config_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} - {}", model.provider, model.model_name)),
        provider: provider.clone(),
        model_name: model.model_name.trim().to_string(),
        base_url: model.base_url.trim().to_string(),
        request_url: resolve_stored_request_url(&model.base_url, &provider),
        api_key: model.api_key.trim().to_string(),
        custom_headers,
        custom_headers_mode,
        skip_ssl_verify: model.skip_ssl_verify.unwrap_or(false),
        custom_request_body: model
            .custom_request_body
            .as_deref()
            .map(str::trim)
            .filter(|body| !body.is_empty())
            .map(str::to_string),
    };

    update_installer_handoff_at(handoff_path, move |handoff| {
        handoff.model = Some(model_handoff);
    })
    .await
}

fn preflight_validate_payload_zip_bytes(
    zip_bytes: &[u8],
    source_label: &str,
) -> Result<(), String> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Invalid zip from {source_label}: {e}"))?;
    preflight_validate_payload_zip_archive(&mut archive, source_label)
}

fn preflight_validate_payload_zip_file(path: &Path, source_label: &str) -> Result<(), String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open payload zip ({source_label}): {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid payload zip ({source_label}): {e}"))?;
    preflight_validate_payload_zip_archive(&mut archive, source_label)
}

fn preflight_validate_payload_zip_archive<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    source_label: &str,
) -> Result<(), String> {
    let mut exe_size: Option<u64> = None;
    let mut archive_paths = HashSet::new();
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read payload entry ({source_label}): {e}"))?;
        let name = file
            .name()
            .map_err(|e| format!("Failed to decode payload entry name ({source_label}): {e}"))?;
        if name.ends_with('/') {
            continue;
        }
        archive_paths.insert(normalize_payload_path(&name));
        let file_name = zip_entry_file_name(&name);
        if file_name.eq_ignore_ascii_case(MAIN_APP_EXE) {
            exe_size = Some(file.size());
        }
    }

    let size = exe_size.ok_or_else(|| {
        format!(
            "Payload from {source_label} does not contain {}",
            MAIN_APP_EXE
        )
    })?;
    validate_payload_exe_size(size, source_label)?;
    validate_required_payload_paths(&archive_paths, source_label)
}

fn preflight_validate_payload_dir(path: &Path, source_label: &str) -> Result<(), String> {
    let app_exe = path.join(MAIN_APP_EXE);
    let meta = std::fs::metadata(&app_exe).map_err(|_| {
        format!(
            "Payload directory from {source_label} does not contain {}",
            app_exe.display()
        )
    })?;
    validate_payload_exe_size(meta.len(), source_label)?;

    let available = REQUIRED_PAYLOAD_FILES
        .iter()
        .filter(|relative| path.join(relative).is_file())
        .map(|relative| (*relative).to_string())
        .collect::<HashSet<_>>();
    validate_required_payload_paths(&available, source_label)
}

fn validate_payload_exe_size(size: u64, source_label: &str) -> Result<(), String> {
    if size < MIN_WINDOWS_APP_EXE_BYTES {
        return Err(format!(
            "Payload {} from {source_label} is too small ({size} bytes)",
            MAIN_APP_EXE
        ));
    }
    Ok(())
}

fn read_payload_manifest_from_zip_bytes(
    zip_bytes: &[u8],
    source_label: &str,
) -> Result<PayloadManifest, String> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| format!("Invalid zip from {source_label}: {e}"))?;
    read_payload_manifest_from_zip_archive(&mut archive, source_label)
}

fn read_payload_manifest_from_zip_file(
    path: &Path,
    source_label: &str,
) -> Result<PayloadManifest, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open payload zip ({source_label}): {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid payload zip ({source_label}): {e}"))?;
    read_payload_manifest_from_zip_archive(&mut archive, source_label)
}

fn read_payload_manifest_from_zip_archive<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    source_label: &str,
) -> Result<PayloadManifest, String> {
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read payload entry ({source_label}): {e}"))?;
        let name = file
            .name()
            .map_err(|e| format!("Failed to decode payload entry name ({source_label}): {e}"))?;
        let file_name = zip_entry_file_name(&name);
        if !file_name.eq_ignore_ascii_case(PAYLOAD_MANIFEST_FILE) {
            continue;
        }
        let mut raw = String::new();
        file.read_to_string(&mut raw)
            .map_err(|e| format!("Failed to read payload manifest ({source_label}): {e}"))?;
        return parse_payload_manifest(&raw, source_label);
    }

    Err(format!(
        "Payload manifest is missing from {source_label}. Refusing unsafe install."
    ))
}

fn read_payload_manifest_from_dir(
    path: &Path,
    source_label: &str,
) -> Result<PayloadManifest, String> {
    let manifest_path = path.join(PAYLOAD_MANIFEST_FILE);
    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| {
        format!(
            "Failed to read payload manifest from {} ({}): {}",
            source_label,
            manifest_path.display(),
            e
        )
    })?;
    parse_payload_manifest(&raw, source_label)
}

fn parse_payload_manifest(raw: &str, source_label: &str) -> Result<PayloadManifest, String> {
    let manifest: PayloadManifest = serde_json::from_str(raw)
        .map_err(|e| format!("Invalid payload manifest from {source_label}: {}", e))?;
    validate_payload_manifest(&manifest, source_label)?;
    Ok(manifest)
}

fn normalize_payload_path(raw: &str) -> String {
    raw.replace('\\', "/").trim_start_matches("./").to_string()
}

fn validate_required_payload_paths(
    available: &HashSet<String>,
    source_label: &str,
) -> Result<(), String> {
    let missing = REQUIRED_PAYLOAD_FILES
        .iter()
        .filter(|required| !available.contains(**required))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Payload from {source_label} is incomplete; missing required files: {}",
        missing.join(", ")
    ))
}

fn validate_payload_manifest(manifest: &PayloadManifest, source_label: &str) -> Result<(), String> {
    let mut paths = HashSet::new();
    for entry in &manifest.files {
        let relative = sanitize_manifest_relative_path(&entry.path)?;
        if relative.as_os_str().is_empty() {
            return Err(format!(
                "Payload manifest from {source_label} has an empty path"
            ));
        }
        let normalized = normalize_payload_path(&entry.path);
        if !paths.insert(normalized.clone()) {
            return Err(format!(
                "Payload manifest from {source_label} contains duplicate path: {normalized}"
            ));
        }
        if entry.sha256.len() != 64 || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!(
                "Payload manifest from {source_label} has an invalid SHA-256 for: {normalized}"
            ));
        }
    }

    validate_required_payload_paths(&paths, source_label)
}

fn zip_entry_file_name(entry_name: &str) -> &str {
    entry_name
        .rsplit(&['/', '\\'][..])
        .next()
        .unwrap_or(entry_name)
}

fn is_payload_manifest_path(relative_path: &Path) -> bool {
    relative_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|n| n.eq_ignore_ascii_case(PAYLOAD_MANIFEST_FILE))
        .unwrap_or(false)
}

fn should_install_payload_path(relative_path: &Path) -> bool {
    !is_payload_manifest_path(relative_path)
}

fn collect_payload_relative_paths_for_uninstall() -> Result<Vec<String>, String> {
    if embedded_payload_available() {
        return Ok(read_payload_manifest_from_zip_bytes(
            EMBEDDED_PAYLOAD_ZIP,
            "embedded payload zip",
        )?
        .files
        .into_iter()
        .map(|entry| entry.path)
        .collect());
    }

    Ok(vec![MAIN_APP_EXE.to_string()])
}

fn collect_uninstall_targets(install_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut relative_paths = collect_payload_relative_paths_for_uninstall()?;
    relative_paths.push("uninstall.exe".to_string());

    let mut targets: Vec<PathBuf> = relative_paths
        .into_iter()
        .map(|entry| sanitize_manifest_relative_path(&entry))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|entry| install_path.join(entry))
        .collect();
    targets.sort();
    targets.dedup();
    Ok(targets)
}

fn remove_installed_targets(
    install_path: &Path,
    targets: &[PathBuf],
    skip_file: Option<&Path>,
) -> Result<(), String> {
    for path in targets {
        if skip_file
            .map(|skip| paths_equal_for_platform(path, skip))
            .unwrap_or(false)
        {
            continue;
        }

        if !path.exists() {
            continue;
        }

        if path.is_file() {
            std::fs::remove_file(path).map_err(|e| {
                format!("Failed to remove installed file {}: {}", path.display(), e)
            })?;
        }
    }

    for dir in collect_parent_directories(install_path, targets) {
        let _ = std::fs::remove_dir(&dir);
    }
    let _ = std::fs::remove_dir(install_path);

    Ok(())
}

fn collect_parent_directories(root: &Path, paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in paths {
        let mut current = path.parent().map(|p| p.to_path_buf());
        while let Some(dir) = current {
            if paths_equal_for_platform(&dir, root) {
                break;
            }
            if dirs.iter().any(|existing| existing == &dir) {
                break;
            }
            dirs.push(dir.clone());
            current = dir.parent().map(|p| p.to_path_buf());
        }
    }

    dirs.sort_by(|a, b| {
        b.components()
            .count()
            .cmp(&a.components().count())
            .then_with(|| a.cmp(b))
    });
    dirs
}

fn sanitize_manifest_relative_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Err(format!("Manifest entry must be relative: {}", raw));
    }

    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("Manifest entry escapes install directory: {}", raw));
    }

    Ok(path)
}

fn verify_installed_payload(install_path: &Path, manifest: &PayloadManifest) -> Result<(), String> {
    let app_exe = install_path.join(MAIN_APP_EXE);
    let app_meta = std::fs::metadata(&app_exe)
        .map_err(|_| format!("Installed {} is missing after extraction", MAIN_APP_EXE))?;
    if app_meta.len() < MIN_WINDOWS_APP_EXE_BYTES {
        return Err(format!(
            "Installed {} is too small ({} bytes). Payload is likely invalid.",
            MAIN_APP_EXE,
            app_meta.len()
        ));
    }

    for entry in &manifest.files {
        let relative_path = sanitize_manifest_relative_path(&entry.path)?;
        let installed_path = install_path.join(&relative_path);
        let metadata = std::fs::metadata(&installed_path).map_err(|_| {
            format!(
                "Installed payload file is missing after extraction: {}",
                relative_path.display()
            )
        })?;
        if !metadata.is_file() || metadata.len() != entry.size {
            return Err(format!(
                "Installed payload file has the wrong size: {} (expected {}, found {})",
                relative_path.display(),
                entry.size,
                metadata.len()
            ));
        }

        let actual_sha256 = sha256_file(&installed_path)?;
        if !actual_sha256.eq_ignore_ascii_case(&entry.sha256) {
            return Err(format!(
                "Installed payload file failed SHA-256 validation: {}",
                relative_path.display()
            ));
        }
    }

    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Failed to open {} for hashing: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to hash {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn paths_equal_for_platform(a: &Path, b: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_path_eq_case_insensitive(a, b)
    }

    #[cfg(not(target_os = "windows"))]
    {
        a == b
    }
}

#[cfg(target_os = "windows")]
fn rollback_installation(
    install_path: &Path,
    install_dir_was_absent: bool,
    windows_state: &WindowsInstallState,
) {
    use super::registry;
    use super::shortcut;

    log::warn!("Installation failed, starting rollback");

    if windows_state.manufacturer_registered {
        let _ = registry::remove_tauri_install_location();
    }
    if windows_state.start_menu_shortcut_created {
        let _ = shortcut::remove_start_menu_shortcut();
    }
    if windows_state.desktop_shortcut_created {
        let _ = shortcut::remove_desktop_shortcut();
    }
    if windows_state.uninstall_registered {
        let _ = registry::remove_uninstall_entry();
    }

    if install_dir_was_absent && install_path.exists() {
        let _ = std::fs::remove_dir_all(install_path);
    }
}

#[cfg(not(target_os = "windows"))]
fn rollback_installation(install_path: &Path, install_dir_was_absent: bool) {
    log::warn!("Installation failed, starting rollback");
    if install_dir_was_absent && install_path.exists() {
        let _ = std::fs::remove_dir_all(install_path);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_first_launch_language_at, apply_theme_preference_at, normalize_app_language,
        preflight_validate_payload_zip_archive, INSTALLER_APP_LANGUAGE_ALIASES_BY_PRIORITY,
        MAIN_APP_EXE, MIN_WINDOWS_APP_EXE_BYTES, REQUIRED_PAYLOAD_FILES,
    };
    use openbitfun_core_types::installer_config_handoff::{
        InstallerConfigHandoff, INSTALLER_CONFIG_HANDOFF_FILE_NAME,
    };
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;

    #[test]
    fn legacy_migration_command_reports_the_independent_distribution() {
        let result =
            super::launch_legacy_data_migrator(super::LaunchLegacyDataMigratorRequest::default());
        assert!(result.unwrap_err().contains("distributed separately"));
    }

    #[test]
    fn language_alias_priority_is_descending_and_stable_for_equal_lengths() {
        let aliases = INSTALLER_APP_LANGUAGE_ALIASES_BY_PRIORITY.as_slice();

        assert!(aliases
            .windows(2)
            .all(|pair| pair[0].1.len() >= pair[1].1.len()));

        let expected_equal_length_order = super::INSTALLER_GENERATED_LOCALES
            .iter()
            .flat_map(|locale| {
                locale
                    .aliases
                    .iter()
                    .map(move |alias| (locale.code, *alias))
            })
            .filter(|(_, alias)| alias.len() == 2)
            .collect::<Vec<_>>();
        let actual_equal_length_order = aliases
            .iter()
            .copied()
            .filter(|(_, alias)| alias.len() == 2)
            .collect::<Vec<_>>();
        assert_eq!(actual_equal_length_order, expected_equal_length_order);
    }

    #[test]
    fn normalize_app_language_maps_aliases_to_canonical_ids() {
        assert_eq!(normalize_app_language("zh-CN"), Some("zh-CN"));
        assert_eq!(normalize_app_language("zh"), Some("zh-CN"));
        assert_eq!(normalize_app_language("zh-Hans"), Some("zh-CN"));
        assert_eq!(normalize_app_language("zh-TW"), Some("zh-TW"));
        assert_eq!(normalize_app_language("zh-Hant"), Some("zh-TW"));
        assert_eq!(normalize_app_language("zh-Hant-TW"), Some("zh-TW"));
        assert_eq!(normalize_app_language("zh-HK"), Some("zh-TW"));
        assert_eq!(normalize_app_language("  EN-us  "), Some("en-US"));
        assert_eq!(normalize_app_language("en"), Some("en-US"));
        assert_eq!(normalize_app_language("en-US"), Some("en-US"));
    }

    #[test]
    fn normalize_app_language_rejects_unknown_language_codes() {
        assert_eq!(normalize_app_language("fr-FR"), None);
        assert_eq!(normalize_app_language(""), None);
    }

    #[test]
    fn installer_preferences_do_not_create_app_config() {
        tauri::async_runtime::block_on(async {
            let temp = tempfile::tempdir().unwrap();
            let config_dir = temp.path().join("config");
            let handoff_path = config_dir.join(INSTALLER_CONFIG_HANDOFF_FILE_NAME);

            apply_first_launch_language_at(&handoff_path, "en")
                .await
                .unwrap();
            apply_theme_preference_at(&handoff_path, "openbitfun-light")
                .await
                .unwrap();

            assert!(!config_dir.join("app.json").exists());
            let handoff: InstallerConfigHandoff = serde_json::from_slice(
                &std::fs::read(&handoff_path).expect("handoff should be persisted"),
            )
            .expect("handoff should be valid JSON");
            assert_eq!(handoff.language.as_deref(), Some("en-US"));
            assert_eq!(
                handoff.appearance_selection.as_deref(),
                Some("openbitfun-light")
            );
            assert!(handoff.model.is_none());
        });
    }

    #[test]
    fn payload_zip_preflight_scans_entries_after_main_executable() {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            let options = SimpleFileOptions::default();

            // The production payload is sorted, so the executable appears before
            // the required nested directories. Preflight must still scan the rest.
            writer.start_file(MAIN_APP_EXE, options).unwrap();
            writer
                .write_all(&vec![0_u8; MIN_WINDOWS_APP_EXE_BYTES as usize])
                .unwrap();
            for required in REQUIRED_PAYLOAD_FILES
                .iter()
                .copied()
                .filter(|path| *path != MAIN_APP_EXE)
            {
                writer.start_file(required, options).unwrap();
                writer.write_all(b"payload").unwrap();
            }
            writer.finish().unwrap();
        }

        bytes.set_position(0);
        let mut archive = zip::ZipArchive::new(bytes).unwrap();
        assert!(preflight_validate_payload_zip_archive(&mut archive, "test payload").is_ok());
    }
}
