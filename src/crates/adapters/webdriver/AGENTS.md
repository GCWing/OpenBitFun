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

For reveal/focus changes, build Desktop and use the real packaged UI regression
documented in `tests/e2e/AGENTS.md` (`run-interaction-scroll.mjs`).

For documentation-only changes, run `git diff --check`.
