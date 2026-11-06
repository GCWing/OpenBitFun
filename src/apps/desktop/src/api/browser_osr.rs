//! Controller-local presentation for the desktop Chromium browser.

use serde::Deserialize;
use std::sync::{Arc, Weak};
use tauri::ipc::Response;
use tauri::Emitter;
use tauri_runtime_cef::AsCefWebviewAttributes;

use super::browser_api::{
    find_browser_webview, offscreen_frame_stream, validate_browser_label, BrowserPresentation,
};

mod frames;
#[cfg(target_os = "macos")]
mod texture_bridge;
pub(super) use frames::FrameStream;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsrFrameRequest {
    label: String,
    after_revision: u32,
    #[serde(default)]
    protocol: u8,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Input {
    Redraw,
    Move {
        pointer: Pointer,
    },
    Button {
        pointer: Pointer,
        button: MouseButton,
        up: bool,
        clicks: i32,
    },
    Wheel {
        pointer: Pointer,
        delta_x: i32,
        delta_y: i32,
    },
    Leave,
    Focus {
        focused: bool,
    },
    Key {
        key: String,
        code: String,
        virtual_key: u32,
        modifiers: u32,
        location: u32,
        repeat: bool,
        up: bool,
        text: String,
    },
    Composition {
        text: String,
        commit: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    modifiers: u32,
    #[serde(default)]
    panel_origin: Option<(i32, i32)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Deserialize)]
pub struct OsrInputRequest {
    label: String,
    events: Vec<Input>,
}

fn check_caller(caller: &tauri::Webview, label: &str) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("Only the main workbench can present a browser surface".into());
    }
    validate_browser_label(label)
}

fn frame_stream(label: &str) -> Result<Arc<FrameStream>, String> {
    offscreen_frame_stream(label)
        .and_then(|stream| stream.upgrade())
        .ok_or_else(|| "Offscreen presentation is unavailable for this browser".into())
}

/// Long-poll the latest frame. A stalled consumer holds no backlog of old frames.
#[tauri::command]
pub async fn browser_webview_osr_frame(
    caller: tauri::Webview,
    request: OsrFrameRequest,
) -> Result<Response, String> {
    check_caller(&caller, &request.label)?;
    let stream = frame_stream(&request.label)?;
    if stream.shared_texture() {
        return Err("The shared-texture browser does not expose CPU frames".into());
    }
    Ok(Response::new(
        stream.next(request.after_revision, request.protocol).await,
    ))
}

/// Dispatch a bounded batch in order on the CEF UI thread.
#[tauri::command]
pub async fn browser_webview_osr_input(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    request: OsrInputRequest,
) -> Result<(), String> {
    check_caller(&caller, &request.label)?;
    let frames = frame_stream(&request.label)?;
    if request.events.len() > 32 {
        return Err("Too many offscreen browser input events".into());
    }
    let webview = find_browser_webview(&app, &request.label)?;
    #[cfg(target_os = "macos")]
    if frames.shared_texture()
        && request
            .events
            .iter()
            .any(|event| matches!(event, Input::Redraw))
    {
        let url = caller.url().map_err(|error| error.to_string())?;
        if super::browser_api::browser_navigation_allowed(&app, &url) {
            return Err("The texture consumer must be the trusted workbench document".into());
        }
        texture_bridge::bind(
            &caller,
            &webview,
            &request.label,
            &url.origin().ascii_serialization(),
        )
        .await?;
        frames.publish_ui();
    }
    cef_surface::send_input(webview, frames, request.events).await
}

pub(super) fn presentation(stream: &Weak<FrameStream>) -> BrowserPresentation {
    if stream
        .upgrade()
        .is_some_and(|frames| frames.shared_texture())
    {
        BrowserPresentation::OffscreenGpu
    } else {
        BrowserPresentation::Offscreen
    }
}

pub(super) fn configure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    builder: &mut tauri::webview::WebviewBuilder<R>,
    label: &str,
) -> Result<Option<Weak<FrameStream>>, String>
where
    R::RuntimeWebviewAttributes: AsCefWebviewAttributes,
{
    let mode = std::env::var_os("OPENBITFUN_BROWSER_OSR");
    if validate_browser_label(label).is_ok() && !mode.as_deref().is_some_and(|mode| mode == "0") {
        let shared_texture = mode.as_deref().is_some_and(|mode| mode == "gpu");
        if shared_texture {
            #[cfg(target_os = "macos")]
            texture_bridge::require()?;
            #[cfg(not(target_os = "macos"))]
            return Err("CEF shared-texture presentation is only available on macOS".into());
        }
        let attributes = builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("Offscreen presentation requires the CEF runtime")?;
        let send_ui = shared_texture.then(|| {
            let app = app.clone();
            let event = format!("browser-osr-ui-{label}");
            Box::new(move |ui| {
                let _ = app.emit_to("main", &event, ui);
            }) as Box<dyn Fn(frames::SurfaceUi) + Send + Sync>
        });
        return Ok(Some(cef_surface::configure(
            attributes,
            FrameStream::new(send_ui),
        )));
    }

    Ok(None)
}

mod cef_surface {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc as LocalRc;
    use tauri_runtime_cef::cef::{
        self, rc::Rc, Browser, BrowserHost, CursorType, ImplBrowser, ImplBrowserHost,
        ImplRenderHandler, MouseButtonType, PaintElementType, RenderHandler, WrapRenderHandler,
    };
    use tauri_runtime_cef::{CefWebviewAttributes, Offscreen, OffscreenView, WebviewCefExt};

    use super::frames::{frame_byte_len, ViewportHistory};
    use tauri_runtime_cef::allocate_devtools_message_id;

    pub(super) fn configure(
        attributes: &mut CefWebviewAttributes,
        frames: FrameStream,
    ) -> Weak<FrameStream> {
        let frames = Arc::new(frames);
        let paint_frames = frames.clone();
        let mut offscreen = Offscreen::new(move |view| {
            BrowserPaint::new(
                view,
                paint_frames.clone(),
                LocalRc::default(),
                LocalRc::default(),
            )
        });
        let cursor_frames = frames.clone();
        offscreen.cursor_handler = Some(Arc::new(move |cursor, _| {
            cursor_frames.cursor(cursor_id(cursor))
        }));
        offscreen.shared_texture_enabled = frames.shared_texture();
        attributes.offscreen = Some(offscreen);
        attributes.browser_settings_callback = Some(Arc::new(|settings| {
            settings.windowless_frame_rate = 60;
        }));
        Arc::downgrade(&frames)
    }

    fn view_size(size: tauri::Size) -> (i32, i32) {
        let logical = size.to_logical::<f64>(1.0);
        (
            logical.width.round().max(1.0) as i32,
            logical.height.round().max(1.0) as i32,
        )
    }

    cef::wrap_render_handler! {
        struct BrowserPaint {
            view: OffscreenView,
            frames: Arc<FrameStream>,
            viewports: LocalRc<RefCell<ViewportHistory>>,
            missed_paint: LocalRc<Cell<bool>>,
        }

        impl RenderHandler {
            fn view_rect(&self, _browser: Option<&mut cef::Browser>, rect: Option<&mut cef::Rect>) {
                if let Some(rect) = rect {
                    let (width, height) = view_size(self.view.bounds().size);
                    if let Some(window) = self.view.window() {
                        self.viewports.borrow_mut().requested((width, height), window.scale_factor() as f32);
                    }
                    *rect = cef::Rect { x: 0, y: 0, width, height };
                }
            }

            fn screen_info(
                &self,
                _browser: Option<&mut cef::Browser>,
                info: Option<&mut cef::ScreenInfo>,
            ) -> i32 {
                let (Some(info), Some(window)) = (info, self.view.window()) else {
                    return 0;
                };
                info.device_scale_factor = window.scale_factor() as f32;
                1
            }

            fn screen_point(&self, _browser: Option<&mut Browser>, x: i32, y: i32, screen_x: Option<&mut i32>, screen_y: Option<&mut i32>) -> i32 {
                let (Some(window), Some(screen_x), Some(screen_y)) = (self.view.window(), screen_x, screen_y) else { return 0 };
                let Ok(mut origin) = window.outer_position() else { return 0 };
                let surface = window.surface_position();
                origin.x = origin.x.saturating_add(surface.x);
                origin.y = origin.y.saturating_add(surface.y);
                let scale = window.scale_factor();
                let fallback = self.view.bounds().position.to_logical::<i32>(scale);
                let (panel_x, panel_y) = self.frames.panel_origin().unwrap_or((fallback.x, fallback.y));
                if cfg!(target_os = "macos") {
                    let origin = origin.to_logical::<i32>(scale);
                    *screen_x = origin.x.saturating_add(panel_x).saturating_add(x);
                    *screen_y = origin.y.saturating_add(panel_y).saturating_add(y);
                } else {
                    *screen_x = origin.x.saturating_add((f64::from(panel_x.saturating_add(x)) * scale).round() as i32);
                    *screen_y = origin.y.saturating_add((f64::from(panel_y.saturating_add(y)) * scale).round() as i32);
                }
                1
            }

            fn on_popup_show(&self, _browser: Option<&mut Browser>, show: i32) {
                self.frames.popup_visibility(show != 0);
            }

            fn on_popup_size(&self, _browser: Option<&mut Browser>, rect: Option<&cef::Rect>) {
                if let (Some(rect), Some(window)) = (rect, self.view.window()) {
                    let scale = window.scale_factor();
                    self.frames.popup_origin(((f64::from(rect.x) * scale).round() as i32, (f64::from(rect.y) * scale).round() as i32));
                }
            }

            fn on_ime_composition_range_changed(&self, _browser: Option<&mut Browser>, _selection: Option<&cef::Range>, bounds: Option<&[cef::Rect]>) {
                self.frames.caret(bounds.and_then(|rects| rects.last()).map(|rect| (rect.x + rect.width, rect.y + rect.height)));
            }

            fn on_paint(
                &self,
                _browser: Option<&mut Browser>,
                kind: PaintElementType,
                dirty: Option<&[cef::Rect]>,
                buffer: *const u8,
                width: i32,
                height: i32,
            ) {
                if self.frames.shared_texture() || buffer.is_null() || !self.view.is_visible() { return; }
                let Some(len) = frame_byte_len(width, height) else { return };
                // SAFETY: CEF supplies width * height BGRA pixels for this callback.
                let pixels = unsafe { std::slice::from_raw_parts(buffer, len) };
                let dirty = dirty.unwrap_or_default();
                if kind == PaintElementType::POPUP {
                    self.frames.popup((width, height), pixels, dirty);
                    return;
                }
                let Some(window) = self.view.window() else { return };
                let logical = self.viewports.borrow_mut().painted((width, height), window.scale_factor() as f32);
                if let Some(logical) = logical {
                    // CEF reports damage relative to its preceding capture,
                    // which may be a frame we declined to display.
                    let dirty = if self.missed_paint.replace(false) { &[] } else { dirty };
                    self.frames.view((width, height), logical, pixels, dirty);
                } else {
                    self.missed_paint.set(true);
                }
            }
        }
    }

    fn cursor_id(cursor: CursorType) -> u32 {
        match cursor {
            CursorType::HAND => 1,
            CursorType::IBEAM => 2,
            CursorType::CROSS => 3,
            CursorType::WAIT => 4,
            CursorType::NOTALLOWED | CursorType::NODROP => 5,
            CursorType::GRAB => 6,
            CursorType::GRABBING => 7,
            CursorType::EASTWESTRESIZE
            | CursorType::EASTRESIZE
            | CursorType::WESTRESIZE
            | CursorType::COLUMNRESIZE => 8,
            CursorType::NORTHSOUTHRESIZE
            | CursorType::NORTHRESIZE
            | CursorType::SOUTHRESIZE
            | CursorType::ROWRESIZE => 9,
            CursorType::NORTHEASTSOUTHWESTRESIZE
            | CursorType::NORTHEASTRESIZE
            | CursorType::SOUTHWESTRESIZE => 10,
            CursorType::NORTHWESTSOUTHEASTRESIZE
            | CursorType::NORTHWESTRESIZE
            | CursorType::SOUTHEASTRESIZE => 11,
            CursorType::MOVE => 12,
            CursorType::NONE => 13,
            CursorType::PROGRESS => 14,
            _ => 0,
        }
    }

    pub(super) async fn send_input(
        webview: tauri::Webview,
        frames: Arc<FrameStream>,
        events: Vec<Input>,
    ) -> Result<(), String> {
        let (result, reply) = tokio::sync::oneshot::channel();
        webview
            .with_cef_webview(move |native| {
                let Some(host) = native.browser().host() else {
                    let _ = result.send(Err("CEF browser host is unavailable".into()));
                    return;
                };
                let snapshot = native.snapshot();
                let viewport = snapshot
                    .visible
                    .filter(|visible| *visible)
                    .and(snapshot.bounds)
                    .map(|bounds| view_size(bounds.size));
                let sent = events
                    .into_iter()
                    .try_for_each(|event| dispatch(&host, &frames, viewport, event));
                let _ = result.send(sent);
            })
            .map_err(|error| error.to_string())?;
        reply
            .await
            .map_err(|_| "The offscreen browser was closed".to_string())?
    }

    fn mouse_event(viewport: Option<(i32, i32)>, pointer: &Pointer) -> Option<cef::MouseEvent> {
        let (width, height) = viewport?;
        if (width, height) != (pointer.width, pointer.height)
            || !(0..width).contains(&pointer.x)
            || !(0..height).contains(&pointer.y)
        {
            return None;
        }
        Some(cef::MouseEvent {
            x: pointer.x,
            y: pointer.y,
            modifiers: pointer.modifiers & 0xfe,
        })
    }

    fn dispatch(
        host: &BrowserHost,
        frames: &FrameStream,
        viewport: Option<(i32, i32)>,
        event: Input,
    ) -> Result<(), String> {
        if let Input::Move { pointer }
        | Input::Button { pointer, .. }
        | Input::Wheel { pointer, .. } = &event
        {
            if let Some(origin) = pointer.panel_origin {
                frames.set_panel_origin(origin);
            }
        }
        match event {
            Input::Redraw if frames.shared_texture() && viewport.is_some() => {
                host.invalidate(PaintElementType::VIEW);
            }
            Input::Redraw => {}
            Input::Move { pointer } => {
                if let Some(mouse) = mouse_event(viewport, &pointer) {
                    host.send_mouse_move_event(Some(&mouse), 0);
                }
            }
            Input::Button {
                pointer,
                button,
                up,
                clicks,
            } => {
                if let Some(mouse) = mouse_event(viewport, &pointer) {
                    let button = match button {
                        MouseButton::Left => MouseButtonType::LEFT,
                        MouseButton::Middle => MouseButtonType::MIDDLE,
                        MouseButton::Right => MouseButtonType::RIGHT,
                    };
                    host.send_mouse_click_event(
                        Some(&mouse),
                        button,
                        i32::from(up),
                        clicks.clamp(1, 3),
                    );
                } else if up {
                    host.send_capture_lost_event();
                }
            }
            Input::Wheel {
                pointer,
                delta_x,
                delta_y,
            } => {
                if let Some(mouse) = mouse_event(viewport, &pointer) {
                    host.send_mouse_wheel_event(Some(&mouse), delta_x, delta_y);
                }
            }
            Input::Leave => {
                host.send_mouse_move_event(
                    Some(&cef::MouseEvent {
                        x: -1,
                        y: -1,
                        modifiers: 0,
                    }),
                    1,
                );
                host.send_capture_lost_event();
            }
            Input::Focus { focused } => {
                if !focused {
                    host.ime_cancel_composition();
                    host.send_capture_lost_event();
                }
                host.set_focus(i32::from(focused && viewport.is_some()));
            }
            Input::Key {
                key,
                code,
                virtual_key,
                modifiers,
                location,
                repeat,
                up,
                text,
            } if viewport.is_some() => {
                let id = allocate_devtools_message_id().map_err(|error| error.to_string())?;
                let kind = if up {
                    "keyUp"
                } else if text.is_empty() {
                    "rawKeyDown"
                } else {
                    "keyDown"
                };
                let mut params = serde_json::json!({
                    "type": kind, "key": key, "code": code,
                    "windowsVirtualKeyCode": virtual_key, "modifiers": modifiers & 15,
                    "location": location.min(2), "isKeypad": location == 3, "autoRepeat": repeat,
                });
                if !up && !text.is_empty() {
                    params["text"] = text.into();
                }
                let primary = if cfg!(target_os = "macos") { 4 } else { 2 };
                if !up && modifiers & 7 == primary {
                    let command = match (code.as_str(), modifiers & 8 != 0) {
                        ("KeyA", false) => Some("SelectAll"),
                        ("KeyC", false) => Some("Copy"),
                        ("KeyV", false) => Some("Paste"),
                        ("KeyX", false) => Some("Cut"),
                        ("KeyZ", false) => Some("Undo"),
                        ("KeyZ", true) | ("KeyY", false) => Some("Redo"),
                        _ => None,
                    };
                    if let Some(command) = command {
                        params["commands"] = serde_json::json!([command]);
                    }
                }
                let message = serde_json::json!({ "id": id, "method": "Input.dispatchKeyEvent", "params": params }).to_string();
                if host.send_dev_tools_message(Some(message.as_bytes())) != 1 {
                    return Err("Chromium rejected the browser keyboard event".into());
                }
            }
            Input::Composition { text, commit } if viewport.is_some() => {
                let length = text.encode_utf16().count() as u32;
                let text = cef::CefString::from(text.as_str());
                if length == 0 {
                    host.ime_cancel_composition();
                } else if commit {
                    host.ime_commit_text(Some(&text), None, 0);
                } else {
                    let selection = cef::Range {
                        from: length,
                        to: length,
                    };
                    let underline = cef::CompositionUnderline {
                        range: cef::Range {
                            from: 0,
                            to: length,
                        },
                        style: cef::CompositionUnderlineStyle::SOLID,
                        ..Default::default()
                    };
                    host.ime_set_composition(
                        Some(&text),
                        Some(&[underline]),
                        None,
                        Some(&selection),
                    );
                }
            }
            _ => {}
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mouse_events_match_only_the_displayed_viewport() {
            let pointer = || Pointer {
                x: 8,
                y: 4,
                width: 20,
                height: 10,
                modifiers: 16,
                panel_origin: None,
            };
            assert!(mouse_event(None, &pointer()).is_none());
            assert!(mouse_event(Some((21, 10)), &pointer()).is_none());
            let event = mouse_event(Some((20, 10)), &pointer()).unwrap();
            assert_eq!((event.x, event.y, event.modifiers), (8, 4, 16));
        }
    }
}
