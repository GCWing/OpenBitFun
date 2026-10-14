If you modify `stream_processor.rs`, run the stream integration tests before finishing.

For next-input suggestions (lowest supported reasoning with original-session
fallback, plain-text output, unchanged message prefix, and silent failure), use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::prompt_suggestion::tests
```

Suggestion generation tries the lowest supported reasoning first. If preparing
that client or its model call fails, make one call with the completed turn's
original client and reasoning settings. Both attempts share one 80-second
deadline and session cancellation. Clear the turn's output schema, retain the
request prefix and cache routing, and request plain text on both attempts.
Empty output, the literal `null`, tool calls, and content filters do not trigger
fallback; all other candidate text is kept verbatim. Do not add JSON parsing,
format negotiation, correction retries, or text reconstruction.

For model retry admission and recovery, use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::round_executor::tests
```

For agent loop detection (tier-to-detector translation, the intervention ladder,
the L2 arbitration port, and the model-backed judge adapter), use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::loop_detection
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::loop_arbiter
```

Detection is observation-first: every verdict is logged in every mode, a steer is
injected at the round boundary like the existing failed-tool recovery reminder,
and the hard fallback reuses the three-attempt pattern with
`finalization_reason=loop_detected`. Only high-confidence kinds may hard stop; a
judge-confirmed confidence-capped kind is the single exception. Detector state
belongs to the turn (`LoopInterventionLadder` owns it), and `mode=off` or a
closed session escape hatch must never feed the detectors.

The arbitration port stays model-free and the judge stays session-free;
`loop_detection/model_arbiter.rs` is the only place they meet, and it owns the
whole conversion: the observed round's model becomes the judge's avoided model,
and `loop`/`not_loop`/`unclear` map to confirmed/rejected/indeterminate, with
every unusable judge outcome (disabled, no eligible model, budget spent, timeout,
failure, malformed reply) keeping the heuristic verdict. Session hosts install
the judge's process-wide arbiter at assembly only when
`ai.loop_detection.judge.enabled` is set in the same configuration snapshot the
engine reads; otherwise the engine keeps its no-arbiter default. Do not add a
second arbitration trait or install the arbiter per session.

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
