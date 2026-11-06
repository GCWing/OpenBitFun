//! Editable DrawingML charts backed by worksheet ranges.

use super::address::{parse_cell, parse_range, CellRange};
use super::model::XlsxDocument;
use crate::common::{parse_color, report_extra, report_list, Extra, UnknownFields};
use crate::{OfficeError, OfficeResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartKind {
    Column,
    Bar,
    Line,
    Pie,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chart {
    #[serde(rename = "type")]
    pub kind: ChartKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Top-left cell, with a fixed pixel extent independent of column widths.
    pub anchor: String,
    #[serde(default = "default_width")]
    pub width_px: u32,
    #[serde(default = "default_height")]
    pub height_px: u32,
    #[serde(default = "default_legend")]
    pub legend: bool,
    pub series: Vec<ChartSeries>,
    #[serde(flatten)]
    pub extra: Extra,
}

fn default_width() -> u32 {
    640
}
fn default_height() -> u32 {
    360
}
fn default_legend() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartSeries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub categories: ChartRange,
    pub values: ChartRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartRange {
    /// Omitted input means the chart's worksheet; normalized before storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    pub range: String,
    #[serde(flatten)]
    pub extra: Extra,
}

impl UnknownFields for Chart {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        report_list(&self.series, &format!("{path}.series"), out);
    }
}
impl UnknownFields for ChartSeries {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        self.categories
            .unknown_fields(&format!("{path}.categories"), out);
        self.values.unknown_fields(&format!("{path}.values"), out);
    }
}
impl UnknownFields for ChartRange {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl ChartRange {
    pub(crate) fn vector(&self) -> OfficeResult<CellRange> {
        let range = parse_range(&self.range)?;
        if range.start.row != range.end.row && range.start.col != range.end.col {
            return Err(OfficeError::invalid(
                "chart ranges must be a single row or column",
            ));
        }
        // Excel's per-series point limit also bounds cache generation.
        if range.cell_count() > 32_000 {
            return Err(OfficeError::limit(
                "a chart series is limited to 32000 points",
            ));
        }
        Ok(range)
    }

    fn normalize(&mut self, book: &XlsxDocument, owner: &str) -> OfficeResult<usize> {
        let name = self.sheet.as_deref().unwrap_or(owner);
        let index = book.sheet_index(name).ok_or_else(|| {
            OfficeError::not_found(format!("chart source sheet `{name}` does not exist"))
        })?;
        self.sheet = Some(book.sheets[index].name.clone());
        let range = self.vector()?;
        self.range = range.to_string();
        Ok(range.cell_count() as usize)
    }
}

impl Chart {
    pub(crate) fn normalize(&mut self, book: &XlsxDocument, owner: &str) -> OfficeResult<()> {
        let mut unknown = Vec::new();
        self.unknown_fields("chart", &mut unknown);
        if !unknown.is_empty() {
            return Err(OfficeError::invalid(format!(
                "unknown field(s): {}",
                unknown.join(", ")
            )));
        }
        self.anchor = parse_cell(&self.anchor)?.to_string();
        if self.width_px == 0 || self.height_px == 0 {
            return Err(OfficeError::invalid(
                "chart width_px and height_px must be positive",
            ));
        }
        if self.series.is_empty() || self.series.len() > 255 {
            return Err(OfficeError::invalid("a chart needs 1..=255 series"));
        }
        if self.kind == ChartKind::Pie && self.series.len() != 1 {
            return Err(OfficeError::invalid("a pie chart needs exactly one series"));
        }
        for series in &mut self.series {
            if series.categories.normalize(book, owner)? != series.values.normalize(book, owner)? {
                return Err(OfficeError::invalid(
                    "chart categories and values must contain the same number of cells",
                ));
            }
            if let Some(color) = &series.color {
                parse_color(color)?;
            }
        }
        Ok(())
    }
}
