use crate::agentic::core::message::{MemoryCitation, MemoryCitationEntry};
use crate::infrastructure::PathManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::info;
use openbitfun_services_core::memory_store::{
    decode_memory_job, decode_memory_record, initialize_memory_schema, upsert_memory_record,
};
pub use openbitfun_services_core::memory_store::{
    MemoryJobRecord as MemoryJobRow, MemoryRecord as MemoryRow,
};
#[cfg(test)]
use openbitfun_services_core::memory_store::{EXPECTED_JOBS_COLUMNS, EXPECTED_STAGE1_COLUMNS};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::task;
use uuid::Uuid;

pub const MEMORY_PHASE2_GLOBAL_JOB_KEY: &str = "global";

const JOB_KIND_MEMORY_STAGE1: &str = "memory_stage1";
const JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL: &str = "memory_consolidate_global";
const JOB_STATUS_RUNNING: &str = "running";
const JOB_STATUS_DONE: &str = "done";
const JOB_STATUS_ERROR: &str = "error";
const DEFAULT_RETRY_REMAINING: i64 = 3;
/// How long a session with an exhausted phase-1 retry budget is quarantined
/// before its attempt budget is restored once. Transient provider failures (for
/// example a temporary 403 model outage) must not permanently discard a session.
const PHASE1_RETRY_EXHAUSTION_QUARANTINE_SECONDS: i64 = 24 * 60 * 60;

/// How long a phase-2 lease may go without a heartbeat before the owning run is
/// considered dead. The phase-2 heartbeat fires every 30 seconds, so four missed
/// beats mean the process that held the job is gone and a new run may reclaim it.
const PHASE2_HEARTBEAT_STALE_SECONDS: i64 = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryPhase2CandidateRow {
    pub session_id: String,
    pub workspace_path: String,
    pub rollout_path: String,
    pub source_updated_at_unix_secs: i64,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub rollout_slug: Option<String>,
    pub generated_at_unix_secs: i64,
    pub usage_count: i64,
    pub last_usage_unix_secs: Option<i64>,
    pub selected_for_phase2: i64,
    pub selected_for_phase2_source_updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryPhase2SelectionRow {
    pub job_key: String,
    pub input_watermark: i64,
}

/// Persisted identity of a live stage-1 row.
///
/// The memory workspace derives a rollout-summary file name from these fields,
/// so the database exposes them without owning the naming rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryRolloutSummaryIdentity {
    pub session_id: String,
    pub source_updated_at_unix_secs: i64,
    pub rollout_slug: Option<String>,
}

/// A stage-1 extraction that failed and has not produced output yet.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct MemoryStage1Failure {
    pub session_id: String,
    pub last_error: String,
    pub retry_exhausted: bool,
}

/// Read-only view of the memory pipeline state for status surfaces.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct MemoryStatusSnapshot {
    pub stage1_output_count: u64,
    pub stage1_pending_promotion_count: u64,
    pub stage1_failed: Vec<MemoryStage1Failure>,
    pub phase2_status: Option<String>,
    pub phase2_last_finished_at_unix_secs: Option<i64>,
    pub phase2_last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryPhase1ClaimOutcome {
    Claimed { ownership_token: String },
    SkippedUpToDate,
    SkippedRunning,
    SkippedRetryBackoff,
    SkippedRetryExhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryPhase2ClaimOutcome {
    Claimed,
    SkippedRunning,
    SkippedCooldown,
    SkippedRetryBackoff,
}

#[derive(Clone)]
pub struct MemoryDatabase {
    db_path: PathBuf,
}

impl MemoryDatabase {
    pub fn new(path_manager: Arc<PathManager>) -> Self {
        Self {
            db_path: path_manager.memories_database_file(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.db_path
    }

    pub async fn initialize(&self) -> OpenBitFunResult<()> {
        let db_path = self.db_path.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<()> {
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to create memories database directory {}: {}",
                        parent.display(),
                        error
                    ))
                })?;
            }

            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            Ok(())
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories init task failed: {}", error))
        })?
    }

    pub async fn reset_memory_state(&self) -> OpenBitFunResult<()> {
        let db_path = self.db_path.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<()> {
            if !db_path.exists() {
                return Ok(());
            }

            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            clear_memory_state_in_conn(&conn)?;
            Ok(())
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories reset task failed: {}", error))
        })?
    }

    pub async fn upsert_memory(&self, row: &MemoryRow) -> OpenBitFunResult<()> {
        let db_path = self.db_path.clone();
        let row = row.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<()> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            upsert_stage1_output_conn(&conn, &row, true)?;
            Ok(())
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn phase1_source_needs_update(
        &self,
        session_id: &str,
        session_finished_at_unix_secs: i64,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let session_id = session_id.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            phase1_source_needs_update_in_conn(&conn, &session_id, session_finished_at_unix_secs)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    pub async fn try_claim_phase1_job(
        &self,
        session_id: &str,
        worker_id: &str,
        session_finished_at_unix_secs: i64,
        lease_seconds: i64,
        max_running_jobs: usize,
    ) -> OpenBitFunResult<MemoryPhase1ClaimOutcome> {
        let db_path = self.db_path.clone();
        let session_id = session_id.to_string();
        let worker_id = worker_id.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<MemoryPhase1ClaimOutcome> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to begin memory phase1 claim transaction: {}",
                        error
                    ))
                })?;
            let outcome = try_claim_phase1_job_in_tx(
                &tx,
                &session_id,
                &worker_id,
                session_finished_at_unix_secs,
                lease_seconds,
                max_running_jobs,
            )?;
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory phase1 claim transaction: {}",
                    error
                ))
            })?;
            Ok(outcome)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn mark_phase1_job_succeeded(
        &self,
        row: &MemoryRow,
        ownership_token: &str,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let row = row.clone();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let tx = conn.transaction().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to begin memory phase1 success transaction: {}",
                    error
                ))
            })?;
            phase1_owned_input_watermark(&tx, &row.session_id, &ownership_token)?;
            let now = current_unix_secs();
            let rows_affected = tx
                .execute(
                    r#"
                    UPDATE jobs
                    SET status = ?1,
                        finished_at = ?2,
                        lease_until = NULL,
                        retry_at = NULL,
                        retry_remaining = ?3,
                        last_error = NULL,
                        last_success_watermark = input_watermark
                    WHERE kind = ?4
                      AND job_key = ?5
                      AND status = ?6
                      AND ownership_token = ?7
                    "#,
                    params![
                        JOB_STATUS_DONE,
                        now,
                        DEFAULT_RETRY_REMAINING,
                        JOB_KIND_MEMORY_STAGE1,
                        row.session_id,
                        JOB_STATUS_RUNNING,
                        ownership_token,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to mark memory phase1 job succeeded: {}",
                        error
                    ))
                })?;
            if rows_affected == 0 {
                tx.commit().map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to commit memory phase1 success transaction: {}",
                        error
                    ))
                })?;
                return Ok(false);
            }

            upsert_stage1_output_tx(&tx, &row, false)?;
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory phase1 success transaction: {}",
                    error
                ))
            })?;
            Ok(true)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn mark_phase1_job_succeeded_no_output(
        &self,
        session_id: &str,
        ownership_token: &str,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let session_id = session_id.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let tx = conn.transaction().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to begin memory phase1 no-output transaction: {}",
                    error
                ))
            })?;
            let input_watermark = phase1_owned_input_watermark(&tx, &session_id, &ownership_token)?;
            let now = current_unix_secs();
            let rows_affected = tx
                .execute(
                    r#"
                    UPDATE jobs
                    SET status = ?1,
                        finished_at = ?2,
                        lease_until = NULL,
                        retry_at = NULL,
                        retry_remaining = ?3,
                        last_error = NULL,
                        last_success_watermark = input_watermark
                    WHERE kind = ?4
                      AND job_key = ?5
                      AND status = ?6
                      AND ownership_token = ?7
                    "#,
                    params![
                        JOB_STATUS_DONE,
                        now,
                        DEFAULT_RETRY_REMAINING,
                        JOB_KIND_MEMORY_STAGE1,
                        session_id,
                        JOB_STATUS_RUNNING,
                        ownership_token,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to mark memory phase1 no-output job succeeded: {}",
                        error
                    ))
                })?;
            if rows_affected > 0 {
                tx.execute(
                    r#"
                    DELETE FROM stage1_outputs
                    WHERE thread_id = ?1
                      AND source_updated_at <= ?2
                    "#,
                    params![session_id, input_watermark],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to remove stale memory phase1 output: {}",
                        error
                    ))
                })?;
            }
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory phase1 no-output transaction: {}",
                    error
                ))
            })?;
            Ok(rows_affected > 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn release_phase1_claim_without_watermark(
        &self,
        session_id: &str,
        ownership_token: &str,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let session_id = session_id.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let rows_affected = conn
                .execute(
                    r#"
                    UPDATE jobs
                    SET status = ?1,
                        ownership_token = NULL,
                        worker_id = NULL,
                        finished_at = ?2,
                        lease_until = NULL,
                        retry_at = NULL,
                        last_error = NULL
                    WHERE kind = ?3
                      AND job_key = ?4
                      AND status = ?5
                      AND ownership_token = ?6
                    "#,
                    params![
                        JOB_STATUS_DONE,
                        current_unix_secs(),
                        JOB_KIND_MEMORY_STAGE1,
                        session_id,
                        JOB_STATUS_RUNNING,
                        ownership_token,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to release memory phase1 claim: {}", error))
                })?;
            Ok(rows_affected > 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn mark_phase1_job_failed(
        &self,
        session_id: &str,
        ownership_token: &str,
        retry_backoff_seconds: i64,
        error: String,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let session_id = session_id.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let now = current_unix_secs();
            let retry_at = now.saturating_add(retry_backoff_seconds.max(0));
            let rows_affected = conn
                .execute(
                    r#"
                    UPDATE jobs
                    SET status = ?1,
                        finished_at = ?2,
                        lease_until = NULL,
                        retry_at = ?3,
                        retry_remaining = MAX(retry_remaining - 1, 0),
                        last_error = ?4
                    WHERE kind = ?5
                      AND job_key = ?6
                      AND status = ?7
                      AND ownership_token = ?8
                    "#,
                    params![
                        JOB_STATUS_ERROR,
                        now,
                        retry_at,
                        error,
                        JOB_KIND_MEMORY_STAGE1,
                        session_id,
                        JOB_STATUS_RUNNING,
                        ownership_token,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to mark memory phase1 job failed: {}",
                        error
                    ))
                })?;
            Ok(rows_affected > 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn record_memory_citation(
        &self,
        _citing_session_id: &str,
        _citing_turn_id: Option<&str>,
        _citing_round_id: Option<&str>,
        _citing_message_id: &str,
        citation: &MemoryCitation,
    ) -> OpenBitFunResult<()> {
        let db_path = self.db_path.clone();
        let citation = citation.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<()> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let resolved_session_ids =
                resolve_citation_session_ids(&conn, &citation).unwrap_or_default();
            let tx = conn.transaction().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to begin memory citation usage transaction: {}",
                    error
                ))
            })?;
            let now = current_unix_secs();
            for session_id in resolved_session_ids {
                tx.execute(
                    r#"
                    UPDATE stage1_outputs
                    SET usage_count = COALESCE(usage_count, 0) + 1,
                        last_usage = CASE
                            WHEN last_usage IS NULL OR last_usage < ?2 THEN ?2
                            ELSE last_usage
                        END
                    WHERE thread_id = ?1
                    "#,
                    params![session_id, now],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to update memory usage from citation: {}",
                        error
                    ))
                })?;
            }
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory citation usage transaction: {}",
                    error
                ))
            })?;
            Ok(())
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn list_phase2_candidates(
        &self,
        limit: usize,
        max_unused_days: i64,
    ) -> OpenBitFunResult<Vec<MemoryPhase2CandidateRow>> {
        self.list_phase2_candidates_inner(limit, max_unused_days, true)
            .await
    }

    pub async fn list_phase2_input_candidates(
        &self,
        limit: usize,
        max_unused_days: i64,
    ) -> OpenBitFunResult<Vec<MemoryPhase2CandidateRow>> {
        self.list_phase2_candidates_inner(limit, max_unused_days, false)
            .await
    }

    /// Identity of every stage-1 row that still exists in the database.
    ///
    /// The memory workspace uses this as the rollout-summary keep-set: a summary
    /// file is deleted only when its stage-1 row is gone, never merely because
    /// the row fell outside the current phase-2 selection.
    pub async fn list_live_rollout_summary_identities(
        &self,
    ) -> OpenBitFunResult<Vec<MemoryRolloutSummaryIdentity>> {
        let db_path = self.db_path.clone();
        task::spawn_blocking(
            move || -> OpenBitFunResult<Vec<MemoryRolloutSummaryIdentity>> {
                let conn = open_connection(&db_path)?;
                initialize_schema(&conn)?;
                live_rollout_summary_identities_in_conn(&conn)
            },
        )
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    /// Counts how many of the given `(session_id, finished_at)` sources still
    /// need phase-1 extraction. Used for aggregate age-gate diagnostics.
    pub async fn count_phase1_sources_needing_update(
        &self,
        sources: &[(String, i64)],
    ) -> OpenBitFunResult<usize> {
        if sources.is_empty() {
            return Ok(0);
        }

        let db_path = self.db_path.clone();
        let sources = sources.to_vec();
        task::spawn_blocking(move || -> OpenBitFunResult<usize> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let mut needing_update = 0usize;
            for (session_id, session_finished_at_unix_secs) in &sources {
                if phase1_source_needs_update_in_conn(
                    &conn,
                    session_id,
                    *session_finished_at_unix_secs,
                )? {
                    needing_update += 1;
                }
            }
            Ok(needing_update)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    /// Read-only pipeline status for status surfaces.
    ///
    /// A status read must be read-only-safe: on a fresh profile the database file
    /// does not exist yet, and the settings surface expects an empty snapshot
    /// instead of an IO error. Reading status never creates the database.
    pub async fn status_snapshot(&self) -> OpenBitFunResult<MemoryStatusSnapshot> {
        if !self.db_path.exists() {
            return Ok(MemoryStatusSnapshot::default());
        }

        let db_path = self.db_path.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<MemoryStatusSnapshot> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;

            let stage1_output_count = conn
                .query_row("SELECT COUNT(*) FROM stage1_outputs", [], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to count memory stage1 outputs: {}", error))
                })?;
            let stage1_pending_promotion_count = conn
                .query_row(
                    "SELECT COUNT(*) FROM stage1_outputs WHERE selected_for_phase2 = 0",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to count pending memory stage1 outputs: {}",
                        error
                    ))
                })?;

            let mut failures_stmt = conn
                .prepare(
                    r#"
                    SELECT job_key, COALESCE(last_error, ''), retry_remaining
                    FROM jobs
                    WHERE kind = ?1 AND status = ?2
                    ORDER BY COALESCE(finished_at, 0) DESC, job_key ASC
                    "#,
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to prepare memory failure query: {}",
                        error
                    ))
                })?;
            let failures = failures_stmt
                .query_map(params![JOB_KIND_MEMORY_STAGE1, JOB_STATUS_ERROR], |row| {
                    Ok(MemoryStage1Failure {
                        session_id: row.get(0)?,
                        last_error: row.get(1)?,
                        retry_exhausted: row.get::<_, i64>(2)? <= 0,
                    })
                })
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to query memory failures: {}", error))
                })?;
            let stage1_failed = collect_rows(failures, "memory stage1 failure")?;

            let phase2_job =
                get_job_in_connection(&conn, JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, "global")?;

            Ok(MemoryStatusSnapshot {
                stage1_output_count: stage1_output_count.max(0) as u64,
                stage1_pending_promotion_count: stage1_pending_promotion_count.max(0) as u64,
                stage1_failed,
                phase2_status: phase2_job.as_ref().map(|job| job.status.clone()),
                phase2_last_finished_at_unix_secs: phase2_job
                    .as_ref()
                    .and_then(|job| job.finished_at_unix_secs),
                phase2_last_error: phase2_job.as_ref().and_then(|job| job.last_error.clone()),
            })
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    /// Bumps `usage_count` / `last_usage` for stage-1 rows referenced by a
    /// memory read.
    ///
    /// `rollout_ids` are matched against session ids. `summary_file_names` are
    /// matched against the rollout-summary file name derived from each live
    /// stage-1 row, with or without the `rollout_summaries/` prefix. Returns the
    /// number of rows updated.
    pub async fn record_memory_usage(
        &self,
        rollout_ids: &[String],
        summary_file_names: &[String],
    ) -> OpenBitFunResult<u64> {
        let db_path = self.db_path.clone();
        let rollout_ids = rollout_ids.to_vec();
        let summary_file_names = summary_file_names.to_vec();
        task::spawn_blocking(move || -> OpenBitFunResult<u64> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;

            let citation = MemoryCitation {
                entries: summary_file_names
                    .iter()
                    .map(|name| MemoryCitationEntry {
                        path: name.clone(),
                        line_start: 0,
                        line_end: 0,
                        note: None,
                    })
                    .collect(),
                rollout_ids: rollout_ids.clone(),
            };
            let mut resolved = resolve_citation_session_ids(&conn, &citation)?;
            for identity in live_rollout_summary_identities_in_conn(&conn)? {
                let file_name =
                    crate::agentic::memories::workspace::rollout_summary_file_name_for_parts(
                        &identity.session_id,
                        identity.source_updated_at_unix_secs,
                        identity.rollout_slug.as_deref(),
                    );
                if summary_file_names
                    .iter()
                    .any(|name| summary_file_name_matches(name, &file_name))
                {
                    push_unique(&mut resolved, &identity.session_id);
                }
            }
            if resolved.is_empty() {
                return Ok(0);
            }

            let tx = conn.transaction().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to begin memory usage transaction: {}",
                    error
                ))
            })?;
            let now = current_unix_secs();
            let mut updated = 0u64;
            for session_id in resolved {
                updated += tx
                    .execute(
                        r#"
                        UPDATE stage1_outputs
                        SET usage_count = COALESCE(usage_count, 0) + 1,
                            last_usage = CASE
                                WHEN last_usage IS NULL OR last_usage < ?2 THEN ?2
                                ELSE last_usage
                            END
                        WHERE thread_id = ?1
                        "#,
                        params![session_id, now],
                    )
                    .map_err(|error| {
                        OpenBitFunError::io(format!("Failed to update memory usage: {}", error))
                    })? as u64;
            }
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory usage transaction: {}",
                    error
                ))
            })?;
            Ok(updated)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn prune_stage1_outputs_for_retention(
        &self,
        max_unused_days: i64,
        limit: usize,
    ) -> OpenBitFunResult<usize> {
        if limit == 0 {
            return Ok(0);
        }

        // Retention never prunes "everything right now": the configured window has a
        // one-day floor, so a misconfigured zero cannot delete live memory input.
        let max_unused_days = max_unused_days.max(1);
        let db_path = self.db_path.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<usize> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let cutoff = current_unix_secs() - max_unused_days * 24 * 60 * 60;
            // Retention uses one clock for every row. Phase-2 selection is not an
            // exemption: a row that is never read again must eventually be pruned
            // so its rollout summary is deleted and the memory workspace forgets
            // the content it no longer has evidence for.
            let pruned = conn
                .execute(
                    r#"
                    DELETE FROM stage1_outputs
                    WHERE thread_id IN (
                        SELECT thread_id
                        FROM stage1_outputs
                        WHERE COALESCE(last_usage, source_updated_at) < ?1
                        ORDER BY
                          COALESCE(last_usage, source_updated_at) ASC,
                          source_updated_at ASC,
                          thread_id ASC
                        LIMIT ?2
                    )
                    "#,
                    params![cutoff, limit as i64],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to prune stale memory stage1 outputs: {}",
                        error
                    ))
                })?;
            Ok(pruned)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories prune task failed: {}", error))
        })?
    }

    async fn list_phase2_candidates_inner(
        &self,
        limit: usize,
        max_unused_days: i64,
        only_unselected: bool,
    ) -> OpenBitFunResult<Vec<MemoryPhase2CandidateRow>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let db_path = self.db_path.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<Vec<MemoryPhase2CandidateRow>> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            // The usage window shares the retention clock floor of one day.
            let cutoff = current_unix_secs() - max_unused_days.max(1) * 24 * 60 * 60;
            let mut sql = String::from(
                r#"
                SELECT thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
                       rollout_summary, rollout_slug, generated_at,
                       COALESCE(usage_count, 0), last_usage, selected_for_phase2,
                       selected_for_phase2_source_updated_at
                FROM stage1_outputs
                WHERE (length(trim(raw_memory)) > 0 OR length(trim(rollout_summary)) > 0)
                  AND (
                        (last_usage IS NOT NULL AND last_usage >= ?1)
                        OR (last_usage IS NULL AND source_updated_at >= ?1)
                  )
                "#,
            );
            if only_unselected {
                sql.push_str(" AND selected_for_phase2 = 0");
            }
            sql.push_str(
                r#"
                ORDER BY
                    COALESCE(usage_count, 0) DESC,
                    COALESCE(last_usage, source_updated_at) DESC,
                    source_updated_at DESC,
                    thread_id DESC
                LIMIT ?2
                "#,
            );
            let mut stmt = conn.prepare(&sql).map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to prepare memory phase2 candidate query: {}",
                    error
                ))
            })?;
            let rows = stmt
                .query_map(params![cutoff, limit as i64], row_to_phase2_candidate)
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to query memory phase2 candidates: {}",
                        error
                    ))
                })?;
            collect_rows(rows, "memory phase2 candidate")
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    pub async fn mark_phase2_candidates_selected(
        &self,
        session_ids: &[String],
        source_updated_at_unix_secs: i64,
    ) -> OpenBitFunResult<()> {
        let db_path = self.db_path.clone();
        let session_ids = session_ids.to_vec();
        task::spawn_blocking(move || -> OpenBitFunResult<()> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let tx = conn.transaction().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to begin memory phase2 selection transaction: {}",
                    error
                ))
            })?;
            tx.execute(
                r#"
                UPDATE stage1_outputs
                SET selected_for_phase2 = 0,
                    selected_for_phase2_source_updated_at = NULL
                WHERE selected_for_phase2 != 0
                   OR selected_for_phase2_source_updated_at IS NOT NULL
                "#,
                [],
            )
            .map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to clear previous memory phase2 selection: {}",
                    error
                ))
            })?;
            for session_id in session_ids {
                tx.execute(
                    r#"
                    UPDATE stage1_outputs
                    SET selected_for_phase2 = 1,
                        selected_for_phase2_source_updated_at = ?2
                    WHERE thread_id = ?1
                    "#,
                    params![session_id, source_updated_at_unix_secs],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to mark memory row selected for phase2: {}",
                        error
                    ))
                })?;
            }
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory phase2 selection transaction: {}",
                    error
                ))
            })?;
            Ok(())
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    /// Persists the phase-2 input watermark for a non-empty selection.
    ///
    /// Returns `Ok(None)` when nothing was selected: an empty selection has no
    /// input to record, and callers must not treat it as a consolidation input.
    pub async fn upsert_phase2_selection(
        &self,
        job_key: &str,
        selected_rows: &[MemoryPhase2CandidateRow],
    ) -> OpenBitFunResult<Option<MemoryPhase2SelectionRow>> {
        if selected_rows.is_empty() {
            return Ok(None);
        }

        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        let max_source_updated_at = selected_rows
            .iter()
            .map(|row| row.source_updated_at_unix_secs)
            .max()
            .unwrap_or_default();
        task::spawn_blocking(
            move || -> OpenBitFunResult<Option<MemoryPhase2SelectionRow>> {
                let conn = open_connection(&db_path)?;
                initialize_schema(&conn)?;
                let existing =
                    get_job_in_connection(&conn, JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, &job_key)?;
                let input_watermark = existing
                    .as_ref()
                    .and_then(|row| row.input_watermark)
                    .map(|watermark| watermark.saturating_add(1).max(max_source_updated_at))
                    .unwrap_or(max_source_updated_at);
                conn.execute(
                    r#"
                INSERT INTO jobs (
                    kind, job_key, status, retry_remaining, input_watermark
                )
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(kind, job_key) DO UPDATE SET
                    input_watermark = excluded.input_watermark
                "#,
                    params![
                        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                        job_key,
                        JOB_STATUS_RUNNING,
                        DEFAULT_RETRY_REMAINING,
                        input_watermark,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to upsert memory phase2 selection: {}",
                        error
                    ))
                })?;
                Ok(Some(MemoryPhase2SelectionRow {
                    job_key,
                    input_watermark,
                }))
            },
        )
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn phase2_selected_for_session(&self, session_id: &str) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let session_id = session_id.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let selected = conn
                .query_row(
                    "SELECT selected_for_phase2 FROM stage1_outputs WHERE thread_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to query memory phase2 selection: {}",
                        error
                    ))
                })?;
            Ok(selected.unwrap_or_default() != 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    pub async fn enqueue_phase2_job(
        &self,
        job_key: &str,
        input_watermark: i64,
    ) -> OpenBitFunResult<()> {
        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<()> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            conn.execute(
                r#"
                INSERT INTO jobs (
                    kind, job_key, status, retry_remaining, input_watermark
                )
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(kind, job_key) DO UPDATE SET
                    status = excluded.status,
                    ownership_token = NULL,
                    worker_id = NULL,
                    lease_until = NULL,
                    retry_at = NULL,
                    last_error = NULL,
                    input_watermark = MAX(COALESCE(jobs.input_watermark, 0), excluded.input_watermark)
                "#,
                params![
                    JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                    job_key,
                    JOB_STATUS_DONE,
                    DEFAULT_RETRY_REMAINING,
                    input_watermark,
                ],
            )
            .map_err(|error| {
                OpenBitFunError::io(format!("Failed to enqueue memory phase2 job: {}", error))
            })?;
            Ok(())
        })
        .await
        .map_err(|error| OpenBitFunError::service(format!("Memories write task failed: {}", error)))?
    }

    pub async fn list_recent(&self, limit: usize) -> OpenBitFunResult<Vec<MemoryRow>> {
        if limit == 0 {
            return Ok(Vec::new());
        }

        let db_path = self.db_path.clone();
        task::spawn_blocking(move || -> OpenBitFunResult<Vec<MemoryRow>> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let mut stmt = conn
                .prepare(
                    r#"
                    SELECT thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
                           rollout_summary, rollout_slug, generated_at,
                           COALESCE(usage_count, 0), last_usage, selected_for_phase2,
                           selected_for_phase2_source_updated_at
                    FROM stage1_outputs
                    ORDER BY source_updated_at DESC, thread_id DESC
                    LIMIT ?1
                    "#,
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to prepare memory list query: {}", error))
                })?;
            let rows = stmt
                .query_map(params![limit as i64], row_to_memory)
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to query memory rows: {}", error))
                })?;
            collect_rows(rows, "memory row")
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    pub async fn get_phase2_job(&self, job_key: &str) -> OpenBitFunResult<Option<MemoryJobRow>> {
        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<Option<MemoryJobRow>> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            get_job_in_connection(&conn, JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, &job_key)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories read task failed: {}", error))
        })?
    }

    /// True while a phase-2 consolidation run owns the global job and is
    /// heartbeat-live.
    ///
    /// This applies the same rule `claim_phase2_job` uses before refusing a claim
    /// with `SkippedRunning`, exposed as a read-only query so status surfaces and
    /// trigger paths do not reimplement the stale-lease logic. The lease length
    /// comes from the same helper the claim path uses, so both always judge the
    /// same job with the same window.
    ///
    /// Returns false when the global job is missing, released or finished
    /// (`ownership_token` cleared), or when its owner stopped heartbeating long
    /// enough for the lease to drain past the stale window.
    pub async fn phase2_has_live_run(&self) -> OpenBitFunResult<bool> {
        let Some(job) = self.get_phase2_job(MEMORY_PHASE2_GLOBAL_JOB_KEY).await? else {
            return Ok(false);
        };
        Ok(phase2_owner_is_live(
            job.ownership_token.as_deref(),
            job.lease_until_unix_secs,
            super::runner::phase2_lease_seconds().await?,
            current_unix_secs(),
        ))
    }

    pub async fn claim_phase2_job(
        &self,
        job_key: &str,
        ownership_token: &str,
        input_watermark: i64,
        lease_seconds: i64,
    ) -> OpenBitFunResult<MemoryPhase2ClaimOutcome> {
        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<MemoryPhase2ClaimOutcome> {
            let mut conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to begin memory phase2 claim transaction: {}",
                        error
                    ))
                })?;
            let now = current_unix_secs();
            if let Some(existing) =
                get_job_in_tx(&tx, JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL, &job_key)?
            {
                if phase2_owner_is_live(
                    existing.ownership_token.as_deref(),
                    existing.lease_until_unix_secs,
                    lease_seconds,
                    now,
                ) {
                    tx.commit().map_err(|error| {
                        OpenBitFunError::io(format!(
                            "Failed to commit memory phase2 running skip transaction: {}",
                            error
                        ))
                    })?;
                    return Ok(MemoryPhase2ClaimOutcome::SkippedRunning);
                }
                if existing.ownership_token.is_some() {
                    // The previous owner stopped refreshing its lease, so it died or
                    // was killed mid-consolidation. Reclaiming here is what keeps a
                    // crashed run from blocking the pipeline until the full lease
                    // expires.
                    info!(
                        "Memory phase2 job claim reclaiming an abandoned lease: job_key={}, previous_ownership_token={:?}, lease_until_unix_secs={:?}, lease_seconds={}, now={}, stale_after_seconds={}",
                        job_key,
                        existing.ownership_token,
                        existing.lease_until_unix_secs,
                        lease_seconds,
                        now,
                        PHASE2_HEARTBEAT_STALE_SECONDS
                    );
                }
                if existing
                    .retry_at_unix_secs
                    .is_some_and(|retry_at| retry_at > now)
                {
                    tx.commit().map_err(|error| {
                        OpenBitFunError::io(format!(
                            "Failed to commit memory phase2 retry skip transaction: {}",
                            error
                        ))
                    })?;
                    return Ok(MemoryPhase2ClaimOutcome::SkippedRetryBackoff);
                }
            }

            let lease_until = now.saturating_add(lease_seconds.max(0));
            tx.execute(
                r#"
                INSERT INTO jobs (
                    kind, job_key, status, worker_id, ownership_token, started_at,
                    finished_at, lease_until, retry_at, retry_remaining, last_error,
                    input_watermark
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL, ?8, NULL, ?9)
                ON CONFLICT(kind, job_key) DO UPDATE SET
                    status = excluded.status,
                    worker_id = excluded.worker_id,
                    ownership_token = excluded.ownership_token,
                    started_at = excluded.started_at,
                    finished_at = NULL,
                    lease_until = excluded.lease_until,
                    retry_at = NULL,
                    retry_remaining = excluded.retry_remaining,
                    last_error = NULL,
                    input_watermark = excluded.input_watermark
                "#,
                params![
                    JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                    job_key,
                    JOB_STATUS_RUNNING,
                    "memory-phase2",
                    ownership_token,
                    now,
                    lease_until,
                    DEFAULT_RETRY_REMAINING,
                    input_watermark,
                ],
            )
            .map_err(|error| {
                OpenBitFunError::io(format!("Failed to claim memory phase2 job: {}", error))
            })?;
            tx.commit().map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to commit memory phase2 claim transaction: {}",
                    error
                ))
            })?;
            Ok(MemoryPhase2ClaimOutcome::Claimed)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn complete_phase2_job_success(
        &self,
        job_key: &str,
        ownership_token: &str,
        input_watermark: i64,
    ) -> OpenBitFunResult<bool> {
        self.complete_phase2_job(job_key, ownership_token, input_watermark, true, None)
            .await
    }

    pub async fn complete_phase2_job_idle(
        &self,
        job_key: &str,
        ownership_token: &str,
        input_watermark: i64,
    ) -> OpenBitFunResult<bool> {
        self.complete_phase2_job(job_key, ownership_token, input_watermark, false, None)
            .await
    }

    async fn complete_phase2_job(
        &self,
        job_key: &str,
        ownership_token: &str,
        input_watermark: i64,
        successful_consolidation: bool,
        error: Option<String>,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let now = current_unix_secs();
            let rows_affected = conn
                .execute(
                    r#"
                    UPDATE jobs
                    SET status = ?1,
                        ownership_token = NULL,
                        worker_id = NULL,
                        finished_at = ?2,
                        lease_until = NULL,
                        retry_at = NULL,
                        retry_remaining = ?3,
                        last_error = ?4,
                        input_watermark = ?5,
                        last_success_watermark = CASE
                            WHEN ?6 != 0 THEN ?5
                            ELSE last_success_watermark
                        END
                    WHERE kind = ?7
                      AND job_key = ?8
                      AND ownership_token = ?9
                      AND lease_until IS NOT NULL
                    "#,
                    params![
                        if error.is_some() {
                            JOB_STATUS_ERROR
                        } else {
                            JOB_STATUS_DONE
                        },
                        now,
                        DEFAULT_RETRY_REMAINING,
                        error,
                        input_watermark,
                        if successful_consolidation { 1 } else { 0 },
                        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                        job_key,
                        ownership_token,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to complete memory phase2 job: {}", error))
                })?;
            Ok(rows_affected > 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn complete_phase2_job_failure(
        &self,
        job_key: &str,
        ownership_token: &str,
        retry_after_unix_secs: i64,
        error: String,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let now = current_unix_secs();
            let rows_affected = conn
                .execute(
                    r#"
                    UPDATE jobs
                    SET status = ?1,
                        ownership_token = NULL,
                        worker_id = NULL,
                        finished_at = ?2,
                        lease_until = NULL,
                        retry_at = ?3,
                        retry_remaining = MAX(retry_remaining - 1, 0),
                        last_error = ?4
                    WHERE kind = ?5
                      AND job_key = ?6
                      AND ownership_token = ?7
                      AND lease_until IS NOT NULL
                    "#,
                    params![
                        JOB_STATUS_ERROR,
                        now,
                        retry_after_unix_secs,
                        error,
                        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                        job_key,
                        ownership_token,
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!("Failed to fail memory phase2 job: {}", error))
                })?;
            Ok(rows_affected > 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }

    pub async fn touch_phase2_job_heartbeat(
        &self,
        job_key: &str,
        ownership_token: &str,
        heartbeat_at_unix_secs: i64,
        lease_seconds: i64,
    ) -> OpenBitFunResult<bool> {
        let db_path = self.db_path.clone();
        let job_key = job_key.to_string();
        let ownership_token = ownership_token.to_string();
        task::spawn_blocking(move || -> OpenBitFunResult<bool> {
            let conn = open_connection(&db_path)?;
            initialize_schema(&conn)?;
            let lease_until = heartbeat_at_unix_secs.saturating_add(lease_seconds.max(0));
            let rows_affected = conn
                .execute(
                    r#"
                    UPDATE jobs
                    SET lease_until = ?1
                    WHERE kind = ?2
                      AND job_key = ?3
                      AND ownership_token = ?4
                      AND lease_until IS NOT NULL
                    "#,
                    params![
                        lease_until,
                        JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                        job_key,
                        ownership_token
                    ],
                )
                .map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to update memory phase2 heartbeat: {}",
                        error
                    ))
                })?;
            Ok(rows_affected > 0)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Memories write task failed: {}", error))
        })?
    }
}

fn open_connection(path: &Path) -> OpenBitFunResult<Connection> {
    Connection::open(path).map_err(|error| {
        OpenBitFunError::io(format!(
            "Failed to open memories database {}: {}",
            path.display(),
            error
        ))
    })
}

fn initialize_schema(conn: &Connection) -> OpenBitFunResult<()> {
    initialize_memory_schema(conn).map_err(|error| {
        OpenBitFunError::io(format!("Failed to initialize memories schema: {error}"))
    })
}

#[cfg(test)]
fn table_columns(conn: &Connection, table_name: &str) -> OpenBitFunResult<Vec<String>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to inspect memories table {}: {}",
                table_name, error
            ))
        })?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query memories table {} columns: {}",
                table_name, error
            ))
        })?;
    let mut columns = Vec::new();
    for row in rows {
        let column = row.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to decode memories table {} column: {}",
                table_name, error
            ))
        })?;
        columns.push(column);
    }
    Ok(columns)
}

fn clear_memory_state_in_conn(conn: &Connection) -> OpenBitFunResult<()> {
    conn.execute_batch(
        r#"
        DELETE FROM stage1_outputs;
        DELETE FROM jobs;
        "#,
    )
    .map_err(|error| OpenBitFunError::io(format!("Failed to clear memories state: {}", error)))?;
    Ok(())
}

fn upsert_stage1_output_conn(
    conn: &Connection,
    row: &MemoryRow,
    overwrite_usage_and_selection: bool,
) -> OpenBitFunResult<()> {
    upsert_memory_record(conn, row, overwrite_usage_and_selection).map_err(|error| {
        OpenBitFunError::io(format!("Failed to upsert memory stage1 output: {error}"))
    })
}

fn upsert_stage1_output_tx(
    tx: &Transaction<'_>,
    row: &MemoryRow,
    overwrite_usage_and_selection: bool,
) -> OpenBitFunResult<()> {
    upsert_memory_record(tx, row, overwrite_usage_and_selection).map_err(|error| {
        OpenBitFunError::io(format!("Failed to upsert memory stage1 output: {error}"))
    })
}

fn phase1_source_needs_update_in_conn(
    conn: &Connection,
    session_id: &str,
    session_finished_at_unix_secs: i64,
) -> OpenBitFunResult<bool> {
    let output_watermark = conn
        .query_row(
            "SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?1",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query memory stage1 output state: {}",
                error
            ))
        })?;
    if output_watermark.is_some_and(|watermark| watermark >= session_finished_at_unix_secs) {
        return Ok(false);
    }

    let last_success_watermark = conn
        .query_row(
            r#"
            SELECT last_success_watermark
            FROM jobs
            WHERE kind = ?1 AND job_key = ?2
            "#,
            params![JOB_KIND_MEMORY_STAGE1, session_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query memory phase1 job watermark: {}",
                error
            ))
        })?
        .flatten();
    Ok(last_success_watermark.is_none_or(|watermark| watermark < session_finished_at_unix_secs))
}

fn try_claim_phase1_job_in_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    worker_id: &str,
    session_finished_at_unix_secs: i64,
    lease_seconds: i64,
    max_running_jobs: usize,
) -> OpenBitFunResult<MemoryPhase1ClaimOutcome> {
    if !phase1_source_needs_update_in_tx(tx, session_id, session_finished_at_unix_secs)? {
        return Ok(MemoryPhase1ClaimOutcome::SkippedUpToDate);
    }

    let now = current_unix_secs();
    let running_count = tx
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM jobs
            WHERE kind = ?1
              AND status = ?2
              AND lease_until IS NOT NULL
              AND lease_until > ?3
            "#,
            params![JOB_KIND_MEMORY_STAGE1, JOB_STATUS_RUNNING, now],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to count running memory phase1 jobs: {}",
                error
            ))
        })?;
    if running_count >= max_running_jobs as i64 {
        return Ok(MemoryPhase1ClaimOutcome::SkippedRunning);
    }

    let existing = get_job_in_tx(tx, JOB_KIND_MEMORY_STAGE1, session_id)?;
    if let Some(existing) = existing.as_ref() {
        if existing.status == JOB_STATUS_RUNNING
            && existing
                .lease_until_unix_secs
                .is_some_and(|lease_until| lease_until > now)
        {
            return Ok(MemoryPhase1ClaimOutcome::SkippedRunning);
        }
        if existing.input_watermark == Some(session_finished_at_unix_secs) {
            if existing.retry_remaining <= 0
                && !phase1_retry_exhaustion_quarantine_elapsed(existing, now)
            {
                return Ok(MemoryPhase1ClaimOutcome::SkippedRetryExhausted);
            }
            if existing
                .retry_at_unix_secs
                .is_some_and(|retry_at| retry_at > now)
            {
                return Ok(MemoryPhase1ClaimOutcome::SkippedRetryBackoff);
            }
        }
    }

    let ownership_token = Uuid::new_v4().to_string();
    let lease_until = now.saturating_add(lease_seconds.max(0));
    // An exhausted budget is restored to the default attempt budget once the
    // quarantine window has passed, so a transient failure cannot dead-end a
    // session forever.
    let retry_remaining = existing
        .as_ref()
        .filter(|job| {
            job.input_watermark == Some(session_finished_at_unix_secs) && job.retry_remaining > 0
        })
        .map(|job| job.retry_remaining)
        .unwrap_or(DEFAULT_RETRY_REMAINING);
    tx.execute(
        r#"
        INSERT INTO jobs (
            kind, job_key, status, worker_id, ownership_token, started_at,
            finished_at, lease_until, retry_at, retry_remaining, last_error,
            input_watermark, last_success_watermark
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL, ?8, NULL, ?9, NULL)
        ON CONFLICT(kind, job_key) DO UPDATE SET
            status = excluded.status,
            worker_id = excluded.worker_id,
            ownership_token = excluded.ownership_token,
            started_at = excluded.started_at,
            finished_at = NULL,
            lease_until = excluded.lease_until,
            retry_at = NULL,
            retry_remaining = excluded.retry_remaining,
            last_error = NULL,
            input_watermark = excluded.input_watermark
        "#,
        params![
            JOB_KIND_MEMORY_STAGE1,
            session_id,
            JOB_STATUS_RUNNING,
            worker_id,
            ownership_token,
            now,
            lease_until,
            retry_remaining,
            session_finished_at_unix_secs,
        ],
    )
    .map_err(|error| {
        OpenBitFunError::io(format!("Failed to claim memory phase1 job: {}", error))
    })?;

    Ok(MemoryPhase1ClaimOutcome::Claimed { ownership_token })
}

fn phase1_source_needs_update_in_tx(
    tx: &Transaction<'_>,
    session_id: &str,
    session_finished_at_unix_secs: i64,
) -> OpenBitFunResult<bool> {
    let output_watermark = tx
        .query_row(
            "SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?1",
            params![session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query memory stage1 output state: {}",
                error
            ))
        })?;
    if output_watermark.is_some_and(|watermark| watermark >= session_finished_at_unix_secs) {
        return Ok(false);
    }

    let last_success_watermark = tx
        .query_row(
            r#"
            SELECT last_success_watermark
            FROM jobs
            WHERE kind = ?1 AND job_key = ?2
            "#,
            params![JOB_KIND_MEMORY_STAGE1, session_id],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query memory phase1 job watermark: {}",
                error
            ))
        })?
        .flatten();
    Ok(last_success_watermark.is_none_or(|watermark| watermark < session_finished_at_unix_secs))
}

fn phase1_retry_exhaustion_quarantine_elapsed(job: &MemoryJobRow, now: i64) -> bool {
    job.finished_at_unix_secs.is_some_and(|finished_at| {
        now.saturating_sub(finished_at) >= PHASE1_RETRY_EXHAUSTION_QUARANTINE_SECONDS
    })
}

/// Cooldown that keeps a clean, finished phase-2 run from being repeated.
///
/// The predicate is owned here rather than by the shared memory store because the
/// freshness decision belongs to the runner: a completion only reports a cooldown
/// when the last run finished cleanly, and the runner decides whether the run has
/// work by comparing its evaluated `input_watermark` and the workspace diff.
/// An idle completion advances `input_watermark` without stamping
/// `last_success_watermark`, so comparing those two watermarks would disarm the
/// cooldown after every no-op run and let each later pass redo the whole
/// evaluation.
pub(crate) fn phase2_success_cooldown_until_unix_secs(
    job: &MemoryJobRow,
    cooldown_seconds: i64,
) -> Option<i64> {
    if job.kind != JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL
        || job.status != JOB_STATUS_DONE
        || job.last_error.is_some()
        || job.input_watermark.is_none()
    {
        return None;
    }

    job.finished_at_unix_secs
        .map(|finished_at| finished_at.saturating_add(cooldown_seconds.max(0)))
}

/// Whether the incumbent phase-2 owner is still alive.
///
/// A live owner refreshes its lease on every heartbeat (every 30 seconds), so its
/// remaining lease stays close to the configured length. A process that died or
/// was killed mid-consolidation stops refreshing and its remaining lease drains
/// past the stale window within roughly `PHASE2_HEARTBEAT_STALE_SECONDS`, which
/// makes the job claimable again long before the full lease expires.
///
/// The comparison is relative to the configured lease length rather than a stored
/// heartbeat timestamp, so it stays correct for a lease written by an older build
/// that keeps refreshing: a live old-version run also holds a fresh lease.
///
/// Precondition: the incumbent claimed the job with the same `lease_seconds` this
/// caller passes. Raising `memories.phase2_lease_seconds` while a run is in flight
/// makes that run's remaining lease look short relative to the new, longer lease,
/// so it can be judged stale even though it is still heartbeating. Lowering the
/// setting is safe (the incumbent then only looks fresher). A configuration change
/// therefore must not be treated as a liveness signal on its own, and the cost of
/// the wrong call is bounded: a second run starts, and the ownership-token
/// compare-and-swap keeps exactly one of them able to complete the job.
fn phase2_owner_is_live(
    ownership_token: Option<&str>,
    lease_until_unix_secs: Option<i64>,
    lease_seconds: i64,
    now_unix_secs: i64,
) -> bool {
    if ownership_token.is_none() {
        return false;
    }
    let Some(lease_until) = lease_until_unix_secs else {
        return false;
    };
    if lease_until <= now_unix_secs {
        return false;
    }
    // Remaining lease that still proves a recent heartbeat. A lease shorter than
    // the stale window falls back to plain expiry, because a heartbeat every 30
    // seconds cannot keep such a lease meaningfully fresh.
    let fresh_lease_seconds = (lease_seconds - PHASE2_HEARTBEAT_STALE_SECONDS).max(0);
    lease_until > now_unix_secs.saturating_add(fresh_lease_seconds)
}

fn live_rollout_summary_identities_in_conn(
    conn: &Connection,
) -> OpenBitFunResult<Vec<MemoryRolloutSummaryIdentity>> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT thread_id, source_updated_at, rollout_slug
            FROM stage1_outputs
            ORDER BY thread_id ASC
            "#,
        )
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to prepare live memory stage1 identity query: {}",
                error
            ))
        })?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MemoryRolloutSummaryIdentity {
                session_id: row.get(0)?,
                source_updated_at_unix_secs: row.get(1)?,
                rollout_slug: row.get(2)?,
            })
        })
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query live memory stage1 identities: {}",
                error
            ))
        })?;
    collect_rows(rows, "memory stage1 identity")
}

fn summary_file_name_matches(candidate: &str, file_name: &str) -> bool {
    let normalized = candidate.replace('\\', "/");
    let normalized = normalized.trim_start_matches("./");
    normalized == file_name || normalized.strip_prefix("rollout_summaries/") == Some(file_name)
}

fn phase1_owned_input_watermark(
    tx: &Transaction<'_>,
    session_id: &str,
    ownership_token: &str,
) -> OpenBitFunResult<i64> {
    tx.query_row(
        r#"
        SELECT input_watermark
        FROM jobs
        WHERE kind = ?1
          AND job_key = ?2
          AND status = ?3
          AND ownership_token = ?4
        "#,
        params![
            JOB_KIND_MEMORY_STAGE1,
            session_id,
            JOB_STATUS_RUNNING,
            ownership_token
        ],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|error| {
        OpenBitFunError::io(format!(
            "Memory phase1 job ownership is no longer valid for session {}: {}",
            session_id, error
        ))
    })
}

fn get_job_in_connection(
    conn: &Connection,
    kind: &str,
    job_key: &str,
) -> OpenBitFunResult<Option<MemoryJobRow>> {
    conn.query_row(
        r#"
        SELECT kind, job_key, status, worker_id, ownership_token, started_at,
               finished_at, lease_until, retry_at, retry_remaining, last_error,
               input_watermark, last_success_watermark
        FROM jobs
        WHERE kind = ?1 AND job_key = ?2
        "#,
        params![kind, job_key],
        row_to_job,
    )
    .optional()
    .map_err(|error| OpenBitFunError::io(format!("Failed to query memory job: {}", error)))
}

fn get_job_in_tx(
    tx: &Transaction<'_>,
    kind: &str,
    job_key: &str,
) -> OpenBitFunResult<Option<MemoryJobRow>> {
    tx.query_row(
        r#"
        SELECT kind, job_key, status, worker_id, ownership_token, started_at,
               finished_at, lease_until, retry_at, retry_remaining, last_error,
               input_watermark, last_success_watermark
        FROM jobs
        WHERE kind = ?1 AND job_key = ?2
        "#,
        params![kind, job_key],
        row_to_job,
    )
    .optional()
    .map_err(|error| OpenBitFunError::io(format!("Failed to query memory job: {}", error)))
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryJobRow> {
    decode_memory_job(row)
}

fn row_to_memory(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRow> {
    decode_memory_record(row)
}

fn row_to_phase2_candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryPhase2CandidateRow> {
    Ok(MemoryPhase2CandidateRow {
        session_id: row.get(0)?,
        workspace_path: row.get(1)?,
        rollout_path: row.get(2)?,
        source_updated_at_unix_secs: row.get(3)?,
        raw_memory: row.get(4)?,
        rollout_summary: row.get(5)?,
        rollout_slug: row.get(6)?,
        generated_at_unix_secs: row.get(7)?,
        usage_count: row.get(8)?,
        last_usage_unix_secs: row.get(9)?,
        selected_for_phase2: row.get(10)?,
        selected_for_phase2_source_updated_at: row.get(11)?,
    })
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
    label: &str,
) -> OpenBitFunResult<Vec<T>> {
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| {
            OpenBitFunError::io(format!("Failed to decode {}: {}", label, error))
        })?);
    }
    Ok(items)
}

fn current_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn resolve_citation_session_ids(
    conn: &Connection,
    citation: &MemoryCitation,
) -> OpenBitFunResult<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT thread_id FROM stage1_outputs")
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to prepare memory citation resolution query: {}",
                error
            ))
        })?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to query memory citation sessions: {}",
                error
            ))
        })?;
    let mut known_session_ids = Vec::new();
    for row in rows {
        known_session_ids.push(row.map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to decode memory citation session: {}",
                error
            ))
        })?);
    }

    let mut resolved = Vec::new();
    for rollout_id in &citation.rollout_ids {
        if known_session_ids
            .iter()
            .any(|session_id| session_id == rollout_id)
        {
            push_unique(&mut resolved, rollout_id);
        }
    }
    for entry in &citation.entries {
        if let Some(session_id) =
            resolve_session_id_from_entry_path(&entry.path, &known_session_ids)
        {
            push_unique(&mut resolved, &session_id);
        }
    }
    Ok(resolved)
}

fn resolve_session_id_from_entry_path(path: &str, known_session_ids: &[String]) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let mut best: Option<&String> = None;
    for session_id in known_session_ids {
        if !normalized.contains(session_id) {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|current| session_id.len() > current.len())
        {
            best = Some(session_id);
        }
    }
    best.cloned()
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::app_paths::PathManager;
    use tempfile::tempdir;

    fn test_memory_row(session_id: &str, source_updated_at: i64) -> MemoryRow {
        MemoryRow {
            session_id: session_id.to_string(),
            workspace_path: "/workspace".to_string(),
            rollout_path: format!("/workspace/sessions/{session_id}"),
            source_updated_at_unix_secs: source_updated_at,
            raw_memory: format!("memory {session_id}"),
            rollout_summary: format!("summary {session_id}"),
            rollout_slug: Some(format!("slug-{session_id}")),
            generated_at_unix_secs: source_updated_at + 1,
            usage_count: 0,
            last_usage_unix_secs: None,
            selected_for_phase2: 0,
            selected_for_phase2_source_updated_at: None,
        }
    }

    fn claim_token(outcome: MemoryPhase1ClaimOutcome) -> String {
        match outcome {
            MemoryPhase1ClaimOutcome::Claimed { ownership_token } => ownership_token,
            other => panic!("expected claim, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn schema_uses_codex_stage1_outputs_and_jobs_tables() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let conn = open_connection(db.path()).unwrap();
        let tables = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(tables, vec!["jobs", "stage1_outputs"]);
        assert_eq!(
            table_columns(&conn, "jobs").unwrap(),
            EXPECTED_JOBS_COLUMNS
                .iter()
                .map(|column| column.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            table_columns(&conn, "stage1_outputs").unwrap(),
            EXPECTED_STAGE1_COLUMNS
                .iter()
                .map(|column| column.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn phase1_success_persists_stage1_output_and_job_watermark() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let token = claim_token(
            db.try_claim_phase1_job("session-a", "worker", 100, 60, 2)
                .await
                .unwrap(),
        );
        assert!(db
            .mark_phase1_job_succeeded(&test_memory_row("session-a", 100), &token)
            .await
            .unwrap());

        assert!(!db
            .phase1_source_needs_update("session-a", 100)
            .await
            .unwrap());
        let row = db.list_recent(10).await.unwrap().pop().unwrap();
        assert_eq!(row.session_id, "session-a");
        assert_eq!(row.rollout_path, "/workspace/sessions/session-a");
        assert_eq!(row.source_updated_at_unix_secs, 100);
        assert_eq!(row.raw_memory, "memory session-a");
    }

    #[tokio::test]
    async fn phase1_no_output_records_job_without_stage1_row() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let token = claim_token(
            db.try_claim_phase1_job("session-a", "worker", 100, 60, 2)
                .await
                .unwrap(),
        );
        assert!(db
            .mark_phase1_job_succeeded_no_output("session-a", &token)
            .await
            .unwrap());

        assert!(db.list_recent(10).await.unwrap().is_empty());
        assert!(!db
            .phase1_source_needs_update("session-a", 100)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn phase1_failure_uses_jobs_retry_at() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let token = claim_token(
            db.try_claim_phase1_job("session-a", "worker", 100, 60, 2)
                .await
                .unwrap(),
        );
        assert!(db
            .mark_phase1_job_failed("session-a", &token, 3600, "boom".to_string())
            .await
            .unwrap());

        let outcome = db
            .try_claim_phase1_job("session-a", "worker", 100, 60, 2)
            .await
            .unwrap();
        assert_eq!(outcome, MemoryPhase1ClaimOutcome::SkippedRetryBackoff);
    }

    #[tokio::test]
    async fn citation_updates_stage1_usage_without_citation_table() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        db.upsert_memory(&test_memory_row("session-a", 100))
            .await
            .unwrap();

        db.record_memory_citation(
            "reader-session",
            None,
            None,
            "message-1",
            &MemoryCitation {
                entries: vec![crate::agentic::core::message::MemoryCitationEntry {
                    path: "rollout_summaries/session-a-slug.md".to_string(),
                    line_start: 1,
                    line_end: 1,
                    note: None,
                }],
                rollout_ids: Vec::new(),
            },
        )
        .await
        .unwrap();

        let row = db.list_recent(10).await.unwrap().pop().unwrap();
        assert_eq!(row.usage_count, 1);
        assert!(row.last_usage_unix_secs.is_some());
    }

    #[tokio::test]
    async fn phase2_candidates_rank_by_usage_then_freshness_and_skip_selected_rows() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let now = current_unix_secs();
        let mut row_a = test_memory_row("session-a", now - 100);
        row_a.usage_count = 5;
        row_a.last_usage_unix_secs = Some(now - 20);
        let mut row_b = test_memory_row("session-b", now - 90);
        row_b.usage_count = 5;
        row_b.last_usage_unix_secs = Some(now - 10);
        let mut row_c = test_memory_row("session-c", now - 80);
        row_c.usage_count = 20;
        row_c.last_usage_unix_secs = Some(now - 40 * 24 * 60 * 60);
        for row in [&row_a, &row_b, &row_c] {
            db.upsert_memory(row).await.unwrap();
        }

        let selected = db.list_phase2_candidates(2, 30).await.unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-b", "session-a"]
        );

        db.mark_phase2_candidates_selected(&["session-b".to_string()], 400)
            .await
            .unwrap();

        let selected = db.list_phase2_candidates(2, 30).await.unwrap();
        assert_eq!(selected[0].session_id, "session-a");
        assert_eq!(selected[0].selected_for_phase2, 0);
        assert!(db.phase2_selected_for_session("session-b").await.unwrap());
    }

    #[tokio::test]
    async fn prune_stage1_outputs_for_retention_uses_one_clock_for_every_row() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let now = current_unix_secs();
        let mut stale_unselected = test_memory_row("stale-unselected", now - 40 * 24 * 60 * 60);
        stale_unselected.last_usage_unix_secs = Some(now - 31 * 24 * 60 * 60);
        let mut stale_selected = test_memory_row("stale-selected", now - 40 * 24 * 60 * 60);
        stale_selected.last_usage_unix_secs = Some(now - 31 * 24 * 60 * 60);
        stale_selected.selected_for_phase2 = 1;
        stale_selected.selected_for_phase2_source_updated_at =
            Some(stale_selected.source_updated_at_unix_secs);
        let fresh_unselected = test_memory_row("fresh-unselected", now - 5 * 24 * 60 * 60);

        for row in [&stale_unselected, &stale_selected, &fresh_unselected] {
            db.upsert_memory(row).await.unwrap();
        }

        assert_eq!(
            db.prune_stage1_outputs_for_retention(30, 100)
                .await
                .unwrap(),
            2
        );

        let remaining = db
            .list_recent(10)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.session_id)
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec!["fresh-unselected"]);
    }

    #[tokio::test]
    async fn prune_stage1_outputs_for_retention_respects_batch_limit() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let now = current_unix_secs();
        for index in 0..3 {
            db.upsert_memory(&test_memory_row(
                &format!("stale-{index}"),
                now - (40 + index) * 24 * 60 * 60,
            ))
            .await
            .unwrap();
        }

        assert_eq!(
            db.prune_stage1_outputs_for_retention(30, 2).await.unwrap(),
            2
        );
        assert_eq!(db.list_recent(10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn retention_keeps_a_one_day_floor_for_a_zero_window() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let now = current_unix_secs();
        let mut recently_used = test_memory_row("recently-used", now - 60 * 60);
        recently_used.last_usage_unix_secs = Some(now - 60);
        db.upsert_memory(&recently_used).await.unwrap();

        assert_eq!(
            db.prune_stage1_outputs_for_retention(0, 100).await.unwrap(),
            0,
            "a zero window must not prune everything immediately"
        );
        assert_eq!(
            db.prune_stage1_outputs_for_retention(1, 100).await.unwrap(),
            0
        );

        let mut long_unused = test_memory_row("long-unused", now - 10 * 24 * 60 * 60);
        long_unused.last_usage_unix_secs = Some(now - 2 * 24 * 60 * 60);
        db.upsert_memory(&long_unused).await.unwrap();

        assert_eq!(
            db.prune_stage1_outputs_for_retention(1, 100).await.unwrap(),
            1
        );
        let remaining = db
            .list_recent(10)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.session_id)
            .collect::<Vec<_>>();
        assert_eq!(remaining, vec!["recently-used"]);
    }

    #[test]
    fn success_cooldown_survives_an_idle_watermark_advance() {
        let mut job = MemoryJobRow {
            kind: JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL.to_string(),
            job_key: "global".to_string(),
            status: JOB_STATUS_DONE.to_string(),
            worker_id: None,
            ownership_token: None,
            started_at_unix_secs: Some(1_000),
            finished_at_unix_secs: Some(1_000),
            lease_until_unix_secs: None,
            retry_at_unix_secs: None,
            retry_remaining: DEFAULT_RETRY_REMAINING,
            last_error: None,
            input_watermark: Some(2_000),
            last_success_watermark: Some(1_500),
        };
        assert_eq!(
            phase2_success_cooldown_until_unix_secs(&job, 600),
            Some(1_600)
        );

        job.last_error = Some("boom".to_string());
        assert_eq!(phase2_success_cooldown_until_unix_secs(&job, 600), None);
        job.last_error = None;

        job.status = JOB_STATUS_RUNNING.to_string();
        assert_eq!(phase2_success_cooldown_until_unix_secs(&job, 600), None);
        job.status = JOB_STATUS_DONE.to_string();

        job.input_watermark = None;
        assert_eq!(phase2_success_cooldown_until_unix_secs(&job, 600), None);
    }

    #[tokio::test]
    async fn upsert_phase2_selection_returns_none_for_empty_selection() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        assert!(db
            .upsert_phase2_selection("global", &[])
            .await
            .unwrap()
            .is_none());
        assert!(db.get_phase2_job("global").await.unwrap().is_none());

        let row = test_memory_row("session-a", 100);
        let selection = db
            .upsert_phase2_selection(
                "global",
                &[MemoryPhase2CandidateRow {
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
                    selected_for_phase2_source_updated_at: row
                        .selected_for_phase2_source_updated_at,
                }],
            )
            .await
            .unwrap()
            .expect("non-empty selection must persist");
        assert_eq!(selection.input_watermark, 100);
    }

    #[tokio::test]
    async fn phase1_retry_exhausted_session_is_requeued_after_quarantine() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let token = claim_token(
            db.try_claim_phase1_job("session-a", "worker", 100, 60, 2)
                .await
                .unwrap(),
        );
        let conn = open_connection(db.path()).unwrap();
        let mut token = token;
        for remaining in (1..=DEFAULT_RETRY_REMAINING).rev() {
            assert!(db
                .mark_phase1_job_failed("session-a", &token, 0, "boom".to_string())
                .await
                .unwrap());
            let job = get_job_in_connection(&conn, JOB_KIND_MEMORY_STAGE1, "session-a")
                .unwrap()
                .unwrap();
            assert_eq!(job.retry_remaining, remaining - 1);
            if remaining == 1 {
                break;
            }
            token = claim_token(
                db.try_claim_phase1_job("session-a", "worker", 100, 60, 2)
                    .await
                    .unwrap(),
            );
        }

        let exhausted = db
            .try_claim_phase1_job("session-a", "worker", 100, 60, 2)
            .await
            .unwrap();
        assert_eq!(exhausted, MemoryPhase1ClaimOutcome::SkippedRetryExhausted);

        // Simulate the quarantine window having elapsed.
        conn.execute(
            "UPDATE jobs SET finished_at = ?1 WHERE kind = ?2 AND job_key = ?3",
            params![
                current_unix_secs() - PHASE1_RETRY_EXHAUSTION_QUARANTINE_SECONDS - 1,
                JOB_KIND_MEMORY_STAGE1,
                "session-a"
            ],
        )
        .unwrap();

        let requeued = db
            .try_claim_phase1_job("session-a", "worker", 100, 60, 2)
            .await
            .unwrap();
        assert!(
            matches!(requeued, MemoryPhase1ClaimOutcome::Claimed { .. }),
            "an exhausted session must be requeued once the quarantine window passes, got {requeued:?}"
        );
        let job = get_job_in_connection(&conn, JOB_KIND_MEMORY_STAGE1, "session-a")
            .unwrap()
            .unwrap();
        assert_eq!(job.retry_remaining, DEFAULT_RETRY_REMAINING);
    }

    #[tokio::test]
    async fn status_snapshot_reports_pipeline_state() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let snapshot = db.status_snapshot().await.unwrap();
        assert_eq!(snapshot.stage1_output_count, 0);
        assert_eq!(snapshot.stage1_pending_promotion_count, 0);
        assert!(snapshot.stage1_failed.is_empty());
        assert!(snapshot.phase2_status.is_none());

        db.upsert_memory(&test_memory_row("session-a", 100))
            .await
            .unwrap();
        db.upsert_memory(&test_memory_row("session-b", 90))
            .await
            .unwrap();
        db.mark_phase2_candidates_selected(&["session-a".to_string()], 100)
            .await
            .unwrap();
        let token = claim_token(
            db.try_claim_phase1_job("session-c", "worker", 50, 60, 2)
                .await
                .unwrap(),
        );
        db.mark_phase1_job_failed("session-c", &token, 60, "model outage".to_string())
            .await
            .unwrap();
        assert_eq!(
            db.claim_phase2_job("global", "phase2-token", 100, 60)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        db.complete_phase2_job_failure(
            "global",
            "phase2-token",
            current_unix_secs() + 60,
            "consolidation failed".to_string(),
        )
        .await
        .unwrap();

        let snapshot = db.status_snapshot().await.unwrap();
        assert_eq!(snapshot.stage1_output_count, 2);
        assert_eq!(snapshot.stage1_pending_promotion_count, 1);
        assert_eq!(snapshot.stage1_failed.len(), 1);
        assert_eq!(snapshot.stage1_failed[0].session_id, "session-c");
        assert_eq!(snapshot.stage1_failed[0].last_error, "model outage");
        assert!(!snapshot.stage1_failed[0].retry_exhausted);
        assert_eq!(snapshot.phase2_status.as_deref(), Some(JOB_STATUS_ERROR));
        assert!(snapshot.phase2_last_finished_at_unix_secs.is_some());
        assert_eq!(
            snapshot.phase2_last_error.as_deref(),
            Some("consolidation failed")
        );
    }

    #[tokio::test]
    async fn record_memory_usage_matches_rollout_ids_and_summary_file_names() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let row_a = test_memory_row("session-a", 100);
        let row_b = test_memory_row("session-b", 90);
        for row in [&row_a, &row_b] {
            db.upsert_memory(row).await.unwrap();
        }
        let summary_b = crate::agentic::memories::workspace::rollout_summary_file_name(&row_b);

        let updated = db
            .record_memory_usage(
                &["session-a".to_string(), "unknown-session".to_string()],
                &[
                    format!("rollout_summaries/{summary_b}"),
                    "missing.md".to_string(),
                ],
            )
            .await
            .unwrap();
        assert_eq!(updated, 2);

        let rows = db.list_recent(10).await.unwrap();
        let row_a = rows
            .iter()
            .find(|row| row.session_id == "session-a")
            .expect("session-a row");
        let row_b = rows
            .iter()
            .find(|row| row.session_id == "session-b")
            .expect("session-b row");
        assert_eq!(row_a.usage_count, 1);
        assert!(row_a.last_usage_unix_secs.is_some());
        assert_eq!(row_b.usage_count, 1);
        assert!(row_b.last_usage_unix_secs.is_some());

        assert_eq!(
            db.record_memory_usage(&[], &["missing.md".to_string()])
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn list_live_rollout_summary_identities_covers_every_row() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        let row_a = test_memory_row("session-a", 100);
        let row_b = test_memory_row("session-b", 90);
        for row in [&row_a, &row_b] {
            db.upsert_memory(row).await.unwrap();
        }

        let identities = db.list_live_rollout_summary_identities().await.unwrap();
        assert_eq!(
            identities
                .iter()
                .map(|identity| identity.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-a", "session-b"]
        );
        assert_eq!(
            identities[0].rollout_slug.as_deref(),
            row_a.rollout_slug.as_deref()
        );
        assert_eq!(
            identities[1].source_updated_at_unix_secs,
            row_b.source_updated_at_unix_secs
        );

        db.prune_stage1_outputs_for_retention(0, 10).await.unwrap();
        assert!(db
            .list_live_rollout_summary_identities()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn phase2_job_lifecycle_uses_jobs_table() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        assert_eq!(
            db.claim_phase2_job("global", "token-a", 10, 60)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        assert_eq!(
            db.claim_phase2_job("global", "token-b", 11, 60)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::SkippedRunning
        );
        assert!(db
            .complete_phase2_job_success("global", "token-a", 11)
            .await
            .unwrap());

        let job = db.get_phase2_job("global").await.unwrap().unwrap();
        assert_eq!(job.status, JOB_STATUS_DONE);
        assert_eq!(job.input_watermark, Some(11));
        assert_eq!(job.last_success_watermark, Some(11));
        assert!(job.ownership_token.is_none());
    }

    #[tokio::test]
    async fn status_snapshot_returns_default_without_creating_a_missing_database() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        let db_path = db.path().to_path_buf();
        assert!(!db_path.exists());

        let snapshot = db.status_snapshot().await.unwrap();

        assert_eq!(snapshot.stage1_output_count, 0);
        assert_eq!(snapshot.stage1_pending_promotion_count, 0);
        assert!(snapshot.stage1_failed.is_empty());
        assert!(snapshot.phase2_status.is_none());
        assert!(snapshot.phase2_last_finished_at_unix_secs.is_none());
        assert!(snapshot.phase2_last_error.is_none());
        // A status read must never create the database as a side effect.
        assert!(!db_path.exists());
    }

    fn set_phase2_lease_until(db: &MemoryDatabase, lease_until_unix_secs: i64) {
        let conn = open_connection(db.path()).unwrap();
        conn.execute(
            "UPDATE jobs SET lease_until = ?1 WHERE kind = ?2 AND job_key = ?3",
            params![
                lease_until_unix_secs,
                JOB_KIND_MEMORY_CONSOLIDATE_GLOBAL,
                MEMORY_PHASE2_GLOBAL_JOB_KEY
            ],
        )
        .unwrap();
    }

    #[test]
    fn phase2_owner_liveness_uses_a_heartbeat_window() {
        let now = 1_000_000;
        assert!(!phase2_owner_is_live(None, Some(now + 3600), 3600, now));
        assert!(!phase2_owner_is_live(Some("token"), None, 3600, now));
        assert!(!phase2_owner_is_live(Some("token"), Some(now), 3600, now));
        // A live owner refreshed its lease within the heartbeat cadence.
        assert!(phase2_owner_is_live(
            Some("token"),
            Some(now + 3570),
            3600,
            now
        ));
        // A dead owner stopped refreshing: the lease drained past the window.
        assert!(!phase2_owner_is_live(
            Some("token"),
            Some(now + 3480),
            3600,
            now
        ));
        assert!(!phase2_owner_is_live(
            Some("token"),
            Some(now + 3000),
            3600,
            now
        ));
        // A lease shorter than the stale window keeps plain expiry semantics.
        assert!(phase2_owner_is_live(Some("token"), Some(now + 59), 60, now));
        assert!(!phase2_owner_is_live(Some("token"), Some(now), 60, now));
    }

    #[tokio::test]
    async fn phase2_claim_keeps_a_live_heartbeat_contending() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        assert_eq!(
            db.claim_phase2_job("global", "token-a", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        // The owner heartbeated 30 seconds ago, so the job is still owned.
        set_phase2_lease_until(&db, current_unix_secs() + 3600 - 30);
        assert_eq!(
            db.claim_phase2_job("global", "token-b", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::SkippedRunning
        );
        let job = db.get_phase2_job("global").await.unwrap().unwrap();
        assert_eq!(job.ownership_token.as_deref(), Some("token-a"));
    }

    #[tokio::test]
    async fn phase2_claim_reclaims_a_stale_heartbeat_lease() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        assert_eq!(
            db.claim_phase2_job("global", "token-a", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        // The owner died mid-consolidation ten minutes ago. Its lease has not
        // expired yet, but it stopped heartbeating, so a new run must reclaim the
        // job instead of waiting out the full lease.
        set_phase2_lease_until(&db, current_unix_secs() + 3600 - 600);
        assert_eq!(
            db.claim_phase2_job("global", "token-b", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );

        let job = db.get_phase2_job("global").await.unwrap().unwrap();
        assert_eq!(job.ownership_token.as_deref(), Some("token-b"));
        assert_eq!(job.status, JOB_STATUS_RUNNING);
        assert!(job.lease_until_unix_secs.unwrap() > current_unix_secs());
    }

    #[tokio::test]
    async fn phase2_claim_reclaims_an_expired_lease() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();

        assert_eq!(
            db.claim_phase2_job("global", "token-a", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        set_phase2_lease_until(&db, current_unix_secs() - 1);
        assert_eq!(
            db.claim_phase2_job("global", "token-b", 10, 3600)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
    }

    #[tokio::test]
    async fn phase2_has_live_run_tracks_the_heartbeat_window() {
        let temp = tempdir().unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().to_path_buf(),
        ));
        let db = MemoryDatabase::new(path_manager);
        db.initialize().await.unwrap();
        let lease_seconds = crate::agentic::memories::runner::phase2_lease_seconds()
            .await
            .unwrap();

        // No job row at all.
        assert!(!db.phase2_has_live_run().await.unwrap());

        assert_eq!(
            db.claim_phase2_job("global", "token-a", 10, lease_seconds)
                .await
                .unwrap(),
            MemoryPhase2ClaimOutcome::Claimed
        );
        // Heartbeated within the cadence: the run is live.
        set_phase2_lease_until(&db, current_unix_secs() + lease_seconds - 30);
        assert!(db.phase2_has_live_run().await.unwrap());

        // Stopped heartbeating long enough for the lease to drain past the stale
        // window, even though the lease has not expired: no live run.
        set_phase2_lease_until(&db, current_unix_secs() + lease_seconds - 600);
        assert!(!db.phase2_has_live_run().await.unwrap());

        // A clean completion releases ownership, so the job is no longer live.
        set_phase2_lease_until(&db, current_unix_secs() + lease_seconds - 30);
        assert!(db
            .complete_phase2_job_success("global", "token-a", 11)
            .await
            .unwrap());
        assert!(!db.phase2_has_live_run().await.unwrap());
    }
}
