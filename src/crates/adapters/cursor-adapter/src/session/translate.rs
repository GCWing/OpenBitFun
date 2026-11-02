use super::*;
use serde_json::json;
use std::collections::{BTreeSet, HashMap};

pub(super) struct Builder {
    candidate: ExternalSessionCandidate,
    turns: Vec<ExternalSessionTurn>,
    tools: HashMap<String, (usize, usize)>,
    warnings: BTreeMap<String, String>,
    bytes: usize,
}

impl Builder {
    pub(super) fn new(candidate: ExternalSessionCandidate) -> Self {
        Self {
            candidate,
            turns: Vec::new(),
            tools: HashMap::new(),
            warnings: BTreeMap::new(),
            bytes: 0,
        }
    }

    pub(super) fn warn(&mut self, code: &str, detail: &str) {
        self.warnings
            .entry(code.into())
            .or_insert_with(|| detail.into());
    }
    pub(super) fn model(&mut self, model: &str) {
        if self.candidate.model_name.is_none() {
            self.candidate.model_name = Some(model.into());
        }
    }

    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > MAX_DOCUMENT_BYTES {
            return Err("Converted Cursor history exceeds the import limit".into());
        }
        Ok(())
    }

    pub(super) fn start(
        &mut self,
        id: String,
        text: String,
        time: Option<u64>,
    ) -> Result<(), String> {
        if self.turns.len() >= 4096 {
            return Err("Cursor history exceeds the 4096 turn import limit".into());
        }
        self.charge(text.len())?;
        if self.candidate.title.is_none() {
            self.candidate.title = Some(text.chars().take(120).collect());
            self.candidate.fallback_title = self.candidate.title.clone();
        }
        self.turns.push(ExternalSessionTurn {
            source_turn_id: id,
            timestamp: time.or(self.candidate.created_at).unwrap_or(0),
            user_text: text,
            items: Vec::new(),
            source_event_count: 1,
            status: ExternalSessionStatus::Interrupted,
        });
        Ok(())
    }

    pub(super) fn item(&mut self, item: ExternalSessionItem) -> Result<(), String> {
        if self.turns.is_empty() {
            self.warn(
                "context_without_user",
                "Cursor context before the first human message was omitted",
            );
            return Ok(());
        }
        self.charge(serde_json::to_vec(&item).map_err(|e| e.to_string())?.len())?;
        let turn_index = self.turns.len() - 1;
        if let ExternalSessionItem::Tool { id, .. } = &item {
            if self.tools.contains_key(id) {
                return Err(
                    "Duplicate Cursor tool call identity; no partial import was created".into(),
                );
            }
            self.tools
                .insert(id.clone(), (turn_index, self.turns[turn_index].items.len()));
        }
        let turn = &mut self.turns[turn_index];
        turn.source_event_count += 1;
        turn.items.push(item);
        Ok(())
    }

    pub(super) fn status(&mut self, status: ExternalSessionStatus) {
        if let Some(turn) = self.turns.last_mut() {
            turn.status = status;
        }
    }

    fn result(&mut self, block: &Value, record: &Value) -> Result<(), String> {
        let id = string(block, &["toolCallId", "tool_use_id", "tool_call_id", "id"]);
        let raw = block
            .get("result")
            .or_else(|| block.get("content"))
            .or_else(|| block.get("output"))
            .or_else(|| block.get("tool_result"));
        let Some(raw) = raw else {
            self.warn(
                "tool_result_missing",
                "A Cursor tool result has no readable result body",
            );
            return Ok(());
        };
        let result = display_value(raw, 0)?;
        self.charge(
            serde_json::to_vec(&result)
                .map_err(|e| e.to_string())?
                .len(),
        )?;
        let error = block
            .get("isError")
            .or_else(|| block.get("is_error"))
            .and_then(Value::as_bool)
            .or_else(|| {
                record
                    .pointer("/providerOptions/cursor/highLevelToolCallResult/isError")
                    .and_then(Value::as_bool)
            })
            .or_else(|| {
                block
                    .pointer("/output/type")
                    .and_then(Value::as_str)
                    .filter(|s| s.starts_with("error-"))
                    .map(|_| true)
            });
        if let Some(&(turn, item)) = self.tools.get(id) {
            if let ExternalSessionItem::Tool {
                result: stored,
                success,
                ..
            } = &mut self.turns[turn].items[item]
            {
                if stored.is_some() {
                    return Err(
                        "Duplicate Cursor tool result identity; no partial import was created"
                            .into(),
                    );
                }
                *stored = Some(result);
                *success = Some(!error.unwrap_or(false));
            }
        } else {
            self.warn(
                "tool_call_missing",
                "A Cursor tool result has no matching call; its result was retained",
            );
            let name = string(block, &["toolName", "tool_name", "name"]);
            self.item(ExternalSessionItem::Tool {
                id: if id.is_empty() {
                    format!("orphan-{}-{}", self.turns.len(), self.bytes)
                } else {
                    id.into()
                },
                name: if name.is_empty() {
                    "CursorTool".into()
                } else {
                    name.into()
                },
                input: Value::Null,
                result: Some(result),
                success: error.map(|error| !error),
            })?;
        }
        Ok(())
    }

    pub(super) fn message(&mut self, record: &Value, fallback_id: &str) -> Result<(), String> {
        if record["type"] == "metadata" {
            return Ok(());
        }
        if record["type"] == "turn_ended" {
            self.status(if record["status"] == "success" {
                ExternalSessionStatus::Complete
            } else {
                ExternalSessionStatus::Interrupted
            });
            if let Some(error) = record["error"].as_str() {
                self.warn("source_turn_error", error);
            }
            return Ok(());
        }
        let role = record["role"]
            .as_str()
            .ok_or("Unsupported Cursor message without a role")?;
        if role == "system"
            || record.pointer("/providerOptions/cursor/isSummary") == Some(&Value::Bool(true))
        {
            return Ok(());
        }
        if record
            .pointer("/providerOptions/cursor/requestContextCompleteness")
            .is_some()
            || record["isSimulatedMsg"] == true
            || record["is_simulated_msg"] == true
        {
            self.warn(
                "injected_context",
                "Cursor runtime context messages were excluded from human conversation turns",
            );
            return Ok(());
        }
        if !matches!(role, "user" | "assistant" | "tool") {
            return Err(format!("Unsupported Cursor message role: {role}"));
        }
        let body = record.get("message").unwrap_or(record);
        let content = body.get("content").or_else(|| body.get("text"));
        let text = message_text(record).unwrap_or_default();
        if role == "user" {
            let text = user_text(record).unwrap_or_default();
            if !text.is_empty() {
                let id = record
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        record
                            .pointer("/providerOptions/cursor/requestId")
                            .and_then(Value::as_str)
                    })
                    .unwrap_or(fallback_id);
                self.start(
                    id.into(),
                    text,
                    timestamp(&record["createdAt"]).or_else(|| timestamp(&record["timestamp"])),
                )?;
            }
        } else if role == "assistant" && !text.is_empty() && !content.is_some_and(Value::is_array) {
            self.item(ExternalSessionItem::Text { text })?;
            self.status(ExternalSessionStatus::Complete);
        }
        if let Some(thinking) = record["thinking"].as_str().filter(|s| !s.is_empty()) {
            self.item(ExternalSessionItem::Thinking {
                text: thinking.into(),
            })?;
        }
        if let Some(blocks) = content.and_then(Value::as_array) {
            for (index, block) in blocks.iter().enumerate() {
                match block["type"].as_str().unwrap_or("") {
                    "text" if role == "assistant" => {
                        if let Some(text) = block["text"].as_str().filter(|s| !s.is_empty()) {
                            self.item(ExternalSessionItem::Text { text: text.into() })?;
                            self.status(ExternalSessionStatus::Complete);
                        }
                    }
                    "image" | "file" if role == "assistant" => {
                        self.item(ExternalSessionItem::Text {
                            text: "[Attachment omitted]".into(),
                        })?;
                    }
                    "text" | "image" | "file" => {}
                    "reasoning" | "thinking" | "redacted-reasoning" => {
                        let text = string(block, &["text", "thinking"]);
                        self.item(ExternalSessionItem::Thinking {
                            text: if text.is_empty() {
                                "[Redacted reasoning]".into()
                            } else {
                                text.into()
                            },
                        })?;
                    }
                    "tool-call" | "tool_use" => {
                        let id = string(block, &["toolCallId", "id", "tool_call_id"]);
                        let name = string(block, &["toolName", "name", "tool_name"]);
                        if name.is_empty() {
                            return Err("Cursor tool call is missing its name".into());
                        }
                        self.item(ExternalSessionItem::Tool {
                            id: if id.is_empty() {
                                format!("{fallback_id}-tool-{index}")
                            } else {
                                id.into()
                            },
                            name: name.into(),
                            input: block
                                .get("args")
                                .or_else(|| block.get("input"))
                                .cloned()
                                .unwrap_or(Value::Null),
                            result: None,
                            success: None,
                        })?;
                    }
                    "tool-result" | "tool_result" => self.result(block, record)?,
                    other => self.warn(
                        "unsupported_content",
                        &format!("Cursor content block {other} was not rendered"),
                    ),
                }
            }
        }
        // Older structured exports use a flat tool_calls / role:tool shape.
        if let Some(calls) = record["tool_calls"].as_array() {
            for (index, call) in calls.iter().enumerate() {
                let name = string(call, &["tool_name", "name"]);
                if name.is_empty() {
                    return Err("Cursor tool call is missing its name".into());
                }
                self.item(ExternalSessionItem::Tool {
                    id: call["tool_call_id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{fallback_id}-tool-{index}")),
                    name: name.into(),
                    input: call.get("tool_args").cloned().unwrap_or(Value::Null),
                    result: None,
                    success: None,
                })?;
            }
        }
        if role == "tool" && record.get("tool_result").is_some() {
            self.result(record, record)?;
        }
        Ok(())
    }

    pub(super) fn finish(mut self, fingerprint: &[u8]) -> Result<ExternalSessionDocument, String> {
        if self.turns.is_empty() {
            return Err("Cursor history contains no readable human conversation turns".into());
        }
        let mut identities = BTreeSet::new();
        for turn in &mut self.turns {
            if !identities.insert(turn.source_turn_id.clone()) {
                return Err("Duplicate Cursor turn identity; no partial import was created".into());
            }
            if turn
                .items
                .iter()
                .any(|item| matches!(item, ExternalSessionItem::Tool { result: None, .. }))
            {
                turn.status = ExternalSessionStatus::Interrupted;
                self.warnings
                    .entry("tool_result_missing".into())
                    .or_insert_with(|| {
                        "Some Cursor calls have no stored result; they remain interrupted".into()
                    });
            }
        }
        if self.candidate.cwd.is_none() {
            self.warn("workspace_unresolved", "Cursor did not retain an unambiguous local workspace path; no local path was guessed");
        }
        self.candidate.turn_count = Some(self.turns.len());
        self.candidate.status = self
            .turns
            .last()
            .map(|turn| turn.status)
            .unwrap_or(ExternalSessionStatus::Interrupted);
        self.candidate.fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(fingerprint)));
        Ok(ExternalSessionDocument {
            candidate: self.candidate,
            turns: self.turns,
            warnings: self
                .warnings
                .into_iter()
                .map(|(code, detail)| ExternalSessionImportWarning { code, detail })
                .collect(),
        })
    }
}

fn string<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .find_map(|key| value[*key].as_str())
        .unwrap_or("")
}

pub(super) fn user_text(record: &Value) -> Option<String> {
    let text = message_text(record)?;
    // Only native messages carrying a request ID use Cursor's prompt wrapper.
    if record
        .pointer("/providerOptions/cursor/requestId")
        .is_some()
    {
        if let (Some(start), Some(end)) = (text.find("<user_query>"), text.rfind("</user_query>")) {
            if start < end {
                return Some(text[start + "<user_query>".len()..end].trim().into());
            }
        }
    }
    Some(text)
}

pub(super) fn message_text(record: &Value) -> Option<String> {
    let body = record.get("message").unwrap_or(record);
    let content = body.get("content").or_else(|| body.get("text"))?;
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.into());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(|block| match block["type"].as_str() {
            Some("text") => block["text"].as_str().map(str::to_owned),
            Some("image") => Some("[Image attachment omitted]".into()),
            Some("file") => Some("[File attachment omitted]".into()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn display_value(value: &Value, depth: usize) -> Result<Value, String> {
    if depth > 64 {
        return Err("Cursor tool result exceeds the nesting limit".into());
    }
    if value["__type"] == "Uint8Array"
        || matches!(value["type"].as_str(), Some("image" | "image_url" | "file"))
    {
        return Ok(json!("[Binary attachment omitted]"));
    }
    match value {
        Value::Array(values) => values
            .iter()
            .map(|v| display_value(v, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(values) => values
            .iter()
            .map(|(k, v)| Ok((k.clone(), display_value(v, depth + 1)?)))
            .collect::<Result<serde_json::Map<_, _>, String>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}
