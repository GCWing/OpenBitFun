use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::core::{Message, MessageContent, MessageRole, ToolCall, ToolResult};
use crate::agentic::insights::session_paths::collect_effective_session_storage_targets;
use crate::agentic::insights::types::*;
use crate::agentic::persistence::PersistenceManager;
use crate::infrastructure::get_path_manager_arc;
use crate::service::session::{
    collect_hidden_subagent_cascade, estimate_turn_message_count, DialogTurnData, SessionMetadata,
    ToolItemIdentityExt, TurnStatus,
};
use crate::service::session_usage::{
    build_session_usage_report_from_turns, SessionUsageReportRequest,
};
use crate::service::snapshot::get_snapshot_manager_for_workspace;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use chrono::{DateTime, Local, Utc};
use log::{debug, warn};
use openbitfun_agent_tools::ResolvedToolInvocation;
use std::collections::{HashMap, HashSet};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_TRANSCRIPT_CHARS: usize = 16000;
const MAX_TEXT_PER_MESSAGE: usize = 800;
const TAIL_RESERVE_CHARS: usize = 4000;
/// Gaps longer than this between messages are treated as "user away" and excluded
/// from both active duration and response time calculations.
const ACTIVITY_GAP_THRESHOLD_SECS: u64 = 30 * 60;

fn effective_tool_call_name(tool_call: &ToolCall) -> String {
    ResolvedToolInvocation::from_wire_call(tool_call.tool_name.clone(), tool_call.arguments.clone())
        .map(|invocation| invocation.effective_tool_name)
        .unwrap_or_else(|_| tool_call.tool_name.clone())
}

fn effective_tool_result_name<'a>(
    wire_tool_name: &'a str,
    effective_tool_name: &'a Option<String>,
) -> &'a str {
    effective_tool_name.as_deref().unwrap_or(wire_tool_name)
}

pub struct InsightsCollector;

impl InsightsCollector {
    /// Stage 1: Collect session data from PersistenceManager across all workspaces
    pub async fn collect(days: u32) -> OpenBitFunResult<(BaseStats, Vec<SessionTranscript>)> {
        let path_manager = get_path_manager_arc();
        let pm = PersistenceManager::new(path_manager)?;
        let coordinator = get_global_coordinator().ok_or_else(|| {
            OpenBitFunError::service("Core coordinator is unavailable for Insights history reads")
        })?;
        let now = SystemTime::now();
        let now_ms = system_time_to_unix_ms(now);
        let cutoff_ms = now_ms.saturating_sub(days as u64 * 86_400_000);

        let workspace_targets = collect_effective_session_storage_targets().await?;

        let mut transcripts = Vec::new();
        let mut base_stats = BaseStats::default();
        let mut seen_sessions: HashSet<(String, String)> = HashSet::new();
        let mut modified_files: HashSet<(String, String)> = HashSet::new();

        for target in &workspace_targets {
            let ws_path = &target.session_storage_path;
            let workspace_path = &target.workspace_path;
            let sessions = match pm.list_sessions(ws_path).await {
                Ok(s) => s,
                Err(e) => {
                    warn!("Skipping workspace {}: {}", ws_path.display(), e);
                    continue;
                }
            };
            let metadata_including_internal = pm
                .list_session_metadata_including_internal(ws_path)
                .await
                .unwrap_or_default();
            let recent_hidden_parent_ids =
                recent_hidden_parent_session_ids(&metadata_including_internal, cutoff_ms);

            for summary in &sessions {
                if system_time_to_unix_ms(summary.last_activity_at) < cutoff_ms
                    && !recent_hidden_parent_ids.contains(&summary.session_id)
                {
                    continue;
                }
                let session_key = (target.workspace_id.clone(), summary.session_id.clone());
                if !seen_sessions.insert(session_key) {
                    continue;
                }

                let mut session = match pm.load_session(ws_path, &summary.session_id).await {
                    Ok(value) => value,
                    Err(e) => {
                        warn!(
                            "Skipping session {}: load failed: {}",
                            summary.session_id, e
                        );
                        continue;
                    }
                };
                let parent_turns = match coordinator
                    .load_visible_persisted_session_turns(ws_path, &summary.session_id)
                    .await
                {
                    Ok(value) => value,
                    Err(e) => {
                        warn!(
                            "Skipping session {}: visible history load failed: {}",
                            summary.session_id, e
                        );
                        continue;
                    }
                };
                session.dialog_turn_ids = parent_turns
                    .iter()
                    .map(|turn| turn.turn_id.clone())
                    .collect();

                let parent_turn_ids = parent_turns
                    .iter()
                    .map(|turn| turn.turn_id.clone())
                    .collect::<HashSet<_>>();
                let hidden_session_ids = collect_hidden_subagent_cascade(
                    metadata_including_internal.iter().cloned(),
                    &summary.session_id,
                    &parent_turn_ids,
                );
                let hidden_session_id_set = hidden_session_ids.iter().collect::<HashSet<_>>();
                let linked_parent_turn_ids = metadata_including_internal
                    .iter()
                    .filter(|metadata| hidden_session_id_set.contains(&metadata.session_id))
                    .filter_map(|metadata| {
                        metadata
                            .relationship
                            .as_ref()
                            .and_then(|relationship| relationship.parent_dialog_turn_id.clone())
                    })
                    .collect::<HashSet<_>>();

                let mut selected_parent_turns =
                    filter_turns_for_window(&parent_turns, cutoff_ms, now_ms);
                let mut transcript_turns = selected_parent_turns.clone();
                let transcript_turn_ids = transcript_turns
                    .iter()
                    .map(|turn| turn.turn_id.clone())
                    .collect::<HashSet<_>>();
                transcript_turns.extend(
                    parent_turns
                        .iter()
                        .filter(|turn| linked_parent_turn_ids.contains(&turn.turn_id))
                        .filter(|turn| !transcript_turn_ids.contains(&turn.turn_id))
                        .cloned(),
                );
                let mut selected_turns = selected_parent_turns.clone();
                for hidden_session_id in hidden_session_ids {
                    match coordinator
                        .load_visible_persisted_session_turns(ws_path, &hidden_session_id)
                        .await
                    {
                        Ok(turns) => {
                            selected_turns
                                .extend(filter_turns_for_window(&turns, cutoff_ms, now_ms));
                        }
                        Err(error) => warn!(
                            "Skipping hidden subagent session {} for parent {}: {}",
                            hidden_session_id, summary.session_id, error
                        ),
                    }
                }

                if selected_turns.is_empty() {
                    continue;
                }

                selected_parent_turns.sort_by_key(|turn| turn.start_time);
                transcript_turns.sort_by_key(|turn| turn.start_time);
                selected_turns.sort_by_key(|turn| turn.start_time);
                let messages = rebuild_messages_from_turns(&transcript_turns);
                let message_count = selected_turns
                    .iter()
                    .map(estimate_turn_message_count)
                    .sum::<usize>();
                let duration_millis = compute_active_duration_millis(
                    &summary.session_id,
                    workspace_path,
                    &selected_turns,
                    now_ms,
                );
                let duration_minutes = duration_millis / 60_000;
                let first_activity_ms = selected_turns
                    .iter()
                    .map(|turn| turn.start_time.max(cutoff_ms))
                    .min()
                    .unwrap_or(cutoff_ms);
                let last_activity_ms = selected_turns
                    .iter()
                    .map(|turn| effective_turn_end_ms(turn, now_ms).min(now_ms))
                    .max()
                    .unwrap_or(first_activity_ms);

                let mut transcript = Self::build_transcript(
                    &summary.session_id,
                    &session,
                    &messages,
                    selected_turns.len(),
                    message_count,
                    duration_minutes,
                    unix_ms_to_iso(first_activity_ms),
                );
                transcript.workspace_path = Some(workspace_path.to_string_lossy().to_string());
                transcript.last_activity_unix_secs = last_activity_ms / 1000;

                update_date_bounds(&mut base_stats, first_activity_ms, last_activity_ms);
                Self::accumulate_stats(
                    &mut base_stats,
                    &session,
                    &selected_parent_turns,
                    &selected_turns,
                    message_count,
                    duration_millis,
                );
                for path in
                    accumulate_code_stats(&mut base_stats, &target.workspace_id, &selected_turns)
                        .await
                {
                    modified_files.insert((target.workspace_id.clone(), path));
                }
                transcripts.push(transcript);
            }
        }

        base_stats.total_sessions = transcripts.len() as u32;
        base_stats.total_duration_minutes = base_stats.total_duration_millis / 60_000;
        base_stats.total_files_modified = modified_files.len();
        for (_, path) in &modified_files {
            if let Some(language) = language_name_for_path(path) {
                *base_stats
                    .languages_by_files
                    .entry(language.to_string())
                    .or_insert(0) += 1;
            }
        }

        // Compute response time buckets from raw intervals
        if !base_stats.response_times_raw.is_empty() {
            base_stats.response_time_buckets =
                bucket_response_times(&base_stats.response_times_raw);
            let (median, avg) = compute_response_time_stats(&base_stats.response_times_raw);
            base_stats.median_response_time_secs = Some(median);
            base_stats.avg_response_time_secs = Some(avg);
        }

        debug!(
            "Collected {} sessions with {} total messages",
            transcripts.len(),
            base_stats.total_messages
        );

        Ok((base_stats, transcripts))
    }

    fn build_transcript(
        session_id: &str,
        session: &crate::agentic::core::Session,
        messages: &[Message],
        turn_count: usize,
        message_count: usize,
        duration_minutes: u64,
        created_at: String,
    ) -> SessionTranscript {
        let mut all_parts: Vec<String> = Vec::new();
        let mut tool_names: Vec<String> = Vec::new();
        let mut has_errors = false;

        for msg in messages {
            match &msg.content {
                MessageContent::Text(text) => {
                    let role_tag = match msg.role {
                        MessageRole::User => "[User]",
                        MessageRole::Assistant => "[Assistant]",
                        MessageRole::System => continue,
                        MessageRole::Tool => continue,
                    };
                    let truncated = truncate_text(text, MAX_TEXT_PER_MESSAGE);
                    all_parts.push(format!("{}: {}", role_tag, truncated));
                }
                MessageContent::Mixed {
                    text, tool_calls, ..
                } => {
                    if !text.is_empty() {
                        let truncated = truncate_text(text, MAX_TEXT_PER_MESSAGE);
                        all_parts.push(format!("[Assistant]: {}", truncated));
                    }
                    for tc in tool_calls {
                        let tool_name = effective_tool_call_name(tc);
                        if !tool_names.contains(&tool_name) {
                            tool_names.push(tool_name.clone());
                        }
                        all_parts.push(format!("[Tool: {}]", tool_name));
                    }
                }
                MessageContent::ToolResult {
                    tool_name,
                    effective_tool_name,
                    is_error,
                    ..
                } => {
                    if *is_error {
                        has_errors = true;
                        all_parts.push(format!(
                            "[Tool Error: {}]",
                            effective_tool_result_name(tool_name, effective_tool_name)
                        ));
                    }
                }
                MessageContent::Multimodal { text, .. } => {
                    if !text.is_empty() {
                        let truncated = truncate_text(text, MAX_TEXT_PER_MESSAGE);
                        all_parts.push(format!("[User]: {} [+images]", truncated));
                    }
                }
            }
        }

        let transcript = smart_truncate_parts(&all_parts, MAX_TRANSCRIPT_CHARS, TAIL_RESERVE_CHARS);

        SessionTranscript {
            session_id: session_id.to_string(),
            agent_type: session.agent_type.clone(),
            session_name: session.session_name.clone(),
            workspace_path: None,
            last_activity_unix_secs: 0,
            duration_minutes,
            message_count: message_count as u32,
            turn_count: turn_count as u32,
            created_at,
            transcript,
            tool_names,
            has_errors,
        }
    }

    fn accumulate_stats(
        base_stats: &mut BaseStats,
        session: &crate::agentic::core::Session,
        parent_turns: &[DialogTurnData],
        all_turns: &[DialogTurnData],
        message_count: usize,
        duration_millis: u64,
    ) {
        base_stats.total_messages += message_count as u32;
        base_stats.total_turns += all_turns.len() as u32;
        base_stats.total_duration_millis += duration_millis;
        accumulate_session_token_usage(&mut base_stats.session_usage, all_turns);

        *base_stats
            .agent_types
            .entry(session.agent_type.clone())
            .or_insert(0) += 1;

        for turn in all_turns {
            for round in &turn.model_rounds {
                for tool in &round.tool_items {
                    *base_stats
                        .tool_usage
                        .entry(tool.effective_name().to_string())
                        .or_insert(0) += 1;
                    if tool
                        .tool_result
                        .as_ref()
                        .is_some_and(|result| !result.success)
                    {
                        *base_stats
                            .tool_errors
                            .entry(tool.effective_name().to_string())
                            .or_insert(0) += 1;
                    }
                }
            }
        }

        let mut previous_end_ms = None;
        for turn in parent_turns {
            let dt = DateTime::<Local>::from(UNIX_EPOCH + Duration::from_millis(turn.start_time));
            let hour = dt.format("%H").to_string().parse::<u32>().unwrap_or(0);
            *base_stats.hour_counts.entry(hour).or_insert(0) += 1;

            if let Some(previous_end_ms) = previous_end_ms {
                let response_ms = turn.start_time.saturating_sub(previous_end_ms);
                let response_secs = response_ms / 1000;
                if (2..=ACTIVITY_GAP_THRESHOLD_SECS).contains(&response_secs) {
                    base_stats.response_times_raw.push(response_secs as f64);
                }
            }
            previous_end_ms = Some(effective_turn_end_ms(turn, turn.start_time));
        }
    }

    /// Stage 3: Aggregate facets into InsightsAggregate
    pub fn aggregate(base_stats: &BaseStats, facets: &[SessionFacet]) -> InsightsAggregate {
        let mut goals: HashMap<String, u32> = HashMap::new();
        let mut outcomes: HashMap<String, u32> = HashMap::new();
        let mut satisfaction: HashMap<String, u32> = HashMap::new();
        let mut friction: HashMap<String, u32> = HashMap::new();
        let mut success: HashMap<String, u32> = HashMap::new();
        let mut session_types: HashMap<String, u32> = HashMap::new();
        let mut session_summaries = Vec::new();
        let mut friction_details = Vec::new();
        let mut user_instructions = Vec::new();

        for facet in facets {
            for (k, v) in &facet.goal_categories {
                *goals.entry(k.clone()).or_insert(0) += v;
            }
            *outcomes.entry(facet.outcome.clone()).or_insert(0) += 1;
            for (k, v) in &facet.user_satisfaction_counts {
                *satisfaction.entry(k.clone()).or_insert(0) += v;
            }
            for (k, v) in &facet.friction_counts {
                *friction.entry(k.clone()).or_insert(0) += v;
            }
            if !facet.primary_success.is_empty() && facet.primary_success != "none" {
                *success.entry(facet.primary_success.clone()).or_insert(0) += 1;
            }
            *session_types.entry(facet.session_type.clone()).or_insert(0) += 1;

            if !facet.brief_summary.is_empty() {
                session_summaries.push(facet.brief_summary.clone());
            }
            if !facet.friction_detail.is_empty() {
                friction_details.push(facet.friction_detail.clone());
            }
            for instr in &facet.user_instructions {
                if !user_instructions.contains(instr) {
                    user_instructions.push(instr.clone());
                }
            }
        }

        let mut top_tools: Vec<(String, u32)> = base_stats
            .tool_usage
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        top_tools.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        top_tools.truncate(15);

        let mut top_goals: Vec<(String, u32)> =
            goals.iter().map(|(k, v)| (k.clone(), *v)).collect();
        top_goals.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        top_goals.truncate(10);

        let hours = base_stats.total_duration_millis as f32 / 3_600_000.0;
        let date_range = DateRange {
            start: base_stats.first_session_at.clone().unwrap_or_default(),
            end: base_stats.last_session_at.clone().unwrap_or_default(),
        };

        let days_covered = compute_days_covered(&date_range);
        let msgs_per_day = if days_covered > 0 {
            base_stats.total_messages as f32 / days_covered as f32
        } else {
            base_stats.total_messages as f32
        };

        let languages = base_stats.languages_by_files.clone();

        InsightsAggregate {
            sessions: base_stats.total_sessions,
            analyzed: facets.len() as u32,
            date_range,
            messages: base_stats.total_messages,
            hours,
            top_tools,
            top_goals,
            outcomes,
            satisfaction,
            friction,
            success,
            languages,
            session_summaries,
            friction_details,
            user_instructions,
            session_types,
            tool_errors: base_stats.tool_errors.clone(),
            hour_counts: base_stats.hour_counts.clone(),
            agent_types: base_stats.agent_types.clone(),
            msgs_per_day,
            response_time_buckets: base_stats.response_time_buckets.clone(),
            median_response_time_secs: base_stats.median_response_time_secs,
            avg_response_time_secs: base_stats.avg_response_time_secs,
            total_lines_added: base_stats.total_lines_added,
            total_lines_removed: base_stats.total_lines_removed,
            total_files_modified: base_stats.total_files_modified,
            session_usage: base_stats.session_usage.clone(),
        }
    }
}

fn accumulate_session_token_usage(aggregate: &mut InsightsSessionUsage, turns: &[DialogTurnData]) {
    aggregate.total_turns = aggregate.total_turns.saturating_add(turns.len() as u32);
    for turn in turns {
        let Some(usage) = turn.token_usage.as_ref() else {
            continue;
        };
        aggregate.input_tokens = aggregate.input_tokens.saturating_add(usage.input_tokens);
        aggregate.total_tokens = aggregate.total_tokens.saturating_add(usage.total_tokens);
        aggregate.turns_with_usage = aggregate.turns_with_usage.saturating_add(1);
        if let Some(output_tokens) = usage.output_tokens {
            aggregate.output_tokens = aggregate.output_tokens.saturating_add(output_tokens);
            aggregate.output_reported_turns = aggregate.output_reported_turns.saturating_add(1);
        }
    }
}

fn filter_turns_for_window(
    turns: &[DialogTurnData],
    cutoff_ms: u64,
    now_ms: u64,
) -> Vec<DialogTurnData> {
    turns
        .iter()
        .filter(|turn| {
            turn.kind.is_model_visible()
                && turn.start_time <= now_ms
                && effective_turn_end_ms(turn, now_ms) >= cutoff_ms
        })
        .cloned()
        .collect()
}

fn recent_hidden_parent_session_ids(
    metadata: &[SessionMetadata],
    cutoff_ms: u64,
) -> HashSet<String> {
    let metadata_by_id = metadata
        .iter()
        .map(|entry| (entry.session_id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let mut recent_parent_ids = HashSet::new();

    for entry in metadata
        .iter()
        .filter(|entry| entry.should_hide_from_user_lists() && entry.last_active_at >= cutoff_ms)
    {
        let mut current = entry;
        let mut visited = HashSet::new();
        while let Some(parent_session_id) = current
            .relationship
            .as_ref()
            .and_then(|relationship| relationship.parent_session_id.as_deref())
        {
            if !visited.insert(parent_session_id) {
                break;
            }
            recent_parent_ids.insert(parent_session_id.to_string());
            let Some(parent) = metadata_by_id.get(parent_session_id) else {
                break;
            };
            current = parent;
        }
    }

    recent_parent_ids
}

fn effective_turn_end_ms(turn: &DialogTurnData, fallback_end_ms: u64) -> u64 {
    let mut end_ms = turn
        .end_time
        .into_iter()
        .chain(
            turn.duration_ms
                .map(|duration| turn.start_time.saturating_add(duration)),
        )
        .max()
        .unwrap_or_else(|| fallback_end_ms.max(turn.start_time));

    for round in &turn.model_rounds {
        end_ms = end_ms.max(
            round
                .end_time
                .into_iter()
                .chain(
                    round
                        .duration_ms
                        .map(|duration| round.start_time.saturating_add(duration)),
                )
                .max()
                .unwrap_or(round.start_time),
        );
        for tool in &round.tool_items {
            end_ms = end_ms.max(
                tool.end_time
                    .into_iter()
                    .chain(
                        tool.duration_ms
                            .map(|duration| tool.start_time.saturating_add(duration)),
                    )
                    .max()
                    .unwrap_or(tool.start_time),
            );
        }
    }

    end_ms
}

fn compute_active_duration_millis(
    session_id: &str,
    workspace_path: &Path,
    turns: &[DialogTurnData],
    now_ms: u64,
) -> u64 {
    let report = build_session_usage_report_from_turns(
        SessionUsageReportRequest {
            session_id: session_id.to_string(),
            workspace_id: None,
            workspace_path: Some(workspace_path.to_string_lossy().to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
            include_hidden_subagents: false,
        },
        turns,
        &[],
        i64::try_from(now_ms).unwrap_or(i64::MAX),
    );
    report.time.active_turn_ms.unwrap_or(0)
}

fn update_date_bounds(base_stats: &mut BaseStats, first_activity_ms: u64, last_activity_ms: u64) {
    let first = unix_ms_to_iso(first_activity_ms);
    let last = unix_ms_to_iso(last_activity_ms);
    if base_stats
        .first_session_at
        .as_ref()
        .is_none_or(|existing| first.as_str() < existing.as_str())
    {
        base_stats.first_session_at = Some(first);
    }
    if base_stats
        .last_session_at
        .as_ref()
        .is_none_or(|existing| last.as_str() > existing.as_str())
    {
        base_stats.last_session_at = Some(last);
    }
}

/// Rebuild `Vec<Message>` from turn data, including tool call and tool result information
/// needed by `build_transcript` and `accumulate_stats`.
/// Preserves timestamps from turn data and marks cancelled turns with `[Cancelled]`.
fn rebuild_messages_from_turns(turns: &[DialogTurnData]) -> Vec<Message> {
    let mut messages = Vec::new();

    for turn in turns {
        if !turn.kind.is_model_visible() {
            continue;
        }

        let user_ts = UNIX_EPOCH + Duration::from_millis(turn.start_time);
        let mut user_msg = Message::user(turn.user_message.content.clone());
        user_msg.timestamp = user_ts;
        messages.push(user_msg);

        for (round_idx, round) in turn.model_rounds.iter().enumerate() {
            let assistant_text = round
                .text_items
                .iter()
                .map(|item| item.content.clone())
                .filter(|c| !c.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");

            let tool_calls: Vec<ToolCall> = round
                .tool_items
                .iter()
                .map(|ti| ToolCall {
                    tool_id: ti.tool_call.id.clone(),
                    tool_name: ti.tool_name.clone(),
                    arguments: ti.tool_call.input.clone(),
                    raw_arguments: None,
                    is_error: false,
                    parse_error: None,
                    recovered_from_truncation: false,
                    repair_kind: Default::default(),
                })
                .collect();

            let round_ts = if let Some(end_time) = turn.end_time {
                let start = turn.start_time;
                let total_rounds = turn.model_rounds.len().max(1) as u64;
                let step = (end_time.saturating_sub(start)) / (total_rounds + 1);
                UNIX_EPOCH + Duration::from_millis(start + step * (round_idx as u64 + 1))
            } else {
                UNIX_EPOCH + Duration::from_millis(turn.start_time + (round_idx as u64 + 1) * 1000)
            };

            if !tool_calls.is_empty() {
                let mut msg = Message::assistant_with_tools(assistant_text.clone(), tool_calls);
                msg.timestamp = round_ts;
                messages.push(msg);
            } else if !assistant_text.trim().is_empty() {
                let mut msg = Message::assistant(assistant_text);
                msg.timestamp = round_ts;
                messages.push(msg);
            }

            for ti in &round.tool_items {
                if let Some(result_data) = &ti.tool_result {
                    let effective_tool_name = ti.effective_name();
                    let mut msg = Message::tool_result(ToolResult {
                        tool_id: ti.tool_call.id.clone(),
                        tool_name: ti.tool_name.clone(),
                        effective_tool_name: (effective_tool_name != ti.tool_name)
                            .then(|| effective_tool_name.to_string()),
                        result: result_data.result.clone(),
                        result_for_assistant: None,
                        is_error: !result_data.success,
                        duration_ms: result_data.duration_ms,
                        image_attachments: None,
                    });
                    msg.timestamp = round_ts;
                    messages.push(msg);
                }
            }
        }

        if turn.status == TurnStatus::Cancelled {
            let cancel_ts = turn
                .end_time
                .map(|t| UNIX_EPOCH + Duration::from_millis(t))
                .unwrap_or(user_ts);
            let mut cancel_msg = Message::assistant("[Cancelled by user]".to_string());
            cancel_msg.timestamp = cancel_ts;
            messages.push(cancel_msg);
        }
    }

    messages
}

/// Keep head + tail of transcript parts, inserting an omission marker in the middle
/// when total length exceeds `max_chars`. This preserves the beginning (context/goals)
/// and end (final outcome) of a session.
fn smart_truncate_parts(parts: &[String], max_chars: usize, tail_reserve: usize) -> String {
    let total: usize = parts.iter().map(|p| p.len() + 1).sum();
    if total <= max_chars {
        return parts.join("\n");
    }

    let head_budget = max_chars.saturating_sub(tail_reserve);
    let mut head_parts = Vec::new();
    let mut head_used = 0;
    let mut head_end_idx = 0;

    for (i, part) in parts.iter().enumerate() {
        let cost = part.len() + 1;
        if head_used + cost > head_budget {
            break;
        }
        head_parts.push(part.as_str());
        head_used += cost;
        head_end_idx = i + 1;
    }

    let mut tail_parts = Vec::new();
    let mut tail_used = 0;
    let mut tail_start_idx = parts.len();

    for (i, part) in parts.iter().enumerate().rev() {
        if i < head_end_idx {
            break;
        }
        let cost = part.len() + 1;
        if tail_used + cost > tail_reserve {
            break;
        }
        tail_parts.push(part.as_str());
        tail_used += cost;
        tail_start_idx = i;
    }
    tail_parts.reverse();

    let omitted = tail_start_idx.saturating_sub(head_end_idx);

    let mut result = head_parts.join("\n");
    if omitted > 0 {
        result.push_str(&format!("\n\n[... {} messages omitted ...]\n\n", omitted));
    }
    result.push_str(&tail_parts.join("\n"));
    result
}

fn truncate_text(text: &str, max_len: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= max_len {
        trimmed.to_string()
    } else {
        let mut end = max_len.min(trimmed.len());
        while end > 0 && !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...", &trimmed[..end])
    }
}

fn system_time_to_unix_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn unix_ms_to_iso(timestamp_ms: u64) -> String {
    DateTime::<Utc>::from(UNIX_EPOCH + Duration::from_millis(timestamp_ms)).to_rfc3339()
}

fn bucket_response_times(raw: &[f64]) -> HashMap<String, u32> {
    let buckets: &[(&str, f64, f64)] = &[
        ("2-10s", 2.0, 10.0),
        ("10-30s", 10.0, 30.0),
        ("30s-1m", 30.0, 60.0),
        ("1-2m", 60.0, 120.0),
        ("2-5m", 120.0, 300.0),
        ("5-15m", 300.0, 900.0),
        (">15m", 900.0, f64::MAX),
    ];

    let mut result: HashMap<String, u32> = HashMap::new();
    for &val in raw {
        for &(label, lo, hi) in buckets {
            if val >= lo && val < hi {
                *result.entry(label.to_string()).or_insert(0) += 1;
                break;
            }
        }
    }
    result
}

fn compute_response_time_stats(raw: &[f64]) -> (f64, f64) {
    if raw.is_empty() {
        return (0.0, 0.0);
    }

    let avg = raw.iter().sum::<f64>() / raw.len() as f64;

    let mut sorted = raw.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = if sorted.len().is_multiple_of(2) {
        let mid = sorted.len() / 2;
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[sorted.len() / 2]
    };

    (median, avg)
}

fn compute_days_covered(range: &DateRange) -> u32 {
    let parse = |s: &str| -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.with_timezone(&Utc))
    };

    match (parse(&range.start), parse(&range.end)) {
        (Some(start), Some(end)) => {
            end.date_naive()
                .signed_duration_since(start.date_naive())
                .num_days()
                .unsigned_abs() as u32
                + 1
        }
        _ => 1,
    }
}

/// Extract code change statistics from persistent turn data.
///
/// For Edit tool results: uses `old_end_line - start_line + 1` as lines removed
/// and `new_end_line - start_line + 1` as lines added, falling back to counting
/// newlines in `old_string`/`new_string`.
///
/// For Write tool: uses `lines_written`, falling back to counting newlines in
/// the tool input for older persisted sessions.
///
/// Per session, each distinct file path touched by Edit/Write contributes once to `languages_by_files`
/// according to [`language_name_for_path`].
async fn accumulate_code_stats(
    base_stats: &mut BaseStats,
    workspace_id: &str,
    turns: &[DialogTurnData],
) -> HashSet<String> {
    let Some(snapshot_manager) = get_snapshot_manager_for_workspace(workspace_id) else {
        return accumulate_code_stats_from_turns(base_stats, turns);
    };

    let mut turn_indexes_by_session: HashMap<String, HashSet<usize>> = HashMap::new();
    for turn in turns {
        turn_indexes_by_session
            .entry(turn.session_id.clone())
            .or_default()
            .insert(turn.turn_index);
    }

    let mut modified_files = HashSet::new();
    let mut fallback_session_ids = HashSet::new();
    for (session_id, turn_indexes) in &turn_indexes_by_session {
        match snapshot_manager.get_session(session_id).await {
            Ok(snapshot) => {
                for operation in snapshot
                    .operations
                    .into_iter()
                    .filter(|operation| turn_indexes.contains(&operation.turn_index))
                {
                    base_stats.total_lines_added += operation.diff_summary.lines_added;
                    base_stats.total_lines_removed += operation.diff_summary.lines_removed;
                    modified_files.insert(operation.file_path.to_string_lossy().to_string());
                }
            }
            Err(_) => {
                fallback_session_ids.insert(session_id.clone());
            }
        }
    }

    if !fallback_session_ids.is_empty() {
        let fallback_turns = turns
            .iter()
            .filter(|turn| fallback_session_ids.contains(&turn.session_id))
            .cloned()
            .collect::<Vec<_>>();
        modified_files.extend(accumulate_code_stats_from_turns(
            base_stats,
            &fallback_turns,
        ));
    }

    modified_files
}

fn accumulate_code_stats_from_turns(
    base_stats: &mut BaseStats,
    turns: &[DialogTurnData],
) -> HashSet<String> {
    let mut modified_files: HashSet<String> = HashSet::new();

    for turn in turns {
        for round in &turn.model_rounds {
            for ti in &round.tool_items {
                let Some(ref result_data) = ti.tool_result else {
                    continue;
                };
                if !result_data.success {
                    continue;
                }

                match ti.effective_name() {
                    "Edit" => {
                        let result = &result_data.result;

                        if let Some(fp) = result.get("file_path").and_then(|v| v.as_str()) {
                            modified_files.insert(fp.to_string());
                        }

                        let (lines_removed, lines_added) =
                            if let (Some(start), Some(old_end), Some(new_end)) = (
                                result.get("start_line").and_then(|v| v.as_u64()),
                                result.get("old_end_line").and_then(|v| v.as_u64()),
                                result.get("new_end_line").and_then(|v| v.as_u64()),
                            ) {
                                let removed = old_end.saturating_sub(start) + 1;
                                let added = new_end.saturating_sub(start) + 1;
                                (removed as usize, added as usize)
                            } else {
                                let old_lines = result
                                    .get("old_string")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.lines().count().max(1))
                                    .unwrap_or(0);
                                let new_lines = result
                                    .get("new_string")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.lines().count().max(1))
                                    .unwrap_or(0);
                                (old_lines, new_lines)
                            };

                        base_stats.total_lines_removed += lines_removed;
                        base_stats.total_lines_added += lines_added;
                    }
                    "Write" => {
                        let result = &result_data.result;

                        if let Some(fp) = result.get("file_path").and_then(|v| v.as_str()) {
                            modified_files.insert(fp.to_string());
                        }

                        if let Some(lines_written) =
                            result.get("lines_written").and_then(|v| v.as_u64())
                        {
                            base_stats.total_lines_added += lines_written as usize;
                        } else if let Some(content) =
                            ti.effective_input().get("content").and_then(|v| v.as_str())
                        {
                            base_stats.total_lines_added += content.lines().count().max(1);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    modified_files
}

/// Infer a language label from a file path (extension or well-known filename).
fn language_name_for_path(path: &str) -> Option<&'static str> {
    let p = Path::new(path);
    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
        match name.to_ascii_lowercase().as_str() {
            "dockerfile" | "containerfile" => return Some("Dockerfile"),
            "makefile" | "gnumakefile" => return Some("Makefile"),
            "cargo.toml" | "cargo.lock" => return Some("Rust"),
            _ => {}
        }
    }
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "ts" | "tsx" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" | "pyi" | "pyw" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "cs" => "C#",
        "cpp" | "cc" | "cxx" | "hpp" => "C/C++",
        "c" | "h" => "C/C++",
        "rb" => "Ruby",
        "php" => "PHP",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "md" | "mdx" => "Markdown",
        "json" | "jsonc" => "JSON",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "xml" => "XML",
        "html" | "htm" => "HTML",
        "css" | "scss" | "sass" | "less" => "CSS",
        "sh" | "bash" | "zsh" | "fish" => "Shell",
        "ps1" => "PowerShell",
        "sql" => "SQL",
        "gradle" => "Gradle",
        "properties" => "Properties",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::session::{
        DialogTurnKind, DialogTurnTokenUsageData, ModelRoundData, SessionKind, SessionRelationship,
        SessionRelationshipKind, TextItemData, UserMessageData,
    };

    fn test_turn(
        turn_id: &str,
        turn_index: usize,
        kind: DialogTurnKind,
        start_time: u64,
        end_time: u64,
    ) -> DialogTurnData {
        let mut turn = DialogTurnData::new_with_kind(
            kind,
            turn_id.to_string(),
            turn_index,
            "session-1".to_string(),
            Some("Standard".to_string()),
            UserMessageData {
                id: format!("user-{turn_id}"),
                content: format!("message-{turn_id}"),
                timestamp: start_time,
                metadata: None,
            },
        );
        turn.timestamp = start_time;
        turn.start_time = start_time;
        turn.end_time = Some(end_time);
        turn.duration_ms = Some(end_time.saturating_sub(start_time));
        turn.status = TurnStatus::Completed;
        turn
    }

    #[test]
    fn window_filter_uses_turn_activity_and_excludes_local_commands() {
        let old = test_turn("old", 0, DialogTurnKind::UserDialog, 1_000, 2_000);
        let recent = test_turn("recent", 1, DialogTurnKind::UserDialog, 9_000, 10_000);
        let local = test_turn("local", 2, DialogTurnKind::LocalCommand, 9_500, 10_000);

        let selected = filter_turns_for_window(&[old, recent, local], 8_000, 11_000);

        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].turn_id, "recent");
    }

    #[test]
    fn active_duration_uses_persisted_turn_span() {
        let turn = test_turn("long", 0, DialogTurnKind::UserDialog, 1_000, 61_000);

        let duration =
            compute_active_duration_millis("session-1", Path::new("/workspace"), &[turn], 70_000);

        assert_eq!(duration, 60_000);
    }

    #[test]
    fn message_count_matches_session_metadata_contract() {
        let mut turn = test_turn("message-count", 0, DialogTurnKind::UserDialog, 1_000, 2_000);
        turn.model_rounds.push(ModelRoundData {
            id: "round-1".to_string(),
            turn_id: turn.turn_id.clone(),
            round_index: 0,
            round_group_id: None,
            timestamp: 1_100,
            text_items: vec![TextItemData {
                id: "text-1".to_string(),
                content: "assistant response".to_string(),
                is_streaming: false,
                timestamp: 1_200,
                is_markdown: true,
                order_index: Some(0),
                is_subagent_item: None,
                parent_task_tool_id: None,
                subagent_session_id: None,
                status: Some("completed".to_string()),
                attempt_id: None,
                attempt_index: None,
            }],
            tool_items: vec![],
            thinking_items: vec![],
            start_time: 1_100,
            end_time: Some(1_900),
            duration_ms: Some(800),
            provider_id: None,
            model_config_id: None,
            effective_model_name: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            attempt_count: None,
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        });

        assert_eq!(estimate_turn_message_count(&turn), 2);
        assert_eq!(rebuild_messages_from_turns(&[turn]).len(), 2);
    }

    #[test]
    fn session_token_usage_sums_included_turns_and_tracks_coverage() {
        let mut first = test_turn("usage-1", 0, DialogTurnKind::UserDialog, 1_000, 2_000);
        first.token_usage = Some(DialogTurnTokenUsageData {
            input_tokens: 1_200,
            output_tokens: Some(300),
            total_tokens: 1_500,
            timestamp: 2_000,
        });
        let mut second = test_turn("usage-2", 1, DialogTurnKind::UserDialog, 3_000, 4_000);
        second.token_usage = Some(DialogTurnTokenUsageData {
            input_tokens: 800,
            output_tokens: None,
            total_tokens: 900,
            timestamp: 4_000,
        });
        let missing = test_turn("usage-3", 2, DialogTurnKind::UserDialog, 5_000, 6_000);
        let mut usage = InsightsSessionUsage::default();

        accumulate_session_token_usage(&mut usage, &[first, second, missing]);

        assert_eq!(
            usage,
            InsightsSessionUsage {
                input_tokens: 2_000,
                output_tokens: 300,
                total_tokens: 2_400,
                turns_with_usage: 2,
                output_reported_turns: 1,
                total_turns: 3,
            }
        );
    }

    #[test]
    fn date_bounds_track_activity_and_days_are_inclusive() {
        let mut stats = BaseStats::default();
        update_date_bounds(&mut stats, 86_400_000, 259_200_000);
        let range = DateRange {
            start: stats.first_session_at.expect("first activity"),
            end: stats.last_session_at.expect("last activity"),
        };

        assert_eq!(compute_days_covered(&range), 3);
    }

    #[test]
    fn workspace_scoped_session_identity_does_not_collapse_equal_ids() {
        let mut seen = HashSet::new();
        assert!(seen.insert((PathBuf::from("workspace-a"), "same-id".to_string())));
        assert!(seen.insert((PathBuf::from("workspace-b"), "same-id".to_string())));
    }

    #[test]
    fn recent_hidden_subagent_keeps_its_parent_session_in_scope() {
        let mut parent = SessionMetadata::new(
            "parent".to_string(),
            "Parent".to_string(),
            "Standard".to_string(),
            "model".to_string(),
        );
        parent.last_active_at = 1_000;

        let mut child = SessionMetadata::new(
            "child".to_string(),
            "Child".to_string(),
            "GeneralPurpose".to_string(),
            "model".to_string(),
        );
        child.session_kind = SessionKind::Subagent;
        child.last_active_at = 10_000;
        child.relationship = Some(SessionRelationship {
            kind: Some(SessionRelationshipKind::Subagent),
            parent_session_id: Some(parent.session_id.clone()),
            ..Default::default()
        });

        let recent_parents = recent_hidden_parent_session_ids(&[parent, child], 8_000);

        assert!(recent_parents.contains("parent"));
    }
}
