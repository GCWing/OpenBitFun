//! Local isolated workspace preparation for LoopX tasks.

use super::loopx_cli::{
    LoopxCommandPlan, LoopxProcessError, LoopxProcessObserver, LoopxProcessRunner,
    NoopLoopxProcessObserver, SystemLoopxProcessRunner,
};
use openbitfun_product_domains::miniapp::loopx as loopx_contract;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::Url;

const WORKSPACE_MARKER_SCHEMA: u32 = 1;
const WORKSPACE_MARKER_NAME: &str = "bitfun-loopx-workspace.json";
static WORKSPACE_PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn git_compatible_path(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

#[derive(Debug, Clone)]
pub struct LoopxWorkspaceServiceConfig {
    pub root_dir: PathBuf,
    pub git_executable: PathBuf,
    pub clone_deadline: Duration,
    pub command_deadline: Duration,
    pub terminate_grace: Duration,
}

impl LoopxWorkspaceServiceConfig {
    pub fn new(root_dir: impl Into<PathBuf>, git_executable: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
            git_executable: git_executable.into(),
            // A first-time bare clone downloads the full history of the target
            // repository; medium repositories on residential bandwidth
            // regularly need more than five minutes. 30 minutes bounds runaway
            // transfers without killing an otherwise healthy clone.
            clone_deadline: Duration::from_secs(1800),
            command_deadline: Duration::from_secs(30),
            terminate_grace: Duration::from_secs(2),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopxWorkspaceLayout {
    pub repository_identity: String,
    pub repository_hash: String,
    pub task_hash: String,
    pub worktree_path: PathBuf,
    /// Shared bare repository for this repository. All tasks of one repository
    /// share a single object database via `git worktree add`; it is removed
    /// once the last worktree is disposed.
    pub bare_repo_path: PathBuf,
    pub registry_path: PathBuf,
    pub branch_name: String,
    pub clone_url: String,
}

pub fn plan_workspace_layout(
    root_dir: &Path,
    task_id: &str,
    item: &loopx_contract::LoopxIssueKey,
) -> loopx_contract::LoopxHostResult<LoopxWorkspaceLayout> {
    validate_task_and_item("workspace-plan", task_id, item)?;
    if !root_dir.is_absolute() {
        return Err(host_error(
            loopx_contract::LoopxHostPortErrorKind::InvalidInput,
            "workspace-plan",
            "LoopX workspace root must be absolute",
            false,
        ));
    }
    let repository_identity = item.repository.canonical_id().to_lowercase();
    let repository_hash = sha256_prefix(repository_identity.as_bytes(), 20);
    let task_hash = sha256_prefix(task_id.as_bytes(), 20);
    let repository_dir = root_dir.join(&repository_hash);
    let worktree_path = repository_dir.join(&task_hash);
    Ok(LoopxWorkspaceLayout {
        repository_identity,
        repository_hash,
        task_hash: task_hash.clone(),
        bare_repo_path: repository_dir.join("bare.git"),
        registry_path: worktree_path.join(".loopx").join("registry.json"),
        worktree_path,
        branch_name: format!("bitfun-loopx/{task_hash}"),
        clone_url: format!(
            "https://github.com/{}/{}.git",
            item.repository.owner, item.repository.repository
        ),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopxGitCommandPlan {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub environment: BTreeMap<OsString, OsString>,
    pub current_dir: Option<PathBuf>,
}

pub fn plan_git_clone_command(
    git_executable: &Path,
    layout: &LoopxWorkspaceLayout,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git_executable.to_path_buf(),
        args: vec![
            OsString::from("clone"),
            OsString::from("--no-checkout"),
            OsString::from("--config"),
            // The target repository may contain paths beyond the Windows
            // 260-character limit once joined with the workspace root; keep
            // git capable of long paths inside every created repository.
            OsString::from("core.longpaths=true"),
            OsString::from("--origin"),
            OsString::from("origin"),
            OsString::from("--"),
            OsString::from(&layout.clone_url),
            layout.worktree_path.as_os_str().to_owned(),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

/// Shared bare clone for one repository. All tasks of the repository add
/// linked worktrees from this single object database.
pub fn plan_git_bare_clone_command(
    git_executable: &Path,
    layout: &LoopxWorkspaceLayout,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git_executable.to_path_buf(),
        args: vec![
            OsString::from("clone"),
            OsString::from("--bare"),
            OsString::from("--config"),
            // Long-path support must travel with the shared bare repository so
            // linked worktree checkouts can write files whose joined path
            // exceeds the Windows 260-character limit.
            OsString::from("core.longpaths=true"),
            OsString::from("--origin"),
            OsString::from("origin"),
            OsString::from("--"),
            OsString::from(&layout.clone_url),
            layout.bare_repo_path.as_os_str().to_owned(),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

/// Cheap validity probe for the shared bare repository. A clone that was
/// killed mid-transfer (deadline, crash) leaves a directory with no resolvable
/// HEAD; every later `worktree add` would fail with "invalid reference".
pub fn plan_git_bare_head_check_command(
    git_executable: &Path,
    layout: &LoopxWorkspaceLayout,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git_executable.to_path_buf(),
        args: vec![
            OsString::from("-C"),
            layout.bare_repo_path.as_os_str().to_owned(),
            OsString::from("rev-parse"),
            OsString::from("--verify"),
            OsString::from("HEAD"),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

/// Adds a linked worktree from the shared bare repository, checking out the
/// task branch. Equivalent to the old per-task full clone + branch checkout
/// but shares the object database across all tasks of the repository.
pub fn plan_git_worktree_add_command(
    git_executable: &Path,
    layout: &LoopxWorkspaceLayout,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git_executable.to_path_buf(),
        args: vec![
            OsString::from("-C"),
            layout.bare_repo_path.as_os_str().to_owned(),
            OsString::from("worktree"),
            OsString::from("add"),
            OsString::from("-b"),
            OsString::from(&layout.branch_name),
            layout.worktree_path.as_os_str().to_owned(),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

/// Removes a task worktree (and its registration) from the shared bare repo.
pub fn plan_git_worktree_remove_command(
    git_executable: &Path,
    layout: &LoopxWorkspaceLayout,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git_executable.to_path_buf(),
        args: vec![
            OsString::from("-C"),
            layout.bare_repo_path.as_os_str().to_owned(),
            OsString::from("worktree"),
            OsString::from("remove"),
            OsString::from("--force"),
            layout.worktree_path.as_os_str().to_owned(),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

/// Porcelain worktree list of the shared bare repo. Used after dispose to
/// decide whether the last worktree is gone and the bare repo can be deleted.
pub fn plan_git_worktree_list_command(
    git_executable: &Path,
    layout: &LoopxWorkspaceLayout,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git_executable.to_path_buf(),
        args: vec![
            OsString::from("-C"),
            layout.bare_repo_path.as_os_str().to_owned(),
            OsString::from("worktree"),
            OsString::from("list"),
            OsString::from("--porcelain"),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

pub fn canonical_github_remote(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/');
    if let Some(path) = trimmed.strip_prefix("git@github.com:") {
        return canonical_github_path(path);
    }
    let parsed = Url::parse(trimmed).ok()?;
    if !parsed.host_str()?.eq_ignore_ascii_case("github.com") {
        return None;
    }
    canonical_github_path(parsed.path().trim_start_matches('/'))
}

pub struct LoopxWorkspaceService {
    config: LoopxWorkspaceServiceConfig,
    runner: Arc<dyn LoopxProcessRunner>,
    observer: Arc<dyn LoopxProcessObserver>,
    mutation_lock: Mutex<()>,
    running: Arc<StdMutex<HashMap<String, CancellationToken>>>,
}

impl std::fmt::Debug for LoopxWorkspaceService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LoopxWorkspaceService")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl LoopxWorkspaceService {
    pub fn new(config: LoopxWorkspaceServiceConfig) -> Self {
        Self::with_runner(
            config,
            Arc::new(SystemLoopxProcessRunner),
            Arc::new(NoopLoopxProcessObserver),
        )
    }

    pub fn with_runner(
        config: LoopxWorkspaceServiceConfig,
        runner: Arc<dyn LoopxProcessRunner>,
        observer: Arc<dyn LoopxProcessObserver>,
    ) -> Self {
        Self {
            config,
            runner,
            observer,
            mutation_lock: Mutex::new(()),
            running: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    async fn probe_inner(
        &self,
        request: &loopx_contract::LoopxWorkspaceProbeRequest,
        cancellation: CancellationToken,
    ) -> loopx_contract::LoopxHostResult<loopx_contract::LoopxWorkspaceProbeResult> {
        if request.operation_id.trim().is_empty() {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::InvalidInput,
                &request.operation_id,
                "operation_id is required",
                false,
            ));
        }
        tokio::fs::create_dir_all(&self.config.root_dir)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to create LoopX workspace root: {error}"),
                    true,
                )
            })?;
        let canonical_root = tokio::fs::canonicalize(&self.config.root_dir)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to resolve LoopX workspace root: {error}"),
                    true,
                )
            })?;
        verify_workspace_root_writable(&canonical_root, &request.operation_id).await?;

        let version = self
            .run_git(
                &request.operation_id,
                git_version_plan(&self.config.git_executable),
                self.config.command_deadline,
                cancellation.clone(),
            )
            .await?;
        let git_version = version.stdout.trim().to_string();

        let repository_verified = if let Some(repository) = &request.repository {
            validate_repository(&request.operation_id, repository)?;
            self.run_git(
                &request.operation_id,
                git_repository_probe_plan(&self.config.git_executable, repository),
                self.config.command_deadline,
                cancellation,
            )
            .await?;
            true
        } else {
            false
        };

        Ok(loopx_contract::LoopxWorkspaceProbeResult {
            git_version: (!git_version.is_empty()).then_some(git_version),
            workspace_root: git_compatible_path(&canonical_root)
                .to_string_lossy()
                .into_owned(),
            repository_verified,
        })
    }

    async fn prepare_inner(
        &self,
        request: &loopx_contract::LoopxWorkspacePrepareRequest,
        cancellation: CancellationToken,
    ) -> loopx_contract::LoopxHostResult<loopx_contract::LoopxWorkspacePrepareResult> {
        validate_task_and_item(&request.operation_id, &request.task_id, &request.item)?;
        tokio::fs::create_dir_all(&self.config.root_dir)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to create LoopX workspace root: {error}"),
                    true,
                )
            })?;
        let canonical_root = tokio::fs::canonicalize(&self.config.root_dir)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to resolve LoopX workspace root: {error}"),
                    true,
                )
            })?;
        let layout = plan_workspace_layout(
            &git_compatible_path(&canonical_root),
            &request.task_id,
            &request.item,
        )?;
        let repository_parent = layout
            .worktree_path
            .parent()
            .expect("hashed workspace layout always has a parent");
        tokio::fs::create_dir_all(repository_parent)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to create repository workspace directory: {error}"),
                    true,
                )
            })?;
        ensure_path_boundary(&canonical_root, repository_parent, &request.operation_id).await?;

        if tokio::fs::try_exists(&layout.worktree_path)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    error.to_string(),
                    true,
                )
            })?
        {
            ensure_path_boundary(
                &canonical_root,
                &layout.worktree_path,
                &request.operation_id,
            )
            .await?;
            let marker = read_workspace_marker(&layout, &request.operation_id).await?;
            validate_marker(&marker, &layout, &request.operation_id)?;
            self.verify_remote(&layout, &request.operation_id, cancellation)
                .await?;
            return Ok(workspace_result(&layout, true));
        }

        // Shared-object-database layout: ensure the bare repository exists once
        // per repository, then add a linked worktree for this task. Older
        // per-task full clones on disk keep working (they take the reuse path
        // above); only brand-new workspaces get the shared bare repo.
        let bare_exists = tokio::fs::try_exists(&layout.bare_repo_path)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to probe shared bare repository: {error}"),
                    true,
                )
            })?;
        // A bare repository abandoned by an interrupted clone has no resolvable
        // HEAD and would poison every task of this repository with
        // "fatal: invalid reference: HEAD" at worktree add. Rebuild it from
        // scratch, but only while no sibling task worktree still links into it:
        // removing a shared object database out from under live worktrees would
        // silently break them.
        let bare_usable = if bare_exists {
            let head_check = self
                .run_git(
                    &request.operation_id,
                    plan_git_bare_head_check_command(&self.config.git_executable, &layout),
                    self.config.command_deadline,
                    cancellation.clone(),
                )
                .await;
            match head_check {
                Ok(_) => true,
                Err(_) => {
                    let linked_worktrees = self
                        .run_git(
                            &request.operation_id,
                            plan_git_worktree_list_command(&self.config.git_executable, &layout),
                            self.config.command_deadline,
                            cancellation.clone(),
                        )
                        .await
                        .map(|listing| {
                            listing
                                .stdout
                                .lines()
                                .filter(|line| line.starts_with("worktree "))
                                .count()
                                // The first porcelain entry is the bare
                                // repository itself.
                                .saturating_sub(1)
                        })
                        // An unlistable bare repository cannot serve any
                        // worktree either; treat it as abandoned.
                        .unwrap_or(0);
                    if linked_worktrees > 0 {
                        return Err(host_error(
                            loopx_contract::LoopxHostPortErrorKind::Conflict,
                            &request.operation_id,
                            format!(
                                "shared bare repository {} has no valid HEAD (an earlier clone was interrupted) but still hosts {linked_worktrees} task worktree(s); archive those tasks so it can be rebuilt",
                                layout.bare_repo_path.display()
                            ),
                            false,
                        ));
                    }
                    tokio::fs::remove_dir_all(&layout.bare_repo_path)
                        .await
                        .map_err(|error| {
                            host_error(
                                loopx_contract::LoopxHostPortErrorKind::Io,
                                &request.operation_id,
                                format!(
                                    "failed to remove corrupt shared bare repository left by an interrupted clone: {error}"
                                ),
                                true,
                            )
                        })?;
                    false
                }
            }
        } else {
            false
        };
        if !bare_usable {
            self.run_git(
                &request.operation_id,
                plan_git_bare_clone_command(&self.config.git_executable, &layout),
                self.config.clone_deadline,
                cancellation.clone(),
            )
            .await?;
        }
        self.run_git(
            &request.operation_id,
            plan_git_worktree_add_command(&self.config.git_executable, &layout),
            self.config.clone_deadline,
            cancellation.clone(),
        )
        .await?;
        self.verify_remote(&layout, &request.operation_id, cancellation.clone())
            .await?;
        write_workspace_marker(&layout, &request.task_id, &request.operation_id).await?;
        Ok(workspace_result(&layout, false))
    }

    async fn verify_inner(
        &self,
        request: &loopx_contract::LoopxWorkspaceVerifyRequest,
        cancellation: CancellationToken,
    ) -> loopx_contract::LoopxHostResult<loopx_contract::LoopxWorkspaceVerifyResult> {
        validate_task_and_item(&request.operation_id, &request.task_id, &request.item)?;
        let canonical_root = match tokio::fs::canonicalize(&self.config.root_dir).await {
            Ok(path) => path,
            Err(error) => {
                return Ok(invalid_workspace(format!(
                    "workspace root is unavailable: {error}"
                )))
            }
        };
        let layout = plan_workspace_layout(
            &git_compatible_path(&canonical_root),
            &request.task_id,
            &request.item,
        )?;
        if Path::new(&request.worktree_path) != layout.worktree_path
            || Path::new(&request.registry_path) != layout.registry_path
        {
            return Ok(invalid_workspace(
                "workspace paths do not match the canonical task layout",
            ));
        }
        if ensure_path_boundary(
            &canonical_root,
            &layout.worktree_path,
            &request.operation_id,
        )
        .await
        .is_err()
        {
            return Ok(invalid_workspace(
                "workspace resolves outside the managed root",
            ));
        }
        let marker = match read_workspace_marker(&layout, &request.operation_id).await {
            Ok(marker) => marker,
            Err(error) => return Ok(invalid_workspace(error.message)),
        };
        if let Err(error) = validate_marker(&marker, &layout, &request.operation_id) {
            return Ok(invalid_workspace(error.message));
        }
        if let Err(error) = self
            .verify_remote(&layout, &request.operation_id, cancellation)
            .await
        {
            if matches!(
                error.kind,
                loopx_contract::LoopxHostPortErrorKind::Cancelled
                    | loopx_contract::LoopxHostPortErrorKind::Timeout
            ) {
                return Err(error);
            }
            return Ok(invalid_workspace(error.message));
        }
        Ok(loopx_contract::LoopxWorkspaceVerifyResult {
            valid: true,
            repository: Some(request.item.repository.clone()),
            message: None,
        })
    }

    async fn verify_remote(
        &self,
        layout: &LoopxWorkspaceLayout,
        operation_id: &str,
        cancellation: CancellationToken,
    ) -> loopx_contract::LoopxHostResult<()> {
        let output = self
            .run_git(
                operation_id,
                git_remote_plan(&self.config.git_executable, layout),
                self.config.command_deadline,
                cancellation,
            )
            .await?;
        let actual = canonical_github_remote(output.stdout.trim()).ok_or_else(|| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                operation_id,
                "workspace origin is not a canonical GitHub repository",
                false,
            )
        })?;
        if actual != layout.repository_identity {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                operation_id,
                format!(
                    "workspace origin mismatch: expected {}, got {actual}; existing data was preserved",
                    layout.repository_identity
                ),
                false,
            ));
        }
        Ok(())
    }

    async fn run_git(
        &self,
        operation_id: &str,
        plan: LoopxGitCommandPlan,
        deadline: Duration,
        cancellation: CancellationToken,
    ) -> loopx_contract::LoopxHostResult<super::loopx_cli::LoopxProcessOutput> {
        self.runner
            .run(
                LoopxCommandPlan {
                    operation_id: operation_id.to_string(),
                    executable: plan.executable,
                    args: plan.args,
                    current_dir: plan.current_dir,
                    environment: plan.environment,
                    deadline,
                    terminate_grace: self.config.terminate_grace,
                },
                cancellation,
                self.observer.as_ref(),
            )
            .await
            .map_err(|error| map_process_error(error, operation_id))
    }

    fn register_operation(
        &self,
        operation_id: &str,
    ) -> loopx_contract::LoopxHostResult<(CancellationToken, WorkspaceOperationRegistration)> {
        if operation_id.trim().is_empty() {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::InvalidInput,
                operation_id,
                "operation_id is required",
                false,
            ));
        }
        let mut running = self
            .running
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if running.contains_key(operation_id) {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                operation_id,
                "workspace operation is already running",
                true,
            ));
        }
        let cancellation = CancellationToken::new();
        running.insert(operation_id.to_string(), cancellation.clone());
        Ok((
            cancellation,
            WorkspaceOperationRegistration {
                operation_id: operation_id.to_string(),
                running: self.running.clone(),
            },
        ))
    }

    /// Removes the task worktree after terminal settlement, then removes the
    /// shared bare repository once its last linked worktree is gone.
    ///
    /// - Shared layout: `git worktree remove --force` (linked worktree), then
    ///   `git worktree list --porcelain`; when only the bare repository itself
    ///   remains, the bare directory is removed too.
    /// - Legacy layout (per-task full clone, `.git` is a directory): the whole
    ///   worktree directory is removed directly. Upgraded installs keep their
    ///   existing clones working; only new workspaces use the shared layout.
    async fn dispose_inner(
        &self,
        request: &loopx_contract::LoopxWorkspaceDisposeRequest,
        cancellation: CancellationToken,
    ) -> loopx_contract::LoopxHostResult<loopx_contract::LoopxWorkspaceDisposeResult> {
        validate_task_and_item(&request.operation_id, &request.task_id, &request.item)?;
        let canonical_root = tokio::fs::canonicalize(&self.config.root_dir)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to resolve LoopX workspace root: {error}"),
                    true,
                )
            })?;
        let layout = plan_workspace_layout(
            &git_compatible_path(&canonical_root),
            &request.task_id,
            &request.item,
        )?;
        let bare_exists = tokio::fs::try_exists(&layout.bare_repo_path)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to probe bare repository: {error}"),
                    true,
                )
            })?;

        if tokio::fs::try_exists(&layout.worktree_path)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    error.to_string(),
                    true,
                )
            })?
        {
            ensure_path_boundary(
                &canonical_root,
                &layout.worktree_path,
                &request.operation_id,
            )
            .await?;
            // Only BitFun-owned workspaces may be removed. A missing or
            // mismatched marker keeps the directory (and any user changes).
            let marker = read_workspace_marker(&layout, &request.operation_id).await?;
            validate_marker(&marker, &layout, &request.operation_id)?;

            let dot_git = layout.worktree_path.join(".git");
            let linked_worktree = tokio::fs::metadata(&dot_git)
                .await
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);

            if linked_worktree && bare_exists {
                self.run_git(
                    &request.operation_id,
                    plan_git_worktree_remove_command(&self.config.git_executable, &layout),
                    self.config.command_deadline,
                    cancellation.clone(),
                )
                .await?;
            } else {
                tokio::fs::remove_dir_all(&layout.worktree_path)
                    .await
                    .map_err(|error| {
                        host_error(
                            loopx_contract::LoopxHostPortErrorKind::Io,
                            &request.operation_id,
                            format!("failed to remove task worktree: {error}"),
                            false,
                        )
                    })?;
            }
        }

        // Remove the shared bare repository once no linked worktree remains.
        if bare_exists {
            let listing = self
                .run_git(
                    &request.operation_id,
                    plan_git_worktree_list_command(&self.config.git_executable, &layout),
                    self.config.command_deadline,
                    cancellation,
                )
                .await?;
            let worktree_entries = listing
                .stdout
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count();
            if worktree_entries <= 1 {
                tokio::fs::remove_dir_all(&layout.bare_repo_path)
                    .await
                    .map_err(|error| {
                        host_error(
                            loopx_contract::LoopxHostPortErrorKind::Io,
                            &request.operation_id,
                            format!("failed to remove shared bare repository: {error}"),
                            false,
                        )
                    })?;
            }
        }
        Ok(loopx_contract::LoopxWorkspaceDisposeResult { removed: true })
    }

    async fn reset_inner(
        &self,
        request: &loopx_contract::LoopxWorkspaceResetRequest,
    ) -> loopx_contract::LoopxHostResult<loopx_contract::LoopxWorkspaceResetResult> {
        if request.operation_id.trim().is_empty() {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::InvalidInput,
                &request.operation_id,
                "operation_id is required",
                false,
            ));
        }
        let root_metadata = match tokio::fs::symlink_metadata(&self.config.root_dir).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(loopx_contract::LoopxWorkspaceResetResult { removed: false });
            }
            Err(error) => {
                return Err(host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to inspect LoopX workspace root: {error}"),
                    true,
                ));
            }
        };
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                &request.operation_id,
                "LoopX workspace reset refused to remove a non-directory or symlink root",
                false,
            ));
        }
        let canonical_root = tokio::fs::canonicalize(&self.config.root_dir)
            .await
            .map_err(|error| {
                host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to resolve LoopX workspace root: {error}"),
                    true,
                )
            })?;
        if !canonical_root.is_absolute() || canonical_root.parent().is_none() {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                &request.operation_id,
                "LoopX workspace reset refused an unsafe root path",
                false,
            ));
        }
        let root_name = canonical_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !root_name.eq_ignore_ascii_case("workspaces")
            && !root_name.eq_ignore_ascii_case("loopx-workspaces")
        {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                &request.operation_id,
                "LoopX workspace reset refused an unexpected root directory name",
                false,
            ));
        }
        let parent = canonical_root
            .parent()
            .expect("validated workspace root parent");
        let detached_root = parent.join(format!(".{root_name}.reset-{}", uuid::Uuid::new_v4()));
        // A freshly cancelled agent turn may still hold handles inside the
        // workspace tree when the reset runs: the turn-cancel path signals
        // cancellation tokens and the tool implementations terminate their
        // child processes (shells, git, gh, the LoopX sidecar) asynchronously,
        // and on Windows a directory rename fails immediately with access
        // denied while ANY such handle or CWD reference exists - handle
        // release after process termination is itself asynchronous (live
        // 2026-09-10: stopping a running task failed the reset with
        // `failed to detach LoopX workspace root for cleanup: 拒绝访问。 (os
        // error 5)` even though the agent cancel had returned). Retry the
        // detach with bounded backoff instead of failing the whole reset.
        let mut rename_error = None;
        for attempt in 0..12u32 {
            match tokio::fs::rename(&canonical_root, &detached_root).await {
                Ok(()) => {
                    rename_error = None;
                    break;
                }
                Err(error) if is_transient_dir_rename_error(&error) => {
                    log::warn!(
                        "LoopX workspace root detach is blocked by a lingering handle; retrying: attempt={}, next_delay_ms={}, error={}",
                        attempt + 1,
                        rename_retry_delay_ms(attempt),
                        error
                    );
                    rename_error = Some(error);
                    tokio::time::sleep(std::time::Duration::from_millis(rename_retry_delay_ms(
                        attempt,
                    )))
                    .await;
                }
                Err(error) => return Err(host_error(
                    loopx_contract::LoopxHostPortErrorKind::Io,
                    &request.operation_id,
                    format!("failed to detach LoopX workspace root for cleanup: {error}"),
                    true,
                )),
            }
        }
        if let Some(error) = rename_error {
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                &request.operation_id,
                format!(
                    "failed to detach LoopX workspace root for cleanup after retries: {error}"
                ),
                true,
            ));
        }
        if let Err(error) = tokio::fs::create_dir_all(&canonical_root).await {
            let _ = tokio::fs::rename(&detached_root, &canonical_root).await;
            return Err(host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                &request.operation_id,
                format!("failed to recreate LoopX workspace root: {error}"),
                true,
            ));
        }

        let retained = self
            .restore_bare_repository_caches(&detached_root, &canonical_root, &request.operation_id)
            .await;
        if let Err(error) = &retained {
            log::warn!("LoopX repository cache retention failed during reset: {error}");
        }
        let prune_paths = retained.unwrap_or_default();
        for bare_repo_path in prune_paths {
            if let Err(error) = self
                .run_git(
                    &request.operation_id,
                    git_worktree_prune_plan(&self.config.git_executable, &bare_repo_path),
                    self.config.command_deadline,
                    CancellationToken::new(),
                )
                .await
            {
                log::warn!(
                    "Failed to prune retained LoopX worktree registrations: bare_repo={}, error={}",
                    bare_repo_path.display(),
                    error
                );
            }
        }

        tokio::spawn(async move {
            match tokio::fs::remove_dir_all(&detached_root).await {
                Ok(()) => log::info!(
                    "Detached LoopX task workspaces were reclaimed in the background: path={}",
                    detached_root.display()
                ),
                Err(error) => log::warn!(
                    "Failed to reclaim detached LoopX task workspaces: path={}, error={}",
                    detached_root.display(),
                    error
                ),
            }
        });
        Ok(loopx_contract::LoopxWorkspaceResetResult { removed: true })
    }

    async fn restore_bare_repository_caches(
        &self,
        detached_root: &Path,
        fresh_root: &Path,
        operation_id: &str,
    ) -> loopx_contract::LoopxHostResult<Vec<PathBuf>> {
        let mut retained = Vec::new();
        let mut repositories = tokio::fs::read_dir(detached_root).await.map_err(|error| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                operation_id,
                format!("failed to enumerate detached LoopX repositories: {error}"),
                true,
            )
        })?;
        while let Some(entry) = repositories.next_entry().await.map_err(|error| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                operation_id,
                format!("failed to inspect detached LoopX repository: {error}"),
                true,
            )
        })? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !is_repository_hash(name)
                || !entry
                    .file_type()
                    .await
                    .map(|kind| kind.is_dir())
                    .unwrap_or(false)
            {
                continue;
            }
            let source = entry.path().join("bare.git");
            let Ok(metadata) = tokio::fs::symlink_metadata(&source).await else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let destination_dir = fresh_root.join(name);
            tokio::fs::create_dir_all(&destination_dir)
                .await
                .map_err(|error| {
                    host_error(
                        loopx_contract::LoopxHostPortErrorKind::Io,
                        operation_id,
                        format!("failed to recreate LoopX repository cache directory: {error}"),
                        true,
                    )
                })?;
            let destination = destination_dir.join("bare.git");
            tokio::fs::rename(&source, &destination)
                .await
                .map_err(|error| {
                    host_error(
                        loopx_contract::LoopxHostPortErrorKind::Io,
                        operation_id,
                        format!("failed to retain LoopX bare repository cache: {error}"),
                        true,
                    )
                })?;
            retained.push(destination);
        }
        Ok(retained)
    }
}

impl loopx_contract::LoopxWorkspacePort for LoopxWorkspaceService {
    fn probe(
        &self,
        request: loopx_contract::LoopxWorkspaceProbeRequest,
    ) -> loopx_contract::LoopxHostFuture<'_, loopx_contract::LoopxWorkspaceProbeResult> {
        Box::pin(async move {
            let (cancellation, _registration) = self.register_operation(&request.operation_id)?;
            self.probe_inner(&request, cancellation).await
        })
    }

    fn prepare(
        &self,
        request: loopx_contract::LoopxWorkspacePrepareRequest,
    ) -> loopx_contract::LoopxHostFuture<'_, loopx_contract::LoopxWorkspacePrepareResult> {
        Box::pin(async move {
            let (cancellation, _registration) = self.register_operation(&request.operation_id)?;
            let _mutation = self.mutation_lock.lock().await;
            self.prepare_inner(&request, cancellation).await
        })
    }

    fn verify(
        &self,
        request: loopx_contract::LoopxWorkspaceVerifyRequest,
    ) -> loopx_contract::LoopxHostFuture<'_, loopx_contract::LoopxWorkspaceVerifyResult> {
        Box::pin(async move {
            let (cancellation, _registration) = self.register_operation(&request.operation_id)?;
            self.verify_inner(&request, cancellation).await
        })
    }

    fn cancel(
        &self,
        request: loopx_contract::LoopxWorkspaceCancelRequest,
    ) -> loopx_contract::LoopxHostFuture<'_, loopx_contract::LoopxWorkspaceCancelResult> {
        Box::pin(async move {
            let running = self
                .running
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            let cancelled = if let Some(cancellation) = running.get(&request.target_operation_id) {
                cancellation.cancel();
                true
            } else {
                false
            };
            Ok(loopx_contract::LoopxWorkspaceCancelResult {
                target_operation_id: request.target_operation_id,
                cancelled,
            })
        })
    }

    fn dispose(
        &self,
        request: loopx_contract::LoopxWorkspaceDisposeRequest,
    ) -> loopx_contract::LoopxHostFuture<'_, loopx_contract::LoopxWorkspaceDisposeResult> {
        Box::pin(async move {
            let (cancellation, _registration) = self.register_operation(&request.operation_id)?;
            let _mutation = self.mutation_lock.lock().await;
            self.dispose_inner(&request, cancellation).await
        })
    }

    fn reset(
        &self,
        request: loopx_contract::LoopxWorkspaceResetRequest,
    ) -> loopx_contract::LoopxHostFuture<'_, loopx_contract::LoopxWorkspaceResetResult> {
        Box::pin(async move {
            let _mutation = self.mutation_lock.lock().await;
            self.reset_inner(&request).await
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct LoopxWorkspaceMarker {
    schema_version: u32,
    repository_identity: String,
    repository_hash: String,
    task_id_hash: String,
    branch_name: String,
}

struct WorkspaceOperationRegistration {
    operation_id: String,
    running: Arc<StdMutex<HashMap<String, CancellationToken>>>,
}

impl Drop for WorkspaceOperationRegistration {
    fn drop(&mut self) {
        self.running
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&self.operation_id);
    }
}

fn git_noninteractive_environment() -> BTreeMap<OsString, OsString> {
    BTreeMap::from([
        (OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0")),
        (OsString::from("GCM_INTERACTIVE"), OsString::from("Never")),
    ])
}

fn git_version_plan(git: &Path) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git.to_path_buf(),
        args: vec![OsString::from("--version")],
        environment: BTreeMap::new(),
        current_dir: None,
    }
}

fn git_worktree_prune_plan(git: &Path, bare_repo_path: &Path) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git.to_path_buf(),
        args: vec![
            OsString::from("--git-dir"),
            bare_repo_path.as_os_str().to_owned(),
            OsString::from("worktree"),
            OsString::from("prune"),
            OsString::from("--expire"),
            OsString::from("now"),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

fn is_repository_hash(value: &str) -> bool {
    value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn git_repository_probe_plan(
    git: &Path,
    repository: &loopx_contract::LoopxRepositoryKey,
) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git.to_path_buf(),
        args: vec![
            OsString::from("ls-remote"),
            OsString::from("--exit-code"),
            OsString::from("--"),
            OsString::from(format!(
                "https://github.com/{}/{}.git",
                repository.owner, repository.repository
            )),
            OsString::from("HEAD"),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

fn git_remote_plan(git: &Path, layout: &LoopxWorkspaceLayout) -> LoopxGitCommandPlan {
    LoopxGitCommandPlan {
        executable: git.to_path_buf(),
        args: vec![
            OsString::from("-C"),
            layout.worktree_path.as_os_str().to_owned(),
            OsString::from("config"),
            OsString::from("--get"),
            OsString::from("remote.origin.url"),
        ],
        environment: git_noninteractive_environment(),
        current_dir: None,
    }
}

/// Resolves the real Git metadata directory for a worktree path.
///
/// A standalone clone keeps `.git` as a directory; a linked worktree from a
/// shared bare repository keeps `.git` as a file containing
/// `gitdir: <absolute path>`. The ownership marker must live inside the real
/// gitdir so both layouts stay covered.
async fn resolve_git_dir(
    worktree_path: &Path,
    operation_id: &str,
) -> loopx_contract::LoopxHostResult<PathBuf> {
    let dot_git = worktree_path.join(".git");
    let metadata = tokio::fs::metadata(&dot_git).await.map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Conflict,
            operation_id,
            format!(
                "existing workspace has no usable .git entry: {error}; existing data was preserved"
            ),
            false,
        )
    })?;
    if metadata.is_dir() {
        return Ok(dot_git);
    }
    // Linked worktree: .git is a gitdir pointer file.
    let pointer = tokio::fs::read_to_string(&dot_git).await.map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Conflict,
            operation_id,
            format!("failed to read worktree gitdir pointer: {error}"),
            false,
        )
    })?;
    let gitdir = pointer
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:").map(str::trim))
        .map(PathBuf::from)
        .ok_or_else(|| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Conflict,
                operation_id,
                "worktree .git pointer has no gitdir entry",
                false,
            )
        })?;
    Ok(gitdir)
}

async fn read_workspace_marker(
    layout: &LoopxWorkspaceLayout,
    operation_id: &str,
) -> loopx_contract::LoopxHostResult<LoopxWorkspaceMarker> {
    let git_dir = resolve_git_dir(&layout.worktree_path, operation_id).await?;
    let marker_path = git_dir.join(WORKSPACE_MARKER_NAME);
    let raw = tokio::fs::read(&marker_path).await.map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Conflict,
            operation_id,
            format!(
                "existing workspace has no valid BitFun ownership marker: {error}; existing data was preserved"
            ),
            false,
        )
    })?;
    serde_json::from_slice(&raw).map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Conflict,
            operation_id,
            format!(
                "existing workspace ownership marker is invalid: {error}; existing data was preserved"
            ),
            false,
        )
    })
}

async fn write_workspace_marker(
    layout: &LoopxWorkspaceLayout,
    task_id: &str,
    operation_id: &str,
) -> loopx_contract::LoopxHostResult<()> {
    let marker = LoopxWorkspaceMarker {
        schema_version: WORKSPACE_MARKER_SCHEMA,
        repository_identity: layout.repository_identity.clone(),
        repository_hash: layout.repository_hash.clone(),
        task_id_hash: sha256_prefix(task_id.as_bytes(), 20),
        branch_name: layout.branch_name.clone(),
    };
    let git_dir = resolve_git_dir(&layout.worktree_path, operation_id).await?;
    let marker_path = git_dir.join(WORKSPACE_MARKER_NAME);
    let temporary_path = git_dir.join(format!("{WORKSPACE_MARKER_NAME}.tmp"));
    let encoded = serde_json::to_vec_pretty(&marker).map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Io,
            operation_id,
            error.to_string(),
            false,
        )
    })?;
    tokio::fs::write(&temporary_path, encoded)
        .await
        .map_err(|error| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                operation_id,
                format!("failed to write workspace ownership marker: {error}"),
                true,
            )
        })?;
    tokio::fs::rename(&temporary_path, &marker_path)
        .await
        .map_err(|error| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                operation_id,
                format!("failed to publish workspace ownership marker: {error}"),
                true,
            )
        })?;
    Ok(())
}

fn validate_marker(
    marker: &LoopxWorkspaceMarker,
    layout: &LoopxWorkspaceLayout,
    operation_id: &str,
) -> loopx_contract::LoopxHostResult<()> {
    if marker.schema_version != WORKSPACE_MARKER_SCHEMA
        || marker.repository_identity != layout.repository_identity
        || marker.repository_hash != layout.repository_hash
        || marker.task_id_hash != layout.task_hash
        || marker.branch_name != layout.branch_name
    {
        return Err(host_error(
            loopx_contract::LoopxHostPortErrorKind::Conflict,
            operation_id,
            "existing workspace ownership does not match the requested task; existing data was preserved",
            false,
        ));
    }
    Ok(())
}

async fn ensure_path_boundary(
    canonical_root: &Path,
    path: &Path,
    operation_id: &str,
) -> loopx_contract::LoopxHostResult<()> {
    let canonical = tokio::fs::canonicalize(path).await.map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Io,
            operation_id,
            format!("failed to resolve workspace path: {error}"),
            true,
        )
    })?;
    if !canonical.starts_with(canonical_root) {
        return Err(host_error(
            loopx_contract::LoopxHostPortErrorKind::Conflict,
            operation_id,
            "workspace path resolves outside the managed root",
            false,
        ));
    }
    Ok(())
}

fn validate_task_and_item(
    operation_id: &str,
    task_id: &str,
    item: &loopx_contract::LoopxIssueKey,
) -> loopx_contract::LoopxHostResult<()> {
    if operation_id.trim().is_empty() || task_id.trim().is_empty() {
        return Err(host_error(
            loopx_contract::LoopxHostPortErrorKind::InvalidInput,
            operation_id,
            "operation_id and task_id are required",
            false,
        ));
    }
    validate_repository(operation_id, &item.repository)?;
    if item.number == 0 {
        return Err(host_error(
            loopx_contract::LoopxHostPortErrorKind::InvalidInput,
            operation_id,
            "workspace preparation requires a canonical GitHub item",
            false,
        ));
    }
    Ok(())
}

fn validate_repository(
    operation_id: &str,
    repository: &loopx_contract::LoopxRepositoryKey,
) -> loopx_contract::LoopxHostResult<()> {
    if !repository.host.eq_ignore_ascii_case("github.com")
        || !is_github_slug(&repository.owner)
        || !is_github_slug(&repository.repository)
    {
        return Err(host_error(
            loopx_contract::LoopxHostPortErrorKind::InvalidInput,
            operation_id,
            "workspace preparation requires a canonical GitHub repository",
            false,
        ));
    }
    Ok(())
}

async fn verify_workspace_root_writable(
    canonical_root: &Path,
    operation_id: &str,
) -> loopx_contract::LoopxHostResult<()> {
    let probe_path = canonical_root.join(format!(
        ".loopx-write-probe-{}-{}",
        std::process::id(),
        WORKSPACE_PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe_path)
        .await
        .map_err(|error| {
            host_error(
                loopx_contract::LoopxHostPortErrorKind::Io,
                operation_id,
                format!("LoopX workspace root is not writable: {error}"),
                false,
            )
        })?;
    drop(file);
    tokio::fs::remove_file(&probe_path).await.map_err(|error| {
        host_error(
            loopx_contract::LoopxHostPortErrorKind::Io,
            operation_id,
            format!("failed to clean up workspace write probe: {error}"),
            true,
        )
    })
}

fn is_github_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn canonical_github_path(path: &str) -> Option<String> {
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/');
    let owner = segments.next()?;
    let repository = segments.next()?;
    if segments.next().is_some() || !is_github_slug(owner) || !is_github_slug(repository) {
        return None;
    }
    Some(format!("github.com/{owner}/{repository}").to_lowercase())
}

fn sha256_prefix(value: &[u8], length: usize) -> String {
    let digest = hex::encode(Sha256::digest(value));
    digest[..length].to_string()
}

fn workspace_result(
    layout: &LoopxWorkspaceLayout,
    reused: bool,
) -> loopx_contract::LoopxWorkspacePrepareResult {
    loopx_contract::LoopxWorkspacePrepareResult {
        worktree_path: layout.worktree_path.to_string_lossy().into_owned(),
        registry_path: layout.registry_path.to_string_lossy().into_owned(),
        reused,
        repository_verified: true,
    }
}

fn invalid_workspace(message: impl Into<String>) -> loopx_contract::LoopxWorkspaceVerifyResult {
    loopx_contract::LoopxWorkspaceVerifyResult {
        valid: false,
        repository: None,
        message: Some(message.into()),
    }
}

fn map_process_error(
    error: LoopxProcessError,
    operation_id: &str,
) -> loopx_contract::LoopxHostPortError {
    let (kind, retryable) = match &error {
        LoopxProcessError::Cancelled { .. } => {
            (loopx_contract::LoopxHostPortErrorKind::Cancelled, true)
        }
        LoopxProcessError::Timeout { .. } => {
            (loopx_contract::LoopxHostPortErrorKind::Timeout, true)
        }
        LoopxProcessError::Io { .. } => (loopx_contract::LoopxHostPortErrorKind::Io, true),
        _ => (loopx_contract::LoopxHostPortErrorKind::Backend, true),
    };
    host_error(
        kind,
        operation_id,
        format_workspace_process_error(&error),
        retryable,
    )
}

fn format_workspace_process_error(error: &LoopxProcessError) -> String {
    let stderr_tail: &[String] = match error {
        LoopxProcessError::Exited { stderr_tail, .. }
        | LoopxProcessError::Timeout { stderr_tail, .. }
        | LoopxProcessError::Cancelled { stderr_tail } => stderr_tail,
        _ => &[],
    };
    let detail = stderr_tail
        .iter()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim())
        .unwrap_or_default();
    let summary = match error {
        LoopxProcessError::Exited { code, .. } => {
            format!("workspace Git command exited with status {code:?}")
        }
        LoopxProcessError::Start { message } => {
            format!("workspace Git command could not start: {message}")
        }
        LoopxProcessError::Io { message } => {
            format!("workspace Git command IO failed: {message}")
        }
        LoopxProcessError::Timeout { deadline_ms, .. } => {
            format!("workspace Git command timed out after {deadline_ms} ms")
        }
        LoopxProcessError::Cancelled { .. } => "workspace Git command was cancelled".to_string(),
        LoopxProcessError::OutputLimit { limit_bytes } => {
            format!("workspace Git output exceeded {limit_bytes} bytes")
        }
    };
    if detail.is_empty() {
        summary
    } else {
        format!("{summary}: {detail}")
    }
}

fn host_error(
    kind: loopx_contract::LoopxHostPortErrorKind,
    operation_id: &str,
    message: impl Into<String>,
    retryable: bool,
) -> loopx_contract::LoopxHostPortError {
    loopx_contract::LoopxHostPortError {
        kind,
        message: message.into(),
        operation_id: Some(operation_id.to_string()),
        retryable,
    }
}

/// Backoff for the workspace-root detach retry, in milliseconds. Twelve
/// attempts at this schedule wait roughly 13.5s in total, which covers the
/// observed teardown tail (agent turn drain, child-process termination, and
/// asynchronous Windows handle release) without making the reset feel stuck.
fn rename_retry_delay_ms(attempt: u32) -> u64 {
    (250 * u64::from(attempt + 1)).min(2_000)
}

/// Windows rename-transient errors that a lingering handle can produce:
/// ERROR_ACCESS_DENIED (5) when a process still holds the tree or uses it as
/// its CWD, ERROR_SHARING_VIOLATION (32) when a file inside is open without
/// FILE_SHARE_DELETE. Everything else (bad path, permissions, disk state) is
/// reported immediately instead of being retried.
fn is_transient_dir_rename_error(error: &std::io::Error) -> bool {
    if cfg!(windows) {
        matches!(error.raw_os_error(), Some(5) | Some(32))
    } else {
        // POSIX renames within one filesystem do not fail transiently on open
        // handles; only EACCES from a concurrent mutation is worth one more
        // attempt.
        matches!(error.raw_os_error(), Some(13))
    }
}
