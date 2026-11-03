//! The full-window frontend follows AppKit geometry in the same native resize.

use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};

pub(super) fn follow_parent_bounds(view: &NSView) -> Result<(), &'static str> {
    // SAFETY: NSView is main-thread-only; the returned parent is retained while
    // this synchronous configuration runs.
    let parent = unsafe { view.superview() }.ok_or("Main WebView has no native parent")?;
    if !parent.autoresizesSubviews() {
        // Do not change the layout policy of siblings (embedded browsers).
        return Err("Main WebView parent does not autoresize subviews");
    }

    // Tauri's multi-WebView path creates even the main frontend as a Wry child.
    // Its default MinYMargin mask keeps the old size until a queued Tao resize
    // event calls set_bounds. Fill the native parent directly instead. Only the
    // main frontend uses this policy; browser children keep explicit bounds.
    view.setFrame(parent.bounds());
    view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    Ok(())
}
