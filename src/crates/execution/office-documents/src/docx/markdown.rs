//! Markdown → Word blocks (CommonMark plus GFM tables, strikethrough, and
//! task lists).

use super::model::{
    Block, CodeBlock, EmptyBlock, HeadingBlock, ImageBlock, ListBlock, ListItem, ParagraphBlock,
    QuoteBlock, TableBlock, TocBlock,
};
use crate::common::{Align, Extra, Run, TableCell};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Default, Clone)]
struct InlineState {
    bold: usize,
    italic: usize,
    strike: usize,
    link: Option<String>,
}

impl InlineState {
    fn run(&self, text: &str, code: bool) -> Run {
        Run {
            text: text.to_string(),
            bold: (self.bold > 0).then_some(true),
            italic: (self.italic > 0).then_some(true),
            strike: (self.strike > 0).then_some(true),
            code: code.then_some(true),
            link: self.link.clone(),
            ..Run::default()
        }
    }
}

/// Appends a run, merging it into the previous one when the formatting matches.
fn push_run(runs: &mut Vec<Run>, run: Run) {
    if run.text.is_empty() {
        return;
    }
    if let Some(last) = runs.last_mut() {
        let mut probe = last.clone();
        probe.text = run.text.clone();
        if probe == run {
            last.text.push_str(&run.text);
            return;
        }
    }
    runs.push(run);
}

enum Container {
    Paragraph,
    Heading(u8),
    Quote { runs: Vec<Run> },
    List(ListFrame),
    Table(TableFrame),
}

struct ListFrame {
    ordered: bool,
    start: Option<u32>,
    items: Vec<ListItem>,
    depth: u8,
}

#[derive(Default)]
struct TableFrame {
    alignments: Vec<Alignment>,
    rows: Vec<Vec<TableCell>>,
    current_row: Vec<TableCell>,
    in_cell: bool,
    head: bool,
}

/// Parses Markdown into blocks. Image references are returned as image
/// blocks whose `src` the caller resolves.
pub fn markdown_to_blocks(markdown: &str) -> Vec<Block> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(markdown, options);

    let mut blocks: Vec<Block> = Vec::new();
    let mut runs: Vec<Run> = Vec::new();
    let mut inline = InlineState::default();
    let mut stack: Vec<Container> = Vec::new();
    let mut code: Option<(String, Option<String>)> = None;
    let mut image: Option<(String, String)> = None;
    let mut list_depth: u8 = 0;

    // Where completed inline content lands depends on the innermost container.
    fn flush_paragraph(blocks: &mut Vec<Block>, stack: &mut [Container], runs: &mut Vec<Run>) {
        trim_runs(runs);
        if runs.is_empty() {
            return;
        }
        let taken = std::mem::take(runs);
        match stack
            .iter_mut()
            .rev()
            .find(|c| !matches!(c, Container::Paragraph))
        {
            Some(Container::Quote { runs: quote_runs }) => {
                if !quote_runs.is_empty() {
                    quote_runs.push(Run::plain("\n"));
                }
                quote_runs.extend(taken);
            }
            Some(Container::List(frame)) => {
                if let Some(item) = frame.items.last_mut() {
                    if !item.runs.is_empty() {
                        item.runs.push(Run::plain("\n"));
                    }
                    item.runs.extend(taken);
                }
            }
            _ => {
                if is_toc_marker(&taken) {
                    blocks.push(Block::Toc(TocBlock {
                        title: None,
                        levels: 3,
                        extra: Extra::default(),
                    }));
                } else {
                    blocks.push(Block::Paragraph(ParagraphBlock {
                        runs: taken,
                        ..ParagraphBlock::default()
                    }));
                }
            }
        }
    }

    for event in parser {
        if let Some((text, _)) = code.as_mut() {
            match event {
                Event::Text(value) => {
                    text.push_str(&value);
                    continue;
                }
                Event::End(TagEnd::CodeBlock) => {
                    let (text, language) = code.take().unwrap_or_default();
                    blocks.push(Block::Code(CodeBlock {
                        text: text.trim_end_matches('\n').to_string(),
                        language,
                        extra: Extra::default(),
                    }));
                    continue;
                }
                _ => continue,
            }
        }
        if let Some((_, alt)) = image.as_mut() {
            match event {
                Event::Text(value) | Event::Code(value) => {
                    alt.push_str(&value);
                    continue;
                }
                Event::End(TagEnd::Image) => {
                    let (src, alt) = image.take().unwrap_or_default();
                    // Pictures are blocks: close the text before and continue after.
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    blocks.push(Block::Image(ImageBlock {
                        src: Some(src),
                        asset: None,
                        width_cm: None,
                        height_cm: None,
                        align: Some(Align::Center),
                        caption: None,
                        alt: (!alt.trim().is_empty()).then(|| alt.trim().to_string()),
                        extra: Extra::default(),
                    }));
                    continue;
                }
                _ => continue,
            }
        }

        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => stack.push(Container::Paragraph),
                Tag::Heading { level, .. } => {
                    stack.push(Container::Heading(heading_level(level)));
                }
                Tag::BlockQuote(_) => stack.push(Container::Quote { runs: Vec::new() }),
                Tag::CodeBlock(kind) => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    let language = match kind {
                        CodeBlockKind::Fenced(info) => info
                            .split_whitespace()
                            .next()
                            .filter(|value| !value.is_empty())
                            .map(str::to_string),
                        CodeBlockKind::Indented => None,
                    };
                    code = Some((String::new(), language));
                }
                Tag::List(start) => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    let nested = stack.iter().any(|c| matches!(c, Container::List(_)));
                    if nested {
                        list_depth = list_depth.saturating_add(1);
                    } else {
                        list_depth = 0;
                        stack.push(Container::List(ListFrame {
                            ordered: start.is_some(),
                            start: start.map(|value| value as u32).filter(|value| *value != 1),
                            items: Vec::new(),
                            depth: 0,
                        }));
                    }
                }
                Tag::Item => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    if let Some(Container::List(frame)) = stack
                        .iter_mut()
                        .rev()
                        .find(|c| matches!(c, Container::List(_)))
                    {
                        frame.depth = list_depth;
                        frame.items.push(ListItem {
                            runs: Vec::new(),
                            level: list_depth.min(8),
                            extra: Extra::default(),
                        });
                    }
                }
                Tag::Table(alignments) => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    stack.push(Container::Table(TableFrame {
                        alignments,
                        ..TableFrame::default()
                    }));
                }
                Tag::TableHead => {
                    if let Some(Container::Table(frame)) = stack.last_mut() {
                        frame.head = true;
                    }
                }
                Tag::TableRow => {}
                Tag::TableCell => {
                    if let Some(Container::Table(frame)) = stack.last_mut() {
                        frame.in_cell = true;
                    }
                }
                Tag::Emphasis => inline.italic += 1,
                Tag::Strong => inline.bold += 1,
                Tag::Strikethrough => inline.strike += 1,
                Tag::Link { dest_url, .. } => {
                    let url = dest_url.to_string();
                    let lower = url.to_ascii_lowercase();
                    inline.link = (lower.starts_with("http://")
                        || lower.starts_with("https://")
                        || lower.starts_with("mailto:"))
                    .then_some(url);
                }
                Tag::Image { dest_url, .. } => {
                    image = Some((dest_url.to_string(), String::new()));
                }
                Tag::HtmlBlock | Tag::FootnoteDefinition(_) | Tag::MetadataBlock(_) => {}
            },
            Event::End(tag_end) => match tag_end {
                TagEnd::Paragraph => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    if matches!(stack.last(), Some(Container::Paragraph)) {
                        stack.pop();
                    }
                }
                TagEnd::Heading(_) => {
                    if let Some(Container::Heading(level)) = stack.pop() {
                        trim_runs(&mut runs);
                        let taken = std::mem::take(&mut runs);
                        if !taken.is_empty() {
                            blocks.push(Block::Heading(HeadingBlock {
                                level,
                                text: None,
                                runs: taken,
                                align: None,
                                extra: Extra::default(),
                            }));
                        }
                    }
                }
                TagEnd::BlockQuote => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    if let Some(Container::Quote { runs: quote_runs }) = stack.pop() {
                        if !quote_runs.is_empty() {
                            blocks.push(Block::Quote(QuoteBlock {
                                text: None,
                                runs: quote_runs,
                                extra: Extra::default(),
                            }));
                        }
                    }
                }
                TagEnd::List(_) => {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    if list_depth > 0 {
                        list_depth -= 1;
                    } else if let Some(Container::List(frame)) = stack.pop() {
                        let items: Vec<ListItem> = frame
                            .items
                            .into_iter()
                            .filter(|item| !item.runs.is_empty())
                            .collect();
                        if !items.is_empty() {
                            blocks.push(Block::List(ListBlock {
                                ordered: frame.ordered,
                                start: frame.start,
                                items,
                                extra: Extra::default(),
                            }));
                        }
                    }
                }
                TagEnd::Item => {
                    // Tight list items carry their text without a paragraph.
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                }
                TagEnd::TableCell => {
                    if let Some(Container::Table(frame)) = stack.last_mut() {
                        trim_runs(&mut runs);
                        let column = frame.current_row.len();
                        let align = match frame.alignments.get(column) {
                            Some(Alignment::Center) => Some(Align::Center),
                            Some(Alignment::Right) => Some(Align::Right),
                            Some(Alignment::Left) => Some(Align::Left),
                            _ => None,
                        };
                        frame.current_row.push(TableCell {
                            runs: std::mem::take(&mut runs),
                            align,
                            ..TableCell::default()
                        });
                        frame.in_cell = false;
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(Container::Table(frame)) = stack.last_mut() {
                        let row = std::mem::take(&mut frame.current_row);
                        if !row.is_empty() {
                            frame.rows.push(row);
                        }
                    }
                }
                TagEnd::Table => {
                    if let Some(Container::Table(frame)) = stack.pop() {
                        if !frame.rows.is_empty() {
                            blocks.push(Block::Table(TableBlock {
                                rows: frame.rows,
                                header_rows: u32::from(frame.head),
                                column_widths_cm: None,
                                borders: true,
                                font_size_pt: None,
                                caption: None,
                                extra: Extra::default(),
                            }));
                        }
                    }
                }
                TagEnd::Emphasis => inline.italic = inline.italic.saturating_sub(1),
                TagEnd::Strong => inline.bold = inline.bold.saturating_sub(1),
                TagEnd::Strikethrough => inline.strike = inline.strike.saturating_sub(1),
                TagEnd::Link => inline.link = None,
                _ => {}
            },
            Event::Text(text) => push_run(&mut runs, inline.run(&text, false)),
            Event::Code(text) => push_run(&mut runs, inline.run(&text, true)),
            Event::InlineMath(text) | Event::DisplayMath(text) => {
                push_run(&mut runs, inline.run(&text, false))
            }
            Event::SoftBreak => push_run(&mut runs, inline.run(" ", false)),
            Event::HardBreak => push_run(&mut runs, inline.run("\n", false)),
            Event::Rule => {
                flush_paragraph(&mut blocks, &mut stack, &mut runs);
                blocks.push(Block::HorizontalRule(EmptyBlock::default()));
            }
            Event::TaskListMarker(checked) => {
                push_run(&mut runs, Run::plain(if checked { "☑ " } else { "☐ " }));
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let lower = html.to_ascii_lowercase();
                if lower.contains("pagebreak") || lower.contains("page-break") {
                    flush_paragraph(&mut blocks, &mut stack, &mut runs);
                    blocks.push(Block::PageBreak(EmptyBlock::default()));
                } else if lower.trim_start().starts_with("<br") {
                    push_run(&mut runs, inline.run("\n", false));
                }
            }
            Event::FootnoteReference(_) => {}
        }
    }
    flush_paragraph(&mut blocks, &mut stack, &mut runs);
    blocks
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn trim_runs(runs: &mut Vec<Run>) {
    while runs
        .last()
        .is_some_and(|run| run.text.trim().is_empty() && run.text != "\n")
    {
        runs.pop();
    }
    while runs.first().is_some_and(|run| run.text.trim().is_empty()) {
        runs.remove(0);
    }
    if let Some(first) = runs.first_mut() {
        first.text = first.text.trim_start().to_string();
    }
    if let Some(last) = runs.last_mut() {
        last.text = last.text.trim_end().to_string();
    }
    runs.retain(|run| !run.text.is_empty());
}

fn is_toc_marker(runs: &[Run]) -> bool {
    let text: String = runs.iter().map(|run| run.text.as_str()).collect();
    matches!(
        text.trim().to_ascii_lowercase().as_str(),
        "[toc]" | "[[toc]]"
    )
}

/// Image sources referenced by Markdown, in document order.
pub fn markdown_image_sources(markdown: &str) -> Vec<String> {
    markdown_to_blocks(markdown)
        .into_iter()
        .filter_map(|block| match block {
            Block::Image(image) => image.src,
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::runs_text;

    #[test]
    fn converts_common_structures() {
        let blocks = markdown_to_blocks(
            "# Title\n\nSome **bold** and *it* with [link](https://a.b).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n\n> quoted\n\n---\n\n![chart](./c.png)\n\n[TOC]\n",
        );
        let kinds: Vec<&str> = blocks.iter().map(Block::kind).collect();
        assert_eq!(
            kinds,
            vec![
                "heading",
                "paragraph",
                "list",
                "list",
                "table",
                "code",
                "quote",
                "horizontal_rule",
                "image",
                "toc"
            ]
        );
        let Block::Paragraph(paragraph) = &blocks[1] else {
            panic!()
        };
        assert!(paragraph
            .runs
            .iter()
            .any(|run| run.bold == Some(true) && run.text == "bold"));
        assert!(paragraph
            .runs
            .iter()
            .any(|run| run.link.as_deref() == Some("https://a.b")));
        let Block::List(list) = &blocks[2] else {
            panic!()
        };
        assert_eq!(list.items.len(), 3);
        assert_eq!(list.items[2].level, 1);
        assert_eq!(runs_text(&list.items[2].runs), "nested");
        let Block::List(ordered) = &blocks[3] else {
            panic!()
        };
        assert!(ordered.ordered);
        let Block::Table(table) = &blocks[4] else {
            panic!()
        };
        assert_eq!(table.header_rows, 1);
        assert_eq!(table.rows[1][1].align, Some(Align::Right));
        assert_eq!(
            markdown_image_sources("![x](a.png) text ![y](b.jpg)"),
            vec!["a.png", "b.jpg"]
        );
    }

    #[test]
    fn splits_paragraph_around_inline_image() {
        let blocks = markdown_to_blocks("before ![pic](p.png) after");
        let kinds: Vec<&str> = blocks.iter().map(Block::kind).collect();
        assert_eq!(kinds, vec!["paragraph", "image", "paragraph"]);
    }
}
