use globset::{GlobBuilder, GlobMatcher};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncReadExt;

use crate::instruction_scope::{parse_instruction_path_scope, InstructionPathScope};
use crate::jsonc::strip_jsonc;

pub const WORKSPACE_INSTRUCTION_FILE_NAMES: [&str; 5] = [
    "AGENTS.override.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/CLAUDE.md",
    "CLAUDE.local.md",
];

const AGENTS_INSTRUCTION_FILE_GROUP: &[&str] = &["AGENTS.override.md", "AGENTS.md"];
const CLAUDE_INSTRUCTION_FILE_GROUP: &[&str] = &["CLAUDE.md", ".claude/CLAUDE.md"];
const CLAUDE_LOCAL_INSTRUCTION_FILE: &str = "CLAUDE.local.md";
const CLAUDE_RULES_DIRECTORY: &str = ".claude/rules";
const OPENCODE_PROJECT_CONFIG_FILES: &[&str] = &[
    "opencode.json",
    "opencode.jsonc",
    ".opencode/opencode.json",
    ".opencode/opencode.jsonc",
];
const MAX_CLAUDE_IMPORT_DEPTH: usize = 5;
const MAX_INSTRUCTION_FILES: usize = 256;
const MAX_INSTRUCTION_FILE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES: usize = 2 * 1024 * 1024;
const MAX_SCANNED_ENTRIES: usize = 4096;
const RECURSIVE_SCAN_IGNORED_DIRECTORIES: &[&str] =
    &[".git", ".hg", ".svn", "node_modules", "target"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInstructionFile {
    pub name: String,
    pub content: String,
    /// Empty means startup context; non-empty patterns defer the document
    /// until a matching workspace file is read.
    pub path_patterns: Vec<String>,
}

/// Metadata from the same resolver used by context injection. Shared AGENTS
/// documents have no single upstream owner.
pub struct WorkspaceInstructionSource {
    pub file: WorkspaceInstructionFile,
    pub ecosystem_id: &'static str,
}

pub struct WorkspaceInstructionSourceCatalog {
    pub sources: Vec<WorkspaceInstructionSource>,
    pub incomplete_ecosystems: Vec<&'static str>,
}

/// Compiled workspace-relative path scope owned alongside declarative
/// instruction glob expansion. Consumers do not need a direct glob dependency.
pub struct WorkspaceInstructionPathMatcher {
    matchers: Vec<GlobMatcher>,
}

impl WorkspaceInstructionPathMatcher {
    pub fn compile(patterns: &[String], source_name: &str) -> Option<Self> {
        let matchers = patterns
            .iter()
            .filter_map(|pattern| {
                let Some(pattern) = normalize_instruction_scope_glob(pattern) else {
                    log::warn!(
                        "Ignoring non-relative conditional instruction pattern in {source_name}: {pattern}"
                    );
                    return None;
                };
                match GlobBuilder::new(&pattern)
                    .literal_separator(true)
                    .backslash_escape(true)
                    .build()
                {
                    Ok(glob) => Some(glob.compile_matcher()),
                    Err(error) => {
                        log::warn!(
                            "Ignoring invalid conditional instruction pattern in {source_name}: {error}"
                        );
                        None
                    }
                }
            })
            .collect::<Vec<_>>();
        (!matchers.is_empty()).then_some(Self { matchers })
    }

    pub fn is_match(&self, workspace_relative_path: &str) -> bool {
        self.matchers
            .iter()
            .any(|matcher| matcher.is_match(workspace_relative_path))
    }
}

/// Keeps the first physical local file across a preceding source set and the
/// workspace-relative files resolved by this owner.
pub fn retain_distinct_local_workspace_instruction_files(
    workspace_root: &Path,
    preceding_canonical_paths: impl IntoIterator<Item = PathBuf>,
    files: &mut Vec<WorkspaceInstructionFile>,
) {
    let mut seen = preceding_canonical_paths
        .into_iter()
        .collect::<HashSet<_>>();
    files.retain(|file| {
        std::fs::canonicalize(workspace_root.join(&file.name))
            .map(|path| seen.insert(path))
            .unwrap_or(true)
    });
}

#[derive(Debug, Clone)]
struct InstructionDirEntry {
    relative_path: String,
    is_dir: bool,
    is_symlink: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstructionEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

enum InstructionIo<'a> {
    Local(&'a Path),
    #[cfg(feature = "workspace-runtime")]
    Port {
        fs: &'a dyn openbitfun_runtime_ports::WorkspaceFileSystem,
        root: &'a str,
    },
}

impl InstructionIo<'_> {
    async fn is_file(&self, relative_path: &str) -> Result<bool, String> {
        match self {
            Self::Local(root) => Ok(spawn_local_entry_kind(root, relative_path)
                .await
                .map_err(|error| format!("Failed to inspect local instruction path: {error}"))?
                .is_some_and(|kind| kind == InstructionEntryKind::File)),
            #[cfg(feature = "workspace-runtime")]
            Self::Port { fs, root } => {
                Ok(
                    port_entry_kind(*fs, (*root).to_string(), relative_path.to_string())
                        .await?
                        .is_some_and(|kind| kind == InstructionEntryKind::File),
                )
            }
        }
    }

    async fn is_dir(&self, relative_path: &str) -> Result<bool, String> {
        match self {
            Self::Local(root) => Ok(spawn_local_entry_kind(root, relative_path)
                .await
                .map_err(|error| format!("Failed to inspect local instruction path: {error}"))?
                .is_some_and(|kind| kind == InstructionEntryKind::Directory)),
            #[cfg(feature = "workspace-runtime")]
            Self::Port { fs, root } => {
                if relative_path.is_empty() {
                    let path = join_workspace_path(root, relative_path);
                    return fs.is_dir(&path).await.map_err(|error| {
                        format!("Failed to inspect workspace instruction directory {path}: {error}")
                    });
                }
                let path = join_workspace_path(root, relative_path);
                port_entry_kind(*fs, (*root).to_string(), relative_path.to_string())
                    .await
                    .map(|entry| entry.is_some_and(|kind| kind == InstructionEntryKind::Directory))
                    .map_err(|error| {
                        format!("Failed to inspect workspace instruction directory {path}: {error}")
                    })
            }
        }
    }

    async fn read_text(&self, relative_path: &str) -> Result<Option<String>, String> {
        match self {
            Self::Local(root) => {
                let path = spawn_resolved_local_file(root, relative_path)
                    .await
                    .map_err(|error| {
                        format!("Failed to validate local instruction path: {error}")
                    })?
                    .ok_or_else(|| {
                        format!(
                            "Rejected workspace instruction path outside the workspace: {relative_path}"
                        )
                    })?;
                let metadata = fs::metadata(&path).await.map_err(|error| {
                    format!(
                        "Failed to inspect instruction file {}: {}",
                        path.display(),
                        error
                    )
                })?;
                if metadata.len() > MAX_INSTRUCTION_FILE_BYTES as u64 {
                    return Ok(None);
                }
                let mut bytes = Vec::with_capacity(metadata.len() as usize);
                fs::File::open(&path)
                    .await
                    .map_err(|error| {
                        format!(
                            "Failed to open workspace instruction file {}: {}",
                            path.display(),
                            error
                        )
                    })?
                    .take(MAX_INSTRUCTION_FILE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|error| {
                        format!(
                            "Failed to read workspace instruction file {}: {}",
                            path.display(),
                            error
                        )
                    })?;
                if bytes.len() > MAX_INSTRUCTION_FILE_BYTES {
                    return Ok(None);
                }
                String::from_utf8(bytes).map(Some).map_err(|error| {
                    format!(
                        "Workspace instruction file is not valid UTF-8 {}: {}",
                        path.display(),
                        error
                    )
                })
            }
            #[cfg(feature = "workspace-runtime")]
            Self::Port { fs, root } => {
                let path = join_workspace_path(root, relative_path);
                fs.read_file_text_bounded(&path, MAX_INSTRUCTION_FILE_BYTES)
                    .await
                    .map_err(|error| {
                        format!("Failed to read workspace instruction file {path}: {error}")
                    })
            }
        }
    }

    async fn read_dir(
        &self,
        relative_path: &str,
        max_entries: usize,
    ) -> Result<Vec<InstructionDirEntry>, String> {
        match self {
            Self::Local(root) => {
                let path = local_path(root, relative_path);
                let mut entries = fs::read_dir(&path).await.map_err(|error| {
                    format!(
                        "Failed to read workspace instruction directory {}: {}",
                        path.display(),
                        error
                    )
                })?;
                let mut output = Vec::new();
                while output.len() < max_entries {
                    let Some(entry) = entries.next_entry().await.map_err(|error| {
                        format!(
                            "Failed to read workspace instruction directory {}: {}",
                            path.display(),
                            error
                        )
                    })?
                    else {
                        break;
                    };
                    let file_type = entry.file_type().await.map_err(|error| {
                        format!(
                            "Failed to inspect workspace instruction entry {}: {}",
                            entry.path().display(),
                            error
                        )
                    })?;
                    let name = entry.file_name().to_string_lossy().to_string();
                    output.push(InstructionDirEntry {
                        relative_path: join_relative_path(relative_path, &name),
                        is_dir: file_type.is_dir(),
                        is_symlink: file_type.is_symlink(),
                    });
                }
                Ok(output)
            }
            #[cfg(feature = "workspace-runtime")]
            Self::Port { fs, root } => {
                let path = join_workspace_path(root, relative_path);
                let entries = fs
                    .read_dir_bounded(&path, max_entries)
                    .await
                    .map_err(|error| {
                        format!("Failed to read workspace instruction directory {path}: {error}")
                    })?;
                Ok(entries
                    .into_iter()
                    .filter_map(|entry| {
                        port_entry_relative_path(root, relative_path, &entry.path).map(
                            |relative_path| InstructionDirEntry {
                                relative_path,
                                is_dir: entry.is_dir,
                                is_symlink: entry.is_symlink,
                            },
                        )
                    })
                    .collect())
            }
        }
    }
}

struct WorkspaceInstructionResolver<'a> {
    io: InstructionIo<'a>,
    files: Vec<WorkspaceInstructionFile>,
    origins: Vec<&'static str>,
    ecosystem_id: &'static str,
    incomplete_ecosystems: HashSet<&'static str>,
    seen: HashSet<String>,
    read_file_count: usize,
    total_instruction_bytes: usize,
    scanned_entries: usize,
    scan_limit_logged: bool,
    file_limit_logged: bool,
    byte_limit_logged: bool,
}

impl<'a> WorkspaceInstructionResolver<'a> {
    fn new(io: InstructionIo<'a>) -> Self {
        Self {
            io,
            files: Vec::new(),
            origins: Vec::new(),
            ecosystem_id: "shared",
            incomplete_ecosystems: HashSet::new(),
            seen: HashSet::new(),
            read_file_count: 0,
            total_instruction_bytes: 0,
            scanned_entries: 0,
            scan_limit_logged: false,
            file_limit_logged: false,
            byte_limit_logged: false,
        }
    }

    async fn resolve(self) -> Result<Vec<WorkspaceInstructionFile>, String> {
        Ok(self.resolve_sources().await?.files)
    }

    async fn resolve_sources(mut self) -> Result<Self, String> {
        self.resolve_agents_or_claude_sources().await?;
        if !self.files.is_empty() {
            return Ok(self);
        }

        self.ecosystem_id = "opencode";
        for config_path in OPENCODE_PROJECT_CONFIG_FILES {
            self.append_opencode_config_instructions(config_path)
                .await?;
        }

        Ok(self)
    }

    async fn resolve_agents_or_claude_sources(&mut self) -> Result<(), String> {
        if let Some((path, content)) = self.first_non_empty(AGENTS_INSTRUCTION_FILE_GROUP).await? {
            self.append_source_tree_with_content(path, false, Some(content))
                .await?;
            return Ok(());
        }
        self.ecosystem_id = "claude-code";
        if let Some((path, content)) = self.first_non_empty(CLAUDE_INSTRUCTION_FILE_GROUP).await? {
            self.append_source_tree_with_content(path, true, Some(content))
                .await?;
        }
        if self.io.is_file(CLAUDE_LOCAL_INSTRUCTION_FILE).await? {
            self.append_source_tree(CLAUDE_LOCAL_INSTRUCTION_FILE.to_string(), true)
                .await?;
        }

        self.append_claude_rules().await
    }

    async fn resolve_conditional(mut self) -> Result<Vec<WorkspaceInstructionFile>, String> {
        // Use the startup family selection here too, so a successful Read
        // cannot reactivate Claude rules suppressed by AGENTS instructions.
        // OpenCode has no conditional rules and need not be discovered here.
        self.resolve_agents_or_claude_sources().await?;
        Ok(self
            .files
            .into_iter()
            .filter(|file| !file.path_patterns.is_empty())
            .collect())
    }

    async fn append_claude_rules(&mut self) -> Result<(), String> {
        self.ecosystem_id = "claude-code";
        let rules = self.collect_files(CLAUDE_RULES_DIRECTORY).await?;
        for rule in rules
            .into_iter()
            .filter(|path| path.to_ascii_lowercase().ends_with(".md"))
        {
            if self.seen.contains(&rule) {
                continue;
            }
            let Some(content) = self.read_instruction_text(&rule).await? else {
                continue;
            };
            match parse_instruction_path_scope(&content) {
                Ok(InstructionPathScope::Unscoped) => {
                    self.append_source_tree_with_content(rule, true, Some(content))
                        .await?;
                }
                Ok(InstructionPathScope::Scoped { paths, body }) => {
                    self.seen.insert(rule.clone());
                    let content = self.expand_scoped_rule_imports(&rule, body).await?;
                    if !content.trim().is_empty() {
                        self.origins.push(self.ecosystem_id);
                        self.files.push(WorkspaceInstructionFile {
                            name: rule,
                            content,
                            path_patterns: paths,
                        });
                    }
                }
                Err(error) => {
                    self.seen.insert(rule);
                    self.incomplete_ecosystems.insert("claude-code");
                    log::warn!("Ignoring invalid Claude Code rule front matter: {error}");
                }
            }
        }
        Ok(())
    }

    async fn first_non_empty(
        &mut self,
        candidates: &[&str],
    ) -> Result<Option<(String, String)>, String> {
        for candidate in candidates {
            if self.io.is_file(candidate).await? {
                if let Some(content) = self.read_instruction_text(candidate).await? {
                    return Ok(Some(((*candidate).to_string(), content)));
                }
            }
        }
        Ok(None)
    }

    async fn read_instruction_text(
        &mut self,
        relative_path: &str,
    ) -> Result<Option<String>, String> {
        if self.read_file_count >= MAX_INSTRUCTION_FILES {
            if !self.file_limit_logged {
                log::warn!("Workspace instruction file limit reached; ignoring additional files");
                self.file_limit_logged = true;
            }
            return Ok(None);
        }
        if self.total_instruction_bytes >= MAX_TOTAL_INSTRUCTION_BYTES {
            if !self.byte_limit_logged {
                log::warn!("Workspace instruction byte limit reached; ignoring additional files");
                self.byte_limit_logged = true;
            }
            return Ok(None);
        }

        self.read_file_count += 1;
        if !self.io.is_file(relative_path).await? {
            return Ok(None);
        }
        let Some(content) = self.io.read_text(relative_path).await? else {
            if !self.byte_limit_logged {
                log::warn!(
                    "Ignoring a workspace instruction file larger than the per-file byte limit"
                );
                self.byte_limit_logged = true;
            }
            return Ok(None);
        };
        if content.trim().is_empty() {
            return Ok(None);
        }
        if self.total_instruction_bytes.saturating_add(content.len()) > MAX_TOTAL_INSTRUCTION_BYTES
        {
            self.total_instruction_bytes = MAX_TOTAL_INSTRUCTION_BYTES;
            if !self.byte_limit_logged {
                log::warn!("Workspace instruction byte limit reached; ignoring additional files");
                self.byte_limit_logged = true;
            }
            return Ok(None);
        }
        self.total_instruction_bytes += content.len();
        Ok(Some(content))
    }

    async fn append_source_tree(
        &mut self,
        relative_path: String,
        follow_claude_imports: bool,
    ) -> Result<(), String> {
        self.append_source_tree_with_content(relative_path, follow_claude_imports, None)
            .await
    }

    async fn append_source_tree_with_content(
        &mut self,
        relative_path: String,
        follow_claude_imports: bool,
        initial_content: Option<String>,
    ) -> Result<(), String> {
        let mut pending = vec![(relative_path, 0usize, initial_content)];
        while let Some((path, depth, prefetched_content)) = pending.pop() {
            if self.seen.contains(&path) {
                continue;
            }
            self.seen.insert(path.clone());
            let content = match prefetched_content {
                Some(content) => Some(content),
                None => self.read_instruction_text(&path).await?,
            };
            let Some(content) = content else { continue };
            let imports = if follow_claude_imports && depth < MAX_CLAUDE_IMPORT_DEPTH {
                claude_import_paths(&path, &content)
            } else {
                Vec::new()
            };
            if !content.trim().is_empty() {
                self.origins.push(self.ecosystem_id);
                self.files.push(WorkspaceInstructionFile {
                    name: path.clone(),
                    content,
                    path_patterns: Vec::new(),
                });
            }

            pending.extend(
                imports
                    .into_iter()
                    .rev()
                    .map(|import| (import, depth + 1, None)),
            );
        }
        Ok(())
    }

    async fn expand_scoped_rule_imports(
        &mut self,
        rule_path: &str,
        body: String,
    ) -> Result<String, String> {
        let mut expanded = body;
        let mut seen = HashSet::from([rule_path.to_string()]);
        let mut pending = claude_import_paths(rule_path, &expanded)
            .into_iter()
            .rev()
            .map(|path| (path, 1usize))
            .collect::<Vec<_>>();

        while let Some((path, depth)) = pending.pop() {
            if !seen.insert(path.clone()) {
                continue;
            }
            let Some(content) = self.read_instruction_text(&path).await? else {
                continue;
            };
            let imports = if depth < MAX_CLAUDE_IMPORT_DEPTH {
                claude_import_paths(&path, &content)
            } else {
                Vec::new()
            };
            if !content.trim().is_empty() {
                expanded.push_str("\n\n");
                expanded.push_str(content.trim());
                expanded.push('\n');
            }
            pending.extend(imports.into_iter().rev().map(|import| (import, depth + 1)));
        }
        Ok(expanded)
    }

    async fn append_opencode_config_instructions(
        &mut self,
        config_path: &str,
    ) -> Result<(), String> {
        if !self.io.is_file(config_path).await? {
            return Ok(());
        }

        let Some(content) = self.io.read_text(config_path).await? else {
            self.incomplete_ecosystems.insert("opencode");
            log::warn!(
                "Ignoring oversized project OpenCode instruction config {}",
                config_path
            );
            return Ok(());
        };
        if content.trim().is_empty() {
            return Ok(());
        }
        let value = match serde_json::from_str::<Value>(&strip_jsonc(&content)) {
            Ok(value) => value,
            Err(error) => {
                self.incomplete_ecosystems.insert("opencode");
                log::warn!(
                    "Ignoring invalid project OpenCode instruction config {}: {}",
                    config_path,
                    error
                );
                return Ok(());
            }
        };
        let Some(instructions) = value.get("instructions").and_then(Value::as_array) else {
            return Ok(());
        };

        for raw in instructions.iter().filter_map(Value::as_str) {
            if unsupported_instruction_reference(raw) {
                self.incomplete_ecosystems.insert("opencode");
                continue;
            }
            if has_glob_meta(raw) {
                for path in self.expand_glob(raw).await? {
                    self.append_source_tree(path, false).await?;
                }
            } else if let Some(path) = normalize_relative_path(raw) {
                self.append_source_tree(path, false).await?;
            }
        }
        Ok(())
    }

    async fn expand_glob(&mut self, raw_pattern: &str) -> Result<Vec<String>, String> {
        let Some(pattern) = normalize_glob_pattern(raw_pattern) else {
            return Ok(Vec::new());
        };
        let glob = match GlobBuilder::new(&pattern)
            .literal_separator(true)
            .backslash_escape(false)
            .build()
        {
            Ok(glob) => glob.compile_matcher(),
            Err(error) => {
                log::warn!(
                    "Ignoring invalid project OpenCode instruction glob {}: {}",
                    raw_pattern,
                    error
                );
                return Ok(Vec::new());
            }
        };
        let prefix = glob_static_prefix(&pattern);
        let mut matches = self
            .collect_files(&prefix)
            .await?
            .into_iter()
            .filter(|path| glob.is_match(path))
            .collect::<Vec<_>>();
        matches.sort();
        matches.dedup();
        Ok(matches)
    }

    async fn collect_files(&mut self, relative_root: &str) -> Result<Vec<String>, String> {
        if !self.io.is_dir(relative_root).await? {
            return Ok(Vec::new());
        }

        let mut files = Vec::new();
        let mut pending = vec![relative_root.to_string()];
        while let Some(directory) = pending.pop() {
            let remaining = MAX_SCANNED_ENTRIES.saturating_sub(self.scanned_entries);
            if remaining == 0 {
                if !self.scan_limit_logged {
                    log::warn!(
                        "Workspace instruction scan limit reached; ignoring additional entries"
                    );
                    self.scan_limit_logged = true;
                }
                break;
            }
            let mut entries = self.io.read_dir(&directory, remaining).await?;
            self.scanned_entries += entries.len();
            entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            for entry in entries.into_iter().rev() {
                if entry.is_symlink {
                    continue;
                }
                if entry.is_dir {
                    if recursive_scan_ignores(&entry.relative_path) {
                        continue;
                    }
                    pending.push(entry.relative_path);
                } else {
                    files.push(entry.relative_path);
                }
            }
        }
        files.sort();
        Ok(files)
    }
}

pub async fn read_workspace_instruction_files(
    workspace_root: &Path,
) -> Result<Vec<WorkspaceInstructionFile>, String> {
    Ok(read_workspace_instruction_sources(workspace_root)
        .await?
        .into_iter()
        .filter(|file| file.path_patterns.is_empty())
        .collect())
}

pub async fn read_workspace_instruction_sources(
    workspace_root: &Path,
) -> Result<Vec<WorkspaceInstructionFile>, String> {
    WorkspaceInstructionResolver::new(InstructionIo::Local(workspace_root))
        .resolve()
        .await
}

pub async fn read_workspace_instruction_source_catalog(
    workspace_root: &Path,
) -> Result<WorkspaceInstructionSourceCatalog, String> {
    let resolver = WorkspaceInstructionResolver::new(InstructionIo::Local(workspace_root))
        .resolve_sources()
        .await?;
    let mut incomplete_ecosystems = resolver.incomplete_ecosystems;
    if resolver.scan_limit_logged || resolver.file_limit_logged || resolver.byte_limit_logged {
        incomplete_ecosystems.insert("shared");
    }
    let mut incomplete_ecosystems = incomplete_ecosystems.into_iter().collect::<Vec<_>>();
    incomplete_ecosystems.sort();
    Ok(WorkspaceInstructionSourceCatalog {
        incomplete_ecosystems,
        sources: resolver
            .files
            .into_iter()
            .zip(resolver.origins)
            .map(|(file, ecosystem_id)| WorkspaceInstructionSource { file, ecosystem_id })
            .collect(),
    })
}

pub async fn read_workspace_conditional_instruction_sources(
    workspace_root: &Path,
) -> Result<Vec<WorkspaceInstructionFile>, String> {
    WorkspaceInstructionResolver::new(InstructionIo::Local(workspace_root))
        .resolve_conditional()
        .await
}

#[cfg(feature = "workspace-runtime")]
pub async fn read_workspace_instruction_files_with_fs(
    fs: &dyn openbitfun_runtime_ports::WorkspaceFileSystem,
    workspace_root: &str,
) -> Result<Vec<WorkspaceInstructionFile>, String> {
    Ok(
        read_workspace_instruction_sources_with_fs(fs, workspace_root)
            .await?
            .into_iter()
            .filter(|file| file.path_patterns.is_empty())
            .collect(),
    )
}

#[cfg(feature = "workspace-runtime")]
pub async fn read_workspace_instruction_sources_with_fs(
    fs: &dyn openbitfun_runtime_ports::WorkspaceFileSystem,
    workspace_root: &str,
) -> Result<Vec<WorkspaceInstructionFile>, String> {
    WorkspaceInstructionResolver::new(InstructionIo::Port {
        fs,
        root: workspace_root,
    })
    .resolve()
    .await
}

#[cfg(feature = "workspace-runtime")]
pub async fn read_workspace_conditional_instruction_sources_with_fs(
    fs: &dyn openbitfun_runtime_ports::WorkspaceFileSystem,
    workspace_root: &str,
) -> Result<Vec<WorkspaceInstructionFile>, String> {
    WorkspaceInstructionResolver::new(InstructionIo::Port {
        fs,
        root: workspace_root,
    })
    .resolve_conditional()
    .await
}

fn local_path(root: &Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .filter(|component| !component.is_empty())
        .fold(root.to_path_buf(), |path, component| path.join(component))
}

fn spawn_local_entry_kind(
    root: &Path,
    relative_path: &str,
) -> tokio::task::JoinHandle<Option<InstructionEntryKind>> {
    let root = root.to_path_buf();
    let relative_path = relative_path.to_string();
    tokio::task::spawn_blocking(move || local_entry_kind(&root, &relative_path))
}

fn spawn_resolved_local_file(
    root: &Path,
    relative_path: &str,
) -> tokio::task::JoinHandle<Option<PathBuf>> {
    let root = root.to_path_buf();
    let relative_path = relative_path.to_string();
    tokio::task::spawn_blocking(move || resolved_local_file(&root, &relative_path))
}

fn resolved_local_file(root: &Path, relative_path: &str) -> Option<PathBuf> {
    let root = std::fs::canonicalize(root).ok()?;
    let path = local_path(&root, relative_path);
    if !std::fs::symlink_metadata(&path).ok()?.file_type().is_file() {
        return None;
    }
    let path = std::fs::canonicalize(path).ok()?;
    path.starts_with(&root).then_some(path)
}

fn local_entry_kind(root: &Path, relative_path: &str) -> Option<InstructionEntryKind> {
    let mut path = root.to_path_buf();
    let mut components = relative_path
        .split('/')
        .filter(|component| !component.is_empty())
        .peekable();
    if components.peek().is_none() {
        let file_type = std::fs::symlink_metadata(root).ok()?.file_type();
        return Some(instruction_entry_kind(file_type));
    }

    while let Some(component) = components.next() {
        path.push(component);
        let file_type = std::fs::symlink_metadata(&path).ok()?.file_type();
        if components.peek().is_none() {
            return Some(instruction_entry_kind(file_type));
        }
        if !file_type.is_dir() || file_type.is_symlink() {
            return None;
        }
    }
    None
}

fn instruction_entry_kind(file_type: std::fs::FileType) -> InstructionEntryKind {
    if file_type.is_symlink() {
        InstructionEntryKind::Symlink
    } else if file_type.is_dir() {
        InstructionEntryKind::Directory
    } else if file_type.is_file() {
        InstructionEntryKind::File
    } else {
        InstructionEntryKind::Other
    }
}

fn join_relative_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

#[cfg(feature = "workspace-runtime")]
fn join_workspace_path(workspace_root: &str, relative_path: &str) -> String {
    let root = workspace_root.trim_end_matches(['/', '\\']);
    if relative_path.is_empty() {
        return root.to_string();
    }
    let separator = if root.contains('\\') && !root.contains('/') {
        '\\'
    } else {
        '/'
    };
    let relative_path = if separator == '\\' {
        relative_path.replace('/', "\\")
    } else {
        relative_path.to_string()
    };
    format!("{root}{separator}{relative_path}")
}

#[cfg(feature = "workspace-runtime")]
fn port_entry_relative_path(root: &str, parent: &str, entry_path: &str) -> Option<String> {
    let normalized_root = root.replace('\\', "/").trim_end_matches('/').to_string();
    let normalized_entry = entry_path.replace('\\', "/");
    let root_prefix = format!("{normalized_root}/");
    if let Some(relative) = normalized_entry.strip_prefix(&root_prefix) {
        return normalize_relative_path(relative);
    }
    let name = normalized_entry.rsplit('/').next()?;
    normalize_relative_path(&join_relative_path(parent, name))
}

#[cfg(feature = "workspace-runtime")]
async fn port_entry_kind(
    fs: &dyn openbitfun_runtime_ports::WorkspaceFileSystem,
    root: String,
    relative_path: String,
) -> Result<Option<InstructionEntryKind>, String> {
    use openbitfun_runtime_ports::WorkspacePathKind;

    let mut current = String::new();
    let components: Vec<String> = relative_path
        .split('/')
        .filter(|component| !component.is_empty())
        .map(str::to_string)
        .collect();
    for (index, component) in components.iter().enumerate() {
        current = join_relative_path(&current, component);
        let path = join_workspace_path(&root, &current);
        let Some(kind) = fs.path_kind_no_follow(&path).await.map_err(|error| {
            format!("Failed to inspect workspace instruction entry {relative_path}: {error}")
        })?
        else {
            return Ok(None);
        };

        if index + 1 == components.len() {
            return Ok(Some(match kind {
                WorkspacePathKind::File => InstructionEntryKind::File,
                WorkspacePathKind::Directory => InstructionEntryKind::Directory,
                WorkspacePathKind::Symlink => InstructionEntryKind::Symlink,
                WorkspacePathKind::Other => InstructionEntryKind::Other,
            }));
        }
        if kind != WorkspacePathKind::Directory {
            return Ok(None);
        }
    }
    Ok(None)
}

fn unsupported_instruction_reference(value: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with('~')
        || value.starts_with('/')
        || value.starts_with('\\')
        || has_windows_drive_component(value)
}

fn has_windows_drive_component(value: &str) -> bool {
    value.replace('\\', "/").split('/').any(|component| {
        let bytes = component.as_bytes();
        bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    })
}

fn normalize_relative_path(value: &str) -> Option<String> {
    if unsupported_instruction_reference(value) {
        return None;
    }
    let mut components = Vec::new();
    for component in value.trim().replace('\\', "/").split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            _ => components.push(component.to_string()),
        }
    }
    (!components.is_empty()).then(|| components.join("/"))
}

fn normalize_glob_pattern(value: &str) -> Option<String> {
    if unsupported_instruction_reference(value) {
        return None;
    }
    let normalized = value.trim().replace('\\', "/");
    let components = normalized
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>();
    if components.is_empty() || components.contains(&"..") {
        return None;
    }
    Some(components.join("/"))
}

fn normalize_instruction_scope_glob(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value.strip_prefix("./").unwrap_or(value);
    if value.is_empty()
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with('~')
        || value.starts_with('/')
        || value.starts_with("\\\\")
        || has_windows_drive_component(value)
        || value.split('/').any(|component| component == "..")
    {
        return None;
    }
    Some(value.to_string())
}

fn has_glob_meta(value: &str) -> bool {
    value.contains(['*', '?', '[', '{'])
}

fn glob_static_prefix(pattern: &str) -> String {
    pattern
        .split('/')
        .take_while(|component| !has_glob_meta(component))
        .collect::<Vec<_>>()
        .join("/")
}

fn recursive_scan_ignores(relative_path: &str) -> bool {
    relative_path.rsplit('/').next().is_some_and(|name| {
        RECURSIVE_SCAN_IGNORED_DIRECTORIES
            .iter()
            .any(|ignored| name.eq_ignore_ascii_case(ignored))
    })
}

fn claude_import_paths(source_path: &str, content: &str) -> Vec<String> {
    let source_parent = source_path.rsplit_once('/').map(|(parent, _)| parent);
    let mut imports = Vec::new();
    let mut seen = HashSet::new();
    for token in content.split_whitespace() {
        let token = token.trim_start_matches(['(', '[', '{', '"', '\'']);
        let Some(raw_path) = token.strip_prefix('@') else {
            continue;
        };
        let raw_path =
            raw_path.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', '\'']);
        if unsupported_instruction_reference(raw_path) {
            continue;
        }
        let candidate = source_parent
            .map(|parent| format!("{parent}/{raw_path}"))
            .unwrap_or_else(|| raw_path.to_string());
        if let Some(path) = normalize_relative_path(&candidate) {
            if seen.insert(path.clone()) {
                imports.push(path);
            }
        }
    }
    imports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_windows_drive_prefix_is_not_a_workspace_relative_path() {
        assert!(normalize_relative_path("guard/C:/.ssh/id_rsa").is_none());
        assert!(normalize_relative_path("guard/c:\\secret.md").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_special_instruction_entry_is_ignored_without_opening_it() {
        use std::os::unix::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let socket_path = temp.path().join("AGENTS.md");
        let _listener = UnixListener::bind(&socket_path).unwrap();

        assert_eq!(
            local_entry_kind(temp.path(), "AGENTS.md"),
            Some(InstructionEntryKind::Other)
        );
        assert!(resolved_local_file(temp.path(), "AGENTS.md").is_none());
        let files = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_workspace_instruction_files(temp.path()),
        )
        .await
        .expect("special files must not block instruction discovery")
        .unwrap();
        assert!(files.is_empty());
    }
}
