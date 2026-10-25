For `stream_processor.rs` changes, run the portable stream suite and the Core
compatibility tests, plus the relevant round-executor tests below:

```bash
cargo test --locked -p openbitfun-agent-stream
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,subscription-auth --lib agentic::execution::stream_processor::tests
```

Provider parsing changes also require the adapter's focused stream tests.


For next-input suggestions (turn reasoning settings, one identical retry,
plain-text output, unchanged message prefix, and silent failure), use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::prompt_suggestion::tests
```

Suggestion generation uses the completed turn's client, including its reasoning
settings. Providers render reasoning and thinking settings into the cached
prompt prefix (DeepSeek at token 0; Anthropic invalidates the message cache when
thinking changes), so a cheaper reasoning override turns the turn's prefix into
a full cache miss. If the model call fails, retry it once unchanged. Both
attempts share one 80-second deadline and session cancellation. Clear the
turn's output schema, retain the request prefix and cache routing, and request
plain text on both attempts. Empty output, the literal `null`, tool calls, and
content filters do not trigger the retry; all other candidate text is kept
verbatim. Do not add JSON parsing, format negotiation, correction retries, or
text reconstruction.

The prepended deferred tool listing renders the session's skill/agent listing
baseline, not the current catalog; deferred tool changes (MCP connects,
description edits) arrive as listing-diff reminders so the request head stays
cache-stable. Snapshots without `deferred_tools` (legacy) keep rendering the
current catalog. For these paths, use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib -- deferred_tool listing_baseline untracked_previous unchanged_tracked prepended_deferred
```

For model retry admission and recovery, use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::round_executor::tests
```

For pool context budgets, host-resolved member limits, and member failover, use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib model_pool
```

The pool window and input limit are independent minima across valid, enabled
text members. Resolve limits with the AI client configuration conversion. Health,
request-specific image/tool filtering, and attempted-member exclusions never
increase the common budget. Refresh it for each model round; invalidate speculative
compression when it changes. Manual compaction uses the same pool budget.

For subscription account switching, provenance, and cancellation at account
resolution, include the auth modifier:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,subscription-auth --lib agentic::execution::round_executor::tests
```

These tests use isolated HTTP servers and injected account clients; they do not
exercise real OAuth accounts or live remote hosts.

For cross-provider channels, run the real factory/round mock and replay-binding
checks with the same minimal features:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,subscription-auth --lib -- multi_channel_pool manual_model_switch_
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,subscription-auth --lib infrastructure::ai::channel_client_source::tests
```

The host injects one frozen channel source into main and finalize rounds. Try
the current channel's account recovery/pool before another channel; use the same
attempt budget. A manual member never spills to another channel. Revalidate all
approved model bindings, preserve signed/opaque history and its channel identity,
and record the actual channel in the same attempt ledger. Tests use synthetic
credentials and loopback OpenAI, Anthropic and Gemini streams, not live providers
or a full product window.

The factory carries its initial prepared client, actual account and credential
revision into the first round. Reuse it unless history requires another proven
origin; do not select again merely to recover attribution. Subsequent rounds
select through the same source, while every actual HTTP send retains the
adapter's live authority checks. HTTP and stream failures enter
`candidate_after_failure` with the same failure facts and shared budget.
The mixed fixture exercises A1 → A2 → independent key1 → key2 through the real
factory, preserving complete tool history and four actual ledger attempts.

In routed rounds (a channel route or an ordered pool) signed/opaque reasoning is
a cache preference, not a binding. Keep only the most recent producer's state,
send it to that producer when available, and otherwise rewrite the request copy
to portable history (`ChannelClientSource::portable_history`: no signature,
signed reasoning text or opaque replay; text, tool calls and results stay).
Every account or channel switch other than same-account authentication recovery
uses portable history. Session records keep the originals. Anthropic requests
whose last assistant tool turn lacks a signed thinking block run without
thinking (adapter-owned). Fixed accounts and unrouted models select the configured
destination without pinning it to historical account provenance. Before every
send, project incompatible or unproven signed/opaque state per message against
the actual channel fingerprint and account, then validate remaining replay state.
Compatible state and durable history remain intact; legacy account-only provenance
can still replay to its proven seat. Configuration/storage errors remain strict.


Native turn initialization and manual compression scaffold preparation resolve
an account before requiring credentials for any particular slot. Factory-owned
credential-free templates stay private and cannot enter the client cache or be
returned as a ready request client. Only typed account credential preparation
failures may advance an ordered pool; fixed accounts, required replay origins,
configuration drift and reasoning errors do not. A prepared account is an
in-memory preference for that exact scope, not successful durable affinity.
Native initialization observes the existing turn cancellation token; compression
preparation retains its existing cancellation/commit gate. Account preparation
does not create a model attempt or fabricate usage.

Account authentication recovery runs before auth-based switching, for both
request failures and stream failures without effective output. Recover the
same account first and retain the existing model-attempt budget, immutable
binding and replay origin. A failed recovery or another rejection may admit a
declared backup; a fixed account never does. Cancellation stops the model wait;
the auth adapter owns completion of any already-started OAuth credential commit.
The factory-backed auth fixture arranges one same-seat token replacement at the
recovery boundary, then delegates to the real factory/adapter lease path. Verify
old/new HTTP bearer headers, same-account retry before backup, one shared round
budget and attempt ledger, fixed-mode rejection and no authentication recovery
or deterministic-error retry after effective output. It does not exercise a live OAuth endpoint. Structured
deterministic rejections after partial text must remain errors, not generic
partial-recovery results that the round would retry.

Pass the request's existing prompt-cache lineage through initial resolution,
switching and retry revalidation. Freeze the actual client's credential epoch
alongside its account origin; failures must not be stamped with today's login
epoch. Structured HTTP/stream failure feedback updates model-scoped cooldown
even when the attempt budget cannot admit a switch. Deterministic input/auth
rejections and cancellation do not poison cooldown. A settled successful stream
records affinity; partial recovery/cancellation does not mark an account healthy.
Retry revalidation is separate from candidate selection. A round's own failure
cooldown must not reject its already selected account before the existing retry
loop runs. Revalidate the declared membership, current configuration fingerprint,
live credential/enable state, reasoning contract and exact upstream identity;
do not reapply quota, cooldown or affinity preferences on this path. Initial and
alternate selection still consume those observations. Cooldown is a preference:
when every declared member is cooling, selection probes the soonest-recovering
cooling member (never a provider-reported exhausted, disabled or excluded one)
instead of refusing locally; a cooling fixed account is a typed
`AccountPoolUnavailable` so a channel route skips it. No eligible alternate or
an explicitly typed credential-preparation failure leaves the original provider
retry policy in charge; configuration drift and storage-contract errors remain
fatal. Authentication recovery revalidates the same identity through this path.
The factory-backed round fixture redirects only HTTP to loopback; it retains the
real account factory, credential guard, routing files, round budget and ledger.
The complete conversation fixture also executes a read and a mutating tool
through ToolPipeline under an isolated workspace permission policy. Check the
semantic message and producing account ledger before mutation, the actual
single-append file result, complete tool history on fallback and final reply,
and service/DTO restoration. Do not treat an error ToolResult as execution.
It reopens config/factory/ledger services, not a whole app or remote host.
The process-restart fixture runs three distinct test processes per history case
against one temporary host directory, for visible and opaque-reasoning histories:
fail over A to B, restore the persisted workspace catalog and native Session
through SessionManager/PersistenceManager with fresh caches, then redeliver
persisted attempts without recounting. Complete turns through the history owner
and settle Processing to Idle through the same conditional state operation as
Scheduler. Check stable workspace/model/lineage, message/turn IDs, complete turn
records, and the exact opaque state and producing seat in restored context and
subsequent wire requests. Do not replace native restore with a DTO fixture file.
Use the adapter's explicit temporary encrypted file-vault override;
the ordinary memory-only test vault cannot survive process exit. The child
creates the normal path-based TokenUsageService and registers it process-wide
before calling the production RoundExecutor constructor. Do not
replace that startup check with a test assignment to `usage_service`.
The child is
ignored in ordinary runs and is launched only by its timed parent with isolated
storage roots. This proves process persistence, not a complete Desktop restart,
native window restore, or Windows/Linux native credential-store behavior.
The cancellation acceptance fixture holds a real HTTP stream open before or
after text output, then observes socket release and the absence of durable
cooldown/affinity. After logout or disable, reuse the same factory/source and
verify a new round selects the backup, while a reopened ledger retains the
cancelled attempt under its original account with unknown usage.

For these factory-backed mock acceptance paths only:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,subscription-auth --lib agentic::execution::round_executor::tests::factory_backed_
```


Routing-state waits are cancellable. Unreadable affinity/cooldown preferences
preserve the file and allow selection/probing from the declared policy; required
replay identity and credential validation remain mandatory.
Drain the source's deduplicated, nonfatal preference-read warning codes into the
next real attempt's existing usage context before sending. Preparation warnings
must survive until that attempt; no attempt means no fabricated ledger record.
Keep raw storage errors and paths out of the codes. They describe degraded
preferences, not a superseded attempt, auth failure, or quota rejection. Factory-created
Codex clients recheck their resolved slot, credential and seat after the existing
adaptive transport queue. Durable capacity admission is outside the first
release and is not on the ordinary request path. Completed tool history is
forwarded intact; opaque reasoning reaches only its originating account and is
degraded on a switch. Fixtures must cover both cases. Local fixtures do not prove provider or remote behavior.

Native model attempts record frozen account/model/policy/attempt identity through
the existing token usage service, including failures and cancellation without
reported counts. Known usage is emitted once per attempt, before retry/tool
settlement; the token subscriber's repeated delivery deduplicates on attempt ID.
Unknown usage must not emit a fabricated zero context-usage event.
The request model stays immutable. Only the typed, provider-reported
`response_model` from the current stream result/error fills the existing
optional ledger field, including failed or cancelled attempts. Metadata does not
satisfy effective-output or usage checks and cannot carry across attempts. Provider usage
captured before a stream error remains attached to the portable error and Core
wrapper. The account ledger HTTP/SSE fixture runs with the subscription modifier
in the round-executor command above; the portable stream fixtures run with
`cargo test -p openbitfun-agent-stream`.

For complete shell constraint checks, use:

```bash
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib complete_shell
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib edit_constraint_guard
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib exec_command::
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib hook_rewrite
```

The ignored `complete_shell_archive_replay` and `complete_shell_normal_sample_replay`
tests take absolute JSONL input/report paths in `OPENBITFUN_SHELL_REPLAY_INPUT` /
`OPENBITFUN_SHELL_REPLAY_OUTPUT` and `OPENBITFUN_SHELL_NORMAL_INPUT` /
`OPENBITFUN_SHELL_NORMAL_OUTPUT`. They only analyze strings; never execute archived
commands. The ignored Bash append integration test requires `OPENBITFUN_SHELL_TEST_BASH`
to name a trusted Bash 4+ executable and uses only isolated synthetic commands.

For automatic/manual context compaction cancellation, preparation, and commit races, use:

Each fixed summary plan has ten total model attempts, shared across transport,
stream aggregation, empty summaries, and tool-call responses. Context overflow
immediately starts a smaller plan with a fresh budget (at most four plans).
Both summary and ordinary model requests use the provider-neutral policy in
`openbitfun-agent-stream::retry` and single-attempt adapter entry points.
Failed compression terminates the turn without replacing context; there is no
locally reconstructed summary fallback. Historical compression payloads remain
readable.

Automatic compression can opt into `ai.enable_context_compression_prefetch`
(default true, omitted from persisted config when true; no frontend setting). The lead is 10,000 tokens. Speculation
starts with a zero-token tail; blocking preparation starts at 10,000 tokens.
`compression_job.rs` owns side-effect-free candidate preparation and request
identity; `compression_lifecycle.rs` owns formal hooks/events and context commit.
Portable publication/claim/cancellation semantics live in
`openbitfun-agent-runtime::compression_prefetch`. Keep a failed speculative slot
until the formal threshold: an already published failure starts fresh blocking
work, but a failure after claiming running work ends the turn. Invalid candidates
are discarded. Never emit speculative product events or install a snapshot tail.
Rebase the candidate against the latest canonical suffix under the context entry
lock, and hold the session mutation permit through formal state side effects,
releasing it before event delivery and post hooks. Do not put provider IO under
either lock. The task is execution-local and cancels on scope exit.

Stable context messages are immutable by ID: changing their content or
compression-relevant semantics requires a new message ID. Token bookkeeping
and timestamps may change without replacing identity. Prefetch admission, final
plan rebasing and canonical snapshot validation compare the entire ordered ID
prefix, not serialized message content, a content hash, or only the last ID.
Keep model/scaffold/tool request identity and atomic tool-boundary checks
independent. New history-editing paths must preserve this identity contract.

```bash
cargo test --locked -p openbitfun-agent-runtime --no-default-features --features agent-runtime --lib compression_prefetch
```

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib compression
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib compaction
```

Edit constraint enforcement is opt-in through `ai.enable_edit_constraint_guard`
(default false, omitted when false). This advanced evaluation setting has no UI
switch. Disabled runtimes skip extraction, model calls, enforcement, provenance
updates and guard telemetry even when old session constraints exist. Persisted
state remains readable and is retained for re-enablement and rollback. Enabling
this setting retains the existing POSIX-only complete shell analysis limitations;
it does not add Windows/PowerShell support. The setting belongs to the host running
the Agent (including peer and detached hosts), not a remote controller. Older hosts
without this setting retain their old behavior; changing a controller setting is
not evidence that an older target disabled enforcement.

For image observation delivery, exercise real pixel bytes, screenshot identity,
and coordinate metadata through the provider wire converters:

```bash
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git,tools-computer-use --lib computer_use_pixels_and_geometry_reach_real_provider_wire
```

## Background result delivery

Portable decisions are owned by `openbitfun-agent-runtime::scheduler::result_delivery`;
this module owns the configured-provider compatibility request and durable
finalization. It never reruns a task. The generic contract and remote limits are
documented in `docs/features/background-result-delivery.md`.

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git,remote-connect --lib background_delivery
```

This filter covers semantic-response validation, legacy job-policy round trips,
run identity, disk completion/checkpoint/recovery, and Weixin result consumption.
The `git` feature supports the existing Core unit-test fixtures. It does not
prove a live model or remote-host execution.

For request TTFT versus effective-output streaming duration:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib model_round_timing_separates_request_ttft_from_output_stream
```

This delayed loopback HTTP fixture separates response headers, metadata and model
output. It does not exercise a real provider or remote host.
