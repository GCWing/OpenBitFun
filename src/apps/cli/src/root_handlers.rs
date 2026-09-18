use anyhow::{Context, Result};

use std::collections::BTreeSet;
use std::io::IsTerminal;
use std::path::Path;

use crate::{
    chat_state::{transcript_message_preview, transcript_role_label},
    config::CliConfig,
    diagnostics::{emit_exit_diagnostic, ExitContext, ExitKind},
    modes::exec::{
        emit_preflight_json_error, ExecApprovalMode, ExecMode, ExecOutputFormat, ExecSessionOptions,
    },
    ui::string_utils::truncate_str,
    ConfigAction, DispatchAction, ExternalAccessArg, ExternalCapabilityArg, ExternalConfigAction,
    ExternalPolicyModeArg, ExternalPolicyScopeArg, SessionAction,
};
use openbitfun_agent_runtime::sdk::{AgentSessionRestoreRequest, SessionTranscriptRequest};
use openbitfun_core::external_sources::{
    external_source_snapshot, sanitize_external_source_operation_error,
    update_external_integration_policy, EcosystemId, ExternalIntegrationAccess,
    ExternalIntegrationCapabilityId, ExternalIntegrationMode, ExternalIntegrationPolicyMutation,
    ExternalIntegrationPolicyOperation, ExternalIntegrationPolicyScope,
    ExternalIntegrationPolicyStatus, ExternalSourceCatalogSnapshot,
    ExternalSourceOperationErrorCode, EXTERNAL_CAPABILITY_COMMAND, EXTERNAL_CAPABILITY_MCP,
    EXTERNAL_CAPABILITY_SUBAGENT, EXTERNAL_CAPABILITY_TOOL,
};

/// Sized for submit/continue requests carrying inline image attachments
/// (16 MiB of data URLs) plus headroom for the rest of the payload.
const MAX_DISPATCH_STDIN_BYTES: u64 = 24 * 1024 * 1024;

pub(crate) struct ExecCommandArgs {
    pub message: Option<String>,
    pub agent: String,
    pub continue_last: bool,
    pub resume: Option<String>,
    pub session: Option<String>,
    pub session_id: Option<String>,
    pub fork_session: bool,
    pub output_format: ExecOutputFormat,
    pub output_patch: Option<String>,
    pub verify_final_changes: bool,
    pub approval_mode: ExecApprovalMode,
}

pub(crate) async fn handle_dispatch_action(action: DispatchAction) -> Result<()> {
    // Dispatch verbs may initialize global configuration before a detached
    // worker builds its runtime. Select the CLI profile at the process entry
    // point so config canonicalization cannot lazily claim product-full first.
    crate::agent::agentic_system::select_agentic_system_profile(
        openbitfun_core::product_assembly::DeliveryProfile::Cli,
    )?;
    let verb = match action {
        DispatchAction::Run { job } => return crate::dispatch::run_worker(job).await,
        DispatchAction::WorkspaceProvisionRun { job } => {
            return crate::dispatch::run_workspace_provision(job)
        }
        DispatchAction::WorkspaceBundleCommitRun { job } => {
            return crate::dispatch::run_workspace_bundle_commit(job)
        }
        DispatchAction::WorkspaceSyncRun { job } => {
            return crate::dispatch::run_workspace_sync(job)
        }
        DispatchAction::Probe => "probe",
        DispatchAction::Submit => "submit",
        DispatchAction::Status => "status",
        DispatchAction::Cancel => "cancel",
        DispatchAction::List => "list",
        DispatchAction::Answer => "answer",
        DispatchAction::Append => "append",
        DispatchAction::Continue => "continue",
        DispatchAction::Query => "query",
        DispatchAction::WorkspaceProvision => "workspace-provision",
        DispatchAction::WorkspaceBundleBegin => "workspace-bundle-begin",
        DispatchAction::WorkspaceBundleChunk => "workspace-bundle-chunk",
        DispatchAction::WorkspaceBundleCommit => "workspace-bundle-commit",
        DispatchAction::WorkspaceSync => "workspace-sync",
        DispatchAction::WorkspaceSyncChunk => "workspace-sync-chunk",
    };
    let result = async {
        use std::io::{IsTerminal, Read};
        let mut raw = String::new();
        let stdin = std::io::stdin();
        if !stdin.is_terminal() {
            stdin
                .take(MAX_DISPATCH_STDIN_BYTES + 1)
                .read_to_string(&mut raw)
                .context("read dispatch JSON from stdin")?;
            if raw.len() as u64 > MAX_DISPATCH_STDIN_BYTES {
                anyhow::bail!("dispatch JSON input exceeds the 24 MiB safety limit");
            }
        }
        let input = if raw.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&raw).context("decode dispatch JSON from stdin")?
        };
        crate::dispatch::run_dispatch_verb(verb, input).await
    }
    .await;

    match result {
        Ok(response) => {
            println!("{}", serde_json::to_string(&response)?);
            Ok(())
        }
        Err(error) => {
            let response = serde_json::json!({
                "productId": openbitfun_services_core::product_identity::product_id(),
                "dataNamespace": openbitfun_services_core::product_identity::data_namespace(),
                "protocolVersion": crate::dispatch::protocol::DISPATCH_PROTOCOL_VERSION,
                "error": format!("{error:#}"),
            });
            println!("{}", serde_json::to_string(&response)?);
            Err(error)
        }
    }
}

pub(crate) async fn handle_exec_command(config: CliConfig, args: ExecCommandArgs) -> Result<()> {
    let workspace_path_resolved = std::env::current_dir().ok();

    if let Some(ref ws_path) = workspace_path_resolved {
        tracing::info!("Workspace path set: {:?}", ws_path);
    }

    let message = match resolve_exec_message(args.message) {
        Ok(message) => message,
        Err(error) => return exec_preflight_error(args.output_format, error),
    };
    let resume = match (args.resume, args.session) {
        (Some(_), Some(_)) => {
            return exec_preflight_error(
                args.output_format,
                anyhow::anyhow!("Use only one of --resume or --session"),
            );
        }
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    if args.continue_last && resume.is_some() {
        return exec_preflight_error(
            args.output_format,
            anyhow::anyhow!("--continue cannot be combined with --resume or --session"),
        );
    }
    if let Some(session_id) = resume.as_deref().filter(|session_id| *session_id != "last") {
        if let Err(error) =
            openbitfun_agent_runtime::session_control::validate_session_id(session_id)
        {
            return exec_preflight_error(args.output_format, anyhow::anyhow!(error));
        }
    }
    if let Some(session_id) = args.session_id.as_deref() {
        if let Err(error) =
            openbitfun_agent_runtime::session_control::validate_session_id(session_id)
        {
            return exec_preflight_error(args.output_format, anyhow::anyhow!(error));
        }
    }
    if args.session_id.is_some() && (args.continue_last || resume.is_some()) {
        return exec_preflight_error(
            args.output_format,
            anyhow::anyhow!(
                "--session-id cannot be combined with --continue, --resume, or --session"
            ),
        );
    }
    if args.fork_session && args.session_id.is_some() {
        return exec_preflight_error(
            args.output_format,
            anyhow::anyhow!("--fork-session cannot be combined with --session-id"),
        );
    }
    if args.output_format == ExecOutputFormat::StreamJson
        && args.output_patch.as_deref() == Some("-")
    {
        return exec_preflight_error(
            args.output_format,
            anyhow::anyhow!(
                "--output-patch with --output-format stream-json requires an explicit file path"
            ),
        );
    }

    let approval_policy = match args.approval_mode {
        ExecApprovalMode::Reject => crate::runtime::approval::CliApprovalPolicy::Reject,
        ExecApprovalMode::Auto => crate::runtime::approval::CliApprovalPolicy::Auto,
    };
    let runtime = match crate::initialize_core_services(
        workspace_path_resolved
            .as_deref()
            .unwrap_or_else(|| Path::new(".")),
        approval_policy,
        crate::BootstrapProfile::Execution,
    )
    .await
    {
        Ok(runtime) => runtime,
        Err(error) => {
            emit_exit_diagnostic(
                ExitKind::ExecError,
                &error.to_string(),
                &ExitContext {
                    agent_type: Some(args.agent.as_str()),
                    workspace: workspace_path_resolved.as_deref(),
                    ..Default::default()
                },
            );
            return exec_preflight_error(args.output_format, error);
        }
    };

    let mut exec_mode = ExecMode::new(
        config,
        message,
        args.agent,
        runtime.clone(),
        workspace_path_resolved,
        args.output_patch,
        args.verify_final_changes,
        args.output_format,
        ExecSessionOptions {
            resume,
            continue_last: args.continue_last,
            session_id: args.session_id,
            fork_session: args.fork_session,
        },
    );
    let run_result = exec_mode.run().await;

    crate::shutdown_mcp_servers().await;

    run_result
}

fn exec_preflight_error<T>(output_format: ExecOutputFormat, error: anyhow::Error) -> Result<T> {
    emit_preflight_json_error(output_format, &error)?;
    Err(error)
}

fn resolve_exec_message(message: Option<String>) -> Result<String> {
    let mut combined = message.unwrap_or_default();
    if !std::io::stdin().is_terminal() {
        use std::io::Read;
        let mut stdin_content = String::new();
        std::io::stdin().read_to_string(&mut stdin_content)?;
        let stdin_content = stdin_content.trim_end().to_string();
        if !stdin_content.is_empty() {
            if combined.is_empty() {
                combined = stdin_content;
            } else {
                combined.push('\n');
                combined.push_str(&stdin_content);
            }
        }
    }

    let message = combined.trim().to_string();
    if message.is_empty() {
        anyhow::bail!("Prompt cannot be empty");
    }

    Ok(message)
}

pub(crate) async fn handle_session_action(
    action: SessionAction,
) -> Result<Option<(String, std::sync::Arc<crate::runtime::CliRuntimeContext>)>> {
    let workspace_path = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let approval_policy = match &action {
        SessionAction::Resume { .. } | SessionAction::Continue => {
            crate::runtime::approval::CliApprovalPolicy::Ask
        }
        _ => crate::runtime::approval::CliApprovalPolicy::Reject,
    };
    let bootstrap_profile = action.bootstrap_profile();
    let runtime =
        crate::initialize_core_services(&workspace_path, approval_policy, bootstrap_profile)
            .await?;

    match action {
        SessionAction::List => {
            let sessions =
                list_cli_sessions(runtime.agent_runtime(), &runtime.workspace().id).await?;

            if sessions.is_empty() {
                println!(
                    "No history sessions for current project: {}",
                    workspace_path.display()
                );
                return Ok(None);
            }

            println!(
                "History sessions for current project (total {})",
                sessions.len()
            );
            println!("Project: {}\n", workspace_path.display());

            for (i, info) in sessions.iter().enumerate() {
                let last_updated = {
                    i64::try_from(info.last_active_at_ms)
                        .ok()
                        .and_then(chrono::DateTime::from_timestamp_millis)
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                };

                println!("{}. {} (ID: {})", i + 1, info.session_name, info.session_id);
                println!(
                    "   Agent: {} | Turns: {} | Updated: {}",
                    info.agent_type, info.turn_count, last_updated
                );
                println!();
            }
        }

        SessionAction::Show { id } => {
            let session_id =
                resolve_cli_session_id(runtime.agent_runtime(), &runtime.workspace().id, &id)
                    .await?;

            let restored = runtime
                .agent_runtime()
                .restore_session(AgentSessionRestoreRequest {
                    workspace_id: Some(runtime.workspace().id.clone()),
                    workspace_path: String::new(),
                    session_id: session_id.clone(),
                    include_internal: false,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?;
            let transcript = runtime
                .agent_runtime()
                .read_session_transcript(SessionTranscriptRequest {
                    session_id: session_id.clone(),
                    turn_id: None,
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?;

            println!("Session Details\n");
            println!("Name: {}", restored.session.session_name);
            println!("ID: {}", restored.session.session_id);
            println!("Agent: {}", restored.session.agent_type);
            println!("State: {:?}", restored.state);
            println!("Messages: {}", transcript.messages.len());
            println!();

            if !transcript.messages.is_empty() {
                println!("Recent messages:");
                let recent: Vec<_> = transcript.messages.iter().rev().take(5).collect();
                for msg in recent.iter().rev() {
                    let role = transcript_role_label(&msg.role);
                    let content_preview = transcript_message_preview(msg);
                    let preview = if content_preview.len() > 80 {
                        truncate_str(&content_preview, 77)
                    } else {
                        content_preview
                    };
                    println!("  [{}] {}", role, preview);
                }
            }
        }

        SessionAction::Delete { id } => {
            openbitfun_agent_runtime::session_control::validate_session_id(&id)
                .map_err(anyhow::Error::msg)?;
            runtime
                .agent_runtime()
                .delete_session(openbitfun_runtime_ports::AgentSessionDeleteRequest {
                    workspace_id: Some(runtime.workspace().id.clone()),
                    workspace_path: String::new(),
                    session_id: id.clone(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?;
            println!("Deleted session from current project: {}", id);
        }

        SessionAction::Resume { id } => {
            let session_id =
                resolve_cli_session_id(runtime.agent_runtime(), &runtime.workspace().id, &id)
                    .await?;
            return Ok(Some((session_id, runtime)));
        }

        SessionAction::Continue => {
            let session_id =
                resolve_cli_session_id(runtime.agent_runtime(), &runtime.workspace().id, "last")
                    .await?;
            return Ok(Some((session_id, runtime)));
        }

        SessionAction::Fork { id, id_only } => {
            let session_id =
                resolve_cli_session_id(runtime.agent_runtime(), &runtime.workspace().id, &id)
                    .await?;
            let result = runtime
                .agent_runtime()
                .fork_session(openbitfun_agent_runtime::sdk::AgentSessionForkRequest {
                    workspace_id: Some(runtime.workspace().id.clone()),
                    workspace_path: String::new(),
                    source_session_id: session_id.clone(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .map_err(|error| anyhow::anyhow!(error.into_message()))?;

            if id_only {
                println!("{}", result.session_id);
            } else {
                println!("Forked session");
                println!("Source ID: {}", session_id);
                println!("New ID: {}", result.session_id);
                println!("Name: {}", result.session_name);
                println!("Agent: {}", result.agent_type);
            }
        }
    }

    Ok(None)
}

async fn resolve_cli_session_id(
    runtime: &openbitfun_agent_runtime::sdk::AgentRuntime,
    workspace_id: &str,
    id: &str,
) -> Result<String> {
    if id == "last" {
        let sessions = list_cli_sessions(runtime, workspace_id).await?;
        return sessions
            .first()
            .map(|session| session.session_id.clone())
            .ok_or_else(|| anyhow::anyhow!("No history sessions"));
    }

    openbitfun_agent_runtime::session_control::validate_session_id(id)
        .map_err(anyhow::Error::msg)?;
    Ok(id.to_string())
}

async fn list_cli_sessions(
    runtime: &openbitfun_agent_runtime::sdk::AgentRuntime,
    workspace_id: &str,
) -> Result<Vec<openbitfun_runtime_ports::AgentSessionSummary>> {
    runtime
        .list_sessions(openbitfun_runtime_ports::AgentSessionListRequest {
            workspace_id: Some(workspace_id.to_owned()),
            workspace_path: String::new(),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .await
        .map_err(|error| anyhow::anyhow!(error.into_message()))
}

pub(crate) async fn handle_config_action(action: ConfigAction, config: &CliConfig) -> Result<()> {
    match action {
        ConfigAction::Show => {
            println!("Current Configuration\n");
            println!("Note: AI model configuration is managed via GlobalConfig");
            println!();
            println!("UI Configuration:");
            println!("  Appearance: {}", config.ui.theme);
            println!("  Theme ID: {}", config.ui.theme_id);
            println!("  Color scheme: {}", config.ui.color_scheme);
            println!("  Show tips: {}", config.ui.show_tips);
            println!("  Animation: {}", config.ui.animation);
            println!();
            println!("Behavior Configuration:");
            println!("  Auto save: {}", config.behavior.auto_save);
            println!("  Confirm dangerous: {}", config.behavior.confirm_dangerous);
            println!("  Default Agent: {}", config.behavior.default_agent);
            println!();
            println!("Config file: {:?}", CliConfig::config_path()?);
        }

        ConfigAction::Edit => {
            let config_path = CliConfig::config_path()?;
            println!("Config file location: {:?}", config_path);
            println!();
            println!("Please use a text editor to edit the config file:");
            println!("  vi {:?}", config_path);
            println!("  or");
            println!("  code {:?}", config_path);
        }

        ConfigAction::Reset => {
            let default_config = CliConfig::default();
            default_config.save()?;
            println!("Reset to default configuration");
        }
        ConfigAction::External { action } => handle_external_config_action(action).await?,
    }

    Ok(())
}

fn external_policy_scope(scope: ExternalPolicyScopeArg) -> ExternalIntegrationPolicyScope {
    match scope {
        ExternalPolicyScopeArg::Global => ExternalIntegrationPolicyScope::User,
        ExternalPolicyScopeArg::Project => ExternalIntegrationPolicyScope::Workspace,
    }
}

fn external_policy_mode(mode: ExternalPolicyModeArg) -> ExternalIntegrationMode {
    match mode {
        ExternalPolicyModeArg::Recommended => ExternalIntegrationMode::Recommended,
        ExternalPolicyModeArg::DiscoverOnly => ExternalIntegrationMode::DiscoverOnly,
        ExternalPolicyModeArg::Off => ExternalIntegrationMode::Disabled,
    }
}

fn external_capability_id(
    capability: ExternalCapabilityArg,
) -> Result<ExternalIntegrationCapabilityId> {
    let capability = match capability {
        ExternalCapabilityArg::Command => EXTERNAL_CAPABILITY_COMMAND,
        ExternalCapabilityArg::Tool => EXTERNAL_CAPABILITY_TOOL,
        ExternalCapabilityArg::Agent => EXTERNAL_CAPABILITY_SUBAGENT,
        ExternalCapabilityArg::Mcp => EXTERNAL_CAPABILITY_MCP,
    };
    ExternalIntegrationCapabilityId::new(capability).map_err(anyhow::Error::msg)
}

fn external_access(access: ExternalAccessArg) -> ExternalIntegrationAccess {
    match access {
        ExternalAccessArg::Off => ExternalIntegrationAccess::Disabled,
        ExternalAccessArg::Discover => ExternalIntegrationAccess::DiscoverOnly,
        ExternalAccessArg::Ask => ExternalIntegrationAccess::AskBeforeUse,
        ExternalAccessArg::Auto => ExternalIntegrationAccess::Auto,
    }
}

fn print_external_policy_status(snapshot: &ExternalSourceCatalogSnapshot) {
    let policy = &snapshot.integration_policy;
    println!("External compatibility");
    if policy.status == ExternalIntegrationPolicyStatus::IncompatibleSchema {
        println!(
            "Status: safely off (policy schema {} is not supported by this version)",
            policy.schema_major
        );
        println!("Recovery: openbitfun config external reset-incompatible");
        println!("The original policy will be backed up before safe defaults are restored.");
        return;
    }
    if !policy.status.is_compatible() {
        println!(
            "Status: safely off (policy status '{}' is not supported by this version)",
            policy.status.as_str()
        );
        println!("Recovery: upgrade OpenBitFun or connect through a compatible workspace host.");
        return;
    }

    println!("Global defaults");
    println!(
        "  Status: {}",
        if policy.global_effective.enabled {
            "enabled"
        } else {
            "disabled"
        }
    );
    print_external_policy_ecosystems(policy, &policy.global_effective, "  ");

    println!("Project overrides");
    if let Some(project) = &policy.workspace_override {
        let has_override = project.enabled.is_some()
            || project.ecosystems.values().any(|ecosystem| {
                ecosystem.mode.is_some() || !ecosystem.capability_overrides.is_empty()
            });
        println!(
            "  {}",
            if has_override {
                "Explicit project override"
            } else {
                "Inherited from global defaults"
            }
        );
    } else {
        println!("  Inherited from global defaults");
    }

    println!("Effective for this project");
    println!(
        "  Status: {}",
        if policy.effective.enabled {
            "enabled"
        } else {
            "disabled"
        }
    );
    print_external_policy_ecosystems(policy, &policy.effective, "  ");
    let locations = snapshot
        .sources
        .iter()
        .map(|source| source.record.location.as_str())
        .collect::<BTreeSet<_>>();
    println!("Detected source locations: {}", locations.len());
    println!("Preference revision: {}", snapshot.preference_revision);
    println!();
    println!("Changes are applied by the workspace host. Project settings never fall back to files from another device.");
}

fn external_cli_operation_error(error: String) -> anyhow::Error {
    let error = sanitize_external_source_operation_error(error);
    let reason = match error.code {
        ExternalSourceOperationErrorCode::InvalidRequest => "The requested change is not valid.",
        ExternalSourceOperationErrorCode::HostUnavailable => "The workspace host is not available.",
        ExternalSourceOperationErrorCode::HostCapabilityUnavailable => {
            "This workspace host is read-only for external integrations."
        }
        ExternalSourceOperationErrorCode::TrustRequired => {
            "This external integration requires review before it can run."
        }
        ExternalSourceOperationErrorCode::PolicyIncompatible => {
            "Compatibility settings were written by a newer OpenBitFun version."
        }
        ExternalSourceOperationErrorCode::PolicyLimited => {
            "The current safety policy does not allow this change."
        }
        ExternalSourceOperationErrorCode::StaleRevision => {
            "Compatibility settings changed; run the command again."
        }
        ExternalSourceOperationErrorCode::Conflict => {
            "The available choices changed; inspect the current status and retry."
        }
        ExternalSourceOperationErrorCode::NotFound => "That external item is no longer available.",
        ExternalSourceOperationErrorCode::Unavailable => {
            "The external integration is temporarily unavailable."
        }
        ExternalSourceOperationErrorCode::RuntimeUnavailable
        | ExternalSourceOperationErrorCode::DependencyFailed
        | ExternalSourceOperationErrorCode::ProcessLost => {
            "The external integration runtime is unavailable."
        }
        ExternalSourceOperationErrorCode::Unsupported
        | ExternalSourceOperationErrorCode::IncompatibleVersion => {
            "This external integration is not supported by the current OpenBitFun version."
        }
        ExternalSourceOperationErrorCode::Timeout
        | ExternalSourceOperationErrorCode::Overloaded
        | ExternalSourceOperationErrorCode::TemporarilyUnavailable => {
            "The external integration is temporarily unavailable."
        }
        ExternalSourceOperationErrorCode::Cancelled => {
            "The external integration operation was cancelled."
        }
        ExternalSourceOperationErrorCode::InvalidResponse
        | ExternalSourceOperationErrorCode::Internal => {
            "OpenBitFun could not complete the external integration operation."
        }
    };
    let reference = error
        .correlation_id
        .as_deref()
        .map(|id| format!(" Reference: {id}."))
        .unwrap_or_default();
    anyhow::anyhow!("{reason}{reference}")
}

fn select_external_ecosystem(
    status: &ExternalIntegrationPolicyStatus,
    ecosystems: &[EcosystemId],
    requested: Option<&str>,
) -> Result<EcosystemId> {
    if !status.is_compatible() {
        return Err(anyhow::anyhow!(
            "External compatibility policy is unsupported and safely off; upgrade OpenBitFun or reset an incompatible policy before changing it"
        ));
    }
    if let Some(requested) = requested {
        let ecosystem = ecosystems
            .iter()
            .find(|ecosystem| ecosystem.as_str() == requested)
            .ok_or_else(|| anyhow::anyhow!("Unknown external ecosystem '{requested}'"))?;
        return Ok(ecosystem.clone());
    }
    match ecosystems {
        [only] => Ok(only.clone()),
        [] => Err(anyhow::anyhow!("No external ecosystems are registered")),
        _ => Err(anyhow::anyhow!(
            "More than one external ecosystem is registered; choose one with --ecosystem <id>"
        )),
    }
}

async fn resolve_external_ecosystem(requested: Option<String>) -> Result<EcosystemId> {
    let workspace = crate::create_cli_local_workspace(
        &std::env::current_dir().context("Failed to resolve current workspace")?,
    )
    .await?
    .id;
    let snapshot = external_source_snapshot(Some(&workspace), false)
        .await
        .map_err(external_cli_operation_error)?;
    let ecosystems = snapshot
        .integration_policy
        .registered_ecosystems
        .iter()
        .map(|descriptor| descriptor.ecosystem_id.clone())
        .collect::<Vec<_>>();
    select_external_ecosystem(
        &snapshot.integration_policy.status,
        &ecosystems,
        requested.as_deref(),
    )
}

fn print_external_policy_ecosystems(
    policy: &openbitfun_core::external_sources::ExternalIntegrationPolicySnapshot,
    effective: &openbitfun_core::external_sources::EffectiveExternalIntegrationPolicy,
    indent: &str,
) {
    for descriptor in &policy.registered_ecosystems {
        let Some(ecosystem) = effective.ecosystems.get(&descriptor.ecosystem_id) else {
            println!("{indent}{}: unavailable", descriptor.display_name);
            continue;
        };
        let mode = match ecosystem.mode.as_str() {
            "recommended" | "discover_only" | "disabled" | "custom" => ecosystem.mode.as_str(),
            _ => "unsupported (safely off)",
        };
        println!("{indent}{} mode: {mode}", descriptor.display_name);
        for capability in &descriptor.capabilities {
            let access = ecosystem
                .capabilities
                .get(&capability.capability_id)
                .map(|access| match access.as_str() {
                    "disabled" | "discover_only" | "ask_before_use" | "auto" => access.as_str(),
                    _ => "unsupported (safely off)",
                })
                .unwrap_or("unavailable");
            let suffix = if ecosystem
                .policy_limited_capabilities
                .contains(&capability.capability_id)
            {
                " (limited by safety policy)"
            } else {
                ""
            };
            println!(
                "{indent}  {}: {access}{suffix}",
                capability.capability_id.as_str()
            );
        }
    }
}

async fn update_external_policy(
    scope: ExternalPolicyScopeArg,
    change: ExternalIntegrationPolicyOperation,
) -> Result<()> {
    let workspace = crate::create_cli_local_workspace(
        &std::env::current_dir().context("Failed to resolve current workspace")?,
    )
    .await?
    .id;
    let snapshot = external_source_snapshot(Some(&workspace), false)
        .await
        .map_err(external_cli_operation_error)?;
    let reset_incompatible = matches!(
        &change,
        ExternalIntegrationPolicyOperation::ResetIncompatiblePolicy
    );
    if !snapshot.integration_policy.status.is_compatible()
        && !(reset_incompatible
            && snapshot.integration_policy.status
                == ExternalIntegrationPolicyStatus::IncompatibleSchema)
    {
        return Err(anyhow::anyhow!(
            "External compatibility policy is unsupported and safely off; upgrade OpenBitFun or reset an incompatible policy before changing it"
        ));
    }
    let snapshot = update_external_integration_policy(
        Some(&workspace),
        ExternalIntegrationPolicyMutation {
            expected_preference_revision: snapshot.preference_revision,
            scope: external_policy_scope(scope),
            change,
        },
    )
    .await
    .map_err(external_cli_operation_error)?;
    println!("External compatibility settings saved.\n");
    print_external_policy_status(&snapshot);
    Ok(())
}

async fn handle_external_config_action(action: ExternalConfigAction) -> Result<()> {
    match action {
        ExternalConfigAction::Status => {
            let workspace = crate::create_cli_local_workspace(
                &std::env::current_dir().context("Failed to resolve current workspace")?,
            )
            .await?
            .id;
            let snapshot = external_source_snapshot(Some(&workspace), false)
                .await
                .map_err(external_cli_operation_error)?;
            print_external_policy_status(&snapshot);
        }
        ExternalConfigAction::SetEnabled { enabled, scope } => {
            update_external_policy(
                scope,
                ExternalIntegrationPolicyOperation::SetEnabled { enabled },
            )
            .await?;
        }
        ExternalConfigAction::SetMode {
            mode,
            ecosystem,
            scope,
        } => {
            let ecosystem_id = resolve_external_ecosystem(ecosystem).await?;
            update_external_policy(
                scope,
                ExternalIntegrationPolicyOperation::SetEcosystemMode {
                    ecosystem_id,
                    mode: external_policy_mode(mode),
                },
            )
            .await?;
        }
        ExternalConfigAction::SetCapability {
            capability,
            access,
            ecosystem,
            scope,
        } => {
            let ecosystem_id = resolve_external_ecosystem(ecosystem).await?;
            let capability_id = external_capability_id(capability)?;
            let access = external_access(access);
            if access == ExternalIntegrationAccess::Auto
                && capability_id.as_str() != EXTERNAL_CAPABILITY_COMMAND
            {
                return Err(anyhow::anyhow!(
                    "Automatic use is available only for commands; tools, agents, and MCP servers require confirmation"
                ));
            }
            update_external_policy(
                scope,
                ExternalIntegrationPolicyOperation::SetCapabilityAccess {
                    ecosystem_id,
                    capability_id,
                    access,
                },
            )
            .await?;
        }
        ExternalConfigAction::ResetProject => {
            update_external_policy(
                ExternalPolicyScopeArg::Project,
                ExternalIntegrationPolicyOperation::ResetWorkspace,
            )
            .await?;
        }
        ExternalConfigAction::ResetIncompatible => {
            update_external_policy(
                ExternalPolicyScopeArg::Global,
                ExternalIntegrationPolicyOperation::ResetIncompatiblePolicy,
            )
            .await?;
        }
    }
    Ok(())
}

pub(crate) fn handle_health_command() -> Result<()> {
    use openbitfun_core::runtime_ports::PluginRuntimeAvailability;

    let workspace = std::env::current_dir().context("Failed to resolve current directory")?;
    let (_, services) =
        openbitfun_core::product_runtime::build_local_runtime_services(&workspace, 16)?;
    let product_runtime = crate::product_assembly::assemble_cli_runtime_parts(services)?;

    println!("OpenBitFun CLI health");
    println!("Version: {}", env!("CARGO_PKG_VERSION"));
    println!(
        "Product runtime: {} assembly-ready",
        product_runtime.plan().profile().id()
    );
    println!("Runtime capability registrations: complete");
    println!("Execution owner: openbitfun-core compatibility");
    match product_runtime.plugin_runtime().availability() {
        PluginRuntimeAvailability::Disabled { reason } => {
            println!("Plugin runtime: disabled ({reason})");
        }
        PluginRuntimeAvailability::ProjectionOnly { reason } => {
            println!("Plugin runtime: projection-only ({reason})");
        }
        PluginRuntimeAvailability::Unavailable { reason } => {
            println!("Plugin runtime: unavailable ({reason})");
        }
        PluginRuntimeAvailability::Available => println!("Plugin runtime: available"),
        _ => println!("Plugin runtime: unknown"),
    }
    println!("Config directory: {:?}", CliConfig::config_dir()?);
    Ok(())
}

pub(crate) async fn serve_acp_stdio() -> Result<()> {
    crate::setup_workspace();
    let workspace_root = std::env::current_dir().context("Failed to resolve ACP workspace")?;

    crate::agent::agentic_system::select_agentic_system_profile(
        openbitfun_core::product_assembly::DeliveryProfile::Acp,
    )?;
    openbitfun_core::service::config::initialize_global_config()
        .await
        .context("Failed to initialize global config service")?;
    tracing::info!("Global config service initialized");

    use openbitfun_core::infrastructure::ai::AIClientFactory;
    AIClientFactory::initialize_global()
        .await
        .context("Failed to initialize global AIClientFactory")?;
    tracing::info!("Global AI client factory initialized");

    crate::initialize_terminal_service().await;

    // The ACP host owns workspace records for the directories its clients
    // name by `cwd`; the process cwd is opened first so the fixed runtime
    // ownership below and the session records share one workspace identity.
    let workspace = crate::create_cli_local_workspace(&workspace_root)
        .await
        .context("Failed to open the ACP workspace record")?;
    tracing::info!(workspace_id = %workspace.id, "ACP workspace record opened");

    let path_manager = openbitfun_core::infrastructure::try_get_path_manager_arc()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let deployment = openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded;
    let runtime_ownership =
        openbitfun_core::runtime_ownership::CoreRuntimeOwnership::fixed_workspace(
            path_manager.as_ref(),
            "acp",
            &workspace_root,
            deployment,
        )
        .map_err(|error| anyhow::anyhow!(error.startup_message(deployment, "acp")))?;

    let agentic_system = crate::agent::agentic_system::init_agentic_system(
        openbitfun_core::product_assembly::DeliveryProfile::Acp,
        std::sync::Arc::new(runtime_ownership),
    )
    .await
    .context("Failed to initialize agentic system")?;
    tracing::info!("Agentic system initialized");

    let runtime = crate::runtime::AcpRuntimeContext::build(agentic_system, workspace_root)?;
    let (agent_runtime, compatibility) = runtime.parts();
    openbitfun_acp::OpenBitFunAcpRuntime::serve_stdio(agent_runtime, compatibility).await?;
    Ok(())
}

#[cfg(test)]
mod external_ecosystem_selection_tests {
    use super::*;

    fn ecosystem(id: &str) -> EcosystemId {
        EcosystemId::new(id).unwrap()
    }

    #[test]
    fn ecosystem_selection_covers_zero_one_many_and_explicit_choices() {
        let compatible = ExternalIntegrationPolicyStatus::Compatible;
        assert!(select_external_ecosystem(&compatible, &[], None)
            .unwrap_err()
            .to_string()
            .contains("No external ecosystems"));

        let only = vec![ecosystem("opencode")];
        assert_eq!(
            select_external_ecosystem(&compatible, &only, None)
                .unwrap()
                .as_str(),
            "opencode"
        );
        assert!(
            select_external_ecosystem(&compatible, &only, Some("missing"))
                .unwrap_err()
                .to_string()
                .contains("Unknown external ecosystem")
        );

        let many = vec![ecosystem("opencode"), ecosystem("another")];
        assert!(select_external_ecosystem(&compatible, &many, None)
            .unwrap_err()
            .to_string()
            .contains("--ecosystem"));
        assert_eq!(
            select_external_ecosystem(&compatible, &many, Some("another"))
                .unwrap()
                .as_str(),
            "another"
        );
    }

    #[test]
    fn unknown_policy_status_is_always_safely_off() {
        let error = select_external_ecosystem(
            &ExternalIntegrationPolicyStatus::Unknown("future_status".to_string()),
            &[ecosystem("opencode")],
            Some("opencode"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("unsupported and safely off"));
    }
}
