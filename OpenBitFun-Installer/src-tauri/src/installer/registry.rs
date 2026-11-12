//! Windows Registry operations for the installer.
//!
//! Handles:
//! - Uninstall registry entries (Add/Remove Programs)
//! - Install location under `Software\{publisher}\{productName}` (matches Tauri NSIS `MANUPRODUCTKEY`)
//!
//! Must stay in sync with `src/apps/desktop/tauri.conf.json`: `bundle.publisher` + `productName`.
//! Main exe name must match `super::MAIN_APP_EXE` (same as Tauri NSIS).

use anyhow::{Context, Result};
use std::path::Path;
use winreg::enums::*;
use winreg::RegKey;

use super::MAIN_APP_EXE;

const APP_NAME: &str = "OpenBitFun";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenBitFun";

/// Matches Tauri NSIS `MANUFACTURER` (`bundle.publisher`).
const TAURI_MANUFACTURER: &str = "OpenBitFun Team";
/// Matches Tauri NSIS `PRODUCTNAME` (`productName`).
const TAURI_PRODUCT_NAME: &str = "OpenBitFun";

/// `HKCU\Software\{TAURI_MANUFACTURER}\{TAURI_PRODUCT_NAME}` — same as Tauri `MANUPRODUCTKEY`.
fn tauri_manufacturer_product_key() -> String {
    format!(r"Software\{}\{}", TAURI_MANUFACTURER, TAURI_PRODUCT_NAME)
}

fn quote_windows_path(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

fn normalize_registry_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(trimmed)
        .trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

/// Register the application in Add/Remove Programs.
pub(super) fn register_uninstall_entry(
    install_path: &Path,
    version: &str,
    uninstall_command: &str,
) -> Result<()> {
    let hkcu = root_for(install_path);
    ensure_registration_owner(&hkcu, install_path)?;
    let (key, _) = hkcu
        .create_subkey(UNINSTALL_KEY)
        .with_context(|| "Failed to create uninstall registry key")?;

    let exe_path = install_path.join(MAIN_APP_EXE);

    // Establish ownership before optional metadata so interrupted first-time
    // registration remains recognizable during journal recovery.
    key.set_value("InstallLocation", &quote_windows_path(install_path))?;
    key.set_value("DisplayName", &APP_NAME)?;
    key.set_value("DisplayVersion", &version)?;
    key.set_value("Publisher", &TAURI_MANUFACTURER)?;
    key.set_value("MainBinaryName", &MAIN_APP_EXE)?;
    key.set_value("DisplayIcon", &quote_windows_path(&exe_path))?;
    key.set_value("UninstallString", &uninstall_command)?;
    key.set_value(
        "QuietUninstallString",
        &format!("{uninstall_command} --quiet"),
    )?;
    key.set_value("NoModify", &1u32)?;
    key.set_value("NoRepair", &1u32)?;

    log::info!("Registered uninstall entry at {}", UNINSTALL_KEY);
    Ok(())
}

/// Same as Tauri NSIS `WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR` — used for default install dir / upgrades.
pub(super) fn register_tauri_install_location(install_path: &Path) -> Result<()> {
    let hkcu = root_for(install_path);
    ensure_registration_owner(&hkcu, install_path)?;
    let path = tauri_manufacturer_product_key();
    let (key, _) = hkcu
        .create_subkey(&path)
        .with_context(|| format!("Failed to create registry key {}", path))?;
    let dir = install_path.to_string_lossy();
    key.set_value("", &dir.as_ref())?;
    log::info!("Registered Tauri install location at {}", path);
    Ok(())
}

/// Read install dir written by Tauri NSIS or this installer (`MANUPRODUCTKEY` default value).
pub(super) fn read_tauri_install_location() -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = tauri_manufacturer_product_key();
    let key = hkcu.open_subkey(&path).ok()?;
    let s: String = key.get_value("").ok()?;
    normalize_registry_path(&s)
}

/// Remove only keys that still point to the selected installation.
pub(super) fn remove_tauri_install_location(install_path: &Path) -> Result<()> {
    remove_owned_key(install_path, &tauri_manufacturer_product_key(), "")
}
pub(super) fn remove_uninstall_entry(install_path: &Path) -> Result<()> {
    remove_owned_key(install_path, UNINSTALL_KEY, "InstallLocation")
}
fn remove_owned_key(install_path: &Path, path: &str, value: &str) -> Result<()> {
    let root = root_for(install_path);
    delete_owned_key(&root, install_path, path, value)
}

fn delete_owned_key(root: &RegKey, install_path: &Path, path: &str, value: &str) -> Result<()> {
    match root.open_subkey(path) {
        Ok(key) => {
            let existing: String = key.get_value(value)?;
            if path_matches(&existing, install_path) {
                root.delete_subkey_all(path)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
pub(super) fn remove_autostart_run_entry(install_path: &Path) -> Result<()> {
    let root = maintenance_user_root()?;
    let key = match root.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_READ | KEY_WRITE,
    ) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    match key.get_value::<String, _>(APP_NAME) {
        Ok(value) => {
            if command_targets(&value, install_path) {
                key.delete_value(APP_NAME)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
pub(super) fn is_machine_install(path: &Path) -> bool {
    !read_uninstall_key(RegKey::predef(HKEY_CURRENT_USER), "hkcu")
        .is_some_and(|v| path_matches(&v.install_location, path))
        && (read_uninstall_key(RegKey::predef(HKEY_LOCAL_MACHINE), "hklm")
            .is_some_and(|v| path_matches(&v.install_location, path))
            || std::fs::read(path.join(super::transaction::INVENTORY))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|value| {
                    value.get("allUsers").and_then(serde_json::Value::as_bool) == Some(true)
                })
            // The inventory and registration may already be backed up when an
            // interrupted machine uninstall re-enters maintenance.
            || std::fs::read(path.join(super::transaction::WORK_DIR).join("journal.json"))
                .ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|value| value.get("schema").and_then(serde_json::Value::as_u64) == Some(1)
                    && value.pointer("/integrations/registry/machine").and_then(serde_json::Value::as_bool) == Some(true)))
}

pub(super) fn validate_scope(path: &Path, all_users: bool) -> Result<()> {
    if all_users
        && read_uninstall_key(RegKey::predef(HKEY_CURRENT_USER), "hkcu")
            .is_some_and(|value| path_matches(&value.install_location, path))
    {
        anyhow::bail!("This directory is a current-user installation; retain its scope or uninstall before changing scope");
    }
    Ok(())
}

pub(super) fn installed_version(path: &Path) -> Option<String> {
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(|hive| read_uninstall_key(RegKey::predef(hive), "registry"))
        .find(|value| path_matches(&value.install_location, path))
        .and_then(|value| value.display_version)
}
fn root_for(path: &Path) -> RegKey {
    RegKey::predef(if is_machine_install(path) {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    })
}
fn path_matches(value: &str, path: &Path) -> bool {
    normalize_registry_path(value)
        .is_some_and(|v| super::commands::windows_path_eq_case_insensitive(Path::new(&v), path))
}
fn command_targets(value: &str, path: &Path) -> bool {
    let value = value.trim();
    let program = if let Some(v) = value.strip_prefix('"') {
        v.split('"').next().unwrap_or("")
    } else {
        value.split_whitespace().next().unwrap_or("")
    };
    path_matches(program, &path.join(MAIN_APP_EXE))
}
fn ensure_registration_owner(root: &RegKey, path: &Path) -> Result<()> {
    for (name, value) in [
        (UNINSTALL_KEY.to_string(), "InstallLocation"),
        (tauri_manufacturer_product_key(), ""),
    ] {
        match root.open_subkey(name) {
            Ok(key) => {
                let existing: String = key.get_value(value).context(
                    "Cannot establish existing installation ownership; registry data was preserved",
                )?;
                anyhow::ensure!(path_matches(&existing, path), "An installation is registered at {existing}; select that directory to update or uninstall it first");
                // Older desktop builds rewrote the manufacturer location even
                // in development. The owned uninstall record is authoritative;
                // a successful maintenance transaction repairs that stale hint.
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct Snapshot {
    machine: bool,
    keys: Vec<Option<Vec<(String, u32, Vec<u8>)>>>,
    #[serde(default)]
    user_sid: Option<String>,
    #[serde(default)]
    user_values: Vec<(String, String, Option<(u32, Vec<u8>)>)>,
    #[serde(default)]
    context_keys: Vec<(String, Vec<(String, Vec<(String, u32, Vec<u8>)>)>)>,
}

const CONTEXT_KEYS: [&str; 2] = [
    r"Software\Classes\Directory\Background\shell\OpenBitFun",
    r"Software\Classes\Directory\shell\OpenBitFun",
];

fn maintenance_user_sid() -> Result<String> {
    let sid = std::env::args()
        .find_map(|arg| arg.strip_prefix("/OWNER_SID=").map(str::to_string))
        .map(Ok)
        .unwrap_or_else(super::elevation::owner_sid)
        .map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        sid.starts_with("S-1-")
            && sid
                .bytes()
                .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-'),
        "Invalid maintenance user SID"
    );
    Ok(sid)
}

fn user_root(sid: &str) -> Result<RegKey> {
    Ok(RegKey::predef(HKEY_USERS).open_subkey_with_flags(sid, KEY_READ | KEY_WRITE)?)
}

fn maintenance_user_root() -> Result<RegKey> {
    user_root(&maintenance_user_sid()?)
}

fn snapshot_tree(
    key: &RegKey,
    relative: &str,
    values: &mut Vec<(String, Vec<(String, u32, Vec<u8>)>)>,
) -> Result<()> {
    values.push((
        relative.into(),
        key.enum_values()
            .map(|v| v.map(|(n, v)| (n, v.vtype as u32, v.bytes)))
            .collect::<std::io::Result<_>>()?,
    ));
    for child in key.enum_keys() {
        let child = child?;
        let path = if relative.is_empty() {
            child.clone()
        } else {
            format!(r"{relative}\{child}")
        };
        snapshot_tree(&key.open_subkey(&child)?, &path, values)?;
    }
    Ok(())
}

fn raw_value(kind: u32, bytes: &[u8]) -> Result<winreg::RegValue> {
    let vtype = match kind {
        0 => REG_NONE,
        1 => REG_SZ,
        2 => REG_EXPAND_SZ,
        3 => REG_BINARY,
        4 => REG_DWORD,
        5 => REG_DWORD_BIG_ENDIAN,
        6 => REG_LINK,
        7 => REG_MULTI_SZ,
        8 => REG_RESOURCE_LIST,
        9 => REG_FULL_RESOURCE_DESCRIPTOR,
        10 => REG_RESOURCE_REQUIREMENTS_LIST,
        11 => REG_QWORD,
        _ => anyhow::bail!("Unsupported registry recovery value type"),
    };
    Ok(winreg::RegValue {
        vtype,
        bytes: bytes.to_vec(),
    })
}

pub(super) fn snapshot(path: &Path, machine: bool) -> Result<Snapshot> {
    let install_path = path;
    let root = RegKey::predef(if machine {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    });
    ensure_registration_owner(&root, path)?;
    let mut keys = Vec::new();
    for name in [UNINSTALL_KEY.to_string(), tauri_manufacturer_product_key()] {
        keys.push(match root.open_subkey(name) {
            Ok(key) => Some(
                key.enum_values()
                    .map(|item| item.map(|(name, value)| (name, value.vtype as u32, value.bytes)))
                    .collect::<std::io::Result<Vec<_>>>()?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        });
    }
    let sid = maintenance_user_sid()?;
    let user = user_root(&sid)?;
    let mut user_values = Vec::new();
    for (path, name) in [
        ("Environment", "Path"),
        (r"Software\Microsoft\Windows\CurrentVersion\Run", APP_NAME),
    ] {
        let value = match user
            .open_subkey(path)
            .and_then(|key| key.get_raw_value(name))
        {
            Ok(value) => Some((value.vtype as u32, value.bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        if let Some((kind, bytes)) = &value {
            use winreg::types::FromRegValue;
            let text = String::from_reg_value(&raw_value(*kind, bytes)?)?;
            let owned = if name == "Path" {
                text.split(';').any(|part| path_matches(part, install_path))
            } else {
                command_targets(&text, install_path)
            };
            if owned {
                user_values.push((path.into(), name.into(), value));
            }
        }
    }
    let mut context_keys = Vec::new();
    for path in CONTEXT_KEYS {
        match user.open_subkey(path) {
            Ok(key) => {
                let command = key.open_subkey("command")?.get_value::<String, _>("")?;
                if !command_targets(&command, install_path) {
                    continue;
                }
                let mut tree = Vec::new();
                snapshot_tree(&key, "", &mut tree)?;
                context_keys.push((path.into(), tree));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(Snapshot {
        machine,
        keys,
        user_sid: Some(sid),
        user_values,
        context_keys,
    })
}

pub(super) fn restore(install_path: &Path, snapshot: &Snapshot) -> Result<()> {
    anyhow::ensure!(
        snapshot.keys.len() == 2,
        "Invalid registry recovery snapshot"
    );
    let root = RegKey::predef(if snapshot.machine {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    });
    for ((path, name), original) in [
        (UNINSTALL_KEY.to_string(), "InstallLocation"),
        (tauri_manufacturer_product_key(), ""),
    ]
    .into_iter()
    .zip(&snapshot.keys)
    {
        match root.open_subkey(&path) {
            Ok(key) => match key.get_value::<String, _>(name) {
                Ok(value) => anyhow::ensure!(
                    path_matches(&value, install_path)
                        || original.as_ref().is_some_and(|values| {
                            values.iter().find(|(key, _, _)| key == name).is_some_and(
                                |(_, kind, bytes)| {
                                    use winreg::types::FromRegValue;
                                    raw_value(*kind, bytes)
                                        .ok()
                                        .and_then(|value| String::from_reg_value(&value).ok())
                                        .is_some_and(|previous| previous == value)
                                },
                            )
                        }),
                    "Registration changed during maintenance; recovery data retained"
                ),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && original.is_none()
                        && key.enum_values().next().is_none() => {}
                Err(error) => return Err(error.into()),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    for (path, values) in [UNINSTALL_KEY.to_string(), tauri_manufacturer_product_key()]
        .iter()
        .zip(&snapshot.keys)
    {
        if let Some(values) = values {
            let (key, _) = root.create_subkey(path)?;
            let names = key
                .enum_values()
                .map(|v| v.map(|(n, _)| n))
                .collect::<std::io::Result<Vec<_>>>()?;
            for name in names {
                key.delete_value(name)?;
            }
            for (name, kind, bytes) in values {
                let vtype = match kind {
                    0 => REG_NONE,
                    1 => REG_SZ,
                    2 => REG_EXPAND_SZ,
                    3 => REG_BINARY,
                    4 => REG_DWORD,
                    5 => REG_DWORD_BIG_ENDIAN,
                    6 => REG_LINK,
                    7 => REG_MULTI_SZ,
                    8 => REG_RESOURCE_LIST,
                    9 => REG_FULL_RESOURCE_DESCRIPTOR,
                    10 => REG_RESOURCE_REQUIREMENTS_LIST,
                    11 => REG_QWORD,
                    _ => anyhow::bail!("Unsupported registry recovery value type"),
                };
                key.set_raw_value(
                    name,
                    &winreg::RegValue {
                        bytes: bytes.clone(),
                        vtype,
                    },
                )?;
            }
        } else {
            match root.delete_subkey_all(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    if let Some(sid) = &snapshot.user_sid {
        anyhow::ensure!(
            sid == &maintenance_user_sid()?,
            "Registry recovery belongs to another user"
        );
        let user = user_root(sid)?;
        for (path, name, value) in &snapshot.user_values {
            anyhow::ensure!(
                (path == "Environment" && name == "Path")
                    || (path == r"Software\Microsoft\Windows\CurrentVersion\Run"
                        && name == APP_NAME),
                "Invalid user registry recovery path"
            );
            if let Some((kind, bytes)) = value {
                use winreg::types::FromRegValue;
                let (key, _) = user.create_subkey(path)?;
                let original = raw_value(*kind, bytes)?;
                let current = match key.get_raw_value(name) {
                    Ok(value) => Some(value),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error.into()),
                };
                if let Some(current) = current {
                    if current.bytes == original.bytes && current.vtype == original.vtype {
                        continue;
                    }
                    anyhow::ensure!(
                        name == "Path",
                        "Autostart changed during maintenance; recovery data retained"
                    );
                    let previous = String::from_reg_value(&original)?;
                    let present = String::from_reg_value(&current)?;
                    let merged = merge_owned_path(&previous, &present, install_path);
                    let bytes = merged
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .flat_map(u16::to_le_bytes)
                        .collect();
                    key.set_raw_value(
                        name,
                        &winreg::RegValue {
                            bytes,
                            vtype: current.vtype,
                        },
                    )?;
                } else {
                    key.set_raw_value(name, &original)?;
                }
            }
        }
        for (path, tree) in &snapshot.context_keys {
            anyhow::ensure!(
                CONTEXT_KEYS.contains(&path.as_str()),
                "Invalid context-menu recovery path"
            );
            if let Ok(key) = user.open_subkey(format!(r"{path}\command")) {
                let value: String = key.get_value("")?;
                anyhow::ensure!(
                    command_targets(&value, install_path),
                    "Context menu changed during maintenance; recovery data retained"
                );
            }
            for (relative, values) in tree {
                anyhow::ensure!(
                    !relative.split('\\').any(|part| part == ".." || part == ".")
                        && !relative.starts_with('\\'),
                    "Invalid context-menu recovery subkey"
                );
                let (key, _) = user.create_subkey(if relative.is_empty() {
                    path.clone()
                } else {
                    format!(r"{path}\{relative}")
                })?;
                for (name, kind, bytes) in values {
                    key.set_raw_value(name, &raw_value(*kind, bytes)?)?;
                }
            }
        }
    }
    Ok(())
}

fn merge_owned_path(previous: &str, present: &str, install_path: &Path) -> String {
    let mut merged = present.to_string();
    if !present
        .split(';')
        .any(|part| path_matches(part, install_path))
    {
        if let Some(owned) = previous
            .split(';')
            .find(|part| path_matches(part, install_path))
        {
            if !merged.is_empty() && !merged.ends_with(';') {
                merged.push(';');
            }
            merged.push_str(owned);
        }
    }
    merged
}

#[cfg(test)]
mod maintenance_tests {
    use super::*;
    #[test]
    fn path_recovery_preserves_concurrent_changes_and_is_idempotent() {
        let root = Path::new(r"C:\OpenBitFun");
        let recovered = merge_owned_path(r"C:\old;C:\OpenBitFun", r"C:\new;C:\other", root);
        assert_eq!(recovered, r"C:\new;C:\other;C:\OpenBitFun");
        assert_eq!(
            merge_owned_path(r"C:\old;C:\OpenBitFun", &recovered, root),
            recovered
        );
    }
    #[test]
    fn registry_removal_requires_exact_installation_ownership() {
        let name = format!(
            r"Software\OpenBitFunMaintenanceTests\{}",
            std::process::id()
        );
        let parent = RegKey::predef(HKEY_CURRENT_USER);
        let (fixture, _) = parent.create_subkey(&name).unwrap();
        let (key, _) = fixture.create_subkey("Install").unwrap();
        key.set_value("InstallLocation", &r"C:\other").unwrap();
        drop(key);
        delete_owned_key(
            &fixture,
            Path::new(r"C:\ours"),
            "Install",
            "InstallLocation",
        )
        .unwrap();
        assert!(fixture.open_subkey("Install").is_ok());
        delete_owned_key(
            &fixture,
            Path::new(r"C:\other"),
            "Install",
            "InstallLocation",
        )
        .unwrap();
        assert!(fixture.open_subkey("Install").is_err());
        drop(fixture);
        parent.delete_subkey_all(&name).unwrap();
    }
}

/// Data read from `Uninstall\OpenBitFun` (Tauri NSIS / this installer).
#[derive(Debug, Clone)]
pub(super) struct UninstallRegistryData {
    pub install_location: String,
    pub display_version: Option<String>,
    pub uninstall_string: Option<String>,
    pub hive: &'static str,
}

fn read_uninstall_key(root: RegKey, hive_name: &'static str) -> Option<UninstallRegistryData> {
    let key = root.open_subkey(UNINSTALL_KEY).ok()?;
    let install_location: String = key.get_value("InstallLocation").ok()?;
    let display_version: Option<String> = key.get_value("DisplayVersion").ok();
    let uninstall_string: Option<String> = key.get_value("UninstallString").ok();
    Some(UninstallRegistryData {
        install_location: normalize_registry_path(&install_location)?,
        display_version,
        uninstall_string,
        hive: hive_name,
    })
}

/// Detect existing install like NSIS `ReadRegStr` on `UNINSTKEY` (HKCU then HKLM).
pub(super) fn read_existing_install_from_uninstall_registry() -> Option<UninstallRegistryData> {
    read_uninstall_key(RegKey::predef(HKEY_CURRENT_USER), "hkcu")
        .or_else(|| read_uninstall_key(RegKey::predef(HKEY_LOCAL_MACHINE), "hklm"))
}

/// Remove OpenBitFun context menu entries (no longer registered on install).
pub(super) fn remove_context_menu(install_path: &Path) -> Result<()> {
    let hkcu = maintenance_user_root()?;
    for path in CONTEXT_KEYS {
        match hkcu.open_subkey(format!("{path}\\command")) {
            Ok(key) => {
                let value = key.get_value::<String, _>("")?;
                if command_targets(&value, install_path) {
                    hkcu.delete_subkey_all(path)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// Remove the install path from the user's PATH environment variable.
pub(super) fn remove_from_path(install_path: &Path) -> Result<()> {
    let hkcu = maintenance_user_root()?;
    let env_key = match hkcu.open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE) {
        Ok(key) => key,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    let raw = match env_key.get_raw_value("Path") {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let current_path: String = env_key.get_value("Path")?;
    let install_dir = install_path.to_string_lossy();

    let new_path: String = current_path
        .split(';')
        .filter(|p| !path_matches(p.trim(), Path::new(install_dir.as_ref())))
        .collect::<Vec<_>>()
        .join(";");

    if new_path != current_path {
        let bytes = new_path
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        env_key.set_raw_value(
            "Path",
            &winreg::RegValue {
                bytes,
                vtype: raw.vtype,
            },
        )?;
    }
    Ok(())
}
