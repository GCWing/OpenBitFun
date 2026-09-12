# OpenBitFun Mobile Design System

This directory is the source-neutral visual contract for the native HarmonyOS,
Android, and iOS applications. It owns stable visual facts and deterministic
preview scenarios; it does not implement a cross-platform renderer.

## Ownership

- `tokens/mobile-tokens.json`: the single source for semantic colors,
  typography, shared geometry, breakpoints, and motion durations.
- `components/mobile-components.json`: component anatomy, states, and the token
  roles each native implementation must consume.
- `scenarios/mobile-preview-scenarios.json`: deterministic states rendered by
  native preview galleries and the desktop comparison tool.
- `preview/`: the local three-column inspection surface. It can show the
  contract fallback immediately and accepts native screenshots for overlay or
  side-by-side inspection.

Generated platform files are checked in so IDE previews and native builds do
not require Node.js. Change the contract, then run:

```bash
pnpm run mobile:ui:generate
pnpm run mobile:ui:check
pnpm run mobile:ui:preview
```

Do not edit generated files by hand. Native components remain responsible for
safe areas, keyboard behavior, accessibility bridges, navigation gestures, and
platform presentation primitives.

## Typography

- Product text consumes the semantic roles in `tokens/mobile-tokens.json`;
  native components must not introduce literal text sizes.
- Keep the hierarchy shallow: display and page titles use the display/headline
  roles, row titles use title roles, reading text uses body roles, and compact
  metadata uses label roles. The smallest product-text role is `label_small`
  at 12 units; icon glyph sizing is independent of text sizing.
- Native hosts follow the system font-size preference with a documented maximum
  scale. Validate the standard size and at least one enlarged accessibility size
  without changing display zoom, and prefer wrapping or ellipsis over clipping.

The native role names map to the product's formal content purposes as follows:

| Content purpose | Native role |
| --- | --- |
| Page title | `display_large`, or `headline_large` in a compact container |
| Section title | `headline_small` |
| Card or row title | `title_small` / `title_medium` |
| Body copy | `body_medium`, with `body_large` for reading emphasis |
| Supporting text | `body_small` |
| Control label | `label_medium` / `label_large` |
| Compact metadata | `label_small` |

Platform renderers may choose the listed size variant for available width, but
must not substitute a different content purpose merely to obtain a preferred
metric.

## Simulator captures

The native galleries can be launched without changing the normal app path:

```bash
# Android (after installing the debug APK)
adb shell am force-stop com.openbitfun.mobile.debug
adb shell am start \
  -n com.openbitfun.mobile.debug/com.openbitfun.mobile.app.MainActivity \
  --ez openbitfun.design_preview true \
  --es openbitfun.design_scenario connected-conversation

# iOS Simulator (after installing the simulator app)
xcrun simctl launch booted com.openbitfun.mobile.ios \
  --design-preview connected-conversation

# HarmonyOS emulator (after installing a locally signed debug HAP)
hdc -t <emulator-tcp-target> shell aa force-stop <harmony-bundle-id>
hdc -t <emulator-tcp-target> shell aa start \
  -a EntryAbility -b <harmony-bundle-id> \
  --ps openbitfunDesignPreview connected-conversation
```

Valid scenario ids come from `scenarios/mobile-preview-scenarios.json`. Save
captures using the convention documented in `preview/snapshots/README.md`, then
open the desktop comparison surface to inspect them beside the HarmonyOS
baseline.

## Cold-start brand motion

HarmonyOS, Android and iOS render `startup_brand_reveal` natively. The 6.8-second
sequence uses the `brand_wordmark` artwork typography and the dedicated
`brand_dot` cyan, distinct from action and status colors. Platform soft sans
fonts are used; the HTML prototype's macOS fonts are not redistributed. This
decorative wordmark scales with its 280-unit stage, rather than Dynamic Type;
normal app text continues to respect accessibility sizing.

The cyan dot hops with the letter reveals, returns to the dotless i, then the
shared contour mark expands above the word. Cold-launch presentation is
independent of account and network readiness. Backgrounding removes it without
replay, and system reduced-motion skips it. Notification onboarding waits until
the overlay finishes. Design-preview launches bypass the startup overlay.

Validate on a compact and wide native window, including a live resize where
available, and check a background/foreground cycle during the reveal.

## Signed-out welcome home

The disconnected, signed-out home uses the A welcome composition with the C
staggered-slide phrase animation: a fixed brand mark, desktop-derived localized
short phrases, and equally weighted sign-in and scan actions in a dark dock.
This is the signed-out home itself, not an onboarding layer before another
landing page. Compact and wide hosts use the same entry on all three platforms:
without a control target, show the welcome composition; account identity only
changes its primary action from sign-in to connect. Connect opens the existing
device chooser and scan opens the existing scanner. With a retained target,
disconnect/reconnect preserves session context and retry controls instead of
returning to welcome. An account reset can leave HarmonyOS disconnected rather
than idle; either state leads to welcome once the control target is cleared.
`welcome_*` geometry tokens own the compact dimensions and a 520-unit wide
content cap. The four dedicated welcome colors keep the dark dock and white
buttons stable in both appearance modes; normal page/action tokens invert or
change surfaces and cannot express this fixed brand treatment.

Each phrase enters with 55 ms per-glyph staggering and an 800 ms cubic ease-out,
then leaves over 650 ms. Reduced motion renders a static wordmark. Background
or invisible hosts suspend presentation work. Native safe-area and accessibility
behavior remain platform-owned; these are logical layout units, not a promise
of identical font rasterization on different systems.

HarmonyOS exposes the bundled MiniApp destination. Android and iOS preserve the
reserved footer area until they own that capability, rather than presenting an
inert MiniApp action. QR actions still use the existing account-device protocol;
this UI change does not add guest credentials or bypass server authorization.
HarmonyOS can render the isolated surface with the existing design-preview
launch parameter `openbitfunDesignPreview=welcome-home`, without logging out an
active account or loading its connection state.

The welcome and startup marks share the desktop AboutBrandMark contour geometry:
15 rounded hexagonal paths with three low-opacity highlights traveling around
each contour over 18 seconds. `assets/welcome-brand-contours.json` records the
256-unit paths and lengths; native renderers own their drawing and lifecycle.
The startup keeps its existing entrance choreography; the welcome mark stays
in place while the highlights and short phrases loop. Reduced motion keeps the
contours static. No microphone or voice-service dependency is introduced.

### Recent-conversation home

Signed-in home shows up to three non-archived sessions from the current remote
device, ordered by valid update timestamp (creation time is the fallback). It
labels the device and workspace without treating a loaded catalog as an active
workspace selection. All conversations opens the existing sidebar; creation
stays in the workspace-owned sidebar action. Signed-in users without a remote
target see the same home with a connection entry, while signed-out users retain
the welcome page. Loading and offline states never erase retained sessions.
The mark uses a five-second diagonal highlight sweep; reduced motion uses a
static contour. Native hosts retain their own lifecycle and adaptive layout.

The recent-home brand and headline are centered above the leading-aligned session list. The mark retains its original silhouette and uses the same diagonal sweep across native surfaces. HarmonyOS uses a 156vp mark and 21fp headline for its optical balance; other hosts use the shared geometry.

HarmonyOS welcome occupies the full window when signed out without an active remote target. It suppresses the workspace sidebar without changing retained selection. At 600vp and above, the brand, phrase and constrained action group are centered without the compact dock; smaller windows retain the stacked dock. The welcome mark is 156vp compact and 184vp wide, using the diagonal sweep. Size changes update this layout in place.

For HarmonyOS welcome windows at least 840vp wide with width/height at least 1.2, a centered composition capped at 1000vp places the brand and actions side by side. This follows available window geometry rather than a device model or fold count.
