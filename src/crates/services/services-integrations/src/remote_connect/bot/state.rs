use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::menu::{MenuItem, MenuItemStyle, MenuView};

const PENDING_TTL_SECS: i64 = 5 * 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum BotDisplayMode {
    #[serde(rename = "pro")]
    Pro,
    #[serde(rename = "assistant")]
    #[default]
    Assistant,
}

/// Workspace selection retained by the bot, including SSH identity when remote.
///
/// Persisted bot state historically stored `current_workspace` as a bare path
/// string. Deserialization still accepts that form and upgrades it in memory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BotWorkspaceRef {
    /// Absent only in pre-ID persisted state or responses from legacy peers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

impl BotWorkspaceRef {
    pub fn local(path: impl Into<String>) -> Self {
        Self {
            workspace_id: None,
            path: path.into(),
            remote_connection_id: None,
            remote_ssh_host: None,
        }
    }

    pub fn with_identity(
        path: impl Into<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
    ) -> Self {
        Self {
            workspace_id: None,
            path: path.into(),
            remote_connection_id: remote_connection_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            remote_ssh_host: remote_ssh_host
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        }
    }

    pub fn with_workspace_id(mut self, workspace_id: Option<String>) -> Self {
        self.workspace_id = workspace_id;
        self
    }

    pub fn path(&self) -> &str {
        &self.path
    }
}

fn deserialize_optional_workspace_ref<'de, D>(
    deserializer: D,
) -> Result<Option<BotWorkspaceRef>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Null,
        Path(String),
        Full(BotWorkspaceRef),
    }

    match Option::<Raw>::deserialize(deserializer)? {
        None | Some(Raw::Null) => Ok(None),
        Some(Raw::Path(path)) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(BotWorkspaceRef::local(trimmed)))
            }
        }
        Some(Raw::Full(workspace)) => {
            if workspace.path.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(workspace))
            }
        }
    }
}

/// One selectable workspace row in the bot `/switch` picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotWorkspaceChoice {
    pub workspace_id: Option<String>,
    pub path: String,
    pub name: String,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
}

impl BotWorkspaceChoice {
    pub fn new(
        path: impl Into<String>,
        name: impl Into<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
    ) -> Self {
        Self {
            workspace_id: None,
            path: path.into(),
            name: name.into(),
            remote_connection_id,
            remote_ssh_host,
        }
    }

    pub fn with_workspace_id(mut self, workspace_id: Option<String>) -> Self {
        self.workspace_id = workspace_id;
        self
    }

    pub fn to_workspace_ref(&self) -> BotWorkspaceRef {
        BotWorkspaceRef::with_identity(
            self.path.clone(),
            self.remote_connection_id.clone(),
            self.remote_ssh_host.clone(),
        )
        .with_workspace_id(self.workspace_id.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotChatState {
    pub chat_id: String,
    pub paired: bool,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_workspace_ref",
        skip_serializing_if = "Option::is_none"
    )]
    pub current_workspace: Option<BotWorkspaceRef>,
    /// Legacy path retained for old readers; selection uses current_assistant_id.
    pub current_assistant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_assistant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_assistant_name: Option<String>,
    pub current_session_id: Option<String>,
    #[serde(default)]
    pub display_mode: BotDisplayMode,
    #[serde(skip)]
    pub pending_action: Option<PendingAction>,
    #[serde(skip)]
    pub pending_remote_target: Option<RemoteBotTarget>,
    #[serde(skip)]
    pub pending_interactions: std::collections::VecDeque<BotInteractiveRequest>,
    #[serde(skip)]
    pub pending_expires_at: i64,
    #[serde(skip)]
    pub pending_invalid_count: u8,
    #[serde(skip, default)]
    pub last_menu_commands: Vec<String>,
    /// Relay base URL the bot should hit for multi-device control. Set by the
    /// desktop when the bot is paired so the bot can reach the same relay.
    #[serde(skip, default)]
    pub relay_url: Option<String>,
    /// Delegated account token + master key for multi-device control. Set by
    /// the desktop layer when the paired desktop has account login. These are
    /// in-memory only (`serde(skip)`) — the master key is never persisted,
    /// mirroring the `AccountSession.master_key` in-memory-only contract.
    #[serde(skip, default)]
    pub delegated_token: Option<String>,
    #[serde(skip, default)]
    pub delegated_master_key: Option<Vec<u8>>,
    /// When Some, the bot operates on a remote device via HTTP RPC instead
    /// of the local desktop. Set by `/devices` → pick a device.
    /// Cleared by `/devices` → pick "local" or selecting an offline device.
    #[serde(skip, default)]
    pub active_remote_device: Option<RemoteDeviceTarget>,
    /// Records that the serializable workspace/session fields currently belong
    /// to an account-routed device. The device target itself and delegated
    /// credentials intentionally stay in memory only, but this marker must be
    /// persisted so a restart cannot reinterpret a remote path/session as a
    /// local desktop context.
    #[serde(default, skip_serializing_if = "is_false")]
    pub account_remote_context: bool,
}

/// A remote device the bot has switched to. All subsequent bot commands
/// (create_session, send_message, list_sessions, etc.) are routed to this
/// device via the relay HTTP RPC API instead of executing locally.
#[derive(Debug, Clone)]
pub struct RemoteDeviceTarget {
    pub device_id: String,
    pub device_name: String,
}

/// Immutable route for one submitted turn and its interactions. Never persisted.
#[derive(Debug, Clone)]
pub struct RemoteBotTarget {
    pub relay_url: String,
    pub device_id: String,
    pub device_name: String,
    pub session_id: String,
    pub account: crate::remote_connect::account::AccountSession,
}

impl BotChatState {
    pub fn assistant_workspace_ref(&self) -> Option<BotWorkspaceRef> {
        if self.current_assistant_id.is_none() && self.current_assistant.is_none() {
            return None;
        }
        let mut reference =
            BotWorkspaceRef::local(self.current_assistant.clone().unwrap_or_default());
        reference.workspace_id = self.current_assistant_id.clone();
        Some(reference)
    }

    pub fn new(chat_id: String) -> Self {
        Self {
            chat_id,
            paired: false,
            current_workspace: None,
            current_assistant: None,
            current_assistant_id: None,
            current_assistant_name: None,
            current_session_id: None,
            display_mode: BotDisplayMode::Assistant,
            pending_action: None,
            pending_remote_target: None,
            pending_interactions: Default::default(),
            pending_expires_at: 0,
            pending_invalid_count: 0,
            last_menu_commands: Vec::new(),
            relay_url: None,
            delegated_token: None,
            delegated_master_key: None,
            active_remote_device: None,
            account_remote_context: false,
        }
    }

    pub fn active_workspace_path(&self) -> Option<String> {
        self.current_workspace
            .as_ref()
            .map(|workspace| workspace.path.clone())
            .or_else(|| self.current_assistant.clone())
    }

    pub fn current_workspace_path(&self) -> Option<&str> {
        self.current_workspace.as_ref().map(BotWorkspaceRef::path)
    }

    pub fn current_workspace_identity(&self) -> (Option<String>, Option<String>) {
        self.current_workspace
            .as_ref()
            .map(|workspace| {
                (
                    workspace.remote_connection_id.clone(),
                    workspace.remote_ssh_host.clone(),
                )
            })
            .unwrap_or((None, None))
    }

    pub fn set_pending(&mut self, action: PendingAction) {
        self.pending_action = Some(action);
        self.pending_expires_at = now_secs() + PENDING_TTL_SECS;
        self.pending_invalid_count = 0;
    }

    pub fn clear_pending(&mut self) {
        self.pending_action = None;
        self.pending_remote_target = None;
        self.pending_interactions.clear();
        self.pending_expires_at = 0;
        self.pending_invalid_count = 0;
    }

    pub fn pending_expired(&self) -> bool {
        self.pending_action.is_some() && now_secs() > self.pending_expires_at
    }

    /// Install the desktop's delegated account identity (token + master key)
    /// so the bot can call the relay's device-control endpoints directly.
    /// The master key is kept in memory only; callers must never persist it.
    pub fn set_delegated_identity(&mut self, token: String, master_key: Vec<u8>) {
        self.delegated_token = Some(token);
        self.delegated_master_key = Some(master_key);
    }

    /// Whether a delegated account identity is available for multi-device
    /// control. Both the token and the master key must be present.
    pub fn has_delegated_identity(&self) -> bool {
        self.delegated_token.is_some() && self.delegated_master_key.is_some()
    }

    /// Switch command routing to an account device and fence every workspace
    /// or session selection made for the previous target.
    pub fn select_remote_device(&mut self, target: RemoteDeviceTarget) {
        self.clear_device_scoped_context();
        self.active_remote_device = Some(target);
        self.account_remote_context = true;
    }

    /// Return command routing to this desktop without leaking a remote
    /// workspace/session into local execution.
    pub fn select_local_device(&mut self) {
        let was_remote = self.active_remote_device.take().is_some() || self.account_remote_context;
        self.account_remote_context = false;
        if was_remote {
            self.clear_device_scoped_context();
        }
    }

    /// Sanitize state loaded from disk. Delegated authority is never restored,
    /// and a persisted remote-context marker makes its workspace/session
    /// selections invalid on a fresh process.
    pub fn prepare_for_restore(&mut self) {
        if self.account_remote_context {
            self.clear_delegated_identity();
        }
    }

    /// Remove every account-bound value when the desktop account changes.
    /// A bot chat can outlive many desktop login sessions, so retaining these
    /// fields would either keep controlling the previous account or replay an
    /// old device selection with the replacement account's credentials.
    pub fn clear_delegated_identity(&mut self) {
        self.relay_url = None;
        self.delegated_token = None;
        self.delegated_master_key = None;

        let was_remote = self.active_remote_device.take().is_some() || self.account_remote_context;
        self.account_remote_context = false;
        let had_remote_interaction = self.pending_remote_target.is_some()
            || self
                .pending_interactions
                .iter()
                .any(|request| request.remote_target.is_some());
        let was_selecting_device = matches!(
            self.pending_action,
            Some(PendingAction::SelectDevice { .. })
        );
        if was_remote {
            // Workspace/session selections made while targeting a remote
            // device are owned by that account and must not fall through to
            // local execution after the remote target is cleared.
            self.clear_device_scoped_context();
        }
        if was_remote || was_selecting_device || had_remote_interaction {
            self.clear_pending();
            self.last_menu_commands.clear();
        }
    }

    fn clear_device_scoped_context(&mut self) {
        self.current_workspace = None;
        self.current_assistant = None;
        self.current_assistant_id = None;
        self.current_assistant_name = None;
        self.current_session_id = None;
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub enum PendingAction {
    ConfirmRemoteTool {
        tool_id: String,
        action_token: String,
        description: String,
    },
    SelectWorkspace {
        options: Vec<BotWorkspaceChoice>,
    },
    SelectAssistant {
        options: Vec<(String, String)>,
    },
    SelectSession {
        options: Vec<(String, String)>,
        page: usize,
        has_more: bool,
    },
    SelectModel {
        options: Vec<(String, String)>,
    },
    AskUserQuestion {
        tool_id: String,
        questions: Vec<BotQuestion>,
        current_index: usize,
        answers: Vec<Value>,
        awaiting_custom_text: bool,
        pending_answer: Option<Value>,
    },
    ConfirmModeSwitch {
        target_mode: BotDisplayMode,
        target_cmd: String,
    },
    /// User is picking a device from the /devices list to switch context to.
    /// `options` is `(device_id, device_name)`; index 0 = "local" (clear).
    SelectDevice {
        options: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotQuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotQuestion {
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub header: String,
    #[serde(default)]
    pub options: Vec<BotQuestionOption>,
    #[serde(rename = "multiSelect", default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BotActionStyle {
    Primary,
    Default,
}

#[derive(Debug, Clone)]
pub struct BotAction {
    pub label: String,
    pub command: String,
    pub style: BotActionStyle,
}

impl BotAction {
    pub fn primary(label: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            command: command.into(),
            style: BotActionStyle::Primary,
        }
    }

    pub fn secondary(label: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            command: command.into(),
            style: BotActionStyle::Default,
        }
    }
}

impl From<MenuItem> for BotAction {
    fn from(item: MenuItem) -> Self {
        let style = match item.style {
            MenuItemStyle::Primary => BotActionStyle::Primary,
            _ => BotActionStyle::Default,
        };
        BotAction {
            label: item.label,
            command: item.command,
            style,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BotInteractiveRequest {
    pub remote_target: Option<RemoteBotTarget>,
    pub reply: String,
    pub actions: Vec<BotAction>,
    pub menu: MenuView,
    pub pending_action: PendingAction,
}

pub type BotInteractionHandler =
    Arc<dyn Fn(BotInteractiveRequest) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub type BotMessageSender =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_id_survives_storage_and_overrides_stale_path() {
        let mut state = BotChatState::new("chat".into());
        state.current_assistant_id = Some("assistant-id".into());
        state.current_assistant = Some("/old/folder".into());
        let restored: BotChatState =
            serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
        let reference = restored.assistant_workspace_ref().unwrap();
        assert_eq!(reference.workspace_id.as_deref(), Some("assistant-id"));
        assert_eq!(reference.path, "/old/folder");
    }

    #[test]
    fn active_workspace_path_prefers_workspace_then_assistant() {
        let mut state = BotChatState::new("chat".into());
        assert_eq!(state.active_workspace_path(), None);

        state.current_assistant = Some("/assistant".into());
        assert_eq!(state.active_workspace_path().as_deref(), Some("/assistant"));

        state.current_workspace = Some(BotWorkspaceRef::local("/workspace"));
        assert_eq!(state.active_workspace_path().as_deref(), Some("/workspace"));
    }

    #[test]
    fn pending_state_sets_expires_and_clear_resets_transient_fields() {
        let mut state = BotChatState::new("chat".into());
        state.set_pending(PendingAction::SelectWorkspace { options: vec![] });
        assert!(state.pending_action.is_some());
        assert!(state.pending_expires_at > 0);
        assert_eq!(state.pending_invalid_count, 0);

        state.pending_invalid_count = 2;
        state.clear_pending();

        assert!(state.pending_action.is_none());
        assert_eq!(state.pending_expires_at, 0);
        assert_eq!(state.pending_invalid_count, 0);
    }

    #[test]
    fn clearing_delegated_identity_drops_remote_account_state() {
        let mut state = BotChatState::new("chat".into());
        state.relay_url = Some("https://relay-a.example".into());
        state.set_delegated_identity("token-a".into(), vec![7; 32]);
        state.select_remote_device(RemoteDeviceTarget {
            device_id: "device-a".into(),
            device_name: "Device A".into(),
        });
        state.current_workspace = Some(BotWorkspaceRef::local("/remote/a"));
        state.current_assistant = Some("/remote/a".into());
        state.current_assistant_name = Some("Remote A".into());
        state.current_session_id = Some("session-a".into());
        state.set_pending(PendingAction::SelectSession {
            options: vec![],
            page: 0,
            has_more: false,
        });
        state.last_menu_commands = vec!["/sessions".into()];

        state.clear_delegated_identity();

        assert!(state.relay_url.is_none());
        assert!(!state.has_delegated_identity());
        assert!(state.active_remote_device.is_none());
        assert!(state.current_workspace.is_none());
        assert!(state.current_assistant.is_none());
        assert!(state.current_assistant_name.is_none());
        assert!(state.current_session_id.is_none());
        assert!(state.pending_action.is_none());
        assert!(state.last_menu_commands.is_empty());
    }

    #[test]
    fn persisted_remote_context_is_sanitized_during_restore() {
        let mut state = BotChatState::new("chat".into());
        state.paired = true;
        state.select_remote_device(RemoteDeviceTarget {
            device_id: "device-a".into(),
            device_name: "Device A".into(),
        });
        state.current_workspace = Some(BotWorkspaceRef::local("/remote/a"));
        state.current_assistant = Some("/remote/a".into());
        state.current_assistant_name = Some("Remote A".into());
        state.current_session_id = Some("session-a".into());

        let encoded = serde_json::to_string(&state).expect("state should serialize");
        assert!(encoded.contains("account_remote_context"));
        assert!(!encoded.contains("device-a"));

        let mut restored: BotChatState =
            serde_json::from_str(&encoded).expect("state should deserialize");
        assert!(restored.active_remote_device.is_none());
        assert!(restored.account_remote_context);

        restored.prepare_for_restore();

        assert!(!restored.account_remote_context);
        assert!(restored.current_workspace.is_none());
        assert!(restored.current_assistant.is_none());
        assert!(restored.current_assistant_name.is_none());
        assert!(restored.current_session_id.is_none());

        let reencoded = serde_json::to_string(&restored).expect("restored state should serialize");
        let recovered_again: BotChatState =
            serde_json::from_str(&reencoded).expect("clean state should deserialize");
        assert!(!recovered_again.account_remote_context);
        assert!(recovered_again.current_workspace.is_none());
        assert!(recovered_again.current_session_id.is_none());
    }

    #[test]
    fn switching_back_to_local_drops_remote_context() {
        let mut state = BotChatState::new("chat".into());
        state.select_remote_device(RemoteDeviceTarget {
            device_id: "device-a".into(),
            device_name: "Device A".into(),
        });
        state.current_workspace = Some(BotWorkspaceRef::local("/remote/a"));
        state.current_session_id = Some("session-a".into());

        state.select_local_device();

        assert!(state.active_remote_device.is_none());
        assert!(!state.account_remote_context);
        assert!(state.current_workspace.is_none());
        assert!(state.current_session_id.is_none());
    }

    #[test]
    fn current_workspace_deserializes_legacy_path_string() {
        let state: BotChatState = serde_json::from_value(serde_json::json!({
            "chat_id": "c1",
            "paired": true,
            "current_workspace": "/root/repos",
            "current_assistant": null,
            "current_session_id": null,
            "display_mode": "pro"
        }))
        .expect("legacy path string must deserialize");

        assert_eq!(
            state.current_workspace,
            Some(BotWorkspaceRef::local("/root/repos"))
        );
    }

    #[test]
    fn current_workspace_deserializes_identity_object() {
        let state: BotChatState = serde_json::from_value(serde_json::json!({
            "chat_id": "c1",
            "paired": true,
            "current_workspace": {
                "path": "/root/repos",
                "remote_connection_id": "conn-a",
                "remote_ssh_host": "host-a"
            },
            "current_assistant": null,
            "current_session_id": null,
            "display_mode": "pro"
        }))
        .expect("identity object must deserialize");

        assert_eq!(
            state.current_workspace,
            Some(BotWorkspaceRef::with_identity(
                "/root/repos",
                Some("conn-a".into()),
                Some("host-a".into()),
            ))
        );
        assert_eq!(
            state.current_workspace_identity(),
            (Some("conn-a".into()), Some("host-a".into()))
        );
    }
}
