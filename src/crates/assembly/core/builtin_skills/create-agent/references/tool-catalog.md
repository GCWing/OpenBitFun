# Tool catalog for choosing agent capabilities

Use these tables to select tools for the user's tasks, then put their exact names in the agent's `tools` list.

## Inspect and search

| Tool name | Purpose |
| --- | --- |
| `LS` | List files and directories. |
| `Read` | Read file contents. |
| `Glob` | Find files by path or filename patterns. |
| `Grep` | Search workspace file contents using structured pattern matching. |

## File editing

| Tool name | Purpose |
| --- | --- |
| `Write` | Create or overwrite a file. |
| `Edit` | Make targeted changes to existing file contents. |
| `Delete` | Delete a file or directory. |

## Command execution

| Tool name | Purpose |
| --- | --- |
| `ExecCommand` | Run a shell command in the session's workspace environment. |
| `WriteStdin` | Send input to or collect output from a running ExecCommand session. |
| `ExecControl` | Interrupt or terminate a running ExecCommand session. |

## Agents and skills

| Tool name | Purpose |
| --- | --- |
| `Task` | Delegate work to a subagent task and collect its result. |
| `ListModels` | List enabled OpenBitFun model configurations. |
| `AgentWait` | Wait for selected background agent results. |
| `Skill` | Discover and load reusable skills for specialized workflows. |

## Web access

| Tool name | Purpose |
| --- | --- |
| `WebSearch` | Search the web for current information and sources. |
| `WebFetch` | Fetch a URL's content as raw text, Markdown, or JSON. |

## Goal management

| Tool name | Purpose |
| --- | --- |
| `create_goal` | Start a new active goal for the current session. |
| `get_goal` | Read the current session's active goal. |
| `update_goal` | Mark the current session's goal complete or blocked. |

## Image understanding

| Tool name | Purpose |
| --- | --- |
| `analyze_image` | Analyze an image file with the configured vision model. |
| `view_image` | Attach an image file for the current model to inspect visually. |

## Interaction and canvas

| Tool name | Purpose |
| --- | --- |
| `AskUserQuestion` | Ask the user focused follow-up questions during execution. |
| `GenerativeUI` | Render HTML or SVG visualizations and lightweight interactive widgets in chat. |
| `CreateCanvas` | Create a Canvas artifact scoped to the session. |
| `ReadCanvas` | Read Canvas metadata, diagnostics, and source. |
| `PatchCanvas` | Apply targeted patches to an existing Canvas artifact. |
| `UpdateCanvas` | Update an existing Canvas artifact. |

## Computer use and automation

| Tool name | Purpose |
| --- | --- |
| `ComputerUse` | Inspect the screen and control desktop input. |
| `ControlHub` | Control built-in or external browsers and existing terminal sessions. |
| `Playbook` | Retrieve predefined operation guides for common tasks. |

## OpenBitFun customization

| Tool name | Purpose |
| --- | --- |
| `OpenBitFunControl` | Discover and control OpenBitFun features and settings. |
| `FrontendWorkbench` | Draft and hot-apply the packaged OpenBitFun frontend with rollback protection. |
| `PublishAppearance` | Submit an Appearance package to the Skin market for review. |

## MiniApp development and publishing

| Tool name | Purpose |
| --- | --- |
| `InitMiniApp` | Create a new MiniApp skeleton in the Toolbox. |
| `FinalizeMiniApp` | Finalize MiniApp file edits and refresh its open runtimes. |
| `PublishMiniApp` | Submit an installed MiniApp to the market for review. |

## Other

| Tool name | Purpose |
| --- | --- |
| `TodoWrite` | Create and update the session's todo list. |
| `Cron` | Manage scheduled jobs. |
| `Worktree` | List worktrees and manage isolated sessions, branches, and worktree removal. |
| `GetFileDiff` | Show a file's diff against its baseline snapshot or Git HEAD. |
| `ReviewPlatform` | Inspect and operate on hosted pull requests or merge requests. |
| `ListMCPResources` | List resources exposed by a connected MCP server. |
| `ReadMCPResource` | Read a connected MCP server's resource by URI. |
| `ListMCPPrompts` | List prompt templates exposed by a connected MCP server. |
| `GetMCPPrompt` | Fetch and render a named prompt template from a connected MCP server. |
| `SessionControl` | Create, list, rename, cancel, and delete persisted agent sessions. |
| `SessionMessage` | Send a message to another agent session and receive its result asynchronously. |
| `SessionHistory` | Export an agent session transcript and index for targeted history reads. |
| `PortForward` | Forward a port from an SSH host to the user's machine. |
| `PagePublish` | Upload, save a version of, and deploy an OpenBitFun Page. |
| `PageDeploy` | Deploy a saved OpenBitFun Page version to production. |
| `GetTime` | Return the current time, weekday, and Unix timestamp. |
| `AgentSpawn` | Launch an agent to work independently in the background. |
| `AgentSendInput` | Send an instruction to an existing agent. |
| `AgentInterrupt` | Interrupt an agent's active background work. |
| `AgentList` | List direct child agents and their status. |
| `AgentDelete` | Permanently delete direct child agent subtrees. |