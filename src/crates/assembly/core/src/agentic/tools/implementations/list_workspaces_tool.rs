//! Read-only discovery of registered workspaces on the runtime's owning host.

use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::service_agent_runtime::CoreWorkspaceCatalogPort;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_core_types::WorkspaceKind;
use openbitfun_runtime_ports::{AgentWorkspaceCatalogEntry, AgentWorkspaceCatalogPort};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct ListWorkspacesTool {
    catalog: Arc<dyn AgentWorkspaceCatalogPort>,
}

impl Default for ListWorkspacesTool {
    fn default() -> Self {
        Self::new()
    }
}

fn default_limit() -> usize {
    50
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    query: Option<String>,
    kind: Option<WorkspaceKind>,
    #[serde(default = "default_limit")]
    limit: usize,
    cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    after: String,
    last_accessed_at_ms: i64,
    query: String,
    kind: Option<WorkspaceKind>,
}

impl Input {
    fn parse(value: &Value) -> Result<Self, String> {
        let input: Self = serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid input: {error}"))?;
        if !(1..=200).contains(&input.limit) {
            return Err("limit must be between 1 and 200".into());
        }
        input.after()?;
        Ok(input)
    }

    fn query(&self) -> String {
        self.query
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_lowercase()
    }

    fn after(&self) -> Result<Option<Cursor>, String> {
        let Some(cursor) = self.cursor.as_deref() else {
            return Ok(None);
        };
        let cursor: Cursor =
            serde_json::from_str(cursor).map_err(|_| "Invalid workspace cursor".to_string())?;
        if cursor.query != self.query() || cursor.kind != self.kind {
            return Err("Workspace cursor does not match this query and kind".into());
        }
        Ok(Some(cursor))
    }
}

impl ListWorkspacesTool {
    pub fn new() -> Self {
        Self {
            catalog: Arc::new(CoreWorkspaceCatalogPort),
        }
    }

    fn result_for_assistant(output: &Value) -> String {
        let mut lines = vec![
            format!(
                "Registered workspaces on this runtime host: showing {} of {} matches (newest access first).",
                output["count"].as_u64().unwrap_or_default(),
                output["total"].as_u64().unwrap_or_default()
            ),
            format!(
                "Current workspace ID: {}",
                output["current_workspace_id"].as_str().unwrap_or("none")
            ),
            "Catalog metadata only; remote connectivity was not checked.".into(),
        ];
        if let Some(workspaces) = output["workspaces"].as_array() {
            if workspaces.is_empty() {
                lines.push("\nNo workspaces on this page.".into());
            }
            for (index, workspace) in workspaces.iter().enumerate() {
                let current = if workspace["is_current"].as_bool() == Some(true) {
                    " (current)"
                } else {
                    ""
                };
                lines.push(format!(
                    "\n{}. {} [{}]{}",
                    index + 1,
                    workspace["name"].as_str().unwrap_or("Unnamed workspace"),
                    workspace["kind"].as_str().unwrap_or("unknown"),
                    current
                ));
                for (label, key) in [
                    ("Workspace ID", "workspace_id"),
                    ("Project workspace ID", "project_workspace_id"),
                    ("Root path", "root_path"),
                ] {
                    if key == "project_workspace_id" && workspace[key] == workspace["workspace_id"]
                    {
                        continue;
                    }
                    lines.push(format!(
                        "   {label}: {}",
                        workspace[key].as_str().unwrap_or("not available")
                    ));
                }
                let accessed = workspace["last_accessed_at_ms"]
                    .as_i64()
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                    .unwrap_or_else(|| "not available".into());
                lines.push(format!("   Last accessed (UTC): {accessed}"));
                if workspace["remote"].is_object() {
                    for (label, key) in
                        [("SSH host", "host"), ("SSH connection ID", "connection_id")]
                    {
                        lines.push(format!(
                            "   {label}: {}",
                            workspace["remote"][key].as_str().unwrap_or("not available")
                        ));
                    }
                }
                if let Some(error) = workspace["binding_error"].as_str() {
                    lines.push(format!("   Binding error: {error}"));
                }
            }
        }
        if let Some(cursor) = output["next_cursor"].as_str() {
            lines.push(format!(
                "\nMore workspaces are available. Call ListWorkspaces with the same query and kind, copying the following next_cursor unchanged into cursor:\n```text\n{cursor}\n```"
            ));
        } else {
            lines.push("\nEnd of results; no next page.".into());
        }
        lines.join("\n")
    }

    fn result(
        input: &Input,
        records: Vec<AgentWorkspaceCatalogEntry>,
        current: Option<&str>,
    ) -> OpenBitFunResult<Value> {
        let query = input.query();
        let after = input.after().map_err(OpenBitFunError::tool)?;
        let mut records: Vec<_> = records
            .into_iter()
            .filter(|record| {
                input.kind.as_ref().is_none_or(|kind| kind == &record.kind)
                    && query.split_whitespace().all(|term| {
                        let remote = record.remote.as_ref();
                        [
                            Some(record.workspace_id.as_str()),
                            Some(record.name.as_str()),
                            Some(record.root_path.as_str()),
                            remote.and_then(|route| route.host.as_deref()),
                            remote.and_then(|route| route.connection_id.as_deref()),
                        ]
                        .into_iter()
                        .flatten()
                        .any(|value| value.to_lowercase().contains(term))
                    })
            })
            .collect();
        records.sort_by(|a, b| {
            b.last_accessed_at_ms
                .cmp(&a.last_accessed_at_ms)
                .then_with(|| a.workspace_id.cmp(&b.workspace_id))
        });
        let total = records.len();
        records.retain(|record| {
            after.as_ref().is_none_or(|cursor| {
                record.last_accessed_at_ms < cursor.last_accessed_at_ms
                    || (record.last_accessed_at_ms == cursor.last_accessed_at_ms
                        && record.workspace_id > cursor.after)
            })
        });
        let has_more = records.len() > input.limit;
        records.truncate(input.limit);
        let next_cursor = if has_more {
            Some(
                serde_json::to_string(&Cursor {
                    after: records.last().expect("nonempty page").workspace_id.clone(),
                    last_accessed_at_ms: records.last().expect("nonempty page").last_accessed_at_ms,
                    query,
                    kind: input.kind.clone(),
                })
                .map_err(|error| OpenBitFunError::tool(error.to_string()))?,
            )
        } else {
            None
        };
        let workspaces: Vec<_> = records
            .into_iter()
            .map(|record| {
                let is_current = current == Some(record.workspace_id.as_str());
                let mut value = serde_json::to_value(record).expect("catalog DTO serializes");
                value["is_current"] = json!(is_current);
                value
            })
            .collect();
        Ok(
            json!({ "success": true, "scope": "runtime_host", "current_workspace_id": current,
            "count": workspaces.len(), "total": total, "workspaces": workspaces, "next_cursor": next_cursor }),
        )
    }
}

#[async_trait]
impl Tool for ListWorkspacesTool {
    fn name(&self) -> &str {
        "ListWorkspaces"
    }
    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("List registered workspaces on this runtime host, including local, assistant, remote SSH, closed, and offline workspaces. Returns opaque workspace_id values, ordered by last recorded access from newest to oldest; equal timestamps use workspace ID as a stable tie-breaker. Pagination reads the live catalog, so recent activity can change ordering between calls.".into())
    }
    fn short_description(&self) -> String {
        "Discover registered workspace IDs for session operations.".into()
    }
    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object", "properties":{
            "query":{"type":"string", "description":"Optional search across workspace names, IDs, paths, and remote host/connection labels."},
            "kind":{"type":"string", "enum":["normal","assistant","remote"], "description":"Optional workspace kind; omit for all registered workspaces."},
            "limit":{"type":"integer", "minimum":1, "maximum":200, "description":"Page size; defaults to 50."},
            "cursor":{"type":"string", "description":"Opaque next_cursor from the preceding page; keep query and kind unchanged."}
        }, "additionalProperties":false})
    }
    fn is_readonly(&self) -> bool {
        true
    }
    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }
    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match Input::parse(input) {
            Ok(_) => ValidationResult::default(),
            Err(message) => ValidationResult {
                result: false,
                message: Some(message),
                error_code: Some(400),
                meta: None,
            },
        }
    }
    fn render_tool_use_message(&self, _input: &Value, _options: &ToolRenderOptions) -> String {
        "List registered workspaces".into()
    }
    fn render_tool_result_message(&self, output: &Value) -> String {
        format!(
            "Found {} workspace(s)",
            output["count"].as_u64().unwrap_or_default()
        )
    }
    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let input = Input::parse(input).map_err(OpenBitFunError::tool)?;
        let records = self
            .catalog
            .list_workspaces()
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        let data = Self::result(&input, records, context.workspace_id())?;
        let assistant = Self::result_for_assistant(&data);
        Ok(vec![ToolResult::ok(data, Some(assistant))])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::WorkspaceBinding;
    use crate::service::workspace::{
        WorkspaceActivityMode, WorkspaceCreateOptions, WorkspaceService,
    };
    use openbitfun_runtime_ports::{
        AgentWorkspaceRemoteInfo, PortError, PortErrorKind, PortResult,
    };
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn record(id: &str, kind: WorkspaceKind) -> AgentWorkspaceCatalogEntry {
        AgentWorkspaceCatalogEntry {
            workspace_id: id.into(),
            project_workspace_id: Some(id.into()),
            name: format!("Project {id}"),
            root_path: "/project".into(),
            remote: (kind == WorkspaceKind::Remote).then(|| AgentWorkspaceRemoteInfo {
                connection_id: Some("offline-connection".into()),
                host: Some("unreachable.example".into()),
            }),
            kind,
            last_accessed_at_ms: 1_000,
            binding_error: None,
        }
    }

    fn context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: Some("caller".into()),
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new(
                Some("b".into()),
                PathBuf::from("/caller"),
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: Default::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: Default::default(),
        }
    }

    struct Catalog(PortResult<Vec<AgentWorkspaceCatalogEntry>>);
    #[async_trait]
    impl AgentWorkspaceCatalogPort for Catalog {
        async fn list_workspaces(&self) -> PortResult<Vec<AgentWorkspaceCatalogEntry>> {
            self.0.clone()
        }
    }

    #[test]
    fn list_workspaces_orders_recent_access_and_paginates_ties() {
        let records: Vec<_> = [
            ("a", 1_000),
            ("z", 3_000),
            ("c", 2_000),
            ("b", 2_000),
            ("u", 0),
        ]
        .into_iter()
        .map(|(id, time)| {
            let mut row = record(id, WorkspaceKind::Normal);
            row.last_accessed_at_ms = time;
            row
        })
        .collect();
        let mut cursor: Option<String> = None;
        let mut ids = Vec::new();
        loop {
            let page = ListWorkspacesTool::result(
                &Input::parse(&json!({"limit":2, "cursor":cursor})).unwrap(),
                records.clone(),
                None,
            )
            .unwrap();
            ids.extend(
                page["workspaces"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["workspace_id"].as_str().unwrap().to_owned()),
            );
            cursor = page["next_cursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids, ["z", "b", "c", "a", "u"]);
    }

    #[test]
    fn list_workspaces_paging_and_filters_preserve_identity() {
        let records = vec![
            record("c", WorkspaceKind::Assistant),
            record("b", WorkspaceKind::Remote),
            record("a", WorkspaceKind::Normal),
        ];
        let first = ListWorkspacesTool::result(
            &Input::parse(&json!({"limit":1})).unwrap(),
            records.clone(),
            Some("b"),
        )
        .unwrap();
        assert_eq!(first["workspaces"][0]["workspace_id"], "a");
        assert_eq!(first["total"], 3);
        let cursor = first["next_cursor"].as_str().unwrap();
        let second = ListWorkspacesTool::result(
            &Input::parse(&json!({"limit":2,"cursor":cursor})).unwrap(),
            records.clone(),
            Some("b"),
        )
        .unwrap();
        assert_eq!(second["workspaces"][0]["workspace_id"], "b");
        assert_eq!(second["workspaces"][0]["is_current"], true);
        assert_eq!(second["workspaces"][1]["workspace_id"], "c");
        assert!(second["next_cursor"].is_null());
        let filtered = ListWorkspacesTool::result(
            &Input::parse(&json!({"kind":"remote","query":"PROJECT unreachable"})).unwrap(),
            records,
            None,
        )
        .unwrap();
        assert_eq!(filtered["total"], 1);
        assert_eq!(
            filtered["workspaces"][0]["remote"]["connection_id"],
            "offline-connection"
        );
        for invalid in [
            json!({"limit":0}),
            json!({"limit":201}),
            json!({"kind":"ssh"}),
            json!({"cursor":"bad"}),
            json!({"query":"changed","cursor":cursor}),
            json!({"kind":"remote","cursor":cursor}),
            json!({"workspace":"unexpected"}),
        ] {
            assert!(Input::parse(&invalid).is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn list_workspaces_call_returns_model_visible_ids_and_provider_errors() {
        let mut broken = record("b", WorkspaceKind::Remote);
        broken.remote.as_mut().unwrap().connection_id = None;
        broken.binding_error = Some("Missing saved route".into());
        let tool = ListWorkspacesTool {
            catalog: Arc::new(Catalog(Ok(vec![broken]))),
        };
        let output = tool.call_impl(&json!({}), &context()).await.unwrap();
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &output[0]
        else {
            panic!("expected result")
        };
        assert_eq!(data["scope"], "runtime_host");
        assert_eq!(data["current_workspace_id"], "b");
        assert_eq!(
            data["workspaces"][0]["binding_error"],
            "Missing saved route"
        );
        let assistant = result_for_assistant.as_ref().unwrap();
        assert!(assistant.contains("1. Project b [remote] (current)"));
        assert!(assistant.contains("Workspace ID: b"));
        assert!(assistant.contains("Root path: /project"));
        assert!(assistant.contains("SSH host: unreachable.example"));
        assert!(assistant.contains("SSH connection ID: not available"));
        assert!(assistant.contains("Binding error: Missing saved route"));
        assert!(assistant.contains("Last accessed (UTC): 1970-01-01T00:00:01Z"));
        assert!(serde_json::from_str::<Value>(assistant).is_err());
        assert!(tool.is_readonly());
        assert!(tool.is_concurrency_safe(None));
        assert!(matches!(tool.default_exposure(), ToolExposure::Deferred));
        let unavailable = ListWorkspacesTool {
            catalog: Arc::new(Catalog(Err(PortError::new(
                PortErrorKind::NotAvailable,
                "offline catalog",
            )))),
        };
        assert!(unavailable
            .call_impl(&json!({}), &context())
            .await
            .unwrap_err()
            .to_string()
            .contains("offline catalog"));
    }

    #[test]
    fn list_workspaces_readable_result_preserves_cursor_and_empty_pages() {
        let mut worktree = record("local-id", WorkspaceKind::Normal);
        worktree.project_workspace_id = Some("project-id".into());
        let records = vec![worktree, record("remote-id", WorkspaceKind::Remote)];
        let page = ListWorkspacesTool::result(
            &Input::parse(&json!({"limit":1})).unwrap(),
            records.clone(),
            None,
        )
        .unwrap();
        let rendered = ListWorkspacesTool::result_for_assistant(&page);
        assert!(rendered.contains("showing 1 of 2 matches"));
        assert!(rendered.contains("Current workspace ID: none"));
        assert!(rendered.contains("1. Project local-id [normal]"));
        assert!(rendered.contains("Project workspace ID: project-id"));
        assert_eq!(page["workspaces"][0]["project_workspace_id"], "project-id");
        assert!(!rendered.contains("SSH host:"));
        let cursor = rendered
            .split("```text\n")
            .nth(1)
            .unwrap()
            .split("\n```")
            .next()
            .unwrap();
        assert_eq!(cursor, page["next_cursor"].as_str().unwrap());
        let next = ListWorkspacesTool::result(
            &Input::parse(&json!({"cursor":cursor})).unwrap(),
            records,
            None,
        )
        .unwrap();
        assert_eq!(next["workspaces"][0]["workspace_id"], "remote-id");
        assert_eq!(next["workspaces"][0]["project_workspace_id"], "remote-id");
        assert!(!ListWorkspacesTool::result_for_assistant(&next).contains("Project workspace ID:"));
        let empty =
            ListWorkspacesTool::result(&Input::parse(&json!({})).unwrap(), Vec::new(), None)
                .unwrap();
        let rendered = ListWorkspacesTool::result_for_assistant(&empty);
        assert!(rendered.contains("showing 0 of 0 matches"));
        assert!(rendered.contains("No workspaces on this page."));
        assert!(rendered.contains("End of results; no next page."));
    }

    #[tokio::test]
    async fn list_workspaces_catalog_retains_closed_and_offline_records_without_activation() {
        let root = std::env::temp_dir().join(format!("workspace-catalog-{}", uuid::Uuid::new_v4()));
        let service = WorkspaceService::new_isolated_for_tests(root.join("user")).await;
        std::fs::create_dir_all(root.join("local")).unwrap();
        let local = service.open_workspace(root.join("local")).await.unwrap();
        service.close_workspace(&local.id).await.unwrap();
        let remote = service
            .track_workspace_activity(
                PathBuf::from("/offline//project/"),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Remote,
                    remote_connection_id: Some("offline".into()),
                    remote_ssh_host: Some("offline.example".into()),
                    ..Default::default()
                },
                WorkspaceActivityMode::TouchOnly,
            )
            .await
            .unwrap();
        // Retain legacy/incomplete routing metadata so discovery can report it.
        let mut broken = remote.clone();
        broken.id = "legacy-remote".into();
        broken.metadata.remove("connectionId");
        service
            .get_manager()
            .write()
            .await
            .get_workspaces_mut()
            .insert(broken.id.clone(), broken);
        std::fs::create_dir_all(root.join("assistant")).unwrap();
        let assistant = service
            .track_workspace_activity(
                root.join("assistant"),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Assistant,
                    assistant_id: Some("assistant".into()),
                    ..Default::default()
                },
                WorkspaceActivityMode::TouchOnly,
            )
            .await
            .unwrap();
        let before = service.get_opened_workspaces().await;
        let rows = CoreWorkspaceCatalogPort::list_from_service(&service).await;
        assert!(rows
            .iter()
            .any(|row| row.workspace_id == local.id && row.kind == WorkspaceKind::Normal));
        let row = rows
            .iter()
            .find(|row| row.workspace_id == remote.id)
            .unwrap();
        assert_eq!(row.root_path, "/offline/project");
        assert_eq!(
            row.last_accessed_at_ms,
            remote.last_accessed.timestamp_millis()
        );
        assert_eq!(
            row.remote.as_ref().unwrap().connection_id.as_deref(),
            Some("offline")
        );
        let broken = rows
            .iter()
            .find(|row| row.workspace_id == "legacy-remote")
            .unwrap();
        assert!(broken.binding_error.is_some());
        assert!(broken.remote.as_ref().unwrap().connection_id.is_none());
        assert!(rows
            .iter()
            .any(|row| row.workspace_id == assistant.id && row.kind == WorkspaceKind::Assistant));
        assert_eq!(service.get_opened_workspaces().await.len(), before.len());
        assert!(!service
            .get_opened_workspaces()
            .await
            .iter()
            .any(|row| row.id == local.id || row.id == remote.id));
        drop(service);
        std::fs::remove_dir_all(root).unwrap();
    }
}
