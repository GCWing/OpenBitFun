import {
  MarkdownParser,
  ParsedMarkdownBlock,
  ParsedMarkdownInline,
  ParsedMarkdownListItem,
  ParsedMarkdownTableCell,
  ParsedMarkdownTableRow
} from './MarkdownParser';

const SAFE_LINK_SCHEME: RegExp = /^(https?:|computer:|file:)/i;
const ORDERED_MARKER: RegExp = /^\d+\.$/;
const CHECKED_PREFIX: string = '<input type="checkbox" checked disabled> ';
const UNCHECKED_PREFIX: string = '<input type="checkbox" disabled> ';

/** One open list element while a parsed list block is being serialized. */
class HtmlListLevel {
  depth: number = 0;
  ordered: boolean = false;
  itemOpen: boolean = false;

  constructor(depth: number, ordered: boolean) {
    this.depth = depth;
    this.ordered = ordered;
  }
}

/**
 * Renders the parsed Markdown tree as the HTML flavor of a rich clipboard
 * payload. Pure string work over `ParsedMarkdownBlock[]`: it never touches the
 * UI, the pasteboard, or a platform kit, so the host runner can exercise the
 * real source and the clipboard owner only has to move the string.
 *
 * Every text node and attribute value is escaped, and links are limited to an
 * allowlisted scheme so a hostile document cannot smuggle markup or a script
 * URL into whatever receives the paste.
 */
export class MarkdownHtmlSerializer {
  /** Parses `text` and serializes it. Blank input produces an empty payload. */
  static toHtml(text: string): string {
    if (text.trim().length === 0) {
      return '';
    }
    return MarkdownHtmlSerializer.blocksToHtml(MarkdownParser.parse(text));
  }

  static blocksToHtml(blocks: ParsedMarkdownBlock[]): string {
    let html = '';
    for (let index = 0; index < blocks.length; index += 1) {
      html += MarkdownHtmlSerializer.blockHtml(blocks[index]);
    }
    return html;
  }

  private static blockHtml(block: ParsedMarkdownBlock): string {
    if (block.type === 'heading') {
      return MarkdownHtmlSerializer.headingHtml(block);
    }
    if (block.type === 'quote') {
      return MarkdownHtmlSerializer.quoteHtml(block);
    }
    if (block.type === 'list') {
      return MarkdownHtmlSerializer.listHtml(block);
    }
    if (block.type === 'table') {
      return MarkdownHtmlSerializer.tableHtml(block);
    }
    if (block.type === 'code') {
      return MarkdownHtmlSerializer.codeHtml(block);
    }
    if (block.type === 'divider') {
      return '<hr>';
    }
    if (block.type === 'frontmatter') {
      return `<pre>${MarkdownHtmlSerializer.escape(block.text)}</pre>`;
    }
    return MarkdownHtmlSerializer.paragraphHtml(block);
  }

  private static headingHtml(block: ParsedMarkdownBlock): string {
    const level = block.level < 1 ? 1 : (block.level > 6 ? 6 : block.level);
    const content = MarkdownHtmlSerializer.inlineHtml(block.inlines, block.text);
    return `<h${level}>${content}</h${level}>`;
  }

  private static paragraphHtml(block: ParsedMarkdownBlock): string {
    const content = MarkdownHtmlSerializer.inlineHtml(block.inlines, block.text);
    if (content.length === 0) {
      return '';
    }
    return `<p>${content}</p>`;
  }

  /**
   * The parser reports the quote depth it consumed, so a nested quote becomes a
   * nested element rather than a repeated sibling.
   */
  private static quoteHtml(block: ParsedMarkdownBlock): string {
    const level = block.level < 1 ? 1 : block.level;
    const content = MarkdownHtmlSerializer.inlineHtml(block.inlines, block.text);
    return '<blockquote>'.repeat(level) + content + '</blockquote>'.repeat(level);
  }

  private static codeHtml(block: ParsedMarkdownBlock): string {
    const body = MarkdownHtmlSerializer.escape(block.text);
    if (block.language.length === 0) {
      return `<pre><code>${body}</code></pre>`;
    }
    const language = MarkdownHtmlSerializer.escape(block.language);
    return `<pre><code class="language-${language}">${body}</code></pre>`;
  }

  /**
   * List items carry their own depth and marker, so one flat sequence still
   * renders as nested `ul`/`ol` and swings between both list elements when the
   * source mixes markers at the same level.
   */
  private static listHtml(block: ParsedMarkdownBlock): string {
    const items = block.items;
    if (items.length === 0) {
      return '';
    }
    const levels: HtmlListLevel[] = [];
    let html = '';
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const depth = item.depth > 0 ? item.depth : 0;
      const ordered = ORDERED_MARKER.test(item.marker);

      while (levels.length > depth + 1) {
        html += MarkdownHtmlSerializer.closeLevel(levels);
      }
      if (levels.length === 0) {
        html += MarkdownHtmlSerializer.openLevel(levels, depth, ordered);
      } else if (levels[levels.length - 1].depth < depth) {
        while (levels.length < depth + 1) {
          html += MarkdownHtmlSerializer.openLevel(levels, levels.length, ordered);
        }
      } else if (levels[levels.length - 1].ordered !== ordered) {
        html += MarkdownHtmlSerializer.closeLevel(levels);
        html += MarkdownHtmlSerializer.openLevel(levels, depth, ordered);
      }

      const level = levels[levels.length - 1];
      if (level.itemOpen) {
        html += '</li>';
        level.itemOpen = false;
      }
      level.itemOpen = true;
      html += '<li>';
      html += MarkdownHtmlSerializer.listItemContent(item);
    }
    while (levels.length > 0) {
      html += MarkdownHtmlSerializer.closeLevel(levels);
    }
    return html;
  }

  private static listItemContent(item: ParsedMarkdownListItem): string {
    const content = MarkdownHtmlSerializer.inlineHtml(item.inlines, item.text);
    if (item.checked === 1) {
      return CHECKED_PREFIX + content;
    }
    if (item.checked === 0) {
      return UNCHECKED_PREFIX + content;
    }
    return content;
  }

  private static openLevel(levels: HtmlListLevel[], depth: number, ordered: boolean): string {
    levels[levels.length] = new HtmlListLevel(depth, ordered);
    return ordered ? '<ol>' : '<ul>';
  }

  private static closeLevel(levels: HtmlListLevel[]): string {
    const level = levels[levels.length - 1];
    let html = '';
    if (level.itemOpen) {
      html += '</li>';
      level.itemOpen = false;
    }
    html += level.ordered ? '</ol>' : '</ul>';
    levels.splice(levels.length - 1, 1);
    return html;
  }

  private static tableHtml(block: ParsedMarkdownBlock): string {
    const rows = block.tableRows;
    let head = '';
    let body = '';
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.header) {
        head += MarkdownHtmlSerializer.tableRowHtml(row);
      } else {
        body += MarkdownHtmlSerializer.tableRowHtml(row);
      }
    }
    return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  private static tableRowHtml(row: ParsedMarkdownTableRow): string {
    const tag = row.header ? 'th' : 'td';
    let cells = '';
    for (let index = 0; index < row.cells.length; index += 1) {
      const cell: ParsedMarkdownTableCell = row.cells[index];
      const style = MarkdownHtmlSerializer.alignmentStyle(cell.alignment);
      const content = MarkdownHtmlSerializer.inlineHtml(cell.inlines, cell.text);
      cells += `<${tag}${style}>${content}</${tag}>`;
    }
    return `<tr>${cells}</tr>`;
  }

  private static alignmentStyle(alignment: string): string {
    if (alignment === 'center' || alignment === 'right') {
      return ` style="text-align: ${alignment}"`;
    }
    return '';
  }

  private static inlineHtml(inlines: ParsedMarkdownInline[], fallback: string): string {
    if (inlines.length === 0) {
      return MarkdownHtmlSerializer.escape(fallback);
    }
    let html = '';
    for (let index = 0; index < inlines.length; index += 1) {
      html += MarkdownHtmlSerializer.inlineNodeHtml(inlines[index]);
    }
    return html;
  }

  private static inlineNodeHtml(inline: ParsedMarkdownInline): string {
    const text = MarkdownHtmlSerializer.escape(inline.text);
    if (inline.type === 'strong') {
      return `<strong>${text}</strong>`;
    }
    if (inline.type === 'emphasis') {
      return `<em>${text}</em>`;
    }
    if (inline.type === 'code') {
      return `<code>${text}</code>`;
    }
    if (inline.type === 'delete') {
      return `<del>${text}</del>`;
    }
    if (inline.type === 'link') {
      if (!SAFE_LINK_SCHEME.test(inline.url)) {
        return text;
      }
      return `<a href="${MarkdownHtmlSerializer.escape(inline.url)}">${text}</a>`;
    }
    return text;
  }

  /** Escapes `&`, `<`, `>` and `"` for both text nodes and attribute values. */
  private static escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
