use crate::plugin_host::PluginHostInstance;
// OpenCode client route projections backed by OpenBitFun owners.
//
// The adapter owns OpenCode path/method matching, wire DTOs, framing, and
// transport errors. This module only invokes the existing OpenBitFun session,
// filesystem, terminal, MCP, Git, and model owners and projects their
// results into the adapter's route contract. The logical instance and PTY
// maps in `plugin_host` scope those calls; they are not physical process
// supervision (that remains in the adapter/services process-tree boundary).

use crate::plugin_host_http::{body_as, Failure, RouteResult};
use openbitfun_opencode_plugin_host::OpenCodeClientRoute;
use serde_json::{json, Value};
use std::collections::HashMap;

pub(crate) async fn dispatch_route(
    context: &PluginHostInstance,
    route: OpenCodeClientRoute,
    query: &HashMap<String, Vec<String>>,
    body: &[u8],
) -> RouteResult {
    match route {
        OpenCodeClientRoute::ProjectList => project_list(context).await,
        OpenCodeClientRoute::ProjectCurrent => Ok(project_value(context)),
        OpenCodeClientRoute::PathGet => path_get(context),
        OpenCodeClientRoute::VcsGet => vcs_get(context).await,
        OpenCodeClientRoute::ConfigGet => config_get().await,
        OpenCodeClientRoute::ConfigProviders => config_providers().await,
        OpenCodeClientRoute::ProviderList => provider_list().await,
        OpenCodeClientRoute::ToolIds => tool_ids().await,
        OpenCodeClientRoute::ToolList => tool_list(query).await,
        OpenCodeClientRoute::AppLog => app_log(context, body),
        OpenCodeClientRoute::AgentList => agent_list(context).await,
        OpenCodeClientRoute::CommandList => command_list(context).await,
        OpenCodeClientRoute::SessionList => session_list(context).await,
        OpenCodeClientRoute::SessionCreate => session_create(context, body).await,
        OpenCodeClientRoute::SessionStatus => session_status(context).await,
        OpenCodeClientRoute::SessionDelete { session_id } => {
            session_delete(context, &session_id).await
        }
        OpenCodeClientRoute::SessionGet { session_id } => session_get(context, &session_id).await,
        OpenCodeClientRoute::SessionUpdate { session_id } => {
            session_update(context, &session_id, body).await
        }
        OpenCodeClientRoute::SessionChildren { session_id } => {
            session_children(context, &session_id).await
        }
        OpenCodeClientRoute::SessionTodo { session_id } => session_todo(context, &session_id).await,
        OpenCodeClientRoute::SessionFork { session_id } => {
            session_fork(context, &session_id, body).await
        }
        OpenCodeClientRoute::SessionAbort { session_id } => {
            session_abort(context, &session_id).await
        }
        OpenCodeClientRoute::SessionDiff { session_id } => {
            session_diff(context, &session_id, query).await
        }
        OpenCodeClientRoute::SessionMessages { session_id } => {
            session_messages(context, &session_id, query).await
        }
        OpenCodeClientRoute::SessionMessage {
            session_id,
            message_id,
        } => session_message(context, &session_id, &message_id).await,
        OpenCodeClientRoute::PtyList => pty_list(context).await,
        OpenCodeClientRoute::PtyCreate => pty_create(context, body).await,
        OpenCodeClientRoute::PtyDelete { pty_id } => pty_delete(context, &pty_id).await,
        OpenCodeClientRoute::PtyGet { pty_id } => pty_get(context, &pty_id).await,
        OpenCodeClientRoute::PtyUpdate { pty_id } => pty_update(context, &pty_id, body).await,
        OpenCodeClientRoute::FindText => find_text(context, query).await,
        OpenCodeClientRoute::FindFiles => find_files(context, query).await,
        OpenCodeClientRoute::FileList => file_list(context, query).await,
        OpenCodeClientRoute::FileRead => file_read(context, query).await,
        OpenCodeClientRoute::FileStatus => file_status(context).await,
        OpenCodeClientRoute::McpStatus => mcp_status().await,
        OpenCodeClientRoute::LspStatus => lsp_status(context).await,
    }
}

fn query_first<'a>(query: &'a HashMap<String, Vec<String>>, key: &str) -> Option<&'a str> {
    query
        .get(key)
        .and_then(|values| values.first())
        .map(String::as_str)
}

fn required_query<'a>(
    query: &'a HashMap<String, Vec<String>>,
    key: &str,
) -> Result<&'a str, Failure> {
    query_first(query, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| Failure::bad_request(format!("Missing required query parameter: {key}")))
}

fn project_value(context: &PluginHostInstance) -> Value {
    json!({
        "id": context.project_id,
        "worktree": context.worktree.to_string_lossy(),
        "time": {"created": context.created_at_ms},
    })
}

async fn project_list(context: &PluginHostInstance) -> RouteResult {
    Ok(json!([project_value(context)]))
}

fn path_get(context: &PluginHostInstance) -> RouteResult {
    let path_manager = crate::infrastructure::try_get_path_manager_arc()
        .map_err(|error| Failure::backend(error.to_string()))?;
    Ok(json!({
        "state": path_manager.project_runtime_root(&context.directory).to_string_lossy(),
        "config": path_manager.project_internal_config_dir(&context.directory).to_string_lossy(),
        "worktree": context.worktree.to_string_lossy(),
        "directory": context.directory.to_string_lossy(),
    }))
}

async fn vcs_get(context: &PluginHostInstance) -> RouteResult {
    let repository = crate::service::git::GitService::get_repository_basic(&context.worktree)
        .await
        .map_err(|error| Failure::not_found(format!("Git repository is unavailable: {error}")))?;
    Ok(json!({"branch": repository.current_branch}))
}

async fn config_get() -> RouteResult {
    use crate::service::config::{get_global_config_service, GlobalConfig};
    let service = get_global_config_service()
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let config: GlobalConfig = service
        .get_config(None)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let plugins = config
        .plugin
        .iter()
        .map(|plugin| plugin.spec().to_string())
        .filter(|spec| !spec.trim().is_empty())
        .collect::<Vec<_>>();
    Ok(json!({
        "plugin": plugins,
        "logLevel": config.app.logging.level.trim().to_ascii_uppercase(),
    }))
}

fn provider_projection(
    models: &[crate::service::config::AIModelConfig],
    catalog: &openbitfun_core_types::ProviderCatalog,
    full_model_dto: bool,
) -> Vec<Value> {
    let mut grouped =
        std::collections::BTreeMap::<String, Vec<&crate::service::config::AIModelConfig>>::new();
    for model in models.iter().filter(|model| model.enabled) {
        grouped
            .entry(model.provider.clone())
            .or_default()
            .push(model);
    }
    grouped
        .into_iter()
        .map(|(provider_id, models)| {
            let model_values = models
                .iter()
                .map(|model| {
                    let attachment = model.capabilities.contains(&crate::service::config::ModelCapability::ImageUnderstanding);
                    let tool_call = model.capabilities.contains(&crate::service::config::ModelCapability::FunctionCalling);
                    let context = model.context_window.unwrap_or(crate::service::config::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
                    let output = model.max_tokens.unwrap_or_else(|| crate::service::config::automatic_max_output_tokens(context));
                    let catalog_model = matching_catalog_model(catalog, model);
                    let input_modalities = catalog_model
                        .map(|entry| entry.capabilities.input_modalities.clone())
                        .filter(|values| !values.is_empty())
                        .unwrap_or_else(|| if attachment { vec!["text".to_string(), "image".to_string()] } else { vec!["text".to_string()] });
                    let output_modalities = catalog_model
                        .map(|entry| entry.capabilities.output_modalities.clone())
                        .filter(|values| !values.is_empty())
                        .unwrap_or_else(|| vec!["text".to_string()]);
                    let release_date = catalog_model.and_then(|entry| entry.release_date.clone()).unwrap_or_default();
                    let status = catalog_model
                        .and_then(|entry| entry.status.as_deref())
                        .filter(|status| matches!(*status, "alpha" | "beta" | "deprecated" | "active"))
                        .unwrap_or("active");
                    let model_context = catalog_model
                        .and_then(|entry| entry.limits.as_ref())
                        .and_then(|limits| limits.context)
                        .unwrap_or(context);
                    let model_output = catalog_model
                        .and_then(|entry| entry.limits.as_ref())
                        .and_then(|limits| limits.output)
                        .unwrap_or(output);
                    let npm = provider_npm(&model.provider);
                    let api_url = model.request_url.as_deref().unwrap_or(&model.base_url);
                    let mut value = if full_model_dto {
                        json!({
                            "id": model.id,
                            "providerID": model.provider,
                            "api": {"id": model.model_name, "url": api_url, "npm": npm},
                            "name": model.name,
                            "capabilities": {
                                "temperature": model.temperature.is_some(),
                                "reasoning": model.reasoning.is_some() || catalog_model.is_some_and(|entry| entry.capabilities.reasoning),
                                "attachment": attachment,
                                "toolcall": tool_call,
                                "input": modality_flags(&input_modalities),
                                "output": modality_flags(&output_modalities),
                            },
                            "cost": model_cost(catalog_model),
                            "limit": {"context": model_context, "output": model_output},
                            "status": status,
                            "options": {},
                            "headers": {},
                        })
                    } else {
                        json!({
                            "id": model.id,
                            "name": model.name,
                            "release_date": release_date,
                            "attachment": attachment,
                            "reasoning": model.reasoning.is_some() || catalog_model.is_some_and(|entry| entry.capabilities.reasoning),
                            "temperature": model.temperature.is_some(),
                            "tool_call": tool_call,
                            "limit": {"context": model_context, "output": model_output},
                            "modalities": {"input": input_modalities, "output": output_modalities},
                            "status": status,
                            "options": {},
                            "provider": {"npm": npm},
                        })
                    };
                    if !full_model_dto {
                        if let Some(cost) = optional_model_cost(catalog_model) {
                            value["cost"] = cost;
                        }
                    }
                    (model.id.clone(), value)
                })
                .collect::<serde_json::Map<String, Value>>();
            let api = models.first().map(|model| model.base_url.clone());
            json!({
                "id": provider_id,
                "name": provider_id,
                "env": [],
                "api": api,
                "npm": provider_npm(&provider_id),
                "models": model_values,
            })
        })
        .collect()
}

fn provider_npm(provider: &str) -> &'static str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "anthropic" => "@ai-sdk/anthropic",
        "gemini" | "google" | "gemini-code-assist" => "@ai-sdk/google",
        "openai-responses" => "@ai-sdk/openai",
        _ => "@ai-sdk/openai-compatible",
    }
}

fn modality_flags(modalities: &[String]) -> Value {
    let supports = |value: &str| {
        modalities
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(value))
    };
    json!({
        "text": supports("text"),
        "audio": supports("audio"),
        "image": supports("image"),
        "video": supports("video"),
        "pdf": supports("pdf"),
    })
}

fn matching_catalog_model<'a>(
    catalog: &'a openbitfun_core_types::ProviderCatalog,
    model: &crate::service::config::AIModelConfig,
) -> Option<&'a openbitfun_core_types::ProviderCatalogModel> {
    let mut matches = catalog
        .providers
        .iter()
        .flat_map(|provider| provider.models.iter())
        .filter(|entry| {
            entry.id.eq_ignore_ascii_case(&model.model_name)
                || entry.id.eq_ignore_ascii_case(&model.id)
        });
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn price(value: Option<&str>) -> Option<f64> {
    value
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn optional_model_cost(
    model: Option<&openbitfun_core_types::ProviderCatalogModel>,
) -> Option<Value> {
    let pricing = model?.pricing.as_ref()?;
    let input = price(pricing.input.as_deref())?;
    let output = price(pricing.output.as_deref())?;
    let mut cost = json!({"input": input, "output": output});
    if let Some(cache_read) = price(pricing.cache_read.as_deref()) {
        cost["cache_read"] = json!(cache_read);
    }
    if let Some(cache_write) = price(pricing.cache_write.as_deref()) {
        cost["cache_write"] = json!(cache_write);
    }
    Some(cost)
}

fn model_cost(model: Option<&openbitfun_core_types::ProviderCatalogModel>) -> Value {
    let pricing = model.and_then(|entry| entry.pricing.as_ref());
    json!({
        "input": price(pricing.and_then(|entry| entry.input.as_deref())).unwrap_or(0.0),
        "output": price(pricing.and_then(|entry| entry.output.as_deref())).unwrap_or(0.0),
        "cache": {
            "read": price(pricing.and_then(|entry| entry.cache_read.as_deref())).unwrap_or(0.0),
            "write": price(pricing.and_then(|entry| entry.cache_write.as_deref())).unwrap_or(0.0),
        },
    })
}

async fn load_models() -> Result<
    (
        Vec<crate::service::config::AIModelConfig>,
        HashMap<String, String>,
        openbitfun_core_types::ProviderCatalog,
    ),
    Failure,
> {
    use crate::service::config::{get_global_config_service, GlobalConfig};
    let service = get_global_config_service()
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let config: GlobalConfig = service
        .get_config(None)
        .await
        .map_err(|error| Failure::backend(error.to_string()))?;
    let primary = config.ai.default_models.primary;
    let mut defaults = HashMap::new();
    for model in config.ai.models.iter().filter(|model| model.enabled) {
        defaults
            .entry(model.provider.clone())
            .or_insert_with(|| model.id.clone());
    }
    if let Some(primary) = primary {
        if let Some(model) = config
            .ai
            .models
            .iter()
            .find(|model| model.enabled && model.id == primary)
        {
            defaults.insert(model.provider.clone(), model.id.clone());
        }
    }
    let catalog = crate::get_ai_model_catalog()
        .await
        .map_err(Failure::backend)?
        .provider_catalog;
    Ok((config.ai.models, defaults, catalog))
}

async fn config_providers() -> RouteResult {
    let (models, defaults, catalog) = load_models().await?;
    let providers = provider_projection(&models, &catalog, true)
        .into_iter()
        .map(|provider| {
            let id = provider["id"].as_str().unwrap_or_default();
            let models = provider["models"].clone();
            json!({
                "id": id,
                "name": id,
                "source": "config",
                "env": [],
                "options": {},
                "models": models,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"providers": providers, "default": defaults}))
}

async fn provider_list() -> RouteResult {
    let (models, defaults, catalog) = load_models().await?;
    let all = provider_projection(&models, &catalog, false);
    // Configured model records are not proof of live credentials or network
    // connectivity. Until the provider owner exposes that fact, project an
    // honest empty connected set instead of claiming every provider is live.
    Ok(json!({"all": all, "default": defaults, "connected": []}))
}

async fn enabled_tools() -> Vec<std::sync::Arc<dyn crate::agentic::tools::Tool>> {
    let mut tools = Vec::new();
    for tool in crate::agentic::tools::registry::get_all_registered_tools().await {
        if tool.is_enabled().await {
            tools.push(tool);
        }
    }
    tools
}

async fn tool_ids() -> RouteResult {
    Ok(json!(enabled_tools()
        .await
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>()))
}

async fn tool_list(query: &HashMap<String, Vec<String>>) -> RouteResult {
    required_query(query, "provider")?;
    required_query(query, "model")?;
    let mut output = Vec::new();
    for tool in enabled_tools().await {
        output.push(json!({
            "id": tool.name(),
            "description": tool.description().await.unwrap_or_else(|_| tool.short_description()),
            "parameters": tool.input_schema(),
        }));
    }
    Ok(Value::Array(output))
}

#[derive(serde::Deserialize)]
struct AppLogBody {
    service: String,
    level: String,
    message: String,
}

fn app_log(context: &PluginHostInstance, body: &[u8]) -> RouteResult {
    let input: AppLogBody = body_as(body)?;
    if input.service.trim().is_empty()
        || input.message.trim().is_empty()
        || input.message.len() > 16 * 1024
    {
        return Err(Failure::bad_request(
            "Log service and message must be non-empty and bounded",
        ));
    }
    let message = input.message.replace(['\r', '\n'], " ");
    match input.level.to_ascii_lowercase().as_str() {
        "debug" => log::debug!(
            "Plugin app log: instance_id={}, service={}, message={}",
            context.instance_id,
            input.service,
            message
        ),
        "info" => log::info!(
            "Plugin app log: instance_id={}, service={}, message={}",
            context.instance_id,
            input.service,
            message
        ),
        "warn" => log::warn!(
            "Plugin app log: instance_id={}, service={}, message={}",
            context.instance_id,
            input.service,
            message
        ),
        "error" => log::error!(
            "Plugin app log: instance_id={}, service={}, message={}",
            context.instance_id,
            input.service,
            message
        ),
        _ => return Err(Failure::bad_request("Unsupported log level")),
    }
    Ok(json!(true))
}

async fn agent_list(context: &PluginHostInstance) -> RouteResult {
    let registry = crate::agentic::agents::get_agent_registry();
    let mut entries = registry
        .get_modes_info_for_workspace(Some(&context.workspace_id), true)
        .await
        .into_iter()
        .map(|agent| (agent, "primary"))
        .collect::<Vec<_>>();
    entries.extend(
        registry
            .get_subagents_info(Some(&context.workspace_id))
            .await
            .into_iter()
            .filter(|agent| agent.effective_enabled)
            .map(|agent| (agent, "subagent")),
    );
    Ok(Value::Array(
        entries
            .into_iter()
            .map(|(agent, mode)| {
                let tools = agent
                    .default_tools
                    .into_iter()
                    .map(|tool| (tool, Value::Bool(true)))
                    .collect::<serde_json::Map<_, _>>();
                json!({
                    "name": agent.id,
                    "description": agent.description,
                    "mode": mode,
                    "builtIn": matches!(agent.source, crate::agentic::agents::AgentSource::Builtin),
                    "tools": tools,
                    "options": {},
                })
            })
            .collect(),
    ))
}

async fn command_list(context: &PluginHostInstance) -> RouteResult {
    let snapshot =
        crate::external_sources::external_source_snapshot(Some(&context.workspace_id), false)
            .await
            .map_err(Failure::backend)?;
    Ok(Value::Array(
        snapshot
            .commands
            .into_iter()
            .filter_map(|entry| {
                if !matches!(
                    entry.definition.availability,
                    crate::external_sources::PromptCommandAvailability::Available
                ) {
                    return None;
                }
                Some(json!({
                    "name": entry.definition.name,
                    "description": entry.definition.description,
                    "template": entry.definition.template,
                    "subtask": !entry.definition.execution_target.is_inline(),
                }))
            })
            .collect(),
    ))
}

// Session, PTY, filesystem, and MCP route implementations follow below.

include!("plugin_host_http_routes_impl.rs");

#[cfg(test)]
mod tests {
    use super::{
        app_log, assistant_parts, file_list, file_read, find_files, find_text, lsp_status,
        parse_pty_shell, project_list, project_value, provider_projection, pty_create, pty_value,
        resolve_scoped_path, search_line_offsets, session_create, session_update, tool_list,
    };
    use crate::plugin_host::PluginHostInstance;
    use crate::service::session::{ModelRoundData, ToolCallData, ToolItemData, ToolResultData};
    use openbitfun_services_core::filesystem::{FileSearchResult, SearchMatchType};
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use terminal_core::{SessionResponse, SessionSource, ShellType};

    fn instance(directory: PathBuf, instance_id: &str, project_id: &str) -> PluginHostInstance {
        let directory = dunce::canonicalize(directory).expect("canonical temporary workspace");
        PluginHostInstance {
            workspace_id: project_id.to_owned(),
            canonical_directory: directory.to_string_lossy().into_owned(),
            directory: directory.clone(),
            worktree: directory,
            project_id: project_id.to_string(),
            created_at_ms: 1,
            instance_id: instance_id.to_string(),
            host_generation: 1,
            generation_key: "generation-test".to_string(),
            revision: "revision-test".to_string(),
            registration_batch: None,
            ready: true,
            hook_commit_token: None,
            transformed_config_health_snapshot: None,
            diagnostic_health_snapshot: Vec::new(),
            tool_names: Vec::new(),
            agent_runtime_keys: Vec::new(),
            retirement_scheduled: false,
        }
    }

    #[tokio::test]
    async fn project_list_isolated_to_current_instance() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let context = instance(directory.path().to_path_buf(), "instance-a", "project-a");

        let value = project_list(&context).await.expect("project list");

        assert_eq!(value.as_array().map(Vec::len), Some(1));
        assert_eq!(value[0]["id"], "project-a");
    }

    #[tokio::test]
    async fn lsp_route_reports_retired_capability_without_restoring_runtime() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let context = instance(directory.path().to_path_buf(), "instance-a", "project-a");

        let failure = lsp_status(&context)
            .await
            .expect_err("explore keeps LSP retired");

        assert!(failure.message().contains("retired"));
    }

    #[test]
    fn project_current_projects_only_instance_bound_workspace_data() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let context = instance(directory.path().to_path_buf(), "instance-a", "project-a");

        let value = project_value(&context);

        assert_eq!(value["id"], "project-a");
        assert_eq!(
            value["worktree"],
            context.worktree.to_string_lossy().as_ref()
        );
        assert!(value.get("vcsDir").is_none());
        assert!(value.get("vcs").is_none());
        assert_eq!(value["time"]["created"], 1);
        assert!(value.get("directory").is_none());
    }

    #[test]
    fn scoped_path_rejects_traversal_and_sibling_prefixes() {
        let directory = tempfile::tempdir().expect("temporary root");
        let workspace = directory.path().join("project");
        let sibling = directory.path().join("project-sibling");
        std::fs::create_dir_all(&workspace).expect("workspace");
        std::fs::create_dir_all(&sibling).expect("sibling");
        let context = instance(workspace, "instance-a", "project-a");

        assert!(resolve_scoped_path(&context, "../project-sibling").is_err());
        assert!(resolve_scoped_path(&context, &sibling.to_string_lossy()).is_err());
    }

    #[test]
    fn provider_projection_omits_credentials() {
        let model = crate::service::config::AIModelConfig {
            id: "model-a".to_string(),
            name: "Model A".to_string(),
            provider: "provider-a".to_string(),
            model_name: "upstream-model-a".to_string(),
            base_url: "https://example.invalid/v1".to_string(),
            api_key: "secret-api-key".to_string(),
            custom_headers: Some(std::collections::HashMap::from([(
                "authorization".to_string(),
                "secret-header".to_string(),
            )])),
            enabled: true,
            ..Default::default()
        };

        let value = serde_json::to_string(&provider_projection(
            &[model],
            &openbitfun_core_types::ProviderCatalog::default(),
            true,
        ))
        .expect("provider projection");

        assert!(!value.contains("secret-api-key"));
        assert!(!value.contains("secret-header"));
        assert!(!value.to_ascii_lowercase().contains("authorization"));
    }

    #[test]
    fn app_log_validates_body_and_supported_levels() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let context = instance(directory.path().to_path_buf(), "instance-a", "project-a");

        for level in ["debug", "info", "warn", "error"] {
            let body = serde_json::to_vec(&json!({
                "service": "route-test",
                "level": level,
                "message": "line one\nline two",
            }))
            .expect("log body");
            assert_eq!(app_log(&context, &body).expect("accepted log"), json!(true));
        }

        for body in [
            json!({"service": "", "level": "info", "message": "message"}),
            json!({"service": "route-test", "level": "trace", "message": "message"}),
            json!({"service": "route-test", "level": "info", "message": ""}),
        ] {
            let body = serde_json::to_vec(&body).expect("invalid log body");
            assert!(app_log(&context, &body).is_err());
        }
        assert!(app_log(&context, b"not-json").is_err());
    }

    #[tokio::test]
    async fn handlers_reject_missing_required_inputs_before_service_access() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let context = instance(directory.path().to_path_buf(), "instance-a", "project-a");
        let query = HashMap::new();

        assert!(tool_list(&query).await.is_err());
        assert!(find_text(&context, &query).await.is_err());
        assert!(find_files(&context, &query).await.is_err());
        assert!(file_list(&context, &query).await.is_err());
        assert!(file_read(&context, &query).await.is_err());
        assert!(
            session_create(&context, br#"{"parentID":"session-parent"}"#)
                .await
                .is_err()
        );
        assert!(session_update(&context, "session-a", b"{}").await.is_err());
        assert!(pty_create(&context, br#"{"args":["--version"]}"#)
            .await
            .is_err());
        assert!(parse_pty_shell("unsupported-plugin-shell").is_err());
    }

    #[tokio::test]
    async fn file_read_returns_workspace_text_content() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let file = directory.path().join("fixture.txt");
        tokio::fs::write(&file, "plugin route fixture")
            .await
            .expect("write fixture");
        let context = instance(directory.path().to_path_buf(), "instance-a", "project-a");
        let query = HashMap::from([("path".to_string(), vec!["fixture.txt".to_string()])]);

        let value = file_read(&context, &query).await.expect("file response");

        assert_eq!(value["type"], "text");
        assert_eq!(value["content"], "plugin route fixture");
    }

    #[test]
    fn assistant_parts_project_completed_tool_state() {
        let tool = ToolItemData {
            id: "tool-item".to_string(),
            tool_name: "demo_tool".to_string(),
            tool_call: ToolCallData {
                input: json!({"value": 7}),
                id: "call-1".to_string(),
            },
            tool_result: Some(ToolResultData {
                result: json!({"echo": 7}),
                success: true,
                result_for_assistant: Some("echoed".to_string()),
                image_attachments: None,
                error: None,
                duration_ms: Some(2),
            }),
            ai_intent: Some("Echo value".to_string()),
            start_time: 10,
            end_time: Some(12),
            duration_ms: Some(2),
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: Some(2),
            order_index: Some(0),
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            subagent_dialog_turn_id: None,
            attempt_id: None,
            attempt_index: None,
            subagent_model_id: None,
            subagent_model_display_name: None,
            status: Some("completed".to_string()),
            interruption_reason: None,
        };
        let turn = crate::service::session::DialogTurnData {
            turn_id: "assistant-message".to_string(),
            turn_index: 0,
            session_id: "session-a".to_string(),
            timestamp: 10,
            kind: Default::default(),
            agent_type: Some("Standard".to_string()),
            user_message: crate::service::session::UserMessageData {
                id: "user-message".to_string(),
                content: "hello".to_string(),
                timestamp: 9,
                metadata: None,
            },
            model_rounds: vec![ModelRoundData {
                id: "round-a".to_string(),
                turn_id: "assistant-message".to_string(),
                round_index: 0,
                round_group_id: None,
                timestamp: 10,
                text_items: Vec::new(),
                tool_items: vec![tool],
                thinking_items: Vec::new(),
                start_time: 10,
                end_time: Some(12),
                duration_ms: Some(2),
                provider_id: Some("provider-a".to_string()),
                model_config_id: Some("model-a".to_string()),
                effective_model_name: None,
                first_chunk_ms: None,
                first_visible_output_ms: None,
                stream_duration_ms: None,
                attempt_count: None,
                attempt_diagnostics: Vec::new(),
                failure_category: None,
                token_details: None,
                status: "completed".to_string(),
            }],
            start_time: 10,
            end_time: Some(12),
            duration_ms: Some(2),
            token_usage: None,
            finish_reason: Some("stop".to_string()),
            has_final_response: Some(true),
            error: None,
            error_detail: None,
            recovery: None,
            recovery_epoch: None,
            status: crate::service::session::TurnStatus::Completed,
        };

        let parts = assistant_parts(&turn, "assistant-message");

        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "tool");
        assert_eq!(parts[0]["state"]["status"], "completed");
        assert_eq!(parts[0]["state"]["input"]["value"], 7);
        assert_eq!(parts[0]["state"]["output"], "echoed");
    }

    #[test]
    fn pty_running_states_are_projected_as_running() {
        for status in ["Starting", "Active", "Orphaned", "Restoring", "Terminating"] {
            let value = pty_value(&SessionResponse {
                workspace_id: Some("workspace-pty".into()),
                id: "pty-a".to_string(),
                name: "PTY A".to_string(),
                shell_type: ShellType::Bash,
                cwd: "/workspace".to_string(),
                initial_cwd: None,
                pid: Some(42),
                status: status.to_string(),
                cols: 80,
                rows: 24,
                source: SessionSource::default(),
            });
            assert_eq!(value["status"], "running");
        }
    }

    #[tokio::test]
    async fn search_offsets_use_file_byte_positions() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let file = directory.path().join("search.txt");
        tokio::fs::write(&file, "abc\nxx needle yy\n")
            .await
            .expect("search fixture");
        let path = file.to_string_lossy().into_owned();
        let offsets = search_line_offsets(&[FileSearchResult {
            path: path.clone(),
            name: "search.txt".to_string(),
            is_directory: false,
            match_type: SearchMatchType::Content,
            line_number: Some(2),
            matched_content: Some("xx needle yy".to_string()),
            preview_before: None,
            preview_inside: None,
            preview_after: None,
        }])
        .await
        .expect("line offsets");

        assert_eq!(offsets.get(&(path, 2)), Some(&4));
    }
}
