//! Tauri commands exposed to the frontend installer UI.

use super::extract::{self, ESTIMATED_INSTALL_SIZE};
use super::generated_locale_contract::INSTALLER_GENERATED_LOCALES;
use super::transaction::{self, Transaction};
use super::types::{
    ConnectionTestResult, DiskSpaceInfo, InstallOptions, InstallProgress, ModelConfig,
    RemoteModelInfo,
};
use super::MAIN_APP_EXE;
use openbitfun_core_types::{
    installer_config_handoff::{
        InstallerConfigHandoff, InstallerModelHandoff, INSTALLER_CONFIG_HANDOFF_FILE_NAME,
    },
    product_identity::data_namespace,
};
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    LazyLock,
};
use tauri::{Emitter, Manager, Window};

static MAINTENANCE_BUSY: AtomicBool = AtomicBool::new(false);
struct OperationGuard {
    _lock: Option<File>,
}
impl OperationGuard {
    fn acquire(machine: bool) -> Result<Self, String> {
        MAINTENANCE_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Another maintenance operation is already in progress".to_string())?;
        let result = (|| {
            let directory = if machine {
                let directory = PathBuf::from(
                    std::env::var_os("PROGRAMDATA")
                        .ok_or("Machine data directory is unavailable")?,
                )
                .join(data_namespace())
                .join("maintenance");
                std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
                directory
            } else {
                ensure_config_directory()?
            };
            let path = directory.join("maintenance.lock");
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)
                .map_err(|e| e.to_string())?;
            file.try_lock()
                .map_err(|_| "Another maintenance process is already running".to_string())?;
            Ok(Self { _lock: Some(file) })
        })();
        if result.is_err() {
            MAINTENANCE_BUSY.store(false, Ordering::Release);
        }
        result
    }
}
impl Drop for OperationGuard {
    fn drop(&mut self) {
        self._lock.take();
        MAINTENANCE_BUSY.store(false, Ordering::Release);
    }
}
pub(crate) fn maintenance_busy() -> bool {
    MAINTENANCE_BUSY.load(Ordering::Acquire)
}

pub(crate) fn persist_native_outcome(code: u32, error: Option<&str>) {
    #[cfg(windows)]
    super::elevation::persist_native_outcome(code, error);
    #[cfg(not(windows))]
    let _ = (code, error);
}

struct UiOperation;
impl UiOperation {
    fn acquire() -> Result<Self, String> {
        MAINTENANCE_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Another maintenance operation is already running".to_string())?;
        Ok(Self)
    }
}
impl Drop for UiOperation {
    fn drop(&mut self) {
        MAINTENANCE_BUSY.store(false, Ordering::Release);
    }
}

/// Kept in the executable so release collection can reject pre-protocol installers.
pub(crate) const MAINTENANCE_PROTOCOL: &str = "OPENBITFUN_MAINTENANCE_V1";

pub(crate) fn native_mode() -> Option<Result<(), String>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--maintenance-protocol") {
        println!("{MAINTENANCE_PROTOCOL}");
        return Some(Ok(()));
    }
    let flags = args
        .iter()
        .take_while(|arg| !arg.eq_ignore_ascii_case("/ARGS"))
        .collect::<Vec<_>>();
    let update = flags.iter().any(|arg| arg.eq_ignore_ascii_case("/UPDATE"));
    let install = flags
        .iter()
        .any(|arg| arg.eq_ignore_ascii_case("/NATIVE_INSTALL"));
    let quiet = flags
        .iter()
        .any(|arg| *arg == "--quiet" || arg.eq_ignore_ascii_case("/NATIVE_UNINSTALL"));
    if !update && !quiet && !install {
        return None;
    }
    if crate::preview::is_enabled() {
        return Some(Err("Preview cannot execute maintenance".into()));
    }
    Some(tauri::async_runtime::block_on(async {
        #[cfg(windows)]
        if let Some(owner) = args.iter().find_map(|arg| arg.strip_prefix("/OWNER_SID=")) {
            let target = args
                .iter()
                .find_map(|arg| arg.strip_prefix("/OPENBITFUN_TARGET="))
                .or_else(|| {
                    args.iter()
                        .position(|arg| arg == "--uninstall")
                        .and_then(|index| args.get(index + 1))
                        .map(String::as_str)
                })
                .map(PathBuf::from);
            let machine = flags
                .iter()
                .any(|arg| arg.eq_ignore_ascii_case("/ALLUSERS"))
                || target
                    .as_ref()
                    .is_some_and(|target| super::registry::is_machine_install(target));
            if !machine && super::elevation::owner_sid()? != owner {
                return Err("The administrator account differs from the installation owner. Run maintenance as the original owner or ask your administrator to repair the installation; no files were changed".into());
            }
        }
        if update || install {
            let target = args
                .iter()
                .find_map(|arg| arg.strip_prefix("/OPENBITFUN_TARGET=").map(str::to_string))
                .unwrap_or_else(get_initial_install_path);
            let validated = prepare_install_target(Path::new(&target))?;
            let space = get_disk_space(validated.to_string_lossy().into_owned())?;
            if !space.sufficient {
                return Err("Insufficient disk space for update staging".into());
            }
            #[cfg(windows)]
            wait_for_update_parent(&args, &validated)?;
            #[cfg(windows)]
            if update && !args.iter().any(|arg| arg.starts_with("/READY_EVENT=")) {
                wait_for_legacy_update_parent(&validated)?;
            }
            let options = InstallOptions {
                install_path: target.clone(),
                all_users: flags
                    .iter()
                    .any(|arg| arg.eq_ignore_ascii_case("/ALLUSERS")),
                desktop_shortcut: flags
                    .iter()
                    .any(|arg| arg.eq_ignore_ascii_case("/DESKTOP_SHORTCUT")),
                start_menu: flags
                    .iter()
                    .any(|arg| arg.eq_ignore_ascii_case("/START_MENU")),
                launch_after_install: false,
                app_language: "en-US".into(),
                theme_preference: "system".into(),
                model_config: None,
            };
            let result = install_impl(None, options).await?;
            if flags.iter().any(|arg| arg.eq_ignore_ascii_case("/R")) {
                launch_application(target)?;
            }
            if result.cleanup_pending {
                return Err("Update installed, but maintenance cleanup remains pending; reopen the application and retry cleanup".into());
            }
        } else {
            let path = args
                .iter()
                .position(|arg| arg == "--uninstall")
                .and_then(|index| args.get(index + 1))
                .cloned()
                .ok_or("Silent uninstall requires an explicit installation path")?;
            let result = uninstall_impl(None, path).await?;
            if result.cleanup_pending {
                return Err(
                    "Uninstall completed, but some maintenance files remain; retry cleanup".into(),
                );
            }
        }
        Ok(())
    }))
}

#[cfg(windows)]
fn wait_for_legacy_update_parent(root: &Path) -> Result<(), String> {
    let powershell = system_powershell()?;
    let script = r#"$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($env:OPENBITFUN_LEGACY_UPDATE_TARGET)
$name=[IO.Path]::GetFileNameWithoutExtension($target)
$deadline=[DateTime]::UtcNow.AddMinutes(3)
foreach($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
  try { $path=$process.Path } catch { if($process.HasExited) { continue }; throw }
  if(!$path) { if($process.HasExited) { continue }; throw 'Cannot inspect an OpenBitFun process; close all application instances and retry' }
  if([String]::Equals([IO.Path]::GetFullPath($path),$target,[StringComparison]::OrdinalIgnoreCase)) {
    $left=[int][Math]::Max(0,($deadline-[DateTime]::UtcNow).TotalMilliseconds)
    if(!$process.WaitForExit($left)) { throw 'OpenBitFun did not exit; close the application and retry. No installation files were changed.' }
  }
}
"#;
    let result = create_windows_silent_command(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("OPENBITFUN_LEGACY_UPDATE_TARGET", root.join(MAIN_APP_EXE))
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "Cannot wait for the previous OpenBitFun version to exit: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn wait_for_update_parent(args: &[String], root: &Path) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            image: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn SetEvent(event: *mut c_void) -> i32;
        fn WaitForMultipleObjects(
            count: u32,
            objects: *const *mut c_void,
            all: i32,
            milliseconds: u32,
        ) -> u32;
        fn CloseHandle(object: *mut c_void) -> i32;
    }
    let Some(event_name) = args
        .iter()
        .find_map(|arg| arg.strip_prefix("/READY_EVENT="))
    else {
        return Ok(());
    };
    if !event_name.starts_with("Local\\OpenBitFunUpdate-") || event_name.len() > 128 {
        return Err("Invalid update handoff event".into());
    }
    let pid = args
        .iter()
        .find_map(|arg| arg.strip_prefix("/WAITPID="))
        .ok_or("Update parent process is missing")?
        .parse::<u32>()
        .map_err(|_| "Update parent process is invalid")?;
    if pid == std::process::id() {
        return Err("Cannot wait for the maintenance process itself".into());
    }
    struct Handle(*mut c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let parent = Handle(unsafe { OpenProcess(0x00100000 | 0x1000, 0, pid) });
    if parent.0.is_null() {
        return Err("Cannot establish update parent identity; no files were changed".into());
    }
    let mut image = vec![0_u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(parent.0, 0, image.as_mut_ptr(), &mut length) } == 0
        || !windows_path_eq_case_insensitive(
            Path::new(&String::from_utf16_lossy(&image[..length as usize])),
            &root.join(MAIN_APP_EXE),
        )
    {
        return Err("Update parent does not belong to the target installation".into());
    }
    let supervisor_pid = args
        .iter()
        .find_map(|arg| arg.strip_prefix("/SUPERVISOR_PID="))
        .ok_or("Update supervisor process is missing")?
        .parse::<u32>()
        .map_err(|_| "Invalid update supervisor process")?;
    let supervisor = Handle(unsafe { OpenProcess(0x00100000, 0, supervisor_pid) });
    if supervisor.0.is_null() {
        return Err("Update supervisor is unavailable".into());
    }
    let name = std::ffi::OsStr::new(event_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let ready = Handle(unsafe { OpenEventW(2, 0, name.as_ptr()) });
    if ready.0.is_null() || unsafe { SetEvent(ready.0) } == 0 {
        return Err("Update supervisor is unavailable".into());
    }
    // A canceled/timed-out supervisor cannot leave an orphan installer that
    // applies a formerly canceled update when the user later closes the app.
    let handles = [supervisor.0, parent.0];
    if unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, 180_000) } != 1 {
        return Err("Update handoff was canceled or the application did not exit; no installation files were changed".into());
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
struct IntegrationSnapshot {
    registry: super::registry::Snapshot,
    shortcuts: super::shortcut::Snapshot,
}

fn restore_integrations(path: &Path, snapshot: &Value) -> Result<(), String> {
    #[cfg(windows)]
    {
        let snapshot: IntegrationSnapshot =
            serde_json::from_value(snapshot.clone()).map_err(|e| e.to_string())?;
        super::registry::restore(path, &snapshot.registry).map_err(|e| e.to_string())?;
        super::shortcut::restore(path, &snapshot.shortcuts).map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (path, snapshot);
    Ok(())
}

fn snapshot_integrations(path: &Path, tx: &mut Transaction, machine: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let snapshot = IntegrationSnapshot {
            registry: super::registry::snapshot(path, machine).map_err(|e| e.to_string())?,
            shortcuts: super::shortcut::snapshot(path, machine).map_err(|e| e.to_string())?,
        };
        tx.snapshot_integrations(serde_json::to_value(snapshot).map_err(|e| e.to_string())?)?;
    }
    #[cfg(not(windows))]
    let _ = (path, tx, machine);
    Ok(())
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

#[cfg(windows)]
pub(crate) fn windows_system_directory() -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0_u16; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Windows system directory is unavailable".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

#[cfg(windows)]
pub(crate) fn system_powershell() -> Result<PathBuf, String> {
    Ok(windows_system_directory()?.join("WindowsPowerShell/v1.0/powershell.exe"))
}

#[cfg(target_os = "windows")]
pub(crate) fn create_windows_silent_command<S: AsRef<std::ffi::OsStr>>(
    program: S,
) -> std::process::Command {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PayloadManifest {
    files: Vec<PayloadManifestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub(crate) fn get_default_install_path(all_users: Option<bool>) -> String {
    let base = if cfg!(target_os = "windows") {
        if all_users == Some(true) {
            std::env::var_os("ProgramW6432")
                .or_else(|| std::env::var_os("ProgramFiles"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        } else {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .or_else(dirs::data_local_dir)
                .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        }
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
            if let Ok(resolved) = resolve_install_target(Path::new(&data.install_location)) {
                return resolved.to_string_lossy().to_string();
            }
        }
        if let Some(from_reg) = registry::read_tauri_install_location() {
            if let Ok(resolved) = resolve_install_target(Path::new(&from_reg)) {
                return resolved.to_string_lossy().to_string();
            }
        }
    }
    if let Some(saved) = read_last_install_path() {
        if let Ok(resolved) = resolve_install_target(Path::new(&saved)) {
            return resolved.to_string_lossy().to_string();
        }
    }
    get_default_install_path(None)
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
pub(super) fn parse_windows_command_line(command_line: &str) -> Result<Vec<String>, String> {
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
                    required: required_install_space()?,
                    sufficient: free_bytes_available >= required_install_space()?,
                });
            }
        }
    }

    Err("Cannot determine available disk space; check the target drive and retry".into())
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
    // Validation must be read-only. Permission probing belongs to execution,
    // where the native worker can request elevation for a protected directory.
    let install_path = resolve_install_target(&requested_path)?;
    Ok(InstallPathValidation {
        install_path: install_path.to_string_lossy().to_string(),
    })
}

/// Main installation command. Emits progress events to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaintenanceResult {
    is_update: bool,
    cleanup_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[tauri::command]
pub(crate) async fn start_installation(
    window: Window,
    options: InstallOptions,
) -> Result<MaintenanceResult, String> {
    #[cfg(windows)]
    {
        let path = resolve_install_target(Path::new(&options.install_path))?;
        super::registry::validate_scope(&path, options.all_users).map_err(|e| e.to_string())?;
        let needs_elevation = !super::elevation::is_elevated()
            && (options.all_users
                || super::registry::is_machine_install(&path)
                || prepare_install_target(&path)
                    .is_err_and(|error| error.ends_with("not_writable")));
        if needs_elevation {
            let _ui = UiOperation::acquire()?;
            let is_update =
                path.join(MAIN_APP_EXE).exists() || path.join(transaction::INVENTORY).exists();
            emit_progress(
                Some(&window),
                "prepare",
                0,
                "Waiting for administrator authorization...",
            );
            let mut args = vec![
                "/NATIVE_INSTALL".into(),
                format!("/OPENBITFUN_TARGET={}", path.display()),
                format!("/OWNER_SID={}", super::elevation::owner_sid()?),
            ];
            if options.all_users || super::registry::is_machine_install(&path) {
                args.push("/ALLUSERS".into());
            }
            if options.desktop_shortcut {
                args.push("/DESKTOP_SHORTCUT".into());
            }
            if options.start_menu {
                args.push("/START_MENU".into());
            }
            let current = std::env::current_exe().map_err(|e| e.to_string())?;
            let code = tauri::async_runtime::spawn_blocking(move || {
                super::elevation::run(&current, &args)
            })
            .await
            .map_err(|e| e.to_string())??;
            if code != 0 && code != 2 {
                return Err(format!("Administrator maintenance failed (exit code {code}); inspect the reported error before retrying"));
            }
            let warning = if !is_update {
                apply_first_launch_language(&options.app_language)
                    .await
                    .err()
            } else {
                None
            };
            persist_last_install_path(&path);
            emit_progress(Some(&window), "complete", 100, "Installation complete");
            return Ok(MaintenanceResult {
                is_update,
                cleanup_pending: code == 2,
                warning,
            });
        }
    }
    install_impl(Some(window), options).await
}

async fn install_impl(
    window: Option<Window>,
    options: InstallOptions,
) -> Result<MaintenanceResult, String> {
    #[cfg(windows)]
    let machine_lock =
        options.all_users || super::registry::is_machine_install(Path::new(&options.install_path));
    #[cfg(not(windows))]
    let machine_lock = options.all_users;
    let _operation = OperationGuard::acquire(machine_lock)?;
    let install_path = prepare_install_target(Path::new(&options.install_path))?;
    #[cfg(windows)]
    super::registry::validate_scope(&install_path, options.all_users).map_err(|e| e.to_string())?;
    let space = get_disk_space(install_path.to_string_lossy().into_owned())?;
    if !space.sufficient {
        return Err(
            "Insufficient disk space for installation staging and maintenance files".into(),
        );
    }
    let mut transaction = Transaction::open_with_recovery(&install_path, restore_integrations)?;
    let is_update = install_path.join(MAIN_APP_EXE).exists()
        || install_path.join(transaction::INVENTORY).exists();
    let previous = read_installed_inventory(&install_path)?;
    let stored_version = std::fs::read(install_path.join(transaction::INVENTORY))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    #[cfg(windows)]
    let stored_version =
        stored_version.or_else(|| super::registry::installed_version(&install_path));
    if let Some(version) = stored_version {
        validate_upgrade_version(&version, env!("CARGO_PKG_VERSION"))?;
    }
    #[cfg(windows)]
    if let Some(version) = installed_binary_version(&install_path.join(MAIN_APP_EXE)) {
        validate_upgrade_version(&version, env!("CARGO_PKG_VERSION"))?;
    }

    #[cfg(windows)]
    let machine = options.all_users || super::registry::is_machine_install(&install_path);
    #[cfg(not(windows))]
    let machine = options.all_users;
    let staging_path = transaction.stage();

    let result: Result<(), String> = async {
        // Step 1: Create target directory
        emit_progress(window.as_ref(), "prepare", 5, "Creating installation directory...");
        std::fs::create_dir_all(&install_path)
            .map_err(|e| format!("Failed to create directory: {}", e))?;

        // Step 2: Extract / copy application files
        emit_progress(window.as_ref(), "extract", 15, "Extracting application files...");

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
                &staging_path,
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
            for candidate in build_payload_candidates(window.as_ref(), &exe_dir) {
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
                        &staging_path,
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
                    &staging_path,
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
                let placeholder = staging_path.join(MAIN_APP_EXE);
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
            verify_installed_payload(&staging_path, manifest)?;
        }

        emit_progress(window.as_ref(), "extract", 50, "Files extracted successfully");

        let mut manifest = installed_manifest.unwrap_or(PayloadManifest { files: vec![] });
        #[cfg(windows)] {
            let current = std::env::current_exe().map_err(|e| e.to_string())?;
            let uninstaller = staging_path.join("uninstall.exe");
            std::fs::copy(current, &uninstaller).map_err(|e| format!("Cannot stage uninstaller: {e}"))?;
            manifest.files.push(PayloadManifestFile { path: "uninstall.exe".into(), size: std::fs::metadata(&uninstaller).map_err(|e| e.to_string())?.len(), sha256: sha256_file(&uninstaller)? });
        }
        let inventory = serde_json::json!({ "schema": 1, "productId": "openbitfun", "version": env!("CARGO_PKG_VERSION"), "allUsers": machine, "files": manifest.files });
        std::fs::write(staging_path.join(transaction::INVENTORY), serde_json::to_vec(&inventory).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut replacements = manifest.files.iter().map(|file| file.path.clone()).collect::<Vec<_>>();
        if used_debug_placeholder { replacements.push(MAIN_APP_EXE.into()); }
        replacements.push(transaction::INVENTORY.into());
        let obsolete = previous.map(|old| old.files.into_iter().map(|file| file.path).filter(|path| !replacements.contains(path)).collect::<Vec<_>>()).unwrap_or_default();
        snapshot_integrations(&install_path, &mut transaction, machine)?;
        transaction.publish(&replacements, &obsolete)?;

        // Step 3: Windows-specific operations
        #[cfg(target_os = "windows")]
        {
            use super::registry;
            use super::shortcut;

            let uninstaller_path = install_path.join("uninstall.exe");
            let uninstall_command = format!("\"{}\"", uninstaller_path.display());

            emit_progress(window.as_ref(), "registry", 60, "Registering application...");
            registry::register_tauri_install_location(&install_path)
                .map_err(|e| format!("Registry error: {}", e))?;

            registry::register_uninstall_entry(
                &install_path,
                env!("CARGO_PKG_VERSION"),
                &uninstall_command,
            )
            .map_err(|e| format!("Registry error: {}", e))?;


            // Desktop shortcut
            if options.desktop_shortcut {
                emit_progress(window.as_ref(), "shortcuts", 70, "Creating desktop shortcut...");
                shortcut::create_desktop_shortcut(&install_path)
                    .map_err(|e| format!("Shortcut error: {}", e))?;

            }

            // Start Menu
            if options.start_menu {
                emit_progress(window.as_ref(), "shortcuts", 75, "Creating Start Menu entry...");
                shortcut::create_start_menu_shortcut(&install_path)
                    .map_err(|e| format!("Start Menu error: {}", e))?;

            }
        }

        // Step 4: Pass startup preferences to the desktop configuration manager,
        // which remains the only writer of the canonical app.json.
        emit_progress(window.as_ref(), "config", 92, "Applying startup preferences...");
        if !is_update && window.is_some() {
            apply_first_launch_language(&options.app_language).await
                .map_err(|e| format!("Failed to apply startup preferences: {e}"))?;
        }
        Ok(())
    }
    .await;

    if let Err(error) = result {
        return match transaction.rollback() {
            Ok(()) => Err(error),
            Err(recovery) => Err(format!(
                "{error}. Recovery failed: {recovery}; installation backup was preserved"
            )),
        };
    }
    let cleaned = transaction.commit()?;

    if window.is_some() {
        persist_last_install_path(&install_path);
    }
    emit_progress(window.as_ref(), "complete", 100, "Installation complete!");

    Ok(MaintenanceResult {
        is_update,
        cleanup_pending: !cleaned,
        warning: None,
    })
}

/// Uninstall OpenBitFun (for the uninstaller companion).
#[tauri::command]
pub(crate) async fn uninstall(
    window: Window,
    install_path: String,
) -> Result<MaintenanceResult, String> {
    #[cfg(windows)]
    {
        let path = PathBuf::from(&install_path);
        if !super::elevation::is_elevated()
            && (super::registry::is_machine_install(&path)
                || prepare_install_target(&path)
                    .is_err_and(|error| error.ends_with("not_writable")))
        {
            let _ui = UiOperation::acquire()?;
            let current = std::env::current_exe().map_err(|e| e.to_string())?;
            let mut args = vec![
                "/NATIVE_UNINSTALL".into(),
                "--uninstall".into(),
                install_path,
                format!("/OPENBITFUN_TARGET={}", path.display()),
                format!("/OWNER_SID={}", super::elevation::owner_sid()?),
            ];
            if super::registry::is_machine_install(&path) {
                args.push("/ALLUSERS".into());
            }
            let code = tauri::async_runtime::spawn_blocking(move || {
                super::elevation::run(&current, &args)
            })
            .await
            .map_err(|e| e.to_string())??;
            if code != 0 && code != 2 {
                return Err(format!("Administrator uninstall failed (exit code {code}); installation recovery data was retained"));
            }
            return Ok(MaintenanceResult {
                is_update: false,
                cleanup_pending: code == 2,
                warning: None,
            });
        }
    }
    uninstall_impl(Some(window), install_path).await
}

async fn uninstall_impl(
    window: Option<Window>,
    install_path: String,
) -> Result<MaintenanceResult, String> {
    #[cfg(windows)]
    let machine_lock = super::registry::is_machine_install(Path::new(&install_path));
    #[cfg(not(windows))]
    let machine_lock = false;
    let _operation = OperationGuard::acquire(machine_lock)?;
    let install_path = PathBuf::from(&install_path);
    if !install_path.is_absolute() || !install_path.is_dir() {
        return Err("Installed directory is unavailable".into());
    }
    if !install_path.join(MAIN_APP_EXE).is_file()
        && !install_path.join(transaction::INVENTORY).is_file()
        && !install_path
            .join(transaction::WORK_DIR)
            .join("journal.json")
            .is_file()
    {
        return Err(
            "Cannot establish ownership of this installation; no files were removed".into(),
        );
    }
    // Running from the installation prevents a safe transactional rename.
    if std::env::current_exe()
        .ok()
        .is_some_and(|exe| paths_equal_for_platform(&exe, &install_path.join("uninstall.exe")))
    {
        return Err(
            "Restart the uninstaller from its registered entry before removing files".into(),
        );
    }
    let mut transaction = Transaction::open_with_recovery(&install_path, restore_integrations)?;
    let targets = collect_uninstall_targets(&install_path)?;
    let relative = targets
        .iter()
        .map(|path| {
            path.strip_prefix(&install_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    #[cfg(windows)]
    let machine = super::registry::is_machine_install(&install_path);
    #[cfg(not(windows))]
    let machine = false;
    snapshot_integrations(&install_path, &mut transaction, machine)?;
    emit_progress(
        window.as_ref(),
        "prepare",
        10,
        "Preparing uninstallation...",
    );
    transaction.publish(&[], &relative)?;
    let cleanup = (|| -> Result<(), String> {
        #[cfg(windows)]
        {
            use super::{registry, shortcut};
            emit_progress(
                window.as_ref(),
                "shortcuts",
                60,
                "Removing owned shortcuts...",
            );
            shortcut::remove_desktop_shortcut(&install_path).map_err(|e| e.to_string())?;
            shortcut::remove_start_menu_shortcut(&install_path).map_err(|e| e.to_string())?;
            registry::remove_context_menu(&install_path).map_err(|e| e.to_string())?;
            registry::remove_from_path(&install_path).map_err(|e| e.to_string())?;
            registry::remove_autostart_run_entry(&install_path).map_err(|e| e.to_string())?;
            emit_progress(
                window.as_ref(),
                "registry",
                85,
                "Removing owned registration...",
            );
            registry::remove_tauri_install_location(&install_path).map_err(|e| e.to_string())?;
            registry::remove_uninstall_entry(&install_path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = cleanup {
        return match transaction.rollback() {
            Ok(()) => Err(format!(
                "Uninstall failed; previous files restored: {error}"
            )),
            Err(recovery) => Err(format!(
                "Uninstall failed: {error}; recovery needs repair: {recovery}"
            )),
        };
    }
    let cleaned = transaction.commit()?;
    drop(transaction);
    if cleaned {
        for dir in collect_parent_directories(&install_path, &targets) {
            let _ = std::fs::remove_dir(dir);
        }
        let _ = std::fs::remove_dir(&install_path);
    }
    emit_progress(
        window.as_ref(),
        "complete",
        100,
        "Uninstallation complete; user data preserved",
    );
    Ok(MaintenanceResult {
        is_update: false,
        cleanup_pending: !cleaned,
        warning: None,
    })
}

#[cfg(windows)]
pub(super) fn windows_path_eq_case_insensitive(a: &Path, b: &Path) -> bool {
    fn normalize(path: &Path) -> String {
        std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    normalize(a) == normalize(b)
}

/// Relocate before creating a WebView so the installed executable is never in use
/// while the removal transaction backs it up. No command-shell cleanup is needed.
pub(crate) fn relocate_uninstaller() -> Result<bool, String> {
    #[cfg(windows)]
    {
        if crate::preview::is_enabled() || !is_running_as_uninstall_binary() {
            return Ok(false);
        }
        let current = std::env::current_exe().map_err(|e| e.to_string())?;
        let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
        let root = arguments
            .iter()
            .position(|arg| arg == "--uninstall")
            .and_then(|index| arguments.get(index + 1))
            .map(PathBuf::from)
            .or_else(|| current.parent().map(Path::to_path_buf))
            .ok_or("Uninstaller has no installation directory")?;
        let temp = tempfile::Builder::new()
            .prefix("openbitfun-uninstall-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let copy = temp.path().join("openbitfun-maintenance.exe");
        std::fs::copy(&current, &copy).map_err(|e| e.to_string())?;
        let mut child = create_windows_silent_command(&copy)
            .arg("--uninstall")
            .arg(&root)
            .args(&arguments)
            .spawn()
            .map_err(|e| format!("Cannot start uninstall maintenance: {e}"))?;
        let _retained = temp.keep();
        if arguments.iter().any(|arg| arg == "--quiet") {
            // Management tools must receive the worker's real result. Keeping
            // this image mapped may defer backup cleanup (exit 2), but a failed
            // removal must never be reported as a successful spawn (exit 0).
            let status = child
                .wait()
                .map_err(|e| format!("Cannot read uninstall result: {e}"))?;
            std::process::exit(status.code().unwrap_or(1));
        }
        return Ok(true);
    }
    #[cfg(not(windows))]
    Ok(false)
}

pub(crate) fn schedule_uninstaller_cleanup() {
    #[cfg(windows)]
    {
        let schedule = || -> Result<(), String> {
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            if executable.file_name() != Some(std::ffi::OsStr::new("openbitfun-maintenance.exe")) {
                return Ok(());
            }
            let directory = executable
                .parent()
                .ok_or("Temporary uninstaller directory is unavailable")?;
            let parent = directory
                .parent()
                .ok_or("Temporary uninstaller parent is unavailable")?;
            if !directory
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("openbitfun-uninstall-"))
                || !windows_path_eq_case_insensitive(parent, &std::env::temp_dir())
            {
                return Ok(());
            }
            let powershell = system_powershell()?;
            // Only the exact relocated executable and its now-empty directory
            // may be removed. Never recursively delete a computed temp path.
            let script = r#"$ErrorActionPreference='Stop'
$process=Get-Process -Id ([int]$env:OPENBITFUN_CLEANUP_PARENT) -ErrorAction SilentlyContinue
if($process) { $null=$process.Handle; $process.WaitForExit() }
$file=Join-Path $env:OPENBITFUN_CLEANUP_DIRECTORY 'openbitfun-maintenance.exe'
for($attempt=0;$attempt -lt 20;$attempt++) {
  try {
    if(Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    [IO.Directory]::Delete($env:OPENBITFUN_CLEANUP_DIRECTORY,$false)
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
"#;
            create_windows_silent_command(powershell)
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("OPENBITFUN_CLEANUP_PARENT", std::process::id().to_string())
                .env("OPENBITFUN_CLEANUP_DIRECTORY", directory)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            Ok(())
        };
        if let Err(error) = schedule() {
            eprintln!("Temporary uninstaller cleanup could not be scheduled: {error}");
        }
    }
}

/// Keep uninstall usable when an existing machine has no WebView2 runtime.
#[cfg(windows)]
pub(crate) fn uninstall_without_webview(path: String) -> Result<(), String> {
    let root = Path::new(&path);
    if !super::elevation::is_elevated()
        && (super::registry::is_machine_install(root)
            || prepare_install_target(root).is_err_and(|error| error.ends_with("not_writable")))
    {
        let args = vec![
            "/NATIVE_UNINSTALL".into(),
            "--uninstall".into(),
            path,
            format!("/OWNER_SID={}", super::elevation::owner_sid()?),
        ];
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        return match super::elevation::run(&executable, &args)? {
            0 => Ok(()),
            2 => {
                Err("Uninstall completed, but some maintenance files remain; retry cleanup".into())
            }
            code => Err(format!(
                "Uninstall failed with exit code {code}; recovery data was retained"
            )),
        };
    }
    let result = tauri::async_runtime::block_on(uninstall_impl(None, path))?;
    if result.cleanup_pending {
        return Err("Uninstall completed, but some maintenance files remain; retry cleanup".into());
    }
    Ok(())
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
    if maintenance_busy() {
        return;
    }
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

fn emit_progress(window: Option<&Window>, step: &str, percent: u32, message: &str) {
    let progress = InstallProgress {
        step: step.to_string(),
        percent,
        message: message.to_string(),
    };
    if let Some(window) = window {
        let _ = window.emit("install-progress", &progress);
    }
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

fn build_payload_candidates(window: Option<&Window>, exe_dir: &Path) -> Vec<PayloadCandidate> {
    let mut candidates = Vec::new();

    if let Some(resource_dir) =
        window.and_then(|window| window.app_handle().path().resource_dir().ok())
    {
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
    if path.join(transaction::INVENTORY).exists()
        || path
            .join(transaction::WORK_DIR)
            .join("journal.json")
            .is_file()
        || get_existing_installation()
            .install_location
            .as_deref()
            .is_some_and(|existing| paths_equal_for_platform(Path::new(existing), &path))
    {
        return path;
    }
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

fn resolve_install_target(requested_path: &Path) -> Result<PathBuf, String> {
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
        if directory_has_entries(&install_path)?
            && !install_path.join(MAIN_APP_EXE).exists()
            && !install_path
                .join(transaction::WORK_DIR)
                .join("journal.json")
                .is_file()
        {
            return Err(format!(
                "{}directory_must_be_empty_or_openbitfun",
                INSTALL_PATH_ERR_PREFIX
            ));
        }
    }

    Ok(install_path)
}

fn prepare_install_target(requested_path: &Path) -> Result<PathBuf, String> {
    let install_path = resolve_install_target(requested_path)?;
    let writable = if install_path.exists() {
        install_path.clone()
    } else {
        find_existing_ancestor(&install_path)
    };
    let probe = tempfile::Builder::new()
        .prefix(".openbitfun-write-probe-")
        .tempfile_in(&writable);
    match probe {
        Ok(_) => Ok(install_path),
        Err(error) if error.raw_os_error() == Some(112) => {
            Err("Insufficient disk space for maintenance staging".into())
        }
        Err(error) if error.kind() != std::io::ErrorKind::PermissionDenied => Err(format!(
            "Cannot probe installation directory {}: {error}",
            writable.display()
        )),
        Err(_) if install_path.exists() => {
            Err(format!("{INSTALL_PATH_ERR_PREFIX}directory_not_writable"))
        }
        Err(_) => Err(format!("{INSTALL_PATH_ERR_PREFIX}parent_not_writable")),
    }
}

fn directory_has_entries(path: &Path) -> Result<bool, String> {
    for entry in std::fs::read_dir(path)
        .map_err(|_| format!("{INSTALL_PATH_ERR_PREFIX}inspect_directory_failed"))?
    {
        let entry =
            entry.map_err(|_| format!("{INSTALL_PATH_ERR_PREFIX}inspect_directory_failed"))?;
        if ![
            transaction::WORK_DIR,
            transaction::LOCK_FILE,
            transaction::INVENTORY,
        ]
        .iter()
        .any(|name| entry.file_name() == std::ffi::OsStr::new(name))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(windows)]
fn installed_binary_version(path: &Path) -> Option<String> {
    let output = create_windows_silent_command(system_powershell().ok()?)
        .args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Diagnostics.FileVersionInfo]::GetVersionInfo($env:OPENBITFUN_VERSION_TARGET).ProductVersion)"])
        .env("OPENBITFUN_VERSION_TARGET", path).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    // Numeric Windows file versions can lose prerelease information. Only an
    // exact semantic ProductVersion may override legacy registration metadata.
    semver::Version::parse(&version).ok().map(|_| version)
}

fn validate_upgrade_version(installed: &str, incoming: &str) -> Result<(), String> {
    let installed = semver::Version::parse(installed).map_err(|_| {
        "Installed version is unreadable; retain the installation and repair its metadata"
    })?;
    let incoming = semver::Version::parse(incoming).map_err(|_| "Installer version is invalid")?;
    if incoming < installed {
        return Err(format!("Downgrade from {installed} to {incoming} was refused to protect existing configuration and session data"));
    }
    Ok(())
}

fn required_install_space() -> Result<u64, String> {
    let manifest = if embedded_payload_available() {
        Some(read_payload_manifest_from_zip_bytes(
            EMBEDDED_PAYLOAD_ZIP,
            "embedded payload",
        )?)
    } else {
        None
    };
    let payload = manifest
        .map(|m| {
            m.files
                .iter()
                .map(|f| f.size.saturating_add(8192))
                .sum::<u64>()
        })
        .unwrap_or(ESTIMATED_INSTALL_SIZE);
    let uninstaller = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(payload
        .saturating_add(uninstaller)
        .saturating_add(1024 * 1024))
}

fn read_installed_inventory(root: &Path) -> Result<Option<PayloadManifest>, String> {
    match std::fs::read(root.join(transaction::INVENTORY)) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                format!("Installed inventory is unreadable; retained for repair: {e}")
            })?;
            if value.get("schema").and_then(Value::as_u64) != Some(1)
                || value.get("productId").and_then(Value::as_str) != Some("openbitfun")
            {
                return Err("Unsupported installed inventory; no files were removed".into());
            }
            let manifest: PayloadManifest =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            for file in &manifest.files {
                transaction::relative_path(&file.path)?;
            }
            Ok(Some(manifest))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read installed inventory: {e}")),
    }
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
    let mut relative_paths = match read_installed_inventory(install_path)? {
        Some(manifest) => manifest.files.into_iter().map(|file| file.path).collect(),
        None => collect_payload_relative_paths_for_uninstall()?,
    };
    relative_paths.push(transaction::INVENTORY.into());
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
    transaction::relative_path(raw)
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
    fn upgrades_accept_repair_and_prerelease_transitions_but_refuse_downgrades() {
        assert!(super::validate_upgrade_version("1.0.9", "1.0.10").is_ok());
        assert!(super::validate_upgrade_version("1.0.10", "1.0.10").is_ok());
        assert!(super::validate_upgrade_version("1.0.10-beta.1", "1.0.10").is_ok());
        assert!(super::validate_upgrade_version("1.0.10", "1.0.10-beta.1").is_err());
        assert!(super::validate_upgrade_version("2.0.0", "1.0.10").is_err());
        assert!(super::validate_upgrade_version("invalid", "1.0.10").is_err());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires OPENBITFUN_PACKAGED_VERSION_FIXTURE pointing to a built desktop executable"]
    fn packaged_binary_version_prevents_unregistered_downgrades() {
        let executable = std::env::var_os("OPENBITFUN_PACKAGED_VERSION_FIXTURE")
            .expect("packaged executable fixture");
        let version = super::installed_binary_version(std::path::Path::new(&executable))
            .expect("built application must expose a semantic ProductVersion");
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
        assert!(super::validate_upgrade_version(&version, "0.0.0").is_err());
        assert!(super::validate_upgrade_version(&version, &version).is_ok());
    }

    #[test]
    fn path_validation_keeps_interrupted_roots_recoverable_before_the_main_binary_is_restored() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("OpenBitFun");
        std::fs::create_dir_all(root.join(super::transaction::WORK_DIR)).unwrap();
        std::fs::write(root.join("runtime.js"), "old runtime").unwrap();
        assert!(super::validate_install_path(root.to_string_lossy().into()).is_err());
        std::fs::write(
            root.join(super::transaction::WORK_DIR).join("journal.json"),
            "invalid journal retained for repair",
        )
        .unwrap();
        let validated = super::validate_install_path(root.to_string_lossy().into()).unwrap();
        assert_eq!(std::path::PathBuf::from(validated.install_path), root);
        assert!(super::Transaction::open(&root).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn legacy_update_flags_wait_for_the_previous_executable_to_exit() {
        use std::process::Stdio;
        let temp = tempfile::tempdir().unwrap();
        let ping = std::path::PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap())
            .join("System32/ping.exe");
        let target = temp.path().join(MAIN_APP_EXE);
        std::fs::copy(ping, &target).unwrap();
        let mut previous = super::create_windows_silent_command(&target)
            .args(["-n", "2", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        super::wait_for_legacy_update_parent(temp.path()).unwrap();
        assert!(
            previous.try_wait().unwrap().is_some(),
            "legacy handoff must not publish while the old executable is still running"
        );
    }

    #[cfg(windows)]
    #[test]
    fn update_handoff_waits_for_the_parent_and_aborts_when_the_supervisor_dies() {
        use std::{
            ffi::c_void,
            process::{Child, Stdio},
        };
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateEventW(
                attributes: *mut c_void,
                manual: i32,
                initial: i32,
                name: *const u16,
            ) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        struct Process(Child);
        impl Drop for Process {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        struct Event(*mut c_void);
        impl Drop for Event {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let ping = std::path::PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap())
            .join("System32/ping.exe");
        let fake_app = temp.path().join(MAIN_APP_EXE);
        std::fs::copy(&ping, &fake_app).unwrap();
        let spawn = |path: &std::path::Path| {
            Process(
                super::create_windows_silent_command(path)
                    .args(["-n", "30", "127.0.0.1"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            )
        };
        for parent_exits in [true, false] {
            let mut parent = spawn(&fake_app);
            let mut supervisor = spawn(&ping);
            let name = format!(
                "Local\\OpenBitFunUpdate-fixture-{}-{parent_exits}",
                std::process::id()
            );
            let wide = name
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let ready = Event(unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, wide.as_ptr()) });
            assert!(!ready.0.is_null());
            let args = vec![
                format!("/READY_EVENT={name}"),
                format!("/WAITPID={}", parent.0.id()),
                format!("/SUPERVISOR_PID={}", supervisor.0.id()),
            ];
            let root = temp.path().to_path_buf();
            let waiter = std::thread::spawn(move || super::wait_for_update_parent(&args, &root));
            assert_eq!(
                unsafe { WaitForSingleObject(ready.0, 10_000) },
                0,
                "native preflight must acknowledge readiness"
            );
            assert!(
                !waiter.is_finished(),
                "readiness must not authorize replacement before parent exit"
            );
            if parent_exits {
                parent.0.kill().unwrap();
                parent.0.wait().unwrap();
            } else {
                supervisor.0.kill().unwrap();
                supervisor.0.wait().unwrap();
            }
            let result = waiter.join().unwrap();
            assert_eq!(result.is_ok(), parent_exits, "{result:?}");
            if !parent_exits {
                assert!(parent.0.try_wait().unwrap().is_none());
            }
        }
    }

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
