use super::*;
use openbitfun_core::service::remote_connect::embedded_relay_host::EmbeddedRelayHost;
use openbitfun_relay_service::{build_relay_router, db, MemoryAssetStore};
use openbitfun_services_integrations::remote_connect::device_crypto;

struct FixtureHost {
    database: Arc<db::DbPool>,
    listener: tokio::sync::Mutex<Option<tokio::net::TcpListener>>,
    server: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    port: u16,
    prefix: &'static str,
}

impl FixtureHost {
    async fn new(prefix: &'static str) -> Arc<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::new(Self {
            port: listener.local_addr().unwrap().port(),
            database: Arc::new(db::connect(":memory:").await.unwrap()),
            listener: tokio::sync::Mutex::new(Some(listener)),
            server: tokio::sync::Mutex::new(None),
            prefix,
        })
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, self.prefix)
    }

    async fn credential(&self, device_id: &str, secret: [u8; 32]) -> AccountSession {
        db::UserRow::upsert_verified(&self.database, "42", "route-test")
            .await
            .unwrap();
        db::DeviceRow::upsert(
            &self.database,
            device_id,
            "42",
            device_id,
            Some("desktop"),
            Some(&device_crypto::public_key_base64(&secret)),
        )
        .await
        .unwrap();
        let token = db::AuthToken::create(&self.database, "42", device_id)
            .await
            .unwrap();
        AccountSession::new(token.token, "42".into(), secret)
    }
}

#[async_trait::async_trait]
impl EmbeddedRelayHost for FixtureHost {
    async fn start(&self, port: u16, _: Option<String>) -> anyhow::Result<()> {
        assert_eq!(port, self.port);
        let listener = match self.listener.lock().await.take() {
            Some(listener) => listener,
            None => tokio::net::TcpListener::bind(("127.0.0.1", port)).await?,
        };
        let app = build_relay_router(
            Arc::new(MemoryAssetStore::new()),
            std::time::Instant::now(),
            self.database.clone(),
            env!("CARGO_PKG_VERSION"),
        );
        let app = if self.prefix.is_empty() {
            app
        } else {
            axum::Router::new().nest(self.prefix, app)
        };
        *self.server.lock().await = Some(tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        }));
        Ok(())
    }

    async fn stop(&self) {
        if let Some(server) = self.server.lock().await.take() {
            server.abort();
            let _ = server.await;
        }
    }
}

async fn rpc(
    host: &FixtureHost,
    controller: &AccountSession,
    target: &str,
    value: serde_json::Value,
) -> serde_json::Value {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        AccountClient::new().device_rpc(&host.url(), controller, target, &value.to_string()),
    )
    .await
    .unwrap()
    .unwrap();
    serde_json::from_str(&result).unwrap()
}

async fn assert_hint(
    receiver: &mut tokio::sync::broadcast::Receiver<
        Option<openbitfun_services_integrations::remote_connect::account::StreamHint>,
    >,
    cursor: u64,
) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if receiver
                .recv()
                .await
                .unwrap()
                .is_some_and(|hint| hint.cursor == cursor)
            {
                break;
            }
        }
    })
    .await
    .expect("encrypted event reached its route's controller");
}

/// Run the real socket/HTTP fixture in a separate process with temporary product
/// storage, so adoption of device identity and credential persistence never
/// modifies the developer's login or races other desktop unit tests.
#[tokio::test]
async fn dual_relay_rpc_persistence_and_teardown_are_independent() {
    if std::env::var_os("OPENBITFUN_RELAY_ROUTE_TEST_CHILD").is_none() {
        let root = tempfile::tempdir().unwrap();
        let mut command = openbitfun_services_core::process_manager::create_tokio_command(
            std::env::current_exe().unwrap(),
        );
        command.args(["api::remote_connect_api::relay_routes_tests::dual_relay_rpc_persistence_and_teardown_are_independent", "--exact", "--nocapture"])
            .env("OPENBITFUN_RELAY_ROUTE_TEST_CHILD", "1")
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .env("OPENBITFUN_HOME", root.path())
            .env("OPENBITFUN_DEVICE_IDENTITY_PATH", root.path().join("device_identity.json"))
            .kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(90), command.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "child fixture must actually run"
        );
        return;
    }
    let _test_guard = sync_state_tests::ACCOUNT_CONTEXT_TEST_LOCK.lock().await;
    let official = FixtureHost::new("/v/1.0.2").await;
    let lan = FixtureHost::new("").await;
    let id = current_device_identity().unwrap().device_id;
    let official_session = official.credential(&id, [1; 32]).await;
    let lan_session = lan.credential(&id, [2; 32]).await;
    let official_controller = official.credential("controller", [3; 32]).await;
    let lan_controller = lan.credential("controller", [4; 32]).await;
    official.start(official.port, None).await.unwrap();
    let official_service = RemoteConnectService::new(
        RemoteConnectConfig {
            openbitfun_server_url: official.url(),
            ..RemoteConnectConfig::default()
        },
        Arc::new(DesktopEmbeddedRelayHost::default()),
    )
    .unwrap();
    let lan_service = RemoteConnectService::new(
        RemoteConnectConfig {
            lan_port: lan.port,
            ..RemoteConnectConfig::default()
        },
        lan.clone(),
    )
    .unwrap();
    official_service
        .prepare_relay(&ConnectionMethod::OpenBitFunServer)
        .await
        .unwrap();
    let lan_method = ConnectionMethod::Lan {
        ip: Some("127.0.0.1".into()),
    };
    lan_service.prepare_relay(&lan_method).await.unwrap();
    *RelayRoute::Official.service().write().await = Some(official_service);
    *RelayRoute::Lan.service().write().await = Some(lan_service);
    *get_account_context().write().await = Some(AccountContextState {
        session: official_session.clone(),
        relay_url: official.url(),
    });
    let generation = account_context_generation();
    account_connect_devices().await.unwrap();
    let mut original_owner = current_device_routing_owner_snapshot().unwrap();
    let saved = session_store::load_session_detailed().unwrap().unwrap();
    assert_eq!(saved.token, official_session.token);
    RelayRoute::replace_lan_context(Some(AccountContextState {
        session: lan_session.clone(),
        relay_url: lan.url(),
    }))
    .await;
    connect_route_devices(RelayRoute::Lan).await.unwrap();
    assert_eq!(account_context_generation(), generation);
    assert_eq!(
        current_device_routing_owner_snapshot().unwrap(),
        original_owner
    );
    assert_eq!(
        session_store::load_session_detailed()
            .unwrap()
            .unwrap()
            .token,
        saved.token
    );
    let invitation = RelayRoute::Lan
        .service()
        .read()
        .await
        .as_ref()
        .unwrap()
        .start(lan_method)
        .await
        .unwrap();
    assert!(invitation
        .qr_url
        .unwrap()
        .starts_with(&format!("http://127.0.0.1:{}/", lan.port)));
    assert_eq!(host_stream_hubs().await.len(), 2);
    let lan_owner = with_route_state(RelayRoute::Lan, |state| state.owner.clone()).unwrap();
    relay_routes::start_lan(ConnectionMethod::Lan {
        ip: Some("127.0.0.1".into()),
    })
    .await
    .unwrap();
    assert!(device_routing_owner_is_current(&lan_owner).await);
    assert_eq!(
        current_device_routing_owner_snapshot().unwrap(),
        original_owner
    );

    for (host, controller, client_id) in [
        (&official, &official_controller, "public-phone"),
        (&lan, &lan_controller, "lan-phone"),
    ] {
        assert_eq!(
            rpc(
                host,
                controller,
                &id,
                serde_json::json!({"cmd":"ping", "client":{"id":client_id,"name":client_id}})
            )
            .await["resp"],
            "pong"
        );
        assert_eq!(rpc(host, controller, &id, serde_json::json!({"cmd":"host_invoke","command":"peer_control_attach","args":{"controllerDeviceId":"spoofed"}})).await["ok"], true);
    }
    for route in RelayRoute::ALL {
        assert_eq!(
            crate::api::peer_host_invoke::attached_route_controllers(route),
            vec!["controller"]
        );
    }
    let status = remote_connect_status().await.unwrap();
    assert_eq!(status.connections.len(), 2);
    assert!(status.connections.iter().all(|route| route.relay_connected));
    assert_eq!(status.connections[0].clients[0].id, "public-phone");
    assert_eq!(status.connections[1].clients[0].id, "lan-phone");
    let mut public_hints = official_controller.stream_hints();
    let mut lan_hints = lan_controller.stream_hints();
    fanout_peer_device_event(
        openbitfun_core::service::remote_connect::host_stream::HOST_STREAM_CHANGED_EVENT.into(),
        serde_json::json!({"stream_id":"dual", "epoch":1, "cursor":1}),
    );
    assert_hint(&mut public_hints, 1).await;
    assert_hint(&mut lan_hints, 1).await;

    // An expired public credential is not a shared-identity sign-out. Its
    // cancellation and persistence cleanup must leave the LAN route usable.
    let lan_cancellation = RelayRoute::Lan.cancellation().subscribe();
    assert!(
        invalidate_local_account_session_if_current(
            generation,
            &official_session.token,
            "fixture token expired",
        )
        .await
    );
    assert!(!lan_cancellation.has_changed().unwrap());
    assert!(account_token_expired().await);
    assert!(session_store::load_session_detailed().unwrap().is_none());
    assert!(device_routing_owner_is_current(&lan_owner).await);
    assert_eq!(
        rpc(
            &lan,
            &lan_controller,
            &id,
            serde_json::json!({"cmd":"ping"})
        )
        .await["resp"],
        "pong"
    );
    fanout_peer_device_event(
        openbitfun_core::service::remote_connect::host_stream::HOST_STREAM_CHANGED_EVENT.into(),
        serde_json::json!({"stream_id":"dual", "epoch":1, "cursor":2}),
    );
    assert_hint(&mut lan_hints, 2).await;
    *get_account_context().write().await = Some(AccountContextState {
        session: official_session.clone(),
        relay_url: official.url(),
    });
    account_connect_devices().await.unwrap();
    assert!(
        !invalidate_local_account_session_if_current(
            generation,
            &official_session.token,
            "stale fixture token failure",
        )
        .await
    );

    remote_connect_stop(Some(StopRemoteConnectRequest {
        method: "openbitfun_server".into(),
    }))
    .await
    .unwrap();
    assert_eq!(host_stream_hubs().await.len(), 1);
    assert_eq!(
        rpc(
            &lan,
            &lan_controller,
            &id,
            serde_json::json!({"cmd":"ping"})
        )
        .await["resp"],
        "pong"
    );
    assert_eq!(
        crate::api::peer_host_invoke::attached_route_controllers(RelayRoute::Lan),
        vec!["controller"]
    );
    account_connect_devices().await.unwrap();
    original_owner = current_device_routing_owner_snapshot().unwrap();
    rpc(&official, &official_controller, &id, serde_json::json!({"cmd":"host_invoke","command":"peer_control_attach","args":{"controllerDeviceId":"spoofed"}})).await;

    remote_connect_stop(Some(StopRemoteConnectRequest {
        method: "lan".into(),
    }))
    .await
    .unwrap();
    assert_eq!(
        current_device_routing_owner_snapshot().unwrap(),
        original_owner
    );
    assert!(device_routing_owner_is_current(&original_owner).await);
    assert_eq!(host_stream_hubs().await.len(), 1);
    assert!(db::AuthToken::find(&lan.database, &lan_session.token)
        .await
        .unwrap()
        .is_none());
    assert!(
        db::AuthToken::find(&official.database, &official_session.token)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        rpc(
            &official,
            &official_controller,
            &id,
            serde_json::json!({"cmd":"ping"})
        )
        .await["resp"],
        "pong"
    );
    let directory = AccountClient::new()
        .list_devices(&official.url(), &official_session)
        .await
        .unwrap();
    assert!(directory
        .iter()
        .any(|device| device.device_id == id && device.online));
    assert_eq!(
        session_store::load_session_detailed()
            .unwrap()
            .unwrap()
            .token,
        saved.token
    );
    assert_eq!(
        crate::api::peer_host_invoke::attached_route_controllers(RelayRoute::Official),
        vec!["controller"]
    );
    assert!(crate::api::peer_host_invoke::attached_route_controllers(RelayRoute::Lan).is_empty());

    // A late exit from the retired LAN loop cannot erase the official owner.
    finish_device_routing_event_loop(&DeviceRoutingOwner {
        route: RelayRoute::Lan,
        ..original_owner.clone()
    })
    .await;
    assert!(device_routing_owner_is_current(&original_owner).await);
    assert!(relay_routes::start_lan(ConnectionMethod::Lan {
        ip: Some("invalid-interface".into())
    })
    .await
    .is_err());
    assert!(device_routing_owner_is_current(&original_owner).await);
    assert_eq!(
        rpc(
            &official,
            &official_controller,
            &id,
            serde_json::json!({"cmd":"ping"})
        )
        .await["resp"],
        "pong"
    );

    // Full sign-out is the shared identity boundary and retires both routes.
    let replacement_lan = lan.credential(&id, [2; 32]).await;
    RelayRoute::Lan
        .service()
        .read()
        .await
        .as_ref()
        .unwrap()
        .prepare_relay(&ConnectionMethod::Lan {
            ip: Some("127.0.0.1".into()),
        })
        .await
        .unwrap();
    RelayRoute::replace_lan_context(Some(AccountContextState {
        session: replacement_lan.clone(),
        relay_url: lan.url(),
    }))
    .await;
    connect_route_devices(RelayRoute::Lan).await.unwrap();
    clear_account_login(true).await;
    assert!(get_account_context().read().await.is_none());
    assert!(RelayRoute::Lan
        .context(RelayRoute::Lan.generation())
        .await
        .is_err());
    assert!(host_stream_hubs().await.is_empty());
    assert!(session_store::load_session_detailed().unwrap().is_none());
    assert!(
        db::AuthToken::find(&official.database, &official_session.token)
            .await
            .unwrap()
            .is_none()
    );
    assert!(db::AuthToken::find(&lan.database, &replacement_lan.token)
        .await
        .unwrap()
        .is_none());
    official.stop().await;
}
