use anyhow::{anyhow, Context, Result};
use openbitfun_agent_runtime::sdk::AgentSessionUsageRequest;
use openbitfun_core::agentic::get_agent_registry;
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::plugin_runtime::{
    activate_managed_plugin, deactivate_managed_plugin, preview_managed_plugin_activation,
    ManagedPluginActivationView, ManagedPluginDeactivationResult,
};
use openbitfun_core::plugin_source::{
    refresh_managed_plugin_sources, set_managed_plugin_trust, ManagedPluginSourceError,
    ManagedPluginSourceIssue, ManagedPluginSourceSnapshot, ManagedPluginTrustDecision,
    ManagedPluginTrustLevel,
};
use openbitfun_core::product_assembly::ProductRuntimeParts;
use openbitfun_core::runtime_ports::PluginRuntimeAvailability;
use openbitfun_core::service::config::initialize_global_config;
use openbitfun_core::service::session_usage::render_usage_report_markdown;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

async fn ensure_global_config_service(
) -> Result<std::sync::Arc<openbitfun_core::service::config::ConfigService>> {
    initialize_global_config()
        .await
        .context("Failed to initialize global config service")?;
    openbitfun_core::service::config::get_global_config_service()
        .await
        .context("Failed to get global config service")
}

pub(crate) async fn print_agents(workspace: Option<&Path>) -> Result<()> {
    let registry = get_agent_registry();
    let workspace_id = match workspace {
        Some(root) => Some(crate::create_cli_local_workspace(root).await?.id),
        None => None,
    };
    if workspace.is_some() {
        if let Err(error) =
            openbitfun_core::external_sources::ensure_external_source_workspace_snapshot(
                workspace_id.as_deref(),
            )
            .await
        {
            eprintln!(
                "Warning: external agent sources could not be refreshed: {}",
                crate::plugin_diagnostics::escape_terminal_text(&error)
            );
        }
    }
    let modes = registry
        .get_modes_info_for_workspace(workspace_id.as_deref(), workspace_id.is_some())
        .await;
    let subagents = registry.get_subagents_info(workspace_id.as_deref()).await;

    println!("Agent modes");
    println!();
    if modes.is_empty() {
        println!("No agent modes found.");
    } else {
        for agent in modes {
            println!(
                "- {}: {} (tools: {}, readonly: {}, review: {})",
                agent.id, agent.name, agent.tool_count, agent.is_readonly, agent.is_review
            );
            if !agent.description.is_empty() {
                println!("  {}", agent.description);
            }
        }
    }

    println!();
    println!("Subagents");
    println!();
    if subagents.is_empty() {
        println!("No subagents found for the current workspace.");
    } else {
        for agent in subagents {
            println!(
                "- {}: {} (tools: {}, enabled: {}, readonly: {}, review: {})",
                agent.id,
                agent.name,
                agent.tool_count,
                agent.effective_enabled,
                agent.is_readonly,
                agent.is_review
            );
            if !agent.description.is_empty() {
                println!("  {}", agent.description);
            }
        }
    }

    Ok(())
}

pub(crate) async fn print_models() -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    let models = config_service.get_ai_models().await?;
    let global_config: openbitfun_core::service::config::GlobalConfig =
        config_service.get_config(None).await?;

    let primary_model_id = global_config.ai.default_models.primary.clone();
    let mode_model_id = crate::model_selection::resolve_mode_model_id(&global_config.ai);

    println!("AI models");
    println!();
    if models.is_empty() {
        println!("No AI models configured.");
        return Ok(());
    }

    for model in models {
        let is_primary = primary_model_id.as_deref() == Some(model.id.as_str());
        let is_mode_default = mode_model_id.as_deref() == Some(model.id.as_str());

        println!(
            "- {}{} ({})",
            if is_primary { "* " } else { "  " },
            model.id,
            if model.enabled { "enabled" } else { "disabled" }
        );
        println!("  Name: {}", model.name);
        println!("  Provider: {}", model.provider);
        println!("  Model: {}", model.model_name);
        if is_mode_default {
            println!("  Used by modes: all");
        }
    }

    Ok(())
}

pub(crate) async fn print_mcp_servers() -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    let mcp_service = openbitfun_core::service::mcp::MCPService::new(config_service.clone())
        .map_err(|error| anyhow!(error.to_string()))?;
    let configs = mcp_service.config_service().load_all_configs().await?;

    println!("MCP servers");
    println!();
    if configs.is_empty() {
        println!("No MCP servers configured.");
        return Ok(());
    }

    for config in configs {
        let status = if config.enabled {
            match tokio::time::timeout(
                Duration::from_millis(30),
                mcp_service.server_manager().get_server_status(&config.id),
            )
            .await
            {
                Ok(Ok(status)) => format!("{:?}", status),
                Ok(Err(_)) => "Unknown".to_string(),
                Err(_) => "Starting".to_string(),
            }
        } else {
            "Disabled".to_string()
        };

        let endpoint = match config.server_type {
            openbitfun_core::service::mcp::server::MCPServerType::Local => config
                .command
                .as_ref()
                .map(|cmd| format!("{} {}", cmd, config.args.join(" ")))
                .unwrap_or_else(|| "<missing command>".to_string()),
            openbitfun_core::service::mcp::server::MCPServerType::Remote => config
                .url
                .clone()
                .unwrap_or_else(|| "<missing url>".to_string()),
        };

        println!("- {} ({:?})", config.id, config.server_type);
        println!("  Name: {}", config.name);
        println!("  Status: {}", status);
        println!("  Enabled: {}", config.enabled);
        println!("  Endpoint: {}", endpoint);
    }

    Ok(())
}

pub(crate) async fn set_default_model(model_id: &str) -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    config_service
        .set_config("ai.default_models.primary", model_id)
        .await?;
    config_service
        .set_config("ai.agent_model_defaults.mode", model_id)
        .await?;

    println!("Default model set to: {}", model_id);

    Ok(())
}

pub(crate) async fn set_mcp_server_enabled(server_id: &str, enabled: bool) -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    let mcp_service = openbitfun_core::service::mcp::MCPService::new(config_service.clone())
        .map_err(|error| anyhow!(error.to_string()))?;
    let mut config = mcp_service
        .config_service()
        .get_server_config(server_id)
        .await?
        .ok_or_else(|| anyhow!("MCP server not found: {}", server_id))?;
    config.enabled = enabled;
    mcp_service
        .config_service()
        .save_server_config(&config)
        .await?;

    println!(
        "MCP server {} {}.",
        server_id,
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

/// User-facing input for `openbitfun mcp add`.
///
/// All fields are optional so the CLI can pre-fill any subset via flags and
/// resolve the rest through the three-step wizard.
pub(crate) struct McpAddInput {
    pub name: Option<String>,
    pub r#type: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub non_interactive: bool,
}

/// RAII guard that disables crossterm raw mode on drop, so an early return or
/// panic in the wizard cannot leave the terminal stuck in raw mode.
struct RawModeGuard;
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

/// Add an MCP server through the three-step wizard.
///
/// Step 1 collects the server name (also used as id). Step 2 lets the user
/// pick the type — `local` (stdio) or `remote` (streamable-http) — using the
/// up/down arrow keys. Step 3 collects the launch command (local) or URL
/// (remote); for local servers, the command string is split on whitespace
/// into `command + args`, matching the behavior of the TUI MCP add dialog.
/// Other `MCPServerConfig` fields use sensible defaults and are validated
/// through the shared `MCPServerConfig::validate` contract before being
/// persisted via `MCPConfigService::save_server_config`.
pub(crate) async fn add_mcp_server(input: McpAddInput) -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    let mcp_service = openbitfun_core::service::mcp::MCPService::new(config_service.clone())
        .map_err(|error| anyhow!(error.to_string()))?;

    println!("Add MCP Server (1/3) — Name");
    let name = read_required_field(
        "Server name (also used as id; no spaces)",
        input.name.as_deref(),
        input.non_interactive,
    )?;
    if name.contains(' ') {
        return Err(anyhow!("Server name cannot contain spaces"));
    }

    println!("Add MCP Server (2/3) — Type");
    let is_local = select_server_type(input.r#type.as_deref(), input.non_interactive)?;
    let server_type = if is_local {
        openbitfun_core::service::mcp::MCPServerType::Local
    } else {
        openbitfun_core::service::mcp::MCPServerType::Remote
    };
    let transport = if is_local {
        openbitfun_core::service::mcp::MCPServerTransport::Stdio
    } else {
        openbitfun_core::service::mcp::MCPServerTransport::StreamableHttp
    };

    println!("Add MCP Server (3/3) — Connection");
    let (command, args, url) = if is_local {
        let raw = read_required_field(
            "Command (e.g. `npx -y @modelcontextprotocol/server-xxx`)",
            input.command.as_deref(),
            input.non_interactive,
        )?;
        let (command_value, args_value) = parse_local_command(&raw)?;
        (Some(command_value), args_value, None)
    } else {
        let url_value = read_required_field(
            "URL (e.g. `https://mcp.example.com/mcp`)",
            input.url.as_deref(),
            input.non_interactive,
        )?;
        (None, Vec::new(), Some(url_value))
    };

    let config = openbitfun_core::service::mcp::MCPServerConfig {
        id: name.clone(),
        name: name.clone(),
        server_type,
        transport: Some(transport),
        command,
        args,
        env: std::collections::HashMap::new(),
        working_directory: None,
        inherit_parent_environment: None,
        headers: std::collections::HashMap::new(),
        url,
        auto_start: true,
        enabled: true,
        location: openbitfun_core::service::mcp::ConfigLocation::User,
        capabilities: Vec::new(),
        settings: std::collections::HashMap::new(),
        oauth: None,
        oauth_enabled: None,
        xaa: None,
        timeouts: Default::default(),
    };

    config
        .validate()
        .map_err(|error| anyhow!("Invalid MCP server config: {}", error))?;

    if mcp_service
        .config_service()
        .get_server_config(&config.id)
        .await?
        .is_some()
    {
        return Err(anyhow!("MCP server already exists: {}", config.id));
    }

    mcp_service
        .config_service()
        .save_server_config(&config)
        .await
        .map_err(|error| anyhow!(error.to_string()))?;

    println!("MCP server '{}' added.", name);
    println!(
        "Run `openbitfun mcp list` to verify, `openbitfun mcp disable {}` to toggle.",
        name
    );
    Ok(())
}

/// Returns `true` for local, `false` for remote. Uses up/down arrow keys
/// (also left/right, vim-style h/l and j/k) when no flag pre-fills the choice;
/// requires an explicit flag value in `--non-interactive` mode.
fn select_server_type(pre_filled: Option<&str>, non_interactive: bool) -> Result<bool> {
    if let Some(value) = pre_filled {
        let trimmed = value.trim();
        return match trimmed {
            "local" => Ok(true),
            "remote" => Ok(false),
            other => Err(anyhow!("Type must be `local` or `remote`, got `{}`", other)),
        };
    }
    if non_interactive {
        return Err(anyhow!(
            "Server type is required in non-interactive mode (pass `--type local` or `--type remote`)"
        ));
    }

    use crossterm::event::{self, KeyCode, KeyEventKind};
    use crossterm::terminal::{disable_raw_mode, enable_raw_mode};

    enable_raw_mode().context("Failed to enable raw mode")?;
    let _guard = RawModeGuard;

    let mut is_local = true;
    let mut stdout = std::io::stdout();
    render_type_prompt(&mut stdout, is_local)?;

    loop {
        let event = match event::read() {
            Ok(event) => event,
            Err(error) => return Err(anyhow!("Failed to read key event: {}", error)),
        };
        let key_event = match event {
            crossterm::event::Event::Key(key_event) => key_event,
            _ => continue,
        };
        if !matches!(key_event.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            continue;
        }
        match key_event.code {
            KeyCode::Up | KeyCode::Left | KeyCode::Char('h') | KeyCode::Char('k') => {
                is_local = true;
                render_type_prompt(&mut stdout, is_local)?;
            }
            KeyCode::Down | KeyCode::Right | KeyCode::Char('l') | KeyCode::Char('j') => {
                is_local = false;
                render_type_prompt(&mut stdout, is_local)?;
            }
            KeyCode::Enter => break,
            KeyCode::Esc => {
                println!();
                return Err(anyhow!("Cancelled by user"));
            }
            _ => {}
        }
    }

    println!();
    let _ = disable_raw_mode();
    Ok(is_local)
}

fn parse_local_command(value: &str) -> Result<(String, Vec<String>)> {
    let parts = split_command_line(value)
        .ok_or_else(|| anyhow!("Command contains an unclosed quote or invalid escaping"))?;
    let mut parts = parts.into_iter();
    let command = parts
        .next()
        .filter(|command| !command.is_empty())
        .ok_or_else(|| anyhow!("Command cannot be empty"))?;
    Ok((command, parts.collect()))
}

#[cfg(not(windows))]
fn split_command_line(value: &str) -> Option<Vec<String>> {
    shlex::split(value)
}

#[cfg(windows)]
fn split_command_line(value: &str) -> Option<Vec<String>> {
    let parts = winsplit::split(value);
    if parts.is_empty() || has_unclosed_windows_quote(value) {
        None
    } else {
        Some(parts)
    }
}

#[cfg(windows)]
fn has_unclosed_windows_quote(value: &str) -> bool {
    let mut quoted = false;
    let mut backslashes = 0usize;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' if backslashes % 2 == 0 => {
                quoted = !quoted;
                backslashes = 0;
            }
            _ => backslashes = 0,
        }
    }
    quoted
}

fn render_type_prompt(stdout: &mut std::io::Stdout, is_local: bool) -> Result<()> {
    use std::io::Write;
    // `\r\x1b[2K` moves to column 0 and clears the current line so the prompt
    // can be re-rendered in place while the user cycles between options.
    write!(stdout, "\r\x1b[2K")?;
    let label = if is_local {
        "local (stdio)"
    } else {
        "remote (streamable-http)"
    };
    let marker = |selected: bool| if selected { "›" } else { " " };
    write!(
        stdout,
        "  Type: [{}] {} local (stdio)  {} remote (streamable-http)  ↑/↓ select, Enter confirm, Esc cancel",
        label,
        marker(is_local),
        marker(!is_local),
    )?;
    stdout.flush()?;
    Ok(())
}

fn read_line_trimmed() -> Result<String> {
    let mut buffer = String::new();
    let bytes_read = std::io::stdin()
        .read_line(&mut buffer)
        .context("Failed to read from stdin")?;
    if bytes_read == 0 {
        return Err(anyhow!("Unexpected end of input (stdin closed)"));
    }
    Ok(buffer.trim_end_matches(['\r', '\n']).to_string())
}

fn read_required_field(
    label: &str,
    pre_filled: Option<&str>,
    non_interactive: bool,
) -> Result<String> {
    if let Some(value) = pre_filled {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("{} cannot be empty", label));
        }
        return Ok(trimmed.to_string());
    }
    if non_interactive {
        return Err(anyhow!(
            "{} is required (pass a flag or run without --non-interactive)",
            label
        ));
    }
    print!("  {}: ", label);
    std::io::stdout()
        .flush()
        .context("Failed to flush stdout")?;
    let value = read_line_trimmed()?;
    if value.is_empty() {
        return Err(anyhow!("{} cannot be empty", label));
    }
    Ok(value)
}
pub(crate) async fn print_mcp_json_config() -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    let mcp_service = openbitfun_core::service::mcp::MCPService::new(config_service.clone())
        .map_err(|error| anyhow!(error.to_string()))?;
    let snapshot = mcp_service.config_service().load_mcp_json_config().await?;
    println!("{}", snapshot.json_config);
    Ok(())
}

pub(crate) async fn run_mcp_import(command: crate::mcp_import::McpImportCommand) -> Result<()> {
    let _config_service = ensure_global_config_service().await?;
    crate::mcp_import::execute(command).await
}

fn validate_usage_session_id(session_id: &str) -> Result<()> {
    openbitfun_agent_runtime::session_control::validate_session_id(session_id)
        .map_err(anyhow::Error::msg)
}

pub(crate) async fn print_usage_report(session_id: Option<&str>) -> Result<()> {
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
        validate_usage_session_id(session_id)?;
    }
    let workspace_path = std::env::current_dir().context("Failed to resolve current directory")?;
    let runtime = crate::initialize_core_services(
        &workspace_path,
        crate::runtime::approval::CliApprovalPolicy::Reject,
        crate::BootstrapProfile::Management,
    )
    .await?;
    let resolved_session_id = match session_id {
        Some(session_id) if !session_id.trim().is_empty() => session_id.to_string(),
        _ => runtime
            .agent_runtime()
            .list_sessions(openbitfun_runtime_ports::AgentSessionListRequest {
                workspace_id: Some(runtime.workspace().id.clone()),
                workspace_path: String::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await?
            .first()
            .map(|session| session.session_id.clone())
            .ok_or_else(|| anyhow!("No history sessions for current project"))?,
    };

    let report = runtime
        .agent_runtime()
        .generate_session_usage(AgentSessionUsageRequest {
            workspace_id: Some(runtime.workspace().id.clone()),
            session_id: resolved_session_id,
            workspace_path: Some(workspace_path.to_string_lossy().to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
            include_hidden_subagents: true,
        })
        .await
        .map_err(|error| anyhow!(error.into_message()))?;

    println!("{}", render_usage_report_markdown(&report));
    Ok(())
}

pub(crate) async fn print_plugins() -> Result<()> {
    let workspace = std::env::current_dir().context("Failed to resolve current directory")?;
    let path_manager = try_get_path_manager_arc().map_err(|error| anyhow!(error.to_string()))?;
    let snapshot = refresh_managed_plugin_sources(&workspace)
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
    println!(
        "User package root: {}",
        crate::plugin_diagnostics::escape_terminal_text(
            &path_manager.user_plugins_dir().to_string_lossy()
        )
    );
    println!(
        "Workspace package root: {}",
        crate::plugin_diagnostics::escape_terminal_text(
            &path_manager
                .project_plugins_dir(&workspace)
                .to_string_lossy()
        )
    );
    println!();
    print_plugin_snapshot(&snapshot);
    Ok(())
}

pub(crate) async fn set_plugin_trust(
    package_id: &str,
    decision: ManagedPluginTrustDecision,
) -> Result<()> {
    let workspace = std::env::current_dir().context("Failed to resolve current directory")?;
    let snapshot = set_managed_plugin_trust(&workspace, package_id, decision)
        .await
        .map_err(|error| {
            anyhow!(crate::plugin_diagnostics::escape_terminal_text(
                &error.to_string()
            ))
        })?;
    let package = snapshot
        .packages
        .iter()
        .find(|package| package.package_id == package_id)
        .ok_or_else(|| anyhow!("Managed plugin package disappeared during trust update"))?;
    let trust_epoch = snapshot
        .trust_epoch
        .ok_or_else(|| anyhow!("Managed plugin source review epoch is unavailable after update"))?;
    println!(
        "Plugin package {} {} is now {} (source review epoch {}).",
        crate::plugin_diagnostics::escape_terminal_text(&package.package_id),
        crate::plugin_diagnostics::escape_terminal_text(&package.version),
        plugin_trust_label(package.trust_level),
        trust_epoch
    );
    println!(
        "Source: {}",
        crate::plugin_diagnostics::escape_terminal_text(&package.source_path)
    );
    println!(
        "Adapter: {}",
        crate::plugin_diagnostics::escape_terminal_text(&package.adapter)
    );
    println!("Content hash: {}", package.content_hash);
    match decision {
        ManagedPluginTrustDecision::ApproveSource => {
            println!("The current manifest and declared files are approved for source review.");
        }
        ManagedPluginTrustDecision::Denied => {
            println!("The current manifest and declared files are denied for this workspace.");
        }
        ManagedPluginTrustDecision::Revoked => {
            println!("The previous approval has been revoked for this workspace.");
        }
    }
    println!("Execution remains unavailable; this action does not enable the package.");
    Ok(())
}

pub(crate) async fn activate_plugin(package_id: &str, confirm: Option<&str>) -> Result<()> {
    let workspace = std::env::current_dir().context("Failed to resolve current directory")?;
    let view = if let Some(content_hash) = confirm {
        activate_managed_plugin(&workspace, package_id, Some(content_hash)).await
    } else {
        preview_managed_plugin_activation(&workspace, package_id).await
    }
    .map_err(|error| {
        let diagnostic = crate::plugin_diagnostics::escape_terminal_text(&error.to_string());
        if confirm.is_some() {
            anyhow!(
                "{}\nRe-run `openbitfun plugins activate {}` to preview the current content, then confirm with the new content hash.",
                diagnostic,
                crate::plugin_diagnostics::escape_terminal_text(package_id)
            )
        } else {
            anyhow!(diagnostic)
        }
    })?;

    print_plugin_activation(&view, confirm.is_none());
    if confirm.is_none() {
        println!();
        println!(
            "No activation state changed. Re-run `openbitfun plugins activate {} --confirm {}` to confirm this exact package content.",
            crate::plugin_diagnostics::escape_terminal_text(package_id),
            crate::plugin_diagnostics::escape_terminal_text(&view.content_hash)
        );
    }
    Ok(())
}

pub(crate) async fn deactivate_plugin(package_id: &str) -> Result<()> {
    let workspace = std::env::current_dir().context("Failed to resolve current directory")?;
    let result = deactivate_managed_plugin(&workspace, package_id)
        .await
        .map_err(|error| {
            let diagnostic = crate::plugin_diagnostics::escape_terminal_text(&error.to_string());
            if matches!(
                error,
                ManagedPluginSourceError::DeactivationPersistenceUncertain { .. }
            ) {
                anyhow!(
                    "{diagnostic}\nThe saved state may already be cleared. Retry `openbitfun plugins deactivate {}` to confirm the result; the operation is idempotent.",
                    crate::plugin_diagnostics::escape_terminal_text(package_id)
                )
            } else {
                anyhow!(diagnostic)
            }
        })?;
    match result {
        ManagedPluginDeactivationResult::Deactivated {
            package_id,
            diagnostics,
        } => {
            let package_id = crate::plugin_diagnostics::escape_terminal_text(&package_id);
            println!("Plugin package {package_id} was deactivated.");
            print_deactivation_diagnostics(&diagnostics);
        }
        ManagedPluginDeactivationResult::ResidualActivationCleared {
            package_id,
            current_package_available,
            diagnostics,
        } => {
            let package_id = crate::plugin_diagnostics::escape_terminal_text(&package_id);
            match current_package_available {
                Some(true) => println!(
                    "Plugin package {package_id} previous source's saved activation state was cleared; the current package was not active."
                ),
                Some(false) => println!(
                    "Plugin package {package_id} is unavailable; its saved activation state was cleared."
                ),
                None => println!(
                    "Plugin package {package_id} saved activation state was cleared; current package availability could not be determined."
                ),
            }
            print_deactivation_diagnostics(&diagnostics);
        }
        ManagedPluginDeactivationResult::AlreadyInactive {
            package_id,
            current_package_available,
            diagnostics,
        } => {
            let package_id = crate::plugin_diagnostics::escape_terminal_text(&package_id);
            match current_package_available {
                Some(true) => println!("Plugin package {package_id} was already inactive."),
                Some(false) => println!(
                    "Plugin package {package_id} is unavailable and has no saved activation state."
                ),
                None => println!(
                    "Plugin package {package_id} has no saved activation state; current package availability could not be determined."
                ),
            }
            print_deactivation_diagnostics(&diagnostics);
        }
    }
    println!("No plugin code or candidate effect was executed.");
    Ok(())
}

fn print_deactivation_diagnostics(diagnostics: &[ManagedPluginSourceIssue]) {
    for diagnostic in diagnostics {
        println!("- {}", render_plugin_source_issue(diagnostic));
    }
}

fn render_plugin_source_issue(issue: &ManagedPluginSourceIssue) -> String {
    format!(
        "[{}:{}] {}: {}",
        if issue.is_error { "error" } else { "warn" },
        crate::plugin_diagnostics::escape_terminal_text(&issue.code),
        crate::plugin_diagnostics::escape_terminal_text(&issue.source_path),
        crate::plugin_diagnostics::escape_terminal_text(&issue.message)
    )
}

fn print_plugin_activation(view: &ManagedPluginActivationView, preview: bool) {
    println!(
        "Plugin activation {}",
        if preview { "preview" } else { "result" }
    );
    println!();
    println!(
        "Package: {} {}",
        crate::plugin_diagnostics::escape_terminal_text(&view.package_id),
        crate::plugin_diagnostics::escape_terminal_text(&view.version)
    );
    println!(
        "Adapter: {}",
        crate::plugin_diagnostics::escape_terminal_text(&view.adapter)
    );
    println!("Content hash: {}", view.content_hash);
    println!(
        "Custom tool candidates: {}",
        if view.provider_candidates_supported {
            "supported"
        } else {
            "not found"
        }
    );
    println!(
        "Permission required before use: {}",
        if view.permission_required {
            "yes"
        } else {
            "no"
        }
    );
    println!("Entries: {}", view.entry_ids.len());
    for entry_id in &view.entry_ids {
        println!(
            "- {}",
            crate::plugin_diagnostics::escape_terminal_text(entry_id)
        );
    }
    println!(
        "{}: {}",
        if preview {
            "Declared candidates requiring permission"
        } else {
            "Candidates requiring permission"
        },
        view.candidates.len()
    );
    for candidate in &view.candidates {
        println!(
            "- {} -> {} (risk: {})",
            crate::plugin_diagnostics::escape_terminal_text(&candidate.entry_id),
            crate::plugin_diagnostics::escape_terminal_text(&candidate.target),
            candidate.risk_level
        );
    }
    for diagnostic in &view.diagnostics {
        println!(
            "- [diagnostic] {}",
            crate::plugin_diagnostics::escape_terminal_text(diagnostic)
        );
    }
    println!("Plugin code was not executed and no tool was registered.");
}

fn print_plugin_snapshot(snapshot: &ManagedPluginSourceSnapshot) {
    let approved_count = snapshot
        .packages
        .iter()
        .filter(|package| package.trust_level == ManagedPluginTrustLevel::SourceApproved)
        .count();
    let warning_count = snapshot
        .issues
        .iter()
        .filter(|issue| !issue.is_error)
        .count();
    let error_count = snapshot
        .issues
        .iter()
        .filter(|issue| issue.is_error)
        .count();
    println!("Managed plugin packages");
    println!();
    println!(
        "{}",
        crate::plugin_diagnostics::render_plugin_source_summary(
            snapshot.packages.len(),
            approved_count,
            warning_count,
            error_count,
        )
    );
    for package in &snapshot.packages {
        println!(
            "- {} {} ({}, {})",
            crate::plugin_diagnostics::escape_terminal_text(&package.package_id),
            crate::plugin_diagnostics::escape_terminal_text(&package.version),
            package.source_scope,
            if snapshot.discovery_complete {
                plugin_trust_label(package.trust_level)
            } else {
                "review state unavailable"
            },
        );
        println!(
            "  Source: {}",
            crate::plugin_diagnostics::escape_terminal_text(&package.source_path)
        );
        println!(
            "  Adapter: {}",
            crate::plugin_diagnostics::escape_terminal_text(&package.adapter)
        );
        println!("  Content hash: {}", package.content_hash);
        println!(
            "  Activation: {}",
            if !snapshot.discovery_complete {
                "unknown; source discovery is incomplete"
            } else if package.activated {
                "active for candidate projection; plugin code is not executed"
            } else {
                "inactive; source review does not activate this package"
            }
        );
    }
    for issue in &snapshot.issues {
        println!("- {}", render_plugin_source_issue(issue));
    }
    println!(
        "{}",
        crate::plugin_diagnostics::render_source_review_epoch(snapshot.trust_epoch)
    );
    println!(
        "Activation epoch: {}",
        snapshot
            .activation_epoch
            .map(|epoch| epoch.to_string())
            .unwrap_or_else(|| "unavailable".to_string())
    );
}

fn plugin_trust_label(trust_level: ManagedPluginTrustLevel) -> &'static str {
    match trust_level {
        ManagedPluginTrustLevel::Unknown => "unreviewed",
        ManagedPluginTrustLevel::SourceApproved => "source-approved",
        ManagedPluginTrustLevel::Denied => "denied",
        ManagedPluginTrustLevel::Revoked => "revoked",
        _ => "other",
    }
}

pub(crate) async fn print_mcp_config_summary() -> Result<()> {
    let config_service = ensure_global_config_service().await?;
    let mcp_service = openbitfun_core::service::mcp::MCPService::new(config_service)
        .map_err(|error| anyhow!(error.to_string()))?;
    let configs = mcp_service.config_service().load_all_configs().await?;

    println!("MCP configuration summary");
    println!();
    println!(
        "{}",
        crate::plugin_diagnostics::render_mcp_configuration_count(configs.len())
    );
    println!("This command does not probe server readiness.");
    Ok(())
}

pub(crate) async fn print_doctor(product_runtime: &ProductRuntimeParts) -> Result<bool> {
    let workspace = std::env::current_dir().context("Failed to resolve current directory")?;
    let config_dir = crate::config::CliConfig::config_dir()?;
    let config_service = ensure_global_config_service().await?;
    let models = config_service.get_ai_models().await?;
    let agent_registry = get_agent_registry();
    let workspace_id = crate::create_cli_local_workspace(&workspace).await?.id;
    let external_source_error =
        openbitfun_core::external_sources::ensure_external_source_workspace_snapshot(Some(
            &workspace_id,
        ))
        .await
        .err();
    let modes = agent_registry
        .get_modes_info_for_workspace(Some(&workspace_id), true)
        .await;
    let subagents = agent_registry.get_subagents_info(Some(&workspace_id)).await;
    let mcp_service = openbitfun_core::service::mcp::MCPService::new(config_service.clone())
        .map_err(|error| anyhow!(error.to_string()))?;
    let mcp_configs = mcp_service.config_service().load_all_configs().await?;
    let plugin_sources = refresh_managed_plugin_sources(&workspace)
        .await
        .map_err(|error| anyhow!(error.to_string()))?;
    let approved_plugin_count = plugin_sources
        .packages
        .iter()
        .filter(|package| package.trust_level == ManagedPluginTrustLevel::SourceApproved)
        .count();
    let active_plugin_count = plugin_sources
        .packages
        .iter()
        .filter(|package| package.activated)
        .count();
    let plugin_warning_count = plugin_sources
        .issues
        .iter()
        .filter(|issue| !issue.is_error)
        .count();
    let plugin_error_count = plugin_sources
        .issues
        .iter()
        .filter(|issue| issue.is_error)
        .count();
    let plugin_sources_ready =
        crate::plugin_diagnostics::plugin_source_check_passes(plugin_error_count);

    println!("OpenBitFun CLI doctor");
    println!();
    println!(
        "[ok] Product runtime: {} assembly-ready",
        product_runtime.plan().profile().id()
    );
    println!("[ok] Runtime capability registrations: complete");
    println!("[info] Execution owner: openbitfun-core compatibility");
    match product_runtime.plugin_runtime().availability() {
        PluginRuntimeAvailability::Disabled { reason } => {
            println!("[info] Plugin runtime: disabled ({reason})");
        }
        PluginRuntimeAvailability::ProjectionOnly { reason } => {
            println!("[info] Plugin runtime: projection-only ({reason})");
        }
        PluginRuntimeAvailability::Unavailable { reason } => {
            println!("[info] Plugin runtime: unavailable ({reason})");
        }
        PluginRuntimeAvailability::Available => {
            println!("[ok] Plugin runtime: available");
        }
        _ => {
            println!("[info] Plugin runtime: unknown");
        }
    }
    println!("[ok] Workspace: {}", workspace.display());
    println!("[ok] Config directory: {}", config_dir.display());
    println!("[ok] Agent modes: {}", modes.len());
    println!("[ok] Subagents: {}", subagents.len());
    if let Some(error) = external_source_error.as_deref() {
        println!(
            "[warn] External agent sources were not refreshed: {}",
            crate::plugin_diagnostics::escape_terminal_text(error)
        );
    } else {
        println!("[ok] External agent sources: refreshed");
    }
    println!(
        "[ok] AI models: {} total, {} enabled",
        models.len(),
        models.iter().filter(|m| m.enabled).count()
    );
    println!("[ok] MCP configuration entries: {}", mcp_configs.len());
    println!(
        "{}",
        crate::plugin_diagnostics::render_plugin_source_summary(
            plugin_sources.packages.len(),
            approved_plugin_count,
            plugin_warning_count,
            plugin_error_count,
        )
    );
    if plugin_sources.discovery_complete {
        println!(
            "[ok] Managed plugin source integrity checked; {} active. Candidate projection was not probed.",
            active_plugin_count
        );
    } else {
        println!(
            "[error] Managed plugin source scan is incomplete; review and activation status are unavailable. Candidate projection was not probed."
        );
    }
    for issue in plugin_sources.issues.iter().take(10) {
        println!("  - {}", render_plugin_source_issue(issue));
    }
    if plugin_sources.issues.len() > 10 {
        println!(
            "  - {} additional plugin diagnostics omitted",
            plugin_sources.issues.len() - 10
        );
    }
    println!();
    let doctor_checks_ready = external_source_error.is_none() && plugin_sources_ready;
    if !plugin_sources_ready {
        println!("Doctor checks found plugin source errors.");
    } else if external_source_error.is_some() {
        println!("Doctor checks completed with an external agent source warning.");
    } else if plugin_warning_count > 0 {
        println!("Doctor checks completed with plugin warnings.");
    } else {
        println!("Doctor checks passed.");
    }
    Ok(doctor_checks_ready)
}

#[cfg(test)]
mod tests {
    use super::{parse_local_command, select_server_type, validate_usage_session_id};

    #[test]
    fn local_command_parser_preserves_quoted_arguments() {
        let (command, args) =
            parse_local_command(r#"node "path with spaces/server.js" --flag "hello world""#)
                .expect("parse quoted command");

        assert_eq!(command, "node");
        assert_eq!(
            args,
            ["path with spaces/server.js", "--flag", "hello world"]
        );
    }

    #[test]
    fn local_command_parser_rejects_unclosed_quotes() {
        let error =
            parse_local_command(r#"node "unterminated"#).expect_err("unclosed quotes must fail");

        assert!(error.to_string().contains("unclosed quote"), "{error}");
    }

    #[test]
    fn non_interactive_server_type_must_be_explicit() {
        let error = select_server_type(None, true)
            .expect_err("non-interactive add must require an explicit type");

        assert!(error.to_string().contains("--type"), "{error}");
    }

    #[test]
    fn usage_rejects_path_like_session_ids_before_runtime_initialization() {
        let error = validate_usage_session_id("../../other-project/session")
            .expect_err("usage must reject path-like session ids");

        assert!(error.to_string().contains("session_id"), "{error}");
    }
}
