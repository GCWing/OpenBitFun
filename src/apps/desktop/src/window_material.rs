//! Native main-window material without replacing the platform resize frame.

#[cfg(any(target_os = "windows", test))]
const WINDOWS_SYSTEM_BACKDROP_MIN_BUILD: u32 = 22621;

#[cfg(any(target_os = "windows", test))]
const fn windows_native_sidebar_material_available(build: u32) -> bool {
    build >= WINDOWS_SYSTEM_BACKDROP_MIN_BUILD
}

pub(crate) fn native_sidebar_material_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        // RtlGetVersion is independent of application compatibility manifests.
        // A failed query leaves the build at zero and selects the opaque path.
        windows_native_sidebar_material_available(windows_version::OsVersion::current().build)
    }
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

pub(crate) fn configure_main_window<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    native_sidebar_material: bool,
    fallback_color: tauri::window::Color,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "windows")]
    let builder = {
        // Tao owns the native side/bottom frame and corner hit testing, while
        // Tauri supplies the top resize strip. Keep both, including the shadow,
        // rather than expanding the client rectangle over their resize areas.
        builder.decorations(false).shadow(true)
    };

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        if native_sidebar_material {
            builder
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .effects(
                    tauri::window::EffectsBuilder::new()
                        .effects([
                            tauri::window::Effect::Acrylic,
                            tauri::window::Effect::Sidebar,
                        ])
                        .build(),
                )
        } else {
            // Older Windows builds use live Acrylic blur during dragging. An
            // opaque fallback avoids that work and keeps the native edge clear.
            builder
                .transparent(false)
                .background_color(tauri::window::Color(
                    fallback_color.0,
                    fallback_color.1,
                    fallback_color.2,
                    255,
                ))
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (native_sidebar_material, fallback_color);
        builder
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_uses_opaque_fallback_before_compositor_backdrop_support() {
        for build in [19045, 22000, 22620] {
            assert!(!windows_native_sidebar_material_available(build));
        }
        for build in [22621, 22631, 26100] {
            assert!(windows_native_sidebar_material_available(build));
        }
    }

    #[test]
    fn failed_windows_version_query_uses_opaque_fallback() {
        assert!(!windows_native_sidebar_material_available(0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_native_sidebar_material() {
        assert!(native_sidebar_material_available());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn other_platforms_keep_their_existing_material_owner() {
        assert!(!native_sidebar_material_available());
    }
}
