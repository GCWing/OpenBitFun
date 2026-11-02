// Native regression coverage for the OpenBitFun macOS chrome patch.
// A standalone main is required because AppKit must run on the main thread.

#[cfg(target_os = "macos")]
fn main() {
  use objc2::msg_send;
  use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};
  use objc2_foundation::{MainThreadMarker, NSPoint, NSRect};
  use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event_loop::EventLoop,
    platform::macos::{WindowBuilderExtMacOS, WindowExtMacOS},
    window::WindowBuilder,
  };

  fn centers(window: &NSWindow) -> Vec<f64> {
    [
      NSWindowButton::CloseButton,
      NSWindowButton::MiniaturizeButton,
      NSWindowButton::ZoomButton,
    ]
    .map(|kind| {
      let button = window.standardWindowButton(kind).unwrap();
      let bounds = button.bounds();
      let point = button.convertPoint_toView(
        NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
        None,
      );
      window.frame().size.height - point.y
    })
    .to_vec()
  }

  let event_loop = EventLoop::new();
  let mtm = MainThreadMarker::new().unwrap();
  for custom in [false, true] {
    let mut builder = WindowBuilder::new()
      .with_visible(false)
      .with_inner_size(LogicalSize::new(800.0, 600.0))
      .with_titlebar_transparent(true)
      .with_title_hidden(true)
      .with_fullsize_content_view(true);
    if custom {
      builder = builder.with_traffic_light_inset(LogicalPosition::new(12.0, 24.5));
    }
    let window = builder.build(&event_loop).unwrap();
    // SAFETY: Tao owns the live native window for this scope, on the main thread.
    let native = unsafe { &*window.ns_window().cast::<NSWindow>() };
    unsafe {
      let _: () = msg_send![native, layoutIfNeeded];
    }
    let expected = centers(native);
    if custom {
      let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
      let titlebar = NSWindow::frameRectForContentRect_styleMask(NSRect::ZERO, style, mtm)
        .size
        .height;
      let button = native
        .standardWindowButton(NSWindowButton::CloseButton)
        .unwrap();
      let configured_center = 24.5 + button.frame().size.height - titlebar / 2.0;
      assert_eq!(
        expected,
        vec![configured_center; 3],
        "configured inset must be applied without drawing TaoView"
      );
    }

    // Wry replaces TaoView. Window chrome must keep its configuration anyway.
    let replacement = NSView::new(mtm);
    native.setContentView(Some(&replacement));
    for cycle in 0..8 {
      native.setStyleMask(native.styleMask());
      unsafe {
        let _: () = msg_send![native, layoutIfNeeded];
      }
      assert_eq!(centers(native), expected, "custom={custom}, cycle={cycle}");
      // An extra layout must neither drift nor depend on drawing TaoView.
      unsafe {
        let _: () = msg_send![native, layoutIfNeeded];
      }
      assert_eq!(centers(native), expected);
    }
  }
  println!("Native titlebar layout regression passed for custom and default chrome");
}

#[cfg(not(target_os = "macos"))]
fn main() {}
