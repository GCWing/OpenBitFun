# OpenBitFun Native Mobile Apps

This directory contains the native mobile product surfaces for OpenBitFun:

- `android/`: Android application code and resources.
- `ios/`: iOS application code and resources.
- `harmonyos/`: HarmonyOS application code and resources.

The mobile apps are remote controllers: GitHub login and the account device
directory select a desktop or CLI host that owns configuration and Agent Runtime
execution. Phones submit tasks and display results; they do not synchronize model
configuration or execute agents locally.

Each platform directory owns its native UI, lifecycle, permissions, packaging,
and platform adapters. Product logic and stable contracts should remain in the
platform-agnostic Rust layers and be exposed to these apps through explicit
interfaces.

## Image messages

All three apps can send images with or without text. Camera photos are decoded
on the phone and converted to a supported format before upload. Failed sends
retain the draft and images; acknowledgement removes only the submitted content.
Android supports selecting several photos at once and retains prepared attachments
across Activity recreation and process restarts. Android stores prepared image drafts
in app-private files excluded from backups, scoped by account endpoint, account,
device and session. Failed saves and unreadable records offer retry without erasing
the stored draft. An in-progress photo conversion still needs to be retried if the
process stops before preparation and saving finish.

Model selection belongs to the connected host. A primary model that supports
images receives their pixels directly. For a text-only primary model, select an
enabled image-understanding model in the host settings and keep `analyze_image`
enabled for the agent. The receiving runtime saves inline attachments so the
same images remain available after restoring a conversation, including sessions
in SSH workspaces. An unavailable model or unreadable image produces an error.

## Shared visual contract

HarmonyOS is the current visual baseline. The source contract in
[`design-system/`](design-system/README.md) records the stable HarmonyOS colors,
type scale, geometry, breakpoints, motion, component anatomy, and deterministic
preview scenarios. A generator emits native constants for ArkUI, Compose, and
SwiftUI; each platform still owns its native component implementation.

```bash
pnpm run mobile:ui:generate
pnpm run mobile:ui:check
pnpm run mobile:ui:preview
```

The preview command opens a local three-column desktop surface for HarmonyOS,
Android, and iOS. It renders the same scenario from the contract and can overlay
native simulator or IDE-preview captures for pixel-level comparison.

## Native feature parity

HarmonyOS is the behavioral and visual reference for the mobile controller.
The Android and iOS implementations share capability negotiation, account display
metadata, execution-mode IDs, speech draft merging, and completion observation in
`shared/core-feature`; native views and OS adapters remain platform-owned.

| Capability | Android and iOS behavior | Compatibility and verification boundary |
|---|---|---|
| Execution modes | Minimal / Standard / Ultimate, with the HarmonyOS density glyph; workspace menus also retain Cowork | Enabled only by live `get_workspace_info.capabilities` containing `harness_profiles_v1`; older hosts keep Code / Cowork. Capability absence in old payloads is covered by a round-trip test. |
| Running-turn input | A nonempty remote draft offers Send; an empty composer retains Stop | Hosts advertising `dialog_steer_v1` receive `steer_turn` with the active turn ID. Older hosts retain `send_message` queueing; failed sends retain the draft and attachments. |
| Plans | Legacy CreatePlan, structured plans and `.plan.md` writes show a plan card with file preview and Build | Build requires `plan_build_v1`, a completed plan tool and an idle connected session. Paths remain remote; the mobile app never runs the plan locally. |
| Offline Mini Apps | Gomoku, Regex Playground and Daily Divination open from welcome and sidebar without login | Product-owned sources are bundled by `miniapps/generate.cjs`; native WebView hosts expose only per-app allowlisted storage and clipboard. No network, Node or shell bridge. |
| Code preview | Native lexical colors, line numbers and referenced-line backgrounds | Both apps use the core-feature highlighter with native theme tokens; large files retain its bounded plain-text fallback. |
| Account profile | Public GitHub login and avatar replace the numeric-ID placeholder | The immutable Relay user ID still authorizes devices. Display metadata uses a separate encrypted 24-hour cache; offline refreshes preserve credentials and cached display. |
| Task completion | Notify for a previously observed successful remote turn while backgrounded | Identity includes target, session and turn. Replayed, failed and cancelled turns do not notify. These are local notifications, not server push. iOS observes within its OS background-task allowance; Android observes while the controller process remains alive. Neither promises notification after process termination. |
| Speech input | Continue an existing draft without trimming its whitespace or inserting spaces into Chinese text | iOS owns Speech/AVAudio lifecycle in a platform adapter and cancels on route, target or scene changes. Android uses the system recognition activity. |
| Conversation UI | Shared native tokens, neutral send/stop discs, supplementary voice action with a nonempty draft, plain assistant body | Native previews reuse production message rendering; compare the same scenario under `design-system`, then verify real app menus separately. |
| Remote operations | Existing session creation, tools/approvals/questions, models, images, remote file preview/download, and compact/wide layouts remain native | Simulator screenshots are presentation evidence, not evidence of a live SSH workspace, peer-device, or detached-dispatch session. |
| HarmonyOS watch provisioning | Remains HarmonyOS-specific | Android/iOS do not advertise watch provisioning without a supported platform transport and negotiated host contract. |

Focused checks are documented in `AGENTS.md` and each platform guide. Keep
comparison screenshots local under the design-system snapshot convention, or
with the task's local artifacts; do not commit account or device captures.

## Notification permission onboarding

iOS, Android 13+, and HarmonyOS offer an optional task-completion notification
introduction on first launch. Enable opens the system authorization dialog;
Later dismisses the introduction. The choice is stored per installation and
survives account changes and process restarts. Already-authorized installations
skip the introduction. Sending or observing a task never requests notification
permission. System settings remain the recovery path after skipping or denying. iOS also
provides a Notifications entry in app settings: it requests undecided permission
or opens system notification settings for an existing decision.
Camera and microphone access stays contextual to scanning and voice input.
Notification authorization does not extend the platform background-execution
limits described above.

## Runtime control and conversation synchronization

The mobile apps control a selected Desktop or CLI runtime. Workspace paths, files, terminals, and saved SSH connections belong to that runtime. Mobile workspace selection lists only connections already saved there and never collects runtime SSH credentials.

Android/iOS conversation synchronization uses the same revisioned rich session records for initial history, live updates, and recovery. The latest page opens first; earlier encrypted pages prefetch in the background through the same single flight used by explicit history requests. Complete fragment boundaries, stable record revisions, and ancestor deletion markers are preserved during backward reads. Encrypted fragments, the forward cursor, and the older-page boundary commit atomically to the local replica. Returning to the foreground actively checks the forward cursor even when the socket did not report a disconnect.

HarmonyOS also publishes the latest page before scheduling older-page prefetch.
Background and manual history requests share the same serialized reader, and
leaving the session cancels scheduled prefetch.

Workspace tools expose directory browsing, text editing with runtime-enforced content-hash conflict detection, file/folder creation, file renaming/deletion, binary upload/download, and bundled xterm PTY control. The terminal executes on the selected runtime or its saved SSH connection; durable notifications request incremental output from the runtime cursor.

Pending approvals are a separate runtime mailbox, refreshed at initial attachment, reconnect/foreground recovery, and relevant permission control events. Android/iOS answer the stable request identity even when no tool call is attached, and support approving edited JSON input through the same runtime permission owner.

Android, iOS, and HarmonyOS terminal WebViews share `src/shared/terminal/webview` assets. The native adapter only bridges keyboard input, dimensions, and cursor-derived output; it has no Relay token or local process access. Android/iOS downloads stage chunks into a controller-local temporary file and hand its URL or input stream to the platform document exporter. They do not retain the full download in a Kotlin ByteArray or Swift Data. Preview buffers have their own bounded presentation policy.

Android, iOS, and HarmonyOS expose a device-tools button at the bottom of the sidebar.
The page selects a runtime location (the controlled device or one of its saved SSH
connections) and provides Files and Terminal tabs independently of any workspace.
Switching tabs retains the selected location and does not create a terminal;
opening a PTY is an explicit action.
Local defaults come from the runtime's `get_system_info.homeDir`; SSH defaults to
`/`. A successful directory change captures that directory and provider for file
transfers. No workspace registration or current-workspace switch is required.
Local filesystem and PTY requests explicitly select the local provider, so an
identically named SSH path cannot redirect them. Workspace and assistant “+”
menus contain Minimal, Standard, and Ultimate creation modes only.

Android and iOS expose a runtime directory picker using the selected saved SSH
connection, plus server-side name and modification-time sorting before directory
pagination. File editing opens a separate full-screen native view; returning
preserves the directory and asks before discarding edits. Its line-number gutter
shares vertical scrolling with unwrapped source text and never changes file
contents. Rename and delete remain available in that editor. The terminal tab
fits its PTY viewport into the remaining safe-area and keyboard-adjusted space;
leaving the page keeps the terminal running until an explicit close. Native build checks cover integration, while keyboard, scrolling,
and live runtime behavior still require device or simulator interaction checks.

Creating an ordinary chat sends `Claw` without a workspace override and lets the
runtime resolve or create its primary assistant workspace. Selecting a project
or a particular assistant sends its explicit path instead. Neither flow changes
the runtime’s current workspace as a prerequisite. Creation results use the
runtime-returned `workspace_path` for immediate session placement; a saved SSH
project carries its connection identity through the create request.

## Connection recovery

Native iOS and Android controllers probe the selected runtime while in the
foreground, including idle open conversations. Each probe has a ten-second
deadline, and the next starts fifteen seconds after the previous one finishes.
Backgrounding cancels the probe. Durable replay recovers conversation records,
but Relay availability alone does not prove the execution host is online.
Temporary transport failures keep the displayed list, transcript, and draft; a
successful response restores the connected state. Connection feedback stays in
the sidebar instead of inserting a banner above the conversation.

Account sign-in on Android, iOS and HarmonyOS opens the shared authorization page
with separate GitHub and email-code options. Email users need no password and are
not automatically linked to GitHub users. Sign in with the same method and account
on the phone and the controlled desktop/CLI.
