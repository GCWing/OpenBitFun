use serde::{Deserialize, Serialize};

pub const SESSION_USAGE_REPORT_SCHEMA_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageToolCategory {
    Git,
    Shell,
    File,
    Other,
}

// PartialEq only (not Eq) because nested UsageTokenBreakdown/UsageModelBreakdown
// hold `cache_hit_rate: Option<f64>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageReport {
    pub schema_version: u16,
    pub report_id: String,
    pub session_id: String,
    pub generated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_from_app_version: Option<String>,
    pub workspace: UsageWorkspace,
    pub scope: UsageScope,
    pub coverage: UsageCoverage,
    pub time: UsageTimeBreakdown,
    pub tokens: UsageTokenBreakdown,
    /// Estimated composition of the latest recorded model request, not cumulative usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<UsageContextBreakdown>,
    /// Latest cached system message, returned only for an explicit preview request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_preview: Option<UsageSystemPromptPreview>,
    /// One explicitly requested category from the latest host-owned request snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_preview: Option<UsageContextPreview>,
    #[serde(default)]
    pub models: Vec<UsageModelBreakdown>,
    #[serde(default)]
    pub tools: Vec<UsageToolBreakdown>,
    pub files: UsageFileBreakdown,
    pub compression: UsageCompressionBreakdown,
    pub errors: UsageErrorBreakdown,
    #[serde(default)]
    pub slowest: Vec<UsageSlowSpan>,
    pub privacy: UsagePrivacy,
}

/// The current session cache, not a historical request snapshot or reconstructed template.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSystemPromptPreview {
    pub content: String,
    pub cached_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum UsageContextCategory {
    SystemPrompt,
    ToolDefinitions,
    Rules,
    Skills,
    McpTools,
    SubagentDefinitions,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageContextPreview {
    pub category: UsageContextCategory,
    pub content: String,
    pub captured_at: u64,
}

/// Numeric-only prompt estimates captured by the executing runtime.
/// Missing snapshots (including legacy hosts) stay absent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageContextBreakdown {
    pub system_prompt: u64,
    pub tool_definitions: u64,
    pub rules: u64,
    pub skills: u64,
    pub mcp_tools: u64,
    pub subagent_definitions: u64,
    pub summarized_conversation: u64,
    pub conversation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWorkspace {
    pub kind: UsageWorkspaceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageWorkspaceKind {
    Local,
    RemoteSsh,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageScope {
    pub kind: UsageScopeKind,
    pub turn_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_turn_id: Option<String>,
    pub includes_subagents: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageScopeKind {
    EntireSession,
    TurnRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageCoverage {
    pub level: UsageCoverageLevel,
    #[serde(default)]
    pub available: Vec<UsageCoverageKey>,
    #[serde(default)]
    pub missing: Vec<UsageCoverageKey>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageCoverageLevel {
    Complete,
    Partial,
    Minimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum UsageCoverageKey {
    ModelRoundTiming,
    ToolPhaseTiming,
    CachedTokens,
    TokenDetailBreakdown,
    SubagentScope,
    RemoteSnapshotStats,
    FileLineStats,
    WorkspaceIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTimeBreakdown {
    pub accounting: UsageTimeAccounting,
    pub denominator: UsageTimeDenominator,
    /// First recorded turn start to last recorded turn end; may include idle gaps.
    pub wall_time_ms: Option<u64>,
    /// Sum of persisted turn durations; may include orchestration/waiting inside a turn.
    pub active_turn_ms: Option<u64>,
    /// Sum of persisted model-round spans, not provider streaming throughput.
    pub model_ms: Option<u64>,
    pub tool_ms: Option<u64>,
    pub idle_gap_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageTimeAccounting {
    Approximate,
    Exact,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageTimeDenominator {
    SessionWallTime,
    ActiveTurnTime,
    Unavailable,
}

// PartialEq only (not Eq) because `cache_hit_rate: Option<f64>` precludes
// total equality. Existing call sites compare with `==`, which works on f64
// via PartialEq (NaN-aware).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokenBreakdown {
    pub source: UsageTokenSource,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub cache_coverage: UsageCacheCoverage,
    /// `cached_tokens / input_tokens` over records that explicitly report
    /// cached tokens. `None` when no record has cached coverage. Range: 0.0–1.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageTokenSource {
    TokenUsageRecords,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageCacheCoverage {
    Available,
    Partial,
    Unavailable,
}

// PartialEq only (not Eq) — see comment on UsageTokenBreakdown.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelBreakdown {
    pub model_id: String,
    pub call_count: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    /// Per-model hit rate. Same semantic as [`UsageTokenBreakdown::cache_hit_rate`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_rate: Option<f64>,
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_turn_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageToolBreakdown {
    pub tool_name: String,
    pub category: UsageToolCategory,
    pub call_count: u64,
    pub success_count: u64,
    pub error_count: u64,
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p95_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preflight_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_turn_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_item_id: Option<String>,
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageFileBreakdown {
    pub scope: UsageFileScope,
    pub changed_files: Option<u64>,
    pub added_lines: Option<u64>,
    pub deleted_lines: Option<u64>,
    #[serde(default)]
    pub files: Vec<UsageFileRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageFileScope {
    SnapshotSummary,
    ToolInputsOnly,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageFileRow {
    pub path_label: String,
    pub operation_count: u64,
    pub added_lines: Option<u64>,
    pub deleted_lines: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub turn_indexes: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_ids: Vec<String>,
    pub redacted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshotFacts {
    pub source_available: bool,
    #[serde(default)]
    pub operations: Vec<UsageSnapshotOperationSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshotOperationSummary {
    pub operation_id: String,
    pub session_id: String,
    pub turn_index: usize,
    pub file_path: String,
    pub lines_added: u64,
    pub lines_removed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageCompressionBreakdown {
    pub compaction_count: u64,
    pub manual_compaction_count: u64,
    pub automatic_compaction_count: u64,
    pub saved_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageErrorBreakdown {
    pub total_errors: u64,
    pub tool_errors: u64,
    pub model_errors: u64,
    #[serde(default)]
    pub examples: Vec<UsageErrorExample>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageErrorExample {
    pub label: String,
    pub count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_turn_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_item_id: Option<String>,
    pub redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSlowSpan {
    pub label: String,
    pub kind: UsageSlowSpanKind,
    pub duration_ms: u64,
    pub redacted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preflight_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageSlowSpanKind {
    Model,
    Tool,
    Turn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsagePrivacy {
    pub prompt_content_included: bool,
    pub tool_inputs_included: bool,
    pub command_outputs_included: bool,
    pub file_contents_included: bool,
    #[serde(default)]
    pub redacted_fields: Vec<String>,
}

impl SessionUsageReport {
    pub fn partial_unavailable(session_id: impl Into<String>, generated_at: i64) -> Self {
        Self {
            schema_version: SESSION_USAGE_REPORT_SCHEMA_VERSION,
            report_id: format!("usage-{}", generated_at),
            session_id: session_id.into(),
            generated_at,
            generated_from_app_version: None,
            workspace: UsageWorkspace {
                kind: UsageWorkspaceKind::Unknown,
                path_label: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
            },
            scope: UsageScope {
                kind: UsageScopeKind::EntireSession,
                turn_count: 0,
                from_turn_id: None,
                to_turn_id: None,
                includes_subagents: false,
            },
            coverage: UsageCoverage {
                level: UsageCoverageLevel::Partial,
                available: vec![],
                missing: vec![
                    UsageCoverageKey::CachedTokens,
                    UsageCoverageKey::TokenDetailBreakdown,
                ],
                notes: vec![
                    "Report uses available persisted session facts and lists unavailable metrics explicitly."
                        .to_string(),
                ],
            },
            time: UsageTimeBreakdown {
                accounting: UsageTimeAccounting::Unavailable,
                denominator: UsageTimeDenominator::Unavailable,
                wall_time_ms: None,
                active_turn_ms: None,
                model_ms: None,
                tool_ms: None,
                idle_gap_ms: None,
            },
            tokens: UsageTokenBreakdown {
                source: UsageTokenSource::Unavailable,
                input_tokens: None,
                output_tokens: None,
                total_tokens: None,
                cached_tokens: None,
                cache_coverage: UsageCacheCoverage::Unavailable,
                cache_hit_rate: None,
            },
            context: None,
            system_prompt_preview: None,
            context_preview: None,
            models: vec![],
            tools: vec![],
            files: UsageFileBreakdown {
                scope: UsageFileScope::Unavailable,
                changed_files: None,
                added_lines: None,
                deleted_lines: None,
                files: vec![],
            },
            compression: UsageCompressionBreakdown {
                compaction_count: 0,
                manual_compaction_count: 0,
                automatic_compaction_count: 0,
                saved_tokens: None,
            },
            errors: UsageErrorBreakdown {
                total_errors: 0,
                tool_errors: 0,
                model_errors: 0,
                examples: vec![],
            },
            slowest: vec![],
            privacy: UsagePrivacy {
                prompt_content_included: false,
                tool_inputs_included: false,
                command_outputs_included: false,
                file_contents_included: false,
                redacted_fields: vec![],
            },
        }
    }
}

#[cfg(test)]
pub(crate) fn test_report() -> SessionUsageReport {
    let mut report = SessionUsageReport::partial_unavailable("session-1", 1_778_347_200_000);
    report.report_id = "usage-session-1-1778347200000".to_string();
    report.workspace = UsageWorkspace {
        kind: UsageWorkspaceKind::Local,
        path_label: Some("D:/workspace/openbitfun".to_string()),
        workspace_id: Some("workspace-1".to_string()),
        remote_connection_id: None,
        remote_ssh_host: None,
    };
    report.scope = UsageScope {
        kind: UsageScopeKind::EntireSession,
        turn_count: 3,
        from_turn_id: Some("turn-1".to_string()),
        to_turn_id: Some("turn-3".to_string()),
        includes_subagents: true,
    };
    report.coverage.available = vec![UsageCoverageKey::WorkspaceIdentity];
    report.coverage.missing = vec![
        UsageCoverageKey::CachedTokens,
        UsageCoverageKey::TokenDetailBreakdown,
    ];
    report.time = UsageTimeBreakdown {
        accounting: UsageTimeAccounting::Approximate,
        denominator: UsageTimeDenominator::SessionWallTime,
        wall_time_ms: Some(62_000),
        active_turn_ms: Some(51_000),
        model_ms: None,
        tool_ms: Some(12_000),
        idle_gap_ms: Some(11_000),
    };
    report.tokens = UsageTokenBreakdown {
        source: UsageTokenSource::TokenUsageRecords,
        input_tokens: Some(1200),
        output_tokens: Some(340),
        total_tokens: Some(1540),
        cached_tokens: None,
        cache_coverage: UsageCacheCoverage::Unavailable,
        cache_hit_rate: None,
    };
    report.models = vec![UsageModelBreakdown {
        model_id: "test-model".to_string(),
        call_count: 2,
        input_tokens: Some(1200),
        output_tokens: Some(340),
        total_tokens: Some(1540),
        cached_tokens: None,
        cache_hit_rate: None,
        duration_ms: None,
        sample_turn_id: Some("turn-1".to_string()),
        sample_turn_index: Some(0),
    }];
    report.tools = vec![UsageToolBreakdown {
        tool_name: "read_file".to_string(),
        category: UsageToolCategory::File,
        call_count: 1,
        success_count: 1,
        error_count: 0,
        duration_ms: Some(1200),
        p95_duration_ms: None,
        queue_wait_ms: None,
        preflight_ms: None,
        confirmation_wait_ms: None,
        execution_ms: None,
        sample_turn_id: Some("turn-1".to_string()),
        sample_turn_index: Some(0),
        sample_item_id: Some("tool-1".to_string()),
        redacted: false,
    }];
    report.files = UsageFileBreakdown {
        scope: UsageFileScope::ToolInputsOnly,
        changed_files: Some(1),
        added_lines: None,
        deleted_lines: None,
        files: vec![UsageFileRow {
            path_label: "src/main.rs".to_string(),
            operation_count: 1,
            added_lines: None,
            deleted_lines: None,
            session_id: None,
            turn_indexes: vec![],
            operation_ids: vec![],
            redacted: false,
        }],
    };
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_usage_report_round_trips_with_partial_coverage() {
        let report = test_report();
        let json = serde_json::to_string(&report).expect("serialize report");
        let restored: SessionUsageReport = serde_json::from_str(&json).expect("deserialize report");

        assert_eq!(restored, report);
        assert_eq!(
            restored.coverage.level,
            UsageCoverageLevel::Partial,
            "Partial usage reports must make partial coverage explicit"
        );
    }

    #[test]
    fn session_usage_report_round_trips_with_workspace_scope_and_privacy() {
        let mut report = test_report();
        report.workspace.kind = UsageWorkspaceKind::RemoteSsh;
        report.workspace.remote_ssh_host = Some("example.internal".to_string());
        report
            .privacy
            .redacted_fields
            .push("slowest.label".to_string());

        let json = serde_json::to_string(&report).expect("serialize report");

        assert!(json.contains("remote_ssh"));
        assert!(json.contains("redactedFields"));

        let restored: SessionUsageReport = serde_json::from_str(&json).expect("deserialize report");
        assert_eq!(restored.workspace.kind, UsageWorkspaceKind::RemoteSsh);
        assert_eq!(restored.privacy.redacted_fields, vec!["slowest.label"]);
    }

    #[test]
    fn token_cache_unavailable_does_not_require_cached_value() {
        let report = test_report();

        assert_eq!(
            report.tokens.cache_coverage,
            UsageCacheCoverage::Unavailable
        );
        assert_eq!(report.tokens.cached_tokens, None);
    }
}
