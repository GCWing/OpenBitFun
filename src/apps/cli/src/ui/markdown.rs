/// Markdown rendering utilities
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use pulldown_cmark::{Alignment, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::theme::{StyleKind, Theme};

/// Markdown renderer with built-in cache for parsed results.
/// Avoids re-parsing the same markdown content on every frame.
pub(super) struct MarkdownRenderer {
    /// Theme
    theme: Theme,
    /// Cache: hash(content + width) -> rendered lines
    cache: HashMap<u64, Vec<Line<'static>>>,
}

impl MarkdownRenderer {
    pub(super) fn new(theme: Theme) -> Self {
        Self {
            theme,
            cache: HashMap::new(),
        }
    }

    /// Compute a cache key from content and width
    fn cache_key(content: &str, width: usize) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        content.hash(&mut hasher);
        width.hash(&mut hasher);
        hasher.finish()
    }

    /// Render markdown with caching. Returns cached result if content+width match.
    pub(super) fn render_cached(&mut self, content: &str, width: usize) -> Vec<Line<'static>> {
        let key = Self::cache_key(content, width);
        if let Some(cached) = self.cache.get(&key) {
            return cached.clone();
        }
        let lines = self.render(content, width);
        self.cache.insert(key, lines.clone());
        lines
    }

    /// Clear the markdown render cache (e.g. on session switch)
    pub(super) fn clear_cache(&mut self) {
        self.cache.clear();
    }

    pub(super) fn render(&self, markdown: &str, width: usize) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        let mut current_line_spans: Vec<Span<'static>> = Vec::new();

        // Style stack
        let mut style_stack: Vec<StyleModifier> = Vec::new();
        let mut list_level: usize = 0;
        let mut in_code_block = false;
        let mut code_block_lang = String::new();
        let mut image_context: Option<(String, String)> = None;
        let wrap_width = if width > 0 { width } else { 80 };

        // Table state
        let mut table_state = TableState::new();

        // Flush current_line_spans into `lines`, wrapping at `wrap_width`.
        // Headings skip wrapping.
        let flush_with_wrap = |spans: &mut Vec<Span<'static>>,
                               lines: &mut Vec<Line<'static>>,
                               max_w: usize,
                               do_wrap: bool| {
            if spans.is_empty() {
                return;
            }
            let collected = std::mem::take(spans);
            if !do_wrap {
                lines.push(Line::from(collected));
                return;
            }
            wrap_spans_to_lines(collected, max_w, lines);
        };

        let options = Options::all();
        let parser = Parser::new_ext(markdown, options);

        for event in parser {
            match event {
                Event::Start(tag) => match tag {
                    Tag::Heading { level, .. } => {
                        flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        lines.push(Line::from(""));

                        let prefix = match level {
                            HeadingLevel::H1 => "# ",
                            HeadingLevel::H2 => "## ",
                            HeadingLevel::H3 => "### ",
                            HeadingLevel::H4 => "#### ",
                            HeadingLevel::H5 => "##### ",
                            HeadingLevel::H6 => "###### ",
                        };
                        current_line_spans.push(Span::styled(
                            prefix.to_string(),
                            self.theme
                                .style(StyleKind::Primary)
                                .add_modifier(Modifier::BOLD),
                        ));

                        style_stack.push(StyleModifier::Heading);
                    }
                    Tag::Paragraph => {}
                    Tag::BlockQuote(_) => {
                        current_line_spans.push(Span::styled(
                            "\u{2502} ".to_string(),
                            self.theme.style(StyleKind::Muted),
                        ));
                        style_stack.push(StyleModifier::Quote);
                    }
                    Tag::CodeBlock(kind) => {
                        in_code_block = true;
                        if let pulldown_cmark::CodeBlockKind::Fenced(lang) = kind {
                            code_block_lang = lang.to_string();
                        }
                        flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        lines.push(Line::from(""));

                        if !code_block_lang.is_empty() {
                            current_line_spans.push(Span::styled(
                                format!("```{}", code_block_lang),
                                self.theme.style(StyleKind::Muted),
                            ));
                            lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                        }
                    }
                    Tag::List(_) => {
                        list_level += 1;
                        if list_level == 1 {
                            flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        }
                    }
                    Tag::Item => {
                        flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        let indent = "  ".repeat(list_level.saturating_sub(1));
                        current_line_spans.push(Span::raw(indent));
                        current_line_spans.push(Span::styled(
                            "\u{2022} ".to_string(),
                            self.theme.style(StyleKind::Primary),
                        ));
                    }
                    Tag::Strong => {
                        style_stack.push(StyleModifier::Bold);
                    }
                    Tag::Emphasis => {
                        style_stack.push(StyleModifier::Italic);
                    }
                    Tag::Link { .. } => {
                        style_stack.push(StyleModifier::Link);
                    }
                    Tag::Image { dest_url, .. } => {
                        image_context = Some((String::new(), dest_url.to_string()));
                    }
                    Tag::Table(alignment) => {
                        flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        lines.push(Line::from(""));
                        table_state.start_table(alignment.into_iter().collect());
                    }
                    Tag::TableHead => {
                        table_state.is_header = true;
                        table_state.start_row();
                    }
                    Tag::TableRow => {
                        table_state.start_row();
                    }
                    Tag::TableCell => {
                        table_state.start_cell();
                        if table_state.is_header {
                            style_stack.push(StyleModifier::TableHeader);
                        }
                    }
                    _ => {}
                },

                Event::End(tag_end) => {
                    match tag_end {
                        TagEnd::Heading(_) => {
                            if let Some(StyleModifier::Heading) = style_stack.last() {
                                style_stack.pop();
                            }
                            // Headings: don't wrap, just push as-is
                            lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                        }
                        TagEnd::Paragraph => {
                            if !in_code_block && !table_state.in_table {
                                flush_with_wrap(
                                    &mut current_line_spans,
                                    &mut lines,
                                    wrap_width,
                                    true,
                                );
                                lines.push(Line::from(""));
                            }
                        }
                        TagEnd::BlockQuote => {
                            if let Some(StyleModifier::Quote) = style_stack.last() {
                                style_stack.pop();
                            }
                            flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        }
                        TagEnd::CodeBlock => {
                            in_code_block = false;
                            if !current_line_spans.is_empty() {
                                lines.push(Line::from(std::mem::take(&mut current_line_spans)));
                            }
                            if !code_block_lang.is_empty() {
                                lines.push(Line::from(Span::styled(
                                    "```".to_string(),
                                    self.theme.style(StyleKind::Muted),
                                )));
                                code_block_lang.clear();
                            }
                            lines.push(Line::from(""));
                        }
                        TagEnd::List(_) => {
                            list_level = list_level.saturating_sub(1);
                            if list_level == 0 {
                                flush_with_wrap(
                                    &mut current_line_spans,
                                    &mut lines,
                                    wrap_width,
                                    true,
                                );
                                lines.push(Line::from(""));
                            }
                        }
                        TagEnd::Item => {
                            flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                        }
                        TagEnd::Strong => {
                            if let Some(StyleModifier::Bold) = style_stack.last() {
                                style_stack.pop();
                            }
                        }
                        TagEnd::Emphasis => {
                            if let Some(StyleModifier::Italic) = style_stack.last() {
                                style_stack.pop();
                            }
                        }
                        TagEnd::Link => {
                            if let Some(StyleModifier::Link) = style_stack.last() {
                                style_stack.pop();
                            }
                        }
                        TagEnd::Table => {
                            let table_lines = table_state.end_table(wrap_width);
                            lines.extend(table_lines);
                            lines.push(Line::from(""));
                        }
                        TagEnd::TableHead => {
                            table_state.end_row();
                        }
                        TagEnd::TableRow => {
                            table_state.end_row();
                        }
                        TagEnd::TableCell => {
                            table_state.end_cell();
                            if table_state.is_header {
                                if let Some(StyleModifier::TableHeader) = style_stack.last() {
                                    style_stack.pop();
                                }
                            }
                        }
                        TagEnd::Image => {
                            if let Some((alt, destination)) = image_context.take() {
                                let label = if alt.is_empty() { "Image" } else { &alt };
                                let span = Span::styled(
                                    format!("[{label}]({destination})"),
                                    self.theme
                                        .style(StyleKind::Info)
                                        .add_modifier(Modifier::UNDERLINED),
                                );
                                if table_state.in_cell {
                                    table_state.push_span(span);
                                } else {
                                    current_line_spans.push(span);
                                }
                            }
                        }
                        _ => {}
                    }
                }

                Event::Text(text) => {
                    let style = self.compute_style(&style_stack, in_code_block);

                    if let Some((alt, _)) = image_context.as_mut() {
                        alt.push_str(&text);
                    } else if in_code_block {
                        for line in text.lines() {
                            // Code blocks preserve style but still wrap to viewport width.
                            wrap_spans_to_lines(
                                vec![Span::styled(format!("  {}", line), style)],
                                wrap_width,
                                &mut lines,
                            );
                        }
                    } else if table_state.in_cell {
                        // Inside table cell: accumulate text into the cell
                        table_state.push_span(Span::styled(text.to_string(), style));
                    } else {
                        current_line_spans.push(Span::styled(text.to_string(), style));
                    }
                }

                Event::Code(code) => {
                    if let Some((alt, _)) = image_context.as_mut() {
                        alt.push_str(&code);
                        continue;
                    }
                    let span =
                        Span::styled(format!("`{}`", code), self.theme.style(StyleKind::Success));
                    if table_state.in_cell {
                        table_state.push_span(span);
                    } else {
                        current_line_spans.push(span);
                    }
                }

                Event::SoftBreak | Event::HardBreak => {
                    if let Some((alt, _)) = image_context.as_mut() {
                        alt.push(' ');
                    } else if !in_code_block && !table_state.in_table {
                        flush_with_wrap(&mut current_line_spans, &mut lines, wrap_width, true);
                    }
                }

                Event::Rule => {
                    let rule_w = wrap_width.min(60);
                    lines.push(Line::from(Span::styled(
                        "\u{2500}".repeat(rule_w),
                        self.theme.style(StyleKind::Muted),
                    )));
                }

                _ => {}
            }
        }

        // Process remaining spans with wrapping
        if !current_line_spans.is_empty() {
            wrap_spans_to_lines(current_line_spans, wrap_width, &mut lines);
        }

        // Remove trailing empty lines
        while lines.last().is_some_and(|line| {
            line.spans.is_empty() || (line.spans.len() == 1 && line.spans[0].content.is_empty())
        }) {
            lines.pop();
        }

        lines
    }

    fn compute_style(&self, stack: &[StyleModifier], in_code_block: bool) -> Style {
        let mut style = Style::default();

        if in_code_block {
            return self.theme.style(StyleKind::Success);
        }

        for modifier in stack {
            style = match modifier {
                StyleModifier::Bold => style.add_modifier(Modifier::BOLD),
                StyleModifier::Italic => style.add_modifier(Modifier::ITALIC),
                StyleModifier::Heading => self
                    .theme
                    .style(StyleKind::Primary)
                    .add_modifier(Modifier::BOLD),
                StyleModifier::Quote => style.fg(self.theme.muted),
                StyleModifier::Link => self
                    .theme
                    .style(StyleKind::Info)
                    .add_modifier(Modifier::UNDERLINED),
                StyleModifier::TableHeader => self
                    .theme
                    .style(StyleKind::Primary)
                    .add_modifier(Modifier::BOLD),
            };
        }

        style
    }

    pub(super) fn has_markdown_syntax(text: &str) -> bool {
        text.contains("**")
            || text.contains("__")
            || text.contains("*")
            || text.contains("_")
            || text.contains("`")
            || text.contains("#")
            || text.contains("[")
            || text.contains(">")
            || text.contains("```")
    }
}

#[cfg(test)]
mod tests {
    use super::{MarkdownRenderer, Theme};

    #[test]
    fn renders_images_as_plain_links_in_the_terminal() {
        let renderer = MarkdownRenderer::new(Theme::dark_ansi16());
        let lines = renderer.render("![diagram](images/diagram.png)", 80);
        let rendered = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert_eq!(rendered, "[diagram](images/diagram.png)");
    }
}

/// Wrap a list of styled spans into multiple Lines, breaking at `max_width`
/// display columns. Preserves the style of each span across line breaks.
/// Breaks prefer word boundaries (spaces) when possible.
fn wrap_spans_to_lines(spans: Vec<Span<'static>>, max_width: usize, out: &mut Vec<Line<'static>>) {
    if max_width == 0 {
        out.push(Line::from(spans));
        return;
    }

    let total_width: usize = spans
        .iter()
        .map(|s| UnicodeWidthStr::width(s.content.as_ref()))
        .sum();
    if total_width <= max_width {
        out.push(Line::from(spans));
        return;
    }

    let mut current_spans: Vec<Span<'static>> = Vec::new();
    let mut current_width: usize = 0;

    for span in spans {
        let span_text: &str = span.content.as_ref();
        let span_w = UnicodeWidthStr::width(span_text);

        if current_width + span_w <= max_width {
            current_spans.push(span);
            current_width += span_w;
            continue;
        }

        // Need to split this span across lines
        let style = span.style;
        let mut remaining = span_text.to_string();

        while !remaining.is_empty() {
            let avail = max_width.saturating_sub(current_width);

            if avail == 0 {
                out.push(Line::from(std::mem::take(&mut current_spans)));
                current_width = 0;
                continue;
            }

            let rem_w = UnicodeWidthStr::width(remaining.as_str());
            if rem_w <= avail {
                current_width += rem_w;
                current_spans.push(Span::styled(remaining, style));
                break;
            }

            // Find a split point: prefer space near the boundary
            let (split, take_w) = find_wrap_point(&remaining, avail);

            if split > 0 {
                let piece: String = remaining[..split].to_string();
                remaining = remaining[split..].to_string();
                // Trim leading space on the continuation line
                if remaining.starts_with(' ') {
                    remaining = remaining[1..].to_string();
                }
                current_spans.push(Span::styled(piece, style));
                let _ = take_w; // width is reset after flush below
            } else {
                // Can't fit even one char - flush current line first
                if !current_spans.is_empty() {
                    out.push(Line::from(std::mem::take(&mut current_spans)));
                    current_width = 0;
                    continue;
                }
                // Force at least one char to avoid infinite loop
                let mut byte_end = 0;
                let mut w = 0;
                for ch in remaining.chars() {
                    let ch_w = UnicodeWidthChar::width(ch).unwrap_or(0);
                    if w + ch_w > avail && w > 0 {
                        break;
                    }
                    byte_end += ch.len_utf8();
                    w += ch_w;
                }
                if byte_end == 0 {
                    let ch = remaining.chars().next().unwrap();
                    byte_end = ch.len_utf8();
                }
                let piece = remaining[..byte_end].to_string();
                remaining = remaining[byte_end..].to_string();
                current_spans.push(Span::styled(piece, style));
            }

            // Line is full, push it
            out.push(Line::from(std::mem::take(&mut current_spans)));
            current_width = 0;
        }
    }

    if !current_spans.is_empty() {
        out.push(Line::from(current_spans));
    }
}

/// Find a good byte offset to split `text` at, fitting within `avail` display columns.
/// Prefers splitting at the last space boundary. Returns (byte_offset, display_width_consumed).
fn find_wrap_point(text: &str, avail: usize) -> (usize, usize) {
    let mut byte_pos = 0;
    let mut width = 0;
    let mut last_space_byte = 0;
    let mut last_space_width = 0;

    for ch in text.chars() {
        let ch_w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if width + ch_w > avail {
            break;
        }
        byte_pos += ch.len_utf8();
        width += ch_w;

        if ch == ' ' {
            last_space_byte = byte_pos;
            last_space_width = width;
        }
    }

    // Prefer breaking at word boundary if we found a space in the first 60% of the line
    if last_space_byte > 0 && last_space_width > avail / 3 {
        (last_space_byte, last_space_width)
    } else {
        (byte_pos, width)
    }
}

/// Style modifier
#[derive(Debug, Clone, Copy)]
enum StyleModifier {
    Bold,
    Italic,
    Heading,
    Quote,
    Link,
    TableHeader,
}

/// Table rendering state
#[derive(Debug, Clone)]
struct TableState {
    /// Column alignments
    alignments: Vec<Alignment>,
    /// Current row's cells (each cell is a list of spans)
    current_row: Vec<Vec<Span<'static>>>,
    /// All rows in the table (including header)
    rows: Vec<Vec<Vec<Span<'static>>>>,
    /// Whether current row is header
    is_header: bool,
    /// Whether we're inside a table
    in_table: bool,
    /// Whether we're inside a table cell
    in_cell: bool,
}

impl TableState {
    fn new() -> Self {
        Self {
            alignments: Vec::new(),
            current_row: Vec::new(),
            rows: Vec::new(),
            is_header: false,
            in_table: false,
            in_cell: false,
        }
    }

    fn start_table(&mut self, alignments: Vec<Alignment>) {
        self.alignments = alignments;
        self.current_row = Vec::new();
        self.rows = Vec::new();
        self.is_header = false;
        self.in_table = true;
    }

    fn start_row(&mut self) {
        self.current_row = Vec::new();
    }

    fn end_row(&mut self) {
        if !self.current_row.is_empty() {
            self.rows.push(std::mem::take(&mut self.current_row));
        }
        self.is_header = false;
    }

    fn start_cell(&mut self) {
        self.current_row.push(Vec::new());
        self.in_cell = true;
    }

    fn end_cell(&mut self) {
        self.in_cell = false;
    }

    fn push_span(&mut self, span: Span<'static>) {
        if self.in_cell {
            if let Some(cell) = self.current_row.last_mut() {
                cell.push(span);
            }
        }
    }

    fn end_table(&mut self, max_total_width: usize) -> Vec<Line<'static>> {
        self.in_table = false;
        self.render_table(max_total_width.max(1))
    }

    /// Calculate column widths based on content and fit them in the available width.
    fn calculate_column_widths(&self, max_total_width: usize) -> Vec<usize> {
        if self.rows.is_empty() {
            return Vec::new();
        }

        let detected_cols = self.rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let num_cols = self.alignments.len().max(detected_cols);
        if num_cols == 0 {
            return Vec::new();
        }

        // Keep each column visible even in very narrow terminals.
        let mut widths = vec![1usize; num_cols];
        for row in &self.rows {
            for (i, cell) in row.iter().enumerate().take(num_cols) {
                let cell_width: usize = cell
                    .iter()
                    .map(|s| UnicodeWidthStr::width(s.content.as_ref()))
                    .sum();
                widths[i] = widths[i].max(cell_width.max(1));
            }
        }

        // Total width for "│ {cell} │" repeated across columns:
        // sum(column_widths) + (3 * num_cols + 1)
        let border_and_padding = 3usize.saturating_mul(num_cols).saturating_add(1);
        let target_content_width = max_total_width
            .saturating_sub(border_and_padding)
            .max(num_cols);
        let mut current_content_width: usize = widths.iter().sum();

        while current_content_width > target_content_width {
            let widest = widths
                .iter()
                .enumerate()
                .filter(|(_, w)| **w > 1)
                .max_by_key(|(_, w)| **w)
                .map(|(idx, _)| idx);
            let Some(idx) = widest else {
                break;
            };
            widths[idx] -= 1;
            current_content_width -= 1;
        }

        widths
    }

    /// Render the table to lines with wrapped cells.
    fn render_table(&self, max_total_width: usize) -> Vec<Line<'static>> {
        let mut lines = Vec::new();

        if self.rows.is_empty() {
            return lines;
        }

        let widths = self.calculate_column_widths(max_total_width);
        let num_cols = widths.len();
        if num_cols == 0 {
            return lines;
        }

        let border_style = Style::default().fg(ratatui::style::Color::DarkGray);
        let build_border = |left: char, mid: char, right: char| -> Line<'static> {
            let mut border = String::new();
            border.push(left);
            for (idx, width) in widths.iter().enumerate() {
                border.push_str(&"\u{2500}".repeat(width.saturating_add(2)));
                if idx + 1 < num_cols {
                    border.push(mid);
                }
            }
            border.push(right);
            Line::from(Span::styled(border, border_style))
        };

        lines.push(build_border('\u{250C}', '\u{252C}', '\u{2510}'));

        for (row_idx, row) in self.rows.iter().enumerate() {
            let mut wrapped_cells: Vec<Vec<Vec<Span<'static>>>> = Vec::with_capacity(num_cols);
            let mut row_height = 1usize;

            for (col_idx, col_width) in widths.iter().copied().enumerate().take(num_cols) {
                let cell = row.get(col_idx).cloned().unwrap_or_default();
                let mut wrapped_lines: Vec<Line<'static>> = Vec::new();
                if cell.is_empty() {
                    wrapped_lines.push(Line::from(Vec::<Span<'static>>::new()));
                } else {
                    wrap_spans_to_lines(cell, col_width.max(1), &mut wrapped_lines);
                    if wrapped_lines.is_empty() {
                        wrapped_lines.push(Line::from(Vec::<Span<'static>>::new()));
                    }
                }
                let wrapped_spans: Vec<Vec<Span<'static>>> =
                    wrapped_lines.into_iter().map(|line| line.spans).collect();
                row_height = row_height.max(wrapped_spans.len());
                wrapped_cells.push(wrapped_spans);
            }

            for visual_row in 0..row_height {
                let mut line_spans = Vec::new();
                line_spans.push(Span::styled("\u{2502}".to_string(), border_style));

                for col_idx in 0..num_cols {
                    let col_width = widths[col_idx];
                    let alignment = self
                        .alignments
                        .get(col_idx)
                        .copied()
                        .unwrap_or(Alignment::None);
                    let content_spans = wrapped_cells[col_idx]
                        .get(visual_row)
                        .cloned()
                        .unwrap_or_default();
                    let content_width: usize = content_spans
                        .iter()
                        .map(|s| UnicodeWidthStr::width(s.content.as_ref()))
                        .sum();
                    let padding = col_width.saturating_sub(content_width);
                    let (left_pad, right_pad) = match alignment {
                        Alignment::Left => (0, padding),
                        Alignment::Center => (padding / 2, padding - padding / 2),
                        Alignment::Right => (padding, 0),
                        Alignment::None => (0, padding),
                    };

                    line_spans.push(Span::raw(" ".to_string()));
                    if left_pad > 0 {
                        line_spans.push(Span::raw(" ".repeat(left_pad)));
                    }
                    line_spans.extend(content_spans);
                    if right_pad > 0 {
                        line_spans.push(Span::raw(" ".repeat(right_pad)));
                    }
                    line_spans.push(Span::raw(" ".to_string()));
                    line_spans.push(Span::styled("\u{2502}".to_string(), border_style));
                }

                lines.push(Line::from(line_spans));
            }

            if row_idx == 0 {
                lines.push(build_border('\u{251C}', '\u{253C}', '\u{2524}'));
            }
        }

        lines.push(build_border('\u{2514}', '\u{2534}', '\u{2518}'));
        lines
    }
}
