# GenOfficeFile — Excel (.xlsx)

A workbook is a list of **sheets**; each sheet holds sparse cells addressed A1-style. Add data in chunks (`append_rows` is the natural way to page a large table across calls), then format. `read` without `sheet` lists the sheets; with `sheet` it pages over rows (`offset`/`limit`, default 100 rows) or reads an A1 `range`.

Range reads also honor `offset`/`limit` (at most 500 rows per call); pass the same range and the returned `next_offset` to continue. `detail: "full"` preserves complete cell text; outline reads shorten long text.

Pass ordinary Unicode text; do not manually transcode or pre-escape XML. The tool writes UTF-8. Use `style.font_name` for a font available in the target viewer; fonts are not embedded. File generation does not require an Office installation, and `read` is not a rendered workbook preview.

## Cell values

Rows are arrays of cell values:

- number or boolean → stored as such
- string → text; a string starting with `=` is a formula (`"=SUM(B2:B9)"`)
- `null` → leave that cell unchanged (skip)
- object → `{"value": …, "formula": "…", "type": "text" | "number" | "boolean" | "date", "style": {…}}`. `type: "text"` keeps a leading `=` literal; `type: "date"` turns `"2024-03-31"` or `"2024-03-31 09:30"` into a real date with a date format.

Formula results are computed and cached for arithmetic, comparisons, `&`, cell and range references (including other sheets), and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, PRODUCT, ROUND, ROUNDUP, ROUNDDOWN, ABS, IF, IFERROR, AND, OR, NOT, CONCAT(ENATE), LEN, UPPER, LOWER, TRIM, so `read` and simple viewers show values. Other functions are stored without a cached value and listed in warnings. The target spreadsheet application must support and recalculate them; this is not a request to install or run an external converter. Write numbers as numbers (not `"1,200"`) so formulas and number formats work.

A style-only cell object preserves its existing value/formula. Use `{"value": null}` or `clear_range` to clear content; a bare `null` skips it.

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
| `add_chart` | `sheet`, `chart` | append a native editable chart |
| `replace_chart` | `sheet`, `index`, `chart` | replace the 0-based chart at `index` |
| `delete_chart` | `sheet`, `index` | remove a chart |
| `set_properties` | `title`, `subject`, `author`, `keywords`, `description`, `category` | |

Operations run in order and each sees the previous result: after `insert_rows`, later operations in the same batch address the shifted grid. A batch is atomic.

Prefer `set_cells`/`format_range` for corrections instead of deleting/recreating sheets or rows. After failure, correct the named field/range; read the current sheet if uncertain. Do not repeat unchanged failed input or replay successful batches.

## Native charts

`chart` takes `type` (`column`, `bar`, `line`, `pie`), `anchor` (top-left cell, e.g. `F2`), optional `title`, `width_px`/`height_px` (default 640/360), `legend` (default true), and `series`. Each series takes optional `name`/`color` and two references: `categories: {sheet?, range}` and `values: {sheet?, range}`. An omitted source sheet means the chart’s sheet. References must be equally sized single rows/columns, up to 32000 points; a pie chart takes one series. Values should be numeric, categories labels; blank/non-numeric values are gaps. Unknown formula results have no cached chart points until recalculation.

```json
{"op":"add_chart","sheet":"Sales","chart":{"type":"column","anchor":"F2","title":"Revenue","series":[{"name":"Total","categories":{"range":"A2:A3"},"values":{"range":"D2:D3"}}]}}
```

`read` lists chart counts and returns configurations with the selected sheet. Range references and caches are rebuilt after edits; references follow sheet renames and row/column shifts. Deleting a source marks it `#REF!` and returns a warning; repair it with `replace_chart`. Charts remain editable in Office. Pivot charts, combination charts and conditional formatting are not currently supported; do not invent operations or claim those features were generated.

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
