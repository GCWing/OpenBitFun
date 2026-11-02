import type { Nodes, Parent, Root, TableCell } from 'mdast';
import { parseEntities } from 'parse-entities';

const ESCAPE = /[!-/:-@\[-`{-~]/;
const OPAQUE = new Set(['inlineCode', 'inlineMath', 'html', 'link', 'linkReference', 'image', 'imageReference']);

/** Decode a sliced text node without interpreting escaped ampersands as entities. */
function decodeText(source: string): string {
  let result = '';
  let start = 0;
  for (let i = 0; i < source.length - 1; i += 1) {
    if (source[i] === '\\' && ESCAPE.test(source[i + 1])) {
      result += parseEntities(source.slice(start, i), { nonTerminated: false }) + source[i + 1];
      i += 1;
      start = i + 1;
    }
  }
  return result + parseEntities(source.slice(start), { nonTerminated: false });
}

// Accept only a destination/title that could still become a valid inline link.
// A real closing parenthesis is left entirely to the Markdown parser.
function isPendingDestination(source: string): boolean {
  let i = 0;
  while (source[i] === ' ' || source[i] === '\t') i += 1;
  const angle = source[i] === '<';
  if (angle) i += 1;
  let depth = 0;
  for (; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\' && ESCAPE.test(source[i + 1] ?? '')) { i += 1; continue; }
    if (angle) {
      if (char === '<') return false;
      if (char === '>') { i += 1; break; }
    } else {
      if (char === '(') depth += 1;
      if (char === ')') {
        if (depth === 0) return false;
        depth -= 1;
      }
      if (char === ' ' || char === '\t') {
        if (depth > 0) return false;
        break;
      }
      if (char === '<' || char.charCodeAt(0) < 32) return false;
    }
  }
  if (i === source.length) return true;
  const whitespaceStart = i;
  while (source[i] === ' ' || source[i] === '\t') i += 1;
  if (i === source.length) return true;
  if (i === whitespaceStart) return false;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== '(') return false;
  const close = quote === '(' ? ')' : quote;
  for (i += 1; i < source.length; i += 1) {
    if (source[i] === '\\' && ESCAPE.test(source[i + 1] ?? '')) { i += 1; continue; }
    if (quote === '(' && source[i] === '(') return false;
    if (source[i] === close) return /^[ \t]*$/.test(source.slice(i + 1));
  }
  return true;
}

function pendingLabel(cell: TableCell, source: string, start: number, end: number) {
  const opaque: Array<{ start: number; end: number }> = [];
  const collect = (node: Nodes) => {
    if (OPAQUE.has(node.type)) {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (from !== undefined && to !== undefined) opaque.push({ start: from, end: to });
    } else if ('children' in node) node.children.forEach(collect);
  };
  collect(cell);
  let range = 0;
  let escapedAt = -1;
  const brackets: Array<{ offset: number; image: boolean }> = [];
  for (let i = start; i < end; i += 1) {
    while (opaque[range] && opaque[range].end <= i) range += 1;
    if (opaque[range] && opaque[range].start <= i) { i = opaque[range].end - 1; continue; }
    if (source[i] === '\\' && ESCAPE.test(source[i + 1] ?? '')) { i += 1; escapedAt = i; continue; }
    if (source[i] === '[') brackets.push({ offset: i, image: source[i - 1] === '!' && escapedAt !== i - 1 });
    if (source[i] !== ']') continue;
    const open = brackets.pop();
    if (!open || brackets.length || source[i + 1] !== '(') continue;
    // Do not reinterpret a malformed earlier candidate or incomplete image.
    if (open.image || !isPendingDestination(source.slice(i + 2, end))) return;
    return { start: open.offset + 1, end: i };
  }
}

function keepLabel(nodes: TableCell['children'], source: string, open: number, label: { start: number; end: number }): TableCell['children'] | undefined {
  const result: TableCell['children'] = [];
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    // GFM can replace escaped bare URLs with positionless siblings. Leave that
    // cell untouched rather than guessing offsets or dropping existing content.
    if (start === undefined || end === undefined) return;
    if (end <= open || (start >= label.start && end <= label.end)) {
      result.push(node);
      continue;
    }
    if (start >= label.end) break;
    if (node.type === 'text') {
      const prefix = start < open ? source.slice(start, Math.min(end, open)) : '';
      const text = source.slice(Math.max(start, label.start), Math.min(end, label.end));
      result.push({ ...node, value: decodeText(prefix) + decodeText(text) });
    } else if ('children' in node) {
      const children = keepLabel(node.children, source, open, label);
      if (!children) return;
      result.push({ ...node, children });
    }
  }
  return result;
}

/** Hide only an unfinished inline-link destination in the actively streamed table cell. */
export function remarkStreamingTableLinks(options?: { isStreaming: boolean }) {
  return (tree: Root, file: { value: unknown }) => {
    if (!options?.isStreaming) return;
    const source = String(file.value);
    // A newline or a cell separator commits the cell; never conceal old malformed text.
    if (!source || /[\r\n]/.test(source[source.length - 1])) return;
    let node: Nodes = tree;
    while ('children' in node && node.type !== 'tableCell') {
      const children: Parent['children'] = node.children;
      if (!children.length) return;
      node = children[children.length - 1];
    }
    if (node.type !== 'tableCell') return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !/^[ \t]*$/.test(source.slice(end))) return;
    if (source.slice(start, end).includes('\n')) return;
    const label = pendingLabel(node, source, start, end);
    if (label) {
      const children = keepLabel(node.children, source, label.start - 1, label);
      if (children) node.children = children;
    }
  };
}
