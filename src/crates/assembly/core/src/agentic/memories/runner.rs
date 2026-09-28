use crate::agentic::coordination::{
    get_global_coordinator, InternalAgentExecutionRequest, SubagentResultStatus,
};
use crate::agentic::memories::db::{
    MemoryDatabase, MemoryPhase2CandidateRow, MemoryPhase2ClaimOutcome, MemoryPhase2SelectionRow,
    MEMORY_PHASE2_GLOBAL_JOB_KEY,
};
use crate::agentic::memories::transcript::redact_memory_secrets;
use crate::agentic::memories::workspace::{
    memory_workspace_diff, memory_workspace_has_input_artifacts, prepare_memory_workspace,
    reset_memory_workspace_baseline, sync_phase2_workspace_inputs, write_workspace_diff,
    MemoryWorkspaceDiff, AD_HOC_EXTENSION_NAME, AD_HOC_INSTRUCTIONS_FILE_NAME,
    MEMORY_EXTENSIONS_DIR_NAME, MEMORY_FILE_NAME, MEMORY_SUMMARY_FILE_NAME,
    PHASE2_WORKSPACE_DIFF_FILE_NAME, RAW_MEMORIES_FILENAME, ROLLOUT_SUMMARIES_DIR_NAME,
    SKILLS_DIR_NAME,
};
use crate::agentic::persistence::PersistenceManager;
use crate::agentic::tools::{ToolPathPolicy, ToolRuntimeRestrictions};
use crate::agentic::SessionKind;
use crate::infrastructure::get_path_manager_arc;
use crate::service::config::get_global_config_service;
use crate::service::session::SessionMemoryMode;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use log::{debug, info, warn};
use openbitfun_agent_runtime::permission::PERMISSION_MODE_CONTEXT_KEY;
use openbitfun_runtime_ports::PermissionMode;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;
use uuid::Uuid;

const PHASE2_JOB_KEY: &str = MEMORY_PHASE2_GLOBAL_JOB_KEY;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Phase2RunReport {
    pub selected_count: usize,
    pub candidate_count: usize,
    pub input_watermark: i64,
    pub input_bytes: usize,
    pub duration_ms: u128,
    pub consolidation_output: String,
}

/// Outcome of one consolidation turn.
///
/// `completed` separates "the agent finished its consolidation" from "the agent
/// returned something, but the turn did not finish cleanly" (for example a
/// partial timeout). Only a completed turn may advance the pipeline: a turn that
/// stopped mid-way left a half-applied workspace and a partly consumed diff, so
/// the runner keeps the baseline and the pending input for the next pass.
#[derive(Debug, Clone, PartialEq, Eq)]
struct MemoryPhase2ConsolidationOutcome {
    output: String,
    completed: bool,
    reason: Option<String>,
}

impl MemoryPhase2ConsolidationOutcome {
    fn completed(output: String) -> Self {
        Self {
            output,
            completed: true,
            reason: None,
        }
    }

    /// Marker used in `Phase2RunReport::consolidation_output` so a caller can see
    /// that the run happened but the consolidation itself did not finish.
    const INCOMPLETE_OUTPUT_PREFIX: &'static str = "[consolidation-incomplete]";

    fn into_run_output(self) -> String {
        if self.completed {
            return self.output;
        }
        match self.reason {
            Some(reason) => format!(
                "{} {}: {}",
                Self::INCOMPLETE_OUTPUT_PREFIX,
                reason,
                self.output
            ),
            None => format!("{} {}", Self::INCOMPLETE_OUTPUT_PREFIX, self.output),
        }
    }
}

impl From<String> for MemoryPhase2ConsolidationOutcome {
    fn from(output: String) -> Self {
        Self::completed(output)
    }
}

#[async_trait]
trait MemoryPhase2Consolidator: Send + Sync {
    async fn consolidate(
        &self,
        memory_root: &std::path::Path,
        model_id: Option<String>,
    ) -> OpenBitFunResult<MemoryPhase2ConsolidationOutcome>;
}

struct InternalAgentMemoryPhase2Consolidator;

#[async_trait]
impl MemoryPhase2Consolidator for InternalAgentMemoryPhase2Consolidator {
    async fn consolidate(
        &self,
        memory_root: &std::path::Path,
        model_id: Option<String>,
    ) -> OpenBitFunResult<MemoryPhase2ConsolidationOutcome> {
        let coordinator = get_global_coordinator().ok_or_else(|| {
            OpenBitFunError::service(
                "Memory phase2 consolidation requires an initialized agent coordinator".to_string(),
            )
        })?;
        let task_description = build_phase2_user_prompt(memory_root);
        info!(
            "Memory phase2 internal agent request prepared: workspace_root={}, model_id={:?}, task_description=\n{}",
            memory_root.display(),
            model_id,
            task_description
        );
        let workspace_service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| OpenBitFunError::service("Workspace service is unavailable"))?;
        // Explicitly register the internal execution folder. Once registered,
        // internal Agent requests carry its ID and never infer SSH from a path.
        let workspace = workspace_service
            .track_workspace_activity(
                memory_root.to_path_buf(),
                crate::service::workspace::WorkspaceCreateOptions {
                    add_to_recent: false,
                    auto_set_current: false,
                    ..Default::default()
                },
                crate::service::workspace::WorkspaceActivityMode::TouchOnly,
            )
            .await?;
        let request = memory_phase2_internal_agent_request(
            workspace.id,
            memory_root,
            model_id.clone(),
            task_description,
        );
        let started_at = std::time::Instant::now();
        let result = coordinator
            .execute_internal_agent(request, None, Some(20 * 60))
            .await?;
        let completed = result.status == SubagentResultStatus::Completed;
        if !completed {
            // A wedged consolidation must not look like a clean run: the caller
            // resets the workspace baseline on success, which would hide a
            // half-finished update from the next run's diff.
            warn!(
                "Memory phase2 internal agent did not complete: workspace_root={}, status={:?}, reason={:?}, duration_ms={}",
                memory_root.display(),
                result.status,
                result.reason,
                started_at.elapsed().as_millis()
            );
        }
        info!(
            "Memory phase2 internal agent raw response: workspace_root={}, model_id={:?}, output_bytes={}, duration_ms={}, raw_response=\n{}",
            memory_root.display(),
            model_id,
            result.text.len(),
            started_at.elapsed().as_millis(),
            redact_memory_secrets(&result.text)
        );
        Ok(MemoryPhase2ConsolidationOutcome {
            output: result.text,
            completed,
            reason: if completed {
                None
            } else {
                Some(match result.reason {
                    Some(reason) => format!("{:?}: {}", result.status, reason),
                    None => format!("{:?}", result.status),
                })
            },
        })
    }
}

/// Builds the request for the internal consolidation turn.
///
/// The consolidation session is an ephemeral child whose lifecycle events are not
/// emitted, so no surface is asked for approval and none can answer an interactive
/// permission prompt. An in-root `Write` that raised an ask would therefore block
/// the turn forever and keep the global phase-2 job `running` until its lease
/// expired. The turn runs in auto-approve mode, which answers asks without a
/// prompt; the tool allowlist and the workspace path roots still bound what the
/// agent may touch.
fn memory_phase2_internal_agent_request(
    workspace_id: String,
    memory_root: &std::path::Path,
    model_id: Option<String>,
    task_description: String,
) -> InternalAgentExecutionRequest {
    let context = HashMap::from([(
        PERMISSION_MODE_CONTEXT_KEY.to_string(),
        PermissionMode::AutoApprove.as_str().to_string(),
    )]);
    InternalAgentExecutionRequest {
        task_description,
        agent_type: "MemoryPhase2".to_string(),
        session_name: "Memory Phase 2 Consolidation".to_string(),
        workspace_id,
        model_id,
        created_by: Some("memory-phase2".to_string()),
        context,
        delegation_policy: openbitfun_runtime_ports::DelegationPolicy::top_level().spawn_child(),
        runtime_tool_restrictions: memory_phase2_tool_restrictions(memory_root),
        session_kind: SessionKind::EphemeralChild,
        emit_lifecycle_events: false,
    }
}

struct Phase2HeartbeatTask {
    handle: JoinHandle<()>,
}

impl Phase2HeartbeatTask {
    fn start(db: Arc<MemoryDatabase>, ownership_token: String) -> Self {
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let now = current_unix_secs();
                match db
                    .touch_phase2_job_heartbeat(
                        PHASE2_JOB_KEY,
                        &ownership_token,
                        now,
                        phase2_lease_seconds().await.unwrap_or(60 * 60),
                    )
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        warn!("Memory phase2 heartbeat stopped because ownership was lost");
                        break;
                    }
                    Err(error) => {
                        warn!("Memory phase2 heartbeat update failed: {}", error);
                    }
                }
            }
        });
        Self { handle }
    }
}

impl Drop for Phase2HeartbeatTask {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

#[derive(Clone)]
pub struct MemoryPhase2Runner {
    db: Arc<MemoryDatabase>,
    persistence: Arc<PersistenceManager>,
    memory_root: std::path::PathBuf,
    consolidator: Arc<dyn MemoryPhase2Consolidator>,
}

impl MemoryPhase2Runner {
    pub async fn new() -> OpenBitFunResult<Self> {
        let path_manager = get_path_manager_arc();
        let db = Arc::new(MemoryDatabase::new(path_manager.clone()));
        db.initialize().await?;
        let persistence = Arc::new(PersistenceManager::new(path_manager)?);
        Ok(Self {
            memory_root: get_path_manager_arc().memories_root_dir(),
            db,
            persistence,
            consolidator: Arc::new(InternalAgentMemoryPhase2Consolidator),
        })
    }

    pub fn with_memory_root_for_tests(
        db: Arc<MemoryDatabase>,
        memory_root: std::path::PathBuf,
    ) -> Self {
        let persistence = Arc::new(
            PersistenceManager::new(get_path_manager_arc()).expect("test persistence manager"),
        );
        Self {
            db,
            persistence,
            memory_root,
            consolidator: Arc::new(InternalAgentMemoryPhase2Consolidator),
        }
    }

    #[cfg(test)]
    fn with_memory_root_and_consolidator_for_tests(
        db: Arc<MemoryDatabase>,
        persistence: Arc<PersistenceManager>,
        memory_root: std::path::PathBuf,
        consolidator: Arc<dyn MemoryPhase2Consolidator>,
    ) -> Self {
        Self {
            db,
            persistence,
            memory_root,
            consolidator,
        }
    }

    pub async fn run_once(&self) -> OpenBitFunResult<Option<Phase2RunReport>> {
        let config = get_phase2_runtime_config().await;
        self.run_once_with_config(config).await
    }

    async fn run_once_with_config(
        &self,
        config: crate::service::config::types::GlobalConfig,
    ) -> OpenBitFunResult<Option<Phase2RunReport>> {
        let started_at = std::time::Instant::now();
        let success_cooldown_seconds = config
            .memories
            .phase2_success_cooldown_seconds
            .clamp(0, 7 * 24 * 60 * 60);
        info!(
            "Memory phase2 run started: generate_memories={}, limit={}, max_unused_days={}, phase2_lease_seconds={}, phase2_success_cooldown_seconds={}, phase2_retry_delay_seconds={}, memory_root={}",
            config.memories.generate_memories,
            config.memories.max_raw_memories_for_consolidation.clamp(1, 4096),
            config.memories.max_unused_days.clamp(1, 365),
            config.memories.phase2_lease_seconds.clamp(60, 24 * 60 * 60),
            success_cooldown_seconds,
            config.memories.phase2_retry_delay_seconds.clamp(60, 24 * 60 * 60),
            self.memory_root.display()
        );
        if !config.memories.generate_memories {
            info!("Memory phase2 run skipped because generate_memories is disabled");
            return Ok(None);
        }

        // The retry backoff is a hard gate: it protects a failing consolidation
        // from being retried in a tight loop.
        let job_before = self.db.get_phase2_job(PHASE2_JOB_KEY).await?;
        if let Some(job) = job_before.as_ref() {
            let now = current_unix_secs();
            if job.retry_at_unix_secs.is_some_and(|until| until > now) {
                info!(
                    "Memory phase2 run skipped by retry backoff: retry_after_unix_secs={:?}, now={}",
                    job.retry_at_unix_secs, now
                );
                return Ok(None);
            }
        }
        // The success cooldown is evaluated later, after the cheap input and
        // workspace checks, so it only ever protects a truly no-op run.
        let cooldown_until = job_before.as_ref().and_then(|job| {
            crate::agentic::memories::db::phase2_success_cooldown_until_unix_secs(
                job,
                success_cooldown_seconds,
            )
        });
        // `input_watermark` is this job's evaluated-input clock: the newest stage-1
        // candidate the pipeline has already accounted for, whether that happened
        // through a consolidation or through a run that found nothing to do. It also
        // advances when a session-memory state change requests a run, which is why
        // freshness is compared against it instead of the last consolidation
        // watermark: a candidate that is newer but never selected must not be able to
        // keep the success cooldown disarmed forever.
        let previous_input_watermark = job_before
            .as_ref()
            .and_then(|job| job.input_watermark)
            .unwrap_or_default();

        let ownership_token = Uuid::new_v4().to_string();
        match self.claim_phase2_job(&ownership_token).await? {
            MemoryPhase2ClaimOutcome::Claimed => {
                info!(
                    "Memory phase2 job claimed: job_key={}, ownership_token={}",
                    PHASE2_JOB_KEY, ownership_token
                );
            }
            outcome => {
                info!("Memory phase2 job claim skipped: outcome={:?}", outcome);
                return Ok(None);
            }
        }
        let _heartbeat = Phase2HeartbeatTask::start(self.db.clone(), ownership_token.clone());

        if let Err(error) = prepare_memory_workspace(&self.memory_root).await {
            let _ = self
                .complete_phase2_job_failure(&ownership_token, error.to_string())
                .await;
            warn!(
                "Memory phase2 workspace preparation failed: memory_root={}, error={}",
                self.memory_root.display(),
                error
            );
            return Err(error);
        }
        info!(
            "Memory phase2 workspace prepared: memory_root={}",
            self.memory_root.display()
        );

        let limit = config
            .memories
            .max_raw_memories_for_consolidation
            .clamp(1, 4096);
        let candidate_scan_limit = 4096;
        let max_unused_days = config.memories.max_unused_days.clamp(1, 365);
        let candidate_rows = self
            .db
            .list_phase2_input_candidates(candidate_scan_limit, max_unused_days)
            .await?;
        info!(
            "Memory phase2 input candidates loaded: candidate_count={}, candidate_scan_limit={}, max_unused_days={}",
            candidate_rows.len(),
            candidate_scan_limit,
            max_unused_days
        );
        for row in &candidate_rows {
            debug!(
                "Memory phase2 input candidate: session_id={}, workspace_path={}, source_updated_at={}, usage_count={}, last_usage={:?}, selected_for_phase2={}, raw_memory_bytes={}, rollout_summary_bytes={}",
                row.session_id,
                row.workspace_path,
                row.source_updated_at_unix_secs,
                row.usage_count,
                row.last_usage_unix_secs,
                row.selected_for_phase2,
                row.raw_memory.len(),
                row.rollout_summary.len()
            );
        }
        let has_candidate_rows = !candidate_rows.is_empty();
        let candidate_input_watermark = candidate_rows
            .iter()
            .map(|row| row.source_updated_at_unix_secs)
            .max()
            .unwrap_or_default();
        let has_new_input = candidate_input_watermark > previous_input_watermark;
        // Every completed run records the newest candidate it evaluated, so a
        // candidate that stays unselected cannot keep this run's freshness signal
        // alive for the next one.
        let evaluated_input_watermark = previous_input_watermark.max(candidate_input_watermark);
        info!(
            "Memory phase2 input freshness evaluated: candidate_count={}, has_new_input={}, candidate_input_watermark={}, evaluated_input_watermark={}",
            candidate_rows.len(),
            has_new_input,
            candidate_input_watermark,
            evaluated_input_watermark
        );
        if !has_candidate_rows {
            info!(
                "Memory phase2 found no stage1 candidates; checking workspace diff for extension changes: limit={}, max_unused_days={}",
                limit, max_unused_days
            );
        }

        let selected = if has_candidate_rows {
            self.select_enabled_rows(&candidate_rows, limit).await?
        } else {
            Vec::new()
        };
        info!(
            "Memory phase2 candidates selected: selected_count={}, limit={}, selected_session_ids={}",
            selected.len(),
            limit,
            selected
                .iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>()
                .join(",")
        );
        let selected_memory_rows = self.rows_to_memory_rows(&selected);
        let input_bytes = selected_memory_rows
            .iter()
            .map(|row| row.raw_memory.len() + row.rollout_summary.len())
            .sum::<usize>();
        let selected_ids = selected
            .iter()
            .map(|row| row.session_id.clone())
            .collect::<Vec<_>>();

        // The workspace input is rebuilt whenever it can be derived at all. An empty
        // enabled-selection still has to drop deselected rows from `raw_memories.md`
        // so the removal shows up in this run's diff and the consolidation agent
        // forgets the content in the same run; a workspace that holds nothing has
        // nothing to rebuild. Rollout summaries are safe to prune against because
        // the keep-set is every live stage-1 row, not the selection.
        let live_summary_identities = self.db.list_live_rollout_summary_identities().await?;
        let workspace_holds_input_artifacts =
            memory_workspace_has_input_artifacts(&self.memory_root).await;
        let rebuilds_workspace_inputs = !selected.is_empty() || workspace_holds_input_artifacts;
        if rebuilds_workspace_inputs {
            if let Err(error) = sync_phase2_workspace_inputs(
                &self.memory_root,
                &selected_memory_rows,
                &live_summary_identities,
            )
            .await
            {
                let _ = self
                    .complete_phase2_job_failure(&ownership_token, error.to_string())
                    .await;
                warn!(
                    "Memory phase2 input sync failed: memory_root={}, selected_count={}, error={}",
                    self.memory_root.display(),
                    selected_memory_rows.len(),
                    error
                );
                return Err(OpenBitFunError::io(format!(
                    "Failed to sync phase2 workspace inputs: {}",
                    error
                )));
            }
            info!(
                "Memory phase2 inputs synced: memory_root={}, selected_count={}, candidate_count={}, input_bytes={}, live_summary_count={}",
                self.memory_root.display(),
                selected_memory_rows.len(),
                candidate_rows.len(),
                input_bytes,
                live_summary_identities.len()
            );
        }

        let workspace_diff = match memory_workspace_diff(&self.memory_root).await {
            Ok(diff) => diff,
            Err(error) => {
                let _ = self
                    .complete_phase2_job_failure(&ownership_token, error.to_string())
                    .await;
                warn!(
                    "Memory phase2 workspace diff failed: memory_root={}, error={}",
                    self.memory_root.display(),
                    error
                );
                return Err(error);
            }
        };
        let has_meaningful_changes = workspace_diff_has_meaningful_changes(&workspace_diff);
        info!(
            "Memory phase2 workspace diff computed: memory_root={}, has_changes={}, change_count={}, has_meaningful_changes={}",
            self.memory_root.display(),
            workspace_diff.has_changes(),
            workspace_diff.changes.len(),
            has_meaningful_changes
        );
        for change in &workspace_diff.changes {
            debug!(
                "Memory phase2 workspace diff entry: path={}, status={:?}",
                change.path, change.status
            );
        }

        // The success cooldown only protects a run that has nothing to do: no new
        // stage-1 input and no meaningful workspace change.
        if cooldown_until.is_some_and(|until| until > current_unix_secs())
            && !has_new_input
            && !has_meaningful_changes
        {
            let selection = MemoryPhase2SelectionRow {
                job_key: PHASE2_JOB_KEY.to_string(),
                input_watermark: evaluated_input_watermark,
            };
            self.confirm_phase2_job_completion(
                self.complete_phase2_job_idle(&ownership_token, &selection)
                    .await?,
            )?;
            info!(
                "Memory phase2 run skipped by success cooldown: cooldown_until_unix_secs={:?}, has_new_input={}, meaningful_changes={}, candidate_count={}, duration_ms={}",
                cooldown_until,
                has_new_input,
                has_meaningful_changes,
                candidate_rows.len(),
                started_at.elapsed().as_millis()
            );
            return Ok(None);
        }

        let selection = match self
            .db
            .upsert_phase2_selection(PHASE2_JOB_KEY, &selected)
            .await?
        {
            Some(selection) => {
                info!(
                    "Memory phase2 selection persisted: input_watermark={}",
                    selection.input_watermark
                );
                selection
            }
            None => {
                // Empty selection. No candidate is marked selected in this run, and the
                // workspace input was still rebuilt above, so deselected rows drop out
                // of `raw_memories.md` and the removal reaches the consolidation agent
                // through this run's diff.
                info!(
                    "Memory phase2 selection was empty: candidate_count={}, meaningful_changes={}, input_rebuilt={}",
                    candidate_rows.len(),
                    has_meaningful_changes,
                    rebuilds_workspace_inputs
                );
                if !has_meaningful_changes {
                    if workspace_diff.has_changes() {
                        self.confirm_phase2_job_ownership(&ownership_token).await?;
                        if let Err(error) = reset_memory_workspace_baseline(&self.memory_root).await
                        {
                            let _ = self
                                .complete_phase2_job_failure(&ownership_token, error.to_string())
                                .await;
                            return Err(error);
                        }
                        self.prune_prompt_artifacts().await?;
                        info!(
                            "Memory phase2 baseline updated for seeded extension instructions without consolidation: duration_ms={}",
                            started_at.elapsed().as_millis()
                        );
                    }
                    let idle_selection = MemoryPhase2SelectionRow {
                        job_key: PHASE2_JOB_KEY.to_string(),
                        input_watermark: evaluated_input_watermark,
                    };
                    self.confirm_phase2_job_completion(
                        self.complete_phase2_job_idle(&ownership_token, &idle_selection)
                            .await?,
                    )?;
                    info!(
                        "Memory phase2 run stopped because selection was empty: candidate_count={}, duration_ms={}",
                        candidate_rows.len(),
                        started_at.elapsed().as_millis()
                    );
                    return Ok(None);
                }
                MemoryPhase2SelectionRow {
                    job_key: PHASE2_JOB_KEY.to_string(),
                    input_watermark: evaluated_input_watermark,
                }
            }
        };
        // Completion always records the evaluated input clock, so the next run compares
        // its candidates against input this pipeline has already looked at.
        let completion_selection = MemoryPhase2SelectionRow {
            job_key: selection.job_key.clone(),
            input_watermark: selection.input_watermark.max(evaluated_input_watermark),
        };

        if !has_meaningful_changes {
            if workspace_diff.has_changes() {
                self.confirm_phase2_job_ownership(&ownership_token).await?;
                if let Err(error) = reset_memory_workspace_baseline(&self.memory_root).await {
                    let _ = self
                        .complete_phase2_job_failure(&ownership_token, error.to_string())
                        .await;
                    return Err(error);
                }
                self.prune_prompt_artifacts().await?;
                info!(
                    "Memory phase2 baseline updated for non-meaningful workspace changes without consolidation: duration_ms={}",
                    started_at.elapsed().as_millis()
                );
            }
            self.confirm_phase2_job_completion(
                self.complete_phase2_job_success(&ownership_token, &completion_selection)
                    .await?,
            )?;
            if !selected_ids.is_empty() {
                self.db
                    .mark_phase2_candidates_selected(&selected_ids, selection.input_watermark)
                    .await?;
            }
            let duration_ms = started_at.elapsed().as_millis();
            info!(
                "Memory phase2 run completed without workspace changes: candidate_count={}, selected_count={}, input_bytes={}, watermark={}, duration_ms={}",
                candidate_rows.len(),
                selected.len(),
                input_bytes,
                completion_selection.input_watermark,
                duration_ms
            );
            return Ok(Some(Phase2RunReport {
                selected_count: selected.len(),
                candidate_count: candidate_rows.len(),
                input_watermark: completion_selection.input_watermark,
                input_bytes,
                duration_ms,
                consolidation_output: "No memory workspace changes to consolidate.".to_string(),
            }));
        }

        if let Err(error) = write_workspace_diff(&self.memory_root, &workspace_diff).await {
            let _ = self
                .complete_phase2_job_failure(&ownership_token, error.to_string())
                .await;
            warn!(
                "Memory phase2 workspace diff write failed: memory_root={}, error={}",
                self.memory_root.display(),
                error
            );
            return Err(error);
        }
        info!(
            "Memory phase2 workspace diff written: memory_root={}, change_count={}",
            self.memory_root.display(),
            workspace_diff.changes.len()
        );

        let consolidation = match self.run_consolidation_agent().await {
            Ok(outcome) => outcome,
            Err(error) => {
                let _ = self
                    .complete_phase2_job_failure(&ownership_token, error.to_string())
                    .await;
                warn!(
                    "Memory phase2 consolidation agent failed: memory_root={}, error={}",
                    self.memory_root.display(),
                    error
                );
                return Err(error);
            }
        };
        info!(
            "Memory phase2 consolidation agent returned: output_bytes={}, turn_completed={}",
            consolidation.output.len(),
            consolidation.completed
        );

        if !consolidation.completed {
            // The turn stopped mid-way, so its workspace edits are only partly
            // applied and the diff it was given is only partly consumed. Do not
            // reset the baseline and do not mark the candidates selected: the
            // retained diff keeps counting as a meaningful change, so the next
            // pass re-offers exactly the same input instead of dropping it behind
            // an advanced evaluated watermark.
            self.confirm_phase2_job_completion(
                self.complete_phase2_job_idle(&ownership_token, &completion_selection)
                    .await?,
            )?;
            let duration_ms = started_at.elapsed().as_millis();
            warn!(
                "Memory phase2 consolidation did not complete; keeping the workspace baseline and the pending input for the next run: reason={:?}, candidate_count={}, selected_count={}, input_bytes={}, watermark={}, duration_ms={}",
                consolidation.reason,
                candidate_rows.len(),
                selected.len(),
                input_bytes,
                completion_selection.input_watermark,
                duration_ms
            );
            return Ok(Some(Phase2RunReport {
                selected_count: selected.len(),
                candidate_count: candidate_rows.len(),
                input_watermark: completion_selection.input_watermark,
                input_bytes,
                duration_ms,
                consolidation_output: consolidation.into_run_output(),
            }));
        }

        let consolidation_output = consolidation.output;

        self.confirm_phase2_job_ownership(&ownership_token).await?;
        if let Err(error) = reset_memory_workspace_baseline(&self.memory_root).await {
            let _ = self
                .complete_phase2_job_failure(&ownership_token, error.to_string())
                .await;
            warn!(
                "Memory phase2 workspace baseline reset failed: memory_root={}, error={}",
                self.memory_root.display(),
                error
            );
            return Err(error);
        }
        info!(
            "Memory phase2 workspace baseline reset: memory_root={}",
            self.memory_root.display()
        );
        self.prune_prompt_artifacts().await?;

        self.confirm_phase2_job_completion(
            self.complete_phase2_job_success(&ownership_token, &completion_selection)
                .await?,
        )?;
        if !selected_ids.is_empty() {
            self.db
                .mark_phase2_candidates_selected(&selected_ids, selection.input_watermark)
                .await?;
        }
        let duration_ms = started_at.elapsed().as_millis();
        info!(
            "Memory phase2 run completed: candidate_count={}, selected_count={}, input_bytes={}, watermark={}, duration_ms={}",
            candidate_rows.len(),
            selected.len(),
            input_bytes,
            completion_selection.input_watermark,
            duration_ms
        );
        Ok(Some(Phase2RunReport {
            selected_count: selected.len(),
            candidate_count: candidate_rows.len(),
            input_watermark: completion_selection.input_watermark,
            input_bytes,
            duration_ms,
            consolidation_output,
        }))
    }

    #[cfg(test)]
    async fn run_once_with_config_for_tests(
        &self,
        config: crate::service::config::types::GlobalConfig,
    ) -> OpenBitFunResult<Option<Phase2RunReport>> {
        self.run_once_with_config(config).await
    }

    async fn select_enabled_rows(
        &self,
        rows: &[MemoryPhase2CandidateRow],
        limit: usize,
    ) -> OpenBitFunResult<Vec<MemoryPhase2CandidateRow>> {
        let mut selected = Vec::new();
        for row in rows {
            if selected.len() >= limit {
                break;
            }
            if self.phase2_row_memory_enabled(row).await? {
                selected.push(row.clone());
            }
        }
        Ok(selected)
    }

    async fn phase2_row_memory_enabled(
        &self,
        row: &MemoryPhase2CandidateRow,
    ) -> OpenBitFunResult<bool> {
        let metadata = self
            .persistence
            .load_session_metadata(std::path::Path::new(&row.workspace_path), &row.session_id)
            .await?;
        Ok(metadata
            .map(|metadata| metadata.memory_mode == SessionMemoryMode::Enabled)
            .unwrap_or(false))
    }

    fn rows_to_memory_rows(
        &self,
        rows: &[MemoryPhase2CandidateRow],
    ) -> Vec<crate::agentic::memories::db::MemoryRow> {
        rows.iter()
            .map(|row| crate::agentic::memories::db::MemoryRow {
                session_id: row.session_id.clone(),
                workspace_path: row.workspace_path.clone(),
                rollout_path: row.rollout_path.clone(),
                source_updated_at_unix_secs: row.source_updated_at_unix_secs,
                raw_memory: row.raw_memory.clone(),
                rollout_summary: row.rollout_summary.clone(),
                rollout_slug: row.rollout_slug.clone(),
                generated_at_unix_secs: row.generated_at_unix_secs,
                usage_count: row.usage_count,
                last_usage_unix_secs: row.last_usage_unix_secs,
                selected_for_phase2: row.selected_for_phase2,
                selected_for_phase2_source_updated_at: row.selected_for_phase2_source_updated_at,
            })
            .collect()
    }

    pub async fn claim_phase2_job(
        &self,
        ownership_token: &str,
    ) -> OpenBitFunResult<MemoryPhase2ClaimOutcome> {
        let job = self.db.get_phase2_job(PHASE2_JOB_KEY).await?;
        let input_watermark = job
            .as_ref()
            .and_then(|row| row.input_watermark)
            .unwrap_or_default();
        self.db
            .claim_phase2_job(
                PHASE2_JOB_KEY,
                ownership_token,
                input_watermark,
                phase2_lease_seconds().await?,
            )
            .await
    }

    pub async fn complete_phase2_job_success(
        &self,
        ownership_token: &str,
        selection: &crate::agentic::memories::db::MemoryPhase2SelectionRow,
    ) -> OpenBitFunResult<bool> {
        self.db
            .complete_phase2_job_success(PHASE2_JOB_KEY, ownership_token, selection.input_watermark)
            .await
    }

    pub async fn complete_phase2_job_idle(
        &self,
        ownership_token: &str,
        selection: &crate::agentic::memories::db::MemoryPhase2SelectionRow,
    ) -> OpenBitFunResult<bool> {
        self.db
            .complete_phase2_job_idle(PHASE2_JOB_KEY, ownership_token, selection.input_watermark)
            .await
    }

    pub async fn complete_phase2_job_failure(
        &self,
        ownership_token: &str,
        error: String,
    ) -> OpenBitFunResult<bool> {
        self.db
            .complete_phase2_job_failure(
                PHASE2_JOB_KEY,
                ownership_token,
                current_unix_secs() + phase2_retry_delay_seconds().await?,
                error,
            )
            .await
    }

    async fn run_consolidation_agent(&self) -> OpenBitFunResult<MemoryPhase2ConsolidationOutcome> {
        let Ok(config_service) = get_global_config_service().await else {
            return self.consolidator.consolidate(&self.memory_root, None).await;
        };
        let config: crate::service::config::types::GlobalConfig =
            config_service.get_config(None).await.map_err(|error| {
                OpenBitFunError::service(format!("Failed to load config: {}", error))
            })?;
        let model_id = Some(select_phase2_model_id(&config)?);
        info!(
            "Memory phase2 internal agent starting: model_id={:?}, workspace_root={}",
            model_id,
            self.memory_root.display()
        );
        let outcome = self
            .consolidator
            .consolidate(&self.memory_root, model_id.clone())
            .await?;
        info!(
            "Memory phase2 internal agent completed: model_id={:?}, output_bytes={}, turn_completed={}",
            model_id,
            outcome.output.len(),
            outcome.completed
        );
        Ok(outcome)
    }

    async fn prune_prompt_artifacts(&self) -> OpenBitFunResult<()> {
        let root = self.memory_root.clone();
        for name in ["phase2_prompt.md", "phase2_user_prompt.md"] {
            let path = root.join(name);
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(OpenBitFunError::io(format!(
                        "Failed to prune memory prompt artifact {}: {}",
                        path.display(),
                        error
                    )))
                }
            }
        }
        Ok(())
    }

    async fn confirm_phase2_job_ownership(&self, ownership_token: &str) -> OpenBitFunResult<()> {
        let job = self.db.get_phase2_job(PHASE2_JOB_KEY).await?;
        if job.as_ref().and_then(|row| row.ownership_token.as_deref()) == Some(ownership_token) {
            self.db
                .touch_phase2_job_heartbeat(
                    PHASE2_JOB_KEY,
                    ownership_token,
                    current_unix_secs(),
                    phase2_lease_seconds().await?,
                )
                .await?
                .then_some(())
                .ok_or_else(|| {
                    OpenBitFunError::service(
                        "Lost memory phase2 job ownership before resetting workspace baseline"
                            .to_string(),
                    )
                })?;
            return Ok(());
        }

        Err(OpenBitFunError::service(
            "Lost memory phase2 job ownership before resetting workspace baseline".to_string(),
        ))
    }

    fn confirm_phase2_job_completion(&self, completed: bool) -> OpenBitFunResult<()> {
        if completed {
            Ok(())
        } else {
            Err(OpenBitFunError::service(
                "Lost memory phase2 job ownership before completing run".to_string(),
            ))
        }
    }
}

fn memory_phase2_tool_restrictions(memory_root: &std::path::Path) -> ToolRuntimeRestrictions {
    let allowed_tool_names = [
        "Read",
        "Grep",
        "Glob",
        "LS",
        "GetFileDiff",
        "GetToolSpec",
        "Write",
        "Edit",
        "Delete",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<BTreeSet<_>>();
    let denied_tool_messages = BTreeMap::from([(
        "Task".to_string(),
        "Recursive memory consolidation delegation is blocked. Use direct memory workspace tools only."
            .to_string(),
    )]);
    let root = memory_root.to_string_lossy().to_string();
    ToolRuntimeRestrictions {
        allowed_tool_names,
        denied_tool_names: BTreeSet::from(["Task".to_string()]),
        denied_tool_messages,
        path_policy: ToolPathPolicy {
            read_roots: vec![root.clone()],
            write_roots: vec![root.clone()],
            edit_roots: vec![root.clone()],
            delete_roots: vec![root],
        },
        miniapp_context_scope: None,
    }
}

/// True when the workspace diff contains a change the consolidation agent must
/// look at.
///
/// A change is meaningful when it touches memory content: the consolidated
/// artifacts, the merged raw inputs, per-rollout evidence, skills, or extension
/// inputs. The re-seeded ad-hoc instructions file and the generated
/// `phase2_workspace_diff.md` are not content, so they never trigger a run on
/// their own.
fn workspace_diff_has_meaningful_changes(diff: &MemoryWorkspaceDiff) -> bool {
    diff.changes
        .iter()
        .any(|change| workspace_change_path_is_meaningful(&change.path))
}

fn workspace_change_path_is_meaningful(path: &str) -> bool {
    if path == MEMORY_FILE_NAME || path == MEMORY_SUMMARY_FILE_NAME || path == RAW_MEMORIES_FILENAME
    {
        return true;
    }
    if path == PHASE2_WORKSPACE_DIFF_FILE_NAME {
        return false;
    }
    if path.starts_with(&format!("{ROLLOUT_SUMMARIES_DIR_NAME}/"))
        || path.starts_with(&format!("{SKILLS_DIR_NAME}/"))
    {
        return true;
    }
    if path.starts_with(&format!("{MEMORY_EXTENSIONS_DIR_NAME}/")) {
        // Re-seeding the extension instructions file alone keeps the existing
        // baseline-reset behavior and is not a consolidation trigger.
        return path
            != format!(
            "{MEMORY_EXTENSIONS_DIR_NAME}/{AD_HOC_EXTENSION_NAME}/{AD_HOC_INSTRUCTIONS_FILE_NAME}"
        );
    }
    false
}

pub fn current_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

async fn phase2_retry_delay_seconds() -> OpenBitFunResult<i64> {
    let config = get_phase2_runtime_config().await;
    Ok(config
        .memories
        .phase2_retry_delay_seconds
        .clamp(60, 24 * 60 * 60))
}

/// Configured length of the global phase-2 job lease.
///
/// Single source for both the claim path and the read-only liveness query, so a
/// stale-lease decision can never be made against a different lease length than
/// the one the job was claimed with.
pub(crate) async fn phase2_lease_seconds() -> OpenBitFunResult<i64> {
    let config = get_phase2_runtime_config().await;
    Ok(config.memories.phase2_lease_seconds.clamp(60, 24 * 60 * 60))
}

fn select_phase2_model_id(
    config: &crate::service::config::types::GlobalConfig,
) -> OpenBitFunResult<String> {
    let ai = &config.ai;
    let model_ref = config.memories.consolidation_model.as_deref().or(config
        .ai
        .default_models
        .primary
        .as_deref());

    model_ref
        .and_then(|model_ref| ai.resolve_model_selection(model_ref))
        .or_else(|| ai.first_enabled_model_id())
        .ok_or_else(|| {
            OpenBitFunError::service("No enabled model available for memory phase2".to_string())
        })
}

fn build_phase2_user_prompt(memory_root: &std::path::Path) -> String {
    format!(
        "Consolidate the workspace at:\n{}\n\nFocus on the selected stage-1 memories in raw_memories.md and the rollout_summaries directory. Return a concise markdown result.",
        memory_root.display()
    )
}

async fn get_phase2_runtime_config() -> crate::service::config::types::GlobalConfig {
    match get_global_config_service().await {
        Ok(service) => service.get_config(None).await.unwrap_or_default(),
        Err(_) => crate::service::config::types::GlobalConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::memories::db::{MemoryDatabase, MemoryRow};
    use crate::agentic::persistence::PersistenceManager;
    use crate::infrastructure::app_paths::PathManager;
    use crate::service::config::types::GlobalConfig;
    use crate::service::session::{SessionMemoryMode, SessionMetadata};
    use std::sync::Arc;
    use tempfile::tempdir;

    struct FakeConsolidator;

    #[async_trait]
    impl MemoryPhase2Consolidator for FakeConsolidator {
        async fn consolidate(
            &self,
            memory_root: &std::path::Path,
            _model_id: Option<String>,
        ) -> OpenBitFunResult<MemoryPhase2ConsolidationOutcome> {
            let diff = tokio::fs::read_to_string(
                crate::agentic::memories::workspace::phase2_workspace_diff_file(memory_root),
            )
            .await
            .map_err(|error| {
                OpenBitFunError::io(format!(
                    "Expected phase2 workspace diff before consolidation: {}",
                    error
                ))
            })?;
            tokio::fs::write(
                crate::agentic::memories::workspace::memory_index_file(memory_root),
                "# MEMORY.md\n\n# Task Group: fake consolidation\nscope: test\napplies_to: cwd=test; reuse_rule=test\n",
            )
            .await
            .unwrap();
            tokio::fs::write(
                crate::agentic::memories::workspace::memory_summary_file(memory_root),
                "v1\n\n## User Profile\n\n- fake\n",
            )
            .await
            .unwrap();
            Ok(format!("consolidated with diff bytes={}", diff.len()).into())
        }
    }

    fn runner_with_fake_consolidator(
        db: Arc<MemoryDatabase>,
        persistence: Arc<PersistenceManager>,
        memory_root: std::path::PathBuf,
    ) -> MemoryPhase2Runner {
        MemoryPhase2Runner::with_memory_root_and_consolidator_for_tests(
            db,
            persistence,
            memory_root,
            Arc::new(FakeConsolidator),
        )
    }

    fn phase2_enabled_test_config() -> GlobalConfig {
        let mut config = GlobalConfig::default();
        config.memories.generate_memories = true;
        config
    }

    async fn save_memory_row_metadata(
        persistence: &PersistenceManager,
        row: &MemoryRow,
        mode: SessionMemoryMode,
    ) {
        let mut metadata = SessionMetadata::new(
            row.session_id.clone(),
            format!("name {}", row.session_id),
            "code".to_string(),
            "model".to_string(),
        );
        metadata.memory_mode = mode;
        metadata.turn_count = 3;
        metadata.workspace_path = Some(row.workspace_path.clone());
        persistence
            .save_session_metadata(std::path::Path::new(&row.workspace_path), &metadata)
            .await
            .expect("metadata should save");
    }

    fn test_memory_row(
        session_id: &str,
        workspace_path: String,
        raw_memory: &str,
        usage_count: i64,
        last_usage_unix_secs: Option<i64>,
        source_updated_at_unix_secs: i64,
    ) -> MemoryRow {
        MemoryRow {
            session_id: session_id.to_string(),
            rollout_path: format!("{workspace_path}/sessions/{session_id}"),
            workspace_path,
            source_updated_at_unix_secs,
            raw_memory: raw_memory.to_string(),
            rollout_summary: format!("summary {session_id}"),
            rollout_slug: Some(format!("slug-{session_id}")),
            generated_at_unix_secs: source_updated_at_unix_secs + 1,
            usage_count,
            last_usage_unix_secs,
            selected_for_phase2: 0,
            selected_for_phase2_source_updated_at: None,
        }
    }

    /// Counts how often the consolidation agent really ran.
    struct CountingConsolidator {
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl MemoryPhase2Consolidator for CountingConsolidator {
        async fn consolidate(
            &self,
            memory_root: &std::path::Path,
            model_id: Option<String>,
        ) -> OpenBitFunResult<MemoryPhase2ConsolidationOutcome> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            FakeConsolidator.consolidate(memory_root, model_id).await
        }
    }

    /// Consolidator that writes a partial MEMORY.md and reports an unfinished turn,
    /// like an internal agent that hit its execution timeout mid-consolidation.
    struct IncompleteConsolidator {
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl MemoryPhase2Consolidator for IncompleteConsolidator {
        async fn consolidate(
            &self,
            memory_root: &std::path::Path,
            _model_id: Option<String>,
        ) -> OpenBitFunResult<MemoryPhase2ConsolidationOutcome> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::fs::write(
                crate::agentic::memories::workspace::memory_index_file(memory_root),
                "# MEMORY.md\n\n# Task Group: partial consolidation\nscope: test\napplies_to: cwd=test; reuse_rule=test\n",
            )
            .await
            .unwrap();
            Ok(MemoryPhase2ConsolidationOutcome {
                output: "partial output".to_string(),
                completed: false,
                reason: Some("PartialTimeout: consolidation turn timed out".to_string()),
            })
        }
    }

    #[test]
    fn memory_phase2_tool_restrictions_allow_only_workspace_file_tools() {
        let root = std::path::PathBuf::from("E:/memory-root");
        let restrictions = memory_phase2_tool_restrictions(&root);

        assert!(restrictions.is_tool_allowed("Read"));
        assert!(restrictions.is_tool_allowed("Write"));
        assert!(restrictions.is_tool_allowed("Edit"));
        assert!(!restrictions.is_tool_allowed("Task"));
        assert!(!restrictions.is_tool_allowed("WebFetch"));
        assert_eq!(
            restrictions.path_policy.read_roots,
            vec![root.to_string_lossy().to_string()]
        );
        assert_eq!(
            restrictions.path_policy.write_roots,
            vec![root.to_string_lossy().to_string()]
        );
        assert_eq!(
            restrictions.path_policy.edit_roots,
            vec![root.to_string_lossy().to_string()]
        );
        assert_eq!(
            restrictions.path_policy.delete_roots,
            vec![root.to_string_lossy().to_string()]
        );
    }

    #[test]
    fn phase2_internal_agent_request_auto_approves_in_root_tool_calls() {
        let root = std::path::PathBuf::from("E:/memory-root");
        let request = memory_phase2_internal_agent_request(
            "memory-root-workspace".to_string(),
            &root,
            Some("model-1".to_string()),
            "consolidate".to_string(),
        );

        // The consolidation turn is unattended: no surface can answer a permission
        // prompt, so an ask would block the global phase-2 job until its lease
        // expired. Auto-approve answers asks in-process.
        assert_eq!(
            request
                .context
                .get(PERMISSION_MODE_CONTEXT_KEY)
                .map(String::as_str),
            Some(PermissionMode::AutoApprove.as_str())
        );
        assert_eq!(request.session_kind, SessionKind::EphemeralChild);
        assert!(!request.emit_lifecycle_events);
        assert_eq!(request.agent_type, "MemoryPhase2");
        // The internal request carries the registered memory-root workspace ID: the
        // session config is built from the ID, so the path is never re-inferred.
        assert_eq!(request.workspace_id, "memory-root-workspace");
        // Auto-approve must not widen what the agent may touch.
        assert_eq!(
            request.runtime_tool_restrictions.path_policy.write_roots,
            vec![root.to_string_lossy().to_string()]
        );
        assert!(!request.runtime_tool_restrictions.is_tool_allowed("Bash"));
    }

    #[tokio::test]
    async fn phase2_runner_syncs_workspace_and_updates_job_state() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let runner = runner_with_fake_consolidator(
            Arc::new(db),
            persistence.clone(),
            temp.path().join("memories"),
        );
        let workspace_a = temp
            .path()
            .join("workspace-a")
            .to_string_lossy()
            .to_string();
        let workspace_b = temp
            .path()
            .join("workspace-b")
            .to_string_lossy()
            .to_string();

        let rows = [
            test_memory_row(
                "session-a",
                workspace_a,
                "memory a",
                5,
                Some(current_unix_secs() - 20),
                current_unix_secs() - 90,
            ),
            test_memory_row(
                "session-b",
                workspace_b,
                "memory b",
                7,
                Some(current_unix_secs() - 10),
                current_unix_secs() - 80,
            ),
        ];
        for row in &rows {
            save_memory_row_metadata(&persistence, row, SessionMemoryMode::Enabled).await;
            runner.db.upsert_memory(row).await.unwrap();
        }

        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("phase2 report");
        assert_eq!(report.selected_count, 2);

        let job = runner
            .db
            .get_phase2_job(PHASE2_JOB_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.last_success_watermark, job.input_watermark);
        assert!(job.input_watermark.unwrap_or_default() >= 0);

        let raw = tokio::fs::read_to_string(
            crate::agentic::memories::workspace::raw_memories_file(&temp.path().join("memories")),
        )
        .await
        .unwrap();
        assert!(raw.contains("memory a"));
        assert!(raw.contains("memory b"));
        assert!(crate::agentic::memories::workspace::memory_index_file(
            &temp.path().join("memories")
        )
        .exists());
        assert!(crate::agentic::memories::workspace::memory_summary_file(
            &temp.path().join("memories")
        )
        .exists());
        assert!(
            !crate::agentic::memories::workspace::phase2_workspace_diff_file(
                &temp.path().join("memories")
            )
            .exists()
        );
    }

    #[tokio::test]
    async fn phase2_runner_respects_cooldown_before_running() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let runner = runner_with_fake_consolidator(Arc::new(db), persistence, memory_root.clone());
        assert_eq!(
            runner
                .db
                .claim_phase2_job(PHASE2_JOB_KEY, "token-a", 10, 60)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        assert!(runner
            .db
            .complete_phase2_job_success(PHASE2_JOB_KEY, "token-a", 10)
            .await
            .unwrap());

        assert!(runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .is_none());
        assert!(
            !crate::agentic::memories::workspace::memory_index_file(&memory_root).exists(),
            "a no-op run inside the success cooldown must not invoke the consolidation agent"
        );
    }

    #[tokio::test]
    async fn phase2_runner_bypasses_success_cooldown_for_ad_hoc_notes() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let runner = runner_with_fake_consolidator(Arc::new(db), persistence, memory_root.clone());
        assert_eq!(
            runner
                .db
                .claim_phase2_job(PHASE2_JOB_KEY, "token-a", 10, 60)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        assert!(runner
            .db
            .complete_phase2_job_success(PHASE2_JOB_KEY, "token-a", 10)
            .await
            .unwrap());

        crate::agentic::memories::workspace::prepare_memory_workspace(&memory_root)
            .await
            .unwrap();
        tokio::fs::write(
            crate::agentic::memories::workspace::ad_hoc_notes_dir(&memory_root)
                .join("2026-07-02T12-00-00-remember-review-style.md"),
            "Remember to keep memory review notes concise.",
        )
        .await
        .unwrap();

        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("an ad-hoc note must bypass the success cooldown");
        assert_eq!(report.selected_count, 0);
        assert!(report.consolidation_output.contains("consolidated"));
        assert!(crate::agentic::memories::workspace::memory_index_file(&memory_root).exists());
    }

    #[test]
    fn memory_workspace_meaningful_change_detection_ignores_tool_and_seed_artifacts() {
        assert!(workspace_change_path_is_meaningful("MEMORY.md"));
        assert!(workspace_change_path_is_meaningful("memory_summary.md"));
        assert!(workspace_change_path_is_meaningful("raw_memories.md"));
        assert!(workspace_change_path_is_meaningful(
            "rollout_summaries/2025-02-11T15-35-19-jqmb.md"
        ));
        assert!(workspace_change_path_is_meaningful(
            "skills/example/SKILL.md"
        ));
        assert!(workspace_change_path_is_meaningful(
            "extensions/ad_hoc/notes/2026-07-02T12-00-00-note.md"
        ));

        assert!(!workspace_change_path_is_meaningful(
            "extensions/ad_hoc/instructions.md"
        ));
        assert!(!workspace_change_path_is_meaningful(
            "phase2_workspace_diff.md"
        ));
        assert!(!workspace_change_path_is_meaningful(
            ".openbitfun/search/flashgrep-index/index.bin"
        ));
    }

    #[tokio::test]
    async fn phase2_runner_advances_evaluated_watermark_so_cooldown_protects_noop_runs() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runner = MemoryPhase2Runner::with_memory_root_and_consolidator_for_tests(
            Arc::new(db),
            persistence.clone(),
            memory_root.clone(),
            Arc::new(CountingConsolidator {
                calls: calls.clone(),
            }),
        );

        // A memory-disabled session is never selected, so its watermark can only be
        // accounted for by the evaluated clock, never by a selection.
        let disabled = test_memory_row(
            "session-disabled",
            temp.path()
                .join("workspace-disabled")
                .to_string_lossy()
                .to_string(),
            "memory disabled",
            1,
            Some(current_unix_secs() - 10),
            current_unix_secs() - 90,
        );
        save_memory_row_metadata(&persistence, &disabled, SessionMemoryMode::Disabled).await;
        runner.db.upsert_memory(&disabled).await.unwrap();

        // An ad-hoc note gives this first run real work, which arms the success
        // cooldown for the runs after it.
        crate::agentic::memories::workspace::prepare_memory_workspace(&memory_root)
            .await
            .unwrap();
        tokio::fs::write(
            crate::agentic::memories::workspace::ad_hoc_notes_dir(&memory_root)
                .join("2026-07-02T12-00-00-remember-review-style.md"),
            "Remember to keep memory review notes concise.",
        )
        .await
        .unwrap();

        runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("an ad-hoc note must trigger consolidation");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

        let job = runner
            .db
            .get_phase2_job(PHASE2_JOB_KEY)
            .await
            .unwrap()
            .unwrap();
        assert!(
            job.input_watermark.unwrap_or_default() >= disabled.source_updated_at_unix_secs,
            "a completed run must record the newest candidate it evaluated"
        );

        // Second run: nothing new and nothing changed, so the success cooldown has to
        // protect it instead of running the consolidation agent again.
        assert!(runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "an unchanged unselected candidate must not keep the cooldown disarmed"
        );

        // A genuinely newer candidate is new input again, and the run after it is
        // cooldown-protected once more.
        let mut newer = disabled.clone();
        newer.session_id = "session-disabled-newer".to_string();
        newer.source_updated_at_unix_secs = current_unix_secs();
        newer.last_usage_unix_secs = Some(current_unix_secs());
        save_memory_row_metadata(&persistence, &newer, SessionMemoryMode::Disabled).await;
        runner.db.upsert_memory(&newer).await.unwrap();

        assert!(runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .is_none());
        let job = runner
            .db
            .get_phase2_job(PHASE2_JOB_KEY)
            .await
            .unwrap()
            .unwrap();
        assert!(job.input_watermark.unwrap_or_default() >= newer.source_updated_at_unix_secs);
        assert!(runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn phase2_runner_idle_noop_records_clock_and_yields_to_new_input() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let runner = runner_with_fake_consolidator(
            Arc::new(db),
            persistence.clone(),
            temp.path().join("memories"),
        );

        assert!(runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .is_none());

        let job = runner
            .db
            .get_phase2_job(PHASE2_JOB_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.ownership_token, None);
        assert!(job.finished_at_unix_secs.is_some());
        assert_eq!(job.last_success_watermark, None);
        assert!(job.last_error.is_none());
        // The idle run still records the evaluated input clock...
        assert!(job.input_watermark.is_some());

        // ...and a candidate newer than that clock bypasses the armed cooldown.
        let row = test_memory_row(
            "session-after-idle",
            temp.path()
                .join("workspace-after-idle")
                .to_string_lossy()
                .to_string(),
            "memory after idle",
            0,
            None,
            current_unix_secs(),
        );
        save_memory_row_metadata(&persistence, &row, SessionMemoryMode::Enabled).await;
        runner.db.upsert_memory(&row).await.unwrap();
        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("new input after an idle run must consolidate");
        assert_eq!(report.selected_count, 1);

        let job = runner
            .db
            .get_phase2_job(PHASE2_JOB_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            runner
                .db
                .claim_phase2_job(
                    PHASE2_JOB_KEY,
                    "next-token",
                    job.input_watermark.unwrap_or_default(),
                    60
                )
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
    }

    #[tokio::test]
    async fn phase2_runner_consolidates_ad_hoc_note_without_stage1_candidates() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let runner = runner_with_fake_consolidator(Arc::new(db), persistence, memory_root.clone());

        crate::agentic::memories::workspace::prepare_memory_workspace(&memory_root)
            .await
            .unwrap();
        tokio::fs::write(
            crate::agentic::memories::workspace::ad_hoc_notes_dir(&memory_root)
                .join("2026-07-02T12-00-00-remember-review-style.md"),
            "Remember to keep memory review notes concise.",
        )
        .await
        .unwrap();

        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("ad-hoc note should trigger phase2 consolidation");
        assert_eq!(report.candidate_count, 0);
        assert_eq!(report.selected_count, 0);
        assert!(report.consolidation_output.contains("consolidated"));
        assert!(crate::agentic::memories::workspace::memory_summary_file(&memory_root).exists());
        assert!(
            !crate::agentic::memories::workspace::phase2_workspace_diff_file(&memory_root).exists()
        );
    }

    #[tokio::test]
    async fn phase2_runner_forgets_polluted_session_on_the_next_run() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let runner =
            runner_with_fake_consolidator(Arc::new(db), persistence.clone(), memory_root.clone());
        let workspace_path = temp
            .path()
            .join("workspace-forget")
            .to_string_lossy()
            .to_string();
        let row = test_memory_row(
            "session-forget",
            workspace_path.clone(),
            "memory forget",
            5,
            Some(current_unix_secs() - 10),
            current_unix_secs() - 90,
        );
        save_memory_row_metadata(&persistence, &row, SessionMemoryMode::Enabled).await;
        runner.db.upsert_memory(&row).await.unwrap();

        let first_report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("first phase2 report");
        assert_eq!(first_report.selected_count, 1);
        assert!(runner
            .db
            .phase2_selected_for_session(&row.session_id)
            .await
            .unwrap());
        let raw_path = crate::agentic::memories::workspace::raw_memories_file(&memory_root);
        let first_raw = tokio::fs::read_to_string(&raw_path).await.unwrap();
        assert!(first_raw.contains("memory forget"));
        let polluted_summary_file =
            crate::agentic::memories::workspace::rollout_summary_file_name(&row);

        persistence
            .mark_session_memory_mode_polluted(
                std::path::Path::new(&workspace_path),
                &row.session_id,
            )
            .await
            .expect("polluted selected session should enqueue phase2");

        // The polluted session is the only candidate and drops out of the selection.
        // Forgetting still has to take effect in this run: `raw_memories.md` is
        // rebuilt without its section, so the removal reaches the consolidation agent
        // through the workspace diff.
        let second_report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("a deselected candidate must still rebuild the workspace inputs");
        assert_eq!(second_report.selected_count, 0);
        assert_eq!(second_report.candidate_count, 1);
        let second_raw = tokio::fs::read_to_string(&raw_path).await.unwrap();
        assert!(!second_raw.contains("memory forget"));
        assert!(second_raw.contains("No raw memories yet."));

        // Evidence is only deleted when its stage-1 row is gone, not when the row
        // merely leaves the selection.
        assert!(
            crate::agentic::memories::workspace::rollout_summaries_dir(&memory_root)
                .join(&polluted_summary_file)
                .exists(),
            "a live-but-deselected row must keep its rollout summary file"
        );
    }

    #[tokio::test]
    async fn phase2_runner_never_marks_an_unselected_candidate_as_selected() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let runner =
            runner_with_fake_consolidator(Arc::new(db), persistence.clone(), memory_root.clone());

        let enabled = test_memory_row(
            "session-enabled",
            temp.path()
                .join("workspace-enabled")
                .to_string_lossy()
                .to_string(),
            "memory enabled",
            5,
            Some(current_unix_secs() - 10),
            current_unix_secs() - 90,
        );
        save_memory_row_metadata(&persistence, &enabled, SessionMemoryMode::Enabled).await;
        runner.db.upsert_memory(&enabled).await.unwrap();

        let polluted = test_memory_row(
            "session-polluted",
            temp.path()
                .join("workspace-polluted")
                .to_string_lossy()
                .to_string(),
            "memory polluted",
            1,
            Some(current_unix_secs() - 9),
            current_unix_secs() - 80,
        );
        save_memory_row_metadata(&persistence, &polluted, SessionMemoryMode::Polluted).await;
        runner.db.upsert_memory(&polluted).await.unwrap();

        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("phase2 report");
        assert_eq!(report.selected_count, 1);
        assert!(
            !runner
                .db
                .phase2_selected_for_session(&polluted.session_id)
                .await
                .unwrap(),
            "a candidate excluded by its memory mode must not be marked selected"
        );
        assert!(
            !crate::agentic::memories::workspace::rollout_summaries_dir(&memory_root)
                .join(crate::agentic::memories::workspace::rollout_summary_file_name(&polluted))
                .exists()
        );
        let raw = tokio::fs::read_to_string(
            crate::agentic::memories::workspace::raw_memories_file(&memory_root),
        )
        .await
        .unwrap();
        assert!(raw.contains("memory enabled"));
        assert!(!raw.contains("memory polluted"));
    }

    #[tokio::test]
    async fn phase2_runner_deletes_summary_file_once_retention_removed_the_row() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let runner =
            runner_with_fake_consolidator(Arc::new(db), persistence.clone(), memory_root.clone());
        let stale_usage = current_unix_secs() - 3 * 24 * 60 * 60;
        let row = test_memory_row(
            "session-stale",
            temp.path()
                .join("workspace-stale")
                .to_string_lossy()
                .to_string(),
            "memory stale",
            1,
            Some(stale_usage),
            current_unix_secs() - 4 * 24 * 60 * 60,
        );
        save_memory_row_metadata(&persistence, &row, SessionMemoryMode::Enabled).await;
        runner.db.upsert_memory(&row).await.unwrap();

        runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("first phase2 report");
        let summary_path = crate::agentic::memories::workspace::rollout_summaries_dir(&memory_root)
            .join(crate::agentic::memories::workspace::rollout_summary_file_name(&row));
        assert!(summary_path.exists());

        assert_eq!(
            runner
                .db
                .prune_stage1_outputs_for_retention(1, 100)
                .await
                .unwrap(),
            1
        );

        // The row is gone, so the next run must forget its input and delete the
        // summary file even though there is no candidate left at all.
        runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("retention deletion must be consolidated");
        assert!(!summary_path.exists());
        let raw = tokio::fs::read_to_string(
            crate::agentic::memories::workspace::raw_memories_file(&memory_root),
        )
        .await
        .unwrap();
        assert!(!raw.contains("memory stale"));
        assert!(raw.contains("No raw memories yet."));
    }

    #[tokio::test]
    async fn phase2_job_claim_rejects_busy_owned_job() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        assert_eq!(
            db.claim_phase2_job(PHASE2_JOB_KEY, "ownership-token-a", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );

        let outcome = db
            .claim_phase2_job(PHASE2_JOB_KEY, "ownership-token-b", 11, 3600)
            .await
            .unwrap();
        assert_eq!(outcome, MemoryPhase2ClaimOutcome::SkippedRunning);
    }

    #[tokio::test]
    async fn phase2_runner_returns_consolidation_output() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let runner = runner_with_fake_consolidator(
            Arc::new(db),
            persistence.clone(),
            temp.path().join("memories"),
        );
        let row = test_memory_row(
            "session-c",
            temp.path()
                .join("workspace-c")
                .to_string_lossy()
                .to_string(),
            "memory c",
            9,
            Some(current_unix_secs() - 5),
            current_unix_secs() - 90,
        );
        save_memory_row_metadata(&persistence, &row, SessionMemoryMode::Enabled).await;
        runner.db.upsert_memory(&row).await.unwrap();

        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("phase2 report");
        assert!(!report.consolidation_output.trim().is_empty());
        let summary = tokio::fs::read_to_string(
            crate::agentic::memories::workspace::memory_summary_file(&temp.path().join("memories")),
        )
        .await
        .unwrap();
        assert!(summary.starts_with("v1\n"));
    }

    #[tokio::test]
    async fn phase2_runner_keeps_baseline_and_input_when_consolidation_does_not_complete() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let memory_root = temp.path().join("memories");
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let runner = MemoryPhase2Runner::with_memory_root_and_consolidator_for_tests(
            Arc::new(db),
            persistence.clone(),
            memory_root.clone(),
            Arc::new(IncompleteConsolidator {
                calls: calls.clone(),
            }),
        );
        let row = test_memory_row(
            "session-incomplete",
            temp.path()
                .join("workspace-incomplete")
                .to_string_lossy()
                .to_string(),
            "memory incomplete",
            5,
            Some(current_unix_secs() - 10),
            current_unix_secs() - 90,
        );
        save_memory_row_metadata(&persistence, &row, SessionMemoryMode::Enabled).await;
        runner.db.upsert_memory(&row).await.unwrap();

        let report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("an unfinished consolidation still reports the run");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(report
            .consolidation_output
            .starts_with(MemoryPhase2ConsolidationOutcome::INCOMPLETE_OUTPUT_PREFIX));

        // The run did not advance the pipeline: the job completed without a success
        // stamp, the candidate stays unselected, and the consumed diff is still
        // pending on disk.
        let job = runner
            .db
            .get_phase2_job(PHASE2_JOB_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(job.status, "done");
        assert_eq!(job.last_success_watermark, None);
        assert!(job.ownership_token.is_none());
        assert!(!runner
            .db
            .phase2_selected_for_session(&row.session_id)
            .await
            .unwrap());
        assert!(
            crate::agentic::memories::workspace::phase2_workspace_diff_file(&memory_root).exists(),
            "an unfinished consolidation must keep the diff it was given"
        );

        // The retained diff is a meaningful change, so the next pass re-offers the
        // same input instead of dropping it behind the advanced evaluated watermark.
        let second = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("the retained diff must re-offer the same input");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(second.selected_count, 1);
        assert_eq!(second.candidate_count, report.candidate_count);
        // Same input content, and the selection clock only moved by its monotonic
        // per-run bump.
        assert_eq!(second.input_bytes, report.input_bytes);
        assert_eq!(second.input_watermark, report.input_watermark + 1);
    }
}
