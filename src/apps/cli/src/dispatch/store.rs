use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use openbitfun_agent_runtime::sdk::{PermissionReply, PermissionRequest};
use serde::{Deserialize, Serialize};

use super::protocol::{
    DispatchAppendRequest, DispatchApprovalPolicy, DispatchAttachment, DispatchContinueRequest,
    DispatchEvent, DispatchJobListEntry, DispatchJobState, DispatchSubmitRequest, DispatchTurnKind,
    DISPATCH_PROTOCOL_VERSION,
};

const JOB_RECORD_FILE: &str = "job.json";
const STATE_FILE: &str = "state";
const EVENTS_FILE: &str = "events.ndjson";
const EVENTS_METADATA_FILE: &str = "events.meta.json";
const EVENTS_LOCK_FILE: &str = ".events.lock";
const PID_FILE: &str = "job.pid";
const PREPARING_FILE: &str = "preparing";
const SPAWN_LOCK_FILE: &str = ".spawn.lock";
const WORKER_LOCK_FILE: &str = ".worker.lock";
const PENDING_PERMISSIONS_DIR: &str = "permissions/pending";
const PERMISSION_ANSWERS_DIR: &str = "permissions/answers";
const RESOLVED_PERMISSIONS_DIR: &str = "permissions/resolved";
const PENDING_MESSAGES_DIR: &str = "messages/pending";
const CONSUMED_MESSAGES_DIR: &str = "messages/consumed";
/// Follow-up turns queued against a job that has already finished one.
///
/// Distinct from the append mailbox: an appended message steers the turn that
/// is already running, while a follow-up starts the next one.
const PENDING_TURNS_DIR: &str = "turns/pending";
const CONSUMED_TURNS_DIR: &str = "turns/consumed";
const DEFAULT_MAX_EVENTS_BYTES: u64 = 64 * 1024 * 1024;
// Keep a single projected event and a complete status page comfortably below
// the server transport's 256 KiB WebSocket frame ceiling.
const MAX_EVENT_BYTES: usize = 96 * 1024;
const MAX_STATUS_PAGE_BYTES: u64 = 128 * 1024;
const MAX_STATUS_PAGE_EVENTS: usize = 512;
const MAX_PENDING_PERMISSION_BYTES: u64 = 48 * 1024;
const MAX_PENDING_PERMISSIONS_BYTES: u64 = 64 * 1024;
const MAX_PENDING_PERMISSIONS: usize = 64;
const MAX_STATE_MESSAGE_BYTES: usize = 16 * 1024;
const TERMINAL_JOB_RETENTION_DAYS: i64 = 30;
const RETENTION_GC_INTERVAL_SECONDS: u64 = 24 * 60 * 60;
const RETENTION_GC_MARKER: &str = ".retention-gc";
const RETENTION_GC_LOCK: &str = ".retention-gc.lock";
/// Shared bare clones, one per source repository, reused across dispatch jobs.
const DISPATCH_REPOS_DIR: &str = "repos";
/// Per-job Git worktrees checked out from those clones.
const DISPATCH_WORKTREES_DIR: &str = "worktrees";
pub(super) const REPO_CACHE_RECORD_FILE: &str = "repo.json";
const REPO_CACHE_RETENTION_DAYS: i64 = 30;
/// Written by the workspace layer; read here only to find a job's checkout.
const PROVISION_RECORD_FILE: &str = "provision.json";

/// The one field retention needs from a provision record.
///
/// Deliberately not the workspace layer's full record: this only has to survive
/// that struct gaining fields, and reading fewer fields cannot fail on one.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionedWorktreeRecord {
    #[serde(default)]
    workspace_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EventLogHeader {
    cursor_base: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EventLogMetadata {
    #[serde(default)]
    history_truncated: bool,
    #[serde(default)]
    omitted_event_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchJobRecord {
    pub(crate) protocol_version: u32,
    pub(crate) intent_sha256: String,
    pub(crate) request: DispatchSubmitRequest,
    pub(crate) created_at: String,
    pub(crate) title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchStateRecord {
    pub(crate) state: DispatchJobState,
    #[serde(default)]
    pub(crate) started_at: Option<String>,
    #[serde(default)]
    pub(crate) finished_at: Option<String>,
    #[serde(default)]
    pub(crate) turn_id: Option<String>,
    #[serde(default)]
    pub(crate) cancel_requested_at: Option<String>,
    #[serde(default)]
    pub(crate) last_error: Option<String>,
}

impl DispatchStateRecord {
    fn queued() -> Self {
        Self {
            state: DispatchJobState::Queued,
            started_at: None,
            finished_at: None,
            turn_id: None,
            cancel_requested_at: None,
            last_error: None,
        }
    }

    pub(crate) fn cancel_requested(&self) -> bool {
        self.cancel_requested_at.is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CreateJobOutcome {
    Created(DispatchStateRecord),
    Existing(DispatchStateRecord),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EventPage {
    pub(crate) cursor: u64,
    pub(crate) events: Vec<DispatchEvent>,
    pub(crate) cursor_reset: bool,
    pub(crate) history_truncated: bool,
    pub(crate) omitted_event_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredPermissionAnswer {
    pub(crate) request_id: String,
    pub(crate) reply: PermissionReply,
    pub(crate) answered_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredAppendMessage {
    request: DispatchAppendRequest,
    created_at: String,
}

/// One queued follow-up turn.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredFollowUpTurn {
    pub(crate) turn_id: String,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) display_content: Option<String>,
    /// Per-turn overrides. The worker applies them to the job record when it
    /// claims the turn, so they carry forward to later turns and restarts.
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) reasoning_preset: Option<String>,
    #[serde(default)]
    pub(crate) approval_policy: Option<DispatchApprovalPolicy>,
    #[serde(default)]
    pub(crate) kind: DispatchTurnKind,
    #[serde(default)]
    pub(crate) attachments: Vec<DispatchAttachment>,
    pub(crate) created_at: String,
}

impl StoredFollowUpTurn {
    fn from_request(request: &DispatchContinueRequest) -> Self {
        Self {
            turn_id: request.turn_id.clone(),
            prompt: request.prompt.clone(),
            display_content: request.display_content.clone(),
            model: request.model.clone(),
            reasoning_preset: request.reasoning_preset.clone(),
            approval_policy: request.approval_policy,
            kind: request.kind,
            attachments: request.attachments.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// A retried turnId must carry the same submission, options included.
    fn same_submission(&self, other: &Self) -> bool {
        self.prompt == other.prompt
            && self.display_content == other.display_content
            && self.model == other.model
            && self.reasoning_preset == other.reasoning_preset
            && self.approval_policy == other.approval_policy
            && self.kind == other.kind
            && self.attachments == other.attachments
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoCacheRetentionRecord {
    last_used_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DispatchStore {
    root: PathBuf,
    max_events_bytes: u64,
}

impl DispatchStore {
    pub(crate) fn open_default() -> Result<Self> {
        let path_manager = openbitfun_core::infrastructure::PathManager::new()
            .map_err(|error| anyhow!("resolve OpenBitFun storage root: {error}"))?;
        let store = Self::open(path_manager.product_home_dir().join("dispatch"))?;
        if let Err(error) = store.maybe_collect_expired_terminal_jobs() {
            tracing::warn!("Dispatch retention cleanup failed: {error:#}");
        }
        Ok(store)
    }

    pub(crate) fn open(root: PathBuf) -> Result<Self> {
        create_private_dir(&root)?;
        create_private_dir(&root.join("jobs"))?;
        create_private_dir(&root.join("workspaces"))?;
        create_private_dir(&root.join(DISPATCH_REPOS_DIR))?;
        create_private_dir(&root.join(DISPATCH_WORKTREES_DIR))?;
        Ok(Self {
            root,
            max_events_bytes: DEFAULT_MAX_EVENTS_BYTES,
        })
    }

    pub(crate) fn create_job_with_intent(
        &self,
        intent: DispatchSubmitRequest,
        request: DispatchSubmitRequest,
        title: String,
    ) -> Result<CreateJobOutcome> {
        validate_id("jobId", &request.job_id)?;
        let intent_sha256 = submit_intent_fingerprint(&intent)?;
        let job_dir = self.job_dir(&request.job_id)?;
        create_private_dir(&job_dir)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;

        let record_path = job_dir.join(JOB_RECORD_FILE);
        match fs::symlink_metadata(&record_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    bail!(
                        "dispatch job commit marker is not a regular file: {}",
                        request.job_id
                    );
                }
                let existing = read_json::<DispatchJobRecord>(&record_path)?;
                if existing.intent_sha256 != intent_sha256 {
                    bail!(
                        "jobId '{}' already exists with a different dispatch request",
                        request.job_id
                    );
                }
                return Ok(CreateJobOutcome::Existing(
                    self.load_state_unlocked(&job_dir)?,
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "inspect dispatch job commit marker {}",
                        record_path.display()
                    )
                })
            }
        }

        let record = DispatchJobRecord {
            protocol_version: DISPATCH_PROTOCOL_VERSION,
            intent_sha256,
            request,
            created_at: chrono::Utc::now().to_rfc3339(),
            title,
        };
        // job.json is the commit marker. Any fragments left without it came
        // from an interrupted initialization and are safely rebuilt while the
        // job lock is held. Publishing the record last means its presence
        // guarantees state and the initial event stream are already durable.
        let state = DispatchStateRecord::queued();
        atomic_write_json(&job_dir.join(STATE_FILE), &state)?;
        ensure_private_file(&job_dir.join(EVENTS_LOCK_FILE))?;
        atomic_write_event_log(&job_dir.join(EVENTS_FILE), 0, None)?;
        atomic_write_json(
            &job_dir.join(EVENTS_METADATA_FILE),
            &EventLogMetadata::default(),
        )?;
        for event in record.request.setup_audit.iter().cloned() {
            self.append_event_unlocked(&job_dir, &DispatchEvent::setup_audit(event))?;
        }
        self.append_event_unlocked(
            &job_dir,
            &DispatchEvent::approval_policy_selected(record.request.approval_policy),
        )?;
        self.append_event_unlocked(
            &job_dir,
            &DispatchEvent::job_state(DispatchJobState::Queued, None),
        )?;
        atomic_write_json(&record_path, &record)?;
        Ok(CreateJobOutcome::Created(state))
    }

    #[cfg(test)]
    pub(crate) fn create_job(
        &self,
        request: DispatchSubmitRequest,
        title: String,
    ) -> Result<CreateJobOutcome> {
        self.create_job_with_intent(request.clone(), request, title)
    }

    pub(crate) fn load_existing_job_for_intent(
        &self,
        intent: &DispatchSubmitRequest,
    ) -> Result<Option<(DispatchJobRecord, DispatchStateRecord)>> {
        validate_id("jobId", &intent.job_id)?;
        let job_dir = self.job_dir(&intent.job_id)?;
        let metadata = match fs::symlink_metadata(&job_dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect dispatch job {}", job_dir.display()))
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!(
                "dispatch job path is not a private directory: {}",
                intent.job_id
            );
        }
        let _lock = JobLock::shared(&job_dir.join(".lock"))?;
        let record_path = job_dir.join(JOB_RECORD_FILE);
        let record_metadata = match fs::symlink_metadata(&record_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "inspect dispatch job commit marker {}",
                        record_path.display()
                    )
                })
            }
        };
        if record_metadata.file_type().is_symlink() || !record_metadata.is_file() {
            bail!(
                "dispatch job commit marker is not a regular file: {}",
                intent.job_id
            );
        }
        let record = read_json::<DispatchJobRecord>(&record_path)?;
        if record.intent_sha256 != submit_intent_fingerprint(intent)? {
            bail!(
                "jobId '{}' already exists with a different dispatch request",
                intent.job_id
            );
        }
        let state = self.load_state_unlocked(&job_dir)?;
        Ok(Some((record, state)))
    }

    pub(crate) fn load_job(&self, job_id: &str) -> Result<DispatchJobRecord> {
        let job_dir = self.existing_job_dir(job_id)?;
        read_json(&job_dir.join(JOB_RECORD_FILE))
    }

    pub(crate) fn load_state(&self, job_id: &str) -> Result<DispatchStateRecord> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::shared(&job_dir.join(".lock"))?;
        self.load_state_unlocked(&job_dir)
    }

    pub(crate) fn mark_state(
        &self,
        job_id: &str,
        state: DispatchJobState,
        turn_id: Option<&str>,
        message: Option<String>,
    ) -> Result<(DispatchStateRecord, bool)> {
        let message = message.map(|message| truncate_utf8_bytes(&message, MAX_STATE_MESSAGE_BYTES));
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut current = self.load_state_unlocked(&job_dir)?;
        if current.state.is_terminal() {
            self.settle_unsubmitted_follow_ups_unlocked(&job_dir, &current)?;
            return Ok((current, false));
        }
        if current.state == state {
            if current.turn_id.is_none() {
                current.turn_id = turn_id.map(ToOwned::to_owned);
                atomic_write_json(&job_dir.join(STATE_FILE), &current)?;
            }
            return Ok((current, false));
        }

        let now = chrono::Utc::now().to_rfc3339();
        current.state = state;
        if state == DispatchJobState::Running && current.started_at.is_none() {
            current.started_at = Some(now.clone());
        }
        if state.is_terminal() {
            current.finished_at = Some(now);
        }
        if let Some(turn_id) = turn_id {
            current.turn_id = Some(turn_id.to_string());
        }
        if state.is_terminal() {
            current.last_error = if state == DispatchJobState::Failed {
                message.clone()
            } else {
                None
            };
        }
        atomic_write_json(&job_dir.join(STATE_FILE), &current)?;
        self.append_event_unlocked(&job_dir, &DispatchEvent::job_state(state, message))?;
        if state.is_terminal() {
            self.settle_unsubmitted_follow_ups_unlocked(&job_dir, &current)?;
        }
        Ok((current, true))
    }

    /// Persist the runtime-owned next turn without re-claiming or finishing the job.
    pub(crate) fn advance_goal_turn(
        &self,
        job_id: &str,
        previous_turn: &str,
        next_turn: &str,
    ) -> Result<()> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut current = self.load_state_unlocked(&job_dir)?;
        if current.state.is_terminal() || current.turn_id.as_deref() != Some(previous_turn) {
            bail!("cannot advance goal turn: dispatch job owner changed");
        }
        current.turn_id = Some(next_turn.to_string());
        atomic_write_json(&job_dir.join(STATE_FILE), &current)
    }

    pub(crate) fn request_cancel(&self, job_id: &str) -> Result<DispatchStateRecord> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut state = self.load_state_unlocked(&job_dir)?;
        if state.state.is_terminal() || state.cancel_requested() {
            return Ok(state);
        }
        state.cancel_requested_at = Some(chrono::Utc::now().to_rfc3339());
        state.last_error = None;
        atomic_write_json(&job_dir.join(STATE_FILE), &state)?;
        self.append_event_unlocked(&job_dir, &DispatchEvent::cancel_requested())?;
        Ok(state)
    }

    pub(crate) fn record_nonterminal_error(&self, job_id: &str, error: &str) -> Result<()> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut state = self.load_state_unlocked(&job_dir)?;
        if !state.state.is_terminal() {
            state.last_error = Some(truncate_utf8_bytes(error, MAX_STATE_MESSAGE_BYTES));
            atomic_write_json(&job_dir.join(STATE_FILE), &state)?;
        }
        Ok(())
    }

    pub(crate) fn settle_exited_worker(&self, job_id: &str) -> Result<DispatchStateRecord> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut state = self.load_state_unlocked(&job_dir)?;
        if state.state.is_terminal() {
            return Ok(state);
        }

        let (terminal_state, message) = if state.cancel_requested() {
            (
                DispatchJobState::Cancelled,
                "Dispatch worker stopped after a cancellation request",
            )
        } else if state.turn_id.is_some() {
            (
                DispatchJobState::Failed,
                "Dispatch worker exited after reserving a turn; the prompt was not replayed to avoid duplicate side effects",
            )
        } else {
            (
                DispatchJobState::Failed,
                "Dispatch worker exited without writing a terminal state",
            )
        };
        state.state = terminal_state;
        state.finished_at = Some(chrono::Utc::now().to_rfc3339());
        state.last_error = if terminal_state == DispatchJobState::Failed {
            Some(message.to_string())
        } else {
            None
        };
        atomic_write_json(&job_dir.join(STATE_FILE), &state)?;
        self.append_event_unlocked(
            &job_dir,
            &DispatchEvent::job_state(terminal_state, Some(message.to_string())),
        )?;
        Ok(state)
    }

    pub(crate) fn try_claim_worker_spawn(&self, job_id: &str) -> Result<Option<DispatchLease>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let Some(lease) = DispatchLease::try_acquire(&job_dir.join(SPAWN_LOCK_FILE))? else {
            return Ok(None);
        };
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let state = self.load_state_unlocked(&job_dir)?;
        if state.state != DispatchJobState::Queued
            || state.turn_id.is_some()
            || state.cancel_requested()
        {
            return Ok(None);
        }
        if let Some(pid) = self.read_pid(job_id)? {
            if super::runner::process_alive(pid) {
                return Ok(None);
            }
            remove_file_if_present(&job_dir.join(PID_FILE));
        }
        atomic_write(
            &job_dir.join(PREPARING_FILE),
            chrono::Utc::now().to_rfc3339().as_bytes(),
        )?;
        Ok(Some(lease))
    }

    pub(crate) fn try_acquire_worker_lease(&self, job_id: &str) -> Result<Option<DispatchLease>> {
        let job_dir = self.existing_job_dir(job_id)?;
        DispatchLease::try_acquire(&job_dir.join(WORKER_LOCK_FILE))
    }

    pub(crate) fn append_event(&self, job_id: &str, event: &DispatchEvent) -> Result<u64> {
        let job_dir = self.existing_job_dir(job_id)?;
        self.append_event_unlocked(&job_dir, event)
    }

    pub(crate) fn read_events(&self, job_id: &str, cursor: u64) -> Result<EventPage> {
        let job_dir = self.existing_job_dir(job_id)?;
        let lock_path = job_dir.join(EVENTS_LOCK_FILE);
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("open dispatch event lock {}", lock_path.display()))?;
        let _lock = FileLock::shared(&lock_file)?;
        let path = job_dir.join(EVENTS_FILE);
        let mut file = OpenOptions::new()
            .read(true)
            .open(&path)
            .with_context(|| format!("open dispatch events {}", path.display()))?;
        set_private_file_permissions(&path)?;
        let len = file.metadata()?.len();
        let (header, data_start) = read_event_log_header(&mut file, &path)?;
        let mut metadata = load_event_log_metadata(&job_dir.join(EVENTS_METADATA_FILE));
        metadata.history_truncated |= header.cursor_base > 0;
        let data_len = len.saturating_sub(data_start);
        let retained_end = header.cursor_base.saturating_add(data_len);
        let (start, cursor_reset) = if cursor < header.cursor_base || cursor > retained_end {
            (0, true)
        } else {
            (cursor.saturating_sub(header.cursor_base), false)
        };
        file.seek(SeekFrom::Start(data_start.saturating_add(start)))?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_STATUS_PAGE_BYTES)
            .read_to_end(&mut bytes)?;

        let mut events = Vec::new();
        let mut consumed = 0_usize;
        while events.len() < MAX_STATUS_PAGE_EVENTS {
            let Some(relative_newline) = bytes[consumed..].iter().position(|byte| *byte == b'\n')
            else {
                break;
            };
            let line_end = consumed + relative_newline;
            let line = &bytes[consumed..line_end];
            consumed = line_end + 1;
            if line.is_empty() {
                continue;
            }
            let event = serde_json::from_slice(line)
                .with_context(|| format!("decode dispatch event for job {job_id}"))?;
            events.push(event);
        }
        Ok(EventPage {
            cursor: header
                .cursor_base
                .saturating_add(start)
                .saturating_add(consumed as u64),
            events,
            cursor_reset,
            history_truncated: metadata.history_truncated,
            omitted_event_count: metadata.omitted_event_count,
        })
    }

    pub(crate) fn save_pending_permission(
        &self,
        job_id: &str,
        request: &PermissionRequest,
    ) -> Result<()> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let state = self.load_state_unlocked(&job_dir)?;
        if state.state.is_terminal() {
            bail!("dispatch job is already terminal");
        }
        let path = mailbox_path(&job_dir, PENDING_PERMISSIONS_DIR, &request.request_id)?;
        let encoded_bytes = serde_json::to_vec_pretty(request)
            .context("encode dispatch permission request")?
            .len()
            .saturating_add(1) as u64;
        if encoded_bytes > MAX_PENDING_PERMISSION_BYTES {
            bail!("dispatch permission request exceeds the 48 KiB safety limit");
        }
        match fs::symlink_metadata(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let (count, bytes) = mailbox_usage(&job_dir.join(PENDING_PERMISSIONS_DIR))?;
                if count >= MAX_PENDING_PERMISSIONS
                    || bytes.saturating_add(encoded_bytes) > MAX_PENDING_PERMISSIONS_BYTES
                {
                    bail!("dispatch pending permission mailbox exceeds the status safety limit");
                }
            }
            Err(error) => return Err(error.into()),
        }
        write_json_if_absent_or_equal(&path, request)
    }

    pub(crate) fn list_pending_permissions(&self, job_id: &str) -> Result<Vec<PermissionRequest>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let mut requests =
            read_json_directory::<PermissionRequest>(&job_dir.join(PENDING_PERMISSIONS_DIR))?;
        requests.sort_by(|left, right| {
            left.round_id
                .cmp(&right.round_id)
                .then_with(|| left.order.cmp(&right.order))
                .then_with(|| left.request_id.cmp(&right.request_id))
        });
        Ok(requests)
    }

    /// Persist a controller answer. `true` means the answer is durably queued
    /// or was already resolved with the same request id.
    pub(crate) fn save_permission_answer(
        &self,
        job_id: &str,
        request_id: &str,
        reply: PermissionReply,
    ) -> Result<bool> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let resolved_path = mailbox_path(&job_dir, RESOLVED_PERMISSIONS_DIR, request_id)?;
        if let Some(existing) =
            read_optional_regular_json::<StoredPermissionAnswer>(&resolved_path)?
        {
            ensure_permission_answer_matches(&existing, request_id, &reply)?;
            return Ok(true);
        }
        let state = self.load_state_unlocked(&job_dir)?;
        if state.state.is_terminal() {
            bail!("dispatch job is already terminal");
        }
        let pending_path = mailbox_path(&job_dir, PENDING_PERMISSIONS_DIR, request_id)?;
        let pending = read_optional_regular_json::<PermissionRequest>(&pending_path)?
            .ok_or_else(|| anyhow!("dispatch permission request not found: {request_id}"))?;
        if pending.request_id != request_id {
            bail!("dispatch permission mailbox identity mismatch");
        }
        let answer_path = mailbox_path(&job_dir, PERMISSION_ANSWERS_DIR, request_id)?;
        if let Some(existing) = read_optional_regular_json::<StoredPermissionAnswer>(&answer_path)?
        {
            ensure_permission_answer_matches(&existing, request_id, &reply)?;
            return Ok(true);
        }
        let answer = StoredPermissionAnswer {
            request_id: request_id.to_string(),
            reply,
            answered_at: chrono::Utc::now().to_rfc3339(),
        };
        write_json_if_absent_or_equal(&answer_path, &answer)?;
        Ok(true)
    }

    pub(crate) fn list_permission_answers(
        &self,
        job_id: &str,
    ) -> Result<Vec<StoredPermissionAnswer>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let mut answers =
            read_json_directory::<StoredPermissionAnswer>(&job_dir.join(PERMISSION_ANSWERS_DIR))?;
        answers.sort_by(|left, right| {
            left.answered_at
                .cmp(&right.answered_at)
                .then_with(|| left.request_id.cmp(&right.request_id))
        });
        Ok(answers)
    }

    pub(crate) fn mark_permission_resolved(
        &self,
        job_id: &str,
        answer: &StoredPermissionAnswer,
    ) -> Result<()> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let resolved_path = mailbox_path(&job_dir, RESOLVED_PERMISSIONS_DIR, &answer.request_id)?;
        write_json_if_absent_or_equal(&resolved_path, answer)?;
        remove_file_if_present(&mailbox_path(
            &job_dir,
            PENDING_PERMISSIONS_DIR,
            &answer.request_id,
        )?);
        remove_file_if_present(&mailbox_path(
            &job_dir,
            PERMISSION_ANSWERS_DIR,
            &answer.request_id,
        )?);
        Ok(())
    }

    pub(crate) fn clear_pending_permissions(&self, job_id: &str) {
        let Ok(job_dir) = self.job_dir(job_id) else {
            return;
        };
        for directory in [PENDING_PERMISSIONS_DIR, PERMISSION_ANSWERS_DIR] {
            if let Err(error) = fs::remove_dir_all(job_dir.join(directory)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        "Failed to clear dispatch permission mailbox for {}: {error}",
                        job_id
                    );
                }
            }
        }
    }

    /// A retry of an accepted turn keeps its identity even if model readiness
    /// or the target catalog has changed since its first acceptance.
    pub(crate) fn load_existing_follow_up_for_intent(
        &self,
        request: &DispatchContinueRequest,
    ) -> Result<Option<DispatchStateRecord>> {
        validate_id("turnId", &request.turn_id)?;
        let job_dir = self.existing_job_dir(&request.job_id)?;
        let _lock = JobLock::shared(&job_dir.join(".lock"))?;
        self.existing_follow_up_state_unlocked(&job_dir, &StoredFollowUpTurn::from_request(request))
    }

    fn existing_follow_up_state_unlocked(
        &self,
        job_dir: &Path,
        submitted: &StoredFollowUpTurn,
    ) -> Result<Option<DispatchStateRecord>> {
        for directory in [CONSUMED_TURNS_DIR, PENDING_TURNS_DIR] {
            let path = mailbox_path(job_dir, directory, &submitted.turn_id)?;
            if let Some(existing) = read_optional_regular_json::<StoredFollowUpTurn>(&path)? {
                if !existing.same_submission(submitted) {
                    bail!("dispatch turnId is already bound to different content");
                }
                return self.load_state_unlocked(job_dir).map(Some);
            }
        }
        Ok(None)
    }

    /// Keep accepted but unsubmitted prompts as consumed records with an audit
    /// event. They belong to the run that ended, and must never displace a later
    /// follow-up after a bootstrap failure or queued cancellation.
    fn settle_unsubmitted_follow_ups_unlocked(
        &self,
        job_dir: &Path,
        state: &DispatchStateRecord,
    ) -> Result<()> {
        debug_assert!(state.state.is_terminal());
        for turn in read_json_directory::<StoredFollowUpTurn>(&job_dir.join(PENDING_TURNS_DIR))? {
            let consumed_path = mailbox_path(job_dir, CONSUMED_TURNS_DIR, &turn.turn_id)?;
            if let Some(consumed) =
                read_optional_regular_json::<StoredFollowUpTurn>(&consumed_path)?
            {
                if !consumed.same_submission(&turn) {
                    bail!("dispatch pending and consumed turn records conflict");
                }
            } else {
                self.append_event_unlocked(
                    job_dir,
                    &DispatchEvent::Audit {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        action: "followUpNotSubmitted".to_string(),
                        details: serde_json::json!({
                            "turnId": turn.turn_id,
                            "terminalState": state.state,
                            "lastError": state.last_error,
                        }),
                    },
                )?;
                write_json_if_absent_or_equal(&consumed_path, &turn)?;
            }
            let pending_path = mailbox_path(job_dir, PENDING_TURNS_DIR, &turn.turn_id)?;
            fs::remove_file(&pending_path)
                .with_context(|| format!("settle dispatch follow-up {}", pending_path.display()))?;
        }
        Ok(())
    }

    /// Queue the next turn for a job whose previous turn has finished.
    ///
    /// This is what makes a dispatch session a conversation rather than a
    /// one-shot: the target session, its worktree, and its event log all stay
    /// put, and only the job's run state rewinds to `Queued`.
    pub(crate) fn queue_follow_up_turn(
        &self,
        request: &DispatchContinueRequest,
    ) -> Result<DispatchStateRecord> {
        validate_id("turnId", &request.turn_id)?;
        let job_dir = self.existing_job_dir(&request.job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;

        let stored = StoredFollowUpTurn::from_request(request);
        // A retried request must not start a second turn. Both mailboxes are
        // checked because the worker may already have claimed this one.
        if let Some(state) = self.existing_follow_up_state_unlocked(&job_dir, &stored)? {
            return Ok(state);
        }

        let mut state = self.load_state_unlocked(&job_dir)?;
        if !state.state.is_terminal() {
            bail!("this dispatch job is still running; steer it with an appended message instead");
        }
        // Older workers could fail before claiming a queued turn. Preserve and
        // settle that legacy mailbox before accepting another prompt.
        self.settle_unsubmitted_follow_ups_unlocked(&job_dir, &state)?;
        let pending_path = mailbox_path(&job_dir, PENDING_TURNS_DIR, &request.turn_id)?;
        write_json_if_absent_or_equal(&pending_path, &stored)?;

        // Rewind only the run state. `started_at` is left alone so the job keeps
        // reporting when its first turn began.
        state.state = DispatchJobState::Queued;
        state.turn_id = None;
        state.finished_at = None;
        state.last_error = None;
        state.cancel_requested_at = None;
        atomic_write_json(&job_dir.join(STATE_FILE), &state)?;
        self.append_event_unlocked(
            &job_dir,
            &DispatchEvent::job_state(DispatchJobState::Queued, None),
        )?;
        Ok(state)
    }

    /// Read the next queued turn without consuming it.
    ///
    /// The worker peeks before initializing the runtime because the approval
    /// policy is baked into runtime bootstrap; the later claim takes the same
    /// earliest turn (identical ordering), and nothing can enqueue in between
    /// — `queue_follow_up_turn` requires a terminal state and the job is
    /// already Queued/Running by then.
    pub(crate) fn peek_follow_up_turn(&self, job_id: &str) -> Result<Option<StoredFollowUpTurn>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut pending =
            read_json_directory::<StoredFollowUpTurn>(&job_dir.join(PENDING_TURNS_DIR))?;
        pending.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });
        Ok(pending.into_iter().next())
    }

    /// Persist the effective per-turn options onto the job record so `list`,
    /// `status`, and any replacement worker observe the same choices the turn
    /// runs with. Returns (model_changed, approval_policy_changed).
    pub(crate) fn update_job_request_options(
        &self,
        job_id: &str,
        model: Option<&str>,
        reasoning_preset: Option<&str>,
        approval_policy: DispatchApprovalPolicy,
    ) -> Result<(bool, bool, bool)> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut job = self.load_job(job_id)?;
        let model = model.map(str::to_string);
        let model_changed = job.request.model != model;
        let reasoning_preset = reasoning_preset.map(str::to_string);
        let reasoning_changed = job.request.reasoning_preset != reasoning_preset;
        let policy_changed = job.request.approval_policy != approval_policy;
        if !model_changed && !reasoning_changed && !policy_changed {
            return Ok((false, false, false));
        }
        job.request.model = model;
        job.request.reasoning_preset = reasoning_preset;
        job.request.approval_policy = approval_policy;
        atomic_write_json(&job_dir.join(JOB_RECORD_FILE), &job)?;
        Ok((model_changed, reasoning_changed, policy_changed))
    }

    /// Take the next queued turn and bind it to the runtime turn the worker is
    /// about to submit.
    ///
    /// Consuming and recording the turn id happen under one lock so a crash can
    /// never leave a turn that looks unclaimed but was already submitted. A
    /// crash after this point settles the job as failed rather than replaying
    /// the prompt, which is the same promise the first turn makes.
    pub(crate) fn claim_follow_up_turn(
        &self,
        job_id: &str,
        runtime_turn_id: &str,
    ) -> Result<Option<StoredFollowUpTurn>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let mut pending =
            read_json_directory::<StoredFollowUpTurn>(&job_dir.join(PENDING_TURNS_DIR))?;
        pending.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.turn_id.cmp(&right.turn_id))
        });
        let claimed = pending.into_iter().next();

        let mut state = self.load_state_unlocked(&job_dir)?;
        if !state.state.is_terminal() && state.turn_id.as_deref() != Some(runtime_turn_id) {
            state.turn_id = Some(runtime_turn_id.to_string());
            atomic_write_json(&job_dir.join(STATE_FILE), &state)?;
        }

        if let Some(turn) = claimed.as_ref() {
            let consumed_path = mailbox_path(&job_dir, CONSUMED_TURNS_DIR, &turn.turn_id)?;
            write_json_if_absent_or_equal(&consumed_path, turn)?;
            remove_file_if_present(&mailbox_path(&job_dir, PENDING_TURNS_DIR, &turn.turn_id)?);
        }
        Ok(claimed)
    }

    pub(crate) fn enqueue_append_message(&self, request: DispatchAppendRequest) -> Result<bool> {
        validate_id("messageId", &request.message_id)?;
        let job_dir = self.existing_job_dir(&request.job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let consumed_path = mailbox_path(&job_dir, CONSUMED_MESSAGES_DIR, &request.message_id)?;
        if let Some(existing) = read_optional_regular_json::<DispatchAppendRequest>(&consumed_path)?
        {
            if existing != request {
                bail!("dispatch messageId is already bound to different content");
            }
            return Ok(true);
        }
        let state = self.load_state_unlocked(&job_dir)?;
        if state.state.is_terminal() {
            bail!("cannot append to a terminal dispatch job");
        }
        if !matches!(
            state.state,
            DispatchJobState::Queued | DispatchJobState::Running
        ) {
            bail!("dispatch job is not accepting appended messages");
        }
        let stored = StoredAppendMessage {
            request: request.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let path = mailbox_path(&job_dir, PENDING_MESSAGES_DIR, &request.message_id)?;
        if let Some(existing) = read_optional_regular_json::<StoredAppendMessage>(&path)? {
            if existing.request != request {
                bail!("dispatch messageId is already bound to different content");
            }
            return Ok(true);
        }
        write_json_if_absent_or_equal(&path, &stored)?;
        Ok(true)
    }

    pub(crate) fn list_pending_append_messages(
        &self,
        job_id: &str,
    ) -> Result<Vec<DispatchAppendRequest>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let mut messages =
            read_json_directory::<StoredAppendMessage>(&job_dir.join(PENDING_MESSAGES_DIR))?;
        messages.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.request.message_id.cmp(&right.request.message_id))
        });
        Ok(messages.into_iter().map(|stored| stored.request).collect())
    }

    pub(crate) fn mark_append_message_consumed(
        &self,
        job_id: &str,
        request: &DispatchAppendRequest,
    ) -> Result<()> {
        let job_dir = self.existing_job_dir(job_id)?;
        let _lock = JobLock::exclusive(&job_dir.join(".lock"))?;
        let consumed_path = mailbox_path(&job_dir, CONSUMED_MESSAGES_DIR, &request.message_id)?;
        write_json_if_absent_or_equal(&consumed_path, request)?;
        remove_file_if_present(&mailbox_path(
            &job_dir,
            PENDING_MESSAGES_DIR,
            &request.message_id,
        )?);
        Ok(())
    }

    pub(crate) fn list_jobs(&self) -> Result<Vec<DispatchJobListEntry>> {
        let jobs_dir = self.root.join("jobs");
        let mut entries = Vec::new();
        for entry in fs::read_dir(&jobs_dir)
            .with_context(|| format!("read dispatch jobs {}", jobs_dir.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(job_id) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            let Ok(job) = self.load_job(&job_id) else {
                continue;
            };
            let Ok(state) = self.load_state(&job_id) else {
                continue;
            };
            // A newly accepted follow-up is durable in the pending mailbox
            // before its worker rewrites the job record. Project those options
            // immediately so controller recovery cannot briefly restore stale
            // model or reasoning selections during that window.
            let pending_turn = if state.state.is_terminal() {
                None
            } else {
                self.peek_follow_up_turn(&job_id).ok().flatten()
            };
            let model = pending_turn
                .as_ref()
                .and_then(|turn| turn.model.clone())
                .or(job.request.model);
            let reasoning_preset = pending_turn
                .as_ref()
                .and_then(|turn| turn.reasoning_preset.clone())
                .or(job.request.reasoning_preset);
            let approval_policy = pending_turn
                .as_ref()
                .and_then(|turn| turn.approval_policy)
                .unwrap_or(job.request.approval_policy);
            entries.push(DispatchJobListEntry {
                job_id,
                session_id: job.request.session_id,
                state: state.state,
                started_at: state.started_at,
                workspace_path: job.request.workspace_path,
                title: job.title,
                agent_type: job.request.agent_type,
                approval_policy,
                model,
                reasoning_preset,
            });
        }
        entries.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        Ok(entries)
    }

    pub(crate) fn write_pid(&self, job_id: &str, pid: u32) -> Result<()> {
        let job_dir = self.existing_job_dir(job_id)?;
        atomic_write(&job_dir.join(PID_FILE), format!("{pid}\n").as_bytes())
    }

    pub(crate) fn read_pid(&self, job_id: &str) -> Result<Option<u32>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let path = job_dir.join(PID_FILE);
        match fs::read_to_string(&path) {
            Ok(raw) => {
                let pid = raw
                    .trim()
                    .parse::<u32>()
                    .with_context(|| format!("decode worker pid {}", path.display()))?;
                if pid <= 1 || i32::try_from(pid).is_err() {
                    bail!("dispatch worker pid is outside the safe process range: {pid}");
                }
                Ok(Some(pid))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).with_context(|| format!("read worker pid {}", path.display())),
        }
    }

    pub(crate) fn remove_pid(&self, job_id: &str) {
        if let Ok(job_dir) = self.job_dir(job_id) {
            remove_file_if_present(&job_dir.join(PID_FILE));
        }
    }

    pub(crate) fn remove_pid_if_matches(&self, job_id: &str, expected_pid: u32) {
        if matches!(self.read_pid(job_id), Ok(Some(pid)) if pid == expected_pid) {
            self.remove_pid(job_id);
        }
    }

    pub(crate) fn clear_preparing(&self, job_id: &str) {
        if let Ok(job_dir) = self.job_dir(job_id) {
            remove_file_if_present(&job_dir.join(PREPARING_FILE));
        }
    }

    pub(crate) fn preparing_age_seconds(&self, job_id: &str) -> Result<Option<u64>> {
        let job_dir = self.existing_job_dir(job_id)?;
        let path = job_dir.join(PREPARING_FILE);
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("read preparing marker {}", path.display()))
            }
        };
        let modified = metadata.modified()?;
        Ok(Some(modified.elapsed().unwrap_or_default().as_secs()))
    }

    pub(crate) fn workspace_lock_path(&self, workspace_path: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(workspace_path.as_bytes());
        self.root
            .join("workspaces")
            .join(format!("{digest:x}.lock"))
    }

    /// Serializes the small JSON state machine used to start and poll one
    /// detached Git operation. It must never be held while Git itself runs,
    /// otherwise a status RPC blocks behind the worker it is meant to poll.
    pub(crate) fn workspace_operation_lock_path(&self, job_id: &str) -> Result<PathBuf> {
        validate_id("jobId", job_id)?;
        Ok(self
            .root
            .join("workspaces")
            .join(format!(".{job_id}.workspace.lock")))
    }

    /// Serializes long-running Git mutations for one managed dispatch
    /// worktree. Retention uses the same lock before removing its artifacts.
    pub(crate) fn workspace_git_operation_lock_path(&self, job_id: &str) -> Result<PathBuf> {
        validate_id("jobId", job_id)?;
        Ok(self
            .root
            .join("workspaces")
            .join(format!(".{job_id}.git.lock")))
    }

    pub(crate) fn workspace_upload_dir(&self, job_id: &str) -> Result<PathBuf> {
        validate_id("jobId", job_id)?;
        Ok(self.root.join("workspaces").join(job_id))
    }

    pub(crate) fn repos_root(&self) -> PathBuf {
        self.root.join(DISPATCH_REPOS_DIR)
    }

    /// Directory holding one shared clone. `repo_key` is validated by the
    /// workspace layer before it ever reaches here, but re-checking costs
    /// nothing and keeps the path constructor safe on its own.
    pub(crate) fn repo_dir(&self, repo_key: &str) -> Result<PathBuf> {
        if repo_key.len() < 8
            || repo_key.len() > 64
            || !repo_key.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("dispatch repoKey must be an 8-64 character hex digest");
        }
        Ok(self.repos_root().join(repo_key))
    }

    /// Cross-process lock for every Git operation that touches one shared
    /// bare repository. Provision, bundle import, sync, and retention all use
    /// the same lock so two jobs cannot concurrently mutate refs or race a
    /// repository-cache deletion.
    pub(crate) fn repo_lock_path(&self, repo_key: &str) -> Result<PathBuf> {
        // Reuse the path validation performed by `repo_dir` before deriving a
        // sibling lock-file name from the key.
        self.repo_dir(repo_key)?;
        Ok(self.repos_root().join(format!(".{repo_key}.lock")))
    }

    pub(crate) fn worktrees_root(&self) -> PathBuf {
        self.root.join(DISPATCH_WORKTREES_DIR)
    }

    /// Checkout directory for one job, grouped under its repository's clone.
    ///
    /// `directory_name` is built by the workspace layer from a sanitized project
    /// label; re-check it here so this path constructor is safe on its own and
    /// cannot be walked out of the worktree root.
    pub(crate) fn worktree_dir(&self, repo_key: &str, directory_name: &str) -> Result<PathBuf> {
        self.repo_dir(repo_key)?;
        if directory_name.is_empty()
            || directory_name.len() > 128
            || !directory_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || directory_name.starts_with('.')
        {
            bail!("dispatch worktree directory name is not a safe path component");
        }
        Ok(self.worktrees_root().join(repo_key).join(directory_name))
    }

    fn maybe_collect_expired_terminal_jobs(&self) -> Result<()> {
        let marker = self.root.join(RETENTION_GC_MARKER);
        if fs::metadata(&marker)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed.as_secs() < RETENTION_GC_INTERVAL_SECONDS)
        {
            return Ok(());
        }
        let _lock = JobLock::exclusive(&self.root.join(RETENTION_GC_LOCK))?;
        if fs::metadata(&marker)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed.as_secs() < RETENTION_GC_INTERVAL_SECONDS)
        {
            return Ok(());
        }
        self.collect_expired_terminal_jobs(chrono::Utc::now())?;
        atomic_write(&marker, chrono::Utc::now().to_rfc3339().as_bytes())
    }

    fn collect_expired_terminal_jobs(&self, now: chrono::DateTime<chrono::Utc>) -> Result<usize> {
        let jobs_root = self.root.join("jobs");
        let mut removed = 0;
        for entry in fs::read_dir(&jobs_root)
            .with_context(|| format!("read dispatch jobs {}", jobs_root.display()))?
        {
            let entry = entry?;
            let Some(job_id) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            if validate_id("jobId", &job_id).is_err() {
                continue;
            }
            let job_dir = entry.path();
            let metadata = fs::symlink_metadata(&job_dir)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let Some(lock) = JobLock::try_exclusive(&job_dir.join(".lock"))? else {
                continue;
            };
            let state = match self.load_state_unlocked(&job_dir) {
                Ok(state) => state,
                Err(error) => {
                    tracing::warn!(
                        "Skipping unreadable dispatch job during retention cleanup: job_id={} error={error:#}",
                        job_id
                    );
                    continue;
                }
            };
            if !state.state.is_terminal() {
                continue;
            }
            let Some(finished_at) = state
                .finished_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&chrono::Utc))
            else {
                continue;
            };
            if now.signed_duration_since(finished_at).num_days() < TERMINAL_JOB_RETENTION_DAYS {
                continue;
            }
            let Some(operation_lock) =
                JobLock::try_exclusive(&self.workspace_operation_lock_path(&job_id)?)?
            else {
                continue;
            };
            let Some(git_operation_lock) =
                JobLock::try_exclusive(&self.workspace_git_operation_lock_path(&job_id)?)?
            else {
                continue;
            };
            let job_record: DispatchJobRecord = match read_json(&job_dir.join(JOB_RECORD_FILE)) {
                Ok(record) => record,
                Err(error) => {
                    tracing::warn!(
                        "Skipping dispatch job with unreadable workspace binding during retention cleanup: job_id={} error={error:#}",
                        job_id
                    );
                    continue;
                }
            };
            let Some(workspace_runtime_lock) = WorkspaceLock::try_acquire(
                &self.workspace_lock_path(&job_record.request.workspace_path),
            )?
            else {
                continue;
            };
            let tombstone = jobs_root.join(format!(
                ".gc-{}-{}",
                job_id,
                uuid::Uuid::new_v4().as_simple()
            ));

            // Windows cannot rename a directory while a child lock file is
            // open. Terminal states are irreversible, so release that handle
            // immediately before the atomic quarantine rename. A concurrent
            // opener makes the rename fail and the job is retried later.
            #[cfg(windows)]
            drop(lock);
            let rename_result = fs::rename(&job_dir, &tombstone);
            #[cfg(not(windows))]
            drop(lock);
            match rename_result {
                Ok(()) => {}
                Err(error) if retryable_retention_rename_error(&error) => {
                    tracing::debug!(
                        job_id = %job_id,
                        error_kind = ?error.kind(),
                        raw_os_error = ?error.raw_os_error(),
                        "Deferring dispatch retention cleanup for busy job"
                    );
                    continue;
                }
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("quarantine expired dispatch job {}", job_dir.display())
                    });
                }
            }
            fs::remove_dir_all(&tombstone)
                .with_context(|| format!("remove expired dispatch job {}", tombstone.display()))?;

            let workspace_dir = self.root.join("workspaces").join(&job_id);
            match fs::symlink_metadata(&workspace_dir) {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_dir() => {
                    fs::remove_dir_all(&workspace_dir).with_context(|| {
                        format!(
                            "remove expired dispatch workspace {}",
                            workspace_dir.display()
                        )
                    })?;
                }
                Ok(_) => {
                    tracing::warn!(
                        "Skipping unsafe expired dispatch workspace path: {}",
                        workspace_dir.display()
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            drop(workspace_runtime_lock);
            drop(git_operation_lock);
            drop(operation_lock);
            self.remove_workspace_operation_locks(&job_id)?;
            removed += 1;
        }
        let workspaces_root = self.root.join("workspaces");
        for entry in fs::read_dir(&workspaces_root)
            .with_context(|| format!("read dispatch workspaces {}", workspaces_root.display()))?
        {
            let entry = entry?;
            let Some(job_id) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            if validate_id("jobId", &job_id).is_err() || jobs_root.join(&job_id).exists() {
                continue;
            }
            let workspace_dir = entry.path();
            let metadata = fs::symlink_metadata(&workspace_dir)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let old_enough = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|elapsed| {
                    elapsed.as_secs() >= (TERMINAL_JOB_RETENTION_DAYS as u64) * 24 * 60 * 60
                });
            if !old_enough {
                continue;
            }
            let Some(operation_lock) =
                JobLock::try_exclusive(&self.workspace_operation_lock_path(&job_id)?)?
            else {
                continue;
            };
            let Some(git_operation_lock) =
                JobLock::try_exclusive(&self.workspace_git_operation_lock_path(&job_id)?)?
            else {
                continue;
            };
            // The checkout is named after the project, not the job, so the
            // provision record is the only link back to it. Remove it before
            // the record that points at it, or it becomes unreachable.
            if !self.remove_recorded_worktree(&workspace_dir)? {
                continue;
            }
            let tombstone = workspaces_root.join(format!(
                ".gc-{}-{}",
                job_id,
                uuid::Uuid::new_v4().as_simple()
            ));
            fs::rename(&workspace_dir, &tombstone).with_context(|| {
                format!(
                    "quarantine orphaned dispatch workspace {}",
                    workspace_dir.display()
                )
            })?;
            fs::remove_dir_all(&tombstone).with_context(|| {
                format!("remove orphaned dispatch workspace {}", tombstone.display())
            })?;
            drop(git_operation_lock);
            drop(operation_lock);
            self.remove_workspace_operation_locks(&job_id)?;
            removed += 1;
        }
        self.collect_expired_repo_clones(now)?;
        Ok(removed)
    }

    /// Remove the checkout a departing job's provision record points at.
    ///
    /// The directory is only the checkout: every commit made in it was fetched
    /// into the shared clone during sync, so removing it cannot lose work the
    /// controller pulled. Work the controller never pulled is discarded with the
    /// job it belonged to, which is the same promise the event log makes.
    ///
    /// Returns `false` when the worktree is still busy, so the caller leaves the
    /// record in place and retries on the next sweep rather than orphaning it.
    /// Stale worktree administrative entries inside the clone are pruned by the
    /// next provision, which always runs `git worktree prune` first.
    fn remove_recorded_worktree(&self, workspace_dir: &Path) -> Result<bool> {
        let Ok(record) =
            read_json::<ProvisionedWorktreeRecord>(&workspace_dir.join(PROVISION_RECORD_FILE))
        else {
            // No record, or one written before checkouts were recorded: there is
            // nothing this sweep can safely delete.
            return Ok(true);
        };
        let Some(path) = record.workspace_path else {
            return Ok(true);
        };
        let worktree_dir = PathBuf::from(&path);
        // Only ever delete inside the managed worktree root, whatever the record
        // claims. A record is target-owned, but this keeps one corrupt file from
        // turning into an arbitrary recursive delete.
        if !worktree_dir.starts_with(self.worktrees_root()) {
            tracing::warn!("Skipping dispatch worktree outside the managed root: {path}");
            return Ok(true);
        }
        let metadata = match fs::symlink_metadata(&worktree_dir) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Ok(true);
        }
        let canonical = std::fs::canonicalize(&worktree_dir)
            .unwrap_or_else(|_| worktree_dir.clone())
            .to_string_lossy()
            .to_string();
        let Some(workspace_runtime_lock) =
            WorkspaceLock::try_acquire(&self.workspace_lock_path(&canonical))?
        else {
            return Ok(false);
        };
        let tombstone = self
            .worktrees_root()
            .join(format!(".gc-{}", uuid::Uuid::new_v4().as_simple()));
        fs::rename(&worktree_dir, &tombstone).with_context(|| {
            format!(
                "quarantine orphaned dispatch worktree {}",
                worktree_dir.display()
            )
        })?;
        fs::remove_dir_all(&tombstone).with_context(|| {
            format!("remove orphaned dispatch worktree {}", tombstone.display())
        })?;
        drop(workspace_runtime_lock);
        Ok(true)
    }

    fn collect_expired_repo_clones(&self, now: chrono::DateTime<chrono::Utc>) -> Result<()> {
        let cache_root = self.repos_root();
        for entry in fs::read_dir(&cache_root)
            .with_context(|| format!("read dispatch repository cache {}", cache_root.display()))?
        {
            let entry = entry?;
            let Some(digest) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            if self.repo_dir(&digest).is_err() {
                continue;
            }
            let cache_dir = entry.path();
            let metadata = fs::symlink_metadata(&cache_dir)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let lock_path = self.repo_lock_path(&digest)?;
            let Some(_lock) = JobLock::try_exclusive(&lock_path)? else {
                continue;
            };
            if self.repo_cache_is_referenced(&digest)? {
                continue;
            }
            let record = match read_json::<RepoCacheRetentionRecord>(
                &cache_dir.join(REPO_CACHE_RECORD_FILE),
            ) {
                Ok(record) => record,
                Err(error) => {
                    tracing::warn!(
                            "Skipping unreadable dispatch workspace cache entry: digest={} error={error:#}",
                            digest
                        );
                    continue;
                }
            };
            let Some(last_used_at) = chrono::DateTime::parse_from_rfc3339(&record.last_used_at)
                .ok()
                .map(|value| value.with_timezone(&chrono::Utc))
            else {
                continue;
            };
            if now.signed_duration_since(last_used_at).num_days() < REPO_CACHE_RETENTION_DAYS {
                continue;
            }
            let tombstone = cache_root.join(format!(
                ".gc-{}-{}",
                digest,
                uuid::Uuid::new_v4().as_simple()
            ));
            fs::rename(&cache_dir, &tombstone).with_context(|| {
                format!(
                    "quarantine expired dispatch workspace cache {}",
                    cache_dir.display()
                )
            })?;
            fs::remove_dir_all(&tombstone).with_context(|| {
                format!(
                    "remove expired dispatch workspace cache {}",
                    tombstone.display()
                )
            })?;
        }
        Ok(())
    }

    /// A live job keeps its shared bare repository alive even when it has not
    /// performed a Git operation for longer than the cache retention window.
    /// Its worktree's Git metadata points into that repository, so collecting
    /// the clone would otherwise break an in-flight detached task.
    fn repo_cache_is_referenced(&self, repo_key: &str) -> Result<bool> {
        let workspaces_root = self.root.join("workspaces");
        let jobs_root = self.root.join("jobs");
        for entry in fs::read_dir(&workspaces_root)
            .with_context(|| format!("read dispatch workspaces {}", workspaces_root.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let Some(job_id) = entry.file_name().to_str().map(ToOwned::to_owned) else {
                continue;
            };
            if validate_id("jobId", &job_id).is_err() || !jobs_root.join(&job_id).is_dir() {
                continue;
            }
            let provision_path = entry.path().join("provision.json");
            let Ok(value) = read_json::<serde_json::Value>(&provision_path) else {
                continue;
            };
            if value.get("repoKey").and_then(serde_json::Value::as_str) == Some(repo_key) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn remove_workspace_operation_locks(&self, job_id: &str) -> Result<()> {
        validate_id("jobId", job_id)?;
        for suffix in ["upload", "workspace", "git"] {
            let path = self
                .root
                .join("workspaces")
                .join(format!(".{job_id}.{suffix}.lock"));
            match fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
                    fs::remove_file(&path).with_context(|| {
                        format!("remove expired dispatch operation lock {}", path.display())
                    })?;
                }
                Ok(_) => tracing::warn!(
                    "Skipping unsafe expired dispatch operation lock: {}",
                    path.display()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn load_state_unlocked(&self, job_dir: &Path) -> Result<DispatchStateRecord> {
        read_json(&job_dir.join(STATE_FILE))
    }

    fn append_event_unlocked(&self, job_dir: &Path, event: &DispatchEvent) -> Result<u64> {
        let lock_path = job_dir.join(EVENTS_LOCK_FILE);
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("open dispatch event lock {}", lock_path.display()))?;
        set_private_file_permissions(&lock_path)?;
        let _lock = FileLock::exclusive(&lock_file)?;
        let path = job_dir.join(EVENTS_FILE);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("open dispatch events {}", path.display()))?;
        set_private_file_permissions(&path)?;
        let encoded = serde_json::to_vec(event).context("encode dispatch event")?;
        let event_was_omitted = encoded.len() > MAX_EVENT_BYTES;
        let encoded = if event_was_omitted {
            serde_json::to_vec(&DispatchEvent::oversized_event_omitted(
                encoded.len(),
                MAX_EVENT_BYTES,
            ))
            .context("encode oversized dispatch event marker")?
        } else {
            encoded
        };
        let (header, data_start) = read_event_log_header(&mut file, &path)?;
        let metadata_path = job_dir.join(EVENTS_METADATA_FILE);
        let mut event_metadata = load_event_log_metadata(&metadata_path);
        event_metadata.history_truncated |= header.cursor_base > 0;
        if event_was_omitted {
            // Persist the conservative completeness fact before the marker.
            // A crash may over-count by one, but can never claim completeness
            // after source content was dropped.
            event_metadata.omitted_event_count =
                event_metadata.omitted_event_count.saturating_add(1);
            atomic_write_json(&metadata_path, &event_metadata)?;
        }
        let physical_len = truncate_incomplete_event_tail(&mut file)?;
        file.seek(SeekFrom::Start(physical_len))?;
        let current_len = physical_len.saturating_sub(data_start);
        if current_len
            .saturating_add(encoded.len() as u64)
            .saturating_add(1)
            > self.max_events_bytes
        {
            let cursor_base = header.cursor_base.saturating_add(current_len);
            event_metadata.history_truncated = true;
            atomic_write_json(&metadata_path, &event_metadata)?;
            atomic_write_event_log(&path, cursor_base, Some(&encoded))?;
            return Ok(cursor_base
                .saturating_add(encoded.len() as u64)
                .saturating_add(1));
        }
        file.write_all(&encoded)?;
        file.write_all(b"\n")?;
        file.sync_data()?;
        Ok(header
            .cursor_base
            .saturating_add(file.metadata()?.len().saturating_sub(data_start)))
    }

    fn existing_job_dir(&self, job_id: &str) -> Result<PathBuf> {
        let path = self.job_dir(job_id)?;
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("dispatch job not found: {job_id}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("dispatch job path is not a private directory: {job_id}");
        }
        let record_path = path.join(JOB_RECORD_FILE);
        let record_metadata = fs::symlink_metadata(&record_path)
            .with_context(|| format!("dispatch job is not committed: {job_id}"))?;
        if record_metadata.file_type().is_symlink() || !record_metadata.is_file() {
            bail!("dispatch job commit marker is not a regular file: {job_id}");
        }
        Ok(path)
    }

    fn job_dir(&self, job_id: &str) -> Result<PathBuf> {
        validate_id("jobId", job_id)?;
        Ok(self.root.join("jobs").join(job_id))
    }

    #[cfg(test)]
    fn open_with_event_limit(root: PathBuf, max_events_bytes: u64) -> Result<Self> {
        let mut store = Self::open(root)?;
        store.max_events_bytes = max_events_bytes;
        Ok(store)
    }
}

pub(crate) struct WorkspaceLock {
    _file: File,
}

impl WorkspaceLock {
    pub(crate) fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            create_private_dir(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open workspace dispatch lock {}", path.display()))?;
        set_private_file_permissions(path)?;
        FileLock::exclusive(&file)?;
        Ok(Self { _file: file })
    }

    pub(crate) fn try_acquire(path: &Path) -> Result<Option<Self>> {
        if let Some(parent) = path.parent() {
            create_private_dir(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open workspace dispatch lock {}", path.display()))?;
        set_private_file_permissions(path)?;
        try_lock_file_exclusive(&file).map(|acquired| acquired.then(|| Self { _file: file }))
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        if let Err(error) = fs2::FileExt::unlock(&self._file) {
            tracing::warn!("Failed to release dispatch workspace lock: {error}");
        }
    }
}

pub(crate) struct DispatchLease {
    _file: File,
}

impl DispatchLease {
    fn try_acquire(path: &Path) -> Result<Option<Self>> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open dispatch lease {}", path.display()))?;
        set_private_file_permissions(path)?;
        try_lock_file_exclusive(&file).map(|acquired| acquired.then(|| Self { _file: file }))
    }
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        // A concurrent child spawn can briefly inherit the open file
        // description before exec closes it. Closing this handle alone leaves
        // its flock held by that child; the lease owner must release it.
        if let Err(error) = fs2::FileExt::unlock(&self._file) {
            tracing::warn!("Failed to release dispatch worker lease: {error}");
        }
    }
}

pub(super) struct JobLock {
    _file: File,
}

impl JobLock {
    pub(super) fn exclusive(path: &Path) -> Result<Self> {
        Self::open(path, true)
    }

    pub(super) fn try_exclusive(path: &Path) -> Result<Option<Self>> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open dispatch job lock {}", path.display()))?;
        set_private_file_permissions(path)?;
        try_lock_file_exclusive(&file).map(|acquired| acquired.then(|| Self { _file: file }))
    }

    fn shared(path: &Path) -> Result<Self> {
        Self::open(path, false)
    }

    fn open(path: &Path, exclusive: bool) -> Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open dispatch job lock {}", path.display()))?;
        set_private_file_permissions(path)?;
        if exclusive {
            FileLock::exclusive(&file)?;
        } else {
            FileLock::shared(&file)?;
        }
        Ok(Self { _file: file })
    }
}

impl Drop for JobLock {
    fn drop(&mut self) {
        if let Err(error) = fs2::FileExt::unlock(&self._file) {
            tracing::warn!("Failed to release dispatch job lock: {error}");
        }
    }
}

struct FileLock;

impl FileLock {
    fn exclusive(file: &File) -> Result<Self> {
        lock_file(file, true)?;
        Ok(Self)
    }

    fn shared(file: &File) -> Result<Self> {
        lock_file(file, false)?;
        Ok(Self)
    }
}

pub(super) fn validate_id(field: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || value == "."
        || value == ".."
    {
        bail!(
            "{field} must be 1-128 ASCII letters, digits, '.', '_' or '-' without path separators"
        );
    }
    Ok(())
}

fn mailbox_path(job_dir: &Path, directory: &str, id: &str) -> Result<PathBuf> {
    if id.trim().is_empty() || id.len() > 1024 {
        bail!("dispatch mailbox identity is empty or too long");
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(id.as_bytes());
    Ok(job_dir.join(directory).join(format!("{digest:x}.json")))
}

fn ensure_permission_answer_matches(
    existing: &StoredPermissionAnswer,
    request_id: &str,
    reply: &PermissionReply,
) -> Result<()> {
    if existing.request_id != request_id || existing.reply != *reply {
        bail!("dispatch permission requestId is already bound to a different answer");
    }
    Ok(())
}

fn load_event_log_metadata(path: &Path) -> EventLogMetadata {
    match read_optional_regular_json(path) {
        Ok(Some(metadata)) => metadata,
        Ok(None) => {
            tracing::warn!(
                "Dispatch event completeness metadata is missing: {}",
                path.display()
            );
            EventLogMetadata {
                history_truncated: true,
                omitted_event_count: 0,
            }
        }
        Err(error) => {
            tracing::warn!(
                "Dispatch event completeness metadata is unreadable: path={} error={error:#}",
                path.display()
            );
            EventLogMetadata {
                history_truncated: true,
                omitted_event_count: 0,
            }
        }
    }
}

fn read_optional_regular_json<T>(path: &Path) -> Result<Option<T>>
where
    T: for<'de> Deserialize<'de>,
{
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!(
                    "dispatch mailbox path is not a regular file: {}",
                    path.display()
                );
            }
            read_json(path).map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("inspect dispatch mailbox {}", path.display()))
        }
    }
}

fn read_json_directory<T>(directory: &Path) -> Result<Vec<T>>
where
    T: for<'de> Deserialize<'de>,
{
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read dispatch mailbox {}", directory.display()))
        }
    };
    let mut values = Vec::new();
    for entry in entries {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            bail!(
                "dispatch mailbox contains an invalid entry: {}",
                entry.path().display()
            );
        }
        values.push(read_json(&entry.path())?);
    }
    Ok(values)
}

fn mailbox_usage(directory: &Path) -> Result<(usize, u64)> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read dispatch mailbox {}", directory.display()))
        }
    };
    let mut count = 0_usize;
    let mut bytes = 0_u64;
    for entry in entries {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            bail!(
                "dispatch mailbox contains an invalid entry: {}",
                entry.path().display()
            );
        }
        count = count.saturating_add(1);
        bytes = bytes.saturating_add(metadata.len());
    }
    Ok((count, bytes))
}

fn write_json_if_absent_or_equal<T>(path: &Path, value: &T) -> Result<()>
where
    T: for<'de> Deserialize<'de> + Serialize + PartialEq,
{
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!(
                    "dispatch mailbox path is not a regular file: {}",
                    path.display()
                );
            }
            let existing = read_json::<T>(path)?;
            if existing != *value {
                bail!("dispatch mailbox identity is already bound to different content");
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            atomic_write_json(path, value)
        }
        Err(error) => {
            Err(error).with_context(|| format!("inspect dispatch mailbox {}", path.display()))
        }
    }
}

fn submit_intent_fingerprint(request: &DispatchSubmitRequest) -> Result<String> {
    use sha2::{Digest, Sha256};
    let encoded = serde_json::to_vec(request).context("encode dispatch submit intent")?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("decode {}", path.display()))
}

fn read_event_log_header(file: &mut File, path: &Path) -> Result<(EventLogHeader, u64)> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(64);
    let mut next = [0_u8; 1];
    loop {
        if bytes.len() >= 4 * 1024 {
            bail!("dispatch event log header is too large: {}", path.display());
        }
        let read = file.read(&mut next)?;
        if read == 0 {
            bail!(
                "dispatch event log header is incomplete: {}",
                path.display()
            );
        }
        if next[0] == b'\n' {
            break;
        }
        bytes.push(next[0]);
    }
    let header = serde_json::from_slice(&bytes)
        .with_context(|| format!("decode dispatch event log header {}", path.display()))?;
    Ok((header, bytes.len() as u64 + 1))
}

fn atomic_write_event_log(path: &Path, cursor_base: u64, event: Option<&[u8]>) -> Result<()> {
    let mut bytes = serde_json::to_vec(&EventLogHeader { cursor_base })
        .context("encode dispatch event log header")?;
    bytes.push(b'\n');
    if let Some(event) = event {
        bytes.extend_from_slice(event);
        bytes.push(b'\n');
    }
    atomic_write(path, &bytes)
}

fn truncate_incomplete_event_tail(file: &mut File) -> Result<u64> {
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(0);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0_u8; 1];
    file.read_exact(&mut last)?;
    if last[0] == b'\n' {
        return Ok(len);
    }

    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::with_capacity(len.min(DEFAULT_MAX_EVENTS_BYTES) as usize);
    file.read_to_end(&mut bytes)?;
    let retained = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    file.set_len(retained as u64)?;
    file.seek(SeekFrom::Start(retained as u64))?;
    file.sync_data()?;
    Ok(retained as u64)
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let suffix = "…";
    let mut end = max_bytes.saturating_sub(suffix.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], suffix)
}

pub(super) fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).context("encode dispatch state")?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("dispatch state path has no parent: {}", path.display()))?;
    create_private_dir(parent)?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("dispatch"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create temporary dispatch file {}", temp.display()))?;
        set_private_file_permissions(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
            .with_context(|| format!("publish dispatch file {}", path.display()))?;
        set_private_file_permissions(path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        remove_file_if_present(&temp);
    }
    result
}

fn ensure_private_file(path: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("create dispatch file {}", path.display()))?;
    drop(file);
    set_private_file_permissions(path)
}

pub(super) fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("set private permissions on {}", path.display()))?;
    }
    Ok(())
}

pub(super) fn set_private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("set private permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(path)
            .with_context(|| format!("open dispatch directory {}", path.display()))?
            .sync_all()
            .with_context(|| format!("sync dispatch directory {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn remove_file_if_present(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("Failed to remove dispatch file {}: {error}", path.display());
        }
    }
}

fn lock_file(file: &File, exclusive: bool) -> Result<()> {
    let result = if exclusive {
        fs2::FileExt::lock_exclusive(file)
    } else {
        fs2::FileExt::lock_shared(file)
    };
    result.context("lock dispatch file")
}

fn try_lock_file_exclusive(file: &File) -> Result<bool> {
    match fs2::FileExt::try_lock_exclusive(file) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
            Ok(false)
        }
        Err(error) => Err(error).context("try lock dispatch file"),
    }
}

fn retryable_retention_rename_error(error: &std::io::Error) -> bool {
    cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::protocol::{
        DispatchApprovalPolicy, DispatchSetupAuditEvent, DispatchSubmitRequest,
    };
    use openbitfun_agent_runtime::sdk::{PermissionRequestSource, PermissionRequestSourceKind};
    use serde_json::Map;

    fn request(job_id: &str) -> DispatchSubmitRequest {
        DispatchSubmitRequest {
            protocol_version: DISPATCH_PROTOCOL_VERSION,
            job_id: job_id.to_string(),
            session_id: format!("session-{job_id}"),
            workspace_path: "/tmp/workspace".to_string(),
            agent_type: "Standard".to_string(),
            prompt: "do the work".to_string(),
            approval_policy: DispatchApprovalPolicy::RejectAndReport,
            model: Some("model-1".to_string()),
            reasoning_preset: Some("medium".to_string()),
            title: None,
            attachments: Vec::new(),
            setup_audit: Vec::new(),
        }
    }

    fn store() -> (tempfile::TempDir, DispatchStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = DispatchStore::open(dir.path().join("dispatch")).expect("store");
        (dir, store)
    }

    fn permission_request(job_id: &str) -> PermissionRequest {
        PermissionRequest {
            request_id: "permission-1".to_string(),
            round_id: "round-1".to_string(),
            order: 0,
            tool_call_id: Some("tool-call-1".to_string()),
            project_path: Some("/tmp/workspace".to_string()),
            project_id: "project-1".to_string(),
            session_id: format!("session-{job_id}"),
            agent_id: "Standard".to_string(),
            action: "write".to_string(),
            resources: vec!["src/main.rs".to_string()],
            save_resources: Vec::new(),
            source: PermissionRequestSource {
                kind: PermissionRequestSourceKind::ToolCall,
                identity: "Write".to_string(),
            },
            delegation: None,
            display_metadata: Map::new(),
        }
    }

    #[test]
    fn event_cursor_is_monotonic_and_does_not_replay() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "Task".to_string())
            .expect("create job");

        let first = store.read_events("job-1", 0).expect("first page");
        assert_eq!(first.events.len(), 2);
        assert!(first.cursor > 0);

        store
            .append_event(
                "job-1",
                &DispatchEvent::job_state(DispatchJobState::Running, Some("started".to_string())),
            )
            .expect("append");
        let second = store
            .read_events("job-1", first.cursor)
            .expect("second page");
        assert_eq!(second.events.len(), 1);
        assert!(second.cursor > first.cursor);

        let empty = store
            .read_events("job-1", second.cursor)
            .expect("empty page");
        assert!(empty.events.is_empty());
        assert_eq!(empty.cursor, second.cursor);
    }

    #[test]
    fn incomplete_trailing_event_is_retried_after_crash_recovery() {
        let (_dir, store) = store();
        store
            .create_job(request("job-2"), "Task".to_string())
            .expect("create job");
        let initial = store.read_events("job-2", 0).expect("initial page");
        let path = store.job_dir("job-2").expect("job dir").join(EVENTS_FILE);
        let mut file = OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open events");
        file.write_all(br#"{"type":"jobState","timestamp":"partial""#)
            .expect("write partial line");
        file.sync_all().expect("sync partial line");
        drop(file);

        let page = store
            .read_events("job-2", initial.cursor)
            .expect("read after partial write");
        assert!(page.events.is_empty());
        assert_eq!(page.cursor, initial.cursor);

        store
            .append_event(
                "job-2",
                &DispatchEvent::job_state(DispatchJobState::Running, Some("recovered".to_string())),
            )
            .expect("append after partial write");
        let recovered = store
            .read_events("job-2", initial.cursor)
            .expect("read recovered event");
        assert_eq!(recovered.events.len(), 1);
        assert!(matches!(
            &recovered.events[0],
            DispatchEvent::JobState {
                state: DispatchJobState::Running,
                ..
            }
        ));
        assert!(recovered.cursor > initial.cursor);
    }

    fn continue_request(job_id: &str, turn_id: &str, prompt: &str) -> DispatchContinueRequest {
        DispatchContinueRequest {
            protocol_version: DISPATCH_PROTOCOL_VERSION,
            job_id: job_id.to_string(),
            turn_id: turn_id.to_string(),
            prompt: prompt.to_string(),
            display_content: None,
            model: None,
            reasoning_preset: None,
            approval_policy: None,
            kind: DispatchTurnKind::Prompt,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn a_follow_up_turn_requeues_a_finished_job_and_is_claimed_once() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "job title".to_string())
            .expect("create job");
        store
            .mark_state("job-1", DispatchJobState::Running, Some("turn-1"), None)
            .expect("running");
        store
            .mark_state("job-1", DispatchJobState::Succeeded, None, None)
            .expect("succeeded");

        let state = store
            .queue_follow_up_turn(&continue_request("job-1", "turn-2", "and now this"))
            .expect("queue follow-up");
        assert_eq!(state.state, DispatchJobState::Queued);
        // The previous turn's identity must not survive, or the next worker
        // would refuse to run believing a turn was already submitted.
        assert!(state.turn_id.is_none());
        assert!(state.finished_at.is_none());

        let claimed = store
            .claim_follow_up_turn("job-1", "runtime-turn-2")
            .expect("claim")
            .expect("a queued turn");
        assert_eq!(claimed.prompt, "and now this");
        assert_eq!(
            store.load_state("job-1").expect("state").turn_id.as_deref(),
            Some("runtime-turn-2")
        );
        // A second worker must find nothing left to run.
        assert!(store
            .claim_follow_up_turn("job-1", "runtime-turn-3")
            .expect("second claim")
            .is_none());
    }

    #[test]
    fn per_turn_options_are_peeked_applied_and_kept_idempotent() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "job title".to_string())
            .expect("create job");
        store
            .mark_state("job-1", DispatchJobState::Succeeded, Some("turn-1"), None)
            .expect("succeeded");

        let mut follow_up = continue_request("job-1", "turn-2", "with new options");
        follow_up.model = Some("model-2".to_string());
        follow_up.reasoning_preset = Some("high".to_string());
        follow_up.approval_policy = Some(DispatchApprovalPolicy::Remote);
        store
            .queue_follow_up_turn(&follow_up)
            .expect("queue follow-up");

        // The worker reads the overrides before runtime bootstrap.
        let peeked = store
            .peek_follow_up_turn("job-1")
            .expect("peek")
            .expect("a queued turn");
        assert_eq!(peeked.model.as_deref(), Some("model-2"));
        assert_eq!(peeked.reasoning_preset.as_deref(), Some("high"));
        assert_eq!(peeked.approval_policy, Some(DispatchApprovalPolicy::Remote));

        let listed = store.list_jobs().expect("list queued job");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].model.as_deref(), Some("model-2"));
        assert_eq!(listed[0].reasoning_preset.as_deref(), Some("high"));
        assert_eq!(listed[0].approval_policy, DispatchApprovalPolicy::Remote);

        // A retried turnId bound to different options must be refused.
        let mut conflicting = follow_up.clone();
        conflicting.reasoning_preset = Some("low".to_string());
        assert!(store.queue_follow_up_turn(&conflicting).is_err());

        // Applying the effective options rewrites the job record...
        let (model_changed, reasoning_changed, policy_changed) = store
            .update_job_request_options(
                "job-1",
                Some("model-2"),
                Some("high"),
                DispatchApprovalPolicy::Remote,
            )
            .expect("apply options");
        assert!(model_changed);
        assert!(reasoning_changed);
        assert!(policy_changed);
        let job = store.load_job("job-1").expect("job");
        assert_eq!(job.request.model.as_deref(), Some("model-2"));
        assert_eq!(job.request.reasoning_preset.as_deref(), Some("high"));
        assert_eq!(job.request.approval_policy, DispatchApprovalPolicy::Remote);

        let listed = store.list_jobs().expect("list applied job");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].reasoning_preset.as_deref(), Some("high"));

        // ...without breaking submit idempotency: the ORIGINAL submit retry
        // still matches its stored fingerprint after the rewrite.
        let existing = store
            .load_existing_job_for_intent(&request("job-1"))
            .expect("intent lookup")
            .expect("existing job");
        assert_eq!(existing.0.request.model.as_deref(), Some("model-2"));

        // Re-applying identical options reports no change.
        assert_eq!(
            store
                .update_job_request_options(
                    "job-1",
                    Some("model-2"),
                    Some("high"),
                    DispatchApprovalPolicy::Remote
                )
                .expect("idempotent apply"),
            (false, false, false)
        );
    }

    #[test]
    fn a_retried_follow_up_request_never_starts_a_second_turn() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "job title".to_string())
            .expect("create job");
        store
            .mark_state("job-1", DispatchJobState::Succeeded, None, None)
            .expect("succeeded");

        let queued = continue_request("job-1", "turn-2", "and now this");
        store.queue_follow_up_turn(&queued).expect("first");
        store.queue_follow_up_turn(&queued).expect("retry");
        store
            .claim_follow_up_turn("job-1", "runtime-turn-2")
            .expect("claim");
        // Even a retry that arrives after the worker claimed the turn is a
        // no-op rather than a duplicate submission.
        store.queue_follow_up_turn(&queued).expect("late retry");
        assert!(store
            .claim_follow_up_turn("job-1", "runtime-turn-3")
            .expect("claim again")
            .is_none());

        let conflicting = continue_request("job-1", "turn-2", "something else");
        assert!(store.queue_follow_up_turn(&conflicting).is_err());
    }

    #[test]
    fn unsubmitted_follow_up_is_preserved_when_bootstrap_fails_or_queue_is_cancelled() {
        for terminal in [DispatchJobState::Failed, DispatchJobState::Cancelled] {
            let (_dir, store) = store();
            store
                .create_job(request("job-1"), "Task".to_string())
                .unwrap();
            store
                .mark_state("job-1", DispatchJobState::Succeeded, None, None)
                .unwrap();
            let old = continue_request("job-1", "turn-2", "preserve the unsubmitted prompt");
            store.queue_follow_up_turn(&old).unwrap();
            let job_dir = store.existing_job_dir("job-1").unwrap();
            let pending_path = mailbox_path(&job_dir, PENDING_TURNS_DIR, "turn-2").unwrap();
            let original = fs::read(&pending_path).unwrap();

            store
                .mark_state(
                    "job-1",
                    terminal,
                    None,
                    Some("target model unavailable".to_string()),
                )
                .unwrap();
            assert!(store.peek_follow_up_turn("job-1").unwrap().is_none());
            let consumed_path = mailbox_path(&job_dir, CONSUMED_TURNS_DIR, "turn-2").unwrap();
            let preserved: StoredFollowUpTurn = read_json(&consumed_path).unwrap();
            let original: StoredFollowUpTurn = serde_json::from_slice(&original).unwrap();
            assert_eq!(preserved, original);
            assert_eq!(
                store
                    .load_existing_follow_up_for_intent(&old)
                    .unwrap()
                    .unwrap()
                    .state,
                terminal
            );
            assert_eq!(store.queue_follow_up_turn(&old).unwrap().state, terminal);
            let events = fs::read_to_string(job_dir.join(EVENTS_FILE)).unwrap();
            let settled = events
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter(|event| {
                    event.get("action").and_then(|v| v.as_str()) == Some("followUpNotSubmitted")
                })
                .collect::<Vec<_>>();
            assert_eq!(settled.len(), 1);
            assert_eq!(settled[0]["details"]["turnId"], "turn-2");

            store
                .queue_follow_up_turn(&continue_request(
                    "job-1",
                    "turn-3",
                    "run only this new prompt",
                ))
                .unwrap();
            let next = store
                .claim_follow_up_turn("job-1", "runtime-turn-3")
                .unwrap()
                .unwrap();
            assert_eq!(next.turn_id, "turn-3");
            assert_eq!(next.prompt, "run only this new prompt");
            assert!(store
                .queue_follow_up_turn(&continue_request("job-1", "turn-2", "changed old prompt"))
                .is_err());
        }
    }

    #[test]
    fn a_new_follow_up_recovers_a_legacy_failed_unclaimed_mailbox_without_replaying_it() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "Task".to_string())
            .unwrap();
        store
            .mark_state(
                "job-1",
                DispatchJobState::Failed,
                None,
                Some("legacy bootstrap failure".to_string()),
            )
            .unwrap();
        let job_dir = store.existing_job_dir("job-1").unwrap();
        let old_payload = serde_json::json!({
            "turnId": "legacy-turn", "prompt": "never replay this old prompt",
            "createdAt": "2026-01-01T00:00:00Z"
        });
        // Older workers marked the job failed while leaving this original
        // mailbox shape untouched. Recovery must not require manual removal.
        let pending_path = mailbox_path(&job_dir, PENDING_TURNS_DIR, "legacy-turn").unwrap();
        atomic_write_json(&pending_path, &old_payload).unwrap();

        store
            .queue_follow_up_turn(&continue_request("job-1", "new-turn", "new request"))
            .unwrap();
        assert!(!pending_path.exists());
        let consumed_path = mailbox_path(&job_dir, CONSUMED_TURNS_DIR, "legacy-turn").unwrap();
        let preserved: StoredFollowUpTurn = read_json(&consumed_path).unwrap();
        let round_trip = serde_json::to_value(&preserved).unwrap();
        for field in ["turnId", "prompt", "createdAt"] {
            assert_eq!(round_trip[field], old_payload[field]);
        }
        assert_eq!(preserved.model, None);
        assert_eq!(preserved.reasoning_preset, None);
        assert!(preserved.attachments.is_empty());
        let next = store
            .claim_follow_up_turn("job-1", "runtime-new-turn")
            .unwrap()
            .unwrap();
        assert_eq!(next.turn_id, "new-turn");
        let events = fs::read_to_string(job_dir.join(EVENTS_FILE)).unwrap();
        assert!(events.contains("followUpNotSubmitted"));
        assert!(events.contains("legacy bootstrap failure"));
    }

    #[test]
    fn accepted_follow_up_intent_lookup_is_read_only_and_rejects_conflicts() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "Task".to_string())
            .unwrap();
        store
            .mark_state("job-1", DispatchJobState::Succeeded, None, None)
            .unwrap();
        let submitted = continue_request("job-1", "turn-2", "accepted once");
        assert!(store
            .load_existing_follow_up_for_intent(&submitted)
            .unwrap()
            .is_none());
        store.queue_follow_up_turn(&submitted).unwrap();
        let job_dir = store.existing_job_dir("job-1").unwrap();
        let before = fs::read(job_dir.join(EVENTS_FILE)).unwrap();
        let state_before = fs::read(job_dir.join(STATE_FILE)).unwrap();
        assert_eq!(
            store
                .load_existing_follow_up_for_intent(&submitted)
                .unwrap()
                .unwrap()
                .state,
            DispatchJobState::Queued
        );
        assert!(store
            .load_existing_follow_up_for_intent(&continue_request(
                "job-1",
                "turn-2",
                "different intent"
            ))
            .is_err());
        assert_eq!(fs::read(job_dir.join(EVENTS_FILE)).unwrap(), before);
        assert_eq!(fs::read(job_dir.join(STATE_FILE)).unwrap(), state_before);
        assert_eq!(
            store.peek_follow_up_turn("job-1").unwrap().unwrap().prompt,
            "accepted once"
        );
    }

    #[test]
    fn a_running_job_refuses_a_follow_up_turn() {
        let (_dir, store) = store();
        store
            .create_job(request("job-1"), "job title".to_string())
            .expect("create job");
        store
            .mark_state("job-1", DispatchJobState::Running, Some("turn-1"), None)
            .expect("running");

        // Steering a live turn is what `append` is for; starting a second turn
        // underneath a running one would race the worker.
        let error = store
            .queue_follow_up_turn(&continue_request("job-1", "turn-2", "next"))
            .expect_err("a running job cannot take a follow-up");
        assert!(error.to_string().contains("still running"));
    }

    #[test]
    fn goal_continuation_persists_its_turn_and_rejects_stale_or_terminal_owners() {
        let (_dir, store) = store();
        store
            .create_job(request("goal-turn"), "Goal".into())
            .unwrap();
        store
            .mark_state("goal-turn", DispatchJobState::Running, Some("turn-1"), None)
            .unwrap();
        store
            .advance_goal_turn("goal-turn", "turn-1", "turn-2")
            .unwrap();
        let restored = store.load_state("goal-turn").unwrap();
        assert_eq!(restored.state, DispatchJobState::Running);
        assert_eq!(restored.turn_id.as_deref(), Some("turn-2"));
        assert!(store
            .advance_goal_turn("goal-turn", "turn-1", "stale")
            .is_err());
        store
            .mark_state(
                "goal-turn",
                DispatchJobState::Succeeded,
                Some("turn-2"),
                None,
            )
            .unwrap();
        assert!(store
            .advance_goal_turn("goal-turn", "turn-2", "late")
            .is_err());
        assert_eq!(
            store.load_state("goal-turn").unwrap().turn_id.as_deref(),
            Some("turn-2")
        );
    }

    #[test]
    fn terminal_state_is_idempotent() {
        let (_dir, store) = store();
        store
            .create_job(request("job-3"), "Task".to_string())
            .expect("create job");
        let (succeeded, changed) = store
            .mark_state("job-3", DispatchJobState::Succeeded, Some("turn-1"), None)
            .expect("succeed");
        assert!(changed);
        assert_eq!(succeeded.state, DispatchJobState::Succeeded);

        let (still_succeeded, changed) = store
            .mark_state(
                "job-3",
                DispatchJobState::Failed,
                Some("turn-1"),
                Some("late failure".to_string()),
            )
            .expect("late terminal update");
        assert!(!changed);
        assert_eq!(still_succeeded.state, DispatchJobState::Succeeded);
        assert!(still_succeeded.last_error.is_none());
    }

    #[test]
    fn permission_answers_are_idempotent_before_and_after_worker_consumption() {
        let (_dir, store) = store();
        store
            .create_job(request("job-permission"), "Task".to_string())
            .expect("create job");
        let permission = permission_request("job-permission");
        store
            .save_pending_permission("job-permission", &permission)
            .expect("save pending permission");

        assert!(store
            .save_permission_answer(
                "job-permission",
                &permission.request_id,
                PermissionReply::Once,
            )
            .expect("first answer"));
        assert!(store
            .save_permission_answer(
                "job-permission",
                &permission.request_id,
                PermissionReply::Once,
            )
            .expect("retry pending answer"));
        let answer = store
            .list_permission_answers("job-permission")
            .expect("list answers")
            .pop()
            .expect("answer");
        store
            .mark_permission_resolved("job-permission", &answer)
            .expect("resolve answer");
        assert!(store
            .save_permission_answer(
                "job-permission",
                &permission.request_id,
                PermissionReply::Once,
            )
            .expect("retry resolved answer"));
        assert!(store
            .save_permission_answer(
                "job-permission",
                &permission.request_id,
                PermissionReply::Always,
            )
            .is_err());
    }

    #[test]
    fn appended_messages_are_idempotently_bound_to_their_content() {
        let (_dir, store) = store();
        store
            .create_job(request("job-append"), "Task".to_string())
            .expect("create job");
        let message = DispatchAppendRequest {
            job_id: "job-append".to_string(),
            message_id: "message-1".to_string(),
            content: "Continue with tests".to_string(),
            display_content: None,
            attachments: Vec::new(),
        };

        assert!(store
            .enqueue_append_message(message.clone())
            .expect("first append"));
        assert!(store
            .enqueue_append_message(message.clone())
            .expect("retry pending append"));
        store
            .mark_append_message_consumed("job-append", &message)
            .expect("consume append");
        assert!(store
            .enqueue_append_message(message.clone())
            .expect("retry consumed append"));
        let mut conflicting = message;
        conflicting.content = "Different content".to_string();
        assert!(store.enqueue_append_message(conflicting).is_err());
    }

    #[test]
    fn worker_exit_settlement_observes_cancel_request_under_the_state_lock() {
        let (_dir, store) = store();
        store
            .create_job(request("job-cancel-exit"), "Task".to_string())
            .expect("create cancelled job");
        store
            .request_cancel("job-cancel-exit")
            .expect("request cancellation");
        assert_eq!(
            store
                .settle_exited_worker("job-cancel-exit")
                .expect("settle cancelled worker")
                .state,
            DispatchJobState::Cancelled
        );

        store
            .create_job(request("job-crash-exit"), "Task".to_string())
            .expect("create crashed job");
        let crashed = store
            .settle_exited_worker("job-crash-exit")
            .expect("settle crashed worker");
        assert_eq!(crashed.state, DispatchJobState::Failed);
        assert!(crashed.last_error.is_some());
    }

    #[test]
    fn duplicate_submit_is_idempotent_but_conflicts_fail() {
        let (_dir, store) = store();
        let original = request("job-4");
        assert!(matches!(
            store
                .create_job(original.clone(), "Task".to_string())
                .expect("first"),
            CreateJobOutcome::Created(_)
        ));
        assert!(matches!(
            store
                .create_job(original.clone(), "Task".to_string())
                .expect("duplicate"),
            CreateJobOutcome::Existing(_)
        ));

        let mut conflicting = original;
        conflicting.prompt = "different task".to_string();
        assert!(store.create_job(conflicting, "Task".to_string()).is_err());
    }

    #[test]
    fn retry_rebuilds_uncommitted_partial_job_before_publishing_record() {
        let (_dir, store) = store();
        let request = request("job-partial-create");
        let job_dir = store.job_dir("job-partial-create").expect("job dir");
        create_private_dir(&job_dir).expect("partial job dir");
        atomic_write(&job_dir.join(STATE_FILE), b"{\"state\":").expect("partial state artifact");
        ensure_private_file(&job_dir.join(EVENTS_LOCK_FILE)).expect("partial event lock");
        atomic_write(
            &job_dir.join(EVENTS_FILE),
            b"{\"cursorBase\":0}\n{\"type\":",
        )
        .expect("partial event artifact");
        assert!(!job_dir.join(JOB_RECORD_FILE).exists());
        assert!(
            store.load_state("job-partial-create").is_err(),
            "status must not consume an uncommitted partial state"
        );
        assert!(
            store.read_events("job-partial-create", 0).is_err(),
            "status must not consume an uncommitted partial event stream"
        );
        assert!(
            store.request_cancel("job-partial-create").is_err(),
            "cancel must not mutate an uncommitted partial job"
        );
        assert!(
            store
                .load_existing_job_for_intent(&request)
                .expect("lookup uncommitted partial job")
                .is_none(),
            "an exact retry must be allowed to rebuild an uncommitted partial job"
        );

        let outcome = store
            .create_job(request, "Recovered task".to_string())
            .expect("retry partial initialization");
        assert!(matches!(outcome, CreateJobOutcome::Created(_)));
        assert!(
            job_dir.join(JOB_RECORD_FILE).is_file(),
            "job record is published only after the artifacts are rebuilt"
        );
        assert_eq!(
            store
                .load_state("job-partial-create")
                .expect("recovered state")
                .state,
            DispatchJobState::Queued
        );
        let events = store
            .read_events("job-partial-create", 0)
            .expect("recovered events");
        assert_eq!(events.events.len(), 2);
        assert!(matches!(
            events.events.first(),
            Some(DispatchEvent::Audit { action, .. }) if action == "approvalPolicySelected"
        ));
    }

    #[test]
    fn raw_submit_intent_remains_idempotent_when_resolution_changes() {
        let (_dir, store) = store();
        let mut intent = request("job-stable-intent");
        intent.model = None;
        intent.title = None;
        intent.workspace_path = "/symbolic/workspace".to_string();
        let mut resolved_a = intent.clone();
        resolved_a.model = Some("model-a".to_string());
        resolved_a.title = Some("Generated title A".to_string());
        resolved_a.workspace_path = "/canonical/workspace-a".to_string();
        store
            .create_job_with_intent(intent.clone(), resolved_a, "Generated title A".to_string())
            .expect("first resolved submit");

        let mut resolved_b = intent.clone();
        resolved_b.model = Some("model-b".to_string());
        resolved_b.title = Some("Generated title B".to_string());
        resolved_b.workspace_path = "/canonical/workspace-b".to_string();
        assert!(matches!(
            store
                .create_job_with_intent(intent.clone(), resolved_b, "Generated title B".to_string())
                .expect("same raw intent"),
            CreateJobOutcome::Existing(_)
        ));
        let (record, _) = store
            .load_existing_job_for_intent(&intent)
            .expect("lookup")
            .expect("existing job");
        assert_eq!(record.request.model.as_deref(), Some("model-a"));
        assert_eq!(record.request.workspace_path, "/canonical/workspace-a");

        let mut conflicting_intent = intent;
        conflicting_intent.prompt = "different task".to_string();
        assert!(store
            .load_existing_job_for_intent(&conflicting_intent)
            .is_err());
    }

    #[test]
    fn queued_job_spawn_claim_recovers_after_controller_loss() {
        let (_dir, store) = store();
        store
            .create_job(request("job-spawn-retry"), "Task".to_string())
            .expect("create job");

        let first = store
            .try_claim_worker_spawn("job-spawn-retry")
            .expect("first claim")
            .expect("claim available");
        assert!(
            store
                .try_claim_worker_spawn("job-spawn-retry")
                .expect("contended claim")
                .is_none(),
            "a concurrent idempotent submit must not spawn twice"
        );
        drop(first);
        assert!(
            store
                .try_claim_worker_spawn("job-spawn-retry")
                .expect("recovery claim")
                .is_some(),
            "the OS lock must release after controller loss so a retry can recover the queued job"
        );
    }

    #[test]
    fn worker_lease_allows_only_one_executor_per_job() {
        let (_dir, store) = store();
        store
            .create_job(request("job-worker-lease"), "Task".to_string())
            .expect("create job");

        let first = store
            .try_acquire_worker_lease("job-worker-lease")
            .expect("first lease")
            .expect("lease available");
        assert!(store
            .try_acquire_worker_lease("job-worker-lease")
            .expect("contended lease")
            .is_none());
        let _inherited_handle = first._file.try_clone().expect("inherited handle");
        drop(first);
        assert!(store
            .try_acquire_worker_lease("job-worker-lease")
            .expect("released lease")
            .is_some());
    }

    #[test]
    fn workspace_lock_release_does_not_wait_for_an_inherited_handle() {
        let (dir, _store) = store();
        let path = dir.path().join("workspace.lock");
        let first = WorkspaceLock::acquire(&path).expect("first lock");
        assert!(WorkspaceLock::try_acquire(&path)
            .expect("contended lock")
            .is_none());
        let _inherited_handle = first._file.try_clone().expect("inherited handle");
        drop(first);
        assert!(WorkspaceLock::try_acquire(&path)
            .expect("released lock")
            .is_some());
    }

    #[test]
    fn first_event_audits_only_the_explicit_approval_policy() {
        let (_dir, store) = store();
        store
            .create_job(request("job-audit"), "Task".to_string())
            .expect("create job");
        let page = store.read_events("job-audit", 0).expect("events");
        let DispatchEvent::Audit {
            action, details, ..
        } = &page.events[0]
        else {
            panic!("first event must be an audit row");
        };
        assert_eq!(action, "approvalPolicySelected");
        assert_eq!(details["approvalPolicy"], "reject-and-report");
        assert!(details.get("prompt").is_none());
    }

    #[test]
    fn controller_setup_audit_is_replayed_before_target_job_events() {
        let (_dir, store) = store();
        let mut request = request("job-setup-audit");
        request.setup_audit.push(DispatchSetupAuditEvent {
            timestamp: "2026-07-31T00:00:00Z".to_string(),
            action: "cli-install".to_string(),
            details: serde_json::json!({ "stage": "cli-install-succeeded" }),
        });
        store
            .create_job(request, "Task".to_string())
            .expect("create job");

        let page = store.read_events("job-setup-audit", 0).expect("events");
        assert!(matches!(
            &page.events[0],
            DispatchEvent::Audit { action, details, .. }
                if action == "cli-install"
                    && details["stage"] == "cli-install-succeeded"
        ));
        assert!(matches!(
            &page.events[1],
            DispatchEvent::Audit { action, .. } if action == "approvalPolicySelected"
        ));
    }

    #[test]
    fn cursor_beyond_the_file_resets_to_the_retained_prefix() {
        let (_dir, store) = store();
        store
            .create_job(request("job-5"), "Task".to_string())
            .expect("create job");
        let page = store.read_events("job-5", u64::MAX).expect("reset page");
        assert!(page.cursor_reset);
        assert_eq!(page.events.len(), 2);
    }

    #[test]
    fn atomic_rotation_resets_old_cursors_and_keeps_terminal_state_visible() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store =
            DispatchStore::open_with_event_limit(dir.path().join("dispatch"), 512).expect("store");
        store
            .create_job(request("job-6"), "Task".to_string())
            .expect("create job");
        let before = store.read_events("job-6", 0).expect("before rotation");
        let job_dir = store.job_dir("job-6").expect("job dir");
        let events_path = job_dir.join(EVENTS_FILE);
        store
            .append_event(
                "job-6",
                &DispatchEvent::job_state(
                    DispatchJobState::Running,
                    Some(format!("rotation-event-{}", "x".repeat(320))),
                ),
            )
            .expect("rotate event log");
        let rotated = store.read_events("job-6", 0).expect("after rotation");
        assert!(rotated.cursor_reset);
        assert!(rotated.cursor > before.cursor);
        assert_eq!(rotated.events.len(), 1);

        let mut file = File::open(&events_path).expect("open rotated log");
        let (header, data_start) =
            read_event_log_header(&mut file, &events_path).expect("coherent header");
        assert!(header.cursor_base >= before.cursor);
        assert!(file.metadata().expect("metadata").len() > data_start);

        // A crash before the final rename may leave an unpublished temporary
        // file, but readers continue to observe the complete active artifact.
        let active_bytes = fs::read(&events_path).expect("active rotated log");
        fs::write(job_dir.join(".events.crash.tmp"), b"incomplete replacement")
            .expect("simulate pre-publish crash");
        assert_eq!(
            fs::read(&events_path).expect("active log after simulated crash"),
            active_bytes
        );
        let caught_up = store
            .read_events("job-6", rotated.cursor)
            .expect("read after simulated crash");
        assert!(caught_up.events.is_empty());
        assert_eq!(caught_up.cursor, rotated.cursor);

        store
            .mark_state("job-6", DispatchJobState::Succeeded, Some("turn-1"), None)
            .expect("write terminal state after rotation");
        let terminal = store.read_events("job-6", 0).expect("terminal page");
        assert!(terminal.cursor_reset);
        assert!(terminal.events.iter().any(|event| matches!(
            event,
            DispatchEvent::JobState {
                state: DispatchJobState::Succeeded,
                ..
            }
        )));
    }

    #[cfg(unix)]
    #[test]
    fn cross_process_reader_and_writer_remain_consistent_during_rotation() {
        const MODE_ENV: &str = "OPENBITFUN_DISPATCH_ROTATION_STRESS_MODE";
        const ROOT_ENV: &str = "OPENBITFUN_DISPATCH_ROTATION_STRESS_ROOT";
        const DONE_ENV: &str = "OPENBITFUN_DISPATCH_ROTATION_STRESS_DONE";

        if let Some(mode) = std::env::var_os(MODE_ENV) {
            let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("stress root"));
            let done = PathBuf::from(std::env::var_os(DONE_ENV).expect("stress done"));
            let store = DispatchStore::open_with_event_limit(root, 4 * 1024).expect("child store");
            match mode.to_string_lossy().as_ref() {
                "writer" => {
                    for index in 0..240 {
                        store
                            .append_event(
                                "job-stress",
                                &DispatchEvent::job_state(
                                    DispatchJobState::Running,
                                    Some(format!("{index}:{}", "x".repeat(512))),
                                ),
                            )
                            .expect("stress append");
                    }
                    fs::write(done, b"done\n").expect("publish writer completion");
                }
                "reader" => {
                    let mut cursor = 0_u64;
                    let mut empty_after_done = 0_u8;
                    for _ in 0..10_000 {
                        let page = store
                            .read_events("job-stress", cursor)
                            .expect("stress read");
                        assert!(page.cursor >= cursor, "absolute cursor must not regress");
                        cursor = page.cursor;
                        if done.exists() && page.events.is_empty() {
                            empty_after_done += 1;
                            if empty_after_done >= 3 {
                                return;
                            }
                        } else {
                            empty_after_done = 0;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    panic!("reader did not drain the rotated log");
                }
                other => panic!("unexpected stress mode {other}"),
            }
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("dispatch");
        let done = dir.path().join("writer.done");
        DispatchStore::open_with_event_limit(root.clone(), 4 * 1024)
            .expect("parent store")
            .create_job(request("job-stress"), "Task".to_string())
            .expect("create stress job");
        let executable = std::env::current_exe().expect("test executable");
        let test_name =
            "dispatch::store::tests::cross_process_reader_and_writer_remain_consistent_during_rotation";
        let mut reader = openbitfun_services_core::process_manager::create_command(&executable)
            .args(["--exact", test_name, "--nocapture"])
            .env(MODE_ENV, "reader")
            .env(ROOT_ENV, &root)
            .env(DONE_ENV, &done)
            .spawn()
            .expect("spawn stress reader");
        let writer = openbitfun_services_core::process_manager::create_command(&executable)
            .args(["--exact", test_name, "--nocapture"])
            .env(MODE_ENV, "writer")
            .env(ROOT_ENV, &root)
            .env(DONE_ENV, &done)
            .output()
            .expect("run stress writer");
        let reader_status = reader.wait().expect("wait for stress reader");
        assert!(
            writer.status.success(),
            "writer failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&writer.stdout),
            String::from_utf8_lossy(&writer.stderr)
        );
        assert!(reader_status.success(), "stress reader failed");
    }

    #[test]
    fn status_pages_are_bounded_and_continue_from_the_returned_cursor() {
        let (_dir, store) = store();
        store
            .create_job(request("job-page"), "Task".to_string())
            .expect("create job");
        for index in 0..48 {
            store
                .append_event(
                    "job-page",
                    &DispatchEvent::job_state(
                        DispatchJobState::Running,
                        Some(format!("{index}:{}", "x".repeat(64 * 1024))),
                    ),
                )
                .expect("append page event");
        }
        let first = store.read_events("job-page", 0).expect("first page");
        assert!(first.events.len() < 50);
        assert!(first.cursor <= MAX_STATUS_PAGE_BYTES);
        assert!(
            serde_json::to_vec(&first.events)
                .expect("serialize status events")
                .len()
                <= MAX_STATUS_PAGE_BYTES as usize + 1
        );
        let second = store
            .read_events("job-page", first.cursor)
            .expect("second page");
        assert!(!second.events.is_empty());
        assert!(second.cursor > first.cursor);
    }

    #[test]
    fn oversized_single_event_is_replaced_without_failing_the_job_log() {
        let (_dir, store) = store();
        store
            .create_job(request("job-large-event"), "Task".to_string())
            .expect("create job");
        let before = store
            .read_events("job-large-event", 0)
            .expect("initial events");
        store
            .append_event(
                "job-large-event",
                &DispatchEvent::job_state(
                    DispatchJobState::Running,
                    Some("x".repeat(MAX_EVENT_BYTES)),
                ),
            )
            .expect("replace oversized event");
        let page = store
            .read_events("job-large-event", before.cursor)
            .expect("oversized marker");
        assert_eq!(page.events.len(), 1);
        let DispatchEvent::Audit {
            action, details, ..
        } = &page.events[0]
        else {
            panic!("oversized event must become an audit marker");
        };
        assert_eq!(action, "eventOmitted");
        assert_eq!(details["reason"], "eventTooLarge");
        assert_eq!(details["maxBytes"], MAX_EVENT_BYTES);
    }

    #[test]
    fn missing_completeness_metadata_fails_closed() {
        let (_dir, store) = store();
        store
            .create_job(request("job-metadata"), "Task".to_string())
            .expect("create job");
        let metadata_path = store
            .job_dir("job-metadata")
            .expect("job directory")
            .join(EVENTS_METADATA_FILE);
        fs::remove_file(metadata_path).expect("remove metadata");

        let page = store.read_events("job-metadata", 0).expect("read events");
        assert!(page.history_truncated);
    }

    #[test]
    fn status_pages_cap_event_count_without_skipping_cursor_bytes() {
        let (_dir, store) = store();
        store
            .create_job(request("job-event-cap"), "Task".to_string())
            .expect("create job");
        for index in 0..1_023 {
            store
                .append_event(
                    "job-event-cap",
                    &DispatchEvent::job_state(
                        DispatchJobState::Running,
                        Some(format!("event-{index}")),
                    ),
                )
                .expect("append event");
        }

        let first = store.read_events("job-event-cap", 0).expect("first page");
        assert_eq!(first.events.len(), MAX_STATUS_PAGE_EVENTS);
        let second = store
            .read_events("job-event-cap", first.cursor)
            .expect("second page");
        assert_eq!(second.events.len(), MAX_STATUS_PAGE_EVENTS);
        let third = store
            .read_events("job-event-cap", second.cursor)
            .expect("third page");
        assert_eq!(third.events.len(), 1);
        let end = store
            .read_events("job-event-cap", third.cursor)
            .expect("end page");
        assert!(end.events.is_empty());
        assert!(first.cursor < second.cursor);
        assert!(second.cursor < third.cursor);
        assert_eq!(third.cursor, end.cursor);
        assert_eq!(
            first.events.len() + second.events.len() + third.events.len(),
            1_025,
            "the two initial events plus every appended event must be returned exactly once"
        );
    }

    #[test]
    fn default_store_honors_path_manager_storage_overrides() {
        const CHILD_ENV: &str = "OPENBITFUN_DISPATCH_PATH_TEST_CHILD";
        if let Some(expected_home) = std::env::var_os(CHILD_ENV) {
            let store = DispatchStore::open_default().expect("open isolated default store");
            assert_eq!(store.root, PathBuf::from(expected_home).join("dispatch"));
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let openbitfun_home = dir.path().join("openbitfun-home");
        let user_root = dir.path().join("user-root");
        let output = openbitfun_services_core::process_manager::create_command(
            std::env::current_exe().expect("test executable"),
        )
        .args([
            "--exact",
            "dispatch::store::tests::default_store_honors_path_manager_storage_overrides",
            "--nocapture",
        ])
        .env(CHILD_ENV, &openbitfun_home)
        .env("OPENBITFUN_HOME", &openbitfun_home)
        .env("OPENBITFUN_USER_ROOT", &user_root)
        .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
        .env_remove("OPENBITFUN_E2E_HOME")
        .env_remove("OPENBITFUN_E2E_USER_ROOT")
        .output()
        .expect("run isolated path test");
        assert!(
            output.status.success(),
            "isolated child failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(openbitfun_home.join("dispatch/jobs").is_dir());
        assert!(openbitfun_home.join("dispatch/workspaces").is_dir());
    }

    #[test]
    fn retention_removes_only_expired_terminal_jobs_and_their_managed_workspace() {
        let (_dir, store) = store();
        for job_id in ["expired", "recent", "running"] {
            store
                .create_job(request(job_id), "Task".to_string())
                .expect("create job");
            create_private_dir(&store.workspace_upload_dir(job_id).expect("workspace path"))
                .expect("create workspace");
        }

        for job_id in ["expired", "recent"] {
            store
                .mark_state(job_id, DispatchJobState::Succeeded, None, None)
                .expect("mark terminal");
        }
        let now = chrono::Utc::now();
        let mut expired = store.load_state("expired").expect("expired state");
        expired.finished_at =
            Some((now - chrono::Duration::days(TERMINAL_JOB_RETENTION_DAYS + 1)).to_rfc3339());
        atomic_write_json(
            &store.job_dir("expired").expect("job path").join(STATE_FILE),
            &expired,
        )
        .expect("age terminal state");
        let expired_digest = "a".repeat(64);
        let recent_digest = "b".repeat(64);
        for (digest, last_used_at) in [
            (
                &expired_digest,
                (now - chrono::Duration::days(REPO_CACHE_RETENTION_DAYS + 1)).to_rfc3339(),
            ),
            (&recent_digest, now.to_rfc3339()),
        ] {
            let cache_dir = store.repos_root().join(digest);
            create_private_dir(&cache_dir).expect("create cache entry");
            atomic_write_json(
                &cache_dir.join(REPO_CACHE_RECORD_FILE),
                &serde_json::json!({ "lastUsedAt": last_used_at }),
            )
            .expect("write cache record");
        }

        assert_eq!(
            store
                .collect_expired_terminal_jobs(now)
                .expect("collect expired jobs"),
            1
        );
        assert!(!store.root.join("jobs/expired").exists());
        assert!(!store.root.join("workspaces/expired").exists());
        assert!(!store
            .workspace_operation_lock_path("expired")
            .expect("operation lock path")
            .exists());
        assert!(!store
            .workspace_git_operation_lock_path("expired")
            .expect("git operation lock path")
            .exists());
        assert!(store.root.join("jobs/recent").exists());
        assert!(store.root.join("workspaces/recent").exists());
        assert!(store.root.join("jobs/running").exists());
        assert!(store.root.join("workspaces/running").exists());
        assert!(!store.repos_root().join(expired_digest).exists());
        assert!(store.repos_root().join(recent_digest).exists());
    }

    #[test]
    fn retention_skips_contended_job_without_blocking_and_retries_later() {
        let (_dir, store) = store();
        store
            .create_job(request("contended"), "Task".to_string())
            .expect("create job");
        store
            .mark_state("contended", DispatchJobState::Succeeded, None, None)
            .expect("mark terminal");
        let now = chrono::Utc::now();
        let mut expired = store.load_state("contended").expect("expired state");
        expired.finished_at =
            Some((now - chrono::Duration::days(TERMINAL_JOB_RETENTION_DAYS + 1)).to_rfc3339());
        let job_dir = store.job_dir("contended").expect("job path");
        atomic_write_json(&job_dir.join(STATE_FILE), &expired).expect("age terminal state");

        let lock = JobLock::exclusive(&job_dir.join(".lock")).expect("hold job lock");
        let collecting_store = store.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let collector = std::thread::spawn(move || {
            let result = collecting_store.collect_expired_terminal_jobs(now);
            sender.send(result).expect("send retention result");
        });
        let while_contended = receiver.recv_timeout(std::time::Duration::from_secs(1));
        drop(lock);
        collector.join().expect("join retention collector");

        assert_eq!(
            while_contended
                .expect("retention must not block on a busy job")
                .expect("skip contended job"),
            0
        );
        assert!(job_dir.exists());

        let released_lock = JobLock::try_exclusive(&job_dir.join(".lock"))
            .expect("reopen released job lock")
            .expect("job lock must be released after contention");
        drop(released_lock);

        let retry_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let removed = loop {
            let removed = store
                .collect_expired_terminal_jobs(now)
                .expect("retry expired job");
            if removed == 1 {
                break removed;
            }
            assert_eq!(removed, 0, "only the contended job may be removed");
            assert!(
                std::time::Instant::now() < retry_deadline,
                "expired job must be removed after transient Windows file contention clears"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(removed, 1);
        assert!(!job_dir.exists());
    }

    #[cfg(windows)]
    #[test]
    fn retention_retries_after_windows_sharing_violation() {
        let (_dir, store) = store();
        store
            .create_job(request("sharing-violation"), "Task".to_string())
            .expect("create job");
        store
            .mark_state("sharing-violation", DispatchJobState::Succeeded, None, None)
            .expect("mark terminal");
        let now = chrono::Utc::now();
        let mut expired = store
            .load_state("sharing-violation")
            .expect("expired state");
        expired.finished_at =
            Some((now - chrono::Duration::days(TERMINAL_JOB_RETENTION_DAYS + 1)).to_rfc3339());
        let job_dir = store.job_dir("sharing-violation").expect("job path");
        let state_path = job_dir.join(STATE_FILE);
        atomic_write_json(&state_path, &expired).expect("age terminal state");

        let open_state = File::open(&state_path).expect("hold state file open");
        assert_eq!(
            store
                .collect_expired_terminal_jobs(now)
                .expect("sharing violation must defer cleanup"),
            0
        );
        assert!(job_dir.exists());

        drop(open_state);
        assert_eq!(
            store
                .collect_expired_terminal_jobs(now)
                .expect("retry expired job"),
            1
        );
        assert!(!job_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn job_storage_uses_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, store) = store();
        store
            .create_job(request("job-private"), "Task".to_string())
            .expect("create job");
        let job_dir = store.job_dir("job-private").expect("job dir");
        assert_eq!(
            fs::metadata(&job_dir)
                .expect("job metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for file in [JOB_RECORD_FILE, STATE_FILE, EVENTS_FILE, EVENTS_LOCK_FILE] {
            assert_eq!(
                fs::metadata(job_dir.join(file))
                    .expect("file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
