// Boundary rules for source ownership, facades, and required owner content.

import { agentRuntimeRootPublicModules } from './public-api-rules.mjs';

const agentRuntimeDefinitionContractModules = new Set(['custom_agent', 'prompt', 'skills']);

export const requiredContentRules = [
  {
    path: 'src/web-ui/src/infrastructure/api/service-api/ExternalSourcesAPI.ts',
    reason:
      'the Web API must continue invoking the stable Desktop command without making Web source a Rust compilation input',
    patterns: [
      {
        regex:
          /\binvokeSurfaceSnapshot\(\s*['"]get_external_source_control_snapshot['"]/,
        message: 'missing stable external-source control snapshot invocation',
      },
    ],
  },
  {
    path: 'src/crates/adapters/agent-runtime-ipc/Cargo.toml',
    reason:
      'agent-runtime-ipc must keep the exact feature-free openbitfun-transport dependency',
    patterns: [
      {
        regex: /^openbitfun-transport = \{ path = "\.\.\/transport" \}$/m,
        message:
          'openbitfun-transport must stay feature-free and use the reviewed sibling path',
      },
    ],
  },
  ...[
    'src/apps/cli/Cargo.toml',
    'src/apps/desktop/Cargo.toml',
    'src/crates/adapters/ai-adapters/Cargo.toml',
    'src/crates/assembly/core/Cargo.toml',
    'src/crates/services/miniapp-market-service/Cargo.toml',
    'src/crates/services/services-integrations/Cargo.toml',
    'src/crates/services/skin-market-service/Cargo.toml',
  ].map((path) => ({
    path,
    reason: 'first-party Reqwest consumers must inherit the workspace-owned compatible version',
    patterns: [
      {
        regex: /^reqwest\s*=\s*\{\s*workspace\s*=\s*true(?:\s*,|\s*\})/m,
        message: 'Reqwest dependency must use workspace = true',
      },
    ],
  })),
  {
    path: 'src/crates/services/services-core/src/lib.rs',
    reason:
      'services-core must compile concrete service owners only through their declared capability features',
    patterns: [
      {
        regex: /#\[cfg\(feature = "diagnostics"\)\]\s*pub mod diagnostics;/,
        message: 'missing diagnostic redaction capability source gate',
      },
      {
        regex: /#\[cfg\(feature = "diff"\)\]\s*pub mod diff;/,
        message: 'missing local diff capability source gate',
      },
      {
        regex: /#\[cfg\(any\(feature = "local-storage", feature = "runtime-ownership"\)\)\]\s*mod file_lock;/,
        message: 'missing shared file lock owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "filesystem"\)\]\s*pub mod filesystem;/,
        message: 'missing filesystem capability source gate',
      },
      {
        regex: /#\[cfg\(any\(feature = "json-io", feature = "local-storage"\)\)\]\s*pub mod json_store;/,
        message: 'missing json-io/local-storage JSON owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "local-storage"\)\]\s*pub mod persistence;/,
        message: 'missing local-storage persistence owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "local-storage"\)\]\s*pub mod session;/,
        message: 'missing local-storage session owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "local-storage"\)\]\s*pub mod session_usage;/,
        message: 'missing local-storage session usage owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "local-storage"\)\]\s*pub mod storage_cleanup;/,
        message: 'missing local-storage cleanup owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "local-storage"\)\]\s*pub mod token_usage;/,
        message: 'missing local-storage token usage owner source gate',
      },
      {
        regex: /#\[cfg\(feature = "process-runtime"\)\]\s*pub mod managed_runtime;/,
        message: 'missing process-runtime managed runtime source gate',
      },
      {
        regex: /#\[cfg\(feature = "process-runtime"\)\]\s*pub mod process_manager;/,
        message: 'missing process-runtime process manager source gate',
      },
      {
        regex: /#\[cfg\(feature = "process-runtime"\)\]\s*pub mod process_tree;/,
        message: 'missing process-runtime process tree source gate',
      },
      {
        regex: /#\[cfg\(feature = "process-runtime"\)\]\s*pub mod system;/,
        message: 'missing process-runtime local system source gate',
      },
      {
        regex: /#\[cfg\(feature = "workspace-instructions"\)\]\s*pub mod workspace_instructions;/,
        message: 'missing workspace-instructions source gate',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/workspace_text.rs',
    reason:
      'workspace text contracts stay synchronous while bounded local IO requires its runtime owner',
    patterns: [
      {
        regex: /pub fn normalize_workspace_relative_path\b/,
        message: 'missing feature-free workspace path normalization contract',
      },
      {
        regex: /#\[cfg\(feature = "workspace-text-runtime"\)\]\s*pub async fn read_workspace_relative_text_bounded\b/s,
        message: 'bounded workspace text reads must stay behind workspace-text-runtime',
      },
      {
        regex: /#\[cfg\(feature = "workspace-text-runtime"\)\]\s*pub async fn resolve_workspace_relative_entry\b/s,
        message: 'workspace entry resolution must stay behind workspace-text-runtime',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/persistence.rs',
    reason:
      'services-core must own generic JSON persistence storage while core keeps only PathManager compatibility adapters',
    patterns: [
      {
        regex: /\bpub struct PersistenceService\b/,
        message: 'missing services-owned generic persistence service',
      },
      {
        regex: /\bpub async fn save_json\b/,
        message: 'missing services-owned JSON save path',
      },
      {
        regex: /\bpub async fn load_json\b/,
        message: 'missing services-owned JSON load path',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/storage_cleanup.rs',
    reason:
      'services-core must own reusable storage cleanup traversal and cleanup policy execution',
    patterns: [
      {
        regex: /\bpub struct CleanupRoots\b/,
        message: 'missing explicit cleanup roots contract',
      },
      {
        regex: /\bpub struct CleanupService\b/,
        message: 'missing services-owned cleanup service',
      },
      {
        regex: /\bpub async fn cleanup_all\b/,
        message: 'missing services-owned cleanup entrypoint',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/token_usage/service.rs',
    reason:
      'services-core must own token usage persistence and query aggregation while core keeps compatibility construction',
    patterns: [
      {
        regex: /\bpub struct TokenUsageService\b/,
        message: 'missing services-owned token usage service',
      },
      {
        regex: /\bpub async fn record_usage\b/,
        message: 'missing token usage record owner',
      },
      {
        regex: /\bpub async fn get_model_stats_filtered\b/,
        message: 'missing token usage filtered query owner',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/workspace_instructions.rs',
    reason:
      'services-core must own workspace instruction file IO and file ordering while core keeps prompt rendering',
    patterns: [
      {
        regex: /\bpub struct WorkspaceInstructionFile\b/,
        message: 'missing workspace instruction file DTO',
      },
      {
        regex: /\bpub async fn read_workspace_instruction_files\b/,
        message: 'missing workspace instruction file reader',
      },
      {
        regex: /\bAGENTS\.md\b/,
        message: 'missing AGENTS.md instruction file order anchor',
      },
      {
        regex: /\bCLAUDE\.md\b/,
        message: 'missing CLAUDE.md instruction file order anchor',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/markdown.rs',
    reason:
      'services-core must own front-matter markdown file parsing and persistence',
    patterns: [
      {
        regex: /\bpub struct FrontMatterMarkdown\b/,
        message: 'missing front-matter markdown owner',
      },
      {
        regex: /\bpub fn load_str\b/,
        message: 'missing front-matter string parser',
      },
      {
        regex: /\bpub fn save\b/,
        message: 'missing front-matter save entrypoint',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/Cargo.toml',
    reason:
      'services-core markdown owner must keep serde_yaml behind an explicit feature to avoid growing the minimal service dependency set',
    patterns: [
      {
        regex: /serde_yaml = \{ workspace = true, optional = true \}/,
        message: 'serde_yaml must remain optional in services-core',
      },
      {
        regex: /markdown = \[[^\]]*"dep:serde_yaml"[^\]]*\]/,
        message: 'missing explicit markdown feature for services-core',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/tests/storage_owner_contracts/storage_owner_contracts.rs',
    reason:
      'services-core local storage owner must keep persistence, cleanup, and token usage behavior contracts',
    patterns: [
      {
        regex: /\bpersistence_service_keeps_atomic_json_shape_and_backups\b/,
        message: 'missing persistence owner behavior regression',
      },
      {
        regex: /\bcleanup_service_deletes_old_temp_and_log_files_without_product_paths\b/,
        message: 'missing storage cleanup owner behavior regression',
      },
      {
        regex: /\btoken_usage_service_persists_records_and_filters_subagents_by_default\b/,
        message: 'missing token usage owner behavior regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/tests/declarative_workspace_instruction_contracts.rs',
    reason:
      'services-core workspace instruction owner must keep local and declarative discovery behavior contracts',
    patterns: [
      {
        regex: /\bworkspace_instruction_files_reads_agents_then_claude_and_skips_empty_files\b/,
        message: 'missing workspace instruction owner behavior regression',
      },
      {
        regex: /\bopencode_project_instructions_support_local_files_and_globs_only\b/,
        message: 'missing declarative workspace instruction behavior regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/tests/markdown_owner_contracts.rs',
    reason:
      'services-core markdown owner must keep front-matter behavior contracts behind the markdown feature',
    patterns: [
      {
        regex: /\bfront_matter_markdown_preserves_metadata_and_trimmed_body_contract\b/,
        message: 'missing front-matter owner behavior regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/infrastructure/storage/cleanup.rs',
    reason:
      'core storage cleanup compatibility path must preserve the legacy cleanup DTO imports while delegating behavior to services-core',
    patterns: [
      {
        regex: /\bCleanupCategory\b/,
        message: 'missing CleanupCategory compatibility re-export',
      },
      {
        regex: /\bopenbitfun_services_core::storage_cleanup\b/,
        message: 'missing services-core cleanup owner delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/token_usage/service.rs',
    reason:
      'core token usage service must stay a compatibility wrapper over services-core',
    patterns: [
      {
        regex: /\bopenbitfun_services_core::token_usage::TokenUsageService\b/,
        message: 'missing services-core token usage delegation',
      },
      {
        regex: /\buser_data_dir\(\)\.join\(TOKEN_USAGE_DIR\)/,
        message: 'missing legacy token usage base directory adapter',
      },
    ],
  },
  {
    path: 'src/crates/contracts/events/src/frontend_projection.rs',
    reason:
      'events contract must own the framework-neutral agentic frontend event projection used by current hosts',
    patterns: [
      {
        regex: /\bpub struct AgenticFrontendEvent\b/,
        message: 'missing framework-neutral frontend event projection DTO',
      },
      {
        regex: /\bpub fn project_agentic_frontend_event\b/,
        message: 'missing shared agentic frontend event projection function',
      },
      {
        regex: /\bdeep_review_queue_projection_preserves_camel_case_contract\b/,
        message: 'missing camelCase queue projection regression test',
      },
    ],
  },
  {
    path: 'src/crates/adapters/transport/src/adapters/tauri.rs',
    reason:
      'Tauri transport adapter must only deliver projected events and must not own agentic event field mapping',
    patterns: [
      {
        regex: /\bproject_agentic_frontend_event\b/,
        message: 'missing shared frontend projection usage in Tauri transport',
      },
      {
        regex: /\.emit\(projected\.event_name\.as_str\(\), projected\.payload\)/,
        message: 'Tauri transport must emit projected event name and payload',
      },
    ],
  },
  {
    path: 'src/crates/execution/runtime-services/src/lib.rs',
    reason:
      'runtime-services must own typed runtime service assembly and capability validation contracts',
    patterns: [
      {
        regex: /\bpub struct RuntimeServices\b/,
        message: 'missing runtime services assembly container',
      },
      {
        regex: /\bpub struct RuntimeServicesBuilder\b/,
        message: 'missing runtime services builder',
      },
      {
        regex: /\bpub struct CapabilityAvailability\b/,
        message: 'missing capability availability contract',
      },
      {
        regex: /\bpub struct RuntimeServiceMarkerPort\b/,
        message: 'missing runtime service marker port owner',
      },
      {
        regex: /\bpub trait RuntimeServicesProvider\b/,
        message: 'missing runtime services provider contract',
      },
      {
        regex: /\bpub struct RuntimeServicesRegistry\b/,
        message: 'missing runtime services registry',
      },
      {
        regex: /\bCapabilityMismatch\b/,
        message: 'missing typed capability mismatch error',
      },
      {
        regex: /\brequire_capability\b/,
        message: 'missing typed capability requirement check',
      },
      {
        regex:
          /#\[cfg\(any\(test, feature = "test-support"\)\)\]\s*pub mod test_support;/,
        message: 'runtime-services test support must stay out of ordinary library builds',
      },
      {
        regex: /#\[cfg\(test\)\]\s*mod runtime_services_contracts;/,
        message: 'runtime-services owner contracts must run in the default crate test target',
      },
    ],
  },
  {
    path: 'src/crates/execution/runtime-services/Cargo.toml',
    reason: 'runtime-services test support must require an explicit dev-only feature',
    patterns: [
      {
        regex: /^test-support\s*=\s*\[\]\s*$/m,
        message: 'missing empty runtime-services test-support feature',
      },
      {
        regex: /^default\s*=\s*\[\]\s*$/m,
        message: 'runtime-services default feature set must stay empty',
      },
    ],
  },
  {
    path: 'src/crates/execution/runtime-services/src/backend_events.rs',
    reason:
      'runtime-services must own backend event delivery while core keeps only a compatibility facade',
    patterns: [
      {
        regex: /\bpub enum BackendEvent\b/,
        message: 'missing backend event contract',
      },
      {
        regex: /\bpub struct BackendEventSystem\b/,
        message: 'missing backend event system owner',
      },
      {
        regex: /\bpub fn event_name\b/,
        message: 'missing stable backend event-name mapping',
      },
      {
        regex: /\bpub async fn emit\b/,
        message: 'missing backend event emitter path',
      },
      {
        regex: /\bget_global_event_system\b/,
        message: 'missing global backend event compatibility entry',
      },
      {
        regex: /\bbackend_event_names_remain_stable\b/,
        message: 'missing backend event name regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/runtime-services/src/runtime_services_contracts.rs',
    reason:
      'runtime-services must keep behavior-equivalence contracts for required services, optional capabilities, registry assembly, and remote port exposure',
    patterns: [
      {
        regex: /\bbuilder_requires_mandatory_runtime_services\b/,
        message: 'missing mandatory runtime services regression',
      },
      {
        regex:
          /\bfake_provider_registers_required_and_remote_services_through_registry\b/,
        message: 'missing provider registry assembly regression',
      },
      {
        regex:
          /\bmissing_optional_capability_returns_typed_unsupported_error\b/,
        message: 'missing optional capability unsupported regression',
      },
      {
        regex:
          /\bcapability_availability_reports_optional_service_status_without_side_effects\b/,
        message: 'missing capability availability regression',
      },
      {
        regex: /\bbuilder_rejects_port_registered_under_the_wrong_capability\b/,
        message: 'missing capability mismatch regression',
      },
      {
        regex: /\bregistered_remote_ports_expose_owner_contract_methods\b/,
        message: 'missing remote port owner contract regression',
      },
      {
        regex: /\bmarker_ports_register_optional_service_availability_without_core_dependency\b/,
        message: 'missing marker-port capability availability regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/runtime.rs',
    reason:
      'agent-runtime must expose a narrow port-backed SDK facade without depending on core, apps, or concrete service managers',
    patterns: [
      {
        regex: /\bpub struct AgentRuntime\b/,
        message: 'missing agent runtime facade type',
      },
      {
        regex: /\bpub struct AgentRuntimeBuilder\b/,
        message: 'missing agent runtime builder',
      },
      {
        regex: /\bAgentSubmissionPort\b/,
        message: 'missing agent submission port dependency',
      },
      {
        regex: /\bAgentDialogTurnPort\b/,
        message: 'missing agent dialog turn lifecycle port dependency',
      },
      {
        regex: /\bwith_dialog_turn_port\b/,
        message: 'missing agent dialog turn lifecycle builder hook',
      },
      {
        regex: /\bsubmit_dialog_turn\b/,
        message: 'missing agent dialog turn lifecycle entrypoint',
      },
      {
        regex: /\bAgentLifecycleDeliveryPort\b/,
        message: 'missing agent lifecycle delivery port dependency',
      },
      {
        regex: /\bwith_lifecycle_delivery_port\b/,
        message: 'missing agent lifecycle delivery builder hook',
      },
      {
        regex: /\bdeliver_background_result\b/,
        message: 'missing background result lifecycle delivery entrypoint',
      },
      {
        regex: /\bdeliver_thread_goal\b/,
        message: 'missing thread-goal lifecycle delivery entrypoint',
      },
      {
        regex: /\bAgentTurnCancellationPort\b/,
        message: 'missing agent turn cancellation port dependency',
      },
      {
        regex: /\bAgentSessionManagementPort\b/,
        message: 'missing agent session management port dependency',
      },
      {
        regex: /\bwith_session_management_port\b/,
        message: 'missing agent session management builder hook',
      },
      {
        regex: /\bMissingSessionManagementPort\b/,
        message: 'missing agent session management missing-port guard',
      },
      {
        regex: /\blist_sessions\b/,
        message: 'missing agent session list entrypoint',
      },
      {
        regex: /\bdelete_session\b/,
        message: 'missing agent session delete entrypoint',
      },
      {
        regex: /\bresolve_session_workspace_binding\b/,
        message: 'missing agent session workspace resolution entrypoint',
      },
      {
        regex: /\bsession_management_delegates_to_registered_port\b/,
        message: 'missing agent session management port delegation regression',
      },
      {
        regex: /\bRuntimeServices\b/,
        message: 'missing typed runtime services injection',
      },
      {
        regex: /\bRuntimeEventEnvelope\b/,
        message: 'missing runtime event envelope contract',
      },
      {
        regex: /\bpub struct AgentEventStream\b/,
        message: 'missing agent runtime event stream contract',
      },
      {
        regex: /\bpub fn with_event_stream\b/,
        message: 'missing agent runtime event stream builder hook',
      },
      {
        regex: /\bpub trait RuntimeToolRegistry\b/,
        message: 'missing SDK tool registry abstraction',
      },
      {
        regex: /\bpub fn with_tool_registry\b/,
        message: 'missing SDK tool registry builder hook',
      },
      {
        regex: /\bpub fn with_hook_registry\b/,
        message: 'missing SDK hook registry builder hook',
      },
      {
        regex: /\bpub enum SessionSelector\b/,
        message: 'missing session selector contract',
      },
      {
        regex: /\bpub struct AgentRunRequest\b/,
        message: 'missing agent run request contract',
      },
      {
        regex: /\bpub struct AgentRunHandle\b/,
        message: 'missing agent run handle contract',
      },
      {
        regex: /\bpub async fn run\b/,
        message: 'missing agent runtime run entrypoint',
      },
      {
        regex: /\bpub async fn publish_event\b/,
        message: 'missing explicit runtime event publish entrypoint',
      },
      {
        regex: /\bpublish_event_uses_runtime_services_event_sink\b/,
        message: 'missing runtime services event sink regression',
      },
      {
        regex: /\brun_handle_exposes_configured_agent_event_stream\b/,
        message: 'missing agent runtime event stream regression',
      },
      {
        regex: /\bport_errors_remain_typed\b/,
        message: 'missing typed port error regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/sdk_smoke.rs',
    reason:
      'agent-runtime SDK smoke tests must prove the facade works with injected fake provider, services, tools, and hooks without core',
    patterns: [
      {
        regex: /\bsdk_facade_exposes_versioned_preview_compatibility_contract\b/,
        message: 'missing SDK API version and compatibility smoke',
      },
      {
        regex: /\bsdk_facade_runs_with_fake_provider_and_local_event_stream\b/,
        message: 'missing SDK fake-provider event-stream smoke',
      },
      {
        regex: /\bsdk_facade_accepts_fake_services_tools_and_hooks_without_core\b/,
        message: 'missing SDK services/tools/hooks injection smoke',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/sdk.rs',
    reason:
      'agent-runtime SDK public facade must expose versioned compatibility metadata and only stable injection contracts',
    patterns: [
      {
        regex: /\bpub const AGENT_RUNTIME_SDK_API_VERSION\b/,
        message: 'missing SDK API version constant',
      },
      {
        regex: /\bpub enum AgentRuntimeSdkStability\b/,
        message: 'missing SDK stability contract',
      },
      {
        regex: /#\[non_exhaustive\]\s+pub enum AgentRuntimeSdkStability/s,
        message: 'SDK stability contract must remain externally extensible',
      },
      {
        regex: /\bpub struct AgentRuntimeSdkCompatibility\b/,
        message: 'missing SDK compatibility contract',
      },
      {
        regex: /#\[non_exhaustive\]\s+pub struct AgentRuntimeSdkCompatibility/s,
        message: 'SDK compatibility contract must remain externally extensible',
      },
      {
        regex: /\bimpl AgentRuntimeSdkCompatibility\b/,
        message: 'missing current SDK compatibility entrypoint',
      },
      {
        regex: /\bpub use openbitfun_agent_tools::\{/,
        message: 'missing SDK tool registry re-exports',
      },
      {
        regex: /\bpub use openbitfun_runtime_services::\{/,
        message: 'missing SDK runtime-services re-exports',
      },
      {
        regex: /\bPortResult\b/,
        message: 'missing SDK port result re-export',
      },
      {
        regex: /\bRuntimeServicePort\b/,
        message: 'missing SDK runtime service port re-export',
      },
      {
        regex: /\bFileSystemPort\b/,
        message: 'missing SDK filesystem service port re-export',
      },
      {
        regex: /\bRemoteWorkspacePort\b/,
        message: 'missing SDK remote workspace service port re-export',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/Cargo.toml',
    reason:
      'agent-runtime SDK package must keep an explicit empty default feature set for minimal embedders',
    patterns: [
      {
        regex: /\[features\]/,
        message: 'missing explicit SDK feature section',
      },
      {
        regex: /default = \[\]/,
        message: 'agent-runtime default feature set must stay empty',
      },
      {
        regex: /\[\[example\]\]\r?\nname = "sdk_minimal"\r?\npath = "examples\/sdk_minimal\.rs"\r?\nrequired-features = \["agent-runtime"\]/,
        message: 'sdk_minimal example must declare the versioned agent-runtime owner feature',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/context_profile.rs',
    reason:
      'agent-runtime must own provider-neutral context profile and model capability policy facts',
    patterns: [
      {
        regex: /\bpub enum ContextProfile\b/,
        message: 'missing context profile fact',
      },
      {
        regex: /\bpub enum ModelCapabilityProfile\b/,
        message: 'missing model capability profile fact',
      },
      {
        regex: /\bpub struct ContextProfilePolicy\b/,
        message: 'missing context profile policy fact',
      },
      {
        regex: /\bfor_subagent_context_and_models\b/,
        message: 'missing subagent context/model policy helper',
      },
      {
        regex: /\bmodel_capability_weak_for_mini\b/,
        message: 'missing weak-model regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/session_state.rs',
    reason:
      'agent-runtime must own provider-neutral session state facts and event-label projection',
    patterns: [
      {
        regex: /\bpub enum SessionState\b/,
        message: 'missing session state fact',
      },
      {
        regex: /\bpub enum ProcessingPhase\b/,
        message: 'missing processing phase fact',
      },
      {
        regex: /\bdialog_state_fact\b/,
        message: 'missing session state fact projection',
      },
      {
        regex: /\bsession_state_label_for_state\b/,
        message: 'missing session state label projection',
      },
      {
        regex: /\bprocessing_state_serialization_stays_compatible\b/,
        message: 'missing session state serialization regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/session.rs',
    reason:
      'agent-runtime must own provider-neutral session config, summary, and persisted state facts',
    patterns: [
      {
        regex: /\bpub struct Session\b/,
        message: 'missing session fact',
      },
      {
        regex: /\bpub struct SessionConfig\b/,
        message: 'missing session config fact',
      },
      {
        regex: /\bpub struct SessionSummary\b/,
        message: 'missing session summary fact',
      },
      {
        regex: /\bpub use openbitfun_core_types::SessionKind\b/,
        message: 'missing session kind compatibility export',
      },
      {
        regex: /\bpub struct PersistedSessionStateFile\b/,
        message: 'missing persisted session state sidecar fact',
      },
      {
        regex: /\bsanitize_persisted_session_state\b/,
        message: 'missing persisted session state sanitization owner',
      },
      {
        regex: /\bpersisted_session_state_file_shape_stays_compatible\b/,
        message: 'missing persisted session state wire-shape regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/dialog_turn.rs',
    reason:
      'agent-runtime must own provider-neutral dialog-turn id and statistics facts',
    patterns: [
      {
        regex: /\bpub fn new_turn_id\b/,
        message: 'missing dialog-turn id helper',
      },
      {
        regex: /\bpub struct TurnStats\b/,
        message: 'missing dialog-turn statistics fact',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/side_question.rs',
    reason:
      'agent-runtime must own runtime-only side-question cancellation and active-turn tracking',
    patterns: [
      {
        regex: /\bpub struct SideQuestionRuntime\b/,
        message: 'missing side-question runtime owner',
      },
      {
        regex: /\bpub struct ActiveBtwTurn\b/,
        message: 'missing active /btw turn fact',
      },
      {
        regex: /\bregister_btw_turn\b/,
        message: 'missing active /btw turn registration',
      },
      {
        regex: /\bregistering_same_request_cancels_previous_token\b/,
        message: 'missing side-question cancellation regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/examples/sdk_minimal.rs',
    reason:
      'agent-runtime SDK must keep a minimal external embedder example that uses the sdk facade without core',
    patterns: [
      {
        regex: /\buse openbitfun_agent_runtime::sdk::\{/,
        message: 'SDK example must import through the public sdk facade',
      },
      {
        regex: /\bAgentRuntimeSdkCompatibility::current\b/,
        message: 'SDK example must expose the compatibility contract',
      },
      {
        regex: /\bimpl AgentSubmissionPort for ExampleAgentProvider\b/,
        message: 'SDK example must show caller-provided submission port injection',
      },
      {
        regex: /\bAgentRuntimeBuilder::new\(\)/,
        message: 'SDK example must build through AgentRuntimeBuilder',
      },
      {
        regex: /\bAgentRunRequest::new\b/,
        message: 'SDK example must run through AgentRunRequest',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/prompt.rs',
    reason:
      'agent-runtime must own prompt-loop facts that do not require concrete workspace or product IO',
    patterns: [
      {
        regex: /\bpub enum UserContextSection\b/,
        message: 'missing agent-runtime user-context section contract',
      },
      {
        regex: /\bpub struct UserContextPolicy\b/,
        message: 'missing agent-runtime user-context policy contract',
      },
      {
        regex: /\bpub struct ToolListingSections\b/,
        message: 'missing agent-runtime tool-listing section contract',
      },
      {
        regex: /\bpub struct PrependedPromptReminders\b/,
        message: 'missing agent-runtime prepended-reminder contract',
      },
      {
        regex: /\bpub struct PromptEnvironmentFacts\b/,
        message: 'missing agent-runtime prompt environment facts contract',
      },
      {
        regex: /\bpub fn render_prompt_environment_info\b/,
        message: 'missing agent-runtime prompt environment renderer',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/prompt_cache.rs',
    reason:
      'agent-runtime must own prompt-cache policy, identities, DTOs, scope keys, and in-memory runtime store',
    patterns: [
      {
        regex: /\bpub const PROMPT_CACHE_SCHEMA_VERSION\b/,
        message: 'missing agent-runtime prompt-cache schema fact',
      },
      {
        regex: /\bpub struct PromptCachePolicy\b/,
        message: 'missing agent-runtime prompt-cache policy',
      },
      {
        regex: /\bpub fn prompt_cache_scope_key\b/,
        message: 'missing agent-runtime prompt-cache scope-key helper',
      },
      {
        regex: /\bpub struct SessionPromptCacheStore\b/,
        message: 'missing agent-runtime in-memory prompt-cache store',
      },
      {
        regex: /\bpub enum PromptCacheLookup\b/,
        message: 'missing agent-runtime prompt-cache lookup contract',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/skill_agent_snapshot.rs',
    reason:
      'agent-runtime must own turn skill/agent snapshot DTOs, diff rendering, listing sections, and in-memory runtime store',
    patterns: [
      {
        regex: /\bpub struct SkillSnapshotEntry\b/,
        message: 'missing agent-runtime skill snapshot DTO',
      },
      {
        regex: /\bpub struct AgentSnapshotEntry\b/,
        message: 'missing agent-runtime agent snapshot DTO',
      },
      {
        regex: /\bpub struct TurnSkillAgentSnapshot\b/,
        message: 'missing agent-runtime turn skill/agent snapshot DTO',
      },
      {
        regex: /\bpub struct SkillAgentDiff\b/,
        message: 'missing agent-runtime skill/agent diff contract',
      },
      {
        regex: /\bpub fn diff_skill_agent_snapshot\b/,
        message: 'missing agent-runtime skill/agent diff owner',
      },
      {
        regex: /\bpub fn build_skill_agent_tool_listing_sections_from_snapshot\b/,
        message: 'missing agent-runtime tool listing section owner',
      },
      {
        regex: /\bpub struct TurnSkillAgentSnapshotStore\b/,
        message: 'missing agent-runtime turn skill/agent snapshot store',
      },
      {
        regex: /\bskill_agent_diff_renders_changed_added_and_removed_entries\b/,
        message: 'missing agent-runtime skill/agent diff rendering regression',
      },
      {
        regex: /\blatest_snapshot_at_or_before_returns_nearest_sparse_snapshot\b/,
        message: 'missing agent-runtime sparse turn snapshot store regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/review_read_receipt.rs',
    reason:
      'agent-runtime must own provider-neutral code-review read receipts and their session-scoped in-memory store',
    patterns: [
      {
        regex: /\bpub struct FileRevision\b/,
        message: 'missing agent-runtime file revision DTO',
      },
      {
        regex: /\bpub struct ReviewReadCoverage\b/,
        message: 'missing agent-runtime review read coverage DTO',
      },
      {
        regex: /\bpub struct ReviewReadReceiptStore\b/,
        message: 'missing agent-runtime review read receipt store',
      },
      {
        regex: /\breview_read_receipt_store_scopes_entries_by_session\b/,
        message: 'missing review read receipt session scoping regression',
      },
      {
        regex: /\breview_read_receipt_covers_only_previously_returned_lines\b/,
        message: 'missing review read receipt coverage regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/evidence_ledger.rs',
    reason:
      'agent-runtime must own provider-neutral session evidence ledger state and compression contract projection',
    patterns: [
      {
        regex: /\bpub enum EvidenceLedgerTargetKind\b/,
        message: 'missing agent-runtime evidence ledger target-kind DTO',
      },
      {
        regex: /\bpub enum EvidenceLedgerEventStatus\b/,
        message: 'missing agent-runtime evidence ledger event status DTO',
      },
      {
        regex: /\bpub struct EvidenceLedgerEvent\b/,
        message: 'missing agent-runtime evidence ledger event DTO',
      },
      {
        regex: /\bpub struct EvidenceLedgerSummary\b/,
        message: 'missing agent-runtime evidence ledger summary DTO',
      },
      {
        regex: /\bpub struct SessionEvidenceLedger\b/,
        message: 'missing agent-runtime session evidence ledger store',
      },
      {
        regex: /\bimpl From<EvidenceLedgerSummary> for CompressionContract\b/,
        message: 'missing agent-runtime evidence ledger compression contract projection',
      },
      {
        regex: /\bimpl From<LightCheckpoint> for EvidenceLedgerCheckpoint\b/,
        message: 'missing agent-runtime checkpoint evidence projection',
      },
      {
        regex: /\bledger_reads_events_scoped_by_session_and_turn\b/,
        message: 'missing agent-runtime evidence ledger session/turn scoping regression',
      },
      {
        regex: /\bcheckpoint_from_light_checkpoint_preserves_recovery_boundary_metadata\b/,
        message: 'missing agent-runtime checkpoint evidence projection regression',
      },
      {
        regex: /\bsummary_projects_into_compression_contract\b/,
        message: 'missing agent-runtime evidence ledger compression contract regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/turn_cancellation.rs',
    reason:
      'agent-runtime must own provider-neutral dialog-turn cancellation token lifecycle state',
    patterns: [
      {
        regex: /\bpub struct DialogTurnCancellationTokenStore\b/,
        message: 'missing dialog-turn cancellation token store',
      },
      {
        regex: /\bpub fn get_or_insert_new\b/,
        message: 'missing dialog-turn cancellation token creation/reuse owner',
      },
      {
        regex: /\bpub fn is_cancelled\b/,
        message: 'missing dialog-turn cancellation state query',
      },
      {
        regex: /\bturn_cancellation_store_reuses_existing_token\b/,
        message: 'missing dialog-turn cancellation token reuse regression',
      },
      {
        regex: /\bturn_cancellation_store_cancels_registered_token\b/,
        message: 'missing dialog-turn cancellation token cancel regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/subagent_task.rs',
    reason:
      'agent-runtime must own provider-neutral subagent Task completion presentation shared by ordinary Task and product command delegation',
    patterns: [
      {
        regex: /\bpub struct SubagentTaskCompletionResultInput\b/,
        message: 'missing provider-neutral subagent Task completion input',
      },
      {
        regex: /\bpub fn subagent_task_completion_result\b/,
        message: 'missing provider-neutral subagent Task completion formatter',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/deep_review/mod.rs',
    reason:
      'agent-runtime must own provider-neutral DeepReview policy, manifest, budget, queue, report, and shared-context runtime state',
    patterns: [
      {
        regex: /\bpub mod budget\b/,
        message: 'missing DeepReview budget owner module',
      },
      {
        regex: /\bpub mod manifest\b/,
        message: 'missing DeepReview manifest owner module',
      },
      {
        regex: /\bpub mod report\b/,
        message: 'missing DeepReview report owner module',
      },
      {
        regex: /\bpub mod task_execution\b/,
        message: 'missing DeepReview task execution owner module',
      },
      {
        regex: /\bpub use runtime_state::\*/,
        message: 'missing DeepReview runtime state exports',
      },
      {
        regex: /\bDeepReviewCacheUpdate\b/,
        message: 'missing DeepReview report cache update export',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/deep_review/task_execution.rs',
    reason:
      'agent-runtime DeepReview task execution owner must keep provider-neutral packet matching, retry validation, capacity timing, and capacity-skipped presentation out of core',
    patterns: [
      {
        regex: /\bpub fn deep_review_packet_id_for_cache\b/,
        message: 'missing DeepReview packet id cache owner function',
      },
      {
        regex: /\bpub fn ensure_deep_review_retry_coverage\b/,
        message: 'missing DeepReview bounded retry coverage owner function',
      },
      {
        regex: /\bpub fn provider_capacity_queue_wait_seconds_for_attempt\b/,
        message: 'missing DeepReview provider capacity backoff owner function',
      },
      {
        regex: /\bpub fn capacity_decision_for_provider_error_facts\b/,
        message: 'missing DeepReview provider capacity error decision owner function',
      },
      {
        regex: /\bpub fn local_reviewer_capacity_queue_decision\b/,
        message: 'missing DeepReview local reviewer capacity decision owner function',
      },
      {
        regex: /\bpub fn decide_provider_capacity_queue_step\b/,
        message: 'missing DeepReview provider capacity queue step owner function',
      },
      {
        regex: /\bpub struct DeepReviewProviderCapacityQueueRuntime\b/,
        message: 'missing DeepReview provider capacity queue runtime owner',
      },
      {
        regex: /\bpub struct DeepReviewProviderCapacityRetryRuntime\b/,
        message: 'missing DeepReview provider capacity retry runtime owner',
      },
      {
        regex: /\bpub enum DeepReviewProviderCapacityRetryDecision\b/,
        message: 'missing DeepReview provider capacity retry decision owner',
      },
      {
        regex: /\bpub fn decide_blocked_reviewer_admission_queue_step\b/,
        message: 'missing DeepReview reviewer admission queue step owner function',
      },
      {
        regex: /\bpub struct DeepReviewReviewerAdmissionQueueRuntime\b/,
        message: 'missing DeepReview reviewer admission queue runtime owner',
      },
      {
        regex: /\bstruct QueueWaitTimer\b/,
        message: 'missing DeepReview queue wait timing owner',
      },
      {
        regex: /\bpub fn deep_review_task_completion_result\b/,
        message: 'missing DeepReview task completion result compatibility wrapper',
      },
      {
        regex: /crate::subagent_task::subagent_task_completion_result/,
        message: 'missing DeepReview delegation to the provider-neutral Task formatter',
      },
      {
        regex: /\bpub fn deep_review_cancelled_reviewer_result\b/,
        message: 'missing DeepReview cancelled reviewer result presentation owner function',
      },
      {
        regex: /\bpub fn should_emit_deep_review_retry_guidance\b/,
        message: 'missing DeepReview retry guidance emission owner function',
      },
      {
        regex: /\bpub fn deep_review_retry_guidance\b/,
        message: 'missing DeepReview retry guidance presentation owner function',
      },
      {
        regex: /\bpub fn auto_retry_suppression_reason\b/,
        message: 'missing DeepReview auto-retry suppression reason owner function',
      },
      {
        regex: /\bpub fn ensure_deep_review_auto_retry_allowed\b/,
        message: 'missing DeepReview auto-retry admission owner function',
      },
      {
        regex: /\bpub fn capacity_skip_result_for_local_queue_outcome\b/,
        message: 'missing DeepReview local capacity-skipped presentation owner function',
      },
      {
        regex: /\bpub fn capacity_skip_result_for_provider_queue_outcome\b/,
        message: 'missing DeepReview provider capacity-skipped presentation owner function',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/deep_review/diagnostics.rs',
    reason:
      'agent-runtime DeepReview diagnostics owner must keep provider-neutral runtime diagnostics log shaping out of core',
    patterns: [
      {
        regex: /\bpub fn deep_review_runtime_diagnostics_log_line\b/,
        message: 'missing DeepReview runtime diagnostics log owner function',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/deep_review/report.rs',
    reason:
      'agent-runtime DeepReview report owner must keep provider-neutral packet metadata, reliability signals, and cache update logic out of core',
    patterns: [
      {
        regex: /\bpub fn fill_deep_review_packet_metadata\b/,
        message: 'missing DeepReview packet metadata owner function',
      },
      {
        regex: /\bpub fn fill_deep_review_reliability_signals\b/,
        message: 'missing DeepReview reliability signal owner function',
      },
      {
        regex: /\bpub fn fill_deep_review_runtime_tracker_signal\b/,
        message: 'missing DeepReview runtime tracker reliability signal owner function',
      },
      {
        regex: /\bpub fn fill_deep_review_cache_update_signals\b/,
        message: 'missing DeepReview cache update reliability signal owner function',
      },
      {
        regex: /\bpub fn deep_review_cache_from_completed_reviewers\b/,
        message: 'missing DeepReview cache update owner function',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_long_horizon_contracts/deep_review_policy_contracts.rs',
    reason:
      'agent-runtime DeepReview owner must keep behavior-equivalence contracts for policy, queue state, tool context, report enrichment, and cache updates',
    patterns: [
      {
        regex: /\bdeep_review_policy_owner_exposes_execution_policy_and_manifest_gate\b/,
        message: 'missing DeepReview policy/manifest owner regression',
      },
      {
        regex: /\bdeep_review_runtime_owner_tracks_budget_queue_and_shared_context\b/,
        message: 'missing DeepReview budget/queue/shared-context regression',
      },
      {
        regex: /\bdeep_review_report_owner_enriches_packet_reliability_and_cache_facts\b/,
        message: 'missing DeepReview report/cache owner regression',
      },
      {
        regex: /\bdeep_review_task_execution_owner_preserves_packet_retry_and_queue_contracts\b/,
        message: 'missing DeepReview task execution owner regression',
      },
      {
        regex: /\bcapacity_decision_for_provider_error_facts\b/,
        message: 'missing DeepReview provider capacity error decision regression',
      },
      {
        regex: /\bdecide_provider_capacity_queue_step\b/,
        message: 'missing DeepReview provider queue step decision regression',
      },
      {
        regex: /\bdecide_blocked_reviewer_admission_queue_step\b/,
        message: 'missing DeepReview blocked admission queue decision regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/prompt_cache_contracts.rs',
    reason:
      'agent-runtime prompt-cache owner must keep behavior-equivalence contracts for cache identity, expiry, invalidation, and scope-key shape',
    patterns: [
      {
        regex: /\bprompt_cache_policy_keeps_existing_default_persistence_ttl\b/,
        message: 'missing prompt-cache default TTL regression',
      },
      {
        regex: /\bprompt_cache_lookup_preserves_identity_and_expiry_semantics\b/,
        message: 'missing prompt-cache identity/expiry regression',
      },
      {
        regex: /\bprompt_cache_scope_key_preserves_legacy_mode_switch_shape\b/,
        message: 'missing prompt-cache scope-key shape regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/src/lib.rs',
    reason:
      'product-capabilities must own product capability selection without concrete runtime implementations',
    patterns: [
      {
        regex: /\bProductCapabilityAssembly\b/,
        message: 'missing product capability assembly owner',
      },
      {
        regex: /\bpub fn agent_ids\b/,
        message: 'missing profile-scoped built-in Agent selection',
      },
      {
        regex: /\bProductFeatureGroup\b/,
        message: 'missing product feature group fact owner',
      },
      {
        regex: /\bProductRuntimeAssembly\b/,
        message: 'missing product runtime assembly owner',
      },
      {
        regex: /\bProductDeliveryProfileEntry\b/,
        message: 'missing product delivery profile entry matrix',
      },
      {
        regex: /\bMobileWeb\b/,
        message: 'missing mobile web delivery profile coverage',
      },
      {
        regex: /\bDeliveryProfile::Sdk\b/,
        message: 'missing SDK delivery profile coverage',
      },
      {
        regex: /\bProductAssembler\b/,
        message: 'missing typed product assembler',
      },
      {
        regex: /\bProductAssemblyInput\b/,
        message: 'missing product assembly input contract',
      },
      {
        regex: /\bProductRuntimeParts\b/,
        message: 'missing product runtime parts output',
      },
      {
        regex: /\binto_runtime_parts\b/,
        message: 'missing owned runtime-parts handoff for SDK/product assembly consumers',
      },
      {
        regex: /\bfeature_groups_from_tool_provider_group_plan\b/,
        message: 'missing tool-provider feature group projection owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/product_capabilities.rs',
    reason:
      'product-capabilities tests must protect product shape facts and runtime service gap reporting',
    patterns: [
      {
        regex: /\bproduct_assembly_plan_exposes_build_feature_groups_explicitly\b/,
        message: 'missing product feature group shape regression',
      },
      {
        regex: /\bproduct_runtime_assembly_reports_runtime_service_capability_gaps\b/,
        message: 'missing product runtime service gap regression',
      },
      {
        regex: /\bproduct_delivery_profile_matrix_documents_current_core_dependency_shape\b/,
        message: 'missing delivery profile entry matrix regression',
      },
      {
        regex: /\ball_current_product_profiles\b/,
        message: 'missing delivery profile matrix coverage guard',
      },
      {
        regex: /\bproduct_assembler_builds_runtime_parts_from_explicit_profile_input\b/,
        message: 'missing typed product assembler regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/runtime_boundary.rs',
    reason:
      'product-capabilities tests must keep headless Agent hosts free of named product workflows and monolithic tool groups',
    patterns: [
      {
        regex: /\bheadless_agent_hosts_select_only_the_code_agent_product_capability\b/,
        message: 'missing headless capability boundary regression',
      },
      {
        regex: /\bheadless_agent_hosts_keep_explore_code_agents_without_product_workflow_agents\b/,
        message: 'missing headless Agent catalog boundary regression',
      },
      {
        regex: /\bcode_agent_tools_are_selected_from_atomic_provider_groups\b/,
        message: 'missing atomic tool group boundary regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/plugin_product_shape.rs',
    reason:
      'product-capabilities plugin shape tests must protect P0 plugin-capable profiles, non-P0 rejection, default availability reasons, and runtime handoff',
    patterns: [
      {
        regex: /\bexecutable_plugin_runtime_is_limited_to_product_full_desktop_and_cli\b/,
        message: 'missing P0 executable plugin runtime profile regression',
      },
      {
        regex: /\bexecutable_plugin_runtime_client_builds_agent_runtime_parts\b/,
        message: 'missing ProductAssembler to AgentRuntimeBuilder host handoff regression',
      },
      {
        regex: /\bnon_p0_surfaces_cannot_inherit_executable_plugin_runtime\b/,
        message: 'missing non-P0 executable plugin runtime rejection regression',
      },
      {
        regex: /\bdefault_product_shapes_expose_only_disabled_plugin_availability\b/,
        message: 'missing default plugin availability reason regression',
      },
      {
        regex: /\bdefault_assembled_product_shapes_keep_profile_specific_plugin_availability\b/,
        message: 'missing assembled default plugin availability reason regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/product-capabilities/tests/product_capability_contracts/product_sdk_assembly.rs',
    reason:
      'product-capabilities must prove product runtime parts can feed the SDK runtime without openbitfun-core',
    patterns: [
      {
        regex: /\bproduct_runtime_parts_can_build_agent_runtime_sdk_without_core\b/,
        message: 'missing product assembly to SDK runtime smoke',
      },
      {
        regex:
          /\bsdk_delivery_profile_builds_shared_runtime_owner_ceiling_without_openbitfun_core\b/,
        message: 'missing SDK delivery profile identity and shared runtime-owner ceiling smoke',
      },
      {
        regex: /\bProductAssembler::new\(\)/,
        message: 'product SDK smoke must assemble through ProductAssembler',
      },
      {
        regex: /\binto_runtime_parts\b/,
        message: 'product SDK smoke must consume owned ProductRuntimeParts',
      },
      {
        regex: /\bAgentRuntimeBuilder::new\(\)/,
        message: 'product SDK smoke must build through the Agent Runtime SDK facade',
      },
      {
        regex: /\bDeliveryProfile::Cli\b/,
        message: 'product SDK smoke must cover a product-full compatibility delivery profile',
      },
      {
        regex: /\bDeliveryProfile::Sdk\b/,
        message: 'product SDK smoke must cover the distinct SDK delivery profile',
      },
    ],
  },
  {
    path: 'src/apps/sdk-host/src/runtime.rs',
    reason:
      'the standalone SDK Host must inject its selected delivery profile into the Core tool owner before agentic system construction',
    patterns: [
      {
        regex: /\binit_agentic_system_for_profile_with_runtime_ownership\b/,
        message:
          'SDK Host runtime must initialize Core with its selected delivery profile and Runtime ownership owner',
      },
      {
        regex: /\bselect_agentic_system_profile\b/,
        message:
          'SDK Host runtime must select its profile before configuration can read the global tool owner',
      },
      {
        regex: /\bDeliveryProfile::Sdk\b/,
        message: 'SDK Host runtime must retain a distinct SDK delivery profile',
      },
    ],
  },
  {
    path: 'src/apps/sdk-host/src/main.rs',
    reason:
      'the SDK Host composition root must select its delivery profile before global configuration canonicalization',
    patterns: [
      {
        regex: /\bselect_process_profile\b/,
        message: 'SDK Host process startup must select its delivery profile first',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/agents.rs',
    reason:
      'agent-runtime must own shared mode config profile facts that are runtime-visible and product-neutral',
    patterns: [
      {
        regex: /\bpub const STANDARD_HARNESS_PROMPT_TEMPLATE\b/,
        message: 'missing Standard Harness prompt template fact',
      },
      {
        regex: /\bpub const STANDARD_HARNESS_CONFIG_ID\b/,
        message: 'missing Standard Harness config profile id',
      },
      {
        regex: /\bpub fn resolve_mode_config_profile_id\b/,
        message: 'missing mode config profile resolver',
      },
      {
        regex: /\bpub fn mode_config_profile_member_mode_ids\b/,
        message: 'missing mode config profile member lookup',
      },
      {
        regex: /\bpub fn mode_presentation_rank\b/,
        message: 'missing mode presentation rank',
      },
      {
        regex: /\bpub fn standard_harness_user_context_policy\b/,
        message: 'missing Standard Harness user-context policy',
      },
      {
        regex: /\bpub enum SubagentListScope\b/,
        message: 'missing subagent query list-scope contract',
      },
      {
        regex: /\bpub struct SubagentQueryContext\b/,
        message: 'missing subagent query context contract',
      },
      {
        regex: /\bpub struct SubagentVisibilityPolicy\b/,
        message: 'missing subagent visibility policy contract',
      },
      {
        regex: /\bpub enum SubagentStateReason\b/,
        message: 'missing subagent state reason contract',
      },
      {
        regex: /\bpub struct SubagentOverrideLayers\b/,
        message: 'missing subagent override-layer contract',
      },
      {
        regex: /\bpub fn resolve_subagent_default_enabled\b/,
        message: 'missing subagent default-enabled decision helper',
      },
      {
        regex: /\bpub fn resolve_subagent_availability\b/,
        message: 'missing subagent availability decision helper',
      },
      {
        regex: /\bpub enum SubAgentSource\b/,
        message: 'missing subagent source DTO',
      },
      {
        regex: /\bpub const fn subagent_source_kind\b/,
        message: 'missing subagent source runtime-kind mapping',
      },
      {
        regex: /\bpub const fn subagent_source_presentation_rank\b/,
        message: 'missing subagent source presentation rank',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/agent_registry_contracts.rs',
    reason:
      'agent-runtime agent registry owner must keep behavior-equivalence contracts for visibility, availability, shared mode config, and source ordering',
    patterns: [
      {
        regex:
          /\bvisibility_policy_supports_public_restricted_hidden_and_denied_parents\b/,
        message: 'missing subagent visibility policy regression',
      },
      {
        regex:
          /\bavailability_preserves_builtin_project_and_user_override_layering\b/,
        message: 'missing subagent availability layering regression',
      },
      {
        regex:
          /\bdefault_enabled_uses_visibility_only_for_builtin_subagents\b/,
        message: 'missing subagent default-enabled regression',
      },
      {
        regex: /\bshared_coding_modes_resolve_to_the_same_config_profile\b/,
        message: 'missing Standard Harness profile regression',
      },
      {
        regex:
          /\bsubagent_source_contract_preserves_runtime_kind_and_presentation_order\b/,
        message: 'missing subagent source ordering regression',
      },
      {
        regex:
          /\bmode_presentation_and_shared_context_policy_match_existing_mode_contract\b/,
        message: 'missing mode presentation/context-policy regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/custom_agent.rs',
    reason:
      'agent-runtime must own custom agent portable schema defaults, discovery, validation, and markdown front-matter IO',
    patterns: [
      {
        regex: /\bpub enum CustomAgentKind\b/,
        message: 'missing custom agent kind contract',
      },
      {
        regex: /\bpub struct CustomAgentDiscoveryRoots\b/,
        message: 'missing custom agent discovery root contract',
      },
      {
        regex: /\bpub struct CustomAgentLoadReport\b/,
        message: 'missing custom agent load report contract',
      },
      {
        regex: /\bpub struct CustomAgentDefinition\b/,
        message: 'missing custom agent definition schema',
      },
      {
        regex: /\bpub enum CustomAgentDefinitionError\b/,
        message: 'missing custom agent definition validation errors',
      },
      {
        regex: /\bDEFAULT_CUSTOM_MODE_TOOLS\b/,
        message: 'missing custom mode default tools contract',
      },
      {
        regex: /\bDEFAULT_CUSTOM_SUBAGENT_TOOLS\b/,
        message: 'missing custom subagent default tools contract',
      },
      {
        regex: /\bpub fn custom_agent_read_markdown_file\b/,
        message: 'missing custom agent markdown file reader',
      },
      {
        regex: /\bpub fn custom_agent_save_markdown_file\b/,
        message: 'missing custom agent markdown file writer',
      },
      {
        regex: /\bpub fn custom_agent_possible_dirs\b/,
        message: 'missing custom agent directory discovery owner',
      },
      {
        regex: /\bpub fn load_custom_agent_definitions\b/,
        message: 'missing custom agent definition loading owner',
      },
      {
        regex: /\bpub struct CustomAgentValidationContext\b/,
        message: 'missing custom agent validation context',
      },
      {
        regex: /\bpub struct CustomAgentValidationReport\b/,
        message: 'missing custom agent validation report',
      },
      {
        regex: /\bpub struct CustomAgentModelFallback\b/,
        message: 'missing custom agent model fallback contract',
      },
      {
        regex: /\bpub fn validate_custom_agent_definition\b/,
        message: 'missing custom agent validation owner',
      },
      {
        regex: /\bpub fn custom_agent_review_writable_tools\b/,
        message: 'missing custom agent review-tool validation owner',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/custom_subagent.rs',
    reason:
      'agent-runtime custom_subagent module must stay a legacy compatibility wrapper over custom_agent owner decisions',
    patterns: [
      {
        regex: /\bpub type CustomSubagentKind = CustomAgentLevel\b/,
        message: 'missing custom subagent kind compatibility alias',
      },
      {
        regex: /\bpub type CustomSubagentDefinition = CustomAgentDefinition\b/,
        message: 'missing custom subagent definition compatibility alias',
      },
      {
        regex: /\bpub type CustomSubagentDiscoveryRoots = CustomAgentDiscoveryRoots\b/,
        message: 'missing custom subagent discovery root compatibility alias',
      },
      {
        regex: /\bpub fn load_custom_subagent_definitions\b/,
        message: 'missing custom subagent filtered load wrapper',
      },
      {
        regex: /\bcustom_agent_read_markdown_file\b/,
        message: 'missing custom subagent markdown read delegation',
      },
      {
        regex: /\bcustom_agent_save_markdown_file\b/,
        message: 'missing custom subagent markdown save delegation',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/custom_subagent_discovery_contracts.rs',
    reason:
      'agent-runtime custom subagent discovery owner must keep behavior-equivalence contracts for OpenBitFun directory priority, foreign directory exclusion, and load errors',
    patterns: [
      {
        regex:
          /\bcustom_subagent_discovery_preserves_openbitfun_priority_and_ignores_foreign_agent_dirs\b/,
        message: 'missing custom subagent discovery priority/foreign-dir regression',
      },
      {
        regex:
          /\bcustom_subagent_discovery_reports_parse_errors_without_dropping_valid_files\b/,
        message: 'missing custom subagent discovery parse-error regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/custom_subagent_contracts.rs',
    reason:
      'agent-runtime custom subagent owner must keep behavior-equivalence contracts for defaults and front-matter serialization decisions',
    patterns: [
      {
        regex: /\bcustom_subagent_defaults_match_existing_front_matter_contract\b/,
        message: 'missing custom subagent default regression',
      },
      {
        regex: /\bcustom_subagent_tool_front_matter_keeps_existing_comma_format\b/,
        message: 'missing custom subagent tools comma-format regression',
      },
      {
        regex: /\bcustom_subagent_default_fields_are_omitted_when_saved\b/,
        message: 'missing custom subagent default omission regression',
      },
      {
        regex: /\bcustom_subagent_definition_from_front_matter_preserves_schema_and_defaults\b/,
        message: 'missing custom subagent definition schema/default regression',
      },
      {
        regex: /\bcustom_subagent_definition_reports_legacy_missing_field_errors\b/,
        message: 'missing custom subagent missing-field regression',
      },
      {
        regex: /\bcustom_subagent_markdown_io_writes_canonical_front_matter\b/,
        message: 'missing custom subagent markdown IO regression',
      },
      {
        regex: /\bcustom_subagent_markdown_parse_errors_match_legacy_prefixes\b/,
        message: 'missing custom subagent markdown parse-error regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/native_hooks/kind.rs',
    reason: 'agent-runtime must own portable hook kind contracts',
    patterns: [
      { regex: /\bpub enum RuntimeHookKind\b/, message: 'missing runtime hook kind contract' },
      { regex: /\bSuccessfulToolPostCall\b/, message: 'missing successful tool post-call hook kind' },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/native_hooks/registry.rs',
    reason: 'agent-runtime must own portable hook registry and validation contracts',
    patterns: [
      { regex: /\bpub enum RuntimeHookErrorPolicy\b/, message: 'missing runtime hook error policy contract' },
      { regex: /\bpub struct RuntimeHookPlan\b/, message: 'missing runtime hook plan contract' },
      { regex: /\bpub struct RuntimeHookRegistry\b/, message: 'missing runtime hook registry contract' },
      { regex: /\btimeout_millis\b/, message: 'missing runtime hook timeout contract' },
      { regex: /\bDuplicateHookId\b/, message: 'missing runtime hook duplicate-id guard' },
      { regex: /\bEmptyHookId\b/, message: 'missing runtime hook empty-id guard' },
      { regex: /\bInvalidTimeoutMillis\b/, message: 'missing runtime hook non-zero-timeout guard' },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_interaction_contracts/post_call_hook_contracts.rs',
    reason:
      'agent-runtime post-call hook owner must keep behavior-equivalence contracts for successful tool-call hook routing',
    patterns: [
      {
        regex: /\bsuccessful_tool_call_uses_stable_builtin_registration_id\b/,
        message: 'missing successful tool post-call hook routing regression',
      },
      {
        regex: /\bruntime_hook_registry_preserves_source_order_timeout_and_error_policy\b/,
        message: 'missing runtime hook order/timeout/error-policy regression',
      },
      {
        regex: /\bruntime_hook_registry_rejects_duplicate_ids\b/,
        message: 'missing runtime hook duplicate-id regression',
      },
      {
        regex: /\bruntime_hook_registry_rejects_unstable_ids_and_zero_timeouts\b/,
        message: 'missing runtime hook invalid-id/timeout regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_interaction_contracts/post_call_hook_execution_contracts.rs',
    reason:
      'agent-runtime post-call hook owner must keep concrete-executor routing behavior-equivalence contracts',
    patterns: [
      {
        regex: /\bsuccessful_tool_post_call_executor_runs_deep_review_measurement_route\b/,
        message: 'missing successful tool post-call executor regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/checkpoint.rs',
    reason:
      'agent-runtime must own provider-neutral light-checkpoint summary policy while core keeps concrete Git/session IO',
    patterns: [
      {
        regex: /\bpub struct LightCheckpoint\b/,
        message: 'missing light checkpoint DTO',
      },
      {
        regex: /\bpub enum LightCheckpointWorkspaceFacts\b/,
        message: 'missing light checkpoint workspace facts',
      },
      {
        regex: /\bpub struct GitStatusCheckpointFacts\b/,
        message: 'missing git status checkpoint facts',
      },
      {
        regex: /\bpub fn build_light_checkpoint\b/,
        message: 'missing light checkpoint builder',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/scheduler.rs',
    reason:
      'agent-runtime scheduler owner must keep portable queue, background delivery, steering, reply, and round injection decisions outside concrete core session IO',
    patterns: [
      {
        regex: /\bpub const DEFAULT_MAX_DIALOG_QUEUE_DEPTH\b/,
        message: 'missing dialog queue depth contract',
      },
      {
        regex: /\bpub struct ActiveDialogTurn\b/,
        message: 'missing active dialog turn owner',
      },
      {
        regex: /\bpub struct ActiveDialogTurnStore\b/,
        message: 'missing active dialog turn store owner',
      },
      {
        regex: /\bpub enum AgentSessionReplyAction\b/,
        message: 'missing agent-session reply action contract',
      },
      {
        regex: /\bpub struct AgentSessionReplyPlan\b/,
        message: 'missing agent-session reply plan contract',
      },
      {
        regex: /\bpub struct BackgroundDeliveryFacts\b/,
        message: 'missing background delivery facts contract',
      },
      {
        regex: /\bpub enum BackgroundDeliveryAction\b/,
        message: 'missing background delivery action contract',
      },
      {
        regex: /\bpub enum BackgroundInjectionKind\b/,
        message: 'missing background injection kind contract',
      },
      {
        regex: /\bpub struct DialogReplySuppressionSet\b/,
        message: 'missing dialog reply suppression set owner',
      },
      {
        regex: /\bpub enum DialogSteeringAction\b/,
        message: 'missing dialog steering action contract',
      },
      {
        regex: /\bpub struct DialogTurnQueue\b/,
        message: 'missing dialog turn queue owner',
      },
      {
        regex: /\bpub struct SessionAbortFlags\b/,
        message: 'missing session abort flags owner',
      },
      {
        regex: /\bpub fn resolve_agent_session_reply_action\b/,
        message: 'missing agent-session reply action resolver',
      },
      {
        regex: /\bpub const fn resolve_background_delivery_action\b/,
        message: 'missing background delivery action resolver',
      },
      {
        regex: /\bpub fn resolve_background_delivery_injection\b/,
        message: 'missing background delivery injection resolver',
      },
      {
        regex: /\bpub fn resolve_dialog_steering_action\b/,
        message: 'missing dialog steering action resolver',
      },
      {
        regex: /\bfollow_up_submission_policy\b/,
        message: 'missing background follow-up submission policy helper',
      },
      {
        regex: /\bSubmitAgentSessionFollowUp\b/,
        message: 'missing agent-session follow-up action variant',
      },
      {
        regex: /\bInjectIntoRunningTurn\b/,
        message: 'missing running-turn injection action variant',
      },
      {
        regex: /\bpub struct SessionRoundInjectionBuffer\b/,
        message: 'missing session round injection buffer owner',
      },
      {
        regex: /\bpub enum TurnOutcome\b/,
        message: 'missing turn outcome contract',
      },
      {
        regex: /\bpub enum TurnOutcomeQueueAction\b/,
        message: 'missing turn outcome queue action contract',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/scheduler_contracts.rs',
    reason:
      'agent-runtime scheduler owner must keep behavior-equivalence contracts for background delivery, queueing, reply suppression, steering, round injection, and turn outcomes',
    patterns: [
      {
        regex: /\bbackground_delivery_injects_when_session_is_processing\b/,
        message: 'missing background delivery processing regression',
      },
      {
        regex:
          /\bbackground_delivery_starts_agent_session_follow_up_when_session_is_not_processing\b/,
        message: 'missing background delivery follow-up regression',
      },
      {
        regex:
          /\bbackground_delivery_follow_up_uses_agent_session_source_semantics\b/,
        message: 'missing background follow-up source semantics regression',
      },
      {
        regex: /\bbackground_delivery_injection_does_not_expose_follow_up_policy\b/,
        message: 'missing background injection policy regression',
      },
      {
        regex:
          /\bbackground_delivery_injection_builds_thread_goal_current_turn_message\b/,
        message: 'missing thread-goal current-turn injection regression',
      },
      {
        regex:
          /\bbackground_delivery_injection_builds_background_result_with_display_fallback\b/,
        message: 'missing background result display fallback regression',
      },
      {
        regex: /\bdialog_turn_queue_preserves_priority_order_and_fifo_within_priority\b/,
        message: 'missing dialog queue ordering regression',
      },
      {
        regex:
          /\bdialog_turn_queue_rejects_overflow_and_preserves_current_error_shape\b/,
        message: 'missing dialog queue overflow regression',
      },
      {
        regex:
          /\bdialog_turn_queue_clear_and_requeue_front_preserve_scheduler_recovery_contract\b/,
        message: 'missing dialog queue clear/requeue recovery regression',
      },
      {
        regex:
          /\bdialog_turn_queue_requeued_turn_keeps_original_priority_for_later_ordering\b/,
        message: 'missing dialog queue requeue regression',
      },
      {
        regex: /\bactive_dialog_turn_owns_agent_session_reply_suppression_facts\b/,
        message: 'missing active dialog turn suppression facts regression',
      },
      {
        regex:
          /\bactive_dialog_turn_store_owns_suppression_key_resolution_and_removal\b/,
        message: 'missing active dialog turn store regression',
      },
      {
        regex: /\breply_suppression_set_marks_takes_and_clears_turn_keys\b/,
        message: 'missing reply suppression set regression',
      },
      {
        regex: /\bsession_abort_flags_are_session_scoped\b/,
        message: 'missing session abort flags regression',
      },
      {
        regex:
          /\bagent_session_reply_action_forwards_completed_outcome_with_legacy_reminder_text\b/,
        message: 'missing agent-session completed reply regression',
      },
      {
        regex:
          /\bagent_session_reply_action_suppresses_cancelled_auto_reply_when_requested\b/,
        message: 'missing agent-session cancelled reply suppression regression',
      },
      {
        regex: /\bagent_session_reply_action_ignores_non_agent_session_turns\b/,
        message: 'missing non-agent-session reply suppression regression',
      },
      {
        regex: /\bdialog_steering_action_buffers_exact_running_turn_with_display_fallback\b/,
        message: 'missing dialog steering buffer regression',
      },
      {
        regex: /\bdialog_steering_action_rejects_when_target_turn_is_not_running\b/,
        message: 'missing dialog steering reject regression',
      },
      {
        regex: /\bround_injection_buffer_drains_only_messages_for_the_active_turn\b/,
        message: 'missing round injection buffer regression',
      },
      {
        regex: /\bturn_outcome_status_reply_and_queue_policy_are_portable\b/,
        message: 'missing turn outcome queue policy regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/thread_goal.rs',
    reason:
      'agent-runtime must own persisted thread-goal runtime decisions, set/update planning, continuation decisions, and tool response shaping',
    patterns: [
      {
        regex: /\bpub struct ThreadGoalRuntime\b/,
        message: 'missing thread-goal runtime owner',
      },
      {
        regex: /\bpub struct SetThreadGoalRequest\b/,
        message: 'missing set-thread-goal request contract',
      },
      {
        regex: /\bpub fn build_set_thread_goal_result\b/,
        message: 'missing set-thread-goal result builder',
      },
      {
        regex: /\bcontinuation_after_turn\b/,
        message: 'missing thread-goal continuation-after-turn decision',
      },
      {
        regex: /\bpub struct ThreadGoalContinuationOutcome\b/,
        message: 'missing thread-goal continuation outcome contract',
      },
      {
        regex: /\bpub fn goal_tool_response\b/,
        message: 'missing thread-goal tool response helper',
      },
      {
        regex: /\bpub fn should_skip_goal_for_turn\b/,
        message: 'missing thread-goal skip-turn decision',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_long_horizon_contracts/thread_goal_contracts.rs',
    reason:
      'agent-runtime thread-goal owner must keep behavior-equivalence contracts for goal creation, continuation limits, budget reporting, and wire response shape',
    patterns: [
      {
        regex: /\bset_thread_goal_creates_new_active_goal_with_trimmed_objective\b/,
        message: 'missing set-thread-goal creation regression',
      },
      {
        regex: /\bcontinuation_outcome_increments_active_goal_and_builds_plan\b/,
        message: 'missing thread-goal continuation increment regression',
      },
      {
        regex: /\bcontinuation_outcome_marks_active_goal_blocked_at_limit\b/,
        message: 'missing thread-goal blocked-at-limit regression',
      },
      {
        regex:
          /\bcontinuation_outcome_reports_budget_limit_once_when_tokens_cross_budget\b/,
        message: 'missing thread-goal budget-limit regression',
      },
      {
        regex: /\bprompt_and_tool_response_contracts_match_thread_goal_wire_shape\b/,
        message: 'missing thread-goal prompt/tool response wire-shape regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_definition_contracts/prompt_contracts.rs',
    reason:
      'agent-runtime prompt owner must keep behavior-equivalence contracts for user context and reminder ordering',
    patterns: [
      {
        regex: /\buser_context_policy_preserves_order_and_deduplicates_sections\b/,
        message: 'missing user-context policy order regression',
      },
      {
        regex: /\btool_listing_sections_render_only_present_sections\b/,
        message: 'missing tool-listing rendering regression',
      },
      {
        regex: /\bprepended_prompt_reminders_keep_runtime_injection_order\b/,
        message: 'missing prompt reminder ordering regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/events.rs',
    reason:
      'agent-runtime must own runtime event facts that do not require concrete scheduler or session IO',
    patterns: [
      {
        regex: /\bpub enum FinishReason\b/,
        message: 'missing agent-runtime finish-reason event fact',
      },
      {
        regex: /\bpub const fn session_state_label\b/,
        message: 'missing agent-runtime session-state label fact',
      },
      {
        regex: /\bpub fn turn_outcome_kind\b/,
        message: 'missing agent-runtime turn-outcome event fact',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/events_contracts.rs',
    reason:
      'agent-runtime event owner must keep behavior-equivalence contracts for event wire labels',
    patterns: [
      {
        regex: /\bfinish_reason_display_preserves_wire_labels\b/,
        message: 'missing finish-reason wire-label regression',
      },
      {
        regex: /\bsession_state_labels_match_existing_event_wire_values\b/,
        message: 'missing session-state label regression',
      },
      {
        regex: /\bturn_outcome_kind_matches_existing_reply_policy_contract\b/,
        message: 'missing turn-outcome event fact regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/event_queue.rs',
    reason:
      'agent-runtime must own provider-neutral runtime event queue delivery without core queue implementation',
    patterns: [
      {
        regex: /\bpub struct EventQueue\b/,
        message: 'missing runtime event queue owner',
      },
      {
        regex: /\bimpl StreamEventSink for EventQueue\b/,
        message: 'missing stream event sink implementation',
      },
      {
        regex: /\bpub async fn clear_session\b/,
        message: 'missing session-scoped event queue cleanup',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/event_router.rs',
    reason:
      'agent-runtime must own provider-neutral event subscriber routing without core router implementation',
    patterns: [
      {
        regex: /\bpub trait EventSubscriber\b/,
        message: 'missing event subscriber contract',
      },
      {
        regex: /\bpub struct EventRouter\b/,
        message: 'missing event router owner',
      },
      {
        regex: /\bpub async fn route_batch\b/,
        message: 'missing batched event routing entrypoint',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/prompt_markup.rs',
    reason:
      'agent-runtime must own provider-neutral prompt markup contracts used by core compatibility paths',
    patterns: [
      {
        regex: /\bpub struct PromptEnvelope\b/,
        message: 'missing prompt envelope owner',
      },
      {
        regex: /\bpub fn render_user_query\b/,
        message: 'missing user-query prompt markup helper',
      },
      {
        regex: /\bpub fn strip_prompt_markup\b/,
        message: 'missing prompt markup stripping helper',
      },
      {
        regex: /\bstrips_current_and_legacy_system_reminder_suffix\b/,
        message: 'missing legacy system-reminder markup regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/remote_file_delivery.rs',
    reason:
      'agent-runtime must own provider-neutral remote file delivery prompt facts without core implementation',
    patterns: [
      {
        regex: /\bTOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY\b/,
        message: 'missing remote file delivery context key',
      },
      {
        regex: /\bpub fn remote_file_delivery_reminder\b/,
        message: 'missing remote file delivery reminder owner',
      },
      {
        regex: /\bpub fn user_workspace_relative_file_link\b/,
        message: 'missing remote file link presentation helper',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/scheduled_job.rs',
    reason:
      'agent-runtime must own scheduled-job portable lifecycle state and transition decisions without concrete cron storage, schedule parsing, or session dispatch',
    patterns: [
      {
        regex: /\bpub struct ScheduledJobRuntimeState\b/,
        message: 'missing scheduled-job runtime state owner',
      },
      {
        regex: /\bpub enum ScheduledJobRunStatus\b/,
        message: 'missing scheduled-job run status owner',
      },
      {
        regex: /\bDEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS\b/,
        message: 'missing scheduled-job retry delay contract',
      },
      {
        regex: /\bpub fn mark_manual_trigger\b/,
        message: 'missing manual trigger transition',
      },
      {
        regex: /\bpub fn apply_due_scheduled_trigger\b/,
        message: 'missing due scheduled trigger transition',
      },
      {
        regex: /\bpub fn mark_enqueued\b/,
        message: 'missing enqueue success transition',
      },
      {
        regex: /\bpub fn mark_enqueue_failed\b/,
        message: 'missing enqueue failure transition',
      },
      {
        regex: /\bpub fn recover_interrupted_turn_after_restart\b/,
        message: 'missing restart recovery transition',
      },
      {
        regex: /\bpub fn pending_is_due\b/,
        message: 'missing scheduled-job pending due decision',
      },
      {
        regex: /\bpub fn next_wakeup_at_ms\b/,
        message: 'missing scheduled-job wakeup decision',
      },
      {
        regex: /\bpub fn clear_pending_trigger\b/,
        message: 'missing scheduled-job pending trigger clear transition',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/tests/agent_session_contracts/scheduled_job_contracts.rs',
    reason:
      'agent-runtime scheduled-job owner must keep behavior-equivalence contracts for wire shape, retry, coalescing, one-shot, missing-session, and restart recovery semantics',
    patterns: [
      {
        regex: /\bmanual_trigger_coalesces_existing_pending_run\b/,
        message: 'missing manual trigger coalescing regression',
      },
      {
        regex: /\bdue_scheduled_trigger_coalesces_when_active_or_pending\b/,
        message: 'missing scheduled trigger coalescing regression',
      },
      {
        regex: /\bpending_wakeup_prefers_retry_time_when_present\b/,
        message: 'missing retry wakeup regression',
      },
      {
        regex: /\bdisabled_and_config_clear_remove_pending_retry_without_touching_history\b/,
        message: 'missing disabled/config clear regression',
      },
      {
        regex: /\benqueue_success_sets_active_turn_and_disables_one_shot_next_run\b/,
        message: 'missing enqueue success one-shot regression',
      },
      {
        regex: /\benqueue_failure_preserves_retry_and_missing_session_disable_semantics\b/,
        message: 'missing enqueue failure regression',
      },
      {
        regex: /\brestart_recovery_marks_active_turn_error\b/,
        message: 'missing restart recovery regression',
      },
      {
        regex: /\bserde_shape_preserves_legacy_cron_state_wire_contract\b/,
        message: 'missing legacy cron state wire-shape regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/cron/types.rs',
    reason:
      'core cron types must preserve old import and wire paths while openbitfun-agent-runtime owns scheduled-job runtime state',
    patterns: [
      {
        regex: /ScheduledJobRuntimeState as CronJobState/,
        message: 'missing scheduled-job state compatibility alias',
      },
      {
        regex: /ScheduledJobRunStatus as CronJobRunStatus/,
        message: 'missing scheduled-job status compatibility alias',
      },
      {
        regex: /DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS/,
        message: 'missing scheduled-job retry delay compatibility constant',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/cron/service.rs',
    reason:
      'core cron service may own concrete storage and schedule parsing, while scheduled-job state and dialog submission flow through agent-runtime owners',
    patterns: [
      {
        regex: /\bmark_manual_trigger\b/,
        message: 'missing manual trigger owner delegation',
      },
      {
        regex: /\bapply_due_scheduled_trigger\b/,
        message: 'missing scheduled trigger owner delegation',
      },
      {
        regex: /\bmark_enqueued\b/,
        message: 'missing enqueue success owner delegation',
      },
      {
        regex: /\bmark_enqueue_failed\b/,
        message: 'missing enqueue failure owner delegation',
      },
      {
        regex: /\brecover_interrupted_turn_after_restart\b/,
        message: 'missing restart recovery owner delegation',
      },
      {
        regex: /\bpending_is_due\b/,
        message: 'missing pending due owner delegation',
      },
      {
        regex: /\bnext_wakeup_at_ms\b/,
        message: 'missing wakeup owner delegation',
      },
      {
        regex: /\bclear_pending_trigger\b/,
        message: 'missing pending trigger clear owner delegation',
      },
      {
        regex: /\bScheduledJobEnqueueFailureAction\b/,
        message: 'missing enqueue failure action owner delegation',
      },
      {
        regex: /\bCoreServiceAgentRuntime::agent_runtime_with_dialog_turns\b/,
        message: 'missing scheduled-job dialog lifecycle owner binding',
      },
      {
        regex: /\bAgentDialogTurnRequest\b/,
        message: 'missing scheduled-job dialog lifecycle request',
      },
      {
        regex: /\bAgentDialogPrependedReminder\b/,
        message: 'missing scheduled-job portable prepended reminder',
      },
      {
        regex: /\bsubmit_dialog_turn\b/,
        message: 'missing scheduled-job dialog lifecycle submission',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/cron_tool.rs',
    reason:
      'CronTool must resolve and validate target agent sessions through the service/agent runtime owner before scheduling jobs',
    patterns: [
      {
        regex: /\bCoreServiceAgentRuntime::agent_runtime\b/,
        message: 'missing service/agent runtime owner routing',
      },
      {
        regex: /\bAgentSessionListRequest\b/,
        message: 'missing port-backed cron target session list request',
      },
      {
        regex: /\bAgentSessionWorkspaceRequest\b/,
        message: 'missing port-backed cron target workspace request',
      },
      {
        regex: /\blist_sessions\b/,
        message: 'missing port-backed cron target session list call',
      },
      {
        regex: /\bresolve_session_workspace_binding\b/,
        message: 'missing port-backed cron target workspace binding resolution call',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/deep_review_policy.rs',
    reason:
      'core DeepReview policy path must stay a compatibility facade over agent-runtime while core keeps product config loading',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::deep_review::/,
        message: 'missing DeepReview agent-runtime compatibility re-export',
      },
      {
        regex: /\bload_default_deep_review_policy\b/,
        message: 'missing DeepReview product config loading bridge',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/deep_review/task_adapter.rs',
    reason:
      'core DeepReview task adapter must delegate provider-neutral packet, retry, backoff, and skipped-result shaping to agent-runtime while retaining core-only event/state side effects',
    patterns: [
      {
        regex: /runtime_task_execution::capacity_skip_result_for_local_queue_outcome/,
        message: 'missing DeepReview local capacity-skip runtime delegation',
      },
      {
        regex: /runtime_task_execution::capacity_skip_result_for_provider_queue_outcome/,
        message: 'missing DeepReview provider capacity-skip runtime delegation',
      },
      {
        regex: /DeepReviewProviderCapacityRetryRuntime/,
        message: 'missing DeepReview provider capacity retry runtime re-export',
      },
      {
        regex: /DeepReviewProviderCapacityRetryDecision/,
        message: 'missing DeepReview provider capacity retry decision re-export',
      },
      {
        regex: /runtime_task_execution::capacity_decision_for_provider_error_facts/,
        message: 'missing DeepReview provider capacity error decision delegation',
      },
      {
        regex: /runtime_task_execution::local_reviewer_capacity_queue_decision/,
        message: 'missing DeepReview local reviewer capacity decision delegation',
      },
      {
        regex: /runtime_task_execution::DeepReviewProviderCapacityQueueRuntime::start/,
        message: 'missing DeepReview provider capacity queue runtime delegation',
      },
      {
        regex: /runtime_task_execution::DeepReviewReviewerAdmissionQueueRuntime::start/,
        message: 'missing DeepReview reviewer admission queue runtime delegation',
      },
      {
        regex: /runtime_task_execution::deep_review_cancelled_reviewer_result/,
        message: 'missing DeepReview cancelled reviewer result runtime delegation',
      },
      {
        regex: /runtime_task_execution::should_emit_deep_review_retry_guidance/,
        message: 'missing DeepReview retry guidance emission runtime delegation',
      },
      {
        regex: /runtime_task_execution::deep_review_retry_guidance/,
        message: 'missing DeepReview retry guidance presentation runtime delegation',
      },
      {
        regex: /runtime_task_execution::auto_retry_suppression_reason/,
        message: 'missing DeepReview auto-retry suppression reason runtime delegation',
      },
      {
        regex: /runtime_task_execution::ensure_deep_review_auto_retry_allowed/,
        message: 'missing DeepReview auto-retry admission runtime delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/deep_review.rs',
    reason:
      'TaskTool must keep DeepReview retry/result presentation as a facade call instead of re-owning provider-neutral policy text or data shaping',
    patterns: [
      {
        regex: /deep_review_task_adapter::should_emit_deep_review_retry_guidance/,
        message: 'missing TaskTool DeepReview retry guidance emission facade call',
      },
      {
        regex: /deep_review_task_adapter::auto_retry_suppression_reason/,
        message: 'missing TaskTool DeepReview auto-retry suppression facade call',
      },
      {
        regex: /deep_review_task_adapter::ensure_deep_review_auto_retry_allowed/,
        message: 'missing TaskTool DeepReview auto-retry admission facade call',
      },
      {
        regex: /deep_review_task_adapter::deep_review_cancelled_reviewer_result/,
        message: 'missing TaskTool DeepReview cancelled reviewer result facade call',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs',
    reason:
      'TaskTool execution must keep DeepReview retry/result presentation as facade calls instead of re-owning provider-neutral policy text or data shaping',
    patterns: [
      {
        regex: /deep_review_task_adapter::deep_review_retry_guidance/,
        message: 'missing TaskTool DeepReview retry guidance facade call',
      },
      {
        regex: /openbitfun_agent_runtime::subagent_task::subagent_task_completion_result/,
        message: 'missing TaskTool provider-neutral completion result owner call',
      },
      {
        regex: /DeepReviewProviderCapacityRetryRuntime::default/,
        message: 'missing TaskTool DeepReview provider retry runtime state owner usage',
      },
      {
        regex: /DeepReviewProviderCapacityRetryDecision::WaitForCapacity/,
        message: 'missing TaskTool DeepReview provider retry runtime wait decision usage',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-workflows/src/deep_research.rs',
    reason:
      'agent-workflows must own provider-neutral DeepResearch citation policy without session or filesystem IO dependencies',
    patterns: [
      {
        regex: /\bpub fn renumber_research_report\b/,
        message: 'missing DeepResearch citation renumber runtime owner',
      },
      {
        regex: /\bpub struct ResearchCitationRenumberOutput\b/,
        message: 'missing DeepResearch citation renumber output contract',
      },
      {
        regex: /\bpub struct ResearchCitationDisplayMapEntry\b/,
        message: 'missing DeepResearch display-map entry contract',
      },
      {
        regex: /\brejected_index_rows_dropped\b/,
        message: 'missing rejected citation index cleanup telemetry',
      },
      {
        regex: /\bpub fn should_post_process_research_report\b/,
        message: 'missing DeepResearch post-process gate owner',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-workflows/tests/deep_research_contracts.rs',
    reason:
      'agent-workflows must keep behavior-equivalence contracts for DeepResearch citation renumbering',
    patterns: [
      {
        regex: /\bdeep_research_citation_renumber_owner_preserves_report_and_display_map_contracts\b/,
        message: 'missing DeepResearch citation renumber behavior contract',
      },
      {
        regex: /\bdeep_research_citation_renumber_owner_is_idempotent_without_citations\b/,
        message: 'missing DeepResearch citation renumber idempotence contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/deep_review/report.rs',
    reason:
      'core DeepReview report path must delegate provider-neutral enrichment and cache updates to agent-runtime while retaining core-only session IO',
    patterns: [
      {
        regex: /runtime_report::fill_deep_review_reliability_signals/,
        message: 'missing DeepReview runtime report enrichment delegation',
      },
      {
        regex: /runtime_report::fill_deep_review_runtime_tracker_signal/,
        message: 'missing DeepReview runtime tracker reliability signal delegation',
      },
      {
        regex: /fill_deep_review_cache_update_signals/,
        message: 'missing DeepReview cache update reliability signal delegation',
      },
      {
        regex: /runtime_diagnostics::deep_review_runtime_diagnostics_log_line/,
        message: 'missing DeepReview runtime diagnostics log delegation',
      },
      {
        regex: /deep_review_cache_from_completed_reviewers/,
        message: 'missing DeepReview cache update compatibility re-export',
      },
      {
        regex: /\bpersist_deep_review_cache\b/,
        message: 'missing core session metadata persistence bridge',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/definitions/custom/subagent.rs',
    reason:
      'core custom subagent path must stay a compatibility facade over agent-runtime custom-agent schema/default and markdown IO decisions',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::custom_subagent::CustomSubagentKind/,
        message: 'missing custom subagent kind compatibility re-export',
      },
      {
        regex: /\bCustomAgentDefinition::new\b/,
        message: 'missing custom agent definition construction delegation',
      },
      {
        regex: /\bcustom_agent_read_markdown_file\b/,
        message: 'missing custom agent markdown read delegation',
      },
      {
        regex: /\bCustomAgentData::from_definition\b/,
        message: 'missing custom agent data adapter delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/custom.rs',
    reason:
      'core custom agent registry must delegate portable discovery/loading and validation to agent-runtime while retaining product tool/model lookup, logging, and registry writes',
    patterns: [
      {
        regex: /\bload_custom_agent_definitions\b/,
        message: 'missing custom agent runtime load delegation',
      },
      {
        regex: /\bCustomAgentDiscoveryRoots\b/,
        message: 'missing custom agent runtime discovery root adapter',
      },
      {
        regex: /\bvalidate_custom_agent_definition\b/,
        message: 'missing custom agent runtime validation delegation',
      },
      {
        regex: /\bcustom_agent_from_definition\b/,
        message: 'missing custom agent runtime definition adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/post_call_hooks.rs',
    reason:
      'core post-call hooks must delegate portable hook routing to agent-runtime while retaining concrete hook execution',
    patterns: [
      { regex: /\bdispatch_successful_tool_post_call\b/, message: 'missing post-call hook dispatch delegation' },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
    reason:
      'core tool pipeline must delegate portable cancellation and retry policy while retaining state/event/tool execution wiring',
    patterns: [
      {
        regex: /\bremote_workspace_route_root_isolated_from_same_local_path\b/,
        message: 'missing remote workspace permission identity isolation regression',
      },
      {
        regex: /\bonce_and_always_replies_control_execution_and_remembered_grants\b/,
        message: 'missing permission project and remote grant isolation regression',
      },
      {
        regex: /\bToolCancellationTokenStore\b/,
        message: 'missing tool cancellation token owner delegation',
      },
      {
        regex: /\bshould_retry_tool_attempt\b/,
        message: 'missing tool-runtime retry decision delegation',
      },
      {
        regex: /\bretry_delay_ms\b/,
        message: 'missing tool-runtime retry backoff delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/execution/types.rs',
    reason:
      'core execution types must preserve legacy import path while agent-runtime owns finish-reason event facts',
    patterns: [
      {
        regex: /openbitfun_agent_runtime::events::FinishReason/,
        message: 'missing finish-reason compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/events/types.rs',
    reason:
      'core event types must preserve legacy import path while agent-runtime owns session-state labels',
    patterns: [
      {
        regex: /openbitfun_agent_runtime::session_state::session_state_label_for_state/,
        message: 'missing session-state label owner delegation',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/session_state_manager.rs',
    reason:
      'agent-runtime owns provider-neutral session state storage, transition helpers, and SessionStateChanged event projection',
    patterns: [
      {
        regex: /\bpub struct SessionStateManager\b/,
        message: 'missing agent-runtime session state manager owner',
      },
      {
        regex: /\bDashMap<String, SessionState>/,
        message: 'missing session state storage owner',
      },
      {
        regex: /\bEventQueue\b/,
        message: 'missing runtime event queue integration',
      },
      {
        regex: /\bAgenticEvent::SessionStateChanged\b/,
        message: 'missing SessionStateChanged event projection',
      },
      {
        regex: /\bsession_state_label_for_state\b/,
        message: 'missing stable session-state label projection',
      },
      {
        regex: /\bcan_start_new_turn\b/,
        message: 'missing turn-start guard owner',
      },
      {
        regex: /\bsession_state_manager_emits_compatible_state_change_events\b/,
        message: 'missing session state event compatibility test',
      },
      {
        regex: /\bsession_state_manager_keeps_turn_start_guard_semantics\b/,
        message: 'missing session state guard compatibility test',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/state_manager.rs',
    reason:
      'core session state manager path must preserve legacy imports while agent-runtime owns the implementation',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::session_state_manager::SessionStateManager;/,
        message: 'missing SessionStateManager compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/prompt_builder/user_context.rs',
    reason:
      'core prompt_builder user_context path must stay a compatibility facade over agent-runtime',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::prompt::\{UserContextPolicy, UserContextSection\};/,
        message: 'missing agent-runtime user-context compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/prompt_cache.rs',
    reason:
      'core prompt_cache path must stay a compatibility facade over agent-runtime',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::prompt_cache::\*;/,
        message: 'missing agent-runtime prompt-cache compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/execution/round_executor.rs',
    reason:
      'core round executor must delegate dialog-turn cancellation token storage to agent-runtime while retaining concrete model streaming and events',
    patterns: [
      {
        regex: /\bDialogTurnCancellationTokenStore\b/,
        message: 'missing dialog-turn cancellation token store delegation',
      },
      {
        regex: /\bget_or_insert_new\b/,
        message: 'missing dialog-turn cancellation token creation/reuse delegation',
      },
      {
        regex: /\bis_cancelled\b/,
        message: 'missing dialog-turn cancellation state delegation',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/user_questions.rs',
    reason:
      'agent-runtime must own user-question contracts and user-input wait-channel lifecycle state',
    patterns: [
      {
        regex: /\bpub struct AskUserQuestionInput\b/,
        message: 'missing AskUserQuestion input contract',
      },
      {
        regex: /\bpub struct UserInputResponse\b/,
        message: 'missing user input response contract',
      },
      {
        regex: /\bpub struct UserInputManager\b/,
        message: 'missing user input manager owner',
      },
      {
        regex: /\bpub fn get_user_input_manager\b/,
        message: 'missing user input manager global entry',
      },
      {
        regex: /\bvalidate_ask_user_question_input\b/,
        message: 'missing AskUserQuestion validation owner',
      },
      {
        regex: /\buser_input_manager_delivers_answer_and_clears_channel\b/,
        message: 'missing user input manager answer regression',
      },
      {
        regex: /\buser_input_manager_cancel_closes_receiver\b/,
        message: 'missing user input manager cancel regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/review_read_receipt.rs',
    reason:
      'core review_read_receipt path must stay a compatibility facade over agent-runtime',
    patterns: [
      {
        regex: /openbitfun_agent_runtime::review_read_receipt::\{/,
        message: 'missing agent-runtime review read receipt compatibility re-export',
      },
      {
        regex: /\bReviewReadReceiptStore\b/,
        message: 'missing review read receipt store compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/evidence_ledger.rs',
    reason:
      'core evidence_ledger path must stay a compatibility facade over agent-runtime',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::evidence_ledger::\*;/,
        message: 'missing agent-runtime evidence ledger compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/turn_skill_agent_snapshot_store.rs',
    reason:
      'core turn_skill_agent_snapshot_store path must stay a compatibility facade over agent-runtime',
    patterns: [
      {
        regex:
          /pub use openbitfun_agent_runtime::skill_agent_snapshot::TurnSkillAgentSnapshotStore;/,
        message: 'missing agent-runtime turn skill/agent snapshot store compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/session/mod.rs',
    reason:
      'services-core session owner must expose lineage, branch, metadata mutation, and metadata store rules through the session boundary',
    patterns: [
      {
        regex: /\bmod lineage;/,
        message: 'missing services-core session lineage module',
      },
      {
        regex: /\bmod metadata_store;/,
        message: 'missing services-core session metadata store module',
      },
      {
        regex: /\bapply_session_lineage\b/,
        message: 'missing session lineage owner re-export',
      },
      {
        regex: /\bbuild_branched_session_metadata\b/,
        message: 'missing branch metadata owner re-export',
      },
      {
        regex: /\bSessionBranchRequest\b/,
        message: 'missing branch request compatibility owner re-export',
      },
      {
        regex: /\bmerge_session_custom_metadata\b/,
        message: 'missing custom metadata mutation owner re-export',
      },
      {
        regex: /\bbuild_session_metadata\b/,
        message: 'missing session metadata construction owner re-export',
      },
      {
        regex: /\bSessionMetadataBuildFacts\b/,
        message: 'missing session metadata construction facts re-export',
      },
      {
        regex: /\bSessionMetadataStore\b/,
        message: 'missing session metadata store owner re-export',
      },
      {
        regex: /\bset_deep_review_cache\b/,
        message: 'missing DeepReview cache metadata mutation owner re-export',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/session/metadata.rs',
    reason:
      'services-core session metadata owner must own construction and field mutation rules while metadata_store owns file/index IO',
    patterns: [
      {
        regex: /\bpub fn merge_session_custom_metadata\b/,
        message: 'missing custom metadata merge owner',
      },
      {
        regex: /\bpub struct SessionMetadataBuildFacts\b/,
        message: 'missing session metadata construction facts owner',
      },
      {
        regex: /\bpub fn build_session_metadata\b/,
        message: 'missing session metadata construction owner',
      },
      {
        regex: /\bpub fn set_session_relationship\b/,
        message: 'missing session relationship mutation owner',
      },
      {
        regex: /\bpub fn set_deep_review_run_manifest\b/,
        message: 'missing DeepReview manifest metadata mutation owner',
      },
      {
        regex: /\bpub fn set_deep_review_cache\b/,
        message: 'missing DeepReview cache metadata mutation owner',
      },
      {
        regex: /\bmerge_custom_metadata_shallow_merges_object_patch\b/,
        message: 'missing custom metadata merge regression',
      },
      {
        regex: /\bdeep_review_cache_mutation_preserves_manifest_and_relationship\b/,
        message: 'missing DeepReview cache mutation regression',
      },
      {
        regex: /\bbuild_session_metadata_preserves_existing_fields_and_legacy_relationship\b/,
        message: 'missing session metadata construction regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/session/metadata_store.rs',
    reason:
      'services-core session metadata store must own provider-neutral metadata file and index IO under a resolved sessions root',
    patterns: [
      {
        regex: /\bpub struct SessionMetadataStore\b/,
        message: 'missing session metadata store owner',
      },
      {
        regex: /\bpub enum SessionMetadataStoreError\b/,
        message: 'missing session metadata store error boundary',
      },
      {
        regex: /\bSessionStorageLayout\b/,
        message: 'metadata store must reuse the session storage layout owner',
      },
      {
        regex: /\bpub async fn list_metadata\b/,
        message: 'missing session metadata list owner entrypoint',
      },
      {
        regex: /\bpub async fn list_metadata_page\b/,
        message: 'missing session metadata page owner entrypoint',
      },
      {
        regex: /\bpub async fn list_metadata_including_internal\b/,
        message: 'missing internal session metadata list owner entrypoint',
      },
      {
        regex: /\bpub async fn rebuild_index\b/,
        message: 'missing session metadata index rebuild owner entrypoint',
      },
      {
        regex: /\bpub async fn save_metadata\b/,
        message: 'missing session metadata save owner entrypoint',
      },
      {
        regex: /\bpub async fn load_metadata\b/,
        message: 'missing session metadata load owner entrypoint',
      },
      {
        regex: /\bpub async fn delete_session_dir_and_index\b/,
        message: 'missing session metadata delete/index owner entrypoint',
      },
      {
        regex: /\bmetadata_store_saves_visible_metadata_and_updates_index\b/,
        message: 'missing metadata store visible-index regression',
      },
      {
        regex: /\bmetadata_store_rebuilds_stale_index_entries\b/,
        message: 'missing metadata store stale-index regression',
      },
      {
        regex: /\bmetadata_store_rebuild_index_counts_hidden_metadata_files\b/,
        message: 'missing metadata store hidden-count rebuild regression',
      },
      {
        regex: /\bmetadata_store_delete_session_updates_visible_index\b/,
        message: 'missing metadata store delete-index regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/session/lineage.rs',
    reason:
      'services-core must own provider-neutral session lineage, subagent cascade, and branch metadata shaping rules without core IO',
    patterns: [
      {
        regex: /\bpub struct SessionBranchRequest\b/,
        message: 'missing session branch request owner type',
      },
      {
        regex: /\bpub struct SessionBranchResult\b/,
        message: 'missing session branch result owner type',
      },
      {
        regex: /\bpub struct BranchSessionMetadataFacts\b/,
        message: 'missing branch metadata facts contract',
      },
      {
        regex: /\bpub fn apply_session_lineage\b/,
        message: 'missing lineage metadata mutation owner',
      },
      {
        regex: /\bpub fn build_branched_session_metadata\b/,
        message: 'missing branch metadata shaping owner',
      },
      {
        regex: /\bpub fn collect_hidden_subagent_cascade\b/,
        message: 'missing hidden subagent cascade owner',
      },
      {
        regex: /\bfn extract_subagent_relationship\b/,
        message: 'missing legacy/structured subagent relationship resolver',
      },
      {
        regex: /\bapply_session_lineage_sets_relationship_and_removes_legacy_projection\b/,
        message: 'missing lineage cleanup regression',
      },
      {
        regex: /\bbuild_branched_session_metadata_resets_child_state_and_counts_turns\b/,
        message: 'missing branch metadata shaping regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/persistence/session_branch.rs',
    reason:
      'core session branch persistence must keep IO orchestration and old import compatibility while services-core owns branch metadata shaping',
    patterns: [
      {
        regex: /pub use openbitfun_services_core::session::\{SessionBranchRequest,\s*SessionBranchResult\};/,
        message: 'missing session branch compatibility re-export',
      },
      {
        regex: /\bbuild_branched_session_metadata\b/,
        message: 'missing services-core branch metadata delegation',
      },
      {
        regex: /\bBranchSessionMetadataFacts\b/,
        message: 'missing branch metadata facts delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/mod.rs',
    reason:
      'core agent mode module must keep old import paths while agent-runtime owns shared mode profile facts',
    patterns: [
      {
        regex: /pub use openbitfun_agent_runtime::agents::\{[\s\S]*mode_presentation_rank[\s\S]*resolve_mode_config_profile_id[\s\S]*standard_harness_user_context_policy[\s\S]*STANDARD_HARNESS_PROMPT_TEMPLATE[\s\S]*\};/,
        message: 'missing agent-runtime shared mode profile compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/filesystem/mod.rs',
    reason:
      'services-core filesystem owner must expose local filesystem primitives behind a single module boundary',
    patterns: [
      {
        regex: /mod error;/,
        message: 'filesystem owner must expose its error boundary',
      },
      {
        regex: /mod operations;/,
        message: 'filesystem owner must expose local file operation primitives',
      },
      {
        regex: /mod tree;/,
        message: 'filesystem owner must expose local file tree/search primitives',
      },
      {
        regex: /pub use error::\{FileSystemError, FileSystemResult\};/,
        message: 'filesystem owner must re-export the unified filesystem error type',
      },
      {
        regex: /pub use service::FileSystemService;/,
        message: 'filesystem owner must keep the consolidated service facade',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/managed_runtime.rs',
    reason:
      'services-core must own managed runtime command resolution and PATH merge rules while core supplies only the product runtime root',
    patterns: [
      {
        regex: /\bpub struct ManagedRuntimeResolver\b/,
        message: 'missing managed runtime resolver owner',
      },
      {
        regex: /\bpub enum RuntimeSource\b/,
        message: 'missing managed runtime source contract',
      },
      {
        regex: /\bpub fn resolve_command\b/,
        message: 'missing managed runtime command resolution entrypoint',
      },
      {
        regex: /\bpub fn merged_path_env\b/,
        message: 'missing managed runtime PATH merge owner',
      },
      {
        regex: /\bnormalizes_windows_alias_for_managed_lookup\b/,
        message: 'missing Windows command alias regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/runtime/mod.rs',
    reason:
      'core runtime service must remain a thin compatibility adapter over services-core managed runtime owner',
    patterns: [
      {
        regex: /\bManagedRuntimeResolver::new\b/,
        message: 'missing services-core managed runtime delegation',
      },
      {
        regex: /\bget_path_manager_arc\b/,
        message: 'missing product-managed runtime root adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/filesystem/service.rs',
    reason:
      'core filesystem service may keep remote-workspace overlay and OpenBitFunError compatibility, but local filesystem owner must remain services-core',
    patterns: [
      {
        regex: /let connection_id = explicit_connection_id\?/,
        message: 'core filesystem wrapper must require explicit remote workspace connection scope',
      },
      {
        regex: /get_remote_workspace_manager/,
        message: 'core filesystem wrapper must preserve existing remote file service lookup',
      },
      {
        regex: /map_filesystem_error/,
        message: 'core filesystem wrapper must map services-core errors at the compatibility boundary',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/persistence/manager.rs',
    reason:
      'core persistence manager must keep workspace identity, runtime preflight, state/turn/prompt-cache IO while services-core owns session metadata store CRUD/index rebuild IO and construction rules',
    patterns: [
      {
        regex: /\bbuild_persisted_session_metadata\s*\(\s*SessionMetadataBuildFacts\s*\{/,
        message: 'missing services-core session metadata construction delegation',
      },
      {
        regex: /\bsession_metadata_store\s*\(\s*&self,\s*workspace_path:\s*&Path\s*\)\s*->\s*SessionMetadataStore\b/,
        message: 'missing services-core session metadata store adapter',
      },
      {
        regex: /\.list_metadata\(\)/,
        message: 'missing metadata list delegation to services-core store',
      },
      {
        regex: /\.list_metadata_page\(cursor,\s*limit\)/,
        message: 'missing metadata page delegation to services-core store',
      },
      {
        regex: /\.list_metadata_including_internal\(\)/,
        message: 'missing internal metadata list delegation to services-core store',
      },
      {
        regex: /\.save_metadata\(metadata\)/,
        message: 'missing metadata save delegation to services-core store',
      },
      {
        regex: /\.load_metadata\(session_id\)/,
        message: 'missing metadata load delegation to services-core store',
      },
      {
        regex: /\.delete_session_dir_and_index\(session_id\)/,
        message: 'missing metadata delete delegation to services-core store',
      },
      {
        regex: /\bensure_runtime_for_write\(workspace_path\)\.await\?/,
        message: 'missing runtime preflight before metadata write',
      },
      {
        regex: /\bresolve_workspace_session_identity\b/,
        message: 'missing workspace identity resolution before metadata construction',
      },
      {
        regex: /\bLOCAL_WORKSPACE_SSH_HOST\b/,
        message: 'missing local workspace hostname compatibility fallback',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/session/session_manager.rs',
    reason:
      'core session manager must keep concrete session IO while services-core owns metadata mutation rules and forked Task prompt-cache baselines remain protected',
    patterns: [
      {
        regex: /\bapply_session_lineage\(metadata, relationship\)/,
        message: 'missing services-core session lineage delegation',
      },
      {
        regex: /\bmerge_session_custom_metadata_value\(metadata, patch\)/,
        message: 'missing services-core custom metadata delegation',
      },
      {
        regex: /\bupdate_persisted_session_metadata\b/,
        message: 'missing shared session metadata update facade',
      },
      {
        regex: /\bcollect_hidden_subagent_cascade_ids\(/,
        message: 'missing services-core hidden subagent cascade delegation',
      },
      {
        regex: /\bpub async fn clone_prompt_cache\b/,
        message: 'missing prompt cache clone runtime entry point',
      },
      {
        regex: /\bpub async fn start_dialog_turn_with_existing_context\b/,
        message: 'missing existing-context dialog turn entry point',
      },
      {
        regex: /\bstart_dialog_turn_with_existing_context_persists_turn_and_snapshot\b/,
        message: 'missing existing-context dialog turn persistence regression',
      },
      {
        regex: /\bclone_prompt_cache_copies_runtime_and_persisted_entries\b/,
        message: 'missing prompt cache clone runtime/disk regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
    reason:
      'core tool pipeline must preserve explicit Write-tail and opt-in normal-completion JSON-repair behavior through agent-tools delegation and keep per-tool denial behavior until tool runtime ownership migrates',
    patterns: [
      {
        regex: /\bbuild_normal_tool_json_repair_notice\b/,
        message: 'missing normal-completion JSON repair notice owner delegation',
      },
      {
        regex: /\bbuild_write_tail_closure_notice\b/,
        message: 'missing Write-tail closure notice owner delegation',
      },
      {
        regex: /\bnormal_json_repair_notice_for_interactive_tools_does_not_claim_file_write\b/,
        message: 'missing normal-completion JSON repair regression',
      },
      {
        regex: /\bwrite_tail_closure_notice_keeps_write_continuation_guidance\b/,
        message: 'missing Write-tail closure recovery regression',
      },
      {
        regex: /\bdenied_tool_messages\b/,
        message: 'missing per-tool denial message propagation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/restrictions.rs',
    reason:
      'core tool restrictions facade must delegate runtime restriction policy to agent-tools while preserving core error and local-path adapters',
    patterns: [
      {
        regex: /\btool_restrictions_for_delegation_policy\b/,
        message: 'missing agent-tools runtime restriction policy re-export',
      },
      {
        regex: /\bminiapp_headless_agent_tool_restrictions\b/,
        message: 'missing agent-tools MiniApp headless restriction re-export',
      },
      {
        regex: /\bimpl From<ToolRestrictionError> for OpenBitFunError\b/,
        message: 'missing core error mapping adapter',
      },
      {
        regex: /\bis_local_path_within_root\b/,
        message: 'missing local filesystem path containment adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_result_storage.rs',
    reason:
      'core tool-result storage must keep explicit file flush until runtime artifact ownership migrates',
    patterns: [
      {
        regex: /\basync fn write_once\b/,
        message: 'missing single-write persistence helper',
      },
      {
        regex: /file\.flush\(\)\.await/,
        message: 'missing explicit persisted tool-result flush',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/shell/mod.rs',
    reason:
      'tool-runtime must own the shared noninteractive terminal environment used by agent-managed sessions',
    patterns: [
      {
        regex: /\bpub fn noninteractive_terminal_env\b/,
        message: 'missing noninteractive terminal environment owner',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/Cargo.toml',
    reason:
      'tool-runtime Web readable extraction must stay behind an explicit feature so minimal tool-runtime consumers do not pull HTML extractor dependencies',
    patterns: [
      {
        regex: /default = \[\]/,
        message: 'tool-runtime default feature set must stay empty',
      },
      {
        regex:
          /web-readable = \["dep:htmd", "dep:legible", "dep:readability-js"\]/,
        message: 'tool-runtime web-readable feature must own exactly the Web extractor deps',
      },
      {
        regex: /^regex = \{ workspace = true \}$/m,
        message: 'tool-runtime POSIX filename byte matching must use the shared regex dependency independently of Web extraction',
      },
      {
        regex: /htmd = \{[^}]*optional = true[^}]*\}/,
        message: 'htmd must stay optional under the web-readable owner feature',
      },
      {
        regex: /legible = \{[^}]*optional = true[^}]*\}/,
        message: 'legible must stay optional under the web-readable owner feature',
      },
      {
        regex: /readability-js = \{[^}]*optional = true[^}]*\}/,
        message: 'readability-js must stay optional under the web-readable owner feature',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/web_readable.rs',
    reason:
      'tool-runtime must own provider-neutral WebFetch readable extraction and preserve existing fallback behavior',
    patterns: [
      {
        regex: /\bpub fn normalize_requested_format\b/,
        message: 'missing WebFetch format normalization owner',
      },
      {
        regex: /\bpub fn extract_markdown_with_text_fallback\b/,
        message: 'missing WebFetch readable extraction owner',
      },
      {
        regex: /\bfn attempt_legible\b/,
        message: 'missing legible extraction attempt',
      },
      {
        regex: /\bfn attempt_readability_js\b/,
        message: 'missing readability-js extraction fallback',
      },
      {
        regex: /\babsolutize_root_relative_markdown_uses_base_origin\b/,
        message: 'missing root-relative markdown link behavior regression',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/web_search.rs',
    reason:
      'runtime-ports must own the provider-neutral WebSearch contract while concrete provider translation stays below assembly',
    patterns: [
      {
        regex: /\bpub struct WebSearchRequest\b/,
        message: 'missing provider-neutral WebSearch request DTO',
      },
      {
        regex: /\bpub struct WebSearchResponse\b/,
        message: 'missing provider-neutral WebSearch response DTO',
      },
      {
        regex: /\bpub struct WebSearchResult\b/,
        message: 'missing provider-neutral WebSearch result DTO',
      },
      {
        regex: /\bpub trait WebSearchProvider\b/,
        message: 'missing provider-neutral WebSearch runtime port',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/web_tools.rs',
    reason:
      'services-integrations must own free Exa MCP transport and provider-specific result translation',
    patterns: [
      {
        regex: /\bpub struct FreeExaMcpProvider\b/,
        message: 'missing free Exa MCP provider adapter',
      },
      {
        regex: /\bfn parse_exa_sse\b/,
        message: 'missing free Exa MCP protocol parser',
      },
      {
        regex: /\bfn parse_exa_text_results\b/,
        message: 'missing free Exa MCP result translator',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/tests/tool_io_contracts.rs',
    reason:
      'tool-runtime shell owner must keep the agent-managed terminal environment contract covered',
    patterns: [
      {
        regex: /\bnoninteractive_terminal_env_preserves_agent_session_contract\b/,
        message: 'missing noninteractive terminal environment regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/pipeline.rs',
    reason:
      'tool-runtime must own provider-neutral tool batching, retry, state counting, and cancellation policy while core keeps concrete execution wiring',
    patterns: [
      {
        regex: /\bpub struct ToolBatch\b/,
        message: 'missing tool batch DTO',
      },
      {
        regex: /\bpub fn partition_tool_batches\b/,
        message: 'missing tool batching policy',
      },
      {
        regex: /\bpub enum ToolExecutionErrorClass\b/,
        message: 'missing tool retry error class',
      },
      {
        regex: /\bpub struct ToolRetryAttemptFacts\b/,
        message: 'missing tool retry attempt facts',
      },
      {
        regex: /\bpub fn should_retry_tool_attempt\b/,
        message: 'missing tool retry decision policy',
      },
      {
        regex: /\bpub fn retry_delay_ms\b/,
        message: 'missing tool retry backoff policy',
      },
      {
        regex: /\bpub enum ToolTaskStateKind\b/,
        message: 'missing provider-neutral tool state kind owner',
      },
      {
        regex: /\bpub fn should_cancel_tool_state\b/,
        message: 'missing tool cancellation state policy',
      },
      {
        regex: /\bpub fn summarize_dialog_turn_cancellation\b/,
        message: 'missing dialog-turn cancellation summary policy',
      },
      {
        regex: /\bpub struct ToolCancellationTokenStore\b/,
        message: 'missing tool cancellation token store owner',
      },
      {
        regex: /\bpub fn count_tool_states\b/,
        message: 'missing tool state counting policy',
      },
      {
        regex: /\bpub struct ToolStateEventFacts\b/,
        message: 'missing provider-neutral tool event facts owner',
      },
      {
        regex: /\bpub enum ToolStateEventKind\b/,
        message: 'missing provider-neutral tool event state owner',
      },
      {
        regex: /\bpub fn tool_state_event_data\b/,
        message: 'missing tool state event payload owner',
      },
      {
        regex: /\bpub fn sanitize_tool_result_for_event\b/,
        message: 'missing tool result event redaction owner',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/context.rs',
    reason:
      'tool-runtime must own provider-neutral tool custom-data materialization and context facts projection while core keeps runtime handles and concrete ToolUseContext',
    patterns: [
      {
        regex: /\bpub struct ToolRuntimeCustomDataInput\b/,
        message: 'missing tool runtime custom-data input DTO',
      },
      {
        regex: /\bpub fn build_tool_runtime_custom_data\b/,
        message: 'missing tool runtime custom-data owner',
      },
      {
        regex: /\bpub struct ToolRuntimeContextFactsInput\b/,
        message: 'missing tool runtime context facts input DTO',
      },
      {
        regex: /\bpub fn project_tool_context_facts\b/,
        message: 'missing tool runtime context facts projection owner',
      },
      {
        regex: /\bpub fn delegation_policy_from_custom_data\b/,
        message: 'missing delegation policy parsing owner',
      },
      {
        regex: /\bpub struct PrimaryModelFacts\b/,
        message: 'missing typed primary model facts owner',
      },
      {
        regex: /\bpub fn multimodal_tool_output_supported\b/,
        message: 'missing primary model multimodal tool-output policy owner',
      },
      {
        regex: /\bmaterializes_provider_neutral_tool_custom_data\b/,
        message: 'missing tool runtime custom-data regression',
      },
      {
        regex: /\bprojects_prompt_safe_tool_context_facts_only\b/,
        message: 'missing prompt-safe context facts regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/tests/tool_pipeline_planning.rs',
    reason:
      'tool-runtime pipeline owner must keep behavior-equivalence contracts for batching and retry policy',
    patterns: [
      {
        regex: /\bpartitions_consecutive_concurrency_safe_tools_into_parallel_batches\b/,
        message: 'missing tool batching regression',
      },
      {
        regex: /\bretry_policy_preserves_attempt_limit_and_error_class_contract\b/,
        message: 'missing tool retry policy regression',
      },
      {
        regex: /\bcancellation_policy_preserves_cancellable_and_terminal_state_contract\b/,
        message: 'missing tool cancellation policy regression',
      },
      {
        regex: /\bdialog_turn_cancellation_summary_counts_cancelled_and_skipped_tasks\b/,
        message: 'missing dialog-turn cancellation summary regression',
      },
      {
        regex: /\bcancellation_token_store_cancels_and_removes_tokens\b/,
        message: 'missing cancellation token store regression',
      },
      {
        regex: /\bstate_counts_preserve_pipeline_stats_contract\b/,
        message: 'missing tool state-count regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/mcp/server/connection.rs',
    reason:
      'services-integrations MCP connection must keep initialize-scoped timeout and channel-close cleanup until MCP owner migration is reviewed',
    patterns: [
      {
        regex: /\bsend_request_with_id\b/,
        message: 'missing stable local JSON-RPC request id path',
      },
      {
        regex: /\binitialize_timeout\b/,
        message: 'missing initialize-scoped timeout',
      },
      {
        regex: /notifications\/initialized/,
        message: 'missing MCP initialized notification',
      },
      {
        regex: /\bpending\.clear\(\)/,
        message: 'missing pending request waiter drain on channel close',
      },
      {
        regex: /\blocal_tool_calls_do_not_inherit_initialize_timeout\b/,
        message: 'missing local tool request timeout-scope regression',
      },
      {
        regex: /\blocal_initialize_uses_initialize_timeout\b/,
        message: 'missing local initialize timeout regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/mcp/protocol/transport.rs',
    reason:
      'services-integrations MCP local transport must keep explicit request ids and stdin flush semantics',
    patterns: [
      {
        regex: /\bpub async fn send_request_with_id\b/,
        message: 'missing explicit JSON-RPC request id send path',
      },
      {
        regex: /\.flush\(\)\s*\.await/,
        message: 'missing local MCP stdin flush',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/Cargo.toml',
    reason:
      'openbitfun-core product-full must explicitly aggregate owner crate feature groups instead of forcing them through dependency declarations',
    patterns: [
      {
        regex:
          /openbitfun-tool-packs = \{ path = "\.\.\/\.\.\/execution\/tool-provider-groups", optional = true \}/,
        message: 'openbitfun-tool-packs dependency must stay optional and not force product-full outside the core feature graph',
      },
      {
        regex:
          /openbitfun-services-integrations = \{ path = "\.\.\/\.\.\/services\/services-integrations", optional = true \}/,
        message:
          'openbitfun-services-integrations dependency must stay optional so local workspace profiles do not compile remote integrations',
      },
      {
        regex:
          /openbitfun-ai-adapters = \{ path = "\.\.\/\.\.\/adapters\/ai-adapters", optional = true \}/,
        message: 'openbitfun-ai-adapters dependency must stay optional for no-default core builds',
      },
      {
        regex: /"dep:openbitfun-ai-adapters"/,
        message: 'core ai-adapter-runtime feature must explicitly enable the optional dependency',
      },
      {
        regex: /subscription-auth = \["openbitfun-ai-adapters\?\/subscription-auth"\]/,
        message: 'core subscription-auth modifier must not activate the optional AI adapter runtime by itself',
      },
      {
        regex: /document-read = \["tool-runtime\?\/document-read"\]/,
        message: 'core document-read modifier must not activate the optional tool runtime by itself',
      },
      {
        regex: /agent-runtime = \[[^\]]*"ai-adapter-runtime"[^\]]*\]/,
        message: 'core agent-runtime assembly must explicitly opt into AI adapter runtime',
      },
      {
        regex: /agent-runtime = \[[^\]]*"openbitfun-product-domains\/external-sources"[^\]]*\]/,
        message: 'core agent-runtime must select only the external-subagent contract slice it uses',
      },
      {
        regex: /function-agents = \[[^\]]*"ai-adapter-runtime"[^\]]*\]/,
        message: 'core function-agent facade must explicitly opt into AI adapter runtime while concrete AI adapters remain optional',
      },
      {
        regex: /function-agents = \[[^\]]*"openbitfun-services-integrations\/function-agents"[^\]]*\]/,
        message: 'core function-agent facade must enable the function-agent service owner feature it imports',
      },
      {
        regex: /tools-miniapp = \[[^\]]*"openbitfun-services-integrations\/miniapp-runtime"[^\]]*\]/,
        message: 'core MiniApp tool owner must enable the MiniApp runtime service feature it imports',
      },
      {
        regex: /tools-miniapp = \[[^\]]*"openbitfun-product-domains\/miniapp"[^\]]*\]/,
        message: 'core MiniApp tool owner must select its product-domain slice explicitly',
      },
      {
        regex: /canvas-runtime = \[[^\]]*"openbitfun-services-integrations\/canvas-runtime"[^\]]*\]/,
        message:
          'core canvas-runtime facade must enable the Canvas service owner feature it imports',
      },
      {
        regex:
          /canvas-runtime = \[[\s\S]*"dep:openbitfun-product-domains"[\s\S]*"openbitfun-services-integrations\/canvas-runtime"[\s\S]*\]/,
        message:
          'core canvas-runtime feature must explicitly aggregate the domain contract and canvas service owner',
      },
      {
        regex:
          /openbitfun-product-domains = \{ path = "\.\.\/\.\.\/contracts\/product-domains", optional = true \}/,
        message:
          'openbitfun-product-domains dependency must stay optional and not force product-full outside the core feature graph',
      },
      {
        regex:
          /openbitfun-product-capabilities = \{ path = "\.\.\/product-capabilities", optional = true \}/,
        message:
          'openbitfun-product-capabilities dependency must stay optional and not force product-full outside the core feature graph',
      },
      {
        regex: /"dep:openbitfun-tool-packs"/,
        message: 'core tool-packs feature must explicitly enable the optional dependency',
      },
      {
        regex: /tools-basic = \[[^\]]*"openbitfun-tool-packs\/basic"[^\]]*\]/,
        message: 'core basic tools owner must explicitly enable the matching tool pack feature',
      },
      {
        regex: /"dep:openbitfun-product-domains"/,
        message: 'core capability owners must explicitly enable the optional product-domain dependency',
      },
      {
        regex: /"dep:openbitfun-product-capabilities"/,
        message:
          'core product-capabilities feature must explicitly enable the optional dependency',
      },
      {
        regex: /"openbitfun-product-domains\/function-agents"/,
        message: 'core function-agent owner must explicitly select its product-domain slice',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/lib.rs',
    reason:
      'no-default openbitfun-core must keep product runtime surfaces behind explicit features',
    patterns: [
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*pub mod agentic\b/s,
        message: 'agentic runtime must stay behind agent-runtime for no-default builds',
      },
      {
        regex: /#\[cfg\(feature = "external-sources"\)\]\s*mod external_subagents\b/s,
        message: 'external subagent product assembly must stay behind external-sources',
      },
      {
        regex: /#\[cfg\(feature = "function-agents"\)\]\s*pub mod function_agents\b/s,
        message: 'function-agent product domain facade must stay behind function-agents',
      },
      {
        regex: /#\[cfg\(feature = "tools-miniapp"\)\]\s*pub mod miniapp\b/s,
        message: 'MiniApp product facade must stay behind its tool capability owner',
      },
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*pub\(crate\) mod service_agent_runtime\b/s,
        message: 'service agent runtime owner assembly must stay behind agent-runtime',
      },
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*pub mod native_hooks\b/s,
        message: 'native Agent hook dispatch must stay owned by agent-runtime',
      },
      {
        regex: /#\[cfg\(feature = "external-sources"\)\]\s*mod instruction_sources\b/s,
        message: 'third-party instruction discovery must stay behind external-sources',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/dispatch/mod.rs',
    reason:
      'no-default dispatch cleanup must retain claimed records when the product worktree owner is unavailable',
    patterns: [
      {
        regex:
          /#\[cfg\(feature = "agent-runtime"\)\]\s*mod baseline;[\s\S]*?#\[cfg\(all\(feature = "agent-runtime", feature = "ssh-remote"\)\)\]\s*mod controller;[\s\S]*?#\[cfg\(all\(feature = "agent-runtime", feature = "ssh-remote"\)\)\]\s*mod device_controller;[\s\S]*?#\[cfg\(feature = "agent-runtime"\)\]\s*mod preparation;/s,
        message: 'Dispatch SSH/device controllers must require both agent-runtime and ssh-remote',
      },
      {
        regex:
          /#\[cfg\(feature = "agent-runtime"\)\]\s*async fn release_baseline_claim\b/s,
        message: 'worktree-backed dispatch claim release must stay behind agent-runtime',
      },
      {
        regex:
          /#\[cfg\(not\(feature = "agent-runtime"\)\)\]\s*async fn release_baseline_claim\([^)]*\)\s*->\s*Result<\(\), DispatchStoreError>\s*\{\s*Err\(\s*DispatchStoreError::ClaimRelease\([\s\S]*?\)\s*\)\s*\}/s,
        message: 'no-default dispatch claim release must fail closed',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/infrastructure/mod.rs',
    reason: 'concrete AI adapter runtime and debug ingest HTTP server must stay out of no-default core builds',
    patterns: [
      {
        regex: /#\[cfg\(feature = "ai-adapter-runtime"\)\]\s*pub mod ai\b/s,
        message: 'AI client runtime must stay behind ai-adapter-runtime',
      },
      {
        regex: /#\[cfg\(all\(feature = "ai-adapter-runtime", feature = "subscription-auth"\)\)\]\s*pub mod subscription_auth\b/s,
        message: 'AI subscription auth runtime must require both the adapter and credential owners',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/util/types/ai.rs',
    reason: 'legacy AI implementation DTO re-exports must not force AI adapters into no-default core builds',
    patterns: [
      {
        regex: /pub use openbitfun_core_types::\{ConnectionTestMessageCode, ConnectionTestResult, RemoteModelInfo\};/s,
        message: 'stable AI DTOs must be re-exported from core-types',
      },
      {
        regex: /#\[cfg\(feature = "ai-adapter-runtime"\)\]\s*pub use openbitfun_ai_adapters::types::\{GeminiResponse, GeminiUsage\};/s,
        message: 'legacy Gemini implementation DTOs must stay behind ai-adapter-runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mod.rs',
    reason:
      'service integration and agent-runtime surfaces must not compile in no-default core builds',
    patterns: [
      {
        regex: /#\[cfg\(feature = "announcement"\)\]\s*pub mod announcement\b/s,
        message: 'announcement facade must stay behind its exact feature',
      },
      {
        regex: /#\[cfg\(feature = "file-watch"\)\]\s*pub use openbitfun_services_integrations::file_watch\b/s,
        message: 'file-watch facade must stay behind its exact feature',
      },
      {
        regex: /#\[cfg\(feature = "diagnostics"\)\]\s*pub use openbitfun_services_core::diagnostics\b/s,
        message: 'diagnostics compatibility facade must stay behind diagnostics',
      },
      {
        regex: /#\[cfg\(feature = "diff"\)\]\s*pub use openbitfun_services_core::diff\b/s,
        message: 'diff compatibility facade must stay behind diff',
      },
      {
        regex: /#\[cfg\(feature = "git"\)\]\s*pub mod git\b/s,
        message: 'git service facade must stay behind its exact feature',
      },
      {
        regex: /#\[cfg\(all\(feature = "agent-runtime", feature = "git"\)\)\]\s*pub mod worktree\b/s,
        message: 'managed worktree service must require both Agent lifecycle and Git owners',
      },
      {
        regex: /#\[cfg\(all\(feature = "agent-runtime", feature = "git"\)\)\]\s*pub use worktree::WorktreeService\b/s,
        message: 'managed worktree export must require both Agent lifecycle and Git owners',
      },
      {
        regex: /#\[cfg\(all\(feature = "agent-runtime", feature = "scheduled-jobs"\)\)\]\s*pub mod cron\b/s,
        message: 'scheduled job service must require both the Agent lifecycle and scheduled-jobs modifier',
      },
      {
        regex: /#\[cfg\(all\(feature = "agent-runtime", feature = "scheduled-jobs"\)\)\]\s*pub use cron::/s,
        message: 'scheduled job exports must require both the Agent lifecycle and scheduled-jobs modifier',
      },
      {
        regex: /#\[cfg\(all\(not\(feature = "remote-workspace"\), feature = "agent-runtime"\)\)\]\s*#\[path = "remote_ssh_compat.rs"\]\s*pub mod remote_ssh\b/s,
        message: 'local Agent workspace identity compatibility must stay behind agent-runtime without enabling remote transport',
      },
      {
        regex: /#\[cfg\(feature = "mcp-runtime"\)\]\s*pub mod mcp\b/s,
        message: 'Core MCP product bridge must stay behind mcp-runtime',
      },
      {
        regex: /#\[cfg\(feature = "remote-connect"\)\]\s*pub mod remote_connect\b/s,
        message: 'Core Remote Connect product bridge must stay behind remote-connect',
      },
      {
        regex: /#\[cfg\(feature = "review-platform"\)\]\s*pub mod review_platform\b/s,
        message: 'review platform facade must stay behind its exact feature',
      },
      {
        regex: /#\[cfg\(feature = "workspace-search"\)\]\s*pub mod search\b/s,
        message: 'workspace search facade must stay behind workspace-search',
      },
      {
        regex: /#\[cfg\(feature = "workspace-search"\)\]\s*pub use search::/s,
        message: 'workspace search exports must stay behind workspace-search',
      },
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*pub mod snapshot\b/s,
        message: 'snapshot service must stay behind agent-runtime until tool-runtime ownership is split',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/config/mod.rs',
    reason:
      'mode config canonicalization depends on product agent/tool registries and must stay out of no-default builds',
    patterns: [
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*pub mod mode_config_canonicalizer\b/s,
        message: 'mode config canonicalizer must stay behind agent-runtime',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace/manager.rs',
    reason:
      'workspace metadata may omit git worktree enrichment when service integrations are disabled',
    patterns: [
      {
        regex:
          /#\[cfg\(feature = "git"\)\]\s*use super::worktree_topology::global_worktree_topology_service\b/s,
        message: 'worktree topology owner import must stay gated for no-default builds',
      },
      {
        regex: /#\[cfg\(not\(feature = "git"\)\)\]\s*\{\s*let _ = \(workspace_root, freshness\);\s*return None;\s*\}/s,
        message: 'no-default worktree enrichment fallback must remain explicit',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace_runtime/service.rs',
    reason:
      'workspace runtime binding helpers may depend on agentic runtime only in full product builds',
    patterns: [
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*use crate::agentic::WorkspaceBinding\b/s,
        message: 'WorkspaceBinding import must stay gated for no-default builds',
      },
      {
        regex: /#\[cfg\(feature = "agent-runtime"\)\]\s*pub async fn ensure_runtime_for_workspace_binding\b/s,
        message: 'WorkspaceBinding runtime helper must stay behind agent-runtime',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/background_command_output.rs',
    reason:
      'tool-runtime must own reusable background exec-command output capture state, cursors, retention, and lifecycle metadata',
    patterns: [
      {
        regex: /\bpub struct BackgroundCommandOutputCapture\b/,
        message: 'missing background command output capture owner',
      },
      {
        regex: /\bpub enum BackgroundCommandOutputStatus\b/,
        message: 'missing background command output status contract',
      },
      {
        regex: /\bpub struct BackgroundCommandOutputMetadata\b/,
        message: 'missing background command output metadata contract',
      },
      {
        regex: /\bpub fn background_command_output_capture\b/,
        message: 'missing background command output global entry',
      },
      {
        regex: /\bBACKGROUND_COMMAND_OUTPUT_CAPTURE_LIMIT_BYTES\b/,
        message: 'missing background command output retention limit',
      },
      {
        regex: /\bbackground_command_output_reads_snapshot_then_incremental_chunks\b/,
        message: 'missing background command output snapshot/incremental regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/exec_command.rs',
    reason:
      'tool-runtime must own provider-neutral ExecCommand presentation, shell/env policy, lifecycle facts, control facts, completion shape, and session-not-found result builders while core keeps concrete process managers',
    patterns: [
      {
        regex: /\bpub const EXEC_COMMAND_POWERSHELL_UTF8_OUTPUT_PREFIX\b/,
        message: 'missing ExecCommand PowerShell UTF-8 shell policy owner',
      },
      {
        regex: /\bpub const EXEC_COMMAND_DEFAULT_YIELD_TIME_MS\b/,
        message: 'missing ExecCommand default wait policy owner',
      },
      {
        regex: /\bpub enum ExecCommandShellKind\b/,
        message: 'missing provider-neutral ExecCommand shell kind owner',
      },
      {
        regex: /\bCustom\(String\)/,
        message: 'missing ExecCommand custom shell name preservation',
      },
      {
        regex: /\bpub struct ExecCommandRemoteShell\b/,
        message: 'missing provider-neutral ExecCommand remote shell probe owner',
      },
      {
        regex: /\bpub const REMOTE_EXEC_SHELL_PROBE_TIMEOUT_MS\b/,
        message: 'missing provider-neutral ExecCommand remote shell probe timeout owner',
      },
      {
        regex: /\bpub fn remote_exec_shell_probe_command\b/,
        message: 'missing provider-neutral ExecCommand remote shell probe command owner',
      },
      {
        regex: /\bpub fn fallback_remote_exec_shell\b/,
        message: 'missing provider-neutral ExecCommand remote shell fallback owner',
      },
      {
        regex: /\bpub struct ExecCommandRemoteEnvSnapshot\b/,
        message: 'missing provider-neutral ExecCommand remote env snapshot owner',
      },
      {
        regex: /\bpub struct ExecCommandRemoteEnvSnapshotCapturePolicy\b/,
        message: 'missing provider-neutral ExecCommand remote env capture policy owner',
      },
      {
        regex: /\bpub struct ExecCommandRemoteEnvSnapshotCacheKey\b/,
        message: 'missing provider-neutral ExecCommand remote env snapshot cache key owner',
      },
      {
        regex: /\bpub struct ExecCommandRemoteEnvSnapshotCache\b/,
        message: 'missing provider-neutral ExecCommand remote env snapshot cache owner',
      },
      {
        regex: /\bpub fn remote_exec_env_snapshot_capture_policy\b/,
        message: 'missing provider-neutral ExecCommand remote env capture policy builder',
      },
      {
        regex: /\bpub fn exec_command_argv_for_shell\b/,
        message: 'missing provider-neutral ExecCommand shell argv owner',
      },
      {
        regex: /\bpub fn remote_exec_login_shell_command\b/,
        message: 'missing provider-neutral ExecCommand remote login command owner',
      },
      {
        regex: /\bpub fn remote_exec_non_tty_control_wrapper\b/,
        message: 'missing provider-neutral ExecCommand remote control wrapper owner',
      },
      {
        regex: /\bpub fn parse_remote_exec_env_snapshot_output\b/,
        message: 'missing provider-neutral ExecCommand remote env parser owner',
      },
      {
        regex: /\bpub enum ExecCommandLifecycleStatus\b/,
        message: 'missing provider-neutral ExecCommand lifecycle status owner',
      },
      {
        regex: /\bpub fn exec_command_lifecycle_background_output_status\b/,
        message: 'missing provider-neutral ExecCommand lifecycle background status owner',
      },
      {
        regex: /\bpub enum ExecCommandControlAction\b/,
        message: 'missing provider-neutral exec control action contract',
      },
      {
        regex: /\bpub struct ExecCommandControlRequest\b/,
        message: 'missing provider-neutral exec control request contract',
      },
      {
        regex: /\bpub struct ExecCommandRunInput\b/,
        message: 'missing provider-neutral ExecCommand input parser contract',
      },
      {
        regex: /\bpub struct WriteStdinInput\b/,
        message: 'missing provider-neutral WriteStdin input parser contract',
      },
      {
        regex: /\bpub struct ExecCommandControlToolInput\b/,
        message: 'missing provider-neutral ExecControl input parser contract',
      },
      {
        regex: /\bpub struct ExecCommandResultFields\b/,
        message: 'missing provider-neutral ExecCommand result fields contract',
      },
      {
        regex: /\bpub struct ExecCommandShellMetadata\b/,
        message: 'missing provider-neutral ExecCommand shell metadata contract',
      },
      {
        regex: /\bpub fn exec_command_result_value\b/,
        message: 'missing ExecCommand result value owner',
      },
      {
        regex: /\bpub fn write_stdin_result_value\b/,
        message: 'missing WriteStdin result value owner',
      },
      {
        regex: /\bpub fn write_stdin_session_not_found_result\b/,
        message: 'missing WriteStdin session-not-found result owner',
      },
      {
        regex: /\bpub fn exec_control_result_value\b/,
        message: 'missing ExecControl result value owner',
      },
      {
        regex: /\bpub fn render_exec_command_response_for_assistant\b/,
        message: 'missing ExecCommand assistant response owner',
      },
      {
        regex: /\bpub fn render_write_stdin_response_for_assistant\b/,
        message: 'missing WriteStdin assistant response owner',
      },
      {
        regex: /\bpub fn exec_control_session_not_found_result\b/,
        message: 'missing ExecControl session-not-found result owner',
      },
      {
        regex: /\bpub fn exec_command_background_output_status\b/,
        message: 'missing ExecCommand background-output status owner',
      },
      {
        regex: /\bcompletion_value_uses_stable_snake_case_shape\b/,
        message: 'missing ExecCommand completion shape regression',
      },
      {
        regex: /\bbackground_output_status_maps_terminal_completion_without_core_types\b/,
        message: 'missing ExecCommand background status regression',
      },
      {
        regex: /\bremote_login_shell_command_applies_snapshot_then_tool_env\b/,
        message: 'missing ExecCommand remote env merge regression',
      },
      {
        regex: /\bremote_shell_probe_and_env_snapshot_are_provider_neutral\b/,
        message: 'missing ExecCommand remote shell/env parser regression',
      },
      {
        regex: /\bremote_env_snapshot_capture_policy_keeps_existing_bounds\b/,
        message: 'missing ExecCommand remote env capture policy regression',
      },
      {
        regex: /\bremote_env_snapshot_cache_owns_key_and_ttl_policy\b/,
        message: 'missing ExecCommand remote env snapshot cache regression',
      },
      {
        regex: /\bremote_shell_probe_skips_non_posix_shells\b/,
        message: 'missing ExecCommand remote shell POSIX compatibility regression',
      },
      {
        regex: /\bremote_shell_probe_preserves_unknown_shell_name_as_posix_compatible\b/,
        message: 'missing ExecCommand custom remote shell metadata regression',
      },
      {
        regex: /\bexec_command_input_policy_applies_defaults_without_trimming_command\b/,
        message: 'missing ExecCommand input/default wait regression',
      },
      {
        regex: /\bwrite_stdin_input_policy_applies_poll_defaults\b/,
        message: 'missing WriteStdin input/default wait regression',
      },
      {
        regex: /\bexec_control_input_policy_keeps_wait_optional\b/,
        message: 'missing ExecControl input/default wait regression',
      },
      {
        regex: /\bexec_command_result_builder_preserves_existing_wire_shape\b/,
        message: 'missing ExecCommand result shape regression',
      },
      {
        regex: /\bwrite_stdin_and_control_result_builders_preserve_remote_shape\b/,
        message: 'missing WriteStdin/ExecControl result shape regression',
      },
      {
        regex: /\blifecycle_status_has_provider_neutral_names_and_background_statuses\b/,
        message: 'missing ExecCommand lifecycle status regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/completion.rs',
    reason:
      'core exec_command adapter must keep concrete local/remote completion mapping centralized while result shape stays in tool-runtime',
    patterns: [
      {
        regex: /\bpub\(super\) fn exec_command_local_completion\b/,
        message: 'missing centralized local completion mapping adapter',
      },
      {
        regex: /\bpub\(super\) fn exec_command_remote_completion\b/,
        message: 'missing centralized remote completion mapping adapter',
      },
      {
        regex: /\bExecCommandCompletionStatus::Interrupted\b/,
        message: 'missing completion status mapping coverage',
      },
      {
        regex: /\bExecCommandCompletionSource::OutOfBandControl\b/,
        message: 'missing completion source mapping coverage',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/command.rs',
    reason:
      'core exec_command adapter must delegate provider-neutral shell/env/lifecycle policy to tool-runtime and keep only concrete process/remote wiring',
    patterns: [
      {
        regex: /\bexec_command_argv_for_shell\b/,
        message: 'missing tool-runtime shell argv delegation in core exec_command adapter',
      },
      {
        regex: /\bparse_remote_exec_shell_probe_output\b/,
        message: 'missing tool-runtime remote shell probe delegation in core exec_command adapter',
      },
      {
        regex: /\bremote_exec_shell_probe_command\b/,
        message: 'missing tool-runtime remote shell probe command delegation in core exec_command adapter',
      },
      {
        regex: /\bfallback_remote_exec_shell\b/,
        message: 'missing tool-runtime remote shell fallback delegation in core exec_command adapter',
      },
      {
        regex: /\bremote_exec_login_shell_command\b/,
        message: 'missing tool-runtime remote login command delegation in core exec_command adapter',
      },
      {
        regex: /\bremote_exec_non_tty_control_wrapper\b/,
        message: 'missing tool-runtime remote non-TTY wrapper delegation in core exec_command adapter',
      },
      {
        regex: /\bexec_command_lifecycle_status_name\b/,
        message: 'missing tool-runtime lifecycle status-name delegation in core exec_command adapter',
      },
      {
        regex: /\bexec_command_lifecycle_background_output_status\b/,
        message: 'missing tool-runtime lifecycle output-status delegation in core exec_command adapter',
      },
      {
        regex: /\bexec_command_run_input_from_input\b/,
        message: 'missing tool-runtime ExecCommand input delegation in core exec_command adapter',
      },
      {
        regex: /\bexec_command_result_value\b/,
        message: 'missing tool-runtime ExecCommand result builder delegation in core exec_command adapter',
      },
      {
        regex: /\bexec_command_local_completion\b/,
        message: 'missing shared completion mapping in core exec_command adapter',
      },
      {
        regex: /\bexec_command_remote_completion\b/,
        message: 'missing shared remote completion mapping in core exec_command adapter',
      },
      {
        regex: /\bExecCommandShellMetadata\b/,
        message: 'missing tool-runtime ExecCommand shell metadata delegation in core exec_command adapter',
      },
      {
        regex: /\bremote_shell_probe_preserves_unknown_shell_metadata\b/,
        message: 'missing core custom remote shell metadata regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/stdin.rs',
    reason:
      'core WriteStdin adapter must delegate provider-neutral input/default wait and result shape policy to tool-runtime',
    patterns: [
      {
        regex: /\bwrite_stdin_input_from_input\b/,
        message: 'missing tool-runtime WriteStdin input delegation in core adapter',
      },
      {
        regex: /\bwrite_stdin_input_validation_message\b/,
        message: 'missing tool-runtime WriteStdin validation delegation in core adapter',
      },
      {
        regex: /\bwrite_stdin_result_value\b/,
        message: 'missing tool-runtime WriteStdin result builder delegation in core adapter',
      },
      {
        regex: /\bwrite_stdin_session_not_found_result\b/,
        message: 'missing tool-runtime WriteStdin session-not-found delegation in core adapter',
      },
      {
        regex: /\bexec_command_local_completion\b/,
        message: 'missing shared local completion mapping in core WriteStdin adapter',
      },
      {
        regex: /\bexec_command_remote_completion\b/,
        message: 'missing shared remote completion mapping in core WriteStdin adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/control.rs',
    reason:
      'core ExecControl adapter must delegate provider-neutral input/default wait and result shape policy to tool-runtime',
    patterns: [
      {
        regex: /\bexec_command_control_tool_input_from_input\b/,
        message: 'missing tool-runtime ExecControl input delegation in core adapter',
      },
      {
        regex: /\bexec_command_control_tool_input_validation_message\b/,
        message: 'missing tool-runtime ExecControl validation delegation in core adapter',
      },
      {
        regex: /\bexec_control_result_value\b/,
        message: 'missing tool-runtime ExecControl result builder delegation in core adapter',
      },
      {
        regex: /\bexec_command_local_completion\b/,
        message: 'missing shared local completion mapping in core ExecControl adapter',
      },
      {
        regex: /\bexec_command_remote_completion\b/,
        message: 'missing shared remote completion mapping in core ExecControl adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/env_snapshot.rs',
    reason:
      'core exec_command env snapshot adapter must delegate snapshot command and parsing policy to tool-runtime',
    patterns: [
      {
        regex: /\bremote_exec_env_snapshot_command\b/,
        message: 'missing tool-runtime remote env snapshot command delegation in core adapter',
      },
      {
        regex: /\bparse_remote_exec_env_snapshot_output\b/,
        message: 'missing tool-runtime remote env snapshot parsing delegation in core adapter',
      },
      {
        regex: /\bremote_exec_env_snapshot_capture_policy\b/,
        message: 'missing tool-runtime remote env snapshot capture policy delegation in core adapter',
      },
      {
        regex: /\bExecCommandRemoteEnvSnapshotCache\b/,
        message: 'missing tool-runtime remote env snapshot cache owner in core adapter',
      },
      {
        regex: /\bExecCommandRemoteEnvSnapshotCacheKey\b/,
        message: 'missing tool-runtime remote env snapshot cache key owner in core adapter',
      },
      {
        regex: /\bexec_command_shell_kind\b/,
        message: 'missing shared shell kind mapping for core env snapshot adapter',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/exec_command/shell_kind.rs',
    reason:
      'core exec_command adapter must keep ShellType/tool-runtime shell-kind mapping centralized and preserve custom shell metadata',
    patterns: [
      {
        regex: /\bpub\(super\) fn exec_command_shell_kind\b/,
        message: 'missing centralized ShellType to ExecCommandShellKind adapter',
      },
      {
        regex: /\bpub\(super\) fn terminal_shell_type\b/,
        message: 'missing centralized ExecCommandShellKind to ShellType adapter',
      },
      {
        regex: /\bExecCommandShellKind::Custom\(name\.clone\(\)\)/,
        message: 'missing custom shell name preservation in core shell-kind adapter',
      },
      {
        regex: /\bShellType::Custom\(name\)/,
        message: 'missing custom shell metadata restoration in core shell-kind adapter',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-execution/src/computer_use.rs',
    reason:
      'tool-runtime must own provider-neutral Computer Use loop detection, screenshot hashing, verification, and retry policy while core keeps host adapters',
    patterns: [
      {
        regex: /\bpub struct ComputerUseOptimizer\b/,
        message: 'missing Computer Use optimizer owner',
      },
      {
        regex: /\bpub fn hash_screenshot_bytes\b/,
        message: 'missing Computer Use screenshot hash owner',
      },
      {
        regex: /\bpub struct VerificationResult\b/,
        message: 'missing Computer Use verification result contract',
      },
      {
        regex: /\bpub fn should_retry_action_message\b/,
        message: 'missing provider-neutral Computer Use retry decision owner',
      },
      {
        regex: /\bdetects_repeated_action_loop\b/,
        message: 'missing Computer Use loop detection regression',
      },
      {
        regex: /\bretry_decision_uses_error_text_without_core_error_type\b/,
        message: 'missing Computer Use retry decision regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_ssh/mod.rs',
    reason:
      'core remote SSH compatibility facade must keep concrete SSH surfaces behind the ssh-remote feature and re-export services-owned disabled stubs for lightweight builds',
    patterns: [
      {
        regex: /#\[cfg\(not\(feature = "ssh-remote"\)\)\]\s*pub use openbitfun_services_integrations::remote_ssh::\{/s,
        message: 'missing services-owned disabled remote SSH re-export for no-default builds',
      },
      {
        regex: /#\[cfg\(feature = "ssh-remote"\)\]\s*pub mod manager\b/s,
        message: 'remote SSH manager must stay gated behind ssh-remote',
      },
      {
        regex: /#\[cfg\(feature = "ssh-remote"\)\]\s*pub mod remote_fs\b/s,
        message: 'remote SSH filesystem runtime must stay gated behind ssh-remote',
      },
      {
        regex: /#\[cfg\(feature = "ssh-remote"\)\]\s*pub mod remote_terminal\b/s,
        message: 'remote SSH terminal runtime must stay gated behind ssh-remote',
      },
      {
        regex: /\bpub mod workspace_state\b/,
        message: 'remote workspace identity helpers must remain available without ssh-remote',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/disabled.rs',
    reason:
      'services-integrations must own explicit unsupported remote SSH stubs for lightweight builds',
    patterns: [
      {
        regex: /Remote SSH support is disabled; enable the `ssh-remote` feature/,
        message: 'missing explicit disabled remote SSH diagnostic',
      },
      {
        regex: /\bpub struct SSHConnectionManager\b/,
        message: 'missing disabled SSH manager compatibility surface',
      },
      {
        regex: /\bpub struct RemoteFileService\b/,
        message: 'missing disabled remote file compatibility surface',
      },
      {
        regex: /\bpub struct RemoteTerminalManager\b/,
        message: 'missing disabled remote terminal compatibility surface',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/mod.rs',
    reason:
      'services-integrations remote_ssh must own concrete SSH/SFTP/PTY runtime behind the remote-ssh-concrete feature while keeping lightweight path/type contracts separate',
    patterns: [
      {
        regex: /#\[cfg\(not\(feature = "remote-ssh-concrete"\)\)\]\s*mod disabled\b/s,
        message: 'missing disabled remote SSH owner module',
      },
      {
        regex: /#\[cfg\(not\(feature = "remote-ssh-concrete"\)\)\]\s*pub use disabled::\{/s,
        message: 'missing disabled remote SSH owner exports',
      },
      {
        regex: /#\[cfg\(feature = "remote-ssh-concrete"\)\]\s*pub mod manager\b/s,
        message: 'missing concrete SSH manager owner module',
      },
      {
        regex: /#\[cfg\(feature = "remote-ssh-concrete"\)\]\s*mod remote_exec\b/s,
        message: 'missing concrete remote exec owner module',
      },
      {
        regex: /#\[cfg\(feature = "remote-ssh-concrete"\)\]\s*pub mod remote_fs\b/s,
        message: 'missing concrete remote filesystem owner module',
      },
      {
        regex: /#\[cfg\(feature = "remote-ssh-concrete"\)\]\s*pub mod remote_terminal\b/s,
        message: 'missing concrete remote terminal owner module',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/manager.rs',
    reason:
      'services-integrations remote_ssh manager owns russh connection, known-host, saved connection, SFTP, PTY channel, and port-forward concrete behavior',
    patterns: [
      {
        regex: /\bpub struct SSHConnectionManager\b/,
        message: 'missing SSH connection manager owner',
      },
      {
        regex: /\brussh::client::connect_stream\b/,
        message: 'missing russh connection owner path',
      },
      {
        regex: /\bSftpSession\b/,
        message: 'missing SFTP session owner path',
      },
      {
        regex: /\bretains_password_connection_and_workspace_without_vault_entry\b/,
        message: 'missing saved credential retention regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/remote_exec.rs',
    reason:
      'services-integrations remote_ssh remote_exec owns model-facing remote shell process lifecycle and stdin/control semantics',
    patterns: [
      {
        regex: /\bpub struct RemoteExecProcessManager\b/,
        message: 'missing remote exec process manager owner',
      },
      {
        regex: /\bGLOBAL_REMOTE_EXEC_MANAGER\b/,
        message: 'missing global remote exec manager compatibility owner',
      },
      {
        regex: /\bremote_exec_session_ids_match_local_test_baseline\b/,
        message: 'missing remote exec session-id compatibility regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/remote_fs.rs',
    reason:
      'services-integrations remote_ssh remote_fs owns SFTP-backed remote filesystem operations',
    patterns: [
      {
        regex: /\bpub struct RemoteFileService\b/,
        message: 'missing remote filesystem service owner',
      },
      {
        regex: /\bsftp_read\b/,
        message: 'missing SFTP read owner path',
      },
      {
        regex: /\bsftp_write\b/,
        message: 'missing SFTP write owner path',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/remote_terminal.rs',
    reason:
      'services-integrations remote_ssh remote_terminal owns remote PTY lifecycle, output broadcast, write, resize, and close behavior',
    patterns: [
      {
        regex: /\bpub struct RemoteTerminalManager\b/,
        message: 'missing remote terminal manager owner',
      },
      {
        regex: /\benum PtyCommand\b/,
        message: 'missing remote PTY command owner',
      },
      {
        regex: /\bchannel\.window_change\b/,
        message: 'missing remote PTY resize owner path',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/plugin.rs',
    reason:
      'runtime-ports plugin module must own typed Plugin Runtime Contract DTOs and client boundary traits',
    patterns: [
      {
        regex: /\bpub trait PluginRuntimeClient\b/,
        message: 'missing plugin runtime client boundary contract',
      },
      {
        regex: /\bread_plugins\b/,
        message: 'missing plugin discovery/status read boundary contract',
      },
      {
        regex: /\bPluginQuarantineState\b/,
        message: 'missing plugin quarantine read-model contract',
      },
      {
        regex: /\bpub enum PluginRuntimeBinding\b/,
        message: 'missing plugin runtime binding boundary contract',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/tests/runtime_port_contracts/plugin_runtime_contracts.rs',
    reason:
      'runtime-ports plugin contract tests must cover typed envelopes, candidate effects, and disabled/projection-only behavior',
    patterns: [
      {
        regex: /\bdispatch_envelope_serializes_typed_runtime_boundary_without_raw_payload\b/,
        message: 'missing typed dispatch envelope regression',
      },
      {
        regex: /\bresponse_envelope_carries_effect_candidates_and_observed_epochs\b/,
        message: 'missing typed response envelope regression',
      },
      {
        regex: /\bpermission_required_effects_keep_auditable_candidate_facts\b/,
        message: 'missing auditable permission-required candidate effect regression',
      },
      {
        regex: /\bread_plugins_contract_supports_discovery_status_and_config_projection\b/,
        message: 'missing plugin read-model contract regression',
      },
      {
        regex: /\bPluginStatusSnapshot\b/,
        message: 'missing plugin status snapshot regression coverage',
      },
      {
        regex: /\bdisabled_plugin_runtime_binding_reports_not_available\b/,
        message: 'missing disabled runtime binding regression',
      },
      {
        regex: /\bprojection_only_plugin_runtime_rejects_dispatch_when_unavailable\b/,
        message: 'missing projection-only runtime binding regression',
      },
      {
        regex: /\bclient_binding_rejects_unchecked_available_client_responses\b/,
        message: 'missing contract-checked executable runtime binding regression',
      },
      {
        regex: /\bclient_binding_rejects_read_sources_outside_request\b/,
        message: 'missing contract-checked read source isolation regression',
      },
      {
        regex: /\bclient_binding_rejects_executable_read_quarantine\b/,
        message: 'missing contract-checked read quarantine availability regression',
      },
      {
        regex:
          /\bclient_binding_rejects_dispatch_quarantine_without_host_restart_clear_condition\b/,
        message: 'missing dispatch quarantine clear-condition regression',
      },
      {
        regex:
          /\bclient_binding_rejects_read_quarantine_without_host_restart_clear_condition\b/,
        message: 'missing read quarantine clear-condition regression',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/tests/runtime_port_contracts/plugin_runtime_diagnostics_contracts.rs',
    reason:
      'runtime-ports plugin diagnostics contract tests must cover permission prompts, diagnostics, and quarantine facts',
    patterns: [
      {
        regex: /\bpermission_prompt_descriptor_contains_minimum_user_decision_facts\b/,
        message: 'missing permission prompt descriptor regression',
      },
      {
        regex: /\bdiagnostic_and_quarantine_state_are_auditable_projection_facts\b/,
        message: 'missing diagnostic and quarantine regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/plugin-runtime-client/tests/plugin_runtime_client.rs',
    reason:
      'plugin-runtime-client owner tests must cover dispatch, idempotency, deadline quarantine, adapter failure quarantine, and disposed project behavior',
    patterns: [
      {
        regex: /\bclient_dispatches_candidates\b/,
        message: 'missing client dispatch regression',
      },
      {
        regex: /\bclient_replays_idempotent_dispatch_without_recalling_adapter\b/,
        message: 'missing client idempotency regression',
      },
      {
        regex: /\bconcurrent_idempotent_dispatch_reuses_in_flight_response\b/,
        message: 'missing concurrent client idempotency regression',
      },
      {
        regex:
          /\bconcurrent_cross_key_dispatch_observes_active_quarantine_before_success\b/,
        message: 'missing cross-key active quarantine concurrency regression',
      },
      {
        regex: /\bidempotent_dispatch_cache_is_scoped_by_project_workspace_and_source\b/,
        message: 'missing client execution-domain scoped idempotency regression',
      },
      {
        regex: /\bidempotent_dispatch_cache_does_not_replay_across_events\b/,
        message: 'missing client event-scoped idempotency regression',
      },
      {
        regex: /\bidempotent_dispatch_cache_is_scoped_by_epoch_changes\b/,
        message: 'missing client epoch-scoped idempotency regression',
      },
      {
        regex: /\bidempotent_dispatch_cache_evicts_old_entries\b/,
        message: 'missing client bounded idempotency cache regression',
      },
      {
        regex: /\bread_model_is_scoped_by_project_and_workspace\b/,
        message: 'missing client read-model execution-domain isolation regression',
      },
      {
        regex: /\bread_model_rejects_wrong_workspace_response\b/,
        message: 'missing client wrong-workspace read-model rejection regression',
      },
      {
        regex: /\bactive_quarantine_blocks_new_dispatches_until_declared_recovery\b/,
        message: 'missing active quarantine dispatch blocking regression',
      },
      {
        regex: /\bactive_quarantine_blocks_malformed_follow_up_without_new_quarantine\b/,
        message: 'missing active quarantine malformed follow-up regression',
      },
      {
        regex: /\bmalformed_dispatch_with_missing_identity_observes_active_quarantine\b/,
        message: 'missing malformed dispatch missing-identity quarantine regression',
      },
      {
        regex: /\bclient_owned_quarantine_is_visible_in_read_model_with_diagnostics\b/,
        message: 'missing client-owned quarantine diagnostic read-model projection regression',
      },
      {
        regex: /\bzero_deadline_quarantines_without_adapter_dispatch\b/,
        message: 'missing client deadline quarantine regression',
      },
      {
        regex: /\bmalformed_dispatch_envelope_quarantines_without_adapter_dispatch\b/,
        message: 'missing client dispatch request preflight regression',
      },
      {
        regex: /\bnonzero_deadline_timeout_quarantines_without_success_effects\b/,
        message: 'missing client nonzero timeout regression',
      },
      {
        regex: /\badapter_failure_quarantines_without_writing_success\b/,
        message: 'missing client adapter failure quarantine regression',
      },
      {
        regex: /\bmalformed_adapter_success_quarantines_without_effects\b/,
        message: 'missing client malformed adapter success quarantine regression',
      },
      {
        regex: /\bpermission_prompt_target_mismatch_quarantines_without_effects\b/,
        message: 'missing client permission prompt/effect mismatch regression',
      },
      {
        regex: /\bpermission_prompt_authority_mismatch_quarantines_without_effects\b/,
        message: 'missing client permission authority mismatch regression',
      },
      {
        regex: /\bfinal_policy_decision_from_adapter_fails_closed\b/,
        message: 'missing client final policy outcome rejection regression',
      },
      {
        regex: /\badapter_id_or_quarantine_with_effects_mismatch_fails_closed\b/,
        message: 'missing client adapter id and mixed quarantine/effects regression',
      },
      {
        regex: /\bstatus_quarantine_with_success_effects_fails_closed\b/,
        message: 'missing client nested status quarantine/effects rejection regression',
      },
      {
        regex: /\bdisposed_project_rejects_dispatch_and_read_model_reports_statuses\b/,
        message: 'missing client dispose/read-model regression',
      },
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/agent_api.rs',
    reason:
      'runtime-ports must keep remote and subagent runtime boundary contracts DTO/trait-only',
    patterns: [
      {
        regex: /\bpub trait AgentTurnCancellationPort\b/,
        message: 'missing turn cancellation port contract',
      },
      {
        regex: /\bpub trait RemoteControlStatePort\b/,
        message: 'missing remote control state port contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/runtime_event_port.rs',
        regex: /\bpub trait RuntimeEventSink\b/,
        message: 'missing runtime event sink contract',
      },
      {
        regex: /\bpub struct AgentSessionCreateResult\b[\s\S]*\bpub session_name: String\b/,
        message: 'agent session create result must return the persisted session name',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bpub struct RemoteWorkspaceFacts\b/,
        message: 'missing remote workspace facts contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bpub trait RemoteWorkspaceRuntimeHost\b/,
        message: 'missing remote workspace runtime host contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bpub trait RemoteWorkspacePort\b/,
        message: 'missing remote workspace service port contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bpub trait RemoteWorkspaceFileRuntimeHost\b/,
        message: 'missing remote workspace file runtime host contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bpub trait RemoteProjectionPort\b/,
        message: 'missing remote projection service port contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bpub trait RemoteInitialSyncRuntimeHost\b/,
        message: 'missing remote initial sync runtime host contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bremote_workspace_contracts_preserve_workspace_and_session_facts\b/,
        message: 'missing remote workspace contract regression',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/remote_workspace_ports.rs',
        regex: /\bremote_projection_contract_preserves_file_chunk_identity\b/,
        message: 'missing remote projection contract regression',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bpub trait WorkspaceFileSystem\b/,
        message: 'missing workspace file-system port contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bfn join_path\(&self, root: &str, components: &\[&str\]\) -> String\b/,
        message: 'workspace filesystem providers must own their path joining syntax',
      },
      {
        path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_services.rs',
        regex: /fn join_path\(&self, root: &str, components: &\[&str\]\) -> String \{\r?\n\s*join_posix_path\(root, components\)/,
        message: 'remote workspace filesystem must keep POSIX path joining independent of the host',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bpub trait WorkspaceShell\b/,
        message: 'missing workspace shell port contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bpub struct WorkspaceServices\b/,
        message: 'missing workspace services bundle contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bpub struct WorkspaceCommandOptions\b/,
        message: 'missing workspace command options contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bpub struct WorkspaceCommandResult\b/,
        message: 'missing workspace command result contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bpub struct WorkspaceDirEntry\b/,
        message: 'missing workspace dir-entry contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/workspace_ports.rs',
        regex: /\bworkspace_services_contract_is_runtime_port_owned\b/,
        message: 'missing workspace service ownership regression',
      },
      {
        regex: /\bpub fn remote_image\b/,
        message: 'missing remote image attachment helper contract',
      },
      {
        regex: /\bpub struct AgentDialogTurnRequest\b/,
        message: 'missing agent dialog turn lifecycle request contract',
      },
      {
        regex: /\bpub struct AgentDialogPrependedReminder\b/,
        message: 'missing agent dialog prepended reminder contract',
      },
      {
        regex: /\bpub trait AgentDialogTurnPort\b/,
        message: 'missing agent dialog turn lifecycle port contract',
      },
      {
        regex: /\bpub struct AgentBackgroundResultRequest\b/,
        message: 'missing background result lifecycle request contract',
      },
      {
        regex: /\bpub enum AgentThreadGoalDeliveryKind\b/,
        message: 'missing thread-goal lifecycle delivery kind contract',
      },
      {
        regex: /\bpub struct AgentThreadGoalDeliveryRequest\b/,
        message: 'missing thread-goal lifecycle delivery request contract',
      },
      {
        regex: /\bpub trait AgentLifecycleDeliveryPort\b/,
        message: 'missing agent lifecycle delivery port contract',
      },
      {
        regex: /\brequester_session_id\b/,
        message: 'missing requester-aware turn cancellation contract',
      },
      {
        regex: /\bpub struct AgentSessionListRequest\b/,
        message: 'missing agent session list request contract',
      },
      {
        regex: /\bpub struct AgentSessionSummary\b/,
        message: 'missing agent session summary contract',
      },
      {
        regex: /\bpub struct AgentSessionDeleteRequest\b/,
        message: 'missing agent session delete request contract',
      },
      {
        regex: /\bpub struct AgentSessionWorkspaceRequest\b/,
        message: 'missing agent session workspace request contract',
      },
      {
        regex: /\bpub trait AgentSessionManagementPort\b/,
        message: 'missing agent session management port contract',
      },
      {
        regex: /\bagent_session_management_contracts_serialize_stable_shape\b/,
        message: 'missing agent session management serialization regression',
      },
      {
        regex: /\bagent_dialog_turn_request_serializes_lifecycle_contract\b/,
        message: 'missing agent dialog turn lifecycle request regression',
      },
      {
        regex: /\bagent_background_result_request_serializes_lifecycle_contract\b/,
        message: 'missing background result lifecycle request regression',
      },
      {
        regex: /\bagent_thread_goal_delivery_request_serializes_lifecycle_contract\b/,
        message: 'missing thread-goal lifecycle request regression',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bpub type DialogTriggerSource = AgentSubmissionSource\b/,
        message: 'missing dialog trigger source compatibility contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bdialog_trigger_source_reuses_agent_submission_source_contract\b/,
        message: 'missing dialog trigger source alias regression',
      },
      {
        regex: /\bpub enum DialogQueuePriority\b/,
        message: 'missing dialog queue priority contract',
      },
      {
        regex: /\bpub struct DialogSubmissionPolicy\b/,
        message: 'missing dialog submission policy contract',
      },
      {
        regex: /\bdialog_submission_policy_preserves_current_surface_queue_defaults\b/,
        message: 'missing dialog submission policy regression',
      },
      {
        regex: /\bpub enum DialogSubmitOutcome\b/,
        message: 'missing dialog submit outcome contract',
      },
      {
        regex: /\bdialog_submit_outcome_preserves_started_and_queued_fields\b/,
        message: 'missing dialog submit outcome regression',
      },
      {
        regex: /\bpub enum DialogSessionStateFact\b/,
        message: 'missing dialog session state fact contract',
      },
      {
        regex: /\bpub struct DialogSubmitQueueFacts\b/,
        message: 'missing dialog submit queue facts contract',
      },
      {
        regex: /\bpub enum DialogSubmitQueueAction\b/,
        message: 'missing dialog submit queue action contract',
      },
      {
        regex: /\bpub const fn resolve_dialog_submit_queue_action\b/,
        message: 'missing dialog submit queue action resolver',
      },
      {
        regex: /\bdialog_submit_queue_action_preserves_current_scheduler_routing_policy\b/,
        message: 'missing dialog submit queue action regression',
      },
      {
        regex: /\bpub fn should_suppress_agent_session_cancelled_reply\b/,
        message: 'missing agent-session cancel suppression contract',
      },
      {
        regex: /\bpub enum DialogTurnOutcomeKind\b/,
        message: 'missing dialog turn outcome kind contract',
      },
      {
        regex: /\bpub const fn should_skip_agent_session_reply\b/,
        message: 'missing agent-session reply skip contract',
      },
      {
        regex: /\bagent_session_reply_decisions_preserve_cancel_suppression_boundary\b/,
        message: 'missing agent-session reply decision regression',
      },
      {
        regex: /\bpub struct AgentSessionReplyRoute\b/,
        message: 'missing agent session reply route contract',
      },
      {
        regex: /\bagent_session_reply_route_keeps_requester_fields\b/,
        message: 'missing agent session reply route regression',
      },
      {
        regex: /\bpub enum DialogSteerOutcome\b/,
        message: 'missing dialog steer outcome contract',
      },
      {
        regex: /\bdialog_steer_outcome_preserves_buffered_fields\b/,
        message: 'missing dialog steer outcome regression',
      },
      {
        regex: /\bpub enum RoundInjectionKind\b/,
        message: 'missing round injection kind contract',
      },
      {
        regex: /\bpub enum RoundInjectionTarget\b/,
        message: 'missing round injection target contract',
      },
      {
        regex: /\bpub struct RoundInjection\b/,
        message: 'missing round injection message contract',
      },
      {
        regex: /\bpub trait DialogRoundInjectionSource\b/,
        message: 'missing dialog round injection source contract',
      },
      {
        regex: /\bround_injection_contract_keeps_kind_and_target_identity\b/,
        message: 'missing round injection contract regression',
      },
      {
        regex: /\bround_injection_source_contract_drains_portable_injections\b/,
        message: 'missing round injection source contract regression',
      },
      {
        regex: /\bpub enum ThreadGoalStatus\b/,
        message: 'missing thread goal status contract',
      },
      {
        regex: /\bpub struct ThreadGoal\b/,
        message: 'missing thread goal contract',
      },
      {
        regex: /\bpub struct SetThreadGoalResult\b/,
        message: 'missing set thread goal result contract',
      },
      {
        regex: /\bpub struct ThreadGoalContinuationPlan\b/,
        message: 'missing thread goal continuation plan contract',
      },
      {
        regex: /\bpub struct ThreadGoalToolResponse\b/,
        message: 'missing thread goal tool response contract',
      },
      {
        regex: /\bthread_goal_active_status_includes_budget_limited\b/,
        message: 'missing thread goal status contract regression',
      },
      {
        regex: /\bthread_goal_tool_response_serializes_optional_fields\b/,
        message: 'missing thread goal tool response wire-shape regression',
      },
      {
        regex: /\bpub struct CompressionContract\b/,
        message: 'missing compression contract',
      },
      {
        regex: /\bpub struct CompressionContractItem\b/,
        message: 'missing compression contract item',
      },
      {
        regex: /\bcompression_contract_renders_model_visible_fields\b/,
        message: 'missing compression contract rendering regression',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bpub struct RelatedPath\b/,
        message: 'missing related path request-context contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\brelated_path_serializes_as_request_context_fact\b/,
        message: 'missing related path serialization regression',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bpub struct DelegationPolicy\b/,
        message: 'missing delegation policy contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bpub enum SubagentContextMode\b/,
        message: 'missing subagent context mode contract',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bdelegation_policy_child_blocks_recursive_spawn_without_losing_depth\b/,
        message: 'missing delegation policy contract regression',
      },
      {
        path: 'src/crates/contracts/runtime-ports/src/lib.rs',
        regex: /\bsubagent_context_mode_preserves_fork_wire_value\b/,
        message: 'missing subagent context mode contract regression',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/lib.rs',
    reason: 'Agent Runtime leaf capability modules must stay behind their exact owner features',
    patterns: [
      {
        regex: /#\[cfg\(feature = "native-hook-settings"\)\]\r?\npub mod native_hooks;/,
        message: 'native-hook-settings must gate the portable hook facade',
      },
      ...agentRuntimeRootPublicModules
        .filter((moduleName) => moduleName !== 'native_hooks')
        .map((moduleName) => ({
          regex: new RegExp(
            agentRuntimeDefinitionContractModules.has(moduleName)
              ? `#\\[cfg\\(any\\(feature = "agent-runtime", feature = "definition-contracts"\\)\\)\\]\\r?\\npub mod ${moduleName};`
              : `#\\[cfg\\(feature = "agent-runtime"\\)\\]\\r?\\npub mod ${moduleName};`,
          ),
          message: agentRuntimeDefinitionContractModules.has(moduleName)
            ? `${moduleName} must stay behind the full runtime or definition-contracts owner`
            : `${moduleName} must stay behind the full agent-runtime owner`,
        })),
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/native_hooks/mod.rs',
    reason: 'native hook execution modules must stay behind native-hook-runtime',
    patterns: [
      ...['engine', 'output', 'payload'].flatMap((moduleName) => [
        {
          regex: new RegExp(`#\\[cfg\\(feature = "native-hook-runtime"\\)\\]\\r?\\nmod ${moduleName};`),
          message: `${moduleName} must stay behind native-hook-runtime`,
        },
        {
          regex: new RegExp(`#\\[cfg\\(feature = "native-hook-runtime"\\)\\]\\r?\\npub use ${moduleName}(?:::|\\{)`),
          message: `${moduleName} exports must stay behind native-hook-runtime`,
        },
      ]),
    ],
  },
  {
    path: 'src/crates/contracts/runtime-ports/src/lib.rs',
    reason: 'runtime-ports capability features must gate their owned source modules and exports',
    patterns: [
      { regex: /#\[cfg\(feature = "agent-api"\)\]\r?\nmod agent_api;/, message: 'agent-api must gate its source module' },
      { regex: /#\[cfg\(feature = "agent-api"\)\]\r?\npub use agent_api::\*;/, message: 'agent-api must gate its public exports' },
      { regex: /#\[cfg\(feature = "plugin-runtime"\)\]\r?\nmod plugin;/, message: 'plugin-runtime must gate its source module' },
      { regex: /#\[cfg\(feature = "plugin-runtime"\)\]\r?\npub use plugin::\{/, message: 'plugin-runtime must gate its public exports' },
      { regex: /#\[cfg\(feature = "hook-function-runtime"\)\]\r?\nmod hook_function;/, message: 'hook-function-runtime must gate its source module' },
      { regex: /#\[cfg\(feature = "hook-function-runtime"\)\]\r?\npub use hook_function::\*;/, message: 'hook-function-runtime must gate its public exports' },
      { regex: /#\[cfg\(feature = "product-search"\)\]\r?\nmod product_search;/, message: 'product-search must gate its source module' },
      { regex: /#\[cfg\(feature = "product-search"\)\]\r?\npub use product_search::ProductSearchPort;/, message: 'product-search must gate its public exports' },
      { regex: /#\[cfg\(feature = "script-tool-runtime"\)\]\r?\nmod script_tool;/, message: 'script-tool-runtime must gate its source module' },
      { regex: /#\[cfg\(feature = "script-tool-runtime"\)\]\r?\npub use script_tool::\{/, message: 'script-tool-runtime must gate its public exports' },
      { regex: /#\[cfg\(feature = "workspace-ports"\)\]\r?\nmod workspace_ports;/, message: 'workspace-ports must gate its source module' },
      { regex: /#\[cfg\(feature = "workspace-ports"\)\]\r?\npub use workspace_ports::\*;/, message: 'workspace-ports must gate its public exports' },
      { regex: /#\[cfg\(feature = "terminal-port"\)\]\r?\nmod terminal_port;/, message: 'terminal-port must gate its source module' },
      { regex: /#\[cfg\(feature = "terminal-port"\)\]\r?\npub use terminal_port::\*;/, message: 'terminal-port must gate its public exports' },
      { regex: /#\[cfg\(feature = "remote-exec-port"\)\]\r?\nmod remote_exec_port;/, message: 'remote-exec-port must gate its source module' },
      { regex: /#\[cfg\(feature = "remote-exec-port"\)\]\r?\npub use remote_exec_port::\*;/, message: 'remote-exec-port must gate its public exports' },
      { regex: /#\[cfg\(feature = "remote-workspace-ports"\)\]\r?\nmod remote_workspace_ports;/, message: 'remote-workspace-ports must gate its source module' },
      { regex: /#\[cfg\(feature = "remote-workspace-ports"\)\]\r?\npub use remote_workspace_ports::\*;/, message: 'remote-workspace-ports must gate its public exports' },
      { regex: /#\[cfg\(feature = "runtime-event-port"\)\]\r?\nmod runtime_event_port;/, message: 'runtime-event-port must gate its source module' },
      { regex: /#\[cfg\(feature = "runtime-event-port"\)\]\r?\npub use runtime_event_port::\*;/, message: 'runtime-event-port must gate its public exports' },
      { regex: /#\[cfg\(feature = "git-port"\)\]\r?\nmod git_port;/, message: 'git-port must gate its source module' },
      { regex: /#\[cfg\(feature = "git-port"\)\]\r?\npub use git_port::\*;/, message: 'git-port must gate its public exports' },
      { regex: /#\[cfg\(feature = "tool-runtime-handles"\)\]\r?\nmod tool_runtime_handles;/, message: 'tool-runtime-handles must gate its source module' },
      { regex: /#\[cfg\(feature = "tool-runtime-handles"\)\]\r?\npub use tool_runtime_handles::\*;/, message: 'tool-runtime-handles must gate its public exports' },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/lib.rs',
    reason: 'tool-contract capability features must gate their owned source modules and exports',
    patterns: [
      { regex: /#\[cfg\(feature = "acp-bridge"\)\]\r?\npub mod acp_tool_bridge;/, message: 'acp-bridge must gate its source module' },
      { regex: /#\[cfg\(feature = "acp-bridge"\)\]\r?\npub use acp_tool_bridge::\{/, message: 'acp-bridge must gate its public exports' },
      { regex: /#\[cfg\(feature = "mcp-bridge"\)\]\r?\npub mod mcp_tool_bridge;/, message: 'mcp-bridge must gate its source module' },
      { regex: /#\[cfg\(feature = "mcp-bridge"\)\]\r?\npub use mcp_tool_bridge::\{/, message: 'mcp-bridge must gate its public exports' },
      { regex: /#\[cfg\(feature = "computer-use-contract"\)\]\r?\npub mod computer_use;/, message: 'computer-use-contract must gate its source module' },
      { regex: /#\[cfg\(feature = "element-token"\)\]\r?\npub mod element_token;/, message: 'element-token must gate its source module' },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/subagent_runtime/mod.rs',
    reason:
      'core subagent runtime must preserve legacy import path while runtime-ports owns portable subagent contracts',
    patterns: [
      {
        regex: /pub\(crate\) use openbitfun_runtime_ports::\{DelegationPolicy, SubagentContextMode\};/,
        message: 'missing core compatibility re-export for subagent runtime contracts',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/framework.rs',
    reason:
      'agent-tools may own pure and generic prompt-visible tool contracts and provider-neutral execution gate policy without owning product registry or concrete execution',
    patterns: [
      {
        regex: /\bpub const GET_TOOL_SPEC_TOOL_NAME\b/,
        message: 'missing shared GetToolSpec manifest name contract',
      },
      {
        regex: /\bpub enum ToolExposure\b/,
        message: 'missing lightweight tool exposure contract',
      },
      {
        regex: /\bpub struct ToolManifestPolicyTool\b/,
        message: 'missing pure tool manifest policy input contract',
      },
      {
        regex: /\bpub fn resolve_tool_manifest_policy\b/,
        message: 'missing pure tool manifest policy resolver',
      },
      {
        regex: /\bfn default_exposure\b/,
        message: 'missing generic tool exposure contract',
      },
      {
        regex: /\bpub fn build_tool_manifest_policy_tools\b/,
        message: 'missing registry snapshot to manifest policy input helper',
      },
      {
        regex: /\bpub enum PromptVisibleToolManifestItem\b/,
        message: 'missing prompt-visible manifest item contract',
      },
      {
        regex: /\bpub fn build_prompt_visible_tool_manifest_definitions\b/,
        message: 'missing prompt-visible manifest definition builder',
      },
      {
        regex: /\bpub trait ContextualToolManifestItem\b/,
        message: 'missing generic contextual manifest item adapter contract',
      },
      {
        regex: /\bpub trait ToolCatalogSnapshotProvider\b/,
        message: 'missing generic tool catalog snapshot provider contract',
      },
      {
        regex: /\bpub trait GetToolSpecCatalogProvider\b/,
        message: 'missing generic GetToolSpec catalog provider contract',
      },
      {
        regex: /\bpub struct ContextualVisibleTools\b/,
        message: 'missing generic contextual visible-tools result contract',
      },
      {
        regex: /\bpub struct ContextualToolManifest\b/,
        message: 'missing generic contextual tool manifest result contract',
      },
      {
        regex: /\bpub async fn resolve_contextual_visible_tools\b/,
        message: 'missing generic contextual visible-tools resolver',
      },
      {
        regex: /\bpub async fn resolve_contextual_tool_manifest\b/,
        message: 'missing generic contextual tool manifest resolver',
      },
      {
        regex: /\bpub async fn resolve_contextual_visible_tools_from_provider\b/,
        message: 'missing provider-backed contextual visible-tools resolver',
      },
      {
        regex: /\bpub async fn resolve_contextual_tool_manifest_from_provider\b/,
        message: 'missing provider-backed contextual manifest resolver',
      },
      {
        regex: /\bpub async fn build_get_tool_spec_catalog_description_from_provider\b/,
        message: 'missing provider-backed GetToolSpec catalog description builder',
      },
      {
        regex: /\bpub async fn resolve_get_tool_spec_detail_from_provider\b/,
        message: 'missing provider-backed GetToolSpec detail resolver',
      },
      {
        regex: /\bpub fn build_get_tool_spec_description\b/,
        message: 'missing pure GetToolSpec prompt description contract',
      },
      {
        regex: /\bpub struct GetToolSpecDeferredToolSummary\b/,
        message: 'missing pure GetToolSpec deferred catalog summary',
      },
      {
        regex: /\bpub struct GetToolSpecDetail\b/,
        message: 'missing pure GetToolSpec detail contract',
      },
      {
        regex: /\bpub fn summarize_get_tool_spec_deferred_tools\b/,
        message: 'missing pure GetToolSpec deferred summary helper',
      },
      {
        regex: /\bpub async fn resolve_get_tool_spec_detail\b/,
        message: 'missing generic GetToolSpec detail resolver',
      },
      {
        regex: /\bpub fn build_get_tool_spec_catalog_description\b/,
        message: 'missing pure GetToolSpec catalog description builder',
      },
      {
        regex: /\bpub fn get_tool_spec_input_schema\b/,
        message: 'missing pure GetToolSpec input schema contract',
      },
      {
        regex: /\bpub fn get_tool_spec_short_description\b/,
        message: 'missing pure GetToolSpec short description contract',
      },
      {
        regex: /\bpub fn render_get_tool_spec_tool_use_message\b/,
        message: 'missing pure GetToolSpec tool-use message renderer',
      },
      {
        regex: /\bpub fn get_tool_spec_is_readonly\b/,
        message: 'missing pure GetToolSpec readonly metadata contract',
      },
      {
        regex: /\bpub fn get_tool_spec_is_concurrency_safe\b/,
        message: 'missing pure GetToolSpec concurrency metadata contract',
      },
      {
        regex: /\bpub fn validate_get_tool_spec_input\b/,
        message: 'missing pure GetToolSpec input validation contract',
      },
      {
        regex: /\bpub fn build_get_tool_spec_assistant_detail\b/,
        message: 'missing pure GetToolSpec assistant detail rendering contract',
      },
      {
        regex: /\bpub fn build_get_tool_spec_duplicate_load_result\b/,
        message: 'missing pure GetToolSpec duplicate-load result assembly contract',
      },
      {
        regex: /\bpub fn build_get_tool_spec_detail_result\b/,
        message: 'missing pure GetToolSpec detail result assembly contract',
      },
      {
        regex: /\bpub enum GetToolSpecExecutionPlan\b/,
        message: 'missing pure GetToolSpec execution plan contract',
      },
      {
        regex: /\bpub enum GetToolSpecExecutionError\b/,
        message: 'missing pure GetToolSpec execution error contract',
      },
      {
        regex: /\bpub fn resolve_get_tool_spec_execution_plan\b/,
        message: 'missing pure GetToolSpec execution plan resolver',
      },
      {
        regex: /\bpub async fn resolve_get_tool_spec_execution_result_from_provider\b/,
        message: 'missing provider-backed GetToolSpec execution result resolver',
      },
      {
        regex: /\bpub struct GetToolSpecRuntime\b/,
        message: 'missing provider-backed GetToolSpec runtime facade',
      },
      {
        regex: /\bpub async fn call_results\b/,
        message: 'missing provider-backed GetToolSpec Tool-result vector adapter facade',
      },
      {
        regex: /\bpub struct GetToolSpecLoadObservation\b/,
        message: 'missing pure GetToolSpec load observation contract',
      },
      {
        regex: /\bpub fn collect_loaded_deferred_tool_specs\b/,
        message: 'missing pure deferred-tool load collection contract',
      },
      {
        regex: /\bpub enum DeferredToolUsageError\b/,
        message: 'missing deferred-tool execution gate error contract',
      },
      {
        regex: /\bpub enum ToolExecutionAccessError\b/,
        message: 'missing tool execution allowed-list gate error contract',
      },
      {
        regex: /\bpub fn validate_tool_allowed_by_list\b/,
        message: 'missing tool execution allowed-list gate policy',
      },
      {
        regex: /\bpub fn validate_deferred_tool_usage\b/,
        message: 'missing deferred-tool execution gate policy',
      },
      {
        regex: /\bpub fn is_tool_path_allowed_by_resolved_roots\b/,
        message: 'missing provider-neutral path policy root matcher',
      },
      {
        regex: /\bpub fn build_tool_path_policy_denial_message\b/,
        message: 'missing provider-neutral path policy denial message',
      },
      {
        regex: /\bpub fn resolve_tool_path_with_context\b/,
        message: 'missing provider-neutral tool path resolution owner',
      },
      {
        regex: /\bpub fn tool_path_is_effectively_absolute\b/,
        message: 'missing provider-neutral tool path absolute check',
      },
      {
        regex: /\bpub fn build_tool_runtime_artifact_reference\b/,
        message: 'missing provider-neutral runtime artifact reference builder',
      },
      {
        regex: /\bpub fn build_tool_session_runtime_artifact_reference\b/,
        message: 'missing provider-neutral session runtime artifact reference builder',
      },
      {
        regex: /\bpub fn sort_tool_manifest_definitions\b/,
        message: 'missing prompt-visible manifest ordering helper',
      },
      {
        regex: /\bpub struct StaticToolProviderGroup\b/,
        message: 'missing generic static provider group container',
      },
      {
        regex: /\bpub trait StaticToolProviderPlan\b/,
        message: 'missing provider-neutral static tool provider plan contract',
      },
      {
        regex: /\bpub trait StaticToolProviderFactory\b/,
        message: 'missing provider-neutral static tool factory contract',
      },
      {
        regex: /\bpub enum StaticToolMaterializationError\b/,
        message: 'missing provider-neutral static tool materialization error',
      },
      {
        regex: /\bpub fn materialize_static_tool_provider_groups\b/,
        message: 'missing provider-neutral static tool materializer',
      },
      {
        regex: /\bpub struct ToolRuntimeAssembly\b/,
        message: 'missing generic tool runtime assembly owner',
      },
      {
        regex: /\bpub type ToolDecoratorRef\b/,
        message: 'missing generic tool decorator reference contract',
      },
      {
        regex: /\bpub trait SnapshotToolWrapper\b/,
        message: 'missing generic snapshot wrapper port',
      },
      {
        regex: /\bpub struct SnapshotToolDecorator\b/,
        message: 'missing generic snapshot decorator adapter',
      },
      {
        regex: /\bcreate_registry_from_static_providers\b/,
        message: 'missing generic static-provider runtime assembly helper',
      },
      {
        regex: /\bcreate_registry_from_static_provider_plans\b/,
        message: 'missing generic static-provider plan-to-registry assembly helper',
      },
      {
        regex: /\bpub fn is_tool_deferred\b/,
        message: 'missing generic deferred-tool registry query',
      },
      {
        regex: /\bpub fn get_deferred_tool_names\b/,
        message: 'missing generic deferred-tool registry catalog query',
      },
      {
        regex: /\bpub async fn resolve_readonly_enabled_tools\b/,
        message: 'missing generic readonly enabled tool filter',
      },
      {
        regex: /\bpub struct ToolCatalogRuntime\b/,
        message: 'missing provider-backed tool catalog runtime facade',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/mcp_tool_bridge.rs',
    reason:
      'agent-tools owns MCP tool bridge naming, descriptor, validation, presentation, and ToolResult shape contracts without depending on MCP transport concrete',
    patterns: [
      {
        regex: /\bpub fn build_mcp_tool_bridge_name\b/,
        message: 'missing MCP tool bridge prompt-visible name builder',
      },
      {
        regex: /\bpub struct McpToolBridgeDefinition\b/,
        message: 'missing MCP tool bridge descriptor contract',
      },
      {
        regex: /\bpub struct McpToolBridgeBehaviorHints\b/,
        message: 'missing MCP tool bridge behavior hint contract',
      },
      {
        regex: /\bpub fn build_mcp_tool_bridge_definition\b/,
        message: 'missing MCP tool bridge descriptor builder',
      },
      {
        regex: /\bpub fn mcp_tool_bridge_dynamic_tool_info\b/,
        message: 'missing MCP dynamic tool info bridge',
      },
      {
        regex: /\bpub fn validate_mcp_tool_bridge_input\b/,
        message: 'missing MCP tool bridge input validation contract',
      },
      {
        regex: /\bpub fn render_mcp_tool_bridge_use_message\b/,
        message: 'missing MCP tool bridge use-message renderer',
      },
      {
        regex: /\bpub fn render_mcp_tool_bridge_rejected_message\b/,
        message: 'missing MCP tool bridge rejection-message renderer',
      },
      {
        regex: /\bpub fn render_mcp_tool_bridge_result_message\b/,
        message: 'missing MCP tool bridge result-message renderer',
      },
      {
        regex: /\bpub fn build_mcp_tool_bridge_result\b/,
        message: 'missing MCP tool bridge ToolResult builder',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/acp_tool_bridge.rs',
    reason:
      'agent-tools owns ACP external-agent tool bridge naming, schema, validation, presentation, and ToolResult contracts without depending on ACP protocol concrete',
    patterns: [
      {
        regex: /\bpub fn build_acp_external_agent_tool_name\b/,
        message: 'missing ACP external-agent prompt-visible name builder',
      },
      {
        regex: /\bpub struct AcpExternalAgentToolDefinition\b/,
        message: 'missing ACP external-agent tool definition contract',
      },
      {
        regex: /\bpub fn build_acp_external_agent_tool_definition\b/,
        message: 'missing ACP external-agent tool definition builder',
      },
      {
        regex: /\bpub fn acp_external_agent_tool_input_schema\b/,
        message: 'missing ACP external-agent input schema contract',
      },
      {
        regex: /\bpub fn validate_acp_external_agent_tool_input\b/,
        message: 'missing ACP external-agent input validation contract',
      },
      {
        regex: /\bpub fn render_acp_external_agent_use_message\b/,
        message: 'missing ACP external-agent use-message renderer',
      },
      {
        regex: /\bpub fn render_acp_external_agent_rejected_message\b/,
        message: 'missing ACP external-agent rejection-message renderer',
      },
      {
        regex: /\bpub fn render_acp_external_agent_result_message\b/,
        message: 'missing ACP external-agent result-message renderer',
      },
      {
        regex: /\bpub fn render_acp_external_agent_result_for_assistant\b/,
        message: 'missing ACP external-agent assistant-result renderer',
      },
      {
        regex: /\bpub fn build_acp_external_agent_tool_result\b/,
        message: 'missing ACP external-agent ToolResult builder',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/file_guidance.rs',
    reason: 'agent-tools owns provider-neutral file tool guidance marker contracts',
    patterns: [
      {
        regex: /\bpub const FILE_TOOL_GUIDANCE_PREFIX\b/,
        message: 'missing file tool guidance marker prefix',
      },
      {
        regex: /\bpub fn file_tool_guidance_message\b/,
        message: 'missing file tool guidance message helper',
      },
      {
        regex: /\bpub fn is_file_tool_guidance_message\b/,
        message: 'missing file tool guidance classifier',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/tool_result_storage.rs',
    reason:
      'agent-tools owns pure oversized tool-result storage policy and rendering without session IO',
    patterns: [
      {
        regex: /\bpub struct ToolResultStoragePolicy\b/,
        message: 'missing provider-neutral tool result storage policy',
      },
      {
        regex: /\bpub struct PersistedToolOutput\b/,
        message: 'missing persisted tool output render contract',
      },
      {
        regex: /\bpub struct ToolResultPersistenceCandidate\b/,
        message: 'missing provider-neutral persistence candidate contract',
      },
      {
        regex: /\bpub fn select_tool_result_indices_for_persistence\b/,
        message: 'missing round-budget persistence candidate selector',
      },
      {
        regex: /\bpub fn sanitize_tool_result_file_component\b/,
        message: 'missing tool-result file component sanitizer',
      },
      {
        regex: /\bpub fn generate_tool_result_preview\b/,
        message: 'missing tool-result preview generator',
      },
      {
        regex: /\bpub fn count_tool_result_lines\b/,
        message: 'missing tool-result line counter',
      },
      {
        regex: /\bpub fn build_persisted_tool_output_message\b/,
        message: 'missing persisted-output message renderer',
      },
      {
        regex: /\bpub fn tool_result_is_persisted_output\b/,
        message: 'missing persisted-output classifier',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/tool_execution_presentation.rs',
    reason:
      'agent-tools owns provider-neutral tool execution result and error presentation helpers',
    patterns: [
      {
        regex: /\bpub const TOOL_ERROR_ARGUMENTS_PREVIEW_BYTES\b/,
        message: 'missing tool error argument preview limit contract',
      },
      {
        regex: /\bpub const USER_STEERING_INTERRUPTED_MESSAGE\b/,
        message: 'missing steering-interrupted assistant message contract',
      },
      {
        regex: /\bpub struct ToolExecutionErrorPresentation\b/,
        message: 'missing tool execution error presentation DTO',
      },
      {
        regex: /\bpub fn render_tool_result_for_assistant\b/,
        message: 'missing tool result assistant rendering helper',
      },
      {
        regex: /\bpub fn truncate_tool_arguments_preview\b/,
        message: 'missing structured tool argument preview helper',
      },
      {
        regex: /\bpub fn truncate_raw_tool_arguments_preview\b/,
        message: 'missing raw tool argument preview helper',
      },
      {
        regex: /\bpub fn build_tool_execution_error_presentation\b/,
        message: 'missing tool execution error presentation helper',
      },
      {
        regex: /\bpub fn build_user_steering_interrupted_presentation\b/,
        message: 'missing steering-interrupted presentation helper',
      },
      {
        regex: /\bpub fn build_invalid_tool_call_error_message\b/,
        message: 'missing invalid tool call error message helper',
      },
      {
        regex: /\bpub fn is_write_like_tool_name\b/,
        message: 'missing write-like tool classification helper',
      },
      {
        regex: /\bpub fn build_normal_tool_json_repair_notice\b/,
        message: 'missing normal-completion JSON repair notice helper',
      },
      {
        regex: /\bpub fn build_write_tail_closure_notice\b/,
        message: 'missing Write-tail closure notice helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/coordinator.rs',
    reason:
      'core must keep current coordinator port adapters and attachment guard until remote runtime migration is reviewed',
    patterns: [
      {
        regex: /impl openbitfun_runtime_ports::AgentSubmissionPort for ConversationCoordinator/,
        message: 'missing agent submission port adapter',
      },
      {
        regex: /impl openbitfun_runtime_ports::SessionTranscriptReader for ConversationCoordinator/,
        message: 'missing session transcript reader adapter',
      },
      {
        regex: /impl openbitfun_runtime_ports::AgentTurnCancellationPort for ConversationCoordinator/,
        message: 'missing turn cancellation port adapter',
      },
      {
        regex: /impl openbitfun_runtime_ports::AgentSessionManagementPort for ConversationCoordinator/,
        message: 'missing session management port adapter',
      },
      {
        regex: /\bruntime_session_summary\b/,
        message: 'missing session summary adapter helper',
      },
      {
        regex: /\bAgentSessionSummary\b/,
        message: 'missing runtime session summary contract binding',
      },
      {
        regex: /impl openbitfun_runtime_ports::RemoteControlStatePort for ConversationCoordinator/,
        message: 'missing remote control state port adapter',
      },
      {
        regex: /agent submission port does not yet accept generic attachments/,
        message: 'missing generic attachment guard on agent submission port',
      },
      {
        regex: /pub use openbitfun_runtime_ports::DialogTriggerSource;/,
        message: 'missing dialog trigger source compatibility re-export',
      },
      {
        regex: /openbitfun_agent_runtime::subagent_task::subagent_task_completion_result/,
        message: 'missing delegated command provider-neutral Task result formatting',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
    reason:
      'core scheduler must preserve legacy submission policy import path while runtime-ports owns portable dialog policy contracts',
    patterns: [
      {
        regex:
          /pub use openbitfun_runtime_ports::\{[\s\S]*AgentSessionReplyRoute[\s\S]*DialogQueuePriority[\s\S]*DialogSteerOutcome[\s\S]*DialogSubmissionPolicy[\s\S]*DialogSubmitOutcome[\s\S]*\};/,
        message: 'missing dialog submission policy compatibility re-export',
      },
      {
        regex:
          /use openbitfun_runtime_ports::\{(?=[\s\S]*DialogSessionStateFact)(?=[\s\S]*DialogSubmitQueueAction)(?=[\s\S]*DialogSubmitQueueFacts)(?=[\s\S]*resolve_dialog_submit_queue_action)[\s\S]*\};/,
        message: 'missing dialog scheduler decision contract import',
      },
      {
        regex:
          /use openbitfun_agent_runtime::scheduler::\{(?=[\s\S]*ActiveDialogTurn)(?=[\s\S]*ActiveDialogTurnStore)(?=[\s\S]*AgentSessionReplyAction)(?=[\s\S]*AgentSessionReplyPlan)(?=[\s\S]*BackgroundDeliveryAction)(?=[\s\S]*BackgroundDeliveryFacts)(?=[\s\S]*BackgroundInjectionKind)(?=[\s\S]*DialogReplySuppressionSet)(?=[\s\S]*DialogSteeringAction)(?=[\s\S]*DialogTurnQueue)(?=[\s\S]*SessionAbortFlags)(?=[\s\S]*resolve_agent_session_reply_action)(?=[\s\S]*resolve_background_delivery_action)(?=[\s\S]*resolve_background_delivery_injection)(?=[\s\S]*resolve_dialog_steering_action)[\s\S]*\};/,
        message: 'missing agent-runtime scheduler owner imports',
      },
      {
        regex: /\bBackgroundResult\b/,
        message: 'missing background-result injection owner delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/round_preempt.rs',
    reason:
      'core round-boundary runtime must preserve legacy import paths while runtime-ports owns portable contracts and agent-runtime owns injection state',
    patterns: [
      {
        regex:
          /pub use openbitfun_agent_runtime::scheduler::\{[\s\S]*DialogRoundInjectionInterrupt[\s\S]*SessionRoundInjectionBuffer[\s\S]*\};/,
        message: 'missing agent-runtime round-boundary state compatibility re-export',
      },
      {
        regex:
          /pub use openbitfun_runtime_ports::\{[\s\S]*DialogRoundInjectionSource[\s\S]*RoundInjection[\s\S]*RoundInjectionKind[\s\S]*RoundInjectionTarget[\s\S]*\};/,
        message: 'missing round injection compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/goal_mode/mod.rs',
    reason:
      'core goal mode must preserve legacy import paths while runtime-ports owns portable contracts and agent-runtime owns runtime decisions',
    patterns: [
      {
        regex:
          /pub use openbitfun_runtime_ports::\{[\s\S]*SetThreadGoalResult[\s\S]*ThreadGoal[\s\S]*ThreadGoalContinuationPlan[\s\S]*ThreadGoalStatus[\s\S]*ThreadGoalToolResponse[\s\S]*GOAL_MODE_METADATA_KEY[\s\S]*MAX_CONTEXT_SUMMARY_CHARS[\s\S]*MAX_THREAD_GOAL_OBJECTIVE_CHARS[\s\S]*THREAD_GOAL_METADATA_KEY[\s\S]*\};/,
        message: 'missing thread goal compatibility re-export',
      },
      {
        regex:
          /pub use openbitfun_agent_runtime::thread_goal::\{[\s\S]*build_thread_goal_continuation_plan[\s\S]*goal_tool_response[\s\S]*should_skip_goal_for_turn[\s\S]*ThreadGoalRuntime[\s\S]*\};/,
        message: 'missing thread goal runtime owner compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/core/message.rs',
    reason:
      'core message model must preserve legacy compression contract import path while runtime-ports owns portable compaction facts',
    patterns: [
      {
        regex: /pub use openbitfun_runtime_ports::\{CompressionContract, CompressionContractItem\};/,
        message: 'missing compression contract compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace/manager.rs',
    reason:
      'core workspace manager must preserve legacy related-path import path while runtime-ports owns portable request-context facts',
    patterns: [
      {
        regex: /pub use openbitfun_runtime_ports::RelatedPath;/,
        message: 'missing related path compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service_agent_runtime.rs',
    reason:
      'core service/agent runtime owner must centralize concrete remote-connect and agent runtime port bindings without moving runtime behavior',
    patterns: [
      {
        regex: /\bpub\(crate\) struct CoreServiceAgentRuntime\b/,
        message: 'missing core service/agent runtime owner type',
      },
      {
        regex: /\bfn remote_dialog_host\b/,
        message: 'missing remote dialog host owner factory',
      },
      {
        regex: /\bfn remote_cancel_host\b/,
        message: 'missing remote cancel host owner factory',
      },
      {
        regex: /\bfn remote_image_context\b/,
        message: 'missing remote image context owner adapter',
      },
      {
        regex: /\bfn load_remote_model_catalog\b/,
        message: 'missing remote model catalog owner adapter',
      },
      {
        regex: /\bRemoteModelCatalogFacts\b/,
        message: 'missing remote model catalog fact projection',
      },
      {
        regex: /\bRemoteModelCapabilityFact\b/,
        message: 'missing remote model capability fact projection',
      },
      {
        regex: /\bproject_model_reasoning_catalog\b/,
        message: 'missing remote reasoning preset catalog projection',
      },
      {
        regex: /\bbuild_remote_model_catalog\b/,
        message: 'missing remote model catalog assembly delegation',
      },
      {
        regex: /\bfn update_remote_session_model\b/,
        message: 'missing remote session model update owner adapter',
      },
      {
        regex: /\bnormalize_remote_session_model_id\(\s*session\.config\.model_id\.as_deref\(\)\s*\)/,
        message: 'missing remote session model id owner delegation',
      },
      {
        regex: /\bfn normalize_remote_model_selection\b/,
        message: 'missing remote model selection normalization regression hook',
      },
      {
        regex: /\bnormalize_remote_model_selection_contract\b/,
        message: 'missing remote model selection owner delegation',
      },
      {
        regex: /\bfn remote_chat_messages_from_turns\b/,
        message: 'missing remote chat history conversion owner adapter',
      },
      {
        regex: /\bRemoteDialogSchedulerOutcomeFact\b/,
        message: 'missing remote dialog scheduler outcome fact projection',
      },
      {
        regex: /\bremote_dialog_submit_outcome_from_scheduler\b/,
        message: 'missing remote dialog submit outcome assembly delegation',
      },
      {
        regex: /\bRemoteChatHistoryTurn\b/,
        message: 'missing remote chat history owner DTO projection',
      },
      {
        regex: /\bbuild_remote_chat_messages\b/,
        message: 'missing remote chat history assembly delegation',
      },
      {
        regex:
          /\bproject_remote_chat_user\(\s*turn\.user_message\.metadata\.as_ref\(\),\s*&prompt_visible_content,\s*read_image_pixels,?\s*\)/,
        message: 'missing remote chat user projection owner delegation',
      },
      {
        regex: /\bfn load_remote_chat_messages\b/,
        message: 'missing remote chat history persistence owner adapter',
      },
      {
        regex: /\bfn agent_runtime\b/,
        message: 'missing agent runtime owner binding',
      },
      {
        regex: /\bfn agent_runtime_with_dialog_turns\b/,
        message: 'missing agent runtime dialog lifecycle owner binding',
      },
      {
        regex: /\bfn agent_runtime_with_lifecycle_delivery\b/,
        message: 'missing agent runtime lifecycle delivery owner binding',
      },
      {
        regex: /\bfn agent_runtime_with_scheduler_ports\b/,
        message: 'missing scheduler lifecycle runtime port binding',
      },
      {
        regex: /\bfn global_agent_runtime_with_lifecycle_delivery\b/,
        message: 'missing global lifecycle delivery runtime binding',
      },
      {
        regex: /\bwith_lifecycle_delivery_port\b/,
        message: 'missing lifecycle delivery builder registration',
      },
      {
        regex: /\bagent_input_attachment_from_image_context\b/,
        message: 'missing remote image to lifecycle attachment adapter',
      },
      {
        regex: /\bAgentDialogTurnRequest\b/,
        message: 'missing dialog lifecycle request binding',
      },
      {
        regex: /\bsubmit_dialog_turn\b/,
        message: 'missing dialog lifecycle submit delegation',
      },
      {
        regex: /\bAgentRuntimeBuilder\b/,
        message: 'missing agent runtime builder binding',
      },
      {
        regex: /\bfn remote_control_state_port\b/,
        message: 'missing remote control state port owner binding',
      },
      {
        regex: /\bCoreRemoteDialogRuntimeHost\b/,
        message: 'missing core remote dialog host binding',
      },
      {
        regex: /\bCoreRemoteCancelRuntimeHost\b/,
        message: 'missing core remote cancel host binding',
      },
      {
        regex: /pub\(crate\) struct CoreRemoteCancelRuntimeHost\s*\{[\s\S]*\bruntime:\s*AgentRuntime\b/,
        message: 'missing remote cancel host runtime field',
      },
      {
        regex: /\bCoreServiceAgentRuntime::agent_runtime_with_scheduler_ports\b/,
        message: 'missing remote cancel scheduler-backed runtime binding',
      },
      {
        regex: /\bCoreRemoteWorkspaceFileRuntimeHost\b/,
        message: 'missing core remote workspace file host binding',
      },
      {
        regex: /\bCoreRemoteSessionTrackerHost\b/,
        message: 'missing core remote session tracker host binding',
      },
      {
        regex: /\bCoreRemoteWorkspaceRuntimeHost\b/,
        message: 'missing core remote workspace runtime host binding',
      },
      {
        regex: /\bCoreRemoteSessionRuntimeHost\b/,
        message: 'missing core remote session runtime host binding',
      },
      {
        regex: /pub\(crate\) struct CoreRemoteSessionRuntimeHost\s*\{[\s\S]*\bruntime:\s*AgentRuntime\b/,
        message: 'missing remote session host runtime field',
      },
      {
        regex: /\bCoreRemotePollRuntimeHost\b/,
        message: 'missing core remote poll runtime host binding',
      },
      {
        regex: /\bCoreRemoteInteractionRuntimeHost\b/,
        message: 'missing core remote interaction runtime host binding',
      },
      {
        regex: /\bRemoteExecutionDispatcher\b/,
        message: 'missing remote execution dispatcher binding',
      },
      {
        regex: /\bimpl RemoteDialogRuntimeHost for CoreRemoteDialogRuntimeHost\b/,
        message: 'missing remote dialog host adapter implementation in runtime owner',
      },
      {
        regex: /\bimpl RemoteCancelRuntimeHost for CoreRemoteCancelRuntimeHost\b/,
        message: 'missing remote cancel host adapter implementation in runtime owner',
      },
      {
        regex: /\bimpl RemoteWorkspaceFileRuntimeHost for CoreRemoteWorkspaceFileRuntimeHost\b/,
        message: 'missing remote workspace file host adapter implementation in runtime owner',
      },
      {
        regex: /\bimpl RemoteSessionTrackerHost for CoreRemoteSessionTrackerHost\b/,
        message: 'missing remote tracker host adapter implementation in runtime owner',
      },
      {
        regex: /\bImageContextData\b/,
        message: 'missing core image context binding',
      },
      {
        regex: /\bagent_input_attachment_from_remote_image_context\(\s*remote_image_context_from_image_context\(/,
        message: 'missing remote image lifecycle attachment owner delegation',
      },
      {
        regex: /\bAgentSubmissionPort\b/,
        message: 'missing agent submission port binding',
      },
      {
        regex: /\bAgentDialogTurnPort\b/,
        message: 'missing agent dialog turn port binding',
      },
      {
        regex: /\bAgentTurnCancellationPort\b/,
        message: 'missing agent turn cancellation port contract guard',
      },
      {
        regex: /\bAgentSessionManagementPort\b/,
        message: 'missing agent session management port contract guard',
      },
      {
        regex: /\bwith_session_management_port\b/,
        message: 'missing agent session management runtime binding',
      },
      {
        regex: /\bRemoteControlStatePort\b/,
        message: 'missing remote control state port contract guard',
      },
      {
        regex: /\bSessionTranscriptReader\b/,
        message: 'missing session transcript reader contract guard',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_keeps_coordinator_port_contracts\b/,
        message: 'missing coordinator runtime port contract regression',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_normalizes_remote_session_model_ids\b/,
        message: 'missing remote session model id normalization regression',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_normalizes_remote_model_selection_aliases\b/,
        message: 'missing remote model selection alias regression',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_preserves_remote_chat_history_shape\b/,
        message: 'missing remote chat history conversion regression',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_preserves_in_progress_remote_assistant_history\b/,
        message: 'missing in-progress remote assistant history regression',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_maps_image_context_to_lifecycle_attachment\b/,
        message: 'missing remote image lifecycle attachment regression',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_keeps_scheduler_lifecycle_port_contracts\b/,
        message: 'missing scheduler lifecycle port contract regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_control_tool.rs',
    reason:
      'SessionControl must route session create, list, delete, workspace resolution, and cancellation through the service/agent runtime owner while preserving existing behavior',
    patterns: [
      {
        regex: /\bCoreServiceAgentRuntime::agent_runtime\b/,
        message: 'missing service/agent runtime owner routing',
      },
      {
        regex: /\bCoreServiceAgentRuntime::agent_runtime_with_scheduler_ports\b/,
        message: 'missing scheduler cancellation runtime owner routing',
      },
      {
        regex: /\bAgentSessionCreateRequest\b/,
        message: 'missing port-backed agent session creation request',
      },
      {
        regex: /\bAgentSessionListRequest\b/,
        message: 'missing port-backed agent session list request',
      },
      {
        regex: /\bAgentSessionDeleteRequest\b/,
        message: 'missing port-backed agent session delete request',
      },
      {
        regex: /\bAgentSessionWorkspaceRequest\b/,
        message: 'missing port-backed session workspace request',
      },
      {
        regex: /\blist_sessions\b/,
        message: 'missing port-backed agent session list call',
      },
      {
        regex: /\bdelete_session\b/,
        message: 'missing port-backed agent session delete call',
      },
      {
        regex: /\bresolve_session_workspace_binding\b/,
        message: 'missing port-backed session workspace binding resolution call',
      },
      {
        regex: /"createdBy"/,
        message: 'missing creator metadata propagation',
      },
      {
        regex: /\bAgentTurnCancellationRequest\b/,
        message: 'missing port-backed cancellation request',
      },
      {
        regex: /\brequester_session_id\b/,
        message: 'missing requester-aware cancellation propagation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/session_message_tool.rs',
    reason:
      'SessionMessage must create, resolve, validate, and submit target agent sessions through the service/agent runtime lifecycle owner',
    patterns: [
      {
        regex: /\bCoreServiceAgentRuntime::agent_runtime_with_dialog_turns\b/,
        message: 'missing service/agent runtime lifecycle owner routing',
      },
      {
        regex: /\bAgentSessionCreateRequest\b/,
        message: 'missing port-backed agent session creation request',
      },
      {
        regex: /\bAgentSessionListRequest\b/,
        message: 'missing port-backed target session list request',
      },
      {
        regex: /\bAgentSessionWorkspaceRequest\b/,
        message: 'missing port-backed target session workspace request',
      },
      {
        regex: /\blist_sessions\b/,
        message: 'missing port-backed target session list call',
      },
      {
        regex: /\bresolve_session_workspace_binding\b/,
        message: 'missing port-backed target session workspace binding resolution call',
      },
      {
        regex: /"createdBy"/,
        message: 'missing creator metadata propagation',
      },
      {
        regex: /\bAgentDialogTurnRequest\b/,
        message: 'missing port-backed dialog turn request',
      },
      {
        regex: /\bAgentDialogPrependedReminder\b/,
        message: 'missing portable prepended reminder request',
      },
      {
        regex: /\bsubmit_dialog_turn\b/,
        message: 'missing dialog lifecycle submission',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_connect.rs',
    reason:
      'services-integrations must own remote-connect wire/response assembly and preserve remote owner compatibility re-exports',
    patterns: [
      {
        regex: /\bpub mod device\b/,
        message: 'missing remote-connect device owner module',
      },
      {
        regex: /\bpub mod encryption\b/,
        message: 'missing remote-connect encryption owner module',
      },
      {
        regex: /\bpub mod pairing\b/,
        message: 'missing remote-connect pairing owner module',
      },
      {
        regex: /\bpub mod qr_generator\b/,
        message: 'missing remote-connect QR owner module',
      },
      {
        regex: /\bpub mod relay_client\b/,
        message: 'missing remote-connect relay client owner module',
      },
      {
        regex: /\bpub use device::DeviceIdentity\b/,
        message: 'missing remote-connect device compatibility export',
      },
      {
        regex: /\bpub use encryption::\{decrypt_from_base64, encrypt_to_base64, KeyPair\}/,
        message: 'missing remote-connect encryption compatibility export',
      },
      {
        regex: /pub use pairing::PairingState/,
        message: 'missing remote-connect bot pairing state export',
      },
      {
        regex: /\bpub use qr_generator::QrGenerator\b/,
        message: 'missing remote-connect QR compatibility export',
      },
      {
        regex: /pub use relay_client::\{[\s\S]*\bConnectionState\b[\s\S]*\bRelayClient\b[\s\S]*\bRelayEvent\b[\s\S]*\}/,
        message: 'missing shared account relay lifecycle export',
      },
      {
        regex: /\bpub struct RemoteSessionStateTracker\b/,
        message: 'missing remote session state tracker owner',
      },
      {
        regex: /\bpub enum TrackerEvent\b/,
        message: 'missing remote tracker event owner',
      },
      {
        regex: /\bpub trait RemoteSessionTrackerHost\b/,
        message: 'missing remote tracker host port',
      },
      {
        regex: /\bpub struct RemoteSessionTrackerRegistry\b/,
        message: 'missing remote tracker registry owner',
      },
      {
        regex: /\bpub fn make_slim_tool_params\b/,
        message: 'missing remote tool preview slimming helper',
      },
      {
        regex: /\bfn handle_agentic_event\b/,
        message: 'missing tracker event reducer',
      },
      {
        regex: /\bpub fn resolve_remote_agent_type\b/,
        message: 'missing remote agent type helper',
      },
      {
        regex: /\bpub struct RemoteImageContext\b/,
        message: 'missing portable remote image context contract',
      },
      {
        regex: /\bpub trait RemoteImageContextAdapter\b/,
        message: 'missing remote image context adapter contract',
      },
      {
        regex: /\bpub fn build_remote_image_contexts\b/,
        message: 'missing legacy remote image context builder',
      },
      {
        regex: /\bpub fn resolve_remote_execution_image_contexts\b/,
        message: 'missing remote image context preference helper',
      },
      {
        regex: /\bpub fn remote_session_restore_target\b/,
        message: 'missing remote restore-target helper',
      },
      {
        regex: /\bpub enum RemoteCancelDecision\b/,
        message: 'missing remote cancel decision contract',
      },
      {
        regex: /\bpub fn resolve_remote_cancel_decision\b/,
        message: 'missing remote cancel decision resolver',
      },
      {
        regex: /\bpub struct RemoteCancelTaskRequest\b/,
        message: 'missing remote cancel task request contract',
      },
      {
        regex: /\bpub trait RemoteCancelRuntimeHost\b/,
        message: 'missing remote cancel runtime host port',
      },
      {
        regex: /\bpub async fn cancel_remote_task\b/,
        message: 'missing remote cancel orchestration owner',
      },
      {
        regex: /\bpub trait RemoteDialogRuntimeHost\b/,
        message: 'missing remote dialog runtime host port',
      },
      {
        regex: /\bpub async fn submit_remote_dialog\b/,
        message: 'missing remote dialog orchestration owner',
      },
      {
        regex: /\bpub struct RemoteChatHistoryTurn\b/,
        message: 'missing remote chat history turn DTO',
      },
      {
        regex: /\bpub struct RemoteChatHistoryRound\b/,
        message: 'missing remote chat history round DTO',
      },
      {
        regex: /\bpub struct RemoteChatHistoryToolItem\b/,
        message: 'missing remote chat history tool item DTO',
      },
      {
        regex: /\bpub fn build_remote_chat_messages\b/,
        message: 'missing remote chat history assembly owner',
      },
      {
        regex: /\bRemoteChatUserProjection\b/,
        message: 'missing remote chat user projection compatibility export',
      },
      {
        regex: /\bproject_remote_chat_user\b/,
        message: 'missing remote chat user projection compatibility export',
      },
      {
        regex: /\bpub const REMOTE_FILE_MAX_READ_BYTES\b/,
        message: 'missing remote file max-read policy',
      },
      {
        regex: /\bpub const REMOTE_FILE_MAX_CHUNK_BYTES\b/,
        message: 'missing remote file chunk policy',
      },
      {
        regex: /\bpub fn resolve_remote_file_chunk_range\b/,
        message: 'missing remote file chunk range helper',
      },
      {
        regex: /\bpub fn remote_file_display_name\b/,
        message: 'missing remote file display-name fallback',
      },
      {
        regex: /\bpub fn resolve_remote_workspace_path\b/,
        message: 'missing remote workspace path resolver',
      },
      {
        regex: /\bpub fn detect_remote_mime_type\b/,
        message: 'missing remote MIME detector',
      },
      {
        regex: /\bpub async fn read_remote_workspace_file\b/,
        message: 'missing remote workspace full-file reader',
      },
      {
        regex: /\bpub async fn read_remote_workspace_file_chunk\b/,
        message: 'missing remote workspace chunk reader',
      },
      {
        regex: /\bpub async fn read_remote_workspace_file_info\b/,
        message: 'missing remote workspace file-info reader',
      },
      {
        regex: /\bRemoteWorkspaceFileRuntimeHost\b/,
        message: 'missing remote workspace file runtime host contract',
      },
      {
        regex: /\bRemoteWorkspaceRuntimeHost\b/,
        message: 'missing remote workspace runtime host contract',
      },
      {
        regex: /\bRemoteInitialSyncRuntimeHost\b/,
        message: 'missing remote initial-sync runtime host contract',
      },
      {
        regex: /\bRemoteSessionRuntimeHost\b/,
        message: 'missing remote session runtime host contract',
      },
      {
        regex: /\bRemotePollRuntimeHost\b/,
        message: 'missing remote poll runtime host contract',
      },
      {
        regex: /\bRemoteInteractionRuntimeHost\b/,
        message: 'missing remote interaction runtime host contract',
      },
      {
        regex: /\bpub async fn handle_remote_workspace_file_command\b/,
        message: 'missing remote workspace file command owner handler',
      },
      {
        regex: /\bpub async fn handle_remote_workspace_command\b/,
        message: 'missing remote workspace command owner handler',
      },
      {
        regex: /\bpub async fn generate_remote_initial_sync\b/,
        message: 'missing remote initial-sync owner handler',
      },
      {
        regex: /\bpub async fn handle_remote_session_command\b/,
        message: 'missing remote session command owner handler',
      },
      {
        regex: /\bpub async fn handle_remote_poll_command\b/,
        message: 'missing remote poll command owner handler',
      },
      {
        regex: /\bpub async fn handle_remote_interaction_command\b/,
        message: 'missing remote interaction command owner handler',
      },
      {
        regex: /\bpub trait RemoteCommandRuntimeHost\b/,
        message: 'missing remote command runtime host contract',
      },
      {
        regex: /\bpub async fn handle_remote_command\b/,
        message: 'missing remote command routing owner',
      },
      {
        regex: /\bpub fn remote_file_content_response\b/,
        message: 'missing remote file content response assembly helper',
      },
      {
        regex: /\bpub fn remote_file_chunk_response\b/,
        message: 'missing remote file chunk response assembly helper',
      },
      {
        regex: /\bpub fn remote_file_info_response\b/,
        message: 'missing remote file-info response assembly helper',
      },
      {
        regex: /\bpub fn remote_dialog_submit_response\b/,
        message: 'missing remote dialog response assembly helper',
      },
      {
        regex: /\bpub fn remote_task_cancel_response\b/,
        message: 'missing remote task cancel response assembly helper',
      },
      {
        regex: /\bpub fn remote_interaction_accepted_response\b/,
        message: 'missing remote interaction response assembly helper',
      },
      {
        regex: /\bpub fn remote_answer_question_response\b/,
        message: 'missing remote answer response assembly helper',
      },
      {
        regex: /\bRemoteWorkspaceFacts\b/,
        message: 'missing remote workspace response facts DTO',
      },
      {
        regex: /\bRemoteSessionMetadata\b/,
        message: 'missing remote session response metadata DTO',
      },
      {
        regex: /\bpub fn remote_workspace_info_response\b/,
        message: 'missing remote workspace-info response assembly helper',
      },
      {
        regex: /\bpub fn remote_recent_workspaces_response\b/,
        message: 'missing remote recent-workspaces response assembly helper',
      },
      {
        regex: /\bpub fn remote_assistant_list_response\b/,
        message: 'missing remote assistant-list response assembly helper',
      },
      {
        regex: /\bpub fn remote_session_info\b/,
        message: 'missing remote session response facts helper',
      },
      {
        regex: /\bpub fn remote_session_list_response\b/,
        message: 'missing remote session-list response assembly helper',
      },
      {
        regex: /\bpub fn remote_initial_sync_response\b/,
        message: 'missing remote initial-sync response assembly helper',
      },
      {
        regex: /\bpub fn remote_messages_response\b/,
        message: 'missing remote messages response assembly helper',
      },
      {
        regex: /\bpub struct RemoteDefaultModelsConfig\b/,
        message: 'missing remote model default DTO',
      },
      {
        regex: /\bpub struct RemoteModelConfig\b/,
        message: 'missing remote model DTO',
      },
      {
        regex: /\bpub struct RemoteModelCatalog\b/,
        message: 'missing remote model catalog DTO',
      },
      {
        regex: /\bpub enum RemoteModelCapabilityFact\b/,
        message: 'missing remote model capability owner fact',
      },
      {
        regex: /\bReasoningCatalogProjection\b/,
        message: 'missing remote reasoning preset catalog owner contract',
      },
      {
        regex: /\bpub struct RemoteModelFacts\b/,
        message: 'missing remote model owner facts',
      },
      {
        regex: /\bpub struct RemoteModelCatalogFacts\b/,
        message: 'missing remote model catalog owner facts',
      },
      {
        regex: /\bpub fn build_remote_model_catalog\b/,
        message: 'missing remote model catalog assembly owner',
      },
      {
        regex: /\bpub struct RemoteModelCatalogPollDelta\b/,
        message: 'missing remote model catalog poll delta',
      },
      {
        regex: /\bpub fn normalize_remote_session_model_id\b/,
        message: 'missing remote session model normalization policy',
      },
      {
        regex: /\bpub fn normalize_remote_model_selection\b/,
        message: 'missing remote model selection policy',
      },
      {
        regex: /\bpub fn remote_model_selection_needs_config\b/,
        message: 'missing remote model selection config-gate policy',
      },
      {
        regex: /\bpub enum RemoteCommand\b/,
        message: 'missing remote command wire contract',
      },
      {
        regex: /\bpub enum RemoteDialogSchedulerOutcomeFact\b/,
        message: 'missing remote dialog scheduler outcome fact',
      },
      {
        regex: /\bpub fn remote_dialog_submit_outcome_from_scheduler\b/,
        message: 'missing remote dialog submit outcome assembly owner',
      },
      {
        regex: /\bpub enum RemoteResponse\b/,
        message: 'missing remote response wire contract',
      },
      {
        regex: /\bpub fn should_send_remote_model_catalog\b/,
        message: 'missing remote model catalog poll policy',
      },
      {
        regex: /\bpub fn remote_model_catalog_poll_delta\b/,
        message: 'missing remote model catalog poll delta helper',
      },
      {
        regex: /\bpub fn remote_no_change_poll_response\b/,
        message: 'missing remote no-change poll response helper',
      },
      {
        regex: /\bpub fn remote_snapshot_poll_response\b/,
        message: 'missing remote snapshot poll response helper',
      },
      {
        regex: /\bpub fn remote_persisted_poll_response\b/,
        message: 'missing remote persisted poll response helper',
      },
      {
        regex: /\bremote_workspace_handler_preserves_response_shapes\b/,
        message: 'missing remote workspace command handler regression',
      },
      {
        regex: /\bremote_session_handler_preserves_list_and_create_policy\b/,
        message: 'missing remote session command handler regression',
      },
      {
        regex: /\bremote_session_handler_removes_tracker_after_delete_success\b/,
        message: 'missing remote session delete tracker cleanup regression',
      },
      {
        regex: /\bremote_poll_handler_preserves_missing_workspace_error\b/,
        message: 'missing remote poll missing-workspace regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_connect/chat_projection.rs',
    reason:
      'remote chat projection helpers must own image metadata/display projection without leaking separate helper APIs',
    patterns: [
      {
        regex: /\bpub struct RemoteChatUserProjection\b/,
        message: 'missing remote chat user projection DTO',
      },
      {
        regex: /\bpub fn project_remote_chat_user\b/,
        message: 'missing remote chat user projection owner',
      },
      {
        regex: /\bfn remote_chat_user_images_from_metadata\b/,
        message: 'remote chat image metadata extraction must stay private to the projection owner',
      },
      {
        regex: /\bfn remote_chat_user_display_content\b/,
        message: 'remote chat display cleanup must stay private to the projection owner',
      },
      {
        regex: /\bfn compress_remote_chat_data_url_for_mobile\b/,
        message: 'remote chat thumbnail compression must stay private to the projection owner',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/tests/remote_connect_contracts.rs',
    reason: 'remote-connect owner crate must keep focused behavior contracts',
    patterns: [
      {
        regex: /\brelay_invitations_and_authentication_use_the_same_protocol_for_all_endpoints\b/,
        message: 'missing authenticated relay invitation owner contract test',
      },
      {
        regex: /\bremote_connect_lan_url_builder_lives_in_services_owner\b/,
        message: 'missing relay endpoint owner contract test',
      },
      {
        regex: /\bremote_connect_command_wire_shape_lives_in_owner_contract\b/,
        message: 'missing remote command wire contract test',
      },
      {
        regex: /\bremote_connect_response_wire_shape_lives_in_owner_contract\b/,
        message: 'missing remote response wire contract test',
      },
      {
        regex: /\bremote_connect_model_catalog_delta_preserves_poll_invalidation_policy\b/,
        message: 'missing remote model catalog delta contract test',
      },
      {
        regex: /\bremote_connect_model_catalog_builder_preserves_config_shape\b/,
        message: 'missing remote model catalog builder contract test',
      },
      {
        regex: /\bremote_connect_model_selection_policy_owns_alias_and_config_reference_rules\b/,
        message: 'missing remote model selection policy contract test',
      },
      {
        regex: /\bremote_connect_poll_helpers_preserve_delta_and_completion_policy\b/,
        message: 'missing remote poll helper contract test',
      },
      {
        regex: /\bremote_connect_image_context_policy_preserves_legacy_fallback_shape\b/,
        message: 'missing legacy image context fallback test',
      },
      {
        regex: /\bremote_connect_image_context_policy_prefers_explicit_contexts\b/,
        message: 'missing explicit image context preference test',
      },
      {
        regex: /\bremote_connect_image_context_adapter_owns_portable_conversion_shape\b/,
        message: 'missing image context adapter contract test',
      },
      {
        regex: /\bremote_connect_cancel_and_restore_policy_preserve_runtime_decisions\b/,
        message: 'missing cancel/restore policy test',
      },
      {
        regex: /\bremote_connect_dialog_runtime_owns_restore_prewarm_and_submit_order\b/,
        message: 'missing dialog runtime order test',
      },
      {
        regex: /\bremote_connect_dialog_runtime_preserves_explicit_turn_without_restore\b/,
        message: 'missing dialog explicit-turn test',
      },
      {
        regex: /\bremote_connect_dialog_submit_outcome_builder_preserves_scheduler_shape\b/,
        message: 'missing remote dialog outcome builder contract test',
      },
      {
        regex: /\bremote_connect_dialog_runtime_stops_before_prewarm_when_restore_fails\b/,
        message: 'missing restore failure propagation test',
      },
      {
        regex: /\bremote_chat_history_assembly_preserves_message_shape_and_item_order\b/,
        message: 'missing remote chat history assembly shape/order test',
      },
      {
        regex: /\bremote_chat_history_assembly_preserves_in_progress_assistant_history\b/,
        message: 'missing remote chat history in-progress preservation test',
      },
      {
        regex: /\bremote_connect_file_transfer_policy_preserves_limits_and_chunk_ranges\b/,
        message: 'missing remote file transfer policy test',
      },
      {
        regex: /\bremote_connect_file_transfer_policy_preserves_name_fallback\b/,
        message: 'missing remote file display-name test',
      },
      {
        regex: /\bremote_connect_file_path_resolution_stays_within_workspace_root\b/,
        message: 'missing remote file path resolution test',
      },
      {
        regex: /\bremote_connect_file_read_helpers_preserve_current_wire_inputs\b/,
        message: 'missing remote full-read helper test',
      },
      {
        regex: /\bremote_connect_file_chunk_and_info_helpers_preserve_response_facts\b/,
        message: 'missing remote chunk/info helper test',
      },
      {
        regex: /\bremote_connect_file_response_assembly_owns_base64_wire_shape\b/,
        message: 'missing remote file response assembly contract test',
      },
      {
        regex: /\bremote_connect_file_command_handler_owns_owner_flow_and_uses_host_root\b/,
        message: 'missing remote file command handler owner-flow test',
      },
      {
        regex: /\bremote_connect_execution_response_helpers_preserve_wire_shape\b/,
        message: 'missing remote execution response helper contract test',
      },
      {
        regex: /\bremote_connect_command_owner_routes_send_message_and_prefers_explicit_images\b/,
        message: 'missing remote command routing image/source regression',
      },
      {
        regex: /\bremote_connect_command_owner_preserves_cancel_and_group_routing\b/,
        message: 'missing remote command routing group/cancel regression',
      },
      {
        regex: /\bremote_connect_tracker_keeps_finished_turn_snapshot_until_persistence_finalizes\b/,
        message: 'missing tracker completion contract test',
      },
      {
        regex: /\bremote_connect_tracker_registry_owns_lifecycle_without_core_state\b/,
        message: 'missing tracker registry owner test',
      },
      {
        regex: /\bremote_connect_tracker_ignores_unrelated_direct_session_events\b/,
        message: 'missing tracker unrelated-event guard test',
      },
      {
        regex: /\bremote_connect_tool_preview_slimming_keeps_short_fields_and_drops_large_strings\b/,
        message: 'missing remote tool preview slimming test',
      },
      {
        regex: /\bremote_connect_cancel_runtime_restores_missing_session_before_cancel\b/,
        message: 'missing remote cancel restore/order regression',
      },
      {
        regex: /\bremote_connect_cancel_runtime_preserves_stale_and_idle_errors_without_restore\b/,
        message: 'missing remote cancel stale/idle regression',
      },
      {
        regex: /\bremote_connect_cancel_runtime_preserves_restore_failure_error\b/,
        message: 'missing remote cancel restore failure regression',
      },
      {
        regex: /\bremote_connect_workspace_response_helpers_own_wire_shape\b/,
        message: 'missing remote workspace response assembly regression',
      },
      {
        regex: /\bremote_connect_session_response_helpers_own_pagination_and_timestamps\b/,
        message: 'missing remote session response assembly regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/mod.rs',
    reason:
      'core remote-connect root keeps compatibility re-exports while services-integrations owns device, pairing, encryption, QR, and relay primitives',
    patterns: [
      {
        regex: /\bpub mod device\s*\{[\s\S]*openbitfun_services_integrations::remote_connect::device::\*/m,
        message: 'missing device compatibility re-export module',
      },
      {
        regex: /\bpub mod encryption\s*\{[\s\S]*openbitfun_services_integrations::remote_connect::encryption::\*/m,
        message: 'missing encryption compatibility re-export module',
      },
      {
        regex: /\bpub mod pairing\s*\{[\s\S]*openbitfun_services_integrations::remote_connect::pairing::\*/m,
        message: 'missing pairing compatibility re-export module',
      },
      {
        regex: /\bpub mod qr_generator\s*\{[\s\S]*openbitfun_services_integrations::remote_connect::qr_generator::\*/m,
        message: 'missing QR compatibility re-export module',
      },
      {
        regex: /\bpub mod relay_client\s*\{[\s\S]*openbitfun_services_integrations::remote_connect::relay_client::\*/m,
        message: 'missing relay client compatibility re-export module',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/remote_server.rs',
    reason:
      'core remote-connect server must remain a product runtime adapter around integrations-owned contracts',
    patterns: [
      {
        regex: /\bCoreServiceAgentRuntime\b/,
        message: 'missing core service/agent runtime owner routing',
      },
      {
        regex: /\bsubmit_remote_dialog\b/,
        message: 'missing remote dialog owner orchestration delegation',
      },
      {
        regex: /\bcancel_remote_task\b/,
        message: 'missing remote cancel owner orchestration delegation',
      },
      {
        regex: /\bhandle_remote_workspace_file_command\b/,
        message: 'missing remote file command owner delegation',
      },
      {
        regex: /\bRemoteCommandRuntimeHost\b/,
        message: 'missing remote command runtime host adapter',
      },
      {
        regex: /\bhandle_remote_command\b/,
        message: 'missing remote command routing owner delegation',
      },
      {
        regex: /\bhandle_remote_interaction_command\b/,
        message: 'missing remote interaction command owner orchestration delegation',
      },
      {
        regex: /\bgenerate_remote_initial_sync\b/,
        message: 'missing remote initial-sync owner orchestration delegation',
      },
      {
        regex: /\bhandle_remote_workspace_command\b/,
        message: 'missing remote workspace command owner orchestration delegation',
      },
      {
        regex: /\bhandle_remote_session_command\b/,
        message: 'missing remote session command owner orchestration delegation',
      },
      {
        regex: /\bhandle_remote_poll_command\b/,
        message: 'missing remote poll command owner orchestration delegation',
      },
      {
        regex: /\bhandle_remote_interaction_command\b/,
        message: 'missing remote interaction command owner orchestration delegation',
      },
      {
        regex: /\bremote_image_context\b/,
        message: 'missing image context adapter contract delegation',
      },
      {
        regex: /\bcore_service_agent_runtime_owner_maps_remote_image_context\b/,
        message: 'missing core service/agent image-context owner regression',
      },
      {
        regex: /\bremote_execution_prefers_unified_image_contexts_over_legacy_images\b/,
        message: 'missing unified image context preference regression',
      },
      {
        regex: /\bremote_execution_falls_back_to_legacy_images_as_image_contexts\b/,
        message: 'missing legacy image context fallback regression',
      },
      {
        regex: /\bremote_cancel_decision_preserves_current_turn_boundaries\b/,
        message: 'missing remote cancel boundary regression',
      },
      {
        regex: /\bremote_restore_target_only_restores_cold_sessions_with_workspace_binding\b/,
        message: 'missing remote restore target regression',
      },
      {
        regex: /\bremote_command_snapshot_covers_execution_poll_and_cancel_surfaces\b/,
        message: 'missing remote command snapshot regression',
      },
      {
        regex: /\bremote_response_snapshot_preserves_active_turn_and_result_shapes\b/,
        message: 'missing remote response snapshot regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/remote_connect/bot/command_router.rs',
    reason:
      'remote-connect bot must route concrete agent runtime port bindings through the core service/agent runtime owner',
    patterns: [
      {
        regex: /\bCoreServiceAgentRuntime\b/,
        message: 'missing core service/agent runtime owner routing',
      },
      {
        regex: /\bagent_runtime\b/,
        message: 'missing agent runtime owner binding',
      },
      {
        regex: /\bbuild_remote_session_create_request\b/,
        message: 'missing integrations-owned remote session create request builder',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
    reason:
      'core scheduler must keep dialog lifecycle and requester-aware cancellation adapters',
    patterns: [
      {
        regex: /\bimpl AgentDialogTurnPort for DialogScheduler\b/,
        message: 'missing dialog lifecycle port implementation',
      },
      {
        regex: /\bimpl AgentLifecycleDeliveryPort for DialogScheduler\b/,
        message: 'missing lifecycle delivery port implementation',
      },
      {
        regex: /\bimpl AgentTurnCancellationPort for DialogScheduler\b/,
        message: 'missing requester-aware cancellation port implementation',
      },
      {
        regex: /\bAgentBackgroundResultRequest\b/,
        message: 'missing background result lifecycle request adapter',
      },
      {
        regex: /\bAgentThreadGoalDeliveryRequest\b/,
        message: 'missing thread-goal lifecycle request adapter',
      },
      {
        regex: /\bAgentThreadGoalDeliveryKind::ObjectiveUpdated\b/,
        message: 'missing thread-goal objective-updated lifecycle adapter',
      },
      {
        regex: /\bcancel_active_turn_for_session_from_requester\b/,
        message: 'missing requester-aware cancellation adapter',
      },
      {
        regex: /\bagent_dialog_turn_image_contexts\b/,
        message: 'missing dialog lifecycle image attachment adapter',
      },
      {
        regex: /\bagent_dialog_turn_prepended_messages\b/,
        message: 'missing dialog lifecycle prepended reminder adapter',
      },
      {
        regex: /\bagent_dialog_turn_attachments_preserve_remote_image_context\b/,
        message: 'missing dialog lifecycle image attachment preservation regression',
      },
      {
        regex: /\bagent_dialog_turn_attachments_reject_unknown_kind\b/,
        message: 'missing dialog lifecycle attachment validation regression',
      },
      {
        regex: /\bagent_dialog_turn_prepended_reminders_preserve_session_message_kind\b/,
        message: 'missing dialog lifecycle prepended reminder preservation regression',
      },
      {
        regex: /\bagent_dialog_turn_prepended_reminders_reject_unknown_kind\b/,
        message: 'missing dialog lifecycle prepended reminder validation regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/registry.rs',
    reason:
      'core registry must stay a compatibility container that delegates product tool runtime assembly through the core owner module',
    patterns: [
      {
        regex: /\bfrom_inner\b/,
        message: 'missing generic agent-tools registry adapter hook',
      },
      {
        regex: /\bProductToolDecoratorRef\b/,
        message: 'missing product decorator ref alias using agent-tools contract',
      },
      {
        regex: /\bProductToolRuntime\b/,
        message: 'missing product tool runtime owner delegation',
      },
      {
        regex: /\bget_deferred_tool_names\b/,
        message: 'missing deferred-tool catalog owner',
      },
      {
        regex: /\bresolve_product_readonly_enabled_tools\b/,
        message: 'missing product tool catalog readonly facade delegation',
      },
      {
        regex: /\bproduct_tool_runtime_owner_preserves_registry_contract\b/,
        message: 'missing deferred-tool manifest migration baseline',
      },
      {
        regex: /\binner\.is_tool_deferred\b/,
        message: 'missing deferred exposure lookup delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime.rs',
    reason:
      'core product tool runtime owner delegates generic registry assembly and only wires product plan, decorator, and compatibility facade',
    patterns: [
      {
        regex: /\bProductToolRuntime\b/,
        message: 'missing core product tool runtime owner',
      },
      {
        regex: /\bSnapshotToolDecorator\b/,
        message: 'missing generic snapshot decorator injection',
      },
      {
        regex: /\bcreate_product_tool_registry_from_plan\b/,
        message: 'missing product registry assembly adapter delegation',
      },
      {
        regex: /\bproduct_assembly_plan_for_profile\b/,
        message: 'missing product assembly plan provider group plan delegation',
      },
      {
        regex: /\bproduct_tool_runtime_owner_preserves_registry_contract\b/,
        message: 'missing product runtime owner registry equivalence regression',
      },
      {
        regex:
          /\bproduct_tool_runtime_provider_plan_covers_registry_without_owning_order\b/,
        message: 'missing product tool ownership and registry-order separation regression',
      },
      {
        regex: /\bproduct_tool_runtime_keeps_no_direct_core_profiles_empty\b/,
        message: 'missing no-direct-core product tool runtime regression',
      },
      {
        regex: /\bDeliveryProfile::Sdk\b/,
        message: 'product tool runtime explicit profile regression must cover SDK profile',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/materialization.rs',
    reason:
      'product runtime materialization must keep only concrete tool construction while delegating generic provider-entry registry assembly to agent-tools',
    patterns: [
      {
        regex: /\bProductConcreteToolFactory\b/,
        message: 'missing product concrete tool factory adapter',
      },
      {
        regex: /\bimpl StaticToolProviderFactory<dyn Tool> for ProductConcreteToolFactory\b/,
        message: 'missing concrete tool factory implementation',
      },
      {
        regex: /\bcreate_registry_from_static_provider_entries\b/,
        message: 'missing generic agent-tools provider-entry registry delegation',
      },
      {
        regex: /\bcreate_product_tool_registry_from_plan\b/,
        message: 'missing product registry creation adapter',
      },
      {
        regex: /\bPRODUCT_TOOL_REGISTRATION_ORDER\b/,
        message: 'missing product registry order compatibility contract',
      },
      {
        regex: /\bMissingRegistrationOrder\b/,
        message: 'product registry materialization must reject unordered planned tools',
      },
      {
        regex: /\bunavailable_feature_groups\b/,
        message: 'product registry materialization must fail closed when a planned group was not compiled',
      },
      {
        regex: /\bmaterialize_tool\b/,
        message: 'missing concrete tool materialization boundary',
      },
      {
        regex: /\bGetToolSpecTool::new\(\)/,
        message: 'missing GetToolSpec registration anchor',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/snapshot.rs',
    reason:
      'product runtime snapshot wrapper must stay isolated from registry and catalog ownership',
    patterns: [
      {
        regex: /\bProductSnapshotToolWrapper\b/,
        message: 'missing core product snapshot wrapper adapter',
      },
      {
        regex: /\bimpl SnapshotToolWrapper<dyn Tool> for ProductSnapshotToolWrapper\b/,
        message: 'missing generic snapshot wrapper implementation',
      },
      {
        regex: /\bwrap_tool_for_snapshot_tracking\b/,
        message: 'missing snapshot wrapper boundary',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/catalog.rs',
    reason:
      'product runtime catalog owner keeps manifest, snapshot, readonly, and GetToolSpec product facades explicit',
    patterns: [
      {
        regex: /\bProductToolCatalogProvider\b/,
        message: 'missing core product tool catalog provider owner',
      },
      {
        regex: /\bimpl ToolCatalogSnapshotProvider<dyn Tool> for ProductToolCatalogProvider\b/,
        message: 'missing core tool catalog snapshot provider implementation',
      },
      {
        regex: /\bimpl GetToolSpecCatalogProvider<dyn Tool, ToolUseContext> for ProductToolCatalogProvider\b/,
        message: 'missing core product GetToolSpec catalog provider implementation',
      },
      {
        regex: /\bget_global_tool_registry\b/,
        message: 'missing core product registry snapshot access',
      },
      {
        regex: /\bget_agent_registry\b/,
        message: 'missing core agent policy source for contextual catalog',
      },
      {
        regex: /\bToolCatalogRuntime\b/,
        message: 'missing agent-tools product catalog runtime facade delegation',
      },
      {
        regex: /\bproduct_tool_catalog_runtime\b/,
        message: 'missing product catalog runtime factory',
      },
      {
        regex: /\bGetToolSpecRuntime\b/,
        message: 'missing agent-tools GetToolSpec runtime facade delegation',
      },
      {
        regex: /\bproduct_get_tool_spec_runtime\b/,
        message: 'missing product GetToolSpec runtime factory',
      },
      {
        regex: /\bresolve_product_tool_manifest\b/,
        message: 'missing product manifest facade',
      },
      {
        regex: /\bresolve_product_resolved_tool_manifest\b/,
        message: 'missing product resolved manifest compatibility facade',
      },
      {
        regex: /\bresolve_product_resolved_visible_tools\b/,
        message: 'missing product resolved visible-tools compatibility facade',
      },
      {
        regex: /\bresolve_product_readonly_enabled_tools\b/,
        message: 'missing product readonly enabled tools facade',
      },
      {
        regex: /\bresolve_product_get_tool_spec_results\b/,
        message: 'missing product GetToolSpec Tool-result vector facade',
      },
      {
        regex: /\bloaded_deferred_tool_specs\b/,
        message: 'missing product runtime deferred-tool loaded-spec state source',
      },
      {
        regex: /\bproduct_catalog_provider_default_get_tool_spec_catalog_matches_registry\b/,
        message: 'missing product catalog provider collapsed catalog regression',
      },
      {
        regex: /\bproduct_resolved_manifest_owner_matches_legacy_shape\b/,
        message: 'missing product resolved manifest compatibility regression',
      },
      {
        regex: /\bGetToolSpec requires agent type context\b/,
        message: 'missing contextual GetToolSpec catalog validation boundary',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_adapter.rs',
    reason:
      'core must keep the product Tool-to-agent-tools adapters explicit until ToolUseContext and concrete tools migrate',
    patterns: [
      {
        regex: /\bimpl ToolRegistryItem for dyn Tool\b/,
        message: 'missing core Tool registry adapter',
      },
      {
        regex: /\bimpl ContextualToolManifestItem<ToolUseContext> for dyn Tool\b/,
        message: 'missing core ToolUseContext contextual manifest adapter',
      },
      {
        regex: /\bTool::dynamic_tool_info\b/,
        message: 'missing dynamic tool metadata adapter',
      },
      {
        regex: /\bTool::is_readonly\b/,
        message: 'missing readonly metadata adapter',
      },
      {
        regex: /\bTool::is_enabled\b/,
        message: 'missing enabled-state metadata adapter',
      },
      {
        regex: /\bTool::description_with_context\b/,
        message: 'missing context-aware tool description adapter',
      },
      {
        regex: /\bTool::input_schema_for_model_with_context\b/,
        message: 'missing context-aware tool schema adapter',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/framework.rs',
    reason: 'agent-tools owns portable tool facts plus generic registry and provider contracts',
    patterns: [
      {
        regex: /\bpub struct ToolContextFacts\b/,
        message: 'missing portable tool context facts contract',
      },
      {
        regex: /\bpub trait PortableToolContextProvider\b/,
        message: 'missing portable tool context provider contract',
      },
      {
        regex: /\bpub enum ToolWorkspaceKind\b/,
        message: 'missing portable workspace kind contract',
      },
      {
        regex: /\bpub trait StaticToolProvider\b/,
        message: 'missing static tool provider contract',
      },
      {
        regex: /\bpub struct ToolRuntimeAssembly\b/,
        message: 'missing generic runtime assembly contract',
      },
      {
        regex: /\bpub async fn materialized_tool_snapshot\b/,
        message: 'missing registry materialized snapshot accessor',
      },
      {
        regex: /\bpub type ToolDecoratorRef\b/,
        message: 'missing generic decorator ref contract',
      },
      {
        regex: /\bpub trait SnapshotToolWrapper\b/,
        message: 'missing generic snapshot wrapper contract',
      },
      {
        regex: /\bpub struct SnapshotToolDecorator\b/,
        message: 'missing generic snapshot decorator contract',
      },
      {
        regex: /\bcreate_registry_from_static_providers\b/,
        message: 'missing generic static-provider assembly helper',
      },
      {
        regex: /\bcreate_registry_from_static_provider_plans\b/,
        message: 'missing generic static-provider plan-to-registry helper',
      },
      {
        regex: /\bcreate_registry_from_static_provider_entries\b/,
        message: 'missing generic static-provider entry-to-registry helper',
      },
      {
        regex: /\bpub fn install_static_provider\b/,
        message: 'missing static provider registry installer',
      },
      {
        regex: /\bpub fn miniapp_headless_agent_tool_restrictions\b/,
        message: 'missing MiniApp headless runtime restriction policy owner',
      },
      {
        regex: /\bpub fn tool_restrictions_for_delegation_policy\b/,
        message: 'missing delegation-policy runtime restriction owner',
      },
      {
        regex: /\bdenied_tool_messages\b/,
        message: 'missing per-tool denial message propagation owner',
      },
      {
        regex: /\bpub fn build_get_tool_spec_duplicate_load_result\b/,
        message: 'missing provider-neutral GetToolSpec duplicate-load result helper',
      },
      {
        regex: /\bpub fn build_get_tool_spec_detail_result\b/,
        message: 'missing provider-neutral GetToolSpec detail result helper',
      },
      {
        regex: /\bpub fn resolve_get_tool_spec_execution_plan\b/,
        message: 'missing provider-neutral GetToolSpec execution plan helper',
      },
      {
        regex: /\bpub async fn resolve_get_tool_spec_execution_result_from_provider\b/,
        message: 'missing provider-backed GetToolSpec execution result helper',
      },
      {
        regex: /\bpub struct GetToolSpecRuntime\b/,
        message: 'missing provider-backed GetToolSpec runtime facade',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-contracts/src/tool_snapshot.rs',
    reason:
      'agent-tools must own materialized tool snapshots, provider identity, effect facts, cancellation facts, and stale-call guards',
    patterns: [
      {
        regex: /\bpub struct MaterializedToolSnapshot\b/,
        message: 'missing materialized tool snapshot contract',
      },
      {
        regex: /\bpub struct ToolProviderIdentity\b/,
        message: 'missing provider-neutral tool identity contract',
      },
      {
        regex: /\bpub struct ToolEffectFacts\b/,
        message: 'missing provider-neutral tool effect facts contract',
      },
      {
        regex: /\bpub enum ToolEffectFactsSource\b/,
        message: 'missing tool effect facts source contract',
      },
      {
        regex: /\bpub struct ToolEffectFilter\b/,
        message: 'missing provider-neutral tool effect filter contract',
      },
      {
        regex: /\bpub struct ToolCallSnapshotGuard\b/,
        message: 'missing stale-call snapshot guard contract',
      },
      {
        regex: /\bpub enum ToolSnapshotCallError\b/,
        message: 'missing stale-call snapshot error contract',
      },
      {
        regex: /\bpub async fn materialize_tool_snapshot\b/,
        message: 'missing materialized tool snapshot builder',
      },
    ],
  },
  {
    path: 'src/crates/execution/tool-provider-groups/src/lib.rs',
    reason:
      'tool-packs must keep its feature-group scaffold explicit without owning concrete tools yet',
    patterns: [
      {
        regex: /\bpub enum ToolPackFeatureGroup\b/,
        message: 'missing tool-pack feature group scaffold',
      },
      {
        regex: /\bpub fn all_feature_groups\b/,
        message: 'missing tool-pack full feature group metadata helper',
      },
      {
        regex: /\bpub fn enabled_feature_groups\b/,
        message: 'missing tool-pack compile-time feature metadata helper',
      },
      {
        regex: /\bpub fn unavailable_feature_groups\b/,
        message: 'missing tool-pack planned-versus-compiled validation helper',
      },
      {
        regex: /\bpub struct ToolProviderGroupPlan\b/,
        message: 'missing tool-pack provider group plan contract',
      },
      {
        regex: /\bpub fn product_tool_provider_group_plan\b/,
        message: 'missing product tool provider group plan',
      },
      {
        regex: /\bpub enum ToolProviderGroupPlanSelectionError\b/,
        message: 'missing tool provider group plan selection error',
      },
      {
        regex: /\bpub fn try_product_tool_provider_group_plan_for_ids\b/,
        message: 'missing product tool provider group plan selector',
      },
      {
        regex: /\bproduct_provider_group_plan_selector_rejects_unknown_provider_ids\b/,
        message: 'missing provider group selector unknown-id regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/manifest_resolver.rs',
    reason:
      'core must continue owning manifest resolver wrappers while delegating product catalog access and generic manifest assembly',
    patterns: [
      {
        regex: /\bpub async fn resolve_tool_manifest\b/,
        message: 'missing tool manifest resolver owner',
      },
      {
        regex: /\bGET_TOOL_SPEC_TOOL_NAME\b/,
        message: 'missing GetToolSpec manifest insertion anchor',
      },
      {
        regex: /\bresolve_product_resolved_visible_tools\b/,
        message: 'missing core product visible-tools facade delegation',
      },
      {
        regex: /\bresolve_product_resolved_tool_manifest\b/,
        message: 'missing core product manifest facade delegation',
      },
      {
        regex: /\bdeferred_tool_names\b/,
        message: 'missing deferred-tool name tracking',
      },
      {
        regex: /\bmanifest_resolver_facade_preserves_product_owner_output\b/,
        message: 'missing manifest resolver facade parity regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/get_tool_spec_tool.rs',
    reason:
      'product runtime must own the GetToolSpec Tool adapter while delegating generic runtime surface to agent-tools',
    patterns: [
      {
        regex: /\bpub(?:\(crate\))? struct GetToolSpecTool\b/,
        message: 'missing GetToolSpec owner type',
      },
      {
        regex: /\bresolve_product_get_tool_spec_results\b/,
        message: 'missing product GetToolSpec Tool-result vector facade delegation',
      },
      {
        regex: /\bmap_get_tool_spec_execution_error\b/,
        message: 'missing core GetToolSpec execution error mapping boundary',
      },
      {
        regex: /\bbuild_deferred_tools_context_section\b/,
        message: 'missing core deferred-tool request-context section renderer',
      },
      {
        regex: /\bproduct_get_tool_spec_runtime\b/,
        message: 'missing product GetToolSpec runtime facade delegation',
      },
      {
        regex: /\bwith_runtime\b/,
        message: 'missing core GetToolSpec static surface facade boundary',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/framework.rs',
    reason:
      'core tool framework must keep compatibility re-exports while ToolUseContext is owned by tool_context_runtime',
    patterns: [
      {
        regex: /\bToolExposure\b/,
        message: 'missing ToolExposure compatibility re-export',
      },
      {
        regex: /\bpub use crate::agentic::tools::tool_context_runtime::ToolUseContext\b/,
        message: 'missing ToolUseContext compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/tool_context_runtime.rs',
    reason:
      'core must keep ToolUseContext runtime/service bindings centralized while ToolUseContext and concrete tools remain core-owned',
    patterns: [
      {
        regex: /\bpub struct ToolUseContext\b/,
        message: 'missing ToolUseContext owner type',
      },
      {
        regex: /\bto_tool_context_facts\b/,
        message: 'missing portable ToolUseContext facts projection',
      },
      {
        regex: /\bproject_tool_context_facts\b/,
        message: 'missing tool-runtime context facts owner delegation',
      },
      {
        regex: /\bbuild_tool_runtime_custom_data\b/,
        message: 'missing tool-runtime custom-data owner delegation',
      },
      {
        regex: /\bdelegation_policy_from_custom_data\b/,
        message: 'missing tool-runtime delegation policy owner delegation',
      },
      {
        regex: /\bimpl PortableToolContextProvider for ToolUseContext\b/,
        message: 'missing portable ToolUseContext facts provider impl',
      },
      {
        regex: /\btool_context_facts_omit_runtime_owner_fields_even_when_context_is_populated\b/,
        message: 'missing portable facts runtime-owner leak guard',
      },
      {
        regex: /customData/,
        message: 'missing custom data runtime-only facts guard',
      },
      {
        regex: /cancellationToken/,
        message: 'missing cancellation token runtime-only facts guard',
      },
      {
        regex: /\bloaded_deferred_tool_specs\b/,
        message: 'missing deferred-tool loaded-spec state',
      },
      {
        regex: /\bimpl ToolUseContext\b/,
        message: 'missing ToolUseContext runtime binding owner impl',
      },
      {
        regex: /\brecord_light_checkpoint\b/,
        message: 'missing Deep Review checkpoint binding',
      },
      {
        regex: /\bbuild_runtime_light_checkpoint\b/,
        message: 'missing agent-runtime light checkpoint policy delegation',
      },
      {
        regex: /\bLightCheckpointWorkspaceFacts::LocalWorkspace\b/,
        message: 'missing local checkpoint facts delegation',
      },
      {
        regex: /\bcall_with_tool_runtime_hooks\b/,
        message: 'missing tool-call cancellation/post-call hook binding',
      },
      {
        regex: /\bcall_tool_with_runtime_hooks\b/,
        message: 'missing unified Tool::call runtime hook facade',
      },
      {
        regex: /\bcall_records_deep_review_read_file_measurement_without_touching_result\b/,
        message: 'missing Deep Review post-call hook regression in runtime owner',
      },
      {
        regex: /\bbuild_tool_use_context_for_task\b/,
        message: 'missing tool pipeline context materialization binding',
      },
      {
        regex: /\bbuild_tool_description_context\b/,
        message: 'missing tool manifest description context materialization binding',
      },
      {
        regex: /\bensure_current_workspace_runtime\b/,
        message: 'missing workspace runtime ensure binding',
      },
      {
        regex: /\bresolve_tool_path\b/,
        message: 'missing tool path resolution binding',
      },
      {
        regex: /\benforce_path_operation\b/,
        message: 'missing runtime path policy binding',
      },
      {
        regex: /\bis_tool_path_allowed_by_resolved_roots\b/,
        message: 'missing path policy owner delegation to agent-tools',
      },
      {
        regex: /\bbuild_tool_path_policy_denial_message\b/,
        message: 'missing shared path policy denial contract',
      },
      {
        regex: /\bresolve_tool_path_with_context\b/,
        message: 'missing shared tool path resolution owner delegation',
      },
      {
        regex: /\btool_path_is_effectively_absolute\b/,
        message: 'missing shared tool path absolute owner delegation',
      },
      {
        regex: /\bbuild_tool_runtime_artifact_reference\b/,
        message: 'missing runtime artifact reference owner delegation',
      },
      {
        regex: /\bbuild_tool_session_runtime_artifact_reference\b/,
        message: 'missing session runtime artifact reference owner delegation',
      },
      {
        regex: /\bworkspace_path_resolution_rejects_absolute_paths_outside_remote_workspace\b/,
        message: 'missing remote workspace containment regression',
      },
      {
        regex: /\bruntime_uri_resolution_rejects_different_workspace_scope\b/,
        message: 'missing runtime artifact scope regression',
      },
      {
        regex: /\bpath_policy_allows_only_configured_local_roots\b/,
        message: 'missing path policy enforcement regression',
      },
      {
        regex: /\btool_call_runtime_hook_returns_cancelled_before_impl_completes\b/,
        message: 'missing tool-call cancellation regression',
      },
      {
        regex: /\btool_task_context_materialization_preserves_runtime_fields\b/,
        message: 'missing tool task context materialization regression',
      },
      {
        regex: /\btool_description_context_preserves_manifest_custom_data_shape\b/,
        message: 'missing tool description context regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/pipeline/tool_pipeline.rs',
    reason:
      'core must continue carrying deferred-tool loaded-spec state while delegating provider-neutral execution gate policy to agent-tools',
    patterns: [
      {
        regex: /\bvalidate_tool_execution_admission\b/,
        message: 'missing provider-neutral tool execution admission gate delegation',
      },
      {
        regex: /\bloaded_deferred_tool_specs\b/,
        message: 'missing deferred-tool loaded-spec state propagation',
      },
      {
        regex: /\bpipeline_preserves_core_owned_tool_context_without_portable_runtime_leak\b/,
        message: 'missing ToolUseContext runtime boundary regression',
      },
      {
        regex: /\bGetToolSpec\b/,
        message: 'missing GetToolSpec gating contract',
      },
      {
        regex: /\brender_tool_result_for_assistant\b/,
        message: 'missing tool result presentation owner delegation',
      },
      {
        regex: /\bbuild_tool_execution_error_presentation\b/,
        message: 'missing tool execution error presentation owner delegation',
      },
      {
        regex: /\bbuild_user_steering_interrupted_presentation\b/,
        message: 'missing steering-interrupted presentation owner delegation',
      },
      {
        regex: /\bbuild_invalid_tool_call_error_message\b/,
        message: 'missing invalid tool call presentation owner delegation',
      },
      {
        regex: /\bbuild_normal_tool_json_repair_notice\b/,
        message: 'missing normal-completion JSON repair notice owner delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/execution/execution_engine.rs',
    reason:
      'core execution must pass deferred-tool loaded-spec state through product runtime owner and keep DeepResearch post-turn hooks',
    patterns: [
      {
        regex: /\bcollect_product_loaded_deferred_tool_specs\b/,
        message: 'missing product runtime deferred-tool loaded-spec state handoff',
      },
      {
        regex: /\bloaded_deferred_tool_specs\b/,
        message: 'missing deferred-tool loaded-spec propagation into round context',
      },
      {
        regex: /\bdeferred_tool_names\b/,
        message: 'missing manifest deferred-tool handoff',
      },
      {
        regex: /\bGetToolSpec\b/,
        message: 'missing GetToolSpec execution contract',
      },
      {
        regex: /\bshould_post_process_research_report\b/,
        message: 'missing DeepResearch post-process runtime gate',
      },
      {
        regex: /\bopenbitfun_services_integrations::deep_research::run_for_session_workspace\b/,
        message: 'missing DeepResearch report IO owner delegation',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/product_runtime/loaded_spec_state.rs',
    reason:
      'product runtime owns deferred-tool loaded-spec observation adaptation while preserving generic agent-tools policy',
    patterns: [
      {
        regex: /\bcollect_product_loaded_deferred_tool_specs\b/,
        message: 'missing product runtime deferred-tool loaded-spec collector',
      },
      {
        regex: /\bGetToolSpecLoadObservation\b/,
        message: 'missing GetToolSpec load observation adapter',
      },
      {
        regex: /\bcollect_loaded_deferred_tool_specs\b/,
        message: 'missing generic deferred-tool load collector delegation',
      },
      {
        regex: /\bproduct_loaded_spec_state_dedupes_and_filters_results\b/,
        message: 'missing deferred-tool loaded-spec filtering regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/availability.rs',
    reason:
      'core agent registry must adapt config and AgentEntry facts while openbitfun-agent-runtime owns mode-scoped subagent availability decisions',
    patterns: [
      {
        regex: /\bfn resolve_availability\b/,
        message: 'missing core compatibility availability adapter',
      },
      {
        regex: /\bfn resolve_override_layers\b/,
        message: 'missing project/user override layering adapter',
      },
      {
        regex: /\bresolve_subagent_availability\b/,
        message: 'missing agent-runtime availability decision delegation',
      },
      {
        regex: /\bto_runtime_override_state\b/,
        message: 'missing config override to runtime override adapter',
      },
      {
        regex: /\bAgentSubagentOverrideState\b/,
        message: 'missing config override state adapter source',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/types.rs',
    reason:
      'core agent registry must preserve legacy DTO fields while openbitfun-agent-runtime owns query scope and availability reason contracts',
    patterns: [
      {
        regex: /\bSubagentOverrideState\b/,
        message: 'missing agent-runtime subagent override contract',
      },
      {
        regex: /pub use openbitfun_agent_runtime::agents::\{[\s\S]*SubAgentSource[\s\S]*SubagentListScope[\s\S]*SubagentQueryContext[\s\S]*SubagentStateReason[\s\S]*\};/,
        message: 'missing agent-runtime subagent registry contract re-export',
      },
      {
        regex: /\bpub struct AgentInfo\b/,
        message: 'missing core AgentInfo facade DTO',
      },
      {
        regex: /\bdefault_enabled\b/,
        message: 'missing default availability field',
      },
      {
        regex: /\beffective_enabled\b/,
        message: 'missing effective availability field',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/definitions/subagents/mod.rs',
    reason:
      'core subagent definitions must continue exposing the built-in GeneralPurpose subagent until registry ownership migration has equivalence coverage',
    patterns: [
      {
        regex: /\bmod general_purpose\b/,
        message: 'missing GeneralPurpose subagent module',
      },
      {
        regex: /\bpub use general_purpose::GeneralPurposeAgent\b/,
        message: 'missing GeneralPurpose subagent export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/agents/registry/builtin.rs',
    reason:
      'core builtin registry must delegate builtin default model facts to agent-runtime while preserving latest-main compatibility',
    patterns: [
      {
        regex: /\bbuiltin_agent_specs\(\)/,
        message: 'missing builtin agent spec registration source',
      },
      {
        regex: /\bruntime_agents::default_model_id_for_builtin_agent\(agent_type\)/,
        message: 'missing default model delegation to agent-runtime',
      },
    ],
  },
  {
    path: 'src/crates/execution/agent-runtime/src/agents.rs',
    reason:
      'agent-runtime builtin agent catalog must own latest-main mode/subagent categories, visibility, and default model facts',
    patterns: [
      {
        regex: /\bbuiltin_agent_definition_specs\(\)/,
        message: 'missing builtin agent definition catalog owner',
      },
      {
        regex: /builtin_agent_spec\(\s*"GeneralPurpose",\s*SubAgent,\s*"primary"/,
        message: 'missing GeneralPurpose runtime default model mapping',
      },
      {
        regex: /SubagentVisibilityPolicy::restricted\(\["Claw"\]\)/,
        message: 'missing ComputerUse restricted visibility mapping',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/input.rs',
    reason:
      'core Task input must continue owning fork-aware background subagent launch semantics until a reviewed agent-runtime port preserves delivery behavior',
    patterns: [
      {
        regex: /\bfork_context\b/,
        message: 'missing Task fork_context schema and validation surface',
      },
      {
        regex: /\bSubagentContextMode::Fork\b/,
        message: 'missing forked subagent context mode path',
      },
      {
        regex: /"run_in_background"/,
        message: 'missing Task run_in_background schema flag',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/execution.rs',
    reason:
      'core Task execution must continue owning background subagent launch semantics until a reviewed agent-runtime port preserves delivery behavior',
    patterns: [
      {
        regex: /\blet\s+delegation_policy\s*=\s*child_delegation_policy\(/,
        message: 'missing policy-aware child delegation for background launches',
      },
      {
        regex: /delegation_policy:\s*child_delegation_policy\(/,
        message: 'missing policy-aware child delegation for foreground execution',
      },
      {
        regex: /\bstart_background_subagent\b/,
        message: 'missing background subagent launch path',
      },
      {
        regex: /\bbg_task_id\b/,
        message: 'missing parent-scoped background task id result contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/background.rs',
    reason:
      'core Task background acknowledgement must remain assistant-visible and expose the task id needed for explicit result collection',
    patterns: [
      {
        regex: /Background subagent started successfully/,
        message: 'missing assistant-visible background start acknowledgement',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/tools/implementations/task/tests.rs',
    reason:
      'core Task tests must preserve background acknowledgement shape',
    patterns: [
      {
        regex: /\bbackground_subagent_start_acknowledgement_exposes_agent_wait_task_id\b/,
        message: 'missing background task start acknowledgement regression',
      },
      {
        regex: /<background_task/,
        message: 'missing regression that started background tasks do not expose structured task markers',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/coordination/scheduler.rs',
    reason:
      'core scheduler keeps concrete background delivery entry points while openbitfun-agent-runtime owns running-turn injection construction',
    patterns: [
      {
        regex: /\bdeliver_background_result\b/,
        message: 'missing background subagent delivery entry point',
      },
      {
        regex: /\bresolve_background_delivery_injection\b/,
        message: 'missing runtime-owned background injection construction',
      },
      {
        regex: /DialogTriggerSource::AgentSession/,
        message: 'missing idle-session agent-session follow-up turn source',
      },
    ],
  },
  {
    path: 'src/apps/cli/src/modes/chat/worktree.rs',
    reason:
      'CLI worktree presentation must delegate session binding to the worktree owner and refuse remote-workspace local fallback',
    patterns: [
      {
        regex: /\bWorktreeService::bind_session\b/,
        message: 'missing worktree session binding delegation',
      },
      {
        regex: /\bis_remote_workspace\b/,
        message: 'missing remote workspace guard',
      },
      {
        regex: /does not fall back to controller-local services/,
        message: 'missing remote workspace local-fallback guard',
      },
    ],
  },
  {
    path: 'src/apps/cli/src/ui/startup.rs',
    reason:
      'CLI subagent presentation remains app-local while mode-aware reads and mutations call the agent registry owner directly',
    patterns: [
      {
        regex: /\bfn show_available_subagent_list\b/,
        message: 'missing CLI subagent list surface',
      },
      {
        regex: /\bfn show_subagent_config_selector\b/,
        message: 'missing CLI subagent config surface',
      },
      {
        regex: /\bget_subagents_for_query\b/,
        message: 'missing CLI agent-registry mode-scoped subagent query',
      },
      {
        regex: /\bSubagentSummary\b/,
        message: 'missing secret-safe CLI subagent read projection',
      },
      {
        regex: /\bupdate_subagent_override\b/,
        message: 'missing CLI agent-registry subagent availability update path',
      },
    ],
  },
  {
    path: 'src/apps/cli/src/ui/subagent_selector.rs',
    reason:
      'CLI subagent selector presentation must remain app-layer UI while registry availability semantics stay in core',
    patterns: [
      {
        regex: /\bSubagentSelectorAction\b/,
        message: 'missing CLI subagent selector action contract',
      },
      {
        regex: /\bshow_list\b/,
        message: 'missing CLI subagent list mode',
      },
      {
        regex: /\bshow_config\b/,
        message: 'missing CLI subagent config mode',
      },
      {
        regex: /\benabled\b/,
        message: 'missing CLI effective availability state',
      },
      {
        regex: /\bfn render_subagent_line\b/,
        message: 'missing CLI subagent presentation renderer',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/deep_research.rs',
    reason:
      'services-integrations DeepResearch owner must retain report filesystem IO, sidecar persistence, and runtime renumbering delegation',
    patterns: [
      {
        regex: /\bpub async fn run_for_session_workspace\b/,
        message: 'missing DeepResearch session workspace report hook entry point',
      },
      {
        regex: /\bpub async fn try_renumber_research_report\b/,
        message: 'missing DeepResearch report IO owner entry point',
      },
      {
        regex: /\brenumber_research_report\b/,
        message: 'missing DeepResearch citation runtime owner delegation',
      },
      {
        regex: /\breport\.md\b/,
        message: 'missing DeepResearch report filename contract',
      },
      {
        regex: /\bcitations\.md\b/,
        message: 'missing DeepResearch citation registry filename contract',
      },
      {
        regex: /display_map\.json/,
        message: 'missing citation display map sidecar contract',
      },
      {
        regex: /\bREJECTED\b/,
        message: 'missing rejected-citation filtering contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace/service.rs',
    reason:
      'core workspace runtime must continue owning startup remote-workspace guards until workspace service migration is reviewed',
    patterns: [
      {
        regex: /\bprepare_startup_restored_workspaces\b/,
        message: 'missing restored-workspace startup guard',
      },
      {
        regex: /\bWorkspaceKind::Remote\b/,
        message: 'missing remote workspace branch',
      },
      {
        regex: /\bensure_remote_workspace_runtime\b/,
        message: 'missing remote workspace runtime ensure call',
      },
      {
        regex: /\bsshHost\b/,
        message: 'missing remote workspace host metadata contract',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/workspace_search/mod.rs',
    reason:
      'workspace_search must keep flashgrep protocol internals crate-private and expose stable DTO/service APIs only',
    patterns: [
      {
        regex: /\bpub\(crate\)\s+mod\s+flashgrep\b/,
        message: 'flashgrep protocol internals must stay crate-private',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/workspace_search/service.rs',
    reason:
      'services-integrations workspace_search must own local flashgrep fallback and session lifecycle',
    patterns: [
      {
        regex: /\bpub struct WorkspaceSearchRepoConfig\b/,
        message: 'missing stable workspace-search repo config contract',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/workspace_search/result_mapping.rs',
    reason:
      'services-integrations workspace_search result mapping must own flashgrep result conversion and delegate content previews to line_hydration',
    patterns: [
      {
        regex: /\bconvert_hits_to_file_search_results\b/,
        message: 'missing hit-to-file-result conversion owner',
      },
      {
        regex: /\bline_hydration\b/,
        message: 'missing preview hydration ownership note',
      },
      {
        regex: /\bpreview_inside\b/,
        message: 'missing preview-inside rendering contract',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/workspace_search/line_hydration.rs',
    reason:
      'services-integrations workspace_search must own disk hydration of daemon line positions, because flashgrep never returns line text',
    patterns: [
      {
        regex: /\bpub\(crate\)\s+fn\s+hydrate_grouped_line_matches\b/,
        message: 'missing grouped line-match hydration owner',
      },
      {
        regex: /\bMAX_HYDRATED_LINE_COLUMNS\b/,
        message: 'missing long-line clamp shared with the ripgrep path',
      },
      {
        regex: /\bContentMatchPreviewBuilder\b/,
        message: 'previews must be built with the shared services-core builder',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/filesystem/content_preview.rs',
    reason:
      'services-core filesystem must own the content preview primitives shared by the ripgrep and indexed search paths',
    patterns: [
      {
        regex: /\bpub fn compile_content_search_regex\b/,
        message: 'missing shared content-search regex compiler',
      },
      {
        regex: /\bpub fn build_content_match_preview\b/,
        message: 'missing shared content preview builder',
      },
      {
        regex: /\bpub struct ContentMatchPreviewBuilder\b/,
        message: 'missing reusable preview builder for batched hydration',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/service.rs',
    reason:
      'core workspace search service must remain a compatibility facade that injects product config/bootstrap hooks into the integration owner',
    patterns: [
      {
        regex: /\bowner::WorkspaceSearchService::new_with_hooks\b/,
        message: 'missing workspace-search owner delegation',
      },
      {
        regex: /\bCoreWorkspaceSearchRuntimeHooks\b/,
        message: 'missing core runtime hook adapter',
      },
      {
        regex: /\bWorkspaceSearchRepoConfig\b/,
        message: 'missing stable workspace-search repo config hook',
      },
      {
        regex: /\bget_global_config_service\b/,
        message: 'missing product config hook for workspace-search repo config',
      },
      {
        regex: /\bensure_workspace_gitignore_ignores_openbitfun\b/,
        message: 'missing workspace bootstrap hook for search warmup',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/mod.rs',
    reason:
      'remote SSH workspace_search strategy helpers must stay crate-internal and keep behavior-equivalence tests near the owner',
    patterns: [
      {
        regex: /#\[cfg\(not\(feature = "remote-ssh-concrete"\)\)\]\s*pub mod disabled\b/s,
        message: 'missing gated service-owned disabled remote workspace search surface',
      },
      {
        regex: /\bpub\(crate\)\s+fn\s+build_remote_scope\b/,
        message: 'remote scope helper must stay crate-internal',
      },
      {
        regex: /\bpub\(crate\)\s+fn\s+shell_escape\b/,
        message: 'remote shell escaping helper must stay crate-internal',
      },
      {
        regex: /\bpub\(crate\)\s+fn\s+should_retry_remote_scan_fallback_as_files_with_matches\b/,
        message: 'remote scan fallback retry policy must stay crate-internal',
      },
      {
        regex: /\bremote_workspace_search_paths_preserve_current_contract\b/,
        message: 'missing remote path contract regression',
      },
      {
        regex: /\bremote_scan_fallback_retry_policy_preserves_current_contract\b/,
        message: 'missing remote scan fallback retry regression',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/service.rs',
    reason:
      'services-integrations remote SSH workspace_search must own remote flashgrep concrete session, fallback, and binary lifecycle behind provider traits',
    patterns: [
      {
        regex: /\bpub trait RemoteWorkspaceSearchProvider\b/,
        message: 'missing remote search provider boundary',
      },
      {
        regex: /\bpub struct RemoteWorkspaceSearchService\b/,
        message: 'missing remote workspace search service owner',
      },
      {
        regex: /\bpub struct RemoteWorkspaceSearchStdioProtocol\b/,
        message: 'missing narrow remote stdio protocol facade',
      },
      {
        regex: /\bREMOTE_STDIO_SESSIONS\b/,
        message: 'missing remote stdio session lifecycle owner',
      },
      {
        regex: /\bensure_remote_search_context\b/,
        message: 'missing remote search context lifecycle owner',
      },
      {
        regex: /\bfallback_query\b/,
        message: 'missing FilesWithMatches fallback query',
      },
      {
        regex: /\bremote_search_rejects_non_linux_before_stdio_open\b/,
        message: 'missing remote OS gate regression',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/remote.rs',
    reason:
      'core remote search runtime must remain a compatibility facade over services-integrations while retaining the transport-neutral workspace stdio bridge adapter',
    patterns: [
      {
        regex: /\bServiceRemoteWorkspaceSearchService\b/,
        message: 'missing services remote search owner delegation',
      },
      {
        regex: /\bimpl RemoteWorkspaceSearchProvider for CoreRemoteWorkspaceSearchProvider\b/,
        message: 'missing core remote search provider adapter',
      },
      {
        regex: /\brequire_workspace\(workspace_id\)/,
        message: 'remote search must resolve the registered workspace by ID',
      },
      {
        regex: /\bopen_workspace_stdio\b/,
        message: 'missing transport-neutral workspace stdio bridge adapter',
      },
      {
        regex: /\bRemoteWorkspaceSearchStdioProtocol\b/,
        message: 'missing narrow stdio protocol facade in core remote bridge',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/mod.rs',
    reason:
      'remote workspace search must route to the real implementation only when ssh-remote is enabled',
    patterns: [
      {
        regex: /#\[cfg\(feature = "ssh-remote"\)\]\s*mod remote\b/s,
        message: 'missing ssh-remote gate for real remote search implementation',
      },
      {
        regex: /#\[cfg\(not\(feature = "ssh-remote"\)\)\]\s*pub use remote_disabled::/s,
        message: 'missing dependency-light disabled remote search export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/search/remote_disabled.rs',
    reason:
      'Core local-search builds must retain an explicit remote-search unsupported contract without compiling SSH services',
    patterns: [
      {
        regex: /Remote SSH search is disabled; enable the `ssh-remote` feature/,
        message: 'missing explicit disabled remote search diagnostic',
      },
      {
        regex: /\bremote_workspace_search_service_for_workspace\b/,
        message: 'missing ID-based disabled remote workspace search resolver',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/workspace_search/disabled.rs',
    reason:
      'services-integrations must own disabled remote workspace search diagnostics for lightweight SSH builds',
    patterns: [
      {
        regex: /Remote SSH search is disabled; enable the `ssh-remote` feature/,
        message: 'missing explicit disabled remote search diagnostic',
      },
      {
        regex: /\bpub struct RemoteWorkspaceSearchService\b/,
        message: 'missing disabled remote workspace search service surface',
      },
      {
        regex: /\bpub async fn search_content\b/,
        message: 'missing explicit unsupported search operation',
      },
    ],
  },
  {
    path: 'src/crates/interfaces/acp/src/client/manager.rs',
    reason:
      'ACP surface runtime must continue owning startup timeout diagnostics until ACP migration is reviewed',
    patterns: [
      {
        regex: /\bCLIENT_STARTUP_TIMEOUT_SECS\b/,
        message: 'missing ACP startup timeout duration contract',
      },
      {
        regex: /\bstartup_timeout_error_message\b/,
        message: 'missing ACP startup timeout diagnostic formatter',
      },
      {
        regex: /\bformats_startup_timeout_error_message\b/,
        message: 'missing ACP startup timeout regression',
      },
    ],
  },
  {
    path: 'src/web-ui/src/flow_chat/tool-cards/FileOperationToolCard.tsx',
    reason:
      'web-ui file operation surface must preserve snapshot-independent inline diffs after the design-system migration',
    patterns: [
      {
        regex: /\bInlineDiffPreview\b/,
        message: 'missing snapshot-independent inline diff renderer',
      },
      {
        regex: /previewVariant === 'completed-diff'/,
        message: 'missing completed file-operation diff state',
      },
      {
        regex: /originalContent=\{oldStringContent\}/,
        message: 'missing Edit original-content projection',
      },
      {
        regex: /modifiedContent=\{newStringContent\}/,
        message: 'missing Edit modified-content projection',
      },
      {
        regex: /originalContent=""/,
        message: 'missing Write empty-baseline projection',
      },
      {
        regex: /modifiedContent=\{contentPreview\}/,
        message: 'missing Write content projection',
      },
    ],
  },
  {
    path: 'src/web-ui/src/main.tsx',
    reason:
      'web startup scheduling and trace orchestration remain web product-surface behavior, not core contract runtime',
    patterns: [
      {
        regex: /\bstartupTrace\b/,
        message: 'missing web startup trace surface',
      },
      {
        regex: /\bbackgroundTaskScheduler\b/,
        message: 'missing deferred startup scheduler surface',
      },
      {
        regex: /\binitializeAllTools\b/,
        message: 'missing narrow tool-startup entry integration',
      },
      {
        regex: /\bafter_render_start\b/,
        message: 'missing post-render startup phase',
      },
    ],
  },
  {
    path: 'src/web-ui/src/shared/utils/startupTrace.ts',
    reason:
      'web startup trace classification and redaction remain web infrastructure behavior until a telemetry contract is reviewed',
    patterns: [
      {
        regex: /\bfunction sanitizeTraceData\b/,
        message: 'missing startup trace sanitization',
      },
      {
        regex: /\bexport function isRemoteTraceRequest\b/,
        message: 'missing remote request classifier',
      },
      {
        regex: /\brecordApiCall\b/,
        message: 'missing startup API-call trace recorder',
      },
      {
        regex: /\bflushSummary\b/,
        message: 'missing bounded startup summary flush',
      },
      {
        regex: /\bmarkPhaseAfterAnimationFrames\b/,
        message: 'missing frame-delayed startup marker',
      },
    ],
  },
  {
    path: 'src/web-ui/src/shared/utils/backgroundTaskScheduler.ts',
    reason:
      'web background startup scheduling remains web infrastructure behavior and must preserve dedupe/cancel semantics',
    patterns: [
      {
        regex: /\bexport class BackgroundTaskScheduler\b/,
        message: 'missing background task scheduler',
      },
      {
        regex: /\binFlightKey\b/,
        message: 'missing in-flight dedupe key',
      },
      {
        regex: /\bAbortController\b/,
        message: 'missing cancellation controller',
      },
      {
        regex: /\bBackgroundTaskCancelledError\b/,
        message: 'missing cancellation error contract',
      },
      {
        regex: /\bcancelIdle\b/,
        message: 'missing idle callback cancellation',
      },
    ],
  },
  {
    path: 'src/web-ui/src/tools/initializeTools.ts',
    reason:
      'web tool startup must stay behind a narrow app-layer entry instead of importing product tools through shared contracts',
    patterns: [
      {
        regex: /\bexport async function initializeAllTools\b/,
        message: 'missing narrow tool startup entry',
      },
      {
        regex: /\binitializeGit\b/,
        message: 'missing Git startup initializer call',
      },
      {
        regex: /does not import every tool/,
        message: 'missing narrow startup import guard',
      },
    ],
  },
  {
    path: 'src/web-ui/src/tools/editor/services/MonacoStartupWarmup.ts',
    reason:
      'Monaco startup warmup remains a deferred web-app optimization, not a core runtime dependency',
    patterns: [
      {
        regex: /\bexport function scheduleMonacoStartupWarmup\b/,
        message: 'missing deferred Monaco warmup entry',
      },
      {
        regex: /\bbackgroundTaskScheduler\b/,
        message: 'missing background scheduler integration',
      },
      {
        regex: /startup:monaco-warmup/,
        message: 'missing Monaco warmup dedupe key',
      },
    ],
  },
  {
    path: 'src/web-ui/src/flow_chat/services/flow-chat-manager/SessionModule.ts',
    reason:
      'flow-chat history hydration remains web startup/product-surface behavior until a UI equivalence plan exists',
    patterns: [
      {
        regex: /\bhistorical_session_hydrate_request\b/,
        message: 'missing historical session hydrate trace',
      },
      {
        regex: /Load history in the background/,
        message: 'missing non-blocking history load contract',
      },
      {
        regex: /\bhistoryState: 'ready'/,
        message: 'missing history-ready state contract',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/storage.rs',
    reason:
      'core MiniApp storage path must stay a compatibility facade over the integrations owner',
    patterns: [
      {
        regex: /\bServiceMiniAppStorage\b/,
        message: 'missing services-owned MiniApp storage delegation',
      },
      {
        regex: /\bmap_storage_error\b/,
        message: 'missing MiniApp storage error compatibility mapping',
      },
      {
        regex: /\bMiniAppImportBundleWriteRequest\b/,
        message: 'missing MiniApp import bundle IO compatibility write request',
      },
      {
        regex: /\bread_import_meta_json\b/,
        message: 'missing MiniApp import metadata IO compatibility delegation',
      },
      {
        regex: /\bwrite_import_bundle\b/,
        message: 'missing MiniApp import bundle IO compatibility delegation',
      },
      {
        regex: /\bimpl MiniAppStoragePort for MiniAppStorage\b/,
        message: 'missing MiniApp storage port adapter owner',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/miniapp/storage.rs',
    reason:
      'services-integrations must own MiniApp filesystem storage, draft, customization, and version IO behind the miniapp-runtime feature',
    patterns: [
      {
        regex: /\bpub struct MiniAppStorage\b/,
        message: 'missing services-owned MiniApp storage owner',
      },
      {
        regex: /\bMiniAppStorageError\b/,
        message: 'missing MiniApp storage integration error type',
      },
      {
        regex: /\bMiniAppImportBundleWriteRequest\b/,
        message: 'missing services-owned MiniApp import bundle write request',
      },
      {
        regex: /\bread_import_meta_json\b/,
        message: 'missing services-owned MiniApp import metadata read',
      },
      {
        regex: /\bwrite_import_bundle\b/,
        message: 'missing services-owned MiniApp import bundle IO',
      },
      {
        regex: /\btokio::fs::read_to_string\b/,
        message: 'missing services-owned MiniApp storage file reads',
      },
      {
        regex: /\btokio::fs::write\b/,
        message: 'missing services-owned MiniApp storage file writes',
      },
      {
        regex: /\btokio::fs::remove_dir_all\b/,
        message: 'missing services-owned MiniApp storage cleanup',
      },
      {
        regex: /\bMiniAppStorageLayout\b/,
        message: 'missing product-domain MiniApp storage layout use',
      },
      {
        regex: /\bimpl MiniAppStoragePort for MiniAppStorage\b/,
        message: 'missing MiniApp storage port implementation in integrations owner',
      },
      {
        regex: /\bstorage_port_adapter_preserves_existing_file_lifecycle\b/,
        message: 'missing MiniApp storage port behavior regression test',
      },
      {
        regex: /\bimport_bundle_io_preserves_copy_and_fallback_contract\b/,
        message: 'missing MiniApp import bundle IO regression test',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/builtin/mod.rs',
    reason:
      'core must adapt built-in MiniApp seed host operations while product-domains owns seed orchestration and services-integrations owns seed filesystem IO',
    patterns: [
      {
        regex: /\bBUILTIN_APPS\b/,
        message: 'missing product-domain built-in MiniApp bundle re-export/use',
      },
      {
        regex: /\bseed_builtin_miniapps_with_host\b/,
        message: 'missing product-domain built-in MiniApp seed orchestrator use',
      },
      {
        regex: /\bimpl BuiltinMiniAppSeedHost for CoreBuiltinMiniAppSeedHost\b/,
        message: 'missing core built-in MiniApp seed host adapter',
      },
      {
        regex: /\bmark_builtin_update_available\b/,
        message: 'missing built-in MiniApp local-override update-record host delegation',
      },
      {
        regex: /\bminiapp_builtin_io::prepare_builtin_seed_bundle_files\b/,
        message: 'missing services-owned built-in MiniApp seed file IO delegation',
      },
      {
        regex: /\bread_builtin_install_marker\b/,
        message: 'missing built-in MiniApp marker read compatibility wrapper',
      },
      {
        regex: /\bminiapp_builtin_io::read_builtin_install_marker\b/,
        message: 'missing services-owned built-in MiniApp marker read delegation',
      },
      {
        regex: /\bwrite_builtin_install_marker\b/,
        message: 'missing built-in MiniApp marker write compatibility wrapper',
      },
      {
        regex: /\bminiapp_builtin_io::write_builtin_install_marker\b/,
        message: 'missing services-owned built-in MiniApp marker write delegation',
      },
      {
        regex: /\brecompile\b/,
        message: 'missing core-owned built-in MiniApp recompile orchestration',
      },
      {
        regex: /\bload_customization_metadata\b/,
        message: 'missing customized built-in preservation path',
      },
      {
        regex: /\bavailable_builtin_update\b/,
        message: 'missing customized built-in update metadata path',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/host_dispatch.rs',
    reason:
      'core MiniApp host-dispatch path must stay a compatibility adapter over the integrations owner',
    patterns: [
      {
        regex: /\bpub async fn dispatch_host\b/,
        message: 'missing MiniApp host dispatch entry',
      },
      {
        regex: /\bopenbitfun_services_integrations::miniapp::host_dispatch::dispatch_host\b/,
        message: 'missing MiniApp host dispatch integrations owner delegation',
      },
      {
        regex: /\bmap_host_dispatch_error\b/,
        message: 'missing MiniApp host dispatch error compatibility mapping',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/miniapp/builtin_io.rs',
    reason:
      'services-integrations must own built-in MiniApp seed files, marker IO, and storage-preservation writes behind the miniapp-runtime feature',
    patterns: [
      {
        regex: /\bpub async fn read_builtin_install_marker\b/,
        message: 'missing built-in MiniApp marker read IO owner',
      },
      {
        regex: /\bparse_builtin_install_marker\b/,
        message: 'missing product-domain built-in MiniApp marker parse helper use',
      },
      {
        regex: /\bpub async fn write_builtin_install_marker\b/,
        message: 'missing built-in MiniApp marker write IO owner',
      },
      {
        regex: /\bserialize_builtin_install_marker\b/,
        message: 'missing product-domain built-in MiniApp marker serialization helper use',
      },
      {
        regex: /\bpub async fn prepare_builtin_seed_bundle_files\b/,
        message: 'missing built-in MiniApp seed bundle file IO owner',
      },
      {
        regex: /\bbuiltin_source_files\b/,
        message: 'missing product-domain built-in MiniApp source payload use',
      },
      {
        regex: /\bbuild_builtin_seed_meta\b/,
        message: 'missing product-domain built-in MiniApp seed meta helper use',
      },
      {
        regex: /\bpreserved_builtin_created_at\b/,
        message: 'missing product-domain built-in MiniApp timestamp preservation helper use',
      },
      {
        regex: /\bBUILTIN_PLACEHOLDER_COMPILED_HTML\b/,
        message: 'missing product-domain built-in MiniApp placeholder payload use',
      },
      {
        regex: /\bstorage\.json\b/,
        message: 'missing built-in MiniApp storage preservation file contract',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/miniapp/host_dispatch.rs',
    reason:
      'services-integrations must own MiniApp host-dispatch fs/shell/net/os execution behind the miniapp-runtime feature',
    patterns: [
      {
        regex: /\bpub async fn dispatch_host\b/,
        message: 'missing MiniApp host dispatch owner entry',
      },
      {
        regex: /\bsplit_host_method\b/,
        message: 'missing product-domain MiniApp host method split use',
      },
      {
        regex: /\basync fn dispatch_fs\b/,
        message: 'missing MiniApp fs host dispatch owner',
      },
      {
        regex: /\bplan_fs_legacy_path_check\b/,
        message: 'missing product-domain MiniApp legacy fs path-gate plan use',
      },
      {
        regex: /\bplan_fs_host_call\b/,
        message: 'missing product-domain MiniApp fs host-call plan use',
      },
      {
        regex: /\bfs_policy_scopes\b/,
        message: 'missing product-domain MiniApp fs scope extraction policy use',
      },
      {
        regex: /\bMiniAppPermissionPolicyRequest::from_paths\b/,
        message: 'missing product-domain MiniApp permission policy request/path delegation',
      },
      {
        regex: /\bresolve_policy_with_request\b/,
        message: 'missing product-domain MiniApp permission policy facade delegation',
      },
      {
        regex: /\bfs_resolved_path_allowed\b/,
        message: 'missing product-domain MiniApp fs resolved path policy use',
      },
      {
        regex: /\basync fn dispatch_shell\b/,
        message: 'missing MiniApp shell host dispatch',
      },
      {
        regex: /\bplan_shell_host_call\b/,
        message: 'missing product-domain MiniApp shell host-call plan use',
      },
      {
        regex: /\bshell_exec_default_env\b/,
        message: 'missing product-domain MiniApp shell env policy use',
      },
      {
        regex: /\bcommand_basename_allowed\b/,
        message: 'missing MiniApp shell allowlist policy use',
      },
      {
        regex: /\bhost_allowed_by_allowlist\b/,
        message: 'missing MiniApp net allowlist policy use',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message: 'missing shared process-manager command creation for shell dispatch',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/workspace_identity.rs',
    reason:
      'services-core owns stable workspace path/session identity helpers without remote transport or concrete SSH runtime handles',
    patterns: [
      {
        regex: /\bpub struct WorkspaceSessionIdentity\b/,
        message: 'missing workspace session identity contract',
      },
      {
        regex: /\bpub fn workspace_session_identity\b/,
        message: 'missing workspace session identity builder',
      },
      {
        regex: /\bpub fn remote_workspace_runtime_root\b/,
        message: 'missing remote workspace runtime root helper',
      },
      {
        regex: /\bpub fn remote_workspace_session_mirror_dir\b/,
        message: 'missing remote workspace session mirror helper',
      },
      {
        regex: /\bpub fn canonicalize_local_workspace_root\b/,
        message: 'missing local workspace canonicalization helper',
      },
      {
        regex: /\bpub fn normalize_local_workspace_root_for_stable_id\b/,
        message: 'missing local workspace stable-root helper',
      },
      {
        regex: /\bpub fn local_workspace_roots_equal\b/,
        message: 'missing local workspace equality helper',
      },
      {
        regex: /\bpub fn unresolved_remote_session_storage_dir\b/,
        message: 'missing unresolved remote session storage helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/storage.rs',
    reason:
      'product-domains owns MiniApp storage shape contracts while services-integrations keeps filesystem IO',
    patterns: [
      {
        regex: /\bpub struct MiniAppStorageLayout\b/,
        message: 'missing MiniApp storage layout contract',
      },
      {
        regex: /\bpub const META_JSON\b/,
        message: 'missing MiniApp metadata filename contract',
      },
      {
        regex: /\bpub fn source_file_path\b/,
        message: 'missing MiniApp source file layout helper',
      },
      {
        regex: /\bpub fn versions_dir\b/,
        message: 'missing MiniApp versions directory layout helper',
      },
      {
        regex: /\bpub const DRAFT_JSON\b/,
        message: 'missing MiniApp draft manifest filename contract',
      },
      {
        regex: /\bpub const REQUIRED_SOURCE_FILES\b/,
        message: 'missing MiniApp import source file list contract',
      },
      {
        regex: /\bpub const PLACEHOLDER_COMPILED_HTML\b/,
        message: 'missing MiniApp placeholder compiled HTML contract',
      },
      {
        regex: /\bpub struct MiniAppImportLayout\b/,
        message: 'missing MiniApp import layout contract',
      },
      {
        regex: /\bpub fn build_import_fallbacks\b/,
        message: 'missing MiniApp import fallback payload helper',
      },
      {
        regex: /\bpub struct MiniAppImportBundlePlan\b/,
        message: 'missing MiniApp import bundle plan shape',
      },
      {
        regex: /\bpub struct MiniAppImportBundleWriteRequest\b/,
        message: 'missing MiniApp import bundle write request contract',
      },
      {
        regex: /\bpub enum MiniAppImportBundlePlanError\b/,
        message: 'missing MiniApp import bundle plan error classification',
      },
      {
        regex: /\bpub fn build_import_bundle_plan\b/,
        message: 'missing MiniApp import bundle plan helper',
      },
      {
        regex: /\bpub fn draft_dir\b/,
        message: 'missing MiniApp draft directory layout helper',
      },
      {
        regex: /\bpub fn customization_path\b/,
        message: 'missing MiniApp customization metadata path helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/lifecycle.rs',
    reason:
      'product-domains owns pure MiniApp lifecycle state transitions while core keeps compile/manager workflow and services-integrations keeps storage/runtime IO',
    patterns: [
      {
        regex: /\bpub fn mark_deps_installed_state\b/,
        message: 'missing MiniApp deps-installed state helper',
      },
      {
        regex: /\bpub struct MiniAppCreateInput\b/,
        message: 'missing MiniApp create input contract',
      },
      {
        regex: /\bpub struct MiniAppUpdatePatch\b/,
        message: 'missing MiniApp update patch contract',
      },
      {
        regex: /\bpub fn build_created_app\b/,
        message: 'missing MiniApp create state helper',
      },
      {
        regex: /\bpub fn apply_update_patch\b/,
        message: 'missing MiniApp update state helper',
      },
      {
        regex: /\bpub fn prepare_draft_app\b/,
        message: 'missing MiniApp draft prepare state helper',
      },
      {
        regex: /\bpub fn apply_draft_source_sync_result\b/,
        message: 'missing MiniApp draft source-sync state helper',
      },
      {
        regex: /\bpub fn apply_draft_permission_update_result\b/,
        message: 'missing MiniApp draft permission-update state helper',
      },
      {
        regex: /\bpub fn apply_draft_to_active\b/,
        message: 'missing MiniApp draft apply state helper',
      },
      {
        regex: /\bpub fn clear_worker_restart_required_state\b/,
        message: 'missing MiniApp worker-restart clear state helper',
      },
      {
        regex: /\bpub fn prepare_rollback_app\b/,
        message: 'missing MiniApp rollback state helper',
      },
      {
        regex: /\bpub fn apply_recompile_result\b/,
        message: 'missing MiniApp recompile result state helper',
      },
      {
        regex: /\bpub fn apply_sync_from_fs_result\b/,
        message: 'missing MiniApp sync-from-fs state helper',
      },
      {
        regex: /\bpub fn apply_import_runtime_state\b/,
        message: 'missing MiniApp import runtime state helper',
      },
      {
        regex: /\bpub fn prepare_imported_meta\b/,
        message: 'missing MiniApp imported metadata identity/timestamp helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/draft.rs',
    reason:
      'product-domains owns MiniApp draft DTO and response shape while services-integrations keeps draft filesystem IO',
    patterns: [
      {
        regex: /\bpub struct MiniAppDraftManifest\b/,
        message: 'missing MiniApp draft manifest DTO',
      },
      {
        regex: /\bpub struct MiniAppDraft\b/,
        message: 'missing MiniApp draft response DTO',
      },
      {
        regex: /\bpub fn build_draft_manifest\b/,
        message: 'missing MiniApp draft manifest helper',
      },
      {
        regex: /\bpub fn build_draft_response\b/,
        message: 'missing MiniApp draft response helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/runtime.rs',
    reason:
      'product-domains owns MiniApp runtime detection, including the reviewed concrete PATH/fs/version probe',
    patterns: [
      {
        regex: /\bpub fn detect_runtime\b/,
        message: 'missing MiniApp concrete runtime detector',
      },
      {
        regex: /\bstruct DefaultMiniAppRuntimeProbe\b/,
        message: 'missing MiniApp default runtime probe owner',
      },
      {
        regex: /\bwhich::which\b/,
        message: 'missing MiniApp PATH lookup owner',
      },
      {
        regex: /\bstd::fs::read_dir\b/,
        message: 'missing MiniApp version-manager directory scan owner',
      },
      {
        regex: /\bcreate_version_command\b/,
        message: 'missing MiniApp version process command owner',
      },
      {
        regex: /\bpub fn runtime_lookup_order\b/,
        message: 'missing MiniApp runtime lookup order contract',
      },
      {
        regex: /\bpub trait MiniAppRuntimeProbe\b/,
        message: 'missing MiniApp runtime probe contract',
      },
      {
        regex: /\bpub fn detect_runtime_with_probe\b/,
        message: 'missing MiniApp runtime detector facade',
      },
      {
        regex: /\bpub fn candidate_executable_path\b/,
        message: 'missing MiniApp runtime candidate executable helper',
      },
      {
        regex: /\bpub fn versioned_executable_candidate\b/,
        message: 'missing MiniApp version-manager executable helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/worker.rs',
    reason:
      'product-domains owns MiniApp worker pool policy and install-deps planning while services-integrations owns worker process execution',
    patterns: [
      {
        regex: /\bpub enum InstallDepsPlan\b/,
        message: 'missing MiniApp install-deps plan contract',
      },
      {
        regex: /\bpub fn plan_install_deps\b/,
        message: 'missing MiniApp install-deps planning helper',
      },
      {
        regex: /\bpub fn worker_pool_capacity\b/,
        message: 'missing MiniApp worker pool capacity policy helper',
      },
      {
        regex: /\bpub fn worker_idle_timeout_ms\b/,
        message: 'missing MiniApp worker idle timeout policy helper',
      },
      {
        regex: /\bpub fn worker_is_idle\b/,
        message: 'missing MiniApp worker idle policy helper',
      },
      {
        regex: /\bpub fn select_lru_worker\b/,
        message: 'missing MiniApp worker LRU selection helper',
      },
      {
        regex: /\binstall_deps_plan_preserves_no_package_noop_and_runtime_commands\b/,
        message: 'missing MiniApp install-deps planning regression test',
      },
      {
        regex: /\bworker_pool_policy_keeps_existing_capacity_and_idle_timeout_contract\b/,
        message: 'missing MiniApp worker pool policy regression test',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/host_routing.rs',
    reason:
      'product-domains owns MiniApp host-routing and allowlist decision policy while core keeps host execution',
    patterns: [
      {
        regex: /\bpub fn split_host_method\b/,
        message: 'missing MiniApp host method split helper',
      },
      {
        regex: /\bpub enum FsAccessMode\b/,
        message: 'missing MiniApp fs access mode contract',
      },
      {
        regex: /\bpub fn fs_method_access_mode\b/,
        message: 'missing MiniApp fs access mode helper',
      },
      {
        regex: /\bpub enum MiniAppFsHostCallPlan\b/,
        message: 'missing MiniApp fs host-call plan contract',
      },
      {
        regex: /\bpub fn plan_fs_host_call\b/,
        message: 'missing MiniApp fs host-call planner',
      },
      {
        regex: /\bpub fn plan_fs_legacy_path_check\b/,
        message: 'missing MiniApp legacy fs path-gate planner',
      },
      {
        regex: /\bpub fn fs_policy_scopes\b/,
        message: 'missing MiniApp fs policy scope helper',
      },
      {
        regex: /\bpub fn fs_resolved_path_allowed\b/,
        message: 'missing MiniApp fs resolved path helper',
      },
      {
        regex: /\bpub fn command_basename_for_allowlist\b/,
        message: 'missing MiniApp command basename allowlist helper',
      },
      {
        regex: /\bpub fn command_basename_allowed\b/,
        message: 'missing MiniApp command allowlist policy helper',
      },
      {
        regex: /\bpub fn host_allowed_by_allowlist\b/,
        message: 'missing MiniApp host allowlist policy helper',
      },
      {
        regex: /\bpub fn shell_exec_first_token\b/,
        message: 'missing MiniApp shell first-token policy helper',
      },
      {
        regex: /\bpub fn shell_exec_input_is_empty\b/,
        message: 'missing MiniApp shell empty-input policy helper',
      },
      {
        regex: /\bpub fn shell_exec_cwd\b/,
        message: 'missing MiniApp shell cwd policy helper',
      },
      {
        regex: /\bpub fn shell_exec_timeout_ms\b/,
        message: 'missing MiniApp shell timeout policy helper',
      },
      {
        regex: /\bpub fn shell_exec_default_env\b/,
        message: 'missing MiniApp shell env policy helper',
      },
      {
        regex: /\bpub struct MiniAppShellHostCallPlan\b/,
        message: 'missing MiniApp shell host-call plan contract',
      },
      {
        regex: /\bpub fn plan_shell_host_call\b/,
        message: 'missing MiniApp shell host-call planner',
      },
      {
        regex: /\bfs_method_access_mode_preserves_access_bypass_and_default_read_contract\b/,
        message: 'missing MiniApp fs access mode regression test',
      },
      {
        regex: /\bfs_policy_scopes_and_resolved_prefix_check_preserve_path_boundary\b/,
        message: 'missing MiniApp fs path policy regression test',
      },
      {
        regex: /\bshell_exec_first_token_prefers_argv_over_shell_command_text\b/,
        message: 'missing MiniApp shell first-token regression test',
      },
      {
        regex: /\bshell_exec_plan_helpers_preserve_defaults_and_precedence\b/,
        message: 'missing MiniApp shell plan regression test',
      },
      {
        regex: /\bminiapp_host_fs_call_plans_preserve_existing_path_and_permission_contract\b/,
        message: 'missing MiniApp fs host-call plan regression test',
      },
      {
        regex: /\bminiapp_host_shell_call_plans_preserve_existing_input_and_default_contract\b/,
        message: 'missing MiniApp shell host-call plan regression test',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/exporter.rs',
    reason:
      'product-domains owns MiniApp export check result policy while core keeps runtime detection',
    patterns: [
      {
        regex: /\bpub const MISSING_JS_RUNTIME_MESSAGE\b/,
        message: 'missing MiniApp export missing-runtime message contract',
      },
      {
        regex: /\bpub fn export_runtime_label\b/,
        message: 'missing MiniApp export runtime label helper',
      },
      {
        regex: /\bpub fn build_export_check_result\b/,
        message: 'missing MiniApp export check result helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/exporter.rs',
    reason:
      'core MiniApp exporter must delegate export check result policy while retaining runtime detection and export skeleton',
    patterns: [
      {
        regex: /\bdetect_runtime\b/,
        message: 'missing core-owned MiniApp export runtime detection',
      },
      {
        regex: /\bbuild_export_check_result\b/,
        message: 'missing product-domain MiniApp export check helper use',
      },
      {
        regex: /Export not yet implemented \(skeleton\)/,
        message: 'missing core-owned MiniApp export skeleton behavior',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/customization.rs',
    reason:
      'product-domains owns MiniApp customization metadata, built-in update policy, and permission-diff contracts while core keeps draft storage/runtime',
    patterns: [
      {
        regex: /\bpub struct MiniAppCustomizationMetadata\b/,
        message: 'missing MiniApp customization metadata contract',
      },
      {
        regex: /\bpub struct MiniAppDeclinedBuiltinUpdate\b/,
        message: 'missing MiniApp declined built-in update contract',
      },
      {
        regex: /\bpub struct MiniAppPermissionDiff\b/,
        message: 'missing MiniApp permission diff contract',
      },
      {
        regex: /\bpub fn diff_permissions\b/,
        message: 'missing MiniApp permission diff helper',
      },
      {
        regex: /\bpub fn apply_draft_customization_metadata\b/,
        message: 'missing MiniApp customization draft-apply helper',
      },
      {
        regex: /\bpub fn mark_builtin_update_available_metadata\b/,
        message: 'missing MiniApp built-in update availability helper',
      },
      {
        regex: /\bpub fn decline_builtin_update_metadata\b/,
        message: 'missing MiniApp built-in update decline helper',
      },
      {
        regex: /\bpub fn is_current_declined_builtin_update\b/,
        message: 'missing MiniApp declined update current-state helper',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/manager.rs',
    reason:
      'core MiniApp manager must delegate manager workflow persistence and compile request/path adaptation to product-domain facades while retaining product orchestration and built-in source-hash lookup',
    patterns: [
      {
        regex: /\bMiniAppRuntimeFacade\b/,
        message: 'missing product-domain MiniApp runtime-state facade use',
      },
      {
        regex: /\bcreate_app\b/,
        message: 'missing product-domain MiniApp create workflow facade delegation',
      },
      {
        regex: /\bpersist_update_result_for_app\b/,
        message: 'missing product-domain MiniApp update workflow facade delegation',
      },
      {
        regex: /\bpersist_draft_for_app\b/,
        message: 'missing product-domain MiniApp create-draft workflow facade delegation',
      },
      {
        regex: /\bpersist_draft_source_sync_result\b/,
        message: 'missing product-domain MiniApp draft source-sync workflow facade delegation',
      },
      {
        regex: /\bpersist_draft_permission_update_result\b/,
        message: 'missing product-domain MiniApp draft permission workflow facade delegation',
      },
      {
        regex: /\bapply_draft_app\b/,
        message: 'missing product-domain MiniApp apply-draft workflow facade delegation',
      },
      {
        regex: /\bmark_builtin_update_available\b/,
        message: 'missing product-domain MiniApp built-in update workflow facade delegation',
      },
      {
        regex: /\bdecline_builtin_update\b/,
        message: 'missing product-domain MiniApp built-in update decline workflow facade delegation',
      },
      {
        regex: /\bCoreProductDomainRuntime\b/,
        message: 'missing core-owned product-domain runtime owner delegation',
      },
      {
        regex: /\bpersist_sync_from_fs_result_for_app\b/,
        message: 'missing product-domain MiniApp sync-from-fs facade delegation',
      },
      {
        regex: /\bcompile_source\b/,
        message: 'missing core MiniApp compile compatibility entry point',
      },
      {
        regex: /\bMiniAppCompileRequest::from_paths\b/,
        message: 'missing product-domain MiniApp compile request/path delegation',
      },
      {
        regex: /\bcompile_with_request\b/,
        message: 'missing product-domain MiniApp compile facade delegation',
      },
      {
        regex: /\bMiniAppPermissionPolicyRequest::from_paths\b/,
        message: 'missing product-domain MiniApp permission policy request/path delegation',
      },
      {
        regex: /\bresolve_policy_with_request\b/,
        message: 'missing product-domain MiniApp permission policy facade delegation',
      },
      {
        regex: /\bMiniAppCompilePort\b/,
        message: 'missing core MiniApp compile port adapter for product-domain import workflow',
      },
      {
        regex: /\bMiniAppImportFromPathRequest\b/,
        message: 'missing product-domain MiniApp import workflow request delegation',
      },
      {
        regex: /\.import_from_path\s*\(/,
        message: 'missing product-domain MiniApp import workflow facade delegation',
      },
      {
        regex: /\bruntime_preflight_preserves_recompile_sync_rollback_and_deps_state\b/,
        message: 'missing MiniApp manager runtime preflight regression test',
      },
      {
        regex: /\bimport_from_path_preserves_fallback_files_recompile_and_runtime_state\b/,
        message: 'missing MiniApp import runtime preflight regression test',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/compiler.rs',
    reason:
      'product-domains owns MiniApp compile request, path adaptation, and provider-neutral compile assembly while core keeps lifecycle orchestration',
    patterns: [
      {
        regex: /\bpub struct MiniAppCompileRequest\b/,
        message: 'missing MiniApp compile request owner',
      },
      {
        regex: /\bpub fn from_paths\b/,
        message: 'missing MiniApp compile path-adaptation helper',
      },
      {
        regex: /\bpub fn compile_with_request\b/,
        message: 'missing MiniApp compile request facade',
      },
      {
        regex: /\bcompile_request_from_paths_preserves_runtime_paths\b/,
        message: 'missing MiniApp compile path regression test',
      },
      {
        regex: /\bcompile_with_request_preserves_legacy_compile_output\b/,
        message: 'missing MiniApp compile request output regression test',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/permission_policy.rs',
    reason:
      'product-domains owns MiniApp permission policy request, path-scope expansion, and granted-path merging while core keeps grant storage',
    patterns: [
      {
        regex: /\bpub struct MiniAppPermissionPolicyRequest\b/,
        message: 'missing MiniApp permission policy request owner',
      },
      {
        regex: /\bpub fn from_paths\b/,
        message: 'missing MiniApp permission path request helper',
      },
      {
        regex: /\bpub fn resolve_policy_with_request\b/,
        message: 'missing MiniApp permission request facade',
      },
      {
        regex: /\bpermission_policy_request_preserves_path_scope_and_granted_paths\b/,
        message: 'missing MiniApp permission path/grant regression test',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/runtime_facade.rs',
    reason:
      'product-domains owns MiniApp manager workflow and runtime-state facade while services-integrations keeps concrete storage/worker/host IO and core keeps compile workflow',
    patterns: [
      {
        regex: /\bpub struct MiniAppRuntimeFacade\b/,
        message: 'missing MiniApp runtime-state facade',
      },
      {
        regex: /\bpub async fn create_app\b/,
        message: 'missing MiniApp create workflow facade owner',
      },
      {
        regex: /\bpub async fn persist_update_result_for_app\b/,
        message: 'missing MiniApp update workflow facade owner',
      },
      {
        regex: /\bpub async fn persist_draft_for_app\b/,
        message: 'missing MiniApp draft creation workflow facade owner',
      },
      {
        regex: /\bpub async fn persist_draft_source_sync_result\b/,
        message: 'missing MiniApp draft source-sync workflow facade owner',
      },
      {
        regex: /\bpub async fn persist_draft_permission_update_result\b/,
        message: 'missing MiniApp draft permission workflow facade owner',
      },
      {
        regex: /\bpub async fn apply_draft_app\b/,
        message: 'missing MiniApp apply-draft workflow facade owner',
      },
      {
        regex: /\bpub async fn mark_builtin_update_available\b/,
        message: 'missing MiniApp built-in update workflow facade owner',
      },
      {
        regex: /\bmark_deps_installed_state\b/,
        message: 'missing MiniApp deps-installed state transition in facade',
      },
      {
        regex: /\bpersist_sync_from_fs_result_for_app\b/,
        message: 'missing MiniApp sync-from-fs preloaded snapshot facade path',
      },
      {
        regex: /\bpersist_import_runtime_state\b/,
        message: 'missing MiniApp import runtime-state facade path',
      },
      {
        regex: /\bpub async fn import_from_path\b/,
        message: 'missing MiniApp import workflow facade owner',
      },
      {
        regex: /\bMiniAppImportPort\b/,
        message: 'missing MiniApp import IO port boundary',
      },
      {
        regex: /\bMiniAppCompilePort\b/,
        message: 'missing MiniApp compile port boundary',
      },
      {
        regex: /\bMiniAppImportBundleWriteRequest\b/,
        message: 'missing MiniApp import bundle write request use',
      },
      {
        regex: /\bbuild_import_bundle_plan\b/,
        message: 'missing MiniApp import bundle plan use inside product-domain facade',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/function_agents/port_adapters.rs',
    reason:
      'core function-agent port adapters must continue owning AI concrete calls while product-domains owns Git prompt, parser, and facade policy',
    patterns: [
      {
        regex: /\bprepare_commit_ai_prompt\b/,
        message: 'missing product-domain Git function-agent prompt policy use',
      },
      {
        regex: /\bparse_commit_ai_response\b/,
        message: 'missing product-domain Git function-agent response policy use',
      },
      {
        regex: /\bai_client\s*\.\s*send_message\b/,
        message: 'missing core-owned function-agent AI call',
      },
      {
        regex: /\bAgentError::internal_error\b/,
        message: 'missing core-owned function-agent AI transport error mapping',
      },
      {
        regex: /\bCoreCommitAiAnalysisService\b/,
        message: 'missing core-owned commit AI concrete service',
      },
      {
        regex: /\bparse_commit_response_preserves_product_domain_response_policy\b/,
        message: 'missing Git function-agent AI response boundary regression test',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/function_agents.rs',
    reason:
      'services-integrations must own function-agent concrete Git snapshots without depending on openbitfun-core',
    patterns: [
      {
        regex: /\bpub struct FunctionAgentGitService\b/,
        message: 'missing function-agent Git service owner',
      },
      {
        regex: /\bgit_commit_snapshot\b/,
        message: 'missing commit snapshot service method',
      },
      {
        regex: /\bGitService::get_status\b/,
        message: 'missing shared GitService status lookup',
      },
      {
        regex: /\bGitService::get_diff\b/,
        message: 'missing shared GitService staged diff lookup',
      },
      {
        regex: /\bContextAnalyzer::analyze_project_context\b/,
        message: 'missing product-domain project context analysis',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/tests/function_agent_contracts.rs',
    reason:
      'services-integrations function-agent Git service must preserve commit snapshot behavior',
    patterns: [
      {
        regex: /\bgit_service_builds_commit_snapshot_from_staged_diff_without_unstaged_content\b/,
        message: 'missing staged/unstaged boundary regression test',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/function_agents/git-func-agent/ai_service.rs',
    reason:
      'legacy Git function-agent AI service path must remain a compatibility re-export only',
    patterns: [
      {
        regex: /\bCoreCommitAiAnalysisService as AIAnalysisService\b/,
        message: 'missing Git function-agent AI service compatibility re-export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/function_agents/git-func-agent/commit_generator.rs',
    reason:
      'legacy Git commit generator must delegate to the core product-domain runtime owner',
    patterns: [
      {
        regex: /\bCoreProductDomainRuntime\b/,
        message: 'missing core product-domain runtime owner routing',
      },
      {
        regex: /\bgenerate_function_agent_commit_message\b/,
        message: 'missing Git commit owner method delegation',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/miniapp/builtin.rs',
    reason:
      'product-domains owns built-in MiniApp bundle assets, marker, hash, seed orchestration, and host adapter contract while core keeps concrete IO and recompilation',
    patterns: [
      {
        regex: /\bpub const BUILTIN_APPS\b/,
        message: 'missing built-in MiniApp bundle asset owner',
      },
      {
        regex: /\bpub struct BuiltinMiniAppBundle\b/,
        message: 'missing built-in MiniApp bundle contract',
      },
      {
        regex: /\bpub struct BuiltinInstallMarker\b/,
        message: 'missing built-in MiniApp install marker contract',
      },
      {
        regex: /\bpub const BUILTIN_INSTALL_MARKER\b/,
        message: 'missing built-in MiniApp marker filename contract',
      },
      {
        regex: /\bpub fn builtin_content_hash\b/,
        message: 'missing built-in MiniApp content hash helper',
      },
      {
        regex: /\bpub fn should_seed_builtin_app\b/,
        message: 'missing built-in MiniApp seed decision helper',
      },
      {
        regex: /\bpub struct BuiltinSeedArtifacts\b/,
        message: 'missing built-in MiniApp seed artifacts contract',
      },
      {
        regex: /\bpub enum BuiltinSeedCheck\b/,
        message: 'missing built-in MiniApp seed check contract',
      },
      {
        regex: /\bpub enum BuiltinSeedAction\b/,
        message: 'missing built-in MiniApp seed action contract',
      },
      {
        regex: /\bpub trait BuiltinMiniAppSeedHost\b/,
        message: 'missing built-in MiniApp seed host adapter contract',
      },
      {
        regex: /\bpub async fn seed_builtin_miniapps_with_host\b/,
        message: 'missing built-in MiniApp seed orchestrator',
      },
      {
        regex: /\bpub async fn seed_builtin_miniapp_with_host\b/,
        message: 'missing built-in MiniApp single-bundle seed orchestrator',
      },
      {
        regex: /\bpub enum BuiltinMiniAppSeedOutcome\b/,
        message: 'missing built-in MiniApp seed outcome contract',
      },
      {
        regex: /\bpub fn resolve_builtin_seed_check\b/,
        message: 'missing built-in MiniApp seed check helper',
      },
      {
        regex: /\bpub fn resolve_builtin_seed_action\b/,
        message: 'missing built-in MiniApp seed action helper',
      },
      {
        regex: /\bpub fn serialize_builtin_install_marker\b/,
        message: 'missing built-in MiniApp marker serialization helper',
      },
      {
        regex: /\bpub fn parse_builtin_install_marker\b/,
        message: 'missing built-in MiniApp marker parse helper',
      },
      {
        regex: /\bpub fn builtin_source_files\b/,
        message: 'missing built-in MiniApp source payload helper',
      },
      {
        regex: /\bpub const BUILTIN_PLACEHOLDER_COMPILED_HTML\b/,
        message: 'missing built-in MiniApp placeholder payload contract',
      },
      {
        regex: /\bpub fn build_builtin_package_json\b/,
        message: 'missing built-in MiniApp package payload helper',
      },
      {
        regex: /\bpub fn preserved_builtin_created_at\b/,
        message: 'missing built-in MiniApp created-at preservation helper',
      },
      {
        regex: /\bpub fn build_builtin_seed_meta\b/,
        message: 'missing built-in MiniApp seed meta helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/function_agents/ports.rs',
    reason:
      'product-domains owns port-backed function-agent facade orchestration while providers/core keep concrete Git/AI runtime calls',
    patterns: [
      {
        regex: /\bpub struct FunctionAgentRuntimeFacade\b/,
        message: 'missing function-agent runtime facade',
      },
      {
        regex: /\bgenerate_commit_message\b/,
        message: 'missing function-agent commit facade orchestration',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/function_agents/common.rs',
    reason:
      'product-domains owns function-agent AI response JSON extraction while core keeps concrete AI clients',
    patterns: [
      {
        regex: /\bfn extract_json_from_ai_response\b/,
        message: 'missing function-agent AI response JSON extraction helper',
      },
      {
        regex: /\bfn try_repair_json\b/,
        message: 'missing function-agent AI response JSON repair helper',
      },
    ],
  },
  {
    path: 'src/crates/contracts/product-domains/src/function_agents/git_func_agent/utils.rs',
    reason:
      'product-domains owns Git function-agent prompt and response policy while core keeps AI calls',
    patterns: [
      {
        regex: /\bpub const COMMIT_MESSAGE_PROMPT\b/,
        message: 'missing product-domain Git function-agent prompt template',
      },
      {
        regex: /\bpub fn parse_commit_analysis_value\b/,
        message: 'missing Git function-agent commit analysis value parser',
      },
      {
        regex: /\bpub fn parse_commit_analysis_json\b/,
        message: 'missing Git function-agent commit analysis JSON parser',
      },
      {
        regex: /\bpub fn truncate_diff_for_commit_prompt\b/,
        message: 'missing Git function-agent diff truncation helper',
      },
      {
        regex: /\bpub fn prepare_commit_prompt\b/,
        message: 'missing Git function-agent prompt preparation helper',
      },
      {
        regex: /\bpub fn prepare_commit_ai_prompt\b/,
        message: 'missing Git function-agent AI prompt policy',
      },
      {
        regex: /\bpub fn parse_commit_ai_response\b/,
        message: 'missing Git function-agent AI response policy',
      },
      {
        regex: /\bcommit_ai_response_policy_extracts_json_and_maps_domain_errors\b/,
        message: 'missing Git function-agent AI response policy regression test',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/runtime_detect.rs',
    reason:
      'core MiniApp runtime detection must be a compatibility facade over product-domain runtime detection',
    patterns: [
      {
        regex: /\bpub use openbitfun_product_domains::miniapp::runtime::\{/,
        message: 'missing product-domain MiniApp runtime facade re-export',
      },
      {
        regex: /\bdetect_runtime\b/,
        message: 'missing product-domain detect_runtime facade export',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/js_worker_pool.rs',
    reason:
      'core MiniApp worker pool path must stay a compatibility facade over the integrations owner',
    patterns: [
      {
        regex: /\bServiceJsWorkerPool\b/,
        message: 'missing services-owned MiniApp worker pool delegation',
      },
      {
        regex: /\bCoreMiniAppWorkerEventSink\b/,
        message: 'missing core MiniApp worker event compatibility sink',
      },
      {
        regex: /\bemit_global_event\b/,
        message: 'missing MiniApp worker event bridge to existing core event bus',
      },
      {
        regex: /\bmap_worker_pool_error\b/,
        message: 'missing MiniApp worker pool error compatibility mapping',
      },
      {
        regex: /\bimpl MiniAppRuntimePort for JsWorkerPool\b/,
        message: 'missing MiniApp runtime port adapter owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/miniapp/js_worker.rs',
    reason:
      'core MiniApp JS worker path must stay a compatibility re-export over the integrations owner',
    patterns: [
      {
        regex: /\bpub use openbitfun_services_integrations::miniapp::worker::\{/,
        message: 'missing services-owned MiniApp JS worker facade re-export',
      },
      {
        regex: /\bMiniAppWorkerEventSink\b/,
        message: 'missing MiniApp worker event sink facade export',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/miniapp/worker.rs',
    reason:
      'services-integrations must own MiniApp JS worker process spawning and RPC routing behind the miniapp-runtime feature',
    patterns: [
      {
        regex: /\bpub struct JsWorker\b/,
        message: 'missing services-owned MiniApp JS worker process owner',
      },
      {
        regex: /\bpub trait MiniAppWorkerEventSink\b/,
        message: 'missing MiniApp worker event sink contract',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message: 'missing services-owned MiniApp JS worker process spawning',
      },
      {
        regex: /\bPendingResponseMap\b/,
        message: 'missing MiniApp worker JSON-RPC pending-response routing owner',
      },
      {
        regex: /\buuid::Uuid::new_v4\b/,
        message: 'missing MiniApp worker RPC id generation owner',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/miniapp/worker_pool.rs',
    reason:
      'services-integrations must own MiniApp JS worker pool lifecycle, install-deps execution, and runtime port implementation behind the miniapp-runtime feature',
    patterns: [
      {
        regex: /\bpub struct JsWorkerPool\b/,
        message: 'missing services-owned MiniApp JS worker pool owner',
      },
      {
        regex: /\bMiniAppWorkerPoolError\b/,
        message: 'missing MiniApp worker pool integration error type',
      },
      {
        regex: /\bworker_pool_at_capacity\b/,
        message: 'missing product-domain worker capacity policy use',
      },
      {
        regex: /\bselect_lru_worker\b/,
        message: 'missing product-domain worker LRU policy use',
      },
      {
        regex: /\bplan_install_deps\b/,
        message: 'missing product-domain install-deps plan use',
      },
      {
        regex: /\bprocess_manager::create_tokio_command\b/,
        message: 'missing services-owned MiniApp install-deps process execution',
      },
      {
        regex: /\bimpl MiniAppRuntimePort for JsWorkerPool\b/,
        message: 'missing MiniApp runtime port implementation in integrations owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/function_agents/port_adapters.rs',
    reason:
      'core function-agent port adapters must stay thin adapters over integration Git services and core AI services',
    patterns: [
      {
        regex: /\bpub struct CoreFunctionAgentGitAdapter\b/,
        message: 'missing core function-agent Git adapter type',
      },
      {
        regex: /\bimpl FunctionAgentGitPort for CoreFunctionAgentGitAdapter\b/,
        message: 'missing function-agent Git port adapter owner',
      },
      {
        regex: /\bpub struct CoreFunctionAgentAiAdapter\b/,
        message: 'missing core function-agent AI adapter type',
      },
      {
        regex: /\bimpl FunctionAgentAiPort for CoreFunctionAgentAiAdapter\b/,
        message: 'missing function-agent AI port adapter owner',
      },
      {
        regex: /\bFunctionAgentGitService::git_commit_snapshot\b/,
        message: 'missing Git adapter delegation to integration runtime service',
      },
      {
        regex: /\bCoreCommitAiAnalysisService::new_with_task_config\b/,
        message: 'missing commit AI adapter delegation to concrete runtime service',
      },
      {
        regex: /\bgit_adapter_commit_snapshot_keeps_staged_diff_and_unstaged_count_separate\b/,
        message: 'missing function-agent Git snapshot boundary regression test',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/product_domain_runtime.rs',
    reason:
      'core product-domain runtime owner must centralize concrete MiniApp and function-agent runtime port bindings without moving runtime behavior',
    patterns: [
      {
        regex: /\bpub\(crate\) struct CoreProductDomainRuntime\b/,
        message: 'missing core product-domain runtime owner type',
      },
      {
        regex: /\bfn miniapp_runtime_facade\b/,
        message: 'missing MiniApp runtime facade owner factory',
      },
      {
        regex: /\bfn function_agent_git_adapter\b/,
        message: 'missing function-agent Git adapter owner factory',
      },
      {
        regex: /\bfn function_agent_ai_adapter\b/,
        message: 'missing function-agent AI adapter owner factory',
      },
      {
        regex: /\bfn function_agent_runtime_facade\b/,
        message: 'missing function-agent runtime facade owner factory',
      },
      {
        regex: /\bfn generate_function_agent_commit_message\b/,
        message: 'missing Git function-agent concrete runtime owner entrypoint',
      },
      {
        regex: /\bCoreFunctionAgentGitAdapter\b/,
        message: 'missing core-owned Git adapter binding',
      },
      {
        regex: /\bCoreFunctionAgentAiAdapter\b/,
        message: 'missing core-owned AI adapter binding',
      },
      {
        regex: /\bMiniAppRuntimeFacade\b/,
        message: 'missing MiniApp product-domain facade binding',
      },
      {
        regex: /\bMiniAppStoragePort\b/,
        message: 'missing MiniApp storage port owner binding',
      },
      {
        regex: /\bFunctionAgentRuntimeFacade\b/,
        message: 'missing function-agent product-domain facade binding',
      },
      {
        regex: /\bFunctionAgentGitPort\b/,
        message: 'missing function-agent Git port owner binding',
      },
      {
        regex: /\bFunctionAgentAiPort\b/,
        message: 'missing function-agent AI port owner binding',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/mod.rs',
    reason:
      'openbitfun-core service facades must compile only when their explicit capability profile is selected',
    patterns: [
      {
        regex: /#\[cfg\(feature = "dispatch-store"\)\]\s*pub mod dispatch\b/s,
        message: 'dispatch store facade must stay gated behind dispatch-store',
      },
      {
        regex: /#\[cfg\(feature = "remote-workspace"\)\]\s*pub mod remote_ssh\b/s,
        message: 'remote workspace facade must stay gated behind remote-workspace',
      },
      {
        regex: /#\[cfg\(feature = "workspace-runtime"\)\]\s*pub mod workspace\b/s,
        message: 'workspace facade must stay gated behind workspace-runtime',
      },
      {
        regex: /#\[cfg\(feature = "terminal"\)\]\s*pub use terminal_core as terminal\b/s,
        message: 'terminal compatibility export must stay gated behind terminal',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/session/mod.rs',
    reason: 'libgit2-backed memory workspace behavior must remain isolated from the reusable session profile',
    patterns: [
      {
        regex: /#\[cfg\(feature = "session-git"\)\]\s*mod memory_workspace\b/s,
        message: 'memory workspace implementation must stay gated behind session-git',
      },
      {
        regex: /#\[cfg\(feature = "session-git"\)\]\s*pub use memory_workspace\b/s,
        message: 'memory workspace exports must stay gated behind session-git',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/remote_ssh/paths.rs',
    reason:
      'remote SSH must preserve its public path while delegating stable workspace identity to services-core',
    patterns: [
      {
        regex: /pub use openbitfun_services_core::workspace_identity::\*/,
        message: 'remote SSH path compatibility module must re-export the services-core owner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/workspace/service.rs',
    reason:
      'local workspace profiles must use stable service-owned identity and fail closed for unavailable remote runtime behavior',
    patterns: [
      {
        regex: /use openbitfun_services_core::workspace_identity::\{/,
        message: 'workspace service must consume the services-core identity owner directly',
      },
      {
        regex: /Remote workspace support is not compiled into this product profile/,
        message: 'workspace service must report an explicit unsupported state without remote-workspace',
      },
    ],
  },
  {
    path: 'src/apps/server/src/bootstrap.rs',
    reason:
      'Server must remain on the canonical Core Agent Runtime and product event-queue owners',
    patterns: [
      {
        regex: /init_agentic_system_for_profile_with_runtime_ownership\s*\(/,
        message: 'Server bootstrap must use the canonical Core Agent Runtime initializer',
      },
      {
        regex: /CoreProductEventQueueOwner::new\s*\(/,
        message: 'Server bootstrap must retain the product event-queue owner',
      },
    ],
  },
  {
    path: 'src/apps/server/src/main.rs',
    reason:
      'Server App Server event projection must consume the product-owned runtime source',
    patterns: [
      {
        regex: /agent_event_queue_owner\.runtime_source\s*\(\s*\)/,
        message: 'Server must consume events through CoreProductEventQueueOwner',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/agentic/system.rs',
    reason:
      'the canonical Core Agent Runtime initializer must publish its token usage service for every embedded host',
    patterns: [
      {
        regex: /set_global_token_usage_service\s*\(\s*token_usage_service\.clone\s*\(\s*\)\s*\)/,
        message: 'canonical Agent Runtime initialization must publish token usage globally',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/src/tls_provider.rs',
    reason:
      'provider-neutral TLS clients must share the services-owned process-level ring selection',
    patterns: [
      {
        regex: /rustls::crypto::ring::default_provider\s*\(\s*\)\.install_default\s*\(\s*\)/,
        message: 'services-core TLS owner must install the workspace-owned ring provider',
      },
    ],
  },
  {
    path: 'src/crates/services/services-core/Cargo.toml',
    reason:
      'services-core must own the exact Rustls provider and protocol feature selection',
    patterns: [
      {
        regex: /rustls = \{ workspace = true, features = \["ring", "std", "tls12"\], optional = true \}/,
        message: 'services-core TLS owner must select only ring, std, and TLS 1.2 support',
      },
    ],
  },
  {
    path: 'src/crates/services/services-integrations/src/lib.rs',
    reason:
      'integration clients must initialize the reviewed TLS provider through centralized constructors',
    patterns: [
      {
        regex: /fn reqwest_client_builder[\s\S]*?ensure_ring_crypto_provider\s*\(\s*\)/,
        message: 'integration Reqwest builder must initialize the ring provider',
      },
      {
        regex: /fn reqwest_client\s*\([^)]*\)[\s\S]*?ensure_ring_crypto_provider\s*\(\s*\)/,
        message: 'integration default Reqwest client must initialize the ring provider',
      },
    ],
  },
  {
    path: 'src/crates/adapters/ai-adapters/src/client/http.rs',
    reason: 'AI transport clients must initialize the reviewed TLS provider before Reqwest',
    patterns: [
      {
        regex: /fn create_http_client[\s\S]*?ensure_ring_crypto_provider\s*\(\s*\)[\s\S]*?Client::builder\s*\(/,
        message: 'AI client construction must initialize the ring provider first',
      },
    ],
  },
  {
    path: 'src/crates/adapters/ai-adapters/src/subscription_auth/mod.rs',
    reason:
      'subscription authentication clients must initialize the same reviewed TLS provider as normal AI transport',
    patterns: [
      {
        regex: /fn build_http_client[\s\S]*?ensure_ring_crypto_provider\s*\(\s*\)[\s\S]*?reqwest::Client::builder\s*\(/,
        message: 'subscription HTTP client construction must initialize the ring provider first',
      },
    ],
  },
  {
    path: 'src/crates/services/miniapp-market-service/src/auth.rs',
    reason: 'MiniApp market HTTP clients must initialize the reviewed TLS provider',
    patterns: [
      {
        regex: /fn new\s*\([^)]*MarketConfig[\s\S]*?ensure_ring_crypto_provider\s*\(\s*\)[\s\S]*?reqwest::Client::builder\s*\(/,
        message: 'MiniApp market AuthService must initialize the ring provider first',
      },
    ],
  },
  {
    path: 'src/crates/services/skin-market-service/src/auth.rs',
    reason: 'appearance market HTTP clients must initialize the reviewed TLS provider',
    patterns: [
      {
        regex: /fn new\s*\([^)]*Url[\s\S]*?ensure_ring_crypto_provider\s*\(\s*\)[\s\S]*?Client::builder\s*\(/,
        message: 'appearance market IdentityVerifier must initialize the ring provider first',
      },
    ],
  },
  {
    path: 'src/crates/services/relay-service/src/identity.rs',
    reason: 'standalone Relay must bind its reviewed ring configuration to the identity client',
    patterns: [{
      regex: /let tls = rustls::ClientConfig::builder_with_provider\(Arc::new\(\s*rustls::crypto::ring::default_provider\(\),?\s*\)\)[\s\S]*?\.tls_backend_preconfigured\(tls\)/,
      message: 'Relay identity verification requires an explicit client-scoped ring config',
    }],
  },
];
