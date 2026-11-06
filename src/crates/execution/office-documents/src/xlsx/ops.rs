//! Workbook edit operations.

use super::address::{
    column_letters, parse_cell, parse_column, parse_range, CellRange, CellRef, MAX_COLUMNS,
    MAX_ROWS,
};
use super::formula::{rename_sheet_in_formula, shift_formula, Axis, Shift};
use super::model::{validate_sheet_name, CellStyle, Freeze, Sheet, XlsxDocument};
use crate::common::{
    parse_color, parse_operation, report_extra, unknown_operation, DocumentProperties, Extra,
    UnknownFields,
};
use crate::error::{OfficeError, OfficeResult};
use crate::ApplyContext;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub(crate) const OPERATIONS: &[&str] = &[
    "add_sheet",
    "delete_sheet",
    "rename_sheet",
    "move_sheet",
    "set_cells",
    "append_rows",
    "insert_rows",
    "delete_rows",
    "insert_columns",
    "delete_columns",
    "clear_range",
    "format_range",
    "set_column_widths",
    "set_row_heights",
    "merge_cells",
    "unmerge_cells",
    "freeze_panes",
    "set_autofilter",
    "set_sheet",
    "set_properties",
];

const MAX_SHEETS: usize = 255;
const MAX_CELLS: usize = 2_000_000;
const MAX_FORMAT_CELLS: u64 = 1_000_000;

macro_rules! op_struct {
    ($name:ident { $($body:tt)* }) => {
        #[derive(Deserialize)]
        struct $name {
            $($body)*
            #[serde(flatten)]
            extra: Extra,
        }
        impl UnknownFields for $name {
            fn unknown_fields(&self, path: &str, out: &mut Vec<String>) {
                report_extra(&self.extra, path, out);
            }
        }
    };
}

op_struct!(AddSheet {
    name: String,
    #[serde(default)]
    index: Option<usize>,
    #[serde(default, alias = "values")]
    rows: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    start: Option<String>,
});
op_struct!(DeleteSheet {
    #[serde(default)]
    sheet: Option<Value>,
});
op_struct!(RenameSheet {
    #[serde(default)]
    sheet: Option<Value>,
    name: String,
});
op_struct!(MoveSheet {
    #[serde(default)]
    sheet: Option<Value>,
    to: usize,
});
op_struct!(SetCells {
    #[serde(default)]
    sheet: Option<Value>,
    #[serde(default, alias = "cell", alias = "anchor")]
    start: Option<String>,
    #[serde(alias = "values")]
    rows: Vec<Vec<Value>>,
});
op_struct!(AppendRows {
    #[serde(default)]
    sheet: Option<Value>,
    #[serde(alias = "values")]
    rows: Vec<Vec<Value>>,
    #[serde(default)]
    column: Option<String>,
});
op_struct!(InsertRows {
    #[serde(default)]
    sheet: Option<Value>,
    row: u32,
    #[serde(default)]
    count: Option<u32>,
    #[serde(default, alias = "values")]
    rows: Option<Vec<Vec<Value>>>,
});
op_struct!(DeleteRows {
    #[serde(default)]
    sheet: Option<Value>,
    row: u32,
    #[serde(default)]
    count: Option<u32>,
});
op_struct!(InsertColumns {
    #[serde(default)]
    sheet: Option<Value>,
    column: String,
    #[serde(default)]
    count: Option<u32>,
});
op_struct!(DeleteColumns {
    #[serde(default)]
    sheet: Option<Value>,
    column: String,
    #[serde(default)]
    count: Option<u32>,
});
op_struct!(ClearRange {
    #[serde(default)]
    sheet: Option<Value>,
    range: String,
    #[serde(default)]
    what: Option<String>,
});
op_struct!(FormatRange {
    #[serde(default)]
    sheet: Option<Value>,
    range: String,
    style: CellStyle,
});
op_struct!(SetColumnWidths {
    #[serde(default)]
    sheet: Option<Value>,
    widths: BTreeMap<String, f64>,
});
op_struct!(SetRowHeights {
    #[serde(default)]
    sheet: Option<Value>,
    heights: BTreeMap<String, f64>,
});
op_struct!(RangeOnly {
    #[serde(default)]
    sheet: Option<Value>,
    range: String,
});
op_struct!(FreezePanes {
    #[serde(default)]
    sheet: Option<Value>,
    #[serde(default)]
    rows: u32,
    #[serde(default, alias = "cols")]
    columns: u32,
});
op_struct!(SetAutofilter {
    #[serde(default)]
    sheet: Option<Value>,
    #[serde(default)]
    range: Option<String>,
});
op_struct!(SetSheet {
    #[serde(default)]
    sheet: Option<Value>,
    #[serde(default)]
    tab_color: Option<String>,
});

pub(crate) fn apply(
    book: &mut XlsxDocument,
    op: &str,
    value: &Value,
    ctx: &mut ApplyContext,
) -> OfficeResult<()> {
    match op {
        "add_sheet" => {
            let input: AddSheet = parse_operation(value)?;
            validate_sheet_name(&input.name)?;
            if book.sheet_index(&input.name).is_some() {
                return Err(OfficeError::invalid(format!(
                    "a sheet named `{}` already exists",
                    input.name
                )));
            }
            if book.sheets.len() >= MAX_SHEETS {
                return Err(OfficeError::limit(format!(
                    "a workbook is limited to {MAX_SHEETS} sheets"
                )));
            }
            let at = crate::common::insertion_index(input.index, book.sheets.len(), "sheet")?;
            let mut sheet = Sheet {
                name: input.name.clone(),
                ..Sheet::default()
            };
            if let Some(rows) = input.rows {
                let start = parse_cell(input.start.as_deref().unwrap_or("A1"))?;
                write_rows(&mut sheet, start, &rows)?;
            }
            book.sheets.insert(at, sheet);
            ensure_cell_budget(book)?;
            ctx.note(format!("added sheet `{}` at position {at}", input.name));
            Ok(())
        }
        "delete_sheet" => {
            let input: DeleteSheet = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let removed = book.sheets.remove(index);
            ctx.note(format!("deleted sheet `{}`", removed.name));
            Ok(())
        }
        "rename_sheet" => {
            let input: RenameSheet = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            validate_sheet_name(&input.name)?;
            if let Some(existing) = book.sheet_index(&input.name) {
                if existing != index {
                    return Err(OfficeError::invalid(format!(
                        "a sheet named `{}` already exists",
                        input.name
                    )));
                }
            }
            let old = std::mem::replace(&mut book.sheets[index].name, input.name.clone());
            for sheet in &mut book.sheets {
                for cell in sheet.cells.values_mut() {
                    if let Some(formula) = &mut cell.formula {
                        *formula = rename_sheet_in_formula(formula, &old, &input.name);
                    }
                }
            }
            ctx.note(format!("renamed sheet `{old}` to `{}`", input.name));
            Ok(())
        }
        "move_sheet" => {
            let input: MoveSheet = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            crate::common::move_span(&mut book.sheets, index..index + 1, input.to, "sheet")?;
            ctx.note(format!("moved sheet to position {}", input.to));
            Ok(())
        }
        "set_cells" => {
            let input: SetCells = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let start = parse_cell(input.start.as_deref().unwrap_or("A1"))?;
            let written = write_rows(&mut book.sheets[index], start, &input.rows)?;
            ensure_cell_budget(book)?;
            ctx.note(format!(
                "wrote {written} cell(s) on `{}` from {start}",
                book.sheets[index].name
            ));
            Ok(())
        }
        "append_rows" => {
            let input: AppendRows = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let sheet = &mut book.sheets[index];
            let next_row = sheet.cells.keys().map(|cell| cell.row).max().unwrap_or(0) + 1;
            let column = match &input.column {
                Some(column) => parse_column(column)?,
                None => 1,
            };
            let start = CellRef::new(next_row, column);
            write_rows(sheet, start, &input.rows)?;
            let name = sheet.name.clone();
            ensure_cell_budget(book)?;
            ctx.note(format!(
                "appended {} row(s) to `{name}` at row {next_row}",
                input.rows.len()
            ));
            Ok(())
        }
        "insert_rows" => {
            let input: InsertRows = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let count = input
                .count
                .or_else(|| input.rows.as_ref().map(|rows| rows.len() as u32))
                .unwrap_or(1)
                .max(1);
            check_index(input.row, MAX_ROWS, "row")?;
            shift_sheet(book, index, Axis::Row, input.row, count as i64)?;
            if let Some(rows) = &input.rows {
                write_rows(&mut book.sheets[index], CellRef::new(input.row, 1), rows)?;
            }
            ensure_cell_budget(book)?;
            ctx.note(format!("inserted {count} row(s) at row {}", input.row));
            Ok(())
        }
        "delete_rows" => {
            let input: DeleteRows = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let count = input.count.unwrap_or(1).max(1);
            check_index(input.row, MAX_ROWS, "row")?;
            shift_sheet(book, index, Axis::Row, input.row, -(count as i64))?;
            ctx.note(format!("deleted {count} row(s) at row {}", input.row));
            Ok(())
        }
        "insert_columns" => {
            let input: InsertColumns = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let column = parse_column(&input.column)?;
            let count = input.count.unwrap_or(1).max(1);
            shift_sheet(book, index, Axis::Column, column, count as i64)?;
            ctx.note(format!(
                "inserted {count} column(s) at {}",
                column_letters(column)
            ));
            Ok(())
        }
        "delete_columns" => {
            let input: DeleteColumns = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let column = parse_column(&input.column)?;
            let count = input.count.unwrap_or(1).max(1);
            shift_sheet(book, index, Axis::Column, column, -(count as i64))?;
            ctx.note(format!(
                "deleted {count} column(s) at {}",
                column_letters(column)
            ));
            Ok(())
        }
        "clear_range" => {
            let input: ClearRange = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let range = parse_range(&input.range)?;
            let what = input.what.as_deref().unwrap_or("all");
            if !matches!(what, "all" | "contents" | "formats") {
                return Err(OfficeError::invalid(
                    "`what` must be all, contents, or formats",
                ));
            }
            let sheet = &mut book.sheets[index];
            let mut cleared = 0;
            sheet.cells.retain(|cell, value| {
                if !range.contains(*cell) {
                    return true;
                }
                cleared += 1;
                match what {
                    "contents" => {
                        value.value = Value::Null;
                        value.formula = None;
                    }
                    "formats" => value.style = None,
                    _ => return false,
                }
                !value.is_empty()
            });
            ctx.note(format!("cleared {what} of {cleared} cell(s) in {range}"));
            Ok(())
        }
        "format_range" => {
            let input: FormatRange = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let range = parse_range(&input.range)?;
            let mut unknown = Vec::new();
            input.style.unknown_fields("style", &mut unknown);
            if !unknown.is_empty() {
                return Err(OfficeError::invalid(format!(
                    "unknown field(s): {}",
                    unknown.join(", ")
                )));
            }
            input.style.validate("style")?;
            if range.cell_count() > MAX_FORMAT_CELLS {
                return Err(OfficeError::limit(format!(
                    "format_range is limited to {MAX_FORMAT_CELLS} cells; format the used rows instead of whole columns"
                )));
            }
            let sheet = &mut book.sheets[index];
            for row in range.start.row..=range.end.row {
                for col in range.start.col..=range.end.col {
                    let cell = sheet.cells.entry(CellRef::new(row, col)).or_default();
                    let mut style = cell.style.take().unwrap_or_default();
                    style.merge(&input.style);
                    cell.style = (!style.is_default()).then_some(style);
                }
            }
            sheet.cells.retain(|_, cell| !cell.is_empty());
            ensure_cell_budget(book)?;
            ctx.note(format!("formatted {range}"));
            Ok(())
        }
        "set_column_widths" => {
            let input: SetColumnWidths = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let sheet = &mut book.sheets[index];
            for (key, width) in &input.widths {
                if !(0.0..=255.0).contains(width) {
                    return Err(OfficeError::invalid(format!(
                        "column width for `{key}` must be 0..=255 characters"
                    )));
                }
                let (first, last) = match key.split_once(':') {
                    Some((a, b)) => (parse_column(a)?, parse_column(b)?),
                    None => {
                        let column = parse_column(key)?;
                        (column, column)
                    }
                };
                for column in first.min(last)..=first.max(last) {
                    sheet.column_widths.insert(column, *width);
                }
            }
            ctx.note("set column widths".to_string());
            Ok(())
        }
        "set_row_heights" => {
            let input: SetRowHeights = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let sheet = &mut book.sheets[index];
            for (key, height) in &input.heights {
                if !(0.0..=409.0).contains(height) {
                    return Err(OfficeError::invalid(format!(
                        "row height for `{key}` must be 0..=409 points"
                    )));
                }
                let parse = |text: &str| -> OfficeResult<u32> {
                    let row: u32 = text
                        .trim()
                        .parse()
                        .map_err(|_| OfficeError::invalid(format!("invalid row `{text}`")))?;
                    check_index(row, MAX_ROWS, "row")?;
                    Ok(row)
                };
                let (first, last) = match key.split_once(':') {
                    Some((a, b)) => (parse(a)?, parse(b)?),
                    None => (parse(key)?, parse(key)?),
                };
                if last.max(first) - first.min(last) > 100_000 {
                    return Err(OfficeError::limit(
                        "set_row_heights spans at most 100000 rows per entry",
                    ));
                }
                for row in first.min(last)..=first.max(last) {
                    sheet.row_heights.insert(row, *height);
                }
            }
            ctx.note("set row heights".to_string());
            Ok(())
        }
        "merge_cells" => {
            let input: RangeOnly = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let range = parse_range(&input.range)?;
            if range.is_single() {
                return Err(OfficeError::invalid(
                    "merge_cells needs a range of at least two cells",
                ));
            }
            let sheet = &mut book.sheets[index];
            if let Some(existing) = sheet
                .merges
                .iter()
                .filter_map(|merge| parse_range(merge).ok())
                .find(|other| other.intersects(&range))
            {
                return Err(OfficeError::invalid(format!(
                    "{range} overlaps the merged range {existing}; unmerge it first"
                )));
            }
            sheet.merges.push(range.to_string());
            ctx.note(format!("merged {range}"));
            Ok(())
        }
        "unmerge_cells" => {
            let input: RangeOnly = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            let range = parse_range(&input.range)?;
            let sheet = &mut book.sheets[index];
            let before = sheet.merges.len();
            sheet.merges.retain(|merge| {
                parse_range(merge)
                    .map(|other| !other.intersects(&range))
                    .unwrap_or(false)
            });
            let removed = before - sheet.merges.len();
            if removed == 0 {
                ctx.warn(format!("unmerge_cells: no merged range intersects {range}"));
            }
            ctx.note(format!("unmerged {removed} range(s)"));
            Ok(())
        }
        "freeze_panes" => {
            let input: FreezePanes = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            if input.rows > 1000 || input.columns > 100 {
                return Err(OfficeError::invalid(
                    "freeze at most 1000 rows and 100 columns",
                ));
            }
            book.sheets[index].freeze = (input.rows > 0 || input.columns > 0).then_some(Freeze {
                rows: input.rows,
                columns: input.columns,
            });
            ctx.note(format!(
                "froze {} row(s) and {} column(s)",
                input.rows, input.columns
            ));
            Ok(())
        }
        "set_autofilter" => {
            let input: SetAutofilter = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            book.sheets[index].autofilter = match &input.range {
                Some(range) => Some(parse_range(range)?.to_string()),
                None => None,
            };
            ctx.note("updated the auto filter".to_string());
            Ok(())
        }
        "set_sheet" => {
            let input: SetSheet = parse_operation(value)?;
            let index = resolve_sheet(book, input.sheet.as_ref())?;
            if let Some(color) = &input.tab_color {
                if color.is_empty() {
                    book.sheets[index].tab_color = None;
                } else {
                    parse_color(color)?;
                    book.sheets[index].tab_color = Some(color.clone());
                }
            }
            ctx.note("updated sheet settings".to_string());
            Ok(())
        }
        "set_properties" => {
            let input: DocumentProperties = parse_operation(value)?;
            book.properties.merge(&input);
            ctx.note("updated document properties".to_string());
            Ok(())
        }
        other => Err(unknown_operation(other, OPERATIONS)),
    }
}

fn check_index(value: u32, max: u32, unit: &str) -> OfficeResult<()> {
    if value == 0 || value > max {
        return Err(OfficeError::out_of_range(format!(
            "{unit} {value} is outside 1..={max}"
        )));
    }
    Ok(())
}

fn ensure_cell_budget(book: &XlsxDocument) -> OfficeResult<()> {
    let total: usize = book.sheets.iter().map(|sheet| sheet.cells.len()).sum();
    if total > MAX_CELLS {
        return Err(OfficeError::limit(format!(
            "a workbook is limited to {MAX_CELLS} stored cells"
        )));
    }
    Ok(())
}

/// Finds the target sheet by name or zero-based index; optional when the
/// workbook has exactly one sheet.
fn resolve_sheet(book: &XlsxDocument, selector: Option<&Value>) -> OfficeResult<usize> {
    let names = || {
        book.sheets
            .iter()
            .map(|sheet| format!("`{}`", sheet.name))
            .collect::<Vec<_>>()
            .join(", ")
    };
    match selector {
        None | Some(Value::Null) => {
            if book.sheets.len() == 1 {
                Ok(0)
            } else if book.sheets.is_empty() {
                Err(OfficeError::not_found(
                    "the workbook has no sheets yet; add one with add_sheet",
                ))
            } else {
                Err(OfficeError::invalid(format!(
                    "`sheet` is required when the workbook has several sheets: {}",
                    names()
                )))
            }
        }
        Some(Value::String(name)) => book.sheet_index(name).ok_or_else(|| {
            let candidates: Vec<&str> = book
                .sheets
                .iter()
                .map(|sheet| sheet.name.as_str())
                .collect();
            let hint = crate::common::did_you_mean(name, &candidates)
                .map(|guess| format!(" Did you mean `{guess}`?"))
                .unwrap_or_default();
            OfficeError::not_found(format!(
                "no sheet named `{name}`.{hint} Sheets: {}",
                names()
            ))
        }),
        Some(Value::Number(number)) => {
            let index = number
                .as_u64()
                .ok_or_else(|| OfficeError::invalid("sheet index must be a non-negative integer"))?
                as usize;
            if index < book.sheets.len() {
                Ok(index)
            } else {
                Err(OfficeError::out_of_range(format!(
                    "sheet index {index} is out of range; sheets: {}",
                    names()
                )))
            }
        }
        Some(_) => Err(OfficeError::invalid(
            "`sheet` must be a sheet name or a zero-based index",
        )),
    }
}

/// Writes a 2-D block of cell inputs; `null` leaves a cell unchanged.
fn write_rows(sheet: &mut Sheet, start: CellRef, rows: &[Vec<Value>]) -> OfficeResult<usize> {
    let mut written = 0;
    for (row_offset, row) in rows.iter().enumerate() {
        let row_number = start.row as u64 + row_offset as u64;
        if row_number > MAX_ROWS as u64 {
            return Err(OfficeError::out_of_range(format!(
                "data runs past row {MAX_ROWS}"
            )));
        }
        for (col_offset, input) in row.iter().enumerate() {
            let col_number = start.col as u64 + col_offset as u64;
            if col_number > MAX_COLUMNS as u64 {
                return Err(OfficeError::out_of_range(format!(
                    "data runs past column {}",
                    column_letters(MAX_COLUMNS)
                )));
            }
            let address = CellRef::new(row_number as u32, col_number as u32);
            let path = address.to_string();
            let Some(update) = parse_cell_input(input, &path)? else {
                continue;
            };
            let cell = sheet.cells.entry(address).or_default();
            cell.value = update.value;
            cell.formula = update.formula;
            if let Some(style) = update.style {
                let mut merged = cell.style.take().unwrap_or_default();
                merged.merge(&style);
                cell.style = (!merged.is_default()).then_some(merged);
            }
            if cell.is_empty() {
                sheet.cells.remove(&address);
            }
            written += 1;
        }
    }
    Ok(written)
}

struct CellUpdate {
    value: Value,
    formula: Option<String>,
    style: Option<CellStyle>,
}

fn parse_cell_input(input: &Value, path: &str) -> OfficeResult<Option<CellUpdate>> {
    let simple = |value: Value, formula: Option<String>| {
        Ok(Some(CellUpdate {
            value,
            formula,
            style: None,
        }))
    };
    match input {
        Value::Null => Ok(None),
        Value::Bool(_) | Value::Number(_) => simple(input.clone(), None),
        Value::String(text) => {
            if let Some(formula) = text
                .strip_prefix('=')
                .filter(|rest| !rest.trim().is_empty())
            {
                check_formula(formula, path)?;
                simple(Value::Null, Some(formula.to_string()))
            } else {
                simple(Value::String(text.clone()), None)
            }
        }
        Value::Object(object) => parse_cell_object(object, path).map(Some),
        Value::Array(_) => Err(OfficeError::invalid(format!(
            "{path}: a cell cannot be an array; rows are arrays of cell values"
        ))),
    }
}

fn parse_cell_object(object: &Map<String, Value>, path: &str) -> OfficeResult<CellUpdate> {
    for key in object.keys() {
        if !matches!(key.as_str(), "value" | "formula" | "type" | "style") {
            return Err(OfficeError::invalid(format!(
                "{path}: unknown cell field `{key}`; cells accept value, formula, type, style"
            )));
        }
    }
    let style = match object.get("style") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let style: CellStyle = serde_json::from_value(value.clone())
                .map_err(|err| OfficeError::invalid(format!("{path}.style: {err}")))?;
            let mut unknown = Vec::new();
            style.unknown_fields(&format!("{path}.style"), &mut unknown);
            if !unknown.is_empty() {
                return Err(OfficeError::invalid(format!(
                    "unknown field(s): {}",
                    unknown.join(", ")
                )));
            }
            style.validate(&format!("{path}.style"))?;
            Some(style)
        }
    };
    let kind = object.get("type").and_then(Value::as_str);
    let raw = object.get("value").cloned().unwrap_or(Value::Null);
    if let Some(formula) = object.get("formula").and_then(Value::as_str) {
        let formula = formula.strip_prefix('=').unwrap_or(formula);
        check_formula(formula, path)?;
        return Ok(CellUpdate {
            value: Value::Null,
            formula: Some(formula.to_string()),
            style,
        });
    }
    let (value, formula, style) = match kind {
        None => match &raw {
            Value::String(text) if text.starts_with('=') && text.len() > 1 => {
                check_formula(&text[1..], path)?;
                (Value::Null, Some(text[1..].to_string()), style)
            }
            Value::Array(_) | Value::Object(_) => {
                return Err(OfficeError::invalid(format!(
                    "{path}.value must be a string, number, or boolean"
                )))
            }
            _ => (raw, None, style),
        },
        Some("text" | "string") => (
            match raw {
                Value::Null => Value::Null,
                Value::String(text) => Value::String(text),
                other => Value::String(other.to_string()),
            },
            None,
            style,
        ),
        Some("number") => {
            let number = match &raw {
                Value::Number(_) => raw.clone(),
                Value::String(text) => text
                    .trim()
                    .replace(',', "")
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .ok_or_else(|| {
                        OfficeError::invalid(format!("{path}: `{text}` is not a number"))
                    })?,
                _ => {
                    return Err(OfficeError::invalid(format!(
                        "{path}: type number needs a numeric value"
                    )))
                }
            };
            (number, None, style)
        }
        Some("boolean" | "bool") => match raw {
            Value::Bool(_) => (raw, None, style),
            _ => {
                return Err(OfficeError::invalid(format!(
                    "{path}: type boolean needs true or false"
                )))
            }
        },
        Some("date" | "datetime") => {
            let text = raw.as_str().ok_or_else(|| {
                OfficeError::invalid(format!(
                    "{path}: type date needs a string such as 2024-03-31"
                ))
            })?;
            let (serial, has_time) = date_serial(text).ok_or_else(|| {
                OfficeError::invalid(format!(
                    "{path}: `{text}` is not YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS]"
                ))
            })?;
            let mut style = style.unwrap_or_default();
            if style.number_format.is_none() {
                style.number_format = Some(
                    if has_time {
                        "yyyy-mm-dd hh:mm"
                    } else {
                        "yyyy-mm-dd"
                    }
                    .to_string(),
                );
            }
            let number = serde_json::Number::from_f64(serial)
                .map(Value::Number)
                .ok_or_else(|| OfficeError::invalid(format!("{path}: invalid date")))?;
            (number, None, Some(style))
        }
        Some(other) => {
            return Err(OfficeError::invalid(format!(
                "{path}: unknown cell type `{other}`; use text, number, boolean, or date"
            )))
        }
    };
    Ok(CellUpdate {
        value,
        formula,
        style,
    })
}

/// Catches the most common formula slips before Excel reports a repair.
fn check_formula(formula: &str, path: &str) -> OfficeResult<()> {
    let mut depth: i64 = 0;
    let mut in_string = false;
    for character in formula.chars() {
        match character {
            '"' => in_string = !in_string,
            '(' if !in_string => depth += 1,
            ')' if !in_string => {
                depth -= 1;
                if depth < 0 {
                    break;
                }
            }
            _ => {}
        }
    }
    if in_string {
        return Err(OfficeError::invalid(format!(
            "{path}: formula `={formula}` has an unterminated string"
        )));
    }
    if depth != 0 {
        return Err(OfficeError::invalid(format!(
            "{path}: formula `={formula}` has unbalanced parentheses"
        )));
    }
    if formula.len() > 8192 {
        return Err(OfficeError::invalid(format!(
            "{path}: formulas are limited to 8192 characters"
        )));
    }
    Ok(())
}

/// Excel serial date (1900 system) for `YYYY-MM-DD[ HH:MM[:SS]]`.
fn date_serial(text: &str) -> Option<(f64, bool)> {
    let text = text.trim();
    let (date, time) = match text.split_once([' ', 'T']) {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some()
        || !(1900..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let days = days_from_civil(year, month, day) - days_from_civil(1899, 12, 30);
    let mut fraction = 0.0;
    if let Some(time) = time {
        let mut pieces = time.trim_end_matches('Z').split(':');
        let hours: f64 = pieces.next()?.parse().ok()?;
        let minutes: f64 = pieces.next().unwrap_or("0").parse().ok()?;
        let seconds: f64 = pieces.next().unwrap_or("0").parse().ok()?;
        if !(0.0..24.0).contains(&hours)
            || !(0.0..60.0).contains(&minutes)
            || !(0.0..61.0).contains(&seconds)
        {
            return None;
        }
        fraction = (hours * 3600.0 + minutes * 60.0 + seconds) / 86400.0;
    }
    Some((days as f64 + fraction, time.is_some()))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inserts or deletes rows/columns on one sheet and rewrites every
/// reference to it across the workbook.
fn shift_sheet(
    book: &mut XlsxDocument,
    index: usize,
    axis: Axis,
    at: u32,
    delta: i64,
) -> OfficeResult<()> {
    let limit = match axis {
        Axis::Row => MAX_ROWS,
        Axis::Column => MAX_COLUMNS,
    };
    check_index(at, limit, if axis == Axis::Row { "row" } else { "column" })?;
    if delta < 0 && at as i64 - delta - 1 > limit as i64 {
        return Err(OfficeError::out_of_range(
            "the deleted span runs past the sheet edge",
        ));
    }
    let shift = Shift {
        sheet: book.sheets[index].name.clone(),
        axis,
        at,
        delta,
    };
    let coordinate = |cell: &CellRef| match axis {
        Axis::Row => cell.row,
        Axis::Column => cell.col,
    };
    let moved = |value: u32| -> Option<u32> {
        if delta >= 0 {
            if value >= at {
                let shifted = value as i64 + delta;
                return (shifted <= limit as i64).then_some(shifted as u32);
            }
            return Some(value);
        }
        let count = (-delta) as u32;
        if value < at {
            Some(value)
        } else if value >= at + count {
            Some(value - count)
        } else {
            None
        }
    };

    let sheet = &mut book.sheets[index];
    if delta > 0 {
        let overflow = sheet
            .cells
            .keys()
            .any(|cell| coordinate(cell) >= at && coordinate(cell) as i64 + delta > limit as i64);
        if overflow {
            return Err(OfficeError::out_of_range(
                "inserting would push cells past the sheet edge",
            ));
        }
    }
    let cells = std::mem::take(&mut sheet.cells);
    for (cell, value) in cells {
        let Some(new) = moved(coordinate(&cell)) else {
            continue;
        };
        let key = match axis {
            Axis::Row => CellRef::new(new, cell.col),
            Axis::Column => CellRef::new(cell.row, new),
        };
        sheet.cells.insert(key, value);
    }
    let remap = |map: &mut BTreeMap<u32, f64>| {
        let old = std::mem::take(map);
        for (key, value) in old {
            if let Some(new) = moved(key) {
                map.insert(new, value);
            }
        }
    };
    match axis {
        Axis::Row => remap(&mut sheet.row_heights),
        Axis::Column => remap(&mut sheet.column_widths),
    }
    let sheet_name = sheet.name.clone();
    let shift_range = |text: &str| -> Option<String> {
        let shifted = shift_formula(text, &sheet_name, &shift);
        (!shifted.contains("#REF!")).then_some(shifted)
    };
    sheet.merges = sheet
        .merges
        .iter()
        .filter_map(|merge| shift_range(merge))
        .filter(|merge| {
            parse_range(merge)
                .map(|range: CellRange| !range.is_single())
                .unwrap_or(false)
        })
        .collect();
    sheet.autofilter = sheet.autofilter.as_deref().and_then(shift_range);

    for other in &mut book.sheets {
        let host = other.name.clone();
        for cell in other.cells.values_mut() {
            if let Some(formula) = &mut cell.formula {
                *formula = shift_formula(formula, &host, &shift);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_serials_match_excel() {
        assert_eq!(date_serial("1900-03-01"), Some((61.0, false)));
        assert_eq!(date_serial("2024-01-01"), Some((45292.0, false)));
        let (serial, has_time) = date_serial("2024-01-01 12:00").unwrap();
        assert!(has_time);
        assert!((serial - 45292.5).abs() < 1e-9);
        assert_eq!(date_serial("2024-13-01"), None);
    }

    #[test]
    fn formula_check_catches_unbalanced_input() {
        assert!(check_formula("SUM(A1:A3", "A4").is_err());
        assert!(check_formula("\"(\"&A1", "A4").is_ok());
    }
}
