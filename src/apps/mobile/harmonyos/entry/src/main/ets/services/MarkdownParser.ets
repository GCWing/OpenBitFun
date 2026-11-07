export interface ParsedMarkdownInline {
  id: string;
  type: string;
  text: string;
  url: string;
}

export interface ParsedMarkdownListItem {
  id: string;
  marker: string;
  text: string;
  inlines: ParsedMarkdownInline[];
  depth: number;
  checked: number;
}

export interface ParsedMarkdownTableCell {
  id: string;
  text: string;
  inlines: ParsedMarkdownInline[];
  alignment: string;
}

export interface ParsedMarkdownTableRow {
  id: string;
  header: boolean;
  cells: ParsedMarkdownTableCell[];
}

export interface ParsedMarkdownBlock {
  id: string;
  renderKey: string;
  type: string;
  level: number;
  language: string;
  text: string;
  items: ParsedMarkdownListItem[];
  inlines: ParsedMarkdownInline[];
  tableRows: ParsedMarkdownTableRow[];
}

export class MarkdownParseCache {
  private text: string = '';
  private blocks: ParsedMarkdownBlock[] = [];
  private initialized: boolean = false;

  blocksFor(text: string): ParsedMarkdownBlock[] {
    if (this.initialized && this.text === text) {
      return this.blocks;
    }
    this.text = text;
    this.blocks = MarkdownParser.parse(text);
    this.initialized = true;
    return this.blocks;
  }
}

export class MarkdownParser {
  static parse(text: string): ParsedMarkdownBlock[] {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const blocks: ParsedMarkdownBlock[] = [];
    let index = 0;
    const frontmatterEnd = MarkdownParser.frontmatterEnd(lines);
    if (frontmatterEnd > 0) {
      MarkdownParser.pushBlock(
        blocks,
        'frontmatter',
        0,
        '',
        lines.slice(1, frontmatterEnd).join('\n').replace(/\s+$/, ''),
        []
      );
      index = frontmatterEnd + 1;
    }

    while (index < lines.length) {
      const raw = lines[index];
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        index += 1;
        continue;
      }

      if (MarkdownParser.isFence(trimmed)) {
        index = MarkdownParser.readCodeBlock(lines, index, blocks);
      } else if (MarkdownParser.isSetextHeading(lines, index)) {
        const level = /^=+\s*$/.test(lines[index + 1].trim()) ? 1 : 2;
        MarkdownParser.pushBlock(blocks, 'heading', level, '', trimmed, []);
        index += 2;
      } else if (MarkdownParser.isDivider(trimmed)) {
        MarkdownParser.pushBlock(blocks, 'divider', 0, '', '', []);
        index += 1;
      } else if (MarkdownParser.isHeading(trimmed)) {
        const level = MarkdownParser.headingLevel(trimmed);
        const headingText = trimmed.slice(level).trim().replace(/\s+#+\s*$/, '');
        MarkdownParser.pushBlock(blocks, 'heading', level, '', headingText, []);
        index += 1;
      } else if (MarkdownParser.isQuote(trimmed)) {
        index = MarkdownParser.readQuoteBlock(lines, index, blocks);
      } else if (MarkdownParser.isListLine(trimmed)) {
        index = MarkdownParser.readListBlock(lines, index, blocks);
      } else if (MarkdownParser.isTableStart(lines, index)) {
        index = MarkdownParser.readTableBlock(lines, index, blocks);
      } else {
        index = MarkdownParser.readParagraphBlock(lines, index, blocks);
      }
    }

    if (blocks.length > 0) {
      return blocks;
    }
    MarkdownParser.pushBlock(blocks, 'paragraph', 0, '', text, []);
    return blocks;
  }

  static formatInlineText(value: string): string {
    return MarkdownParser.plainInlineText(MarkdownParser.parseInlineText(value));
  }

  private static plainInlineText(inlines: ParsedMarkdownInline[]): string {
    return inlines.map((inline: ParsedMarkdownInline) => {
      return inline.type === 'link' && inline.text !== inline.url ? `${inline.text} (${inline.url})` : inline.text;
    }).join('');
  }

  private static readCodeBlock(lines: string[], start: number, blocks: ParsedMarkdownBlock[]): number {
    const opening = lines[start].trim();
    const fence = MarkdownParser.fenceMarker(opening);
    const info = opening.slice(fence.length).trim();
    const language = info.split(/\s+/)[0] || '';
    const body: string[] = [];
    let index = start + 1;
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (MarkdownParser.isClosingFence(trimmed, fence)) {
        index += 1;
        break;
      }
      body.push(lines[index]);
      index += 1;
    }
    MarkdownParser.pushBlock(blocks, 'code', 0, language, body.join('\n'), []);
    return index;
  }

  private static readQuoteBlock(lines: string[], start: number, blocks: ParsedMarkdownBlock[]): number {
    const body: string[] = [];
    let index = start;
    let level = 0;
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (!MarkdownParser.isQuote(trimmed)) {
        break;
      }
      const currentLevel = MarkdownParser.quoteDepth(trimmed);
      if (level === 0) {
        level = currentLevel;
      }
      if (currentLevel !== level) {
        MarkdownParser.pushBlock(blocks, 'quote', level, '', MarkdownParser.joinFlowLines(body), []);
        body.length = 0;
        level = currentLevel;
      }
      body.push(MarkdownParser.quoteText(trimmed, currentLevel));
      index += 1;
    }
    if (body.length > 0) {
      MarkdownParser.pushBlock(blocks, 'quote', level, '', MarkdownParser.joinFlowLines(body), []);
    }
    return index;
  }

  private static readListBlock(lines: string[], start: number, blocks: ParsedMarkdownBlock[]): number {
    const items: ParsedMarkdownListItem[] = [];
    let index = start;
    while (index < lines.length) {
      const raw = lines[index];
      const trimmed = raw.trim();
      if (!MarkdownParser.isListLine(trimmed)) {
        break;
      }
      const marker = MarkdownParser.listMarker(trimmed);
      const firstLineText = MarkdownParser.listText(trimmed);
      const taskMatch = firstLineText.match(/^\[([ xX])\]\s+(.*)$/);
      let text = taskMatch ? taskMatch[2] : firstLineText;
      let nextIndex = index + 1;
      const currentIndent = MarkdownParser.leadingIndentWidth(raw);
      while (nextIndex < lines.length) {
        const continuation = lines[nextIndex];
        const continuationTrimmed = continuation.trim();
        if (continuationTrimmed.length === 0 || MarkdownParser.isListLine(continuationTrimmed) ||
          MarkdownParser.leadingIndentWidth(continuation) <= currentIndent) {
          break;
        }
        text += ' ' + continuationTrimmed;
        nextIndex += 1;
      }
      const inlines = MarkdownParser.parseInlineText(text, `li-${start}-${items.length}`);
      const item: ParsedMarkdownListItem = {
        id: `li-${start}-${items.length}`,
        marker,
        text: MarkdownParser.plainInlineText(inlines),
        inlines,
        depth: MarkdownParser.listDepth(raw),
        checked: taskMatch ? (taskMatch[1].toLowerCase() === 'x' ? 1 : 0) : -1
      };
      items.push(item);
      index = nextIndex;
    }
    MarkdownParser.pushBlock(blocks, 'list', 0, '', '', items);
    return index;
  }

  private static readTableBlock(lines: string[], start: number, blocks: ParsedMarkdownBlock[]): number {
    const sourceRows: string[] = [lines[start].trim(), lines[start + 1].trim()];
    const headerCells = MarkdownParser.splitTableRow(lines[start]);
    const separatorCells = MarkdownParser.splitTableRow(lines[start + 1]);
    const alignments: string[] = separatorCells.map((cell: string) => MarkdownParser.tableAlignment(cell));
    const rows: ParsedMarkdownTableRow[] = [];
    rows.push(MarkdownParser.buildTableRow(headerCells, alignments, true, start, 0));
    let index = start + 2;
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (!MarkdownParser.hasTablePipes(trimmed)) {
        break;
      }
      sourceRows.push(trimmed);
      rows.push(MarkdownParser.buildTableRow(
        MarkdownParser.splitTableRow(lines[index]), alignments, false, start, rows.length
      ));
      index += 1;
    }
    MarkdownParser.pushBlock(blocks, 'table', 0, '', sourceRows.join('\n'), [], rows);
    return index;
  }

  private static readParagraphBlock(lines: string[], start: number, blocks: ParsedMarkdownBlock[]): number {
    const body: string[] = [];
    let index = start;
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (trimmed.length === 0 ||
        MarkdownParser.isFence(trimmed) ||
        MarkdownParser.isSetextHeading(lines, index) ||
        MarkdownParser.isDivider(trimmed) ||
        MarkdownParser.isHeading(trimmed) ||
        MarkdownParser.isQuote(trimmed) ||
        MarkdownParser.isListLine(trimmed) ||
        MarkdownParser.isTableStart(lines, index)) {
        break;
      }
      body.push(lines[index].replace(/^\s+/, ''));
      index += 1;
    }
    MarkdownParser.pushBlock(blocks, 'paragraph', 0, '', MarkdownParser.joinFlowLines(body), []);
    return index;
  }

  private static pushBlock(
    blocks: ParsedMarkdownBlock[],
    type: string,
    level: number,
    language: string,
    text: string,
    items: ParsedMarkdownListItem[],
    tableRows: ParsedMarkdownTableRow[] = []
  ): void {
    const id = `md-${blocks.length}-${type}`;
    const inlines = MarkdownParser.shouldParseInline(type) ? MarkdownParser.parseInlineText(text, id) : [];
    const normalizedText = MarkdownParser.shouldParseInline(type) ? MarkdownParser.plainInlineText(inlines) : text;
    const block: ParsedMarkdownBlock = {
      id,
      renderKey: '',
      type,
      level,
      language,
      text: normalizedText,
      items,
      inlines,
      tableRows
    };
    block.renderKey = `${id}-${MarkdownParser.blockContentRevision(block)}`;
    blocks.push(block);
  }

  private static blockContentRevision(block: ParsedMarkdownBlock): string {
    let source = MarkdownParser.revisionPart(block.type) +
      MarkdownParser.revisionPart(block.level.toString()) +
      MarkdownParser.revisionPart(block.language) +
      MarkdownParser.revisionPart(block.text);
    block.inlines.forEach((inline: ParsedMarkdownInline) => {
      source += MarkdownParser.inlineRevisionSource(inline);
    });
    block.items.forEach((item: ParsedMarkdownListItem) => {
      source += MarkdownParser.revisionPart(item.marker) +
        MarkdownParser.revisionPart(item.text) +
        MarkdownParser.revisionPart(item.depth.toString()) +
        MarkdownParser.revisionPart(item.checked.toString());
      item.inlines.forEach((inline: ParsedMarkdownInline) => {
        source += MarkdownParser.inlineRevisionSource(inline);
      });
    });
    block.tableRows.forEach((row: ParsedMarkdownTableRow) => {
      source += MarkdownParser.revisionPart(row.header ? '1' : '0');
      row.cells.forEach((cell: ParsedMarkdownTableCell) => {
        source += MarkdownParser.revisionPart(cell.text) + MarkdownParser.revisionPart(cell.alignment);
        cell.inlines.forEach((inline: ParsedMarkdownInline) => {
          source += MarkdownParser.inlineRevisionSource(inline);
        });
      });
    });
    return MarkdownParser.revisionHash(source);
  }

  private static inlineRevisionSource(inline: ParsedMarkdownInline): string {
    return MarkdownParser.revisionPart(inline.type) +
      MarkdownParser.revisionPart(inline.text) +
      MarkdownParser.revisionPart(inline.url);
  }

  private static revisionPart(value: string): string {
    return `${value.length}:${value}`;
  }

  private static revisionHash(value: string): string {
    let primary = 7;
    let secondary = 11;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      primary = (primary * 31 + code) % 2147483647;
      secondary = (secondary * 131 + code) % 2147483629;
    }
    return `${value.length}-${primary}-${secondary}`;
  }

  static parseInlineText(value: string, prefix: string = 'inline'): ParsedMarkdownInline[] {
    const inlines: ParsedMarkdownInline[] = [];
    let index = 0;
    while (index < value.length) {
      const next = MarkdownParser.nextInlineMarker(value, index);
      if (next < 0) {
        MarkdownParser.pushTextWithAutoLinks(inlines, prefix, value.slice(index));
        break;
      }
      if (next > index) {
        MarkdownParser.pushTextWithAutoLinks(inlines, prefix, value.slice(index, next));
      }
      const consumed = MarkdownParser.readInlineAt(value, next, prefix, inlines);
      if (consumed <= next) {
        MarkdownParser.pushInline(inlines, prefix, 'text', value.charAt(next), '');
        index = next + 1;
      } else {
        index = consumed;
      }
    }
    return inlines.filter((inline: ParsedMarkdownInline) => inline.text.length > 0);
  }

  private static readInlineAt(value: string, start: number, prefix: string, inlines: ParsedMarkdownInline[]): number {
    if (value.charAt(start) === '`') {
      let markerLength = 1;
      while (value.charAt(start + markerLength) === '`') {
        markerLength += 1;
      }
      const marker = '`'.repeat(markerLength);
      const end = value.indexOf(marker, start + markerLength);
      if (end > start + markerLength) {
        let code = value.slice(start + markerLength, end).replace(/\s+/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) {
          code = code.slice(1, -1);
        }
        MarkdownParser.pushInline(inlines, prefix, 'code', code, '');
        return end + markerLength;
      }
    }
    if (value.slice(start, start + 2) === '**') {
      const end = value.indexOf('**', start + 2);
      if (end > start + 2) {
        MarkdownParser.pushInline(inlines, prefix, 'strong', value.slice(start + 2, end), '');
        return end + 2;
      }
    }
    if (value.slice(start, start + 2) === '__') {
      const end = value.indexOf('__', start + 2);
      if (end > start + 2) {
        MarkdownParser.pushInline(inlines, prefix, 'strong', value.slice(start + 2, end), '');
        return end + 2;
      }
    }
    if (MarkdownParser.isStrikeDelimiter(value, start, false)) {
      let end = value.indexOf('~~', start + 2);
      while (end >= 0 && !MarkdownParser.isStrikeDelimiter(value, end, true)) {
        end = value.indexOf('~~', end + 2);
      }
      if (end > start + 2) {
        MarkdownParser.pushInline(inlines, prefix, 'delete', MarkdownParser.unescapeText(value.slice(start + 2, end)), '');
        return end + 2;
      }
    }
    if (value.charAt(start) === '[') {
      const labelEnd = value.indexOf(']', start + 1);
      if (labelEnd > start + 1 && value.charAt(labelEnd + 1) === '(') {
        const urlEnd = value.indexOf(')', labelEnd + 2);
        if (urlEnd > labelEnd + 2) {
          MarkdownParser.pushInline(inlines, prefix, 'link', value.slice(start + 1, labelEnd), value.slice(labelEnd + 2, urlEnd));
          return urlEnd + 1;
        }
      }
    }
    if (value.charAt(start) === '<') {
      const end = value.indexOf('>', start + 1);
      if (end > start + 1) {
        const url = value.slice(start + 1, end);
        if (/^(https?:\/\/|computer:\/\/|file:\/\/)[^\s<>]+$/.test(url)) {
          MarkdownParser.pushInline(inlines, prefix, 'link', url, url);
          return end + 1;
        }
      }
    }
    if (value.charAt(start) === '*') {
      const end = value.indexOf('*', start + 1);
      if (end > start + 1) {
        MarkdownParser.pushInline(inlines, prefix, 'emphasis', value.slice(start + 1, end), '');
        return end + 1;
      }
    }
    if (value.charAt(start) === '_') {
      const end = value.indexOf('_', start + 1);
      if (end > start + 1) {
        MarkdownParser.pushInline(inlines, prefix, 'emphasis', value.slice(start + 1, end), '');
        return end + 1;
      }
    }
    return start;
  }

  private static nextInlineMarker(value: string, start: number): number {
    const markers: string[] = ['`', '**', '__', '~~', '[', '<', '*', '_'];
    let next = -1;
    markers.forEach((marker: string) => {
      let markerIndex = value.indexOf(marker, start);
      while (markerIndex >= 0 && MarkdownParser.isEscaped(value, markerIndex)) {
        markerIndex = value.indexOf(marker, markerIndex + marker.length);
      }
      if (markerIndex >= 0 && (next < 0 || markerIndex < next)) {
        next = markerIndex;
      }
    });
    return next;
  }

  private static isStrikeDelimiter(value: string, index: number, closing: boolean): boolean {
    // Single tildes are chat ranges; runs longer than two are literal inlines.
    if (value.slice(index, index + 2) !== '~~' || value.charAt(index - 1) === '~' ||
      value.charAt(index + 2) === '~' || MarkdownParser.isEscaped(value, index)) {
      return false;
    }
    const before = value.charAt(index - 1);
    const after = value.charAt(index + 2);
    const beforeSpace = before.length === 0 || /\s/.test(before);
    const afterSpace = after.length === 0 || /\s/.test(after);
    const beforePunctuation = /[\p{P}\p{S}]/u.test(before);
    const afterPunctuation = /[\p{P}\p{S}]/u.test(after);
    return closing ? !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation) :
      !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
  }

  private static pushInline(
    inlines: ParsedMarkdownInline[],
    prefix: string,
    type: string,
    text: string,
    url: string
  ): void {
    const inline: ParsedMarkdownInline = {
      id: `${prefix}-inline-${inlines.length}`,
      type,
      text,
      url
    };
    inlines.push(inline);
  }

  private static pushTextWithAutoLinks(
    inlines: ParsedMarkdownInline[],
    prefix: string,
    text: string
  ): void {
    const pattern = /(https?:\/\/|computer:\/\/|file:\/\/)[^\s<>]+/g;
    let cursor = 0;
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match) {
      if (match.index > cursor) {
        MarkdownParser.pushInline(
          inlines, prefix, 'text', MarkdownParser.unescapeText(text.slice(cursor, match.index)), ''
        );
      }
      let url = match[0];
      let suffix = '';
      while (url.length > 0 && /[.,;:!?]$/.test(url)) {
        suffix = url.slice(-1) + suffix;
        url = url.slice(0, -1);
      }
      MarkdownParser.pushInline(inlines, prefix, 'link', url, url);
      if (suffix.length > 0) {
        MarkdownParser.pushInline(inlines, prefix, 'text', suffix, '');
      }
      cursor = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (cursor < text.length) {
      MarkdownParser.pushInline(inlines, prefix, 'text', MarkdownParser.unescapeText(text.slice(cursor)), '');
    }
  }

  private static unescapeText(value: string): string {
    const escapable = '\\`*{}[]()#+-.!_>~|';
    let result = '';
    let index = 0;
    while (index < value.length) {
      if (value.charAt(index) === '\\' && index + 1 < value.length &&
        escapable.indexOf(value.charAt(index + 1)) >= 0) {
        result += value.charAt(index + 1);
        index += 2;
      } else {
        result += value.charAt(index);
        index += 1;
      }
    }
    return result;
  }

  private static isEscaped(value: string, index: number): boolean {
    let slashCount = 0;
    let cursor = index - 1;
    while (cursor >= 0 && value.charAt(cursor) === '\\') {
      slashCount += 1;
      cursor -= 1;
    }
    return slashCount % 2 === 1;
  }

  private static shouldParseInline(type: string): boolean {
    return type === 'paragraph' || type === 'heading' || type === 'quote';
  }

  private static frontmatterEnd(lines: string[]): number {
    if (lines.length < 3 || lines[0].trim() !== '---') {
      return -1;
    }
    for (let index = 1; index < lines.length; index += 1) {
      const marker = lines[index].trim();
      if (marker === '---' || marker === '...') {
        return index > 1 ? index : -1;
      }
    }
    return -1;
  }

  private static isHeading(line: string): boolean {
    return /^#{1,6}\s+/.test(line);
  }

  private static headingLevel(line: string): number {
    const match = line.match(/^#{1,6}/);
    return match ? match[0].length : 1;
  }

  private static isDivider(line: string): boolean {
    return /^(?:\*\s*){3,}$/.test(line) || /^(?:_\s*){3,}$/.test(line) || /^(?:-\s*){3,}$/.test(line);
  }

  private static isQuote(line: string): boolean {
    return line.indexOf('>') === 0;
  }

  private static quoteDepth(line: string): number {
    let depth = 0;
    let index = 0;
    while (index < line.length) {
      if (line.charAt(index) !== '>') {
        break;
      }
      depth += 1;
      index += 1;
      if (line.charAt(index) === ' ') {
        index += 1;
      }
    }
    return Math.max(1, depth);
  }

  private static quoteText(line: string, depth: number): string {
    let index = 0;
    let consumed = 0;
    while (index < line.length && consumed < depth) {
      if (line.charAt(index) === '>') {
        consumed += 1;
        index += 1;
        if (line.charAt(index) === ' ') {
          index += 1;
        }
      } else {
        break;
      }
    }
    return line.slice(index);
  }

  private static isListLine(line: string): boolean {
    return /^[-*+]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
  }

  private static listMarker(line: string): string {
    const ordered = line.match(/^(\d+)[.)]\s+/);
    if (ordered) {
      return `${ordered[1]}.`;
    }
    return '•';
  }

  private static listText(line: string): string {
    return line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
  }

  private static listDepth(line: string): number {
    const width = MarkdownParser.leadingIndentWidth(line);
    return width > 0 ? Math.ceil(width / 4) : 0;
  }

  private static leadingIndentWidth(line: string): number {
    let width = 0;
    let index = 0;
    while (index < line.length) {
      const character = line.charAt(index);
      if (character === ' ') {
        width += 1;
      } else if (character === '\t') {
        width += 4;
      } else {
        break;
      }
      index += 1;
    }
    return width;
  }

  private static isFence(line: string): boolean {
    return /^`{3,}[^`]*$/.test(line) || /^~{3,}.*$/.test(line);
  }

  private static fenceMarker(line: string): string {
    const match = line.match(/^(`{3,}|~{3,})/);
    return match ? match[1] : '```';
  }

  private static isClosingFence(line: string, opening: string): boolean {
    if (line.length < opening.length || line.charAt(0) !== opening.charAt(0)) {
      return false;
    }
    let count = 0;
    while (count < line.length && line.charAt(count) === opening.charAt(0)) {
      count += 1;
    }
    return count >= opening.length && line.slice(count).trim().length === 0;
  }

  private static isSetextHeading(lines: string[], index: number): boolean {
    if (index + 1 >= lines.length || lines[index].trim().length === 0) {
      return false;
    }
    return /^(=+|-+)\s*$/.test(lines[index + 1].trim());
  }

  private static joinFlowLines(lines: string[]): string {
    let result = '';
    lines.forEach((line: string, index: number) => {
      if (index === 0) {
        result = line;
        return;
      }
      if (/ {2,}$/.test(result)) {
        result = result.replace(/ {2,}$/, '') + '\n' + line;
      } else if (result.endsWith('\\')) {
        result = result.slice(0, -1) + '\n' + line;
      } else {
        result += ' ' + line;
      }
    });
    return result.replace(/\s+$/, '');
  }

  private static isTableStart(lines: string[], index: number): boolean {
    if (index + 1 >= lines.length) {
      return false;
    }
    const current = lines[index].trim();
    const next = lines[index + 1].trim();
    return MarkdownParser.hasTablePipes(current) && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
  }

  private static hasTablePipes(line: string): boolean {
    let inCode = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line.charAt(index);
      if (character === '`' && !MarkdownParser.isEscaped(line, index)) {
        inCode = !inCode;
      } else if (character === '|' && !inCode && !MarkdownParser.isEscaped(line, index)) {
        return true;
      }
    }
    return false;
  }

  private static splitTableRow(line: string): string[] {
    let source = line.trim();
    if (source.startsWith('|')) {
      source = source.slice(1);
    }
    if (source.endsWith('|') && !MarkdownParser.isEscaped(source, source.length - 1)) {
      source = source.slice(0, -1);
    }
    const cells: string[] = [];
    let current = '';
    let inCode = false;
    let index = 0;
    while (index < source.length) {
      const character = source.charAt(index);
      if (character === '\\' && source.charAt(index + 1) === '|') {
        current += '|';
        index += 2;
        continue;
      }
      if (character === '`') {
        inCode = !inCode;
        current += character;
        index += 1;
        continue;
      }
      if (character === '|' && !inCode) {
        cells.push(current.trim());
        current = '';
      } else {
        current += character;
      }
      index += 1;
    }
    cells.push(current.trim());
    return cells;
  }

  private static tableAlignment(separator: string): string {
    const value = separator.trim();
    if (value.startsWith(':') && value.endsWith(':')) {
      return 'center';
    }
    if (value.endsWith(':')) {
      return 'right';
    }
    return 'left';
  }

  private static buildTableRow(
    values: string[],
    alignments: string[],
    header: boolean,
    start: number,
    rowIndex: number
  ): ParsedMarkdownTableRow {
    const cells: ParsedMarkdownTableCell[] = [];
    const columnCount = Math.max(values.length, alignments.length);
    for (let column = 0; column < columnCount; column += 1) {
      const text = column < values.length ? values[column] : '';
      const id = `table-${start}-${rowIndex}-${column}`;
      const inlines = MarkdownParser.parseInlineText(text, id);
      cells.push({
        id,
        text: MarkdownParser.plainInlineText(inlines),
        inlines,
        alignment: column < alignments.length ? alignments[column] : 'left'
      });
    }
    return {
      id: `table-${start}-row-${rowIndex}`,
      header,
      cells
    };
  }
}
