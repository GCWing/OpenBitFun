//! Slide deck model: a fixed px canvas of absolutely positioned elements,
//! following GenOffice's page spec (`x`/`y`/`w`/`h` in px, paint order =
//! array order).

use crate::common::{
    canonical_runs, parse_color, prefix, report_extra, report_list, runs_text, validate_language,
    validate_runs, Align, DocumentProperties, Extra, Run, TableCell, UnknownFields, VerticalAlign,
};
use crate::error::{OfficeError, OfficeResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const SHAPE_KINDS: &[&str] = &[
    "rect",
    "roundRect",
    "ellipse",
    "triangle",
    "rtTriangle",
    "rightArrow",
    "leftArrow",
    "upArrow",
    "downArrow",
    "chevron",
    "diamond",
    "parallelogram",
    "trapezoid",
    "hexagon",
    "pentagon",
    "octagon",
    "plus",
    "pie",
    "donut",
    "star5",
    "heart",
    "cloud",
    "line",
    "lineArrow",
];

pub(crate) const MAX_ELEMENTS_PER_SLIDE: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SlideSize {
    #[default]
    #[serde(rename = "16:9", alias = "wide", alias = "widescreen")]
    Wide,
    #[serde(rename = "4:3", alias = "standard")]
    Standard,
}

impl SlideSize {
    /// Canvas size in px; one px is 9525 EMU in both sizes.
    pub const fn canvas(self) -> (f64, f64) {
        match self {
            Self::Wide => (1280.0, 720.0),
            Self::Standard => (960.0, 720.0),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeckTheme {
    /// Latin font for all text unless a run names its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// Font for CJK text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    /// Default text language; runs/elements may override it. Omitted means auto.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// Default text color.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PptxDocument {
    #[serde(default)]
    pub properties: DocumentProperties,
    #[serde(default)]
    pub slide_size: SlideSize,
    #[serde(default)]
    pub theme: DeckTheme,
    #[serde(default)]
    pub slides: Vec<Slide>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Slide {
    /// Planning label echoed from an outline; also the slide's name in read results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    /// Speaker notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub elements: Vec<Element>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Element {
    Shape(ShapeElement),
    #[serde(alias = "textbox")]
    Text(TextElement),
    #[serde(alias = "picture")]
    Image(ImageElement),
    Table(TableElement),
}

/// Run defaults shared by text-bearing elements: a run or paragraph that
/// does not set a field inherits it from here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "sizePt")]
    pub size_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub color: String,
    #[serde(default = "default_stroke_width", alias = "widthPt", alias = "width")]
    pub width_pt: f64,
    /// `solid` (default), `dash`, or `dot`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_stroke_width() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapeElement {
    #[serde(default = "default_shape")]
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
    #[serde(default, skip_serializing)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paragraphs: Vec<Paragraph>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valign: Option<VerticalAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<f64>,
    #[serde(default, skip_serializing_if = "is_false", alias = "flipH")]
    pub flip_h: bool,
    #[serde(default, skip_serializing_if = "is_false", alias = "flipV")]
    pub flip_v: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(flatten)]
    pub defaults: TextDefaults,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_shape() -> String {
    "rect".to_string()
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextElement {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing)]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paragraphs: Vec<Paragraph>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valign: Option<VerticalAlign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(flatten)]
    pub defaults: TextDefaults,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFit {
    /// Center-crop to fill the box (object-fit: cover).
    #[default]
    Cover,
    /// Fit inside the box, keeping the whole picture.
    Contain,
    /// Stretch to the box, ignoring the aspect ratio.
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageElement {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "url",
        alias = "path"
    )]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default)]
    pub fit: ImageFit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "alt_text")]
    pub alt: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableElement {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rows: Vec<Vec<TableCell>>,
    /// Style the first row as a header.
    #[serde(default = "default_true")]
    pub header: bool,
    /// Column widths in px; scaled to `w` when they do not add up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_widths: Option<Vec<f64>>,
    #[serde(default = "default_table_font_size", alias = "fontSizePt")]
    pub font_size_pt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default = "default_header_fill")]
    pub header_fill: String,
    #[serde(default = "default_header_color")]
    pub header_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// Alternate row fill; empty string disables banding.
    #[serde(default = "default_band_fill")]
    pub band_fill: String,
    #[serde(default = "default_border_color")]
    pub border_color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_true() -> bool {
    true
}
fn default_table_font_size() -> f64 {
    14.0
}
fn default_header_fill() -> String {
    "#1F3864".to_string()
}
fn default_header_color() -> String {
    "#FFFFFF".to_string()
}
fn default_band_fill() -> String {
    "#F2F2F2".to_string()
}
fn default_border_color() -> String {
    "#BFBFBF".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "ParagraphInput")]
pub struct Paragraph {
    #[serde(default)]
    pub runs: Vec<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_spacing_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_before_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_after_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bullet: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub numbered: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub level: u8,
    #[serde(flatten)]
    pub extra: Extra,
}

fn is_zero(value: &u8) -> bool {
    *value == 0
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ParagraphInput {
    Text(String),
    Full(ParagraphFull),
}

#[derive(Deserialize)]
struct ParagraphFull {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    runs: Vec<Run>,
    #[serde(default)]
    align: Option<Align>,
    #[serde(default, alias = "lineSpacingPct")]
    line_spacing_pct: Option<f64>,
    #[serde(default, alias = "spaceBeforePt")]
    space_before_pt: Option<f64>,
    #[serde(default, alias = "spaceAfterPt")]
    space_after_pt: Option<f64>,
    #[serde(default)]
    bullet: bool,
    #[serde(default)]
    numbered: bool,
    #[serde(default)]
    level: u8,
    /// Run defaults at paragraph level, folded into the runs.
    #[serde(default, alias = "sizePt")]
    size_pt: Option<f64>,
    #[serde(default)]
    bold: Option<bool>,
    #[serde(default)]
    italic: Option<bool>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    font: Option<String>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(flatten)]
    extra: Extra,
}

impl From<ParagraphInput> for Paragraph {
    fn from(input: ParagraphInput) -> Self {
        match input {
            ParagraphInput::Text(text) => Paragraph {
                runs: vec![Run::plain(text)],
                ..Paragraph::default()
            },
            ParagraphInput::Full(mut full) => {
                canonical_runs(&mut full.text, &mut full.runs);
                for run in &mut full.runs {
                    run.size_pt = run.size_pt.or(full.size_pt);
                    run.bold = run.bold.or(full.bold);
                    run.italic = run.italic.or(full.italic);
                    if run.color.is_none() {
                        run.color = full.color.clone();
                    }
                    if run.font.is_none() {
                        run.font = full.font.clone();
                    }
                    if run.lang.is_none() {
                        run.lang = full.lang.clone();
                    }
                }
                Paragraph {
                    runs: full.runs,
                    align: full.align,
                    line_spacing_pct: full.line_spacing_pct,
                    space_before_pt: full.space_before_pt,
                    space_after_pt: full.space_after_pt,
                    bullet: full.bullet,
                    numbered: full.numbered,
                    level: full.level,
                    extra: full.extra,
                }
            }
        }
    }
}

impl Paragraph {
    fn validate(&self, path: &str) -> OfficeResult<()> {
        validate_runs(&self.runs, path)?;
        if self.runs.iter().any(|run| run.math.is_some()) {
            return Err(OfficeError::invalid(format!(
                "{path}: native math runs are currently supported only in DOCX"
            )));
        }
        if let Some(value) = self.line_spacing_pct {
            if !(50.0..=300.0).contains(&value) {
                return Err(OfficeError::invalid(format!(
                    "{path}.line_spacing_pct must be 50..=300"
                )));
            }
        }
        for (name, value) in [
            ("space_before_pt", self.space_before_pt),
            ("space_after_pt", self.space_after_pt),
        ] {
            if value.is_some_and(|value| !(0.0..=200.0).contains(&value)) {
                return Err(OfficeError::invalid(format!(
                    "{path}.{name} must be 0..=200"
                )));
            }
        }
        if self.level > 8 {
            return Err(OfficeError::invalid(format!("{path}.level must be 0..=8")));
        }
        Ok(())
    }
}

impl UnknownFields for Paragraph {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        report_list(&self.runs, &format!("{path}.runs"), out);
    }
}

impl TextDefaults {
    fn validate(&self, path: &str) -> OfficeResult<()> {
        if let Some(lang) = &self.lang {
            validate_language(lang).map_err(|err| prefix(err, path, "lang"))?;
        }
        if let Some(color) = &self.color {
            parse_color(color).map_err(|err| prefix(err, path, "color"))?;
        }
        if self
            .size_pt
            .is_some_and(|size| !(1.0..=400.0).contains(&size))
        {
            return Err(OfficeError::invalid(format!(
                "{path}.size_pt must be 1..=400"
            )));
        }
        Ok(())
    }
}

fn check_geometry(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    allow_flat: bool,
    path: &str,
) -> OfficeResult<()> {
    for (name, value) in [("x", x), ("y", y), ("w", w), ("h", h)] {
        if !value.is_finite() || value.abs() > 20_000.0 {
            return Err(OfficeError::invalid(format!(
                "{path}.{name} must be a finite px value"
            )));
        }
    }
    let minimum = if allow_flat { 0.0 } else { 1.0 };
    if w < minimum || h < minimum || (w <= 0.0 && h <= 0.0) {
        return Err(OfficeError::invalid(format!(
            "{path}: w and h must be at least {minimum} px (got {w}×{h})"
        )));
    }
    Ok(())
}

impl Element {
    pub fn kind(&self) -> &'static str {
        match self {
            Element::Shape(_) => "shape",
            Element::Text(_) => "text",
            Element::Image(_) => "image",
            Element::Table(_) => "table",
        }
    }

    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        match self {
            Element::Shape(e) => (e.x, e.y, e.w, e.h),
            Element::Text(e) => (e.x, e.y, e.w, e.h),
            Element::Image(e) => (e.x, e.y, e.w, e.h),
            Element::Table(e) => (e.x, e.y, e.w, e.h),
        }
    }

    pub fn canonicalize(&mut self) {
        let shorthand = |text: &mut Option<String>, paragraphs: &mut Vec<Paragraph>| {
            if let Some(text) = text.take() {
                if paragraphs.is_empty() {
                    paragraphs.extend(text.split('\n').map(|line| Paragraph {
                        runs: vec![Run::plain(line)],
                        ..Paragraph::default()
                    }));
                }
            }
        };
        match self {
            Element::Shape(e) => shorthand(&mut e.text, &mut e.paragraphs),
            Element::Text(e) => shorthand(&mut e.text, &mut e.paragraphs),
            _ => {}
        }
    }

    pub fn plain_text(&self) -> String {
        let paragraphs_text = |paragraphs: &[Paragraph]| {
            paragraphs
                .iter()
                .map(|paragraph| runs_text(&paragraph.runs))
                .collect::<Vec<_>>()
                .join("\n")
        };
        match self {
            Element::Shape(e) => paragraphs_text(&e.paragraphs),
            Element::Text(e) => paragraphs_text(&e.paragraphs),
            Element::Image(e) => e.alt.clone().unwrap_or_default(),
            Element::Table(e) => e
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
        }
    }

    pub fn validate(&self, path: &str) -> OfficeResult<()> {
        match self {
            Element::Shape(e) => {
                if !SHAPE_KINDS.contains(&e.shape.as_str()) {
                    let hint = crate::common::did_you_mean(&e.shape, SHAPE_KINDS)
                        .map(|guess| format!(" Did you mean `{guess}`?"))
                        .unwrap_or_default();
                    return Err(OfficeError::invalid(format!(
                        "{path}.shape `{}` is unknown.{hint} Supported: {}",
                        e.shape,
                        SHAPE_KINDS.join(", ")
                    )));
                }
                let is_line = e.shape == "line" || e.shape == "lineArrow";
                check_geometry(e.x, e.y, e.w, e.h, is_line, path)?;
                if let Some(fill) = &e.fill {
                    parse_color(fill).map_err(|err| prefix(err, path, "fill"))?;
                }
                if let Some(stroke) = &e.stroke {
                    parse_color(&stroke.color).map_err(|err| prefix(err, path, "stroke.color"))?;
                    if !(0.0..=50.0).contains(&stroke.width_pt) {
                        return Err(OfficeError::invalid(format!(
                            "{path}.stroke.width_pt must be 0..=50"
                        )));
                    }
                    if let Some(dash) = &stroke.dash {
                        if !matches!(dash.as_str(), "solid" | "dash" | "dot") {
                            return Err(OfficeError::invalid(format!(
                                "{path}.stroke.dash must be solid, dash, or dot"
                            )));
                        }
                    }
                }
                if is_line && e.stroke.is_none() {
                    return Err(OfficeError::invalid(format!(
                        "{path}: `{}` shapes need a `stroke`",
                        e.shape
                    )));
                }
                if !is_line && e.fill.is_none() && e.stroke.is_none() && e.paragraphs.is_empty() {
                    return Err(OfficeError::invalid(format!(
                        "{path}: a shape needs a `fill`, a `stroke`, or text"
                    )));
                }
                e.defaults.validate(path)?;
                for (index, paragraph) in e.paragraphs.iter().enumerate() {
                    paragraph.validate(&format!("{path}.paragraphs[{index}]"))?;
                }
                Ok(())
            }
            Element::Text(e) => {
                check_geometry(e.x, e.y, e.w, e.h, false, path)?;
                if e.paragraphs
                    .iter()
                    .all(|paragraph| runs_text(&paragraph.runs).trim().is_empty())
                {
                    return Err(OfficeError::invalid(format!(
                        "{path}: text element has no text (use `text` or `paragraphs`)"
                    )));
                }
                e.defaults.validate(path)?;
                for (index, paragraph) in e.paragraphs.iter().enumerate() {
                    paragraph.validate(&format!("{path}.paragraphs[{index}]"))?;
                }
                Ok(())
            }
            Element::Image(e) => {
                check_geometry(e.x, e.y, e.w, e.h, false, path)?;
                if e.src.is_none() && e.asset.is_none() {
                    return Err(OfficeError::invalid(format!(
                        "{path}: image needs `src` (an absolute file path or data URL) or the `asset` of an embedded picture"
                    )));
                }
                Ok(())
            }
            Element::Table(e) => {
                check_geometry(e.x, e.y, e.w, e.h, false, path)?;
                if e.rows.is_empty() || e.rows.iter().all(Vec::is_empty) {
                    return Err(OfficeError::invalid(format!("{path}: table has no cells")));
                }
                if e.rows.len() > 60 || e.rows.iter().any(|row| row.len() > 30) {
                    return Err(OfficeError::limit(format!(
                        "{path}: slide tables are limited to 60 rows and 30 columns; split the data across slides"
                    )));
                }
                for (row_index, row) in e.rows.iter().enumerate() {
                    for (cell_index, cell) in row.iter().enumerate() {
                        cell.validate(&format!("{path}.rows[{row_index}][{cell_index}]"))?;
                        if cell.runs.iter().any(|run| run.math.is_some()) {
                            return Err(OfficeError::invalid(format!(
                                "{path}: native math runs are currently supported only in DOCX"
                            )));
                        }
                    }
                }
                for (name, color) in [
                    ("header_fill", Some(&e.header_fill)),
                    ("header_color", Some(&e.header_color)),
                    ("border_color", Some(&e.border_color)),
                    ("fill", e.fill.as_ref()),
                    ("text_color", e.text_color.as_ref()),
                ] {
                    if let Some(color) = color {
                        parse_color(color).map_err(|err| prefix(err, path, name))?;
                    }
                }
                if !e.band_fill.is_empty() {
                    parse_color(&e.band_fill).map_err(|err| prefix(err, path, "band_fill"))?;
                }
                if !(4.0..=96.0).contains(&e.font_size_pt) {
                    return Err(OfficeError::invalid(format!(
                        "{path}.font_size_pt must be 4..=96"
                    )));
                }
                if let Some(widths) = &e.column_widths {
                    if widths
                        .iter()
                        .any(|width| !width.is_finite() || *width <= 0.0)
                    {
                        return Err(OfficeError::invalid(format!(
                            "{path}.column_widths must be positive px"
                        )));
                    }
                }
                Ok(())
            }
        }
    }
}

impl UnknownFields for Element {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        match self {
            Element::Shape(e) => {
                report_extra(&e.extra, path, out);
                if let Some(stroke) = &e.stroke {
                    report_extra(&stroke.extra, &format!("{path}.stroke"), out);
                }
                report_list(&e.paragraphs, &format!("{path}.paragraphs"), out);
            }
            Element::Text(e) => {
                report_extra(&e.extra, path, out);
                report_list(&e.paragraphs, &format!("{path}.paragraphs"), out);
            }
            Element::Image(e) => report_extra(&e.extra, path, out),
            Element::Table(e) => {
                report_extra(&e.extra, path, out);
                for (index, row) in e.rows.iter().enumerate() {
                    report_list(row, &format!("{path}.rows[{index}]"), out);
                }
            }
        }
    }
}

impl Slide {
    pub fn canonicalize(&mut self) {
        for element in &mut self.elements {
            element.canonicalize();
        }
    }

    pub fn validate(&self, path: &str) -> OfficeResult<()> {
        if self.elements.len() > MAX_ELEMENTS_PER_SLIDE {
            return Err(OfficeError::limit(format!(
                "{path}: a slide is limited to {MAX_ELEMENTS_PER_SLIDE} elements"
            )));
        }
        if let Some(background) = &self.background {
            parse_color(background).map_err(|err| prefix(err, path, "background"))?;
        }
        for (index, element) in self.elements.iter().enumerate() {
            element.validate(&format!("{path}.elements[{index}]"))?;
        }
        Ok(())
    }

    /// A short label: the planning title, else the first line of text.
    pub fn label(&self) -> String {
        if let Some(title) = &self.title {
            return title.clone();
        }
        self.elements
            .iter()
            .map(Element::plain_text)
            .find(|text| !text.trim().is_empty())
            .map(|text| text.lines().next().unwrap_or("").to_string())
            .unwrap_or_default()
    }
}

impl UnknownFields for Slide {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        report_list(&self.elements, &format!("{path}.elements"), out);
    }
}

impl UnknownFields for PptxDocument {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        self.properties
            .unknown_fields(&format!("{path}.properties"), out);
        report_extra(&self.theme.extra, &format!("{path}.theme"), out);
        report_list(&self.slides, &format!("{path}.slides"), out);
    }
}

impl PptxDocument {
    pub fn validate_settings(&self) -> OfficeResult<()> {
        if let Some(lang) = &self.theme.lang {
            validate_language(lang).map_err(|err| prefix(err, "theme", "lang"))?;
        }
        if let Some(color) = &self.theme.text_color {
            parse_color(color).map_err(|err| prefix(err, "theme", "text_color"))?;
        }
        Ok(())
    }

    pub fn referenced_assets(&self) -> BTreeSet<String> {
        self.slides
            .iter()
            .flat_map(|slide| slide.elements.iter())
            .filter_map(|element| match element {
                Element::Image(image) => image.asset.clone(),
                _ => None,
            })
            .collect()
    }
}
