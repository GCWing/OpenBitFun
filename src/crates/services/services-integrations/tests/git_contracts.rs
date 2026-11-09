#![cfg(feature = "git")]

use openbitfun_runtime_ports::{GitPort, WorkspaceDiffContent, WorkspaceDiffFileStatus};
use openbitfun_services_integrations::git::{
    build_git_changed_files_args, build_git_diff_args, parse_branch_line, parse_git_log_line,
    parse_name_status_output, parse_worktree_list, GitAuthor, GitChangedFile, GitChangedFileStatus,
    GitChangedFilesParams, GitCommandOutput, GitCommitParams, GitDiffParams, GitError, GitGraph,
    GitService, GitStatus, GitWorkspaceDiffPort, GitWorktreeInfo, GraphNode, GraphRef,
};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn git_changed_file_status_preserves_snake_case_contract() {
    let status = serde_json::to_value(GitChangedFileStatus::Renamed).unwrap();
    assert_eq!(status, serde_json::json!("renamed"));

    let changed_file = GitChangedFile {
        path: "src/new.rs".to_string(),
        old_path: Some("src/old.rs".to_string()),
        status: GitChangedFileStatus::Renamed,
    };

    let value = serde_json::to_value(changed_file).unwrap();
    assert_eq!(value["old_path"], "src/old.rs");
    assert_eq!(value["status"], "renamed");
}

#[test]
fn git_name_status_parser_preserves_common_status_contract() {
    let files = parse_name_status_output(
        "M\tsrc/main.rs\nA\tsrc/new.rs\nD\tsrc/old.rs\nR100\tsrc/old_name.rs\tsrc/new_name.rs\nC087\tsrc/source.rs\tsrc/copy.rs\n",
    );

    assert_eq!(
        files,
        vec![
            GitChangedFile {
                path: "src/main.rs".to_string(),
                old_path: None,
                status: GitChangedFileStatus::Modified,
            },
            GitChangedFile {
                path: "src/new.rs".to_string(),
                old_path: None,
                status: GitChangedFileStatus::Added,
            },
            GitChangedFile {
                path: "src/old.rs".to_string(),
                old_path: None,
                status: GitChangedFileStatus::Deleted,
            },
            GitChangedFile {
                path: "src/new_name.rs".to_string(),
                old_path: Some("src/old_name.rs".to_string()),
                status: GitChangedFileStatus::Renamed,
            },
            GitChangedFile {
                path: "src/copy.rs".to_string(),
                old_path: Some("src/source.rs".to_string()),
                status: GitChangedFileStatus::Copied,
            },
        ],
    );
}

#[test]
fn git_command_output_preserves_raw_stream_contract() {
    let output = GitCommandOutput {
        stdout: "ok".to_string(),
        stderr: "warning".to_string(),
        exit_code: 1,
    };

    assert_eq!(output.stdout, "ok");
    assert_eq!(output.stderr, "warning");
    assert_eq!(output.exit_code, 1);
}

#[test]
fn git_text_parsers_preserve_branch_and_log_contracts() {
    assert_eq!(
        parse_git_log_line("abc123|OpenBitFun|openbitfun@example.com|2026-05-12|subject|body"),
        Some((
            "abc123".to_string(),
            "OpenBitFun".to_string(),
            "openbitfun@example.com".to_string(),
            "2026-05-12".to_string(),
            "subject|body".to_string(),
        ))
    );
    assert_eq!(parse_git_log_line("abc123|missing"), None);

    assert_eq!(
        parse_branch_line("* main"),
        Some(("main".to_string(), true))
    );
    assert_eq!(
        parse_branch_line("  feature/test"),
        Some(("feature/test".to_string(), false))
    );
    assert_eq!(
        parse_branch_line("detached"),
        Some(("detached".to_string(), false))
    );
    assert_eq!(parse_branch_line("  "), None);
}

#[test]
fn git_diff_arg_builders_preserve_existing_command_contract() {
    let args = build_git_diff_args(&GitDiffParams {
        source: Some("main".to_string()),
        target: Some("feature".to_string()),
        files: Some(vec!["src/lib.rs".to_string(), "README.md".to_string()]),
        staged: Some(true),
        stat: Some(true),
        review_safe: Some(true),
    });
    assert_eq!(
        args,
        vec![
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--cached",
            "main..feature",
            "--stat",
            "--",
            "src/lib.rs",
            "README.md",
        ]
    );

    let target_only_args = build_git_diff_args(&GitDiffParams {
        source: None,
        target: Some("feature".to_string()),
        files: None,
        staged: None,
        stat: None,
        review_safe: None,
    });
    assert_eq!(target_only_args, vec!["diff"]);

    let changed_args = build_git_changed_files_args(&GitChangedFilesParams {
        source: None,
        target: Some("feature".to_string()),
        staged: Some(true),
        review_safe: Some(true),
    });
    assert_eq!(
        changed_args,
        vec![
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--name-status",
            "-z",
            "--cached",
            "feature",
        ]
    );
}

#[tokio::test]
async fn review_safe_workspace_diff_forces_rename_detection() {
    let repo_dir = TempRepoDir::new("review-workspace-rename");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "tests@openbitfun.dev"],
    );
    let original = (0..10)
        .map(|index| format!("stable line {index}\n"))
        .collect::<String>();
    fs::write(repo_dir.path().join("old.txt"), &original).unwrap();
    run_git(repo_dir.path(), &["add", "--", "old.txt"]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);
    run_git(repo_dir.path(), &["config", "diff.renames", "false"]);
    run_git(repo_dir.path(), &["mv", "old.txt", "new.txt"]);
    fs::write(
        repo_dir.path().join("new.txt"),
        original.replace("stable line 5", "edited line 5"),
    )
    .unwrap();

    let files = GitService::get_changed_files(
        repo_dir.path(),
        &GitChangedFilesParams {
            source: Some("HEAD".to_string()),
            review_safe: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, GitChangedFileStatus::Renamed);
    assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!(files[0].path, "new.txt");

    let diff = GitService::get_diff(
        repo_dir.path(),
        &GitDiffParams {
            source: Some("HEAD".to_string()),
            files: Some(vec!["old.txt".to_string(), "new.txt".to_string()]),
            review_safe: Some(true),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(diff.contains("rename from old.txt"));
    assert!(diff.contains("rename to new.txt"));
}

#[tokio::test]
async fn git_service_preserves_repository_status_contract() {
    let repo_dir = TempRepoDir::new("git-service-status");
    assert!(!GitService::is_repository(repo_dir.path()).await.unwrap());

    run_git(repo_dir.path(), &["init"]);
    fs::write(repo_dir.path().join("new-file.txt"), "hello\n").unwrap();

    assert!(GitService::is_repository(repo_dir.path()).await.unwrap());

    let status = GitService::get_status(repo_dir.path()).await.unwrap();
    assert!(status
        .untracked
        .iter()
        .any(|path| path == "new-file.txt" || path == "new-file.txt/"));
}

#[tokio::test]
async fn tracked_change_count_excludes_untracked_and_counts_each_file_once() {
    let repo_dir = TempRepoDir::new("tracked change count");
    let root = repo_dir.path();
    assert_eq!(
        GitService::get_tracked_change_count(root).await.unwrap(),
        None
    );
    #[cfg(all(unix, feature = "remote-ssh"))]
    assert!(!run_remote_tracked_change_count(root).status.success());
    run_git(root, &["init"]);
    run_git(root, &["config", "user.name", "OpenBitFun Tests"]);
    run_git(root, &["config", "user.email", "tests@openbitfun.dev"]);
    fs::write(root.join("both.txt"), "base\n").unwrap();
    fs::write(root.join("old.txt"), "rename me\n").unwrap();
    run_git(root, &["add", "--", "both.txt", "old.txt"]);
    assert_tracked_change_count(root, 2).await;
    run_git(root, &["commit", "-m", "base"]);

    fs::create_dir(root.join("untracked")).unwrap();
    fs::write(root.join("untracked/file.txt"), "ignored by count\n").unwrap();
    assert_tracked_change_count(root, 0).await;

    fs::write(root.join("both.txt"), "staged\n").unwrap();
    run_git(root, &["add", "--", "both.txt"]);
    fs::write(root.join("both.txt"), "staged and unstaged\n").unwrap();
    run_git(root, &["mv", "old.txt", "renamed.txt"]);
    assert_tracked_change_count(root, 2).await;

    let worktree = TempRepoDir::new("tracked-change-count-worktree");
    run_git(
        root,
        &[
            "worktree",
            "add",
            "--detach",
            worktree.path().to_str().unwrap(),
        ],
    );
    assert_tracked_change_count(worktree.path(), 0).await;
    fs::remove_file(worktree.path().join("both.txt")).unwrap();
    assert_tracked_change_count(worktree.path(), 1).await;
}

async fn assert_tracked_change_count(root: &std::path::Path, expected: usize) {
    assert_eq!(
        GitService::get_tracked_change_count(root).await.unwrap(),
        Some(expected)
    );
    #[cfg(all(unix, feature = "remote-ssh"))]
    {
        let output = run_remote_tracked_change_count(root);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            expected.to_string()
        );
    }
}

#[cfg(all(unix, feature = "remote-ssh"))]
fn run_remote_tracked_change_count(root: &std::path::Path) -> std::process::Output {
    let command =
        openbitfun_services_integrations::remote_ssh::build_remote_git_tracked_change_count_command(
            &root.to_string_lossy(),
        );
    openbitfun_services_core::process_manager::create_command("sh")
        .args(["-c", &command])
        .output()
        .unwrap()
}

#[tokio::test]
async fn workspace_diff_port_reports_staged_unstaged_and_untracked_changes() {
    let repo_dir = TempRepoDir::new("workspace-diff-port");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "tests@openbitfun.dev"],
    );
    fs::write(repo_dir.path().join("both.txt"), "base\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "both.txt"]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);

    fs::write(repo_dir.path().join("both.txt"), "base\nstaged\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "both.txt"]);
    fs::write(repo_dir.path().join("both.txt"), "base\nstaged\nunstaged\n").unwrap();
    fs::write(repo_dir.path().join("new.txt"), "untracked\n").unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");

    let both = snapshot
        .files
        .iter()
        .find(|file| file.path == "both.txt")
        .expect("tracked file");
    assert_eq!(both.status, WorkspaceDiffFileStatus::Modified);
    assert!(both.staged);
    assert!(both.unstaged);
    assert!(!both.untracked);
    assert!(matches!(
        &both.content,
        WorkspaceDiffContent::Text { patch } if patch.contains("+staged") && patch.contains("+unstaged")
    ));

    let untracked = snapshot
        .files
        .iter()
        .find(|file| file.path == "new.txt")
        .expect("untracked file");
    assert_eq!(untracked.status, WorkspaceDiffFileStatus::Added);
    assert!(untracked.untracked);
    assert!(matches!(
        &untracked.content,
        WorkspaceDiffContent::Text { patch } if patch.contains("+untracked")
    ));
    assert!(!snapshot.truncated);
}

#[tokio::test]
async fn workspace_diff_port_keeps_staged_changes_when_worktree_returns_to_head() {
    let repo_dir = TempRepoDir::new("workspace-diff-cancelled-worktree");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "tests@openbitfun.dev"],
    );
    fs::write(repo_dir.path().join("both.txt"), "base\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "both.txt"]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);

    fs::write(repo_dir.path().join("both.txt"), "staged\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "both.txt"]);
    fs::write(repo_dir.path().join("both.txt"), "base\n").unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");

    let both = snapshot
        .files
        .iter()
        .find(|file| file.path == "both.txt")
        .expect("staged change must remain visible");
    assert!(both.staged);
    assert!(both.unstaged);
    assert!(matches!(&both.content, WorkspaceDiffContent::Text { .. }));
}

#[tokio::test]
async fn workspace_diff_port_keeps_staged_additions_deleted_from_the_worktree() {
    let repo_dir = TempRepoDir::new("workspace-diff-staged-add-deleted");
    run_git(repo_dir.path(), &["init"]);
    fs::write(repo_dir.path().join("added.txt"), "staged\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "added.txt"]);
    fs::remove_file(repo_dir.path().join("added.txt")).unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");
    let added = snapshot
        .files
        .iter()
        .find(|file| file.path == "added.txt")
        .expect("status-only staged addition must remain visible");

    assert_eq!(added.status, WorkspaceDiffFileStatus::Added);
    assert!(added.staged);
    assert!(added.unstaged);
    assert!(!added.untracked);
    assert!(matches!(
        &added.content,
        WorkspaceDiffContent::Text { patch } if patch.is_empty()
    ));
}

#[tokio::test]
async fn workspace_diff_port_preserves_staged_delete_and_recreated_file_sources() {
    let repo_dir = TempRepoDir::new("workspace-diff-staged-delete-recreated");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "tests@openbitfun.dev"],
    );
    fs::write(repo_dir.path().join("rebuilt.txt"), "base\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "rebuilt.txt"]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);
    run_git(repo_dir.path(), &["rm", "--cached", "--", "rebuilt.txt"]);
    fs::write(repo_dir.path().join("rebuilt.txt"), "rebuilt\n").unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");
    let rebuilt = snapshot
        .files
        .iter()
        .find(|file| file.path == "rebuilt.txt")
        .expect("recreated file");

    assert!(rebuilt.staged);
    assert!(rebuilt.untracked);
}

#[tokio::test]
async fn workspace_diff_port_marks_conflicts_without_projecting_an_incomplete_patch() {
    let repo_dir = TempRepoDir::new("workspace-diff-conflict");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "tests@openbitfun.dev"],
    );
    fs::write(repo_dir.path().join("conflict.txt"), "base\n").unwrap();
    run_git(repo_dir.path(), &["add", "--", "conflict.txt"]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);
    run_git(repo_dir.path(), &["branch", "-M", "main"]);
    run_git(repo_dir.path(), &["checkout", "-b", "side"]);
    fs::write(repo_dir.path().join("conflict.txt"), "side\n").unwrap();
    run_git(repo_dir.path(), &["commit", "-am", "side"]);
    run_git(repo_dir.path(), &["checkout", "main"]);
    fs::write(repo_dir.path().join("conflict.txt"), "main\n").unwrap();
    run_git(repo_dir.path(), &["commit", "-am", "main"]);
    run_git_expect_failure(repo_dir.path(), &["merge", "side"]);

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");
    let conflict = snapshot
        .files
        .iter()
        .find(|file| file.path == "conflict.txt")
        .expect("conflicted file");
    assert_tracked_change_count(repo_dir.path(), 1).await;

    assert_eq!(conflict.status, WorkspaceDiffFileStatus::Conflicted);
    assert!(matches!(
        &conflict.content,
        WorkspaceDiffContent::Text { patch } if patch.is_empty()
    ));
}

#[tokio::test]
async fn workspace_diff_port_scopes_parent_repository_paths_to_the_bound_workspace() {
    let repo_dir = TempRepoDir::new("workspace-diff-scope");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "tests@openbitfun.dev"],
    );
    fs::create_dir_all(repo_dir.path().join("scope[1]")).unwrap();
    fs::write(repo_dir.path().join("outside.txt"), "base\n").unwrap();
    fs::write(
        repo_dir.path().join("scope[1]").join("inside.txt"),
        "base\n",
    )
    .unwrap();
    run_git(repo_dir.path(), &["add", "."]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);

    fs::write(repo_dir.path().join("outside.txt"), "outside change\n").unwrap();
    fs::write(
        repo_dir.path().join("scope[1]").join("inside.txt"),
        "inside change\n",
    )
    .unwrap();
    fs::write(repo_dir.path().join("scope[1]").join("new.txt"), "new\n").unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path().join("scope[1]"))
        .workspace_diff()
        .await
        .expect("workspace diff");

    assert_eq!(
        snapshot
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["inside.txt", "new.txt"]
    );
}

#[tokio::test]
async fn workspace_diff_port_omits_large_text_before_building_a_patch() {
    let repo_dir = TempRepoDir::new("workspace-diff-large-text");
    run_git(repo_dir.path(), &["init"]);
    fs::write(
        repo_dir.path().join("large.txt"),
        "x".repeat(1024 * 1024 + 1),
    )
    .unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");
    let large = snapshot
        .files
        .iter()
        .find(|file| file.path == "large.txt")
        .expect("large file");

    assert_eq!(large.content, WorkspaceDiffContent::TooLarge);
    assert!(snapshot.truncated);
}

#[tokio::test]
async fn workspace_diff_port_stops_projecting_content_after_the_total_text_cap() {
    let repo_dir = TempRepoDir::new("workspace-diff-total-cap");
    run_git(repo_dir.path(), &["init"]);
    for name in ["a.txt", "b.txt", "c.txt", "d.txt"] {
        fs::write(repo_dir.path().join(name), "x".repeat(800 * 1024)).unwrap();
    }
    fs::write(repo_dir.path().join("z.bin"), [0, 1, 0, 2]).unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");

    assert!(snapshot.truncated);
    assert_eq!(
        snapshot
            .files
            .iter()
            .find(|file| file.path == "d.txt")
            .expect("first over-budget file")
            .content,
        WorkspaceDiffContent::TooLarge
    );
    assert_eq!(
        snapshot
            .files
            .iter()
            .find(|file| file.path == "z.bin")
            .expect("later file")
            .content,
        WorkspaceDiffContent::TooLarge
    );
}

#[tokio::test]
async fn workspace_diff_port_marks_binary_content_without_text_projection() {
    let repo_dir = TempRepoDir::new("workspace-diff-binary");
    run_git(repo_dir.path(), &["init"]);
    fs::write(repo_dir.path().join("binary.dat"), [0, 1, 2, 0, 3]).unwrap();

    let snapshot = GitWorkspaceDiffPort::new(repo_dir.path())
        .workspace_diff()
        .await
        .expect("workspace diff");
    let binary = snapshot
        .files
        .iter()
        .find(|file| file.path == "binary.dat")
        .expect("binary file");

    assert_eq!(binary.content, WorkspaceDiffContent::Binary);
}

#[test]
fn git_name_status_parser_preserves_nul_delimited_unicode_and_rename_paths() {
    let files = parse_name_status_output("M\0src/中文.rs\0R100\0old name.rs\0new name.rs\0");
    assert_eq!(
        files,
        vec![
            GitChangedFile {
                path: "src/中文.rs".to_string(),
                old_path: None,
                status: GitChangedFileStatus::Modified,
            },
            GitChangedFile {
                path: "new name.rs".to_string(),
                old_path: Some("old name.rs".to_string()),
                status: GitChangedFileStatus::Renamed,
            },
        ]
    );
}

#[test]
fn git_status_json_preserves_conflict_contract() {
    let status = GitStatus {
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
        conflicts: vec!["src/conflicted.rs".to_string()],
        current_branch: "main".to_string(),
        ahead: 0,
        behind: 0,
    };
    assert_eq!(
        serde_json::to_value(status).unwrap()["conflicts"],
        serde_json::json!(["src/conflicted.rs"])
    );
}

#[tokio::test]
async fn review_git_service_reads_exact_renamed_and_deleted_range_without_mutation() {
    let repo_dir = TempRepoDir::new("review-exact-range");
    run_git(repo_dir.path(), &["init"]);
    run_git(
        repo_dir.path(),
        &["config", "user.name", "OpenBitFun Tests"],
    );
    run_git(
        repo_dir.path(),
        &["config", "user.email", "openbitfun-tests@example.com"],
    );
    fs::write(
        repo_dir.path().join(".gitattributes"),
        "*.txt diff=reviewdriver\n",
    )
    .unwrap();
    fs::write(repo_dir.path().join("renamed.txt"), "before rename\n").unwrap();
    fs::write(repo_dir.path().join("deleted.txt"), "deleted content\n").unwrap();
    fs::write(
        repo_dir.path().join(" leading whitespace.txt"),
        "before whitespace\n",
    )
    .unwrap();
    run_git(repo_dir.path(), &["add", "."]);
    run_git(repo_dir.path(), &["commit", "-m", "base"]);
    let base = GitService::resolve_revision(repo_dir.path(), "HEAD")
        .await
        .unwrap();

    run_git(repo_dir.path(), &["mv", "renamed.txt", "moved.txt"]);
    run_git(repo_dir.path(), &["rm", "deleted.txt"]);
    fs::write(repo_dir.path().join("moved.txt"), "after rename\n").unwrap();
    fs::write(
        repo_dir.path().join(" leading whitespace.txt"),
        "after whitespace\n",
    )
    .unwrap();
    run_git(repo_dir.path(), &["add", "."]);
    run_git(repo_dir.path(), &["commit", "-m", "target"]);
    let head = GitService::resolve_revision(repo_dir.path(), "HEAD")
        .await
        .unwrap();

    run_git(
        repo_dir.path(),
        &[
            "config",
            "diff.external",
            "openbitfun-review-should-not-run",
        ],
    );
    run_git(
        repo_dir.path(),
        &[
            "config",
            "diff.reviewdriver.textconv",
            "openbitfun-review-should-not-run",
        ],
    );

    let diff = GitService::get_review_diff(
        repo_dir.path(),
        &base,
        &head,
        &[
            "renamed.txt".to_string(),
            "moved.txt".to_string(),
            "deleted.txt".to_string(),
            " leading whitespace.txt".to_string(),
        ],
    )
    .await
    .unwrap();
    assert!(diff.contains("moved.txt"));
    assert!(diff.contains("deleted.txt"));
    assert!(diff.contains("after rename"));
    assert!(diff.contains("after whitespace"));

    let generic_diff = GitService::get_diff(
        repo_dir.path(),
        &GitDiffParams {
            source: Some(base.clone()),
            target: Some(head.clone()),
            files: Some(vec!["moved.txt".to_string()]),
            staged: None,
            stat: None,
            review_safe: Some(true),
        },
    )
    .await
    .expect("generic read-only diff must ignore external diff and textconv helpers");
    assert!(generic_diff.contains("after rename"));

    let wildcard_diff =
        GitService::get_review_diff(repo_dir.path(), &base, &head, &["*.txt".to_string()])
            .await
            .unwrap();
    assert!(wildcard_diff.is_empty());

    let status = GitService::get_status(repo_dir.path()).await.unwrap();
    assert!(status.staged.is_empty());
    assert!(status.unstaged.is_empty());
    assert!(status.untracked.is_empty());
    assert!(status.conflicts.is_empty());
}

#[tokio::test]
async fn review_git_service_rejects_mutable_revisions_and_escaping_paths() {
    let repo_dir = TempRepoDir::new("review-input-boundary");

    let mutable_revision = GitService::get_review_diff(
        repo_dir.path(),
        "main",
        "feature",
        &["src/lib.rs".to_string()],
    )
    .await;
    assert!(mutable_revision.is_err());

    let escaping_path = GitService::get_review_diff(
        repo_dir.path(),
        &"1".repeat(40),
        &"2".repeat(40),
        &["../outside.rs".to_string()],
    )
    .await;
    assert!(escaping_path.is_err());

    let nul_path = GitService::get_review_diff(
        repo_dir.path(),
        &"1".repeat(40),
        &"2".repeat(40),
        &["src/nul\0path.rs".to_string()],
    )
    .await;
    assert!(
        matches!(nul_path, Err(GitError::InvalidPath(message)) if message.contains("workspace-relative"))
    );
}

struct TempRepoDir {
    path: std::path::PathBuf,
}

impl TempRepoDir {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "openbitfun-services-integrations-{}-{}-{}",
            name,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TempRepoDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn run_git(repo_dir: &std::path::Path, args: &[&str]) {
    let output = openbitfun_services_core::process_manager::create_command("git")
        .current_dir(repo_dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}{}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_git_expect_failure(repo_dir: &std::path::Path, args: &[&str]) {
    let output = openbitfun_services_core::process_manager::create_command("git")
        .current_dir(repo_dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "git {:?} unexpectedly succeeded",
        args
    );
}

#[test]
fn git_worktree_info_preserves_camel_case_contract() {
    let worktree = GitWorktreeInfo {
        path: "D:/workspace/OpenBitFun-worktree".to_string(),
        branch: Some("feature/test".to_string()),
        head: "abc123".to_string(),
        is_main: false,
        is_locked: true,
        is_prunable: false,
    };

    let value = serde_json::to_value(worktree).unwrap();
    assert_eq!(value["isMain"], false);
    assert_eq!(value["isLocked"], true);
    assert_eq!(value["isPrunable"], false);
}

#[test]
fn git_worktree_parser_preserves_porcelain_contract() {
    let worktrees = parse_worktree_list(
        "worktree D:/workspace/OpenBitFun\nHEAD abc123\nbranch refs/heads/main\n\nworktree D:/workspace/OpenBitFun-feature\nHEAD def456\nbranch refs/heads/feature/test\nlocked\nprunable\n",
    );

    assert_eq!(worktrees.len(), 2);
    assert_eq!(worktrees[0].path, "D:/workspace/OpenBitFun");
    assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
    assert_eq!(worktrees[0].head, "abc123");
    assert!(worktrees[0].is_main);
    assert!(!worktrees[0].is_locked);
    assert_eq!(worktrees[1].branch.as_deref(), Some("feature/test"));
    assert!(worktrees[1].is_locked);
    assert!(worktrees[1].is_prunable);
}

#[test]
fn git_commit_params_preserves_no_verify_rename_contract() {
    let params = GitCommitParams {
        message: "test commit".to_string(),
        amend: Some(false),
        all: Some(true),
        no_verify: Some(true),
        author: Some(GitAuthor {
            name: "OpenBitFun".to_string(),
            email: "openbitfun@example.com".to_string(),
        }),
    };

    let value = serde_json::to_value(params).unwrap();
    assert_eq!(value["noVerify"], true);
    assert!(value.get("no_verify").is_none());
}

#[test]
fn git_graph_contract_preserves_camel_case_contract() {
    let graph = GitGraph {
        nodes: vec![GraphNode {
            hash: "abc123".to_string(),
            message: "initial".to_string(),
            full_message: "initial commit".to_string(),
            author_name: "OpenBitFun".to_string(),
            author_email: "openbitfun@example.com".to_string(),
            timestamp: 1_700_000_000,
            parents: Vec::new(),
            children: vec!["def456".to_string()],
            refs: vec![GraphRef {
                name: "main".to_string(),
                ref_type: "branch".to_string(),
                is_current: true,
                is_head: true,
            }],
            lane: 0,
            forking_lanes: Vec::new(),
            merging_lanes: Vec::new(),
            passing_lanes: Vec::new(),
        }],
        max_lane: 1,
        current_branch: Some("main".to_string()),
    };

    let value = serde_json::to_value(graph).unwrap();
    assert_eq!(value["maxLane"], 1);
    assert_eq!(value["currentBranch"], "main");
    assert_eq!(value["nodes"][0]["fullMessage"], "initial commit");
    assert_eq!(value["nodes"][0]["refs"][0]["refType"], "branch");
    assert_eq!(value["nodes"][0]["refs"][0]["isCurrent"], true);
}
