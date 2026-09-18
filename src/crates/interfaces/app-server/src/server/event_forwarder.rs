use crate::agent::OpenBitFunAppRuntime;
use crate::management::AppManagementService;
use crate::role::AppClient;
use crate::schema::{
    ConfigEventNotification, EventStream, EventStreamState, EventStreamStateNotification,
    PermissionEventNotification, ResyncDirective, SessionEventNotification,
};
use agent_client_protocol::{ConnectionTo, Result};
use openbitfun_agent_runtime::sdk::PermissionRequestEvent;
use openbitfun_app_server_protocol::external_source::ExternalSourceEventNotification;
use std::sync::Arc;

pub(super) async fn run(
    runtime: Arc<OpenBitFunAppRuntime>,
    management: Option<Arc<AppManagementService>>,
    cx: ConnectionTo<AppClient>,
    event_state: Arc<crate::server::ConnectionEventState>,
    disconnect: Option<Arc<crate::server::host_policy::AppServerDisconnect>>,
) -> Result<()> {
    let mut rx = runtime.event_source().subscribe();
    let mut permission_rx = runtime.runtime().subscribe_permission_requests().ok();
    let mut config_rx = openbitfun_core::service::config::subscribe_config_updates();
    let mut external_source_rx = management
        .as_ref()
        .map(|management| management.subscribe_external_source_updates());
    loop {
        let permission_recv = async {
            match &mut permission_rx {
                Some(receiver) => Some(receiver.recv().await),
                None => {
                    std::future::pending::<
                        Option<
                            Result<
                                PermissionRequestEvent,
                                tokio::sync::broadcast::error::RecvError,
                            >,
                        >,
                    >()
                    .await
                }
            }
        };
        let config_recv = async {
            match &mut config_rx {
                Some(receiver) => Some(receiver.recv().await),
                None => {
                    std::future::pending::<
                        Option<
                            Result<
                                openbitfun_core::service::config::ConfigUpdateEvent,
                                tokio::sync::broadcast::error::RecvError,
                            >,
                        >,
                    >()
                    .await
                }
            }
        };
        let external_source_recv = async {
            match &mut external_source_rx {
                Some(receiver) => Some(receiver.recv().await),
                None => {
                    std::future::pending::<Option<Result<
                        (String, openbitfun_product_domains::external_sources::ExternalSourcePublicSnapshot),
                        tokio::sync::broadcast::error::RecvError,
                    >>>()
                    .await
                }
            }
        };
        tokio::select! {
            _ = async {
                match &disconnect {
                    Some(disconnect) => disconnect.wait().await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                log::info!(
                    "App-server connection closed -- stopping event forwarding so the Host can run its disconnect lifecycle"
                );
                break;
            }
            recv = rx.recv() => match recv {
                Ok(envelope) => {
                    let notification = SessionEventNotification {
                        cursor: event_state.next_cursor(EventStream::Agent),
                        event: envelope,
                    };
                    if let Err(error) = cx.send_notification(notification) {
                        log::warn!("App-server agent event forwarder failed to send a notification: {:?} -- skipping this event", error);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    send_stream_state(&cx, &event_state, EventStream::Agent, EventStreamState::Lagged, Some(missed), "session/sync", false);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    send_stream_state(&cx, &event_state, EventStream::Agent, EventStreamState::Closed, None, "session/sync", false);
                    log::warn!("App-server agent event stream closed -- serve main loop exiting (client RPCs will now fail with 'receiver is gone')");
                    break;
                }
            },
            recv = permission_recv => match recv {
                Some(Ok(event)) => {
                    let notification = PermissionEventNotification {
                        cursor: event_state.next_cursor(EventStream::Permission),
                        event,
                    };
                    if let Err(error) = cx.send_notification(notification) {
                        log::warn!("App-server permission event forwarder failed to send a notification: {:?} -- skipping this event", error);
                    }
                }
                Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(missed))) => {
                    send_stream_state(&cx, &event_state, EventStream::Permission, EventStreamState::Lagged, Some(missed), "app/syncEvents", true);
                }
                Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    send_stream_state(&cx, &event_state, EventStream::Permission, EventStreamState::Closed, None, "app/syncEvents", true);
                    permission_rx = None;
                }
                None => {}
            },
            recv = config_recv => match recv {
                Some(Ok(event)) => {
                    if let Err(error) = cx.send_notification(ConfigEventNotification {
                        cursor: event_state.next_cursor(EventStream::Config),
                        event: crate::server::wire::config_update(event),
                    }) {
                        log::warn!("App-server config event forwarder failed to send a notification: {:?} -- skipping this event", error);
                    }
                },
                Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(missed))) => {
                    send_stream_state(&cx, &event_state, EventStream::Config, EventStreamState::Lagged, Some(missed), "app/syncEvents", false);
                }
                Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    send_stream_state(&cx, &event_state, EventStream::Config, EventStreamState::Closed, None, "app/syncEvents", false);
                    config_rx = None;
                }
                None => {}
            },
            recv = external_source_recv => match recv {
                Some(Ok((workspace_id, snapshot))) => {
                    let workspace_path = match openbitfun_core::service::workspace::get_global_workspace_service() {
                        Some(service) => service.require_workspace(&workspace_id).await.ok()
                            .map(|record| record.root_path.to_string_lossy().into_owned()).unwrap_or_default(),
                        None => String::new(),
                    };
                    if let Err(error) = cx.send_notification(ExternalSourceEventNotification {
                        cursor: event_state.next_cursor(EventStream::ExternalSource),
                        workspace_id: Some(workspace_id),
                        workspace_path,
                        snapshot,
                    }) {
                        log::warn!("App-server external source event forwarder failed to send a notification: {:?} -- skipping this event", error);
                    }
                }
                Some(Err(tokio::sync::broadcast::error::RecvError::Lagged(missed))) => {
                    send_stream_state(&cx, &event_state, EventStream::ExternalSource, EventStreamState::Lagged, Some(missed), "externalSource/snapshot", true);
                }
                Some(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    send_stream_state(&cx, &event_state, EventStream::ExternalSource, EventStreamState::Closed, None, "externalSource/snapshot", true);
                    external_source_rx = None;
                }
                None => {}
            }
        }
    }
    Ok(())
}

fn send_stream_state(
    cx: &ConnectionTo<AppClient>,
    event_state: &crate::server::ConnectionEventState,
    stream: EventStream,
    state: EventStreamState,
    missed: Option<u64>,
    method: &str,
    snapshot_available: bool,
) {
    let notification = EventStreamStateNotification {
        cursor: event_state.cursor(stream),
        stream,
        state,
        missed,
        resync: ResyncDirective {
            method: method.to_string(),
            snapshot_available,
            reason: Some("The authoritative event stream is no longer contiguous".to_string()),
        },
    };
    if let Err(error) = cx.send_notification(notification) {
        log::warn!(
            "App-server event stream state notification failed: {:?}",
            error
        );
    }
}
