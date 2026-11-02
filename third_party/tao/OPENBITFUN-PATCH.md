# macOS traffic-light geometry after style restoration

Source: crates.io `tao` 0.36.0, from <https://github.com/tauri-apps/tao>.
This copy retains the upstream Apache-2.0 license. The published Rust sources,
examples, manifest, README and licenses are retained.

Fullscreen exit calls `restore_state_from_fullscreen`, which queues a native
style-mask change. The upstream delegate immediately reapplies the configured
traffic-light inset before that queued change runs. `NSWindow::setStyleMask`
then resets the native buttons, leaving them misaligned until another layout.

Inset restoration moves from the fullscreen delegate into `util::set_style_mask`,
immediately after the style and first responder are restored. Both synchronous
and asynchronous style changes preserve the inset within their existing
main-thread operation.

AppKit can also reset titlebar geometry independently of fullscreen, including
when window-sharing status changes. `TaoWindow::layoutIfNeeded` reapplies the
configured inset after native layout and before display. The inset belongs to
`TaoWindow`, because Wry replaces `TaoView` with its own content parent. Geometry
writes are idempotent so another layout pass does not schedule unchanged frames.
Untitled and fullscreen style masks are excluded from the layout override;
windows without a custom inset retain upstream behavior. No notification retry,
timer, new private API or product-specific geometry is added.

The vendored macOS sources also receive compiler-warning maintenance: current
event constants and ivar reads, removal of unused private state/helpers and
redundant unsafe blocks, and explicit retention of validated per-window icon
data. The obsolete fullscreen button lookup is omitted because AppKit always
returns nil for it; the zoom button remains in the list. The legacy filename-list
pasteboard format is retained at its three registration/read sites, with local
deprecation annotations, so this cleanup does not change drag payload semantics.

OpenBitFun keeps its original toolbar height and tab spacing. The desktop host
derives the configured inset from the shared design height and native metrics;
the framework owns applying that inset during its native window lifecycle.

The standalone native regression test keeps AppKit on the main thread, replaces
the content view as Wry does, and repeatedly resets the style and lays out both
custom and default windows. Run it on macOS with:

```sh
cargo test --manifest-path third_party/tao/Cargo.toml --test macos_chrome_layout
```

Remove this override when upstream preserves the inset after deferred style
restoration and native titlebar relayout, independently of the content view.
Verify normal and maximized windows through repeated native fullscreen
round trips, with expanded and collapsed navigation. After exit, leave the
window untouched to ensure alignment does not depend on a subsequent resize.

# Wayland client-side decoration height

tao claims a client-side decoration on Wayland for windows created with
`decorations(false)`, because otherwise the compositor paints server-side
decorations. The claim is installed by setting an empty `EventBox` as the
titlebar. GTK still gives that strip its themed height, so such a window shows a
header bar carrying the window title and the GTK window buttons directly above
the application's own window chrome.

The Linux window path keeps the CSD claim and collapses the strip instead: an
empty `Box` replaces the `EventBox` titlebar and a per-window style provider
zeroes its minimum height, padding, margin, border, shadow and background.
A `HeaderBar` would keep one themed border row even at zero height, which a
transparent window shows as a stripe above the webview; a plain box has no themed
chrome of its own. OpenBitFun keeps rendering its own window controls and drag
regions in every case.

Collapsing the strip removes the only square frame GTK still drew, so the shell
owns the frame radius: the desktop window is created transparent and the Web UI
paints a rounded `#root` over a transparent `html`/`body`. The window therefore
shows the desktop through its four corners instead of a square GTK edge, and it
drops that radius again when the window is maximized so the frame fills the
screen. This only works while nothing repaints the page background, so the
desktop bootstrap advertises `data-openbitfun-native-frame="client"` and the
bootstrap script, the startup overlay and the appearance adapter all leave
`html`/`body` transparent under that attribute.

GTK clips the webview to the decoration node's shape, so that node — not the
page — decides the visible outline. It paints its own background and the theme
rounds only the top, leaving the bottom corners square; a transparent corner in
the page therefore still showed a square block behind it. The frame provider
clears the node's background and rounds it to the shell's radius while the window
floats, and drops that class when the window is maximized so the theme's square,
shadowless decoration still fills the screen. The shadow stays GTK's, which is
what makes the arc look native.

Verify on a Wayland session that a `decorations(false)` window shows neither a
GTK strip nor a compositor header, that all four corners are rounded with no
square edge behind them, that a maximized window is square and covers the work
area, and that dragging, edge resizing, maximizing and restoring still work.
Remove this override once tao collapses the placeholder titlebar itself, or once
it exposes an undecorated Wayland window that the client can own completely.
