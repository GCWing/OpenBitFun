# macOS CEF shared-texture presentation

The patch targets CEF `154.0.34`, commit
`14c5a089e8452874cb1a556dc3fde26ed2d87723`, with Chromium `154.0.8037.98`.
Apply it in the CEF checkout before generating the Chromium build files.

```sh
git -C "$CEF_SOURCE" apply --check "$OPENBITFUN_SOURCE/src/apps/desktop/cef-patches/154.0.34-macos-osr-texture.patch"
git -C "$CEF_SOURCE" apply "$OPENBITFUN_SOURCE/src/apps/desktop/cef-patches/154.0.34-macos-osr-texture.patch"
```

Build and package the pinned CEF framework with the
[CEF macOS build workflow](https://github.com/chromiumembedded/cef/blob/master/docs/automated_build_setup.md#macos-configuration).
Stage the minimal distribution under the existing `CEF_PATH` layout with its
own `archive.json` metadata. For Apple Silicon the distribution directory is
`$CEF_PATH/154.0.34/cef_macos_aarch64`. Keep the version at `154.0.34` for
the pinned Rust CEF bindings. Check that the framework exports
`_cef_openbitfun_bind_osr_texture_v1` with `nm -gU` before bundling Desktop.

```sh
CEF_PATH="$PATCHED_CEF_CACHE" OPENBITFUN_BROWSER_OSR=gpu pnpm run desktop:dev -- --isolated-data
OPENBITFUN_E2E_BROWSER_GPU=1 OPENBITFUN_E2E_FRONTEND_DIR="$BUILT_FRONTEND" \
  node tests/e2e/scripts/run-browser-osr-resize.mjs
```

The E2E executable must be in a complete bundle containing the patched
framework. Set `OPENBITFUN_E2E_DESKTOP_BINARY` to choose a different bundle.
Run the same script with the default presentation to collect the CPU baseline.

The bridge hands off the native capture buffer and its lease through Chromium
Mojo. Blink imports the IOSurface as a SharedImage and hands a compositor-backed
ImageBitmap to the workbench canvas. The capture pool can recycle the slot after
the compositor releases the image and its GPU sync token signals. The document
token scopes delivery to the trusted workbench document. This private symbol
keeps the upstream CEF C API hashes and structure layouts intact.

GPU mode requires this versioned symbol. The stock CEF runtime continues to
support the default CPU presentation. GPU acceptance checks the shared-texture
surface and requires zero calls and zero bytes on the Tauri pixel endpoint.
Resize, input, and the Chromium texture handle and lease still use control IPC.
