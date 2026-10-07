# Agent hooks

Hooks let you run your own commands at fixed points in the OpenBitFun Agent's
lifecycle: before and after a tool call, when a permission prompt would appear,
when a prompt is submitted, around context compaction, around subagents, and
when a session or turn starts or ends. A hook can observe what the Agent is
doing, add context the model will read, rewrite a tool call's arguments, or
block an action outright.

## OpenBitFun hooks are Codex hooks

OpenBitFun implements **the Codex hook contract**, not a OpenBitFun dialect:

- the same `hooks.json` document — events, matcher groups, handler fields;
- the same event names (`PreToolUse`, `PostToolUse`, `PermissionRequest`,
  `UserPromptSubmit`, `PreCompact`, `PostCompact`, `SessionStart`,
  `SessionEnd`, `SubagentStart`, `SubagentStop`, `Stop`);
- the same JSON payload on stdin, with the same field names;
- the same exit-code meanings (`0` success, `2` block with stderr as the
  reason, anything else a non-blocking error);
- the same JSON decision schema on stdout (`permissionDecision`,
  `updatedInput`, `additionalContext`, `decision`/`reason`, …).

**A Codex hook script runs in OpenBitFun unchanged, and vice versa — there is
nothing to port.**

So this page does not restate the reference. For event semantics, the exact
payload fields per event, and the decision schema, use Codex's own
documentation, which covers all of it well:

**→ <https://learn.chatgpt.com/docs/hooks>**

The rest of this page is only what is OpenBitFun-specific: where the files live,
how to switch hooks on, and where OpenBitFun currently differs.

## Where OpenBitFun reads hooks

Codex reads `~/.codex/hooks.json`; OpenBitFun reads its own config directory
instead. Everything inside the file is identical.

| Scope | Path |
| --- | --- |
| User | `<user config dir>/config/hooks.json` |
| Project | `<workspace>/.openbitfun/config/hooks.json` |

The user config directory is `~/.config/openbitfun` on Linux,
`~/Library/Application Support/openbitfun` on macOS, and `%APPDATA%\openbitfun` on
Windows.

Both layers are additive: every matching handler runs, user handlers first.
There is no override or shadowing between them. Changes are picked up without
restarting OpenBitFun.

## Turning hooks on

**Settings → Agent Hooks**, or directly under the `app` section of
`<user config dir>/config/app.json`:

```json
{
  "app": {
    "hooks": {
      "enabled": true,
      "project_hooks_enabled": true
    }
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `app.hooks.enabled` | `true` | Master switch. `false` disables all hooks. |
| `app.hooks.project_hooks_enabled` | `false` | Whether the project hook file is honored. |

**Project hooks are off by default.** A project hook file executes commands
that live inside a checked-out repository, so anyone who can land a commit
could otherwise run code on your machine. Turn it on only for repositories
you trust, and re-check the file after pulling.

Codex's `[features] hooks = false` has no OpenBitFun equivalent — use
`app.hooks.enabled` instead.

## Importing Claude Code and Codex command hooks

OpenBitFun can take a reviewed local snapshot of compatible `type: "command"`
hooks discovered from Claude Code or Codex. This is an explicit copy, not a
live mount of another product's configuration:

1. Open **Settings → Agent Hooks** or run `/hooks` in the TUI. Use
   `openbitfun hooks list` from the root CLI for a scriptable view.
2. Choose a source and review every effective command, Windows override,
   timeout, copied or external dependency, skipped item, and the plan
   fingerprint.
3. Confirm that exact plan. If the source changed after review, OpenBitFun writes
   nothing and returns a refreshed plan for another confirmation.

User sources are copied to OpenBitFun's user-managed data. Project sources are
copied to workspace-isolated data under OpenBitFun's project runtime area. Safe
relative script dependencies beneath a source's `.claude/hooks` or
`.codex/hooks` directory are copied into the immutable snapshot. Absolute
dependencies remain external and are called out during review; moving or
changing one can therefore change behavior without updating the snapshot.
Dynamic paths, globs, escaping paths, links, unreadable files, and files beyond
the fixed import limits are skipped rather than followed implicitly.

An imported source can be enabled, disabled, updated, or removed independently.
Removing it deletes only OpenBitFun's managed copy; it never edits Claude Code or
Codex files. Updates always require another exact-command review. Imported
layers run in this fixed order:

1. manual user `hooks.json`;
2. enabled user imports, ordered by stable import id;
3. manual project `hooks.json`, when project hooks are enabled;
4. enabled project imports, ordered by stable import id.

Import, update, enable, disable, and remove take effect on the next matching
Hook event; an already running Hook finishes against the snapshot it started
with. OpenBitFun does not re-import on startup, poll, or watch Claude Code/Codex
files. Use **Refresh** or `/hooks refresh` to check for source changes, then
review an update explicitly. The management and execution paths are local-only;
remote workspaces return unsupported instead of running local commands against
a remote path.

OpenCode plugin Hooks are intentionally excluded. Their JavaScript callbacks
need the OpenCode plugin execution domain; the current OpenCode Hook catalog is
still discovery/static preview and is not executable.

The compatibility page also discovers **DeepSeek Harness** and **PI** Hooks.
The Hook owner shows these sources as read-only, with their native events,
disabled/unsupported states, and unresolved-source diagnostics. Refresh uses the
same host catalog; discovering a source never loads or imports its code.

- DeepSeek Harness: `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`),
  `profiles/*/cordis.yml` and `cordis.patch.yml`, and the selected workspace's
  Cordis composition files. Explicit `dsh-hooks-claude-code` and `dsh-hooks-codex`
  rows provide `config.configPath`; relative paths use the selected launch
  workspace, not the profile directory. Without that workspace they remain
  unresolved. Group/insert rows and disabled groups are recognized. The Codex
  bridge supports only its five native events and skips asynchronous handlers.
  Bundle composition and runtime Cordis registrations remain opaque.
- PI: `~/.pi/agent/extensions` (or `PI_CODING_AGENT_DIR/extensions`),
  `.pi/extensions`, and `settings.json` extension paths relative to their owning
  config directory. Single `.ts`/`.js` entries, directory `index.ts`/`index.js`,
  and local `package.json` `pi.extensions` entries are inspected without import.
  Literal `pi.on(...)` registrations in a default function or arrow export are
  native-only; indirect exports and dynamic registrations are opaque. Package
  installation/resolution and dynamic selectors require PI itself.

Skill discovery also includes `.dsh/skills`, `$DSH_HOME/skills`, `.pi/skills`,
and `$PI_CODING_AGENT_DIR/skills` (default `~/.pi/agent/skills`). These sources
are appended to the existing root order. DSH supports direct bundles and flat
Markdown; PI additionally supports nested groups and optional frontmatter names.
Flat entries retain their own stable keys and Markdown filenames. Existing
directory-shaped payloads still default to `SKILL.md`. Configured/custom,
package-provided, and runtime-published Skill paths are outside this standard-root
discovery. Project roots use the active workspace; native ancestor/profile
resolution is not reproduced. Remote project Skill discovery uses the workspace
filesystem, while the Hook catalog still rejects remote workspace domains.

Source references: [DSH Skills](https://github.com/deepseek-ai/deepseek-harness/blob/c389f96bf3a9b6807cb71ed6bdad5849be0df6d8/docs/subsystems/skills.md),
[DSH Codex bridge](https://github.com/deepseek-ai/deepseek-harness/blob/c389f96bf3a9b6807cb71ed6bdad5849be0df6d8/packages/hooks/hooks-codex/src/config.ts),
[PI Skills](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/docs/skills.md),
[PI Extensions](https://github.com/earendil-works/pi/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/coding-agent/docs/extensions.md).

Root CLI equivalents are:

```text
openbitfun hooks list [--refresh] [--format text|json]
openbitfun hooks import --source <source-key> [--confirm <plan-fingerprint>]
openbitfun hooks update <import-id> [--confirm <plan-fingerprint>]
openbitfun hooks enable <import-id>
openbitfun hooks disable <import-id>
openbitfun hooks remove <import-id> --confirm
openbitfun hooks reset <user|project> --confirm
```

Import and update are preview-only without the matching fingerprint. TUI uses
the same backend and keeps `/hooks_external` and `/hooks-external` as aliases
for the unified `/hooks` management view. `reset` is available only as explicit
recovery for a corrupt OpenBitFun-managed index and never changes source files.

## Hooks declared by skills

Invoking a Claude-format skill through `Skill` registers its validated synchronous
`type: "command"` handlers in the existing Hook engine for that session. Discovery,
listing, and importing do not register or execute them. Imported Claude skills
retain their source dialect. The external Hook catalog remains read-only.

Skill hooks use the supported lifecycle events listed above, regular-expression
matchers, stdin JSON, exit-code blocking, and `updatedInput`. They run after the
configured command layers. Registration is idempotent; invoking a changed hook
declaration in the same session returns an error instead of replacing active rules.
`once: true` is consumed after exit code 0, atomically across concurrent dispatches;
exit 2, other failures, and timeouts leave it eligible. A skill loaded mid-batch is
a preflight barrier: later calls see its hooks even within the same model response.

The Claude adapter maps `Bash` to `ExecCommand` and `command` to `cmd`. For `Write`,
it translates the path-first `payload` into `file_path`/`content` and converts
`updatedInput` back before normal input validation. An ambiguous Write destination
is blocked while a matching skill hook is active. `Edit` keeps its existing fields.
The command receives `CLAUDE_SKILL_DIR`, `CLAUDE_SESSION_ID`, and
`CLAUDE_PROJECT_DIR`; this does not expand variables in the skill's prose.

Skill `PreToolUse` hooks also support Claude's `permissionDecision: "ask"` through
the existing session permission mailbox. An ask requires a fresh reply even in
bypass mode; a policy deny still wins. The hook reason is included in the approval
metadata. Native `hooks.json` keeps its Codex decision contract.

The master `app.hooks.enabled` gate applies. Project skills additionally require
`app.hooks.project_hooks_enabled`, including on subsequent dispatch. Activation
without a session/local workspace, or in an SSH/remote workspace, returns an
explicit error; no controller-local fallback executes. Remote control, Peer Device,
and Detached Dispatch reuse their target runtime's session and permission owners;
this change does not introduce a separate client-side hook runner.

Registrations survive ordinary turns and idle in-process session unloading. Session
end/delete/discard removes them and cancels running handlers; cancelled SessionEnd
dispatch also clears them. They are process-local and are not restored after a
runtime restart: invoke the skill again. Unknown events, asynchronous handlers,
`prompt`/`agent` handlers, and unknown execution fields reject the entire skill
rather than silently dropping constraints. Script files remain live dependencies,
as for native command hooks; the declaration fingerprint does not snapshot scripts.

## Quick start

Create `<user config dir>/config/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.command' >> ~/openbitfun-commands.log"
          }
        ]
      }
    ]
  }
}
```

Start a new session and ask the Agent to run a shell command; each command it
runs is appended to `~/openbitfun-commands.log`.

A hook that blocks — here, refusing edits under `migrations/`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "python3 ~/hooks/protect.py" }]
      }
    ]
  }
}
```

```python
#!/usr/bin/env python3
import json, sys

payload = json.load(sys.stdin)
if "/migrations/" in payload.get("tool_input", {}).get("file_path", ""):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Migrations are generated; edit the schema instead.",
        }
    }))
sys.exit(0)
```

## Where OpenBitFun differs from Codex

Everything not listed here behaves as the Codex documentation describes.

### Not supported

| Codex feature | OpenBitFun |
| --- | --- |
| `config.toml` `[hooks]` table | not read — put hooks in `hooks.json` |
| `[features] hooks = false` | use `app.hooks.enabled` |
| Plugin-bundled and managed hooks (`PLUGIN_ROOT`, `managed_dir`) | not supported |
| `prompt` and `agent` handler types | parsed so shared files stay valid, but skipped — only `type: "command"` executes |
| Remote workspaces | hooks are not dispatched: a local hook process and a remote workspace path do not describe the same filesystem. The skip is reported, not silent: when the host has rules for the event, the first skipped dispatch per session logs a warning, and the hook overview carries `remote_workspace_unsupported` so surfaces can say the configured rules did not run |

### Fields not populated yet

| Field or event | Current behavior |
| --- | --- |
| `transcript_path`, `agent_transcript_path` | always `null` |
| `permission_mode` | only `default` or `bypassPermissions` |
| `SessionStart.source` | only `startup`; `resume`, `clear`, `compact` are not dispatched |
| `SessionEnd.reason` | always `other` |
| `SubagentStop.stop_hook_active` | always `false` |
| `SubagentStop` | dispatched when a subagent settles successfully, not on failure, cancellation, or timeout |
| `Stop` | top-level turns only; subagent turns report through `SubagentStop` |

### Behavior worth knowing

- **A hook can narrow the permission policy, never widen it.** A `PreToolUse`
  `permissionDecision: "allow"` waives the interactive prompt, but a tool call
  denied by a permission rule stays denied.
- `PreToolUse updatedInput` is final-validated before execution. It may repair
  ordinary malformed input, but it cannot relax a non-relaxable internal
  constraint (for example, a user-requested edit restriction) that rejected
  the original input.
- `suppressOutput` is parsed and currently ignored.
- `continue: false` is honored for `PreToolUse` and `UserPromptSubmit`; for
  other events use `decision: "block"`.
- `PostToolUse` fires for error results too, not only successes.
- Limits: 1 MiB per `hooks.json`, 2048 handlers inspected across all layers
  (invalid and non-`command` handlers count toward it), and 10,000 bytes of
  model-visible text per hook before truncation.

## Security

A hook is arbitrary code that runs with your user account's full privileges,
every time its event fires. Treat `hooks.json` like a shell profile:

- Review any hook you did not write before enabling it.
- Keep project hooks off unless you trust everyone who can commit to the
  repository.
- A hook command that writes files directly bypasses the tool pipeline and its
  `validate_input` checks. Use `updatedInput` for tool rewrites; sandbox or
  disable untrusted command hooks when direct process side effects are unsafe.
- Payload values (prompts, tool arguments, file paths) are model- and
  user-supplied text. Parse them as JSON and never interpolate them into a
  shell command — that is why the examples above read fields with
  `jq`/`json.load`.
- Do not print secrets to stdout for `SessionStart`, `UserPromptSubmit`, or
  `SubagentStart`, where plain stdout becomes context the model reads.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No hook runs at all | `app.hooks.enabled` is `false`, the file is not at the documented path, or the workspace is remote (the log then carries a warning for the first skipped dispatch of each session). |
| Project hooks do not run | `app.hooks.project_hooks_enabled` is `false` (the default). |
| The whole file is ignored | Invalid JSON, or a root key other than `description`/`hooks`. |
| One event is ignored | Misspelled event name — the names are case-sensitive. |
| A handler never runs | Its matcher does not match, or the matcher is not a valid pattern. Matchers are regular expressions anchored to the whole value, so `Bash` matches `Bash` but not `BashOutput`. |
| A `prompt`/`agent` handler never runs | Only `type: "command"` handlers execute. |
| Blocking has no effect | Blocking needs exit code 2 (reason on stderr), or a `decision`/`permissionDecision` field on stdout with exit code 0. |
| Plain `echo` output is not visible to the model | Only `SessionStart`, `UserPromptSubmit`, and `SubagentStart` turn plain stdout into context; elsewhere use `hookSpecificOutput.additionalContext`. |

Configuration problems, non-zero exits, timeouts, and hook decisions are
written to the OpenBitFun backend log. See
[`src/crates/LOGGING.md`](../../src/crates/LOGGING.md) for how to raise the
log level.

## Related

- CLI `/hooks` shows manual and imported layers, discovers supported external
  sources asynchronously, and owns the import management actions described
  above. Edit `hooks.json` directly only for manual OpenBitFun layers.
- `/hooks_external` and `/hooks-external` are compatibility aliases for the
  same view; they do not create a second import or execution path.
