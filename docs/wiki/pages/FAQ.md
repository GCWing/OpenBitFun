[English] | [简体中文](常见问题) · [Home](Home)

# FAQ

## Is OpenBitFun only for coding?

No. Coding, research, office work, and creation share the Agent workspace. A separate Cowork mode is not a prerequisite for documents or analysis.

## Which mode should I use?

The four general Harnesses are Minimal, Standard, Ultimate, and Creative. Start with Minimal for bounded work, Standard for everyday multi-step tasks, Ultimate for complex work, and Creative for workspace creation/customization. See [selection details](Agent-Modes).

## Can I ask for a plan without implementation?

Yes. Say “investigate and propose a plan, but do not edit.” A Harness choice does not override your task scope or permission rules.

## Can I change the Harness mid-session?

The current selector chooses it before the first turn. After a session starts, selecting another execution profile asks to create a new session. See [sessions](Sessions-and-Goals).

## Can I upgrade directly from 0.2.x?

Legacy data is not directly compatible with 1.0. Use the optional migrator for stable 0.2.17–0.2.19 and keep backups. [Migration instructions](Getting-Started).

## Is it free, and do I need an account?

Core code is [MIT licensed](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/LICENSE). Model APIs, cloud speech, infrastructure, and other services may cost money. Core local use does not need an OpenBitFun account; account-device control and Pages require configured account services.

## Can I work offline?

Only if the chosen model, speech, tools, and dependencies can operate offline. A cloud endpoint or web research naturally needs connectivity.

## Can it create editable office files?

Supported Skills/toolchains can produce editable artifacts. Check installed dependencies and validate the saved output; this is not automatic support for every format on every model.

## Does it upload my project?

Core use does not require whole-project account upload. Relevant content may still go to the configured model or external tools. See [privacy](Security-and-Privacy).

## What is the difference between SSH, peer control, and Dispatch?

SSH changes the workspace IO/command target while the Agent Runtime stays on the host. Peer control uses another host's product state and execution. Dispatch submits a target-owned durable job with a managed Git worktree. See [remote comparison](Remote-and-Multi-device).

## Can I close the controller?

Accepted peer work belongs to its executing runtime, not the controller UI. A Dispatch job can continue after durable acceptance while the controller disconnects. The executing host and dependencies must remain available; pending permissions can still block work.

## Does a session fork isolate files?

No. It copies history and preserves the workspace binding. Remote forks share the same working tree. Use a worktree or separate workspace for file isolation.

## Can I use a phone or messaging app?

Yes, through supported Remote Connect mobile/Bot flows. Browser/device control uses the same GitHub identity on both ends, including LAN mode; a QR invitation is not anonymous authorization. Bot setup has connector-specific credentials. Capabilities vary by surface; see [remote control](Remote-and-Multi-device).

## Are voice input and realtime calls the same?

No. Input transcription creates editable text before sending. Realtime calls provide ongoing spoken collaboration and can request project work. They have separate service requirements. See [voice](Voice-and-Realtime).

## What are Mini Apps, Pages, and skins?

Mini Apps are installed interactive tools; Pages publishes versioned static results; skins change appearance. See [Mini Apps and Pages](Mini-Apps-and-Pages) and [customization](Customize-and-Extend).

## Can I use another Agent ecosystem's plugins?

Compatibility is selective. Discovery/import/activation are different states, and OpenCode static preview does not imply full live plugin execution. [Compatibility limits](Customize-and-Extend).

## Where can I get help?

[Playbook](https://playbook.openbitfun.com), [Issues](https://github.com/GCWing/OpenBitFun/issues), and the [contribution guide](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/CONTRIBUTING.md). Include version, OS, target, error text, and reproduction steps; remove secrets. Report security issues privately.
