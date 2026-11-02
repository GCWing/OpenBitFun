//! Literal Shell launch with an explicit activation policy; no cmd.exe parsing.
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::OpenAppResult;
use windows::core::{w, HSTRING};
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::{
    Shell::ShellExecuteW,
    WindowsAndMessaging::{SW_SHOWNOACTIVATE, SW_SHOWNORMAL},
};

pub(super) fn open(name: String, background: bool) -> OpenBitFunResult<OpenAppResult> {
    crate::computer_use::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    if name.trim().is_empty() || name.contains('\0') {
        return Err(OpenBitFunError::tool(
            "[APP_REQUIRED] A valid application name or path is required",
        ));
    }
    // Shell handlers may require COM. A blocking worker can already own an
    // apartment; balance only the initialization performed by this call.
    let initialized =
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
        return Err(OpenBitFunError::tool(format!(
            "Windows application launch could not initialize COM: {initialized:?}"
        )));
    }
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(&name),
            None,
            None,
            if background {
                SW_SHOWNOACTIVATE
            } else {
                SW_SHOWNORMAL
            },
        )
    }
    .0 as isize;
    if initialized.is_ok() {
        unsafe { CoUninitialize() };
    }
    Ok(OpenAppResult {
        app_name: name,
        success: result > 32,
        process_id: None,
        error_message: (result <= 32)
            .then(|| format!("Windows application launch failed: {result}")),
        bundle_id: None,
        process_name: None,
        window_count: None,
        launch_path: Some(
            if background {
                "shell_no_activate"
            } else {
                "shell_open"
            }
            .into(),
        ),
    })
}
