[English] | [简体中文](自定义与扩展) · [Home](Home)

# Customize and extend

## Start with the smallest extension

1. Adjust a role's instructions and permissions.
2. Add a Skill for repeatable knowledge.
3. Connect MCP for external tools.
4. Build a Mini App for a dedicated interface.
5. Add trusted Hooks for lifecycle behavior.
6. Use selective ecosystem compatibility or ACP where appropriate.
7. Modify source only when the product itself needs to change.

## Agents, Skills, and MCP

In Agents, inspect built-in, user, project, and external roles. Configure tools/tool groups, Skills/Skill groups, model strategy, and read-only constraints according to the visible host catalog. Subagents handle bounded delegated tasks; delegation does not make every independent role a general Harness.

Skills guide workflows and may require runtime dependencies. Check source, scope, shadowing, and availability. For MCP, configure the transport and authentication, test the connection, and explicitly select the server/tools for relevant Agents. Saved MCP configuration and a connected MCP service are different states.

## Hooks

OpenBitFun native user Hooks implement the Codex hook contract, with documented deviations. Use OpenBitFun's own user/project configuration files and Settings → Agent Hooks. Project Hooks are off by default and run code from a repository: enable only after review.

Compatible Claude Code/Codex command Hooks can be imported as explicitly reviewed snapshots. Updates need another review; removing a managed copy does not modify the source tool's files. Hook management and execution are local-only; remote workspaces return unsupported.

OpenCode plugin callbacks are discovery/static-preview data, not executable native Hooks. Follow the [OpenBitFun Hook guide](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/features/agent-hooks.md) for paths, gates, and compatibility limits.

## Ecosystem compatibility

The compatibility UI covers OpenCode, Claude Code, Codex, DeepSeek Harness, and PI. Inspect per-source/per-category status. Discovering content, importing a copy, enabling it, and connecting its dependencies are distinct steps.

Select supported Skill/MCP/Hook items, review import plans and conflicts, then confirm the copy. Commands, tools, and subagents use their supported compatibility paths; this is not universal plugin execution. DeepSeek Harness/PI Hook catalogs are read-only. OpenCode's managed-package/static-preview support must not be described as its full live runtime.

## Skins and client customization

Open Settings → Application → Appearance for themes, language, fonts, local appearance packages, and the Skin market. Preview before applying, keep a known-good built-in appearance, and review market updates. [Skin market](https://market.openbitfun.com/skin/).

Creative offers client UI/runtime customization, distinct from a visual skin and from changing/building the source product. Source development follows the [contribution guide](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/CONTRIBUTING.md). ACP connects supported external Agent processes, with their own setup and trust boundaries.

> Screenshot pending: S22 — Agent capability configuration; S23 — ecosystem import; S24 — Hook review; S25 — appearance/Skin market.
