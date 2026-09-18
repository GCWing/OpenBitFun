//! Hook-management App Server wire schemas.
//!
//! External Hook DTOs reuse the stable product-domain contracts. Native Hook
//! inspection uses a protocol-owned projection so executable commands and host
//! filesystem paths do not cross the wire.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use openbitfun_product_domains::external_hook_import::{
    ExternalHookImportApplyRequestV1, ExternalHookImportApplyResultV1,
    ExternalHookImportMutationRequestV1, ExternalHookImportPlanV1, ExternalHookImportSnapshotV1,
};
use openbitfun_product_domains::external_sources::SourceKey;
use serde::{Deserialize, Serialize};

pub use openbitfun_product_domains::native_hooks::{
    NativeHookFileSummary, NativeHookHandlerSummary, NativeHookOverview, NativeHookRuleSummary,
};

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "nativeHook/overview", response = NativeHookOverviewResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeHookOverviewRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
}

impl std::fmt::Debug for NativeHookOverviewRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeHookOverviewRequest")
            .field("workspace_path", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct NativeHookOverviewResponse(pub NativeHookOverview);

impl std::fmt::Debug for NativeHookOverviewResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeHookOverviewResponse")
            .field("enabled", &self.0.enabled)
            .field("project_hooks_enabled", &self.0.project_hooks_enabled)
            .field("file_count", &self.0.files.len())
            .field("rule_count", &self.0.rules.len())
            .field("total_handlers", &self.0.total_handlers)
            .field("issue_count", &self.0.issues.len())
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalHook/snapshot", response = ExternalHookSnapshotResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHookSnapshotRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub refresh_updates: bool,
}

impl std::fmt::Debug for ExternalHookSnapshotRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalHookSnapshotRequest")
            .field("workspace_path", &"<redacted>")
            .field("refresh_updates", &self.refresh_updates)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ExternalHookSnapshotResponse(pub ExternalHookImportSnapshotV1);

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalHook/plan", response = ExternalHookPlanResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHookPlanRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub source: SourceKey,
}

impl std::fmt::Debug for ExternalHookPlanRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalHookPlanRequest")
            .field("workspace_path", &"<redacted>")
            .field("source", &self.source)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ExternalHookPlanResponse(pub ExternalHookImportPlanV1);

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalHook/apply", response = ExternalHookApplyResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHookApplyRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub operation_id: String,
    pub import_request: ExternalHookImportApplyRequestV1,
}

impl std::fmt::Debug for ExternalHookApplyRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalHookApplyRequest")
            .field("workspace_path", &"<redacted>")
            .field("operation_id", &self.operation_id)
            .field("source", &self.import_request.source)
            .field("plan_fingerprint", &self.import_request.plan_fingerprint)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ExternalHookApplyResponse(pub ExternalHookImportApplyResultV1);

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "externalHook/mutate", response = ExternalHookMutationResponse))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHookMutationRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only field for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub operation_id: String,
    pub mutation: ExternalHookImportMutationRequestV1,
}

impl std::fmt::Debug for ExternalHookMutationRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalHookMutationRequest")
            .field("workspace_path", &"<redacted>")
            .field("operation_id", &self.operation_id)
            .field("expected_revision", &self.mutation.expected_revision)
            .field("action", &self.mutation.action)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ExternalHookMutationResponse(pub ExternalHookImportSnapshotV1);

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::external_hook_import::{
        ExternalHookImportMutationV1, EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
    };

    #[test]
    fn hook_request_debug_redacts_workspace_paths() {
        let request = ExternalHookMutationRequest {
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "C:/secret/workspace".to_string(),
            operation_id: "hook-operation-1".to_string(),
            mutation: ExternalHookImportMutationRequestV1 {
                schema_version: EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
                expected_revision: "revision-1".to_string(),
                action: ExternalHookImportMutationV1::Remove {
                    import_id: "import-1".to_string(),
                },
            },
        };
        let debug = format!("{request:?}");
        assert!(!debug.contains("C:/secret/workspace"));
        assert!(debug.contains("hook-operation-1"));
    }

    #[test]
    fn native_overview_contains_only_projected_command_and_location_summaries() {
        let overview = NativeHookOverview {
            enabled: true,
            project_hooks_enabled: true,
            files: vec![NativeHookFileSummary {
                scope: "project".to_string(),
                location: "<workspace>/.openbitfun/config/hooks.json".to_string(),
                exists: true,
                loaded: true,
            }],
            rules: vec![NativeHookRuleSummary {
                event: "PreToolUse".to_string(),
                matcher: "Bash".to_string(),
                matcher_is_valid: true,
                scope: "project".to_string(),
                handlers: vec![NativeHookHandlerSummary {
                    command_summary: "check".to_string(),
                    command_truncated: false,
                    timeout_seconds: 5,
                    status_message: None,
                }],
            }],
            total_handlers: 1,
            issues: Vec::new(),
        };
        let wire = serde_json::to_value(overview).unwrap();
        assert!(wire.get("postCallHooks").is_none());
        assert!(wire["files"][0].get("path").is_none());
        assert!(wire["rules"][0]["handlers"][0].get("command").is_none());
    }

    #[test]
    fn hook_management_methods_follow_the_stable_app_server_naming_contract() {
        for method in [
            "nativeHook/overview",
            "externalHook/snapshot",
            "externalHook/plan",
            "externalHook/apply",
            "externalHook/mutate",
        ] {
            assert!(crate::method::is_valid_method_name(method));
        }
    }
}
