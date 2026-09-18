//! Scheduled job service.

use super::schedule::{
    compute_initial_next_run_at_ms, compute_next_run_after_ms, validate_schedule,
};
use super::store::CronJobStore;
use super::types::{
    CreateCronJobRequest, CronJob, CronJobPayload, CronJobTarget, CronJobTargetKind,
    CronLaunchSpec, CronSchedule, CronWorkspaceRef, UpdateCronJobRequest, DEFAULT_RETRY_DELAY_MS,
};
use crate::agentic::coordination::{
    ConversationCoordinator, DialogQueuePriority, DialogScheduler, DialogSubmissionPolicy,
    DialogTriggerSource,
};
use crate::agentic::core::SessionConfig;
use crate::agentic::workspace::WorkspaceBinding;
use crate::infrastructure::PathManager;
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use chrono::{Local, SecondsFormat, TimeZone, Utc};
use log::{debug, info, warn};
use openbitfun_agent_runtime::scheduled_job::ScheduledJobEnqueueFailureAction;
use openbitfun_agent_runtime::sdk::AgentRuntime;
use openbitfun_runtime_ports::{AgentDialogPrependedReminder, AgentDialogTurnRequest};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::{Mutex, Notify, RwLock};
use tokio::time::Duration;
use uuid::Uuid;

static GLOBAL_CRON_SERVICE: OnceLock<Arc<CronService>> = OnceLock::new();

pub struct CronService {
    coordinator: Arc<ConversationCoordinator>,
    runtime: AgentRuntime,
    store: Arc<CronJobStore>,
    jobs: Arc<RwLock<HashMap<String, CronJob>>>,
    mutation_lock: Arc<Mutex<()>>,
    wakeup: Arc<Notify>,
    runner_started: AtomicBool,
}

impl CronService {
    pub async fn new(
        path_manager: Arc<PathManager>,
        coordinator: Arc<ConversationCoordinator>,
        scheduler: Arc<DialogScheduler>,
    ) -> OpenBitFunResult<Arc<Self>> {
        let store = Arc::new(CronJobStore::new(path_manager).await?);
        let loaded = store.load().await?;
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
        });

        if needs_save {
            service.persist_snapshot().await?;
        }

        Ok(service)
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
        tokio::spawn(async move {
            service.run_loop().await;
        });
    }

    pub async fn list_jobs(&self) -> Vec<CronJob> {
        let jobs = self.jobs.read().await;
        jobs.values().cloned().collect::<Vec<_>>()
    }

    pub async fn list_jobs_filtered(
        &self,
        workspace_id: Option<&str>,
        session_id: Option<&str>,
        target_kind: Option<CronJobTargetKind>,
    ) -> Vec<CronJob> {
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
        self.jobs.read().await.get(job_id).cloned()
    }

    pub async fn create_job(&self, request: CreateCronJobRequest) -> OpenBitFunResult<CronJob> {
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
        self.wakeup.notify_one();

        Ok(job)
    }

    pub async fn update_job(
        &self,
        job_id: &str,
        request: UpdateCronJobRequest,
    ) -> OpenBitFunResult<CronJob> {
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
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let existed = jobs.remove(job_id).is_some();
        if existed {
            self.persist_jobs_locked(&jobs).await?;
            drop(jobs);
            self.wakeup.notify_one();
        }
        Ok(existed)
    }

    /// Remove all scheduled jobs bound to the given session (e.g. after session delete).
    pub async fn delete_jobs_for_session(&self, session_id: &str) -> OpenBitFunResult<usize> {
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
            self.wakeup.notify_one();
        }
        Ok(removed)
    }

    pub async fn run_job_now(&self, job_id: &str) -> OpenBitFunResult<CronJob> {
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
        let _guard = self.mutation_lock.lock().await;
        let mut jobs = self.jobs.write().await;
        let Some(job) = jobs
            .values_mut()
            .find(|job| job.state.active_turn_id.as_deref() == Some(turn_id))
        else {
            return Ok(());
        };

        update(job, now_ms());
        self.persist_jobs_locked(&jobs).await?;
        drop(jobs);
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
        self.wakeup.notify_one();
        Ok(())
    }

    async fn persist_snapshot(&self) -> OpenBitFunResult<()> {
        let jobs = self.jobs.read().await;
        self.persist_jobs_locked(&jobs).await
    }

    async fn submit_enqueue_input(&self, enqueue_input: &EnqueueInput) -> Result<(), String> {
        let resolved = self.resolve_enqueue_submission(enqueue_input).await?;
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
                metadata: serde_json::Map::new(),
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
                "This message was triggered by a scheduled job.\nCurrent time: {}",
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

/// Permanent failure: coordinator cannot load session metadata (session deleted from disk).
fn cron_enqueue_error_is_missing_session(error: &str) -> bool {
    error.contains("Session metadata not found")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::cron::CronJobState;

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
        }
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
