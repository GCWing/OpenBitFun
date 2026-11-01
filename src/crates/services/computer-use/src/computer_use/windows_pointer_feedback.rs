//! Session-lived, non-activating Windows pointer feedback. Never moves the user's
//! cursor. Feedback is only drawn over the target's currently visible pixels;
//! occluded/background targets are represented in the controller preview.
#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

type Handle = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: Handle,
        menu: Handle,
        instance: Handle,
        param: Handle,
    ) -> Handle;
    fn DestroyWindow(window: Handle) -> i32;
    fn GetWindowRect(window: Handle, rect: *mut Rect) -> i32;
    fn IsWindow(window: Handle) -> i32;
    fn SetWindowPos(
        window: Handle,
        after: Handle,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        flags: u32,
    ) -> i32;
    fn ShowWindow(window: Handle, command: i32) -> i32;
    fn UpdateLayeredWindow(
        window: Handle,
        dst_dc: Handle,
        position: *const Point,
        size: *const Size,
        src_dc: Handle,
        origin: *const Point,
        key: u32,
        blend: *const Blend,
        flags: u32,
    ) -> i32;
    fn GetDC(window: Handle) -> Handle;
    fn ReleaseDC(window: Handle, dc: Handle) -> i32;
    fn GetForegroundWindow() -> Handle;
    fn WindowFromPoint(point: Point) -> Handle;
    fn GetAncestor(window: Handle, flags: u32) -> Handle;
    fn SystemParametersInfoW(action: u32, param: u32, value: *mut c_void, flags: u32) -> i32;
}
#[repr(C)]
struct Size {
    width: i32,
    height: i32,
}
#[repr(C)]
struct Blend {
    operation: u8,
    flags: u8,
    alpha: u8,
    format: u8,
}
#[repr(C)]
struct BitmapHeader {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pixels: i32,
    y_pixels: i32,
    colors_used: u32,
    colors_important: u32,
}
#[repr(C)]
struct BitmapInfo {
    header: BitmapHeader,
    colors: [u32; 1],
}
#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(dc: Handle) -> Handle;
    fn DeleteDC(dc: Handle) -> i32;
    fn CreateDIBSection(
        dc: Handle,
        info: *const BitmapInfo,
        usage: u32,
        bits: *mut *mut c_void,
        section: Handle,
        offset: u32,
    ) -> Handle;
    fn SelectObject(dc: Handle, object: Handle) -> Handle;
    fn DeleteObject(object: Handle) -> i32;
}

// Rasterize the shared 40x40 cubic contour at four samples per axis. Alpha is
// premultiplied for AC_SRC_ALPHA: black shadow pixels retain alpha, unlike a
// color-key surface. The contour shrinks around its hotspot before adding a
// fixed 3px white stroke; the complete silhouette casts the shadow.
fn pointer_pixels(clicked: bool) -> Vec<u32> {
    type P = (f64, f64);
    fn cubic(points: &mut Vec<P>, a: P, b: P, c: P, d: P) {
        for step in 1..=16 {
            let t = f64::from(step) / 16.0;
            let u = 1.0 - t;
            points.push((
                u * u * u * a.0 + 3.0 * u * u * t * b.0 + 3.0 * u * t * t * c.0 + t * t * t * d.0,
                u * u * u * a.1 + 3.0 * u * u * t * b.1 + 3.0 * u * t * t * c.1 + t * t * t * d.1,
            ));
        }
    }
    let mut outline = vec![(8.0, 8.0)];
    cubic(
        &mut outline,
        (8.0, 8.0),
        (6.0, 10.0),
        (7.0, 12.0),
        (8.0, 15.0),
    );
    outline.push((14.0, 31.0));
    cubic(
        &mut outline,
        (14.0, 31.0),
        (15.5, 35.0),
        (19.0, 35.0),
        (20.5, 31.5),
    );
    outline.push((23.0, 26.0));
    cubic(
        &mut outline,
        (23.0, 26.0),
        (23.6, 24.5),
        (24.5, 23.6),
        (26.0, 23.0),
    );
    outline.push((31.5, 20.5));
    cubic(
        &mut outline,
        (31.5, 20.5),
        (35.0, 19.0),
        (35.0, 15.5),
        (31.0, 14.0),
    );
    outline.push((15.0, 8.0));
    cubic(
        &mut outline,
        (15.0, 8.0),
        (12.0, 7.0),
        (10.0, 6.0),
        (8.0, 8.0),
    );
    for point in &mut outline {
        point.0 = 8.0 + (point.0 - 8.0) * 0.7;
        point.1 = 8.0 + (point.1 - 8.0) * 0.7;
    }
    let mut mask = vec![0.0; 1600];
    let mut stroke_mask = vec![0.0; 1600];
    for y in 0..40 {
        for x in 0..40 {
            let mut coverage = 0;
            let mut stroke_coverage = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = x as f64 + (f64::from(sx) + 0.5) / 4.0;
                    let py = y as f64 + (f64::from(sy) + 0.5) / 4.0;
                    let mut inside = false;
                    let mut on_stroke = false;
                    for edge in outline.windows(2) {
                        let (a, b) = (edge[0], edge[1]);
                        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
                        let length_squared = dx * dx + dy * dy;
                        let t = if length_squared > 0.0 {
                            (((px - a.0) * dx + (py - a.1) * dy) / length_squared).clamp(0.0, 1.0)
                        } else {
                            0.0
                        };
                        on_stroke |= (px - a.0 - t * dx).powi(2) + (py - a.1 - t * dy).powi(2)
                            <= 1.5_f64.powi(2);
                        if (a.1 > py) != (b.1 > py)
                            && px < (b.0 - a.0) * (py - a.1) / (b.1 - a.1) + a.0
                        {
                            inside = !inside;
                        }
                    }
                    if inside || on_stroke {
                        coverage += 1;
                    }
                    if on_stroke {
                        stroke_coverage += 1;
                    }
                }
            }
            mask[y * 40 + x] = f64::from(coverage) / 16.0;
            stroke_mask[y * 40 + x] = f64::from(stroke_coverage) / 16.0;
        }
    }
    let weights: Vec<f64> = (-5..=5)
        .map(|n| (-(f64::from(n).powi(2)) / (2.0 * 2.0 * 2.0)).exp())
        .collect();
    let edge_weights: Vec<f64> = (-5..=5)
        .map(|n| (-(f64::from(n).powi(2)) / (2.0 * 0.65 * 0.65)).exp())
        .collect();
    let sum: f64 = weights.iter().sum();
    let edge_sum: f64 = edge_weights.iter().sum();
    let mut pixels = vec![0u32; 1600];
    for y in 0..40i32 {
        for x in 0..40i32 {
            let mut shadow = 0.0;
            let mut edge_shadow = 0.0;
            for dy in -5..=5 {
                for dx in -5..=5 {
                    let (mx, my) = (x - dx, y - dy);
                    if (0..40).contains(&mx) && (0..40).contains(&my) {
                        let coverage = mask[(my * 40 + mx) as usize];
                        shadow +=
                            coverage * weights[(dx + 5) as usize] * weights[(dy + 5) as usize]
                                / (sum * sum);
                        edge_shadow += coverage
                            * edge_weights[(dx + 5) as usize]
                            * edge_weights[(dy + 5) as usize]
                            / (edge_sum * edge_sum);
                    }
                }
            }
            let silhouette = mask[(y * 40 + x) as usize];
            let stroke = stroke_mask[(y * 40 + x) as usize];
            let fill = silhouette - stroke;
            let radius =
                ((f64::from(x) + 0.5 - 8.0).powi(2) + (f64::from(y) + 0.5 - 8.0).powi(2)).sqrt();
            let ring = if clicked {
                (1.0 - (radius - 6.5).abs()).clamp(0.0, 1.0) * 0.4
            } else {
                0.0
            };
            // Center both layers: dark beside the white edge, softer farther out.
            let halo = edge_shadow * 0.8 + shadow * 0.5 * (1.0 - edge_shadow * 0.8);
            let behind = ring + halo * (1.0 - ring);
            let alpha = silhouette + behind * (1.0 - silhouette);
            let channel =
                (64.0 * fill + 255.0 * stroke + 166.0 * ring * (1.0 - silhouette)).round() as u32;
            pixels[(y * 40 + x) as usize] =
                ((alpha * 255.0).round() as u32) << 24 | channel << 16 | channel << 8 | channel;
        }
    }
    pixels
}

unsafe fn present_pointer(window: Handle, pixels: &[u32]) -> bool {
    // SAFETY: all GDI handles are checked and released; the top-down 32-bit DIB
    // owns exactly 40*40 pixels and remains selected until UpdateLayeredWindow copies it.
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        let dc = CreateCompatibleDC(screen);
        if dc.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return false;
        }
        let info = BitmapInfo {
            header: BitmapHeader {
                size: 40,
                width: 40,
                height: -40,
                planes: 1,
                bit_count: 32,
                compression: 0,
                size_image: 6400,
                x_pixels: 0,
                y_pixels: 0,
                colors_used: 0,
                colors_important: 0,
            },
            colors: [0],
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(dc, &info, 0, &mut bits, std::ptr::null_mut(), 0);
        if bitmap.is_null() || bits.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            DeleteDC(dc);
            ReleaseDC(std::ptr::null_mut(), screen);
            return false;
        }
        let old = SelectObject(dc, bitmap);
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u32>(), 1600);
        let result = UpdateLayeredWindow(
            window,
            screen,
            std::ptr::null(),
            &Size {
                width: 40,
                height: 40,
            },
            dc,
            &Point { x: 0, y: 0 },
            0,
            &Blend {
                operation: 0,
                flags: 0,
                alpha: 255,
                format: 1,
            },
            2,
        ) != 0;
        SelectObject(dc, old);
        DeleteObject(bitmap);
        DeleteDC(dc);
        ReleaseDC(std::ptr::null_mut(), screen);
        result
    }
}

static POINTER_BITMAPS: OnceLock<(Vec<u32>, Vec<u32>)> = OnceLock::new();

// The repr(C) fields match pointer_motion.h. Both native renderers execute
// the same elapsed-time spring; native coordinates/input never depend on it.
#[repr(C)]
#[derive(Default)]
struct PointerMotion {
    x: f64,
    y: f64,
    velocity_x: f64,
    velocity_y: f64,
    target_x: f64,
    target_y: f64,
}
unsafe extern "C" {
    fn obf_pointer_motion_step(motion: *mut PointerMotion, dt: f64);
}
impl PointerMotion {
    fn snap(&mut self, x: f64, y: f64) {
        *self = Self {
            x,
            y,
            target_x: x,
            target_y: y,
            ..Self::default()
        };
    }
    fn advance(&mut self, dt: f64) {
        // SAFETY: the C helper only updates this repr(C) value.
        unsafe { obf_pointer_motion_step(self, dt) };
    }
    fn active(&self) -> bool {
        self.x != self.target_x
            || self.y != self.target_y
            || self.velocity_x != 0.0
            || self.velocity_y != 0.0
    }
    fn arrived(&self) -> bool {
        (self.x - self.target_x).hypot(self.y - self.target_y) < 1.0
    }
}

#[derive(Clone, Copy)]
struct PointerRequest {
    target: usize,
    x: i32,
    y: i32,
    clicked: bool,
    epoch: u64,
}
#[derive(Default)]
struct Mailbox {
    version: u64,
    epoch: u64,
    request: Option<PointerRequest>,
}
impl Mailbox {
    fn hide(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.version = self.version.wrapping_add(1);
        self.request = None;
    }
    fn show(&mut self, target: usize, x: i32, y: i32, clicked: bool) {
        self.version = self.version.wrapping_add(1);
        // A down/up pair at the same point may arrive before the renderer wakes.
        let clicked = clicked
            || self.request.is_some_and(|previous| {
                previous.target == target && previous.x == x && previous.y == y && previous.clicked
            });
        self.request = Some(PointerRequest {
            target,
            x,
            y,
            clicked,
            epoch: self.epoch,
        });
    }
    fn consume(&mut self) -> Option<PointerRequest> {
        let next = self.request;
        if let Some(request) = self.request.as_mut() {
            request.clicked = false;
        }
        next
    }
}
type FeedbackMailbox = (Mutex<Mailbox>, Condvar);
// Publish requests before starting the worker. Stop must be able to clear the
// first request even while thread creation or bitmap initialization is pending.
static MAILBOX: FeedbackMailbox = (
    Mutex::new(Mailbox {
        version: 0,
        epoch: 0,
        request: None,
    }),
    Condvar::new(),
);
static POINTER_WORKER: OnceLock<()> = OnceLock::new();

pub(super) fn hide_pointer() {
    let mut state = MAILBOX.0.lock().unwrap_or_else(|error| error.into_inner());
    state.hide();
    MAILBOX.1.notify_one();
}

/// Coalesce presentation updates on one window-owning thread. No input is
/// queued here, and Stop wakes the renderer immediately, even while idle.
pub(super) fn show_pointer(target: usize, x: i32, y: i32, clicked: bool) {
    {
        let mut state = MAILBOX.0.lock().unwrap_or_else(|error| error.into_inner());
        state.show(target, x, y, clicked);
        MAILBOX.1.notify_one();
    }
    POINTER_WORKER.get_or_init(|| {
        if let Err(error) = std::thread::Builder::new()
            .name("computer-use-pointer".into())
            .spawn(|| run_pointer(&MAILBOX))
        {
            log::warn!("Failed to start computer use pointer renderer: {error}");
        }
    });
}

fn run_pointer(mailbox: &FeedbackMailbox) {
    // SAFETY: every HWND/GDI object is owned and used on this thread. The
    // mailbox carries only integer target identities and presentation data.
    unsafe {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let mut window: Handle = std::ptr::null_mut();
        let (normal_pixels, click_pixels) =
            POINTER_BITMAPS.get_or_init(|| (pointer_pixels(false), pointer_pixels(true)));
        let mut current: Option<PointerRequest> = None;
        let mut version = 0;
        let mut motion = PointerMotion::default();
        let mut last_frame = Instant::now();
        let mut pending_click = false;
        let mut click_until = last_frame;
        let mut click_visible = false;
        let mut drawn = false;
        let mut was_visible = false;
        loop {
            let mut state = mailbox.0.lock().unwrap_or_else(|error| error.into_inner());
            if state.version == version {
                state = if current.is_none() {
                    mailbox
                        .1
                        .wait(state)
                        .unwrap_or_else(|error| error.into_inner())
                } else {
                    let interval = if motion.active() || pending_click || click_visible {
                        Duration::from_secs_f64(1.0 / 120.0)
                    } else {
                        Duration::from_millis(100)
                    };
                    mailbox
                        .1
                        .wait_timeout(state, interval)
                        .unwrap_or_else(|error| error.into_inner())
                        .0
                };
            }
            let changed = state.version != version;
            version = state.version;
            // Consume this pulse once; later status updates must not replay it.
            let next = state.consume();
            drop(state);

            let now = Instant::now();
            motion.advance(now.duration_since(last_frame).as_secs_f64());
            last_frame = now;
            let mut animations_enabled: i32 = 1;
            let reduced =
                SystemParametersInfoW(0x1042, 0, (&mut animations_enabled as *mut i32).cast(), 0)
                    != 0
                    && animations_enabled == 0; // SPI_GETCLIENTAREAANIMATION
            if changed {
                let same_target = current
                    .zip(next)
                    .is_some_and(|(old, new)| old.target == new.target && old.epoch == new.epoch);
                if !same_target {
                    if !window.is_null() {
                        ShowWindow(window, 0);
                    }
                    was_visible = false;
                    pending_click = false;
                    click_until = now;
                }
                current = next;
                if let Some(request) = current {
                    let mut bounds = Rect::default();
                    if request.target == 0
                        || GetWindowRect(request.target as Handle, &mut bounds) == 0
                    {
                        current = None;
                    } else {
                        let x = f64::from(request.x) - f64::from(bounds.left);
                        let y = f64::from(request.y) - f64::from(bounds.top);
                        if x != motion.target_x || y != motion.target_y {
                            pending_click = false;
                            click_until = now;
                        }
                        if same_target && was_visible && !reduced {
                            motion.target_x = x;
                            motion.target_y = y;
                        } else {
                            motion.snap(x, y);
                        }
                        pending_click |= request.clicked;
                    }
                }
            }
            let Some(request) = current else {
                if !window.is_null() {
                    DestroyWindow(window);
                    window = std::ptr::null_mut();
                }
                drawn = false;
                was_visible = false;
                continue;
            };
            let target = request.target as Handle;
            let mut bounds = Rect::default();
            if IsWindow(target) == 0 || GetWindowRect(target, &mut bounds) == 0 {
                DestroyWindow(window);
                window = std::ptr::null_mut();
                current = None;
                was_visible = false;
                drawn = false;
                continue;
            }
            if reduced {
                motion.snap(motion.target_x, motion.target_y);
            }
            let px = f64::from(bounds.left) + motion.x;
            let py = f64::from(bounds.top) + motion.y;
            if window.is_null() {
                // TOOLWINDOW | NOACTIVATE | TRANSPARENT | LAYERED, with a
                // disabled POPUP so WindowFromPoint skips our passive marker.
                window = CreateWindowExW(
                    0x80 | 0x08000000 | 0x20 | 0x80000,
                    class.as_ptr(),
                    std::ptr::null(),
                    0x80000000 | 0x08000000,
                    px as i32 - 8,
                    py as i32 - 8,
                    40,
                    40,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
                if window.is_null() {
                    current = None;
                    continue;
                }
                drawn = false;
            }
            SetWindowPos(
                window,
                std::ptr::null_mut(),
                px.round() as i32 - 8,
                py.round() as i32 - 8,
                40,
                40,
                0x4 | 0x10,
            ); // NOZORDER | NOACTIVATE
            let target_root = GetAncestor(target, 2);
            let visible = GetAncestor(GetForegroundWindow(), 2) == target_root
                && px - 8.0 >= f64::from(bounds.left)
                && py - 8.0 >= f64::from(bounds.top)
                && px + 32.0 <= f64::from(bounds.right)
                && py + 32.0 <= f64::from(bounds.bottom)
                && [(0, 0), (-8, -8), (31, -8), (-8, 31), (31, 31)]
                    .iter()
                    .all(|(dx, dy)| {
                        GetAncestor(
                            WindowFromPoint(Point {
                                x: px.round() as i32 + dx,
                                y: py.round() as i32 + dy,
                            }),
                            2,
                        ) == target_root
                    });
            if visible != was_visible {
                ShowWindow(window, if visible { 4 } else { 0 });
                drawn = false;
                was_visible = visible;
            }
            if pending_click && motion.arrived() {
                click_until = now + Duration::from_millis(200);
                pending_click = false;
            }
            let next_click = now < click_until;
            let click_changed = next_click != click_visible;
            click_visible = next_click;
            if visible && (!drawn || click_changed) {
                drawn = present_pointer(
                    window,
                    if click_visible {
                        &click_pixels
                    } else {
                        &normal_pixels
                    },
                );
            }
            // A persistent native window needs a responsive owner message loop.
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{pointer_pixels, Mailbox, PointerMotion};

    #[test]
    fn native_spring_preserves_motion_when_a_new_target_arrives() {
        let mut motion = PointerMotion::default();
        motion.snap(20.0, 40.0);
        motion.target_x = 400.0;
        motion.advance(0.08);
        assert!(motion.x > 20.0 && motion.x < 400.0 && motion.velocity_x > 0.0);
        let position = motion.x;
        motion.target_x = 0.0;
        motion.advance(0.001);
        assert!(motion.x > position && motion.velocity_x > 0.0);
        motion.advance(3.0);
        assert!(motion.arrived() && !motion.active());
        assert_eq!(motion.x, 0.0);
    }

    #[test]
    fn feedback_coalesces_destinations_retains_one_click_and_fences_stop() {
        let mut mailbox = Mailbox::default();
        mailbox.show(7, 100, 80, true);
        mailbox.show(7, 100, 80, false);
        assert!(mailbox.consume().unwrap().clicked);
        mailbox.show(7, 100, 80, false);
        assert!(!mailbox.consume().unwrap().clicked);
        for x in 101..200 {
            mailbox.show(7, x, 80, false);
        }
        let previous = mailbox.consume().unwrap();
        assert_eq!(previous.x, 199);
        mailbox.hide();
        assert!(mailbox.consume().is_none());
        mailbox.show(7, 199, 80, false);
        assert_ne!(mailbox.consume().unwrap().epoch, previous.epoch);
        mailbox.show(7, 200, 80, true);
        mailbox.show(8, 200, 80, false);
        assert!(!mailbox.consume().unwrap().clicked);
    }

    #[test]
    fn rounded_cursor_has_dark_fill_white_edge_and_translucent_black_shadow() {
        let pixels = pointer_pixels(false);
        assert_eq!(pixels.len(), 1600);
        assert_eq!(pixels[16 * 40 + 16], 0xff404040);
        assert!(pixels.contains(&0xffffffff));
        assert!(pixels
            .iter()
            .any(|p| p & 0xffffff == 0 && p >> 24 > 0 && p >> 24 < 115));
        assert!(pixels.iter().all(|p| p & 255 <= p >> 24));
        assert_eq!(pixels[0], 0);
        assert_ne!(pixels, pointer_pixels(true));
        // The contour is diagonal-symmetric; directional shadow offsets must
        // not bias one side. Outside each edge, black fades toward transparency.
        for y in 0..40 {
            for x in 0..40 {
                assert_eq!(pixels[y * 40 + x], pixels[x * 40 + y]);
            }
        }
        for ray in [
            [(12, 5), (12, 4), (12, 3)],
            [(5, 12), (4, 12), (3, 12)],
            [(28, 16), (29, 16), (30, 16)],
            [(16, 28), (16, 29), (16, 30)],
        ] {
            let alpha = ray.map(|(x, y)| {
                let pixel = pixels[y * 40 + x];
                assert_eq!(pixel & 0xffffff, 0);
                pixel >> 24
            });
            assert!(alpha[0] > alpha[1] && alpha[1] > alpha[2] && alpha[2] > 0);
        }
    }
}
