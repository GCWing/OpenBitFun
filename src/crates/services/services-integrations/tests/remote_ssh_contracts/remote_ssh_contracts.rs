use openbitfun_services_integrations::remote_ssh::{
    canonicalize_local_workspace_root, local_workspace_roots_equal,
    local_workspace_stable_storage_id, normalize_local_workspace_root_for_stable_id,
    normalize_remote_workspace_path, remote_root_to_mirror_subpath, remote_workspace_runtime_root,
    remote_workspace_session_mirror_dir, remote_workspace_stable_id,
    sanitize_remote_mirror_path_component, sanitize_ssh_connection_id_for_local_dir,
    sanitize_ssh_hostname_for_mirror, unresolved_remote_session_storage_dir,
    unresolved_remote_session_storage_key, workspace_logical_key, workspace_session_identity,
    ContainerAccess, ContainerWorkspaceConfig, PortForward, PortForwardDirection,
    PortForwardRequest, RemoteListeningPort, RemoteWorkspace, RemoteWorkspaceRegistry,
    SSHAuthMethod, SSHConnectionConfig, SavedAuthType, SavedConnection, LOCAL_WORKSPACE_SSH_HOST,
};

#[test]
fn remote_ssh_legacy_agent_auth_keeps_default_private_key_fallback() {
    let config: SSHConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn-1",
        "name": "dev",
        "host": "example.com",
        "port": 22,
        "username": "alice",
        "auth": { "type": "Agent" },
        "defaultWorkspace": "/repo"
    }))
    .unwrap();

    match config.auth {
        SSHAuthMethod::Agent {
            key_fingerprint,
            fallback_key_path,
        } => {
            assert_eq!(key_fingerprint, None);
            assert_eq!(fallback_key_path.as_deref(), Some("~/.ssh/id_rsa"));
        }
        _ => panic!("legacy agent auth must remain agent-compatible"),
    }
    assert_eq!(config.proxy_jump, None);
    assert_eq!(config.container, None);
    assert_eq!(config.wsl, None);
    assert_eq!(config.options.connect_timeout_secs, 30);
    assert_eq!(config.options.auth_timeout_secs, 60);
    assert_eq!(config.options.auth_attempts, 3);
    assert_eq!(config.options.connect_attempts, 1);

    let saved: SavedConnection = serde_json::from_value(serde_json::json!({
        "id": "conn-1",
        "name": "dev",
        "host": "example.com",
        "port": 22,
        "username": "alice",
        "authType": { "type": "Agent" },
        "defaultWorkspace": "/repo",
        "lastConnected": 1
    }))
    .unwrap();

    assert!(matches!(
        saved.auth_type,
        SavedAuthType::Agent {
            key_fingerprint: None,
            ref fallback_key_path,
        } if fallback_key_path.as_deref() == Some("~/.ssh/id_rsa")
    ));
    assert_eq!(saved.proxy_jump, None);
    assert_eq!(saved.container, None);
    assert_eq!(saved.wsl, None);
    assert_eq!(saved.options.connect_timeout_secs, 30);
    assert_eq!(saved.options.auth_timeout_secs, 60);
    assert_eq!(saved.options.auth_attempts, 3);
    assert_eq!(saved.options.connect_attempts, 1);
}

#[test]
fn remote_target_contract_uses_proxy_jump_and_kebab_case_container_access() {
    let config = SSHConnectionConfig {
        id: "conn-1".to_string(),
        name: "train".to_string(),
        host: "train.internal".to_string(),
        port: 22,
        username: "trainer".to_string(),
        auth: SSHAuthMethod::PrivateKey {
            key_path: "~/.ssh/train".to_string(),
            passphrase: None,
            certificate_path: None,
        },
        default_workspace: Some("/workspace".to_string()),
        proxy_jump: Some("jump1,jump2".to_string()),
        proxy_command: None,
        container: Some(ContainerWorkspaceConfig {
            name: "trainer-dev".to_string(),
            access: ContainerAccess::DockerExec,
            local: false,
            docker_path: "docker".to_string(),
            shell: "/bin/bash".to_string(),
            user: Some("trainer".to_string()),
            interactive: true,
        }),
        wsl: None,
        options: Default::default(),
    };

    let json = serde_json::to_value(&config).unwrap();
    assert_eq!(json["proxyJump"], "jump1,jump2");
    assert_eq!(json["container"]["access"], "docker-exec");
    assert_eq!(json["container"]["dockerPath"], "docker");
    let round_trip: SSHConnectionConfig = serde_json::from_value(json).unwrap();
    assert_eq!(
        round_trip.container.unwrap().access,
        ContainerAccess::DockerExec
    );
}

#[test]
fn remote_target_contract_carries_proxy_command_and_stays_back_compatible() {
    // A payload that names a ProxyCommand must round-trip through the camelCase
    // wire shape and mark the config as drift-changed when the command changes.
    let config: SSHConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn-1",
        "name": "coder",
        "host": "coder-vscode.coder.sage.org.ai--abc",
        "port": 22,
        "username": "alice",
        "auth": { "type": "PrivateKey", "keyPath": "~/.ssh/coder_deploy" },
        "defaultWorkspace": "/home/coder",
        "proxyCommand": "\"coder\" --url https://coder.example:9443 ssh --stdio %h"
    }))
    .unwrap();
    assert_eq!(
        config.proxy_command.as_deref(),
        Some("\"coder\" --url https://coder.example:9443 ssh --stdio %h")
    );

    let json = serde_json::to_value(&config).unwrap();
    assert_eq!(
        json["proxyCommand"],
        "\"coder\" --url https://coder.example:9443 ssh --stdio %h"
    );
    let round_trip: SSHConnectionConfig = serde_json::from_value(json).unwrap();
    assert_eq!(
        round_trip.proxy_command.as_deref(),
        config.proxy_command.as_deref()
    );
    assert!(config.connection_params_equal(&round_trip));

    // Older clients and persisted files predate the field: it must deserialize
    // as absent, and two such configs must still compare equal.
    let legacy: SSHConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn-1",
        "name": "coder",
        "host": "coder-vscode.coder.sage.org.ai--abc",
        "port": 22,
        "username": "alice",
        "auth": { "type": "PrivateKey", "keyPath": "~/.ssh/coder_deploy" },
        "defaultWorkspace": "/home/coder"
    }))
    .unwrap();
    assert_eq!(legacy.proxy_command, None);
    assert!(!config.connection_params_equal(&legacy));
}

#[test]
#[cfg(feature = "remote-persistence")]
fn saved_connection_record_tolerates_legacy_payloads_without_proxy_command() {
    let saved: openbitfun_services_integrations::remote_persistence::SavedConnectionRecord =
        serde_json::from_value(serde_json::json!({
            "id": "conn-1",
            "name": "coder",
            "host": "coder-vscode.coder.sage.org.ai--abc",
            "port": 22,
            "username": "alice",
            "authType": { "type": "PrivateKey", "keyPath": "~/.ssh/coder_deploy" },
            "defaultWorkspace": "/home/coder",
            "lastConnected": 1
        }))
        .unwrap();
    assert_eq!(saved.proxy_command, None);
    assert_eq!(saved.proxy_jump, None);

    let written = serde_json::to_value(&saved).unwrap();
    assert!(written.get("proxyCommand").is_none());
}

#[test]
fn remote_workspace_defaults_keep_older_files_loadable() {
    let workspace: RemoteWorkspace = serde_json::from_value(serde_json::json!({
        "connectionId": "conn-1"
    }))
    .unwrap();

    assert_eq!(workspace.connection_id, "conn-1");
    assert_eq!(workspace.remote_path, "");
    assert_eq!(workspace.connection_name, "");
    assert_eq!(workspace.ssh_host, "");
}

#[test]
fn remote_workspace_path_helpers_preserve_current_identity_contract() {
    assert_eq!(
        normalize_remote_workspace_path(r"\\home\\user\\repo//src"),
        "/home/user/repo/src"
    );
    assert_eq!(normalize_remote_workspace_path("///"), "/");
    assert_eq!(
        normalize_remote_workspace_path("/home/user/repo/"),
        "/home/user/repo"
    );

    #[cfg(windows)]
    assert_eq!(
        sanitize_ssh_connection_id_for_local_dir("ssh-root@1.95.50.146:22"),
        "ssh-root@1.95.50.146-22"
    );
    #[cfg(not(windows))]
    assert_eq!(
        sanitize_ssh_connection_id_for_local_dir("ssh-root@1.95.50.146:22"),
        "ssh-root@1.95.50.146:22"
    );
    assert_eq!(
        sanitize_ssh_connection_id_for_local_dir("../unsafe/id"),
        "..-unsafe-id"
    );
    assert_eq!(sanitize_ssh_connection_id_for_local_dir(".."), "_dotdot_");

    assert_eq!(sanitize_remote_mirror_path_component(""), "_");
    assert_eq!(sanitize_remote_mirror_path_component("."), "_dot_");
    assert_eq!(sanitize_remote_mirror_path_component(".."), "_dotdot_");
    assert!(remote_root_to_mirror_subpath("/../../escape")
        .components()
        .all(|component| !matches!(component, std::path::Component::ParentDir)));
    assert_eq!(
        remote_root_to_mirror_subpath("/home/user/../project"),
        std::path::PathBuf::from("home").join("project"),
        "safe legacy dot segments must keep their previous effective mirror path"
    );
    #[cfg(windows)]
    {
        assert_eq!(sanitize_remote_mirror_path_component("CON"), "_CON");
        assert_eq!(sanitize_remote_mirror_path_component("report. "), "report");
    }
    assert_eq!(
        sanitize_ssh_hostname_for_mirror(" Example.COM "),
        "example.com"
    );
    assert_eq!(
        remote_root_to_mirror_subpath("/home/user/repo"),
        std::path::PathBuf::from("home").join("user").join("repo")
    );
    assert_eq!(
        remote_root_to_mirror_subpath("/"),
        std::path::PathBuf::from("_root")
    );

    assert_eq!(
        workspace_logical_key(LOCAL_WORKSPACE_SSH_HOST, "/Users/p/w"),
        "localhost:/Users/p/w"
    );

    let local_id = local_workspace_stable_storage_id("/Users/foo/OpenBitFun");
    assert_eq!(local_id, "local_20fa48956633477b7a38a742510b63ea");

    let remote_id = remote_workspace_stable_id("myhost", "/root/proj");
    assert_eq!(remote_id, "remote_0b6e9c54b3e51fd56bf721ed35c1ce88");

    let unresolved_key = unresolved_remote_session_storage_key(" conn-1 ", "/home/u/p");
    assert_eq!(unresolved_key, "d1c72f60fc1b7cb99599cf21");
}

#[test]
fn remote_workspace_session_paths_use_supplied_mirror_root() {
    let mirror_root = std::path::PathBuf::from("/openbitfun/remote_ssh");

    assert_eq!(
        remote_workspace_runtime_root(&mirror_root, " Example.COM ", "/home/user/repo"),
        mirror_root
            .join("example.com")
            .join("home")
            .join("user")
            .join("repo")
    );
    assert_eq!(
        remote_workspace_session_mirror_dir(&mirror_root, " Example.COM ", "/"),
        mirror_root
            .join("example.com")
            .join("_root")
            .join("sessions")
    );
    assert_eq!(
        unresolved_remote_session_storage_dir(&mirror_root, " conn-1 ", "/home/u/p"),
        mirror_root
            .join("_unresolved")
            .join("d1c72f60fc1b7cb99599cf21")
            .join("sessions")
    );
}

#[test]
fn local_workspace_identity_helpers_preserve_canonical_root_contract() {
    let workspace_root = std::env::temp_dir().join(format!(
        "openbitfun-services-remote-ssh-contract-{}",
        std::process::id()
    ));
    let nested = workspace_root.join("nested");
    std::fs::create_dir_all(&nested).expect("workspace root should exist");

    let (canonical_path, stable_root) =
        canonicalize_local_workspace_root(&workspace_root).expect("canonical local root");
    assert_eq!(
        stable_root,
        normalize_local_workspace_root_for_stable_id(&workspace_root)
            .expect("normalized local root")
    );
    assert_eq!(
        stable_root,
        canonical_path.to_string_lossy().replace('\\', "/")
    );
    assert!(local_workspace_roots_equal(
        &workspace_root,
        &workspace_root
    ));
    assert!(!local_workspace_roots_equal(&workspace_root, &nested));

    let _ = std::fs::remove_dir_all(workspace_root);
}

#[test]
fn workspace_session_identity_preserves_local_and_remote_contracts() {
    let workspace_root = std::env::temp_dir().join(format!(
        "openbitfun-services-workspace-identity-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&workspace_root).expect("workspace root should exist");

    let local =
        workspace_session_identity(&workspace_root.to_string_lossy(), None, None).expect("local");
    assert_eq!(local.hostname, LOCAL_WORKSPACE_SSH_HOST);
    assert!(!local.is_remote());
    assert_eq!(local.remote_connection_id, None);

    let remote = workspace_session_identity(
        r"\\home\\wsp\\project//",
        Some(" conn-1 "),
        Some(" ssh.dev "),
    )
    .expect("remote");
    assert_eq!(remote.hostname, "ssh.dev");
    assert_eq!(remote.logical_workspace_path(), "/home/wsp/project");
    assert_eq!(remote.remote_connection_id.as_deref(), Some("conn-1"));
    assert!(remote.is_remote());

    assert!(
        workspace_session_identity("/home/wsp/project", Some("conn-1"), None).is_none(),
        "remote identity requires a resolvable SSH host"
    );

    let _ = std::fs::remove_dir_all(workspace_root);
}

#[tokio::test]
async fn remote_workspace_registry_preserves_ambiguous_root_resolution_contract() {
    let registry = RemoteWorkspaceRegistry::new();
    registry
        .register_remote_workspace(
            "/".to_string(),
            "conn-a".to_string(),
            "Server A".to_string(),
            "host-a".to_string(),
        )
        .await;
    registry
        .register_remote_workspace(
            "/".to_string(),
            "conn-b".to_string(),
            "Server B".to_string(),
            "host-b".to_string(),
        )
        .await;

    assert!(registry.lookup_connection("/tmp", None).await.is_none());

    registry
        .set_active_connection_hint(Some("conn-a".to_string()))
        .await;
    let hinted = registry.lookup_connection("/tmp", None).await.unwrap();
    assert_eq!(hinted.connection_id, "conn-a");
    assert_eq!(hinted.ssh_host, "host-a");

    let preferred = registry
        .lookup_connection("/tmp", Some("conn-b"))
        .await
        .unwrap();
    assert_eq!(preferred.connection_id, "conn-b");
    assert_eq!(preferred.ssh_host, "host-b");
}

#[tokio::test]
async fn remote_workspace_registry_treats_explicit_connection_as_exact_identity() {
    let registry = RemoteWorkspaceRegistry::new();
    registry
        .register_remote_workspace(
            "/workspace".to_string(),
            "conn-a".to_string(),
            "Server A".to_string(),
            "host-a".to_string(),
        )
        .await;

    assert!(
        registry
            .lookup_scoped_connection("/workspace/project", "conn-b")
            .await
            .is_none(),
        "an explicit connection must never route to a different registered host"
    );

    let legacy_hint = registry
        .lookup_connection("/workspace/project", Some("conn-b"))
        .await
        .expect("the compatibility lookup keeps its unique-path hint behavior");
    assert_eq!(legacy_hint.connection_id, "conn-a");
}

#[tokio::test]
async fn remote_workspace_registry_preserves_legacy_state_and_clear_contract() {
    let registry = RemoteWorkspaceRegistry::new();
    assert!(!registry.has_any().await);
    assert!(!registry.get_state().await.is_active);

    registry
        .register_remote_workspace(
            "/repo".to_string(),
            "conn-1".to_string(),
            "Dev Server".to_string(),
            "dev.example.com".to_string(),
        )
        .await;

    let state = registry.get_state().await;
    assert!(state.is_active);
    assert_eq!(state.connection_id.as_deref(), Some("conn-1"));
    assert_eq!(state.remote_path.as_deref(), Some("/repo"));
    assert_eq!(state.connection_name.as_deref(), Some("Dev Server"));

    registry
        .unregister_remote_workspace("conn-1", "/repo")
        .await;
    assert!(!registry.has_any().await);
    assert!(!registry.get_state().await.is_active);
}

#[test]
fn port_forward_request_defaults_keep_a_bare_remote_port_usable() {
    // The UI is allowed to send nothing but the connection and the remote port;
    // every other field has to default to the safe, common-case answer.
    let request: PortForwardRequest = serde_json::from_value(serde_json::json!({
        "connectionId": "conn-1",
        "remotePort": 3000
    }))
    .expect("a minimal request must deserialize");

    assert_eq!(request.effective_remote_host(), "127.0.0.1");
    assert_eq!(
        request.effective_local_host(),
        "127.0.0.1",
        "a forward must never reach beyond loopback unless asked to"
    );
    assert_eq!(request.preferred_local_port(), None);
    assert_eq!(request.normalized_label(), None);
    assert!(!request.expose_on_lan);
}

#[test]
fn port_forward_request_honors_an_explicit_lan_exposure() {
    let request: PortForwardRequest = serde_json::from_value(serde_json::json!({
        "connectionId": "conn-1",
        "remotePort": 8080,
        "remoteHost": "10.0.0.5",
        "localPort": 18080,
        "exposeOnLan": true,
        "label": "  staging api  "
    }))
    .expect("a full request must deserialize");

    assert_eq!(request.effective_remote_host(), "10.0.0.5");
    assert_eq!(request.effective_local_host(), "0.0.0.0");
    assert_eq!(request.preferred_local_port(), Some(18080));
    assert_eq!(request.normalized_label().as_deref(), Some("staging api"));
}

#[test]
fn port_forward_wire_shape_stays_camel_case() {
    let forward = PortForward {
        id: "forward-1".to_string(),
        connection_id: "conn-1".to_string(),
        direction: PortForwardDirection::Local,
        label: None,
        local_host: "127.0.0.1".to_string(),
        local_port: 3001,
        requested_local_port: Some(3000),
        remote_host: "127.0.0.1".to_string(),
        remote_port: 3000,
        active_connections: 2,
        total_connections: 17,
        last_error: None,
    };

    let value = serde_json::to_value(&forward).expect("a forward must serialize");
    assert_eq!(value["localPort"], 3001);
    assert_eq!(
        value["requestedLocalPort"], 3000,
        "the UI needs the requested port to explain a moved mapping"
    );
    assert_eq!(value["remotePort"], 3000);
    assert_eq!(value["activeConnections"], 2);
    assert_eq!(value["direction"], "local");
    assert_eq!(forward.local_address(), "127.0.0.1:3001");
}

#[test]
fn remote_listening_port_wire_shape_stays_camel_case() {
    let port = RemoteListeningPort {
        port: 5173,
        bind_address: "127.0.0.1".to_string(),
        process: Some("vite".to_string()),
        pid: Some(4242),
    };
    let value = serde_json::to_value(&port).expect("a listening port must serialize");
    assert_eq!(value["bindAddress"], "127.0.0.1");
    assert_eq!(value["process"], "vite");
    assert_eq!(value["pid"], 4242);
}

#[test]
fn wsl_target_and_legacy_ssh_profiles_round_trip_without_requiring_new_fields() {
    let legacy = serde_json::json!({
        "id": "legacy", "name": "legacy", "host": "example.test", "port": 22,
        "username": "dev", "auth": { "type": "Password", "password": "" }
    });
    let config: SSHConnectionConfig = serde_json::from_value(legacy).unwrap();
    let wire = serde_json::to_value(&config).unwrap();
    assert!(wire.get("wsl").is_none());
    let round_trip: SSHConnectionConfig = serde_json::from_value(wire).unwrap();
    assert!(config.connection_params_equal(&round_trip));
    assert!(!round_trip.uses_local_process());

    let wsl_wire = serde_json::json!({
        "id": "wsl-Ubuntu-", "name": "WSL", "host": "wsl.invalid", "port": 0,
        "username": "", "auth": { "type": "PrivateKey", "keyPath": "" },
        "wsl": { "distribution": "Ubuntu" }
    });
    let config: SSHConnectionConfig = serde_json::from_value(wsl_wire).unwrap();
    assert!(config.uses_local_process());
    assert!(config.uses_shell_filesystem());
    assert!(!config.uses_local_docker());
    assert!(!config.uses_docker_exec());
    assert_eq!(config.wsl.as_ref().unwrap().user, None);
    let round_trip: SSHConnectionConfig =
        serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
    assert!(config.connection_params_equal(&round_trip));
    let mut other = round_trip;
    other.wsl.as_mut().unwrap().distribution = "Debian".into();
    assert!(!config.connection_params_equal(&other));
    other.wsl.as_mut().unwrap().distribution = "Ubuntu".into();
    other.wsl.as_mut().unwrap().user = Some("root".into());
    assert!(!config.connection_params_equal(&other));
}
