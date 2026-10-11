use log::{error, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCallBoundary {
    NewTool,
    FinishReason,
    StreamEnd,
    GracefulShutdown,
    EndOfAggregation,
}

/// Provider-neutral classification of how a streamed model response ended.
///
/// The classification is deliberately conservative: only `NormalToolUse`
/// permits the opt-in, non-Write JSON repair path. A parser EOF alone does not
/// prove the response reached a normal model completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallCompletion {
    NormalToolUse,
    NormalNoToolUse,
    OutputLimit,
    ContentFiltered,
    Failed,
    Interrupted,
    #[default]
    Unknown,
}

impl ToolCallCompletion {
    pub fn permits_normal_tool_json_repair(self) -> bool {
        matches!(self, Self::NormalToolUse)
    }
}

/// How invalid raw tool arguments were repaired before schema validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolArgumentRepairKind {
    #[default]
    None,
    /// The Write-specific close-only repair preserved a completed payload prefix.
    WriteTailClosure,
    /// The user explicitly enabled best-effort repair after a normal tool-use
    /// completion. This must never be presented as a max-token truncation.
    PermissiveNormalToolJsonRepair,
}

impl ToolArgumentRepairKind {
    pub fn is_none(value: &Self) -> bool {
        matches!(value, Self::None)
    }

    pub fn is_write_tail_closure(self) -> bool {
        matches!(self, Self::WriteTailClosure)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ToolCallFinalizeOptions {
    pub completion: ToolCallCompletion,
    pub allow_normal_tool_json_repair: bool,
}

impl ToolCallBoundary {
    fn as_str(self) -> &'static str {
        match self {
            Self::NewTool => "new_tool",
            Self::FinishReason => "finish_reason",
            Self::StreamEnd => "stream_end",
            Self::GracefulShutdown => "graceful_shutdown",
            Self::EndOfAggregation => "end_of_aggregation",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ToolCallStreamKey {
    Indexed(usize),
    Unindexed,
}

impl From<Option<usize>> for ToolCallStreamKey {
    fn from(value: Option<usize>) -> Self {
        match value {
            Some(index) => Self::Indexed(index),
            None => Self::Unindexed,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PendingToolCall {
    tool_id: String,
    tool_name: String,
    raw_arguments: String,
    early_detected_emitted: bool,
}

#[derive(Debug, Clone)]
pub struct FinalizedToolCall {
    pub tool_id: String,
    pub tool_name: String,
    pub raw_arguments: String,
    pub arguments: Value,
    pub is_error: bool,
    /// Original JSON parser error when the provider emitted invalid arguments.
    pub parse_error: Option<String>,
    pub repair_kind: ToolArgumentRepairKind,
    /// True when the raw stream produced unparseable JSON (e.g. truncated by
    /// `max_tokens`) and we successfully patched the trailing brackets/strings
    /// to make it parse. The recovered call still executes, but downstream
    /// consumers should warn the model that the content may be incomplete.
    pub recovered_from_truncation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarlyDetectedToolCall {
    pub tool_id: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCallParamsChunk {
    pub tool_id: String,
    pub tool_name: String,
    pub params_chunk: String,
}

#[derive(Debug, Clone, Default)]
pub struct ToolCallDeltaOutcome {
    pub finalized_previous: Option<FinalizedToolCall>,
    pub early_detected: Option<EarlyDetectedToolCall>,
    pub params_partial: Option<ToolCallParamsChunk>,
}

#[derive(Debug, Clone, Default)]
pub struct PendingToolCalls {
    pending: BTreeMap<ToolCallStreamKey, PendingToolCall>,
}

/// Tools where a repaired truncation can be passed to schema validation.
/// Write requires its path/content separator before execution, so a truncation
/// inside the path is rejected while a truncation in the content can still
/// write the safe prefix. For everything else (ExecCommand, Edit, Task, ...) we surface
/// the truncation as an error: a partial shell command or a partial
/// `old_string`/`new_string` for Edit can change semantics destructively.
pub fn is_write_like_tool_name(tool_name: &str) -> bool {
    matches!(tool_name, "Write" | "file_write" | "write_notebook")
}

#[derive(Debug)]
struct ToolArgumentParseError {
    message: String,
    is_eof: bool,
    category: &'static str,
}

/// Attempt to repair a JSON document that was truncated mid-stream (typically
/// because the model hit `max_tokens`). Closes any open string literal and any
/// unclosed `{`/`[` brackets in their correct nesting order. Returns `None`
/// when the truncation occurs at a position where we would have to invent a
/// missing value (e.g. trailing `,` or `:`) since blindly closing in those
/// states would silently corrupt the semantics.
fn repair_truncated_json(raw: &str) -> Option<String> {
    let mut in_string = false;
    let mut escape = false;
    let mut stack: Vec<u8> = Vec::new();
    let mut last_significant: Option<u8> = None;

    for &b in raw.as_bytes() {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match b {
                b'\\' => escape = true,
                b'"' => {
                    in_string = false;
                    last_significant = Some(b'"');
                }
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => {
                in_string = true;
                last_significant = Some(b'"');
            }
            b'{' => {
                stack.push(b'{');
                last_significant = Some(b'{');
            }
            b'[' => {
                stack.push(b'[');
                last_significant = Some(b'[');
            }
            b'}' => {
                if stack.pop() != Some(b'{') {
                    return None;
                }
                last_significant = Some(b'}');
            }
            b']' => {
                if stack.pop() != Some(b'[') {
                    return None;
                }
                last_significant = Some(b']');
            }
            b' ' | b'\t' | b'\n' | b'\r' => {}
            other => last_significant = Some(other),
        }
    }

    // Nothing to repair (parser failed for some other reason).
    if !in_string && stack.is_empty() {
        return None;
    }

    // Refuse to fabricate values when truncated mid-pair.
    if !in_string {
        if let Some(b',') | Some(b':') = last_significant {
            return None;
        }
    }

    let mut out = String::with_capacity(raw.len() + stack.len() + 1);
    out.push_str(raw);
    if in_string {
        out.push('"');
    }
    while let Some(c) = stack.pop() {
        out.push(match c {
            b'{' => '}',
            b'[' => ']',
            _ => unreachable!(),
        });
    }
    Some(out)
}

impl PendingToolCall {
    fn parse_arguments(
        _tool_name: &str,
        raw_arguments: &str,
    ) -> Result<Value, ToolArgumentParseError> {
        match serde_json::from_str::<Value>(raw_arguments) {
            Ok(arguments) => Ok(arguments),
            Err(primary_error) => Err(ToolArgumentParseError {
                message: primary_error.to_string(),
                is_eof: primary_error.is_eof(),
                category: match primary_error.classify() {
                    serde_json::error::Category::Io => "io",
                    serde_json::error::Category::Syntax => "syntax",
                    serde_json::error::Category::Data => "data",
                    serde_json::error::Category::Eof => "eof",
                },
            }),
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.tool_id.is_empty()
    }

    pub fn has_meaningful_payload(&self) -> bool {
        !self.tool_name.is_empty() || !self.raw_arguments.is_empty()
    }

    pub fn tool_id(&self) -> &str {
        &self.tool_id
    }

    pub fn tool_name(&self) -> &str {
        &self.tool_name
    }

    pub fn start_new(&mut self, tool_id: String, tool_name: Option<String>) {
        self.tool_id = tool_id;
        self.tool_name = tool_name.unwrap_or_default();
        self.raw_arguments.clear();
        self.early_detected_emitted = false;
    }

    pub fn update_tool_name_if_missing(&mut self, tool_name: Option<String>) {
        if self.tool_name.is_empty() {
            self.tool_name = tool_name.unwrap_or_default();
        }
    }

    pub fn append_arguments(&mut self, arguments_chunk: &str) {
        self.raw_arguments.push_str(arguments_chunk);
    }

    pub fn replace_arguments(&mut self, arguments_snapshot: &str) {
        self.raw_arguments.clear();
        self.raw_arguments.push_str(arguments_snapshot);
    }

    pub fn raw_arguments(&self) -> &str {
        &self.raw_arguments
    }

    pub fn finalize(&mut self, boundary: ToolCallBoundary) -> Option<FinalizedToolCall> {
        self.finalize_with_options(boundary, ToolCallFinalizeOptions::default())
    }

    pub fn finalize_with_options(
        &mut self,
        boundary: ToolCallBoundary,
        options: ToolCallFinalizeOptions,
    ) -> Option<FinalizedToolCall> {
        if !self.has_pending() {
            return None;
        }

        if !self.has_meaningful_payload() {
            self.tool_id.clear();
            self.tool_name.clear();
            self.raw_arguments.clear();
            self.early_detected_emitted = false;
            return None;
        }

        let tool_id = std::mem::take(&mut self.tool_id);
        let tool_name = std::mem::take(&mut self.tool_name);
        let raw_arguments = std::mem::take(&mut self.raw_arguments);
        self.early_detected_emitted = false;
        let parsed_arguments = Self::parse_arguments(&tool_name, &raw_arguments);

        let (arguments, is_error, repair_kind, parse_error) = match parsed_arguments {
            Ok(value) => (value, false, ToolArgumentRepairKind::None, None),
            Err(parse_err) => {
                let original_parse_error = parse_err.message.clone();
                let write_tail_repair = is_write_like_tool_name(&tool_name)
                    .then(|| repair_truncated_json(&raw_arguments))
                    .flatten()
                    .and_then(|candidate| Self::parse_arguments(&tool_name, &candidate).ok());
                if let Some(value) = write_tail_repair {
                    warn!(
                        "Write tool call arguments recovered with close-only repair at boundary={}: tool_id={}, tool_name={}, raw_len={}, parse_error_category={}, parse_error_is_eof={}, completion={:?}",
                        boundary.as_str(),
                        tool_id,
                        tool_name,
                        raw_arguments.len(),
                        parse_err.category,
                        parse_err.is_eof,
                        options.completion
                    );
                    (
                        value,
                        false,
                        ToolArgumentRepairKind::WriteTailClosure,
                        Some(original_parse_error),
                    )
                } else if options.allow_normal_tool_json_repair
                    && options.completion.permits_normal_tool_json_repair()
                {
                    // Keep Markdown markers and decode model-emitted JSON escapes.
                    // Literal backslashes must be escaped or inside valid JSON strings.
                    let repair_options = jsonrepair_rs::RepairOptions::new()
                        .with_preserve_comment_markers(true)
                        .with_decode_unquoted_escapes(true);
                    let repaired =
                        jsonrepair_rs::jsonrepair_with_options(&raw_arguments, repair_options)
                            .ok()
                            .and_then(|candidate| {
                                Self::parse_arguments(&tool_name, &candidate).ok()
                            });
                    match repaired {
                        Some(value) => {
                            warn!(
                                "Tool call arguments repaired after normal tool-use completion: boundary={}, tool_id={}, tool_name={}, raw_len={}, parse_error_category={}, parse_error_is_eof={}",
                                boundary.as_str(),
                                tool_id,
                                tool_name,
                                raw_arguments.len(),
                                parse_err.category,
                                parse_err.is_eof
                            );
                            (
                                value,
                                false,
                                ToolArgumentRepairKind::PermissiveNormalToolJsonRepair,
                                Some(original_parse_error),
                            )
                        }
                        None => {
                            error!(
                                "Tool call arguments parsing failed after normal-completion JSON repair: boundary={}, tool_id={}, tool_name={}, raw_len={}, error={}, parse_error_category={}, parse_error_is_eof={}",
                                boundary.as_str(),
                                tool_id,
                                tool_name,
                                raw_arguments.len(),
                                parse_err.message,
                                parse_err.category,
                                parse_err.is_eof
                            );
                            (
                                json!({}),
                                true,
                                ToolArgumentRepairKind::None,
                                Some(original_parse_error),
                            )
                        }
                    }
                } else {
                    error!(
                        "Tool call arguments parsing failed at boundary={}: tool_id={}, tool_name={}, raw_len={}, error={}, parse_error_category={}, parse_error_is_eof={}, completion={:?}",
                        boundary.as_str(),
                        tool_id,
                        tool_name,
                        raw_arguments.len(),
                        parse_err.message,
                        parse_err.category,
                        parse_err.is_eof,
                        options.completion
                    );
                    (
                        json!({}),
                        true,
                        ToolArgumentRepairKind::None,
                        Some(original_parse_error),
                    )
                }
            }
        };

        Some(FinalizedToolCall {
            tool_id,
            tool_name,
            raw_arguments,
            arguments,
            is_error,
            repair_kind,
            recovered_from_truncation: repair_kind.is_write_tail_closure(),
            parse_error,
        })
    }
}

impl PendingToolCalls {
    pub fn new() -> Self {
        Self {
            pending: BTreeMap::new(),
        }
    }

    pub fn apply_delta(
        &mut self,
        key: ToolCallStreamKey,
        tool_id: Option<String>,
        tool_name: Option<String>,
        arguments: Option<String>,
        arguments_is_snapshot: bool,
    ) -> ToolCallDeltaOutcome {
        let mut outcome = ToolCallDeltaOutcome::default();

        let has_tool_id = tool_id.as_ref().is_some_and(|tool_id| !tool_id.is_empty());
        if !self.pending.contains_key(&key) {
            if has_tool_id {
                self.pending.insert(key.clone(), PendingToolCall::default());
            } else {
                return outcome;
            }
        }

        let Some(pending) = self.pending.get_mut(&key) else {
            return outcome;
        };

        if let Some(tool_id) = tool_id.filter(|tool_id| !tool_id.is_empty()) {
            let is_new_tool = pending.tool_id() != tool_id;
            if is_new_tool {
                outcome.finalized_previous = pending.finalize(ToolCallBoundary::NewTool);
                pending.start_new(tool_id, tool_name.clone());
            } else {
                pending.update_tool_name_if_missing(tool_name.clone());
            }
        } else if tool_name
            .as_ref()
            .is_some_and(|tool_name| !tool_name.is_empty())
        {
            pending.update_tool_name_if_missing(tool_name.clone());
        }

        if pending.has_pending()
            && !pending.tool_name().is_empty()
            && !pending.early_detected_emitted
        {
            pending.early_detected_emitted = true;
            outcome.early_detected = Some(EarlyDetectedToolCall {
                tool_id: pending.tool_id().to_string(),
                tool_name: pending.tool_name().to_string(),
            });
        }

        if let Some(arguments) = arguments.filter(|arguments| !arguments.is_empty()) {
            if pending.has_pending() {
                if arguments_is_snapshot {
                    pending.replace_arguments(&arguments);
                } else {
                    pending.append_arguments(&arguments);
                }
                let tool_name = pending.tool_name().to_string();
                let params_chunk = arguments;
                if !params_chunk.is_empty() {
                    outcome.params_partial = Some(ToolCallParamsChunk {
                        tool_id: pending.tool_id().to_string(),
                        tool_name,
                        params_chunk,
                    });
                }
            }
        }

        outcome
    }

    pub fn finalize_key(
        &mut self,
        key: &ToolCallStreamKey,
        boundary: ToolCallBoundary,
    ) -> Option<FinalizedToolCall> {
        let mut pending = self.pending.remove(key)?;
        pending.finalize(boundary)
    }

    pub fn finalize_key_with_options(
        &mut self,
        key: &ToolCallStreamKey,
        boundary: ToolCallBoundary,
        options: ToolCallFinalizeOptions,
    ) -> Option<FinalizedToolCall> {
        let mut pending = self.pending.remove(key)?;
        pending.finalize_with_options(boundary, options)
    }

    pub fn finalize_all(&mut self, boundary: ToolCallBoundary) -> Vec<FinalizedToolCall> {
        let keys: Vec<_> = self.pending.keys().cloned().collect();
        keys.into_iter()
            .filter_map(|key| self.finalize_key(&key, boundary))
            .collect()
    }

    pub fn finalize_all_with_options(
        &mut self,
        boundary: ToolCallBoundary,
        options: ToolCallFinalizeOptions,
    ) -> Vec<FinalizedToolCall> {
        let keys: Vec<_> = self.pending.keys().cloned().collect();
        keys.into_iter()
            .filter_map(|key| self.finalize_key_with_options(&key, boundary, options))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        repair_truncated_json, EarlyDetectedToolCall, PendingToolCall, PendingToolCalls,
        ToolArgumentRepairKind, ToolCallBoundary, ToolCallCompletion, ToolCallFinalizeOptions,
        ToolCallParamsChunk, ToolCallStreamKey,
    };
    use serde_json::json;

    #[test]
    fn finalizes_complete_json_only_at_boundary() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("tool_a".to_string()));
        pending.append_arguments("{\"a\":1}");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.tool_id, "call_1");
        assert_eq!(finalized.tool_name, "tool_a");
        assert_eq!(finalized.arguments, json!({"a": 1}));
        assert!(!finalized.is_error);
        assert!(!pending.has_pending());
    }

    #[test]
    fn invalid_json_becomes_error_with_empty_object() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("tool_a".to_string()));
        pending.append_arguments("{\"a\":");

        let finalized = pending
            .finalize(ToolCallBoundary::StreamEnd)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
        assert_eq!(finalized.raw_arguments, "{\"a\":");
        assert!(finalized
            .parse_error
            .as_deref()
            .is_some_and(|error| error.contains("EOF")));
    }

    #[test]
    fn raw_string_arguments_for_single_field_tools_stay_invalid_json() {
        let cases = [
            ("ExecCommand", "pnpm test"),
            ("Skill", "openai-docs"),
            ("Read", "src/main.rs"),
            ("GetFileDiff", "src/lib.rs"),
            ("LS", "src/crates"),
            ("Delete", "tmp/output.log"),
            ("Glob", "**/*.rs"),
            ("Grep", "Arguments are invalid JSON"),
            ("WebSearch", "OpenAI Agents SDK"),
            ("WebFetch", "https://example.com"),
            ("InitMiniApp", "Markdown Viewer"),
        ];

        for (tool_name, raw_arguments) in cases {
            let mut pending = PendingToolCall::default();
            pending.start_new("call_1".to_string(), Some(tool_name.to_string()));
            pending.append_arguments(raw_arguments);

            let finalized = pending
                .finalize(ToolCallBoundary::FinishReason)
                .expect("finalized tool");

            assert_eq!(finalized.arguments, json!({}), "tool={tool_name}");
            assert!(finalized.is_error, "tool={tool_name}");
        }
    }

    #[test]
    fn incomplete_json_object_for_single_field_tools_stays_invalid() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments(
            "{\"command\": \"git log --since=\\\"2026-05-02\\\" --oneline --stat",
        );

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn does_not_wrap_incomplete_json_object_as_raw_string_argument() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments("{\"command\": ");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn does_not_repair_incomplete_json_object_for_multifield_tools() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("Task".to_string()));
        pending.append_arguments(
            "{\"description\":\"Explore OpenBitFun project structure\",\"prompt\":\"read README\\n\\nthoroughness: very",
        );

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn does_not_repair_object_without_key_value_payload() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments("{");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn does_not_execute_truncated_incomplete_json_object() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments("{\"command\": \"git log --since=\\\"2026-05-02\\\" --on");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn json_string_arguments_for_single_field_tools_are_schema_errors_not_rewritten() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments("\"git status\"");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!("git status"));
        assert!(!finalized.is_error);
    }

    #[test]
    fn fenced_raw_arguments_for_single_field_tools_stay_invalid_json() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments("```bash\npnpm run lint:web\n```");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn does_not_repair_raw_string_arguments_for_multifield_tools() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("Edit".to_string()));
        pending.append_arguments("src/main.rs");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn json_with_one_extra_trailing_right_brace_stays_invalid() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("tool_a".to_string()));
        pending.append_arguments("{\"a\":1}}");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.raw_arguments, "{\"a\":1}}");
        assert_eq!(finalized.arguments, json!({}));
        assert!(finalized.is_error);
    }

    #[test]
    fn finalized_arguments_preserve_object_fields() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("tool_a".to_string()));
        pending.append_arguments("{\"a\":1,\"b\":\"x\"}");

        let finalized = pending
            .finalize(ToolCallBoundary::EndOfAggregation)
            .expect("finalized tool");

        assert_eq!(finalized.arguments["a"], json!(1));
        assert_eq!(finalized.arguments["b"], json!("x"));
    }

    #[test]
    fn replace_arguments_overwrites_partial_buffer() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("tool_a".to_string()));
        pending.append_arguments("{\"city\":\"Bei");
        pending.replace_arguments("{\"city\":\"Beijing\"}");

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert_eq!(finalized.arguments, json!({"city": "Beijing"}));
        assert!(!finalized.is_error);
    }

    #[test]
    fn manages_multiple_pending_tool_calls_by_index() {
        let mut pending = PendingToolCalls::default();

        assert_eq!(
            pending
                .apply_delta(
                    ToolCallStreamKey::Indexed(0),
                    Some("call_1".to_string()),
                    Some("tool_a".to_string()),
                    None,
                    false,
                )
                .early_detected,
            Some(EarlyDetectedToolCall {
                tool_id: "call_1".to_string(),
                tool_name: "tool_a".to_string(),
            })
        );
        assert_eq!(
            pending
                .apply_delta(
                    ToolCallStreamKey::Indexed(1),
                    Some("call_2".to_string()),
                    Some("tool_b".to_string()),
                    None,
                    false,
                )
                .early_detected,
            Some(EarlyDetectedToolCall {
                tool_id: "call_2".to_string(),
                tool_name: "tool_b".to_string(),
            })
        );

        pending.apply_delta(
            ToolCallStreamKey::Indexed(0),
            None,
            None,
            Some("{\"a\":1}".to_string()),
            false,
        );
        pending.apply_delta(
            ToolCallStreamKey::Indexed(1),
            None,
            None,
            Some("{\"b\":2}".to_string()),
            false,
        );

        let finalized = pending.finalize_all(ToolCallBoundary::FinishReason);
        assert_eq!(finalized.len(), 2);
        assert_eq!(finalized[0].tool_id, "call_1");
        assert_eq!(finalized[0].arguments, json!({"a": 1}));
        assert_eq!(finalized[1].tool_id, "call_2");
        assert_eq!(finalized[1].arguments, json!({"b": 2}));
    }

    #[test]
    fn id_only_prelude_is_attached_to_following_payload_without_id() {
        let mut pending = PendingToolCalls::default();

        let prelude = pending.apply_delta(
            ToolCallStreamKey::Indexed(0),
            Some("call_1".to_string()),
            None,
            None,
            false,
        );
        assert_eq!(prelude.early_detected, None);
        assert_eq!(prelude.params_partial, None);

        let payload = pending.apply_delta(
            ToolCallStreamKey::Indexed(0),
            None,
            Some("tool_a".to_string()),
            Some("{\"a\":1}".to_string()),
            false,
        );
        assert_eq!(
            payload.early_detected,
            Some(EarlyDetectedToolCall {
                tool_id: "call_1".to_string(),
                tool_name: "tool_a".to_string(),
            })
        );
        assert_eq!(
            payload.params_partial,
            Some(ToolCallParamsChunk {
                tool_id: "call_1".to_string(),
                tool_name: "tool_a".to_string(),
                params_chunk: "{\"a\":1}".to_string(),
            })
        );
    }

    #[test]
    fn id_only_orphan_is_dropped_on_finalize() {
        let mut pending = PendingToolCalls::default();

        let outcome = pending.apply_delta(
            ToolCallStreamKey::Indexed(1),
            Some("call_orphan".to_string()),
            None,
            None,
            false,
        );
        assert!(outcome.finalized_previous.is_none());
        assert!(outcome.early_detected.is_none());
        assert!(outcome.params_partial.is_none());
        assert!(pending
            .finalize_all(ToolCallBoundary::FinishReason)
            .is_empty());
    }

    #[test]
    fn empty_argument_delta_is_ignored() {
        let mut pending = PendingToolCalls::default();

        let header = pending.apply_delta(
            ToolCallStreamKey::Indexed(0),
            Some("call_1".to_string()),
            Some("tool_a".to_string()),
            Some(String::new()),
            false,
        );
        assert_eq!(
            header.early_detected,
            Some(EarlyDetectedToolCall {
                tool_id: "call_1".to_string(),
                tool_name: "tool_a".to_string(),
            })
        );
        assert!(header.params_partial.is_none());

        let empty_delta = pending.apply_delta(
            ToolCallStreamKey::Indexed(0),
            None,
            None,
            Some(String::new()),
            false,
        );
        assert!(empty_delta.finalized_previous.is_none());
        assert!(empty_delta.early_detected.is_none());
        assert!(empty_delta.params_partial.is_none());
    }

    // ------------------------------------------------------------------
    // Truncation recovery tests
    // ------------------------------------------------------------------

    #[test]
    fn write_truncated_mid_content_string_is_recovered() {
        // The path and its separating newline have already been emitted, so
        // truncation can only remove a suffix of the file content.
        let raw = r#"{"payload":"+++ /tmp/report.md\n# Report\n\nA long body that was cut"#;
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("Write".to_string()));
        pending.append_arguments(raw);

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert!(!finalized.is_error, "Write recovery should succeed");
        assert!(finalized.recovered_from_truncation);
        assert_eq!(
            finalized.repair_kind,
            ToolArgumentRepairKind::WriteTailClosure
        );
        assert_eq!(
            finalized.arguments,
            json!({
                "payload": "+++ /tmp/report.md\n# Report\n\nA long body that was cut"
            })
        );
    }

    #[test]
    fn write_like_recovery_classification_matches_tool_presentation_contract() {
        for tool_name in [
            "Write",
            "file_write",
            "write_notebook",
            "Read",
            "Edit",
            "AskUserQuestion",
            "TodoWrite",
        ] {
            assert_eq!(
                super::is_write_like_tool_name(tool_name),
                openbitfun_agent_tools::is_write_like_tool_name(tool_name),
                "tool_name={tool_name}"
            );
        }
    }

    #[test]
    fn write_truncated_with_chinese_multibyte_is_recovered() {
        let raw = r#"{"payload":"+++ /tmp/r.md\n深度研究报告：未完"#;
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("Write".to_string()));
        pending.append_arguments(raw);

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert!(!finalized.is_error);
        assert!(finalized.recovered_from_truncation);
        assert_eq!(
            finalized.arguments["payload"].as_str(),
            Some("+++ /tmp/r.md\n深度研究报告：未完")
        );
    }

    #[test]
    fn non_write_truncated_command_still_errors_without_repair_provenance() {
        let raw = r#"{"command": "git log --since=\"2026-05-02\" --on"#;
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("ExecCommand".to_string()));
        pending.append_arguments(raw);

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        // We never execute a partial shell command.
        assert!(finalized.is_error);
        assert_eq!(finalized.arguments, json!({}));
        assert!(!finalized.recovered_from_truncation);
        assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
    }

    #[test]
    fn repair_refuses_truncation_after_colon() {
        // We can't invent the missing value, so this must not auto-repair.
        assert!(repair_truncated_json(r#"{"a": 1, "b":"#).is_none());
    }

    #[test]
    fn repair_refuses_truncation_after_comma() {
        assert!(repair_truncated_json(r#"{"a": 1,"#).is_none());
    }

    #[test]
    fn repair_returns_none_for_already_valid_json() {
        // Already balanced — repair has nothing to do (parser would have
        // succeeded anyway).
        assert!(repair_truncated_json(r#"{"a": 1}"#).is_none());
    }

    #[test]
    fn repair_closes_nested_brackets_in_correct_order() {
        let raw = r#"{"a": [1, 2, {"b": "incomplete"#;
        let repaired = repair_truncated_json(raw).expect("repaired");
        let parsed: serde_json::Value =
            serde_json::from_str(&repaired).expect("repaired is valid JSON");
        assert_eq!(parsed, json!({"a": [1, 2, {"b": "incomplete"}]}));
    }

    #[test]
    fn repair_preserves_escaped_quote_inside_truncated_string() {
        let raw = r#"{"content": "she said \"hello\" and then"#;
        let repaired = repair_truncated_json(raw).expect("repaired");
        let parsed: serde_json::Value = serde_json::from_str(&repaired).expect("valid JSON");
        assert_eq!(
            parsed["content"].as_str(),
            Some("she said \"hello\" and then")
        );
    }

    #[test]
    fn ask_user_question_truncated_mid_chinese_string_is_not_recovered_by_default() {
        let raw = r#"{"questions": [{"header": "重试场景", "multiSelect": true, "options": [{"description": "当消息发送后后端返回失败（消息气泡显示为红色失败状态，有 model rounds 但 status='error'），在失败气泡旁增加重试按钮，点击后重新发送该消息", "label": "失败消息气泡上加重试按钮"}]}]}"#;
        // Truncate mid-Chinese-string, after a colon that opened the value
        let truncated = &raw[..raw.find("消息气泡显示为红色失败状态").unwrap()
            + "消息气泡显示为红色失败状态".len()];
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("AskUserQuestion".to_string()));
        pending.append_arguments(truncated);

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert!(finalized.is_error);
        assert!(!finalized.recovered_from_truncation);
        assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
    }

    #[test]
    fn ask_user_question_truncated_mid_options_is_not_recovered_by_default() {
        // Truncation right after a completed description value's closing quote + comma
        let raw = r#"{"questions": [{"header": "场景", "multiSelect": true, "options": [{"description": "第一条描述", "label": "选项一"}, {"description": "第二条描"#;
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("AskUserQuestion".to_string()));
        pending.append_arguments(raw);

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert!(finalized.is_error);
        assert!(!finalized.recovered_from_truncation);
        assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
    }

    #[test]
    fn todo_write_truncated_mid_content_is_not_recovered_by_default() {
        let raw = r#"{"todos": [{"id": "1", "content": "完成重构并优化性能", "status": "in_progress"}, {"id": "2", "content": "编写单元测"#;
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("TodoWrite".to_string()));
        pending.append_arguments(raw);

        let finalized = pending
            .finalize(ToolCallBoundary::FinishReason)
            .expect("finalized tool");

        assert!(finalized.is_error);
        assert!(!finalized.recovered_from_truncation);
        assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
    }

    #[test]
    fn write_close_only_repair_does_not_depend_on_non_write_repair_setting() {
        let raw = r#"{"payload":"+++ /tmp/report.md\npartial content"#;

        for allow_normal_tool_json_repair in [false, true] {
            let mut pending = PendingToolCall::default();
            pending.start_new("call_1".to_string(), Some("Write".to_string()));
            pending.append_arguments(raw);

            let finalized = pending
                .finalize_with_options(
                    ToolCallBoundary::FinishReason,
                    ToolCallFinalizeOptions {
                        completion: ToolCallCompletion::OutputLimit,
                        allow_normal_tool_json_repair,
                    },
                )
                .expect("finalized tool");

            assert!(!finalized.is_error);
            assert_eq!(
                finalized.repair_kind,
                ToolArgumentRepairKind::WriteTailClosure
            );
        }
    }

    #[test]
    fn non_write_repair_requires_enabled_normal_tool_use_completion() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("Read".to_string()));
        pending.append_arguments(r#"{"path":"src/main.rs" "line_end":4}"#);

        let finalized = pending
            .finalize_with_options(
                ToolCallBoundary::FinishReason,
                ToolCallFinalizeOptions {
                    completion: ToolCallCompletion::NormalToolUse,
                    allow_normal_tool_json_repair: true,
                },
            )
            .expect("finalized tool");

        assert!(!finalized.is_error);
        assert_eq!(
            finalized.repair_kind,
            ToolArgumentRepairKind::PermissiveNormalToolJsonRepair
        );
        assert_eq!(
            finalized.arguments,
            json!({"path": "src/main.rs", "line_end": 4})
        );
    }

    #[test]
    fn repairs_create_plan_string_fields_without_opening_quotes() {
        // `name`, `overview`, and Markdown `plan` have their closing quote
        // but omit the opening quote after `:`. The plan begins with `#`, so
        // it must not be interpreted as a JSON-like comment.
        let raw_arguments = r##"{"name": CreatePlan JSON repair", "overview": Verify malformed plan arguments", "plan": # CreatePlan repair\n\n- Add a regression test"}"##;
        let mut pending = PendingToolCall::default();
        pending.start_new(
            "call_create_plan".to_string(),
            Some("CreatePlan".to_string()),
        );
        pending.append_arguments(raw_arguments);

        let finalized = pending
            .finalize_with_options(
                ToolCallBoundary::FinishReason,
                ToolCallFinalizeOptions {
                    completion: ToolCallCompletion::NormalToolUse,
                    allow_normal_tool_json_repair: true,
                },
            )
            .expect("finalized CreatePlan call");

        assert!(!finalized.is_error);
        assert_eq!(
            finalized.repair_kind,
            ToolArgumentRepairKind::PermissiveNormalToolJsonRepair
        );
        assert_eq!(
            finalized.arguments["name"].as_str(),
            Some("CreatePlan JSON repair")
        );
        assert_eq!(
            finalized.arguments["overview"].as_str(),
            Some("Verify malformed plan arguments")
        );
        assert_eq!(
            finalized.arguments["plan"].as_str(),
            Some("# CreatePlan repair\n\n- Add a regression test")
        );
    }

    #[test]
    fn normal_tool_repair_preserves_content_and_escaped_paths() {
        let cases = [
            (
                r##"{"content": # Heading\nSub"}"##,
                json!({"content": "# Heading\nSub"}),
            ),
            (
                r#"{"content": // Heading\nSub}"#,
                json!({"content": "// Heading\nSub"}),
            ),
            (
                r#"{"content": /* Heading\nSub */}"#,
                json!({"content": "/* Heading\nSub */"}),
            ),
            (
                r#"{"content": text // example}"#,
                json!({"content": "text // example"}),
            ),
            (
                r#"{"content": text /* example */}"#,
                json!({"content": "text /* example */"}),
            ),
            (
                r#"{"content": prefix\"quote\"suffix}"#,
                json!({"content": "prefix\"quote\"suffix"}),
            ),
            (
                r#"{"path": C:\\new\\table.txt}"#,
                json!({"path": r"C:\new\table.txt"}),
            ),
            (
                r#"{"path":"C:\\new\\table.txt" "line_end":4}"#,
                json!({"path": r"C:\new\table.txt", "line_end": 4}),
            ),
            (
                r#"{"path":"/home/user/project/file.txt" "line_end":4}"#,
                json!({"path": "/home/user/project/file.txt", "line_end": 4}),
            ),
            (r#"{"path": src/main.rs}"#, json!({"path": "src/main.rs"})),
            (
                r#"{"content": value\uD83D\uDE00}"#,
                json!({"content": "value\u{1f600}"}),
            ),
            (
                r##"{"content":"# Heading\nhttps:/"##,
                json!({"content": "# Heading\nhttps:/"}),
            ),
        ];

        for (raw, expected) in cases {
            let mut pending = PendingToolCall::default();
            pending.start_new("call_content".to_string(), Some("tool_a".to_string()));
            pending.append_arguments(raw);
            let finalized = pending
                .finalize_with_options(
                    ToolCallBoundary::FinishReason,
                    ToolCallFinalizeOptions {
                        completion: ToolCallCompletion::NormalToolUse,
                        allow_normal_tool_json_repair: true,
                    },
                )
                .expect("finalized tool");

            assert!(!finalized.is_error, "raw={raw:?}");
            assert_eq!(finalized.arguments, expected, "raw={raw:?}");
            assert_eq!(finalized.raw_arguments, raw);
            assert!(finalized.parse_error.is_some());
            assert_eq!(
                finalized.repair_kind,
                ToolArgumentRepairKind::PermissiveNormalToolJsonRepair
            );
        }
    }

    #[test]
    fn normal_tool_repair_rejects_invalid_content() {
        for raw in [
            r#"{"value":+e1}"#,
            "{\"items\":[\u{000c}",
            r#"{"content": value\uD800}"#,
            r#"{"content": value\uDC00}"#,
            r#"{"content": value\uD800\u0041}"#,
            "{\"content\": # Heading\n## Sub\n}",
        ] {
            let mut pending = PendingToolCall::default();
            pending.start_new("call_invalid".to_string(), Some("tool_a".to_string()));
            pending.append_arguments(raw);
            let finalized = pending
                .finalize_with_options(
                    ToolCallBoundary::FinishReason,
                    ToolCallFinalizeOptions {
                        completion: ToolCallCompletion::NormalToolUse,
                        allow_normal_tool_json_repair: true,
                    },
                )
                .expect("finalized tool");

            assert!(finalized.is_error, "raw={raw:?}");
            assert_eq!(finalized.arguments, json!({}));
            assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
            assert!(finalized.parse_error.is_some());
        }
    }

    #[test]
    fn non_write_repair_is_disabled_by_default() {
        let mut pending = PendingToolCall::default();
        pending.start_new("call_1".to_string(), Some("Read".to_string()));
        pending.append_arguments(r#"{"path":"src/main.rs" "line_end":4}"#);

        let finalized = pending
            .finalize_with_options(
                ToolCallBoundary::FinishReason,
                ToolCallFinalizeOptions {
                    completion: ToolCallCompletion::NormalToolUse,
                    allow_normal_tool_json_repair: false,
                },
            )
            .expect("finalized tool");

        assert!(finalized.is_error);
        assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
    }

    #[test]
    fn non_write_repair_never_runs_after_non_normal_completion() {
        for completion in [
            ToolCallCompletion::NormalNoToolUse,
            ToolCallCompletion::OutputLimit,
            ToolCallCompletion::ContentFiltered,
            ToolCallCompletion::Failed,
            ToolCallCompletion::Interrupted,
            ToolCallCompletion::Unknown,
        ] {
            let mut pending = PendingToolCall::default();
            pending.start_new("call_1".to_string(), Some("Read".to_string()));
            pending.append_arguments(r#"{"path":"src/main.rs" "line_end":4}"#);

            let finalized = pending
                .finalize_with_options(
                    ToolCallBoundary::FinishReason,
                    ToolCallFinalizeOptions {
                        completion,
                        allow_normal_tool_json_repair: true,
                    },
                )
                .expect("finalized tool");

            assert!(finalized.is_error, "completion={completion:?}");
            assert_eq!(finalized.repair_kind, ToolArgumentRepairKind::None);
        }
    }
}
