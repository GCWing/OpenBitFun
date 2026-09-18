// Boundary rules for source ownership, facades, and required owner content.

import { agentRuntimeRootPublicModules } from './public-api-rules.mjs';

const agentRuntimeRootUnexpectedLine = new RegExp(
  `^(?!(?:[ \\t]*|[ \\t]*\\/\\/!.*|[ \\t]*#\\[cfg\\(feature = "(?:agent-runtime|deep-research|native-hook-settings)"\\)\\][ \\t]*|[ \\t]*#\\[cfg\\(any\\(feature = "agent-runtime", feature = "definition-contracts"\\)\\)\\][ \\t]*|[ \\t]*pub mod (?:${agentRuntimeRootPublicModules.join('|')});[ \\t]*)\\r?$).+$`,
  'm',
);

export const forbiddenContentRules = [
  {
    path: 'src/apps/desktop/src/api/path_target.rs',
    patterns: [{
      regex: /\b(?:lookup_remote_entry_for_path|lookup_remote_connection(?:_scoped|_with_hint)?|should_force_local_assistant_path)\b/,
      message: 'desktop file routing must resolve workspace IDs; legacy path interpretation belongs only to the upgrade adapter',
    }],
  },
  {
    path: 'src/crates/assembly/core/src/service/filesystem/service.rs',
    patterns: [{
      regex: /\blookup_remote_connection(?:_scoped|_with_hint)?\b/,
      message: 'filesystem IO must use an explicit provider scope, never infer a workspace from a path',
    }],
  },
  ...[
    'file_read_tool', 'file_write_tool', 'file_edit_tool', 'delete_file_tool', 'ls_tool',
  ].map((tool) => ({
    path: `src/crates/assembly/core/src/agentic/tools/implementations/${tool}.rs`,
    reason: 'workspace file tools share one implementation; transport selection belongs to the bound WorkspaceFileSystem provider',
    patterns: [{
      regex: /\b(?:uses_remote_workspace_backend|is_remote|ws_shell|build_remote_\w+|read_local_file|write_local_file|edit_local_file|delete_local_path)\s*\(/,
      message: 'workspace file tool must not reintroduce a local/SSH execution fork or a transport-specific helper',
      ignoreRustComments: true,
    }],
  })),
  {
    path: 'src/crates/assembly/core/src/plugin_capability_publication.rs',
    reason:
      'generic plugin capability publication consumes provider-neutral product contracts and must not absorb ecosystem config, Host wire, or adapter lifecycle',
    patterns: [
      {
        regex:
          /\b(?:OpenCode|DeepSeek|HookFunction|serde_json|openbitfun_[a-z0-9_]+_adapter)\b/,
        message:
          'plugin capability publication must not depend on ecosystem adapters, raw config, or Host runtime contracts',
      },
    ],
  },
  {
    path: 'Cargo.toml',
    reason:
      'workspace Rustls owns only the compatible version; concrete provider features belong to services-core',
    patterns: [
      {
        regex: /^rustls\s*=\s*\{[^\n}]*,\s*features\s*=/m,
        message: 'root workspace Rustls dependency must not select crypto-provider capabilities',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/lib.rs',
    reason:
      'Agent Runtime root is a flat feature-owned module wrapper, not a feature-free implementation surface',
    patterns: [
      {
        regex: agentRuntimeRootUnexpectedLine,
        message: 'unexpected Agent Runtime root content outside the reviewed cfg/module pairs',
      },
    ],
  },
  {
    path: 'src/apps/cli/Cargo.toml',
    reason:
      'CLI/TUI consumes stable contracts; the `server` command may host the App Server stdio surface, but the CLI must not depend on the typed App Server client transport, wire DTOs, or a shared TUI management crate',
    patterns: [
      {
        regex:
          /^\s*openbitfun-(?:app-server-client|app-server-protocol|tui-management)\s*=/m,
        message:
          'openbitfun-cli must not depend on the typed App Server client transport, wire DTOs, or a shared TUI management crate',
      },
    ],
  },
  {
    path: 'src/crates/interfaces/app-server/Cargo.toml',
    reason: 'App Server must select explicit openbitfun-core owner features',
    patterns: [
      {
        regex: /features\s*=\s*\[[^\]]*"product-full"/,
        message: 'app-server must not select the broad openbitfun-core/product-full union',
      },
    ],
  },
  {
    path: 'src/crates/adapters/agent-runtime-ipc/src/operation.rs',
    reason: 'agent-runtime-ipc operation scope is frozen to the reviewed Shared TUI slice',
    patterns: [
      {
        regex: /^\s+(?!(?:Health|ListAgentModes|ListSessions|CreateSession|RestoreSession|DeleteSession|ForkSession|RenameSession|UpdateSessionMode|UpdateSessionModel|ReloadSessionContext|CompactSession|UndoSession|RedoSession|SessionUsage|WaitForSettlement|RecordLocalCommandTurn|SearchWorkspaceReferences|WorkspaceReferencesForMessage|GetSessionLineage|InspectLineageSession|CancelLineageSession|WorkspaceDiff|SubmitTurn|SteerTurn|RunUserShellCommand|CancelTurn|PendingPermissions|RespondPermission|StartQuestionInteraction|CancelUserQuestion|SubmitUserAnswers|Unit|AgentModes|Sessions|SessionCreated|SessionRestored|SessionForked|SessionReverted|SessionLineage|LineageSessionInspection|WorkspaceReferenceSearch|WorkspaceReferences|TurnAccepted|TurnSteered|TurnCancelled|LocalCommandTurnRecorded|Idle|Processing|Error|Starting|Compacting|Thinking|Streaming|ToolCalling|ToolConfirming|None|CurrentController|AttachExisting|UncontrolledTarget|Self|RuntimeIpcSessionRequirement|RuntimeIpcOperationRules|RuntimeSessionForkRequest|RuntimeSessionState|RuntimeSessionProcessingPhase|AgentContextReloadRequest|AgentDialogSteerRequest|AgentDialogTurnRequest|AgentLocalCommandTurnRecordRequest|AgentLocalCommandTurnRecordResult|AgentMessageWorkspaceReferencesRequest|AgentSessionCompactionRequest|AgentSessionCreateRequest|AgentSessionCreateResult|AgentSessionLineageCancellationRequest|AgentSessionLineageInspection|AgentSessionLineageRequest|AgentSessionLineageSnapshot|AgentSessionLineageTranscriptRequest|AgentSessionListRequest|AgentSessionModeUpdateRequest|AgentSessionModelUpdateRequest|AgentSessionRevertRequest|AgentSessionRevertResult|AgentSessionSummary|AgentSessionUsageRequest|AgentTurnCancellationRequest|AgentTurnCancellationResult|AgentTurnSettlementRequest|AgentUserShellCommandRequest|AgentWorkspaceReference|AgentWorkspaceReferenceSearchRequest|AgentWorkspaceReferenceSearchResult|SessionTranscript|SessionUsageReport|WorkspaceDiffSnapshot)\b)[A-Z][A-Za-z0-9_]*\b/,
        message:
          'agent-runtime-ipc may not add archive, replay, observer, general controller-transfer, or other operations beyond the reviewed Shared TUI slice',
      },
    ],
  },
  {
    path: 'src/crates/adapters/agent-runtime-ipc/Cargo.toml',
    reason:
      'agent-runtime-ipc may reuse bounded JSON encoding without enabling openbitfun-transport features',
    patterns: [
      {
        regex:
          /openbitfun-transport\s*=\s*\{[^}\r\n]*(?:features|default-features)\s*=/,
        message:
          'agent-runtime-ipc must not enable event-host or Tauri transport features',
      },
    ],
  },
  {
    path: 'src/crates/execution/plugin-runtime-client/src/adapter.rs',
    reason: 'plugin-runtime-client adapter trait method surface must stay narrow',
    patterns: [
      {
        regex: /^\s*(?:async\s+)?fn\s+(?!(?:adapter_id|availability|read_plugins|dispatch)\b)[A-Za-z_][A-Za-z0-9_]*\b/,
        message:
          'unexpected PluginRuntimeAdapter trait method; update the reviewed adapter method budget before exposing more client API',
      },
    ],
  },
  {
    path: 'src/crates/execution/plugin-runtime-client/src/lib.rs',
    reason:
      'plugin-runtime-client public method surface must stay narrow and must not expose status-write or test-helper side channels',
    patterns: [
      {
        regex:
          /\bpub\s+(?:async\s+)?fn\s+(?!(?:new|dispose_project)\b)[A-Za-z_][A-Za-z0-9_]*\b/,
        message:
          'unexpected public DefaultPluginRuntimeClient method; update the reviewed method budget before exposing more client API',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/plugin_source.rs',
    reason:
      'managed plugin source service method surface must stay limited to source review and activation authority',
    patterns: [
      {
        regex:
          /\bpub\s+(?:async\s+)?fn\s+(?!(?:new|refresh|set_trust|load_package|activate|deactivate|load_activated_package|has_activation_authority)\b)[A-Za-z_][A-Za-z0-9_]*\b/,
        message:
          'unexpected public ManagedPluginSourceService method; update the reviewed method budget before exposing more API',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/plugin_source.rs',
    reason:
      'plugin source contract methods must stay limited to manifest validation, source review, and activation authority',
    patterns: [
      {
        regex:
          /\bpub\s+(?:const\s+)?fn\s+(?!(?:parse_json|validate|content_hash|new|into_parts|epoch|activation_epoch|activation_sources|trust_level_for|apply_decision|reconcile_sources|is_activated|activation_authority|is_activation_current|activate|clear_activation_record)\b)[A-Za-z_][A-Za-z0-9_]*\b/,
        message:
          'unexpected public plugin source contract method; update the reviewed method budget before exposing more API',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/plugin_source.rs',
    reason: 'plugin source review must fail when product path initialization fails',
    patterns: [
      {
        regex: /crate::infrastructure::get_path_manager_arc\s*\(/,
        message:
          'plugin source review must use try_get_path_manager_arc instead of the temporary fallback path manager',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/lib.rs',
    patterns: [
      {
        regex: /\bpub\s+use\s+plugin::\*/,
        message:
          'runtime-ports root must not wildcard re-export plugin contracts; update the explicit public API budget',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/plugin.rs',
    patterns: [
      {
        regex: /\bserde_json::Value\b|\bserde_json::Map\b|\bjson!\b/,
        message:
          'plugin runtime contracts must not expose raw JSON ABI; use typed refs, descriptors, candidates, diagnostics, and quarantine facts',
      },
      {
        regex: /\bpub\s+(?:\w+\s+)*payload\s*:\s*serde_json::Value\b/,
        message:
          'PluginDispatchEnvelope must not regress to raw payload transport across the plugin runtime boundary',
      },
      {
        regex: /\bpub\s+accepted\s*:\s*bool\b/,
        message:
          'PluginResponseEnvelope must return typed effect candidates and diagnostics instead of an accepted bool',
      },
      {
        regex: /product-full/,
        message:
          'plugin runtime contracts must not pull product-full delivery assumptions into runtime-ports',
      },
      {
        regex: /\b(?:TrustEpochAdvanced|PluginUpdated|PolicyUpdated)\b/,
        message:
          'P0-B quarantine clear condition public API must only expose implemented HostRestarted semantics',
      },
      {
        regex: /\brequires_permission\b|\bpermission_prompt\b/,
        message:
          'plugin effect permission state must use PluginPermissionGate to avoid invalid required-without-prompt combinations',
      },
      {
        regex: /\bNotRequired\b|\bPluginMaterializeCondition\b|\bmaterialize_when\b/,
        message:
          'plugin effect materialization must be derived from an auditable PluginPermissionGate, not an unaudited no-op or free materialize flag',
      },
      {
        regex: /\bPermissionPromptEffectKind\s*\{[^}]*\bUnsupported\b|\bPluginEffectCandidatePayload\s*\{[^}]*\bUnsupported\b/s,
        message:
          'unsupported plugin capabilities must be reported as typed diagnostics/status, not permission prompts or effect candidates',
      },
    ],
  },
  {
    path: 'src/crates/adapters/transport/src/adapters/tauri.rs',
    patterns: [
      {
        regex: /\bAgenticEvent::[A-Z]/,
        message:
          'Tauri transport adapter must not match agentic event variants directly; use openbitfun-events frontend projection',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/sdk_smoke.rs',
    patterns: [
      {
        regex: /\bopenbitfun_runtime_services::test_support\b/,
        message:
          'agent-runtime SDK smoke tests must prove the public sdk facade is enough; do not rely on runtime-services test_support',
      },
      {
        regex: /\bFakeRuntimeServicesProvider\b/,
        message:
          'agent-runtime SDK smoke tests must build fake services through sdk-reexported ports and RuntimeServicesBuilder',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/sdk.rs',
    patterns: [
      {
        regex: /\bopenbitfun_core\b/,
        message: 'SDK facade must not expose openbitfun-core',
      },
      {
        regex: /\bopenbitfun_product_capabilities\b/,
        message: 'SDK facade must not expose product assembly facts',
      },
      {
        regex: /\btauri\b/,
        message: 'SDK facade must not expose Tauri APIs',
      },
      {
        regex: /\bAppHandle\b/,
        message: 'SDK facade must not expose desktop app handles',
      },
      {
        regex: /\breqwest\b/,
        message: 'SDK facade must not expose concrete HTTP clients',
      },
      {
        regex: /\bgit2\b/,
        message: 'SDK facade must not expose concrete Git providers',
      },
      {
        regex: /\brmcp\b/,
        message: 'SDK facade must not expose concrete MCP clients',
      },
      {
        regex:
          /\b(?:PluginRuntime[A-Za-z0-9_]*|PluginDispatchEnvelope|PluginResponseEnvelope|PluginRuntimeReadRequest|PluginRuntimeReadResponse|PluginStatusSnapshot|PluginQuarantineState|PluginHostLifecycle[A-Za-z0-9_]*)\b/,
        message:
          'SDK facade must not expose raw plugin runtime client contracts; use product assembly or Server/API projection instead',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/product_sdk_assembly.rs',
    patterns: [
      {
        regex: /\bopenbitfun_core\b/,
        message:
          'product assembly to SDK smoke must not depend on openbitfun-core',
      },
      {
        regex: /\bCoreRuntimeServicesProvider\b/,
        message:
          'product assembly to SDK smoke must not use core concrete service adapters',
      },
      {
        regex: /\btauri\b/,
        message: 'product assembly to SDK smoke must not depend on Tauri',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/browser_control/browser_launcher.rs',
    patterns: [
      {
        regex: /\bprocess_manager::/,
        message:
          'core browser launcher facade must not own browser process execution; use openbitfun-services-integrations browser_control launcher',
      },
      {
        regex: /\b(?:std::process::Command|Command::new\()/,
        message:
          'core browser launcher facade must not construct browser launch commands; use openbitfun-services-integrations browser_control launcher',
      },
      {
        regex: /\breqwest::/,
        message:
          'core browser launcher facade must not own CDP network probing; use openbitfun-services-integrations browser_control launcher',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/browser_control/cdp_client.rs',
    patterns: [
      {
        regex: /\breqwest::/,
        message:
          'core CDP client facade must not own HTTP endpoint probing; use openbitfun-services-integrations browser_control CDP provider',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/web/fetch.rs',
    patterns: [
      {
        regex: /\breqwest::/,
        message:
          'core WebFetch tool must not own HTTP clients; use openbitfun-services-integrations web provider',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/web/search.rs',
    patterns: [
      {
        regex: /\breqwest::/,
        message:
          'core WebSearch tool must not own provider HTTP clients; use openbitfun-services-integrations web provider',
      },
      {
        regex: /strip_prefix\("Title: "\)/,
        message:
          'core WebSearch tool must not own Exa text result parsing; use tool-runtime web_search helpers',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/web/readable.rs',
    patterns: [
      {
        regex: /\bhtmd::|\bHtmlToMarkdown\b/,
        message:
          'core WebFetch readable facade must not own HTML-to-Markdown conversion; use tool-runtime web_readable helpers',
      },
      {
        regex: /\blegible::|\bparse_legible\b/,
        message:
          'core WebFetch readable facade must not own legible extraction; use tool-runtime web_readable helpers',
      },
      {
        regex: /\breadability_js::|\bReadability::new\b/,
        message:
          'core WebFetch readable facade must not own readability-js extraction; use tool-runtime web_readable helpers',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/infrastructure/storage/persistence.rs',
    patterns: [
      {
        regex: /\bstatic\s+FILE_LOCKS\b/,
        message:
          'core persistence wrapper must not own file locks; use openbitfun-services-core persistence owner',
      },
      {
        regex: /\bserde_json::to_string_pretty\b/,
        message:
          'core persistence wrapper must not own JSON serialization; use openbitfun-services-core persistence owner',
      },
      {
        regex: /\btokio::fs::rename\b/,
        message:
          'core persistence wrapper must not own atomic file replacement; use openbitfun-services-core persistence owner',
      },
      {
        regex: /\bfn create_backup\b/,
        message:
          'core persistence wrapper must not own backup creation; use openbitfun-services-core persistence owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/infrastructure/storage/cleanup.rs',
    patterns: [
      {
        regex: /\btokio::fs::read_dir\b/,
        message:
          'core storage cleanup wrapper must not own directory traversal; use openbitfun-services-core cleanup owner',
      },
      {
        regex: /\btokio::fs::remove_file\b/,
        message:
          'core storage cleanup wrapper must not own cleanup deletion; use openbitfun-services-core cleanup owner',
      },
      {
        regex: /\bfn cleanup_recursively\b/,
        message:
          'core storage cleanup wrapper must not own recursive cleanup; use openbitfun-services-core cleanup owner',
      },
      {
        regex: /\bfn calculate_dir_size\b/,
        message:
          'core storage cleanup wrapper must not own cleanup size accounting; use openbitfun-services-core cleanup owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/token_usage/service.rs',
    patterns: [
      {
        regex: /\bconst\s+MODEL_STATS_FILE\b/,
        message:
          'core token usage wrapper must not own token usage file layout; use openbitfun-services-core token usage owner',
      },
      {
        regex: /\bRecordsBatch\b/,
        message:
          'core token usage wrapper must not own token usage persistence batches; use openbitfun-services-core token usage owner',
      },
      {
        regex: /\bfn persist_record\b/,
        message:
          'core token usage wrapper must not own record persistence; use openbitfun-services-core token usage owner',
      },
      {
        regex: /\btokio::fs::/,
        message:
          'core token usage wrapper must not own token usage file IO; use openbitfun-services-core token usage owner',
      },
      {
        regex: /\bchrono::/,
        message:
          'core token usage wrapper must not own token usage time aggregation; use openbitfun-services-core token usage owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/instruction_context.rs',
    patterns: [
      {
        regex: /\btokio::fs::read_to_string\b/,
        message:
          'core instruction context wrapper must not own workspace instruction file IO; use openbitfun-services-core workspace instruction owner',
      },
      {
        regex: /\bfor file_name in\b/,
        message:
          'core instruction context wrapper must not own instruction file ordering; use openbitfun-services-core workspace instruction owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/util/front_matter_markdown.rs',
    patterns: [
      {
        regex: /\bserde_yaml::from_str\b/,
        message:
          'core front-matter markdown facade must not own YAML parsing; use openbitfun-services-core markdown owner',
      },
      {
        regex: /\bserde_yaml::to_string\b/,
        message:
          'core front-matter markdown facade must not own YAML serialization; use openbitfun-services-core markdown owner',
      },
      {
        regex: /\bstd::fs::write\b/,
        message:
          'core front-matter markdown facade must not own markdown persistence; use openbitfun-services-core markdown owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/review_platform/mod.rs',
    patterns: [
      {
        regex: /\breqwest::/,
        message:
          'core review platform service must not own concrete HTTP clients; use openbitfun-services-integrations review platform HTTP transport',
      },
      {
        regex: /\btokio::fs\b|\bstd::fs\b/,
        message:
          'core review platform service must not own token or provider file IO; use openbitfun-services-integrations review platform owner',
      },
      {
        regex: /\bprocess_manager::|\bCommand::new\(|\bexecute_git_command\b|\bgit\s+remote\b|\brev-parse\b/,
        message:
          'core review platform service must not own Git probing; use openbitfun-services-integrations review platform owner',
      },
      {
        regex: /\bserde_json::|\bjson!\b|\bValue\b/,
        message:
          'core review platform service must not own provider DTO parsing; use openbitfun-services-integrations review platform owner',
      },
      {
        regex: /\bstruct\s+(?:Github|Gitlab|Gitcode)|\bimpl\s+ReviewProvider\b|\btrait\s+ReviewProvider\b/,
        message:
          'core review platform service must not own provider implementations; use openbitfun-services-integrations review platform owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/computer_use_actions.rs',
    patterns: [
      {
        regex: /\bprocess_manager::/,
        message:
          'core computer-use system facade must not spawn local system processes directly; use openbitfun-services-core local system provider',
      },
      {
        regex: /\btokio::process::/,
        message:
          'core computer-use system facade must not own async process execution; use openbitfun-services-core local system provider',
      },
      {
        regex: /\b(?:std::process::Command|Command::new\()/,
        message:
          'core computer-use system facade must not construct local system commands directly; use openbitfun-services-core local system provider',
      },
      {
        regex: /\bfn\s+script_invocation\b/,
        message:
          'core computer-use system facade must not own script invocation selection; use openbitfun-services-core local system provider',
      },
      {
        regex: /\bfn\s+platform_open_attempts\b/,
        message:
          'core computer-use system facade must not own platform open-app command selection; use openbitfun-services-core local system provider',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/local_shell.rs',
    patterns: [
      {
        regex: /\bprocess_manager::/,
        message:
          'core local shell facade must not probe shells through process execution; use terminal-core shell resolution',
      },
      {
        regex: /\b(?:std::process::Command|Command::new\()/,
        message:
          'core local shell facade must not construct shell probe commands; use terminal-core shell resolution',
      },
      {
        regex: /\bstd::env::var\b/,
        message:
          'core local shell facade must not own environment-based shell selection; use terminal-core shell resolution',
      },
      {
        regex: /\bcfg!\(target_os\b/,
        message:
          'core local shell facade must not own platform shell fallback rules; use terminal-core shell resolution',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/bot/weixin.rs',
    patterns: [
      {
        regex: /\breqwest::/,
        message:
          'core Weixin bot facade must not own provider HTTP clients; use openbitfun-services-integrations Weixin provider',
      },
      {
        regex: /\baes::/,
        message:
          'core Weixin bot facade must not own provider AES/CDN crypto; use openbitfun-services-integrations Weixin provider',
      },
      {
        regex: /\bhex::/,
        message:
          'core Weixin bot facade must not own provider hex encoding; use openbitfun-services-integrations Weixin provider',
      },
      {
        regex: /\bmd5::/,
        message:
          'core Weixin bot facade must not own provider MD5 signing; use openbitfun-services-integrations Weixin provider',
      },
      {
        regex: /\bfn\s+sync_buf_path\b/,
        message:
          'core Weixin bot facade must not own provider sync-buffer storage layout; use openbitfun-services-integrations Weixin provider',
      },
      {
        regex: /\bfn\s+parse_weixin_cdn_aes_key\b/,
        message:
          'core Weixin bot facade must not own provider CDN AES key parsing; use openbitfun-services-integrations Weixin provider',
      },
    ],
  },
  {
    path: 'src/crates/contracts/core-types/src/ai.rs',
    patterns: [
      {
        regex: /\bresolve_request_url\b/,
        message:
          'core-types may own AI DTOs, but provider URL resolution belongs in adapter or assembly compatibility owners',
      },
      {
        regex: /\b(?:chat\/completions|v1\/messages|streamGenerateContent)\b/,
        message:
          'core-types must not encode provider endpoint paths; keep protocol URL behavior above contracts',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/product_assembly.rs',
    patterns: [
      {
        regex: /\bpub struct CoreRuntimeServicesProvider\b/,
        message:
          'core product_assembly must remain a compatibility facade; move core-specific runtime service providers to product runtime adapters',
      },
      {
        regex: /\bimpl RuntimeServicesProvider for CoreRuntimeServicesProvider\b/,
        message:
          'core product_assembly must not own runtime service provider registration; use the product runtime adapter path',
      },
      {
        regex: /\bCoreSessionStorePort\b/,
        message:
          'core product_assembly must not bind concrete session store adapters directly; use the product runtime adapter path',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/persistence/session_branch.rs',
    patterns: [
      {
        regex: /\bfn\s+estimate_turn_message_count\b/,
        message:
          'session branch metadata counting belongs in services-core session lineage owner, not core persistence',
      },
      {
        regex: /\bfn\s+strip_child_session_metadata\b/,
        message:
          'branch child-metadata cleanup belongs in services-core session lineage owner, not core persistence',
      },
      {
        regex: /\bfn\s+build_branch_custom_metadata\b/,
        message:
          'branch custom metadata shaping belongs in services-core session lineage owner, not core persistence',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/persistence/manager.rs',
    patterns: [
      {
        regex: /\bfn\s+build_session_relationship\b/,
        message:
          'session relationship reconstruction belongs in services-core session metadata owner, not core persistence manager',
      },
      {
        regex: /\bSessionMetadata\s*\{\s*session_id\s*:/,
        message:
          'session metadata field assembly belongs in services-core session metadata owner, not core persistence manager',
      },
      {
        regex: /\bmetadata\.deep_review_cache\s*=\s*Some\s*\(/,
        message:
          'DeepReview cache metadata mutation belongs in services-core session metadata owner, not core persistence manager',
      },
      {
        regex: /\bstatic\s+SESSION_INDEX_LOCKS\b/,
        message:
          'session metadata index locking belongs in services-core SessionMetadataStore, not core persistence manager',
      },
      {
        regex: /\bfn\s+scan_session_metadata_dirs\b/,
        message:
          'session metadata directory scanning belongs in services-core SessionMetadataStore, not core persistence manager',
      },
      {
        regex: /\bfn\s+count_session_metadata_dirs\b/,
        message:
          'session metadata directory counting belongs in services-core SessionMetadataStore, not core persistence manager',
      },
      {
        regex: /\bfn\s+rebuild_index_locked\b/,
        message:
          'session metadata index rebuilding belongs in services-core SessionMetadataStore, not core persistence manager',
      },
      {
        regex: /\bfn\s+upsert_index_entry_locked\b/,
        message:
          'session metadata index upsert belongs in services-core SessionMetadataStore, not core persistence manager',
      },
      {
        regex: /\bfn\s+remove_index_entry_locked\b/,
        message:
          'session metadata index removal belongs in services-core SessionMetadataStore, not core persistence manager',
      },
      {
        regex: /\bget_session_index_lock\b/,
        message:
          'session metadata index lock access belongs in services-core SessionMetadataStore, not core persistence manager',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/session_manager.rs',
    patterns: [
      {
        regex: /\bfn\s+extract_subagent_relationship\b/,
        message:
          'subagent relationship extraction belongs in services-core session lineage owner, not core session manager',
      },
      {
        regex: /\bmetadata\.custom_metadata\s*=\s*Some\s*\(\s*match\b/,
        message:
          'session custom-metadata merge rules belong in services-core session metadata owner, not core session manager',
      },
      {
        regex: /\bmetadata\.relationship\s*=\s*Some\s*\(\s*relationship\s*\)/,
        message:
          'session relationship mutation belongs in services-core session metadata owner, not core session manager',
      },
      {
        regex: /\bmetadata\.deep_review_run_manifest\s*=\s*deep_review_run_manifest\b/,
        message:
          'DeepReview run-manifest metadata mutation belongs in services-core session metadata owner, not core session manager',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace_runtime/service.rs',
    patterns: [
      {
        regex: /\bfn\s+merge_session_directory\b/,
        message:
          'legacy session directory merge belongs in services-core session migration owner, not core workspace runtime',
      },
      {
        regex: /\bfn\s+merge_session_metadata_file\b/,
        message:
          'legacy session metadata conflict resolution belongs in services-core session migration owner, not core workspace runtime',
      },
      {
        regex: /\bSessionMetadataStore::new\b/,
        message:
          'legacy session index rebuild belongs in services-core session migration owner, not core workspace runtime',
      },
      {
        regex: /\bfn\s+copy_dir_recursive\b/,
        message:
          'legacy path copy fallback belongs in services-core session migration owner, not core workspace runtime',
      },
      {
        regex: /\bfn\s+files_are_equal\b/,
        message:
          'legacy path conflict comparison belongs in services-core session migration owner, not core workspace runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service_agent_runtime.rs',
    patterns: [
      {
        regex: /\bself\.scheduler\s*\.\s*submit\b/,
        message:
          'remote dialog runtime host must submit through AgentRuntime dialog lifecycle port, not direct DialogScheduler',
      },
      {
        regex: /\bfn\s+strip_remote_user_input_tags\b/,
        message:
          'service agent runtime must not own remote user display cleanup; use services-integrations projection helpers',
      },
      {
        regex: /\bfn\s+compress_remote_chat_data_url_for_mobile\b/,
        message:
          'service agent runtime must not own remote chat thumbnail compression; use services-integrations projection helpers',
      },
      {
        regex: /\bfn\s+normalize_remote_session_model_id\b/,
        message:
          'service agent runtime must not own remote session model id normalization; use services-integrations model selection helpers',
      },
      {
        regex: /\.get\(\s*["']images["']\s*\)/,
        message:
          'service agent runtime must not extract remote chat image metadata directly; use services-integrations projection helpers',
      },
      {
        regex: /\bimage::load_from_memory\b/,
        message:
          'service agent runtime must not own remote chat image decoding/compression; use services-integrations projection helpers',
      },
      {
        regex: /\bJpegEncoder\b/,
        message:
          'service agent runtime must not own remote chat thumbnail encoding; use services-integrations projection helpers',
      },
      {
        regex: /\.find\(\s*["']User's question:\\n["']\s*\)/,
        message:
          'service agent runtime must not parse remote chat legacy wrapper text; use services-integrations projection helpers',
      },
      {
        regex: /\bAgentInputAttachment\s*\{[\s\S]*?\bkind:\s*["']remote_image["']/,
        message:
          'service agent runtime must not construct remote image attachments directly; use services-integrations attachment mapping',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_message_tool.rs',
    patterns: [
      {
        regex: /\bsubmit_with_prepended_messages\b/,
        message:
          'SessionMessage must submit through AgentRuntime dialog lifecycle port, not direct DialogScheduler',
      },
      {
        regex: /\bcoordinator\s*\.\s*resolve_session_workspace_binding\b/,
        message:
          'SessionMessage target workspace resolution must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\bresolve_session_workspace_binding\s*\(\s*&?target_session_id\b/,
        message:
          'SessionMessage target workspace resolution must use AgentSessionWorkspaceRequest, not legacy direct session id calls',
      },
      {
        regex: /\bcoordinator\s*\.\s*list_sessions\b/,
        message:
          'SessionMessage target session lookup must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\blist_sessions\s*\(\s*(?:Path::new|workspace_path)\b/,
        message:
          'SessionMessage target session lookup must use AgentSessionListRequest, not legacy path arguments',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_control_tool.rs',
    patterns: [
      {
        regex: /\bcancel_active_turn_for_session_from_requester\b/,
        message:
          'SessionControl requester-aware cancellation must flow through AgentRuntime cancellation port, not direct DialogScheduler',
      },
      {
        regex: /\bcoordinator\s*\.\s*resolve_session_workspace_binding\b/,
        message:
          'SessionControl workspace resolution must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\bresolve_session_workspace_binding\s*\(\s*session_id\b/,
        message:
          'SessionControl workspace resolution must use AgentSessionWorkspaceRequest, not legacy direct session id calls',
      },
      {
        regex: /\bcoordinator\s*\.\s*list_sessions\b/,
        message:
          'SessionControl session listing must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\blist_sessions\s*\(\s*(?:Path::new|workspace_path)\b/,
        message:
          'SessionControl session listing must use AgentSessionListRequest, not legacy path arguments',
      },
      {
        regex: /\bcoordinator\s*\.\s*delete_session\b/,
        message:
          'SessionControl session deletion must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\bdelete_session\s*\(\s*(?:Path::new|workspace_path)\b/,
        message:
          'SessionControl session deletion must use AgentSessionDeleteRequest, not legacy path arguments',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/cron/service.rs',
    patterns: [
      {
        regex: /\bsubmit_with_prepended_messages\b/,
        message:
          'Cron scheduled jobs must submit through AgentRuntime dialog lifecycle port, not direct DialogScheduler',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/cron_tool.rs',
    patterns: [
      {
        regex: /\bcoordinator\s*\.\s*resolve_session_workspace_binding\b/,
        message:
          'CronTool target workspace resolution must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\bresolve_session_workspace_binding\s*\(\s*&?session_id\b/,
        message:
          'CronTool target workspace resolution must use AgentSessionWorkspaceRequest, not legacy direct session id calls',
      },
      {
        regex: /\bcoordinator\s*\.\s*list_sessions\b/,
        message:
          'CronTool target session lookup must flow through AgentRuntime session-management port, not direct coordinator access',
      },
      {
        regex: /\blist_sessions\s*\(\s*(?:Path::new|workspace_path)\b/,
        message:
          'CronTool target session lookup must use AgentSessionListRequest, not legacy path arguments',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/coordinator.rs',
    patterns: [
      {
        regex: /\bscheduler\s*\.\s*deliver_thread_goal_(?:resumed|objective_updated)\b/,
        message:
          'Coordinator thread-goal delivery must flow through AgentRuntime lifecycle delivery port, not direct DialogScheduler',
      },
      {
        regex: /\bscheduler\s*\.\s*deliver_background_result\b/,
        message:
          'Coordinator background result delivery must flow through AgentRuntime lifecycle delivery port, not direct DialogScheduler',
      },
      {
        regex: /\bCoreRuntimeServicesProvider::terminal_port\b/,
        message:
          'Coordinator must consume an injected TerminalPort; product runtime owns concrete terminal provider construction',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'Coordinator must not construct concrete terminal providers; use injected TerminalPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/system.rs',
    patterns: [
      {
        regex: /\bCoreRuntimeServicesProvider::terminal_port\b/,
        message:
          'shared agentic system init must not construct concrete terminal providers; product entrypoints inject TerminalPort',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'shared agentic system init must not construct concrete terminal providers; product entrypoints inject TerminalPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/deep_review_policy.rs',
    patterns: [
      {
        regex: /\bstatic GLOBAL_DEEP_REVIEW_BUDGET_TRACKER\b/,
        message:
          'core DeepReview policy facade must not re-own runtime budget state; use openbitfun-agent-runtime::deep_review',
      },
      {
        regex: /\bstatic GLOBAL_DEEP_REVIEW_QUEUE_CONTROL_TRACKER\b/,
        message:
          'core DeepReview policy facade must not re-own queue control state; use openbitfun-agent-runtime::deep_review',
      },
      {
        regex: /\bpub struct DeepReviewExecutionPolicy\b/,
        message:
          'core DeepReview policy facade must not redefine execution policy; use openbitfun-agent-runtime::deep_review',
      },
      {
        regex: /\bpub fn record_deep_review_task_budget\b/,
        message:
          'core DeepReview policy facade must not re-own task budget recording; use openbitfun-agent-runtime::deep_review',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/deep_review/report.rs',
    patterns: [
      {
        regex: /\bfn fill_deep_review_packet_metadata\b/,
        message:
          'core DeepReview report must not re-own packet metadata enrichment; use openbitfun-agent-runtime::deep_review::report',
      },
      {
        regex: /\bfn deep_review_cache_from_completed_reviewers\b/,
        message:
          'core DeepReview report must not re-own cache update logic; use openbitfun-agent-runtime::deep_review::report',
      },
      {
        regex: /\bmetadata\.deep_review_cache\s*=\s*Some\s*\(/,
        message:
          'DeepReview cache metadata mutation belongs in services-core session metadata owner, not core report bridge',
      },
      {
        regex: /\bstruct DeepReviewCacheUpdate\b/,
        message:
          'core DeepReview report must not re-own cache update DTO; use openbitfun-agent-runtime::deep_review::report',
      },
      {
        regex: /"kind": "concurrency_limited"/,
        message:
          'core DeepReview report must not re-own runtime tracker reliability signal shaping; use openbitfun-agent-runtime::deep_review::report',
      },
      {
        regex: /DeepReview runtime diagnostics:/,
        message:
          'core DeepReview report must not re-own runtime diagnostics log formatting; use openbitfun-agent-runtime::deep_review::diagnostics',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/deep_review/task_adapter.rs',
    patterns: [
      {
        regex: /\bfn string_for_any_key\b/,
        message:
          'core DeepReview task adapter must not re-own manifest key normalization; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bfn deep_review_packet_id_for_cache\b/,
        message:
          'core DeepReview task adapter must not re-own packet id inference; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bfn ensure_deep_review_retry_coverage\b/,
        message:
          'core DeepReview task adapter must not re-own retry coverage validation; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bfn provider_capacity_queue_wait_seconds_for_attempt\b/,
        message:
          'core DeepReview task adapter must not re-own provider capacity backoff; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bclassify_deep_review_capacity_error\b/,
        message:
          'core DeepReview task adapter must not directly classify provider or local capacity errors; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bDeepReviewCapacityFailFastReason::DeterministicProviderError\b/,
        message:
          'core DeepReview task adapter must not re-own provider capacity category fallback; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bfn provider_capacity_wait_can_wake_on_active_reviewer_release\b/,
        message:
          'core DeepReview task adapter must not re-own provider capacity queue wake policy; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bqueue_expired_without_active_reviewer\b/,
        message:
          'core DeepReview task adapter must not re-own reviewer admission queue expiry policy; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bstruct QueueWaitTimer\b/,
        message:
          'core DeepReview task adapter must not re-own queue wait timing; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /runtime_task_execution::decide_provider_capacity_queue_step/,
        message:
          'core DeepReview task adapter must use the runtime provider queue state machine instead of direct step decisions',
      },
      {
        regex: /runtime_task_execution::decide_blocked_reviewer_admission_queue_step/,
        message:
          'core DeepReview task adapter must use the runtime reviewer admission state machine instead of direct step decisions',
      },
      {
        regex: /\bcontrol_snapshot\.(?:cancelled|paused|skip_optional)\b/,
        message:
          'core DeepReview task adapter must not re-own queue control decision priority; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /\bfn prompt_with_deep_review_retry_scope\b/,
        message:
          'core DeepReview task adapter must not re-own retry prompt shaping; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /<partial_result status=/,
        message:
          'core DeepReview task adapter must not re-own task completion result presentation; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /completed successfully with result:/,
        message:
          'core DeepReview task adapter must not re-own task completion result presentation; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /Retries used:/,
        message:
          'core DeepReview task adapter must not re-own retry guidance presentation; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /DeepReview automatic retry elapsed guard exceeded/,
        message:
          'core DeepReview task adapter must not re-own auto-retry admission policy; use openbitfun-agent-runtime::deep_review::task_execution',
      },
      {
        regex: /cancelled coverage/,
        message:
          'core DeepReview task adapter must not re-own cancelled reviewer presentation; use openbitfun-agent-runtime::deep_review::task_execution',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs',
    patterns: [
      {
        regex: /\bDeepReviewIncrementalCache\b/,
        message:
          'TaskTool must not directly inspect DeepReview incremental cache internals; use deep_review_task_adapter',
      },
      {
        regex: /deepReviewCache/,
        message:
          'TaskTool must not directly parse DeepReview cache payloads; use deep_review_task_adapter',
      },
      {
        regex: /<partial_result status=/,
        message:
          'TaskTool must not re-own DeepReview task completion result presentation; use deep_review_task_adapter',
      },
      {
        regex: /completed successfully with result:/,
        message:
          'TaskTool must not re-own DeepReview task completion result presentation; use deep_review_task_adapter',
      },
      {
        regex: /Retries used:/,
        message:
          'TaskTool must not re-own DeepReview retry guidance presentation; use deep_review_task_adapter',
      },
      {
        regex: /DeepReview automatic retry elapsed guard exceeded/,
        message:
          'TaskTool must not re-own DeepReview auto-retry admission policy; use deep_review_task_adapter',
      },
      {
        regex: /cancelled coverage/,
        message:
          'TaskTool must not re-own DeepReview cancelled reviewer presentation; use deep_review_task_adapter',
      },
      {
        regex: /\bprovider_capacity_retry_attempts\b/,
        message:
          'TaskTool must not re-own DeepReview provider capacity retry attempts; use deep_review_task_adapter',
      },
      {
        regex: /\bprovider_capacity_queue_elapsed_ms\b/,
        message:
          'TaskTool must not re-own DeepReview provider capacity queue elapsed aggregation; use deep_review_task_adapter',
      },
      {
        regex: /\bDEEP_REVIEW_PROVIDER_CAPACITY_MAX_RETRY_ATTEMPTS\b/,
        message:
          'TaskTool must not re-own DeepReview provider capacity retry limits; use deep_review_task_adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/code_review_tool.rs',
    patterns: [
      {
        regex: /"kind"\s*:\s*"cache_hit"/,
        message:
          'CodeReviewTool must not re-own DeepReview cache-hit reliability signal shaping; use deep_review_report',
      },
      {
        regex: /"kind"\s*:\s*"cache_miss"/,
        message:
          'CodeReviewTool must not re-own DeepReview cache-miss reliability signal shaping; use deep_review_report',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/prompt_builder/prompt_builder_impl.rs',
    patterns: [
      {
        regex: /\bComputer use \/ `key_chord`\b/,
        message:
          'core prompt builder must not re-own ComputerUse environment guidance; use openbitfun-agent-runtime::prompt',
      },
      {
        regex: /\bfn computer_use_key_chord_guidance\b/,
        message:
          'core prompt builder must not re-own prompt environment guidance helpers; use openbitfun-agent-runtime::prompt',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/host_dispatch.rs',
    patterns: [
      {
        regex: /\btokio::fs\b/,
        message:
          'core MiniApp host-dispatch adapter must not own filesystem execution; use openbitfun-services-integrations::miniapp::host_dispatch',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message:
          'core MiniApp host-dispatch adapter must not own shell process execution; use openbitfun-services-integrations::miniapp::host_dispatch',
      },
      {
        regex: /\breqwest::Client\b/,
        message:
          'core MiniApp host-dispatch adapter must not own net.fetch execution; use openbitfun-services-integrations::miniapp::host_dispatch',
      },
      {
        regex: /\basync fn dispatch_fs\b/,
        message:
          'core MiniApp host-dispatch adapter must not re-own fs dispatch helpers',
      },
      {
        regex: /\basync fn dispatch_shell\b/,
        message:
          'core MiniApp host-dispatch adapter must not re-own shell dispatch helpers',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/miniapp/host_dispatch.rs',
    patterns: [
      {
        regex: /\bresolve_policy\s*\(/,
        message:
          'services MiniApp host-dispatch must use MiniAppPermissionPolicyRequest for permission path adaptation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/js_worker.rs',
    patterns: [
      {
        regex: /\btokio::process\b/,
        message:
          'core MiniApp JS worker facade must not own worker process types; use openbitfun-services-integrations::miniapp::worker',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message:
          'core MiniApp JS worker facade must not spawn worker processes; use openbitfun-services-integrations::miniapp::worker',
      },
      {
        regex: /\bPendingResponseMap\b/,
        message:
          'core MiniApp JS worker facade must not own JSON-RPC response routing; use openbitfun-services-integrations::miniapp::worker',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/js_worker_pool.rs',
    patterns: [
      {
        regex: /\bworker_pool_at_capacity\b/,
        message:
          'core MiniApp worker pool facade must not own pool policy; use openbitfun-services-integrations::miniapp::worker_pool',
      },
      {
        regex: /\bselect_lru_worker\b/,
        message:
          'core MiniApp worker pool facade must not own LRU policy; use openbitfun-services-integrations::miniapp::worker_pool',
      },
      {
        regex: /\bplan_install_deps\b/,
        message:
          'core MiniApp worker pool facade must not own install-deps planning; use openbitfun-services-integrations::miniapp::worker_pool',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message:
          'core MiniApp worker pool facade must not execute install-deps processes; use openbitfun-services-integrations::miniapp::worker_pool',
      },
      {
        regex: /\bHashMap<String, WorkerEntry>\b/,
        message:
          'core MiniApp worker pool facade must not own worker pool state; use openbitfun-services-integrations::miniapp::worker_pool',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/storage.rs',
    patterns: [
      {
        regex: /\btokio::fs\b/,
        message:
          'core MiniApp storage facade must not own filesystem IO; use openbitfun-services-integrations::miniapp::storage',
      },
      {
        regex: /\bMiniAppStorageLayout\b/,
        message:
          'core MiniApp storage facade must not own storage layout logic; use openbitfun-services-integrations::miniapp::storage',
      },
      {
        regex: /\bbuild_package_json\b/,
        message:
          'core MiniApp storage facade must not own package-json storage assembly; use openbitfun-services-integrations::miniapp::storage',
      },
      {
        regex: /\bparse_npm_dependencies\b/,
        message:
          'core MiniApp storage facade must not own package-json dependency parsing; use openbitfun-services-integrations::miniapp::storage',
      },
      {
        regex: /\bDRAFTS_CLEANUP_MARKER\b/,
        message:
          'core MiniApp storage facade must not own draft cleanup marker IO; use openbitfun-services-integrations::miniapp::storage',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/function_agents/port_adapters.rs',
    patterns: [
      {
        regex: /\bCoreFunctionAgentGitService\b/,
        message:
          'core function-agent port adapters must not re-own Git concrete snapshots; use openbitfun-services-integrations::function_agents',
      },
      {
        regex: /\bgit_stdout_lenient\b/,
        message:
          'core function-agent port adapters must not re-own lenient Git process fallback; use openbitfun-services-integrations::function_agents',
      },
      {
        regex: /\bGitService::get_status\b/,
        message:
          'core function-agent port adapters must not re-own Git status snapshots; use openbitfun-services-integrations::function_agents',
      },
      {
        regex: /\bcreate_command\("git"\)/,
        message:
          'core function-agent port adapters must not spawn Git concrete commands; use openbitfun-services-integrations::function_agents',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/src/lib.rs',
    patterns: [
      {
        regex: /\bpub enum ProductCapabilityBuildError\b/,
        message:
          'product-capabilities must not redefine tool provider group selection errors; use openbitfun-tool-packs',
      },
      {
        regex: /\bproduct_tool_provider_group_plan\(\)\b/,
        message:
          'product-capabilities must not scan product tool provider plans locally; use openbitfun-tool-packs selector',
      },
      {
        regex: /\bdefault_product_tool_provider_group_plan\b/,
        message:
          'product-capabilities must expose product assembly, not a separate default tool-provider plan shortcut',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/filesystem/service.rs',
    patterns: [
      {
        regex: /\btokio::fs::/,
        message:
          'core filesystem service must not own async local filesystem IO; use openbitfun-services-core filesystem primitives',
      },
      {
        regex: /\bstd::fs::/,
        message:
          'core filesystem service must not own sync local filesystem IO; use openbitfun-services-core filesystem primitives',
      },
      {
        regex: /\bignore::WalkBuilder\b/,
        message:
          'core filesystem service must not own local file walking/search implementation; use openbitfun-services-core filesystem primitives',
      },
      {
        regex: /\bsha2::/,
        message:
          'core filesystem service must not own editor-sync hashing implementation; use openbitfun-services-core filesystem primitives',
      },
      {
        regex: /\bbase64::/,
        message:
          'core filesystem service must not own binary file encoding implementation; use openbitfun-services-core filesystem primitives',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/service.rs',
    patterns: [
      {
        regex: /\bManagedClient\b/,
        message:
          'core workspace-search facade must not own flashgrep daemon clients; use openbitfun-services-integrations::workspace_search',
      },
      {
        regex: /\bRepoSession\b/,
        message:
          'core workspace-search facade must not own flashgrep repo sessions; use openbitfun-services-integrations::workspace_search',
      },
      {
        regex: /\bwith_scan_fallback\b/,
        message:
          'core workspace-search facade must not own scan fallback policy; use openbitfun-services-integrations::workspace_search',
      },
      {
        regex: /\bconvert_hits_to_file_search_results\b/,
        message:
          'core workspace-search facade must not own hit conversion; use openbitfun-services-integrations::workspace_search',
      },
      {
        regex: /\bsplit_preview\b/,
        message:
          'core workspace-search facade must not own preview mapping; use openbitfun-services-integrations::workspace_search',
      },
      {
        regex: /\bdunce::canonicalize\b/,
        message:
          'core workspace-search facade must not own local search path normalization; use openbitfun-services-integrations::workspace_search',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/mod.rs',
    patterns: [
      {
        regex: /\bopenbitfun_services_integrations::workspace_search::flashgrep\b/,
        message:
          'core must not import flashgrep internals; use the remote workspace-search stdio facade instead',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/service.rs',
    patterns: [
      {
        regex:
          /\b(?:owner::flashgrep|workspace_search::flashgrep|openbitfun_services_integrations::workspace_search::flashgrep)\b/,
        message:
          'core workspace search facade must not depend on flashgrep internals; use stable workspace-search config and DTO APIs',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/remote.rs',
    patterns: [
      {
        regex: /\blookup_remote_connection(?:_scoped|_with_hint)?\b/,
        message: 'remote search must use the ID-bound workspace object, never reselect a workspace by a path',
      },
      {
        regex: /\bconst\s+REMOTE_FLASHGREP_INSTALL_DIR\b/,
        message:
          'core remote workspace search must not own remote flashgrep install facts; use openbitfun-services-integrations::remote_ssh::workspace_search',
      },
      {
        regex: /\bconst\s+REMOTE_(?:OS|ARCHITECTURE)_PROBES\b/,
        message:
          'core remote workspace search must not own remote probe facts; use openbitfun-services-integrations::remote_ssh::workspace_search',
      },
      {
        regex: /\bstruct\s+LocalFlashgrepBundle\b/,
        message:
          'core remote workspace search must not own local remote-search bundle DTOs; use openbitfun-services-integrations::remote_ssh::workspace_search',
      },
      {
        regex:
          /\bfn\s+(?:build_remote_scope|normalize_remote_scope_path|remote_flashgrep_install_dir|parse_remote_architecture_output|parse_remote_os_output|local_flashgrep_bundle_for_arch|remote_stdio_search_mode|should_retry_remote_scan_fallback_as_files_with_matches|join_remote_path|shell_escape)\b/,
        message:
          'core remote workspace search must not re-own provider-neutral remote search strategy helpers',
      },
      {
        regex: /\b(?:RemoteStdioRepoSession|RemoteStdioDaemonClient|RemoteSearchContext|REMOTE_STDIO_SESSIONS|REMOTE_SEARCH_CONTEXTS)\b/,
        message:
          'core remote workspace search must not own remote flashgrep session/context lifecycle; use openbitfun-services-integrations::remote_ssh::workspace_search',
      },
      {
        regex: /\bfn\s+(?:ensure_remote_search_context|convert_stdio_search_results|remote_stdio_session_key|remote_search_context_key|schedule_remote_stdio_session_release)\b/,
        message:
          'core remote workspace search must not re-own remote search concrete lifecycle helpers',
      },
      {
        regex:
          /\b(?:ProtocolClient|drain_content_length_messages|log_flashgrep_stderr_line_with_context|FLASHGREP_LOG_TARGET)\b/,
        message:
          'core remote workspace search must not depend on flashgrep protocol internals; use RemoteWorkspaceSearchStdioProtocol',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/workspace_search/mod.rs',
    patterns: [
      {
        regex: /\bpub\s+mod\s+flashgrep\b/,
        message:
          'workspace_search must not publicly expose flashgrep protocol internals',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/mod.rs',
    patterns: [
      {
        regex:
          /\bpub\s+(?:const|struct|fn)\s+(?:REMOTE_OS_PROBES|REMOTE_ARCHITECTURE_PROBES|LocalFlashgrepBundle|build_remote_scope|remote_flashgrep_install_dir|remote_workspace_search_storage_root|looks_like_linux_workspace_root|parse_remote_architecture_output|parse_remote_os_output|local_flashgrep_bundle_for_arch|remote_stdio_search_mode|should_retry_remote_scan_fallback_as_files_with_matches|join_remote_path|shell_escape)\b/,
        message:
          'remote workspace-search helper APIs must stay crate-internal; expose only reviewed provider/service contracts',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/runtime_detect.rs',
    patterns: [
      {
        regex: /\bCoreMiniAppRuntimeProbe\b/,
        message:
          'core MiniApp runtime_detect must remain a compatibility facade; concrete probe owner is product-domains',
      },
      {
        regex: /\bwhich::which\b/,
        message:
          'core MiniApp runtime_detect must not own PATH lookup; use product-domain runtime detection',
      },
      {
        regex: /\bcreate_command\b/,
        message:
          'core MiniApp runtime_detect must not own version process execution; use product-domain runtime detection',
      },
      {
        regex: /\bstd::fs::read_dir\b/,
        message:
          'core MiniApp runtime_detect must not own version-manager directory scanning; use product-domain runtime detection',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/prompt_builder/user_context.rs',
    patterns: [
      {
        regex: /\bpub\s+enum\s+UserContextSection\b/,
        message:
          'core prompt builder must not own user-context section facts; use openbitfun-agent-runtime prompt contracts',
      },
      {
        regex: /\bpub\s+struct\s+UserContextPolicy\b/,
        message:
          'core prompt builder must not own user-context policy facts; use openbitfun-agent-runtime prompt contracts',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/mod.rs',
    patterns: [
      {
        regex: /\bpub const STANDARD_HARNESS_PROMPT_TEMPLATE\b/,
        message:
          'core agent mode module must not own Standard Harness prompt facts; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bpub const STANDARD_HARNESS_CONFIG_ID\b/,
        message:
          'core agent mode module must not own Standard Harness config profile facts; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bpub const STANDARD_HARNESS_CONFIG_MEMBERS\b/,
        message:
          'core agent mode module must not own Standard Harness membership facts; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bpub fn resolve_mode_config_profile_id\b/,
        message:
          'core agent mode module must not own mode config profile resolution; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bpub fn mode_config_profile_member_mode_ids\b/,
        message:
          'core agent mode module must not own mode config profile membership; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bpub fn mode_config_profile_label\b/,
        message:
          'core agent mode module must not own mode config profile labels; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bpub fn standard_harness_user_context_policy\b/,
        message:
          'core agent mode module must not own Standard Harness context policy; use openbitfun-agent-runtime agents',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/query.rs',
    patterns: [
      {
        regex: /"agentic"\s*=>\s*0[\s\S]*"Cowork"\s*=>\s*1/,
        message:
          'core agent registry query must not own mode presentation order; use openbitfun-agent-runtime agents',
      },
      {
        regex: /\bfn subagent_source_rank\b/,
        message:
          'core agent registry query must not own subagent source presentation rank; use openbitfun-agent-runtime agents',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/types.rs',
    patterns: [
      {
        regex: /\bpub enum SubAgentSource\b/,
        message:
          'core agent registry must not own subagent source DTOs; use openbitfun-agent-runtime agents',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/prompt_cache.rs',
    patterns: [
      {
        regex: /\bpub const PROMPT_CACHE_SCHEMA_VERSION\b/,
        message:
          'core prompt cache must not own prompt-cache schema facts; use openbitfun-agent-runtime prompt_cache',
      },
      {
        regex: /\bpub struct PromptCachePolicy\b/,
        message:
          'core prompt cache must not own prompt-cache policy; use openbitfun-agent-runtime prompt_cache',
      },
      {
        regex: /\bpub struct SessionPromptCache\b/,
        message:
          'core prompt cache must not own prompt-cache DTOs; use openbitfun-agent-runtime prompt_cache',
      },
      {
        regex: /\bpub enum PromptCacheScope\b/,
        message:
          'core prompt cache must not own prompt-cache invalidation scope; use openbitfun-agent-runtime prompt_cache',
      },
      {
        regex: /\bpub struct SessionPromptCacheStore\b/,
        message:
          'core prompt cache must not own in-memory prompt-cache store; use openbitfun-agent-runtime prompt_cache',
      },
      {
        regex: /\bpub enum PromptCacheLookup\b/,
        message:
          'core prompt cache must not own prompt-cache lookup outcomes; use openbitfun-agent-runtime prompt_cache',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/review_read_receipt.rs',
    patterns: [
      {
        regex: /\bpub struct FileRevision\b/,
        message:
          'core review_read_receipt must not own file revision DTOs; use openbitfun-agent-runtime review_read_receipt',
      },
      {
        regex: /\bpub struct ReviewReadCoverage\b/,
        message:
          'core review_read_receipt must not own review coverage DTOs; use openbitfun-agent-runtime review_read_receipt',
      },
      {
        regex: /\bpub struct ReviewReadReceiptStore\b/,
        message:
          'core review_read_receipt must not own the receipt store; use openbitfun-agent-runtime review_read_receipt',
      },
      {
        regex: /\bDashMap\b/,
        message:
          'core review_read_receipt must not own receipt storage maps; use openbitfun-agent-runtime review_read_receipt',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/evidence_ledger.rs',
    patterns: [
      {
        regex: /\bpub enum EvidenceLedgerTargetKind\b/,
        message:
          'core evidence_ledger must not own evidence ledger DTOs; use openbitfun-agent-runtime evidence_ledger',
      },
      {
        regex: /\bpub struct EvidenceLedgerEvent\b/,
        message:
          'core evidence_ledger must not own evidence ledger events; use openbitfun-agent-runtime evidence_ledger',
      },
      {
        regex: /\bpub struct SessionEvidenceLedger\b/,
        message:
          'core evidence_ledger must not own evidence ledger store; use openbitfun-agent-runtime evidence_ledger',
      },
      {
        regex: /\bimpl From<EvidenceLedgerSummary> for CompressionContract\b/,
        message:
          'core evidence_ledger must not own compression contract projection; use openbitfun-agent-runtime evidence_ledger',
      },
      {
        regex: /\buuid::Uuid::new_v4\b/,
        message:
          'core evidence_ledger must not own evidence ledger event id generation; use openbitfun-agent-runtime evidence_ledger',
      },
      {
        regex: /\bDashMap\b/,
        message:
          'core evidence_ledger must not own evidence ledger storage maps; use openbitfun-agent-runtime evidence_ledger',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_context_runtime.rs',
    patterns: [
      {
        regex: /\bimpl From<LightCheckpoint> for EvidenceLedgerCheckpoint\b/,
        message:
          'core tool context runtime must not own checkpoint evidence projection; use openbitfun-agent-runtime evidence_ledger',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'core tool context runtime must consume injected terminal ports, not construct the concrete terminal provider',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/user_input_manager.rs',
    patterns: [
      {
        regex: /\bpub struct UserInputManager\b/,
        message:
          'core user_input_manager must not own user-input channel state; use openbitfun-agent-runtime user_questions',
      },
      {
        regex: /\boneshot::Sender\b/,
        message:
          'core user_input_manager must not own user-input wait channels; use openbitfun-agent-runtime user_questions',
      },
      {
        regex: /\bDashMap\b/,
        message:
          'core user_input_manager must not own user-input channel storage; use openbitfun-agent-runtime user_questions',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
    patterns: [
      {
        regex: /\bpub enum ConfirmationResponse\b/,
        message:
          'core tool pipeline must not reintroduce legacy confirmation channel responses; use permission requests',
      },
      {
        regex: /\boneshot::Sender<\s*ConfirmationResponse\s*>/,
        message:
          'core tool pipeline must not reintroduce legacy confirmation wait-channel storage; use permission requests',
      },
      {
        regex: /\bArc<DashMap<String,\s*CancellationToken>>\b/,
        message:
          'core tool pipeline must not own cancellation token storage; use tool-runtime pipeline',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/execution/round_executor.rs',
    patterns: [
      {
        regex: /\bArc<DashMap<String,\s*CancellationToken>>\b/,
        message:
          'core round executor must not own dialog-turn cancellation token storage; use openbitfun-agent-runtime turn_cancellation',
      },
      {
        regex: /\bcancellation_tokens:\s*Arc<DashMap\b/,
        message:
          'core round executor must not reintroduce DashMap-backed cancellation token storage',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/background_command_output.rs',
    patterns: [
      {
        regex: /\bpub struct BackgroundCommandOutputCapture\b/,
        message:
          'core exec_command output path must not own background output capture; use tool-runtime background_command_output',
      },
      {
        regex: /\bpub enum BackgroundCommandOutputStatus\b/,
        message:
          'core exec_command output path must not own background output status; use tool-runtime background_command_output',
      },
      {
        regex: /\bVecDeque\b/,
        message:
          'core exec_command output path must not own retained output buffers; use tool-runtime background_command_output',
      },
      {
        regex: /\bmpsc::UnboundedSender\b/,
        message:
          'core exec_command output path must not own background output capture channels; use tool-runtime background_command_output',
      },
      {
        regex: /\btokio::spawn\b/,
        message:
          'core exec_command output path must not own background output capture tasks; use tool-runtime background_command_output',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/command.rs',
    patterns: [
      {
        regex: /\bconst\s+POWERSHELL_UTF8_OUTPUT_PREFIX\b/,
        message:
          'core exec_command adapter must not own PowerShell shell policy; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+REMOTE_NON_TTY_INTERRUPT_GRACE_SECONDS\b/,
        message:
          'core exec_command adapter must not own remote non-TTY lifecycle policy; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+DEFAULT_TOOL_YIELD_TIME_MS\b/,
        message:
          'core exec_command adapter must not own ExecCommand default wait policy; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+(?:local|remote)_completion_value\b/,
        message:
          'core exec_command adapter must not own ExecCommand completion value shaping; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+(?:local|remote)_completion\b/,
        message:
          'core exec_command adapter must not duplicate concrete completion mapping; use exec_command completion adapter',
      },
      {
        regex: /\bfn\s+(?:local|remote)_background_output_status_for_completion\b/,
        message:
          'core exec_command adapter must not own ExecCommand background status shaping; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+merged_remote_env\b/,
        message:
          'core exec_command adapter must not own remote env merge policy; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+remote_command_env_words\b/,
        message:
          'core exec_command adapter must not own remote env rendering; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+shell_escape\b/,
        message:
          'core exec_command adapter must not own shell escaping policy; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+is_plausible_remote_shell_path\b/,
        message:
          'core exec_command adapter must not own remote shell probe validation; use tool-runtime exec_command',
      },
      {
        regex: /\bgetent\s+passwd\b/,
        message:
          'core exec_command adapter must not own remote shell probe command text; use tool-runtime exec_command',
      },
      {
        regex: /\bcommand\s+-v\s+bash\b/,
        message:
          'core exec_command adapter must not own remote shell fallback probe text; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+REMOTE_SHELL_PROBE_TIMEOUT_MS\b/,
        message:
          'core exec_command adapter must not own remote shell probe timeout; use tool-runtime exec_command',
      },
      {
        regex: /\bget_global_exec_process_manager\b/,
        message:
          'core local ExecCommand adapter must not call the global local process manager; use injected TerminalPort',
      },
      {
        regex: /\bget_global_remote_exec_process_manager\b/,
        message:
          'core remote ExecCommand adapter must not call the global remote process manager; use injected RemoteExecPort',
      },
      {
        regex: /\bSSHConnectionManager\b/,
        message:
          'core remote ExecCommand adapter must not depend on concrete SSH managers; use injected RemoteExecPort',
      },
      {
        regex: /\bSSHCommandOptions\b/,
        message:
          'core remote ExecCommand adapter must not depend on concrete SSH command options; use injected RemoteExecPort',
      },
      {
        regex: /\bLocalExecCommandRequest\b/,
        message:
          'core local ExecCommand adapter must not construct local process-manager requests; use TerminalExecCommandRequest',
      },
      {
        regex: /\bCoreRuntimeServicesProvider::terminal_port\b/,
        message:
          'core local ExecCommand adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'core local ExecCommand adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/stdin.rs',
    patterns: [
      {
        regex: /\bconst\s+DEFAULT_TOOL_YIELD_TIME_MS\b/,
        message:
          'core WriteStdin adapter must not own default wait policy; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+(?:local|remote)_completion_value\b/,
        message:
          'core WriteStdin adapter must not own completion value shaping; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+(?:local|remote)_completion\b/,
        message:
          'core WriteStdin adapter must not duplicate concrete completion mapping; use exec_command completion adapter',
      },
      {
        regex: /"status"\s*:\s*"session_not_found"/,
        message:
          'core WriteStdin adapter must not own session-not-found result shape; use tool-runtime exec_command',
      },
      {
        regex: /\bNo input was sent\b/,
        message:
          'core WriteStdin adapter must not own session-not-found assistant text; use tool-runtime exec_command',
      },
      {
        regex: /\bget_global_exec_process_manager\b/,
        message:
          'core local WriteStdin adapter must not call the global local process manager; use injected TerminalPort',
      },
      {
        regex: /\bget_global_remote_exec_process_manager\b/,
        message:
          'core remote WriteStdin adapter must not call the global remote process manager; use injected RemoteExecPort',
      },
      {
        regex: /\bRemoteExecError\b/,
        message:
          'core remote WriteStdin adapter must not match concrete remote exec errors; use PortErrorKind',
      },
      {
        regex: /\bLocalWriteStdinRequest\b/,
        message:
          'core local WriteStdin adapter must not construct local process-manager requests; use TerminalWriteStdinRequest',
      },
      {
        regex: /\bCoreRuntimeServicesProvider::terminal_port\b/,
        message:
          'core local WriteStdin adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'core local WriteStdin adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/control.rs',
    patterns: [
      {
        regex: /\bexec_command_control_action_name\b/,
        message:
          'core ExecControl adapter must not own action result value shaping; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+(?:local|remote)_completion\b/,
        message:
          'core ExecControl adapter must not duplicate concrete completion mapping; use exec_command completion adapter',
      },
      {
        regex: /\bget_global_exec_process_manager\b/,
        message:
          'core local ExecControl adapter must not call the global local process manager; use injected TerminalPort',
      },
      {
        regex: /\bget_global_remote_exec_process_manager\b/,
        message:
          'core remote ExecControl adapter must not call the global remote process manager; use injected RemoteExecPort',
      },
      {
        regex: /\bRemoteExecError\b/,
        message:
          'core remote ExecControl adapter must not match concrete remote exec errors; use PortErrorKind',
      },
      {
        regex: /\bLocalExecControlRequest\b/,
        message:
          'core local ExecControl adapter must not construct local process-manager requests; use TerminalExecControlRequest',
      },
      {
        regex: /\bCoreRuntimeServicesProvider::terminal_port\b/,
        message:
          'core local ExecControl adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'core local ExecControl adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/input.rs',
    patterns: [
      {
        regex: /\bget_global_exec_process_manager\b/,
        message:
          'core local ExecCommand input adapter must not call the global local process manager; use injected TerminalPort',
      },
      {
        regex: /\bget_global_remote_exec_process_manager\b/,
        message:
          'core remote ExecCommand input adapter must not call the global remote process manager; use injected RemoteExecPort',
      },
      {
        regex: /\bLocalSendStdinRequest\b/,
        message:
          'core local ExecCommand input adapter must not construct local process-manager requests; use TerminalSendStdinRequest',
      },
      {
        regex: /\bCoreRuntimeServicesProvider::terminal_port\b/,
        message:
          'core local ExecCommand input adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
      {
        regex: /\bTerminalRuntimePort\b/,
        message:
          'core local ExecCommand input adapter must not construct concrete terminal providers; use injected TerminalPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/env_snapshot.rs',
    patterns: [
      {
        regex: /\bconst\s+ENV_SNAPSHOT_BEGIN\b/,
        message:
          'core exec_command env snapshot adapter must not own snapshot framing; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+ENV_SNAPSHOT_END\b/,
        message:
          'core exec_command env snapshot adapter must not own snapshot framing; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+should_import_env_var\b/,
        message:
          'core exec_command env snapshot adapter must not own env import policy; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+is_valid_env_var_name\b/,
        message:
          'core exec_command env snapshot adapter must not own env name validation; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+is_volatile_env_var\b/,
        message:
          'core exec_command env snapshot adapter must not own volatile env filtering; use tool-runtime exec_command',
      },
      {
        regex: /\bfn\s+shell_escape\b/,
        message:
          'core exec_command env snapshot adapter must not own shell escaping policy; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+ENV_SNAPSHOT_TIMEOUT_MS\b/,
        message:
          'core exec_command env snapshot adapter must not own snapshot capture timeout; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+ENV_SNAPSHOT_MAX_OUTPUT_CHARS\b/,
        message:
          'core exec_command env snapshot adapter must not own snapshot capture output bounds; use tool-runtime exec_command',
      },
      {
        regex: /\bconst\s+ENV_SNAPSHOT_TTL\b/,
        message:
          'core exec_command env snapshot adapter must not own snapshot cache ttl; use tool-runtime exec_command',
      },
      {
        regex: /\bget_global_remote_exec_process_manager\b/,
        message:
          'core exec_command env snapshot adapter must not call the global remote process manager; use injected RemoteExecPort',
      },
      {
        regex: /\bSSHConnectionManager\b/,
        message:
          'core exec_command env snapshot adapter must not depend on concrete SSH managers; use injected RemoteExecPort',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/computer_use_optimizer.rs',
    patterns: [
      {
        regex: /\bpub struct ComputerUseOptimizer\b/,
        message:
          'core Computer Use optimizer facade must not own optimizer state; use tool-runtime computer_use',
      },
      {
        regex: /\bVecDeque\b/,
        message:
          'core Computer Use optimizer facade must not own action history storage; use tool-runtime computer_use',
      },
      {
        regex: /\bpub fn hash_screenshot_bytes\b/,
        message:
          'core Computer Use optimizer facade must not own screenshot hashing; use tool-runtime computer_use',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/turn_skill_agent_snapshot_store.rs',
    patterns: [
      {
        regex: /\bpub struct TurnSkillAgentSnapshotStore\b/,
        message:
          'core turn_skill_agent_snapshot_store must not own in-memory skill/agent snapshot store; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bDashMap\b/,
        message:
          'core turn_skill_agent_snapshot_store must not own skill/agent snapshot storage maps; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bBTreeMap\b/,
        message:
          'core turn_skill_agent_snapshot_store must not own sparse turn snapshot ordering; use openbitfun-agent-runtime skill_agent_snapshot',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/skill_agent_snapshot.rs',
    patterns: [
      {
        regex: /\bpub struct SkillSnapshotEntry\b/,
        message:
          'core skill_agent_snapshot must not own skill snapshot DTOs; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bpub struct AgentSnapshotEntry\b/,
        message:
          'core skill_agent_snapshot must not own agent snapshot DTOs; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bpub struct TurnSkillAgentSnapshot\b/,
        message:
          'core skill_agent_snapshot must not own turn snapshot DTOs; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bpub struct SkillAgentDiff\b/,
        message:
          'core skill_agent_snapshot must not own skill/agent diff contracts; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bpub fn diff_skill_agent_snapshot\b/,
        message:
          'core skill_agent_snapshot must not own skill/agent diff rendering; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bfn render_titled_skill_entries\b/,
        message:
          'core skill_agent_snapshot must not own skill update rendering helpers; use openbitfun-agent-runtime skill_agent_snapshot',
      },
      {
        regex: /\bfn render_titled_subagent_entries\b/,
        message:
          'core skill_agent_snapshot must not own agent update rendering helpers; use openbitfun-agent-runtime skill_agent_snapshot',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/prompt_builder/prompt_builder_impl.rs',
    patterns: [
      {
        regex: /\bpub\s+struct\s+ToolListingSections\b/,
        message:
          'core prompt builder must not own tool-listing reminder facts; use openbitfun-agent-runtime prompt contracts',
      },
      {
        regex: /\bpub\s+struct\s+PrependedPromptReminders\b/,
        message:
          'core prompt builder must not own prepended-reminder ordering facts; use openbitfun-agent-runtime prompt contracts',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/execution/types.rs',
    patterns: [
      {
        regex: /\bpub\s+enum\s+FinishReason\b/,
        message:
          'core execution types must not own finish-reason event facts; use openbitfun-agent-runtime events',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/events/types.rs',
    patterns: [
      {
        regex: /SessionState::Idle\s*=>\s*"idle"/,
        message:
          'core event types must not own session-state wire labels; use openbitfun-agent-runtime events',
      },
      {
        regex: /SessionState::Processing\s*\{[^}]*\}\s*=>\s*"processing"/,
        message:
          'core event types must not own session-state wire labels; use openbitfun-agent-runtime events',
      },
      {
        regex: /SessionState::Error\s*\{[^}]*\}\s*=>\s*"error"/,
        message:
          'core event types must not own session-state wire labels; use openbitfun-agent-runtime events',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/state_manager.rs',
    patterns: [
      {
        regex: /\bpub\s+struct\s+SessionStateManager\b/,
        message:
          'core session state manager path must remain a compatibility facade; use openbitfun-agent-runtime session_state_manager',
      },
      {
        regex: /\bDashMap\b/,
        message:
          'core session state manager path must not own session state storage; use openbitfun-agent-runtime session_state_manager',
      },
      {
        regex: /\bAgenticEvent::SessionStateChanged\b/,
        message:
          'core session state manager path must not emit session-state events directly; use openbitfun-agent-runtime session_state_manager',
      },
      {
        regex: /\bimpl\s+SessionStateManager\b/,
        message:
          'core session state manager path must not reimplement session state transitions; use openbitfun-agent-runtime session_state_manager',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
    patterns: [
      {
        regex: /\bconst\s+MAX_QUEUE_DEPTH\b/,
        message:
          'core scheduler must not own dialog queue capacity; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /\bstd::collections::VecDeque\b/,
        message:
          'core scheduler must not own dialog queue storage; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /\bactive_turns:\s*Arc<dashmap::DashMap\b/,
        message:
          'core scheduler must not own active-turn state maps; use openbitfun-agent-runtime scheduler stores',
      },
      {
        regex: /\bstruct\s+ActiveTurn\b/,
        message:
          'core scheduler must not own active-turn facts; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /\bfn\s+format_agent_session_reply\b/,
        message:
          'core scheduler must not own agent-session reply text assembly; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /automated reply to a previous SessionMessage call/,
        message:
          'core scheduler must not own agent-session reply reminder text; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /RoundInjectionKind::UserSteering/,
        message:
          'core scheduler must not own steering injection construction; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /RoundInjectionTarget::ExactTurn/,
        message:
          'core scheduler must not own steering exact-turn targeting; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /RoundInjectionKind::ThreadGoalObjectiveUpdated/,
        message:
          'core scheduler must not own thread-goal background injection construction; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /RoundInjectionKind::BackgroundResult/,
        message:
          'core scheduler must not own background result injection construction; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /RoundInjectionTarget::CurrentRunningTurn/,
        message:
          'core scheduler must not own current-turn background injection targeting; use openbitfun-agent-runtime scheduler',
      },
      {
        regex: /\bfn\s+turn_outcome_kind\s*\(/,
        message:
          'core scheduler must not own turn-outcome event facts; use openbitfun-agent-runtime events',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/framework.rs',
    patterns: [
      {
        regex: /\bpub struct DynamicMcpToolInfo\b/,
        message: 'core tool framework must not redefine DynamicMcpToolInfo; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct DynamicToolInfo\b/,
        message: 'core tool framework must not redefine DynamicToolInfo; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ToolRenderOptions\b/,
        message: 'core tool framework must not redefine ToolRenderOptions; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub enum ToolPathBackend\b/,
        message: 'core tool framework must not redefine ToolPathBackend; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ToolPathResolution\b/,
        message: 'core tool framework must not redefine ToolPathResolution; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ToolContextFacts\b/,
        message: 'core tool framework must not redefine ToolContextFacts; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub enum ToolWorkspaceKind\b/,
        message: 'core tool framework must not redefine ToolWorkspaceKind; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ToolUseContext\b/,
        message:
          'core tool framework must not own ToolUseContext; re-export it from tool_context_runtime',
      },
      {
        regex: /\bcall_with_tool_runtime_hooks\b/,
        message:
          'core tool framework must not wire runtime hooks directly; delegate through tool_context_runtime',
      },
      {
        regex: /\bdeep_review_shared_context_measurement_snapshot\b/,
        message:
          'core tool framework must not own runtime hook regressions; keep them in tool_context_runtime',
      },
      {
        regex: /\bget_global_coordinator\b/,
        message:
          'core tool framework must not own runtime checkpoint coordination; keep it in tool_context_runtime',
      },
      {
        regex: /\bGitService\b/,
        message:
          'core tool framework must not own git-backed checkpoint runtime; keep it in tool_context_runtime',
      },
      {
        regex: /\bget_workspace_runtime_service_arc\b/,
        message:
          'core tool framework must not own workspace runtime lookup; keep it in tool_context_runtime',
      },
      {
        regex: /\bremote_workspace_runtime_root\b/,
        message:
          'core tool framework must not own remote runtime-root lookup; keep it in tool_context_runtime',
      },
      {
        regex: /\bget_path_manager_arc\b/,
        message:
          'core tool framework must not own host runtime-root lookup; keep it in tool_context_runtime',
      },
      {
        regex: /\bpost_call_hooks::record_successful_tool_call\b/,
        message:
          'core tool framework must not own post-call runtime hooks; keep them in tool_context_runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'tool pipeline must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
      {
        regex: /\bfn serialize_result_for_assistant\b/,
        message:
          'core tool pipeline must not own provider-neutral assistant result rendering; use openbitfun-agent-tools',
      },
      {
        regex: /\bconst TOOL_ERROR_ARGUMENTS_PREVIEW_BYTES\b/,
        message:
          'core tool pipeline must not own tool error argument preview limits; use openbitfun-agent-tools',
      },
      {
        regex: /\bfn truncate_arguments_preview\b/,
        message:
          'core tool pipeline must not own tool error argument preview rendering; use openbitfun-agent-tools',
      },
      {
        regex: /\bfn truncate_raw_arguments_preview\b/,
        message:
          'core tool pipeline must not own raw tool argument preview rendering; use openbitfun-agent-tools',
      },
      {
        regex: /\bconst USER_STEERING_INTERRUPTED_MESSAGE\b/,
        message:
          'core tool pipeline must not own steering-interrupted result presentation; use openbitfun-agent-tools',
      },
      {
        regex: /\bfn build_truncation_recovery_notice\b/,
        message:
          'core tool pipeline must not own truncation recovery notice policy; use openbitfun-agent-tools',
      },
      {
        regex: /\bfn is_write_like_tool_name\b/,
        message:
          'core tool pipeline must not own write-like truncation classification; use openbitfun-agent-tools',
      },
      {
        regex: /\bstruct\s+ToolBatch\b/,
        message:
          'core tool pipeline must not own portable batching DTOs; use tool-runtime::pipeline',
      },
      {
        regex: /\bfn\s+partition_tool_batches\b/,
        message:
          'core tool pipeline must not own portable batching strategy; use tool-runtime::pipeline',
      },
      {
        regex: /Duration::from_millis\(100\s*\*\s*attempts/,
        message:
          'core tool pipeline must not own retry backoff policy; use tool-runtime::pipeline',
      },
      {
        regex: /\blet\s+mut\s+cancelled_count\b/,
        message:
          'core tool pipeline must not own dialog-turn cancellation summary policy; use tool-runtime::pipeline',
      },
      {
        regex: /ToolConfirmationOutcome::(?:Rejected|ChannelClosed|Timeout)/,
        message:
          'core tool pipeline must not reintroduce legacy confirmation wait-result mapping; use permission requests',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline/state_manager.rs',
    patterns: [
      {
        regex: /\bstats\.(?:queued|waiting|running|streaming|awaiting_confirmation|completed|failed|cancelled)\s*\+=/,
        message:
          'core tool state manager must not own provider-neutral state counting; use tool-runtime::pipeline',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_context_runtime.rs',
    patterns: [
      {
        regex: /remote_workspace_git_metadata_unavailable|workspace_unavailable|git_status_unavailable:/,
        message:
          'core tool context must not own light-checkpoint summary policy; use openbitfun-agent-runtime::checkpoint',
      },
      {
        regex: /format!\(\s*"staged=\{\}, unstaged=\{\}, untracked=\{\}"/,
        message:
          'core tool context must not own local git dirty-state checkpoint formatting; use openbitfun-agent-runtime::checkpoint',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/definitions/custom/subagent.rs',
    patterns: [
      {
        regex: /\bFrontMatterMarkdown\b/,
        message:
          'core custom subagent facade must not own markdown front-matter IO; use openbitfun-agent-runtime',
      },
      {
        regex: /\bserde_yaml::Mapping\b/,
        message:
          'core custom subagent facade must not own markdown metadata serialization; use openbitfun-agent-runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/custom.rs',
    patterns: [
      {
        regex: /\bCustomSubagentLoader\b/,
        message:
          'core custom subagent registry must not restore the old loader owner; use openbitfun-agent-runtime discovery report',
      },
      {
        regex: /\bread_dir\b/,
        message:
          'core custom subagent registry must not own directory scanning; use openbitfun-agent-runtime discovery report',
      },
      {
        regex: /\.extension\(\)\.is_some_and\(\|ext\|\s*ext\s*==\s*"md"\)/,
        message:
          'core custom subagent registry must not own markdown file discovery; use openbitfun-agent-runtime discovery report',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/subagent_runtime/mod.rs',
    patterns: [
      {
        regex: /\bstruct\s+DelegationPolicy\b/,
        message:
          'core subagent runtime must not redefine DelegationPolicy; use openbitfun-runtime-ports',
      },
      {
        regex: /\benum\s+SubagentContextMode\b/,
        message:
          'core subagent runtime must not redefine SubagentContextMode; use openbitfun-runtime-ports',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/coordinator.rs',
    patterns: [
      {
        regex: /\benum\s+DialogTriggerSource\b/,
        message:
          'core coordinator must not redefine DialogTriggerSource; use openbitfun-runtime-ports',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
    patterns: [
      {
        regex: /\benum\s+DialogQueuePriority\b/,
        message:
          'core scheduler must not redefine DialogQueuePriority; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+DialogSubmissionPolicy\b/,
        message:
          'core scheduler must not redefine DialogSubmissionPolicy; use openbitfun-runtime-ports',
      },
      {
        regex: /\benum\s+DialogSubmitOutcome\b/,
        message:
          'core scheduler must not redefine DialogSubmitOutcome; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+AgentSessionReplyRoute\b/,
        message:
          'core scheduler must not redefine AgentSessionReplyRoute; use openbitfun-runtime-ports',
      },
      {
        regex: /\benum\s+DialogSteerOutcome\b/,
        message:
          'core scheduler must not redefine DialogSteerOutcome; use openbitfun-runtime-ports',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/round_preempt.rs',
    patterns: [
      {
        regex: /\bstruct\s+RoundInjection\b/,
        message:
          'core round-boundary runtime must not redefine RoundInjection; use openbitfun-runtime-ports',
      },
      {
        regex: /\btrait\s+DialogRoundInjectionSource\b/,
        message:
          'core round-boundary runtime must not redefine DialogRoundInjectionSource; use openbitfun-runtime-ports',
      },
      {
        regex: /\benum\s+RoundInjectionKind\b/,
        message:
          'core round-boundary runtime must not redefine RoundInjectionKind; use openbitfun-runtime-ports',
      },
      {
        regex: /\benum\s+RoundInjectionTarget\b/,
        message:
          'core round-boundary runtime must not redefine RoundInjectionTarget; use openbitfun-runtime-ports',
      },
      {
        regex: /\bpub\s+struct\s+SessionRoundInjectionBuffer\b/,
        message:
          'core round-boundary runtime must not own round injection buffer; use openbitfun-agent-runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/goal_mode/mod.rs',
    patterns: [
      {
        regex: /\bconst\s+GOAL_MODE_METADATA_KEY\b/,
        message: 'core goal mode types must not redefine GOAL_MODE_METADATA_KEY; use openbitfun-runtime-ports',
      },
      {
        regex: /\bconst\s+MAX_GOAL_CONTINUATIONS\b/,
        message: 'core goal mode types must not redefine MAX_GOAL_CONTINUATIONS; use openbitfun-runtime-ports',
      },
      {
        regex: /\bconst\s+MAX_CONTEXT_SUMMARY_CHARS\b/,
        message: 'core goal mode types must not redefine MAX_CONTEXT_SUMMARY_CHARS; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+ThreadGoal\b/,
        message: 'core goal mode types must not redefine ThreadGoal; use openbitfun-runtime-ports',
      },
      {
        regex: /\benum\s+ThreadGoalStatus\b/,
        message: 'core goal mode types must not redefine ThreadGoalStatus; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+GoalGenerationResult\b/,
        message: 'core goal mode types must not redefine GoalGenerationResult; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+ThreadGoalToolResponse\b/,
        message: 'core goal mode types must not redefine ThreadGoalToolResponse; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+GoalActivationResult\b/,
        message: 'core goal mode types must not redefine GoalActivationResult; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+GoalContinuationPlan\b/,
        message: 'core goal mode types must not redefine GoalContinuationPlan; use openbitfun-runtime-ports',
      },
      {
        regex: /\bpub\s+struct\s+ThreadGoalRuntime\b/,
        message:
          'core goal mode must not own thread goal runtime accounting; use openbitfun-agent-runtime',
      },
      {
        regex: /\bfn\s+build_thread_goal_continuation_plan\b/,
        message:
          'core goal mode must not own thread goal continuation planning; use openbitfun-agent-runtime',
      },
      {
        regex: /\bfn\s+goal_tool_response\b/,
        message:
          'core goal mode must not own thread goal tool response assembly; use openbitfun-agent-runtime',
      },
      {
        regex: /\bfn\s+billable_tokens_from_counts\b/,
        message:
          'core goal mode must not own thread goal token accounting policy; use openbitfun-agent-runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/core/message.rs',
    patterns: [
      {
        regex: /\bstruct\s+CompressionContract\b/,
        message: 'core message model must not redefine CompressionContract; use openbitfun-runtime-ports',
      },
      {
        regex: /\bstruct\s+CompressionContractItem\b/,
        message: 'core message model must not redefine CompressionContractItem; use openbitfun-runtime-ports',
      },
      {
        regex: /\bfn\s+render_contract_items\b/,
        message: 'core message model must not own compression contract rendering; use openbitfun-runtime-ports',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace/manager.rs',
    patterns: [
      {
        regex: /\bstruct\s+RelatedPath\b/,
        message: 'core workspace manager must not redefine RelatedPath; use openbitfun-runtime-ports',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/review_read_receipt_runtime.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'review read receipt runtime must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_result_storage.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'tool-result storage runtime must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/post_call_hooks.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'post-call hooks must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_adapter.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'tool adapter must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'product tool runtime must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/catalog.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'product tool runtime catalog must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/get_tool_spec_tool.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'GetToolSpec adapter must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/manifest_resolver.rs',
    patterns: [
      {
        regex: /framework::(?:\{[^}]*\bToolUseContext\b[^}]*\}|\bToolUseContext\b)/,
        message:
          'manifest resolver must import ToolUseContext from tool_context_runtime, not the framework re-export',
      },
      {
        regex: /\bContextualToolManifest\b/,
        message:
          'manifest resolver must stay a compatibility facade; contextual manifest conversion belongs in product_runtime/catalog',
      },
      {
        regex: /\bContextualVisibleTools\b/,
        message:
          'manifest resolver must stay a compatibility facade; contextual visible-tool conversion belongs in product_runtime/catalog',
      },
      {
        regex: /\bToolManifestDefinition\b/,
        message:
          'manifest resolver must not own manifest DTO conversion; use product_runtime/catalog',
      },
      {
        regex: /\bfn\s+to_core_tool_definition\b/,
        message:
          'manifest resolver must not own ToolDefinition conversion; use product_runtime/catalog',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/workspace.rs',
    patterns: [
      {
        regex: /\bpub\s+trait\s+WorkspaceFileSystem\b/,
        message:
          'workspace file-system contract must be owned by openbitfun-runtime-ports; keep only concrete adapters or re-exports in core',
      },
      {
        regex: /\bpub\s+trait\s+WorkspaceShell\b/,
        message:
          'workspace shell contract must be owned by openbitfun-runtime-ports; keep only concrete adapters or re-exports in core',
      },
      {
        regex: /\bpub\s+struct\s+WorkspaceServices\b/,
        message:
          'workspace service bundle contract must be owned by openbitfun-runtime-ports; keep only concrete adapters or re-exports in core',
      },
      {
        regex: /\bpub\s+struct\s+WorkspaceCommandOptions\b/,
        message:
          'workspace command contract must be owned by openbitfun-runtime-ports; keep only concrete adapters or re-exports in core',
      },
      {
        regex: /\bpub\s+struct\s+WorkspaceCommandResult\b/,
        message:
          'workspace command result contract must be owned by openbitfun-runtime-ports; keep only concrete adapters or re-exports in core',
      },
      {
        regex: /\bpub\s+struct\s+WorkspaceDirEntry\b/,
        message:
          'workspace directory entry contract must be owned by openbitfun-runtime-ports; keep only concrete adapters or re-exports in core',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/execution/execution_engine.rs',
    patterns: [
      {
        regex: /\bGetToolSpecLoadObservation\b/,
        message:
          'execution engine must not own deferred-tool loaded-spec observation details; use product_runtime loaded-spec state owner',
      },
      {
        regex: /\bcollect_loaded_deferred_tool_specs\b/,
        message:
          'execution engine must not call generic deferred-tool collector directly; use product_runtime loaded-spec state owner',
      },
      {
        regex: /\bfn\s+collect_loaded_deferred_tool_specs\b/,
        message:
          'execution engine must not own deferred-tool loaded-spec collection; use product_runtime loaded-spec state owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/manager.rs',
    patterns: [
      {
        regex: /\bbuild_runtime_state\b/,
        message:
          'core MiniApp manager must not build runtime state directly; use product-domain lifecycle helpers',
      },
      {
        regex: /\bbuild_source_revision\b/,
        message:
          'core MiniApp manager must not build source revisions directly; use product-domain lifecycle helpers',
      },
      {
        regex: /\bbuild_deps_revision\b/,
        message:
          'core MiniApp manager must not build dependency revisions directly; use product-domain lifecycle helpers',
      },
      {
        regex: /\bapp\.version\s*\+=\s*1\b/,
        message:
          'core MiniApp manager must not own version increments for lifecycle transitions; use product-domain lifecycle helpers',
      },
      {
        regex: /\bapp\.runtime\s*=/,
        message:
          'core MiniApp manager must not own runtime-state replacement for lifecycle transitions; use product-domain lifecycle helpers',
      },
      {
        regex: /\bbuild_created_app\b/,
        message:
          'core MiniApp manager must not own create workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bapply_update_patch\b/,
        message:
          'core MiniApp manager must not own update workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bprepare_draft_app\b/,
        message:
          'core MiniApp manager must not own draft creation workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bapply_draft_source_sync_result\b/,
        message:
          'core MiniApp manager must not own draft source-sync workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bapply_draft_permission_update_result\b/,
        message:
          'core MiniApp manager must not own draft permission workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bapply_draft_to_active\b/,
        message:
          'core MiniApp manager must not own apply-draft workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bapply_draft_customization_metadata\b/,
        message:
          'core MiniApp manager must not own draft customization workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bmark_builtin_update_available_metadata\b/,
        message:
          'core MiniApp manager must not own built-in update workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bdecline_builtin_update_metadata\b/,
        message:
          'core MiniApp manager must not own built-in update decline workflow assembly; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bprepare_imported_meta\b/,
        message:
          'core MiniApp manager must not own import metadata rehome planning; use product-domain import bundle plan',
      },
      {
        regex: /\bbuild_import_fallbacks\b/,
        message:
          'core MiniApp manager must not own import fallback planning; use product-domain import bundle plan',
      },
      {
        regex: /\bbuild_import_bundle_plan\b/,
        message:
          'core MiniApp manager must not own import bundle planning; use MiniAppRuntimeFacade',
      },
      {
        regex: /\bread_import_meta_json\b/,
        message:
          'core MiniApp manager must not own import metadata IO; use MiniAppRuntimeFacade import ports',
      },
      {
        regex: /\bwrite_import_bundle\b/,
        message:
          'core MiniApp manager must not own import bundle IO; use MiniAppRuntimeFacade import ports',
      },
      {
        regex: /\bworkspace_dir_string\b/,
        message:
          'core MiniApp manager must not own compile workspace path adaptation; use MiniAppCompileRequest',
      },
      {
        regex: /\bresolve_policy\s*\(/,
        message:
          'core MiniApp manager must not own permission policy path adaptation; use MiniAppPermissionPolicyRequest',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/restrictions.rs',
    patterns: [
      {
        regex: /\bpub enum ToolPathOperation\b/,
        message: 'core tool restrictions must not redefine ToolPathOperation; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ToolPathPolicy\b/,
        message: 'core tool restrictions must not redefine ToolPathPolicy; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ToolRuntimeRestrictions\b/,
        message:
          'core tool restrictions must not redefine ToolRuntimeRestrictions; use openbitfun-agent-tools',
      },
      {
        regex: /\bfn\s+normalize_absolute_posix_path\b/,
        message:
          'core tool restrictions must not redefine remote POSIX path normalization; use openbitfun-agent-tools',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/workspace_paths.rs',
    patterns: [
      {
        regex: /\bpub const OPENBITFUN_RUNTIME_URI_PREFIX\b/,
        message:
          'core workspace path facade must not redefine the runtime URI prefix; use openbitfun-agent-tools',
      },
      {
        regex: /\bpub struct ParsedOpenBitFunRuntimeUri\b/,
        message:
          'core workspace path facade must not redefine ParsedOpenBitFunRuntimeUri; use openbitfun-agent-tools',
      },
      {
        regex: /\bfn\s+posix_normalize_components\b/,
        message:
          'core workspace path facade must not redefine remote POSIX path normalization; use openbitfun-agent-tools',
      },
      {
        regex: /Component::ParentDir/,
        message:
          'core workspace path facade must not redefine host path normalization; use openbitfun-agent-tools',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/registry.rs',
    patterns: [
      {
        regex: /\bstruct DynamicToolMetadata\b/,
        message:
          'core tool registry must not own dynamic tool metadata storage; use openbitfun-agent-tools ToolRegistry',
      },
      {
        regex: /\btools\s*:\s*IndexMap\b/,
        message:
          'core tool registry must not own the generic tool map; use openbitfun-agent-tools ToolRegistry',
      },
      {
        regex: /\bdynamic_tools\s*:\s*IndexMap\b/,
        message:
          'core tool registry must not own the dynamic tool map; use openbitfun-agent-tools ToolRegistry',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_result_storage.rs',
    patterns: [
      {
        regex: /\bfn\s+generate_preview\b/,
        message:
          'core tool result storage must delegate pure preview generation to openbitfun-agent-tools',
      },
      {
        regex: /\bfn\s+build_persisted_output_message\b/,
        message:
          'core tool result storage must delegate persisted-output rendering to openbitfun-agent-tools',
      },
      {
        regex: /\bfn\s+select_candidates_to_persist\b/,
        message:
          'core tool result storage must delegate round-budget selection to openbitfun-agent-tools',
      },
      {
        regex: /\bstruct\s+ToolResultStoragePolicy\b/,
        message:
          'core tool result storage must use the provider-neutral storage policy from openbitfun-agent-tools',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/server/process.rs',
    patterns: [
      {
        regex: /\bpub enum MCPServerType\b/,
        message: 'core MCP server process runtime must not redefine MCPServerType; use the integrations contract',
      },
      {
        regex: /\bpub enum MCPServerStatus\b/,
        message: 'core MCP server process runtime must not redefine MCPServerStatus; use the integrations contract',
      },
      {
        regex: /\bfn is_auth_error\b/,
        message: 'core MCP server process runtime must not own auth error classification; use the integrations helper',
      },
      {
        regex: /\bconst AUTHORIZATION_KEYS\b/,
        message: 'core MCP server process runtime must not own remote authorization key constants; use the integrations helper',
      },
      {
        regex: /\bcontains_key\("Authorization"\)/,
        message: 'core MCP server process runtime must not inline legacy authorization header fallback; use the integrations helper',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message: 'core MCP server process facade must not spawn MCP child processes; use the integrations owner crate',
      },
      {
        regex: /\bMCPTransport::start_receive_loop\b/,
        message: 'core MCP server process facade must not own stdio receive lifecycle; use the integrations owner crate',
      },
      {
        regex: /\bMCPConnection::new_remote\b/,
        message: 'core MCP server process facade must not own remote transport lifecycle; use the integrations owner crate',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/server/manager/mod.rs',
    patterns: [
      {
        regex: /\benum ListChangedKind\b/,
        message: 'core MCP server manager must not own list-changed classification; use the integrations helper',
      },
      {
        regex: /\bresource_catalog_cache\b/,
        message: 'core MCP server manager must not own resource catalog cache state; use the integrations owner crate',
      },
      {
        regex: /\bprompt_catalog_cache\b/,
        message: 'core MCP server manager must not own prompt catalog cache state; use the integrations owner crate',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/server/manager/reconnect.rs',
    patterns: [
      {
        regex: /\bfn compute_backoff_delay\b/,
        message: 'core MCP reconnect runtime must not own backoff policy math; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/server/manager/interaction.rs',
    patterns: [
      {
        regex: /\bfn detect_list_changed_kind\b/,
        message: 'core MCP interaction runtime must not own list-changed classification; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/adapter/tool.rs',
    patterns: [
      {
        regex: /\bfn behavior_hints\b/,
        message: 'core MCP tool adapter must not own dynamic tool behavior hint rendering; use the execution MCP tool bridge contract',
      },
      {
        regex: /\bfn truncate_for_assistant\b/,
        message: 'core MCP tool adapter must not own result truncation rendering; use the integrations helper',
      },
      {
        regex: /\bMCPToolResultContent\b/,
        message: 'core MCP tool adapter must not own MCP result content rendering; use the integrations helper',
      },
      {
        regex: /Tool '\{\}' from MCP server/,
        message: 'core MCP tool adapter must not own dynamic descriptor text; use the execution MCP tool bridge contract',
      },
      {
        regex: /\bDynamicMcpToolInfo\b/,
        message: 'core MCP tool adapter must not own dynamic MCP metadata assembly; use the execution MCP tool bridge contract',
      },
      {
        regex: /Input must be an object/,
        message: 'core MCP tool adapter must not own bridge input validation text; use the execution MCP tool bridge contract',
      },
      {
        regex: /Using MCP tool/,
        message: 'core MCP tool adapter must not own bridge tool-use presentation; use the execution MCP tool bridge contract',
      },
      {
        regex: /was rejected by user/,
        message: 'core MCP tool adapter must not own bridge rejection presentation; use the execution MCP tool bridge contract',
      },
      {
        regex: /completed\. Result:/,
        message: 'core MCP tool adapter must not own bridge result presentation; use the execution MCP tool bridge contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/adapter/context.rs',
    patterns: [
      {
        regex: /\bpub struct ContextEnhancerConfig\b/,
        message: 'core MCP context provider must not own enhancer config; use the integrations helper',
      },
      {
        regex: /\bpub struct ContextEnhancer\b/,
        message: 'core MCP context provider must not own resource selection logic; use the integrations helper',
      },
      {
        regex: /\bpartial_cmp\b/,
        message: 'core MCP context provider must not own resource ranking logic; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/function_agents/git-func-agent/commit_generator.rs',
    patterns: [
      {
        regex: /\bGitService::get_status\b/,
        message:
          'Git function-agent commit generator must use CoreProductDomainRuntime for Git adapter wiring',
      },
      {
        regex: /\bAIAnalysisService::new_with_task_config\b/,
        message:
          'Git function-agent commit generator must use CoreProductDomainRuntime for AI adapter wiring',
      },
      {
        regex: /\bto_string_lossy\b/,
        message:
          'Git function-agent commit generator must preserve PathBuf paths when routing through the facade',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/server/config.rs',
    patterns: [
      {
        regex: /\bpub enum MCPServerTransport\b/,
        message: 'core MCP server config facade must not redefine MCPServerTransport; use the integrations contract',
      },
      {
        regex: /\bpub struct MCPServerOAuthConfig\b/,
        message: 'core MCP server config facade must not redefine OAuth config; use the integrations contract',
      },
      {
        regex: /\bpub struct MCPServerXaaConfig\b/,
        message: 'core MCP server config facade must not redefine XAA config; use the integrations contract',
      },
      {
        regex: /\bpub struct MCPServerConfig\b/,
        message: 'core MCP server config facade must not redefine server config; use the integrations contract',
      },
      {
        regex: /\bfn default_true\b/,
        message: 'core MCP server config facade must not redefine config serde defaults; use the integrations contract',
      },
      {
        regex: /\bpub fn resolved_transport\b/,
        message: 'core MCP server config facade must not redefine transport defaults; use the integrations contract',
      },
      {
        regex: /\bpub fn validate\b/,
        message: 'core MCP server config facade must not redefine config validation; use the integrations contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/config/cursor_format.rs',
    patterns: [
      {
        regex: /\bfn parse_source\b/,
        message: 'core MCP cursor facade must not redefine source parsing; use the integrations contract',
      },
      {
        regex: /\bfn parse_transport\b/,
        message: 'core MCP cursor facade must not redefine transport parsing; use the integrations contract',
      },
      {
        regex: /\bfn parse_legacy_type\b/,
        message: 'core MCP cursor facade must not redefine legacy type parsing; use the integrations contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/config/json_config.rs',
    patterns: [
      {
        regex: /\bfn normalize_source\b/,
        message: 'core MCP JSON config facade must not redefine source normalization; use the integrations helper',
      },
      {
        regex: /\bfn normalize_transport\b/,
        message: 'core MCP JSON config facade must not redefine transport normalization; use the integrations helper',
      },
      {
        regex: /\bfn normalize_legacy_type\b/,
        message: 'core MCP JSON config facade must not redefine legacy type normalization; use the integrations helper',
      },
      {
        regex: /\bconfig_value\.get\("mcpServers"\)\.is_none\(\)/,
        message: 'core MCP JSON config facade must not inline save validation; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/config/service.rs',
    patterns: [
      {
        regex: /\bconst AUTHORIZATION_KEYS\b/,
        message: 'core MCP config service facade must not own authorization key constants; use the integrations helper',
      },
      {
        regex: /\bfn config_signature\b/,
        message: 'core MCP config service facade must not own merge signatures; use the integrations helper',
      },
      {
        regex: /\bfn precedence\b/,
        message: 'core MCP config service facade must not own merge precedence; use the integrations helper',
      },
      {
        regex: /\bfn config_authorization_from_map\b/,
        message: 'core MCP config service facade must not own authorization extraction; use the integrations helper',
      },
      {
        regex: /\bBTreeMap\b/,
        message: 'core MCP config service facade must not rebuild stable merge signatures; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/auth.rs',
    patterns: [
      {
        regex: /\bstruct VaultFile\b/,
        message: 'core MCP auth facade must not own OAuth vault storage; use the integrations owner crate',
      },
      {
        regex: /\bconst NONCE_LEN\b/,
        message: 'core MCP auth facade must not own OAuth vault encryption; use the integrations owner crate',
      },
      {
        regex: /\bfn encrypt_value\b/,
        message: 'core MCP auth facade must not own OAuth vault encryption; use the integrations owner crate',
      },
      {
        regex: /\bfn decrypt_value\b/,
        message: 'core MCP auth facade must not own OAuth vault encryption; use the integrations owner crate',
      },
      {
        regex: /\bAuthorizationManager::new\b/,
        message: 'core MCP auth facade must not assemble OAuth authorization manager internals; use the integrations owner crate',
      },
      {
        regex: /\bOAuthState::new\b/,
        message: 'core MCP auth facade must not assemble OAuth authorization state internals; use the integrations owner crate',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/protocol/transport_remote.rs',
    patterns: [
      {
        regex: /\bfn normalize_authorization_value\b/,
        message: 'core MCP remote transport must not redefine authorization normalization; use the integrations helper',
      },
      {
        regex: /starts_with\("bearer "\)/,
        message: 'core MCP remote transport must not inline bearer normalization; use the integrations helper',
      },
      {
        regex: /\bfn build_client_info\b/,
        message: 'core MCP remote transport must not own client capability construction; use the integrations helper',
      },
      {
        regex: /\bClientCapabilities::builder\b/,
        message: 'core MCP remote transport must not inline client capability construction; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?initialize_result\b/,
        message: 'core MCP remote transport must not own rmcp initialize mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?tool\b/,
        message: 'core MCP remote transport must not own rmcp tool mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?resource\b/,
        message: 'core MCP remote transport must not own rmcp resource mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?resource_content\b/,
        message: 'core MCP remote transport must not own rmcp resource content mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?prompt\b/,
        message: 'core MCP remote transport must not own rmcp prompt mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?prompt_message\b/,
        message: 'core MCP remote transport must not own rmcp prompt message mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?tool_result\b/,
        message: 'core MCP remote transport must not own rmcp tool result mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?content_block\b/,
        message: 'core MCP remote transport must not own rmcp content block mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?icons\b/,
        message: 'core MCP remote transport must not own rmcp icon mapping; use the integrations helper',
      },
      {
        regex: /\bfn map_(?:rmcp_)?annotations\b/,
        message: 'core MCP remote transport must not own rmcp annotation mapping; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mcp/protocol/jsonrpc.rs',
    patterns: [
      {
        regex: /\bfn serialize_params\b/,
        message: 'core MCP jsonrpc facade must not redefine request parameter serialization; use the integrations contract',
      },
      {
        regex: /\bpub fn create_initialize_request\b/,
        message: 'core MCP jsonrpc facade must not redefine initialize request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_resources_list_request\b/,
        message: 'core MCP jsonrpc facade must not redefine resources/list request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_resources_read_request\b/,
        message: 'core MCP jsonrpc facade must not redefine resources/read request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_prompts_list_request\b/,
        message: 'core MCP jsonrpc facade must not redefine prompts/list request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_prompts_get_request\b/,
        message: 'core MCP jsonrpc facade must not redefine prompts/get request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_tools_list_request\b/,
        message: 'core MCP jsonrpc facade must not redefine tools/list request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_tools_call_request\b/,
        message: 'core MCP jsonrpc facade must not redefine tools/call request builders; use the integrations contract',
      },
      {
        regex: /\bpub fn create_ping_request\b/,
        message: 'core MCP jsonrpc facade must not redefine ping request builders; use the integrations contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_ssh/mod.rs',
    patterns: [
      {
        regex: /#\[cfg\(not\(feature = "ssh-remote"\)\)\]\s*mod disabled\b/s,
        message: 'core remote SSH facade must not own disabled runtime stubs; re-export services-integrations remote_ssh',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_ssh/workspace_state.rs',
    patterns: [
      {
        regex: /\bpub const LOCAL_WORKSPACE_SSH_HOST\b/,
        message: 'core remote SSH workspace runtime must not redefine LOCAL_WORKSPACE_SSH_HOST; use the integrations contract',
      },
      {
        regex: /\bpub fn normalize_remote_workspace_path\b/,
        message: 'core remote SSH workspace runtime must not redefine remote path normalization; use the integrations contract',
      },
      {
        regex: /\bpub fn sanitize_ssh_connection_id_for_local_dir\b/,
        message: 'core remote SSH workspace runtime must not redefine SSH connection id sanitization; use the integrations contract',
      },
      {
        regex: /\bpub fn sanitize_remote_mirror_path_component\b/,
        message: 'core remote SSH workspace runtime must not redefine remote mirror path sanitization; use the integrations contract',
      },
      {
        regex: /\bpub fn sanitize_ssh_hostname_for_mirror\b/,
        message: 'core remote SSH workspace runtime must not redefine SSH hostname mirror sanitization; use the integrations contract',
      },
      {
        regex: /\bpub fn remote_root_to_mirror_subpath\b/,
        message: 'core remote SSH workspace runtime must not redefine remote mirror subpath mapping; use the integrations contract',
      },
      {
        regex: /\bpub fn workspace_logical_key\b/,
        message: 'core remote SSH workspace runtime must not redefine workspace logical keys; use the integrations contract',
      },
      {
        regex: /\bpub fn local_workspace_stable_storage_id\b/,
        message: 'core remote SSH workspace runtime must not redefine local workspace stable ids; use the integrations contract',
      },
      {
        regex: /\bpub fn remote_workspace_stable_id\b/,
        message: 'core remote SSH workspace runtime must not redefine remote workspace stable ids; use the integrations contract',
      },
      {
        regex: /\bpub fn unresolved_remote_session_storage_key\b/,
        message: 'core remote SSH workspace runtime must not redefine unresolved session keys; use the integrations contract',
      },
      {
        regex: /\bpub struct WorkspaceSessionIdentity\b/,
        message: 'core remote SSH workspace runtime must not redefine workspace session identity; use the integrations path helper',
      },
      {
        regex: /\bpub fn workspace_session_identity\b/,
        message: 'core remote SSH workspace runtime must not redefine workspace session identity construction; use the integrations path helper',
      },
      {
        regex: /\bstruct RegisteredRemoteWorkspace\b/,
        message: 'core remote SSH workspace runtime must not own workspace registrations; use the integrations registry',
      },
      {
        regex: /\bpub struct RemoteWorkspaceEntry\b/,
        message: 'core remote SSH workspace runtime must not redefine workspace entries; use the integrations registry',
      },
      {
        regex: /\bpub struct RemoteWorkspaceState\b/,
        message: 'core remote SSH workspace runtime must not redefine legacy workspace state; use the integrations registry',
      },
      {
        regex: /\bregistration_matches_path\b/,
        message: 'core remote SSH workspace runtime must not own path-to-registration matching; use the integrations registry',
      },
      {
        regex: /\bdunce::canonicalize\b/,
        message: 'core remote SSH workspace runtime must not own local root canonicalization; use the integrations path helper',
      },
      {
        regex: /\bfn path_buf_to_stable_local_root_string\b/,
        message: 'core remote SSH workspace runtime must not own local root string normalization; use the integrations path helper',
      },
      {
        regex: /join\("_unresolved"\)/,
        message: 'core remote SSH workspace runtime must not own unresolved session path layout; use the integrations path helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/mod.rs',
    patterns: [
      {
        regex: /\bpub\s+mod\s+device\s*;/,
        message:
          'core remote-connect root must not own device module implementation; use the services-integrations owner',
      },
      {
        regex: /\bpub\s+mod\s+encryption\s*;/,
        message:
          'core remote-connect root must not own encryption module implementation; use the services-integrations owner',
      },
      {
        regex: /\bpub\s+mod\s+pairing\s*;/,
        message:
          'core remote-connect root must not own pairing module implementation; use the services-integrations owner',
      },
      {
        regex: /\bpub\s+mod\s+qr_generator\s*;/,
        message:
          'core remote-connect root must not own QR module implementation; use the services-integrations owner',
      },
      {
        regex: /\bpub\s+mod\s+relay_client\s*;/,
        message:
          'core remote-connect root must not own relay client module implementation; use the services-integrations owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/remote_server.rs',
    patterns: [
      {
        regex: /\bpub\(crate\) struct CoreRemoteDialogRuntimeHost\b/,
        message:
          'remote_server must not own concrete remote dialog runtime host; keep it in service_agent_runtime',
      },
      {
        regex: /\bpub\(crate\) struct CoreRemoteCancelRuntimeHost\b/,
        message:
          'remote_server must not own concrete remote cancel runtime host; keep it in service_agent_runtime',
      },
      {
        regex: /\bpub\(crate\) struct CoreRemoteWorkspaceFileRuntimeHost\b/,
        message:
          'remote_server must not own concrete remote workspace file runtime host; keep it in service_agent_runtime',
      },
      {
        regex: /\bstruct CoreRemoteSessionTrackerHost\b/,
        message:
          'remote_server must not own concrete remote tracker host; keep it in service_agent_runtime',
      },
      {
        regex: /\basync fn resolve_session_model_id\b/,
        message:
          'remote_server must not own remote session model resolution; keep it in service_agent_runtime',
      },
      {
        regex: /\basync fn load_remote_model_catalog\b/,
        message:
          'remote_server must not own remote model catalog loading; keep it in service_agent_runtime',
      },
      {
        regex: /\bget_global_config_service\b/,
        message:
          'remote_server must not own remote model config access; route it through service_agent_runtime',
      },
      {
        regex: /\bfn compress_data_url_for_mobile\b/,
        message:
          'remote_server must not own remote chat thumbnail compression; use services-integrations projection helpers',
      },
      {
        regex: /\bfn turns_to_chat_messages\b/,
        message:
          'remote_server must not own persisted turn to remote chat conversion; keep it in service_agent_runtime',
      },
      {
        regex: /\basync fn load_chat_messages_from_conversation_persistence\b/,
        message:
          'remote_server must not own remote chat history persistence loading; keep it in service_agent_runtime',
      },
      {
        regex: /\bfn strip_user_input_tags\b/,
        message:
          'remote_server must not own remote user input display cleanup; use services-integrations projection helpers',
      },
      {
        regex: /\bpub struct ImageAttachment\b/,
        message: 'core remote-connect server must not redefine image attachment wire DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct ChatImageAttachment\b/,
        message: 'core remote-connect server must not redefine chat image wire DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct ChatMessage\b/,
        message: 'core remote-connect server must not redefine chat message wire DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct ChatMessageItem\b/,
        message: 'core remote-connect server must not redefine chat message item DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct RemoteToolStatus\b/,
        message: 'core remote-connect server must not redefine remote tool status DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct ActiveTurnSnapshot\b/,
        message: 'core remote-connect server must not redefine active turn snapshot DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct SessionInfo\b/,
        message: 'core remote-connect server must not redefine session info DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct RemoteDefaultModelsConfig\b/,
        message: 'core remote-connect server must not redefine remote model default DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct RemoteModelConfig\b/,
        message: 'core remote-connect server must not redefine remote model DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct RemoteModelCatalog\b/,
        message: 'core remote-connect server must not redefine remote model catalog DTOs; use the integrations contract',
      },
      {
        regex: /\bpub struct RemoteModelCatalogPollDelta\b/,
        message: 'core remote-connect server must not redefine remote model catalog poll delta; use the integrations contract',
      },
      {
        regex: /\bpub enum RemoteCommand\b/,
        message: 'core remote-connect server must not redefine remote command wire DTOs; use the integrations contract',
      },
      {
        regex: /\bpub enum RemoteResponse\b/,
        message: 'core remote-connect server must not redefine remote response wire DTOs; use the integrations contract',
      },
      {
        regex: /\bstruct TrackerState\b/,
        message: 'core remote-connect server must not own tracker state; use the integrations tracker',
      },
      {
        regex: /\bpub enum TrackerEvent\b/,
        message: 'core remote-connect server must not redefine tracker events; use the integrations tracker',
      },
      {
        regex: /\bpub struct RemoteSessionStateTracker\b/,
        message: 'core remote-connect server must not own tracker state; use the integrations tracker',
      },
      {
        regex: /\bDashMap\b/,
        message: 'core remote-connect server must not own tracker storage; use the integrations registry',
      },
      {
        regex: /\bfn make_slim_params\b/,
        message: 'core remote-connect server must not own remote tool preview slimming; use the integrations helper',
      },
      {
        regex: /\bmatch mobile_type\b/,
        message: 'core remote-connect server must not own remote agent type alias mapping; use the integrations helper',
      },
      {
        regex: /\bfn resolve_remote_cancel_decision\b/,
        message: 'core remote-connect server must not own cancel decision policy; use the integrations helper',
      },
      {
        regex: /\benum RemoteCancelDecision\b/,
        message: 'core remote-connect server must not own cancel decision types; use the integrations contract',
      },
      {
        regex: /\bstruct RemoteCancelTaskRequest\b/,
        message: 'core remote-connect server must not own cancel task request contracts; use the integrations contract',
      },
      {
        regex: /\btrait RemoteCancelRuntimeHost\b/,
        message: 'core remote-connect server must not own cancel runtime host contracts; use the integrations contract',
      },
      {
        regex: /\bfn cancel_remote_task\b/,
        message: 'core remote-connect server must not own cancel orchestration; use the integrations helper',
      },
      {
        regex: /\bfn remote_session_restore_target\b/,
        message: 'core remote-connect server must not own restore-target policy; use the integrations helper',
      },
      {
        regex: /\bfn resolve_remote_execution_image_contexts\b/,
        message: 'core remote-connect server must not own image-context preference policy; use the integrations helper',
      },
      {
        regex: /\btrait RemoteImageContextAdapter\b/,
        message: 'core remote-connect server must not own image-context adapter contracts; use the integrations contract',
      },
      {
        regex: /\bconst MAX_SIZE\b/,
        message: 'core remote-connect server must not own remote file max-read policy; use the integrations helper',
      },
      {
        regex: /\bconst MAX_CHUNK\b/,
        message: 'core remote-connect server must not own remote file chunk policy; use the integrations helper',
      },
      {
        regex: /unwrap_or\("file"\)/,
        message: 'core remote-connect server must not own remote file display-name fallback; use the integrations helper',
      },
      {
        regex: /\bresolve_workspace_path\b/,
        message: 'core remote-connect server must not own workspace file path resolution; use the integrations helper',
      },
      {
        regex: /\bdetect_mime_type\b/,
        message: 'core remote-connect server must not own workspace file MIME detection; use the integrations helper',
      },
      {
        regex: /\bread_workspace_file\b/,
        message: 'core remote-connect server must not own workspace file read helpers; use the integrations helper',
      },
      {
        regex: /\bfn read_remote_workspace_file\b/,
        message: 'core remote-connect server must not redefine remote workspace full-file readers; use the integrations helper',
      },
      {
        regex: /\bfn read_remote_workspace_file_chunk\b/,
        message: 'core remote-connect server must not redefine remote workspace chunk readers; use the integrations helper',
      },
      {
        regex: /\bfn read_remote_workspace_file_info\b/,
        message: 'core remote-connect server must not redefine remote workspace file-info readers; use the integrations helper',
      },
      {
        regex: /\bfn remote_file_content_response\b/,
        message: 'core remote-connect server must not own remote file content response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_file_chunk_response\b/,
        message: 'core remote-connect server must not own remote file chunk response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_file_info_response\b/,
        message: 'core remote-connect server must not own remote file-info response assembly; use the integrations helper',
      },
      {
        regex: /\bfn handle_remote_workspace_file_command\b/,
        message: 'core remote-connect server must not own remote file command orchestration; use the integrations helper',
      },
      {
        regex: /general_purpose::STANDARD\.encode/,
        message: 'core remote-connect server must not own remote response base64 wrapping; use the integrations helper',
      },
      {
        regex: /\bfn remote_dialog_submit_response\b/,
        message: 'core remote-connect server must not own remote dialog response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_task_cancel_response\b/,
        message: 'core remote-connect server must not own remote cancel response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_interaction_accepted_response\b/,
        message: 'core remote-connect server must not own remote interaction response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_answer_question_response\b/,
        message: 'core remote-connect server must not own remote answer response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_workspace_info_response\b/,
        message: 'core remote-connect server must not own workspace-info response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_recent_workspaces_response\b/,
        message: 'core remote-connect server must not own recent-workspaces response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_assistant_list_response\b/,
        message: 'core remote-connect server must not own assistant-list response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_workspace_updated_response\b/,
        message: 'core remote-connect server must not own workspace-updated response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_assistant_updated_response\b/,
        message: 'core remote-connect server must not own assistant-updated response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_session_info\b/,
        message: 'core remote-connect server must not own session response facts assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_session_list_response\b/,
        message: 'core remote-connect server must not own session-list response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_initial_sync_response\b/,
        message: 'core remote-connect server must not own initial-sync response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_session_created_response\b/,
        message: 'core remote-connect server must not own session-created response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_session_model_updated_response\b/,
        message: 'core remote-connect server must not own session-model response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_messages_response\b/,
        message: 'core remote-connect server must not own remote messages response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_session_deleted_response\b/,
        message: 'core remote-connect server must not own session-deleted response assembly; use the integrations helper',
      },
      {
        regex: /\bfn should_send_remote_model_catalog\b/,
        message: 'core remote-connect server must not own poll model-catalog policy; use the integrations helper',
      },
      {
        regex: /\bfn remote_model_catalog_poll_delta\b/,
        message: 'core remote-connect server must not own poll model-catalog delta policy; use the integrations helper',
      },
      {
        regex: /\bfn remote_no_change_poll_response\b/,
        message: 'core remote-connect server must not own no-change poll response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_snapshot_poll_response\b/,
        message: 'core remote-connect server must not own streaming poll response assembly; use the integrations helper',
      },
      {
        regex: /\bfn remote_persisted_poll_response\b/,
        message: 'core remote-connect server must not own persisted poll response assembly; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/bot/mod.rs',
    patterns: [
      {
        regex: /\bfn strip_workspace_path_prefix\b/,
        message: 'core remote-connect bot facade must not own workspace path prefix stripping; use the integrations helper',
      },
      {
        regex: /\bfn is_absolute_workspace_path\b/,
        message: 'core remote-connect bot facade must not own workspace path absolute detection; use the integrations helper',
      },
      {
        regex: /\bmatch ext\.as_str\(\)/,
        message: 'core remote-connect bot facade must not own workspace file MIME mapping; use the integrations helper',
      },
      {
        regex: /\btokio::fs::read\(&abs_path\)/,
        message: 'core remote-connect bot facade must not own workspace file reads; use the integrations helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_control_tool.rs',
    patterns: [
      {
        regex: /\bcreate_session_with_workspace_and_creator\b/,
        message:
          'SessionControl must not bypass the service/agent runtime owner when creating sessions',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_message_tool.rs',
    patterns: [
      {
        regex: /\bcreate_session_with_workspace_and_creator\b/,
        message:
          'SessionMessage must not bypass the service/agent runtime owner when creating sessions',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/announcement/state_store.rs',
    patterns: [
      {
        regex: /\btokio::fs\b/,
        message: 'core announcement state store facade must not own filesystem persistence; use the integrations state store',
      },
      {
        regex: /\bserde_json::to_string_pretty\b/,
        message: 'core announcement state store facade must not own state serialization; use the integrations state store',
      },
      {
        regex: /\bserde_json::from_str\b/,
        message: 'core announcement state store facade must not own state deserialization; use the integrations state store',
      },
    ],
  },
  {
    path: 'src/apps/server/src/bootstrap.rs',
    reason:
      'Server must not assemble a second Agent Runtime beside the canonical Core owner',
    patterns: [
      {
        regex: /\b(?:EventQueue|EventRouter|SessionManager|ToolPipeline|ExecutionEngine|ConversationCoordinator)::new\s*\(/,
        message: 'Server bootstrap must not directly construct canonical Agent Runtime components',
      },
    ],
  },
  {
    path: 'src/apps/server/src/main.rs',
    reason:
      'Server must retain the product event-queue owner instead of bypassing legacy queue draining',
    patterns: [
      {
        regex: /\bAgentEventSource::new\s*\(/,
        message: 'Server must not construct an unowned Agent event source',
      },
    ],
  },
  {
    path: 'src/apps/desktop/src/api/app_state.rs',
    reason:
      'token usage publication belongs to the canonical Core Agent Runtime initializer for every embedded host',
    patterns: [
      {
        regex: /\bset_global_token_usage_service\s*\(/,
        message: 'Desktop AppState must not re-own canonical token usage publication',
      },
    ],
  },
];

export const rustWebUiSourceBoundaryRule = {
  path: '.',
  reason:
    'Rust source must not reference the Web UI source tree; cross-surface contracts belong in surface tests and repository boundary checks',
  patterns: [
    {
      regex: /\bweb-ui\b/g,
      wholeFile: true,
      ignoreRustComments: true,
      allowLines: [
        {
          path: 'src/crates/assembly/core/src/agentic/tools/implementations/code_review_tool.rs',
          text: 'touched_files: vec!["src/web-ui/src/flow_chat/utils/codeReviewReport.ts".to_string()],',
        },
        {
          path: 'src/crates/assembly/core/src/agentic/tools/implementations/code_review_tool.rs',
          text: 'target: "pnpm --dir src/web-ui run test:run".to_string(),',
        },
        {
          path: 'src/crates/execution/agent-runtime/src/deep_review/manifest.rs',
          text: '"changed_files": ["src/web-ui/src/locales/en-US/flow-chat.json"],',
        },
        {
          path: 'src/crates/execution/agent-runtime/src/deep_review/manifest.rs',
          text: '"file_path": "src/web-ui/src/locales/en-US/flow-chat.json",',
        },
        {
          path: 'src/crates/execution/agent-runtime/src/deep_review/manifest.rs',
          text: '"src/web-ui/src/locales/en-US/flow-chat.json"',
        },
        {
          path: 'src/crates/services/services-integrations/src/canvas/compiler/tests.rs',
          text: "nodes: [{ id: 'web-ui' }, { id: 'core' }],",
        },
        {
          path: 'src/crates/services/services-integrations/src/canvas/compiler/tests.rs',
          text: "edges: [{ from: 'web-ui', to: 'core' }],",
        },
      ],
      message:
        'non-comment Rust source must not spell the web-ui path token outside reviewed fixture lines',
    },
  ],
};

export const forbiddenContentUnderRules = [
  rustWebUiSourceBoundaryRule,
  {
    path: 'src/crates/assembly/core/src',
    reason:
      'OpenCode backend wire parsing, raw RPC handlers, and wire errors belong to the opencode-plugin-host adapter',
    patterns: [
      {
        regex:
          /\b(?:BackendHttp(?:Request|Response)|Stream(?:Read|Cancel)Params|RpcHandlerError|RawDiagnostic(?:PublishParams)?)\b/,
        message: 'core must not consume OpenCode backend wire DTOs or RPC errors',
      },
      {
        regex: /["']backend\.[a-z0-9_.-]+["']/i,
        message: 'core must not own raw OpenCode backend RPC method names',
      },
      {
        regex: /register_handler\s*\(\s*["']backend\./,
        message: 'core must not register raw OpenCode backend RPC handlers',
      },
    ],
  },
  {
    path: 'src/crates/adapters/opencode-plugin-host/src',
    reason:
      'raw OpenCode RPC handler registration is an adapter-internal implementation detail',
    patterns: [
      {
        regex: /\bpub\s+async\s+fn\s+register_handler\b/,
        message: 'the raw JSON-RPC handler registration API must not be public',
      },
    ],
  },
  {
    path: 'src/crates/adapters/agent-runtime-ipc/src',
    reason: 'agent-runtime-ipc transport is restricted to Named Pipe and Unix Domain Socket',
    patterns: [
      {
        regex:
          /\b(?:(?:Tcp|Udp)[A-Za-z0-9_]*|tokio_tungstenite|reqwest|hyper|WebSocket)\b/,
        message: 'agent-runtime-ipc must not add network or remote transports',
      },
      {
        regex:
          /\bopenbitfun_transport\b(?!::(?:encode_json_with_limit|JsonCodecError)\b)/,
        message:
          'agent-runtime-ipc may consume only the reviewed bounded JSON API from openbitfun-transport',
      },
    ],
  },
  {
    path: 'src/apps',
    reason:
      'product entrypoints must consume capability-surface projections instead of raw plugin runtime client contracts',
    patterns: [
      {
        regex:
          /\b(?:PluginRuntimeReadResponse|PluginStatusSnapshot|PluginResponseEnvelope|PluginDispatchEnvelope|PluginEffectCandidate|PluginQuarantineState|PluginRuntimeClient|PluginRuntimeBinding|openbitfun_plugin_runtime_client|openbitfun_agent_runtime::runtime)\b/,
        message:
          'product entrypoints must not consume raw plugin runtime client contracts; project through the capability surface contract first',
      },
    ],
  },
  {
    path: 'src/apps/cli/src',
    reason:
      'only the reviewed stdio Server Host assembly point may import the App Server implementation; TUI, controller, and headless CLI must stay on stable contracts',
    patterns: [
      {
        regex: /\bopenbitfun_app_server\b/,
        message:
          'openbitfun-app-server implementation imports belong only in src/apps/cli/src/server_host.rs, the reviewed stdio Server Host assembly point',
        allowPaths: ['src/apps/cli/src/server_host.rs'],
      },
    ],
  },
  {
    path: 'src/crates/interfaces',
    reason:
      'Server/API interface crates must expose projected DTOs instead of raw plugin runtime client contracts',
    patterns: [
      {
        regex:
          /\b(?:PluginRuntimeReadResponse|PluginStatusSnapshot|PluginResponseEnvelope|PluginDispatchEnvelope|PluginEffectCandidate|PluginQuarantineState|PluginRuntimeClient|PluginRuntimeBinding|openbitfun_plugin_runtime_client|openbitfun_agent_runtime::runtime)\b/,
        message:
          'Server/API interfaces must not consume raw plugin runtime client contracts; define a projected contract first',
      },
    ],
  },
  {
    path: 'src/web-ui',
    reason:
      'frontend surfaces must consume capability-surface projections instead of raw plugin runtime client contracts',
    patterns: [
      {
        regex:
          /\b(?:PluginRuntimeReadResponse|PluginStatusSnapshot|PluginResponseEnvelope|PluginDispatchEnvelope|PluginEffectCandidate|PluginQuarantineState|PluginRuntimeClient|PluginRuntimeBinding|openbitfun_plugin_runtime_client|openbitfun_agent_runtime::runtime)\b/,
        message:
          'frontend surfaces must not consume raw plugin runtime client contracts; project through the capability surface contract first',
      },
    ],
  },
  {
    path: 'src/mobile-web',
    reason:
      'mobile surfaces must consume capability-surface projections instead of raw plugin runtime client contracts',
    patterns: [
      {
        regex:
          /\b(?:PluginRuntimeReadResponse|PluginStatusSnapshot|PluginResponseEnvelope|PluginDispatchEnvelope|PluginEffectCandidate|PluginQuarantineState|PluginRuntimeClient|PluginRuntimeBinding|openbitfun_plugin_runtime_client|openbitfun_agent_runtime::runtime)\b/,
        message:
          'mobile surfaces must not consume raw plugin runtime client contracts; project through the capability surface contract first',
      },
    ],
  },
  {
    path: 'OpenBitFun-Installer',
    reason:
      'installer surfaces must consume capability-surface projections instead of raw plugin runtime client contracts',
    patterns: [
      {
        regex:
          /\b(?:PluginRuntimeReadResponse|PluginStatusSnapshot|PluginResponseEnvelope|PluginDispatchEnvelope|PluginEffectCandidate|PluginQuarantineState|PluginRuntimeClient|PluginRuntimeBinding|openbitfun_plugin_runtime_client|openbitfun_agent_runtime::runtime)\b/,
        message:
          'installer surfaces must not consume raw plugin runtime client contracts; project through the capability surface contract first',
      },
    ],
  },
  {
    path: 'src',
    reason:
      'OpenCode adapter production imports are limited to the reviewed composition root',
    patterns: [
      {
        regex:
          /\b(?:use\s+openbitfun_opencode_adapter\b|extern\s+crate\s+openbitfun_opencode_adapter\b|openbitfun_opencode_adapter::)/,
        allowPaths: [
          'src/crates/adapters/opencode-adapter/tests/opencode_source_adapter.rs',
          'src/crates/adapters/opencode-adapter/tests/opencode_static_source_contracts/opencode_command_adapter.rs',
          'src/crates/adapters/opencode-adapter/tests/opencode_static_source_contracts/opencode_skill_roots.rs',
          'src/crates/adapters/opencode-adapter/tests/opencode_static_source_contracts/opencode_workspace_references.rs',
          'src/crates/adapters/opencode-adapter/tests/tool_source_contracts.rs',
          'src/crates/adapters/opencode-adapter/tests/opencode_static_source_contracts/opencode_subagent_adapter.rs',
          'src/crates/adapters/opencode-adapter/tests/opencode_mcp_adapter.rs',
          'src/crates/adapters/opencode-adapter/tests/opencode_static_source_contracts/hook_source.rs',
          'src/crates/assembly/core/src/plugin_runtime.rs',
          'src/crates/assembly/core/src/external_sources.rs',
          'src/crates/assembly/core/src/external_hooks.rs',
          'src/crates/assembly/core/src/instruction_sources.rs',
          'src/crates/assembly/core/src/plugin_host.rs',
        ],
        message:
          'only a reviewed product composition root may import openbitfun-opencode-adapter through a capability-specific provider boundary',
      },
    ],
  },
  {
    path: 'OpenBitFun-Installer/src-tauri',
    reason:
      'OpenCode adapter production imports are limited to the reviewed composition root',
    patterns: [
      {
        regex:
          /\b(?:use\s+openbitfun_opencode_adapter\b|extern\s+crate\s+openbitfun_opencode_adapter\b|openbitfun_opencode_adapter::)/,
        message:
          'only a reviewed product composition root may import openbitfun-opencode-adapter and inject it into PluginRuntimeClient',
      },
    ],
  },
  {
    path: 'src',
    reason: 'Claude Code declarative source adapter imports are limited to its fixtures and composition roots',
    patterns: [{
      regex: /\b(?:use\s+openbitfun_claude_code_adapter\b|extern\s+crate\s+openbitfun_claude_code_adapter\b|openbitfun_claude_code_adapter::)/,
      allowPaths: [
        'src/crates/adapters/claude-code-adapter/tests/claude_code_source_contracts/hook_source.rs',
        'src/crates/adapters/claude-code-adapter/tests/claude_code_source_contracts/command_source.rs',
        'src/crates/adapters/claude-code-adapter/tests/claude_code_source_contracts/subagent_source.rs',
        'src/crates/adapters/claude-code-adapter/tests/claude_code_source_contracts/mcp_source.rs',
        'src/crates/assembly/core/src/external_sources.rs',
        'src/crates/assembly/core/src/external_hooks.rs',
        'src/crates/assembly/core/src/instruction_sources.rs',
      ],
      message: 'Claude Code declarative source adapter may only be imported by its fixtures and reviewed composition roots',
    }],
  },
  {
    path: 'src',
    reason: 'Codex declarative source adapter imports are limited to its fixtures and composition roots',
    patterns: [{
      regex: /\b(?:use\s+openbitfun_codex_adapter\b|extern\s+crate\s+openbitfun_codex_adapter\b|openbitfun_codex_adapter::)/,
      allowPaths: [
        'src/crates/adapters/codex-adapter/tests/codex_source_contracts/hook_source.rs',
        'src/crates/adapters/codex-adapter/tests/codex_source_contracts/subagent_source.rs',
        'src/crates/adapters/codex-adapter/tests/codex_source_contracts/mcp_source.rs',
        'src/crates/assembly/core/src/external_sources.rs',
        'src/crates/assembly/core/src/external_hooks.rs',
        'src/crates/assembly/core/src/instruction_sources.rs',
      ],
      message: 'Codex declarative source adapter may only be imported by its fixtures and reviewed composition roots',
    }],
  },
  {
    path: 'src',
    reason: 'shared bounded static-source support is private to reviewed ecosystem source adapters',
    patterns: [{
      regex: /\b(?:use\s+openbitfun_static_hook_support\b|extern\s+crate\s+openbitfun_static_hook_support\b|openbitfun_static_hook_support::)/,
      allowPaths: [
        'src/crates/adapters/static-hook-support/tests/parser.rs',
        'src/crates/adapters/dsh-adapter/src/hook_source.rs',
        'src/crates/adapters/dsh-adapter/src/mcp_source.rs',
        'src/crates/adapters/pi-adapter/src/hook_source.rs',
        'src/crates/adapters/pi-adapter/src/skill_source.rs',
        'src/crates/adapters/opencode-adapter/src/hook_source.rs',
        'src/crates/adapters/opencode-adapter/src/command_source.rs',
        'src/crates/adapters/opencode-adapter/src/agent_source.rs',
        'src/crates/adapters/opencode-adapter/src/mcp_source.rs',
        'src/crates/adapters/claude-code-adapter/src/hook_source.rs',
        'src/crates/adapters/claude-code-adapter/src/command_source.rs',
        'src/crates/adapters/claude-code-adapter/src/agent_source.rs',
        'src/crates/adapters/claude-code-adapter/src/mcp_source.rs',
        'src/crates/adapters/codex-adapter/src/hook_source.rs',
        'src/crates/adapters/codex-adapter/src/agent_source.rs',
        'src/crates/adapters/codex-adapter/src/mcp_source.rs',
      ],
      message: 'bounded static-source support may only be imported by reviewed ecosystem source adapters',
    }],
  },
  {
    path: 'src/crates/assembly/core/src/service',
    reason:
      'concrete speech runtime ownership belongs in services-integrations',
    patterns: [
      {
        regex: /\bpub\s+mod\s+speech\s*;/,
        message:
          'core must not declare a speech service owner; use stable core-types contracts and compose the services-integrations provider at the app boundary',
      },
      {
        regex: /\bpub\s+use\s+(?:self::)?speech(?:::|\s*::)/,
        message:
          'core must not re-export the concrete speech service provider',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src',
    reason:
      'core must use runtime-ports as the owner path for portable subagent contracts',
    patterns: [
      {
        regex:
          /crate::agentic::subagent_runtime(?:::|\s*::|::\{)(?:[^;\n]*\b(?:DelegationPolicy|SubagentContextMode)\b)/,
        message:
          'DelegationPolicy and SubagentContextMode must be imported from openbitfun-runtime-ports, not the core compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src',
    reason:
      'product-domains must not own IO/process/Git/AI/platform runtime behavior without an approved port/provider migration',
    patterns: [
      {
        regex: /\bCommand::new\(/,
        allowPaths: ['src/crates/contracts/product-domains/src/miniapp/runtime.rs'],
        message:
          'product-domains must not spawn processes outside the reviewed MiniApp runtime detector owner',
      },
      {
        regex: /\bprocess_manager::/,
        message:
          'product-domains must not use the core process manager; keep process execution in core/adapters',
      },
      {
        regex: /\btokio::process::/,
        message: 'product-domains must not own async process execution',
      },
      {
        regex: /\btokio::fs::/,
        message:
          'product-domains must not own async storage IO; storage runtime belongs in services-integrations',
      },
      {
        regex: /\bGitService::/,
        message: 'product-domains must not call concrete Git services; use reviewed ports/adapters',
      },
      {
        regex: /\b(?:AIService|AiService)::/,
        message: 'product-domains must not call concrete AI services; use reviewed ports/adapters',
      },
      {
        regex: /\breqwest::/,
        message: 'product-domains must not own network clients',
      },
      {
        regex: /\bgit2::/,
        message: 'product-domains must not own libgit2 runtime integration',
      },
      {
        regex: /\brmcp::/,
        message: 'product-domains must not own MCP runtime integration',
      },
      {
        regex: /\btauri::/,
        message: 'product-domains must not depend on Tauri platform APIs',
      },
      {
        regex: /\bAppHandle\b/,
        message: 'product-domains must not own desktop platform handles',
      },
      {
        regex: /\bstd::net::/,
        message: 'product-domains must not own network sockets',
      },
      {
        regex: /\b(?:TcpStream|UdpSocket)\b/,
        message: 'product-domains must not own network sockets',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src',
    reason:
      'agent-tools may own pure tool manifest and deferred-tool state contracts, but not product manifest runtime or concrete GetToolSpec execution',
    patterns: [
      {
        regex: /\bGetToolSpecTool\b/,
        message: 'GetToolSpec implementation stays in core product tool runtime',
      },
      {
        regex: /\bmanifest_resolver\b/,
        message: 'tool manifest resolution stays in core product tool runtime',
      },
      {
        regex: /\bToolUseContext\b/,
        message: 'ToolUseContext stays in core until a portable context port is reviewed',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-provider-groups/src',
    reason:
      'tool-packs may own provider group plans, but not product tool manifest/exposure or GetToolSpec runtime',
    patterns: [
      {
        regex: /\bGetToolSpecTool\b/,
        message: 'GetToolSpec implementation stays in core product tool runtime',
      },
      {
        regex: /\bGET_TOOL_SPEC_TOOL_NAME\b/,
        message: 'GetToolSpec manifest insertion stays in core product tool runtime',
      },
      {
        regex: /\bmanifest_resolver\b/,
        message: 'tool manifest resolution stays in core product tool runtime',
      },
      {
        regex: /\bloaded_deferred_tool_specs\b/,
        message: 'deferred-tool loaded-spec state stays in core ToolUseContext/runtime',
      },
      {
        regex: /\bToolExposure\b/,
        message: 'direct/deferred exposure policy stays in core until provider migration',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations',
    reason:
      'GetToolSpec concrete adapter belongs in the product tool runtime owner, not the generic concrete-tool implementations module',
    patterns: [
      {
        regex: /\bpub(?:\(crate\))? struct GetToolSpecTool\b/,
        message: 'move GetToolSpecTool into core product_runtime owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline',
    reason:
      'core pipeline must delegate deterministic tool execution admission policy to openbitfun-agent-tools',
    patterns: [
      {
        regex: /\bvalidate_tool_allowed_by_list\s*\(/,
        message: 'allowed-list admission must stay behind validate_tool_execution_admission',
      },
      {
        regex: /\bruntime_tool_restrictions\s*\.\s*ensure_tool_allowed\s*\(/,
        message: 'runtime-restriction admission must stay behind validate_tool_execution_admission',
      },
      {
        regex: /\bvalidate_deferred_tool_usage\s*\(/,
        message: 'deferred-tool admission must stay behind validate_tool_execution_admission',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src',
    reason:
      'integration modules must use the crate-level provider-initializing Reqwest constructors',
    patterns: [
      {
        regex: /\breqwest::(?:get|Client::(?:new|builder)|ClientBuilder::new)\s*\(/,
        allowPaths: ['src/crates/services/services-integrations/src/lib.rs'],
        message: 'use crate::reqwest_client or crate::reqwest_client_builder',
      },
      {
        regex: /use\s+reqwest(?:::(?:Client|ClientBuilder)|::\{[^}]*\b(?:Client|ClientBuilder)\b[^}]*\})[^;]*;/,
        message: 'keep Reqwest client types fully qualified and construct them through crate-level TLS helpers',
      },
      {
        regex: /use\s+reqwest\s+as\s+\w+\s*;/,
        message: 'do not alias Reqwest around the centralized client-construction guard',
      },
    ],
  },
  {
    path: 'src',
    reason:
      'services-core is the only owner allowed to install the process-wide Rustls provider',
    patterns: [
      {
        regex: /\brustls::crypto::(?:ring|aws_lc_rs)\b/,
        allowPaths: [
          'src/crates/services/services-core/src/tls_provider.rs',
          // Independently built Relay binds ring to one client; the separate
          // rule below still forbids process-wide installation in that owner.
          'src/crates/services/relay-service/src/identity.rs',
        ],
        message: 'delegate built-in Rustls provider selection to services-core::tls_provider',
      },
    ],
  },
  {
    path: 'src/crates/services/relay-service/src/identity.rs',
    reason: 'standalone Relay identity TLS must remain client-scoped',
    patterns: [{
      regex: /\binstall_default\b/,
      message: 'Relay must not install or replace the process-wide TLS provider',
    }],
  },
];
