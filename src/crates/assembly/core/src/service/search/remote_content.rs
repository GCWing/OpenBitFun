//! Interactive content search for remote workspaces.
//!
//! Flashgrep only ships for the host platform, so the search box cannot use it for a
//! remote root. This runs the same workspace-stream search as the agent Grep tool
//! through the workspace's own file and shell providers: target `rg` or `grep` select
//! candidate files when available, and the native matcher produces every result. It
//! never touches the controller filesystem, so failures reach the caller as errors.

use openbitfun_services_core::filesystem::FileSearchOutcome;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// One remote content search routed to an already-resolved workspace connection.
pub struct RemoteContentSearch {
    pub connection_id: String,
    pub root_path: String,
    pub pattern: String,
    pub case_sensitive: bool,
    pub use_regex: bool,
    pub whole_word: bool,
    pub limit: usize,
    pub cancel_flag: Option<Arc<AtomicBool>>,
}

#[cfg(all(feature = "ssh-remote", feature = "agent-runtime"))]
pub async fn search_remote_workspace_contents(
    search: RemoteContentSearch,
) -> Result<FileSearchOutcome, String> {
    use crate::service::remote_ssh::workspace_state::get_remote_workspace_manager;

    let manager = get_remote_workspace_manager()
        .ok_or_else(|| "remote workspace state is not initialized".to_string())?;
    let ssh_manager = manager
        .get_ssh_manager()
        .await
        .ok_or_else(|| "the SSH connection manager is not available".to_string())?;
    let file_service = manager
        .get_file_service()
        .await
        .ok_or_else(|| "the remote file service is not available".to_string())?;
    let root_path = crate::service::remote_ssh::normalize_remote_workspace_path(&search.root_path);
    let services = openbitfun_services_integrations::remote_ssh::remote_workspace_services(
        search.connection_id.clone(),
        file_service,
        ssh_manager,
        root_path.clone(),
    );
    enabled::search_through_providers(
        services.fs.as_ref(),
        services.shell.as_ref(),
        &RemoteContentSearch {
            root_path,
            ..search
        },
    )
    .await
}

#[cfg(not(all(feature = "ssh-remote", feature = "agent-runtime")))]
pub async fn search_remote_workspace_contents(
    _search: RemoteContentSearch,
) -> Result<FileSearchOutcome, String> {
    Err("remote content search is not compiled into this OpenBitFun host".to_string())
}

#[cfg(all(feature = "ssh-remote", feature = "agent-runtime"))]
mod enabled {
    use super::RemoteContentSearch;
    use openbitfun_runtime_ports::{
        WorkspaceCommandOptions, WorkspaceFileSystem, WorkspacePathKind, WorkspaceShell,
    };
    use openbitfun_services_core::filesystem::{
        compile_content_search_regex, ContentMatchPreviewBuilder, FileSearchOutcome,
        FileSearchResult, SearchMatchType, CONTENT_SEARCH_BINARY_SUFFIXES,
        CONTENT_SEARCH_MAX_FILE_BYTES, CONTENT_SEARCH_SKIPPED_DIRECTORIES,
        CONTENT_SEARCH_SKIPPED_FILE_NAMES,
    };
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tool_runtime::search::grep_search::{
        content_search_candidate_literal, grep_search_workspace, GrepOptions,
        InteractiveSearchPolicy, OutputMode, SearchCancellation, WorkspaceGrepLineMatch,
    };

    /// A provider scan over a slow link must end in a visible state instead of a
    /// spinner: the person can narrow the query, and cancelling stays available.
    const SEARCH_TIMEOUT: Duration = Duration::from_secs(120);
    const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(100);

    fn local_search_policy() -> InteractiveSearchPolicy {
        let owned = |values: &[&str]| values.iter().map(|value| value.to_string()).collect();
        InteractiveSearchPolicy {
            excluded_directories: owned(CONTENT_SEARCH_SKIPPED_DIRECTORIES),
            excluded_file_names: owned(CONTENT_SEARCH_SKIPPED_FILE_NAMES),
            excluded_file_suffixes: owned(CONTENT_SEARCH_BINARY_SUFFIXES),
            max_file_size_bytes: Some(CONTENT_SEARCH_MAX_FILE_BYTES),
        }
    }

    /// The walker does not traverse a symlinked directory root, and a relative root would
    /// mean something different after the shell's own `cd` into it. The workspace shell
    /// already runs inside the root, so it can report the physical directory.
    async fn resolve_search_root(
        fs: &dyn WorkspaceFileSystem,
        shell: &dyn WorkspaceShell,
        root: &str,
    ) -> Result<String, String> {
        let is_symlink = root.starts_with('/')
            && fs
                .metadata(root, false)
                .await
                .map_err(|error| format!("Failed to inspect {root}: {error:#}"))?
                .is_some_and(|metadata| metadata.kind == WorkspacePathKind::Symlink);
        if root.starts_with('/') && !is_symlink {
            return Ok(root.to_string());
        }
        let result = shell
            .exec_with_options(
                "pwd -P",
                WorkspaceCommandOptions {
                    timeout_ms: Some(30_000),
                    cancellation_token: None,
                },
            )
            .await
            .map_err(|error| format!("Failed to resolve workspace root {root}: {error:#}"))?;
        let resolved = result.stdout.trim_end_matches(['\r', '\n']);
        if result.exit_code != 0 || !resolved.starts_with('/') {
            return Err(format!(
                "Failed to resolve workspace root {root}: {}",
                result.stderr.trim()
            ));
        }
        Ok(resolved.to_string())
    }

    /// Callers know the workspace by its logical root, so a symlinked root keeps that
    /// spelling in results. A relative root stays physical: it could not be opened anyway.
    fn rebase_result_path(path: String, resolved_root: &str, root: &str) -> String {
        if resolved_root == root || !root.starts_with('/') {
            return path;
        }
        match path.strip_prefix(&format!("{}/", resolved_root.trim_end_matches('/'))) {
            Some(relative) => format!("{}/{relative}", root.trim_end_matches('/')),
            None => path,
        }
    }

    pub(super) async fn search_through_providers(
        fs: &dyn WorkspaceFileSystem,
        shell: &dyn WorkspaceShell,
        search: &RemoteContentSearch,
    ) -> Result<FileSearchOutcome, String> {
        let matcher = compile_content_search_regex(
            &search.pattern,
            search.case_sensitive,
            search.use_regex,
            search.whole_word,
        )
        .map_err(|error| format!("Invalid search pattern: {error}"))?;
        let preview = ContentMatchPreviewBuilder::new(
            &search.pattern,
            search.case_sensitive,
            search.use_regex,
            search.whole_word,
        )
        .map_err(|error| error.to_string())?;

        let resolved_root = resolve_search_root(fs, shell, &search.root_path).await?;
        let cancellation = SearchCancellation::new();
        let options = GrepOptions::new(matcher.as_str(), resolved_root.clone())
            .case_insensitive(!search.case_sensitive)
            .output_mode(OutputMode::Content)
            .show_line_numbers(true)
            .head_limit(search.limit)
            .candidate_literal(content_search_candidate_literal(
                &search.pattern,
                search.case_sensitive,
                search.use_regex,
            ))
            .interactive(local_search_policy())
            .cancellation(cancellation.clone());

        let found = tokio::select! {
            found = tokio::time::timeout(
                SEARCH_TIMEOUT,
                grep_search_workspace(options, fs, Some(shell)),
            ) => found,
            _ = forward_cancellation(search, &cancellation) => unreachable!("never completes"),
        }
        .map_err(|_| {
            format!(
                "the search did not finish within {} seconds; try a more specific search",
                SEARCH_TIMEOUT.as_secs()
            )
        })??;

        if found.skipped_path_count > 0 {
            log::warn!(
                "Remote content search skipped {} unreadable paths under {}",
                found.skipped_path_count,
                search.root_path
            );
        }
        let mut outcome = build_outcome(found.line_matches, search.limit, &preview);
        for result in &mut outcome.results {
            result.path = rebase_result_path(
                std::mem::take(&mut result.path),
                &resolved_root,
                &search.root_path,
            );
        }
        Ok(outcome)
    }

    /// Bridges the Tauri cancel flag to the search token, then waits for the search
    /// itself to wind down so readers and shell commands get released in order.
    async fn forward_cancellation(
        search: &RemoteContentSearch,
        cancellation: &SearchCancellation,
    ) -> std::convert::Infallible {
        if let Some(flag) = search.cancel_flag.as_ref() {
            while !flag.load(Ordering::Relaxed) {
                tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
            }
            cancellation.cancel();
        }
        std::future::pending().await
    }

    fn build_outcome(
        line_matches: Vec<WorkspaceGrepLineMatch>,
        limit: usize,
        preview: &ContentMatchPreviewBuilder,
    ) -> FileSearchOutcome {
        let mut results: Vec<_> = line_matches
            .into_iter()
            .map(|line| content_result(line, preview))
            .collect();
        let truncated = results.len() > limit;
        results.truncate(limit);
        FileSearchOutcome { results, truncated }
    }

    fn content_result(
        line: WorkspaceGrepLineMatch,
        preview: &ContentMatchPreviewBuilder,
    ) -> FileSearchResult {
        let (preview_before, preview_inside, preview_after) = preview.preview(&line.text);
        FileSearchResult {
            // Remote paths are POSIX on every client OS, so no host path parsing here.
            name: line
                .path
                .rsplit('/')
                .next()
                .unwrap_or(&line.path)
                .to_string(),
            path: line.path,
            is_directory: false,
            match_type: SearchMatchType::Content,
            line_number: Some(line.line_number),
            matched_content: Some(line.text),
            preview_before,
            preview_inside,
            preview_after,
        }
    }

    #[cfg(all(test, unix))]
    mod tests {
        use super::*;
        use async_trait::async_trait;
        use openbitfun_runtime_ports::{
            WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry,
        };
        use openbitfun_services_core::workspace::{LocalWorkspaceFs, LocalWorkspaceShell};
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        use std::sync::{Arc, Mutex};

        fn request(root: &str, pattern: &str) -> RemoteContentSearch {
            RemoteContentSearch {
                connection_id: "test-connection".to_string(),
                root_path: root.to_string(),
                pattern: pattern.to_string(),
                case_sensitive: false,
                use_regex: false,
                whole_word: false,
                limit: 100,
                cancel_flag: None,
            }
        }

        fn fixture() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::create_dir_all(root.join(".git")).unwrap();
            std::fs::create_dir_all(root.join("ignored")).unwrap();
            std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
            std::fs::write(root.join("src/a:1:b.txt"), "first\nThe Needle here\n").unwrap();
            std::fs::write(root.join("src/other.txt"), "nothing to see\n").unwrap();
            std::fs::write(root.join("ignored/hit.txt"), "needle\n").unwrap();
            std::fs::write(root.join(".git/hit.txt"), "needle\n").unwrap();
            dir
        }

        fn root_of(dir: &tempfile::TempDir) -> String {
            dir.path().to_string_lossy().into_owned()
        }

        /// Models a server without `rg`, and optionally without any usable `grep`.
        struct TargetShell {
            local: LocalWorkspaceShell,
            has_grep: bool,
            commands: Mutex<Vec<String>>,
        }

        impl TargetShell {
            fn new(root: &str, has_grep: bool) -> Self {
                Self {
                    local: LocalWorkspaceShell::new(root.to_string()),
                    has_grep,
                    commands: Mutex::new(Vec::new()),
                }
            }

            fn ran_recursive_grep(&self) -> bool {
                self.commands
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|command| command.contains("command grep -r"))
            }
        }

        #[async_trait]
        impl WorkspaceShell for TargetShell {
            async fn exec_with_options(
                &self,
                command: &str,
                options: WorkspaceCommandOptions,
            ) -> anyhow::Result<WorkspaceCommandResult> {
                self.commands.lock().unwrap().push(command.to_string());
                if command.contains("command rg ") || !self.has_grep {
                    return Ok(WorkspaceCommandResult {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: 127,
                        interrupted: false,
                        timed_out: false,
                    });
                }
                self.local.exec_with_options(command, options).await
            }
        }

        /// Counts file reads on top of the real tree, and can fail like a lost connection.
        struct TargetFs {
            local: LocalWorkspaceFs,
            opened: AtomicUsize,
            fail_listing: AtomicBool,
        }

        impl Default for TargetFs {
            fn default() -> Self {
                Self {
                    local: LocalWorkspaceFs,
                    opened: AtomicUsize::new(0),
                    fail_listing: AtomicBool::new(false),
                }
            }
        }

        #[async_trait]
        impl WorkspaceFileSystem for TargetFs {
            async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
                self.local.read_file(path).await
            }
            async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
                self.local.read_file_text(path).await
            }
            async fn read_file_text_bounded(
                &self,
                path: &str,
                max_bytes: usize,
            ) -> anyhow::Result<Option<String>> {
                self.local.read_file_text_bounded(path, max_bytes).await
            }
            async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()> {
                self.local.write_file(path, contents).await
            }
            async fn exists(&self, path: &str) -> anyhow::Result<bool> {
                self.local.exists(path).await
            }
            async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
                self.local.is_file(path).await
            }
            async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
                self.local.is_dir(path).await
            }
            async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
                if self.fail_listing.load(Ordering::Relaxed) {
                    anyhow::bail!("connection lost");
                }
                self.local.read_dir(path).await
            }
            async fn metadata(
                &self,
                path: &str,
                follow_symlinks: bool,
            ) -> anyhow::Result<Option<openbitfun_runtime_ports::WorkspaceMetadata>> {
                self.local.metadata(path, follow_symlinks).await
            }
            async fn open_read(
                &self,
                path: &str,
            ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceReader> {
                self.opened.fetch_add(1, Ordering::Relaxed);
                self.local.open_read(path).await
            }
        }

        #[tokio::test]
        async fn server_without_rg_selects_candidates_with_case_folded_grep() {
            let dir = fixture();
            let root = root_of(&dir);
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert!(shell.ran_recursive_grep());
            // Only the one reachable candidate is streamed, not `other.txt`.
            assert_eq!(fs.opened.load(Ordering::Relaxed), 1);
            assert!(!outcome.truncated);
            assert_eq!(outcome.results.len(), 1);
            let hit = &outcome.results[0];
            assert_eq!(hit.path, format!("{root}/src/a:1:b.txt"));
            assert_eq!(hit.name, "a:1:b.txt");
            assert_eq!(hit.line_number, Some(2));
            assert_eq!(hit.matched_content.as_deref(), Some("The Needle here"));
            assert_eq!(hit.preview_inside.as_deref(), Some("Needle"));
        }

        #[tokio::test]
        async fn server_with_rg_selects_candidates_with_case_folded_rg() {
            let dir = fixture();
            let root = root_of(&dir);
            let shell = LocalWorkspaceShell::new(root.clone());
            let has_rg = shell
                .exec("command -v rg >/dev/null 2>&1", Some(1000))
                .await
                .unwrap()
                .2
                == 0;
            if !has_rg {
                return;
            }
            let fs = TargetFs::default();

            let outcome = search_through_providers(&fs, &shell, &request(&root, "NEEDLE"))
                .await
                .unwrap();

            assert_eq!(fs.opened.load(Ordering::Relaxed), 1);
            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].line_number, Some(2));
        }

        #[tokio::test]
        async fn server_without_any_prefilter_still_searches_through_the_provider() {
            let dir = fixture();
            let root = root_of(&dir);
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, false);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
            assert!(fs.opened.load(Ordering::Relaxed) > 1);
        }

        #[tokio::test]
        async fn literal_case_and_word_options_keep_local_search_semantics() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            std::fs::write(
                dir.path().join("a.txt"),
                "version a.b here\nversion axb here\nNEEDLES\nneedle\nNeedle\n",
            )
            .unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);
            let lines = |outcome: FileSearchOutcome| {
                outcome
                    .results
                    .iter()
                    .map(|result| result.line_number.unwrap())
                    .collect::<Vec<_>>()
            };

            // A metacharacter stays literal instead of acting as a regex wildcard.
            let literal = search_through_providers(&fs, &shell, &request(&root, "a.b"))
                .await
                .unwrap();
            assert_eq!(lines(literal), vec![1]);

            let mut sensitive = request(&root, "Needle");
            sensitive.case_sensitive = true;
            let sensitive = search_through_providers(&fs, &shell, &sensitive)
                .await
                .unwrap();
            assert_eq!(lines(sensitive), vec![5]);

            let mut word = request(&root, "needle");
            word.whole_word = true;
            let word = search_through_providers(&fs, &shell, &word).await.unwrap();
            assert_eq!(lines(word), vec![4, 5]);

            let mut regex = request(&root, "version a.b");
            regex.use_regex = true;
            let regex = search_through_providers(&fs, &shell, &regex).await.unwrap();
            assert_eq!(lines(regex), vec![1, 2]);
        }

        #[tokio::test]
        async fn limit_reports_truncation_and_stops_reading_more_files() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            for index in 0..20 {
                std::fs::write(dir.path().join(format!("{index}.txt")), "needle\nneedle\n")
                    .unwrap();
            }
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);
            let mut search = request(&root, "needle");
            search.limit = 3;

            let outcome = search_through_providers(&fs, &shell, &search)
                .await
                .unwrap();

            assert!(outcome.truncated);
            assert_eq!(outcome.results.len(), 3);
            assert!(fs.opened.load(Ordering::Relaxed) < 20);
        }

        #[tokio::test]
        async fn lost_connection_is_an_error_even_when_local_files_could_answer() {
            let dir = fixture();
            let root = root_of(&dir);
            let fs = TargetFs::default();
            fs.fail_listing.store(true, Ordering::Relaxed);
            let shell = TargetShell::new(&root, false);

            let error = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap_err();

            assert!(error.contains("connection lost"), "{error}");
        }

        #[tokio::test]
        async fn invalid_regex_is_reported_before_any_remote_work() {
            let dir = fixture();
            let root = root_of(&dir);
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);
            let mut search = request(&root, "(unclosed");
            search.use_regex = true;

            let error = search_through_providers(&fs, &shell, &search)
                .await
                .unwrap_err();

            assert!(error.contains("Invalid search pattern"), "{error}");
            assert!(shell.commands.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn dangling_symlink_does_not_fail_the_search() {
            let dir = fixture();
            let root = root_of(&dir);
            std::os::unix::fs::symlink(dir.path().join("gone"), dir.path().join("dangling"))
                .unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
        }

        #[tokio::test]
        async fn binary_files_are_left_out_of_the_result_list() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            std::fs::write(dir.path().join("blob"), b"\0needle\0\n").unwrap();
            std::fs::write(dir.path().join("text"), "needle\n").unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].name, "text");
        }

        #[tokio::test]
        async fn binary_files_do_not_consume_the_result_budget() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            std::fs::write(dir.path().join("a-blob"), b"\0needle\nneedle\nneedle\n").unwrap();
            std::fs::write(dir.path().join("b-text"), "needle\n").unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);
            let mut search = request(&root, "needle");
            search.limit = 1;

            let outcome = search_through_providers(&fs, &shell, &search)
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].name, "b-text");
            assert!(!outcome.truncated);
        }

        #[tokio::test]
        async fn utf16_file_with_bom_is_text_not_binary() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            let mut bytes = vec![0xFF, 0xFE];
            bytes.extend("a needle\n".encode_utf16().flat_map(u16::to_le_bytes));
            std::fs::write(dir.path().join("wide.txt"), bytes).unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
        }

        #[tokio::test]
        async fn local_exclusions_apply_to_size_suffix_and_directories() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
            std::fs::write(dir.path().join("node_modules/pkg/a.js"), "needle\n").unwrap();
            std::fs::write(dir.path().join("image.PNG"), "needle\n").unwrap();
            std::fs::write(dir.path().join(".DS_Store"), "needle\n").unwrap();
            let oversized = "needle\n".repeat(CONTENT_SEARCH_MAX_FILE_BYTES as usize / 7 + 1);
            std::fs::write(dir.path().join("huge.txt"), oversized).unwrap();
            std::fs::write(dir.path().join("kept.txt"), "needle\n").unwrap();
            for has_grep in [true, false] {
                let fs = TargetFs::default();
                let shell = TargetShell::new(&root, has_grep);

                let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                    .await
                    .unwrap();

                assert_eq!(outcome.results.len(), 1, "has_grep={has_grep}");
                assert_eq!(outcome.results[0].name, "kept.txt");
            }
        }

        #[tokio::test]
        async fn repository_exclude_file_applies_at_the_workspace_root() {
            let dir = fixture();
            let root = root_of(&dir);
            std::fs::create_dir_all(dir.path().join(".git/info")).unwrap();
            std::fs::write(dir.path().join(".git/info/exclude"), "*.local\n").unwrap();
            std::fs::write(dir.path().join("settings.local"), "needle\n").unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].name, "a:1:b.txt");
        }

        #[tokio::test]
        async fn match_past_the_agent_column_cap_still_renders() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            let line = format!("{}needle tail", "x".repeat(800));
            std::fs::write(dir.path().join("min.js"), format!("{line}\n")).unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            let hit = &outcome.results[0];
            assert_eq!(hit.matched_content.as_deref(), Some(line.as_str()));
            assert_eq!(hit.preview_inside.as_deref(), Some("needle"));
        }

        #[tokio::test]
        async fn crlf_lines_match_end_anchors_and_lose_the_carriage_return() {
            let dir = tempfile::tempdir().unwrap();
            let root = root_of(&dir);
            std::fs::write(dir.path().join("dos.txt"), "foo\r\nbar foo tail\r\n").unwrap();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);
            let mut search = request(&root, "foo$");
            search.use_regex = true;

            let outcome = search_through_providers(&fs, &shell, &search)
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].line_number, Some(1));
            assert_eq!(outcome.results[0].matched_content.as_deref(), Some("foo"));
            assert_eq!(outcome.results[0].preview_inside.as_deref(), Some("foo"));
        }

        #[tokio::test]
        async fn symlinked_root_is_searched_and_keeps_its_logical_paths() {
            let dir = fixture();
            let real = root_of(&dir);
            let links = tempfile::tempdir().unwrap();
            let link = links.path().join("workspace");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let root = link.to_string_lossy().into_owned();
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);

            let outcome = search_through_providers(&fs, &shell, &request(&root, "needle"))
                .await
                .unwrap();

            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].path, format!("{root}/src/a:1:b.txt"));
        }

        /// Answers every candidate command with one fixed status and no candidates.
        struct FailingCandidateShell {
            exit_code: i32,
        }

        #[async_trait]
        impl WorkspaceShell for FailingCandidateShell {
            async fn exec_with_options(
                &self,
                _command: &str,
                _options: WorkspaceCommandOptions,
            ) -> anyhow::Result<WorkspaceCommandResult> {
                Ok(WorkspaceCommandResult {
                    stdout: "OPENBITFUN_RG_CANDIDATES_BEGIN\0OPENBITFUN_RG_CANDIDATES_END\0"
                        .to_string(),
                    stderr: "rg: repo: No such file or directory".to_string(),
                    exit_code: self.exit_code,
                    interrupted: false,
                    timed_out: false,
                })
            }
        }

        #[tokio::test]
        async fn failed_candidate_command_scans_instead_of_reporting_no_results() {
            let dir = fixture();
            let root = root_of(&dir);
            let fs = TargetFs::default();

            let outcome = search_through_providers(
                &fs,
                &FailingCandidateShell { exit_code: 2 },
                &request(&root, "needle"),
            )
            .await
            .unwrap();

            assert_eq!(outcome.results.len(), 1);
        }

        #[tokio::test]
        async fn unreadable_and_vanished_files_are_skipped_but_transport_errors_are_not() {
            let dir = fixture();
            let root = root_of(&dir);
            std::fs::write(dir.path().join("src/locked.txt"), "needle\n").unwrap();
            std::fs::write(dir.path().join("src/gone.txt"), "needle\n").unwrap();

            let fs = RefusingFs {
                inner: TargetFs::default(),
                message: |path| match path {
                    path if path.ends_with("locked.txt") => Some("Permission denied"),
                    path if path.ends_with("gone.txt") => Some("No such file"),
                    _ => None,
                },
            };
            // Regex mode has no candidate literal, so it reaches every file.
            let mut search = request(&root, "needle");
            search.use_regex = true;
            let outcome = search_through_providers(&fs, &TargetShell::new(&root, false), &search)
                .await
                .unwrap();
            assert_eq!(outcome.results.len(), 1);
            assert_eq!(outcome.results[0].name, "a:1:b.txt");

            let fs = RefusingFs {
                inner: TargetFs::default(),
                message: |path| path.ends_with("locked.txt").then_some("connection lost"),
            };
            let error = search_through_providers(&fs, &TargetShell::new(&root, false), &search)
                .await
                .unwrap_err();
            assert!(error.contains("connection lost"), "{error}");
        }

        /// Fails opening selected files, as a target would for that path.
        struct RefusingFs {
            inner: TargetFs,
            message: fn(&str) -> Option<&'static str>,
        }

        #[async_trait]
        impl WorkspaceFileSystem for RefusingFs {
            async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
                self.inner.read_file(path).await
            }
            async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
                self.inner.read_file_text(path).await
            }
            async fn read_file_text_bounded(
                &self,
                path: &str,
                max_bytes: usize,
            ) -> anyhow::Result<Option<String>> {
                self.inner.read_file_text_bounded(path, max_bytes).await
            }
            async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()> {
                self.inner.write_file(path, contents).await
            }
            async fn exists(&self, path: &str) -> anyhow::Result<bool> {
                self.inner.exists(path).await
            }
            async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
                self.inner.is_file(path).await
            }
            async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
                self.inner.is_dir(path).await
            }
            async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
                self.inner.read_dir(path).await
            }
            async fn metadata(
                &self,
                path: &str,
                follow_symlinks: bool,
            ) -> anyhow::Result<Option<openbitfun_runtime_ports::WorkspaceMetadata>> {
                self.inner.metadata(path, follow_symlinks).await
            }
            async fn open_read(
                &self,
                path: &str,
            ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceReader> {
                if let Some(message) = (self.message)(path) {
                    anyhow::bail!("{message}");
                }
                self.inner.open_read(path).await
            }
        }

        #[tokio::test]
        async fn cancel_flag_stops_a_pending_search() {
            let dir = fixture();
            let root = root_of(&dir);
            let fs = TargetFs::default();
            let shell = TargetShell::new(&root, true);
            let mut search = request(&root, "needle");
            search.cancel_flag = Some(Arc::new(AtomicBool::new(true)));

            let outcome = tokio::time::timeout(
                Duration::from_secs(30),
                search_through_providers(&fs, &shell, &search),
            )
            .await
            .expect("cancelled search must finish")
            .unwrap();

            assert!(outcome.results.len() <= 1);
        }
    }
}
