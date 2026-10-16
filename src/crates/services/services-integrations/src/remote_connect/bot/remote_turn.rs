//! Account-routed bot IO. The immutable target follows the submitted turn,
//! independently of later menu selection on the bot host.
use super::RemoteBotTarget;
use crate::remote_connect::{account::AccountClient, RemoteToolStatus};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

impl RemoteBotTarget {
    async fn rpc_response(&self, command: Value) -> Result<Value, String> {
        let reply = AccountClient::new()
            .device_rpc(
                &self.relay_url,
                &self.account,
                &self.device_id,
                &command.to_string(),
            )
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&reply).map_err(|e| e.to_string())
    }

    pub async fn start_question_interaction(&self, tool_id: &str) -> Result<(), String> {
        let info = self.rpc(json!({"cmd": "get_workspace_info"})).await?;
        if !info["capabilities"].as_array().is_some_and(|capabilities| {
            capabilities.iter().any(|value| {
                value.as_str()
                    == Some(crate::remote_connect::REMOTE_CAPABILITY_USER_QUESTION_INTERACTION_V1)
            })
        }) {
            return Err("Execution host does not support stopping the question timeout".into());
        }
        let reply = self.rpc(json!({"cmd": "start_question_interaction", "session_id": self.session_id, "tool_id": tool_id})).await?;
        if reply["resp"] != "interaction_accepted" {
            return Err("Execution host did not acknowledge question interaction".into());
        }
        Ok(())
    }

    pub async fn poll(&self, version: u64) -> Result<Value, String> {
        self.rpc_response(json!({"cmd":"poll_session","session_id":self.session_id,"since_version":version,"known_msg_count":0})).await
    }

    pub async fn rpc(&self, command: Value) -> Result<Value, String> {
        let reply = self.rpc_response(command).await?;
        if reply["resp"] == "error" {
            return Err(reply["message"]
                .as_str()
                .or(reply["error"].as_str())
                .unwrap_or("Remote command failed")
                .to_string());
        }
        Ok(reply)
    }

    pub async fn read_file(
        &self,
        path: &str,
        max_bytes: u64,
        is_current: &(dyn Fn() -> bool + Sync),
    ) -> Result<super::WorkspaceFileContent, String> {
        // Chunking keeps both base64 encodings below the encrypted relay body
        // limit. This command is also supported by older mobile-capable hosts.
        let mut transfer = FileTransfer::default();
        loop {
            if !is_current() {
                return Err("Bot identity changed during output delivery".into());
            }
            let chunk = self
                .rpc(json!({"cmd":"read_file_chunk","path":path,
                "session_id":self.session_id,"offset":transfer.bytes.len(),
                "limit":FILE_CHUNK_BYTES}))
                .await?;
            if !is_current() {
                return Err("Bot identity changed during output delivery".into());
            }
            if transfer.append(chunk, max_bytes)? {
                return Ok(super::WorkspaceFileContent {
                    mime_type: super::detect_mime_type(std::path::Path::new(&transfer.name)),
                    name: transfer.name,
                    size: transfer.bytes.len() as u64,
                    bytes: transfer.bytes,
                });
            }
        }
    }
}

const FILE_CHUNK_BYTES: u64 = 3 * 1024 * 1024;

#[derive(Default)]
struct FileTransfer {
    name: String,
    revision: String,
    total_size: Option<u64>,
    bytes: Vec<u8>,
}

impl FileTransfer {
    fn append(&mut self, chunk: Value, max_bytes: u64) -> Result<bool, String> {
        let size = chunk["total_size"]
            .as_u64()
            .ok_or("Invalid remote file size")?;
        let count = chunk["chunk_size"]
            .as_u64()
            .ok_or("Invalid remote chunk size")?;
        let name = chunk["name"].as_str().ok_or("Missing remote file name")?;
        let revision = chunk["revision"].as_str().unwrap_or_default();
        let offset = self.bytes.len() as u64;
        if chunk["resp"] != "file_chunk"
            || size > max_bytes
            || chunk["offset"].as_u64() != Some(offset)
            || count > FILE_CHUNK_BYTES
            || offset > size
            || count > size - offset
            || (count == 0 && offset < size)
        {
            return Err("Invalid, incomplete, or oversized remote file chunk".into());
        }
        if self.total_size.is_some_and(|total| total != size)
            || (self.total_size.is_some() && (self.name != name || self.revision != revision))
        {
            return Err(
                "Remote file changed during transfer; retry when generation finishes".into(),
            );
        }
        let encoded = chunk["chunk_base64"]
            .as_str()
            .ok_or("Missing remote file bytes")?;
        if encoded.len() as u64 > count.div_ceil(3) * 4 {
            return Err("Remote file payload exceeds limit".into());
        }
        let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        if bytes.len() as u64 != count {
            return Err("Remote file byte count mismatch".into());
        }
        self.name = name.into();
        self.revision = revision.into();
        self.total_size = Some(size);
        self.bytes.extend(bytes);
        Ok(self.bytes.len() as u64 == size)
    }
}

#[derive(Default, Debug)]
pub struct ObservedTurn {
    pub text: String,
    pub status: String,
    pub error: Option<String>,
    pub tools: Vec<RemoteToolStatus>,
    pub background_delivery: Option<openbitfun_core_types::background_delivery::BackgroundDelivery>,
}

impl ObservedTurn {
    pub fn terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            "done" | "completed" | "failed" | "cancelled" | "error"
        )
    }
}

/// Replay-safe projection, accepting the historical assistant ID when an older
/// peer omits turn_id. Never infer ownership from whichever turn is active now.
pub fn observe_turn(poll: &Value, turn_id: &str) -> Option<ObservedTurn> {
    let active = &poll["active_turn"];
    let message = poll["message_snapshot"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(poll["new_messages"].as_array().into_iter().flatten())
        .find(|m| {
            m["role"] == "assistant"
                && (m["turn_id"] == turn_id
                    || (m["turn_id"].is_null() && m["id"] == format!("{turn_id}_assistant")))
        });
    let source = if active["turn_id"] == turn_id {
        active
    } else {
        message?
    };
    Some(ObservedTurn {
        background_delivery:
            openbitfun_core_types::background_delivery::BackgroundDelivery::from_metadata(
                source.get("metadata"),
                turn_id,
            ),
        text: source["items"]
            .as_array()
            .filter(|items| !items.is_empty())
            .map(|items| {
                items
                    .iter()
                    .filter(|item| item["type"] == "text" && item["is_subagent"] != true)
                    .filter_map(|item| item["content"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_else(|| {
                source["text"]
                    .as_str()
                    .or(source["content"].as_str())
                    .unwrap_or_default()
                    .into()
            }),
        status: source["status"].as_str().unwrap_or_default().into(),
        error: source["error"].as_str().map(str::to_string),
        tools: serde_json::from_value(source["tools"].clone()).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_binds_to_our_turn_even_after_next_turn_started() {
        let poll = json!({"active_turn":{"turn_id":"next","text":"other","status":"running"},
            "message_snapshot":[{"id":"ours_assistant","role":"assistant","content":"[report](report.pdf)","status":"done"}]});
        let result = observe_turn(&poll, "ours").unwrap();
        assert!(result.terminal());
        assert_eq!(result.text, "[report](report.pdf)");
        assert!(observe_turn(&poll, "unrelated").is_none());
        let conflict = json!({"new_messages":[{"id":"ours_assistant","turn_id":"other","role":"assistant","status":"done"}]});
        assert!(observe_turn(&conflict, "ours").is_none());
    }
    #[test]
    fn structured_turn_items_preserve_output_without_thinking_or_subagents() {
        let poll = json!({"active_turn":{"turn_id":"ours","status":"completed","text":"",
            "items":[{"type":"thinking","content":"private reasoning"},
                {"type":"text","content":"![image](result.png)"},
                {"type":"text","content":"other","is_subagent":true},
                {"type":"text","content":"[report](report.pdf)"}]}});
        let observed = observe_turn(&poll, "ours").unwrap();
        assert!(observed.terminal());
        assert_eq!(
            observed.text,
            "![image](result.png)\n\n[report](report.pdf)"
        );
    }
    #[test]
    fn chunks_preserve_binary_bytes_and_legacy_payloads() {
        let first = json!({"resp":"file_chunk","name":"图.png","total_size":4,
            "offset":0,"chunk_size":3,"chunk_base64":"AP8B"});
        let last = json!({"resp":"file_chunk","name":"图.png","total_size":4,
            "offset":3,"chunk_size":1,"chunk_base64":"Ag=="});
        let mut transfer = FileTransfer::default();
        assert!(!transfer.append(first.clone(), 4).unwrap());
        assert!(transfer.append(last.clone(), 4).unwrap());
        assert_eq!(transfer.bytes, vec![0, 255, 1, 2]);
        assert!(FileTransfer::default().append(first.clone(), 2).is_err());
        assert!(FileTransfer::default().append(last, 4).is_err());
        let mut invalid = first;
        invalid["chunk_size"] = json!(2);
        assert!(FileTransfer::default().append(invalid, 4).is_err());
    }

    #[test]
    fn chunks_reject_same_size_revision_changes_and_stalled_transfers() {
        let mut first = json!({"resp":"file_chunk","name":"a.png","total_size":2,
            "offset":0,"chunk_size":1,"chunk_base64":"AQ==","revision":"2:1"});
        let mut transfer = FileTransfer::default();
        assert!(!transfer.append(first.clone(), 2).unwrap());
        first["offset"] = json!(1);
        first["revision"] = json!("2:2");
        assert!(transfer.append(first.clone(), 2).is_err());
        first["revision"] = json!("2:1");
        first["chunk_size"] = json!(0);
        first["chunk_base64"] = json!("");
        assert!(transfer.append(first, 2).is_err());
    }
}
