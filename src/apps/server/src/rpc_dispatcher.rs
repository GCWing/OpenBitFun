//! WebSocket RPC command dispatcher.
//!
//! Maps Tauri command names (used by the frontend `api.invoke()`) to
//! server-side handler functions. Each handler receives the raw JSON
//! `params` and returns a JSON `result`.

use crate::bootstrap::ServerAppState;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openbitfun_core::agentic::agents::SubAgentSource;
use openbitfun_core::agentic::coordination::{DialogSubmissionPolicy, DialogTriggerSource};
use openbitfun_core::agentic::core::SessionConfig;
use openbitfun_core::agentic::deep_review_policy::{
    apply_deep_review_queue_control, DeepReviewQueueControlAction,
};
use openbitfun_core::service::config::model_pool::AgentModelSelection;
use openbitfun_core::service::i18n::{sync_global_i18n_service_locale, LocaleId, LocaleMetadata};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Dispatch a WebSocket RPC method call to the appropriate handler.
///
/// The `method` string matches the Tauri command name exactly (e.g.
/// `"open_workspace"`, `"terminal_create"`), so the frontend's
/// `api.invoke(name, args)` works identically over both Tauri IPC and
/// WebSocket.
pub async fn dispatch(
    method: &str,
    params: serde_json::Value,
    state: &Arc<ServerAppState>,
) -> Result<serde_json::Value> {
    match method {
        // ── Ping ──────────────────────────────────────────────
        "ping" => Ok(serde_json::json!({
            "pong": true,
            "timestamp": chrono::Utc::now().timestamp(),
        })),

        // ── Health / Status ──────────────────────────────────
        "get_health_status" => {
            let uptime = state.start_time.elapsed().as_secs();
            Ok(serde_json::json!({
                "status": "healthy",
                "message": "All services are running normally",
                "services": {
                    "workspace_service": true,
                    "config_service": true,
                    "filesystem_service": true,
                },
                "uptime_seconds": uptime,
            }))
        }

        // ── Workspace ────────────────────────────────────────
        "open_workspace" => {
            let request = extract_request(&params)?;
            let path: String = serde_json::from_value(
                request
                    .get("path")
                    .cloned()
                    .ok_or_else(|| anyhow!("Missing path"))?,
            )?;
            let info = state
                .workspace_service
                .open_workspace(path.into())
                .await
                .map_err(|e| anyhow!("{}", e))?;
            *state.workspace_path.write().await = Some(info.root_path.clone());
            Ok(serde_json::to_value(&info).unwrap_or_default())
        }
        "get_current_workspace" => {
            let ws = state.workspace_service.get_current_workspace().await;
            Ok(serde_json::to_value(&ws).unwrap_or(serde_json::Value::Null))
        }
        "get_recent_workspaces" => {
            let list = state.workspace_service.get_recent_workspaces().await;
            Ok(serde_json::to_value(&list).unwrap_or_default())
        }
        "remove_recent_workspace" => {
            let request = extract_request(&params)?;
            let workspace_id = get_string(request, "workspaceId")?;
            state
                .workspace_service
                .remove_workspace_from_recent(&workspace_id)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::Value::Null)
        }
        "get_opened_workspaces" => {
            let list = state.workspace_service.get_opened_workspaces().await;
            Ok(serde_json::to_value(&list).unwrap_or_default())
        }

        // ── File System ──────────────────────────────────────
        "read_file_content" => {
            let request = extract_request(&params)?;
            let file_path = get_string(&request, "filePath")?;
            let encoding = request.get("encoding").and_then(|value| value.as_str());

            if encoding.is_some_and(|value| value.eq_ignore_ascii_case("base64")) {
                let bytes = state
                    .filesystem_service
                    .read_file_bytes(&file_path)
                    .await
                    .map_err(|e| anyhow!("{}", e))?;
                return Ok(serde_json::json!(BASE64.encode(bytes)));
            }

            let result = state
                .filesystem_service
                .read_file(&file_path)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!(result.content))
        }
        "write_file_content" => {
            let request = extract_request(&params)?;
            let file_path = get_string(&request, "filePath")?;
            let content = get_string(&request, "content")?;
            state
                .filesystem_service
                .write_file(&file_path, &content)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::Value::Null)
        }
        "check_path_exists" => {
            let path_str = if let Some(req) = params.get("request") {
                get_string(req, "path")?
            } else {
                get_string(&params, "path")?
            };
            let exists = std::path::Path::new(&path_str).exists();
            Ok(serde_json::json!(exists))
        }
        "get_file_tree" => {
            let request = extract_request(&params)?;
            let path = get_string(&request, "path")?;
            let nodes = state
                .filesystem_service
                .build_file_tree(&path)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::to_value(&nodes).unwrap_or_default())
        }
        "fs_exists" => {
            let path_str = get_string(&params, "path")?;
            let exists = std::path::Path::new(&path_str).exists();
            Ok(serde_json::json!(exists))
        }

        // ── Config ───────────────────────────────────────────
        "get_config" => {
            let request = extract_request(&params)?;
            let key = request.get("key").and_then(|v| v.as_str());
            let config: serde_json::Value = state
                .config_service
                .get_config(key)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(config)
        }
        "set_config" => {
            let request = extract_request(&params)?;
            let key = get_string(&request, "key")?;
            let value = request
                .get("value")
                .cloned()
                .ok_or_else(|| anyhow!("Missing value"))?;
            state
                .config_service
                .set_config(&key, value)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!("ok"))
        }
        "get_web_search_credential_status" => {
            let request = extract_request(&params)?;
            let provider = get_string(&request, "provider")?;
            let status =
                openbitfun_core::service::web_search::get_web_search_credential_status(&provider)
                    .await
                    .map_err(|error| anyhow!(error.to_string()))?;
            Ok(serde_json::to_value(status)?)
        }
        "save_web_search_credential" => {
            let request = serde_json::from_value(extract_request(&params)?.clone())?;
            let status = openbitfun_core::service::web_search::save_web_search_credential(request)
                .await
                .map_err(|error| anyhow!(error.to_string()))?;
            Ok(serde_json::to_value(status)?)
        }
        "clear_web_search_credential" => {
            let request = serde_json::from_value(extract_request(&params)?.clone())?;
            let status = openbitfun_core::service::web_search::clear_web_search_credential(request)
                .await
                .map_err(|error| anyhow!(error.to_string()))?;
            Ok(serde_json::to_value(status)?)
        }
        "get_model_configs" => {
            let models = state
                .config_service
                .get_ai_models()
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::to_value(&models).unwrap_or_default())
        }
        "get_token_usage_statistics" => {
            let request = serde_json::from_value(extract_request(&params)?.clone())?;
            let statistics = state
                .token_usage_service
                .get_statistics_for_request(request)
                .await?;
            Ok(serde_json::to_value(statistics)?)
        }

        "list_subagents" => {
            let request = extract_request(&params)?;
            let source = request
                .get("source")
                .cloned()
                .map(serde_json::from_value::<SubAgentSource>)
                .transpose()?;
            let workspace =
                workspace_root_from_request(request.get("workspacePath").and_then(|v| v.as_str()));
            let list = state
                .agent_registry
                .get_subagents_info(workspace.as_deref())
                .await;
            let result: Vec<_> = match source {
                Some(source) => list
                    .into_iter()
                    .filter(|agent| agent.subagent_source == Some(source))
                    .collect(),
                None => list,
            };

            Ok(serde_json::to_value(&result).unwrap_or_default())
        }
        "update_subagent_config" => {
            let request = extract_request(&params)?;
            let subagent_id = get_string(request, "subagentId")?;
            let parent_agent_type = request
                .get("parentAgentType")
                .and_then(|v| v.as_str())
                .map(|value| value.to_string());
            let enabled = request.get("enabled").and_then(|v| v.as_bool());
            let model = request
                .get("model")
                .and_then(|v| v.as_str())
                .map(|value| value.to_string());
            let clear_model_override = request
                .get("clearModelOverride")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if model.is_some() && clear_model_override {
                return Err(anyhow!(
                    "model and clearModelOverride cannot be provided together"
                ));
            }
            let workspace =
                workspace_root_from_request(request.get("workspacePath").and_then(|v| v.as_str()));

            state
                .agent_registry
                .load_custom_agents(workspace.as_deref())
                .await;

            if state
                .agent_registry
                .get_custom_subagent_config(&subagent_id, workspace.as_deref())
                .is_some()
            {
                if let Some(enabled) = enabled {
                    let parent_agent_type = parent_agent_type.as_deref().ok_or_else(|| {
                        anyhow!("parentAgentType is required when updating subagent availability")
                    })?;
                    state
                        .agent_registry
                        .update_subagent_override(
                            parent_agent_type,
                            &subagent_id,
                            enabled,
                            workspace.as_deref(),
                        )
                        .await
                        .map_err(|e| anyhow!("Failed to update subagent availability: {}", e))?;
                }

                if model.is_some() || clear_model_override {
                    state
                        .agent_registry
                        .update_and_save_custom_subagent_config(
                            &subagent_id,
                            model,
                            clear_model_override,
                            workspace.as_deref(),
                        )
                        .map_err(|e| anyhow!("Failed to update configuration: {}", e))?;
                }
                Ok(serde_json::Value::Null)
            } else {
                if state
                    .agent_registry
                    .has_project_custom_subagent(&subagent_id)
                {
                    if let Some(workspace) = workspace.as_deref() {
                        return Err(anyhow!(
                            "Project Sub-Agent '{}' was not found in workspace '{}'",
                            subagent_id,
                            workspace.display()
                        ));
                    }

                    return Err(anyhow!(
                        "workspacePath is required to update project Sub-Agent '{}'",
                        subagent_id
                    ));
                }

                if let Some(enabled) = enabled {
                    let parent_agent_type = parent_agent_type.as_deref().ok_or_else(|| {
                        anyhow!("parentAgentType is required when updating subagent availability")
                    })?;
                    state
                        .agent_registry
                        .update_subagent_override(
                            parent_agent_type,
                            &subagent_id,
                            enabled,
                            workspace.as_deref(),
                        )
                        .await
                        .map_err(|e| anyhow!("Failed to update subagent availability: {}", e))?;
                }

                if clear_model_override || model.is_some() {
                    let mut builtin_models: std::collections::HashMap<
                        String,
                        openbitfun_core::service::config::model_pool::AgentModelSelection,
                    > = state
                        .config_service
                        .get_config(Some("ai.agent_model_selections.subagents.builtin"))
                        .await
                        .map_err(|e| anyhow!("Failed to read model selections: {e}"))?;
                    if clear_model_override {
                        builtin_models.remove(&subagent_id);
                    } else {
                        let model = model.as_deref().expect("model checked above").trim();
                        let selection = if model == "inherit" {
                            AgentModelSelection::Inherit
                        } else {
                            AgentModelSelection::Model {
                                model_ref: model.to_string(),
                            }
                        };
                        builtin_models.insert(subagent_id.clone(), selection);
                    }
                    state
                        .config_service
                        .set_config(
                            "ai.agent_model_selections.subagents.builtin",
                            &builtin_models,
                        )
                        .await
                        .map_err(|e| anyhow!("Failed to update model configuration: {}", e))?;
                }

                if let Err(e) = openbitfun_core::service::config::reload_global_config().await {
                    log::warn!(
                        "Failed to reload global config after server subagent config update: subagent_id={}, error={}",
                        subagent_id,
                        e
                    );
                }

                Ok(serde_json::Value::Null)
            }
        }

        // ── Agentic (Session / Dialog) ───────────────────────
        "create_session" => {
            let request = extract_request(&params)?;
            let session_name = get_string(&request, "sessionName")?;
            let agent_type = get_string(&request, "agentType")?;
            let workspace_path = get_string(&request, "workspacePath")?;
            let session_id = request
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let config = SessionConfig {
                tool_presentation_mode: Default::default(),
                workspace_path: Some(workspace_path.clone()),
                ..Default::default()
            };

            let session = state
                .coordinator
                .create_session_with_workspace(
                    session_id,
                    session_name,
                    agent_type,
                    config,
                    workspace_path,
                )
                .await
                .map_err(|e| anyhow!("{}", e))?;

            Ok(serde_json::json!({
                "sessionId": session.session_id,
                "sessionName": session.session_name,
                "agentType": session.agent_type,
            }))
        }
        "list_sessions" => {
            let request = extract_request(&params)?;
            let workspace_path = get_string(&request, "workspacePath")?;
            let sessions = state
                .coordinator
                .list_sessions(&PathBuf::from(workspace_path))
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::to_value(&sessions).unwrap_or_default())
        }
        "delete_session" => {
            let request = extract_request(&params)?;
            let session_id = get_string(&request, "sessionId")?;
            let workspace_path = get_string(&request, "workspacePath")?;
            state
                .coordinator
                .ensure_workspace_runtime_ownership(
                    std::path::Path::new(&workspace_path),
                    None,
                    None,
                )
                .map_err(|e| anyhow!("{}", e))?;
            state
                .coordinator
                .delete_session(&PathBuf::from(workspace_path), &session_id)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!({ "success": true }))
        }
        "start_dialog_turn" => {
            let request = extract_request(&params)?;
            let session_id = get_string(&request, "sessionId")?;
            let user_input = get_string(&request, "userInput")?;
            let original_user_input = request
                .get("originalUserInput")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let agent_type = get_string(&request, "agentType")?;
            let workspace_path = request
                .get("workspacePath")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let turn_id = request
                .get("turnId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            state
                .scheduler
                .submit(
                    session_id,
                    user_input,
                    original_user_input,
                    turn_id,
                    agent_type,
                    workspace_path,
                    DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
                    None,
                    None,
                )
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!({ "success": true, "message": "Dialog turn started" }))
        }
        "cancel_dialog_turn" => {
            let request = extract_request(&params)?;
            let session_id = get_string(&request, "sessionId")?;
            let dialog_turn_id = get_string(&request, "dialogTurnId")?;
            state
                .coordinator
                .cancel_dialog_turn(&session_id, &dialog_turn_id)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!({ "success": true }))
        }
        "control_deep_review_queue" => {
            let request = extract_request(&params)?;
            let session_id = get_string(&request, "sessionId")?;
            let dialog_turn_id = get_string(&request, "dialogTurnId")?;
            let tool_id = get_string(&request, "toolId")?;
            let action_raw = get_string(&request, "action")?;
            let action = match action_raw.as_str() {
                "pause" => DeepReviewQueueControlAction::Pause,
                "continue" => DeepReviewQueueControlAction::Continue,
                "cancel" => DeepReviewQueueControlAction::Cancel,
                "skip_optional" => DeepReviewQueueControlAction::SkipOptional,
                other => {
                    return Err(anyhow!(
                        "Invalid DeepReview queue control action: {}",
                        other
                    ));
                }
            };
            if session_id.trim().is_empty() {
                return Err(anyhow!("Missing sessionId"));
            }
            if dialog_turn_id.trim().is_empty() {
                return Err(anyhow!("Missing dialogTurnId"));
            }
            if tool_id.trim().is_empty() {
                return Err(anyhow!("Missing toolId"));
            }
            apply_deep_review_queue_control(&dialog_turn_id, &tool_id, action);
            Ok(serde_json::json!({ "success": true }))
        }
        "cancel_session" => {
            let request = extract_request(&params)?;
            let session_id = get_string(&request, "sessionId")?;
            let cancel_descendants = request
                .get("cancelDescendants")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let dialog_turn_id = state
                .coordinator
                .cancel_active_turn_for_session_with_descendant_policy(
                    &session_id,
                    Duration::from_secs(5),
                    cancel_descendants,
                )
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!({
                "cancelled": dialog_turn_id.is_some(),
                "dialogTurnId": dialog_turn_id,
            }))
        }
        "get_session_messages" => {
            let request = params.get("request").unwrap_or(&params);
            let session_id = request
                .get("sessionId")
                .or_else(|| request.get("session_id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("Missing or invalid 'sessionId'/'session_id' field"))?
                .to_string();
            let limit = request
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(50);
            let before_message_id = request
                .get("beforeMessageId")
                .or_else(|| request.get("before_message_id"))
                .and_then(|v| v.as_str());

            let (messages, has_more) = state
                .coordinator
                .get_messages_paginated(&session_id, limit, before_message_id)
                .await
                .map_err(|e| anyhow!("{}", e))?;
            Ok(serde_json::json!({
                "messages": messages,
                "has_more": has_more,
            }))
        }
        // ── I18n ─────────────────────────────────────────────
        "i18n_get_current_language" => {
            let lang: String = state
                .config_service
                .get_config(Some("app.language"))
                .await
                .unwrap_or_else(|_| "zh-CN".to_string());
            let lang = LocaleId::from_str(&lang)
                .unwrap_or_default()
                .as_str()
                .to_string();
            Ok(serde_json::json!(lang))
        }
        "i18n_set_language" => {
            let request = extract_request(&params)?;
            let language = get_string(&request, "language")?;
            let Some(locale_id) = LocaleId::from_str(&language) else {
                return Err(anyhow!("Unsupported language: {}", language));
            };
            state
                .config_service
                .set_config("app.language", locale_id.as_str())
                .await
                .map_err(|e| anyhow!("{}", e))?;
            match sync_global_i18n_service_locale(locale_id).await {
                Ok(true) => {}
                Ok(false) => {
                    log::warn!(
                        "Global I18nService not initialized after server language change: language={}",
                        locale_id.as_str()
                    );
                }
                Err(e) => {
                    log::warn!(
                        "Failed to sync global I18nService after server language change: language={}, error={}",
                        locale_id.as_str(),
                        e
                    );
                }
            }
            Ok(serde_json::json!(locale_id.as_str()))
        }
        "i18n_get_config" => {
            let current_language = match state
                .config_service
                .get_config::<String>(Some("app.language"))
                .await
            {
                Ok(language) => LocaleId::from_str(&language)
                    .unwrap_or_default()
                    .as_str()
                    .to_string(),
                Err(_) => "zh-CN".to_string(),
            };

            Ok(serde_json::json!({
                "currentLanguage": current_language,
                "fallbackLanguage": "en-US",
                "autoDetect": false
            }))
        }
        "i18n_set_config" => {
            let config = params.get("config").unwrap_or(&params);
            if let Some(language) = config.get("currentLanguage").and_then(|v| v.as_str()) {
                let Some(locale_id) = LocaleId::from_str(language) else {
                    return Err(anyhow!("Unsupported language: {}", language));
                };
                state
                    .config_service
                    .set_config("app.language", locale_id.as_str())
                    .await
                    .map_err(|e| anyhow!("{}", e))?;
                match sync_global_i18n_service_locale(locale_id).await {
                    Ok(true) => {}
                    Ok(false) => {
                        log::warn!(
                            "Global I18nService not initialized after server i18n config save: language={}",
                            locale_id.as_str()
                        );
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to sync global I18nService after server i18n config save: language={}, error={}",
                            locale_id.as_str(),
                            e
                        );
                    }
                }
            }
            Ok(serde_json::json!("i18n config saved"))
        }
        "i18n_get_supported_languages" => {
            let locales: Vec<_> = LocaleMetadata::all()
                .into_iter()
                .map(|locale| {
                    serde_json::json!({
                        "id": locale.id.as_str(),
                        "name": locale.name,
                        "englishName": locale.english_name,
                        "nativeName": locale.native_name,
                        "rtl": locale.rtl,
                    })
                })
                .collect();
            Ok(serde_json::json!(locales))
        }

        // ── Tools ────────────────────────────────────────────
        "get_all_tools_info" => {
            let tools: Vec<serde_json::Value> = state
                .tool_registry_snapshot
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name().to_string(),
                    })
                })
                .collect();
            Ok(serde_json::json!(tools))
        }

        // ── Fallback ─────────────────────────────────────────
        _ => {
            log::warn!("Unknown RPC method: {}", method);
            Err(anyhow!("Unknown command: {}", method))
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────

/// Extract the `request` field from params (Tauri convention: `{ request: { ... } }`).
fn extract_request(params: &serde_json::Value) -> Result<&serde_json::Value> {
    params
        .get("request")
        .ok_or_else(|| anyhow!("Missing 'request' field in params"))
}

fn get_string(obj: &serde_json::Value, key: &str) -> Result<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("Missing or invalid '{}' field", key))
}

fn workspace_root_from_request(workspace_path: Option<&str>) -> Option<PathBuf> {
    workspace_path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}
