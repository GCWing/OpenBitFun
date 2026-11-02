# OpenBitFun Data Tools

[中文](README.zh-CN.md)

A separate, optional offline desktop utility. Its home page offers three tools,
in order: **Data migration**, **Reset OpenBitFun data**, and **Session repair**.
Choose a tool to enter its workflow; return home when idle to choose another.
Migration imports legacy BitFun data. Reset permanently clears the selected
OpenBitFun destination when you need a clean start. Session repair restores
sessions affected by earlier data or runtime-directory migrations.
The GUI repair engine is native Rust; Python is not required.

## Session repair

Open **Session repair**, confirm the OpenBitFun home and config roots, and select
**Scan and prepare repair plan**. A legacy BitFun install is not required.
Review directory moves, assistant identity field changes and skipped items.
Then close all product writers and select **Apply / resume repair**.

Repair moves entire session directories into the registered workspace runtime,
repairs proven old named-assistant IDs after the `.bitfun` rename, copies shared
snapshot dependencies without removing originals, rebuilds visible session
indexes, and invalidates rebuildable search caches. Local persisted SSH mirrors
are included without connecting to SSH. IDs absent from older sessions remain
absent; a unique registered path must prove their owner. Ambiguous/unregistered
workspaces, conflicting targets, malformed neighbors and missing snapshot
references are skipped with reasons. This tool does not change permission modes.

Plans, full-session backups and durable journals are stored beneath the existing
tool app-config directory in `session-repairs/<task-id>`, outside product data.
The UI shows that path. **Saved repair tasks** survive tool restarts; review one
to resume an interrupted repair or select **Roll back / resume rollback**. If
product data changed after planning or repair, execution/rollback refuses to
replace it; keep backups and review the diagnostic instead of resetting data.
Cancellation and window close stop at safe boundaries; close again once idle.
Backups include conversation content: keep them private and retain them until
sessions are verified. The standalone standard-library Python alternative is
[documented separately](../../../scripts/recovery/repair-session-storage.md);
its task files are independent of GUI task files.
Both tools share `.session-storage-repair.lock`. After a hard kill, close all
repair/product writers before manually removing that stale sentinel to resume.

The product and executable are **OpenBitFun Data Tools** and
`openbitfun-data-tools`. New releases use `data-tools-v<version>` tags. The
migration history remains readable. Tool settings use the new
`com.openbitfun.data-tools` identity; previous tool locations and language
preferences are not imported. Historical `data-migrator-v` tags remain
supported; release signing secrets use the `DATA_TOOLS_SIGNING_*` prefix.
Existing v0.1.2 downloads below predate the Session repair feature; build this
source or use a subsequent release to access it.

## Download and run

**Historical migration-only release: [v0.1.2 — download Data Migrator](https://github.com/GCWing/OpenBitFun/releases/tag/data-migrator-v0.1.2).**

| Platform | Download | Launch |
| --- | --- | --- |
| Windows x64 | `openbitfun-data-tools-v<version>-windows-x64.zip` | Extract, then double-click `openbitfun-data-tools.exe` |
| macOS Apple Silicon | `openbitfun-data-tools-v<version>-macos-arm64.dmg` | Open the DMG and its Data Tools app |
| macOS Intel | `openbitfun-data-tools-v<version>-macos-x64.dmg` | Open the DMG and its Data Tools app |
| Linux x64 | `openbitfun-data-tools-v<version>-linux-x64.AppImage` | Make executable and launch in a desktop session |

Windows needs the Microsoft Edge WebView2 runtime. macOS uses the system WebView;
Linux packages are built on Ubuntu 22.04. No login or network connection is
needed for migration. ARM Windows/Linux packages are not currently produced.

1. Close BitFun, OpenBitFun, their CLI instances, and background data writers.
2. Open Data Tools, choose **Data migration**, and check the **source and destination** directories.
3. Select the data groups, scan, then run the preflight plan.
4. Review the destination, scope, and conflicts, then start migration. If known writers
   remain open, the tool waits for them to stop; it does not terminate them.
5. Read the report. Sign in again or repair paths where indicated, close the
   tool, and open OpenBitFun yourself.

## Data and compatibility

Supported sources are **stable BitFun releases 0.2.17–0.2.19**, targeting
**OpenBitFun 1.0**. Direct migration from 0.2.16 or earlier is not supported;
upgrade BitFun first, launch it, and verify that your existing data is accessible.

Scanning isolates errors in individual sessions, runtime event logs, Skills,
MiniApps, and Agent definitions. Valid items continue to migrate; skipped items
remain in the source and are recorded in the report. Legacy session Turn counts
are rebuilt from the actual files in the migration copy only.
If an entire domain is unavailable, only that domain and its dependents are skipped.
If a domain fails during execution, it is rolled back before independent domains
continue. Execution stops if rollback cannot complete safely. Review warnings
and the migration report before retrying.

The destination is OpenBitFun: configuration schema **1**, workspace registry
format **1**, coordination database schema **2**, and the session, memory,
extension, and connection formats accepted by the shared storage owners in
this source revision. Unknown product/configuration schemas and newer SQLite
or session schemas fail validation.

Migration covers settings and credentials; user Agents, Skills and MiniApps;
workspaces, sessions and task records; memories; and local connection/device
records. Existing destination values take priority or conflicts are preserved
under a new identity according to the domain policy. Runtime caches, locks,
process discovery files, built-in executable content and request traces are
excluded. Credentials that cannot be decrypted on the destination require
sign-in again.

Source data is never automatically deleted. Writes use consistent snapshots,
staging, validation, backups, a migration lock and atomic replacement. Keep
both applications closed until the run finishes. Cancellation and window close
requests wait for an engine-declared safe boundary; already verified domains
may remain imported.

## Resume and diagnose

Plans, journals, reports, backups and staging live under:

```text
<destination settings-and-data>/data/migrations/bitfun-to-openbitfun/runs/<run-id>/
```

Reopen the tool, select the original directories, and use **Saved migration
tasks → Review / resume task**. Recovery requires a valid plan and unchanged
source fingerprint and resumes through the journal; it does not expire after
ten minutes. Completed reports can be reopened. New scans create new tasks and
never replace earlier journals. Old handoff-based plans remain readable even
if their `request.json` has expired; select the original locations before
resuming them. Unreadable files are not deleted or reset.

The tool remembers selected locations in its own `com.openbitfun.data-tools`
application configuration directory. It does not write main-app onboarding or
reminder preferences. **Export failure diagnostics** writes a sanitized file
containing result codes and journal phases. Review personal information before
sharing full reports or optional data directories as described below.

This tool only operates on files accessible on the computer where it runs.
Remote workspace execution, remote control, Peer Device Mode and Detached
Dispatch are not execution surfaces for it. Run it on the data-owning computer;
importing stored connection records does not connect to or migrate a remote host.

## Troubleshooting

**Migration finishes, but workspaces or sessions are empty, or some data is missing**

If you have already launched OpenBitFun or run a migration, existing destination data may take precedence and remain unchanged during retries.

If OpenBitFun contains no new data you need to keep, you can clear its destination data and retry:

1. Fully quit BitFun, OpenBitFun, their CLI/background writers, and other Data Tools instances.
2. Open Data Tools, choose **Reset OpenBitFun data** on the home page, check the destination locations, and select **Review reset directories**.
3. Save any data and migration logs/backups you need from the listed directories. **Reset permanently removes all their contents, including existing OpenBitFun settings, credentials, assistant workspaces, and sessions.** It does not create a backup.
4. Type `RESET`, then select **Permanently reset OpenBitFun data**. If a directory cannot be fully removed, close applications using it and retry before migrating.
5. Return to the home page, choose **Data migration**, and start a new migration. Launch OpenBitFun after migration finishes.

The reset preview uses the selected destination locations. For standard locations,
it also covers platform Skills/SSH parent directories and Desktop WebView/UI data
under `com.openbitfun.desktop`. It preserves the original BitFun source, the
tool's preferences, and ordinary project directories outside the listed roots.
Unsafe overlaps and linked reset paths are rejected.

Windows destination directories:

```text
%APPDATA%\openbitfun
%USERPROFILE%\.openbitfun
%LOCALAPPDATA%\OpenBitFun
```

On macOS the standard roots are `~/.openbitfun` and
`~/Library/Application Support/{openbitfun,OpenBitFun}`. On Linux they are
`~/.openbitfun`, `~/.config/openbitfun`, and
`~/.local/share/{openbitfun,OpenBitFun}` (or the corresponding XDG locations).
Always review the actual paths shown by the tool before confirming.

**The issue persists after retrying**

Open a report in [GitHub Issues](https://github.com/GCWing/OpenBitFun/issues) or share your feedback in the OpenBitFun user WeChat group. Include:

- Your operating system and the BitFun, OpenBitFun, and Data Tools versions.
- Steps to reproduce, the expected result, and the actual result.
- The workspace and session name or ID associated with missing data.
- Migration logs from the affected run.

Windows migration log location:

```text
%APPDATA%\openbitfun\data\migrations\bitfun-to-openbitfun\runs\<run-id>\
```

Provide the log files from the affected run, such as `report.json`, `plan.json`, `journal.jsonl`, `locations.json`, and `release-observation.json` when present. The `stage` and `backup` directories contain personal data, so sharing them is optional and at your discretion; the log files listed above are usually sufficient for an initial report. Save the logs before clearing the destination directories for another attempt.

Review the logs for personal information, such as usernames and paths, and redact it as needed before submitting.

## Build and release

From the repository root with Rust, Node, pnpm and the platform's Tauri build prerequisites:

```bash
pnpm install
pnpm run data-tools:dev       # independent window; no Desktop or dev server
pnpm run data-tools:build     # independent release bundle
cargo build -p openbitfun-data-tools --bin openbitfun-data-tools
```

Direct Cargo builds embed the committed UI and design-system CSS. After changing
the token/theme owners run `pnpm run data-tools:theme:generate`; the packaging
entry does this automatically. Desktop development/build commands do not build
Data Tools. Shared Rust crates remain in the same source workspace to preserve
storage compatibility; there is no dependency on the main application's Core,
runtime assembly, Web UI, installer or updater.

The tool version is maintained in its own `Cargo.toml` and `tauri.conf.json`.
The **Data Tools Package** workflow builds four platform artifacts manually
or on `data-tools-v<version>` tags (historical `data-migrator-v` tags remain supported). Tag builds require the separate
`DATA_TOOLS_SIGNING_PRIVATE_KEY`, `DATA_TOOLS_SIGNING_PRIVATE_KEY_PASSWORD`
and `DATA_TOOLS_SIGNING_PUBKEY` secrets, verify checksums/signatures, and create
a **draft** release for review. Manual workflow runs only upload CI artifacts.
Publishing Data Tools releases does not start main-app packaging or update feeds.

When publishing a new version, update the latest-release links in both README
files on the default branch and review [RELEASE.md](RELEASE.md), the release
description template used by the workflow. Source and guide paths live under
`src/apps/data-tools`.

Each asset has a SHA-256 sidecar and a base64-encoded minisign `.sig`; the
release also carries `SHA256SUMS` and `data-tools.minisign.pub`. Verify the key
against the maintainer's trusted key before checking signatures. Detached
signatures are distinct from Apple/Authenticode platform signing; the workflow
does not currently configure those certificates or macOS notarization.

Focused checks and architecture rules are in [AGENTS.md](AGENTS.md).

### Handling damaged legacy data

Scanning isolates invalid settings/model entries, workspace registrations, memory
rows/files, SSH profiles, Remote Connect files/Bots, Sessions, Skills, MiniApps,
and Agent definitions. Readable Turns within a damaged Session are recovered;
derived Turn counts and workspace reference lists are rebuilt. Identical Turn
copies are deduplicated; conflicting Turn identities are omitted with warnings.
Nested user memory notes are supported. Legacy memory jobs are not read or
imported: the runtime creates jobs on demand, and destination jobs stay intact.
Optional Skills and MiniApps do not block importing Agent definitions.

Item failures during staging are omitted from the committed manifest where the
item has an independent storage boundary. Source data remains read-only and the
report shows omissions and partial history recovery. Unreadable destination
stores, unsafe paths, unsupported schemas, changed inputs, and transaction/write
failures still protect the affected domain; independent domains can continue
after successful rollback. A failed rollback stops execution.
