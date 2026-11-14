//! Native main-window material without replacing the platform resize frame.

#[cfg(any(target_os = "windows", test))]
const WINDOWS_SYSTEM_BACKDROP_MIN_BUILD: u32 = 22621;

#[cfg(any(target_os = "windows", test))]
const fn windows_native_sidebar_material_available(build: u32) -> bool {
    build >= WINDOWS_SYSTEM_BACKDROP_MIN_BUILD
}

/// `OPENBITFUN_NATIVE_WINDOW_MATERIAL=0` selects the opaque window path on macOS
/// and Windows, for comparing WebView compositing cost without native material.
const NATIVE_WINDOW_MATERIAL_ENV: &str = "OPENBITFUN_NATIVE_WINDOW_MATERIAL";

fn native_window_material_allowed_by(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_none_or(|value| value != "0")
}

pub(crate) fn native_sidebar_material_available() -> bool {
    if !native_window_material_allowed_by(std::env::var_os(NATIVE_WINDOW_MATERIAL_ENV).as_deref()) {
        return false;
    }
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

    #[test]
    fn native_window_material_env_only_opts_out_with_zero() {
        use std::ffi::OsStr;
        assert!(native_window_material_allowed_by(None));
        assert!(native_window_material_allowed_by(Some(OsStr::new("1"))));
        assert!(native_window_material_allowed_by(Some(OsStr::new(""))));
        assert!(!native_window_material_allowed_by(Some(OsStr::new("0"))));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_native_sidebar_material_unless_disabled() {
        assert_eq!(
            native_sidebar_material_available(),
            native_window_material_allowed_by(
                std::env::var_os(NATIVE_WINDOW_MATERIAL_ENV).as_deref()
            )
        );
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn other_platforms_keep_their_existing_material_owner() {
        assert!(!native_sidebar_material_available());
    }
}
