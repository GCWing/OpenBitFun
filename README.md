**English** · [中文](README.zh-CN.md)

<div align="center">

<img src="./png/openbitfun-wordmark.png" alt="OpenBitFun" width="520" />

### Built to keep going.

OpenBitFun is a highly customizable, open-source agent workspace that keeps work moving your way.

**Four powerful Agent Harness modes** · **Cross-device remote control** · **Customization from Mini Apps to source**

**If this is the kind of agent workspace you want, ⭐ Star OpenBitFun and help more people discover it.**

[Download Desktop](https://openbitfun.com/download) · [Mobile Releases](https://github.com/GCWing/OpenBitFun/releases?q=mobile-&expanded=true) · [Mini App Marketplace](https://market.openbitfun.com/miniapp/) · [Join the community](#join-the-community) · [Contribute](./CONTRIBUTING.md)

[![Website](https://img.shields.io/badge/Website-openbitfun.com-0b7285?style=flat-square)](https://openbitfun.com/)
[![Core code: MIT](https://img.shields.io/badge/core_code-MIT-yellow?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](https://openbitfun.com/download)

[![Trendshift](https://trendshift.io/api/badge/repositories/44672)](https://trendshift.io/repositories/44672)

</div>

---

<div align="center">
  <video src="https://github.com/user-attachments/assets/ff1780fa-d248-40f1-9582-82e0de3d2f46" controls width="800"></video>
</div>

---

<p align="center">
  <img src="./png/openbitfun-desktop.png" alt="The OpenBitFun desktop home screen" width="49%" />
  <img src="./png/openbitfun-desktop-session.png" alt="The OpenBitFun desktop multi-agent session" width="49%" />
  <br />
  <img src="./png/openbitfun-desktop-settings.png" alt="The OpenBitFun desktop settings screen" width="49%" />
  <img src="./png/openbitfun-desktop-task-board.png" alt="The OpenBitFun desktop task board" width="49%" />
</p>

## Four modes for the way you work

**The Agent Harness shapes how a task gets done.** It plans steps, manages context, calls tools, coordinates agents, and brings their results together. Choose the mode that fits the task:

![Four working modes: Minimal, Standard, Ultimate, and Creative](./png/openbitfun-harness-modes.png)

| Mode | When to use it |
| --- | --- |
| **Minimal** | **Quick collaboration.** Start with a clear goal. The agent acts directly, you give feedback, and you refine the work together. |
| **Standard** | **Everyday tasks.** For work with several steps: plan the approach, work through it, and check the results. |
| **Ultimate** | **Complex tasks.** Dig into demanding problems, divide the work among agents, and bring their results together. |
| **Creative** | **Creation and customization.** Build Mini Apps or extend OpenBitFun's interface and capabilities to make the workspace your own. |

## Switch computers. Control from your phone.

**Switch the device, switch the entire workspace.** Choose another connected computer in the desktop app, and the interface switches to that device's sessions, workspaces, files, and task status. Move between your home computer, office computer, and server from the same app.

**Your phone is a remote controller.** Send instructions, check progress, and respond to approval requests from your phone or browser. Tasks run on the selected host and keep going when you switch views or disconnect the controller.

**On mobile, switch between layouts for one, two, or three screens.** Focus on the conversation with a single screen, then unfold your phone to view conversations and files side by side. The interface adapts as the screen layout changes.

![Switching between connected computers and remotely controlling the selected device from a phone](./png/openbitfun-multi-device.png)

<details>
<summary>Connection and deployment details</summary>

Use SSH to work on a remote host, through a jump host, or inside a container, with files, commands, and agent execution in the target environment. The desktop app and CLI share core execution capabilities; mobile clients and messaging bots offer more ways to control tasks.

Account login, synchronization, and control between devices on the same account run through a [Relay server you deploy](./src/apps/relay-server/README.md). See [Remote Connect](./docs/interactive-capabilities/capabilities/feature.remote-connect.md) and [remote workspaces](./docs/features/remote-workspaces.md) for connection options.

</details>

## Turn everyday needs into useful apps

Build a Git insights panel for a repository, a workspace for presentations, or a form that brings routine actions together. **Mini Apps turn specific needs into tools you can use.**

Describe what you need and let the agent build it. Each Mini App pairs a dedicated interface with an agent conversation, so you can use the app for everyday work and keep improving it through chat.

Install and reuse the apps you build, or explore the [Mini App Marketplace](https://market.openbitfun.com/miniapp/) for tools that fit your work.

## Extend OpenBitFun with OpenBitFun

**Customize the roles, tools, interface, and source code.** Start with an agent that fits your work, then extend the workspace around it:

- **Build a specialist agent.** Choose a model, define its role, and equip it with the tools and workflows it needs for motion comic production, visual design, code review, or your own field.
- **Connect tools and workflows.** Connect tools through MCP, turn repeatable processes into Skills, and use Hooks to customize how tasks run.
- **Change the interface and source.** Install [skins](https://market.openbitfun.com/skin/) for a new look, or modify the UI, tools, and runtime source to build your own version of OpenBitFun.

**You can ask OpenBitFun's Code Agent to modify and extend OpenBitFun itself.**

Learn more about [agent management](./docs/interactive-capabilities/capabilities/feature.agents.md), [Hooks and compatibility](./docs/features/agent-hooks.md), and the [product architecture](./docs/architecture/product-architecture.md).

## Built for sustained work

The Rust Agent Runtime manages session state, context, and tool execution. Persistent sessions, interruption recovery, long-term memory, and support for extended tasks help keep work moving. Context compression and cache reuse help control resource consumption over longer runs.

In this **DeepSWE v1.1** evaluation, OpenBitFun achieved:

- **GLM-5.3-Flash**: **64.6%** pass rate, **42.9 minutes** median runtime (P50).
- **DeepSeek-V4-Flash**: **56.6%** pass rate, **19.6 minutes** median runtime (P50).

![DeepSWE v1.1 comparison: pass rate, runtime P50, and token P50](./png/openbitfun-deepswe-v1.1.png)

## More to explore

**These are just some of OpenBitFun's features.** Explore more tools, workflows, and extensions as you put it to work on your own tasks.

![A selection of OpenBitFun's features](./png/openbitfun-feature-wall.jpg)

## Where we're headed

OpenBitFun is still evolving. Here are three directions we want to explore:

- **Lights-Out Factory**: Plan and design during the day, let tasks continue on a server, and come back the next morning to review the results.
- **Infinite Radius**: Extend from desktops and phones to wearables and embedded devices, so work can continue in more places.
- **App Evolution**: Enable more people to shape software, from personal tools to versions tailored to a profession or industry.

Getting there means making long-running tasks more reliable, the runtime more efficient, and the desktop experience smoother.

## Build with it. Help shape it.

**Share what you build, offer feedback, or contribute code to help shape OpenBitFun.**

Share your use cases and experience, contribute agents, Skills, Mini Apps, or skins, or help improve the docs, interface, and runtime. Ideas and questions are welcome in this repository's Issues and Discussions. See the [contribution guide](./CONTRIBUTING.md) for the development workflow.

<details>
<summary>Download, setup, and running from source</summary>

Get the Windows, macOS, or Linux package from the [official download page](https://openbitfun.com/download). Install it, configure a model, and open a workspace to get started. See the [user guide](https://playbook.openbitfun.com) for usage instructions and [download verification](./docs/verify-downloads.md) for package signature checks.

**Migration note:** OpenBitFun 1.0.0 is not data-compatible with legacy 0.2.x releases. To migrate legacy data,
use the [OpenBitFun Data Tools](src/apps/data-tools/README.md), currently available
for stable releases 0.2.17–0.2.19.

To run from source, install [Node.js](https://nodejs.org/) 22.12+, [pnpm](https://pnpm.io/) 10.15.0, the [Rust toolchain](https://rustup.rs/), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Clone the repository, then run:

```bash
pnpm install
pnpm run desktop:dev
```

Desktop development supports frontend hot reload and automatic Rust rebuilds. See the [CLI guide](./src/apps/cli/README.md) for the command-line workflow.

</details>

Core code is licensed under the [MIT License](./LICENSE). Third-party dependencies and assets retain their own licenses. Thanks to the open-source authors and contributors who make this work possible. To report a vulnerability, see the [security policy](./SECURITY.md).

## Join the community

Scan the QR code with WeChat to add us and request to join the OpenBitFun community group.

<img src="./png/openbitfun-community-wechat.png" alt="WeChat QR code for joining the OpenBitFun community" width="360" />

## Star History

<a href="https://www.star-history.com/?repos=gcwing%2Fopenbitfun&amp;type=date&amp;legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=gcwing/openbitfun&amp;type=date&amp;legend=top-left&amp;theme=dark" />
    <img alt="OpenBitFun Star History Chart" src="https://api.star-history.com/chart?repos=gcwing/openbitfun&amp;type=date&amp;legend=top-left" />
  </picture>
</a>
