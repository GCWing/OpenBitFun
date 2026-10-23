[English] | [简体中文](任务板与定时任务) · [Home](Home)

# Task board and scheduled work

## Plan future or recurring work

Open the Task Board to inspect Pending, Calendar, and Inactive views. Scheduling is separate from a session goal: it decides when and where another run should start.

1. Create a scheduled job from the available task/assistant entry, or ask the Agent to create one.
2. Define the objective and choose one-time, daily, weekly, or custom Cron scheduling.
3. Review the displayed timezone and upcoming occurrences; make the intended timezone explicit in your request.
4. Choose the workspace, Agent, model, work mode, and supported execution target.
5. Save, then inspect the calendar and enabled state.

Use a harmless initial task to verify your environment before relying on a consequential recurring workflow.

## Host and permission requirements

The owning scheduler/execution host must be available and ready. Scheduling on a remote target requires the relevant connection/capability; it does not make every target automatically usable.

A pending permission request may need a remote answer. Do not assume that scheduling authorizes purchases, publishing, deletion, or unlimited Full Access. A switched-off machine is not a cloud scheduler.

Assistants can manage jobs scoped to their own workspace. Verify the selected workspace rather than assuming all assistants share the same task list.

## Edit and stop

Inspect the next run, edit timing or scope, and enable or disable the job. Disable future occurrences when pausing a routine; cancellation of an already running session and deletion of the job are separate actions.

Example: “Every Monday at 09:00 in my timezone, summarize this project's recent work. Save a report, but do not send messages or change source files.”

[Scheduling reference](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/interactive-capabilities/capabilities/feature.tasks-automation.md)

> Screenshot pending: S29 — board/calendar; S30 — job configuration and target.
