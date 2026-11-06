//! Types and helpers shared by the docx, xlsx, and pptx models.

use crate::error::{OfficeError, OfficeResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Fields the current schema does not know. Stored documents keep them so a
/// newer writer's data survives a round trip through this version; operation
/// input reports them so a typo is not silently ignored.
pub type Extra = BTreeMap<String, Value>;

pub trait UnknownFields {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>);
}

pub(crate) fn report_extra(extra: &Extra, path: &str, out: &mut Vec<String>) {
    for key in extra.keys() {
        out.push(if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        });
    }
}

pub(crate) fn report_list<T: UnknownFields>(items: &[T], path: &str, out: &mut Vec<String>) {
    for (index, item) in items.iter().enumerate() {
        item.unknown_fields(&format!("{path}[{index}]"), out);
    }
}

/// Parses one operation payload (without its `op` key) and rejects unknown
/// fields anywhere in it.
pub(crate) fn parse_operation<T: DeserializeOwned + UnknownFields>(
    value: &Value,
) -> OfficeResult<T> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| OfficeError::invalid("every operation must be a JSON object"))?;
    object.remove("op");
    let parsed: T = serde_json::from_value(Value::Object(object))
        .map_err(|err| OfficeError::invalid(err.to_string()))?;
    let mut unknown = Vec::new();
    parsed.unknown_fields("", &mut unknown);
    if !unknown.is_empty() {
        return Err(OfficeError::invalid(format!(
            "unknown field(s): {}; see the guide for the fields this operation accepts",
            unknown.join(", ")
        )));
    }
    Ok(parsed)
}

pub(crate) fn operation_name(value: &Value) -> OfficeResult<&str> {
    value
        .get("op")
        .and_then(Value::as_str)
        .ok_or_else(|| OfficeError::invalid("every operation needs an `op` string"))
}

pub(crate) fn unknown_operation(name: &str, supported: &[&str]) -> OfficeError {
    let hint = did_you_mean(name, supported)
        .map(|guess| format!(" Did you mean `{guess}`?"))
        .unwrap_or_default();
    OfficeError::invalid(format!(
        "unknown operation `{name}`.{hint} Supported: {}",
        supported.join(", ")
    ))
}

pub(crate) fn did_you_mean<'a>(input: &str, candidates: &[&'a str]) -> Option<&'a str> {
    let input = input.to_ascii_lowercase();
    candidates
        .iter()
        .map(|candidate| {
            (
                levenshtein(&input, &candidate.to_ascii_lowercase()),
                *candidate,
            )
        })
        .filter(|(distance, candidate)| *distance <= 2.max(candidate.len() / 4))
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, candidate)| candidate)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut current = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            current[j + 1] = (previous[j] + cost)
                .min(previous[j + 1] + 1)
                .min(current[j] + 1);
        }
        previous = current;
    }
    previous[b.len()]
}

/// Core document metadata written to `docProps/core.xml`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DocumentProperties {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "creator")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl UnknownFields for DocumentProperties {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl DocumentProperties {
    /// Applies the provided fields; an empty string clears a field.
    pub fn merge(&mut self, patch: &DocumentProperties) {
        fn merge_field(target: &mut Option<String>, value: &Option<String>) {
            if let Some(value) = value {
                *target = (!value.is_empty()).then(|| value.clone());
            }
        }
        merge_field(&mut self.title, &patch.title);
        merge_field(&mut self.subject, &patch.subject);
        merge_field(&mut self.author, &patch.author);
        merge_field(&mut self.keywords, &patch.keywords);
        merge_field(&mut self.description, &patch.description);
        merge_field(&mut self.category, &patch.category);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MathMode {
    Inline,
    Display,
}

/// One formatted span of text. Shared by Word paragraphs, slide paragraphs,
/// and table cells; each writer ignores the fields its format cannot show.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Run {
    #[serde(default)]
    pub text: String,
    /// DOCX equation source is kept as text for inspection and legacy readers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub math: Option<MathMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "strikethrough"
    )]
    pub strike: Option<bool>,
    /// Monospace inline code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superscript: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscript: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "sizePt",
        alias = "size"
    )]
    pub size_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// Script-specific overrides. `font` keeps its legacy all-script meaning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_script_font: Option<String>,
    /// BCP 47 text language; omitted legacy runs keep automatic language selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// External hyperlink target (http, https, or mailto).
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "url")]
    pub link: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Run {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            ..Self::default()
        }
    }

    pub fn validate(&self, path: &str) -> OfficeResult<()> {
        if let Some(lang) = &self.lang {
            validate_language(lang).map_err(|err| prefix(err, path, "lang"))?;
        }
        if let Some(color) = &self.color {
            parse_color(color).map_err(|err| prefix(err, path, "color"))?;
        }
        if let Some(color) = &self.highlight {
            parse_color(color).map_err(|err| prefix(err, path, "highlight"))?;
        }
        if let Some(size) = self.size_pt {
            if !(1.0..=400.0).contains(&size) {
                return Err(OfficeError::invalid(format!(
                    "{path}.size_pt must be between 1 and 400, got {size}"
                )));
            }
        }
        if let Some(link) = &self.link {
            validate_link(link).map_err(|err| prefix(err, path, "link"))?;
        }
        Ok(())
    }
}

/// Script-based fallback shared by Word and PowerPoint. Han-only content is
/// ambiguous; callers can override the language without forcing a font.
pub(crate) fn inferred_cjk_language(text: &str) -> Option<&'static str> {
    if text.chars().any(|c| matches!(c as u32, 0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9D | 0x1B000..=0x1B16F)) {
        Some("ja-JP")
    } else if text.chars().any(|c| matches!(c as u32, 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xAC00..=0xD7FF | 0xFFA0..=0xFFDC)) {
        Some("ko-KR")
    } else if text.chars().any(|c| matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2FA1F | 0x30000..=0x323AF)) {
        Some("zh-CN")
    } else {
        None
    }
}

/// A syntax check, not a locale allowlist: Office language tags are independent
/// of the product UI's supported locales.
pub(crate) fn validate_language(lang: &str) -> OfficeResult<()> {
    let mut parts = lang.split('-');
    let primary = parts.next().unwrap_or_default();
    if (!(2..=8).contains(&primary.len()) && !matches!(primary, "x" | "X" | "i" | "I"))
        || !primary.bytes().all(|c| c.is_ascii_alphabetic())
        || parts.any(|part| {
            part.is_empty() || part.len() > 8 || !part.bytes().all(|c| c.is_ascii_alphanumeric())
        })
    {
        return Err(OfficeError::invalid(
            "use a BCP 47 language tag, such as en-US, zh-CN, zh-TW, ja-JP, or ko-KR",
        ));
    }
    Ok(())
}

impl UnknownFields for Run {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

pub(crate) fn validate_link(link: &str) -> OfficeResult<()> {
    let lower = link.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")
    {
        Ok(())
    } else {
        Err(OfficeError::invalid(format!(
            "links must start with http://, https:// or mailto:, got `{link}`"
        )))
    }
}

pub(crate) fn prefix(mut error: OfficeError, path: &str, field: &str) -> OfficeError {
    let location = if path.is_empty() {
        field.to_string()
    } else {
        format!("{path}.{field}")
    };
    error.message = format!("{location}: {}", error.message);
    error
}

/// Inline content accepted wherever text appears: either a plain `text`
/// string or explicit `runs`. Stored documents always keep `runs`.
pub(crate) fn canonical_runs(text: &mut Option<String>, runs: &mut Vec<Run>) {
    if let Some(text) = text.take() {
        if runs.is_empty() {
            runs.push(Run::plain(text));
        }
    }
}

pub(crate) fn runs_text(runs: &[Run]) -> String {
    runs.iter().map(|run| run.text.as_str()).collect()
}

pub(crate) fn validate_runs(runs: &[Run], path: &str) -> OfficeResult<()> {
    for (index, run) in runs.iter().enumerate() {
        run.validate(&format!("{path}.runs[{index}]"))?;
    }
    Ok(())
}

/// A table cell shared by Word and slide tables. Accepts a bare string,
/// number, boolean, or null as shorthand for `{ "text": ... }`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "TableCellInput")]
pub struct TableCell {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runs: Vec<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    /// Number of grid columns this cell spans (Word tables only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colspan: Option<u32>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum TableCellInput {
    Text(String),
    Number(serde_json::Number),
    Bool(bool),
    Null,
    Full(TableCellFull),
}

#[derive(Deserialize)]
struct TableCellFull {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    runs: Vec<Run>,
    #[serde(default)]
    bold: Option<bool>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    fill: Option<String>,
    #[serde(default)]
    align: Option<Align>,
    #[serde(default)]
    colspan: Option<u32>,
    #[serde(flatten)]
    extra: Extra,
}

impl From<TableCellInput> for TableCell {
    fn from(input: TableCellInput) -> Self {
        let text_cell = |text: String| TableCell {
            runs: if text.is_empty() {
                Vec::new()
            } else {
                vec![Run::plain(text)]
            },
            ..TableCell::default()
        };
        match input {
            TableCellInput::Text(text) => text_cell(text),
            TableCellInput::Number(number) => text_cell(number.to_string()),
            TableCellInput::Bool(value) => text_cell(value.to_string()),
            TableCellInput::Null => TableCell::default(),
            TableCellInput::Full(mut full) => {
                canonical_runs(&mut full.text, &mut full.runs);
                TableCell {
                    runs: full.runs,
                    bold: full.bold,
                    color: full.color,
                    fill: full.fill,
                    align: full.align,
                    colspan: full.colspan,
                    extra: full.extra,
                }
            }
        }
    }
}

impl TableCell {
    pub fn text(&self) -> String {
        runs_text(&self.runs)
    }

    pub fn validate(&self, path: &str) -> OfficeResult<()> {
        validate_runs(&self.runs, path)?;
        if let Some(color) = &self.color {
            parse_color(color).map_err(|err| prefix(err, path, "color"))?;
        }
        if let Some(color) = &self.fill {
            parse_color(color).map_err(|err| prefix(err, path, "fill"))?;
        }
        if self.colspan == Some(0) {
            return Err(OfficeError::invalid(format!(
                "{path}.colspan must be at least 1"
            )));
        }
        Ok(())
    }
}

impl UnknownFields for TableCell {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        report_list(&self.runs, &format!("{path}.runs"), out);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Left,
    #[serde(alias = "centre", alias = "middle")]
    Center,
    Right,
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerticalAlign {
    Top,
    #[serde(alias = "center")]
    Middle,
    Bottom,
}

/// `#RGB`, `#RRGGBB`, or `#RRGGBBAA` → (`RRGGBB`, alpha 0..=255).
pub fn parse_color(input: &str) -> OfficeResult<(String, Option<u8>)> {
    let hex = input.trim().trim_start_matches('#').to_ascii_uppercase();
    let expanded = if hex.len() == 3 {
        hex.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        hex
    };
    let valid = matches!(expanded.len(), 6 | 8) && expanded.chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(OfficeError::invalid(format!(
            "invalid color `{input}`; use #RRGGBB or #RRGGBBAA"
        )));
    }
    let alpha = (expanded.len() == 8)
        .then(|| u8::from_str_radix(&expanded[6..8], 16).ok())
        .flatten();
    Ok((expanded[..6].to_string(), alpha))
}

/// Normalizes an insertion point: `None` appends.
pub(crate) fn insertion_index(index: Option<usize>, len: usize, unit: &str) -> OfficeResult<usize> {
    match index {
        None => Ok(len),
        Some(index) if index <= len => Ok(index),
        Some(index) => Err(OfficeError::out_of_range(format!(
            "{unit} index {index} is out of range; valid insertion points are 0..={len}"
        ))),
    }
}

/// Validates `index..index+count` against a list length.
pub(crate) fn existing_span(
    index: usize,
    count: Option<usize>,
    len: usize,
    unit: &str,
) -> OfficeResult<std::ops::Range<usize>> {
    let count = count.unwrap_or(1);
    if count == 0 {
        return Err(OfficeError::invalid("count must be at least 1"));
    }
    if len == 0 {
        return Err(OfficeError::out_of_range(format!(
            "the document has no {unit}s yet"
        )));
    }
    if index >= len || index + count > len {
        return Err(OfficeError::out_of_range(format!(
            "{unit} range {index}..{} is out of range; the document has {len} {unit}(s), indexes 0..={}",
            index + count,
            len - 1
        )));
    }
    Ok(index..index + count)
}

/// Moves `span` so that it starts at `to` in the list that results after the
/// span is removed.
pub(crate) fn move_span<T>(
    items: &mut Vec<T>,
    span: std::ops::Range<usize>,
    to: usize,
    unit: &str,
) -> OfficeResult<()> {
    let limit = items.len() - span.len();
    if to > limit {
        return Err(OfficeError::out_of_range(format!(
            "target {unit} position {to} is out of range; after removing the moved {unit}(s) valid positions are 0..={limit}"
        )));
    }
    let moved: Vec<T> = items.drain(span).collect();
    items.splice(to..to, moved);
    Ok(())
}

/// RFC 7386 JSON merge patch.
pub(crate) fn merge_patch(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(patch_map) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            let target_map = target.as_object_mut().expect("object ensured above");
            for (key, value) in patch_map {
                if value.is_null() {
                    target_map.remove(key);
                } else {
                    merge_patch(target_map.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        other => *target = other.clone(),
    }
}

/// Shortens text for previews, counting characters rather than bytes.
pub(crate) fn preview(text: &str, limit: usize) -> String {
    let flattened: String = text
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .collect();
    let count = flattened.chars().count();
    if count <= limit {
        flattened
    } else {
        let head: String = flattened.chars().take(limit).collect();
        format!("{head}…(+{} chars)", count - limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_color_forms() {
        assert_eq!(parse_color("#abc").unwrap(), ("AABBCC".to_string(), None));
        assert_eq!(parse_color("112233").unwrap(), ("112233".to_string(), None));
        assert_eq!(
            parse_color("#11223380").unwrap(),
            ("112233".to_string(), Some(0x80))
        );
        assert!(parse_color("red").is_err());
    }

    #[test]
    fn table_cell_accepts_shorthand() {
        let cells: Vec<TableCell> =
            serde_json::from_value(json!(["a", 3, null, {"text": "b", "bold": true}])).unwrap();
        assert_eq!(cells[0].text(), "a");
        assert_eq!(cells[1].text(), "3");
        assert!(cells[2].runs.is_empty());
        assert_eq!(cells[3].bold, Some(true));
    }

    #[test]
    fn unknown_fields_are_reported_with_paths() {
        let cell: TableCell =
            serde_json::from_value(json!({"text": "a", "colour": "#fff"})).unwrap();
        let mut out = Vec::new();
        cell.unknown_fields("cell", &mut out);
        assert_eq!(out, vec!["cell.colour".to_string()]);
    }

    #[test]
    fn move_span_places_items_after_removal() {
        let mut items = vec![0, 1, 2, 3, 4];
        move_span(&mut items, 0..2, 3, "item").unwrap();
        assert_eq!(items, vec![2, 3, 4, 0, 1]);
    }

    #[test]
    fn suggests_close_operation_names() {
        assert_eq!(
            did_you_mean("insert_block", &["insert_blocks", "delete_blocks"]),
            Some("insert_blocks")
        );
    }
}
