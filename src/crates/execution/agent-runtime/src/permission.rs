//! Provider-neutral permission planning, pending requests, and reply coordination.

use dashmap::DashMap;
use openbitfun_agent_tools::PermissionIntent;
use openbitfun_runtime_ports::{
    wildcard_matches, ClockPort, PermissionAuditEvent, PermissionAuditRecord,
    PermissionAuditStorePort, PermissionEffect, PermissionEvaluator, PermissionGrant,
    PermissionGrantStorePort, PermissionReply, PermissionReplySource, PermissionReplyStorePort,
    PermissionRequest, PermissionRequestEvent, PermissionResourceCaseSensitivity, PortError,
    ResolvedPermissionPolicy,
};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use tokio::sync::{broadcast, oneshot, Mutex};

const PERMISSION_EVENT_CAPACITY: usize = 128;

/// Per-submission override for the interactive ask handling policy.
///
/// Product surfaces may set this in dialog metadata to keep invocation-scoped
/// policies (such as CLI `--auto`) separate from persisted user preferences.
///
/// Superseded by [`PERMISSION_MODE_CONTEXT_KEY`], which carries the whole mode
/// instead of the auto-approval half. Still read so existing surfaces and
/// persisted submissions keep working.
pub const AUTO_APPROVE_ASK_CONTEXT_KEY: &str = "auto_approve_ask";

/// Effective permission mode for one dialog turn.
///
/// The owning surface resolves `turn -> session -> global default` once at
/// submission time and writes the result here. Everything downstream, including
/// delegated subagents, reads this single value instead of re-resolving the
/// layers with partial context.
pub const PERMISSION_MODE_CONTEXT_KEY: &str = "permission_mode";

/// Invocation-scoped approval strategy override. This is separate from the
/// permission mode because `auto_approve` means immediate allow while model
/// approval still evaluates every request.
pub const PERMISSION_APPROVAL_STRATEGY_CONTEXT_KEY: &str = "permission_approval_strategy";

/// Provider-neutral result of applying resolved policy and remembered grants.
///
/// Product orchestration remains responsible for scope derivation, native hooks,
/// interactive request construction, and tool execution.
#[derive(Debug, Clone, PartialEq)]
pub enum PermissionIntentPlan {
    Allowed,
    Denied(PermissionIntent),
    RequiresApproval(Vec<PermissionIntent>),
}

/// Applies the resolved permission policy to one ordered set of tool intents.
///
/// A denial short-circuits the whole set. Intents that still require approval
/// keep their input order so the product layer can create deterministic requests.
pub fn plan_permission_intents(
    intents: Vec<PermissionIntent>,
    policy: &ResolvedPermissionPolicy,
    grants: &[PermissionGrant],
    case_sensitivity: PermissionResourceCaseSensitivity,
) -> PermissionIntentPlan {
    let mut approvals = Vec::new();

    for intent in intents {
        match permission_intent_effect(&intent, policy, grants, case_sensitivity) {
            PermissionEffect::Allow => {}
            PermissionEffect::Ask => approvals.push(intent),
            PermissionEffect::Deny => return PermissionIntentPlan::Denied(intent),
        }
    }

    if approvals.is_empty() {
        PermissionIntentPlan::Allowed
    } else {
        PermissionIntentPlan::RequiresApproval(approvals)
    }
}

fn permission_intent_effect(
    intent: &PermissionIntent,
    policy: &ResolvedPermissionPolicy,
    grants: &[PermissionGrant],
    case_sensitivity: PermissionResourceCaseSensitivity,
) -> PermissionEffect {
    let evaluator = PermissionEvaluator::new(case_sensitivity);
    let mut aggregate = PermissionEffect::Allow;

    for resource in &intent.resources {
        let configured_effect = if intent.action == "bash" {
            policy
                .rules()
                .iter()
                .rev()
                .find(|rule| {
                    wildcard_matches(
                        &intent.action,
                        &rule.action,
                        PermissionResourceCaseSensitivity::Sensitive,
                    ) && match rule.effect {
                        PermissionEffect::Allow => {
                            rule.resource == *resource
                                || (rule.action == "*" && rule.resource == "*")
                        }
                        PermissionEffect::Ask | PermissionEffect::Deny => {
                            wildcard_matches(resource, &rule.resource, case_sensitivity)
                        }
                    }
                })
                .map(|rule| rule.effect)
                .unwrap_or(PermissionEffect::Ask)
        } else {
            evaluator.evaluate_resource(&intent.action, resource, policy.rules())
        };
        let configured_effect =
            policy
                .constraint_layers()
                .iter()
                .fold(configured_effect, |effect, layer| {
                    effect.most_restrictive(evaluator.evaluate_constraint_resource(
                        &intent.action,
                        resource,
                        layer,
                    ))
                });

        match configured_effect {
            PermissionEffect::Deny => return PermissionEffect::Deny,
            PermissionEffect::Allow => {}
            PermissionEffect::Ask => {
                let remembered = grants.iter().any(|grant| {
                    if intent.action == "bash" {
                        grant.action == intent.action && grant.resource == *resource
                    } else {
                        wildcard_matches(
                            &intent.action,
                            &grant.action,
                            PermissionResourceCaseSensitivity::Sensitive,
                        ) && wildcard_matches(resource, &grant.resource, case_sensitivity)
                    }
                });
                if !remembered {
                    aggregate = PermissionEffect::Ask;
                }
            }
        }
    }

    let effect = if intent.resources.is_empty() {
        PermissionEffect::Ask
    } else {
        aggregate
    };
    if effect != PermissionEffect::Deny
        && intent
            .display_metadata
            .get("requiresFreshApproval")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        PermissionEffect::Ask
    } else {
        effect
    }
}

pub type PermissionRequestEventReceiver = broadcast::Receiver<PermissionRequestEvent>;

#[derive(Debug, Clone, PartialEq)]
pub enum PermissionWaitOutcome {
    Replied(PermissionReply),
    Cancelled { reason: String },
}

#[derive(Debug)]
pub struct PendingPermissionReceiver {
    request_id: String,
    receiver: oneshot::Receiver<PermissionWaitOutcome>,
}

/// Monotonic snapshot used by reconnecting product surfaces to reconcile
/// permission requests even when the low-latency event stream had a gap.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestSnapshot {
    pub revision: u64,
    #[serde(default)]
    pub requests: Vec<PermissionRequest>,
}

impl PendingPermissionReceiver {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub async fn wait(self) -> PermissionWaitOutcome {
        self.receiver
            .await
            .unwrap_or_else(|_| PermissionWaitOutcome::Cancelled {
                reason: "Permission request channel closed".to_string(),
            })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionReplyResolution {
    pub request: PermissionRequest,
    pub reply: PermissionReply,
    pub saved_grants: Vec<PermissionGrant>,
    pub resolved_request_ids: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PermissionRequestManagerError {
    #[error("Invalid permission reply: {0}")]
    InvalidReply(String),
    #[error("Duplicate pending permission request: {0}")]
    DuplicateRequest(String),
    #[error("Pending permission request not found: {0}")]
    RequestNotFound(String),
    #[error("Failed to persist permission reply: {0}")]
    ReplyStore(#[source] PortError),
    #[error("Failed to load remembered permission grants: {0}")]
    GrantStore(#[source] PortError),
    #[error("Failed to persist permission audit: {0}")]
    AuditStore(#[source] PortError),
}

#[derive(Debug)]
struct PendingPermission {
    request: PermissionRequest,
    dialog_turn_id: Option<String>,
    sender: oneshot::Sender<PermissionWaitOutcome>,
    interactive: bool,
    registration_sequence: u64,
}

#[derive(Clone)]
pub struct PermissionRequestManager {
    pending: Arc<DashMap<String, PendingPermission>>,
    next_registration_sequence: Arc<AtomicU64>,
    snapshot_revision: Arc<AtomicU64>,
    snapshot_barrier: Arc<StdRwLock<()>>,
    operations: Arc<Mutex<()>>,
    audit_store: Arc<dyn PermissionAuditStorePort>,
    reply_store: Arc<dyn PermissionReplyStorePort>,
    grant_store: Option<Arc<dyn PermissionGrantStorePort>>,
    clock: Arc<dyn ClockPort>,
    events: broadcast::Sender<PermissionRequestEvent>,
}

impl std::fmt::Debug for PermissionRequestManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PermissionRequestManager")
            .field("pending_count", &self.pending.len())
            .finish_non_exhaustive()
    }
}

impl PermissionRequestManager {
    pub fn new(
        audit_store: Arc<dyn PermissionAuditStorePort>,
        reply_store: Arc<dyn PermissionReplyStorePort>,
        clock: Arc<dyn ClockPort>,
    ) -> Self {
        let (events, _) = broadcast::channel(PERMISSION_EVENT_CAPACITY);
        Self {
            pending: Arc::new(DashMap::new()),
            next_registration_sequence: Arc::new(AtomicU64::new(0)),
            snapshot_revision: Arc::new(AtomicU64::new(0)),
            snapshot_barrier: Arc::new(StdRwLock::new(())),
            operations: Arc::new(Mutex::new(())),
            audit_store,
            reply_store,
            grant_store: None,
            clock,
            events,
        }
    }

    pub fn with_grant_store(mut self, grant_store: Arc<dyn PermissionGrantStorePort>) -> Self {
        self.grant_store = Some(grant_store);
        self
    }

    pub async fn list_project_grants(
        &self,
        project_id: &str,
    ) -> Result<Vec<PermissionGrant>, PermissionRequestManagerError> {
        let Some(grant_store) = &self.grant_store else {
            return Ok(Vec::new());
        };
        grant_store
            .list_project_grants(project_id)
            .await
            .map_err(PermissionRequestManagerError::GrantStore)
    }

    pub async fn remove_project_grant(
        &self,
        key: openbitfun_runtime_ports::PermissionGrantKey,
    ) -> Result<bool, PermissionRequestManagerError> {
        let Some(grant_store) = &self.grant_store else {
            return Ok(false);
        };
        grant_store
            .remove_project_grant(key)
            .await
            .map_err(PermissionRequestManagerError::GrantStore)
    }

    pub async fn clear_project_grants(
        &self,
        project_id: &str,
    ) -> Result<usize, PermissionRequestManagerError> {
        let Some(grant_store) = &self.grant_store else {
            return Ok(0);
        };
        grant_store
            .clear_project_grants(project_id)
            .await
            .map_err(PermissionRequestManagerError::GrantStore)
    }

    pub async fn list_project_permission_audit(
        &self,
        project_id: &str,
    ) -> Result<Vec<openbitfun_runtime_ports::PermissionAuditRecord>, PermissionRequestManagerError>
    {
        self.audit_store
            .list_project_permission_audit(project_id)
            .await
            .map_err(PermissionRequestManagerError::AuditStore)
    }

    pub fn subscribe(&self) -> PermissionRequestEventReceiver {
        self.events.subscribe()
    }

    pub async fn register(
        &self,
        request: PermissionRequest,
    ) -> Result<PendingPermissionReceiver, PermissionRequestManagerError> {
        let mut pending = self.register_batch(vec![request]).await?;
        Ok(pending
            .pop()
            .expect("a single-request batch must return one receiver"))
    }

    /// Registers a request for internal coordination and audit without exposing
    /// it to interactive subscribers or pending-request snapshots.
    pub async fn register_non_interactive(
        &self,
        request: PermissionRequest,
    ) -> Result<PendingPermissionReceiver, PermissionRequestManagerError> {
        let mut pending = self.register_batch_non_interactive(vec![request]).await?;
        Ok(pending
            .pop()
            .expect("a single-request batch must return one receiver"))
    }

    pub async fn register_batch(
        &self,
        requests: Vec<PermissionRequest>,
    ) -> Result<Vec<PendingPermissionReceiver>, PermissionRequestManagerError> {
        self.register_batch_with_visibility(requests, None, true)
            .await
    }

    /// Registers a batch with the exact owning Dialog Turn kept as internal
    /// coordination state. The public permission DTO remains stable because
    /// turn routing is a runtime concern, not an authorization fact.
    pub async fn register_batch_for_turn(
        &self,
        requests: Vec<PermissionRequest>,
        dialog_turn_id: impl Into<String>,
    ) -> Result<Vec<PendingPermissionReceiver>, PermissionRequestManagerError> {
        self.register_batch_with_visibility(requests, Some(dialog_turn_id.into()), true)
            .await
    }

    pub async fn register_batch_non_interactive(
        &self,
        requests: Vec<PermissionRequest>,
    ) -> Result<Vec<PendingPermissionReceiver>, PermissionRequestManagerError> {
        self.register_batch_with_visibility(requests, None, false)
            .await
    }

    pub async fn register_batch_non_interactive_for_turn(
        &self,
        requests: Vec<PermissionRequest>,
        dialog_turn_id: impl Into<String>,
    ) -> Result<Vec<PendingPermissionReceiver>, PermissionRequestManagerError> {
        self.register_batch_with_visibility(requests, Some(dialog_turn_id.into()), false)
            .await
    }

    async fn register_batch_with_visibility(
        &self,
        requests: Vec<PermissionRequest>,
        dialog_turn_id: Option<String>,
        interactive: bool,
    ) -> Result<Vec<PendingPermissionReceiver>, PermissionRequestManagerError> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }

        let _operation = self.operations.lock().await;
        let mut request_ids = HashSet::with_capacity(requests.len());
        for request in &requests {
            if !request_ids.insert(request.request_id.clone()) {
                return Err(PermissionRequestManagerError::DuplicateRequest(
                    request.request_id.clone(),
                ));
            }
            if self.pending.contains_key(&request.request_id) {
                return Err(PermissionRequestManagerError::DuplicateRequest(
                    request.request_id.clone(),
                ));
            }
        }

        let timestamp_ms = self.clock.now_unix_millis();
        let mut receivers = Vec::with_capacity(requests.len());
        {
            let _snapshot_write = self
                .snapshot_barrier
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for request in &requests {
                let (sender, receiver) = oneshot::channel();
                let registration_sequence = self
                    .next_registration_sequence
                    .fetch_add(1, Ordering::Relaxed);
                self.pending.insert(
                    request.request_id.clone(),
                    PendingPermission {
                        request: request.clone(),
                        dialog_turn_id: dialog_turn_id.clone(),
                        sender,
                        interactive,
                        registration_sequence,
                    },
                );
                receivers.push(PendingPermissionReceiver {
                    request_id: request.request_id.clone(),
                    receiver,
                });
            }
            self.snapshot_revision.fetch_add(1, Ordering::Release);
        }

        for request in &requests {
            if let Err(error) = self
                .audit_store
                .append_permission_audit(PermissionAuditRecord {
                    audit_id: audit_id(&request.request_id, "requested"),
                    request: request.clone(),
                    event: PermissionAuditEvent::Requested,
                    timestamp_ms,
                })
                .await
            {
                let _snapshot_write = self
                    .snapshot_barrier
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let mut removed = false;
                for request in &requests {
                    removed |= self.pending.remove(&request.request_id).is_some();
                }
                if removed {
                    self.snapshot_revision.fetch_add(1, Ordering::Release);
                }
                return Err(PermissionRequestManagerError::AuditStore(error));
            }
        }

        if interactive {
            for request in requests {
                let _ = self.events.send(PermissionRequestEvent::Asked { request });
            }
        }

        Ok(receivers)
    }

    pub fn pending_requests(&self) -> Vec<PermissionRequest> {
        self.ordered_pending_requests(|_| true)
    }

    pub fn interactive_pending_requests(&self) -> Vec<PermissionRequest> {
        self.ordered_pending_requests(|pending| pending.interactive)
    }

    pub fn interactive_pending_snapshot(&self) -> PermissionRequestSnapshot {
        let _snapshot_read = self
            .snapshot_barrier
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        PermissionRequestSnapshot {
            revision: self.snapshot_revision.load(Ordering::Acquire),
            requests: self.ordered_pending_requests(|pending| pending.interactive),
        }
    }

    /// Returns the process-local owning Dialog Turn for exact event routing.
    /// This fact is intentionally absent from the persisted/public request DTO.
    pub fn pending_request_dialog_turn_id(&self, request_id: &str) -> Option<String> {
        self.pending
            .get(request_id)
            .and_then(|pending| pending.dialog_turn_id.clone())
    }

    fn ordered_pending_requests(
        &self,
        include: impl Fn(&PendingPermission) -> bool,
    ) -> Vec<PermissionRequest> {
        let mut first_registration_by_round = HashMap::<(String, String), u64>::new();
        for entry in self.pending.iter().filter(|entry| include(entry.value())) {
            let batch_id = (
                entry.request.session_id.clone(),
                entry.request.round_id.clone(),
            );
            first_registration_by_round
                .entry(batch_id)
                .and_modify(|first| *first = (*first).min(entry.registration_sequence))
                .or_insert(entry.registration_sequence);
        }

        let mut requests = self
            .pending
            .iter()
            .filter_map(|entry| {
                include(entry.value()).then(|| {
                    (
                        first_registration_by_round
                            .get(&(
                                entry.request.session_id.clone(),
                                entry.request.round_id.clone(),
                            ))
                            .copied()
                            .unwrap_or(entry.registration_sequence),
                        entry.request.order,
                        entry.registration_sequence,
                        entry.request.request_id.clone(),
                        entry.request.clone(),
                    )
                })
            })
            .collect::<Vec<_>>();
        requests.sort_by(|left, right| {
            (left.0, left.1, left.2, &left.3).cmp(&(right.0, right.1, right.2, &right.3))
        });
        requests
            .into_iter()
            .map(|(_, _, _, _, request)| request)
            .collect()
    }

    pub async fn reply(
        &self,
        request_id: &str,
        reply: PermissionReply,
        source: PermissionReplySource,
    ) -> Result<PermissionReplyResolution, PermissionRequestManagerError> {
        self.reply_from(request_id, false, reply, source).await
    }

    pub async fn reply_from(
        &self,
        request_id: &str,
        include_following: bool,
        reply: PermissionReply,
        source: PermissionReplySource,
    ) -> Result<PermissionReplyResolution, PermissionRequestManagerError> {
        if let PermissionReply::OnceWithInput { updated_input } = &reply {
            if include_following || !updated_input.is_object() {
                return Err(PermissionRequestManagerError::InvalidReply(
                    "Edited approval requires an object input and a single request".to_string(),
                ));
            }
        }
        let _operation = self.operations.lock().await;
        let request = self
            .pending
            .get(request_id)
            .map(|entry| entry.request.clone())
            .ok_or_else(|| {
                PermissionRequestManagerError::RequestNotFound(request_id.to_string())
            })?;
        if matches!(reply, PermissionReply::OnceWithInput { .. })
            && (request.source.kind
                != openbitfun_runtime_ports::PermissionRequestSourceKind::ToolCall
                || request.tool_call_id.is_none())
        {
            return Err(PermissionRequestManagerError::InvalidReply(
                "This permission owner does not support edited input".to_string(),
            ));
        }
        let timestamp_ms = self.clock.now_unix_millis();
        let resolution_requests = if include_following {
            self.ordered_pending_requests(|pending| {
                pending.request.session_id == request.session_id
                    && pending.request.round_id == request.round_id
                    && pending.request.order >= request.order
            })
        } else {
            vec![request.clone()]
        };
        let resolutions = resolution_requests
            .into_iter()
            .map(|request| (request, reply.clone()))
            .collect::<Vec<_>>();
        let grants = resolutions
            .iter()
            .flat_map(|(request, reply)| grants_for_reply(request, reply, timestamp_ms))
            .collect::<Vec<_>>();

        let audit = resolutions
            .iter()
            .map(|(pending_request, pending_reply)| PermissionAuditRecord {
                audit_id: audit_id(&pending_request.request_id, "replied"),
                request: pending_request.clone(),
                event: PermissionAuditEvent::Replied {
                    reply: pending_reply.clone(),
                    source,
                },
                timestamp_ms,
            })
            .collect::<Vec<_>>();
        self.reply_store
            .commit_permission_reply(grants.clone(), audit)
            .await
            .map_err(PermissionRequestManagerError::ReplyStore)?;

        let resolved_request_ids = resolutions
            .iter()
            .map(|(pending_request, _)| pending_request.request_id.clone())
            .collect::<Vec<_>>();
        {
            let _snapshot_write = self
                .snapshot_barrier
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut removed = false;
            for (pending_request, pending_reply) in resolutions {
                if let Some((_, pending)) = self.pending.remove(&pending_request.request_id) {
                    removed = true;
                    let _ = pending
                        .sender
                        .send(PermissionWaitOutcome::Replied(pending_reply.clone()));
                    if pending.interactive {
                        let _ = self.events.send(PermissionRequestEvent::Replied {
                            request_id: pending_request.request_id,
                            reply: pending_reply,
                            source,
                        });
                    }
                }
            }
            if removed {
                self.snapshot_revision.fetch_add(1, Ordering::Release);
            }
        }

        Ok(PermissionReplyResolution {
            request,
            reply,
            saved_grants: grants,
            resolved_request_ids,
        })
    }

    pub async fn cancel_request(
        &self,
        request_id: &str,
        reason: impl Into<String>,
    ) -> Result<bool, PermissionRequestManagerError> {
        let _operation = self.operations.lock().await;
        let Some(request) = self
            .pending
            .get(request_id)
            .map(|entry| entry.request.clone())
        else {
            return Ok(false);
        };
        self.cancel_requests(vec![request], reason.into()).await?;
        Ok(true)
    }

    pub async fn cancel_session(
        &self,
        session_id: &str,
        reason: impl Into<String>,
    ) -> Result<Vec<String>, PermissionRequestManagerError> {
        let _operation = self.operations.lock().await;
        let requests =
            self.ordered_pending_requests(|pending| pending.request.session_id == session_id);
        let request_ids = requests
            .iter()
            .map(|request| request.request_id.clone())
            .collect();
        self.cancel_requests(requests, reason.into()).await?;
        Ok(request_ids)
    }

    async fn cancel_requests(
        &self,
        requests: Vec<PermissionRequest>,
        reason: String,
    ) -> Result<(), PermissionRequestManagerError> {
        let timestamp_ms = self.clock.now_unix_millis();
        for request in &requests {
            self.audit_store
                .append_permission_audit(PermissionAuditRecord {
                    audit_id: audit_id(&request.request_id, "cancelled"),
                    request: request.clone(),
                    event: PermissionAuditEvent::Cancelled {
                        reason: reason.clone(),
                    },
                    timestamp_ms,
                })
                .await
                .map_err(PermissionRequestManagerError::AuditStore)?;
        }

        {
            let _snapshot_write = self
                .snapshot_barrier
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut removed = false;
            for request in requests {
                if let Some((_, pending)) = self.pending.remove(&request.request_id) {
                    removed = true;
                    let _ = pending.sender.send(PermissionWaitOutcome::Cancelled {
                        reason: reason.clone(),
                    });
                    if pending.interactive {
                        let _ = self.events.send(PermissionRequestEvent::Cancelled {
                            request_id: request.request_id,
                            reason: reason.clone(),
                        });
                    }
                }
            }
            if removed {
                self.snapshot_revision.fetch_add(1, Ordering::Release);
            }
        }
        Ok(())
    }
}

fn grants_for_reply(
    request: &PermissionRequest,
    reply: &PermissionReply,
    created_at_ms: i64,
) -> Vec<PermissionGrant> {
    if !matches!(reply, PermissionReply::Always) {
        return Vec::new();
    }

    let mut unique = HashSet::new();
    request
        .save_resources
        .iter()
        .filter(|resource| unique.insert((*resource).clone()))
        .map(|resource| PermissionGrant {
            project_id: request.project_id.clone(),
            action: request.action.clone(),
            resource: resource.clone(),
            created_at_ms,
        })
        .collect()
}

fn audit_id(request_id: &str, event: &str) -> String {
    format!("{request_id}:{event}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_runtime_ports::{
        PermissionAuditStorePort, PermissionReplyStorePort, PortResult, RuntimeServiceCapability,
        RuntimeServicePort,
    };
    use serde_json::Map;
    use std::sync::Mutex as StdMutex;

    #[derive(Debug, Default)]
    struct MemoryPermissionStore {
        audit: StdMutex<Vec<PermissionAuditRecord>>,
    }

    impl RuntimeServicePort for MemoryPermissionStore {
        fn capability(&self) -> RuntimeServiceCapability {
            RuntimeServiceCapability::Permission
        }
    }

    #[async_trait::async_trait]
    impl PermissionAuditStorePort for MemoryPermissionStore {
        async fn append_permission_audit(&self, record: PermissionAuditRecord) -> PortResult<()> {
            self.audit.lock().unwrap().push(record);
            Ok(())
        }

        async fn list_project_permission_audit(
            &self,
            project_id: &str,
        ) -> PortResult<Vec<PermissionAuditRecord>> {
            Ok(self
                .audit
                .lock()
                .unwrap()
                .iter()
                .filter(|record| record.request.project_id == project_id)
                .cloned()
                .collect())
        }
    }

    #[async_trait::async_trait]
    impl PermissionReplyStorePort for MemoryPermissionStore {
        async fn commit_permission_reply(
            &self,
            _grants: Vec<PermissionGrant>,
            audit: Vec<PermissionAuditRecord>,
        ) -> PortResult<()> {
            self.audit.lock().unwrap().extend(audit);
            Ok(())
        }
    }

    #[derive(Debug)]
    struct FixedClock;

    impl RuntimeServicePort for FixedClock {
        fn capability(&self) -> RuntimeServiceCapability {
            RuntimeServiceCapability::Clock
        }
    }

    impl ClockPort for FixedClock {
        fn now_unix_millis(&self) -> i64 {
            42
        }
    }

    fn request() -> PermissionRequest {
        PermissionRequest {
            request_id: "request-1".to_string(),
            round_id: "round-1".to_string(),
            order: 0,
            tool_call_id: None,
            project_path: None,
            project_id: "project-1".to_string(),
            session_id: "session-1".to_string(),
            agent_id: "Standard".to_string(),
            action: "edit".to_string(),
            resources: vec!["src/main.rs".to_string()],
            save_resources: vec!["src/main.rs".to_string()],
            source: openbitfun_runtime_ports::PermissionRequestSource {
                kind: openbitfun_runtime_ports::PermissionRequestSourceKind::ToolCall,
                identity: "write_file".to_string(),
            },
            delegation: None,
            display_metadata: Map::new(),
        }
    }

    #[tokio::test]
    async fn request_events_project_asked_and_replied_lifecycle() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager = PermissionRequestManager::new(store.clone(), store, Arc::new(FixedClock));
        let mut events = manager.subscribe();

        let pending = manager.register(request()).await.expect("register request");
        assert_eq!(
            events.recv().await.expect("asked event"),
            PermissionRequestEvent::Asked { request: request() }
        );
        assert_eq!(manager.pending_requests(), vec![request()]);
        let asked_snapshot = manager.interactive_pending_snapshot();
        assert_eq!(asked_snapshot.requests, vec![request()]);
        assert!(asked_snapshot.revision > 0);

        manager
            .reply(
                "request-1",
                PermissionReply::Once,
                PermissionReplySource::User,
            )
            .await
            .expect("reply request");
        assert_eq!(
            events.recv().await.expect("replied event"),
            PermissionRequestEvent::Replied {
                request_id: "request-1".to_string(),
                reply: PermissionReply::Once,
                source: PermissionReplySource::User,
            }
        );
        assert_eq!(
            pending.wait().await,
            PermissionWaitOutcome::Replied(PermissionReply::Once)
        );
        assert!(manager.pending_requests().is_empty());
        let replied_snapshot = manager.interactive_pending_snapshot();
        assert!(replied_snapshot.requests.is_empty());
        assert!(replied_snapshot.revision > asked_snapshot.revision);

        let cancelled = manager
            .register(PermissionRequest {
                request_id: "request-2".to_string(),
                ..request()
            })
            .await
            .expect("register second request");
        let _ = events.recv().await.expect("second asked event");
        manager
            .cancel_request("request-2", "session closed")
            .await
            .expect("cancel request");
        assert!(matches!(
            events.recv().await.expect("cancelled event"),
            PermissionRequestEvent::Cancelled { request_id, reason }
                if request_id == "request-2" && reason == "session closed"
        ));
        assert_eq!(
            cancelled.wait().await,
            PermissionWaitOutcome::Cancelled {
                reason: "session closed".to_string()
            }
        );
    }

    #[tokio::test]
    async fn non_interactive_request_is_audited_without_entering_interactive_surfaces() {
        let store = Arc::new(MemoryPermissionStore::default());
        let manager =
            PermissionRequestManager::new(store.clone(), store.clone(), Arc::new(FixedClock));
        let mut events = manager.subscribe();

        let pending = manager
            .register_non_interactive(request())
            .await
            .expect("register non-interactive request");

        assert_eq!(manager.pending_requests(), vec![request()]);
        assert!(manager.interactive_pending_requests().is_empty());
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));

        manager
            .reply(
                "request-1",
                PermissionReply::Once,
                PermissionReplySource::AutoApprove,
            )
            .await
            .expect("auto-approve request");

        assert_eq!(
            pending.wait().await,
            PermissionWaitOutcome::Replied(PermissionReply::Once)
        );
        assert!(manager.pending_requests().is_empty());
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(store.audit.lock().unwrap().len(), 2);
    }
}
