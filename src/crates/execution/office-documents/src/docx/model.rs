//! Word document model: page setup, styles, and an ordered list of blocks.

use crate::common::{
    canonical_runs, parse_color, prefix, report_extra, report_list, runs_text, validate_runs,
    Align, DocumentProperties, Extra, Run, TableCell, UnknownFields,
};
use crate::error::{OfficeError, OfficeResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DocxDocument {
    #[serde(default)]
    pub properties: DocumentProperties,
    #[serde(default)]
    pub page: PageSetup,
    #[serde(default)]
    pub styles: DocxStyles,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<HeaderFooter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<HeaderFooter>,
    #[serde(default)]
    pub blocks: Vec<Block>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperSize {
    #[default]
    #[serde(alias = "A4")]
    A4,
    #[serde(alias = "Letter")]
    Letter,
    #[serde(alias = "Legal")]
    Legal,
    #[serde(alias = "A3")]
    A3,
    #[serde(alias = "A5")]
    A5,
}

impl PaperSize {
    /// Portrait width and height in twentieths of a point.
    pub const fn twips(self) -> (u32, u32) {
        match self {
            Self::A4 => (11906, 16838),
            Self::Letter => (12240, 15840),
            Self::Legal => (12240, 20160),
            Self::A3 => (16838, 23811),
            Self::A5 => (8391, 11906),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    #[default]
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Margins {
    #[serde(default = "default_margin")]
    pub top: f64,
    #[serde(default = "default_margin")]
    pub bottom: f64,
    #[serde(default = "default_margin")]
    pub left: f64,
    #[serde(default = "default_margin")]
    pub right: f64,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_margin() -> f64 {
    2.54
}

impl Default for Margins {
    fn default() -> Self {
        Self {
            top: default_margin(),
            bottom: default_margin(),
            left: default_margin(),
            right: default_margin(),
            extra: Extra::default(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PageSetup {
    #[serde(default)]
    pub size: PaperSize,
    #[serde(default)]
    pub orientation: Orientation,
    /// Margins in centimeters.
    #[serde(default, alias = "margins")]
    pub margins_cm: Margins,
    #[serde(flatten)]
    pub extra: Extra,
}

impl PageSetup {
    /// Page width and height in twips after orientation.
    pub fn page_twips(&self) -> (u32, u32) {
        let (width, height) = self.size.twips();
        match self.orientation {
            Orientation::Portrait => (width, height),
            Orientation::Landscape => (height, width),
        }
    }

    /// Width available to text, in twips.
    pub fn text_width_twips(&self) -> u32 {
        let (width, _) = self.page_twips();
        let margins = cm_to_twips(self.margins_cm.left) + cm_to_twips(self.margins_cm.right);
        width.saturating_sub(margins).max(1440)
    }

    pub fn validate(&self) -> OfficeResult<()> {
        let m = &self.margins_cm;
        for (name, value) in [
            ("top", m.top),
            ("bottom", m.bottom),
            ("left", m.left),
            ("right", m.right),
        ] {
            if !(0.0..=10.0).contains(&value) {
                return Err(OfficeError::invalid(format!(
                    "page.margins_cm.{name} must be between 0 and 10 cm, got {value}"
                )));
            }
        }
        Ok(())
    }
}

pub(crate) fn cm_to_twips(cm: f64) -> u32 {
    (cm * 1440.0 / 2.54).round().max(0.0) as u32
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocxStyles {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Legacy Latin and complex-script body font. East Asian text is separate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// Font for CJK text, such as "Microsoft YaHei" or "SimSun".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_script_font: Option<String>,
    #[serde(default = "default_body_size", alias = "size_pt")]
    pub font_size_pt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heading_font: Option<String>,
    #[serde(default = "default_heading_color")]
    pub heading_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    /// Line spacing as a multiple of single spacing.
    #[serde(default = "default_line_spacing")]
    pub line_spacing: f64,
    #[serde(default = "default_space_after")]
    pub paragraph_space_after_pt: f64,
    /// Fill of table header rows.
    #[serde(default = "default_table_header_fill")]
    pub table_header_fill: String,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_body_size() -> f64 {
    11.0
}
fn default_heading_color() -> String {
    "#1F3864".to_string()
}
fn default_line_spacing() -> f64 {
    1.15
}
fn default_space_after() -> f64 {
    8.0
}
fn default_table_header_fill() -> String {
    "#D9E2F3".to_string()
}

impl Default for DocxStyles {
    fn default() -> Self {
        Self {
            lang: None,
            font: None,
            east_asia_font: None,
            complex_script_font: None,
            font_size_pt: default_body_size(),
            heading_font: None,
            heading_color: default_heading_color(),
            text_color: None,
            line_spacing: default_line_spacing(),
            paragraph_space_after_pt: default_space_after(),
            table_header_fill: default_table_header_fill(),
            extra: Extra::default(),
        }
    }
}

impl DocxStyles {
    pub fn validate(&self) -> OfficeResult<()> {
        if let Some(lang) = &self.lang {
            crate::common::validate_language(lang)?;
        }
        if !(6.0..=72.0).contains(&self.font_size_pt) {
            return Err(OfficeError::invalid(format!(
                "styles.font_size_pt must be between 6 and 72, got {}",
                self.font_size_pt
            )));
        }
        if !(0.8..=3.0).contains(&self.line_spacing) {
            return Err(OfficeError::invalid(format!(
                "styles.line_spacing must be between 0.8 and 3.0, got {}",
                self.line_spacing
            )));
        }
        if !(0.0..=72.0).contains(&self.paragraph_space_after_pt) {
            return Err(OfficeError::invalid(
                "styles.paragraph_space_after_pt must be between 0 and 72",
            ));
        }
        parse_color(&self.heading_color).map_err(|err| prefix(err, "styles", "heading_color"))?;
        parse_color(&self.table_header_fill)
            .map_err(|err| prefix(err, "styles", "table_header_fill"))?;
        if let Some(color) = &self.text_color {
            parse_color(color).map_err(|err| prefix(err, "styles", "text_color"))?;
        }
        Ok(())
    }
}

/// Header or footer text. `{PAGE}` and `{NUMPAGES}` become page fields.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeaderFooter {
    pub text: String,
    #[serde(default = "default_hf_align")]
    pub align: Align,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_hf_align() -> Align {
    Align::Center
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Heading(HeadingBlock),
    Paragraph(ParagraphBlock),
    List(ListBlock),
    Table(TableBlock),
    Image(ImageBlock),
    #[serde(alias = "code_block")]
    Code(CodeBlock),
    #[serde(alias = "blockquote")]
    Quote(QuoteBlock),
    PageBreak(EmptyBlock),
    #[serde(alias = "rule", alias = "divider")]
    HorizontalRule(EmptyBlock),
    #[serde(alias = "table_of_contents")]
    Toc(TocBlock),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingBlock {
    pub level: u8,
    #[serde(default, skip_serializing)]
    pub text: Option<String>,
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParagraphStyle {
    Normal,
    Title,
    Subtitle,
    Caption,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParagraphBlock {
    #[serde(default, skip_serializing)]
    pub text: Option<String>,
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<ParagraphStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent_cm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_line_indent_cm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_before_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_after_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_spacing: Option<f64>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListBlock {
    #[serde(default)]
    pub ordered: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
    pub items: Vec<ListItem>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "ListItemInput")]
pub struct ListItem {
    #[serde(default)]
    pub runs: Vec<Run>,
    /// Nesting level, 0 for top-level items.
    #[serde(default)]
    pub level: u8,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ListItemInput {
    Text(String),
    Full(ListItemFull),
}

#[derive(Deserialize)]
struct ListItemFull {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    runs: Vec<Run>,
    #[serde(default)]
    level: u8,
    #[serde(flatten)]
    extra: Extra,
}

impl From<ListItemInput> for ListItem {
    fn from(input: ListItemInput) -> Self {
        match input {
            ListItemInput::Text(text) => ListItem {
                runs: vec![Run::plain(text)],
                level: 0,
                extra: Extra::default(),
            },
            ListItemInput::Full(mut full) => {
                canonical_runs(&mut full.text, &mut full.runs);
                ListItem {
                    runs: full.runs,
                    level: full.level,
                    extra: full.extra,
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableBlock {
    pub rows: Vec<Vec<TableCell>>,
    /// Leading rows styled as headers and repeated on every page.
    #[serde(default = "default_header_rows")]
    pub header_rows: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_widths_cm: Option<Vec<f64>>,
    #[serde(default = "default_true")]
    pub borders: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_header_rows() -> u32 {
    1
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageBlock {
    /// Source path or data URL given by the caller; informational once the
    /// picture is embedded.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "url",
        alias = "path"
    )]
    pub src: Option<String>,
    /// Name of the embedded picture. Echo it back to keep the same picture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_cm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_cm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "alt_text")]
    pub alt: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeBlock {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuoteBlock {
    #[serde(default, skip_serializing)]
    pub text: Option<String>,
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EmptyBlock {
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TocBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Deepest heading level listed.
    #[serde(default = "default_toc_levels")]
    pub levels: u8,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_toc_levels() -> u8 {
    3
}

impl Block {
    pub fn kind(&self) -> &'static str {
        match self {
            Block::Heading(_) => "heading",
            Block::Paragraph(_) => "paragraph",
            Block::List(_) => "list",
            Block::Table(_) => "table",
            Block::Image(_) => "image",
            Block::Code(_) => "code",
            Block::Quote(_) => "quote",
            Block::PageBreak(_) => "page_break",
            Block::HorizontalRule(_) => "horizontal_rule",
            Block::Toc(_) => "toc",
        }
    }

    /// Moves `text` shorthands into `runs` so stored blocks have one shape.
    pub fn canonicalize(&mut self) {
        match self {
            Block::Heading(block) => canonical_runs(&mut block.text, &mut block.runs),
            Block::Paragraph(block) => canonical_runs(&mut block.text, &mut block.runs),
            Block::Quote(block) => canonical_runs(&mut block.text, &mut block.runs),
            _ => {}
        }
    }

    /// Plain text of the block, for previews and search.
    pub fn plain_text(&self) -> String {
        match self {
            Block::Heading(block) => runs_text(&block.runs),
            Block::Paragraph(block) => runs_text(&block.runs),
            Block::Quote(block) => runs_text(&block.runs),
            Block::List(block) => block
                .items
                .iter()
                .map(|item| runs_text(&item.runs))
                .collect::<Vec<_>>()
                .join(" | "),
            Block::Table(block) => block
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(TableCell::text)
                        .collect::<Vec<_>>()
                        .join(" | ")
                })
                .collect::<Vec<_>>()
                .join(" / "),
            Block::Image(block) => block
                .caption
                .clone()
                .or_else(|| block.alt.clone())
                .unwrap_or_default(),
            Block::Code(block) => block.text.clone(),
            Block::Toc(block) => block.title.clone().unwrap_or_default(),
            Block::PageBreak(_) | Block::HorizontalRule(_) => String::new(),
        }
    }

    pub fn run_groups(&self) -> Vec<&[Run]> {
        match self {
            Block::Heading(block) => vec![&block.runs],
            Block::Paragraph(block) => vec![&block.runs],
            Block::Quote(block) => vec![&block.runs],
            Block::List(block) => block
                .items
                .iter()
                .map(|item| item.runs.as_slice())
                .collect(),
            Block::Table(block) => block
                .rows
                .iter()
                .flatten()
                .map(|cell| cell.runs.as_slice())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Every run of the block, for text replacement.
    /// Separate text containers; replacements never cross paragraphs, list
    /// items or table cells, even when their text happens to be adjacent.
    pub fn run_groups_mut(&mut self) -> Vec<&mut Vec<Run>> {
        match self {
            Block::Heading(block) => vec![&mut block.runs],
            Block::Paragraph(block) => vec![&mut block.runs],
            Block::Quote(block) => vec![&mut block.runs],
            Block::List(block) => block.items.iter_mut().map(|item| &mut item.runs).collect(),
            Block::Table(block) => block
                .rows
                .iter_mut()
                .flat_map(|row| row.iter_mut())
                .map(|cell| &mut cell.runs)
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn validate(&self, path: &str) -> OfficeResult<()> {
        for runs in self.run_groups() {
            for run in runs {
                if let Some(mode) = run.math {
                    if mode == crate::common::MathMode::Display && runs.len() != 1 {
                        return Err(OfficeError::invalid(format!(
                            "{path}: display math must be the only run in its paragraph or cell"
                        )));
                    }
                    super::math::render(&run.text, mode)
                        .map_err(|err| prefix(err, path, "math"))?;
                }
            }
        }
        match self {
            Block::Heading(block) => {
                if !(1..=6).contains(&block.level) {
                    return Err(OfficeError::invalid(format!(
                        "{path}.level must be 1..=6, got {}",
                        block.level
                    )));
                }
                if runs_text(&block.runs).trim().is_empty() {
                    return Err(OfficeError::invalid(format!("{path}: heading has no text")));
                }
                validate_runs(&block.runs, path)
            }
            Block::Paragraph(block) => {
                if let Some(spacing) = block.line_spacing {
                    if !(0.8..=3.0).contains(&spacing) {
                        return Err(OfficeError::invalid(format!(
                            "{path}.line_spacing must be between 0.8 and 3.0"
                        )));
                    }
                }
                validate_runs(&block.runs, path)
            }
            Block::Quote(block) => validate_runs(&block.runs, path),
            Block::List(block) => {
                if block.items.is_empty() {
                    return Err(OfficeError::invalid(format!("{path}: list has no items")));
                }
                for (index, item) in block.items.iter().enumerate() {
                    if item.level > 8 {
                        return Err(OfficeError::invalid(format!(
                            "{path}.items[{index}].level must be 0..=8"
                        )));
                    }
                    validate_runs(&item.runs, &format!("{path}.items[{index}]"))?;
                }
                Ok(())
            }
            Block::Table(block) => {
                if block.rows.is_empty() || block.rows.iter().all(Vec::is_empty) {
                    return Err(OfficeError::invalid(format!("{path}: table has no cells")));
                }
                if block.rows.len() > 2000 {
                    return Err(OfficeError::limit(format!(
                        "{path}: tables are limited to 2000 rows"
                    )));
                }
                for (row_index, row) in block.rows.iter().enumerate() {
                    if row
                        .iter()
                        .map(|cell| cell.colspan.unwrap_or(1) as u64)
                        .sum::<u64>()
                        > 63
                    {
                        return Err(OfficeError::limit(format!(
                            "{path}.rows[{row_index}]: Word tables are limited to 63 columns"
                        )));
                    }
                    for (cell_index, cell) in row.iter().enumerate() {
                        cell.validate(&format!("{path}.rows[{row_index}][{cell_index}]"))?;
                    }
                }
                if block
                    .font_size_pt
                    .is_some_and(|size| !(1.0..=400.0).contains(&size))
                {
                    return Err(OfficeError::invalid(format!(
                        "{path}.font_size_pt must be between 1 and 400"
                    )));
                }
                if let Some(widths) = &block.column_widths_cm {
                    if widths.iter().any(|width| !(0.2..=60.0).contains(width)) {
                        return Err(OfficeError::invalid(format!(
                            "{path}.column_widths_cm values must be between 0.2 and 60"
                        )));
                    }
                }
                Ok(())
            }
            Block::Image(block) => {
                if block.src.is_none() && block.asset.is_none() {
                    return Err(OfficeError::invalid(format!(
                        "{path}: image needs `src` (a file path or data URL) or the `asset` of an embedded picture"
                    )));
                }
                for (name, value) in [("width_cm", block.width_cm), ("height_cm", block.height_cm)]
                {
                    if let Some(value) = value {
                        if !(0.1..=100.0).contains(&value) {
                            return Err(OfficeError::invalid(format!(
                                "{path}.{name} must be between 0.1 and 100"
                            )));
                        }
                    }
                }
                Ok(())
            }
            Block::Toc(block) => {
                if !(1..=6).contains(&block.levels) {
                    return Err(OfficeError::invalid(format!("{path}.levels must be 1..=6")));
                }
                Ok(())
            }
            Block::Code(_) | Block::PageBreak(_) | Block::HorizontalRule(_) => Ok(()),
        }
    }
}

impl UnknownFields for Block {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        match self {
            Block::Heading(block) => {
                report_extra(&block.extra, path, out);
                report_list(&block.runs, &format!("{path}.runs"), out);
            }
            Block::Paragraph(block) => {
                report_extra(&block.extra, path, out);
                report_list(&block.runs, &format!("{path}.runs"), out);
            }
            Block::Quote(block) => {
                report_extra(&block.extra, path, out);
                report_list(&block.runs, &format!("{path}.runs"), out);
            }
            Block::List(block) => {
                report_extra(&block.extra, path, out);
                for (index, item) in block.items.iter().enumerate() {
                    let item_path = format!("{path}.items[{index}]");
                    report_extra(&item.extra, &item_path, out);
                    report_list(&item.runs, &format!("{item_path}.runs"), out);
                }
            }
            Block::Table(block) => {
                report_extra(&block.extra, path, out);
                for (row_index, row) in block.rows.iter().enumerate() {
                    report_list(row, &format!("{path}.rows[{row_index}]"), out);
                }
            }
            Block::Image(block) => report_extra(&block.extra, path, out),
            Block::Code(block) => report_extra(&block.extra, path, out),
            Block::PageBreak(block) | Block::HorizontalRule(block) => {
                report_extra(&block.extra, path, out)
            }
            Block::Toc(block) => report_extra(&block.extra, path, out),
        }
    }
}

impl UnknownFields for PageSetup {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        report_extra(&self.margins_cm.extra, &format!("{path}.margins_cm"), out);
    }
}

impl UnknownFields for DocxStyles {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl UnknownFields for HeaderFooter {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl UnknownFields for DocxDocument {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        self.properties
            .unknown_fields(&format!("{path}.properties"), out);
        self.page.unknown_fields(&format!("{path}.page"), out);
        self.styles.unknown_fields(&format!("{path}.styles"), out);
        if let Some(header) = &self.header {
            header.unknown_fields(&format!("{path}.header"), out);
        }
        if let Some(footer) = &self.footer {
            footer.unknown_fields(&format!("{path}.footer"), out);
        }
        report_list(&self.blocks, &format!("{path}.blocks"), out);
    }
}
