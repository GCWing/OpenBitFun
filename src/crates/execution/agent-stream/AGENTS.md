# agent-stream Agent Guide

Scope: this guide applies to `src/crates/execution/agent-stream`.

`openbitfun-agent-stream` owns provider-neutral stream DTOs, tool-call accumulation,
and replayable stream processing contracts. Provider wire parsing belongs in
`src/crates/adapters/ai-adapters`, which converts provider chunks into these
portable stream contracts.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, Tauri, concrete services,
  transport adapters, AI adapters, terminal, tool-runtime, or product-domain
  implementations.
- Keep provider-specific SSE or response parsing in `openbitfun-ai-adapters`; this
  crate only owns provider-neutral stream assembly and replay behavior.
- Do not add session lifecycle, tool execution, prompt policy, or product
  orchestration behavior here.
- Stream contract changes must preserve ordering, tool-call reconstruction,
  reasoning/thinking fields, usage accounting, and malformed-chunk handling.
- Tool argument syntax repair uses upstream `jsonrepair-rs` with
  `preserve_comment_markers` and `decode_unquoted_escapes` enabled. Keep repair
  gated by the setting and a confirmed normal tool-use completion, then parse
  and validate the candidate through the existing pipeline. Schema-guided
  correction is not enabled. Write close-only recovery remains separate.
- Escape decoding preserves the existing model-argument policy: an unquoted
  literal Windows path containing `\n` or `\t` is ambiguous and will decode
  those escapes. Use properly escaped JSON paths; do not infer path semantics
  from the controller OS, since the runtime and workspace may be remote.

## Verification

```bash
cargo test -p openbitfun-agent-stream
node scripts/check-core-boundaries.mjs
```

When provider fixture parsing changes, run the focused `openbitfun-ai-adapters`
stream tests as well.

For documentation-only changes, run `git diff --check`.
