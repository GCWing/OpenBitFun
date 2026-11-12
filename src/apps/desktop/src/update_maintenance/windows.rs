use base64::Engine;
use openbitfun_services_core::process_manager::create_command;
use std::{
    ffi::OsStr,
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const PROTOCOL: &[u8] = b"OPENBITFUN_MAINTENANCE_V1";

fn system_directory() -> io::Result<PathBuf> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0; 32768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(std::ffi::OsString::from_wide(&buffer[..length as usize]).into())
}

struct Package {
    stage: tempfile::TempDir,
    path: PathBuf,
    native: bool,
    msi: bool,
}

fn stage_package(bytes: &[u8]) -> io::Result<Package> {
    let mut extracted = Vec::new();
    let contents = if bytes.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(io::Cursor::new(bytes))?;
        let mut found = false;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            let installer = Path::new(entry.name())
                .extension()
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("msi")
                });
            if !entry.is_dir() && installer {
                if found {
                    return Err(io::Error::other(
                        "Update archive contains multiple installers",
                    ));
                }
                entry.read_to_end(&mut extracted)?;
                found = true;
            }
        }
        if !found {
            return Err(io::Error::other(
                "Update archive contains no Windows installer",
            ));
        }
        &extracted
    } else {
        bytes
    };
    let msi = contents.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    if !msi && !contents.starts_with(b"MZ") {
        return Err(io::Error::other(
            "Update package is not a Windows installer",
        ));
    }
    let native = !msi
        && contents
            .windows(PROTOCOL.len())
            .any(|window| window == PROTOCOL);
    let stage = tempfile::Builder::new()
        .prefix("openbitfun-update-")
        .tempdir()?;
    let path = stage.path().join(if msi {
        "installer.msi"
    } else {
        "installer.exe"
    });
    let mut file = fs::File::create(&path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(Package {
        stage,
        path,
        native,
        msi,
    })
}

pub(super) fn install(
    app: &AppHandle,
    bytes: &[u8],
    version: &str,
    receipt: &Path,
) -> io::Result<()> {
    let package = stage_package(bytes)?;
    let current = std::env::current_exe()?;
    let target = current
        .parent()
        .ok_or_else(|| io::Error::other("Installation path is unavailable"))?;
    let protected = match tempfile::NamedTempFile::new_in(target) {
        Ok(_) => false,
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => true,
        Err(error) => return Err(error),
    };
    let machine = crate::api::update_api::windows_machine_install(target);
    let event_name = format!("Local\\OpenBitFunUpdate-{}", uuid::Uuid::new_v4());
    let file = if package.msi {
        system_directory()?.join("msiexec.exe")
    } else {
        package.path.clone()
    };
    let parameters = if package.native {
        format!(
            "/UPDATE /S /WAITPID={} /READY_EVENT={} {} {}",
            std::process::id(),
            event_name,
            quote_windows_argument(OsStr::new(&format!(
                "/OPENBITFUN_TARGET={}",
                target.display()
            ))),
            if machine { "/ALLUSERS" } else { "" },
        )
    } else if package.msi {
        // The original-token supervisor owns restart, including cancellation.
        format!(
            "/i {} /passive /norestart AUTOLAUNCHAPP=False",
            quote_windows_argument(package.path.as_os_str())
        )
    } else {
        // NSIS /D must be last and unquoted. Keep the historical installer route.
        format!("/S /UPDATE /D={}", target.display())
    };
    let namespace = openbitfun_services_core::product_identity::data_namespace();
    let result_root = |variable| -> io::Result<PathBuf> {
        std::env::var_os(variable)
            .map(|root| {
                PathBuf::from(root)
                    .join(namespace)
                    .join("maintenance/results")
            })
            .ok_or_else(|| {
                io::Error::other(format!("Maintenance directory is unavailable: {variable}"))
            })
    };
    let user_results = result_root("LOCALAPPDATA")?;
    let machine_results = result_root("PROGRAMDATA")?;
    let restart = app
        .env()
        .args_os
        .iter()
        .skip(1)
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(" ");
    let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
    let script = format!(
        r#"$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$parentProcess=Get-Process -Id {pid}
$null=$parentProcess.Handle
$nativeResultFile=''
function Read-NativeFailure($code) {{
  if($nativeResultFile -and (Test-Path -LiteralPath $nativeResultFile)) {{
    try {{
      $native=Get-Content -LiteralPath $nativeResultFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if($native.exitCode -eq $code) {{ return $native.error }}
    }} catch {{}}
  }}
  return $null
}}
$result=@{{version={version};success=$false;exitCode=$null;error=$null}}
$announced=$false
try {{
  $parameters=@{{FilePath={file};ArgumentList={parameters};PassThru=$true}}
  if ({transactional}) {{
    $event=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,{event})
    $parameters.ArgumentList='/SUPERVISOR_PID='+$PID+' /OWNER_SID='+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+' '+$parameters.ArgumentList
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    $root=if({elevate} -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){{{machine_results}}}else{{{user_results}}}
    $resultID=[Guid]::NewGuid().ToString('N')
    $nativeResultFile=Join-Path $root ($resultID+'.json')
    $parameters.ArgumentList='/RESULT_ID='+$resultID+' '+$parameters.ArgumentList
  }} else {{
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $announced=$true
    $parentProcess.WaitForExit()
  }}
  if ({elevate}) {{ $parameters.Verb='RunAs' }}
  $installer=Start-Process @parameters
  if ({transactional}) {{
    $deadline=[DateTime]::UtcNow.AddSeconds(150)
    while (!$event.WaitOne(100)) {{
      if ($installer.HasExited) {{
        $result.exitCode=$installer.ExitCode
        $detail=Read-NativeFailure $installer.ExitCode
        if($detail) {{ throw $detail }}
        throw 'Maintenance exited before it was ready. Check permissions, disk space and installation ownership.'
      }}
      if ([DateTime]::UtcNow -gt $deadline) {{ $installer.Kill(); throw 'Maintenance readiness timed out; no files were changed.' }}
    }}
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $announced=$true
  }}
  $installer.WaitForExit()
  $result.exitCode=$installer.ExitCode
  $detail=Read-NativeFailure $installer.ExitCode
  if ($installer.ExitCode -ne 0 -and $installer.ExitCode -ne 2) {{ if($detail) {{ throw $detail }}; throw "Installer exited with code $($installer.ExitCode)" }}
  $result.success=$true
  if ($installer.ExitCode -eq 2) {{ $result.error=if($detail){{$detail}}else{{'The update was installed, but some maintenance files require cleanup.'}} }}
}} catch {{
  $result.error=$_.Exception.Message
  if (!$announced) {{ [Console]::Out.WriteLine('ERROR: '+$result.error); [Console]::Out.Flush() }}
}}
try {{
  $json=$result | ConvertTo-Json -Compress
  $tmp={receipt}+'.tmp'
  [IO.File]::WriteAllText($tmp,$json,(New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists({receipt})) {{ [IO.File]::Replace($tmp,{receipt},[NullString]::Value) }} else {{ [IO.File]::Move($tmp,{receipt}) }}
}} catch {{}}
if ($result.error -and $announced) {{
  Add-Type -AssemblyName System.Windows.Forms
  $message=if($result.success){{'OpenBitFun update completed with a cleanup warning. '}}else{{'OpenBitFun update failed. The downloaded package is retained. '}}
  [Windows.Forms.MessageBox]::Show($message+$result.error,'OpenBitFun',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
}}
if ({cleanup} -ne '') {{
  try {{ Remove-Item -LiteralPath {cleanup} -Force; [IO.Directory]::Delete([IO.Path]::GetDirectoryName({cleanup}),$false) }} catch {{}}
}}
if ($announced -and (Test-Path -LiteralPath {current})) {{
  $restart=@{{FilePath={current}}}
  if ({restart} -ne '') {{ $restart.ArgumentList={restart} }}
  Start-Process @restart
}}
"#,
        pid = std::process::id(),
        version = quote(version),
        file = quote(&file.to_string_lossy()),
        parameters = quote(&parameters),
        transactional = if package.native { "$true" } else { "$false" },
        event = quote(&event_name),
        elevate = if protected || machine {
            "$true"
        } else {
            "$false"
        },
        receipt = quote(&receipt.to_string_lossy()),
        current = quote(&current.to_string_lossy()),
        restart = quote(&restart),
        user_results = quote(&user_results.to_string_lossy()),
        machine_results = quote(&machine_results.to_string_lossy()),
        cleanup = quote(&package.path.to_string_lossy()),
    );
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut supervisor =
        create_command(system_directory()?.join("WindowsPowerShell/v1.0/powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .creation_flags(windows_supervisor_creation_flags())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
    let stdout = supervisor
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Supervisor output is unavailable"))?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .read_line(&mut line)
            .map(|_| line.trim().to_owned());
        let _ = sender.send(result);
    });
    let ready = receiver.recv_timeout(Duration::from_secs(180));
    if !matches!(&ready, Ok(Ok(line)) if line == "READY") {
        let _ = supervisor.kill();
        let _ = supervisor.wait();
        let detail = match ready {
            Ok(Ok(line)) if !line.is_empty() => line.trim_start_matches("ERROR: ").to_owned(),
            Ok(Err(error)) => error.to_string(),
            _ => "Maintenance readiness timed out or the supervisor exited".into(),
        };
        return Err(io::Error::other(format!(
            "Cannot start update maintenance: {detail}; the application was left running"
        )));
    }
    // The ready worker owns only this exact staged installer and empty directory.
    let _ = package.stage.keep();
    Ok(())
}

fn windows_supervisor_creation_flags() -> u32 {
    // Host-lifetime cleanup must not kill the worker after the old app exits.
    0x08000000 | 0x00000200 | 0x01000000
}

fn quote_windows_argument(argument: &OsStr) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for character in argument.to_string_lossy().chars() {
        if character == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            slashes * if character == '"' { 2 } else { 1 },
        ));
        slashes = 0;
        if character == '"' {
            result.push('\\');
        }
        result.push(character);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_supervisor_survives_the_host_lifetime_job() {
        if let Some(receipt) = std::env::var_os("OPENBITFUN_UPDATER_JOB_FIXTURE") {
            // Only the disposable child joins a host-lifetime Job.
            let mut limits = win32job::ExtendedLimitInfo::new();
            limits.limit_kill_on_job_close().limit_breakaway_ok();
            let job = win32job::Job::create_with_limit_info(&limits).unwrap();
            job.assign_current_process().unwrap();
            create_command(system_directory().unwrap().join("WindowsPowerShell/v1.0/powershell.exe"))
                .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 800; [IO.File]::WriteAllText($env:OPENBITFUN_UPDATER_JOB_FIXTURE, 'survived')"])
                .env("OPENBITFUN_UPDATER_JOB_FIXTURE", receipt)
                .creation_flags(windows_supervisor_creation_flags())
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            std::process::exit(0);
        }
        let root = tempfile::tempdir().unwrap();
        let receipt = root.path().join("supervisor.txt");
        let result = create_command(std::env::current_exe().unwrap())
            .args(["--exact", "update_maintenance::windows::tests::windows_supervisor_survives_the_host_lifetime_job"])
            .env("OPENBITFUN_UPDATER_JOB_FIXTURE", &receipt).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while !receipt.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(fs::read_to_string(receipt).unwrap(), "survived");
    }

    #[test]
    fn native_windows_arguments_roundtrip_through_the_os_parser() {
        #[link(name = "shell32")]
        extern "system" {
            fn CommandLineToArgvW(command: *const u16, count: *mut i32) -> *mut *mut u16;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        }
        let values = [
            r"/OPENBITFUN_TARGET=C:\Program Files\测试目录",
            "space here",
            "quote\"inside",
            "trailing\\",
            "",
        ];
        let command = format!(
            "program.exe {}",
            values
                .iter()
                .map(|value| quote_windows_argument(OsStr::new(value)))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let wide = command
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut count = 0;
        let arguments = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
        assert!(!arguments.is_null());
        let decoded = unsafe { std::slice::from_raw_parts(arguments, count as usize) }
            .iter()
            .skip(1)
            .map(|pointer| {
                let mut length = 0;
                unsafe {
                    while *(*pointer).add(length) != 0 {
                        length += 1;
                    }
                    String::from_utf16_lossy(std::slice::from_raw_parts(*pointer, length))
                }
            })
            .collect::<Vec<_>>();
        unsafe {
            LocalFree(arguments.cast());
        }
        assert_eq!(decoded, values);
    }

    #[test]
    fn package_staging_validates_before_starting_any_process() {
        assert!(stage_package(b"invalid package").is_err());
        let payload = [b"MZ".as_slice(), PROTOCOL].concat();
        let package = stage_package(&payload).unwrap();
        assert!(package.native);
        assert!(!package.msi);
        assert_eq!(fs::read(&package.path).unwrap(), payload);
        let directory = package.stage.path().to_owned();
        drop(package);
        assert!(!directory.exists());
    }

    #[test]
    fn archived_installers_are_selected_without_extracting_unrelated_paths() {
        let mut archive = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("../../unrelated.txt", options).unwrap();
        archive.write_all(b"keep outside paths untouched").unwrap();
        archive.start_file("nested/setup.exe", options).unwrap();
        archive.write_all(b"MZOPENBITFUN_MAINTENANCE_V1").unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let package = stage_package(&bytes).unwrap();
        assert!(package.native);
        assert_eq!(fs::read_dir(package.stage.path()).unwrap().count(), 1);
        assert_eq!(package.path.file_name().unwrap(), "installer.exe");
    }
}
