use super::workspace_walk::{add_directory_ignores, WorkspaceFileWalker};
use crate::util::string::shell_single_quote;
use globset::GlobBuilder;
use ignore::{WalkBuilder, WalkState};
use log::{info, warn};
use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspacePathKind};
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalGlobRequest {
    pub search_path: PathBuf,
    pub pattern: String,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalGlobResult {
    pub matches: Vec<PathBuf>,
    pub walk_root: PathBuf,
    pub total_matches: Option<usize>,
    pub truncated: bool,
}

pub fn extract_glob_base_directory(pattern: &str) -> (String, String) {
    let glob_start = pattern.find(['*', '?', '[', '{']);

    #[cfg(not(windows))]
    if pattern[..glob_start.unwrap_or(pattern.len())].contains('\\') {
        return (String::new(), pattern.to_string());
    }

    match glob_start {
        Some(index) => {
            let static_prefix = &pattern[..index];
            let last_separator = static_prefix
                .char_indices()
                .rev()
                .find(|(_, ch)| *ch == '/' || *ch == '\\')
                .map(|(idx, _)| idx);

            if let Some(separator_index) = last_separator {
                let mut base_dir = static_prefix[..separator_index].to_string();

                // Preserve the root for patterns such as `/*.txt`. On Windows,
                // also preserve the separator after a drive prefix: `C:/*.txt`
                // must search from `C:/`, not from the drive-relative `C:`.
                if base_dir.is_empty() && separator_index == 0 {
                    base_dir = static_prefix[..1].to_string();
                }
                #[cfg(windows)]
                if base_dir.len() == 2
                    && base_dir.as_bytes()[1] == b':'
                    && base_dir.as_bytes()[0].is_ascii_alphabetic()
                {
                    base_dir.push(
                        static_prefix[separator_index..]
                            .chars()
                            .next()
                            .expect("separator index must point to a character"),
                    );
                }

                (base_dir, pattern[separator_index + 1..].to_string())
            } else {
                (String::new(), pattern.to_string())
            }
        }
        None => {
            let trimmed = pattern.trim_end_matches(['/', '\\']);
            let literal_path = Path::new(trimmed);
            let base_dir = literal_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty() && *parent != Path::new("."))
                .map(|parent| parent.to_string_lossy().to_string())
                .unwrap_or_default();
            let file_name = literal_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| trimmed.to_string());

            let relative_pattern = if pattern.ends_with('/') || pattern.ends_with('\\') {
                format!("{}/", file_name)
            } else {
                file_name
            };

            (base_dir, relative_pattern)
        }
    }
}

pub fn normalize_path(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().replace('\\', "/")
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct GlobCandidate {
    depth: usize,
    path: String,
}

impl Ord for GlobCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.depth
            .cmp(&other.depth)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for GlobCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// The matcher consumes provider-relative paths, not host `Path` candidates.
/// This keeps a POSIX backslash filename intact on a Windows controller.
#[derive(Clone)]
struct WorkspaceGlobMatcher {
    matcher: regex::bytes::Regex,
    match_basename: bool,
}

impl WorkspaceGlobMatcher {
    fn new(pattern: &str) -> Result<Self, String> {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .backslash_escape(true)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            matcher: regex::bytes::Regex::new(glob.regex()).map_err(|error| error.to_string())?,
            match_basename: !pattern.contains('/'),
        })
    }

    fn is_match(&self, relative_path: &str) -> bool {
        self.matcher.is_match(relative_path.as_bytes())
            || (self.match_basename
                && relative_path
                    .rsplit('/')
                    .next()
                    .is_some_and(|name| self.matcher.is_match(name.as_bytes())))
    }
}

/// One result reducer for native walking, command output and workspace IO.
/// Only the best `limit` candidates are retained, while totals remain exact.
struct GlobCollector {
    limit: usize,
    total: usize,
    best: BinaryHeap<GlobCandidate>,
}

impl GlobCollector {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            total: 0,
            best: BinaryHeap::with_capacity(limit.saturating_add(1)),
        }
    }

    fn push(&mut self, path: String) {
        if path.is_empty() {
            return;
        }
        self.total += 1;
        let candidate = GlobCandidate {
            depth: path.split('/').count(),
            path,
        };
        self.retain(candidate);
    }

    fn retain(&mut self, candidate: GlobCandidate) {
        if self.limit == 0 {
            return;
        }
        if self.best.len() < self.limit {
            self.best.push(candidate);
        } else if self.best.peek().is_some_and(|worst| candidate < *worst) {
            self.best.pop();
            self.best.push(candidate);
        }
    }

    fn merge(&mut self, other: Self) {
        self.total += other.total;
        for candidate in other.best {
            self.retain(candidate);
        }
    }

    fn finish(self) -> (Vec<PathBuf>, usize) {
        let mut matches = self
            .best
            .into_iter()
            .map(|candidate| PathBuf::from(candidate.path))
            .collect::<Vec<_>>();
        matches.sort();
        (matches, self.total)
    }
}

fn is_safe_relative_subpath(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

pub fn derive_walk_root(search_path_abs: &Path, pattern: &str) -> (PathBuf, String) {
    let (base_dir, relative_pattern) = extract_glob_base_directory(pattern);
    let base_path = Path::new(&base_dir);

    if base_dir.is_empty() || !is_safe_relative_subpath(base_path) {
        return (search_path_abs.to_path_buf(), pattern.to_string());
    }

    let walk_root = search_path_abs.join(base_path);
    if walk_root.starts_with(search_path_abs) {
        (walk_root, relative_pattern)
    } else {
        (search_path_abs.to_path_buf(), pattern.to_string())
    }
}

pub fn extract_remote_glob_base_directory(pattern: &str) -> (String, String) {
    let static_prefix = pattern
        .find(['*', '?', '[', '{'])
        .map_or(pattern.trim_end_matches('/'), |index| &pattern[..index]);
    // This is a glob prefix, not yet a filesystem spelling. Escaped characters
    // must be interpreted by the matcher, never copied into a directory name.
    // Keeping the original root avoids needing a second glob parser here.
    if static_prefix.contains('\\') {
        return (String::new(), pattern.to_string());
    }
    match static_prefix.rfind('/') {
        Some(index) => (
            if index == 0 { "/" } else { &pattern[..index] }.to_string(),
            pattern[index + 1..].to_string(),
        ),
        None => (String::new(), pattern.to_string()),
    }
}

/// Remote paths are POSIX strings even when the controller runs on Windows.
pub fn derive_remote_walk_root(search_dir: &str, pattern: &str) -> (String, String) {
    let (base_dir, relative_pattern) = extract_remote_glob_base_directory(pattern);
    if base_dir.is_empty()
        || base_dir.starts_with('/')
        || base_dir.split('/').any(|component| component == "..")
    {
        return (search_dir.to_string(), pattern.to_string());
    }
    let suffix = base_dir
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect::<Vec<_>>()
        .join("/");
    let root = if suffix.is_empty() {
        search_dir.to_string()
    } else {
        format!("{}/{suffix}", search_dir.trim_end_matches('/'))
    };
    (root, relative_pattern)
}

pub fn resolve_glob_config(pattern: &str) -> (bool, bool) {
    let hidden_directory = openbitfun_core_types::product_identity::hidden_data_directory();
    let is_whitelisted = pattern.starts_with(hidden_directory)
        || pattern.contains(&format!("/{hidden_directory}"))
        || pattern.contains(&format!("\\{hidden_directory}"));

    let apply_gitignore = !is_whitelisted;
    let ignore_hidden_files = !is_whitelisted;
    (apply_gitignore, ignore_hidden_files)
}

fn native_glob_relative_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        normalize_path(path)
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn relativize_remote_stdout_path(search_dir: &str, path: &str) -> String {
    let normalized_path = path.strip_prefix("./").unwrap_or(path);
    let search_dir_with_slash = format!("{}/", search_dir.trim_end_matches('/'));

    if let Some(relative_path) = normalized_path.strip_prefix(&search_dir_with_slash) {
        return relative_path.to_string();
    }
    if normalized_path == search_dir {
        return String::new();
    }

    normalized_path.to_string()
}

struct LocalGlobWorker<'a> {
    collector: Option<GlobCollector>,
    merged: &'a Mutex<GlobCollector>,
}

impl Drop for LocalGlobWorker<'_> {
    fn drop(&mut self) {
        // Each worker only locks once, after its complete traversal. A global
        // top-N candidate must also belong to its worker's top-N candidates.
        if let Some(collector) = self.collector.take() {
            self.merged
                .lock()
                .expect("glob collector lock poisoned")
                .merge(collector);
        }
    }
}

fn collect_local_glob(
    walk_root: &Path,
    relative_pattern: &str,
    apply_gitignore: bool,
    ignore_hidden_files: bool,
    limit: usize,
) -> Result<LocalGlobResult, String> {
    let matcher = WorkspaceGlobMatcher::new(relative_pattern)?;
    let worker_count = std::thread::available_parallelism().map_or(1, |count| count.get().min(12));
    let mut builder = WalkBuilder::new(walk_root);
    builder
        .ignore(apply_gitignore)
        .git_ignore(apply_gitignore)
        .git_global(apply_gitignore)
        .git_exclude(apply_gitignore)
        .hidden(ignore_hidden_files)
        .threads(worker_count);
    if apply_gitignore {
        builder.add_custom_ignore_filename(".rgignore");
    }

    let merged = Mutex::new(GlobCollector::new(limit));
    builder.build_parallel().run(|| {
        // Regex clones share the compiled pattern but have independent scratch
        // caches, avoiding contention between traversal workers.
        let matcher = matcher.clone();
        let mut worker = LocalGlobWorker {
            collector: Some(GlobCollector::new(limit)),
            merged: &merged,
        };
        Box::new(move |entry| {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    warn!("Glob walker entry error (skipped): {}", error);
                    return WalkState::Continue;
                }
            };
            if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return WalkState::Continue;
            }
            let relative_path = match entry.path().strip_prefix(walk_root) {
                Ok(relative) => native_glob_relative_path(relative),
                Err(_) => return WalkState::Continue,
            };
            if matcher.is_match(&relative_path) {
                worker
                    .collector
                    .as_mut()
                    .expect("glob worker collector available during traversal")
                    .push(relative_path);
            }
            WalkState::Continue
        })
    });
    let (matches, total) = merged
        .into_inner()
        .expect("glob collector lock poisoned")
        .finish();
    Ok(LocalGlobResult {
        matches,
        walk_root: walk_root.to_path_buf(),
        total_matches: Some(total),
        truncated: total > limit,
    })
}

pub fn limit_paths(paths: &[PathBuf], limit: usize) -> Vec<PathBuf> {
    let mut collector = GlobCollector::new(limit);
    for path in paths {
        collector.push(native_glob_relative_path(path));
    }
    collector.finish().0
}

pub fn collect_remote_glob_matches(search_dir: &str, stdout: &str, limit: usize) -> Vec<PathBuf> {
    collect_remote_limited_paths(search_dir, remote_stdout_paths(stdout), limit).0
}

fn remote_stdout_paths(stdout: &str) -> Box<dyn Iterator<Item = &str> + '_> {
    if stdout.contains('\0') {
        Box::new(stdout.split_terminator('\0'))
    } else {
        // Keep accepting the legacy newline-delimited response shape.
        Box::new(stdout.lines())
    }
}

fn collect_remote_limited_paths<'a>(
    search_dir: &str,
    paths: impl Iterator<Item = &'a str>,
    limit: usize,
) -> (Vec<PathBuf>, usize) {
    let mut collector = GlobCollector::new(limit);
    for path in paths.filter(|path| !path.is_empty()) {
        collector.push(relativize_remote_stdout_path(search_dir, path));
    }
    collector.finish()
}

pub fn collect_remote_glob_result(
    search_dir: &str,
    stdout: &str,
    limit: usize,
    exact_total: bool,
) -> LocalGlobResult {
    let (matches, observed_matches) =
        collect_remote_limited_paths(search_dir, remote_stdout_paths(stdout), limit);
    let truncated = observed_matches > limit;
    let total_matches = if exact_total || !truncated {
        Some(observed_matches)
    } else {
        None
    };

    LocalGlobResult {
        matches,
        walk_root: PathBuf::from(search_dir),
        total_matches,
        truncated,
    }
}

/// A dependency-free workspace-IO fallback. It shares matching and bounded
/// collection with the native walker and never weakens the pattern to find -name.
///
/// Ignore discovery is confined to the supplied search scope. The native/rg
/// acceleration paths retain their target Git/global configuration discovery;
/// callers must not present this fallback as supporting configuration outside
/// the authorized scope. Only `limit` result paths are retained, rather than
/// buffering one shell output for the entire tree.
pub async fn collect_workspace_glob(
    fs: &dyn WorkspaceFileSystem,
    search_dir: &str,
    pattern: &str,
    limit: usize,
) -> Result<LocalGlobResult, String> {
    match fs
        .path_kind_no_follow(search_dir)
        .await
        .map_err(|error| error.to_string())?
    {
        Some(WorkspacePathKind::Directory) => {}
        None => return Err(format!("Search path '{search_dir}' does not exist")),
        Some(_) => return Err(format!("Search path '{search_dir}' is not a directory")),
    }
    let (base, relative) = extract_remote_glob_base_directory(pattern);
    let safe_prefix = !base.starts_with('/') && !base.split('/').any(|part| part == "..");
    let (prefix, relative_pattern) = if safe_prefix {
        (
            base.split('/')
                .filter(|part| !part.is_empty() && *part != ".")
                .map(str::to_string)
                .collect::<Vec<_>>(),
            relative,
        )
    } else {
        (Vec::new(), pattern.to_string())
    };
    let matcher = WorkspaceGlobMatcher::new(&relative_pattern)?;
    let (apply_ignore, hide_hidden) = resolve_glob_config(pattern);
    let mut walk_root = search_dir.to_string();
    let mut initial_rules = Vec::new();
    for (depth, component) in prefix.iter().enumerate() {
        if apply_ignore {
            let entries = fs
                .read_dir(&walk_root)
                .await
                .map_err(|error| format!("Failed to list {walk_root}: {error}"))?;
            add_directory_ignores(fs, &entries, depth, &mut initial_rules).await?;
        }
        walk_root = fs.join_path(&walk_root, &[component]);
        match fs
            .path_kind_no_follow(&walk_root)
            .await
            .map_err(|error| error.to_string())?
        {
            Some(WorkspacePathKind::Directory) => {}
            _ => {
                return Ok(LocalGlobResult {
                    matches: Vec::new(),
                    walk_root: PathBuf::from(walk_root),
                    total_matches: Some(0),
                    truncated: false,
                })
            }
        }
    }
    if limit == 0 {
        return Ok(LocalGlobResult {
            matches: Vec::new(),
            walk_root: PathBuf::from(walk_root),
            total_matches: Some(0),
            truncated: false,
        });
    }
    let mut walker = WorkspaceFileWalker::with_scope(
        fs,
        walk_root.clone(),
        prefix,
        initial_rules,
        hide_hidden,
        apply_ignore,
    );
    let mut collector = GlobCollector::new(limit);
    while let Some(file) = walker.next().await? {
        if matcher.is_match(&file.relative_path) {
            collector.push(file.relative_path);
        }
    }
    let (matches, total) = collector.finish();
    Ok(LocalGlobResult {
        matches,
        walk_root: PathBuf::from(walk_root),
        total_matches: Some(total),
        truncated: total > limit,
    })
}

pub fn validate_remote_glob_exit(exit_code: i32, stderr: &str) -> Result<(), String> {
    if exit_code == 0 || exit_code == 1 {
        return Ok(());
    }
    let details = stderr.trim();
    Err(if details.is_empty() {
        format!("Remote glob failed with exit code {exit_code}")
    } else {
        format!("Remote glob failed with exit code {exit_code}: {details}")
    })
}

pub fn execute_local_glob(request: LocalGlobRequest) -> Result<LocalGlobResult, String> {
    if !request.search_path.exists() {
        return Err(format!(
            "Search path '{}' does not exist",
            request.search_path.display()
        ));
    }
    if !request.search_path.is_dir() {
        return Err(format!(
            "Search path '{}' is not a directory",
            request.search_path.display()
        ));
    }

    let search_path_abs =
        dunce::canonicalize(&request.search_path).map_err(|error| error.to_string())?;
    let (walk_root, relative_pattern) = derive_walk_root(&search_path_abs, &request.pattern);
    let (apply_gitignore, ignore_hidden_files) = resolve_glob_config(&request.pattern);

    if !walk_root.exists() || !walk_root.is_dir() || request.limit == 0 {
        return Ok(LocalGlobResult {
            matches: Vec::new(),
            walk_root,
            total_matches: Some(0),
            truncated: false,
        });
    }

    info!(
        "Glob backend selected: backend=native_walk, search_root={}, pattern={}",
        walk_root.display(),
        relative_pattern
    );
    collect_local_glob(
        &walk_root,
        &relative_pattern,
        apply_gitignore,
        ignore_hidden_files,
        request.limit,
    )
}

pub fn build_remote_rg_command(search_dir: &str, pattern: &str) -> String {
    let (remote_walk_root, remote_pattern) = derive_remote_walk_root(search_dir, pattern);
    let (apply_gitignore, ignore_hidden_files) = resolve_glob_config(pattern);

    let mut parts = vec![
        "(cd".to_string(),
        shell_single_quote(&remote_walk_root),
        "|| exit 2;".to_string(),
        "rg".to_string(),
        "--no-config".to_string(),
        "--files".to_string(),
        "--null".to_string(),
        "--glob".to_string(),
        shell_single_quote(&remote_pattern),
    ];

    if !apply_gitignore {
        parts.push("--no-ignore".to_string());
    }

    if !ignore_hidden_files {
        parts.push("--hidden".to_string());
    }

    parts.push(".".to_string());
    parts.push(")".to_string());
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::{
        collect_local_glob, derive_remote_walk_root, execute_local_glob,
        extract_glob_base_directory, normalize_path, LocalGlobRequest, WorkspaceGlobMatcher,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn path(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn make_temp_dir(name: &str) -> TempTree {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("openbitfun-glob-search-{name}-{unique}"));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        TempTree { root: dir }
    }

    fn normalized(path: &Path) -> String {
        normalize_path(path)
    }

    fn search(root: &Path, pattern: &str, limit: usize) -> super::LocalGlobResult {
        execute_local_glob(LocalGlobRequest {
            search_path: root.to_path_buf(),
            pattern: pattern.to_string(),
            limit,
        })
        .expect("local glob should succeed")
    }

    #[test]
    fn local_glob_applies_ignore_precedence_before_pattern_matching() {
        let temp = make_temp_dir("ignore-precedence");
        let root = temp.path();
        for directory in [".git/info", "src/nested", "ignored", ".hidden"] {
            fs::create_dir_all(root.join(directory)).unwrap();
        }
        fs::write(root.join(".gitignore"), "git.rs\nrestored.rs\nignored/\n").unwrap();
        fs::write(root.join(".ignore"), "dot.rs\nrestored.rs\n").unwrap();
        fs::write(root.join(".rgignore"), "rg.rs\n!restored.rs\n").unwrap();
        fs::write(root.join(".git/info/exclude"), "excluded.rs\n").unwrap();
        fs::write(root.join("src/.gitignore"), "private.rs\n").unwrap();
        fs::write(root.join("src/.rgignore"), "nested-rg.rs\n").unwrap();
        for name in [
            "visible.rs",
            "git.rs",
            "dot.rs",
            "rg.rs",
            "restored.rs",
            "excluded.rs",
            ".hidden.rs",
            "ignored/file.rs",
            ".hidden/file.rs",
            "src/lib.rs",
            "src/nested/private.rs",
            "src/nested/nested-rg.rs",
            "src/nested/public.rs",
        ] {
            fs::write(root.join(name), "").unwrap();
        }
        let expected = [
            "restored.rs",
            "src/lib.rs",
            "src/nested/public.rs",
            "visible.rs",
        ]
        .map(PathBuf::from)
        .to_vec();
        for pattern in ["**/*.rs", "*.rs", "*", "**/*"] {
            let result = search(root, pattern, 100);
            assert_eq!(result.matches, expected, "pattern: {pattern}");
            assert_eq!(result.total_matches, Some(4));
            assert!(!result.truncated);
        }
        // Static scopes still read ignore files from their ancestors.
        let scoped = search(root, "src/**/*.rs", 100);
        assert_eq!(
            scoped.matches,
            ["lib.rs", "nested/public.rs"].map(PathBuf::from)
        );
    }

    #[test]
    fn local_glob_preserves_explicit_hidden_root_and_product_directory_exception() {
        let temp = make_temp_dir("hidden-roots");
        let root = temp.path();
        fs::create_dir(root.join(".hidden")).unwrap();
        fs::write(root.join(".hidden/public.rs"), "").unwrap();
        fs::write(root.join(".hidden/.secret.rs"), "").unwrap();
        fs::write(root.join(".hidden/.rgignore"), "ignored.rs\n").unwrap();
        fs::write(root.join(".hidden/ignored.rs"), "").unwrap();
        assert!(search(root, "**/*.rs", 100).matches.is_empty());
        assert_eq!(
            search(root, ".hidden/**/*.rs", 100).matches,
            vec![PathBuf::from("public.rs")]
        );

        let product_directory = openbitfun_core_types::product_identity::hidden_data_directory();
        fs::create_dir(root.join(product_directory)).unwrap();
        fs::write(root.join(product_directory).join(".rgignore"), "*.rs\n").unwrap();
        fs::write(root.join(product_directory).join(".secret.rs"), "").unwrap();
        fs::write(root.join(product_directory).join("public.rs"), "").unwrap();
        let result = search(root, &format!("{product_directory}/**/*.rs"), 100);
        assert_eq!(
            result.matches,
            [".secret.rs", "public.rs"].map(PathBuf::from)
        );
        assert_eq!(result.total_matches, Some(2));
    }

    #[test]
    fn parallel_local_glob_keeps_stable_top_results_and_exact_totals() {
        let temp = make_temp_dir("parallel-top-results");
        let root = temp.path();
        for directory in 0..16 {
            let path = root.join(format!("dir{directory:02}/deep"));
            fs::create_dir_all(&path).unwrap();
            for file in 0..20 {
                fs::write(path.join(format!("file{file:02}.rs")), "").unwrap();
            }
            fs::write(root.join(format!("top{directory:02}.rs")), "").unwrap();
        }
        let complete = search(root, "**/*.rs", 1000);
        assert_eq!(complete.total_matches, Some(336));
        assert!(!complete.truncated);
        // Compute expected depth/path selection independently of worker grouping.
        let mut expected = complete.matches.clone();
        expected.sort_by_key(|path| (normalized(path).split('/').count(), normalized(path)));
        expected.truncate(100);
        expected.sort();
        for _ in 0..5 {
            let limited = search(root, "**/*.rs", 100);
            assert_eq!(limited.matches, expected);
            assert_eq!(limited.total_matches, Some(336));
            assert!(limited.truncated);
        }
        let exact = search(root, "**/*.rs", 336);
        assert_eq!(exact.matches, complete.matches);
        assert!(!exact.truncated);
        let zero = search(root, "**/*.rs", 0);
        assert!(zero.matches.is_empty());
        assert_eq!(zero.total_matches, Some(0));
    }

    #[test]
    fn local_glob_rejects_invalid_patterns_and_missing_search_roots() {
        let temp = make_temp_dir("invalid-pattern");
        let request = |path: PathBuf, pattern: &str| LocalGlobRequest {
            search_path: path,
            pattern: pattern.to_string(),
            limit: 100,
        };
        assert!(execute_local_glob(request(temp.path().to_path_buf(), "[")).is_err());
        assert!(
            execute_local_glob(request(temp.path().join("missing"), "*"))
                .unwrap_err()
                .contains("does not exist")
        );
        let file = temp.path().join("file.rs");
        fs::write(&file, "").unwrap();
        assert!(execute_local_glob(request(file, "*"))
            .unwrap_err()
            .contains("not a directory"));
        assert!(search(temp.path(), "missing/*.rs", 100).matches.is_empty());
    }

    #[test]
    fn local_walk_returns_files_only_and_matches_basename_globs() {
        let temp = make_temp_dir("files-only");
        let root = temp.path();
        fs::create_dir_all(root.join("src").join("nested")).expect("dirs should be created");
        fs::write(root.join("src").join("nested").join("lib.rs"), "")
            .expect("file should be written");

        let wildcard_matches = collect_local_glob(root, "*", false, false, 10)
            .expect("local glob should succeed")
            .matches
            .into_iter()
            .map(|path| normalized(&path))
            .collect::<Vec<_>>();

        assert!(wildcard_matches
            .iter()
            .all(|path| !path.ends_with("/src") && !path.ends_with("/src/nested")));
        assert!(wildcard_matches
            .iter()
            .any(|path| path == "src/nested/lib.rs"));

        let rust_matches = collect_local_glob(root, "*.rs", false, false, 10)
            .expect("local rust glob should succeed")
            .matches
            .into_iter()
            .map(|path| normalized(&path))
            .collect::<Vec<_>>();
        assert_eq!(rust_matches.len(), 1);
        assert_eq!(rust_matches[0], "src/nested/lib.rs");

        let directory_name_matches = collect_local_glob(root, "src", false, false, 10)
            .expect("local directory-name glob should succeed");
        assert!(directory_name_matches.matches.is_empty());
        assert_eq!(directory_name_matches.total_matches, Some(0));
        assert!(!directory_name_matches.truncated);
    }

    #[test]
    fn extract_glob_base_directory_preserves_absolute_roots() {
        assert_eq!(
            extract_glob_base_directory("/*.txt"),
            ("/".to_string(), "*.txt".to_string())
        );

        #[cfg(windows)]
        assert_eq!(
            extract_glob_base_directory("C:/*.txt"),
            ("C:/".to_string(), "*.txt".to_string())
        );
    }

    #[test]
    fn shared_glob_matcher_keeps_posix_backslashes_and_complete_patterns() {
        let matcher = WorkspaceGlobMatcher::new(r"a\\b.rs").unwrap();
        assert!(matcher.is_match(r"a\b.rs"));
        assert!(!matcher.is_match("a/b.rs"));
        let matcher = WorkspaceGlobMatcher::new("**/src/*.{rs,ts}").unwrap();
        assert!(matcher.is_match(&format!("{}src/file.rs", "level/".repeat(12))));
        assert!(!matcher.is_match("other/not-src/file.rs"));
        assert!(!matcher.is_match("other/src/file.js"));
        assert_eq!(
            derive_remote_walk_root(r"/repo\name/", r"src\cache/*.rs"),
            (r"/repo\name/".to_string(), r"src\cache/*.rs".to_string())
        );
        assert_eq!(
            derive_remote_walk_root("/", "src/*.rs"),
            ("/src".to_string(), "*.rs".to_string())
        );
    }

    #[test]
    fn escaped_static_prefix_is_matched_without_becoming_a_literal_walk_root() {
        for (pattern, file) in [
            (r"a\\b/*.rs", r"a\b/source.rs"),
            (r"a\ space/*.rs", "a space/source.rs"),
            (r"literal\?/nested/*.rs", "literal?/nested/source.rs"),
        ] {
            assert_eq!(
                derive_remote_walk_root("/repo", pattern),
                ("/repo".to_string(), pattern.to_string())
            );
            assert!(WorkspaceGlobMatcher::new(pattern).unwrap().is_match(file));
            #[cfg(not(windows))]
            assert_eq!(
                super::derive_walk_root(Path::new("/repo"), pattern),
                (PathBuf::from("/repo"), pattern.to_string())
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn local_walk_uses_the_shared_posix_matcher_for_backslash_names() {
        let temp = make_temp_dir("posix-names");
        fs::write(temp.path().join(r"a\b.rs"), "").unwrap();
        let result = collect_local_glob(temp.path(), r"a\\b.rs", false, false, 10).unwrap();
        assert_eq!(result.matches, vec![PathBuf::from(r"a\b.rs")]);
        assert_eq!(result.total_matches, Some(1));
    }

    #[cfg(unix)]
    #[test]
    fn local_glob_preserves_newline_file_names_without_a_stdout_protocol() {
        let temp = make_temp_dir("newline-name");
        fs::write(temp.path().join("line\nname.rs"), "").unwrap();
        let result = search(temp.path(), "*.rs", 100);
        assert_eq!(result.matches, vec![PathBuf::from("line\nname.rs")]);
        assert_eq!(result.total_matches, Some(1));
    }
}
