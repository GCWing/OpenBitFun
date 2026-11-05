use crate::{
    read_frame, write_frame, DiscoveryStore, InitializeRequest, RuntimeInstanceIdentity,
    RuntimeIpcClient, RuntimeIpcClientError, RuntimeIpcErrorCode, RuntimeIpcFrame,
    RuntimeIpcIoError, RuntimeIpcOperation, RuntimeIpcServer, RuntimeIpcServerConfig,
    RuntimeIpcTransportError, RuntimeSessionRenameRequest, MAX_REQUEST_FRAME_BYTES,
    PROTOCOL_VERSION,
};
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::AsyncWriteExt;

fn runtime_identity(workspace: &std::path::Path) -> RuntimeInstanceIdentity {
    RuntimeInstanceIdentity::for_workspace(
        workspace,
        "openbitfun",
        "stable",
        "user-a",
        PROTOCOL_VERSION,
    )
    .expect("runtime identity")
}

fn server_config() -> RuntimeIpcServerConfig {
    RuntimeIpcServerConfig {
        server_version: "0.2.14-test".to_string(),
        idle_timeout: Duration::from_millis(80),
        handshake_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_secs(2),
        max_connections: 8,
    }
}

#[tokio::test]
async fn authenticated_client_can_read_health_and_idle_server_cleans_discovery() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity.clone(), server_config())
        .await
        .expect("bind server");
    let discovery = server.discovery_record().clone();
    let store = DiscoveryStore::new(runtime_root.path(), identity.clone());
    assert_eq!(
        store.read().expect("read discovery"),
        Some(discovery.clone())
    );

    let server_task = tokio::spawn(server.serve());
    let client = RuntimeIpcClient::connect(
        runtime_root.path(),
        &discovery,
        "foundation-test",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .expect("initialize client");
    let health = client.health().await.expect("read health");
    assert_eq!(health.instance_identity, identity.as_str());
    assert_eq!(health.process_id, std::process::id());
    drop(client);

    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits after idle timeout")
        .expect("server task joins")
        .expect("server exits cleanly");
    assert_eq!(store.read().expect("read cleaned discovery"), None);
}

#[tokio::test]
async fn oversized_request_is_rejected_before_send_without_closing_the_connection() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, server_config())
        .await
        .expect("bind server");
    let discovery = server.discovery_record().clone();
    let server_task = tokio::spawn(server.serve());
    let client = RuntimeIpcClient::connect(
        runtime_root.path(),
        &discovery,
        "oversized-request-test",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .expect("initialize client");

    let error = client
        .request(RuntimeIpcOperation::RenameSession {
            request: RuntimeSessionRenameRequest {
                session_id: "session-1".to_string(),
                session_name: "x".repeat(MAX_REQUEST_FRAME_BYTES),
            },
        })
        .await
        .expect_err("oversized request must fail before transport write");
    assert!(matches!(
        error,
        RuntimeIpcClientError::RequestEncoding(RuntimeIpcIoError::FrameTooLarge { .. })
    ));
    client
        .health()
        .await
        .expect("pre-send rejection must leave the connection usable");

    drop(client);
    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits after idle timeout")
        .expect("server task joins")
        .expect("server exits cleanly");
}

#[tokio::test]
async fn cancelling_the_server_task_cleans_its_discovery_record() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity.clone(), server_config())
        .await
        .expect("bind server");
    let store = DiscoveryStore::new(runtime_root.path(), identity);
    let server_task = tokio::spawn(server.serve());

    server_task.abort();
    assert!(server_task
        .await
        .expect_err("server task is cancelled")
        .is_cancelled());

    assert_eq!(store.read().expect("read cleaned discovery"), None);
}

#[tokio::test]
async fn handshake_rejects_bad_token_wrong_instance_and_protocol_mismatch() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let other_workspace = tempdir().expect("other workspace");
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, server_config())
        .await
        .expect("bind server");
    let endpoint = server.endpoint().clone();
    let discovery = server.discovery_record().clone();
    let server_task = tokio::spawn(server.serve());

    let mut bad_token = discovery.clone();
    bad_token.token = "wrong-token".to_string();
    let error = RuntimeIpcClient::connect(
        runtime_root.path(),
        &bad_token,
        "foundation-test",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .expect_err("bad token must fail");
    assert!(matches!(
        error,
        RuntimeIpcClientError::Remote(ref remote)
            if remote.code == RuntimeIpcErrorCode::Unauthorized
    ));

    let wrong_identity = runtime_identity(other_workspace.path());
    let mut raw = endpoint
        .connect(Duration::from_secs(2))
        .await
        .expect("connect raw local stream");
    write_frame(
        &mut raw,
        &RuntimeIpcFrame::Initialize {
            request_id: 41,
            request: InitializeRequest {
                protocol_version: PROTOCOL_VERSION,
                instance_identity: wrong_identity.as_str().to_string(),
                token: discovery.token.clone(),
                client_id: "foundation-test".to_string(),
                client_version: "0.1.0".to_string(),
            },
        },
    )
    .await
    .expect("write wrong-instance initialize");
    assert!(matches!(
        read_frame(&mut raw).await.expect("read wrong-instance rejection"),
        RuntimeIpcFrame::Error { request_id: Some(41), error }
            if error.code == RuntimeIpcErrorCode::WrongInstance
    ));
    drop(raw);

    let mut mismatched_discovery = discovery.clone();
    mismatched_discovery.instance_identity = wrong_identity;
    assert!(matches!(
        RuntimeIpcClient::connect(
            runtime_root.path(),
            &mismatched_discovery,
            "foundation-test",
            "0.1.0",
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
        .await,
        Err(RuntimeIpcClientError::Transport(
            RuntimeIpcTransportError::InvalidEndpoint
        ))
    ));

    let mut wrong_protocol = discovery;
    wrong_protocol.protocol_version = PROTOCOL_VERSION + 1;
    assert!(matches!(
        RuntimeIpcClient::connect(
            runtime_root.path(),
            &wrong_protocol,
            "foundation-test",
            "0.1.0",
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
        .await,
        Err(RuntimeIpcClientError::IncompatibleProtocol { .. })
    ));

    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits")
        .expect("server task joins")
        .expect("server exits cleanly");
}

#[tokio::test]
async fn first_frame_must_be_initialize() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, server_config())
        .await
        .expect("bind server");
    let endpoint = server.endpoint().clone();
    let server_task = tokio::spawn(server.serve());

    let mut stream = endpoint
        .connect(Duration::from_secs(2))
        .await
        .expect("connect raw local stream");
    write_frame(
        &mut stream,
        &RuntimeIpcFrame::Request {
            request_id: 99,
            operation: RuntimeIpcOperation::Health,
        },
    )
    .await
    .expect("write pre-initialize request");
    let response = read_frame(&mut stream).await.expect("read rejection");
    assert!(matches!(
        response,
        RuntimeIpcFrame::Error {
            request_id: Some(99),
            error
        } if error.code == RuntimeIpcErrorCode::InvalidRequest
    ));
    drop(stream);

    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits")
        .expect("server task joins")
        .expect("server exits cleanly");
}

#[tokio::test]
async fn malformed_client_is_isolated_from_later_health_clients() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let mut config = server_config();
    config.idle_timeout = Duration::from_millis(250);
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, config)
        .await
        .expect("bind server");
    let endpoint = server.endpoint().clone();
    let discovery = server.discovery_record().clone();
    let server_task = tokio::spawn(server.serve());

    let mut malformed = endpoint
        .connect(Duration::from_secs(2))
        .await
        .expect("connect malformed client");
    malformed
        .write_u32((MAX_REQUEST_FRAME_BYTES + 1) as u32)
        .await
        .expect("write oversized frame prefix");
    drop(malformed);
    tokio::time::sleep(Duration::from_millis(20)).await;

    let healthy = RuntimeIpcClient::connect(
        runtime_root.path(),
        &discovery,
        "foundation-test",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .expect("server remains available after malformed client");
    healthy.health().await.expect("Health remains available");
    drop(healthy);

    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits")
        .expect("server task joins")
        .expect("server exits cleanly");
}

#[tokio::test]
async fn connection_limit_applies_before_authentication() {
    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let mut config = server_config();
    config.idle_timeout = Duration::from_millis(250);
    config.max_connections = 1;
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, config)
        .await
        .expect("bind server");
    let endpoint = server.endpoint().clone();
    let discovery = server.discovery_record().clone();
    let server_task = tokio::spawn(server.serve());

    let blocker = endpoint
        .connect(Duration::from_secs(2))
        .await
        .expect("connect unauthenticated blocker");
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(
        RuntimeIpcClient::connect(
            runtime_root.path(),
            &discovery,
            "bounded-client",
            "0.1.0",
            Duration::from_millis(50),
            Duration::from_secs(2),
        )
        .await,
        Err(RuntimeIpcClientError::Timeout)
    ));

    drop(blocker);
    let client = RuntimeIpcClient::connect(
        runtime_root.path(),
        &discovery,
        "bounded-client",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .expect("capacity recovers after blocker disconnects");
    client
        .health()
        .await
        .expect("Health after capacity recovery");
    drop(client);

    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits")
        .expect("server task joins")
        .expect("server exits cleanly");
}

#[cfg(unix)]
#[tokio::test]
async fn non_utf8_runtime_root_supports_discovery_bind_and_health() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let parent = tempdir().expect("runtime parent");
    let runtime_root = parent
        .path()
        .join(OsString::from_vec(b"runtime-\x80".to_vec()));
    std::fs::create_dir(&runtime_root).expect("create non-UTF-8 runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(&runtime_root, identity.clone(), server_config())
        .await
        .expect("bind server under non-UTF-8 runtime root");
    let discovery = server.discovery_record().clone();
    let server_task = tokio::spawn(server.serve());

    let client = RuntimeIpcClient::connect(
        &runtime_root,
        &discovery,
        "non-utf8-test",
        "0.1.0",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .expect("initialize through lossless Unix endpoint");
    let health = client.health().await.expect("read Health");
    assert_eq!(health.instance_identity, identity.as_str());
    drop(client);

    tokio::time::timeout(Duration::from_secs(2), server_task)
        .await
        .expect("server exits")
        .expect("server task joins")
        .expect("server exits cleanly");
}

#[cfg(unix)]
#[tokio::test]
async fn unix_endpoint_rejects_a_runtime_root_that_exceeds_the_portable_uds_limit() {
    let parent = tempdir().expect("runtime parent");
    let runtime_root = parent.path().join("r".repeat(120));
    std::fs::create_dir(&runtime_root).expect("create long runtime root");
    let workspace = tempdir().expect("workspace");

    let error = match RuntimeIpcServer::bind(
        &runtime_root,
        runtime_identity(workspace.path()),
        server_config(),
    )
    .await
    {
        Ok(_) => panic!("overlong UDS path must fail before bind"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        crate::server::RuntimeIpcServerError::Transport(
            RuntimeIpcTransportError::EndpointTooLong { .. }
        )
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn stale_unix_socket_is_replaced_by_the_next_locked_owner() {
    use std::os::unix::net::UnixListener;

    let runtime_root = tempdir().expect("runtime root");
    let workspace = tempdir().expect("workspace");
    let identity = runtime_identity(workspace.path());
    let endpoint = crate::LocalIpcEndpoint::for_instance(runtime_root.path(), &identity)
        .expect("stable endpoint");
    let stale = UnixListener::bind(endpoint.as_path()).expect("create stale socket");
    drop(stale);
    assert!(endpoint.as_path().exists());

    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, server_config())
        .await
        .expect("next owner replaces stale socket");
    assert_eq!(server.endpoint(), &endpoint);
    drop(server);
    assert!(!endpoint.as_path().exists());
}

#[tokio::test]
async fn force_compaction_without_capability_is_rejected_without_losing_the_connection() {
    let runtime_root = tempdir().unwrap();
    let workspace = tempdir().unwrap();
    let identity = runtime_identity(workspace.path());
    let server = RuntimeIpcServer::bind(runtime_root.path(), identity, server_config())
        .await
        .unwrap();
    let discovery = server.discovery_record().clone();
    let server_task = tokio::spawn(server.serve());
    let client = RuntimeIpcClient::connect(
        runtime_root.path(),
        &discovery,
        "compact",
        "test",
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    assert!(!client.capabilities().local_context_truncation);
    let error = client
        .request(RuntimeIpcOperation::CompactSession {
            request: openbitfun_runtime_ports::AgentSessionCompactionRequest {
                session_id: "session".into(),
                turn_id: "turn".into(),
                force: true,
            },
        })
        .await
        .unwrap_err();
    assert!(
        matches!(error, RuntimeIpcClientError::Remote(error) if error.code == RuntimeIpcErrorCode::OperationUnsupported)
    );
    client.health().await.unwrap();
    drop(client);
    server_task.await.unwrap().unwrap();
}
