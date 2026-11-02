//! Scheduled job service.

use super::schedule::{
    compute_initial_next_run_at_ms, compute_next_run_after_ms, validate_schedule,
};
use super::store::CronJobStore;
use super::types::{
    CreateCronJobRequest, CronJob, CronJobPayload, CronJobTarget, CronJobTargetKind, CronJobsFile,
    CronLaunchSpec, CronSchedule, CronWorkspaceRef, UpdateCronJobRequest, DEFAULT_RETRY_DELAY_MS,
};
use super::{CronJobsChangedEvent, CronJobsChangedReason, CRON_JOBS_CHANGED_EVENT};
use crate::agentic::coordination::scheduler::DIALOG_TURN_ID_ALREADY_SETTLED_MESSAGE;
use crate::agentic::coordination::{
    ConversationCoordinator, DialogQueuePriority, DialogScheduler, DialogSubmissionPolicy,
    DialogTriggerSource,
};
use crate::agentic::core::SessionConfig;
use crate::agentic::workspace::WorkspaceBinding;
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::infrastructure::PathManager;
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use chrono::{Local, SecondsFormat, TimeZone, Utc};
use log::{debug, error, info, warn};
use openbitfun_agent_runtime::scheduled_job::ScheduledJobEnqueueFailureAction;
use openbitfun_agent_runtime::sdk::AgentRuntime;
use openbitfun_runtime_ports::{AgentDialogPrependedReminder, AgentDialogTurnRequest};
use openbitfun_services_core::exclusive_file_lease::{ExclusiveFileLease, ExclusiveFileLeaseError};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio::time::Duration;
use uuid::Uuid;

static GLOBAL_CRON_SERVICE: OnceLock<Arc<CronService>> = OnceLock::new();

/// How long a standby instance waits before re-checking whether the scheduling
/// owner released the lease. Only a process exit releases it, so this is a
/// takeover latency bound, not a lock timeout.
const STANDBY_TAKEOVER_RETRY: Duration = Duration::from_secs(30);

pub struct CronService {
    coordinator: Arc<ConversationCoordinator>,
    runtime: AgentRuntime,
    store: Arc<CronJobStore>,
    jobs: Arc<RwLock<HashMap<String, CronJob>>>,
    mutation_lock: Arc<Mutex<()>>,
    wakeup: Arc<Notify>,
    runner_started: AtomicBool,
    /// Held by the process that schedules jobs and writes `jobs.json`.
    ///
    /// Two desktop instances share one user data directory, so without this
    /// lease both schedulers fire the same trigger, and the loser retries a
    /// turn id the winner already consumed.
    scheduling_lease: SchedulingLease,
}

impl CronService {
    pub async fn new(
        path_manager: Arc<PathManager>,
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
    ) -> OpenBitFunResult<Arc<Self>> {
        // Take the scheduling lease before touching the store: it is what makes
        // this instance the only writer of jobs.json.
        let scheduling_lease = SchedulingLease::new(path_manager.cron_scheduler_lease_file());
        if scheduling_lease.claim() {
            scheduling_lease.publish_ownership();
        }

        let store = Arc::new(CronJobStore::new(path_manager).await?);
        let (jobs, needs_save) = materialize_loaded_jobs(store.load().await?).await?;

        let runtime = CoreServiceAgentRuntime::agent_runtime_with_dialog_turns(
            coordinator.clone(),
            scheduler,
        )
        .map_err(OpenBitFunError::service)?;

        let service = Arc::new(Self {
            coordinator,
            runtime,
            store,
            jobs: Arc::new(RwLock::new(jobs)),
            mutation_lock: Arc::new(Mutex::new(())),
            wakeup: Arc::new(Notify::new()),
            runner_started: AtomicBool::new(false),
            scheduling_lease,
        });

        if !service.is_scheduling_owner() {
            warn!(
                "Another OpenBitFun instance owns scheduled jobs; this instance runs as standby and only reads them: lease={}",
                service.scheduling_lease.path().display()
            );
        }

        if needs_save {
            if service.is_scheduling_owner() {
                service.persist_snapshot().await?;
            } else {
                // Writing here would clobber state the owner is advancing.
                warn!(
                    "Deferring scheduled job store upgrade to the owning instance: lease={}",
                    service.scheduling_lease.path().display()
                );
            }
        }

        Ok(service)
    }

    /// Whether this instance schedules jobs and owns `jobs.json`.
    ///
    /// Standby instances reject job changes and read the store from disk so
    /// they never report state the owner has already replaced.
    pub fn is_scheduling_owner(&self) -> bool {
        self.scheduling_lease.is_owned()
    }

    pub fn start(self: &Arc<Self>) {
        if self
            .runner_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let service = Arc::clone(self);
        if service.is_scheduling_owner() {
            tokio::spawn(async move {
                service.run_loop().await;
            });
            return;
        }
        tokio::spawn(async move {
            service.run_standby_loop().await;
        });
    }

    fn require_scheduling_owner(&self, operation: &str) -> OpenBitFunResult<()> {
        self.scheduling_lease.require_owned(operation)
    }

    /// Waits for the owner's lease so this instance can take over scheduling.
    async fn run_standby_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(STANDBY_TAKEOVER_RETRY).await;
            match self.try_take_over_scheduling().await {
                Ok(true) => {
                    self.run_loop().await;
                    return;
                }
                Ok(false) => {}
                Err(error) => {
                    warn!("Failed to take over scheduled job scheduling: {}", error);
                }
            }
        }
    }

    async fn try_take_over_scheduling(&self) -> OpenBitFunResult<bool> {
        if !self.scheduling_lease.claim() {
            return Ok(false);
        }
        if self.is_scheduling_owner() {
            return Ok(true);
        }

        // The previous owner advanced job state while this instance was standby,
        // so adopt the store before scheduling from it. Ownership stays
        // unpublished until the adoption is in memory, and standby callers are
        // refused during that window instead of writing a stale map.
        let (jobs, needs_save) = self.load_jobs_from_store().await?;
        *self.jobs.write().await = jobs;
        self.scheduling_lease.publish_ownership();
        if needs_save {
            self.persist_snapshot().await?;
        }
        self.notify_jobs_changed(CronJobsChangedReason::StateChanged, None)
            .await;
        info!(
            "Scheduled job scheduler took ownership from a released lease: lease={}",
            self.scheduling_lease.path().display()
        );
        Ok(true)
    }

    async fn load_jobs_from_store(&self) -> OpenBitFunResult<(HashMap<String, CronJob>, bool)> {
        materialize_loaded_jobs(self.store.load().await?).await
    }

    /// Standby readers see the owner's current state instead of their own
    /// snapshot from startup. Owner reads stay on the in-memory map, which is
    /// authoritative while it holds the lease.
    async fn refresh_from_store_when_standby(&self) {
        if self.is_scheduling_owner() {
            return;
        }
        match self.load_jobs_from_store().await {
            Ok((jobs, _)) => {
                *self.jobs.write().await = jobs;
            }
            Err(error) => {
                warn!(
                    "Failed to read scheduled jobs from the owning instance's store: {}",
                    error
                );
            }
        }
    }

    pub async fn list_jobs(&self) -> Vec<CronJob> {
        self.refresh_from_store_when_standby().await;
        let jobs = self.jobs.read().await;
        jobs.values().cloned().collect::<Vec<_>>()
    }

    /// Broadcast a job-set change hint to product surfaces.
    ///
    /// The event bus is created later than this service during startup, so an
    /// early emit is a no-op; surfaces still bootstrap their lists with an
    /// explicit `list_cron_jobs` fetch.
    async fn notify_jobs_changed(&self, reason: CronJobsChangedReason, job_id: Option<String>) {
        let payload = match serde_json::to_value(CronJobsChangedEvent { reason, job_id }) {
            Ok(payload) => payload,
            Err(error) => {
                warn!("Failed to serialize scheduled job change event: {}", error);
                return;
            }
        };
        if let Err(error) = emit_global_event(BackendEvent::Custom {
            event_name: CRON_JOBS_CHANGED_EVENT.to_string(),
            payload,
        })
        .await
        {
            warn!("Failed to emit scheduled job change event: {}", error);
        }
    }

    pub async fn list_jobs_filtered(
        &self,
        workspace_id: Option<&str>,
        session_id: Option<&str>,
        target_kind: Option<CronJobTargetKind>,
    ) -> Vec<CronJob> {
        self.refresh_from_store_when_standby().await;
        let jobs = self.jobs.read().await;
        jobs.values()
            .filter(|job| {
                let workspace_matches = matches_workspace_filter(job.workspace(), workspace_id);
                let session_matches = session_id
                    .map(|session_id| job.session_id() == Some(session_id))
                    .unwrap_or(true);
                let target_matches = target_kind
                    .map(|target_kind| job.target_kind() == target_kind)
                    .unwrap_or(true);
                workspace_matches && session_matches && target_matches
            })
            .cloned()
            .collect::<Vec<_>>()
    }

    pub async fn get_job(&self, job_id: &str) -> Option<CronJob> {
        self.refresh_from_store_when_standby().await;
        self.jobs.read().await.get(job_id).cloned()
    }

    pub async fn create_job(&self, request: CreateCronJobRequest) -> OpenBitFunResult<CronJob> {
        self.require_scheduling_owner("creating a scheduled job")?;
        let target = self.canonicalize_target(request.target).await?;
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let current_ms = now_ms();
        let schedule = materialize_schedule(request.schedule, current_ms);

        validate_request_fields(&request.name, &request.payload, &target)?;
        validate_schedule(&schedule, current_ms)?;

        let mut job = CronJob {
            id: generate_cron_job_id(&jobs),
            name: request.name.trim().to_string(),
            schedule,
            payload: request.payload,
            report_policy: request.report_policy,
            enabled: request.enabled,
            target,
            created_at_ms: current_ms,
            config_updated_at_ms: current_ms,
            updated_at_ms: current_ms,
            state: Default::default(),
        };

        if job.enabled {
            job.state.next_run_at_ms = compute_initial_next_run_at_ms(&job, current_ms)?;
        }

        jobs.insert(job.id.clone(), job.clone());

        self.persist_jobs_locked(&jobs).await?;
        drop(jobs);
        self.notify_jobs_changed(CronJobsChangedReason::Created, Some(job.id.clone()))
            .await;
        self.wakeup.notify_one();

        Ok(job)
    }

    pub async fn update_job(
        &self,
        job_id: &str,
        request: UpdateCronJobRequest,
    ) -> OpenBitFunResult<CronJob> {
        self.require_scheduling_owner("updating a scheduled job")?;
        let canonicalized_target = match request.target {
            Some(target) => Some(self.canonicalize_target(target).await?),
            None => None,
        };

        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let current_ms = now_ms();
        let job = jobs.get_mut(job_id).ok_or_else(|| {
            OpenBitFunError::NotFound(format!("Scheduled job not found: {}", job_id))
        })?;
        let previous_schedule = job.schedule.clone();
        let was_enabled = job.enabled;

        if let Some(name) = request.name {
            job.name = name.trim().to_string();
        }
        if let Some(payload) = request.payload {
            job.payload = payload;
        }
        if let Some(policy) = request.report_policy {
            job.report_policy = policy;
        }
        if let Some(target) = canonicalized_target {
            job.target = target;
        }
        if let Some(enabled) = request.enabled {
            job.enabled = enabled;
        }
        if let Some(schedule) = request.schedule {
            job.schedule = materialize_schedule(schedule, current_ms);
        }
        let schedule_changed = job.schedule != previous_schedule;
        let reenabled = !was_enabled && job.enabled;

        validate_request_fields(&job.name, &job.payload, &job.target)?;
        validate_schedule(&job.schedule, job.created_at_ms)?;

        job.config_updated_at_ms = current_ms;
        job.updated_at_ms = current_ms;
        job.state.clear_pending_trigger();

        if !job.enabled {
            job.state.next_run_at_ms = None;
        } else {
            job.state.next_run_at_ms =
                compute_next_run_after_update(job, current_ms, schedule_changed, reenabled)?;
        }

        let updated = job.clone();
        self.persist_jobs_locked(&jobs).await?;
        drop(jobs);
        self.notify_jobs_changed(CronJobsChangedReason::Updated, Some(updated.id.clone()))
            .await;
        self.wakeup.notify_one();

        Ok(updated)
    }

    pub async fn set_job_enabled(&self, job_id: &str, enabled: bool) -> OpenBitFunResult<CronJob> {
        self.update_job(
            job_id,
            UpdateCronJobRequest {
                enabled: Some(enabled),
                ..Default::default()
            },
        )
        .await
    }

    pub async fn delete_job(&self, job_id: &str) -> OpenBitFunResult<bool> {
        self.require_scheduling_owner("deleting a scheduled job")?;
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let existed = jobs.remove(job_id).is_some();
        if existed {
            self.persist_jobs_locked(&jobs).await?;
            drop(jobs);
            self.notify_jobs_changed(CronJobsChangedReason::Deleted, Some(job_id.to_string()))
                .await;
            self.wakeup.notify_one();
        }
        Ok(existed)
    }

    /// Remove all scheduled jobs bound to the given session (e.g. after session delete).
    pub async fn delete_jobs_for_session(&self, session_id: &str) -> OpenBitFunResult<usize> {
        self.require_scheduling_owner("deleting scheduled jobs of a session")?;
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Ok(0);
        }
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let before = jobs.len();
        jobs.retain(|_, job| job.session_id() != Some(session_id));
        let removed = before - jobs.len();
        if removed > 0 {
            self.persist_jobs_locked(&jobs).await?;
            drop(jobs);
            self.notify_jobs_changed(CronJobsChangedReason::Deleted, None)
                .await;
            self.wakeup.notify_one();
        }
        Ok(removed)
    }

    pub async fn run_job_now(&self, job_id: &str) -> OpenBitFunResult<CronJob> {
        self.require_scheduling_owner("running a scheduled job now")?;
        {
            let _guard = self.mutation_lock.lock().await;
            let mut jobs = self.jobs.write().await;
            let current_ms = now_ms();
            let job = jobs.get_mut(job_id).ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Scheduled job not found: {}", job_id))
            })?;

            job.state.mark_manual_trigger(current_ms);
            job.updated_at_ms = current_ms;

            self.persist_jobs_locked(&jobs).await?;
            drop(jobs);
            self.notify_jobs_changed(
                CronJobsChangedReason::StateChanged,
                Some(job_id.to_string()),
            )
            .await;
            self.wakeup.notify_one();
        }

        self.process_job(job_id).await?;
        self.get_job(job_id).await.ok_or_else(|| {
            OpenBitFunError::NotFound(format!("Scheduled job not found after run: {}", job_id))
        })
    }

    pub async fn handle_turn_started(&self, turn_id: &str) -> OpenBitFunResult<()> {
        self.handle_turn_state_change(turn_id, |job, now_ms| {
            job.state.mark_turn_started(now_ms);
            job.updated_at_ms = now_ms;
        })
        .await
    }

    pub async fn handle_turn_completed(
        &self,
        turn_id: &str,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        self.handle_turn_state_change(turn_id, |job, now_ms| {
            job.state.mark_turn_completed(now_ms, duration_ms);
            job.updated_at_ms = now_ms;
        })
        .await
    }

    pub async fn handle_turn_failed(&self, turn_id: &str, error: &str) -> OpenBitFunResult<()> {
        self.handle_turn_state_change(turn_id, |job, now_ms| {
            job.state.mark_turn_failed(now_ms, error.to_string());
            job.updated_at_ms = now_ms;
        })
        .await
    }

    pub async fn handle_turn_cancelled(&self, turn_id: &str) -> OpenBitFunResult<()> {
        self.handle_turn_state_change(turn_id, |job, now_ms| {
            job.state.mark_turn_cancelled(now_ms);
            job.updated_at_ms = now_ms;
        })
        .await
    }

    async fn handle_turn_state_change<F>(&self, turn_id: &str, update: F) -> OpenBitFunResult<()>
    where
        F: FnOnce(&mut CronJob, i64),
    {
        if !self.is_scheduling_owner() {
            // Turn lifecycle events reach every instance, but only the owner
            // tracks job state; writing here would race the owner's store.
            debug!(
                "Ignoring scheduled job turn state change while standby: turn_id={}",
                turn_id
            );
            return Ok(());
        }
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let Some(job_id) = jobs
            .values_mut()
            .find(|job| job.state.active_turn_id.as_deref() == Some(turn_id))
            .map(|job| {
                update(job, now_ms());
                job.id.clone()
            })
        else {
            return Ok(());
        };

        self.persist_jobs_locked(&jobs).await?;
        drop(jobs);
        self.notify_jobs_changed(CronJobsChangedReason::StateChanged, Some(job_id))
            .await;
        self.wakeup.notify_one();
        Ok(())
    }

    async fn run_loop(self: Arc<Self>) {
        info!("Cron service loop started");

        loop {
            match self.next_wakeup_at().await {
                Some(next_wakeup_ms) => {
                    let current_ms = now_ms();
                    if next_wakeup_ms > current_ms {
                        let sleep_ms = (next_wakeup_ms - current_ms) as u64;
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(sleep_ms)) => {}
                            _ = self.wakeup.notified() => {
                                continue;
                            }
                        }
                    }
                }
                None => {
                    self.wakeup.notified().await;
                    continue;
                }
            }

            if let Err(error) = self.process_due_jobs().await {
                warn!("Failed to process due scheduled jobs: {}", error);
                tokio::time::sleep(Duration::from_millis(1_000)).await;
            }
        }
    }

    async fn next_wakeup_at(&self) -> Option<i64> {
        let jobs = self.jobs.read().await;
        jobs.values().filter_map(next_wakeup_for_job).min()
    }

    async fn process_due_jobs(&self) -> OpenBitFunResult<()> {
        let current_ms = now_ms();
        let due_job_ids = {
            let jobs = self.jobs.read().await;
            let mut due = jobs
                .values()
                .filter_map(|job| {
                    let wake_at = next_wakeup_for_job(job)?;
                    (wake_at <= current_ms).then(|| (job.id.clone(), wake_at))
                })
                .collect::<Vec<_>>();
            due.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
            due.into_iter()
                .map(|(job_id, _)| job_id)
                .collect::<Vec<_>>()
        };

        for job_id in due_job_ids {
            self.process_job(&job_id).await?;
        }

        Ok(())
    }

    async fn process_job(&self, job_id: &str) -> OpenBitFunResult<()> {
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let current_ms = now_ms();

        let mut should_persist = false;
        let mut should_attempt_enqueue = false;
        let mut scheduled_at_ms = None;
        let mut enqueue_input = None;

        {
            let Some(job) = jobs.get_mut(job_id) else {
                return Ok(());
            };

            if !job.enabled && job.state.pending_trigger_at_ms.is_none() {
                return Ok(());
            }

            if let Some(next_run_at_ms) = job.state.next_run_at_ms {
                if next_run_at_ms <= current_ms {
                    let next_run_after_ms =
                        compute_next_run_after_ms(&job.schedule, job.created_at_ms, current_ms)?;
                    job.state
                        .apply_due_scheduled_trigger(next_run_at_ms, next_run_after_ms);
                    job.updated_at_ms = current_ms;
                    should_persist = true;
                }
            }

            if job.state.active_turn_id.is_none() && job.state.pending_is_due(current_ms) {
                let pending_trigger_at_ms = job.state.pending_trigger_at_ms.ok_or_else(|| {
                    OpenBitFunError::service(format!(
                        "Scheduled job {} is missing pending trigger timestamp",
                        job.id
                    ))
                })?;

                let turn_id = format!("cronjob_{}_{}", job.id, pending_trigger_at_ms);
                scheduled_at_ms = Some(pending_trigger_at_ms);
                let (user_input, prepended_messages) =
                    format_scheduled_job_user_input(&job.payload.text, current_ms);
                enqueue_input = Some(EnqueueInput {
                    job_id: job.id.clone(),
                    job_name: job.name.clone(),
                    turn_id,
                    target: job.target.clone(),
                    user_input,
                    prepended_messages,
                    report_policy: job.report_policy.clone(),
                });
                should_attempt_enqueue = true;
            }
        }

        if should_persist {
            self.persist_jobs_locked(&jobs).await?;
        }

        if !should_attempt_enqueue {
            return Ok(());
        }

        let enqueue_input = enqueue_input.ok_or_else(|| {
            OpenBitFunError::service(format!(
                "Scheduled job {} is missing enqueue input after due calculation",
                job_id
            ))
        })?;
        let scheduled_at_ms = scheduled_at_ms.ok_or_else(|| {
            OpenBitFunError::service(format!(
                "Scheduled job {} is missing scheduled timestamp after due calculation",
                job_id
            ))
        })?;

        let submit_result = self.submit_enqueue_input(&enqueue_input).await;

        let now_after_submit = now_ms();
        let Some(job) = jobs.get_mut(job_id) else {
            return Ok(());
        };

        match submit_result {
            Ok(_) => {
                let one_shot = job.is_one_shot();
                job.state
                    .mark_enqueued(enqueue_input.turn_id.clone(), now_after_submit, one_shot);
                job.updated_at_ms = now_after_submit;

                if one_shot {
                    job.enabled = false;
                }

                debug!(
                    "Scheduled job enqueued: job_id={}, target_kind={:?}, target_session_id={}, scheduled_at_ms={}",
                    job.id,
                    job.target_kind(),
                    submit_target_session_id(&enqueue_input),
                    scheduled_at_ms
                );
            }
            Err(error) if cron_enqueue_error_is_turn_already_settled(&error) => {
                job.state.mark_trigger_delivered_elsewhere(now_after_submit);
                job.updated_at_ms = now_after_submit;

                if job.is_one_shot() {
                    job.enabled = false;
                }

                info!(
                    "Scheduled job trigger was already delivered by another owner: job_id={}, target_kind={:?}, target_session_id={}, scheduled_at_ms={}",
                    job.id,
                    job.target_kind(),
                    submit_target_session_id(&enqueue_input),
                    scheduled_at_ms
                );
            }
            Err(error) => {
                let missing_session = matches!(job.target_kind(), CronJobTargetKind::Session)
                    && cron_enqueue_error_is_missing_session(&error);
                let failure_action = job.state.mark_enqueue_failed(
                    now_after_submit,
                    error.clone(),
                    DEFAULT_RETRY_DELAY_MS,
                    missing_session,
                );
                job.updated_at_ms = now_after_submit;

                if matches!(
                    failure_action,
                    ScheduledJobEnqueueFailureAction::DisableMissingSession
                ) {
                    job.enabled = false;
                    info!(
                        "Scheduled job auto-disabled (session no longer exists): job_id={}, session_id={}",
                        job.id,
                        submit_target_session_id(&enqueue_input)
                    );
                } else {
                    warn!(
                        "Failed to enqueue scheduled job: job_id={}, target_kind={:?}, target_session_id={}, error={}",
                        job.id,
                        job.target_kind(),
                        submit_target_session_id(&enqueue_input),
                        error
                    );
                }
            }
        }

        self.persist_jobs_locked(&jobs).await?;
        drop(jobs);
        self.notify_jobs_changed(
            CronJobsChangedReason::StateChanged,
            Some(job_id.to_string()),
        )
        .await;
        self.wakeup.notify_one();
        Ok(())
    }

    async fn persist_snapshot(&self) -> OpenBitFunResult<()> {
        let jobs = self.jobs.read().await;
        self.persist_jobs_locked(&jobs).await
    }

    async fn submit_enqueue_input(&self, enqueue_input: &EnqueueInput) -> Result<(), String> {
        let resolved = self.resolve_enqueue_submission(enqueue_input).await?;
        let delivery = openbitfun_core_types::background_delivery::BackgroundDelivery::pending(
            enqueue_input.job_id.clone(),
            enqueue_input.turn_id.clone(),
            enqueue_input.report_policy.clone(),
        );
        let metadata = serde_json::Map::from_iter([(
            openbitfun_core_types::background_delivery::BACKGROUND_DELIVERY_METADATA_KEY.to_owned(),
            serde_json::to_value(delivery).map_err(|error| error.to_string())?,
        )]);
        self.runtime
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: resolved.session_id,
                message: enqueue_input.user_input.clone(),
                output_schema: None,
                original_message: Some(enqueue_input.user_input.clone()),
                turn_id: Some(enqueue_input.turn_id.clone()),
                execution: Default::default(),
                agent_type: resolved.agent_type,
                workspace_path: Some(resolved.workspace_path),
                workspace_id: resolved.workspace_id,
                remote_connection_id: resolved.remote_connection_id,
                remote_ssh_host: resolved.remote_ssh_host,
                policy: scheduled_job_policy(),
                reply_route: None,
                prepended_reminders: enqueue_input.prepended_messages.clone(),
                attachments: Vec::new(),
                metadata,
            })
            .await
            .map_err(CoreServiceAgentRuntime::runtime_error_message)
            .map(|_| ())
    }

    async fn resolve_enqueue_submission(
        &self,
        enqueue_input: &EnqueueInput,
    ) -> Result<ResolvedEnqueueSubmission, String> {
        let target = self
            .canonicalize_target(enqueue_input.target.clone())
            .await
            .map_err(|error| error.to_string())?;
        match &target {
            CronJobTarget::Session {
                session_id,
                workspace,
            } => {
                let agent_type = self
                    .coordinator
                    .get_session_manager()
                    .get_session(session_id)
                    .map(|session| session.agent_type)
                    .unwrap_or_default();
                Ok(ResolvedEnqueueSubmission {
                    session_id: session_id.clone(),
                    workspace_id: workspace.workspace_id.clone(),
                    workspace_path: workspace.workspace_path.clone(),
                    remote_connection_id: workspace.remote_connection_id.clone(),
                    remote_ssh_host: workspace.remote_ssh_host.clone(),
                    agent_type,
                })
            }
            CronJobTarget::Workspace { workspace, launch } => {
                let created = self
                    .coordinator
                    .create_session_with_workspace(
                        None,
                        format!("Scheduled: {}", enqueue_input.job_name.trim()),
                        launch.agent_type.clone(),
                        SessionConfig {
                            tool_presentation_mode: Default::default(),
                            workspace_path: Some(workspace.workspace_path.clone()),
                            project_workspace_path: workspace.project_workspace_path.clone(),
                            execution_target: workspace.execution_target.clone(),
                            workspace_id: workspace.workspace_id.clone(),
                            remote_connection_id: workspace.remote_connection_id.clone(),
                            remote_ssh_host: workspace.remote_ssh_host.clone(),
                            model_id: launch.model_id.clone(),
                            ..Default::default()
                        },
                        workspace.workspace_path.clone(),
                    )
                    .await
                    .map_err(|error| {
                        format!(
                            "Failed to create session for scheduled job {}: {}",
                            enqueue_input.job_id, error
                        )
                    })?;

                Ok(ResolvedEnqueueSubmission {
                    session_id: created.session_id,
                    workspace_id: workspace.workspace_id.clone(),
                    workspace_path: workspace.workspace_path.clone(),
                    remote_connection_id: workspace.remote_connection_id.clone(),
                    remote_ssh_host: workspace.remote_ssh_host.clone(),
                    agent_type: created.agent_type,
                })
            }
        }
    }

    async fn canonicalize_target(&self, target: CronJobTarget) -> OpenBitFunResult<CronJobTarget> {
        let mut target = materialize_target(target);

        if let CronJobTarget::Session {
            session_id,
            workspace,
        } = &mut target
        {
            *workspace =
                Self::resolve_session_target_workspace_ref(&self.coordinator, session_id).await?;
        } else {
            // The only path reader is the temporary persisted/wire upgrade adapter.
            target = crate::service::workspace::legacy_compat::upgrade_legacy_cron_target(target)
                .await?;
            if let CronJobTarget::Workspace { workspace, .. } = &mut target {
                let id = workspace.workspace_id.as_deref().ok_or_else(|| {
                    OpenBitFunError::validation("Scheduled job workspace ID is required")
                })?;
                *workspace = workspace_ref_from_binding(&WorkspaceBinding::resolve(id).await?);
            }
        }

        Ok(target)
    }

    async fn resolve_session_target_workspace_ref(
        coordinator: &ConversationCoordinator,
        session_id: &str,
    ) -> OpenBitFunResult<CronWorkspaceRef> {
        let binding = coordinator
            .get_session_manager()
            .resolve_session_workspace_binding(session_id)
            .await
            .ok_or_else(|| {
                OpenBitFunError::validation(format!(
                    "Unable to resolve workspace for session '{}'",
                    session_id
                ))
            })?;

        Ok(workspace_ref_from_binding(&binding))
    }

    async fn persist_jobs_locked(&self, jobs: &HashMap<String, CronJob>) -> OpenBitFunResult<()> {
        self.store
            .save_jobs(jobs.values().cloned().collect::<Vec<_>>())
            .await
    }
}

pub fn get_global_cron_service() -> Option<Arc<CronService>> {
    GLOBAL_CRON_SERVICE.get().cloned()
}

pub fn set_global_cron_service(service: Arc<CronService>) {
    let _ = GLOBAL_CRON_SERVICE.set(service);
}

/// Process-local view of the cross-process lease that decides which instance
/// schedules jobs and writes `jobs.json`.
///
/// The lease is held until the process exits; dropping it releases the OS lock
/// so a standby instance can take over.
struct SchedulingLease {
    path: PathBuf,
    lease: std::sync::Mutex<Option<ExclusiveFileLease>>,
    owned: AtomicBool,
}

impl SchedulingLease {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            lease: std::sync::Mutex::new(None),
            owned: AtomicBool::new(false),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn is_owned(&self) -> bool {
        self.owned.load(Ordering::SeqCst)
    }

    /// Takes the cross-process lease without publishing ownership, so the
    /// caller can adopt the store it protects first. `false` means another
    /// process holds it and this instance stays standby.
    ///
    /// A lease that cannot be created at all fails open: scheduled jobs keep
    /// working exactly as they did before the lease existed, instead of a
    /// product feature going silently dead because one lock file is
    /// unavailable. That case stays loud in the log and leaves the
    /// multi-instance hazard in place.
    fn claim(&self) -> bool {
        if self.is_owned() {
            return true;
        }
        match ExclusiveFileLease::try_acquire(&self.path) {
            Ok(lease) => {
                *self
                    .lease
                    .lock()
                    .expect("Scheduled job lease slot poisoned") = Some(lease);
                true
            }
            Err(ExclusiveFileLeaseError::InUse) => false,
            Err(error) => {
                error!(
                    "Failed to acquire the scheduled job lease {}; scheduling without cross-instance protection: {}",
                    self.path.display(),
                    error
                );
                true
            }
        }
    }

    fn publish_ownership(&self) {
        self.owned.store(true, Ordering::SeqCst);
    }

    fn require_owned(&self, operation: &str) -> OpenBitFunResult<()> {
        if self.is_owned() {
            return Ok(());
        }
        Err(OpenBitFunError::service(format!(
            "Scheduled jobs are managed by the other running OpenBitFun instance (lease: {}); {} was refused here instead of overwriting its state",
            self.path.display(),
            operation
        )))
    }
}

/// Turns the persisted file into the in-memory job map, applying the one-time
/// target upgrade and the startup reconciliation. The returned flag reports
/// whether the result differs from what is on disk.
async fn materialize_loaded_jobs(
    loaded: CronJobsFile,
) -> OpenBitFunResult<(HashMap<String, CronJob>, bool)> {
    let current_ms = now_ms();
    let mut jobs = HashMap::new();
    let mut needs_save = false;

    for mut job in loaded.jobs {
        if jobs.contains_key(&job.id) {
            return Err(OpenBitFunError::service(format!(
                "Duplicate scheduled job id found in jobs.json: {}",
                job.id
            )));
        }

        // Upgrade persisted pre-ID targets once. Unavailable/ambiguous records
        // stay on disk and fail explicitly when executed, never select a folder.
        let old_target = job.target.clone();
        match crate::service::workspace::legacy_compat::upgrade_legacy_cron_target(
            job.target.clone(),
        )
        .await
        {
            Ok(target) => job.target = target,
            Err(error) => warn!(
                "Unable to upgrade scheduled job workspace: job_id={}, error={}",
                job.id, error
            ),
        }
        needs_save |= job.target != old_target;
        needs_save |= reconcile_loaded_job(&mut job, current_ms)?;
        jobs.insert(job.id.clone(), job);
    }

    Ok((jobs, needs_save))
}

fn reconcile_loaded_job(job: &mut CronJob, now_ms: i64) -> OpenBitFunResult<bool> {
    let original = job.clone();

    job.target = materialize_target(job.target.clone());
    validate_request_fields(&job.name, &job.payload, &job.target)?;
    validate_schedule(&job.schedule, job.created_at_ms)?;

    if job.updated_at_ms < job.created_at_ms {
        job.updated_at_ms = job.created_at_ms;
    }

    if let CronSchedule::Every { anchor_ms, .. } = &mut job.schedule {
        if anchor_ms.is_none() {
            *anchor_ms = Some(job.created_at_ms);
        }
    }

    if job.state.recover_interrupted_turn_after_restart(
        now_ms,
        "Application restarted before the scheduled job finished".to_string(),
    ) {
        job.updated_at_ms = now_ms;
    }

    if !job.enabled {
        job.state.mark_disabled();
    } else if job.state.pending_trigger_at_ms.is_some() {
        job.state.ensure_pending_retry_at(now_ms);
    } else if job.state.next_run_at_ms.is_none() {
        job.state.next_run_at_ms = compute_initial_next_run_at_ms(job, now_ms)?;
    }

    Ok(job != &original)
}

fn validate_request_fields(
    name: &str,
    payload: &CronJobPayload,
    target: &CronJobTarget,
) -> OpenBitFunResult<()> {
    if name.trim().is_empty() {
        return Err(OpenBitFunError::validation(
            "Scheduled job name must not be empty",
        ));
    }
    if payload.text.trim().is_empty() {
        return Err(OpenBitFunError::validation(
            "Scheduled job payload.text must not be empty",
        ));
    }

    validate_target(target)?;

    Ok(())
}

fn materialize_schedule(schedule: CronSchedule, anchor_ms: i64) -> CronSchedule {
    match schedule {
        CronSchedule::Every {
            every_ms,
            anchor_ms: None,
        } => CronSchedule::Every {
            every_ms,
            anchor_ms: Some(anchor_ms),
        },
        other => other,
    }
}

fn compute_next_run_after_update(
    job: &CronJob,
    current_ms: i64,
    schedule_changed: bool,
    reenabled: bool,
) -> OpenBitFunResult<Option<i64>> {
    if schedule_changed || reenabled {
        return compute_next_run_after_ms(&job.schedule, job.created_at_ms, current_ms);
    }

    if job.state.active_turn_id.is_some() {
        if job.is_one_shot() {
            Ok(None)
        } else {
            compute_next_run_after_ms(&job.schedule, job.created_at_ms, current_ms)
        }
    } else {
        compute_initial_next_run_at_ms(job, current_ms)
    }
}

fn materialize_target(target: CronJobTarget) -> CronJobTarget {
    match target {
        CronJobTarget::Session {
            session_id,
            workspace,
        } => CronJobTarget::Session {
            session_id: session_id.trim().to_string(),
            workspace: materialize_workspace_ref(workspace),
        },
        CronJobTarget::Workspace { workspace, launch } => CronJobTarget::Workspace {
            workspace: materialize_workspace_ref(workspace),
            launch: materialize_launch_spec(launch),
        },
    }
}

fn materialize_workspace_ref(workspace: CronWorkspaceRef) -> CronWorkspaceRef {
    CronWorkspaceRef {
        workspace_id: workspace
            .workspace_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        workspace_path: normalize_workspace_io_path(&workspace.workspace_path),
        project_workspace_path: workspace
            .project_workspace_path
            .map(|value| normalize_workspace_io_path(&value))
            .filter(|value| !value.is_empty()),
        execution_target: workspace.execution_target,
        remote_connection_id: workspace
            .remote_connection_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        remote_ssh_host: workspace
            .remote_ssh_host
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    }
}

fn workspace_ref_from_binding(binding: &WorkspaceBinding) -> CronWorkspaceRef {
    CronWorkspaceRef {
        workspace_id: binding.workspace_id.clone(),
        workspace_path: normalize_workspace_io_path(&binding.root_path_string()),
        project_workspace_path: Some(normalize_workspace_io_path(
            &binding.project_root_path_string(),
        )),
        execution_target: binding.execution_target.clone(),
        remote_connection_id: binding.connection_id().map(ToOwned::to_owned),
        remote_ssh_host: if binding.is_remote() {
            Some(binding.session_identity.hostname.clone()).filter(|value| !value.trim().is_empty())
        } else {
            None
        },
    }
}

fn materialize_launch_spec(launch: CronLaunchSpec) -> CronLaunchSpec {
    CronLaunchSpec {
        agent_type: normalize_agent_type(&launch.agent_type),
        model_id: launch
            .model_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    }
}

fn normalize_agent_type(agent_type: &str) -> String {
    if agent_type.trim().is_empty() {
        "Standard".to_string()
    } else {
        agent_type.trim().to_string()
    }
}

fn validate_target(target: &CronJobTarget) -> OpenBitFunResult<()> {
    validate_workspace_ref(target.workspace())?;

    match target {
        CronJobTarget::Session { session_id, .. } => {
            if session_id.trim().is_empty() {
                return Err(OpenBitFunError::validation(
                    "Scheduled job sessionId must not be empty",
                ));
            }
        }
        CronJobTarget::Workspace { launch, .. } => {
            if launch.agent_type.trim().is_empty() {
                return Err(OpenBitFunError::validation(
                    "Scheduled job launch.agentType must not be empty",
                ));
            }
        }
    }

    Ok(())
}

fn validate_workspace_ref(workspace: &CronWorkspaceRef) -> OpenBitFunResult<()> {
    if workspace.workspace_path.trim().is_empty() {
        return Err(OpenBitFunError::validation(
            "Scheduled job workspacePath must not be empty",
        ));
    }
    Ok(())
}

fn matches_workspace_filter(workspace: &CronWorkspaceRef, workspace_id: Option<&str>) -> bool {
    workspace_id
        .map(|id| workspace.workspace_id.as_deref() == Some(id))
        .unwrap_or(true)
}

fn normalize_workspace_io_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");

    if normalized.starts_with("file://") {
        normalized = normalized.trim_start_matches("file://").to_string();
    }

    if normalized.len() >= 4
        && normalized.starts_with('/')
        && normalized.as_bytes()[2] == b':'
        && normalized.as_bytes()[1].is_ascii_alphabetic()
    {
        normalized = normalized.trim_start_matches('/').to_string();
    }

    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }

    if normalized.len() >= 2
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[0].is_ascii_alphabetic()
    {
        normalized = format!(
            "{}{}",
            normalized[..1].to_ascii_uppercase(),
            &normalized[1..]
        );
    }

    if normalized != "/" && !is_windows_drive_root(&normalized) {
        normalized = normalized.trim_end_matches('/').to_string();
    }

    normalized
}

fn is_windows_drive_root(path: &str) -> bool {
    path.len() == 3
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[2] == b'/'
        && path.as_bytes()[0].is_ascii_alphabetic()
}

fn next_wakeup_for_job(job: &CronJob) -> Option<i64> {
    job.state.next_wakeup_at_ms()
}

fn format_scheduled_job_user_input(
    payload: &str,
    current_ms: i64,
) -> (String, Vec<AgentDialogPrependedReminder>) {
    let current_time = Local
        .timestamp_millis_opt(current_ms)
        .single()
        .map(|datetime| datetime.to_rfc3339_opts(SecondsFormat::Secs, false))
        .unwrap_or_else(|| current_ms.to_string());

    (
        payload.to_string(),
        vec![AgentDialogPrependedReminder {
            kind: "scheduled_job".to_string(),
            text: format!(
                "This message was triggered by a scheduled job.\nCurrent time: {}\nAfter completing the work, use Cron action=report with report={{disposition: quiet|report|attention, reason: a brief explanation}} to declare whether this run should be delivered. Quiet is allowed only when the task's instructions permit withholding a report and no reporting condition was met. This records a delivery proposal; it does not run or end a task. Extra final text is still saved in the execution record. If Cron is deferred, load its specification first.",
                current_time
            ),
        }],
    )
}

fn scheduled_job_policy() -> DialogSubmissionPolicy {
    DialogSubmissionPolicy::new(DialogTriggerSource::ScheduledJob, DialogQueuePriority::Low)
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn generate_cron_job_id(jobs: &HashMap<String, CronJob>) -> String {
    loop {
        let uuid = Uuid::new_v4().simple().to_string();
        let id = format!("cron_{}", &uuid[..8]);
        if !jobs.contains_key(&id) {
            return id;
        }
    }
}

struct EnqueueInput {
    job_id: String,
    job_name: String,
    turn_id: String,
    target: CronJobTarget,
    user_input: String,
    prepended_messages: Vec<AgentDialogPrependedReminder>,
    report_policy: openbitfun_core_types::background_delivery::BackgroundReportPolicy,
}

struct ResolvedEnqueueSubmission {
    session_id: String,
    workspace_id: Option<String>,
    workspace_path: String,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
    agent_type: String,
}

fn submit_target_session_id(enqueue_input: &EnqueueInput) -> &str {
    match &enqueue_input.target {
        CronJobTarget::Session { session_id, .. } => session_id.as_str(),
        CronJobTarget::Workspace { .. } => "<new-session>",
    }
}

/// The trigger's dialog turn already exists, so this trigger was delivered by
/// another owner instead of failing.
///
/// The trigger's turn ID is derived from its scheduled timestamp, so every retry
/// for the same trigger is rejected the same way; retrying can never succeed.
fn cron_enqueue_error_is_turn_already_settled(error: &str) -> bool {
    error.contains(DIALOG_TURN_ID_ALREADY_SETTLED_MESSAGE)
}

/// Permanent failure: coordinator cannot load session metadata (session deleted from disk).
fn cron_enqueue_error_is_missing_session(error: &str) -> bool {
    error.contains("Session metadata not found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::cron::{CronJobState, CRON_JOBS_VERSION};

    fn sample_job(schedule: CronSchedule) -> CronJob {
        CronJob {
            id: "cron_test".to_string(),
            name: "test".to_string(),
            schedule,
            payload: CronJobPayload {
                text: "hello".to_string(),
            },
            enabled: true,
            target: CronJobTarget::Session {
                session_id: "session_1".to_string(),
                workspace: CronWorkspaceRef {
                    workspace_id: None,
                    workspace_path: "E:/workspace".to_string(),
                    project_workspace_path: None,
                    execution_target: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                },
            },
            created_at_ms: 0,
            config_updated_at_ms: 0,
            updated_at_ms: 0,
            state: CronJobState::default(),
            report_policy: Default::default(),
        }
    }

    #[test]
    fn enqueue_failure_classifies_already_delivered_trigger() {
        assert!(cron_enqueue_error_is_turn_already_settled(&format!(
            "{}: session_id=session_1, turn_id=cronjob_cron_test_1000",
            DIALOG_TURN_ID_ALREADY_SETTLED_MESSAGE
        )));
        assert!(!cron_enqueue_error_is_turn_already_settled(
            "Session is already open for writing: session_1"
        ));
        assert!(!cron_enqueue_error_is_turn_already_settled(
            "Session metadata not found"
        ));
    }

    #[tokio::test]
    async fn loaded_jobs_are_rewritten_when_they_gain_their_first_anchor() {
        let mut job = sample_job(CronSchedule::Every {
            every_ms: 60_000,
            anchor_ms: None,
        });
        // An id-carrying workspace needs no legacy upgrade, so the pending save
        // can only come from the anchor reconciliation.
        if let CronJobTarget::Session { workspace, .. } = &mut job.target {
            workspace.workspace_id = Some("workspace_1".to_string());
        }

        let (jobs, needs_save) = materialize_loaded_jobs(CronJobsFile {
            version: CRON_JOBS_VERSION,
            jobs: vec![job],
        })
        .await
        .expect("load");

        assert_eq!(jobs.len(), 1);
        assert!(
            needs_save,
            "a job that gains its first schedule anchor must be written back"
        );
    }

    #[tokio::test]
    async fn loaded_jobs_reject_duplicate_ids_before_scheduling() {
        let mut job = sample_job(CronSchedule::Every {
            every_ms: 60_000,
            anchor_ms: Some(0),
        });
        if let CronJobTarget::Session { workspace, .. } = &mut job.target {
            workspace.workspace_id = Some("workspace_1".to_string());
        }

        let error = materialize_loaded_jobs(CronJobsFile {
            version: CRON_JOBS_VERSION,
            jobs: vec![job.clone(), job],
        })
        .await
        .expect_err("duplicate ids must be rejected");

        assert!(error.to_string().contains("Duplicate scheduled job id"));
    }

    #[test]
    fn a_second_lease_on_the_same_path_stays_standby_and_refuses_writes() {
        let project_root = tempfile::tempdir().expect("project root");
        let lease_path = project_root.path().join("cron").join("scheduler.lock");

        let owner = SchedulingLease::new(lease_path.clone());
        assert!(owner.claim(), "first claim");
        owner.publish_ownership();
        assert!(owner.is_owned());

        let standby = SchedulingLease::new(lease_path.clone());
        assert!(!standby.claim(), "the lease is held elsewhere");
        assert!(!standby.is_owned());

        let error = standby
            .require_owned("updating a scheduled job")
            .expect_err("standby must refuse job changes");
        assert!(error.to_string().contains("managed by the other running"));
        assert!(error.to_string().contains("scheduler.lock"));

        // The leaseless owner stays able to act on its own store.
        owner
            .require_owned("updating a scheduled job")
            .expect("owner may write");
    }

    #[test]
    fn dropping_the_owner_releases_the_lease_for_takeover() {
        let project_root = tempfile::tempdir().expect("project root");
        let lease_path = project_root.path().join("cron").join("scheduler.lock");

        let owner = SchedulingLease::new(lease_path.clone());
        assert!(owner.claim(), "first claim");
        owner.publish_ownership();
        drop(owner);

        let standby = SchedulingLease::new(lease_path);
        assert!(
            standby.claim(),
            "a released lease must be claimable for takeover"
        );
        assert!(!standby.is_owned(), "ownership needs an explicit publish");
        standby.publish_ownership();
        assert!(standby.is_owned());
    }

    #[test]
    fn an_unusable_lease_path_fails_open_instead_of_disabling_scheduling() {
        let project_root = tempfile::tempdir().expect("project root");
        // A regular file where the lease directory should be makes the lease
        // impossible to create, which is not the same as "someone else holds it".
        let blocking_file = project_root.path().join("cron");
        std::fs::write(&blocking_file, b"not a directory").expect("blocking file");

        let lease = SchedulingLease::new(blocking_file.join("scheduler.lock"));

        assert!(
            lease.claim(),
            "an unusable lease must keep the pre-lease scheduling behavior"
        );
    }

    #[test]
    fn generate_cron_job_id_uses_short_hex_suffix() {
        let jobs = HashMap::new();
        let id = generate_cron_job_id(&jobs);

        assert_eq!(id.len(), "cron_".len() + 8);
        assert!(id.starts_with("cron_"));
        assert!(id["cron_".len()..]
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()));
    }

    #[test]
    fn materialize_workspace_ref_normalizes_windows_style_paths() {
        let workspace = materialize_workspace_ref(CronWorkspaceRef {
            workspace_id: None,
            workspace_path: r"c:\Users\wsp\.openbitfun\personal_assistant\workspace\".to_string(),
            project_workspace_path: None,
            execution_target: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        });

        assert_eq!(
            workspace.workspace_path,
            "C:/Users/wsp/.openbitfun/personal_assistant/workspace"
        );
    }

    #[test]
    fn workspace_filter_uses_id_even_when_paths_differ() {
        let workspace = CronWorkspaceRef {
            workspace_id: Some("local_workspace".to_string()),
            workspace_path: r"C:\Users\wsp\.openbitfun\personal_assistant\workspace".to_string(),
            project_workspace_path: None,
            execution_target: None,
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        assert!(matches_workspace_filter(
            &workspace,
            Some("local_workspace")
        ));
        assert!(!matches_workspace_filter(
            &workspace,
            Some("another-workspace")
        ));
    }

    #[test]
    fn workspace_filter_never_matches_an_unmigrated_record_by_path() {
        let workspace = CronWorkspaceRef {
            workspace_id: None,
            workspace_path: "/home/wsp/projects/test/".to_string(),
            project_workspace_path: None,
            execution_target: None,
            remote_connection_id: Some("ssh-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };

        assert!(!matches_workspace_filter(
            &workspace,
            Some("remote-workspace")
        ));
        assert!(matches_workspace_filter(&workspace, None));
    }

    #[test]
    fn changed_at_schedule_rearms_consumed_one_shot_only_for_future_time() {
        let mut job = sample_job(CronSchedule::At {
            at: "1970-01-01T00:00:03Z".to_string(),
        });
        job.state.last_enqueued_at_ms = Some(1_500);

        let future_next =
            compute_next_run_after_update(&job, 2_000, true, false).expect("future next run");
        assert_eq!(future_next, Some(3_000));

        job.schedule = CronSchedule::At {
            at: "1970-01-01T00:00:01Z".to_string(),
        };
        let past_next =
            compute_next_run_after_update(&job, 2_000, true, false).expect("past next run");
        assert_eq!(past_next, None);
    }

    #[test]
    fn reenabled_at_schedule_rearms_consumed_one_shot_only_for_future_time() {
        let mut job = sample_job(CronSchedule::At {
            at: "1970-01-01T00:00:03Z".to_string(),
        });
        job.state.last_enqueued_at_ms = Some(1_500);

        let future_next =
            compute_next_run_after_update(&job, 2_000, false, true).expect("future next run");
        assert_eq!(future_next, Some(3_000));

        job.schedule = CronSchedule::At {
            at: "1970-01-01T00:00:01Z".to_string(),
        };
        let past_next =
            compute_next_run_after_update(&job, 2_000, false, true).expect("past next run");
        assert_eq!(past_next, None);
    }

    #[test]
    fn unchanged_at_schedule_keeps_initial_catchup_semantics() {
        let job = sample_job(CronSchedule::At {
            at: "1970-01-01T00:00:01Z".to_string(),
        });

        let next =
            compute_next_run_after_update(&job, 2_000, false, false).expect("initial next run");
        assert_eq!(next, Some(1_000));
    }

    #[test]
    fn unchanged_consumed_at_schedule_stays_completed() {
        let mut job = sample_job(CronSchedule::At {
            at: "1970-01-01T00:00:03Z".to_string(),
        });
        job.state.last_enqueued_at_ms = Some(1_500);

        let next =
            compute_next_run_after_update(&job, 2_000, false, false).expect("completed next run");
        assert_eq!(next, None);
    }
}
