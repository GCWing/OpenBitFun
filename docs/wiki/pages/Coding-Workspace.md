[English] | [简体中文](编程工作台) · [Home](Home)

# Coding workspace

## From a request to an inspectable change

1. Open the correct project and check whether it is local, SSH, container, WSL, or peer-owned.
2. Ask the Agent to inspect the relevant code and explain its findings. For planning-only work, explicitly prohibit edits.
3. Review the approach, then authorize implementation within the intended scope.
4. Run the project's checks and inspect diffs and unresolved failures.
5. Review changes before committing, pushing, or publishing.

Use [Harness selection](Agent-Modes) for the execution approach. Debugging, planning, research, and review do not require the old mode buttons described in earlier guides.

## Integrated tools

- Files and editor: browse and organize material, search, edit code/text, view Markdown/images and diffs, and use available language services or inline AI.
- Terminal: run commands, use multiple terminal views, and inspect background processes.
- Git: inspect changes, history, branches, and worktrees; stage, commit, push, or pull with the appropriate authorization.
- Browser: inspect pages, follow supported interactions, and collect visual evidence.
- Review: ask for actionable findings or use the available review workflow. Read-only review must not silently implement fixes.
- Sessions: preserve separate conversations, inspect modified files, and manage history; see [sessions](Sessions-and-Goals).

Language intelligence and browser/computer actions depend on configured services and OS permissions. A successful command does not prove the resulting application works.

## Recovery is not a blanket backup

Session forks copy conversation history, not an independent filesystem. Snapshot and rollback capabilities depend on recorded coverage and target support; they are not protection for every command or external side effect.

For remote sessions, full file rollback and edit-and-rerun are currently unavailable until coverage can be verified. Some recorded operations can still show diffs after disconnect. Use Git commits and backups for recovery; do not assume a conversation fork isolates work.

[Remote guide](Remote-and-Multi-device) · [CLI reference](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/src/apps/cli/README.md)

> Screenshot pending: S08 — editor, terminal, and session; S09 — Git changes and review.
