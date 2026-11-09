use super::embedded_relay_host::EmbeddedRelayHost;
use super::{ConnectionMethod, RemoteConnectConfig, RemoteConnectService};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Default)]
struct RecordingEmbeddedRelayHost {
    start_calls: AtomicUsize,
    stop_calls: AtomicUsize,
    cleanup_stops: AtomicUsize,
    active: AtomicBool,
}

#[derive(Default)]
struct BlockingEmbeddedRelayHost {
    start_calls: AtomicUsize,
    starts_in_flight: AtomicUsize,
    overlapping_starts: AtomicUsize,
    stop_while_starting: AtomicUsize,
    active: AtomicBool,
    first_start_entered: tokio::sync::Notify,
    release_first_start: tokio::sync::Notify,
    stop_called: tokio::sync::Notify,
    lifecycle_violation: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl EmbeddedRelayHost for RecordingEmbeddedRelayHost {
    async fn start(&self, _port: u16, _static_dir: Option<String>) -> anyhow::Result<()> {
        self.start_calls.fetch_add(1, Ordering::SeqCst);
        self.active.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn stop(&self) {
        self.stop_calls.fetch_add(1, Ordering::SeqCst);
        if self.active.swap(false, Ordering::SeqCst) {
            self.cleanup_stops.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[async_trait::async_trait]
impl EmbeddedRelayHost for BlockingEmbeddedRelayHost {
    async fn start(&self, _port: u16, _static_dir: Option<String>) -> anyhow::Result<()> {
        let call_index = self.start_calls.fetch_add(1, Ordering::SeqCst);
        if self.starts_in_flight.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlapping_starts.fetch_add(1, Ordering::SeqCst);
            self.lifecycle_violation.notify_one();
        }

        if call_index == 0 {
            self.first_start_entered.notify_one();
            self.release_first_start.notified().await;
        }

        self.active.store(true, Ordering::SeqCst);
        self.starts_in_flight.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }

    async fn stop(&self) {
        if self.starts_in_flight.load(Ordering::SeqCst) > 0 {
            self.stop_while_starting.fetch_add(1, Ordering::SeqCst);
            self.lifecycle_violation.notify_one();
        }
        self.active.store(false, Ordering::SeqCst);
        self.stop_called.notify_one();
    }
}

async fn unused_port() -> u16 {
    let reserved = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test should reserve an unused port");
    reserved
        .local_addr()
        .expect("reserved listener should have an address")
        .port()
}

fn lan_config(port: u16) -> RemoteConnectConfig {
    RemoteConnectConfig {
        lan_port: port,
        ..RemoteConnectConfig::default()
    }
}

fn lan_method() -> ConnectionMethod {
    ConnectionMethod::Lan {
        ip: Some("127.0.0.1".to_string()),
    }
}

#[tokio::test]
async fn remote_connect_stop_delegates_concrete_cleanup_to_host() {
    let host = Arc::new(RecordingEmbeddedRelayHost::default());
    let service = RemoteConnectService::new(RemoteConnectConfig::default(), host.clone())
        .expect("remote connect service should initialize");

    service.stop_relay().await;
    service.stop_relay().await;

    assert_eq!(host.stop_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn preparation_starts_a_local_host_but_never_grants_unauthenticated_control() {
    let port = unused_port().await;
    let host = Arc::new(RecordingEmbeddedRelayHost::default());
    let service = RemoteConnectService::new(lan_config(port), host.clone()).unwrap();
    assert_eq!(
        service.prepare_relay(&lan_method()).await.unwrap(),
        format!("http://127.0.0.1:{port}")
    );
    assert!(service
        .start(lan_method())
        .await
        .unwrap_err()
        .to_string()
        .contains("Sign in with GitHub"));
    assert_eq!(host.start_calls.load(Ordering::SeqCst), 1);
    assert!(host.active.load(Ordering::SeqCst));
    service.stop_relay().await;
    assert_eq!(host.cleanup_stops.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_relay_starts_do_not_cleanup_or_enter_the_host_concurrently() {
    let host = Arc::new(BlockingEmbeddedRelayHost::default());
    let service = Arc::new(
        RemoteConnectService::new(lan_config(unused_port().await), host.clone())
            .expect("remote connect service should initialize"),
    );

    let first = tokio::spawn({
        let service = service.clone();
        async move { service.prepare_relay(&lan_method()).await }
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        host.first_start_entered.notified(),
    )
    .await
    .expect("first start should enter the host");

    let second = tokio::spawn({
        let service = service.clone();
        async move { service.prepare_relay(&lan_method()).await }
    });
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            host.lifecycle_violation.notified(),
        )
        .await
        .is_err(),
        "a concurrent start must wait instead of stopping or entering the active host start"
    );

    host.release_first_start.notify_one();
    let (first_result, second_result) =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(first, second)
        })
        .await
        .expect("serialized starts should complete");
    first_result
        .expect("first start task should join")
        .expect("endpoint preparation should succeed");
    second_result
        .expect("second start task should join")
        .expect("endpoint preparation should succeed");

    assert_eq!(host.start_calls.load(Ordering::SeqCst), 1);
    assert_eq!(host.overlapping_starts.load(Ordering::SeqCst), 0);
    assert_eq!(host.stop_while_starting.load(Ordering::SeqCst), 0);
    assert!(host.active.load(Ordering::SeqCst));
}

#[tokio::test]
async fn relay_stop_waits_for_an_in_progress_start_to_settle() {
    let host = Arc::new(BlockingEmbeddedRelayHost::default());
    let service = Arc::new(
        RemoteConnectService::new(lan_config(unused_port().await), host.clone())
            .expect("remote connect service should initialize"),
    );

    let start = tokio::spawn({
        let service = service.clone();
        async move { service.prepare_relay(&lan_method()).await }
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        host.first_start_entered.notified(),
    )
    .await
    .expect("start should enter the host");
    host.stop_called.notified().await;

    let stop = tokio::spawn({
        let service = service.clone();
        async move { service.stop_relay().await }
    });
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            host.stop_called.notified(),
        )
        .await
        .is_err(),
        "stop must wait behind the in-progress start lifecycle"
    );

    host.release_first_start.notify_one();
    let (start_result, stop_result) =
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(start, stop)
        })
        .await
        .expect("start and stop should complete after release");
    start_result
        .expect("start task should join")
        .expect("endpoint preparation should succeed");
    stop_result.expect("stop task should join");

    assert_eq!(host.stop_while_starting.load(Ordering::SeqCst), 0);
    assert!(!host.active.load(Ordering::SeqCst));
}

#[tokio::test]
async fn official_invitation_requires_device_auth_without_starting_an_anonymous_room() {
    let host = Arc::new(RecordingEmbeddedRelayHost::default());
    let service = RemoteConnectService::new(RemoteConnectConfig::default(), host.clone()).unwrap();
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        service.start(ConnectionMethod::OpenBitFunServer),
    )
    .await
    .expect("must fail immediately without waiting for RoomCreated")
    .unwrap_err();
    assert!(error.to_string().contains("Sign in with GitHub"));
    assert_eq!(host.start_calls.load(Ordering::SeqCst), 0);
    assert_eq!(host.stop_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn official_and_lan_invitations_use_the_same_authenticated_device_protocol() {
    for method in [ConnectionMethod::OpenBitFunServer, lan_method()] {
        let host = Arc::new(RecordingEmbeddedRelayHost::default());
        let service = RemoteConnectService::new(lan_config(9700), host.clone()).unwrap();
        let url = service.prepare_relay(&method).await.unwrap();
        *service.authenticated_device_id.write().await = Some("authenticated-host-1".into());
        *service.device_relay_url.write().await = Some(url.clone());
        let result = service.start(method.clone()).await.unwrap();
        assert_eq!(
            result.qr_url,
            Some(openbitfun_product_domains::account::relay_page_url(
                &url,
                "#/pair?did=authenticated-host-1"
            ))
        );
        assert!(result
            .qr_data
            .as_ref()
            .is_some_and(|value| !value.is_empty()));
        assert_eq!(
            host.start_calls.load(Ordering::SeqCst),
            usize::from(matches!(method, ConnectionMethod::Lan { .. }))
        );
        service.stop_device_connection().await;
        assert!(service.start(method).await.is_err());
    }
}

#[tokio::test]
async fn restored_base_endpoint_keeps_the_announced_version_in_the_invitation() {
    let host = Arc::new(RecordingEmbeddedRelayHost::default());
    let service = RemoteConnectService::new(RemoteConnectConfig::default(), host).unwrap();
    let prepared = service
        .prepare_relay(&ConnectionMethod::OpenBitFunServer)
        .await
        .unwrap();
    assert!(prepared.contains("?v="));
    *service.authenticated_device_id.write().await = Some("restored-host".into());
    *service.device_relay_url.write().await =
        Some(openbitfun_product_domains::account::relay_endpoint_base(&prepared).to_string());
    let result = service
        .start(ConnectionMethod::OpenBitFunServer)
        .await
        .unwrap();
    assert_eq!(
        result.qr_url,
        Some(openbitfun_product_domains::account::relay_page_url(
            &prepared,
            "#/pair?did=restored-host"
        ))
    );
}

#[tokio::test]
async fn switching_endpoint_invalidates_the_previous_invitation() {
    let host = Arc::new(RecordingEmbeddedRelayHost::default());
    let service = RemoteConnectService::new(lan_config(9700), host.clone()).unwrap();
    let local = service.prepare_relay(&lan_method()).await.unwrap();
    *service.authenticated_device_id.write().await = Some("device-1".into());
    *service.device_relay_url.write().await = Some(local);
    assert!(service.start(lan_method()).await.is_ok());
    service
        .prepare_relay(&ConnectionMethod::OpenBitFunServer)
        .await
        .unwrap();
    assert!(service.start(lan_method()).await.is_err());
    assert!(service
        .start(ConnectionMethod::OpenBitFunServer)
        .await
        .is_err());
    assert!(!host.active.load(Ordering::SeqCst));
}

#[tokio::test]
async fn every_bot_provider_requires_an_active_github_account() {
    let service = RemoteConnectService::new(
        RemoteConnectConfig::default(),
        Arc::new(RecordingEmbeddedRelayHost::default()),
    )
    .unwrap();
    for method in [
        ConnectionMethod::BotFeishu,
        ConnectionMethod::BotTelegram,
        ConnectionMethod::BotWeixin,
    ] {
        let error = service.start(method).await.unwrap_err();
        assert!(error.to_string().contains("Sign in with GitHub"));
    }
    service.set_bot_account(Some("account-a".into())).await;
    let epoch = service.bot_account_identity_epoch.load(Ordering::SeqCst);
    service.set_bot_account(Some("account-a".into())).await;
    assert_eq!(
        service.bot_account_identity_epoch.load(Ordering::SeqCst),
        epoch
    );
    service.set_bot_account(None).await;
    assert!(service.bot_account_identity_epoch.load(Ordering::SeqCst) > epoch);
    assert!(service
        .start(ConnectionMethod::BotTelegram)
        .await
        .unwrap_err()
        .to_string()
        .contains("Sign in with GitHub"));
}
