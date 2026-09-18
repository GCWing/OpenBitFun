use crate::service::session::ToolItemIdentityExt;
use openbitfun_runtime_ports::{GitPort, WorkspaceDiffFileStatus};
use openbitfun_services_core::filesystem::{FileSearchOptions, FileSearchResult, FileTreeNode};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use terminal_core::{
    CloseSessionRequest, CreateSessionRequest, ResizeRequest, SessionResponse, ShellType,
    TerminalApi,
};
use tokio::io::{AsyncBufReadExt, BufReader};

fn resolve_scoped_path(context: &PluginHostInstance, value: &str) -> Result<PathBuf, Failure> {
    let requested = PathBuf::from(value);
    let path = if requested.is_absolute() {
        requested
    } else {
        context.directory.join(requested)
    };
    let canonical =
        dunce::canonicalize(&path).map_err(|_| Failure::not_found("Path does not exist"))?;
    if !canonical.starts_with(&context.directory) {
        return Err(Failure::forbidden(
            "Path is outside the plugin instance workspace",
        ));
    }
    Ok(canonical)
}

fn relative_path(context: &PluginHostInstance, path: &Path) -> String {
    path.strip_prefix(&context.directory)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn session_value(
    context: &PluginHostInstance,
    metadata: &crate::service::session::SessionMetadata,
) -> Value {
    let project_id = context.project_id.clone();
    let mut value = json!({
        "id": metadata.session_id,
        "projectID": project_id,
        "directory": context.directory.to_string_lossy(),
        "title": metadata.session_name,
        "version": env!("CARGO_PKG_VERSION"),
        "time": {"created": metadata.created_at, "updated": metadata.last_active_at},
    });
    if let Some(parent_id) = metadata
        .relationship
        .as_ref()
        .and_then(|relationship| relationship.parent_session_id.as_ref())
    {
        value["parentID"] = json!(parent_id);
    }
    value
}

fn coordinator() -> Result<Arc<crate::agentic::coordination::ConversationCoordinator>, Failure> {
    crate::agentic::coordination::get_global_coordinator()
        .ok_or_else(|| Failure::unavailable("Session coordinator is not initialized"))
}

/// Session storage is owned by the plugin instance's workspace ID; the instance
/// directory is only the execution root handed to file and git routes.
async fn session_storage_root(context: &PluginHostInstance) -> Result<PathBuf, Failure> {
    use openbitfun_runtime_ports::SessionStorePort;
    crate::agentic::session::session_store_port::CoreSessionStorePort::default()
        .resolve_workspace_storage(&context.workspace_id)
        .await
        .map(|resolution| resolution.effective_storage_path)
        .map_err(|error| Failure::backend(error.to_string()))
}

async fn session_metadata(
    context: &PluginHostInstance,
    session_id: &str,
) -> Result<crate::service::session::SessionMetadata, Failure> {
    openbitfun_core_types::validate_session_id(session_id)
        .map_err(|error| Failure::bad_request(error.to_string()))?;
    let coordinator = coordinator()?;
    coordinator
        .get_session_manager()
        .load_session_metadata(&session_storage_root(context).await?, session_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?
        .ok_or_else(|| Failure::not_found("Session was not found in this workspace"))
}

async fn session_list(context: &PluginHostInstance) -> RouteResult {
    let coordinator = coordinator()?;
    let summaries = coordinator
        .list_sessions(&session_storage_root(context).await?)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let persistence = coordinator.get_session_manager().persistence_manager();
    let metadata = persistence
        .list_session_metadata(&session_storage_root(context).await?)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let values = metadata
        .into_iter()
        .filter(|item| {
            summaries
                .iter()
                .any(|summary| summary.session_id == item.session_id)
        })
        .map(|item| session_value(context, &item))
        .collect::<Vec<_>>();
    Ok(Value::Array(values))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionCreateBody {
    parent_id: Option<String>,
    title: Option<String>,
}

async fn session_create(context: &PluginHostInstance, body: &[u8]) -> RouteResult {
    let input: SessionCreateBody = body_as(body)?;
    let coordinator = coordinator()?;
    if input.parent_id.is_some() {
        return Err(Failure::bad_request(
            "parentID session creation is not supported by the OpenBitFun session owner",
        ));
    }
    let session = coordinator
        .create_session_with_workspace(
            None,
            input
                .title
                .unwrap_or_else(|| "OpenCode Plugin Session".to_string()),
            "Standard".to_string(),
            crate::agentic::core::SessionConfig {
                workspace_id: Some(context.workspace_id.clone()),
                workspace_path: Some(context.directory.to_string_lossy().into_owned()),
                project_workspace_path: Some(context.directory.to_string_lossy().into_owned()),
                ..Default::default()
            },
            context.directory.to_string_lossy().into_owned(),
        )
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let metadata = coordinator
        .get_session_manager()
        .load_session_metadata(&session_storage_root(context).await?, &session.session_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?
        .ok_or_else(|| Failure::backend("Created session metadata is unavailable"))?;
    Ok(session_value(context, &metadata))
}

async fn session_status(context: &PluginHostInstance) -> RouteResult {
    let coordinator = coordinator()?;
    let sessions = coordinator
        .list_sessions(&session_storage_root(context).await?)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let statuses = sessions
        .into_iter()
        .map(|summary| {
            let status = match summary.state {
                crate::agentic::core::SessionState::Processing { .. } => json!({"type": "busy"}),
                crate::agentic::core::SessionState::Error { error, .. } => {
                    json!({"type": "retry", "attempt": 0, "message": error, "next": 0})
                }
                crate::agentic::core::SessionState::Idle => json!({"type": "idle"}),
            };
            (summary.session_id, status)
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(Value::Object(statuses))
}

async fn session_get(context: &PluginHostInstance, session_id: &str) -> RouteResult {
    Ok(session_value(
        context,
        &session_metadata(context, session_id).await?,
    ))
}

async fn session_delete(context: &PluginHostInstance, session_id: &str) -> RouteResult {
    let coordinator = coordinator()?;
    session_metadata(context, session_id).await?;
    let _ = coordinator
        .cancel_active_turn_for_session(session_id, std::time::Duration::from_secs(2))
        .await;
    coordinator
        .delete_session(&session_storage_root(context).await?, session_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(json!(true))
}

#[derive(Deserialize)]
struct SessionUpdateBody {
    title: Option<String>,
}

async fn session_update(
    context: &PluginHostInstance,
    session_id: &str,
    body: &[u8],
) -> RouteResult {
    let input: SessionUpdateBody = body_as(body)?;
    let title = input
        .title
        .ok_or_else(|| Failure::bad_request("Only title updates are supported"))?;
    session_metadata(context, session_id).await?;
    let title = coordinator()?
        .update_session_title(session_id, &title)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let mut metadata = session_metadata(context, session_id).await?;
    metadata.session_name = title;
    Ok(session_value(context, &metadata))
}

async fn session_children(context: &PluginHostInstance, session_id: &str) -> RouteResult {
    session_metadata(context, session_id).await?;
    let persistence = coordinator()?.get_session_manager().persistence_manager();
    let metadata = persistence
        .list_session_metadata_including_internal(&session_storage_root(context).await?)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(Value::Array(
        metadata
            .into_iter()
            .filter(|item| {
                item.relationship
                    .as_ref()
                    .and_then(|r| r.parent_session_id.as_deref())
                    == Some(session_id)
            })
            .map(|item| session_value(context, &item))
            .collect(),
    ))
}

async fn session_todo(context: &PluginHostInstance, session_id: &str) -> RouteResult {
    Ok(session_metadata(context, session_id)
        .await?
        .todos
        .unwrap_or_else(|| json!([])))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SessionForkBody {
    message_id: Option<String>,
}

async fn session_fork(context: &PluginHostInstance, session_id: &str, body: &[u8]) -> RouteResult {
    let input: SessionForkBody = body_as(body)?;
    let result = crate::product_runtime::fork_session_for_plugin(
        context.workspace_id.clone(),
        session_id.to_string(),
        input.message_id,
    )
    .await
    .map_err(Failure::backend)?;
    let metadata = session_metadata(context, &result.session_id).await?;
    Ok(session_value(context, &metadata))
}

async fn session_abort(context: &PluginHostInstance, session_id: &str) -> RouteResult {
    session_metadata(context, session_id).await?;
    coordinator()?
        .cancel_active_turn_for_session(session_id, std::time::Duration::from_secs(2))
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(json!(true))
}

async fn session_diff(
    context: &PluginHostInstance,
    session_id: &str,
    query: &HashMap<String, Vec<String>>,
) -> RouteResult {
    session_metadata(context, session_id).await?;
    let Some(message_id) = query_first(query, "messageID") else {
        return Ok(json!([]));
    };
    let manager = crate::service::snapshot::open_snapshot_manager_for_view(&context.workspace_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let turns = coordinator()?
        .load_visible_persisted_session_turns(&session_storage_root(context).await?, session_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let turn = turns
        .iter()
        .find(|turn| turn.user_message.id == message_id)
        .ok_or_else(|| Failure::not_found("Message was not found in this session"))?;
    let files = manager
        .get_turn_files(session_id, turn.turn_index)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let max_turn_exclusive = Some(turn.turn_index + 1);
    let mut result = Vec::new();
    for file in files {
        let file_path = file.to_string_lossy();
        let diff = manager
            .get_file_diff_before(session_id, &file_path, None, max_turn_exclusive)
            .await
            .map_err(|error| Failure::backend(error.to_string()))?;
        let before = diff
            .get("original_content")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Failure::backend("Session diff did not contain string original content")
            })?;
        let after = diff
            .get("modified_content")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                Failure::backend("Session diff did not contain string modified content")
            })?;
        let stats = manager
            .get_session_file_diff_stats_before(session_id, &file_path, max_turn_exclusive)
            .await
            .map_err(|error| Failure::backend(error.to_string()))?;
        result.push(json!({"file": relative_path(context, &file), "before": before, "after": after, "additions": stats.lines_added, "deletions": stats.lines_removed}));
    }
    Ok(Value::Array(result))
}

struct MessageProjectionContext<'a> {
    instance: &'a PluginHostInstance,
    session: &'a crate::service::session::SessionMetadata,
    models: &'a [crate::service::config::AIModelConfig],
    catalog: &'a openbitfun_core_types::ProviderCatalog,
}

fn message_model_identity<'a>(
    context: &'a MessageProjectionContext<'_>,
    turn: &crate::service::session::DialogTurnData,
) -> (
    String,
    String,
    Option<&'a crate::service::config::AIModelConfig>,
) {
    let round = turn.model_rounds.last();
    let configured = round
        .and_then(|round| round.model_config_id.as_deref())
        .and_then(|id| context.models.iter().find(|model| model.id == id))
        .or_else(|| {
            context
                .models
                .iter()
                .find(|model| model.id == context.session.model_name)
        });
    let provider_id = round
        .and_then(|round| round.provider_id.clone())
        .or_else(|| configured.map(|model| model.provider.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    let model_id = round
        .and_then(|round| {
            round
                .model_config_id
                .clone()
                .or_else(|| round.effective_model_name.clone())
        })
        .or_else(|| configured.map(|model| model.id.clone()))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    (provider_id, model_id, configured)
}

fn user_message_projection(
    context: &MessageProjectionContext<'_>,
    turn: &crate::service::session::DialogTurnData,
) -> Value {
    let (provider_id, model_id, _) = message_model_identity(context, turn);
    json!({
        "info": {
            "id": turn.user_message.id,
            "sessionID": turn.session_id,
            "role": "user",
            "time": {"created": turn.user_message.timestamp},
            "agent": turn.agent_type.as_deref().unwrap_or(&context.session.agent_type),
            "model": {"providerID": provider_id, "modelID": model_id},
        },
        "parts": [{
            "id": format!("{}:text", turn.user_message.id),
            "sessionID": turn.session_id,
            "messageID": turn.user_message.id,
            "type": "text",
            "text": crate::agentic::core::strip_prompt_markup(&turn.user_message.content),
            "time": {"start": turn.user_message.timestamp},
        }],
    })
}

fn token_detail(turn: &crate::service::session::DialogTurnData, key: &str) -> u64 {
    turn.model_rounds
        .iter()
        .filter_map(|round| round.token_details.as_ref())
        .filter_map(|details| details.get(key))
        .filter_map(Value::as_u64)
        .sum()
}

fn assistant_cost(
    context: &MessageProjectionContext<'_>,
    configured: Option<&crate::service::config::AIModelConfig>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) -> f64 {
    let pricing = configured
        .and_then(|model| matching_catalog_model(context.catalog, model))
        .and_then(|model| model.pricing.as_ref());
    let input_price = price(pricing.and_then(|value| value.input.as_deref())).unwrap_or(0.0);
    let output_price = price(pricing.and_then(|value| value.output.as_deref())).unwrap_or(0.0);
    let cache_read_price =
        price(pricing.and_then(|value| value.cache_read.as_deref())).unwrap_or(0.0);
    let cache_write_price =
        price(pricing.and_then(|value| value.cache_write.as_deref())).unwrap_or(0.0);
    ((input as f64 * input_price)
        + (output as f64 * output_price)
        + (cache_read as f64 * cache_read_price)
        + (cache_write as f64 * cache_write_price))
        / 1_000_000.0
}

fn tool_part(
    session_id: &str,
    message_id: &str,
    item: &crate::service::session::ToolItemData,
) -> Value {
    let input = item.effective_input().clone();
    let tool = item.effective_name();
    let state = match item.tool_result.as_ref() {
        Some(result) if result.success => json!({
            "status": "completed",
            "input": input,
            "output": result.result_for_assistant.clone().unwrap_or_else(|| result.result.to_string()),
            "title": item.ai_intent.as_deref().unwrap_or(tool),
            "metadata": {},
            "time": {"start": item.start_time, "end": item.end_time.unwrap_or(item.start_time)},
        }),
        Some(result) => json!({
            "status": "error",
            "input": input,
            "error": result.error.clone().unwrap_or_else(|| result.result.to_string()),
            "metadata": {},
            "time": {"start": item.start_time, "end": item.end_time.unwrap_or(item.start_time)},
        }),
        None => json!({
            "status": "running",
            "input": input,
            "title": item.ai_intent.as_deref().unwrap_or(tool),
            "metadata": {},
            "time": {"start": item.start_time},
        }),
    };
    json!({
        "id": item.id,
        "sessionID": session_id,
        "messageID": message_id,
        "type": "tool",
        "callID": item.tool_call.id,
        "tool": tool,
        "state": state,
    })
}

fn assistant_parts(turn: &crate::service::session::DialogTurnData, message_id: &str) -> Vec<Value> {
    let mut parts = Vec::<(usize, usize, Value)>::new();
    let mut sequence = 0usize;
    for round in &turn.model_rounds {
        for item in &round.thinking_items {
            parts.push((
                item.order_index.unwrap_or(usize::MAX),
                sequence,
                json!({
                    "id": item.id,
                    "sessionID": turn.session_id,
                    "messageID": message_id,
                    "type": "reasoning",
                    "text": item.content,
                    "time": {"start": item.timestamp},
                }),
            ));
            sequence += 1;
        }
        for item in &round.text_items {
            parts.push((
                item.order_index.unwrap_or(usize::MAX),
                sequence,
                json!({
                    "id": item.id,
                    "sessionID": turn.session_id,
                    "messageID": message_id,
                    "type": "text",
                    "text": item.content,
                    "time": {"start": item.timestamp},
                }),
            ));
            sequence += 1;
        }
        for item in &round.tool_items {
            parts.push((
                item.order_index.unwrap_or(usize::MAX),
                sequence,
                tool_part(&turn.session_id, message_id, item),
            ));
            sequence += 1;
        }
    }
    parts.sort_by_key(|(order, sequence, _)| (*order, *sequence));
    parts.into_iter().map(|(_, _, part)| part).collect()
}

fn assistant_message_projection(
    context: &MessageProjectionContext<'_>,
    turn: &crate::service::session::DialogTurnData,
) -> Option<Value> {
    if turn.model_rounds.is_empty() {
        return None;
    }
    let (provider_id, model_id, configured) = message_model_identity(context, turn);
    let message_id = turn.turn_id.clone();
    let input_tokens = turn
        .token_usage
        .as_ref()
        .map_or(0, |usage| usage.input_tokens);
    let output_tokens = turn
        .token_usage
        .as_ref()
        .and_then(|usage| usage.output_tokens)
        .unwrap_or(0);
    let reasoning_tokens = token_detail(turn, "reasoningTokenCount");
    let cache_read = token_detail(turn, "cachedContentTokenCount");
    let cache_write = token_detail(turn, "cacheCreationTokenCount");
    let mut info = json!({
        "id": message_id,
        "sessionID": turn.session_id,
        "role": "assistant",
        "time": {"created": turn.start_time, "completed": turn.end_time},
        "parentID": turn.user_message.id,
        "modelID": model_id,
        "providerID": provider_id,
        "mode": turn.agent_type.as_deref().unwrap_or(&context.session.agent_type),
        "path": {"cwd": context.instance.directory, "root": context.instance.worktree},
        "cost": assistant_cost(context, configured, input_tokens, output_tokens, cache_read, cache_write),
        "tokens": {
            "input": input_tokens,
            "output": output_tokens,
            "reasoning": reasoning_tokens,
            "cache": {"read": cache_read, "write": cache_write},
        },
        "finish": turn.finish_reason,
    });
    if let Some(error) = turn.error.as_ref() {
        info["error"] = json!({"name": "UnknownError", "data": {"message": error}});
    }
    Some(json!({"info": info, "parts": assistant_parts(turn, &message_id)}))
}

fn project_turn_messages(
    context: &MessageProjectionContext<'_>,
    turn: &crate::service::session::DialogTurnData,
) -> Vec<Value> {
    let mut messages = vec![user_message_projection(context, turn)];
    if let Some(assistant) = assistant_message_projection(context, turn) {
        messages.push(assistant);
    }
    messages
}

async fn session_messages(
    context: &PluginHostInstance,
    session_id: &str,
    query: &HashMap<String, Vec<String>>,
) -> RouteResult {
    let metadata = session_metadata(context, session_id).await?;
    let limit = query_first(query, "limit")
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| Failure::bad_request("limit must be a positive integer"))
        })
        .transpose()?
        .unwrap_or(100)
        .clamp(1, 1000);
    let turns = coordinator()?
        .load_visible_persisted_session_turns(&session_storage_root(context).await?, session_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let (models, _, catalog) = load_models().await?;
    let projection = MessageProjectionContext {
        instance: context,
        session: &metadata,
        models: &models,
        catalog: &catalog,
    };
    let messages = turns
        .iter()
        .flat_map(|turn| project_turn_messages(&projection, turn))
        .collect::<Vec<_>>();
    Ok(Value::Array(
        messages
            .into_iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
    ))
}

async fn session_message(
    context: &PluginHostInstance,
    session_id: &str,
    message_id: &str,
) -> RouteResult {
    let metadata = session_metadata(context, session_id).await?;
    let turns = coordinator()?
        .load_visible_persisted_session_turns(&session_storage_root(context).await?, session_id)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let (models, _, catalog) = load_models().await?;
    let projection = MessageProjectionContext {
        instance: context,
        session: &metadata,
        models: &models,
        catalog: &catalog,
    };
    turns
        .iter()
        .flat_map(|turn| project_turn_messages(&projection, turn))
        .find(|message| message["info"]["id"].as_str() == Some(message_id))
        .ok_or_else(|| Failure::not_found("Message was not found in this session"))
}

fn pty_value(session: &SessionResponse) -> Value {
    let status = if matches!(
        session.status.to_ascii_lowercase().as_str(),
        "starting" | "active" | "orphaned" | "restoring" | "terminating" | "running"
    ) {
        "running"
    } else {
        "exited"
    };
    json!({"id": session.id, "title": session.name, "command": session.shell_type.default_executable(), "args": [], "cwd": session.cwd, "status": status, "pid": session.pid.unwrap_or(0)})
}

async fn pty_list(context: &PluginHostInstance) -> RouteResult {
    let api =
        TerminalApi::from_singleton().map_err(|error| Failure::unavailable(error.to_string()))?;
    let sessions = api
        .list_sessions()
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let mut values = Vec::new();
    let mut live_ids = std::collections::HashSet::new();
    for session in sessions {
        live_ids.insert(session.id.clone());
        if crate::plugin_host::plugin_host_pty_owned_by(&session.id, &context.instance_id).await {
            values.push(pty_value(&session));
        }
    }
    for pty_id in crate::plugin_host::plugin_host_pty_ids_for_instance(&context.instance_id).await {
        if !live_ids.contains(&pty_id) {
            crate::plugin_host::prune_plugin_host_pty(&pty_id, &context.instance_id).await;
        }
    }
    Ok(Value::Array(values))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PtyCreateBody {
    command: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    title: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
}

async fn pty_create(context: &PluginHostInstance, body: &[u8]) -> RouteResult {
    let input: PtyCreateBody = body_as(body)?;
    if input.args.as_ref().is_some_and(|args| !args.is_empty()) {
        return Err(Failure::bad_request(
            "OpenBitFun terminal sessions do not support arbitrary PTY arguments",
        ));
    }
    let cwd = input
        .cwd
        .as_deref()
        .map(|value| resolve_scoped_path(context, value))
        .transpose()?
        .unwrap_or_else(|| context.directory.clone());
    let shell_type = input.command.as_deref().map(parse_pty_shell).transpose()?;
    let api =
        TerminalApi::from_singleton().map_err(|error| Failure::unavailable(error.to_string()))?;
    let session = api
        .create_session(CreateSessionRequest {
            session_id: None,
            name: input.title,
            shell_type,
            shell_id: None,
            working_directory: Some(cwd.to_string_lossy().into_owned()),
            env: input.env,
            cols: None,
            rows: None,
            remote_connection_id: None,
            source: None,
        })
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    crate::plugin_host::register_plugin_host_pty(&session.id, &context.instance_id).await;
    Ok(pty_value(&session))
}

fn parse_pty_shell(command: &str) -> Result<ShellType, Failure> {
    let shell = ShellType::from_executable(command.trim());
    if matches!(shell, ShellType::Custom(_)) {
        return Err(Failure::bad_request(
            "PTY command must select a supported OpenBitFun shell",
        ));
    }
    Ok(shell)
}

async fn pty_get(context: &PluginHostInstance, pty_id: &str) -> RouteResult {
    if !crate::plugin_host::plugin_host_pty_owned_by(pty_id, &context.instance_id).await {
        return Err(Failure::not_found(
            "PTY was not found in this plugin instance",
        ));
    }
    let api =
        TerminalApi::from_singleton().map_err(|error| Failure::unavailable(error.to_string()))?;
    let session = match api.get_session(pty_id).await {
        Ok(session) => session,
        Err(error) => {
            crate::plugin_host::prune_plugin_host_pty(pty_id, &context.instance_id).await;
            return Err(Failure::not_found(error.to_string()));
        }
    };
    Ok(pty_value(&session))
}

async fn pty_delete(context: &PluginHostInstance, pty_id: &str) -> RouteResult {
    if !crate::plugin_host::plugin_host_pty_owned_by(pty_id, &context.instance_id).await {
        return Err(Failure::not_found(
            "PTY was not found in this plugin instance",
        ));
    }
    let api =
        TerminalApi::from_singleton().map_err(|error| Failure::unavailable(error.to_string()))?;
    if let Err(error) = api.get_session(pty_id).await {
        crate::plugin_host::prune_plugin_host_pty(pty_id, &context.instance_id).await;
        return Err(Failure::not_found(error.to_string()));
    }
    api.close_session(CloseSessionRequest {
        session_id: pty_id.to_string(),
        immediate: Some(false),
    })
    .await
    .map_err(|error| Failure::backend(error.to_string()))?;
    crate::plugin_host::unregister_plugin_host_pty(pty_id, &context.instance_id).await;
    Ok(json!(true))
}

#[derive(Deserialize)]
struct PtyUpdateBody {
    title: Option<String>,
    size: Option<PtySize>,
}
#[derive(Deserialize)]
struct PtySize {
    rows: u16,
    cols: u16,
}

async fn pty_update(context: &PluginHostInstance, pty_id: &str, body: &[u8]) -> RouteResult {
    let input: PtyUpdateBody = body_as(body)?;
    pty_get(context, pty_id).await?;
    if input.title.is_some() {
        return Err(Failure::bad_request(
            "PTY title updates are not supported by the OpenBitFun terminal owner",
        ));
    }
    if let Some(size) = input.size {
        TerminalApi::from_singleton()
            .map_err(|error| Failure::unavailable(error.to_string()))?
            .resize(ResizeRequest {
                session_id: pty_id.to_string(),
                cols: size.cols,
                rows: size.rows,
            })
            .await
            .map_err(|error| Failure::backend(error.to_string()))?;
    }
    pty_get(context, pty_id).await
}

async fn find_text(
    context: &PluginHostInstance,
    query: &HashMap<String, Vec<String>>,
) -> RouteResult {
    let pattern = required_query(query, "pattern")?;
    let options = FileSearchOptions {
        include_content: true,
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: Some(1000),
        file_extensions: None,
        include_directories: false,
    };
    let outcome = crate::service::filesystem::FileSystemService::default()
        .search_file_contents(&context.directory.to_string_lossy(), pattern, options, None)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let matcher = regex::RegexBuilder::new(&regex::escape(pattern))
        .case_insensitive(true)
        .build()
        .map_err(|error| Failure::bad_request(error.to_string()))?;
    let offsets = search_line_offsets(&outcome.results).await?;
    let mut results = Vec::new();
    for result in outcome.results {
        let Some(line_number) = result.line_number else {
            continue;
        };
        let Some(line) = result.matched_content else {
            continue;
        };
        let submatches = matcher
            .find_iter(&line)
            .map(|matched| {
                json!({
                    "match": {"text": matched.as_str()},
                    "start": matched.start(),
                    "end": matched.end(),
                })
            })
            .collect::<Vec<_>>();
        if submatches.is_empty() {
            continue;
        }
        let path = Path::new(&result.path);
        let relative = relative_path(context, path);
        let absolute_offset = *offsets
            .get(&(result.path.clone(), line_number))
            .ok_or_else(|| Failure::backend("Search result line was outside the indexed file"))?;
        results.push(json!({
            "path": {"text": relative},
            "lines": {"text": line},
            "line_number": line_number,
            "absolute_offset": absolute_offset,
            "submatches": submatches,
        }));
    }
    Ok(Value::Array(results))
}

async fn search_line_offsets(
    results: &[FileSearchResult],
) -> Result<HashMap<(String, usize), u64>, Failure> {
    let mut requested = BTreeMap::<String, BTreeSet<usize>>::new();
    for result in results {
        if let Some(line_number) = result.line_number {
            requested
                .entry(result.path.clone())
                .or_default()
                .insert(line_number);
        }
    }

    let mut offsets = HashMap::new();
    for (path, line_numbers) in requested {
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|error| Failure::backend(error.to_string()))?;
        let mut reader = BufReader::new(file);
        let last_line = line_numbers.iter().next_back().copied().unwrap_or(0);
        let mut line_number = 1usize;
        let mut offset = 0u64;
        let mut buffer = Vec::new();
        while line_number <= last_line {
            buffer.clear();
            let bytes = reader
                .read_until(b'\n', &mut buffer)
                .await
                .map_err(|error| Failure::backend(error.to_string()))?;
            if bytes == 0 {
                break;
            }
            if line_numbers.contains(&line_number) {
                offsets.insert((path.clone(), line_number), offset);
            }
            offset = offset.saturating_add(u64::try_from(bytes).unwrap_or(u64::MAX));
            line_number += 1;
        }
    }
    Ok(offsets)
}

async fn find_files(
    context: &PluginHostInstance,
    query: &HashMap<String, Vec<String>>,
) -> RouteResult {
    let pattern = required_query(query, "query")?;
    let options = FileSearchOptions {
        include_content: false,
        case_sensitive: false,
        use_regex: false,
        whole_word: false,
        max_results: Some(1000),
        file_extensions: None,
        include_directories: query_first(query, "dirs") == Some("true"),
    };
    let outcome = crate::service::filesystem::FileSystemService::default()
        .search_file_names(&context.directory.to_string_lossy(), pattern, options, None)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(Value::Array(
        outcome
            .results
            .into_iter()
            .map(|result| Value::String(relative_path(context, Path::new(&result.path))))
            .collect(),
    ))
}

fn file_node(context: &PluginHostInstance, node: FileTreeNode) -> Value {
    json!({"name": node.name, "path": relative_path(context, Path::new(&node.path)), "absolute": node.path, "type": if node.is_directory {"directory"} else {"file"}, "ignored": false})
}

async fn file_list(
    context: &PluginHostInstance,
    query: &HashMap<String, Vec<String>>,
) -> RouteResult {
    let value = required_query(query, "path")?;
    let path = resolve_scoped_path(context, value)?;
    let nodes = crate::service::filesystem::FileSystemService::default()
        .get_directory_contents(&path.to_string_lossy())
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(Value::Array(
        nodes
            .into_iter()
            .map(|node| file_node(context, node))
            .collect(),
    ))
}

async fn file_read(
    context: &PluginHostInstance,
    query: &HashMap<String, Vec<String>>,
) -> RouteResult {
    let path = resolve_scoped_path(context, required_query(query, "path")?)?;
    let result = crate::service::filesystem::FileSystemService::default()
        .read_file(&path.to_string_lossy())
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    if result.is_binary {
        Ok(json!({"type": "binary", "content": result.content, "encoding": "base64"}))
    } else {
        Ok(json!({"type": "text", "content": result.content}))
    }
}

async fn file_status(context: &PluginHostInstance) -> RouteResult {
    let snapshot =
        openbitfun_services_integrations::git::GitWorkspaceDiffPort::new(&context.directory)
            .workspace_diff()
            .await
            .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(Value::Array(snapshot.files.into_iter().map(|file| json!({
        "path": file.path,
        "added": file.additions,
        "removed": file.deletions,
        "status": match file.status {
            WorkspaceDiffFileStatus::Added => "added",
            WorkspaceDiffFileStatus::Deleted => "deleted",
            WorkspaceDiffFileStatus::Modified | WorkspaceDiffFileStatus::Renamed | WorkspaceDiffFileStatus::Conflicted => "modified",
        },
    })).collect()))
}

async fn mcp_status() -> RouteResult {
    let service = crate::service::mcp::get_global_mcp_service()
        .ok_or_else(|| Failure::unavailable("MCP service is not initialized"))?;
    let statuses = service
        .server_manager()
        .get_all_server_statuses()
        .await
        .into_iter()
        .map(|(name, status)| {
            let value = match status {
                crate::service::mcp::MCPServerStatus::Connected
                | crate::service::mcp::MCPServerStatus::Healthy => json!({"status": "connected"}),
                crate::service::mcp::MCPServerStatus::NeedsAuth => json!({"status": "needs_auth"}),
                crate::service::mcp::MCPServerStatus::Failed => {
                    json!({"status": "failed", "error": "MCP server failed"})
                }
                _ => json!({"status": "disabled"}),
            };
            (name, value)
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(Value::Object(statuses))
}

async fn lsp_status(_context: &PluginHostInstance) -> RouteResult {
    Err(Failure::unsupported(
        "LSP runtime is retired in the 1.0.0-explore product line",
    ))
}
