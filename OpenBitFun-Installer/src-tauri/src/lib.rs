mod installer;
mod preview;

use installer::commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match commands::relocate_uninstaller() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            if std::env::args().any(|arg| arg == "--quiet") {
                eprintln!("Cannot start uninstaller: {error}");
            } else {
                show_native_error(&format!("Cannot start uninstaller: {error}"));
            }
            std::process::exit(1);
        }
    }
    commands::schedule_uninstaller_cleanup();
    if let Some(result) = commands::native_mode() {
        let code = match &result {
            Ok(()) => 0,
            Err(error)
                if error.starts_with("Update installed, but")
                    || error.starts_with("Uninstall completed, but") =>
            {
                2
            }
            Err(_) => 1,
        };
        commands::persist_native_outcome(code, result.as_ref().err().map(String::as_str));
        if let Err(error) = result {
            eprintln!("Maintenance failed: {error}");
            if !std::env::args().any(|arg| arg.starts_with("/READY_EVENT=") || arg == "--quiet") {
                show_native_error(&error);
            }
            std::process::exit(code as i32);
        }
        return;
    }
    let preview_only = preview::is_enabled();
    #[cfg(windows)]
    if !preview_only && tauri::webview_version().is_err() {
        let context = commands::get_launch_context();
        if context.mode == "uninstall" {
            let Some(path) = context.uninstall_path else {
                show_native_error("The uninstall directory is unavailable");
                std::process::exit(1);
            };
            if !confirm_native_uninstall() {
                std::process::exit(1223);
            }
            if let Err(error) = commands::uninstall_without_webview(path) {
                show_native_error(&error);
                std::process::exit(if error.starts_with("Uninstall completed, but") {
                    2
                } else {
                    1
                });
            }
            return;
        }
        if let Err(error) = install_webview_runtime() {
            show_native_error(&error);
            std::process::exit(1);
        }
    }
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        commands::get_launch_context,
        commands::get_default_install_path,
        commands::get_initial_install_path,
        commands::get_existing_installation,
        commands::launch_registered_uninstaller,
        commands::get_disk_space,
        commands::validate_install_path,
        commands::start_installation,
        commands::set_model_config,
        commands::test_model_config_connection,
        commands::list_model_config_models,
        commands::set_theme_preference,
        commands::uninstall,
        commands::launch_application,
        commands::launch_legacy_data_migrator,
        commands::close_installer,
    ];
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if commands::maintenance_busy() { api.prevent_close(); }
            }
        })
        .invoke_handler(move |invoke| {
            if preview_only && !preview::allows_command(invoke.message.command()) {
                invoke
                    .resolver
                    .reject("Installer UI preview does not execute this operation.");
                return true;
            }
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            show_native_error(&format!("Cannot open the installer. Check the Microsoft WebView2 Runtime and retry. {error}"));
            std::process::exit(1);
        });
}

#[cfg(windows)]
fn confirm_native_uninstall() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            flags: u32,
        ) -> i32;
    }
    let message = "Remove the OpenBitFun application? Your settings, sessions and workspaces will be preserved. WebView2 is unavailable, so a native uninstaller will be used."
        .encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let title = "OpenBitFun"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            0x124,
        ) == 6
    }
}

#[cfg(windows)]
fn install_webview_runtime() -> Result<(), String> {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            window: *mut std::ffi::c_void,
            text: *const u16,
            title: *const u16,
            flags: u32,
        ) -> i32;
    }
    let text = "OpenBitFun requires Microsoft WebView2 Runtime. Download and install the signed Microsoft runtime now? An internet connection is required."
        .encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let title = "OpenBitFun"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x24) } != 6 {
        return Err("WebView2 Runtime is required. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and retry. No application files were changed.".into());
    }
    let temp = tempfile::Builder::new()
        .prefix("openbitfun-webview-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let bootstrap = temp.path().join("MicrosoftEdgeWebview2Setup.exe");
    let script = r#"$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $env:OPENBITFUN_WEBVIEW_BOOTSTRAP
$signature=Get-AuthenticodeSignature -LiteralPath $env:OPENBITFUN_WEBVIEW_BOOTSTRAP
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'Microsoft WebView2 signature verification failed' }
$installer=Start-Process -FilePath $env:OPENBITFUN_WEBVIEW_BOOTSTRAP -ArgumentList '/silent /install' -PassThru
$installer.WaitForExit()
if ($installer.ExitCode -ne 0) { throw "WebView2 setup failed with exit code $($installer.ExitCode)" }
"#;
    let output = commands::create_windows_silent_command(commands::system_powershell()?)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("OPENBITFUN_WEBVIEW_BOOTSTRAP", &bootstrap)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Cannot install WebView2 Runtime. Install the runtime manually and retry. {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    tauri::webview_version().map_err(|e| format!("WebView2 Runtime is still unavailable: {e}. Restart Windows if runtime setup requires a reboot"))?;
    Ok(())
}

fn show_native_error(message: &str) {
    #[cfg(windows)]
    unsafe {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(
                window: *mut std::ffi::c_void,
                text: *const u16,
                title: *const u16,
                flags: u32,
            ) -> i32;
        }
        let text = message
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let title = "OpenBitFun"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}
