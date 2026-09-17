//! Complete ExecCommand preflight. Interactive stdin and Git retain their legacy
//! entry points; they are not assumed to contain complete shell source.
use super::*;
use openbitfun_runtime_ports::WorkspacePathKind;
use tool_runtime::shell_analysis::{analyze, AnalysisStatus, FileOperation, Span};

pub(super) async fn active_state(context: &ToolUseContext) -> Option<EditConstraintState> {
    if !is_enabled().await {
        return None;
    }
    let state = get_global_coordinator()?
        .get_session_manager()
        .edit_constraint_state(context.session_id.as_deref()?)?;
    state.has_enforceable_constraints().then_some(state)
}

pub async fn check_exec_command(
    context: &ToolUseContext,
    command: &str,
    shell_kind: &str,
    workdir: &str,
) -> Option<ValidationResult> {
    let state = active_state(context).await?;
    check_enabled_with_state(context, command, shell_kind, workdir, &state).await
}

async fn check_enabled_with_state(
    context: &ToolUseContext,
    command: &str,
    shell_kind: &str,
    workdir: &str,
    state: &EditConstraintState,
) -> Option<ValidationResult> {
    if !is_enabled().await {
        return None;
    }
    check_with_state(context, command, shell_kind, workdir, state).await
}

pub(crate) async fn check_with_state(
    context: &ToolUseContext,
    command: &str,
    shell_kind: &str,
    workdir: &str,
    state: &EditConstraintState,
) -> Option<ValidationResult> {
    if !state.has_enforceable_constraints() {
        return None;
    }
    let analysis = analyze(command, shell_kind, workdir);
    // A syntax failure cannot supply reliable target facts. Never mislabel it
    // as a violation of a fabricated path.
    if analysis.parse_status != AnalysisStatus::Supported {
        let issue = analysis.unresolved_effects.first()?;
        return Some(reject(
            context,
            state,
            None,
            None,
            shell_kind,
            workdir,
            issue.span,
            analysis.parse_status,
            "deny_shell_analysis",
            issue.reason,
        ));
    }
    for op in &analysis.file_operations {
        // Apply logical policy before IO, then physical policy after resolving
        // symlinks/parents. Remote IO never consults the controller filesystem.
        if let Some(c) = find_violation_for_operation(&state.constraints, &op.path, op.operation) {
            return Some(reject(
                context,
                state,
                Some(c),
                Some(op),
                shell_kind,
                &op.cwd,
                op.source_span,
                analysis.parse_status,
                "deny_constraint",
                "target violates task constraint",
            ));
        }
        let paths = match resolved_candidates(context, &op.path).await {
            Ok(paths) => paths,
            Err(reason) => {
                return Some(reject(
                    context,
                    state,
                    None,
                    Some(op),
                    shell_kind,
                    &op.cwd,
                    op.source_span,
                    analysis.parse_status,
                    "deny_unresolved_target",
                    reason,
                ))
            }
        };
        for path in paths {
            if let Some(c) = find_violation_for_operation(&state.constraints, &path, op.operation) {
                let mut resolved = op.clone();
                resolved.path = path;
                return Some(reject(
                    context,
                    state,
                    Some(c),
                    Some(&resolved),
                    shell_kind,
                    &op.cwd,
                    op.source_span,
                    analysis.parse_status,
                    "deny_constraint",
                    "target violates task constraint",
                ));
            }
        }
    }
    if let Some(issue) = analysis.unresolved_effects.first() {
        return Some(reject(
            context,
            state,
            None,
            None,
            shell_kind,
            workdir,
            issue.span,
            analysis.parse_status,
            "deny_unresolved_target",
            issue.reason,
        ));
    }
    None
}

async fn resolved_candidates(
    context: &ToolUseContext,
    path: &str,
) -> Result<Vec<String>, &'static str> {
    // Preserve the undecoded POSIX path until after physical inspection. In
    // particular link/../file cannot be normalized using string arithmetic.
    if path.len() > 32 * 1024 || path.split('/').count() > 256 {
        return Err("path inspection resource limit");
    }
    if context.is_remote() {
        let fs = context
            .ws_fs()
            .ok_or("remote path inspection unavailable")?;
        let mut current = String::new();
        let mut missing = false;
        for component in path.split('/').filter(|s| !s.is_empty()) {
            if component == "." {
                continue;
            }
            if component == ".." {
                if missing {
                    return Err("parent traversal after an unconfirmed remote path");
                }
                current = current
                    .rsplit_once('/')
                    .map(|(p, _)| p.to_owned())
                    .unwrap_or_default();
                continue;
            }
            current.push('/');
            current.push_str(component);
            if missing {
                continue;
            }
            match fs
                .path_kind_no_follow(&current)
                .await
                .map_err(|_| "remote path inspection failed")?
            {
                Some(WorkspacePathKind::Symlink) => {
                    return Err("remote symbolic link target cannot be confirmed")
                }
                Some(_) => {}
                None => missing = true,
            }
        }
        // Existing tool routing/remote path contracts still apply; it must not
        // silently route a remote command's file target to local runtime data.
        let resolved = context
            .resolve_tool_path(&current)
            .map_err(|_| "remote target outside supported path context")?;
        if !resolved.uses_remote_workspace_backend() {
            return Err("remote target resolved to a local backend");
        }
        Ok(vec![current, resolved.logical_path, resolved.resolved_path])
    } else {
        let mut pending = Path::new(path).to_path_buf();
        let mut tail = vec![];
        loop {
            match fs::canonicalize(&pending) {
                Ok(mut canonical) => {
                    for part in tail.iter().rev() {
                        canonical.push(part);
                    }
                    let physical = canonical.to_string_lossy().to_string();
                    let resolved = context
                        .resolve_tool_path(&physical)
                        .map_err(|_| "target path resolution failed")?;
                    if resolved.uses_remote_workspace_backend() {
                        return Err("local shell target resolved to a remote backend");
                    }
                    return Ok(vec![
                        physical,
                        resolved.logical_path,
                        resolved.resolved_path,
                    ]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // A dangling symlink is not a nonexistent ordinary leaf.
                    if fs::symlink_metadata(&pending).is_ok() {
                        return Err("unconfirmed symbolic link target");
                    }
                    let part = pending
                        .file_name()
                        .ok_or("unconfirmed parent path")?
                        .to_os_string();
                    tail.push(part);
                    if !pending.pop() {
                        return Err("unconfirmed parent path");
                    }
                }
                Err(_) => return Err("path inspection failed"),
            }
        }
    }
}
fn safe(s: &str) -> String {
    s.chars().take(512).flat_map(char::escape_debug).collect()
}
#[allow(clippy::too_many_arguments)]
fn reject(
    context: &ToolUseContext,
    state: &EditConstraintState,
    constraint: Option<&ExtractedConstraint>,
    op: Option<&FileOperation>,
    shell: &str,
    cwd: &str,
    span: Span,
    status: AnalysisStatus,
    decision: &str,
    reason: &str,
) -> ValidationResult {
    let mut meta = json!({
        "failure_kind":"edit_constraint_guard", "blocks_input_rewrite":true,
        "guard_decision_id":Uuid::new_v4().to_string(), "guard_decision":decision,
        "constraint_id":constraint.map(|c|safe(&c.id)), "protected_path":constraint.and(op.map(|o|safe(&o.path))),
        "force_requested":false, "executed":false, "analysis_status":status,
        "operation":op.map(|o|o.operation), "resolved_target":if decision=="deny_constraint" {op.map(|o|safe(&o.path))}else{None}, "requested_target":op.map(|o|safe(&o.path)),
        "source_span":{"start":span.start,"end":span.end,"unit":"utf8_bytes","end_exclusive":true},
        "effective_workdir":safe(cwd), "shell_kind":safe(shell), "reason":reason,
    });
    if let Some(c) = constraint {
        meta["constraint_description"] = json!(safe(&c.description));
    }
    let message = if let (Some(c), Some(op)) = (constraint, op) {
        format!("Command was not executed. {} of `{}` violates task constraint: \"{}\". Use a permitted explicit target.",op.operation,safe(&op.path),safe(&c.description))
    } else {
        format!("Command was not executed. Shell analysis could not confirm this operation: {reason}. Use explicit paths and inspectable execution input; invalid or unsupported syntax must be corrected.")
    };
    // Keep the compatibility error category and carry the bounded facts through
    // its existing string observation path, including original-input rejections.
    let message = format!("{message}\nShell guard details: {meta}");
    append_tool_telemetry(
        context,
        &json!({"event":"shell_guard_decision","schema_version":EDIT_CONSTRAINT_SCHEMA_VERSION,"details":meta,"extraction_status":state.latest_status()}),
    );
    ValidationResult {
        result: false,
        message: Some(message),
        error_code: Some(403),
        meta: Some(meta),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::WorkspaceBinding;
    use openbitfun_runtime_ports::{
        ToolRuntimeHandles, WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
        WorkspaceFileSystem, WorkspaceServices, WorkspaceShell,
    };
    use std::sync::Arc;
    struct RemoteFixture {
        link: bool,
        unavailable: bool,
        seen: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl WorkspaceFileSystem for RemoteFixture {
        async fn path_kind_no_follow(
            &self,
            path: &str,
        ) -> anyhow::Result<Option<WorkspacePathKind>> {
            self.seen.lock().unwrap().push(path.into());
            if self.unavailable {
                anyhow::bail!("fixture offline");
            }
            Ok(if self.link && path.ends_with("/link") {
                Some(WorkspacePathKind::Symlink)
            } else if path.ends_with("/output") {
                None
            } else {
                Some(WorkspacePathKind::Directory)
            })
        }
        async fn read_file(&self, _: &str) -> anyhow::Result<Vec<u8>> {
            panic!("guard must not read script contents")
        }
        async fn read_file_text(&self, _: &str) -> anyhow::Result<String> {
            panic!("guard must not read script contents")
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
            panic!("guard must not write")
        }
        async fn exists(&self, _: &str) -> anyhow::Result<bool> {
            panic!("must use no-follow metadata")
        }
        async fn is_file(&self, _: &str) -> anyhow::Result<bool> {
            panic!("must use no-follow metadata")
        }
        async fn is_dir(&self, _: &str) -> anyhow::Result<bool> {
            panic!("must use no-follow metadata")
        }
        async fn read_dir(&self, _: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            panic!("no directory traversal")
        }
    }
    struct NoShell;
    #[async_trait::async_trait]
    impl WorkspaceShell for NoShell {
        async fn exec_with_options(
            &self,
            _: &str,
            _: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            panic!("path checks must not execute shell probes")
        }
    }
    #[tokio::test]
    async fn complete_shell_remote_path_contract_never_uses_local_mirror() {
        let root = tempfile::tempdir().unwrap();
        let logical = root.path().to_string_lossy();
        let identity = crate::service::remote_ssh::workspace_state::workspace_session_identity(
            &logical,
            Some("guard-fixture"),
            Some("remote.invalid"),
        )
        .unwrap();
        let workspace = WorkspaceBinding::new_remote(
            None,
            root.path().into(),
            "guard-fixture".into(),
            "fixture".into(),
            identity,
        );
        for (link, unavailable) in [(false, false), (true, false), (false, true)] {
            let fs = Arc::new(RemoteFixture {
                link,
                unavailable,
                seen: Mutex::new(vec![]),
            });
            let services = WorkspaceServices {
                fs: fs.clone(),
                shell: Arc::new(NoShell),
            };
            let mut context = ToolUseContext::for_tool_listing(Some(workspace.clone()), None);
            context.runtime_handles = ToolRuntimeHandles::new(Some(services), None);
            // The local directory exists and contains no link. A remote link
            // or transport failure must still reject rather than use it.
            let target = format!("{logical}/link/output");
            let result = resolved_candidates(&context, &target).await;
            assert_eq!(result.is_ok(), !link && !unavailable);
            assert!(!fs.seen.lock().unwrap().is_empty());
        }
    }
    #[tokio::test]
    async fn complete_shell_disabled_ignores_restored_windows_constraints() {
        let state: EditConstraintState = serde_json::from_value(serde_json::json!({
            "schema_version": 6,
            "constraints": [{
                "id": "legacy:test", "description": "Do not modify tests",
                "matcher": {"kind": "test_files"}
            }],
            "extractions": []
        }))
        .unwrap();
        assert!(state.has_enforceable_constraints());
        let context = ToolUseContext::for_tool_listing(None, None);
        for enabled in [false, true, false] {
            let result = TEST_ENABLED
                .scope(
                    enabled,
                    check_enabled_with_state(
                        &context,
                        "Get-Location",
                        "powershell",
                        r"E:\guard-repro",
                        &state,
                    ),
                )
                .await;
            assert_eq!(result.is_some(), enabled);
            if let Some(rejection) = result {
                assert!(rejection
                    .message
                    .unwrap()
                    .contains("non-POSIX working directory"));
            }
        }
        assert!(state.has_enforceable_constraints());
    }

    #[tokio::test]
    async fn complete_shell_no_constraints_preserves_unknown_dialect() {
        let context = ToolUseContext::for_tool_listing(None, None);
        assert!(check_with_state(
            &context,
            "not parseable '",
            "powershell",
            "/anything",
            &EditConstraintState::default()
        )
        .await
        .is_none());
    }
}

#[cfg(all(test, unix))]
#[tokio::test]
async fn complete_shell_acceptance_through_real_local_path_guard() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../execution/tool-execution/src/shell_analysis/fixtures/acceptance.json"
    )))
    .unwrap();
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for case in cases {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let root = root.to_string_lossy();
        for path in ["app", "tmp/lab", "logs/agent"] {
            fs::create_dir_all(format!("{root}/{path}")).unwrap();
        }
        let map = |s: &str| {
            s.replace("/app", "@@APP@@")
                .replace("/tmp", "@@TMP@@")
                .replace("/logs", "@@LOGS@@")
                .replace("@@APP@@", &format!("{root}/app"))
                .replace("@@TMP@@", &format!("{root}/tmp"))
                .replace("@@LOGS@@", &format!("{root}/logs"))
        };
        let id = case["id"].as_str().unwrap();
        if id == "CW07" {
            #[cfg(unix)]
            std::os::unix::fs::symlink(format!("{root}/app"), format!("{root}/tmp/lab/link"))
                .unwrap();
            #[cfg(not(unix))]
            continue;
        }
        let context = ToolUseContext::for_tool_listing(
            Some(crate::agentic::WorkspaceBinding::new(
                None,
                format!("{root}/app").into(),
            )),
            None,
        );
        let state = EditConstraintState {
            constraints: if case["context_overrides"]["active_constraints"] == false {
                vec![]
            } else {
                vec![ExtractedConstraint {
                    id: "fixture".into(),
                    description: "Do not modify repository".into(),
                    matcher: ConstraintMatcher::PathUnderDir {
                        dirs: vec![format!("{root}/app")],
                    },
                    operation_scope: ConstraintOperationScope::All,
                    source: ConstraintSource::Legacy,
                    source_text: None,
                }]
            },
            ..Default::default()
        };
        let result = check_with_state(
            &context,
            &map(case["command"].as_str().unwrap()),
            case["context_overrides"]["shell_kind"]
                .as_str()
                .unwrap_or("bash"),
            &map(case["context_overrides"]["workdir"]
                .as_str()
                .unwrap_or("/app")),
            &state,
        )
        .await;
        let decision = match result
            .as_ref()
            .and_then(|v| v.meta.as_ref())
            .and_then(|v| v["guard_decision"].as_str())
        {
            None => "no_guard_rejection",
            Some("deny_constraint") => "deny_protected",
            Some("deny_shell_analysis") => "invalid_or_unresolved",
            _ => "deny_unresolved",
        };
        let expected = &case["expected"]["guard_decision"];
        let choices = expected
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![expected.clone()]);
        assert!(
            choices.iter().any(|v| v == decision),
            "{id}: {decision}, expected {choices:?}; {result:?}"
        );
        *counts.entry(decision.into()).or_default() += 1;
    }
    eprintln!("Core acceptance decisions: {counts:?}");
}
