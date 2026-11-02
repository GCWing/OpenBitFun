#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shell;
mod window_chrome;

fn string(value: &serde_json::Value, key: &str) -> Result<String, String> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing MiniApp {key}"))
}

fn show_fatal_startup_error(message: &str) {
    eprintln!("MiniApp startup error: {message}");
    #[cfg(windows)]
    // SAFETY: the message and title own their UTF-16 buffers for the call.
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let _ = MessageBoxW(
            None,
            &windows::core::HSTRING::from(message),
            &windows::core::HSTRING::from("MiniApp startup error"),
            MB_OK | MB_ICONERROR,
        );
    }
}

fn main() {
    // A headless diagnostic also lets packaging verify the artifact without
    // opening windows or initializing a backend.
    if std::env::args_os().any(|arg| arg == "--miniapp-shell-info") {
        println!(
            "{}",
            serde_json::json!({"role":"miniapp-shell", "version":env!("CARGO_PKG_VERSION"), "protocolVersion":openbitfun_miniapp_ipc::MINIAPP_PRESENTATION_PROTOCOL, "launchRecordVersions":[1,2], "tauriDevMode": tauri::is_dev(), "capabilities":[openbitfun_miniapp_ipc::MINIAPP_CUSTOM_CHROME_CAPABILITY,openbitfun_miniapp_ipc::MINIAPP_CHAT_SNAPSHOT_CAPABILITY]})
        );
        return;
    }
    let path = match openbitfun_miniapp_ipc::launcher::launch_manifest() {
        Ok(Some(path)) => path,
        Ok(None) => {
            show_fatal_startup_error(
                "Open a MiniApp system application or supply --miniapp-launch <record>.",
            );
            std::process::exit(1);
        }
        Err(error) => {
            show_fatal_startup_error(&error);
            std::process::exit(1);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("MiniApp async runtime could not start");
    runtime.block_on(shell::run(path));
}
