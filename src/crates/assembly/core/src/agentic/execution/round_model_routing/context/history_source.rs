//! Host-owned, visible-session history for rebuilding Router-only summaries.

use crate::agentic::core::strip_prompt_markup;
use crate::agentic::persistence::PersistenceManager;
use crate::service::session::{DialogTurnData, ModelRoundData, ToolItemIdentityExt};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::router_context::RouterEntryKind;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(in crate::agentic::execution) struct HistoryObservation {
    pub source_id: String,
    pub kind: RouterEntryKind,
    pub content: Value,
}

#[async_trait::async_trait]
pub(in crate::agentic::execution) trait RouterHistorySource:
    Send + Sync
{
    async fn observations(&self, turn_id: &str) -> OpenBitFunResult<Vec<HistoryObservation>>;
}

/// Paths belong to the execution host's resolved session store, never the controller.
pub(in crate::agentic::execution) struct PersistentRouterHistorySource {
    persistence: Arc<PersistenceManager>,
    workspace: PathBuf,
    session_id: String,
    // Legacy sessions may have no derived turn catalog. Cache storage positions
    // after a bounded-body scan, without retaining all historical message bodies.
    indices: Mutex<Option<HashMap<String, usize>>>,
}

impl PersistentRouterHistorySource {
    pub(in crate::agentic::execution) fn new(
        persistence: Arc<PersistenceManager>,
        workspace: PathBuf,
        session_id: String,
    ) -> Self {
        Self {
            persistence,
            workspace,
            session_id,
            indices: Mutex::new(None),
        }
    }

    async fn load_turn(&self, turn_id: &str) -> OpenBitFunResult<DialogTurnData> {
        if turn_id.is_empty() {
            return Err(OpenBitFunError::Validation(
                "Router historical turn ID is empty".into(),
            ));
        }
        if let Some(turn) = self
            .persistence
            .load_visible_session_turn(&self.workspace, &self.session_id, turn_id)
            .await?
        {
            self.validate_turn(&turn, turn_id, turn.turn_index)?;
            return Ok(turn);
        }

        let index = {
            let mut cached = self.indices.lock().await;
            if cached.is_none() {
                let mut indices = HashMap::new();
                let mut before = None;
                loop {
                    let (turns, next) = self
                        .persistence
                        .load_visible_history_turn(&self.workspace, &self.session_id, before)
                        .await?;
                    for turn in turns {
                        if turn.session_id != self.session_id || turn.turn_id.is_empty() {
                            return Err(OpenBitFunError::Validation(
                                "Router historical turn identity mismatch".into(),
                            ));
                        }
                        if indices.insert(turn.turn_id, turn.turn_index).is_some() {
                            return Err(OpenBitFunError::Validation(
                                "Router history contains duplicate turn IDs".into(),
                            ));
                        }
                    }
                    let Some(next) = next else { break };
                    if before.is_some_and(|previous| next >= previous) {
                        return Err(OpenBitFunError::Validation(
                            "Router history cursor did not advance".into(),
                        ));
                    }
                    before = Some(next);
                }
                *cached = Some(indices);
            }
            cached
                .as_ref()
                .and_then(|indices| indices.get(turn_id))
                .copied()
        }
        .ok_or_else(|| OpenBitFunError::NotFound("Router historical turn is unavailable".into()))?;

        let turn = self
            .persistence
            .load_dialog_turn(&self.workspace, &self.session_id, index)
            .await?
            .ok_or_else(|| {
                OpenBitFunError::NotFound("Router historical turn is unavailable".into())
            })?;
        self.validate_turn(&turn, turn_id, index)?;
        // A previously cached index must not bypass a newer undo boundary.
        if self
            .persistence
            .load_session_revert_state(&self.workspace, &self.session_id)
            .await?
            .is_some_and(|state| index >= state.boundary_turn)
        {
            return Err(OpenBitFunError::Validation(
                "Router historical turn is no longer visible".into(),
            ));
        }
        Ok(turn)
    }

    fn validate_turn(
        &self,
        turn: &DialogTurnData,
        turn_id: &str,
        index: usize,
    ) -> OpenBitFunResult<()> {
        if turn.session_id != self.session_id || turn.turn_id != turn_id || turn.turn_index != index
        {
            return Err(OpenBitFunError::Validation(
                "Router historical turn identity mismatch".into(),
            ));
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl RouterHistorySource for PersistentRouterHistorySource {
    async fn observations(&self, turn_id: &str) -> OpenBitFunResult<Vec<HistoryObservation>> {
        project_turn(&self.load_turn(turn_id).await?)
    }
}

fn effective_attempt(round: &ModelRoundData) -> Option<u32> {
    round
        .text_items
        .iter()
        .filter(|item| !item.is_subagent_item.unwrap_or(false))
        .filter_map(|item| item.attempt_index)
        .chain(
            round
                .thinking_items
                .iter()
                .filter(|item| !item.is_subagent_item.unwrap_or(false))
                .filter_map(|item| item.attempt_index),
        )
        .chain(
            round
                .tool_items
                .iter()
                .filter(|item| !item.is_subagent_item.unwrap_or(false))
                .filter_map(|item| item.attempt_index),
        )
        .max()
}

fn project_turn(turn: &DialogTurnData) -> OpenBitFunResult<Vec<HistoryObservation>> {
    if !turn.kind.is_model_visible() {
        return Ok(Vec::new());
    }
    let user_text = turn
        .user_message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("original_text"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| strip_prompt_markup(&turn.user_message.content));
    let mut observations = vec![HistoryObservation {
        source_id: json!([
            "router-history",
            turn.session_id,
            turn.turn_id,
            "user",
            turn.user_message.id
        ])
        .to_string(),
        kind: RouterEntryKind::UserUpdate,
        content: json!(user_text),
    }];
    let mut rounds = turn.model_rounds.iter().collect::<Vec<_>>();
    rounds.sort_by_key(|round| round.round_index);
    let mut round_ids = HashSet::new();
    for round in rounds {
        if round.turn_id != turn.turn_id || round.id.is_empty() || !round_ids.insert(&round.id) {
            return Err(OpenBitFunError::Validation(
                "Router historical round identity mismatch".into(),
            ));
        }
        let attempt = effective_attempt(round);
        let is_effective = |index| attempt.is_none_or(|effective| index == Some(effective));
        let text = round
            .text_items
            .iter()
            .filter(|item| {
                !item.is_subagent_item.unwrap_or(false) && is_effective(item.attempt_index)
            })
            .map(|item| item.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let reasoning = round
            .thinking_items
            .iter()
            .filter(|item| {
                !item.is_subagent_item.unwrap_or(false) && is_effective(item.attempt_index)
            })
            .map(|item| item.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut calls = Vec::new();
        let mut results = Vec::new();
        for tool in round.tool_items.iter().filter(|item| {
            !item.is_subagent_item.unwrap_or(false) && is_effective(item.attempt_index)
        }) {
            calls.push(json!({
                "tool_id": tool.tool_call.id,
                "tool_name": tool.effective_name(),
                "arguments": tool.effective_input(),
                "is_error": tool.tool_result.as_ref().is_some_and(|result| !result.success),
            }));
            if let Some(result) = &tool.tool_result {
                let mut status = Map::new();
                for key in [
                    "exit_code",
                    "success",
                    "timed_out",
                    "interrupted",
                    "session_id",
                    "file_path",
                    "path",
                    "start_line",
                    "end_line",
                    "total_lines",
                ] {
                    if let Some(value) = result.result.get(key).filter(|value| {
                        value.is_boolean() || value.is_number() || value.is_string()
                    }) {
                        status.insert(key.into(), value.clone());
                    }
                }
                results.push(json!({
                    "tool_id": tool.tool_call.id,
                    "tool_name": tool.effective_name(),
                    "result_for_assistant": result.result_for_assistant.as_ref().map(|text| json!(text)).unwrap_or_else(|| result.result.clone()),
                    "is_error": !result.success,
                    "status": status,
                }));
            }
        }
        if text.trim().is_empty() && reasoning.trim().is_empty() && calls.is_empty() {
            continue;
        }
        observations.push(HistoryObservation {
            source_id: json!([
                "router-history",
                turn.session_id,
                turn.turn_id,
                "round",
                round.id
            ])
            .to_string(),
            kind: RouterEntryKind::Round,
            content: json!({
                "round_id": round.id,
                "assistant": {"text": text, "reasoning_content": reasoning, "tool_calls": calls},
                "tool_results": results,
            }),
        });
    }
    Ok(observations)
}

#[cfg(test)]
mod tests;
