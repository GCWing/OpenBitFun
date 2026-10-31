#[cfg(all(
    feature = "agent-runtime",
    feature = "ssh-remote",
    feature = "remote-connect"
))]
mod account_device_rpc;
#[cfg(feature = "agent-runtime")]
mod baseline;
#[cfg(all(feature = "agent-runtime", feature = "ssh-remote"))]
mod controller;
#[cfg(all(feature = "agent-runtime", feature = "ssh-remote"))]
mod device_controller;
#[cfg(feature = "agent-runtime")]
mod preparation;
mod target;

use std::path::{Path, PathBuf};

use anyhow::Context as _;
use chrono::{DateTime, Utc};
use openbitfun_services_core::json_store::{JsonFileStore, JsonFileStoreError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::fs;

use crate::infrastructure::PathManager;

#[cfg(all(
    feature = "agent-runtime",
    feature = "ssh-remote",
    feature = "remote-connect"
))]
pub use account_device_rpc::{
    decode_device_dispatch_response, encode_device_dispatch_command,
    AccountRuntimeDeviceDispatchRpc,
};
#[cfg(all(feature = "agent-runtime", feature = "ssh-remote"))]
pub use controller::{
    answer as answer_dispatch, append as append_dispatch, cancel as cancel_dispatch,
    continue_job as continue_dispatch_job, install_cli_cancel as cancel_dispatch_cli_install,
    install_cli_poll as poll_dispatch_cli_install, install_cli_start as start_dispatch_cli_install,
    list_jobs as list_dispatch_jobs, list_targets as list_dispatch_targets,
    probe_target as probe_dispatch_target, query_job as query_dispatch_job,
    status as get_dispatch_status, submit as submit_dispatch,
    sync_model_config as sync_dispatch_model_config, sync_result as sync_dispatch_result,
    DispatchAnswerRequest, DispatchAppendRequest, DispatchConnectionRequest,
    DispatchContinueRequest, DispatchInstallPollRequest, DispatchInstallStartRequest,
    DispatchJobRequest, DispatchListJobsRequest, DispatchListTargetsRequest,
    DispatchPermissionReplyKind, DispatchProbeTargetRequest, DispatchQueryJobRequest,
    DispatchStatusRequest, DispatchSubmitRequest, DispatchSyncResultRequest, DispatchTargetOption,
};
#[cfg(all(feature = "agent-runtime", feature = "ssh-remote"))]
pub use device_controller::{
    answer_device as answer_device_dispatch, append_device as append_device_dispatch,
    cancel_device as cancel_device_dispatch, continue_device_job as continue_device_dispatch_job,
    list_device_jobs as list_device_dispatch_jobs, probe_device as probe_device_dispatch_target,
    query_device_job as query_device_dispatch_job, status_device as get_device_dispatch_status,
    submit_device as submit_device_dispatch, sync_device_result as sync_device_dispatch_result,
    DeviceDispatchRpc,
};
pub use openbitfun_services_core::dispatch_contract::{
    DispatchAccountDaemonIdentity, DispatchAccountDaemonProvisionRequest,
    DISPATCH_ACCOUNT_DAEMON_PROVISIONING_SCHEMA_VERSION,
};
pub use target::{DispatchTarget, DispatchTargetRequest, DispatchWorkspaceDelivery};

const PROMPT_PREVIEW_CHARS: usize = 160;
/// Where synced result bundles are staged before they are fetched into the
/// controller's baseline worktree.
pub(super) const OUTBOUND_RESULTS_DIR: &str = ".results";
/// Where base bundles are built before being uploaded to a target.
#[cfg(feature = "agent-runtime")]
const OUTBOUND_BUNDLES_DIR: &str = ".bundles";
/// Where the renderer's observer transcript cache lives.
const OUTBOUND_TRANSCRIPTS_DIR: &str = ".transcripts";
const TERMINAL_OUTBOUND_RETENTION_DAYS: i64 = 30;
/// Ceiling for one cached observer transcript.
///
/// A transcript that outgrows this stops being cached rather than growing
/// without bound; the observer then replays that job from the beginning, which
/// is exactly the behavior that existed before the cache.
const MAX_OUTBOUND_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(feature = "agent-runtime")]
struct DispatchTargetJobEntry {
    job_id: String,
    session_id: String,
    state: String,
    #[serde(default)]
    started_at: Option<String>,
    workspace_path: String,
    title: String,
    #[serde(default)]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    agent_type: Option<String>,
    #[serde(default)]
    approval_policy: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning_preset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundDispatchRecord {
    pub job_id: String,
    pub target: DispatchTarget,
    pub session_id: String,
    /// Controller-side workspace that owns the observer session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workspace_id: Option<String>,
    pub workspace_path: String,
    pub prompt_preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(
        deserialize_with = "openbitfun_core_types::agent_identity::deserialize_optional_agent_id"
    )]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Target-owned reasoning preset carried across controller restarts.
    /// The explicit value `auto` clears a previous override and is therefore
    /// distinct from a missing field in a legacy record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_preset: Option<String>,
    /// Managed worktree on this controller that this job was branched from.
    ///
    /// Recorded so sync-back knows where to fetch the target's branch into, and
    /// so cleanup can release the worktree's retention claim. A record without
    /// it predates Git-worktree delivery and can only be observed, not synced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_worktree_id: Option<String>,
    /// Stable main-project path that owns the baseline's worktree registry.
    /// Unlike `source_workspace_path`, this does not point at a linked
    /// worktree that may disappear before retention cleanup runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// Tip of `branch` the last successful sync fetched.
    ///
    /// Lets the UI tell "never synced" from "synced and unchanged since".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_head_commit: Option<String>,
    pub last_cursor: u64,
    pub last_state: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl OutboundDispatchRecord {
    pub fn new(
        job_id: String,
        target: DispatchTarget,
        session_id: String,
        workspace_path: String,
        prompt: &str,
        state: impl Into<String>,
    ) -> Result<Self, DispatchStoreError> {
        validate_id(&job_id)?;
        let now = Utc::now();
        Ok(Self {
            job_id,
            target,
            session_id,
            source_workspace_path: None,
            source_workspace_id: None,
            workspace_path,
            prompt_preview: prompt.chars().take(PROMPT_PREVIEW_CHARS).collect(),
            title: None,
            agent_type: None,
            approval_policy: None,
            model: None,
            reasoning_preset: None,
            baseline_worktree_id: None,
            baseline_project_workspace_path: None,
            baseline_worktree_path: None,
            base_commit: None,
            branch: None,
            remote_url: None,
            synced_head_commit: None,
            last_cursor: 0,
            last_state: state.into(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn with_submission_metadata(
        mut self,
        title: Option<String>,
        agent_type: String,
        approval_policy: String,
        model: Option<String>,
        reasoning_preset: Option<String>,
    ) -> Self {
        self.title = title.filter(|value| !value.trim().is_empty());
        self.agent_type = Some(agent_type);
        self.approval_policy = Some(approval_policy);
        self.model = model.filter(|value| !value.trim().is_empty());
        self.reasoning_preset = reasoning_preset.filter(|value| !value.trim().is_empty());
        self
    }

    pub fn with_source_workspace(
        mut self,
        source_workspace_path: Option<String>,
        source_workspace_id: Option<String>,
    ) -> Self {
        self.source_workspace_path = source_workspace_path.filter(|value| !value.trim().is_empty());
        self.source_workspace_id = source_workspace_id.filter(|value| !value.trim().is_empty());
        self
    }

    /// Record the Git baseline this job was branched from.
    ///
    /// Written before the target is contacted, so a submit whose response is
    /// lost still leaves a record that names the worktree holding its claim.
    pub fn with_baseline(
        mut self,
        delivery: &DispatchWorkspaceDelivery,
        worktree_path: &str,
    ) -> Self {
        self.baseline_worktree_id = non_empty(&delivery.baseline_worktree_id);
        self.baseline_project_workspace_path = non_empty(&delivery.project_workspace_path);
        self.baseline_worktree_path = non_empty(worktree_path);
        self.base_commit = non_empty(&delivery.base_commit);
        self.branch = non_empty(&delivery.branch);
        self.remote_url = delivery.remote_url.as_deref().and_then(non_empty);
        self
    }
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTranscriptRequest {
    pub job_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchSaveTranscriptRequest {
    pub job_id: String,
    /// Stored verbatim. The controller never interprets the renderer's
    /// projection, so its shape is versioned by the renderer alone.
    ///
    /// `null` erases the cached transcript. That is how deleting a projection
    /// drops its cached content immediately instead of waiting for retention.
    #[serde(default)]
    pub transcript: Option<Value>,
}

#[derive(Debug, Error)]
pub enum DispatchStoreError {
    #[error("Invalid dispatch job id")]
    InvalidJobId,
    #[error("Failed to access outbound dispatch index: {0}")]
    Io(#[from] std::io::Error),
    #[error("Failed to persist outbound dispatch index: {0}")]
    Json(#[from] JsonFileStoreError),
    #[error("Failed to release outbound dispatch baseline claim: {0}")]
    ClaimRelease(String),
}

/// Durable observer-only index for jobs submitted to other OpenBitFun processes.
///
/// This store intentionally lives outside every workspace/session directory.
/// Writing a record here must never acquire runtime ownership or create a local
/// backend session.
#[derive(Debug, Clone)]
pub struct OutboundDispatchStore {
    root: PathBuf,
    json_store: JsonFileStore,
}

impl OutboundDispatchStore {
    pub fn new(path_manager: &PathManager) -> Self {
        Self::from_root(
            path_manager
                .product_home_dir()
                .join("dispatch")
                .join("outbound"),
        )
    }

    fn from_root(root: PathBuf) -> Self {
        Self {
            root,
            json_store: JsonFileStore,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_in_root_for_tests(root: PathBuf) -> Self {
        Self::from_root(root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Atomically bind a job id to its first outbound record.
    ///
    /// Dispatch submission is idempotent across renderer retries and may race
    /// across multiple controller processes. The first binding wins; callers
    /// must compare the returned record with their requested target/session
    /// before asking the target to execute the job.
    pub async fn bind_if_absent(
        &self,
        record: &OutboundDispatchRecord,
    ) -> Result<OutboundDispatchRecord, DispatchStoreError> {
        let path = self.record_path(&record.job_id)?;
        self.ensure_root().await?;
        let _lock = self.json_store.acquire_cross_process_lock(&path).await?;
        if let Some(existing) = self
            .json_store
            .read_optional::<OutboundDispatchRecord>(&path)
            .await?
        {
            return Ok(existing);
        }
        self.json_store.write_atomic_strict(&path, record).await?;
        harden_file_permissions(&path).await?;
        Ok(record.clone())
    }

    pub async fn get(
        &self,
        job_id: &str,
    ) -> Result<Option<OutboundDispatchRecord>, DispatchStoreError> {
        let path = self.record_path(job_id)?;
        Ok(self.json_store.read_optional(&path).await?)
    }

    pub async fn update_progress(
        &self,
        job_id: &str,
        cursor: u64,
        state: impl Into<String>,
    ) -> Result<OutboundDispatchRecord, DispatchStoreError> {
        let path = self.record_path(job_id)?;
        let _lock = self.json_store.acquire_cross_process_lock(&path).await?;
        let mut record = self
            .json_store
            .read_optional::<OutboundDispatchRecord>(&path)
            .await?
            .ok_or_else(|| {
                DispatchStoreError::Io(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("dispatch job {job_id} is not in the outbound index"),
                ))
            })?;
        record.last_cursor = record.last_cursor.max(cursor);
        let next_state = state.into();
        if !is_terminal_state(&record.last_state) || record.last_state == next_state {
            record.last_state = next_state;
        }
        record.updated_at = Utc::now();
        self.json_store.write_atomic_strict(&path, &record).await?;
        harden_file_permissions(&path).await?;
        Ok(record)
    }

    /// Reflect per-turn option overrides in the observer index so a later
    /// reconciliation cannot revert the UI to the pre-override values.
    pub async fn update_submission_options(
        &self,
        job_id: &str,
        model: Option<&str>,
        reasoning_preset: Option<&str>,
        approval_policy: Option<&str>,
    ) -> Result<(), DispatchStoreError> {
        if model.is_none() && reasoning_preset.is_none() && approval_policy.is_none() {
            return Ok(());
        }
        let path = self.record_path(job_id)?;
        let _lock = self.json_store.acquire_cross_process_lock(&path).await?;
        let Some(mut record) = self
            .json_store
            .read_optional::<OutboundDispatchRecord>(&path)
            .await?
        else {
            return Ok(());
        };
        if let Some(model) = model {
            record.model = Some(model.to_string()).filter(|value| !value.trim().is_empty());
        }
        if let Some(reasoning_preset) = reasoning_preset {
            record.reasoning_preset =
                Some(reasoning_preset.to_string()).filter(|value| !value.trim().is_empty());
        }
        if let Some(policy) = approval_policy {
            record.approval_policy = Some(policy.to_string());
        }
        record.updated_at = Utc::now();
        self.json_store.write_atomic_strict(&path, &record).await?;
        harden_file_permissions(&path).await?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<OutboundDispatchRecord>, DispatchStoreError> {
        #[cfg(feature = "agent-runtime")]
        if let Err(error) = self.reconcile_expired_preparations().await {
            log::warn!("Failed to reconcile expired dispatch preparations: {error}");
        }
        let mut entries = match fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut records = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json")
                || !entry.file_type().await?.is_file()
            {
                continue;
            }
            match self
                .json_store
                .read_optional::<OutboundDispatchRecord>(&path)
                .await
            {
                Ok(Some(record))
                    if is_terminal_state(&record.last_state)
                        && Utc::now()
                            .signed_duration_since(record.updated_at)
                            .num_days()
                            >= TERMINAL_OUTBOUND_RETENTION_DAYS =>
                {
                    match self.remove(&record.job_id).await {
                        Ok(_) => {
                            // Result/transcript artifacts are disposable only
                            // after claim release and durable-record deletion
                            // succeed. A failed claim release keeps the whole
                            // cleanup token intact for the next retry.
                            if let Err(error) = self.remove_result_bundle(&record.job_id).await {
                                log::warn!(
                                    "Failed to remove expired dispatch result bundle: job_id={} error={}",
                                    record.job_id,
                                    error
                                );
                            }
                            if let Err(error) = self.remove_transcript(&record.job_id).await {
                                log::warn!(
                                    "Failed to remove expired dispatch observer transcript: job_id={} error={}",
                                    record.job_id,
                                    error
                                );
                            }
                        }
                        Err(error) => {
                            log::warn!(
                                "Failed to remove expired outbound dispatch record: job_id={} error={}",
                                record.job_id,
                                error
                            );
                            records.push(record);
                        }
                    }
                }
                Ok(Some(record)) => records.push(record),
                Ok(None) => {}
                Err(error) => {
                    log::warn!(
                        "Skipping unreadable outbound dispatch record: path={} error={}",
                        path.display(),
                        error
                    );
                }
            }
        }
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.job_id.cmp(&right.job_id))
        });
        Ok(records)
    }

    pub async fn remove(&self, job_id: &str) -> Result<bool, DispatchStoreError> {
        self.remove_with_claim_releaser(job_id, release_baseline_claim)
            .await
    }

    async fn remove_with_claim_releaser<Release, ReleaseFuture>(
        &self,
        job_id: &str,
        release_claim: Release,
    ) -> Result<bool, DispatchStoreError>
    where
        Release: FnOnce(BaselineClaimRelease) -> ReleaseFuture,
        ReleaseFuture: std::future::Future<Output = Result<(), DispatchStoreError>>,
    {
        let path = self.record_path(job_id)?;
        let _lock = self.json_store.acquire_cross_process_lock(&path).await?;
        let Some(record) = self
            .json_store
            .read_optional::<OutboundDispatchRecord>(&path)
            .await?
        else {
            return Ok(false);
        };

        // The durable record is the retry token for claim cleanup. Keep both it
        // and its cross-process lock until cleanup succeeds; deleting first
        // would make a transient registry/path failure strand the claim forever.
        if let Some(release) = BaselineClaimRelease::for_record(&record) {
            release_claim(release).await?;
        }
        match fs::remove_file(&path).await {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// Record the branch tip a successful sync fetched into the baseline.
    pub async fn record_synced_head(&self, job_id: &str, head: &str) -> anyhow::Result<()> {
        let path = self.record_path(job_id)?;
        let _lock = self.json_store.acquire_cross_process_lock(&path).await?;
        let Some(mut record) = self
            .json_store
            .read_optional::<OutboundDispatchRecord>(&path)
            .await?
        else {
            return Ok(());
        };
        record.synced_head_commit = non_empty(head);
        record.updated_at = Utc::now();
        self.json_store.write_atomic(&path, &record).await?;
        harden_file_permissions(&path).await?;
        Ok(())
    }

    /// Owner-only staging directory for outbound Git bundles.
    ///
    /// Bundles hold repository contents, so they get the same private treatment
    /// as everything else the controller writes here.
    #[cfg(feature = "agent-runtime")]
    pub(crate) async fn bundles_dir(&self) -> anyhow::Result<PathBuf> {
        let bundles = self.root.join(OUTBOUND_BUNDLES_DIR);
        fs::create_dir_all(&bundles).await?;
        harden_directory_permissions(&bundles).await?;
        Ok(bundles)
    }

    /// Owner-only staging directory for bundles fetched back from a target.
    #[cfg(feature = "agent-runtime")]
    pub(crate) async fn results_dir(&self) -> anyhow::Result<PathBuf> {
        let results = self.root.join(OUTBOUND_RESULTS_DIR);
        fs::create_dir_all(&results).await?;
        harden_directory_permissions(&results).await?;
        Ok(results)
    }

    /// Drop a synced result bundle and its summary.
    ///
    /// The bundle is only a transfer artifact: once it has been fetched into
    /// the baseline worktree the objects live in the repository, so deleting it
    /// never loses work.
    pub async fn remove_result_bundle(&self, job_id: &str) -> anyhow::Result<()> {
        validate_id(job_id)?;
        let results = self.root.join(OUTBOUND_RESULTS_DIR);
        for path in [
            results.join(format!("{job_id}.bundle")),
            results.join(format!("{job_id}.json")),
        ] {
            match fs::remove_file(&path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// Read the renderer's cached observer transcript for one job.
    ///
    /// This is the "UI cache" half of the outbound store: it exists so a
    /// restarted renderer can resume from its persisted cursor instead of
    /// replaying the target's whole event log. The controller stores it
    /// verbatim and never interprets it — the target CLI remains the only owner
    /// of the durable session, and reading this must not create a local one.
    pub async fn read_transcript(&self, job_id: &str) -> anyhow::Result<Option<Value>> {
        let path = self.transcript_path(job_id)?;
        match self.json_store.read_optional::<Value>(&path).await {
            Ok(value) => Ok(value),
            Err(error) => {
                // A damaged cache is not a failure; the observer simply replays
                // the job from the beginning.
                log::warn!(
                    "Ignoring unreadable dispatch observer transcript: job_id={job_id} error={error}"
                );
                Ok(None)
            }
        }
    }

    /// Persist the renderer's observer transcript for one job.
    ///
    /// Returns `false` when the transcript is too large to cache. The previous
    /// entry is then left in place: it pairs an older cursor with the turns for
    /// exactly that cursor, so it stays internally consistent and still saves
    /// the observer part of the replay.
    pub async fn write_transcript(&self, job_id: &str, transcript: &Value) -> anyhow::Result<bool> {
        let path = self.transcript_path(job_id)?;
        let encoded = serde_json::to_vec(transcript).context("encode observer transcript")?;
        if encoded.len() > MAX_OUTBOUND_TRANSCRIPT_BYTES {
            log::debug!(
                "Skipping dispatch observer transcript above the cache limit: job_id={job_id} bytes={}",
                encoded.len()
            );
            return Ok(false);
        }
        let transcripts = self.root.join(OUTBOUND_TRANSCRIPTS_DIR);
        fs::create_dir_all(&transcripts).await?;
        harden_directory_permissions(&transcripts).await?;
        let _lock = self.json_store.acquire_cross_process_lock(&path).await?;
        self.json_store.write_atomic(&path, transcript).await?;
        harden_file_permissions(&path).await?;
        Ok(true)
    }

    pub async fn remove_transcript(&self, job_id: &str) -> anyhow::Result<()> {
        remove_file_if_present(&self.transcript_path(job_id)?).await
    }

    fn transcript_path(&self, job_id: &str) -> Result<PathBuf, DispatchStoreError> {
        validate_id(job_id)?;
        Ok(self
            .root
            .join(OUTBOUND_TRANSCRIPTS_DIR)
            .join(format!("{job_id}.json")))
    }

    fn record_path(&self, job_id: &str) -> Result<PathBuf, DispatchStoreError> {
        validate_id(job_id)?;
        Ok(self.root.join(format!("{job_id}.json")))
    }

    async fn ensure_root(&self) -> Result<(), DispatchStoreError> {
        fs::create_dir_all(&self.root).await?;
        harden_directory_permissions(&self.root).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BaselineClaimRelease {
    job_id: String,
    project_workspace_path: String,
    worktree_id: String,
    claimed_by: String,
}

impl BaselineClaimRelease {
    fn for_record(record: &OutboundDispatchRecord) -> Option<Self> {
        let project_workspace_path = record
            .baseline_project_workspace_path
            .as_deref()
            .or(record.source_workspace_path.as_deref())
            .map(str::trim)
            .filter(|path| !path.is_empty())?;
        let worktree_id = record
            .baseline_worktree_id
            .as_deref()
            .map(str::trim)
            .filter(|worktree_id| !worktree_id.is_empty())?;
        Some(Self {
            job_id: record.job_id.clone(),
            project_workspace_path: project_workspace_path.to_string(),
            worktree_id: worktree_id.to_string(),
            claimed_by: baseline_claim(&record.job_id),
        })
    }
}

/// Release the worktree retention claim an outbound record was holding.
///
/// The caller intentionally keeps the durable outbound record until this
/// succeeds, so a moved repository or temporary registry error remains
/// observable and retryable instead of silently stranding a claim.
#[cfg(feature = "agent-runtime")]
async fn release_baseline_claim(release: BaselineClaimRelease) -> Result<(), DispatchStoreError> {
    crate::service::worktree::WorktreeService::release_claim_for_worktree(
        &release.project_workspace_path,
        &release.worktree_id,
        &release.claimed_by,
    )
    .await
    .map(|_| ())
    .map_err(|error| {
        DispatchStoreError::ClaimRelease(format!("job_id={} error={error}", release.job_id))
    })
}

#[cfg(not(feature = "agent-runtime"))]
async fn release_baseline_claim(release: BaselineClaimRelease) -> Result<(), DispatchStoreError> {
    Err(DispatchStoreError::ClaimRelease(format!(
        "job_id={} error=agent-runtime is required to release the baseline worktree claim",
        release.job_id
    )))
}

/// Claim string a dispatch job holds on its baseline worktree.
pub fn baseline_claim(job_id: &str) -> String {
    format!("dispatch:{job_id}")
}

async fn remove_file_if_present(path: &Path) -> anyhow::Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(feature = "agent-runtime")]
async fn adopt_target_jobs(
    store: &OutboundDispatchStore,
    target: &DispatchTarget,
    response: &serde_json::Value,
) -> anyhow::Result<()> {
    let entries: Vec<DispatchTargetJobEntry> =
        serde_json::from_value(response.clone()).context("decode target dispatch job list")?;
    for entry in entries {
        if !matches!(
            entry.state.as_str(),
            "queued" | "running" | "succeeded" | "failed" | "cancelled"
        ) {
            anyhow::bail!("dispatch target returned an invalid job state");
        }
        openbitfun_agent_runtime::session_control::validate_session_id(&entry.session_id)
            .map_err(anyhow::Error::msg)?;
        let workspace_path = entry.workspace_path.trim();
        if !target_workspace_path_is_absolute(workspace_path) {
            anyhow::bail!("dispatch target returned an invalid workspace path");
        }
        let resolved_target = match target {
            DispatchTarget::Ssh {
                connection_id,
                display_name,
                ..
            } => DispatchTarget::Ssh {
                connection_id: connection_id.clone(),
                workspace_path: workspace_path.to_string(),
                display_name: display_name.clone(),
            },
            DispatchTarget::Device {
                device_id,
                display_name,
                ..
            } => DispatchTarget::Device {
                device_id: device_id.clone(),
                workspace_path: workspace_path.to_string(),
                display_name: display_name.clone(),
            },
            DispatchTarget::Local => {
                anyhow::bail!("local jobs cannot be adopted as outbound dispatch observers")
            }
        };
        let title = entry
            .title
            .chars()
            .take(PROMPT_PREVIEW_CHARS)
            .collect::<String>();
        if entry
            .approval_policy
            .as_deref()
            .is_some_and(|policy| !matches!(policy, "auto" | "reject-and-report" | "remote"))
        {
            anyhow::bail!("dispatch target returned an invalid approval policy");
        }
        let mut requested = OutboundDispatchRecord::new(
            entry.job_id,
            resolved_target,
            entry.session_id,
            workspace_path.to_string(),
            &title,
            entry.state.clone(),
        )?;
        requested.title = (!title.trim().is_empty()).then_some(title);
        requested.agent_type = entry.agent_type.filter(|value| !value.trim().is_empty());
        requested.approval_policy = entry.approval_policy;
        requested.model = entry.model.filter(|value| !value.trim().is_empty());
        requested.reasoning_preset = entry
            .reasoning_preset
            .filter(|value| !value.trim().is_empty());
        if let Some(started_at) = entry
            .started_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
        {
            requested.created_at = started_at;
            requested.updated_at = started_at;
        }
        let bound = store.bind_if_absent(&requested).await?;
        if bound.session_id != requested.session_id
            || !same_target_identity_for_store(&bound.target, &requested.target)
        {
            anyhow::bail!(
                "dispatch jobId is already bound to another target or session on this controller"
            );
        }
        store
            .update_submission_options(
                &requested.job_id,
                requested.model.as_deref(),
                requested.reasoning_preset.as_deref(),
                requested.approval_policy.as_deref(),
            )
            .await?;
        store
            .update_progress(&requested.job_id, 0, entry.state)
            .await?;
    }
    Ok(())
}

/// Validate a path returned by the target without applying the controller
/// process's host path semantics. The target may run POSIX while the controller
/// runs Windows, or vice versa.
#[cfg(feature = "agent-runtime")]
fn target_workspace_path_is_absolute(path: &str) -> bool {
    let path = path.trim();
    if path.starts_with('/') {
        return true;
    }

    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }

    let Some(unc_path) = path.strip_prefix(r"\\") else {
        return false;
    };
    let mut components = unc_path
        .split(['\\', '/'])
        .filter(|component| !component.is_empty());
    components.next().is_some() && components.next().is_some()
}

#[cfg(feature = "agent-runtime")]
fn same_target_identity_for_store(left: &DispatchTarget, right: &DispatchTarget) -> bool {
    match (left, right) {
        (
            DispatchTarget::Ssh {
                connection_id: left,
                ..
            },
            DispatchTarget::Ssh {
                connection_id: right,
                ..
            },
        ) => left == right,
        (
            DispatchTarget::Device {
                device_id: left, ..
            },
            DispatchTarget::Device {
                device_id: right, ..
            },
        ) => left == right,
        (DispatchTarget::Local, DispatchTarget::Local) => true,
        _ => false,
    }
}

fn validate_id(value: &str) -> Result<(), DispatchStoreError> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(DispatchStoreError::InvalidJobId);
    }
    Ok(())
}

fn is_terminal_state(state: &str) -> bool {
    matches!(state, "succeeded" | "failed" | "cancelled")
}

#[cfg(unix)]
async fn harden_directory_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await
}

#[cfg(not(unix))]
async fn harden_directory_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
async fn harden_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(not(unix))]
async fn harden_file_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> DispatchTarget {
        DispatchTarget::Ssh {
            connection_id: "server-a".to_string(),
            workspace_path: "/srv/app".to_string(),
            display_name: "Build server".to_string(),
        }
    }

    #[tokio::test]
    async fn outbound_index_is_separate_and_cursor_is_monotonic() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::from_root(temp.path().join("dispatch/outbound"));
        let record = OutboundDispatchRecord::new(
            "job-1".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Summarize the repository",
            "queued",
        )
        .expect("record")
        .with_source_workspace(
            Some("/Users/test/projects/OpenBitFun".to_string()),
            Some("workspace-1".to_string()),
        );

        store.bind_if_absent(&record).await.expect("persist");
        let persisted = store
            .get("job-1")
            .await
            .expect("load persisted record")
            .expect("persisted record");
        assert_eq!(
            persisted.source_workspace_path.as_deref(),
            Some("/Users/test/projects/OpenBitFun")
        );
        assert_eq!(
            persisted.source_workspace_id.as_deref(),
            Some("workspace-1")
        );
        let first = store
            .update_progress("job-1", 42, "running")
            .await
            .expect("first progress");
        let stale = store
            .update_progress("job-1", 12, "running")
            .await
            .expect("stale progress");
        let terminal = store
            .update_progress("job-1", 50, "succeeded")
            .await
            .expect("terminal progress");
        let regressed = store
            .update_progress("job-1", 55, "running")
            .await
            .expect("stale state after terminal");

        assert_eq!(first.last_cursor, 42);
        assert_eq!(stale.last_cursor, 42);
        assert_eq!(terminal.last_state, "succeeded");
        assert_eq!(regressed.last_state, "succeeded");
        assert_eq!(regressed.last_cursor, 55);
        assert_eq!(store.list().await.expect("list").len(), 1);
        assert!(store.root().ends_with("dispatch/outbound"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(store.root())
                    .expect("outbound directory")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(store.root().join("job-1.json"))
                    .expect("outbound record")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn outbound_index_persists_initial_and_follow_up_reasoning_presets() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::from_root(temp.path().join("dispatch/outbound"));
        let record = OutboundDispatchRecord::new(
            "job-reasoning".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Use explicit reasoning",
            "queued",
        )
        .expect("record")
        .with_submission_metadata(
            Some("Reasoning job".to_string()),
            "Standard".to_string(),
            "remote".to_string(),
            Some("target-model".to_string()),
            Some("high".to_string()),
        );

        store.bind_if_absent(&record).await.expect("persist");
        assert_eq!(
            store
                .get("job-reasoning")
                .await
                .expect("read")
                .expect("record")
                .reasoning_preset
                .as_deref(),
            Some("high")
        );

        store
            .update_submission_options("job-reasoning", None, Some("auto"), None)
            .await
            .expect("persist explicit auto");
        assert_eq!(
            store
                .get("job-reasoning")
                .await
                .expect("read")
                .expect("record")
                .reasoning_preset
                .as_deref(),
            Some("auto")
        );
    }

    #[test]
    fn legacy_outbound_record_without_reasoning_preset_remains_readable() {
        let record = OutboundDispatchRecord::new(
            "job-legacy".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Legacy dispatch",
            "running",
        )
        .expect("record");
        let value = serde_json::to_value(record).expect("serialize legacy-shaped record");
        assert!(value.get("reasoningPreset").is_none());

        let restored: OutboundDispatchRecord =
            serde_json::from_value(value).expect("deserialize legacy-shaped record");
        assert_eq!(restored.reasoning_preset, None);
    }

    #[tokio::test]
    async fn removing_an_outbound_record_releases_its_baseline_claim_once() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let mut record = OutboundDispatchRecord::new(
            "job-1".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Summarize the repository",
            "succeeded",
        )
        .expect("record")
        .with_source_workspace(Some("/linked/repo".to_string()), None);
        record.baseline_worktree_id = Some("wt-baseline".to_string());
        record.baseline_project_workspace_path = Some("/stable/repo".to_string());
        store.bind_if_absent(&record).await.expect("persist");

        let releases = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = std::sync::Arc::clone(&releases);
        let callback_store = store.clone();
        assert!(store
            .remove_with_claim_releaser("job-1", move |release| {
                assert!(
                    callback_store.root().join("job-1.json").is_file(),
                    "the durable record must remain until claim release succeeds"
                );
                let captured = std::sync::Arc::clone(&captured);
                async move {
                    captured.lock().expect("release capture").push(release);
                    Ok(())
                }
            })
            .await
            .expect("remove record"));
        assert_eq!(
            releases.lock().expect("releases").as_slice(),
            &[BaselineClaimRelease {
                job_id: "job-1".to_string(),
                project_workspace_path: "/stable/repo".to_string(),
                worktree_id: "wt-baseline".to_string(),
                claimed_by: "dispatch:job-1".to_string(),
            }]
        );
        assert!(
            store
                .get("job-1")
                .await
                .expect("read removed record")
                .is_none(),
            "the record is deleted only after claim release succeeds"
        );

        let called_again = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called = std::sync::Arc::clone(&called_again);
        assert!(!store
            .remove_with_claim_releaser("job-1", move |_| {
                let called = std::sync::Arc::clone(&called);
                async move {
                    called.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }
            })
            .await
            .expect("idempotent remove"));
        assert!(
            !called_again.load(std::sync::atomic::Ordering::SeqCst),
            "an absent record has no claim to release"
        );
    }

    #[tokio::test]
    async fn failed_claim_release_keeps_the_outbound_record_retryable() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let mut record = OutboundDispatchRecord::new(
            "job-claim-retry".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Summarize the repository",
            "succeeded",
        )
        .expect("record")
        .with_source_workspace(Some("/linked/repo".to_string()), None);
        record.baseline_worktree_id = Some("wt-baseline".to_string());
        record.baseline_project_workspace_path = Some("/stable/repo".to_string());
        store.bind_if_absent(&record).await.expect("persist");

        let error = store
            .remove_with_claim_releaser("job-claim-retry", |_| async {
                Err(DispatchStoreError::ClaimRelease(
                    "temporary registry failure".to_string(),
                ))
            })
            .await
            .expect_err("claim failure must stop record deletion");
        assert!(matches!(error, DispatchStoreError::ClaimRelease(_)));
        assert!(
            store
                .get("job-claim-retry")
                .await
                .expect("read retained record")
                .is_some(),
            "the durable record is the retry token for claim cleanup"
        );

        assert!(store
            .remove_with_claim_releaser("job-claim-retry", |_| async { Ok(()) })
            .await
            .expect("retry removal"));
        assert!(store
            .get("job-claim-retry")
            .await
            .expect("read removed record")
            .is_none());
    }

    #[cfg(not(feature = "agent-runtime"))]
    #[tokio::test]
    async fn removing_a_claimed_record_without_product_full_fails_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let mut record = OutboundDispatchRecord::new(
            "job-no-agent-runtime".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Summarize the repository",
            "succeeded",
        )
        .expect("record")
        .with_source_workspace(Some("/linked/repo".to_string()), None);
        record.baseline_worktree_id = Some("wt-baseline".to_string());
        record.baseline_project_workspace_path = Some("/stable/repo".to_string());
        store.bind_if_absent(&record).await.expect("persist");

        let error = store
            .remove("job-no-agent-runtime")
            .await
            .expect_err("claim cleanup without the product owner must fail closed");
        let DispatchStoreError::ClaimRelease(message) = error else {
            panic!("unexpected dispatch cleanup error: {error}");
        };
        assert!(message.contains("agent-runtime"));
        assert!(
            store
                .get("job-no-agent-runtime")
                .await
                .expect("read retained record")
                .is_some(),
            "the durable record must remain available for an agent-runtime retry"
        );
    }

    #[tokio::test]
    async fn expired_jobs_do_not_strand_their_result_bundles() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let results = temp.path().join(OUTBOUND_RESULTS_DIR);
        fs::create_dir_all(&results).await.expect("results dir");
        let bundle = results.join("job-1.bundle");
        let summary = results.join("job-1.json");
        fs::write(&bundle, b"bundle").await.expect("bundle");
        fs::write(&summary, b"{}").await.expect("summary");
        // A second job's bundle must survive the first job's cleanup.
        let other = results.join("job-2.bundle");
        fs::write(&other, b"other").await.expect("other");

        store.remove_result_bundle("job-1").await.expect("remove");
        assert!(!bundle.exists(), "expired bundle must be removed");
        assert!(!summary.exists(), "expired summary must be removed");
        assert!(other.exists(), "an unrelated job must be untouched");

        // Removing twice is how GC behaves after a partial failure.
        store
            .remove_result_bundle("job-1")
            .await
            .expect("removing an absent bundle is not an error");

        assert!(
            store.remove_result_bundle("../escape").await.is_err(),
            "job ids must stay validated on this path too"
        );
    }

    #[tokio::test]
    async fn observer_transcript_round_trips_and_deletion_is_idempotent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let transcript = serde_json::json!({
            "schemaVersion": 1,
            "jobId": "job-1",
            "cursor": 4096,
            "dialogTurns": [{ "id": "turn-1" }],
        });

        assert!(
            store
                .write_transcript("job-1", &transcript)
                .await
                .expect("write transcript"),
            "a small transcript must be cached"
        );
        assert_eq!(
            store
                .read_transcript("job-1")
                .await
                .expect("read transcript"),
            Some(transcript),
            "the controller stores the renderer projection verbatim"
        );
        assert_eq!(
            store
                .read_transcript("job-2")
                .await
                .expect("read absent transcript"),
            None,
            "an uncached job replays from the beginning"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = temp
                .path()
                .join(OUTBOUND_TRANSCRIPTS_DIR)
                .join("job-1.json");
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("transcript file")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        store.remove_transcript("job-1").await.expect("remove");
        assert_eq!(
            store
                .read_transcript("job-1")
                .await
                .expect("read removed transcript"),
            None
        );
        store
            .remove_transcript("job-1")
            .await
            .expect("removing an absent transcript is not an error");
        assert!(
            store.remove_transcript("../escape").await.is_err(),
            "job ids must stay validated on this path too"
        );
    }

    #[tokio::test]
    async fn oversized_observer_transcript_keeps_the_previous_cache() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let cached = serde_json::json!({ "schemaVersion": 1, "cursor": 128 });
        store
            .write_transcript("job-1", &cached)
            .await
            .expect("cache the first transcript");

        let oversized = serde_json::json!({
            "schemaVersion": 1,
            "cursor": 4096,
            "dialogTurns": "x".repeat(MAX_OUTBOUND_TRANSCRIPT_BYTES + 1),
        });
        assert!(
            !store
                .write_transcript("job-1", &oversized)
                .await
                .expect("an oversized transcript is not an error"),
            "a transcript above the ceiling must not be cached"
        );
        assert_eq!(
            store
                .read_transcript("job-1")
                .await
                .expect("read transcript"),
            Some(cached),
            "the older entry stays because its cursor and turns still agree"
        );
    }

    #[tokio::test]
    async fn unreadable_observer_transcript_falls_back_to_full_replay() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let transcripts = temp.path().join(OUTBOUND_TRANSCRIPTS_DIR);
        fs::create_dir_all(&transcripts)
            .await
            .expect("transcripts dir");
        fs::write(transcripts.join("job-1.json"), b"{\"dialogTurns\": [")
            .await
            .expect("truncated transcript");

        assert_eq!(
            store
                .read_transcript("job-1")
                .await
                .expect("a damaged cache must not fail the observer"),
            None
        );
    }

    #[tokio::test]
    async fn expired_jobs_do_not_strand_their_observer_transcripts() {
        let temp = tempfile::tempdir().expect("temp dir");
        let store = OutboundDispatchStore::new_in_root_for_tests(temp.path().to_path_buf());
        let mut expired = OutboundDispatchRecord::new(
            "job-1".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "Summarize the repository",
            "succeeded",
        )
        .expect("record");
        expired.updated_at = Utc::now() - chrono::Duration::days(TERMINAL_OUTBOUND_RETENTION_DAYS);
        store.bind_if_absent(&expired).await.expect("persist");
        let live = OutboundDispatchRecord::new(
            "job-2".to_string(),
            target(),
            "session-2".to_string(),
            "/srv/app".to_string(),
            "Still running",
            "running",
        )
        .expect("record");
        store.bind_if_absent(&live).await.expect("persist");
        for job_id in ["job-1", "job-2"] {
            store
                .write_transcript(job_id, &serde_json::json!({ "schemaVersion": 1 }))
                .await
                .expect("cache transcript");
        }

        let records = store.list().await.expect("list");

        assert_eq!(
            records
                .iter()
                .map(|record| &record.job_id)
                .collect::<Vec<_>>(),
            vec!["job-2"],
            "retention must drop the expired record"
        );
        assert_eq!(
            store
                .read_transcript("job-1")
                .await
                .expect("read expired transcript"),
            None,
            "the expired job's transcript must go with its record"
        );
        assert!(
            store
                .read_transcript("job-2")
                .await
                .expect("read live transcript")
                .is_some(),
            "a live job must keep its cached transcript"
        );
    }

    #[tokio::test]
    async fn rejects_path_traversal_job_ids() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::from_root(temp.path().to_path_buf());
        let error = store.get("../sessions").await.expect_err("must reject");
        assert!(matches!(error, DispatchStoreError::InvalidJobId));
    }

    #[tokio::test]
    async fn concurrent_job_binding_has_one_immutable_winner() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::from_root(temp.path().to_path_buf());
        let first = OutboundDispatchRecord::new(
            "job-1".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            "first",
            "submitting",
        )
        .expect("first record");
        let mut conflicting = first.clone();
        conflicting.session_id = "session-2".to_string();

        let (left, right) = tokio::join!(
            store.bind_if_absent(&first),
            store.bind_if_absent(&conflicting)
        );
        let left = left.expect("left bind");
        let right = right.expect("right bind");
        let persisted = store
            .get("job-1")
            .await
            .expect("read")
            .expect("persisted winner");
        assert_eq!(left, persisted);
        assert_eq!(right, persisted);
        assert!(
            persisted == first || persisted == conflicting,
            "the persisted record must be one complete contender"
        );
    }

    #[test]
    fn prompt_preview_is_unicode_safe_and_bounded() {
        let prompt = "界".repeat(PROMPT_PREVIEW_CHARS + 10);
        let record = OutboundDispatchRecord::new(
            "job-1".to_string(),
            target(),
            "session-1".to_string(),
            "/srv/app".to_string(),
            &prompt,
            "queued",
        )
        .expect("record");
        assert_eq!(record.prompt_preview.chars().count(), PROMPT_PREVIEW_CHARS);
    }

    #[cfg(feature = "agent-runtime")]
    #[test]
    fn target_workspace_paths_use_target_platform_semantics() {
        assert!(target_workspace_path_is_absolute("/srv/app"));
        assert!(target_workspace_path_is_absolute(r"C:\work\app"));
        assert!(target_workspace_path_is_absolute("D:/work/app"));
        assert!(target_workspace_path_is_absolute(r"\\server\share\app"));

        assert!(!target_workspace_path_is_absolute(""));
        assert!(!target_workspace_path_is_absolute("relative/app"));
        assert!(!target_workspace_path_is_absolute(r"C:relative\app"));
        assert!(!target_workspace_path_is_absolute(r"\root-relative"));
        assert!(!target_workspace_path_is_absolute(r"\\server"));
    }

    #[cfg(feature = "agent-runtime")]
    #[tokio::test]
    async fn listing_a_target_adopts_observer_records_without_runtime_ownership() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = OutboundDispatchStore::from_root(temp.path().join("outbound"));
        adopt_target_jobs(
            &store,
            &target(),
            &serde_json::json!([{
                "jobId": "job-observed",
                "sessionId": "00000000-0000-4000-8000-000000000001",
                "state": "running",
                "startedAt": "2026-07-28T00:00:00Z",
                "workspacePath": "/srv/canonical-app",
                "title": "Observed task",
                "agentType": "review",
                "approvalPolicy": "remote",
                "model": "target-model",
                "reasoningPreset": "high"
            }]),
        )
        .await
        .expect("adopt target jobs");

        let record = store
            .get("job-observed")
            .await
            .expect("read observer")
            .expect("observer record");
        assert_eq!(record.last_state, "running");
        assert_eq!(record.title.as_deref(), Some("Observed task"));
        assert_eq!(record.agent_type.as_deref(), Some("review"));
        assert_eq!(record.approval_policy.as_deref(), Some("remote"));
        assert_eq!(record.model.as_deref(), Some("target-model"));
        assert_eq!(record.reasoning_preset.as_deref(), Some("high"));
        assert!(matches!(
            record.target,
            DispatchTarget::Ssh { workspace_path, .. }
                if workspace_path == "/srv/canonical-app"
        ));

        adopt_target_jobs(
            &store,
            &target(),
            &serde_json::json!([{
                "jobId": "job-observed",
                "sessionId": "00000000-0000-4000-8000-000000000001",
                "state": "running",
                "startedAt": "2026-07-28T00:00:00Z",
                "workspacePath": "/srv/canonical-app",
                "title": "Observed task",
                "agentType": "review",
                "approvalPolicy": "remote",
                "model": "target-model",
                "reasoningPreset": "auto"
            }]),
        )
        .await
        .expect("refresh adopted target job");
        assert_eq!(
            store
                .get("job-observed")
                .await
                .expect("read refreshed observer")
                .expect("refreshed observer record")
                .reasoning_preset
                .as_deref(),
            Some("auto")
        );
    }
}
