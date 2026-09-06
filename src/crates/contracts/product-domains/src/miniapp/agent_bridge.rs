//! MiniApp agent bridge domain rules.
//!
//! This module owns provider-neutral run ownership, rate-limit, registry, and
//! turn-text extraction rules. Product hosts still own filesystem creation and
//! agent scheduler/coordinator calls.

use crate::miniapp::rate_limit::{MiniAppRateLimitState, MiniAppRateLimitSubject};
use crate::miniapp::types::AgentPermissions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MINIAPP_AGENT_SURFACE: &str = "miniapp_agent";
pub const MINIAPP_AGENT_SESSION_NAME: &str = "MiniApp Agent Run";
pub const MINIAPP_AGENT_KIND: &str = "Cowork";
pub const AGENT_ACCESS_DISABLED_MESSAGE: &str = "Agent access is not enabled for this MiniApp";
pub const UNKNOWN_AGENT_SESSION_MESSAGE: &str = "Unknown MiniApp agent session";
pub const UNKNOWN_AGENT_RUN_MESSAGE: &str = "Unknown MiniApp agent run";
pub const WORKSPACE_MISMATCH_MESSAGE: &str =
    "MiniApp agent session workspace does not match this run";
pub const APP_DATA_WORKSPACE_INVALID_MESSAGE: &str =
    "appDataWorkspace must be a clean relative path";
pub const WORKSPACE_REQUIRED_MESSAGE: &str = "workspacePath is required for MiniApp agent runs";
pub const AGENT_PROMPT_REQUIRED_MESSAGE: &str = "prompt is required";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniAppAgentWorkspacePlan {
    pub path: PathBuf,
    pub workspace_path: String,
    pub create_if_missing: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MiniAppAgentSubmissionPlan {
    pub run_id: String,
    pub owner: String,
    pub session_name: String,
    pub requested_session_id: Option<String>,
    pub workspace_path: String,
    pub enable_tools: bool,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppAgentRunRecord {
    pub app_id: String,
    pub session_id: String,
    pub turn_id: String,
}

#[derive(Debug)]
pub struct MiniAppAgentRunRegistry {
    records: Mutex<HashMap<String, MiniAppAgentRunRecord>>,
    max_records: usize,
}

impl Default for MiniAppAgentRunRegistry {
    fn default() -> Self {
        Self::new(256)
    }
}

impl MiniAppAgentRunRegistry {
    pub fn new(max_records: usize) -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            max_records,
        }
    }

    pub fn register(&self, record: MiniAppAgentRunRecord) {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if records.len() >= self.max_records {
            if let Some(key) = records.keys().next().cloned() {
                records.remove(&key);
            }
        }
        records.insert(record.turn_id.clone(), record);
    }

    pub fn lookup(
        &self,
        app_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> Option<MiniAppAgentRunRecord> {
        let records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        records
            .get(turn_id)
            .filter(|record| record.app_id == app_id && record.session_id == session_id)
            .cloned()
    }

    pub fn take_for_app(&self, app_id: &str) -> Vec<MiniAppAgentRunRecord> {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let turn_ids: Vec<String> = records
            .iter()
            .filter(|(_, record)| record.app_id == app_id)
            .map(|(turn_id, _)| turn_id.clone())
            .collect();
        turn_ids
            .into_iter()
            .filter_map(|turn_id| records.remove(&turn_id))
            .collect()
    }

    pub fn remove(&self, turn_id: &str) {
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        records.remove(turn_id);
    }
}

#[derive(Debug, Default)]
pub struct MiniAppAgentRateLimiter {
    state: Mutex<MiniAppRateLimitState>,
}

impl MiniAppAgentRateLimiter {
    pub fn check(
        &self,
        app_id: &str,
        rate_limit_per_minute: u32,
        now_ms: u64,
    ) -> Result<(), String> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .check(
                app_id,
                rate_limit_per_minute,
                now_ms,
                MiniAppRateLimitSubject::Agent,
            )
    }
}

pub fn require_enabled_agent_permissions(
    agent_permissions: Option<&AgentPermissions>,
) -> Result<AgentPermissions, String> {
    let agent_permissions = agent_permissions
        .cloned()
        .ok_or(AGENT_ACCESS_DISABLED_MESSAGE)?;
    if !agent_permissions.enabled {
        return Err(AGENT_ACCESS_DISABLED_MESSAGE.to_string());
    }
    Ok(agent_permissions)
}

pub fn require_agent_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err(AGENT_PROMPT_REQUIRED_MESSAGE.to_string());
    }
    Ok(())
}

pub fn is_clean_relative_subdir(subdir: &str) -> bool {
    let relative = Path::new(subdir);
    !relative.as_os_str().is_empty()
        && relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

pub fn app_data_workspace_path(app_data_dir: &Path, subdir: &str) -> Result<PathBuf, String> {
    if !is_clean_relative_subdir(subdir) {
        return Err(APP_DATA_WORKSPACE_INVALID_MESSAGE.to_string());
    }
    Ok(app_data_dir.join(Path::new(subdir)))
}

pub fn resolve_agent_workspace_path(
    explicit_workspace_path: Option<&str>,
    app_data_workspace: Option<&str>,
    app_data_dir: &Path,
) -> Result<PathBuf, String> {
    if let Some(subdir) = app_data_workspace
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return app_data_workspace_path(app_data_dir, subdir);
    }
    explicit_workspace_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| WORKSPACE_REQUIRED_MESSAGE.to_string())
}

pub fn plan_agent_workspace(
    explicit_workspace_path: Option<&str>,
    app_data_workspace: Option<&str>,
    app_data_dir: &Path,
) -> Result<MiniAppAgentWorkspacePlan, String> {
    if let Some(subdir) = app_data_workspace
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = app_data_workspace_path(app_data_dir, subdir)?;
        return Ok(MiniAppAgentWorkspacePlan {
            workspace_path: path.to_string_lossy().to_string(),
            path,
            create_if_missing: true,
        });
    }

    let workspace_path = explicit_workspace_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| WORKSPACE_REQUIRED_MESSAGE.to_string())?;
    Ok(MiniAppAgentWorkspacePlan {
        path: PathBuf::from(workspace_path),
        workspace_path: workspace_path.to_string(),
        create_if_missing: false,
    })
}

pub fn default_agent_run_id(app_id: &str, sequence: u64) -> String {
    // The process-local sequence resets on restart while a reused hidden
    // session keeps its persisted dialog_turn_ids. A restarted host would
    // otherwise regenerate "miniapp-agent-{app_id}-1" and collide with a turn
    // already recorded on that session ("Dialog turn already exists"). Anchor
    // the id to wall-clock time so it stays unique across restarts.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("miniapp-agent-{}-{}-{}", app_id, sequence, stamp)
}

pub fn agent_run_id_from_request(
    app_id: &str,
    requested_run_id: Option<&str>,
    sequence: u64,
) -> String {
    requested_run_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_agent_run_id(app_id, sequence))
}

pub fn agent_owner(app_id: &str, run_id: &str) -> String {
    format!("miniapp-agent:{}:{}", app_id, run_id)
}

pub fn agent_owner_prefix(app_id: &str) -> String {
    format!("miniapp-agent:{}:", app_id)
}

pub fn session_name_or_default(session_name: Option<&str>) -> String {
    session_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(MINIAPP_AGENT_SESSION_NAME)
        .to_string()
}

pub fn requested_session_id(session_id: Option<&str>) -> Option<String> {
    session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn validate_reused_session(
    created_by: Option<&str>,
    workspace_path: Option<&str>,
    app_id: &str,
    expected_workspace_path: &str,
) -> Result<(), String> {
    let owner_prefix = agent_owner_prefix(app_id);
    if !created_by.is_some_and(|created_by| created_by.starts_with(&owner_prefix)) {
        return Err(UNKNOWN_AGENT_SESSION_MESSAGE.to_string());
    }
    if workspace_path != Some(expected_workspace_path) {
        return Err(WORKSPACE_MISMATCH_MESSAGE.to_string());
    }
    Ok(())
}

/// Metadata carried by every MiniApp agent turn.
///
/// `market_strict` mirrors the app's runtime profile so the agent runtime can
/// pick the marketplace tool allowlist without reaching back into MiniApp
/// storage. The flag is only serialized for strict apps, keeping the turn
/// metadata of built-in MiniApps byte-identical to earlier releases.
pub fn agent_run_metadata(app_id: &str, run_id: &str, market_strict: bool) -> serde_json::Value {
    let mut metadata = json!({
        "surface": MINIAPP_AGENT_SURFACE,
        "appId": app_id,
        "runId": run_id,
        "acp_transport": true,
    });
    if market_strict {
        metadata["marketStrict"] = Value::Bool(true);
    }
    metadata
}

pub fn build_agent_submission_plan(
    app_id: &str,
    run_id: &str,
    session_name: Option<&str>,
    requested_session: Option<&str>,
    workspace_path: &str,
    enable_tools: Option<bool>,
    market_strict: bool,
) -> MiniAppAgentSubmissionPlan {
    MiniAppAgentSubmissionPlan {
        run_id: run_id.to_string(),
        owner: agent_owner(app_id, run_id),
        session_name: session_name_or_default(session_name),
        requested_session_id: requested_session_id(requested_session),
        workspace_path: workspace_path.to_string(),
        enable_tools: enable_tools.unwrap_or(true),
        metadata: agent_run_metadata(app_id, run_id, market_strict),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MiniAppAgentTurnMessageRole {
    Assistant,
    Tool,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniAppAgentTurnMessage {
    pub turn_id: Option<String>,
    pub role: MiniAppAgentTurnMessageRole,
    pub is_tool_result: bool,
    pub text: String,
}

pub fn extract_agent_turn_text(messages: &[MiniAppAgentTurnMessage], turn_id: &str) -> String {
    let turn_messages: Vec<&MiniAppAgentTurnMessage> = messages
        .iter()
        .filter(|message| message.turn_id.as_deref() == Some(turn_id))
        .collect();
    let answer_start = turn_messages
        .iter()
        .rposition(|message| {
            message.role == MiniAppAgentTurnMessageRole::Tool || message.is_tool_result
        })
        .map_or(0, |index| index + 1);
    turn_messages[answer_start..]
        .iter()
        .filter(|message| message.role == MiniAppAgentTurnMessageRole::Assistant)
        .filter_map(|message| {
            if message.text.trim().is_empty() {
                None
            } else {
                Some(message.text.as_str())
            }
        })
        .collect::<Vec<_>>()
        .concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_workspace_rejects_paths_outside_app_storage() {
        assert!(is_clean_relative_subdir("decks/deck-123"));
        assert!(is_clean_relative_subdir("decks"));
        assert!(!is_clean_relative_subdir(""));
        assert!(!is_clean_relative_subdir("/etc"));
        assert!(!is_clean_relative_subdir("../outside"));
        assert!(!is_clean_relative_subdir("decks/../../outside"));
        assert!(!is_clean_relative_subdir("./decks"));

        assert_eq!(
            app_data_workspace_path(Path::new("/appdata"), "decks/deck-123").unwrap(),
            PathBuf::from("/appdata").join("decks").join("deck-123")
        );
    }

    #[test]
    fn run_registry_preserves_owner_lookup_and_bounded_cleanup() {
        let registry = MiniAppAgentRunRegistry::new(1);
        registry.register(MiniAppAgentRunRecord {
            app_id: "app-1".to_string(),
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
        });
        assert!(registry.lookup("app-1", "session-1", "turn-1").is_some());
        assert!(registry.lookup("other", "session-1", "turn-1").is_none());

        registry.register(MiniAppAgentRunRecord {
            app_id: "app-1".to_string(),
            session_id: "session-2".to_string(),
            turn_id: "turn-2".to_string(),
        });
        assert_eq!(registry.take_for_app("app-1").len(), 1);
    }

    #[test]
    fn reused_session_validation_preserves_owner_and_workspace_checks() {
        validate_reused_session(
            Some("miniapp-agent:builtin-ppt-live:run-1"),
            Some("/workspace"),
            "builtin-ppt-live",
            "/workspace",
        )
        .unwrap();
        assert_eq!(
            validate_reused_session(
                Some("other-agent:builtin-ppt-live:run-1"),
                Some("/workspace"),
                "builtin-ppt-live",
                "/workspace",
            )
            .unwrap_err(),
            UNKNOWN_AGENT_SESSION_MESSAGE
        );
        assert_eq!(
            validate_reused_session(
                Some("miniapp-agent:builtin-ppt-live:run-1"),
                Some("/other"),
                "builtin-ppt-live",
                "/workspace",
            )
            .unwrap_err(),
            WORKSPACE_MISMATCH_MESSAGE
        );
    }

    #[test]
    fn agent_run_plan_helpers_preserve_workspace_identity_and_metadata_contract() {
        assert_eq!(
            require_agent_prompt("   ").unwrap_err(),
            AGENT_PROMPT_REQUIRED_MESSAGE
        );
        assert!(require_agent_prompt(" plan ").is_ok());

        let explicit_workspace =
            plan_agent_workspace(Some(" /workspace "), None, Path::new("/appdata"))
                .expect("explicit workspace");
        assert_eq!(explicit_workspace.path, PathBuf::from("/workspace"));
        assert_eq!(explicit_workspace.workspace_path, "/workspace");
        assert!(!explicit_workspace.create_if_missing);

        let appdata_workspace =
            plan_agent_workspace(None, Some("decks/deck-123"), Path::new("/appdata"))
                .expect("appdata workspace");
        assert_eq!(
            appdata_workspace.path,
            PathBuf::from("/appdata").join("decks").join("deck-123")
        );
        assert_eq!(
            appdata_workspace.workspace_path,
            appdata_workspace.path.to_string_lossy()
        );
        assert!(appdata_workspace.create_if_missing);

        assert_eq!(
            plan_agent_workspace(None, Some("../outside"), Path::new("/appdata")).unwrap_err(),
            APP_DATA_WORKSPACE_INVALID_MESSAGE
        );
        assert_eq!(
            plan_agent_workspace(None, None, Path::new("/appdata")).unwrap_err(),
            WORKSPACE_REQUIRED_MESSAGE
        );

        assert_eq!(
            agent_run_id_from_request("app-1", Some(" run-1 "), 9),
            "run-1"
        );
        let generated = agent_run_id_from_request("app-1", Some("   "), 9);
        assert!(
            generated.starts_with("miniapp-agent-app-1-9-"),
            "expected a restart-unique run id, got: {generated}"
        );

        let plan = build_agent_submission_plan(
            "app-1",
            "run-1",
            Some(" Session "),
            Some(" session-1 "),
            "/workspace",
            Some(false),
            false,
        );
        assert_eq!(plan.owner, "miniapp-agent:app-1:run-1");
        assert_eq!(plan.session_name, "Session");
        assert_eq!(plan.requested_session_id.as_deref(), Some("session-1"));
        assert_eq!(plan.workspace_path, "/workspace");
        assert!(!plan.enable_tools);
        assert_eq!(
            plan.metadata,
            serde_json::json!({
                "surface": MINIAPP_AGENT_SURFACE,
                "appId": "app-1",
                "runId": "run-1",
                "acp_transport": true,
            })
        );
    }

    #[test]
    fn market_strict_runs_tag_their_turn_metadata() {
        assert_eq!(
            agent_run_metadata("app-1", "run-1", true),
            serde_json::json!({
                "surface": MINIAPP_AGENT_SURFACE,
                "appId": "app-1",
                "runId": "run-1",
                "acp_transport": true,
                "marketStrict": true,
            })
        );

        let plan =
            build_agent_submission_plan("app-1", "run-1", None, None, "/workspace", None, true);
        assert!(plan.enable_tools);
        assert_eq!(plan.metadata["marketStrict"], serde_json::json!(true));
    }

    #[test]
    fn turn_text_starts_after_last_tool_result_for_requested_turn() {
        let messages = vec![
            MiniAppAgentTurnMessage {
                turn_id: Some("turn-1".to_string()),
                role: MiniAppAgentTurnMessageRole::Assistant,
                is_tool_result: false,
                text: "old".to_string(),
            },
            MiniAppAgentTurnMessage {
                turn_id: Some("turn-1".to_string()),
                role: MiniAppAgentTurnMessageRole::Tool,
                is_tool_result: true,
                text: String::new(),
            },
            MiniAppAgentTurnMessage {
                turn_id: Some("turn-1".to_string()),
                role: MiniAppAgentTurnMessageRole::Assistant,
                is_tool_result: false,
                text: "new".to_string(),
            },
            MiniAppAgentTurnMessage {
                turn_id: Some("turn-2".to_string()),
                role: MiniAppAgentTurnMessageRole::Assistant,
                is_tool_result: false,
                text: "ignored".to_string(),
            },
        ];

        assert_eq!(extract_agent_turn_text(&messages, "turn-1"), "new");
    }
}
