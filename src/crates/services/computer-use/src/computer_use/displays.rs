//! Display geometry only. Linux uses X11 protocol IO without a mandatory Xlib
//! dependency; Wayland coordinates remain owned by the consented portal stream.
#[cfg(not(target_os = "linux"))]
pub(super) use screenshots::{display_info::DisplayInfo, Screen};

#[cfg(target_os = "linux")]
pub(super) use linux::{DisplayInfo, Screen};

#[cfg(target_os = "linux")]
mod linux {
    use x11rb::{
        connection::Connection,
        protocol::{
            randr::{ConnectionExt as _, MonitorInfo},
            xproto::{AtomEnum, ConnectionExt as _},
        },
    };
    #[derive(Clone, Debug)]
    pub(in crate::computer_use) struct DisplayInfo {
        pub id: u32,
        pub x: i32,
        pub y: i32,
        pub width: u32,
        pub height: u32,
        pub scale_factor: f32,
        pub is_primary: bool,
    }
    pub(in crate::computer_use) struct Screen {
        pub display_info: DisplayInfo,
    }
    impl Screen {
        pub(in crate::computer_use) fn all() -> Result<Vec<Self>, String> {
            super::super::linux_control::require_legacy_x11()?;
            let (connection, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
            let root = &connection.setup().roots[screen];
            // Preserve the prior display-info logical-coordinate/DPI contract.
            let scale = connection
                .get_property(
                    false,
                    root.root,
                    AtomEnum::RESOURCE_MANAGER,
                    AtomEnum::STRING,
                    0,
                    1024,
                )
                .ok()
                .and_then(|request| request.reply().ok())
                .map(|reply| scale_from_resources(&reply.value))
                .unwrap_or(1.0);
            let monitors = connection
                .randr_get_monitors(root.root, true)
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            monitors
                .monitors
                .iter()
                .map(|monitor| {
                    display_from_monitor(monitor, scale).map(|display_info| Self { display_info })
                })
                .collect()
        }
        pub(in crate::computer_use) fn from_point(x: i32, y: i32) -> Result<Self, String> {
            Self::all()?
                .into_iter()
                .find(|screen| {
                    let d = &screen.display_info;
                    i64::from(x) >= i64::from(d.x)
                        && i64::from(y) >= i64::from(d.y)
                        && i64::from(x) < i64::from(d.x) + i64::from(d.width)
                        && i64::from(y) < i64::from(d.y) + i64::from(d.height)
                })
                .ok_or_else(|| {
                    "[DISPLAY_UNAVAILABLE] Point is outside the available X11 monitors".into()
                })
        }
    }
    fn scale_from_resources(resources: &[u8]) -> f32 {
        std::str::from_utf8(resources)
            .ok()
            .and_then(|text| {
                text.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    (name.trim() == "Xft.dpi")
                        .then(|| value.trim().parse::<f32>().ok())
                        .flatten()
                })
            })
            .filter(|dpi| dpi.is_finite() && *dpi > 0.0)
            .map(|dpi| dpi / 96.0)
            .unwrap_or(1.0)
    }

    fn display_from_monitor(monitor: &MonitorInfo, scale: f32) -> Result<DisplayInfo, String> {
        Ok(DisplayInfo {
            id: monitor
                .outputs
                .first()
                .copied()
                .ok_or("[DISPLAY_UNAVAILABLE] X11 monitor has no output identity")?,
            x: (f32::from(monitor.x) / scale) as i32,
            y: (f32::from(monitor.y) / scale) as i32,
            width: (f32::from(monitor.width) / scale) as u32,
            height: (f32::from(monitor.height) / scale) as u32,
            scale_factor: scale,
            is_primary: monitor.primary,
        })
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn x11_dpi_keeps_negative_origin_and_logical_geometry() {
            use super::*;
            let scale = scale_from_resources(b"Xcursor.size: 24\nXft.dpi:\t192\n");
            let monitor = MonitorInfo {
                name: 9,
                primary: false,
                automatic: true,
                x: -1920,
                y: -1080,
                width: 1920,
                height: 1080,
                width_in_millimeters: 500,
                height_in_millimeters: 300,
                outputs: vec![42],
            };
            let display = display_from_monitor(&monitor, scale).unwrap();
            assert_eq!((display.id, display.x, display.y), (42, -960, -540));
            assert_eq!(
                (display.width, display.height, display.scale_factor),
                (960, 540, 2.0)
            );
            let mut anonymous = monitor.clone();
            anonymous.outputs.clear();
            assert!(display_from_monitor(&anonymous, scale).is_err());
            for invalid in [
                b"Xft.dpi: NaN".as_slice(),
                b"Xft.dpi: 0",
                b"Xft.dpi: -96",
                b"unrelated: 192",
            ] {
                assert_eq!(scale_from_resources(invalid), 1.0);
            }
        }
    }

    impl DisplayInfo {
        pub(in crate::computer_use) fn from_point(x: i32, y: i32) -> Result<Self, String> {
            Screen::from_point(x, y).map(|s| s.display_info)
        }
    }
}
