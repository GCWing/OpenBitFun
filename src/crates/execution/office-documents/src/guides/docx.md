# GenOfficeFile — Word (.docx)

A Word document is an ordered list of **blocks** (0-based indexes) plus document settings. Build it over several `edit` calls: write the skeleton first, then insert sections one or a few at a time. `read` pages over blocks with `offset`/`limit` and returns the heading outline, so you can find where to insert next.

File generation does not require an Office installation. `read` inspects the stored model, not rendered pages.

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
| `toc` | `title`, `levels` (default 3). Lists headings; Word computes page numbers. Refresh the field after pagination if needed |

**Run** fields: `text`, `math` (`inline` or `display`, treats `text` as LaTeX math), `bold`, `italic`, `underline`, `strike`, `code`, `superscript`, `subscript`, `color` (`#RRGGBB`), `highlight` (`#RRGGBB`), `size_pt`, `font`, `latin_font`, `east_asia_font`, `complex_script_font`, `lang` (optional BCP 47 language, e.g. `zh-CN`), `link` (http/https/mailto URL).

### Markdown

`insert_blocks` and `replace_blocks` accept `markdown` instead of `blocks`. Supported: headings, paragraphs with `**bold**` / `*italic*` / `~~strike~~` / `` `code` `` / `[links](https://…)`, bullet / numbered / nested / task lists, GFM tables (with column alignment), fenced code, block quotes, `---` rules, images `![alt](/abs/path.png)`, `[TOC]` on its own line, and `<!-- pagebreak -->`. Math uses `$...$` inline and `$$...$$` on its own line for display.

### Papers and equations

Use heading levels, `[TOC]`, paragraph spacing/indents, page breaks, tables/captions, and page fields for papers. Agent-readable `.tex` content can be expressed with these blocks and Markdown; the tool does not compile an entire TeX document or execute its macros/files. Citation markers and bibliography entries can be authored as ordinary text; automatic citation databases, cross-reference numbering and footnotes are not supported. Do not claim journal-template compliance without checking its actual requirements.

LaTeX math is written as native editable Word equations. Supported structures include fractions, roots, subscripts/superscripts, sums, integrals, Greek symbols, accents and rectangular matrices. Explicit input: `{"type":"paragraph","runs":[{"text":"E=mc^2","math":"display"}]}`. A display equation must be the only run in its paragraph or cell. Math text has no dollar delimiters in explicit runs; JSON backslashes must be escaped (`"\\frac{1}{2}"`). Code blocks retain literal TeX.

Unsupported syntax/structures fail the whole batch with an actionable error; simplify that expression or explicitly show its source as code if that satisfies the user. No TeX/Office installation or external conversion is needed. `read` retains the original math source; `replace_blocks` edits equations in place. `replace_text` skips equations and never matches across them. Legacy readers retain the math fields and can show the stored source text.

## Operations

| op | fields | effect |
|---|---|---|
| `insert_blocks` | `index` (insert before; omit to append), `blocks` or `markdown` | adds blocks |
| `replace_blocks` | `index`, `count` (default 1), `blocks` or `markdown` | replaces `count` blocks with the new ones (any number) |
| `delete_blocks` | `index`, `count` (default 1) | removes blocks |
| `move_blocks` | `index`, `count` (default 1), `to` | moves blocks; `to` is the position in the list after they are removed |
| `replace_text` | `find`, `replace`, `match_case` (default true), `include_headers_footers` (default false) | replaces body text, including text split across formatted runs; replacement inherits the first matched run’s format. Matches never cross paragraphs, list items or table cells. `include_headers_footers: true` also updates header/footer text |
| `set_page_setup` | `size` (`a4` `letter` `legal` `a3` `a5`), `orientation` (`portrait` `landscape`), `margins_cm` `{top,bottom,left,right}` | partial update |
| `set_styles` | `lang` (BCP 47, optional), `font`, `east_asia_font`, `complex_script_font`, `font_size_pt`, `heading_font`, `heading_color`, `text_color`, `line_spacing`, `paragraph_space_after_pt`, `table_header_fill` | partial update of document-wide styles |
| `set_header_footer` | `header`, `footer`: a string, `{text, align}`, or `null` to remove. `{PAGE}` and `{NUMPAGES}` become page fields | |
| `set_properties` | `title`, `subject`, `author`, `keywords`, `description`, `category` | document metadata |

Indexes inside one batch are live: after inserting two blocks at index 3, the old block 3 is block 5 for the next operation in the same batch. A batch is atomic — if any operation fails, nothing is written and the error names the operation.

Prefer `replace_blocks` for content corrections instead of insert/delete/move sequences. After failure, correct the named field/index; read the current target if uncertain. Do not repeat unchanged failed input or replay successful batches.

## Settings at create

`settings` may carry `page`, `styles`, `header`, `footer`, `properties` (same fields as above). CJK run languages follow their text unless overridden by run `lang` or `styles.lang`. Use the style defaults unless document requirements call for specific fonts; `styles.east_asia_font` sets the East Asian font. Font availability and substitution depend on the viewing environment, which may differ from the generation environment.

### Font scope and recovery

- `styles.font` and `styles.heading_font` select Latin and complex-script fonts; `styles.complex_script_font` can override the latter; `styles.east_asia_font` selects the East Asian font. With no font overrides, the engine uses Calibri for Latin text and leaves East Asian selection to the viewer.
- `run.font` retains its all-script shorthand meaning. Run `latin_font`, `east_asia_font`, and `complex_script_font` override only their script and take precedence over `run.font`; unset scripts inherit document styles. Use `latin_font` for a Latin-only change in a mixed-language run. These fields work in paragraphs, headings, lists and table-cell runs. Equation fonts are selected by the native equation renderer.
- Remove global overrides with `{"op":"set_styles","font":null,"heading_font":null,"east_asia_font":null,"complex_script_font":null}`. This preserves text, sizes and other styles. Existing local run overrides still win; replace the affected block with the same content and those font fields omitted to restore inheritance.
- `lang` does not select a font. Run language overrides `styles.lang`; otherwise CJK language follows the text. Set `zh-TW`, `ja-JP`, etc. explicitly when Han-only text is ambiguous.

Example of a required Latin-only override: `{"type":"paragraph","runs":[{"text":"Report 中文 日本語 한국어","latin_font":"Arial"}]}`. Omit `latin_font` too when no particular family is required.

## Example

```json
{"action": "create", "file_path": "/abs/report.docx",
 "settings": {"styles": {"font_size_pt": 11}},
 "operations": [
   {"op": "set_properties", "title": "Q3 Report"},
   {"op": "insert_blocks", "markdown": "# Q3 Report\n\n[TOC]\n\n## Summary\n\nRevenue grew **23%**."},
   {"op": "set_header_footer", "footer": "Page {PAGE} of {NUMPAGES}"}
 ]}
```

Then append sections with `{"action": "edit", "file_path": "/abs/report.docx", "operations": [{"op": "insert_blocks", "markdown": "## Details\n\n..."}]}`.
