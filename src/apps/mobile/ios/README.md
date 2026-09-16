# OpenBitFun iOS

Native SwiftUI client for local and remote conversations, account pairing,
workspace and session management, approvals, attachments, and file previews.
It follows the HarmonyOS reference geometry: 76pt conversation header, 44pt
circle controls, 16pt content margins, the 48pt connection strip, and the
floating composer with 52pt collapsed height.

## Project layout

- `OpenBitFun/App/`: lifecycle, launch configuration, and composition root.
- `OpenBitFun/Features/Chat/`: conversation home, header, timeline bubbles, and composer.
- `OpenBitFun/Features/Remote/`: remote conversation home surfaces.
- `OpenBitFun/Features/Settings/`: app settings composition and reusable settings cards.
- `OpenBitFun/Features/Pairing/`: pairing sheet flow.
- `OpenBitFun/Features/Account/`: account settings and device rows.
- `OpenBitFun/Features/Shell/`: theme tokens, drawer, shell layout, and remote supporting surfaces.
- `OpenBitFun/Infrastructure/`: observable state, failure copy, and platform adapters.
- `OpenBitFun/Presentation/Models/`: SwiftUI-facing presentation DTOs.
- `OpenBitFun/Resources.xcassets/`: app icon and future native assets.

## Build and run

The repository does not change the machine-wide developer directory. Use the
Xcode copy in `~/Downloads` when it is the compatible version:

```bash
export DEVELOPER_DIR="$HOME/Downloads/Xcode.app/Contents/Developer"
"$DEVELOPER_DIR/usr/bin/xcodebuild" \
  -project OpenBitFun.xcodeproj -scheme OpenBitFun \
  -destination 'platform=iOS Simulator,id=1D7E5AA6-1AE9-4CAB-966B-A83B5F113B4A' \
  -derivedDataPath /tmp/OpenBitFun-iOS-Derived \
  CODE_SIGNING_ALLOWED=YES CODE_SIGNING_IDENTITY=- build
```

`MobileAppModel` is kept in `Infrastructure` so the SwiftUI views do not know
about transport or persistence. Local chat, pairing, and remote session state
are supplied by the generated `OpenBitFunMobileCore` framework from
`src/apps/mobile/shared/core-feature`; SwiftUI only maps the typed state to its
presentation model. Pairing accepts the desktop connection URL through the
connection sheet (the camera scanner remains a native adapter concern).

Run the platform-independent Swift infrastructure checks through the registered
focused entry point. It compiles production helpers together with their local
test executables; test mains are not part of the app target:

```bash
export DEVELOPER_DIR="$HOME/Downloads/Xcode.app/Contents/Developer"
./Testing/run-pure-swift-tests.sh
```

After changing shared Kotlin code, regenerate the framework with the same compatible
toolchain before building the Xcode project. Xcode links the existing XCFramework;
its build does not rebuild Kotlin. Compiling a Kotlin target alone also does not
update the XCFramework consumed by this app:

```bash
export JAVA_HOME="/Applications/DevEco-Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
export DEVELOPER_DIR="$HOME/Downloads/Xcode.app/Contents/Developer"
cd ../shared
./gradlew :core-feature:assembleOpenBitFunMobileCoreDebugXCFramework
```

The shell includes both product surfaces already: Local opens the HarmonyOS
welcome prompts, Remote has the disconnected desktop state and connection
action, and the unified drawer mirrors the HarmonyOS recent-chat, device,
workspace, chat, and settings sections. A connected preview exposes the
remote empty home through the same conversation chrome.

For repeatable simulator captures, pass `--remote`, `--connected`, `--drawer`,
`--settings`, `--remote-settings`, `--remote-view-settings`, `--remote-view-density`, `--model-settings`, `--composer-model-picker`, `--pairing`, `--pairing-manual`, `--pairing-account`, `--remote-create`, `--remote-create-workspace-picker`, `--remote-chat-section`, `--project-create-menu`, `--file-preview`, `--plan-preview`, `--session-actions`, `--sidebar-actions`, `--local-actions`, and/or
`--account-login` or `--account-profile` after the bundle identifier in `simctl launch`. The local
actions flag can be combined with the session-actions flag; the account-login
flag opens a deterministic signed-out surface without storing credentials. These launch flags
select deterministic inspection states; normal launches use the live KMP
pairing/session stores.

Hosts advertising `harness_profiles_v1` expose Minimal, Standard, and Ultimate
execution modes; older hosts retain Code and Cowork. Use `--connected --drawer
--harness-preview --project-create-menu` to inspect the supported-host menu.
Task completion notifications use a bounded iOS background task; they do not
guarantee delivery after process termination. See the mobile README parity table.

To verify that skipping notification onboarding survives restart, run this on a
fresh simulator installation with undecided notification authorization:

```bash
xcodebuild -project OpenBitFun.xcodeproj -scheme OpenBitFun \
  -destination 'platform=iOS Simulator,name=Notification Onboarding QA' \
  -only-testing:OpenBitFunUITests/NotificationOnboardingUITests test
```

For the sidebar's New Chat menu and compact/wide scrolling checks, use the same
command with `-only-testing:OpenBitFunUITests/SidebarNavigationUITests` instead.
This suite uses deterministic remote preview data and does not create host sessions.

Use `-only-testing:OpenBitFunUITests/GitHubLoginPresentationUITests` on a signed-out
simulator to check the compact login sheet and automatic authorization-browser
handoff. This check needs the configured relay's login endpoint and opens Safari;
it does not submit GitHub credentials or approve account access.

For offline parity regression, use `-only-testing:OpenBitFunUITests/MobileParityUITests`.
It exercises language switching, numbered file previews, plan capability gating,
and all three bundled Mini Apps using isolated preview data. No host command is sent.
The Mini App resource build phase requires Node.js on PATH.

The MiniApp build phase generates resources directly into the app bundle, so
incremental builds include CSS and script edits without relying on a folder
reference's timestamp. `miniapps.css` owns iOS font-family adaptations; the iframe
sandbox and network restrictions remain in the shared document wrapper.

The Mini App gallery follows the HarmonyOS full-page surface: a 56pt back/title
bar, an offline header, and square preview tiles in two columns (three from
600pt). The `miniapp-*.imageset` previews are PNG projections of HarmonyOS
`miniapp_*_preview.webp` assets; retain their original artwork and center-crop
them in the native view. App pages display their own name in the same header.
