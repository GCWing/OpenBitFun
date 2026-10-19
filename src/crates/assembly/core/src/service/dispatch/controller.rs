use openbitfun_services_integrations::remote_ssh::{
    dispatch_ssh::{
        self, DispatchCliRelease, DispatchInstallPoll, DispatchInstallStart, DispatchSshProbe,
    },
    SSHConnectionManager,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::service::git::trust;
use crate::service::worktree::WorktreeService;

use super::baseline::{
    base_commit_is_published, build_base_bundle, ensure_baseline_branch, fetch_result_bundle,
    outbound_record_owns_baseline, prepare_baseline, release_prepared_baseline, PreparedBaseline,
};
use super::preparation::{DispatchPreparationRequest, DispatchPreparationTarget};
use super::{
    adopt_target_jobs, DispatchTarget, DispatchTargetRequest, OutboundDispatchRecord,
    OutboundDispatchStore,
};

pub(super) const DISPATCH_PROTOCOL_VERSION: u64 =
    openbitfun_services_core::dispatch_contract::DISPATCH_PROTOCOL_VERSION as u64;
pub(super) const MAX_DISPATCH_TEXT_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchListTargetsRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchProbeTargetRequest {
    pub target: DispatchTargetRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchConnectionRequest {
    pub connection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInstallStartRequest {
    pub connection_id: String,
    pub release: DispatchCliRelease,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInstallPollRequest {
    pub connection_id: String,
    #[serde(default)]
    pub cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchSubmitRequest {
    pub target: DispatchTargetRequest,
    /// Revision used to create the controller baseline worktree. It is
    /// resolved once, then both sides use the resulting immutable commit.
    #[serde(default)]
    pub base_ref: Option<String>,
    /// Carry the baseline worktree's uncommitted changes into `base_commit`.
    #[serde(default)]
    pub include_uncommitted: bool,
    pub job_id: String,
    pub session_id: String,
    pub agent_type: String,
    pub prompt: String,
    pub approval_policy: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_preset: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Controller-side workspace that owns the observer session.
    #[serde(default)]
    pub source_workspace_path: Option<String>,
    #[serde(default)]
    pub source_workspace_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<DispatchAttachmentPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchStatusRequest {
    pub job_id: String,
    #[serde(default)]
    pub cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchJobRequest {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchSyncResultRequest {
    pub job_id: String,
    /// Commit message used when the target still has uncommitted changes.
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchPermissionReplyKind {
    Once,
    Always,
    Reject,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchAnswerRequest {
    pub job_id: String,
    pub request_id: String,
    pub reply: DispatchPermissionReplyKind,
    #[serde(default)]
    pub feedback: Option<String>,
}

/// Start the next turn of an existing dispatch session.
///
/// Separate from `append`, which steers a turn that is still running: this one
/// is for a job whose previous turn has finished, and it is what makes a
/// dispatch session hold a conversation instead of a single exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchContinueRequest {
    pub job_id: String,
    /// Caller-generated identity so a retry cannot start two turns.
    pub turn_id: String,
    pub prompt: String,
    #[serde(default)]
    pub display_content: Option<String>,
    /// Per-turn model override; carries forward as the job's model.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_preset: Option<String>,
    /// Per-turn approval-policy override with the same carry-forward rule.
    #[serde(default)]
    pub approval_policy: Option<String>,
    /// Operation kind understood by the target (`prompt` default, `compact`).
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub attachments: Vec<DispatchAttachmentPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchAppendRequest {
    pub job_id: String,
    pub message_id: String,
    pub content: String,
    #[serde(default)]
    pub display_content: Option<String>,
    /// Attachments injected with the message into the running turn, under the
    /// same structural limits as a turn submission's.
    #[serde(default)]
    pub attachments: Vec<DispatchAttachmentPayload>,
}

/// The wire shape and structural limits come from the shared contract; the
/// controller only adds transport-owned policy (the device inline budget).
pub(super) use openbitfun_services_core::dispatch_contract::DispatchAttachment as DispatchAttachmentPayload;

pub(super) fn validate_attachment_payloads(
    attachments: &[DispatchAttachmentPayload],
) -> anyhow::Result<()> {
    openbitfun_services_core::dispatch_contract::validate_dispatch_attachments(attachments)
        .map_err(|error| anyhow::anyhow!(error))
}

pub(super) fn validate_device_attachment_budget(
    attachments: &[DispatchAttachmentPayload],
) -> anyhow::Result<()> {
    let total: usize = attachments
        .iter()
        .map(|attachment| attachment.data_url.len())
        .sum();
    if total
        > openbitfun_services_core::dispatch_contract::MAX_DEVICE_DISPATCH_ATTACHMENTS_TOTAL_BYTES
    {
        anyhow::bail!(
            "Device dispatch carries at most 192 KiB of inline images; use an SSH target for larger screenshots"
        );
    }
    Ok(())
}

/// Read-only persisted-state question answered by the target without
/// starting a turn or initializing a runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchQueryJobRequest {
    pub job_id: String,
    /// Query kind understood by the target.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_chunk: Option<openbitfun_services_core::dispatch_contract::DispatchFileChunkRequest>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchListJobsRequest {
    #[serde(default)]
    pub target: Option<DispatchTargetRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTargetOption {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
}

pub async fn list_targets(
    manager: &SSHConnectionManager,
    _request: DispatchListTargetsRequest,
) -> anyhow::Result<Vec<DispatchTargetOption>> {
    let mut targets = vec![DispatchTargetOption {
        kind: "local".to_string(),
        connection_id: None,
        device_id: None,
        display_name: "Local".to_string(),
        description: None,
        online: None,
    }];
    targets.extend(
        manager
            .get_saved_connections()
            .await
            .into_iter()
            .map(|connection| DispatchTargetOption {
                kind: "ssh".to_string(),
                connection_id: Some(connection.id),
                device_id: None,
                display_name: connection.name,
                description: Some(format!(
                    "{}@{}:{}",
                    connection.username, connection.host, connection.port
                )),
                online: None,
            }),
    );
    Ok(targets)
}

pub async fn probe_target(
    manager: &SSHConnectionManager,
    request: DispatchProbeTargetRequest,
) -> anyhow::Result<DispatchSshProbe> {
    let DispatchTargetRequest::Ssh {
        connection_id,
        workspace_path,
    } = request.target
    else {
        anyhow::bail!("SSH dispatch probing requires an SSH target");
    };
    dispatch_ssh::probe(manager, &connection_id, nonempty(&workspace_path)).await
}

pub async fn install_cli_start(
    manager: &SSHConnectionManager,
    request: DispatchInstallStartRequest,
) -> anyhow::Result<DispatchInstallStart> {
    dispatch_ssh::install_cli_start(manager, request.connection_id.trim(), &request.release).await
}

pub async fn install_cli_poll(
    manager: &SSHConnectionManager,
    request: DispatchInstallPollRequest,
) -> anyhow::Result<DispatchInstallPoll> {
    dispatch_ssh::install_cli_poll(manager, request.connection_id.trim(), request.cursor).await
}

pub async fn install_cli_cancel(
    manager: &SSHConnectionManager,
    request: DispatchConnectionRequest,
) -> anyhow::Result<()> {
    dispatch_ssh::install_cli_cancel(manager, request.connection_id.trim()).await
}

#[derive(Debug, thiserror::Error)]
#[error("{reason}")]
struct SubscriptionModelSyncUnsupported {
    reason: String,
}

fn protected_model_sync_payload(config: &Value) -> anyhow::Result<Value> {
    let mut protected = config.clone();
    openbitfun_config_contracts::protected_account_models::protect_account_models(&mut protected);
    let ai = protected
        .get("ai")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("exported model configuration has no AI section"))?;
    let mut payload = serde_json::Map::new();
    for key in [
        "models",
        "default_models",
        "agent_model_defaults",
        "agent_model_selections",
        "model_pools",
    ] {
        if let Some(value) = ai.get(key) {
            payload.insert(key.to_string(), value.clone());
        }
    }
    Ok(Value::Object(payload))
}

fn subscription_model_sync_requirements(
    payload: &Value,
) -> Result<Vec<&'static str>, SubscriptionModelSyncUnsupported> {
    use crate::service::config::AuthConfig;
    use openbitfun_services_core::dispatch_contract::{
        DISPATCH_SUBSCRIPTION_ACCOUNT_BINDINGS_CAPABILITY,
        DISPATCH_SUBSCRIPTION_ACCOUNT_FAILOVER_CAPABILITY,
    };
    // The codec owns guard versions and opaque-source restoration. Inspect its
    // supported live auth facts instead of duplicating version rules here.
    let mut provider_accounts = false;
    let mut restored = json!({"ai":payload});
    if !openbitfun_config_contracts::protected_account_models::restore_account_models(&mut restored)
        .is_empty()
    {
        return Err(SubscriptionModelSyncUnsupported {
            reason: "The controller has an unsupported subscription binding version or invalid record; the source and target configurations were preserved. Update OpenBitFun before syncing this model.".into(),
        });
    }
    let mut bindings = false;
    let mut failover = false;
    let mut channels = false;
    for model in restored
        .pointer("/ai/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(route) = model
            .get("channel_routing")
            .filter(|value| !value.is_null())
        {
            let route: openbitfun_config_contracts::channel_routing::ModelChannelRouting =
                serde_json::from_value(route.clone()).map_err(|_| {
                    SubscriptionModelSyncUnsupported {
                        reason: "Unsupported channel routing record; configuration was preserved"
                            .into(),
                    }
                })?;
            if route.version != 1 {
                return Err(SubscriptionModelSyncUnsupported {
                    reason: "Unsupported channel routing version; configuration was preserved"
                        .into(),
                });
            }
            channels = true;
        }
        let auth = match model.get("auth") {
            Some(auth) => serde_json::from_value::<AuthConfig>(auth.clone()).map_err(|_| {
                SubscriptionModelSyncUnsupported {
                    reason: "The controller has unsupported model authentication; its configuration was preserved and no model sync was attempted.".into(),
                }
            })?,
            None => AuthConfig::ApiKey,
        };
        match auth {
            AuthConfig::SubscriptionPool { provider, .. } => {
                provider_accounts |=
                    provider != crate::service::config::types::SubscriptionProvider::Codex;
                bindings = true;
                failover = true;
            }
            AuthConfig::Subscription {
                provider,
                account_id: Some(_),
                ..
            } => {
                bindings = true;
                provider_accounts |=
                    provider != crate::service::config::types::SubscriptionProvider::Codex;
            }
            _ => {}
        }
    }
    let mut required = Vec::new();
    if provider_accounts {
        required.push(openbitfun_services_core::dispatch_contract::DISPATCH_SUBSCRIPTION_PROVIDER_ACCOUNTS_CAPABILITY);
    }
    if channels {
        required.push(
            openbitfun_services_core::dispatch_contract::DISPATCH_MODEL_CHANNEL_ROUTING_CAPABILITY,
        );
    }
    if bindings {
        required.push(DISPATCH_SUBSCRIPTION_ACCOUNT_BINDINGS_CAPABILITY);
    }
    if failover {
        required.push(DISPATCH_SUBSCRIPTION_ACCOUNT_FAILOVER_CAPABILITY);
    }
    Ok(required)
}

fn validate_subscription_model_sync(
    payload: &Value,
    protocol: Option<&Value>,
) -> Result<(), SubscriptionModelSyncUnsupported> {
    let required = subscription_model_sync_requirements(payload)?;
    let needs_routing_support = !required.is_empty();
    let advertised = protocol
        .and_then(|protocol| protocol.get("capabilities"))
        .and_then(Value::as_array);
    let missing: Vec<_> = required
        .into_iter()
        .filter(|required| {
            !advertised.is_some_and(|capabilities| {
                capabilities
                    .iter()
                    .any(|capability| capability.as_str() == Some(required))
            })
        })
        .collect();
    if !missing.is_empty() {
        return Err(SubscriptionModelSyncUnsupported {
            reason: format!(
                "The target OpenBitFun host does not support the configured model routing (missing {}). Update the target before syncing; OAuth credentials are not transferred and must be authorized on the executing host.",
                missing.join(", "),
            ),
        });
    }
    if needs_routing_support {
        let protocol = protocol.ok_or_else(|| SubscriptionModelSyncUnsupported {
            reason: "The target returned no dispatch protocol for routed model sync".into(),
        })?;
        dispatch_ssh::validate_dispatch_protocol(protocol, None).map_err(|error| {
            SubscriptionModelSyncUnsupported {
                reason: format!(
                    "The target is incompatible with routed model configuration sync: {error}"
                ),
            }
        })?;
    }
    Ok(())
}

/// Copy this controller's model configuration (catalog, credentials, and
/// default-model selections) onto the SSH target so its CLI can resolve a
/// ready model.
///
/// Credential-bearing: this writes the controller's API keys into the target
/// user's OpenBitFun configuration. Callers are the explicit UI command and the
/// automatic submit-time repair in [`ensure_target_model_config`]; both leave
/// a durable record of having done it.
/// Explicit account bindings use the protected export codec and require the
/// target's runtime capability before any model config is written. OAuth
/// credentials are not included; referenced slots belong to the executing host.
pub(super) async fn push_model_config(
    manager: &SSHConnectionManager,
    connection_id: &str,
    target_protocol: Option<&Value>,
) -> anyhow::Result<()> {
    crate::service::config::initialize_global_config()
        .await
        .map_err(|error| anyhow::anyhow!("initialize controller configuration: {error}"))?;
    let config_service = crate::service::config::get_global_config_service()
        .await
        .map_err(|error| anyhow::anyhow!("read controller configuration: {error}"))?;
    // Use the existing export codec, including retained opaque compatible-source
    // fields. A raw serialization can rebind an old target to its default slot.
    let export = config_service
        .export_config()
        .await
        .map_err(|error| anyhow::anyhow!("export controller model configuration: {error}"))?;
    if !export.config.ai.models.iter().any(|model| model.enabled) {
        anyhow::bail!("no enabled AI model is configured on this device to sync");
    }
    let payload = protected_model_sync_payload(
        &serde_json::to_value(export.config)
            .map_err(|error| anyhow::anyhow!("encode controller model configuration: {error}"))?,
    )?;
    let needs_routing_support = !subscription_model_sync_requirements(&payload)?.is_empty();
    // Reuse the submit-time probe. Explicit sync probes only when the new
    // routing semantics require negotiation; ordinary fixed API-key sync stays unchanged.
    let probe = if needs_routing_support && target_protocol.is_none() {
        Some(dispatch_ssh::probe(manager, connection_id, None).await?)
    } else {
        None
    };
    validate_subscription_model_sync(
        &payload,
        target_protocol.or_else(|| probe.as_ref().and_then(|probe| probe.protocol.as_ref())),
    )?;
    dispatch_ssh::sync_model_config(manager, connection_id, &payload).await
}

pub async fn sync_model_config(
    manager: &SSHConnectionManager,
    request: DispatchConnectionRequest,
) -> anyhow::Result<()> {
    push_model_config(manager, request.connection_id.trim(), None).await
}

pub async fn submit(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchSubmitRequest,
) -> anyhow::Result<Value> {
    validate_submit_request(&request)?;

    let DispatchTargetRequest::Ssh {
        connection_id,
        // The target path is the target's business now: dispatch always checks
        // out its own worktree there rather than reusing a directory.
        workspace_path: _,
    } = &request.target
    else {
        anyhow::bail!("SSH dispatch submission requires an SSH target");
    };
    if connection_id.trim().is_empty() {
        anyhow::bail!("SSH dispatch requires a connectionId");
    }

    let source_workspace_path = request
        .source_workspace_path
        .as_deref()
        .unwrap_or_default()
        .trim();
    let project_workspace_path =
        WorktreeService::resolve_project_workspace_path(source_workspace_path)
            .await
            .map_err(|error| anyhow::anyhow!("resolve the dispatch project workspace: {error}"))?;
    // One controller process at a time may install/provision/submit a job. The
    // JSON journal uses a different lock, so audit events can still be appended
    // atomically while this long-lived guard is held.
    let _preparation_run_lock = store.acquire_preparation_run_lock(&request.job_id).await?;
    if let Some(existing) = store.get(&request.job_id).await? {
        if existing.session_id != request.session_id
            || !matches!(
                &existing.target,
                DispatchTarget::Ssh {
                    connection_id: existing_connection,
                    ..
                } if existing_connection == connection_id
            )
        {
            anyhow::bail!("Dispatch jobId is already bound to another target or session");
        }
    }
    store
        .begin_preparation(DispatchPreparationRequest {
            job_id: request.job_id.clone(),
            session_id: request.session_id.clone(),
            target: DispatchPreparationTarget::ssh(connection_id.clone()),
            source_workspace_path: source_workspace_path.to_string(),
            project_workspace_path,
        })
        .await?;

    // Re-check the executable that will receive this submission, installing it
    // when missing. The picker probe can be stale, and headless callers bypass
    // the UI entirely. Every audit event is durably journaled before the
    // corresponding remote mutation, then replayed into the target event log.
    let audit_attempt = uuid::Uuid::new_v4().as_simple().to_string();
    let mut audit_sequence = 0_u32;
    let audit_store = store.clone();
    let audit_job_id = request.job_id.clone();
    let cli_probe =
        dispatch_ssh::ensure_target_cli(manager, connection_id, move |stage, release| {
            audit_sequence = audit_sequence.saturating_add(1);
            let event_id = format!("{audit_attempt}:{audit_sequence}");
            let stage = stage.to_string();
            let audit_store = audit_store.clone();
            let audit_job_id = audit_job_id.clone();
            async move {
                log::info!("Dispatch SSH CLI install: stage={stage} details={release}");
                audit_store
                    .append_preparation_setup_audit(
                        &audit_job_id,
                        &event_id,
                        json!({
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                            "action": "cli-install",
                            "details": {
                                "stage": stage,
                                "release": release,
                            },
                        }),
                    )
                    .await
            }
        })
        .await?;
    recover_interrupted_cli_install_audit(store, &request.job_id, &cli_probe).await?;
    let cli_protocol = cli_probe.protocol.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "{}",
            cli_probe
                .protocol_error
                .as_deref()
                .or(cli_probe.install_error.as_deref())
                .unwrap_or("OpenBitFun CLI dispatch protocol is unavailable on the SSH target")
        )
    })?;
    dispatch_ssh::validate_dispatch_protocol(cli_protocol, Some(&request.approval_policy))?;

    // Prepare the model before the Git baseline: the composer offers this
    // controller's own model list, so the target is brought up to it here
    // rather than failing the submission back to the user with a manual step.
    // Doing it now also means a target that cannot serve the model at all
    // fails before a worktree is created and released again.
    let cli_probe = ensure_target_model_config(
        manager,
        store,
        &request.job_id,
        connection_id,
        cli_probe,
        request.model.as_deref(),
    )
    .await?;
    let cli_protocol = cli_probe.protocol.as_ref().ok_or_else(|| {
        anyhow::anyhow!("OpenBitFun CLI dispatch protocol is unavailable on the SSH target")
    })?;
    if !target_serves_model(cli_protocol, request.model.as_deref()) {
        anyhow::bail!(
            "{}",
            unservable_model_message(cli_protocol, request.model.as_deref())
        );
    }

    let baseline = prepare_baseline(
        store,
        &request.job_id,
        source_workspace_path,
        request.base_ref.as_deref(),
        request.include_uncommitted,
    )
    .await?;
    if let Err(error) = store
        .attach_preparation_baseline(
            &request.job_id,
            &baseline.delivery.baseline_worktree_id,
            &baseline.delivery.branch,
        )
        .await
    {
        release_prepared_baseline(store, &request.job_id, &baseline).await;
        return Err(error);
    }
    store.touch_preparation(&request.job_id).await?;

    let workspace_path =
        match provision_ssh_workspace(manager, store, connection_id, &request.job_id, &baseline)
            .await
        {
            Ok(path) => path,
            Err(error) => {
                release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
                return Err(error);
            }
        };
    store.touch_preparation(&request.job_id).await?;

    // Provision owns the canonical target path. Probe that exact worktree so
    // model readiness and Git identity are checked immediately before submit.
    let workspace_probe =
        match dispatch_ssh::probe(manager, connection_id, Some(&workspace_path)).await {
            Ok(probe) => probe,
            Err(error) => {
                release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
                return Err(error);
            }
        };
    let protocol = match workspace_probe.protocol.as_ref() {
        Some(protocol) => protocol,
        None => {
            release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
            anyhow::bail!(
                "{}",
                workspace_probe.protocol_error.as_deref().unwrap_or(
                    "OpenBitFun CLI dispatch protocol is unavailable in the target worktree"
                )
            );
        }
    };
    if let Err(error) =
        dispatch_ssh::validate_dispatch_protocol(protocol, Some(&request.approval_policy)).and_then(
            |_| {
                validate_submission_preflight(
                    protocol,
                    request.model.as_deref(),
                    request.reasoning_preset.as_deref(),
                )
            },
        )
    {
        release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
        return Err(error);
    }

    let display_name = manager
        .get_saved_connections()
        .await
        .into_iter()
        .find(|connection| connection.id == *connection_id)
        .map(|connection| connection.name)
        .unwrap_or_else(|| connection_id.clone());
    let resolved_target = DispatchTarget::Ssh {
        connection_id: connection_id.clone(),
        workspace_path: workspace_path.clone(),
        display_name,
    };

    let requested_record = match OutboundDispatchRecord::new(
        request.job_id.clone(),
        resolved_target,
        request.session_id.clone(),
        workspace_path.clone(),
        &request.prompt,
        "submitting",
    ) {
        Ok(record) => record,
        Err(error) => {
            release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
            return Err(error.into());
        }
    }
    .with_submission_metadata(
        request.title.clone(),
        request.agent_type.clone(),
        request.approval_policy.clone(),
        request.model.clone(),
        request.reasoning_preset.clone(),
    )
    .with_source_workspace(
        request.source_workspace_path.clone(),
        request.source_workspace_id.clone(),
    )
    .with_baseline(&baseline.delivery, &baseline.worktree_path);
    let bound_record = bind_outbound_record(store, &requested_record, &baseline).await?;
    if bound_record.session_id != request.session_id
        || !same_target_identity(&bound_record.target, &requested_record.target)
    {
        anyhow::bail!("Dispatch jobId is already bound to another target or session");
    }
    store
        .mark_preparation_outbound_bound(&request.job_id)
        .await?;
    let setup_audit = setup_audit_for_target(
        store.preparation_setup_audit(&request.job_id).await?,
        protocol,
    );

    let mut protocol_request = json!({
        "protocolVersion": DISPATCH_PROTOCOL_VERSION,
        "jobId": request.job_id.clone(),
        "sessionId": request.session_id.clone(),
        "workspacePath": workspace_path,
        "agentType": request.agent_type,
        "prompt": request.prompt,
        "approvalPolicy": request.approval_policy,
        "setupAudit": setup_audit,
    });
    if let Some(model) = request.model.filter(|value| !value.trim().is_empty()) {
        protocol_request["model"] = Value::String(model);
    }
    if let Some(preset) = request
        .reasoning_preset
        .filter(|value| !value.trim().is_empty())
    {
        protocol_request["reasoningPreset"] = Value::String(preset);
    }
    if let Some(title) = request.title.filter(|value| !value.trim().is_empty()) {
        protocol_request["title"] = Value::String(title);
    }
    if !request.attachments.is_empty() {
        protocol_request["attachments"] = serde_json::to_value(&request.attachments)?;
    }

    let response = match dispatch_ssh::submit(manager, connection_id, &protocol_request).await {
        Ok(response) => response,
        Err(error) => {
            // The SSH response can be lost after the target has durably
            // accepted and detached the worker. Preserve an observable,
            // retryable state instead of freezing the outbound record at a
            // false terminal failure; status or an idempotent re-submit will
            // reconcile the authoritative target state.
            let _ = store
                .update_progress(&request.job_id, 0, "submission_unknown")
                .await;
            return Err(error);
        }
    };
    if let Err(error) = validate_submit_ack(&response, &request.job_id, &request.session_id) {
        let _ = store
            .update_progress(&request.job_id, 0, "submission_unknown")
            .await;
        return Err(error);
    }
    let state = response
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("queued")
        .to_string();
    store.update_progress(&request.job_id, 0, state).await?;
    if let Err(error) = store.acknowledge_preparation(&request.job_id).await {
        // The target ACK is authoritative. Retaining a redundant journal is
        // safe and lets status/retry remove it later; failing the already-live
        // task here would be misleading.
        log::warn!(
            "Failed to remove acknowledged dispatch preparation: job_id={} error={}",
            request.job_id,
            error
        );
    }
    Ok(response)
}

/// Whether the target can already run the model this submission needs.
///
/// Mirrors the model half of [`validate_submission_preflight`], which stays
/// the authoritative check immediately before submit. This one exists so the
/// controller can tell "needs repair" from "genuinely unusable" early, while
/// repair is still cheap.
pub(super) fn target_serves_model(protocol: &Value, requested_model: Option<&str>) -> bool {
    match requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        Some(model) => protocol
            .get("availableModels")
            .and_then(Value::as_array)
            .is_some_and(|models| models.iter().any(|entry| entry.as_str() == Some(model))),
        None => protocol.get("modelConfigured").and_then(Value::as_bool) == Some(true),
    }
}

fn unservable_model_message(protocol: &Value, requested_model: Option<&str>) -> String {
    match requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        Some(model) => {
            format!("Requested model '{model}' is not ready on the dispatch target")
        }
        None => protocol
            .get("modelDiagnostic")
            .and_then(Value::as_str)
            .filter(|diagnostic| !diagnostic.trim().is_empty())
            .unwrap_or("No ready default model is configured on the dispatch target")
            .to_string(),
    }
}

/// Bring the target's model configuration up to this controller's when the
/// target cannot serve the submission's model, then re-probe.
///
/// Returns the probe the caller should keep using: the fresh one when a sync
/// happened, the original otherwise. A failed sync is not fatal here — the
/// caller reports the target's own model diagnostic, which describes the
/// user-visible problem better than a transport error from the repair attempt.
async fn ensure_target_model_config(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    job_id: &str,
    connection_id: &str,
    probe: DispatchSshProbe,
    requested_model: Option<&str>,
) -> anyhow::Result<DispatchSshProbe> {
    if probe
        .protocol
        .as_ref()
        .is_some_and(|protocol| target_serves_model(protocol, requested_model))
    {
        return Ok(probe);
    }

    let attempt = uuid::Uuid::new_v4().as_simple().to_string();

    log::info!(
        "Dispatch SSH model sync: stage=model-sync-started connection_id={connection_id} requested_model={requested_model:?}"
    );
    // Persisted before the remote mutation, exactly like the CLI installer: a
    // controller that dies mid-write must still leave evidence that this
    // device's credentials may have reached the target.
    append_model_sync_audit(
        store,
        job_id,
        &attempt,
        1,
        "model-sync-started",
        json!({ "requestedModel": requested_model }),
    )
    .await
    .map_err(|error| anyhow::anyhow!("persist the model sync started audit event: {error}"))?;

    if let Err(error) = push_model_config(manager, connection_id, probe.protocol.as_ref()).await {
        log::warn!("Dispatch SSH model sync failed: connection_id={connection_id} error={error}");
        append_model_sync_audit(
            store,
            job_id,
            &attempt,
            2,
            "model-sync-failed",
            json!({ "error": bounded_audit_detail(&error) }),
        )
        .await?;
        // A known unsupported binding is actionable preflight failure, not a
        // transport repair miss that can fall back to a generic readiness error.
        if error
            .downcast_ref::<SubscriptionModelSyncUnsupported>()
            .is_some()
        {
            return Err(error);
        }
        return Ok(probe);
    }

    // Re-probe with no workspace path: this only needs to re-read the model
    // readiness the sync just changed.
    let resynced = match dispatch_ssh::probe(manager, connection_id, None).await {
        Ok(resynced) => resynced,
        Err(error) => {
            append_model_sync_audit(
                store,
                job_id,
                &attempt,
                2,
                "model-sync-failed",
                json!({ "error": bounded_audit_detail(&error) }),
            )
            .await?;
            return Err(error);
        }
    };
    let model_count = resynced
        .protocol
        .as_ref()
        .and_then(|protocol| protocol.get("availableModels"))
        .and_then(Value::as_array)
        .map(|models| models.len())
        .unwrap_or(0);
    append_model_sync_audit(
        store,
        job_id,
        &attempt,
        2,
        "model-sync-succeeded",
        json!({ "modelCount": model_count }),
    )
    .await?;
    log::info!(
        "Dispatch SSH model sync: stage=model-sync-succeeded connection_id={connection_id} model_count={model_count}"
    );
    Ok(resynced)
}

/// An audit event has a hard size limit, and a transport failure can carry an
/// unbounded remote tail. Truncating keeps a real failure from turning into a
/// confusing "audit event too large" error that hides it.
fn bounded_audit_detail(error: &anyhow::Error) -> String {
    const MAX_AUDIT_DETAIL_CHARS: usize = 512;
    let message = error.to_string();
    let mut chars = message.chars();
    let truncated: String = chars.by_ref().take(MAX_AUDIT_DETAIL_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

async fn append_model_sync_audit(
    store: &OutboundDispatchStore,
    job_id: &str,
    attempt: &str,
    sequence: u32,
    stage: &str,
    detail: Value,
) -> anyhow::Result<()> {
    store
        .append_preparation_setup_audit(
            job_id,
            &format!("{attempt}:model-sync:{sequence}"),
            json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "action": openbitfun_services_core::dispatch_contract::DISPATCH_MODEL_SYNC_SETUP_AUDIT_ACTION,
                "details": {
                    "stage": stage,
                    // Never the synced payload itself: it carries API keys.
                    "sync": detail,
                },
            }),
        )
        .await
}

/// Narrow the controller's own setup journal to the audit rows this target
/// accepts. A target rejects an unknown action outright, so forwarding one
/// would turn a working submission into a hard failure on an older CLI.
fn setup_audit_for_target(events: Vec<Value>, protocol: &Value) -> Vec<Value> {
    let capabilities: Vec<&str> = protocol
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    events
        .into_iter()
        .filter(|event| {
            event
                .get("action")
                .and_then(Value::as_str)
                .is_some_and(|action| {
                    openbitfun_services_core::dispatch_contract::
                        dispatch_target_accepts_setup_audit_action(action, &capabilities)
                })
        })
        .collect()
}

async fn recover_interrupted_cli_install_audit(
    store: &OutboundDispatchStore,
    job_id: &str,
    probe: &DispatchSshProbe,
) -> anyhow::Result<()> {
    let events = store.preparation_setup_audit(job_id).await?;
    if events.is_empty() {
        return Ok(());
    }
    let last_stage = events.iter().rev().find_map(|event| {
        event
            .pointer("/details/stage")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|stage| !stage.is_empty())
    });
    if last_stage == Some("cli-install-succeeded") {
        return Ok(());
    }
    let version = probe
        .protocol
        .as_ref()
        .and_then(|protocol| protocol.get("cliVersion"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    store
        .append_preparation_setup_audit(
            job_id,
            &format!("recovered-{}", uuid::Uuid::new_v4().as_simple()),
            json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "action": "cli-install",
                "details": {
                    "stage": "cli-install-succeeded",
                    "release": {
                        "version": version,
                        "cliPath": probe.cli_path,
                        "recovered": true,
                    },
                },
            }),
        )
        .await
}

pub(super) async fn release_unbound_preparation_baseline(
    store: &OutboundDispatchStore,
    job_id: &str,
    baseline: &PreparedBaseline,
) {
    release_prepared_baseline(store, job_id, baseline).await;
    if let Err(error) = store.clear_preparation_baseline(job_id).await {
        // Keep the exact journal on any ambiguity. Expiry reconciliation can
        // retry the release, whereas deleting its identity could strand it.
        log::warn!(
            "Failed to clear released dispatch preparation baseline: job_id={} error={}",
            job_id,
            error
        );
    }
}

/// Bind the record that takes ownership of a prepared baseline claim.
///
/// A JSON-store error can be ambiguous (for example, permission hardening can
/// fail after the atomic rename). Re-read before releasing so a durable record
/// never loses the claim that keeps its baseline alive.
pub(super) async fn bind_outbound_record(
    store: &OutboundDispatchStore,
    record: &OutboundDispatchRecord,
    baseline: &PreparedBaseline,
) -> anyhow::Result<OutboundDispatchRecord> {
    match store.bind_if_absent(record).await {
        Ok(bound)
            if outbound_record_owns_baseline(
                &bound,
                &baseline.delivery.baseline_worktree_id,
                &baseline.delivery.base_commit,
                &baseline.delivery.branch,
            ) =>
        {
            Ok(bound)
        }
        Ok(_) => {
            release_prepared_baseline(store, &record.job_id, baseline).await;
            anyhow::bail!(
                "Dispatch jobId is already bound to a different baseline worktree, commit, or branch"
            );
        }
        Err(error) => {
            // The write may have become durable before permission hardening or
            // another post-rename step failed. The ownership-aware release
            // helper re-reads the record and preserves a matching claim.
            release_prepared_baseline(store, &record.job_id, baseline).await;
            Err(error.into())
        }
    }
}

/// Check out the baseline commit on the target, shipping objects if needed.
///
/// The target answers `needsBundle` when its own clone cannot reach the commit.
/// Only then does anything cross the wire, so the common case — a commit that
/// is already on the shared remote — costs one round trip and no transfer.
async fn provision_ssh_workspace(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    connection_id: &str,
    job_id: &str,
    baseline: &PreparedBaseline,
) -> anyhow::Result<String> {
    // Both attempts must send an identical request: the target treats a
    // differing request for one job as a conflicting baseline and refuses it.
    let request = json!({
        "protocolVersion": DISPATCH_PROTOCOL_VERSION,
        "jobId": job_id,
        "repoKey": baseline.repo_key,
        "projectLabel": baseline.project_label,
        "remoteUrl": baseline.delivery.remote_url,
        "baseCommit": baseline.delivery.base_commit,
        "branch": baseline.delivery.branch,
    });

    let response = dispatch_ssh::provision_workspace(manager, connection_id, &request).await?;
    if let Some(path) = provisioned_path(&response) {
        return Ok(path);
    }
    if response.get("needsBundle").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("dispatch target neither provisioned a workspace nor asked for a bundle");
    }

    let have_tips = target_have_tips(&response);
    if base_commit_is_published(&baseline.worktree_path, &baseline.delivery.base_commit).await {
        // Worth saying out loud: the commit is on the remote, so the target
        // asking for it means its clone is stale or its network is down. Say why
        // when the target told us — on a cold cache this fallback re-sends the
        // project's whole history over SSH, and "the remote refused us" is the
        // difference between a slow dispatch and a misconfigured target.
        match target_fetch_error(&response) {
            Some(reason) => log::warn!(
                "Dispatch target could not fetch a published base commit ({reason}); delivering {} history by bundle instead",
                if have_tips.is_empty() { "the entire" } else { "the missing" }
            ),
            None => log::info!(
                "Dispatch target could not reach a published base commit; delivering it by bundle"
            ),
        }
    }
    let bundle = build_base_bundle(store, baseline, &have_tips).await?;
    let upload = dispatch_ssh::upload_bundle(
        manager,
        connection_id,
        job_id,
        &bundle.sha256,
        bundle.size,
        &bundle.path,
    )
    .await;
    // The objects are in the target repository now; the local artifact is pure
    // duplication of history this machine already owns. Remove it either way so
    // a failed upload does not leave a stale bundle behind.
    let _ = std::fs::remove_file(&bundle.path);
    upload?;

    let response = dispatch_ssh::provision_workspace(manager, connection_id, &request).await?;
    provisioned_path(&response).ok_or_else(|| {
        anyhow::anyhow!("dispatch target could not check out the base commit after the bundle")
    })
}

/// Why the target fell back to bundle delivery, when it said.
pub(super) fn target_fetch_error(response: &Value) -> Option<String> {
    response
        .get("fetchError")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn target_have_tips(response: &Value) -> Vec<String> {
    response
        .get("haveTips")
        .and_then(Value::as_array)
        .map(|tips| {
            tips.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn provisioned_path(response: &Value) -> Option<String> {
    if response.get("provisioned").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    response
        .get("workspacePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
}

pub async fn status(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchStatusRequest,
) -> anyhow::Result<Value> {
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch status requires an SSH target");
    };
    let response = dispatch_ssh::status(
        manager,
        connection_id,
        &json!({ "jobId": request.job_id, "cursor": request.cursor }),
    )
    .await?;
    if let Err(error) = store.acknowledge_preparation(&record.job_id).await {
        log::warn!(
            "Failed to remove dispatch preparation after status confirmation: job_id={} error={}",
            record.job_id,
            error
        );
    }

    // The request cursor is the last cursor the observer already applied. The
    // response cursor is deliberately not persisted until the next poll, so a
    // controller crash cannot skip events.
    let state = response
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or(record.last_state.as_str())
        .to_string();
    store
        .update_progress(&record.job_id, request.cursor, state)
        .await?;
    Ok(response)
}

pub async fn query_job(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchQueryJobRequest,
) -> anyhow::Result<Value> {
    validate_query_request(&request)?;
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch query requires an SSH target");
    };
    if matches!(request.kind.as_str(), "readFile" | "readFileChunk") {
        let probe = dispatch_ssh::probe(manager, connection_id, None).await?;
        validate_file_query_capability(probe.protocol.as_ref(), &request.kind)?;
    }
    dispatch_ssh::query(manager, connection_id, &serde_json::to_value(request)?).await
}

pub(super) fn validate_file_query_capability(
    protocol: Option<&Value>,
    kind: &str,
) -> anyhow::Result<()> {
    let required = if kind == "readFileChunk" {
        openbitfun_services_core::dispatch_contract::DISPATCH_FILE_CHUNKS_CAPABILITY
    } else {
        openbitfun_services_core::dispatch_contract::DISPATCH_READ_FILE_CAPABILITY
    };
    let supported = protocol
        .and_then(|value| value.get("capabilities"))
        .and_then(Value::as_array)
        .is_some_and(|capabilities| {
            capabilities
                .iter()
                .any(|capability| capability.as_str() == Some(required))
        });
    if !supported {
        anyhow::bail!("This target does not support remote file previews. Update its CLI or sync changes to view files.");
    }
    Ok(())
}

pub(super) fn validate_query_request(request: &DispatchQueryJobRequest) -> anyhow::Result<()> {
    if request.job_id.trim().is_empty() {
        anyhow::bail!("Dispatch query requires a jobId");
    }
    if request.kind.trim().is_empty() || request.kind.len() > 64 {
        anyhow::bail!("Dispatch query kind is invalid");
    }
    if matches!(request.kind.as_str(), "readFile" | "readFileChunk")
        && request
            .file_path
            .as_deref()
            .is_none_or(|path| path.trim().is_empty())
    {
        anyhow::bail!("Dispatch file query requires a filePath");
    }
    if !matches!(request.kind.as_str(), "readFile" | "readFileChunk") && request.file_path.is_some()
    {
        anyhow::bail!("Only a dispatch file query accepts a filePath");
    }
    if request.kind == "readFileChunk" {
        let chunk = request
            .file_chunk
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Dispatch chunk query requires fileChunk"))?;
        if chunk.limit == 0
            || chunk.limit
                > openbitfun_services_core::dispatch_contract::DISPATCH_FILE_CHUNK_MAX_BYTES
        {
            anyhow::bail!("Invalid dispatch output chunk size");
        }
        if chunk.offset > 0 && chunk.expected_revision.as_deref().is_none_or(str::is_empty) {
            anyhow::bail!("A file revision is required to resume this download");
        }
    } else if request.file_chunk.is_some() {
        anyhow::bail!("Only a chunk query accepts fileChunk");
    }
    // Which kinds exist is the target's contract; an unknown kind comes back
    // as a clear target-side error instead of drifting a second list here.
    Ok(())
}

/// Bring the target's work back into this controller's baseline worktree.
///
/// One button, two halves: the target commits and bundles its branch, then the
/// controller fast-forwards its baseline onto it. There is no conflict handling
/// because there is no conflict to have — both sides share the base commit, so
/// the fetch either fast-forwards or fails loudly because the user committed
/// into the baseline themselves.
pub async fn sync_result(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchSyncResultRequest,
) -> anyhow::Result<Value> {
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch sync requires an SSH target");
    };
    let destination = result_bundle_path(store, &request.job_id).await?;
    let response = dispatch_ssh::sync_workspace(
        manager,
        connection_id,
        &request.job_id,
        request.message.as_deref(),
        record.synced_head_commit.as_deref(),
        &destination,
    )
    .await?;
    finish_sync(store, &record, response, &destination).await
}

/// Fast-forward the baseline worktree and record what was synced.
///
/// Shared by both transports: only fetching the bundle differs between SSH and
/// an account device.
pub(super) async fn finish_sync(
    store: &OutboundDispatchStore,
    record: &OutboundDispatchRecord,
    mut response: Value,
    bundle: &std::path::Path,
) -> anyhow::Result<Value> {
    if response.get("changed").and_then(Value::as_bool) != Some(true) {
        // A clean sync is still an acknowledgement of the target head. Carry
        // it into the next request so a later click starts a fresh detached
        // sync operation if the still-running agent has since added commits.
        if let Some(head) = response.get("headCommit").and_then(Value::as_str) {
            store.record_synced_head(&record.job_id, head).await?;
        }
        return Ok(response);
    }
    let (Some(worktree_path), Some(branch)) = (
        record.baseline_worktree_path.as_deref(),
        record.branch.as_deref(),
    ) else {
        anyhow::bail!(
            "This dispatch has no recorded baseline worktree, so its result cannot be synced.              It was submitted before Git-worktree delivery."
        );
    };
    if !std::path::Path::new(worktree_path).is_dir() {
        anyhow::bail!(
            "The baseline worktree for this dispatch is missing ({worktree_path}).              Recreate it before syncing."
        );
    }

    ensure_baseline_branch(worktree_path, branch).await?;
    let head = fetch_result_bundle(worktree_path, branch, bundle).await?;
    store.record_synced_head(&record.job_id, &head).await?;
    // The bundle's objects are in the repository now, so keeping the file only
    // duplicates history the user already has.
    let _ = std::fs::remove_file(bundle);
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "baselineWorktreePath".to_string(),
            Value::String(worktree_path.to_string()),
        );
        object.insert("syncedHeadCommit".to_string(), Value::String(head));
    }
    Ok(response)
}

pub(super) async fn result_bundle_path(
    store: &OutboundDispatchStore,
    job_id: &str,
) -> anyhow::Result<std::path::PathBuf> {
    Ok(store.results_dir().await?.join(format!("{job_id}.bundle")))
}

pub async fn cancel(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchJobRequest,
) -> anyhow::Result<Value> {
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch cancellation requires an SSH target");
    };
    let response =
        dispatch_ssh::cancel(manager, connection_id, &json!({ "jobId": request.job_id })).await?;
    if response
        .get("cancelled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        store
            .update_progress(&record.job_id, record.last_cursor, "cancelled")
            .await?;
    }
    Ok(response)
}

pub async fn answer(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchAnswerRequest,
) -> anyhow::Result<Value> {
    validate_answer_request(&request)?;
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch permission answers require an SSH target");
    };
    let mut payload = json!({
        "jobId": request.job_id,
        "requestId": request.request_id,
        "reply": request.reply,
    });
    if let Some(feedback) = request.feedback.filter(|value| !value.trim().is_empty()) {
        payload["feedback"] = Value::String(feedback);
    }
    dispatch_ssh::answer(manager, connection_id, &payload).await
}

pub async fn append(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchAppendRequest,
) -> anyhow::Result<Value> {
    validate_append_request(&request)?;
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch message append requires an SSH target");
    };
    dispatch_ssh::append(manager, connection_id, &serde_json::to_value(request)?).await
}

/// Send the next turn of a dispatch session to its SSH target.
pub async fn continue_job(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchContinueRequest,
) -> anyhow::Result<Value> {
    validate_continue_request(&request)?;
    let record = store
        .get(&request.job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Outbound dispatch job was not found"))?;
    let DispatchTarget::Ssh { connection_id, .. } = &record.target else {
        anyhow::bail!("SSH dispatch follow-up requires an SSH target");
    };
    let response =
        dispatch_ssh::continue_job(manager, connection_id, &continue_payload(&request)).await?;
    record_follow_up_state(store, &record, &request, &response).await;
    Ok(response)
}

/// The wire payload both transports send for a follow-up turn.
pub(super) fn continue_payload(request: &DispatchContinueRequest) -> Value {
    let mut payload = json!({
        "protocolVersion": DISPATCH_PROTOCOL_VERSION,
        "jobId": request.job_id,
        "turnId": request.turn_id,
        "prompt": request.prompt,
    });
    if let Some(display) = request
        .display_content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["displayContent"] = Value::String(display.to_string());
    }
    if let Some(model) = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["model"] = Value::String(model.to_string());
    }
    if let Some(preset) = request
        .reasoning_preset
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["reasoningPreset"] = Value::String(preset.to_string());
    }
    if let Some(policy) = request
        .approval_policy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["approvalPolicy"] = Value::String(policy.to_string());
    }
    if let Some(kind) = request
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["kind"] = Value::String(kind.to_string());
    }
    if !request.attachments.is_empty() {
        payload["attachments"] = serde_json::to_value(&request.attachments).unwrap_or(Value::Null);
    }
    payload
}

/// Move the observer record back out of its terminal state.
///
/// Best effort: the next status poll reconciles it from the target anyway, but
/// updating here keeps the composer from briefly re-offering "send" as if the
/// follow-up had not been accepted.
pub(super) async fn record_follow_up_state(
    store: &OutboundDispatchStore,
    record: &OutboundDispatchRecord,
    request: &DispatchContinueRequest,
    response: &Value,
) {
    if let Err(error) = store
        .update_submission_options(
            &record.job_id,
            request.model.as_deref(),
            request.reasoning_preset.as_deref(),
            request.approval_policy.as_deref(),
        )
        .await
    {
        log::warn!(
            "Failed to record dispatch follow-up options: job_id={} error={error}",
            record.job_id
        );
    }
    let Some(state) = response.get("state").and_then(Value::as_str) else {
        return;
    };
    if let Err(error) = store
        .update_progress(&record.job_id, record.last_cursor, state)
        .await
    {
        log::warn!(
            "Failed to record dispatch follow-up state: job_id={} error={error}",
            record.job_id
        );
    }
}

pub async fn list_jobs(
    manager: &SSHConnectionManager,
    store: &OutboundDispatchStore,
    request: DispatchListJobsRequest,
) -> anyhow::Result<Value> {
    let Some(target) = request.target else {
        return Ok(serde_json::to_value(store.list().await?)?);
    };
    let DispatchTargetRequest::Ssh { connection_id, .. } = target else {
        anyhow::bail!("SSH dispatch listing requires an SSH target");
    };
    let display_name = manager
        .get_saved_connections()
        .await
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .map(|connection| connection.name)
        .unwrap_or_else(|| connection_id.clone());
    let response = dispatch_ssh::list(manager, &connection_id, &json!({})).await?;
    adopt_target_jobs(
        store,
        &DispatchTarget::Ssh {
            connection_id,
            workspace_path: String::new(),
            display_name,
        },
        &response,
    )
    .await?;
    Ok(response)
}

pub(super) fn validate_submit_request(request: &DispatchSubmitRequest) -> anyhow::Result<()> {
    if !matches!(
        request.approval_policy.as_str(),
        "auto" | "reject-and-report" | "remote"
    ) {
        anyhow::bail!(
            "Dispatch approvalPolicy must be explicitly set to auto, reject-and-report, or remote"
        );
    }
    if request.job_id.trim().is_empty() || request.session_id.trim().is_empty() {
        anyhow::bail!("Dispatch jobId and sessionId cannot be empty");
    }
    if request.agent_type.trim().is_empty() {
        anyhow::bail!("Dispatch agentType cannot be empty");
    }
    if request.prompt.trim().is_empty() {
        anyhow::bail!("Dispatch prompt cannot be empty");
    }
    if request.prompt.len() > MAX_DISPATCH_TEXT_BYTES {
        anyhow::bail!("Dispatch prompt exceeds the 32 KiB request limit");
    }
    if request.base_ref.as_ref().is_some_and(|base_ref| {
        base_ref.trim().is_empty()
            || base_ref.len() > 512
            || base_ref.bytes().any(|byte| byte.is_ascii_control())
    }) {
        anyhow::bail!("Dispatch baseRef is invalid");
    }
    validate_attachment_payloads(&request.attachments)?;
    Ok(())
}

pub(super) fn validate_append_request(request: &DispatchAppendRequest) -> anyhow::Result<()> {
    if request.message_id.trim().is_empty() || request.message_id.len() > 128 {
        anyhow::bail!("Dispatch messageId must contain 1-128 bytes");
    }
    // An attachment-only message is a real message; only one with neither text
    // nor attachments is empty.
    if request.content.trim().is_empty() && request.attachments.is_empty() {
        anyhow::bail!("Dispatch appended message cannot be empty");
    }
    let total_bytes = request
        .content
        .len()
        .saturating_add(request.display_content.as_ref().map_or(0, String::len));
    if total_bytes > MAX_DISPATCH_TEXT_BYTES {
        anyhow::bail!("Dispatch appended message exceeds the 32 KiB request limit");
    }
    validate_attachment_payloads(&request.attachments)?;
    Ok(())
}

pub(super) fn validate_continue_request(request: &DispatchContinueRequest) -> anyhow::Result<()> {
    if request.turn_id.trim().is_empty() || request.turn_id.len() > 128 {
        anyhow::bail!("Dispatch turnId must contain 1-128 bytes");
    }
    // Kind/prompt semantics (which kinds exist, which take a prompt) are the
    // target's contract; duplicating that list here would drift. Only
    // transport-owned limits are enforced below.
    let total_bytes = request
        .prompt
        .len()
        .saturating_add(request.display_content.as_ref().map_or(0, String::len));
    if total_bytes > MAX_DISPATCH_TEXT_BYTES {
        anyhow::bail!("Dispatch follow-up exceeds the 32 KiB request limit");
    }
    if let Some(model) = &request.model {
        if model.trim().is_empty() || model.len() > 256 {
            anyhow::bail!("Dispatch model override must contain 1-256 bytes");
        }
    }
    if let Some(policy) = &request.approval_policy {
        if !matches!(policy.as_str(), "auto" | "reject-and-report" | "remote") {
            anyhow::bail!("Dispatch approval policy override is not recognized");
        }
    }
    validate_attachment_payloads(&request.attachments)?;
    Ok(())
}

pub(super) fn validate_answer_request(request: &DispatchAnswerRequest) -> anyhow::Result<()> {
    if request.request_id.trim().is_empty() || request.request_id.len() > 512 {
        anyhow::bail!("Dispatch permission requestId is invalid");
    }
    if request
        .feedback
        .as_ref()
        .is_some_and(|feedback| feedback.len() > MAX_DISPATCH_TEXT_BYTES)
    {
        anyhow::bail!("Dispatch permission feedback exceeds the 32 KiB request limit");
    }
    Ok(())
}

pub(super) fn validate_submit_ack(
    response: &Value,
    job_id: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    if response.get("accepted").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("Dispatch target did not accept the job");
    }
    if response.get("jobId").and_then(Value::as_str) != Some(job_id)
        || response.get("sessionId").and_then(Value::as_str) != Some(session_id)
    {
        anyhow::bail!("Dispatch target returned a mismatched acknowledgement");
    }
    Ok(())
}

pub(super) fn same_target_identity(left: &DispatchTarget, right: &DispatchTarget) -> bool {
    match (left, right) {
        (DispatchTarget::Local, DispatchTarget::Local) => true,
        (
            DispatchTarget::Ssh {
                connection_id: left_connection,
                workspace_path: left_workspace,
                ..
            },
            DispatchTarget::Ssh {
                connection_id: right_connection,
                workspace_path: right_workspace,
                ..
            },
        ) => left_connection == right_connection && left_workspace == right_workspace,
        (
            DispatchTarget::Device {
                device_id: left_device,
                workspace_path: left_workspace,
                ..
            },
            DispatchTarget::Device {
                device_id: right_device,
                workspace_path: right_workspace,
                ..
            },
        ) => left_device == right_device && left_workspace == right_workspace,
        _ => false,
    }
}

pub(super) fn validate_submission_preflight(
    protocol: &Value,
    requested_model: Option<&str>,
    requested_reasoning_preset: Option<&str>,
) -> anyhow::Result<()> {
    let workspace = protocol
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("Dispatch target did not report workspace readiness"))?;
    if workspace.get("exists").and_then(Value::as_bool) != Some(true)
        || workspace.get("isDirectory").and_then(Value::as_bool) != Some(true)
        || workspace.get("isGitRepository").and_then(Value::as_bool) != Some(true)
    {
        anyhow::bail!("Dispatch workspace is not a Git worktree on the target");
    }
    // A repository the target's Git refuses on ownership grounds still *is* one,
    // so the probe answers `isGitRepository: true` and the check above passes.
    // Submitting anyway creates the record, ships the job, and fails on the
    // target at the worker's first Git read — far from the person who could act
    // on it. Nothing here can fix it either: the trust decision belongs to the
    // machine holding the repository, and this controller cannot write that
    // host's configuration. Refusing now, by name, is the only honest outcome.
    if workspace.get("trustRequired").and_then(Value::as_bool) == Some(true) {
        // The path the *target* reported, not the one this controller asked
        // about: the probe canonicalizes it, and the command below has to be run
        // over there.
        let path = workspace.get("path").and_then(Value::as_str);
        let remedy = path.map_or_else(
            || "Add the workspace to that host's `safe.directory` configuration".to_string(),
            |path| format!("Run `{}` on that host", trust::manual_trust_command(path)),
        );
        anyhow::bail!(
            "Git on the dispatch target refuses '{}': the repository is owned by another user \
             there. {remedy} and submit again",
            path.unwrap_or("the dispatch workspace")
        );
    }
    let selected_model = if let Some(requested_model) = requested_model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        let available = protocol
            .get("availableModels")
            .and_then(Value::as_array)
            .is_some_and(|models| {
                models
                    .iter()
                    .any(|model| model.as_str() == Some(requested_model))
            });
        if !available {
            anyhow::bail!(
                "Requested model '{requested_model}' is not ready on the dispatch target"
            );
        }
        requested_model
    } else if protocol.get("modelConfigured").and_then(Value::as_bool) != Some(true) {
        let diagnostic = protocol
            .get("modelDiagnostic")
            .and_then(Value::as_str)
            .unwrap_or("No ready default model is configured on the dispatch target");
        anyhow::bail!("{diagnostic}");
    } else {
        protocol
            .get("defaultModel")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!("Dispatch target did not report a ready default model")
            })?
    };

    if let Some(preset) = requested_reasoning_preset
        .map(str::trim)
        .filter(|preset| !preset.is_empty() && *preset != "auto")
    {
        let supported = protocol
            .get("modelCatalog")
            .and_then(|catalog| catalog.get("models"))
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|model| model.get("id").and_then(Value::as_str) == Some(selected_model))
            })
            .and_then(|model| model.get("reasoning"))
            .and_then(|reasoning| reasoning.get("presets"))
            .and_then(Value::as_array)
            .is_some_and(|presets| {
                presets
                    .iter()
                    .any(|candidate| candidate.get("id").and_then(Value::as_str) == Some(preset))
            });
        if !supported {
            anyhow::bail!(
                "Reasoning preset '{preset}' is not available for target model '{selected_model}'"
            );
        }
    }
    Ok(())
}

fn nonempty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscription_sync_protocol(extra: &[&str]) -> Value {
        let mut capabilities: Vec<_> =
            openbitfun_services_core::dispatch_contract::dispatch_required_target_capabilities()
                .collect();
        capabilities.extend_from_slice(extra);
        json!({"productId":openbitfun_services_core::product_identity::product_id(),
            "dataNamespace":openbitfun_services_core::product_identity::data_namespace(),
            "protocolVersion":DISPATCH_PROTOCOL_VERSION,"capabilities":capabilities})
    }

    fn subscription_sync_fixture(auth: crate::service::config::AuthConfig) -> Value {
        let mut config = crate::service::config::GlobalConfig::default();
        config.ai.models = vec![crate::service::config::AIModelConfig {
            id: "sync-model".into(),
            name: "Sync fixture".into(),
            model_name: "fixture-model".into(),
            provider: "responses".into(),
            base_url: "https://fixture.invalid/v1".into(),
            enabled: true,
            api_key: "synthetic-static-key".into(),
            auth,
            ..Default::default()
        }];
        config.ai.default_models.primary = Some("sync-model".into());
        serde_json::to_value(config).unwrap()
    }

    #[test]
    fn subscription_model_sync_uses_guarded_export_and_restores_the_exact_binding() {
        use crate::service::config::{AuthConfig, SubscriptionProvider};
        use openbitfun_config_contracts::protected_account_models::{
            restore_account_models, ACCOUNT_MODEL_GUARD_KEY, ACCOUNT_MODEL_GUARD_URL,
        };
        for auth in [
            AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: Some("codex-account-58134808-15a6-45db-ae33-2ad7d85cc570".into()),
            },
            AuthConfig::SubscriptionPool {
                provider: SubscriptionProvider::Codex,
                accounts: vec![
                    "codex".into(),
                    "codex-account-58134808-15a6-45db-ae33-2ad7d85cc570".into(),
                ],
                revision: 7,
            },
        ] {
            let original = subscription_sync_fixture(auth);
            let mut payload = protected_model_sync_payload(&original).unwrap();
            assert_eq!(
                payload.as_object().unwrap().len(),
                3,
                "sync must not carry unrelated host settings"
            );
            assert_eq!(payload["models"][0]["auth"]["type"], "api_key");
            assert_eq!(payload["models"][0]["base_url"], ACCOUNT_MODEL_GUARD_URL);
            assert_eq!(
                payload["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["model"]["auth"],
                original["ai"]["models"][0]["auth"]
            );
            payload["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["model"]
                ["future_source_field"] = json!({"retained":true});
            let mut target = json!({"ai":payload});
            let repeated = protected_model_sync_payload(&target).unwrap();
            assert_eq!(
                repeated["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["model"]
                    ["future_source_field"],
                json!({"retained":true})
            );
            assert!(restore_account_models(&mut target).is_empty());
            assert_eq!(
                target["ai"]["models"][0]["auth"],
                original["ai"]["models"][0]["auth"]
            );
            assert_eq!(
                target["ai"]["default_models"],
                original["ai"]["default_models"]
            );
        }
    }

    #[test]
    fn channel_model_sync_negotiates_channels_independently_and_preserves_unsupported_records() {
        use crate::service::config::AuthConfig;
        use openbitfun_services_core::dispatch_contract::DISPATCH_MODEL_CHANNEL_ROUTING_CAPABILITY as CHANNELS;
        let mut original = subscription_sync_fixture(AuthConfig::ApiKey);
        let mut backup = original["ai"]["models"][0].clone();
        backup["id"] = json!("sync-backup");
        backup["api_key"] = json!("synthetic-backup-key");
        backup["base_url"] = json!("https://backup.invalid/v1");
        original["ai"]["models"]
            .as_array_mut()
            .unwrap()
            .push(backup);
        original["ai"]["models"][0]["channel_routing"] = json!({"version":1,"fallback_model_ids":["sync-backup"],"manual_channel":"sync-backup"});
        let payload = protected_model_sync_payload(&original).unwrap();
        assert_eq!(
            subscription_model_sync_requirements(&payload).unwrap(),
            vec![CHANNELS]
        );
        assert!(
            validate_subscription_model_sync(&payload, Some(&subscription_sync_protocol(&[])))
                .unwrap_err()
                .to_string()
                .contains(CHANNELS)
        );
        assert!(
            validate_subscription_model_sync(
                &payload,
                Some(&subscription_sync_protocol(&[CHANNELS]))
            )
            .is_ok(),
            "API-key channels must not require subscription-account capabilities"
        );
        let before = payload.clone();
        assert!(validate_subscription_model_sync(&payload, None).is_err());
        assert_eq!(
            payload, before,
            "unsupported targets cannot rewrite or downgrade the protected source"
        );
        original["ai"]["models"][0]["channel_routing"]["version"] = json!(99);
        let future = protected_model_sync_payload(&original).unwrap();
        assert!(validate_subscription_model_sync(
            &future,
            Some(&subscription_sync_protocol(&[CHANNELS]))
        )
        .is_err());
    }

    #[test]
    fn other_provider_model_sync_requires_explicit_support_before_any_remote_write() {
        use crate::service::config::{AuthConfig, SubscriptionProvider};
        use openbitfun_services_core::dispatch_contract::{
            DISPATCH_SUBSCRIPTION_ACCOUNT_BINDINGS_CAPABILITY as BINDINGS,
            DISPATCH_SUBSCRIPTION_ACCOUNT_FAILOVER_CAPABILITY as FAILOVER,
            DISPATCH_SUBSCRIPTION_PROVIDER_ACCOUNTS_CAPABILITY as PROVIDERS,
        };
        for provider in [
            SubscriptionProvider::Antigravity,
            SubscriptionProvider::Opencode,
            SubscriptionProvider::Grok,
            SubscriptionProvider::Hermes,
        ] {
            let source = subscription_sync_fixture(AuthConfig::SubscriptionPool {
                provider,
                accounts: vec![provider.key().into()],
                revision: 1,
            });
            let payload = protected_model_sync_payload(&source).unwrap();
            let before = payload.clone();
            assert!(validate_subscription_model_sync(
                &payload,
                Some(&subscription_sync_protocol(&[BINDINGS, FAILOVER]))
            )
            .unwrap_err()
            .to_string()
            .contains(PROVIDERS));
            assert_eq!(payload, before);
            assert!(validate_subscription_model_sync(
                &payload,
                Some(&subscription_sync_protocol(&[
                    BINDINGS, FAILOVER, PROVIDERS
                ]))
            )
            .is_ok());
        }
    }

    #[test]
    fn subscription_model_sync_requires_runtime_bindings_and_failover_independently() {
        use crate::service::config::{AuthConfig, SubscriptionProvider};
        use openbitfun_services_core::dispatch_contract::{
            DISPATCH_SUBSCRIPTION_ACCOUNT_BINDINGS_CAPABILITY as BINDINGS,
            DISPATCH_SUBSCRIPTION_ACCOUNT_FAILOVER_CAPABILITY as FAILOVER,
        };
        let fixed =
            protected_model_sync_payload(&subscription_sync_fixture(AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: Some("codex".into()),
            }))
            .unwrap();
        let pool = protected_model_sync_payload(&subscription_sync_fixture(
            AuthConfig::SubscriptionPool {
                provider: SubscriptionProvider::Codex,
                accounts: vec!["codex".into()],
                revision: 1,
            },
        ))
        .unwrap();
        let fixed_only = subscription_sync_protocol(&[BINDINGS]);
        assert!(validate_subscription_model_sync(&fixed, Some(&fixed_only)).is_ok());
        assert!(validate_subscription_model_sync(&pool, Some(&fixed_only))
            .unwrap_err()
            .to_string()
            .contains(FAILOVER));
        assert!(validate_subscription_model_sync(
            &pool,
            Some(&subscription_sync_protocol(&[FAILOVER]))
        )
        .unwrap_err()
        .to_string()
        .contains(BINDINGS));
        assert!(validate_subscription_model_sync(
            &pool,
            Some(&subscription_sync_protocol(&[BINDINGS, FAILOVER]))
        )
        .is_ok());
        for unsupported in [
            None,
            Some(
                json!({"protocolVersion":DISPATCH_PROTOCOL_VERSION,"capabilities":["subscription_account_management_v1"]}),
            ),
            Some(json!({"capabilities":[]})),
        ] {
            let error = validate_subscription_model_sync(&pool, unsupported.as_ref()).unwrap_err();
            let wrapped = anyhow::Error::new(error);
            assert!(wrapped
                .downcast_ref::<SubscriptionModelSyncUnsupported>()
                .is_some());
            assert!(!wrapped.to_string().contains("synthetic-static-key"));
        }
    }

    #[test]
    fn subscription_model_sync_rejects_incompatible_data_spaces_even_with_runtime_flags() {
        use crate::service::config::{AuthConfig, SubscriptionProvider};
        let payload =
            protected_model_sync_payload(&subscription_sync_fixture(AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: Some("codex".into()),
            }))
            .unwrap();
        let valid = subscription_sync_protocol(
            openbitfun_services_core::dispatch_contract::DISPATCH_SUBSCRIPTION_ACCOUNT_CAPABILITIES,
        );
        assert!(validate_subscription_model_sync(&payload, Some(&valid)).is_ok());
        for (field, value) in [
            ("productId", json!("another-product")),
            ("dataNamespace", json!("another-data-space")),
            ("protocolVersion", json!(0)),
        ] {
            let mut incompatible = valid.clone();
            incompatible[field] = value;
            let error =
                validate_subscription_model_sync(&payload, Some(&incompatible)).unwrap_err();
            assert!(error.to_string().contains("incompatible"));
        }
    }

    #[test]
    fn subscription_model_sync_keeps_api_key_and_legacy_default_sync_compatible() {
        use crate::service::config::{AuthConfig, SubscriptionProvider};
        for auth in [
            AuthConfig::ApiKey,
            AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: None,
            },
        ] {
            let original = subscription_sync_fixture(auth);
            let payload = protected_model_sync_payload(&original).unwrap();
            assert_eq!(payload["models"], original["ai"]["models"]);
            assert!(subscription_model_sync_requirements(&payload)
                .unwrap()
                .is_empty());
            assert!(validate_subscription_model_sync(&payload, None).is_ok());
        }
    }

    #[test]
    fn subscription_model_sync_preserves_but_rejects_future_guards_before_transport() {
        use crate::service::config::{AuthConfig, SubscriptionProvider};
        use openbitfun_config_contracts::protected_account_models::ACCOUNT_MODEL_GUARD_KEY;
        let mut payload =
            protected_model_sync_payload(&subscription_sync_fixture(AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                plan: None,
                account_id: Some("codex".into()),
            }))
            .unwrap();
        payload["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["version"] = json!(99);
        let original = payload.clone();
        assert!(validate_subscription_model_sync(&payload, None)
            .unwrap_err()
            .to_string()
            .contains("unsupported subscription binding version"));
        assert_eq!(payload, original);
    }

    #[test]
    fn legacy_query_payload_is_unchanged_and_file_preview_is_optional() {
        let old = json!({"jobId": "job-1", "kind": "usageReport"});
        let request: DispatchQueryJobRequest = serde_json::from_value(old.clone()).unwrap();
        assert!(validate_query_request(&request).is_ok());
        assert_eq!(serde_json::to_value(request).unwrap(), old);
        assert!(validate_file_query_capability(
            Some(&json!({"capabilities": ["session_query"]})),
            "readFile"
        )
        .is_err());
        assert!(validate_file_query_capability(
            Some(&json!({"capabilities": ["query_file_content"]})),
            "readFile"
        )
        .is_ok());
        assert!(validate_file_query_capability(None, "readFile").is_err());
        assert!(validate_file_query_capability(
            Some(&json!({"capabilities": ["query_file_content"]})),
            "readFileChunk"
        )
        .is_err());
        assert!(validate_file_query_capability(
            Some(&json!({"capabilities": ["query_file_chunks_v1"]})),
            "readFileChunk"
        )
        .is_ok());
    }

    #[test]
    fn rejects_false_or_mismatched_submit_acknowledgements() {
        assert!(validate_submit_ack(
            &json!({"accepted": false, "jobId": "j", "sessionId": "s"}),
            "j",
            "s"
        )
        .is_err());
        assert!(validate_submit_ack(
            &json!({"accepted": true, "jobId": "other", "sessionId": "s"}),
            "j",
            "s"
        )
        .is_err());
        assert!(validate_submit_ack(
            &json!({"accepted": true, "jobId": "j", "sessionId": "s"}),
            "j",
            "s"
        )
        .is_ok());
    }

    #[test]
    fn submission_preflight_requires_workspace_and_target_model_readiness() {
        let ready = json!({
            "workspace": { "exists": true, "isDirectory": true, "isGitRepository": true },
            "modelConfigured": true,
            "availableModels": ["target-model"],
            "defaultModel": "target-model",
            "modelCatalog": {
                "models": [{
                    "id": "target-model",
                    "reasoning": { "presets": [{ "id": "high" }] }
                }]
            }
        });
        validate_submission_preflight(&ready, None, None).expect("target default");
        validate_submission_preflight(&ready, Some("target-model"), Some("high"))
            .expect("selected model and preset");
        validate_submission_preflight(&ready, Some("target-model"), Some("auto"))
            .expect("explicit auto");
        assert!(validate_submission_preflight(
            &ready,
            Some("target-model"),
            Some("controller-only")
        )
        .is_err());
        assert!(validate_submission_preflight(&ready, Some("local-only-model"), None).is_err());

        let missing_workspace = json!({
            "workspace": { "exists": false, "isDirectory": false, "isGitRepository": false },
            "modelConfigured": true,
            "availableModels": []
        });
        assert!(validate_submission_preflight(&missing_workspace, None, None).is_err());

        let missing_model = json!({
            "workspace": { "exists": true, "isDirectory": true, "isGitRepository": true },
            "modelConfigured": false,
            "modelDiagnostic": "configure a model",
            "availableModels": []
        });
        assert!(validate_submission_preflight(&missing_model, None, None).is_err());
    }

    /// The target's Git refuses the workspace on ownership grounds. It is still
    /// a repository, so every readiness field says yes — and the job would be
    /// submitted only to die at the worker's first Git read on a host nobody is
    /// watching.
    #[test]
    fn submission_preflight_refuses_a_workspace_the_target_does_not_trust() {
        let untrusted = json!({
            "workspace": {
                "path": "/srv/shared/repo",
                "exists": true,
                "isDirectory": true,
                "isGitRepository": true,
                "trustRequired": true
            },
            "modelConfigured": true,
            "availableModels": ["target-model"],
            "defaultModel": "target-model"
        });
        let error = validate_submission_preflight(&untrusted, None, None)
            .expect_err("an untrusted target workspace cannot be dispatched to");
        let message = error.to_string();
        assert!(message.contains("/srv/shared/repo"), "{message}");
        // The exact command, shell-quoted by the same helper every other surface
        // uses — the user has to paste this into a shell on the target.
        assert!(
            message.contains("git config --global --add safe.directory /srv/shared/repo"),
            "{message}"
        );

        // A target that never reports the field (an older CLI) is unchanged.
        let legacy = json!({
            "workspace": { "exists": true, "isDirectory": true, "isGitRepository": true },
            "modelConfigured": true,
            "availableModels": ["target-model"],
            "defaultModel": "target-model"
        });
        validate_submission_preflight(&legacy, None, None)
            .expect("legacy target stays dispatchable");
    }

    #[test]
    fn model_readiness_distinguishes_repairable_targets_from_unusable_ones() {
        let empty = json!({ "modelConfigured": false, "availableModels": [] });
        assert!(!target_serves_model(&empty, None));
        assert!(!target_serves_model(&empty, Some("local-model")));

        let ready = json!({
            "modelConfigured": true,
            "availableModels": ["local-model", "other-model"],
        });
        assert!(target_serves_model(&ready, None));
        assert!(target_serves_model(&ready, Some("local-model")));
        // A blank selection means "whatever the target defaults to", not a
        // model named "".
        assert!(target_serves_model(&ready, Some("   ")));
        assert!(!target_serves_model(
            &ready,
            Some("model-only-on-controller")
        ));

        // A target with models but no default cannot serve an unspecified
        // choice, so it is still repairable rather than already ready.
        let no_default = json!({
            "modelConfigured": false,
            "availableModels": ["local-model"],
        });
        assert!(!target_serves_model(&no_default, None));
        assert!(target_serves_model(&no_default, Some("local-model")));
    }

    #[test]
    fn setup_audit_drops_rows_an_older_target_would_reject() {
        let events = vec![
            json!({ "action": "cli-install", "details": { "stage": "cli-install-succeeded" } }),
            json!({ "action": "model-sync", "details": { "stage": "model-sync-succeeded" } }),
            json!({ "action": "invented-later", "details": {} }),
        ];

        let legacy = json!({ "capabilities": ["persistent_jobs"] });
        let forwarded = setup_audit_for_target(events.clone(), &legacy);
        assert_eq!(forwarded.len(), 1);
        assert_eq!(forwarded[0]["action"], "cli-install");

        let current = json!({ "capabilities": ["persistent_jobs", "setup_audit_model_sync"] });
        let forwarded = setup_audit_for_target(events, &current);
        assert_eq!(forwarded.len(), 2);
        assert_eq!(forwarded[1]["action"], "model-sync");
    }

    #[test]
    fn continue_payload_preserves_explicit_auto_reasoning_preset() {
        let payload = continue_payload(&DispatchContinueRequest {
            job_id: "job-1".to_string(),
            turn_id: "turn-2".to_string(),
            prompt: "Continue".to_string(),
            display_content: None,
            model: Some("target-model".to_string()),
            reasoning_preset: Some("auto".to_string()),
            approval_policy: None,
            kind: None,
            attachments: Vec::new(),
        });

        assert_eq!(payload["model"], "target-model");
        assert_eq!(payload["reasoningPreset"], "auto");
    }

    #[test]
    fn target_identity_ignores_mutable_display_names() {
        let before = DispatchTarget::Ssh {
            connection_id: "server-a".to_string(),
            workspace_path: "/srv/app".to_string(),
            display_name: "Old label".to_string(),
        };
        let renamed = DispatchTarget::Ssh {
            connection_id: "server-a".to_string(),
            workspace_path: "/srv/app".to_string(),
            display_name: "New label".to_string(),
        };
        assert!(same_target_identity(&before, &renamed));
    }

    #[tokio::test]
    async fn finish_sync_checks_the_recorded_branch_before_reading_the_bundle() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repository = temp.path().join("baseline");
        std::fs::create_dir_all(&repository).expect("repository");
        let init = crate::util::create_test_command("git")
            .arg("-C")
            .arg(&repository)
            .args(["init", "--quiet"])
            .output()
            .expect("run git init");
        assert!(
            init.status.success(),
            "git init failed: {}",
            String::from_utf8_lossy(&init.stderr)
        );

        let branch = crate::util::create_test_command("git")
            .arg("-C")
            .arg(&repository)
            .args(["symbolic-ref", "HEAD", "refs/heads/main"])
            .output()
            .expect("select initial branch");
        assert!(branch.status.success());

        let store =
            OutboundDispatchStore::new_in_root_for_tests(temp.path().join("dispatch-outbound"));
        let mut record = OutboundDispatchRecord::new(
            "job-branch-guard".to_string(),
            DispatchTarget::Local,
            "session-1".to_string(),
            "/target".to_string(),
            "prompt",
            "succeeded",
        )
        .expect("record");
        record.baseline_worktree_path = Some(repository.to_string_lossy().to_string());
        record.branch = Some("openbitfun/dispatch/job-branch-guard".to_string());

        let error = finish_sync(
            &store,
            &record,
            json!({"changed": true}),
            &temp.path().join("missing.bundle"),
        )
        .await
        .expect_err("wrong branch must stop sync before bundle inspection");

        assert!(
            error.to_string().contains("baseline is on branch 'main'"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn compatible_reprobe_recovers_a_durable_started_install_audit_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        store
            .begin_preparation(DispatchPreparationRequest {
                job_id: "job-install-recovery".to_string(),
                session_id: "session-1".to_string(),
                target: DispatchPreparationTarget::ssh("server-1"),
                source_workspace_path: "/repo/linked".to_string(),
                project_workspace_path: "/repo/main".to_string(),
            })
            .await
            .expect("begin preparation");
        store
            .append_preparation_setup_audit(
                "job-install-recovery",
                "attempt-1:1",
                json!({
                    "timestamp": "2026-07-31T00:00:00Z",
                    "action": "cli-install",
                    "details": {
                        "stage": "cli-install-started",
                        "release": { "version": "1.2.3" },
                    },
                }),
            )
            .await
            .expect("started audit");
        let probe = DispatchSshProbe {
            cli_installed: true,
            cli_path: Some("/home/user/.openbitfun/bin/openbitfun".to_string()),
            os: "Linux".to_string(),
            arch: "x86_64".to_string(),
            install_supported: true,
            install_error: None,
            protocol_error: None,
            release: None,
            protocol: Some(json!({ "cliVersion": "1.2.3" })),
            prebuilt_incompatible: None,
        };

        recover_interrupted_cli_install_audit(&store, "job-install-recovery", &probe)
            .await
            .expect("recover audit");
        recover_interrupted_cli_install_audit(&store, "job-install-recovery", &probe)
            .await
            .expect("idempotent recovery");

        let events = store
            .preparation_setup_audit("job-install-recovery")
            .await
            .expect("load audit");
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[1].pointer("/details/stage").and_then(Value::as_str),
            Some("cli-install-succeeded")
        );
        assert_eq!(
            events[1]
                .pointer("/details/release/recovered")
                .and_then(Value::as_bool),
            Some(true)
        );
    }
}
