[中文](AGENTS-CN.md) | **English**

# OpenCode Adapter

The current crate owns OpenCode user Instruction path/config precedence, the static OpenCode source preview used by the existing
managed-package path, the OpenCode-specific implementations of command,
standalone-tool, subagent, and MCP provider contracts, the bounded projection of
configured local Skill roots, the private merged configuration snapshot passed
to the managed Plugin Host's Config Hook, the typed Agent/permission/Tool/Skill
projection of that Hook's result, and runtime-free mapping of
caller-normalized static-preview Hook descriptors. It preserves OpenCode source
discovery, precedence, formats, argument expansion, and versioned compatibility semantics.
Shared source catalog, lifecycle coordination, file-watch implementation,
product policy, UI, credentials, worker supervision, and final effect writes
belong elsewhere.

Product-source boundary:

- The current `load_opencode_package_adapter` entry remains static-preview only
  until OC-R1/OC-R2 replace its production role. Do not extend this P0 entry into
  another managed OpenCode package format.
- Standard OpenCode Command, standalone Tool, Subagent, and configured local
  Skill paths are current read-only live sources. Configured Skill URLs remain
  unsupported and must never be fetched. Full plugin directories and package specs
  remain target work rather than executable production sources. Source files need
  no OpenBitFun import. Low-risk declarative results follow the
  user's auto-apply/ask preference; executable sources require a source, plugin,
  and execution-domain
  decision before first import. Broader pre-import execution permissions and
  post-import contribution expansion are separate gates, not repeated approval
  for every internal lifecycle state. Code updates may prepare automatically only
  when source identity/integrity, the source update policy, and the current
  execution conditions still allow it.
- A global source preference is deduplicated by source/plugin/execution domain, but
  every activation/import recomputes its effective source graph, working
  directory/environment, credentials, and policy. Workspace participates only when
  the owning config or logical plugin instance has workspace-specific state. Raw parsing
  and exact materialization caches may be shared; physical health follows the actual
  process grouping and is not keyed globally or by workspace by default. Crossing projects alone does not prompt again;
  only broader execution permissions, credential scope, or capability does.
- `ExternalSourceControlPlane` owns candidate versions and atomic provider
  replacement. This adapter supplies OpenCode-qualified source identity/order and
  watch roots through narrow provider contracts; the reusable file-watch service
  supplies change facts. For the current package-plugin path, Core owns logical
  workspace generations and capability publication, this crate owns the typed
  Config projection, and the sibling `opencode-plugin-host` crate owns the typed
  Host wire/connection while using services process-tree primitives. The legacy
  managed-package path keeps request reliability in `PluginRuntimeClient`, and
  standalone workers remain under `ScriptToolRuntime`; do not merge these lifecycle facts.
- Effective policy and safe-start mode must be recomputed before third-party
  module import from the source, plugin identity, actual execution domain/user,
  product/organization policy bounds, credential scope, and environment scope.
  Discovery or config-import approval is not an execution decision. The product
  source experience and existing capability owners provide the source/plugin
  decision; this adapter consumes it but does not own prompts or trust state.
  After activation, the default local runtime policy is compatibility mode.
- Final tool creation, permission decisions, authoritative state, and audit facts
  stay in their tool, permission, product, and runtime owner paths.
- Standalone-tool preparation may return only a version-checked, bounded module
  for an already approved script. It must not spawn a process, install a package,
  persist approval, or interpret another ecosystem. Static import restrictions
  describe the current compatibility subset; they are not a security sandbox.
- The user's local `opencode` CLI installation is unrelated to loading
  OpenCode-compatible plugins. CLI/server interop with an installed OpenCode
  binary belongs to ACP/external-client work, not this adapter boundary.

## Boundary Rules

- Depend on stable contracts such as `openbitfun-runtime-ports` and the
  `PluginRuntimeAdapter` boundary trait, not `openbitfun-core`, app crates, Tauri
  APIs, product UI, or concrete service managers.
- Keep OpenCode config JSON, source ordering, loader compatibility, and argument
  expansion inside this crate. Cross-crate outputs use typed source snapshots,
  adapter bindings, and PluginRuntimeClient DTOs; do not expose raw OpenCode JSON
  or source syntax as product contracts.
- `local_source_paths` owns the adapter-private local source plan: user config,
  `OPENCODE_CONFIG`, project files, ordered config directories, and
  `OPENCODE_CONFIG_CONTENT`. Capability providers consume only the plan items
  they understand and retain their field-specific merge and validation rules;
  do not introduce a public generic merged OpenCode config contract. The managed
  Plugin Host may consume an adapter-private, bounded full-object merge for its
  Config Hook, including unknown OpenCode fields. Inline content is bounded,
  uses a redacted virtual source identity, has no watch root, and may resolve
  relative paths only from an explicit workspace context.
- Managed Plugin Host Config projection validates contributor attribution and
  maps only the currently consumed Agent, permission, Plugin Tool, and workspace
  Skill fields into the provider-neutral plugin capability contract. OpenCode
  contributor parsing and Tool registration conversion stay here; adapter-owned
  DTOs must not leak into generic publication. This projection must not create
  Agent runtime keys, select native Tool baselines, mutate product registries,
  or grow into a generic Config platform.
- Current source inspection recognizes only the tested declarative subset. The
  adapter may reuse the workspace-pinned parse-only OXC profile for syntax-safe static
  projection, but it is not a general JavaScript/TypeScript semantic analyzer or
  runtime. Packages with no recognized entry and recognized unsupported hooks
  must produce diagnostics; other syntax is outside the compatibility claim.
- Unsupported OpenCode capabilities must be explicit diagnostics or typed
  unsupported candidates. Do not silently ignore them.
- Public APIs require a current Product Assembly consumer, a capability-specific
  provider contract, boundary updates, and focused tests. Do not expose generic
  OpenCode JSON access or add APIs only for target-design completeness.
- Runtime-free Hook mapping accepts only the `opencode.plugins` provider and is
  consumed by the existing managed-package `.js` / `.ts` read projection. OXC may
  extract static top-level property names from the exported plugin return object;
  the adapter owns their OpenCode meaning. Mapping may emit static declarations
  and diagnostics with incomplete safety. Parse failures must remain explicit
  diagnostics, while event payload types must not be treated as Hook properties.
  This static-preview path does not load or dispatch handlers. Executable callback
  support is a separate managed Plugin Host path using the typed gateway and Core
  lifecycle owner.
- The reviewed product assembly entrypoint selects and constructs the compiled
  OpenCode adapter/provider. External-source providers and configured Skill-root
  facts are projected through `openbitfun-core/external_sources`; managed-package
  bindings are injected into PluginRuntimeClient. Product consumers do not
  import the adapter directly. The composition layer does not
  discover dynamic sources, prepare dependencies, or import plugin modules.
- Product Assembly may consume this crate only from reviewed composition modules
  such as `openbitfun-core/plugin_runtime`, `openbitfun-core/external_sources`,
  `openbitfun-core/instruction_sources`, or the OpenCode-specific
  `openbitfun-core/plugin_host` composition path; boundary
  guards and focused assembly-path tests must change with any additional consumer.
- This crate must not depend on Codex, Claude Code, or another ecosystem adapter.
  New ecosystems are sibling adapters registered by Product Assembly, not modes of
  this adapter.
- `OpenCodeInstructionSourceOptions::include_project_config` lets Product Assembly
  suppress automatic project config discovery after selecting another instruction
  family. Keep user-configured relative paths resolved against the workspace;
  this switch must not change `OPENCODE_DISABLE_PROJECT_CONFIG` path semantics.
- Production crates must not depend on `openbitfun_opencode_adapter` internals.
  Unsupported capabilities must return diagnostics or typed unsupported states
  instead of failing at runtime on external plugin content.

MCP discovery keeps V1 and V2 parsing in separate private modules. V1 uses
`mcp.<name>`, recursive field merging and a scalar timeout; V2 uses
`mcp.servers.<name>`, whole-server replacement, `disabled` and independent
startup/catalog/execution timeout defaults. Reject mixed-version layers
explicitly. Keep valid V1 servers named `servers` discoverable. Source disablement
blocks direct activation, but valid declarations remain eligible for explicit
native import; OpenBitFun source suppression and revision fencing still apply.

## Verification

- `cargo test --locked -p openbitfun-opencode-adapter --lib instruction_source::tests::`
- `cargo test -p openbitfun-opencode-adapter --test opencode_source_adapter`
- `cargo test -p openbitfun-opencode-adapter --test opencode_mcp_adapter`
- `cargo test -p openbitfun-opencode-adapter --test opencode_static_source_contracts opencode_command_adapter::`
- `cargo test -p openbitfun-opencode-adapter --test opencode_static_source_contracts opencode_subagent_adapter::`
- `cargo test -p openbitfun-opencode-adapter --test tool_source_contracts`
- `cargo test -p openbitfun-opencode-adapter --lib p0_c2_fixture`
- `cargo test -p openbitfun-opencode-adapter --lib plugin_config_projection`
- `cargo test -p openbitfun-opencode-adapter --lib client_path_projects_trusted_custom_tool_candidate_with_permission_prompt`
- `node scripts/check-core-boundaries.mjs`
