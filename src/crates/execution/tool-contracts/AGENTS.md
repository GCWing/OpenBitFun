# tool-contracts Agent Guide

Scope: this guide applies to `src/crates/execution/tool-contracts`.

`openbitfun-agent-tools` owns portable tool contracts. It must stay independent of
the product tool runtime.

## Guardrails

- Do not depend on `openbitfun-core`, concrete service crates,
  `tool-provider-groups`, app crates, Tauri, Git, MCP, network clients, or CLI
  UI dependencies.
- This crate may own provider-neutral tool DTOs, validation/restriction facts,
  path and artifact contracts, pure manifest/catalog/exposure helpers, result
  presentation policy, deterministic admission policy, portable tool context
  facts, runtime restriction policy shaping, and provider-neutral MCP / ACP
  external-agent tool bridge naming, validation, result, and presentation
  contracts.
- This crate may own generic provider contracts, containers, materialization,
  and registry assembly. Concrete tool construction and product runtime
  registration stay outside this crate until a reviewed owner move proves
  behavior equivalence.
- Do not move `ToolUseContext`, concrete tools, workspace services, cancellation
  tokens, code-review read receipt storage, tool-result filesystem writes,
  state update side effects, snapshot decoration, collapsed unlock state,
  product registry snapshot access, or concrete `GetToolSpecTool` execution
  here without an owner design and equivalence tests.
- Provider-specific wire serialization belongs in AI adapters, not in these
  provider-neutral contracts.
- MCP transport/client lifecycle and protocol result-content rendering stay in
  `services-integrations`; this crate owns only the model/tool bridge contract.
- ACP protocol/client lifecycle stays in `openbitfun-acp`; this crate owns only the
  external-agent tool bridge contract.
- Keep `default = []`. ACP and MCP bridges, Computer Use contracts, and element
  tokens are independent capability slices; do not combine them into a
  `full` or compatibility feature.

## Verification

```bash
cargo test --locked -p openbitfun-agent-tools --no-default-features
cargo test --locked -p openbitfun-agent-tools --no-default-features --features acp-bridge --test tool_contracts acp_external_agent_bridge_preserves_tool_contract
cargo test --locked -p openbitfun-agent-tools --no-default-features --features mcp-bridge --test tool_contracts mcp_tool_bridge
cargo test --locked -p openbitfun-agent-tools --no-default-features --features computer-use-contract --lib computer_use
cargo test --locked -p openbitfun-agent-tools --no-default-features --features element-token --lib element_token::
node scripts/check-core-boundaries.mjs
```
