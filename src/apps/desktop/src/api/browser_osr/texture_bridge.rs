//! Private ABI provided by the patched macOS CEF framework.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::sync::OnceLock;
use tauri_runtime_cef::cef::ImplBrowser;
use tauri_runtime_cef::WebviewCefExt;

type Bind = unsafe extern "C" fn(
    libc::c_int,
    libc::c_int,
    *const libc::c_char,
    *const libc::c_char,
) -> libc::c_int;

fn entry_point() -> Option<Bind> {
    static ENTRY_POINT: OnceLock<Option<Bind>> = OnceLock::new();
    *ENTRY_POINT.get_or_init(|| {
        let contents = std::env::current_exe()
            .ok()?
            .parent()?
            .parent()?
            .to_path_buf();
        let framework = contents
            .join("Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework");
        let framework = CString::new(framework.canonicalize().ok()?.as_os_str().as_bytes()).ok()?;
        // SAFETY: RTLD_NOLOAD only obtains a reference to the CEF image that
        // Tauri already owns. The versioned symbol has the ABI declared above.
        unsafe {
            let image = libc::dlopen(framework.as_ptr(), libc::RTLD_LAZY | libc::RTLD_NOLOAD);
            if image.is_null() {
                return None;
            }
            let symbol = libc::dlsym(image, c"cef_openbitfun_bind_osr_texture_v1".as_ptr());
            libc::dlclose(image);
            (!symbol.is_null()).then(|| std::mem::transmute::<*mut libc::c_void, Bind>(symbol))
        }
    })
}

pub(super) fn require() -> Result<(), String> {
    entry_point().map(|_| ()).ok_or_else(|| {
        "GPU browser presentation requires the OpenBitFun CEF IOSurface patch".into()
    })
}

pub(super) async fn bind(
    workbench: &tauri::Webview,
    guest: &tauri::Webview,
    label: &str,
    origin: &str,
) -> Result<(), String> {
    let bind = entry_point().ok_or("CEF IOSurface bridge is unavailable")?;
    let label = CString::new(label).map_err(|error| error.to_string())?;
    let origin = CString::new(origin).map_err(|error| error.to_string())?;
    let (send, recv) = tokio::sync::oneshot::channel();
    workbench
        .with_cef_webview(move |native| {
            let _ = send.send(native.browser().identifier());
        })
        .map_err(|error| error.to_string())?;
    let destination = recv.await.map_err(|_| "The workbench was closed")?;

    let (send, recv) = tokio::sync::oneshot::channel();
    guest
        .with_cef_webview(move |native| {
            // SAFETY: This runs on the CEF UI thread and the label remains alive
            // until the bridge has copied it into its document-bound route.
            let attached = unsafe {
                bind(
                    native.browser().identifier(),
                    destination,
                    label.as_ptr(),
                    origin.as_ptr(),
                )
            } == 1;
            let _ = send.send(attached);
        })
        .map_err(|error| error.to_string())?;
    match recv.await {
        Ok(true) => Ok(()),
        _ => Err("CEF could not bind the browser texture to the workbench document".into()),
    }
}
