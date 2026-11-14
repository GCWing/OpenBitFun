use super::*;
/**
 * Git service implementation
 */
use git2::{BranchType, Commit, ErrorCode, Repository, StatusOptions};
use std::io::Write;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;
use tokio::task;
use tokio::time::timeout;

pub struct GitService;

type CommitStats = (Option<i32>, Option<i32>, Option<i32>);

fn elapsed_ms_u64(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis() as u64
}

fn review_path_has_parent_traversal(path: &str, windows: bool) -> bool {
    if windows {
        path.replace('\\', "/")
            .split('/')
            .any(|segment| segment == "..")
    } else {
        path.split('/').any(|segment| segment == "..")
    }
}

/// `git rev-parse` on a date string is a pure local parse, so anything slower
/// than this is a stuck process, not a slow one.
const APPROXIDATE_TIMEOUT: Duration = Duration::from_secs(5);

/// Resolve a `since`/`until` value through Git's own approxidate parser.
///
/// Note the semantics this inherits: approxidate never rejects input. A typo
/// like `--since=lst week` parses as "now", producing a filter that matches
/// almost nothing and an empty, successful result. That is Git's documented
/// behaviour and callers are matched to it deliberately, so unparseable input is
/// logged rather than turned into an error — but it is why an empty commit list
/// is worth double-checking against the filter that produced it.
fn resolve_git_approxidate(repo_path: &Path, option: &str, value: &str) -> Result<i64, GitError> {
    let argument = format!("{option}={value}");
    let output = execute_git_command_sync_with_timeout(
        repo_path.to_string_lossy().as_ref(),
        &["rev-parse", argument.as_str()],
        APPROXIDATE_TIMEOUT,
    )
    .map_err(|error| {
        GitError::CommandFailed(format!(
            "Failed to parse Git date filter '{argument}': {error}"
        ))
    })?;
    let timestamp = output
        .trim()
        .split_once('=')
        .map(|(_, timestamp)| timestamp)
        .ok_or_else(|| {
            GitError::CommandFailed(format!(
                "Git returned an invalid date filter for '{argument}': {}",
                output.trim()
            ))
        })?;
    let timestamp = timestamp.parse::<i64>().map_err(|error| {
        GitError::CommandFailed(format!(
            "Git returned an invalid timestamp for '{argument}': {error}"
        ))
    })?;

    // Approxidate falls back to "now" for anything it cannot read, so a value
    // that lands on the current second is the one signal that the input was
    // probably a typo. Not an error — "now" and "today" are legitimate — but
    // worth a line when the query then comes back empty.
    let now = chrono::Utc::now().timestamp();
    if (now - timestamp).abs() <= 1
        && !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "now" | "today" | ""
        )
    {
        log::warn!(
            "Git date filter '{argument}' resolved to the current time; \
             approxidate could not parse it and the result will be nearly empty"
        );
    }

    Ok(timestamp)
}

impl GitService {
    /// Checks whether the path is a Git repository.
    pub async fn is_repository<P: AsRef<Path>>(path: P) -> Result<bool, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || Ok(is_git_repository(path_buf)))
            .await
            .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Reports whether Git accepts the repository's ownership for the current
    /// user. Read-only: nothing is configured.
    pub async fn inspect_trust<P: AsRef<Path>>(path: P) -> Result<GitTrustReport, GitError> {
        trust::inspect_repository_trust(&path.as_ref().to_string_lossy()).await
    }

    /// Grants ownership trust for the repository after the caller obtained an
    /// explicit user confirmation. See [`trust::trust_repository`].
    pub async fn trust_repository<P: AsRef<Path>>(path: P) -> Result<GitTrustOutcome, GitError> {
        trust::trust_repository(&path.as_ref().to_string_lossy()).await
    }

    /// Resolves the stable repository identity shared by all worktrees without
    /// spawning the Git CLI.
    pub async fn resolve_worktree_repository<P: AsRef<Path>>(
        path: P,
    ) -> Result<GitWorktreeRepositoryInfo, GitError> {
        let requested_path = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repository = discover_repository(&requested_path)?;
            let query_path = repository
                .workdir()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| requested_path.clone());
            let git_dir = repository.path().to_path_buf();
            let common_git_dir = git_dir
                .parent()
                .filter(|parent| {
                    parent
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(|name| name.eq_ignore_ascii_case("worktrees"))
                        .unwrap_or(false)
                })
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or(git_dir);

            Ok(GitWorktreeRepositoryInfo {
                worktree_git_marker: query_path.join(".git"),
                query_path: std::fs::canonicalize(&query_path).unwrap_or(query_path),
                common_git_dir: std::fs::canonicalize(&common_git_dir).unwrap_or(common_git_dir),
            })
        })
        .await
        .map_err(|error| GitError::CommandFailed(format!("spawn_blocking join: {error}")))?
    }

    /// Resolves a revision to an immutable commit id without changing repository state.
    pub async fn resolve_revision<P: AsRef<Path>>(
        path: P,
        revision: &str,
    ) -> Result<String, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        let revision = revision.trim().to_string();
        if revision.is_empty() {
            return Err(GitError::CommandFailed(
                "Revision cannot be empty".to_string(),
            ));
        }

        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;
            let object = repo
                .revparse_single(&revision)
                .map_err(|e| GitError::CommandFailed(format!("Failed to resolve revision: {e}")))?;
            let commit = object
                .peel_to_commit()
                .map_err(|e| GitError::CommandFailed(format!("Revision is not a commit: {e}")))?;
            Ok(commit.id().to_string())
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Returns an exact target-bound diff for Review without external diff or
    /// text-conversion helpers. Revisions must already be immutable commit ids.
    pub async fn get_review_diff<P: AsRef<Path>>(
        path: P,
        base_revision: &str,
        head_revision: &str,
        files: &[String],
    ) -> Result<String, GitError> {
        fn is_commit_id(value: &str) -> bool {
            value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        }

        if !is_commit_id(base_revision) || !is_commit_id(head_revision) {
            return Err(GitError::CommandFailed(
                "Review diff requires full immutable commit ids".to_string(),
            ));
        }
        if files.is_empty() {
            return Err(GitError::CommandFailed(
                "Review diff requires at least one target file".to_string(),
            ));
        }
        if files.iter().any(|file| {
            file.trim().is_empty()
                || file.contains('\0')
                || Path::new(file).is_absolute()
                || review_path_has_parent_traversal(file, cfg!(windows))
        }) {
            return Err(GitError::InvalidPath(
                "Review diff files must be workspace-relative target paths".to_string(),
            ));
        }

        let repo_path = path.as_ref().to_string_lossy();
        let range = format!("{}..{}", base_revision, head_revision);
        let mut args = vec![
            "--literal-pathspecs".to_string(),
            "--no-pager".to_string(),
            "diff".to_string(),
            "--no-ext-diff".to_string(),
            "--no-textconv".to_string(),
            "--find-renames".to_string(),
            range,
            "--".to_string(),
        ];
        args.extend(files.iter().cloned());
        let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        execute_git_readonly_command(&repo_path, &arg_refs).await
    }

    /// Gets repository information.
    pub async fn get_repository<P: AsRef<Path>>(path: P) -> Result<GitRepository, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;

            let current_branch = get_current_branch(&repo)?;
            let is_bare = repo.is_bare();
            let has_changes = !get_file_statuses(&repo)?.is_empty();

            let remotes = repo
                .remotes()
                .map_err(|e| GitError::CommandFailed(e.to_string()))?
                .iter()
                .filter_map(|name| name.ok().flatten().map(str::to_string))
                .collect();

            let path_str = path_buf.to_string_lossy().to_string();
            let name = path_buf
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            Ok(GitRepository {
                path: path_str,
                name,
                current_branch,
                is_bare,
                has_changes,
                remotes,
            })
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Gets lightweight repository information without scanning worktree status.
    pub async fn get_repository_basic<P: AsRef<Path>>(path: P) -> Result<GitRepository, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;

            let current_branch = get_current_branch(&repo)?;
            let is_bare = repo.is_bare();
            let path_str = path_buf.to_string_lossy().to_string();
            let name = path_buf
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            Ok(GitRepository {
                path: path_str,
                name,
                current_branch,
                is_bare,
                has_changes: false,
                remotes: Vec::new(),
            })
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Counts changed tracked entries across the index and working tree in one scan.
    pub async fn get_tracked_change_count<P: AsRef<Path>>(
        path: P,
    ) -> Result<Option<usize>, GitError> {
        let path = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = match open_repository(&path) {
                Ok(repo) if !repo.is_bare() => repo,
                Ok(_) | Err(GitError::RepositoryNotFound(_)) => return Ok(None),
                Err(error) => return Err(error),
            };
            let mut options = StatusOptions::new();
            options.include_untracked(false).renames_head_to_index(true);
            let statuses = repo.statuses(Some(&mut options))?;
            Ok(Some(statuses.len()))
        })
        .await
        .map_err(|error| GitError::CommandFailed(format!("spawn_blocking join: {error}")))?
    }

    /// Gets repository status.
    pub async fn get_status<P: AsRef<Path>>(path: P) -> Result<GitStatus, GitError> {
        let path_buf = path.as_ref().to_path_buf();

        timeout(
            Duration::from_secs(10),
            task::spawn_blocking(move || {
                let repo = open_repository(&path_buf)?;

                let current_branch = get_current_branch(&repo)?;
                let file_statuses = get_file_statuses(&repo)?;

                let mut staged = Vec::new();
                let mut unstaged = Vec::new();
                let mut untracked = Vec::new();
                let mut conflicts = Vec::new();

                for status in file_statuses {
                    if status.status.contains('C') {
                        conflicts.push(status.path.clone());
                        staged.push(status.clone());
                        unstaged.push(status);
                    } else if status.status.contains('?') {
                        untracked.push(status.path);
                    } else {
                        if status.index_status.is_some() {
                            staged.push(status.clone());
                        }
                        if status.workdir_status.is_some() {
                            unstaged.push(status);
                        }
                    }
                }

                let (ahead, behind) =
                    GitService::get_ahead_behind_count(&repo, &current_branch).unwrap_or((0, 0));

                Ok(GitStatus {
                    staged,
                    unstaged,
                    untracked,
                    conflicts,
                    current_branch,
                    ahead,
                    behind,
                })
            }),
        )
        .await
        .map_err(|_| GitError::CommandFailed("Git status timed out after 10s".to_string()))?
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Gets the branch list.
    pub async fn get_branches<P: AsRef<Path>>(
        path: P,
        include_remote: bool,
    ) -> Result<Vec<GitBranch>, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;

            let mut branches = Vec::new();
            let current_branch = get_current_branch(&repo)?;

            let local_branches = repo
                .branches(Some(BranchType::Local))
                .map_err(|e| GitError::CommandFailed(e.to_string()))?;

            for branch_result in local_branches {
                let (branch, _) =
                    branch_result.map_err(|e| GitError::CommandFailed(e.to_string()))?;

                if let Some(name) = branch
                    .name()
                    .map_err(|e| GitError::CommandFailed(e.to_string()))?
                {
                    let is_current = name == current_branch;
                    let upstream = branch.upstream().ok().and_then(|upstream_branch| {
                        upstream_branch.name().ok().flatten().map(|s| s.to_string())
                    });

                    let (last_commit, last_commit_date) =
                        if let Ok(commit) = branch.get().peel_to_commit() {
                            (
                                Some(commit.id().to_string()),
                                Some(format_timestamp(commit.time().seconds())),
                            )
                        } else {
                            (None, None)
                        };

                    let (ahead, behind) = if is_current {
                        GitService::get_ahead_behind_count(&repo, name).unwrap_or((0, 0))
                    } else {
                        (0, 0)
                    };

                    branches.push(GitBranch {
                        name: name.to_string(),
                        current: is_current,
                        remote: false,
                        upstream,
                        ahead,
                        behind,
                        last_commit,
                        last_commit_date: last_commit_date.clone(),

                        base_branch: None,
                        child_branches: None,
                        merged_branches: None,
                        branch_type: Some(Self::determine_branch_type(name)),
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
                    });
                }
            }

            if include_remote {
                let remote_branches = repo
                    .branches(Some(BranchType::Remote))
                    .map_err(|e| GitError::CommandFailed(e.to_string()))?;

                for branch_result in remote_branches {
                    let (branch, _) =
                        branch_result.map_err(|e| GitError::CommandFailed(e.to_string()))?;

                    if let Some(name) = branch
                        .name()
                        .map_err(|e| GitError::CommandFailed(e.to_string()))?
                    {
                        let (last_commit, last_commit_date) =
                            if let Ok(commit) = branch.get().peel_to_commit() {
                                (
                                    Some(commit.id().to_string()),
                                    Some(format_timestamp(commit.time().seconds())),
                                )
                            } else {
                                (None, None)
                            };

                        branches.push(GitBranch {
                            name: name.to_string(),
                            current: false,
                            remote: true,
                            upstream: None,
                            ahead: 0,
                            behind: 0,
                            last_commit,
                            last_commit_date: last_commit_date.clone(),

                            base_branch: None,
                            child_branches: None,
                            merged_branches: None,
                            branch_type: Some(Self::determine_branch_type(name)),
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
                        });
                    }
                }
            }

            Ok(branches)
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Gets branches with detailed information.
    pub async fn get_enhanced_branches<P: AsRef<Path>>(
        path: P,
        include_remote: bool,
    ) -> Result<Vec<GitBranch>, GitError> {
        let mut branches = Self::get_branches(&path, include_remote).await?;

        Self::analyze_branch_relations(&mut branches)?;

        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;
            let current_branch = get_current_branch(&repo)?;

            for branch in &mut branches {
                if !branch.remote {
                    branch.stats = GitService::calculate_branch_stats(&repo, &branch.name).ok();
                    branch.is_stale = Some(GitService::is_branch_stale(branch));
                    if branch.name != current_branch {
                        branch.can_merge = GitService::can_merge_safely(&repo, &branch.name).ok();
                        branch.has_conflicts = branch.can_merge.map(|can| !can);
                    }
                }
            }

            Ok(branches)
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Determines the branch type.
    fn determine_branch_type(branch_name: &str) -> String {
        if branch_name.starts_with("feature/") || branch_name.starts_with("feat/") {
            "feature".to_string()
        } else if branch_name.starts_with("hotfix/") || branch_name.starts_with("fix/") {
            "hotfix".to_string()
        } else if branch_name.starts_with("release/") || branch_name.starts_with("rel/") {
            "release".to_string()
        } else if branch_name.starts_with("bugfix/") || branch_name.starts_with("bug/") {
            "bugfix".to_string()
        } else if branch_name.starts_with("chore/") {
            "chore".to_string()
        } else if branch_name.starts_with("docs/") {
            "docs".to_string()
        } else if branch_name.starts_with("test/") {
            "test".to_string()
        } else if ["main", "master", "develop", "development"].contains(&branch_name) {
            "main".to_string()
        } else {
            "other".to_string()
        }
    }

    /// Analyzes branch relationships.
    fn analyze_branch_relations(branches: &mut [GitBranch]) -> Result<(), GitError> {
        let main_branches = ["main", "master", "develop"];

        let available_main_branches: Vec<String> = branches
            .iter()
            .filter(|b| !b.remote && main_branches.contains(&b.name.as_str()))
            .map(|b| b.name.clone())
            .collect();

        for branch in branches.iter_mut() {
            if !branch.remote && !main_branches.contains(&branch.name.as_str()) {
                if let Some(main_branch) = available_main_branches.first() {
                    branch.base_branch = Some(main_branch.clone());
                }
            }
        }

        let mut child_map: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        for branch in branches.iter() {
            if let Some(base) = &branch.base_branch {
                child_map
                    .entry(base.clone())
                    .or_default()
                    .push(branch.name.clone());
            }
        }

        for branch in branches.iter_mut() {
            if let Some(children) = child_map.get(&branch.name) {
                branch.child_branches = Some(children.clone());
            }
        }

        Ok(())
    }

    /// Computes branch statistics.
    fn calculate_branch_stats(
        repo: &Repository,
        branch_name: &str,
    ) -> Result<GitBranchStats, GitError> {
        let branch_ref = repo
            .find_branch(branch_name, BranchType::Local)
            .map_err(|e| GitError::BranchNotFound(e.to_string()))?;

        let target = branch_ref
            .get()
            .target()
            .ok_or_else(|| GitError::CommandFailed("Branch has no target".to_string()))?;

        let mut revwalk = repo
            .revwalk()
            .map_err(|e| GitError::CommandFailed(e.to_string()))?;
        revwalk
            .push(target)
            .map_err(|e| GitError::CommandFailed(e.to_string()))?;

        // Only count recent commits, avoid full-history traversal.
        const STATS_COMMIT_LIMIT: usize = 1000;
        let commit_count = revwalk.take(STATS_COMMIT_LIMIT).count() as i32;

        Ok(GitBranchStats {
            commit_count,
            contributor_count: 1,
            file_changes: 0,
            lines_changed: GitLinesChanged {
                additions: 0,
                deletions: 0,
            },
            activity_score: std::cmp::min(commit_count * 2, 100),
        })
    }

    /// Branches with no activity in this many days are considered stale.
    const STALE_DAYS_THRESHOLD: i64 = 90;

    /// Checks whether a branch is stale.
    fn is_branch_stale(branch: &GitBranch) -> bool {
        match branch
            .last_activity_at
            .as_ref()
            .or(branch.last_commit_date.as_ref())
        {
            Some(date_str) => {
                // format_timestamp produces "YYYY-MM-DD HH:MM:SS UTC"
                chrono::NaiveDateTime::parse_from_str(date_str, "%Y-%m-%d %H:%M:%S UTC")
                    .map(|dt| {
                        (chrono::Utc::now().naive_utc() - dt).num_days()
                            > Self::STALE_DAYS_THRESHOLD
                    })
                    .unwrap_or(false)
            }
            None => true,
        }
    }

    /// Checks whether a branch can be merged safely into HEAD via
    /// three-way merge analysis (merge-base, merge-trees).
    fn can_merge_safely(repo: &Repository, branch_name: &str) -> Result<bool, GitError> {
        let branch = repo
            .find_branch(branch_name, BranchType::Local)
            .map_err(|e| GitError::BranchNotFound(e.to_string()))?;
        let branch_commit = branch
            .get()
            .peel_to_commit()
            .map_err(|e| GitError::CommandFailed(format!("Failed to peel branch: {e}")))?;

        let head_commit = repo
            .head()
            .map_err(|e| GitError::CommandFailed(format!("Failed to get HEAD: {e}")))?
            .peel_to_commit()
            .map_err(|e| GitError::CommandFailed(format!("Failed to peel HEAD: {e}")))?;

        let base_oid = repo
            .merge_base(head_commit.id(), branch_commit.id())
            .map_err(|e| GitError::CommandFailed(format!("Failed to find merge base: {e}")))?;
        let base_commit = repo.find_commit(base_oid).map_err(|e| {
            GitError::CommandFailed(format!("Failed to find merge base commit: {e}"))
        })?;

        let base_tree = base_commit
            .tree()
            .map_err(|e| GitError::CommandFailed(format!("Failed to get base tree: {e}")))?;
        let head_tree = head_commit
            .tree()
            .map_err(|e| GitError::CommandFailed(format!("Failed to get HEAD tree: {e}")))?;
        let branch_tree = branch_commit
            .tree()
            .map_err(|e| GitError::CommandFailed(format!("Failed to get branch tree: {e}")))?;

        let index = repo
            .merge_trees(&base_tree, &head_tree, &branch_tree, None)
            .map_err(|e| GitError::MergeConflict(format!("Merge analysis failed: {e}")))?;

        Ok(!index.has_conflicts())
    }

    /// Gets commit history.
    pub async fn get_commits<P: AsRef<Path>>(
        path: P,
        params: GitLogParams,
    ) -> Result<Vec<GitCommit>, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;
            let since_timestamp = params
                .since
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| resolve_git_approxidate(&path_buf, "--since", value))
                .transpose()?;
            let until_timestamp = params
                .until
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| resolve_git_approxidate(&path_buf, "--until", value))
                .transpose()?;

            let mut revwalk = repo
                .revwalk()
                .map_err(|e| GitError::CommandFailed(e.to_string()))?;

            revwalk
                .push_head()
                .map_err(|e| GitError::CommandFailed(e.to_string()))?;

            // Safety valve: maximum revwalk steps for filtered queries.
            const MAX_REVWALK_STEPS: usize = 500;
            let has_filter = params.author.is_some() || params.grep.is_some();
            let has_time_filter = since_timestamp.is_some() || until_timestamp.is_some();
            let step_limit = if has_time_filter || has_filter {
                MAX_REVWALK_STEPS
            } else {
                usize::MAX
            };

            let mut commits = Vec::new();
            let mut matched_count = 0;
            let skip = params.skip.unwrap_or(0);
            let max_count = params.max_count.unwrap_or(50);
            let mut walk_steps = 0;

            for oid_result in revwalk {
                walk_steps += 1;
                if walk_steps > step_limit {
                    break;
                }

                if commits.len() >= max_count as usize {
                    break;
                }

                let oid = oid_result.map_err(|e| GitError::CommandFailed(e.to_string()))?;

                let commit = repo
                    .find_commit(oid)
                    .map_err(|e| GitError::CommandFailed(e.to_string()))?;

                let author = commit.author();
                let message = commit.message().unwrap_or("").to_string();
                let commit_timestamp = commit.time().seconds();

                if since_timestamp.is_some_and(|threshold| commit_timestamp < threshold)
                    || until_timestamp.is_some_and(|threshold| commit_timestamp > threshold)
                {
                    continue;
                }

                if let Some(author_filter) = &params.author {
                    if !author.name().unwrap_or("").contains(author_filter) {
                        continue;
                    }
                }

                if let Some(grep_filter) = &params.grep {
                    if !message.contains(grep_filter) {
                        continue;
                    }
                }

                if matched_count < skip as usize {
                    matched_count += 1;
                    continue;
                }

                let parents: Vec<String> = commit.parent_ids().map(|id| id.to_string()).collect();

                let (additions, deletions, files_changed) = if params.stat.unwrap_or(false) {
                    GitService::get_commit_stats(&repo, &commit).unwrap_or((None, None, None))
                } else {
                    (None, None, None)
                };

                commits.push(GitCommit {
                    hash: commit.id().to_string(),
                    short_hash: commit.id().to_string()[..7].to_string(),
                    message,
                    author: author.name().unwrap_or("Unknown").to_string(),
                    author_email: author.email().unwrap_or("").to_string(),
                    date: format_timestamp(commit.time().seconds()),
                    parents,
                    additions,
                    deletions,
                    files_changed,
                });

                matched_count += 1;
            }

            Ok(commits)
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Adds files to the staging area.
    pub async fn add_files<P: AsRef<Path>>(
        path: P,
        params: GitAddParams,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec!["add"];

        if params.all.unwrap_or(false) {
            args.push("-A");
        } else if params.update.unwrap_or(false) {
            args.push("-u");
        } else {
            for file in &params.files {
                args.push(file);
            }
        }

        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "files": params.files,
                "all": params.all,
                "update": params.update
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Commits changes.
    pub async fn commit<P: AsRef<Path>>(
        path: P,
        params: GitCommitParams,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec![
            "commit".to_string(),
            "-m".to_string(),
            params.message.clone(),
        ];

        if params.amend.unwrap_or(false) {
            args.push("--amend".to_string());
        }

        if params.all.unwrap_or(false) {
            args.push("-a".to_string());
        }

        if params.no_verify.unwrap_or(false) {
            args.push("--no-verify".to_string());
        }

        if let Some(author) = &params.author {
            args.push("--author".to_string());
            args.push(format!("{} <{}>", author.name, author.email));
        }

        let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let output = execute_git_command(&repo_path, &args_refs).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "message": params.message,
                "amend": params.amend,
                "all": params.all,
                "noVerify": params.no_verify,
                "author": params.author
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Pushes changes.
    pub async fn push<P: AsRef<Path>>(
        path: P,
        params: GitPushParams,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec!["push"];

        if params.force.unwrap_or(false) {
            args.push("--force");
        }

        if params.set_upstream.unwrap_or(false) {
            args.push("-u");
        }

        if let Some(remote) = &params.remote {
            args.push(remote);
        }

        if let Some(branch) = &params.branch {
            args.push(branch);
        }

        let output = timeout(
            Duration::from_secs(30),
            execute_git_command(&repo_path, &args),
        )
        .await
        .map_err(|_| GitError::NetworkError("Push operation timed out".to_string()))??;

        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "remote": params.remote,
                "branch": params.branch,
                "force": params.force,
                "set_upstream": params.set_upstream
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Pulls changes.
    pub async fn pull<P: AsRef<Path>>(
        path: P,
        params: GitPullParams,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec!["pull"];

        if params.rebase.unwrap_or(false) {
            args.push("--rebase");
        }

        if let Some(remote) = &params.remote {
            args.push(remote);
        }

        if let Some(branch) = &params.branch {
            args.push(branch);
        }

        let output = timeout(
            Duration::from_secs(30),
            execute_git_command(&repo_path, &args),
        )
        .await
        .map_err(|_| GitError::NetworkError("Pull operation timed out".to_string()))??;

        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "remote": params.remote,
                "branch": params.branch,
                "rebase": params.rebase
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Checks out a branch.
    pub async fn checkout_branch<P: AsRef<Path>>(
        path: P,
        branch_name: &str,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let args = vec!["checkout", branch_name];
        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "branch": branch_name
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Creates a branch.
    pub async fn create_branch<P: AsRef<Path>>(
        path: P,
        branch_name: &str,
        start_point: Option<&str>,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec!["checkout", "-b", branch_name];
        let effective_start_point = start_point.filter(|s| !s.trim().is_empty());
        if let Some(start) = effective_start_point {
            args.push(start);
        }

        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "branch": branch_name,
                "start_point": effective_start_point
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Deletes a branch.
    pub async fn delete_branch<P: AsRef<Path>>(
        path: P,
        branch_name: &str,
        force: bool,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let flag = if force { "-D" } else { "-d" };
        let args = vec!["branch", flag, branch_name];
        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "branch": branch_name,
                "force": force
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Resets to a specific commit.
    ///
    /// # Parameters
    /// - `path`: Repository path
    /// - `commit_hash`: Target commit hash
    /// - `mode`: Reset mode (`soft`, `mixed`, `hard`)
    pub async fn reset_to_commit<P: AsRef<Path>>(
        path: P,
        commit_hash: &str,
        mode: &str,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mode_flag = match mode {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            _ => {
                return Err(GitError::CommandFailed(format!(
                    "Invalid reset mode: {}",
                    mode
                )))
            }
        };

        let args = vec!["reset", mode_flag, commit_hash];
        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "commit": commit_hash,
                "mode": mode
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Gets the diff.
    pub async fn get_diff<P: AsRef<Path>>(
        path: P,
        params: &GitDiffParams,
    ) -> Result<String, GitError> {
        let repo_path = path.as_ref().to_string_lossy();
        let args = build_git_diff_args(params);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        if params.review_safe.unwrap_or(false) {
            execute_git_readonly_command(&repo_path, &arg_refs).await
        } else {
            execute_git_command(&repo_path, &arg_refs).await
        }
    }

    /// Gets changed files using `git diff --name-status`.
    pub async fn get_changed_files<P: AsRef<Path>>(
        path: P,
        params: &GitChangedFilesParams,
    ) -> Result<Vec<GitChangedFile>, GitError> {
        let repo_path = path.as_ref().to_string_lossy();
        let args = build_git_changed_files_args(params);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        let output = if params.review_safe.unwrap_or(false) {
            execute_git_readonly_command(&repo_path, &arg_refs).await?
        } else {
            execute_git_command(&repo_path, &arg_refs).await?
        };
        Ok(parse_name_status_output(&output))
    }

    /// Gets file content.
    ///
    /// # Parameters
    /// - `path`: Repository path
    /// - `file_path`: File relative path
    /// - `commit`: Commit reference (optional, defaults to `HEAD`)
    ///
    /// # Returns
    /// - File content string
    pub async fn get_file_content<P: AsRef<Path>>(
        path: P,
        file_path: &str,
        commit: Option<&str>,
    ) -> Result<String, GitError> {
        let repo_path = path.as_ref().to_string_lossy();

        let commit_ref = commit.unwrap_or("HEAD");
        let object_spec = format!("{}:{}", commit_ref, file_path);

        let args = vec!["show", &object_spec];

        execute_git_command(&repo_path, &args).await
    }

    /// Resets file changes (discarding working tree changes).
    ///
    /// # Parameters
    /// - `path`: Repository path
    /// - `files`: List of file paths
    /// - `staged`: Whether to reset the index (`true`: reset staged, `false`: restore worktree)
    ///
    /// # Returns
    /// - Operation result
    pub async fn reset_files<P: AsRef<Path>>(
        path: P,
        files: &[String],
        staged: bool,
    ) -> Result<String, GitError> {
        let repo_path = path.as_ref().to_string_lossy();

        if staged {
            let mut args = vec!["restore", "--staged"];
            for file in files {
                args.push(file);
            }
            execute_git_command(&repo_path, &args).await
        } else {
            let mut args = vec!["restore"];
            for file in files {
                args.push(file);
            }
            execute_git_command(&repo_path, &args).await
        }
    }

    /// Gets ahead/behind counts.
    fn get_ahead_behind_count(
        repo: &Repository,
        branch_name: &str,
    ) -> Result<(i32, i32), GitError> {
        let local_branch = repo
            .find_branch(branch_name, BranchType::Local)
            .map_err(|e| GitError::BranchNotFound(e.to_string()))?;

        if let Ok(upstream) = local_branch.upstream() {
            let local_oid = local_branch.get().target().ok_or_else(|| {
                GitError::CommandFailed("Failed to get local branch target".to_string())
            })?;
            let upstream_oid = upstream.get().target().ok_or_else(|| {
                GitError::CommandFailed("Failed to get upstream branch target".to_string())
            })?;

            let (ahead, behind) = repo
                .graph_ahead_behind(local_oid, upstream_oid)
                .map_err(|e| GitError::CommandFailed(e.to_string()))?;

            Ok((ahead as i32, behind as i32))
        } else {
            Ok((0, 0))
        }
    }

    /// Gets commit statistics via diff_tree_to_tree.
    fn get_commit_stats(repo: &Repository, commit: &Commit) -> Result<CommitStats, GitError> {
        let tree = commit
            .tree()
            .map_err(|e| GitError::CommandFailed(format!("Failed to get tree: {e}")))?;

        let parent_tree = if commit.parent_count() > 0 {
            commit.parent(0).ok().and_then(|p| p.tree().ok())
        } else {
            None
        };

        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map_err(|e| GitError::CommandFailed(format!("Failed to diff: {e}")))?;

        let stats = diff
            .stats()
            .map_err(|e| GitError::CommandFailed(format!("Failed to get diff stats: {e}")))?;

        Ok((
            Some(stats.insertions() as i32),
            Some(stats.deletions() as i32),
            Some(stats.files_changed() as i32),
        ))
    }

    /// Gets Git commit graph data.
    pub async fn get_git_graph<P: AsRef<Path>>(
        path: P,
        max_count: Option<usize>,
    ) -> Result<GitGraph, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;
            build_git_graph(&repo, max_count).map_err(|e| GitError::CommandFailed(e.to_string()))
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Gets Git commit graph data for a specific branch.
    pub async fn get_git_graph_for_branch<P: AsRef<Path>>(
        path: P,
        max_count: Option<usize>,
        branch_name: Option<String>,
    ) -> Result<GitGraph, GitError> {
        let path_buf = path.as_ref().to_path_buf();
        task::spawn_blocking(move || {
            let repo = open_repository(&path_buf)?;
            build_git_graph_for_branch(&repo, max_count, branch_name.as_deref())
                .map_err(|e| GitError::CommandFailed(e.to_string()))
        })
        .await
        .map_err(|e| GitError::CommandFailed(format!("spawn_blocking join: {e}")))?
    }

    /// Cherry-picks a commit onto the current branch.
    ///
    /// # Parameters
    /// - `path`: Repository path
    /// - `commit_hash`: Commit hash to cherry-pick
    /// - `no_commit`: Apply changes without committing automatically (default `false`)
    ///
    /// # Returns
    /// - Operation result
    pub async fn cherry_pick<P: AsRef<Path>>(
        path: P,
        commit_hash: &str,
        no_commit: bool,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec!["cherry-pick"];

        if no_commit {
            args.push("-n");
        }

        args.push(commit_hash);

        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "commit": commit_hash,
                "no_commit": no_commit
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Aborts the cherry-pick operation.
    ///
    /// # Parameters
    /// - `path`: Repository path
    ///
    /// # Returns
    /// - Operation result
    pub async fn cherry_pick_abort<P: AsRef<Path>>(
        path: P,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let args = vec!["cherry-pick", "--abort"];
        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: None,
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Continues the cherry-pick operation (after resolving conflicts).
    ///
    /// # Parameters
    /// - `path`: Repository path
    ///
    /// # Returns
    /// - Operation result
    pub async fn cherry_pick_continue<P: AsRef<Path>>(
        path: P,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let args = vec!["cherry-pick", "--continue"];
        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: None,
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }

    /// Lists all worktrees.
    ///
    /// # Parameters
    /// - `path`: Repository path
    ///
    /// # Returns
    /// - Worktree list
    pub async fn list_worktrees<P: AsRef<Path>>(path: P) -> Result<Vec<GitWorktreeInfo>, GitError> {
        let repo_path = path.as_ref().to_string_lossy();

        let args = vec!["worktree", "list", "--porcelain"];
        let output = execute_git_command(&repo_path, &args).await?;

        Ok(parse_worktree_list(&output))
    }

    /// Adds a new worktree.
    ///
    /// # Parameters
    /// - `path`: Repository path
    /// - `branch`: Branch name
    /// - `create_branch`: Whether to create a new branch
    ///
    /// # Returns
    /// - Newly created worktree information
    pub async fn add_worktree<P: AsRef<Path>>(
        path: P,
        branch: &str,
        create_branch: bool,
    ) -> Result<GitWorktreeInfo, GitError> {
        let repo_path = path.as_ref().to_string_lossy();
        let repository_path = path.as_ref().to_path_buf();
        let repository_info = Self::resolve_worktree_repository(path.as_ref()).await?;

        task::spawn_blocking(move || {
            let repository = discover_repository(&repository_path)?;
            match repository.head() {
                Ok(head) if head.target().is_some() => {}
                Err(error) if error.code() == ErrorCode::UnbornBranch => {
                    return Err(GitError::CommandFailed(
                        "Cannot create a worktree before the repository has an initial commit"
                            .to_string(),
                    ));
                }
                Ok(_) => {
                    return Err(GitError::CommandFailed(
                        "Cannot create a worktree because the repository HEAD has no commit"
                            .to_string(),
                    ));
                }
                Err(error) => {
                    return Err(GitError::CommandFailed(format!(
                        "Failed to inspect repository HEAD before creating worktree: {error}"
                    )));
                }
            }
            ensure_worktree_directory_excluded(&repository_info.common_git_dir)
        })
        .await
        .map_err(|error| GitError::CommandFailed(format!("spawn_blocking join: {error}")))??;

        let worktree_dir = path.as_ref().join(".worktrees");
        let worktree_path = worktree_dir.join(branch);
        let worktree_path_str = worktree_path.to_string_lossy().to_string();

        if !worktree_dir.exists() {
            std::fs::create_dir_all(&worktree_dir).map_err(GitError::IoError)?;
        }

        let args = if create_branch {
            vec!["worktree", "add", "-b", branch, &worktree_path_str]
        } else {
            vec!["worktree", "add", &worktree_path_str, branch]
        };

        execute_git_command(&repo_path, &args).await?;
        let normalized_expected = worktree_path_str.replace("\\", "/");
        let expected_branch = branch.to_string();
        task::spawn_blocking(move || {
            let repository = Repository::open(&worktree_path).map_err(|error| {
                GitError::CommandFailed(format!(
                    "Failed to inspect newly created worktree: {error}"
                ))
            })?;
            let (branch, head) = match repository.head() {
                Ok(head) => (
                    head.shorthand().ok().map(str::to_string),
                    head.target()
                        .map(|target| target.to_string())
                        .unwrap_or_default(),
                ),
                Err(error) if error.code() == ErrorCode::UnbornBranch => {
                    (Some(expected_branch), "0".repeat(40))
                }
                Err(error) => {
                    return Err(GitError::CommandFailed(format!(
                        "Failed to resolve newly created worktree HEAD: {error}"
                    )))
                }
            };
            Ok(GitWorktreeInfo {
                path: normalized_expected,
                branch,
                head,
                is_main: false,
                is_locked: false,
                is_prunable: false,
            })
        })
        .await
        .map_err(|error| GitError::CommandFailed(format!("spawn_blocking join: {error}")))?
    }

    /// Removes a worktree.
    ///
    /// # Parameters
    /// - `path`: Repository path
    /// - `worktree_path`: Worktree path to remove
    /// - `force`: Whether to force removal
    ///
    /// # Returns
    /// - Operation result
    pub async fn remove_worktree<P: AsRef<Path>>(
        path: P,
        worktree_path: &str,
        force: bool,
    ) -> Result<GitOperationResult, GitError> {
        let start_time = Instant::now();
        let repo_path = path.as_ref().to_string_lossy();

        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(worktree_path);

        let output = execute_git_command(&repo_path, &args).await?;
        let duration = elapsed_ms_u64(start_time);

        Ok(GitOperationResult {
            success: true,
            data: Some(serde_json::json!({
                "worktree_path": worktree_path,
                "force": force
            })),
            error: None,
            output: Some(output),
            duration: Some(duration),
        })
    }
}

fn ensure_worktree_directory_excluded(common_git_dir: &Path) -> Result<(), GitError> {
    const WORKTREE_EXCLUDE_PATTERN: &str = ".worktrees/";

    let info_dir = common_git_dir.join("info");
    std::fs::create_dir_all(&info_dir).map_err(GitError::IoError)?;
    let exclude_path = info_dir.join("exclude");
    let existing = match std::fs::read_to_string(&exclude_path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(GitError::IoError(error)),
    };
    if existing
        .lines()
        .any(|line| line.trim() == WORKTREE_EXCLUDE_PATTERN)
    {
        return Ok(());
    }

    let mut exclude = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exclude_path)
        .map_err(GitError::IoError)?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        writeln!(exclude).map_err(GitError::IoError)?;
    }
    writeln!(exclude, "{WORKTREE_EXCLUDE_PATTERN}").map_err(GitError::IoError)
}

#[cfg(test)]
mod review_path_tests {
    use super::{review_path_has_parent_traversal, GitLogParams, GitService};
    use std::{fs, path::Path};

    fn git(root: &Path, args: &[&str], commit_date: Option<&str>) {
        let mut command = openbitfun_services_core::process_manager::create_command("git");
        command.current_dir(root).args(args);
        if let Some(commit_date) = commit_date {
            command
                .env("GIT_AUTHOR_DATE", commit_date)
                .env("GIT_COMMITTER_DATE", commit_date);
        }
        let output = command.output().expect("git should be available for tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit_file(root: &Path, contents: &str, message: &str, commit_date: &str) {
        fs::write(root.join("tracked.txt"), contents).expect("fixture should be written");
        git(root, &["add", "--", "tracked.txt"], None);
        git(
            root,
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=openbitfun@example.com",
                "commit",
                "-m",
                message,
            ],
            Some(commit_date),
        );
    }

    #[test]
    fn parent_traversal_uses_platform_path_separators() {
        assert!(review_path_has_parent_traversal("src/../outside.rs", false));
        assert!(!review_path_has_parent_traversal(
            r"src/literal\..\name.rs",
            false,
        ));
        assert!(review_path_has_parent_traversal(r"src\..\outside.rs", true,));
    }

    #[tokio::test]
    async fn commit_date_filters_use_git_approxidates_instead_of_revision_names() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        git(directory.path(), &["init"], None);
        commit_file(
            directory.path(),
            "old\n",
            "old commit",
            "2020-01-01T00:00:00Z",
        );
        commit_file(
            directory.path(),
            "new\n",
            "new commit",
            "2030-01-01T00:00:00Z",
        );

        let recent = GitService::get_commits(
            directory.path(),
            GitLogParams {
                since: Some("2025-01-01".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("since date should be accepted");
        assert_eq!(
            recent
                .iter()
                .map(|commit| commit.message.trim())
                .collect::<Vec<_>>(),
            vec!["new commit"]
        );

        let older = GitService::get_commits(
            directory.path(),
            GitLogParams {
                until: Some("2025-01-01".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("until date should be accepted");
        assert_eq!(
            older
                .iter()
                .map(|commit| commit.message.trim())
                .collect::<Vec<_>>(),
            vec!["old commit"]
        );
    }

    #[tokio::test]
    async fn add_worktree_returns_created_checkout_without_listing_all_worktrees() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        git(directory.path(), &["init"], None);
        commit_file(
            directory.path(),
            "initial\n",
            "initial commit",
            "2025-01-01T00:00:00Z",
        );

        let worktree = GitService::add_worktree(directory.path(), "feature-test", true)
            .await
            .expect("worktree should be created");

        assert_eq!(worktree.branch.as_deref(), Some("feature-test"));
        assert!(!worktree.head.is_empty());
        assert!(!worktree.is_main);
        assert!(Path::new(&worktree.path).is_dir());
        let exclude = fs::read_to_string(directory.path().join(".git/info/exclude"))
            .expect("Git exclude file should be readable");
        assert_eq!(
            exclude
                .lines()
                .filter(|line| line.trim() == ".worktrees/")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn add_worktree_rejects_repository_without_commits_before_side_effects() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        git(directory.path(), &["init"], None);

        let error = GitService::add_worktree(directory.path(), "unborn-test", true)
            .await
            .expect_err("unborn worktree creation should be rejected");

        assert!(error.to_string().contains("initial commit"));
        assert!(!directory.path().join(".worktrees").exists());
        let worktrees = GitService::list_worktrees(directory.path())
            .await
            .expect("worktree list should remain readable");
        assert_eq!(worktrees.len(), 1);
    }
}
