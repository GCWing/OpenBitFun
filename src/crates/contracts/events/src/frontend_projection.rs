//! Framework-neutral projection for product-facing agentic events.
//!
//! This module owns the stable event name and payload shape consumed by host
//! transports. Concrete delivery adapters should only emit the projected
//! envelope.

use crate::AgenticEvent;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct AgenticFrontendEvent {
    pub event_name: String,
    pub payload: Value,
}

impl AgenticFrontendEvent {
    fn new(event_name: impl Into<String>, payload: Value) -> Self {
        Self {
            event_name: event_name.into(),
            payload,
        }
    }
}

pub fn project_agentic_frontend_event(event: AgenticEvent) -> Option<AgenticFrontendEvent> {
    match event {
        AgenticEvent::SessionCreated {
            session_id,
            session_name,
            agent_type,
            workspace_path,
            project_workspace_path,
            execution_target,
            workspace_id,
            remote_connection_id,
            remote_ssh_host,
        } => Some(AgenticFrontendEvent::new(
            "agentic://session-created",
            json!({
                "sessionId": session_id,
                "sessionName": session_name,
                "agentType": agent_type,
                "workspacePath": workspace_path,
                "projectWorkspacePath": project_workspace_path,
                "executionTarget": execution_target,
                "workspaceId": workspace_id,
                "remoteConnectionId": remote_connection_id,
                "remoteSshHost": remote_ssh_host,
            }),
        )),
        AgenticEvent::SessionDeleted { session_id } => Some(AgenticFrontendEvent::new(
            "agentic://session-deleted",
            json!({ "sessionId": session_id }),
        )),
        AgenticEvent::ImageAnalysisStarted {
            session_id,
            image_count,
            user_input,
            image_metadata,
        } => Some(AgenticFrontendEvent::new(
            "agentic://image-analysis-started",
            json!({
                "sessionId": session_id,
                "imageCount": image_count,
                "userInput": user_input,
                "imageMetadata": image_metadata,
            }),
        )),
        AgenticEvent::ImageAnalysisCompleted {
            session_id,
            success,
            duration_ms,
        } => Some(AgenticFrontendEvent::new(
            "agentic://image-analysis-completed",
            json!({
                "sessionId": session_id,
                "success": success,
                "durationMs": duration_ms,
            }),
        )),
        AgenticEvent::DialogTurnStarted {
            session_id,
            turn_id,
            turn_index,
            user_input,
            original_user_input,
            user_message_metadata,
        } => Some(AgenticFrontendEvent::new(
            "agentic://dialog-turn-started",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "turnIndex": turn_index,
                "userInput": user_input,
                "originalUserInput": original_user_input,
                "userMessageMetadata": user_message_metadata,
            }),
        )),
        AgenticEvent::SubagentSessionLinked {
            session_id,
            subagent_dialog_turn_id,
            parent_session_id,
            parent_dialog_turn_id,
            parent_tool_call_id,
            agent_type,
            model_id,
            focused_review_display_label,
        } => Some(AgenticFrontendEvent::new(
            "agentic://subagent-session-linked",
            json!({
                "sessionId": session_id,
                "subagentDialogTurnId": subagent_dialog_turn_id,
                "parentSessionId": parent_session_id,
                "parentDialogTurnId": parent_dialog_turn_id,
                "parentToolCallId": parent_tool_call_id,
                "agentType": agent_type,
                "modelId": model_id,
                "focusedReviewDisplayLabel": focused_review_display_label,
            }),
        )),
        AgenticEvent::ModelRoundStarted {
            session_id,
            turn_id,
            round_id,
            round_group_id,
            round_index,
            model_config_id,
            effective_model_name,
        } => Some(AgenticFrontendEvent::new(
            "agentic://model-round-started",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "roundGroupId": round_group_id,
                "roundIndex": round_index,
                "modelConfigId": model_config_id,
                "effectiveModelName": effective_model_name,
            }),
        )),
        AgenticEvent::TextChunk {
            session_id,
            turn_id,
            round_id,
            attempt_id,
            attempt_index,
            text,
        } => Some(AgenticFrontendEvent::new(
            "agentic://text-chunk",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "attemptId": attempt_id,
                "attemptIndex": attempt_index,
                "text": text,
                "contentType": "text",
            }),
        )),
        AgenticEvent::ThinkingChunk {
            session_id,
            turn_id,
            round_id,
            attempt_id,
            attempt_index,
            content,
            reasoning_kind,
            is_end,
        } => Some(AgenticFrontendEvent::new(
            "agentic://text-chunk",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "attemptId": attempt_id,
                "attemptIndex": attempt_index,
                "text": content,
                "contentType": "thinking",
                "reasoningKind": reasoning_kind,
                "isThinkingEnd": is_end,
            }),
        )),
        AgenticEvent::ToolEvent {
            session_id,
            turn_id,
            round_id,
            attempt_id,
            attempt_index,
            tool_event,
        } => Some(AgenticFrontendEvent::new(
            "agentic://tool-event",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "attemptId": attempt_id,
                "attemptIndex": attempt_index,
                "toolEvent": tool_event,
            }),
        )),
        AgenticEvent::DialogTurnCompleted {
            session_id,
            turn_id,
            duration_ms,
            partial_recovery_reason,
            success,
            finish_reason,
            has_final_response,
            ..
        } => Some(AgenticFrontendEvent::new(
            "agentic://dialog-turn-completed",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "durationMs": duration_ms,
                "partialRecoveryReason": partial_recovery_reason,
                "success": success,
                "finishReason": finish_reason,
                "hasFinalResponse": has_final_response,
            }),
        )),
        AgenticEvent::SessionTitleGenerated {
            session_id,
            title,
            method,
        } => Some(AgenticFrontendEvent::new(
            "session_title_generated",
            json!({
                "sessionId": session_id,
                "title": title,
                "method": method,
                "timestamp": chrono::Utc::now().timestamp_millis(),
            }),
        )),
        AgenticEvent::DialogTurnCancelled {
            session_id,
            turn_id,
        } => Some(AgenticFrontendEvent::new(
            "agentic://dialog-turn-cancelled",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
            }),
        )),
        AgenticEvent::DialogTurnInterrupted {
            session_id,
            turn_id,
            execution_generation,
            model_id,
        } => Some(AgenticFrontendEvent::new(
            "agentic://dialog-turn-interrupted",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "executionGeneration": execution_generation,
                "modelId": model_id,
            }),
        )),
        AgenticEvent::DialogTurnRecovered {
            session_id,
            turn_id,
            execution_generation,
        } => Some(AgenticFrontendEvent::new(
            "agentic://dialog-turn-recovered",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "executionGeneration": execution_generation,
            }),
        )),
        AgenticEvent::DialogTurnFailed {
            session_id,
            turn_id,
            error,
            error_category,
            error_detail,
        } => Some(AgenticFrontendEvent::new(
            "agentic://dialog-turn-failed",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "error": error,
                "errorCategory": error_category,
                "errorDetail": error_detail,
            }),
        )),
        AgenticEvent::TokenUsageUpdated {
            session_id,
            turn_id,
            model_config_id,
            effective_model_name,
            input_tokens,
            output_tokens,
            total_tokens,
            max_context_tokens,
            is_subagent,
            cached_tokens,
            token_details,
        } => Some(AgenticFrontendEvent::new(
            "agentic://token-usage-updated",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "modelConfigId": model_config_id,
                "effectiveModelName": effective_model_name,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": total_tokens,
                "maxContextTokens": max_context_tokens,
                "isSubagent": is_subagent,
                "cachedTokens": cached_tokens,
                "tokenDetails": token_details,
            }),
        )),
        AgenticEvent::ContextCompressionStarted {
            session_id,
            turn_id,
            compression_id,
            trigger,
            tokens_before,
            context_window,
        } => Some(AgenticFrontendEvent::new(
            "agentic://context-compression-started",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "compressionId": compression_id,
                "trigger": trigger,
                "tokensBefore": tokens_before,
                "contextWindow": context_window,
            }),
        )),
        AgenticEvent::ContextCompressionCompleted {
            session_id,
            turn_id,
            compression_id,
            compression_count,
            tokens_before,
            tokens_after,
            compression_ratio,
            duration_ms,
            has_summary,
            summary_source,
            applied,
        } => Some(AgenticFrontendEvent::new(
            "agentic://context-compression-completed",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "compressionId": compression_id,
                "compressionCount": compression_count,
                "tokensBefore": tokens_before,
                "tokensAfter": tokens_after,
                "compressionRatio": compression_ratio,
                "durationMs": duration_ms,
                "hasSummary": has_summary,
                "summarySource": summary_source,
                "applied": applied,
            }),
        )),
        AgenticEvent::ContextCompressionFailed {
            session_id,
            turn_id,
            compression_id,
            error,
        } => Some(AgenticFrontendEvent::new(
            "agentic://context-compression-failed",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "compressionId": compression_id,
                "error": error,
            }),
        )),
        AgenticEvent::ThreadGoalUpdated { session_id, goal } => Some(AgenticFrontendEvent::new(
            "agentic://thread-goal-updated",
            json!({
                "sessionId": session_id,
                "goal": goal,
            }),
        )),
        AgenticEvent::SessionStateChanged {
            session_id,
            new_state,
        } => Some(AgenticFrontendEvent::new(
            "agentic://session-state-changed",
            json!({
                "sessionId": session_id,
                "newState": new_state,
            }),
        )),
        AgenticEvent::SessionHistoryChanged {
            session_id,
            settled_turn_id,
        } => Some(AgenticFrontendEvent::new(
            "agentic://session-history-changed",
            json!({
                "sessionId": session_id,
                "settledTurnId": settled_turn_id,
            }),
        )),
        AgenticEvent::SessionModelFallbackApplied {
            session_id,
            previous_model_id,
            new_model_id,
            reason,
        } => Some(AgenticFrontendEvent::new(
            "agentic://session-model-fallback-applied",
            json!({
                "sessionId": session_id,
                "previousModelId": previous_model_id,
                "newModelId": new_model_id,
                "reason": reason,
            }),
        )),
        AgenticEvent::SessionReasoningPresetAutoCleared {
            session_id,
            previous_preset_id,
            reason,
        } => Some(AgenticFrontendEvent::new(
            "agentic://session-reasoning-preset-auto-cleared",
            json!({
                "sessionId": session_id,
                "previousPresetId": previous_preset_id,
                "reason": reason,
            }),
        )),
        AgenticEvent::DeepReviewQueueStateChanged {
            session_id,
            turn_id,
            queue_state,
        } => Some(AgenticFrontendEvent::new(
            "agentic://deep-review-queue-state-changed",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "queueState": {
                    "toolId": queue_state.tool_id,
                    "subagentType": queue_state.subagent_type,
                    "status": queue_state.status,
                    "reason": queue_state.reason,
                    "queuedReviewerCount": queue_state.queued_reviewer_count,
                    "activeReviewerCount": queue_state.active_reviewer_count,
                    "effectiveParallelInstances": queue_state.effective_parallel_instances,
                    "optionalReviewerCount": queue_state.optional_reviewer_count,
                    "queueElapsedMs": queue_state.queue_elapsed_ms,
                    "runElapsedMs": queue_state.run_elapsed_ms,
                    "maxQueueWaitSeconds": queue_state.max_queue_wait_seconds,
                    "sessionConcurrencyHigh": queue_state.session_concurrency_high,
                },
            }),
        )),
        AgenticEvent::ModelRoundCompleted {
            session_id,
            turn_id,
            round_id,
            has_tool_calls,
            duration_ms,
            provider_id,
            model_config_id,
            effective_model_name,
            first_chunk_ms,
            first_visible_output_ms,
            stream_duration_ms,
            attempt_count,
            failure_category,
            token_details,
        } => Some(AgenticFrontendEvent::new(
            "agentic://model-round-completed",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "hasToolCalls": has_tool_calls,
                "durationMs": duration_ms,
                "providerId": provider_id,
                "modelConfigId": model_config_id,
                "effectiveModelName": effective_model_name,
                "firstChunkMs": first_chunk_ms,
                "firstVisibleOutputMs": first_visible_output_ms,
                "streamDurationMs": stream_duration_ms,
                "attemptCount": attempt_count,
                "failureCategory": failure_category,
                "tokenDetails": token_details,
            }),
        )),
        AgenticEvent::ModelRoundAttemptSuperseded {
            session_id,
            turn_id,
            round_id,
            diagnostic,
        } => Some(AgenticFrontendEvent::new(
            "agentic://model-round-attempt-superseded",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "diagnostic": diagnostic,
            }),
        )),
        AgenticEvent::UserSteeringInjected {
            session_id,
            turn_id,
            round_index,
            steering_id,
            content,
            display_content,
        } => Some(AgenticFrontendEvent::new(
            "agentic://user-steering-injected",
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundIndex": round_index,
                "steeringId": steering_id,
                "content": content,
                "displayContent": display_content,
            }),
        )),
        AgenticEvent::SystemError { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        DeepReviewQueueReason, DeepReviewQueueState, DeepReviewQueueStatus,
        ModelRoundAttemptDiagnostic,
    };
    use openbitfun_core_types::{
        ReasoningContentKind, SessionExecutionTarget, SessionExecutionTargetKind, WorktreeLifecycle,
    };

    #[test]
    fn session_created_projects_worktree_binding_fields() {
        let projected = project_agentic_frontend_event(AgenticEvent::SessionCreated {
            session_id: "session-1".to_string(),
            session_name: "Isolated task".to_string(),
            agent_type: "Standard".to_string(),
            workspace_path: Some("/worktrees/wt-1".to_string()),
            project_workspace_path: Some("/repo".to_string()),
            execution_target: Some(SessionExecutionTarget {
                kind: SessionExecutionTargetKind::ManagedWorktree,
                worktree_id: Some("wt-1".to_string()),
                root_path: "/worktrees/wt-1".to_string(),
                base_ref: Some("HEAD".to_string()),
                base_commit: Some("0123456789abcdef".to_string()),
                branch: None,
                lifecycle: Some(WorktreeLifecycle::Managed),
            }),
            workspace_id: Some("workspace-wt-1".to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .expect("projected");

        assert_eq!(projected.payload["workspacePath"], "/worktrees/wt-1");
        assert_eq!(projected.payload["projectWorkspacePath"], "/repo");
        assert_eq!(projected.payload["executionTarget"]["worktreeId"], "wt-1");
        assert_eq!(projected.payload["workspaceId"], "workspace-wt-1");
    }

    #[test]
    fn thinking_chunk_projects_to_text_chunk_event() {
        let projected = project_agentic_frontend_event(AgenticEvent::ThinkingChunk {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: Some("attempt-1".to_string()),
            attempt_index: Some(2),
            content: "thinking".to_string(),
            reasoning_kind: Some(ReasoningContentKind::Summary),
            is_end: true,
        })
        .expect("projected");

        assert_eq!(projected.event_name, "agentic://text-chunk");
        assert_eq!(projected.payload["contentType"], "thinking");
        assert_eq!(projected.payload["reasoningKind"], "summary");
        assert_eq!(projected.payload["isThinkingEnd"], true);
    }

    #[test]
    fn context_compression_completion_projects_applied_state() {
        let projected = project_agentic_frontend_event(AgenticEvent::ContextCompressionCompleted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            compression_id: "compression-1".to_string(),
            compression_count: 1,
            tokens_before: 100,
            tokens_after: 100,
            compression_ratio: 1.0,
            duration_ms: 5,
            has_summary: false,
            summary_source: "none".to_string(),
            applied: false,
        })
        .expect("projected");

        assert_eq!(projected.payload["applied"], false);
    }

    #[test]
    fn dialog_turn_completion_projects_duration() {
        let projected = project_agentic_frontend_event(AgenticEvent::DialogTurnCompleted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            total_rounds: 2,
            total_tools: 1,
            duration_ms: 21_206,
            partial_recovery_reason: None,
            success: Some(true),
            finish_reason: Some("stop".to_string()),
            has_final_response: Some(true),
        })
        .expect("projected");

        assert_eq!(projected.event_name, "agentic://dialog-turn-completed");
        assert_eq!(projected.payload["durationMs"], 21_206);
    }

    #[test]
    fn interrupted_turn_lifecycle_projects_generation() {
        let interrupted = project_agentic_frontend_event(AgenticEvent::DialogTurnInterrupted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            execution_generation: 2,
            model_id: Some("model-a".to_string()),
        })
        .expect("interrupted event should project");
        let recovered = project_agentic_frontend_event(AgenticEvent::DialogTurnRecovered {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            execution_generation: 3,
        })
        .expect("recovered event should project");

        assert_eq!(interrupted.event_name, "agentic://dialog-turn-interrupted");
        assert_eq!(interrupted.payload["executionGeneration"], 2);
        assert_eq!(interrupted.payload["modelId"], "model-a");
        assert_eq!(recovered.event_name, "agentic://dialog-turn-recovered");
        assert_eq!(recovered.payload["executionGeneration"], 3);
    }

    #[test]
    fn subagent_session_linked_projects_the_child_model() {
        let projected = project_agentic_frontend_event(AgenticEvent::SubagentSessionLinked {
            session_id: "child-session".to_string(),
            subagent_dialog_turn_id: "child-turn".to_string(),
            parent_session_id: "parent-session".to_string(),
            parent_dialog_turn_id: "parent-turn".to_string(),
            parent_tool_call_id: "task-tool".to_string(),
            agent_type: Some("Explore".to_string()),
            model_id: Some("fast".to_string()),
            focused_review_display_label: Some("Authentication boundary".to_string()),
        })
        .expect("projected");

        assert_eq!(projected.event_name, "agentic://subagent-session-linked");
        assert_eq!(projected.payload["sessionId"], "child-session");
        assert_eq!(projected.payload["modelId"], "fast");
        assert_eq!(
            projected.payload["focusedReviewDisplayLabel"],
            "Authentication boundary"
        );
    }

    #[test]
    fn model_round_started_projects_distinct_model_identity_fields() {
        let projected = project_agentic_frontend_event(AgenticEvent::ModelRoundStarted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            round_group_id: None,
            round_index: 0,
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
        })
        .expect("projected");

        assert_eq!(projected.payload["modelConfigId"], "model-config");
        assert_eq!(projected.payload["effectiveModelName"], "provider-model");
    }

    #[test]
    fn model_round_completed_projects_completion_fields() {
        let projected = project_agentic_frontend_event(AgenticEvent::ModelRoundCompleted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            has_tool_calls: false,
            duration_ms: None,
            provider_id: None,
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            attempt_count: Some(1),
            failure_category: Some("invalid_tool_arguments".to_string()),
            token_details: None,
        })
        .expect("projected");

        assert_eq!(projected.event_name, "agentic://model-round-completed");
        assert_eq!(projected.payload["attemptCount"], 1);
    }

    #[test]
    fn model_round_attempt_superseded_projects_realtime_retry_diagnostic() {
        let projected = project_agentic_frontend_event(AgenticEvent::ModelRoundAttemptSuperseded {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            diagnostic: ModelRoundAttemptDiagnostic {
                attempt_id: "round-1:attempt:1".to_string(),
                attempt_index: 1,
                category: "invalid_tool_arguments".to_string(),
                raw_error: Some("Provider rejected the payload".to_string()),
                tool_calls: vec![],
            },
        })
        .expect("projected");

        assert_eq!(
            projected.event_name,
            "agentic://model-round-attempt-superseded"
        );
        assert_eq!(projected.payload["sessionId"], "session-1");
        assert_eq!(projected.payload["diagnostic"]["attemptIndex"], 1);
        assert_eq!(
            projected.payload["diagnostic"]["rawError"],
            "Provider rejected the payload"
        );
    }

    #[test]
    fn deep_review_queue_projection_preserves_camel_case_contract() {
        let projected = project_agentic_frontend_event(AgenticEvent::DeepReviewQueueStateChanged {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            queue_state: DeepReviewQueueState {
                tool_id: "tool-1".to_string(),
                subagent_type: "ReviewSecurity".to_string(),
                status: DeepReviewQueueStatus::QueuedForCapacity,
                reason: Some(DeepReviewQueueReason::ProviderConcurrencyLimit),
                queued_reviewer_count: 2,
                active_reviewer_count: Some(1),
                effective_parallel_instances: Some(2),
                optional_reviewer_count: Some(1),
                queue_elapsed_ms: Some(1200),
                run_elapsed_ms: None,
                max_queue_wait_seconds: Some(60),
                session_concurrency_high: true,
            },
        })
        .expect("projected");

        assert_eq!(
            projected.event_name,
            "agentic://deep-review-queue-state-changed"
        );
        assert_eq!(projected.payload["queueState"]["toolId"], "tool-1");
        assert_eq!(
            projected.payload["queueState"]["reason"],
            json!("provider_concurrency_limit")
        );
        assert_eq!(
            projected.payload["queueState"]["sessionConcurrencyHigh"],
            true
        );
    }

    #[test]
    fn session_title_projection_preserves_legacy_event_name_and_timestamp() {
        let projected = project_agentic_frontend_event(AgenticEvent::SessionTitleGenerated {
            session_id: "session-1".to_string(),
            title: "Title".to_string(),
            method: "model".to_string(),
        })
        .expect("projected");

        assert_eq!(projected.event_name, "session_title_generated");
        assert_eq!(projected.payload["sessionId"], "session-1");
        assert!(projected.payload["timestamp"].as_i64().is_some());
    }

    #[test]
    fn reasoning_preset_auto_clear_projects_canonical_auto_transition() {
        let projected =
            project_agentic_frontend_event(AgenticEvent::SessionReasoningPresetAutoCleared {
                session_id: "session-1".to_string(),
                previous_preset_id: "high".to_string(),
                reason: "reasoning_catalog_updated".to_string(),
            })
            .expect("projected");

        assert_eq!(
            projected.event_name,
            "agentic://session-reasoning-preset-auto-cleared"
        );
        assert_eq!(projected.payload["sessionId"], "session-1");
        assert_eq!(projected.payload["previousPresetId"], "high");
        assert_eq!(projected.payload["reason"], "reasoning_catalog_updated");
    }
}
