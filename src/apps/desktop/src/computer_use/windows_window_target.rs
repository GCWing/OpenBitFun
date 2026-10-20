//! Default HWND selection from Win32 facts. Explicit/bound HWNDs bypass this policy.
//! Keep the policy portable so reported window inventories can be regression tested.

// Stable Win32 extended-style bits; no window titles, classes or app names are special.
const WS_EX_TOPMOST: u32 = 0x0000_0008;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub(super) struct WindowCandidate {
    pub handle: usize,
    pub pid: u32,
    pub visible: bool,
    pub minimized: bool,
    pub enabled: bool,
    pub titled: bool,
    pub ex_style: u32,
    pub cloaked: Option<u32>,
    pub display_affinity: Option<u32>,
    pub bounds: Option<[i32; 4]>,
}

impl WindowCandidate {
    pub(super) fn capture_unavailable_reason(&self) -> Option<&'static str> {
        if !self.visible || self.minimized {
            return Some("target is hidden or minimized");
        }
        if self.cloaked.is_some_and(|value| value != 0) {
            return Some("target is cloaked by DWM");
        }
        if self.display_affinity.is_some_and(|value| value != 0) {
            return Some("target restricts capture through window display affinity");
        }
        match self.bounds {
            Some([left, top, right, bottom]) if right > left && bottom > top => None,
            _ => Some("target has no readable, non-empty window bounds"),
        }
    }

    fn priority(&self) -> (bool, bool, bool) {
        (
            self.ex_style & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) != 0,
            !self.enabled,
            self.ex_style & WS_EX_TOPMOST != 0,
        )
    }
}

/// Prefer an ordinary content window to a floating utility/overlay. Keep native
/// enumeration order among equal candidates (do not guess by window size).
/// A utility-only app remains targetable. This is selection, not a WGC probe:
/// failure to capture the chosen HWND must never silently switch to another one.
pub(super) fn select_default_window(
    pid: u32,
    candidates: impl IntoIterator<Item = WindowCandidate>,
) -> Option<usize> {
    candidates
        .into_iter()
        .filter(|window| {
            window.pid == pid && window.titled && window.capture_unavailable_reason().is_none()
        })
        .min_by_key(WindowCandidate::priority)
        .map(|window| window.handle)
}

#[cfg(target_os = "windows")]
pub(super) fn inspect_window(hwnd: windows::Win32::Foundation::HWND) -> WindowCandidate {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE,
    };
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut bounds = RECT::default();
        let bounds = GetWindowRect(hwnd, &mut bounds)
            .ok()
            .map(|()| [bounds.left, bounds.top, bounds.right, bounds.bottom]);
        let mut cloaked = 0u32;
        let cloaked = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .ok()
        .map(|()| cloaked);
        // Failure is unknown, not WDA_NONE: this query is not supported for
        // every window. WGC remains the authority for actual capture support.
        let mut affinity = 0;
        let display_affinity = GetWindowDisplayAffinity(hwnd, &mut affinity)
            .ok()
            .map(|()| affinity);
        WindowCandidate {
            handle: hwnd.0 as usize,
            pid,
            visible: IsWindowVisible(hwnd).as_bool(),
            minimized: IsIconic(hwnd).as_bool(),
            enabled: IsWindowEnabled(hwnd).as_bool(),
            titled: GetWindowTextLengthW(hwnd) > 0,
            ex_style: GetWindowLongW(hwnd, GWL_EXSTYLE) as u32,
            cloaked,
            display_affinity,
            bounds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(handle: usize) -> WindowCandidate {
        WindowCandidate {
            handle,
            pid: 5580,
            visible: true,
            minimized: false,
            enabled: true,
            titled: true,
            ex_style: 0x40110,
            cloaked: Some(0),
            display_affinity: None,
            bounds: Some([-8, -8, 1374, 736]),
        }
    }

    #[test]
    fn issue_3291_main_window_wins_over_topmost_companion() {
        let main = window(1050228);
        let mut companion = window(985246);
        companion.ex_style = 0x40118;
        companion.bounds = Some([1063, 72, 1351, 182]);
        // The report's EnumWindows order was companion, then main.
        assert_eq!(
            select_default_window(5580, [companion, main]),
            Some(1050228)
        );
    }

    #[test]
    fn tool_and_noactivate_windows_do_not_preempt_content() {
        for flag in [WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE] {
            let mut utility = window(1);
            utility.ex_style |= flag;
            assert_eq!(select_default_window(5580, [utility, window(2)]), Some(2));
        }
    }

    #[test]
    fn same_priority_preserves_z_order_instead_of_preferring_largest_window() {
        let mut first = window(1);
        first.bounds = Some([-1920, 0, -1600, 200]);
        assert_eq!(select_default_window(5580, [first, window(2)]), Some(1));
    }

    #[test]
    fn utility_only_apps_remain_targetable() {
        let mut utility = window(1);
        utility.ex_style |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST;
        assert_eq!(select_default_window(5580, [utility]), Some(1));
    }

    #[test]
    fn enabled_modal_dialog_wins_over_disabled_main_window() {
        let mut main = window(1);
        main.enabled = false;
        let mut dialog = window(2);
        dialog.ex_style |= WS_EX_TOPMOST;
        assert_eq!(select_default_window(5580, [dialog, main]), Some(2));
    }

    #[test]
    fn unrelated_processes_and_unavailable_windows_are_not_selected() {
        let mut unavailable = Vec::new();
        let mut candidate = window(1);
        candidate.pid = 3920;
        unavailable.push(candidate);
        let mut candidate = window(2);
        candidate.visible = false;
        unavailable.push(candidate);
        let mut candidate = window(3);
        candidate.minimized = true;
        unavailable.push(candidate);
        let mut candidate = window(4);
        candidate.titled = false;
        unavailable.push(candidate);
        let mut candidate = window(5);
        candidate.cloaked = Some(1);
        unavailable.push(candidate);
        for affinity in [1, 0x11] {
            let mut candidate = window(6);
            candidate.display_affinity = Some(affinity);
            unavailable.push(candidate);
        }
        for bounds in [None, Some([0, 0, 0, 100])] {
            let mut candidate = window(7);
            candidate.bounds = bounds;
            unavailable.push(candidate);
        }
        assert_eq!(select_default_window(5580, unavailable.clone()), None);
        unavailable.push(window(8));
        assert_eq!(select_default_window(5580, unavailable), Some(8));
    }

    #[test]
    fn unknown_dwm_and_affinity_do_not_claim_capture_is_denied() {
        let mut candidate = window(1);
        candidate.cloaked = None;
        candidate.display_affinity = None;
        assert_eq!(candidate.capture_unavailable_reason(), None);
        assert_eq!(select_default_window(5580, [candidate]), Some(1));
    }
}
