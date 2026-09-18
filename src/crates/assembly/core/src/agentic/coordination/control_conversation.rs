//! Persistent product-control conversation; media connections never own Sessions.
use super::ConversationCoordinator;
use crate::agentic::core::SessionConfig;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const CONTROL_SESSION_ID: &str = "openbitfun-control";
static ENSURE_CONTROL: Mutex<()> = Mutex::const_new(());

fn legacy_session_id() -> String {
    CONTROL_SESSION_ID.to_string()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlConversationState {
    #[serde(default = "legacy_session_id")]
    session_id: String,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for ControlConversationState {
    fn default() -> Self {
        Self {
            session_id: legacy_session_id(),
            extra: Default::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateControlConversationRequest {
    /// Compare-and-switch: retrying an acknowledged or concurrent reset returns
    /// the current conversation instead of creating another empty session.
    pub expected_session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlConversation {
    pub session_id: String,
    /// Owning workspace record of the control conversation. The directory is
    /// app-owned (never in the recent list); clients scope the session by ID.
    pub workspace_id: String,
    /// Execution root of the conversation; an IO projection, not identity.
    pub workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceExchangeRequest {
    pub session_id: String,
    pub exchange_id: String,
    pub user_text: String,
    #[serde(default)]
    pub assistant_text: String,
}

impl ConversationCoordinator {
    pub async fn ensure_control_conversation(&self) -> OpenBitFunResult<ControlConversation> {
        self.select_control_conversation(None).await
    }

    pub async fn create_control_conversation(
        &self,
        request: CreateControlConversationRequest,
    ) -> OpenBitFunResult<ControlConversation> {
        if request.expected_session_id.is_empty() {
            return Err(OpenBitFunError::validation(
                "The current control conversation is required",
            ));
        }
        self.select_control_conversation(Some(&request.expected_session_id))
            .await
    }

    async fn select_control_conversation(
        &self,
        expected_session_id: Option<&str>,
    ) -> OpenBitFunResult<ControlConversation> {
        let workspace = self
            .get_session_manager()
            .path_manager()
            .user_data_dir()
            .join("control-conversation");
        self.select_control_conversation_in_workspace(&workspace, expected_session_id)
            .await
    }

    pub(super) async fn select_control_conversation_in_workspace(
        &self,
        workspace: &std::path::Path,
        expected_session_id: Option<&str>,
    ) -> OpenBitFunResult<ControlConversation> {
        let _guard = ENSURE_CONTROL.lock().await;
        let manager = self.get_session_manager();
        tokio::fs::create_dir_all(&workspace).await?;
        // The control conversation runs in an app-owned folder. Register it as a
        // hidden workspace record so the session, its history reads, and remote
        // controllers address it by workspace ID rather than by this path.
        let workspace_service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| OpenBitFunError::service("Workspace service is unavailable"))?;
        let workspace_record = workspace_service
            .track_workspace_activity(
                workspace.to_path_buf(),
                crate::service::workspace::WorkspaceCreateOptions {
                    add_to_recent: false,
                    auto_set_current: false,
                    ..Default::default()
                },
                crate::service::workspace::WorkspaceActivityMode::TouchOnly,
            )
            .await?;
        let state_path = workspace.join("active.json");
        let store = JsonFileStore;
        let _file_guard = store
            .acquire_cross_process_lock(&state_path)
            .await
            .map_err(anyhow::Error::from)?;
        let mut state: ControlConversationState = store
            .read_optional(&state_path)
            .await
            .map_err(anyhow::Error::from)?
            .unwrap_or_default();
        let create_new = expected_session_id.is_some_and(|id| id == state.session_id);
        let session_id = if create_new {
            format!("openbitfun-control-{}", uuid::Uuid::new_v4())
        } else {
            state.session_id.clone()
        };
        let workspace_path = workspace.to_string_lossy().into_owned();
        if manager.get_session(&session_id).is_none() {
            // An unreadable record is an error, never a reason to replace user history.
            if manager
                .persistence_manager()
                .load_session_metadata(workspace, &session_id)
                .await?
                .is_some()
            {
                manager.restore_session(workspace, &session_id).await?;
            } else if create_new || session_id == CONTROL_SESSION_ID {
                self.create_session_with_id(
                    Some(session_id.clone()),
                    "OpenBitFun".to_string(),
                    "OpenBitFun".to_string(),
                    SessionConfig {
                        workspace_id: Some(workspace_record.id.clone()),
                        workspace_path: Some(workspace_path.clone()),
                        ..SessionConfig::default()
                    },
                )
                .await?;
            } else {
                return Err(OpenBitFunError::session(
                    "The saved control conversation is unavailable",
                ));
            }
        }
        self.ensure_session_runtime_ownership(&session_id, None)?;
        if create_new {
            state.session_id = session_id.clone();
            // Publish the new selection only after the Session owner persists it.
            // Earlier sessions and their pending work remain intact.
            store
                .write_atomic_strict(&state_path, &state)
                .await
                .map_err(anyhow::Error::from)?;
        }
        Ok(ControlConversation {
            session_id,
            workspace_id: workspace_record.id,
            workspace_path,
        })
    }

    pub async fn record_voice_exchange(
        &self,
        request: VoiceExchangeRequest,
    ) -> OpenBitFunResult<()> {
        self.ensure_session_runtime_ownership(&request.session_id, None)?;
        self.get_session_manager()
            .append_voice_exchange(
                &request.session_id,
                &request.exchange_id,
                request.user_text,
                request.assistant_text,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_selection_and_future_fields_round_trip() {
        let legacy: ControlConversationState = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.session_id, CONTROL_SESSION_ID);
        let payload = serde_json::json!({"sessionId": "openbitfun-control-new", "futureField": {"keep": true}});
        let state: ControlConversationState = serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(serde_json::to_value(state).unwrap(), payload);
    }
}
