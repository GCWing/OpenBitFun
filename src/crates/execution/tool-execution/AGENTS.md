# tool-execution Agent Guide

Scope: this guide applies to `src/crates/execution/tool-execution`.

`tool-runtime` owns low-level reusable tool execution helpers such as filesystem
and search utilities, provider-neutral pipeline planning/retry/token policy,
ExecCommand presentation/control facts, Computer Use loop/retry policies,
prompt-safe tool context facts/custom-data materialization and extension merge,
background exec-output capture state, and provider-neutral Web tool result
processing. It is not the product tool registry, permission model, or
agent-facing tool surface.

## Guardrails

- Do not depend on `openbitfun-core`, app crates, Tauri, product-domain crates,
  transport adapters, or AI providers.
- Keep this crate focused on reusable execution primitives and pure utilities.
  Product-specific tool exposure, prompt-visible manifests, `GetToolSpec`,
  collapsed unlock state, concrete runtime handles, and the `ToolUseContext`
  owner type stay outside this crate.
- Preserve existing filesystem/search/Web tool behavior when moving helpers
  here. Do not change path containment, encoding, cancellation, extraction, or
  result presentation semantics as a side effect of refactoring.
- Listing and search algorithms consume `WorkspaceFileSystem` from
  `runtime-ports/workspace-ports`; concrete SSH/SFTP clients stay in services.
  Native and workspace-stream Grep share the Rust matcher and output reducer;
  optional target `rg` or batched system `grep` supplies conservative literal
  candidates only, after behavior probes. Complex/case-folded regex stays in the
  shared matcher; never translate it to a weaker shell regex. `tokio-util/io-util`
  bridges provider read streams into the existing blocking matcher, with
  cancellation closing pending readers.
- Glob and ignore matching compile POSIX patterns to byte regexes without host
  path normalization. The shared `regex` dependency belongs to the baseline
  search utilities; HTML extractors remain optional under `web-readable`.
- `document-read` owns offline byte-to-Markdown extraction. Non-PDF formats use
  anydoc; PDFs use its existing pdf-inspector backend's page API so readable
  pages survive alongside explicit OCR gaps. Keep source-page coverage separate
  from Markdown line-window truncation. `pages` selects original PDF pages,
  PPTX slides, XLSX visible sheets, or explicitly synthetic text chunks for
  reflowable/legacy formats. Office selection filters the in-memory OOXML
  manifest while preserving package resources; never infer slides from headings
  or claim that Word text chunks are printed pages. Keep normalized selections
  in cache keys and apply line windows within the same selected representation.
  Whole-source transfer and parser limits still apply. Dependencies remain optional, with
  OCR/network features disabled; workspace byte IO and model-facing guidance
  stay with their existing providers and Core tool owner.
- Background exec-output and ExecCommand presentation helpers may own retained
  output buffers, cursors, lifecycle metadata, assistant response text, and
  provider-neutral completion shapes; concrete local/remote process managers
  stay in services or core adapters.
- Computer Use helpers here may own provider-neutral loop detection, screenshot
  hash, verification, and retry policy. Host APIs, permissions, captures, OCR,
  accessibility, and OS input remain in host adapters.
- Provider-neutral contracts belong in `tool-contracts` (`openbitfun-agent-tools`);
  product provider grouping belongs in `tool-provider-groups`
  (`openbitfun-tool-packs`).
- `shell-analysis` owns non-executing syntax facts for complete ExecCommand
  inputs. Core's Agent Runtime selects it for task constraints; session state,
  path IO and permission decisions stay in Core. Keep the default empty;
  regex is shared with baseline filename matching. See `src/shell_analysis/README.md`.

## Verification

```bash
cargo test -p tool-runtime
cargo test -p tool-runtime --features shell-analysis --lib shell_analysis
cargo test -p tool-runtime --lib fs::read_file::tests::
cargo test -p tool-runtime --no-default-features --lib search::
cargo test -p tool-runtime --no-default-features --test tool_io_contracts
# Production LocalWorkspaceFs and bound remote-provider conformance fixtures:
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib grep_tool::tests::workspace_io
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib glob_tool::tests
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git --lib ls_tool::tests
cargo test -p tool-runtime --features document-read --lib fs::document
cargo test -p tool-runtime --features web-readable web
node scripts/check-core-boundaries.mjs
```

For documentation-only changes, run `git diff --check`.
