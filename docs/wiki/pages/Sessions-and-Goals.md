[English] | [简体中文](会话与持续目标) · [Home](Home)

# Sessions and sustained goals

## Start and organize

Create a session in the intended workspace, choose the Harness/Agent before the first turn, then select the model and permissions. Rename, archive, restore, search, fork, or export sessions as needed. Deletion is different from archiving and should be intentional.

Inspect tool output, modified files, background commands, and pending interactions rather than relying only on a final completion message.

## Steer, interrupt, and recover

Send additional instructions to redirect active work through the supported steering flow. Inspect queued messages before assuming they have been executed. Interrupt or cancel a run when needed; these actions do not undo edits or external effects already performed.

Recovery depends on persisted session/runtime state and the executing host. A lost connection is not proof that a task stopped. Confirm host and session identity before retrying a submission to avoid duplicate work.

## Forks and context

Fork a conversation to explore another direction. A fork copies selected history; it does not automatically create a Git worktree or duplicate files. Remote forks retain their connection and POSIX path and share the original working tree.

Context reload, instruction initialization, memory management, and compression affect what the model sees; they do not necessarily delete persisted history. A memory reset is a separate operation from session removal.

Use lightweight BTW questions or editor inline AI for side questions where available. Keep the main task's scope explicit.

## Sustained goals

For work that needs a durable objective, explicitly ask to create a session goal. Inspect its objective and status; edit or clear it when necessary. Goals can be completed or marked blocked based on actual progress, not merely on a tool count.

A goal is not a schedule. Use [scheduled jobs](Tasks-and-Automation) for future runs and [Dispatch](Detached-Dispatch) for target-owned remote execution.

Review the session's request, token, and cost report where available. Provider pricing and reported usage can differ; verify consequential billing assumptions with the provider.

[Session reference](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/interactive-capabilities/capabilities/feature.ai-assistant.md)

> Screenshot pending: S27 — session actions and goal; S28 — usage and background commands.
