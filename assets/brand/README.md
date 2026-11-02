# OpenBitFun application brand assets

`source/openbitfun-mark.svg` is the transparent vector master for the current
fine-line Logo used by startup and in-product brand surfaces. Its fifteen rounded
hexagonal contours match the About dialog's static geometry. Motion and moving
highlights are intentionally absent from static files. The SVG uses
`currentColor`, with a light default for dark backgrounds.

The generator also maintains the existing transparent PNG paths:

- `openbitfun-mark-dark.png` is the dark mark for light surfaces.
- `openbitfun-mark-light.png` is the light mark for dark surfaces.

`source/openbitfun-app-mark.png` preserves the originally submitted silver
hexagonal application mark. Application, window, taskbar, Dock, tray, browser,
installer, and mobile launcher icons use this artwork on the black rounded-square
background with transparent corners. It is intentionally independent from the
current startup Logo, so regenerating either family cannot replace the other.
The iOS App Store icon uses an opaque black square; iOS applies the corner mask.

`exports/` contains the SVG, ICO, ICNS, and PNGs at 16, 24, 32, 48, 64, 96,
128, 192, 256, 512, 1024, and 2048 px. Each PNG size includes a dark transparent
mark, a light transparent mark, and the application icon. Fine-line mark exports
are rendered directly from the SVG with size-specific optical treatments at
small sizes. Application icons are resized from the preserved application artwork.
Windows ICO frames and Linux icons use the matching size-specific application
exports. macOS owns a separate native resource pipeline described below; the
shared PNGs, Windows ICO, Linux, web, and mobile artwork are unchanged.

## macOS icons

`macos/openbitfun.icon` is the Icon Composer document for macOS 26 and newer,
including macOS 27. Its background is an opaque, full-bleed black fill and its
foreground is the transparent silver mark projected from the same brand master.
It has no baked outer mask, shadow, or Dock padding. macOS applies the enclosure
and appearance treatment through `Assets.car`. The source uses Icon Composer 1.2
features supported by Xcode 26.2; it does not require an Xcode 27-only document.
No language or region-specific icon variants are needed.

The committed ICNS is the static dev and older-macOS fallback. It is rendered
from that Composer document by Apple's `ictool`, on the separate authored
`macos/legacy-canvas.json` layout, and encoded with Apple's `iconutil`. That
legacy layout has an 824 px body on a 1024 px transparent canvas. This is our
legacy artwork geometry, **not a universal Apple padding requirement**. It never
alters the modern Composer source. Ten 1x/2x representations cover 16–1024 px.
There is no runtime OS-version scaling and no modification of ICNS chunks by
the shared brand generator; canonicalization only orders the native chunks.

Tauri CLI is pinned to **2.11.4** in both workspace apps. The macOS config overlay
adds `.icon` alongside ICNS; base and Windows/Linux icon selections stay intact.
Tauri dev reads ICNS through `NSApplication.applicationIconImage`. Bundled builds
use `CFBundleIconName` with `Assets.car`, plus `CFBundleIconFile` for the legacy
resource. `tauri.dev.conf.json` and the generated release config inherit the
platform icon list instead of overwriting it. The minimum application OS version
is unchanged; compiling the modern catalog for 26 does not raise that minimum.

Normal installs, dev builds, and non-Apple builds use the committed ICNS and need
no Icon Composer installation. After changing the application mark, Composer
document, or legacy layout, regenerate on macOS with **Icon Composer 1.2**:

```bash
# ICON_COMPOSER_APP can point to an alternate location for Icon Composer.app.
pnpm run generate:macos-icons
pnpm run generate-brand-assets
```

The native export manifest records the renderer version and source/output
hashes. Normal asset generation refuses stale native exports instead of silently
shipping a mismatched dev icon. Commit the Composer layer, manifest, and all
three generated ICNS copies together.

Packaging requires **full Xcode 26 or newer**, with `actool` and `assetutil`
selected by `DEVELOPER_DIR` or `xcode-select`. Command Line Tools alone are not
enough. Stable/beta and nightly macOS runners select **Xcode 26.2** on both Intel
and Apple Silicon. The pre-bundle check fails when modern tools are unavailable;
the build wrapper verifies the resulting catalog, both Info.plist icon keys,
and the exact fallback bytes before reporting success. No signed bundle is
modified by verification.

```bash
node --test scripts/generate-brand-assets.test.mjs scripts/macos-icon-bundle.test.mjs scripts/desktop-tauri-build.test.mjs
# Full Xcode: exercise actual Tauri + actool packaging in a disposable fixture.
OPENBITFUN_TEST_MACOS_BUNDLE=1 node --test scripts/macos-icon-bundle.test.mjs
# Inspect an existing bundle without launching it.
node scripts/macos-icon-bundle.mjs verify /path/to/OpenBitFun.app
```

These checks validate resources, native decoding, and package metadata. They do
not establish visual Dock equivalence on every supported OS or display. Remote
workspace, remote control, Peer Device Mode, and detached dispatch are not
exercised by these local packaging checks; their protocols and host logic are
unchanged.

References: [Apple app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons),
[Icon Composer](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer),
[NSApplication.applicationIconImage](https://developer.apple.com/documentation/appkit/nsapplication/applicationiconimage),
and [Tauri 2.11.4 macOS icon bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/icon.rs).

Browser entry points select explicit 16/32 px favicons. The system tray reuses
the macOS template mark on macOS and the configured application icon elsewhere.

Run `pnpm run generate-brand-assets` after changing either source master. The
generator owns the shared desktop, web, installer, Android, iOS, and HarmonyOS
projections. Native macOS exports have the separate owner described above.

Verify generated dimensions, small-size rim contrast, favicon references,
platform selection, and icon containers with
`node --test scripts/generate-brand-assets.test.mjs`. macOS export and native
bundling checks also run `scripts/macos-icon-bundle.test.mjs`.

Verification emails use the silver application mark on its black rounded-square
background, generated at
`src/miniapp-market-web/public/assets/openbitfun-email-app-icon.png`. The market build
publishes this stable anonymous image path for email clients; it contains no
recipient or verification data and does not require authentication.

The previous email mark URL remains available for already-sent messages.
