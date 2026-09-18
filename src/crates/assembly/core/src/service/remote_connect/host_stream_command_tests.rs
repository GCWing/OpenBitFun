//! The host answers stream commands from its own memory; nothing here touches
//! a relay store, and retired relay-history commands get an explicit upgrade
//! message instead of an unknown-command failure.
use super::host_stream::{
    HostStreamNotifier, StreamReadRequest, HOST_CATALOG_ID, RELAY_SESSION_HISTORY_RETIRED_MESSAGE,
};
use super::remote_server::{RemoteCommand, RemoteResponse};
use super::{handle_host_stream_command, is_session_stream, start_host_stream_hub};
use std::sync::{Arc, Mutex};

struct Recorder(Mutex<Vec<(String, serde_json::Value)>>);
impl HostStreamNotifier for Recorder {
    fn notify(&self, target_device_id: &str, payload: serde_json::Value) {
        self.0
            .lock()
            .unwrap()
            .push((target_device_id.to_owned(), payload));
    }
}

fn read(stream_id: &str) -> RemoteCommand {
    RemoteCommand::ReadStream {
        request: StreamReadRequest {
            stream_id: stream_id.into(),
            subscribe: true,
            ..Default::default()
        },
    }
}

#[test]
fn stream_families_are_told_apart_by_id() {
    assert!(is_session_stream("session-1"));
    assert!(!is_session_stream(HOST_CATALOG_ID));
    assert!(!is_session_stream("terminal-abc"));
}

#[tokio::test]
async fn retired_relay_history_requests_get_an_upgrade_message() {
    let hub = start_host_stream_hub(Arc::new(Recorder(Mutex::new(Vec::new()))));
    let response = handle_host_stream_command(
        Some(&hub),
        "phone",
        &RemoteCommand::GetSessionKey {
            session_id: "s".into(),
        },
    )
    .await
    .expect("handled");
    assert_eq!(
        response,
        RemoteResponse::Error {
            message: RELAY_SESSION_HISTORY_RETIRED_MESSAGE.to_string()
        }
    );
    // Same answer when routing is offline: the message is about the protocol.
    let offline = handle_host_stream_command(
        None,
        "phone",
        &RemoteCommand::GetSessionKey {
            session_id: "s".into(),
        },
    )
    .await
    .expect("handled");
    assert_eq!(offline, response);
    hub.close();
}

#[tokio::test]
async fn non_stream_commands_are_left_to_the_regular_dispatcher() {
    let hub = start_host_stream_hub(Arc::new(Recorder(Mutex::new(Vec::new()))));
    assert!(
        handle_host_stream_command(Some(&hub), "phone", &RemoteCommand::Ping { client: None })
            .await
            .is_none()
    );
    hub.close();
}

#[tokio::test]
async fn catalog_reads_materialize_the_stream_and_later_appends_reach_the_reader() {
    let recorder = Arc::new(Recorder(Mutex::new(Vec::new())));
    let hub = start_host_stream_hub(recorder.clone());
    let page = match handle_host_stream_command(Some(&hub), "phone", &read(HOST_CATALOG_ID))
        .await
        .expect("handled")
    {
        RemoteResponse::StreamPage { page } => page,
        other => panic!("unexpected response: {other:?}"),
    };
    assert_eq!(page.stream_id, HOST_CATALOG_ID);
    assert!(page.events.is_empty());
    assert!(hub.is_active(HOST_CATALOG_ID));
    hub.append(
        HOST_CATALOG_ID.into(),
        "host-catalog-changed".into(),
        serde_json::json!({"sessionsRevision": 3}),
    )
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    // The runtime catalog bridge may publish its initial revisions as well;
    // every hint targets the one subscribed device and names the stream only.
    let hints = recorder.0.lock().unwrap().clone();
    assert!(!hints.is_empty());
    for (device, payload) in &hints {
        assert_eq!(device, "phone");
        assert_eq!(payload["stream_id"], HOST_CATALOG_ID);
        assert!(payload.get("events").is_none(), "hints never carry content");
    }
    let next = match handle_host_stream_command(
        Some(&hub),
        "phone",
        &RemoteCommand::ReadStream {
            request: StreamReadRequest {
                stream_id: HOST_CATALOG_ID.into(),
                after: Some(page.cursor),
                epoch: Some(page.epoch),
                subscribe: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("handled")
    {
        RemoteResponse::StreamPage { page } => page,
        other => panic!("unexpected response: {other:?}"),
    };
    assert!(next
        .events
        .iter()
        .any(|event| event.payload["sessionsRevision"] == 3));
    let unsubscribed = handle_host_stream_command(
        Some(&hub),
        "phone",
        &RemoteCommand::UnsubscribeStream {
            stream_id: HOST_CATALOG_ID.into(),
        },
    )
    .await
    .expect("handled");
    assert_eq!(
        unsubscribed,
        RemoteResponse::StreamUnsubscribed {
            stream_id: HOST_CATALOG_ID.into()
        }
    );
    assert_eq!(hub.subscriber_count(HOST_CATALOG_ID), 0);
    hub.close();
}

#[tokio::test]
async fn stream_reads_without_routing_are_rejected_loudly() {
    let response = handle_host_stream_command(None, "phone", &read("terminal-1"))
        .await
        .expect("handled");
    assert!(matches!(response, RemoteResponse::Error { .. }));
}

#[tokio::test]
async fn stopping_device_routing_closes_the_hub() {
    let hub = start_host_stream_hub(Arc::new(Recorder(Mutex::new(Vec::new()))));
    hub.activate("terminal-1");
    let mut closed = hub.subscribe_closed();
    hub.close();
    assert!(*closed.borrow_and_update());
    assert!(hub.active_stream_ids().is_empty());
}
