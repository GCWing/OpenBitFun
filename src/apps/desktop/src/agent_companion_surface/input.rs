use tauri_runtime_cef::cef::{
    self, sys::cef_event_flags_t as Flag, BrowserHost, ImplBrowserHost, KeyEventType,
    MouseButtonType,
};
use winit::{
    dpi::PhysicalPosition,
    event::{ButtonSource, Ime, KeyEvent, MouseButton, MouseScrollDelta, WindowEvent},
    keyboard::{Key, KeyLocation, ModifiersState, NamedKey},
    platform::scancode::PhysicalKeyExtScancode,
    window::Window,
};

#[cfg(not(target_os = "linux"))]
use winit::{
    dpi::{LogicalPosition, LogicalSize},
    window::{ImeCapabilities, ImeEnableRequest, ImeRequest, ImeRequestData},
};

#[derive(Default)]
pub(super) struct Input {
    position: PhysicalPosition<f64>,
    buttons: u32,
    modifiers: ModifiersState,
}

pub(super) enum Dispatch {
    Focus(bool),
    Move(cef::MouseEvent, bool),
    Button(cef::MouseEvent, MouseButtonType, bool),
    Wheel(cef::MouseEvent, i32, i32),
    Key(cef::KeyEvent, String),
    Ime(Ime),
}

impl Input {
    fn flags(&self) -> u32 {
        let mut flags = self.buttons;
        for (active, flag) in [
            (self.modifiers.shift_key(), Flag::EVENTFLAG_SHIFT_DOWN),
            (self.modifiers.control_key(), Flag::EVENTFLAG_CONTROL_DOWN),
            (self.modifiers.alt_key(), Flag::EVENTFLAG_ALT_DOWN),
            (self.modifiers.meta_key(), Flag::EVENTFLAG_COMMAND_DOWN),
        ] {
            if active {
                flags |= flag.0 as u32;
            }
        }
        flags
    }

    fn mouse(&self, scale: f64) -> cef::MouseEvent {
        let position = self.position.to_logical::<i32>(scale);
        cef::MouseEvent {
            x: position.x,
            y: position.y,
            modifiers: self.flags(),
        }
    }

    pub(super) fn translate(&mut self, scale: f64, event: &WindowEvent) -> Option<Dispatch> {
        Some(match event {
            WindowEvent::Focused(focused) => {
                if !focused {
                    *self = Self::default();
                }
                Dispatch::Focus(*focused)
            }
            WindowEvent::ModifiersChanged(modifiers) => {
                self.modifiers = modifiers.state();
                return None;
            }
            WindowEvent::PointerMoved {
                position,
                primary: true,
                ..
            }
            | WindowEvent::PointerEntered {
                position,
                primary: true,
                ..
            } => {
                self.position = *position;
                Dispatch::Move(self.mouse(scale), false)
            }
            WindowEvent::PointerLeft {
                position,
                primary: true,
                ..
            } => {
                if let Some(position) = position {
                    self.position = *position;
                }
                Dispatch::Move(self.mouse(scale), true)
            }
            WindowEvent::PointerButton {
                position,
                state,
                button: ButtonSource::Mouse(button),
                ..
            } => {
                self.position = *position;
                let (button, flag) = match button {
                    MouseButton::Left => (MouseButtonType::LEFT, Flag::EVENTFLAG_LEFT_MOUSE_BUTTON),
                    MouseButton::Right => {
                        (MouseButtonType::RIGHT, Flag::EVENTFLAG_RIGHT_MOUSE_BUTTON)
                    }
                    MouseButton::Middle => {
                        (MouseButtonType::MIDDLE, Flag::EVENTFLAG_MIDDLE_MOUSE_BUTTON)
                    }
                    _ => return None,
                };
                let down = state.is_pressed();
                if down {
                    self.buttons |= flag.0 as u32;
                } else {
                    self.buttons &= !(flag.0 as u32);
                }
                Dispatch::Button(self.mouse(scale), button, !down)
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let mut mouse = self.mouse(scale);
                let (x, y) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => ((x * 120.0) as i32, (y * 120.0) as i32),
                    MouseScrollDelta::PixelDelta(position) => {
                        mouse.modifiers |= Flag::EVENTFLAG_PRECISION_SCROLLING_DELTA.0 as u32;
                        let position = position.to_logical::<i32>(scale);
                        (position.x, position.y)
                    }
                    _ => return None,
                };
                Dispatch::Wheel(mouse, x, y)
            }
            WindowEvent::KeyboardInput {
                event,
                is_synthetic: false,
                ..
            } => {
                let key = key_event(event, self.flags());
                let text = if event.state.is_pressed()
                    && !self.modifiers.meta_key()
                    && (!self.modifiers.control_key() || self.modifiers.alt_key())
                {
                    event.text.as_deref().unwrap_or_default()
                } else {
                    ""
                };
                Dispatch::Key(key, text.to_owned())
            }
            WindowEvent::Ime(ime) => Dispatch::Ime(ime.clone()),
            _ => return None,
        })
    }
}

impl Dispatch {
    pub(super) fn send(self, _window: &dyn Window, host: &BrowserHost) {
        match self {
            Self::Focus(focused) => {
                host.set_focus(i32::from(focused));
                #[cfg(not(target_os = "linux"))]
                set_ime_focus(_window, focused);
                if !focused {
                    host.send_capture_lost_event();
                }
            }
            Self::Move(mouse, leaving) => {
                host.send_mouse_move_event(Some(&mouse), i32::from(leaving))
            }
            Self::Button(mouse, button, up) => {
                host.send_mouse_click_event(Some(&mouse), button, i32::from(up), 1)
            }
            Self::Wheel(mouse, x, y) => host.send_mouse_wheel_event(Some(&mouse), x, y),
            Self::Key(mut event, text) => {
                host.send_key_event(Some(&event));
                event.type_ = KeyEventType::CHAR;
                for character in text
                    .encode_utf16()
                    .filter(|code| *code >= 0x20 && *code != 0x7f)
                {
                    event.character = character;
                    event.windows_key_code = i32::from(character);
                    host.send_key_event(Some(&event));
                }
            }
            Self::Ime(ime) => send_ime(host, ime),
        }
    }
}

fn send_ime(host: &BrowserHost, ime: Ime) {
    match ime {
        Ime::Preedit(text, selection) if !text.is_empty() => {
            let text_len = text.encode_utf16().count() as u32;
            let cursor = |byte| {
                text.get(..byte)
                    .map_or(text_len, |prefix| prefix.encode_utf16().count() as u32)
            };
            let (from, to) = selection.map_or((text_len, text_len), |(from, to)| {
                (cursor(from), cursor(to))
            });
            let underline = cef::CompositionUnderline {
                range: cef::Range {
                    from: 0,
                    to: text_len,
                },
                color: 0xff00_0000,
                ..Default::default()
            };
            host.ime_set_composition(
                Some(&cef::CefString::from(text.as_str())),
                Some(&[underline]),
                None,
                Some(&cef::Range { from, to }),
            );
        }
        Ime::Preedit(..) | Ime::Disabled => host.ime_cancel_composition(),
        Ime::Commit(text) => {
            host.ime_commit_text(Some(&cef::CefString::from(text.as_str())), None, 0);
        }
        _ => {}
    }
}

fn key_event(event: &KeyEvent, mut modifiers: u32) -> cef::KeyEvent {
    let location = match event.location {
        KeyLocation::Left => Flag::EVENTFLAG_IS_LEFT,
        KeyLocation::Right => Flag::EVENTFLAG_IS_RIGHT,
        KeyLocation::Numpad => Flag::EVENTFLAG_IS_KEY_PAD,
        _ => Flag::EVENTFLAG_NONE,
    };
    modifiers |= location.0 as u32;
    if event.repeat {
        modifiers |= Flag::EVENTFLAG_IS_REPEAT.0 as u32;
    }

    let text = event.text_with_all_modifiers.as_deref().unwrap_or_default();
    let unmodified = event.key_without_modifiers.to_text().unwrap_or_default();
    let code = event.physical_key.to_scancode().unwrap_or_default() as i32;
    #[cfg(target_os = "windows")]
    let code = 1
        | ((code & 0xff) << 16)
        | (i32::from(code > 0xff) << 24)
        | if event.state.is_pressed() { 0 } else { 3 << 30 };
    #[cfg(target_os = "linux")]
    let code = code + 8; // CEF expects X11 keycodes.

    cef::KeyEvent {
        type_: if event.state.is_pressed() {
            KeyEventType::RAWKEYDOWN
        } else {
            KeyEventType::KEYUP
        },
        modifiers,
        windows_key_code: windows_key_code(&event.key_without_modifiers),
        native_key_code: code,
        character: text.encode_utf16().next().unwrap_or_default(),
        unmodified_character: unmodified.encode_utf16().next().unwrap_or_default(),
        ..Default::default()
    }
}

fn windows_key_code(key: &Key) -> i32 {
    match key {
        Key::Named(NamedKey::Backspace) => 0x08,
        Key::Named(NamedKey::Tab) => 0x09,
        Key::Named(NamedKey::Enter) => 0x0d,
        Key::Named(NamedKey::Escape) => 0x1b,
        Key::Character(text) if text == " " => 0x20,
        Key::Named(NamedKey::PageUp) => 0x21,
        Key::Named(NamedKey::PageDown) => 0x22,
        Key::Named(NamedKey::End) => 0x23,
        Key::Named(NamedKey::Home) => 0x24,
        Key::Named(NamedKey::ArrowLeft) => 0x25,
        Key::Named(NamedKey::ArrowUp) => 0x26,
        Key::Named(NamedKey::ArrowRight) => 0x27,
        Key::Named(NamedKey::ArrowDown) => 0x28,
        Key::Named(NamedKey::Delete) => 0x2e,
        Key::Character(text) => text
            .bytes()
            .next()
            .filter(u8::is_ascii_alphanumeric)
            .map_or(0, |byte| i32::from(byte.to_ascii_uppercase())),
        _ => 0,
    }
}

#[cfg(not(target_os = "linux"))]
fn set_ime_focus(window: &dyn Window, focused: bool) {
    let request = if focused {
        let capabilities = ImeCapabilities::new().with_cursor_area();
        let data = ImeRequestData::default().with_cursor_area(
            LogicalPosition::new(0, 0).into(),
            LogicalSize::new(1, 1).into(),
        );
        let Some(enable) = ImeEnableRequest::new(capabilities, data) else {
            return;
        };
        ImeRequest::Enable(enable)
    } else {
        ImeRequest::Disable
    };
    let _ = window.request_ime_update(request);
}

#[cfg(not(target_os = "linux"))]
pub(super) fn position_ime(window: &dyn Window, caret: &cef::Rect) {
    let data = ImeRequestData::default().with_cursor_area(
        LogicalPosition::new(caret.x + caret.width, caret.y).into(),
        LogicalSize::new(1, caret.height).into(),
    );
    let _ = window.request_ime_update(ImeRequest::Update(data));
}

#[cfg(target_os = "linux")]
fn gtk_keyboard(window: &gtk4::ApplicationWindow) -> Option<gtk4::EventControllerKey> {
    use gtk4::prelude::*;

    let controllers = window.observe_controllers();
    (0..controllers.n_items()).find_map(|index| controllers.item(index).and_downcast())
}

#[cfg(target_os = "linux")]
pub(super) fn install_gtk_ime(window: &dyn Window) {
    use gtk4::prelude::*;
    use winit::platform::gtk4::WindowExtGtk4;

    let id = window.id();
    let Some(window) = window.gtk_window() else {
        return;
    };
    let Some(keyboard) = gtk_keyboard(&window) else {
        return;
    };
    // GTK winit does not implement ImeRequest. Let its existing key controller
    // filter composing keys before Winit can forward them to Chromium.
    let context = gtk4::IMMulticontext::new();
    context.set_client_widget(Some(&window));
    context.connect_preedit_changed(move |context| {
        let (text, _, cursor) = context.preedit_string();
        let cursor = text
            .char_indices()
            .nth(cursor.max(0) as usize)
            .map_or(text.len(), |(index, _)| index);
        dispatch_gtk_ime(id, Ime::Preedit(text.to_string(), Some((cursor, cursor))));
    });
    context.connect_commit(move |_, text| dispatch_gtk_ime(id, Ime::Commit(text.to_owned())));
    keyboard.set_im_context(Some(&context));
}

#[cfg(target_os = "linux")]
fn dispatch_gtk_ime(id: winit::window::WindowId, ime: Ime) {
    let host = super::SURFACE.with_borrow(|state| {
        state
            .as_ref()
            .filter(|surface| surface.id == id)
            .map(|surface| surface.host.clone())
    });
    if let Some(host) = host {
        send_ime(&host, ime);
    }
}

#[cfg(target_os = "linux")]
pub(super) fn position_ime(window: &dyn Window, caret: &cef::Rect) {
    use gtk4::{gdk, prelude::*};
    use winit::platform::gtk4::WindowExtGtk4;

    let keyboard = window.gtk_window().as_ref().and_then(gtk_keyboard);
    if let Some(context) = keyboard.and_then(|key| key.im_context()) {
        context.set_cursor_location(&gdk::Rectangle::new(
            caret.x + caret.width,
            caret.y,
            1,
            caret.height,
        ));
    }
}
