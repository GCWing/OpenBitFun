# webdriver Agent Guide

Scope: this guide applies to `src/crates/adapters/webdriver`.

`openbitfun-webdriver` owns the embedded desktop WebDriver bridge. It is a
platform-integration crate, not a product runtime or tool-policy owner.

## Guardrails

- Keep startup gated by the existing debug, feature, and environment checks.
- Platform capture, evaluation, and native WebView access may live here; product
  policy, session lifecycle, tool exposure, and agent decisions must not.
- Preserve WebDriver protocol response shapes, session/window/element semantics,
  and platform-specific capture/evaluation behavior.
- Do not expose this crate as a shared runtime contract; route product-facing
  behavior through desktop/API/transport boundaries.

## Verification

```bash
cargo check -p openbitfun-webdriver
```

The crate selects Tauri's raw WebView access and the PNG/JPEG codecs it uses;
focused checks must not depend on feature unification from the Desktop host.

For macOS screenshot encoding, also run
`cargo test -p openbitfun-webdriver --lib platform::capture::imp::tests`.
The tests cover lossless pixels/alpha, decode errors and the existing timeout
including the blocking queue. After rebuilding Desktop, use native screenshot
and Browser workloads for full callback, presentation and preview coverage;
bitmap tests alone do not establish UI latency or resource improvements.

For reveal/focus changes, build Desktop and use the real packaged UI regression
documented in `tests/e2e/AGENTS.md` (`run-interaction-scroll.mjs`).

For script result serialization and background browser automation, build Desktop
and run `node tests/e2e/scripts/run-browser-session-isolation.mjs`. It checks
numeric-length object fields, DOM collection references and actual article reads.

For native script transport changes, also run
`node tests/e2e/scripts/run-webdriver-evaluation.mjs` with frozen frontend/native
overrides and a fresh `OPENBITFUN_EVALUATION_FUNCTIONAL_EVIDENCE` directory.
It checks structured arguments, sync/callback/Promise execution, expression
side effects, errors, timeout recovery, selected frames and document replacement.
Cache only the native wrapper source; user expressions/functions must still be
evaluated on every call. Use the separate evaluation diagnostic documented in
`tests/e2e/AGENTS.md` to measure driver overhead, not product performance gains.

For same-origin frame execution, build Desktop and run
`node tests/e2e/scripts/run-webdriver-frames.mjs` with completed frontend/native
snapshots and a new `OPENBITFUN_FRAME_EVIDENCE` directory. It checks frame-local
user scripts, element lookup/input/click/scroll/labels, nested frames, parent/top
restoration and index selection. Internal commands resolve the bridge and element
store on the native top-level document; DOM reads still use the selected frame.
This is native functional coverage, not performance or cross-origin support.

For documentation-only changes, run `git diff --check`.
