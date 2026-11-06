//! CEF only exposes per-pixel alpha through windowless rendering. Keep the
//! pet's Tauri page and IPC, and present its premultiplied BGRA frames natively.

mod input;
mod paint;

use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
};

use tauri_runtime_cef::{
    cef::{self, rc::Rc, ImplBrowser, ImplRenderHandler, RenderHandler, WrapRenderHandler},
    AsCefWebviewAttributes, Offscreen, OffscreenView,
};
use winit::{
    cursor::CursorIcon,
    dpi::PhysicalPosition,
    event::WindowEvent,
    event_loop::ActiveEventLoop,
    window::{Window, WindowId},
};

use crate::appearance::AGENT_COMPANION_WINDOW_LABEL;

struct Frame {
    width: i32,
    height: i32,
    pixels: Vec<u8>,
}

struct Surface {
    id: WindowId,
    host: cef::BrowserHost,
    input: input::Input,
    frame: Option<Frame>,
    paint_failed: bool,
}

// Both CEF's external pump and the native window events run on the UI thread.
thread_local! {
    static SURFACE: RefCell<Option<Surface>> = const { RefCell::new(None) };
}

pub(crate) fn configure<R, M>(
    builder: &mut tauri::WebviewWindowBuilder<'_, R, M>,
) -> Result<(), String>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
    R::RuntimeWebviewAttributes: AsCefWebviewAttributes,
{
    let attributes = builder
        .runtime_specific_attributes_mut()
        .as_cef_webview_attributes_mut()
        .ok_or("The transparent Agent companion window requires the CEF runtime")?;
    let cursor_view = Arc::new(Mutex::new(None::<OffscreenView>));
    let handler_view = Arc::clone(&cursor_view);
    let mut offscreen = Offscreen::new(move |view| {
        if let Ok(mut slot) = handler_view.lock() {
            *slot = Some(view.clone());
        }
        PetPaint::new(view)
    });
    offscreen.cursor_handler = Some(Arc::new(move |cursor, _| {
        let Some(window) = cursor_view
            .lock()
            .ok()
            .and_then(|view| view.as_ref()?.window())
        else {
            return;
        };
        let icon = match cursor {
            cef::CursorType::HAND => CursorIcon::Pointer,
            cef::CursorType::IBEAM => CursorIcon::Text,
            cef::CursorType::GRAB => CursorIcon::Grab,
            cef::CursorType::GRABBING => CursorIcon::Grabbing,
            _ => CursorIcon::Default,
        };
        window.set_cursor(icon.into());
    }));
    attributes.offscreen = Some(offscreen);
    Ok(())
}

pub(crate) fn on_window_event(
    label: &str,
    _event_loop: &dyn ActiveEventLoop,
    window: Arc<dyn Window>,
    event: &WindowEvent,
) {
    if label != AGENT_COMPANION_WINDOW_LABEL {
        return;
    }
    let id = window.id();

    // Do not keep a RefCell borrow across native or CEF calls. Either can
    // synchronously deliver another event.
    if matches!(event, WindowEvent::Destroyed) {
        drop(SURFACE.with_borrow_mut(|state| {
            if state.as_ref().is_some_and(|surface| surface.id == id) {
                state.take()
            } else {
                None
            }
        }));
        return;
    }
    if matches!(event, WindowEvent::RedrawRequested) {
        let frame = SURFACE.with_borrow_mut(|state| {
            state
                .as_mut()
                .filter(|surface| surface.id == id)?
                .frame
                .take()
        });
        if let Some(frame) = frame {
            // A resize may land between the paint and this redraw. Presenting an
            // old-size frame can stretch the pet or even resize a layered HWND.
            let size = window.surface_size();
            let tolerance = window.scale_factor().ceil() as u32;
            if size.width.abs_diff(frame.width as u32) <= tolerance
                && size.height.abs_diff(frame.height as u32) <= tolerance
            {
                if let Err(error) = paint::present(window.as_ref(), frame) {
                    let first_failure = SURFACE.with_borrow_mut(|state| {
                        state
                            .as_mut()
                            .filter(|surface| surface.id == id)
                            .is_some_and(|surface| {
                                !std::mem::replace(&mut surface.paint_failed, true)
                            })
                    });
                    if first_failure {
                        log::warn!("Failed to paint Agent companion window: {error}");
                    }
                }
            }
        }
        return;
    }

    let scale = window.scale_factor();
    let dispatch = SURFACE.with_borrow_mut(|state| {
        let surface = state.as_mut().filter(|surface| surface.id == id)?;
        let input = surface.input.translate(scale, event)?;
        Some((surface.host.clone(), input))
    });
    if let Some((host, input)) = dispatch {
        input.send(window.as_ref(), &host);
    }
}

fn frame_byte_len(width: i32, height: i32) -> Option<usize> {
    let pixels = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?;
    (pixels > 0 && pixels <= 8_000_000).then(|| pixels * 4)
}

fn view_origin(window: &dyn Window) -> Option<cef::Point> {
    let outer = window.outer_position().ok()?;
    let surface = window.surface_position();
    let position = PhysicalPosition::new(outer.x + surface.x, outer.y + surface.y);
    #[cfg(target_os = "macos")]
    let position = position.to_logical::<i32>(window.scale_factor());
    Some(cef::Point {
        x: position.x,
        y: position.y,
    })
}

cef::wrap_render_handler! {
    struct PetPaint {
        view: OffscreenView,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut cef::Browser>, rect: Option<&mut cef::Rect>) {
            if let Some(rect) = rect {
                let size = self.view.bounds().size.to_logical::<i32>(1.0);
                *rect = cef::Rect { x: 0, y: 0, width: size.width.max(1), height: size.height.max(1) };
            }
        }

        fn screen_info(&self, _browser: Option<&mut cef::Browser>, info: Option<&mut cef::ScreenInfo>) -> i32 {
            let (Some(window), Some(info)) = (self.view.window(), info) else {
                return 0;
            };
            info.device_scale_factor = window.scale_factor() as f32;
            1
        }

        fn screen_point(
            &self,
            _browser: Option<&mut cef::Browser>,
            x: i32,
            y: i32,
            screen_x: Option<&mut i32>,
            screen_y: Option<&mut i32>,
        ) -> i32 {
            let (Some(window), Some(screen_x), Some(screen_y)) = (self.view.window(), screen_x, screen_y) else {
                return 0;
            };
            let Some(origin) = view_origin(window.as_ref()) else { return 0 };
            #[cfg(not(target_os = "macos"))]
            let (x, y) = {
                let scale = window.scale_factor();
                ((f64::from(x) * scale).round() as i32, (f64::from(y) * scale).round() as i32)
            };
            *screen_x = origin.x + x;
            *screen_y = origin.y + y;
            1
        }

        fn on_ime_composition_range_changed(
            &self,
            _browser: Option<&mut cef::Browser>,
            _selection: Option<&cef::Range>,
            character_bounds: Option<&[cef::Rect]>,
        ) {
            if let (Some(window), Some(caret)) = (self.view.window(), character_bounds.and_then(|rects| rects.last())) {
                input::position_ime(window.as_ref(), caret);
            }
        }

        fn on_paint(
            &self,
            browser: Option<&mut cef::Browser>,
            kind: cef::PaintElementType,
            _dirty_rects: Option<&[cef::Rect]>,
            buffer: *const u8,
            width: i32,
            height: i32,
        ) {
            if kind != cef::PaintElementType::VIEW || buffer.is_null() || !self.view.is_visible() {
                return;
            }
            let (Some(window), Some(len)) = (self.view.window(), frame_byte_len(width, height)) else {
                return;
            };
            let Some(host) = browser.and_then(|browser| browser.host()) else { return };
            // CEF owns the top-down BGRA buffer only for this callback.
            let pixels = unsafe { std::slice::from_raw_parts(buffer, len) }.to_vec();
            let frame = Frame { width, height, pixels };
            let id = window.id();
            let initialize = SURFACE.with_borrow_mut(|state| {
                if let Some(surface) = state.as_mut().filter(|surface| surface.id == id) {
                    surface.frame = Some(frame);
                    return false;
                }
                *state = Some(Surface {
                    id,
                    host: host.clone(),
                    input: input::Input::default(),
                    frame: Some(frame),
                    paint_failed: false,
                });
                true
            });
            if initialize {
                #[cfg(target_os = "linux")]
                input::install_gtk_ime(window.as_ref());
                if window.has_focus() {
                    input::Dispatch::Focus(true).send(window.as_ref(), &host);
                }
            }
            window.request_redraw();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::frame_byte_len;

    #[test]
    fn companion_paint_rejects_invalid_buffer_dimensions() {
        assert_eq!(frame_byte_len(720, 480), Some(720 * 480 * 4));
        assert_eq!(frame_byte_len(0, 480), None);
        assert_eq!(frame_byte_len(720, -1), None);
        assert_eq!(frame_byte_len(i32::MAX, i32::MAX), None);
    }
}
