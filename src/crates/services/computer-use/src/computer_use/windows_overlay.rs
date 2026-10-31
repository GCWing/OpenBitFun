//! Same-process popup HWNDs (menus, dropdown lists, suggestion popups) stacked
//! above the bound top-level window. Only Win32 style and ownership facts are
//! used; no window titles, classes or application names are special.

// Stable Win32 style bits.
const WS_POPUP: u32 = 0x8000_0000;
const WS_CAPTION: u32 = 0x00C0_0000;
const WS_THICKFRAME: u32 = 0x0004_0000;
const WS_EX_APPWINDOW: u32 = 0x0004_0000;

#[derive(Clone, Debug)]
pub(super) struct PopupCandidate {
    pub handle: usize,
    pub pid: u32,
    pub visible: bool,
    pub cloaked: bool,
    /// The bound window is this window's owner, directly or transitively.
    pub owned_by_bound: bool,
    pub style: u32,
    pub ex_style: u32,
    pub bounds: Option<[f64; 4]>,
}

impl PopupCandidate {
    /// Owned windows are transient by Win32 contract. An unowned window counts
    /// only when it is a captionless, fixed-size popup that is not an
    /// application window: a sibling main window is an independent surface.
    pub(super) fn is_overlay_of(&self, pid: u32, bound: usize, bound_bounds: [f64; 4]) -> bool {
        let Some(bounds) = self.bounds else {
            return false;
        };
        if self.pid != pid || self.handle == bound || !self.visible || self.cloaked {
            return false;
        }
        if bounds[2] < 2.0
            || bounds[3] < 2.0
            || !super::overlay_windows::intersects(bounds, bound_bounds)
        {
            return false;
        }
        self.owned_by_bound
            || (self.style & WS_POPUP != 0
                && self.style & WS_CAPTION != WS_CAPTION
                && self.style & WS_THICKFRAME == 0
                && self.ex_style & WS_EX_APPWINDOW == 0)
    }
}

/// Keeps candidates above the bound window (z-order is front to back and
/// ends at the bound window) that qualify as its overlays.
pub(super) fn select_overlays(
    pid: u32,
    bound: usize,
    bound_bounds: [f64; 4],
    z_order: impl IntoIterator<Item = PopupCandidate>,
) -> Vec<super::overlay_windows::OverlayWindow> {
    z_order
        .into_iter()
        .take_while(|candidate| candidate.handle != bound)
        .filter(|candidate| candidate.is_overlay_of(pid, bound, bound_bounds))
        .filter_map(|candidate| {
            Some(super::overlay_windows::OverlayWindow {
                window_id: candidate.handle as u64,
                bounds: candidate.bounds?,
                layer: None,
                title: None,
            })
        })
        .take(super::overlay_windows::MAX_OVERLAYS)
        .collect()
}

#[cfg(target_os = "windows")]
mod native {
    use super::PopupCandidate;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, GWL_STYLE, GW_OWNER,
    };

    struct Walk {
        bound: HWND,
        candidates: Vec<PopupCandidate>,
        reached_bound: bool,
    }

    fn owned_by(window: HWND, bound: HWND) -> bool {
        let mut owner = window;
        // Owner chains are short; the bound guards against a malformed cycle.
        for _ in 0..16 {
            owner = match unsafe { GetWindow(owner, GW_OWNER) } {
                Ok(next) if !next.is_invalid() => next,
                _ => return false,
            };
            if owner == bound {
                return true;
            }
        }
        false
    }

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the &mut Walk passed by `z_order_above`, alive for
        // the synchronous EnumWindows call.
        let walk = unsafe { &mut *(lparam.0 as *mut Walk) };
        if hwnd == walk.bound {
            walk.reached_bound = true;
            return BOOL(0);
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        let mut cloaked = 0u32;
        let cloaked = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .is_ok()
            && cloaked != 0;
        walk.candidates.push(PopupCandidate {
            handle: hwnd.0 as usize,
            pid,
            visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
            cloaked,
            owned_by_bound: owned_by(hwnd, walk.bound),
            style: unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32,
            ex_style: unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32,
            bounds: super::super::windows_capture::window_bounds(hwnd).ok(),
        });
        BOOL(1)
    }

    /// Top-level windows in front of `bound`, front to back. Empty when the
    /// bound window is no longer in the z-order.
    fn z_order_above(bound: HWND) -> Vec<PopupCandidate> {
        let mut walk = Walk {
            bound,
            candidates: Vec::new(),
            reached_bound: false,
        };
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut walk as *mut Walk as isize));
        }
        if walk.reached_bound {
            walk.candidates
        } else {
            Vec::new()
        }
    }

    fn title(hwnd: HWND) -> Option<String> {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        (length > 0).then(|| String::from_utf16_lossy(&buffer[..length as usize]))
    }

    pub(in super::super) fn popups_above(
        bound: HWND,
        bound_bounds: [f64; 4],
    ) -> Vec<super::super::overlay_windows::OverlayWindow> {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(bound, Some(&mut pid)) };
        if pid == 0 {
            return Vec::new();
        }
        let mut overlays =
            super::select_overlays(pid, bound.0 as usize, bound_bounds, z_order_above(bound));
        for overlay in &mut overlays {
            overlay.title = title(HWND(overlay.window_id as usize as *mut _));
        }
        overlays
    }

    /// The window a physical pointer at a screen point reaches: the bound
    /// window's front-most popup there, otherwise the bound window itself.
    pub(in super::super) fn pointer_root(bound: HWND, x: i32, y: i32) -> HWND {
        let Ok(bounds) = super::super::windows_capture::window_bounds(bound) else {
            return bound;
        };
        let overlays = popups_above(bound, bounds);
        super::super::overlay_windows::topmost_at(&overlays, f64::from(x), f64::from(y))
            .map(|overlay| HWND(overlay.window_id as usize as *mut _))
            .unwrap_or(bound)
    }
}

#[cfg(target_os = "windows")]
pub(super) use native::{pointer_root, popups_above};

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(handle: usize) -> PopupCandidate {
        PopupCandidate {
            handle,
            pid: 42,
            visible: true,
            cloaked: false,
            owned_by_bound: false,
            style: WS_POPUP,
            ex_style: 0,
            bounds: Some([100.0, 100.0, 200.0, 300.0]),
        }
    }

    const BOUND: usize = 7;
    const FRAME: [f64; 4] = [0.0, 0.0, 800.0, 600.0];

    #[test]
    fn captionless_popups_and_owned_windows_above_the_bound_window_qualify() {
        let mut owned_dialog = candidate(2);
        owned_dialog.style = WS_CAPTION | WS_THICKFRAME;
        owned_dialog.owned_by_bound = true;
        let overlays = select_overlays(
            42,
            BOUND,
            FRAME,
            [candidate(1), owned_dialog, candidate(BOUND), candidate(9)],
        );
        let ids: Vec<u64> = overlays.iter().map(|overlay| overlay.window_id).collect();
        assert_eq!(ids, [1, 2], "windows below the bound window never qualify");
    }

    #[test]
    fn independent_or_invisible_windows_are_not_overlays() {
        let mut other_process = candidate(1);
        other_process.pid = 43;
        let mut main_window = candidate(2);
        main_window.style = WS_POPUP | WS_THICKFRAME;
        let mut app_window = candidate(3);
        app_window.ex_style = WS_EX_APPWINDOW;
        let mut captioned = candidate(4);
        captioned.style = WS_CAPTION;
        let mut hidden = candidate(5);
        hidden.visible = false;
        let mut cloaked = candidate(6);
        cloaked.cloaked = true;
        let mut elsewhere = candidate(8);
        elsewhere.bounds = Some([900.0, 0.0, 100.0, 100.0]);
        let mut tiny = candidate(10);
        tiny.bounds = Some([10.0, 10.0, 1.0, 40.0]);
        let overlays = select_overlays(
            42,
            BOUND,
            FRAME,
            [
                other_process,
                main_window,
                app_window,
                captioned,
                hidden,
                cloaked,
                elsewhere,
                tiny,
                candidate(BOUND),
            ],
        );
        assert!(overlays.is_empty(), "{overlays:?}");
    }
}
