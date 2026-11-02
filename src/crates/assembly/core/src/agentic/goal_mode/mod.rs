//! Persisted session thread goals (Codex `/goal` parity).
//!
//! Users set objectives via `/goal <objective>`; the agent manages lifecycle through
//! `create_goal`, `update_goal`, and `get_goal` tools. Runtime auto-continues active
//! goals after idle turns using internal continuation prompts.

mod token_accounting;

pub(crate) use token_accounting::record_thread_goal_token_usage;

use crate::agentic::core::{InternalReminderKind, Message};
use crate::agentic::session::SessionManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{info, warn};
pub use openbitfun_agent_runtime::thread_goal::{
    billable_tokens_from_counts, build_objective_updated_plan, build_thread_goal_continuation_plan,
    clear_thread_goal_patch, completion_budget_report, continuation_prompt,
    effective_subagent_timeout_seconds, goal_continuation_submit_retry_delay_ms,
    goal_objective_from_prompt, goal_tool_response, objective_updated_prompt,
    should_skip_goal_continuation_after_turn, should_skip_goal_for_turn, thread_goal_patch,
    thread_goal_status_is_resumable, ThreadGoalContinuationFacts, ThreadGoalRuntime,
    GOAL_CONTINUATION_SUBMIT_RETRY_BASE_DELAY_MS, GOAL_CONTINUATION_SUBMIT_RETRY_MAX_DELAY_MS,
};
use openbitfun_agent_runtime::thread_goal::{
    build_set_thread_goal_result, is_usage_limit_message, SetThreadGoalRequest,
};
pub use openbitfun_runtime_ports::{
    validate_thread_goal_objective, SetThreadGoalResult, ThreadGoal, ThreadGoalContinuationPlan,
    ThreadGoalStatus, ThreadGoalToolResponse, GOAL_MODE_METADATA_KEY, MAX_CONTEXT_SUMMARY_CHARS,
    MAX_GOAL_CONTINUATIONS, MAX_THREAD_GOAL_AUTO_CONTINUATIONS, MAX_THREAD_GOAL_OBJECTIVE_CHARS,
    THREAD_GOAL_METADATA_KEY,
};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub fn thread_goal_from_custom_metadata(
    custom_metadata: Option<&serde_json::Value>,
) -> Option<ThreadGoal> {
    openbitfun_agent_runtime::thread_goal::thread_goal_from_custom_metadata(
        custom_metadata,
        Uuid::new_v4().to_string(),
        now_epoch_seconds(),
    )
}

pub fn is_usage_limit_error(error: &OpenBitFunError) -> bool {
    is_usage_limit_message(&error.to_string())
}

pub fn goal_internal_context_message(prompt: String) -> Message {
    Message::internal_reminder(InternalReminderKind::GoalContinuation, prompt)
}

pub fn goal_objective_updated_message(prompt: String) -> Message {
    Message::internal_reminder(InternalReminderKind::GoalObjectiveUpdated, prompt)
}

pub struct ThreadGoalStore<'a> {
    session_manager: &'a SessionManager,
}

impl<'a> ThreadGoalStore<'a> {
    pub fn new(session_manager: &'a SessionManager) -> Self {
        Self { session_manager }
    }

    async fn load_metadata(
        &self,
        session_id: &str,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Option<serde_json::Value>> {
        Ok(self
            .session_manager
            .load_session_metadata(workspace_path, session_id)
            .await?
            .and_then(|metadata| metadata.custom_metadata))
    }

    pub async fn get_thread_goal(
        &self,
        session_id: &str,
        workspace_path: &Path,
    ) -> OpenBitFunResult<Option<ThreadGoal>> {
        let metadata = self.load_metadata(session_id, workspace_path).await?;
        Ok(thread_goal_from_custom_metadata(metadata.as_ref()))
    }

    pub(crate) async fn persist_thread_goal(
        &self,
        session_id: &str,
        _workspace_path: &Path,
        goal: Option<ThreadGoal>,
    ) -> OpenBitFunResult<()> {
        let patch = match goal {
            Some(goal) => thread_goal_patch(&goal),
            None => clear_thread_goal_patch(),
        };
        self.session_manager
            .merge_session_custom_metadata(session_id, patch)
            .await
    }

    pub async fn clear_thread_goal(
        &self,
        session_id: &str,
        workspace_path: &Path,
    ) -> OpenBitFunResult<()> {
        self.persist_thread_goal(session_id, workspace_path, None)
            .await
    }

    pub async fn set_thread_goal(
        &self,
        session_id: &str,
        workspace_path: &Path,
        objective: Option<String>,
        status: Option<ThreadGoalStatus>,
        token_budget: Option<Option<i64>>,
        replace_existing: bool,
    ) -> OpenBitFunResult<SetThreadGoalResult> {
        let existing = self.get_thread_goal(session_id, workspace_path).await?;

        let result = build_set_thread_goal_result(SetThreadGoalRequest {
            session_id: session_id.to_string(),
            existing,
            objective,
            status,
            token_budget,
            replace_existing,
            now_epoch_seconds: now_epoch_seconds(),
            new_goal_id: Uuid::new_v4().to_string(),
        })
        .map_err(|error| match error {
            openbitfun_agent_runtime::thread_goal::ThreadGoalRuntimeError::Validation(message) => {
                OpenBitFunError::Validation(message)
            }
            openbitfun_agent_runtime::thread_goal::ThreadGoalRuntimeError::NotFound(message) => {
                OpenBitFunError::NotFound(message)
            }
        })?;

        self.persist_thread_goal(session_id, workspace_path, Some(result.goal.clone()))
            .await?;

        Ok(result)
    }

    pub async fn create_thread_goal(
        &self,
        session_id: &str,
        workspace_path: &Path,
        objective: String,
        token_budget: Option<i64>,
    ) -> OpenBitFunResult<ThreadGoal> {
        if self
            .get_thread_goal(session_id, workspace_path)
            .await?
            .is_some()
        {
            return Err(OpenBitFunError::Validation(format!(
                "cannot create a new goal because session {session_id} already has a goal"
            )));
        }
        let result = self
            .set_thread_goal(
                session_id,
                workspace_path,
                Some(objective),
                Some(ThreadGoalStatus::Active),
                Some(token_budget),
                false,
            )
            .await?;
        Ok(result.goal)
    }
}

pub async fn maybe_build_continuation_after_turn(
    store: &ThreadGoalStore<'_>,
    runtime: &ThreadGoalRuntime,
    session_id: &str,
    workspace_path: &Path,
    turn_id: &str,
    turn_tokens: usize,
    turn_completed: bool,
) -> OpenBitFunResult<Option<ThreadGoalContinuationPlan>> {
    let Some(goal) = store.get_thread_goal(session_id, workspace_path).await? else {
        return Ok(None);
    };

    let outcome = runtime.continuation_after_turn(
        goal,
        ThreadGoalContinuationFacts {
            turn_id,
            turn_tokens,
            turn_completed,
            now_epoch_seconds: now_epoch_seconds(),
        },
    );

    if outcome.reached_auto_continuation_limit {
        if let Some(goal) = outcome.goal_to_persist.as_ref() {
            warn!(
                "Thread goal auto-continuation limit reached; marking blocked: session_id={}, goal_id={}, objective={}",
                session_id, goal.goal_id, goal.objective
            );
        }
    }

    if let Some(goal) = outcome.goal_to_persist.as_ref() {
        store
            .persist_thread_goal(session_id, workspace_path, Some(goal.clone()))
            .await?;
        if outcome.scheduled_auto_continuation {
            info!(
                "Scheduling thread goal auto-continuation: session_id={}, attempt={}/{}, objective={}",
                session_id,
                goal.auto_continuation_count,
                MAX_THREAD_GOAL_AUTO_CONTINUATIONS,
                goal.objective
            );
        }
    }

    Ok(outcome.plan)
}

pub fn user_facing_thread_goal_error(error: OpenBitFunError) -> OpenBitFunError {
    match error {
        OpenBitFunError::Validation(_) | OpenBitFunError::NotFound(_) => error,
        other => {
            warn!("Thread goal operation failed: {other}");
            OpenBitFunError::Validation(
                "Thread goal operation failed. Check session state and try again.".to_string(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumable_statuses_match_ui_actions() {
        assert!(thread_goal_status_is_resumable(ThreadGoalStatus::Paused));
        assert!(thread_goal_status_is_resumable(ThreadGoalStatus::Blocked));
        assert!(thread_goal_status_is_resumable(
            ThreadGoalStatus::UsageLimited
        ));
        assert!(!thread_goal_status_is_resumable(ThreadGoalStatus::Active));
        assert!(!thread_goal_status_is_resumable(
            ThreadGoalStatus::BudgetLimited
        ));
        assert!(!thread_goal_status_is_resumable(ThreadGoalStatus::Complete));
    }

    #[test]
    fn continuation_plan_metadata_marks_completion_check() {
        let plan = build_thread_goal_continuation_plan(&ThreadGoal {
            goal_id: "g1".to_string(),
            session_id: "s1".to_string(),
            objective: "sync upstream".to_string(),
            status: ThreadGoalStatus::Active,
            token_budget: None,
            tokens_used: 0,
            time_used_seconds: 0,
            created_at: 1,
            updated_at: 2,
            auto_continuation_count: 2,
        });
        assert!(plan.display_message.contains("completion check"));
        assert!(plan.display_message.contains("2/100"));
        assert_eq!(
            plan.user_message_metadata["threadGoalContinuationCheck"],
            true
        );
        assert_eq!(plan.user_message_metadata["autoContinuationAttempt"], 2);
        assert_eq!(plan.user_message_metadata["autoContinuationMax"], 100);
    }

    #[test]
    fn continuation_prompt_references_update_goal() {
        let prompt = continuation_prompt(&ThreadGoal {
            goal_id: "g1".to_string(),
            session_id: "s1".to_string(),
            objective: "finish stack".to_string(),
            status: ThreadGoalStatus::Active,
            token_budget: Some(10_000),
            tokens_used: 1_000,
            time_used_seconds: 0,
            created_at: 1,
            updated_at: 2,
            auto_continuation_count: 0,
        });
        assert!(prompt.contains("finish stack"));
        assert!(prompt.contains("update_goal"));
    }

    #[test]
    fn goal_objective_turns_participate_in_accounting() {
        assert!(!should_skip_goal_for_turn("/goal fix bug", None));
        assert!(should_skip_goal_for_turn("/goal pause", None));
        assert!(!should_skip_goal_for_turn("fix bug", None));
    }

    #[test]
    fn objective_updated_followup_participates_in_accounting() {
        let metadata = serde_json::json!({ "threadGoalObjectiveUpdated": true });
        assert!(!should_skip_goal_for_turn("Adjust work", Some(&metadata)));
    }

    #[test]
    fn objective_updated_turn_still_schedules_continuation_after_turn() {
        let metadata = serde_json::json!({ "threadGoalObjectiveUpdated": true });
        assert!(!should_skip_goal_continuation_after_turn(
            "Adjust work",
            Some(&metadata)
        ));
    }

    #[test]
    fn continuation_turn_chains_until_goal_completes_or_limit() {
        let metadata = serde_json::json!({ "threadGoalContinuation": true });
        assert!(!should_skip_goal_continuation_after_turn(
            "Continue toward goal",
            Some(&metadata)
        ));
    }

    #[test]
    fn max_goal_continuations_matches_legacy_limit() {
        assert_eq!(MAX_GOAL_CONTINUATIONS, 100);
        assert_eq!(MAX_THREAD_GOAL_AUTO_CONTINUATIONS, 100);
    }

    #[test]
    fn goal_continuation_submit_retry_delay_backoff_caps() {
        assert_eq!(goal_continuation_submit_retry_delay_ms(0), 0);
        assert_eq!(goal_continuation_submit_retry_delay_ms(1), 1_000);
        assert_eq!(goal_continuation_submit_retry_delay_ms(2), 2_000);
        assert_eq!(
            goal_continuation_submit_retry_delay_ms(100),
            GOAL_CONTINUATION_SUBMIT_RETRY_MAX_DELAY_MS
        );
    }

    #[test]
    fn billable_tokens_subtracts_cached_input() {
        assert_eq!(billable_tokens_from_counts(1000, 400, 200), 800);
    }

    #[test]
    fn usage_limit_error_detects_quota_messages() {
        assert!(is_usage_limit_error(&OpenBitFunError::AIClient(
            "insufficient_quota: billing hard limit".to_string()
        )));
        assert!(!is_usage_limit_error(&OpenBitFunError::Validation(
            "tool failed".to_string()
        )));
    }

    #[test]
    fn objective_updated_plan_skips_turn_accounting_but_allows_continuation() {
        let metadata = build_objective_updated_plan(&ThreadGoal {
            goal_id: "g1".to_string(),
            session_id: "s1".to_string(),
            objective: "ship feature".to_string(),
            status: ThreadGoalStatus::Active,
            token_budget: None,
            tokens_used: 0,
            time_used_seconds: 0,
            created_at: 1,
            updated_at: 2,
            auto_continuation_count: 0,
        })
        .user_message_metadata;
        assert!(!should_skip_goal_for_turn("Adjust work", Some(&metadata)));
        assert!(!should_skip_goal_continuation_after_turn(
            "Adjust work",
            Some(&metadata)
        ));
    }
}
