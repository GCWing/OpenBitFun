use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tool_runtime::fs::{
    build_remote_delete_command, delete_local_path, edit_local_file, inspect_local_delete_target,
    write_local_file, DeleteLocalPathRequest, EditLocalFileRequest, LocalDeleteTarget,
    WriteLocalFileRequest, WriteLocalFileStatus,
};
use tool_runtime::search::glob_search::{
    build_remote_rg_command, collect_remote_glob_matches, collect_remote_glob_result,
    execute_local_glob, LocalGlobRequest,
};
use tool_runtime::search::grep_search::{apply_offset_and_limit, relativize_result_text};
use tool_runtime::shell::noninteractive_terminal_env;
use tool_runtime::util::string::shell_single_quote;

fn make_temp_dir(name: &str) -> PathBuf {
    static NEXT_TEMP_DIR_ID: AtomicU64 = AtomicU64::new(0);
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_nanos();
    // Clock resolution alone cannot distinguish parallel fixtures on every host.
    let sequence = NEXT_TEMP_DIR_ID.fetch_add(1, Ordering::Relaxed);
    let process_id = std::process::id();
    let dir = std::env::temp_dir().join(format!(
        "openbitfun-tool-io-{name}-{process_id}-{unique}-{sequence}"
    ));
    fs::create_dir(&dir).expect("isolated temp dir should be created");
    dir
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[test]
fn write_local_file_reports_created_overwritten_and_identical_retry() {
    let root = make_temp_dir("write");
    let target = root.join("nested").join("file.txt");

    let created = write_local_file(WriteLocalFileRequest {
        logical_path: "nested/file.txt".to_string(),
        resolved_path: target.clone(),
        content: "hello\nworld\n".to_string(),
    })
    .expect("write should create file");

    assert_eq!(created.status, WriteLocalFileStatus::Created);
    assert_eq!(created.bytes_written, "hello\nworld\n".len());
    assert_eq!(created.lines_written, 2);
    assert_eq!(
        fs::read_to_string(&target).expect("file should exist"),
        "hello\nworld\n"
    );

    let identical = write_local_file(WriteLocalFileRequest {
        logical_path: "nested/file.txt".to_string(),
        resolved_path: target.clone(),
        content: "hello\nworld\n".to_string(),
    })
    .expect("identical retry should be successful and idempotent");

    assert_eq!(
        identical.status,
        WriteLocalFileStatus::AlreadyExistsSameContent
    );
    assert_eq!(identical.bytes_written, 0);
    assert_eq!(identical.lines_written, 0);

    let overwritten = write_local_file(WriteLocalFileRequest {
        logical_path: "nested/file.txt".to_string(),
        resolved_path: target.clone(),
        content: "replacement".to_string(),
    })
    .expect("write should overwrite file");

    assert_eq!(overwritten.status, WriteLocalFileStatus::Overwritten);
    assert_eq!(
        fs::read_to_string(&target).expect("file should exist"),
        "replacement"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn edit_local_file_writes_apply_edit_result() {
    let root = make_temp_dir("edit");
    let target = root.join("file.txt");
    fs::write(&target, "alpha\nbeta\n").expect("file should be written");

    let outcome = edit_local_file(EditLocalFileRequest {
        logical_path: "file.txt".to_string(),
        resolved_path: target.clone(),
        old_string: "beta".to_string(),
        new_string: "BETA".to_string(),
        replace_all: false,
    })
    .expect("edit should succeed");

    assert_eq!(outcome.match_count, 1);
    assert_eq!(outcome.edit_result.start_line, 2);
    assert_eq!(
        fs::read_to_string(&target).expect("file should exist"),
        "alpha\nBETA\n"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn delete_local_path_inspection_and_execution_preserve_recursive_guard_facts() {
    let root = make_temp_dir("delete");
    let dir = root.join("dir");
    fs::create_dir_all(&dir).expect("dir should be created");
    fs::write(dir.join("child.txt"), "child").expect("child should be written");

    let target = inspect_local_delete_target(&dir).expect("target should inspect");
    assert_eq!(
        target,
        LocalDeleteTarget {
            exists: true,
            is_directory: true,
            is_empty: false,
        }
    );

    let deleted = delete_local_path(DeleteLocalPathRequest {
        logical_path: "dir".to_string(),
        resolved_path: dir.clone(),
        recursive: true,
    })
    .expect("recursive delete should succeed");

    assert!(deleted.is_directory);
    assert!(deleted.recursive);
    assert!(!dir.exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn execute_local_glob_keeps_shallowest_matches() {
    let root = make_temp_dir("glob");
    fs::create_dir_all(root.join("src").join("deep")).expect("dirs should be created");
    fs::create_dir_all(root.join("tests")).expect("dirs should be created");
    fs::write(root.join("Cargo.toml"), "").expect("file should be written");
    fs::write(root.join("src").join("lib.rs"), "").expect("file should be written");
    fs::write(root.join("src").join("deep").join("mod.rs"), "").expect("file should be written");
    fs::write(root.join("tests").join("mod.rs"), "").expect("file should be written");

    let result = execute_local_glob(LocalGlobRequest {
        search_path: root.clone(),
        pattern: "**/*.rs".to_string(),
        limit: 2,
    })
    .expect("glob should succeed");

    let matches = result
        .matches
        .iter()
        .map(|path| normalized(path))
        .collect::<Vec<_>>();
    assert_eq!(matches.len(), 2);
    assert_eq!(
        normalized(&result.walk_root),
        normalized(&dunce::canonicalize(&root).unwrap())
    );
    assert_eq!(result.total_matches, Some(3));
    assert!(result.truncated);
    assert!(matches.iter().any(|path| path == "src/lib.rs"));
    assert!(matches.iter().any(|path| path == "tests/mod.rs"));
    assert!(!matches.iter().any(|path| path == "src/deep/mod.rs"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn execute_local_glob_returns_matches_relative_to_derived_walk_root() {
    let root = make_temp_dir("glob-relative");
    fs::create_dir_all(root.join("src").join("deep")).expect("dirs should be created");
    fs::write(root.join("src").join("lib.rs"), "").expect("file should be written");
    fs::write(root.join("src").join("deep").join("mod.rs"), "").expect("file should be written");

    let result = execute_local_glob(LocalGlobRequest {
        search_path: root.clone(),
        pattern: "src/*.rs".to_string(),
        limit: 10,
    })
    .expect("glob should succeed");

    let matches = result
        .matches
        .iter()
        .map(|path| normalized(path))
        .collect::<Vec<_>>();
    assert_eq!(
        normalized(&result.walk_root),
        normalized(&dunce::canonicalize(root.join("src")).unwrap())
    );
    assert!(matches.iter().any(|path| path == "lib.rs"));
    assert!(matches.iter().any(|path| path == "deep/mod.rs"));
    assert!(matches.iter().all(|path| !path.starts_with("src/")));
    assert_eq!(result.total_matches, Some(2));
    assert!(!result.truncated);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn execute_local_glob_returns_empty_result_when_no_files_match() {
    let root = make_temp_dir("glob-empty");
    fs::create_dir_all(root.join("empty-dir")).expect("empty dir should be created");

    let result = execute_local_glob(LocalGlobRequest {
        search_path: root.clone(),
        pattern: "empty-dir/**/*".to_string(),
        limit: 10,
    })
    .expect("empty glob should not fail");

    assert!(result.matches.is_empty());
    assert_eq!(result.total_matches, Some(0));
    assert!(!result.truncated);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn remote_glob_stdout_is_normalized_and_limited_by_tool_runtime() {
    let matches =
        collect_remote_glob_matches("C:/repo", "./src/deep/mod.rs\nsrc/lib.rs\nREADME.md\n\n", 2)
            .into_iter()
            .map(|path| normalized(&path))
            .collect::<Vec<_>>();

    assert_eq!(matches, vec!["README.md", "src/lib.rs"]);
}

#[test]
fn remote_glob_result_reports_exact_or_unknown_truncation() {
    let exact = collect_remote_glob_result(
        "C:/repo",
        "./src/deep/mod.rs\nsrc/lib.rs\nREADME.md\n",
        2,
        true,
    );
    let exact_matches = exact
        .matches
        .iter()
        .map(|path| normalized(path))
        .collect::<Vec<_>>();
    assert_eq!(exact_matches, vec!["README.md", "src/lib.rs"]);
    assert_eq!(normalized(&exact.walk_root), "C:/repo");
    assert_eq!(exact.total_matches, Some(3));
    assert!(exact.truncated);

    let unknown = collect_remote_glob_result(
        "C:/repo",
        "./src/deep/mod.rs\nsrc/lib.rs\nREADME.md\n",
        2,
        false,
    );
    assert_eq!(unknown.total_matches, None);
    assert!(unknown.truncated);

    let unknown_complete =
        collect_remote_glob_result("C:/repo", "src/lib.rs\nREADME.md\n", 2, false);
    assert_eq!(unknown_complete.total_matches, Some(2));
    assert!(!unknown_complete.truncated);

    let remote_find = collect_remote_glob_result(
        "/home/user/repo/src",
        "/home/user/repo/src/deep/mod.rs\n/home/user/repo/src/lib.rs\n",
        10,
        false,
    );
    let remote_find_matches = remote_find
        .matches
        .iter()
        .map(|path| normalized(path))
        .collect::<Vec<_>>();
    assert_eq!(remote_find_matches, vec!["deep/mod.rs", "lib.rs"]);
    assert_eq!(remote_find.total_matches, Some(2));
    assert!(!remote_find.truncated);
}

#[test]
fn remote_glob_result_ignores_walk_root_self_match() {
    let result = collect_remote_glob_result(
        "/home/user/repo/empty",
        "/home/user/repo/empty\n",
        10,
        false,
    );

    assert!(result.matches.is_empty());
    assert_eq!(result.total_matches, Some(0));
    assert!(!result.truncated);

    let matches =
        collect_remote_glob_matches("/home/user/repo/empty", "/home/user/repo/empty\n", 10);
    assert!(matches.is_empty());
}

#[test]
fn remote_glob_commands_preprocess_static_pattern_prefix() {
    let rg_command = build_remote_rg_command("/home/user/repo", "src/*.rs");
    assert!(
        rg_command.starts_with(
            "(cd '/home/user/repo/src' || exit 2; rg --no-config --files --null --glob '*.rs'"
        ),
        "{rg_command}"
    );
    assert!(!rg_command.contains("--no-ignore"));
    assert!(!rg_command.contains("--hidden"));
    assert!(!rg_command.contains("--sort"));

    let openbitfun_rg_command = build_remote_rg_command("/home/user/repo", ".openbitfun/**/*.json");
    assert!(openbitfun_rg_command.contains("--no-ignore"));
    assert!(openbitfun_rg_command.contains("--hidden"));
    assert!(!openbitfun_rg_command.contains("--sort"));
}

#[test]
fn shell_single_quote_preserves_existing_remote_escape_style() {
    assert_eq!(shell_single_quote("C:/repo/a'b"), "'C:/repo/a'\\''b'");
}

#[test]
fn noninteractive_terminal_env_preserves_agent_session_contract() {
    let env = noninteractive_terminal_env();
    assert_eq!(
        env.get("OPENBITFUN_NONINTERACTIVE").map(String::as_str),
        Some("1")
    );
    assert_eq!(env.get("GIT_PAGER").map(String::as_str), Some("cat"));
    assert_eq!(env.get("PAGER").map(String::as_str), Some("cat"));
    assert_eq!(
        env.get("GIT_TERMINAL_PROMPT").map(String::as_str),
        Some("0")
    );
    assert_eq!(env.get("GIT_EDITOR").map(String::as_str), Some("true"));
}

#[test]
fn remote_delete_command_preserves_existing_recursive_flag_and_escaping() {
    assert_eq!(
        build_remote_delete_command("/repo/a'b.txt", false),
        "rm -f '/repo/a'\\''b.txt'"
    );
    assert_eq!(
        build_remote_delete_command("/repo/a'b", true),
        "rm -rf '/repo/a'\\''b'"
    );
}

#[cfg(unix)]
#[test]
fn remote_glob_missing_scope_is_an_error_and_rg_no_match_is_success() {
    let root = make_temp_dir("remote-glob-scope");
    let missing = root.join("missing").to_string_lossy().into_owned();
    let output = std::process::Command::new("sh")
        .args(["-c", &build_remote_rg_command(&missing, "*.rs")])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(
        tool_runtime::search::glob_search::validate_remote_glob_exit(
            2,
            &String::from_utf8_lossy(&output.stderr)
        )
        .is_err()
    );
    assert!(tool_runtime::search::glob_search::validate_remote_glob_exit(1, "").is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn grep_result_windowing_can_be_applied_outside_core() {
    let mut items = vec![
        "one".to_string(),
        "two".to_string(),
        "three".to_string(),
        "four".to_string(),
    ];

    apply_offset_and_limit(&mut items, 1, Some(2));
    assert_eq!(items, vec!["two", "three"]);

    let text = "C:/repo/src/main.rs:1:one\nC:/repo/src/lib.rs:2:two";
    assert_eq!(
        relativize_result_text(text, Some("C:/repo")),
        "src/main.rs:1:one\nsrc/lib.rs:2:two"
    );
}
