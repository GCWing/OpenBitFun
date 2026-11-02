//! Thin runtime ports for boundaries that currently cross service and agentic
//! concrete implementations.
//!
//! This crate intentionally contains only DTOs and traits. It must not depend
//! on concrete managers, platform adapters, `openbitfun-core`, or app crates.

use serde::{Deserialize, Serialize};

#[cfg(feature = "agent-api")]
pub use openbitfun_core_types::{
    SessionExecutionTarget, SessionExecutionTargetKind, SessionExecutionTargetRequest,
    SessionUsageReport, WorktreeError, WorktreeErrorCode, WorktreeLifecycle, WorktreeSettings,
    WorktreeSummary,
};

#[cfg(feature = "hook-function-runtime")]
mod hook_function;
#[cfg(feature = "workspace-ports")]
mod local_workspace_snapshot;
#[cfg(feature = "permission")]
mod permission;
#[cfg(feature = "plugin-runtime")]
mod plugin;
#[cfg(feature = "product-search")]
mod product_search;
#[cfg(feature = "ptc-runtime")]
mod ptc_tool;
#[cfg(feature = "script-tool-runtime")]
mod script_tool;
#[cfg(feature = "web-search-port")]
mod web_search;
#[cfg(feature = "hook-function-runtime")]
pub use hook_function::*;
#[cfg(feature = "workspace-ports")]
pub use local_workspace_snapshot::{
    LocalWorkspaceSnapshotPort, LocalWorkspaceSnapshotSessionRequest, LocalWorkspaceSnapshotStats,
    LocalWorkspaceSnapshotTurnRequest,
};
#[cfg(feature = "product-search")]
pub use openbitfun_product_domains::product_search::{
    SessionContentSearchRequest, SessionContentSearchResponse,
};
#[cfg(feature = "permission")]
pub use openbitfun_product_domains::tool_permissions::{
    deserialize_optional_permission_mode, resolve_child_permission_policy, resolve_permission_mode,
    resolve_permission_policy, wildcard_matches, ChildPermissionPolicyLayers, PermissionAuditEvent,
    PermissionAuditRecord, PermissionConstraintLayer, PermissionDelegationContext,
    PermissionEffect, PermissionEvaluator, PermissionGrant, PermissionGrantKey,
    PermissionInteractionConfig, PermissionMode, PermissionModeLayers, PermissionModeSource,
    PermissionPolicyConfig, PermissionPolicyLayers, PermissionPolicyPreset, PermissionReply,
    PermissionReplySource, PermissionRequest, PermissionRequestEvent, PermissionRequestSource,
    PermissionRequestSourceKind, PermissionResourceCaseSensitivity, PermissionRule,
    PermissionRuleset, PermissionRuntimeCeiling, PermissionRuntimeCeilingValidationError,
    ResolvedPermissionMode, ResolvedPermissionPolicy, ToolPermissionConfig,
};
#[cfg(feature = "permission")]
pub use permission::{
    PermissionAuditStorePort, PermissionGrantStorePort, PermissionReplyStorePort,
};
#[cfg(feature = "plugin-runtime")]
pub use plugin::{
    validate_plugin_dispatch_response, validate_plugin_runtime_read_response,
    DisabledPluginRuntimeClient, ExtensionCapabilityAvailability, PermissionPromptDenyState,
    PermissionPromptDescriptor, PermissionPromptEffectKind, PluginArtifactRef, PluginAuditRef,
    PluginCapabilityRef, PluginConfigValidationIssue, PluginConfigValidationState,
    PluginConfigValidationStatus, PluginDataClassification, PluginDiagnostic,
    PluginDiagnosticDetail, PluginDiagnosticSeverity, PluginDispatchEnvelope,
    PluginEffectCandidate, PluginEffectCandidatePayload, PluginHostLifecyclePhase,
    PluginManifestRef, PluginOwnerKind, PluginOwnerRef, PluginPayloadRedaction, PluginPayloadRef,
    PluginPermissionGate, PluginQuarantineClearCondition, PluginQuarantineReason,
    PluginQuarantineScope, PluginQuarantineState, PluginResponseEnvelope, PluginRiskLevel,
    PluginRollbackMode, PluginRollbackPolicy, PluginRuntimeAvailability, PluginRuntimeBinding,
    PluginRuntimeClient, PluginRuntimeEpochs, PluginRuntimeReadRequest, PluginRuntimeReadResponse,
    PluginRuntimeUnavailableReason, PluginSourceKind, PluginSourceRef, PluginStatusKind,
    PluginStatusSnapshot, PluginTargetRef, PluginTrustLevel, ProjectionOnlyPluginRuntimeClient,
};
#[cfg(feature = "product-search")]
pub use product_search::ProductSearchPort;
#[cfg(feature = "ptc-runtime")]
pub use ptc_tool::{
    PtcExecutionRequest, PtcExecutionResponse, PtcNestedToolCall, PtcRuntime,
    PtcRuntimeAvailability, PtcToolBinding, PtcToolCallHandler, PtcToolSpecRequest,
};
#[cfg(feature = "script-tool-runtime")]
pub use script_tool::{
    ScriptToolDescriptor, ScriptToolExpectedExport, ScriptToolInvokeRequest,
    ScriptToolInvokeResponse, ScriptToolLoadRequest, ScriptToolLoadResponse, ScriptToolRuntime,
    ScriptToolRuntimeAvailability,
};
#[cfg(feature = "web-search-port")]
pub use web_search::*;

pub type PortResult<T> = Result<T, PortError>;

/// Source geometry for a fixed-size ExecCommand PTY replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecTerminalSize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortErrorKind {
    NotAvailable,
    NotFound,
    InvalidRequest,
    PermissionDenied,
    Cancelled,
    Timeout,
    SessionInUse,
    CleanupRequired,
    OutcomeUnknown,
    Backend,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortError {
    pub kind: PortErrorKind,
    pub message: String,
}

impl PortError {
    pub fn new(kind: PortErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for PortError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeServiceCapability {
    FileSystem,
    Workspace,
    SessionStore,
    Permission,
    Events,
    Clock,
    Terminal,
    RemoteExec,
    Network,
    Git,
    McpCatalog,
    RemoteConnection,
    RemoteWorkspace,
    RemoteProjection,
    RemoteCapabilities,
    PtcRuntime,
}

impl RuntimeServiceCapability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FileSystem => "filesystem",
            Self::Workspace => "workspace",
            Self::SessionStore => "session_store",
            Self::Permission => "permission",
            Self::Events => "events",
            Self::Clock => "clock",
            Self::Terminal => "terminal",
            Self::RemoteExec => "remote_exec",
            Self::Network => "network",
            Self::Git => "git",
            Self::McpCatalog => "mcp_catalog",
            Self::RemoteConnection => "remote_connection",
            Self::RemoteWorkspace => "remote_workspace",
            Self::RemoteProjection => "remote_projection",
            Self::RemoteCapabilities => "remote_capabilities",
            Self::PtcRuntime => "ptc_runtime",
        }
    }
}

impl std::fmt::Display for RuntimeServiceCapability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub trait RuntimeServicePort: Send + Sync {
    fn capability(&self) -> RuntimeServiceCapability;
}

#[cfg(feature = "agent-api")]
mod agent_api;
#[cfg(feature = "git-port")]
mod git_port;
#[cfg(feature = "remote-exec-port")]
mod remote_exec_port;
#[cfg(feature = "remote-workspace-ports")]
mod remote_workspace_ports;
#[cfg(feature = "runtime-event-port")]
mod runtime_event_port;
mod service_markers;
#[cfg(feature = "terminal-port")]
mod terminal_port;
#[cfg(feature = "tool-runtime-handles")]
mod tool_runtime_handles;
#[cfg(feature = "workspace-ports")]
mod workspace_ports;

#[cfg(feature = "agent-api")]
pub use agent_api::*;
#[cfg(feature = "git-port")]
pub use git_port::*;
#[cfg(feature = "remote-exec-port")]
pub use remote_exec_port::*;
#[cfg(feature = "remote-workspace-ports")]
pub use remote_workspace_ports::*;
#[cfg(feature = "runtime-event-port")]
pub use runtime_event_port::*;
pub use service_markers::*;
#[cfg(feature = "terminal-port")]
pub use terminal_port::*;
#[cfg(feature = "tool-runtime-handles")]
pub use tool_runtime_handles::*;
#[cfg(feature = "workspace-ports")]
pub use workspace_ports::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum AgentSubmissionSource {
    DesktopUi,
    DesktopApi,
    AgentSession,
    ScheduledJob,
    RemoteRelay,
    Bot,
    Cli,
    SdkHost,
}

pub type DialogTriggerSource = AgentSubmissionSource;

/// User-managed related directory reference for request-context prompts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelatedPath {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicToolDescriptor {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
}

#[async_trait::async_trait]
pub trait DynamicToolProvider: Send + Sync {
    async fn list_dynamic_tools(&self) -> PortResult<Vec<DynamicToolDescriptor>>;
}

pub trait ToolDecorator<Tool>: Send + Sync {
    fn decorate(&self, tool: Tool) -> Tool;
}

#[async_trait::async_trait]
pub trait ConfigReadPort: Send + Sync {
    async fn get_config_value(&self, key: &str) -> PortResult<Option<serde_json::Value>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationScope {
    Standard,
    Swarm,
}

impl Default for DelegationScope {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DelegationPolicy {
    pub allow_subagent_spawn: bool,
    pub nesting_depth: u8,
    #[serde(default)]
    pub scope: DelegationScope,
}

impl Default for DelegationPolicy {
    fn default() -> Self {
        Self::top_level()
    }
}

impl DelegationPolicy {
    pub fn top_level() -> Self {
        Self {
            allow_subagent_spawn: true,
            nesting_depth: 0,
            scope: DelegationScope::Standard,
        }
    }

    pub fn swarm_root() -> Self {
        Self {
            allow_subagent_spawn: true,
            nesting_depth: 0,
            scope: DelegationScope::Swarm,
        }
    }

    pub fn spawn_child(self) -> Self {
        Self {
            allow_subagent_spawn: match self.scope {
                DelegationScope::Standard => false,
                DelegationScope::Swarm => self.allow_subagent_spawn,
            },
            nesting_depth: self.nesting_depth.saturating_add(1),
            scope: self.scope,
        }
    }

    pub fn spawn_child_for(self, agent_type: &str) -> Self {
        let is_swarm_planner = matches!(agent_type, "Ultimate" | "SwarmPlanner");
        Self {
            allow_subagent_spawn: self.scope == DelegationScope::Swarm && is_swarm_planner,
            nesting_depth: self.nesting_depth.saturating_add(1),
            scope: self.scope,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentContextMode {
    #[default]
    Fresh,
    Fork,
}

impl SubagentContextMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Fork => "fork",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_error_display_keeps_kind_and_message() {
        let error = PortError::new(PortErrorKind::NotAvailable, "coordinator missing");

        assert_eq!(
            error.to_string(),
            "NotAvailable: coordinator missing".to_string()
        );
    }

    #[test]
    fn dialog_trigger_source_reuses_agent_submission_source_contract() {
        let json = serde_json::to_value(DialogTriggerSource::Cli)
            .expect("serialize dialog trigger source");

        assert_eq!(json, serde_json::json!("cli"));

        let sdk_host = serde_json::to_value(DialogTriggerSource::SdkHost)
            .expect("serialize SDK Host trigger source");
        assert_eq!(sdk_host, serde_json::json!("sdk_host"));
    }

    #[test]
    fn related_path_serializes_as_request_context_fact() {
        let related = RelatedPath {
            path: "/workspace/shared".to_string(),
            description: Some("shared fixtures".to_string()),
        };

        let json = serde_json::to_value(related).expect("serialize related path");

        assert_eq!(json["path"], "/workspace/shared");
        assert_eq!(json["description"], "shared fixtures");
        assert!(json.get("related_path").is_none());
    }

    #[test]
    fn dynamic_tool_descriptor_serializes_current_wire_shape() {
        let descriptor = DynamicToolDescriptor {
            name: "external_search".to_string(),
            description: "Search external docs".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
            provider_id: Some("provider-a".to_string()),
        };

        let json = serde_json::to_value(descriptor).expect("serialize descriptor");

        assert_eq!(json["name"], "external_search");
        assert_eq!(json["description"], "Search external docs");
        assert_eq!(json["inputSchema"]["type"], "object");
        assert_eq!(json["providerId"], "provider-a");
        assert!(json.get("provider_id").is_none());
    }

    #[test]
    fn subagent_context_mode_preserves_fork_wire_value() {
        assert_eq!(SubagentContextMode::default(), SubagentContextMode::Fresh);
        assert_eq!(SubagentContextMode::Fresh.as_str(), "fresh");
        assert_eq!(SubagentContextMode::Fork.as_str(), "fork");

        let json = serde_json::to_value(SubagentContextMode::Fork)
            .expect("serialize subagent context mode");

        assert_eq!(json, serde_json::json!("fork"));
    }

    #[test]
    fn delegation_policy_child_blocks_recursive_spawn_without_losing_depth() {
        let top_level = DelegationPolicy::top_level();
        assert!(top_level.allow_subagent_spawn);
        assert_eq!(top_level.nesting_depth, 0);

        let child = top_level.spawn_child();

        assert!(!child.allow_subagent_spawn);
        assert_eq!(child.nesting_depth, 1);
        assert_eq!(child.spawn_child().nesting_depth, 2);
    }

    #[test]
    fn swarm_delegation_allows_only_planners_to_recurse() {
        let root = DelegationPolicy::swarm_root();
        let planner = root.spawn_child_for("SwarmPlanner");
        let worker = root.spawn_child_for("SwarmWorker");

        assert!(planner.allow_subagent_spawn);
        assert_eq!(planner.nesting_depth, 1);
        assert_eq!(planner.scope, DelegationScope::Swarm);
        assert!(!worker.allow_subagent_spawn);
        assert_eq!(worker.nesting_depth, 1);
    }

    #[test]
    fn dynamic_tool_descriptor_omits_missing_provider_id() {
        let descriptor = DynamicToolDescriptor {
            name: "local_tool".to_string(),
            description: "Local tool".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
            provider_id: None,
        };

        let json = serde_json::to_value(descriptor).expect("serialize descriptor");

        assert!(json.get("providerId").is_none());
    }
}

#[cfg(feature = "agent-api")]
mod dialog_queue;
#[cfg(feature = "agent-api")]
pub use dialog_queue::*;
