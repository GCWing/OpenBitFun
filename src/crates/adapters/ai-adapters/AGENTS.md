# AI Adapters Agent Guide

Scope: this guide applies to `src/crates/adapters/ai-adapters`.

`openbitfun-ai-adapters` owns provider-specific request/response mapping, stream
protocol parsing, subscription auth (in-app OAuth login and credential
resolution), and provider/model selection helpers that are independent of core
config IO. Keep provider quirks here, then convert stream chunks into the
provider-neutral contracts owned by `openbitfun-agent-stream`.

## Guardrails

- OpenAI Responses and Codex ChatGPT flat tool schemas are adapter
  serialization behavior. Keep core/tool manifests provider-neutral.
- `cached_content_token_count` means cache reads/hits. Keep
  `cache_creation_token_count` separate, and preserve provider-specific mappings
  such as DeepSeek prompt-cache hits and Gemini's current lack of creation
  count.
- Do not change shared stream or usage semantics without updating the focused
  adapter tests and downstream usage expectations.
- Do not move provider-neutral stream DTOs, replay policy, or tool-call
  accumulation ownership back into this crate.
- Subscription auth (Codex/Antigravity codex CLI user-agent probing) may reuse
  lower-layer service command helpers for PATH and process-platform behavior; do
  not introduce host framework calls.
- Keep `subscription-auth` optional so standalone protocol adapters do not pull
  service/process dependencies by default. Never scan or reuse third-party CLI
  credential files on disk; tokens come only from the in-app OAuth store.

## Subscription protocol references

Compared on 2026-09-08 against [OpenCode v1.18.29](https://github.com/anomalyco/opencode/tree/16747470f976aca3d362ad730bcd3fe82ecc2c9a)
(`account/account.ts`, `plugin/openai/codex.ts`, `plugin/xai.ts`, and
`session/llm/request.ts` under `packages/opencode/src`) and
[Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/6e2b8e070d28b1a3381a3fb290b6b8d6cce13cef)
(`hermes_cli/auth_nous.py`, `hermes_cli/providers.py`, `agent/codex_headers.py`,
`agent/opencode_affinity.py`, and `agent/transports/codex.py`).

- OpenCode Console OAuth supports Zen only. The Go preset uses an API key.
  Keep legacy Go OAuth configurations readable, but reject their requests with
  an explicit API-key migration error before accessing credentials or network.
  The released baseline supports Zen and Go through OAuth, without built-in
  Zen/Go API-key presets. Preserve old Zen credentials and model configs; do not
  convert Go OAuth tokens into API keys or delete/reset model or vault data.
  Unreleased preset/removal changes are not a separate migration baseline.
- Hermes currently defaults even `anthropic/*` to Chat Completions while the
  Portal native Messages cache issue is unresolved. Preserve the Nous bearer
  and `x-nous-refresh-token` refresh contract, including rotated-token storage.
- Subscription credentials own authentication and account headers regardless
  of saved replace mode or header casing. Use OpenBitFun attribution for Codex;
  retain provider-required compatibility headers for xAI and
  Antigravity. Public API-key configurations retain their authentication policy.
- Additional subscription request policy is enabled only by an explicit runtime
  subscription identity attached after resolving AuthConfig::Subscription; URLs
  and model names never opt ordinary API-key clients into it. Separately,
  API-key calls to the six official HTTPS Zen/Go Chat Completions, Responses,
  and Messages routes require `x-opencode-session` without activating any
  subscription authentication or account-header policy.
- Request affinity comes from `ModelRequestContext` on each call, never from a
  random ID on a cached client. Standalone OpenCode calls without runtime context
  still require `x-opencode-session`: generate one opaque identity per logical
  call and reuse it across all retries, including aggregate stream retries.
  Only the matching provider origin receives it.
  Client caches also compare the durable credential revision so login, logout,
  refresh, and account catalog changes invalidate old credentials/routes.

## Verification

OpenCode API-key discovery uses `https://models.opencode.ai/api.json` with a
one-hour public-only memory cache and no account headers. Preserve per-model
Chat Completions, Responses, and Messages routes and unknown manual IDs.
OpenCode Console discovery merges the public base catalog with authenticated
account overrides and filters to Zen. OAuth routes preserve Console-owned HTTPS
`opencode.ai/inference/` addresses and `x-opencode-org-id`; bind only the Console
token reference to the current OAuth credential. Never send OAuth tokens to
public Zen/Go API-key routes. Legacy accounts lazily refresh missing routing
metadata with credential revision checks, preserving their tokens and models.
A failed account request (including 404) must not fall back to public OAuth
inference. Account route metadata must not contain keys or token material.
Antigravity uses `v1internal:fetchAvailableModels`; preserve returned wire IDs
and restrict alias translation to known legacy names. Codex's `supported_in_api`
flag describes the public API, not subscription availability. OpenCode public catalog
models must stay grouped by plan and wire format. Never mask a failed account
lookup with a static catalog or another application's local model cache.

For the auth/discovery path, use `cargo test -p openbitfun-ai-adapters --features
subscription-auth --lib`. Device-grant timing tests use the dev-only Tokio
test clock and synthetic tokens; they do not authorize real accounts.

xAI OAuth resolves device and token endpoints from its OpenID discovery document
at the start of each login or refresh. Keep the issuer and endpoint origin pinned
to `https://auth.x.ai`; discovery failure must remain explicit. A pending device
grant retains its discovered token endpoint throughout polling. Discovery uses
the host's subscription HTTP proxy options and does not change inference routes
or persisted credential shapes.

```bash
cargo test -p openbitfun-agent-stream
cargo test -p openbitfun-ai-adapters
cargo test -p openbitfun-ai-adapters --lib opencode_catalog
cargo test -p openbitfun-ai-adapters --features subscription-auth subscription_auth
cargo test -p openbitfun-ai-adapters --lib providers::shared::tests
cargo test -p openbitfun-ai-adapters --features subscription-auth --lib providers::shared::tests
```

If stream behavior affects core integration, also run the relevant tests in
`src/crates/assembly/core/tests`.
