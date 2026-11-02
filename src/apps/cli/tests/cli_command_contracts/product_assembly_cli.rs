#[test]
fn doctor_reports_the_validated_cli_runtime_assembly() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("workspace");
    let user_root = temp.path().join("user-root");
    let home_root = temp.path().join("home-root");
    let config_root = temp.path().join("host-config");
    std::fs::create_dir_all(&workspace).expect("create workspace");

    let output =
        openbitfun_services_core::process_manager::create_command(env!("CARGO_BIN_EXE_openbitfun"))
            .arg("doctor")
            .current_dir(&workspace)
            .env_remove("OPENBITFUN_USER_ROOT")
            .env_remove("OPENBITFUN_HOME")
            .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
            .env("OPENBITFUN_E2E_USER_ROOT", &user_root)
            .env("OPENBITFUN_E2E_HOME", &home_root)
            .env("APPDATA", &config_root)
            .env("XDG_CONFIG_HOME", &config_root)
            .env("HOME", &home_root)
            .output()
            .expect("run openbitfun doctor");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(
        stdout.contains("[ok] Product runtime: cli assembly-ready"),
        "{stdout}"
    );
    assert!(
        stdout.contains("[ok] Runtime capability registrations: complete"),
        "{stdout}"
    );
    assert!(
        stdout.contains("[info] Execution owner: openbitfun-core compatibility"),
        "{stdout}"
    );
    assert!(
        stdout.contains("[info] Plugin runtime: disabled (not_built)"),
        "{stdout}"
    );
    assert!(
        stdout.contains(&format!("[ok] Config directory: {}", user_root.display())),
        "{stdout}"
    );
}

#[test]
fn health_reports_assembly_and_compatibility_boundaries() {
    let temp = tempfile::tempdir().expect("tempdir");
    let workspace = temp.path().join("workspace");
    let user_root = temp.path().join("user-root");
    let home_root = temp.path().join("home-root");
    let config_root = temp.path().join("host-config");
    std::fs::create_dir_all(&workspace).expect("create workspace");

    let output =
        openbitfun_services_core::process_manager::create_command(env!("CARGO_BIN_EXE_openbitfun"))
            .arg("health")
            .current_dir(&workspace)
            .env_remove("OPENBITFUN_USER_ROOT")
            .env_remove("OPENBITFUN_HOME")
            .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
            .env("OPENBITFUN_E2E_USER_ROOT", &user_root)
            .env("OPENBITFUN_E2E_HOME", &home_root)
            .env("APPDATA", &config_root)
            .env("XDG_CONFIG_HOME", &config_root)
            .env("HOME", &home_root)
            .output()
            .expect("run openbitfun health");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(
        stdout.contains("Product runtime: cli assembly-ready"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Runtime capability registrations: complete"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Execution owner: openbitfun-core compatibility"),
        "{stdout}"
    );
    assert!(
        stdout.contains("Plugin runtime: disabled (not_built)"),
        "{stdout}"
    );
}

#[test]
fn doctor_rejects_incomplete_e2e_storage_roots() {
    for (case_name, provide_user_root, provide_home_root) in
        [("missing-user", false, true), ("missing-home", true, false)]
    {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let user_root = temp.path().join("user-root");
        let home_root = temp.path().join("home-root");
        let config_root = temp.path().join("host-config");
        std::fs::create_dir_all(&workspace).expect("create workspace");

        let mut command = openbitfun_services_core::process_manager::create_command(env!(
            "CARGO_BIN_EXE_openbitfun"
        ));
        command
            .arg("doctor")
            .current_dir(&workspace)
            .env_remove("OPENBITFUN_USER_ROOT")
            .env_remove("OPENBITFUN_E2E_USER_ROOT")
            .env_remove("OPENBITFUN_HOME")
            .env_remove("OPENBITFUN_E2E_HOME")
            .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
            .env("APPDATA", &config_root)
            .env("XDG_CONFIG_HOME", &config_root)
            .env("HOME", &home_root);
        if provide_user_root {
            command.env("OPENBITFUN_E2E_USER_ROOT", &user_root);
        }
        if provide_home_root {
            command.env("OPENBITFUN_E2E_HOME", &home_root);
        }

        let output = command.output().expect("run openbitfun doctor");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{case_name}: {stderr}");
        assert!(
            stderr.contains("OPENBITFUN_E2E_STORAGE_GUARD requires isolated")
                && stderr.contains("OPENBITFUN_E2E_USER_ROOT")
                && stderr.contains("OPENBITFUN_E2E_HOME"),
            "{case_name}: {stderr}"
        );
        assert!(
            !user_root.join("config.toml").exists(),
            "{case_name}: config should not be written before guard validation"
        );
    }
}

#[test]
fn remaining_cli_local_persistence_stays_behind_explicit_owner_boundaries() {
    const ACCOUNT_ADAPTER: &str = include_str!("../../src/account.rs");
    const ACCOUNT_RUNTIME: &str = include_str!(
        "../../../../crates/assembly/core/src/service/remote_connect/account_runtime.rs"
    );
    const STARTUP_PAGE: &str = include_str!("../../src/ui/startup.rs");
    const PEER_BOOTSTRAP: &str = include_str!("../../src/peer_host/bootstrap.rs");
    const PEER_STATE: &str = include_str!("../../src/peer_host/state.rs");
    const PEER_SESSION_COMMANDS: &str = include_str!("../../src/peer_host/commands/session.rs");
    const PEER_SNAPSHOT_COMMANDS: &str = include_str!("../../src/peer_host/commands/snapshot.rs");
    const CORE_RUNTIME_SERVICES: &str =
        include_str!("../../../../crates/assembly/core/src/product_runtime/runtime_services.rs");

    for (path, source) in [
        ("account.rs", ACCOUNT_ADAPTER),
        ("ui/startup.rs", STARTUP_PAGE),
        ("peer_host/bootstrap.rs", PEER_BOOTSTRAP),
        ("peer_host/state.rs", PEER_STATE),
        ("peer_host/commands/session.rs", PEER_SESSION_COMMANDS),
        ("peer_host/commands/snapshot.rs", PEER_SNAPSHOT_COMMANDS),
    ] {
        assert!(
            !source.contains("PersistenceManager"),
            "{path} must not import or name Core's concrete persistence manager"
        );
    }

    assert!(
        ACCOUNT_RUNTIME.contains("pub struct AccountRuntime")
            && ACCOUNT_ADAPTER.contains("impl AccountRuntimeHost for CliAccountRoutingHost")
            && ACCOUNT_ADAPTER.contains("AccountRuntime::new(routing.clone())")
            && !ACCOUNT_ADAPTER.contains("AccountSessionBackupPort"),
        "account state must live in the shared owner while CLI keeps narrow Host adapters"
    );
    assert!(
        STARTUP_PAGE.contains("self.account_runtime")
            && STARTUP_PAGE.contains("account.advance_github_login(transaction_id).await")
            && STARTUP_PAGE.contains("account.logout().await")
            && !STARTUP_PAGE.contains("finalize_login_after_sync_choice")
            && !STARTUP_PAGE.contains("start_auto_sync_background")
            && STARTUP_PAGE.contains("account_snapshot_projection"),
        "startup identity operations must call AccountRuntime directly without cloud-sync policy"
    );
    assert!(
        !CORE_RUNTIME_SERVICES.contains("pub fn persistence_manager"),
        "runtime services provider must not expose a concrete persistence factory"
    );
    assert!(
        !PEER_BOOTSTRAP.contains("DialogScheduler::new")
            && !PEER_BOOTSTRAP.contains("get_global_scheduler"),
        "Peer Host must consume the invocation-scoped scheduler instead of assembling one"
    );
    assert!(
        !PEER_STATE.contains("pub(crate) persistence")
            && !PEER_SESSION_COMMANDS.contains("state.persistence")
            && !PEER_SNAPSHOT_COMMANDS.contains("state.persistence")
            && !PEER_SESSION_COMMANDS.contains("get_snapshot_manager_for_workspace")
            && !PEER_SNAPSHOT_COMMANDS.contains("get_snapshot_manager_for_workspace")
            && !PEER_SESSION_COMMANDS.contains("ensure_snapshot_manager_for_workspace")
            && !PEER_SNAPSHOT_COMMANDS.contains("ensure_snapshot_manager_for_workspace"),
        "Peer Host persistence operations must stay behind an explicit Core owner boundary"
    );
    assert!(
        PEER_BOOTSTRAP.contains("local_workspace_snapshot:")
            && PEER_STATE.contains("LocalWorkspaceSnapshotPort")
            && PEER_SESSION_COMMANDS.contains("local_workspace_snapshot")
            && PEER_SNAPSHOT_COMMANDS.contains("local_workspace_snapshot"),
        "Peer Host local snapshot operations must consume the injected owner port"
    );
}

#[test]
fn embedded_account_management_uses_the_account_owner_directly() {
    const CLI_MAIN: &str = include_str!("../../src/main.rs");
    const STARTUP_PAGE: &str = include_str!("../../src/ui/startup.rs");
    const APP_SERVER_MANAGEMENT: &str =
        include_str!("../../../../crates/interfaces/app-server/src/management.rs");

    assert!(
        !CLI_MAIN.contains("surface_services")
            && CLI_MAIN.contains("runtime.account_runtime().clone()")
            && STARTUP_PAGE.contains("Option<Arc<AccountRuntime>>")
            && STARTUP_PAGE.contains("account.advance_github_login(transaction_id).await")
            && STARTUP_PAGE.contains("account.snapshot().await")
            && APP_SERVER_MANAGEMENT.contains("pub use owner::AppManagementService")
            && !CLI_MAIN.contains("mod tui_host")
            && !CLI_MAIN.contains("mod embedded_tui_backend"),
        "Embedded TUI must use AccountRuntime directly without surface service or App Server wiring"
    );
}

#[test]
fn peer_session_control_and_usage_persistence_use_runtime_sdk() {
    const PEER_SESSION_COMMANDS: &str = include_str!("../../src/peer_host/commands/session.rs");
    const CHAT_SELECTION: &str = include_str!("../../src/modes/chat/selection.rs");
    const CORE_PRODUCT_RUNTIME: &str =
        include_str!("../../../../crates/assembly/core/src/product_runtime.rs");

    for sdk_operation in [
        "create_session_with_id",
        "restore_session",
        "rename_session",
        "archive_session",
        "get_thread_goal",
    ] {
        assert!(
            PEER_SESSION_COMMANDS.contains(sdk_operation),
            "Peer Host session control must route {sdk_operation} through the Runtime SDK"
        );
    }
    // Inverted, along with the behaviour it described. `/usage` renders into
    // the conversation view and writes nothing: a report about a session is not
    // an event in it, and the Turn this used to persist was loaded back by the
    // desktop and given a numbered slot in its Turn rail. `add_assistant_message`
    // is the UI-only path — `turn_id: None`, never persisted — and in a terminal
    // the scrollback is the record.
    //
    // Source text only. This says the call is absent, not that nothing persists;
    // a behavioural guarantee would have to come from the runtime port's own
    // tests.
    assert!(
        !CHAT_SELECTION.contains("record_completed_local_command_turn"),
        "/usage must not write a local_command Turn: it renders into the          conversation view and persists nothing"
    );

    for removed_compatibility_method in [
        "pub async fn create_session_with_workspace",
        "pub async fn restore_session_for_workspace",
        "pub async fn update_session_title_for_storage_path",
        "pub async fn archive_persisted_session",
        "pub async fn get_thread_goal",
        "pub async fn append_completed_local_command_turn",
        "pub async fn get_session_snapshot_files",
        "pub async fn get_session_snapshot_stats",
        "pub async fn rollback_workspace_files_to_turn",
    ] {
        assert!(
            !CORE_PRODUCT_RUNTIME.contains(removed_compatibility_method),
            "migrated session control must not remain on CoreAgentRuntimeCompatibility: {removed_compatibility_method}"
        );
    }
}

#[test]
fn local_workspace_snapshot_port_does_not_expand_the_agent_runtime_sdk() {
    const RUNTIME_SDK: &str = include_str!("../../../../crates/execution/agent-runtime/src/sdk.rs");
    const LOCAL_SNAPSHOT_PORT: &str =
        include_str!("../../../../crates/contracts/runtime-ports/src/local_workspace_snapshot.rs");

    assert!(!RUNTIME_SDK.contains("LocalWorkspaceSnapshot"));
    assert!(!LOCAL_SNAPSHOT_PORT.contains("remote_connection_id"));
    assert!(!LOCAL_SNAPSHOT_PORT.contains("remote_ssh_host"));
    assert!(!LOCAL_SNAPSHOT_PORT.contains("checkpoint_workspace"));
    assert!(!LOCAL_SNAPSHOT_PORT.contains("rewind_workspace"));
}

#[test]
fn interactive_tui_separates_runtime_deployment_from_domain_services() {
    const AGENT_MODULE: &str = include_str!("../../src/agent/mod.rs");
    const CLI_MANIFEST: &str = include_str!("../../Cargo.toml");
    const CHAT_MODE: &str = include_str!("../../src/modes/chat.rs");
    const RUNTIME_CLIENT: &str = include_str!("../../src/agent/runtime_client.rs");

    assert!(
        !AGENT_MODULE.contains("trait Agent"),
        "a one-implementation private trait must not obscure the Runtime boundary"
    );
    assert!(
        CHAT_MODE.contains("agent: Arc<CliAgentRuntimeClient>")
            && CHAT_MODE.contains("account_runtime: Option<Arc<AccountRuntime>>")
            && !CHAT_MODE.contains("Arc<dyn")
            && !CHAT_MODE.contains("TuiAgentClient")
            && !CHAT_MODE.contains("surface_services"),
        "interactive controllers must depend on the Runtime client and call existing owners directly"
    );
    assert!(
        RUNTIME_CLIENT.contains("pub(crate) struct CliAgentRuntimeClient")
            && RUNTIME_CLIENT.contains("enum CliAgentRuntimeBackend")
            && RUNTIME_CLIENT.contains("Embedded(AgentRuntime)")
            && RUNTIME_CLIENT.contains("Shared(RuntimeIpcClient)")
            && RUNTIME_CLIENT.contains("fn is_remote_workspace"),
        "CliAgentRuntimeClient must own Embedded/Shared deployment and expose Remote workspace scope"
    );
    assert!(
        CLI_MANIFEST.contains("openbitfun-app-server =")
            && !CLI_MANIFEST.contains("openbitfun-app-server-client =")
            && !CLI_MANIFEST.contains("openbitfun-app-server-protocol")
            && !CLI_MANIFEST.contains("openbitfun-tui-management =")
            && !CHAT_MODE.contains("trait ModelService")
            && !CHAT_MODE.contains("trait ExternalSourceService"),
        "CLI may host the App Server stdio surface but must not depend on the typed App Server client transport, wire DTOs, or a shared TUI management crate"
    );
    for runtime_operation in [
        "pub(crate) async fn list_sessions(",
        "pub(crate) async fn respond_permission(",
        "pub(crate) async fn fork_current_session(",
        "pub(crate) async fn generate_session_usage_report(",
        "pub(crate) async fn wait_for_turn_settlement(",
    ] {
        assert!(
            RUNTIME_CLIENT.contains(runtime_operation),
            "interactive Runtime operation must remain on CliAgentRuntimeClient: {runtime_operation}"
        );
    }
    assert!(
        RUNTIME_CLIENT.contains("CliAgentRuntimeBackend::Embedded(runtime)")
            && RUNTIME_CLIENT.contains("CliAgentRuntimeBackend::Shared(client)"),
        "Runtime operations must retain explicit Embedded and Shared deployment mappings"
    );
}

#[test]
fn chat_context_reload_uses_the_same_runtime_client_as_session_operations() {
    const CHAT_MODE: &str = include_str!("../../src/modes/chat.rs");
    const CHAT_CAPABILITIES: &str = include_str!("../../src/modes/chat/capabilities.rs");
    const RUNTIME_CLIENT: &str = include_str!("../../src/agent/runtime_client.rs");

    assert!(
        !CHAT_MODE.contains("context_reload")
            && CHAT_CAPABILITIES.contains("self.agent.reload_context(request)"),
        "ChatMode must submit context reload through CliAgentRuntimeClient"
    );
    assert!(
        !CHAT_CAPABILITIES.contains("is_shared()")
            && !CHAT_CAPABILITIES.contains("reload_shared_session_context")
            && !CHAT_CAPABILITIES.contains("self.compatibility"),
        "TUI capability code must not branch context reload by Runtime deployment"
    );
    assert!(
        RUNTIME_CLIENT.contains("pub(crate) async fn reload_context"),
        "CliAgentRuntimeClient must own context reload"
    );
}

#[test]
fn runtime_client_covers_interactive_permission_operations() {
    const RUNTIME_CLIENT: &str = include_str!("../../src/agent/runtime_client.rs");

    for sdk_operation in [
        "subscribe_permission_requests",
        "pending_permission_requests",
        "respond_permission",
    ] {
        assert!(
            RUNTIME_CLIENT.contains(sdk_operation),
            "interactive TUI operation {sdk_operation} must stay on CliAgentRuntimeClient"
        );
    }
}

#[test]
fn interactive_tui_operations_use_runtime_and_domain_services() {
    const STARTUP_PAGE: &str = include_str!("../../src/ui/startup.rs");
    const CHAT_MODE: &str = include_str!("../../src/modes/chat.rs");
    const CHAT_RUN: &str = include_str!("../../src/modes/chat/run.rs");
    const CHAT_COMMANDS: &str = include_str!("../../src/modes/chat/commands.rs");
    const CHAT_INPUT: &str = include_str!("../../src/modes/chat/input.rs");
    const CHAT_SELECTION: &str = include_str!("../../src/modes/chat/selection.rs");
    const CHAT_EXTERNAL_SOURCES: &str = include_str!("../../src/modes/chat/external_sources.rs");
    const RUNTIME_CLIENT: &str = include_str!("../../src/agent/runtime_client.rs");
    const SHARED_RUNTIME: &str = include_str!("../../src/shared_runtime.rs");
    const CLI_MAIN: &str = include_str!("../../src/main.rs");
    const CLI_CARGO: &str = include_str!("../../Cargo.toml");

    assert!(
        !STARTUP_PAGE.contains("openbitfun_agent_runtime::sdk::AgentRuntime"),
        "the startup controller must use the existing CLI runtime client instead of AgentRuntime"
    );
    assert!(
        !CHAT_MODE.contains("Arc<CliRuntimeContext>"),
        "ChatMode must not retain the whole Embedded runtime context"
    );
    for (path, source) in [
        ("modes/chat/run.rs", CHAT_RUN),
        ("modes/chat/input.rs", CHAT_INPUT),
        ("modes/chat/selection.rs", CHAT_SELECTION),
    ] {
        assert!(
            !source.contains(".agent_runtime()"),
            "{path} must route Agent operations through CliAgentRuntimeClient"
        );
    }
    assert!(
        CHAT_MODE.contains("Arc<CliAgentRuntimeClient>")
            && STARTUP_PAGE.contains("Arc<CliAgentRuntimeClient>")
            && !CHAT_MODE.contains("Arc<dyn")
            && !STARTUP_PAGE.contains("Arc<dyn"),
        "interactive chat and startup must use Runtime plus existing owners without service wrappers"
    );
    assert!(
        !CLI_CARGO.contains("openbitfun-sdk-host")
            && CLI_CARGO.contains("openbitfun-agent-runtime-ipc"),
        "Shared TUI must use the private Runtime IPC adapter without making CLI depend on SDK Host"
    );
    assert!(
        RUNTIME_CLIENT.contains("RuntimeIpcClient")
            && RUNTIME_CLIENT.contains("CliAgentRuntimeBackend::Shared(client)")
            && !STARTUP_PAGE.contains("RuntimeIpcClient")
            && !CHAT_MODE.contains("RuntimeIpcClient"),
        "Shared IPC must remain in the common CLI Runtime client instead of leaking into TUI controllers"
    );
    assert!(
        RUNTIME_CLIENT.contains("RuntimeIpcOperation::UpdateSessionMode { request }")
            && SHARED_RUNTIME.contains("RuntimeIpcOperation::UpdateSessionMode { request }")
            && SHARED_RUNTIME.contains(".update_session_mode(request)"),
        "Shared Agent mode updates must reuse CliAgentRuntimeClient through private Runtime IPC"
    );
    assert!(
        RUNTIME_CLIENT.contains("RuntimeIpcOperation::UpdateSessionModel { request }")
            && SHARED_RUNTIME.contains("RuntimeIpcOperation::UpdateSessionModel { request }")
            && SHARED_RUNTIME.contains(".update_session_model(request)"),
        "Shared model updates must reuse CliAgentRuntimeClient through private Runtime IPC"
    );
    assert!(
        CHAT_EXTERNAL_SOURCES.contains("apply_external_source_control_action")
            && CHAT_EXTERNAL_SOURCES.contains("set_external_tool_target_decision")
            && CHAT_RUN.contains("subscribe_external_source_updates")
            && CHAT_COMMANDS.contains("openbitfun_core::external_sources")
            && !CHAT_COMMANDS.contains("external_source_service"),
        "TUI external-source controllers must call the existing owner API directly"
    );
    assert!(
        CHAT_COMMANDS.matches("if self.agent.is_shared()").count() >= 3
            && !CLI_MAIN.contains("surface_services")
            && CLI_MAIN.contains("CliAgentRuntimeClient::new(")
            && CLI_MAIN.contains("CliAgentRuntimeClient::new_shared(")
            && !CLI_MAIN.contains("mod tui_backend")
            && !CLI_MAIN.contains("mod shared_tui_backend")
            && !CLI_MAIN.contains("mod embedded_tui_backend")
            && !CLI_MAIN.contains("mod tui_runtime")
            && SHARED_RUNTIME.contains("RuntimeDeployment::Shared")
            && SHARED_RUNTIME.contains("process_manager::contain_current_process_tree"),
        "Embedded and Shared TUI must share CliAgentRuntimeClient while preserving the Shared v17 owner"
    );
    assert!(
        CLI_MAIN.contains("Cli::command()") && CLI_MAIN.contains("McpAction::Import"),
        "interactive composition changes must preserve product-aware CLI identity and MCP import"
    );
}

#[test]
fn interactive_tui_hook_management_calls_existing_owners_directly() {
    const CHAT_HOOKS: &str = include_str!("../../src/modes/chat/external_hooks.rs");
    const CHAT_NATIVE_HOOKS: &str = include_str!("../../src/modes/chat/native_hooks.rs");

    for operation in [
        "external_hook_import_snapshot",
        "plan_external_hook_import",
        "apply_external_hook_import",
        "mutate_external_hook_import",
        "native_hooks::overview",
    ] {
        assert!(
            CHAT_HOOKS.contains(operation),
            "TUI Hook operation {operation} must call its existing owner"
        );
    }
    assert!(
        CHAT_HOOKS.contains("expected_revision")
            && CHAT_NATIVE_HOOKS.contains("project_native_hook_overview")
            && CHAT_HOOKS.contains("is_remote_workspace"),
        "Hook mutations must preserve stale-revision fencing and remote fail-closed routing"
    );
    assert!(
        !CHAT_HOOKS.contains("post_call_hooks") && !CHAT_NATIVE_HOOKS.contains("post_call_hooks"),
        "compiled-in post-call Hooks must not enter the TUI management API"
    );
}

#[test]
fn interactive_tui_worktrees_call_existing_owners_directly() {
    const WORKTREE_CONTROLLER: &str = include_str!("../../src/modes/chat/worktree.rs");
    const CLI_MAIN: &str = include_str!("../../src/main.rs");

    for direct_owner in [
        "GitService",
        "WorktreeService",
        "WorktreeSessionBindingRequest",
    ] {
        assert!(
            WORKTREE_CONTROLLER.contains(direct_owner),
            "Worktree controller must call {direct_owner} directly"
        );
    }
    assert!(
        WORKTREE_CONTROLLER.contains("WorktreeService::bind_session")
            && WORKTREE_CONTROLLER.contains("GitService::resolve_worktree_repository")
            && !CLI_MAIN.contains("mod tui_host"),
        "the Embedded Host must call the Worktree and Git owners directly"
    );
    assert!(
        WORKTREE_CONTROLLER.contains("is_remote_workspace")
            && WORKTREE_CONTROLLER.contains("does not fall back to controller-local services")
            && !CLI_MAIN.contains("surface_services"),
        "Worktree management must depend on Remote workspace scope instead of Runtime deployment"
    );
}

#[test]
fn tui_controllers_do_not_recreate_surface_service_wrappers() {
    const CLI_MAIN: &str = include_str!("../../src/main.rs");
    const CHAT_MODE: &str = include_str!("../../src/modes/chat.rs");
    const STARTUP: &str = include_str!("../../src/ui/startup.rs");

    for (path, source) in [
        ("main.rs", CLI_MAIN),
        ("modes/chat.rs", CHAT_MODE),
        ("ui/startup.rs", STARTUP),
    ] {
        assert!(
            !source.contains("surface_services"),
            "{path} must not restore surface_services"
        );
        assert!(
            !source.contains("Arc<dyn ModelService>"),
            "{path} must not wrap model owners"
        );
        assert!(
            !source.contains("Arc<dyn AccountService>"),
            "{path} must not wrap account owners"
        );
        assert!(
            !source.contains("Arc<dyn ExternalSourceService>"),
            "{path} must not wrap external-source owners"
        );
    }
}

#[test]
fn runtime_ownership_policy_is_assembled_once_in_core() {
    const SHARED_RUNTIME: &str = include_str!("../../src/shared_runtime.rs");
    const CLI_RUNTIME: &str = include_str!("../../src/runtime/mod.rs");
    const CLI_MAIN: &str = include_str!("../../src/main.rs");
    const AGENTIC_SYSTEM: &str = include_str!("../../src/agent/agentic_system.rs");

    for private_policy in [
        "RuntimeOwnershipKey::for_workspace",
        "WorkspaceRuntimeOwnership::try_acquire",
        "fn ownership_root",
        "fn product_identity",
        "pub(crate) fn acquire_ownership",
    ] {
        assert!(
            !SHARED_RUNTIME.contains(private_policy),
            "CLI must not duplicate Core ownership policy: {private_policy}"
        );
    }
    assert!(
        !CLI_RUNTIME.contains("WorkspaceRuntimeOwnership")
            && !CLI_RUNTIME.contains("_runtime_ownership"),
        "Coordinator must retain the Core owner; CliRuntimeContext must not keep a second guard"
    );
    let assembly_call: String = AGENTIC_SYSTEM
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    assert!(
        CLI_MAIN.contains("CoreRuntimeOwnership")
            && assembly_call.contains(
                "init_agentic_system_with_computer_use_host(profile,runtime_ownership,computer_use_host,)"
            ),
        "CLI must select a deployment and inject the single Core owner"
    );
}
