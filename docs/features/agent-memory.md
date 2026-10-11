# Agent memory

OpenBitFun's memory system turns completed local sessions into a durable, file-based
memory folder that later sessions can read. It is a two-phase pipeline: phase 1
extracts per-session memories, phase 2 consolidates them into a small set of
handbook files.

Memory is **host-local**. It is produced and consumed on the machine that runs
the agent, and it is not synchronized between devices.

## Where memory lives

| What | Path |
| --- | --- |
| Memory workspace (git-tracked) | `<openbitfun home>/.openbitfun/memories/` |
| Phase 1/2 database (SQLite) | `<user data dir>/memories/memories.sqlite` |

The workspace is a real git repository that OpenBitFun initializes and re-baselines
itself. It is bookkeeping for the diff, not a user-facing repository: users never
commit or push it.

## Workspace layout

```
MEMORY.md                  consolidated handbook; grep entry point
memory_summary.md          prompt-loaded summary; first line must be `v1`
raw_memories.md            mechanical merge of the selected phase-1 outputs
rollout_summaries/*.md     per-rollout evidence referenced by MEMORY.md
skills/<name>/SKILL.md     reusable procedures (optional)
extensions/<name>/         extension inputs, including ad-hoc user notes
  ad_hoc/instructions.md   seeded instructions for the ad-hoc extension
  ad_hoc/notes/*.md        user-requested memory notes
```

## Pipeline

### Phase 1: per-session extraction

`MemoryPhase1Service` scans local workspaces for sessions that finished at least
`min_rollout_idle_hours` ago, claims them one at a time, renders the persisted
turns of the session, and asks the extraction model for a raw memory, a rollout
summary, and a rollout slug. Successful extractions are stored in the
`stage1_outputs` table with a `source_updated_at` watermark equal to the session's
last finished turn.

A session is skipped when it is archived, is not `memory_mode == Enabled`, has no
finished turn, has fewer than two turns, or is not idle enough yet. The age gate
(`max_rollout_age_days`) is evaluated last, and a run logs one aggregate line
reporting how many sessions the age gate discarded and how many of those were
never extracted.

Failed extractions decrement a three-attempt budget. When the budget is
exhausted the session is quarantined for 24 hours; after that window the budget is
restored once, so a transient provider failure is never a permanent dead end.

### Phase 2: consolidation

`MemoryPhase2Runner` owns one global job (`memory_consolidate_global`). A run:

1. checks the config gate and the retry backoff;
2. claims the job (lease + heartbeat);
3. prepares the workspace (seed the ad-hoc extension, ensure the git baseline);
4. loads phase-2 input candidates and selects the enabled rows up to
   `max_raw_memories_for_consolidation`;
5. rebuilds `raw_memories.md` and the rollout summaries from the current selection,
   and prunes summary files whose stage-1 row is gone;
6. computes the git diff of the workspace against the previous successful
   baseline;
7. runs the internal `MemoryPhase2` agent when there is real work.

The input rebuild happens whenever the input state can be derived: when there are
candidates, when stage-1 rows still exist, or when the workspace still holds
rendered input. An empty *enabled* selection therefore still drops the deselected
sessions out of `raw_memories.md`, so a disabled or polluted session is forgotten
in that same run rather than waiting for a later selection. Summary files are never
deleted by that rebuild, because the keep-set is every live stage-1 row.

The workspace diff is the input to forgetting. Only tracked and untracked content
files are diffed. Gitignored paths are never part of the diff, and OpenBitFun's own
tool state (the product's hidden data directory, `.openbitfun/` by default) is excluded whether or not the host
ignores it, so a local search index written into the memory root can never make an
unchanged workspace look dirty or leak tool state into the prompt.

**Divergence from the upstream memory design:** upstream also diffed ignored
paths and rendered each one as an added-file patch. This port keeps them out of
the diff, which is what the memory end-to-end test verified and which avoids a
whole-workspace diff churn whenever a user or global ignore rule changes. The
consequence is explicit and deliberate: a memory file inside the memory root that
a user or global gitignore rule matches is **not** consolidated. Keep memory
files un-ignored. Each diff computation reports the skipped paths once (count plus
a bounded sample) so the divergence is visible instead of silent.

A workspace change is *meaningful* when it touches `MEMORY.md`,
`memory_summary.md`, `raw_memories.md`, `rollout_summaries/**`, `skills/**`, or an
`extensions/**` content file. Re-seeding `extensions/ad_hoc/instructions.md` on
its own, and the generated `phase2_workspace_diff.md`, are not meaningful.

### Scheduling and cooldown semantics

The success cooldown (`phase2_success_cooldown_seconds`, default 6 h) is evaluated
**after** the candidate load and the workspace diff, and it only suppresses a run
that has nothing to do:

- new phase-1 input → the cooldown is bypassed;
- meaningful workspace changes (for example a new ad-hoc note, or a session that
  dropped out of the selection) → the cooldown is bypassed;
- neither → the run releases the job as idle and returns without invoking the
  model.

Freshness is measured against the job's *evaluated input clock*
(`input_watermark`, the newest candidate watermark this pipeline has accounted
for), not against the last successful consolidation. Every completed run — idle or
consolidating — records the newest candidate it evaluated, so a candidate that
stays unselected (for example a memory-disabled session) cannot keep the cooldown
disarmed forever. A run that finds no meaningful change completes without an LLM
call and records "No memory workspace changes to consolidate."

The retry backoff (`phase2_retry_delay_seconds`) stays a hard gate and is checked
before the claim.

### Ownership, leases, and the unattended consolidation turn

The global job is claimed with an ownership token and a lease
(`phase2_lease_seconds`, default 1 h) that the owner refreshes on a 30-second
heartbeat. Liveness is judged from the *remaining* lease: a claim is refused
(`SkippedRunning`) only while the incumbent still holds a lease that is fresher
than `phase2_lease_seconds - 120 s`, which is what a live owner looks like right
after a heartbeat. A run whose process died or was killed mid-consolidation stops
refreshing, so its lease drains past that window and the next claim reclaims the
job within about two minutes instead of waiting out the full lease. The
ownership-token compare-and-swap is unchanged, and the rule stays correct against
a live owner running an older build, which also refreshes its lease.

The window assumes the incumbent claimed with the currently configured lease
length, so raising `phase2_lease_seconds` while a run is in flight can make that
still-live run look stale; the ownership token still guarantees that only one run
can complete the job.

The consolidation turn runs as an internal `MemoryPhase2` agent on an ephemeral
child session with `emit_lifecycle_events = false`, so no surface can answer an
interactive permission prompt for it. The turn therefore requests
`permission_mode = auto_approve`, which answers in-root `Write`/`Edit` asks
in-process; the agent's tool allowlist and workspace path roots still bound what
it may touch. Auto-approve is a permission-mode change, not a sandbox: under it the
project sensitive-marker gate is skipped and native hooks see
`bypass_permissions: true` for this turn. Without it, an in-root write would wait
on a mailbox nobody answers and keep the job `running` until its lease expired. A
turn that does not finish cleanly (`PartialTimeout`) is logged as a warning, keeps
the workspace baseline and the pending diff, and is re-offered to the next pass
instead of being recorded as a clean consolidation.

### Retention and the forget loop

`max_unused_days` (default 30, and never below 1 day, so a misconfigured zero
cannot delete live input) is one retention clock for every stage-1 row. Phase-2
selection is not an exemption: a row unused for `max_unused_days` is deleted in
batches, whether or not it was selected, and the consolidated `MEMORY.md` content
that depended on it is removed by the next consolidation:

```
row pruned -> its rollout summary file is deleted at the next sync
           -> the deletion appears in the workspace diff
           -> phase 2 removes the memory content that depended on it
```

The usage clock (`last_usage`) advances on every memory read that resolves to a
row: memory citations, `MemoryFetch` reads, and `MemorySearch` hits.

Failure bookkeeping expires on its own clock. A failed stage-1 row whose failure
timestamp is older than `max_failure_report_days` is deleted, so a retry-exhausted
dead end (for example a model that no longer exists) cannot stay listed forever.
The sweep runs at startup and before every on-demand run, ahead of phase-1
claims, so an expired row is gone before the quarantine requeue would consider
renewing its attempt budget. Only per-session stage-1 `error` rows expire: the
global phase-2 job keeps its `last_error` as current-run diagnostics, and
`stage1_outputs` is never touched, so no extracted memory is lost.

Rollout summary files are only deleted when their database row is gone. A live row
that simply fell outside the current selection keeps its summary file, so
evidence that `MEMORY.md` still references is never destroyed.

The phase-2 prompt requires deletion, not annotation: a deleted input must be
removed from `MEMORY.md` and `memory_summary.md`, `[summary not in store]`-style
placeholders are not an acceptable terminal state, and a task group whose evidence
is entirely deleted is deleted as a whole. A deleted rollout summary that is
paired in the same diff with an added one sharing its
`<session-timestamp>-<4-char-hash>` prefix is a rename of the same session: the
prompt re-points the reference instead of forgetting the content.

## Read path

When `use_memories` is enabled and the session runs against a local workspace, the
`memory_summary.md` content is injected into the prompt together with a read-path
reminder describing the layout, the quick memory pass, and the citation contract.
If any memory file beyond the injected summary is read, the model appends one
`<openbitfun-mem-citation>` block as the last content of the reply.

## Memory tools

Sessions may expose three built-in memory tools:

| Tool | Purpose |
| --- | --- |
| `MemorySearch` | Search memory entries without a raw filesystem search. |
| `MemoryFetch` | Read one memory file; usage statistics are recorded automatically. |
| `MemorySave` | Write an ad-hoc memory note for an explicit user request. |

The read-path reminder tells the model to prefer these tools over `Grep`/`Read`
against the memory folder. `MemoryFetch` records usage by itself; a direct file
read still requires the `<openbitfun-mem-citation>` block.

## Configuration

Memory configuration lives in the top-level `memories` section of
`<user config dir>/config/app.json`:

```json
{
  "memories": {
    "generate_memories": true,
    "use_memories": true
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `generate_memories` | `false` | Enables phase 1 extraction and phase 2 consolidation. |
| `generate_for_btw_sessions` | `false` | Allows persistent BTW sessions to become memory sources. |
| `use_memories` | `false` | Injects the memory summary and read path into prompts. |
| `external_context_policy` | `clear_tool_results` | `clear_tool_results`, `allow`, or `skip_session` for sessions that used external context tools. |
| `max_raw_memories_for_consolidation` | `64` | Maximum stage-1 rows selected per phase-2 run (clamped to 4096). |
| `max_unused_days` | `30` | Retention window for stage-1 rows; a row unused for this long is deleted and its memory content is forgotten (clamped to 1..365). |
| `max_rollout_age_days` | `10` | Oldest source session phase 1 still considers (clamped to 365). |
| `max_failure_report_days` | `14` | Report window for failed stage-1 extraction records; older failure bookkeeping is deleted (clamped to 1..90). |
| `max_rollouts_per_startup` | `2` | Maximum source sessions claimed per startup pass. |
| `max_rollouts_scan_limit` | `2000` | Maximum source sessions scanned per startup pass. |
| `min_rollout_idle_hours` | `6` | Minimum idle time before a session can be extracted. |
| `phase1_max_concurrency` | `1` | Concurrent phase-1 extraction jobs. |
| `phase1_retry_backoff_minutes` | `60` | Backoff after a failed phase-1 extraction. |
| `phase1_lease_seconds` | `3600` | Phase-1 claim lease. |
| `phase2_lease_seconds` | `3600` | Global phase-2 job lease. |
| `phase2_success_cooldown_seconds` | `21600` | No-op protection window after a successful consolidation. |
| `phase2_retry_delay_seconds` | `3600` | Retry delay after a failed consolidation. |
| `extract_model` | unset | Model selector for phase 1; falls back to the primary model. |
| `consolidation_model` | unset | Model selector for phase 2; falls back to the primary model. |

## Public APIs

```rust
impl MemoryPhase1Service {
    /// Extract phase-1 memory for ONE session on demand. Bypasses the scan,
    /// idle, age, turn-count and current-session-exclusion gates, but still
    /// respects `generate_memories`, the session's `memory_mode == Enabled`,
    /// and claim/watermark semantics (up-to-date sessions return Ok with
    /// skipped stats).
    pub async fn run_once_for_session(
        &self,
        workspace_path: &str,
        session_id: &str,
    ) -> OpenBitFunResult<MemoryPhase1RunStats>;
}

impl MemoryDatabase {
    /// Read-only pipeline status: stage-1 counts, pending promotions, failed
    /// extractions, and the phase-2 job state.
    pub async fn status_snapshot(&self) -> OpenBitFunResult<MemoryStatusSnapshot>;

    /// Bump usage_count / last_usage for stage-1 rows matching rollout/session
    /// ids or rollout-summary file names. Returns rows updated.
    pub async fn record_memory_usage(
        &self,
        rollout_ids: &[String],
        summary_file_names: &[String],
    ) -> OpenBitFunResult<u64>;
}
```

## Remote scenarios

| Scenario | Behavior |
| --- | --- |
| Remote workspace | Phase 1 skips remote workspaces: only local session roots are scanned, and the memory folder is host-local. |
| Remote control (mobile web, IM bots) | Memory configuration and the read path are unchanged; the memory folder stays on the host that owns the session. |
| Peer Device Mode | The memory folder belongs to the host that runs the session; peer proxying does not move it. |
| Detached Dispatch | The target host owns the job and its memory folder; the controller never reads or writes memory on its behalf. |

Memory startup is not scheduled for remote workspaces, for sessions without user
input, or for subagent and ephemeral child sessions.
