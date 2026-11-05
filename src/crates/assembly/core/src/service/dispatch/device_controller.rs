use anyhow::{anyhow, Context};
use async_trait::async_trait;
use base64::Engine as _;
use openbitfun_services_integrations::remote_ssh::dispatch_ssh::{
    self, harden_result_directory, DispatchSshProbe,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::service::worktree::WorktreeService;

use super::baseline::{
    build_base_bundle, prepare_baseline, release_prepared_baseline, PreparedBaseline,
};
use super::controller::{
    bind_outbound_record, continue_payload, finish_sync, provisioned_path, record_follow_up_state,
    release_unbound_preparation_baseline, result_bundle_path, same_target_identity,
    target_have_tips, validate_answer_request, validate_append_request, validate_continue_request,
    validate_device_attachment_budget, validate_file_query_capability,
    validate_force_compaction_capability, validate_query_request, validate_submission_preflight,
    validate_submit_ack, validate_submit_request, DispatchAnswerRequest, DispatchAppendRequest,
    DispatchContinueRequest, DispatchJobRequest, DispatchListJobsRequest,
    DispatchProbeTargetRequest, DispatchQueryJobRequest, DispatchStatusRequest,
    DispatchSubmitRequest, DispatchSyncResultRequest, DISPATCH_PROTOCOL_VERSION,
};
use super::preparation::{DispatchPreparationRequest, DispatchPreparationTarget};
use super::{
    adopt_target_jobs, DispatchTarget, DispatchTargetRequest, OutboundDispatchRecord,
    OutboundDispatchStore,
};

const DEVICE_WORKSPACE_CHUNK_BYTES: usize = 256 * 1024;
const DEVICE_WORKSPACE_OPERATION_WAIT: std::time::Duration =
    std::time::Duration::from_secs(30 * 60);
const DEVICE_WORKSPACE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(750);
/// A result bundle carries only the commits made during the job and is streamed
/// into a private staging file, but it is still bounded to limit retained disk
/// usage from an untrusted peer.
const MAX_DEVICE_RESULT_BUNDLE_BYTES: u64 = 256 * 1024 * 1024;

struct UnverifiedResultBundle {
    path: std::path::PathBuf,
    verified: bool,
}

impl UnverifiedResultBundle {
    fn new(path: std::path::PathBuf) -> Self {
        Self {
            path,
            verified: false,
        }
    }

    fn retain(&mut self) {
        self.verified = true;
    }
}

impl Drop for UnverifiedResultBundle {
    fn drop(&mut self) {
        if !self.verified {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Account-device routing is a platform adapter. The product controller owns
/// dispatch semantics while Desktop supplies the encrypted Relay RPC.
#[async_trait]
pub trait DeviceDispatchRpc: Send + Sync {
    async fn invoke(&self, device_id: &str, command: &str, args: Value) -> anyhow::Result<Value>;
}

pub async fn probe_device(
    rpc: &dyn DeviceDispatchRpc,
    request: DispatchProbeTargetRequest,
) -> anyhow::Result<DispatchSshProbe> {
    let DispatchTargetRequest::Device {
        device_id,
        workspace_path,
    } = request.target
    else {
        anyhow::bail!("Device dispatch probe requires a device target");
    };
    if device_id.trim().is_empty() {
        anyhow::bail!("Device dispatch requires a deviceId");
    }
    let args = if workspace_path.trim().is_empty() {
        json!({})
    } else {
        json!({ "workspacePath": workspace_path })
    };
    let protocol = rpc
        .invoke(&device_id, "dispatch_target_probe", args)
        .await?;
    let protocol_error = dispatch_ssh::validate_dispatch_protocol(&protocol, None)
        .err()
        .map(|error| error.to_string());
    Ok(DispatchSshProbe {
        cli_installed: true,
        cli_path: None,
        os: protocol
            .get("os")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        arch: protocol
            .get("arch")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        install_supported: false,
        install_error: None,
        protocol_error,
        release: None,
        protocol: Some(protocol),
        // An account device runs its own already-installed CLI; this
        // controller installs nothing for it.
        prebuilt_incompatible: None,
    })
}

pub async fn submit_device(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    display_name: String,
    request: DispatchSubmitRequest,
) -> anyhow::Result<Value> {
    validate_submit_request(&request)?;
    let DispatchTargetRequest::Device {
        device_id,
        // The target path is the target's business now: dispatch always checks
        // out its own worktree there rather than reusing a directory.
        workspace_path: _,
    } = &request.target
    else {
        anyhow::bail!("Device dispatch submission requires a device target");
    };
    if device_id.trim().is_empty() {
        anyhow::bail!("Device dispatch requires a deviceId");
    }

    // A device cannot be upgraded by this controller. Check protocol support
    // before creating a baseline so an old/offline peer cannot strand a
    // controller-side worktree claim.
    let initial_protocol = rpc
        .invoke(device_id, "dispatch_target_probe", json!({}))
        .await
        .context("probe device dispatch protocol before baseline creation")?;
    dispatch_ssh::validate_dispatch_protocol(&initial_protocol, Some(&request.approval_policy))?;

    let source_workspace_path = request
        .source_workspace_path
        .as_deref()
        .unwrap_or_default()
        .trim();
    let project_workspace_path =
        WorktreeService::resolve_project_workspace_path(source_workspace_path)
            .await
            .map_err(|error| anyhow!("resolve the dispatch project workspace: {error}"))?;
    let _preparation_run_lock = store.acquire_preparation_run_lock(&request.job_id).await?;
    if let Some(existing) = store.get(&request.job_id).await? {
        if existing.session_id != request.session_id
            || !matches!(
                &existing.target,
                DispatchTarget::Device {
                    device_id: existing_device,
                    ..
                } if existing_device == device_id
            )
        {
            anyhow::bail!("Dispatch jobId is already bound to another target or session");
        }
    }
    store
        .begin_preparation(DispatchPreparationRequest {
            job_id: request.job_id.clone(),
            session_id: request.session_id.clone(),
            target: DispatchPreparationTarget::device(device_id.clone()),
            source_workspace_path: source_workspace_path.to_string(),
            project_workspace_path,
        })
        .await?;

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
        match provision_device_workspace(rpc, store, device_id, &request.job_id, &baseline).await {
            Ok(path) => path,
            Err(error) => {
                release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
                return Err(error);
            }
        };
    store.touch_preparation(&request.job_id).await?;
    let protocol = match rpc
        .invoke(
            device_id,
            "dispatch_target_probe",
            json!({ "workspacePath": workspace_path }),
        )
        .await
        .context("probe device immediately before dispatch submission")
    {
        Ok(protocol) => protocol,
        Err(error) => {
            release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
            return Err(error);
        }
    };
    if let Err(error) =
        dispatch_ssh::validate_dispatch_protocol(&protocol, Some(&request.approval_policy))
            .and_then(|_| {
                validate_submission_preflight(
                    &protocol,
                    request.model.as_deref(),
                    request.reasoning_preset.as_deref(),
                )
            })
    {
        release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
        return Err(error);
    }
    let workspace_path = match protocol
        .pointer("/workspace/path")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => path.to_string(),
        None => {
            release_unbound_preparation_baseline(store, &request.job_id, &baseline).await;
            anyhow::bail!("Device dispatch target returned no canonical workspace path");
        }
    };

    let resolved_target = DispatchTarget::Device {
        device_id: device_id.clone(),
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
        .mark_preparation_outbound_bound(&requested_record.job_id)
        .await?;

    let mut payload = json!({
        "protocolVersion": DISPATCH_PROTOCOL_VERSION,
        "jobId": request.job_id,
        "sessionId": request.session_id,
        "workspacePath": workspace_path,
        "agentType": request.agent_type,
        "prompt": request.prompt,
        "approvalPolicy": request.approval_policy,
    });
    if let Some(model) = request.model.filter(|value| !value.trim().is_empty()) {
        payload["model"] = Value::String(model);
    }
    if let Some(preset) = request
        .reasoning_preset
        .filter(|value| !value.trim().is_empty())
    {
        payload["reasoningPreset"] = Value::String(preset);
    }
    if let Some(title) = request.title.filter(|value| !value.trim().is_empty()) {
        payload["title"] = Value::String(title);
    }
    if !request.attachments.is_empty() {
        validate_device_attachment_budget(&request.attachments)?;
        payload["attachments"] = serde_json::to_value(&request.attachments).unwrap_or(Value::Null);
    }

    let response = match rpc
        .invoke(device_id, "dispatch_target_submit", payload)
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let _ = store
                .update_progress(&requested_record.job_id, 0, "submission_unknown")
                .await;
            return Err(error);
        }
    };
    if let Err(error) = validate_submit_ack(
        &response,
        &requested_record.job_id,
        &requested_record.session_id,
    ) {
        let _ = store
            .update_progress(&requested_record.job_id, 0, "submission_unknown")
            .await;
        return Err(error);
    }
    let state = response
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("queued")
        .to_string();
    store
        .update_progress(&requested_record.job_id, 0, state)
        .await?;
    if let Err(error) = store
        .acknowledge_preparation(&requested_record.job_id)
        .await
    {
        log::warn!(
            "Failed to remove acknowledged device dispatch preparation: job_id={} error={}",
            requested_record.job_id,
            error
        );
    }
    Ok(response)
}

pub async fn query_device_job(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchQueryJobRequest,
) -> anyhow::Result<Value> {
    validate_query_request(&request)?;
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };
    if matches!(request.kind.as_str(), "readFile" | "readFileChunk") {
        let protocol = rpc
            .invoke(device_id, "dispatch_target_probe", json!({}))
            .await?;
        validate_file_query_capability(Some(&protocol), &request.kind)?;
    }
    rpc.invoke(
        device_id,
        "dispatch_target_query",
        serde_json::to_value(request)?,
    )
    .await
}

pub async fn status_device(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchStatusRequest,
) -> anyhow::Result<Value> {
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };
    let response = rpc
        .invoke(
            device_id,
            "dispatch_target_status",
            json!({ "jobId": request.job_id, "cursor": request.cursor }),
        )
        .await?;
    if let Err(error) = store.acknowledge_preparation(&record.job_id).await {
        log::warn!(
            "Failed to remove device dispatch preparation after status confirmation: job_id={} error={}",
            record.job_id,
            error
        );
    }
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

pub async fn cancel_device(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchJobRequest,
) -> anyhow::Result<Value> {
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };
    let response = rpc
        .invoke(
            device_id,
            "dispatch_target_cancel",
            json!({ "jobId": request.job_id }),
        )
        .await?;
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

pub async fn answer_device(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchAnswerRequest,
) -> anyhow::Result<Value> {
    validate_answer_request(&request)?;
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };
    rpc.invoke(
        device_id,
        "dispatch_target_answer",
        serde_json::to_value(request)?,
    )
    .await
}

pub async fn append_device(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchAppendRequest,
) -> anyhow::Result<Value> {
    validate_append_request(&request)?;
    validate_device_attachment_budget(&request.attachments)?;
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };
    rpc.invoke(
        device_id,
        "dispatch_target_append",
        serde_json::to_value(request)?,
    )
    .await
}

/// Send the next turn of a dispatch session to an account device.
pub async fn continue_device_job(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchContinueRequest,
) -> anyhow::Result<Value> {
    validate_continue_request(&request)?;
    validate_device_attachment_budget(&request.attachments)?;
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };
    if request.force {
        let protocol = rpc
            .invoke(device_id, "dispatch_target_probe", json!({}))
            .await?;
        validate_force_compaction_capability(Some(&protocol))?;
    }
    let response = rpc
        .invoke(
            device_id,
            "dispatch_target_continue",
            continue_payload(&request),
        )
        .await?;
    record_follow_up_state(store, &record, &request, &response).await;
    Ok(response)
}

pub async fn list_device_jobs(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    display_name: String,
    request: DispatchListJobsRequest,
) -> anyhow::Result<Value> {
    let Some(DispatchTargetRequest::Device { device_id, .. }) = request.target else {
        anyhow::bail!("Device dispatch listing requires a device target");
    };
    let response = rpc
        .invoke(&device_id, "dispatch_target_list", json!({}))
        .await?;
    adopt_target_jobs(
        store,
        &DispatchTarget::Device {
            device_id,
            workspace_path: String::new(),
            display_name,
        },
        &response,
    )
    .await?;
    Ok(response)
}

/// Check out the baseline commit on an account device.
///
/// Same two-phase contract as SSH — provision, and only ship objects when the
/// device says it cannot reach the commit. The device transport carries JSON
/// only, so a bundle travels as base64 chunks inside the existing encrypted
/// envelope rather than over a file channel.
async fn provision_device_workspace(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    device_id: &str,
    job_id: &str,
    baseline: &PreparedBaseline,
) -> anyhow::Result<String> {
    let request = json!({
        "protocolVersion": DISPATCH_PROTOCOL_VERSION,
        "jobId": job_id,
        "repoKey": baseline.repo_key,
        "projectLabel": baseline.project_label,
        "remoteUrl": baseline.delivery.remote_url,
        "baseCommit": baseline.delivery.base_commit,
        "branch": baseline.delivery.branch,
    });

    let response = invoke_device_workspace_operation(
        rpc,
        device_id,
        "dispatch_target_workspace_provision",
        request.clone(),
        "Git workspace provisioning",
    )
    .await?;
    if let Some(path) = provisioned_path(&response) {
        return Ok(path);
    }
    if response.get("needsBundle").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!(
            "Device dispatch target neither provisioned a workspace nor asked for a bundle"
        );
    }

    let bundle = build_base_bundle(store, baseline, &target_have_tips(&response)).await?;
    let upload = upload_device_bundle(rpc, device_id, job_id, &bundle).await;
    let _ = std::fs::remove_file(&bundle.path);
    upload?;

    let response = invoke_device_workspace_operation(
        rpc,
        device_id,
        "dispatch_target_workspace_provision",
        request,
        "Git workspace provisioning",
    )
    .await?;
    provisioned_path(&response).ok_or_else(|| {
        anyhow!("Device dispatch target could not check out the base commit after the bundle")
    })
}

async fn invoke_device_workspace_operation(
    rpc: &dyn DeviceDispatchRpc,
    device_id: &str,
    command: &str,
    args: Value,
    operation: &str,
) -> anyhow::Result<Value> {
    let deadline = tokio::time::Instant::now() + DEVICE_WORKSPACE_OPERATION_WAIT;
    loop {
        let response = rpc.invoke(device_id, command, args.clone()).await?;
        if response.get("pending").and_then(Value::as_bool) != Some(true) {
            return Ok(response);
        }
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!(
                "{operation} did not finish within {} minutes",
                DEVICE_WORKSPACE_OPERATION_WAIT.as_secs() / 60
            );
        }
        tokio::time::sleep(DEVICE_WORKSPACE_POLL_INTERVAL).await;
    }
}

async fn upload_device_bundle(
    rpc: &dyn DeviceDispatchRpc,
    device_id: &str,
    job_id: &str,
    bundle: &super::baseline::PreparedBundle,
) -> anyhow::Result<()> {
    let begin = rpc
        .invoke(
            device_id,
            "dispatch_target_workspace_bundle_begin",
            json!({
                "protocolVersion": DISPATCH_PROTOCOL_VERSION,
                "jobId": job_id,
                "sha256": bundle.sha256,
                "size": bundle.size,
            }),
        )
        .await?;
    if begin
        .get("committed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    if begin.get("accepted").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("Device dispatch target did not accept the bundle upload");
    }
    let mut offset = begin
        .get("offset")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("Device dispatch target returned no bundle upload offset"))?;
    if offset > bundle.size {
        anyhow::bail!("Device dispatch target returned an invalid bundle upload offset");
    }

    let mut file = tokio::fs::File::open(&bundle.path)
        .await
        .with_context(|| format!("open dispatch bundle {}", bundle.path.display()))?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut buffer = vec![0_u8; DEVICE_WORKSPACE_CHUNK_BYTES];
    while offset < bundle.size {
        let remaining = (bundle.size - offset) as usize;
        let read_limit = remaining.min(buffer.len());
        let read = file.read(&mut buffer[..read_limit]).await?;
        if read == 0 {
            anyhow::bail!("Dispatch bundle ended at {offset} of {} bytes", bundle.size);
        }
        let next_offset = offset + read as u64;
        let response = rpc
            .invoke(
                device_id,
                "dispatch_target_workspace_bundle_chunk",
                json!({
                    "jobId": job_id,
                    "offset": offset,
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(&buffer[..read]),
                }),
            )
            .await?;
        if response.get("accepted").and_then(Value::as_bool) != Some(true)
            || response.get("offset").and_then(Value::as_u64) != Some(next_offset)
        {
            anyhow::bail!(
                "Device dispatch target returned a mismatched bundle chunk acknowledgement"
            );
        }
        offset = next_offset;
    }

    let committed = invoke_device_workspace_operation(
        rpc,
        device_id,
        "dispatch_target_workspace_bundle_commit",
        json!({ "jobId": job_id }),
        "Git bundle import",
    )
    .await?;
    if committed.get("committed").and_then(Value::as_bool) != Some(true) {
        anyhow::bail!("Device dispatch target did not commit the delivered bundle");
    }
    Ok(())
}

/// Sync a finished job's work back from an account device.
///
/// The device transport carries JSON only, so the bundle streams back in
/// base64 chunks — the mirror of `upload_device_bundle`. The digest the target
/// reported is verified over the reassembled bytes before anything is fetched
/// into the user's repository.
pub async fn sync_device_result(
    rpc: &dyn DeviceDispatchRpc,
    store: &OutboundDispatchStore,
    request: DispatchSyncResultRequest,
) -> anyhow::Result<Value> {
    let record = load_device_record(store, &request.job_id).await?;
    let DispatchTarget::Device { device_id, .. } = &record.target else {
        unreachable!("load_device_record validates target kind")
    };

    // Reuse this identity across the operation poll loop, but generate a new
    // one for every later user-requested sync. This is what makes a completed
    // no-op distinguishable from a fresh check at the same known head.
    let mut args = json!({
        "jobId": request.job_id,
        "operationId": uuid::Uuid::new_v4().as_simple().to_string(),
    });
    if let Some(message) = request
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args["message"] = Value::String(message.to_string());
    }
    if let Some(head) = record.synced_head_commit.as_deref() {
        args["knownHead"] = Value::String(head.to_string());
    }
    let response = invoke_device_workspace_operation(
        rpc,
        device_id,
        "dispatch_target_workspace_sync",
        args,
        "Git workspace sync",
    )
    .await?;
    if response.get("changed").and_then(Value::as_bool) != Some(true) {
        return finish_sync(store, &record, response, std::path::Path::new("")).await;
    }

    let expected_size = response
        .get("bundleSize")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("Device dispatch target returned no result bundle size"))?;
    let expected_digest = response
        .get("bundleSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Device dispatch target returned no result bundle digest"))?
        .to_string();
    if expected_size == 0 || expected_size > MAX_DEVICE_RESULT_BUNDLE_BYTES {
        anyhow::bail!(
            "Device dispatch result bundle exceeds the {} MB safety limit",
            MAX_DEVICE_RESULT_BUNDLE_BYTES / (1024 * 1024)
        );
    }

    let destination = result_bundle_path(store, &request.job_id).await?;
    let mut staged_bundle = UnverifiedResultBundle::new(destination.clone());
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create result staging {}", parent.display()))?;
        harden_result_directory(parent)?;
    }
    dispatch_ssh::write_private_file(&destination, &[])?;
    let mut output = std::fs::OpenOptions::new()
        .append(true)
        .open(&destination)
        .with_context(|| format!("open result staging {}", destination.display()))?;
    let mut digest = Sha256::new();
    let mut received = 0_u64;
    while received < expected_size {
        let chunk = rpc
            .invoke(
                device_id,
                "dispatch_target_workspace_sync_chunk",
                json!({
                    "jobId": request.job_id,
                    "offset": received,
                    "length": DEVICE_WORKSPACE_CHUNK_BYTES as u64,
                }),
            )
            .await?;
        let encoded = chunk
            .get("dataBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Device dispatch target returned no result chunk data"))?;
        if encoded.len() > 384 * 1024 {
            anyhow::bail!("Device dispatch target returned an oversized result chunk");
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("decode dispatch result chunk")?;
        if decoded.is_empty() || decoded.len() > DEVICE_WORKSPACE_CHUNK_BYTES {
            anyhow::bail!(
                "Device dispatch result bundle ended at {} of {expected_size} bytes",
                received
            );
        }
        let next_offset = received.saturating_add(decoded.len() as u64);
        if next_offset > expected_size {
            anyhow::bail!("Device dispatch target returned more result bytes than it declared");
        }
        if chunk.get("offset").and_then(Value::as_u64) != Some(next_offset) {
            anyhow::bail!("Device dispatch target returned a mismatched result chunk offset");
        }
        std::io::Write::write_all(&mut output, &decoded)
            .with_context(|| format!("write result staging {}", destination.display()))?;
        digest.update(&decoded);
        received = next_offset;
        let eof = chunk.get("eof").and_then(Value::as_bool) == Some(true);
        if eof != (received == expected_size) {
            anyhow::bail!("Device dispatch target returned an inconsistent result end marker");
        }
    }
    output
        .sync_all()
        .with_context(|| format!("flush result staging {}", destination.display()))?;
    let actual_digest = format!("{:x}", digest.finalize());
    if !actual_digest.eq_ignore_ascii_case(&expected_digest) {
        anyhow::bail!("Device dispatch result bundle does not match the reported digest");
    }
    staged_bundle.retain();

    let mut response = response;
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "localBundlePath".to_string(),
            Value::String(destination.to_string_lossy().to_string()),
        );
    }
    finish_sync(store, &record, response, &destination).await
}

async fn load_device_record(
    store: &OutboundDispatchStore,
    job_id: &str,
) -> anyhow::Result<OutboundDispatchRecord> {
    let record = store
        .get(job_id)
        .await?
        .ok_or_else(|| anyhow!("Outbound dispatch job was not found"))?;
    if !matches!(record.target, DispatchTarget::Device { .. }) {
        anyhow::bail!("Outbound dispatch job is not bound to a device target");
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_services_core::dispatch_workspace::sha256_bytes;
    use std::sync::Mutex;

    #[test]
    fn target_command_names_are_separate_from_outbound_commands() {
        for command in [
            "dispatch_target_probe",
            "dispatch_target_submit",
            "dispatch_target_status",
            "dispatch_target_cancel",
            "dispatch_target_list",
            "dispatch_target_answer",
            "dispatch_target_append",
            "dispatch_target_workspace_provision",
            "dispatch_target_workspace_bundle_begin",
            "dispatch_target_workspace_bundle_chunk",
            "dispatch_target_workspace_bundle_commit",
            "dispatch_target_workspace_sync",
            "dispatch_target_workspace_sync_chunk",
        ] {
            assert!(command.starts_with("dispatch_target_"));
            assert_ne!(command, "dispatch_submit");
        }
    }

    /// Serves a fixed bundle back in chunks, like a real device would.
    struct BundleRpc {
        bundle: Vec<u8>,
        declared_digest: String,
        calls: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DeviceDispatchRpc for BundleRpc {
        async fn invoke(
            &self,
            _device_id: &str,
            command: &str,
            args: Value,
        ) -> anyhow::Result<Value> {
            self.calls.lock().unwrap().push(command.to_string());
            match command {
                "dispatch_target_workspace_sync" => {
                    assert!(args
                        .get("operationId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.is_empty()));
                    Ok(json!({
                        "changed": true,
                        "branch": "openbitfun/dispatch/job-1",
                        "baseCommit": "0".repeat(40),
                        "headCommit": "1".repeat(40),
                        "commitCount": 1,
                        "changes": [{ "status": "A", "path": "new.txt" }],
                        "truncatedChanges": false,
                        "bundlePath": "/home/u/.openbitfun/dispatch/workspaces/job-1/result.bundle",
                        "bundleSha256": self.declared_digest,
                        "bundleSize": self.bundle.len() as u64,
                    }))
                }
                "dispatch_target_workspace_sync_chunk" => {
                    let offset = args.get("offset").and_then(Value::as_u64).unwrap() as usize;
                    let length = args.get("length").and_then(Value::as_u64).unwrap() as usize;
                    let end = (offset + length).min(self.bundle.len());
                    Ok(json!({
                        "offset": end as u64,
                        "dataBase64": base64::engine::general_purpose::STANDARD
                            .encode(&self.bundle[offset..end]),
                        "eof": end >= self.bundle.len(),
                    }))
                }
                other => anyhow::bail!("unexpected command {other}"),
            }
        }
    }

    async fn device_store(root: &std::path::Path) -> OutboundDispatchStore {
        let store = OutboundDispatchStore::new_in_root_for_tests(root.to_path_buf());
        let record = OutboundDispatchRecord::new(
            "job-1".to_string(),
            DispatchTarget::Device {
                device_id: "device-a".to_string(),
                workspace_path: "/w".to_string(),
                display_name: "Phone".to_string(),
            },
            "session-1".to_string(),
            "/w".to_string(),
            "prompt",
            "succeeded",
        )
        .expect("record");
        store.bind_if_absent(&record).await.expect("bind");
        store
    }

    struct QueryRpc {
        supports_files: bool,
        supports_chunks: bool,
        calls: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl DeviceDispatchRpc for QueryRpc {
        async fn invoke(
            &self,
            device_id: &str,
            command: &str,
            args: Value,
        ) -> anyhow::Result<Value> {
            assert_eq!(device_id, "device-a");
            self.calls.lock().unwrap().push((command.to_owned(), args));
            Ok(if command == "dispatch_target_probe" {
                json!({"capabilities": if self.supports_chunks { vec!["query_file_chunks_v1"] } else if self.supports_files { vec!["query_file_content"] } else { vec!["session_query"] }})
            } else {
                json!({"kind": "readFile", "content": "target content"})
            })
        }
    }

    #[tokio::test]
    async fn file_query_negotiates_with_the_owning_device_and_preserves_old_usage_queries() {
        let temp = tempfile::tempdir().unwrap();
        let store = device_store(temp.path()).await;
        for supports_files in [false, true] {
            let rpc = QueryRpc {
                supports_files,
                supports_chunks: false,
                calls: Mutex::new(Vec::new()),
            };
            let request = DispatchQueryJobRequest {
                job_id: "job-1".into(),
                kind: "readFile".into(),
                file_path: Some("/w/result.txt".into()),
                file_chunk: None,
            };
            let result = query_device_job(&rpc, &store, request).await;
            assert_eq!(result.is_ok(), supports_files);
            let calls = rpc.calls.lock().unwrap();
            assert_eq!(calls[0].0, "dispatch_target_probe");
            assert_eq!(calls.len(), if supports_files { 2 } else { 1 });
            if supports_files {
                assert_eq!(
                    calls[1].1,
                    json!({"jobId": "job-1", "kind": "readFile", "filePath": "/w/result.txt"})
                );
            }
        }
        let rpc = QueryRpc {
            supports_files: false,
            supports_chunks: false,
            calls: Mutex::new(Vec::new()),
        };
        query_device_job(
            &rpc,
            &store,
            DispatchQueryJobRequest {
                job_id: "job-1".into(),
                kind: "usageReport".into(),
                file_path: None,
                file_chunk: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            *rpc.calls.lock().unwrap(),
            vec![(
                "dispatch_target_query".into(),
                json!({"jobId": "job-1", "kind": "usageReport"})
            )]
        );
    }

    #[tokio::test]
    async fn binary_query_negotiates_optional_capability_and_retains_chunk_cursor() {
        let temp = tempfile::tempdir().unwrap();
        let store = device_store(temp.path()).await;
        for supports_chunks in [false, true] {
            let rpc = QueryRpc {
                supports_files: true,
                supports_chunks,
                calls: Mutex::new(vec![]),
            };
            let request = DispatchQueryJobRequest {
                job_id: "job-1".into(),
                kind: "readFileChunk".into(),
                file_path: Some("/w/image.png".into()),
                file_chunk: Some(
                    openbitfun_services_core::dispatch_contract::DispatchFileChunkRequest {
                        offset: 256,
                        limit: 256,
                        expected_revision: Some("revision-1".into()),
                    },
                ),
            };
            assert_eq!(
                query_device_job(&rpc, &store, request).await.is_ok(),
                supports_chunks
            );
            let calls = rpc.calls.lock().unwrap();
            assert_eq!(calls.len(), if supports_chunks { 2 } else { 1 });
            if supports_chunks {
                assert_eq!(
                    calls[1].1["fileChunk"],
                    json!({"offset":256,"limit":256,"expectedRevision":"revision-1"})
                );
                assert_eq!(calls[1].1["filePath"], "/w/image.png");
            }
        }
    }

    #[tokio::test]
    async fn a_device_streams_its_result_bundle_back_and_it_is_verified() {
        let temp = tempfile::tempdir().expect("temp");
        let store = device_store(temp.path()).await;
        // Larger than one chunk, so the loop is genuinely exercised.
        let bundle = vec![7_u8; DEVICE_WORKSPACE_CHUNK_BYTES + 1234];
        let rpc = BundleRpc {
            declared_digest: sha256_bytes(&bundle),
            bundle: bundle.clone(),
            calls: Mutex::new(Vec::new()),
        };

        // No baseline worktree is recorded, so the fetch half must refuse. The
        // download half still has to have run and verified the bytes first —
        // that is what this asserts.
        let error = sync_device_result(
            &rpc,
            &store,
            DispatchSyncResultRequest {
                job_id: "job-1".to_string(),
                message: None,
            },
        )
        .await
        .expect_err("a record without a baseline cannot be synced");
        assert!(error.to_string().contains("baseline worktree"));

        let staged = temp.path().join(".results/job-1.bundle");
        assert_eq!(std::fs::read(&staged).expect("read staged"), bundle);
        let chunk_calls = rpc
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.as_str() == "dispatch_target_workspace_sync_chunk")
            .count();
        assert!(chunk_calls >= 2, "a multi-chunk bundle must loop");
    }

    #[tokio::test]
    async fn a_tampered_device_stream_never_reaches_the_repository() {
        let temp = tempfile::tempdir().expect("temp");
        let store = device_store(temp.path()).await;
        let bundle = vec![3_u8; 4096];
        let rpc = BundleRpc {
            // Declares a digest the streamed bytes do not match.
            declared_digest: sha256_bytes(b"something else entirely"),
            bundle,
            calls: Mutex::new(Vec::new()),
        };

        let error = sync_device_result(
            &rpc,
            &store,
            DispatchSyncResultRequest {
                job_id: "job-1".to_string(),
                message: None,
            },
        )
        .await
        .expect_err("a tampered stream must fail");

        assert!(error
            .to_string()
            .contains("does not match the reported digest"));
        assert!(
            !temp.path().join(".results/job-1.bundle").exists(),
            "nothing may be staged when the digest does not match"
        );
    }
}
