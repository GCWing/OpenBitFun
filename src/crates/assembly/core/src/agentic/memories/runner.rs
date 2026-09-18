use crate::agentic::coordination::{get_global_coordinator, InternalAgentExecutionRequest};
use crate::agentic::memories::db::{
    MemoryDatabase, MemoryPhase2CandidateRow, MemoryPhase2ClaimOutcome,
    MEMORY_PHASE2_GLOBAL_JOB_KEY,
};
use crate::agentic::memories::transcript::redact_memory_secrets;
use crate::agentic::memories::workspace::{
    memory_workspace_diff, prepare_memory_workspace, reset_memory_workspace_baseline,
    sync_phase2_workspace_inputs, write_workspace_diff, MemoryWorkspaceDiff, AD_HOC_EXTENSION_NAME,
    AD_HOC_INSTRUCTIONS_FILE_NAME, MEMORY_EXTENSIONS_DIR_NAME,
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

#[async_trait]
trait MemoryPhase2Consolidator: Send + Sync {
    async fn consolidate(
        &self,
        memory_root: &std::path::Path,
        model_id: Option<String>,
    ) -> OpenBitFunResult<String>;
}

struct InternalAgentMemoryPhase2Consolidator;

#[async_trait]
impl MemoryPhase2Consolidator for InternalAgentMemoryPhase2Consolidator {
    async fn consolidate(
        &self,
        memory_root: &std::path::Path,
        model_id: Option<String>,
    ) -> OpenBitFunResult<String> {
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
        let request = InternalAgentExecutionRequest {
            task_description,
            agent_type: "MemoryPhase2".to_string(),
            session_name: "Memory Phase 2 Consolidation".to_string(),
            workspace_id: workspace.id,
            model_id: model_id.clone(),
            created_by: Some("memory-phase2".to_string()),
            context: HashMap::new(),
            delegation_policy: openbitfun_runtime_ports::DelegationPolicy::top_level()
                .spawn_child(),
            runtime_tool_restrictions: memory_phase2_tool_restrictions(memory_root),
            session_kind: SessionKind::EphemeralChild,
            emit_lifecycle_events: false,
        };
        let started_at = std::time::Instant::now();
        let result = coordinator
            .execute_internal_agent(request, None, Some(20 * 60))
            .await?;
        info!(
            "Memory phase2 internal agent raw response: workspace_root={}, model_id={:?}, output_bytes={}, duration_ms={}, raw_response=\n{}",
            memory_root.display(),
            model_id,
            result.text.len(),
            started_at.elapsed().as_millis(),
            redact_memory_secrets(&result.text)
        );
        Ok(result.text)
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
        info!(
            "Memory phase2 run started: generate_memories={}, limit={}, max_unused_days={}, phase2_lease_seconds={}, phase2_success_cooldown_seconds={}, phase2_retry_delay_seconds={}, memory_root={}",
            config.memories.generate_memories,
            config.memories.max_raw_memories_for_consolidation.clamp(1, 4096),
            config.memories.max_unused_days.clamp(0, 365),
            config.memories.phase2_lease_seconds.clamp(60, 24 * 60 * 60),
            config.memories.phase2_success_cooldown_seconds.clamp(0, 7 * 24 * 60 * 60),
            config.memories.phase2_retry_delay_seconds.clamp(60, 24 * 60 * 60),
            self.memory_root.display()
        );
        if !config.memories.generate_memories {
            info!("Memory phase2 run skipped because generate_memories is disabled");
            return Ok(None);
        }

        if let Some(job) = self.db.get_phase2_job(PHASE2_JOB_KEY).await? {
            let now = current_unix_secs();
            let cooldown_until = job.success_cooldown_until_unix_secs(
                config
                    .memories
                    .phase2_success_cooldown_seconds
                    .clamp(0, 7 * 24 * 60 * 60),
            );
            if cooldown_until.is_some_and(|until| until > now) {
                info!(
                    "Memory phase2 run skipped by success cooldown: cooldown_until_unix_secs={:?}, now={}",
                    cooldown_until, now
                );
                return Ok(None);
            }
            if job.retry_at_unix_secs.is_some_and(|until| until > now) {
                info!(
                    "Memory phase2 run skipped by retry backoff: retry_after_unix_secs={:?}, now={}",
                    job.retry_at_unix_secs,
                    now
                );
                return Ok(None);
            }
        }

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
        let max_unused_days = config.memories.max_unused_days.clamp(0, 365);
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

        let Some(selection) = self
            .db
            .upsert_phase2_selection(PHASE2_JOB_KEY, &selected)
            .await?
        else {
            info!("Memory phase2 run stopped because selection was empty");
            return Ok(None);
        };
        info!(
            "Memory phase2 selection persisted: input_watermark={}",
            selection.input_watermark
        );

        if has_candidate_rows {
            if let Err(error) =
                sync_phase2_workspace_inputs(&self.memory_root, &selected_memory_rows).await
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
                "Memory phase2 inputs synced: memory_root={}, selected_count={}, input_bytes={}",
                self.memory_root.display(),
                selected_memory_rows.len(),
                input_bytes
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
        info!(
            "Memory phase2 workspace diff computed: memory_root={}, has_changes={}, change_count={}",
            self.memory_root.display(),
            workspace_diff.has_changes(),
            workspace_diff.changes.len()
        );
        for change in &workspace_diff.changes {
            debug!(
                "Memory phase2 workspace diff entry: path={}, status={:?}",
                change.path, change.status
            );
        }

        if !workspace_diff.has_changes() {
            if has_candidate_rows {
                self.confirm_phase2_job_completion(
                    self.complete_phase2_job_success(&ownership_token, &selection)
                        .await?,
                )?;
                self.db
                    .mark_phase2_candidates_selected(&selected_ids, selection.input_watermark)
                    .await?;
            } else {
                self.confirm_phase2_job_completion(
                    self.complete_phase2_job_idle(&ownership_token, &selection)
                        .await?,
                )?;
            }
            let duration_ms = started_at.elapsed().as_millis();
            info!(
                "Memory phase2 run completed without workspace changes: candidate_count={}, selected_count={}, input_bytes={}, watermark={}, duration_ms={}",
                candidate_rows.len(),
                selected.len(),
                input_bytes,
                selection.input_watermark,
                duration_ms
            );
            if !has_candidate_rows {
                return Ok(None);
            }
            return Ok(Some(Phase2RunReport {
                selected_count: selected.len(),
                candidate_count: candidate_rows.len(),
                input_watermark: selection.input_watermark,
                input_bytes,
                duration_ms,
                consolidation_output: "No memory workspace changes to consolidate.".to_string(),
            }));
        }

        if !has_candidate_rows && workspace_diff_only_seeds_ad_hoc_instructions(&workspace_diff) {
            self.confirm_phase2_job_ownership(&ownership_token).await?;
            if let Err(error) = reset_memory_workspace_baseline(&self.memory_root).await {
                let _ = self
                    .complete_phase2_job_failure(&ownership_token, error.to_string())
                    .await;
                return Err(error);
            }
            self.prune_prompt_artifacts().await?;
            self.confirm_phase2_job_completion(
                self.complete_phase2_job_idle(&ownership_token, &selection)
                    .await?,
            )?;
            info!(
                "Memory phase2 baseline updated for seeded ad-hoc extension instructions without consolidation: duration_ms={}",
                started_at.elapsed().as_millis()
            );
            return Ok(None);
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

        let consolidation_output = match self.run_consolidation_agent().await {
            Ok(output) => output,
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
            "Memory phase2 consolidation agent completed: output_bytes={}",
            consolidation_output.len()
        );

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
            self.complete_phase2_job_success(&ownership_token, &selection)
                .await?,
        )?;
        if has_candidate_rows {
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
            selection.input_watermark,
            duration_ms
        );
        Ok(Some(Phase2RunReport {
            selected_count: selected.len(),
            candidate_count: candidate_rows.len(),
            input_watermark: selection.input_watermark,
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

    async fn run_consolidation_agent(&self) -> OpenBitFunResult<String> {
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
        let output = self
            .consolidator
            .consolidate(&self.memory_root, model_id.clone())
            .await?;
        info!(
            "Memory phase2 internal agent completed: model_id={:?}, output_bytes={}",
            model_id,
            output.len()
        );
        Ok(output)
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

fn workspace_diff_only_seeds_ad_hoc_instructions(diff: &MemoryWorkspaceDiff) -> bool {
    let instructions_path = format!(
        "{}/{}/{}",
        MEMORY_EXTENSIONS_DIR_NAME, AD_HOC_EXTENSION_NAME, AD_HOC_INSTRUCTIONS_FILE_NAME
    );
    diff.has_changes()
        && diff
            .changes
            .iter()
            .all(|change| change.path == instructions_path)
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

async fn phase2_lease_seconds() -> OpenBitFunResult<i64> {
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
        ) -> OpenBitFunResult<String> {
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
            Ok(format!("consolidated with diff bytes={}", diff.len()))
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
        let runner =
            runner_with_fake_consolidator(Arc::new(db), persistence, temp.path().join("memories"));
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
    }

    #[tokio::test]
    async fn phase2_runner_idle_noop_does_not_set_success_cooldown() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let persistence =
            Arc::new(PersistenceManager::new(path_manager.clone()).expect("persistence manager"));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let runner =
            runner_with_fake_consolidator(Arc::new(db), persistence, temp.path().join("memories"));

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
    async fn phase2_runner_forgets_polluted_previous_selection() {
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
        let raw_path =
            crate::agentic::memories::workspace::raw_memories_file(&temp.path().join("memories"));
        let first_raw = tokio::fs::read_to_string(&raw_path).await.unwrap();
        assert!(first_raw.contains("memory forget"));

        persistence
            .mark_session_memory_mode_polluted(
                std::path::Path::new(&workspace_path),
                &row.session_id,
            )
            .await
            .expect("polluted selected session should enqueue phase2");
        let second_report = runner
            .run_once_with_config_for_tests(phase2_enabled_test_config())
            .await
            .unwrap()
            .expect("pollution should enqueue phase2");
        assert_eq!(second_report.candidate_count, 1);
        assert_eq!(second_report.selected_count, 0);
        let second_raw = tokio::fs::read_to_string(&raw_path).await.unwrap();
        assert!(!second_raw.contains("memory forget"));
        assert!(!runner
            .db
            .phase2_selected_for_session(&row.session_id)
            .await
            .unwrap());
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
}
