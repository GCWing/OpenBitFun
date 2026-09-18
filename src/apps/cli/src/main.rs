// Trait resolution for this crate's async call graph (reqwest/h2 futures behind
// several layers of `async fn`) exceeds the default depth.
#![recursion_limit = "256"]

/// OpenBitFun CLI
///
/// Command-line interface version, supports:
/// - Interactive TUI
/// - Single command execution
/// - Batch task processing
mod account;
mod acp_cli;
mod actions;
mod agent;
#[allow(dead_code)]
mod chat_state;
mod config;
mod daemon;
mod diagnostics;
mod dispatch;
mod hook_import;
mod logging;
mod management;
mod mcp_import;
mod model_selection;
mod modes;
mod peer_host;
mod plugin_diagnostics;
mod plugin_host_activation;
mod product_assembly;
mod prompt_stash;
mod prompts;
mod root_handlers;
mod runtime;
mod self_update;
mod server_host;
mod shared_runtime;
mod terminal_attention;
mod ui;

use anyhow::{anyhow, Result};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand, ValueEnum};
use openbitfun_core::service::remote_connect::DeviceIdentity;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};

use agent::runtime_client::CliAgentRuntimeClient;
use config::CliConfig;
use hook_import::HookAction;
use mcp_import::{McpImportCommand, McpImportOutputFormat};
use modes::chat::ChatMode;
use modes::exec::{ExecApprovalMode, ExecOutputFormat};

pub(crate) const PLUGIN_HOST_LAUNCH_POLICY: openbitfun_core::plugin_host::PluginHostLaunchPolicy =
    openbitfun_core::plugin_host::PluginHostLaunchPolicy::Enabled;

// ======================== Global MCP Service ========================

static MCP_SERVICE: OnceLock<std::sync::Arc<openbitfun_core::service::mcp::MCPService>> =
    OnceLock::new();

/// MCP initialization status: 0=not started, 1=in progress, 2=completed, 3=failed
static MCP_INIT_STATUS: OnceLock<AtomicU8> = OnceLock::new();

/// Get the MCP init status atomic
fn get_mcp_init_status() -> &'static AtomicU8 {
    MCP_INIT_STATUS.get_or_init(|| AtomicU8::new(0))
}

/// Get MCP status text for UI display
pub fn get_mcp_status_text() -> String {
    let status = get_mcp_init_status().load(Ordering::Relaxed);
    match status {
        0 => "MCP: Pending".to_string(),
        1 => "MCP: Connecting...".to_string(),
        2 => "MCP: Ready".to_string(),
        3 => "MCP: Failed".to_string(),
        _ => "MCP: Unknown".to_string(),
    }
}

fn final_change_verification_enabled(
    verify_final_changes: bool,
    no_verify_final_changes: bool,
) -> bool {
    verify_final_changes && !no_verify_final_changes
}

/// Get the global MCP service instance (if initialized)
pub fn get_mcp_service(
) -> Option<&'static std::sync::Arc<openbitfun_core::service::mcp::MCPService>> {
    MCP_SERVICE.get()
}

pub(crate) fn ensure_cli_mcp_service(
    config_service: Arc<openbitfun_core::service::config::ConfigService>,
) -> Option<Arc<openbitfun_core::service::mcp::MCPService>> {
    if let Some(service) = get_mcp_service() {
        return Some(service.clone());
    }

    let service = match openbitfun_core::service::mcp::MCPService::new(config_service) {
        Ok(service) => Arc::new(service),
        Err(error) => {
            tracing::warn!("Failed to create MCP service: {}", error);
            get_mcp_init_status().store(3, Ordering::Relaxed);
            return None;
        }
    };

    if MCP_SERVICE.set(service.clone()).is_err() {
        return get_mcp_service().cloned();
    }
    openbitfun_core::service::mcp::set_global_mcp_service(service.clone());
    get_mcp_init_status().store(1, Ordering::Relaxed);

    // Shared TUI keeps the pre-migration CLI-local MCP compatibility path. It
    // is intentionally separate from the MCP manager inside Shared Runtime;
    // this process must not be mistaken for that Runtime's owner.
    let initializing = service.clone();
    tokio::spawn(async move {
        match initializing.server_manager().initialize_all().await {
            Ok(_) => {
                tracing::info!("MCP servers initialized successfully");
                get_mcp_init_status().store(2, Ordering::Relaxed);
            }
            Err(error) => {
                tracing::warn!("Failed to initialize MCP servers: {}", error);
                get_mcp_init_status().store(3, Ordering::Relaxed);
            }
        }
    });

    Some(service)
}

#[derive(Parser)]
#[command(name = "openbitfun")]
#[command(about = "OpenBitFun CLI - AI agent-driven command-line programming assistant", long_about = None)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Enable verbose logging
    #[arg(short, long, global = true)]
    verbose: bool,

    /// Use the opt-in Shared Runtime for interactive TUI mode
    /// Multiple TUIs may share one workspace Runtime; each controls a Session at a time.
    /// Automation, desktop, and remote modes remain unchanged.
    #[arg(long, verbatim_doc_comment)]
    shared: bool,

    /// Continue the most recent session (skip startup page)
    #[arg(long = "continue", conflicts_with = "session")]
    continue_last: bool,

    /// Open a specific session by ID (or "last" for the most recent)
    #[arg(long, conflicts_with = "continue_last")]
    session: Option<String>,

    /// Specify the model ID for this session
    #[arg(long)]
    model: Option<String>,

    /// Specify the agent type for this session
    #[arg(long)]
    agent: Option<String>,

    /// Select the Agent Harness for this session.
    #[arg(long, value_parser = harness_profile_parser())]
    harness_profile: Option<String>,
}

fn harness_profile_parser() -> clap::builder::PossibleValuesParser {
    use openbitfun_core_types::agent_identity::HarnessId;
    clap::builder::PossibleValuesParser::new(HarnessId::ALL.map(|id| {
        clap::builder::PossibleValue::new(id.as_str()).aliases(id.legacy_ids().iter().copied())
    }))
}

fn shared_tui_requested(shared: bool, command: &Option<Commands>) -> Result<bool> {
    if shared && !matches!(command, None | Some(Commands::Chat { .. })) {
        return Err(anyhow!(
            "--shared is available only for the interactive TUI (`openbitfun --shared` or `openbitfun chat --shared`); other commands and applications are unchanged"
        ));
    }
    Ok(shared || matches!(command, Some(Commands::Chat { shared: true, .. })))
}

fn validate_global_harness_profile_scope(
    harness_profile: Option<&str>,
    command: &Option<Commands>,
) -> Result<()> {
    if harness_profile.is_none()
        || matches!(
            command,
            None | Some(Commands::Chat { .. } | Commands::Exec { .. })
        )
    {
        return Ok(());
    }
    Err(anyhow!(
        "--harness-profile is supported only by interactive chat and headless exec; this command cannot silently fall back to Standard"
    ))
}

fn resolved_command_harness_profile(
    global: &Option<String>,
    command: Option<String>,
) -> Option<String> {
    command.or_else(|| global.clone())
}

fn agent_type_with_harness_profile(agent_type: String, harness_profile: Option<&str>) -> String {
    use openbitfun_core_types::agent_identity::canonical_agent_id;
    match harness_profile {
        // The retired CLI profile was an overlay: balanced preserved --agent.
        Some("balanced") | None => canonical_agent_id(&agent_type).to_string(),
        Some(profile) => canonical_agent_id(profile).to_string(),
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Start interactive chat (TUI)
    Chat {
        /// Agent type
        #[arg(short, long, default_value = "Standard")]
        agent: String,

        /// Use the opt-in Shared Runtime for this interactive TUI
        #[arg(long)]
        shared: bool,

        /// Agent Harness for this session.
        #[arg(long, value_parser = harness_profile_parser())]
        harness_profile: Option<String>,
    },

    #[command(name = "__shared-runtime", hide = true)]
    SharedRuntime {
        #[arg(long)]
        workspace: std::path::PathBuf,
        #[arg(long)]
        instance_identity: String,
    },

    /// Execute single command
    Exec {
        /// User message. If omitted, stdin is used when piped.
        message: Option<String>,

        /// Agent type
        #[arg(short, long, default_value = "Standard")]
        agent: String,

        /// Agent Harness for this session.
        #[arg(long, value_parser = harness_profile_parser())]
        harness_profile: Option<String>,

        /// Continue the most recent session in the current workspace
        #[arg(short = 'c', long = "continue")]
        continue_last: bool,

        /// Resume a session by ID, or use "last" for the most recent session
        #[arg(short = 'r', long)]
        resume: Option<String>,

        /// Alias for --resume, compatible with opencode-style CLIs
        #[arg(short = 's', long)]
        session: Option<String>,

        /// Create a new session with a fixed session ID
        #[arg(long)]
        session_id: Option<String>,

        /// Fork the resumed session before executing the prompt
        #[arg(long = "fork-session")]
        fork_session: bool,

        /// Output format for automation
        #[arg(long, value_enum, default_value_t = ExecOutputFormat::Text)]
        output_format: ExecOutputFormat,

        /// Output git diff patch after execution (for SWE-bench evaluation)
        /// Without path outputs to terminal, with path saves to file
        /// The snapshot is captured before writing an explicit output artifact;
        /// the artifact itself is not included in the captured diff
        /// Example: --output-patch or --output-patch ./result.patch
        #[arg(long, num_args = 0..=1, default_missing_value = "-")]
        output_patch: Option<String>,

        /// Verify workspace changes before a successful headless exit (enabled by default)
        #[arg(long, default_value_t = true, action = clap::ArgAction::SetTrue)]
        verify_final_changes: bool,

        /// Disable automatic final-change verification
        #[arg(long, conflicts_with = "verify_final_changes")]
        no_verify_final_changes: bool,

        /// Auto-approve tool permissions that are not explicitly denied
        #[arg(long, conflicts_with = "confirm")]
        auto: bool,

        /// Deprecated compatibility flag; confirmations are rejected in non-interactive mode
        #[arg(long, hide = true, conflicts_with = "auto")]
        confirm: bool,
    },

    /// Session management
    Sessions {
        #[command(subcommand)]
        action: SessionAction,
    },

    /// Agent management
    Agents,

    /// Model management
    Models {
        #[command(subcommand)]
        action: Option<ModelAction>,
    },

    /// MCP server management
    Mcp {
        #[command(subcommand)]
        action: Option<McpAction>,
    },

    /// Inspect and review OpenBitFun-managed plugin packages
    ///
    /// Package layout: <package-root>/<package-id>/openbitfun.plugin.json
    Plugins {
        #[command(subcommand)]
        action: Option<PluginAction>,
    },

    /// Review and manage imported Claude Code and Codex command Hooks
    Hooks {
        #[command(subcommand)]
        action: Option<HookAction>,
    },

    /// Usage reporting
    Usage {
        /// Session ID to inspect; defaults to the most recent session in the current workspace
        session_id: Option<String>,
    },

    /// Diagnostic check
    Doctor,

    /// Configuration management
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },

    /// Health check
    Health,

    /// Check for and install the latest official Linux CLI release
    Update {
        /// Only report whether a newer version exists
        #[arg(long)]
        check: bool,
    },

    /// Manage the always-on account device host daemon
    ///
    /// The daemon holds the relay device-routing connection in a headless
    /// process so this device stays reachable by account peers whenever the
    /// machine is up, even without an interactive CLI running.
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },

    /// Run and inspect persistent tasks owned by this machine
    Dispatch {
        #[command(subcommand)]
        action: DispatchAction,
    },

    /// Start the OpenBitFun app server over stdio
    ///
    /// stdout carries JSON-RPC traffic only; logs are written to stderr.
    Server,

    /// Start or inspect the Agent Client Protocol (ACP) server
    Acp {
        #[command(subcommand)]
        action: Option<AcpAction>,
    },
}

#[derive(Subcommand)]
enum ModelAction {
    /// List configured models
    List,
    /// Set the default model for all modes
    SetDefault {
        /// Model id
        model_id: String,
    },
}

#[derive(Subcommand)]
enum McpAction {
    /// List configured MCP servers
    List,
    /// Show the configured MCP entries without probing readiness
    Doctor,
    /// Enable an MCP server by id
    Enable {
        /// MCP server id
        server_id: String,
    },
    /// Disable an MCP server by id
    Disable {
        /// MCP server id
        server_id: String,
    },
    /// Print the stored MCP JSON config
    Config,
    /// Preview or explicitly import external MCP declarations
    Import {
        /// Apply the current plan; without this flag the command is read-only
        #[arg(long)]
        apply: bool,
        /// Import only this eligible candidate; repeat to select multiple
        #[arg(long, action = clap::ArgAction::Append, requires = "apply")]
        candidate: Vec<String>,
        /// Override the native ID; requires exactly one candidate
        #[arg(long, requires = "candidate")]
        native_id: Option<String>,
        /// Output format for automation
        #[arg(long, value_enum, default_value_t = McpImportOutputFormat::Text)]
        format: McpImportOutputFormat,
    },
    /// Add an MCP server (three-step wizard: name, type, command/URL)
    Add {
        /// Step 1: server name (also used as id; no spaces)
        #[arg(long)]
        name: Option<String>,
        /// Step 2: server type — accepts `local` or `remote`
        #[arg(long, value_parser = ["local", "remote"])]
        r#type: Option<String>,
        /// Step 3: launch command for a local server (e.g. `npx -y @modelcontextprotocol/server-xxx`)
        #[arg(long)]
        command: Option<String>,
        /// Step 3: server URL for a remote server
        #[arg(long)]
        url: Option<String>,
        /// Skip interactive prompts for missing fields; error instead
        #[arg(long)]
        non_interactive: bool,
    },
}

#[derive(Subcommand)]
enum PluginAction {
    /// List discovered packages and trust status
    List,
    /// Approve the current manifest and declared files without enabling execution
    ApproveSource { package_id: String },
    /// Deny the current manifest and declared files for this workspace
    Deny { package_id: String },
    /// Revoke the current package approval for this workspace
    Revoke { package_id: String },
    /// Preview or confirm activation of one source-approved package
    Activate {
        package_id: String,
        /// Confirm the exact content hash displayed by the activation preview
        #[arg(long, value_name = "CONTENT_HASH")]
        confirm: Option<String>,
    },
    /// Deactivate one package for this workspace
    Deactivate { package_id: String },
}

#[derive(Subcommand)]
enum AcpAction {
    /// Start the ACP server over stdio
    Serve,
    /// Show ACP server status and capabilities
    Status {
        /// Command name or path to show in generated examples
        #[arg(long, default_value = "openbitfun")]
        command: String,
    },
    /// Check local readiness for ACP clients
    Doctor {
        /// Command name or path to show in generated examples
        #[arg(long, default_value = "openbitfun")]
        command: String,
    },
    /// Print editor/client integration snippets
    Config {
        /// ACP client/editor to generate config for
        #[arg(long, value_enum, default_value_t = acp_cli::AcpConfigClient::Zed)]
        client: acp_cli::AcpConfigClient,

        /// Command name or path your editor should execute
        #[arg(long, default_value = "openbitfun")]
        command: String,
    },
    /// Manage external ACP agents that OpenBitFun can launch
    Clients {
        #[command(subcommand)]
        action: AcpClientsAction,
    },
    /// Run a prompt through an external ACP agent
    Run {
        /// External ACP agent to launch
        #[arg(value_enum)]
        client: acp_cli::ExternalAcpClient,

        /// Prompt to send to the external ACP agent
        prompt: String,

        /// Workspace directory for the external agent
        #[arg(long)]
        workspace: Option<String>,

        /// Timeout in seconds
        #[arg(long, default_value_t = 600)]
        timeout: u64,

        /// Permission handling for ACP tool permission requests
        #[arg(long, value_enum, default_value_t = acp_cli::CliAcpPermissionMode::AllowOnce)]
        permission: acp_cli::CliAcpPermissionMode,
    },
}

#[derive(Subcommand)]
enum AcpClientsAction {
    /// List configured and built-in external ACP agents
    List,
    /// Check whether external ACP agent CLIs and adapters are available
    Doctor,
    /// Enable a built-in external ACP agent
    Enable {
        /// Built-in external ACP agent
        #[arg(value_enum)]
        client: acp_cli::ExternalAcpClient,

        /// Permission handling to store for this client
        #[arg(long, value_enum, default_value_t = acp_cli::CliAcpPermissionMode::Ask)]
        permission: acp_cli::CliAcpPermissionMode,
    },
    /// Disable an external ACP agent by id
    Disable {
        /// External ACP client id, for example opencode
        client_id: String,
    },
    /// Print the stored ACP client JSON
    Config,
}

#[derive(Subcommand)]
enum SessionAction {
    /// List all sessions
    List,
    /// Show session details
    Show {
        /// Session ID (or "last" for the most recent)
        id: String,
    },
    /// Delete session
    Delete {
        /// Session ID
        id: String,
    },
    /// Resume a session in the interactive TUI
    Resume {
        /// Session ID (or "last" for the most recent)
        id: String,
    },
    /// Continue the most recent session in the interactive TUI
    Continue,
    /// Fork a session at the latest persisted turn
    Fork {
        /// Session ID (or "last" for the most recent)
        id: String,
        /// Print only the new session ID
        #[arg(long)]
        id_only: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BootstrapProfile {
    Interactive,
    Execution,
    Management,
}

impl BootstrapProfile {
    const fn starts_peer_host(
        self,
        deployment: openbitfun_services_core::runtime_ownership::RuntimeDeployment,
    ) -> bool {
        matches!(self, Self::Interactive)
            && matches!(
                deployment,
                openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded
            )
    }

    const fn starts_mcp(self) -> bool {
        matches!(self, Self::Interactive | Self::Execution)
    }

    const fn starts_plugin_host(self) -> bool {
        matches!(
            PLUGIN_HOST_LAUNCH_POLICY,
            openbitfun_core::plugin_host::PluginHostLaunchPolicy::Enabled
        ) && matches!(self, Self::Interactive | Self::Execution)
    }
}

impl SessionAction {
    const fn bootstrap_profile(&self) -> BootstrapProfile {
        match self {
            Self::Resume { .. } | Self::Continue => BootstrapProfile::Interactive,
            Self::List | Self::Show { .. } | Self::Delete { .. } | Self::Fork { .. } => {
                BootstrapProfile::Management
            }
        }
    }
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Show configuration
    Show,
    /// Edit configuration
    Edit,
    /// Reset to default configuration
    Reset,
    /// Inspect or change external AI application compatibility
    External {
        #[command(subcommand)]
        action: ExternalConfigAction,
    },
}

#[derive(Subcommand)]
enum ExternalConfigAction {
    /// Show effective global and project compatibility settings
    Status,
    /// Enable or disable external compatibility
    SetEnabled {
        /// Whether external compatibility is enabled
        #[arg(action = clap::ArgAction::Set, value_parser = clap::value_parser!(bool))]
        enabled: bool,
        #[arg(long, value_enum, default_value = "project")]
        scope: ExternalPolicyScopeArg,
    },
    /// Select an external ecosystem compatibility mode
    SetMode {
        #[arg(value_enum)]
        mode: ExternalPolicyModeArg,
        /// Ecosystem id; optional when exactly one ecosystem is registered
        #[arg(long)]
        ecosystem: Option<String>,
        #[arg(long, value_enum, default_value = "project")]
        scope: ExternalPolicyScopeArg,
    },
    /// Customize one external ecosystem capability
    SetCapability {
        #[arg(value_enum)]
        capability: ExternalCapabilityArg,
        #[arg(value_enum)]
        access: ExternalAccessArg,
        /// Ecosystem id; optional when exactly one ecosystem is registered
        #[arg(long)]
        ecosystem: Option<String>,
        #[arg(long, value_enum, default_value = "project")]
        scope: ExternalPolicyScopeArg,
    },
    /// Remove this project's overrides and inherit global settings
    ResetProject,
    /// Back up and reset a policy written by an incompatible OpenBitFun version
    ResetIncompatible,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ExternalPolicyScopeArg {
    Global,
    Project,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ExternalPolicyModeArg {
    Recommended,
    DiscoverOnly,
    Off,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ExternalCapabilityArg {
    Command,
    Tool,
    Agent,
    Mcp,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ExternalAccessArg {
    Off,
    Discover,
    Ask,
    Auto,
}

#[derive(Subcommand)]
enum DaemonAction {
    /// Run the daemon in the foreground (used by the service manager)
    Run,
    /// Install and start the auto-start service (systemd user unit / LaunchAgent)
    Install,
    /// Stop and remove the auto-start service
    Uninstall,
    /// Show daemon and auto-start service status
    Status,
    #[command(name = "__dispatch_identity", hide = true)]
    DispatchIdentity,
    #[command(name = "__dispatch_provision", hide = true)]
    DispatchProvision { request_path: std::path::PathBuf },
    #[command(name = "__dispatch_deprovision", hide = true)]
    DispatchDeprovision { device_id: String, user_id: String },
}

#[derive(Subcommand)]
pub(crate) enum DispatchAction {
    /// Report target protocol and local execution readiness
    Probe,
    /// Persist and start a detached dispatch job
    Submit,
    /// Read job state and incremental events
    Status,
    /// Cancel a detached dispatch job
    Cancel,
    /// List jobs owned by this machine
    List,
    /// Answer a permission request for a remotely supervised job
    Answer,
    /// Append a steering message to a queued or running job
    Append,
    /// Queue the next turn of a dispatch session whose previous turn finished
    Continue,
    /// Read persisted session facts (usage report) without starting a turn
    Query,
    #[command(name = "__workspace_provision", hide = true)]
    WorkspaceProvision,
    #[command(name = "__workspace_bundle_begin", hide = true)]
    WorkspaceBundleBegin,
    #[command(name = "__workspace_bundle_chunk", hide = true)]
    WorkspaceBundleChunk,
    #[command(name = "__workspace_bundle_commit", hide = true)]
    WorkspaceBundleCommit,
    #[command(name = "__workspace_sync", hide = true)]
    WorkspaceSync,
    #[command(name = "__workspace_sync_chunk", hide = true)]
    WorkspaceSyncChunk,
    #[command(name = "__workspace_provision_run", hide = true)]
    WorkspaceProvisionRun {
        #[arg(long)]
        job: String,
    },
    #[command(name = "__workspace_bundle_commit_run", hide = true)]
    WorkspaceBundleCommitRun {
        #[arg(long)]
        job: String,
    },
    #[command(name = "__workspace_sync_run", hide = true)]
    WorkspaceSyncRun {
        #[arg(long)]
        job: String,
    },
    #[command(name = "__run", hide = true)]
    Run {
        #[arg(long)]
        job: String,
    },
}

// ======================== System Initialization ========================

/// Return the current project path. CLI session scope is intentionally cwd-only.
fn setup_workspace() -> Option<String> {
    let workspace_path = std::env::current_dir().ok();
    tracing::info!("Workspace path set: {:?}", workspace_path);
    workspace_path.map(|p| p.to_string_lossy().to_string())
}

fn terminal_scripts_dir() -> std::path::PathBuf {
    CliConfig::config_dir()
        .ok()
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "{}-cli",
                openbitfun_core_types::product_identity::data_namespace()
            ))
        })
        .join("temp")
        .join("scripts")
}

async fn initialize_terminal_service() {
    use openbitfun_core::infrastructure::try_get_path_manager_arc;
    use openbitfun_core::service::runtime::RuntimeManager;
    use openbitfun_core::service::terminal::{TerminalApi, TerminalConfig};

    let mut terminal_config = TerminalConfig::default();
    terminal_config.shell_integration.scripts_dir = Some(terminal_scripts_dir());
    match try_get_path_manager_arc() {
        Ok(path_manager) => {
            terminal_config.transcript.root_dir =
                Some(path_manager.user_data_dir().join("terminals"));
        }
        Err(error) => {
            tracing::warn!(
                "Failed to configure terminal transcript storage; recording is disabled: {}",
                error
            );
        }
    }

    if let Ok(runtime_manager) = RuntimeManager::new() {
        let current_path = std::env::var("PATH").ok();
        if let Some(merged_path) = runtime_manager.merged_path_env(current_path.as_deref()) {
            terminal_config
                .env
                .insert("PATH".to_string(), merged_path.clone());
            #[cfg(windows)]
            {
                terminal_config.env.insert("Path".to_string(), merged_path);
            }
        }
    } else {
        tracing::warn!("Failed to initialize runtime manager for terminal PATH");
    }

    let _terminal_api = TerminalApi::new(terminal_config).await;
    tracing::info!("Terminal service initialized");
}

/// Initialize Core owners and assemble one invocation-scoped CLI runtime.
async fn initialize_core_services(
    workspace_root: &std::path::Path,
    approval_policy: runtime::approval::CliApprovalPolicy,
    bootstrap_profile: BootstrapProfile,
) -> Result<std::sync::Arc<runtime::CliRuntimeContext>> {
    initialize_core_services_for_deployment(
        workspace_root,
        approval_policy,
        bootstrap_profile,
        openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded,
    )
    .await
}

async fn initialize_core_services_for_deployment(
    workspace_root: &std::path::Path,
    approval_policy: runtime::approval::CliApprovalPolicy,
    bootstrap_profile: BootstrapProfile,
    deployment: openbitfun_services_core::runtime_ownership::RuntimeDeployment,
) -> Result<std::sync::Arc<runtime::CliRuntimeContext>> {
    use openbitfun_core::infrastructure::ai::AIClientFactory;

    agent::agentic_system::select_agentic_system_profile(
        openbitfun_core::product_assembly::DeliveryProfile::Cli,
    )?;
    openbitfun_core::service::config::initialize_global_config()
        .await
        .map_err(|error| anyhow!("Failed to initialize global config service: {error}"))?;
    tracing::info!("Global config service initialized");
    if matches!(
        bootstrap_profile,
        BootstrapProfile::Interactive | BootstrapProfile::Execution
    ) {
        if let Err(error) =
            plugin_host_activation::ensure_configured_plugin_execution_supported().await
        {
            openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
                "CLI startup configuration",
                None,
                error,
            )
            .await;
        }
    }
    if bootstrap_profile.starts_plugin_host() {
        match openbitfun_core::plugin_host::initialize_configured_plugin_host_with_log_file(
            PLUGIN_HOST_LAUNCH_POLICY,
            logging::active_plugin_host_log_path(),
        )
        .await
        {
            Ok(openbitfun_core::plugin_host::PluginHostStartup::Disabled) => {}
            Ok(status) => tracing::info!("Plugin host initialization completed: {:?}", status),
            Err(error) => {
                openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
                    "CLI startup",
                    None,
                    error,
                )
                .await;
            }
        }
    }
    let path_manager = openbitfun_core::infrastructure::try_get_path_manager_arc()
        .map_err(|error| anyhow!(error.to_string()))?;
    let entrypoint = match (deployment, bootstrap_profile) {
        (
            openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded,
            BootstrapProfile::Interactive,
        ) => "cli-interactive",
        (openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded, _) => {
            "cli-headless"
        }
        (openbitfun_services_core::runtime_ownership::RuntimeDeployment::Shared, _) => {
            "shared-tui-runtime"
        }
    };
    let runtime_ownership =
        openbitfun_core::runtime_ownership::CoreRuntimeOwnership::fixed_workspace(
            path_manager.as_ref(),
            entrypoint,
            workspace_root,
            deployment,
        )
        .map_err(|error| anyhow!(error.startup_message(deployment, entrypoint)))?;
    let runtime_ownership = std::sync::Arc::new(runtime_ownership);

    let config_service = openbitfun_core::service::config::get_global_config_service()
        .await
        .ok();

    AIClientFactory::initialize_global()
        .await
        .map_err(|error| anyhow!("Failed to initialize global AIClientFactory: {error}"))?;
    tracing::info!("Global AI client factory initialized");

    initialize_terminal_service().await;

    let agentic_system = agent::agentic_system::init_agentic_system(
        openbitfun_core::product_assembly::DeliveryProfile::Cli,
        runtime_ownership,
    )
    .await
    .map_err(|error| anyhow!("Failed to initialize agentic system: {error}"))?;
    tracing::info!("Agentic system initialized");

    let workspace = create_cli_local_workspace(workspace_root).await?;
    let runtime = std::sync::Arc::new(runtime::CliRuntimeContext::build(
        agentic_system,
        workspace,
        approval_policy,
    )?);
    // Restore on the executing host for TUI, exec, Shared and detached jobs alike.
    runtime.account_runtime().try_restore_session().await;
    debug_assert!(runtime
        .product()
        .service_availability()
        .iter()
        .all(|entry| {
            runtime
                .services()
                .has_capability(entry.requirement().service_capability())
        }));
    tracing::info!(
        "CLI product runtime assembled: profile={}, services={}, plugin_runtime={:?}",
        runtime.product().plan().profile().id(),
        runtime.product().service_availability().len(),
        runtime.product().plugin_runtime(),
    );

    if bootstrap_profile.starts_peer_host(deployment) {
        if let Err(e) = peer_host::ensure_peer_host_ready(runtime.as_ref()).await {
            tracing::warn!("Failed to initialize CLI peer host services: {e}");
        } else {
            tracing::info!("CLI peer host services initialized");
        }
    }

    // Initialize MCP service in background (non-blocking).
    if bootstrap_profile.starts_mcp() {
        if let Some(config_service) = config_service {
            ensure_cli_mcp_service(config_service);
        }
    }

    Ok(runtime)
}

/// Shutdown MCP servers gracefully
async fn shutdown_mcp_servers() {
    if let Some(mcp_service) = get_mcp_service() {
        if let Err(e) = mcp_service.server_manager().shutdown().await {
            tracing::warn!("Failed to shutdown MCP servers: {}", e);
        } else {
            tracing::info!("MCP servers shut down successfully");
        }
    }
}

// ======================== Interactive TUI Flow ========================

/// Run the full interactive TUI flow: loading screen → startup page → chat
async fn run_interactive(
    config: CliConfig,
    default_agent: String,
    _workspace_str: String,
    shared: bool,
    agent_override: Option<String>,
    model_id: Option<String>,
    harness_profile: Option<String>,
    session_override: Option<String>,
) -> Result<()> {
    use ui::startup::{StartupPage, StartupResult};

    if shared && harness_profile.is_some() {
        anyhow::bail!(
            "--harness-profile is not supported by the current Shared Runtime protocol; use embedded TUI"
        );
    }

    // 1. Initialize terminal and show loading screen
    let mut terminal = ui::init_terminal()?;
    ui::render_loading(&mut terminal, "Initializing system, please wait...")?;

    // 2. Set workspace path
    let workspace = setup_workspace();
    let workspace_path = workspace
        .as_deref()
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let runtime = if shared {
        None
    } else {
        Some(
            initialize_core_services(
                &workspace_path,
                runtime::approval::CliApprovalPolicy::Ask,
                BootstrapProfile::Interactive,
            )
            .await?,
        )
    };
    let agent = if let Some(runtime) = &runtime {
        Arc::new(agent::runtime_client::CliAgentRuntimeClient::new(runtime))
    } else {
        let client = shared_runtime::connect_or_start(&workspace_path).await?;
        client.health().await?;
        if !client.capabilities().interactive_tui {
            anyhow::bail!("Shared Runtime does not advertise interactive TUI support");
        }
        Arc::new(agent::runtime_client::CliAgentRuntimeClient::new_shared(
            client,
            &create_cli_local_workspace(&workspace_path).await?,
        ))
    };
    let account_runtime = runtime
        .as_ref()
        .map(|runtime| runtime.account_runtime().clone());
    // 3.5 Start device routing for the account restored by Runtime startup
    if !shared {
        let runtime = runtime
            .as_ref()
            .expect("Embedded account startup requires the CLI Runtime");
        if let Ok(account_info) = runtime.account_runtime().account_info().await {
            let user_id = account_info.user_id;
            tracing::info!("Restored account session for user {user_id}");
            if daemon::is_daemon_running() {
                tracing::info!(
                    "CLI daemon is running; skipping in-process device routing (daemon owns it)"
                );
            } else {
                let device = DeviceIdentity::from_current_machine()
                    .map_err(|e| anyhow!("detect device: {e}"))?;
                if let Err(e) = runtime
                    .account_runtime()
                    .restore_device_routing(&device.device_name)
                    .await
                {
                    tracing::warn!("Failed to restore device routing: {e}");
                }
            }
        }
    }

    // Resolve the agent override against the execution owner's mode catalog.
    // Embedded and Shared both report the catalog through the same client
    // boundary, so a Shared controller never falls back to its local registry.
    let effective_agent = if let Some(ref override_val) = agent_override {
        let modes = agent.available_agent_modes().await.map_err(|error| {
            anyhow::anyhow!("Failed to read the execution owner's agent mode catalog: {error}")
        })?;
        if modes.iter().any(|mode| mode.id == *override_val) {
            override_val.clone()
        } else {
            let available: Vec<&str> = modes.iter().map(|mode| mode.id.as_str()).collect();
            anyhow::bail!(
                "Agent '{override_val}' was not found in the execution owner's mode catalog. Available: {}",
                available.join(", ")
            );
        }
    } else {
        default_agent.clone()
    };
    let effective_agent =
        agent_type_with_harness_profile(effective_agent, harness_profile.as_deref());

    // If --continue or --session was given, skip the startup page and go directly
    // to chat with the resolved session.
    if let Some(ref session_spec) = session_override {
        let restore_session_id = resolve_startup_session_override(&agent, session_spec).await?;
        let mut chat_mode = ChatMode::new(
            config,
            effective_agent,
            workspace,
            Arc::clone(&agent),
            account_runtime.clone(),
        )
        .with_restore_session(restore_session_id);
        if let Some(mid) = model_id {
            chat_mode = chat_mode.with_model(mid);
        }
        let chat_result = chat_mode.run(Some(terminal));

        if !shared {
            shutdown_mcp_servers().await;
        }
        let _exit_reason = chat_result?;
        println!("Goodbye!");
        return Ok(());
    }

    // 4. Show startup page (with full command support)
    let mut startup_page = StartupPage::new(
        config,
        Arc::clone(&agent),
        account_runtime.clone(),
        effective_agent,
        workspace.clone(),
    );
    startup_page.set_model_override(model_id.clone());
    let startup_result = startup_page.run(&mut terminal)?;

    if let StartupResult::Exit = startup_result {
        shutdown_mcp_servers().await;
        ui::restore_terminal(terminal)?;
        println!("Goodbye!");
        return Ok(());
    }

    // 5. Parse startup result and enter chat
    let (restore_session_id, initial_prompt) = match &startup_result {
        StartupResult::NewSession { prompt } => (None, prompt.clone()),
        StartupResult::ContinueSession(id) => (Some(id.clone()), None),
        StartupResult::Exit => unreachable!(),
    };

    let agent_type = harness_profile
        .as_deref()
        .map(|profile| {
            agent_type_with_harness_profile(startup_page.agent_type().to_string(), Some(profile))
        })
        .unwrap_or_else(|| startup_page.agent_type().to_string());
    if matches!(startup_result, StartupResult::NewSession { .. }) {
        let selected_model_id = startup_page.selected_model_id().map(str::to_string);
        if selected_model_id.is_some() {
            let _session_id = agent
                .ensure_session_with_model(&agent_type, selected_model_id)
                .await?;
        }
    }
    // Use the current project workspace selected at process start.
    let workspace = startup_page.workspace();
    let config = startup_page.config().clone();
    let mut chat_mode = ChatMode::new(config, agent_type, workspace, agent, account_runtime);
    if let Some(session_id) = restore_session_id {
        chat_mode = chat_mode.with_restore_session(session_id);
    }
    if let Some(prompt) = initial_prompt {
        chat_mode = chat_mode.with_initial_prompt(prompt);
    }
    if let Some(mid) = model_id {
        chat_mode = chat_mode.with_model(mid);
    }
    let chat_result = chat_mode.run(Some(terminal));

    // 6. Cleanup, including fatal event-stream exits.
    shutdown_mcp_servers().await;
    let _exit_reason = chat_result?;
    println!("Goodbye!");

    Ok(())
}

/// Resolve a `--session` / `--continue` override to a concrete session ID.
/// "last" (or empty for --continue) resolves to the most recent session.
async fn resolve_startup_session_override(
    agent: &Arc<CliAgentRuntimeClient>,
    session_spec: &str,
) -> Result<String> {
    if session_spec == "last" || session_spec.is_empty() {
        let sessions = agent.list_sessions().await?;
        return sessions
            .first()
            .map(|s| s.session_id.clone())
            .ok_or_else(|| anyhow!("No history sessions for current project"));
    }
    openbitfun_agent_runtime::session_control::validate_session_id(session_spec)
        .map_err(anyhow::Error::msg)?;
    Ok(session_spec.to_string())
}

// ======================== Main ========================

#[derive(Debug)]
struct ReportedCliError {
    exit_code: i32,
}

impl std::fmt::Display for ReportedCliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CLI error was already reported")
    }
}

impl std::error::Error for ReportedCliError {}

fn is_dispatch_command(command: &Option<Commands>) -> bool {
    matches!(command, Some(Commands::Dispatch { .. }))
}

async fn run_cli() -> Result<()> {
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    let product_binary_name = option_env!("OPENBITFUN_PRODUCT_BINARY_NAME").unwrap_or("openbitfun");
    let product_display_name =
        option_env!("OPENBITFUN_PRODUCT_DISPLAY_NAME").unwrap_or("OpenBitFun CLI");
    let parsed = Cli::command()
        .name(product_binary_name)
        .bin_name(product_binary_name)
        .about(format!(
            "{product_display_name} - AI agent-driven command-line programming assistant"
        ))
        .try_get_matches_from(&raw_args)
        .and_then(|matches| Cli::from_arg_matches(&matches));
    let cli = match parsed {
        Ok(cli) => cli,
        Err(error)
            if exec_requests_json_output(&raw_args)
                && matches!(
                    error.kind(),
                    clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
                ) =>
        {
            error.print()?;
            return Ok(());
        }
        Err(error) if exec_requests_json_output(&raw_args) => {
            let exit_code = error.exit_code();
            let error = anyhow!(error.to_string());
            modes::exec::emit_preflight_json_error(ExecOutputFormat::Json, &error)?;
            return Err(anyhow::Error::new(ReportedCliError { exit_code }));
        }
        Err(error) => error.exit(),
    };

    let is_tui_mode = matches!(cli.command, None | Some(Commands::Chat { .. }));
    let is_shared_service = matches!(cli.command, Some(Commands::SharedRuntime { .. }));
    let use_shared_runtime = match shared_tui_requested(cli.shared, &cli.command) {
        Ok(shared) => shared,
        Err(error) if exec_requests_json_output(&raw_args) => {
            modes::exec::emit_preflight_json_error(ExecOutputFormat::Json, &error)?;
            return Err(anyhow::Error::new(ReportedCliError { exit_code: 2 }));
        }
        Err(error) => return Err(error),
    };
    validate_global_harness_profile_scope(cli.harness_profile.as_deref(), &cli.command)?;
    let is_exec_mode = matches!(cli.command, Some(Commands::Exec { .. }));
    let is_dispatch_mode = is_dispatch_command(&cli.command);
    let is_daemon_run = matches!(
        cli.command,
        Some(Commands::Daemon {
            action: DaemonAction::Run,
        })
    );
    let file_log_level = logging::default_log_level(cli.verbose);
    let stderr_log_level = if cli.verbose {
        tracing::Level::TRACE
    } else {
        tracing::Level::ERROR
    };

    if is_shared_service {
        let service_log_dir =
            logging::resolve_logs_root().join(format!("shared-runtime-{}", std::process::id()));
        logging::init_file_logging_at(&service_log_dir, file_log_level);
    } else if is_tui_mode || is_exec_mode || is_daemon_run || is_dispatch_mode {
        logging::init_file_logging(file_log_level);
    } else {
        tracing_subscriber::fmt()
            .with_max_level(stderr_log_level)
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .with_target(false)
            .init();
    }

    let config = CliConfig::load().unwrap_or_else(|e| {
        if !is_tui_mode {
            eprintln!("Warning: Failed to load config: {}", e);
            eprintln!("Using default configuration");
        }
        CliConfig::default()
    });
    if is_tui_mode && config.behavior.auto_update {
        self_update::maybe_run_automatic().await;
    }

    match cli.command {
        Some(Commands::Chat {
            agent,
            harness_profile,
            ..
        }) => {
            // Interactive mode with startup page, scoped to the current directory.
            run_interactive(
                config,
                agent,
                ".".to_string(),
                use_shared_runtime,
                cli.agent.clone(),
                cli.model.clone(),
                resolved_command_harness_profile(&cli.harness_profile, harness_profile),
                None,
            )
            .await?;
        }

        Some(Commands::SharedRuntime {
            workspace,
            instance_identity,
        }) => shared_runtime::run_service(workspace, instance_identity).await?,

        Some(Commands::Exec {
            message,
            agent,
            harness_profile,
            continue_last,
            resume,
            session,
            session_id,
            fork_session,
            output_format,
            output_patch,
            verify_final_changes,
            no_verify_final_changes,
            auto,
            confirm,
        }) => {
            let approval_mode = if auto {
                ExecApprovalMode::Auto
            } else {
                if confirm {
                    eprintln!(
                        "Warning: --confirm is deprecated; non-interactive confirmations are rejected by default"
                    );
                }
                ExecApprovalMode::Reject
            };
            root_handlers::handle_exec_command(
                config,
                root_handlers::ExecCommandArgs {
                    message,
                    agent: agent_type_with_harness_profile(
                        agent,
                        resolved_command_harness_profile(&cli.harness_profile, harness_profile)
                            .as_deref(),
                    ),
                    continue_last,
                    resume,
                    session,
                    session_id,
                    fork_session,
                    output_format,
                    output_patch,
                    verify_final_changes: final_change_verification_enabled(
                        verify_final_changes,
                        no_verify_final_changes,
                    ),
                    approval_mode,
                },
            )
            .await?;
        }

        Some(Commands::Sessions { action }) => {
            if let Some((session_id, runtime)) =
                root_handlers::handle_session_action(action).await?
            {
                run_interactive_with_session(config, session_id, runtime).await?;
            }
        }

        Some(Commands::Agents) => {
            let workspace = std::env::current_dir()?;
            management::print_agents(Some(workspace.as_path())).await?;
        }

        Some(Commands::Models { action }) => match action {
            None | Some(ModelAction::List) => management::print_models().await?,
            Some(ModelAction::SetDefault { model_id }) => {
                management::set_default_model(&model_id).await?;
            }
        },

        Some(Commands::Mcp { action }) => match action {
            None | Some(McpAction::List) => management::print_mcp_servers().await?,
            Some(McpAction::Doctor) => management::print_mcp_config_summary().await?,
            Some(McpAction::Enable { server_id }) => {
                management::set_mcp_server_enabled(&server_id, true).await?;
            }
            Some(McpAction::Disable { server_id }) => {
                management::set_mcp_server_enabled(&server_id, false).await?;
            }
            Some(McpAction::Config) => {
                management::print_mcp_json_config().await?;
            }
            Some(McpAction::Import {
                apply,
                candidate,
                native_id,
                format,
            }) => {
                management::run_mcp_import(McpImportCommand {
                    apply,
                    candidates: candidate,
                    native_id,
                    format,
                })
                .await?;
            }
            Some(McpAction::Add {
                name,
                r#type,
                command,
                url,
                non_interactive,
            }) => {
                management::add_mcp_server(management::McpAddInput {
                    name,
                    r#type,
                    command,
                    url,
                    non_interactive,
                })
                .await?;
            }
        },

        Some(Commands::Plugins { action }) => match action {
            None | Some(PluginAction::List) => management::print_plugins().await?,
            Some(PluginAction::ApproveSource { package_id }) => {
                management::set_plugin_trust(
                    &package_id,
                    openbitfun_core::plugin_source::ManagedPluginTrustDecision::ApproveSource,
                )
                .await?;
            }
            Some(PluginAction::Deny { package_id }) => {
                management::set_plugin_trust(
                    &package_id,
                    openbitfun_core::plugin_source::ManagedPluginTrustDecision::Denied,
                )
                .await?;
            }
            Some(PluginAction::Revoke { package_id }) => {
                management::set_plugin_trust(
                    &package_id,
                    openbitfun_core::plugin_source::ManagedPluginTrustDecision::Revoked,
                )
                .await?;
            }
            Some(PluginAction::Activate {
                package_id,
                confirm,
            }) => {
                management::activate_plugin(&package_id, confirm.as_deref()).await?;
            }
            Some(PluginAction::Deactivate { package_id }) => {
                management::deactivate_plugin(&package_id).await?;
            }
        },

        Some(Commands::Hooks { action }) => {
            hook_import::run(action).await?;
        }

        Some(Commands::Usage { session_id }) => {
            management::print_usage_report(session_id.as_deref()).await?;
        }

        Some(Commands::Doctor) => {
            let workspace = std::env::current_dir()?;
            let (_, services) =
                openbitfun_core::product_runtime::build_local_runtime_services(&workspace, 16)?;
            let product_runtime = product_assembly::assemble_cli_runtime_parts(services)?;
            if !management::print_doctor(&product_runtime).await? {
                std::process::exit(1);
            }
        }

        Some(Commands::Config { action }) => {
            root_handlers::handle_config_action(action, &config).await?;
        }

        Some(Commands::Health) => {
            root_handlers::handle_health_command()?;
        }

        Some(Commands::Update { check }) => {
            self_update::run_manual(check).await?;
        }

        Some(Commands::Daemon { action }) => match action {
            DaemonAction::Run => daemon::run_daemon().await?,
            DaemonAction::Install => daemon::install_service()?,
            DaemonAction::Uninstall => daemon::uninstall_service()?,
            DaemonAction::Status => daemon::print_status()?,
            DaemonAction::DispatchIdentity => daemon::print_identity()?,
            DaemonAction::DispatchProvision { request_path } => daemon::provision(request_path)?,
            DaemonAction::DispatchDeprovision { device_id, user_id } => {
                daemon::deprovision(device_id, user_id)?
            }
        },

        Some(Commands::Dispatch { action }) => {
            root_handlers::handle_dispatch_action(action).await?;
        }

        Some(Commands::Server) => {
            server_host::serve().await?;
        }

        Some(Commands::Acp {
            action: None | Some(AcpAction::Serve),
        }) => {
            root_handlers::serve_acp_stdio().await?;
        }

        Some(Commands::Acp {
            action: Some(AcpAction::Status { command }),
        }) => {
            acp_cli::print_status(&command)?;
        }

        Some(Commands::Acp {
            action: Some(AcpAction::Doctor { command }),
        }) => {
            if !acp_cli::print_doctor(&command).await? {
                std::process::exit(1);
            }
        }

        Some(Commands::Acp {
            action: Some(AcpAction::Config { client, command }),
        }) => {
            acp_cli::print_config(client, &command)?;
        }

        Some(Commands::Acp {
            action: Some(AcpAction::Clients { action }),
        }) => match action {
            AcpClientsAction::List => acp_cli::list_external_clients().await?,
            AcpClientsAction::Doctor => {
                if !acp_cli::doctor_external_clients().await? {
                    std::process::exit(1);
                }
            }
            AcpClientsAction::Enable { client, permission } => {
                acp_cli::enable_external_client(client, permission).await?;
            }
            AcpClientsAction::Disable { client_id } => {
                acp_cli::disable_external_client(&client_id).await?;
            }
            AcpClientsAction::Config => acp_cli::print_external_client_config().await?,
        },

        Some(Commands::Acp {
            action:
                Some(AcpAction::Run {
                    client,
                    prompt,
                    workspace,
                    timeout,
                    permission,
                }),
        }) => {
            acp_cli::run_external_client(client, prompt, workspace, timeout, permission).await?;
        }

        None => {
            // Default: interactive TUI with startup page
            let workspace_str = ".".to_string();

            let default_agent = config.behavior.default_agent.clone();

            // Resolve --continue / --session into a session override spec.
            let session_override = if cli.continue_last {
                Some("last".to_string())
            } else {
                cli.session.clone()
            };

            run_interactive(
                config,
                default_agent,
                workspace_str,
                use_shared_runtime,
                cli.agent.clone(),
                cli.model.clone(),
                cli.harness_profile.clone(),
                session_override,
            )
            .await?;
        }
    }

    Ok(())
}

fn exec_requests_json_output(args: &[std::ffi::OsString]) -> bool {
    let values = args
        .iter()
        .skip(1)
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>();
    if !values.iter().any(|value| value == "exec") {
        return false;
    }

    values.iter().enumerate().any(|(index, value)| {
        value == "--output-format=json"
            || (value == "--output-format"
                && values.get(index + 1).is_some_and(|format| format == "json"))
    })
}

async fn run_interactive_with_session(
    config: CliConfig,
    session_id: String,
    runtime: std::sync::Arc<runtime::CliRuntimeContext>,
) -> Result<()> {
    let mut terminal = ui::init_terminal()?;
    ui::render_loading(&mut terminal, "Initializing system, please wait...")?;

    let workspace_path = runtime.workspace_root().to_path_buf();
    let workspace = Some(workspace_path.to_string_lossy().to_string());
    let agent = Arc::new(agent::runtime_client::CliAgentRuntimeClient::new(&runtime));
    let sessions = agent.list_sessions().await?;
    let agent_type = sessions
        .iter()
        .find(|session| session.session_id == session_id)
        .map(|session| session.agent_type.clone())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Session {session_id} was not found in the current workspace: {}",
                runtime.workspace_root().display()
            )
        })?;

    let mut chat_mode = ChatMode::new(
        config,
        agent_type,
        workspace,
        agent,
        Some(runtime.account_runtime().clone()),
    )
    .with_restore_session(session_id);
    let run_result = chat_mode.run(Some(terminal));

    shutdown_mcp_servers().await;
    println!("Goodbye!");

    run_result?;
    Ok(())
}

fn main() {
    // Install the workspace-owned ring CryptoProvider before any TLS-capable
    // work (relay WS, reqwest rustls paths, Feishu wss) so every client uses
    // the same explicit process-level provider.
    openbitfun_core::service::remote_connect::ensure_rustls_crypto_provider();

    let worker = std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                // Agent execution can exceed Tokio's default stack in debug builds.
                // Runtime threads do not inherit the outer thread's stack size.
                .thread_stack_size(16 * 1024 * 1024)
                .enable_all()
                .build()
                .expect("failed to build tokio runtime");
            runtime.block_on(async {
                let result = run_cli().await;
                match openbitfun_core::plugin_host::shutdown_configured_plugin_host().await {
                    Ok(Some(report)) => tracing::info!(
                        generation = report.generation,
                        disposition = ?report.disposition,
                        rpc_completed = report.rpc_completed,
                        exit_code = ?report.exit_code,
                        duration_ms = report.duration_ms,
                        "CLI plugin host shutdown completed"
                    ),
                    Ok(None) => {
                        tracing::debug!("CLI plugin host shutdown skipped: host not started")
                    }
                    Err(error) => tracing::warn!("CLI plugin host shutdown failed: {error}"),
                }
                result
            })
        })
        .expect("failed to spawn openbitfun worker thread");

    match worker.join() {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            if let Some(reported) = err.downcast_ref::<ReportedCliError>() {
                std::process::exit(reported.exit_code);
            }
            eprintln!("Error: {err}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("Error: openbitfun worker thread panicked");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod server_command_tests {
    use super::{Cli, Commands};
    use clap::Parser;

    #[test]
    fn server_command_parses_as_stdio_host() {
        let parsed = Cli::try_parse_from(["openbitfun", "server"]).expect("parse server command");
        assert!(matches!(parsed.command, Some(Commands::Server)));
    }
}

#[cfg(test)]
mod plugin_command_tests {
    use super::{Cli, Commands, PluginAction};
    use clap::Parser;

    #[test]
    fn plugin_commands_parse_list_and_source_review_actions() {
        let list = Cli::try_parse_from(["openbitfun", "plugins"]).expect("parse plugin list");
        assert!(matches!(
            list.command,
            Some(Commands::Plugins { action: None })
        ));

        let approval =
            Cli::try_parse_from(["openbitfun", "plugins", "approve-source", "acme.demo"])
                .expect("parse plugin source approval");
        assert!(matches!(
            approval.command,
            Some(Commands::Plugins {
                action: Some(PluginAction::ApproveSource { package_id })
            }) if package_id == "acme.demo"
        ));

        let deny = Cli::try_parse_from(["openbitfun", "plugins", "deny", "acme.demo"])
            .expect("parse plugin deny");
        assert!(matches!(
            deny.command,
            Some(Commands::Plugins {
                action: Some(PluginAction::Deny { package_id })
            }) if package_id == "acme.demo"
        ));

        let revoke = Cli::try_parse_from(["openbitfun", "plugins", "revoke", "acme.demo"])
            .expect("parse plugin revoke");
        assert!(matches!(
            revoke.command,
            Some(Commands::Plugins {
                action: Some(PluginAction::Revoke { package_id })
            }) if package_id == "acme.demo"
        ));

        let preview = Cli::try_parse_from(["openbitfun", "plugins", "activate", "acme.demo"])
            .expect("parse plugin activation preview");
        assert!(matches!(
            preview.command,
            Some(Commands::Plugins {
                action: Some(PluginAction::Activate {
                    package_id,
                    confirm: None,
                })
            }) if package_id == "acme.demo"
        ));

        let confirm = Cli::try_parse_from([
            "openbitfun",
            "plugins",
            "activate",
            "acme.demo",
            "--confirm",
            "sha256:previewed",
        ])
        .expect("parse confirmed plugin activation");
        assert!(matches!(
            confirm.command,
            Some(Commands::Plugins {
                action: Some(PluginAction::Activate {
                    package_id,
                    confirm: Some(content_hash),
                })
            }) if package_id == "acme.demo" && content_hash == "sha256:previewed"
        ));

        let deactivate = Cli::try_parse_from(["openbitfun", "plugins", "deactivate", "acme.demo"])
            .expect("parse plugin deactivation");
        assert!(matches!(
            deactivate.command,
            Some(Commands::Plugins {
                action: Some(PluginAction::Deactivate { package_id })
            }) if package_id == "acme.demo"
        ));
    }
}

#[cfg(test)]
mod external_config_command_tests {
    use super::{
        Cli, Commands, ConfigAction, ExternalAccessArg, ExternalCapabilityArg,
        ExternalConfigAction, ExternalPolicyModeArg, ExternalPolicyScopeArg,
    };
    use clap::Parser;

    #[test]
    fn external_config_commands_keep_scope_and_capability_explicit() {
        let status = Cli::try_parse_from(["openbitfun", "config", "external", "status"])
            .expect("parse external status");
        assert!(matches!(
            status.command,
            Some(Commands::Config {
                action: ConfigAction::External {
                    action: ExternalConfigAction::Status
                }
            })
        ));

        let enabled = Cli::try_parse_from([
            "openbitfun",
            "config",
            "external",
            "set-enabled",
            "true",
            "--scope",
            "global",
        ])
        .expect("parse external enabled value");
        assert!(matches!(
            enabled.command,
            Some(Commands::Config {
                action: ConfigAction::External {
                    action: ExternalConfigAction::SetEnabled {
                        enabled: true,
                        scope: ExternalPolicyScopeArg::Global,
                    }
                }
            })
        ));

        let mode = Cli::try_parse_from([
            "openbitfun",
            "config",
            "external",
            "set-mode",
            "discover-only",
            "--scope",
            "global",
        ])
        .expect("parse external mode");
        assert!(matches!(
            mode.command,
            Some(Commands::Config {
                action: ConfigAction::External {
                    action: ExternalConfigAction::SetMode {
                        mode: ExternalPolicyModeArg::DiscoverOnly,
                        ecosystem: None,
                        scope: ExternalPolicyScopeArg::Global,
                    }
                }
            })
        ));

        let capability = Cli::try_parse_from([
            "openbitfun",
            "config",
            "external",
            "set-capability",
            "mcp",
            "ask",
            "--ecosystem",
            "opencode",
        ])
        .expect("parse external capability");
        assert!(matches!(
            capability.command,
            Some(Commands::Config {
                action: ConfigAction::External {
                    action: ExternalConfigAction::SetCapability {
                        capability: ExternalCapabilityArg::Mcp,
                        access: ExternalAccessArg::Ask,
                        ecosystem: Some(ref ecosystem),
                        scope: ExternalPolicyScopeArg::Project,
                    }
                }
            }) if ecosystem == "opencode"
        ));

        let reset = Cli::try_parse_from(["openbitfun", "config", "external", "reset-incompatible"])
            .expect("parse incompatible policy reset");
        assert!(matches!(
            reset.command,
            Some(Commands::Config {
                action: ConfigAction::External {
                    action: ExternalConfigAction::ResetIncompatible
                }
            })
        ));
    }
}

#[cfg(test)]
mod bootstrap_profile_tests {
    use super::{exec_requests_json_output, BootstrapProfile, SessionAction};

    #[test]
    fn profiles_start_only_their_requested_background_services() {
        let cases = [
            (BootstrapProfile::Interactive, true, true, true),
            (BootstrapProfile::Execution, false, true, true),
            (BootstrapProfile::Management, false, false, false),
        ];

        for (profile, starts_peer_host, starts_mcp, starts_plugin_host) in cases {
            assert_eq!(
                profile.starts_peer_host(
                    openbitfun_services_core::runtime_ownership::RuntimeDeployment::Embedded,
                ),
                starts_peer_host
            );
            assert_eq!(profile.starts_mcp(), starts_mcp);
            assert_eq!(profile.starts_plugin_host(), starts_plugin_host);
        }
    }

    #[test]
    fn session_resume_and_continue_use_interactive_bootstrap() {
        let resume = SessionAction::Resume {
            id: "session-1".to_string(),
        };

        assert_eq!(resume.bootstrap_profile(), BootstrapProfile::Interactive);
        assert_eq!(
            SessionAction::Continue.bootstrap_profile(),
            BootstrapProfile::Interactive
        );
    }

    #[test]
    fn session_management_actions_use_management_bootstrap() {
        let actions = [
            SessionAction::List,
            SessionAction::Show {
                id: "session-1".to_string(),
            },
            SessionAction::Delete {
                id: "session-1".to_string(),
            },
            SessionAction::Fork {
                id: "session-1".to_string(),
                id_only: false,
            },
        ];

        for action in actions {
            assert_eq!(action.bootstrap_profile(), BootstrapProfile::Management);
        }
    }

    #[test]
    fn json_exec_parse_failures_are_detected_before_clap_exits() {
        let args = [
            "openbitfun",
            "exec",
            "task",
            "--output-format",
            "json",
            "--unknown-option",
        ]
        .map(std::ffi::OsString::from);

        assert!(exec_requests_json_output(&args));
    }
}

#[cfg(test)]
mod final_change_verification_cli_tests {
    use super::{final_change_verification_enabled, Cli, Commands};
    use clap::Parser;

    fn parse_flags(args: &[&str]) -> (bool, bool) {
        let cli = Cli::try_parse_from(args).expect("exec args");
        let Some(Commands::Exec {
            verify_final_changes,
            no_verify_final_changes,
            ..
        }) = cli.command
        else {
            panic!("expected exec command");
        };
        (verify_final_changes, no_verify_final_changes)
    }

    #[test]
    fn verification_is_enabled_by_default_and_can_be_disabled() {
        let (verify, disable) = parse_flags(&["openbitfun", "exec", "task"]);
        assert!(final_change_verification_enabled(verify, disable));

        let (verify, disable) =
            parse_flags(&["openbitfun", "exec", "--no-verify-final-changes", "task"]);
        assert!(!final_change_verification_enabled(verify, disable));
    }
}

#[cfg(test)]
mod hook_import_command_tests {
    use super::{Cli, Commands};
    use crate::hook_import::{HookAction, HookImportOutputFormat};
    use clap::Parser;

    #[test]
    fn hook_import_is_preview_only_without_a_fingerprint() {
        let cli = Cli::try_parse_from([
            "openbitfun",
            "hooks",
            "import",
            "--source",
            "6:codex6:global",
            "--format",
            "json",
        ])
        .expect("parse Hook import preview");
        assert!(matches!(
            cli.command,
            Some(Commands::Hooks {
                action: Some(HookAction::Import {
                    confirm: None,
                    format: HookImportOutputFormat::Json,
                    ..
                })
            })
        ));
    }

    #[test]
    fn hook_remove_requires_explicit_confirmation() {
        assert!(Cli::try_parse_from(["openbitfun", "hooks", "remove", "import-id"]).is_err());
        let cli = Cli::try_parse_from(["openbitfun", "hooks", "remove", "import-id", "--confirm"])
            .expect("parse confirmed Hook removal");
        assert!(matches!(
            cli.command,
            Some(Commands::Hooks {
                action: Some(HookAction::Remove { .. })
            })
        ));
    }

    #[test]
    fn corrupt_hook_store_reset_requires_an_explicit_scope_and_confirmation() {
        assert!(Cli::try_parse_from(["openbitfun", "hooks", "reset", "user"]).is_err());
        let cli = Cli::try_parse_from(["openbitfun", "hooks", "reset", "project", "--confirm"])
            .expect("parse confirmed project Hook store reset");
        assert!(matches!(
            cli.command,
            Some(Commands::Hooks {
                action: Some(HookAction::Reset {
                    scope: crate::hook_import::HookImportResetScope::Project,
                    ..
                })
            })
        ));
    }
}

#[cfg(test)]
mod sdk_host_command_tests {
    use super::Cli;
    use clap::{CommandFactory, Parser};

    #[test]
    fn sdk_host_is_not_a_cli_command() {
        let error = match Cli::try_parse_from(["openbitfun", "sdk-host"]) {
            Ok(_) => panic!("SDK Host must be a sibling application, not a CLI subcommand"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), clap::error::ErrorKind::InvalidSubcommand);
        let help = Cli::command().render_long_help().to_string();
        assert!(!help.contains("sdk-host"));
        assert!(!include_str!("../Cargo.toml").contains("openbitfun-sdk-host"));
    }
}

#[cfg(test)]
mod shared_tui_command_tests {
    use super::{shared_tui_requested, BootstrapProfile, Cli, Commands};
    use clap::{CommandFactory, Parser, Subcommand};
    use openbitfun_services_core::runtime_ownership::RuntimeDeployment;

    #[test]
    fn shared_is_an_opt_in_interactive_tui_flag() {
        let default_tui =
            Cli::try_parse_from(["openbitfun", "--shared"]).expect("parse default TUI");
        assert!(default_tui.shared);

        let chat = Cli::try_parse_from(["openbitfun", "chat", "--shared"])
            .expect("parse explicit chat TUI");
        assert!(matches!(
            chat.command,
            Some(Commands::Chat { shared: true, .. })
        ));
        let root_chat = Cli::try_parse_from(["openbitfun", "--shared", "chat"])
            .expect("parse root Shared choice before chat");
        assert!(shared_tui_requested(root_chat.shared, &root_chat.command).unwrap());
    }

    #[test]
    fn shared_rejects_non_interactive_surfaces_without_fallback() {
        assert!(Cli::try_parse_from(["openbitfun", "exec", "hello", "--shared"]).is_err());
        let exec = Cli::try_parse_from(["openbitfun", "--shared", "exec", "hello"])
            .expect("parse root deployment choice");
        let error = shared_tui_requested(exec.shared, &exec.command)
            .expect_err("headless exec must remain Embedded");
        assert!(error.to_string().contains("interactive TUI"));
    }

    #[test]
    fn shared_runtime_does_not_start_the_peer_host() {
        assert!(BootstrapProfile::Interactive.starts_peer_host(RuntimeDeployment::Embedded));
        assert!(!BootstrapProfile::Interactive.starts_peer_host(RuntimeDeployment::Shared));
    }

    #[test]
    fn help_explains_shared_scope_and_hides_internal_process_role() {
        let help = Cli::command().render_long_help().to_string();
        assert!(help.contains("one workspace Runtime"));
        assert!(help.contains("controls a Session at a time"));
        assert!(help.contains("Automation, desktop, and remote modes"));
        assert!(!help.contains("__shared-runtime"));
        let exec_help = Commands::augment_subcommands(Cli::command())
            .find_subcommand("exec")
            .expect("exec command")
            .clone()
            .render_long_help()
            .to_string();
        assert!(!exec_help.contains("--shared"));
    }
}

#[cfg(test)]
mod dispatch_command_tests {
    use super::{is_dispatch_command, Cli, Commands, DispatchAction};
    use clap::{CommandFactory, Parser};

    #[test]
    fn dispatch_commands_parse_and_internal_worker_is_hidden() {
        let status = Cli::try_parse_from(["openbitfun", "dispatch", "status"])
            .expect("parse dispatch status");
        assert!(matches!(
            status.command,
            Some(Commands::Dispatch {
                action: DispatchAction::Status
            })
        ));
        assert!(is_dispatch_command(&status.command));

        let worker = Cli::try_parse_from(["openbitfun", "dispatch", "__run", "--job", "job-1"])
            .expect("parse internal dispatch worker");
        assert!(matches!(
            worker.command,
            Some(Commands::Dispatch {
                action: DispatchAction::Run { ref job }
            }) if job == "job-1"
        ));
        assert!(is_dispatch_command(&worker.command));
        let provision = Cli::try_parse_from(["openbitfun", "dispatch", "__workspace_provision"])
            .expect("parse internal workspace provision");
        assert!(matches!(
            provision.command,
            Some(Commands::Dispatch {
                action: DispatchAction::WorkspaceProvision
            })
        ));
        assert!(is_dispatch_command(&provision.command));
        let unrelated =
            Cli::try_parse_from(["openbitfun", "config", "show"]).expect("parse config");
        assert!(!is_dispatch_command(&unrelated.command));

        let help = Cli::command().render_long_help().to_string();
        assert!(help.contains("dispatch"));
        let dispatch_help = Cli::command()
            .find_subcommand_mut("dispatch")
            .expect("dispatch command")
            .render_long_help()
            .to_string();
        assert!(!dispatch_help.contains("__run"));
    }
}

#[cfg(test)]
mod harness_profile_compatibility_tests {
    use super::{agent_type_with_harness_profile, resolved_command_harness_profile, Cli, Commands};
    use clap::{CommandFactory, Parser};

    #[test]
    fn canonical_cli_choices_are_the_only_displayed_identifiers() {
        let help = Cli::command().render_long_help().to_string();
        assert!(help.contains("Minimal, Standard, Ultimate, Creative"));
        assert!(!help.contains("balanced"));
        for id in openbitfun_core_types::agent_identity::HarnessId::ALL {
            let cli =
                Cli::try_parse_from(["openbitfun", "--harness-profile", id.as_str()]).unwrap();
            assert_eq!(
                agent_type_with_harness_profile("Cowork".into(), cli.harness_profile.as_deref()),
                id.as_str()
            );
        }
    }

    #[test]
    fn minimal_profile_is_an_agent_type_compatibility_alias() {
        assert_eq!(
            agent_type_with_harness_profile("Standard".to_string(), Some("minimal")),
            "Minimal"
        );
        assert_eq!(
            agent_type_with_harness_profile("Cowork".to_string(), Some("balanced")),
            "Cowork"
        );
    }

    #[test]
    fn legacy_global_and_subcommand_forms_keep_precedence() {
        let cli = Cli::try_parse_from([
            "openbitfun",
            "--harness-profile",
            "balanced",
            "exec",
            "--harness-profile",
            "minimal",
            "fix",
        ])
        .expect("legacy harness profile syntax should parse");
        let Some(Commands::Exec {
            harness_profile, ..
        }) = cli.command
        else {
            panic!("expected exec command");
        };
        assert_eq!(
            resolved_command_harness_profile(&cli.harness_profile, harness_profile).as_deref(),
            Some("minimal")
        );
    }
}

#[cfg(test)]
mod daemon_command_tests {
    use super::{Cli, Commands, DaemonAction};
    use clap::{CommandFactory, Parser};

    #[test]
    fn dispatch_daemon_bootstrap_commands_parse_and_stay_hidden() {
        let identity = Cli::try_parse_from(["openbitfun", "daemon", "__dispatch_identity"])
            .expect("parse target identity command");
        assert!(matches!(
            identity.command,
            Some(Commands::Daemon {
                action: DaemonAction::DispatchIdentity
            })
        ));

        let provision = Cli::try_parse_from([
            "openbitfun",
            "daemon",
            "__dispatch_provision",
            "/tmp/request.json",
        ])
        .expect("parse target provisioning command");
        assert!(matches!(
            provision.command,
            Some(Commands::Daemon {
                action: DaemonAction::DispatchProvision { ref request_path }
            }) if request_path == std::path::Path::new("/tmp/request.json")
        ));

        let rollback = Cli::try_parse_from([
            "openbitfun",
            "daemon",
            "__dispatch_deprovision",
            "device-1",
            "user-1",
        ])
        .expect("parse target rollback command");
        assert!(matches!(
            rollback.command,
            Some(Commands::Daemon {
                action: DaemonAction::DispatchDeprovision {
                    ref device_id,
                    ref user_id,
                }
            }) if device_id == "device-1" && user_id == "user-1"
        ));

        let daemon_help = Cli::command()
            .find_subcommand_mut("daemon")
            .expect("daemon command")
            .render_long_help()
            .to_string();
        assert!(!daemon_help.contains("__dispatch_"));
    }
}

/// Resolves the stable workspace record for a directory the CLI is operating in
/// (its cwd, `--workspace`, or a command operand). Session and protocol routing
/// must use the resulting record ID.
///
/// This registers a hidden record only. The CLI shares the workspace catalog
/// with the desktop, and running `openbitfun doctor` or a chat in some folder
/// must not make that folder an opened, recent, or current desktop workspace;
/// opening a folder for the desktop UI is an explicit user action there.
async fn create_cli_local_workspace(
    path: &std::path::Path,
) -> Result<openbitfun_core::service::workspace::WorkspaceInfo> {
    use openbitfun_core::service::workspace::{
        get_global_workspace_service, set_global_workspace_service, WorkspaceService,
    };
    let service = if let Some(service) = get_global_workspace_service() {
        service
    } else {
        let service = std::sync::Arc::new(
            WorkspaceService::new()
                .await
                .map_err(|error| anyhow!(error.to_string()))?,
        );
        set_global_workspace_service(service.clone());
        service
    };
    service
        .register_local_workspace_record(path.to_owned())
        .await
        .map_err(|error| anyhow!(error.to_string()))
}
