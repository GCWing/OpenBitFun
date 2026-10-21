//! Git HostInvoke handlers for CLI Peer Host.

use serde_json::{json, Value};

use openbitfun_core::service::git::{trust, GitError, GitService};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::peer_host::args::{get_string, optional_string, request_value};

async fn repository_path_for_workspace(request: &Value) -> Result<String, String> {
    let service = openbitfun_core::service::workspace::get_global_workspace_service()
        .ok_or("Workspace service is unavailable")?;
    let path = optional_string(request, "repositoryPath").unwrap_or_default();
    let workspace = match optional_string(request, "workspaceId") {
        Some(id) => service
            .require_workspace(&id)
            .await
            .map_err(|e| e.to_string())?,
        None => service
            .resolve_legacy_workspace_reference(None, &path, None, None)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy Git workspace cannot be resolved; select a workspace by ID")?,
    };
    resolved_repository_path(
        workspace.workspace_kind,
        &workspace.root_path.to_string_lossy(),
        path,
        optional_string(request, "workspaceId").is_some(),
    )
}

fn resolved_repository_path(
    kind: openbitfun_core::service::workspace::WorkspaceKind,
    root: &str,
    legacy_path: String,
    has_workspace_id: bool,
) -> Result<String, String> {
    if kind == openbitfun_core::service::workspace::WorkspaceKind::Remote {
        return Err("CLI peer Git inspection does not support remote workspaces; local filesystem fallback was not attempted".into());
    }
    Ok(if has_workspace_id || legacy_path.is_empty() {
        root.to_string()
    } else {
        legacy_path
    })
}

/// Read-only Git panel operations. Workspace resolution runs before opening a
/// repository so an SSH workspace can never fall back to a same-named local path.
pub(crate) async fn read(command: &str, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = repository_path_for_workspace(request).await?;
    read_at_path(command, &path, request).await
}

fn git_result<T: Serialize>(command: &str, result: Result<T, GitError>) -> Result<Value, String> {
    let value = result.map_err(|error| match error.untrusted_repository_path() {
        Some(path) => trust::untrusted_repository_error_message(path),
        None => format!("{command} failed: {error}"),
    })?;
    serde_json::to_value(value).map_err(|error| format!("Invalid {command} response: {error}"))
}

fn required_params<T: DeserializeOwned>(request: &Value) -> Result<T, String> {
    serde_json::from_value(request.get("params").cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("Invalid Git params: {error}"))
}

#[derive(Deserialize)]
struct BranchOptions {
    #[serde(default, rename = "includeRemote", alias = "include_remote")]
    include_remote: Option<bool>,
}

async fn read_at_path(command: &str, path: &str, request: &Value) -> Result<Value, String> {
    match command {
        "git_get_repository" => git_result(command, GitService::get_repository(path).await),
        "git_get_repository_basic" => {
            git_result(command, GitService::get_repository_basic(path).await)
        }
        "git_get_status" => git_result(command, GitService::get_status(path).await),
        "git_get_branches" | "git_get_enhanced_branches" => {
            let options: BranchOptions = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid Git branch request: {error}"))?;
            let include_remote = options.include_remote.unwrap_or(false);
            if command == "git_get_branches" {
                git_result(
                    command,
                    GitService::get_branches(path, include_remote).await,
                )
            } else {
                git_result(
                    command,
                    GitService::get_enhanced_branches(path, include_remote).await,
                )
            }
        }
        "git_get_commits" => {
            // Like Desktop, absent/null log params select the owner's defaults.
            let params = request.get("params").filter(|value| !value.is_null());
            let params = match params {
                Some(params) => serde_json::from_value(params.clone())
                    .map_err(|error| format!("Invalid Git log params: {error}"))?,
                None => Default::default(),
            };
            git_result(command, GitService::get_commits(path, params).await)
        }
        "git_get_diff" => {
            let params = required_params(request)?;
            git_result(command, GitService::get_diff(path, &params).await)
        }
        "git_get_changed_files" => {
            let params = required_params(request)?;
            git_result(command, GitService::get_changed_files(path, &params).await)
        }
        "git_resolve_revision" => {
            let revision = get_string(request, "revision")?;
            git_result(command, GitService::resolve_revision(path, &revision).await)
        }
        other => Err(format!("Unknown CLI peer Git read command '{other}'")),
    }
}

pub(crate) async fn git_is_repository(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let repository_path = repository_path_for_workspace(request).await?;
    let is_repo = GitService::is_repository(&repository_path)
        .await
        .map_err(|e| {
            tracing::error!("Failed to check Git repository: path={repository_path}, error={e}");
            format!("Failed to check Git repository: {e}")
        })?;
    Ok(json!(is_repo))
}

/// Read-only ownership-trust probe.
///
/// Granting trust writes to the host user's global Git configuration, so that
/// decision stays on surfaces where the user is at the machine; a controller
/// only gets the diagnosis and the manual command.
pub(crate) async fn git_get_repository_trust(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let repository_path = repository_path_for_workspace(request).await?;
    let report = GitService::inspect_trust(&repository_path)
        .await
        .map_err(|e| {
            tracing::error!(
                "Failed to inspect Git repository trust: path={repository_path}, error={e}"
            );
            format!("Failed to inspect Git repository trust: {e}")
        })?;
    serde_json::to_value(report).map_err(|e| format!("Failed to serialize trust report: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::service::workspace::WorkspaceKind;
    use openbitfun_services_core::process_manager::create_command;
    use std::path::Path;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = create_command("git")
            .current_dir(path)
            .args(["-c", "core.hooksPath=", "-c", "commit.gpgSign=false"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", path.join("fixture-global-config"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "Fixture"]);
        git(
            dir.path(),
            &["config", "user.email", "fixture@example.invalid"],
        );
        std::fs::write(dir.path().join("tracked.txt"), "before\n").unwrap();
        git(dir.path(), &["add", "tracked.txt"]);
        git(dir.path(), &["commit", "-m", "initial fixture"]);
        dir
    }

    #[tokio::test]
    async fn git_panel_reads_keep_owner_wire_shapes_and_do_not_mutate_repository() {
        let dir = fixture();
        let path = dir.path().to_str().unwrap();
        let head = git(dir.path(), &["rev-parse", "HEAD"]);
        std::fs::write(dir.path().join("tracked.txt"), "after\n").unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "new\n").unwrap();
        let status_before = git(dir.path(), &["status", "--porcelain"]);
        let index_before = std::fs::read(dir.path().join(".git/index")).unwrap();
        for command in ["git_get_repository", "git_get_repository_basic"] {
            let result = read_at_path(command, path, &json!({})).await.unwrap();
            assert_eq!(result["current_branch"], "main");
            assert_eq!(result["is_bare"], false);
            assert!(result["remotes"].is_array());
        }
        let status = read_at_path("git_get_status", path, &json!({}))
            .await
            .unwrap();
        assert_eq!(status["unstaged"][0]["path"], "tracked.txt");
        assert_eq!(status["untracked"][0], "untracked.txt");
        for command in ["git_get_branches", "git_get_enhanced_branches"] {
            let branches = read_at_path(command, path, &json!({"includeRemote": false}))
                .await
                .unwrap();
            assert!(branches
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["name"] == "main" && b["current"] == true));
        }
        let commits = read_at_path(
            "git_get_commits",
            path,
            &json!({"params": {"max_count": 1}}),
        )
        .await
        .unwrap();
        assert_eq!(commits.as_array().unwrap().len(), 1);
        assert_eq!(commits[0]["hash"], head);
        let diff = read_at_path(
            "git_get_diff",
            path,
            &json!({"params": {"files": ["tracked.txt"], "reviewSafe": true}}),
        )
        .await
        .unwrap();
        assert!(diff.as_str().unwrap().contains("+after"));
        let files = read_at_path(
            "git_get_changed_files",
            path,
            &json!({"params": {"reviewSafe": true}}),
        )
        .await
        .unwrap();
        assert_eq!(files[0]["path"], "tracked.txt");
        assert_eq!(files[0]["status"], "modified");
        let revision = read_at_path("git_resolve_revision", path, &json!({"revision": "HEAD"}))
            .await
            .unwrap();
        assert_eq!(revision, head);
        assert_eq!(git(dir.path(), &["status", "--porcelain"]), status_before);
        assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]), head);
        assert_eq!(
            std::fs::read(dir.path().join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("tracked.txt")).unwrap(),
            "after\n"
        );
    }

    #[test]
    fn workspace_identity_wins_and_remote_scope_never_uses_local_path() {
        let sentinel = fixture();
        let root = sentinel.path().to_str().unwrap();
        assert_eq!(
            resolved_repository_path(WorkspaceKind::Normal, root, "wrong-path".into(), true)
                .unwrap(),
            root
        );
        assert_eq!(
            resolved_repository_path(WorkspaceKind::Normal, root, "legacy-path".into(), false)
                .unwrap(),
            "legacy-path"
        );
        for has_id in [true, false] {
            let error = resolved_repository_path(WorkspaceKind::Remote, root, root.into(), has_id)
                .unwrap_err();
            assert!(error.contains("local filesystem fallback was not attempted"));
        }
    }

    #[tokio::test]
    async fn legacy_payloads_and_invalid_params_are_handled_without_fake_success() {
        let dir = fixture();
        let path = dir.path().to_str().unwrap();
        let legacy = json!({"repository_path": path, "include_remote": false, "futureField": true});
        let wrapped = json!({"request": legacy});
        let old = read_at_path("git_get_branches", path, request_value(&legacy))
            .await
            .unwrap();
        let new = read_at_path("git_get_branches", path, request_value(&wrapped))
            .await
            .unwrap();
        assert_eq!(old, new);
        for payload in [json!({}), json!({"params": null})] {
            assert!(!read_at_path("git_get_commits", path, &payload)
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty());
            assert!(read_at_path("git_get_diff", path, &payload).await.is_err());
        }
        assert!(
            read_at_path("git_get_branches", path, &json!({"includeRemote": "yes"}))
                .await
                .is_err()
        );
        assert!(read_at_path(
            "git_get_commits",
            path,
            &json!({"params": {"max_count": "bad"}})
        )
        .await
        .is_err());
        assert!(read_at_path(
            "git_resolve_revision",
            path,
            &json!({"revision": "missing-fixture-ref"})
        )
        .await
        .is_err());
        assert!(read_at_path("git_push", path, &json!({})).await.is_err());
    }
}
