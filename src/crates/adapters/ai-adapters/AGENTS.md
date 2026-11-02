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
- Anthropic Messages requests carry block-level `cache_control` breakpoints
  (system head, last two messages); without them Anthropic does not cache at
  all. Keep the custom-body top-level `cache_control` override (object or
  `null`) and the "leave existing markers alone" rule; see
  `docs/architecture/model-request-cache-reuse.md`.
- Do not change shared stream or usage semantics without updating the focused
  adapter tests and downstream usage expectations.
- OpenAI Chat Completions streams request `stream_options.include_usage` by
  default, preserving explicit custom-body `false`/`null` overrides. Only an
  HTTP error explicitly rejecting `include_usage` or `stream_options` may
  trigger one compatibility resend without the rejected option. Use the error
  body as evidence across 4xx/5xx statuses, not just 400/422; preserve dedicated
  authentication and rate-limit handling. Keep other
  request content, authorization checks, and attempt traces intact. Never
  replay an accepted stream to recover usage, or invent usage when the
  provider omits it. This negotiation is per call, with no persisted provider
  capability assumption. Focused check:
  `cargo test --locked -p openbitfun-ai-adapters --lib providers::openai::chat::tests`.
- Do not move provider-neutral stream DTOs, replay policy, or tool-call
  accumulation ownership back into this crate.
- Optional model image-input ceilings are applied to outgoing message copies at
  the shared AIClient send boundary, including single-attempt Responses calls.
  Count user image parts and tool attachments together; preserve durable history,
  tool-result identities, opaque tool text and non-image media. Newer messages
  keep their pixels first, with explicit omission text for older pixels. Verify
  with `cargo test --locked -p openbitfun-ai-adapters --lib client::image_budget::tests`.
- Normalize explicitly reported response models into the typed stream
  `response_model` observation. Responses/Codex lifecycle metadata is emitted
  before an associated error, and Chat Completions model identifiers remain
  separate from the configured request model. Never infer an observation from
  URLs, model selection or error text. Inline-think buffering must not hide it,
  and metadata alone must not satisfy TTFT or become effective output.
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
- `prepare_account_request_route` exposes credential-free provider protocol/model facts
  without credential IO or subscription identity. It shares the route definition
  with real credential resolution for static routes; OpenCode's final route
  must come from the selected account's catalog. It must never enable subscription request
  policy on an ordinary API-key client; product initialization/account fallback
  decisions remain in the factory and native runtime.
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

- Public Zen free-model compatibility lives in `providers::opencode`, compared
  with [pi-opencode-zen](https://github.com/ZhiAo1120/pi-opencode-zen) on 2026-10-19.
  Apply the matching session/session-id headers and compatibility user agent
  after custom-header merging; exclude the legacy `x-opencode-request` header
  on this route, including custom-header spellings. Session IDs retain runtime
  conversation affinity and match the provider's decrementing-time layout.
  Preserve explicit API-key authentication, and use Zen's public key only when
  no key/custom auth is set. Go, including its free-named models, retains its
  paid route and ordinary client identity.
  Known free models require streaming and lowercase `bash`/`read` definitions;
  translate actual tools, history, named choices, and returned names at the
  adapter boundary. Missing tools are advertised as unavailable compatibility
  placeholders and any attempted call fails explicitly as `InvalidRequest`.
  Never execute these placeholders or enable this policy for Console OAuth,
  lookalike origins, or unrelated providers.

  The ignored `providers::opencode::tests::live_mimo_public_connection` test
  sends a synthetic prompt and the settings connection probe over real network
  transport. Run it explicitly with `-- --ignored --nocapture`; set
  `OPENBITFUN_LIVE_OPENCODE_PROXY` only for an explicit proxy, or
  `OPENBITFUN_LIVE_OPENCODE_CONFIG` to verify an explicitly selected local
  application config's public MiMo model and proxy. The latter requires the
  selected model to have API-key auth with literal `public`; it never resolves
  OAuth or prints credentials. This proves the tested network at that time,
  not continuous availability or any remote-host scenario.

- Explicit account slots use `<provider>-account-<canonical UUID v4>` in the
  existing v2 credential store; each provider key remains its legacy default.
  Codex, Antigravity, OpenCode Zen, Grok and Hermes share slot validation,
  conditional identity commits and resolved-client binding through `accounts`;
  each provider owns authorization, refresh and trusted routing. Named-slot
  reauthentication must preserve its upstream account identity. Resolve,
  refresh, and logout target that slot's revision and never fall back to the
  default credential. Account-level logout retains non-secret seat metadata and
  clears vault references, so reauthentication still checks the same identity.
  Account eligibility lives in versioned non-secret account metadata; disable is
  independent of login, advances the credential epoch, and sets the existing
  v2 reauthentication gate for older readers. New readers retain disabled vault
  references and reject model resolution while disabled. Preserve same-version
  management extensions across refresh, and never reset unknown versions.
  Legacy provider writes must preserve additional slots.
  The legacy provider list stays default-only; `list_account_instances` exposes
  the account-aware view and propagates store read failures. See
  [account routing design](../../../../docs/architecture/subscription-account-routing-design.md).

- Rejected access tokens may trigger provider-owned recovery even before expiry. Under
  the account refresh lease, reuse a concurrent replacement or rotate the exact
  rejected credential, checking its upstream identity and store revision.
  Once OAuth rotation starts, finish its CAS commit independently of a model
  waiter's cancellation. The four additional providers use
  `complete_credential_refresh` to own the complete refresh lease/CAS operation.
  Logout/disable still win by epoch. For Codex, an OAuth
  `invalid_grant` on HTTP 400/401 marks reauthentication required by revision,
  preserving identity and vault references; transient errors do not. A stale
  rejection must not invalidate a newer login.

- `bind_resolved_account_identity` verifies that the selected slot still holds
  the exact resolved token, then binds its provider-owned upstream identity to an
  adapter-owned identity guard. After the existing in-process adaptive queue,
  and before every HTTP attempt, recheck the live credential, enabled state and
  upstream identity. Rotation, logout or disable must reject a stale client.
  Ordinary requests do not read capacity policy, reserve durable occupancy or
  create capacity files. A changed credential produces structured local `Auth`;
  unreadable vault/binding state produces `InvalidRequest` with no provider or
  status, never an inferred provider cooldown. Provider-only attribution and
  API-key clients do not infer an account slot.

- Code Assist streaming uses `handle_gemini_code_assist_stream` to unwrap its
  response envelope before the shared Gemini parser. Ordinary Gemini stays on
  the flat wire path. Preserve raw SSE, text, signatures, usage and terminal
  completion; wrapped RPC errors remain structured adapter errors. Focused check:
  `cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib stream::stream_handler::gemini::tests`.

- Factory clients may also carry a host-owned `ModelRequestAuthorization` check.
  Run it after the existing transport queue and before each HTTP attempt, for
  every protocol. Adapters do not read product configuration themselves. Local
  configuration/key revocation is `InvalidRequest` without provider/status and
  must not trigger provider cooldown or failover. Verify queue-time revocation
  and revalidation before transport retries with the SSE command below.
- Model transport allows 30 seconds for connection setup, including proxy
  CONNECT and TLS. A 10-second cap rejected measured working proxy handshakes
  before any model HTTP request was sent. Keep the per-call TTFT budget around
  the complete send; a shorter configured TTFT must still cancel connection
  setup instead of waiting for this transport ceiling.

## Verification

Grok OAuth uses `https://cli-chat-proxy.grok.com/v1` for model discovery and
Responses inference, with Grok Build's client/token-auth headers. `api.x.ai`
is the separate API-key service; never interpret its OAuth 403 as proof that a
subscription is missing. Compared with magpie's `packages/grok/index.mjs` and
[official enterprise docs](https://docs.x.ai/build/enterprise) on 2026-10-19.
Preserve saved model IDs and credentials; override old public routes only in
resolved subscription clients. Public API-key clients retain their own route.
The account catalog must come from that selected account and include only
Responses models; an empty or failed read stays an error.

Focused checks: `cargo test --locked -p openbitfun-ai-adapters --features
subscription-auth --lib subscription_auth::grok` and the shared-header command
below. The ignored `subscription_auth::grok::tests::live_grok_model_catalog`
accepts `OPENBITFUN_LIVE_GROK_ACCOUNT` (an exact in-app slot) and optionally
`OPENBITFUN_LIVE_SUBSCRIPTION_PROXY`. It may refresh that slot, then exercises
production discovery without inference or reading third-party credentials.
This verifies the selected host's catalog, not generation eligibility or remote
transport behavior.

ZCode (`zcode`, `zcode_cn`) uses browser authorization with server polling; no
loopback callback or third-party desktop credential read is involved. Protocols
were compared with magpie's `internal/provider/zcode.go` and
[magpie-community/plugins](https://github.com/magpie-community/plugins), commit
`ab38da681af7716ea9a7609f045ca91d2ad9988a`, on 2026-10-19. ZCode imports active
personal/team Coding Plans only; its vault access field holds the project key
after browser authorization, with a non-expiring credential marker. Never use a
business-session token for inference or silently switch Coding Plan requests onto
Start/gift plans. Region and project endpoints are adapter-owned. Catalog
failures remain errors.

WorkBuddy (`workbuddy`, `workbuddy_ai`) is retired. The vendor stopped allowing
subscription-token access, so its sign-in, refresh, catalog, request-dialect and
billing protocols were deleted. `SubscriptionProvider::{Workbuddy, WorkbuddyAi}`
stay deserializable, keep their store keys, and are absent from
`SubscriptionProvider::ALL` so nothing offers them; every login, resolve,
catalog, quota and route path returns `SubscriptionProvider::retired_error()`.
Stored credentials are never deleted automatically: a slot that still holds
state is listed in `list_accounts`/`list_account_instances` so an upgrade can
show and remove it. Do not reintroduce a vendor protocol without confirming the
vendor allows subscription access again.

Focused checks: `cargo test --locked -p openbitfun-ai-adapters --features
subscription-auth --lib subscription_auth` and `cargo test --locked -p
openbitfun-ai-adapters --features subscription-auth --lib providers`.
The ignored `subscription_auth::browser_poll::tests::live_browser_authorization_endpoints`
probe accepts an optional `OPENBITFUN_LIVE_SUBSCRIPTION_PROXY`, creates short-lived
flows, prints browser hosts only, and never polls, authorizes, or stores an account.
It verifies initiation only, not inference or any remote transport scenario. The
ZCode-only probe is
`subscription_auth::zcode::tests::live_browser_authorization_init`, with the same
proxy option and no polling or persistence. ZCode initialization retries transient
pre-request connection resets at most twice, keeping the same poll/device identity;
never replay API refusals, certificate errors or an ambiguously sent POST. Polling
keeps its advertised interval and expiry across transient connection failures.
The ignored `subscription_auth::zcode::tests::live_public_coding_catalogs` probe uses
the same proxy variable to read both public regional Coding Plan catalogs,
without any credentials; it does not establish account eligibility.

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

Router HTTP serialization, classifier parsing, authentication, and failures:

```bash
cargo test --locked -p openbitfun-ai-adapters --lib round_router
```

`round_router` owns the OpenAI-compatible wire protocol and returns classifier
facts. Core retains thresholds, model-slot selection, context lifecycle, traces,
and fallback; the adapter must not depend on Core config or Agent sessions.

Local Router token counting (optional `local-tokenizer`, no model downloads):

```bash
cargo test --locked -p openbitfun-ai-adapters --features local-tokenizer --lib local_tokenizer
```

Subscription model discovery must use the authenticated account catalog.
Antigravity uses `v1internal:fetchAvailableModels`; preserve returned wire IDs
and restrict alias translation to known legacy names. Codex's `supported_in_api`
flag describes the public API, not subscription availability. OpenCode public catalog
models must stay grouped by plan and wire format. Never mask a failed account
lookup with a static catalog or another application's local model cache.

For the auth/discovery path, use `cargo test -p openbitfun-ai-adapters --features
subscription-auth --lib`. Device-grant timing tests use the dev-only Tokio
test clock and synthetic tokens; they do not authorize real accounts.
The existing metadata-path override defaults to a process-local memory vault.
Cross-process acceptance may explicitly select
`store::set_store_path_and_file_vault_for_test` with its own temporary path;
this uses the existing encrypted file vault, never the native OS credential
store. Its key, ciphertext, metadata and cleanup stay inside that temporary
directory. Keep ordinary test overrides memory-only and opt-in isolated.

`model_quota_observation` interprets Codex billing details into a borrowed,
model-scoped eligibility conclusion. Runtime checks its scope and freshness,
not vendor bucket/credit rules. Preserve conservative unknown and conflicting
observations. The provider regression cases are in `quota::routing_eligibility_tests`;
run the subscription-auth command below after changing those interpretations.

```bash
cargo test -p openbitfun-agent-stream
cargo test -p openbitfun-ai-adapters
cargo test --locked -p openbitfun-ai-adapters --lib client::healthcheck::tests
cargo test --locked -p openbitfun-ai-adapters --lib providers::anthropic::request::tests
cargo test -p openbitfun-ai-adapters --lib opencode_catalog
cargo test --locked -p openbitfun-ai-adapters --lib providers::opencode::tests
cargo test -p openbitfun-ai-adapters --lib models_dev::tests
cargo test -p openbitfun-ai-adapters --features image-generation --lib client::image_generation::tests
cargo test -p openbitfun-ai-adapters --features subscription-auth subscription_auth
cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib subscription_auth::request_identity::tests::
cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib client::sse::tests::
cargo test -p openbitfun-ai-adapters --lib providers::shared::tests
cargo test -p openbitfun-ai-adapters --features subscription-auth --lib providers::shared::tests
```

If stream behavior affects core integration, also run the relevant tests in
`src/crates/assembly/core/tests`.

ZCode/Grok allowance reads live in `subscription_auth::vendor_quota`.
ZCode monitoring uses the bare project key, keeps the BigModel team billing
origin and organization/project headers, and separates MCP call limits from
Coding Plan windows. Optional plan-term failures do not erase observed
allowance. Missing fields stay unknown; zero-cap ZCode limits mean unlimited.
These display observations must not gate model routing. Versioned display DTOs
are additive to existing Codex windows/details. Preserve unknown cache/display
versions and credential-epoch CAS when publishing results.

Focused allowance verification:
`cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib subscription_auth`
and `cargo test --locked -p openbitfun-core-types --lib subscription`.
Transport tests use isolated HTTP fixtures and synthetic credentials, not live
billing accounts or physical remote hosts.

OpenCode Go allowance uses the API-key-only `/zen/go/v1/usage` endpoint. Parse both
`usage.{rolling,weekly,monthly}` and the original `{rolling,weekly,monthly}Usage`
shape; retain unknown amounts and omit synthetic reset times from idle windows.
Only the official Go origin may receive the key, with redirects disabled. The
adapter receives a saved model's opaque `model:<id>` observation binding, never
stores it as a subscription slot, and never infers routing eligibility from it.
Console OAuth and Zen/public keys do not authorize this endpoint. Zen monetary
balances have no supported public API as of 2026-10-19; expose a clear unavailable
state and console link instead of scraping cookies or fabricating a balance.

Run `cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib subscription_auth::opencode_quota`.
Fixtures cover both response generations, Bearer authentication, 401/403 distinctions
and origin pinning; they do not verify a subscribed production account.

Grok OAuth billing uses `subscription_auth::vendor_quota` with the selected
account's token and CLI headers at the pinned Build billing origin. Preserve
unknown percentages, reset dates and revision-scoped caches; display meters do
not gate routing. Focused check: `cargo test --locked -p openbitfun-ai-adapters --features subscription-auth --lib subscription_auth::vendor_quota`.

A successful Grok billing response may include a current period/reset without
`creditUsagePercent`. Retain the period with unknown usage instead of reporting
a query failure or inventing zero usage. The ignored
`subscription_auth::vendor_quota::tests::live_grok_quota_diagnostic` uses
`OPENBITFUN_LIVE_GROK_ACCOUNT` and optional `OPENBITFUN_LIVE_SUBSCRIPTION_PROXY`
to verify billing and the production quota read for that exact in-app slot. It
may refresh credentials and quota cache, prints only response field names/status,
and sends no inference request. This does not verify remote-host behavior.

The image-generation filter uses synthetic HTTP credentials. The ignored Codex
probe requires a real in-app subscription login and generates a billed image;
run it explicitly only when live provider validation is needed.
