If you modify `stream_processor.rs`, run the stream integration tests before finishing.

For model retry admission and recovery, use:

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib agentic::execution::round_executor::tests
```

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
