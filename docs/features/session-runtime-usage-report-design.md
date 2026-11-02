# Session Runtime Usage Report Design

> Status: P0 and P1 implemented; P2 Desktop analysis surface hardening mostly implemented as of 2026-05-11
> Scope: `/usage`, Desktop Flow Chat usage reports, CLI usage reports, session runtime metrics, Chat-bottom usage entry
> Non-goal: this document does not prescribe exact code edits or final UI copy.

## Background

### Current side-panel scope

The side panel displays session/project identity, context
composition, and cumulative token shares. The former Usage details chapter and
its Overview, Models, Tools, Files, Errors, and Slowest tabs are removed. Chat
cards retain their report entry and compact summaries, but no longer offer jumps
to those removed tabs. Report data and Markdown export remain intact. Saved
panel tab hints are accepted and show the summary. Appearance parts now describe
the remaining UI; overrides for removed detail parts follow the existing
structured incompatibility diagnostics without rewriting saved packages. Detailed
tab and navigation descriptions in the earlier implementation stages below are
historical, not the current side-panel UI.

The session title is centered independently of the copy action. The generation
timestamp is omitted from the panel header; report and export timestamps remain intact.

The system-prompt, tool-definition, rules, skills, MCP/dynamic-tools and subagent
legend rows expose an external-link button on hover or keyboard focus. Each opens
its own read-only preview tab. Tool definitions use a searchable, expandable
`tool-definitions` document reader, showing tool descriptions and parameter types,
required flags, defaults, enums, nested structures and schema constraints. It
projects the existing captured definition array without altering persisted
sessions; the Markdown envelope and calling instructions remain compatible with
older captures. Other categories use the standard `markdown-editor`. The executing host replaces a single
session-local `usage-context.json` snapshot when preparing a request, using the
same typed sources as the category estimates. It includes prompt/reminder text,
native tool schemas and the model-visible Skill/GetToolSpec results; it does not
reload today's catalog or workspace files to reconstruct earlier content.

An explicit `contextPreviewCategory` request returns only that category in
`contextPreview`, including its capture time. Empty captured categories open an
empty-content message; absent snapshots/categories return unavailable. A snapshot
whose owning turn has been replaced or reverted is not exposed. This is the
latest prepared request, not a historical request selected from the chart.
The older `includeSystemPromptPreview` / `systemPromptPreview` cached-system-message
path remains readable as a fallback for older hosts and sessions. Ordinary usage
reports, persisted `/usage` results, and Markdown exports remain content-free.
Dispatch projections refuse preview instead of reading the controller's cache.
Tab identity and late responses remain scoped to the originating device, session,
and category; no filesystem editor path is created, and the standard Markdown
editor stays read-only in rich and source modes. Retained tool-definition Markdown
tabs also render through the structured reader and retain their tab identity.

### Context composition and token shares

The side panel separates the latest recorded parent request's context composition
from cumulative session token usage. The context donut has eight categories:
system prompt (including runtime context), tool definitions, rules (workspace/user
instructions), skills, MCP/dynamic tools, subagent definitions, summarized
conversation, and conversation. Typed runtime message/reminder provenance assigns
categories; user-authored text is never classified by matching prompt headings.
Counts use the runtime token estimator, are labelled estimates, and are not
provider billing counts or measured context-window occupancy.

Numeric-only composition snapshots travel in the existing opaque usage-record
`token_details.openbitfunModelRequest.contextComposition` field. The additive
optional report `context` field projects the newest in-scope parent request;
subagent records do not replace it. A newer request without a snapshot does not
reuse stale composition. Old records and external hosts without this telemetry
show an explicit empty state, while existing report totals remain usable.
The same runtime/report path runs on the executing host for local, SSH, Peer,
and detached jobs; no controller filesystem reads or new commands are required.

The leading project, cumulative token, and turn facts use the home overview's
rounded outline and inset vertical dividers, with centered values above labels.
The Token Usage section precedes context composition. Its continuous horizontal bar groups
cumulative tokens into input and output, with total tokens as the denominator.
With recorded cache counts, the input group splits into cached and remaining
parts in two shades of blue; output stays purple. Group labels above the bar show
input/output totals and shares. Cache hit rate appears in parentheses immediately
after the input share, with the cached/input calculation in its tooltip. The child legend
shows percentages of input, with counts and the denominator in tooltips. Parent
hover/focus highlights both input parts; a child highlights its own segment and
parent label. For complete telemetry, remaining input is labelled uncached. Partial
telemetry still plots recorded cache reads, but labels the remainder as remaining
input, including unknown cache usage. The inline hit percentage uses an explicit
lower-bound marker (≥) over all input tokens and a scope explanation in its tooltip;
it does not extrapolate the reported-call hit rate to unreported calls. Missing
or invalid cache counts keep a single input segment. Invalid or inconsistent
totals never produce invented segments.
Child widths are normalized within each parent group so they fill that group
instead of applying the overall share a second time. Nonzero groups and segments
have small visibility minimums; labels retain the actual percentages and zero
segments are omitted.

The token-level hit rate uses summed cache reads divided by summed total input
over the same records, not an average of per-request percentages or a share of
input plus output. This follows the [OpenAI caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).
The adapter already normalizes [Anthropic usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
by adding ordinary input, cache reads and cache writes; only reads enter the hit
numerator. The report's partial-coverage rate covers reported records only, so it
is not presented as the overall input hit rate or used to infer uncached input.

Long OpenBitFun sessions can include model streaming, tool execution, Git operations, file writes, Skills, MCP calls, context compression, subagents, retries, user confirmation waits, and file diffs. The chat transcript shows what happened, but it does not yet answer the user's operational questions:

- What recorded runtime spans are available for the session, and where are they approximate?
- Which models contributed token usage when a session used multiple models?
- Which tools, files, or retries dominated the session?
- Did context compression reduce or increase token pressure?
- Can this summary be read later in the conversation, not only in a temporary popover?

Claude Code's `/usage` is the closest product reference. Anthropic describes it as a command that helps users understand Claude Code usage in the context of session and context-window management. GitHub Copilot cloud agent exposes a session overview/log where users can track progress, token usage, session count, and session length. OpenAI Agents SDK is the useful engineering reference: its usage API tracks requests and tokens per run/request, while tracing models agent work as spans for model generations, tool calls, handoffs, guardrails, and custom events.

References:

- [Claude Code session management and `/usage`](https://claude.com/blog/using-claude-code-session-management-and-1m-context)
- [GitHub Copilot agent session tracking](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/track-copilot-sessions)
- [OpenAI Agents SDK usage](https://openai.github.io/openai-agents-python/usage/)
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)

External reference check: as of 2026-05-11, these sources support a narrow usage-report scope. Claude Code frames `/usage` around understanding session usage and managing context; GitHub Copilot exposes session progress, token usage, session count, session length, and logs; OpenAI Agents SDK separates per-run/request token usage from deeper span tracing. Treat these as product references, not compatibility requirements. OpenBitFun's boundary is intentionally narrower than a full tracing dashboard: it reports the current session's recorded runtime facts, their coverage, and safe navigation points back to the transcript or existing diff surfaces.

## Product Direction

OpenBitFun should support a Claude-like `/usage` command and a richer Desktop runtime report using the same underlying data.

The key product decision is:

> `/usage` creates a durable, readable session report in the current conversation, while Desktop also exposes the same action from one compact button in the Chat input footer.

The implemented report is intentionally a persisted-data report. It does not claim pure model streaming throughput, first-token latency, token-per-second speed, or live per-model timing unless a stable runtime span contract provides those fields.

This avoids making usage insight feel hidden behind a temporary button. Users should be able to run `/usage`, scroll back to the report, search it, export it with the session, and compare it with file changes.

## Closed Product Scope

The closed product is a current-session runtime report. It answers:

- How long the session spans and how much recorded work happened inside it.
- Which token, model, tool, file, error, compression, and slow-work facts were recorded.
- Which facts are complete, partial, or unavailable, with user-facing reasons near the affected values.
- Which transcript turn or existing diff surface can be opened for verification.
- Which report metadata should be copyable or exportable without exposing unnecessary path detail by default.

The product is complete when `/usage` can generate a durable, model-invisible report from the current session, the Chat-bottom entry exposes the same action, the detail panel makes recorded facts understandable, and partial data is clearly labeled. Anything that changes runtime policy, recommends workflow changes, aggregates across sessions, or shows live status belongs outside this closed scope.

## Independent Third-Party Review

Verdict: the direction is reasonable, but the current draft needs a few product and telemetry boundaries before it is safe to implement. The strongest decisions are:

- Use one structured report contract and surface-specific renderers instead of separate CLI/Desktop counters.
- Store Desktop `/usage` as user-visible but model-invisible local output.
- Start with existing persisted data, then improve accuracy with additive runtime spans.
- Exclude charts, cross-session summaries, and automated optimization advice from the closed product scope; keep the Chat-bottom action as a compact entry point backed by the same session-level contract.

The main remaining risk is not that the feature is too ambitious. The risk is that "usage reporting" accidentally becomes a second runtime control plane for budget, scheduler, retry, artifact, or context mutation behavior. The report should be an observability projection. It may consume runtime facts, but it must not decide scheduling, retries, context compaction, permissions, or runtime governance.

The current implementation resolves the important boundaries as follows:

- Standard `/usage` reports the current session only.
- Overlapping recorded spans use union accounting where supported, and the UI labels approximations.
- `/usage` requires an idle session and returns friendly local feedback while a turn is active.
- Cached tokens, reasoning tokens, local models, model aliases, and provider-specific token details are marked partial or unavailable when the source cannot prove them.
- Durable/exportable reports use bounded labels, workspace-relative paths where possible, and copy/export path redaction by default.

## Relationship to Adjacent Runtime Plans

This document should remain the user-facing reporting layer for session runtime facts. It should not duplicate the owner responsibilities already planned elsewhere:

| Area | Owner document / module | Usage report responsibility | Must not do |
| --- | --- | --- | --- |
| Budget, truncation, retry classification, output spill | `agent-runtime-budget-governance-design.md` and runtime budget modules | Show summarized facts and coverage when those events exist | Recompute budget policy, trigger compaction, retry model calls, or own spill decisions |
| Context mutation and health | `context-reliability-architecture.md` | Report context mutation timing, token before/after, and lossy/partial markers | Infer context quality from transcript prose or create a second health model |
| Subagent scheduling and gateway pressure | `docs/agent-runtime-subagent-scheduling-plan.md` | Report queued/running/retry/wait timing from scheduler events | Implement queueing, permits, retry backoff, or effective concurrency |
| Deep Review policy and evidence | `deep-review-design.md` and Deep Review services | Display reviewer/runtime contribution when linked to the session | Re-plan reviewer roles, strategy, retry budget, or evidence collection |

If two documents describe the same runtime fact, the implementation should pick one behavioral owner and let `/usage` consume the typed event or persisted summary from that owner.

## User Experience Shape

### CLI

In CLI chat mode, `/usage` should render a compact terminal-friendly report.

Current implemented shape:

```text
Session usage

Session span:        2h 14m
Recorded turn time:  18m 42s
Tool call time:       4m 36s
Compressions:         2

Tokens
Input:            183,420
Output:           21,908
Cached:           not reported
Total:            205,328

Models
gpt-5.4:          8 req, 183,420 input, 21,908 output

Tools
ExecCommand:      19 calls, 3m 13s, 2 errors
Write/Edit:       7 calls, 1m 08s
```

CLI may allow a one-line mode later, but the implemented command is a full report only.

### Desktop Chat Markdown Report

In Desktop Flow Chat, `/usage` should add a local, non-model-visible Markdown report into the chat stream.

The report should be durable and exportable:

- It persists with the session.
- It is searchable like other chat content.
- It is not sent back to the model by default.
- It can contain links/actions to open the detailed runtime panel or relevant diffs.

Current implemented Markdown shape:

```markdown
## Session Usage

| Metric | Value |
|---|---|
| Session span | 2h 14m |
| Recorded turn time | 18m 42s |
| Model round time | 11m 28s |
| Tool call time | 4m 36s |

### Tokens
| Type | Tokens |
|---|---:|
| Input | 183,420 |
| Output | 21,908 |
| Cached | not reported |
| Total | 205,328 |

### Models
| Model | Calls | Input | Output | Total |
|---|---:|---:|---:|---:|
| gpt-5.4 | 8 | 183,420 | 21,908 | 205,328 |

### Slowest Work
1. ExecCommand `pnpm run build:web` - 1m 42s
2. Context compression - 28s
3. ExecCommand `git fetch origin main` - 19s
```

The detailed visual report exists alongside the Markdown snapshot. It uses the structured DTO when present and falls back to the Markdown snapshot for historical/local-only reports.

### Desktop Chat-Bottom Usage Entry

The implemented Flow Chat entry is a compact action in the Chat input footer (`ChatInputWorkspaceStrip`) that generates `/usage` in the current chat. It intentionally avoids title/header placement and live timing values.

The Chat-bottom entry should never compete with the title/header row. It must preserve the input footer's workspace/branch controls, model selector, and send affordances. Its job is to start report generation, not to become a live status display.

## Current Reusable Capabilities

OpenBitFun can reuse several existing surfaces.

### Current code anchors

| Capability | Current anchor |
| --- | --- |
| Agentic event definitions | `src/crates/contracts/events/src/agentic.rs` |
| Token usage persistence and aggregation | `src/crates/assembly/core/src/service/token_usage/{types.rs,service.rs,subscriber.rs}` |
| Model stream timing currently logged/held during execution | `src/crates/assembly/core/src/agentic/execution/{round_executor.rs,stream_processor.rs}` |
| Context compression events and tool-like UI item | `src/crates/assembly/core/src/agentic/execution/execution_engine.rs`, `src/web-ui/src/flow_chat/tool-cards/ContextCompressionDisplay.tsx` |
| Tool lifecycle and total duration | `src/crates/assembly/core/src/agentic/tools/pipeline/{tool_pipeline.rs,state_manager.rs}` |
| CLI slash command handling | `src/apps/cli/src/modes/chat.rs` |
| CLI session/tool persistence | `src/apps/cli/src/session.rs`, `src/apps/cli/src/agent/core_adapter.rs` |
| Desktop token/compression event routing | `src/web-ui/src/flow_chat/services/flow-chat-manager/EventHandlerModule.ts` |
| Flow Chat Chat-bottom usage entry | `src/web-ui/src/flow_chat/components/ChatInputWorkspaceStrip.tsx` |
| Session file badge and diff affordances | `src/web-ui/src/flow_chat/components/modern/{SessionFilesBadge.tsx,SessionFileModificationsBar.tsx}` |
| Operation-level file diff and summary entry | `src/web-ui/src/flow_chat/tool-cards/FileOperationToolCard.tsx` |

### Existing events and runtime data

- `AgenticEvent::DialogTurnCompleted` already has turn duration, round count, tool count, success, finish reason, and partial recovery metadata.
- `AgenticEvent::TokenUsageUpdated` already carries session, turn, model, input/output/total tokens, max context tokens, and subagent marker.
- `AgenticEvent::ContextCompressionStarted/Completed/Failed` already exposes trigger, before/after tokens, ratio, duration, summary status, and subagent parent info.
- `AgenticEvent::ModelRoundStarted/Completed` can define model round boundaries.
- `ToolEventData::Completed` carries tool duration.
- `ToolEventData::{Queued, Waiting, Started, Progress, Streaming, Failed, Cancelled}` already gives tool lifecycle states.

### Existing token usage service

`TokenUsageService` already persists records with:

- model id
- session id
- turn id
- input tokens
- output tokens
- cached tokens
- total tokens
- subagent flag

It also provides summary aggregation by model and session.

### Existing UI surfaces

- Flow Chat already listens to token usage and context compression events.
- Context compression is already rendered as a tool-like card.
- `SessionFilesBadge`, `SessionFileModificationsBar`, and file operation tool cards already connect chat with file diffs.
- The Chat input footer already hosts compact session-level controls, including workspace/branch context and the usage action.

### Existing CLI surfaces

- CLI chat mode already recognizes slash commands.
- `/sessions` opens the session browser; `/resume`, `/continue`, and `/history` are aliases.
- `/status` shows current runtime facts and the latest primary-model request observed by the TUI.
- CLI session messages and tool cards already persist tool call count and tool duration.

## Original Gaps and Current Implementation Status

The subsections below preserve the original gap analysis so later reviews can
see why each work item existed. The current code review on 2026-05-11 checked
the plan against `origin/main..HEAD` and found P0/P1 implemented, with P2
hardening implemented except for real long-session smoke checks and items now
outside the closed scope. "Done" means code and automated coverage exist in
this branch; "Partial" means the foundation exists, but the remaining work
below still needs product or technical signoff before the item should be
considered complete.

| Area | Current status | Code evidence | Remaining work |
| --- | --- | --- | --- |
| Shared report service | Done | `src/crates/assembly/core/src/service/session_usage/{service.rs,types.rs,render.rs}` and `SessionAPI.getSessionUsageReport` | Keep the API contract stable while adding future report fields. |
| Durable local report message | Done | `DialogTurnKind::LocalCommand`, `localCommandKind: 'usage_report'`, `modelVisible: false` | Keep usage report snapshots model-invisible through future history, export, and transcript changes. |
| CLI `/usage` coverage | Done for interactive CLI | CLI `usage_*` coverage and the shared renderer | Top-level `openbitfun usage --session` is outside the closed product scope. |
| Model timing | Mostly done | Optional event and persisted fields for duration, provider/model identity, first chunk, visible output, stream duration, attempts, failure category, and token details | Throughput/TPS and provider-latency claims are outside the closed product scope. |
| Tool phase timing/classification | Mostly done | Optional terminal tool duration fields and `session_usage::classifier` coverage | Scheduler, budget, and backoff facts still depend on owning modules emitting typed facts. |
| File correlation and diff links | Mostly done | Snapshot summaries, `UsageFileRow.operationIds`, representative model/tool/error anchors, `SessionUsagePanel` diff actions, file-row turn jumps, tool-input-only file-row tool anchors, and panel-local long-session row caps | Exact per-call deep anchors for every aggregate row are outside the closed product scope. |
| Token reporting boundary | Done | Token-focused locale guard coverage and DTO fields limited to runtime/session facts | Keep `/usage` centered on current-session observability. |
| i18n and theme | Mostly done | Flow Chat locale alignment coverage, semantic style guard coverage, quick-action localization coverage, detail-panel tab keyboard semantics, and manual preview checks across Light, Slate, Dark, Midnight, Ink Charm, Ink Night, Cyber, and Tokyo Night | Final real-App long-session smoke and keyboard/focus pass are still needed before final UX signoff. |
| Scope and workspace identity | Done for current session | Request carries workspace path/remote identity and DTO exposes `UsageWorkspace` | Hidden subagent and visible side-session aggregation are outside the closed product scope. |
| Redaction/export policy | Mostly done | Bounded labels, privacy flags, workspace-relative display, copied metadata, and copy/export path redaction preference | Broader export formats stay outside the closed product scope. |

### 1. Shared session usage report service

Missing:

- A single API that returns a `SessionUsageReport` for CLI, Desktop, and later server use.
- A shared formatter that can produce Markdown and terminal text from the same structured data.

Required change:

- Use the existing platform-agnostic session usage owners to aggregate persisted session turns, runtime events or runtime journal records, token usage records, and snapshot/file stats.
- Keep product logic platform-agnostic. Desktop and CLI should call the same report service through adapters.

### 2. Durable local report message

Missing:

- A session item kind for local command output that is visible to the user but not injected into future model context.

Required change:

- Add a non-model-visible `LocalCommand` or `UsageReport` dialog turn/item kind.
- The Markdown report should be persisted and exportable, but `DialogTurnKind::is_model_visible()` should keep it out of model input by default.

Risk if skipped:

- If `/usage` is stored as a normal assistant message, later model calls may ingest the report, increasing token usage and creating self-referential context noise.

### 3. CLI event coverage

Missing:

- CLI `AgentEvent` does not currently surface token usage, model round timing, or context compression as first-class events.
- CLI `/status` reports the latest observed request rather than cumulative session usage; `/history`
  is an alias for the session browser and is not a usage-report entrypoint.

Required change:

- Extend CLI adapter events or let `/usage` query the shared report service after the fact.
- Add `/usage` to CLI command handling and `/help`.
- Prefer querying the report service for final numbers over maintaining a separate CLI-only counter.

### 4. Model timing and throughput

Missing:

- Model round start/completion events do not currently expose duration or model id in a way that is enough for reliable throughput metrics.
- `first_chunk_ms`, `first_visible_output_ms`, `send_to_stream_ms`, and `stream_processing_ms` exist in runtime logs/objects, but they are not stable persisted report fields.

Required change:

- Add structured model timing to report data, either through `ModelRoundCompleted` fields or a new runtime span/journal.
- Capture model id per round, request attempt count, first token latency, stream duration, output tokens, and failure category.

### 5. Tool timing breakdown

Missing:

- Tool completion has total duration, but queue wait, preflight, confirmation wait, and execution time are currently logged rather than emitted as stable report fields.
- Failed and cancelled tool events do not consistently include duration.

Required change:

- Extend tool lifecycle report metadata or create `RuntimeSpan` records for tool phases.
- Include `duration_ms` on failed/cancelled tool terminal events when available.
- Classify tool categories: `git`, `terminal`, `file_write`, `file_read`, `skill`, `mcp`, `browser`, `context`, `review`, `other`.

### 6. Git command classification

Missing:

- Git now runs through ExecCommand; persisted legacy sessions may still contain dedicated Git or Bash calls.

Required change:

- Classify a terminal call as Git when the normalized command starts with `git` or PowerShell/cmd wrappers run `git`.
- Keep the original tool name and command for detail view, but aggregate under `Git` for report readability.

### 7. Skill and script attribution

Missing:

- Skills may appear as Skill tool calls, shell scripts, or prompt-loaded context.

Required change:

- Attribute explicit `Skill` tool invocations by skill command/name.
- Attribute shell-executed known skill scripts only when the tool metadata proves it, not by fuzzy command guessing.
- Treat passive skill-loading context as token/context overhead, not script execution time.

### 8. File change statistics by scope

Missing:

- File operation cards can already request operation summaries/diffs, but the usage report needs stable aggregate counts for operation, turn, session, and git scopes.

Required change:

- Reuse snapshot operation metadata for operation-scoped file stats.
- Add report fields for files changed, additions, deletions, and top changed files.
- Link report rows to existing operation/turn/session/git diff opening paths.

### 9. Token reporting boundary

Missing:

- TokenUsageService stores tokens, but not every provider reports the same token detail categories.
- Cache, reasoning, audio/image, local-model, and gateway-mediated token details may be unavailable or partial.

Required change:

- `/usage` reports token counts and token coverage only when the source data can support them.
- Keep unavailable token categories visible as partial coverage instead of showing misleading zeros.
- Keep token detail categories provider-agnostic in the DTO; provider-specific values can be optional structured fields, not prose.
- Do not let token reporting become a recommendation, quota, or policy surface.

### 10. Internationalization and theme integration

Missing:

- Report strings, metric labels, table headers, compact chip labels, empty/error states, and tooltip text need locale coverage.
- Theme variables must be used for charts, status chips, badges, and report tables.

Required change:

- Use locale keys in `src/web-ui/src/locales/*/flow-chat.json` or a new localized report namespace.
- Render Desktop reports from structured data through the frontend i18n layer, not from hard-coded backend prose.
- CLI can start with English if the CLI has no locale pipeline, but the report DTO should not make localization impossible later.
- Use `@openbitfun/ui` and semantic theme tokens for colors; do not hard-code status colors except through semantic variables.

### 11. Report scope and workspace identity

Missing:

- The current draft mostly keys reports by `sessionId`, but persisted session ids are only meaningful within a workspace/runtime identity.
- The closed product reports only the active chat session. Hidden subagent sessions, visible `/btw` side sessions, and Deep Review child sessions are not silently aggregated.
- Remote sessions need `remote_connection_id` / `remote_ssh_host` context, and snapshot data may be unavailable for remote workspaces.

Required change:

- Every report request and API adapter should include the same workspace identity fields used by session persistence: workspace path plus remote identity when present.
- Default scope is "current user-visible session".
- Hidden subagent usage and visible side sessions such as `/btw` should not be silently folded into the parent report.
- Add coverage keys such as `workspace_identity`, `subagent_scope`, and `remote_snapshot_stats`.

### 12. Time accounting and overlapping spans

Missing:

- The report examples show percentages, but they do not define the denominator.
- Parent and child work can overlap: subagents, tool queues, retries, streaming, and UI waits can make summed resource time exceed wall time.
- P0 turn durations and tool durations can overlap, so "active runtime" can only be a lower-bound or approximate metric until spans are complete.

Required change:

- Define `wallMs` as session elapsed time from first reportable turn start to report generation or session end.
- Define `activeMs` as the union of known active spans when spans exist. In P0, label it approximate and derive it from available turn durations.
- Percentages should use `activeMs` as the denominator and should not double count overlapping child spans.
- If the UI later wants "resource time" that sums parallel work, expose it as a separate field such as `resourceMs`, not as a percentage of wall time.

### 13. Active-session and repeated-report behavior

Missing:

- The draft does not say what happens if the user runs `/usage` while a turn is streaming or tools are executing.
- It does not define whether repeated `/usage` commands update the previous report or append new reports.

Required change:

- P0 may restrict durable Desktop insertion to idle sessions if the current state machine cannot safely insert local output during an active turn.
- If `/usage` is allowed during active work, it must be a point-in-time snapshot with `generatedAt`, `inProgress=true`, and coverage notes for open spans. It must not mutate the active model round or queued user input.
- Repeated `/usage` should append a new report in P0. Updating an earlier report is a separate UX decision because it changes transcript durability and export semantics.

### 14. Cached token and provider token-detail propagation

Missing:

- `TokenUsageService` stores `cached_tokens`, but current `TokenUsageUpdated` events do not expose cached token counts and the subscriber records cached tokens as `0`.
- Providers can expose different token detail categories: cache read/write, reasoning, audio/image tokens, ephemeral cache tiers, or local-model estimates.

Required change:

- Do not render "Cached" as an authoritative P0 metric unless the source actually records it.
- Add coverage metadata for `cached_tokens` and `token_detail_breakdown`.
- Later span/event enrichment should carry provider token details as structured optional fields, not as provider-specific prose.

### 15. Privacy, redaction, and durable export policy

Missing:

- The report is durable and exportable, so command labels, file paths, error examples, model ids, remote host names, and operation links can become part of long-lived session history.
- Detailed tool params and tool results may contain secrets, prompts, file contents, command output, or private paths.

Required change:

- Report DTOs must not include raw prompts, full command output, tool params, tool results, file contents, environment variables, or secret-bearing payloads.
- Tool and error examples should use sanitized labels with bounded length and explicit redaction.
- File paths should follow the same visibility policy as existing transcript and diff surfaces. Prefer workspace-relative paths where possible; keep absolute or remote paths only behind existing detail views.
- Export behavior should include local reports by default because they are user-visible, but the report must be safe enough to export under the same rules as chat history.

### 16. Report versioning and migration

Missing:

- A local report item becomes persisted session history. Future schema changes need a migration path.
- Generated Markdown can become stale when the underlying session receives more turns after the report was inserted.

Required change:

- Add `schemaVersion`, `reportId`, `generatedAt`, and optionally `generatedFromAppVersion` to structured report metadata.
- Treat persisted Markdown as a historical snapshot, not a live view. Regeneration should create a new report unless a later UX explicitly supports updating.
- Old local report items should deserialize as generic user-visible, model-invisible local output even if the usage-specific subtype is retired.

## Proposed Data Shape

The report service should return structured data first. Text rendering is a view concern.

This is the design target, not a promise that every optional field is implemented. The current implementation intentionally omits per-model speed/latency fields such as `firstTokenMsP50`, `outputTokensPerSecond`, and `effectiveTokensPerSecond` until runtime spans can link those values reliably.

```ts
type SessionUsageReport = {
  schemaVersion: number;
  reportId: string;
  sessionId: string;
  generatedAt: number;
  generatedFromAppVersion?: string;
  workspace: {
    workspacePath?: string;
    remoteConnectionId?: string;
    remoteSshHost?: string;
    workspaceKind?: 'local' | 'remote' | 'unknown';
  };
  scope: {
    kind: 'current_session' | 'parent_with_hidden_subagents' | 'custom';
    includesHiddenSubagents: boolean;
    includesVisibleSideSessions: boolean;
    includedSessionIds: string[];
    inProgress: boolean;
    generatedDuringActiveTurn: boolean;
  };
  coverage: {
    level: 'partial' | 'complete';
    missing: Array<
      | 'model_round_timing'
      | 'tool_phase_timing'
      | 'cached_tokens'
      | 'token_detail_breakdown'
      | 'subagent_scope'
      | 'remote_snapshot_stats'
      | 'file_line_stats'
      | string
    >;
  };
  time: {
    wallMs: number;
    activeMs: number;
    activeMsIsApproximate: boolean;
    accounting: {
      denominator: 'active_union_ms' | 'turn_duration_estimate';
      overlappingChildSpansCountedOnce: boolean;
    };
    userIdleMs?: number;
    modelMs: number;
    toolMs: number;
    compressionMs: number;
    queueMs?: number;
    retryBackoffMs?: number;
    resourceMs?: number;
  };
  tokens: {
    source: 'provider_reported' | 'estimated' | 'mixed' | 'unavailable';
    cacheCoverage: 'available' | 'unavailable' | 'partial';
    input: number;
    output: number;
    cached?: number;
    total: number;
    maxContextTokens?: number;
    inputDetails?: Record<string, number>;
    outputDetails?: Record<string, number>;
  };
  models: Array<{
    providerId?: string;
    modelId: string;
    modelAlias?: string;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    totalTokens: number;
    firstTokenMsP50?: number;
    outputTokensPerSecond?: number;
    effectiveTokensPerSecond?: number;
    errorCount: number;
  }>;
  tools: Array<{
    category: string;
    name: string;
    displayLabel: string;
    callCount: number;
    successCount: number;
    errorCount: number;
    totalDurationMs: number;
    p95DurationMs?: number;
    queueWaitMs?: number;
    redacted: boolean;
  }>;
  files: {
    changedFiles: number;
    additions?: number;
    deletions?: number;
    topFiles: Array<{
      path: string;
      additions?: number;
      deletions?: number;
      operationIds?: string[];
      turnIds?: string[];
      scope?: 'operation' | 'turn' | 'session' | 'git';
      redacted?: boolean;
    }>;
  };
  compression: {
    count: number;
    failedCount: number;
    tokensBefore: number;
    tokensAfter: number;
    totalDurationMs: number;
  };
  errors: Array<{
    category: string;
    count: number;
    examples: Array<{ turnId?: string; toolCallId?: string; message: string }>;
  }>;
  slowest: Array<{
    kind: 'model' | 'tool' | 'compression' | 'subagent';
    label: string;
    durationMs: number;
    turnId?: string;
    toolCallId?: string;
    coverage?: 'complete' | 'partial';
  }>;
  privacy: {
    redactionApplied: boolean;
    omittedDetailKinds: string[];
  };
};
```

Exact field names can change during implementation. The important boundary is that the report is structured and renderers are surface-specific.

## Interaction Requirements

### `/usage` command

- CLI: `/usage` renders the terminal report.
- Desktop: `/usage` inserts a Markdown usage report into Flow Chat.
- The command should be local-only and should not call the model.
- The report should clearly indicate when data is partial because older sessions lack runtime spans.
- The report should offer a clear action to open the detailed report panel when Desktop supports it.
- The report is a point-in-time snapshot. It is not expected to update after more turns run.
- Running `/usage` multiple times should append multiple reports in P0.
- If `/usage` is invoked during an active turn, the implementation must either reject it with a friendly local-only message or insert a clearly marked in-progress snapshot without touching the active model/tool state.
- A standard session report should not silently include visible side sessions or hidden subagents.

### Chat-bottom usage entry

- The Chat-bottom usage entry is a convenience, not the source of truth.
- It should remain action-only at constrained widths; live metrics are outside the closed product scope.
- It must not introduce horizontal overflow.
- It must support keyboard focus, screen-reader labels, and tooltip summaries.
- It should hide itself automatically when no active session or no reportable data exists.

### Detailed report panel

The panel is not required for the first `/usage` milestone, but the data shape should support it.

Recommended tabs:

- Overview
- Models
- Tools
- Files
- Errors
- Slowest

Timeline is outside the closed product scope. Current P2 uses the Slowest tab
plus representative transcript links instead of a full trace timeline.

## Milestone Execution Plan

Implementation should be delivered through at most three mergeable milestones. Each milestone must leave CLI, Desktop, and existing session replay behavior usable, even if later metrics are still partial. The detailed tasks below remain the task inventory; this section defines the delivery order, release gates, and rollback boundaries.

Current milestone progress, verified against the current branch on 2026-05-11:

| Milestone | Status | Current evidence | Remaining work |
| --- | --- | --- | --- |
| P0: Safe `/usage` foundation | Complete | Shared report service/renderers, model-invisible local report items, CLI interactive `/usage`, Desktop report cards, repeated-report exclusion, and old-session/cache-unavailable fixtures are covered by Rust and Web UI tests. | Keep future changes within the same local-only and model-invisible contract. |
| P1: Runtime spans and file correlation | Complete for the approved P1 scope | Optional model/tool runtime facts persist and aggregate; local usage reports are excluded from the next report span; snapshot-backed and recognized tool-input file rows are surfaced; missing model identity uses legacy-session copy instead of implementation labels. | Scheduler/budget/context/artifact facts remain projections only when their owning modules emit typed facts. Hidden subagents remain excluded by default. |
| P2: Desktop analysis surface | Almost complete | Chat-bottom entry, detail panel tabs, accessible tab keyboard semantics, copyable metadata, file diff actions, slow-span turn jumps, representative model/tool/error anchors, file-row turn/tool-input anchors, panel-local long-list caps, user-confirmed Markdown copy path redaction, i18n coverage, semantic style tests, duplicate-localized-header guard, and manual preview checks across all built-in themes are present. | Real-App long-session smoke remains before final UX signoff. |

### Milestone P0: Safe `/usage` Foundation

Goal: ship a Claude-like `/usage` command that is useful with existing data only and cannot affect model execution.

Included task groups:

| Order | Work item | Detailed tasks | Output |
| --- | --- | --- | --- |
| P0.0 | Baseline and scope lock | Task 0 | Clean branch proof and narrow change set |
| P0.1 | Shared contract and boundaries | Task 1 | Provider-agnostic `SessionUsageReport` DTO with scope, workspace identity, accounting, redaction, and coverage metadata |
| P0.2 | Durable local report item | Task 2 | User-visible, model-invisible local command/report item |
| P0.3 | Read-only aggregation | Task 3 | Report service using token, turn, tool, compression, and cached snapshot summaries |
| P0.4 | Text renderers | Task 4 | Deterministic terminal and Markdown renderers |
| P0.5 | CLI command | Task 5 | Interactive CLI `/usage` output |
| P0.6 | Desktop command | Task 6 | Desktop `/usage` local Markdown report insertion |
| P0.7 | Presentation baseline | Task 7 subset | Locale keys and theme-safe empty/error/partial states for Desktop report text |
| P0.8 | Contract fixtures | Tasks 1, 3, 4, 6 | Fixtures for old sessions, missing cache data, remote workspace without snapshot stats, repeated reports, and active-session rejection/snapshot behavior |

Functional guardrails:

- `/usage` must never call the model, enqueue an agent turn, mutate runtime scheduling, or trigger context compression.
- The Desktop report must be stored as a local command/report item that is visible to the user but excluded from model-visible history.
- P0 must not introduce live header UI, charts, cross-session summaries, or new runtime span persistence.
- Missing data must be represented by coverage metadata and partial-data copy, not by misleading zero values.
- Old sessions must still deserialize and replay; sessions without token/snapshot data should still produce a partial report instead of failing.
- P0 must not show cached-token counts as real if current events only record them as `0`.
- P0 report requests must be scoped by workspace identity as well as session id.
- P0 percentages must state whether they use approximate turn-duration accounting or complete span-union accounting.
- P0 output must use sanitized labels and bounded examples; no raw prompts, tool params, tool results, command output, file contents, or environment values.

Risk and drift controls:

| Risk or drift | Mitigation | Stop condition |
| --- | --- | --- |
| Report enters future model context | Add regression tests around model-visible history assembly before wiring CLI/Desktop commands | Any test shows report Markdown in model input |
| `ChatInput.tsx` becomes a feature dump | Keep command parsing behind a small command helper or service boundary when adding `/usage` | More than one local-command branch is added directly to the component |
| Aggregation scans become slow on long sessions | Use persisted records and cached snapshot summaries only; do not compute full diffs during `/usage` | Report generation needs workspace-wide or full-diff reads |
| P0 appears more accurate than it is | Render partial coverage notes next to affected sections | A metric cannot explain whether it is complete or approximate |
| CLI and Desktop diverge | Both call the same report service and only differ at renderer/adaptor boundaries | Same fixture produces different counts |
| Workspace/session id ambiguity | Require workspace identity in report API requests and service lookup | Same session id can read data from another workspace |
| Cached token metric is fake | Add `cached_tokens` coverage and hide/unavailable-state when only zero-filled records exist | Report labels cached tokens as known while source cannot measure them |
| Running `/usage` disturbs active turn | Reject during active turn or insert only a local point-in-time item outside the active model round; exclude local usage-report turns from aggregation and session activity ordering | `/usage` changes queued input, model state, active turn persistence, report scope, or session recency |

Required verification before merging P0:

- `cargo check -p openbitfun-core --no-default-features --features agent-runtime`
- `cargo test -p openbitfun-core --no-default-features --features agent-runtime --lib session_usage -- --nocapture`
- Focused CLI command tests or manual CLI smoke if no existing helper test harness exists.
- `pnpm run lint:web`
- `pnpm run type-check:web`
- `pnpm --dir src/web-ui run test:run`
- Manual or automated proof that Desktop `/usage` does not call the model send path.
- Fixture proof that cache-unavailable, remote-snapshot-unavailable, and old-session reports render as partial rather than zero/empty success.
- Regression proof that repeated `/usage` creates separate historical snapshots while the previous report is excluded from the next report's scope and timing.

Rollback boundary:

- P0 can be disabled by hiding `/usage` command registration in CLI/Desktop while leaving DTO and read-only service code in place.
- The local report item type must remain backward-compatible once persisted; if it needs removal, migrate it as a generic local system/report item instead of deleting session records.

P0 implementation status (2026-05-11): complete. The current branch has the
shared DTO/service/renderer path, interactive CLI `/usage`, Desktop local
report card insertion, and regression coverage for old sessions, unavailable
cache fields, repeated usage reports, workspace identity, and model-invisible
local report turns. The original rollback boundary still applies: disable the
command entry points first if product rollback is needed, and keep persisted
local command records backward-compatible.

### Milestone P1: Accurate Runtime Spans and File Correlation

Goal: make P0 reports more accurate by enriching runtime span data and linking file-change summaries without changing tool/model behavior.

Included task groups:

| Order | Work item | Detailed tasks | Output |
| --- | --- | --- | --- |
| P1.0 | Model span enrichment | Task 8 | Optional model timing fields for first chunk, first visible output, stream duration, attempts, and failure category |
| P1.1 | Tool phase spans | Task 9 | Queue, preflight, confirmation, execution, total, failed, and cancelled timing summaries |
| P1.2 | Conservative classification | Task 9 | Report-only tool categories, including Git classification with false-positive tests |
| P1.3 | File-change correlation | Task 10 | Changed file counts, additions/deletions when cached, and metadata links to existing diff scopes |
| P1.4 | Coverage upgrade | Tasks 3, 8, 9, 10 | Aggregator prefers precise spans and falls back to P0 data for old sessions |
| P1.5 | Runtime-fact consumption | Tasks 8, 9, 10 | Consume scheduler, budget, context mutation, and artifact facts when their owning modules emit them; do not reimplement those owners |

Functional guardrails:

- Span fields must be optional or additive so existing Desktop, server, websocket, and CLI consumers continue to work.
- Instrumentation must not add sleeps, awaits, locks, retries, or scheduling changes to model streaming or tool execution paths.
- No per-token persistence is allowed; store terminal summaries or bounded span records only.
- File correlation must reuse existing snapshot summaries and diff open paths. It must not change operation, turn, session, or git diff semantics.
- Command classification must be conservative. A terminal command is `git` only when the normalized executable is clearly Git.
- Scheduler, budget, retry, context mutation, and artifact fields must be projections from their owning runtime modules. The usage report must not create a parallel state machine.
- Parallel child spans should be parented or linked so the report can show both user-perceived elapsed time and optional resource time without double-counting percentages.

Risk and drift controls:

| Risk or drift | Mitigation | Stop condition |
| --- | --- | --- |
| Event schema breaks old clients | Add optional fields or new event variants with adapter compatibility tests | Existing event consumers require code changes unrelated to reporting |
| Timing instrumentation affects runtime | Capture already measured timestamps at terminal state transitions | Any measurable behavior change in model/tool lifecycle tests |
| File links open the wrong diff scope | Store explicit scope metadata and route through existing snapshot APIs | Operation-scoped links resolve to cumulative session diff |
| Tool category becomes policy logic | Keep classifiers inside report service or report-only module | Classification affects permissions, scheduling, or confirmation |
| Old sessions lose report usefulness | Preserve P0 fallback path and mark coverage partial | Old-session fixtures fail report generation |
| Subagent or retry time is double-counted | Store parent/child span relationships and compute percentages from span union | Parent active time plus child active time exceeds denominator in percentage sections |
| Usage reporting duplicates budget/scheduler facts | Consume typed events from owning modules only | New `/usage` code owns retry, queue, budget, or context mutation decisions |

Required verification before merging P1:

- `cargo check --workspace`
- `cargo test --workspace`
- Event adapter serialization tests for optional model/tool timing fields.
- Report aggregation tests covering complete spans, partial spans, old sessions, and file summaries.
- Regression tests for Git command classification false positives.

Rollback boundary:

- P1 can be rolled back by ignoring new span fields in aggregation while leaving additive event fields in place.
- If an event field proves risky, keep the DTO coverage key and revert only the producer path, so `/usage` continues to work with P0 data.

Executable implementation plan:

P1 must move `/usage` from P0 approximation toward factual runtime accounting without changing the report command contract. The implementation order below is test-first and split by ownership boundary so each step can be reviewed independently.

1. Persist runtime facts already owned by the runtime.
   - Files: `src/crates/assembly/core/src/service/session/types.rs`, `src/crates/assembly/core/src/agentic/session/session_manager.rs`, `src/crates/assembly/core/src/agentic/coordination/coordinator.rs`, and the tool/model execution call sites that construct persisted session items.
   - Add optional fields to persisted model rounds for provider/model identity, first chunk latency, first visible output latency, stream duration, attempt count, failure category, token details, and total duration.
   - Add optional tool phase durations to persisted tool items: queue wait, preflight, confirmation wait, and execution.
   - Acceptance: old session JSON still deserializes, new session JSON round-trips with these fields, and missing fields never fail report generation.

2. Consume persisted facts in the usage service.
   - File: `src/crates/assembly/core/src/service/session_usage/service.rs`.
   - Prefer persisted model/tool duration fields when present; fall back to existing start/end or result durations only when facts are missing.
   - Compute active time as a union of known active intervals so overlapping spans do not double-count the denominator.
   - Exclude `local_command` usage-report turns from scope, wall/active time, model/tool/file/error rows, and slowest spans so generating a report cannot affect the next report.
   - Use a localized "model not recorded" label for persisted model spans that have timing but no model identity, instead of exposing implementation terms such as `model round 0`.
   - Mark `ModelRoundTiming` and `ToolPhaseTiming` coverage available only from actual recorded facts, not from guessed fallback data.
   - Acceptance: model rows can exist from runtime span facts even when token records are absent, tool rows expose phase subtotals, slowest spans include model rounds and tools, and the coverage panel explains missing facts conservatively.

3. Keep file-change correlation conservative.
   - File: `src/crates/assembly/core/src/service/session_usage/service.rs`.
   - Keep snapshot operations as the highest-trust source for file rows, including remote sessions when cached snapshot summaries are present, then use tool-call metadata as a fallback only for recognized edit/write/delete operations.
   - Preserve operation ids and turn indexes for later UI navigation, but do not invent line counts when no snapshot or diff fact exists.
   - Acceptance: remote sessions with cached snapshot summaries show file/line rows; remote sessions that only have tool metadata show edited files with unknown line counts instead of "unavailable"; files without trustworthy evidence remain omitted.

4. Surface the new facts without adding noise.
   - Files: `src/web-ui/src/flow_chat/components/usage/*`, `src/web-ui/src/flow_chat/store/FlowChatStore.ts`, `src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts`, and `src/web-ui/src/locales/*/flow-chat.json`.
   - Show model duration only when at least one model duration is recorded.
   - Keep error and coverage explanations visible through concise hover text plus detail-page descriptions.
   - Avoid new claims such as exact throughput or file-line changes unless the backend has the underlying fact.

5. Verify and review consistency.
   - Required checks: `pnpm run lint:web`, `pnpm run type-check:web`, `pnpm --dir src/web-ui run test:run`, `cargo check --workspace`, and `cargo test --workspace`.
   - Review pass: compare backend DTOs, TypeScript types, visible copy, and coverage explanations for the same semantics; list any remaining approximate or inferred fields explicitly.

P1 red/green test plan:

- Rust service tests:
  - model span facts create model rows and slow-span rows without token records;
  - local usage-report turns are excluded from report scope, timing, model/tool/file/error rows, and slowest spans;
  - missing model identity renders as localized "model not recorded" copy rather than `model round N`;
  - active time uses interval union instead of summing overlapping turns;
  - tool phase timings are summed by tool and enable `ToolPhaseTiming` coverage;
  - file rows prefer snapshot operations for local and remote sessions, and use tool-call metadata only as fallback.
- Rust persistence tests:
  - legacy persisted model/tool JSON without new fields still deserializes;
  - persisted model/tool JSON with P1 fields round-trips.
- Web UI tests:
  - model duration column appears only when duration facts exist;
  - missing timing facts still use coverage/error explanations instead of absolute claims.

P1 residual-risk checklist:

- Hallucination risk: any field derived from a fallback must be labeled approximate or unavailable, never exact.
- Drift risk: frontend labels must match backend `accounting`, `denominator`, and coverage states.
- Privacy risk: file paths must continue to use existing redaction/path-label behavior.
- Compatibility risk: optional fields must not invalidate old persisted sessions or remote-session reports.
- Rollback risk: ignoring new optional fields must leave the P0 report usable.

P1 implementation review note (2026-05-11):

- Third-party review result: the P1 data contract is additive and optional; old persisted turns, model rounds, and tool items still deserialize, while new facts round-trip through Rust and Web UI session persistence.
- Product-risk review result: visible copy now distinguishes recorded runtime from provider latency, model duration columns stay hidden until at least one model row has timing, and unavailable file/error facts have short hover text plus detail-panel explanations.
- Configuration-side review result: built-in Commit/Create PR quick actions display localized defaults, but unchanged localized defaults are normalized back to canonical storage values when saved so language switching is not pinned to one locale.
- Known boundary: hidden subagent totals remain excluded from the standard report until parent linkage and scheduler/event aggregation are reliable enough for default inclusion.
- Known boundary: legacy start/end timing can make the report useful but still approximate; `accounting` and help text must remain the source of truth for precision.
- Known boundary: remote-session file rows use snapshot summaries when available and recognized file-edit tool inputs otherwise; line counts are still unavailable without snapshot facts.
- Current consistency update: Chat-bottom usage is the only Desktop entry point; report generation appends a local visible report card but that local command is excluded from future usage aggregation and does not update session activity ordering.
- Verification evidence for this review: `pnpm run lint:web`, `pnpm run type-check:web`, `pnpm --dir src/web-ui run test:run`, `cargo check --workspace`, and `cargo test --workspace`.

### Milestone P2: Responsive Desktop Analysis Surface

Goal: add the interactive Desktop analysis panel and keep a compact Chat-bottom entry point after the report contract is stable. The implemented entry is a lightweight `/usage` trigger in the Chat input footer; title/header placement and live timing values are outside the closed product scope.

Included task groups:

| Order | Work item | Detailed tasks | Output |
| --- | --- | --- | --- |
| P2.0 | Chat-bottom action contract | Task 11 | Entry point that can generate the current session report |
| P2.1 | Responsive Chat-bottom entry | Task 11 | `ChatInputWorkspaceStrip` usage action as a stable icon/text trigger |
| P2.2 | Detailed report panel | Task 12 | Overview, Models, Tools, Files, Errors, and Slowest tabs using the shared DTO |
| P2.3 | Diff and transcript links | Tasks 10, 12 | Snapshot-backed file rows open existing diff viewers; slow-span rows can jump to known turns; model/tool/error aggregate rows expose representative anchors; file rows can jump to transcript turns; tool-input-only file rows can request tool-card focus when a single stable tool item id exists |
| P2.4 | i18n, theme, accessibility hardening | Tasks 7, 11, 12 | Locale-safe labels, semantic colors, keyboard access, tooltips, and screen-reader labels |

Functional guardrails:

- The Chat-bottom entry is an optional entry point, not the only way to access `/usage`.
- The implemented Chat-bottom entry does not show live metrics or model/tool percentages.
- The title/header must stay free of usage controls in the current implementation.
- The Chat input footer must preserve existing workspace, branch, model, attachment, and send controls at small widths.
- Entry rendering must use priority collapse instead of viewport-scaled fonts or clipped text.
- The panel must not render raw prompts, full command output, file contents, or secret-bearing tool payloads.
- P2 must not add large charting libraries; use existing components, simple bars, tables, or capped lists.

Risk and drift controls:

| Risk or drift | Mitigation | Stop condition |
| --- | --- | --- |
| Small windows become cluttered | Use container-aware priority collapse and icon-only fallback | Chat footer controls overlap or disappear in narrow desktop widths |
| Live summary creeps back into the footer | Keep the entry action-only | Streaming causes visible layout jitter |
| Panel becomes a debugger replacement | Keep default view summary-first and deep links back to existing transcript/diff surfaces | Panel starts duplicating raw tool output or full diffs |
| i18n text overflows | Test `en-US`, `zh-CN`, and `zh-TW`; prefer card/list fallback over wide tables | Any required label clips in supported locales |
| Theme contrast regresses | Use semantic tokens and light/dark checks | New colors bypass theme tokens |

Required verification before merging P2:

- `pnpm run lint:web`
- `pnpm run type-check:web`
- `pnpm --dir src/web-ui run test:run`
- Component/layout tests for the usage trigger in wide and narrow Chat footer states.
- Locale smoke checks for `en-US`, `zh-CN`, and `zh-TW`.
- Manual preview checks across all built-in themes: Light, Slate, Dark, Midnight, Ink Charm, Ink Night, Cyber, and Tokyo Night.
- Manual proof that existing file diff buttons and report-linked diff buttons open the same scopes.

Rollback boundary:

- P2 can be disabled by hiding the Chat-bottom entry and panel route/action while keeping `/usage` Markdown reports available.
- If the panel has performance issues on long sessions, keep P2.0/P2.1 and disable only the detailed tab content behind a feature flag or capability switch.

P2 implementation progress note (2026-05-11):

- P2.0/P2.1 entry placement matches current code: the usage action lives in `ChatInputWorkspaceStrip` at the Chat bottom, not in `FlowChatHeader` or the window title/header area.
- P2.2 is implemented as a single detail-panel module today: `SessionUsagePanel.tsx`, `SessionUsagePanel.scss`, `sessionUsagePanelTypes.ts`, and `openSessionUsageReport.ts`. The panel includes Overview, Models, Tools, Files, Errors, and Slowest tabs. Splitting tab bodies into separate files is a maintenance choice, not product scope.
- P2.3 is partially implemented. File rows open the existing snapshot diff viewer through `snapshotAPI.getOperationDiff` and `createDiffEditorTab`; no new diff renderer or mutation path is introduced. Slowest rows can jump to known turns through the existing Flow Chat pin-to-top event. Model, tool, and error aggregate rows now carry optional representative anchors from core and route through the existing Flow Chat focus event. File-row turn indexes also use the focus event for transcript jumps, and tool-input-only file rows request tool-card focus only when a single stable tool item id is available.
- The file diff action is intentionally enabled only for trustworthy snapshot-backed rows with a visible path and session id. Redacted rows, tool-input-only rows, and unavailable rows show a disabled placeholder with an explanation instead of attempting a best-effort open.
- Exact per-call deep anchors are outside the closed product scope; aggregate rows link to representative sources instead of becoming a full occurrence explorer.
- Remaining P2 hardening: complete real-App long-session smoke for scroll/jump feel. Panel-local long-session row caps, Markdown copy/export path redaction, detail-panel tab keyboard semantics, representative aggregate anchors, file-row turn/tool-input anchors, duplicate-localized-table-header guards, and built-in-theme preview checks are implemented in this branch. Do not touch Flow Chat's global virtual list or scroll layout for this work unless a separate navigation design is approved.
- Verification evidence for current P2 slices: `SessionUsageComponents` covers detail tabs, file diff action, slowest turn jumps, copyable metadata, unavailable help, token-only copy, i18n behavior, duplicate localized table headers, and semantic color usage; manual preview checks covered Light, Slate, Dark, Midnight, Ink Charm, Ink Night, Cyber, and Tokyo Night. Broader web/Rust verification is tracked in the P1 review note above.

### Final Merge-Ready Execution Plan

This plan was re-reviewed on 2026-05-11 after refreshing `origin/main`. The
current branch is based on latest `origin/main`, and main has recent Flow Chat
scroll-position, follow-output jitter, settings/usage, and theme work. The
remaining usage-report work must therefore stay local to the usage-report
surface.

Compatibility guardrails for the final hardening batch:

- Run `git fetch origin main:refs/remotes/origin/main` before starting.
- Run `git merge-base --is-ancestor origin/main HEAD`; stop and rebase if it fails.
- Run `git diff --name-only origin/main..HEAD` and confirm the batch does not touch unrelated mainline areas.
- Do not modify `src/web-ui/src/flow_chat/components/modern/VirtualMessageList.tsx`, `src/web-ui/src/flow_chat/utils/flowChatScrollLayout.ts`, theme preset files, tray files, installer files, or settings basics files for P2 hardening unless a separate design review approves that scope.
- Keep every final P2 change reversible by hiding the usage detail action or disabling one panel tab while leaving `/usage` Markdown reports available.

Next executable stage:

| Stage | Recommendation | Files allowed by default | Verification | Stop condition |
| --- | --- | --- | --- | --- |
| Final smoke and merge readiness | Run real Desktop long-session smoke, fix only usage-local defects, then prepare commit/PR | Usage panel/card styles, usage component tests, locale files, and this document | `pnpm run lint:web`, `pnpm run type-check:web`, `pnpm --dir src/web-ui run test:run`, `cargo check --workspace`, `cargo test --workspace`, real-App long-session smoke | Any fix requires Flow Chat global scroll/session-switch changes or shared theme token changes. |

Detailed executable checklist:

1. Launch the real Desktop app from this branch.
2. Open or create a long session with enough model, tool, file, and error rows to exercise every detail tab.
3. Generate `/usage` from the Chat-bottom entry and from the slash command if available.
4. Check the report card, detail panel tabs, file table sticky action column, copy/export redaction toggle, representative transcript jumps, file diff actions, and keyboard focus order.
5. Confirm that report generation does not trigger a model request, does not appear in the next report span, and does not make session switching or follow-output feel slower.
6. Fix only usage-local issues found during the smoke pass.
7. Re-run the full frontend and Rust verification commands.
8. Rebase onto latest `origin/main`, split into a small commit set, and update the PR description around the closed product scope.

### Explicitly Out Of Closed Scope

The following work is intentionally not queued as follow-up for this usage-report product:

- Cross-session or project-level summaries.
- Export formats beyond existing conversation export behavior.
- Automated recommendations such as context optimization advice or retry-loop diagnosis.
- Live status metrics in the Chat footer or title/header.
- Exact per-call occurrence browsing for every aggregate row.

If any of these become important later, they should start from a new product question instead of being treated as incomplete work in this milestone.

## Fine-Grained Execution Breakdown

This section turns the milestone plan into implementation-sized tasks. Each task has an explicit blast radius, risk list, mitigation, and functional guardrails. Later detailed task plans can split these further, but implementation should preserve the P0 to P2 order unless a task is deliberately descoped.

### Global guardrails

- `/usage` must never trigger a model request.
- `/usage` output must not be included in future model context unless a user explicitly quotes or references it in a later prompt.
- P0 reports tokens and available timing only. P0 does not introduce charts, cross-session summaries, or live header UI.
- Runtime metrics collection must be append-only or summary-only; do not add per-token persistence.
- Shared report logic belongs in its current platform-agnostic Rust owner. Desktop, server, and CLI keep only their entry adapters.
- Desktop UI must use existing i18n, semantic theme tokens, and `@openbitfun/ui` primitives.
- Every report field that can be incomplete must carry coverage metadata instead of silently showing `0`.
- Existing file diff behavior must not change while adding report links.
- Report APIs must be scoped by workspace identity and remote identity, not only by session id.
- Reports must define their scope: current session, hidden subagents included/excluded, visible side sessions included/excluded, and whether the session was active when generated.
- Time percentages must state the denominator and must not double-count overlapping child spans.
- Durable report content must be redacted and bounded. Do not persist raw prompts, tool params, full tool output, file contents, secrets, or environment values in the report DTO or Markdown.
- Reporting must consume budget/scheduler/context/artifact facts from their owning modules rather than implementing another control plane.

### Task 0: Baseline and scope lock

Goal: start implementation from a known branch state and prevent unrelated files from entering the feature.

Files:

- Read: `session-runtime-usage-report-design.md`
- Read: `AGENTS.md`
- Read: `src/web-ui/AGENTS.md`
- Read: `src/crates/assembly/core/AGENTS.md`

Steps:

1. Confirm the branch is based on the latest remote main:
   - Run `git fetch --no-tags origin main`.
   - Run `git merge-base --is-ancestor origin/main HEAD`.
   - Run `git rev-list --left-right --count origin/main...HEAD`.
2. Confirm the intended working set:
   - Run `git status --short --branch`.
   - Keep unrelated untracked docs and scratch files unstaged unless the user explicitly asks otherwise.
3. Create a narrow branch or backup branch before code changes if the checkout is dirty.

Functional guardrails:

- Do not rebase, push, or force-push during implementation unless the user asks for that exact git operation.
- Do not stage root-level architecture docs unless the current task explicitly edits them.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Implementation starts from stale main | Require ancestry proof before code edits |
| Unrelated docs enter the PR | Use explicit path staging and `git diff -- <paths>` review |
| Old tracking branch shows ahead/behind after rebase | Treat tracking divergence as publish state only; do not "fix" it without a push request |

Verification:

- `git merge-base --is-ancestor origin/main HEAD` exits `0`.
- `git diff --check origin/main..HEAD` has no new whitespace issues from this feature.

### Task 1: Shared report DTO and coverage model

Goal: define the stable structured contract used by CLI, Desktop, and future server/API surfaces.

Files:

- Create: `src/crates/assembly/core/src/service/session_usage/types.rs`
- Create: `src/crates/assembly/core/src/service/session_usage/mod.rs`
- Modify: `src/crates/assembly/core/src/service/mod.rs`
- Test: `src/crates/assembly/core/src/service/session_usage/types.rs` or nearby module tests

Steps:

1. Add `SessionUsageReport`, `UsageCoverage`, `UsageTimeBreakdown`, `UsageTokenBreakdown`, `UsageModelBreakdown`, `UsageToolBreakdown`, `UsageFileBreakdown`, `UsageCompressionBreakdown`, `UsageErrorBreakdown`, and `UsageSlowSpan` structs.
2. Add `CoverageLevel::{Complete, Partial}` plus a stable list of missing-data keys such as `model_round_timing`, `tool_phase_timing`, and `file_line_stats`.
3. Use milliseconds and token counts in DTOs; keep formatting out of DTOs.
4. Make optional fields explicit for data that is not reliable in P0.
5. Add `schema_version`, `report_id`, `generated_at`, workspace identity, report scope, in-progress marker, and redaction metadata.
6. Define time accounting fields so renderers know whether percentages use span-union accounting or P0 turn-duration estimates.
7. Add token source and cache coverage fields so cached tokens are not shown as known when the event source cannot measure them.
8. Add serde round-trip tests with missing optional fields.

Functional guardrails:

- The DTO must be provider-agnostic.
- Do not include raw prompts, full command output, file contents, secrets, or tool result payloads.
- Do not encode localized prose in the DTO.
- Do not treat model aliases such as `fast` as the authoritative model id when a resolved provider/model id is available.
- Do not assume session ids are globally unique across local and remote workspaces.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| DTO becomes UI-specific | Use numeric fields and enum identifiers, not rendered text |
| DTO leaks sensitive transcript data | Store labels and identifiers only; detail links reuse existing transcript permissions |
| Future fields break older persisted reports | Prefer optional fields and serde defaults |
| Cache coverage looks complete when it is not | Make cache coverage explicit and assert unavailable cache does not render as measured `0` |
| Scope ambiguity hides or double-counts child work | Record report scope and included session ids |

Verification:

- `cargo test -p openbitfun-core --no-default-features --features agent-runtime --lib session_usage -- --nocapture` once tests exist.
- `cargo check -p openbitfun-core --no-default-features --features agent-runtime`.
- DTO tests for workspace identity, report scope, in-progress reports, cache-unavailable coverage, and redaction metadata.

### Task 2: Non-model-visible local report item

Goal: give Desktop `/usage` a durable chat representation without polluting future model context.

Files:

- Modify: `src/crates/assembly/core/src/service/session/types.rs`
- Modify: `src/crates/assembly/core/src/agentic/session/session_manager.rs`
- Modify: `src/web-ui/src/flow_chat/types/flow-chat.ts`
- Modify: `src/web-ui/src/flow_chat/store/FlowChatStore.ts`
- Test: session serialization/deserialization tests near existing session tests
- Test: web-ui Flow Chat store tests

Steps:

1. Add a local-only session item or dialog turn kind such as `DialogTurnKind::LocalCommand` with a report subtype such as `usage_report`.
2. Ensure `DialogTurnKind::is_model_visible()` returns `false` for local command/report turns.
3. Persist the report Markdown and structured report id/metadata in the session, including `generatedAt`, `schemaVersion`, report scope, and whether it was generated while the session was active.
4. Ensure older sessions deserialize with the existing default `UserDialog`.
5. Ensure export/search can include local reports, while model message assembly excludes them.
6. Treat each generated report as a historical snapshot. Do not mutate an older report in P0 when the user runs `/usage` again.

Functional guardrails:

- Do not store `/usage` as a normal assistant message.
- Do not change visibility semantics for existing user, assistant, tool, or compaction messages.
- Do not hide existing system/tool diagnostics from the user.
- Do not insert a local report into the currently streaming model round.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Report enters model context | Add a regression test that builds model-visible history after `/usage` and asserts the report is absent |
| Existing persisted sessions fail to load | Keep serde defaults and add old-shape fixture tests |
| Search/export unexpectedly omit the report | Treat local reports as user-visible but model-invisible |
| Re-running `/usage` rewrites history | Append a new report item in P0 and preserve previous report timestamps |

Verification:

- Rust session tests for `is_model_visible()`.
- Web UI store tests for insert, render, persist, reload, and exclude-from-model-context behavior.
- Tests for repeated local reports and active-turn insertion/rejection behavior.

### Task 3: P0 report aggregation from existing data

Goal: produce a useful `/usage` report without changing runtime event production.

Files:

- Create: `src/crates/assembly/core/src/service/session_usage/service.rs`
- Modify: `src/crates/assembly/core/src/service/session_usage/mod.rs`
- Modify: `src/crates/assembly/core/src/service/mod.rs`
- Read/reuse: `src/crates/assembly/core/src/service/token_usage/service.rs`
- Read/reuse: `src/crates/assembly/core/src/service/session/types.rs`
- Read/reuse: `src/crates/assembly/core/src/service/snapshot/service.rs`
- Test: `src/crates/assembly/core/src/service/session_usage/service.rs`

Steps:

1. Aggregate token records for the current session. Preserve subagent markers only as coverage metadata; do not silently fold hidden subagent usage into the default report.
2. Aggregate persisted dialog turn durations for wall and active lower-bound estimates.
3. Aggregate tool result `duration_ms` from persisted model round items.
4. Identify context compression items by existing `ContextCompression` tool records and compression event metadata when available.
5. Aggregate file stats from snapshot operation summaries where operation ids are present.
6. Resolve workspace identity before reading session, token, or snapshot data.
7. Mark cached tokens as unavailable when the source records only subscriber-filled zeroes.
8. Mark remote snapshot stats as unavailable when snapshot tracking is skipped for remote workspaces.
9. Mark missing coverage keys for model round timing, tool phase timing, cached token detail, subagent scope, and remote snapshot stats in P0.

Functional guardrails:

- P0 aggregation must be read-only.
- Absence of a data source must produce partial coverage, not a failed report.
- If a metric is unavailable, omit it or label it unavailable; do not substitute `0` unless the true value is known to be zero.
- Aggregation must not scan the workspace, compute large diffs, or read full file contents.
- Aggregation must not infer hidden subagent linkage from display names or fuzzy text matching.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Double-counting subagent tokens | Include `is_subagent` in model breakdown and document whether totals include subagents |
| Turn duration and tool duration overlap | Label active runtime as approximate until span data exists |
| Snapshot stats unavailable for old sessions | Mark `file_line_stats` missing and still report changed file count if available |
| Remote workspace snapshot data is absent by design | Mark `remote_snapshot_stats` missing and avoid file-line totals unless a remote-safe source exists |
| Cached tokens are silently zero-filled | Add a source capability check and render cache as unavailable |
| Scope is guessed from names | Use explicit parent/session linkage only; otherwise mark `subagent_scope` partial |

Verification:

- Unit tests with complete data.
- Unit tests with missing token records.
- Unit tests with missing snapshot stats.
- Unit tests proving not-reported metrics are partial, not zeroed.
- Unit tests for remote workspace coverage, cache-unavailable coverage, and scope/include-subagent behavior.

### Task 4: Shared text renderers

Goal: render the same report as CLI terminal text and Desktop Markdown without duplicating business logic.

Files:

- Create: `src/crates/assembly/core/src/service/session_usage/render.rs`
- Modify: `src/crates/assembly/core/src/service/session_usage/mod.rs`
- Test: renderer snapshot or exact-output tests in Rust

Steps:

1. Add `render_usage_report_terminal(report)` for CLI.
2. Add `render_usage_report_markdown(report)` for Desktop P0.
3. Keep rendering deterministic: stable sort models/tools by duration or token count, then by label.
4. Include a partial-data note when `coverage.level == Partial`.
5. Render token counts and token coverage only; omit unrelated account, plan, or quota language.
6. Render scope, generated time, and in-progress state in a compact way when they affect interpretation.
7. Render unavailable cached tokens as unavailable/partial, not as `0`, unless the source proves the true value is zero.
8. Bound and redact slowest-work labels, error examples, and path displays.

Functional guardrails:

- Renderers must not query storage or mutate sessions.
- Markdown should be plain Markdown with tables and short lists; no HTML or app-specific directives in P0.
- Terminal output must not rely on color for meaning.
- Renderers must not leak raw tool input/output fields that were intentionally omitted from the DTO.
- Renderers must explain approximate time accounting when percentages are shown.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| CLI and Desktop summaries diverge | Both renderers consume one DTO |
| Wide Markdown tables are unreadable | Keep tables narrow in P0 and move wide details to later UI cards |
| Report text becomes localized in Rust too early | Keep Rust renderer English for CLI/P0, let Desktop component-localized rendering replace Markdown later if needed |
| Redacted fields become confusing | Use short labels such as `redacted path` or `details omitted` and link to existing transcript detail when available |
| Approximate time reads as exact | Add a compact note near affected time fields |

Verification:

- Exact-output tests for terminal and Markdown renderers.
- Tests for partial coverage note.
- Tests for stable sort ordering.
- Tests for cache-unavailable rendering, in-progress rendering, redaction, and approximate time notes.

### Task 5: CLI `/usage`

Goal: add Claude-like interactive CLI usage reporting.

Files:

- Modify: `src/apps/cli/src/modes/chat.rs`
- Modify: `src/apps/cli/src/agent/core_adapter.rs` only if the report needs additional session identity wiring
- Modify: `src/apps/cli/src/session.rs` only if local command entries are also persisted in CLI sessions
- Test: CLI command handling tests if available; otherwise add focused unit tests around command dispatch helpers

Steps:

1. Add `/usage` to `/help`.
2. In command handling, call the shared report service for the current session id.
3. Render terminal text through `render_usage_report_terminal`.
4. Add the output as a system/local CLI message without calling the model.
5. Return a clear partial-data message if the report service cannot find a source.
6. If the existing command handler is synchronous, isolate async report loading behind a small command-dispatch boundary instead of blocking the TUI event loop with storage work.

Functional guardrails:

- Do not make `/usage` asynchronous model work.
- Do not overload `/sessions` or its aliases with usage-report behavior.
- Do not require Desktop-only state for CLI reports.
- Do not make the CLI command depend on a Tauri API or Desktop workspace state.
- Do not print sensitive raw tool details that Desktop would redact.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| CLI lacks enough persisted data | Use coverage metadata and report available basics |
| Command blocks TUI | Keep aggregation bounded and avoid scanning full workspaces |
| `/usage` conflicts with future top-level `openbitfun usage` | Keep interactive command implementation isolated behind a reusable service |
| Sync command path grows ad hoc async blocking | Add a small command dispatcher/helper rather than embedding runtime/blocking logic in the match arm |

Verification:

- CLI `/help` includes `/usage`.
- `/usage` output appears in chat without a model request.
- Existing `/sessions` aliases, `/new` and `/clear` fresh-session behavior, and normal message send
  behavior still work.
- CLI output redacts the same sensitive detail categories as Desktop P0.

### Task 6: Desktop `/usage` command and local Markdown insertion

Goal: insert a durable, model-invisible usage report in Flow Chat when the user types `/usage`.

Files:

- Modify: `src/web-ui/src/flow_chat/components/ChatInput.tsx`
- Modify or create: `src/web-ui/src/flow_chat/services/usageReportService.ts`
- Modify: `src/web-ui/src/infrastructure/api/service-api/AgentAPI.ts` or a new usage API adapter
- Modify: `src/web-ui/src/flow_chat/services/flow-chat-manager/EventHandlerModule.ts` only if local report insertion belongs in manager flow
- Test: `src/web-ui/src/flow_chat/components/ChatInput.test.tsx` or command helper tests
- Test: Flow Chat manager/store tests for local report insertion

Steps:

1. Add local `/usage` command recognition before model submit.
2. Call the usage report API for the active session.
3. Insert a local Markdown report item using the non-model-visible type from Task 2.
4. Show a user-friendly error if the report cannot be generated.
5. Ensure the report can be copied/exported like other visible chat content.
6. Pass workspace path and remote identity through the same adapter shape used by session persistence.
7. Define active-turn behavior before wiring: reject with local feedback, insert after current turn, or insert a marked point-in-time snapshot. P0 should choose the simplest safe option.
8. Add `/usage` to slash suggestions only where it can execute safely; do not queue it as a future model message while the session is processing.

Functional guardrails:

- Do not add more feature-specific branching to `ChatInput.tsx` than necessary; prefer a small command registry/helper if the existing shape supports it.
- Do not call Tauri directly from UI components; go through infrastructure API adapters.
- Do not send `/usage` to the current model.
- Do not let `/usage` participate in queued user input semantics.
- Do not store the typed `/usage` command as the user prompt for a model turn.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| ChatInput grows more coupled | Extract command handling into a small helper if more than one local command path is touched |
| Desktop and CLI render different numbers | Both call shared report service |
| User sees a blank or overly technical failure | Add localized empty/error states with retry/open-details actions |
| `/usage` gets queued during active generation | Treat it as a local command with explicit active-session behavior, separate from model queueing |
| Remote sessions read the wrong store | Carry remote identity through the report API and test remote/local request shapes |

Verification:

- Web UI test that typing `/usage` does not call send-message/model APIs.
- Web UI test that a local report appears in the session.
- Web UI test that the local report is marked model-invisible.
- Web UI test for active-session behavior and for repeated reports.
- Adapter test or mock proof that workspace path and remote identity are passed to the backend.

### Task 7: Internationalization and report presentation guardrails

Goal: make Desktop report output friendly across locales, themes, and small surfaces.

Files:

- Modify: `src/web-ui/src/locales/en-US/flow-chat.json`
- Modify: `src/web-ui/src/locales/zh-CN/flow-chat.json`
- Modify: `src/web-ui/src/locales/zh-TW/flow-chat.json`
- Modify or create: Desktop report rendering component if Markdown is rendered through a structured card in later phases
- Test: locale key coverage tests if available

Steps:

1. Add locale keys for report title, time labels, token labels, model/table labels, partial data notes, error states, and actions.
2. Use locale-aware duration and number formatting in Desktop components.
3. Keep CLI English until CLI locale support is deliberately added.
4. Define report color semantics through existing theme tokens.
5. For Markdown reports, avoid embedding hard-coded backend-localized prose in the DTO.

Functional guardrails:

- Do not add English strings directly to React components except test ids or internal identifiers.
- Do not introduce hard-coded colors for warnings, errors, model segments, or token types.
- Do not make CJK locales rely on narrow English table labels.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Report tables overflow in Chinese or Traditional Chinese | Use compact labels and allow card/list fallback in later UI |
| Theme contrast regression | Use semantic tokens and screenshot/manual checks in light/dark |
| Backend-generated Markdown cannot localize | Treat Rust Markdown renderer as CLI/P0 fallback; Desktop can render from DTO with i18n later |

Verification:

- Locale smoke check for `en-US`, `zh-CN`, and `zh-TW`.
- Theme smoke check in dark and light mode.
- Text overflow check at narrow widths.

### Task 8: Model round span enrichment

Goal: make model speed and wait-time metrics accurate after the minimal report is stable.

Files:

- Modify: `src/crates/contracts/events/src/agentic.rs`
- Modify: `src/crates/contracts/events/src/frontend_projection.rs`
- Modify: `src/crates/assembly/core/src/agentic/execution/round_executor.rs`
- Modify: `src/crates/assembly/core/src/agentic/execution/stream_processor.rs`
- Deferred: add Server/WebSocket delivery only when the server has a real usage-report event consumer; do not prebuild an unused transport adapter.
- Test: Rust event serialization and stream/round executor tests

Steps:

1. Extend model round completion metadata or add a runtime span event with provider id, resolved model id, display/model alias, duration, first chunk latency, first visible output latency, stream duration, and attempt count.
2. Preserve existing `ModelRoundStarted/Completed` event consumers by adding optional fields or a separate event.
3. Record failure category and partial recovery state when available.
4. Propagate provider token details when available: cached tokens, cache write/read, reasoning tokens, multimodal tokens, and provider-specific detail keys.
5. Update report aggregation to use precise model span data when present.
6. Keep P0 fallback logic for old sessions.

Functional guardrails:

- Do not break existing event names or required fields consumed by Desktop, server, or CLI.
- Do not emit per-token events.
- Do not change model retry behavior as part of metrics instrumentation.
- Do not derive user-facing optimization conclusions from token details in this task.
- Do not use display aliases such as `fast` for model-level aggregation when the resolved model id is known.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Event schema breaks clients | Add optional fields or a new event variant with adapter compatibility tests |
| Timing changes affect execution | Use already measured timestamps; no sleeps, locks, or awaits added to hot stream loops |
| TPS appears wrong with missing output tokens | Only compute TPS when both duration and output tokens are present |
| Model aliases merge unrelated providers | Store display alias separately from provider/resolved model id |
| Token details vary by provider | Preserve detail keys as optional structured metadata and mark coverage partial when absent |

Verification:

- Existing stream processor tests still pass.
- Event projection tests cover optional fields.
- Report tests prefer span timing when available and fall back when absent.
- Tests for cache/reasoning token detail propagation when provided and absence handling when not provided.

### Task 9: Tool phase span enrichment and classification

Goal: explain tool-heavy sessions without relying on logs.

Files:

- Modify: `src/crates/contracts/events/src/agentic.rs`
- Modify: `src/crates/contracts/events/src/frontend_projection.rs`
- Modify: `src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs`
- Modify: `src/crates/assembly/core/src/agentic/tools/pipeline/state_manager.rs`
- Test: tool pipeline/state manager tests

Steps:

1. Persist or emit queue wait, preflight, confirmation wait, execution, and total duration for completed tools.
2. Include best-effort total duration for failed and cancelled tools.
3. Add a report-only classifier for tool categories.
4. Classify legacy dedicated Git tool calls as `git`.
5. Classify ExecCommand and legacy terminal calls as `git` only when the normalized command clearly invokes Git.
6. Classify file operations by tool name and snapshot operation metadata.
7. When SubagentScheduler or budget governance events exist, consume their queued/running/retry/backoff summaries as runtime facts instead of inferring them from tool names.

Functional guardrails:

- Do not change tool scheduling, confirmation, permissions, or cancellation behavior.
- Do not parse arbitrary command text for sensitive details beyond category detection.
- Do not treat every terminal command containing the string `git` as a Git operation.
- Do not classify tool mutability or retry safety in the usage report; consume those facts from the tool/runtime owner if they exist.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Metrics changes perturb tool pipeline | Capture existing measured durations at terminal state transitions only |
| Misclassified commands mislead users | Use conservative classifiers and expose original tool name in detail |
| Failed tools lack start time | Mark phase timing partial while still counting failure |
| Report code becomes scheduler/retry policy | Keep queue/backoff/retry fields as consumed event facts, not report-owned decisions |

Verification:

- Unit tests for legacy Git tool classification.
- Unit tests for ExecCommand Git command classification and false positives.
- Existing tool lifecycle tests still pass.

### Task 10: File-change report integration

Goal: connect usage reports with existing file diff affordances without changing diff semantics.

Files:

- Modify: `src/crates/assembly/core/src/service/session_usage/service.rs`
- Read/reuse: `src/crates/assembly/core/src/service/snapshot/service.rs`
- Read/reuse: `src/web-ui/src/infrastructure/api/service-api/SnapshotAPI.ts`
- Modify later UI: `src/web-ui/src/flow_chat/tool-cards/FileOperationToolCard.tsx` only for report link integration
- Test: report aggregation tests with snapshot operation summaries

Steps:

1. Aggregate changed files from snapshot session stats and operation summaries.
2. Include additions/deletions only when available from snapshot diff summaries.
3. Preserve operation, turn, session, and git diff scopes as separate concepts.
4. Add report link metadata that can open existing diff viewers later.
5. Keep file paths normalized for display, but do not rewrite stored paths.
6. For remote workspaces where snapshot tracking is skipped or unavailable, report file stats as partial and avoid implying no files changed.
7. Prefer workspace-relative display paths; mark paths redacted when a safe relative display cannot be produced.

Functional guardrails:

- Do not change `get_operation_diff` semantics.
- Do not replace operation-scoped diff with cumulative session diff.
- Do not open or compute large diffs while generating a lightweight `/usage` report unless cached summaries exist.
- Do not read file bodies solely to enrich `/usage`.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Report generation becomes slow on large sessions | Use cached operation summaries and counts, not full diff content |
| Scope confusion returns | Store `operationIds` and `turnIds` separately from session/git scopes |
| Path normalization breaks remote workspaces | Use existing path utilities and keep original path in metadata |
| Remote sessions look like they changed no files | Render `remote_snapshot_stats` partial instead of zeroing changed-file counts |
| Absolute paths leak private workspace layout | Prefer workspace-relative paths and bounded labels |

Verification:

- Tests for operation-level additions/deletions.
- Tests for old sessions without operation ids.
- Manual check that existing file diff buttons still open the same diff.
- Tests for remote/no-snapshot coverage and path display redaction.

### Task 11: Responsive Chat-bottom usage entry

Goal: add one compact Chat-bottom entry that generates the current session usage report without displaying live metrics. Live summaries and header entries are outside the closed product scope.

Files:

- Modify: `src/web-ui/src/flow_chat/components/ChatInputWorkspaceStrip.tsx`
- Modify: `src/web-ui/src/flow_chat/components/ChatInput.tsx` only for command/action wiring that already belongs to the input surface
- Existing: `src/web-ui/src/flow_chat/components/usage/SessionRuntimeStatusEntry.tsx` remains a lightweight/tested action component, but the production Chat-bottom entry is owned by `ChatInputWorkspaceStrip`
- Test: layout/component tests near existing Chat input/footer tests

Steps:

1. Add or keep a Chat-bottom usage action that triggers the same report generation path as `/usage`.
2. Implement a stable icon/text button with an icon-only narrow fallback.
3. Preserve Chat input footer workspace, branch, model, attachment, and send-control layout priority.
4. Add tooltip and accessible label that describe the action, not live report values.
5. Hide the entry when no active session exists.
6. Keep live values out of the entry.
7. Do not add a duplicate title/header entry while the Chat-bottom action is the product-approved entry point.

Functional guardrails:

- Do not make the status entry the only way to access usage details.
- Do not use viewport-scaled font sizes.
- Do not allow the entry to push core Chat input controls offscreen.
- Do not show high-frequency timing changes in a way that causes constant reflow.
- Do not show model/tool percentages in the Chat footer.
- Do not add a title/header affordance unless a separate product/design review reopens that placement.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Small windows become cluttered | Use container-query or measured available-space collapse |
| The Chat footer becomes too dynamic while streaming | Keep the implemented entry action-only |
| Accessibility suffers in icon-only mode | Provide aria-label and tooltip with text summary |
| Users confuse live action and historical report | Label report generated time and keep the entry action-only |

Verification:

- Component/layout tests for visible text and icon-only narrow states.
- Playwright or manual screenshot checks for small desktop windows and the Chat input footer.
- Theme checks in dark and light mode.

### Task 12: Detailed report panel

Goal: provide interactive analysis without making `/usage` depend on a heavy UI.

Files:

- Current implementation: `src/web-ui/src/flow_chat/components/usage/SessionUsagePanel.tsx`
- Current implementation: `src/web-ui/src/flow_chat/components/usage/SessionUsagePanel.scss`
- Current implementation: `src/web-ui/src/flow_chat/components/usage/sessionUsagePanelTypes.ts`
- Current implementation: `src/web-ui/src/flow_chat/components/usage/openSessionUsageReport.ts`
- Deferred split, only if needed: `SessionUsageOverview.tsx`, `SessionUsageModels.tsx`, `SessionUsageTools.tsx`, and `SessionUsageFiles.tsx`
- Test: focused component tests for panel tabs and empty states

Steps:

1. Open the panel from the Markdown/report-card action and Chat-bottom usage entry.
2. Add tabs: Overview, Models, Tools, Files, Errors, Slowest.
3. Use panel-local capped lists for slowest spans and file rows first; consider virtualization only in a separate design if caps are insufficient.
4. Link file rows to existing diff open paths.
5. Show partial coverage explanations close to affected metrics.
6. Keep detail expansion routed through existing transcript/diff permissions instead of embedding raw details in the panel.

Functional guardrails:

- Do not put large charting libraries in P1/P2.
- Do not render full command output, prompts, or file contents inside the report panel.
- Do not change existing transcript tool-card behavior.
- Do not let the panel become the only place where partial-data caveats are visible; Markdown and CLI still need caveats.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| Panel becomes a second debugger UI | Keep the default view summary-first and hide raw detail behind existing transcript links |
| Large sessions cause UI jank | Cap rows inside the usage panel first; do not touch Flow Chat global virtualization without a separate design |
| File links open wrong scope | Include explicit scope metadata and route through existing diff helpers |
| Panel exposes more sensitive detail than transcript | Reuse existing detail surfaces and redaction policy |

Verification:

- Component tests for partial and complete reports.
- Manual checks on long sessions.
- Existing Flow Chat rendering tests still pass.

### Task 13: Closed product scope guardrails

Goal: keep `/usage` focused on current-session observability and prevent scope drift into cross-session summaries, recommendations, or live runtime control.

Files:

- Harden: `src/crates/assembly/core/src/service/session_usage/render.rs`
- Harden: `src/apps/cli/src/main.rs`
- Update: `session-runtime-usage-report-design.md`
- Test: current-session report and top-level CLI scope tests

Steps:

1. Keep the DTO limited to current-session runtime facts: tokens, timing, models, tools, files, errors, coverage, privacy, and navigation metadata.
2. Separate cache read, cache write, input, output, and reasoning token categories only when providers expose them reliably.
3. Keep cross-session aggregation, live footer metrics, and automated recommendations out of the closed product scope.
4. Keep top-level `openbitfun usage --session <id>` out of scope until workspace-scoped persisted session lookup is designed.

Functional guardrails:

- Do not show charts, cross-session trends, live runtime percentages, optimization recommendations, or scheduler actions in this report.
- Do not imply token counts are a quota or policy decision.
- Do not backfill or rewrite historical reports when newer runtime facts become available.
- Preserve current-session scope markers and partial-coverage copy.

Risks and mitigations:

| Risk | Mitigation |
| --- | --- |
| User reads the report as an instruction to change workflow | Keep the copy descriptive and avoid recommendations |
| Provider token semantics drift | Keep token detail fields optional and covered by partial-data markers |
| Scope expands beyond the current session too early | Keep cross-session views out of this milestone |
| Historical reports become inconsistent after runtime schema updates | Treat persisted reports as snapshots and regenerate a new report when needed |

Verification:

- Tests assert token reporting is present.
- CLI test asserts top-level `usage` is not registered.

## Product Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Usage report pollutes future model context | Higher token usage, confusing self-reference | Store as non-model-visible local command output |
| Metrics look authoritative when data is partial | User mistrust | Include coverage state and "partial data" notes |
| Token counts are mistaken for a workflow instruction | User changes behavior based on partial data | Keep the report descriptive, show coverage, and avoid recommendations |
| Chat footer becomes noisy or breaks small windows | Worse chat UX | Responsive priority collapse and tooltip-only narrow mode |
| Report exposes sensitive command/file details | Privacy concern | Default to aggregate labels; detailed command/file rows follow existing transcript visibility rules |
| Runtime tracing adds overhead | Slower sessions | Persist request/tool terminal summaries, not per-token events |
| i18n tables become unreadable in CJK locales | Poor localization | Use responsive table/cards and locale-aware number/duration formatting |
| Theme colors fail in dark/light/high-contrast modes | Accessibility issue | Use semantic theme tokens and contrast tests |
| CLI and Desktop diverge | Confusing reports | Use shared DTO and separate renderers |
| Old sessions lack span data | Empty or misleading report | Partial report with clear unavailable fields |
| Session scope is ambiguous | Double-counting or hiding subagent/side-session work | Include explicit report scope, included session ids, and subagent coverage metadata |
| Overlapping spans are summed as percentages | Percentages exceed reality and users distrust the report | Use active span union as denominator; expose resource time separately if needed |
| Cached tokens are zero-filled | False optimization signal | Hide or mark cache metrics unavailable until events carry real cache counts |
| Report reads the wrong workspace/session store | Privacy or correctness issue | Require workspace path plus remote identity in report API requests |
| Active `/usage` mutates running state | Lost queued input or corrupted turn persistence | Reject during active turn or insert only a local point-in-time snapshot outside the active round |
| Durable report leaks sensitive details | Exported chat exposes commands, paths, errors, or secrets | Use bounded labels, workspace-relative paths, redaction metadata, and no raw tool params/results |
| Usage report duplicates runtime control logic | Conflicting budget/scheduler/retry behavior | Treat report as projection only; consume typed facts from owning modules |

## Verification Strategy

Minimum checks for implementation milestones:

- Rust unit tests for report aggregation and partial coverage.
- CLI tests for `/usage` command output.
- Web UI tests for Markdown insertion, non-model-visible report item behavior, and responsive Chat-footer collapse.
- Locale smoke tests for `en-US`, `zh-CN`, and `zh-TW`.
- Theme screenshot/manual checks for dark and light modes.
- Regression check that running `/usage` does not trigger a model request.
- Fixture tests for old sessions, missing token records, cache-unavailable records, remote workspaces without snapshot stats, hidden subagent exclusion, repeated reports, and active-session behavior.
- Time-accounting tests where parent and child spans overlap, proving percentages use the intended denominator.
- Redaction tests covering command labels, file paths, error examples, and omitted tool params/results.
- Workspace identity tests proving a report cannot read a same-id session from another local or remote workspace.

For frontend changes, use the normal web verification:

```bash
pnpm run lint:web
pnpm run type-check:web
pnpm --dir src/web-ui run test:run
```

For shared Rust aggregation:

```bash
cargo check --workspace
cargo test --workspace
```

## Closed Product Decisions

No remaining product decision blocks closure. The current implementation and this document define the closed scope as:

- Desktop renders `/usage` as a dedicated local report card backed by structured metadata and Markdown fallback.
- CLI supports interactive chat `/usage`; top-level `openbitfun usage --session <id>` is outside the closed product scope.
- The compact usage entry lives in the Chat input footer as a lightweight `/usage` trigger; it does not display live model/tool percentages and no longer appears in the title/header area.
- Unavailable cache, tool timing, and file metrics include user-facing reasons in hover/help text.
- Model timing is labeled as recorded model-round time; per-model duration columns appear only when at least one model row has recorded duration facts.
- The detail panel shows generated time, session ID, and project path as separate rows with copy controls for long values.
- Idle gap is computed as wall time minus the union of recorded active turn spans when those spans are available.
- Report generation itself is a user-visible local command card, but it is excluded from report scope, timing, model/tool/file/error rows, and session activity ordering.
- `/usage` requires an idle session and returns local feedback while a turn is active.
- Cached tokens are shown as unavailable when the source cannot prove a value; unknown cache metrics are never shown as `0`.
- Hidden subagents, visible side sessions, full trace timelines, exact per-call occurrence browsing, live status metrics, and cross-session summaries are outside the closed product scope.
- Path redaction for Markdown copy/export defaults on, can be user-confirmed by checkbox, and remembers the last preference.
- The detail panel stays consolidated unless normal maintenance proves a split is needed.

## Recommended First Cut

Historical first cut, now complete in the current branch, started with Milestone P0:

1. Lock the report contract first: schema version, workspace identity, report scope, coverage keys, time accounting semantics, token source/cache coverage, and redaction policy.
2. Add shared `SessionUsageReport` aggregation using existing persisted data.
3. Add `/usage` in CLI and Desktop, with explicit idle/active behavior.
4. Render Desktop output as durable Markdown, stored as non-model-visible local command output.
5. Add explicit messaging that recorded runtime spans are approximate and may differ from pure model streaming throughput.
6. Keep one compact Chat-bottom entry point until live runtime values have a separate, reliable span contract and placement review.

This delivered immediate user value while avoiding risky runtime rewrites. The
remaining work is now concentrated in P2 hardening, not the P0/P1 report
contract.
