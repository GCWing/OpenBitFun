# GenOfficeFile — Excel (.xlsx)

A workbook is a list of **sheets**; each sheet holds sparse cells addressed A1-style. Add data in chunks (`append_rows` is the natural way to page a large table across calls), then format. `read` without `sheet` lists the sheets; with `sheet` it pages over rows (`offset`/`limit`, default 100 rows) or reads an A1 `range`.

Range reads also honor `offset`/`limit` (at most 500 rows per call); pass the same range and the returned `next_offset` to continue. `detail: "full"` preserves complete cell text; outline reads shorten long text.

## Cell values

Rows are arrays of cell values:

- number or boolean → stored as such
- string → text; a string starting with `=` is a formula (`"=SUM(B2:B9)"`)
- `null` → leave that cell unchanged (skip)
- object → `{"value": …, "formula": "…", "type": "text" | "number" | "boolean" | "date", "style": {…}}`. `type: "text"` keeps a leading `=` literal; `type: "date"` turns `"2024-03-31"` or `"2024-03-31 09:30"` into a real date with a date format.

Formula results are computed and cached for arithmetic, comparisons, `&`, cell and range references (including other sheets), and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, PRODUCT, ROUND, ROUNDUP, ROUNDDOWN, ABS, IF, IFERROR, AND, OR, NOT, CONCAT(ENATE), LEN, UPPER, LOWER, TRIM, so `read` and simple viewers show values. Other functions (VLOOKUP, SUMIF, FILTER, …) are stored without a cached value; Excel, WPS and LibreOffice compute every formula when the file opens, and the tool lists the uncached cells. Write numbers as numbers (not `"1,200"`) so formulas and number formats work.

## Styles

`style` objects (in `format_range` or a cell object) take: `bold`, `italic`, `underline`, `strike`, `font_color`, `font_size`, `font_name`, `fill_color`, `number_format` (`"#,##0.00"`, `"0.0%"`, `"yyyy-mm-dd"`, `"¥#,##0"` …), `align` (`left` `center` `right` `justify` `general`), `valign` (`top` `center` `bottom`), `wrap`, `indent`, `border` (`thin` `medium` `thick` `dashed` `dotted` `double` `none`), `border_color`. Colors are `#RRGGBB`. Formatting merges into a cell's existing style.

## Operations

`sheet` is a sheet name (or 0-based index); it may be omitted when the workbook has exactly one sheet. Rows and columns are 1-based in `row`, letters in `column`.

| op | fields | effect |
|---|---|---|
| `add_sheet` | `name`, `index`, `rows`, `start` (default `A1`) | new sheet, optionally with data |
| `delete_sheet` | `sheet` | |
| `rename_sheet` | `sheet`, `name` | formulas that reference the sheet are updated |
| `move_sheet` | `sheet`, `to` | reorder tabs |
| `set_cells` | `sheet`, `start` (default `A1`), `rows` | writes a 2-D block anchored at `start` |
| `append_rows` | `sheet`, `rows`, `column` (default `A`) | writes below the last used row |
| `insert_rows` | `sheet`, `row`, `count`, `rows` | inserts empty rows before `row` (optionally filled); references below shift |
| `delete_rows` | `sheet`, `row`, `count` | references shift; references to deleted cells become `#REF!` |
| `insert_columns` / `delete_columns` | `sheet`, `column`, `count` | same for columns |
| `clear_range` | `sheet`, `range`, `what` (`all` `contents` `formats`) | |
| `format_range` | `sheet`, `range`, `style` | |
| `set_column_widths` | `sheet`, `widths` `{ "A": 18, "B:D": 12 }` (characters; 0 hides) | |
| `set_row_heights` | `sheet`, `heights` `{ "1": 28, "2:10": 18 }` (points; 0 hides) | |
| `merge_cells` / `unmerge_cells` | `sheet`, `range` | |
| `freeze_panes` | `sheet`, `rows`, `columns` (0, 0 removes) | |
| `set_autofilter` | `sheet`, `range` (`null` removes) | |
| `set_sheet` | `sheet`, `tab_color` | |
| `set_properties` | `title`, `subject`, `author`, `keywords`, `description`, `category` | |

Operations run in order and each sees the previous result: after `insert_rows`, later operations in the same batch address the shifted grid. A batch is atomic.

## Example

```json
{"action": "create", "file_path": "/abs/sales.xlsx", "operations": [
  {"op": "add_sheet", "name": "Sales", "rows": [["Item", "Qty", "Price", "Total"], ["Apple", 2, 1.5, "=B2*C2"]]},
  {"op": "append_rows", "sheet": "Sales", "rows": [["Pear", 3, 2, "=B3*C3"], ["Total", "=SUM(B2:B3)", null, "=SUM(D2:D3)"]]},
  {"op": "format_range", "sheet": "Sales", "range": "A1:D1", "style": {"bold": true, "fill_color": "#1F4E79", "font_color": "#FFFFFF"}},
  {"op": "format_range", "sheet": "Sales", "range": "C2:D4", "style": {"number_format": "#,##0.00"}},
  {"op": "set_column_widths", "sheet": "Sales", "widths": {"A": 16, "B:D": 12}},
  {"op": "freeze_panes", "sheet": "Sales", "rows": 1}
]}
```
