If you modify `stream_processor.rs`, run the stream integration tests before finishing.

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
The host-global `ai.local_context_truncation` policy defaults to `explicit_only`:
only `/compact force` discards older context locally. `on_context_overflow`
selects local truncation after a classified context overflow from an ordinary or
summary model request, without retrying smaller summary plans. `always` bypasses
summary model calls and automatic summary prefetch. Local truncation preserves
original retained messages and atomic tool units; it does not generate a summary.
Other compression failures terminate the turn without replacing context.
Historical compression payloads remain readable.

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
