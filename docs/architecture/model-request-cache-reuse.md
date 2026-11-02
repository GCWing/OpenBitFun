# Model Request Cache Reuse In OpenBitFun

This document owns session cache identity, persistence, cloning, invalidation,
and cache-use observability. The exact model-visible request ordering is owned
by [`cache-friendly-message-structure.md`](cache-friendly-message-structure.md);
this document references that order but does not redefine it.

This note summarizes the mechanisms OpenBitFun uses to improve model-side prompt
cache reuse and to avoid unnecessary cache invalidation across long-running
agent sessions.

The implementation is mostly in the shared Rust runtime under
`src/crates/assembly/core/src/agentic/`.

## The Core Idea

OpenBitFun tries to keep the model-visible request prefix as stable as possible.
It does that in four complementary ways:

1. Cache stable prompt fragments at the session level.
2. Reuse or clone existing conversation prefixes when creating derived
   sessions.
3. Keep compatible coding modes on the same prompt-cache identity.
4. Move frequently changing surfaces, such as skill and subagent listings, out
   of the cached base prompt and update them incrementally.

There is also explicit observability for provider-reported cache reads versus
cache writes so OpenBitFun can measure whether these strategies are actually
working.

## 1. System Prompt And User Context Are Cached Separately

OpenBitFun does not treat the whole request prefix as one opaque string.
Instead, it separates two relatively stable layers:

- the system prompt
- the user-context reminder

The cache model lives in
`src/crates/execution/agent-runtime/src/prompt_cache.rs`.

Core still exposes `src/crates/assembly/core/src/agentic/session/prompt_cache.rs`, but
that file is now a compatibility facade that re-exports the owner types from
`openbitfun-agent-runtime`.

Key details:

- `SystemPromptCacheIdentity` keys the cached system prompt.
- `UserContextCacheIdentity` keys the cached user-context reminder.
- `SessionPromptCache` stores both entries independently.
- `PromptCachePolicy` supports both in-memory TTL and persistence TTL.
- the default persistence TTL is one day
  (`DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL`)

Session-level loading, saving, invalidation, and cloning live in
`src/crates/assembly/core/src/agentic/session/session_manager.rs`.

The test coverage in that file also explicitly exercises:

- persistence across session restore
- persisted invalidation cleanup
- prompt-cache cloning between sessions

Persistence details:

- prompt cache is persisted as `prompt_cache.json`
- the file is stored under the session directory in `.openbitfun/sessions/...`
- restore-time TTL cleanup happens before the cache is accepted back into
  memory

Request assembly uses the cache in
`src/crates/assembly/core/src/agentic/execution/execution_engine.rs`:

- `resolve_cached_system_prompt(...)` reuses a cached system prompt when the
  scope key still matches
- `build_cached_prepended_prompt_reminders(...)` reuses the cached
  user-context reminder when the user-context scope key still matches

One important design choice is documented directly in
`prompt_builder_impl.rs`: workspace context is intentionally injected outside
the system prompt cache. That lets OpenBitFun keep the global instruction template
stable while still handling workspace-dependent context separately.

## 2. Derived Sessions Reuse Existing Prefixes Instead Of Starting Cold

### Session branching

Persisted session branching is implemented in
`src/crates/assembly/core/src/agentic/persistence/session_branch.rs`.

When OpenBitFun branches a session from an existing turn, it copies more than turn
text:

- the branched turns up to the selected turn
- persisted turn context snapshots
- persisted skill/subagent listing snapshots
- persisted `skill-agent-baseline-override.json` when the source session has one
- the source session's prompt cache
- compression state and lineage metadata

This means a branch can continue from a pre-built prefix instead of paying to
reconstruct everything from scratch.

### `/btw` side questions

`/btw` is implemented as a hidden child session, not as an ad hoc detached
request.

Relevant code:

- desktop adapter:
  `src/apps/desktop/src/api/btw_api.rs`
- child-session creation:
  `ConversationCoordinator::ensure_hidden_btw_session(...)` in
  `src/crates/assembly/core/src/agentic/coordination/coordinator.rs`
- side-question prompt wrapper:
  `src/crates/assembly/core/src/agentic/side_question.rs`

The parent context snapshot is not limited to a hot in-memory session. When
needed, `load_session_context_messages(...)` restores the parent session from
persistence first and then captures the context snapshot.

The child session is initialized from a captured parent context snapshot:

- same parent agent type
- same workspace and model config
- inherited message context
- cloned session-level prompt cache
- seeded skill/agent listing baselines derived from the parent session

That gives the side thread an already-built conversational prefix.

In other words, `/btw` now reuses both:

- the parent message context snapshot
- the parent session's prompt cache via `SessionManager::clone_prompt_cache(...)`
- the parent session's full skill/agent listing baseline via
  `SessionManager::seed_forked_skill_agent_listing_baselines(...)`

### `fork_context` subagents

Forked subagents reuse even more.

Relevant code:

- snapshot model:
  `src/crates/assembly/core/src/agentic/fork_agent/mod.rs`
- request validation and tool contract:
  `src/crates/assembly/core/src/agentic/tools/implementations/task/mod.rs`
- execution and prompt-cache cloning:
  `src/crates/assembly/core/src/agentic/coordination/coordinator.rs`

When `Task` is called with `fork_context=true`, OpenBitFun:

- captures the parent session's model-visible message context
- creates an isolated child session with the parent session's agent type,
  workspace, remote metadata, and model selection
- clones the parent session's prompt cache into the child session via
  `SessionManager::clone_prompt_cache(...)`
- seeds a fork-aware skill/agent listing baseline split via
  `SessionManager::seed_forked_skill_agent_listing_baselines(...)`

That seed step intentionally keeps two different baselines:

- the parent's turn-0 skill/agent snapshot is preserved as a prompt/listing
  baseline override so the child can reuse the same full-listing prefix on its
  first request
- the parent's latest snapshot at fork time becomes the child's own turn-0
  snapshot so later child turns diff against the fork-time surface, not forever
  against the parent's original turn-0 baseline

The `Task` tool also forbids fields that would make the fork drift away from
the inherited prefix, including `subagent_type`, `workspace_path`, `model_id`,
and DeepReview retry fields.

That restriction is not just validation polish; it protects cache reuse by
keeping the forked child aligned with the parent session shape.

### Prompt suggestion

The background next-input suggestion
(`src/crates/assembly/core/src/agentic/execution/prompt_suggestion.rs`) sends
the final round's send-time messages plus one instruction, with the turn's own
client. It deliberately keeps the turn's reasoning settings: DeepSeek renders
reasoning effort and thinking mode at the very start of the prompt, so a
"cheaper" low-reasoning suggestion measured 0% cache hits on a prefix the main
loop had at 99%. Only the output schema is cleared.

## 3. Coding Workflows Keep The Agentic Cache Identity Stable

`agentic` owns the stable coding prompt base. Planning and parallel task
coordination are built-in `plan` and `multitask` Skills rather than separate
Agent modes.

Relevant code:

- the Agentic prompt identity and coding profile facts:
  `src/crates/execution/agent-runtime/src/agents.rs`
- the Agentic definition:
  `src/crates/assembly/core/src/agentic/agents/definitions/modes/agentic.rs`
- built-in Skill catalog and mode policy:
  `src/crates/execution/agent-runtime/src/skills/`

Skill availability and loading use the dynamic listing path described below.
Invoking a coding workflow therefore does not create another base Agent prompt
identity; only the dynamic Skill context changes.

The frontend also knows about this compatibility:

- `AgentInfo.prompt_cache_scope_key` is produced in
  `src/crates/assembly/core/src/agentic/agents/registry/types.rs`
- `ChatInput.tsx` only shows a prompt-cache warning when the next mode's scope
  key differs from the last submitted mode's scope key

In other words, OpenBitFun aligns backend prompt identities and frontend mode-switch
UX around the same cache-compatibility contract.

## 4. Skill And Subagent Listings Are Hot-Updated Without Rebuilding The Base Prompt

A major source of cache churn in agent systems is dynamic capability listing.
OpenBitFun explicitly avoids baking that surface into one permanently rebuilt prompt.

Relevant code:

- snapshot and diff model:
  `src/crates/assembly/core/src/agentic/skill_agent_snapshot.rs`
- sparse snapshot store:
  `src/crates/assembly/core/src/agentic/session/turn_skill_agent_snapshot_store.rs`
- fork baseline override persistence:
  `snapshots/skill-agent-baseline-override.json` via
  `src/crates/assembly/core/src/agentic/persistence/manager.rs`
- turn-time diff injection:
  `ConversationCoordinator::wrap_user_input(...)`
- baseline reminder reuse:
  `ExecutionEngine::build_cached_prepended_prompt_reminders(...)`
- reminder ordering owner:
  `src/crates/execution/agent-runtime/src/prompt.rs`

The strategy is:

1. On the first turn, OpenBitFun saves a full skill/subagent snapshot.
2. On later turns, it resolves the current snapshot again.
3. It diffs the latest prior snapshot against the new one.
4. Only the diff is injected as a reminder when something changed.

This keeps the base cached prefix stable while still letting the model see
fresh capability changes.

Forked child sessions add one extra wrinkle: prompt/listing reuse and later diff
correctness do not always want the same baseline. In those cases OpenBitFun can keep
the child's turn-0 snapshot as the diff baseline while reading the separate
baseline-override snapshot first when rebuilding the full skill/agent listing
reminder.

What gets updated dynamically:

- skills
- visible subagents / agents
- the deferred tool catalog behind `GetToolSpec` (including MCP tools); its
  head rendering follows the baseline snapshot, and changes arrive as
  `# Deferred Tool Listing Update` diff reminders because deferred tools are
  called through the stable `CallDeferredTool` gateway rather than the request
  tool definitions

Why this is effectively "hot update":

- local custom subagents are reloaded during request wrapping via
  `load_custom_subagents(...)`
- skills are rescanned for the current workspace via
  `get_resolved_skills_for_workspace(...)`
- the desktop app also exposes an explicit `reload_subagents` command in
  `src/apps/desktop/src/api/subagent_api.rs`

So capability changes can reach the next request without restarting the session
and without rebuilding the main prompt template.

### Current gap: per-agent tool changes still churn request-prefix cache

This is not fully solved yet.

OpenBitFun does allow tool customization at the agent/profile level:

- built-in modes resolve their effective tools from default tools plus user
  `added_tools` / `removed_tools`
- custom subagents can define their own tool lists directly

Relevant code:

- mode/profile tool overrides:
  `src/crates/assembly/core/src/service/config/types.rs`
  and `src/crates/assembly/core/src/service/config/mode_config_canonicalizer.rs`
- runtime resolution of effective agent tool policy:
  `src/crates/assembly/core/src/agentic/agents/registry/query.rs`

However, tool manifests are still recomputed per turn/request, not diff-patched
like skill and subagent listings.

More precisely:

- `ExecutionEngine` resolves `get_agent_tool_policy(...)` at turn start
- it then resolves `resolve_tool_manifest(...)`
- the resulting `tool_definitions` are attached to the model request for that
  turn
- all model rounds inside the same turn reuse that resolved tool surface

Relevant code:

- request-time tool manifest resolution:
  `src/crates/assembly/core/src/agentic/execution/execution_engine.rs`
- tool definitions included in token estimation:
  `src/crates/assembly/core/src/util/token_counter.rs`
- provider request-body tool attachment:
  `src/crates/adapters/ai-adapters/src/providers/openai/responses.rs`
  and `src/crates/adapters/ai-adapters/src/providers/openai/codex_chatgpt.rs`

This is why tool changes cannot currently be handled the same way as
skill/subagent listing updates.

Skill and subagent listings are prompt-visible descriptive surfaces, so OpenBitFun
can:

- keep a baseline
- send only a diff reminder when they change

But tool availability is different. For many tool-calling providers, the model
is only allowed to call tools that are present in the current request's tool
definitions/schema payload.

That creates an asymmetry:

- removing a tool or changing its description can be partially explained with a
  reminder
- adding a new callable tool cannot be expressed by reminder alone
- the new tool must exist in the turn's actual `tool_definitions`

So as long as the callable tool set is request-attached in this provider style,
new tool additions will necessarily mutate the request prefix surface and
typically break prompt-cache reuse for that turn.

One plausible future direction would be to expose only a single stable
"tool-dispatch" entry in the provider request and let that entry accept:

- the real tool name
- the real tool arguments

In that design, the provider-visible tool schema could stay nearly constant
even when the product's actual tool catalog changes underneath it.

Deferred tools already work this way: `GetToolSpec` and `CallDeferredTool` are
the only request-attached entries, and the deferred catalog is a snapshot +
diff listing (see above). The remaining gap is limited to direct tools, plus
the moment a session gains or loses its first deferred tool, which adds or
removes the two gateway definitions.

However, OpenBitFun does not currently plan to extend this to direct tools.

Reasons:

- it would be a fairly large architectural change across tool schema exposure,
  execution, validation, safety checks, and provider adapters
- the cache misses caused by tool-set changes are relatively low-frequency in
  practice
- those misses are usually user-driven, because changing an agent's tool set is
  an explicit configuration action rather than a high-churn runtime event

So while the direction is technically viable, it is not currently attractive
enough relative to its implementation cost.

## 5. Compression Rebuilds A Smaller Stable Prefix

Compression is not a pure cache-preserving operation, but it is still part of
OpenBitFun's cache-hit strategy.

Relevant code:

- compression flow:
  `src/crates/assembly/core/src/agentic/execution/execution_engine.rs`
- compressor:
  `src/crates/assembly/core/src/agentic/session/compression/`

There are two different cache-reuse stories around compression:

1. the compression request itself reuses the current session prefix
2. the completed compression result intentionally invalidates and rebuilds the
   session prompt cache

### Compression request path: reuses the existing prefix

OpenBitFun does not send compression as a detached, prompt-from-scratch request.

Instead:

- `build_compression_request_messages(...)` calls
  `build_ai_messages_for_send(...)`
- that means the compression request is assembled through the same message-send
  path used for ordinary model rounds
- prepended reminders are preserved
- the current conversation messages are preserved

For automatic compression, the `runtime_messages` passed into
`build_compression_request_messages(...)` come from the active `messages`
buffer, which already includes the current system prompt at the front of the
request.

For manual compaction, the code explicitly rebuilds `runtime_messages` as:

- `system_prompt_message`
- followed by the current session messages

Only after that shared prefix is rebuilt does OpenBitFun append the final
compression-specific instruction from
`context_compressor.build_compact_prompt(...)`.

So the compression model call itself is prefix-reusing by design: it keeps the
same stable prefix and adds one extra user message that asks the model to
compact the conversation.

There is even an explicit runtime comment documenting why an older pre-pass was
removed: the removed "microcompact" rewrite mutated already-sent prefixes and
"kill[ed] provider KV-cache hits on every round". The current compression path
keeps that concern front and center.

### Compression completion path: invalidate, then rebuild against a shorter prefix

When compression is applied, OpenBitFun does three important things:

1. Replaces the live context messages with the compressed result.
2. Rebuilds the skill/subagent listing baseline to the latest snapshot.
3. Invalidates the session prompt cache because the mutable prefix changed.

That invalidation happens on purpose. After compression, the old cached prompt
fragments no longer match the new conversation prefix.

However, the next request can rebuild cache entries against a much shorter and
more stable post-compression prefix. In practice, compression is a "reset once,
reuse many times after" mechanism, not a permanent loss.

## 6. Provider Cache Activation

Most providers cache prefixes automatically (DeepSeek, OpenAI, Gemini implicit
caching). OpenAI additionally routes requests by `prompt_cache_key`; OpenBitFun
sends the session's prompt-cache lineage as that key on Responses/Codex
requests and on Chat Completions requests to `https://api.openai.com/v1`
only, because other Chat Completions servers may reject unknown fields.

Anthropic Messages caches only content marked with `cache_control`
and writes cache entries only at those breakpoints, checking at most 20 blocks
back from each one.

The Anthropic adapter
(`src/crates/adapters/ai-adapters/src/providers/anthropic/request.rs`) therefore
adds three `{"type": "ephemeral"}` breakpoints to every request:

- the last `system` block (or the last tool when there is no system prompt),
  so tools + system are reusable across sessions
- the last cacheable block of the last message, so each request writes the
  entry the next request extends
- the last cacheable block of the penultimate message, which lines up with the
  previous request's write and keeps a lookback anchor when a request appends
  many blocks

Thinking and blank text blocks are skipped. The system prompt is sent as one
text block so it can carry the marker; on prefix-caching gateways this does not
change the cached prefix (verified on DeepSeek's `/anthropic` endpoint).
Compatible gateways accept the same block-level markers that Claude Code
sends. A top-level `cache_control` in the model's custom request body replaces
this policy: an object enables Anthropic automatic caching with the user's TTL,
and `null` removes all markers. Requests that already contain block-level
markers are left unchanged.

## 7. Cache Observability Is First-Class

OpenBitFun also normalizes provider-specific cache telemetry so cache reuse can be
measured instead of guessed.

Relevant code:

- unified usage types:
  `src/crates/adapters/ai-adapters/src/stream/types/unified.rs`
- Anthropic mapping:
  `src/crates/adapters/ai-adapters/src/stream/types/anthropic.rs`
- OpenAI / DeepSeek mapping:
  `src/crates/adapters/ai-adapters/src/stream/types/openai.rs`
- runtime event emission:
  `src/crates/assembly/core/src/agentic/execution/round_executor.rs`

Two fields matter:

- `cached_content_token_count`: cache reads / hits
- `cache_creation_token_count`: cache writes / creation

OpenBitFun keeps them separate on purpose. That avoids overstating hit rate and
makes it possible to answer both of these questions correctly:

- "How many input tokens were served from cache?"
- "How many input tokens were spent creating new cache entries?"

## Summary

OpenBitFun improves request cache hit rate by combining prompt splitting, session
reuse, compatible mode identities, incremental capability-list updates, and
post-compression prefix rebuilding.

The most important implementation choices are:

- stable prompt pieces are cached separately and persisted per session
- derived sessions reuse parent prefixes instead of starting from zero
- shared coding modes keep the same cache identity and express differences as
  reminders
- dynamic capability surfaces are updated incrementally outside the base cached
  prompt
- provider cache-read and cache-write telemetry is tracked separately

## Implementation Map

- Prompt cache model:
  `src/crates/execution/agent-runtime/src/prompt_cache.rs`
- Prompt cache lifecycle:
  `src/crates/assembly/core/src/agentic/session/session_manager.rs`
- Request assembly and cache hits:
  `src/crates/assembly/core/src/agentic/execution/execution_engine.rs`
- Fork snapshot model:
  `src/crates/assembly/core/src/agentic/fork_agent/mod.rs`
- Session branching:
  `src/crates/assembly/core/src/agentic/persistence/session_branch.rs`
- Side-question child sessions:
  `src/crates/assembly/core/src/agentic/coordination/coordinator.rs`
  and `src/apps/desktop/src/api/btw_api.rs`
- Shared coding-mode identities:
  `src/crates/execution/agent-runtime/src/agents.rs`
- Dynamic skill/agent listing snapshots:
  `src/crates/assembly/core/src/agentic/skill_agent_snapshot.rs`
- Provider cache telemetry:
  `src/crates/adapters/ai-adapters/src/stream/types/`
