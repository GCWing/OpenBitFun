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

```bash
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib compression
cargo test --locked -p openbitfun-core --no-default-features --features agent-runtime,git --lib compaction
```
