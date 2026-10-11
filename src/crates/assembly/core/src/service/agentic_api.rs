//! Read/trigger facade for the memory pipeline status surface.
//!
//! The memory settings page needs facts that live in three places: the persisted
//! pipeline snapshot ([`MemoryDatabase::status_snapshot`]), the effective memory
//! config flags, and the memory-root file statistics. This module joins them into
//! one payload so the desktop command stays a thin wrapper, and it exposes the
//! explicit "run the pipeline now" trigger.
//!
//! Everything here is host-local by design: the memory store, the memory
//! workspace, and the memory config are owned by the OpenBitFun host that runs the
//! agent, and never follow the workspace filesystem to an SSH host.

use std::io::ErrorKind;
use std::path::Path;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};

use crate::agentic::memories::db::{MemoryDatabase, MemoryStatusSnapshot};
use crate::agentic::memories::{
    memory_index_file, memory_root_dir, memory_summary_file, rollout_summaries_dir,
    MemoryPhase1Service, MemoryPhase2Runner,
};
use crate::infrastructure::get_path_manager_arc;
use crate::service::config::get_global_config_service;
use crate::service::config::types::GlobalConfig;
use crate::util::errors::OpenBitFunResult;

/// Size/count statistics for the memory root.
///
/// A field is `None` only when the read failed for a reason other than "nothing
/// there yet" (permissions, I/O errors). An absent file or directory reports
/// `0`, because that is a real, user-meaningful state: the memory workspace is
/// empty. Status surfaces render `None` as unknown instead of `0 B`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryFileStats {
    /// Bytes of `MEMORY.md`.
    pub memory_index_bytes: Option<u64>,
    /// Bytes of `memory_summary.md`.
    pub memory_summary_bytes: Option<u64>,
    /// Number of `rollout_summaries/*.md` files.
    pub rollout_summary_count: Option<u64>,
}

/// Host-local memory pipeline status for status surfaces.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryStatusReport {
    /// Persisted pipeline snapshot.
    pub status: MemoryStatusSnapshot,
    /// Whether the background pipeline is allowed to run.
    pub generate_memories: bool,
    /// Whether sessions may read the consolidated memory summary.
    pub use_memories: bool,
    /// Host-local memory root directory.
    pub memory_root_dir: String,
    /// Memory-root file statistics.
    pub files: MemoryFileStats,
}

/// Outcome of an explicit memory pipeline trigger.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPipelineRunReport {
    /// `true` when a background pass was spawned.
    ///
    /// `false` means the pipeline gate (`generate_memories`) is off, so nothing
    /// was scheduled. A trigger that overlaps an already running pass still
    /// reports `true`: deduplication happens in the claim/lease layer, which
    /// turns the overlap into a no-op pass instead of an error.
    pub started: bool,
}

/// Outcome of clearing the failed stage-1 extraction bookkeeping.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryClearFailuresReport {
    /// Number of failed stage-1 job rows that were deleted.
    pub cleared_count: u64,
    /// Pipeline snapshot read after the clear, so the caller does not have to
    /// guess whether the failed list is really empty.
    pub status: MemoryStatusSnapshot,
}

/// Reads the persisted pipeline snapshot plus the effective config flags and the
/// memory-root file statistics.
///
/// The snapshot and the config flags are required: without them the status card
/// would have to render guessed values, so a failure is returned instead.
/// Memory-root file reads degrade to [`None`] fields.
pub async fn get_memory_status() -> OpenBitFunResult<MemoryStatusReport> {
    let config = load_global_config().await?;
    let db = MemoryDatabase::new(get_path_manager_arc());
    let status = db.status_snapshot().await?;
    let root = memory_root_dir();

    Ok(MemoryStatusReport {
        status,
        generate_memories: config.memories.generate_memories,
        use_memories: config.memories.use_memories,
        memory_root_dir: root.to_string_lossy().to_string(),
        files: read_memory_root_file_stats(&root).await,
    })
}

/// Schedules one memory pipeline pass in the background and returns immediately.
///
/// Phase 1 extraction runs first, then Phase 2 consolidation, mirroring the
/// startup pass. The same expiry sweep that runs at startup runs here before
/// phase 1 claims any session, so a manual run also clears failure records that
/// aged out of the report window instead of leaving them listed. Failures are
/// logged, not propagated: the trigger already returned, and the status surface
/// reports the resulting pipeline state.
pub async fn run_memory_pipeline_now() -> OpenBitFunResult<MemoryPipelineRunReport> {
    let config = load_global_config().await?;
    if !config.memories.generate_memories {
        info!("Memory pipeline run requested while generate_memories is disabled");
        return Ok(MemoryPipelineRunReport { started: false });
    }
    let max_failure_report_days = config.memories.max_failure_report_days;

    tokio::spawn(async move {
        info!("Memory pipeline on-demand run started");

        match MemoryPhase1Service::new().await {
            Ok(service) => {
                match service.prune_failed_stage1_jobs(max_failure_report_days).await {
                    Ok(expired) if expired > 0 => info!(
                        "Memory pipeline on-demand run expired stale stage1 failure records: expired={}, max_failure_report_days={}",
                        expired, max_failure_report_days
                    ),
                    Ok(_) => {}
                    Err(error) => warn!(
                        "Memory pipeline on-demand run failed to expire stale stage1 failure records: {}",
                        error
                    ),
                }
                match service.run_once().await {
                    Ok(stats) => info!(
                        "Memory pipeline on-demand phase1 pass finished: scanned_sessions={}, extracted_sessions={}, skipped_sessions={}",
                        stats.scanned_sessions, stats.extracted_sessions, stats.skipped_sessions
                    ),
                    Err(error) => warn!("Memory pipeline on-demand phase1 run failed: {}", error),
                }
            }
            Err(error) => warn!(
                "Memory pipeline on-demand phase1 service initialization failed: {}",
                error
            ),
        }

        match MemoryPhase2Runner::new().await {
            Ok(runner) => match runner.run_once().await {
                Ok(Some(report)) => info!(
                    "Memory pipeline on-demand phase2 pass finished: candidate_count={}, selected_count={}",
                    report.candidate_count, report.selected_count
                ),
                Ok(None) => {
                    info!("Memory pipeline on-demand phase2 pass was a no-op for the current state")
                }
                Err(error) => warn!("Memory pipeline on-demand phase2 run failed: {}", error),
            },
            Err(error) => warn!(
                "Memory pipeline on-demand phase2 runner initialization failed: {}",
                error
            ),
        }

        info!("Memory pipeline on-demand run finished");
    });

    Ok(MemoryPipelineRunReport { started: true })
}

/// Deletes the failed stage-1 extraction bookkeeping for this host.
///
/// This is the manual counterpart of the automatic 24 h quarantine requeue: it
/// removes only the `memory_stage1/*` job rows in `error` state, so the failed
/// list stops repeating without discarding any extracted memory and without
/// touching the global phase-2 job. A cleared session becomes claimable again on
/// the next scan, which inserts a fresh claim with the full default attempt
/// budget.
pub async fn clear_memory_stage1_failures() -> OpenBitFunResult<MemoryClearFailuresReport> {
    let db = MemoryDatabase::new(get_path_manager_arc());
    let cleared_count = db.clear_failed_stage1_jobs().await?;
    let status = db.status_snapshot().await?;
    info!(
        "Memory stage1 failure bookkeeping cleared: cleared_count={}, remaining_failed={}",
        cleared_count,
        status.stage1_failed.len()
    );

    Ok(MemoryClearFailuresReport {
        cleared_count,
        status,
    })
}

async fn load_global_config() -> OpenBitFunResult<GlobalConfig> {
    let service = get_global_config_service().await?;
    service.get_config(None).await
}

async fn read_memory_root_file_stats(root: &Path) -> MemoryFileStats {
    MemoryFileStats {
        memory_index_bytes: read_file_bytes(&memory_index_file(root)).await,
        memory_summary_bytes: read_file_bytes(&memory_summary_file(root)).await,
        rollout_summary_count: count_rollout_summaries(&rollout_summaries_dir(root)).await,
    }
}

async fn read_file_bytes(path: &Path) -> Option<u64> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) => Some(metadata.len()),
        Err(error) => absent_or_unknown(&error, path),
    }
}

async fn count_rollout_summaries(dir: &Path) -> Option<u64> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) => return absent_or_unknown(&error, dir),
    };

    let mut count = 0u64;
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => {
                let is_markdown = entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(".md"));
                if is_markdown {
                    count += 1;
                }
            }
            Ok(None) => return Some(count),
            Err(error) => {
                debug!(
                    "Memory status could not scan directory {}: {}",
                    dir.display(),
                    error
                );
                return None;
            }
        }
    }
}

/// Maps a failed memory-root read to its reported statistic.
///
/// A path that is simply not there yet is an empty memory workspace (`Some(0)`).
/// Anything else is a real I/O failure (`None`), so status surfaces show
/// "unknown" instead of claiming an empty memory after a failed read.
fn absent_or_unknown(error: &std::io::Error, path: &Path) -> Option<u64> {
    if error.kind() == ErrorKind::NotFound {
        return Some(0);
    }

    debug!("Memory status could not read {}: {}", path.display(), error);
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn memory_root_stats_report_zero_for_an_empty_workspace() {
        let temp = tempdir().unwrap();

        let stats = read_memory_root_file_stats(temp.path()).await;

        assert_eq!(
            stats,
            MemoryFileStats {
                memory_index_bytes: Some(0),
                memory_summary_bytes: Some(0),
                rollout_summary_count: Some(0),
            },
            "an absent memory root is empty, not unknown"
        );
    }

    #[tokio::test]
    async fn memory_root_stats_measure_files_and_count_only_rollout_summaries() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        tokio::fs::create_dir_all(rollout_summaries_dir(root))
            .await
            .unwrap();
        tokio::fs::write(memory_index_file(root), "12345")
            .await
            .unwrap();
        tokio::fs::write(memory_summary_file(root), "1234567890")
            .await
            .unwrap();
        tokio::fs::write(rollout_summaries_dir(root).join("a.md"), "a")
            .await
            .unwrap();
        tokio::fs::write(rollout_summaries_dir(root).join("b.md"), "bb")
            .await
            .unwrap();
        tokio::fs::write(rollout_summaries_dir(root).join("notes.txt"), "ignored")
            .await
            .unwrap();

        let stats = read_memory_root_file_stats(root).await;

        assert_eq!(stats.memory_index_bytes, Some(5));
        assert_eq!(stats.memory_summary_bytes, Some(10));
        assert_eq!(stats.rollout_summary_count, Some(2));
    }

    #[test]
    fn absent_paths_are_empty_but_failed_reads_are_unknown() {
        let path = Path::new("/host/memories/MEMORY.md");

        assert_eq!(
            absent_or_unknown(&std::io::Error::new(ErrorKind::NotFound, "gone"), path),
            Some(0),
            "a missing memory-root path is an empty memory workspace, not unknown"
        );
        assert_eq!(
            absent_or_unknown(
                &std::io::Error::new(ErrorKind::PermissionDenied, "denied"),
                path
            ),
            None,
            "a real read failure must surface as unknown instead of 0 B"
        );
    }

    #[test]
    fn status_report_tolerates_partial_and_unknown_payloads() {
        let empty: MemoryStatusReport = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty.generate_memories, false);
        assert_eq!(empty.use_memories, false);
        assert_eq!(empty.memory_root_dir, "");
        assert_eq!(empty.status.stage1_output_count, 0);
        assert_eq!(empty.status.stage1_pending_promotion_count, 0);
        assert!(empty.status.stage1_failed.is_empty());
        assert_eq!(empty.status.phase2_status, None);
        assert_eq!(empty.status.phase2_last_finished_at_unix_secs, None);
        assert_eq!(empty.status.phase2_last_error, None);
        assert_eq!(empty.files.memory_index_bytes, None);
        assert_eq!(empty.files.rollout_summary_count, None);

        let partial: MemoryStatusReport = serde_json::from_value(serde_json::json!({
            "generate_memories": true,
            "status": {
                "stage1_output_count": 3,
                "stage1_failed": [
                    { "session_id": "session-a", "last_error": "boom", "retry_exhausted": true }
                ],
                "phase2_status": "error"
            },
            "future_field_added_by_a_newer_host": "ignored"
        }))
        .unwrap();
        assert!(partial.generate_memories);
        assert_eq!(partial.use_memories, false);
        assert_eq!(partial.status.stage1_output_count, 3);
        assert_eq!(partial.status.stage1_pending_promotion_count, 0);
        assert_eq!(partial.status.stage1_failed.len(), 1);
        assert_eq!(partial.status.stage1_failed[0].session_id, "session-a");
        assert!(partial.status.stage1_failed[0].retry_exhausted);
        assert_eq!(partial.status.phase2_status.as_deref(), Some("error"));
    }

    #[test]
    fn pipeline_run_report_defaults_to_not_started() {
        let report: MemoryPipelineRunReport =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!report.started);
    }

    #[test]
    fn clear_failures_report_carries_the_cleared_count_and_post_clear_status() {
        let report = MemoryClearFailuresReport {
            cleared_count: 3,
            status: MemoryStatusSnapshot {
                stage1_output_count: 4,
                stage1_pending_promotion_count: 1,
                stage1_failed: Vec::new(),
                phase2_status: Some("error".to_string()),
                phase2_last_finished_at_unix_secs: None,
                phase2_last_error: Some("consolidation failed".to_string()),
            },
        };
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["cleared_count"], serde_json::json!(3));
        assert_eq!(value["status"]["stage1_output_count"], serde_json::json!(4));
        assert_eq!(value["status"]["stage1_failed"], serde_json::json!([]));

        // A host that reports nothing still yields a usable report instead of
        // forcing the caller to guess the post-clear state.
        let empty: MemoryClearFailuresReport =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(empty.cleared_count, 0);
        assert!(empty.status.stage1_failed.is_empty());
        assert_eq!(empty.status.phase2_status, None);
    }
}
