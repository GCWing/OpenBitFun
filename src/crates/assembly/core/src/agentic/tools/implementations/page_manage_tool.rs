//! Unified account-backed Pages management for Agents.

use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::page_manage_host::{invoke_page_manage, PageManageRequest};
use crate::agentic::tools::page_publish_host::page_account_available;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

#[derive(Default)]
pub struct PageManageTool;

impl PageManageTool {
    pub fn new() -> Self {
        Self
    }
}

fn parse_request(
    input: &Value,
    context: Option<&ToolUseContext>,
) -> Result<PageManageRequest, String> {
    let request: PageManageRequest = serde_json::from_value(input.clone())
        .map_err(|error| format!("Invalid PageManage input: {error}"))?;
    if let Some(slug) = request.slug() {
        if slug.is_empty()
            || slug.len() > 64
            || slug.starts_with('-')
            || !slug
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("slug must be 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit".into());
        }
    }
    match &request {
        PageManageRequest::Publish { visibility, .. }
        | PageManageRequest::Permissions { visibility, .. }
            if !matches!(visibility.as_str(), "private" | "relay" | "public") =>
        {
            return Err("visibility must be private, relay, or public".into());
        }
        PageManageRequest::Deploy { version_id, .. }
        | PageManageRequest::Delete {
            version_id: Some(version_id),
            ..
        } if version_id.is_empty()
            || !version_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) =>
        {
            return Err("version_id must be a saved version identifier".into());
        }
        _ => {}
    }
    if let PageManageRequest::Publish {
        files,
        directory,
        title,
        ..
    }
    | PageManageRequest::Update {
        files,
        directory,
        title,
        ..
    } = &request
    {
        let has_content = files.is_some() || directory.is_some();
        if files.is_some() && directory.is_some() {
            return Err("provide either directory or files, not both".into());
        }
        if let Some(files) = files {
            if !files.contains_key("index.html") && !files.contains_key("server/worker.js") {
                return Err("files must include index.html and/or server/worker.js".into());
            }
        }
        if title.as_ref().is_some_and(|title| title.trim().is_empty()) {
            return Err("title must not be empty".into());
        }
        if let Some(directory) = directory {
            if directory.trim().is_empty() {
                return Err("directory must not be empty".into());
            }
            if let Some(context) = context {
                if context.is_remote() {
                    return Err("PageManage cannot read a remote workspace directory through the local host; use inline files".into());
                }
                if context.workspace.is_none() {
                    return Err("PageManage directory requires a local workspace; use inline files when no workspace is open".into());
                }
            }
        }
        match &request {
            PageManageRequest::Publish { .. } if !has_content => {
                return Err(
                    "publish requires files or directory; use deploy for a saved version".into(),
                );
            }
            PageManageRequest::Update { note, deploy, .. } if !has_content => {
                if title.is_none() || note.is_some() || *deploy {
                    return Err(
                        "update requires title or content; note and deploy require content".into(),
                    );
                }
            }
            _ => {}
        }
    }
    Ok(request)
}

#[async_trait]
impl Tool for PageManageTool {
    fn name(&self) -> &str {
        "PageManage"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Manage OpenBitFun Pages on the executing host's account relay. Requires OpenBitFun account login.

Actions:
- list: list published Pages by default, with name/title, slug, absolute url, visibility, updated_at (Unix seconds), generation and deployed_version_id. published_only=false also includes saved/unpublished Pages.
- publish: upload a complete files bundle or an existing local directory, save an immutable version, optionally deploy. visibility defaults to private; deploy defaults to false (preview only). Use public or deploy=true only when the user asks for it.
- update: update an existing Page's title and/or replace its content with a complete bundle. Preserves visibility and the existing title unless title is supplied. Content is saved as a new version; deploy=true makes it live. Use permissions to change access.
- permissions: set visibility to private (owner), relay (signed-in relay users), or public (anyone).
- delete: permanently delete a Page and all versions; with version_id, delete only that saved version.
- versions: list saved versions and their preview URLs for a slug.
- deploy: promote or roll back to an existing version_id without uploading content.
- unpublish: take a Page offline while retaining saved versions.

Prefer inline files (relative path -> UTF-8 content); include index.html and/or server/worker.js. Do not create workspace files solely to publish. directory is only for sources already on disk or explicitly requested local copies; remote workspaces must use files. Content updates replace the entire bundle, not a patch.
Use the returned version_id to retry deployment after a saved-version/deploy failure. Do not upload again blindly.
Content updates require Relay metadata precondition support. If unsupported, report it; do not substitute publish, which can change access settings. If metadata changes during an update, list the Page again before retrying.
Public URLs can be shared directly. Private/relay URLs require authenticated access; open them through the Pages scene/tool card. Never describe raw restricted URLs as public share links.
When the user requests an operation, call it directly. The permission system handles confirmation in Ask mode; Auto Approve and Full Access need no extra confirmation."#.into())
    }

    fn short_description(&self) -> String {
        "List, publish, update, delete, and manage access to OpenBitFun Pages.".into()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object", "additionalProperties": false, "required": ["action"],
            "properties": {
                "action": {"type": "string", "enum": ["list", "publish", "update", "permissions", "delete", "versions", "deploy", "unpublish"]},
                "slug": {"type": "string", "description": "Required except for list. Lowercase letters, digits, hyphens."},
                "published_only": {"type": "boolean", "description": "list only. Defaults to true; false also includes unpublished Pages."},
                "title": {"type": "string", "description": "publish/update only. Page name."},
                "visibility": {"type": "string", "enum": ["private", "relay", "public"], "description": "publish (default private) or permissions (required)."},
                "files": {"type": "object", "additionalProperties": {"type": "string"}, "description": "publish/update only. Complete inline file bundle; includes index.html and/or server/worker.js. Mutually exclusive with directory."},
                "directory": {"type": "string", "description": "publish/update only. Existing local workspace directory. Remote workspaces must use files."},
                "note": {"type": "string", "description": "Version note for publish/content update."},
                "deploy": {"type": "boolean", "description": "publish/content update only. Default false saves a preview; true deploys the new version."},
                "version_id": {"type": "string", "description": "Required for deploy; optional for delete (omit to delete the entire Page). Obtain from versions or a saved version result."}
            }
        })
    }

    fn output_schema(&self) -> Value {
        let page = json!({"type": "object", "properties": {
            "slug": {"type": "string"}, "name": {"type": "string"}, "title": {"type": "string"},
            "url": {"type": "string"}, "visibility": {"type": "string"},
            "updated_at": {"type": "integer", "description": "Unix timestamp in seconds"},
            "published": {"type": "boolean"}, "generation": {"type": "string"},
            "deployed_version_id": {"type": ["string", "null"]}
        }, "required": ["slug", "name", "url", "visibility", "updated_at"], "additionalProperties": true});
        json!({"type": "object", "properties": {
            "action": {"type": "string"}, "pages": {"type": "array", "items": page},
            "versions": {"type": "array", "items": {"type": "object", "additionalProperties": true}},
            "slug": {"type": "string"}, "version_id": {"type": "string"},
            "visibility": {"type": "string"}, "url": {"type": "string"},
            "preview_url": {"type": "string"}, "deployed": {"type": "boolean"},
            "deleted": {"type": "boolean"}, "unpublished": {"type": "boolean"}
        }, "required": ["action"], "additionalProperties": true})
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        input
            .and_then(|input| parse_request(input, None).ok())
            .is_some_and(|request| request.is_readonly())
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match parse_request(input, context) {
            Ok(_) => ValidationResult {
                result: true,
                message: None,
                error_code: None,
                meta: None,
            },
            Err(message) => ValidationResult {
                result: false,
                message: Some(message),
                error_code: Some(400),
                meta: None,
            },
        }
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let request = parse_request(input, Some(context)).map_err(OpenBitFunError::tool)?;
        if request.is_readonly() {
            return Ok(Vec::new());
        }
        let mut resource = format!(
            "page:{}; action={}",
            request.slug().unwrap_or_default(),
            request.action()
        );
        // Include resolved defaults, so remote approval mailboxes also show
        // private visibility and preview-only publication when fields are omitted.
        let normalized = serde_json::to_value(&request)
            .map_err(|error| OpenBitFunError::tool(error.to_string()))?;
        for key in ["visibility", "title", "deploy", "version_id"] {
            if let Some(value) = normalized.get(key).filter(|value| !value.is_null()) {
                resource.push_str(&format!("; {key}={value}"));
            }
        }
        // Content replacement has the same upload/deploy effects as legacy
        // PagePublish, so existing publication denials must still apply.
        let permission_action = match &request {
            PageManageRequest::Update {
                files, directory, ..
            } if files.is_some() || directory.is_some() => "page_publish".to_string(),
            _ => format!("page_{}", request.action()),
        };
        let mut intent = PermissionIntent::new(permission_action, vec![resource]);
        intent.save_resources.clear();
        intent
            .display_metadata
            .insert("permissionScope".into(), json!("account"));
        intent.display_metadata.insert(
            "requiresFreshApproval".into(),
            json!(context.requires_fresh_approval()),
        );
        intent
            .display_metadata
            .insert("pageOperation".into(), json!(request.action()));
        intent
            .display_metadata
            .insert("pageSlug".into(), json!(request.slug()));
        if let Some(visibility) = normalized.get("visibility") {
            intent
                .display_metadata
                .insert("pageVisibility".into(), visibility.clone());
        }
        if let Some(version) = normalized
            .get("version_id")
            .filter(|value| !value.is_null())
        {
            intent
                .display_metadata
                .insert("pageVersionId".into(), version.clone());
        }
        Ok(vec![intent])
    }

    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        page_account_available().await
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let request = parse_request(input, Some(context)).map_err(OpenBitFunError::tool)?;
        if !page_account_available().await {
            return Err(OpenBitFunError::tool(
                "PageManage requires a logged-in OpenBitFun account",
            ));
        }
        let result = invoke_page_manage(request)
            .await
            .map_err(OpenBitFunError::tool)?;
        let assistant = format!("{}\nPrivate/relay URLs require authenticated access; use the Pages scene/tool card to open them.", serde_json::to_string(&result).map_err(|error| OpenBitFunError::tool(error.to_string()))?);
        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(assistant),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::account_login_capability::{
        lock_account_login_for_test, set_account_login_available,
    };
    use std::collections::HashMap;

    fn context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: Default::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: Default::default(),
        }
    }

    #[test]
    fn page_manage_validates_actions_before_any_host_call() {
        for input in [
            json!({"action": "list", "visibility": "public"}),
            json!({"action": "permissions", "slug": "demo"}),
            json!({"action": "permissions", "slug": "demo", "visibility": "everyone"}),
            json!({"action": "delete", "slug": "../demo"}),
            json!({"action": "delete", "slug": "demo", "version_id": "v1?other=x"}),
            json!({"action": "publish", "slug": "demo"}),
            json!({"action": "publish", "slug": "demo", "files": {"style.css": ""}}),
            json!({"action": "publish", "slug": "demo", "files": {"index.html": ""}, "directory": "x"}),
            json!({"action": "update", "slug": "demo"}),
            json!({"action": "update", "slug": "demo", "title": "Demo", "deploy": true}),
            json!({"action": "update", "slug": "demo", "title": "Demo", "visibility": "public"}),
        ] {
            assert!(parse_request(&input, Some(&context())).is_err(), "{input}");
        }
        assert!(parse_request(
            &json!({"action":"update", "slug":"demo", "title":"New name"}),
            Some(&context())
        )
        .is_ok());
    }

    #[test]
    fn page_manage_defaults_do_not_deploy_or_publish_publicly() {
        let request = parse_request(
            &json!({"action":"publish", "slug":"demo", "files":{"index.html":"Hello"}}),
            None,
        )
        .unwrap();
        assert!(
            matches!(request, PageManageRequest::Publish { deploy: false, ref visibility, .. } if visibility == "private")
        );
        assert!(matches!(
            parse_request(&json!({"action":"list"}), None).unwrap(),
            PageManageRequest::List {
                published_only: true
            }
        ));
    }

    #[test]
    fn page_manage_reads_need_no_approval_but_mutations_are_account_scoped() {
        let tool = PageManageTool::new();
        let preview = tool
            .permission_intents(
                &json!({"action":"publish", "slug":"demo", "files":{"index.html":"Hello"}}),
                &context(),
            )
            .unwrap();
        assert!(preview[0].resources[0].contains("visibility=\"private\""));
        assert!(preview[0].resources[0].contains("deploy=false"));
        let replacement = tool.permission_intents(&json!({"action":"update", "slug":"demo", "files":{"index.html":"Hello"}, "deploy":true}), &context()).unwrap();
        assert_eq!(replacement[0].action, "page_publish");
        let rename = tool
            .permission_intents(
                &json!({"action":"update", "slug":"demo", "title":"Renamed"}),
                &context(),
            )
            .unwrap();
        assert_eq!(rename[0].action, "page_update");
        for input in [
            json!({"action":"list"}),
            json!({"action":"versions", "slug":"demo"}),
        ] {
            assert!(tool
                .permission_intents(&input, &context())
                .unwrap()
                .is_empty());
            assert!(tool.is_concurrency_safe(Some(&input)));
        }
        for input in [
            json!({"action":"publish", "slug":"demo", "files":{"index.html":"Hello"}}),
            json!({"action":"update", "slug":"demo", "title":"New name"}),
            json!({"action":"permissions", "slug":"demo", "visibility":"public"}),
            json!({"action":"delete", "slug":"demo"}),
            json!({"action":"deploy", "slug":"demo", "version_id":"v1"}),
            json!({"action":"unpublish", "slug":"demo"}),
        ] {
            let intents = tool.permission_intents(&input, &context()).unwrap();
            assert_eq!(intents.len(), 1);
            assert_eq!(intents[0].display_metadata["permissionScope"], "account");
            assert!(intents[0].save_resources.is_empty());
            assert!(!tool.is_concurrency_safe(Some(&input)));
        }
    }

    #[tokio::test]
    async fn page_manage_login_gate_and_no_workspace_inline_content() {
        let _guard = lock_account_login_for_test();
        let tool = PageManageTool::new();
        set_account_login_available(false);
        assert!(!tool.is_available_in_context(None).await);
        assert!(tool
            .call_impl(&json!({"action":"list"}), &context())
            .await
            .unwrap_err()
            .to_string()
            .contains("logged-in"));
        set_account_login_available(true);
        assert!(tool.is_available_in_context(None).await);
        let inline = json!({"action":"publish", "slug":"demo", "files":{"index.html":"Hello"}});
        assert!(tool.validate_input(&inline, Some(&context())).await.result);
        let directory = json!({"action":"publish", "slug":"demo", "directory":"/tmp/demo"});
        assert!(
            !tool
                .validate_input(&directory, Some(&context()))
                .await
                .result
        );
        let mut remote = context();
        remote.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
            None,
            std::path::PathBuf::from("/srv/page"),
            "page-connection".into(),
            "Remote".into(),
            crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "remote.example".into(),
                logical_workspace_path: "/srv/page".into(),
                remote_connection_id: Some("page-connection".into()),
            },
        ));
        for action in ["publish", "update"] {
            let input = json!({"action":action, "slug":"demo", "directory":"/srv/page"});
            assert!(tool
                .validate_input(&input, Some(&remote))
                .await
                .message
                .unwrap()
                .contains("remote workspace"));
            let inline = json!({"action":action, "slug":"demo", "files":{"index.html":"Hello"}});
            assert!(tool.validate_input(&inline, Some(&remote)).await.result);
        }
        set_account_login_available(false);
    }
}
