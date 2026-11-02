fn main() {
    // Cargo does not propagate a dependency's link-arg to the final executable.
    // Keep the shared provider optional on macOS older than ScreenCaptureKit.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }
    println!("cargo:rerun-if-env-changed=OPENBITFUN_RELEASE_CHANNEL");
    println!("cargo:rerun-if-env-changed=OPENBITFUN_DESKTOP_BINARY_NAME");
    println!("cargo:rerun-if-env-changed=OPENBITFUN_UPDATER_PRIMARY_ENDPOINT");
    println!("cargo:rerun-if-env-changed=OPENBITFUN_UPDATER_FALLBACK_ENDPOINT");
    // The Windows primary thread keeps the Tauri event loop and native window
    // creation stack. Reserve the same headroom as the Tokio workers so a
    // large debug invoke dispatcher cannot exhaust the default 1 MiB stack.
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app.manifest"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to build desktop platform resources");
}
