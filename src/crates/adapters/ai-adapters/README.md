# OpenBitFun AI Adapters

Shared AI protocol adapters used by both `openbitfun-core` and the installer.

This crate owns the portable AI integration layer:

- provider request building
- provider-specific message conversion
- SSE / stream parsing into provider-neutral stream contracts
- shared AI-facing transport types
- provider model discovery
- connection health checks

This crate intentionally does **not** own OpenBitFun runtime concerns such as:

- global config services
- client factories and caches
- application event systems
- agent/session orchestration

Those remain in `openbitfun-core`, which maps app config into the shared `AIConfig`
and re-exports this crate where convenient.

## Module Guide

- `client`: shared HTTP transport, retries, aggregation, health checks
- `providers`: OpenAI / Anthropic / Gemini request and discovery adapters
- `round_router`: bounded classifier HTTP calls and protocol parsing; the caller owns routing policy and context
- `stream`: provider SSE parsing into unified streaming events from `openbitfun-agent-stream`
- `tool_call_accumulator`: compatibility re-export; canonical implementation lives in `openbitfun-agent-stream`
- `types`: portable request/response/config/message types

## Design Rule

If a type or function must behave the same in both the main app and the
installer, it belongs here. If it depends on OpenBitFun runtime state or services,
it should stay outside this crate.
