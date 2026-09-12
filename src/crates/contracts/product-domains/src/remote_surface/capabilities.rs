//! Typed peer host capability advertisement.
//!
//! `peer_mode_ping` answers with a `capabilities` object whose keys a
//! controller consults before sending a command that an older host may not
//! implement. Both peer hosts used to hand-write that object, which is how the
//! Desktop and CLI lists drifted apart and how keys ended up advertised but
//! never consulted. This module is the single list: a host publishes exactly
//! `advertised_by(host)`, and the generated frontend artifact carries the same
//! ids so a controller cannot probe for a key that no host will ever send.
//!
//! Wire rule: a host publishes only the keys it supports, each with value
//! `true`. A missing key means "older host, unknown"; controllers resolve that
//! through `host_type`. Publishing `false` would change that meaning, so
//! `capability_map` never emits it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::PeerHostKind;

/// A capability a peer host may advertise in `peer_mode_ping`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerHostCapability {
    /// `start_dialog_turn` / `start_acp_dialog_turn` may be retried with the
    /// same `(sessionId, turnId)`; the host coalesces duplicate attempts.
    IdempotentDialogSubmit,
    /// Inline imageContexts are durably prepared by the receiving Runtime.
    InlineImageAttachmentsV1,
    /// Identity-based `rollback_session_to_turn` is implemented.
    TargetedSessionRollback,
    /// `get_token_usage_statistics` is implemented.
    TokenUsageStatistics,
    /// `miniapp_agent_run` accepts non-empty `contextFiles`.
    MiniappAgentContextFilesV1,
    /// WSL profiles and discovery are understood; availability is probed on the host.
    WslWorkspacesV1,
    /// `product_control_invoke` is implemented (shared config contract).
    ProductControlV1,
    /// ProductControl definitions that need a host-native provider run here.
    ProductControlNativeV1,
    /// ProductControl definitions that need a live presentation surface run here.
    ProductControlPresentationV1,
    /// Per-tool `cancel_tool` is implemented.
    CancelTool,
    /// Read-only `get_all_tools_info` catalog is implemented.
    ToolCatalog,
    /// Mode/workspace-scoped `get_chat_mcp_catalog` is implemented.
    ChatMcpCatalogV1,
    /// `submit_user_answers` is implemented for Runtime-owned questions.
    UserQuestionResponse,
}

impl PeerHostCapability {
    /// Every capability id, in wire order.
    pub const ALL: &'static [PeerHostCapability] = &[
        Self::IdempotentDialogSubmit,
        Self::InlineImageAttachmentsV1,
        Self::TargetedSessionRollback,
        Self::TokenUsageStatistics,
        Self::MiniappAgentContextFilesV1,
        Self::WslWorkspacesV1,
        Self::ProductControlV1,
        Self::ProductControlNativeV1,
        Self::ProductControlPresentationV1,
        Self::CancelTool,
        Self::ToolCatalog,
        Self::ChatMcpCatalogV1,
        Self::UserQuestionResponse,
    ];

    /// The key used in the `peer_mode_ping` `capabilities` object.
    pub const fn key(self) -> &'static str {
        match self {
            Self::IdempotentDialogSubmit => "idempotent_dialog_submit",
            Self::InlineImageAttachmentsV1 => "inline_image_attachments_v1",
            Self::TargetedSessionRollback => "targeted_session_rollback",
            Self::TokenUsageStatistics => "token_usage_statistics",
            Self::MiniappAgentContextFilesV1 => "miniapp_agent_context_files_v1",
            Self::WslWorkspacesV1 => "wsl_workspaces_v1",
            Self::ProductControlV1 => "product_control_v1",
            Self::ProductControlNativeV1 => "product_control_native_v1",
            Self::ProductControlPresentationV1 => "product_control_presentation_v1",
            Self::CancelTool => "cancel_tool",
            Self::ToolCatalog => "tool_catalog",
            Self::ChatMcpCatalogV1 => "chat_mcp_catalog_v1",
            Self::UserQuestionResponse => "user_question_response",
        }
    }

    /// Parse a wire key back into a capability.
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|value| value.key() == key)
    }
}

const DESKTOP_CAPABILITIES: &[PeerHostCapability] = PeerHostCapability::ALL;

/// The CLI peer host has no MiniApp runtime, WSL connection setup, host-native
/// ProductControl providers, or presentation surface.
const CLI_CAPABILITIES: &[PeerHostCapability] = &[
    PeerHostCapability::IdempotentDialogSubmit,
    PeerHostCapability::InlineImageAttachmentsV1,
    PeerHostCapability::TargetedSessionRollback,
    PeerHostCapability::TokenUsageStatistics,
    PeerHostCapability::ProductControlV1,
    PeerHostCapability::CancelTool,
    PeerHostCapability::ToolCatalog,
    PeerHostCapability::ChatMcpCatalogV1,
    PeerHostCapability::UserQuestionResponse,
];

/// The capabilities a peer host of the given kind publishes.
pub const fn advertised_by(host: PeerHostKind) -> &'static [PeerHostCapability] {
    match host {
        PeerHostKind::Desktop => DESKTOP_CAPABILITIES,
        PeerHostKind::Cli => CLI_CAPABILITIES,
    }
}

/// Whether a peer host of the given kind publishes the capability.
pub fn advertises(host: PeerHostKind, capability: PeerHostCapability) -> bool {
    advertised_by(host).contains(&capability)
}

/// The `capabilities` object for `peer_mode_ping`: only advertised keys, all `true`.
pub fn capability_map(host: PeerHostKind) -> Map<String, Value> {
    advertised_by(host)
        .iter()
        .map(|capability| (capability.key().to_string(), Value::Bool(true)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_keys_are_unique_snake_case_and_round_trip() {
        let mut seen = std::collections::BTreeSet::new();
        for capability in PeerHostCapability::ALL {
            let key = capability.key();
            assert!(
                key.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "capability key must be snake_case: {key}"
            );
            assert!(seen.insert(key), "duplicate capability key {key}");
            assert_eq!(PeerHostCapability::from_key(key), Some(*capability));
            let wire = serde_json::to_value(capability).unwrap();
            assert_eq!(wire, Value::String(key.to_string()));
        }
    }

    #[test]
    fn desktop_advertises_a_superset_of_cli() {
        for capability in advertised_by(PeerHostKind::Cli) {
            assert!(
                advertises(PeerHostKind::Desktop, *capability),
                "desktop must advertise every CLI capability: {}",
                capability.key()
            );
        }
        assert_eq!(
            advertised_by(PeerHostKind::Desktop).len(),
            PeerHostCapability::ALL.len()
        );
    }

    #[test]
    fn capability_map_emits_only_true_for_advertised_keys() {
        for host in [PeerHostKind::Desktop, PeerHostKind::Cli] {
            let map = capability_map(host);
            assert_eq!(map.len(), advertised_by(host).len());
            for (key, value) in &map {
                assert_eq!(value, &Value::Bool(true), "{key} must be published as true");
                assert!(PeerHostCapability::from_key(key).is_some());
            }
        }
        let cli = capability_map(PeerHostKind::Cli);
        assert!(!cli.contains_key("miniapp_agent_context_files_v1"));
        assert!(!cli.contains_key("product_control_native_v1"));
        assert!(!cli.contains_key("product_control_presentation_v1"));
    }
}
