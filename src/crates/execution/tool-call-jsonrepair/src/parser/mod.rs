use std::fmt::Write;

use crate::chars;
use crate::error::{JsonRepairError, JsonRepairErrorKind};

pub(crate) type Result<T> = std::result::Result<T, JsonRepairError>;

mod array;
mod format;
mod keyword;
mod number;
mod object;
mod string;
mod toplevel;

const MAX_DEPTH: usize = 512;

/// Recursive-descent JSON repair parser.
/// Copy-on-repair: preserves original whitespace, only modifies what needs fixing.
pub(crate) struct JsonRepairer {
    pub(super) chars: Vec<char>,
    pub(super) pos: usize,
    pub(super) output: String,
    pub(super) depth: usize,
    pub(super) comments_enabled: bool,
}

impl JsonRepairer {
    pub(crate) fn new(input: &str) -> Self {
        Self::new_with_comments(input, true)
    }

    /// Build the parser for streamed tool arguments. Tool calls use JSON, not
    /// configuration syntax, so `#`, `//`, and `/* ... */` must not discard
    /// content as comments.
    pub(crate) fn new_tool_call(input: &str) -> Self {
        Self::new_with_comments(input, false)
    }

    fn new_with_comments(input: &str, comments_enabled: bool) -> Self {
        let input = chars::strip_bom(input);
        Self {
            chars: input.chars().collect(),
            pos: 0,
            output: String::with_capacity(input.len()),
            depth: 0,
            comments_enabled,
        }
    }

    // repair() and parse_ndjson() are in toplevel.rs
    pub(super) fn parse_value(&mut self) -> Result<bool> {
        self.parse_whitespace_and_comments();
        let c = self.peek();
        macro_rules! finish {
            ($processed:expr) => {{
                let processed = $processed;
                self.parse_whitespace_and_comments();
                return Ok(processed);
            }};
        }

        if c == Some('{') {
            finish!(self.parse_object()?);
        }
        if c == Some('[') {
            finish!(self.parse_array()?);
        }
        if c == Some('`') && self.matches_at(self.pos, "```") {
            finish!(self.parse_markdown_fenced()?);
        }
        if c.is_some_and(chars::is_quote)
            || (c == Some('\\') && self.peek_at(self.pos + 1).is_some_and(chars::is_quote))
        {
            finish!(self.parse_string()?);
        }
        if c == Some('+') && self.parse_plus_number()? {
            finish!(true);
        }
        if matches!(c, Some('+') | Some('-')) && self.parse_signed_keyword()? {
            finish!(true);
        }
        if (c.is_some_and(chars::is_number_start)
            || (c == Some('.') && self.peek_at(self.pos + 1).is_some_and(chars::is_digit)))
            && self.parse_number()?
        {
            finish!(true);
        }
        if c.is_some_and(chars::is_identifier_start) && self.parse_keyword_or_unquoted()? {
            finish!(true);
        }
        if self.parse_unquoted_string(false)? {
            finish!(true);
        }
        if c == Some('/') {
            finish!(self.parse_slash()?);
        }

        self.parse_whitespace_and_comments();
        Ok(false)
    }

    fn parse_slash(&mut self) -> Result<bool> {
        self.parse_regex_as_string()
    }

    // ── Depth tracking ────────────────────────────────────

    pub(super) fn enter_container(&mut self) -> Result<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error_kind(
                "Maximum nesting depth exceeded",
                JsonRepairErrorKind::MaxDepthExceeded,
            ));
        }
        Ok(())
    }

    pub(super) fn leave_container(&mut self) {
        self.depth -= 1;
    }

    // ── Whitespace / comments ───────────────────────────────

    /// Copy whitespace to output, strip comments. Returns true if anything was consumed.
    pub(super) fn parse_whitespace_and_comments(&mut self) -> bool {
        self.parse_whitespace_and_comments_with_newline(true)
    }

    /// Copy whitespace to output, strip comments.
    /// When `skip_newline` is false, newlines are not consumed as whitespace.
    pub(super) fn parse_whitespace_and_comments_with_newline(
        &mut self,
        skip_newline: bool,
    ) -> bool {
        if !self.comments_enabled {
            return self.parse_whitespace_with_newline(skip_newline);
        }

        if self.at_end() {
            return false;
        }
        let c = self.chars[self.pos];
        if !(matches!(c, ' ' | '\t' | '\r' | '/' | '#')
            || (skip_newline && c == '\n')
            || (!c.is_ascii() && chars::is_special_whitespace(c)))
        {
            return false;
        }

        let start = self.pos;
        loop {
            while let Some(c) = self.peek() {
                match c {
                    ' ' | '\t' | '\r' => {
                        self.output.push(c);
                        self.pos += 1;
                    }
                    '\n' if skip_newline => {
                        self.output.push('\n');
                        self.pos += 1;
                    }
                    _ if !c.is_ascii() && chars::is_special_whitespace(c) => {
                        self.output.push(' ');
                        self.pos += 1;
                    }
                    _ => break,
                }
            }

            if self.peek() == Some('/') {
                if self.pos + 1 < self.chars.len() && self.chars[self.pos + 1] == '/' {
                    self.pos += 2;
                    self.skip_until_newline();
                    continue;
                }

                if self.pos + 1 < self.chars.len() && self.chars[self.pos + 1] == '*' {
                    self.pos += 2;
                    while !self.at_end() {
                        if self.chars[self.pos] == '*'
                            && self.pos + 1 < self.chars.len()
                            && self.chars[self.pos + 1] == '/'
                        {
                            self.pos += 2;
                            break;
                        }
                        self.pos += 1;
                    }
                    continue;
                }
            }

            if self.peek() == Some('#') {
                self.pos += 1;
                self.skip_until_newline();
                continue;
            }

            break;
        }
        self.pos > start
    }

    fn parse_whitespace_with_newline(&mut self, skip_newline: bool) -> bool {
        let start = self.pos;
        while let Some(c) = self.peek() {
            match c {
                ' ' | '\t' | '\r' => {
                    self.output.push(c);
                    self.pos += 1;
                }
                '\n' if skip_newline => {
                    self.output.push('\n');
                    self.pos += 1;
                }
                _ if !c.is_ascii() && chars::is_special_whitespace(c) => {
                    self.output.push(' ');
                    self.pos += 1;
                }
                _ => break,
            }
        }
        self.pos > start
    }

    // ── Helpers ─────────────────────────────────────────────

    #[inline(always)]
    pub(super) fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    #[inline(always)]
    pub(super) fn at_end(&self) -> bool {
        self.pos >= self.chars.len()
    }

    #[inline(always)]
    pub(super) fn peek_at(&self, idx: usize) -> Option<char> {
        self.chars.get(idx).copied()
    }

    /// If next char equals `c`, copy it to output and advance. Returns true if matched.
    #[inline(always)]
    pub(super) fn parse_char(&mut self, c: char) -> bool {
        if self.pos < self.chars.len() && self.chars[self.pos] == c {
            self.output.push(c);
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// If next char equals `c`, advance without copying to output.
    #[inline(always)]
    pub(super) fn skip_char(&mut self, c: char) -> bool {
        if self.pos < self.chars.len() && self.chars[self.pos] == c {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// Advance cursor until newline or end of input.
    #[inline(always)]
    pub(super) fn skip_until_newline(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos] != '\n' {
            self.pos += 1;
        }
    }

    /// Check if `pattern` matches at position `pos` in the input.
    /// Iterates pattern chars directly — no allocation.
    pub(super) fn matches_at(&self, pos: usize, pattern: &str) -> bool {
        for (i, pc) in pattern.chars().enumerate() {
            if pos + i >= self.chars.len() || self.chars[pos + i] != pc {
                return false;
            }
        }
        true
    }

    /// Fast path for the common trailing-comma rollback case.
    /// Never remove a separator before the current container's output.
    pub(super) fn strip_trailing_comma(&mut self, min_index: usize) {
        let bytes = self.output.as_bytes();
        let mut idx = bytes.len();
        while idx > min_index && matches!(bytes[idx - 1], b' ' | b'\n' | b'\r' | b'\t') {
            idx -= 1;
        }

        if idx > min_index && bytes[idx - 1] == b',' {
            self.output.remove(idx - 1);
            return;
        }

        if let Some(relative_index) = self.output[min_index..].rfind(',') {
            self.output.remove(min_index + relative_index);
        }
    }

    /// Insert `text` before any trailing whitespace in the output buffer.
    pub(super) fn insert_before_last_whitespace(&mut self, text: &str) {
        let bytes = self.output.as_bytes();
        let mut idx = bytes.len();
        while idx > 0 && matches!(bytes[idx - 1], b' ' | b'\n' | b'\r' | b'\t') {
            idx -= 1;
        }
        self.output.insert_str(idx, text);
    }

    /// Write chars from input slice directly to output — no intermediate String.
    pub(super) fn push_slice_to_output(&mut self, start: usize, end: usize) {
        for i in start..end {
            self.output.push(self.chars[i]);
        }
    }

    /// Check if input char slice equals a keyword — no allocation.
    pub(super) fn slice_eq(&self, start: usize, end: usize, keyword: &str) -> bool {
        if end - start != keyword.len() {
            return false;
        }
        keyword
            .chars()
            .enumerate()
            .all(|(i, c)| self.chars[start + i] == c)
    }

    /// Push a char to output, escaping it for JSON strings.
    pub(super) fn push_string_char(&mut self, c: char) {
        if c >= '\u{0020}' && c != '"' && c != '\\' {
            self.output.push(c);
            return;
        }

        match c {
            '"' => self.output.push_str("\\\""),
            '\\' => self.output.push_str("\\\\"),
            '\n' => self.output.push_str("\\n"),
            '\r' => self.output.push_str("\\r"),
            '\t' => self.output.push_str("\\t"),
            '\x08' => self.output.push_str("\\b"),
            '\x0C' => self.output.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(self.output, "\\u{:04x}", c as u32);
            }
            _ => self.output.push(c),
        }
    }

    fn compute_line_col(&self, pos: usize) -> (usize, usize) {
        let mut line = 1;
        let mut col = 1;
        for i in 0..pos.min(self.chars.len()) {
            if self.chars[i] == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
        }
        (line, col)
    }

    pub(super) fn error_kind(&self, msg: &str, kind: JsonRepairErrorKind) -> JsonRepairError {
        let (line, col) = self.compute_line_col(self.pos);
        JsonRepairError::with_kind(msg, self.pos, kind).with_location(line, col)
    }

    pub(super) fn error_at_kind(
        &self,
        msg: &str,
        pos: usize,
        kind: JsonRepairErrorKind,
    ) -> JsonRepairError {
        let (line, col) = self.compute_line_col(pos);
        JsonRepairError::with_kind(msg, pos, kind).with_location(line, col)
    }

    pub(super) fn error_char_kind(
        &self,
        prefix: &str,
        kind: JsonRepairErrorKind,
    ) -> JsonRepairError {
        let msg = if let Some(c) = self.peek() {
            format!("{prefix} \"{c}\"")
        } else {
            prefix.to_string()
        };
        let (line, col) = self.compute_line_col(self.pos);
        JsonRepairError::with_kind(msg, self.pos, kind).with_location(line, col)
    }

    /// Find previous non-whitespace character index from `start` backwards.
    pub(super) fn prev_non_whitespace_index(&self, start: usize) -> Option<usize> {
        let mut idx = start;
        loop {
            let c = self.peek_at(idx)?;
            if !chars::is_whitespace(c) {
                return Some(idx);
            }
            if idx == 0 {
                return None;
            }
            idx -= 1;
        }
    }

    /// True when output ends with comma or newline followed by optional spaces/tabs/cr.
    /// Works on bytes to avoid UTF-8 decoding overhead.
    pub(super) fn output_ends_with_comma_or_newline(&self) -> bool {
        let bytes = self.output.as_bytes();
        let mut i = bytes.len();
        while i > 0 {
            match bytes[i - 1] {
                b' ' | b'\t' | b'\r' => i -= 1,
                b',' | b'\n' => return true,
                _ => return false,
            }
        }
        false
    }
}
