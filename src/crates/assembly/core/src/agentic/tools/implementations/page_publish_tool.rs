//! PagePublish tool — create/update a OpenBitFun Page from inline files or a directory,
//! then optionally deploy to production.

use std::collections::HashMap;

use crate::agentic::tools::framework::{PermissionIntent, Tool, ToolResult, ToolUseContext};
use crate::agentic::tools::page_publish_host::page_account_available;
use crate::agentic::tools::page_publish_host::{invoke_page_publish, PagePublishHostRequest};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct PagePublishTool;

impl PagePublishTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PagePublishTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for PagePublishTool {
    fn name(&self) -> &str {
        "PagePublish"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            r#"Publish a OpenBitFun Page to the account relay: upload content, freeze an immutable version, and optionally deploy it to production.

Requires a logged-in GitHub account. This tool is only available after account login. Published Pages can be reviewed and managed later from the Pages scene.

When you produce self-contained publishable web content (landing page, docs site, or a Page with server/worker.js) and the user is logged in, proactively ask whether they want it published to OpenBitFun Page (suggest a slug and visibility). If they already said publish/deploy/上线, proceed with permission confirmation.

IMPORTANT — content source:
- Prefer `files` (inline path→UTF-8 content). For agent-authored pages, pass HTML/JS directly in `files` and call PagePublish. Do NOT Write/Edit page files into the user workspace just to publish, and do NOT create folders like openbitfun-page/ unless the user explicitly asked to keep a local copy.
- Use `directory` only when the user already has (or explicitly wants) page sources on disk in a local workspace. Remote workspaces must use `files` so OpenBitFun never mistakes a remote path for a local path.

Input:
- slug (required): page path id (lowercase letters, digits, hyphens)
- visibility: private | relay | public (default private)
- title?, note?
- deploy: boolean (default false). false = save version only; still returns absolute preview_url
- Exactly one of:
  - files: object map of relative path → UTF-8 file content (default/preferred). Must include index.html and/or server/worker.js
  - directory: existing local workspace path (only when user wants on-disk sources)

Returns version_id, absolute `url` / `preview_url` (plus relative paths), deployed_version_id when deployed. Public links can be shared directly. Private and relay links must be opened or copied through the Pages scene/tool card so the browser receives a scoped one-time access handoff; never share their raw URL as if it were independently accessible.

When telling the user the link: paste the full absolute URL and put a trailing space after it (before any punctuation or newline), so chat linkifiers do not swallow the next character.

Use PageDeploy only to switch an already-saved version_id (rollback / promote a prior version)."#
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Publish a OpenBitFun Page (upload, save version, deploy).".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["slug"],
            "properties": {
                "slug": {
                    "type": "string",
                    "description": "Page slug (lowercase letters, digits, hyphens)."
                },
                "visibility": {
                    "type": "string",
                    "enum": ["private", "relay", "public"],
                    "description": "Page visibility. Defaults to private. Use public only when the user explicitly intends to share the page publicly."
                },
                "title": {
                    "type": "string",
                    "description": "Optional page title (defaults to slug)."
                },
                "note": {
                    "type": "string",
                    "description": "Optional version note."
                },
                "deploy": {
                    "type": "boolean",
                    "description": "Deploy to production after saving. Defaults to false; set true only when the user explicitly asked to publish or deploy."
                },
                "files": {
                    "type": "object",
                    "additionalProperties": { "type": "string" },
                    "description": "Preferred. Inline path→UTF-8 content map (e.g. index.html). Do not write these into the workspace first. Must include index.html and/or server/worker.js. Mutually exclusive with directory."
                },
                "directory": {
                    "type": "string",
                    "description": "Only when page sources already exist (or user asked to keep them) on disk in a local workspace. Remote workspaces must use files. Mutually exclusive with files."
                }
            }
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let slug = input
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("<missing-slug>");
        let visibility = input
            .get("visibility")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("private");
        let deploy = input
            .get("deploy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let resource = format!(
            "page:{slug}; visibility={visibility}; deploy={}",
            if deploy {
                "production"
            } else {
                "saved-version-only"
            }
        );
        let mut intent = PermissionIntent::new("page_publish", vec![resource]);
        // Publishing decisions should stay per-call: a remembered wildcard grant could
        // otherwise hide a later change from private preview to public production.
        intent.save_resources.clear();
        intent.display_metadata.insert(
            "permissionScope".to_string(),
            Value::String("account".to_string()),
        );
        intent
            .display_metadata
            .insert("requiresFreshApproval".to_string(), Value::Bool(true));
        intent.display_metadata.insert(
            "pageOperation".to_string(),
            Value::String(if deploy { "publish" } else { "save" }.to_string()),
        );
        intent
            .display_metadata
            .insert("pageSlug".to_string(), Value::String(slug.to_string()));
        intent.display_metadata.insert(
            "pageVisibility".to_string(),
            Value::String(visibility.to_string()),
        );
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
        if !page_account_available().await {
            return Err(OpenBitFunError::tool(
                "PagePublish requires a logged-in GitHub account".to_string(),
            ));
        }

        let slug = input
            .get("slug")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| OpenBitFunError::tool("slug is required".to_string()))?
            .to_string();

        let visibility = input
            .get("visibility")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("private")
            .to_string();

        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let note = input
            .get("note")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let deploy = input
            .get("deploy")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let directory = input
            .get("directory")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        if directory.is_some() && context.workspace.is_none() {
            return Err(OpenBitFunError::tool(
                "PagePublish directory requires a local workspace; use inline files when no workspace is open"
                    .to_string(),
            ));
        }
        if directory.is_some() && context.is_remote() {
            return Err(OpenBitFunError::tool(
                "PagePublish cannot read a remote workspace directory through the local desktop host; use inline files"
                    .to_string(),
            ));
        }

        let files = parse_files_map(input.get("files"))?;

        match (&directory, &files) {
            (Some(_), Some(_)) => {
                return Err(OpenBitFunError::tool(
                    "provide either directory or files, not both".to_string(),
                ));
            }
            (None, None) => {
                return Err(OpenBitFunError::tool(
                    "either directory or files is required".to_string(),
                ));
            }
            _ => {}
        }

        let result = invoke_page_publish(PagePublishHostRequest {
            slug: slug.clone(),
            visibility: visibility.clone(),
            title,
            note,
            deploy,
            directory,
            files,
        })
        .await
        .map_err(OpenBitFunError::tool)?;

        let version_id = result
            .get("version_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let url = result
            .get("url")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| result.get("url_path").and_then(|v| v.as_str()))
            .unwrap_or("");
        let preview = result
            .get("preview_url")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| result.get("preview_url_path").and_then(|v| v.as_str()))
            .unwrap_or("");
        let deployed = result
            .get("deployed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let assistant =
            publish_result_for_assistant(&slug, version_id, &visibility, deployed, url, preview);

        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(assistant),
            image_attachments: None,
        }])
    }
}

fn publish_result_for_assistant(
    slug: &str,
    version_id: &str,
    visibility: &str,
    deployed: bool,
    url: &str,
    preview: &str,
) -> String {
    if visibility != "public" {
        let state = if deployed {
            "published to production"
        } else {
            "saved without changing production"
        };
        return format!(
            "OpenBitFun Page '{slug}' version '{version_id}' was {state} with {visibility} visibility. Open or copy it from the Pages scene/tool card so OpenBitFun can create a scoped browser-access link; do not share the raw Page URL."
        );
    }

    // Trailing space after URL keeps chat linkifiers from eating the next char.
    if deployed {
        if url.is_empty() {
            format!(
                "Published public OpenBitFun Page '{slug}' version '{version_id}' to production."
            )
        } else {
            format!(
                "Published public OpenBitFun Page '{slug}' version '{version_id}'. Production URL: {url} \n\
                 Share this full absolute URL with the user, and keep a trailing space after the URL."
            )
        }
    } else if preview.is_empty() {
        format!("Saved public OpenBitFun Page '{slug}' version '{version_id}' (not deployed).")
    } else {
        format!(
            "Saved public OpenBitFun Page '{slug}' version '{version_id}' (not deployed). Preview URL: {preview} \n\
             Share this full absolute URL with the user, and keep a trailing space after the URL."
        )
    }
}

fn parse_files_map(value: Option<&Value>) -> OpenBitFunResult<Option<HashMap<String, String>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let obj = value.as_object().ok_or_else(|| {
        OpenBitFunError::tool("files must be an object of path→content strings".to_string())
    })?;
    if obj.is_empty() {
        return Err(OpenBitFunError::tool("files must not be empty".to_string()));
    }
    let mut map = HashMap::with_capacity(obj.len());
    for (path, content) in obj {
        let Some(text) = content.as_str() else {
            return Err(OpenBitFunError::tool(format!(
                "files['{path}'] must be a UTF-8 string"
            )));
        };
        map.insert(path.clone(), text.to_string());
    }
    Ok(Some(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::account_login_capability::{
        lock_account_login_for_test, set_account_login_available,
    };

    fn empty_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn login_gate_controls_availability_and_execution() {
        let _guard = lock_account_login_for_test();
        let tool = PagePublishTool::new();

        set_account_login_available(false);
        assert!(!tool.is_available_in_context(None).await);

        set_account_login_available(true);
        assert!(tool.is_available_in_context(None).await);

        set_account_login_available(false);
        let err = tool
            .call_impl(
                &json!({
                    "slug": "demo",
                    "files": { "index.html": "<html></html>" }
                }),
                &empty_context(),
            )
            .await
            .expect_err("should reject without login");
        assert!(err.to_string().contains("logged-in"));
    }

    #[tokio::test]
    async fn rejects_missing_source_when_logged_in() {
        let _guard = lock_account_login_for_test();
        let tool = PagePublishTool::new();
        set_account_login_available(true);
        let err = tool
            .call_impl(&json!({ "slug": "demo" }), &empty_context())
            .await
            .expect_err("should require files or directory");
        assert!(err.to_string().contains("directory or files"));
        set_account_login_available(false);
    }

    #[test]
    fn permission_intent_exposes_safe_defaults_and_publish_scope() {
        let tool = PagePublishTool::new();
        let intents = tool
            .permission_intents(
                &json!({
                    "slug": "release-notes",
                    "files": { "index.html": "<html></html>" }
                }),
                &empty_context(),
            )
            .expect("permission intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "page_publish");
        assert_eq!(
            intents[0].resources,
            vec!["page:release-notes; visibility=private; deploy=saved-version-only"]
        );
        assert!(intents[0].save_resources.is_empty());
        assert_eq!(
            intents[0].display_metadata.get("permissionScope"),
            Some(&Value::String("account".to_string()))
        );
        assert_eq!(
            intents[0].display_metadata.get("requiresFreshApproval"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            intents[0].display_metadata.get("pageOperation"),
            Some(&Value::String("save".to_string()))
        );

        let public_deploy = tool
            .permission_intents(
                &json!({
                    "slug": "launch",
                    "visibility": "public",
                    "deploy": true,
                    "files": { "index.html": "<html></html>" }
                }),
                &empty_context(),
            )
            .expect("public deploy permission intent");
        assert_eq!(
            public_deploy[0].resources,
            vec!["page:launch; visibility=public; deploy=production"]
        );
        assert_eq!(
            public_deploy[0].display_metadata.get("pageOperation"),
            Some(&Value::String("publish".to_string()))
        );
    }

    #[tokio::test]
    async fn directory_source_requires_a_local_workspace() {
        let _guard = lock_account_login_for_test();
        let tool = PagePublishTool::new();
        set_account_login_available(true);

        let no_workspace_error = tool
            .call_impl(
                &json!({ "slug": "demo", "directory": "page" }),
                &empty_context(),
            )
            .await
            .expect_err("directory without workspace should be rejected");
        assert!(no_workspace_error.to_string().contains("local workspace"));

        let mut remote_context = empty_context();
        remote_context.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
            None,
            std::path::PathBuf::from("/srv/page"),
            "connection-1".to_string(),
            "Remote".to_string(),
            crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "remote.example".to_string(),
                logical_workspace_path: "/srv/page".to_string(),
                remote_connection_id: Some("connection-1".to_string()),
            },
        ));
        let remote_error = tool
            .call_impl(
                &json!({ "slug": "demo", "directory": "." }),
                &remote_context,
            )
            .await
            .expect_err("remote directory should be rejected");
        assert!(remote_error.to_string().contains("remote workspace"));
        set_account_login_available(false);
    }

    #[test]
    fn private_result_never_advertises_the_raw_url() {
        let message = publish_result_for_assistant(
            "demo",
            "v1",
            "private",
            true,
            "https://relay.example/p/alice/demo",
            "https://relay.example/p/alice/demo/@v/v1",
        );
        assert!(!message.contains("https://"));
        assert!(message.contains("scoped browser-access link"));
    }
}
