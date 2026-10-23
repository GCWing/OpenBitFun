[English] | [简体中文](快速开始) · [Home](Home)

# Getting started and migration

## Install

Download the Windows, macOS, or Linux package from the [official download page](https://openbitfun.com/download). Choose the package matching your system and architecture; see [download verification](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/verify-downloads.md) for signature checks. Nightly builds are a separate, potentially unstable channel.

## Migrating from legacy 0.2.x releases

OpenBitFun 1.0 is not data-compatible with legacy 0.2.x installs. Do not point it at old data and assume an ordinary upgrade will convert everything.

The optional [Data Migrator](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/src/apps/data-migrator/README.md) supports stable legacy releases 0.2.17–0.2.19 as sources. Earlier versions require upgrading the old application first and checking that its data is readable.

1. Back up your data and close both applications, their CLI instances, and background writers.
2. Open the migrator on the machine that owns the data.
3. Check source and destination, choose data groups, scan, and review the preflight plan.
4. Run migration and inspect warnings, skipped items, conflicts, and the report.
5. Open OpenBitFun yourself; repair paths or sign in again where the report indicates.

The migrator does not automatically delete source data. Do not delete or reset either application's data as a generic recovery step. Remote connection records are data, not a migration of the remote machine.

## Start your first task

1. Follow setup to configure a supported model provider or custom endpoint. Check credentials, model capabilities, and the connection test. A saved configuration is not proof of a successful connection.
2. Open a project folder containing your code, notes, data, or other material.
3. Create a session. Start with Minimal for a bounded task or Standard for several steps.
4. Choose an approval-oriented permission posture for initial work.
5. Describe the outcome and constraints, then inspect the result.

Good first prompts:

- “Explain this project; do not edit files.”
- “Summarize these notes into a brief and identify unsupported claims.”
- “Analyze this workbook and save a report; ask before changing the source.”
- “Plan a small improvement, but wait for approval before implementing.”

Model use may incur provider charges. Account login is not required for core local work, but account-based device control and Pages need configured account services.

## Find help

Use global search and the [Playbook](https://playbook.openbitfun.com). See [Harnesses](Agent-Modes), [security](Security-and-Privacy), and [FAQ](FAQ). Report problems with the application version, OS, target environment, and reproduction steps.

> Screenshot pending: S05 — model setup and connection test; S06 — first session; S07 — migrator preflight.
