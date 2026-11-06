//! Workbook model: sheets of sparse cells with styles and sheet layout.

use super::address::{parse_range, CellRef};
use super::formula::referenced_sheets;
use crate::common::{
    parse_color, prefix, report_extra, report_list, DocumentProperties, Extra, UnknownFields,
};
use crate::error::{OfficeError, OfficeResult};
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct XlsxDocument {
    #[serde(default)]
    pub properties: DocumentProperties,
    #[serde(default)]
    pub sheets: Vec<Sheet>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub name: String,
    #[serde(default, with = "cell_map")]
    pub cells: BTreeMap<CellRef, Cell>,
    /// Column widths in characters, keyed by one-based column number.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub column_widths: BTreeMap<u32, f64>,
    /// Row heights in points, keyed by one-based row number.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub row_heights: BTreeMap<u32, f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze: Option<Freeze>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autofilter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Freeze {
    #[serde(default)]
    pub rows: u32,
    #[serde(default, alias = "cols")]
    pub columns: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Cell {
    /// Literal value: string, number, boolean, or null for formula/style-only cells.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub value: Value,
    /// Formula without the leading `=`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<CellStyle>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Cell {
    pub fn is_empty(&self) -> bool {
        self.value.is_null() && self.formula.is_none() && self.style.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BorderStyle {
    None,
    Thin,
    Medium,
    Thick,
    Dashed,
    Dotted,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HorizontalAlign {
    General,
    Left,
    #[serde(alias = "centre", alias = "middle")]
    Center,
    Right,
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerticalAlignment {
    Top,
    #[serde(alias = "middle")]
    Center,
    Bottom,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CellStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "color")]
    pub font_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "size_pt")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "font")]
    pub font_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "fill",
        alias = "background"
    )]
    pub fill_color: Option<String>,
    /// Excel number format code, such as `#,##0.00`, `0.0%`, or `yyyy-mm-dd`.
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "format")]
    pub number_format: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "horizontal_align"
    )]
    pub align: Option<HorizontalAlign>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "vertical_align"
    )]
    pub valign: Option<VerticalAlignment>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "wrap_text")]
    pub wrap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<BorderStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border_color: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl CellStyle {
    /// Overlays the fields set in `patch`.
    pub fn merge(&mut self, patch: &CellStyle) {
        macro_rules! take {
            ($($field:ident),*) => {
                $(if patch.$field.is_some() { self.$field = patch.$field.clone(); })*
            };
        }
        take!(
            bold,
            italic,
            underline,
            strike,
            font_color,
            font_size,
            font_name,
            fill_color,
            number_format,
            align,
            valign,
            wrap,
            indent,
            border,
            border_color
        );
    }

    pub fn is_default(&self) -> bool {
        *self == CellStyle::default()
    }

    pub fn validate(&self, path: &str) -> OfficeResult<()> {
        for (name, color) in [
            ("font_color", &self.font_color),
            ("fill_color", &self.fill_color),
            ("border_color", &self.border_color),
        ] {
            if let Some(color) = color {
                parse_color(color).map_err(|err| prefix(err, path, name))?;
            }
        }
        if let Some(size) = self.font_size {
            if !(1.0..=409.0).contains(&size) {
                return Err(OfficeError::invalid(format!(
                    "{path}.font_size must be 1..=409"
                )));
            }
        }
        if self.indent.is_some_and(|indent| indent > 250) {
            return Err(OfficeError::invalid(format!(
                "{path}.indent must be 0..=250"
            )));
        }
        if self
            .number_format
            .as_ref()
            .is_some_and(|format| format.len() > 255)
        {
            return Err(OfficeError::invalid(format!(
                "{path}.number_format is too long"
            )));
        }
        Ok(())
    }
}

impl UnknownFields for CellStyle {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

impl UnknownFields for XlsxDocument {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
        self.properties
            .unknown_fields(&format!("{path}.properties"), out);
        report_list(&self.sheets, &format!("{path}.sheets"), out);
    }
}

impl UnknownFields for Sheet {
    fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
        report_extra(&self.extra, path, out);
    }
}

pub(crate) fn validate_sheet_name(name: &str) -> OfficeResult<()> {
    let length = name.chars().count();
    if name.trim().is_empty() || length > 31 {
        return Err(OfficeError::invalid(format!(
            "sheet name `{name}` must be 1 to 31 characters"
        )));
    }
    if name.contains(['[', ']', ':', '*', '?', '/', '\\']) {
        return Err(OfficeError::invalid(format!(
            "sheet name `{name}` cannot contain [ ] : * ? / \\"
        )));
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Err(OfficeError::invalid(format!(
            "sheet name `{name}` cannot start or end with an apostrophe"
        )));
    }
    if name.eq_ignore_ascii_case("history") {
        return Err(OfficeError::invalid("`History` is a reserved sheet name"));
    }
    Ok(())
}

impl XlsxDocument {
    pub fn sheet_index(&self, name: &str) -> Option<usize> {
        self.sheets
            .iter()
            .position(|sheet| sheet.name.eq_ignore_ascii_case(name))
    }

    /// Problems worth reporting after a batch.
    pub fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        for sheet in &self.sheets {
            let mut missing: Vec<String> = Vec::new();
            for (cell, value) in &sheet.cells {
                let Some(formula) = &value.formula else {
                    continue;
                };
                if formula.contains("#REF!") {
                    warnings.push(format!(
                        "sheet `{}` {cell}: formula contains #REF! (a referenced row, column, or sheet was deleted)",
                        sheet.name
                    ));
                }
                for referenced in referenced_sheets(formula) {
                    if self.sheet_index(&referenced).is_none() && !missing.contains(&referenced) {
                        missing.push(referenced);
                    }
                }
            }
            for name in missing {
                warnings.push(format!(
                    "sheet `{}` has formulas that reference sheet `{name}`, which does not exist",
                    sheet.name
                ));
            }
            let ranges: Vec<_> = sheet
                .merges
                .iter()
                .filter_map(|merge| parse_range(merge).ok())
                .collect();
            for (index, range) in ranges.iter().enumerate() {
                if ranges[index + 1..]
                    .iter()
                    .any(|other| other.intersects(range))
                {
                    warnings.push(format!(
                        "sheet `{}`: merged range {range} overlaps another merged range",
                        sheet.name
                    ));
                }
            }
        }
        let computed = super::eval::evaluate_workbook(self);
        let mut uncached: Vec<String> = Vec::new();
        for (sheet_index, sheet) in self.sheets.iter().enumerate() {
            for (cell, value) in &sheet.cells {
                if value.formula.is_some() && !computed.contains_key(&(sheet_index, *cell)) {
                    uncached.push(format!("{}!{cell}", sheet.name));
                }
            }
        }
        if !uncached.is_empty() {
            let sample: Vec<&str> = uncached.iter().take(5).map(String::as_str).collect();
            warnings.push(format!(
                "{} formula cell(s) ({}{}) use functions or references the local evaluator does not compute; they show values once Excel, WPS, or LibreOffice opens the file",
                uncached.len(),
                sample.join(", "),
                if uncached.len() > sample.len() { ", …" } else { "" }
            ));
        }
        for (sheet_index, sheet) in self.sheets.iter().enumerate() {
            for (cell, value) in &sheet.cells {
                if value.formula.is_none() {
                    continue;
                }
                if let Some(super::eval::Computed::Error(error)) =
                    computed.get(&(sheet_index, *cell))
                {
                    if *error != "#REF!" {
                        warnings.push(format!(
                            "sheet `{}` {cell}: formula evaluates to {error}",
                            sheet.name
                        ));
                    }
                }
            }
        }
        warnings.truncate(30);
        warnings
    }
}

/// Serializes the sparse cell map as `{ "A1": {...}, ... }` in row-major order.
mod cell_map {
    use super::*;
    use crate::xlsx::address::parse_cell;

    pub(crate) fn serialize<S: Serializer>(
        cells: &BTreeMap<CellRef, Cell>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(cells.len()))?;
        for (cell, value) in cells {
            map.serialize_entry(&cell.to_string(), value)?;
        }
        map.end()
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<BTreeMap<CellRef, Cell>, D::Error> {
        struct CellMapVisitor;
        impl<'de> Visitor<'de> for CellMapVisitor {
            type Value = BTreeMap<CellRef, Cell>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a map of A1 addresses to cells")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut access: M) -> Result<Self::Value, M::Error> {
                let mut cells = BTreeMap::new();
                while let Some((key, value)) = access.next_entry::<String, Cell>()? {
                    let cell = parse_cell(&key).map_err(serde::de::Error::custom)?;
                    cells.insert(cell, value);
                }
                Ok(cells)
            }
        }
        deserializer.deserialize_map(CellMapVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cells_round_trip_as_a1_map() {
        let mut sheet = Sheet {
            name: "S".to_string(),
            ..Sheet::default()
        };
        sheet.cells.insert(
            CellRef::new(2, 1),
            Cell {
                value: json!(5),
                ..Cell::default()
            },
        );
        let value = serde_json::to_value(&sheet).unwrap();
        assert_eq!(value["cells"]["A2"]["value"], json!(5));
        let back: Sheet = serde_json::from_value(value).unwrap();
        assert_eq!(back, sheet);
    }

    #[test]
    fn rejects_invalid_sheet_names() {
        assert!(validate_sheet_name("Q1/Q2").is_err());
        assert!(validate_sheet_name("").is_err());
        assert!(validate_sheet_name("营收 2024").is_ok());
    }
}
