//! Built-in memory tools: `MemorySearch`, `MemoryFetch`, and `MemorySave`.
//!
//! The memory read path prefers these tools over raw file tools because they
//! understand the memory layout, bound their own output, and record memory usage
//! so retention stops depending on model-emitted citation blocks.
//!
//! All three tools are host-local: memory lives in the OpenBitFun user data folder,
//! is never mirrored to a remote SSH workspace, and must fail loudly instead of
//! returning a silent empty result when it is disabled or unavailable.

use crate::agentic::memories::db::{MemoryDatabase, MEMORY_PHASE2_GLOBAL_JOB_KEY};
use crate::agentic::memories::workspace::{
    ad_hoc_notes_dir, memory_index_file, memory_root_dir, memory_summary_file,
    rollout_summaries_dir, rollout_summary_file_name_for_parts,
};
use crate::agentic::memories::{MemoryPhase1Service, MemoryPhase2Runner};
use crate::agentic::persistence::PersistenceManager;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
    ValidationResult,
};
use crate::infrastructure::get_path_manager_arc;
use crate::service::config::get_global_config_service;
use crate::service::config::types::GlobalConfig;
use crate::service::session::{SessionMemoryMode, SessionMetadata};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use chrono::Utc;
use log::{info, warn};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tokio::io::AsyncWriteExt;

const DEFAULT_MAX_RESULTS: usize = 8;
const MAX_MAX_RESULTS: usize = 20;
const SNIPPET_CHAR_LIMIT: usize = 200;
const SNIPPET_LEAD_CHARS: usize = 60;
/// Approximate output budget: 2000 tokens at roughly 4 bytes per token.
const SEARCH_OUTPUT_BYTE_BUDGET: usize = 8_000;
const DEFAULT_FETCH_LINE_COUNT: usize = 80;
const MAX_FETCH_LINE_COUNT: usize = 200;
const FETCH_OUTPUT_BYTE_BUDGET: usize = 32_000;
const MAX_ROLLOUT_FILES_SCANNED: usize = 2_000;
const ROLLOUT_USAGE_LOOKUP_LIMIT: usize = 500;
const NOTE_SLUG_MAX_LEN: usize = 60;
const NOTE_NAME_COLLISION_LIMIT: usize = 100;
const DEFAULT_NOTE_SLUG: &str = "note";
const TASK_GROUP_HEADER_PREFIX: &str = "# task group:";

/// Memory switches that gate the tools.
///
/// `use_memories` gates the read path; `generate_memories` gates the write path
/// because an ad-hoc note or a captured session is only useful when the
/// consolidation pipeline is allowed to run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct MemoryToolGates {
    use_memories: bool,
    generate_memories: bool,
}

/// Test-only overrides.
///
/// Production tools resolve the memory root, the memory gates, and the usage
/// database from global runtime state. Unit tests inject a temporary memory root
/// and explicit gates so they never touch the real user memory folder.
#[derive(Debug, Clone)]
struct MemoryToolOverrides {
    memory_root: PathBuf,
    gates: MemoryToolGates,
    skip_usage_database: bool,
}

impl MemoryToolOverrides {
    #[cfg(test)]
    fn new(memory_root: PathBuf, gates: MemoryToolGates) -> Self {
        Self {
            memory_root,
            gates,
            skip_usage_database: true,
        }
    }
}

async fn load_global_config() -> GlobalConfig {
    match get_global_config_service().await {
        Ok(service) => service.get_config(None).await.unwrap_or_default(),
        Err(_) => GlobalConfig::default(),
    }
}

fn memory_read_disabled_error(tool_name: &str) -> OpenBitFunError {
    OpenBitFunError::tool(format!(
        "{tool_name} is disabled: the memory read path requires `memories.use_memories = true` in the OpenBitFun configuration (Settings > Memory). Enable it and retry, or continue without memory lookup."
    ))
}

fn memory_write_disabled_error(tool_name: &str) -> OpenBitFunError {
    OpenBitFunError::tool(format!(
        "{tool_name} is disabled: saving memory requires `memories.generate_memories = true` in the OpenBitFun configuration (Settings > Memory), because new notes and captured rollouts are only consolidated when memory generation is enabled. Enable it and retry."
    ))
}

fn memory_remote_workspace_error(tool_name: &str) -> OpenBitFunError {
    OpenBitFunError::tool(format!(
        "{tool_name} is not available for remote workspaces: OpenBitFun memory is host-local and is not mirrored to a remote SSH workspace. Continue without memory, or reopen this session on a local workspace."
    ))
}

fn ensure_read_gate(
    tool_name: &str,
    gates: MemoryToolGates,
    is_remote: bool,
) -> OpenBitFunResult<()> {
    if is_remote {
        return Err(memory_remote_workspace_error(tool_name));
    }
    if !gates.use_memories {
        return Err(memory_read_disabled_error(tool_name));
    }
    Ok(())
}

fn ensure_write_gate(
    tool_name: &str,
    gates: MemoryToolGates,
    is_remote: bool,
) -> OpenBitFunResult<()> {
    if is_remote {
        return Err(memory_remote_workspace_error(tool_name));
    }
    if !gates.generate_memories {
        return Err(memory_write_disabled_error(tool_name));
    }
    Ok(())
}

fn normalize_permission_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_lexical_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Whether `candidate` is inside `root`.
///
/// Canonicalized paths are compared when both sides exist on disk so symlinked
/// paths cannot escape the memory root; otherwise the comparison is lexical.
fn memory_path_is_within(candidate: &Path, root: &Path) -> bool {
    match (
        std::fs::canonicalize(candidate),
        std::fs::canonicalize(root),
    ) {
        (Ok(candidate), Ok(root)) => candidate.starts_with(&root),
        _ => normalize_lexical_path(candidate).starts_with(normalize_lexical_path(root)),
    }
}

/// Resolve a model-supplied memory path and require containment in the root.
fn resolve_memory_path(root: &Path, requested: &str) -> OpenBitFunResult<PathBuf> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err(OpenBitFunError::validation(
            "path cannot be empty".to_string(),
        ));
    }
    if requested.contains('\0') {
        return Err(OpenBitFunError::validation(
            "path must not contain NUL characters".to_string(),
        ));
    }

    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        root.join(requested)
    };
    let candidate = normalize_lexical_path(&candidate);
    if !memory_path_is_within(&candidate, root) {
        return Err(OpenBitFunError::tool(format!(
            "Memory path '{}' resolves outside the memory root '{}'. Use a memory-root-relative path such as MEMORY.md or rollout_summaries/<file>.md.",
            requested,
            root.display()
        )));
    }
    Ok(candidate)
}

fn relative_memory_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(normalize_permission_path)
        .unwrap_or_else(|_| normalize_permission_path(path))
}

async fn file_modified_unix_ms(path: &Path) -> u64 {
    match tokio::fs::metadata(path)
        .await
        .and_then(|metadata| metadata.modified())
    {
        Ok(modified) => modified
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        Err(_) => 0,
    }
}

async fn read_text_file(path: &Path) -> OpenBitFunResult<Option<String>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Ok(Some(text)),
            Err(_) => Err(OpenBitFunError::tool(format!(
                "Memory file '{}' is not UTF-8 text and cannot be read as memory.",
                path.display()
            ))),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(OpenBitFunError::io(format!(
            "Failed to read memory file '{}': {}",
            path.display(),
            error
        ))),
    }
}

// ---------------------------------------------------------------------------
// MemorySearch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemorySearchScope {
    All,
    Index,
    Summaries,
}

impl MemorySearchScope {
    fn parse(value: Option<&str>) -> OpenBitFunResult<Self> {
        match value.map(str::trim).unwrap_or("all") {
            "" | "all" => Ok(Self::All),
            "index" => Ok(Self::Index),
            "summaries" => Ok(Self::Summaries),
            other => Err(OpenBitFunError::validation(format!(
                "scope must be one of \"all\", \"index\", or \"summaries\"; received \"{other}\""
            ))),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Index => "index",
            Self::Summaries => "summaries",
        }
    }

    fn includes_index(self) -> bool {
        matches!(self, Self::All | Self::Index)
    }

    fn includes_summary_files(self) -> bool {
        matches!(self, Self::All | Self::Summaries)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryFileKind {
    Index,
    Summary,
    RolloutSummary,
}

impl MemoryFileKind {
    fn id(self) -> &'static str {
        match self {
            Self::Index => "index",
            Self::Summary => "summary",
            Self::RolloutSummary => "rollout_summary",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MemorySearchHit {
    relative_path: String,
    kind: MemoryFileKind,
    heading: Option<String>,
    line_start: usize,
    line_end: usize,
    term_hits: usize,
    total_matches: usize,
    snippet: String,
    session_id: Option<String>,
    usage_count: i64,
    modified_unix_ms: u64,
}

#[derive(Debug, Clone, Default)]
struct MemorySearchOutcome {
    hits: Vec<MemorySearchHit>,
    total_hits: usize,
    truncated: bool,
    memory_root_exists: bool,
    rollout_files_scanned: usize,
    rollout_scan_capped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MemoryTextBlock {
    heading: Option<String>,
    line_start: usize,
    line_end: usize,
}

fn tokenize_query(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for raw in query.split_whitespace() {
        let term = raw.to_lowercase();
        if term.is_empty() || terms.contains(&term) {
            continue;
        }
        terms.push(term);
    }
    terms
}

fn count_matched_terms(lower_text: &str, terms: &[String]) -> usize {
    terms
        .iter()
        .filter(|term| lower_text.contains(term.as_str()))
        .count()
}

fn count_term_matches(lower_text: &str, terms: &[String]) -> usize {
    terms
        .iter()
        .map(|term| lower_text.matches(term.as_str()).count())
        .sum()
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Build a bounded one-line snippet that starts near the first matched term.
///
/// The match offset is derived from the lowercased text, so a character whose
/// lowercase form expands can shift the window by a character or two. The window
/// is always taken by characters from the original text, so it can never split a
/// UTF-8 code point.
fn build_snippet(text: &str, lower_text: &str, terms: &[String], limit: usize) -> String {
    let match_char_offset = terms
        .iter()
        .filter_map(|term| lower_text.find(term.as_str()))
        .min()
        .map(|byte_index| lower_text[..byte_index].chars().count())
        .unwrap_or(0);
    let start = match_char_offset.saturating_sub(SNIPPET_LEAD_CHARS);
    let total_chars = text.chars().count();
    let snippet: String = text.chars().skip(start).take(limit).collect();
    let collapsed = collapse_whitespace(&snippet);
    if total_chars > start + limit {
        format!("{collapsed}...")
    } else {
        collapsed
    }
}

/// Split the memory handbook into `# Task Group:` blocks with 1-based line ranges.
///
/// Content before the first header is kept as a heading-less block so overview
/// text stays searchable.
fn split_index_blocks(content: &str) -> Vec<MemoryTextBlock> {
    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    let mut blocks = Vec::new();
    let mut current_heading: Option<String> = None;
    let mut current_start = 1usize;
    let mut current_has_content = false;

    for (index, line) in lines.iter().enumerate() {
        let line_number = index + 1;
        let trimmed = line.trim_start();
        let is_header = trimmed.to_lowercase().starts_with(TASK_GROUP_HEADER_PREFIX);
        if is_header && current_has_content {
            blocks.push(MemoryTextBlock {
                heading: current_heading.take(),
                line_start: current_start,
                line_end: line_number - 1,
            });
            current_has_content = false;
        }
        if is_header {
            current_heading = Some(trimmed.trim_start_matches('#').trim().to_string());
            current_start = line_number;
        }
        if !line.trim().is_empty() {
            current_has_content = true;
        }
    }

    if current_has_content {
        blocks.push(MemoryTextBlock {
            heading: current_heading,
            line_start: current_start,
            line_end: total_lines.max(current_start),
        });
    }
    blocks
}

fn line_texts(lines: &[&str], line_start: usize, line_end: usize) -> String {
    if lines.is_empty() || line_start == 0 || line_start > lines.len() {
        return String::new();
    }
    let start = line_start - 1;
    let end = line_end.min(lines.len());
    if end <= start {
        return String::new();
    }
    lines[start..end].join("\n")
}

fn sort_search_hits(hits: &mut [MemorySearchHit]) {
    hits.sort_by(|left, right| {
        right
            .term_hits
            .cmp(&left.term_hits)
            .then_with(|| right.modified_unix_ms.cmp(&left.modified_unix_ms))
            .then_with(|| right.usage_count.cmp(&left.usage_count))
            .then_with(|| left.relative_path.cmp(&right.relative_path))
            .then_with(|| left.line_start.cmp(&right.line_start))
    });
}

/// Keep whole hits while the serialized output stays inside `budget_bytes`.
fn apply_output_budget(
    hits: Vec<MemorySearchHit>,
    budget_bytes: usize,
) -> (Vec<MemorySearchHit>, bool) {
    let mut kept = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;

    for hit in hits {
        let size = serde_json::to_string(&search_hit_to_json(&hit))
            .map(|rendered| rendered.len() + 2)
            .unwrap_or(0);
        if !kept.is_empty() && used + size > budget_bytes {
            truncated = true;
            break;
        }
        used += size;
        kept.push(hit);
    }

    (kept, truncated)
}

fn search_hit_to_json(hit: &MemorySearchHit) -> Value {
    let mut value = json!({
        "path": hit.relative_path,
        "kind": hit.kind.id(),
        "line_start": hit.line_start,
        "line_end": hit.line_end,
        "matched_terms": hit.term_hits,
        "total_term_matches": hit.total_matches,
        "snippet": hit.snippet,
    });
    if let Some(heading) = &hit.heading {
        value["heading"] = json!(heading);
    }
    if let Some(session_id) = &hit.session_id {
        value["session_id"] = json!(session_id);
        value["rollout_id"] = json!(session_id);
    }
    if hit.usage_count > 0 {
        value["usage_count"] = json!(hit.usage_count);
    }
    value
}

async fn rollout_summary_file_names(dir: &Path) -> OpenBitFunResult<Vec<String>> {
    let mut names = Vec::new();
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(error) => {
            return Err(OpenBitFunError::io(format!(
                "Failed to list memory rollout summaries '{}': {}",
                dir.display(),
                error
            )))
        }
    };

    while let Some(entry) = entries.next_entry().await.map_err(|error| {
        OpenBitFunError::io(format!(
            "Failed to list memory rollout summaries '{}': {}",
            dir.display(),
            error
        ))
    })? {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') || !file_name.to_lowercase().ends_with(".md") {
            continue;
        }
        let is_file = entry
            .file_type()
            .await
            .map(|file_type| file_type.is_file())
            .unwrap_or(false);
        if is_file {
            names.push(file_name);
        }
    }
    names.sort();
    Ok(names)
}

/// Rollout-summary file name -> recorded usage count / owning session id.
async fn load_rollout_summary_index(
    database: Option<&Arc<MemoryDatabase>>,
) -> (HashMap<String, i64>, HashMap<String, String>) {
    let mut usage_by_file = HashMap::new();
    let mut session_by_file = HashMap::new();
    let Some(database) = database else {
        return (usage_by_file, session_by_file);
    };

    match database.list_recent(ROLLOUT_USAGE_LOOKUP_LIMIT).await {
        Ok(rows) => {
            for row in rows {
                let file_name = rollout_summary_file_name_for_parts(
                    &row.session_id,
                    row.source_updated_at_unix_secs,
                    row.rollout_slug.as_deref(),
                );
                usage_by_file.insert(file_name.clone(), row.usage_count);
                session_by_file.insert(file_name, row.session_id);
            }
        }
        Err(error) => {
            warn!(
                "Memory tool could not read recorded memory usage; search ranking falls back to recency only: error={}",
                error
            );
        }
    }
    (usage_by_file, session_by_file)
}

/// Rollout-summary file name contributed by one search hit.
fn hit_rollout_summary_file_name(hit: &MemorySearchHit) -> Option<String> {
    if hit.kind != MemoryFileKind::RolloutSummary {
        return None;
    }
    let file_name = hit.relative_path.strip_prefix("rollout_summaries/")?;
    if file_name.is_empty() {
        return None;
    }
    Some(file_name.to_string())
}

/// Rollout ids and summary file names referenced by the returned hits.
///
/// Only the hits that were actually returned are collected. Hits dropped by
/// `max_results` truncation or by the output budget were never shown to the
/// model, so they must not refresh the retention clock.
fn search_usage_targets(hits: &[MemorySearchHit]) -> (Vec<String>, Vec<String>) {
    let mut rollout_ids: Vec<String> = Vec::new();
    let mut file_names: Vec<String> = Vec::new();

    for hit in hits {
        if let Some(file_name) = hit_rollout_summary_file_name(hit) {
            if !file_names.contains(&file_name) {
                file_names.push(file_name);
            }
        }
        let session_id = hit
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        if let Some(session_id) = session_id {
            if !rollout_ids.iter().any(|known| known == session_id) {
                rollout_ids.push(session_id.to_string());
            }
        }
    }

    (rollout_ids, file_names)
}

/// Record memory usage for the returned rollout-summary hits.
///
/// Retention counts a rollout summary as used when it is returned by search or
/// read by `MemoryFetch`, so search results keep the entries the model actually
/// saw alive. Recording is best effort: the search already produced its answer,
/// so a database failure is logged and never fails the tool call.
async fn record_search_usage(
    tool_name: &str,
    database: Option<&Arc<MemoryDatabase>>,
    hits: &[MemorySearchHit],
) -> u64 {
    let (rollout_ids, file_names) = search_usage_targets(hits);
    if rollout_ids.is_empty() && file_names.is_empty() {
        return 0;
    }
    let Some(database) = database else {
        return 0;
    };

    match database
        .record_memory_usage(&rollout_ids, &file_names)
        .await
    {
        Ok(updated) => updated,
        Err(error) => {
            warn!(
                "{tool_name} could not record memory usage for {} returned rollout summary hit(s); retention falls back to citation blocks: error={}",
                file_names.len(),
                error
            );
            0
        }
    }
}

async fn search_memory_root(
    root: &Path,
    query: &str,
    scope: MemorySearchScope,
    max_results: usize,
    usage_by_file: &HashMap<String, i64>,
    session_by_file: &HashMap<String, String>,
) -> OpenBitFunResult<MemorySearchOutcome> {
    let terms = tokenize_query(query);
    if terms.is_empty() {
        return Err(OpenBitFunError::validation(
            "query must contain at least one non-whitespace term".to_string(),
        ));
    }

    let mut outcome = MemorySearchOutcome {
        memory_root_exists: tokio::fs::metadata(root)
            .await
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false),
        ..Default::default()
    };
    let mut hits = Vec::new();

    if scope.includes_index() {
        let index_path = memory_index_file(root);
        if let Some(content) = read_text_file(&index_path).await? {
            let modified_unix_ms = file_modified_unix_ms(&index_path).await;
            let lines: Vec<&str> = content.lines().collect();
            let lower_lines: Vec<String> =
                content.lines().map(|line| line.to_lowercase()).collect();
            for block in split_index_blocks(&content) {
                let text = line_texts(&lines, block.line_start, block.line_end);
                let lower_text = line_texts(
                    &lower_lines.iter().map(String::as_str).collect::<Vec<_>>(),
                    block.line_start,
                    block.line_end,
                );
                let term_hits = count_matched_terms(&lower_text, &terms);
                if term_hits == 0 {
                    continue;
                }
                hits.push(MemorySearchHit {
                    relative_path: "MEMORY.md".to_string(),
                    kind: MemoryFileKind::Index,
                    heading: block.heading,
                    line_start: block.line_start,
                    line_end: block.line_end,
                    term_hits,
                    total_matches: count_term_matches(&lower_text, &terms),
                    snippet: build_snippet(&text, &lower_text, &terms, SNIPPET_CHAR_LIMIT),
                    session_id: None,
                    usage_count: 0,
                    modified_unix_ms,
                });
            }
        }
    }

    if scope.includes_summary_files() {
        let summary_path = memory_summary_file(root);
        if let Some(hit) = scan_flat_memory_file(
            &summary_path,
            "memory_summary.md",
            MemoryFileKind::Summary,
            &terms,
            usage_by_file,
            session_by_file,
        )
        .await?
        {
            hits.push(hit);
        }

        let summaries_dir = rollout_summaries_dir(root);
        let file_names = rollout_summary_file_names(&summaries_dir).await?;
        if file_names.len() > MAX_ROLLOUT_FILES_SCANNED {
            outcome.rollout_scan_capped = true;
        }
        for file_name in file_names.iter().take(MAX_ROLLOUT_FILES_SCANNED) {
            let path = summaries_dir.join(file_name);
            if let Some(hit) = scan_flat_memory_file(
                &path,
                &format!("rollout_summaries/{file_name}"),
                MemoryFileKind::RolloutSummary,
                &terms,
                usage_by_file,
                session_by_file,
            )
            .await?
            {
                hits.push(hit);
            }
            outcome.rollout_files_scanned += 1;
        }
    }

    sort_search_hits(&mut hits);
    outcome.total_hits = hits.len();
    if hits.len() > max_results {
        hits.truncate(max_results);
        outcome.truncated = true;
    }
    let (hits, budget_truncated) = apply_output_budget(hits, SEARCH_OUTPUT_BYTE_BUDGET);
    outcome.truncated |= budget_truncated;
    outcome.hits = hits;
    Ok(outcome)
}

/// Scan one non-index memory file and return at most one ranked hit.
async fn scan_flat_memory_file(
    path: &Path,
    relative_path: &str,
    kind: MemoryFileKind,
    terms: &[String],
    usage_by_file: &HashMap<String, i64>,
    session_by_file: &HashMap<String, String>,
) -> OpenBitFunResult<Option<MemorySearchHit>> {
    let Some(content) = read_text_file(path).await? else {
        return Ok(None);
    };
    let lower_content = content.to_lowercase();
    let term_hits = count_matched_terms(&lower_content, terms);
    if term_hits == 0 {
        return Ok(None);
    }

    let lines: Vec<&str> = content.lines().collect();
    let lower_lines: Vec<String> = content.lines().map(|line| line.to_lowercase()).collect();
    let first_match = lines
        .iter()
        .zip(lower_lines.iter())
        .position(|(_, lower)| terms.iter().any(|term| lower.contains(term.as_str())));
    let (line_start, line_end, text, lower_text) = match first_match {
        Some(index) => {
            let line_start = index + 1;
            let line_end = (index + 3).min(lines.len().max(line_start));
            (
                line_start,
                line_end,
                line_texts(&lines, line_start, line_end),
                line_texts(
                    &lower_lines.iter().map(String::as_str).collect::<Vec<_>>(),
                    line_start,
                    line_end,
                ),
            )
        }
        None => (
            1,
            lines.len().max(1),
            content.clone(),
            lower_content.clone(),
        ),
    };

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(Some(MemorySearchHit {
        relative_path: relative_path.to_string(),
        kind,
        heading: None,
        line_start,
        line_end,
        term_hits,
        total_matches: count_term_matches(&lower_content, terms),
        snippet: build_snippet(&text, &lower_text, terms, SNIPPET_CHAR_LIMIT),
        session_id: session_by_file.get(&file_name).cloned(),
        usage_count: usage_by_file.get(&file_name).copied().unwrap_or(0),
        modified_unix_ms: file_modified_unix_ms(path).await,
    }))
}

fn render_search_for_assistant(
    query: &str,
    scope: MemorySearchScope,
    root: &Path,
    outcome: &MemorySearchOutcome,
) -> String {
    if outcome.hits.is_empty() {
        let mut text = format!(
            "MemorySearch found no memory entry for \"{query}\" (scope {}).",
            scope.id()
        );
        if !outcome.memory_root_exists {
            text.push_str(&format!(
                " The memory folder does not exist yet at {}.",
                root.display()
            ));
        }
        text.push_str(" Stop the memory lookup and continue normally.");
        return text;
    }

    let mut text = format!(
        "MemorySearch \"{query}\" (scope {}) returned {} of {} matching entr{}:",
        scope.id(),
        outcome.hits.len(),
        outcome.total_hits,
        if outcome.total_hits == 1 { "y" } else { "ies" }
    );
    for (index, hit) in outcome.hits.iter().enumerate() {
        let heading = hit
            .heading
            .as_deref()
            .map(|heading| format!(" {heading}"))
            .unwrap_or_default();
        let session = hit
            .session_id
            .as_deref()
            .map(|session_id| format!(", rollout {session_id}"))
            .unwrap_or_default();
        text.push_str(&format!(
            "\n{}. {}:{}-{} [{}]{} (matched terms: {}, total matches: {}, usage: {}{})\n   {}",
            index + 1,
            hit.relative_path,
            hit.line_start,
            hit.line_end,
            hit.kind.id(),
            heading,
            hit.term_hits,
            hit.total_matches,
            hit.usage_count,
            session,
            hit.snippet
        ));
    }
    if outcome.truncated {
        text.push_str(
            "\n[MemorySearch output truncated to the memory output budget; narrow the query or lower max_results for a precise list.]",
        );
    }
    if outcome.rollout_scan_capped {
        text.push_str(&format!(
            "\n[Only the first {MAX_ROLLOUT_FILES_SCANNED} rollout summaries by file name were scanned.]"
        ));
    }
    text.push_str(
        "\nUse MemoryFetch with one of these paths (plus optional start_line and line_count) to read the full file.",
    );
    text
}

/// `MemorySearch` - ranked keyword search over the local memory folder.
pub struct MemorySearchTool {
    overrides: Option<MemoryToolOverrides>,
}

impl Default for MemorySearchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl MemorySearchTool {
    pub fn new() -> Self {
        Self { overrides: None }
    }

    #[cfg(test)]
    fn with_overrides_for_tests(overrides: MemoryToolOverrides) -> Self {
        Self {
            overrides: Some(overrides),
        }
    }

    fn memory_root(&self) -> PathBuf {
        self.overrides
            .as_ref()
            .map(|overrides| overrides.memory_root.clone())
            .unwrap_or_else(memory_root_dir)
    }

    async fn gates(&self) -> MemoryToolGates {
        match &self.overrides {
            Some(overrides) => overrides.gates,
            None => {
                let config = load_global_config().await;
                MemoryToolGates {
                    use_memories: config.memories.use_memories,
                    generate_memories: config.memories.generate_memories,
                }
            }
        }
    }

    fn usage_database(&self) -> Option<Arc<MemoryDatabase>> {
        if self
            .overrides
            .as_ref()
            .is_some_and(|overrides| overrides.skip_usage_database)
        {
            return None;
        }
        Some(Arc::new(MemoryDatabase::new(get_path_manager_arc())))
    }

    /// Read intents are declared so remote surfaces and permission policies can
    /// answer them. They are skipped when the call itself will fail loudly
    /// instead, so the user is never prompted for an unavailable call.
    fn read_intents(&self, context: &ToolUseContext) -> Vec<PermissionIntent> {
        if context.is_remote() {
            return Vec::new();
        }
        if self
            .overrides
            .as_ref()
            .is_some_and(|overrides| !overrides.gates.use_memories)
        {
            return Vec::new();
        }
        vec![PermissionIntent::new(
            "read",
            vec![normalize_permission_path(&self.memory_root())],
        )]
    }
}

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "MemorySearch"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Search the local OpenBitFun memory folder for task-relevant entries.

Memory is a host-local folder with guidance from prior runs:
- MEMORY.md: the task-group handbook and the primary search target.
- memory_summary.md: the consolidated summary that is also injected into prompts.
- rollout_summaries/*.md: per-session evidence snippets referenced by MEMORY.md.

Use MemorySearch when the request may depend on prior work, prior decisions, repository history, or user preferences and the injected memory summary is not enough. Prefer it over Grep or Read against the memory folder: it understands the memory layout, ranks results, and bounds its own output.

Scopes:
- all (default): MEMORY.md, memory_summary.md, and every rollout summary.
- index: MEMORY.md only.
- summaries: memory_summary.md and every rollout summary.

Matching is case-insensitive over whitespace-separated query terms. Results are ranked by matched term count, then file recency, then recorded memory usage. Returned rollout summaries are recorded as used, so search keeps the evidence the model actually received. Follow up with MemoryFetch to read a specific file. If nothing matches, stop the memory lookup and continue normally.

Memory is host-local: this tool is hidden when `memories.use_memories = false` or when the session runs against a remote workspace, and a direct call in that state fails with an explicit error instead of returning an empty result."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Search OpenBitFun memory (handbook, summary, rollout summaries) by keyword.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Whitespace-separated keywords. All terms are matched case-insensitively; entries matching more terms rank higher."
                },
                "scope": {
                    "type": "string",
                    "enum": ["all", "index", "summaries"],
                    "default": "all",
                    "description": "Which memory files to search: all (default) = MEMORY.md, memory_summary.md, and rollout summaries; index = MEMORY.md only; summaries = memory_summary.md and rollout summaries."
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_MAX_RESULTS,
                    "default": DEFAULT_MAX_RESULTS,
                    "description": "Maximum ranked entries to return (default 8, capped at 20)."
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    /// Memory is host-local and switchable, so an unavailable tool is hidden
    /// from the manifest instead of costing the model a round-trip. The loud
    /// gate error in `call_impl` stays as the backstop for a direct call.
    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        if context.is_some_and(|context| context.is_remote()) {
            return false;
        }
        self.gates().await.use_memories
    }

    fn permission_intents(
        &self,
        _input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(self.read_intents(context))
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default();
        format!("Search memory: {query}")
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        let count = output
            .get("result_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        format!(
            "MemorySearch returned {count} entr{}",
            if count == 1 { "y" } else { "ies" }
        )
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        self.render_result_for_assistant(output)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match input.get("query").and_then(Value::as_str) {
            Some(query) if !query.trim().is_empty() => ValidationResult::default(),
            Some(_) => ValidationResult {
                result: false,
                message: Some("query cannot be empty".to_string()),
                error_code: Some(400),
                meta: None,
            },
            None => ValidationResult {
                result: false,
                message: Some("query is required".to_string()),
                error_code: Some(400),
                meta: None,
            },
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let gates = self.gates().await;
        ensure_read_gate(self.name(), gates, context.is_remote())?;

        let query = input
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::validation("query is required".to_string()))?;
        if query.trim().is_empty() {
            return Err(OpenBitFunError::validation(
                "query cannot be empty".to_string(),
            ));
        }
        let scope = MemorySearchScope::parse(input.get("scope").and_then(Value::as_str))?;
        let max_results = input
            .get("max_results")
            .and_then(Value::as_u64)
            .map(|value| (value as usize).clamp(1, MAX_MAX_RESULTS))
            .unwrap_or(DEFAULT_MAX_RESULTS);

        let root = self.memory_root();
        let database = self.usage_database();
        let (usage_by_file, session_by_file) = load_rollout_summary_index(database.as_ref()).await;
        let outcome = search_memory_root(
            &root,
            query,
            scope,
            max_results,
            &usage_by_file,
            &session_by_file,
        )
        .await?;

        // Searched entries count as used, so retention keeps the rollout
        // summaries the model actually received.
        let usage_recorded =
            record_search_usage(self.name(), database.as_ref(), &outcome.hits).await;

        info!(
            "MemorySearch completed: query_terms={}, scope={}, memory_root={}, total_hits={}, returned_hits={}, truncated={}, usage_recorded={}",
            tokenize_query(query).len(),
            scope.id(),
            root.display(),
            outcome.total_hits,
            outcome.hits.len(),
            outcome.truncated,
            usage_recorded
        );

        let results = outcome
            .hits
            .iter()
            .map(search_hit_to_json)
            .collect::<Vec<_>>();
        let mut data = json!({
            "success": true,
            "query": query,
            "scope": scope.id(),
            "terms": tokenize_query(query),
            "memory_root": normalize_permission_path(&root),
            "memory_root_exists": outcome.memory_root_exists,
            "result_count": results.len(),
            "total_hits": outcome.total_hits,
            "truncated": outcome.truncated,
            "results": results,
        });
        if outcome.rollout_scan_capped {
            data["rollout_scan_capped"] = json!(true);
        }
        if usage_recorded > 0 {
            data["usage_recorded"] = json!(usage_recorded);
        }

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(render_search_for_assistant(query, scope, &root, &outcome)),
            image_attachments: None,
        }])
    }
}

// ---------------------------------------------------------------------------
// MemoryFetch
// ---------------------------------------------------------------------------

/// `MemoryFetch` - read one memory file with a bounded line window.
pub struct MemoryFetchTool {
    overrides: Option<MemoryToolOverrides>,
}

impl Default for MemoryFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryFetchTool {
    pub fn new() -> Self {
        Self { overrides: None }
    }

    #[cfg(test)]
    fn with_overrides_for_tests(overrides: MemoryToolOverrides) -> Self {
        Self {
            overrides: Some(overrides),
        }
    }

    fn memory_root(&self) -> PathBuf {
        self.overrides
            .as_ref()
            .map(|overrides| overrides.memory_root.clone())
            .unwrap_or_else(memory_root_dir)
    }

    async fn gates(&self) -> MemoryToolGates {
        match &self.overrides {
            Some(overrides) => overrides.gates,
            None => {
                let config = load_global_config().await;
                MemoryToolGates {
                    use_memories: config.memories.use_memories,
                    generate_memories: config.memories.generate_memories,
                }
            }
        }
    }

    fn usage_database(&self) -> Option<Arc<MemoryDatabase>> {
        if self
            .overrides
            .as_ref()
            .is_some_and(|overrides| overrides.skip_usage_database)
        {
            return None;
        }
        Some(Arc::new(MemoryDatabase::new(get_path_manager_arc())))
    }

    fn read_intents(&self, context: &ToolUseContext) -> Vec<PermissionIntent> {
        if context.is_remote() {
            return Vec::new();
        }
        if self
            .overrides
            .as_ref()
            .is_some_and(|overrides| !overrides.gates.use_memories)
        {
            return Vec::new();
        }
        vec![PermissionIntent::new(
            "read",
            vec![normalize_permission_path(&self.memory_root())],
        )]
    }

    /// Resolve a rollout id to its rollout-summary file.
    ///
    /// The database owns the id -> file-name derivation, so a registered rollout
    /// always resolves to the same file the memory pipeline wrote.
    async fn resolve_rollout_id(
        &self,
        root: &Path,
        rollout_id: &str,
    ) -> OpenBitFunResult<(PathBuf, Option<String>)> {
        let rollout_id = rollout_id.trim();
        if rollout_id.is_empty() {
            return Err(OpenBitFunError::validation(
                "rollout_id cannot be empty".to_string(),
            ));
        }

        let summaries_dir = rollout_summaries_dir(root);
        if let Some(database) = self.usage_database() {
            match database.list_recent(ROLLOUT_USAGE_LOOKUP_LIMIT).await {
                Ok(rows) => {
                    for row in rows {
                        if row.session_id != rollout_id {
                            continue;
                        }
                        let file_name = rollout_summary_file_name_for_parts(
                            &row.session_id,
                            row.source_updated_at_unix_secs,
                            row.rollout_slug.as_deref(),
                        );
                        let path = summaries_dir.join(&file_name);
                        if tokio::fs::metadata(&path).await.is_ok() {
                            return Ok((path, Some(row.session_id)));
                        }
                        return Err(OpenBitFunError::tool(format!(
                            "Rollout summary for rollout_id '{rollout_id}' is registered in the memory database but its file is missing on disk: {}",
                            path.display()
                        )));
                    }
                }
                Err(error) => {
                    warn!(
                        "MemoryFetch could not read the memory database to resolve rollout_id; falling back to file-name matching: error={}",
                        error
                    );
                }
            }
        }

        for file_name in rollout_summary_file_names(&summaries_dir).await? {
            let stem = file_name.trim_end_matches(".md");
            if file_name == rollout_id || stem == rollout_id {
                return Ok((summaries_dir.join(&file_name), None));
            }
        }

        Err(OpenBitFunError::tool(format!(
            "No rollout summary is registered for rollout_id '{rollout_id}'. Use MemorySearch to find memory entries, or pass a memory-root-relative path instead."
        )))
    }
}

#[async_trait]
impl Tool for MemoryFetchTool {
    fn name(&self) -> &str {
        "MemoryFetch"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Read one file from the local OpenBitFun memory folder.

Use MemoryFetch after MemorySearch, when MEMORY.md points at a specific evidence file, or when the user asks what memory contains. It reads one memory-root-relative path with a bounded line window and records memory usage automatically, so no <openbitfun-mem-citation> block is needed for memory read through this tool.

Provide exactly one of:
- path: a memory-root-relative path such as "MEMORY.md", "memory_summary.md", or "rollout_summaries/<file>.md".
- rollout_id: a session or rollout id, which resolves to that rollout's summary file.

Paths must stay inside the memory root; traversal outside it is rejected. Memory is host-local: this tool is hidden when `memories.use_memories = false` or when the session runs against a remote workspace, and a direct call in that state fails with an explicit error."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Read one OpenBitFun memory file and record memory usage.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Memory-root-relative path to read, for example \"MEMORY.md\", \"memory_summary.md\", or \"rollout_summaries/<file>.md\". Provide either path or rollout_id."
                },
                "rollout_id": {
                    "type": "string",
                    "description": "Session or rollout id whose rollout summary file should be read. Provide either path or rollout_id."
                },
                "start_line": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1,
                    "description": "1-based first line to return (default 1)."
                },
                "line_count": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_FETCH_LINE_COUNT,
                    "default": DEFAULT_FETCH_LINE_COUNT,
                    "description": "Number of lines to return (default 80, capped at 200)."
                }
            },
            "additionalProperties": false
        })
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    /// Same availability rule as `MemorySearch`: hidden when memory is off or
    /// the session is remote, with the loud gate error kept as a backstop.
    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        if context.is_some_and(|context| context.is_remote()) {
            return false;
        }
        self.gates().await.use_memories
    }

    fn permission_intents(
        &self,
        _input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(self.read_intents(context))
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        if let Some(path) = input.get("path").and_then(Value::as_str) {
            return format!("Read memory: {path}");
        }
        if let Some(rollout_id) = input.get("rollout_id").and_then(Value::as_str) {
            return format!("Read memory for rollout: {rollout_id}");
        }
        "Read memory file".to_string()
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        output
            .get("path")
            .and_then(Value::as_str)
            .map(|path| format!("MemoryFetch read {path}"))
            .unwrap_or_else(|| "MemoryFetch returned a memory file".to_string())
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        self.render_result_for_assistant(output)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let has_path = input
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.trim().is_empty());
        let has_rollout_id = input
            .get("rollout_id")
            .and_then(Value::as_str)
            .is_some_and(|rollout_id| !rollout_id.trim().is_empty());
        match (has_path, has_rollout_id) {
            (true, false) | (false, true) => ValidationResult::default(),
            (true, true) => ValidationResult {
                result: false,
                message: Some("provide either path or rollout_id, not both".to_string()),
                error_code: Some(400),
                meta: None,
            },
            (false, false) => ValidationResult {
                result: false,
                message: Some("path or rollout_id is required".to_string()),
                error_code: Some(400),
                meta: None,
            },
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let gates = self.gates().await;
        ensure_read_gate(self.name(), gates, context.is_remote())?;

        let requested_path = input
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let requested_rollout_id = input
            .get("rollout_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|rollout_id| !rollout_id.is_empty());
        let (target_path, rollout_id) = match (requested_path, requested_rollout_id) {
            (Some(path), None) => {
                let root = self.memory_root();
                (resolve_memory_path(&root, path)?, None)
            }
            (None, Some(rollout_id)) => {
                let root = self.memory_root();
                let (path, resolved_session_id) =
                    self.resolve_rollout_id(&root, rollout_id).await?;
                let path = resolve_memory_path(&root, &path.to_string_lossy())?;
                (
                    path,
                    resolved_session_id.or_else(|| Some(rollout_id.to_string())),
                )
            }
            (Some(_), Some(_)) => {
                return Err(OpenBitFunError::validation(
                    "provide either path or rollout_id, not both".to_string(),
                ))
            }
            (None, None) => {
                return Err(OpenBitFunError::validation(
                    "path or rollout_id is required".to_string(),
                ))
            }
        };

        let root = self.memory_root();
        let relative_path = relative_memory_path(&root, &target_path);
        let content = read_text_file(&target_path).await?.ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "Memory file '{relative_path}' does not exist under the memory root '{}'. Use MemorySearch to find available memory entries.",
                root.display()
            ))
        })?;

        let lines: Vec<&str> = content.lines().collect();
        let total_lines = lines.len();
        let start_line = input
            .get("start_line")
            .and_then(Value::as_u64)
            .map(|value| value.max(1) as usize)
            .unwrap_or(1);
        let line_count = input
            .get("line_count")
            .and_then(Value::as_u64)
            .map(|value| (value as usize).clamp(1, MAX_FETCH_LINE_COUNT))
            .unwrap_or(DEFAULT_FETCH_LINE_COUNT);

        let mut rendered = String::new();
        let mut rendered_lines = 0usize;
        let mut truncated = false;
        let mut last_line = start_line.saturating_sub(1);
        for (offset, line) in lines
            .iter()
            .skip(start_line.saturating_sub(1))
            .take(line_count)
            .enumerate()
        {
            let line_number = start_line + offset;
            let entry = format!("{line_number}\t{line}\n");
            if rendered_lines > 0 && rendered.len() + entry.len() > FETCH_OUTPUT_BYTE_BUDGET {
                truncated = true;
                break;
            }
            rendered.push_str(&entry);
            rendered_lines += 1;
            last_line = line_number;
        }
        if start_line.saturating_sub(1) + line_count < total_lines {
            truncated = true;
        }

        let usage = self
            .record_usage(&relative_path, rollout_id.as_deref())
            .await;
        let mut data = json!({
            "success": true,
            "path": relative_path,
            "absolute_path": normalize_permission_path(&target_path),
            "memory_root": normalize_permission_path(&root),
            "start_line": start_line,
            "end_line": last_line,
            "total_lines": total_lines,
            "returned_lines": rendered_lines,
            "truncated": truncated,
            "content": rendered,
        });
        if let Some(rollout_id) = &rollout_id {
            data["rollout_id"] = json!(rollout_id);
            data["session_id"] = json!(rollout_id);
        }
        if let Some(recorded) = usage {
            data["usage_recorded"] = json!(recorded);
        }

        let mut result_for_assistant = format!(
            "MemoryFetch {relative_path} (lines {start_line}-{last_line} of {total_lines}):\n{rendered}"
        );
        if truncated {
            result_for_assistant.push_str(&format!(
                "\n[Memory file truncated: call MemoryFetch again with start_line={} to continue.]",
                last_line + 1
            ));
        }

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

impl MemoryFetchTool {
    /// Record usage so retention stops depending on model-emitted citations.
    ///
    /// Only rollout summaries have a stage-1 row; reads of `MEMORY.md` or
    /// `memory_summary.md` have nothing to record.
    async fn record_usage(&self, relative_path: &str, rollout_id: Option<&str>) -> Option<u64> {
        if !relative_path.starts_with("rollout_summaries/") {
            return None;
        }
        let database = self.usage_database()?;
        let file_name = relative_path
            .trim_start_matches("rollout_summaries/")
            .to_string();
        let rollout_ids = rollout_id
            .map(|rollout_id| vec![rollout_id.to_string()])
            .unwrap_or_default();
        match database
            .record_memory_usage(&rollout_ids, &[file_name])
            .await
        {
            Ok(updated) => Some(updated),
            Err(error) => {
                warn!(
                    "MemoryFetch could not record memory usage for '{}': error={}",
                    relative_path, error
                );
                None
            }
        }
    }
}

// ---------------------------------------------------------------------------
// MemorySave
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemorySaveMode {
    Note,
    CaptureSession,
}

impl MemorySaveMode {
    fn parse(value: Option<&str>) -> OpenBitFunResult<Self> {
        match value.map(str::trim).unwrap_or_default() {
            "note" => Ok(Self::Note),
            "capture_session" => Ok(Self::CaptureSession),
            "" => Err(OpenBitFunError::validation("mode is required".to_string())),
            other => Err(OpenBitFunError::validation(format!(
                "mode must be \"note\" or \"capture_session\"; received \"{other}\""
            ))),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::CaptureSession => "capture_session",
        }
    }
}

/// Lowercase ASCII slug for a note file name: letters, digits, and hyphens only.
fn slugify_note_slug(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return String::new();
    };

    let mut slug = String::new();
    let mut pending_separator = false;
    for character in raw.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_separator && !slug.is_empty() {
                slug.push('-');
            }
            pending_separator = false;
            slug.push(character.to_ascii_lowercase());
            if slug.len() >= NOTE_SLUG_MAX_LEN {
                break;
            }
        } else {
            pending_separator = true;
        }
    }
    slug.truncate(NOTE_SLUG_MAX_LEN);
    slug.trim_end_matches('-').to_string()
}

fn note_file_stem(now: chrono::DateTime<Utc>, slug: &str) -> String {
    let slug = if slug.is_empty() {
        DEFAULT_NOTE_SLUG
    } else {
        slug
    };
    format!("{}-{slug}", now.format("%Y-%m-%dT%H-%M-%S"))
}

/// Create a new ad-hoc note file without ever overwriting an existing note.
async fn write_ad_hoc_note(
    notes_dir: &Path,
    stem: &str,
    content: &str,
) -> OpenBitFunResult<(PathBuf, usize)> {
    for attempt in 0..NOTE_NAME_COLLISION_LIMIT {
        let file_name = if attempt == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem}-{}.md", attempt + 1)
        };
        let path = notes_dir.join(&file_name);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => {
                file.write_all(content.as_bytes()).await.map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to write ad-hoc memory note '{}': {}",
                        path.display(),
                        error
                    ))
                })?;
                file.flush().await.map_err(|error| {
                    OpenBitFunError::io(format!(
                        "Failed to flush ad-hoc memory note '{}': {}",
                        path.display(),
                        error
                    ))
                })?;
                return Ok((path, content.len()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(OpenBitFunError::io(format!(
                    "Failed to create ad-hoc memory note '{}': {}",
                    path.display(),
                    error
                )))
            }
        }
    }

    Err(OpenBitFunError::tool(format!(
        "Could not allocate a unique ad-hoc memory note file name in '{}' after {NOTE_NAME_COLLISION_LIMIT} attempts.",
        notes_dir.display()
    )))
}

/// Best-effort explanation for a phase-1 run that extracted nothing.
///
/// The service remains authoritative for the gates; this only mirrors the
/// reportable session facts so the model learns why nothing was captured.
/// `storage_unavailable_sessions` is the one typed fact the service hands back,
/// so it is classified first instead of being re-derived from the session record.
async fn capture_session_skip_reason(
    workspace_path: &Path,
    session_id: &str,
    storage_unavailable_sessions: u64,
) -> Option<String> {
    if storage_unavailable_sessions > 0 {
        return Some("workspace session storage is not available for memory capture".to_string());
    }
    let persistence = PersistenceManager::new(get_path_manager_arc()).ok()?;
    let metadata = persistence
        .load_session_metadata(workspace_path, session_id)
        .await
        .ok()??;
    if metadata.memory_mode != SessionMemoryMode::Enabled {
        return Some(
            "memory is disabled for this session (session memory mode is not enabled), so no turns were captured"
                .to_string(),
        );
    }
    if session_last_finished_at(&metadata).is_none() {
        return Some(
            "the session has no completed turn yet, so there is nothing to capture".to_string(),
        );
    }
    None
}

fn session_last_finished_at(metadata: &SessionMetadata) -> Option<u64> {
    metadata.last_finished_at.or_else(|| {
        metadata
            .custom_metadata
            .as_ref()
            .and_then(|value| value.get("lastFinishedAt"))
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
            })
    })
}

/// Phase-2 consolidation job facts used to explain a fire-and-forget outcome.
///
/// `has_live_run` is the authoritative liveness decision and comes from
/// `MemoryDatabase::phase2_has_live_run()`, which owns the heartbeat window the
/// runner uses when it decides whether a stale-but-unexpired lease can be stolen.
/// The remaining fields are display facts only: the tool never derives liveness
/// from the lease fields, because a lease that still looks unexpired may belong to
/// a run the runner would reclaim and start itself.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Phase2JobSnapshot {
    status: String,
    has_live_run: bool,
    ownership_token: Option<String>,
    lease_until_unix_secs: Option<i64>,
    input_watermark: Option<i64>,
    last_success_watermark: Option<i64>,
}

/// Why a requested consolidation run did not produce a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase2TriggerSkipReason {
    /// Another consolidation run holds the phase-2 job.
    AlreadyInProgress,
    /// The job was free but there was nothing new to consolidate.
    NothingToConsolidate,
}

/// Classify an `Ok(None)` consolidation trigger from the job state afterwards.
///
/// A claimed run releases the job before it returns `Ok(None)`, so a live run
/// observed here belongs to another consolidation that is still working.
fn classify_phase2_skip(job_after: Option<&Phase2JobSnapshot>) -> Phase2TriggerSkipReason {
    match job_after {
        Some(job) if job.has_live_run => Phase2TriggerSkipReason::AlreadyInProgress,
        _ => Phase2TriggerSkipReason::NothingToConsolidate,
    }
}

/// Authoritative liveness of the phase-2 consolidation job.
///
/// Best effort: an unreadable database or no database handle yields `None`, which
/// the callers treat as "cannot tell" rather than as a skip reason.
async fn phase2_live_run(database: Option<&Arc<MemoryDatabase>>) -> Option<bool> {
    let database = database?;
    match database.phase2_has_live_run().await {
        Ok(has_live_run) => Some(has_live_run),
        Err(error) => {
            warn!(
                "Memory tool could not read phase-2 consolidation liveness; the trigger outcome cannot be classified: error={}",
                error
            );
            None
        }
    }
}

/// Whether a consolidation run currently owns the phase-2 job.
async fn phase2_consolidation_in_progress(database: Option<&Arc<MemoryDatabase>>) -> bool {
    phase2_live_run(database).await.unwrap_or(false)
}

/// Read the phase-2 consolidation job state. Best effort: unknown state is `None`.
async fn phase2_job_snapshot(database: Option<&Arc<MemoryDatabase>>) -> Option<Phase2JobSnapshot> {
    let has_live_run = phase2_live_run(database).await?;
    let job = match database?.get_phase2_job(MEMORY_PHASE2_GLOBAL_JOB_KEY).await {
        Ok(job) => job,
        Err(error) => {
            warn!(
                "Memory tool could not read the phase-2 consolidation job row; reporting liveness without job details: error={}",
                error
            );
            None
        }
    };

    Some(Phase2JobSnapshot {
        status: job
            .as_ref()
            .map(|job| job.status.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        has_live_run,
        ownership_token: job.as_ref().and_then(|job| job.ownership_token.clone()),
        lease_until_unix_secs: job.as_ref().and_then(|job| job.lease_until_unix_secs),
        input_watermark: job.as_ref().and_then(|job| job.input_watermark),
        last_success_watermark: job.as_ref().and_then(|job| job.last_success_watermark),
    })
}

/// Start background consolidation after a successful memory write.
///
/// The task is spawned on the ambient runtime, exactly like the memory startup
/// task and the phase-2 heartbeat, so it survives the tool call and the turn that
/// requested it. Failures are logged instead of failing the tool call: the note or
/// the captured rollout is already durable and the next memory pass picks it up.
fn spawn_phase2_consolidation(tool_name: &str, database: Option<Arc<MemoryDatabase>>) {
    let tool_name = tool_name.to_string();
    tokio::spawn(async move {
        let runner = match MemoryPhase2Runner::new().await {
            Ok(runner) => runner,
            Err(error) => {
                warn!(
                    "Memory consolidation requested by {tool_name} could not start because the runner failed to initialize: {}",
                    error
                );
                return;
            }
        };
        match runner.run_once().await {
            Ok(Some(report)) => info!(
                "Memory consolidation requested by {tool_name} completed: selected={}, candidates={}, duration_ms={}",
                report.selected_count, report.candidate_count, report.duration_ms
            ),
            Ok(None) => {
                let job_after = phase2_job_snapshot(database.as_ref()).await;
                match classify_phase2_skip(job_after.as_ref()) {
                    Phase2TriggerSkipReason::AlreadyInProgress => info!(
                        "Memory consolidation requested by {tool_name} did not run because another consolidation run is already in progress: job_status={}, new memory stays queued for the next consolidation run",
                        job_after
                            .as_ref()
                            .map(|job| job.status.as_str())
                            .unwrap_or("unknown")
                    ),
                    Phase2TriggerSkipReason::NothingToConsolidate => info!(
                        "Memory consolidation requested by {tool_name} found nothing new to consolidate: job_status={}, input_watermark={:?}, last_success_watermark={:?}",
                        job_after
                            .as_ref()
                            .map(|job| job.status.as_str())
                            .unwrap_or("unknown"),
                        job_after.as_ref().and_then(|job| job.input_watermark),
                        job_after
                            .as_ref()
                            .and_then(|job| job.last_success_watermark)
                    ),
                }
            }
            Err(error) => warn!(
                "Memory consolidation requested by {tool_name} failed: {}",
                error
            ),
        }
    });
}

/// What the tool knows about the background consolidation it requested.
///
/// `run_once()` finishes after the tool result exists, so the tool can only report
/// whether a run was requested and whether another run already owned the job.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ConsolidationRequest {
    /// A background consolidation trigger was spawned.
    requested: bool,
    /// Another consolidation run already owned the phase-2 job lease.
    already_running: bool,
}

impl ConsolidationRequest {
    fn note(&self) -> Option<&'static str> {
        match (self.requested, self.already_running) {
            (true, true) => Some(
                "Another consolidation run is already in progress, so this memory stays queued and is folded in by the next consolidation run.",
            ),
            (true, false) => Some("Background consolidation was started."),
            (false, _) => None,
        }
    }
}

/// `MemorySave` - ad-hoc note capture and current-session memory capture.
pub struct MemorySaveTool {
    overrides: Option<MemoryToolOverrides>,
}

impl Default for MemorySaveTool {
    fn default() -> Self {
        Self::new()
    }
}

impl MemorySaveTool {
    pub fn new() -> Self {
        Self { overrides: None }
    }

    #[cfg(test)]
    fn with_overrides_for_tests(overrides: MemoryToolOverrides) -> Self {
        Self {
            overrides: Some(overrides),
        }
    }

    fn memory_root(&self) -> PathBuf {
        self.overrides
            .as_ref()
            .map(|overrides| overrides.memory_root.clone())
            .unwrap_or_else(memory_root_dir)
    }

    async fn gates(&self) -> MemoryToolGates {
        match &self.overrides {
            Some(overrides) => overrides.gates,
            None => {
                let config = load_global_config().await;
                MemoryToolGates {
                    use_memories: config.memories.use_memories,
                    generate_memories: config.memories.generate_memories,
                }
            }
        }
    }

    fn write_intents(
        &self,
        mode: Option<MemorySaveMode>,
        context: &ToolUseContext,
    ) -> Vec<PermissionIntent> {
        if context.is_remote() {
            return Vec::new();
        }
        if self
            .overrides
            .as_ref()
            .is_some_and(|overrides| !overrides.gates.generate_memories)
        {
            return Vec::new();
        }

        let root = self.memory_root();
        // A note file name carries a timestamp and a collision suffix, so the
        // intent names the directory the tool writes into. Session capture writes
        // rollout summaries plus the consolidated memory files, so its intent
        // covers the whole memory root.
        let resource = match mode {
            Some(MemorySaveMode::Note) => ad_hoc_notes_dir(&root),
            _ => root,
        };
        vec![PermissionIntent::new(
            "edit",
            vec![normalize_permission_path(&resource)],
        )]
    }

    /// Database used for memory-tool bookkeeping: phase-2 job state and usage
    /// records. Test overrides keep the tools off the real user database.
    fn bookkeeping_database(&self) -> Option<Arc<MemoryDatabase>> {
        if self
            .overrides
            .as_ref()
            .is_some_and(|overrides| overrides.skip_usage_database)
        {
            return None;
        }
        Some(Arc::new(MemoryDatabase::new(get_path_manager_arc())))
    }

    /// Request a background consolidation run and report what is known about it.
    ///
    /// The run itself finishes after the tool result exists, so the tool reports
    /// the two facts it can observe: whether a trigger was spawned, and whether
    /// another run already owned the phase-2 job lease. Without the second fact a
    /// request that skipped behind a running consolidation would look identical to
    /// a request that found nothing to consolidate.
    async fn request_consolidation(&self, requested: bool) -> ConsolidationRequest {
        if !requested {
            return ConsolidationRequest::default();
        }

        let database = self.bookkeeping_database();
        let already_running = phase2_consolidation_in_progress(database.as_ref()).await;
        if already_running {
            info!(
                "MemorySave observed an in-progress consolidation run before spawning another trigger: tool=MemorySave"
            );
        }
        spawn_phase2_consolidation(self.name(), database);

        ConsolidationRequest {
            requested: true,
            already_running,
        }
    }
}

#[async_trait]
impl Tool for MemorySaveTool {
    fn name(&self) -> &str {
        "MemorySave"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Write a memory intent to the local OpenBitFun memory folder.

Modes:
- note: save an explicit ad-hoc memory note, for example when the user asks you to remember, update, or save something. It writes one new file under extensions/ad_hoc/notes/ named YYYY-MM-DDTHH-MM-SS-<slug>.md and never edits MEMORY.md or memory_summary.md; consolidation does that.
- capture_session: extract memory from the completed turns of the CURRENT session. Use it after producing a handoff or summary document, when the user confirms a task is done, or when you confidently complete a large task. It captures only persisted completed turns, so it is safe to call while later work continues.

trigger_consolidation (default true) asks the consolidation agent to fold new notes or freshly captured rollouts into MEMORY.md and memory_summary.md right away. It runs in the background, so this tool returns as soon as the write or extraction finishes. The trigger is best-effort: when another consolidation run already holds the consolidation job, this run is skipped and the new memory stays queued for the next consolidation; the result reports that with `consolidation_already_running`.

Memory is host-local: this tool is hidden when memory generation is disabled (`memories.generate_memories = false`) or when the session runs against a remote workspace, and a direct call in that state fails with an explicit error."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Save an ad-hoc memory note or capture the current session into memory.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["note", "capture_session"],
                    "description": "note writes an ad-hoc memory note; capture_session extracts memory from the completed turns of the current session."
                },
                "content": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Note content. Required for mode=note; ignored for mode=capture_session."
                },
                "slug": {
                    "type": "string",
                    "description": "Optional short slug for the note file name. Lowercased to ASCII letters, digits, and hyphens and capped at 60 characters."
                },
                "trigger_consolidation": {
                    "type": "boolean",
                    "default": true,
                    "description": "Run memory consolidation in the background after the write so MEMORY.md and memory_summary.md reflect it promptly (default true)."
                }
            },
            "required": ["mode"],
            "additionalProperties": false
        })
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    /// `MemorySave` writes the host-local memory folder, gated by
    /// `memories.generate_memories`. It is hidden when that gate is off or the
    /// session is remote; `call_impl` still fails loudly on a direct call.
    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        if context.is_some_and(|context| context.is_remote()) {
            return false;
        }
        self.gates().await.generate_memories
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let mode = MemorySaveMode::parse(input.get("mode").and_then(Value::as_str)).ok();
        Ok(self.write_intents(mode, context))
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match input.get("mode").and_then(Value::as_str) {
            Some("capture_session") => "Capture session memory".to_string(),
            _ => "Save memory note".to_string(),
        }
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        match output.get("mode").and_then(Value::as_str) {
            Some("capture_session") => output
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Session memory capture finished")
                .to_string(),
            _ => output
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Memory note saved")
                .to_string(),
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        self.render_result_for_assistant(output)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let mode = match MemorySaveMode::parse(input.get("mode").and_then(Value::as_str)) {
            Ok(mode) => mode,
            Err(error) => {
                return ValidationResult {
                    result: false,
                    message: Some(error.to_string()),
                    error_code: Some(400),
                    meta: None,
                }
            }
        };
        if mode == MemorySaveMode::Note
            && !input
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| !content.trim().is_empty())
        {
            return ValidationResult {
                result: false,
                message: Some("content is required and cannot be empty for mode=note".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        ValidationResult::default()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let gates = self.gates().await;
        ensure_write_gate(self.name(), gates, context.is_remote())?;

        let mode = MemorySaveMode::parse(input.get("mode").and_then(Value::as_str))?;
        let trigger_consolidation = input
            .get("trigger_consolidation")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        match mode {
            MemorySaveMode::Note => self.save_note(input, mode, trigger_consolidation).await,
            MemorySaveMode::CaptureSession => {
                self.capture_session(context, mode, trigger_consolidation)
                    .await
            }
        }
    }
}

impl MemorySaveTool {
    async fn save_note(
        &self,
        input: &Value,
        mode: MemorySaveMode,
        trigger_consolidation: bool,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|content| !content.is_empty())
            .ok_or_else(|| {
                OpenBitFunError::validation(
                    "content is required and cannot be empty for mode=note".to_string(),
                )
            })?;

        let root = self.memory_root();
        let notes_dir = ad_hoc_notes_dir(&root);
        tokio::fs::create_dir_all(&notes_dir)
            .await
            .map_err(|error| {
                OpenBitFunError::io(format!(
                    "Failed to create the ad-hoc memory notes directory '{}': {}",
                    notes_dir.display(),
                    error
                ))
            })?;

        let slug = slugify_note_slug(input.get("slug").and_then(Value::as_str));
        let stem = note_file_stem(Utc::now(), &slug);
        let (path, bytes_written) = write_ad_hoc_note(&notes_dir, &stem, content).await?;
        let relative_path = relative_memory_path(&root, &path);

        let consolidation = self.request_consolidation(trigger_consolidation).await;
        info!(
            "MemorySave wrote an ad-hoc memory note: memory_root={}, note_path={}, bytes={}, trigger_consolidation={}, consolidation_already_running={}",
            root.display(),
            relative_path,
            bytes_written,
            trigger_consolidation,
            consolidation.already_running
        );

        let mut message = format!(
            "Saved ad-hoc memory note {relative_path}. MEMORY.md and memory_summary.md are updated by consolidation, not by this tool."
        );
        if let Some(note) = consolidation.note() {
            message.push(' ');
            message.push_str(note);
        }

        let mut data = json!({
            "success": true,
            "mode": mode.id(),
            "note_path": relative_path,
            "absolute_path": normalize_permission_path(&path),
            "bytes_written": bytes_written,
            "consolidation_started": consolidation.requested,
            "message": message,
        });
        if consolidation.already_running {
            data["consolidation_already_running"] = json!(true);
        }

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(message),
            image_attachments: None,
        }])
    }

    async fn capture_session(
        &self,
        context: &ToolUseContext,
        mode: MemorySaveMode,
        trigger_consolidation: bool,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let session_id = context.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).ok_or_else(|| {
            OpenBitFunError::tool(
                "MemorySave capture_session requires a running session: no session id is available in this tool context."
                    .to_string(),
            )
        })?;
        let workspace_path = context.workspace_root().ok_or_else(|| {
            OpenBitFunError::tool(
                "MemorySave capture_session requires a local workspace: no workspace path is available in this tool context."
                    .to_string(),
            )
        })?;
        let workspace_path_string = workspace_path.to_string_lossy().to_string();

        let service = MemoryPhase1Service::new().await?;
        let stats = service
            .run_once_for_session(&workspace_path_string, session_id)
            .await?;
        let captured = stats.extracted_sessions > 0;

        let mut reason = if captured {
            "extracted memory from the completed turns of this session".to_string()
        } else {
            capture_session_skip_reason(
                workspace_path,
                session_id,
                stats.storage_unavailable_sessions,
            )
            .await
            .unwrap_or_else(|| {
                "no new memory was extracted: this session is already captured, or another memory job currently owns it"
                    .to_string()
            })
        };
        if stats.failed_sessions > 0 {
            reason.push_str("; extraction failed for this session, check the memory logs for the provider error");
        }

        // A capture that produced no rollout has nothing to consolidate, so the
        // trigger is only requested when extraction actually wrote memory.
        let consolidation = self
            .request_consolidation(captured && trigger_consolidation)
            .await;
        info!(
            "MemorySave capture_session finished: session_id={}, workspace_path={}, extracted={}, skipped={}, failed={}, storage_unavailable={}, consolidation_requested={}, consolidation_already_running={}",
            session_id,
            workspace_path_string,
            stats.extracted_sessions,
            stats.skipped_sessions,
            stats.failed_sessions,
            stats.storage_unavailable_sessions,
            consolidation.requested,
            consolidation.already_running
        );

        let mut message = if captured {
            format!("Captured memory from the completed turns of this session: {reason}.")
        } else {
            format!("No memory was captured: {reason}.")
        };
        if let Some(note) = consolidation.note() {
            message.push(' ');
            message.push_str(note);
        }

        let mut data = json!({
            "success": true,
            "mode": mode.id(),
            "captured": captured,
            "session_id": session_id,
            "workspace_path": workspace_path_string,
            "scanned_sessions": stats.scanned_sessions,
            "candidate_sessions": stats.candidate_sessions,
            "extracted_sessions": stats.extracted_sessions,
            "skipped_sessions": stats.skipped_sessions,
            "failed_sessions": stats.failed_sessions,
            "reason": reason,
            "consolidation_started": consolidation.requested,
            "message": message,
        });
        if consolidation.already_running {
            data["consolidation_already_running"] = json!(true);
        }

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(message),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::memories::workspace::{memory_extensions_dir, MEMORY_EXTENSIONS_DIR_NAME};
    use crate::agentic::WorkspaceBinding;
    use crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity;

    const ROLLOUT_FIXTURE_FILE_NAME: &str = "2026-01-01T00-00-00-abcd.md";

    fn gates(use_memories: bool, generate_memories: bool) -> MemoryToolGates {
        MemoryToolGates {
            use_memories,
            generate_memories,
        }
    }

    fn local_context() -> ToolUseContext {
        ToolUseContext::for_tool_listing(None, None)
    }

    fn remote_context() -> ToolUseContext {
        ToolUseContext::for_tool_listing(
            Some(WorkspaceBinding::new_remote(
                None,
                PathBuf::from("/remote/workspace"),
                "connection-1".to_string(),
                "remote".to_string(),
                WorkspaceSessionIdentity {
                    workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                    hostname: "remote-host".to_string(),
                    logical_workspace_path: "/remote/workspace".to_string(),
                    remote_connection_id: Some("connection-1".to_string()),
                },
            )),
            None,
        )
    }

    fn write_memory_root(root: &Path) {
        std::fs::create_dir_all(rollout_summaries_dir(root)).unwrap();
        std::fs::write(
            memory_index_file(root),
            "# Memory\n\nOverview line.\n\n# Task Group: Login flow\n- login redirect bug fixed in auth module\n- login token refresh documented\n\n# Task Group: Release\n- release checklist updated\n",
        )
        .unwrap();
        std::fs::write(memory_summary_file(root), "Login flow summary line.\n").unwrap();
        std::fs::write(
            rollout_summaries_dir(root).join(ROLLOUT_FIXTURE_FILE_NAME),
            "# Rollout\nlogin token refresh evidence\nsecond line\n",
        )
        .unwrap();
    }

    /// Rewrite the fixture rollout summary when a test needs to control which
    /// query terms it contains. Ordering between files with equal term hits
    /// falls back to file recency, so a test that asserts an exact order must
    /// not depend on fixture write timing.
    fn write_rollout_summary(root: &Path, content: &str) {
        std::fs::write(
            rollout_summaries_dir(root).join(ROLLOUT_FIXTURE_FILE_NAME),
            content,
        )
        .unwrap();
    }

    #[test]
    fn slugify_keeps_ascii_alphanumerics_and_hyphens() {
        assert_eq!(slugify_note_slug(Some("Fix Login Bug!")), "fix-login-bug");
        assert_eq!(slugify_note_slug(Some("  --Memories: v2  ")), "memories-v2");
        assert_eq!(slugify_note_slug(Some("路径 note")), "note");
        assert_eq!(slugify_note_slug(Some("")), "");
        assert_eq!(slugify_note_slug(None), "");
        assert_eq!(slugify_note_slug(Some("!!!")), "");
    }

    #[test]
    fn slugify_caps_length_at_sixty_characters() {
        let slug = slugify_note_slug(Some(&"a".repeat(200)));
        assert_eq!(slug.len(), NOTE_SLUG_MAX_LEN);
    }

    #[test]
    fn note_file_stem_uses_timestamp_and_default_slug() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-08-05T12:34:56Z")
            .unwrap()
            .with_timezone(&Utc);

        assert_eq!(note_file_stem(now, "deploy"), "2026-08-05T12-34-56-deploy");
        assert_eq!(
            note_file_stem(now, ""),
            format!("2026-08-05T12-34-56-{DEFAULT_NOTE_SLUG}")
        );
    }

    #[test]
    fn resolve_memory_path_rejects_traversal_and_outside_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();

        assert_eq!(
            resolve_memory_path(&root, "rollout_summaries/a.md").unwrap(),
            root.join("rollout_summaries").join("a.md")
        );
        assert_eq!(
            resolve_memory_path(&root, "nested/../MEMORY.md").unwrap(),
            root.join("MEMORY.md")
        );
        assert!(resolve_memory_path(&root, "../outside.md").is_err());
        assert!(resolve_memory_path(&root, "nested/../../outside.md").is_err());
        assert!(resolve_memory_path(&root, "").is_err());

        let outside = temp.path().join("outside.md");
        std::fs::write(&outside, "outside").unwrap();
        assert!(resolve_memory_path(&root, &outside.to_string_lossy()).is_err());

        let inside = root.join("MEMORY.md");
        std::fs::write(&inside, "inside").unwrap();
        assert_eq!(
            resolve_memory_path(&root, &inside.to_string_lossy()).unwrap(),
            inside
        );
    }

    #[test]
    fn split_index_blocks_keeps_headings_and_line_ranges() {
        let content = "preamble line\n\n# Task Group: One\nbody a\n# Task Group: Two\nbody b\n";
        let blocks = split_index_blocks(content);

        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].heading, None);
        assert_eq!((blocks[0].line_start, blocks[0].line_end), (1, 2));
        assert_eq!(blocks[1].heading.as_deref(), Some("Task Group: One"));
        assert_eq!((blocks[1].line_start, blocks[1].line_end), (3, 4));
        assert_eq!(blocks[2].heading.as_deref(), Some("Task Group: Two"));
        assert_eq!((blocks[2].line_start, blocks[2].line_end), (5, 6));
    }

    #[test]
    fn split_index_blocks_skips_empty_content() {
        assert!(split_index_blocks("").is_empty());
        assert!(split_index_blocks("\n\n   \n").is_empty());
    }

    #[test]
    fn build_snippet_bounds_output_and_marks_truncation() {
        let text = format!(
            "{}\nlogin token refresh {}",
            "x".repeat(500),
            "y".repeat(400)
        );
        let lower = text.to_lowercase();
        let snippet = build_snippet(&text, &lower, &["login token".to_string()], 200);

        assert!(snippet.len() <= SNIPPET_CHAR_LIMIT + 3);
        assert!(snippet.starts_with('x'));
        assert!(snippet.ends_with("..."));
        assert!(snippet.contains("login token refresh"));
        assert!(!snippet.contains('\n'));
    }

    #[test]
    fn sort_search_hits_ranks_terms_then_recency_then_usage() {
        let hit = |path: &str, term_hits: usize, modified: u64, usage: i64| MemorySearchHit {
            relative_path: path.to_string(),
            kind: MemoryFileKind::RolloutSummary,
            heading: None,
            line_start: 1,
            line_end: 1,
            term_hits,
            total_matches: term_hits,
            snippet: String::new(),
            session_id: None,
            usage_count: usage,
            modified_unix_ms: modified,
        };

        let mut hits = vec![
            hit("usage-wins.md", 1, 10, 5),
            hit("recency-wins.md", 1, 20, 0),
            hit("two-terms.md", 2, 1, 0),
        ];
        sort_search_hits(&mut hits);

        let order = hits
            .iter()
            .map(|hit| hit.relative_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            vec!["two-terms.md", "recency-wins.md", "usage-wins.md"]
        );
    }

    #[test]
    fn apply_output_budget_truncates_whole_hits() {
        let hit = |index: usize| MemorySearchHit {
            relative_path: format!("rollout_summaries/{index}.md"),
            kind: MemoryFileKind::RolloutSummary,
            heading: None,
            line_start: 1,
            line_end: 1,
            term_hits: 1,
            total_matches: 1,
            snippet: "s".repeat(200),
            session_id: None,
            usage_count: 0,
            modified_unix_ms: 0,
        };

        let hits = (0..10).map(hit).collect::<Vec<_>>();
        let (kept, truncated) = apply_output_budget(hits, 600);

        assert!(truncated);
        assert_eq!(kept.len(), 1);
    }

    #[tokio::test]
    async fn search_ranks_multi_term_index_blocks_first() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        // The index block matches both query terms while the rollout summary
        // matches one, so the exact order does not depend on file recency.
        write_rollout_summary(&root, "# Rollout\nlogin redirect evidence\n");

        let outcome = search_memory_root(
            &root,
            "login token",
            MemorySearchScope::All,
            DEFAULT_MAX_RESULTS,
            &HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert!(outcome.memory_root_exists);
        assert_eq!(outcome.hits.len(), 3);
        assert_eq!(outcome.hits[0].relative_path, "MEMORY.md");
        assert_eq!(outcome.hits[0].term_hits, 2);
        assert_eq!(
            outcome.hits[0].heading.as_deref(),
            Some("Task Group: Login flow")
        );
        assert_eq!(outcome.hits[0].line_start, 5);
        assert!(outcome.hits[0].snippet.contains("login"));
        assert_eq!(outcome.rollout_files_scanned, 1);
    }

    #[tokio::test]
    async fn search_scope_selects_memory_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);

        let index_only = search_memory_root(
            &root,
            "login",
            MemorySearchScope::Index,
            DEFAULT_MAX_RESULTS,
            &HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        assert!(index_only
            .hits
            .iter()
            .all(|hit| hit.relative_path == "MEMORY.md"));

        let summaries_only = search_memory_root(
            &root,
            "login",
            MemorySearchScope::Summaries,
            DEFAULT_MAX_RESULTS,
            &HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();
        let paths = summaries_only
            .hits
            .iter()
            .map(|hit| hit.relative_path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"memory_summary.md"));
        assert!(paths.contains(&"rollout_summaries/2026-01-01T00-00-00-abcd.md"));
        assert!(!paths.contains(&"MEMORY.md"));
    }

    #[tokio::test]
    async fn search_caps_results_and_reports_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);

        let outcome = search_memory_root(
            &root,
            "login",
            MemorySearchScope::All,
            1,
            &HashMap::new(),
            &HashMap::new(),
        )
        .await
        .unwrap();

        assert_eq!(outcome.hits.len(), 1);
        assert_eq!(outcome.total_hits, 3);
        assert!(outcome.truncated);
    }

    #[tokio::test]
    async fn search_uses_recorded_usage_and_session_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);

        let usage = HashMap::from([("2026-01-01T00-00-00-abcd.md".to_string(), 7i64)]);
        let sessions = HashMap::from([(
            "2026-01-01T00-00-00-abcd.md".to_string(),
            "session-abc".to_string(),
        )]);

        let outcome = search_memory_root(
            &root,
            "token refresh",
            MemorySearchScope::Summaries,
            DEFAULT_MAX_RESULTS,
            &usage,
            &sessions,
        )
        .await
        .unwrap();

        let rollout = outcome
            .hits
            .iter()
            .find(|hit| hit.kind == MemoryFileKind::RolloutSummary)
            .expect("rollout summary hit");
        assert_eq!(rollout.usage_count, 7);
        assert_eq!(rollout.session_id.as_deref(), Some("session-abc"));
    }

    #[tokio::test]
    async fn search_rejects_empty_query() {
        let temp = tempfile::tempdir().unwrap();
        let error = search_memory_root(
            temp.path(),
            "   ",
            MemorySearchScope::All,
            DEFAULT_MAX_RESULTS,
            &HashMap::new(),
            &HashMap::new(),
        )
        .await
        .expect_err("empty query must be rejected");

        assert!(error.to_string().contains("non-whitespace"));
    }

    #[test]
    fn gates_degrade_loudly() {
        let disabled = ensure_read_gate("MemorySearch", gates(false, false), false)
            .expect_err("disabled memory read must fail");
        assert!(disabled
            .to_string()
            .contains("memories.use_memories = true"));

        let remote = ensure_read_gate("MemorySearch", gates(true, true), true)
            .expect_err("remote memory read must fail");
        assert!(remote
            .to_string()
            .contains("not available for remote workspaces"));

        let write_disabled = ensure_write_gate("MemorySave", gates(true, false), false)
            .expect_err("disabled memory write must fail");
        assert!(write_disabled
            .to_string()
            .contains("memories.generate_memories = true"));

        assert!(ensure_read_gate("MemorySearch", gates(true, false), false).is_ok());
        assert!(ensure_write_gate("MemorySave", gates(false, true), false).is_ok());
    }

    #[tokio::test]
    async fn memory_search_tool_returns_ranked_hits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        // Keep the index block ahead of the summary files: it matches both
        // query terms, while each summary file matches one.
        write_rollout_summary(&root, "# Rollout\nlogin redirect evidence\n");
        let tool = MemorySearchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(true, true),
        ));

        let results = tool
            .call_impl(
                &json!({ "query": "login token", "scope": "all" }),
                &local_context(),
            )
            .await
            .unwrap();

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("MemorySearch should return a structured result");
        };
        assert_eq!(data["success"], true);
        assert_eq!(data["scope"], "all");
        assert_eq!(data["result_count"], 3);
        assert_eq!(data["memory_root"], normalize_permission_path(&root));
        assert_eq!(data["results"][0]["path"], "MEMORY.md");
        assert_eq!(data["results"][0]["kind"], "index");
    }

    #[tokio::test]
    async fn memory_search_tool_fails_loudly_when_disabled_or_remote() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        let disabled = MemorySearchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(false, true),
        ));
        let error = disabled
            .call_impl(&json!({ "query": "login" }), &local_context())
            .await
            .expect_err("disabled memory search must fail");
        assert!(error.to_string().contains("memories.use_memories = true"));

        let enabled = MemorySearchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, true),
        ));
        let error = enabled
            .call_impl(&json!({ "query": "login" }), &remote_context())
            .await
            .expect_err("remote memory search must fail");
        assert!(error.to_string().contains("remote workspaces"));
        assert!(enabled
            .permission_intents(&json!({ "query": "login" }), &remote_context())
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn memory_fetch_tool_reads_a_line_window() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        let tool = MemoryFetchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, true),
        ));

        let results = tool
            .call_impl(
                &json!({ "path": "MEMORY.md", "start_line": 5, "line_count": 2 }),
                &local_context(),
            )
            .await
            .unwrap();

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("MemoryFetch should return a structured result");
        };
        assert_eq!(data["path"], "MEMORY.md");
        assert_eq!(data["start_line"], 5);
        assert_eq!(data["end_line"], 6);
        assert_eq!(data["returned_lines"], 2);
        assert_eq!(data["truncated"], true);
        assert!(data["content"]
            .as_str()
            .unwrap()
            .contains("Task Group: Login flow"));
    }

    #[tokio::test]
    async fn memory_fetch_tool_rejects_traversal_and_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        let tool = MemoryFetchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, true),
        ));

        let traversal = tool
            .call_impl(&json!({ "path": "../secrets.md" }), &local_context())
            .await
            .expect_err("traversal must be rejected");
        assert!(traversal.to_string().contains("outside the memory root"));

        let missing = tool
            .call_impl(
                &json!({ "path": "rollout_summaries/missing.md" }),
                &local_context(),
            )
            .await
            .expect_err("missing file must fail loudly");
        assert!(missing.to_string().contains("does not exist"));

        let both = tool
            .call_impl(
                &json!({ "path": "MEMORY.md", "rollout_id": "session-1" }),
                &local_context(),
            )
            .await
            .expect_err("path and rollout_id must not be combined");
        assert!(both.to_string().contains("not both"));
    }

    #[tokio::test]
    async fn memory_fetch_tool_resolves_rollout_id_from_file_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        let tool = MemoryFetchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, true),
        ));

        let results = tool
            .call_impl(
                &json!({ "rollout_id": "2026-01-01T00-00-00-abcd" }),
                &local_context(),
            )
            .await
            .unwrap();

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("MemoryFetch should return a structured result");
        };
        assert_eq!(
            data["path"],
            "rollout_summaries/2026-01-01T00-00-00-abcd.md"
        );
        assert_eq!(data["rollout_id"], "2026-01-01T00-00-00-abcd");

        let unknown = tool
            .call_impl(
                &json!({ "rollout_id": "session-unknown" }),
                &local_context(),
            )
            .await
            .expect_err("unknown rollout id must fail loudly");
        assert!(unknown
            .to_string()
            .contains("No rollout summary is registered"));
    }

    #[tokio::test]
    async fn memory_save_note_writes_a_unique_file_under_the_notes_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();
        let tool = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(true, true),
        ));

        let first = tool
            .call_impl(
                &json!({
                    "mode": "note",
                    "content": "Remember the login redirect fix.",
                    "slug": "Login Fix",
                    "trigger_consolidation": false
                }),
                &local_context(),
            )
            .await
            .unwrap();
        let second = tool
            .call_impl(
                &json!({
                    "mode": "note",
                    "content": "Remember the login redirect fix again.",
                    "slug": "Login Fix",
                    "trigger_consolidation": false
                }),
                &local_context(),
            )
            .await
            .unwrap();

        let ToolResult::Result { data, .. } = &first[0] else {
            panic!("MemorySave should return a structured result");
        };
        assert_eq!(data["success"], true);
        assert_eq!(data["mode"], "note");
        assert_eq!(data["consolidation_started"], false);
        let first_path = data["note_path"].as_str().unwrap();
        assert!(first_path.starts_with("extensions/ad_hoc/notes/"));
        assert!(first_path.ends_with("-login-fix.md"));

        let ToolResult::Result { data, .. } = &second[0] else {
            panic!("MemorySave should return a structured result");
        };
        let second_path = data["note_path"].as_str().unwrap();
        assert_ne!(first_path, second_path);

        let note = std::fs::read_to_string(
            memory_extensions_dir(&root)
                .join("ad_hoc")
                .join("notes")
                .join(first_path.rsplit('/').next().unwrap()),
        )
        .unwrap();
        assert_eq!(note, "Remember the login redirect fix.");
        assert_eq!(
            ad_hoc_notes_dir(&root)
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
            format!("{MEMORY_EXTENSIONS_DIR_NAME}/ad_hoc/notes")
        );
    }

    #[tokio::test]
    async fn memory_save_rejects_empty_note_content_and_unknown_mode() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();
        let tool = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, true),
        ));

        let empty = tool
            .call_impl(
                &json!({ "mode": "note", "content": "   " }),
                &local_context(),
            )
            .await
            .expect_err("empty note content must be rejected");
        assert!(empty.to_string().contains("content is required"));

        let unknown = tool
            .call_impl(&json!({ "mode": "write_index" }), &local_context())
            .await
            .expect_err("unknown mode must be rejected");
        assert!(unknown.to_string().contains("mode must be"));
    }

    #[tokio::test]
    async fn memory_save_capture_session_requires_context_and_gates() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();
        let tool = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(true, true),
        ));

        let no_session = tool
            .call_impl(&json!({ "mode": "capture_session" }), &local_context())
            .await
            .expect_err("capture_session without a session must fail");
        assert!(no_session
            .to_string()
            .contains("requires a running session"));

        let disabled = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, false),
        ));
        let error = disabled
            .call_impl(&json!({ "mode": "capture_session" }), &local_context())
            .await
            .expect_err("disabled memory generation must fail");
        assert!(error
            .to_string()
            .contains("memories.generate_memories = true"));
    }

    #[tokio::test]
    async fn memory_save_declares_write_intents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();
        let tool = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(true, true),
        ));

        let note_intents = tool
            .permission_intents(&json!({ "mode": "note" }), &local_context())
            .unwrap();
        assert_eq!(note_intents.len(), 1);
        assert_eq!(note_intents[0].action, "edit");
        assert_eq!(
            note_intents[0].resources[0],
            normalize_permission_path(&ad_hoc_notes_dir(&root))
        );

        let capture_intents = tool
            .permission_intents(&json!({ "mode": "capture_session" }), &local_context())
            .unwrap();
        assert_eq!(capture_intents[0].action, "edit");
        assert_eq!(
            capture_intents[0].resources[0],
            normalize_permission_path(&root)
        );

        assert!(tool
            .permission_intents(&json!({ "mode": "note" }), &remote_context())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn memory_tools_are_direct_and_readonly_as_designed() {
        assert_eq!(
            MemorySearchTool::new().default_exposure(),
            ToolExposure::Direct
        );
        assert_eq!(
            MemoryFetchTool::new().default_exposure(),
            ToolExposure::Direct
        );
        assert_eq!(
            MemorySaveTool::new().default_exposure(),
            ToolExposure::Direct
        );
        assert!(MemorySearchTool::new().is_readonly());
        assert!(MemoryFetchTool::new().is_readonly());
        assert!(!MemorySaveTool::new().is_readonly());
        assert_eq!(MemorySearchTool::new().name(), "MemorySearch");
        assert_eq!(MemoryFetchTool::new().name(), "MemoryFetch");
        assert_eq!(MemorySaveTool::new().name(), "MemorySave");
    }

    fn search_hit(
        relative_path: &str,
        kind: MemoryFileKind,
        session_id: Option<&str>,
    ) -> MemorySearchHit {
        MemorySearchHit {
            relative_path: relative_path.to_string(),
            kind,
            heading: None,
            line_start: 1,
            line_end: 1,
            term_hits: 1,
            total_matches: 1,
            snippet: String::new(),
            session_id: session_id.map(str::to_string),
            usage_count: 0,
            modified_unix_ms: 0,
        }
    }

    #[test]
    fn search_usage_targets_only_collect_returned_rollout_hits() {
        let hits = vec![
            search_hit("MEMORY.md", MemoryFileKind::Index, None),
            search_hit("memory_summary.md", MemoryFileKind::Summary, None),
            search_hit(
                "rollout_summaries/first.md",
                MemoryFileKind::RolloutSummary,
                Some("session-1"),
            ),
            search_hit(
                "rollout_summaries/second.md",
                MemoryFileKind::RolloutSummary,
                Some("session-2"),
            ),
            // A repeated hit for the same rollout must not double count.
            search_hit(
                "rollout_summaries/first.md",
                MemoryFileKind::RolloutSummary,
                Some("session-1"),
            ),
            // A blank session id and a rollout kind without the directory
            // prefix contribute nothing.
            search_hit(
                "rollout_summaries/third.md",
                MemoryFileKind::RolloutSummary,
                Some("   "),
            ),
            search_hit("stray.md", MemoryFileKind::RolloutSummary, None),
        ];

        let (rollout_ids, file_names) = search_usage_targets(&hits);

        assert_eq!(
            file_names,
            vec![
                "first.md".to_string(),
                "second.md".to_string(),
                "third.md".to_string()
            ]
        );
        assert_eq!(
            rollout_ids,
            vec!["session-1".to_string(), "session-2".to_string()]
        );
    }

    #[tokio::test]
    async fn search_usage_recording_is_a_no_op_without_a_database() {
        let hits = vec![search_hit(
            "rollout_summaries/first.md",
            MemoryFileKind::RolloutSummary,
            Some("session-1"),
        )];

        assert_eq!(record_search_usage("MemorySearch", None, &hits).await, 0);
        assert_eq!(record_search_usage("MemorySearch", None, &[]).await, 0);
    }

    #[tokio::test]
    async fn search_usage_targets_follow_max_results_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        write_memory_root(&root);
        let extra_rollout = "2026-01-02T00-00-00-efgh.md";
        write_rollout_summary(&root, "# Rollout\nlogin token refresh evidence\n");
        std::fs::write(
            rollout_summaries_dir(&root).join(extra_rollout),
            "# Rollout\nlogin redirect evidence\n",
        )
        .unwrap();

        let sessions = HashMap::from([(
            ROLLOUT_FIXTURE_FILE_NAME.to_string(),
            "session-abc".to_string(),
        )]);

        let all_hits = search_memory_root(
            &root,
            "login token",
            MemorySearchScope::Summaries,
            DEFAULT_MAX_RESULTS,
            &HashMap::new(),
            &sessions,
        )
        .await
        .unwrap();
        assert_eq!(all_hits.hits.len(), all_hits.total_hits);
        let (_, mut all_file_names) = search_usage_targets(&all_hits.hits);
        all_file_names.sort();
        assert_eq!(
            all_file_names,
            vec![
                ROLLOUT_FIXTURE_FILE_NAME.to_string(),
                extra_rollout.to_string()
            ]
        );

        let capped = search_memory_root(
            &root,
            "login token",
            MemorySearchScope::Summaries,
            1,
            &HashMap::new(),
            &sessions,
        )
        .await
        .unwrap();
        assert_eq!(capped.total_hits, 3);
        assert_eq!(capped.hits.len(), 1);

        // Only the returned hit may refresh retention, so the collected targets
        // stay bounded by the returned hits even though three summaries matched.
        let (capped_ids, capped_file_names) = search_usage_targets(&capped.hits);
        assert!(capped_file_names.len() <= capped.hits.len());
        assert_eq!(capped_ids.len(), capped_file_names.len());
        assert!(capped_file_names.len() < all_file_names.len());
    }

    #[tokio::test]
    async fn memory_tools_hide_themselves_when_memory_is_disabled_or_remote() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();

        let read_enabled = MemorySearchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(true, true),
        ));
        assert!(
            read_enabled
                .is_available_in_context(Some(&local_context()))
                .await
        );
        assert!(
            !read_enabled
                .is_available_in_context(Some(&remote_context()))
                .await
        );
        // Without a context there is no remote information, so only the gate decides.
        assert!(read_enabled.is_available_in_context(None).await);

        let search_disabled = MemorySearchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(false, true),
        ));
        assert!(
            !search_disabled
                .is_available_in_context(Some(&local_context()))
                .await
        );

        let fetch_disabled = MemoryFetchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(false, true),
        ));
        assert!(
            !fetch_disabled
                .is_available_in_context(Some(&local_context()))
                .await
        );

        let fetch_enabled = MemoryFetchTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root.clone(),
            gates(true, true),
        ));
        assert!(
            fetch_enabled
                .is_available_in_context(Some(&local_context()))
                .await
        );
        assert!(
            !fetch_enabled
                .is_available_in_context(Some(&remote_context()))
                .await
        );

        // MemorySave follows the write gate, so a read-only memory session does
        // not advertise a save tool that would immediately fail.
        let save_without_generation = MemorySaveTool::with_overrides_for_tests(
            MemoryToolOverrides::new(root.clone(), gates(true, false)),
        );
        assert!(
            !save_without_generation
                .is_available_in_context(Some(&local_context()))
                .await
        );

        let save_enabled = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(false, true),
        ));
        assert!(
            save_enabled
                .is_available_in_context(Some(&local_context()))
                .await
        );
        assert!(
            !save_enabled
                .is_available_in_context(Some(&remote_context()))
                .await
        );
    }

    fn phase2_job(
        status: &str,
        has_live_run: bool,
        ownership_token: Option<&str>,
        lease_until_unix_secs: Option<i64>,
    ) -> Phase2JobSnapshot {
        Phase2JobSnapshot {
            status: status.to_string(),
            has_live_run,
            ownership_token: ownership_token.map(str::to_string),
            lease_until_unix_secs,
            input_watermark: Some(7),
            last_success_watermark: Some(6),
        }
    }

    #[test]
    fn classify_phase2_skip_follows_the_database_liveness_decision() {
        // A live run means another consolidation owns the job: the trigger was
        // skipped behind it, which is not "nothing to consolidate".
        let running = phase2_job("running", true, Some("token-a"), Some(1_030));
        assert_eq!(
            classify_phase2_skip(Some(&running)),
            Phase2TriggerSkipReason::AlreadyInProgress
        );

        // A finished idle run is not live.
        let idle = phase2_job("done", false, None, None);
        assert_eq!(
            classify_phase2_skip(Some(&idle)),
            Phase2TriggerSkipReason::NothingToConsolidate
        );

        // A stale-but-unexpired lease is stealable, so the database reports it as
        // not live and the trigger really had nothing pending. The lease fields
        // must never override that decision.
        let stale = phase2_job("running", false, Some("token-a"), Some(1_030));
        assert_eq!(
            classify_phase2_skip(Some(&stale)),
            Phase2TriggerSkipReason::NothingToConsolidate
        );

        // Unknown job state must never be reported as an in-progress run.
        assert_eq!(
            classify_phase2_skip(None),
            Phase2TriggerSkipReason::NothingToConsolidate
        );
    }

    #[tokio::test]
    async fn phase2_job_state_is_unavailable_without_a_database() {
        assert!(phase2_job_snapshot(None).await.is_none());
        assert!(!phase2_consolidation_in_progress(None).await);
    }

    #[tokio::test]
    async fn capture_skip_reason_reports_unavailable_workspace_storage() {
        // The typed service signal is authoritative and must not fall through to
        // the generic "already captured / owned" cause.
        let reason = capture_session_skip_reason(
            Path::new("openbitfun-unregistered-workspace"),
            "session-no-storage",
            1,
        )
        .await
        .expect("an unavailable workspace storage must be reported");
        assert_eq!(
            reason,
            "workspace session storage is not available for memory capture"
        );

        let repeated = capture_session_skip_reason(
            Path::new("openbitfun-unregistered-workspace"),
            "session-no-storage",
            7,
        )
        .await
        .expect("any positive skip count must be reported");
        assert_eq!(repeated, reason);
    }

    #[test]
    fn consolidation_request_reports_an_already_running_run() {
        assert_eq!(ConsolidationRequest::default().note(), None);
        assert_eq!(
            ConsolidationRequest {
                requested: true,
                already_running: false,
            }
            .note(),
            Some("Background consolidation was started.")
        );
        assert!(ConsolidationRequest {
            requested: true,
            already_running: true,
        }
        .note()
        .expect("an in-progress run must be reported")
        .contains("already in progress"));
        assert_eq!(
            ConsolidationRequest {
                requested: false,
                already_running: true,
            }
            .note(),
            None
        );
    }

    #[tokio::test]
    async fn memory_save_consolidation_request_is_inert_without_a_database() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("memories");
        std::fs::create_dir_all(&root).unwrap();
        let tool = MemorySaveTool::with_overrides_for_tests(MemoryToolOverrides::new(
            root,
            gates(true, true),
        ));

        // Test overrides keep the tool off the real phase-2 job state, and an
        // unrequested trigger must not spawn a background run.
        assert!(tool.bookkeeping_database().is_none());
        assert_eq!(
            tool.request_consolidation(false).await,
            ConsolidationRequest::default()
        );
    }
}
