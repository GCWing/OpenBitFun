# GenOfficeFile — PowerPoint (.pptx)

A deck is a list of **slides** (0-based). Each slide is a fixed canvas — **1280 × 720 px** for `16:9` (default) or 960 × 720 for `4:3` — with absolutely positioned elements: origin top-left, `x` `y` `w` `h` in px, painted in array order (first = bottom). Build one slide (or a few) per `edit` call; `read` pages over slides, and `detail: "full"` returns a slide's elements with their indexes for targeted edits.

## Editing workflow

- Append new pages with `insert_slides`. To rewrite a page, use `replace_slide` with **both `index` and `slide`**; no insert/delete/move sequence is needed.
- For a small correction, `read` the target with `detail: "full"`, then `update_slide` with its slide index and element patches. Each patch is `{index, ...changed fields}`, with **no nested `op`**. `text` replaces the old paragraphs; use `paragraphs` instead to retain rich run formatting. Do not supply both.
- Indexes are live within a batch: inserting or deleting slides shifts subsequent indexes. Recalculate later selectors against the resulting order. `move_slides.to` is measured after removing the moved pages.
- Failure leaves the whole batch unapplied. Correct the named field/index; if uncertain, read the current document and retry a smaller edit. Do not resend unchanged failed input or replay successful calls.

## Text and fonts

Pass ordinary Unicode text; do not manually transcode or pre-escape XML. The tool writes UTF-8. Set deck defaults at create with `settings.theme`, or later with `set_theme`: `{font, east_asia_font, text_color, lang}`. Use the theme defaults unless document requirements call for specific fonts. Fonts are not embedded; availability and substitution depend on the viewing environment, which may differ from the generation environment.

`lang` is an optional BCP 47 override on the theme, text/shape element, paragraph, or run (most specific wins). Omit it for automatic selection: kana → `ja-JP`, Hangul → `ko-KR`, Han → `zh-CN`, otherwise `en-US`. Set the intended language explicitly when script alone is ambiguous, such as Traditional Chinese or Han-only Japanese/Korean. `font` on an element/run overrides its font; `theme.east_asia_font` supplies the theme's East Asian font.

## Slide

`{ "title", "layout", "background": "#RRGGBB", "notes": "speaker notes", "elements": [ … ] }`. `title` and `layout` are planning labels shown by `read` (not drawn).

## Elements

Colors are `#RRGGBB` or `#RRGGBBAA` (alpha). Text-bearing elements accept `text` (string, `\n` = new paragraph) or `paragraphs`, plus element-level defaults `size_pt`, `bold`, `italic`, `color`, `font`, `lang`, `align`. Defaults apply only where a run/paragraph does not set its own value; changing element size/color/font does not override explicit values inside runs.

**text** — `{type: "text", x, y, w, h, text | paragraphs, valign (top|middle|bottom, default top), rotation, …defaults}`. Zero inner padding; the box wraps at `w` and does not grow, so size it for its content.

**shape** — `{type: "shape", shape, x, y, w, h, fill, stroke: {color, width_pt, dash: solid|dash|dot}, text | paragraphs, valign (default middle), padding (px), flip_h, flip_v, rotation, …defaults}`. `shape` is one of `rect` `roundRect` `ellipse` `triangle` `rtTriangle` `rightArrow` `leftArrow` `upArrow` `downArrow` `chevron` `diamond` `parallelogram` `trapezoid` `hexagon` `pentagon` `octagon` `plus` `pie` `donut` `star5` `heart` `cloud` `line` `lineArrow`. A shape needs a fill, a stroke, or text. `line`/`lineArrow` draw the box diagonal (use `h: 0` for a horizontal rule, `flip_v` for bottom-left → top-right) and need a `stroke`.

**image** — `{type: "image", src, x, y, w, h, fit: cover|contain|stretch (default cover), alt, rotation}`. `src` is an absolute local path or a data URL (PNG/JPEG/GIF/BMP; download web images to a local file first). `cover` center-crops to fill the box, so give the box roughly the picture's aspect ratio. After embedding, `read` shows `asset`; keep it to reuse the picture.

**table** — `{type: "table", x, y, w, h, rows, header (default true), column_widths (px, scaled to w), font_size_pt (default 14), font, header_fill, header_color, fill, band_fill ("" disables banding), border_color, text_color}`. Cells are strings/numbers or `{text/runs, bold, color, fill, align}`. Rows share `h` equally. At most 60 rows × 30 columns.

**Paragraph** — a string, or `{text | runs, align (left|center|right|justify), line_spacing_pct, space_before_pt, space_after_pt, bullet, numbered, level, size_pt, bold, italic, color, font, lang}`.

**Run** — `{text, size_pt, bold, italic, underline, strike, superscript, subscript, color, highlight, font, lang, link}`.

GenOffice spec spellings are accepted as aliases: `sizePt`, `lineSpacingPct`, `spaceBeforePt`, `spaceAfterPt`, `widthPt`, `flipH`, `flipV`, `url`.

## Operations

| op | fields | effect |
|---|---|---|
| `insert_slides` | `index` (omit to append), `slides` | adds slides |
| `replace_slide` | `index`, `slide` | rebuilds one slide |
| `update_slide` | `index`, then any of `title` `layout` `background` `notes` (null clears), `elements` (replace all), or `update_elements` `[{index, …changed fields}]`, `remove_elements` `[indexes]`, `append_elements` `[elements]` (applied in that order) | partial slide edit |
| `delete_slides` | `index`, `count` (default 1) | |
| `move_slides` | `index`, `count`, `to` | `to` is the position after the moved slides are removed |
| `duplicate_slide` | `index`, `to` (default right after) | |
| `set_theme` | `font`, `east_asia_font`, `text_color`, `lang` (null clears an override) | deck-wide defaults |
| `set_properties` | `title`, `subject`, `author`, `keywords`, `description`, `category` | |

After a batch the tool audits the touched slides and reports elements outside the canvas and text that likely overflows its box; fix relevant findings with `update_slide`. These are estimates, not rendered images. Visual verification is a separate step using an available viewer/renderer; report the environment actually checked. File generation does not require an installed Office application or renderer.

### In-place edit examples

```json
{"action":"edit","file_path":"/abs/deck.pptx","operations":[
  {"op":"replace_slide","index":2,"slide":{"title":"Summary","elements":[
    {"type":"text","x":80,"y":80,"w":1000,"h":100,"size_pt":32,"text":"Updated result"}
  ]}}
]}
```

Then change only that text with `{"op":"update_slide","index":2,"update_elements":[{"index":0,"text":"Final result"}]}`. Slide index 2 and element index 0 are different selectors; get both from `read`.

## Design rules (from GenOffice's deck pipeline)

- Decide the style first: background per page type, main text color, one or two accent colors, title and body fonts. Re-use them on every slide; never give each item its own color.
- Plan the deck before writing slides: a cover, content/data pages with varied layouts (three cards, big number, two-column comparison, timeline, KPI row, chart + insight), and a closing page. Do not repeat the same content layout back to back.
- Sizing text: one line ≈ `size_pt × 1.6` px tall; a CJK character ≈ `size_pt × 1.33` px wide, a Latin character ≈ `size_pt × 0.7` px. Count the wrapped lines and make the box that tall plus a spare line.
- Type scale (pt): titles 32–48, subtitles 18–24, body 12–16, hero numbers up to 80.
- Spacing: ≥ 8 px between text and a card edge, ≥ 20 px between a title and its subtitle. Keep everything inside the canvas and spread content over the whole slide.
- Only use photos you actually have (local files, generated or downloaded images). Without photos, use typography, color blocks and shapes; never fake a photo with a grey box. Data visuals can be built from `rect`, `donut` and `line` shapes sized proportionally to real values.
- Avoid: a thin accent bar on every card, rainbow cards, a header bar repeated on every slide, two text boxes that say the same thing, placeholder copy ("XX%", "lorem").

## Example

```json
{"action": "edit", "file_path": "/abs/deck.pptx", "operations": [
  {"op": "insert_slides", "slides": [{
    "title": "Cover", "background": "#0E1A2B", "notes": "Open with the 40% figure.",
    "elements": [
      {"type": "shape", "shape": "rect", "x": 0, "y": 0, "w": 560, "h": 720, "fill": "#1F3A5F"},
      {"type": "text", "x": 80, "y": 240, "w": 440, "h": 150, "paragraphs": [
        {"runs": [{"text": "Margins fell ", "size_pt": 40, "bold": true, "color": "#FFFFFF"}, {"text": "40%", "size_pt": 54, "bold": true, "color": "#FFC000"}]}]},
      {"type": "image", "src": "/abs/assets/port.jpg", "x": 640, "y": 120, "w": 560, "h": 480}
    ]}]}
]}
```
