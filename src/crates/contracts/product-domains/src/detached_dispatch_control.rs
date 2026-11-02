//! Closed Agent-facing requests for the executing host's Detached Dispatch
//! controller: list same-account devices and saved SSH targets, submit a job,
//! and observe or cancel jobs this host submitted.
//!
//! The controller semantics live in the Core dispatch owner; this contract only
//! names the operations and their arguments so every host binds them the same way.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DETACHED_DISPATCH_CONTROL_PROVIDER: &str = "detached-dispatch";
/// Largest prompt a controller may submit; mirrors the dispatch protocol limit.
pub const MAX_DETACHED_DISPATCH_PROMPT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetachedDispatchApprovalPolicy {
    /// Approve every tool request that static rules do not deny.
    Auto,
    /// Reject permission prompts and report them in the job result.
    RejectAndReport,
}

impl DetachedDispatchApprovalPolicy {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::RejectAndReport => "reject-and-report",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DetachedDispatchControlRequest {
    /// Same-account devices (including this one, marked) and saved SSH targets.
    ListTargets,
    Submit {
        /// Device name or alias, `device:<deviceId>`, or `ssh:<connectionId>`.
        target: String,
        prompt: String,
        approval_policy: DetachedDispatchApprovalPolicy,
        /// Git checkout on this host the job branches from.
        workspace_path: String,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        base_ref: Option<String>,
        #[serde(default)]
        include_uncommitted: bool,
        #[serde(default)]
        title: Option<String>,
    },
    Status {
        job_id: String,
        #[serde(default)]
        cursor: u64,
    },
    ListJobs {
        #[serde(default)]
        target: Option<String>,
    },
    Cancel {
        job_id: String,
    },
}

impl DetachedDispatchControlRequest {
    pub fn from_operation(operation: &str, arguments: Option<&Value>) -> Result<Self, String> {
        let mut arguments = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
        let object = arguments
            .as_object_mut()
            .ok_or("Detached Dispatch arguments must be an object")?;
        if object.contains_key("operation") {
            return Err(
                "Detached Dispatch operation must be supplied by the registered handler".into(),
            );
        }
        object.insert("operation".into(), Value::String(operation.into()));
        serde_json::from_value(arguments)
            .map_err(|_| "Invalid Detached Dispatch operation or arguments".into())
    }

    pub fn operation_id(&self) -> &'static str {
        match self {
            Self::ListTargets => "list-targets",
            Self::Submit { .. } => "submit",
            Self::Status { .. } => "status",
            Self::ListJobs { .. } => "list-jobs",
            Self::Cancel { .. } => "cancel",
        }
    }

    pub fn is_readonly(&self) -> bool {
        matches!(
            self,
            Self::ListTargets | Self::Status { .. } | Self::ListJobs { .. }
        )
    }

    /// A detached dispatch worker runs unattended on a target; it may observe
    /// jobs but must not fan out further dispatches.
    pub fn ensure_allowed_in_dispatch_worker(&self) -> Result<(), String> {
        match self {
            Self::Submit { .. } => Err("detached_dispatch_nested_submit_unsupported: A detached dispatch job cannot dispatch further work; report the follow-up in the job result instead".into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn closed_requests_parse_documented_arguments_only() {
        let submit = DetachedDispatchControlRequest::from_operation(
            "submit",
            Some(&json!({
                "target": "MacBook-Pro-2.local",
                "prompt": "run the tests",
                "approvalPolicy": "reject-and-report",
                "workspacePath": "/repo",
            })),
        )
        .unwrap();
        assert!(!submit.is_readonly());
        assert!(submit.ensure_allowed_in_dispatch_worker().is_err());
        assert_eq!(submit.operation_id(), "submit");

        let list = DetachedDispatchControlRequest::from_operation("list-targets", None).unwrap();
        assert!(list.is_readonly());
        assert!(list.ensure_allowed_in_dispatch_worker().is_ok());

        for (operation, arguments) in [
            (
                "submit",
                json!({"target":"a","prompt":"p","approvalPolicy":"remote","workspacePath":"/r"}),
            ),
            (
                "submit",
                json!({"target":"a","prompt":"p","approvalPolicy":"auto"}),
            ),
            ("status", json!({"jobId":"j","token":"secret"})),
            ("cancel", json!({"operation":"submit","jobId":"j"})),
            ("delete", json!({})),
        ] {
            assert!(
                DetachedDispatchControlRequest::from_operation(operation, Some(&arguments))
                    .is_err(),
                "{operation} {arguments}"
            );
        }
    }

    #[test]
    fn controls_declare_risk_host_paths_and_cli_availability() {
        use crate::product_control::*;
        let registry = ProductControlRegistry::global();
        let capability = "feature.detached-dispatch";
        for (operation, risk) in [
            ("list-targets", ProductControlRisk::Read),
            ("status", ProductControlRisk::Read),
            ("list-jobs", ProductControlRisk::Read),
            ("submit", ProductControlRisk::Execute),
            ("cancel", ProductControlRisk::Destructive),
        ] {
            assert_eq!(
                registry.operation(capability, operation).unwrap().risk,
                risk
            );
            let definition = registry
                .definition(&format!("{capability}:operation:{operation}"))
                .unwrap();
            assert!(definition.availability[&ProductControlDeliveryProfile::Desktop].available);
            assert!(definition.availability[&ProductControlDeliveryProfile::Cli].available);
            assert_eq!(
                definition.availability[&ProductControlDeliveryProfile::DetachedDispatch].available,
                operation != "submit",
                "{operation}"
            );
        }
        let submit = registry.operation(capability, "submit").unwrap();
        let args = json!({"target":"mac","prompt":"p","approvalPolicy":"auto","workspacePath":"/host/repo"});
        validate_operation_arguments(&submit.input_schema, Some(&args)).unwrap();
        assert!(validate_operation_argument_scopes(submit, Some(&args), true).is_err());
    }
}
