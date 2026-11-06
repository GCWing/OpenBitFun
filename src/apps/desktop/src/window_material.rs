//! Windowed Chromium supplies an opaque surface on each desktop platform.

pub(crate) fn configure_main_window<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    fallback_color: tauri::window::Color,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "windows")]
    let builder = builder.decorations(false).shadow(true);

    builder
        .transparent(false)
        .background_color(tauri::window::Color(
            fallback_color.0,
            fallback_color.1,
            fallback_color.2,
            255,
        ))
}
