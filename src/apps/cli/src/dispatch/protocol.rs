use serde::{Deserialize, Serialize};

use openbitfun_agent_runtime::sdk::{PermissionReply, PermissionRequest};
use openbitfun_core::AIModelCatalog;

// The wire contract (version, capability names, attachment shape and
// limits) has one source of truth shared with the controller side.
pub(crate) use openbitfun_services_core::dispatch_contract::{
    validate_dispatch_attachments, DispatchAttachment, DISPATCH_PROTOCOL_VERSION,
};

pub(crate) const MAX_DISPATCH_TEXT_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchProbeRequest {
    #[serde(default)]
    pub(crate) workspace_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceProbe {
    pub(crate) path: String,
    pub(crate) exists: bool,
    pub(crate) is_directory: bool,
    pub(crate) is_git_repository: bool,
    /// Git found the repository but refuses to read it until the current user
    /// trusts the path. Present only when that is the case, so a controller can
    /// say why `branch` and `dirty` are missing instead of showing a blank.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) trust_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) behind: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchProbeResponse {
    pub(crate) product_id: String,
    pub(crate) data_namespace: String,
    pub(crate) protocol_version: u32,
    pub(crate) cli_version: String,
    pub(crate) os: String,
    pub(crate) arch: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) model_configured: bool,
    pub(crate) available_models: Vec<String>,
    pub(crate) model_catalog: AIModelCatalog,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace: Option<DispatchWorkspaceProbe>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DispatchApprovalPolicy {
    Auto,
    RejectAndReport,
    Remote,
}

/// What a queued follow-up turn asks the worker to run.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DispatchTurnKind {
    /// An ordinary user prompt submitted as a dialog turn.
    #[default]
    Prompt,
    /// Manual context compaction, run as a turn so its events attribute.
    Compact,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchSubmitRequest {
    pub(crate) protocol_version: u32,
    pub(crate) job_id: String,
    pub(crate) session_id: String,
    pub(crate) workspace_path: String,
    #[serde(deserialize_with = "openbitfun_core_types::agent_identity::deserialize_agent_id")]
    pub(crate) agent_type: String,
    pub(crate) prompt: String,
    pub(crate) approval_policy: DispatchApprovalPolicy,
    #[serde(default)]
    pub(crate) model: Option<String>,
    /// Explicit canonical preset id. `auto` clears the session override.
    #[serde(default)]
    pub(crate) reasoning_preset: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) attachments: Vec<DispatchAttachment>,
    /// Controller-side setup actions that happened before the target job could
    /// exist (currently the signed CLI auto-install). They are replayed into
    /// the durable job event log at creation time and are deliberately excluded
    /// from submit idempotency.
    #[serde(default)]
    pub(crate) setup_audit: Vec<DispatchSetupAuditEvent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchSetupAuditEvent {
    pub(crate) timestamp: String,
    pub(crate) action: String,
    #[serde(default)]
    pub(crate) details: serde_json::Value,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DispatchJobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl DispatchJobState {
    pub(crate) const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchSubmitResponse {
    pub(crate) accepted: bool,
    pub(crate) job_id: String,
    pub(crate) session_id: String,
    pub(crate) state: DispatchJobState,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchStatusRequest {
    pub(crate) job_id: String,
    #[serde(default)]
    pub(crate) cursor: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(try_from = "DispatchAnswerWireRequest")]
pub(crate) struct DispatchAnswerRequest {
    pub(crate) job_id: String,
    pub(crate) request_id: String,
    pub(crate) reply: PermissionReply,
}

// `deny_unknown_fields` cannot recognize the fields consumed by a flattened,
// internally tagged enum. Keep the existing flat wire shape strict, then let
// the shared permission contract validate the reply itself.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispatchAnswerWireRequest {
    job_id: String,
    request_id: String,
    reply: String,
    #[serde(default)]
    feedback: Option<String>,
}

impl TryFrom<DispatchAnswerWireRequest> for DispatchAnswerRequest {
    type Error = serde_json::Error;

    fn try_from(request: DispatchAnswerWireRequest) -> Result<Self, Self::Error> {
        let reply = serde_json::from_value(serde_json::json!({
            "reply": request.reply,
            "feedback": request.feedback,
        }))?;
        Ok(Self {
            job_id: request.job_id,
            request_id: request.request_id,
            reply,
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchAnswerResponse {
    pub(crate) resolved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchAppendRequest {
    pub(crate) job_id: String,
    pub(crate) message_id: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) display_content: Option<String>,
    /// Attachments injected into the running turn with the message. An older
    /// controller omits the field entirely, which decodes to an empty list.
    #[serde(default)]
    pub(crate) attachments: Vec<DispatchAttachment>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchAppendResponse {
    pub(crate) accepted: bool,
    pub(crate) message_id: String,
}

/// Ask the target to check out this dispatch's baseline commit.
///
/// The target answers `needsBundle` when it cannot reach `baseCommit` from the
/// shared Git remote — an unpushed commit, or a repository with no remote at
/// all. The controller then delivers exactly the missing objects as a bundle
/// and retries, so the remote stays the fast path without being a requirement.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchWorkspaceProvisionRequest {
    pub(crate) protocol_version: u32,
    pub(crate) job_id: String,
    /// Hex digest naming the shared clone on the target. Never a user-supplied
    /// path: it becomes a directory name.
    pub(crate) repo_key: String,
    #[serde(default)]
    pub(crate) remote_url: Option<String>,
    /// Readable name of the controller's project, used to build a worktree path
    /// a human can recognize. Advisory: the target sanitizes it and falls back
    /// to the remote's own basename, so a hostile value cannot shape the path.
    #[serde(default)]
    pub(crate) project_label: Option<String>,
    /// Full 40-character commit id. A ref name would be ambiguous — it can move
    /// between the controller resolving it and the target fetching it.
    pub(crate) base_commit: String,
    pub(crate) branch: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceProvisionResponse {
    /// True while a detached target-side Git process is still running. The
    /// controller polls the same idempotent verb; no individual RPC owns the
    /// lifetime of clone/fetch/worktree creation.
    #[serde(default)]
    pub(crate) pending: bool,
    pub(crate) provisioned: bool,
    pub(crate) needs_bundle: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_path: Option<String>,
    pub(crate) base_commit: String,
    pub(crate) branch: String,
    /// Commits the target already has, so the controller can bundle only the
    /// difference instead of the whole history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) have_tips: Vec<String>,
    /// Why the target could not pull `base_commit` from the project's remote,
    /// when it tried and failed. Absent when the remote served the commit, and
    /// when there is no remote to try. Bundle delivery costs the whole history
    /// on a cold cache, so the reason it was chosen belongs in the record rather
    /// than only in the target's log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fetch_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchWorkspaceBundleBeginRequest {
    pub(crate) protocol_version: u32,
    pub(crate) job_id: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceBundleBeginResponse {
    pub(crate) accepted: bool,
    /// Bytes the target already holds, so a resumed upload skips them.
    pub(crate) offset: u64,
    pub(crate) committed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchWorkspaceBundleChunkRequest {
    pub(crate) job_id: String,
    pub(crate) offset: u64,
    pub(crate) data_base64: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceBundleChunkResponse {
    pub(crate) accepted: bool,
    pub(crate) offset: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchWorkspaceBundleCommitRequest {
    pub(crate) job_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceBundleCommitResponse {
    pub(crate) committed: bool,
    #[serde(default)]
    pub(crate) pending: bool,
}

/// Commit the worktree and package its new history for the controller.
///
/// Only ever appends commits on this job's own branch, so a controller that
/// never syncs leaves the target unchanged.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchWorkspaceSyncRequest {
    pub(crate) job_id: String,
    /// Identifies one controller-side sync invocation. Every poll for that
    /// invocation reuses this value, while a later user-requested sync gets a
    /// new value even when `knownHead` has not advanced.
    ///
    /// The default keeps operation journals written by older v3 development
    /// builds readable after an upgrade. New requests must still provide a
    /// non-empty validated value.
    #[serde(default)]
    pub(crate) operation_id: String,
    #[serde(default)]
    pub(crate) message: Option<String>,
    /// Head the controller has already fetched. A later invocation combines
    /// this boundary with a new `operationId` to start a new operation;
    /// transport retries before acknowledgement receive the cached result.
    #[serde(default)]
    pub(crate) known_head: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceSyncedChange {
    pub(crate) status: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceSyncResponse {
    #[serde(default)]
    pub(crate) pending: bool,
    /// False when the worktree still matches `baseCommit`; no bundle is built.
    pub(crate) changed: bool,
    pub(crate) branch: String,
    pub(crate) base_commit: String,
    pub(crate) head_commit: String,
    pub(crate) commit_count: u64,
    pub(crate) changes: Vec<DispatchWorkspaceSyncedChange>,
    /// True when the change list was capped; the bundle is still complete.
    pub(crate) truncated_changes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bundle_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bundle_sha256: Option<String>,
    pub(crate) bundle_size: u64,
}

/// Read a slice of an already-built result bundle.
///
/// Exists for transports with no file channel of their own: SSH pulls the
/// bundle over SFTP, but an account device can only carry JSON, so it streams
/// the same bytes back in chunks — the mirror of the upload path.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchWorkspaceSyncChunkRequest {
    pub(crate) job_id: String,
    pub(crate) offset: u64,
    pub(crate) length: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchWorkspaceSyncChunkResponse {
    pub(crate) offset: u64,
    pub(crate) data_base64: String,
    /// True once this chunk reaches the end of the bundle.
    pub(crate) eof: bool,
}

/// Start the next turn in a dispatch session whose previous turn has finished.
///
/// Distinct from `append`, which steers a turn that is still running. This is
/// what lets a dispatch session hold a conversation: the target session, its
/// worktree, and its event log all persist, and only the job's run state
/// rewinds so a new worker can pick it up.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchContinueRequest {
    pub(crate) protocol_version: u32,
    pub(crate) job_id: String,
    /// Caller-generated identity for this turn, so a retried request cannot
    /// start two.
    pub(crate) turn_id: String,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) display_content: Option<String>,
    /// Per-turn model override. Absent keeps the job's current model; present
    /// it also becomes the job's model for later turns.
    #[serde(default)]
    pub(crate) model: Option<String>,
    /// Per-turn preset override. Absent keeps the job's current selection;
    /// `auto` clears it and uses the target model default.
    #[serde(default)]
    pub(crate) reasoning_preset: Option<String>,
    /// Per-turn approval-policy override with the same carry-forward rule.
    #[serde(default)]
    pub(crate) approval_policy: Option<DispatchApprovalPolicy>,
    /// Operation the worker runs; defaults to an ordinary prompt turn.
    #[serde(default)]
    pub(crate) kind: DispatchTurnKind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) force: bool,
    #[serde(default)]
    pub(crate) attachments: Vec<DispatchAttachment>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchContinueResponse {
    pub(crate) accepted: bool,
    pub(crate) job_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) state: DispatchJobState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchCancelRequest {
    pub(crate) job_id: String,
}

/// Read-only question about a job's persisted session state.
///
/// Served by a short-lived process straight from persistence — no runtime is
/// initialized and no workspace runtime ownership is taken, so a query is
/// always safe next to a running detached worker.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchQueryRequest {
    pub(crate) job_id: String,
    pub(crate) kind: DispatchQueryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) file_chunk:
        Option<openbitfun_services_core::dispatch_contract::DispatchFileChunkRequest>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DispatchQueryKind {
    UsageReport,
    ReadFile,
    ReadFileChunk,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DispatchListRequest {}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum DispatchEvent {
    Audit {
        timestamp: String,
        action: String,
        details: serde_json::Value,
    },
    JobState {
        timestamp: String,
        state: DispatchJobState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    AgentEvent {
        timestamp: String,
        event: serde_json::Value,
        #[serde(rename = "frontendEventName", skip_serializing_if = "Option::is_none")]
        frontend_event_name: Option<String>,
        #[serde(rename = "frontendPayload", skip_serializing_if = "Option::is_none")]
        frontend_payload: Option<serde_json::Value>,
    },
    PermissionRejected {
        timestamp: String,
        request: serde_json::Value,
        reason: String,
    },
}

impl DispatchEvent {
    pub(crate) fn setup_audit(event: DispatchSetupAuditEvent) -> Self {
        Self::Audit {
            timestamp: event.timestamp,
            action: event.action,
            details: event.details,
        }
    }

    pub(crate) fn approval_policy_selected(policy: DispatchApprovalPolicy) -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "approvalPolicySelected".to_string(),
            details: serde_json::json!({ "approvalPolicy": policy }),
        }
    }

    pub(crate) fn model_selected(model: Option<&str>) -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "modelSelected".to_string(),
            details: serde_json::json!({ "model": model }),
        }
    }

    pub(crate) fn cancel_requested() -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "cancelRequested".to_string(),
            details: serde_json::json!({}),
        }
    }

    pub(crate) fn permission_pending(request_id: &str) -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "permissionPending".to_string(),
            details: serde_json::json!({ "requestId": request_id }),
        }
    }

    pub(crate) fn permission_resolved(request_id: &str) -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "permissionResolved".to_string(),
            details: serde_json::json!({ "requestId": request_id }),
        }
    }

    pub(crate) fn message_appended(message_id: &str) -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "messageAppended".to_string(),
            details: serde_json::json!({ "messageId": message_id }),
        }
    }

    pub(crate) fn oversized_event_omitted(encoded_bytes: usize, max_bytes: usize) -> Self {
        Self::Audit {
            timestamp: chrono::Utc::now().to_rfc3339(),
            action: "eventOmitted".to_string(),
            details: serde_json::json!({
                "reason": "eventTooLarge",
                "encodedBytes": encoded_bytes,
                "maxBytes": max_bytes,
            }),
        }
    }

    pub(crate) fn job_state(state: DispatchJobState, message: impl Into<Option<String>>) -> Self {
        Self::JobState {
            timestamp: chrono::Utc::now().to_rfc3339(),
            state,
            message: message.into(),
        }
    }

    pub(crate) fn agent_event(
        event: serde_json::Value,
        frontend_projection: Option<(String, serde_json::Value)>,
    ) -> Self {
        let (frontend_event_name, frontend_payload) = frontend_projection
            .map(|(name, payload)| (Some(name), Some(payload)))
            .unwrap_or((None, None));
        Self::AgentEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            event,
            frontend_event_name,
            frontend_payload,
        }
    }

    pub(crate) fn permission_rejected(
        request: serde_json::Value,
        reason: impl Into<String>,
    ) -> Self {
        Self::PermissionRejected {
            timestamp: chrono::Utc::now().to_rfc3339(),
            request,
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchStatusResponse {
    pub(crate) state: DispatchJobState,
    pub(crate) cursor: u64,
    pub(crate) events: Vec<DispatchEvent>,
    pub(crate) pending_permissions: Vec<PermissionRequest>,
    pub(crate) cursor_reset: bool,
    pub(crate) history_truncated: bool,
    pub(crate) event_log_complete: bool,
    pub(crate) omitted_event_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchCancelResponse {
    pub(crate) cancelled: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchJobListEntry {
    pub(crate) job_id: String,
    pub(crate) session_id: String,
    pub(crate) state: DispatchJobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) started_at: Option<String>,
    pub(crate) workspace_path: String,
    pub(crate) title: String,
    #[serde(deserialize_with = "openbitfun_core_types::agent_identity::deserialize_agent_id")]
    pub(crate) agent_type: String,
    pub(crate) approval_policy: DispatchApprovalPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reasoning_preset: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_answers_accept_existing_flat_controller_payloads() {
        for reply in [
            PermissionReply::Once,
            PermissionReply::Always,
            PermissionReply::Reject { feedback: None },
            PermissionReply::Reject {
                feedback: Some("Use a read-only command".to_string()),
            },
        ] {
            let mut payload = serde_json::to_value(&reply).expect("serialize shared reply");
            payload["jobId"] = "job-1".into();
            payload["requestId"] = "request-1".into();
            assert_eq!(
                serde_json::from_value::<DispatchAnswerRequest>(payload)
                    .expect("decode existing flat answer"),
                DispatchAnswerRequest {
                    job_id: "job-1".to_string(),
                    request_id: "request-1".to_string(),
                    reply,
                }
            );
        }
    }

    #[test]
    fn permission_answers_reject_unknown_fields_and_invalid_replies() {
        let base = serde_json::json!({
            "jobId": "job-1", "requestId": "request-1", "reply": "once"
        });
        for (field, value) in [
            ("unexpected", serde_json::json!(true)),
            ("reply", serde_json::json!("approve")),
            ("reply", serde_json::json!({"reply": "once"})),
            ("feedback", serde_json::json!(false)),
            ("jobId", serde_json::Value::Null),
            ("requestId", serde_json::Value::Null),
        ] {
            let mut payload = base.clone();
            payload[field] = value;
            assert!(serde_json::from_value::<DispatchAnswerRequest>(payload).is_err());
        }
    }

    #[test]
    fn wire_names_are_camel_case_and_policy_values_are_explicit() {
        let event = DispatchEvent::AgentEvent {
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            event: serde_json::json!({"id": "event-1"}),
            frontend_event_name: Some("agentic://text-chunk".to_string()),
            frontend_payload: Some(serde_json::json!({"sessionId": "session-1"})),
        };
        let value = serde_json::to_value(event).expect("serialize event");
        assert_eq!(value["type"], "agentEvent");
        assert_eq!(value["frontendEventName"], "agentic://text-chunk");
        assert_eq!(value["frontendPayload"]["sessionId"], "session-1");

        assert_eq!(
            serde_json::to_value(DispatchApprovalPolicy::RejectAndReport)
                .expect("serialize policy"),
            "reject-and-report"
        );
        assert_eq!(
            serde_json::to_value(DispatchJobState::Running).expect("serialize state"),
            "running"
        );

        let list_entry = DispatchJobListEntry {
            job_id: "job-1".to_string(),
            session_id: "session-1".to_string(),
            state: DispatchJobState::Running,
            started_at: None,
            workspace_path: "/repo".to_string(),
            title: "Reasoning job".to_string(),
            agent_type: "Standard".to_string(),
            approval_policy: DispatchApprovalPolicy::Remote,
            model: Some("model-1".to_string()),
            reasoning_preset: Some("high".to_string()),
        };
        let value = serde_json::to_value(list_entry).expect("serialize list entry");
        assert_eq!(value["reasoningPreset"], "high");
    }
}
