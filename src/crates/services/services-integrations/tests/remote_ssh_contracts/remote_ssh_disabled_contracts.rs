#![cfg(not(feature = "remote-ssh-concrete"))]

use std::path::PathBuf;
use std::sync::Arc;

use openbitfun_services_integrations::remote_ssh::{
    get_global_remote_exec_process_manager, RemoteExecCommandRequest, RemoteExecError,
    RemoteFileService, RemoteTerminalManager, SSHAuthMethod, SSHConnectionConfig,
    SSHConnectionManager,
};

fn test_config() -> SSHConnectionConfig {
    SSHConnectionConfig {
        id: "conn-1".to_string(),
        name: "Connection 1".to_string(),
        host: "example.test".to_string(),
        port: 22,
        username: "user".to_string(),
        auth: SSHAuthMethod::Password {
            password: "secret".to_string(),
        },
        default_workspace: Some("/repo".to_string()),
        proxy_jump: None,
        proxy_command: None,
        container: None,
        wsl: None,
        options: Default::default(),
    }
}

fn assert_disabled_error(error: impl std::fmt::Display) {
    assert!(
        error.to_string().contains("Remote SSH support is disabled"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn remote_ssh_disabled_connection_manager_preserves_unsupported_contract() {
    let manager = SSHConnectionManager::new(PathBuf::from("remote-ssh-disabled"));

    assert!(manager.list_known_hosts().await.is_empty());
    assert!(manager.get_saved_connections().await.is_empty());
    assert!(!manager.is_connected("conn-1").await);
    assert!(manager.get_server_info("conn-1").await.is_none());

    let error = manager.connect(test_config()).await.unwrap_err();
    assert_disabled_error(error);
}

#[tokio::test]
async fn remote_ssh_disabled_file_terminal_and_exec_paths_return_unsupported() {
    let manager = SSHConnectionManager::new(PathBuf::from("remote-ssh-disabled"));
    let manager_slot = Arc::new(tokio::sync::RwLock::new(Some(manager.clone())));
    let file_service = RemoteFileService::new(manager_slot);
    let terminal_manager = RemoteTerminalManager::new(manager.clone());
    let exec_manager = get_global_remote_exec_process_manager();

    let read_error = file_service
        .read_file("conn-1", "/repo/file.txt")
        .await
        .unwrap_err();
    assert_disabled_error(read_error);

    let terminal_result = terminal_manager
        .create_session(
            Some("session-1".to_string()),
            Some("Remote terminal".to_string()),
            "conn-1",
            80,
            24,
            Some("/repo"),
            None,
        )
        .await;
    let terminal_error = match terminal_result {
        Ok(_) => panic!("disabled remote terminal should return an unsupported error"),
        Err(error) => error,
    };
    assert_disabled_error(terminal_error);

    let exec_error = exec_manager
        .exec_command(RemoteExecCommandRequest {
            ssh_manager: manager,
            connection_id: "conn-1".to_string(),
            command: "pwd".to_string(),
            tty: false,
            yield_time_ms: None,
            max_output_chars: None,
            lifecycle_tx: None,
            output_capture_tx: None,
        })
        .await
        .unwrap_err();
    match exec_error {
        RemoteExecError::Other(error) => assert_disabled_error(error),
        other => panic!("unexpected exec error: {other:?}"),
    }
}
