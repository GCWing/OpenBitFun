[English] | [简体中文](Agent-模式) · [Home](Home)

# Harnesses and Agent selection

## Choose how the task runs

OpenBitFun 1.0 exposes four general Harnesses. They apply across coding, research, writing, and analysis; choose by the collaboration you need, not only by output format.

| Harness | When to choose it | Example |
| --- | --- | --- |
| Minimal | Clear scope and quick iteration | “Explain this function, then answer my follow-up.” |
| Standard | Several dependent steps | “Analyze these files, propose changes, implement them, and verify.” |
| Ultimate | Demanding investigation or coordinated work | “Investigate this system and compare approaches before implementation.” |
| Creative | Build or extend your workspace | “Create a Mini App for repository insights.” |

Creative can work on client UI and runtime capabilities through its available tools. Distinguish installed-client customization from changing a source checkout; source changes still need the normal build and review workflow. Review requested access and keep a recovery path.

## Select a Harness or specialist Agent

1. Create a session in the intended project or assistant workspace.
2. Open the session execution selector in the chat input menu.
3. Choose a Harness, or select a visible specialist/custom Agent.
4. Check the model and permission settings before sending the first request.

The Harness is selected before the first turn. Once a session has started, choosing another execution profile asks to start a new session rather than silently changing the current run. Legacy sessions also retain their existing execution identity.

## Harness, Agent, tool, and workflow are different

A custom Agent can have its own instructions, model choice, tools, Skills, and read-only constraints. Browser automation and computer interaction are capabilities. Planning, debugging, and research are also tasks you can request in ordinary language.

Older guides listed Agentic, Plan, Debug, Multitask, Cowork, Computer Use, Deep Research, Team, and Claw as equivalent modes. That list is not the current general Harness chooser. Some names remain specialist identities or compatibility identifiers; an old name is not evidence of a current mode button.

For “plan first,” explicitly ask for a proposal without edits. Harness selection itself is not permission to implement, publish, or perform destructive actions.

[Agent configuration](Customize-and-Extend) · [Sessions](Sessions-and-Goals)

> Screenshot pending: S03 — Harness chooser; S04 — started-session confirmation.
