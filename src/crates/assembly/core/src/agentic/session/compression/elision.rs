//! Request-side elision for the compression summary input.
//!
//! When the summary request cannot shrink any further by planning alone
//! (the cutoff is already at its floor), this ladder folds oversized fenced
//! and top-level XML blocks in the OLDEST message text first, deepest pass
//! last. The folds apply to a request-scoped copy only: stored history,
//! message identities, and the compression plan are never rewritten here.

use crate::agentic::core::{Message, MessageContent};
use crate::util::TokenCounter;

/// Default minimum block size eligible for elision, mirroring the
/// `ai.context_compression_elide_min_tokens` config default.
pub(crate) const DEFAULT_ELIDE_MIN_TOKENS: usize = 400;

/// Elision passes available after the unelided attempt. Pass depth halves
/// the configured threshold: configured, /2, /4.
pub(crate) const MAX_ELISION_PASSES: usize = 3;

/// Upper bound on gross tokens folded per pass, so a pass can never elide
/// the whole request. A block that starts within budget is folded whole.
const ELISION_BUDGET_TOKENS_PER_PASS: usize = 40_000;

#[derive(Debug, Default, Clone, Copy)]
pub struct ElisionReport {
    pub elided_blocks: usize,
    pub elided_tokens: usize,
}

/// Progressive elision state for one summary request ladder.
#[derive(Debug)]
pub struct RequestElisionLadder {
    enabled: bool,
    min_tokens: usize,
    depth: usize,
}

impl RequestElisionLadder {
    pub fn new(enabled: bool, min_tokens: usize) -> Self {
        Self {
            enabled,
            min_tokens: min_tokens.max(1),
            depth: 0,
        }
    }

    /// True once at least one pass has been applied to request copies.
    pub fn active(&self) -> bool {
        self.enabled && self.depth > 0
    }

    pub fn can_deepen(&self) -> bool {
        self.enabled && self.depth < MAX_ELISION_PASSES
    }

    pub fn deepen(&mut self) {
        if self.can_deepen() {
            self.depth += 1;
        }
    }

    pub fn depth(&self) -> usize {
        self.depth
    }

    fn effective_min_tokens(&self) -> usize {
        (self.min_tokens >> self.depth.saturating_sub(1)).max(1)
    }

    /// Fold eligible blocks across all text-bearing messages, oldest first.
    /// Blocks are folded whole; the budget only stops NEW folds.
    pub fn apply(&self, messages: &mut [Message]) -> ElisionReport {
        let mut report = ElisionReport::default();
        if !self.active() {
            return report;
        }
        let min_tokens = self.effective_min_tokens();
        let mut budget = ELISION_BUDGET_TOKENS_PER_PASS;
        for message in messages.iter_mut() {
            fold_message_text(message, min_tokens, &mut budget, &mut report);
            if budget == 0 {
                break;
            }
        }
        report
    }
}

/// Fold one message's text in place.
fn fold_message_text(
    message: &mut Message,
    min_tokens: usize,
    budget: &mut usize,
    report: &mut ElisionReport,
) {
    match &mut message.content {
        MessageContent::Text(text) => {
            fold_text_with_label(text, "message", min_tokens, budget, report);
        }
        MessageContent::Multimodal { text, .. } => {
            fold_text_with_label(text, "message", min_tokens, budget, report);
        }
        MessageContent::Mixed { text, .. } => {
            fold_text_with_label(text, "message", min_tokens, budget, report);
        }
        MessageContent::ToolResult {
            tool_name,
            result_for_assistant,
            ..
        } => {
            let Some(text) = result_for_assistant
                .as_mut()
                .filter(|text| !text.is_empty())
            else {
                return;
            };
            fold_text_with_label(text, tool_name, min_tokens, budget, report);
        }
    }
}

fn fold_text_with_label(
    text: &mut String,
    label: &str,
    min_tokens: usize,
    budget: &mut usize,
    report: &mut ElisionReport,
) -> bool {
    let ranges = scan_elidable_block_ranges(text);
    if ranges.is_empty() {
        return false;
    }
    let mut replacement = String::with_capacity(text.len());
    let mut last_end = 0usize;
    let mut changed = false;
    for range in ranges {
        let block = &text[range.start..range.end];
        let block_tokens = TokenCounter::estimate_tokens(block);
        if block_tokens < min_tokens || *budget == 0 {
            continue;
        }
        *budget = budget.saturating_sub(block_tokens);
        replacement.push_str(&text[last_end..range.start]);
        replacement.push_str(&format!(
            "[Elided {block_tokens}-token {} block from {label}]",
            range.kind
        ));
        last_end = range.end;
        report.elided_blocks += 1;
        report.elided_tokens += block_tokens;
        changed = true;
    }
    if changed {
        replacement.push_str(&text[last_end..]);
        *text = replacement;
    }
    changed
}

struct ElidableBlockRange {
    start: usize,
    end: usize,
    kind: &'static str,
}

/// Locate complete fenced code blocks and top-level lowercase XML blocks.
/// Conservative by design: unterminated fences or tags yield no range, XML
/// detection is suppressed inside fences, and only exact-line lowercase tags
/// are considered.
fn scan_elidable_block_ranges(text: &str) -> Vec<ElidableBlockRange> {
    let mut ranges = Vec::new();
    let mut in_fence = false;
    let mut fence_start = 0usize;
    let mut fence_marker: Option<char> = None;
    let mut tag_stack: Vec<String> = Vec::new();
    let mut xml_start = 0usize;
    let bytes = text.as_bytes();
    let mut line_start = 0usize;
    while line_start < text.len() {
        let line_end = bytes[line_start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(text.len(), |position| line_start + position);
        let line = &text[line_start..line_end];
        let trimmed = line.trim_start();
        let fence = trimmed.starts_with("```") || trimmed.starts_with("~~~");
        if fence {
            let marker = trimmed.chars().next();
            if !in_fence {
                in_fence = true;
                fence_start = line_start;
                fence_marker = marker;
            } else if marker == fence_marker {
                in_fence = false;
                fence_marker = None;
                ranges.push(ElidableBlockRange {
                    start: fence_start,
                    end: line_end,
                    kind: "code",
                });
            }
        } else if !in_fence {
            if let Some(name) = opening_xml_tag(line) {
                if tag_stack.is_empty() {
                    xml_start = line_start;
                }
                tag_stack.push(name.to_string());
            } else if let Some(name) = closing_xml_tag(line) {
                if tag_stack.last().is_some_and(|open| open == name) {
                    tag_stack.pop();
                    if tag_stack.is_empty() {
                        ranges.push(ElidableBlockRange {
                            start: xml_start,
                            end: line_end,
                            kind: "xml",
                        });
                    }
                }
            }
        }
        if line_end >= text.len() {
            break;
        }
        line_start = line_end + 1;
    }
    ranges
}

/// `<name>` or `<name attr="value">` on an exact, otherwise-empty line.
fn opening_xml_tag(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('<')?;
    let name_end = rest.find(['>', ' ', '\t'])?;
    let name = &rest[..name_end];
    if !is_xml_name(name) {
        return None;
    }
    let after = &rest[name_end..];
    if after == ">" {
        return Some(name);
    }
    let attributes = after.strip_suffix('>')?;
    if attributes.is_empty()
        || attributes.contains('<')
        || !attributes.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b' ' | b'\t' | b'=' | b'"' | b'\'' | b'-' | b'_' | b'.' | b':' | b'/'
                )
        })
    {
        return None;
    }
    Some(name)
}

/// `</name>` on an exact line.
fn closing_xml_tag(line: &str) -> Option<&str> {
    let name = line.strip_prefix("</")?.strip_suffix('>')?;
    if !is_xml_name(name) {
        return None;
    }
    Some(name)
}

fn is_xml_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::Message;

    fn fenced_block(lines: usize) -> String {
        let mut block = String::from("```rust\n");
        for index in 0..lines {
            block.push_str(&format!(
                "let value_{index} = {index}; value_{index} + 42;\n"
            ));
        }
        block.push_str("```\n");
        block
    }

    fn tool_result_with_text(text: &str) -> Message {
        let mut message = Message::assistant("working".to_string());
        message.content = MessageContent::ToolResult {
            tool_id: "tool-1".to_string(),
            tool_name: "Read".to_string(),
            effective_tool_name: None,
            result: serde_json::json!({}),
            result_for_assistant: Some(text.to_string()),
            is_error: false,
            image_attachments: None,
        };
        message
    }

    fn ladder_at_depth(min_tokens: usize, depth: usize) -> RequestElisionLadder {
        let mut ladder = RequestElisionLadder::new(true, min_tokens);
        for _ in 0..depth {
            ladder.deepen();
        }
        ladder
    }

    #[test]
    fn disabled_ladder_is_inert() {
        let ladder = RequestElisionLadder::new(false, 400);
        assert!(!ladder.active());
        assert!(!ladder.can_deepen());
        let mut messages = vec![tool_result_with_text(&fenced_block(200))];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 0);
        assert!(messages[0].content.to_string().contains("let value_0"));
    }

    #[test]
    fn fences_above_threshold_are_elided_oldest_first_within_budget() {
        let ladder = ladder_at_depth(400, 1);
        let mut messages = vec![
            tool_result_with_text(&fenced_block(300)),
            tool_result_with_text(&fenced_block(300)),
        ];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 2);
        let first = messages[0].content.to_string();
        let second = messages[1].content.to_string();
        assert!(first.contains("[Elided ") && first.contains("code block from Read]"));
        assert!(!first.contains("let value_0"));
        assert!(second.contains("[Elided "));
    }

    #[test]
    fn elision_stops_when_the_pass_budget_is_spent() {
        // One fold of this size exhausts the per-pass budget, so the second
        // message keeps its block.
        let ladder = ladder_at_depth(400, 1);
        let huge = fenced_block(20_000);
        let mut messages = vec![
            tool_result_with_text(&huge),
            tool_result_with_text(&fenced_block(300)),
        ];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 1);
        assert!(messages[0].content.to_string().contains("[Elided "));
        assert!(messages[1].content.to_string().contains("let value_0"));
    }

    #[test]
    fn deepening_lowers_the_threshold() {
        let mut ladder = RequestElisionLadder::new(true, 400);
        // ~30 short lines stay under the 400-token depth-1 threshold but
        // clear the 200-token depth-2 threshold.
        let mut messages = vec![tool_result_with_text(&fenced_block(30))];
        ladder.deepen();
        assert!(ladder.active());
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 0, "depth 1 keeps the 400 threshold");
        ladder.deepen();
        let report = ladder.apply(&mut messages);
        assert_eq!(
            report.elided_blocks, 1,
            "depth 2 lowers the threshold to 200"
        );
    }

    #[test]
    fn unterminated_blocks_and_mixed_case_xml_are_preserved() {
        let text = "start\n```rust\nnever closed\nmore code\nand <NotXml> stays\n";
        let ladder = ladder_at_depth(1, 1);
        let mut messages = vec![tool_result_with_text(text)];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 0);
        assert!(messages[0].content.to_string().contains("never closed"));
    }

    #[test]
    fn complete_top_level_xml_blocks_are_elided() {
        let text = "<result>\nline one\nline two\n</result>\nafter\n";
        let ladder = ladder_at_depth(1, 1);
        let mut messages = vec![tool_result_with_text(text)];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 1);
        let folded = messages[0].content.to_string();
        assert!(folded.contains("xml block from Read]"));
        assert!(!folded.contains("line one"));
        assert!(folded.contains("after"));
    }

    #[test]
    fn user_and_plain_text_messages_fold_their_fences() {
        let ladder = ladder_at_depth(400, 1);
        let mut messages = vec![
            Message::user(format!("Please use this:\n{}", fenced_block(300))),
            Message::assistant("plain answer without blocks".to_string()),
        ];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 1);
        assert!(messages[0].content.to_string().contains("[Elided "));
        assert!(messages[1].content.to_string().contains("plain answer"));
    }

    #[test]
    fn tool_results_without_assistant_text_are_untouched() {
        let mut message = Message::assistant("working".to_string());
        message.content = MessageContent::ToolResult {
            tool_id: "tool-1".to_string(),
            tool_name: "Read".to_string(),
            effective_tool_name: None,
            result: serde_json::json!({ "content": fenced_block(300) }),
            result_for_assistant: None,
            is_error: false,
            image_attachments: None,
        };
        let ladder = ladder_at_depth(1, 1);
        let mut messages = vec![message];
        let report = ladder.apply(&mut messages);
        assert_eq!(report.elided_blocks, 0);
        assert!(messages[0].content.to_string().contains("content"));
    }
}
