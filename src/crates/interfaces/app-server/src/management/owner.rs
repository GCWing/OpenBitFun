//! App Server management adapter over the existing product owners.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use openbitfun_app_server_protocol::account::*;
use openbitfun_app_server_protocol::agent::{
    AgentModeSummary, ListAgentModesRequest, ListAgentModesResponse,
};
use openbitfun_app_server_protocol::external_source::*;
use openbitfun_app_server_protocol::hook::*;
use openbitfun_app_server_protocol::mcp::*;
use openbitfun_app_server_protocol::model::*;
use openbitfun_app_server_protocol::skill::*;
use openbitfun_app_server_protocol::subagent::*;
use openbitfun_app_server_protocol::worktree::*;
use openbitfun_core::service::config::model_projection::{
    model_catalog_projection, model_edit_projection, model_list_projection, selector_is_unset,
};
use openbitfun_core::service::remote_connect::account_runtime::AccountRuntime;

use super::{
    AppManagementCapabilities, AppManagementError, AppManagementResult, ACCOUNT_CAPABILITY,
    WORKTREES_CAPABILITY,
};

/// Management adapter shared by App Server, Embedded, and local Shared Hosts.
///
/// The service delegates to the existing config, registry, MCP, and external
/// source owners. Local-only capabilities must be enabled through the local
/// Host constructor; constructing an App Server does not enable them by default.
pub struct AppManagementService {
    config: Arc<openbitfun_core::service::config::ConfigService>,
    mcp: Option<Arc<openbitfun_core::service::mcp::MCPService>>,
    external_source_updates: tokio::sync::broadcast::Sender<(
        String,
        openbitfun_product_domains::external_sources::ExternalSourcePublicSnapshot,
    )>,
    external_source_subscriptions: Arc<Mutex<HashSet<String>>>,
    account: Option<Arc<AccountRuntime>>,
    local_worktrees_enabled: bool,
}

impl AppManagementService {
    pub async fn load() -> Result<Self> {
        Self::load_inner(None, false).await
    }

    pub async fn load_for_local_host(account: Option<Arc<AccountRuntime>>) -> Result<Self> {
        Self::load_inner(account, true).await
    }

    async fn load_inner(
        account: Option<Arc<AccountRuntime>>,
        local_worktrees_enabled: bool,
    ) -> Result<Self> {
        let config = openbitfun_core::service::config::get_global_config_service()
            .await
            .context("Failed to load the Host management configuration owner")?;
        let (external_source_updates, _) = tokio::sync::broadcast::channel(64);
        Ok(Self {
            config,
            mcp: openbitfun_core::service::mcp::get_global_mcp_service(),
            external_source_updates,
            external_source_subscriptions: Arc::new(Mutex::new(HashSet::new())),
            account,
            local_worktrees_enabled,
        })
    }

    fn account_runtime(&self, capability: &str) -> AppManagementResult<&Arc<AccountRuntime>> {
        self.account
            .as_ref()
            .ok_or_else(|| AppManagementError::unsupported(format!("{capability} is unavailable")))
    }

    fn require_local_worktrees(&self) -> AppManagementResult<()> {
        if self.local_worktrees_enabled {
            Ok(())
        } else {
            Err(AppManagementError::unsupported(format!(
                "{WORKTREES_CAPABILITY} is unavailable"
            )))
        }
    }

    async fn model_config(
        &self,
        model_id: &str,
    ) -> AppManagementResult<openbitfun_core::service::config::AIModelConfig> {
        self.config
            .get_ai_models()
            .await
            .map_err(core_error)
            .and_then(|models| {
                models
                    .into_iter()
                    .find(|model| model.id == model_id)
                    .ok_or_else(|| {
                        AppManagementError::not_found(format!(
                            "AI model '{model_id}' was not found"
                        ))
                    })
            })
    }

    pub fn subscribe_external_source_updates(
        &self,
    ) -> tokio::sync::broadcast::Receiver<(
        String,
        openbitfun_product_domains::external_sources::ExternalSourcePublicSnapshot,
    )> {
        self.external_source_updates.subscribe()
    }

    async fn ensure_external_source_subscription(
        &self,
        workspace: &str,
    ) -> AppManagementResult<()> {
        let workspace_path = workspace.to_owned();
        {
            let mut subscriptions = self
                .external_source_subscriptions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !subscriptions.insert(workspace_path.clone()) {
                return Ok(());
            }
        }
        let mut subscription =
            match openbitfun_core::external_sources::subscribe_external_source_updates(Some(
                workspace,
            ))
            .await
            {
                Ok(subscription) => subscription,
                Err(error) => {
                    self.external_source_subscriptions
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&workspace_path);
                    return Err(external_source_string_error(error));
                }
            };
        let updates = self.external_source_updates.clone();
        let subscriptions = self.external_source_subscriptions.clone();
        tokio::spawn(async move {
            loop {
                match subscription.recv().await {
                    Ok(snapshot) => {
                        let _ = updates.send((
                            workspace_path.clone(),
                            openbitfun_product_domains::external_sources::ExternalSourcePublicSnapshot::from(snapshot),
                        ));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            subscriptions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&workspace_path);
        });
        Ok(())
    }
}

fn external_source_error(
    error: openbitfun_product_domains::external_sources::ExternalSourceOperationError,
) -> AppManagementError {
    use openbitfun_product_domains::external_sources::ExternalSourceOperationErrorCode as Code;
    let encoded = error.encode();
    match error.code {
        Code::InvalidRequest => AppManagementError::invalid_request(encoded),
        Code::NotFound => AppManagementError::not_found(encoded),
        Code::HostCapabilityUnavailable | Code::Unsupported => {
            AppManagementError::unsupported(encoded)
        }
        _ => AppManagementError::internal(encoded),
    }
}

fn external_source_string_error(error: String) -> AppManagementError {
    external_source_error(
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error),
    )
}

fn external_source_string_error_with_id(error: String, operation_id: &str) -> AppManagementError {
    let mut typed =
        openbitfun_core::external_sources::sanitize_external_source_operation_error(error);
    if typed.correlation_id.is_none() {
        typed = typed.with_correlation_id(operation_id);
    } else if typed.causation_id.is_none() {
        typed = typed.with_causation_id(operation_id);
    }
    external_source_error(typed)
}

fn validate_external_operation(operation_id: &str) -> AppManagementResult<()> {
    openbitfun_app_server_protocol::external_source::validate_operation_id(operation_id)
        .map_err(AppManagementError::invalid_request)
}

const MAX_NATIVE_HOOK_COMMAND_CHARS: usize = 200;
const MAX_NATIVE_HOOK_STATUS_CHARS: usize = 200;

fn bounded_native_hook_text(value: &str, max_chars: usize) -> (String, bool) {
    let value = value.trim();
    let truncated = value.chars().count() > max_chars;
    let mut summary = value
        .chars()
        .take(max_chars)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    if truncated {
        summary.push_str("...");
    }
    (summary, truncated)
}

fn managed_hook_location(path: &Path) -> String {
    let import_id = path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .map(|value| value.to_string_lossy())
        .map(|value| {
            value
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                        character
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "import".to_string());
    format!("<managed-hooks>/{import_id}/hooks.json")
}

fn native_hook_location(path: &Path, workspace: &Path, user_hooks_file: Option<&Path>) -> String {
    if user_hooks_file.is_some_and(|user| user == path) {
        return "<user-config>/config/hooks.json".to_string();
    }
    if let Ok(relative) = path.strip_prefix(workspace) {
        let relative = relative.to_string_lossy().replace('\\', "/");
        return if relative.is_empty() {
            "<workspace>".to_string()
        } else {
            format!("<workspace>/{relative}")
        };
    }
    managed_hook_location(path)
}

fn project_native_hook_overview(
    overview: openbitfun_core::native_hooks::NativeHookOverview,
    workspace: &Path,
) -> NativeHookOverview {
    let user_hooks_file = openbitfun_core::infrastructure::try_get_path_manager_arc()
        .ok()
        .map(|manager| manager.user_hooks_file());
    let path_labels = overview
        .files
        .iter()
        .map(|file| {
            (
                file.path.clone(),
                native_hook_location(&file.path, workspace, user_hooks_file.as_deref()),
            )
        })
        .collect::<Vec<_>>();
    let sanitize_issue = |issue: String| {
        path_labels.iter().fold(issue, |sanitized, (path, label)| {
            let native = path.to_string_lossy();
            let sanitized = sanitized.replace(native.as_ref(), label);
            sanitized.replace(&native.replace('\\', "/"), label)
        })
    };

    NativeHookOverview {
        enabled: overview.enabled,
        project_hooks_enabled: overview.project_hooks_enabled,
        files: overview
            .files
            .into_iter()
            .zip(path_labels.iter())
            .map(|(file, (_, location))| NativeHookFileSummary {
                scope: file.scope.to_string(),
                location: location.clone(),
                exists: file.exists,
                loaded: file.loaded,
            })
            .collect(),
        rules: overview
            .rules
            .into_iter()
            .map(|rule| NativeHookRuleSummary {
                event: rule.event.to_string(),
                matcher: rule.matcher,
                matcher_is_valid: rule.matcher_is_valid,
                scope: rule.scope.to_string(),
                handlers: rule
                    .handlers
                    .into_iter()
                    .map(|handler| {
                        let (command_summary, command_truncated) = bounded_native_hook_text(
                            &handler.command,
                            MAX_NATIVE_HOOK_COMMAND_CHARS,
                        );
                        NativeHookHandlerSummary {
                            command_summary,
                            command_truncated,
                            timeout_seconds: handler.timeout_seconds,
                            status_message: handler.status_message.map(|message| {
                                bounded_native_hook_text(&message, MAX_NATIVE_HOOK_STATUS_CHARS).0
                            }),
                        }
                    })
                    .collect(),
            })
            .collect(),
        total_handlers: overview.total_handlers,
        issues: overview.issues.into_iter().map(sanitize_issue).collect(),
    }
}

async fn external_source_preferences() -> AppManagementResult<ExternalSourceConflictPreferences> {
    openbitfun_core::external_sources::external_source_conflict_choices()
        .await
        .map(
            |(choices, lineage_current_keys, conflicted_candidate_ids)| {
                ExternalSourceConflictPreferences {
                    choices,
                    lineage_current_keys,
                    conflicted_candidate_ids,
                }
            },
        )
        .map_err(external_source_string_error)
}

async fn external_source_snapshot_response(
    workspace: &str,
    force_refresh: bool,
) -> AppManagementResult<ExternalSourceSnapshotResponse> {
    let surface = openbitfun_core::external_sources::get_external_source_control_snapshot(
        Some(workspace),
        force_refresh,
        openbitfun_product_domains::external_sources::ExternalSourceHostCapabilities::read_write(),
    )
    .await
    .map_err(external_source_error)?;
    Ok(ExternalSourceSnapshotResponse {
        control: surface.control,
        snapshot: surface.catalog,
        preferences: external_source_preferences().await?,
    })
}

fn core_error(error: openbitfun_core::OpenBitFunError) -> AppManagementError {
    AppManagementError::internal(sanitize_management_error(error.to_string()))
}

fn sanitize_management_error(error: impl AsRef<str>) -> String {
    let value = error.as_ref();
    if value.to_ascii_lowercase().contains("api key")
        || value.to_ascii_lowercase().contains("authorization")
        || value.to_ascii_lowercase().contains("header")
    {
        "The management owner rejected the request".to_string()
    } else {
        value.to_string()
    }
}

fn secret_update_value(
    update: Option<SecretUpdate>,
    existing: Option<String>,
) -> AppManagementResult<String> {
    Ok(match update.unwrap_or(SecretUpdate::Preserve) {
        SecretUpdate::Preserve => Ok(existing.unwrap_or_default()),
        SecretUpdate::Replace(value) => Ok(value),
        SecretUpdate::Clear => Ok(String::new()),
    }?)
}

fn headers_update(
    update: Option<SecretUpdate>,
    existing: Option<HashMap<String, String>>,
) -> AppManagementResult<Option<HashMap<String, String>>> {
    match update.unwrap_or(SecretUpdate::Preserve) {
        SecretUpdate::Preserve => Ok(existing),
        SecretUpdate::Clear => Ok(None),
        SecretUpdate::Replace(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| AppManagementError::invalid_request("Custom headers must be valid JSON")),
    }
}

fn string_update(
    update: Option<SecretUpdate>,
    existing: Option<String>,
) -> AppManagementResult<Option<String>> {
    match update.unwrap_or(SecretUpdate::Preserve) {
        SecretUpdate::Preserve => Ok(existing),
        SecretUpdate::Clear => Ok(None),
        SecretUpdate::Replace(value) => Ok((!value.is_empty()).then_some(value)),
    }
}

fn model_from_mutation(
    mutation: ModelMutation,
    existing: Option<openbitfun_core::service::config::AIModelConfig>,
) -> AppManagementResult<openbitfun_core::service::config::AIModelConfig> {
    let current = existing.unwrap_or_default();
    let api_key = secret_update_value(mutation.api_key, Some(current.api_key))?;
    let custom_headers = headers_update(mutation.custom_headers, current.custom_headers)?;
    let custom_request_body =
        string_update(mutation.custom_request_body, current.custom_request_body)?;
    Ok(openbitfun_core::service::config::AIModelConfig {
        id: mutation.id,
        name: mutation.name,
        provider: mutation.provider,
        model_name: mutation.model_name,
        base_url: mutation.base_url,
        request_url: current.request_url,
        api_key,
        context_window: mutation.context_window,
        max_tokens: mutation.max_tokens,
        temperature: current.temperature,
        top_p: current.top_p,
        enabled: mutation.enabled,
        category: current.category,
        capabilities: current.capabilities,
        recommended_for: current.recommended_for,
        metadata: current.metadata,
        reasoning: mutation.reasoning,
        inline_think_in_text: mutation.inline_think_in_text,
        custom_headers,
        custom_headers_mode: mutation.custom_headers_mode.or(current.custom_headers_mode),
        skip_ssl_verify: mutation.skip_ssl_verify,
        custom_request_body,
        custom_request_body_mode: current.custom_request_body_mode,
        auth: current.auth,
    })
}

fn validate_model_update_identity(
    model_id: &str,
    mutation: &ModelMutation,
) -> AppManagementResult<()> {
    if mutation.id != model_id {
        return Err(AppManagementError::invalid_request(
            "Model update identity does not match the request target",
        ));
    }
    Ok(())
}

fn skill_from_info(
    info: openbitfun_core::agentic::tools::implementations::skills::SkillInfo,
) -> SkillSummary {
    SkillSummary {
        key: info.key,
        name: info.name,
        description: info.description,
        level: info.level.as_str().to_string(),
        source_slot: Some(info.source_slot),
        source_label: Some(info.source_label),
        enabled: true,
        selected_for_runtime: true,
        default_enabled: true,
        is_shadowed: info.is_shadowed,
        shadowed_by_key: info.shadowed_by_key,
        argument_hint: info.argument_hint,
    }
}

fn skill_from_mode_info(
    info: openbitfun_core::agentic::tools::implementations::skills::ModeSkillInfo,
) -> SkillSummary {
    let skill = info.skill;
    SkillSummary {
        key: skill.key,
        name: skill.name,
        description: skill.description,
        level: skill.level.as_str().to_string(),
        source_slot: Some(skill.source_slot),
        source_label: Some(skill.source_label),
        enabled: info.effective_enabled,
        selected_for_runtime: info.selected_for_runtime,
        default_enabled: info.default_enabled,
        is_shadowed: skill.is_shadowed,
        shadowed_by_key: skill.shadowed_by_key,
        argument_hint: skill.argument_hint,
    }
}

fn subagent_from_info(info: openbitfun_core::agentic::agents::AgentInfo) -> SubagentSummary {
    let is_external =
        info.subagent_source == Some(openbitfun_core::agentic::agents::SubAgentSource::External);
    SubagentSummary {
        key: info.key,
        id: info.id,
        name: info.name,
        description: info.description,
        source: format!(
            "{:?}",
            info.subagent_source
                .unwrap_or(openbitfun_core::agentic::agents::SubAgentSource::Builtin)
        )
        .to_ascii_lowercase(),
        enabled: info.effective_enabled,
        is_external,
        supports_follow_up: info.supports_follow_up,
    }
}

fn native_mcp_detail(config: &openbitfun_core::service::mcp::MCPServerConfig) -> String {
    let server_type = format!("{:?}", config.server_type).to_ascii_lowercase();
    let transport = config.resolved_transport().as_str();
    if config.server_type == openbitfun_core::service::mcp::MCPServerType::Local {
        format!("type: {server_type}; transport: {transport}; command: {}; arguments: {}; environment variables set: {}",
            config.command.as_deref().unwrap_or("unknown"),
            config.args.len(),
            if config.env.is_empty() { "none" } else { "configured" })
    } else {
        let origin = config
            .url
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .and_then(|url| {
                let host = url.host_str()?;
                Some(match url.port() {
                    Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
                    None => format!("{}://{}", url.scheme(), host),
                })
            })
            .unwrap_or_else(|| "unknown".to_string());
        format!(
            "type: {server_type}; transport: {transport}; remote origin: {}; HTTP headers: {}",
            origin,
            if config.headers.is_empty() {
                "none"
            } else {
                "configured"
            }
        )
    }
}

fn external_mcp_action(
    entry: &openbitfun_product_domains::external_sources::ExternalMcpCatalogEntry,
    snapshot: &openbitfun_product_domains::external_sources::ExternalSourceCatalogSnapshot,
) -> McpServerAction {
    use openbitfun_product_domains::external_sources::ExternalMcpActivationState as State;
    match &entry.activation_state {
        State::ApprovalRequired | State::Declined | State::ConfigurationChanged => {
            McpServerAction::ExternalDecision {
                candidate_id: entry.candidate_id.clone(),
                decision_key: entry.decision_key.clone(),
                approved: true,
                expected_mcp_generation: snapshot.mcp_generation,
                expected_preference_revision: snapshot.preference_revision,
            }
        }
        State::Starting | State::Active | State::RuntimeUnavailable { .. } => {
            McpServerAction::ExternalDecision {
                candidate_id: entry.candidate_id.clone(),
                decision_key: entry.decision_key.clone(),
                approved: false,
                expected_mcp_generation: snapshot.mcp_generation,
                expected_preference_revision: snapshot.preference_revision,
            }
        }
        State::Conflict | State::Covered { .. } => snapshot
            .mcp_conflicts
            .iter()
            .find(|conflict| {
                conflict
                    .candidates
                    .iter()
                    .any(|candidate| candidate.candidate_id == entry.candidate_id)
            })
            .map(|conflict| McpServerAction::ConflictChoice {
                conflict_key: conflict.conflict_key.clone(),
                candidate_id: entry.candidate_id.clone(),
                approve_external: true,
                expected_mcp_generation: snapshot.mcp_generation,
                expected_preference_revision: snapshot.preference_revision,
            })
            .unwrap_or_else(|| McpServerAction::ReadOnly {
                reason: "Refresh to review the current conflict".to_string(),
            }),
        State::Unsupported { reason } => McpServerAction::ReadOnly {
            reason: format!("Not supported: {reason}"),
        },
        State::SourceDisabled => McpServerAction::ReadOnly {
            reason: "Enable this server in the source application".to_string(),
        },
        State::Removed => McpServerAction::ReadOnly {
            reason: "Removed".to_string(),
        },
        _ => McpServerAction::ReadOnly {
            reason: "This external MCP state is read-only".to_string(),
        },
    }
}

async fn external_mcp_status(
    entry: &openbitfun_product_domains::external_sources::ExternalMcpCatalogEntry,
    manager: &openbitfun_core::service::mcp::MCPServerManager,
) -> String {
    use openbitfun_product_domains::external_sources::ExternalMcpActivationState as State;
    match &entry.activation_state {
        State::Active => match entry.runtime_id.as_deref() {
            Some(id) => match tokio::time::timeout(
                std::time::Duration::from_millis(30),
                manager.get_server_status(id),
            )
            .await
            {
                Ok(Ok(value)) => format!("{value:?}"),
                Ok(Err(_)) => "Unavailable".to_string(),
                Err(_) => "Starting".to_string(),
            },
            None => "Enabled".to_string(),
        },
        State::ApprovalRequired => "Confirmation required".to_string(),
        State::Starting => "Starting".to_string(),
        State::Declined => "Kept disabled".to_string(),
        State::Conflict => "Choice required".to_string(),
        State::Covered { .. } => "Not selected".to_string(),
        State::SourceDisabled => "Source disabled".to_string(),
        State::ConfigurationChanged => "Changed; confirm again".to_string(),
        State::Unsupported { .. } => "Not supported".to_string(),
        State::RuntimeUnavailable { reason } => format!("Unavailable - {reason}"),
        State::Removed => "Removed".to_string(),
        _ => "Unavailable".to_string(),
    }
}

fn external_mcp_detail(
    entry: &openbitfun_product_domains::external_sources::ExternalMcpCatalogEntry,
) -> String {
    let definition = &entry.definition;
    match definition.transport {
        openbitfun_product_domains::external_sources::ExternalMcpTransportKind::LocalStdio => format!(
            "source MCP configuration; local command: {}; arguments: {}; environment variables set: {}",
            definition.command_preview.as_deref().unwrap_or("unknown"),
            definition.argument_count,
            if definition.environment_keys.is_empty() { "none" } else { "configured" },
        ),
        openbitfun_product_domains::external_sources::ExternalMcpTransportKind::StreamableHttp => format!(
            "source MCP configuration; remote origin: {}; HTTP headers: {}",
            definition.remote_url_preview.as_deref().unwrap_or("unknown"),
            if definition.header_names.is_empty() { "none" } else { "configured" },
        ),
        _ => "unsupported external MCP transport".to_string(),
    }
}

fn mcp_config_from_mutation(
    name: &str,
    mutation: McpServerMutation,
) -> AppManagementResult<openbitfun_core::service::mcp::MCPServerConfig> {
    let (server_type, transport) = match mutation.transport {
        McpTransport::Stdio => (
            openbitfun_core::service::mcp::MCPServerType::Local,
            openbitfun_core::service::mcp::MCPServerTransport::Stdio,
        ),
        McpTransport::Sse => (
            openbitfun_core::service::mcp::MCPServerType::Remote,
            openbitfun_core::service::mcp::MCPServerTransport::Sse,
        ),
        McpTransport::StreamableHttp => (
            openbitfun_core::service::mcp::MCPServerType::Remote,
            openbitfun_core::service::mcp::MCPServerTransport::StreamableHttp,
        ),
    };
    let oauth = mutation
        .oauth
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| {
            AppManagementError::invalid_request(
                "MCP OAuth configuration does not match the supported schema",
            )
        })?;
    let xaa = mutation
        .xaa
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| {
            AppManagementError::invalid_request(
                "MCP XAA configuration does not match the supported schema",
            )
        })?;
    Ok(openbitfun_core::service::mcp::MCPServerConfig {
        id: name.to_string(),
        name: name.to_string(),
        server_type,
        transport: Some(transport),
        command: mutation.command,
        args: mutation.args,
        env: mutation.env,
        working_directory: None,
        inherit_parent_environment: None,
        headers: mutation.headers,
        url: mutation.url,
        auto_start: mutation.auto_start,
        enabled: mutation.enabled,
        location: openbitfun_core::service::mcp::ConfigLocation::User,
        capabilities: Vec::new(),
        settings: HashMap::new(),
        oauth,
        oauth_enabled: None,
        xaa,
        timeouts: Default::default(),
    })
}

impl AppManagementService {
    pub fn capabilities(&self) -> AppManagementCapabilities {
        let mut capabilities = AppManagementCapabilities::available();
        if self.mcp.is_none() {
            capabilities.mcp =
                openbitfun_app_server_protocol::app::CapabilityAvailability::Unavailable {
                    reason: "The Host MCP owner is unavailable".to_string(),
                };
        }
        if self.account.is_none() {
            let reason = "The Host did not provide an account owner".to_string();
            capabilities.account =
                openbitfun_app_server_protocol::app::CapabilityAvailability::Unavailable {
                    reason: reason.clone(),
                };
        }
        if !self.local_worktrees_enabled {
            capabilities.worktrees =
                openbitfun_app_server_protocol::app::CapabilityAvailability::Unavailable {
                    reason: "The Host did not enable local Worktree management".to_string(),
                };
        }
        capabilities
    }

    pub async fn worktree_repository_status(
        &self,
        request: WorktreeRepositoryStatusRequest,
    ) -> AppManagementResult<WorktreeRepositoryStatusResponse> {
        self.require_local_worktrees()?;
        super::worktree::repository_status(request).await
    }

    pub async fn worktree_bind_session(
        &self,
        request: WorktreeBindSessionRequest,
    ) -> AppManagementResult<WorktreeBindingResponse> {
        self.require_local_worktrees()?;
        super::worktree::bind_session(request).await
    }

    pub async fn worktree_release_session(
        &self,
        request: WorktreeReleaseSessionRequest,
    ) -> AppManagementResult<WorktreeBindingResponse> {
        self.require_local_worktrees()?;
        super::worktree::release_session(request).await
    }

    pub async fn account_snapshot(
        &self,
        request: AccountSnapshotRequest,
    ) -> AppManagementResult<AccountSnapshotResponse> {
        let _ = request.workspace_path;
        Ok(project_account_snapshot(
            self.account_runtime(ACCOUNT_CAPABILITY)?.snapshot().await,
        ))
    }

    pub async fn account_github_start(
        &self,
        _request: AccountGitHubStartRequest,
    ) -> AppManagementResult<AccountGitHubStartResponse> {
        let authorization = self
            .account_runtime(ACCOUNT_CAPABILITY)?
            .start_github_auth()
            .await
            .map_err(internal_account_error)?;
        Ok(AccountGitHubStartResponse { authorization })
    }

    pub async fn account_github_poll(
        &self,
        request: AccountGitHubPollRequest,
    ) -> AppManagementResult<AccountGitHubPollResponse> {
        let result = self
            .account_runtime(ACCOUNT_CAPABILITY)?
            .poll_github_auth(request.transaction_id)
            .await
            .map_err(internal_account_error)?;
        Ok(AccountGitHubPollResponse {
            status: result.status,
        })
    }

    pub async fn account_login(
        &self,
        request: AccountLoginRequest,
    ) -> AppManagementResult<AccountLoginResponse> {
        validate_account_operation_id(&request.operation_id)?;
        let result = self
            .account_runtime(ACCOUNT_CAPABILITY)?
            .login_with_identity()
            .await
            .map_err(|error| internal_account_error(error))?;
        let status_message = account_login_status_message(&result);
        Ok(AccountLoginResponse {
            user_id: result.user_id,
            relay_url: result.relay_url,
            status_message,
        })
    }

    pub async fn account_logout(
        &self,
        request: AccountLogoutRequest,
    ) -> AppManagementResult<AccountSnapshotResponse> {
        validate_account_operation_id(&request.operation_id)?;
        let account = self.account_runtime(ACCOUNT_CAPABILITY)?;
        account.logout().await.map_err(internal_account_error)?;
        Ok(project_account_snapshot(account.snapshot().await))
    }

    pub async fn native_hook_overview(
        &self,
        request: NativeHookOverviewRequest,
    ) -> AppManagementResult<NativeHookOverviewResponse> {
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let workspace = record.id.as_str();
        let overview = openbitfun_core::native_hooks::overview(Some(workspace))
            .await
            .map_err(AppManagementError::invalid_request)?;
        Ok(NativeHookOverviewResponse(project_native_hook_overview(
            overview,
            &record.root_path,
        )))
    }

    pub async fn external_hook_snapshot(
        &self,
        request: ExternalHookSnapshotRequest,
    ) -> AppManagementResult<ExternalHookSnapshotResponse> {
        openbitfun_core::external_hook_import::external_hook_import_snapshot(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            request.refresh_updates,
        )
        .await
        .map(ExternalHookSnapshotResponse)
        .map_err(external_source_error)
    }

    pub async fn external_hook_plan(
        &self,
        request: ExternalHookPlanRequest,
    ) -> AppManagementResult<ExternalHookPlanResponse> {
        openbitfun_core::external_hook_import::plan_external_hook_import(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            request.source,
        )
        .await
        .map(ExternalHookPlanResponse)
        .map_err(external_source_error)
    }

    pub async fn external_hook_apply(
        &self,
        request: ExternalHookApplyRequest,
    ) -> AppManagementResult<ExternalHookApplyResponse> {
        validate_external_operation(&request.operation_id)?;
        openbitfun_core::external_hook_import::apply_external_hook_import(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            request.import_request,
        )
        .await
        .map(ExternalHookApplyResponse)
        .map_err(external_source_error)
    }

    pub async fn external_hook_mutate(
        &self,
        request: ExternalHookMutationRequest,
    ) -> AppManagementResult<ExternalHookMutationResponse> {
        validate_external_operation(&request.operation_id)?;
        openbitfun_core::external_hook_import::mutate_external_hook_import(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            request.mutation,
        )
        .await
        .map(ExternalHookMutationResponse)
        .map_err(external_source_error)
    }

    pub async fn external_source_snapshot(
        &self,
        request: ExternalSourceSnapshotRequest,
    ) -> AppManagementResult<ExternalSourceSnapshotResponse> {
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let workspace = record.id.as_str();
        self.ensure_external_source_subscription(workspace).await?;
        external_source_snapshot_response(workspace, request.force_refresh).await
    }

    pub async fn external_source_control(
        &self,
        request: ExternalSourceControlRequest,
    ) -> AppManagementResult<ExternalSourceControlResponse> {
        request
            .request
            .validate()
            .map_err(AppManagementError::invalid_request)?;
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let workspace = record.id.as_str();
        let surface = openbitfun_core::external_sources::apply_external_source_control_action(
            Some(workspace),
            request.request,
        )
        .await
        .map_err(external_source_error)?;
        Ok(ExternalSourceControlResponse {
            surface,
            snapshot: external_source_snapshot_response(workspace, false).await?,
        })
    }

    pub async fn external_source_review(
        &self,
        request: ExternalSourceReviewRequest,
    ) -> AppManagementResult<ExternalSourceReviewResponse> {
        validate_external_operation(&request.operation_id)?;
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let workspace = record.id.as_str();
        let operation_id = request.operation_id.clone();
        let result = match request.action {
            ExternalSourceReviewAction::Refresh => {
                openbitfun_core::external_sources::external_source_snapshot(Some(workspace), true)
                    .await
            }
            ExternalSourceReviewAction::SetPromptCommandConflictChoice {
                conflict_key,
                candidate_id,
                expected_preference_revision,
            } => {
                openbitfun_core::external_sources::set_external_prompt_command_conflict_choice(
                    Some(workspace),
                    &conflict_key,
                    &candidate_id,
                    expected_preference_revision,
                )
                .await
            }
            ExternalSourceReviewAction::SetToolTargetDecision {
                approval_key,
                decision_key,
                approved,
                expected_preference_revision,
            } => {
                openbitfun_core::external_sources::set_external_tool_target_decision(
                    Some(workspace),
                    &approval_key,
                    &decision_key,
                    approved,
                    expected_preference_revision,
                )
                .await
            }
            ExternalSourceReviewAction::SetToolConflictChoice {
                conflict_key,
                candidate_id,
                expected_preference_revision,
            } => {
                openbitfun_core::external_sources::set_external_tool_conflict_choice(
                    Some(workspace),
                    &conflict_key,
                    &candidate_id,
                    expected_preference_revision,
                )
                .await
            }
            ExternalSourceReviewAction::SetSubagentActivation {
                candidate_id,
                approved,
                expected_subagent_generation,
                expected_preference_revision,
                decision_key,
            } => {
                openbitfun_core::external_sources::set_external_subagent_activation(
                    Some(workspace),
                    &candidate_id,
                    approved,
                    expected_subagent_generation,
                    expected_preference_revision,
                    &decision_key,
                )
                .await
            }
            ExternalSourceReviewAction::SetSubagentModelBinding {
                binding_key,
                target,
                expected_subagent_generation,
                expected_preference_revision,
            } => {
                openbitfun_core::external_sources::set_external_subagent_model_binding(
                    Some(workspace),
                    &binding_key,
                    target,
                    expected_subagent_generation,
                    expected_preference_revision,
                )
                .await
            }
            ExternalSourceReviewAction::ChooseSubagentConflict {
                conflict_key,
                candidate_id,
                approve_external,
                expected_subagent_generation,
                expected_preference_revision,
            } => {
                openbitfun_core::external_sources::choose_external_subagent_conflict(
                    Some(workspace),
                    &conflict_key,
                    &candidate_id,
                    approve_external,
                    expected_subagent_generation,
                    expected_preference_revision,
                )
                .await
            }
        };
        result.map_err(|error| external_source_string_error_with_id(error, &operation_id))?;
        Ok(ExternalSourceReviewResponse(
            external_source_snapshot_response(workspace, false).await?,
        ))
    }

    pub async fn set_native_command_choice(
        &self,
        request: SetNativeCommandChoiceRequest,
    ) -> AppManagementResult<SetNativeCommandChoiceResponse> {
        validate_external_operation(&request.operation_id)?;
        let operation_id = request.operation_id.clone();
        let conflicts =
            openbitfun_core::external_sources::set_native_prompt_command_conflict_choice(
                Some(
                    &resolve_management_workspace(
                        request.workspace_id.as_deref(),
                        &request.workspace_path,
                    )
                    .await?
                    .id,
                ),
                request.native_commands,
                &request.selected_candidate_id,
                request.expected_preference_revision,
            )
            .await
            .map_err(|error| external_source_string_error_with_id(error, &operation_id))?;
        Ok(SetNativeCommandChoiceResponse {
            conflicts,
            preferences: external_source_preferences().await?,
        })
    }

    pub async fn expand_external_command(
        &self,
        request: ExpandExternalCommandRequest,
    ) -> AppManagementResult<ExpandExternalCommandResponse> {
        validate_external_operation(&request.operation_id)?;
        let operation_id = request.operation_id.clone();
        openbitfun_core::external_sources::expand_external_prompt_command(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            &request.command_name,
            &request.arguments,
            request.native_commands,
            request.candidate_id.as_deref(),
            request.content_version.as_deref(),
            request.native_conflict_key.as_deref(),
            request.expected_preference_revision,
            request.shell_review_decision.as_ref(),
        )
        .await
        .map(ExpandExternalCommandResponse)
        .map_err(|error| external_source_string_error_with_id(error, &operation_id))
    }

    pub async fn list_agent_modes(
        &self,
        request: ListAgentModesRequest,
    ) -> AppManagementResult<ListAgentModesResponse> {
        let record = if request.workspace_id.is_some() || request.workspace_path.is_some() {
            Some(
                resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    request.workspace_path.as_deref().unwrap_or_default(),
                )
                .await?,
            )
        } else {
            None
        };
        let include_external = request.include_external
            && record.as_ref().is_some_and(|record| {
                record.workspace_kind != openbitfun_core::service::workspace::WorkspaceKind::Remote
            });
        if include_external {
            if let Err(error) =
                openbitfun_core::external_sources::ensure_external_source_workspace_snapshot(
                    record.as_ref().map(|record| record.id.as_str()),
                )
                .await
            {
                tracing::warn!("Failed to initialize external agent sources: {error}");
            }
        }
        let modes = openbitfun_core::agentic::agents::get_agent_registry()
            .get_modes_info_for_workspace(
                record.as_ref().map(|record| record.id.as_str()),
                include_external,
            )
            .await
            .into_iter()
            .map(|mode| AgentModeSummary {
                id: mode.id,
                route_key: mode.key,
                description: mode.description,
                model_id: mode.model,
                is_external: mode.source == openbitfun_core::agentic::agents::AgentSource::External,
            })
            .collect();
        Ok(ListAgentModesResponse { modes })
    }

    pub async fn list_models(
        &self,
        _request: ListModelsRequest,
    ) -> AppManagementResult<ListModelsResponse> {
        let models = self.config.get_ai_models().await.map_err(core_error)?;
        let config: openbitfun_core::service::config::GlobalConfig =
            self.config.get_config(None).await.map_err(core_error)?;
        let projection = model_list_projection(&models, &config);
        Ok(ListModelsResponse {
            models: projection.models,
            primary_model_id: projection.primary_model_id,
            fast_model_id: projection.fast_model_id,
            mode_default_model_id: projection.mode_default_model_id,
        })
    }

    pub async fn get_model(
        &self,
        request: GetModelRequest,
    ) -> AppManagementResult<GetModelResponse> {
        Ok(GetModelResponse {
            model: model_edit_projection(&self.model_config(&request.model_id).await?),
        })
    }

    pub async fn tui_model_catalog(
        &self,
        _request: TuiModelCatalogRequest,
    ) -> AppManagementResult<TuiModelCatalogResponse> {
        let catalog = openbitfun_core::get_ai_model_catalog()
            .await
            .map_err(AppManagementError::internal)?;
        let projection = model_catalog_projection(catalog);
        Ok(TuiModelCatalogResponse {
            provider_catalog: projection.provider_catalog,
            reasoning_presets_by_model: projection.reasoning_presets_by_model,
        })
    }

    pub async fn project_reasoning_catalog(
        &self,
        request: ProjectReasoningCatalogRequest,
    ) -> AppManagementResult<ProjectReasoningCatalogResponse> {
        Ok(ProjectReasoningCatalogResponse {
            projection: openbitfun_core::project_ai_model_reasoning_catalog(request.0).await,
        })
    }

    pub async fn add_model(
        &self,
        request: AddModelRequest,
    ) -> AppManagementResult<AddModelResponse> {
        let model = model_from_mutation(request.model, None)?;
        let model_id = model.id.clone();
        self.config.add_ai_model(model).await.map_err(core_error)?;
        if request.make_primary_if_empty {
            let config: openbitfun_core::service::config::GlobalConfig =
                self.config.get_config(None).await.map_err(core_error)?;
            if selector_is_unset(&config.ai.default_models.primary) {
                self.config
                    .set_config("ai.default_models.primary", &Some(model_id))
                    .await
                    .map_err(core_error)?;
            }
        }
        Ok(AddModelResponse {})
    }

    pub async fn update_model(
        &self,
        request: UpdateModelRequest,
    ) -> AppManagementResult<UpdateModelResponse> {
        validate_model_update_identity(&request.model_id, &request.model)?;
        let existing = self.model_config(&request.model_id).await?;
        let model = model_from_mutation(request.model, Some(existing))?;
        self.config
            .update_ai_model(&request.model_id, model)
            .await
            .map_err(core_error)?;
        Ok(UpdateModelResponse {})
    }

    pub async fn delete_model(
        &self,
        request: DeleteModelRequest,
    ) -> AppManagementResult<DeleteModelResponse> {
        self.config
            .delete_ai_model(&request.model_id)
            .await
            .map_err(core_error)?;
        Ok(DeleteModelResponse {})
    }

    pub async fn set_model_default(
        &self,
        request: SetModelDefaultRequest,
    ) -> AppManagementResult<SetModelDefaultResponse> {
        match request.slot {
            ModelDefaultSlot::Primary => self
                .config
                .set_config("ai.default_models.primary", &request.model_id)
                .await
                .map_err(core_error)?,
            ModelDefaultSlot::Mode => self
                .config
                .set_config(
                    "ai.agent_model_defaults.mode",
                    request.model_id.as_deref().unwrap_or("primary"),
                )
                .await
                .map_err(core_error)?,
        }
        Ok(SetModelDefaultResponse {})
    }

    pub async fn list_skills(
        &self,
        request: ListSkillsRequest,
    ) -> AppManagementResult<ListSkillsResponse> {
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let remote =
            record.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote;
        if remote {
            return Err(AppManagementError::invalid_request(
                "This management operation is unsupported for remote workspaces",
            ));
        }
        let workspace = openbitfun_core::agentic::workspace::WorkspaceBinding::resolve(&record.id)
            .await
            .map_err(core_error)?;
        let registry =
            openbitfun_core::agentic::tools::implementations::skills::get_skill_registry();
        let skills = if request.manageable {
            registry
                .get_mode_skill_infos_for_workspace(
                    openbitfun_core::agentic::tools::implementations::skills::mode_overrides::SkillPolicyWorkspace::from_binding(&workspace),
                    &request.mode_id,
                )
                .await
                .into_iter()
                .map(skill_from_mode_info)
                .collect()
        } else {
            registry
                .get_user_invocable_skills_for_workspace(Some(&workspace), Some(&request.mode_id))
                .await
                .into_iter()
                .map(skill_from_info)
                .collect()
        };
        Ok(ListSkillsResponse { skills })
    }

    pub async fn set_skill_enabled(
        &self,
        request: SetSkillEnabledRequest,
    ) -> AppManagementResult<SetSkillEnabledResponse> {
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let remote =
            record.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote;
        if remote {
            return Err(AppManagementError::invalid_request(
                "This management operation is unsupported for remote workspaces",
            ));
        }
        match request.level.as_str() {
            "user" => {
                let _ = openbitfun_core::agentic::tools::implementations::skills::mode_overrides::set_user_mode_skill_state(
                    &request.mode_id,
                    &request.skill_key,
                    request.enabled,
                    request.default_enabled,
                )
                .await
                .map_err(core_error)?;
            }
            "project" => {
                let mut document = openbitfun_core::agentic::tools::implementations::skills::mode_overrides::load_project_mode_skills_document_local(&record.root_path)
                    .await
                    .map_err(core_error)?;
                openbitfun_core::agentic::tools::implementations::skills::mode_overrides::set_mode_skill_disabled_in_document(
                    &mut document,
                    &request.mode_id,
                    &request.skill_key,
                    !request.enabled,
                )
                .map_err(core_error)?;
                openbitfun_core::agentic::tools::implementations::skills::mode_overrides::save_project_mode_skills_document_local(
                    &record.root_path,
                    &document,
                )
                .await
                .map_err(core_error)?;
            }
            level => {
                return Err(AppManagementError::invalid_request(format!(
                    "Unsupported skill level '{level}'"
                )))
            }
        }
        Ok(SetSkillEnabledResponse {})
    }

    pub async fn list_subagents(
        &self,
        request: ListSubagentsRequest,
    ) -> AppManagementResult<ListSubagentsResponse> {
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let remote =
            record.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote;
        let scope = if request.management {
            openbitfun_core::agentic::agents::SubagentListScope::RegistryManagement
        } else {
            openbitfun_core::agentic::agents::SubagentListScope::TaskVisible
        };
        let values = openbitfun_core::agentic::agents::get_agent_registry()
            .get_subagents_for_query(&openbitfun_core::agentic::agents::SubagentQueryContext {
                parent_agent_type: Some(&request.parent_mode_id),
                workspace_id: (!remote).then_some(record.id.as_str()),
                list_scope: scope,
                include_disabled: request.management,
                external_sources_supported: !remote,
            })
            .await;
        let has_external = values.iter().any(|info| {
            info.subagent_source == Some(openbitfun_core::agentic::agents::SubAgentSource::External)
        });
        Ok(ListSubagentsResponse {
            subagents: values
                .into_iter()
                .filter(|info| {
                    !request.management
                        || info.subagent_source
                            != Some(openbitfun_core::agentic::agents::SubAgentSource::External)
                })
                .map(subagent_from_info)
                .collect(),
            has_external,
        })
    }

    pub async fn set_subagent_enabled(
        &self,
        request: SetSubagentEnabledRequest,
    ) -> AppManagementResult<SetSubagentEnabledResponse> {
        let record =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let remote =
            record.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote;
        if remote {
            return Err(AppManagementError::invalid_request(
                "This management operation is unsupported for remote workspaces",
            ));
        }
        openbitfun_core::agentic::agents::get_agent_registry()
            .update_subagent_override(
                &request.parent_mode_id,
                &request.subagent_id,
                request.enabled,
                Some(&record.id),
            )
            .await
            .map_err(core_error)?;
        Ok(SetSubagentEnabledResponse {})
    }

    pub async fn list_mcp_servers(
        &self,
        request: ListMcpServersRequest,
    ) -> AppManagementResult<ListMcpServersResponse> {
        let mcp = self
            .mcp
            .as_ref()
            .ok_or_else(|| AppManagementError::unsupported("The Host MCP owner is unavailable"))?;
        let workspace =
            resolve_management_workspace(request.workspace_id.as_deref(), &request.workspace_path)
                .await?;
        let external =
            openbitfun_core::external_sources::external_source_snapshot(Some(&workspace.id), false)
                .await
                .map_err(|error| AppManagementError::internal(sanitize_management_error(error)))?;
        let tool_registry = openbitfun_core::agentic::tools::registry::get_global_tool_registry();
        let tools = tool_registry.read().await.get_all_tools();
        let configs = mcp
            .config_service()
            .load_all_configs()
            .await
            .map_err(core_error)?;
        let manager = mcp.server_manager();
        let mut servers = Vec::new();
        for config in configs {
            let status = if !config.enabled {
                "Stopped".to_string()
            } else {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(30),
                    manager.get_server_status(&config.id),
                )
                .await
                {
                    Ok(Ok(value)) => format!("{value:?}"),
                    _ => "Starting".to_string(),
                }
            };
            let prefix = format!("mcp_{}_", config.id);
            let tool_count = tools
                .iter()
                .filter(|tool| tool.name().starts_with(&prefix))
                .count();
            let native_id = openbitfun_core::external_sources::native_mcp_candidate_id(&config.id);
            let conflict = external.mcp_conflicts.iter().find(|conflict| {
                conflict
                    .candidates
                    .iter()
                    .any(|candidate| candidate.candidate_id == native_id)
            });
            let action = match conflict {
                Some(conflict)
                    if conflict
                        .candidates
                        .iter()
                        .find(|candidate| candidate.candidate_id == native_id)
                        .is_some_and(|candidate| !candidate.available) =>
                {
                    let reason = conflict
                        .candidates
                        .iter()
                        .find(|candidate| candidate.candidate_id == native_id)
                        .and_then(|candidate| candidate.unavailable_reason.clone())
                        .unwrap_or_else(|| {
                            "Enable this OpenBitFun server in its MCP configuration".to_string()
                        });
                    McpServerAction::ReadOnly { reason }
                }
                Some(conflict) if conflict.selected_candidate_id.as_deref() != Some(&native_id) => {
                    McpServerAction::ConflictChoice {
                        conflict_key: conflict.conflict_key.clone(),
                        candidate_id: native_id,
                        approve_external: false,
                        expected_mcp_generation: external.mcp_generation,
                        expected_preference_revision: external.preference_revision,
                    }
                }
                _ => McpServerAction::NativeToggle,
            };
            servers.push(McpServerSummary {
                id: config.id.clone(),
                name: config.name.clone(),
                server_type: format!("{:?}", config.server_type).to_lowercase(),
                status,
                tool_count,
                source_label: "OpenBitFun".to_string(),
                external: false,
                detail: native_mcp_detail(&config),
                action,
            });
        }
        for entry in &external.mcp_servers {
            let source_label = external
                .sources
                .iter()
                .find(|source| source.record.key == entry.definition.id.source)
                .map(|source| source.record.display_name.clone())
                .unwrap_or_else(|| "External AI app".to_string());
            let action = external_mcp_action(&entry, &external);
            let status = external_mcp_status(&entry, manager.as_ref()).await;
            let tool_count = entry.runtime_id.as_deref().map_or(0, |runtime_id| {
                let prefix = format!("mcp_{runtime_id}_");
                tools
                    .iter()
                    .filter(|tool| tool.name().starts_with(&prefix))
                    .count()
            });
            servers.push(McpServerSummary {
                id: entry.candidate_id.clone(),
                name: entry.definition.name.clone(),
                server_type: "external".to_string(),
                status,
                tool_count,
                source_label,
                external: true,
                detail: external_mcp_detail(&entry),
                action,
            });
        }
        if servers.is_empty() && external.discovery_pending {
            servers.push(McpServerSummary {
                id: "external-mcp-discovery-pending".to_string(),
                name: "External MCP servers".to_string(),
                server_type: "external".to_string(),
                status: "Checking".to_string(),
                tool_count: 0,
                source_label: "External AI applications".to_string(),
                external: true,
                detail: "OpenBitFun is still checking compatible MCP settings".to_string(),
                action: McpServerAction::ReadOnly {
                    reason: "Still checking; this list updates automatically".to_string(),
                },
            });
        }
        let config_path = openbitfun_core::infrastructure::try_get_path_manager_arc()
            .ok()
            .map(|manager| manager.app_config_file().display().to_string());
        Ok(ListMcpServersResponse {
            servers,
            config_path,
        })
    }

    pub async fn toggle_mcp_server(
        &self,
        request: ToggleMcpServerRequest,
    ) -> AppManagementResult<ToggleMcpServerResponse> {
        let mcp = self
            .mcp
            .as_ref()
            .ok_or_else(|| AppManagementError::unsupported("The Host MCP owner is unavailable"))?;
        let manager = mcp.server_manager();
        match manager.get_server_status(&request.server_id).await {
            Ok(openbitfun_core::service::mcp::MCPServerStatus::Connected)
            | Ok(openbitfun_core::service::mcp::MCPServerStatus::Healthy) => {
                manager.stop_server(&request.server_id).await
            }
            _ => manager.start_server(&request.server_id).await,
        }
        .map_err(core_error)?;
        Ok(ToggleMcpServerResponse {})
    }

    pub async fn add_mcp_server(
        &self,
        request: AddMcpServerRequest,
    ) -> AppManagementResult<AddMcpServerResponse> {
        let mcp = self
            .mcp
            .as_ref()
            .ok_or_else(|| AppManagementError::unsupported("The Host MCP owner is unavailable"))?;
        let config = mcp_config_from_mutation(&request.name, request.config)?;
        mcp.server_manager()
            .add_server(config)
            .await
            .map_err(core_error)?;
        Ok(AddMcpServerResponse {})
    }

    pub async fn delete_mcp_server(
        &self,
        request: DeleteMcpServerRequest,
    ) -> AppManagementResult<DeleteMcpServerResponse> {
        let mcp = self
            .mcp
            .as_ref()
            .ok_or_else(|| AppManagementError::unsupported("The Host MCP owner is unavailable"))?;
        mcp.config_service()
            .delete_server_config(&request.server_id)
            .await
            .map_err(core_error)?;
        mcp.server_manager().schedule_stop_server(request.server_id);
        Ok(DeleteMcpServerResponse {})
    }

    pub async fn external_mcp_decision(
        &self,
        request: ExternalMcpDecisionRequest,
    ) -> AppManagementResult<ExternalMcpDecisionResponse> {
        openbitfun_core::external_sources::set_external_mcp_server_decision(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            &request.candidate_id,
            &request.decision_key,
            request.approved,
            request.expected_mcp_generation,
            request.expected_preference_revision,
        )
        .await
        .map_err(|error| AppManagementError::internal(sanitize_management_error(error)))?;
        Ok(ExternalMcpDecisionResponse {})
    }

    pub async fn mcp_conflict_choice(
        &self,
        request: McpConflictChoiceRequest,
    ) -> AppManagementResult<McpConflictChoiceResponse> {
        openbitfun_core::external_sources::choose_external_mcp_conflict(
            Some(
                &resolve_management_workspace(
                    request.workspace_id.as_deref(),
                    &request.workspace_path,
                )
                .await?
                .id,
            ),
            &request.conflict_key,
            &request.candidate_id,
            request.approve_external,
            request.expected_mcp_generation,
            request.expected_preference_revision,
        )
        .await
        .map_err(|error| AppManagementError::internal(sanitize_management_error(error)))?;
        Ok(McpConflictChoiceResponse {})
    }
}

fn project_account_snapshot(
    snapshot: openbitfun_core::service::remote_connect::account_runtime::AccountSnapshot,
) -> AccountSnapshotResponse {
    AccountSnapshotResponse {
        logged_in: snapshot.logged_in,
        info: snapshot.info.map(|info| AccountInfo {
            user_id: info.user_id,
            relay_url: info.relay_url,
            device_id: info.device_id,
            device_name: info.device_name,
        }),
        devices: snapshot
            .devices
            .into_iter()
            .map(|device| AccountDevice {
                device_id: device.device_id,
                device_name: device.device_name,
                online: device.online,
            })
            .collect(),
    }
}

fn account_login_status_message(
    result: &openbitfun_core::service::remote_connect::account_runtime::AccountLoginResult,
) -> String {
    if result.routing_connected {
        format!(
            "Logged in as user {} on {}. Device routing connected.",
            result.user_id, result.relay_url
        )
    } else if let Some(error) = &result.routing_error {
        format!(
            "Logged in as user {} on {}. Device routing failed: {}",
            result.user_id,
            result.relay_url,
            bounded_error(error.clone())
        )
    } else {
        format!(
            "Logged in as user {} on {}.",
            result.user_id, result.relay_url
        )
    }
}

fn validate_account_operation_id(operation_id: &str) -> AppManagementResult<()> {
    let valid = !operation_id.trim().is_empty()
        && operation_id.len() <= 128
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    valid
        .then_some(())
        .ok_or_else(|| AppManagementError::invalid_request("Account operation ID is invalid"))
}

fn internal_account_error(error: anyhow::Error) -> AppManagementError {
    AppManagementError::internal(bounded_error(error.to_string()))
}

fn bounded_error(message: String) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(500)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppManagementErrorKind;
    use std::path::PathBuf;

    fn native_overview_with_sensitive_paths() -> openbitfun_core::native_hooks::NativeHookOverview {
        openbitfun_core::native_hooks::NativeHookOverview {
            enabled: true,
            project_hooks_enabled: true,
            remote_workspace_unsupported: false,
            files: vec![
                openbitfun_core::native_hooks::NativeHookFileView {
                    scope: "user",
                    path: PathBuf::from("C:/Users/private/AppData/Roaming/OpenBitFun/config/hooks.json"),
                    exists: true,
                    loaded: true,
                },
                openbitfun_core::native_hooks::NativeHookFileView {
                    scope: "project",
                    path: PathBuf::from("D:/secret/project/.openbitfun/config/hooks.json"),
                    exists: true,
                    loaded: true,
                },
                openbitfun_core::native_hooks::NativeHookFileView {
                    scope: "user",
                    path: PathBuf::from(
                        "C:/Users/private/AppData/Roaming/OpenBitFun/runtime/hook-imports/bundles/import-one/version/hooks.json",
                    ),
                    exists: true,
                    loaded: true,
                },
            ],
            rules: vec![openbitfun_core::native_hooks::NativeHookRuleView {
                event: "PreToolUse",
                matcher: "Bash".to_string(),
                matcher_is_valid: true,
                scope: "project",
                source: "D:/secret/project/.openbitfun/config/hooks.json".to_string(),
                handlers: vec![openbitfun_core::native_hooks::NativeHookHandlerView {
                    command: format!("secret-token {}", "x".repeat(240)),
                    timeout_seconds: 5,
                    status_message: Some("Checking".to_string()),
                }],
            }],
            total_handlers: 1,
            issues: vec![
                "Failed to read hook configuration: path=D:/secret/project/.openbitfun/config/hooks.json"
                    .to_string(),
            ],
        }
    }

    fn mutation() -> ModelMutation {
        ModelMutation {
            id: "model-1".to_string(),
            name: "Model".to_string(),
            provider: "openai".to_string(),
            model_name: "gpt-test".to_string(),
            base_url: "https://example.com/v1".to_string(),
            api_key: Some(SecretUpdate::Preserve),
            custom_headers: Some(SecretUpdate::Preserve),
            custom_request_body: Some(SecretUpdate::Preserve),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            enabled: true,
            reasoning: None,
            inline_think_in_text: true,
            skip_ssl_verify: false,
            custom_headers_mode: Some("merge".to_string()),
        }
    }

    #[test]
    fn model_mutation_preserves_and_replaces_write_only_values() {
        let existing = openbitfun_core::service::config::AIModelConfig {
            api_key: "existing-key".to_string(),
            custom_headers: Some(HashMap::from([(
                "Authorization".to_string(),
                "existing-header".to_string(),
            )])),
            custom_request_body: Some("existing-body".to_string()),
            ..Default::default()
        };

        let preserved = model_from_mutation(mutation(), Some(existing.clone()))
            .expect("preserve existing model secrets");
        assert_eq!(preserved.api_key, "existing-key");
        assert_eq!(preserved.custom_headers, existing.custom_headers);
        assert_eq!(
            preserved.custom_request_body.as_deref(),
            Some("existing-body")
        );

        let mut replacement = mutation();
        replacement.api_key = Some(SecretUpdate::Replace("new-key".to_string()));
        replacement.custom_headers = Some(SecretUpdate::Clear);
        replacement.custom_request_body = Some(SecretUpdate::Replace("new-body".to_string()));
        let replaced =
            model_from_mutation(replacement, Some(existing)).expect("replace model secrets");
        assert_eq!(replaced.api_key, "new-key");
        assert!(replaced.custom_headers.is_none());
        assert_eq!(replaced.custom_request_body.as_deref(), Some("new-body"));
    }

    #[test]
    fn native_hook_projection_replaces_paths_and_bounds_command_summaries() {
        let overview = project_native_hook_overview(
            native_overview_with_sensitive_paths(),
            Path::new("D:/secret/project"),
        );

        assert_eq!(
            overview.files[1].location,
            "<workspace>/.openbitfun/config/hooks.json"
        );
        assert!(overview.files[2].location.starts_with("<managed-hooks>/"));
        assert!(overview.rules[0].handlers[0].command_truncated);
        assert_eq!(
            overview.rules[0].handlers[0]
                .command_summary
                .chars()
                .count(),
            MAX_NATIVE_HOOK_COMMAND_CHARS + 3
        );
        let debug = format!("{:?}", NativeHookOverviewResponse(overview.clone()));
        for secret in ["D:/secret/project", "C:/Users/private", "secret-token"] {
            assert!(!debug.contains(secret), "native Hook Debug leaked {secret}");
        }
        assert!(overview.issues[0].contains("<workspace>/.openbitfun/config/hooks.json"));
        assert!(!overview.issues[0].contains("D:/secret/project"));
    }

    #[test]
    fn model_update_rejects_a_mismatched_payload_identity() {
        let error = validate_model_update_identity(
            "model-1",
            &ModelMutation {
                id: "model-2".to_string(),
                ..mutation()
            },
        )
        .expect_err("mismatched model identity should be rejected");

        assert_eq!(error.kind, AppManagementErrorKind::InvalidRequest);
        assert!(!error.message.contains("model-1"));
        assert!(!error.message.contains("model-2"));
    }

    #[test]
    fn blank_primary_selector_is_treated_as_unset() {
        assert!(selector_is_unset(&None));
        assert!(selector_is_unset(&Some("  ".to_string())));
        assert!(!selector_is_unset(&Some("primary-model".to_string())));
    }

    #[test]
    fn model_summary_exposes_only_sorted_header_names() {
        let model = openbitfun_core::service::config::AIModelConfig {
            api_key: "secret-key".to_string(),
            custom_headers: Some(HashMap::from([
                ("Z-Header".to_string(), "secret-z".to_string()),
                ("A-Header".to_string(), "secret-a".to_string()),
            ])),
            ..Default::default()
        };

        let summary = openbitfun_core::service::config::model_projection::model_summary(&model);
        assert!(summary.api_key_configured);
        assert_eq!(summary.custom_header_names, ["A-Header", "Z-Header"]);
        let debug = format!("{summary:?}");
        assert!(!debug.contains("secret-key"));
        assert!(!debug.contains("secret-z"));
        assert!(!debug.contains("secret-a"));
    }

    #[test]
    fn mcp_mutation_rejects_invalid_auth_shapes_without_echoing_values() {
        let error = mcp_config_from_mutation(
            "server",
            McpServerMutation {
                transport: McpTransport::StreamableHttp,
                command: None,
                args: Vec::new(),
                env: HashMap::new(),
                headers: HashMap::new(),
                url: Some("https://example.com".to_string()),
                auto_start: true,
                enabled: true,
                oauth: Some(serde_json::Value::String("secret-oauth".to_string())),
                xaa: None,
            },
        )
        .expect_err("invalid OAuth shape should be rejected");

        assert_eq!(error.kind, AppManagementErrorKind::InvalidRequest);
        assert!(!error.message.contains("secret-oauth"));
    }

    #[test]
    fn native_mcp_detail_omits_remote_credentials_path_and_query() {
        let config = openbitfun_core::service::mcp::MCPServerConfig {
            id: "remote".to_string(),
            name: "Remote".to_string(),
            server_type: openbitfun_core::service::mcp::MCPServerType::Remote,
            transport: Some(openbitfun_core::service::mcp::MCPServerTransport::StreamableHttp),
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            working_directory: None,
            inherit_parent_environment: None,
            headers: HashMap::new(),
            url: Some(
                "https://user:password@example.com:8443/private?token=secret#fragment".to_string(),
            ),
            auto_start: true,
            enabled: true,
            location: openbitfun_core::service::mcp::ConfigLocation::User,
            capabilities: Vec::new(),
            settings: HashMap::new(),
            oauth: None,
            oauth_enabled: None,
            xaa: None,
            timeouts: Default::default(),
        };

        let detail = native_mcp_detail(&config);
        assert!(detail.contains("https://example.com:8443"));
        for secret in [
            "user", "password", "/private", "token", "secret", "fragment",
        ] {
            assert!(!detail.contains(secret), "detail leaked {secret}");
        }
    }
}

/// Old wire references are converted at ingress, then only the record ID is used.
async fn resolve_management_workspace(
    workspace_id: Option<&str>,
    legacy_path: &str,
) -> AppManagementResult<openbitfun_core::service::workspace::WorkspaceInfo> {
    let service = openbitfun_core::service::workspace::get_global_workspace_service()
        .ok_or_else(|| AppManagementError::invalid_request("Workspace service is unavailable"))?;
    service
        .resolve_legacy_workspace_reference(workspace_id, legacy_path, None, None)
        .await
        .map_err(|error| AppManagementError::invalid_request(error.to_string()))?
        .ok_or_else(|| AppManagementError::invalid_request("Unknown workspace reference"))
}
