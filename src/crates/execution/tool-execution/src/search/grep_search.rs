use crate::util::string::shell_single_quote;
use log::{debug, info, warn};
use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

pub use super::workspace_grep_prefilter::content_search_candidate_literal;
use super::workspace_grep_prefilter::{
    grep_batch_command, grep_probe_command, literal_alternatives, parse_grep_batch_output,
    recursive_grep_candidate_command, MAX_GREP_BATCH_COMMAND_BYTES, MAX_GREP_BATCH_PATHS,
};
use globset::GlobBuilder;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
use ignore::types::TypesBuilder;
use ignore::{DirEntry, WalkBuilder, WalkState};
use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspacePathKind, WorkspaceShell};
use std::collections::HashSet;

const MAX_DISPLAY_COLUMNS: usize = 500;
const MAX_VIRTUAL_GREP_CONTENT_LINES: usize = 4096;
const VCS_DIRECTORIES_TO_EXCLUDE: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
const CANDIDATE_COMMAND_TIMEOUT_MS: u64 = 30_000;
/// Interactive search has its own overall deadline and scans whole workspaces
/// without a narrowing path, so its one candidate command gets most of that budget.
const INTERACTIVE_CANDIDATE_COMMAND_TIMEOUT_MS: u64 = 100_000;

/// Output mode enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Content,
    FilesWithMatches,
    Count,
}

impl std::str::FromStr for OutputMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "content" => Ok(OutputMode::Content),
            "count" => Ok(OutputMode::Count),
            "files_with_matches" => Ok(OutputMode::FilesWithMatches),
            _ => Err(format!("Unknown output mode: {}", s)),
        }
    }
}

impl fmt::Display for OutputMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OutputMode::Content => write!(f, "content"),
            OutputMode::Count => write!(f, "count"),
            OutputMode::FilesWithMatches => write!(f, "files_with_matches"),
        }
    }
}

/// Sink implementation for collecting search results
#[derive(Clone)]
struct GrepSink {
    output_mode: OutputMode,
    show_line_numbers: bool,
    before_context: usize,
    after_context: usize,
    head_limit: Option<usize>,
    /// Retain this many final physical output lines without stopping matching.
    output_budget: Option<usize>,
    current_file: PathBuf,
    display_base: Option<String>,
    display_path: Option<String>,
    output: Arc<Mutex<Vec<String>>>,
    line_count: Arc<Mutex<usize>>,
    match_count: Arc<Mutex<usize>>,
    /// Last output line number, used to detect discontinuity
    last_line_number: Arc<Mutex<Option<u64>>>,
}

fn lock_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("Mutex poisoned in grep search: {}", name);
            poisoned.into_inner()
        }
    }
}

impl GrepSink {
    fn new(
        output_mode: OutputMode,
        show_line_numbers: bool,
        before_context: usize,
        after_context: usize,
        head_limit: Option<usize>,
        current_file: PathBuf,
        display_base: Option<String>,
    ) -> Self {
        Self {
            output_mode,
            show_line_numbers,
            before_context,
            after_context,
            head_limit,
            output_budget: None,
            current_file,
            display_base,
            display_path: None,
            output: Arc::new(Mutex::new(Vec::new())),
            line_count: Arc::new(Mutex::new(0)),
            match_count: Arc::new(Mutex::new(0)),
            last_line_number: Arc::new(Mutex::new(None)),
        }
    }

    fn with_display_path(mut self, display_path: String) -> Self {
        self.display_path = Some(display_path);
        self
    }

    /// Limit retained output independently of the existing search stop limit.
    /// Budget includes context and separators and uses the reducer's physical
    /// line units. None is unbounded; Some(0) counts matches without retaining
    /// text. Pass offset + head_limit after normalizing user head_limit=0 to None.
    fn with_output_budget(mut self, output_budget: Option<usize>) -> Self {
        self.output_budget = output_budget;
        self
    }

    /// Takes the collected output lines, avoiding a split/realloc/join round
    /// trip at the call site.
    fn take_output_lines(&self) -> Vec<String> {
        std::mem::take(&mut *lock_recover(&self.output, "output"))
    }

    fn get_match_count(&self) -> usize {
        *lock_recover(&self.match_count, "match_count")
    }

    fn should_stop(&self) -> bool {
        if let Some(limit) = self.head_limit {
            let count = *lock_recover(&self.line_count, "line_count");
            count >= limit
        } else {
            false
        }
    }

    fn increment_line_count(&self) -> bool {
        let mut count = lock_recover(&self.line_count, "line_count");
        *count += 1;
        if let Some(limit) = self.head_limit {
            *count <= limit
        } else {
            true
        }
    }

    fn has_output_capacity(&self) -> bool {
        self.output_budget
            .is_none_or(|budget| lock_recover(&self.output, "output").len() < budget)
    }

    fn retain_output(&self, line: String) {
        let mut output = lock_recover(&self.output, "output");
        let Some(budget) = self.output_budget else {
            // Keep the original representation for native/virtual consumers.
            output.push(line);
            return;
        };
        let remaining = budget.saturating_sub(output.len());
        if remaining == 0 {
            return;
        }
        // Match reduce_grep_results exactly, including empty physical lines
        // within a multiline match. The retained prefix can still be paginated
        // by the existing reducer without changing context or separator output.
        if line.contains('\n') {
            output.extend(
                line.lines()
                    .filter(|part| !part.is_empty())
                    .take(remaining)
                    .map(str::to_string),
            );
        } else if !line.is_empty() {
            output.push(line);
        }
    }

    fn write_line(&self, format: impl FnOnce() -> String) {
        if self.increment_line_count() && self.has_output_capacity() {
            self.retain_output(format());
        }
    }

    /// Check if separator (--) needs to be inserted before current line
    /// Insert when previous line and current line are not continuous (only when context is set)
    fn check_and_write_separator(&self, current_line: u64) {
        // Only use separator when context is set (consistent with rg behavior)
        if self.before_context == 0 && self.after_context == 0 {
            return;
        }

        let mut last_line = lock_recover(&self.last_line_number, "last_line_number");
        if let Some(last) = *last_line {
            // If current line number is not continuous with previous line (difference > 1), insert separator
            if current_line > last + 1 && self.has_output_capacity() {
                self.retain_output("--".to_string());
            }
        }
        *last_line = Some(current_line);
    }

    /// Format output line (rg style: only show line number and content, no path)
    fn format_line(&self, line_number: u64, line: &[u8], is_match: bool) -> String {
        let mut line_str = String::from_utf8_lossy(line).trim_end().to_string();
        if line_str.chars().count() > MAX_DISPLAY_COLUMNS {
            line_str = format!(
                "{} [truncated]",
                line_str
                    .chars()
                    .take(MAX_DISPLAY_COLUMNS)
                    .collect::<String>()
            );
        }
        let separator = if is_match { ":" } else { "-" };
        let path_prefix = self.display_path.clone().unwrap_or_else(|| {
            relativize_display_path(&self.current_file, self.display_base.as_deref())
        });

        if self.show_line_numbers {
            format!("{}{}{}:{}", path_prefix, separator, line_number, line_str)
        } else {
            format!("{}{}{}", path_prefix, separator, line_str)
        }
    }
}

impl Sink for GrepSink {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.should_stop() {
            return Ok(false);
        }

        *lock_recover(&self.match_count, "match_count") += 1;

        match self.output_mode {
            OutputMode::Content => {
                let line_number = mat.line_number().unwrap_or(0);
                // Check if separator needs to be inserted
                self.check_and_write_separator(line_number);
                self.write_line(|| self.format_line(line_number, mat.bytes(), true));
            }
            OutputMode::FilesWithMatches => {
                return Ok(false); // Only need first match, then stop
            }
            OutputMode::Count => {
                // Count mode doesn't write here, handled uniformly at the end
            }
        }

        Ok(!self.should_stop())
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        ctx: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        if self.should_stop() {
            return Ok(false);
        }

        // Only output context lines in content mode and when context is set
        if matches!(self.output_mode, OutputMode::Content)
            && (self.before_context > 0 || self.after_context > 0)
        {
            let line_number = ctx.line_number().unwrap_or(0);
            // Check if separator needs to be inserted
            self.check_and_write_separator(line_number);
            self.write_line(|| self.format_line(line_number, ctx.bytes(), false));
        }

        Ok(!self.should_stop())
    }

    fn begin(&mut self, _searcher: &Searcher) -> Result<bool, Self::Error> {
        Ok(!self.should_stop())
    }

    fn finish(
        &mut self,
        _searcher: &Searcher,
        _: &grep_searcher::SinkFinish,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "grep_sink_tests.rs"]
mod sink_tests;

/// Progress report callback type
pub type ProgressCallback = Arc<dyn Fn(usize, usize, usize) + Send + Sync>;

/// Cooperative cancellation for an in-flight [`grep_search`].
///
/// Cheap to clone and share: the walker threads, the per-worker searchers and the reducer all hold
/// the same flag. Cancelling is one-way — a cancelled search never becomes runnable again, so a
/// caller that wants to retry builds a fresh token.
///
/// Native path searches observe cancellation between entries. Workspace stream
/// searches also wake a pending read, so dropping a timed-out caller does not
/// leave its blocking matcher waiting indefinitely for the transport.
#[derive(Debug, Clone, Default)]
pub struct SearchCancellation {
    token: tokio_util::sync::CancellationToken,
}

impl SearchCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask the search to stop. Idempotent, and safe to call from any thread.
    pub fn cancel(&self) {
        self.token.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
}

/// grep search options
#[derive(Debug, Clone)]
pub struct GrepOptions {
    /// Regular expression pattern
    pub pattern: String,
    /// Search path
    pub path: String,
    /// Whether to ignore case
    pub case_insensitive: bool,
    /// Whether to enable multiline mode
    pub multiline: bool,
    /// Output mode
    pub output_mode: OutputMode,
    /// Whether to show line numbers
    pub show_line_numbers: bool,
    /// Context line count (sets both before and after)
    pub context: Option<usize>,
    /// Context lines before match
    pub before_context: Option<usize>,
    /// Context lines after match
    pub after_context: Option<usize>,
    /// Limit output lines/files
    pub head_limit: Option<usize>,
    /// Number of lines/files to skip before limiting output
    pub offset: usize,
    /// Glob pattern filters
    pub globs: Vec<String>,
    /// File type filter
    pub file_type: Option<String>,
    /// Prefer displaying paths relative to this base when possible
    pub display_base: Option<String>,
    /// Exact files omitted from this search by the caller's scope policy.
    pub excluded_paths: Vec<String>,
    /// Reject linked file entries when the caller requires workspace identity.
    pub reject_linked_files: bool,
    /// Cooperative cancellation. `None` means the search cannot be cancelled.
    pub cancellation: Option<SearchCancellation>,
    /// Fixed string the caller has proven every match contains (see
    /// [`content_search_candidate_literal`]). `pattern` cannot always reveal it:
    /// an escaped or case-folded literal looks like complex regex to the prefilter.
    /// Only workspace-stream search reads this, and only to select candidates.
    pub candidate_literal: Option<String>,
    /// Interactive workspace-stream search: keep structured [`WorkspaceGrepLineMatch`]es
    /// and stop scanning once `head_limit` is known to be exceeded, because a person
    /// waiting on a result list wants the first page rather than exact totals.
    pub collect_line_matches: bool,
}

impl Default for GrepOptions {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: String::from("."),
            case_insensitive: false,
            multiline: false,
            output_mode: OutputMode::Content,
            show_line_numbers: true,
            context: None,
            before_context: None,
            after_context: None,
            head_limit: None,
            offset: 0,
            globs: Vec::new(),
            file_type: None,
            display_base: None,
            excluded_paths: Vec::new(),
            reject_linked_files: false,
            cancellation: None,
            candidate_literal: None,
            collect_line_matches: false,
        }
    }
}

pub fn relativize_result_text(result_text: &str, display_base: Option<&str>) -> String {
    let Some(base) = display_base else {
        return result_text.to_string();
    };

    let normalized_base = base.replace('\\', "/").trim_end_matches('/').to_string();
    if normalized_base.is_empty() {
        return result_text.to_string();
    }

    result_text
        .lines()
        .map(|line| {
            if let Some(rest) = line.strip_prefix(&(normalized_base.clone() + "/")) {
                rest.to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn apply_offset_and_limit(items: &mut Vec<String>, offset: usize, head_limit: Option<usize>) {
    if offset > 0 {
        if offset >= items.len() {
            items.clear();
        } else {
            *items = items[offset..].to_vec();
        }
    }

    if let Some(limit) = head_limit {
        if items.len() > limit {
            items.truncate(limit);
        }
    }
}

impl GrepOptions {
    /// Create a new GrepOptions with required pattern and path
    pub fn new(pattern: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            pattern: pattern.into(),
            path: path.into(),
            ..Default::default()
        }
    }

    /// Set whether to ignore case
    pub fn case_insensitive(mut self, value: bool) -> Self {
        self.case_insensitive = value;
        self
    }

    /// Attach a cancellation token so the caller can stop this search early.
    pub fn cancellation(mut self, value: SearchCancellation) -> Self {
        self.cancellation = Some(value);
        self
    }

    /// Declare a fixed string every match contains, enabling candidate selection for
    /// literal searches that `pattern` alone cannot prove.
    pub fn candidate_literal(mut self, value: Option<String>) -> Self {
        self.candidate_literal = value;
        self
    }

    /// Return structured line matches and stop scanning once the limit is exceeded.
    pub fn collect_line_matches(mut self, value: bool) -> Self {
        self.collect_line_matches = value;
        self
    }

    /// Set whether to enable multiline mode
    pub fn multiline(mut self, value: bool) -> Self {
        self.multiline = value;
        self
    }

    /// Set output mode
    pub fn output_mode(mut self, mode: OutputMode) -> Self {
        self.output_mode = mode;
        self
    }

    /// Set whether to show line numbers
    pub fn show_line_numbers(mut self, value: bool) -> Self {
        self.show_line_numbers = value;
        self
    }

    pub fn excluded_paths(mut self, paths: Vec<String>) -> Self {
        self.excluded_paths = paths;
        self
    }

    pub fn reject_linked_files(mut self, reject: bool) -> Self {
        self.reject_linked_files = reject;
        self
    }

    /// Set context line count (sets both before and after)
    pub fn context(mut self, lines: usize) -> Self {
        self.context = Some(lines);
        self
    }

    /// Set context lines before match
    pub fn before_context(mut self, lines: usize) -> Self {
        self.before_context = Some(lines);
        self
    }

    /// Set context lines after match
    pub fn after_context(mut self, lines: usize) -> Self {
        self.after_context = Some(lines);
        self
    }

    /// Set output lines/files limit
    pub fn head_limit(mut self, limit: usize) -> Self {
        self.head_limit = Some(limit);
        self
    }

    /// Set glob pattern filter
    pub fn offset(mut self, offset: usize) -> Self {
        self.offset = offset;
        self
    }

    pub fn globs(mut self, patterns: Vec<String>) -> Self {
        self.globs = patterns;
        self
    }

    /// Set file type filter
    pub fn file_type(mut self, ftype: impl Into<String>) -> Self {
        self.file_type = Some(ftype.into());
        self
    }

    pub fn display_base(mut self, base: impl Into<String>) -> Self {
        self.display_base = Some(base.into());
        self
    }
}

/// Execute grep search
///
/// # Parameters
/// - `options`: Search options
/// - `progress_callback`: Progress callback (optional)
/// - `progress_interval_millis`: Progress report interval (milliseconds, optional, default 500)
///
/// # Returns
/// - `Ok((file_count, match_count, result_text))`: Number of matching files, number of matches, and result text
/// - `Err(error_message)`: Error message
///
/// # Example
/// ```ignore
/// use tool_runtime::search::{grep_search, GrepOptions, OutputMode};
///
/// let options = GrepOptions::new("pattern", "path/to/search")
///     .case_insensitive(true)
///     .context(2);
///
/// let result = grep_search(options, None, None);
/// ```
pub struct GrepSearchResult {
    pub file_count: usize,
    pub total_matches: usize,
    pub result_text: String,
    pub applied_limit: Option<usize>,
    pub applied_offset: Option<usize>,
    /// The search stopped early because its [`SearchCancellation`] fired. Everything already
    /// aggregated is still returned — it is a correct result over the subset of the tree that was
    /// walked, not over the whole tree — so callers that care about completeness must check this.
    pub cancelled: bool,
}

#[derive(Clone)]
struct GrepWorkerConfig {
    output_mode: OutputMode,
    show_line_numbers: bool,
    before_context: usize,
    after_context: usize,
    display_base: Option<String>,
    search_root: String,
    globs: Vec<regex::bytes::Regex>,
    excluded_paths: Vec<String>,
    reject_linked_files: bool,
    output_budget: Option<usize>,
}

#[derive(Clone)]
struct GrepFileResult {
    path: PathBuf,
    display_path: Option<String>,
    file_matches: usize,
    output_lines: Vec<String>,
    modified_time: SystemTime,
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum GrepResultOrder {
    Path(std::ffi::OsString),
    Modified(std::cmp::Reverse<SystemTime>, String),
}

/// Retain only the global output prefix needed for pagination, regardless of
/// traversal/completion order. Counts describe all scanned matches. Content and
/// Count preserve native path ordering; FilesWithMatches preserves mtime then
/// display-path ordering. One extra unit proves truncation to the final reducer.
struct GrepResultCollector {
    output_mode: OutputMode,
    display_base: Option<String>,
    budget: Option<usize>,
    file_count: usize,
    total_matches: usize,
    retained_units: usize,
    files: std::collections::BTreeMap<(GrepResultOrder, usize), GrepFileResult>,
}

fn grep_output_budget(options: &GrepOptions) -> Option<usize> {
    options
        .head_limit
        .filter(|limit| *limit > 0)
        .map(|limit| options.offset.saturating_add(limit).saturating_add(1))
}

impl GrepResultCollector {
    fn new(options: &GrepOptions) -> Self {
        Self {
            output_mode: options.output_mode,
            display_base: options.display_base.clone(),
            budget: grep_output_budget(options),
            file_count: 0,
            total_matches: 0,
            retained_units: 0,
            files: std::collections::BTreeMap::new(),
        }
    }

    fn push(&mut self, mut result: GrepFileResult) {
        self.file_count += 1;
        self.total_matches += result.file_matches;
        let order = if self.output_mode == OutputMode::FilesWithMatches {
            let display_path = result.display_path.clone().unwrap_or_else(|| {
                relativize_display_path(&result.path, self.display_base.as_deref())
            });
            GrepResultOrder::Modified(std::cmp::Reverse(result.modified_time), display_path)
        } else {
            GrepResultOrder::Path(result.path.as_os_str().to_os_string())
        };
        let units = if self.output_mode == OutputMode::Content {
            // Preserve the reducer's physical-line units, including multiline
            // sink writes. Production sinks already bound each file prefix.
            result.output_lines = result
                .output_lines
                .into_iter()
                .flat_map(|line| {
                    if line.contains('\n') {
                        line.lines()
                            .filter(|part| !part.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    } else if line.is_empty() {
                        Vec::new()
                    } else {
                        vec![line]
                    }
                })
                .take(self.budget.unwrap_or(usize::MAX))
                .collect();
            if result.output_lines.is_empty() {
                return;
            }
            result.output_lines.len()
        } else {
            1
        };
        self.retained_units += units;
        self.files.insert((order, self.file_count), result);
        if let Some(budget) = self.budget {
            while self.retained_units > budget {
                let mut last = self.files.last_entry().expect("retained result exists");
                let units = if self.output_mode == OutputMode::Content {
                    last.get().output_lines.len()
                } else {
                    1
                };
                let excess = self.retained_units - budget;
                if units > excess {
                    last.get_mut().output_lines.truncate(units - excess);
                    self.retained_units -= excess;
                } else {
                    last.remove();
                    self.retained_units -= units;
                }
            }
        }
    }

    /// The retained prefix already proves truncation, so further matches cannot
    /// change what a caller that accepts unsorted first results will show.
    fn budget_exhausted(&self) -> bool {
        self.budget
            .is_some_and(|budget| self.retained_units >= budget)
    }

    /// Recover structured matches from the sink's `path:line:text` rendering. The
    /// file's own display path is the prefix, so a `:` in a path stays unambiguous.
    fn line_matches(&self) -> Vec<WorkspaceGrepLineMatch> {
        let mut matches = Vec::with_capacity(self.retained_units);
        for file in self.files.values() {
            let Some(prefix) = file.display_path.as_deref() else {
                continue;
            };
            let path = file.path.to_string_lossy();
            for line in &file.output_lines {
                let parsed = line
                    .strip_prefix(prefix)
                    .and_then(|rest| rest.strip_prefix(':'))
                    .and_then(|rest| rest.split_once(':'))
                    .and_then(|(number, text)| Some((number.parse().ok()?, text)));
                if let Some((line_number, text)) = parsed {
                    matches.push(WorkspaceGrepLineMatch {
                        path: path.to_string(),
                        line_number,
                        text: text.to_string(),
                    });
                }
            }
        }
        matches
    }

    fn finish(self, options: &GrepOptions, cancelled: bool) -> Result<GrepSearchResult, String> {
        reduce_grep_results_with_totals(
            options,
            self.files.into_values().collect(),
            cancelled,
            self.file_count,
            self.total_matches,
        )
    }
}

enum GrepWorkerEvent {
    Processed(Option<GrepFileResult>),
    Error(String),
}

fn native_search_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy().replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

fn build_grep_globs(patterns: &[String]) -> Result<Vec<regex::bytes::Regex>, String> {
    patterns
        .iter()
        .map(|pattern| {
            let glob = GlobBuilder::new(pattern)
                .backslash_escape(true)
                .build()
                .map_err(|error| format!("Invalid glob pattern: {error}"))?;
            regex::bytes::Regex::new(glob.regex())
                .map_err(|error| format!("Invalid glob pattern: {error}"))
        })
        .collect()
}

/// Relative filters address the requested search root. Keep absolute patterns
/// and basename filters working too, without interpreting POSIX paths through
/// the controller's platform-specific Path implementation.
fn grep_globs_match(globs: &[regex::bytes::Regex], path: &str, search_root: &str) -> bool {
    if globs.is_empty() {
        return true;
    }
    let path = workspace_search_path(path);
    let root = workspace_search_path(search_root);
    let relative = path
        .strip_prefix(&format!("{}/", root.trim_end_matches('/')))
        .unwrap_or(&path);
    let basename = path.rsplit('/').next().unwrap_or(&path);
    globs.iter().any(|glob| {
        glob.is_match(path.as_bytes())
            || glob.is_match(relative.as_bytes())
            || glob.is_match(basename.as_bytes())
    })
}

fn build_grep_matcher(options: &GrepOptions) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(options.case_insensitive)
        .multi_line(options.multiline)
        .dot_matches_new_line(options.multiline)
        .build(&options.pattern)
        .map_err(|error| format!("Invalid regex pattern: {error}"))
}

fn build_grep_file_types(file_type: Option<&str>) -> Result<TypesBuilder, String> {
    let mut types_builder = TypesBuilder::new();
    types_builder.add_defaults();

    types_builder
        .add("arkts", "*.ets")
        .map_err(|e| format!("Failed to add arkts type: {}", e))?;
    types_builder
        .add("json", "*.json5")
        .map_err(|e| format!("Failed to add json5 type: {}", e))?;

    if let Some(ftype) = file_type {
        // Check if type already exists
        let type_exists = types_builder
            .definitions()
            .iter()
            .any(|def| def.name() == ftype);

        if !type_exists {
            // Type doesn't exist, automatically add *.{ftype}
            let glob_pattern = format!("*.{}", ftype);
            types_builder
                .add(ftype, &glob_pattern)
                .map_err(|e| format!("Failed to add file type '{}': {}", ftype, e))?;
            debug!(
                "Auto-added file type '{}' with glob '{}'",
                ftype, glob_pattern
            );
        }

        // User specified type, use user-specified type
        types_builder.select(ftype);
    }

    Ok(types_builder)
}

fn build_grep_searcher(before_context: usize, after_context: usize, multiline: bool) -> Searcher {
    let mut builder = SearcherBuilder::new();
    builder
        .line_number(true)
        .before_context(before_context)
        .after_context(after_context);
    if multiline {
        builder.multi_line(true);
    }
    builder.build()
}

fn search_entry(
    entry: Result<DirEntry, ignore::Error>,
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    config: &GrepWorkerConfig,
) -> GrepWorkerEvent {
    let entry = match entry {
        Ok(entry) => entry,
        Err(error) => return GrepWorkerEvent::Error(format!("Error walking files: {error}")),
    };
    let path = entry.path();

    let entry_file_type = entry.file_type();
    let is_file = entry_file_type
        .is_some_and(|file_type| file_type.is_file() || (file_type.is_symlink() && path.is_file()));
    if !is_file {
        return GrepWorkerEvent::Processed(None);
    }

    let path_is_symlink = entry_file_type.is_some_and(|file_type| file_type.is_symlink());
    let path_has_multiple_hard_links =
        config.reject_linked_files && crate::fs::path_has_multiple_hard_links(path).unwrap_or(true);
    if config.reject_linked_files && (path_is_symlink || path_has_multiple_hard_links) {
        return GrepWorkerEvent::Processed(None);
    }
    if config
        .excluded_paths
        .iter()
        .any(|excluded| paths_equal_for_exclusion(path, excluded))
        || is_vcs_path(path)
        || !grep_globs_match(
            &config.globs,
            &native_search_path(path),
            &config.search_root,
        )
    {
        return GrepWorkerEvent::Processed(None);
    }

    let sink = GrepSink::new(
        config.output_mode,
        config.show_line_numbers,
        config.before_context,
        config.after_context,
        None,
        path.to_path_buf(),
        config.display_base.clone(),
    )
    .with_output_budget(config.output_budget);
    if let Err(error) = searcher.search_path(matcher, path, sink.clone()) {
        return GrepWorkerEvent::Error(format!("Error searching file {}: {error}", path.display()));
    }

    let file_matches = sink.get_match_count();
    if file_matches == 0 {
        return GrepWorkerEvent::Processed(None);
    }
    let output_lines = if config.output_mode == OutputMode::Content {
        sink.take_output_lines()
    } else {
        Vec::new()
    };
    GrepWorkerEvent::Processed(Some(GrepFileResult {
        path: path.to_path_buf(),
        display_path: None,
        file_matches,
        output_lines,
        modified_time: modified_time(path),
    }))
}

fn is_vcs_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::Normal(name)
                if VCS_DIRECTORIES_TO_EXCLUDE
                    .iter()
                    .any(|excluded| name.to_string_lossy() == *excluded)
        )
    })
}

fn modified_time(path: &Path) -> SystemTime {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn relativize_display_path(path: &Path, display_base: Option<&str>) -> String {
    let base = display_base.map(|base| native_search_path(Path::new(base)));
    workspace_display_path(&native_search_path(path), base.as_deref())
}

fn apply_offset_limit<T>(
    items: Vec<T>,
    limit: Option<usize>,
    offset: usize,
) -> (Vec<T>, Option<usize>, Option<usize>)
where
    T: Clone,
{
    let total_len = items.len();
    let sliced = match limit {
        Some(limit) => items
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>(),
        None => items.into_iter().skip(offset).collect::<Vec<_>>(),
    };

    let applied_limit = match limit {
        Some(limit) if total_len.saturating_sub(offset) > limit => Some(limit),
        _ => None,
    };
    let applied_offset = if offset > 0 { Some(offset) } else { None };

    (sliced, applied_limit, applied_offset)
}

pub fn grep_search(
    options: GrepOptions,
    progress_callback: Option<ProgressCallback>,
    progress_interval_millis: Option<u128>,
) -> Result<GrepSearchResult, String> {
    let search_path = &options.path;

    // Validate that search path exists
    let path = std::path::Path::new(search_path);
    if !path.exists() {
        return Err(format!("Search path '{}' does not exist", search_path));
    }

    let cancellation = options.cancellation.clone();
    let is_cancelled = move || {
        cancellation
            .as_ref()
            .is_some_and(SearchCancellation::is_cancelled)
    };
    if is_cancelled() {
        return Ok(GrepSearchResult {
            file_count: 0,
            total_matches: 0,
            result_text: String::new(),
            applied_limit: None,
            applied_offset: None,
            cancelled: true,
        });
    }

    let before_context = options
        .before_context
        .unwrap_or(options.context.unwrap_or(0));
    let after_context = options
        .after_context
        .unwrap_or(options.context.unwrap_or(0));
    let multiline = options.multiline;
    let output_mode = options.output_mode;
    let show_line_numbers = options.show_line_numbers;
    let file_type = options.file_type.as_deref();
    let display_base = options.display_base.clone();

    let matcher = build_grep_matcher(&options)?;

    // Build walker
    let mut walk_builder = WalkBuilder::new(search_path);
    walk_builder
        .hidden(false) // Include hidden files, closer to Claude's rg --hidden
        .ignore(true) // Use .gitignore
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true);

    let types_builder = build_grep_file_types(file_type)?;
    walk_builder.types(
        types_builder
            .build()
            .map_err(|error| format!("Invalid file type: {error}"))?,
    );

    let glob_matchers = build_grep_globs(&options.globs)?;

    let worker_config = GrepWorkerConfig {
        output_mode,
        show_line_numbers,
        before_context,
        after_context,
        display_base,
        search_root: native_search_path(path),
        globs: glob_matchers,
        excluded_paths: options.excluded_paths.clone(),
        reject_linked_files: options.reject_linked_files,
        output_budget: grep_output_budget(&options),
    };
    let worker_count =
        std::thread::available_parallelism().map_or(1, |parallelism| parallelism.get().min(8));
    walk_builder.threads(worker_count);
    let walker = walk_builder.build_parallel();

    // Collect all results
    let mut total_matches = 0;
    let mut file_count = 0;
    let (event_sender, event_receiver) = std::sync::mpsc::sync_channel(worker_count * 4);
    let worker_matcher = matcher.clone();
    let walker_cancellation = options.cancellation.clone();
    let walker_thread = std::thread::spawn(move || {
        let sender = event_sender;
        walker.run(move || {
            let sender = sender.clone();
            let matcher = worker_matcher.clone();
            let config = worker_config.clone();
            let cancellation = walker_cancellation.clone();
            let mut searcher =
                build_grep_searcher(config.before_context, config.after_context, multiline);
            Box::new(move |entry| {
                // Checked before the search, not after: the point of cancelling is to stop paying
                // for work, and the per-entry search is the expensive half.
                if cancellation
                    .as_ref()
                    .is_some_and(SearchCancellation::is_cancelled)
                {
                    return WalkState::Quit;
                }
                let event = search_entry(entry, &mut searcher, &matcher, &config);
                if sender.send(event).is_err() {
                    WalkState::Quit
                } else {
                    WalkState::Continue
                }
            })
        });
    });

    // Progress tracking
    let mut files_processed = 0;
    let mut last_progress_time = std::time::Instant::now();
    let progress_interval_millis = progress_interval_millis.unwrap_or(500);
    let mut file_results = GrepResultCollector::new(&options);

    let mut cancelled = false;
    for event in event_receiver {
        if is_cancelled() {
            // Stop consuming and let the receiver drop. Every worker's next `send` then fails,
            // which is what unwinds the walk without needing a second signalling path.
            cancelled = true;
            break;
        }
        match event {
            GrepWorkerEvent::Processed(result) => {
                files_processed += 1;
                if let Some(result) = result {
                    file_count += 1;
                    total_matches += result.file_matches;
                    file_results.push(result);
                }
            }
            GrepWorkerEvent::Error(error) => warn!("{}", error),
        }

        if last_progress_time.elapsed().as_millis() >= progress_interval_millis {
            info!(
                "Search progress: processed {} files, found {} matching files, total {} matches",
                files_processed, file_count, total_matches
            );

            if let Some(ref callback) = progress_callback {
                callback(files_processed, file_count, total_matches);
            }

            last_progress_time = std::time::Instant::now();
        }
    }
    // The receiver was moved into the `for` loop above and is dropped as that loop exits, break
    // included — so by the time we join, the workers' sends are already failing.
    if walker_thread.join().is_err() {
        warn!("Parallel search walker thread panicked");
    }
    // The walk can also observe the cancel first and quit on its own, which closes the channel and
    // ends the loop above without setting the flag there.
    let cancelled = cancelled || is_cancelled();

    file_results.finish(&options, cancelled)
}

fn reduce_grep_results(
    options: &GrepOptions,
    file_results: Vec<GrepFileResult>,
    cancelled: bool,
) -> Result<GrepSearchResult, String> {
    let file_count = file_results.len();
    let total_matches = file_results.iter().map(|file| file.file_matches).sum();
    reduce_grep_results_with_totals(options, file_results, cancelled, file_count, total_matches)
}

fn reduce_grep_results_with_totals(
    options: &GrepOptions,
    mut file_results: Vec<GrepFileResult>,
    cancelled: bool,
    file_count: usize,
    total_matches: usize,
) -> Result<GrepSearchResult, String> {
    let output_mode = options.output_mode;
    let head_limit = options.head_limit;
    let offset = options.offset;
    let pattern = &options.pattern;
    // Worker completion order is nondeterministic. Stable path order keeps Content and Count
    // output reproducible; FilesWithMatches applies its existing mtime ordering below.
    file_results.sort_by(|left, right| left.path.as_os_str().cmp(right.path.as_os_str()));
    let mut content_lines: Vec<String> =
        Vec::with_capacity(head_limit.map_or(256, |limit| limit.min(4096)));
    let mut file_match_counts: Vec<(String, usize)> = Vec::new();
    let mut matched_files_with_mtime: Vec<(String, SystemTime)> = Vec::new();
    for result in file_results {
        let display_path = result.display_path.unwrap_or_else(|| {
            relativize_display_path(&result.path, options.display_base.as_deref())
        });
        match output_mode {
            OutputMode::Content => {
                for line in result.output_lines {
                    // In multi-line mode a single sink write can span several physical lines;
                    // keep one entry per physical line so head_limit/offset paginate by line.
                    if line.contains('\n') {
                        content_lines.extend(
                            line.lines()
                                .filter(|part| !part.is_empty())
                                .map(str::to_string),
                        );
                    } else if !line.is_empty() {
                        content_lines.push(line);
                    }
                }
            }
            OutputMode::FilesWithMatches => {
                matched_files_with_mtime.push((display_path, result.modified_time));
            }
            OutputMode::Count => file_match_counts.push((display_path, result.file_matches)),
        }
    }

    // Build result
    let result_text = match output_mode {
        OutputMode::Content => {
            let (lines, applied_limit, applied_offset) =
                apply_offset_limit(content_lines, head_limit, offset);
            if lines.is_empty() {
                format!("No matches found for pattern '{}'", pattern)
            } else {
                return Ok(GrepSearchResult {
                    file_count,
                    total_matches,
                    // join() never yields a trailing newline, no trim needed.
                    result_text: lines.join("\n"),
                    applied_limit,
                    applied_offset,
                    cancelled,
                });
            }
        }
        OutputMode::FilesWithMatches => {
            matched_files_with_mtime
                .sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
            let sorted_matches = matched_files_with_mtime
                .into_iter()
                .map(|(path, _)| path)
                .collect::<Vec<_>>();
            let (matches, applied_limit, applied_offset) =
                apply_offset_limit(sorted_matches, head_limit, offset);

            if matches.is_empty() {
                format!("No files found matching pattern '{}'", pattern)
            } else {
                return Ok(GrepSearchResult {
                    file_count,
                    total_matches,
                    result_text: matches.join("\n").trim_end_matches('\n').to_string(),
                    applied_limit,
                    applied_offset,
                    cancelled,
                });
            }
        }
        OutputMode::Count => {
            if file_match_counts.is_empty() {
                format!("No matches found for pattern '{}'", pattern)
            } else {
                let (count_list, applied_limit, applied_offset) =
                    apply_offset_limit(file_match_counts, head_limit, offset);

                let count_lines: Vec<String> = count_list
                    .iter()
                    .map(|(file, count)| format!("{}:{}", file, count))
                    .collect();

                return Ok(GrepSearchResult {
                    file_count,
                    total_matches,
                    result_text: format!(
                        "Total {} matches in {} files:\n{}",
                        total_matches,
                        count_list.len(),
                        count_lines.join("\n")
                    )
                    .trim_end_matches('\n')
                    .to_string(),
                    applied_limit,
                    applied_offset,
                    cancelled,
                });
            }
        }
    };

    Ok(GrepSearchResult {
        file_count,
        total_matches,
        result_text: result_text.trim_end_matches('\n').to_string(),
        applied_limit: None,
        applied_offset: if offset > 0 { Some(offset) } else { None },
        cancelled,
    })
}

/// `rg` is only a candidate accelerator. Matching, context, counts and output
/// windows are always produced by this crate's native matcher and reducer.
pub fn build_grep_candidate_command(options: &GrepOptions) -> String {
    let Some(literals) = candidate_literals(options) else {
        return "exit 127".to_string();
    };
    // Native Searcher does not skip binary content. Disable rg's binary and
    // ignore filters so it cannot exclude a file accepted by our IO walker.
    // User globs/types are deliberately not translated to rg's different glob
    // precedence or version-dependent built-in type catalog.
    let mut command =
        "command rg --no-config --fixed-strings --hidden --no-ignore --text --files-with-matches --null --color never"
            .to_string();
    // Reached only with a caller-proven literal: rg folds with the same Unicode
    // tables as the native matcher, so this cannot exclude a match it would accept.
    if options.case_insensitive {
        command.push_str(" --ignore-case");
    }
    for literal in literals {
        command.push_str(&format!(" -e {}", shell_single_quote(literal)));
    }
    for directory in VCS_DIRECTORIES_TO_EXCLUDE {
        command.push_str(&format!(
            " --glob {}",
            shell_single_quote(&format!("!**/{directory}/**"))
        ));
    }
    command.push_str(&format!(" -- {}", shell_single_quote(&options.path)));
    // Probe bytes and BOM decoding, not a version string. Only fixed strings
    // cross this boundary, so the target's Unicode regex tables cannot exclude
    // a match accepted by the Runtime's matcher.
    format!(
        "command -v rg >/dev/null 2>&1 || exit 127\n\
         printf 'before\\000openbitfun.probe\\n' | command rg --no-config --fixed-strings --text --quiet -e 'openbitfun.probe' || exit 127\n\
         printf '\\377\\376b\\000f\\000\\n\\000' | command rg --no-config --fixed-strings --text --quiet -e bf || exit 127\n\
         printf '\\376\\377\\000b\\000f\\000\\n' | command rg --no-config --fixed-strings --text --quiet -e bf || exit 127\n\
         printf 'OPENBITFUN_RG_CANDIDATES_BEGIN\\000'\n\
         if {command}; then openbitfun_search_status=0; else openbitfun_search_status=$?; fi\n\
         printf 'OPENBITFUN_RG_CANDIDATES_END\\000'\n\
         exit \"$openbitfun_search_status\""
    )
}

/// One matched line of an interactive workspace-stream search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceGrepLineMatch {
    /// Provider path of the file: POSIX for a remote workspace on every client OS.
    pub path: String,
    pub line_number: usize,
    pub text: String,
}

pub struct WorkspaceGrepResult {
    pub result: GrepSearchResult,
    pub used_rg_candidates: bool,
    pub used_grep_candidates: bool,
    pub scanned_file_count: usize,
    pub scanned_bytes: u64,
    /// Filled only when [`GrepOptions::collect_line_matches`] is set. Holds one entry
    /// beyond `head_limit` when more matches exist, which is how callers see truncation.
    pub line_matches: Vec<WorkspaceGrepLineMatch>,
}

fn candidate_literals(options: &GrepOptions) -> Option<Vec<&str>> {
    match options.candidate_literal.as_deref() {
        Some(literal) => Some(vec![literal]),
        None => literal_alternatives(&options.pattern, options.case_insensitive),
    }
}

/// Exit status 2 means some files could not be read, not that the search failed:
/// `rg` and `grep` still report everything they could read. Those unreadable files
/// could not be opened through the workspace provider either. Interactive search
/// accepts this, while agent Grep keeps treating any failure as an error.
fn parse_partial_candidates(stdout: &str, root: &str) -> Result<HashSet<String>, String> {
    let empty = stdout == "OPENBITFUN_RG_CANDIDATES_BEGIN\0OPENBITFUN_RG_CANDIDATES_END\0";
    warn!("Workspace search candidate command could not read some files under {root}");
    parse_rg_candidates(stdout, i32::from(empty), root)
}

/// One-shot candidate selection through system grep. Unlike the per-file batch
/// prefilter this avoids a metadata round trip per file, and it also supports the
/// ASCII case folding that interactive search uses by default.
async fn recursive_grep_candidates(
    shell: &dyn WorkspaceShell,
    literals: &[&str],
    options: &GrepOptions,
    cancellation: &SearchCancellation,
) -> Result<Option<HashSet<String>>, String> {
    let result = shell
        .exec_with_options(
            &recursive_grep_candidate_command(
                literals,
                &options.path,
                options.case_insensitive,
                VCS_DIRECTORIES_TO_EXCLUDE,
            ),
            openbitfun_runtime_ports::WorkspaceCommandOptions {
                timeout_ms: Some(INTERACTIVE_CANDIDATE_COMMAND_TIMEOUT_MS),
                cancellation_token: Some(cancellation.token.clone()),
            },
        )
        .await
        .map_err(|error| format!("Workspace grep candidate command failed: {error}"))?;
    if result.timed_out || result.interrupted {
        return Err("Workspace grep candidate command timed out or was interrupted".to_string());
    }
    match result.exit_code {
        0 | 1 => parse_rg_candidates(&result.stdout, result.exit_code, &options.path).map(Some),
        2 => parse_partial_candidates(&result.stdout, &options.path).map(Some),
        127 => Ok(None),
        status => Err(format!(
            "Workspace grep candidate command failed with exit code {status}: {}",
            result.stderr.trim(),
        )),
    }
}

fn parse_rg_candidates(
    stdout: &str,
    exit_code: i32,
    root: &str,
) -> Result<HashSet<String>, String> {
    let payload = stdout
        .strip_prefix("OPENBITFUN_RG_CANDIDATES_BEGIN\0")
        .and_then(|text| text.strip_suffix("OPENBITFUN_RG_CANDIDATES_END\0"))
        .ok_or_else(|| {
            "Workspace search candidate protocol was incomplete or contaminated".to_string()
        })?;
    if (exit_code == 1 && !payload.is_empty()) || (exit_code == 0 && payload.is_empty()) {
        return Err(
            "Workspace search candidate output did not agree with its exit status".to_string(),
        );
    }
    if !payload.is_empty() && !payload.ends_with('\0') {
        return Err(
            "Workspace search candidate output was missing a filename delimiter".to_string(),
        );
    }
    let root = workspace_search_path(root);
    let prefix = format!("{}/", root.trim_end_matches('/'));
    payload
        .split_terminator('\0')
        .map(|path| {
            let path = workspace_search_path(path);
            let in_scope = if root.is_empty() {
                !path.is_empty()
                    && !path.starts_with('/')
                    && !path.split('/').any(|component| component == "..")
            } else {
                path == root || path.starts_with(&prefix)
            };
            if !in_scope {
                return Err(
                    "Workspace search candidate path was outside the requested scope".to_string(),
                );
            }
            Ok(path)
        })
        .collect()
}

fn workspace_search_path(path: &str) -> String {
    // Absolute Windows drive/UNC paths can only belong to a native provider:
    // SSH paths are always absolute POSIX paths, including on Windows clients.
    // Detect the spelling instead of applying host Path semantics to SSH names.
    let windows_absolute = (path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')))
        || path.starts_with("\\\\");
    let native_path;
    let path = if windows_absolute {
        native_path = path.replace('\\', "/");
        &native_path
    } else {
        path
    };
    let mut normalized = if windows_absolute && path.starts_with("//") {
        "//".to_string()
    } else if path.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    normalized.push_str(
        &path
            .split('/')
            .filter(|component| !component.is_empty() && *component != ".")
            .collect::<Vec<_>>()
            .join("/"),
    );
    normalized
}

fn workspace_display_path(path: &str, base: Option<&str>) -> String {
    let path = workspace_search_path(path);
    let display = if let Some(base) = base {
        let base = workspace_search_path(base);
        if path == base {
            ".".to_string()
        } else {
            path.strip_prefix(&format!("{}/", base.trim_end_matches('/')))
                .unwrap_or(&path)
                .to_string()
        }
    } else {
        path
    };
    if display.chars().any(char::is_control) || display.contains('\\') {
        serde_json::to_string(&display).expect("strings serialize")
    } else {
        display
    }
}

struct CancelSearchOnDrop(SearchCancellation);
impl Drop for CancelSearchOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[derive(Default)]
struct WorkspaceSearchWorkers {
    active: std::sync::atomic::AtomicUsize,
    idle: tokio::sync::Notify,
}

impl WorkspaceSearchWorkers {
    fn start(self: &Arc<Self>) -> WorkspaceSearchWorkerGuard {
        self.active
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        WorkspaceSearchWorkerGuard(self.clone())
    }

    async fn wait_until_idle(&self) {
        loop {
            let idle = self.idle.notified();
            if self.active.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                return;
            }
            idle.await;
        }
    }
}

struct WorkspaceSearchWorkerGuard(Arc<WorkspaceSearchWorkers>);

impl Drop for WorkspaceSearchWorkerGuard {
    fn drop(&mut self) {
        if self
            .0
            .active
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            self.0.idle.notify_one();
        }
    }
}

struct CancellableWorkspaceReader {
    reader: openbitfun_runtime_ports::WorkspaceReader,
    cancelled: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    bytes_read: Arc<std::sync::atomic::AtomicU64>,
}

impl tokio::io::AsyncRead for CancellableWorkspaceReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        if self.cancelled.as_mut().poll(context).is_ready() {
            return std::task::Poll::Ready(Err(io::Error::other("Search cancelled")));
        }
        let before = buffer.filled().len();
        let result = std::pin::Pin::new(&mut self.reader).poll_read(context, buffer);
        self.bytes_read.fetch_add(
            buffer.filled().len().saturating_sub(before) as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        result
    }
}

/// Poll cancellation around the entire provider pipeline, including directory
/// enumeration, metadata and opening a file, not only reads from an open stream.
pub async fn grep_search_workspace(
    mut options: GrepOptions,
    fs: &dyn WorkspaceFileSystem,
    shell: Option<&dyn WorkspaceShell>,
) -> Result<WorkspaceGrepResult, String> {
    let cancellation = SearchCancellation {
        token: options
            .cancellation
            .as_ref()
            .map(|parent| parent.token.child_token())
            .unwrap_or_default(),
    };
    options.cancellation = Some(cancellation.clone());
    let _cancel_on_drop = CancelSearchOnDrop(cancellation.clone());
    let workers = Arc::new(WorkspaceSearchWorkers::default());
    tokio::select! {
        biased;
        _ = cancellation.token.cancelled() => {
            workers.wait_until_idle().await;
            Ok(WorkspaceGrepResult {
                result: reduce_grep_results(&options, Vec::new(), true)?,
                used_rg_candidates: false,
                used_grep_candidates: false,
                scanned_file_count: 0,
                scanned_bytes: 0,
                line_matches: Vec::new(),
            })
        },
        result = grep_search_workspace_inner(options.clone(), fs, shell, workers.clone()) => result,
    }
}

struct WorkspaceGrepCollector<'a> {
    options: &'a GrepOptions,
    fs: &'a dyn WorkspaceFileSystem,
    matcher: RegexMatcher,
    file_results: GrepResultCollector,
    scanned_file_count: usize,
    bytes_read: Arc<std::sync::atomic::AtomicU64>,
    workers: Arc<WorkspaceSearchWorkers>,
}

impl WorkspaceGrepCollector<'_> {
    async fn scan_batch(
        &mut self,
        files: &mut Vec<(String, openbitfun_runtime_ports::WorkspaceMetadata)>,
        grep_prefilter: Option<(&dyn WorkspaceShell, &[&str])>,
    ) -> Result<(), String> {
        if files.is_empty() {
            return Ok(());
        }
        let cancellation = self
            .options
            .cancellation
            .as_ref()
            .expect("search cancellation bound");
        let selected =
            if let Some((shell, literals)) = grep_prefilter {
                let paths = files
                    .iter()
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
                let result = shell
                    .exec_with_options(
                        &grep_batch_command(literals, &paths),
                        openbitfun_runtime_ports::WorkspaceCommandOptions {
                            timeout_ms: Some(30_000),
                            cancellation_token: Some(cancellation.token.clone()),
                        },
                    )
                    .await
                    .map_err(|error| format!("Workspace grep prefilter failed: {error}"))?;
                if result.timed_out || result.interrupted || result.exit_code != 0 {
                    return Err(format!(
                    "Workspace grep prefilter failed (exit {}, timed_out={}, interrupted={}): {}",
                    result.exit_code, result.timed_out, result.interrupted, result.stderr.trim()
                ));
                }
                parse_grep_batch_output(&result.stdout, files.len())?
            } else {
                vec![true; files.len()]
            };
        let before = self
            .options
            .before_context
            .unwrap_or(self.options.context.unwrap_or(0));
        let after = self
            .options
            .after_context
            .unwrap_or(self.options.context.unwrap_or(0));
        for ((path, metadata), selected) in files.drain(..).zip(selected) {
            if !selected {
                continue;
            }
            let reader = self
                .fs
                .open_read(&path)
                .await
                .map_err(|error| format!("Failed to open {path}: {error}"))?;
            self.scanned_file_count += 1;
            let reader = tokio_util::io::SyncIoBridge::new(CancellableWorkspaceReader {
                reader,
                cancelled: Box::pin(cancellation.token.clone().cancelled_owned()),
                bytes_read: self.bytes_read.clone(),
            });
            let display_path = workspace_display_path(&path, self.options.display_base.as_deref());
            let sink = GrepSink::new(
                self.options.output_mode,
                self.options.show_line_numbers,
                before,
                after,
                None,
                PathBuf::from(&path),
                None,
            )
            .with_display_path(display_path.clone())
            .with_output_budget(grep_output_budget(self.options));
            let worker_sink = sink.clone();
            let worker_matcher = self.matcher.clone();
            let multiline = self.options.multiline;
            let worker_guard = self.workers.start();
            tokio::task::spawn_blocking(move || {
                let _worker_guard = worker_guard;
                build_grep_searcher(before, after, multiline).search_reader(
                    &worker_matcher,
                    reader,
                    worker_sink,
                )
            })
            .await
            .map_err(|error| format!("Workspace search reader task failed: {error}"))?
            .map_err(|error| format!("Error searching file {path}: {error}"))?;
            let file_matches = sink.get_match_count();
            if file_matches > 0 {
                self.file_results.push(GrepFileResult {
                    path: PathBuf::from(path),
                    display_path: Some(display_path),
                    file_matches,
                    output_lines: if self.options.output_mode == OutputMode::Content {
                        sink.take_output_lines()
                    } else {
                        Vec::new()
                    },
                    modified_time: metadata.modified.unwrap_or(SystemTime::UNIX_EPOCH),
                });
            }
        }
        Ok(())
    }
}

/// Search workspace streams with the native regex engine. The optional shell
/// returns matching candidate *paths*, never tool-formatted output. Without rg,
/// the same walker and reader scan the authorized scope without installing any
/// executable on the target. Global Git excludes outside this scope are not read.
async fn grep_search_workspace_inner(
    options: GrepOptions,
    fs: &dyn WorkspaceFileSystem,
    shell: Option<&dyn WorkspaceShell>,
    workers: Arc<WorkspaceSearchWorkers>,
) -> Result<WorkspaceGrepResult, String> {
    let matcher = build_grep_matcher(&options)?;
    let globs = build_grep_globs(&options.globs)?;
    let type_builder = build_grep_file_types(options.file_type.as_deref())?;
    let type_patterns = type_builder
        .definitions()
        .into_iter()
        .filter(|definition| {
            options
                .file_type
                .as_deref()
                .is_some_and(|name| definition.name() == name)
        })
        .flat_map(|definition| definition.globs().to_vec())
        .map(|pattern| {
            let glob = GlobBuilder::new(&pattern)
                .literal_separator(true)
                .backslash_escape(true)
                .build()
                .map_err(|error| format!("Invalid file type glob: {error}"))?;
            Ok(glob.regex().to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let type_globs =
        regex::bytes::RegexSet::new(type_patterns).map_err(|error| error.to_string())?;
    let mut root_metadata = fs
        .metadata(&options.path, false)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Search path '{}' does not exist", options.path))?;
    let root_is_symlink = root_metadata.kind == WorkspacePathKind::Symlink;
    if root_is_symlink && !options.reject_linked_files {
        root_metadata = fs
            .metadata(&options.path, true)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Search symlink target '{}' does not exist", options.path))?;
        if root_metadata.kind != WorkspacePathKind::File {
            return Err(
                "Workspace search does not traverse symbolic-link directory roots".to_string(),
            );
        }
    }
    if !matches!(
        root_metadata.kind,
        WorkspacePathKind::File | WorkspacePathKind::Directory
    ) {
        return Err(format!(
            "Search path '{}' is not a regular file or directory",
            options.path
        ));
    }
    let cancellation = options
        .cancellation
        .as_ref()
        .expect("search cancellation bound");
    let literals = candidate_literals(&options)
        .filter(|_| build_grep_candidate_command(&options).len() <= MAX_GREP_BATCH_COMMAND_BYTES);
    let mut candidates = None;
    let mut used_grep_candidates = false;
    let mut used_recursive_grep = false;
    let candidate_timeout_ms = if options.candidate_literal.is_some() {
        INTERACTIVE_CANDIDATE_COMMAND_TIMEOUT_MS
    } else {
        CANDIDATE_COMMAND_TIMEOUT_MS
    };
    if let (Some(shell), Some(literals)) = (shell, literals.as_ref()) {
        let command_result = shell
            .exec_with_options(
                &build_grep_candidate_command(&options),
                openbitfun_runtime_ports::WorkspaceCommandOptions {
                    timeout_ms: Some(candidate_timeout_ms),
                    cancellation_token: Some(cancellation.token.clone()),
                },
            )
            .await
            .map_err(|error| format!("Workspace search candidate command failed: {error}"))?;
        if command_result.timed_out || command_result.interrupted {
            return Err(
                "Workspace search candidate command timed out or was interrupted".to_string(),
            );
        }
        match command_result.exit_code {
            0 | 1 => {
                candidates = Some(parse_rg_candidates(
                    &command_result.stdout,
                    command_result.exit_code,
                    &options.path,
                )?);
            }
            2 if options.candidate_literal.is_some() => {
                candidates = Some(parse_partial_candidates(
                    &command_result.stdout,
                    &options.path,
                )?);
            }
            127 => {
                if options.candidate_literal.is_some() {
                    candidates =
                        recursive_grep_candidates(shell, literals, &options, cancellation).await?;
                    used_recursive_grep = candidates.is_some();
                }
                // A compatible grep is an optional fixed-byte prefilter. It
                // never reinterprets regex syntax or renders tool results.
                // Oversized patterns skip acceleration, not the search itself.
                // The batch command never folds case, so a case-folded literal
                // without a usable recursive grep scans through the provider.
                if candidates.is_none()
                    && !options.case_insensitive
                    && grep_batch_command(literals, &[]).len() < MAX_GREP_BATCH_COMMAND_BYTES
                {
                    let probe = shell
                        .exec_with_options(
                            grep_probe_command(),
                            openbitfun_runtime_ports::WorkspaceCommandOptions {
                                timeout_ms: Some(30_000),
                                cancellation_token: Some(cancellation.token.clone()),
                            },
                        )
                        .await
                        .map_err(|error| {
                            format!("Workspace grep capability probe failed: {error}")
                        })?;
                    if probe.timed_out || probe.interrupted {
                        return Err(
                            "Workspace grep capability probe timed out or was interrupted"
                                .to_string(),
                        );
                    }
                    match probe.exit_code {
                        0 if probe.stdout.is_empty() => used_grep_candidates = true,
                        127 => {}
                        _ => {
                            return Err(format!(
                                "Workspace grep capability probe failed (exit {}): {}",
                                probe.exit_code,
                                probe.stderr.trim(),
                            ))
                        }
                    }
                }
            }
            status => {
                return Err(format!(
                    "Workspace search candidate command failed with exit code {status}: {}",
                    command_result.stderr.trim(),
                ))
            }
        }
    }
    let used_rg_candidates = candidates.is_some() && !used_recursive_grep;
    let grep_prefilter = if used_grep_candidates {
        Some((
            shell.expect("grep shell checked"),
            literals.as_ref().expect("literals checked").as_slice(),
        ))
    } else {
        None
    };
    let mut collector = WorkspaceGrepCollector {
        options: &options,
        fs,
        matcher,
        file_results: GrepResultCollector::new(&options),
        scanned_file_count: 0,
        bytes_read: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        workers,
    };
    let mut pending = Vec::new();
    let command_overhead = grep_prefilter
        .map(|(_, literals)| grep_batch_command(literals, &[]).len())
        .unwrap_or(0);
    let mut command_bytes = command_overhead;
    let mut walker = (root_metadata.kind == WorkspacePathKind::Directory).then(|| {
        super::workspace_walk::WorkspaceFileWalker::new(fs, options.path.clone(), false, true)
            .with_symlink_entries()
    });
    let mut single_file =
        (root_metadata.kind == WorkspacePathKind::File).then(|| options.path.clone());
    loop {
        if cancellation.is_cancelled()
            || (options.collect_line_matches && collector.file_results.budget_exhausted())
        {
            break;
        }
        let (path, is_symlink, file_name) = if let Some(path) = single_file.take() {
            (path, root_is_symlink, None)
        } else if let Some(walker) = walker.as_mut() {
            match walker.next().await? {
                Some(file) => (
                    file.entry.path,
                    file.entry.is_symlink,
                    Some(file.entry.name),
                ),
                None => break,
            }
        } else {
            break;
        };
        if workspace_search_path(&path)
            .split('/')
            .any(|component| VCS_DIRECTORIES_TO_EXCLUDE.contains(&component))
        {
            continue;
        }
        // rg intentionally does not follow links. Native Grep reads file links,
        // so they bypass candidate filtering and are inspected individually.
        if (is_symlink && options.reject_linked_files)
            || (!is_symlink
                && candidates
                    .as_ref()
                    .is_some_and(|paths| !paths.contains(&workspace_search_path(&path))))
        {
            continue;
        }
        if options
            .excluded_paths
            .iter()
            .any(|excluded| workspace_search_path(excluded) == workspace_search_path(&path))
        {
            continue;
        }
        if !grep_globs_match(&globs, &path, &options.path) {
            continue;
        }
        let name = file_name.as_deref().unwrap_or(&path);
        // Explicit files bypass the walker's type filters in the native path.
        if root_metadata.kind == WorkspacePathKind::Directory
            && options.file_type.is_some()
            && !type_globs.is_match(name.as_bytes())
        {
            continue;
        }
        let metadata = fs
            .metadata(&path, is_symlink)
            .await
            .map_err(|error| format!("Failed to inspect {path}: {error}"))?;
        // A dangling link is ordinary workspace content, and it must not fail a
        // whole-workspace search that the person never scoped around it.
        if metadata.is_none() && is_symlink && options.collect_line_matches {
            continue;
        }
        let metadata =
            metadata.ok_or_else(|| format!("File disappeared while searching: {path}"))?;
        if metadata.kind != WorkspacePathKind::File {
            continue;
        }
        if options.reject_linked_files {
            return Err(
                "This workspace provider cannot prove hard-link identity for a restricted search"
                    .to_string(),
            );
        }
        let path_bytes = shell_single_quote(&path).len() + 1;
        if grep_prefilter.is_some()
            && (!pending.is_empty())
            && (pending.len() >= MAX_GREP_BATCH_PATHS
                || command_bytes.saturating_add(path_bytes) > MAX_GREP_BATCH_COMMAND_BYTES)
        {
            collector.scan_batch(&mut pending, grep_prefilter).await?;
            command_bytes = command_overhead;
        }
        pending.push((path, metadata));
        command_bytes = command_bytes.saturating_add(path_bytes);
        if grep_prefilter.is_none() || command_bytes > MAX_GREP_BATCH_COMMAND_BYTES {
            // An exceptionally long path remains searchable through the provider.
            collector.scan_batch(&mut pending, None).await?;
            command_bytes = command_overhead;
        }
    }
    collector.scan_batch(&mut pending, grep_prefilter).await?;
    let line_matches = if options.collect_line_matches {
        collector.file_results.line_matches()
    } else {
        Vec::new()
    };
    Ok(WorkspaceGrepResult {
        line_matches,
        result: collector
            .file_results
            .finish(&options, cancellation.is_cancelled())?,
        used_rg_candidates,
        used_grep_candidates: used_grep_candidates || used_recursive_grep,
        scanned_file_count: collector.scanned_file_count,
        scanned_bytes: collector
            .bytes_read
            .load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// Search immutable in-memory text files with the same matcher and result
/// presentation used by filesystem Grep.
///
/// This is used for capability-backed virtual files whose contents must not be
/// reopened through a mutable filesystem path.
pub fn grep_search_virtual_files(
    options: GrepOptions,
    files: &[(String, Arc<str>)],
) -> Result<GrepSearchResult, String> {
    let before_context = options
        .before_context
        .unwrap_or(options.context.unwrap_or(0));
    let after_context = options
        .after_context
        .unwrap_or(options.context.unwrap_or(0));
    let matcher = build_grep_matcher(&options)?;
    let glob_matchers = build_grep_globs(&options.globs)?;

    // A MiniApp controls these bounded inputs and may deliberately request an
    // unbounded result (`head_limit: 0`). Keep the virtual capability bounded
    // while scanning, not only while rendering, so millions of matching lines
    // cannot expand into millions of formatted Strings first.
    let content_head_limit = if options.output_mode == OutputMode::Content {
        let requested = options
            .head_limit
            .filter(|limit| *limit > 0)
            .unwrap_or(MAX_VIRTUAL_GREP_CONTENT_LINES);
        let collection_budget = options
            .offset
            .checked_add(requested)
            .filter(|budget| *budget <= MAX_VIRTUAL_GREP_CONTENT_LINES)
            .ok_or_else(|| {
                format!(
                    "Virtual Grep offset + head_limit must not exceed {MAX_VIRTUAL_GREP_CONTENT_LINES} lines"
                )
            })?;
        Some((requested, collection_budget))
    } else {
        None
    };

    let mut file_results = Vec::new();
    let mut collected_content_lines = 0usize;
    for (path, content) in files {
        if content_head_limit.is_some_and(|(_, budget)| collected_content_lines >= budget) {
            break;
        }
        let path_buf = PathBuf::from(path);
        if !glob_matchers.is_empty()
            && !glob_matchers
                .iter()
                .any(|glob| glob.is_match(native_search_path(&path_buf).as_bytes()))
        {
            continue;
        }
        if let Some(file_type) = options.file_type.as_deref() {
            let extension_matches = path_buf
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case(file_type)
                        || (file_type.eq_ignore_ascii_case("json")
                            && extension.eq_ignore_ascii_case("json5"))
                });
            if !extension_matches {
                continue;
            }
        }

        let mut searcher = build_grep_searcher(before_context, after_context, options.multiline);
        let sink_limit =
            content_head_limit.map(|(_, budget)| budget.saturating_sub(collected_content_lines));
        let sink = GrepSink::new(
            options.output_mode,
            options.show_line_numbers,
            before_context,
            after_context,
            sink_limit,
            path_buf.clone(),
            None,
        );
        searcher
            .search_slice(&matcher, content.as_bytes(), sink.clone())
            .map_err(|error| format!("Error searching virtual file {path}: {error}"))?;
        let file_matches = sink.get_match_count();
        if file_matches == 0 {
            continue;
        }
        let output_lines = if options.output_mode == OutputMode::Content {
            let remaining = content_head_limit
                .map(|(_, budget)| budget.saturating_sub(collected_content_lines))
                .unwrap_or(0);
            let mut bounded = Vec::with_capacity(remaining.min(256));
            'writes: for line in sink.take_output_lines() {
                if line.contains('\n') {
                    for part in line.lines().filter(|part| !part.is_empty()) {
                        if bounded.len() >= remaining {
                            break 'writes;
                        }
                        bounded.push(part.to_string());
                    }
                } else if !line.is_empty() {
                    if bounded.len() >= remaining {
                        break;
                    }
                    bounded.push(line);
                }
            }
            collected_content_lines = collected_content_lines.saturating_add(bounded.len());
            bounded
        } else {
            Vec::new()
        };
        file_results.push(GrepFileResult {
            path: path_buf,
            display_path: None,
            file_matches,
            output_lines,
            modified_time: SystemTime::UNIX_EPOCH,
        });
    }

    file_results.sort_by(|left, right| left.path.cmp(&right.path));
    let file_count = file_results.len();
    let total_matches = file_results.iter().map(|result| result.file_matches).sum();
    let mut content_lines = Vec::new();
    let mut file_match_counts = Vec::new();
    let mut matched_files = Vec::new();
    for result in file_results {
        let path = result.path.to_string_lossy().replace('\\', "/");
        match options.output_mode {
            OutputMode::Content => {
                for line in result.output_lines {
                    if line.contains('\n') {
                        content_lines.extend(
                            line.lines()
                                .filter(|part| !part.is_empty())
                                .map(str::to_string),
                        );
                    } else if !line.is_empty() {
                        content_lines.push(line);
                    }
                }
            }
            OutputMode::FilesWithMatches => matched_files.push(path),
            OutputMode::Count => file_match_counts.push((path, result.file_matches)),
        }
    }

    let (result_text, applied_limit, applied_offset) = match options.output_mode {
        OutputMode::Content => {
            let (lines, applied_limit, applied_offset) = apply_offset_limit(
                content_lines,
                content_head_limit.map(|(limit, _)| limit),
                options.offset,
            );
            (
                if lines.is_empty() {
                    format!("No matches found for pattern '{}'", options.pattern)
                } else {
                    lines.join("\n")
                },
                applied_limit,
                applied_offset,
            )
        }
        OutputMode::FilesWithMatches => {
            let (matches, applied_limit, applied_offset) =
                apply_offset_limit(matched_files, options.head_limit, options.offset);
            (
                if matches.is_empty() {
                    format!("No files found matching pattern '{}'", options.pattern)
                } else {
                    matches.join("\n")
                },
                applied_limit,
                applied_offset,
            )
        }
        OutputMode::Count => {
            let (counts, applied_limit, applied_offset) =
                apply_offset_limit(file_match_counts, options.head_limit, options.offset);
            let lines = counts
                .iter()
                .map(|(file, count)| format!("{file}:{count}"))
                .collect::<Vec<_>>();
            (
                if lines.is_empty() {
                    format!("No matches found for pattern '{}'", options.pattern)
                } else {
                    format!(
                        "Total {} matches in {} files:\n{}",
                        total_matches,
                        counts.len(),
                        lines.join("\n")
                    )
                },
                applied_limit,
                applied_offset,
            )
        }
    };

    Ok(GrepSearchResult {
        file_count,
        total_matches,
        result_text,
        applied_limit,
        applied_offset,
        cancelled: false,
    })
}

fn paths_equal_for_exclusion(path: &Path, excluded: &str) -> bool {
    let path = path.to_string_lossy().replace('\\', "/");
    let excluded = excluded.replace('\\', "/");
    if path == excluded {
        return true;
    }
    let needs_identity_check = cfg!(windows) && path.eq_ignore_ascii_case(&excluded);
    if !needs_identity_check {
        return false;
    }
    let Ok(path) = std::fs::canonicalize(path) else {
        return false;
    };
    let Ok(excluded) = std::fs::canonicalize(excluded) else {
        return false;
    };
    path == excluded
}

#[cfg(test)]
mod tests {
    use super::{
        grep_search, grep_search_virtual_files, paths_equal_for_exclusion, GrepOptions, OutputMode,
        SearchCancellation, MAX_VIRTUAL_GREP_CONTENT_LINES,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("openbitfun-grep-search-{name}-{unique}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn workspace_paths_normalize_native_drives_without_rewriting_posix_names() {
        assert_eq!(
            super::workspace_search_path(r"C:\repo\src\main.py"),
            "C:/repo/src/main.py"
        );
        assert_eq!(
            super::workspace_search_path(r"\\server\share\a.py"),
            "//server/share/a.py"
        );
        assert_eq!(
            super::workspace_search_path(r"/repo/a\b.py"),
            r"/repo/a\b.py"
        );
        assert_eq!(
            super::workspace_search_path("/repo/./sub//a.py"),
            "/repo/sub/a.py"
        );
        assert_eq!(
            super::workspace_display_path(r"C:\repo\src\a.py", Some(r"C:\repo")),
            "src/a.py"
        );
        assert_eq!(
            super::workspace_display_path(r"/repo/a\b.py", Some("/repo")),
            r#""a\\b.py""#
        );
    }

    #[test]
    fn relative_globs_use_search_root_without_rewriting_posix_backslashes() {
        for (pattern, path, root) in [
            ("src/*.rs", "/repo/src/lib.rs", "/repo"),
            ("src/**", "/repo/src/nested/lib.rs", "/repo/"),
            ("/repo/src/*.rs", "/repo/src/lib.rs", "/repo"),
            ("lib.rs", "/repo/src/lib.rs", "/repo"),
            (r"src/a\\b.rs", r"/repo/src/a\b.rs", "/repo"),
            ("src/*.rs", r"C:\repo\src\lib.rs", r"C:\repo"),
        ] {
            let globs = super::build_grep_globs(&[pattern.to_string()]).unwrap();
            assert!(
                super::grep_globs_match(&globs, path, root),
                "{pattern}: {path}"
            );
        }
        let globs = super::build_grep_globs(&["src/*.rs".to_string()]).unwrap();
        assert!(!super::grep_globs_match(
            &globs,
            "/repository/src/lib.rs",
            "/repo"
        ));
    }

    #[cfg(unix)]
    fn create_file_symlink(target: &std::path::Path, alias: &std::path::Path) -> bool {
        std::os::unix::fs::symlink(target, alias).expect("file symlink should be available");
        true
    }

    #[test]
    fn virtual_file_search_preserves_regex_modes_filters_and_pagination() {
        let files = vec![
            (
                ".miniapp-context/scope/a.json".to_string(),
                std::sync::Arc::<str>::from("alpha\nNeedle one\nneedle two\n"),
            ),
            (
                ".miniapp-context/scope/b.txt".to_string(),
                std::sync::Arc::<str>::from("needle ignored by type\n"),
            ),
        ];
        let result = grep_search_virtual_files(
            GrepOptions::new("needle", ".miniapp-context/scope")
                .case_insensitive(true)
                .output_mode(OutputMode::Content)
                .file_type("json")
                .offset(1)
                .head_limit(1),
            &files,
        )
        .expect("virtual grep should succeed");

        assert_eq!(result.file_count, 1);
        assert_eq!(result.total_matches, 2);
        assert_eq!(
            result.result_text,
            ".miniapp-context/scope/a.json:3:needle two"
        );
        assert_eq!(result.applied_offset, Some(1));
    }

    #[test]
    fn virtual_file_search_bounds_explicit_unlimited_content_during_collection() {
        let files = vec![(
            ".miniapp-context/scope/large.ndjson".to_string(),
            std::sync::Arc::<str>::from(
                "needle\n".repeat(MAX_VIRTUAL_GREP_CONTENT_LINES.saturating_add(100)),
            ),
        )];
        let result = grep_search_virtual_files(
            GrepOptions::new("needle", ".miniapp-context/scope")
                .output_mode(OutputMode::Content)
                .head_limit(0),
            &files,
        )
        .expect("virtual grep should replace an unlimited request with a hard bound");

        assert_eq!(
            result.result_text.lines().count(),
            MAX_VIRTUAL_GREP_CONTENT_LINES
        );
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &std::path::Path, alias: &std::path::Path) -> bool {
        std::os::windows::fs::symlink_file(target, alias).is_ok()
    }

    #[test]
    fn a_search_that_was_never_cancelled_reports_so() {
        let root = make_temp_dir("cancel-none");
        fs::write(root.join("a.txt"), "needle\n").unwrap();

        let result = grep_search(
            GrepOptions::new("needle", root.to_string_lossy().to_string())
                .output_mode(OutputMode::Content),
            None,
            None,
        )
        .unwrap();

        assert!(!result.cancelled);
        assert_eq!(result.file_count, 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelling_before_the_walk_starts_returns_an_empty_cancelled_result() {
        let root = make_temp_dir("cancel-upfront");
        fs::write(root.join("a.txt"), "needle\n").unwrap();

        let cancellation = SearchCancellation::new();
        cancellation.cancel();

        let result = grep_search(
            GrepOptions::new("needle", root.to_string_lossy().to_string())
                .output_mode(OutputMode::Content)
                .cancellation(cancellation),
            None,
            None,
        )
        .unwrap();

        assert!(result.cancelled);
        assert_eq!(result.file_count, 0);
        assert_eq!(result.total_matches, 0);
        assert!(result.result_text.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelling_mid_walk_keeps_what_was_already_found() {
        // Every file matches, so an uncancelled run would report all 200. The progress interval is
        // zeroed so the callback fires on every event; we cancel once five matches are in, which
        // puts the cancel mid-walk deterministically instead of racing a timer, and leaves a known
        // non-empty partial result to assert on.
        let root = make_temp_dir("cancel-midwalk");
        for index in 0..200 {
            fs::write(root.join(format!("file-{index:03}.txt")), "needle\n").unwrap();
        }

        let cancellation = SearchCancellation::new();
        let from_callback = cancellation.clone();
        let callback: super::ProgressCallback =
            std::sync::Arc::new(move |_files_processed, file_count, _total_matches| {
                if file_count >= 5 {
                    from_callback.cancel();
                }
            });

        let result = grep_search(
            GrepOptions::new("needle", root.to_string_lossy().to_string())
                .output_mode(OutputMode::Content)
                .cancellation(cancellation),
            Some(callback),
            Some(0),
        )
        .unwrap();

        assert!(result.cancelled);
        // Partial, not empty and not complete: the point of the contract is that a cancelled search
        // still hands back the work it had already paid for.
        assert!(
            result.file_count < 200,
            "expected the walk to stop early, saw {} files",
            result.file_count
        );
        // The cancel is raised from inside the callback once five matches are counted, so a
        // correct implementation never comes back with fewer than that.
        assert!(result.file_count >= 5, "saw {} files", result.file_count);
        assert_eq!(result.result_text.lines().count(), result.file_count);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn truncates_very_long_output_lines() {
        let root = make_temp_dir("truncate");
        let file_path = root.join("sample.txt");
        let long_line = "a".repeat(600);
        fs::write(&file_path, format!("{long_line}\n")).unwrap();

        let result = grep_search(
            GrepOptions::new("a+", root.to_string_lossy().to_string())
                .output_mode(OutputMode::Content)
                .show_line_numbers(true)
                .head_limit(10),
            None,
            None,
        )
        .unwrap();

        assert!(result.result_text.contains("[truncated]"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multiline_matches_paginate_by_physical_line() {
        // A multiline match reaches the sink as one entry spanning several
        // physical lines; head_limit/offset must still paginate by physical
        // line, not by match block.
        let root = make_temp_dir("multiline-head-limit");
        let file_path = root.join("sample.txt");
        fs::write(&file_path, "alpha\nbeta\nnoise\nalpha\nbeta\n").unwrap();

        let result = grep_search(
            GrepOptions::new("alpha\\nbeta", root.to_string_lossy().to_string())
                .multiline(true)
                .output_mode(OutputMode::Content)
                .show_line_numbers(true)
                .head_limit(3),
            None,
            None,
        )
        .unwrap();

        let lines: Vec<&str> = result.result_text.lines().collect();
        assert_eq!(
            lines.len(),
            3,
            "head_limit must count physical lines, got {lines:?}"
        );
        assert!(lines[0].ends_with(":1:alpha"), "got {lines:?}");
        assert_eq!(lines[1], "beta", "got {lines:?}");
        assert!(lines[2].ends_with(":4:alpha"), "got {lines:?}");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exact_exclusions_remove_unassigned_files_from_results() {
        let root = make_temp_dir("excluded");
        let included = root.join("included.txt");
        let excluded = root.join("excluded.txt");
        fs::write(&included, "review-token\n").unwrap();
        fs::write(&excluded, "review-token\n").unwrap();

        let result = grep_search(
            GrepOptions::new("review-token", root.to_string_lossy().to_string())
                .output_mode(OutputMode::FilesWithMatches)
                .excluded_paths(vec![excluded.to_string_lossy().to_string()]),
            None,
            None,
        )
        .unwrap();

        assert!(result.result_text.contains("included.txt"));
        assert!(!result.result_text.contains("excluded.txt"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exclusion_comparison_does_not_merge_distinct_path_spelling() {
        assert!(!paths_equal_for_exclusion(
            PathBuf::from("src/CaseSensitive.rs").as_path(),
            "src/casesensitive.rs",
        ));
    }

    #[test]
    fn exact_exclusions_block_file_symlink_aliases() {
        let root = make_temp_dir("excluded-symlink");
        let excluded = root.join("excluded.txt");
        let alias = root.join("alias.txt");
        fs::write(&excluded, "linked-review-token\n").unwrap();

        if !create_file_symlink(&excluded, &alias) {
            let _ = fs::remove_dir_all(root);
            return;
        }

        let result = grep_search(
            GrepOptions::new("linked-review-token", root.to_string_lossy().to_string())
                .output_mode(OutputMode::FilesWithMatches)
                .excluded_paths(vec![excluded.to_string_lossy().to_string()])
                .reject_linked_files(true),
            None,
            None,
        )
        .unwrap();

        assert!(!result.result_text.contains("alias.txt"));
        assert_eq!(result.file_count, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exact_exclusions_block_file_hard_link_aliases() {
        let root = make_temp_dir("excluded-hard-link");
        let excluded = root.join("excluded.txt");
        let alias = root.join("alias.txt");
        fs::write(&excluded, "linked-review-token\n").unwrap();
        fs::hard_link(&excluded, &alias).unwrap();

        let result = grep_search(
            GrepOptions::new("linked-review-token", root.to_string_lossy().to_string())
                .output_mode(OutputMode::FilesWithMatches)
                .excluded_paths(vec![excluded.to_string_lossy().to_string()])
                .reject_linked_files(true),
            None,
            None,
        )
        .unwrap();

        assert!(!result.result_text.contains("alias.txt"));
        assert_eq!(result.file_count, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exact_exclusions_block_file_symlinks_outside_the_search_root() {
        let root = make_temp_dir("excluded-outside-link");
        let outside = make_temp_dir("outside-link-target");
        let alias = root.join("outside-alias.txt");
        let secret = outside.join("secret.txt");
        fs::write(&secret, "outside-review-token\n").unwrap();
        if !create_file_symlink(&secret, &alias) {
            let _ = fs::remove_dir_all(root);
            let _ = fs::remove_dir_all(outside);
            return;
        }

        let result = grep_search(
            GrepOptions::new("outside-review-token", root.to_string_lossy().to_string())
                .output_mode(OutputMode::FilesWithMatches)
                .reject_linked_files(true),
            None,
            None,
        )
        .unwrap();

        assert_eq!(result.file_count, 0);
        assert!(!result.result_text.contains("outside-alias.txt"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn parallel_output_modes_keep_stable_order_and_counts() {
        let root = make_temp_dir("parallel-output");
        fs::write(root.join("z-last.txt"), "parallel-token\n").unwrap();
        fs::write(root.join("a-first.txt"), "parallel-token\n").unwrap();
        let display_base = root.to_string_lossy().to_string();

        let content = grep_search(
            GrepOptions::new("parallel-token", root.to_string_lossy().to_string())
                .output_mode(OutputMode::Content)
                .display_base(display_base.clone()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            content.result_text,
            "a-first.txt:1:parallel-token\nz-last.txt:1:parallel-token"
        );

        let count = grep_search(
            GrepOptions::new("parallel-token", root.to_string_lossy().to_string())
                .output_mode(OutputMode::Count)
                .display_base(display_base),
            None,
            None,
        )
        .unwrap();
        assert_eq!(count.file_count, 2);
        assert_eq!(count.total_matches, 2);
        assert_eq!(
            count.result_text,
            "Total 2 matches in 2 files:\na-first.txt:1\nz-last.txt:1"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parallel_content_order_is_stable_across_repeated_runs() {
        // Two files can agree by luck; sixty spread over eight workers cannot. Names are written in
        // an order unrelated to their sort order so a reducer that just preserved arrival order
        // would produce something different from the sorted answer.
        let root = make_temp_dir("parallel-stable-order");
        for index in (0..60).rev() {
            fs::write(
                root.join(format!("file-{index:02}.txt")),
                "parallel-token\n",
            )
            .unwrap();
        }
        let display_base = root.to_string_lossy().to_string();

        let run = || {
            grep_search(
                GrepOptions::new("parallel-token", root.to_string_lossy().to_string())
                    .output_mode(OutputMode::Content)
                    .display_base(display_base.clone()),
                None,
                None,
            )
            .unwrap()
            .result_text
        };

        let expected: Vec<String> = (0..60)
            .map(|index| format!("file-{index:02}.txt:1:parallel-token"))
            .collect();
        for _ in 0..5 {
            assert_eq!(run(), expected.join("\n"));
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pagination_slices_the_stable_parallel_order() {
        // Pagination is only meaningful if the underlying order is fixed: windows taken with
        // different offsets have to tile the full result exactly, with no gaps and no repeats.
        let root = make_temp_dir("parallel-pagination");
        for index in 0..60 {
            fs::write(
                root.join(format!("file-{index:02}.txt")),
                "parallel-token\n",
            )
            .unwrap();
        }
        let display_base = root.to_string_lossy().to_string();

        let page = |offset: usize, limit: usize| {
            grep_search(
                GrepOptions::new("parallel-token", root.to_string_lossy().to_string())
                    .output_mode(OutputMode::Content)
                    .display_base(display_base.clone())
                    .offset(offset)
                    .head_limit(limit),
                None,
                None,
            )
            .unwrap()
        };

        let full = page(0, 60);
        let full_lines: Vec<&str> = full.result_text.lines().collect();
        assert_eq!(full_lines.len(), 60);

        let mut tiled = Vec::new();
        for offset in (0..60).step_by(7) {
            let window = page(offset, 7);
            assert_eq!(window.applied_offset, Some(offset).filter(|it| *it > 0));
            tiled.extend(
                window
                    .result_text
                    .lines()
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            );
        }
        assert_eq!(tiled, full_lines);

        // Past the end is an empty page, not an error and not a wrapped-around one. Note that the
        // rendered text is the same "No matches found" string an genuinely empty search produces —
        // callers that need to tell the two apart have to look at `total_matches`, which still
        // reports the full unpaginated count.
        let past_end = page(60, 7);
        assert_eq!(
            past_end.result_text,
            "No matches found for pattern 'parallel-token'"
        );
        assert_eq!(past_end.total_matches, 60);

        let _ = fs::remove_dir_all(root);
    }
}
