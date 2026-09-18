//! Relay records retain the runtime's persisted turn, round and item contracts.
//! Parent headers make a latest-page record independently interpretable, while
//! large text/tool bodies occur only on their own stable item record.
use anyhow::Result;
use openbitfun_services_core::session::DialogTurnData;
use serde_json::{json, Value};

use super::chat_projection::inline_host_path_pixels;

/// Transcript facts and interaction controls have different persistence roles.
/// Provider chunks are not durable messages; completed runtime blocks are read
/// from the canonical turn store. Approval controls retain their full payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEventPublication {
    pub synchronize_records: bool,
    pub persist_control: bool,
}

pub fn session_event_publication(name: &str, payload: &Value) -> SessionEventPublication {
    if name == "agentic://text-chunk" {
        return SessionEventPublication {
            synchronize_records: false,
            persist_control: false,
        };
    }
    if name == "agentic://tool-event" {
        let kind = payload["toolEvent"]["event_type"].as_str().unwrap_or("");
        return SessionEventPublication {
            synchronize_records: !matches!(
                kind,
                "EarlyDetected"
                    | "ParamsPartial"
                    | "Queued"
                    | "Waiting"
                    | "Progress"
                    | "Streaming"
                    | "StreamChunk"
            ),
            persist_control: matches!(
                kind,
                "ConfirmationNeeded" | "Confirmed" | "Rejected" | "Cancelled"
            ),
        };
    }
    SessionEventPublication {
        synchronize_records: true,
        persist_control: true,
    }
}

/// `read_image_pixels` resolves an attachment path against the host filesystem;
/// it is passed in because records are otherwise a pure transform over turns.
pub fn records_from_turns(
    turns: &[DialogTurnData],
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<Vec<Value>> {
    let mut records = Vec::new();
    for source in turns {
        let mut turn = serde_json::to_value(source)?;
        turn.as_object_mut()
            .expect("turn serializes as object")
            .remove("modelRounds");
        // The turn record is the one clients build the user message from, so the
        // pixels are inlined there alone; the parent headers below stay as they
        // were recorded rather than repeating an image once per item.
        let mut turn_record = turn.clone();
        inline_turn_attachment_pixels(&mut turn_record, read_image_pixels);
        records.push(json!({"sessionId":source.session_id,"id":format!("turn/{}",source.turn_id),"turn":turn_record}));
        for source_round in &source.model_rounds {
            let mut round = serde_json::to_value(source_round)?;
            let object = round.as_object_mut().expect("round serializes as object");
            for field in ["textItems", "thinkingItems", "toolItems"] {
                object.remove(field);
            }
            records.push(json!({"sessionId":source.session_id,"id":format!("round/{}",source_round.id),"turn":turn,"round":round}));
            for (kind, items) in [
                ("text", serde_json::to_value(&source_round.text_items)?),
                (
                    "thinking",
                    serde_json::to_value(&source_round.thinking_items)?,
                ),
                ("tool", serde_json::to_value(&source_round.tool_items)?),
            ] {
                for item in items.as_array().expect("items serialize as array") {
                    let id = item["id"].as_str().expect("persisted item has id");
                    records.push(json!({"sessionId":source.session_id,"id":format!("item/{id}"),"turn":turn,"round":round,"item":{"type":kind,"data":item}}));
                }
            }
        }
    }
    Ok(records)
}

/// An attachment recorded before pixels travelled inline holds a host path and
/// nothing else, and only this host can still resolve it. Clients read images
/// straight out of the recorded metadata, so the pixels join it there.
fn inline_turn_attachment_pixels(
    turn: &mut Value,
    read_image_pixels: &dyn Fn(&str) -> Option<Vec<u8>>,
) {
    let Some(images) = turn
        .pointer_mut("/userMessage/metadata/images")
        .and_then(|images| images.as_array_mut())
    else {
        return;
    };
    for image in images {
        let recorded_pixels = image
            .get("data_url")
            .and_then(|value| value.as_str())
            .is_some_and(|data_url| !data_url.is_empty());
        if recorded_pixels {
            continue;
        }
        let Some(data_url) = inline_host_path_pixels(image, read_image_pixels) else {
            continue;
        };
        if let Some(image) = image.as_object_mut() {
            image.insert("data_url".to_string(), Value::String(data_url));
        }
    }
}

#[cfg(test)]
mod publication_tests {
    use super::*;
    #[test]
    fn completed_tool_body_is_only_published_as_a_canonical_record() {
        for kind in ["Started", "Completed", "Failed"] {
            let policy = session_event_publication(
                "agentic://tool-event",
                &json!({"toolEvent":{"event_type":kind,"result":"large tool output"}}),
            );
            assert!(policy.synchronize_records);
            assert!(!policy.persist_control);
        }
        for kind in ["ParamsPartial", "StreamChunk", "Streaming"] {
            let policy = session_event_publication(
                "agentic://tool-event",
                &json!({"toolEvent":{"event_type":kind}}),
            );
            assert!(!policy.synchronize_records);
            assert!(!policy.persist_control);
        }
    }
    #[test]
    fn approvals_and_lifecycle_controls_are_retained() {
        for kind in ["ConfirmationNeeded", "Confirmed", "Rejected", "Cancelled"] {
            assert!(session_event_publication("agentic://tool-event",&json!({"toolEvent":{"event_type":kind,"params":{"question":"Review this input"}}})).persist_control);
        }
        assert!(
            session_event_publication("agentic://dialog-turn-completed", &json!({"turnId":"turn"}))
                .persist_control
        );
    }
}
