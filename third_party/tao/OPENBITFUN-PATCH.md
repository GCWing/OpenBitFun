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
