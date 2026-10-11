//! Memory pipeline status, on-demand trigger, and failure-bookkeeping commands.
//!
//! Every command here is a thin wire wrapper over
//! `openbitfun_core::service::agentic_api`. The memory database, the memory
//! workspace, and the memory config are owned by the OpenBitFun host that runs the
//! agent, so the payload describes the *host's* memory store and never follows the
//! workspace filesystem to a remote host.

use serde::{Deserialize, Serialize};

use openbitfun_core::agentic::memories::db::MemoryStatusSnapshot;
use openbitfun_core::service::agentic_api::{
    clear_memory_stage1_failures as clear_stage1_failures, get_memory_status as read_memory_status,
    run_memory_pipeline_now as trigger_memory_pipeline, MemoryPipelineRunReport,
    MemoryStatusReport,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStage1FailureResponse {
    pub session_id: String,
    pub last_error: String,
    pub retry_exhausted: bool,
    /// When the failed attempt finished (or started, when it never finished).
    /// `null` when the host stored neither timestamp.
    pub failed_at_unix_secs: Option<i64>,
}

/// Byte counts of the memory root. `null` means the host could not read that
/// path, which is different from an empty memory (`0`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileStatsResponse {
    pub memory_index_bytes: Option<u64>,
    pub memory_summary_bytes: Option<u64>,
    pub rollout_summary_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusResponse {
    /// Whether the background pipeline is allowed to run.
    pub generate_memories: bool,
    /// Whether sessions may read the consolidated memory summary.
    pub use_memories: bool,
    /// Host-local memory root directory.
    pub memory_root_dir: String,
    pub stage1_output_count: u64,
    pub stage1_pending_promotion_count: u64,
    pub stage1_failed: Vec<MemoryStage1FailureResponse>,
    pub phase2_status: Option<String>,
    pub phase2_last_finished_at_unix_secs: Option<i64>,
    pub phase2_last_error: Option<String>,
    pub files: MemoryFileStatsResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMemoryPipelineNowResponse {
    /// `false` when the pipeline gate is off and nothing was scheduled.
    pub started: bool,
}

/// Request for [`clear_memory_stage1_failures`].
///
/// The action is unconditional, but it still travels as a structured request so
/// the command keeps the repository's Tauri request shape (and can gain an
/// explicit scope later without a wire break).
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClearMemoryStage1FailuresRequest {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearMemoryStage1FailuresResponse {
    /// Number of failed stage-1 job rows that were deleted.
    pub cleared_count: u64,
    /// Failed list after the clear, so the caller does not have to re-read to
    /// learn whether the list is really empty.
    pub stage1_failed: Vec<MemoryStage1FailureResponse>,
}

/// Projects the snapshot's failed stage-1 rows onto the wire shape.
fn stage1_failure_responses(snapshot: MemoryStatusSnapshot) -> Vec<MemoryStage1FailureResponse> {
    snapshot
        .stage1_failed
        .into_iter()
        .map(|failure| MemoryStage1FailureResponse {
            session_id: failure.session_id,
            last_error: failure.last_error,
            retry_exhausted: failure.retry_exhausted,
            failed_at_unix_secs: failure.failed_at_unix_secs,
        })
        .collect()
}

impl From<MemoryStatusReport> for MemoryStatusResponse {
    fn from(report: MemoryStatusReport) -> Self {
        let snapshot = report.status;
        Self {
            generate_memories: report.generate_memories,
            use_memories: report.use_memories,
            memory_root_dir: report.memory_root_dir,
            stage1_output_count: snapshot.stage1_output_count,
            stage1_pending_promotion_count: snapshot.stage1_pending_promotion_count,
            stage1_failed: stage1_failure_responses(snapshot.clone()),
            phase2_status: snapshot.phase2_status,
            phase2_last_finished_at_unix_secs: snapshot.phase2_last_finished_at_unix_secs,
            phase2_last_error: snapshot.phase2_last_error,
            files: MemoryFileStatsResponse {
                memory_index_bytes: report.files.memory_index_bytes,
                memory_summary_bytes: report.files.memory_summary_bytes,
                rollout_summary_count: report.files.rollout_summary_count,
            },
        }
    }
}

impl From<MemoryPipelineRunReport> for RunMemoryPipelineNowResponse {
    fn from(report: MemoryPipelineRunReport) -> Self {
        Self {
            started: report.started,
        }
    }
}

#[tauri::command]
pub async fn get_memory_status() -> Result<MemoryStatusResponse, String> {
    read_memory_status()
        .await
        .map(MemoryStatusResponse::from)
        .map_err(|error| format!("Failed to read memory status: {}", error))
}

#[tauri::command]
pub async fn run_memory_pipeline_now() -> Result<RunMemoryPipelineNowResponse, String> {
    trigger_memory_pipeline()
        .await
        .map(RunMemoryPipelineNowResponse::from)
        .map_err(|error| format!("Failed to start the memory pipeline: {}", error))
}

/// Deletes the failed stage-1 extraction bookkeeping on this host.
///
/// This clears the failure list only: extracted memories are kept, and the
/// cleared sessions become eligible for extraction again on the next memory run.
#[tauri::command]
pub async fn clear_memory_stage1_failures(
    request: ClearMemoryStage1FailuresRequest,
) -> Result<ClearMemoryStage1FailuresResponse, String> {
    let ClearMemoryStage1FailuresRequest {} = request;
    clear_stage1_failures()
        .await
        .map(|report| ClearMemoryStage1FailuresResponse {
            cleared_count: report.cleared_count,
            stage1_failed: stage1_failure_responses(report.status),
        })
        .map_err(|error| format!("Failed to clear failed memory extractions: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::agentic::memories::db::{MemoryStage1Failure, MemoryStatusSnapshot};
    use openbitfun_core::service::agentic_api::MemoryFileStats;

    #[test]
    fn status_response_projects_every_snapshot_field() {
        let response = MemoryStatusResponse::from(MemoryStatusReport {
            status: MemoryStatusSnapshot {
                stage1_output_count: 7,
                stage1_pending_promotion_count: 2,
                stage1_failed: vec![MemoryStage1Failure {
                    session_id: "session-a".to_string(),
                    last_error: "provider unavailable".to_string(),
                    retry_exhausted: true,
                    failed_at_unix_secs: Some(1_700_000_000),
                }],
                phase2_status: Some("error".to_string()),
                phase2_last_finished_at_unix_secs: Some(1_700_000_000),
                phase2_last_error: Some("consolidation failed".to_string()),
            },
            generate_memories: true,
            use_memories: false,
            memory_root_dir: "/host/memories".to_string(),
            files: MemoryFileStats {
                memory_index_bytes: Some(128),
                memory_summary_bytes: None,
                rollout_summary_count: Some(3),
            },
        });

        assert!(response.generate_memories);
        assert!(!response.use_memories);
        assert_eq!(response.memory_root_dir, "/host/memories");
        assert_eq!(response.stage1_output_count, 7);
        assert_eq!(response.stage1_pending_promotion_count, 2);
        assert_eq!(response.stage1_failed.len(), 1);
        assert_eq!(response.stage1_failed[0].session_id, "session-a");
        assert_eq!(response.stage1_failed[0].last_error, "provider unavailable");
        assert!(response.stage1_failed[0].retry_exhausted);
        assert_eq!(
            response.stage1_failed[0].failed_at_unix_secs,
            Some(1_700_000_000)
        );
        assert_eq!(response.phase2_status.as_deref(), Some("error"));
        assert_eq!(
            response.phase2_last_finished_at_unix_secs,
            Some(1_700_000_000)
        );
        assert_eq!(
            response.phase2_last_error.as_deref(),
            Some("consolidation failed")
        );
        assert_eq!(response.files.memory_index_bytes, Some(128));
        assert_eq!(response.files.memory_summary_bytes, None);
        assert_eq!(response.files.rollout_summary_count, Some(3));
    }

    #[test]
    fn status_response_serializes_camel_case_for_the_web_ui() {
        let response = MemoryStatusResponse::from(MemoryStatusReport::default());
        let value = serde_json::to_value(&response).unwrap();

        assert_eq!(value["generateMemories"], serde_json::json!(false));
        assert_eq!(value["memoryRootDir"], serde_json::json!(""));
        assert_eq!(value["stage1OutputCount"], serde_json::json!(0));
        assert_eq!(value["stage1PendingPromotionCount"], serde_json::json!(0));
        assert_eq!(value["stage1Failed"], serde_json::json!([]));
        assert_eq!(value["phase2Status"], serde_json::Value::Null);
        assert_eq!(
            value["phase2LastFinishedAtUnixSecs"],
            serde_json::Value::Null
        );
        assert_eq!(value["phase2LastError"], serde_json::Value::Null);
        assert_eq!(value["files"]["memoryIndexBytes"], serde_json::Value::Null);
        assert_eq!(
            value["files"]["rolloutSummaryCount"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn pipeline_run_response_reports_whether_a_pass_was_scheduled() {
        let started = RunMemoryPipelineNowResponse::from(MemoryPipelineRunReport { started: true });
        assert_eq!(
            serde_json::to_value(&started).unwrap(),
            serde_json::json!({ "started": true })
        );

        let skipped = RunMemoryPipelineNowResponse::from(MemoryPipelineRunReport::default());
        assert_eq!(
            serde_json::to_value(&skipped).unwrap(),
            serde_json::json!({ "started": false })
        );
    }

    #[test]
    fn clear_failures_response_serializes_camel_case_and_keeps_the_post_clear_list() {
        let response = ClearMemoryStage1FailuresResponse {
            cleared_count: 2,
            stage1_failed: stage1_failure_responses(MemoryStatusSnapshot {
                stage1_failed: vec![MemoryStage1Failure {
                    session_id: "session-b".to_string(),
                    last_error: "still failing".to_string(),
                    retry_exhausted: false,
                    failed_at_unix_secs: Some(1_690_000_000),
                }],
                ..Default::default()
            }),
        };

        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            serde_json::json!({
                "clearedCount": 2,
                "stage1Failed": [
                    {
                        "sessionId": "session-b",
                        "lastError": "still failing",
                        "retryExhausted": false,
                        "failedAtUnixSecs": 1690000000
                    }
                ]
            })
        );
    }

    #[test]
    fn clear_failures_request_accepts_the_structured_payload_shape() {
        // The Web UI sends `{ request: {} }`; an extra field from a newer client
        // must not break an older host command.
        let _: ClearMemoryStage1FailuresRequest =
            serde_json::from_value(serde_json::json!({})).unwrap();
        let _: ClearMemoryStage1FailuresRequest =
            serde_json::from_value(serde_json::json!({ "futureScope": "all" })).unwrap();
    }
}
