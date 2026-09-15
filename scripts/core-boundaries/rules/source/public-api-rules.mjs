// Public API allowlists for contract modules where accidental surface growth is costly.

export const publicApiContractSlices = [
  'frontend-backend-capability-service',
  'openbitfun-plugin-extension-contract',
  'plugin-runtime-internal-abi',
  'opencode-adapter-boundary',
  'external-source-control-contract',
  'external-source-command-contract',
  'external-source-tool-contract',
  'external-source-subagent-contract',
  'external-source-mcp-contract',
  'external-source-pet-contract',
  'external-source-hook-contract',
  'external-source-reference-contract',
  'user-instruction-source-boundary',
  'external-integration-policy-contract',
];

export const agentRuntimeRootPublicModules = [
  'agents',
  'checkpoint',
  'compression_prefetch',
  'context_profile',
  'custom_agent',
  'custom_subagent',
  'deep_review',
  'dialog_turn',
  'event_bus',
  'event_queue',
  'event_router',
  'event_source',
  'events',
  'evidence_ledger',
  'review_read_receipt',
  'native_hooks',
  'output_surface',
  'permission',
  'post_call_hooks',
  'prompt',
  'prompt_cache',
  'prompt_markup',
  'remote_file_delivery',
  'runtime',
  'scheduled_job',
  'scheduler',
  'sdk',
  'session',
  'session_control',
  'session_state',
  'session_state_manager',
  'side_question',
  'skill_agent_snapshot',
  'skills',
  'subagent_task',
  'thread_goal',
  'thread_goal_tools',
  'turn_cancellation',
  'user_questions',
];

const contractSlices = {
  frontendBackendCapabilityService: 'frontend-backend-capability-service',
  openbitfunPluginExtension: 'openbitfun-plugin-extension-contract',
  pluginRuntimeInternalAbi: 'plugin-runtime-internal-abi',
  opencodeAdapterBoundary: 'opencode-adapter-boundary',
  externalSourceControlContract: 'external-source-control-contract',
  externalSourceCommandContract: 'external-source-command-contract',
  externalSourceToolContract: 'external-source-tool-contract',
  externalSourceSubagentContract: 'external-source-subagent-contract',
  externalSourceMcpContract: 'external-source-mcp-contract',
  externalSourcePetContract: 'external-source-pet-contract',
  externalSourceHookContract: 'external-source-hook-contract',
  externalSourceReferenceContract: 'external-source-reference-contract',
  userInstructionSourceBoundary: 'user-instruction-source-boundary',
  externalIntegrationPolicyContract: 'external-integration-policy-contract',
};

function pluginRuntimeEntry(symbol, p0, consumer, verification, contractSlice, wireImpact = true) {
  return {
    symbol,
    owner: 'runtime-ports plugin contract owner',
    consumer,
    verification,
    p0,
    contractSlice,
    wireImpact,
    rationale: `${p0} needs a stable contract symbol instead of raw JSON or product-full leakage`,
    exit: 'remove only after a reviewed compatibility migration and root re-export budget update',
  };
}

export const pluginRuntimePublicApiEntries = [
  ...[
    'PluginSourceKind',
    'PluginSourceRef',
    'PluginManifestRef',
    'PluginTrustLevel',
    'PluginStatusKind',
    'PluginStatusSnapshot',
    'PluginConfigValidationIssue',
    'PluginConfigValidationState',
    'PluginConfigValidationStatus',
  ].map((symbol) =>
    pluginRuntimeEntry(
      symbol,
      'plugin discovery, status, and config-validation projection',
      'PluginRuntimeClient read model and product assembly plugin status projection',
      'runtime-ports read-model contract tests, OpenCode fixture projection tests, and plugin-runtime-client read-model tests',
      contractSlices.openbitfunPluginExtension,
    ),
  ),
  ...[
    'PluginCapabilityRef',
    'PluginTargetRef',
    'PluginArtifactRef',
    'PluginAuditRef',
    'PluginOwnerKind',
    'PluginOwnerRef',
    'PluginDataClassification',
    'PluginPayloadRedaction',
    'PluginPayloadRef',
    'PluginRiskLevel',
    'PermissionPromptEffectKind',
    'PermissionPromptDenyState',
    'PermissionPromptDescriptor',
    'PluginRollbackMode',
    'PluginRollbackPolicy',
    'PluginPermissionGate',
    'PluginEffectCandidate',
    'PluginEffectCandidatePayload',
  ].map((symbol) =>
    pluginRuntimeEntry(
      symbol,
      'plugin permission, effect-preview, and provider handoff',
      'PluginRuntimeClient, tool ABI integration, and security-control candidate validation',
      'runtime-ports candidate-effect contract tests and plugin-runtime-client permission/effect validation tests',
      contractSlices.openbitfunPluginExtension,
    ),
  ),
  ...[
    'PluginDiagnostic',
    'PluginDiagnosticDetail',
    'PluginDiagnosticSeverity',
    'PluginQuarantineScope',
    'PluginQuarantineReason',
    'PluginQuarantineClearCondition',
    'PluginQuarantineState',
  ].map((symbol) =>
    pluginRuntimeEntry(
      symbol,
      'plugin diagnostics and quarantine read-model projection',
      'PluginRuntimeClient read model and capability-service diagnostics projection',
      'runtime-ports diagnostics tests and plugin-runtime-client quarantine/read-model owner tests',
      contractSlices.openbitfunPluginExtension,
    ),
  ),
  ...[
    'ExtensionCapabilityAvailability',
    'PluginRuntimeAvailability',
    'PluginRuntimeUnavailableReason',
    'PluginRuntimeEpochs',
    'PluginRuntimeReadRequest',
    'PluginRuntimeReadResponse',
    'PluginDispatchEnvelope',
    'PluginResponseEnvelope',
    'PluginHostLifecyclePhase',
    'PluginRuntimeClient',
    'DisabledPluginRuntimeClient',
    'ProjectionOnlyPluginRuntimeClient',
    'PluginRuntimeBinding',
    'validate_plugin_runtime_read_response',
    'validate_plugin_dispatch_response',
  ].map((symbol) =>
    pluginRuntimeEntry(
      symbol,
      'plugin runtime boundary, lifecycle facts, and execution availability',
      'Product assembly client injection and Agent Runtime plugin binding',
      'runtime-ports contract tests and plugin-runtime-client owner validation',
      contractSlices.pluginRuntimeInternalAbi,
    ),
  ),
];

export const pluginRuntimePublicApiSymbols = pluginRuntimePublicApiEntries.map(
  (entry) => entry.symbol,
);

function pluginRuntimeClientEntry(symbol, consumer) {
  return {
    symbol,
    owner: 'plugin-runtime-client owner',
    consumer,
    verification: 'plugin-runtime-client owner tests and product assembly binding checks',
    p0: 'PluginRuntimeClient executable boundary for the OpenCode-compatible P0 vertical slice',
    contractSlice: contractSlices.pluginRuntimeInternalAbi,
    wireImpact: false,
    rationale:
      'P0 execution needs a narrow injected adapter boundary without exposing concrete plugin runtimes',
    exit: 'remove only if the client implementation moves to a reviewed replacement crate with equivalent boundary tests',
  };
}

export const pluginRuntimeClientPublicApiEntries = [
  pluginRuntimeClientEntry(
    'PluginRuntimeAdapter',
    'DefaultPluginRuntimeClient::new injected adapter boundary and plugin-runtime-client owner tests',
  ),
  pluginRuntimeClientEntry(
    'DefaultPluginRuntimeClient',
    'Product Assembly runtime binding, AgentRuntimeBuilder handoff, and plugin-runtime-client contract tests',
  ),
];

function opencodeAdapterEntry(symbol, consumer) {
  return {
    symbol,
    owner: 'opencode-adapter owner',
    consumer,
    verification:
      'opencode-adapter source adapter tests, DefaultPluginRuntimeClient integration path, and core-boundary public API budget checks',
    p0: 'OpenCode-compatible P0-C.1 source discovery/read model and P0-C.2 custom tool candidate mapping',
    contractSlice: contractSlices.opencodeAdapterBoundary,
    wireImpact: false,
    rationale:
      'P0-C needs one adapter factory that consumes fixed OpenBitFun-managed package content and returns the existing PluginRuntimeAdapter boundary',
    exit:
      'remove only if source discovery moves behind a reviewed product source registry with equivalent client tests',
  };
}

function opencodeHookAdapterEntry(symbol, consumer) {
  return {
    symbol,
    owner: 'opencode-adapter static Hook source owner',
    consumer,
    verification:
      'OpenCode static Hook fixture tests, openbitfun-core catalog composition tests, and core-boundary public API budget checks',
    p0: 'runtime-free OpenCode Hook discovery and catalog projection',
    contractSlice: contractSlices.opencodeAdapterBoundary,
    wireImpact: false,
    rationale:
      'the product catalog needs one OpenCode-specific parser behind the ecosystem-neutral external Hook provider contract',
    exit:
      'remove only if OpenCode Hook discovery moves behind another reviewed adapter with equivalent redaction and fail-closed tests',
  };
}

function opencodePluginConfigProjectionEntry(symbol) {
  return {
    symbol,
    owner: 'opencode-adapter managed Plugin Host Config projection owner',
    consumer: 'openbitfun-core plugin Config publication composition root',
    verification:
      'OpenCode plugin Config projection tests, openbitfun-core publication tests, and core-boundary public API budget checks',
    p0: 'typed OpenCode Config Hook projection for the managed Plugin Host runtime slice',
    contractSlice: contractSlices.opencodeAdapterBoundary,
    wireImpact: false,
    rationale:
      'the live Plugin Host path needs OpenCode field interpretation and contributor attribution outside Product Assembly while Core retains product publication',
    exit:
      'remove only if the managed Plugin Host Config projection moves behind another reviewed OpenCode adapter boundary with equivalent attribution and fail-closed tests',
  };
}

function opencodeReferenceAdapterEntry(symbol, consumer) {
  return {
    symbol,
    owner: 'opencode-adapter workspace Reference source owner',
    consumer,
    verification:
      'OpenCode workspace Reference fixtures, openbitfun-core composition tests, and core-boundary public API budget checks',
    p0: 'runtime-free OpenCode local workspace Reference discovery',
    contractSlice: contractSlices.opencodeAdapterBoundary,
    wireImpact: false,
    rationale:
      'the product catalog needs one OpenCode-specific parser behind the ecosystem-neutral workspace Reference provider contract',
    exit:
      'remove only if OpenCode workspace Reference discovery moves behind another reviewed adapter with equivalent precedence and fail-closed tests',
  };
}

export const opencodeAdapterPublicApiEntries = [
  opencodeAdapterEntry(
    'load_opencode_package_adapter',
    'openbitfun-core managed plugin composition root and DefaultPluginRuntimeClient integration tests',
  ),
  opencodeAdapterEntry(
    'load_opencode_config_snapshot',
    'openbitfun-core live Plugin Host composition root and OpenCode config snapshot contract tests',
  ),
  opencodeAdapterEntry(
    'OpenCodeConfigSnapshot',
    'openbitfun-core live Plugin Host config input and OpenCode config snapshot contract tests',
  ),
  opencodeAdapterEntry(
    'OpenCodeConfigSnapshotError',
    'openbitfun-core live Plugin Host config validation and OpenCode config snapshot contract tests',
  ),
  ...[
    'project_plugin_config',
    'project_plugin_tool_ref',
    'OpenCodePluginConfigProjectionError',
  ].map(opencodePluginConfigProjectionEntry),
  opencodeAdapterEntry(
    'OpenCodeCommandProvider',
    'openbitfun-core external source composition root and OpenCode command adapter tests',
  ),
  opencodeAdapterEntry(
    'OpenCodeCommandProviderOptions',
    'OpenCode command adapter fixture tests and explicit environment injection',
  ),
  opencodeAdapterEntry(
    'OpenCodeConfiguredSkillRoot',
    'openbitfun-core external source composition root and OpenCode configured Skill fixtures',
  ),
  ...['OpenCodeSkillRootDiagnostic', 'OpenCodeSkillRootReport'].map((symbol) => ({
    symbol,
    owner: 'opencode-adapter configured Skill root source owner',
    consumer: 'openbitfun-core external_sources::opencode_configured_skill_roots_with_provider',
    verification:
      'opencode_static_source_contracts::opencode_skill_roots diagnostics fixtures and core-boundary public API checks',
    p0: 'runtime-free configured local Skill root discovery with bounded diagnostics',
    contractSlice: contractSlices.opencodeAdapterBoundary,
    wireImpact: false,
    rationale:
      'Product Assembly projects valid roots and redacted discovery failures into its neutral Skill scan report without exposing OpenCode configuration syntax',
    exit:
      'remove only with the configured Skill root provider or an equivalent reviewed diagnostic projection',
  })),
  opencodeAdapterEntry(
    'OpenCodeSkillRootProvider',
    'openbitfun-core external source composition root and OpenCode configured Skill fixtures',
  ),
  opencodeAdapterEntry(
    'OpenCodeSkillRootProviderOptions',
    'OpenCode configured Skill fixture tests and explicit environment injection',
  ),
  opencodeAdapterEntry(
    'OpenCodeToolProvider',
    'openbitfun-core external source composition root and OpenCode standalone-tool adapter tests',
  ),
  opencodeAdapterEntry(
    'OpenCodeToolProviderOptions',
    'OpenCode standalone-tool adapter fixture tests and explicit environment injection',
  ),
  opencodeAdapterEntry(
    'OpenCodeSubagentProvider',
    'openbitfun-core external source composition root and OpenCode subagent adapter tests',
  ),
  opencodeAdapterEntry(
    'OpenCodeSubagentProviderOptions',
    'OpenCode subagent adapter fixture tests and explicit environment injection',
  ),
  opencodeAdapterEntry(
    'OpenCodeMcpProvider',
    'openbitfun-core external source composition root and OpenCode MCP adapter tests',
  ),
  opencodeAdapterEntry(
    'OpenCodeMcpProviderOptions',
    'OpenCode MCP adapter fixture tests and explicit environment injection',
  ),
  opencodeHookAdapterEntry(
    'OpenCodeHookProvider',
    'openbitfun-core external Hook catalog composition root and OpenCode static Hook fixtures',
  ),
  opencodeHookAdapterEntry(
    'OpenCodeHookProviderOptions',
    'OpenCode static Hook fixture tests and explicit environment injection',
  ),
  opencodeReferenceAdapterEntry(
    'OpenCodeWorkspaceReferenceProvider',
    'openbitfun-core workspace Reference composition root and OpenCode adapter fixtures',
  ),
  opencodeReferenceAdapterEntry(
    'OpenCodeWorkspaceReferenceProviderOptions',
    'OpenCode workspace Reference fixtures and explicit environment injection',
  ),
  userInstructionSourceAdapterEntry('load_opencode_user_instructions', 'OpenCode'),
  userInstructionSourceAdapterEntry('OpenCodeInstructionSourceOptions', 'OpenCode'),
];

function staticHookAdapterEntry(symbol, owner, consumer) {
  return {
    symbol,
    owner,
    consumer,
    verification: 'ecosystem Hook fixtures and core-boundary public API budget checks',
    p0: 'runtime-free static Hook discovery',
    contractSlice: contractSlices.externalSourceHookContract,
    wireImpact: false,
    rationale: 'the source adapter needs one narrow, redacted static-inspection surface',
    exit: 'remove only with the corresponding static Hook source adapter',
  };
}

function staticSourceSupportEntry(symbol) {
  return {
    symbol,
    owner: 'static-hook-support bounded source utility owner',
    consumer: 'reviewed OpenCode, Claude Code, and Codex declarative source adapters',
    verification:
      'bounded path and redaction unit tests, ecosystem adapter fixtures, and core-boundary public API budget checks',
    p0: 'runtime-free bounded static external-source discovery',
    contractSlice: contractSlices.externalSourceControlContract,
    wireImpact: false,
    rationale:
      'sibling declarative adapters need one narrow implementation for canonical containment and public executable redaction',
    exit:
      'remove only if every reviewed consumer moves to an equivalent shared bounded-source owner',
  };
}

function commonExternalSubagentToolMappingEntry(symbol) {
  return {
    symbol,
    owner: 'static-hook-support shared declarative source adapter utility owner',
    consumer: 'reviewed OpenCode and Claude Code declarative subagent adapters',
    verification:
      'shared mapping unit tests, ecosystem subagent adapter fixtures, and core-boundary public API budget checks',
    p0: 'runtime-free common external Agent tool capability normalization',
    contractSlice: contractSlices.externalSourceControlContract,
    wireImpact: false,
    rationale:
      'sibling declarative adapters need one static mapping while provider-specific aliases remain adapter-owned',
    exit:
      'remove only if every reviewed consumer moves to an equivalent adapter-layer mapping owner',
  };
}

function declarativeSourceAdapterEntry(
  symbol,
  owner,
  consumer,
  capability,
  contractSlice,
) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      `${capability} adapter fixtures, openbitfun-core composition tests, and core-boundary public API budget checks`,
    p0: `runtime-free ${capability} discovery and ecosystem-neutral catalog projection`,
    contractSlice,
    wireImpact: false,
    rationale:
      `the product catalog needs one ecosystem-specific parser behind the ${capability} provider contract`,
    exit:
      `remove only if ${capability} discovery moves behind another reviewed adapter with equivalent fail-closed tests`,
  };
}

function userInstructionSourceAdapterEntry(symbol, ecosystem) {
  return {
    symbol,
    owner: `${ecosystem} adapter user Instruction source owner`,
    consumer: 'openbitfun-core instruction_sources composition root',
    verification:
      `${ecosystem} user Instruction fixtures, openbitfun-core prompt composition tests, and core-boundary public API budget checks`,
    p0: 'runtime-free local user Instruction source discovery',
    contractSlice: contractSlices.userInstructionSourceBoundary,
    wireImpact: false,
    rationale:
      'ecosystem-specific user file precedence belongs in its adapter while Product Assembly owns cross-ecosystem order',
    exit:
      'remove only if the ecosystem source semantics move behind an equivalent reviewed adapter boundary',
  };
}

function userInstructionSourceServiceEntry(symbol) {
  return {
    symbol,
    owner: 'services-core bounded local user Instruction file owner',
    consumer: 'reviewed OpenCode, Claude Code, and Codex adapters plus openbitfun-core prompt composition',
    verification:
      'services-core bounded file tests, ecosystem Instruction fixtures, prompt composition tests, and core-boundary public API checks',
    p0: 'runtime-free bounded local user Instruction reads and accumulation',
    contractSlice: contractSlices.userInstructionSourceBoundary,
    wireImpact: false,
    rationale:
      'sibling adapters need one canonical, bounded file implementation while raw content stays inside backend prompt composition',
    exit:
      'remove only if every reviewed adapter migrates to an equivalent bounded local source owner',
  };
}

export const userInstructionSourceServicePublicApiEntries = [
  'MAX_LOCAL_INSTRUCTION_FILE_BYTES',
  'MAX_LOCAL_INSTRUCTION_FILES',
  'MAX_LOCAL_INSTRUCTION_TOTAL_BYTES',
  'LocalInstructionFile',
  'LocalInstructionFiles',
  'local_instruction_path_exists',
  'read_local_instruction_file',
  'read_local_text_file',
].map(userInstructionSourceServiceEntry);

export const claudeCodeAdapterPublicApiEntries = [
  'ClaudeCodeHookProvider',
  'ClaudeCodeHookProviderOptions',
].map((symbol) => staticHookAdapterEntry(
  symbol,
  'claude-code-adapter static Hook owner',
  'openbitfun-core composition root and Claude Code Hook fixtures',
)).concat([
  ['ClaudeCodeCommandProvider', 'command', contractSlices.externalSourceCommandContract],
  ['ClaudeCodeCommandProviderOptions', 'command', contractSlices.externalSourceCommandContract],
  ['ClaudeCodeSubagentProvider', 'subagent', contractSlices.externalSourceSubagentContract],
  ['ClaudeCodeSubagentProviderOptions', 'subagent', contractSlices.externalSourceSubagentContract],
  ['ClaudeCodeMcpProvider', 'MCP', contractSlices.externalSourceMcpContract],
  ['ClaudeCodeMcpProviderOptions', 'MCP', contractSlices.externalSourceMcpContract],
].map(([symbol, capability, contractSlice]) => declarativeSourceAdapterEntry(
  symbol,
  'claude-code-adapter declarative source owner',
  `openbitfun-core composition root and Claude Code ${capability} fixtures`,
  capability,
  contractSlice,
))).concat([
  'load_claude_code_user_instructions',
  'ClaudeCodeInstructionSourceOptions',
].map((symbol) => userInstructionSourceAdapterEntry(symbol, 'Claude Code')));

export const codexAdapterPublicApiEntries = [
  'CodexHookProvider',
  'CodexHookProviderOptions',
].map((symbol) => staticHookAdapterEntry(
  symbol,
  'codex-adapter static Hook owner',
  'openbitfun-core composition root and Codex Hook fixtures',
)).concat([
  ['CodexSubagentProvider', 'subagent', contractSlices.externalSourceSubagentContract],
  ['CodexSubagentProviderOptions', 'subagent', contractSlices.externalSourceSubagentContract],
  ['CodexMcpProvider', 'MCP', contractSlices.externalSourceMcpContract],
  ['CodexMcpProviderOptions', 'MCP', contractSlices.externalSourceMcpContract],
].map(([symbol, capability, contractSlice]) => declarativeSourceAdapterEntry(
  symbol,
  'codex-adapter declarative source owner',
  `openbitfun-core composition root and Codex ${capability} fixtures`,
  capability,
  contractSlice,
))).concat([
  'load_codex_user_instructions',
  'CodexInstructionSourceOptions',
].map((symbol) => userInstructionSourceAdapterEntry(symbol, 'Codex'))).concat(['pet_source_root', 'builtin_pet_sources', 'BuiltinPetCatalog', 'BuiltinPetSource'].map((symbol) => ({
  symbol,
  owner: 'Codex adapter static pet source owner',
  consumer: 'openbitfun-core external source composition facade',
  verification: 'Codex pet source fixtures, installed bundle smoke test, and services-core pet package tests',
  p0: 'local custom and bundled pet source discovery without execution or installation',
  contractSlice: contractSlices.externalSourcePetContract,
  wireImpact: false,
  rationale: 'the adapter translates Codex package metadata; portable services own bounded resource IO and native copying',
  exit: 'remove only when an equivalent typed pet source provider owns this root',
})));

export const staticHookSupportPublicApiEntries = [
  // Shared by DSH/PI only for validated, redacted source/event construction.
  'StaticHookCatalog',
  'BoundedFileRead',
  'read_bounded_file',
  'regular_file_exists',
  'bounded_project_ancestors',
  'StaticHookDocumentFormat',
  'StaticHookHandlerRule',
  'StaticHookParseIssue',
  'StaticHookHandlerFact',
  'StaticHookParseResult',
  'redacted_parse_content_version',
  'parse_hook_document',
].map((symbol) => staticHookAdapterEntry(
  symbol,
  'static-hook-support parser owner',
  'OpenCode, Claude Code, Codex, DeepSeek Harness, and PI static Hook source adapters',
)).concat([
  'PreparedStaticHookCommand',
  'StaticHookAssetError',
  'importable_hook_matcher',
  'required_hook_string',
  'optional_hook_string',
  'optional_positive_hook_u64',
  'prepare_static_hook_command',
  'StaticHookVisitSummary',
  'StaticHookHandlerRef',
  'visit_hook_document',
  'static_hook_handler_fact',
].map((symbol) => staticHookAdapterEntry(
  symbol,
  'static-hook-support command import owner',
  'Claude Code and Codex command Hook adapters',
))).concat([
  'BoundedFileResolveError',
  'resolve_bounded_regular_file',
  'redacted_executable_preview',
  'BoundedTextRead',
  'read_bounded_text',
  'BoundedDirectoryWalkLimits',
  'BoundedDirectoryWalkLimit',
  'BoundedDirectoryWalkError',
  'collect_bounded_regular_files',
].map(staticSourceSupportEntry)).concat([
  'common_external_subagent_tool_capability',
].map(commonExternalSubagentToolMappingEntry));

function externalHookContractEntry(symbol, owner, consumer, wireImpact = false) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'product-domain Hook contract tests, ecosystem adapter fixtures, catalog coordinator tests, and core-boundary checks',
    p0: 'runtime-free external Hook contribution and catalog contracts',
    contractSlice: contractSlices.externalSourceHookContract,
    wireImpact,
    rationale:
      'static Hook inspection needs typed, redacted identities and safety facts without runtime or ecosystem payload coupling',
    exit:
      'remove only through a reviewed Hook contract migration with equivalent redaction and fail-closed mapping tests',
  };
}

export const externalHookContractPublicApiEntries = [
  'ExternalHookContributionId',
  'ExternalHookPoint',
  'ExternalHookRiskCapability',
  'ExternalHookSafetyDeclaration',
  'ExternalHookContributionDeclaration',
].map((symbol) =>
  externalHookContractEntry(
    symbol,
    'product-domains external Hook contract owner',
    'OpenCode managed-package read projection through source_adapter::read_diagnostics',
  ),
);

export const pluginCapabilityProjectionPublicApiEntries = [
  'PluginContributorIdentity',
  'PluginToolRef',
  'PluginAgentProjection',
  'PluginSkillRootContribution',
  'PluginCapabilityProjection',
].map((symbol) => ({
  symbol,
  owner: 'product-domains plugin capability projection contract owner',
  consumer: 'ecosystem plugin adapters and openbitfun-core capability publication',
  verification:
    'product-domain projection contract tests, OpenCode projection tests, openbitfun-core publication tests, and core-boundary checks',
  p0: 'provider-neutral Agent, Tool, and Skill contributions from executable plugin adapters',
  contractSlice: contractSlices.openbitfunPluginExtension,
  wireImpact: false,
  rationale:
    'sibling executable plugin adapters need one typed contribution shape without sharing source formats, Host protocols, or lifecycle',
  exit:
    'remove only through a reviewed capability-publication migration with equivalent owner isolation and adapter-boundary tests',
}));

export const externalHookCatalogPublicApiEntries = [
  'EXTERNAL_HOOK_CATALOG_SCHEMA_V1',
  'ExternalHookSourceKind',
  'ExternalHookHandlerKind',
  'ExternalHookProjectionStatus',
  'ExternalHookNativeActivation',
  'ExternalHookMatcherSummary',
  'ExternalHookMapping',
  'ExternalHookProviderIdentity',
  'ExternalHookSource',
  'ExternalHookCatalogEntry',
  'ExternalHookProviderSnapshot',
  'ExternalHookSourceProvider',
  'ExternalHookCatalogSnapshotV1',
].map((symbol) =>
  externalHookContractEntry(
    symbol,
    'product-domains external Hook catalog contract owner',
    'ecosystem Hook source adapters, external-sources catalog coordinator, openbitfun-core, and read-only product surfaces',
    true,
  ),
);

function externalSourceEntry(symbol, owner, consumer, wireImpact = false) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'external source contract tests, fake-provider coordinator tests, OpenCode command fixtures, and CLI/Desktop product tests',
    p0: 'PR1 ecosystem-neutral source catalog and OpenCode prompt-command vertical slice',
    contractSlice: contractSlices.externalSourceCommandContract,
    wireImpact,
    rationale:
      'PR1 needs typed capability contracts and provider-neutral lifecycle coordination without ecosystem payload leakage',
    exit: 'remove only through a reviewed capability-contract migration with equivalent isolation and product tests',
  };
}

function externalSourceControlEntry(symbol, owner, consumer, wireImpact = true) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'product-domain control contract tests, core safe-mode and generation tests, and Desktop, TUI, Peer Host, Server, and Web control tests',
    p0: 'PR1 unified external source control plane and cross-host Safe Mode vertical slice',
    contractSlice: contractSlices.externalSourceControlContract,
    wireImpact,
    rationale:
      'cross-host control needs versioned lifecycle facts and closed actions without leaking capability payloads or ecosystem-specific types',
    exit:
      'remove only through a reviewed cross-host control migration with equivalent schema validation, safety, and host behavior tests',
  };
}

function externalIntegrationPolicyEntry(
  symbol,
  owner = 'product-domains external integration policy contract owner',
  consumer = 'openbitfun-core product composition and cross-host product surfaces',
  wireImpact = true,
) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'external integration policy contract tests, core policy lifecycle tests, cross-host route tests, and Web policy-control tests',
    p0: 'host-owned external integration policy and OpenCode-compatible product defaults',
    contractSlice: contractSlices.externalIntegrationPolicyContract,
    wireImpact,
    rationale:
      'all product surfaces need one ecosystem-neutral, versioned, fail-closed policy contract while concrete ecosystem defaults remain in product assembly',
    exit:
      'remove only through a reviewed policy-contract migration with equivalent compatibility, safety-ceiling, and cross-host behavior tests',
  };
}

export const externalIntegrationPolicyPublicApiEntries = [
  'EXTERNAL_INTEGRATION_POLICY_SCHEMA_MAJOR',
  'ExternalIntegrationMode',
  'ExternalIntegrationAccess',
  'ExternalEcosystemPolicy',
  'ExternalIntegrationPolicySettings',
  'ExternalIntegrationPolicySettingsView',
  'ExternalEcosystemPolicyOverride',
  'ExternalEcosystemPolicyOverrideView',
  'ExternalIntegrationPolicyOverride',
  'ExternalIntegrationPolicyOverrideView',
  'ExternalIntegrationPolicyDocument',
  'ExternalIntegrationCapabilityDescriptor',
  'ExternalIntegrationEcosystemDescriptor',
  'ExternalEcosystemPolicyView',
  'EffectiveExternalEcosystemPolicy',
  'EffectiveExternalIntegrationPolicy',
  'ExternalIntegrationPolicyStatus',
  'ExternalIntegrationPolicySnapshot',
  'ExternalIntegrationPolicyScope',
  'ExternalIntegrationPolicyOperation',
  'ExternalIntegrationPolicyMutation',
  'evaluate_external_integration_policy',
  'external_integration_policy_snapshot',
  'incompatible_external_integration_policy_snapshot',
].map((symbol) => externalIntegrationPolicyEntry(symbol)).concat({
  ...externalIntegrationPolicyEntry(
    'automatic_discovery_enabled',
    'product-domains external integration policy contract owner',
    'openbitfun-core discovery catalog preference evaluation',
    false,
  ),
  verification: 'external_source_contracts legacy discovery preference, scope precedence, and old-reader round-trip tests',
  rationale: 'resolve the independently persisted discovery preference with legacy fallback without changing runtime authorization',
});

function externalDiscoveryEntry(symbol, owner, consumer) {
  return {
    ...externalSourceControlEntry(symbol, owner, consumer),
    verification: 'external_source_contracts policy compatibility tests, core automatic_discovery tests, and ExternalSourcesAPI version negotiation tests',
    p0: 'independent automatic discovery and retained read-only ecosystem catalog',
    rationale: 'Desktop and CLI peer host adapters need a negotiated discovery view without changing the existing runtime snapshot or execution policy',
    exit: 'remove only through a compatible discovery-view migration that preserves old-host fallback and runtime-policy isolation',
  };
}

function externalToolEntry(symbol, owner, consumer, wireImpact = false) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'external tool contract, coordinator, OpenCode adapter, worker runtime, core routing, CLI, and Desktop tests',
    p0: 'PR2 ecosystem-neutral standalone-tool activation and OpenCode JavaScript vertical slice',
    contractSlice: contractSlices.externalSourceToolContract,
    wireImpact,
    rationale:
      'PR2 needs typed preview, approval, conflict, activation, and preparation contracts without ecosystem payload leakage',
    exit: 'remove only through a reviewed tool-capability contract migration with equivalent isolation and product tests',
  };
}

function externalSubagentEntry(symbol, owner, consumer, wireImpact = false) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'external subagent contract, coordinator, OpenCode, Claude Code, and Codex adapters, product reconciliation, registry lease, TUI, Desktop, and Web tests',
    p0: 'ecosystem-neutral fresh subagent activation and declarative model binding vertical slice',
    contractSlice: contractSlices.externalSourceSubagentContract,
    wireImpact,
    rationale:
      'PR3 needs typed discovery, approval-envelope, conflict, summary, and fresh-invocation contracts without ecosystem payload leakage',
    exit:
      'remove only through a reviewed subagent-capability contract migration with equivalent fail-closed routing and product tests',
  };
}

function externalMcpEntry(symbol, owner, consumer, wireImpact = false) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'external MCP contract, coordinator, OpenCode adapter, MCP owner lifecycle, TUI, Desktop, and Web tests',
    p0: 'PR6 ecosystem-neutral MCP source activation and OpenCode MCP configuration vertical slice',
    contractSlice: contractSlices.externalSourceMcpContract,
    wireImpact,
    rationale:
      'PR6 needs typed static discovery, versioned approval, conflict, preparation, and runtime status contracts without OpenCode or MCP-owner payload leakage',
    exit:
      'remove only through a reviewed MCP source contract migration with equivalent fail-closed activation and lifecycle tests',
  };
}

function externalReferenceEntry(symbol, owner, consumer, wireImpact = false) {
  return {
    symbol,
    owner,
    consumer,
    verification:
      'workspace Reference contract, coordinator, OpenCode adapter, product composition, Desktop, and Web tests',
    p0: 'runtime-free named local workspace Reference discovery and native-first product projection',
    contractSlice: contractSlices.externalSourceReferenceContract,
    wireImpact,
    rationale:
      'workspace Reference discovery needs typed provider facts and one product projection without granting filesystem permissions or leaking ecosystem payloads',
    exit:
      'remove only through a reviewed workspace Reference contract migration with equivalent precedence, policy, remote, and permission-boundary tests',
  };
}

export const workspaceReferenceContractPublicApiEntries = [
  'ExternalWorkspaceReferenceProviderIdentity',
  'ExternalWorkspaceReferenceDefinition',
  'ExternalWorkspaceReferenceProviderSnapshot',
  'ExternalWorkspaceReferenceSourceProvider',
  'WorkspaceReferenceOrigin',
  'WorkspaceReferenceCatalogEntry',
  'WorkspaceReferenceSnapshot',
].map((symbol) =>
  externalReferenceEntry(
    symbol,
    'product-domains workspace Reference contract owner',
    'OpenCode provider, external-sources coordinator, openbitfun-core composition, and Desktop/Web workspace surfaces',
    true,
  ),
);

export const externalSourceContractPublicApiEntries = [
  'ExternalSourceContractError',
  'SourceKey',
  'SourceQualifiedCommandId',
  'ExternalSourceScope',
  'ExternalSourceHealth',
  'ExternalSourceAssetKind',
  'ExternalSourceDiagnosticSeverity',
  'ExternalSourceDiagnostic',
  'ExternalSourceRecord',
  'PromptCommandAvailability',
  'PromptCommandDefinition',
  'PromptCommandExecutionTarget',
  'ExpandedPromptCommand',
  'PromptCommandExpansion',
  'PromptCommandShellPreference',
  'PromptCommandShellReviewMode',
  'PromptCommandShellReviewDecision',
  'PromptCommandShellReviewPlan',
  'PromptCommandInvocationOutcome',
  'PromptCommandShellInvocation',
  'PromptCommandShellExpansion',
  'PromptCommandProviderIdentity',
  'PromptCommandProviderSnapshot',
  'ExternalSourceContext',
  'ExternalWatchRoot',
  'ExternalSourceProviderError',
  'ExternalSourceOperationErrorCode',
  'ExternalSourceOperationError',
  'ExternalSourceOperationResult',
  'PromptCommandSourceProvider',
  'ExternalSourceLifecycleState',
  'ExternalSourceCatalogEntry',
  'PromptCommandCatalogEntry',
  'PromptCommandConflictCandidate',
  'PromptCommandConflict',
  'prompt_command_conflict_key',
  'native_prompt_command_conflict_key',
  'native_prompt_command_group_fingerprint',
  'NativePromptCommandDescriptor',
  'NativePromptCommandConflictProjection',
  'NativePromptCommandReconfirmationProjection',
  'NativePromptCommandConflictSnapshot',
  'ExternalSourceCatalogSnapshot',
  'ExternalPromptCommandDefinitionSummary',
  'ExternalPromptCommandSummary',
  'ExternalSourcePublicSnapshot',
  'ExternalSourceConflictPreferences',
  'ExternalSourceHostCapabilities',
].map((symbol) =>
  externalSourceEntry(
    symbol,
    'product-domains external source contract owner',
    'ecosystem command providers, external-source coordinator, product composition, and neutral product surfaces',
    true,
  ),
).concat(
  externalDiscoveryEntry(
    'ExternalSourceDiscoverySnapshotV1',
    'product-domains external source discovery contract owner',
    'openbitfun-core discovery catalog and Desktop and CLI peer host discovery responses',
  ),
  [
    'SourceQualifiedToolTargetId',
    'SourceQualifiedToolId',
    'ExternalToolRuntimeKind',
    'ExternalToolCapability',
    'ExternalToolStaticStatus',
    'ExternalToolDefinition',
    'external_tool_approval_key',
    'external_tool_conflict_key',
    'external_tool_decision_key',
    'ExternalToolProviderIdentity',
    'ExternalToolProviderSnapshot',
    'PreparedExternalToolExport',
    'PreparedExternalToolTarget',
    'ExternalToolSourceProvider',
    'ExternalToolActivationState',
    'ExternalToolCatalogEntry',
    'ExternalToolApprovalRequest',
    'ExternalToolConflictCandidateKind',
    'ExternalToolConflictCandidate',
    'ExternalToolConflict',
  ].map((symbol) =>
    externalToolEntry(
      symbol,
      'product-domains external tool contract owner',
      'ecosystem tool providers, external-tool coordinator, product composition, and neutral product surfaces',
      true,
    ),
  ),
  [
    'SourceQualifiedMcpServerId',
    'ExternalMcpTransportKind',
    'ExternalMcpStaticStatus',
    'ExternalMcpTimeouts',
    'MAX_EXTERNAL_MCP_TIMEOUT_MS',
    'ExternalMcpServerDefinition',
    'ExternalMcpActivationState',
    'ExternalMcpCatalogEntry',
    'ExternalMcpApprovalRequest',
    'ExternalMcpConflictCandidate',
    'ExternalMcpConflict',
    'SecretValue',
    'PreparedExternalMcpTransport',
    'PreparedExternalMcpServer',
    'PreparedExternalMcpImportTransport',
    'PreparedExternalMcpImportServer',
    'EXTERNAL_MCP_IMPORT_SCHEMA_V1',
    'ExternalMcpImportDispositionV1',
    'ExternalMcpImportPlanItemV1',
    'ExternalMcpImportPlanV1',
    'ExternalMcpImportSelectionV1',
    'ExternalMcpImportApplyRequestV1',
    'ExternalMcpImportedItemV1',
    'ExternalMcpImportApplyOutcomeV1',
    'ExternalMcpImportApplyResultV1',
    'ExternalMcpProviderIdentity',
    'ExternalMcpProviderSnapshot',
    'ExternalMcpSourceProvider',
    'ExternalMcpRevisionKey',
    'external_mcp_approval_key',
    'external_mcp_conflict_key',
    'ExternalMcpDiscoveryInput',
  ].map((symbol) =>
    externalMcpEntry(
      symbol,
      'product-domains external MCP contract owner',
      'ecosystem MCP providers, external-MCP coordinator, product reconciliation, and MCP runtime owner',
      true,
    ),
  ),
);

export const externalSourceControlPublicApiEntries = [
  'EXTERNAL_SOURCE_CONTROL_SCHEMA_V1',
  'ExternalSourceOperationStage',
  'ExternalSourceRecoveryActionV1',
  'ExternalSourceDiscoveryState',
  'ExternalSourceDesiredState',
  'ExternalSourceReviewState',
  'ExternalSourceRuntimeState',
  'ExternalSourceSupportState',
  'ExternalSourceEffectiveStatus',
  'ExternalCapabilityKindV1',
  'ExternalSourceControlSourceV1',
  'ExternalCapabilityControlV1',
  'ExternalSourceControlSnapshotV1',
  'ExternalSourceSurfaceSnapshotV1',
  'ExternalSourceControlActionV1',
  'ExternalSourceControlRequestV1',
].map((symbol) =>
  externalSourceControlEntry(
    symbol,
    'product-domains external source control contract owner',
    'openbitfun-core control composition and neutral Desktop, TUI, Peer Host, Server, and Web surfaces',
  ),
);

export const externalSubagentContractPublicApiEntries = [
  'ExternalSubagentLocalId',
  'ExternalSubagentCandidateId',
  'ExternalSubagentBehaviorVersion',
  'SecretText',
  'ExternalSubagentContributionId',
  'ExternalSubagentContributionRole',
  'ExternalSubagentProvenanceRef',
  'ExternalSubagentProviderIdentity',
  'ExternalSubagentMode',
  'ExternalSubagentModelRequest',
  'ExternalSubagentModelProfileRequest',
  'ExternalSubagentModelBindingTarget',
  'ExternalSubagentModelBindingMethod',
  'ExternalSubagentModelBindingOption',
  'ExternalSubagentModelBindingGroup',
  'ExternalSubagentToolCapability',
  'ExternalSubagentToolSelector',
  'ExternalSubagentToolRequest',
  'ExternalSubagentCompatibilityState',
  'ExternalSubagentDefinition',
  'ExternalSubagentDiscoveryInput',
  'ExternalSubagentProviderSnapshot',
  'ExternalSubagentSourceProvider',
  'ExternalSubagentActivationState',
  'ExternalSubagentDiagnosticSummary',
  'ExternalSubagentSummary',
  'ExternalSubagentConflictCandidate',
  'ExternalSubagentConflict',
  'external_subagent_candidate_id',
  'external_subagent_approval_key',
  'external_subagent_conflict_key',
  'external_subagent_model_binding_key',
].map((symbol) =>
  externalSubagentEntry(
    symbol,
    'product-domains external subagent contract owner',
    'ecosystem subagent providers, external-subagent coordinator, product reconciliation, and neutral product surfaces',
    true,
  ),
);

export const externalSourceCoordinatorPublicApiEntries = [
  ...['ExternalSourceControlPlane', 'DeferredDiscovery', 'DiscoveryBatch'].map((symbol) =>
    externalSourceControlEntry(
      symbol,
      'external-sources assembly control-plane owner',
      'openbitfun-core bounded capability discovery and deferred-completion scheduler',
      false,
    ),
  ),
  externalSourceEntry(
    'ExternalSourceCoordinator',
    'external-sources assembly owner',
    'openbitfun-core product composition root',
  ),
  externalHookContractEntry(
    'ExternalHookCatalogCoordinator',
    'external-sources Hook catalog coordinator owner',
    'openbitfun-core local-workspace Hook catalog service',
  ),
  externalHookContractEntry(
    'ExternalHookDiscoveryResult',
    'external-sources Hook discovery scheduler owner',
    'openbitfun-core local-workspace Hook catalog service',
  ),
  ...['ExternalSourceDiscoveryRequest', 'ExternalSourceDiscoveryResult'].map((symbol) =>
    externalSourceEntry(
      symbol,
      'external-sources assembly owner',
      'openbitfun-core bounded concurrent provider scheduler',
    ),
  ),
  ...[
    'ExternalToolCoordinator',
    'ExternalToolCoordinatorSnapshot',
    'ExternalToolDiscoveryRequest',
    'ExternalToolDiscoveryResult',
  ].map((symbol) =>
    externalToolEntry(
      symbol,
      'external-sources assembly owner',
      'openbitfun-core bounded concurrent external-tool provider scheduler',
    ),
  ),
  ...[
    'ExternalSubagentCoordinator',
    'ExternalSubagentCoordinatorSnapshot',
    'ExternalSubagentDiscoveryRequest',
    'ExternalSubagentDiscoveryResult',
  ].map((symbol) =>
    externalSubagentEntry(
      symbol,
      'external-sources assembly owner',
      'openbitfun-core bounded concurrent external-subagent provider scheduler',
    ),
  ),
  ...[
    'ExternalMcpCoordinator',
    'ExternalMcpCoordinatorSnapshot',
    'ExternalMcpDiscoveryRequest',
    'ExternalMcpDiscoveryResult',
  ].map((symbol) =>
    externalMcpEntry(
      symbol,
      'external-sources assembly owner',
      'openbitfun-core bounded concurrent external-MCP provider scheduler',
    ),
  ),
  ...[
    'ExternalWorkspaceReferenceCoordinator',
    'ExternalWorkspaceReferenceCoordinatorSnapshot',
    'ExternalWorkspaceReferenceDiscoveryRequest',
    'ExternalWorkspaceReferenceDiscoveryResult',
  ].map((symbol) =>
    externalReferenceEntry(
      symbol,
      'external-sources workspace Reference coordinator owner',
      'openbitfun-core bounded concurrent workspace Reference provider scheduler',
    ),
  ),
];

export const externalSourceCorePublicApiEntries = [
  ...[
    'ExternalSourceDiscoverySnapshotV1',
    'external_source_discovery_snapshot',
  ].map((symbol) => externalDiscoveryEntry(
    symbol,
    'openbitfun-core read-only discovery catalog composition facade',
    'Desktop and CLI peer host get_external_source_discovery_snapshot adapters',
  )),
  ...[
    'ExternalCapabilityKindV1',
    'ExternalSourceControlActionV1',
    'ExternalSourceControlRequestV1',
    'ExternalSourceControlSnapshotV1',
    'ExternalSourceRuntimeState',
    'ExternalSourceSurfaceSnapshotV1',
    'EXTERNAL_SOURCE_CONTROL_SCHEMA_V1',
    'get_external_source_control_snapshot',
    'apply_external_source_control_action',
  ].map((symbol) =>
    externalSourceControlEntry(
      symbol,
      'openbitfun-core external source control composition facade',
      'OpenBitFun CLI, Desktop, Server, Peer Host, and Web API adapters',
    ),
  ),
  ...[
    'ExternalIntegrationAccess',
    'ExternalIntegrationMode',
    'ExternalIntegrationPolicyMutation',
    'ExternalIntegrationPolicyOperation',
    'ExternalIntegrationPolicyScope',
    'EffectiveExternalIntegrationPolicy',
    'ExternalIntegrationPolicySnapshot',
    'ExternalIntegrationPolicyStatus',
    'EcosystemId',
    'ExternalIntegrationCapabilityId',
    'EXTERNAL_CAPABILITY_COMMAND',
    'EXTERNAL_CAPABILITY_TOOL',
    'EXTERNAL_CAPABILITY_SUBAGENT',
    'EXTERNAL_CAPABILITY_MCP',
    'EXTERNAL_CAPABILITY_REFERENCE',
    'update_external_integration_policy',
  ].map((symbol) =>
    externalIntegrationPolicyEntry(
      symbol,
      'openbitfun-core external integration policy composition facade',
      'OpenBitFun CLI, Desktop, Server, Peer Host, and Web API adapters',
      true,
    ),
  ),
  ...[
    'ExpandedPromptCommand',
    'ExternalSourceCatalogEntry',
    'ExternalSourceCatalogSnapshot',
    'ExternalSourceAssetKind',
    'ExternalSourceDiagnostic',
    'ExternalSourceDiagnosticSeverity',
    'ExternalSourceLifecycleState',
    'ExternalSourceHostCapabilities',
    'ExternalSourceOperationError',
    'ExternalSourceOperationErrorCode',
    'ExternalSourceOperationResult',
    'PromptCommandAvailability',
    'PromptCommandCatalogEntry',
    'PromptCommandDefinition',
    'PromptCommandExecutionTarget',
    'PromptCommandInvocationOutcome',
    'PromptCommandShellReviewDecision',
    'PromptCommandShellReviewMode',
    'PromptCommandShellReviewPlan',
    'SourceKey',
    'prompt_command_conflict_key',
    'native_prompt_command_conflict_key',
    'NativePromptCommandDescriptor',
    'NativePromptCommandConflictProjection',
    'NativePromptCommandReconfirmationProjection',
    'NativePromptCommandConflictSnapshot',
    'native_prompt_command_conflicts',
    'instruction_source_catalog',
    'external_pet_source_root',
    'external_builtin_pet_sources',
    'ExternalBuiltinPetCatalog',
    'InstructionSourceCatalog',
    'set_native_prompt_command_conflict_choice',
    'external_source_conflict_choices',
    'set_external_prompt_command_conflict_choice',
    'external_source_snapshot',
    'external_source_read_only_snapshot',
    'ensure_external_source_workspace_snapshot',
    'set_external_source_enabled',
    'expand_external_prompt_command',
    'sanitize_external_source_operation_error',
    'subscribe_external_source_updates',
    'ExternalSourceSubscription',
    'ExternalSourcePublicSnapshot',
  ].map((symbol) =>
    externalSourceEntry(
      symbol,
      'openbitfun-core external source composition facade',
      'OpenBitFun CLI and desktop host APIs',
    ),
  ),
  externalReferenceEntry(
    'workspace_reference_snapshot',
    'openbitfun-core workspace Reference composition facade',
    'Desktop and Web workspace directory surfaces',
    true,
  ),
  externalSourceEntry(
    'external_source_location_for_host_action',
    'openbitfun-core external source composition owner',
    'Desktop external-source configuration host adapter',
    true,
  ),
  {
    symbol: 'ecosystem_for_imported_mcp_candidate',
    owner: 'openbitfun-core external MCP provider registration composition',
    consumer: 'Desktop MCP list projection for legacy native import receipts',
    verification: 'core imported_mcp_legacy_receipt_keeps_registered_origin_without_discovery test',
    p0: 'preserve source identity for existing native MCP imports',
    contractSlice: contractSlices.externalSourceMcpContract,
    wireImpact: false,
    rationale:
      'resolve an optional ecosystem id from registered provider identity without discovery, runtime activation, or adapter types in the host API',
    exit:
      'remove when legacy import receipts no longer need source identity resolution or an owner replacement preserves offline provenance',
  },
  ...[
    'unacknowledged_external_ecosystems',
    'acknowledge_external_ecosystems',
  ].map((symbol) => ({
    symbol,
    owner: 'openbitfun-core external source composition facade',
    consumer: 'Desktop external-source host adapter and Web settings navigation',
    verification:
      'core acknowledgement persistence and execution-domain scoping tests, Desktop command contract tests, and Web settings awareness tests',
    p0: 'first-discovery notification for external-source settings',
    contractSlice: contractSlices.externalSourceCommandContract,
    wireImpact: true,
    rationale:
      'the Web settings notification must remain stable across refreshes and workspace changes without treating acknowledgement as permission or policy',
    exit:
      'remove only if Web settings no longer persists first-discovery awareness or a reviewed owner-scoped replacement preserves the same workspace isolation',
  })),
  ...[
    'ExternalToolActivationState',
    'ExternalToolApprovalRequest',
    'ExternalToolCapability',
    'ExternalToolCatalogEntry',
    'ExternalToolConflict',
    'ExternalToolConflictCandidateKind',
    'ExternalToolRuntimeKind',
    'set_external_tool_target_decision',
    'set_external_tool_targets_enabled',
    'set_external_tool_conflict_choice',
  ].map((symbol) =>
    externalToolEntry(
      symbol,
      'openbitfun-core external tool composition facade',
      'OpenBitFun CLI and desktop host APIs',
    ),
  ),
  ...[
    'ExternalSubagentActivationState',
    'ExternalSubagentCompatibilityState',
    'ExternalSubagentConflict',
    'ExternalSubagentConflictCandidate',
    'ExternalSubagentModelBindingGroup',
    'ExternalSubagentModelBindingMethod',
    'ExternalSubagentModelBindingOption',
    'ExternalSubagentModelBindingTarget',
    'ExternalSubagentModelProfileRequest',
    'ExternalSubagentModelRequest',
    'ExternalSubagentSummary',
    'set_external_subagent_activation',
    'set_external_subagents_enabled',
    'set_external_subagent_model_binding',
    'choose_external_subagent_conflict',
  ].map((symbol) =>
    externalSubagentEntry(
      symbol,
      'openbitfun-core external subagent composition facade',
      'OpenBitFun CLI and desktop host APIs',
    ),
  ),
  ...[
    'ExternalMcpActivationState',
    'ExternalMcpApprovalRequest',
    'ExternalMcpCatalogEntry',
    'ExternalMcpConflict',
    'ExternalMcpTransportKind',
    'native_mcp_candidate_id',
    'set_external_mcp_server_decision',
    'set_external_mcp_servers_enabled',
    'choose_external_mcp_conflict',
  ].map((symbol) =>
    externalMcpEntry(
      symbol,
      'openbitfun-core external MCP composition facade',
      'OpenBitFun CLI and desktop host APIs',
    ),
  ),
];

function pluginSourceEntry(symbol, owner, consumer, verification, wireImpact) {
  return {
    symbol,
    owner,
    consumer,
    verification,
    p0: 'P0-C managed package discovery, workspace review state, fixed adapter input, and CLI diagnostics',
    contractSlice: contractSlices.openbitfunPluginExtension,
    wireImpact,
    rationale:
      'P0-C needs one ecosystem-neutral package identity, review, and fixed-content boundary without exposing adapter or plugin-internal ABI types',
    exit:
      'remove only after a reviewed package-source owner migration with equivalent CLI and trust-state tests',
  };
}

export const pluginSourceContractPublicApiEntries = [
  'PluginPackageFile',
  'PluginPackageManifest',
  'PluginPackageSourceIdentity',
  'PluginPackageInput',
  'PluginPackageTrustLevel',
  'PluginTrustDecision',
  'PluginTrustStore',
  'PLUGIN_TRUST_STORE_SCHEMA_VERSION',
  'PluginSourceContractError',
  'PluginActivationAuthority',
].map((symbol) =>
  pluginSourceEntry(
    symbol,
    'product-domains plugin-source contract owner',
    'services-integrations managed package source owner, openbitfun-core compatibility facade, and plugin-source contract tests',
    'product-domains plugin_source_contracts tests and services-integrations managed package discovery tests',
    true,
  ),
);

export const managedPluginSourcePublicApiEntries = [
  'ManagedPluginTrustLevel',
  'ManagedPluginTrustDecision',
  'ManagedPluginPackageView',
  'ManagedPluginSourceIssue',
  'ManagedPluginSourceSnapshot',
  'ManagedPluginSourceError',
  'refresh_managed_plugin_sources',
  'set_managed_plugin_trust',
].map((symbol) =>
  pluginSourceEntry(
    symbol,
    'openbitfun-core managed plugin source compatibility facade',
    'OpenBitFun CLI plugins and doctor commands',
    'services-integrations plugin_source tests, core boundary checks, and OpenBitFun CLI plugin command tests',
    false,
  ),
);

export const managedPluginActivationPublicApiEntries = [
  'ManagedPluginCandidateView',
  'ManagedPluginActivationView',
  'ManagedPluginDeactivationResult',
  'preview_managed_plugin_activation',
  'activate_managed_plugin',
  'deactivate_managed_plugin',
].map((symbol) =>
  pluginSourceEntry(
    symbol,
    'openbitfun-core managed plugin composition root',
    'OpenBitFun CLI plugin activation commands',
    'openbitfun-core plugin_runtime tests, OpenBitFun CLI plugin source tests, and core boundary checks',
    false,
  ),
);

export const managedPluginSourceServicePublicApiEntries = [
  'ManagedPluginTrustLevel',
  'ManagedPluginTrustDecision',
  'ManagedPluginPackageView',
  'ManagedPluginSourceIssue',
  'ManagedPluginSourceSnapshot',
  'ManagedPluginSourceError',
  'ManagedPluginSourceService',
].map((symbol) =>
  pluginSourceEntry(
    symbol,
    'services-integrations managed plugin source owner',
    'openbitfun-core managed plugin source compatibility facade',
    'services-integrations plugin_source tests and core boundary checks',
    false,
  ),
);

export const publicApiAllowlistRules = [
  {
    path: 'src/crates/execution/agent-runtime/src/lib.rs',
    reason:
      'Agent Runtime root must expose only the reviewed feature-owned capability modules',
    allowedSymbols: agentRuntimeRootPublicModules,
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/plugin.rs',
    reason:
      'plugin runtime public contract symbols must stay explicitly budgeted and consumer-backed',
    allowedSymbolEntries: pluginRuntimePublicApiEntries,
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/lib.rs',
    reason:
      'runtime-ports root must re-export only the explicitly budgeted plugin runtime contract surface',
    allowedPluginReexportEntries: pluginRuntimePublicApiEntries,
  },
  {
    path: 'src/crates/adapters/opencode-adapter/src/lib.rs',
    reason:
      'OpenCode adapter public API must stay limited to reviewed sources, managed Plugin Host Config projection, and the PluginRuntimeClient adapter boundary',
    allowedSymbolEntries: opencodeAdapterPublicApiEntries,
  },
  {
    path: 'src/crates/adapters/claude-code-adapter/src/lib.rs',
    reason: 'Claude Code adapter public API is limited to reviewed declarative source providers',
    allowedSymbolEntries: claudeCodeAdapterPublicApiEntries,
  },
  {
    path: 'src/crates/adapters/codex-adapter/src/lib.rs',
    reason: 'Codex adapter public API is limited to reviewed declarative source providers',
    allowedSymbolEntries: codexAdapterPublicApiEntries,
  },
  {
    path: 'src/crates/adapters/static-hook-support/src/lib.rs',
    reason: 'shared static Hook parsing helpers must stay narrow and redacted',
    allowedSymbolEntries: staticHookSupportPublicApiEntries,
  },
  {
    path: 'src/crates/services/services-core/src/local_instructions.rs',
    reason:
      'bounded local user Instruction file support must stay narrow, backend-only, and explicitly consumer-backed',
    allowedSymbolEntries: userInstructionSourceServicePublicApiEntries,
  },
  {
    path: 'src/crates/execution/plugin-runtime-client/src/lib.rs',
    reason:
      'PluginRuntimeClient public API must stay limited to the injected adapter trait and client boundary type',
    allowedSymbolEntries: pluginRuntimeClientPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/plugin_source.rs',
    reason:
      'managed plugin package and trust contracts must stay explicitly budgeted and ecosystem-neutral',
    allowedSymbolEntries: pluginSourceContractPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/external_integration_policy.rs',
    reason:
      'external integration policy contracts must stay ecosystem-neutral, versioned, fail-closed, and explicitly consumer-backed',
    allowedSymbolEntries: externalIntegrationPolicyPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/external_source_control.rs',
    reason:
      'external source control contracts must stay versioned, capability-neutral, closed-action, and explicitly consumer-backed',
    allowedSymbolEntries: externalSourceControlPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/external_sources.rs',
    reason:
      'external source contracts must stay capability-specific, ecosystem-neutral, and explicitly consumer-backed',
    allowedSymbolEntries: externalSourceContractPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/plugin_capabilities.rs',
    reason:
      'executable plugin capability projections must stay ecosystem-neutral, behavior-light, and explicitly consumer-backed',
    allowedSymbolEntries: pluginCapabilityProjectionPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/external_subagents.rs',
    reason:
      'external subagent contracts must stay ecosystem-neutral, fresh-only, and explicitly consumer-backed',
    allowedSymbolEntries: externalSubagentContractPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/external_hook_contributions.rs',
    reason:
      'external Hook contracts must stay ecosystem-neutral, runtime-free, fail-closed, and explicitly consumer-backed',
    allowedSymbolEntries: externalHookContractPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/external_hook_catalog.rs',
    reason:
      'external Hook catalog contracts must stay ecosystem-neutral, runtime-free, redacted, bounded, and explicitly consumer-backed',
    allowedSymbolEntries: externalHookCatalogPublicApiEntries,
  },
  {
    path: 'src/crates/contracts/product-domains/src/workspace_references.rs',
    reason:
      'workspace Reference contracts must stay ecosystem-neutral, runtime-free, non-authorizing, bounded, and explicitly consumer-backed',
    allowedSymbolEntries: workspaceReferenceContractPublicApiEntries,
  },
  {
    path: 'src/crates/assembly/external-sources/src/lib.rs',
    reason:
      'external source assembly API must expose only the provider-neutral coordinator',
    allowedSymbolEntries: externalSourceCoordinatorPublicApiEntries,
  },
  {
    path: 'src/crates/assembly/core/src/external_sources.rs',
    reason:
      'core external source facade must stay limited to neutral product operations and read models',
    allowedSymbolEntries: externalSourceCorePublicApiEntries,
  },
  {
    path: 'src/crates/services/services-integrations/src/plugin_source.rs',
    reason:
      'managed plugin source service API must stay limited to one injected service and its result types',
    allowedSymbolEntries: managedPluginSourceServicePublicApiEntries,
  },
  {
    path: 'src/crates/assembly/core/src/plugin_source.rs',
    reason:
      'core managed plugin source compatibility API must stay limited to the current CLI consumer surface',
    allowedSymbolEntries: managedPluginSourcePublicApiEntries,
  },
  {
    path: 'src/crates/assembly/core/src/plugin_runtime.rs',
    reason:
      'core managed plugin activation API must stay limited to product status projection and explicit activation or deactivation transitions',
    allowedSymbolEntries: managedPluginActivationPublicApiEntries,
  },
];
