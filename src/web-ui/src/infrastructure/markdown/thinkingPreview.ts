import type { BaseNode, ParsedNode } from 'stream-markdown-parser';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

/** Product presentation fields on the streaming parser's nodes. */
export interface ThinkingNode extends BaseNode {
  children?: ParsedNode[];
  content?: string;
  language?: string;
  level?: number;
  ordered?: boolean;
  start?: number;
  items?: ParsedNode[];
  header?: ThinkingNode;
  rows?: ThinkingNode[];
  cells?: ThinkingNode[];
  align?: string;
  href?: string;
  src?: string;
  alt?: string;
  title?: string | null;
  checked?: boolean;
  id?: string;
}

const text = (content: string): ParsedNode => ({ type: 'text', raw: content, content });
const inline = (type: string, children: ParsedNode[]): ParsedNode => ({ type, raw: '', children } as ParsedNode);
const previews = new WeakMap<ParsedNode, ParsedNode[]>();
const htmlBlocks = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dt', 'dd',
  'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li',
  'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);

// Only exceptional HTML/file-image fragments use the existing safe Markdown
// pipeline. Ordinary streaming text stays on the incremental parser's AST.
const fragmentParser = unified().use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitize);

function fragmentNodes(source: string): ParsedNode[] {
  const tree = fragmentParser.runSync(fragmentParser.parse(source));
  const convert = (node: (typeof tree.children)[number]): ParsedNode[] => {
    if (node.type === 'text') return [text(node.value)];
    if (node.type !== 'element') return [];
    const children = node.children.flatMap(convert);
    switch (node.tagName) {
      case 'img': return [text(String(node.properties.alt ?? ''))];
      case 'br': return [{ type: 'hardbreak', raw: '\n' } as ParsedNode];
      case 'hr': return [];
      case 'strong': case 'b': return [inline('strong', children)];
      case 'em': case 'i': return [inline('emphasis', children)];
      case 'del': case 's': return [inline('strikethrough', children)];
      case 'a': return [{ type: 'link', raw: '', href: String(node.properties.href ?? ''), children } as ParsedNode];
      case 'code': return [{ type: 'inline_code', raw: '', code: node.children.map(child => child.type === 'text' ? child.value : '').join('').replace(/\s+/g, ' ') } as ParsedNode];
      default: return htmlBlocks.has(node.tagName) ? [...children, text(' ')] : children;
    }
  };
  return tree.children.flatMap(convert);
}

function inlineNodes(nodes: ParsedNode[] = [], trimTrailing = false): ParsedNode[] {
  const result = nodes.flatMap(projectNode);
  // A trailing break/empty format must not replace the last readable line.
  while (trimTrailing && result.length) {
    const last = result[result.length - 1] as ThinkingNode;
    if (last.type === 'hardbreak' || last.type === 'softbreak'
      || (last.type === 'text' && !last.content?.trim())) result.pop();
    else break;
  }
  return result;
}

function projectNode(source: ParsedNode): ParsedNode[] {
  const cached = previews.get(source);
  if (cached) return cached;
  const node = source as ThinkingNode;
  let result: ParsedNode[];
  switch (node.type) {
    case 'text': case 'text_special':
      result = [source];
      break;
    case 'paragraph': case 'inline':
      result = node.raw.includes('![') && /file:/i.test(node.raw)
        ? inlineNodes(fragmentNodes(node.raw), true) : inlineNodes(node.children, true);
      break;
    case 'heading': {
      const children = inlineNodes(node.children, true);
      result = children.length ? [inline('strong', children)] : [];
      break;
    }
    case 'strong': case 'emphasis': case 'strikethrough': case 'link': {
      const children = inlineNodes(node.children);
      result = children.length ? [{ ...node, children } as ParsedNode] : [];
      break;
    }
    case 'inline_code':
      result = node.code?.trim() ? [{ ...node, code: node.code.replace(/\r?\n/g, ' ') } as ParsedNode] : [];
      break;
    case 'code_block': case 'mermaid': case 'd2': case 'infographic': {
      const code = (node.code ?? node.content ?? '').trimEnd();
      // Read just the latest nonempty logical line; browser wrapping handles
      // long lines at the available width without measuring or scrolling DOM.
      const line = code.slice(code.lastIndexOf('\n') + 1).trimStart();
      result = line ? [text(line)] : [];
      break;
    }
    case 'list':
      result = getThinkingPreview(node.items ?? []);
      break;
    case 'list_item': case 'blockquote': case 'footnote':
      result = getThinkingPreview(node.children ?? []);
      break;
    case 'table': {
      result = [];
      const rows = [...(node.header ? [node.header] : []), ...(node.rows ?? [])];
      for (let index = rows.length - 1; index >= 0 && !result.length; index--) {
        const cells = rows[index].cells?.map(cell => cell.raw.includes('![') && /file:/i.test(cell.raw)
          ? inlineNodes(fragmentNodes(cell.raw), true) : inlineNodes(cell.children, true)).filter(cell => cell.length) ?? [];
        result = cells.flatMap((cell, index) => index ? [text(' · '), ...cell] : cell);
      }
      break;
    }
    case 'image': result = node.alt?.trim() ? [text(node.alt)] : []; break;
    case 'math_inline': case 'math_block':
      result = node.content?.trim() ? [text(node.content.trim().replace(/\s+/g, ' '))] : [];
      break;
    case 'html_inline': case 'html_block':
      result = inlineNodes(fragmentNodes(node.content ?? node.raw), true);
      break;
    case 'softbreak': result = [text(' ')]; break;
    case 'hardbreak': result = [source]; break;
    case 'checkbox': case 'checkbox_input': result = [text(node.checked ? '☑ ' : '☐ ')]; break;
    case 'footnote_reference': result = node.id ? [text(`[${node.id}]`)] : []; break;
    case 'thematic_break': case 'label_open': case 'label_close': case 'footnote_anchor': case 'reference':
      result = [];
      break;
    default:
      result = node.children ? inlineNodes(node.children) : node.content?.trim() ? [text(node.content)] : [];
  }
  previews.set(source, result);
  return result;
}

/** Latest readable block, with inline formatting and no multi-line box geometry. */
export function getThinkingPreview(nodes: ParsedNode[]): ParsedNode[] {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const result = inlineNodes([nodes[index]], true);
    if (result.length) return result;
  }
  return [];
}
