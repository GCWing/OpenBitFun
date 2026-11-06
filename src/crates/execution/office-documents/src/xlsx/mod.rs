//! Workbooks (`.xlsx`).

pub(crate) mod address;
pub(crate) mod eval;
pub(crate) mod formula;
pub(crate) mod model;
pub(crate) mod ops;
pub(crate) mod render;

pub use model::{Cell, CellStyle, Sheet, XlsxDocument};

use crate::common::preview;
use crate::error::{OfficeError, OfficeResult};
use crate::{Detail, ReadRequest};
use address::{column_letters, parse_range, CellRange, CellRef};
use serde_json::{json, Value};

const MAX_READ_COLUMNS: u32 = 60;

pub(crate) fn read(book: &XlsxDocument, request: &ReadRequest) -> OfficeResult<Value> {
    let Some(name) = &request.sheet else {
        return Ok(list_sheets(book, request));
    };
    let index = book.sheet_index(name).ok_or_else(|| {
        OfficeError::not_found(format!(
            "no sheet named `{name}`; sheets: {}",
            book.sheets
                .iter()
                .map(|sheet| sheet.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;
    let sheet = &book.sheets[index];
    let computed = eval::evaluate_workbook(book);
    let used = used_range(sheet);
    let Some(used) = used else {
        return Ok(json!({ "sheet": sheet.name, "used_range": null, "rows": [], "total_rows": 0 }));
    };
    let requested = match &request.range {
        Some(range) => parse_range(range)?,
        None => used,
    };
    let total_rows = (requested.end.row - requested.start.row + 1) as usize;
    let (offset, limit) = request.window(total_rows, 100);
    let row_count = limit.min(total_rows - offset);
    let first = requested.start.row + offset as u32;
    let window = CellRange {
        start: CellRef::new(first, requested.start.col),
        end: CellRef::new(
            first + row_count.saturating_sub(1) as u32,
            requested.end.col,
        ),
    };
    let last_col = window.end.col.min(window.start.col + MAX_READ_COLUMNS - 1);
    let columns: Vec<String> = (window.start.col..=last_col).map(column_letters).collect();
    let mut rows = Vec::new();
    let mut styles = serde_json::Map::new();
    for row in first..first + row_count as u32 {
        let mut values = Vec::new();
        let mut any = false;
        for col in window.start.col..=last_col {
            let address = CellRef::new(row, col);
            let value = match sheet.cells.get(&address) {
                Some(cell) => {
                    if request.detail == Detail::Full {
                        if let Some(style) = &cell.style {
                            styles.insert(
                                address.to_string(),
                                serde_json::to_value(style).unwrap_or(Value::Null),
                            );
                        }
                    }
                    match (&cell.formula, &cell.value) {
                        (Some(formula), _) => match computed.get(&(index, address)) {
                            Some(value) => {
                                json!({ "formula": format!("={formula}"), "value": computed_json(value) })
                            }
                            None => json!({ "formula": format!("={formula}"), "value": null }),
                        },
                        (None, Value::String(text)) if request.detail == Detail::Outline => {
                            json!(preview(text, 200))
                        }
                        (None, other) => other.clone(),
                    }
                }
                None => Value::Null,
            };
            any |= !value.is_null();
            values.push(value);
        }
        if any {
            rows.push(json!({ "row": row, "cells": values }));
        }
    }
    let mut view = json!({
        "sheet": sheet.name,
        "used_range": used.to_string(),
        "window": (row_count > 0).then(|| CellRange { start: window.start, end: CellRef::new(window.end.row, last_col) }.to_string()),
        "offset": offset,
        "limit": limit,
        "total_rows": total_rows,
        "columns": columns,
        "rows": rows,
        "merges": sheet.merges,
        "freeze": sheet.freeze,
        "autofilter": sheet.autofilter,
        "note": "formula cells show {formula, value}; a null value means the formula uses functions only the spreadsheet application computes (on open)",
    });
    if window.end.col > last_col {
        view["columns_truncated"] = json!(true);
    }
    if offset + row_count < total_rows {
        view["next_offset"] = json!(offset + row_count);
    }
    if request.detail == Detail::Full {
        view["styles"] = Value::Object(styles);
        view["column_widths"] = json!(sheet
            .column_widths
            .iter()
            .map(|(column, width)| (column_letters(*column), *width))
            .collect::<std::collections::BTreeMap<_, _>>());
        view["row_heights"] = json!(sheet.row_heights);
    }
    Ok(view)
}

fn list_sheets(book: &XlsxDocument, request: &ReadRequest) -> Value {
    let total = book.sheets.len();
    let (offset, limit) = request.window(total, 50);
    let sheets: Vec<Value> = book
        .sheets
        .iter()
        .enumerate()
        .skip(offset)
        .take(limit)
        .map(|(index, sheet)| {
            json!({
                "index": index,
                "name": sheet.name,
                "used_range": used_range(sheet).map(|range| range.to_string()),
                "cells": sheet.cells.values().filter(|cell| !cell.value.is_null() || cell.formula.is_some()).count(),
                "formulas": sheet.cells.values().filter(|cell| cell.formula.is_some()).count(),
                "merges": sheet.merges.len(),
                "freeze": sheet.freeze,
                "autofilter": sheet.autofilter,
            })
        })
        .collect();
    let mut view = json!({
        "total_sheets": total,
        "offset": offset,
        "limit": limit,
        "sheets": sheets,
        "properties": book.properties,
        "hint": "pass `sheet` (and optionally `range` or offset/limit over rows) to read cell values",
    });
    if offset + limit < total {
        view["next_offset"] = json!(offset + limit);
    }
    view
}

fn used_range(sheet: &Sheet) -> Option<CellRange> {
    let mut cells = sheet
        .cells
        .iter()
        .filter(|(_, cell)| !cell.value.is_null() || cell.formula.is_some())
        .map(|(address, _)| *address)
        .peekable();
    cells.peek()?;
    let mut start = CellRef::new(u32::MAX, u32::MAX);
    let mut end = CellRef::new(0, 0);
    for cell in cells {
        start.row = start.row.min(cell.row);
        start.col = start.col.min(cell.col);
        end.row = end.row.max(cell.row);
        end.col = end.col.max(cell.col);
    }
    Some(CellRange { start, end })
}

fn computed_json(value: &eval::Computed) -> Value {
    match value {
        eval::Computed::Number(number) => json!(number),
        eval::Computed::Text(text) => json!(text),
        eval::Computed::Bool(flag) => json!(flag),
        eval::Computed::Error(error) => json!(error),
        eval::Computed::Empty => json!(0),
    }
}
