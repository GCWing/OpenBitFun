use crate::agentic::memories::{MemoryPhase1Service, MemoryPhase2Runner};
use crate::agentic::SessionKind;
use crate::service::config::get_global_config_service;
use crate::service::config::types::GlobalConfig;
use log::{debug, info, warn};

#[derive(Debug, Clone)]
pub struct MemoryStartupRequest {
    pub session_id: String,
    pub session_kind: SessionKind,
    pub agent_type: String,
    pub workspace_path: Option<String>,
    pub is_remote_workspace: bool,
    pub has_user_input: bool,
}

pub async fn start_memory_startup_task(request: MemoryStartupRequest) {
    if !memory_startup_is_eligible(&request) {
        debug!(
            "Memory startup skipped by eligibility gate: session_id={}, session_kind={:?}, agent_type={}, workspace_path={:?}, is_remote_workspace={}, has_user_input={}",
            request.session_id,
            request.session_kind,
            request.agent_type,
            request.workspace_path,
            request.is_remote_workspace,
            request.has_user_input
        );
        return;
    }

    let config = load_global_config().await;
    if !config.memories.generate_memories {
        debug!(
            "Memory startup skipped because generate_memories is disabled: session_id={}",
            request.session_id
        );
        return;
    }

    info!(
        "Memory startup task scheduled: session_id={}, session_kind={:?}, agent_type={}, workspace_path={:?}",
        request.session_id, request.session_kind, request.agent_type, request.workspace_path
    );
    tokio::spawn(async move {
        let started_at = std::time::Instant::now();
        info!(
            "Memory startup task started: session_id={}, generate_memories={}, use_memories={}",
            request.session_id, config.memories.generate_memories, config.memories.use_memories
        );
        let phase1 = match MemoryPhase1Service::new().await {
            Ok(service) => service,
            Err(error) => {
                warn!("Memory phase1 service initialization failed: {}", error);
                return;
            }
        };
        let max_unused_days = config.memories.max_unused_days.clamp(1, 365);
        match phase1
            .prune_stage1_outputs_for_retention(max_unused_days)
            .await
        {
            Ok(pruned) if pruned > 0 => {
                info!(
                    "Memory startup pruned stale stage1 output rows: pruned={}, max_unused_days={}",
                    pruned, max_unused_days
                );
            }
            Ok(_) => {}
            Err(error) => {
                warn!(
                    "Memory startup failed to prune stale stage1 output rows: {}",
                    error
                );
            }
        }
        // Failure bookkeeping expires on the same pass and before phase 1 claims
        // any session: an expired row is a dead end whose attempt budget is
        // dropped here instead of being requeued by the quarantine path.
        let max_failure_report_days = config.memories.max_failure_report_days;
        match phase1
            .prune_failed_stage1_jobs(max_failure_report_days)
            .await
        {
            Ok(expired) if expired > 0 => {
                info!(
                    "Memory startup expired stale stage1 failure records: expired={}, max_failure_report_days={}",
                    expired, max_failure_report_days
                );
            }
            Ok(_) => {}
            Err(error) => {
                warn!(
                    "Memory startup failed to expire stale stage1 failure records: {}",
                    error
                );
            }
        }
        if let Err(error) = phase1
            .run_once_excluding_session(Some(request.session_id.as_str()))
            .await
        {
            warn!("Memory phase1 startup run failed: {}", error);
        }
        info!(
            "Memory startup phase1 pass finished: session_id={}, elapsed_ms={}",
            request.session_id,
            started_at.elapsed().as_millis()
        );

        let phase2 = match MemoryPhase2Runner::new().await {
            Ok(runner) => runner,
            Err(error) => {
                warn!("Memory phase2 runner initialization failed: {}", error);
                return;
            }
        };
        if let Err(error) = phase2.run_once().await {
            warn!("Memory phase2 startup run failed: {}", error);
        }
        info!(
            "Memory startup task completed: session_id={}, duration_ms={}",
            request.session_id,
            started_at.elapsed().as_millis()
        );
    });
}

pub fn memory_startup_is_eligible(request: &MemoryStartupRequest) -> bool {
    if !request.has_user_input {
        return false;
    }
    if request.is_remote_workspace || request.workspace_path.is_none() {
        return false;
    }
    if matches!(
        request.session_kind,
        SessionKind::Subagent | SessionKind::EphemeralChild
    ) {
        return false;
    }
    let agent_type = request.agent_type.trim();
    !agent_type.is_empty() && agent_type != "MemoryPhase2"
}

async fn load_global_config() -> GlobalConfig {
    match get_global_config_service().await {
        Ok(service) => service.get_config(None).await.unwrap_or_default(),
        Err(_) => GlobalConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> MemoryStartupRequest {
        MemoryStartupRequest {
            session_id: "session-a".to_string(),
            session_kind: SessionKind::Standard,
            agent_type: "Standard".to_string(),
            workspace_path: Some("workspace".to_string()),
            is_remote_workspace: false,
            has_user_input: true,
        }
    }

    #[test]
    fn memory_startup_requires_root_local_user_input() {
        assert!(memory_startup_is_eligible(&request()));

        assert!(!memory_startup_is_eligible(&MemoryStartupRequest {
            has_user_input: false,
            ..request()
        }));
        assert!(!memory_startup_is_eligible(&MemoryStartupRequest {
            is_remote_workspace: true,
            ..request()
        }));
        assert!(!memory_startup_is_eligible(&MemoryStartupRequest {
            session_kind: SessionKind::Subagent,
            ..request()
        }));
        assert!(!memory_startup_is_eligible(&MemoryStartupRequest {
            session_kind: SessionKind::EphemeralChild,
            ..request()
        }));
        assert!(!memory_startup_is_eligible(&MemoryStartupRequest {
            workspace_path: None,
            ..request()
        }));
    }
}
