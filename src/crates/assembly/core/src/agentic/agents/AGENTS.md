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
