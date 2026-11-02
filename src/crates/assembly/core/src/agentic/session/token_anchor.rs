use crate::agentic::core::{Message, MessageRole, MessageSemanticKind};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const TOKEN_ANCHOR_RECENT_RETAIN_COUNT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenAnchor {
    pub anchor_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub round_id: String,
    pub prefix_message_count: usize,
    pub prefix_last_message_id: Option<String>,
    pub prefix_digest: String,
    pub model_id: String,
    pub input_tokens: usize,
    pub system_tokens_at_anchor: usize,
    pub tool_tokens_at_anchor: usize,
    pub prepended_reminder_tokens_at_anchor: usize,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenAnchorSkip {
    pub anchor_id: String,
    pub prefix_message_count: usize,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenAnchorSelection {
    pub selected: Option<TokenAnchor>,
    pub skipped: Vec<TokenAnchorSkip>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenAnchorRetentionStats {
    pub before: usize,
    pub after: usize,
    pub removed: usize,
    pub recent_limit: usize,
    pub retained_recent: usize,
    pub retained_turn_boundaries: usize,
}

#[derive(Debug, Clone)]
pub struct TokenAnchorInput {
    pub session_id: String,
    pub turn_id: String,
    pub round_id: String,
    pub model_id: String,
    pub input_tokens: usize,
    pub system_tokens_at_anchor: usize,
    pub tool_tokens_at_anchor: usize,
    pub prepended_reminder_tokens_at_anchor: usize,
}

impl TokenAnchor {
    pub fn from_request_prefix(input: TokenAnchorInput, messages: &[Message]) -> Self {
        Self {
            anchor_id: format!("token_anchor_{}", Uuid::new_v4()),
            session_id: input.session_id,
            turn_id: input.turn_id,
            round_id: input.round_id,
            prefix_message_count: messages.len(),
            prefix_last_message_id: messages.last().map(|message| message.id.clone()),
            prefix_digest: digest_message_prefix(messages),
            model_id: input.model_id,
            input_tokens: input.input_tokens,
            system_tokens_at_anchor: input.system_tokens_at_anchor,
            tool_tokens_at_anchor: input.tool_tokens_at_anchor,
            prepended_reminder_tokens_at_anchor: input.prepended_reminder_tokens_at_anchor,
            created_at_unix_ms: current_unix_ms(),
        }
    }

    pub fn matches_prefix(&self, messages: &[Message]) -> bool {
        self.prefix_mismatch_reason(messages).is_none()
    }

    pub fn prefix_mismatch_reason(&self, messages: &[Message]) -> Option<String> {
        if self.prefix_message_count > messages.len() {
            return Some(format!(
                "anchor_prefix_longer_than_messages(anchor_prefix={}, messages={})",
                self.prefix_message_count,
                messages.len()
            ));
        }

        match (
            self.prefix_message_count,
            self.prefix_last_message_id.as_deref(),
        ) {
            (0, None) => {}
            (0, Some(_)) => {
                return Some("empty_prefix_has_last_message_id".to_string());
            }
            (count, Some(last_id)) => {
                let current_last_id = messages.get(count - 1).map(|message| message.id.as_str());
                if current_last_id != Some(last_id) {
                    return Some(format!(
                        "prefix_last_message_id_mismatch(expected={}, actual={})",
                        last_id,
                        current_last_id.unwrap_or("<missing>")
                    ));
                }
            }
            (_, None) => {
                return Some("non_empty_prefix_missing_last_message_id".to_string());
            }
        }

        let current_digest = digest_message_prefix(&messages[..self.prefix_message_count]);
        if current_digest != self.prefix_digest {
            return Some(format!(
                "prefix_digest_mismatch(expected={}, actual={})",
                self.prefix_digest, current_digest
            ));
        }

        None
    }
}

#[derive(Debug, Default)]
pub struct TokenAnchorStore {
    anchors_by_session: DashMap<String, Vec<TokenAnchor>>,
}

impl TokenAnchorStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.anchors_by_session.contains_key(session_id)
    }

    pub fn create_session(&self, session_id: &str) {
        self.anchors_by_session
            .entry(session_id.to_string())
            .or_default();
    }

    pub fn replace_session(
        &self,
        session_id: &str,
        mut anchors: Vec<TokenAnchor>,
    ) -> Option<TokenAnchorRetentionStats> {
        let retention = apply_anchor_retention(&mut anchors, TOKEN_ANCHOR_RECENT_RETAIN_COUNT);
        self.anchors_by_session
            .insert(session_id.to_string(), anchors);
        retention
    }

    pub fn append(&self, anchor: TokenAnchor) -> Option<TokenAnchorRetentionStats> {
        let mut anchors = self
            .anchors_by_session
            .entry(anchor.session_id.clone())
            .or_default();
        anchors.push(anchor);
        apply_anchor_retention(&mut anchors, TOKEN_ANCHOR_RECENT_RETAIN_COUNT)
    }

    pub fn anchors(&self, session_id: &str) -> Vec<TokenAnchor> {
        self.anchors_by_session
            .get(session_id)
            .map(|anchors| anchors.clone())
            .unwrap_or_default()
    }

    pub fn latest_matching(&self, session_id: &str, messages: &[Message]) -> Option<TokenAnchor> {
        self.select_latest_matching(session_id, messages).selected
    }

    pub fn select_latest_matching(
        &self,
        session_id: &str,
        messages: &[Message],
    ) -> TokenAnchorSelection {
        self.select_latest_matching_for_model(session_id, messages, None)
    }

    /// Select the newest matching prefix produced by the requested model.
    ///
    /// Provider token counts are model-specific, so a mixed-model conversation
    /// must not reuse an anchor emitted by a different model.
    pub fn select_latest_matching_for_model(
        &self,
        session_id: &str,
        messages: &[Message],
        model_id: Option<&str>,
    ) -> TokenAnchorSelection {
        let Some(anchors) = self.anchors_by_session.get(session_id) else {
            return TokenAnchorSelection {
                selected: None,
                skipped: vec![TokenAnchorSkip {
                    anchor_id: "<none>".to_string(),
                    prefix_message_count: 0,
                    reason: "no_anchor_store_for_session".to_string(),
                }],
            };
        };

        let mut skipped = Vec::new();
        for anchor in anchors.iter().rev() {
            let mismatch = if model_id.is_some_and(|id| id != anchor.model_id) {
                Some("model_id_mismatch".to_string())
            } else {
                anchor.prefix_mismatch_reason(messages)
            };
            if let Some(reason) = mismatch {
                skipped.push(TokenAnchorSkip {
                    anchor_id: anchor.anchor_id.clone(),
                    prefix_message_count: anchor.prefix_message_count,
                    reason,
                });
                continue;
            }

            return TokenAnchorSelection {
                selected: Some(anchor.clone()),
                skipped,
            };
        }

        if skipped.is_empty() {
            skipped.push(TokenAnchorSkip {
                anchor_id: "<none>".to_string(),
                prefix_message_count: 0,
                reason: "no_anchors_recorded".to_string(),
            });
        }

        TokenAnchorSelection {
            selected: None,
            skipped,
        }
    }

    pub fn remove_non_matching(&self, session_id: &str, messages: &[Message]) {
        if let Some(mut anchors) = self.anchors_by_session.get_mut(session_id) {
            anchors.retain(|anchor| anchor.matches_prefix(messages));
        }
    }

    pub fn delete_session(&self, session_id: &str) {
        self.anchors_by_session.remove(session_id);
    }
}

fn apply_anchor_retention(
    anchors: &mut Vec<TokenAnchor>,
    recent_limit: usize,
) -> Option<TokenAnchorRetentionStats> {
    let before = anchors.len();
    if before <= recent_limit {
        return None;
    }

    let recent_start = before.saturating_sub(recent_limit);
    let retained_recent = before - recent_start;
    let mut retain_indices: HashSet<usize> = (recent_start..before).collect();
    let mut turn_boundaries: HashMap<String, (usize, usize)> = HashMap::new();

    for (index, anchor) in anchors.iter().enumerate() {
        turn_boundaries
            .entry(anchor.turn_id.clone())
            .and_modify(|(_, last)| *last = index)
            .or_insert((index, index));
    }

    let mut boundary_indices = HashSet::new();
    for (first, last) in turn_boundaries.values() {
        boundary_indices.insert(*first);
        boundary_indices.insert(*last);
    }
    retain_indices.extend(boundary_indices.iter().copied());

    if retain_indices.len() == before {
        return None;
    }

    let mut retained = Vec::with_capacity(retain_indices.len());
    for (index, anchor) in anchors.drain(..).enumerate() {
        if retain_indices.contains(&index) {
            retained.push(anchor);
        }
    }

    let after = retained.len();
    *anchors = retained;

    Some(TokenAnchorRetentionStats {
        before,
        after,
        removed: before - after,
        recent_limit,
        retained_recent,
        retained_turn_boundaries: boundary_indices.len(),
    })
}

pub fn digest_message_prefix(messages: &[Message]) -> String {
    let mut hasher = Sha256::new();
    for message in messages {
        if message.role != MessageRole::System {
            hasher.update(message.id.as_bytes());
            hasher.update([0]);
        }
        hasher.update(format!("{:?}", message.role).as_bytes());
        hasher.update([0]);
        if let Some(kind) = message.metadata.semantic_kind.as_ref() {
            hasher.update(semantic_kind_tag(kind).as_bytes());
        }
        hasher.update([0xff]);
    }
    hex_digest(hasher)
}

fn semantic_kind_tag(kind: &MessageSemanticKind) -> &'static str {
    match kind {
        MessageSemanticKind::ActualUserInput => "actual_user_input",
        MessageSemanticKind::InternalReminder => "internal_reminder",
        MessageSemanticKind::CompressionBoundaryMarker => "compression_boundary_marker",
        MessageSemanticKind::CompressionSummary => "compression_summary",
        MessageSemanticKind::ComputerUseVerificationScreenshot => {
            "computer_use_verification_screenshot"
        }
        MessageSemanticKind::ComputerUsePostActionSnapshot => "computer_use_post_action_snapshot",
    }
}

fn hex_digest(hasher: Sha256) -> String {
    format!("{:x}", hasher.finalize())
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::Message;
    use std::collections::HashSet;

    fn test_anchor(turn_index: usize, round_index: usize, global_index: usize) -> TokenAnchor {
        let messages = vec![
            Message::system("sys".to_string()),
            Message::user(format!("message-{global_index}")),
        ];
        TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: format!("turn-{turn_index}"),
                round_id: format!("round-{round_index}"),
                model_id: "model".to_string(),
                input_tokens: global_index,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &messages,
        )
    }

    #[test]
    fn model_pool_switch_does_not_reuse_other_models_token_counts() {
        let store = TokenAnchorStore::new();
        let messages = vec![Message::user("hello".into())];
        let mut anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".into(),
                turn_id: "turn".into(),
                round_id: "round".into(),
                model_id: "a".into(),
                input_tokens: 123,
                system_tokens_at_anchor: 0,
                tool_tokens_at_anchor: 0,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &messages,
        );
        store.append(anchor.clone());
        anchor.model_id = "b".into();
        anchor.input_tokens = 456;
        store.append(anchor);
        assert_eq!(
            store
                .select_latest_matching_for_model("session", &messages, Some("a"))
                .selected
                .unwrap()
                .input_tokens,
            123
        );
        let selection = store.select_latest_matching_for_model("session", &messages, Some("c"));
        assert!(selection.selected.is_none());
        assert!(selection
            .skipped
            .iter()
            .all(|skip| skip.reason == "model_id_mismatch"));
    }

    #[test]
    fn matching_anchor_survives_suffix_append() {
        let prefix = vec![
            Message::system("sys".to_string()),
            Message::user("hello".to_string()),
        ];
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &prefix,
        );

        let mut current = prefix;
        current.push(Message::assistant("answer".to_string()));

        assert!(anchor.matches_prefix(&current));
    }

    #[test]
    fn matching_anchor_rejects_truncated_prefix() {
        let prefix = vec![
            Message::system("sys".to_string()),
            Message::user("hello".to_string()),
        ];
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &prefix,
        );

        assert!(!anchor.matches_prefix(&prefix[..1]));
    }

    #[test]
    fn matching_anchor_allows_system_message_replacement() {
        let prefix = vec![
            Message::system("old sys".to_string()),
            Message::user("hello".to_string()),
        ];
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &prefix,
        );
        let current = vec![
            Message::system("new sys".to_string()),
            prefix[1].clone(),
            Message::assistant("answer".to_string()),
        ];

        assert!(anchor.matches_prefix(&current));
    }

    #[test]
    fn store_selects_older_anchor_after_suffix_rollback() {
        let first_prefix = vec![
            Message::system("sys".to_string()),
            Message::user("hello".to_string()),
        ];
        let mut second_prefix = first_prefix.clone();
        second_prefix.push(Message::assistant("answer".to_string()));
        let first_anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round-1".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &first_prefix,
        );
        let second_anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round-2".to_string(),
                model_id: "model".to_string(),
                input_tokens: 150,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &second_prefix,
        );
        let store = TokenAnchorStore::new();
        store.append(first_anchor.clone());
        store.append(second_anchor);

        let selected = store
            .latest_matching("session", &first_prefix)
            .expect("older anchor should remain usable after rollback");

        assert_eq!(selected.anchor_id, first_anchor.anchor_id);
    }

    #[test]
    fn store_does_not_reuse_anchor_from_another_model() {
        let prefix = vec![
            Message::system("sys".to_string()),
            Message::user("hello".to_string()),
        ];
        let primary_anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round-primary".to_string(),
                model_id: "primary-provider-model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &prefix,
        );
        let fast_anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round-fast".to_string(),
                model_id: "fast-provider-model".to_string(),
                input_tokens: 80,
                system_tokens_at_anchor: 10,
                tool_tokens_at_anchor: 20,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &prefix,
        );
        let store = TokenAnchorStore::new();
        store.append(primary_anchor.clone());
        store.append(fast_anchor);

        let selection = store.select_latest_matching_for_model(
            "session",
            &prefix,
            Some("primary-provider-model"),
        );

        assert_eq!(
            selection.selected.map(|anchor| anchor.anchor_id),
            Some(primary_anchor.anchor_id)
        );
        assert!(selection
            .skipped
            .iter()
            .any(|skip| skip.reason.contains("model_id_mismatch")));
    }

    #[test]
    fn store_retains_recent_anchors_and_turn_boundaries() {
        let store = TokenAnchorStore::new();
        let mut turn_boundaries = Vec::new();
        let mut global_index = 0;

        for turn_index in 0..3 {
            let first = global_index;
            for round_index in 0..80 {
                store.append(test_anchor(turn_index, round_index, global_index));
                global_index += 1;
            }
            turn_boundaries.push((first, global_index - 1));
        }

        let anchors = store.anchors("session");
        let retained_tokens = anchors
            .iter()
            .map(|anchor| anchor.input_tokens)
            .collect::<HashSet<_>>();
        let recent_start = global_index - TOKEN_ANCHOR_RECENT_RETAIN_COUNT;

        for token in recent_start..global_index {
            assert!(
                retained_tokens.contains(&token),
                "missing recent anchor {}",
                token
            );
        }

        for (first, last) in turn_boundaries {
            assert!(
                retained_tokens.contains(&first),
                "missing first turn anchor {}",
                first
            );
            assert!(
                retained_tokens.contains(&last),
                "missing last turn anchor {}",
                last
            );
        }

        assert!(!retained_tokens.contains(&1));
        assert!(!retained_tokens.contains(&81));
        assert!(anchors.len() <= TOKEN_ANCHOR_RECENT_RETAIN_COUNT + 6);
    }

    #[test]
    fn store_applies_retention_to_replaced_session() {
        let store = TokenAnchorStore::new();
        let anchors = (0..80)
            .map(|round_index| test_anchor(0, round_index, round_index))
            .collect::<Vec<_>>();

        let stats = store
            .replace_session("session", anchors)
            .expect("loaded anchors should be pruned");
        let retained_tokens = store
            .anchors("session")
            .iter()
            .map(|anchor| anchor.input_tokens)
            .collect::<HashSet<_>>();

        assert_eq!(stats.recent_limit, TOKEN_ANCHOR_RECENT_RETAIN_COUNT);
        assert!(retained_tokens.contains(&0));
        assert!(retained_tokens.contains(&79));
        assert!(retained_tokens.contains(&16));
        assert!(!retained_tokens.contains(&1));
    }
}
