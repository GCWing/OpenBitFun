# Cache-Friendly Message Structure In OpenBitFun

This document owns the model-visible request ordering and the rules for keeping
that prefix stable. Session cache identity, persistence, cloning, invalidation,
and observability are owned by
[`model-request-cache-reuse.md`](model-request-cache-reuse.md); changes should
update the owning document instead of duplicating the same contract in both.

This note explains the cache-friendly request shape OpenBitFun tries to preserve
for long-running agent sessions, where each layer is stored, and which kinds
of changes tend to preserve or break provider-side prefix cache reuse.

The implementation is mostly in `src/crates/assembly/core/src/agentic/`.

## Request Shape

OpenBitFun's model requests are intentionally assembled in a stable order:

1. `system prompt`
2. `tool definitions`
3. `collapsed tool listing`
4. `skill listing`
5. `agent listing`
6. `user context`
7. `conversation history`

Two details matter here:

- `tool definitions` are request-attached provider payload, not a chat message
- `collapsed tool listing`, `skill listing`, `agent listing`, and `user context`
  are prepended reminders injected immediately before the first non-system
  conversation message
- `tool definitions` are rebuilt every turn and are not restored from a
  dedicated session-level cache artifact; the deferred catalog inside the
  `collapsed tool listing` follows the session's listing baseline snapshot

Relevant code:

- request assembly:
  `src/crates/assembly/core/src/agentic/execution/execution_engine.rs`
- prepended reminder ordering:
  `src/crates/execution/agent-runtime/src/prompt.rs`
- tool manifest resolution:
  `src/crates/assembly/core/src/agentic/tools/manifest_resolver.rs`

In practice the model-visible layout looks like this:

```text
system prompt message
tool definitions payload
collapsed tool listing reminder
skill listing reminder
agent listing reminder
user context reminder
conversation history messages
```

The reminder order is fixed on purpose:

1. collapsed tool listing
2. skill listing
3. agent listing
4. user context

That fixed order is part of the cache strategy.

## Layer By Layer

### 1. System prompt

What it is:

- the agent/mode system prompt template rendered into the first system message

How it is reused:

- cached per session in `SessionPromptCache.system_prompt`
- keyed by `SystemPromptCacheIdentity`

Where it is persisted:

- `prompt_cache.json`

What usually preserves reuse:

- staying on a compatible prompt template / prompt-cache scope
- cloning prompt cache into derived sessions instead of rebuilding from scratch

What usually breaks reuse:

- changing to a different prompt template or incompatible mode
- explicit prompt-cache invalidation
- context compression, which intentionally resets the prompt cache after
  rewriting history

Relevant code:

- cache model:
  `src/crates/execution/agent-runtime/src/prompt_cache.rs`
- cache lifecycle:
  `src/crates/assembly/core/src/agentic/session/session_manager.rs`

The old core path `src/crates/assembly/core/src/agentic/session/prompt_cache.rs` is now
a compatibility facade that re-exports the owner types from `openbitfun-agent-runtime`.

### 2. Tool definitions

What it is:

- the callable tool schema payload attached to the provider request

How it is reused:

- not stored in `prompt_cache.json`
- resolved at turn start from the effective tool manifest
- reused within the turn's model rounds, but not persisted as a session cache

Where it is persisted:

- nowhere as a dedicated session cache artifact

What usually preserves reuse:

- keeping the effective tool manifest stable across turns

What usually breaks reuse:

- adding, removing, or materially changing callable tools
- switching to an agent/profile with a different effective tool set

Why this layer is different:

- unlike prompt-visible descriptive listings, callable tools must exist in the
  actual request payload, so new tool availability cannot be represented by a
  reminder alone

### 3. Collapsed tool listing

What it is:

- a prompt-visible reminder with the tool-calling guide, the direct tool names,
  and the deferred tool catalog that `GetToolSpec` / `CallDeferredTool` serve

How it is reused:

- the deferred catalog is part of `TurnSkillAgentSnapshot.deferred_tools` and
  follows the same baseline + diff model as skill/agent listings: the head
  renders the baseline catalog in baseline order, and later additions,
  description changes, and removals (for example an MCP server that connects
  after turn 0 or reconnects with a different tool list) are appended as a
  `# Deferred Tool Listing Update` diff reminder
- deferred tools are invoked through the stable `CallDeferredTool` gateway, so
  catalog changes never touch the tool definitions payload
- the direct tool names follow the current turn's tool definitions, which
  already change the request at the tools layer when they differ
- the reminder is rendered only while the current agent exposes `GetToolSpec`
- ordered before skill/agent listings to keep the reminder prefix stable

Where it is persisted:

- inside the per-turn skill-agent snapshots and the fork baseline override
- snapshots written before deferred tools were tracked have no
  `deferred_tools` field; a session whose baseline lacks it (or lists no
  deferred tools) keeps rendering the current catalog each turn until a
  baseline rebuild adopts a tracked snapshot
- deferred-tool diff reminders reuse the `skill_listing_diff` reminder kind,
  because reminder kinds are persisted and older builds reject unknown kinds

What usually preserves reuse:

- appending deferred-catalog diffs instead of re-rendering the catalog
- catalog reordering alone, which produces no diff

What usually breaks reuse:

- changing the agent's direct tool set, which also changes tool definitions
- a listing baseline rebuild, which re-renders the head from the latest snapshot

### 4. Skill listing and agent listing

What it is:

- prompt-visible reminders for available skills and visible subagents/agents

How it is reused:

- first turn saves a full `TurnSkillAgentSnapshot`
- later turns diff the latest prior snapshot against the current snapshot
- only diff reminders are injected when the listing changes
- full listing reminder rebuild reads a baseline snapshot first, then renders
  from that baseline instead of recomputing the historical prefix from scratch

Where it is persisted:

- per-turn snapshots:
  `snapshots/skill-agent-0000.json`, `snapshots/skill-agent-0001.json`, ...
- optional fork baseline override:
  `snapshots/skill-agent-baseline-override.json`

Why there is an override file:

- forked child sessions sometimes need two different baselines at once
- the child's prompt/full-listing prefix may need to stay aligned with the
  parent's original listing baseline
- the child's later diff calculations should still use the child's own fork-time
  baseline

So OpenBitFun can keep:

- `skill-agent-baseline-override.json` as the prompt/full-listing baseline
- child `turn-0 skill-agent snapshot` as the diff baseline for later child turns

What usually preserves reuse:

- appending listing diffs instead of rebuilding full listing every turn
- seeding derived sessions from parent baselines instead of starting with a new
  full listing

What usually breaks reuse:

- losing the baseline snapshot when creating a derived session
- forcing full-listing rebuilds too often

Special rewrite path:

- when OpenBitFun rebuilds the listing baseline to the latest snapshot, it also
  removes old skill/agent/deferred-tool diff reminders from live context and
  from pre-rebuild persisted context snapshots
- a turn also rebuilds the baseline when the baseline tracks deferred tools but
  the previous snapshot does not (written by a build without deferred-tool
  tracking), because the deferred changes in between are unknown
- this is the main non-compression exception to the normal append-only message
  pattern

Relevant code:

- snapshot model and diffing:
  `src/crates/assembly/core/src/agentic/skill_agent_snapshot.rs`
- sparse snapshot store:
  `src/crates/assembly/core/src/agentic/session/turn_skill_agent_snapshot_store.rs`
- baseline rebuild and cleanup:
  `src/crates/assembly/core/src/agentic/session/session_manager.rs`

### 5. User context

What it is:

- workspace context, workspace instructions, memory files, project layout, and
  other user-context sections selected by the current policy

How it is reused:

- cached per session in `SessionPromptCache.user_context`
- keyed by `UserContextCacheIdentity`

Where it is persisted:

- `prompt_cache.json`

What usually preserves reuse:

- keeping the same user-context policy scope

What usually breaks reuse:

- changing to a different user-context policy scope
- explicit prompt-cache invalidation
- context compression, which resets prompt cache after rewriting history

The user-facing `/reload instructions` command intentionally invalidates only
the current Session's `UserContext` cache. The active turn is not rewritten;
workspace instructions are read again when the next message is assembled.
Plain `/reload` combines that operation with the independently owned Skill
Registry refresh, while `/reload skills` leaves `UserContext` intact.
An in-memory generation guard rejects a user-context build that started before
the invalidation from repopulating the cache after it, so active-turn reloads
preserve the same next-message guarantee.

### 6. Conversation history

What it is:

- the actual user / assistant / tool / internal-reminder message stream sent as
  conversation context after the prepended reminders

How it is reused:

- normal session flow is append-only: new turns extend history instead of
  rewriting already-sent prefixes
- derived sessions reuse captured parent history instead of reconstructing it

Where it is persisted:

- per-turn records:
  `turns/turn-0000.json`, `turns/turn-0001.json`, ...
- context snapshots:
  `snapshots/context-0000.json`, `snapshots/context-0001.json`, ...

Important exceptions:

- listing baseline rebuild removes old skill/agent diff reminders from live
  context and older persisted context snapshots
- context compression intentionally rewrites conversation history into a shorter
  summary form, then invalidates prompt cache and starts a new stable prefix
- image payloads are elided from older image-bearing messages at send time.
  The latest two image-bearing messages always keep pixels; older ones are
  elided four at a time (`MIN_RETAINED_IMAGE_MESSAGES`,
  `IMAGE_ELISION_BATCH` in `execution_engine.rs`). Each elision rewrites an
  already-sent message and invalidates the provider cache from that message
  onward, so it must stay batched rather than sliding by one message per new
  image. Model-pool image requirements use the same retained window.

## Session Storage Layout

Persisted session artifacts live under `.openbitfun/sessions/{session_id}/`
(or the session's effective storage mirror for remote workspaces).

The cache-relevant files are:

```text
session.json
metadata.json
prompt_cache.json
turns/
  turn-0000.json
  turn-0001.json
snapshots/
  context-0000.json
  context-0001.json
  skill-agent-0000.json
  skill-agent-0001.json
  skill-agent-baseline-override.json   # only when a session needs it
```

## Developer Rules Of Thumb

If you want to preserve prefix cache reuse:

1. Keep the system prompt identity stable.
2. Keep the user-context policy scope stable.
3. Avoid changing the effective tool manifest unless the feature really needs
   it.
4. Treat skill/agent listings and the deferred tool catalog as snapshot + diff
   state, not as text to rebuild from scratch every turn.
5. When creating derived sessions, clone prompt cache and seed listing baselines
   from the parent session.
6. Prefer append-only history updates; do not rewrite already-sent prefixes in
   normal turn flow.
7. Side requests that extend a turn's prefix (prompt suggestion, compression,
   finalize) must keep the turn's model, tools, and reasoning/thinking
   settings. Providers render reasoning settings into the prompt itself
   (DeepSeek at token 0; Anthropic invalidates the message cache when thinking
   changes), so changing them is a full miss, not a cheaper request.
8. Do not insert `system`-role messages after the start of history. Some
   chat templates (for example DeepSeek V4) hoist every system message to the
   front, which rewrites the head; use user-role reminders at the tail.

If you intentionally need to reset or rewrite the prefix:

1. Do it explicitly, like compression does.
2. Rebuild the listing baseline if the old diff chain is no longer the right
   baseline.
3. Invalidate prompt cache when the old cached prefix no longer matches the
   rewritten history.

## Implementation Map

- request assembly:
  `src/crates/assembly/core/src/agentic/execution/execution_engine.rs`
- reminder ordering and prompt builder helpers:
  `src/crates/execution/agent-runtime/src/prompt.rs`
- prompt cache model:
  `src/crates/execution/agent-runtime/src/prompt_cache.rs`
- prompt cache lifecycle and listing baseline rebuild:
  `src/crates/assembly/core/src/agentic/session/session_manager.rs`
- listing snapshots and diffs:
  `src/crates/assembly/core/src/agentic/skill_agent_snapshot.rs`
- session persistence paths:
  `src/crates/assembly/core/src/agentic/persistence/manager.rs`
