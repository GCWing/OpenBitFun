## Current Tool Default Exposure States and Agent Overrides

This document describes the statically registered product tools. The registry
order and names come from `product_runtime/materialization.rs`; a tool may still
be unavailable when its owning Cargo feature is not selected.

Notes:

- `Default state` comes from `Tool::default_exposure()`. Tools that do not
  implement that method inherit `Direct` from the tool framework.
- `Overriding agents` lists built-in agents whose
  `tool_exposure_overrides()` explicitly changes the tool's default. An
  override matters only when the agent already allows that tool.
- Agent IDs in this document are the registry IDs, such as `CodeReview` and
  `ReviewWorker`.
- Custom subagents do not currently support independent exposure overrides and
  inherit each tool's default behavior.
- Dynamically registered MCP tools default to `Deferred`; they are discovered
  at runtime and are not enumerated in the built-in table below.
- When `ai.enable_deferred_tool_loading=false`, all allowed tools are exposed as
  `Direct`, and `GetToolSpec` plus `CallDeferredTool` are removed from the
  model-visible manifest.

## Tool Exposure Table

| Tool | Default state | Overriding agents | Override state |
|---|---|---|---|
| `LS` | Direct | None | - |
| `Read` | Direct | None | - |
| `view_image` | Direct | None | - |
| `analyze_image` | Direct | None | - |
| `Glob` | Direct | None | - |
| `Grep` | Direct | None | - |
| `Write` | Direct | None | - |
| `Edit` | Direct | None | - |
| `Delete` | Direct | None | - |
| `ExecCommand` | Direct | None | - |
| `WriteStdin` | Direct | None | - |
| `ExecControl` | Direct | None | - |
| `GetTime` | Direct | None | - |
| `ListModels` | Deferred | None | - |
| `Task` | Direct | None | - |
| `AgentSpawn` | Direct | None | - |
| `AgentSendInput` | Direct | None | - |
| `AgentControl` | Direct | None | - |
| `AgentList` | Direct | None | - |
| `AgentWait` | Direct | None | - |
| `LaunchReviewAgent` | Direct | `CodeReview` | Deferred |
| `Skill` | Direct | None | - |
| `AskUserQuestion` | Direct | None | - |
| `TodoWrite` | Direct | None | - |
| `get_goal` | Direct | None | - |
| `create_goal` | Direct | None | - |
| `update_goal` | Direct | None | - |
| `submit_code_review` | Direct | None | - |
| `GetToolSpec` | Direct | None | - |
| `CallDeferredTool` | Direct | None | - |
| `OpenBitFunControl` | Direct | None | - |
| `GetFileDiff` | Deferred | `CodeReview`, `DeepReview`, `ReviewFixer`, `ReviewWorker`, `ReviewJudge` | Direct |
| `CreateCanvas` | Direct | None | - |
| `ReadCanvas` | Direct | None | - |
| `UpdateCanvas` | Direct | None | - |
| `PatchCanvas` | Direct | None | - |
| `ListWorkspaces` | Deferred | None | - |
| `SessionControl` | Deferred | None | - |
| `SessionMessage` | Deferred | None | - |
| `SessionHistory` | Deferred | None | - |
| `Cron` | Deferred | None | - |
| `PortForward` | Deferred | None | - |
| `WebSearch` | Deferred | None | - |
| `WebFetch` | Deferred | None | - |
| `ListMCPResources` | Deferred | None | - |
| `ReadMCPResource` | Deferred | None | - |
| `ListMCPPrompts` | Deferred | None | - |
| `GetMCPPrompt` | Deferred | None | - |
| `GenerativeUI` | Deferred | None | - |
| `Worktree` | Deferred | None | - |
| `ReviewPlatform` | Deferred | None | - |
| `InitMiniApp` | Direct | None | - |
| `FinalizeMiniApp` | Direct | None | - |
| `PublishMiniApp` | Direct | None | - |
| `FrontendWorkbench` | Direct | None | - |
| `PublishAppearance` | Direct | None | - |
| `PageDeploy` | Direct | None | - |
| `PagePublish` | Direct | None | - |
| `ControlHub` | Deferred | `ComputerUse` | Direct |
| `ComputerUse` | Direct | None | - |
| `Playbook` | Deferred | None | - |

## Agents With Override Policies

| Agent ID | Overrides |
|---|---|
| `ComputerUse` | `ControlHub`: Direct |
| `CodeReview` | `GetFileDiff`: Direct; `LaunchReviewAgent`: Deferred |
| `DeepReview` | `GetFileDiff`: Direct |
| `ReviewFixer` | `GetFileDiff`: Direct |
| `ReviewWorker` | `GetFileDiff`: Direct |
| `ReviewJudge` | `GetFileDiff`: Direct |
