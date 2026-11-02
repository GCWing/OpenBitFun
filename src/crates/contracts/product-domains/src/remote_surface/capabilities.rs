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
    ModelRoutingV1,
    ModelPoolSelectionV1,
    /// Versioned, execution-host-owned background report decisions are persisted and projected.
    BackgroundResultDeliveryV1,
    DialogQueueV1,
    /// `start_dialog_turn` / `start_acp_dialog_turn` may be retried with the
    /// same `(sessionId, turnId)`; the host coalesces duplicate attempts.
    IdempotentDialogSubmit,
    /// Inline imageContexts are durably prepared by the receiving Runtime.
    InlineImageAttachmentsV1,
    /// `btw_ask_stream` applies initial model and reasoning selection before the first turn.
    BtwInitialModelSelectionV1,
    /// BTW accepts typed initial model/pool choices and retains inherited bindings.
    BtwModelPoolSelectionV1,
    /// Persistent control conversations and idempotent voice history are available.
    ControlConversationV1,
    /// A fresh persistent control conversation can be selected without deleting history.
    ControlConversationResetV1,
    /// Identity-based `rollback_session_to_turn` is implemented.
    TargetedSessionRollback,
    /// `get_token_usage_statistics` is implemented.
    TokenUsageStatistics,
    /// Explicit subscription slots and account-aware management are implemented.
    SubscriptionAccountsV1,
    /// Independent slots/pools for Antigravity, OpenCode Zen, Grok and Hermes.
    SubscriptionProviderAccountsV1,
    /// Account-scoped vendor allowance snapshots are implemented.
    SubscriptionQuotaV1,
    /// Grok OAuth billing periods and on-demand usage are available.
    GrokQuotaV1,
    /// The quota command can read a saved API-key model by model_id.
    SubscriptionModelQuotaV1,
    /// Model configs support ordered pools and atomic `set_config.expectedModels`
    /// comparisons for editors of those bindings.
    SubscriptionAccountPoolsV1,
    /// Native model rounds can safely switch accounts within one attempt budget.
    SubscriptionAccountFailoverV1,
    /// Explicit cross-provider model channels and native failover are supported.
    ModelChannelRoutingV1,
    /// Account eligibility is independent of login and survives sign-out.
    SubscriptionAccountManagementV1,
    /// `miniapp_agent_run` accepts non-empty `contextFiles`.
    MiniappAgentContextFilesV1,
    /// `miniapp_agent_run` accepts and durably prepares inline `imageContexts`.
    MiniappAgentImagesV1,
    /// WSL profiles and discovery are understood; availability is probed on the host.
    WslWorkspacesV1,
    /// User-selected native window sharing and explicit permission receipts.
    ComputerUseSharingV1,
    /// `product_control_invoke` is implemented (shared config contract).
    ProductControlV1,
    /// Remote Connect bot and Mobile Web management on the executing host.
    RemoteConnectControlV1,
    /// ProductControl definitions that need a host-native provider run here.
    ProductControlNativeV1,
    /// ProductControl definitions that need a live presentation surface run here.
    ProductControlPresentationV1,
    /// Per-tool `cancel_tool` is implemented.
    CancelTool,
    /// Read-only `get_all_tools_info` catalog is implemented.
    ToolCatalog,
    /// Workspace-backed pull request context and detail pages are implemented.
    ReviewPlatformV1,
    /// Mode/workspace-scoped `get_chat_mcp_catalog` is implemented.
    ChatMcpCatalogV1,
    /// Workspace references can carry the owning host's persisted ID.
    WorkspaceIconV1,
    WorkspaceIdReferencesV1,
    /// Workspace-confined static resources for controller-owned HTML preview.
    WorkspaceHtmlPreviewV1,
    /// `copy_session` copies a whole session without a caller-selected turn id.
    WholeSessionCopyV1,
    /// Bounded session trajectory summaries and host-side body search.
    SessionTrajectoryV1,
    /// `submit_user_answers` is implemented for Runtime-owned questions.
    UserQuestionResponse,
    /// First human interaction disables the unattended question timeout.
    UserQuestionInteractionV1,
}

impl PeerHostCapability {
    /// Every capability id, in wire order.
    pub const ALL: &'static [PeerHostCapability] = &[
        Self::ModelRoutingV1,
        Self::ModelPoolSelectionV1,
        Self::BackgroundResultDeliveryV1,
        Self::DialogQueueV1,
        Self::IdempotentDialogSubmit,
        Self::InlineImageAttachmentsV1,
        Self::BtwInitialModelSelectionV1,
        Self::BtwModelPoolSelectionV1,
        Self::ControlConversationV1,
        Self::ControlConversationResetV1,
        Self::TargetedSessionRollback,
        Self::TokenUsageStatistics,
        Self::SubscriptionAccountsV1,
        Self::SubscriptionProviderAccountsV1,
        Self::SubscriptionQuotaV1,
        Self::GrokQuotaV1,
        Self::SubscriptionModelQuotaV1,
        Self::SubscriptionAccountPoolsV1,
        Self::SubscriptionAccountFailoverV1,
        Self::ModelChannelRoutingV1,
        Self::SubscriptionAccountManagementV1,
        Self::MiniappAgentContextFilesV1,
        Self::MiniappAgentImagesV1,
        Self::WslWorkspacesV1,
        Self::ComputerUseSharingV1,
        Self::ProductControlV1,
        Self::RemoteConnectControlV1,
        Self::ProductControlNativeV1,
        Self::ProductControlPresentationV1,
        Self::CancelTool,
        Self::ToolCatalog,
        Self::ReviewPlatformV1,
        Self::ChatMcpCatalogV1,
        Self::WorkspaceIconV1,
        Self::WorkspaceIdReferencesV1,
        Self::WorkspaceHtmlPreviewV1,
        Self::WholeSessionCopyV1,
        Self::SessionTrajectoryV1,
        Self::UserQuestionResponse,
        Self::UserQuestionInteractionV1,
    ];

    /// The key used in the `peer_mode_ping` `capabilities` object.
    pub const fn key(self) -> &'static str {
        match self {
            Self::ModelRoutingV1 => "model_routing_v1",
            Self::ModelPoolSelectionV1 => "model_pool_selection_v1",
            Self::BackgroundResultDeliveryV1 => "background_result_delivery_v1",
            Self::DialogQueueV1 => "dialog_queue_v1",
            Self::IdempotentDialogSubmit => "idempotent_dialog_submit",
            Self::InlineImageAttachmentsV1 => "inline_image_attachments_v1",
            Self::ControlConversationV1 => "control_conversation_v1",
            Self::ControlConversationResetV1 => "control_conversation_reset_v1",
            Self::BtwInitialModelSelectionV1 => "btw_initial_model_selection_v1",
            Self::BtwModelPoolSelectionV1 => "btw_model_pool_selection_v1",
            Self::TargetedSessionRollback => "targeted_session_rollback",
            Self::TokenUsageStatistics => "token_usage_statistics",
            Self::SubscriptionAccountsV1 => "subscription_accounts_v1",
            Self::SubscriptionProviderAccountsV1 => "subscription_provider_accounts_v1",
            Self::SubscriptionQuotaV1 => "subscription_quota_v1",
            Self::GrokQuotaV1 => "grok_quota_v1",
            Self::SubscriptionModelQuotaV1 => "subscription_model_quota_v1",
            Self::SubscriptionAccountPoolsV1 => "subscription_account_pools_v1",
            Self::SubscriptionAccountFailoverV1 => "subscription_account_failover_v1",
            Self::ModelChannelRoutingV1 => "model_channel_routing_v1",
            Self::SubscriptionAccountManagementV1 => "subscription_account_management_v1",
            Self::MiniappAgentContextFilesV1 => "miniapp_agent_context_files_v1",
            Self::MiniappAgentImagesV1 => "miniapp_agent_images_v1",
            Self::WslWorkspacesV1 => "wsl_workspaces_v1",
            Self::ComputerUseSharingV1 => "computer_use_sharing_v1",
            Self::ProductControlV1 => "product_control_v1",
            Self::RemoteConnectControlV1 => "remote_connect_control_v1",
            Self::ProductControlNativeV1 => "product_control_native_v1",
            Self::ProductControlPresentationV1 => "product_control_presentation_v1",
            Self::CancelTool => "cancel_tool",
            Self::ToolCatalog => "tool_catalog",
            Self::ReviewPlatformV1 => "review_platform_v1",
            Self::ChatMcpCatalogV1 => "chat_mcp_catalog_v1",
            Self::WorkspaceIconV1 => "workspace_icon_v1",
            Self::WorkspaceIdReferencesV1 => "workspace_id_references_v1",
            Self::WorkspaceHtmlPreviewV1 => "workspace_html_preview_v1",
            Self::SessionTrajectoryV1 => "session_trajectory_v1",
            Self::WholeSessionCopyV1 => "whole_session_copy_v1",
            Self::UserQuestionResponse => "user_question_response",
            Self::UserQuestionInteractionV1 => "user_question_interaction_v1",
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
    PeerHostCapability::ModelRoutingV1,
    PeerHostCapability::ModelPoolSelectionV1,
    PeerHostCapability::BackgroundResultDeliveryV1,
    PeerHostCapability::DialogQueueV1,
    PeerHostCapability::ControlConversationV1,
    PeerHostCapability::ControlConversationResetV1,
    PeerHostCapability::IdempotentDialogSubmit,
    PeerHostCapability::InlineImageAttachmentsV1,
    PeerHostCapability::BtwInitialModelSelectionV1,
    PeerHostCapability::BtwModelPoolSelectionV1,
    PeerHostCapability::TargetedSessionRollback,
    PeerHostCapability::TokenUsageStatistics,
    PeerHostCapability::ModelChannelRoutingV1,
    PeerHostCapability::ProductControlV1,
    PeerHostCapability::RemoteConnectControlV1,
    PeerHostCapability::CancelTool,
    PeerHostCapability::ToolCatalog,
    PeerHostCapability::SessionTrajectoryV1,
    PeerHostCapability::ChatMcpCatalogV1,
    PeerHostCapability::WorkspaceIconV1,
    PeerHostCapability::WorkspaceIdReferencesV1,
    PeerHostCapability::WorkspaceHtmlPreviewV1,
    PeerHostCapability::UserQuestionResponse,
    PeerHostCapability::UserQuestionInteractionV1,
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
        assert!(advertises(
            PeerHostKind::Desktop,
            PeerHostCapability::BtwInitialModelSelectionV1
        ));
        assert!(advertises(
            PeerHostKind::Cli,
            PeerHostCapability::BtwInitialModelSelectionV1
        ));
        assert!(advertises(
            PeerHostKind::Cli,
            PeerHostCapability::BtwModelPoolSelectionV1
        ));
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
        assert!(!cli.contains_key("miniapp_agent_images_v1"));
        assert_eq!(
            capability_map(PeerHostKind::Desktop)["miniapp_agent_images_v1"],
            true
        );
        assert!(!cli.contains_key("product_control_native_v1"));
        assert!(!cli.contains_key("product_control_presentation_v1"));
        assert!(!cli.contains_key("whole_session_copy_v1"));
        assert!(!cli.contains_key("review_platform_v1"));
        assert_eq!(
            capability_map(PeerHostKind::Desktop).get("review_platform_v1"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            capability_map(PeerHostKind::Desktop).get("whole_session_copy_v1"),
            Some(&Value::Bool(true))
        );
    }
}
