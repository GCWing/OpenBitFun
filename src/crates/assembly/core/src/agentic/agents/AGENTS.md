# Agent Definitions and Tool Policy

## Tool authorization

- Registering or materializing a tool makes it available to the runtime; it does
  not authorize every Agent to use it.
- Add a tool only to the default tool lists of the modes or subagents whose
  responsibilities require it. Keep specialized tools out of shared tool lists
  unless every consumer needs them.
- Do not force tools into Agent allowlists in registry queries, policy
  resolution, or downstream catalog/execution assembly. In particular, do not
  append a tool merely because it is registered, or restore it after explicit
  mode configuration has excluded it. Preserve the existing explicit dynamic
  MCP opt-in policy; it is not a precedent for injecting built-in tools.

## Desktop tool exposure verification

Main-mode desktop defaults and explicit user exclusions:

```bash
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git,tools-computer-use --lib direct_desktop_policy_tests
```

Prompt routing and optional delegation are checked in the owning content crate:

```bash
cargo test -p openbitfun-agent-content --test prompt_catalog_contracts
# Verify the assembled mode/subagent prompts as well as their source templates:
cargo test -p openbitfun-core --no-default-features --features agent-runtime,git,tools-browser-web,tools-computer-use --lib agentic::agents::
```
