//! Remove only system entries proven to belong to this product's launch records.
//! Runtime bundles, launch identities, app data and active leases are left intact.
use super::launcher::{read_record, LaunchRecord};
use std::path::{Path, PathBuf};

pub(super) fn applications_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    return dirs::home_dir()
        .map(|root| root.join("Applications/OpenBitFun Apps"))
        .ok_or_else(|| "Home directory unavailable".into());
    #[cfg(target_os = "windows")]
    return dirs::data_dir()
        .map(|root| root.join("Microsoft/Windows/Start Menu/Programs/OpenBitFun Apps"))
        .ok_or_else(|| "Application directory unavailable".into());
    #[cfg(target_os = "linux")]
    return dirs::data_dir()
        .map(|root| root.join("applications"))
        .ok_or_else(|| "Application directory unavailable".into());
    #[allow(unreachable_code)]
    Err("System MiniApp launchers are unsupported on this platform".into())
}

fn records(data_dir: &Path, app_id: &str) -> Result<Vec<LaunchRecord>, String> {
    let root = data_dir.join("miniapp-desktop/launchers");
    if !root.try_exists().map_err(|e| e.to_string())? {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path().join("launch.json");
        if !path.is_file() {
            continue;
        }
        let record = read_record(&path)?;
        if record.app_id == app_id && record.data_dir == data_dir {
            records.push(record);
        }
    }
    Ok(records)
}

fn installed_in(applications: &Path, records: &[LaunchRecord]) -> Result<Vec<PathBuf>, String> {
    if !applications.try_exists().map_err(|e| e.to_string())? {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(applications).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // Never follow a link placed in the application menu to another location.
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            continue;
        }
        let path = entry.path();
        if records.iter().any(|record| owns(&path, record)) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

pub(super) fn status(data_dir: &Path, app_id: &str) -> Result<Vec<PathBuf>, String> {
    installed_in(&applications_directory()?, &records(data_dir, app_id)?)
}

pub(super) fn uninstall(data_dir: &Path, app_id: &str) -> Result<(), String> {
    uninstall_in(&applications_directory()?, &records(data_dir, app_id)?)
}

fn uninstall_in(applications: &Path, records: &[LaunchRecord]) -> Result<(), String> {
    for path in installed_in(applications, records)? {
        // Recheck ownership immediately before deleting; filenames are not identity.
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() || !records.iter().any(|record| owns(&path, record)) {
            return Err("System app ownership changed; the entry was left untouched".into());
        }
        if metadata.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        }
        .map_err(|e| format!("Could not uninstall system app {}: {e}", path.display()))?;
    }
    Ok(())
}

fn owns(path: &Path, record: &LaunchRecord) -> bool {
    #[cfg(target_os = "macos")]
    return path.extension().is_some_and(|ext| ext == "app")
        && read_record(&path.join("Contents/Resources/openbitfun-miniapp.json")).is_ok_and(
            |embedded| {
                embedded.launch_id == record.launch_id
                    && embedded.app_id == record.app_id
                    && embedded.data_dir == record.data_dir
            },
        );
    #[cfg(target_os = "linux")]
    return path.file_name().is_some_and(|name| {
        name == format!("com.openbitfun.miniapp.{}.desktop", record.launch_id).as_str()
    }) && std::fs::read_to_string(path).is_ok_and(|text| linux_entry_owned(&text, record));
    #[cfg(target_os = "windows")]
    return path.extension().is_some_and(|ext| ext == "lnk") && windows_link_owned(path, record);
    #[allow(unreachable_code)]
    false
}

#[cfg(any(target_os = "linux", test))]
fn linux_entry_owned(text: &str, record: &LaunchRecord) -> bool {
    use super::launcher::{desktop_exec_arg, desktop_value};
    let manifest = openbitfun_miniapp_ipc::launcher::launch_path(record);
    let candidates = [
        record.host_executable.clone(),
        record
            .host_executable
            .with_file_name("openbitfun-miniapp-shell"),
    ];
    candidates.iter().any(|binary| {
        let Ok(binary) = desktop_exec_arg(binary) else {
            return false;
        };
        let Ok(manifest) = desktop_exec_arg(&manifest) else {
            return false;
        };
        let expected = format!(
            "Exec={}",
            desktop_value(&format!("{binary} --miniapp-launch {manifest}"))
        );
        text.lines().any(|line| line == expected)
    })
}

#[cfg(target_os = "windows")]
fn windows_link_owned(path: &Path, record: &LaunchRecord) -> bool {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    // SAFETY: COM and its interfaces stay on this blocking thread and all borrowed
    // buffers outlive their calls. A failed initialization cannot acquire ownership.
    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return false;
        }
        let result = (|| -> windows::core::Result<bool> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let persist: IPersistFile = link.cast()?;
            persist.Load(&HSTRING::from(path.as_os_str()), STGM_READ)?;
            let mut buffer = vec![0u16; 32768];
            link.GetArguments(&mut buffer)?;
            let end = buffer
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(buffer.len());
            Ok(String::from_utf16_lossy(&buffer[..end])
                == format!(
                    "--miniapp-launch \"{}\"",
                    openbitfun_miniapp_ipc::launcher::launch_path(record).display()
                ))
        })();
        CoUninitialize();
        result.unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &Path) -> LaunchRecord {
        LaunchRecord {
            protocol_version: 1,
            launch_id: uuid::Uuid::new_v4().to_string(),
            app_id: "notes".into(),
            workspace_path: None,
            data_dir: root.join("data"),
            user_root: root.to_path_buf(),
            host_executable: root.join("OpenBitFun"),
            name: "Notes".into(),
            extra: Default::default(),
        }
    }

    #[test]
    fn linux_ownership_accepts_legacy_and_shell_entries_but_not_other_apps() {
        let root = tempfile::tempdir().unwrap();
        let record = fixture(root.path());
        let manifest = openbitfun_miniapp_ipc::launcher::launch_path(&record);
        for binary in [
            record.host_executable.clone(),
            record
                .host_executable
                .with_file_name("openbitfun-miniapp-shell"),
        ] {
            let text = format!(
                "[Desktop Entry]\nExec={}\n",
                super::super::launcher::desktop_value(&format!(
                    "{} --miniapp-launch {}",
                    super::super::launcher::desktop_exec_arg(&binary).unwrap(),
                    super::super::launcher::desktop_exec_arg(&manifest).unwrap()
                ))
            );
            assert!(linux_entry_owned(&text, &record));
            assert!(!linux_entry_owned(&text, &fixture(root.path())));
        }
        assert!(!linux_entry_owned(
            "[Desktop Entry]\nExec=unrelated\n",
            &record
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn uninstall_removes_only_owned_exports_and_preserves_runtime_and_data() {
        let root = tempfile::tempdir().unwrap();
        let record = fixture(root.path());
        let manifest = super::super::launcher::write_record(&record).unwrap();
        let runtime = manifest.parent().unwrap().join("runtime/Notes.app");
        std::fs::create_dir_all(&runtime).unwrap();
        let saved = record.data_dir.join("storage.json");
        std::fs::write(&saved, r#"{"note":"keep"}"#).unwrap();
        let applications = root.path().join("Applications");
        let owned = applications.join(format!("Notes — {}.app", &record.launch_id[..8]));
        let another = applications.join("Notes.app");
        for (path, identity) in [(&owned, record.clone()), (&another, fixture(root.path()))] {
            std::fs::create_dir_all(path.join("Contents/Resources")).unwrap();
            ipc_record(path, &identity);
        }
        // A symlink to an external bundle must not be treated as an owned export.
        let external = root.path().join("External.app");
        std::fs::create_dir_all(external.join("Contents/Resources")).unwrap();
        ipc_record(&external, &record);
        std::os::unix::fs::symlink(&external, applications.join("Linked.app")).unwrap();
        let records = records(&record.data_dir, &record.app_id).unwrap();
        assert_eq!(
            installed_in(&applications, &records).unwrap(),
            vec![owned.clone()]
        );
        uninstall_in(&applications, &records).unwrap();
        uninstall_in(&applications, &records).unwrap();
        assert!(!owned.exists());
        assert!(another.exists() && external.exists() && runtime.exists() && manifest.exists());
        assert_eq!(
            std::fs::read_to_string(saved).unwrap(),
            r#"{"note":"keep"}"#
        );
        assert!(installed_in(&applications, &records).unwrap().is_empty());
    }

    #[cfg(target_os = "macos")]
    fn ipc_record(bundle: &Path, record: &LaunchRecord) {
        super::super::ipc::private_json(
            &bundle.join("Contents/Resources/openbitfun-miniapp.json"),
            record,
        )
        .unwrap();
    }
}
