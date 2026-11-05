//! File tree service
//!
//! Provides file tree building, directory scanning, and file search

use super::content_preview::{build_content_match_preview, compile_content_search_regex};
use super::error::{FileSystemError, FileSystemResult};
use log::warn;

use ignore::WalkBuilder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeNode {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub children: Option<Vec<FileTreeNode>>,
    pub size: Option<u64>,
    #[serde(rename = "lastModified")]
    pub last_modified: Option<String>,
    pub extension: Option<String>,

    pub depth: Option<u32>,
    pub is_symlink: Option<bool>,
    pub permissions: Option<String>,
    pub mime_type: Option<String>,
    pub git_status: Option<String>,
}

impl FileTreeNode {
    pub fn new(id: String, name: String, path: String, is_directory: bool) -> Self {
        Self {
            id,
            name,
            path,
            is_directory,
            children: None,
            size: None,
            last_modified: None,
            extension: None,
            depth: None,
            is_symlink: None,
            permissions: None,
            mime_type: None,
            git_status: None,
        }
    }

    pub fn with_metadata(mut self, size: Option<u64>, last_modified: Option<String>) -> Self {
        self.size = size;
        self.last_modified = last_modified;
        self
    }

    pub fn with_extension(mut self, extension: Option<String>) -> Self {
        self.extension = extension;
        self
    }

    pub fn with_children(mut self, children: Vec<FileTreeNode>) -> Self {
        self.children = Some(children);
        self
    }

    pub fn with_depth(mut self, depth: u32) -> Self {
        self.depth = Some(depth);
        self
    }

    pub fn with_enhanced_info(
        mut self,
        is_symlink: bool,
        permissions: Option<String>,
        mime_type: Option<String>,
        git_status: Option<String>,
    ) -> Self {
        self.is_symlink = Some(is_symlink);
        self.permissions = permissions;
        self.mime_type = mime_type;
        self.git_status = git_status;
        self
    }
}

/// File tree build options
#[derive(Debug, Clone)]
pub struct FileTreeOptions {
    pub max_depth: Option<u32>,
    pub include_hidden: bool,
    pub include_git_info: bool,
    pub include_mime_types: bool,
    pub skip_patterns: Vec<String>,
    /// Retained for source compatibility. Metadata listings never hide files by size;
    /// content readers own their separate memory/streaming budgets.
    pub max_file_size_mb: Option<u64>,
    pub follow_symlinks: bool,
}

impl Default for FileTreeOptions {
    fn default() -> Self {
        Self {
            max_depth: Some(50),
            include_hidden: true,
            include_git_info: false,
            include_mime_types: false,
            skip_patterns: vec![
                ".git".to_string(),
                ".svn".to_string(),
                ".hg".to_string(),
                ".DS_Store".to_string(),
                "Thumbs.db".to_string(),
            ],
            max_file_size_mb: None,
            follow_symlinks: false,
        }
    }
}

/// File tree statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTreeStatistics {
    pub total_files: usize,
    pub total_directories: usize,
    pub total_size_bytes: u64,
    pub max_depth_reached: u32,
    pub file_type_counts: HashMap<String, usize>,
    pub large_files: Vec<(String, u64)>, // (path, size) for files > 10MB
    pub symlinks_count: usize,
    pub hidden_files_count: usize,
}

pub struct FileTreeService {
    options: FileTreeOptions,
}

fn lock_search_results(
    results: &Arc<Mutex<Vec<FileSearchResult>>>,
) -> std::sync::MutexGuard<'_, Vec<FileSearchResult>> {
    match results.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("File search results mutex was poisoned, recovering lock");
            poisoned.into_inner()
        }
    }
}

fn cancellation_requested(cancel_flag: Option<&Arc<AtomicBool>>) -> bool {
    cancel_flag
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
pub struct FileNameSearchOptions {
    pub case_sensitive: bool,
    pub use_regex: bool,
    pub whole_word: bool,
    pub max_results: usize,
    pub include_directories: bool,
    pub cancel_flag: Option<Arc<AtomicBool>>,
}

impl Default for FileNameSearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            use_regex: false,
            whole_word: false,
            max_results: 10_000,
            include_directories: true,
            cancel_flag: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileContentSearchOptions {
    pub case_sensitive: bool,
    pub use_regex: bool,
    pub whole_word: bool,
    pub max_results: usize,
    pub max_file_size_bytes: u64,
    pub cancel_flag: Option<Arc<AtomicBool>>,
}

impl Default for FileContentSearchOptions {
    fn default() -> Self {
        Self {
            case_sensitive: false,
            use_regex: false,
            whole_word: false,
            max_results: 10_000,
            max_file_size_bytes: 10 * 1024 * 1024,
            cancel_flag: None,
        }
    }
}

/// Content search exclusions shared by every interactive backend, so the same
/// query does not see different files depending on where the workspace lives.
pub const CONTENT_SEARCH_SKIPPED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "target",
    "build",
    "dist",
    "out",
    ".next",
    ".nuxt",
    ".cache",
    "__pycache__",
    "coverage",
    ".idea",
    ".vscode",
];
pub const CONTENT_SEARCH_SKIPPED_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db"];
/// Lowercase file-name suffixes treated as binary without reading the file.
pub const CONTENT_SEARCH_BINARY_SUFFIXES: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".mp4", ".avi", ".mov",
    ".wmv", ".flv", ".mkv", ".mp3", ".wav", ".flac", ".aac", ".ogg", ".zip", ".tar", ".gz", ".7z",
    ".rar", ".bz2", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".woff", ".woff2",
    ".ttf", ".otf", ".eot", ".exe", ".dll", ".so", ".dylib", ".bin", ".pyc", ".class", ".o", ".a",
    ".lib",
];
pub const CONTENT_SEARCH_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSearchOutcome {
    pub results: Vec<FileSearchResult>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSearchResultGroup {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub file_name_match: Option<FileSearchResult>,
    pub content_matches: Vec<FileSearchResult>,
}

pub trait FileSearchProgressSink: Send + Sync {
    fn report(&self, result: FileSearchResultGroup);
    fn flush(&self);
}

pub struct BatchedFileSearchProgressSink {
    batch: Mutex<Vec<FileSearchResultGroup>>,
    batch_size: usize,
    flush_interval: Duration,
    last_flush_at: Mutex<Instant>,
    on_flush: Box<dyn Fn(Vec<FileSearchResultGroup>) + Send + Sync>,
}

impl BatchedFileSearchProgressSink {
    pub fn new<F>(batch_size: usize, flush_interval: Duration, on_flush: F) -> Self
    where
        F: Fn(Vec<FileSearchResultGroup>) + Send + Sync + 'static,
    {
        Self {
            batch: Mutex::new(Vec::new()),
            batch_size: batch_size.max(1),
            flush_interval,
            last_flush_at: Mutex::new(Instant::now() - flush_interval),
            on_flush: Box::new(on_flush),
        }
    }

    fn drain_batch(&self) -> Vec<FileSearchResultGroup> {
        match self.batch.lock() {
            Ok(mut guard) => std::mem::take(&mut *guard),
            Err(poisoned) => {
                warn!("File search progress batch mutex was poisoned, recovering lock");
                let mut guard = poisoned.into_inner();
                std::mem::take(&mut *guard)
            }
        }
    }

    fn elapsed_since_last_flush(&self) -> Duration {
        match self.last_flush_at.lock() {
            Ok(guard) => guard.elapsed(),
            Err(poisoned) => {
                warn!("File search progress flush timer mutex was poisoned, recovering lock");
                poisoned.into_inner().elapsed()
            }
        }
    }

    fn mark_flushed(&self) {
        match self.last_flush_at.lock() {
            Ok(mut guard) => {
                *guard = Instant::now();
            }
            Err(poisoned) => {
                warn!("File search progress flush timer mutex was poisoned, recovering lock");
                let mut guard = poisoned.into_inner();
                *guard = Instant::now();
            }
        }
    }

    fn flush_internal(&self, force: bool) {
        let should_flush = force || self.elapsed_since_last_flush() >= self.flush_interval;
        if !should_flush {
            return;
        }

        let batch = self.drain_batch();
        if batch.is_empty() {
            return;
        }

        (self.on_flush)(batch);
        self.mark_flushed();
    }
}

impl FileSearchProgressSink for BatchedFileSearchProgressSink {
    fn report(&self, result: FileSearchResultGroup) {
        let should_flush_now = match self.batch.lock() {
            Ok(mut guard) => {
                guard.push(result);
                guard.len() >= self.batch_size
            }
            Err(poisoned) => {
                warn!("File search progress batch mutex was poisoned, recovering lock");
                let mut guard = poisoned.into_inner();
                guard.push(result);
                guard.len() >= self.batch_size
            }
        };

        if should_flush_now {
            self.flush_internal(true);
            return;
        }

        self.flush_internal(false);
    }

    fn flush(&self) {
        self.flush_internal(true);
    }
}

impl Default for FileTreeService {
    fn default() -> Self {
        Self::new(FileTreeOptions::default())
    }
}

struct SearchFileContentInput<'a> {
    path: &'a Path,
    file_name: &'a str,
    matcher: &'a Regex,
    results: &'a Arc<Mutex<Vec<FileSearchResult>>>,
    max_results: usize,
    should_stop: &'a Arc<AtomicBool>,
    limit_reached: &'a Arc<AtomicBool>,
    cancel_flag: Option<&'a Arc<AtomicBool>>,
    progress_sink: Option<&'a Arc<dyn FileSearchProgressSink>>,
}

impl FileTreeService {
    pub fn new(options: FileTreeOptions) -> Self {
        Self { options }
    }

    pub async fn build_tree(&self, root_path: &str) -> Result<Vec<FileTreeNode>, String> {
        self.build_tree_with_remote_hint(root_path, None).await
    }

    pub async fn build_tree_with_remote_hint(
        &self,
        root_path: &str,
        _preferred_remote_connection_id: Option<&str>,
    ) -> Result<Vec<FileTreeNode>, String> {
        let root_path_buf = PathBuf::from(root_path);

        if !root_path_buf.exists() {
            return Err("Directory does not exist".to_string());
        }

        if !root_path_buf.is_dir() {
            return Err("Path is not a directory".to_string());
        }

        let mut visited = HashSet::new();
        self.build_tree_recursive(&root_path_buf, &root_path_buf, &mut visited, 0)
            .await
    }

    pub async fn build_tree_with_stats(
        &self,
        root_path: &str,
    ) -> FileSystemResult<(Vec<FileTreeNode>, FileTreeStatistics)> {
        let root_path_buf = PathBuf::from(root_path);

        if !root_path_buf.exists() {
            return Err(FileSystemError::service(
                "Directory does not exist".to_string(),
            ));
        }

        if !root_path_buf.is_dir() {
            return Err(FileSystemError::service(
                "Path is not a directory".to_string(),
            ));
        }

        let mut visited = HashSet::new();
        let mut stats = FileTreeStatistics {
            total_files: 0,
            total_directories: 0,
            total_size_bytes: 0,
            max_depth_reached: 0,
            file_type_counts: HashMap::new(),
            large_files: Vec::new(),
            symlinks_count: 0,
            hidden_files_count: 0,
        };

        let nodes = self
            .build_tree_recursive_with_stats(
                &root_path_buf,
                &root_path_buf,
                &mut visited,
                0,
                &mut stats,
            )
            .await
            .map_err(FileSystemError::service)?;

        Ok((nodes, stats))
    }

    fn build_tree_recursive<'a>(
        &'a self,
        path: &'a PathBuf,
        root_path: &'a PathBuf,
        visited: &'a mut HashSet<PathBuf>,
        depth: u32,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<FileTreeNode>, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if let Some(max_depth) = self.options.max_depth {
                if depth > max_depth {
                    return Ok(vec![]);
                }
            }

            // Prevent cycles. canonicalize is blocking IO, so keep it off the
            // async worker threads.
            let canonical_path = Self::canonicalize_off_thread(path).await;

            if visited.contains(&canonical_path) {
                return Ok(vec![]);
            }
            visited.insert(canonical_path);

            let mut read_dir = fs::read_dir(path)
                .await
                .map_err(|e| format!("Failed to read directory: {}", e))?;

            // Land (entry, file_type, metadata) in one pass so the sort
            // comparator and per-entry processing make zero extra syscalls.
            let mut entries: Vec<(fs::DirEntry, std::fs::FileType, Option<std::fs::Metadata>)> =
                Vec::new();
            while let Some(entry) = read_dir
                .next_entry()
                .await
                .map_err(|e| format!("Failed to read directory entry: {}", e))?
            {
                let file_name = entry.file_name();
                let file_name_str = file_name.to_string_lossy();

                if self.should_skip_file(&file_name_str) {
                    continue;
                }

                let (file_type, metadata) = match entry.file_type().await {
                    Ok(ft) => (ft, entry.metadata().await.ok()),
                    Err(_) => match std::fs::symlink_metadata(entry.path()) {
                        Ok(metadata) => (metadata.file_type(), Some(metadata)),
                        Err(e) => {
                            warn!(
                                "Failed to get file type, skipping: {} ({})",
                                entry.path().display(),
                                e
                            );
                            continue;
                        }
                    },
                };

                entries.push((entry, file_type, metadata));
            }

            entries.sort_by(|a, b| match (a.1.is_dir(), b.1.is_dir()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.0.file_name().cmp(&b.0.file_name()),
            });

            let mut nodes = Vec::with_capacity(entries.len());

            for (entry, file_type, metadata) in entries {
                let file_name = entry.file_name();
                let file_name_str = file_name.to_string_lossy();

                let entry_path = entry.path();
                let relative_path = entry_path
                    .strip_prefix(root_path)
                    .unwrap_or(&entry_path)
                    .to_string_lossy()
                    .to_string();

                let is_directory = file_type.is_dir();
                let is_symlink = file_type.is_symlink();

                let size = if is_directory {
                    None
                } else {
                    metadata.as_ref().map(|m| m.len())
                };

                let last_modified = metadata.as_ref().and_then(|m| {
                    m.modified().ok().map(|t| {
                        let datetime: chrono::DateTime<chrono::Utc> = t.into();
                        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
                    })
                });

                let extension = if !is_directory {
                    entry_path
                        .extension()
                        .map(|ext| ext.to_string_lossy().to_string())
                } else {
                    None
                };

                let mime_type = if self.options.include_mime_types && !is_directory {
                    self.detect_mime_type(&entry_path)
                } else {
                    None
                };

                let permissions = metadata
                    .as_ref()
                    .map(Self::permissions_string_from_metadata);

                let mut node = FileTreeNode::new(
                    relative_path,
                    file_name_str.to_string(),
                    entry_path.to_string_lossy().to_string(),
                    is_directory,
                )
                .with_metadata(size, last_modified)
                .with_extension(extension)
                .with_depth(depth)
                .with_enhanced_info(is_symlink, permissions, mime_type, None);

                if is_directory && (!is_symlink || self.options.follow_symlinks) {
                    match self
                        .build_tree_recursive(&entry_path, root_path, visited, depth + 1)
                        .await
                    {
                        Ok(children) => {
                            node = node.with_children(children);
                        }
                        Err(_) => {
                            node = node.with_children(vec![]);
                        }
                    }
                }

                nodes.push(node);
            }

            Ok(nodes)
        })
    }

    fn build_tree_recursive_with_stats<'a>(
        &'a self,
        path: &'a PathBuf,
        root_path: &'a PathBuf,
        visited: &'a mut HashSet<PathBuf>,
        depth: u32,
        stats: &'a mut FileTreeStatistics,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<FileTreeNode>, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            if depth > stats.max_depth_reached {
                stats.max_depth_reached = depth;
            }

            if let Some(max_depth) = self.options.max_depth {
                if depth > max_depth {
                    return Ok(vec![]);
                }
            }

            // Prevent cycles. canonicalize is blocking IO, so keep it off the
            // async worker threads.
            let canonical_path = Self::canonicalize_off_thread(path).await;

            if visited.contains(&canonical_path) {
                return Ok(vec![]);
            }
            visited.insert(canonical_path);

            let mut read_dir = fs::read_dir(path)
                .await
                .map_err(|e| format!("Failed to read directory: {}", e))?;

            // Land (entry, file_type, metadata) in one pass so the sort
            // comparator and per-entry processing make zero extra syscalls.
            let mut entries: Vec<(fs::DirEntry, std::fs::FileType, Option<std::fs::Metadata>)> =
                Vec::new();
            while let Some(entry) = read_dir
                .next_entry()
                .await
                .map_err(|e| format!("Failed to read directory entry: {}", e))?
            {
                let file_name = entry.file_name();
                let file_name_str = file_name.to_string_lossy();

                if file_name_str.starts_with('.') {
                    stats.hidden_files_count += 1;
                }

                if self.should_skip_file(&file_name_str) {
                    continue;
                }

                let (file_type, metadata) = match entry.file_type().await {
                    Ok(ft) => (ft, entry.metadata().await.ok()),
                    Err(_) => match std::fs::symlink_metadata(entry.path()) {
                        Ok(metadata) => (metadata.file_type(), Some(metadata)),
                        Err(e) => {
                            warn!(
                                "Failed to get file type, skipping: {} ({})",
                                entry.path().display(),
                                e
                            );
                            continue;
                        }
                    },
                };

                entries.push((entry, file_type, metadata));
            }

            entries.sort_by(|a, b| match (a.1.is_dir(), b.1.is_dir()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.0.file_name().cmp(&b.0.file_name()),
            });

            let mut nodes = Vec::with_capacity(entries.len());

            for (entry, file_type, metadata) in entries {
                let file_name = entry.file_name();
                let file_name_str = file_name.to_string_lossy();

                let entry_path = entry.path();
                let relative_path = entry_path
                    .strip_prefix(root_path)
                    .unwrap_or(&entry_path)
                    .to_string_lossy()
                    .to_string();

                let is_directory = file_type.is_dir();
                let is_symlink = file_type.is_symlink();

                if is_directory {
                    stats.total_directories += 1;
                } else {
                    stats.total_files += 1;
                }

                if is_symlink {
                    stats.symlinks_count += 1;
                }

                let size = if is_directory {
                    None
                } else {
                    metadata.as_ref().map(|m| m.len())
                };

                if let Some(file_size) = size {
                    stats.total_size_bytes += file_size;

                    if file_size > 10 * 1024 * 1024 {
                        stats
                            .large_files
                            .push((entry_path.to_string_lossy().to_string(), file_size));
                    }
                }

                if !is_directory {
                    if let Some(ext) = entry_path.extension().and_then(|e| e.to_str()) {
                        *stats.file_type_counts.entry(ext.to_string()).or_insert(0) += 1;
                    } else {
                        *stats
                            .file_type_counts
                            .entry("no_extension".to_string())
                            .or_insert(0) += 1;
                    }
                }

                let last_modified = metadata.as_ref().and_then(|m| {
                    m.modified().ok().map(|t| {
                        let datetime: chrono::DateTime<chrono::Utc> = t.into();
                        datetime.format("%Y-%m-%d %H:%M:%S").to_string()
                    })
                });

                let extension = if !is_directory {
                    entry_path
                        .extension()
                        .map(|ext| ext.to_string_lossy().to_string())
                } else {
                    None
                };

                let mime_type = if self.options.include_mime_types && !is_directory {
                    self.detect_mime_type(&entry_path)
                } else {
                    None
                };

                let permissions = metadata
                    .as_ref()
                    .map(Self::permissions_string_from_metadata);

                let mut node = FileTreeNode::new(
                    relative_path,
                    file_name_str.to_string(),
                    entry_path.to_string_lossy().to_string(),
                    is_directory,
                )
                .with_metadata(size, last_modified)
                .with_extension(extension)
                .with_depth(depth)
                .with_enhanced_info(is_symlink, permissions, mime_type, None);

                if is_directory && (!is_symlink || self.options.follow_symlinks) {
                    match self
                        .build_tree_recursive_with_stats(
                            &entry_path,
                            root_path,
                            visited,
                            depth + 1,
                            stats,
                        )
                        .await
                    {
                        Ok(children) => {
                            node = node.with_children(children);
                        }
                        Err(_) => {
                            node = node.with_children(vec![]);
                        }
                    }
                }

                nodes.push(node);
            }

            Ok(nodes)
        })
    }

    fn should_skip_file(&self, file_name: &str) -> bool {
        // Skip hidden files and directories unless explicitly included.
        if !self.options.include_hidden
            && file_name.starts_with('.')
            && file_name != ".gitignore"
            && file_name != crate::product_identity::hidden_data_directory()
        {
            return true;
        }

        self.options.skip_patterns.iter().any(|pattern| {
            if pattern.contains('*') {
                let parts: Vec<&str> = pattern.split('*').collect();
                if parts.len() == 2 {
                    file_name.starts_with(parts[0]) && file_name.ends_with(parts[1])
                } else {
                    file_name.contains(pattern.trim_matches('*'))
                }
            } else {
                file_name == pattern
            }
        })
    }

    pub async fn get_directory_contents(&self, path: &str) -> Result<Vec<FileTreeNode>, String> {
        self.get_directory_contents_with_remote_hint(path, None)
            .await
    }

    /// Keeps the legacy signature; core handles remote routing before delegating
    /// local directory reads to this owner crate.
    pub async fn get_directory_contents_with_remote_hint(
        &self,
        path: &str,
        _preferred_remote_connection_id: Option<&str>,
    ) -> Result<Vec<FileTreeNode>, String> {
        let path_buf = PathBuf::from(path);

        if !path_buf.exists() {
            return Err("Directory does not exist".to_string());
        }

        if !path_buf.is_dir() {
            return Err("Path is not a directory".to_string());
        }

        let mut nodes = Vec::new();

        let mut read_dir = fs::read_dir(&path_buf)
            .await
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read directory entry: {}", e))?
        {
            let file_name = entry.file_name();
            let file_name_str = file_name.to_string_lossy();

            if self.should_skip_file(&file_name_str) {
                continue;
            }

            let entry_path = entry.path();
            let metadata = entry.metadata().await.ok();
            let is_directory = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            let size = if is_directory {
                None
            } else {
                metadata.as_ref().map(|value| value.len())
            };
            let modified = metadata
                .as_ref()
                .and_then(|value| value.modified().ok())
                .map(|value| {
                    let time: chrono::DateTime<chrono::Utc> = value.into();
                    time.format("%Y-%m-%d %H:%M:%S").to_string()
                });
            let extension = if is_directory {
                None
            } else {
                entry_path
                    .extension()
                    .map(|value| value.to_string_lossy().to_string())
            };

            let node = FileTreeNode::new(
                entry_path.to_string_lossy().to_string(),
                file_name_str.to_string(),
                entry_path.to_string_lossy().to_string(),
                is_directory,
            )
            .with_metadata(size, modified)
            .with_extension(extension);

            nodes.push(node);
        }

        Ok(nodes)
    }

    fn detect_mime_type(&self, path: &Path) -> Option<String> {
        if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
            match extension.to_lowercase().as_str() {
                "txt" | "md" | "rst" => Some("text/plain".to_string()),
                "html" | "htm" => Some("text/html".to_string()),
                "css" => Some("text/css".to_string()),
                "js" => Some("application/javascript".to_string()),
                "json" => Some("application/json".to_string()),
                "xml" => Some("application/xml".to_string()),
                "yaml" | "yml" => Some("application/yaml".to_string()),

                "rs" => Some("text/rust".to_string()),
                "py" => Some("text/python".to_string()),
                "java" => Some("text/java".to_string()),
                "cpp" | "cc" | "cxx" => Some("text/cpp".to_string()),
                "c" => Some("text/c".to_string()),
                "h" | "hpp" => Some("text/c-header".to_string()),
                "go" => Some("text/go".to_string()),
                "php" => Some("text/php".to_string()),
                "rb" => Some("text/ruby".to_string()),
                "ts" => Some("application/typescript".to_string()),

                "png" => Some("image/png".to_string()),
                "jpg" | "jpeg" => Some("image/jpeg".to_string()),
                "gif" => Some("image/gif".to_string()),
                "svg" => Some("image/svg+xml".to_string()),
                "webp" => Some("image/webp".to_string()),

                "pdf" => Some("application/pdf".to_string()),
                "doc" | "docx" => Some("application/msword".to_string()),
                "xls" | "xlsx" => Some("application/excel".to_string()),
                "ppt" | "pptx" => Some("application/powerpoint".to_string()),

                "zip" => Some("application/zip".to_string()),
                "tar" => Some("application/tar".to_string()),
                "gz" => Some("application/gzip".to_string()),
                "rar" => Some("application/rar".to_string()),

                _ => None,
            }
        } else {
            None
        }
    }

    /// Resolves a canonical path on the blocking pool; falls back to the
    /// original path on error.
    async fn canonicalize_off_thread(path: &Path) -> PathBuf {
        let owned = path.to_path_buf();
        let fallback = owned.clone();
        match tokio::task::spawn_blocking(move || owned.canonicalize()).await {
            Ok(Ok(canonical)) => canonical,
            _ => fallback,
        }
    }

    /// Formats a permissions string from already-fetched metadata, avoiding an
    /// extra stat per entry.
    fn permissions_string_from_metadata(metadata: &std::fs::Metadata) -> String {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = metadata.permissions().mode();

            let user = format!(
                "{}{}{}",
                if mode & 0o400 != 0 { "r" } else { "-" },
                if mode & 0o200 != 0 { "w" } else { "-" },
                if mode & 0o100 != 0 { "x" } else { "-" }
            );
            let group = format!(
                "{}{}{}",
                if mode & 0o040 != 0 { "r" } else { "-" },
                if mode & 0o020 != 0 { "w" } else { "-" },
                if mode & 0o010 != 0 { "x" } else { "-" }
            );
            let other = format!(
                "{}{}{}",
                if mode & 0o004 != 0 { "r" } else { "-" },
                if mode & 0o002 != 0 { "w" } else { "-" },
                if mode & 0o001 != 0 { "x" } else { "-" }
            );

            format!("{}{}{}", user, group, other)
        }

        #[cfg(windows)]
        {
            let readonly = metadata.permissions().readonly();
            (if readonly { "r--" } else { "rw-" }).to_string()
        }
    }

    pub async fn search_files(
        &self,
        root_path: &str,
        pattern: &str,
        search_content: bool,
    ) -> FileSystemResult<Vec<FileSearchResult>> {
        self.search_files_with_options(root_path, pattern, search_content, false, false, false)
            .await
    }

    pub async fn search_files_with_options(
        &self,
        root_path: &str,
        pattern: &str,
        search_content: bool,
        case_sensitive: bool,
        use_regex: bool,
        whole_word: bool,
    ) -> FileSystemResult<Vec<FileSearchResult>> {
        let filename_outcome = self
            .search_file_names(
                root_path,
                pattern,
                FileNameSearchOptions {
                    case_sensitive,
                    use_regex,
                    whole_word,
                    max_results: 10_000,
                    include_directories: true,
                    cancel_flag: None,
                },
            )
            .await?;
        let mut results = filename_outcome.results;

        if search_content && !filename_outcome.truncated && results.len() < 10_000 {
            let remaining = 10_000 - results.len();
            let mut content_outcome = self
                .search_file_contents(
                    root_path,
                    pattern,
                    FileContentSearchOptions {
                        case_sensitive,
                        use_regex,
                        whole_word,
                        max_results: remaining,
                        max_file_size_bytes: 10 * 1024 * 1024,
                        cancel_flag: None,
                    },
                )
                .await?;
            results.append(&mut content_outcome.results);
        }

        Ok(results)
    }

    pub async fn search_file_names(
        &self,
        root_path: &str,
        pattern: &str,
        options: FileNameSearchOptions,
    ) -> FileSystemResult<FileSearchOutcome> {
        self.search_file_names_with_progress(root_path, pattern, options, None)
            .await
    }

    pub async fn search_file_names_with_progress(
        &self,
        root_path: &str,
        pattern: &str,
        options: FileNameSearchOptions,
        progress_sink: Option<Arc<dyn FileSearchProgressSink>>,
    ) -> FileSystemResult<FileSearchOutcome> {
        let root_path_buf = PathBuf::from(root_path);

        if !root_path_buf.exists() {
            return Err(FileSystemError::service(
                "Directory does not exist".to_string(),
            ));
        }

        let matcher = Arc::new(Self::compile_search_regex(
            pattern,
            options.case_sensitive,
            options.use_regex,
            options.whole_word,
        )?);
        let results = Arc::new(Mutex::new(Vec::new()));
        let should_stop = Arc::new(AtomicBool::new(false));
        let limit_reached = Arc::new(AtomicBool::new(false));
        let cancel_flag = options.cancel_flag.clone();
        let include_directories = options.include_directories;
        let max_results = options.max_results.max(1);
        let progress_sink_for_walker = progress_sink.clone();

        let walker = Self::build_search_walker(&root_path_buf);

        walker.run(|| {
            let matcher = Arc::clone(&matcher);
            let results = Arc::clone(&results);
            let should_stop = Arc::clone(&should_stop);
            let limit_reached = Arc::clone(&limit_reached);
            let root_path_buf = root_path_buf.clone();
            let cancel_flag = cancel_flag.clone();
            let progress_sink = progress_sink_for_walker.clone();

            Box::new(move |entry| {
                if should_stop.load(Ordering::Relaxed)
                    || cancellation_requested(cancel_flag.as_ref())
                {
                    should_stop.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }

                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => return ignore::WalkState::Continue,
                };

                let path = entry.path();
                if path == root_path_buf {
                    return ignore::WalkState::Continue;
                }

                let file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                let file_type = entry.file_type();

                if file_type.map(|kind| kind.is_dir()).unwrap_or(false) {
                    if Self::should_skip_directory_static(&file_name) {
                        return ignore::WalkState::Skip;
                    }

                    if include_directories
                        && matcher.is_match(&file_name)
                        && !Self::push_search_result_group(
                            &results,
                            &should_stop,
                            &limit_reached,
                            max_results,
                            progress_sink.as_ref(),
                            vec![FileSearchResult {
                                path: path.to_string_lossy().to_string(),
                                name: file_name,
                                is_directory: true,
                                match_type: SearchMatchType::FileName,
                                line_number: None,
                                matched_content: None,
                                preview_before: None,
                                preview_inside: None,
                                preview_after: None,
                            }],
                        )
                    {
                        return ignore::WalkState::Quit;
                    }

                    return ignore::WalkState::Continue;
                }

                if !file_type.map(|kind| kind.is_file()).unwrap_or(false) {
                    return ignore::WalkState::Continue;
                }

                if Self::should_skip_file_static(&file_name)
                    || Self::is_binary_file_static(&file_name)
                {
                    return ignore::WalkState::Continue;
                }

                if matcher.is_match(&file_name)
                    && !Self::push_search_result_group(
                        &results,
                        &should_stop,
                        &limit_reached,
                        max_results,
                        progress_sink.as_ref(),
                        vec![FileSearchResult {
                            path: path.to_string_lossy().to_string(),
                            name: file_name,
                            is_directory: false,
                            match_type: SearchMatchType::FileName,
                            line_number: None,
                            matched_content: None,
                            preview_before: None,
                            preview_inside: None,
                            preview_after: None,
                        }],
                    )
                {
                    return ignore::WalkState::Quit;
                }

                ignore::WalkState::Continue
            })
        });

        if let Some(progress_sink) = progress_sink {
            progress_sink.flush();
        }

        let final_results = std::mem::take(&mut *lock_search_results(&results));
        Ok(FileSearchOutcome {
            results: final_results,
            truncated: limit_reached.load(Ordering::Relaxed),
        })
    }

    pub async fn search_file_contents(
        &self,
        root_path: &str,
        pattern: &str,
        options: FileContentSearchOptions,
    ) -> FileSystemResult<FileSearchOutcome> {
        self.search_file_contents_with_progress(root_path, pattern, options, None)
            .await
    }

    pub async fn search_file_contents_with_progress(
        &self,
        root_path: &str,
        pattern: &str,
        options: FileContentSearchOptions,
        progress_sink: Option<Arc<dyn FileSearchProgressSink>>,
    ) -> FileSystemResult<FileSearchOutcome> {
        let root_path_buf = PathBuf::from(root_path);

        if !root_path_buf.exists() {
            return Err(FileSystemError::service(
                "Directory does not exist".to_string(),
            ));
        }

        let matcher = Arc::new(Self::compile_search_regex(
            pattern,
            options.case_sensitive,
            options.use_regex,
            options.whole_word,
        )?);
        let results = Arc::new(Mutex::new(Vec::new()));
        let should_stop = Arc::new(AtomicBool::new(false));
        let limit_reached = Arc::new(AtomicBool::new(false));
        let cancel_flag = options.cancel_flag.clone();
        let max_results = options.max_results.max(1);
        let max_file_size_bytes = options.max_file_size_bytes;
        let progress_sink_for_walker = progress_sink.clone();

        let walker = Self::build_search_walker(&root_path_buf);

        walker.run(|| {
            let matcher = Arc::clone(&matcher);
            let results = Arc::clone(&results);
            let should_stop = Arc::clone(&should_stop);
            let limit_reached = Arc::clone(&limit_reached);
            let root_path_buf = root_path_buf.clone();
            let cancel_flag = cancel_flag.clone();
            let progress_sink = progress_sink_for_walker.clone();

            Box::new(move |entry| {
                if should_stop.load(Ordering::Relaxed)
                    || cancellation_requested(cancel_flag.as_ref())
                {
                    should_stop.store(true, Ordering::Relaxed);
                    return ignore::WalkState::Quit;
                }

                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => return ignore::WalkState::Continue,
                };

                let path = entry.path();
                if path == root_path_buf {
                    return ignore::WalkState::Continue;
                }

                let file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                let file_type = entry.file_type();

                if file_type.map(|kind| kind.is_dir()).unwrap_or(false) {
                    return if Self::should_skip_directory_static(&file_name) {
                        ignore::WalkState::Skip
                    } else {
                        ignore::WalkState::Continue
                    };
                }

                if !file_type.map(|kind| kind.is_file()).unwrap_or(false) {
                    return ignore::WalkState::Continue;
                }

                if Self::should_skip_file_static(&file_name)
                    || Self::is_binary_file_static(&file_name)
                {
                    return ignore::WalkState::Continue;
                }

                if let Ok(metadata) = path.metadata() {
                    if metadata.len() > max_file_size_bytes {
                        return ignore::WalkState::Continue;
                    }
                }

                if let Err(error) = Self::search_file_content_lines(SearchFileContentInput {
                    path,
                    file_name: &file_name,
                    matcher: matcher.as_ref(),
                    results: &results,
                    max_results,
                    should_stop: &should_stop,
                    limit_reached: &limit_reached,
                    cancel_flag: cancel_flag.as_ref(),
                    progress_sink: progress_sink.as_ref(),
                }) {
                    warn!(
                        "Failed to search file content {}: {}",
                        path.display(),
                        error
                    );
                }

                if should_stop.load(Ordering::Relaxed) {
                    ignore::WalkState::Quit
                } else {
                    ignore::WalkState::Continue
                }
            })
        });

        if let Some(progress_sink) = progress_sink {
            progress_sink.flush();
        }

        let final_results = std::mem::take(&mut *lock_search_results(&results));
        Ok(FileSearchOutcome {
            results: final_results,
            truncated: limit_reached.load(Ordering::Relaxed),
        })
    }

    fn build_search_walker(root_path: &Path) -> ignore::WalkParallel {
        WalkBuilder::new(root_path)
            .hidden(false)
            .ignore(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .threads(
                std::thread::available_parallelism()
                    .map(|count| count.get())
                    .unwrap_or(1)
                    .min(8),
            )
            .build_parallel()
    }

    fn compile_search_regex(
        pattern: &str,
        case_sensitive: bool,
        use_regex: bool,
        whole_word: bool,
    ) -> FileSystemResult<Regex> {
        compile_content_search_regex(pattern, case_sensitive, use_regex, whole_word)
            .map_err(|error| FileSystemError::service(format!("Invalid regex pattern: {}", error)))
    }

    fn build_search_result_group(results: Vec<FileSearchResult>) -> Option<FileSearchResultGroup> {
        let first = results.first()?.clone();
        let file_name_match = results
            .iter()
            .find(|result| matches!(result.match_type, SearchMatchType::FileName))
            .cloned();
        let content_matches = results
            .iter()
            .filter(|result| matches!(result.match_type, SearchMatchType::Content))
            .cloned()
            .collect();

        Some(FileSearchResultGroup {
            path: first.path,
            name: first.name,
            is_directory: first.is_directory,
            file_name_match,
            content_matches,
        })
    }

    fn push_search_result_group(
        results: &Arc<Mutex<Vec<FileSearchResult>>>,
        should_stop: &Arc<AtomicBool>,
        limit_reached: &Arc<AtomicBool>,
        max_results: usize,
        progress_sink: Option<&Arc<dyn FileSearchProgressSink>>,
        group_results: Vec<FileSearchResult>,
    ) -> bool {
        if group_results.is_empty() {
            return true;
        }

        let mut results_guard = lock_search_results(results);
        if results_guard.len() >= max_results {
            should_stop.store(true, Ordering::Relaxed);
            limit_reached.store(true, Ordering::Relaxed);
            return false;
        }

        let remaining_capacity = max_results.saturating_sub(results_guard.len());
        if remaining_capacity == 0 {
            should_stop.store(true, Ordering::Relaxed);
            limit_reached.store(true, Ordering::Relaxed);
            return false;
        }

        let accepted_results = if group_results.len() > remaining_capacity {
            limit_reached.store(true, Ordering::Relaxed);
            group_results
                .into_iter()
                .take(remaining_capacity)
                .collect::<Vec<_>>()
        } else {
            group_results
        };

        results_guard.extend(accepted_results.iter().cloned());
        if results_guard.len() >= max_results {
            should_stop.store(true, Ordering::Relaxed);
            limit_reached.store(true, Ordering::Relaxed);
        }

        drop(results_guard);
        if let (Some(progress_sink), Some(group)) = (
            progress_sink,
            Self::build_search_result_group(accepted_results),
        ) {
            progress_sink.report(group);
        }

        !should_stop.load(Ordering::Relaxed)
    }

    fn search_file_content_lines(input: SearchFileContentInput<'_>) -> FileSystemResult<()> {
        let SearchFileContentInput {
            path,
            file_name,
            matcher,
            results,
            max_results,
            should_stop,
            limit_reached,
            cancel_flag,
            progress_sink,
        } = input;
        if should_stop.load(Ordering::Relaxed) || cancellation_requested(cancel_flag) {
            should_stop.store(true, Ordering::Relaxed);
            return Ok(());
        }

        let file = File::open(path)
            .map_err(|error| FileSystemError::service(format!("Failed to open file: {}", error)))?;
        let reader = BufReader::new(file);
        let mut matched_results = Vec::new();

        for (index, line_result) in reader.split(b'\n').enumerate() {
            if should_stop.load(Ordering::Relaxed) || cancellation_requested(cancel_flag) {
                should_stop.store(true, Ordering::Relaxed);
                return Ok(());
            }

            let line_bytes = line_result.map_err(|error| {
                FileSystemError::service(format!("Failed to read file: {}", error))
            })?;
            // Match on the borrowed Cow first; only allocate for hit lines.
            let line_cow = String::from_utf8_lossy(&line_bytes);
            let line = line_cow.trim_end_matches('\r');

            if !matcher.is_match(line) {
                continue;
            }

            let (preview_before, preview_inside, preview_after) =
                build_content_match_preview(line, matcher);
            let line = line.to_string();

            matched_results.push(FileSearchResult {
                path: path.to_string_lossy().to_string(),
                name: file_name.to_string(),
                is_directory: false,
                match_type: SearchMatchType::Content,
                line_number: Some(index + 1),
                matched_content: Some(line),
                preview_before,
                preview_inside,
                preview_after,
            });

            if matched_results.len() >= max_results {
                break;
            }
        }

        if !Self::push_search_result_group(
            results,
            should_stop,
            limit_reached,
            max_results,
            progress_sink,
            matched_results,
        ) {
            return Ok(());
        }

        Ok(())
    }

    fn should_skip_directory_static(file_name: &str) -> bool {
        CONTENT_SEARCH_SKIPPED_DIRECTORIES.contains(&file_name)
    }

    fn should_skip_file_static(file_name: &str) -> bool {
        CONTENT_SEARCH_SKIPPED_FILE_NAMES.contains(&file_name)
    }

    fn is_binary_file_static(file_name: &str) -> bool {
        let lower_name = file_name.to_lowercase();
        CONTENT_SEARCH_BINARY_SUFFIXES
            .iter()
            .any(|ext| lower_name.ends_with(ext))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSearchResult {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub match_type: SearchMatchType,
    pub line_number: Option<usize>,
    pub matched_content: Option<String>,
    pub preview_before: Option<String>,
    pub preview_inside: Option<String>,
    pub preview_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SearchMatchType {
    FileName,
    Content,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn large_files_remain_visible_in_metadata_listings() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("large.bin");
        // Sparse metadata fixture: no 101 MiB buffer or content write is needed.
        let size = 101 * 1024 * 1024;
        std::fs::File::create(&path).unwrap().set_len(size).unwrap();
        let service = FileTreeService::new(FileTreeOptions {
            max_file_size_mb: Some(1),
            ..Default::default()
        });
        let root = root.path().to_str().unwrap();
        let nodes = service.build_tree(root).await.unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "large.bin");
        assert_eq!(nodes[0].size, Some(size));
        let (nodes, stats) = service.build_tree_with_stats(root).await.unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(stats.total_files, 1);
        assert_eq!(stats.total_size_bytes, size);
        let page = service.get_directory_contents(root).await.unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].size, Some(size));
    }

    #[test]
    fn default_tree_visibility_matches_vscode_baseline() {
        let service = FileTreeService::default();

        for name in [".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"] {
            assert!(service.should_skip_file(name), "{name} should be excluded");
        }

        for name in [
            ".env",
            ".github",
            ".vscode",
            "node_modules",
            "target",
            "dist",
            "build",
        ] {
            assert!(
                !service.should_skip_file(name),
                "{name} should be visible by default"
            );
        }
    }

    #[tokio::test]
    async fn content_search_preserves_matching_lines_and_preview_ranges() {
        let root = tempfile::tempdir().expect("create temp search directory");
        std::fs::write(
            root.path().join("sample.txt"),
            "first line\r\nbefore needle after\r\n",
        )
        .expect("write search fixture");

        let outcome = FileTreeService::default()
            .search_file_contents(
                root.path().to_str().expect("utf-8 temp path"),
                "needle",
                FileContentSearchOptions {
                    case_sensitive: true,
                    use_regex: false,
                    whole_word: false,
                    max_results: 10,
                    max_file_size_bytes: 1024,
                    cancel_flag: None,
                },
            )
            .await
            .expect("content search");

        assert!(!outcome.truncated);
        assert_eq!(outcome.results.len(), 1);
        assert_eq!(outcome.results[0].line_number, Some(2));
        assert_eq!(
            outcome.results[0].matched_content.as_deref(),
            Some("before needle after")
        );
        assert_eq!(
            outcome.results[0].preview_before.as_deref(),
            Some("before ")
        );
        assert_eq!(outcome.results[0].preview_inside.as_deref(), Some("needle"));
        assert_eq!(outcome.results[0].preview_after.as_deref(), Some(" after"));
    }
}
