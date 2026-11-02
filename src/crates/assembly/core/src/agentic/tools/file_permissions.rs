use crate::agentic::tools::framework::{PermissionIntent, ToolPathResolution, ToolUseContext};
use crate::agentic::tools::restrictions::{
    canonicalize_local_path_best_effort, is_local_path_within_root,
};
use crate::infrastructure::get_path_manager_arc;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(crate) fn file_permission_intents<'a>(
    action: &str,
    paths: impl IntoIterator<Item = &'a str>,
    context: &ToolUseContext,
) -> OpenBitFunResult<Vec<PermissionIntent>> {
    file_permission_intents_with_plan_edit_access(action, paths, context, false)
}

pub(crate) fn file_permission_intents_allowing_managed_plan_edits<'a>(
    action: &str,
    paths: impl IntoIterator<Item = &'a str>,
    context: &ToolUseContext,
) -> OpenBitFunResult<Vec<PermissionIntent>> {
    file_permission_intents_with_plan_edit_access(action, paths, context, true)
}

fn file_permission_intents_with_plan_edit_access<'a>(
    action: &str,
    paths: impl IntoIterator<Item = &'a str>,
    context: &ToolUseContext,
    allow_managed_plan_edits: bool,
) -> OpenBitFunResult<Vec<PermissionIntent>> {
    let mut resources = Vec::new();
    let mut external_directories = Vec::new();
    let mut seen_resources = HashSet::new();
    let mut seen_external_directories = HashSet::new();
    let mut has_paths = false;

    for path in paths {
        has_paths = true;
        let resolved = context.resolve_tool_path(path)?;
        let skip_edit_permission = allow_managed_plan_edits
            && action == "edit"
            && is_current_workspace_plan_path(context, &resolved)?;
        if !skip_edit_permission {
            let resource = normalized_permission_resource(&resolved)?;
            if seen_resources.insert(resource.clone()) {
                resources.push(resource);
            }
        }

        if let Some(directory) = external_directory_resource(context, &resolved)? {
            if seen_external_directories.insert(directory.clone()) {
                external_directories.push(directory);
            }
        }
    }

    if !has_paths {
        return Err(OpenBitFunError::validation(
            "File permission intent requires at least one resource".to_string(),
        ));
    }

    let mut intents = Vec::new();
    if !resources.is_empty() {
        intents.push(PermissionIntent::new(action, resources));
    }
    if !external_directories.is_empty() {
        intents.push(PermissionIntent::new(
            "external_directory",
            external_directories,
        ));
    }
    Ok(intents)
}

fn normalized_permission_resource(resolved: &ToolPathResolution) -> OpenBitFunResult<String> {
    if resolved.uses_remote_workspace_backend() || resolved.is_runtime_artifact() {
        return Ok(resolved.resolved_path.replace('\\', "/"));
    }

    Ok(
        canonicalize_local_path_best_effort(Path::new(&resolved.resolved_path))?
            .to_string_lossy()
            .replace('\\', "/"),
    )
}

fn external_directory_resource(
    context: &ToolUseContext,
    resolved: &ToolPathResolution,
) -> OpenBitFunResult<Option<String>> {
    if resolved.uses_remote_workspace_backend() || resolved.is_runtime_artifact() {
        return Ok(None);
    }

    if is_openbitfun_managed_local_path(context, resolved)? {
        return Ok(None);
    }

    let workspace_root = context.workspace_root().ok_or_else(|| {
        OpenBitFunError::validation("A workspace is required for file permissions".to_string())
    })?;
    let path = Path::new(&resolved.resolved_path);
    if is_local_path_within_root(path, workspace_root)? {
        return Ok(None);
    }

    let directory = if path.is_dir() {
        path
    } else {
        path.parent().ok_or_else(|| {
            OpenBitFunError::validation(format!(
                "External path '{}' has no parent directory",
                path.display()
            ))
        })?
    };
    Ok(Some(
        canonicalize_local_path_best_effort(directory)?
            .to_string_lossy()
            .replace('\\', "/"),
    ))
}

fn is_openbitfun_managed_local_path(
    context: &ToolUseContext,
    resolved: &ToolPathResolution,
) -> OpenBitFunResult<bool> {
    let path = Path::new(&resolved.resolved_path);
    for root in openbitfun_managed_local_roots(context)? {
        if is_local_path_within_root(path, &root)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_current_workspace_plan_path(
    context: &ToolUseContext,
    resolved: &ToolPathResolution,
) -> OpenBitFunResult<bool> {
    if resolved.uses_remote_workspace_backend()
        || resolved.is_runtime_artifact()
        || context.workspace_root().is_none()
    {
        return Ok(false);
    }

    let workspace_root = context.workspace_root().ok_or_else(|| {
        OpenBitFunError::validation("A workspace is required for plan permissions".to_string())
    })?;
    let plans_root = get_path_manager_arc().project_plans_dir(workspace_root);
    is_local_path_within_root(Path::new(&resolved.resolved_path), &plans_root)
}

fn openbitfun_managed_local_roots(context: &ToolUseContext) -> OpenBitFunResult<Vec<PathBuf>> {
    let mut roots = vec![terminal_transcript_root(context)];
    if context.workspace_root().is_none() {
        return Ok(roots);
    }

    if let Some(session_id) = context.session_id.as_deref() {
        roots.push(
            context
                .current_workspace_session_dir(session_id)?
                .join("artifacts"),
        );
    }
    Ok(roots)
}

fn terminal_transcript_root(_context: &ToolUseContext) -> PathBuf {
    #[cfg(test)]
    if let Some(path) = _context
        .custom_data
        .get("__openbitfun_test_terminal_transcript_root")
        .and_then(|value| value.as_str())
        .filter(|path| !path.trim().is_empty())
    {
        return PathBuf::from(path);
    }

    get_path_manager_arc().user_data_dir().join("terminals")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::Tool;
    use crate::agentic::tools::implementations::{
        DeleteFileTool, FileEditTool, FileReadTool, FileWriteTool,
    };
    use crate::agentic::WorkspaceBinding;
    use openbitfun_runtime_ports::{
        PermissionConstraintLayer, PermissionEffect, PermissionEvaluator, PermissionRule,
    };
    use serde_json::{json, Value};
    use std::fs;

    #[test]
    fn local_external_file_adds_external_directory_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let external = temp.path().join("external");
        fs::create_dir_all(&workspace).expect("workspace dir");
        fs::create_dir_all(&external).expect("external dir");
        let external_file = external.join("outside.txt");
        fs::write(&external_file, "outside").expect("external file");
        let context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);

        let intents =
            file_permission_intents("read", [external_file.to_string_lossy().as_ref()], &context)
                .expect("permission intents");

        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].action, "read");
        assert_eq!(intents[1].action, "external_directory");
        assert_eq!(intents[1].resources.len(), 1);
        assert_eq!(
            intents[1].resources[0],
            canonicalize_local_path_best_effort(&external)
                .expect("canonical external dir")
                .to_string_lossy()
                .replace('\\', "/")
        );
    }

    #[test]
    fn workspace_file_does_not_add_external_directory_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace dir");
        let workspace_file = workspace.join("inside.txt");
        fs::write(&workspace_file, "inside").expect("workspace file");
        let context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);

        let intents = file_permission_intents(
            "read",
            [workspace_file.to_string_lossy().as_ref()],
            &context,
        )
        .expect("permission intents");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "read");
    }

    #[test]
    fn workspace_absolute_constraint_matches_real_file_tool_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let secret = workspace.join("src/secrets/key.txt");
        fs::create_dir_all(secret.parent().expect("secret parent")).expect("secret parent");
        fs::write(&secret, "secret").expect("secret file");
        let context = ToolUseContext::for_tool_listing(
            Some(WorkspaceBinding::new(None, workspace.clone())),
            None,
        );
        let intents = FileReadTool::new()
            .permission_intents(&json!({ "file_path": "src/secrets/key.txt" }), &context)
            .expect("read permission intent");
        let workspace_resource = canonicalize_local_path_best_effort(&workspace)
            .expect("canonical workspace")
            .to_string_lossy()
            .replace('\\', "/");
        let constraints = PermissionConstraintLayer::new(vec![PermissionRule::new(
            "read",
            format!("{workspace_resource}/src/secrets/**"),
            PermissionEffect::Deny,
        )]);

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].resources.len(), 1);
        assert_eq!(
            PermissionEvaluator::for_current_platform().evaluate_constraint_resource(
                &intents[0].action,
                &intents[0].resources[0],
                &constraints,
            ),
            PermissionEffect::Deny
        );
    }

    #[test]
    fn current_session_artifacts_do_not_add_external_directory_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let runtime_root = temp.path().join("runtime");
        fs::create_dir_all(&workspace).expect("workspace dir");

        let mut context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);
        context.session_id = Some("session-1".to_string());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            json!(runtime_root.to_string_lossy().to_string()),
        );

        for path in [
            "openbitfun://current-session/artifacts/session-references/reference.txt",
            "openbitfun://current-session/artifacts/compression-transcripts/transcript.txt",
        ] {
            let intents = file_permission_intents("read", [path], &context)
                .expect("current session permission intents");

            assert_eq!(intents.len(), 1, "{path}");
            assert_eq!(intents[0].action, "read", "{path}");
            assert_eq!(intents[0].resources.len(), 1, "{path}");
        }
    }

    #[test]
    fn managed_local_absolute_paths_do_not_add_external_directory_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let runtime_root = temp.path().join("runtime");
        let terminal_root = temp.path().join("terminals");
        let plan = workspace.join(".openbitfun/plans/plan.plan.md");
        let reference = runtime_root.join("sessions/session-1/artifacts/session-references/ref.md");
        let compression =
            runtime_root.join("sessions/session-1/artifacts/compression-transcripts/turn.md");
        let terminal_agents = terminal_root.join("AGENTS.md");
        let terminal_index = terminal_root.join("index.json");
        let terminal_log = terminal_root.join("transcript-1/000001.log");
        fs::create_dir_all(&workspace).expect("workspace dir");
        for path in [
            &plan,
            &reference,
            &compression,
            &terminal_agents,
            &terminal_index,
            &terminal_log,
        ] {
            fs::create_dir_all(path.parent().expect("parent dir")).expect("parent dir");
            fs::write(path, "content").expect("managed file");
        }

        let mut context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);
        context.session_id = Some("session-1".to_string());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            json!(runtime_root.to_string_lossy().to_string()),
        );
        context.custom_data.insert(
            "__openbitfun_test_terminal_transcript_root".to_string(),
            json!(terminal_root.to_string_lossy().to_string()),
        );

        for path in [
            &plan,
            &reference,
            &compression,
            &terminal_agents,
            &terminal_index,
            &terminal_log,
        ] {
            let file_path = path.to_string_lossy();
            let intents = file_permission_intents("read", [file_path.as_ref()], &context)
                .expect("managed file permission intents");

            assert_eq!(intents.len(), 1, "{}", path.display());
            assert_eq!(intents[0].action, "read", "{}", path.display());
        }

        let plan_path = plan.to_string_lossy();
        let edit = file_permission_intents("edit", [plan_path.as_ref()], &context)
            .expect("managed plan edit permission intents");
        assert_eq!(edit.len(), 1);
        assert_eq!(edit[0].action, "edit");
    }

    #[test]
    fn plan_updates_skip_edit_permission_but_other_managed_writes_do_not() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let runtime_root = temp.path().join("runtime");
        let plan = workspace.join(".openbitfun/plans/plan.plan.md");
        let transcript =
            runtime_root.join("sessions/session-1/artifacts/compression-transcripts/turn.md");
        fs::create_dir_all(&workspace).expect("workspace dir");
        for path in [&plan, &transcript] {
            fs::create_dir_all(path.parent().expect("parent dir")).expect("parent dir");
            fs::write(path, "old").expect("managed file");
        }

        let mut context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);
        context.session_id = Some("session-1".to_string());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            json!(runtime_root.to_string_lossy().to_string()),
        );
        context.custom_data.insert(
            "__openbitfun_test_terminal_transcript_root".to_string(),
            json!(temp.path().join("terminals").to_string_lossy().to_string()),
        );

        let plan_path = plan.to_string_lossy();
        let edit = FileEditTool::new()
            .permission_intents(
                &json!({
                    "file_path": plan_path.as_ref(),
                    "old_string": "old",
                    "new_string": "updated"
                }),
                &context,
            )
            .expect("plan edit permission intents");
        assert!(edit.is_empty());

        let write = FileWriteTool::new()
            .permission_intents(
                &json!({ "payload": format!("+++ {plan_path}\nupdated") }),
                &context,
            )
            .expect("plan write permission intents");
        assert!(write.is_empty());

        let delete = DeleteFileTool::new()
            .permission_intents(&json!({ "path": plan_path.as_ref() }), &context)
            .expect("plan delete permission intents");
        assert_eq!(delete.len(), 1);
        assert_eq!(delete[0].action, "edit");

        let transcript_path = transcript.to_string_lossy();
        let transcript_edit = FileEditTool::new()
            .permission_intents(
                &json!({
                    "file_path": transcript_path.as_ref(),
                    "old_string": "old",
                    "new_string": "updated"
                }),
                &context,
            )
            .expect("transcript edit permission intents");
        assert_eq!(transcript_edit.len(), 1);
        assert_eq!(transcript_edit[0].action, "edit");
    }

    #[test]
    fn project_openbitfun_files_are_not_globally_exempt_from_edit_permission() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let config_file = workspace.join(".openbitfun/config/settings.json");
        fs::create_dir_all(config_file.parent().expect("config parent")).expect("config dir");
        fs::write(&config_file, "{}").expect("config file");

        let context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);
        let file_path = config_file.to_string_lossy();
        let intents = file_permission_intents("edit", [file_path.as_ref()], &context)
            .expect("project config permission intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "edit");
        assert_eq!(intents[0].resources.len(), 1);
    }

    #[test]
    fn unmanaged_runtime_paths_still_add_external_directory_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        let runtime_root = temp.path().join("runtime");
        let snapshot = runtime_root.join("snapshots/snapshot.json");
        fs::create_dir_all(&workspace).expect("workspace dir");
        fs::create_dir_all(snapshot.parent().expect("snapshot parent")).expect("snapshot parent");
        fs::write(&snapshot, "snapshot").expect("snapshot file");

        let mut context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);
        context.session_id = Some("session-1".to_string());
        context.custom_data.insert(
            "__openbitfun_test_runtime_root".to_string(),
            json!(runtime_root.to_string_lossy().to_string()),
        );
        context.custom_data.insert(
            "__openbitfun_test_terminal_transcript_root".to_string(),
            json!(temp.path().join("terminals").to_string_lossy().to_string()),
        );

        let snapshot_path = snapshot.to_string_lossy();
        let intents = file_permission_intents("read", [snapshot_path.as_ref()], &context)
            .expect("snapshot permission intents");

        assert_eq!(intents.len(), 2);
        assert_eq!(intents[0].action, "read");
        assert_eq!(intents[1].action, "external_directory");
    }

    #[test]
    fn multi_file_edit_keeps_patch_targets_in_one_atomic_intent() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace dir");
        let first = workspace.join("first.txt");
        let second = workspace.join("second.txt");
        fs::write(&first, "first").expect("first file");
        fs::write(&second, "second").expect("second file");
        let context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);

        let intents = file_permission_intents(
            "edit",
            [
                first.to_string_lossy().as_ref(),
                second.to_string_lossy().as_ref(),
            ],
            &context,
        )
        .expect("multi-file edit intent");

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "edit");
        assert_eq!(intents[0].resources.len(), 2);
        assert_eq!(intents[0].save_resources, intents[0].resources);
    }

    #[test]
    fn migrated_file_tools_emit_read_and_edit_intents() {
        let temp = tempfile::tempdir().expect("temp dir");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).expect("workspace dir");
        let file = workspace.join("file.txt");
        fs::write(&file, "old").expect("workspace file");
        let mut context =
            ToolUseContext::for_tool_listing(Some(WorkspaceBinding::new(None, workspace)), None);
        context.tool_call_id = Some("tool-call-123".to_string());
        let file_path = file.to_string_lossy();

        let read = FileReadTool::new();
        let write = FileWriteTool::new();
        let edit = FileEditTool::new();
        let delete = DeleteFileTool::new();
        let cases: Vec<(&dyn Tool, Value, &str)> = vec![
            (&read, json!({ "file_path": file_path.as_ref() }), "read"),
            (
                &write,
                json!({ "payload": format!("+++ {}\nnew", file_path) }),
                "edit",
            ),
            (
                &edit,
                json!({
                    "file_path": file_path.as_ref(),
                    "old_string": "old",
                    "new_string": "new"
                }),
                "edit",
            ),
            (&delete, json!({ "path": file_path.as_ref() }), "edit"),
        ];

        for (tool, input, expected_action) in cases {
            let intents = tool
                .permission_intents(&input, &context)
                .expect("file tool permission intent");
            assert_eq!(intents.len(), 1, "{}", tool.name());
            assert_eq!(intents[0].action, expected_action, "{}", tool.name());
            assert_eq!(intents[0].resources.len(), 1, "{}", tool.name());
        }

        let fallback = FileWriteTool::new()
            .permission_intents(&json!({ "payload": "new file" }), &context)
            .expect("fallback write intent");
        assert!(fallback[0].resources[0]
            .replace('\\', "/")
            .ends_with("/.openbitfun/tmp/write_toolcall123.tmp"));
    }
}
