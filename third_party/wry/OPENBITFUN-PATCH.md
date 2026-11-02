# macOS HTML drag ownership and warning cleanup

Source: crates.io `wry` 0.56.0, published from upstream revision
`5c9b89920f3c6abf90b9c539fad2e352d24d179a` at
<https://github.com/tauri-apps/wry>. The published source, examples, manifest,
README and Apache-2.0 / MIT licenses are retained.

The four AppKit destination callbacks in `src/wkwebview/drag_drop.rs` now route
a drag with no native file paths directly to their WKWebView superclass.
Tauri's native handler unconditionally accepts events, so sending empty file
lists to that handler swallowed HTML
`dragover` and `drop` and returned Copy even for a source allowing only Move.

File drags retain the existing native event payloads, original filesystem paths,
Copy result and browser fallback when the native listener declines. Non-file
drags retain WebKit's Move, Link, rejection, drop and exit behavior. Ownership is
decided from each callback's pasteboard, without application tab state, timers,
synthetic JavaScript events or changes to Windows/Linux handlers. Desktop keeps
the macOS file handler enabled; disabling it would discard Finder paths used by
the attachment and workspace transfer adapters.

File paths are read through `readObjectsForClasses:options:` with `NSURL` and
`NSPasteboardURLReadingFileURLsOnlyKey` instead of the deprecated filename
pasteboard API. This keeps multiple files, decoded paths and legacy filename
pasteboards working while leaving web URLs and text with WebKit. Synthetic
mouse events use `NSEventModifierFlags` instead of deprecated key-mask globals.
`mod.rs` imports `NSObject` only for the configurations that use it;
`download.rs` retains its debug-only error logging without an unused release
parameter. Redundant unsafe blocks were removed from drag coordinates,
`class/wry_web_view_parent.rs` and `class/wry_web_view_ui_delegate.rs`.

Focused verification on macOS (no window or browser automation):

```sh
CARGO_TARGET_DIR=target cargo test --manifest-path third_party/wry/Cargo.toml --lib wkwebview::drag_drop::tests
```

The routing tests cover an always-accepting native receiver, WebKit's accepted
and rejected moves/drops, file ownership and exit. Unique test pasteboards cover
multiple file URLs, escaped/Unicode paths, folders, legacy filename payloads and
non-file drags without changing the user's clipboard. Rebuild Desktop to apply
this dependency change; frontend HMR cannot update native callbacks. Manual desktop
verification covers both directions of tab moves and Finder file drops.

Remove the override when upstream delegates every non-file drag phase directly
to WebKit while preserving native file paths and operation negotiation. Keep the
crate outside the product workspace; its dependency closure remains subject to
the resolved feature audit.

The warning cleanup can be dropped when the vendored release contains the
equivalent API and conditional-compilation fixes.

## Unavailable WebKit URLs

`url_from_webview` returns `Error::UrlUnavailable` when `WKWebView.URL` or its
absolute string is absent. An uncommitted page can have no URL; reading it must
return an error instead of panicking on the UI thread. Valid URLs retain their
existing representation. This shared Apple adapter also serves page-load
callbacks and browser automation URL reads.

On macOS, run the native regression on the main thread:

```sh
cargo test --manifest-path third_party/wry/Cargo.toml --no-default-features --test wkwebview_url --target-dir "${TMPDIR:-/tmp}/openbitfun-wry-tests"
```

The test uses a hidden, nonpersistent WebView. It checks an unavailable URL,
loads `about:blank`, then exercises a failed loopback connection, late state
observation, intentional stop and explicit navigation recovery. It does not contact a website
or exercise remote scenarios.
Remove this URL patch when the vendored dependency returns an error for absent
native URLs without panicking.

`WryWebView::set_navigation_state_handler` exposes main-frame provisional start,
completion and failure through the existing navigation delegate. The latest
outcome is replayed to a late subscriber, and terminal events from a replaced
navigation do not overwrite its replacement. Desktop uses this callback for its
browser load state; ordinary page-load callbacks retain their commit/finish
meaning. WebKit's cancellation error settles the pending navigation without a
retained page failure; it cannot leave subsequent reads waiting for that request.
This bridge does not retry or reload failed navigation.

---

# WebKitGTK file-drop delivery

Same vendored `wry` 0.56.0 release, Linux handler only.

`src/webkitgtk/drag_drop.rs` claimed OS file drags but could never deliver a
drop to the application:

- `DragDropEvent::Drop` required `DragControllerState::Leaving`, which only the
  `drag-leave` signal sets, and GTK emits `drag-leave` after `drag-drop`. The
  branch was unreachable.
- `Enter` and the stored paths depended on `drag-data-received` firing with
  `info == 2`, but nothing in this handler ever called `gtk_drag_get_data`, so
  the reply was at best incidental.

The webview therefore reported `Enter`/`Over` at most and never `Drop`, and a
file dropped on the window was discarded. Desktop depends on that event for
attachment intake (`useLocalFileDrop`), and the WebKitGTK DOM path cannot
substitute for it: the page receives no `DataTransfer` types for an OS file
drag, which is why `ContextDropZone` deliberately leaves empty-typed drags
unclaimed.

The handler now:

- claims only drags whose target list contains `text/uri-list`, so internal
  application drags, tab moves and text drags stay with WebKit;
- requests the URI list on the first `drag-motion`, so `Enter` carries the
  paths while the drag is still in progress;
- finishes the drag and emits `Drop` from `drag-drop` when the paths are
  already known, or from `drag-data-received` when the drop raced the reply;
- rejects non-`file://` URIs, so a link or text drag that happens to advertise
  a URI list cannot become an attachment path;
- answers a pending drop with `drop_finish(false)` when the drag leaves first,
  instead of leaving the source wait for a reply that will never come.

Verification: `cargo check -p openbitfun-desktop` covers the handler on Linux.
Manual desktop verification is a file dragged from the file manager onto the
composer and onto the Files panel, plus a tab or context-pill drag to confirm
internal drags still work.

Remove the override when upstream wry delivers `Drop` for WebKitGTK file drags.
