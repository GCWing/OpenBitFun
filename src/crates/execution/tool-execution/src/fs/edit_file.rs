use crate::util::read_line_prefix::{
    read_tool_output_to_file_content, strip_read_line_number_prefix,
};
use crate::util::string::normalize_string;
use std::fs;
use std::path::PathBuf;

const MAX_MATCH_CONTEXTS: usize = 5;
const CONTEXT_LINES_BEFORE: usize = 2;
const CONTEXT_LINES_AFTER: usize = 2;
const NOT_FOUND_DIAGNOSTIC_SNIPPETS: usize = 1;
const NOT_FOUND_MIN_SUBSTRING_LEN: usize = 8;

/// Edit result, contains line number range information
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
    /// Start line number of old_string/new_string (starts from 1)
    pub start_line: usize,
    /// End line number of old_string (starts from 1)
    pub old_end_line: usize,
    /// End line number of new_string after replacement (starts from 1)
    pub new_end_line: usize,
}

/// Result of applying an edit to in-memory content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyEditResult {
    pub new_content: String,
    pub match_count: usize,
    pub edit_result: EditResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditLocalFileRequest {
    pub logical_path: String,
    pub resolved_path: PathBuf,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditLocalFileWithContentRequest {
    pub logical_path: String,
    pub resolved_path: PathBuf,
    pub current_content: String,
    pub old_string: String,
    pub new_string: String,
    pub replace_all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditLocalFileOutcome {
    pub new_content: String,
    pub match_count: usize,
    pub edit_result: EditResult,
}

/// Classified at the source, independently of diagnostic wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditContentErrorKind {
    EmptyTarget,
    NoChange,
    TargetNotFound,
    TargetAmbiguous,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditContentError {
    pub kind: EditContentErrorKind,
    pub message: String,
}
impl EditContentError {
    fn new(kind: EditContentErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn no_change() -> Self {
        Self::new(
            EditContentErrorKind::NoChange,
            "new_string must be different from old_string",
        )
    }
    pub fn detail(&self) -> Option<openbitfun_core_types::errors::ToolErrorDetail> {
        let code = match self.kind {
            EditContentErrorKind::EmptyTarget => return None,
            EditContentErrorKind::NoChange => "edit_no_change",
            EditContentErrorKind::TargetNotFound => "edit_target_not_found",
            EditContentErrorKind::TargetAmbiguous => "edit_target_ambiguous",
        };
        Some(openbitfun_core_types::errors::ToolErrorDetail {
            code: code.into(),
            kind: "guidance".into(),
        })
    }
}
impl std::fmt::Display for EditContentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EditContentError {}

pub fn edit_success_message(logical_path: &str) -> String {
    format!("Successfully edited {}", logical_path)
}

/// Count lines before given byte position (line numbers start from 1)
fn count_lines_before(content: &str, byte_pos: usize) -> usize {
    content[..byte_pos].matches('\n').count() + 1
}

/// Count newlines in string
fn count_newlines(s: &str) -> usize {
    s.matches('\n').count()
}

fn match_contexts(content: &str, old_string: &str, matches: &[(usize, &str)]) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let old_line_count = count_newlines(old_string) + 1;
    let mut contexts = Vec::new();

    for (idx, (byte_pos, _)) in matches.iter().take(MAX_MATCH_CONTEXTS).enumerate() {
        let start_line = count_lines_before(content, *byte_pos);
        let old_end_line = start_line + old_line_count.saturating_sub(1);
        let context_start_line = start_line.saturating_sub(CONTEXT_LINES_BEFORE).max(1);
        let context_end_line = (old_end_line + CONTEXT_LINES_AFTER).min(lines.len().max(1));
        let snippet = lines[(context_start_line - 1)..context_end_line].join("\n");

        contexts.push(format!(
            "[match {} starts at line {}]\n{}",
            idx + 1,
            start_line,
            snippet
        ));
    }

    let omitted = matches.len().saturating_sub(MAX_MATCH_CONTEXTS);
    let omitted_note = if omitted > 0 {
        format!("\n... {omitted} more matches omitted.")
    } else {
        String::new()
    };

    format!(
        "Matched contexts (copy exact text from a snippet and add stable surrounding lines to make `old_string` unique):\n{}{}",
        contexts.join("\n---\n"),
        omitted_note
    )
}

/// Remove Read-tool cat -n prefixes line-by-line when present.
pub fn sanitize_read_tool_copied_text(text: &str) -> Option<String> {
    let sanitized = read_tool_output_to_file_content(text);
    (sanitized != text).then_some(sanitized)
}

fn normalize_quote_char(ch: char) -> char {
    match ch {
        '\u{2018}' | '\u{2019}' => '\'',
        '\u{201C}' | '\u{201D}' => '"',
        other => other,
    }
}

fn find_actual_string(file_content: &str, search_string: &str) -> Option<String> {
    if file_content.contains(search_string) {
        return Some(search_string.to_string());
    }

    // Normalize line endings so CRLF files can match LF search strings.
    let normalized_file = normalize_string(file_content);
    let normalized_search = normalize_string(search_string);

    if normalized_file.contains(&normalized_search) {
        return Some(search_string.to_string());
    }

    // Quote normalization maps one char to one char, so a match in the
    // quote-normalized text starts at the same char offset in the original and
    // spans the same number of chars.  Normalizing both sides once lets
    // `str::find` locate it, instead of comparing every window by hand — that
    // comparison is quadratic when the file holds long runs of one character.
    let quoted_file: String = normalized_file.chars().map(normalize_quote_char).collect();
    let quoted_search: String = normalized_search
        .chars()
        .map(normalize_quote_char)
        .collect();

    let match_start = quoted_file.find(&quoted_search)?;
    let chars_before = quoted_file[..match_start].chars().count();
    let match_chars = quoted_search.chars().count();

    Some(
        normalized_file
            .chars()
            .skip(chars_before)
            .take(match_chars)
            .collect(),
    )
}

/// Replace every tab with `tab_width` spaces.
fn convert_tabs_to_spaces(s: &str, tab_width: usize) -> String {
    s.replace('\t', &" ".repeat(tab_width))
}

/// Replace leading spaces on each line with tabs when the space count is a
/// clean multiple of `tab_width`. Lines whose leading whitespace contains
/// tabs or whose space count is not divisible by `tab_width` are left as-is.
fn convert_leading_spaces_to_tabs(s: &str, tab_width: usize) -> String {
    s.lines()
        .map(|line| {
            let trimmed_start = line.len() - line.trim_start().len();
            let leading = &line[..trimmed_start];

            if leading.is_empty()
                || !leading.chars().all(|c| c == ' ')
                || leading.len() % tab_width != 0
            {
                return line.to_string();
            }

            let tabs = "\t".repeat(leading.len() / tab_width);
            tabs + &line[trimmed_start..]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn edit_string_candidates(
    content: &str,
    old_string: &str,
    new_string: &str,
) -> Vec<(String, String)> {
    let mut candidates = Vec::new();
    let mut push_candidate = |old: String, new: String| {
        if !candidates
            .iter()
            .any(|(existing_old, existing_new)| existing_old == &old && existing_new == &new)
        {
            candidates.push((old, new));
        }
    };

    push_candidate(old_string.to_string(), new_string.to_string());

    if let Some(sanitized_old) = sanitize_read_tool_copied_text(old_string) {
        let sanitized_new =
            sanitize_read_tool_copied_text(new_string).unwrap_or_else(|| new_string.to_string());
        push_candidate(sanitized_old, sanitized_new);
    }

    if let Some(actual_old) = find_actual_string(content, old_string) {
        push_candidate(actual_old, new_string.to_string());
    }

    if !old_string.ends_with('\n') {
        let with_newline = format!("{old_string}\n");
        if content.contains(&with_newline) {
            push_candidate(with_newline, format!("{new_string}\n"));
        }
    }

    // Whitespace-normalization fallbacks: when the model copies indentation
    // with tabs instead of spaces (or vice versa), try common conversions.
    // Only the old/new string pair is transformed — file content is never
    // rewritten speculatively.  Each pair must pass exact match inside
    // apply_match_and_replace (after CRLF normalization) before any write.
    for tab_width in [2, 4] {
        let tabs_to_spaces_old = convert_tabs_to_spaces(old_string, tab_width);
        if tabs_to_spaces_old != old_string {
            let tabs_to_spaces_new = convert_tabs_to_spaces(new_string, tab_width);
            push_candidate(tabs_to_spaces_old.clone(), tabs_to_spaces_new.clone());

            // Also try quote-normalized variant (e.g. curly quotes in file
            // after whitespace normalization).
            if let Some(actual_old) = find_actual_string(content, &tabs_to_spaces_old) {
                push_candidate(actual_old, tabs_to_spaces_new);
            }
        }

        let spaces_to_tabs_old = convert_leading_spaces_to_tabs(old_string, tab_width);
        if spaces_to_tabs_old != old_string {
            let spaces_to_tabs_new = convert_leading_spaces_to_tabs(new_string, tab_width);
            push_candidate(spaces_to_tabs_old.clone(), spaces_to_tabs_new.clone());

            if let Some(actual_old) = find_actual_string(content, &spaces_to_tabs_old) {
                push_candidate(actual_old, spaces_to_tabs_new);
            }
        }
    }

    candidates
}

fn contains_read_tool_line_prefixes(text: &str) -> bool {
    text.lines()
        .any(|line| strip_read_line_number_prefix(line) != line)
}

fn contains_read_truncation_marker(text: &str) -> bool {
    text.contains(" [truncated]")
}

fn longest_shared_prefix_len(left: &str, right: &str) -> usize {
    left.chars()
        .zip(right.chars())
        .take_while(|(a, b)| a == b)
        .count()
}

fn longest_shared_suffix_len(left: &str, right: &str) -> usize {
    longest_shared_prefix_len(
        &left.chars().rev().collect::<String>(),
        &right.chars().rev().collect::<String>(),
    )
}

fn snippet_context(lines: &[&str], line_idx: usize) -> String {
    let start = line_idx.saturating_sub(CONTEXT_LINES_BEFORE);
    let end = (line_idx + CONTEXT_LINES_AFTER + 1).min(lines.len());
    lines[start..end].join("\n")
}

fn build_not_found_diagnostics(content: &str, old_string: &str) -> String {
    let mut hints = vec![
        "Re-read the target lines with Read (use start_line/limit if needed), then copy the exact text after the tab on each line into old_string without reformatting indentation.".to_string(),
    ];

    if contains_read_tool_line_prefixes(old_string) {
        hints.push(
            "Detected Read-tool line-number prefixes inside `old_string`. Copy only the text after the tab on each line.".to_string(),
        );
    }

    if contains_read_truncation_marker(old_string) {
        hints.push(
            "Detected a Read-tool `[truncated]` marker inside `old_string`. Re-read with start_line/limit so the target lines are complete.".to_string(),
        );
    }

    let normalized_content = normalize_string(content);
    let lines: Vec<&str> = normalized_content.split('\n').collect();
    let anchor_line = old_string
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(old_string)
        .trim();

    if !anchor_line.is_empty() {
        let mut candidates = Vec::new();
        for (idx, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let shared_prefix = longest_shared_prefix_len(anchor_line, trimmed);
            let shared_suffix = longest_shared_suffix_len(anchor_line, trimmed);
            let score = shared_prefix.max(shared_suffix);

            if anchor_line.contains(trimmed)
                || trimmed.contains(anchor_line)
                || score >= NOT_FOUND_MIN_SUBSTRING_LEN
            {
                candidates.push((score, idx));
            }
        }

        candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        candidates.dedup_by_key(|candidate| candidate.1);

        let snippets: Vec<String> = candidates
            .into_iter()
            .take(NOT_FOUND_DIAGNOSTIC_SNIPPETS)
            .map(|(_, idx)| {
                format!(
                    "[nearby content around line {}]\n{}",
                    idx + 1,
                    snippet_context(&lines, idx)
                )
            })
            .collect();

        if !snippets.is_empty() {
            hints.push(format!(
                "Closest current file snippet:\n{}",
                snippets.join("\n---\n")
            ));
        }
    }

    hints.join("\n\n")
}

/// Core match-and-replace logic.  `normalized_content` and `uses_crlf` are
/// pre-computed by the caller so they are not re-derived per candidate.
fn apply_match_and_replace(
    normalized_content: &str,
    uses_crlf: bool,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<ApplyEditResult, EditContentError> {
    let normalized_old = normalize_string(old_string);
    let normalized_new = normalize_string(new_string);

    if normalized_old.is_empty() {
        return Err(EditContentError::new(
            EditContentErrorKind::EmptyTarget,
            "old_string cannot be empty.",
        ));
    }

    let matches: Vec<_> = normalized_content.match_indices(&normalized_old).collect();

    if matches.is_empty() {
        return Err(EditContentError::new(
            EditContentErrorKind::TargetNotFound,
            "old_string not found in file.",
        ));
    }

    if matches.len() > 1 && !replace_all {
        return Err(EditContentError::new(EditContentErrorKind::TargetAmbiguous, format!(
            "`old_string` appears {} times in file, either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n{}",
            matches.len(),
            match_contexts(normalized_content, &normalized_old, &matches)
        )));
    }

    let first_match_pos = matches[0].0;
    let start_line = count_lines_before(normalized_content, first_match_pos);
    let old_end_line = start_line + count_newlines(&normalized_old);
    let new_end_line = start_line + count_newlines(&normalized_new);

    let new_normalized_content = if replace_all {
        normalized_content.replace(&normalized_old, &normalized_new)
    } else {
        normalized_content.replacen(&normalized_old, &normalized_new, 1)
    };

    let new_content = if uses_crlf {
        new_normalized_content.replace("\n", "\r\n")
    } else {
        new_normalized_content
    };

    Ok(ApplyEditResult {
        new_content,
        match_count: matches.len(),
        edit_result: EditResult {
            start_line,
            old_end_line,
            new_end_line,
        },
    })
}

pub fn apply_edit_to_content(
    content: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<ApplyEditResult, EditContentError> {
    if !old_string.is_empty() && old_string == new_string {
        return Err(EditContentError::no_change());
    }
    let mut last_error = String::from("old_string not found in file.");

    // Pre-compute so every candidate iteration reuses the same normalized form.
    let uses_crlf = content.contains("\r\n");
    let normalized_content = normalize_string(content);

    for (candidate_old, candidate_new) in edit_string_candidates(content, old_string, new_string) {
        match apply_match_and_replace(
            &normalized_content,
            uses_crlf,
            &candidate_old,
            &candidate_new,
            replace_all,
        ) {
            Ok(result) => return Ok(result),
            Err(error) if error.kind == EditContentErrorKind::TargetNotFound => {
                last_error = error.message;
            }
            Err(error) => return Err(error),
        }
    }

    Err(EditContentError::new(EditContentErrorKind::TargetNotFound, format!(
        "{}\nPossible causes: the file might be changed externally after you inspected it, or old_string was generated incorrectly (for example, with line-number prefixes, different whitespace or indentation, or truncated output).\nInspect the current target region, correct old_string to match the current file content exactly, then retry.\n{}",
        last_error,
        build_not_found_diagnostics(content, old_string)
    )))
}

pub fn edit_file(
    file_path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
) -> Result<EditResult, String> {
    let content = fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read file {}: {}", file_path, e))?;
    let result = apply_edit_to_content(&content, old_string, new_string, replace_all)
        .map_err(|error| error.to_string())?;

    fs::write(file_path, &result.new_content)
        .map_err(|e| format!("Failed to write file {}: {}", file_path, e))?;

    Ok(result.edit_result)
}

pub fn edit_local_file(request: EditLocalFileRequest) -> Result<EditLocalFileOutcome, String> {
    let content = fs::read_to_string(&request.resolved_path)
        .map_err(|error| format!("Failed to read file {}: {}", request.logical_path, error))?;
    edit_local_file_with_content(EditLocalFileWithContentRequest {
        logical_path: request.logical_path,
        resolved_path: request.resolved_path,
        current_content: content,
        old_string: request.old_string,
        new_string: request.new_string,
        replace_all: request.replace_all,
    })
}

pub fn edit_local_file_with_content(
    request: EditLocalFileWithContentRequest,
) -> Result<EditLocalFileOutcome, String> {
    let result = apply_edit_to_content(
        &request.current_content,
        &request.old_string,
        &request.new_string,
        request.replace_all,
    )
    .map_err(|error| error.to_string())?;

    fs::write(&request.resolved_path, result.new_content.as_bytes())
        .map_err(|error| format!("Failed to write file {}: {}", request.logical_path, error))?;

    Ok(EditLocalFileOutcome {
        new_content: result.new_content,
        match_count: result.match_count,
        edit_result: result.edit_result,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_edit_to_content, edit_file, edit_success_message, sanitize_read_tool_copied_text,
        EditContentErrorKind, EditResult,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn write_temp_file(contents: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("openbitfun-edit-file-test-{unique}.txt"));
        fs::write(&path, contents).expect("temp file should be written");
        path
    }

    #[test]
    fn sanitize_read_tool_copied_text_strips_cat_n_prefixes() {
        let sanitized = sanitize_read_tool_copied_text("     1\talpha\n     2\tbeta")
            .expect("read prefixes should be stripped");

        assert_eq!(sanitized, "alpha\nbeta");
    }

    #[test]
    fn sanitize_read_tool_copied_text_allows_mixed_lines() {
        let sanitized = sanitize_read_tool_copied_text("     1\talpha\nplain")
            .expect("partial prefixes should still be stripped");

        assert_eq!(sanitized, "alpha\nplain");
    }

    #[test]
    fn apply_edit_to_content_matches_curly_quotes() {
        let content = "msg := “hello”\n";
        let result = apply_edit_to_content(content, "msg := \"hello\"", "msg := \"hi\"", false)
            .expect("quote-normalized edit should succeed");

        assert_eq!(result.new_content, "msg := \"hi\"\n");
    }

    #[test]
    fn apply_edit_to_content_matches_multiline_lf_input_against_crlf_file() {
        let content = "header\r\nalpha\r\nbeta\r\nfooter\r\n";
        let result = apply_edit_to_content(content, "alpha\nbeta", "alpha\nBETA", false)
            .expect("edit should succeed");

        assert_eq!(result.match_count, 1);
        assert_eq!(
            result.edit_result,
            EditResult {
                start_line: 2,
                old_end_line: 3,
                new_end_line: 3,
            }
        );
        assert_eq!(result.new_content, "header\r\nalpha\r\nBETA\r\nfooter\r\n");
    }

    #[test]
    fn apply_edit_to_content_accepts_read_tool_line_prefixes() {
        let content = "alpha\nbeta\n";
        let result =
            apply_edit_to_content(content, "     1\talpha\n     2\tbeta", "alpha\nBETA", false)
                .expect("edit should succeed with read prefixes");

        assert_eq!(result.new_content, "alpha\nBETA\n");
    }

    #[test]
    fn apply_edit_to_content_replace_all_reports_match_count() {
        let result = apply_edit_to_content("one\r\ntwo\r\none\r\n", "one", "ONE", true)
            .expect("replace_all should succeed");

        assert_eq!(result.match_count, 2);
        assert_eq!(result.new_content, "ONE\r\ntwo\r\nONE\r\n");
        assert_eq!(result.edit_result.start_line, 1);
    }

    #[test]
    fn apply_edit_to_content_rejects_empty_old_string() {
        let error = apply_edit_to_content("alpha\n", "", "beta", false)
            .expect_err("empty old_string should fail");

        assert_eq!(error.to_string(), "old_string cannot be empty.");
    }

    #[test]
    fn content_errors_have_stable_classifications() {
        for (content, old, new, code) in [
            ("a", "a", "a", "edit_no_change"),
            ("a", "b", "c", "edit_target_not_found"),
            ("aa", "a", "b", "edit_target_ambiguous"),
        ] {
            assert_eq!(
                apply_edit_to_content(content, old, new, false)
                    .unwrap_err()
                    .detail()
                    .unwrap()
                    .code,
                code
            );
        }
        let error = apply_edit_to_content("a", "", "b", false).unwrap_err();
        assert_eq!(error.kind, EditContentErrorKind::EmptyTarget);
        assert!(error.detail().is_none());
    }

    #[test]
    fn edit_success_message_matches_tool_presentation() {
        assert_eq!(
            edit_success_message("src/lib.rs"),
            "Successfully edited src/lib.rs"
        );
    }

    #[test]
    fn apply_edit_to_content_multiple_match_error_includes_contexts() {
        let error = apply_edit_to_content(
            "first block\n  same();\nend first\n\nsecond block\n  same();\nend second\n",
            "  same();",
            "  changed();",
            false,
        )
        .expect_err("ambiguous edit should fail");

        assert!(error
            .to_string()
            .contains("`old_string` appears 2 times in file"));
        assert!(error.to_string().contains("[match 1 starts at line 2]"));
        assert!(error.to_string().contains("first block"));
        assert!(error.to_string().contains("[match 2 starts at line 6]"));
        assert!(error.to_string().contains("second block"));
    }

    #[test]
    fn apply_edit_to_content_not_found_calls_out_read_prefixes() {
        let error = apply_edit_to_content(
            "alpha\nbeta\n",
            "     1\talpha\n     2\tgamma",
            "alpha\nBETA",
            false,
        )
        .expect_err("missing text should fail");

        assert!(error.to_string().contains("Read-tool line-number prefixes"));
    }

    #[test]
    fn edit_file_preserves_crlf_when_editing_with_lf_old_string() {
        let path = write_temp_file("first\r\nalpha\r\nbeta\r\n");

        let result = edit_file(
            path.to_str().expect("utf-8 path"),
            "alpha\nbeta",
            "alpha\nBETA",
            false,
        )
        .expect("edit should succeed");
        let content = fs::read_to_string(&path).expect("edited file should be readable");

        fs::remove_file(&path).expect("temp file should be deleted");

        assert_eq!(
            result,
            EditResult {
                start_line: 2,
                old_end_line: 3,
                new_end_line: 3,
            }
        );
        assert_eq!(content, "first\r\nalpha\r\nBETA\r\n");
    }

    // -- whitespace-normalization candidate tests ----------------------------------

    #[test]
    fn apply_edit_tabs_old_matches_spaces_file_2w() {
        // Model copies with tabs; file uses 2-space indentation.
        let content = "fn main() {\n  let x = 1;\n  let y = 2;\n}\n";
        let result = apply_edit_to_content(
            content,
            "fn main() {\n\tlet x = 1;\n\tlet y = 2;\n}",
            "fn main() {\n\tlet x = 0;\n\tlet y = 0;\n}",
            false,
        )
        .expect("tabs→2-space edit should succeed");
        assert_eq!(
            result.new_content,
            "fn main() {\n  let x = 0;\n  let y = 0;\n}\n"
        );
    }

    #[test]
    fn apply_edit_tabs_old_matches_spaces_file_4w() {
        // Model copies with tabs; file uses 4-space indentation.
        let content = "fn main() {\n    let x = 1;\n}\n";
        let result = apply_edit_to_content(
            content,
            "fn main() {\n\tlet x = 1;\n}",
            "fn main() {\n\tlet x = 0;\n}",
            false,
        )
        .expect("tabs→4-space edit should succeed");
        assert_eq!(result.new_content, "fn main() {\n    let x = 0;\n}\n");
    }

    #[test]
    fn apply_edit_spaces_old_matches_tabs_file_4w() {
        // Model copies with 4-space indentation; file uses tabs.
        let content = "fn main() {\n\tlet x = 1;\n}\n";
        let result = apply_edit_to_content(
            content,
            "fn main() {\n    let x = 1;\n}",
            "fn main() {\n    let x = 0;\n}",
            false,
        )
        .expect("4-space→tabs edit should succeed");
        assert_eq!(result.new_content, "fn main() {\n\tlet x = 0;\n}\n");
    }

    #[test]
    fn apply_edit_spaces_old_matches_tabs_file_2w() {
        // Model copies with 2-space indentation; file uses tabs.
        let content = "fn main() {\n\tlet x = 1;\n}\n";
        let result = apply_edit_to_content(
            content,
            "fn main() {\n  let x = 1;\n}",
            "fn main() {\n  let x = 0;\n}",
            false,
        )
        .expect("2-space→tabs edit should succeed");
        assert_eq!(result.new_content, "fn main() {\n\tlet x = 0;\n}\n");
    }

    #[test]
    fn apply_edit_whitespace_candidate_does_not_match_when_content_differs() {
        // Tabs→spaces conversion should NOT produce a false match when the
        // non-whitespace portion of the content differs.
        let content = "fn main() {\n    let x = 1;\n}\n";
        let error = apply_edit_to_content(
            content,
            "fn main() {\n\tlet x = 999;\n}",
            "fn main() {\n\tlet x = 0;\n}",
            false,
        )
        .expect_err("different content should fail");
        assert!(error.to_string().contains("old_string not found in file."));
    }

    #[test]
    fn apply_edit_whitespace_candidate_preserves_crlf() {
        // Whitespace-normalized edit on a CRLF file must preserve CRLF.
        let content = "fn main() {\r\n    let x = 1;\r\n}\r\n";
        let result = apply_edit_to_content(
            content,
            "fn main() {\n\tlet x = 1;\n}",
            "fn main() {\n\tlet x = 0;\n}",
            false,
        )
        .expect("whitespace-normalized CRLF edit should succeed");
        assert_eq!(result.new_content, "fn main() {\r\n    let x = 0;\r\n}\r\n");
        assert_eq!(result.match_count, 1);
    }

    #[test]
    fn apply_edit_curly_quotes_with_crlf_file() {
        // find_actual_string must work on CRLF files after the fix.
        let content = "msg := \u{201c}hello\u{201d}\r\n";
        let result = apply_edit_to_content(content, "msg := \"hello\"", "msg := \"hi\"", false)
            .expect("curly-quote edit on CRLF file should succeed");
        assert_eq!(result.new_content, "msg := \"hi\"\r\n");
    }

    #[test]
    fn apply_edit_curly_quotes_with_crlf_file_and_whitespace_mismatch() {
        // Combined: CRLF file, curly quotes, AND tab↔space mismatch.
        let content = "fn main() {\r\n    msg := \u{201c}hello\u{201d}\r\n}\r\n";
        let result = apply_edit_to_content(
            content,
            "fn main() {\n\tmsg := \"hello\"\n}",
            "fn main() {\n\tmsg := \"hi\"\n}",
            false,
        )
        .expect("combined CRLF + curly + tab→space edit should succeed");
        assert_eq!(
            result.new_content,
            "fn main() {\r\n    msg := \"hi\"\r\n}\r\n"
        );
    }

    #[test]
    fn apply_edit_matches_curly_quotes_after_multibyte_content() {
        // Quote normalization maps one char to one char but changes byte
        // length. The curly quotes before the match therefore make the byte
        // offset differ between quoted_file and normalized_file, so the match
        // has to be located by char offset rather than byte offset.
        let content = "// \u{201c}prefix\u{201d} \u{5909}\u{6570}\u{306e}\u{8aac}\u{660e} \u{2014} \u{3b1}\u{3b2}\u{3b3}\nmsg := \u{201c}hello\u{201d}\n";
        let result = apply_edit_to_content(content, "msg := \"hello\"", "msg := \"hi\"", false)
            .expect("curly-quote edit after multibyte content should succeed");

        assert_eq!(
            result.new_content,
            "// \u{201c}prefix\u{201d} \u{5909}\u{6570}\u{306e}\u{8aac}\u{660e} \u{2014} \u{3b1}\u{3b2}\u{3b3}\nmsg := \"hi\"\n"
        );
    }

    #[test]
    fn apply_edit_scans_long_repeated_runs_without_hanging() {
        // A file that is one long run of a single character makes every
        // candidate window share a long prefix with the search string, the
        // worst case for comparing windows one at a time.  This input took
        // over 20 seconds before find_actual_string searched with str::find.
        let content = format!("\t{}\n", " ".repeat(256 * 1024));
        let old_string = format!("\t{}X", " ".repeat(2000));

        let started = Instant::now();
        let error = apply_edit_to_content(&content, &old_string, "replacement", false)
            .expect_err("old_string is not present in the file");

        assert!(error.to_string().contains("old_string not found in file"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "scan took {:?}, expected the linear search path",
            started.elapsed()
        );
    }
}
