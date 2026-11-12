//! A one-shot native maintenance launch. The interactive installer stays under
//! the original user's token, including when a machine install uses another admin.
use std::{ffi::c_void, path::Path};

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
    fn GetTokenInformation(
        token: *mut c_void,
        class: u32,
        information: *mut c_void,
        size: u32,
        required: *mut u32,
    ) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
    fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
}

pub(super) fn is_elevated() -> bool {
    let mut token = std::ptr::null_mut();
    let mut elevated = 0_u32;
    let mut required = 0;
    unsafe {
        if OpenProcessToken(-1_isize as *mut c_void, 8, &mut token) == 0 {
            return false;
        }
        let ok = GetTokenInformation(
            token,
            20,
            &mut elevated as *mut u32 as *mut c_void,
            4,
            &mut required,
        );
        CloseHandle(token);
        ok != 0 && elevated != 0
    }
}

pub(super) fn owner_sid() -> Result<String, String> {
    let output = super::commands::create_windows_silent_command(
        super::commands::windows_system_directory()?.join("whoami.exe"),
    )
    .args(["/user", "/fo", "csv", "/nh"])
    .output()
    .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        return Err("Cannot identify the maintenance owner".into());
    }
    text.split([',', '"', '\r', '\n'])
        .find(|part| part.starts_with("S-1-"))
        .map(str::to_string)
        .ok_or_else(|| "Cannot identify the maintenance owner".into())
}

fn quote(arg: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            slashes * if c == '"' { 2 } else { 1 },
        ));
        slashes = 0;
        if c == '"' {
            result.push('\\');
        }
        result.push(c);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

pub(super) fn run(executable: &Path, args: &[String]) -> Result<u32, String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }
    struct Com(bool);
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }
    let status = unsafe { CoInitializeEx(std::ptr::null_mut(), 2 | 4) };
    if status < 0 && status != -2147417850 {
        return Err(format!(
            "Cannot initialize maintenance authorization ({status:#x})"
        ));
    }
    let _com = Com(status >= 0);
    #[repr(C)]
    struct ExecuteInfo {
        size: u32,
        mask: u32,
        window: *mut c_void,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: *mut c_void,
        id_list: *mut c_void,
        class: *const u16,
        class_key: *mut c_void,
        hot_key: u32,
        icon: *mut c_void,
        process: *mut c_void,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ExecuteInfo) -> i32;
    }
    let file = executable
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let verb = "runas"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result_id = format!(
        "{:x}{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let mut arguments = vec![format!("/RESULT_ID={result_id}")];
    arguments.extend_from_slice(args);
    let parameters = arguments
        .iter()
        .map(|arg| quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut info: ExecuteInfo = unsafe { std::mem::zeroed() };
    info.size = std::mem::size_of::<ExecuteInfo>() as u32;
    info.mask = 0x40 | 0x100;
    info.verb = verb.as_ptr();
    info.file = file.as_ptr();
    info.parameters = parameters.as_ptr();
    info.show = 0;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        let error = std::io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(1223) {
            "Administrator authorization was canceled; no files were changed".into()
        } else {
            format!("Cannot start elevated maintenance: {error}")
        });
    }
    if info.process.is_null() {
        return Err("Maintenance did not return a process handle".into());
    }
    let mut code = 1;
    unsafe {
        let waited = WaitForSingleObject(info.process, u32::MAX);
        let received = GetExitCodeProcess(info.process, &mut code);
        CloseHandle(info.process);
        if waited != 0 || received == 0 {
            return Err(
                "Maintenance result is unknown; check the installation before retrying".into(),
            );
        }
    }
    if code != 0 && code != 2 {
        if let Ok(path) = native_result_path(&result_id, true) {
            if let Some(error) = read_native_error(&path, code) {
                return Err(error);
            }
        }
    }
    Ok(code)
}

fn native_result_path(id: &str, machine: bool) -> Result<std::path::PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid native maintenance result identifier".into());
    }
    let base = std::env::var_os(if machine {
        "PROGRAMDATA"
    } else {
        "LOCALAPPDATA"
    })
    .ok_or("Maintenance result directory is unavailable")?;
    Ok(std::path::PathBuf::from(base)
        .join(openbitfun_core_types::product_identity::data_namespace())
        .join("maintenance/results")
        .join(format!("{id}.json")))
}

fn read_native_error(path: &Path, code: u32) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value.get("exitCode")?.as_u64()? != u64::from(code) {
        return None;
    }
    value.get("error")?.as_str().map(str::to_owned)
}

pub(super) fn persist_native_outcome(code: u32, error: Option<&str>) {
    let Some(id) =
        std::env::args().find_map(|arg| arg.strip_prefix("/RESULT_ID=").map(str::to_owned))
    else {
        return;
    };
    let write = || -> Result<(), String> {
        use std::io::Write;
        let path = native_result_path(&id, is_elevated())?;
        let parent = path
            .parent()
            .ok_or("Maintenance result parent is unavailable")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temporary
            .write_all(
                &serde_json::to_vec(&serde_json::json!({"exitCode":code,"error":error}))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(path).map_err(|e| e.to_string())?;
        Ok(())
    };
    if let Err(error) = write() {
        eprintln!("Cannot persist native maintenance result: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_errors_require_a_matching_exit_code_and_safe_operation_id() {
        for id in ["", "../outside", "C:\\Windows", "not-hex"] {
            assert!(native_result_path(id, true).is_err());
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("result.json");
        std::fs::write(
            &path,
            br#"{"exitCode":1,"error":"Cannot back up a locked file; previous files restored"}"#,
        )
        .unwrap();
        assert!(read_native_error(&path, 1).unwrap().contains("locked file"));
        assert!(read_native_error(&path, 2).is_none());
        std::fs::write(&path, b"unreadable").unwrap();
        assert!(read_native_error(&path, 1).is_none());
        assert_eq!(std::fs::read(&path).unwrap(), b"unreadable");
    }
    #[test]
    fn quotes_paths_and_arguments_without_command_line_injection() {
        let values = [
            r"C:\Program Files\OpenBitFun",
            "a\"b",
            "trailing\\",
            "",
            "中文目录",
        ];
        let command = format!(
            "program.exe {}",
            values
                .iter()
                .map(|arg| quote(arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        assert_eq!(
            &super::super::commands::parse_windows_command_line(&command).unwrap()[1..],
            values
        );
    }
}
