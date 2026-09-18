//! Controller-side Git baseline for one dispatch.
//!
//! Every dispatch branches from a managed worktree of the controller's own
//! repository. That worktree is what makes the target's result a normal branch
//! instead of a pile of overwritten files: both sides share `base_commit`, so
//! syncing back is a fast-forward the user can inspect, merge, or throw away.
//!
//! Nothing here is transport-specific. SSH and account-device dispatch differ
//! only in how the bundle bytes travel.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result};
use sha2::{Digest, Sha256};

use crate::service::git::{execute_git_command, GitService};
use crate::service::worktree::{
    WorktreeCreateBranchRequest, WorktreeCreateRequest, WorktreeService,
};

use super::{
    baseline_claim, DispatchWorkspaceDelivery, OutboundDispatchRecord, OutboundDispatchStore,
};

/// Number of hex characters used to name a target's shared clone.
const REPO_KEY_CHARS: usize = 16;
/// Commit written when the user asked to carry uncommitted work along.
const UNCOMMITTED_COMMIT_MESSAGE: &str = "OpenBitFun dispatch: uncommitted baseline changes";

#[derive(Debug, Clone)]
pub(super) struct PreparedBaseline {
    /// Readable project name the target uses to name its checkout.
    pub(super) project_label: String,
    pub(super) delivery: DispatchWorkspaceDelivery,
    /// Absolute path of the managed worktree on this controller.
    pub(super) worktree_path: String,
    /// Names the shared clone on the target. Derived, never user-supplied.
    pub(super) repo_key: String,
}

#[derive(Debug, Clone)]
pub(super) struct PreparedBundle {
    pub(super) path: PathBuf,
    pub(super) sha256: String,
    pub(super) size: u64,
}

/// Create (or reopen) this job's baseline worktree and describe its delivery.
///
/// Idempotent through `WorktreeService`'s own receipt: an ambiguous submit that
/// is retried with the same job id reuses the same worktree and the same base
/// commit, so a retry can never hand the target a different tree than the one
/// the first attempt may already have committed to.
pub(super) async fn prepare_baseline(
    store: &OutboundDispatchStore,
    job_id: &str,
    source_workspace_path: &str,
    base_ref: Option<&str>,
    include_uncommitted: bool,
) -> Result<PreparedBaseline> {
    let project = source_workspace_path.trim();
    if project.is_empty() {
        anyhow::bail!("dispatch requires the controller workspace that owns the session");
    }
    let repository = GitService::resolve_worktree_repository(Path::new(project))
        .await
        .map_err(|error| {
            anyhow::anyhow!("dispatch requires a Git workspace on this machine: {error}")
        })?;

    let settings = WorktreeService::settings().await;
    let branch = dispatch_branch_name(&settings.branch_prefix, job_id);

    let created = WorktreeService::create(WorktreeCreateRequest {
        request_id: job_id.to_string(),
        project_workspace_id: None,
        project_workspace_path: project.to_string(),
        source_workspace_path: Some(project.to_string()),
        base_ref: base_ref
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        // Carrying uncommitted work needs it in the worktree first; the commit
        // below is what actually makes it reachable by the target.
        copy_local_changes: include_uncommitted,
        claimed_by: Some(baseline_claim(job_id)),
    })
    .await
    .map_err(|error| anyhow::anyhow!("prepare the dispatch baseline worktree: {error}"))?;

    let worktree_path = created.worktree.path.clone();
    let worktree_id = created.worktree.worktree_id.clone();
    let project_workspace_path = created.worktree.project_workspace_path.trim().to_string();
    let project_workspace_path = if project_workspace_path.is_empty() {
        project.to_string()
    } else {
        project_workspace_path
    };
    let prepared = async {
        if created.worktree.branch.as_deref() != Some(branch.as_str()) {
            WorktreeService::create_branch(WorktreeCreateBranchRequest {
                request_id: format!("{job_id}::branch"),
                project_workspace_id: None,
                project_workspace_path: project_workspace_path.clone(),
                worktree_id: worktree_id.clone(),
                branch: branch.clone(),
            })
            .await
            .map_err(|error| anyhow::anyhow!("create the dispatch branch: {error}"))?;
        }

        if include_uncommitted {
            commit_uncommitted_changes(&worktree_path).await?;
        }

        let base_commit = GitService::resolve_revision(&worktree_path, "HEAD")
            .await
            .map_err(|error| anyhow::anyhow!("resolve the dispatch base commit: {error}"))?;
        let remote_url = resolve_remote_url(project).await;
        let repo_key = repo_key(remote_url.as_deref(), &repository.common_git_dir);

        Ok(PreparedBaseline {
            project_label: project_label(&project_workspace_path),
            delivery: DispatchWorkspaceDelivery {
                source_workspace_path: project.to_string(),
                project_workspace_path: project_workspace_path.clone(),
                baseline_worktree_id: worktree_id.clone(),
                base_commit,
                branch: branch.clone(),
                remote_url,
                include_uncommitted,
            },
            worktree_path,
            repo_key,
        })
    }
    .await;

    match prepared {
        Ok(baseline) => Ok(baseline),
        Err(error) => {
            release_baseline_claim_if_unowned(
                store,
                job_id,
                &project_workspace_path,
                &worktree_id,
                &branch,
            )
            .await;
            Err(error)
        }
    }
}

/// Release the retention claim when setup fails before an outbound record can
/// take ownership of it. The managed worktree is intentionally retained: it
/// may contain the WIP baseline commit and the normal worktree retention rules
/// can decide when it is safe to remove.
pub(super) async fn release_prepared_baseline(
    store: &OutboundDispatchStore,
    job_id: &str,
    baseline: &PreparedBaseline,
) {
    release_baseline_claim_if_unowned(
        store,
        job_id,
        &baseline.delivery.project_workspace_path,
        &baseline.delivery.baseline_worktree_id,
        &baseline.delivery.branch,
    )
    .await;
}

/// The persisted record, rather than the current submit attempt, owns the
/// baseline claim once all immutable Git identity fields match.
pub(super) fn outbound_record_owns_baseline(
    record: &OutboundDispatchRecord,
    worktree_id: &str,
    base_commit: &str,
    branch: &str,
) -> bool {
    record.baseline_worktree_id.as_deref() == Some(worktree_id)
        && record.base_commit.as_deref() == Some(base_commit)
        && record.branch.as_deref() == Some(branch)
}

/// A durable record conservatively owns the retention claim when it identifies
/// this exact worktree and job branch.
///
/// The commit is deliberately not part of this cleanup predicate. A retry that
/// copied uncommitted changes may observe the receipt's original base before it
/// refreshes the worktree HEAD, while the durable record already contains the
/// generated WIP commit. In that ambiguous state preserving a valid claim is
/// safer than allowing automatic cleanup to delete the record's baseline.
fn outbound_record_may_own_claim(
    record: &OutboundDispatchRecord,
    worktree_id: &str,
    branch: &str,
) -> bool {
    record.baseline_worktree_id.as_deref() == Some(worktree_id)
        && record.branch.as_deref() == Some(branch)
}

async fn release_baseline_claim_if_unowned(
    store: &OutboundDispatchStore,
    job_id: &str,
    project_workspace_path: &str,
    worktree_id: &str,
    branch: &str,
) {
    match store.get(job_id).await {
        Ok(Some(record)) if outbound_record_may_own_claim(&record, worktree_id, branch) => {
            return;
        }
        Ok(_) => {}
        Err(error) => {
            // A read failure makes ownership ambiguous. Preserve the claim and
            // its durable owner rather than risking automatic baseline deletion.
            log::warn!(
                "Could not determine dispatch baseline claim ownership: job_id={} worktree_id={} error={}",
                job_id,
                worktree_id,
                error
            );
            return;
        }
    }

    if let Err(error) = WorktreeService::release_claim_for_worktree(
        project_workspace_path,
        worktree_id,
        &baseline_claim(job_id),
    )
    .await
    {
        log::warn!(
            "Failed to release unbound dispatch baseline claim: job_id={} worktree_id={} error={}",
            job_id,
            worktree_id,
            error
        );
    }
}

/// Package the objects a target is missing.
///
/// `have_tips` comes from the target itself rather than from this machine's
/// remote-tracking refs. A controller that assumed "the remote has it, so the
/// target has it" would ship a bundle with prerequisites the target cannot
/// resolve whenever the target's clone is stale or its network is down.
pub(super) async fn build_base_bundle(
    store: &OutboundDispatchStore,
    baseline: &PreparedBaseline,
    have_tips: &[String],
) -> Result<PreparedBundle> {
    let bundles = store.bundles_dir().await?;
    let path = bundles.join(format!(
        "{}.base.bundle",
        sanitized_stem(&baseline.delivery.branch)
    ));
    remove_if_present(&path)?;

    let mut args: Vec<String> = vec![
        "bundle".to_string(),
        "create".to_string(),
        path.to_string_lossy().to_string(),
        // `git bundle create` needs a named ref to advertise; a raw commit SHA
        // is treated as an unadvertised object and Git refuses the resulting
        // empty bundle. The branch is job-scoped and points at `base_commit`.
        format!("refs/heads/{}", baseline.delivery.branch),
    ];
    let known_tips = retain_known_commits(&baseline.worktree_path, have_tips).await;
    if !known_tips.is_empty() {
        args.push("--not".to_string());
        args.extend(known_tips);
    }
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    execute_git_command(&baseline.worktree_path, &borrowed)
        .await
        .map_err(|error| anyhow::anyhow!("package the dispatch base bundle: {error}"))?;

    finish_bundle(path)
}

/// Verify that sync-back is still operating on the branch this job owns.
///
/// A path alone is not enough identity: a user can switch the managed worktree
/// to another branch (or detach it) while the dispatch is running. Fetching and
/// merging in that state would advance the wrong checkout.
pub(super) async fn ensure_baseline_branch(
    worktree_path: &str,
    expected_branch: &str,
) -> Result<()> {
    let current = execute_git_command(
        worktree_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await
    .map_err(|error| {
        anyhow::anyhow!(
            "the dispatch baseline is detached or its symbolic branch cannot be read: {error}"
        )
    })?;
    let current = current.trim();
    if current != expected_branch {
        anyhow::bail!(
            "the dispatch baseline is on branch '{current}', expected '{expected_branch}'; switch it back before syncing"
        );
    }
    Ok(())
}

/// Fast-forward the baseline worktree onto the branch the target produced.
///
/// `--ff-only` is the whole safety story: the baseline branch is created for
/// this job and nothing else writes it, so a rejected fast-forward means the
/// user committed into the baseline themselves. Refusing loudly is correct —
/// silently merging or resetting would discard their work.
pub(super) async fn fetch_result_bundle(
    worktree_path: &str,
    branch: &str,
    bundle: &Path,
) -> Result<String> {
    let bundle_arg = bundle.to_string_lossy().to_string();
    execute_git_command(worktree_path, &["bundle", "verify", &bundle_arg])
        .await
        .map_err(|error| anyhow::anyhow!("verify the dispatch result bundle: {error}"))?;
    execute_git_command(
        worktree_path,
        &[
            "fetch",
            "--no-tags",
            &bundle_arg,
            &format!("refs/heads/{branch}"),
        ],
    )
    .await
    .map_err(|error| anyhow::anyhow!("fetch the dispatch result bundle: {error}"))?;
    execute_git_command(worktree_path, &["merge", "--ff-only", "FETCH_HEAD"])
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "fast-forward the dispatch baseline worktree: {error}. \
                 The baseline has its own commits, so the target's branch was left in FETCH_HEAD \
                 for you to merge manually."
            )
        })?;
    Ok(execute_git_command(worktree_path, &["rev-parse", "HEAD"])
        .await
        .map_err(|error| anyhow::anyhow!("read the synced baseline head: {error}"))?
        .trim()
        .to_string())
}

/// Whether `base_commit` is already reachable from a remote-tracking ref.
///
/// A hint only: the target has the final say through `needsBundle`, because
/// only it knows what its own clone can reach.
pub(super) async fn base_commit_is_published(worktree_path: &str, base_commit: &str) -> bool {
    execute_git_command(
        worktree_path,
        &[
            "rev-list",
            "--count",
            "--max-count=1",
            base_commit,
            "--not",
            "--remotes",
        ],
    )
    .await
    .map(|output| output.trim() == "0")
    .unwrap_or(false)
}

async fn commit_uncommitted_changes(worktree_path: &str) -> Result<()> {
    execute_git_command(worktree_path, &["add", "-A"])
        .await
        .map_err(|error| anyhow::anyhow!("stage the dispatch baseline changes: {error}"))?;
    if execute_git_command(worktree_path, &["diff", "--cached", "--name-only"])
        .await
        .map(|output| output.trim().is_empty())
        .unwrap_or(true)
    {
        return Ok(());
    }
    execute_git_command(
        worktree_path,
        &[
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=OpenBitFun Dispatch",
            "-c",
            "user.email=dispatch@openbitfun.local",
            "commit",
            "--no-verify",
            "-m",
            UNCOMMITTED_COMMIT_MESSAGE,
        ],
    )
    .await
    .map_err(|error| anyhow::anyhow!("commit the dispatch baseline changes: {error}"))?;
    Ok(())
}

async fn resolve_remote_url(project: &str) -> Option<String> {
    for args in [
        vec!["remote", "get-url", "--push", "origin"],
        vec!["remote", "get-url", "origin"],
    ] {
        if let Ok(output) = execute_git_command(project, &args).await {
            let url = output.trim();
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }
    // No `origin`: fall back to whichever remote the repository does define, so
    // a repo using a differently named remote still gets the fast path.
    let remotes = execute_git_command(project, &["remote"]).await.ok()?;
    let first = remotes
        .lines()
        .map(str::trim)
        .find(|name| !name.is_empty())?;
    let url = execute_git_command(project, &["remote", "get-url", first])
        .await
        .ok()?;
    let url = url.trim();
    (!url.is_empty()).then(|| url.to_string())
}

async fn retain_known_commits(worktree_path: &str, tips: &[String]) -> Vec<String> {
    let mut known = Vec::new();
    for tip in tips {
        let tip = tip.trim();
        if tip.len() != 40 || !tip.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        if execute_git_command(
            worktree_path,
            &["cat-file", "-e", &format!("{tip}^{{commit}}")],
        )
        .await
        .is_ok()
        {
            known.push(tip.to_string());
        }
    }
    known
}

fn finish_bundle(path: PathBuf) -> Result<PreparedBundle> {
    let size = std::fs::symlink_metadata(&path)
        .with_context(|| format!("inspect dispatch bundle {}", path.display()))?
        .len();
    let sha256 = openbitfun_services_core::dispatch_workspace::sha256_file(&path)?;
    Ok(PreparedBundle { path, sha256, size })
}

fn remove_if_present(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("replace bundle {}", path.display())),
    }
}

/// Branch that carries this dispatch's work on both machines.
///
/// The user-configurable prefix is sanitized rather than trusted: it reaches a
/// `git update-ref` argument on the target, and the job id suffix is what keeps
/// concurrent dispatches on one repository from colliding.
fn dispatch_branch_name(branch_prefix: &str, job_id: &str) -> String {
    // Rebuild the prefix segment by segment. `.` and `..` segments are dropped
    // rather than escaped: they are invalid in a Git ref and are also the shape
    // a path traversal would take on the target.
    let prefix = branch_prefix
        .split('/')
        .map(|segment| {
            segment
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
                .collect::<String>()
        })
        .map(|segment| {
            segment
                .trim_matches('.')
                .trim_start_matches('-')
                .to_string()
        })
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let suffix = job_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(24)
        .collect::<String>();
    let suffix = if suffix.is_empty() {
        "job".to_string()
    } else {
        suffix
    };
    if prefix.is_empty() {
        format!("dispatch/{suffix}")
    } else {
        format!("{prefix}/dispatch/{suffix}")
    }
}

fn sanitized_stem(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

/// Readable name for the project a dispatch came from.
///
/// The target sanitizes this again before it becomes a path component, so this
/// only has to be recognizable — a directory basename is exactly that, and it
/// matches what the local managed-worktree naming already shows the user.
fn project_label(project_workspace_path: &str) -> String {
    Path::new(project_workspace_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Stable directory name for the target's shared clone.
///
/// Keyed on the remote URL when there is one, so unrelated controllers cloning
/// the same repository reuse one clone on a shared target. Without a remote the
/// repositories are unrelated by construction, so the controller's own Git
/// directory keys it instead.
fn repo_key(remote_url: Option<&str>, common_git_dir: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(b"openbitfun-dispatch-repo");
    match remote_url {
        Some(url) => {
            digest.update(b"remote:");
            digest.update(url.trim().as_bytes());
        }
        None => {
            digest.update(b"local:");
            digest.update(common_git_dir.to_string_lossy().as_bytes());
        }
    }
    format!("{:x}", digest.finalize())
        .chars()
        .take(REPO_KEY_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = crate::util::create_test_command("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn branch_names_are_prefixed_scoped_and_ref_safe() {
        assert_eq!(
            dispatch_branch_name("openbitfun/", "dispatch-1a2b3c"),
            "openbitfun/dispatch/dispatch-1a2b3c"
        );
        assert_eq!(dispatch_branch_name("", "job1"), "dispatch/job1");
        // A prefix that could be read as a git option or escape a ref namespace
        // is sanitized rather than rejected: the setting is cosmetic and must
        // not be able to break every dispatch.
        assert_eq!(
            dispatch_branch_name("--upload-pack=x", "job1"),
            "upload-packx/dispatch/job1"
        );
        assert_eq!(
            dispatch_branch_name("../../etc", "job1"),
            "etc/dispatch/job1"
        );
        assert_eq!(dispatch_branch_name("///", "job1"), "dispatch/job1");
    }

    #[test]
    fn project_labels_come_from_the_workspace_basename() {
        assert_eq!(project_label("/Users/me/code/OpenBitFun"), "OpenBitFun");
        assert_eq!(project_label("/Users/me/code/OpenBitFun/"), "OpenBitFun");
        // Nothing recognizable to use; the target falls back on its own side.
        assert_eq!(project_label("/"), "");
    }

    #[test]
    fn repo_keys_are_hex_stable_and_separate_remote_from_local_identity() {
        let remote = repo_key(Some("git@example.com:acme/app.git"), Path::new("/a/.git"));
        let same_remote = repo_key(Some("git@example.com:acme/app.git"), Path::new("/b/.git"));
        let local = repo_key(None, Path::new("/a/.git"));

        assert_eq!(
            remote, same_remote,
            "one remote must map to one shared clone"
        );
        assert_ne!(remote, local);
        assert_eq!(remote.len(), REPO_KEY_CHARS);
        assert!(remote.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn base_bundle_advertises_the_job_branch_instead_of_an_empty_raw_sha() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repository = temp.path().join("repository");
        std::fs::create_dir_all(&repository).expect("repository");
        git(&repository, &["init", "--quiet"]);
        git(&repository, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&repository, &["config", "user.name", "Dispatch Test"]);
        git(
            &repository,
            &["config", "user.email", "dispatch@example.com"],
        );
        std::fs::write(repository.join("file.txt"), b"base").expect("seed");
        git(&repository, &["add", "-A"]);
        git(&repository, &["commit", "--quiet", "-m", "base"]);
        let branch = "openbitfun/dispatch/job-1";
        git(&repository, &["branch", branch]);
        let base_commit = git(&repository, &["rev-parse", "HEAD"]);
        let store =
            OutboundDispatchStore::new_in_root_for_tests(temp.path().join("dispatch-outbound"));
        let baseline = PreparedBaseline {
            project_label: "OpenBitFun".to_string(),
            delivery: DispatchWorkspaceDelivery {
                source_workspace_path: repository.to_string_lossy().to_string(),
                project_workspace_path: repository.to_string_lossy().to_string(),
                baseline_worktree_id: "worktree-1".to_string(),
                base_commit,
                branch: branch.to_string(),
                remote_url: None,
                include_uncommitted: false,
            },
            worktree_path: repository.to_string_lossy().to_string(),
            repo_key: "abcdef0123456789".to_string(),
        };

        let bundle = build_base_bundle(&store, &baseline, &[])
            .await
            .expect("base bundle");
        git(
            &repository,
            &[
                "bundle",
                "verify",
                bundle.path.to_str().expect("bundle path"),
            ],
        );
        let heads = git(
            &repository,
            &[
                "bundle",
                "list-heads",
                bundle.path.to_str().expect("bundle path"),
            ],
        );
        assert!(heads.contains(&format!("refs/heads/{branch}")));
    }

    #[test]
    fn durable_baseline_ownership_requires_all_immutable_git_identity() {
        let mut record = OutboundDispatchRecord::new(
            "job-1".to_string(),
            super::super::DispatchTarget::Local,
            "session-1".to_string(),
            "/target".to_string(),
            "prompt",
            "submitting",
        )
        .expect("record");
        record.baseline_worktree_id = Some("worktree-1".to_string());
        record.base_commit = Some("0123456789abcdef".to_string());
        record.branch = Some("openbitfun/dispatch/job-1".to_string());

        assert!(outbound_record_owns_baseline(
            &record,
            "worktree-1",
            "0123456789abcdef",
            "openbitfun/dispatch/job-1"
        ));
        assert!(!outbound_record_owns_baseline(
            &record,
            "different-worktree",
            "0123456789abcdef",
            "openbitfun/dispatch/job-1"
        ));
        assert!(!outbound_record_owns_baseline(
            &record,
            "worktree-1",
            "different-commit",
            "openbitfun/dispatch/job-1"
        ));
        assert!(!outbound_record_owns_baseline(
            &record,
            "worktree-1",
            "0123456789abcdef",
            "different-branch"
        ));

        // Claim cleanup is intentionally more conservative than binding: an
        // idempotent WIP retry can briefly observe the receipt's original HEAD
        // even though this durable record owns the later generated commit.
        assert!(outbound_record_may_own_claim(
            &record,
            "worktree-1",
            "openbitfun/dispatch/job-1"
        ));
        record.base_commit = Some("generated-wip-commit".to_string());
        assert!(outbound_record_may_own_claim(
            &record,
            "worktree-1",
            "openbitfun/dispatch/job-1"
        ));
        assert!(!outbound_record_may_own_claim(
            &record,
            "different-worktree",
            "openbitfun/dispatch/job-1"
        ));
    }

    #[tokio::test]
    async fn baseline_branch_guard_rejects_wrong_and_detached_checkouts() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repository = temp.path().join("repository");
        std::fs::create_dir_all(&repository).expect("repository");
        git(&repository, &["init", "--quiet"]);
        git(&repository, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(&repository, &["config", "user.name", "Dispatch Test"]);
        git(
            &repository,
            &["config", "user.email", "dispatch@example.com"],
        );
        std::fs::write(repository.join("file.txt"), b"base").expect("seed");
        git(&repository, &["add", "-A"]);
        git(&repository, &["commit", "--quiet", "-m", "base"]);
        let branch = "openbitfun/dispatch/job-branch";
        git(&repository, &["switch", "--quiet", "-c", branch]);

        ensure_baseline_branch(repository.to_str().expect("repository path"), branch)
            .await
            .expect("owned branch");

        git(&repository, &["switch", "--quiet", "main"]);
        let wrong = ensure_baseline_branch(repository.to_str().expect("repository path"), branch)
            .await
            .expect_err("wrong branch");
        assert!(wrong.to_string().contains("baseline is on branch 'main'"));

        git(&repository, &["switch", "--quiet", "--detach"]);
        let detached =
            ensure_baseline_branch(repository.to_str().expect("repository path"), branch)
                .await
                .expect_err("detached baseline");
        assert!(detached.to_string().contains("baseline is detached"));
    }
}
