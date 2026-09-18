use crate::agentic::persistence::PersistenceManager;
use crate::service::session::{
    collect_hidden_subagent_cascade, DialogTurnData, DialogTurnKind, ModelRoundData,
    SessionMetadata, ToolItemData, ToolItemIdentityExt, TurnStatus,
};
use crate::service::session_usage::classifier::classify_tool_usage;
use crate::service::session_usage::redaction::{
    display_workspace_relative_path, redact_usage_input_summary, redact_usage_label,
};
use crate::service::session_usage::types::*;
use crate::service::snapshot::get_snapshot_manager_for_workspace;
use crate::service::snapshot::types::FileOperation;
use crate::service::token_usage::{
    TimeRange, TokenUsageQuery, TokenUsageRecord, TokenUsageService,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use chrono::Utc;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

pub use openbitfun_runtime_ports::AgentSessionUsageRequest as SessionUsageReportRequest;

pub async fn generate_session_usage_report(
    persistence_manager: &PersistenceManager,
    token_usage_service: Option<&TokenUsageService>,
    request: SessionUsageReportRequest,
) -> OpenBitFunResult<SessionUsageReport> {
    let workspace_path = request.workspace_path.clone().ok_or_else(|| {
        OpenBitFunError::validation("Workspace path is required for usage reports")
    })?;
    generate_session_usage_report_from_storage_path(
        persistence_manager,
        token_usage_service,
        Path::new(&workspace_path),
        request,
    )
    .await
}

/// Build a usage report after a product adapter has resolved the Session
/// storage directory. The request workspace remains the source of snapshot
/// facts and user-facing identity; persisted Session and subagent facts use
/// `session_storage_path`.
pub async fn generate_session_usage_report_from_storage_path(
    persistence_manager: &PersistenceManager,
    token_usage_service: Option<&TokenUsageService>,
    session_storage_path: &Path,
    request: SessionUsageReportRequest,
) -> OpenBitFunResult<SessionUsageReport> {
    let revert_boundary = persistence_manager
        .load_session_revert_state(session_storage_path, &request.session_id)
        .await?
        .map(|state| state.boundary_turn);
    let mut turns = persistence_manager
        .load_session_turns(session_storage_path, &request.session_id)
        .await?;
    retain_usage_turns_before_boundary(&mut turns, revert_boundary);
    let (session_ids, subagent_scope_complete) =
        token_usage_session_scope(persistence_manager, session_storage_path, &request, &turns)
            .await;
    let (token_turn_scope, turn_scope_complete) = token_usage_turn_scope(
        persistence_manager,
        session_storage_path,
        &request,
        &turns,
        &session_ids,
    )
    .await;
    let token_records = if let Some(service) = token_usage_service {
        service
            .query_records_for_sessions(token_usage_query(&request), &session_ids)
            .await
            .map_err(|error| {
                OpenBitFunError::service(format!("Failed to query token usage records: {}", error))
            })?
    } else {
        Vec::new()
    };

    let workspace_id = persistence_manager
        .load_session_header(session_storage_path, &request.session_id)
        .await
        .ok()
        .and_then(|session| session.config.workspace_id);
    let snapshot_facts =
        load_snapshot_facts(&request, workspace_id.as_deref(), revert_boundary).await;

    Ok(build_session_usage_report_from_sources_with_scope(
        request,
        &turns,
        &token_records,
        &snapshot_facts,
        Utc::now().timestamp_millis(),
        &token_turn_scope,
        subagent_scope_complete && turn_scope_complete,
    ))
}

fn token_usage_query(request: &SessionUsageReportRequest) -> TokenUsageQuery {
    TokenUsageQuery {
        model_id: None,
        // Hidden subagents use their own session IDs. The storage call receives
        // the exact parent/child session set separately and scans history once.
        session_id: None,
        time_range: TimeRange::All,
        time_zone: None,
        limit: None,
        offset: None,
        include_subagent: request.include_hidden_subagents,
    }
}

async fn token_usage_session_scope(
    persistence_manager: &PersistenceManager,
    workspace_path: &Path,
    request: &SessionUsageReportRequest,
    turns: &[DialogTurnData],
) -> (HashSet<String>, bool) {
    if !request.include_hidden_subagents {
        return (HashSet::from([request.session_id.clone()]), true);
    }
    let metadata = persistence_manager
        .list_session_metadata_including_internal(workspace_path)
        .await
        .ok();
    token_usage_session_ids(request, turns, metadata.as_deref())
}

fn token_usage_session_ids(
    request: &SessionUsageReportRequest,
    turns: &[DialogTurnData],
    metadata: Option<&[SessionMetadata]>,
) -> (HashSet<String>, bool) {
    let reportable_turns = turns
        .iter()
        .filter(|turn| is_reportable_usage_turn(turn))
        .cloned()
        .collect::<Vec<_>>();
    let mut session_ids = HashSet::from([request.session_id.clone()]);
    if !request.include_hidden_subagents {
        return (session_ids, true);
    }

    let direct_session_ids = iter_tools(&reportable_turns)
        .filter_map(|tool| tool.subagent_session_id.as_ref())
        .cloned()
        .collect::<HashSet<_>>();
    let parent_turn_ids = reportable_turns
        .iter()
        .map(|turn| turn.turn_id.clone())
        .collect::<HashSet<_>>();
    let persisted_cascade = metadata
        .map(|metadata| {
            collect_hidden_subagent_cascade(
                metadata.iter().cloned(),
                &request.session_id,
                &parent_turn_ids,
            )
            .into_iter()
            .collect::<HashSet<_>>()
        })
        .unwrap_or_default();
    let complete = metadata.is_some() && direct_session_ids.is_subset(&persisted_cascade);
    session_ids.extend(persisted_cascade);
    session_ids.extend(direct_session_ids);
    (session_ids, complete)
}

type TokenUsageTurnScope = HashMap<String, HashSet<String>>;

fn extend_token_usage_turn_scope(
    scope: &mut TokenUsageTurnScope,
    session_id: &str,
    turns: &[DialogTurnData],
) {
    let reportable_turns = turns
        .iter()
        .filter(|turn| is_reportable_usage_turn(turn))
        .cloned()
        .collect::<Vec<_>>();
    scope
        .entry(session_id.to_string())
        .or_default()
        .extend(reportable_turns.iter().map(|turn| turn.turn_id.clone()));
    for tool in iter_tools(&reportable_turns) {
        if let (Some(child_session_id), Some(child_turn_id)) = (
            tool.subagent_session_id.as_ref(),
            tool.subagent_dialog_turn_id.as_ref(),
        ) {
            scope
                .entry(child_session_id.clone())
                .or_default()
                .insert(child_turn_id.clone());
        }
    }
}

async fn token_usage_turn_scope(
    _persistence_manager: &PersistenceManager,
    workspace_path: &Path,
    request: &SessionUsageReportRequest,
    parent_turns: &[DialogTurnData],
    session_ids: &HashSet<String>,
) -> (TokenUsageTurnScope, bool) {
    let mut scope = TokenUsageTurnScope::new();
    extend_token_usage_turn_scope(&mut scope, &request.session_id, parent_turns);
    if !request.include_hidden_subagents {
        return (scope, true);
    }

    let mut complete = true;
    for session_id in session_ids {
        if session_id == &request.session_id {
            continue;
        }
        let turns = match crate::agentic::coordination::get_global_coordinator() {
            Some(coordinator) => {
                coordinator
                    .load_visible_persisted_session_turns(workspace_path, session_id)
                    .await
            }
            None => {
                complete = false;
                continue;
            }
        };
        match turns {
            Ok(turns) => extend_token_usage_turn_scope(&mut scope, session_id, &turns),
            Err(_) => complete = false,
        }
    }
    (scope, complete)
}

pub fn build_session_usage_report_from_turns(
    request: SessionUsageReportRequest,
    turns: &[DialogTurnData],
    token_records: &[TokenUsageRecord],
    generated_at: i64,
) -> SessionUsageReport {
    build_session_usage_report_from_sources(
        request,
        turns,
        token_records,
        &UsageSnapshotFacts::default(),
        generated_at,
    )
}

pub fn build_session_usage_report_from_sources(
    request: SessionUsageReportRequest,
    turns: &[DialogTurnData],
    token_records: &[TokenUsageRecord],
    snapshot_facts: &UsageSnapshotFacts,
    generated_at: i64,
) -> SessionUsageReport {
    let (_, subagent_scope_complete) = token_usage_session_ids(&request, turns, None);
    let mut token_turn_scope = TokenUsageTurnScope::new();
    extend_token_usage_turn_scope(&mut token_turn_scope, &request.session_id, turns);
    build_session_usage_report_from_sources_with_scope(
        request,
        turns,
        token_records,
        snapshot_facts,
        generated_at,
        &token_turn_scope,
        subagent_scope_complete,
    )
}

fn build_session_usage_report_from_sources_with_scope(
    request: SessionUsageReportRequest,
    turns: &[DialogTurnData],
    token_records: &[TokenUsageRecord],
    snapshot_facts: &UsageSnapshotFacts,
    generated_at: i64,
    token_turn_scope: &TokenUsageTurnScope,
    subagent_scope_complete: bool,
) -> SessionUsageReport {
    let reportable_turns: Vec<DialogTurnData> = turns
        .iter()
        .filter(|turn| is_reportable_usage_turn(turn))
        .cloned()
        .collect();
    let turns = reportable_turns.as_slice();
    // Token usage is stored globally and session IDs are only unique within a
    // workspace. Join records back to the exact parent/child lineage loaded
    // from this workspace so equal identifiers elsewhere cannot contaminate
    // the report.
    let scoped_token_records: Vec<TokenUsageRecord> = token_records
        .iter()
        .filter(|record| {
            token_turn_scope
                .get(&record.session_id)
                .is_some_and(|turn_ids| turn_ids.contains(&record.turn_id))
                && (record.session_id == request.session_id || request.include_hidden_subagents)
        })
        .cloned()
        .collect();
    let includes_subagent_records = scoped_token_records
        .iter()
        .any(|record| record.session_id != request.session_id);
    let token_records = scoped_token_records.as_slice();
    let mut report = SessionUsageReport::partial_unavailable(&request.session_id, generated_at);
    report.report_id = format!("usage-{}-{}", request.session_id, generated_at);
    report.workspace = build_workspace(&request);
    report.scope = build_scope(turns, includes_subagent_records);
    report.coverage = build_coverage(
        &request,
        turns,
        token_records,
        snapshot_facts,
        subagent_scope_complete,
    );
    report.time = build_time_breakdown(turns, generated_at);
    report.tokens = build_token_breakdown(token_records);
    report.models = build_model_breakdown(turns, token_records);
    report.tools = build_tool_breakdown(turns);
    report.files = build_file_breakdown(request.workspace_path.as_deref(), turns, snapshot_facts);
    report.compression = build_compression_breakdown(turns);
    report.errors = build_error_breakdown(turns);
    report.slowest = build_slowest_spans(turns, token_records);
    report.privacy = UsagePrivacy {
        prompt_content_included: false,
        tool_inputs_included: report
            .slowest
            .iter()
            .any(|span| span.input_summary.is_some()),
        command_outputs_included: false,
        file_contents_included: false,
        redacted_fields: collect_redacted_fields(&report),
    };
    report
}

async fn load_snapshot_facts(
    request: &SessionUsageReportRequest,
    workspace_id: Option<&str>,
    revert_boundary: Option<usize>,
) -> UsageSnapshotFacts {
    let Some(workspace_id) = workspace_id else {
        return UsageSnapshotFacts::default();
    };
    let Some(manager) = get_snapshot_manager_for_workspace(workspace_id) else {
        return UsageSnapshotFacts::default();
    };

    match manager.get_session(&request.session_id).await {
        Ok(session) => UsageSnapshotFacts {
            source_available: true,
            operations: session
                .operations
                .into_iter()
                .filter(|operation| usage_index_is_visible(operation.turn_index, revert_boundary))
                .map(snapshot_operation_from_file_operation)
                .collect(),
        },
        Err(_) => UsageSnapshotFacts::default(),
    }
}

fn retain_usage_turns_before_boundary(
    turns: &mut Vec<DialogTurnData>,
    revert_boundary: Option<usize>,
) {
    turns.retain(|turn| usage_index_is_visible(turn.turn_index, revert_boundary));
}

fn usage_index_is_visible(turn_index: usize, revert_boundary: Option<usize>) -> bool {
    revert_boundary.is_none_or(|boundary| turn_index < boundary)
}

fn is_reportable_usage_turn(turn: &DialogTurnData) -> bool {
    turn.kind != DialogTurnKind::LocalCommand
}

fn snapshot_operation_from_file_operation(
    operation: FileOperation,
) -> UsageSnapshotOperationSummary {
    UsageSnapshotOperationSummary {
        operation_id: operation.operation_id,
        session_id: operation.session_id,
        turn_index: operation.turn_index,
        file_path: operation.file_path.to_string_lossy().to_string(),
        lines_added: operation.diff_summary.lines_added as u64,
        lines_removed: operation.diff_summary.lines_removed as u64,
    }
}

fn build_workspace(request: &SessionUsageReportRequest) -> UsageWorkspace {
    UsageWorkspace {
        kind: if request.remote_connection_id.is_some() || request.remote_ssh_host.is_some() {
            UsageWorkspaceKind::RemoteSsh
        } else if request.workspace_path.is_some() {
            UsageWorkspaceKind::Local
        } else {
            UsageWorkspaceKind::Unknown
        },
        path_label: request
            .workspace_path
            .as_deref()
            .map(|path| redact_usage_label(path, 120).value),
        workspace_id: request.workspace_id.clone(),
        remote_connection_id: request.remote_connection_id.clone(),
        remote_ssh_host: request.remote_ssh_host.clone(),
    }
}

fn build_scope(turns: &[DialogTurnData], includes_subagents: bool) -> UsageScope {
    UsageScope {
        kind: UsageScopeKind::EntireSession,
        turn_count: turns.len(),
        from_turn_id: turns.first().map(|turn| turn.turn_id.clone()),
        to_turn_id: turns.last().map(|turn| turn.turn_id.clone()),
        includes_subagents,
    }
}

fn build_coverage(
    request: &SessionUsageReportRequest,
    turns: &[DialogTurnData],
    token_records: &[TokenUsageRecord],
    snapshot_facts: &UsageSnapshotFacts,
    subagent_scope_complete: bool,
) -> UsageCoverage {
    let mut available = vec![UsageCoverageKey::WorkspaceIdentity];
    if request.include_hidden_subagents && subagent_scope_complete {
        available.push(UsageCoverageKey::SubagentScope);
    }
    if turns
        .iter()
        .flat_map(|turn| turn.model_rounds.iter())
        .any(has_model_timing_fact)
    {
        available.push(UsageCoverageKey::ModelRoundTiming);
    }
    if iter_tools(turns).any(has_tool_phase_timing_fact) {
        available.push(UsageCoverageKey::ToolPhaseTiming);
    }
    if token_records
        .iter()
        .any(|record| record.cached_tokens_available)
    {
        available.push(UsageCoverageKey::CachedTokens);
    }
    if token_records
        .iter()
        .any(|record| record.token_details.is_some())
    {
        available.push(UsageCoverageKey::TokenDetailBreakdown);
    }
    if snapshot_facts.source_available {
        available.push(UsageCoverageKey::FileLineStats);
    }

    let mut missing = vec![
        UsageCoverageKey::ToolPhaseTiming,
        UsageCoverageKey::CachedTokens,
        UsageCoverageKey::TokenDetailBreakdown,
        UsageCoverageKey::FileLineStats,
        UsageCoverageKey::SubagentScope,
    ];
    if !available.contains(&UsageCoverageKey::ModelRoundTiming) {
        missing.push(UsageCoverageKey::ModelRoundTiming);
    }
    for available_key in &available {
        missing.retain(|key| key != available_key);
    }

    if request.remote_connection_id.is_some() || request.remote_ssh_host.is_some() {
        if snapshot_facts.source_available {
            available.push(UsageCoverageKey::RemoteSnapshotStats);
        } else {
            missing.push(UsageCoverageKey::RemoteSnapshotStats);
        }
    }

    available.sort_by_key(|key| format!("{:?}", key));
    available.dedup();
    missing.sort_by_key(|key| format!("{:?}", key));
    missing.dedup();

    let mut notes = vec![
        "Report is based on persisted turns, token records, and cached snapshot summaries that already exist."
            .to_string(),
    ];
    if missing.contains(&UsageCoverageKey::CachedTokens) {
        notes.push(
            "Cached token source is unavailable when provider events do not report cache counts."
                .to_string(),
        );
    }
    if missing.contains(&UsageCoverageKey::SubagentScope) {
        if request.include_hidden_subagents {
            notes.push(
                "Subagent coverage is partial; only token records linked by persisted session lineage are included."
                    .to_string(),
            );
        } else {
            notes.push("Subagent rows are excluded from this report scope.".to_string());
        }
    }
    if snapshot_facts.source_available {
        notes.push(
            "File line stats use cached snapshot operation summaries and do not read file bodies."
                .to_string(),
        );
    } else if request.remote_connection_id.is_some() || request.remote_ssh_host.is_some() {
        notes.push(
            "Remote snapshot summaries are unavailable for this workspace, so file line stats remain partial."
                .to_string(),
        );
    }

    UsageCoverage {
        level: UsageCoverageLevel::Partial,
        available,
        missing,
        notes,
    }
}

fn build_time_breakdown(turns: &[DialogTurnData], generated_at: i64) -> UsageTimeBreakdown {
    if turns.is_empty() {
        return UsageTimeBreakdown {
            accounting: UsageTimeAccounting::Unavailable,
            denominator: UsageTimeDenominator::Unavailable,
            wall_time_ms: None,
            active_turn_ms: None,
            model_ms: None,
            tool_ms: None,
            idle_gap_ms: None,
        };
    }

    // These are persisted lifecycle spans. They intentionally describe recorded
    // session/turn/model-round boundaries, not pure provider streaming
    // throughput such as first-token latency or tokens per second.
    let start = turns.iter().map(|turn| turn.start_time).min().unwrap_or(0);
    let generated_at_ms = u64::try_from(generated_at).ok();
    let end = turns
        .iter()
        .filter_map(|turn| effective_turn_end_time(turn, generated_at_ms))
        .max()
        .unwrap_or(start);
    let wall_time_ms = end.saturating_sub(start);
    let active_intervals = turns
        .iter()
        .filter_map(|turn| {
            effective_turn_end_time(turn, generated_at_ms)
                .filter(|end| *end > turn.start_time)
                .map(|end| (turn.start_time, end))
        })
        .collect::<Vec<_>>();
    let active_turn_ms = (!active_intervals.is_empty())
        .then(|| duration_union_ms(&active_intervals))
        .or_else(|| {
            let summed: u64 = turns.iter().filter_map(|turn| turn.duration_ms).sum();
            (summed > 0).then_some(summed)
        });
    let tool_durations = turns
        .iter()
        .flat_map(|turn| turn.model_rounds.iter())
        .flat_map(|round| round.tool_items.iter())
        .filter_map(tool_duration_ms)
        .collect::<Vec<_>>();
    let tool_ms = Some(tool_durations.iter().sum());
    let model_round_durations: Vec<u64> = turns
        .iter()
        .flat_map(|turn| turn.model_rounds.iter())
        .filter_map(model_round_duration_ms)
        .collect();
    let model_ms = (!model_round_durations.is_empty()).then(|| model_round_durations.iter().sum());
    let has_incomplete_turn_span = turns.iter().any(|turn| turn.end_time.is_none());
    let has_legacy_model_span = turns
        .iter()
        .flat_map(|turn| turn.model_rounds.iter())
        .any(|round| round.duration_ms.is_none() && round.end_time.is_some());

    UsageTimeBreakdown {
        accounting: if has_incomplete_turn_span || has_legacy_model_span {
            UsageTimeAccounting::Approximate
        } else {
            UsageTimeAccounting::Exact
        },
        denominator: if active_turn_ms.is_some() {
            UsageTimeDenominator::ActiveTurnTime
        } else {
            UsageTimeDenominator::SessionWallTime
        },
        wall_time_ms: Some(wall_time_ms),
        active_turn_ms,
        model_ms,
        tool_ms,
        idle_gap_ms: active_turn_ms.map(|active| wall_time_ms.saturating_sub(active)),
    }
}

/// Compute `cache hit rate = cached / input` over records whose provider
/// reported cached tokens. Records without `cached_tokens_available` are
/// excluded from BOTH numerator and denominator — never punish a partially
/// reporting provider by inflating the denominator with un-reported input.
///
/// Returns `None` when no record reports cached tokens, or when the filtered
/// input sum is zero (avoids dividing by zero on edge cases like a tool-only
/// turn). Range: 0.0..=1.0 in normal cases; values >1.0 are theoretically
/// possible on broken providers and left as-is for diagnostic visibility.
fn compute_cache_hit_rate<'a, I>(records: I) -> Option<f64>
where
    I: IntoIterator<Item = &'a TokenUsageRecord>,
{
    let mut cached_sum: u64 = 0;
    let mut input_sum: u64 = 0;
    let mut any_reported = false;
    for record in records {
        if !record.cached_tokens_available {
            continue;
        }
        any_reported = true;
        cached_sum += record.cached_tokens as u64;
        input_sum += record.input_tokens as u64;
    }
    if !any_reported || input_sum == 0 {
        return None;
    }
    Some(cached_sum as f64 / input_sum as f64)
}

fn effective_turn_end_time(turn: &DialogTurnData, generated_at_ms: Option<u64>) -> Option<u64> {
    let mut end = span_end_time(turn.start_time, turn.end_time, turn.duration_ms);

    for round in &turn.model_rounds {
        end = max_optional_end(
            end,
            span_end_time(round.start_time, round.end_time, round.duration_ms),
        );
        for tool in &round.tool_items {
            end = max_optional_end(
                end,
                span_end_time(tool.start_time, tool.end_time, tool_duration_ms(tool)),
            );
        }
    }

    if end.is_none() && turn.status == TurnStatus::InProgress {
        end = generated_at_ms.filter(|generated_at| *generated_at > turn.start_time);
    }

    end.filter(|end| *end >= turn.start_time)
}

fn span_end_time(start_time: u64, end_time: Option<u64>, duration_ms: Option<u64>) -> Option<u64> {
    max_optional_end(
        end_time,
        duration_ms.map(|duration| start_time.saturating_add(duration)),
    )
}

fn max_optional_end(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn build_token_breakdown(token_records: &[TokenUsageRecord]) -> UsageTokenBreakdown {
    if token_records.is_empty() {
        return UsageTokenBreakdown {
            source: UsageTokenSource::Unavailable,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cached_tokens: None,
            cache_coverage: UsageCacheCoverage::Unavailable,
            cache_hit_rate: None,
        };
    }

    UsageTokenBreakdown {
        source: UsageTokenSource::TokenUsageRecords,
        input_tokens: Some(
            token_records
                .iter()
                .map(|record| record.input_tokens as u64)
                .sum(),
        ),
        output_tokens: Some(
            token_records
                .iter()
                .map(|record| record.output_tokens as u64)
                .sum(),
        ),
        total_tokens: Some(
            token_records
                .iter()
                .map(|record| record.total_tokens as u64)
                .sum(),
        ),
        cached_tokens: token_records
            .iter()
            .any(|record| record.cached_tokens_available)
            .then(|| {
                token_records
                    .iter()
                    .filter(|record| record.cached_tokens_available)
                    .map(|record| record.cached_tokens as u64)
                    .sum()
            }),
        cache_coverage: if token_records
            .iter()
            .all(|record| record.cached_tokens_available)
        {
            UsageCacheCoverage::Available
        } else if token_records
            .iter()
            .any(|record| record.cached_tokens_available)
        {
            UsageCacheCoverage::Partial
        } else {
            UsageCacheCoverage::Unavailable
        },
        cache_hit_rate: compute_cache_hit_rate(token_records.iter()),
    }
}

fn build_model_breakdown(
    turns: &[DialogTurnData],
    token_records: &[TokenUsageRecord],
) -> Vec<UsageModelBreakdown> {
    let mut by_model: HashMap<String, UsageModelBreakdown> = HashMap::new();
    let mut span_counts_by_model: HashMap<String, u64> = HashMap::new();
    let turn_indexes_by_id: HashMap<&str, usize> = turns
        .iter()
        .map(|turn| (turn.turn_id.as_str(), turn.turn_index))
        .collect();
    let token_model_ids_by_turn = build_token_model_ids_by_turn(token_records);
    for record in token_records {
        let row = by_model
            .entry(record.effective_model_name.clone())
            .or_insert_with(|| UsageModelBreakdown {
                model_id: record.effective_model_name.clone(),
                call_count: 0,
                input_tokens: Some(0),
                output_tokens: Some(0),
                total_tokens: Some(0),
                cached_tokens: None,
                // Filled in by P2-2.
                cache_hit_rate: None,
                duration_ms: None,
                sample_turn_id: None,
                sample_turn_index: None,
            });

        row.call_count += 1;
        row.input_tokens = Some(row.input_tokens.unwrap_or(0) + record.input_tokens as u64);
        row.output_tokens = Some(row.output_tokens.unwrap_or(0) + record.output_tokens as u64);
        row.total_tokens = Some(row.total_tokens.unwrap_or(0) + record.total_tokens as u64);
        if record.cached_tokens_available {
            row.cached_tokens = Some(row.cached_tokens.unwrap_or(0) + record.cached_tokens as u64);
        }
        set_turn_anchor_if_missing(
            &mut row.sample_turn_id,
            &mut row.sample_turn_index,
            &record.turn_id,
            turn_indexes_by_id.get(record.turn_id.as_str()).copied(),
        );
    }

    for turn in turns {
        for round in &turn.model_rounds {
            let Some(duration_ms) = model_round_duration_ms(round) else {
                continue;
            };
            let model_id = report_model_id_for_round(round, &token_model_ids_by_turn);
            let row = by_model
                .entry(model_id.clone())
                .or_insert_with(|| UsageModelBreakdown {
                    model_id: model_id.clone(),
                    call_count: 0,
                    input_tokens: None,
                    output_tokens: None,
                    total_tokens: None,
                    cached_tokens: None,
                    // Filled in by P2-2.
                    cache_hit_rate: None,
                    duration_ms: Some(0),
                    sample_turn_id: None,
                    sample_turn_index: None,
                });

            row.duration_ms = Some(row.duration_ms.unwrap_or(0) + duration_ms);
            set_turn_anchor_if_missing(
                &mut row.sample_turn_id,
                &mut row.sample_turn_index,
                &turn.turn_id,
                Some(turn.turn_index),
            );
            *span_counts_by_model.entry(model_id).or_default() += 1;
        }
    }

    for (model_id, span_count) in span_counts_by_model {
        if let Some(row) = by_model.get_mut(&model_id) {
            row.call_count = row.call_count.max(span_count);
        }
    }

    // Per-model hit rate: group records by model_id, then apply the same
    // numerator/denominator policy as the session-level rate.
    let mut records_by_model: HashMap<&str, Vec<&TokenUsageRecord>> = HashMap::new();
    for record in token_records {
        records_by_model
            .entry(record.effective_model_name.as_str())
            .or_default()
            .push(record);
    }
    for (model_id, model_records) in &records_by_model {
        if let Some(row) = by_model.get_mut(*model_id) {
            row.cache_hit_rate = compute_cache_hit_rate(model_records.iter().copied());
        }
    }

    let mut rows: Vec<_> = by_model.into_values().collect();
    rows.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    rows
}

fn build_token_model_ids_by_turn(
    token_records: &[TokenUsageRecord],
) -> HashMap<String, BTreeSet<String>> {
    let mut by_turn: HashMap<String, BTreeSet<String>> = HashMap::new();
    for record in token_records {
        by_turn
            .entry(record.turn_id.clone())
            .or_default()
            .insert(record.effective_model_name.clone());
    }
    by_turn
}

fn report_model_id_for_round(
    round: &ModelRoundData,
    token_model_ids_by_turn: &HashMap<String, BTreeSet<String>>,
) -> String {
    let label = model_round_label(round);
    if is_legacy_model_identity(&label) {
        if let Some(token_models) = token_model_ids_by_turn.get(&round.turn_id) {
            if token_models.len() == 1 {
                if let Some(model_id) = token_models.iter().next() {
                    return model_id.clone();
                }
            }
        }
    }
    label
}

fn is_legacy_model_identity(model_id: &str) -> bool {
    let normalized = model_id.trim().to_ascii_lowercase();
    normalized == "unknown_model"
        || (normalized.starts_with("model round ")
            && normalized["model round ".len()..]
                .chars()
                .all(|value| value.is_ascii_digit()))
}

fn build_tool_breakdown(turns: &[DialogTurnData]) -> Vec<UsageToolBreakdown> {
    let mut by_tool: HashMap<String, UsageToolBreakdown> = HashMap::new();
    let mut durations_by_tool: HashMap<String, Vec<u64>> = HashMap::new();

    for turn in turns {
        for tool in iter_turn_tools(turn) {
            let tool_name = tool.effective_name();
            let tool_input = tool.effective_input();
            let label = redact_usage_label(tool_name, 80);
            let row = by_tool
                .entry(label.value.clone())
                .or_insert_with(|| UsageToolBreakdown {
                    tool_name: label.value.clone(),
                    category: classify_tool_usage(tool_name, Some(tool_input)),
                    call_count: 0,
                    success_count: 0,
                    error_count: 0,
                    duration_ms: Some(0),
                    p95_duration_ms: None,
                    queue_wait_ms: None,
                    preflight_ms: None,
                    confirmation_wait_ms: None,
                    execution_ms: None,
                    sample_turn_id: None,
                    sample_turn_index: None,
                    sample_item_id: None,
                    redacted: label.redacted,
                });
            row.call_count += 1;
            match tool.tool_result.as_ref().map(|result| result.success) {
                Some(true) => row.success_count += 1,
                Some(false) => row.error_count += 1,
                None => {}
            }
            let duration_ms = tool_duration_ms(tool).unwrap_or(0);
            row.duration_ms = Some(row.duration_ms.unwrap_or(0) + duration_ms);
            if duration_ms > 0 {
                durations_by_tool
                    .entry(label.value.clone())
                    .or_default()
                    .push(duration_ms);
            }
            add_optional_duration(&mut row.queue_wait_ms, tool.queue_wait_ms);
            add_optional_duration(&mut row.preflight_ms, tool.preflight_ms);
            add_optional_duration(&mut row.confirmation_wait_ms, tool.confirmation_wait_ms);
            add_optional_duration(&mut row.execution_ms, tool.execution_ms);
            set_item_anchor_if_missing(
                &mut row.sample_turn_id,
                &mut row.sample_turn_index,
                &mut row.sample_item_id,
                &turn.turn_id,
                turn.turn_index,
                &tool.id,
            );
            row.redacted |= label.redacted;
        }
    }

    let mut rows: Vec<_> = by_tool
        .into_values()
        .map(|mut row| {
            row.p95_duration_ms = durations_by_tool
                .get(&row.tool_name)
                .and_then(|durations| p95_duration_ms(durations));
            row
        })
        .collect();
    rows.sort_by(|a, b| {
        b.call_count
            .cmp(&a.call_count)
            .then_with(|| a.tool_name.cmp(&b.tool_name))
    });
    rows
}

fn p95_duration_ms(durations: &[u64]) -> Option<u64> {
    if durations.len() < 2 {
        return None;
    }

    let mut sorted = durations.to_vec();
    sorted.sort_unstable();
    let index = ((sorted.len() as f64) * 0.95).ceil() as usize;
    sorted.get(index.saturating_sub(1)).copied()
}

fn build_file_breakdown(
    workspace_root: Option<&str>,
    turns: &[DialogTurnData],
    snapshot_facts: &UsageSnapshotFacts,
) -> UsageFileBreakdown {
    if snapshot_facts.source_available {
        return build_file_breakdown_from_snapshot_operations(
            workspace_root,
            &snapshot_facts.operations,
        );
    }

    build_file_breakdown_from_tool_inputs(workspace_root, turns)
}

fn build_file_breakdown_from_snapshot_operations(
    workspace_root: Option<&str>,
    operations: &[UsageSnapshotOperationSummary],
) -> UsageFileBreakdown {
    let mut files: HashMap<String, UsageFileRow> = HashMap::new();
    let mut turn_indexes_by_path: HashMap<String, BTreeSet<usize>> = HashMap::new();
    let mut operation_ids_by_path: HashMap<String, BTreeSet<String>> = HashMap::new();

    for operation in operations {
        let label = display_workspace_relative_path(workspace_root, &operation.file_path);
        let row = files
            .entry(label.value.clone())
            .or_insert_with(|| UsageFileRow {
                path_label: label.value.clone(),
                operation_count: 0,
                added_lines: Some(0),
                deleted_lines: Some(0),
                session_id: Some(operation.session_id.clone()),
                turn_indexes: vec![],
                operation_ids: vec![],
                redacted: label.redacted,
            });
        row.operation_count += 1;
        row.added_lines = Some(row.added_lines.unwrap_or(0) + operation.lines_added);
        row.deleted_lines = Some(row.deleted_lines.unwrap_or(0) + operation.lines_removed);
        row.session_id
            .get_or_insert_with(|| operation.session_id.clone());
        row.redacted |= label.redacted;

        turn_indexes_by_path
            .entry(label.value.clone())
            .or_default()
            .insert(operation.turn_index);
        operation_ids_by_path
            .entry(label.value)
            .or_default()
            .insert(operation.operation_id.clone());
    }

    let mut rows: Vec<_> = files
        .into_iter()
        .map(|(path_label, mut row)| {
            row.turn_indexes = turn_indexes_by_path
                .remove(&path_label)
                .map(|values| values.into_iter().collect())
                .unwrap_or_default();
            row.operation_ids = operation_ids_by_path
                .remove(&path_label)
                .map(|values| values.into_iter().collect())
                .unwrap_or_default();
            row
        })
        .collect();
    rows.sort_by(|a, b| a.path_label.cmp(&b.path_label));

    UsageFileBreakdown {
        scope: UsageFileScope::SnapshotSummary,
        changed_files: Some(rows.len() as u64),
        added_lines: Some(rows.iter().map(|row| row.added_lines.unwrap_or(0)).sum()),
        deleted_lines: Some(rows.iter().map(|row| row.deleted_lines.unwrap_or(0)).sum()),
        files: rows,
    }
}

fn build_file_breakdown_from_tool_inputs(
    workspace_root: Option<&str>,
    turns: &[DialogTurnData],
) -> UsageFileBreakdown {
    let mut files: HashMap<String, UsageFileRow> = HashMap::new();
    let mut turn_indexes_by_path: HashMap<String, BTreeSet<usize>> = HashMap::new();
    let mut operation_ids_by_path: HashMap<String, BTreeSet<String>> = HashMap::new();

    for turn in turns {
        for tool in iter_turn_tools(turn) {
            if !is_file_modification_tool(tool.effective_name()) {
                continue;
            }

            let Some(path) = extract_file_path(tool) else {
                continue;
            };
            let label = display_workspace_relative_path(workspace_root, &path);
            let row = files
                .entry(label.value.clone())
                .or_insert_with(|| UsageFileRow {
                    path_label: label.value.clone(),
                    operation_count: 0,
                    added_lines: None,
                    deleted_lines: None,
                    session_id: None,
                    turn_indexes: vec![],
                    operation_ids: vec![],
                    redacted: label.redacted,
                });
            row.operation_count += 1;
            row.redacted |= label.redacted;

            turn_indexes_by_path
                .entry(label.value.clone())
                .or_default()
                .insert(turn.turn_index);
            operation_ids_by_path
                .entry(label.value)
                .or_default()
                .insert(tool.id.clone());
        }
    }

    let mut rows: Vec<_> = files
        .into_iter()
        .map(|(path_label, mut row)| {
            row.turn_indexes = turn_indexes_by_path
                .remove(&path_label)
                .map(|values| values.into_iter().collect())
                .unwrap_or_default();
            row.operation_ids = operation_ids_by_path
                .remove(&path_label)
                .map(|values| values.into_iter().collect())
                .unwrap_or_default();
            row
        })
        .collect();
    rows.sort_by(|a, b| a.path_label.cmp(&b.path_label));
    UsageFileBreakdown {
        scope: if rows.is_empty() {
            UsageFileScope::Unavailable
        } else {
            UsageFileScope::ToolInputsOnly
        },
        changed_files: if rows.is_empty() {
            None
        } else {
            Some(rows.len() as u64)
        },
        added_lines: None,
        deleted_lines: None,
        files: rows,
    }
}

fn build_compression_breakdown(turns: &[DialogTurnData]) -> UsageCompressionBreakdown {
    let manual_compaction_count = turns
        .iter()
        .filter(|turn| turn.kind == DialogTurnKind::ManualCompaction)
        .count() as u64;
    let automatic_compaction_count = iter_tools(turns)
        .filter(|tool| tool.effective_name().to_lowercase().contains("compaction"))
        .count() as u64;

    UsageCompressionBreakdown {
        compaction_count: manual_compaction_count + automatic_compaction_count,
        manual_compaction_count,
        automatic_compaction_count,
        saved_tokens: None,
    }
}

fn build_error_breakdown(turns: &[DialogTurnData]) -> UsageErrorBreakdown {
    let model_errors = turns
        .iter()
        .filter(|turn| turn.status == TurnStatus::Error)
        .count() as u64;
    let tool_errors = iter_tools(turns)
        .filter(|tool| {
            tool.tool_result
                .as_ref()
                .is_some_and(|result| !result.success)
        })
        .count() as u64;
    let mut examples = Vec::new();

    if model_errors > 0 {
        let sample_model_error_turn = turns.iter().find(|turn| turn.status == TurnStatus::Error);
        examples.push(UsageErrorExample {
            label: "Model/runtime turn errors".to_string(),
            count: model_errors,
            sample_turn_id: sample_model_error_turn.map(|turn| turn.turn_id.clone()),
            sample_turn_index: sample_model_error_turn.map(|turn| turn.turn_index),
            sample_item_id: None,
            redacted: false,
        });
    }

    let mut tool_error_counts: HashMap<String, UsageErrorExample> = HashMap::new();
    for turn in turns {
        for tool in iter_turn_tools(turn).filter(|tool| {
            tool.tool_result
                .as_ref()
                .is_some_and(|result| !result.success)
        }) {
            let label = redact_usage_label(tool.effective_name(), 80);
            let row = tool_error_counts
                .entry(label.value.clone())
                .or_insert_with(|| UsageErrorExample {
                    label: label.value.clone(),
                    count: 0,
                    sample_turn_id: None,
                    sample_turn_index: None,
                    sample_item_id: None,
                    redacted: label.redacted,
                });
            row.count += 1;
            set_item_anchor_if_missing(
                &mut row.sample_turn_id,
                &mut row.sample_turn_index,
                &mut row.sample_item_id,
                &turn.turn_id,
                turn.turn_index,
                &tool.id,
            );
            row.redacted |= label.redacted;
        }
    }

    let mut tool_examples: Vec<_> = tool_error_counts.into_values().collect();
    tool_examples.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.label.cmp(&b.label)));
    examples.extend(tool_examples.into_iter().take(4));

    UsageErrorBreakdown {
        total_errors: model_errors + tool_errors,
        tool_errors,
        model_errors,
        examples,
    }
}

fn build_slowest_spans(
    turns: &[DialogTurnData],
    token_records: &[TokenUsageRecord],
) -> Vec<UsageSlowSpan> {
    let mut spans = Vec::new();
    let token_model_ids_by_turn = build_token_model_ids_by_turn(token_records);

    for turn in turns {
        if let Some(duration_ms) =
            effective_turn_end_time(turn, None).map(|end| end.saturating_sub(turn.start_time))
        {
            spans.push(UsageSlowSpan {
                label: format!("turn {}", turn.turn_index),
                kind: UsageSlowSpanKind::Turn,
                duration_ms,
                redacted: false,
                turn_id: Some(turn.turn_id.clone()),
                turn_index: Some(turn.turn_index),
                item_id: None,
                input_summary: None,
                status: None,
                timeout_seconds: None,
                exit_code: None,
                timed_out: None,
                error_summary: None,
                queue_wait_ms: None,
                preflight_ms: None,
                confirmation_wait_ms: None,
                execution_ms: None,
            });
        }

        for round in &turn.model_rounds {
            if let Some(duration_ms) = model_round_duration_ms(round) {
                spans.push(UsageSlowSpan {
                    label: report_model_id_for_round(round, &token_model_ids_by_turn),
                    kind: UsageSlowSpanKind::Model,
                    duration_ms,
                    redacted: false,
                    turn_id: Some(turn.turn_id.clone()),
                    turn_index: Some(turn.turn_index),
                    item_id: None,
                    input_summary: None,
                    status: None,
                    timeout_seconds: None,
                    exit_code: None,
                    timed_out: None,
                    error_summary: None,
                    queue_wait_ms: None,
                    preflight_ms: None,
                    confirmation_wait_ms: None,
                    execution_ms: None,
                });
            }
        }

        for tool in iter_turn_tools(turn) {
            let label = redact_usage_label(tool.effective_name(), 80);
            if let Some(duration_ms) = tool_duration_ms(tool) {
                spans.push(UsageSlowSpan {
                    label: label.value,
                    kind: UsageSlowSpanKind::Tool,
                    duration_ms,
                    redacted: label.redacted,
                    turn_id: Some(turn.turn_id.clone()),
                    turn_index: Some(turn.turn_index),
                    item_id: Some(tool.id.clone()),
                    input_summary: tool_input_summary(tool),
                    status: tool_status_summary(tool),
                    timeout_seconds: tool_timeout_seconds(tool),
                    exit_code: tool_exit_code(tool),
                    timed_out: tool_timed_out(tool),
                    error_summary: tool_error_summary(tool),
                    queue_wait_ms: tool.queue_wait_ms,
                    preflight_ms: tool.preflight_ms,
                    confirmation_wait_ms: tool.confirmation_wait_ms,
                    execution_ms: tool.execution_ms,
                });
            }
        }
    }

    spans.sort_by_key(|span| std::cmp::Reverse(span.duration_ms));
    spans.truncate(5);
    spans
}

fn collect_redacted_fields(report: &SessionUsageReport) -> Vec<String> {
    let mut fields = HashSet::new();
    if report.tools.iter().any(|tool| tool.redacted) {
        fields.insert("tools.toolName".to_string());
    }
    if report.files.files.iter().any(|file| file.redacted) {
        fields.insert("files.pathLabel".to_string());
    }
    if report.slowest.iter().any(|span| span.redacted) {
        fields.insert("slowest.label".to_string());
    }
    if report
        .slowest
        .iter()
        .filter_map(|span| span.input_summary.as_deref())
        .any(|summary| summary.contains("[redacted]"))
    {
        fields.insert("slowest.inputSummary".to_string());
    }

    let mut fields: Vec<_> = fields.into_iter().collect();
    fields.sort();
    fields
}

fn iter_tools(turns: &[DialogTurnData]) -> impl Iterator<Item = &ToolItemData> {
    turns.iter().flat_map(iter_turn_tools)
}

fn iter_turn_tools(turn: &DialogTurnData) -> impl Iterator<Item = &ToolItemData> {
    turn.model_rounds
        .iter()
        .flat_map(|round| round.tool_items.iter())
}

fn model_round_duration_ms(round: &ModelRoundData) -> Option<u64> {
    round.duration_ms.or_else(|| {
        round
            .end_time
            .map(|end| end.saturating_sub(round.start_time))
    })
}

fn model_round_label(round: &ModelRoundData) -> String {
    round
        .effective_model_name
        .as_deref()
        .map(|value| redact_usage_label(value, 80).value)
        .unwrap_or_else(|| "unknown_model".to_string())
}

fn has_model_timing_fact(round: &ModelRoundData) -> bool {
    model_round_duration_ms(round).is_some()
        || round.first_chunk_ms.is_some()
        || round.first_visible_output_ms.is_some()
        || round.stream_duration_ms.is_some()
        || round.attempt_count.is_some()
        || round.failure_category.is_some()
}

fn has_tool_phase_timing_fact(tool: &ToolItemData) -> bool {
    tool.queue_wait_ms.is_some()
        || tool.preflight_ms.is_some()
        || tool.confirmation_wait_ms.is_some()
        || tool.execution_ms.is_some()
}

fn tool_duration_ms(tool: &ToolItemData) -> Option<u64> {
    tool.duration_ms
        .or_else(|| {
            tool.tool_result
                .as_ref()
                .and_then(|result| result.duration_ms)
        })
        .or_else(|| tool.end_time.map(|end| end.saturating_sub(tool.start_time)))
}

fn tool_input_summary(tool: &ToolItemData) -> Option<String> {
    let input = tool.effective_input().as_object()?;
    let command = input
        .get("command")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(command) = command {
        return Some(redact_usage_input_summary(command, 180).value);
    }

    let url = ["url", "request_url", "endpoint"]
        .into_iter()
        .find_map(|field| input.get(field).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let method = input
        .get("method")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let summary = method
        .map(|method| format!("{method} {url}"))
        .unwrap_or_else(|| url.to_string());
    Some(redact_usage_input_summary(&summary, 180).value)
}

fn tool_timeout_seconds(tool: &ToolItemData) -> Option<u64> {
    let input = tool.effective_input().as_object()?;
    input
        .get("timeout_seconds")
        .and_then(|value| value.as_u64())
        .or_else(|| {
            input
                .get("timeout_ms")
                .and_then(|value| value.as_u64())
                .map(|ms| ms.div_ceil(1000))
        })
}

fn tool_status_summary(tool: &ToolItemData) -> Option<String> {
    if let Some(success) = tool.tool_result.as_ref().map(|result| result.success) {
        return Some(if success { "succeeded" } else { "failed" }.to_string());
    }

    tool.status.as_deref().map(|status| match status {
        "completed" | "success" | "succeeded" => "succeeded".to_string(),
        "failed" | "error" => "failed".to_string(),
        "cancelled" | "canceled" => "cancelled".to_string(),
        other => redact_usage_label(other, 80).value,
    })
}

fn tool_exit_code(tool: &ToolItemData) -> Option<i64> {
    tool.tool_result
        .as_ref()
        .and_then(|result| result.result.get("exit_code"))
        .and_then(|value| value.as_i64())
}

fn tool_timed_out(tool: &ToolItemData) -> Option<bool> {
    tool.tool_result
        .as_ref()
        .and_then(|result| result.result.get("timed_out"))
        .and_then(|value| value.as_bool())
}

fn tool_error_summary(tool: &ToolItemData) -> Option<String> {
    let error = tool
        .tool_result
        .as_ref()
        .and_then(|result| result.error.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(redact_usage_label(error, 180).value)
}

fn add_optional_duration(total: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *total = Some(total.unwrap_or(0) + value);
    }
}

fn set_turn_anchor_if_missing(
    sample_turn_id: &mut Option<String>,
    sample_turn_index: &mut Option<usize>,
    turn_id: &str,
    turn_index: Option<usize>,
) {
    if sample_turn_id.is_none() {
        *sample_turn_id = Some(turn_id.to_string());
    }
    if sample_turn_index.is_none() {
        *sample_turn_index = turn_index;
    }
}

fn set_item_anchor_if_missing(
    sample_turn_id: &mut Option<String>,
    sample_turn_index: &mut Option<usize>,
    sample_item_id: &mut Option<String>,
    turn_id: &str,
    turn_index: usize,
    item_id: &str,
) {
    set_turn_anchor_if_missing(sample_turn_id, sample_turn_index, turn_id, Some(turn_index));
    if sample_item_id.is_none() {
        *sample_item_id = Some(item_id.to_string());
    }
}

fn duration_union_ms(intervals: &[(u64, u64)]) -> u64 {
    let mut normalized = intervals
        .iter()
        .filter_map(|(start, end)| (end > start).then_some((*start, *end)))
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return 0;
    }

    normalized.sort_unstable_by_key(|(start, end)| (*start, *end));
    let mut total = 0;
    let (mut current_start, mut current_end) = normalized[0];

    for (start, end) in normalized.into_iter().skip(1) {
        if start <= current_end {
            current_end = current_end.max(end);
        } else {
            total += current_end.saturating_sub(current_start);
            current_start = start;
            current_end = end;
        }
    }

    total + current_end.saturating_sub(current_start)
}

fn is_file_modification_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "Write"
            | "Edit"
            | "Delete"
            | "write_file"
            | "edit_file"
            | "create_file"
            | "delete_file"
            | "rename_file"
            | "move_file"
            | "search_replace"
    )
}

fn extract_file_path(tool: &ToolItemData) -> Option<String> {
    let input = tool.effective_input().as_object()?;
    ["file_path", "path", "filePath", "target_file", "filename"]
        .into_iter()
        .find_map(|key| input.get(key).and_then(|value| value.as_str()))
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::session::{
        DialogTurnData, ModelRoundData, ToolCallData, ToolItemData, ToolResultData, UserMessageData,
    };
    use chrono::TimeZone;

    #[test]
    fn report_marks_cache_unavailable_for_zero_filled_cache_source() {
        let request = test_request(None);
        let records = vec![test_token_record("model-a", 100, 20, 0)];

        let report = build_session_usage_report_from_turns(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &records,
            1_778_347_200_000,
        );

        assert_eq!(report.tokens.total_tokens, Some(120));
        assert_eq!(report.tokens.cached_tokens, None);
        assert_eq!(
            report.tokens.cache_coverage,
            UsageCacheCoverage::Unavailable
        );
        assert!(report
            .coverage
            .missing
            .contains(&UsageCoverageKey::CachedTokens));
    }

    #[test]
    fn report_uses_cached_tokens_when_provider_reports_them() {
        let request = test_request(None);
        let mut records = vec![test_token_record("model-a", 100, 20, 12)];
        records[0].cached_tokens_available = true;

        let report = build_session_usage_report_from_turns(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &records,
            1_778_347_200_000,
        );

        assert_eq!(report.tokens.cached_tokens, Some(12));
        assert_eq!(report.tokens.cache_coverage, UsageCacheCoverage::Available);
        assert_eq!(report.models[0].cached_tokens, Some(12));
        assert!(report
            .coverage
            .available
            .contains(&UsageCoverageKey::CachedTokens));
    }

    #[test]
    fn report_marks_remote_snapshot_stats_partial() {
        let request = test_request(Some("ssh-1"));

        let report = build_session_usage_report_from_turns(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[],
            1_778_347_200_000,
        );

        assert_eq!(report.workspace.kind, UsageWorkspaceKind::RemoteSsh);
        assert!(report
            .coverage
            .missing
            .contains(&UsageCoverageKey::RemoteSnapshotStats));
    }

    #[test]
    fn report_scopes_by_workspace_identity() {
        let request = test_request(None);

        let report = build_session_usage_report_from_turns(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[],
            1_778_347_200_000,
        );

        assert_eq!(report.session_id, "session-1");
        assert_eq!(report.workspace.kind, UsageWorkspaceKind::Local);
        assert_eq!(
            report.workspace.path_label.as_deref(),
            Some("D:/workspace/openbitfun")
        );
    }

    #[test]
    fn report_excludes_token_records_not_owned_by_loaded_turns() {
        let request = test_request(None);
        let mut unrelated_record = test_token_record("model-b", 200, 40, 0);
        unrelated_record.turn_id = "turn-from-another-workspace".to_string();

        let report = build_session_usage_report_from_turns(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[test_token_record("model-a", 100, 20, 0), unrelated_record],
            1_778_347_200_000,
        );

        assert_eq!(report.tokens.total_tokens, Some(120));
        assert_eq!(report.models.len(), 1);
        assert_eq!(report.models[0].model_id, "model-a");
    }

    #[test]
    fn report_excludes_equal_turn_id_from_another_session() {
        let request = test_request(None);
        let mut unrelated_record = test_token_record("model-b", 200, 40, 0);
        unrelated_record.session_id = "session-from-another-workspace".to_string();

        let report = build_session_usage_report_from_turns(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[test_token_record("model-a", 100, 20, 0), unrelated_record],
            1_778_347_200_000,
        );

        assert_eq!(report.tokens.total_tokens, Some(120));
        assert_eq!(report.models.len(), 1);
        assert_eq!(report.models[0].model_id, "model-a");
    }

    #[test]
    fn report_includes_only_linked_hidden_subagent_records_when_requested() {
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        let tool = &mut turn.model_rounds[0].tool_items[0];
        tool.subagent_session_id = Some("child-session".to_string());
        tool.subagent_dialog_turn_id = Some("child-turn".to_string());

        let root_record = test_token_record("model-a", 100, 20, 0);
        let mut child_record = test_token_record("model-b", 50, 10, 0);
        child_record.session_id = "child-session".to_string();
        child_record.turn_id = "child-turn".to_string();
        child_record.is_subagent = true;
        let records = [root_record, child_record];

        let included = build_session_usage_report_from_turns(
            test_request(None),
            std::slice::from_ref(&turn),
            &records,
            1_778_347_200_000,
        );
        let mut excluded_request = test_request(None);
        excluded_request.include_hidden_subagents = false;
        let excluded = build_session_usage_report_from_turns(
            excluded_request,
            &[turn],
            &records,
            1_778_347_200_000,
        );

        assert_eq!(included.tokens.total_tokens, Some(180));
        assert_eq!(included.models.len(), 2);
        assert_eq!(excluded.tokens.total_tokens, Some(120));
        assert_eq!(excluded.models.len(), 1);
    }

    #[test]
    fn report_excludes_unverifiable_legacy_child_records_and_marks_lineage_partial() {
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        turn.model_rounds[0].tool_items[0].subagent_session_id = Some("child-session".to_string());

        let mut child_record = test_token_record("model-b", 50, 10, 0);
        child_record.session_id = "child-session".to_string();
        child_record.turn_id = "legacy-child-turn".to_string();
        child_record.is_subagent = true;
        let report = build_session_usage_report_from_turns(
            test_request(None),
            &[turn],
            &[test_token_record("model-a", 100, 20, 0), child_record],
            1_778_347_200_000,
        );

        assert_eq!(report.tokens.total_tokens, Some(120));
        assert!(!report.scope.includes_subagents);
        assert!(report
            .coverage
            .missing
            .contains(&UsageCoverageKey::SubagentScope));
        assert!(report
            .coverage
            .notes
            .iter()
            .any(|note| note.contains("Subagent coverage is partial")));
    }

    #[test]
    fn report_excludes_same_child_session_id_with_unowned_turn_id() {
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        let tool = &mut turn.model_rounds[0].tool_items[0];
        tool.subagent_session_id = Some("child-session".to_string());
        tool.subagent_dialog_turn_id = Some("owned-child-turn".to_string());

        let mut owned = test_token_record("model-b", 50, 10, 0);
        owned.session_id = "child-session".to_string();
        owned.turn_id = "owned-child-turn".to_string();
        owned.is_subagent = true;
        let mut collision = test_token_record("model-c", 500, 100, 0);
        collision.session_id = "child-session".to_string();
        collision.turn_id = "other-workspace-turn".to_string();
        collision.is_subagent = true;

        let report = build_session_usage_report_from_turns(
            test_request(None),
            &[turn],
            &[test_token_record("model-a", 100, 20, 0), owned, collision],
            1_778_347_200_000,
        );

        assert_eq!(report.tokens.total_tokens, Some(180));
        assert_eq!(
            report
                .models
                .iter()
                .map(|model| model.model_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["model-a", "model-b"])
        );
    }

    #[test]
    fn usage_scope_resolves_persisted_hidden_subagent_cascade() {
        let request = test_request(None);
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        turn.model_rounds[0].tool_items[0].subagent_session_id = Some("child-session".to_string());

        let mut child = SessionMetadata::new(
            "child-session".to_string(),
            "Child".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        child.relationship = Some(crate::service::session::SessionRelationship {
            kind: Some(crate::service::session::SessionRelationshipKind::Subagent),
            parent_session_id: Some("session-1".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("turn-1".to_string()),
            parent_turn_index: Some(0),
            parent_tool_call_id: Some("tool-1".to_string()),
            subagent_type: Some("Explore".to_string()),
            continuation_policy: None,
        });
        let mut grandchild = SessionMetadata::new(
            "grandchild-session".to_string(),
            "Grandchild".to_string(),
            "Explore".to_string(),
            "model".to_string(),
        );
        grandchild.relationship = Some(crate::service::session::SessionRelationship {
            kind: Some(crate::service::session::SessionRelationshipKind::Subagent),
            parent_session_id: Some("child-session".to_string()),
            parent_request_id: None,
            parent_dialog_turn_id: Some("child-turn".to_string()),
            parent_turn_index: Some(0),
            parent_tool_call_id: Some("child-tool".to_string()),
            subagent_type: Some("Explore".to_string()),
            continuation_policy: None,
        });

        let (session_ids, complete) =
            token_usage_session_ids(&request, &[turn], Some(&[child, grandchild]));

        assert!(complete);
        assert_eq!(
            session_ids,
            HashSet::from([
                "session-1".to_string(),
                "child-session".to_string(),
                "grandchild-session".to_string(),
            ])
        );
    }

    #[test]
    fn usage_query_bounds_storage_results_to_parent_and_linked_children() {
        let request = test_request(None);
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        turn.model_rounds[0].tool_items[0].subagent_session_id = Some("child-session".to_string());

        let (session_ids, complete) = token_usage_session_ids(&request, &[turn], None);

        assert!(!complete);
        assert_eq!(
            session_ids,
            HashSet::from(["session-1".to_string(), "child-session".to_string()])
        );
    }

    #[test]
    fn report_active_runtime_uses_active_span_union() {
        let request = test_request(None);
        let mut first = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        first.start_time = 1_000;
        first.end_time = Some(1_300);
        first.duration_ms = Some(300);
        first.model_rounds[0].start_time = 1_010;
        first.model_rounds[0].end_time = Some(1_110);
        first.model_rounds[0].duration_ms = Some(100);

        let mut second = test_turn("turn-2", 1, DialogTurnKind::ManualCompaction);
        second.start_time = 1_200;
        second.end_time = Some(1_500);
        second.duration_ms = Some(300);
        second.model_rounds[0].start_time = 1_220;
        second.model_rounds[0].end_time = Some(1_340);
        second.model_rounds[0].duration_ms = Some(120);

        let report = build_session_usage_report_from_turns(
            request,
            &[first, second],
            &[],
            1_778_347_200_000,
        );

        assert_eq!(report.time.accounting, UsageTimeAccounting::Exact);
        assert_eq!(
            report.time.denominator,
            UsageTimeDenominator::ActiveTurnTime
        );
        assert_eq!(report.time.wall_time_ms, Some(500));
        assert_eq!(report.time.active_turn_ms, Some(500));
        assert_eq!(report.time.model_ms, Some(220));
        assert_eq!(report.time.idle_gap_ms, Some(0));
        assert_eq!(report.compression.manual_compaction_count, 1);
    }

    #[test]
    fn report_active_runtime_includes_incomplete_turn_child_spans() {
        let request = test_request(None);
        let mut completed = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        completed.start_time = 1_000;
        completed.end_time = Some(61_000);
        completed.duration_ms = Some(60_000);
        completed.model_rounds[0].start_time = 2_000;
        completed.model_rounds[0].end_time = Some(12_000);
        completed.model_rounds[0].duration_ms = Some(10_000);
        completed.model_rounds[0].tool_items.clear();

        let mut incomplete = test_turn("turn-2", 1, DialogTurnKind::UserDialog);
        incomplete.start_time = 121_000;
        incomplete.end_time = None;
        incomplete.duration_ms = None;
        incomplete.model_rounds[0].start_time = 122_000;
        incomplete.model_rounds[0].end_time = Some(181_000);
        incomplete.model_rounds[0].duration_ms = Some(59_000);
        incomplete.model_rounds[0].tool_items = vec![test_tool_item_with_input(
            "slow-command",
            "ExecCommand",
            Some(true),
            120_000,
            serde_json::json!({
                "command": "pnpm install",
                "timeout_seconds": 300
            }),
        )];
        incomplete.model_rounds[0].tool_items[0].start_time = 181_000;
        incomplete.model_rounds[0].tool_items[0].end_time = Some(301_000);

        let report = build_session_usage_report_from_turns(
            request,
            &[completed, incomplete],
            &[],
            1_778_347_200_000,
        );

        assert_eq!(report.time.accounting, UsageTimeAccounting::Approximate);
        assert_eq!(report.time.wall_time_ms, Some(300_000));
        assert_eq!(report.time.active_turn_ms, Some(240_000));
        assert_eq!(report.time.tool_ms, Some(120_000));
    }

    #[test]
    fn report_excludes_local_command_turns_from_usage_metrics() {
        let request = test_request(None);
        let mut user_turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        user_turn.start_time = 1_000;
        user_turn.end_time = Some(1_300);
        user_turn.duration_ms = Some(300);
        user_turn.model_rounds[0].duration_ms = Some(200);

        let mut local_usage_turn = test_turn("local-usage-1", 1, DialogTurnKind::LocalCommand);
        local_usage_turn.start_time = 50_000;
        local_usage_turn.end_time = Some(50_000);
        local_usage_turn.duration_ms = Some(0);
        local_usage_turn.model_rounds[0].duration_ms = Some(9_000);

        let report = build_session_usage_report_from_turns(
            request,
            &[user_turn, local_usage_turn],
            &[],
            1_778_347_200_000,
        );

        assert_eq!(report.scope.turn_count, 1);
        assert_eq!(report.scope.from_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(report.scope.to_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(report.time.wall_time_ms, Some(300));
        assert_eq!(report.time.active_turn_ms, Some(300));
        assert_eq!(report.time.model_ms, Some(200));
        assert_eq!(report.models[0].duration_ms, Some(200));
        assert_eq!(report.tools[0].call_count, 1);
        assert_eq!(report.files.files[0].operation_count, 1);
    }

    #[test]
    fn staged_revert_boundary_excludes_hidden_turn_token_tool_and_snapshot_usage() {
        let request = test_request(None);
        let mut turns = vec![
            test_turn("turn-visible", 0, DialogTurnKind::UserDialog),
            test_turn("turn-hidden", 1, DialogTurnKind::UserDialog),
        ];
        retain_usage_turns_before_boundary(&mut turns, Some(1));

        let mut visible_record = test_token_record("model-a", 100, 20, 0);
        visible_record.turn_id = "turn-visible".to_string();
        let mut hidden_record = test_token_record("model-a", 900, 100, 0);
        hidden_record.turn_id = "turn-hidden".to_string();
        let snapshot_facts = test_snapshot_facts(
            [
                test_snapshot_operation(
                    "op-visible",
                    0,
                    "D:/workspace/openbitfun/src/visible.rs",
                    2,
                    0,
                ),
                test_snapshot_operation(
                    "op-hidden",
                    1,
                    "D:/workspace/openbitfun/src/hidden.rs",
                    30,
                    4,
                ),
            ]
            .into_iter()
            .filter(|operation| usage_index_is_visible(operation.turn_index, Some(1)))
            .collect(),
        );

        let report = build_session_usage_report_from_sources(
            request,
            &turns,
            &[visible_record, hidden_record],
            &snapshot_facts,
            1_778_347_200_000,
        );

        assert_eq!(report.scope.turn_count, 1);
        assert_eq!(report.scope.to_turn_id.as_deref(), Some("turn-visible"));
        assert_eq!(report.tokens.total_tokens, Some(120));
        assert_eq!(
            report.tools.iter().map(|tool| tool.call_count).sum::<u64>(),
            1
        );
        assert_eq!(report.files.files.len(), 1);
        assert_eq!(report.files.files[0].path_label, "src/visible.rs");
    }

    #[test]
    fn report_classifies_deferred_calls_by_effective_identity_and_nested_args() {
        let request = test_request(None);
        let tool = test_tool_item_with_input(
            "tool-deferred",
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
            Some(true),
            120,
            serde_json::json!({
                "tool_name": "write_file",
                "args": { "path": "D:/workspace/openbitfun/src/main.rs" }
            }),
        );
        let turn = test_turn_with_tools("turn-1", 0, DialogTurnKind::UserDialog, vec![tool]);

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        assert_eq!(report.tools.len(), 1);
        assert_eq!(report.tools[0].tool_name, "write_file");
        assert_eq!(report.files.files.len(), 1);
        assert_eq!(report.files.files[0].path_label, "src/main.rs");
    }

    #[test]
    fn report_uses_persisted_model_span_facts_without_token_records() {
        let request = test_request(None);
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        turn.model_rounds = vec![
            test_model_round("round-a", "turn-1", 0, "model-a", 90),
            test_model_round("round-b", "turn-1", 1, "model-b", 140),
        ];

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        assert!(report
            .coverage
            .available
            .contains(&UsageCoverageKey::ModelRoundTiming));
        assert!(!report
            .coverage
            .missing
            .contains(&UsageCoverageKey::ModelRoundTiming));
        assert_eq!(
            report
                .models
                .iter()
                .map(|model| (
                    model.model_id.as_str(),
                    model.call_count,
                    model.duration_ms,
                    model.total_tokens
                ))
                .collect::<Vec<_>>(),
            vec![
                ("model-a", 1, Some(90), None),
                ("model-b", 1, Some(140), None),
            ]
        );
        assert!(report.slowest.iter().any(|span| {
            span.kind == UsageSlowSpanKind::Model
                && span.label == "model-b"
                && span.duration_ms == 140
        }));
    }

    #[test]
    fn report_merges_legacy_model_timing_into_token_model_row_for_same_turn() {
        let request = test_request(None);
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        turn.model_rounds[0].model_config_id = None;
        turn.model_rounds[0].effective_model_name = None;
        turn.model_rounds[0].duration_ms = Some(180);
        let token_record = test_token_record("gpt-5.4", 120, 30, 0);

        let report = build_session_usage_report_from_turns(
            request,
            &[turn],
            &[token_record],
            1_778_347_200_000,
        );

        assert_eq!(
            report
                .models
                .iter()
                .map(|model| (
                    model.model_id.as_str(),
                    model.call_count,
                    model.duration_ms,
                    model.total_tokens
                ))
                .collect::<Vec<_>>(),
            vec![("gpt-5.4", 1, Some(180), Some(150))]
        );
        assert!(report.slowest.iter().any(|span| {
            span.kind == UsageSlowSpanKind::Model
                && span.label == "gpt-5.4"
                && span.duration_ms == 180
        }));
    }

    #[test]
    fn report_uses_clear_label_when_model_identity_is_missing() {
        let request = test_request(None);
        let mut turn = test_turn("turn-1", 0, DialogTurnKind::UserDialog);
        turn.model_rounds[0].model_config_id = None;
        turn.model_rounds[0].effective_model_name = None;
        turn.model_rounds[0].duration_ms = Some(180);

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        assert_eq!(report.models[0].model_id, "unknown_model");
        assert!(report.slowest.iter().any(|span| {
            span.kind == UsageSlowSpanKind::Model
                && span.label == "unknown_model"
                && span.duration_ms == 180
        }));
    }

    #[test]
    fn report_adds_turn_anchors_to_slowest_spans() {
        let request = test_request(None);
        let mut turn = test_turn_with_tools(
            "turn-7",
            7,
            DialogTurnKind::UserDialog,
            vec![test_tool_item(
                "tool-7",
                "write_file",
                Some(true),
                500,
                "D:/workspace/openbitfun/src/main.rs",
            )],
        );
        turn.duration_ms = Some(900);
        turn.model_rounds[0].duration_ms = Some(700);

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        for kind in [
            UsageSlowSpanKind::Turn,
            UsageSlowSpanKind::Model,
            UsageSlowSpanKind::Tool,
        ] {
            let span = report
                .slowest
                .iter()
                .find(|span| span.kind == kind)
                .expect("anchored slow span");
            assert_eq!(span.turn_id.as_deref(), Some("turn-7"));
            assert_eq!(span.turn_index, Some(7));
        }
    }

    #[test]
    fn slowest_spans_are_descending_and_stable_for_equal_durations() {
        let request = test_request(None);
        let first = test_turn("turn-first", 1, DialogTurnKind::UserDialog);
        let second = test_turn("turn-second", 2, DialogTurnKind::UserDialog);
        let mut longest = test_turn("turn-longest", 3, DialogTurnKind::UserDialog);
        longest.duration_ms = Some(900);
        longest.end_time = Some(longest.start_time + 900);

        let report = build_session_usage_report_from_turns(
            request,
            &[first, second, longest],
            &[],
            1_778_347_200_000,
        );
        let turn_ids = report
            .slowest
            .iter()
            .filter(|span| span.kind == UsageSlowSpanKind::Turn)
            .filter_map(|span| span.turn_id.as_deref())
            .collect::<Vec<_>>();

        assert_eq!(turn_ids, vec!["turn-longest", "turn-first", "turn-second"]);
    }

    #[test]
    fn report_adds_representative_anchors_to_model_tool_and_error_rows() {
        let request = test_request(None);
        let mut failed_turn = test_turn_with_tools(
            "turn-2",
            2,
            DialogTurnKind::UserDialog,
            vec![test_tool_item(
                "tool-failed",
                "write_file",
                Some(false),
                120,
                "D:/workspace/openbitfun/src/main.rs",
            )],
        );
        failed_turn.model_rounds[0].model_config_id = Some("config-model-a".to_string());
        failed_turn.model_rounds[0].effective_model_name = Some("model-a".to_string());
        failed_turn.model_rounds[0].duration_ms = Some(220);
        let mut model_error_turn =
            test_turn_with_tools("turn-4", 4, DialogTurnKind::UserDialog, vec![]);
        model_error_turn.status = TurnStatus::Error;

        let report = build_session_usage_report_from_turns(
            request,
            &[failed_turn, model_error_turn],
            &[],
            1_778_347_200_000,
        );

        let model = report
            .models
            .iter()
            .find(|model| model.model_id == "model-a")
            .expect("model row");
        assert_eq!(model.sample_turn_id.as_deref(), Some("turn-2"));
        assert_eq!(model.sample_turn_index, Some(2));

        let tool = report
            .tools
            .iter()
            .find(|tool| tool.tool_name == "write_file")
            .expect("tool row");
        assert_eq!(tool.sample_turn_id.as_deref(), Some("turn-2"));
        assert_eq!(tool.sample_turn_index, Some(2));
        assert_eq!(tool.sample_item_id.as_deref(), Some("tool-failed"));

        let tool_error = report
            .errors
            .examples
            .iter()
            .find(|example| example.label == "write_file")
            .expect("tool error example");
        assert_eq!(tool_error.sample_turn_id.as_deref(), Some("turn-2"));
        assert_eq!(tool_error.sample_turn_index, Some(2));
        assert_eq!(tool_error.sample_item_id.as_deref(), Some("tool-failed"));

        let model_error = report
            .errors
            .examples
            .iter()
            .find(|example| example.label == "Model/runtime turn errors")
            .expect("model error example");
        assert_eq!(model_error.sample_turn_id.as_deref(), Some("turn-4"));
        assert_eq!(model_error.sample_turn_index, Some(4));
        assert_eq!(model_error.sample_item_id, None);
    }

    #[test]
    fn report_counts_failed_and_cancelled_tool_duration_when_available() {
        let request = test_request(None);
        let turn = test_turn_with_tools(
            "turn-1",
            0,
            DialogTurnKind::UserDialog,
            vec![
                test_tool_item(
                    "tool-failed",
                    "write_file",
                    Some(false),
                    120,
                    "D:/workspace/openbitfun/src/main.rs",
                ),
                test_tool_item(
                    "tool-cancelled",
                    "edit_file",
                    None,
                    80,
                    "D:/workspace/openbitfun/src/lib.rs",
                ),
            ],
        );

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        let failed = report
            .tools
            .iter()
            .find(|tool| tool.tool_name == "write_file")
            .expect("failed tool row");
        assert_eq!(failed.error_count, 1);
        assert_eq!(failed.duration_ms, Some(120));

        let cancelled = report
            .tools
            .iter()
            .find(|tool| tool.tool_name == "edit_file")
            .expect("cancelled tool row");
        assert_eq!(cancelled.call_count, 1);
        assert_eq!(cancelled.duration_ms, Some(80));
    }

    #[test]
    fn report_computes_tool_p95_only_with_multiple_duration_spans() {
        let request = test_request(None);
        let turn = test_turn_with_tools(
            "turn-1",
            0,
            DialogTurnKind::UserDialog,
            vec![
                test_tool_item(
                    "tool-1",
                    "write_file",
                    Some(true),
                    10,
                    "D:/workspace/openbitfun/src/a.rs",
                ),
                test_tool_item(
                    "tool-2",
                    "write_file",
                    Some(true),
                    100,
                    "D:/workspace/openbitfun/src/b.rs",
                ),
                test_tool_item(
                    "tool-3",
                    "write_file",
                    Some(true),
                    200,
                    "D:/workspace/openbitfun/src/c.rs",
                ),
                test_tool_item(
                    "tool-4",
                    "edit_file",
                    Some(true),
                    60,
                    "D:/workspace/openbitfun/src/d.rs",
                ),
            ],
        );

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        let write = report
            .tools
            .iter()
            .find(|tool| tool.tool_name == "write_file")
            .expect("write tool row");
        assert_eq!(write.duration_ms, Some(310));
        assert_eq!(write.p95_duration_ms, Some(200));

        let edit = report
            .tools
            .iter()
            .find(|tool| tool.tool_name == "edit_file")
            .expect("edit tool row");
        assert_eq!(edit.p95_duration_ms, None);
    }

    #[test]
    fn report_sums_tool_phase_timings_and_marks_phase_coverage_available() {
        let request = test_request(None);
        let mut first = test_tool_item(
            "tool-1",
            "write_file",
            Some(true),
            100,
            "D:/workspace/openbitfun/src/a.rs",
        );
        first.queue_wait_ms = Some(7);
        first.preflight_ms = Some(11);
        first.confirmation_wait_ms = Some(13);
        first.execution_ms = Some(69);

        let mut second = test_tool_item(
            "tool-2",
            "write_file",
            Some(true),
            80,
            "D:/workspace/openbitfun/src/b.rs",
        );
        second.queue_wait_ms = Some(3);
        second.preflight_ms = Some(5);
        second.confirmation_wait_ms = Some(0);
        second.execution_ms = Some(72);

        let turn =
            test_turn_with_tools("turn-1", 0, DialogTurnKind::UserDialog, vec![first, second]);

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);

        let write = report
            .tools
            .iter()
            .find(|tool| tool.tool_name == "write_file")
            .expect("write tool row");
        assert_eq!(write.duration_ms, Some(180));
        assert_eq!(write.queue_wait_ms, Some(10));
        assert_eq!(write.preflight_ms, Some(16));
        assert_eq!(write.confirmation_wait_ms, Some(13));
        assert_eq!(write.execution_ms, Some(141));
        assert!(report
            .coverage
            .available
            .contains(&UsageCoverageKey::ToolPhaseTiming));
        assert!(!report
            .coverage
            .missing
            .contains(&UsageCoverageKey::ToolPhaseTiming));
    }

    #[test]
    fn report_slowest_tool_spans_include_diagnostic_fields() {
        let request = test_request(None);
        let mut slow = test_tool_item_with_input(
            "tool-slow",
            "ExecCommand",
            Some(false),
            95_000,
            serde_json::json!({
                "command": "curl https://api.example.test/slow",
                "timeout_seconds": 90
            }),
        );
        slow.queue_wait_ms = Some(5);
        slow.preflight_ms = Some(10);
        slow.confirmation_wait_ms = Some(15);
        slow.execution_ms = Some(94_970);
        slow.tool_result = Some(ToolResultData {
            result: serde_json::json!({
                "exit_code": 28,
                "timed_out": true,
                "stderr": "operation timed out"
            }),
            success: false,
            result_for_assistant: None,
            image_attachments: None,
            error: Some("operation timed out".to_string()),
            duration_ms: Some(95_000),
        });
        let turn = test_turn_with_tools("turn-1", 0, DialogTurnKind::UserDialog, vec![slow]);

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);
        let span = report
            .slowest
            .iter()
            .find(|span| span.kind == UsageSlowSpanKind::Tool)
            .expect("slow tool span");

        assert_eq!(span.item_id.as_deref(), Some("tool-slow"));
        assert_eq!(
            span.input_summary.as_deref(),
            Some("curl https://api.example.test/slow")
        );
        assert_eq!(span.status.as_deref(), Some("failed"));
        assert_eq!(span.exit_code, Some(28));
        assert_eq!(span.timed_out, Some(true));
        assert_eq!(span.error_summary.as_deref(), Some("operation timed out"));
        assert_eq!(span.execution_ms, Some(94_970));
    }

    #[test]
    fn report_slowest_tool_spans_summarize_url_inputs() {
        let request = test_request(None);
        let slow = test_tool_item_with_input(
            "tool-slow-url",
            "web_fetch",
            Some(true),
            95_000,
            serde_json::json!({
                "method": "GET",
                "url": "https://api.example.test/slow"
            }),
        );
        let turn = test_turn_with_tools("turn-1", 0, DialogTurnKind::UserDialog, vec![slow]);

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);
        let span = report
            .slowest
            .iter()
            .find(|span| span.item_id.as_deref() == Some("tool-slow-url"))
            .expect("slow URL tool span");

        assert_eq!(
            span.input_summary.as_deref(),
            Some("GET https://api.example.test/slow")
        );
    }

    #[test]
    fn report_slowest_tool_input_summary_redacts_common_secrets() {
        let request = test_request(None);
        let slow_command = test_tool_item_with_input(
            "tool-secret-command",
            "ExecCommand",
            Some(true),
            95_000,
            serde_json::json!({
                "command": "curl -H 'Authorization: Bearer sk-secret' https://api.example.test --api-key abc123"
            }),
        );
        let slow_url = test_tool_item_with_input(
            "tool-secret-url",
            "web_fetch",
            Some(true),
            94_000,
            serde_json::json!({
                "method": "GET",
                "url": "https://api.example.test/slow?token=secret-token&x=1"
            }),
        );
        let turn = test_turn_with_tools(
            "turn-1",
            0,
            DialogTurnKind::UserDialog,
            vec![slow_command, slow_url],
        );

        let report =
            build_session_usage_report_from_turns(request, &[turn], &[], 1_778_347_200_000);
        let command_span = report
            .slowest
            .iter()
            .find(|span| span.item_id.as_deref() == Some("tool-secret-command"))
            .expect("slow command span");
        let url_span = report
            .slowest
            .iter()
            .find(|span| span.item_id.as_deref() == Some("tool-secret-url"))
            .expect("slow URL span");

        let command_summary = command_span
            .input_summary
            .as_deref()
            .expect("command summary");
        assert!(command_summary.contains("Authorization: Bearer [redacted]"));
        assert!(command_summary.contains("--api-key [redacted]"));
        assert!(!command_summary.contains("sk-secret"));
        assert!(!command_summary.contains("abc123"));
        assert_eq!(
            url_span.input_summary.as_deref(),
            Some("GET https://api.example.test/slow?token=[redacted]&x=1")
        );
        assert!(report
            .privacy
            .redacted_fields
            .contains(&"slowest.inputSummary".to_string()));
    }

    #[test]
    fn aggregates_operation_summary_file_stats_without_reading_file_bodies() {
        let request = test_request(None);
        let snapshot_facts = test_snapshot_facts(vec![
            test_snapshot_operation("op-1", 0, "D:/workspace/openbitfun/src/main.rs", 10, 2),
            test_snapshot_operation("op-2", 1, "D:/workspace/openbitfun/src/main.rs", 5, 1),
            test_snapshot_operation("op-3", 1, "D:/workspace/openbitfun/src/lib.rs", 4, 0),
        ]);

        let report = build_session_usage_report_from_sources(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[],
            &snapshot_facts,
            1_778_347_200_000,
        );

        assert_eq!(report.files.scope, UsageFileScope::SnapshotSummary);
        assert_eq!(report.files.changed_files, Some(2));
        assert_eq!(report.files.added_lines, Some(19));
        assert_eq!(report.files.deleted_lines, Some(3));
        assert!(report
            .coverage
            .available
            .contains(&UsageCoverageKey::FileLineStats));
        assert!(!report
            .coverage
            .missing
            .contains(&UsageCoverageKey::FileLineStats));

        let main_row = report
            .files
            .files
            .iter()
            .find(|row| row.path_label == "src/main.rs")
            .expect("main.rs row");
        assert_eq!(main_row.operation_count, 2);
        assert_eq!(main_row.added_lines, Some(15));
        assert_eq!(main_row.deleted_lines, Some(3));
    }

    #[test]
    fn remote_workspace_without_snapshot_marks_file_stats_partial() {
        let request = test_request(Some("ssh-1"));

        let report = build_session_usage_report_from_sources(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[],
            &UsageSnapshotFacts::default(),
            1_778_347_200_000,
        );

        assert_eq!(report.workspace.kind, UsageWorkspaceKind::RemoteSsh);
        assert_eq!(report.files.scope, UsageFileScope::ToolInputsOnly);
        assert_eq!(report.files.changed_files, Some(1));
        assert_eq!(report.files.added_lines, None);
        assert!(report
            .coverage
            .missing
            .contains(&UsageCoverageKey::FileLineStats));
        assert!(report
            .coverage
            .missing
            .contains(&UsageCoverageKey::RemoteSnapshotStats));
    }

    #[test]
    fn remote_workspace_uses_wrapped_tool_inputs_for_file_rows() {
        let request = test_request(Some("ssh-1"));
        let turn = test_turn_with_tools(
            "turn-1",
            0,
            DialogTurnKind::UserDialog,
            vec![
                test_tool_item_with_input(
                    "tool-1",
                    "Write",
                    Some(true),
                    100,
                    serde_json::json!({ "file_path": "D:/workspace/openbitfun/src/main.rs" }),
                ),
                test_tool_item_with_input(
                    "tool-2",
                    "Edit",
                    Some(true),
                    80,
                    serde_json::json!({ "target_file": "D:/workspace/openbitfun/src/lib.rs" }),
                ),
            ],
        );

        let report = build_session_usage_report_from_sources(
            request,
            &[turn],
            &[],
            &UsageSnapshotFacts::default(),
            1_778_347_200_000,
        );

        assert_eq!(report.workspace.kind, UsageWorkspaceKind::RemoteSsh);
        assert_eq!(report.files.scope, UsageFileScope::ToolInputsOnly);
        assert_eq!(report.files.changed_files, Some(2));
        assert_eq!(
            report
                .files
                .files
                .iter()
                .map(|row| row.path_label.as_str())
                .collect::<Vec<_>>(),
            vec!["src/lib.rs", "src/main.rs"]
        );
    }

    #[test]
    fn report_includes_error_examples_for_failed_turns_and_tools() {
        let request = test_request(None);
        let mut failed_turn = test_turn_with_tools(
            "turn-1",
            0,
            DialogTurnKind::UserDialog,
            vec![
                test_tool_item(
                    "tool-1",
                    "Write",
                    Some(false),
                    100,
                    "D:/workspace/openbitfun/src/main.rs",
                ),
                test_tool_item(
                    "tool-2",
                    "ExecCommand",
                    Some(false),
                    120,
                    "D:/workspace/openbitfun",
                ),
            ],
        );
        failed_turn.status = TurnStatus::Error;

        let report =
            build_session_usage_report_from_turns(request, &[failed_turn], &[], 1_778_347_200_000);

        assert_eq!(report.errors.total_errors, 3);
        assert_eq!(report.errors.tool_errors, 2);
        assert_eq!(report.errors.model_errors, 1);
        assert_eq!(
            report
                .errors
                .examples
                .iter()
                .map(|example| (example.label.as_str(), example.count))
                .collect::<Vec<_>>(),
            vec![
                ("Model/runtime turn errors", 1),
                ("ExecCommand", 1),
                ("Write", 1),
            ]
        );
    }

    #[test]
    fn file_rows_preserve_operation_turn_and_session_scopes() {
        let request = test_request(None);
        let snapshot_facts = test_snapshot_facts(vec![
            test_snapshot_operation("op-9", 2, "D:/workspace/openbitfun/src/main.rs", 1, 0),
            test_snapshot_operation("op-1", 0, "D:/workspace/openbitfun/src/main.rs", 2, 1),
        ]);

        let report = build_session_usage_report_from_sources(
            request,
            &[test_turn("turn-1", 0, DialogTurnKind::UserDialog)],
            &[],
            &snapshot_facts,
            1_778_347_200_000,
        );

        let row = report
            .files
            .files
            .iter()
            .find(|row| row.path_label == "src/main.rs")
            .expect("main.rs row");

        assert_eq!(row.session_id.as_deref(), Some("session-1"));
        assert_eq!(row.turn_indexes, vec![0, 2]);
        assert_eq!(row.operation_ids, vec!["op-1", "op-9"]);
    }

    fn test_request(remote_connection_id: Option<&str>) -> SessionUsageReportRequest {
        SessionUsageReportRequest {
            session_id: "session-1".to_string(),
            workspace_id: None,
            workspace_path: Some("D:/workspace/openbitfun".to_string()),
            remote_connection_id: remote_connection_id.map(ToOwned::to_owned),
            remote_ssh_host: remote_connection_id.map(|_| "host.example".to_string()),
            include_hidden_subagents: true,
        }
    }

    fn test_snapshot_facts(operations: Vec<UsageSnapshotOperationSummary>) -> UsageSnapshotFacts {
        UsageSnapshotFacts {
            source_available: true,
            operations,
        }
    }

    fn test_snapshot_operation(
        operation_id: &str,
        turn_index: usize,
        file_path: &str,
        lines_added: u64,
        lines_removed: u64,
    ) -> UsageSnapshotOperationSummary {
        UsageSnapshotOperationSummary {
            operation_id: operation_id.to_string(),
            session_id: "session-1".to_string(),
            turn_index,
            file_path: file_path.to_string(),
            lines_added,
            lines_removed,
        }
    }

    fn test_turn(turn_id: &str, turn_index: usize, kind: DialogTurnKind) -> DialogTurnData {
        test_turn_with_tools(
            turn_id,
            turn_index,
            kind,
            vec![test_tool_item(
                &format!("tool-{}", turn_index),
                "write_file",
                Some(true),
                100,
                "D:/workspace/openbitfun/src/main.rs",
            )],
        )
    }

    fn test_turn_with_tools(
        turn_id: &str,
        turn_index: usize,
        kind: DialogTurnKind,
        tool_items: Vec<ToolItemData>,
    ) -> DialogTurnData {
        DialogTurnData {
            turn_id: turn_id.to_string(),
            turn_index,
            session_id: "session-1".to_string(),
            timestamp: 1_000 + turn_index as u64,
            kind,
            agent_type: None,
            user_message: UserMessageData {
                id: format!("user-{}", turn_index),
                content: "hidden from report".to_string(),
                timestamp: 1_000 + turn_index as u64,
                metadata: None,
            },
            model_rounds: vec![ModelRoundData {
                id: format!("round-{}", turn_index),
                turn_id: turn_id.to_string(),
                round_index: 0,
                round_group_id: None,
                timestamp: 1_000 + turn_index as u64,
                text_items: vec![],
                tool_items,
                thinking_items: vec![],
                start_time: 1_000 + turn_index as u64,
                end_time: Some(1_200 + turn_index as u64),
                duration_ms: Some(200),
                provider_id: None,
                model_config_id: Some("model-config-a".to_string()),
                effective_model_name: Some("model-a".to_string()),
                first_chunk_ms: None,
                first_visible_output_ms: None,
                stream_duration_ms: None,
                attempt_count: None,
                attempt_diagnostics: vec![],
                failure_category: None,
                token_details: None,
                status: "completed".to_string(),
            }],
            start_time: 1_000 + turn_index as u64,
            end_time: Some(1_300 + turn_index as u64),
            duration_ms: Some(300),
            token_usage: None,
            finish_reason: None,
            has_final_response: None,
            error: None,
            error_detail: None,
            recovery: None,
            recovery_epoch: None,
            status: TurnStatus::Completed,
        }
    }

    fn test_model_round(
        id: &str,
        turn_id: &str,
        round_index: usize,
        model_id: &str,
        duration_ms: u64,
    ) -> ModelRoundData {
        ModelRoundData {
            id: id.to_string(),
            turn_id: turn_id.to_string(),
            round_index,
            round_group_id: None,
            timestamp: 1_000 + round_index as u64,
            text_items: vec![],
            tool_items: vec![],
            thinking_items: vec![],
            start_time: 1_000 + round_index as u64,
            end_time: Some(1_000 + round_index as u64 + duration_ms),
            duration_ms: Some(duration_ms),
            provider_id: Some("test-provider".to_string()),
            model_config_id: Some(format!("config-{}", model_id)),
            effective_model_name: Some(model_id.to_string()),
            first_chunk_ms: Some(5),
            first_visible_output_ms: Some(8),
            stream_duration_ms: Some(duration_ms.saturating_sub(10)),
            attempt_count: Some(1),
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        }
    }

    fn test_tool_item(
        id: &str,
        tool_name: &str,
        success: Option<bool>,
        duration_ms: u64,
        file_path: &str,
    ) -> ToolItemData {
        test_tool_item_with_input(
            id,
            tool_name,
            success,
            duration_ms,
            serde_json::json!({
                "file_path": file_path
            }),
        )
    }

    fn test_tool_item_with_input(
        id: &str,
        tool_name: &str,
        success: Option<bool>,
        duration_ms: u64,
        input: serde_json::Value,
    ) -> ToolItemData {
        ToolItemData {
            id: id.to_string(),
            tool_name: tool_name.to_string(),
            tool_call: ToolCallData {
                input,
                id: format!("call-{}", id),
            },
            tool_result: success.map(|success| ToolResultData {
                result: serde_json::json!({}),
                success,
                result_for_assistant: None,
                image_attachments: None,
                error: (!success).then(|| "tool failed".to_string()),
                duration_ms: Some(duration_ms),
            }),
            ai_intent: None,
            start_time: 1_000,
            end_time: Some(1_000 + duration_ms),
            duration_ms: Some(duration_ms),
            order_index: None,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            subagent_dialog_turn_id: None,
            attempt_id: None,
            attempt_index: None,
            subagent_model_id: None,
            subagent_model_display_name: None,
            status: Some(
                match success {
                    Some(true) => "completed",
                    Some(false) => "failed",
                    None => "cancelled",
                }
                .to_string(),
            ),
            interruption_reason: success.is_none().then(|| "cancelled".to_string()),
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
        }
    }

    fn test_token_record(
        model_id: &str,
        input_tokens: u32,
        output_tokens: u32,
        cached_tokens: u32,
    ) -> TokenUsageRecord {
        TokenUsageRecord {
            model_config_id: format!("config-{}", model_id),
            effective_model_name: model_id.to_string(),
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            timestamp: Utc.timestamp_millis_opt(1_778_347_200_000).unwrap(),
            input_tokens,
            output_tokens,
            cached_tokens,
            cached_tokens_available: false,
            cache_write_tokens: 0,
            total_tokens: input_tokens + output_tokens,
            token_details: None,
            is_subagent: false,
        }
    }

    fn reported_token_record(
        model_id: &str,
        input_tokens: u32,
        output_tokens: u32,
        cached_tokens: u32,
    ) -> TokenUsageRecord {
        let mut record = test_token_record(model_id, input_tokens, output_tokens, cached_tokens);
        record.cached_tokens_available = true;
        record
    }

    #[test]
    fn cache_hit_rate_computes_when_all_records_report_cache() {
        let records = vec![
            reported_token_record("model-a", 100, 20, 30),
            reported_token_record("model-a", 200, 40, 80),
        ];
        let breakdown = build_token_breakdown(&records);
        // (30 + 80) / (100 + 200) = 110 / 300
        let rate = breakdown.cache_hit_rate.expect("hit rate present");
        assert!((rate - (110.0 / 300.0)).abs() < 1e-9);
    }

    #[test]
    fn cache_hit_rate_is_none_when_no_record_reports_cache() {
        let records = vec![
            test_token_record("model-a", 100, 20, 0),
            test_token_record("model-a", 200, 40, 0),
        ];
        let breakdown = build_token_breakdown(&records);
        assert_eq!(breakdown.cache_hit_rate, None);
    }

    #[test]
    fn cache_hit_rate_excludes_unreported_records_from_denominator() {
        // Partial coverage: one record reports, the other does not. The
        // unreported record must be excluded from BOTH numerator and
        // denominator — otherwise hit rate is artificially deflated.
        let records = vec![
            reported_token_record("model-a", 100, 20, 80), // reports → counts
            test_token_record("model-a", 9999, 1, 0),      // unreported → excluded
        ];
        let breakdown = build_token_breakdown(&records);
        let rate = breakdown.cache_hit_rate.expect("hit rate present");
        // 80 / 100 — the 9999 input from the unreported record must NOT bloat the denominator.
        assert!((rate - 0.8).abs() < 1e-9);
    }

    #[test]
    fn cache_hit_rate_none_when_input_sum_is_zero() {
        // Edge case: reported records but their input_tokens all 0.
        // Avoid divide-by-zero; surface as None.
        let records = vec![reported_token_record("model-a", 0, 5, 0)];
        let breakdown = build_token_breakdown(&records);
        assert_eq!(breakdown.cache_hit_rate, None);
    }

    #[test]
    fn per_model_cache_hit_rate_isolated_per_model() {
        let records = vec![
            reported_token_record("model-a", 100, 10, 40), // a: 40/100
            reported_token_record("model-b", 200, 20, 50), // b: 50/200
        ];
        let models = build_model_breakdown(&[], &records);
        let a = models.iter().find(|m| m.model_id == "model-a").unwrap();
        let b = models.iter().find(|m| m.model_id == "model-b").unwrap();
        assert!((a.cache_hit_rate.unwrap() - 0.4).abs() < 1e-9);
        assert!((b.cache_hit_rate.unwrap() - 0.25).abs() < 1e-9);
    }
}
