//! Pure parsing and lifecycle decisions for LoopX tasks.

use super::types::{
    LoopxActionStatus, LoopxCliGoalState, LoopxCoreEnvironmentFacts, LoopxEnvironmentFactStatus,
    LoopxEnvironmentStatus, LoopxEventsPageStatus, LoopxExistingTask, LoopxIntakeCandidate,
    LoopxIntakeTarget, LoopxIssueKey, LoopxItemKind, LoopxOptionalEnvironmentFacts,
    LoopxPermissionScope, LoopxPhase, LoopxRemoteItemState, LoopxRepositoryKey, LoopxTaskSnapshot,
    LoopxTaskState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopxIntakeParseErrorKind {
    Empty,
    UnsupportedHost,
    InvalidRepository,
    UnsupportedPath,
    InvalidItemNumber,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopxIntakeParseError {
    pub kind: LoopxIntakeParseErrorKind,
    pub message: String,
}

impl LoopxIntakeParseError {
    fn new(kind: LoopxIntakeParseErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for LoopxIntakeParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for LoopxIntakeParseError {}

fn valid_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 39
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_repository(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn split_host_and_path(input: &str) -> Result<(String, String), LoopxIntakeParseError> {
    let without_suffix = input
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/');

    if let Some(rest) = without_suffix.strip_prefix("git@") {
        let Some((host, path)) = rest.split_once(':') else {
            return Err(LoopxIntakeParseError::new(
                LoopxIntakeParseErrorKind::InvalidRepository,
                "Invalid GitHub SSH repository URL",
            ));
        };
        return Ok((host.to_ascii_lowercase(), path.to_string()));
    }

    let schemeless = without_suffix
        .strip_prefix("https://")
        .or_else(|| without_suffix.strip_prefix("http://"))
        .unwrap_or(without_suffix);

    if let Some((host, path)) = schemeless.split_once('/') {
        if host.eq_ignore_ascii_case("github.com") || host.eq_ignore_ascii_case("www.github.com") {
            return Ok(("github.com".to_string(), path.to_string()));
        }
        if host.contains('.') || input.contains("://") {
            return Err(LoopxIntakeParseError::new(
                LoopxIntakeParseErrorKind::UnsupportedHost,
                "Only github.com repositories are supported",
            ));
        }
    }

    if !input.contains("://") {
        return Ok(("github.com".to_string(), schemeless.to_string()));
    }

    Err(LoopxIntakeParseError::new(
        LoopxIntakeParseErrorKind::UnsupportedHost,
        "Only github.com repositories are supported",
    ))
}

/// Parse one GitHub repository, issues-list, issue, or pull-request target.
pub fn parse_loopx_intake(input: &str) -> Result<LoopxIntakeTarget, LoopxIntakeParseError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(LoopxIntakeParseError::new(
            LoopxIntakeParseErrorKind::Empty,
            "A GitHub repository, issue, or pull-request URL is required",
        ));
    }
    if input.chars().any(char::is_whitespace) {
        return Err(LoopxIntakeParseError::new(
            LoopxIntakeParseErrorKind::UnsupportedPath,
            "LoopX intake accepts one GitHub target at a time",
        ));
    }

    let (host, path) = split_host_and_path(input)?;
    if host != "github.com" {
        return Err(LoopxIntakeParseError::new(
            LoopxIntakeParseErrorKind::UnsupportedHost,
            "Only github.com repositories are supported",
        ));
    }

    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() < 2 {
        return Err(LoopxIntakeParseError::new(
            LoopxIntakeParseErrorKind::InvalidRepository,
            "GitHub target must include an owner and repository",
        ));
    }

    let owner = segments[0].to_ascii_lowercase();
    let repository = segments[1]
        .strip_suffix(".git")
        .unwrap_or(segments[1])
        .to_ascii_lowercase();
    if !valid_owner(&owner) || !valid_repository(&repository) {
        return Err(LoopxIntakeParseError::new(
            LoopxIntakeParseErrorKind::InvalidRepository,
            "Invalid GitHub owner or repository name",
        ));
    }
    let repository_key = LoopxRepositoryKey {
        host,
        owner,
        repository,
    };

    match segments.as_slice() {
        [_, _] | [_, _, "issues"] | [_, _, "pulls"] => Ok(LoopxIntakeTarget::Repository {
            repository: repository_key,
        }),
        [_, _, collection @ ("issues" | "pull"), number] => {
            let number = number.parse::<u64>().map_err(|_| {
                LoopxIntakeParseError::new(
                    LoopxIntakeParseErrorKind::InvalidItemNumber,
                    "GitHub issue or pull-request number is invalid",
                )
            })?;
            if number == 0 {
                return Err(LoopxIntakeParseError::new(
                    LoopxIntakeParseErrorKind::InvalidItemNumber,
                    "GitHub issue or pull-request number must be positive",
                ));
            }
            let kind = if *collection == "issues" {
                LoopxItemKind::Issue
            } else {
                LoopxItemKind::PullRequest
            };
            Ok(LoopxIntakeTarget::Item {
                item: LoopxIssueKey {
                    repository: repository_key,
                    kind,
                    number,
                },
            })
        }
        _ => Err(LoopxIntakeParseError::new(
            LoopxIntakeParseErrorKind::UnsupportedPath,
            "Paste a repository, issues-list, issue, or pull-request URL",
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum LoopxTransitionDecision {
    NoChange,
    Allowed { next: LoopxTaskState },
    Rejected,
}

pub fn decide_task_transition(
    current: LoopxTaskState,
    next: LoopxTaskState,
) -> LoopxTransitionDecision {
    if current == next {
        return LoopxTransitionDecision::NoChange;
    }

    let allowed = match current {
        LoopxTaskState::Preparing => matches!(
            next,
            LoopxTaskState::Queued
                | LoopxTaskState::Cancelling
                | LoopxTaskState::RecoveryRequired
                | LoopxTaskState::Failed
        ),
        LoopxTaskState::Queued => matches!(
            next,
            LoopxTaskState::Running
                | LoopxTaskState::Cancelling
                | LoopxTaskState::RecoveryRequired
                | LoopxTaskState::Failed
        ),
        LoopxTaskState::Running => matches!(
            next,
            LoopxTaskState::Queued
                | LoopxTaskState::WaitingForUser
                | LoopxTaskState::Cancelling
                | LoopxTaskState::RecoveryRequired
                | LoopxTaskState::Completed
                | LoopxTaskState::Failed
        ),
        LoopxTaskState::WaitingForUser => matches!(
            next,
            LoopxTaskState::Queued
                | LoopxTaskState::Cancelling
                | LoopxTaskState::RecoveryRequired
                | LoopxTaskState::Failed
        ),
        LoopxTaskState::Cancelling => matches!(
            next,
            LoopxTaskState::Stopped
                | LoopxTaskState::Aborted
                | LoopxTaskState::RecoveryRequired
                | LoopxTaskState::Failed
        ),
        LoopxTaskState::Stopped | LoopxTaskState::Failed => {
            matches!(next, LoopxTaskState::Queued | LoopxTaskState::Archived)
        }
        LoopxTaskState::Aborted => matches!(next, LoopxTaskState::Archived),
        // Legacy persisted state only: no live path re-enters RetryWait, so
        // every transition from it is rejected until restart recovery requeues
        // the task.
        LoopxTaskState::RetryWait => false,
        LoopxTaskState::RecoveryRequired => matches!(
            next,
            LoopxTaskState::Queued | LoopxTaskState::Stopped | LoopxTaskState::Failed
        ),
        LoopxTaskState::Completed => matches!(next, LoopxTaskState::Archived),
        LoopxTaskState::Archived => matches!(next, LoopxTaskState::RecoveryRequired),
    };

    if allowed {
        LoopxTransitionDecision::Allowed { next }
    } else {
        LoopxTransitionDecision::Rejected
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum LoopxRestartDecision {
    Preserve { state: LoopxTaskState },
    RequireRecovery,
}

pub fn decide_task_restart(state: LoopxTaskState) -> LoopxRestartDecision {
    match state {
        LoopxTaskState::Preparing | LoopxTaskState::RetryWait => LoopxRestartDecision::Preserve {
            state: LoopxTaskState::Queued,
        },
        state if state.was_executing_at_shutdown() => LoopxRestartDecision::RequireRecovery,
        state => LoopxRestartDecision::Preserve { state },
    }
}

pub fn task_state_after_restart(state: LoopxTaskState) -> LoopxTaskState {
    match decide_task_restart(state) {
        LoopxRestartDecision::RequireRecovery => LoopxTaskState::RecoveryRequired,
        LoopxRestartDecision::Preserve { state } => state,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopxGoalProjection {
    pub state: LoopxTaskState,
    pub phase: LoopxPhase,
}

/// Reconcile BitFun's local host-job projection with the authoritative LoopX
/// Goal lifecycle. Explicit local operator states and in-flight host work are
/// preserved; terminal or user-gate facts from LoopX replace stale projections.
pub fn project_host_task_from_goal(
    current_state: LoopxTaskState,
    current_phase: LoopxPhase,
    goal_state: LoopxCliGoalState,
) -> LoopxGoalProjection {
    if matches!(
        current_state,
        LoopxTaskState::Stopped
            | LoopxTaskState::Aborted
            | LoopxTaskState::Archived
            | LoopxTaskState::Running
            | LoopxTaskState::Cancelling
    ) {
        return LoopxGoalProjection {
            state: current_state,
            phase: current_phase,
        };
    }

    match goal_state {
        LoopxCliGoalState::Completed => LoopxGoalProjection {
            state: LoopxTaskState::Completed,
            phase: LoopxPhase::Finished,
        },
        LoopxCliGoalState::Failed => LoopxGoalProjection {
            state: LoopxTaskState::Failed,
            phase: LoopxPhase::Finished,
        },
        LoopxCliGoalState::Archived => LoopxGoalProjection {
            state: LoopxTaskState::Archived,
            phase: LoopxPhase::Finished,
        },
        LoopxCliGoalState::WaitingForUser => LoopxGoalProjection {
            state: LoopxTaskState::WaitingForUser,
            phase: LoopxPhase::WaitingForApproval,
        },
        LoopxCliGoalState::Active
            if matches!(
                current_state,
                LoopxTaskState::Completed | LoopxTaskState::Failed
            ) =>
        {
            LoopxGoalProjection {
                state: LoopxTaskState::RecoveryRequired,
                phase: LoopxPhase::Recovering,
            }
        }
        LoopxCliGoalState::Unknown | LoopxCliGoalState::Active => LoopxGoalProjection {
            state: current_state,
            phase: current_phase,
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum LoopxDedupDecision {
    CreateAttempt {
        attempt: u32,
    },
    OpenExisting {
        task_id: String,
    },
    RequireExplicitRetry {
        previous_task_id: String,
        next_attempt: u32,
    },
    ClosedNoop,
    NeedsLiveVerification,
}

pub fn decide_task_dedup(
    key: &LoopxIssueKey,
    remote_state: LoopxRemoteItemState,
    existing: &[LoopxExistingTask],
    retry_terminal: bool,
) -> LoopxDedupDecision {
    let mut matching = existing
        .iter()
        .filter(|task| &task.identity.item == key)
        .collect::<Vec<_>>();
    matching.sort_by_key(|task| task.identity.attempt);

    if let Some(active) = matching.iter().rev().find(|task| !task.state.is_terminal()) {
        return LoopxDedupDecision::OpenExisting {
            task_id: active.task_id.clone(),
        };
    }

    if remote_state.is_resolved() {
        return LoopxDedupDecision::ClosedNoop;
    }
    if remote_state == LoopxRemoteItemState::Unknown {
        return LoopxDedupDecision::NeedsLiveVerification;
    }

    let Some(previous) = matching.last() else {
        return LoopxDedupDecision::CreateAttempt { attempt: 1 };
    };
    let next_attempt = previous.identity.attempt.saturating_add(1).max(1);
    if retry_terminal {
        LoopxDedupDecision::CreateAttempt {
            attempt: next_attempt,
        }
    } else {
        LoopxDedupDecision::RequireExplicitRetry {
            previous_task_id: previous.task_id.clone(),
            next_attempt,
        }
    }
}

pub const LOOPX_REQUIRED_PERMISSION_SCOPES: [LoopxPermissionScope; 5] = [
    LoopxPermissionScope::WorkspaceRead,
    LoopxPermissionScope::WorkspaceWrite,
    LoopxPermissionScope::GitLocal,
    LoopxPermissionScope::GithubRead,
    LoopxPermissionScope::AgentExecution,
];

pub fn intake_scope_is_pregrantable(scope: LoopxPermissionScope) -> bool {
    LOOPX_REQUIRED_PERMISSION_SCOPES.contains(&scope)
}

pub fn required_permission_scopes_are_granted(granted: &[LoopxPermissionScope]) -> bool {
    LOOPX_REQUIRED_PERMISSION_SCOPES
        .iter()
        .all(|scope| granted.contains(scope))
}

/// The agent concluded the reported failure was already fixed upstream, so the
/// issue needs no follow-up work. Such tasks are excluded from the repository
/// recovery candidates: resuming them would only re-run a no-op investigation.
/// Mirrors the bitfun-loopx MiniApp UI heuristic (`isResolvedUpstream`); keep
/// the two in sync.
pub fn task_summary_resolves_upstream(summary: Option<&str>) -> bool {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let Some(summary) = summary else {
        return false;
    };
    let summary = summary.trim();
    if summary.is_empty() {
        return false;
    }
    PATTERNS
        .get_or_init(|| {
            [
                r"(?is)covered[-_ ]?upstream.{0,80}no[-_ ]?follow[-_ ]?up",
                r"(?is)原始故障路径.{0,40}(?:消失|移除).{0,120}(?:不开\s*PR|无需.{0,20}修复)",
            ]
            .into_iter()
            .map(|pattern| regex::Regex::new(pattern).expect("static resolved-upstream pattern"))
            .collect()
        })
        .iter()
        .any(|pattern| pattern.is_match(summary))
}

/// Classifies a LoopX action kind as monitor-class: the todo waits for an
/// external event the agent cannot advance itself (PR merge readiness, PR
/// state watches, continuous monitoring). Covers `continuous_monitor`, the
/// `*_monitor` family, and the `issue_fix_track_*` merge-readiness trackers.
/// The MiniApp UI projects the "PR monitor waiting" state with this rule
/// (`isMonitorTodo` in the bitfun-loopx UI); keep the two in sync. The
/// controller itself does NOT pace monitor re-checks with it: the pinned
/// v1.0.x runtime owns the monitor cadence (`monitor_due` only when
/// `next_due_at` has passed, unchanged writebacks must advance the
/// schedule), so the host follows the LoopX projection as-is.
pub fn is_loopx_monitor_action(action_kind: &str) -> bool {
    let kind = action_kind.trim();
    !kind.is_empty() && (kind.ends_with("_monitor") || kind.starts_with("issue_fix_track_"))
}

/// Repository resume candidates: resumable states on the same repository that
/// the agent has not already concluded are resolved upstream. The MiniApp
/// repository resume dialog counts with the same rule, so the confirmed count
/// always matches the tasks the controller actually queues.
pub fn decide_repository_recovery_candidate(task: &LoopxTaskSnapshot, repository_id: &str) -> bool {
    task.identity.item.repository.canonical_id() == repository_id
        && matches!(
            task.state,
            LoopxTaskState::Stopped | LoopxTaskState::Failed | LoopxTaskState::RecoveryRequired
        )
        && !task_summary_resolves_upstream(task.last_agent_summary.as_deref())
}

const SUMMARY_SCHEMA_MARKER: &str = "loopx_summary_v1";
const SUMMARY_VERDICTS: [&str; 4] = [
    "needs_fix",
    "already_fixed_upstream",
    "wont_fix",
    "needs_info",
];
const SUMMARY_REPRODUCTIONS: [&str; 3] = ["reproduced", "not_reproduced", "not_applicable"];
const SUMMARY_SEGMENT_KINDS: [&str; 5] = [
    "evidence",
    "route_decision",
    "implementation",
    "validation",
    "delivery",
];

/// Extract and validate the `loopx_summary_v1` fenced JSON block from an agent
/// summary. Returns None when the block is absent or violates the schema
/// (unknown enum value, or a verdict missing its conditional evidence); the
/// caller then falls back to rendering the raw text. Approval and gate state
/// are intentionally not part of the schema — the host-projected gate card is
/// the single expression and operation surface for them.
pub fn parse_structured_summary(summary: Option<&str>) -> Option<serde_json::Value> {
    let summary = summary?;
    let marker = format!("```{SUMMARY_SCHEMA_MARKER}");
    let start = summary.find(&marker)?;
    let body_start = summary[start..].find('\n')? + start + 1;
    let body_end = summary[body_start..].find("```")? + body_start;
    let body = summary[body_start..body_end].trim();
    let mut value: serde_json::Value = serde_json::from_str(body).ok()?;
    let object = value.as_object()?;

    let verdict = object.get("issue_verdict")?.as_str()?;
    if !SUMMARY_VERDICTS.contains(&verdict) {
        return None;
    }
    // Conditional evidence: a verdict that claims facts must carry them, or the
    // block is malformed (single-source-of-truth: the verdict is the only
    // place upstream fix state can be expressed).
    match verdict {
        "already_fixed_upstream" => {
            let fixed_by = object
                .get("fixed_by")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if fixed_by.trim().is_empty() {
                return None;
            }
        }
        "wont_fix" => {
            let reason = object
                .get("wont_fix_reason")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if reason.trim().is_empty() {
                return None;
            }
        }
        "needs_info" => {
            let missing = object.get("missing_info").and_then(|v| v.as_array())?;
            if missing.is_empty() {
                return None;
            }
        }
        _ => {}
    }

    if let Some(reproduction) = object.get("reproduction").and_then(|v| v.as_str()) {
        if !SUMMARY_REPRODUCTIONS.contains(&reproduction) {
            return None;
        }
        if reproduction == "reproduced" {
            let evidence = object
                .get("reproduction_evidence")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if evidence.trim().is_empty() {
                return None;
            }
        }
    }
    if let Some(kind) = object.get("segment_kind").and_then(|v| v.as_str()) {
        if !SUMMARY_SEGMENT_KINDS.contains(&kind) {
            return None;
        }
    }
    inject_summary_artifact_roles(&mut value);
    Some(value)
}

const SUMMARY_ARTIFACT_KIND_PULL_REQUEST: &str = "pull_request";
const SUMMARY_ARTIFACT_KIND_ISSUE_COMMENT: &str = "issue_comment";
const SUMMARY_ARTIFACT_KIND_OTHER: &str = "other";
const SUMMARY_ARTIFACT_ROLE_PRODUCED: &str = "produced";
const SUMMARY_ARTIFACT_ROLE_REFERENCED: &str = "referenced";

const SUMMARY_PR_CREATION_MARKERS: &[&str] = &[
    "已创建",
    "创建了",
    "已提交",
    "提交了",
    "已打开",
    "打开了",
    "已发布",
    "发布了",
    "已推送",
    "推送了",
    "created",
    "opened",
    "submitted",
    "published",
    "pushed",
    "filed",
    "raised",
    "新建",
];

const SUMMARY_PR_CREATION_NEGATIVE_MARKERS: &[&str] = &[
    "停止",
    "不再",
    "未创建",
    "没有创建",
    "未提交",
    "没有提交",
    "未打开",
    "没有打开",
    "没打开",
    "未推送",
    "没有推送",
    "没推送",
    "未发布",
    "没有发布",
    "没发布",
    "不开",
    "不会开",
    "reuse",
    "merge",
    "skip",
    "no_followup",
    "no-follow-up",
    "wont_fix",
    "already_fixed",
];

/// Adds the host's explicit artifact-role projection to a parsed
/// `loopx_summary_v1` block. The agent-authored `artifacts` list mixes produced
/// outputs (for example a newly opened PR) with evidence references (for
/// example historical closed PRs), so the UI must not infer publication from
/// the mere presence of a URL. `produced_artifacts` and `referenced_artifacts`
/// are the host-owned classification; `artifact_events` keeps the same
/// information in a typed, forward-compatible shape.
fn inject_summary_artifact_roles(value: &mut serde_json::Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let raw_artifacts = object
        .get("artifacts")
        .and_then(|artifacts| artifacts.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let production_text = summary_production_text(object);
    let creation_is_negative = summary_pr_creation_is_negative(&production_text);
    let delivery_route_is_positive = summary_delivery_route_is_positive(object, &production_text);
    let mut artifact_events = Vec::new();
    let mut produced = Vec::new();
    let mut referenced = Vec::new();
    let mut seen = Vec::<String>::new();

    for artifact in raw_artifacts {
        if seen.iter().any(|value| value == &artifact) {
            continue;
        }
        seen.push(artifact.clone());
        let (kind, number) = classify_summary_artifact(&artifact);
        let role = if kind == SUMMARY_ARTIFACT_KIND_PULL_REQUEST {
            match number.as_deref() {
                Some(number)
                    if !creation_is_negative
                        && (delivery_route_is_positive
                            || summary_has_pr_creation_evidence(&production_text, number)) =>
                {
                    SUMMARY_ARTIFACT_ROLE_PRODUCED
                }
                _ => SUMMARY_ARTIFACT_ROLE_REFERENCED,
            }
        } else if kind == SUMMARY_ARTIFACT_KIND_ISSUE_COMMENT {
            if !creation_is_negative && summary_has_comment_publication_evidence(&production_text) {
                SUMMARY_ARTIFACT_ROLE_PRODUCED
            } else {
                SUMMARY_ARTIFACT_ROLE_REFERENCED
            }
        } else {
            SUMMARY_ARTIFACT_ROLE_REFERENCED
        };
        if role == SUMMARY_ARTIFACT_ROLE_PRODUCED {
            produced.push(artifact.clone());
        } else {
            referenced.push(artifact.clone());
        }
        artifact_events.push(serde_json::json!({
            "role": role,
            "kind": kind,
            "url": artifact,
            "number": number,
        }));
    }

    for inline in summary_inline_pull_request_urls(&production_text) {
        if seen.iter().any(|value| value == &inline) {
            continue;
        }
        let Some(number) = github_pull_number(&inline) else {
            continue;
        };
        if creation_is_negative || !summary_has_pr_creation_evidence(&production_text, &number) {
            continue;
        }
        seen.push(inline.clone());
        produced.push(inline.clone());
        artifact_events.push(serde_json::json!({
            "role": SUMMARY_ARTIFACT_ROLE_PRODUCED,
            "kind": SUMMARY_ARTIFACT_KIND_PULL_REQUEST,
            "url": inline,
            "number": number,
        }));
    }

    object.insert(
        "artifact_events".to_string(),
        serde_json::Value::Array(artifact_events),
    );
    object.insert(
        "produced_artifacts".to_string(),
        serde_json::Value::Array(
            produced
                .into_iter()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    object.insert(
        "referenced_artifacts".to_string(),
        serde_json::Value::Array(
            referenced
                .into_iter()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
}

fn summary_production_text(object: &serde_json::Map<String, serde_json::Value>) -> String {
    let mut parts = Vec::<String>::new();
    for key in ["segment_kind", "actual_findings", "next_step"] {
        if let Some(value) = object.get(key).and_then(|value| value.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                parts.push(value.to_string());
            }
        }
    }
    if let Some(decision) = object.get("decision").and_then(|value| value.as_object()) {
        for key in ["route", "reason"] {
            if let Some(value) = decision.get(key).and_then(|value| value.as_str()) {
                let value = value.trim();
                if !value.is_empty() {
                    parts.push(value.to_string());
                }
            }
        }
    }
    if let Some(completed) = object.get("completed").and_then(|value| value.as_array()) {
        for value in completed.iter().filter_map(|value| value.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                parts.push(value.to_string());
            }
        }
    }
    parts.join("\n")
}

fn summary_text_contains_marker(text: &str, markers: &[&str]) -> bool {
    let lower = text.to_lowercase();
    markers
        .iter()
        .any(|marker| lower.contains(&marker.to_lowercase()))
}

fn summary_pr_creation_is_negative(text: &str) -> bool {
    summary_text_contains_marker(text, SUMMARY_PR_CREATION_NEGATIVE_MARKERS)
}

fn summary_delivery_route_is_positive(
    object: &serde_json::Map<String, serde_json::Value>,
    production_text: &str,
) -> bool {
    let segment_kind = object
        .get("segment_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    segment_kind == "delivery"
        && !summary_pr_creation_is_negative(production_text)
        && summary_text_contains_marker(production_text, SUMMARY_PR_CREATION_MARKERS)
}

fn classify_summary_artifact(artifact: &str) -> (&'static str, Option<String>) {
    if let Some(number) = github_pull_number(artifact) {
        return (SUMMARY_ARTIFACT_KIND_PULL_REQUEST, Some(number));
    }
    if artifact.contains("github.com/")
        && artifact.contains("/issues/")
        && artifact.contains("#issuecomment-")
    {
        return (SUMMARY_ARTIFACT_KIND_ISSUE_COMMENT, None);
    }
    (SUMMARY_ARTIFACT_KIND_OTHER, None)
}

fn github_pull_number(url: &str) -> Option<String> {
    let marker = "/pull/";
    let start = url.find(marker)? + marker.len();
    let number = url[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    (!number.is_empty()).then_some(number)
}

fn summary_has_pr_creation_evidence(text: &str, number: &str) -> bool {
    let markers = SUMMARY_PR_CREATION_MARKERS.join("|");
    let number = regex::escape(number);
    let pattern = format!(
        r"(?is)(?:{markers})[^\n]{{0,80}}(?:pull\s*request|拉取请求|\bpr\b)[^\n]{{0,20}}#?{number}\b|(?is)(?:pull\s*request|拉取请求|\bpr\b)[^\n]{{0,20}}#?{number}\b[^\n]{{0,80}}(?:{markers})"
    );
    regex::Regex::new(&pattern)
        .map(|pattern| pattern.is_match(text))
        .unwrap_or(false)
}

fn summary_has_comment_publication_evidence(text: &str) -> bool {
    let pattern =
        r"(?is)(?:已发布|发表了|已发表|发布了|published|posted)[^\n]{0,80}(?:评论|comment)";
    regex::Regex::new(pattern)
        .map(|pattern| pattern.is_match(text))
        .unwrap_or(false)
}

fn summary_inline_pull_request_urls(text: &str) -> Vec<String> {
    let Ok(pattern) = regex::Regex::new(r"https?://github\.com/[^\s/]+/[^\s/]+/pull/\d+") else {
        return Vec::new();
    };
    pattern
        .find_iter(text)
        .map(|matched| matched.as_str().to_string())
        .collect()
}

pub fn derive_environment_status(
    core: &LoopxCoreEnvironmentFacts,
    optional: &LoopxOptionalEnvironmentFacts,
) -> LoopxEnvironmentStatus {
    let core_statuses = [
        core.sidecar.status,
        // v1.0.x pinned control plane hard-fails bootstrap without Node, so
        // the Node fact gates the environment exactly like the sidecar itself.
        // Legacy persisted snapshots predate the field (Unknown); the next
        // validation pass replaces it with a probed fact.
        core.node_runtime.status,
        core.git_worktree.status,
        core.agent_model.status,
    ];
    if core_statuses.contains(&LoopxEnvironmentFactStatus::Checking) {
        return LoopxEnvironmentStatus::Checking;
    }
    if core_statuses.contains(&LoopxEnvironmentFactStatus::Unavailable) {
        return LoopxEnvironmentStatus::Blocked;
    }
    if core_statuses.contains(&LoopxEnvironmentFactStatus::Unknown) {
        return LoopxEnvironmentStatus::Unknown;
    }
    if core_statuses.contains(&LoopxEnvironmentFactStatus::Degraded) {
        return LoopxEnvironmentStatus::Degraded;
    }

    let optional_statuses = [optional.python_fallback.status, optional.github_auth.status];
    if optional_statuses.iter().any(|status| {
        matches!(
            status,
            LoopxEnvironmentFactStatus::Degraded | LoopxEnvironmentFactStatus::Unavailable
        )
    }) {
        LoopxEnvironmentStatus::Degraded
    } else {
        LoopxEnvironmentStatus::Ready
    }
}

pub fn decide_action_status(
    client_request_already_applied: bool,
    expected_revision: u64,
    current_revision: u64,
) -> LoopxActionStatus {
    if client_request_already_applied {
        LoopxActionStatus::Duplicate
    } else if expected_revision != current_revision {
        LoopxActionStatus::RevisionConflict
    } else {
        LoopxActionStatus::Applied
    }
}

pub fn decide_events_page_status(
    current_stream_id: &str,
    requested_stream_id: &str,
    after_cursor: u64,
    oldest_retained_cursor: Option<u64>,
    latest_cursor: u64,
) -> LoopxEventsPageStatus {
    if current_stream_id != requested_stream_id || after_cursor > latest_cursor {
        return LoopxEventsPageStatus::SnapshotRequired;
    }
    if let Some(oldest) = oldest_retained_cursor {
        if after_cursor.saturating_add(1) < oldest {
            return LoopxEventsPageStatus::SnapshotRequired;
        }
    }
    LoopxEventsPageStatus::Current
}

pub fn build_intake_fingerprint(
    target: &LoopxIntakeTarget,
    candidates: &[LoopxIntakeCandidate],
    workspace_path: Option<&str>,
    model_id: &str,
    permission_scopes: &[LoopxPermissionScope],
) -> String {
    let mut item_facts = candidates
        .iter()
        .map(|candidate| {
            format!(
                "{}:{:?}:{}:{}",
                candidate.key.canonical_id(),
                candidate.state,
                candidate.has_images,
                candidate.from_repository
            )
        })
        .collect::<Vec<_>>();
    item_facts.sort();
    let mut scopes = permission_scopes.to_vec();
    scopes.sort();
    scopes.dedup();
    let target_id = match target {
        LoopxIntakeTarget::Repository { repository } => repository.canonical_id(),
        LoopxIntakeTarget::Item { item } => item.canonical_id(),
    };
    let payload = format!(
        "target={target_id}\nitems={}\nworkspace={}\nmodel={model_id}\nscopes={scopes:?}",
        item_facts.join("|"),
        workspace_path.unwrap_or_default(),
    );
    format!("sha256:{}", hex::encode(Sha256::digest(payload.as_bytes())))
}
