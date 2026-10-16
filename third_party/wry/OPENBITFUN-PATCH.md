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
