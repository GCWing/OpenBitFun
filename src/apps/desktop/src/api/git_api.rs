//! Git API

use crate::api::app_state::AppState;
use crate::startup_trace::DesktopStartupTrace;
use log::{error, info};
use openbitfun_core::infrastructure::storage::StorageOptions;
use openbitfun_core::service::git::{
    build_git_changed_files_args, build_git_diff_args, parse_name_status_output, GitAddParams,
    GitChangedFile, GitChangedFilesParams, GitCommitParams, GitDiffParams, GitFileStatus,
    GitLogParams, GitPullParams, GitPushParams, GitService,
};
use openbitfun_core::service::git::{
    trust, GitBranch, GitCommit, GitError, GitOperationResult, GitRepository, GitStatus,
    GitTrustOutcome, GitTrustReport, GitTrustState,
};
use openbitfun_core::service::remote_ssh::{
    build_remote_git_command as build_remote_git_command_shared, normalize_remote_workspace_path,
};
use openbitfun_core::service::workspace::WorktreeTopologyFreshness;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

/// Flattens a Git service failure into the desktop error string, keeping
/// ownership rejections machine-recognizable across the command boundary. The
/// wire form is produced by `trust`, shared with the app-server surface.
fn git_error_message(context: &str, error: &GitError) -> String {
    match error.untrusted_repository_path() {
        Some(repository_path) => trust::untrusted_repository_error_message(repository_path),
        None => format!("{context}: {error}"),
    }
}

/// Same classification for repositories reached over a remote connection, where
/// only the remote diagnostic text is available.
fn remote_git_error_message(fallback_path: &str, message: String) -> String {
    if trust::is_untrusted_repository_message(&message) {
        let repository_path = trust::untrusted_repository_path_from_message(&message)
            .unwrap_or_else(|| fallback_path.to_string());
        return trust::untrusted_repository_error_message(&repository_path);
    }
    message
}

#[derive(Debug, Clone)]
struct RemoteGitTarget {
    connection_id: String,
    repository_path: String,
}

#[derive(Debug)]
struct RemoteGitOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

/// Resolve the execution environment from the authoritative workspace object.
/// repository_path is only an IO location inside that workspace, never its key.
async fn resolve_remote_git_target(
    workspace_id: &str,
    repository_path: &str,
) -> Result<Option<RemoteGitTarget>, String> {
    let service = openbitfun_core::service::workspace::get_global_workspace_service()
        .ok_or("Workspace service is unavailable")?;
    let workspace = service
        .require_workspace(workspace_id)
        .await
        .map_err(|e| e.to_string())?;
    if workspace.workspace_kind != openbitfun_core::service::workspace::WorkspaceKind::Remote {
        return Ok(None);
    }
    let connection_id = workspace
        .remote_ssh_connection_id()
        .ok_or("Remote workspace has no saved SSH connection ID")?
        .to_string();
    Ok(Some(RemoteGitTarget {
        connection_id,
        repository_path: normalize_remote_workspace_path(repository_path),
    }))
}

/// Old HostInvoke payloads are decoded only at this temporary upgrade boundary.
async fn resolve_git_request(
    workspace_id: &mut Option<String>,
    repository_path: &mut String,
) -> Result<(), String> {
    let service = openbitfun_core::service::workspace::get_global_workspace_service()
        .ok_or("Workspace service is unavailable")?;
    let workspace = match workspace_id.as_deref() {
        Some(id) => service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?,
        None => service
            .resolve_legacy_workspace_reference(None, repository_path, None, None)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy Git workspace cannot be resolved; select a workspace by ID")?,
    };
    if workspace_id.is_some() || repository_path.is_empty() {
        *repository_path = workspace.root_path.to_string_lossy().into_owned();
    }
    *workspace_id = Some(workspace.id);
    Ok(())
}

fn build_remote_git_command(repository_path: &str, args: &[String]) -> String {
    build_remote_git_command_shared(repository_path, args)
}

async fn execute_remote_git_command(
    state: &AppState,
    target: &RemoteGitTarget,
    args: &[String],
) -> Result<RemoteGitOutput, String> {
    let manager = state
        .get_ssh_manager_async()
        .await
        .map_err(|e| e.to_string())?;
    let command = build_remote_git_command(&target.repository_path, args);
    let (stdout, stderr, exit_code) = manager
        .execute_command(&target.connection_id, &command)
        .await
        .map_err(|e| e.to_string())?;

    Ok(RemoteGitOutput {
        stdout,
        stderr,
        exit_code,
    })
}

async fn execute_remote_git_success(
    state: &AppState,
    target: &RemoteGitTarget,
    args: &[String],
) -> Result<String, String> {
    let output = execute_remote_git_command(state, target, args).await?;
    if output.exit_code == 0 {
        Ok(output.stdout)
    } else {
        let error = if output.stderr.trim().is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        Err(remote_git_error_message(
            &target.repository_path,
            error.trim().to_string(),
        ))
    }
}

async fn execute_remote_git_operation(
    state: &AppState,
    target: &RemoteGitTarget,
    args: &[String],
) -> Result<GitOperationResult, String> {
    let output = execute_remote_git_command(state, target, args).await?;
    let success = output.exit_code == 0;
    let error = remote_operation_error(&target.repository_path, &output);

    Ok(GitOperationResult {
        success,
        data: Some(serde_json::json!({
            "remoteExecution": true,
            "exitCode": output.exit_code,
        })),
        error,
        output: Some(output.stdout),
        duration: None,
    })
}

/// The failure a remote mutation reports, `None` when it succeeded.
///
/// A mutation refused on ownership grounds hits the same wall a read hits, and
/// has to reach the frontend the same way — through the stable code the trust
/// recovery flow branches on. Reporting the raw remote diagnostic instead put
/// `fatal: detected dubious ownership` in front of the user with nothing to do
/// about it, while the same rejection on a read offered the way out.
fn remote_operation_error(fallback_path: &str, output: &RemoteGitOutput) -> Option<String> {
    if output.exit_code == 0 {
        return None;
    }

    Some(remote_git_error_message(
        fallback_path,
        remote_git_diagnostic(output),
    ))
}

fn parse_remote_status_line(
    line: &str,
) -> Option<(String, String, Option<String>, Option<String>)> {
    if line.len() < 4 {
        return None;
    }

    let index = line.chars().next()?;
    let worktree = line.chars().nth(1)?;
    let path = line.get(3..)?.to_string();
    if path.is_empty() {
        return None;
    }

    let index_status = (index != ' ' && index != '?').then(|| index.to_string());
    let workdir_status = (worktree != ' ' && worktree != '?').then(|| worktree.to_string());
    let status = if index == '?' && worktree == '?' {
        "?".to_string()
    } else {
        [index, worktree]
            .into_iter()
            .filter(|c| *c != ' ')
            .collect::<String>()
    };

    Some((path, status, index_status, workdir_status))
}

fn parse_remote_git_status(output: &str) -> GitStatus {
    let mut current_branch = "HEAD".to_string();
    let mut ahead = 0;
    let mut behind = 0;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicts = Vec::new();

    let records = if output.contains('\0') {
        output.split('\0').collect::<Vec<_>>()
    } else {
        output.lines().collect::<Vec<_>>()
    };
    let mut record_index = 0usize;
    while record_index < records.len() {
        let line = records[record_index];
        record_index += 1;
        if line.is_empty() {
            continue;
        }
        if let Some(branch) = line.strip_prefix("## ") {
            let mut branch_part = branch.split("...").next().unwrap_or(branch).trim();
            if let Some((name, _)) = branch_part.split_once(' ') {
                branch_part = name;
            }
            if !branch_part.is_empty() {
                current_branch = branch_part.to_string();
            }

            if let Some(meta_start) = branch.find('[') {
                if let Some(meta_end) = branch[meta_start + 1..].find(']') {
                    let meta = &branch[meta_start + 1..meta_start + 1 + meta_end];
                    for part in meta.split(',').map(str::trim) {
                        if let Some(value) = part.strip_prefix("ahead ") {
                            ahead = value.parse().unwrap_or(0);
                        } else if let Some(value) = part.strip_prefix("behind ") {
                            behind = value.parse().unwrap_or(0);
                        }
                    }
                }
            }
            continue;
        }

        let Some((path, status, index_status, workdir_status)) = parse_remote_status_line(line)
        else {
            continue;
        };

        if status == "?" {
            untracked.push(path);
            continue;
        }

        let is_rename_or_copy = status.contains('R') || status.contains('C');
        if is_rename_or_copy && output.contains('\0') && record_index < records.len() {
            record_index += 1;
        }
        let is_conflict = matches!(
            (status.chars().next(), status.chars().nth(1)),
            (Some('D'), Some('D'))
                | (Some('A'), Some('U'))
                | (Some('U'), Some('D'))
                | (Some('U'), Some('A'))
                | (Some('D'), Some('U'))
                | (Some('A'), Some('A'))
                | (Some('U'), Some('U'))
        );
        if is_conflict {
            conflicts.push(path.clone());
        }

        let file = GitFileStatus {
            path,
            status,
            index_status,
            workdir_status,
        };

        if file.index_status.is_some() {
            staged.push(file.clone());
        }
        if file.workdir_status.is_some() {
            unstaged.push(file);
        }
    }

    GitStatus {
        staged,
        unstaged,
        untracked,
        conflicts,
        current_branch,
        ahead,
        behind,
    }
}

fn parse_remote_branches(output: &str) -> Vec<GitBranch> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\t');
            let current = fields.next()? == "*";
            let full_ref = fields.next()?;
            let name = fields.next()?.to_string();
            let upstream = fields
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let last_commit = fields
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let last_commit_date = fields
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let remote = full_ref.starts_with("refs/remotes/");

            Some(GitBranch {
                name,
                current,
                remote,
                upstream,
                ahead: 0,
                behind: 0,
                last_commit,
                last_commit_date: last_commit_date.clone(),
                base_branch: None,
                child_branches: None,
                merged_branches: None,
                branch_type: None,
                has_conflicts: None,
                can_merge: None,
                is_stale: None,
                merge_status: None,
                stats: None,
                created_at: None,
                last_activity_at: last_commit_date,
                tags: None,
                description: None,
                linked_issues: None,
            })
        })
        .collect()
}

fn parse_remote_commits(output: &str) -> Vec<GitCommit> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\t');
            let hash = fields.next()?.to_string();
            let short_hash = fields.next()?.to_string();
            let author = fields.next()?.to_string();
            let author_email = fields.next()?.to_string();
            let date = fields.next()?.to_string();
            let message = fields.next().unwrap_or_default().to_string();
            Some(GitCommit {
                hash,
                short_hash,
                message,
                author,
                author_email,
                date,
                parents: Vec::new(),
                additions: None,
                deletions: None,
                files_changed: None,
            })
        })
        .collect()
}

fn git_log_args(params: &GitLogParams) -> Vec<String> {
    let mut args = vec![
        "log".to_string(),
        format!("--max-count={}", params.max_count.unwrap_or(50)),
        "--format=%H%x09%h%x09%an%x09%ae%x09%ci%x09%s".to_string(),
    ];
    if let Some(skip) = params.skip {
        args.push(format!("--skip={skip}"));
    }
    if let Some(author) = params.author.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push(format!("--author={author}"));
    }
    if let Some(grep) = params.grep.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push(format!("--grep={grep}"));
    }
    if let Some(since) = params.since.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push(format!("--since={since}"));
    }
    if let Some(until) = params.until.as_deref().filter(|s| !s.trim().is_empty()) {
        args.push(format!("--until={until}"));
    }
    args
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResolveRevisionRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub include_remote: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: Option<GitLogParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAddFilesRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: GitAddParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: GitCommitParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: GitPushParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: GitPullParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutBranchRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub branch_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateBranchRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub branch_name: String,
    pub start_point: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteBranchRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub branch_name: String,
    pub force: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: GitDiffParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFilesRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub params: GitChangedFilesParams,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResetFilesRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub files: Vec<String>,
    pub staged: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResetToCommitRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub commit_hash: String,
    pub mode: String, // "soft", "mixed", or "hard"
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGetFileContentRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub file_path: String,
    pub commit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCherryPickRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub commit_hash: String,
    pub no_commit: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAddWorktreeRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub branch: String,
    pub create_branch: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoveWorktreeRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub repository_path: String,
    pub worktree_path: String,
    pub force: Option<bool>,
}

/// Read-only ownership-trust probe for a repository.
///
/// Git refuses to operate on a repository owned by another user until the path
/// is listed in the protected `safe.directory` configuration. Surfaces call
/// this to tell that state apart from "not a repository" before offering the
/// trust decision.
#[tauri::command]
pub async fn git_get_repository_trust(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<GitTrustReport, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return inspect_remote_repository_trust(&state, &target).await;
    }

    GitService::inspect_trust(&request.repository_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to inspect Git repository trust: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to inspect Git repository trust", &e)
        })
}

/// Grants ownership trust for a repository after the user confirmed it.
///
/// Writes the `safe.directory` exception Git asks for, then re-probes the
/// repository. A decision that could not be applied here (remote workspace,
/// read-only configuration) is reported with `state != trusted` and the manual
/// command, never silently swallowed.
#[tauri::command]
pub async fn git_trust_repository(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<GitTrustOutcome, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let report = inspect_remote_repository_trust(&state, &target).await?;
        info!(
            "Git repository trust must be granted on the remote host: path={}",
            target.repository_path
        );
        return Ok(GitTrustOutcome {
            already_trusted: report.state == GitTrustState::Trusted,
            state: report.state,
            repository_path: report.repository_path,
            added_entries: Vec::new(),
            detail: report.detail,
            manual_command: report.manual_command,
        });
    }

    let outcome = GitService::trust_repository(&request.repository_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to trust Git repository: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to trust Git repository", &e)
        })?;
    info!(
        "Git repository trust decision applied: path={}, state={:?}, added={}",
        request.repository_path,
        outcome.state,
        outcome.added_entries.len()
    );
    Ok(outcome)
}

async fn inspect_remote_repository_trust(
    state: &AppState,
    target: &RemoteGitTarget,
) -> Result<GitTrustReport, String> {
    let output = execute_remote_git_command(
        state,
        target,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    )
    .await?;

    if output.exit_code == 0 {
        // A successful `--show-toplevel` always names the worktree. Empty
        // output means the transport, not Git, produced this result; calling it
        // "trusted" would report a repository we never actually saw.
        // Normalized like every local path, so a remote report and a local one
        // are comparable and a `safe.directory` entry derived from either has
        // the same spelling.
        let Some(repository_path) = trust::normalize_trust_path(&output.stdout) else {
            return Err(
                "Failed to inspect Git repository trust on the remote host: git reported success without a repository path"
                    .to_string(),
            );
        };
        return Ok(GitTrustReport {
            state: GitTrustState::Trusted,
            repository_path: Some(repository_path),
            detail: None,
            manual_command: None,
        });
    }

    let diagnostic = remote_git_diagnostic(&output);
    if trust::is_untrusted_repository_message(&diagnostic) {
        let repository_path = trust::untrusted_repository_path_from_message(&diagnostic)
            .or_else(|| trust::normalize_trust_path(&target.repository_path))
            .unwrap_or_else(|| target.repository_path.clone());
        let manual_command = trust::manual_trust_command(&repository_path);
        return Ok(GitTrustReport {
            state: GitTrustState::TrustRequired,
            repository_path: Some(repository_path),
            detail: Some(diagnostic),
            manual_command: Some(manual_command),
        });
    }

    if trust::is_missing_repository_message(&diagnostic) {
        return Ok(GitTrustReport {
            state: GitTrustState::NotARepository,
            repository_path: trust::normalize_trust_path(&target.repository_path)
                .or_else(|| Some(target.repository_path.clone())),
            detail: Some(diagnostic),
            manual_command: None,
        });
    }

    // Anything else — a denied path, a broken `.git`, an SSH wrapper that died
    // — means the probe could not reach an answer. The local inspection returns
    // an error there, and so must this one: reporting "not a repository" would
    // send the user to initialize one over a repository that is already there.
    Err(format!(
        "Failed to inspect Git repository trust on the remote host: {}",
        if diagnostic.is_empty() {
            format!("git exited with code {}", output.exit_code)
        } else {
            diagnostic
        }
    ))
}

/// The remote diagnostic to classify: stderr when Git wrote one, stdout
/// otherwise (some SSH wrappers merge the streams).
fn remote_git_diagnostic(output: &RemoteGitOutput) -> String {
    if output.stderr.trim().is_empty() {
        output.stdout.trim().to_string()
    } else {
        output.stderr.trim().to_string()
    }
}

/// Whether a remote `rev-parse --is-inside-work-tree` found a repository.
///
/// Mirrors the local [`openbitfun_core::service::git::utils::is_git_repository`]:
/// a repository Git refuses on ownership grounds still *is* one, and answering
/// `false` there hides the recovery affordance behind "not a repository".
fn remote_probe_found_repository(output: &RemoteGitOutput) -> bool {
    if output.exit_code == 0 {
        return output.stdout.trim() == "true";
    }
    trust::is_untrusted_repository_message(&remote_git_diagnostic(output))
}

#[tauri::command]
pub async fn git_is_repository(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
    mut request: GitRepositoryRequest,
) -> Result<bool, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let trace_started = Instant::now();
    let result = if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        execute_remote_git_command(
            &state,
            &target,
            &["rev-parse".to_string(), "--is-inside-work-tree".to_string()],
        )
        .await
        .map(|output| remote_probe_found_repository(&output))
    } else {
        GitService::is_repository(&request.repository_path)
            .await
            .map_err(|e| {
                error!(
                    "Failed to check Git repository: path={}, error={}",
                    request.repository_path, e
                );
                git_error_message("Failed to check Git repository", &e)
            })
    };

    startup_trace.record_tauri_command_elapsed("git_is_repository", None, trace_started);
    result
}

#[tauri::command]
pub async fn git_get_repository(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<GitRepository, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let current_branch = execute_remote_git_success(
            &state,
            &target,
            &["branch".to_string(), "--show-current".to_string()],
        )
        .await
        .map(|s| {
            let branch = s.trim();
            if branch.is_empty() {
                "HEAD".to_string()
            } else {
                branch.to_string()
            }
        })?;
        let remotes_output =
            execute_remote_git_success(&state, &target, &["remote".to_string()]).await?;
        let status = execute_remote_git_success(
            &state,
            &target,
            &["status".to_string(), "--porcelain".to_string()],
        )
        .await?;

        let name = target
            .repository_path
            .rsplit('/')
            .find(|part| !part.is_empty())
            .unwrap_or("/")
            .to_string();

        return Ok(GitRepository {
            path: target.repository_path,
            name,
            current_branch,
            is_bare: false,
            has_changes: !status.trim().is_empty(),
            remotes: remotes_output
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
        });
    }

    GitService::get_repository(&request.repository_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to get Git repository info: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to get Git repository info", &e)
        })
}

#[tauri::command]
pub async fn git_get_repository_basic(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
    mut request: GitRepositoryRequest,
) -> Result<GitRepository, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let trace_started = Instant::now();
    let result = async {
        if let Some(target) = resolve_remote_git_target(
            request.workspace_id.as_deref().expect("resolved workspace"),
            &request.repository_path,
        )
        .await?
        {
            let current_branch = execute_remote_git_success(
                &state,
                &target,
                &["branch".to_string(), "--show-current".to_string()],
            )
            .await
            .map(|s| {
                let branch = s.trim();
                if branch.is_empty() {
                    "HEAD".to_string()
                } else {
                    branch.to_string()
                }
            })?;

            let name = target
                .repository_path
                .rsplit('/')
                .find(|part| !part.is_empty())
                .unwrap_or("/")
                .to_string();

            Ok(GitRepository {
                path: target.repository_path,
                name,
                current_branch,
                is_bare: false,
                has_changes: false,
                remotes: Vec::new(),
            })
        } else {
            GitService::get_repository_basic(&request.repository_path)
                .await
                .map_err(|e| {
                    error!(
                        "Failed to get basic Git repository info: path={}, error={}",
                        request.repository_path, e
                    );
                    git_error_message("Failed to get basic Git repository info", &e)
                })
        }
    }
    .await;

    startup_trace.record_tauri_command_elapsed("git_get_repository_basic", None, trace_started);
    result
}

#[tauri::command]
pub async fn git_resolve_revision(
    state: State<'_, AppState>,
    mut request: GitResolveRevisionRequest,
) -> Result<String, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let revision = request.revision.trim();
    if revision.is_empty() {
        return Err("Revision cannot be empty".to_string());
    }

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return execute_remote_git_success(
            &state,
            &target,
            &[
                "rev-parse".to_string(),
                "--verify".to_string(),
                format!("{}^{{commit}}", revision),
            ],
        )
        .await
        .map(|output| output.trim().to_string());
    }

    GitService::resolve_revision(&request.repository_path, revision)
        .await
        .map_err(|e| git_error_message("Failed to resolve Git revision", &e))
}

#[tauri::command]
pub async fn git_get_status(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<GitStatus, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let output = execute_remote_git_success(
            &state,
            &target,
            &[
                "status".to_string(),
                "--porcelain=v1".to_string(),
                "--branch".to_string(),
                "-z".to_string(),
            ],
        )
        .await?;
        return Ok(parse_remote_git_status(&output));
    }

    GitService::get_status(&request.repository_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to get Git status: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to get Git status", &e)
        })
}

#[tauri::command]
pub async fn git_get_branches(
    state: State<'_, AppState>,
    mut request: GitBranchesRequest,
) -> Result<Vec<GitBranch>, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let include_remote = request.include_remote.unwrap_or(false);
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec![
            "for-each-ref".to_string(),
            "--format=%(if)%(HEAD)%(then)*%(else) %(end)%09%(refname)%09%(refname:short)%09%(upstream:short)%09%(objectname)%09%(committerdate:iso-strict)".to_string(),
            "refs/heads".to_string(),
        ];
        if include_remote {
            args.push("refs/remotes".to_string());
        }
        let output = execute_remote_git_success(&state, &target, &args).await?;
        return Ok(parse_remote_branches(&output));
    }

    GitService::get_branches(&request.repository_path, include_remote)
        .await
        .map_err(|e| {
            error!(
                "Failed to get Git branches: path={}, include_remote={}, error={}",
                request.repository_path, include_remote, e
            );
            git_error_message("Failed to get Git branches", &e)
        })
}

#[tauri::command]
pub async fn git_get_enhanced_branches(
    state: State<'_, AppState>,
    mut request: GitBranchesRequest,
) -> Result<Vec<GitBranch>, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let include_remote = request.include_remote.unwrap_or(false);
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec![
            "for-each-ref".to_string(),
            "--format=%(if)%(HEAD)%(then)*%(else) %(end)%09%(refname)%09%(refname:short)%09%(upstream:short)%09%(objectname)%09%(committerdate:iso-strict)".to_string(),
            "refs/heads".to_string(),
        ];
        if include_remote {
            args.push("refs/remotes".to_string());
        }
        let output = execute_remote_git_success(&state, &target, &args).await?;
        return Ok(parse_remote_branches(&output));
    }

    GitService::get_enhanced_branches(&request.repository_path, include_remote)
        .await
        .map_err(|e| {
            error!(
                "Failed to get enhanced Git branches: path={}, include_remote={}, error={}",
                request.repository_path, include_remote, e
            );
            git_error_message("Failed to get enhanced Git branches", &e)
        })
}

#[tauri::command]
pub async fn git_get_commits(
    state: State<'_, AppState>,
    mut request: GitCommitsRequest,
) -> Result<Vec<GitCommit>, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let params = request.params.unwrap_or_default();
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let output = execute_remote_git_success(&state, &target, &git_log_args(&params)).await?;
        return Ok(parse_remote_commits(&output));
    }

    GitService::get_commits(&request.repository_path, params)
        .await
        .map_err(|e| {
            error!(
                "Failed to get Git commits: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to get Git commits", &e)
        })
}

#[tauri::command]
pub async fn git_add_files(
    state: State<'_, AppState>,
    mut request: GitAddFilesRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec!["add".to_string()];
        if request.params.all.unwrap_or(false) {
            args.push("-A".to_string());
        } else if request.params.update.unwrap_or(false) {
            args.push("-u".to_string());
        } else {
            args.extend(request.params.files);
        }
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::add_files(&request.repository_path, request.params)
        .await
        .map_err(|e| {
            error!(
                "Failed to add files: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to add files", &e)
        })
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    mut request: GitCommitRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec![
            "commit".to_string(),
            "-m".to_string(),
            request.params.message.clone(),
        ];
        if request.params.amend.unwrap_or(false) {
            args.push("--amend".to_string());
        }
        if request.params.all.unwrap_or(false) {
            args.push("-a".to_string());
        }
        if request.params.no_verify.unwrap_or(false) {
            args.push("--no-verify".to_string());
        }
        if let Some(author) = request.params.author {
            args.push("--author".to_string());
            args.push(format!("{} <{}>", author.name, author.email));
        }
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::commit(&request.repository_path, request.params)
        .await
        .map_err(|e| {
            error!(
                "Failed to commit: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to commit", &e)
        })
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    mut request: GitPushRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec!["push".to_string()];
        if request.params.force.unwrap_or(false) {
            args.push("--force".to_string());
        }
        if request.params.set_upstream.unwrap_or(false) {
            args.push("-u".to_string());
        }
        if let Some(remote) = request.params.remote {
            args.push(remote);
        }
        if let Some(branch) = request.params.branch {
            args.push(branch);
        }
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::push(&request.repository_path, request.params)
        .await
        .map_err(|e| {
            error!(
                "Failed to push: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to push", &e)
        })
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    mut request: GitPullRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec!["pull".to_string()];
        if request.params.rebase.unwrap_or(false) {
            args.push("--rebase".to_string());
        }
        if let Some(remote) = request.params.remote {
            args.push(remote);
        }
        if let Some(branch) = request.params.branch {
            args.push(branch);
        }
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::pull(&request.repository_path, request.params)
        .await
        .map_err(|e| {
            error!(
                "Failed to pull: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to pull", &e)
        })
}

#[tauri::command]
pub async fn git_checkout_branch(
    state: State<'_, AppState>,
    mut request: GitCheckoutBranchRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return execute_remote_git_operation(
            &state,
            &target,
            &["checkout".to_string(), request.branch_name],
        )
        .await;
    }

    GitService::checkout_branch(&request.repository_path, &request.branch_name)
        .await
        .map_err(|e| {
            error!(
                "Failed to checkout branch: path={}, branch={}, error={}",
                request.repository_path, request.branch_name, e
            );
            git_error_message("Failed to checkout branch", &e)
        })
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    mut request: GitCreateBranchRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec![
            "checkout".to_string(),
            "-b".to_string(),
            request.branch_name,
        ];
        if let Some(start_point) = request.start_point.filter(|s| !s.trim().is_empty()) {
            args.push(start_point);
        }
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::create_branch(
        &request.repository_path,
        &request.branch_name,
        request.start_point.as_deref(),
    )
    .await
    .map_err(|e| {
        error!(
            "Failed to create branch: path={}, branch={}, error={}",
            request.repository_path, request.branch_name, e
        );
        git_error_message("Failed to create branch", &e)
    })
}

#[tauri::command]
pub async fn git_delete_branch(
    state: State<'_, AppState>,
    mut request: GitDeleteBranchRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let force = request.force.unwrap_or(false);
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return execute_remote_git_operation(
            &state,
            &target,
            &[
                "branch".to_string(),
                if force { "-D" } else { "-d" }.to_string(),
                request.branch_name,
            ],
        )
        .await;
    }

    GitService::delete_branch(&request.repository_path, &request.branch_name, force)
        .await
        .map_err(|e| {
            error!(
                "Failed to delete branch: path={}, branch={}, force={}, error={}",
                request.repository_path, request.branch_name, force, e
            );
            git_error_message("Failed to delete branch", &e)
        })
}

#[tauri::command]
pub async fn git_get_diff(
    state: State<'_, AppState>,
    mut request: GitDiffRequest,
) -> Result<String, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return execute_remote_git_success(&state, &target, &build_git_diff_args(&request.params))
            .await;
    }

    GitService::get_diff(&request.repository_path, &request.params)
        .await
        .map_err(|e| {
            error!(
                "Failed to get Git diff: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to get Git diff", &e)
        })
}

#[tauri::command]
pub async fn git_get_changed_files(
    state: State<'_, AppState>,
    mut request: GitChangedFilesRequest,
) -> Result<Vec<GitChangedFile>, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    info!(
        "Getting changed Git files for repository: {}",
        request.repository_path
    );

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let output = execute_remote_git_success(
            &state,
            &target,
            &build_git_changed_files_args(&request.params),
        )
        .await?;
        return Ok(parse_name_status_output(&output));
    }

    GitService::get_changed_files(&request.repository_path, &request.params)
        .await
        .map_err(|e| {
            error!("Failed to get changed Git files: {}", e);
            git_error_message("Failed to get changed Git files", &e)
        })
}

#[tauri::command]
pub async fn git_reset_files(
    state: State<'_, AppState>,
    mut request: GitResetFilesRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let staged = request.staged.unwrap_or(false);

    info!(
        "Resetting files in '{}' (staged: {}): {:?}",
        request.repository_path, staged, request.files
    );

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec!["restore".to_string()];
        if staged {
            args.push("--staged".to_string());
        }
        args.extend(request.files);
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::reset_files(&request.repository_path, &request.files, staged)
        .await
        .map(|output| GitOperationResult {
            success: true,
            data: None,
            error: None,
            output: Some(output),
            duration: None,
        })
        .map_err(|e| git_error_message("Failed to reset files", &e))
}

#[tauri::command]
pub async fn git_get_file_content(
    state: State<'_, AppState>,
    mut request: GitGetFileContentRequest,
) -> Result<String, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    info!(
        "Getting file content for '{}' at commit '{:?}' in repo '{}'",
        request.file_path, request.commit, request.repository_path
    );

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let object_spec = format!(
            "{}:{}",
            request.commit.as_deref().unwrap_or("HEAD"),
            request.file_path
        );
        return execute_remote_git_success(&state, &target, &["show".to_string(), object_spec])
            .await;
    }

    let content = GitService::get_file_content(
        &request.repository_path,
        &request.file_path,
        request.commit.as_deref(),
    )
    .await
    .map_err(|e| git_error_message("Failed to get file content", &e))?;

    Ok(content)
}

#[tauri::command]
pub async fn git_reset_to_commit(
    state: State<'_, AppState>,
    mut request: GitResetToCommitRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    info!(
        "Resetting to commit '{}' with mode '{}' in repo '{}'",
        request.commit_hash, request.mode, request.repository_path
    );

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mode_flag = match request.mode.as_str() {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            _ => return Err(format!("Invalid reset mode: {}", request.mode)),
        };
        return execute_remote_git_operation(
            &state,
            &target,
            &[
                "reset".to_string(),
                mode_flag.to_string(),
                request.commit_hash,
            ],
        )
        .await;
    }

    GitService::reset_to_commit(
        &request.repository_path,
        &request.commit_hash,
        &request.mode,
    )
    .await
    .map_err(|e| {
        error!(
            "Failed to reset to commit: path={}, commit={}, mode={}, error={}",
            request.repository_path, request.commit_hash, request.mode, e
        );
        git_error_message("Failed to reset", &e)
    })
}

#[tauri::command]
pub async fn git_get_graph(
    _state: State<'_, AppState>,
    repository_path: Option<String>,
    mut workspace_id: Option<String>,
    max_count: Option<usize>,
    branch_name: Option<String>,
) -> Result<openbitfun_core::service::git::GitGraph, String> {
    let mut repository_path = repository_path.unwrap_or_default();
    info!(
        "Getting git graph: repository_path={}, max_count={:?}, branch_name={:?}",
        repository_path, max_count, branch_name
    );

    resolve_git_request(&mut workspace_id, &mut repository_path).await?;
    if resolve_remote_git_target(
        workspace_id.as_deref().expect("resolved workspace"),
        &repository_path,
    )
    .await?
    .is_some()
    {
        return Err("Git graph is not supported for remote SSH workspaces yet".to_string());
    }

    GitService::get_git_graph_for_branch(&repository_path, max_count, branch_name)
        .await
        .map_err(|e| git_error_message("Failed to get Git graph", &e))
}

#[tauri::command]
pub async fn git_cherry_pick(
    state: State<'_, AppState>,
    mut request: GitCherryPickRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let no_commit = request.no_commit.unwrap_or(false);

    info!(
        "Cherry-picking commit '{}' in repo '{}' (no_commit: {})",
        request.commit_hash, request.repository_path, no_commit
    );

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        let mut args = vec!["cherry-pick".to_string()];
        if no_commit {
            args.push("-n".to_string());
        }
        args.push(request.commit_hash);
        return execute_remote_git_operation(&state, &target, &args).await;
    }

    GitService::cherry_pick(&request.repository_path, &request.commit_hash, no_commit)
        .await
        .map_err(|e| {
            error!(
                "Failed to cherry-pick: path={}, commit={}, no_commit={}, error={}",
                request.repository_path, request.commit_hash, no_commit, e
            );
            git_error_message("Failed to cherry-pick", &e)
        })
}

#[tauri::command]
pub async fn git_cherry_pick_abort(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    info!("Aborting cherry-pick in repo '{}'", request.repository_path);

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return execute_remote_git_operation(
            &state,
            &target,
            &["cherry-pick".to_string(), "--abort".to_string()],
        )
        .await;
    }

    GitService::cherry_pick_abort(&request.repository_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to abort cherry-pick: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to abort cherry-pick", &e)
        })
}

#[tauri::command]
pub async fn git_cherry_pick_continue(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    info!(
        "Continuing cherry-pick in repo '{}'",
        request.repository_path
    );

    if let Some(target) = resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    {
        return execute_remote_git_operation(
            &state,
            &target,
            &["cherry-pick".to_string(), "--continue".to_string()],
        )
        .await;
    }

    GitService::cherry_pick_continue(&request.repository_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to continue cherry-pick: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to continue cherry-pick", &e)
        })
}

#[tauri::command]
pub async fn git_list_worktrees(
    state: State<'_, AppState>,
    mut request: GitRepositoryRequest,
) -> Result<Vec<openbitfun_core::service::git::GitWorktreeInfo>, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    info!("Listing worktrees for '{}'", request.repository_path);

    if resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    .is_some()
    {
        return Err("Git worktrees are not supported for remote SSH workspaces yet".to_string());
    }

    state
        .workspace_service
        .list_worktrees(
            std::path::Path::new(&request.repository_path),
            WorktreeTopologyFreshness::ForceRefresh,
        )
        .await
        .map_err(|e| {
            error!(
                "Failed to list worktrees: path={}, error={}",
                request.repository_path, e
            );
            git_error_message("Failed to list worktrees", &e)
        })
}

#[tauri::command]
pub async fn git_add_worktree(
    state: State<'_, AppState>,
    mut request: GitAddWorktreeRequest,
) -> Result<openbitfun_core::service::git::GitWorktreeInfo, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let create_branch = request.create_branch.unwrap_or(false);
    info!(
        "Adding worktree for branch '{}' in '{}' (create_branch: {})",
        request.branch, request.repository_path, create_branch
    );

    if resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    .is_some()
    {
        return Err("Git worktrees are not supported for remote SSH workspaces yet".to_string());
    }

    let worktree =
        GitService::add_worktree(&request.repository_path, &request.branch, create_branch)
            .await
            .map_err(|e| {
                error!(
                    "Failed to add worktree: path={}, branch={}, create_branch={}, error={}",
                    request.repository_path, request.branch, create_branch, e
                );
                git_error_message("Failed to add worktree", &e)
            })?;
    state
        .workspace_service
        .invalidate_worktree_topology(std::path::Path::new(&request.repository_path))
        .await;
    Ok(worktree)
}

#[tauri::command]
pub async fn git_remove_worktree(
    state: State<'_, AppState>,
    mut request: GitRemoveWorktreeRequest,
) -> Result<GitOperationResult, String> {
    resolve_git_request(&mut request.workspace_id, &mut request.repository_path).await?;
    let force = request.force.unwrap_or(false);
    info!(
        "Removing worktree '{}' from '{}' (force: {})",
        request.worktree_path, request.repository_path, force
    );

    if resolve_remote_git_target(
        request.workspace_id.as_deref().expect("resolved workspace"),
        &request.repository_path,
    )
    .await?
    .is_some()
    {
        return Err("Git worktrees are not supported for remote SSH workspaces yet".to_string());
    }

    let result =
        GitService::remove_worktree(&request.repository_path, &request.worktree_path, force)
            .await
            .map_err(|e| {
                error!(
                    "Failed to remove worktree: path={}, worktree_path={}, force={}, error={}",
                    request.repository_path, request.worktree_path, force, e
                );
                git_error_message("Failed to remove worktree", &e)
            })?;
    state
        .workspace_service
        .invalidate_worktree_topology(std::path::Path::new(&request.repository_path))
        .await;
    Ok(result)
}

// MARK: Git Repo History

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoHistory {
    pub url: String,
    pub last_used: String,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRepoHistoryData {
    pub repos: Vec<GitRepoHistory>,
    pub saved_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveGitRepoHistoryRequest {
    pub repos: Vec<GitRepoHistory>,
}

#[tauri::command]
pub async fn save_git_repo_history(
    state: State<'_, AppState>,
    request: SaveGitRepoHistoryRequest,
) -> Result<(), String> {
    let workspace_service = &state.workspace_service;
    let persistence = workspace_service.persistence();

    let data = GitRepoHistoryData {
        repos: request.repos,
        saved_at: chrono::Utc::now().to_rfc3339(),
    };

    persistence
        .save_json("git_repo_history", &data, StorageOptions::default())
        .await
        .map_err(|e| {
            error!("Failed to save git repo history: {}", e);
            format!("Failed to save git repo history: {}", e)
        })
}

#[tauri::command]
pub async fn load_git_repo_history(
    state: State<'_, AppState>,
) -> Result<Vec<GitRepoHistory>, String> {
    let workspace_service = &state.workspace_service;
    let persistence = workspace_service.persistence();

    let data: Option<GitRepoHistoryData> = persistence
        .load_json("git_repo_history")
        .await
        .map_err(|e| {
            error!("Failed to load git repo history: {}", e);
            format!("Failed to load git repo history: {}", e)
        })?;

    match data {
        Some(data) => Ok(data.repos),
        None => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_output(stdout: &str, stderr: &str, exit_code: i32) -> RemoteGitOutput {
        RemoteGitOutput {
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
        }
    }

    #[test]
    fn a_remote_repository_git_refuses_on_ownership_is_still_a_repository() {
        // Answering `false` here is what sent shared SSH hosts and containers
        // running under a different uid to the "initialize a repository" page.
        let output = remote_output(
            "",
            "fatal: detected dubious ownership in repository at '/srv/shared/repo'",
            128,
        );

        assert!(remote_probe_found_repository(&output));
    }

    #[test]
    fn a_remote_path_without_a_repository_is_reported_as_none() {
        let output = remote_output(
            "",
            "fatal: not a git repository (or any parent up to /)",
            128,
        );

        assert!(!remote_probe_found_repository(&output));
    }

    #[test]
    fn a_remote_worktree_answers_the_probe() {
        assert!(remote_probe_found_repository(&remote_output(
            "true\n", "", 0
        )));
        assert!(!remote_probe_found_repository(&remote_output(
            "false\n", "", 0
        )));
    }

    #[test]
    fn a_merged_stream_still_carries_the_ownership_rejection() {
        // Some SSH wrappers fold stderr into stdout; the diagnostic must be
        // read from whichever stream carried it.
        let output = remote_output(
            "fatal: detected dubious ownership in repository at '/srv/shared/repo'",
            "",
            128,
        );

        assert!(remote_probe_found_repository(&output));
    }

    #[test]
    fn a_remote_mutation_refused_on_ownership_carries_the_stable_code() {
        // Commit, push, checkout and the rest went through a path that reported
        // the raw diagnostic, so the frontend could not tell this failure from
        // any other and the user saw Git's prose with no way out — while the
        // same rejection on a read offered one.
        let output = remote_output(
            "",
            "fatal: detected dubious ownership in repository at '/srv/shared/repo'",
            128,
        );

        assert_eq!(
            remote_operation_error("/srv/shared/other", &output).as_deref(),
            Some("git_repository_untrusted: /srv/shared/repo")
        );
    }

    #[test]
    fn an_ordinary_remote_mutation_failure_is_reported_as_is() {
        let output = remote_output("", "error: failed to push some refs", 1);

        assert_eq!(
            remote_operation_error("/srv/shared/repo", &output).as_deref(),
            Some("error: failed to push some refs")
        );
        assert_eq!(
            remote_operation_error("/srv/shared/repo", &remote_output("ok\n", "", 0)),
            None
        );
    }
}
