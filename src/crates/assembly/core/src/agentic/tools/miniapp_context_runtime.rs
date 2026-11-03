//! Resolution of the host-owned MiniApp context namespace for Read and Grep.

use crate::agentic::tools::framework::{ToolPathResolution, ToolUseContext};
use crate::miniapp::agent_context::{
    agent_context_file, agent_context_files, MINIAPP_AGENT_CONTEXT_DIR,
};
use std::sync::Arc;

fn scope_from_read_root(read_root: &str) -> Option<&str> {
    let scope = read_root.strip_prefix(&format!("{MINIAPP_AGENT_CONTEXT_DIR}/"))?;
    (scope.len() == 32 && scope.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(scope)
}

fn normalized_relative_child<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    let root = root.trim_end_matches('/');
    if path == root {
        return Some("");
    }
    path.strip_prefix(root)?.strip_prefix('/')
}

fn virtual_target(
    context: &ToolUseContext,
    resolution: &ToolPathResolution,
) -> Option<(String, String)> {
    let scope = context
        .runtime_tool_restrictions
        .miniapp_context_scope
        .as_deref()?;
    if scope.len() != 32 || !scope.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let read_root = format!("{MINIAPP_AGENT_CONTEXT_DIR}/{scope}");
    debug_assert_eq!(scope_from_read_root(&read_root), Some(scope));
    let resolved_root = context.resolve_tool_path(&read_root).ok()?;
    if resolved_root.backend != resolution.backend {
        return None;
    }
    let path = resolution.resolved_path.replace('\\', "/");
    let root = resolved_root.resolved_path.replace('\\', "/");
    let child = normalized_relative_child(&path, &root)?;
    Some((scope.to_string(), child.to_string()))
}

fn is_plain_file_name(value: &str) -> bool {
    !value.is_empty() && !value.contains('/') && !matches!(value, "." | "..")
}

pub(crate) fn is_virtual_context_path(
    context: &ToolUseContext,
    resolution: &ToolPathResolution,
) -> bool {
    virtual_target(context, resolution).is_some()
}

/// Marketplace MiniApps receive a non-empty read-root policy together with a
/// virtual scope. Once that capability is present, Read/Grep must never fall
/// through to a physical alias that merely canonicalizes inside the root.
pub(crate) fn requires_virtual_context_path(context: &ToolUseContext) -> bool {
    context
        .runtime_tool_restrictions
        .miniapp_context_scope
        .is_some()
        && !context
            .runtime_tool_restrictions
            .path_policy
            .read_roots
            .is_empty()
}

pub(crate) fn virtual_context_file(
    context: &ToolUseContext,
    resolution: &ToolPathResolution,
) -> Option<Arc<str>> {
    let (scope, file_name) = virtual_target(context, resolution)?;
    if !is_plain_file_name(&file_name) {
        return None;
    }
    agent_context_file(&scope, &file_name)
}

/// Return virtual files selected by a Grep path. The path may name the whole
/// snapshot root or one exact file; nested directories are never supported.
pub(crate) fn virtual_context_files_for_search(
    context: &ToolUseContext,
    resolution: &ToolPathResolution,
) -> Option<Vec<(String, Arc<str>)>> {
    let (scope, file_name) = virtual_target(context, resolution)?;
    let files = agent_context_files(&scope)?;
    if file_name.is_empty() {
        return Some(
            files
                .iter()
                .map(|(name, content)| {
                    (
                        format!("{MINIAPP_AGENT_CONTEXT_DIR}/{scope}/{name}"),
                        content.clone(),
                    )
                })
                .collect(),
        );
    }
    if !is_plain_file_name(&file_name) {
        return None;
    }
    files.get(&file_name).map(|content| {
        vec![(
            format!("{MINIAPP_AGENT_CONTEXT_DIR}/{scope}/{file_name}"),
            content.clone(),
        )]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::{ToolPathOperation, ToolPathPolicy, ToolRuntimeRestrictions};
    use crate::agentic::WorkspaceBinding;
    use crate::miniapp::agent_context::{
        publish_agent_context_snapshot, remove_agent_context_snapshot, MiniAppAgentContextInput,
    };
    use crate::service::remote_ssh::workspace_state::workspace_session_identity;
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn virtual_context_resolution_is_independent_of_remote_workspace_storage() {
        let snapshot = publish_agent_context_snapshot(
            "remote-context-app",
            "remote-context-session",
            "remote-context-turn",
            vec![MiniAppAgentContextInput {
                name: "market.json".to_string(),
                content: "remote-safe sentinel".to_string(),
            }],
        )
        .unwrap()
        .unwrap();
        let remote_root = "/srv/project";
        let session_identity =
            workspace_session_identity(remote_root, Some("conn-1"), Some("ssh.dev"))
                .expect("remote identity");
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: Some("Agent".to_string()),
            session_id: Some("remote-context-session".to_string()),
            dialog_turn_id: Some("remote-context-turn".to_string()),
            workspace: Some(WorkspaceBinding::new_remote(
                Some("remote-context-workspace".to_string()),
                PathBuf::from(remote_root),
                "conn-1".to_string(),
                "Dev SSH".to_string(),
                session_identity,
            )),
            loaded_deferred_tool_specs: Vec::new(),
            model_client: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions {
                path_policy: ToolPathPolicy {
                    read_roots: vec![snapshot.relative_root.clone()],
                    ..Default::default()
                },
                miniapp_context_scope: Some(snapshot.scope.clone()),
                ..Default::default()
            },
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };
        let resolved = context
            .resolve_tool_path(&format!("{}/market.json", snapshot.relative_root))
            .expect("virtual path should use remote POSIX resolution semantics");
        context
            .enforce_path_operation(ToolPathOperation::Read, &resolved)
            .expect("the exact virtual root remains authorized remotely");
        assert!(is_virtual_context_path(&context, &resolved));
        assert_eq!(
            virtual_context_file(&context, &resolved).as_deref(),
            Some("remote-safe sentinel")
        );
        assert!(remove_agent_context_snapshot(
            "remote-context-session",
            "remote-context-turn"
        ));
    }
}
