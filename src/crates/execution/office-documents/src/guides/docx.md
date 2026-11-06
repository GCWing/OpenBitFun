# GenOfficeFile — Word (.docx)

A Word document is an ordered list of **blocks** (0-based indexes) plus document settings. Build it over several `edit` calls: write the skeleton first, then insert sections one or a few at a time. `read` pages over blocks with `offset`/`limit` and returns the heading outline, so you can find where to insert next.

## Blocks

Every block is an object with `type`. Text fields take either `text` (plain string) or `runs` (formatted spans). Inside text, `\n` is a line break.

| type | fields |
|---|---|
| `heading` | `level` 1–6, `text`/`runs`, `align` |
| `paragraph` | `text`/`runs`, `style` (`normal` `title` `subtitle` `caption`), `align` (`left` `center` `right` `justify`), `indent_cm`, `first_line_indent_cm` (negative = hanging), `space_before_pt`, `space_after_pt`, `line_spacing` (multiple, e.g. 1.5) |
| `list` | `ordered` (bool), `start`, `items`: strings or `{text/runs, level}` (level 0–8 nests) |
| `table` | `rows`: array of rows; a cell is a string/number or `{text/runs, bold, color, fill, align, colspan}`; `header_rows` (default 1), `column_widths_cm`, `borders` (default true), `font_size_pt`, `caption` |
| `image` | `src` (absolute local path or data URL; PNG/JPEG/GIF/BMP), `width_cm` and/or `height_cm` (aspect kept when one is given; default = natural size capped at the text width), `align`, `caption`, `alt`. After embedding, `read` shows `asset`; pass `asset` instead of `src` to reuse an embedded picture |
| `code` | `text`, `language` |
| `quote` | `text`/`runs` |
| `page_break` | — |
| `horizontal_rule` | — |
| `toc` | `title`, `levels` (default 3). Lists the headings; Word refreshes page numbers on open |

**Run** fields: `text`, `bold`, `italic`, `underline`, `strike`, `code`, `superscript`, `subscript`, `color` (`#RRGGBB`), `highlight` (`#RRGGBB`), `size_pt`, `font`, `link` (http/https/mailto URL).

### Markdown

`insert_blocks` and `replace_blocks` accept `markdown` instead of `blocks`. Supported: headings, paragraphs with `**bold**` / `*italic*` / `~~strike~~` / `` `code` `` / `[links](https://…)`, bullet / numbered / nested / task lists, GFM tables (with column alignment), fenced code, block quotes, `---` rules, images `![alt](/abs/path.png)`, `[TOC]` on its own line, and `<!-- pagebreak -->`.

## Operations

| op | fields | effect |
|---|---|---|
| `insert_blocks` | `index` (insert before; omit to append), `blocks` or `markdown` | adds blocks |
| `replace_blocks` | `index`, `count` (default 1), `blocks` or `markdown` | replaces `count` blocks with the new ones (any number) |
| `delete_blocks` | `index`, `count` (default 1) | removes blocks |
| `move_blocks` | `index`, `count` (default 1), `to` | moves blocks; `to` is the position in the list after they are removed |
| `replace_text` | `find`, `replace`, `match_case` (default true) | replaces inside every run (text split across differently formatted runs is not matched) |
| `set_page_setup` | `size` (`a4` `letter` `legal` `a3` `a5`), `orientation` (`portrait` `landscape`), `margins_cm` `{top,bottom,left,right}` | partial update |
| `set_styles` | `font`, `east_asia_font`, `font_size_pt`, `heading_font`, `heading_color`, `text_color`, `line_spacing`, `paragraph_space_after_pt`, `table_header_fill` | partial update of document-wide styles |
| `set_header_footer` | `header`, `footer`: a string, `{text, align}`, or `null` to remove. `{PAGE}` and `{NUMPAGES}` become page fields | |
| `set_properties` | `title`, `subject`, `author`, `keywords`, `description`, `category` | document metadata |

Indexes inside one batch are live: after inserting two blocks at index 3, the old block 3 is block 5 for the next operation in the same batch. A batch is atomic — if any operation fails, nothing is written and the error names the operation.

## Settings at create

`settings` may carry `page`, `styles`, `header`, `footer`, `properties` (same fields as above). For Chinese documents set `styles.east_asia_font` (for example `Microsoft YaHei`, `SimSun`, `PingFang SC`).

## Example

```json
{"action": "create", "file_path": "/abs/report.docx",
 "settings": {"styles": {"east_asia_font": "Microsoft YaHei"}},
 "operations": [
   {"op": "set_properties", "title": "Q3 Report"},
   {"op": "insert_blocks", "markdown": "# Q3 Report\n\n[TOC]\n\n## Summary\n\nRevenue grew **23%**."},
   {"op": "set_header_footer", "footer": "Page {PAGE} of {NUMPAGES}"}
 ]}
```

Then append sections with `{"action": "edit", "file_path": "/abs/report.docx", "operations": [{"op": "insert_blocks", "markdown": "## Details\n\n..."}]}`.
