//! Persisted thread goal runtime decisions.

use openbitfun_runtime_ports::{
    validate_thread_goal_objective, SetThreadGoalResult, ThreadGoal, ThreadGoalContinuationPlan,
    ThreadGoalStatus, ThreadGoalToolResponse, GOAL_MODE_METADATA_KEY,
    MAX_THREAD_GOAL_AUTO_CONTINUATIONS, THREAD_GOAL_METADATA_KEY,
};
use std::fmt;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const LIFECYCLE_PROMPT: &str = include_str!("thread_goal/templates/lifecycle.md");
const CONTINUATION_PROMPT_TEMPLATE: &str = include_str!("thread_goal/templates/continuation.md");
const BUDGET_LIMIT_PROMPT_TEMPLATE: &str = include_str!("thread_goal/templates/budget_limit.md");
const OBJECTIVE_UPDATED_PROMPT_TEMPLATE: &str =
    include_str!("thread_goal/templates/objective_updated.md");

/// Backoff when scheduling a goal continuation dialog turn fails (network, queue, etc.).
pub const GOAL_CONTINUATION_SUBMIT_RETRY_BASE_DELAY_MS: u64 = 1_000;
pub const GOAL_CONTINUATION_SUBMIT_RETRY_MAX_DELAY_MS: u64 = 30_000;

/// Delay before retrying a failed goal-continuation submit (1s, 2s, 4s, ... capped at 30s).
pub fn goal_continuation_submit_retry_delay_ms(retry_count: u32) -> u64 {
    if retry_count == 0 {
        return 0;
    }
    GOAL_CONTINUATION_SUBMIT_RETRY_BASE_DELAY_MS
        .saturating_mul(1_u64 << retry_count.saturating_sub(1).min(5))
        .min(GOAL_CONTINUATION_SUBMIT_RETRY_MAX_DELAY_MS)
}

/// In active thread-goal mode, subagents start without an active timeout.
pub fn effective_subagent_timeout_seconds(
    timeout_seconds: Option<u64>,
    parent_thread_goal_active: bool,
) -> Option<u64> {
    if parent_thread_goal_active {
        None
    } else {
        timeout_seconds.filter(|seconds| *seconds > 0)
    }
}

/// Objective submitted through a plain prompt, independent of the sending surface.
/// Keep the existing UI control commands out of objective creation.
pub fn goal_objective_from_prompt(prompt: &str) -> Option<&str> {
    let prompt = prompt.trim();
    let command = prompt.get(..5)?;
    if !command.eq_ignore_ascii_case("/goal") {
        return None;
    }
    let rest = prompt.get(5..)?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let objective = rest.trim();
    if objective.is_empty()
        || ["edit", "clear", "pause", "resume"]
            .iter()
            .any(|control| objective.eq_ignore_ascii_case(control))
    {
        return None;
    }
    Some(objective)
}

/// Skip marking turn start / token accounting for turns that are not goal-driving work.
pub fn should_skip_goal_for_turn(
    user_input: &str,
    user_message_metadata: Option<&serde_json::Value>,
) -> bool {
    should_skip_goal_turn_accounting(user_input, user_message_metadata)
}

/// Inputs that must not trigger another auto-continuation after the turn ends.
pub fn should_skip_goal_continuation_after_turn(
    user_input: &str,
    user_message_metadata: Option<&serde_json::Value>,
) -> bool {
    should_skip_goal_turn_accounting(user_input, user_message_metadata)
}

fn should_skip_goal_turn_accounting(
    user_input: &str,
    user_message_metadata: Option<&serde_json::Value>,
) -> bool {
    let trimmed = user_input.trim();
    if trimmed.eq_ignore_ascii_case("/compact")
        || trimmed.starts_with("/usage")
        || trimmed.starts_with("/btw")
        || (trimmed
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("/goal"))
            && (trimmed.len() == 5 || trimmed[5..].starts_with(char::is_whitespace))
            && goal_objective_from_prompt(trimmed).is_none())
    {
        return true;
    }
    if user_message_metadata
        .and_then(|metadata| metadata.get("maintenanceTurn"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return true;
    }
    false
}

fn escape_xml_text(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn render_template(template: &str, replacements: &[(&str, &str)]) -> String {
    // Substitute only template text, never placeholders inside user-provided data.
    let mut rendered = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{ ") {
        rendered.push_str(&rest[..start]);
        let candidate = &rest[start..];
        let Some(end) = candidate.find(" }}") else {
            rendered.push_str(candidate);
            return rendered;
        };
        let key = &candidate[3..end];
        let placeholder_end = end + 3;
        match replacements.iter().find(|(name, _)| *name == key) {
            Some((_, value)) => rendered.push_str(value),
            None => rendered.push_str(&candidate[..placeholder_end]),
        }
        rest = &candidate[placeholder_end..];
    }
    rendered.push_str(rest);
    rendered
}

pub fn continuation_prompt(goal: &ThreadGoal) -> String {
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());
    let remaining_tokens = goal
        .remaining_tokens()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unbounded".to_string());
    render_template(
        CONTINUATION_PROMPT_TEMPLATE,
        &[
            ("lifecycle_instructions", LIFECYCLE_PROMPT),
            ("objective", &escape_xml_text(goal.objective.trim())),
            ("tokens_used", &goal.tokens_used.to_string()),
            ("token_budget", token_budget.as_str()),
            ("remaining_tokens", remaining_tokens.as_str()),
        ],
    )
}

pub fn budget_limit_prompt(goal: &ThreadGoal) -> String {
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());
    render_template(
        BUDGET_LIMIT_PROMPT_TEMPLATE,
        &[
            ("lifecycle_instructions", LIFECYCLE_PROMPT),
            ("objective", &escape_xml_text(goal.objective.trim())),
            ("tokens_used", &goal.tokens_used.to_string()),
            ("time_used_seconds", &goal.time_used_seconds.to_string()),
            ("token_budget", token_budget.as_str()),
        ],
    )
}

pub fn objective_updated_prompt(goal: &ThreadGoal) -> String {
    let token_budget = goal
        .token_budget
        .map(|budget| budget.to_string())
        .unwrap_or_else(|| "none".to_string());
    let remaining_tokens = goal
        .remaining_tokens()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unbounded".to_string());
    render_template(
        OBJECTIVE_UPDATED_PROMPT_TEMPLATE,
        &[
            ("lifecycle_instructions", LIFECYCLE_PROMPT),
            ("objective", &escape_xml_text(goal.objective.trim())),
            ("tokens_used", &goal.tokens_used.to_string()),
            ("token_budget", token_budget.as_str()),
            ("remaining_tokens", remaining_tokens.as_str()),
        ],
    )
}

/// Codex-style billable tokens: non-cached input + output.
pub fn billable_tokens_from_counts(
    input_tokens: usize,
    cached_tokens: usize,
    output_tokens: usize,
) -> usize {
    input_tokens.saturating_sub(cached_tokens) + output_tokens
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThreadGoalTokenUsageFacts {
    pub input_tokens: usize,
    pub output_tokens: Option<usize>,
    pub cached_tokens: Option<usize>,
    pub is_subagent: bool,
}

pub fn should_record_thread_goal_token_usage(facts: ThreadGoalTokenUsageFacts) -> Option<usize> {
    if facts.is_subagent {
        return None;
    }

    let billable = billable_tokens_from_counts(
        facts.input_tokens,
        facts.cached_tokens.unwrap_or(0),
        facts.output_tokens.unwrap_or(0),
    );
    (billable > 0).then_some(billable)
}

pub fn is_usage_limit_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "usage limit",
        "usage_limit",
        "insufficient_quota",
        "insufficient quota",
        "quota exceeded",
        "rate limit",
        "rate_limit",
        "billing",
        "exceeded your current",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

pub fn build_objective_updated_plan(goal: &ThreadGoal) -> ThreadGoalContinuationPlan {
    ThreadGoalContinuationPlan {
        prepended_reminders: vec![objective_updated_prompt(goal)],
        display_message: format!("Thread goal updated: {}", goal.objective.trim()),
        user_message_metadata: serde_json::json!({
            "threadGoalObjectiveUpdated": true,
            "goalId": goal.goal_id,
            "objective": goal.objective,
        }),
    }
}

pub fn completion_budget_report(goal: &ThreadGoal) -> Option<String> {
    if goal.token_budget.is_none() && goal.time_used_seconds <= 0 {
        return None;
    }
    Some(
        "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."
            .to_string(),
    )
}

pub fn goal_tool_response(
    goal: Option<ThreadGoal>,
    include_completion_report: bool,
) -> ThreadGoalToolResponse {
    let remaining_tokens = goal.as_ref().and_then(ThreadGoal::remaining_tokens);
    let completion_budget_report = if include_completion_report {
        goal.as_ref()
            .filter(|goal| goal.status == ThreadGoalStatus::Complete)
            .and_then(completion_budget_report)
    } else {
        None
    };
    ThreadGoalToolResponse {
        goal,
        remaining_tokens,
        completion_budget_report,
    }
}

pub fn thread_goal_patch(goal: &ThreadGoal) -> serde_json::Value {
    serde_json::json!({
        THREAD_GOAL_METADATA_KEY: goal,
    })
}

pub fn clear_thread_goal_patch() -> serde_json::Value {
    serde_json::json!({
        THREAD_GOAL_METADATA_KEY: serde_json::Value::Null,
    })
}

pub fn thread_goal_event_payload(goal: Option<ThreadGoal>) -> Option<serde_json::Value> {
    goal.and_then(|goal| serde_json::to_value(goal).ok())
}

pub fn thread_goal_from_custom_metadata(
    custom_metadata: Option<&serde_json::Value>,
    legacy_goal_id: String,
    legacy_created_at: i64,
) -> Option<ThreadGoal> {
    if let Some(goal) = custom_metadata
        .and_then(|value| value.get(THREAD_GOAL_METADATA_KEY))
        .and_then(|value| serde_json::from_value::<ThreadGoal>(value.clone()).ok())
    {
        return Some(goal);
    }
    migrate_legacy_goal_mode(custom_metadata, legacy_goal_id, legacy_created_at)
}

fn migrate_legacy_goal_mode(
    custom_metadata: Option<&serde_json::Value>,
    legacy_goal_id: String,
    legacy_created_at: i64,
) -> Option<ThreadGoal> {
    let legacy = custom_metadata?.get(GOAL_MODE_METADATA_KEY)?;
    let active = legacy.get("active")?.as_bool().unwrap_or(false);
    if !active {
        return None;
    }
    let objective = legacy
        .get("initialGoal")
        .and_then(|value| value.get("goalText"))
        .and_then(|value| value.as_str())
        .or_else(|| legacy.get("goalText").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let session_id = legacy
        .get("sessionId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let created_at = legacy
        .get("activatedAtMs")
        .and_then(|value| value.as_u64())
        .map(|value| value as i64)
        .unwrap_or(legacy_created_at);
    Some(ThreadGoal {
        goal_id: legacy_goal_id,
        session_id: session_id.to_string(),
        objective: objective.to_string(),
        status: ThreadGoalStatus::Active,
        token_budget: None,
        tokens_used: 0,
        time_used_seconds: 0,
        created_at,
        updated_at: created_at,
        auto_continuation_count: 0,
    })
}

/// Statuses where the user may explicitly resume auto-continuation toward the goal.
pub fn thread_goal_status_is_resumable(status: ThreadGoalStatus) -> bool {
    matches!(
        status,
        ThreadGoalStatus::Paused | ThreadGoalStatus::Blocked | ThreadGoalStatus::UsageLimited
    )
}

pub fn build_thread_goal_continuation_plan(goal: &ThreadGoal) -> ThreadGoalContinuationPlan {
    let prompt = match goal.status {
        ThreadGoalStatus::BudgetLimited => budget_limit_prompt(goal),
        ThreadGoalStatus::Active => continuation_prompt(goal),
        _ => continuation_prompt(goal),
    };
    ThreadGoalContinuationPlan {
        prepended_reminders: vec![prompt],
        display_message: format!(
            "Thread goal completion check (auto {}/{}): {}",
            goal.auto_continuation_count,
            MAX_THREAD_GOAL_AUTO_CONTINUATIONS,
            goal.objective.trim()
        ),
        user_message_metadata: serde_json::json!({
            "threadGoalContinuation": true,
            "threadGoalContinuationCheck": true,
            "goalId": goal.goal_id,
            "objective": goal.objective,
            "autoContinuationAttempt": goal.auto_continuation_count,
            "autoContinuationMax": MAX_THREAD_GOAL_AUTO_CONTINUATIONS,
        }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThreadGoalRuntimeError {
    Validation(String),
    NotFound(String),
}

impl fmt::Display for ThreadGoalRuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) | Self::NotFound(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ThreadGoalRuntimeError {}

#[derive(Debug, Clone)]
pub struct SetThreadGoalRequest {
    pub session_id: String,
    pub existing: Option<ThreadGoal>,
    pub objective: Option<String>,
    pub status: Option<ThreadGoalStatus>,
    pub token_budget: Option<Option<i64>>,
    pub replace_existing: bool,
    pub now_epoch_seconds: i64,
    pub new_goal_id: String,
}

pub fn build_set_thread_goal_result(
    request: SetThreadGoalRequest,
) -> Result<SetThreadGoalResult, ThreadGoalRuntimeError> {
    if let Some(budget) = request.token_budget.flatten() {
        if budget <= 0 {
            return Err(ThreadGoalRuntimeError::Validation(
                "goal budgets must be positive when provided".to_string(),
            ));
        }
    }

    let objective = request.objective.map(|value| value.trim().to_string());
    if let Some(objective) = objective.as_deref() {
        validate_thread_goal_objective(objective).map_err(ThreadGoalRuntimeError::Validation)?;
    }

    let replaced_existing =
        request.replace_existing || objective.is_some() && request.existing.is_some();
    let existing = if request.replace_existing {
        None
    } else {
        request.existing
    };

    let goal = if let Some(objective) = objective {
        if let Some(mut existing) = existing {
            let objective_changed = existing.objective != objective;
            existing.objective = objective;
            if objective_changed {
                existing.auto_continuation_count = 0;
            }
            if let Some(status) = request.status {
                existing.status = status;
            }
            if let Some(token_budget) = request.token_budget {
                existing.token_budget = token_budget;
            }
            existing.updated_at = request.now_epoch_seconds;
            existing
        } else {
            ThreadGoal {
                goal_id: request.new_goal_id,
                session_id: request.session_id,
                objective,
                status: request.status.unwrap_or(ThreadGoalStatus::Active),
                token_budget: request.token_budget.flatten(),
                tokens_used: 0,
                time_used_seconds: 0,
                created_at: request.now_epoch_seconds,
                updated_at: request.now_epoch_seconds,
                auto_continuation_count: 0,
            }
        }
    } else {
        let Some(mut existing) = existing else {
            return Err(ThreadGoalRuntimeError::NotFound(format!(
                "cannot update goal for session {}: no goal exists",
                request.session_id
            )));
        };
        if let Some(status) = request.status {
            if status == ThreadGoalStatus::Active && existing.status == ThreadGoalStatus::Blocked {
                existing.auto_continuation_count = 0;
            }
            existing.status = status;
        }
        if let Some(token_budget) = request.token_budget {
            existing.token_budget = token_budget;
        }
        existing.updated_at = request.now_epoch_seconds;
        existing
    };

    Ok(SetThreadGoalResult {
        goal,
        replaced_existing,
    })
}

#[derive(Debug)]
struct GoalTurnAccounting {
    turn_id: String,
    baseline_tokens: usize,
    /// Cumulative Codex-style billable tokens for the active dialog turn.
    cumulative_billable: usize,
    active_goal_id: Option<String>,
}

#[derive(Debug)]
struct GoalWallClockAccounting {
    last_accounted_at: Instant,
    active_goal_id: Option<String>,
}

#[derive(Debug, Default)]
pub struct ThreadGoalRuntime {
    accounting: Mutex<GoalRuntimeAccounting>,
    budget_limit_reported_goal_id: Mutex<Option<String>>,
}

#[derive(Debug, Default)]
struct GoalRuntimeAccounting {
    turn: Option<GoalTurnAccounting>,
    wall_clock: GoalWallClockAccounting,
}

impl Default for GoalWallClockAccounting {
    fn default() -> Self {
        Self {
            last_accounted_at: Instant::now(),
            active_goal_id: None,
        }
    }
}

impl ThreadGoalRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mark_turn_started(&self, turn_id: &str, goal: Option<&ThreadGoal>) {
        let mut accounting = lock_or_recover(&self.accounting);
        // Repeated steering toward the same active goal is not a new turn.
        if let Some(goal) = goal.filter(|goal| goal.is_active()) {
            if accounting.turn.as_ref().is_some_and(|turn| {
                turn.turn_id == turn_id
                    && turn.active_goal_id.as_deref() == Some(goal.goal_id.as_str())
            }) {
                accounting.wall_clock.mark_active_goal(goal.goal_id.clone());
                return;
            }
        }
        accounting.turn = Some(GoalTurnAccounting {
            turn_id: turn_id.to_string(),
            baseline_tokens: 0,
            cumulative_billable: 0,
            active_goal_id: None,
        });
        if let Some(goal) = goal.filter(|goal| goal.is_active()) {
            if let Some(turn) = accounting.turn.as_mut() {
                turn.active_goal_id = Some(goal.goal_id.clone());
            }
            accounting.wall_clock.mark_active_goal(goal.goal_id.clone());
        } else {
            accounting.wall_clock.clear_active_goal();
        }
    }

    pub fn record_round_billable_tokens(&self, turn_id: &str, billable: usize) {
        if billable == 0 {
            return;
        }
        let mut accounting = lock_or_recover(&self.accounting);
        let Some(turn) = accounting.turn.as_mut() else {
            return;
        };
        if turn.turn_id != turn_id || turn.active_goal_id.is_none() {
            return;
        }
        turn.cumulative_billable = turn.cumulative_billable.saturating_add(billable);
    }

    pub fn turn_cumulative_billable_tokens(&self, turn_id: &str) -> usize {
        let accounting = lock_or_recover(&self.accounting);
        accounting
            .turn
            .as_ref()
            .filter(|turn| turn.turn_id == turn_id)
            .map(|turn| turn.cumulative_billable)
            .unwrap_or(0)
    }

    pub fn current_turn_usage(&self) -> Option<(String, usize)> {
        let accounting = lock_or_recover(&self.accounting);
        accounting
            .turn
            .as_ref()
            .filter(|turn| turn.active_goal_id.is_some())
            .map(|turn| (turn.turn_id.clone(), turn.cumulative_billable))
    }

    pub fn clear_active_goal(&self, turn_id: Option<&str>) {
        let mut accounting = lock_or_recover(&self.accounting);
        if let Some(expected) = turn_id {
            if accounting
                .turn
                .as_ref()
                .is_none_or(|turn| turn.turn_id != expected)
            {
                return;
            }
        }
        if let Some(turn) = accounting.turn.as_mut() {
            turn.active_goal_id = None;
        }
        accounting.wall_clock.clear_active_goal();
    }

    pub fn account_turn_tokens(
        &self,
        turn_id: &str,
        turn_tokens: usize,
        goal: &mut ThreadGoal,
        now_epoch_seconds: i64,
    ) -> bool {
        let mut accounting = lock_or_recover(&self.accounting);
        let Some(turn) = accounting.turn.as_mut() else {
            return false;
        };
        if turn.turn_id != turn_id || turn.active_goal_id.as_deref() != Some(goal.goal_id.as_str())
        {
            return false;
        }
        let delta = turn_tokens.saturating_sub(turn.baseline_tokens) as i64;
        turn.baseline_tokens = turn_tokens;
        let time_delta = accounting.wall_clock.time_delta_seconds();
        if delta <= 0 && time_delta <= 0 {
            return false;
        }
        goal.tokens_used = goal.tokens_used.saturating_add(delta.max(0));
        goal.time_used_seconds = goal.time_used_seconds.saturating_add(time_delta);
        goal.updated_at = now_epoch_seconds;
        accounting.wall_clock.mark_accounted(time_delta);
        Self::apply_budget_status(goal)
    }

    pub fn continuation_after_turn(
        &self,
        mut goal: ThreadGoal,
        facts: ThreadGoalContinuationFacts<'_>,
    ) -> ThreadGoalContinuationOutcome {
        self.account_turn_tokens(
            facts.turn_id,
            facts.turn_tokens,
            &mut goal,
            facts.now_epoch_seconds,
        );
        if !facts.turn_completed {
            return ThreadGoalContinuationOutcome {
                goal_to_persist: Some(goal),
                plan: None,
                reached_auto_continuation_limit: false,
                scheduled_auto_continuation: false,
            };
        }
        if goal.status == ThreadGoalStatus::BudgetLimited {
            if self.mark_budget_limit_reported(goal.goal_id.as_str()) {
                let plan = build_thread_goal_continuation_plan(&goal);
                return ThreadGoalContinuationOutcome {
                    goal_to_persist: Some(goal),
                    plan: Some(plan),
                    reached_auto_continuation_limit: false,
                    scheduled_auto_continuation: false,
                };
            }
            return ThreadGoalContinuationOutcome {
                goal_to_persist: Some(goal),
                plan: None,
                reached_auto_continuation_limit: false,
                scheduled_auto_continuation: false,
            };
        }

        if !goal.is_active() {
            return ThreadGoalContinuationOutcome {
                goal_to_persist: Some(goal),
                plan: None,
                reached_auto_continuation_limit: false,
                scheduled_auto_continuation: false,
            };
        }

        if goal.auto_continuation_count >= MAX_THREAD_GOAL_AUTO_CONTINUATIONS {
            if goal.status == ThreadGoalStatus::Active {
                goal.status = ThreadGoalStatus::Blocked;
                goal.updated_at = facts.now_epoch_seconds;
                return ThreadGoalContinuationOutcome {
                    goal_to_persist: Some(goal),
                    plan: None,
                    reached_auto_continuation_limit: true,
                    scheduled_auto_continuation: false,
                };
            }
            return ThreadGoalContinuationOutcome::none();
        }

        goal.auto_continuation_count = goal.auto_continuation_count.saturating_add(1);
        goal.updated_at = facts.now_epoch_seconds;
        let plan = build_thread_goal_continuation_plan(&goal);
        ThreadGoalContinuationOutcome {
            goal_to_persist: Some(goal),
            plan: Some(plan),
            reached_auto_continuation_limit: false,
            scheduled_auto_continuation: true,
        }
    }

    fn apply_budget_status(goal: &mut ThreadGoal) -> bool {
        if let Some(budget) = goal.token_budget {
            if goal.tokens_used >= budget && goal.status == ThreadGoalStatus::Active {
                goal.status = ThreadGoalStatus::BudgetLimited;
                return true;
            }
        }
        false
    }

    fn mark_budget_limit_reported(&self, goal_id: &str) -> bool {
        let mut reported = lock_or_recover(&self.budget_limit_reported_goal_id);
        if reported.as_deref() == Some(goal_id) {
            return false;
        }
        *reported = Some(goal_id.to_string());
        true
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ThreadGoalContinuationFacts<'a> {
    pub turn_id: &'a str,
    pub turn_tokens: usize,
    pub turn_completed: bool,
    pub now_epoch_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadGoalContinuationOutcome {
    pub goal_to_persist: Option<ThreadGoal>,
    pub plan: Option<ThreadGoalContinuationPlan>,
    pub reached_auto_continuation_limit: bool,
    pub scheduled_auto_continuation: bool,
}

impl ThreadGoalContinuationOutcome {
    pub fn none() -> Self {
        Self {
            goal_to_persist: None,
            plan: None,
            reached_auto_continuation_limit: false,
            scheduled_auto_continuation: false,
        }
    }
}

impl GoalWallClockAccounting {
    fn time_delta_seconds(&self) -> i64 {
        i64::try_from(self.last_accounted_at.elapsed().as_secs()).unwrap_or(i64::MAX)
    }

    fn mark_accounted(&mut self, accounted_seconds: i64) {
        if accounted_seconds <= 0 {
            return;
        }
        let advance = Duration::from_secs(u64::try_from(accounted_seconds).unwrap_or(u64::MAX));
        self.last_accounted_at = self
            .last_accounted_at
            .checked_add(advance)
            .unwrap_or_else(Instant::now);
    }

    fn mark_active_goal(&mut self, goal_id: String) {
        if self.active_goal_id.as_deref() != Some(goal_id.as_str()) {
            self.last_accounted_at = Instant::now();
            self.active_goal_id = Some(goal_id);
        }
    }

    fn clear_active_goal(&mut self) {
        self.active_goal_id = None;
        self.last_accounted_at = Instant::now();
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Tracks a goal across turn boundaries for hosts whose lifetime is one job.
/// Completion of a dialog turn is not completion of its active goal.
#[derive(Debug, Default)]
pub struct ThreadGoalRunTracker {
    goal: Option<ThreadGoal>,
    waiting: bool,
    budget_wrap_up: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadGoalRunDisposition {
    Continue,
    Complete,
    Stopped(ThreadGoalStatus),
}

impl ThreadGoalRunTracker {
    pub fn new(goal: Option<ThreadGoal>) -> Self {
        Self {
            goal,
            ..Self::default()
        }
    }

    pub fn observe_goal(&mut self, goal: Option<ThreadGoal>) -> Option<ThreadGoalRunDisposition> {
        self.goal = goal;
        if self.waiting && self.goal.as_ref().is_none_or(|goal| !goal.is_active()) {
            Some(self.terminal_disposition())
        } else {
            None
        }
    }

    pub fn accept_continuation(&mut self, metadata: Option<&serde_json::Value>) -> bool {
        let Some(goal) = self.goal.as_ref() else {
            return false;
        };
        if !self.waiting
            || !goal.is_active()
            || !metadata.is_some_and(|metadata| {
                ["threadGoalContinuation", "threadGoalObjectiveUpdated"]
                    .iter()
                    .any(|key| {
                        metadata.get(*key).and_then(serde_json::Value::as_bool) == Some(true)
                    })
                    && metadata.get("goalId").and_then(serde_json::Value::as_str)
                        == Some(goal.goal_id.as_str())
            })
        {
            return false;
        }
        self.waiting = false;
        self.budget_wrap_up = goal.status == ThreadGoalStatus::BudgetLimited;
        true
    }

    pub fn after_successful_turn(&mut self) -> ThreadGoalRunDisposition {
        if self.goal.as_ref().is_some_and(|goal| {
            goal.status == ThreadGoalStatus::Active
                || (goal.status == ThreadGoalStatus::BudgetLimited && !self.budget_wrap_up)
        }) {
            self.waiting = true;
            ThreadGoalRunDisposition::Continue
        } else {
            self.terminal_disposition()
        }
    }

    fn terminal_disposition(&self) -> ThreadGoalRunDisposition {
        match self.goal.as_ref().map(|goal| goal.status) {
            None | Some(ThreadGoalStatus::Complete) => ThreadGoalRunDisposition::Complete,
            Some(status) => ThreadGoalRunDisposition::Stopped(status),
        }
    }
}

/// Fence delayed/queued continuations against goal replacement, editing or stopping.
pub fn goal_continuation_matches(goal: &ThreadGoal, metadata: &serde_json::Value) -> bool {
    goal.is_active()
        && metadata.get("goalId").and_then(serde_json::Value::as_str) == Some(goal.goal_id.as_str())
        && metadata
            .get("objective")
            .and_then(serde_json::Value::as_str)
            == Some(goal.objective.as_str())
        && metadata
            .get("autoContinuationAttempt")
            .and_then(serde_json::Value::as_u64)
            == Some(u64::from(goal.auto_continuation_count))
}
