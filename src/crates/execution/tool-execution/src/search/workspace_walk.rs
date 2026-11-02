use openbitfun_runtime_ports::{WorkspaceDirEntry, WorkspaceFileSystem};
use std::collections::VecDeque;

#[derive(Clone)]
pub(crate) struct DirectoryIgnore {
    depth: usize,
    override_gitignore: bool,
    rules: super::workspace_ignore::WorkspaceIgnoreRules,
}

pub(crate) async fn add_directory_ignores(
    fs: &dyn WorkspaceFileSystem,
    entries: &[openbitfun_runtime_ports::WorkspaceDirEntry],
    depth: usize,
    rules: &mut Vec<DirectoryIgnore>,
) -> Result<(), String> {
    // At the same directory, .ignore overrides .gitignore, as in ignore's walker.
    for name in [".gitignore", ".ignore"] {
        if let Some(entry) = entries
            .iter()
            .find(|entry| entry.name == name && !entry.is_dir && !entry.is_symlink)
        {
            let text = fs
                .read_file_text_bounded(&entry.path, 1024 * 1024)
                .await
                .map_err(|error| format!("Failed to read {}: {error}", entry.path))?
                .ok_or_else(|| format!("Ignore file exceeds 1048576 bytes: {}", entry.path))?;
            rules.push(DirectoryIgnore {
                depth,
                override_gitignore: name == ".ignore",
                rules: super::workspace_ignore::WorkspaceIgnoreRules::parse(&text)
                    .map_err(|error| format!("Invalid ignore file {}: {error}", entry.path))?,
            });
        }
    }
    Ok(())
}

pub(crate) struct WorkspaceWalkFile {
    pub entry: WorkspaceDirEntry,
    pub relative_path: String,
}

/// Streams file candidates without buffering a complete workspace listing.
/// Ignore files and filenames use provider-relative POSIX components.
pub(crate) struct WorkspaceFileWalker<'a> {
    fs: &'a dyn WorkspaceFileSystem,
    pending: VecDeque<(String, Vec<String>, Vec<DirectoryIgnore>)>,
    entries: std::vec::IntoIter<WorkspaceDirEntry>,
    components: Vec<String>,
    ignores: Vec<DirectoryIgnore>,
    base_depth: usize,
    hide_hidden: bool,
    apply_ignore: bool,
    include_symlink_entries: bool,
    excluded_directories: Vec<String>,
    skip_unreadable_directories: bool,
    skipped_directories: usize,
}

/// Rules from the repository-level exclude file. They rank below every `.gitignore`
/// because ignores apply in order. Only a workspace rooted at its repository has one
/// here: linked worktrees, parent repositories and global excludes are not consulted.
pub(crate) async fn git_info_exclude_ignores(
    fs: &dyn WorkspaceFileSystem,
    root: &str,
) -> Vec<DirectoryIgnore> {
    let path = format!("{}/.git/info/exclude", root.trim_end_matches('/'));
    match fs.read_file_text_bounded(&path, 1024 * 1024).await {
        Ok(Some(text)) => super::workspace_ignore::WorkspaceIgnoreRules::parse(&text)
            .map(|rules| {
                vec![DirectoryIgnore {
                    depth: 0,
                    override_gitignore: false,
                    rules,
                }]
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// True for a per-path refusal from the target. Anything else, such as a lost
/// connection, says nothing about the path and has to stay fatal to the search.
pub(crate) fn is_per_path_read_failure(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "permission denied",
        "access denied",
        "no such file",
        "not a readable regular file",
    ]
    .iter()
    .any(|refusal| message.contains(refusal))
}

impl<'a> WorkspaceFileWalker<'a> {
    pub(crate) fn with_scope(
        fs: &'a dyn WorkspaceFileSystem,
        root: String,
        prefix: Vec<String>,
        ignores: Vec<DirectoryIgnore>,
        hide_hidden: bool,
        apply_ignore: bool,
    ) -> Self {
        let base_depth = prefix.len();
        Self {
            fs,
            pending: VecDeque::from([(root, prefix, ignores)]),
            entries: Vec::new().into_iter(),
            components: Vec::new(),
            ignores: Vec::new(),
            base_depth,
            hide_hidden,
            apply_ignore,
            include_symlink_entries: false,
            excluded_directories: Vec::new(),
            skip_unreadable_directories: false,
            skipped_directories: 0,
        }
    }

    /// Prune directories by name and pass over those the target refuses to list.
    pub(crate) fn with_interactive_policy(mut self, excluded_directories: Vec<String>) -> Self {
        self.excluded_directories = excluded_directories;
        self.skip_unreadable_directories = true;
        self
    }

    pub(crate) fn skipped_directories(&self) -> usize {
        self.skipped_directories
    }

    /// Let consumers inspect final symlink targets without ever following a
    /// linked directory during traversal. Grep preserves native file-link reads;
    /// callers with no-follow policies leave this disabled.
    pub(crate) fn with_symlink_entries(mut self) -> Self {
        self.include_symlink_entries = true;
        self
    }

    pub(crate) async fn next(&mut self) -> Result<Option<WorkspaceWalkFile>, String> {
        loop {
            if let Some(entry) = self.entries.next() {
                if (entry.is_symlink && !self.include_symlink_entries)
                    || [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"].contains(&entry.name.as_str())
                    || (self.hide_hidden && entry.name.starts_with('.'))
                {
                    continue;
                }
                let mut components = self.components.clone();
                components.push(entry.name.clone());
                let mut ignored = false;
                for override_gitignore in [false, true] {
                    for scope in self
                        .ignores
                        .iter()
                        .filter(|scope| scope.override_gitignore == override_gitignore)
                    {
                        if let Some(decision) = scope
                            .rules
                            .matched(&components[scope.depth..].join("/"), entry.is_dir)
                        {
                            ignored = decision;
                        }
                    }
                }
                if ignored {
                    continue;
                }
                if entry.is_dir && !entry.is_symlink {
                    if self.excluded_directories.contains(&entry.name) {
                        continue;
                    }
                    self.pending
                        .push_back((entry.path, components, self.ignores.clone()));
                    continue;
                }
                return Ok(Some(WorkspaceWalkFile {
                    entry,
                    relative_path: components[self.base_depth..].join("/"),
                }));
            }
            let Some((path, components, mut ignores)) = self.pending.pop_front() else {
                return Ok(None);
            };
            let entries = match self.fs.read_dir(&path).await {
                Ok(entries) => entries,
                Err(error)
                    if self.skip_unreadable_directories
                        && is_per_path_read_failure(&format!("{error:#}")) =>
                {
                    log::warn!("Workspace search skipped unreadable directory {path}: {error:#}");
                    self.skipped_directories += 1;
                    continue;
                }
                Err(error) => return Err(format!("Failed to list {path}: {error}")),
            };
            if self.apply_ignore {
                if let Err(error) =
                    add_directory_ignores(self.fs, &entries, components.len(), &mut ignores).await
                {
                    if !(self.skip_unreadable_directories && is_per_path_read_failure(&error)) {
                        return Err(error);
                    }
                    log::warn!("Workspace search ignored an unreadable ignore file: {error}");
                }
            }
            self.entries = entries.into_iter();
            self.components = components;
            self.ignores = ignores;
        }
    }
}
