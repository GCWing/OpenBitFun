import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import remarkStringify from 'remark-stringify';
import { parseEntities } from 'parse-entities';
import type { PhrasingContent, Root, Strong, Emphasis, Delete, Link as MarkdownLink } from 'mdast';
import rehypeRaw from 'rehype-raw';
import type { JSONContent } from '@tiptap/core';
import { createBlockId } from './blockId';
import { serializeMarkdownFrontmatter, splitMarkdownFrontmatter } from './markdownFrontmatter';

type MdastNode = {
  type?: string;
  value?: string;
  source?: string;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  align?: Array<string | null>;
  children?: MdastNode[];
  position?: {
    start?: {
      offset?: number;
      column?: number;
    };
    end?: {
      offset?: number;
    };
  };
};

type Mark = {
  type: string;
  attrs?: Record<string, unknown>;
};

type TiptapMarkdownOptions = {
  preserveTrailingNewline?: boolean;
};

export type MarkdownEditabilityMode = 'lossless' | 'canonicalizable' | 'unsafe';

export interface MarkdownEditabilityAnalysis {
  mode: MarkdownEditabilityMode;
  canonicalMarkdown: string;
  textEqual: boolean;
  semanticEqual: boolean;
  containsRenderOnlyBlocks: boolean;
  containsRawHtmlBlocks: boolean;
  containsRawHtmlInlines: boolean;
  hardIssues: string[];
  softIssues: string[];
}

export interface TiptapTopLevelMarkdownBlock {
  blockId?: string;
  markdown: string;
}

type AlignmentStackEntry = {
  align: string | null;
  groupId: number | null;
};

type AlignmentState = {
  activeAlign: string | null;
  activeGroupId: number | null;
  nextGroupId: number;
  stack: AlignmentStackEntry[];
};

type ComparableJsonValue =
  | null
  | boolean
  | number
  | string
  | ComparableJsonValue[]
  | { [key: string]: ComparableJsonValue };

type HtmlToken =
  | {
      kind: 'open' | 'close' | 'self';
      tagName: string;
      attrs: Record<string, string>;
      raw: string;
    }
  | {
      kind: 'text';
      value: string;
    };

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Unsupported syntax stays in the smallest containing Markdown block, rather
// than disabling rich text for the whole document or dropping unknown nodes.
const NATIVE_MARKDOWN_TYPES = new Set([
  'paragraph', 'heading', 'text', 'html', 'inlineCode', 'image', 'strong',
  'emphasis', 'delete', 'link', 'break', 'blockquote', 'list', 'listItem',
  'table', 'tableRow', 'tableCell', 'code', 'thematicBreak', 'inlineMath',
]);

const TOP_LEVEL_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'markdownTable',
  'details',
  'frontmatter',
  'renderOnlyBlock',
  'rawHtmlBlock',
]);

const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const HTML_BOLD_TAGS = new Set(['strong', 'b']);
const HTML_ITALIC_TAGS = new Set(['em', 'i']);
const SOURCE_ONLY_HTML_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'video',
  'audio',
  'canvas',
  'svg',
  'math',
]);

const markdownHtmlProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw);

function createTextNode(text: string, marks: Mark[] = []): JSONContent[] {
  if (!text) {
    return [];
  }

  return [{
    type: 'text',
    text,
    ...(marks.length > 0 ? { marks } : {}),
  }];
}

function createParagraph(content: JSONContent[] = []): JSONContent {
  return {
    type: 'paragraph',
    ...(content.length > 0 ? { content } : {}),
  };
}

function createRawHtmlBlock(html: string): JSONContent {
  return {
    type: 'rawHtmlBlock',
    attrs: {
      html,
    },
  };
}

function createRenderOnlyBlock(markdown: string, kind: string): JSONContent {
  return {
    type: 'renderOnlyBlock',
    attrs: {
      markdown,
      kind,
    },
  };
}

function createFrontmatterBlock(
  frontmatter: NonNullable<ReturnType<typeof splitMarkdownFrontmatter>>,
  bodyPrefix: string,
): JSONContent {
  return {
    type: 'frontmatter',
    attrs: {
      yaml: frontmatter.yaml,
      delimiter: frontmatter.delimiter,
      openingLineEnding: frontmatter.openingLineEnding,
      contentLineEnding: frontmatter.contentLineEnding,
      closingLineEnding: frontmatter.closingLineEnding,
      bodyPrefix,
    },
  };
}

function getLeadingBlankLines(markdown: string): string {
  return markdown.match(/^(?:[\t ]*\r?\n)+/)?.[0] ?? '';
}

function serializeFrontmatterNode(node: JSONContent): string {
  return serializeMarkdownFrontmatter({
    delimiter: node.attrs?.delimiter === '+++' ? '+++' : '---',
    yaml: String(node.attrs?.yaml ?? ''),
    openingLineEnding: node.attrs?.openingLineEnding === '\r\n' ? '\r\n' : '\n',
    contentLineEnding: node.attrs?.contentLineEnding === '\r\n'
      ? '\r\n'
      : node.attrs?.contentLineEnding === '\n'
        ? '\n'
        : '',
    closingLineEnding: node.attrs?.closingLineEnding === '\r\n'
      ? '\r\n'
      : node.attrs?.closingLineEnding === '\n'
        ? '\n'
        : '',
  });
}

function withBlockAttrs(node: JSONContent, align: string | null, alignGroup: number | null): JSONContent {
  if (!node.type || !TOP_LEVEL_BLOCK_TYPES.has(node.type)) {
    return node;
  }

  return {
    ...node,
    attrs: {
      ...node.attrs,
      ...(align ? { align } : {}),
      ...(alignGroup !== null ? { alignGroup } : {}),
    },
  };
}

function withTopLevelBlockIds(content: JSONContent[]): JSONContent[] {
  return content.map(node => {
    if (!node.type || !TOP_LEVEL_BLOCK_TYPES.has(node.type)) {
      return node;
    }

    return {
      ...node,
      attrs: {
        ...node.attrs,
        blockId: typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : createBlockId(),
      },
    };
  });
}

function flattenText(node: MdastNode | null | undefined): string {
  if (!node) {
    return '';
  }

  if (node.type === 'text' || node.type === 'inlineCode') {
    return node.value ?? '';
  }

  return (node.children ?? []).map(child => flattenText(child)).join('');
}

function parseHtmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrPattern = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attrPattern.exec(raw)) !== null) {
    const [, name, doubleQuoted, singleQuoted, unquoted] = match;
    if (!name) {
      continue;
    }

    attributes[name.toLowerCase()] = parseEntities(doubleQuoted ?? singleQuoted ?? unquoted ?? '', { attribute: true });
  }

  return attributes;
}

function parseSingleHtmlTagToken(raw: string): Exclude<HtmlToken, { kind: 'text' }> | null {
  const match = raw.match(/^<\s*(\/)?\s*([A-Za-z][\w:-]*)([\s\S]*?)\s*(\/)?\s*>$/);
  if (!match) {
    return null;
  }

  const [, closingSlash, tagNameRaw, attrSource = '', selfClosingSlash] = match;
  const tagName = tagNameRaw.toLowerCase();
  const attrs = parseHtmlAttributes(attrSource);

  if (closingSlash) {
    return {
      kind: 'close',
      tagName,
      attrs: {},
      raw,
    };
  }

  return {
    kind: selfClosingSlash || HTML_VOID_TAGS.has(tagName) ? 'self' : 'open',
    tagName,
    attrs,
    raw,
  };
}

function tokenizeInlineHtmlFragment(fragment: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const tagPattern = /<\/?[^>]+?>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(fragment)) !== null) {
    if (match.index > cursor) {
      tokens.push({
        kind: 'text',
        value: fragment.slice(cursor, match.index),
      });
    }

    const raw = match[0];
    const parsed = parseSingleHtmlTagToken(raw);
    tokens.push(parsed ?? { kind: 'text', value: raw });
    cursor = match.index + raw.length;
  }

  if (cursor < fragment.length) {
    tokens.push({
      kind: 'text',
      value: fragment.slice(cursor),
    });
  }

  return tokens;
}

function removeLastMatchingMark(
  marks: Mark[],
  predicate: (mark: Mark) => boolean,
): Mark[] | null {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    if (!predicate(marks[index])) {
      continue;
    }

    const nextMarks = [...marks];
    nextMarks.splice(index, 1);
    return nextMarks;
  }

  return null;
}

function convertHtmlInlineTokens(
  tokens: HtmlToken[],
  baseMarks: Mark[] = [],
  options: { strict?: boolean } = {},
): { content: JSONContent[]; fullyStructured: boolean; activeMarks: Mark[] } {
  let activeMarks = [...baseMarks];
  let fullyStructured = true;
  const content: JSONContent[] = [];

  const appendRawHtml = (html: string) => {
    fullyStructured = false;
    content.push({
      type: 'rawHtmlInline',
      attrs: {
        html,
      },
      ...(activeMarks.length > 0 ? { marks: activeMarks } : {}),
    });
  };

  const appendText = (text: string) => {
    content.push(...createTextNode(text, activeMarks));
  };

  for (const token of tokens) {
    if (token.kind === 'text') {
      appendText(parseEntities(token.value));
      continue;
    }

    const supportedAttrs = token.tagName === 'a' ? ['href', 'title']
      : token.tagName === 'img' ? ['src', 'alt', 'title'] : [];
    if (Object.keys(token.attrs).some(name => !supportedAttrs.includes(name))) {
      appendRawHtml(token.raw);
      continue;
    }

    if (token.kind === 'self' && token.tagName === 'br') {
      content.push({ type: 'hardBreak', ...(activeMarks.length > 0 ? { marks: activeMarks } : {}) });
      continue;
    }

    if (token.kind === 'self' && token.tagName === 'img') {
      content.push({
        type: 'markdownImage',
        attrs: {
          src: token.attrs.src ?? '',
          alt: token.attrs.alt ?? '',
          title: token.attrs.title ?? null,
        },
        ...(activeMarks.length > 0 ? { marks: activeMarks } : {}),
      });
      continue;
    }

    if (['del', 's', 'strike', 'u'].includes(token.tagName)) {
      const type = token.tagName === 'u' ? 'underline' : 'strike';
      if (token.kind === 'open') {
        activeMarks = [...activeMarks, { type }];
        continue;
      }
      if (token.kind === 'close') {
        const nextMarks = removeLastMatchingMark(activeMarks, mark => mark.type === type);
        if (nextMarks) { activeMarks = nextMarks; continue; }
      }
    }

    if (token.kind === 'open' && HTML_BOLD_TAGS.has(token.tagName)) {
      activeMarks = [...activeMarks, { type: 'bold' }];
      continue;
    }

    if (token.kind === 'close' && HTML_BOLD_TAGS.has(token.tagName)) {
      const nextMarks = removeLastMatchingMark(activeMarks, mark => mark.type === 'bold');
      if (!nextMarks) {
        if (options.strict) {
          return { content: [], fullyStructured: false, activeMarks };
        }
        appendRawHtml(token.raw);
        continue;
      }
      activeMarks = nextMarks;
      continue;
    }

    if (token.kind === 'open' && HTML_ITALIC_TAGS.has(token.tagName)) {
      activeMarks = [...activeMarks, { type: 'italic' }];
      continue;
    }

    if (token.kind === 'close' && HTML_ITALIC_TAGS.has(token.tagName)) {
      const nextMarks = removeLastMatchingMark(activeMarks, mark => mark.type === 'italic');
      if (!nextMarks) {
        if (options.strict) {
          return { content: [], fullyStructured: false, activeMarks };
        }
        appendRawHtml(token.raw);
        continue;
      }
      activeMarks = nextMarks;
      continue;
    }

    if (token.tagName === 'code') {
      if (token.kind === 'open') {
        activeMarks = [...activeMarks, { type: 'code' }];
        continue;
      }

      if (token.kind === 'close') {
        const nextMarks = removeLastMatchingMark(activeMarks, mark => mark.type === 'code');
        if (!nextMarks) {
          if (options.strict) {
            return { content: [], fullyStructured: false, activeMarks };
          }
          appendRawHtml(token.raw);
          continue;
        }
        activeMarks = nextMarks;
        continue;
      }
    }

    if (token.tagName === 'a') {
      if (token.kind === 'open' && Object.prototype.hasOwnProperty.call(token.attrs, 'href')) {
        activeMarks = [...activeMarks, { type: 'link', attrs: { href: token.attrs.href, ...(token.attrs.title !== undefined ? { title: token.attrs.title } : {}) } }];
        continue;
      }

      if (token.kind === 'close') {
        const nextMarks = removeLastMatchingMark(activeMarks, mark => mark.type === 'link');
        if (!nextMarks) {
          if (options.strict) {
            return { content: [], fullyStructured: false, activeMarks };
          }
          appendRawHtml(token.raw);
          continue;
        }
        activeMarks = nextMarks;
        continue;
      }
    }

    if (options.strict) {
      return { content: [], fullyStructured: false, activeMarks };
    }

    appendRawHtml(token.raw);
  }

  if (activeMarks.length !== baseMarks.length) {
    if (options.strict) {
      return { content: [], fullyStructured: false, activeMarks };
    }

    fullyStructured = false;
  }

  return { content, fullyStructured, activeMarks };
}

function convertInlineNodes(nodes: MdastNode[], marks: Mark[] = []): JSONContent[] {
  const content: JSONContent[] = [];
  let activeMarks = [...marks];

  nodes.forEach((node) => {
    switch (node.type) {
      case 'text':
        content.push(...createTextNode(node.value ?? '', activeMarks));
        return;
      case 'html': {
        const htmlFragment = convertHtmlInlineTokens(tokenizeInlineHtmlFragment(node.value ?? ''), activeMarks);
        content.push(...htmlFragment.content);
        activeMarks = htmlFragment.activeMarks;
        return;
      }
      case 'inlineMath':
        content.push({ type: 'inlineMath', attrs: { markdown: node.source ?? `$${node.value ?? ''}$`, kind: 'inlineMath' },
          ...(activeMarks.length ? { marks: activeMarks } : {}) });
        return;
      case 'inlineCode':
        content.push(...createTextNode(node.value ?? '', [...activeMarks, { type: 'code' }]));
        return;
      case 'image':
        content.push({
          type: 'markdownImage',
          attrs: {
            src: node.url ?? '',
            alt: node.alt ?? '',
            title: node.title ?? null,
          },
          ...(activeMarks.length > 0 ? { marks: activeMarks } : {}),
        });
        return;
      case 'strong':
        content.push(...convertInlineNodes(node.children ?? [], [...activeMarks, { type: 'bold' }]));
        return;
      case 'emphasis':
        content.push(...convertInlineNodes(node.children ?? [], [...activeMarks, { type: 'italic' }]));
        return;
      case 'delete':
        content.push(...convertInlineNodes(node.children ?? [], [...activeMarks, { type: 'strike' }]));
        return;
      case 'link':
        content.push(...convertInlineNodes(node.children ?? [], [
          ...activeMarks,
          { type: 'link', attrs: { href: node.url ?? '', ...(node.title !== null && node.title !== undefined ? { title: node.title } : {}) } },
        ]));
        return;
      case 'break':
        content.push({ type: 'hardBreak', ...(activeMarks.length > 0 ? { marks: activeMarks } : {}) });
        return;
      default:
        content.push(...convertInlineNodes(node.children ?? [], activeMarks));
    }
  });

  return content;
}

function convertListItemContent(node: MdastNode): JSONContent[] {
  const content = (node.children ?? []).flatMap(child => convertBlock(child));
  return content.length > 0 ? content : [createParagraph()];
}

function isTaskList(node: MdastNode): boolean {
  const items = node.children ?? [];
  return items.length > 0 && items.every(item => typeof item.checked === 'boolean');
}

function convertList(node: MdastNode): JSONContent[] {
  const hasTasks = node.children?.some(item => typeof item.checked === 'boolean');
  if (hasTasks && (node.ordered || !isTaskList(node)) && node.source !== undefined) {
    // Native task lists cannot represent unchecked-vs-non-task membership or
    // ordered task markers. Preserve just this list, including nested lists.
    return [createRenderOnlyBlock(node.source, 'list')];
  }
  if (isTaskList(node)) {
    return [{
      type: 'taskList',
      content: (node.children ?? []).map(item => ({
        type: 'taskItem',
        attrs: {
          checked: !!item.checked,
        },
        content: convertListItemContent(item),
      })),
    }];
  }

  return [{
    type: node.ordered ? 'orderedList' : 'bulletList',
    ...(node.ordered ? { attrs: { start: node.start ?? 1 } } : {}),
    content: (node.children ?? []).map(item => ({
      type: 'listItem',
      content: convertListItemContent(item),
    })),
  }];
}

function convertTableCell(node: MdastNode, type: 'markdownTableHeader' | 'markdownTableCell'): JSONContent {
  const inline = convertInlineNodes(node.children ?? []);
  return {
    type,
    ...(inline.length > 0 ? { content: inline } : {}),
  };
}

function convertTable(node: MdastNode): JSONContent[] {
  const rows = node.children ?? [];

  return [{
    type: 'markdownTable',
    attrs: {
      align: node.align ?? [],
    },
    content: rows.map((row, rowIndex) => ({
      type: 'markdownTableRow',
      content: (row.children ?? []).map(cell => convertTableCell(
        cell,
        rowIndex === 0 ? 'markdownTableHeader' : 'markdownTableCell',
      )),
    })),
  }];
}

function convertBlock(node: MdastNode): JSONContent[] {
  if (node.source && (node.type === 'math' || (node.type === 'code' &&
      (node.lang?.toLowerCase() === 'mermaid' || node.meta)))) {
    return [createRenderOnlyBlock(node.source, node.type)];
  }
  switch (node.type) {
    case 'paragraph': {
      const inline = convertInlineNodes(node.children ?? []);
      return [createParagraph(inline)];
    }
    case 'heading': {
      const inline = convertInlineNodes(node.children ?? []);
      return [{
        type: 'heading',
        attrs: { level: Math.min(Math.max(node.depth ?? 1, 1), 6) },
        ...(inline.length > 0 ? { content: inline } : {}),
      }];
    }
    case 'blockquote':
      return [{
        type: 'blockquote',
        content: (node.children ?? []).flatMap(child => convertBlock(child)),
      }];
    case 'list':
      return convertList(node);
    case 'table':
      return convertTable(node);
    case 'code':
      return [{
        type: 'codeBlock',
        attrs: {
          language: node.lang ?? null,
        },
        content: createTextNode(node.value ?? ''),
      }];
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'image':
      return [createParagraph(createTextNode(`![${flattenText(node)}](${node.url ?? ''})`))];
    case 'html':
      return node.value ? [createRawHtmlBlock(node.value)] : [];
    default:
      if (node.children?.length) {
        return node.children.flatMap(child => convertBlock(child));
      }

      return node.value ? [createParagraph(createTextNode(node.value))] : [];
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function walkMdast(node: MdastNode | null | undefined, visit: (current: MdastNode) => void): void {
  if (!node) {
    return;
  }

  visit(node);
  (node.children ?? []).forEach(child => {
    walkMdast(child, visit);
  });
}

function parseMarkdownTree(markdown: string): MdastNode {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .parse(markdown) as MdastNode;
  walkMdast(tree, node => {
    if (node.type === 'inlineMath' || node.type === 'math' || node.type === 'code' || node.type === 'list') {
      const raw = markdown.slice(node.position?.start?.offset, node.position?.end?.offset);
      const indent = Math.max(0, (node.position?.start?.column ?? 1) - 1);
      node.source = raw.split('\n').map((line, index) => index === 0 ? line
        : line.replace(new RegExp(`^[ \t>]{0,${indent}}`), '')).join('\n');
    }
  });
  return tree;
}

function normalizeComparableJson(
  value: ComparableJsonValue,
  keysToStrip: Set<string>,
  currentKey?: string,
): ComparableJsonValue {
  if (Array.isArray(value)) {
    const normalizedArray = value.map(item => normalizeComparableJson(item, keysToStrip, currentKey));
    if (currentKey === 'marks') {
      return [...normalizedArray].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return normalizedArray;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, ComparableJsonValue> = {};

  Object.entries(value).forEach(([key, entryValue]) => {
    if (keysToStrip.has(key)) {
      return;
    }

    if (key === 'attrs' && entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
      const cleanedAttrs = normalizeComparableJson(entryValue, keysToStrip, key);
      if (cleanedAttrs && typeof cleanedAttrs === 'object' && !Array.isArray(cleanedAttrs) && Object.keys(cleanedAttrs).length === 0) {
        return;
      }
      result[key] = cleanedAttrs;
      return;
    }

    result[key] = normalizeComparableJson(entryValue, keysToStrip, key);
  });

  return result;
}

function normalizeTiptapDoc(doc: JSONContent): ComparableJsonValue {
  const normalized = normalizeComparableJson(doc as ComparableJsonValue, new Set(['blockId', 'alignGroup'])) as JSONContent;
  const mergeTextRuns = (node: JSONContent): JSONContent => {
    if (!node.content) return node;
    const content: JSONContent[] = [];
    for (const child of node.content.map(mergeTextRuns)) {
      const last = content.at(-1);
      if (last?.type === 'text' && child.type === 'text' &&
          JSON.stringify(last.marks ?? []) === JSON.stringify(child.marks ?? []) &&
          JSON.stringify(last.attrs) === JSON.stringify(child.attrs)) {
        last.text = (last.text ?? '') + (child.text ?? '');
      } else content.push(child);
    }
    return { ...node, content };
  };
  return mergeTextRuns(normalized) as ComparableJsonValue;
}

function walkTiptapDoc(
  node: JSONContent | null | undefined,
  visit: (current: JSONContent) => void,
): void {
  if (!node) {
    return;
  }

  visit(node);
  (node.content ?? []).forEach(child => {
    walkTiptapDoc(child, visit);
  });
}

function getNodeStartOffset(node: MdastNode | null | undefined): number | null {
  const offset = node?.position?.start?.offset;
  return typeof offset === 'number' ? offset : null;
}

function getNodeEndOffset(node: MdastNode | null | undefined): number | null {
  const offset = node?.position?.end?.offset;
  return typeof offset === 'number' ? offset : null;
}

function applyHtmlTagTokens(stack: string[], html: string): string[] {
  const nextStack = [...stack];
  const tagPattern = /<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\s*\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const token = match[0];
    const tagName = match[1]?.toLowerCase();
    if (!tagName) {
      continue;
    }

    if (/^<\s*\/.*/.test(token)) {
      for (let index = nextStack.length - 1; index >= 0; index -= 1) {
        if (nextStack[index] === tagName) {
          nextStack.splice(index, 1);
          break;
        }
      }
      continue;
    }

    if (token.endsWith('/>') || HTML_VOID_TAGS.has(tagName)) {
      continue;
    }

    nextStack.push(tagName);
  }

  return nextStack;
}

function consumeRawHtmlRegion(
  children: MdastNode[],
  startIndex: number,
  markdown: string,
): { node: JSONContent; nextIndex: number } | null {
  const firstNode = children[startIndex];
  if (firstNode.type !== 'html' || !firstNode.value) {
    return null;
  }

  const startOffset = getNodeStartOffset(firstNode);
  const initialEndOffset = getNodeEndOffset(firstNode);
  if (startOffset === null || initialEndOffset === null) {
    return {
      node: createRawHtmlBlock(firstNode.value),
      nextIndex: startIndex + 1,
    };
  }

  let endOffset = initialEndOffset;
  let stack = applyHtmlTagTokens([], firstNode.value);

  if (stack.length === 0) {
    return {
      node: createRawHtmlBlock(markdown.slice(startOffset, endOffset)),
      nextIndex: startIndex + 1,
    };
  }

  let cursor = startIndex + 1;

  while (cursor < children.length) {
    const currentNode = children[cursor];
    const currentEndOffset = getNodeEndOffset(currentNode);
    if (currentEndOffset === null) {
      break;
    }

    endOffset = currentEndOffset;

    if (currentNode.type === 'html' && currentNode.value) {
      stack = applyHtmlTagTokens(stack, currentNode.value);
      if (stack.length === 0) {
        return {
          node: createRawHtmlBlock(markdown.slice(startOffset, endOffset)),
          nextIndex: cursor + 1,
        };
      }
    }

    cursor += 1;
  }

  return {
    node: createRawHtmlBlock(markdown.slice(startOffset, endOffset)),
    nextIndex: cursor,
  };
}

function parseSingleHtmlElement(
  html: string,
): { tagName: string; attrs: Record<string, string>; innerHtml: string } | null {
  const trimmed = html.trim();
  const match = trimmed.match(/^<([A-Za-z][\w:-]*)([\s\S]*?)>([\s\S]*)<\/\1>$/);
  if (!match) {
    return null;
  }

  const [, tagNameRaw, attrSource = '', innerHtml = ''] = match;
  return {
    tagName: tagNameRaw.toLowerCase(),
    attrs: parseHtmlAttributes(attrSource),
    innerHtml,
  };
}

function convertStructuredHtmlBlock(html: string): JSONContent[] | null {
  const tagToken = parseSingleHtmlTagToken(html.trim());
  if (tagToken && tagToken.kind === 'self' && tagToken.tagName === 'img' &&
      Object.keys(tagToken.attrs).every(name => ['src', 'alt', 'title'].includes(name))) {
    return [createParagraph([{
      type: 'markdownImage',
      attrs: {
        src: tagToken.attrs.src ?? '',
        alt: tagToken.attrs.alt ?? '',
        title: tagToken.attrs.title ?? null,
      },
    }])];
  }

  const element = parseSingleHtmlElement(html);
  if (!element) {
    return null;
  }

  if (element.tagName !== 'p' || Object.keys(element.attrs).some(name => name !== 'align')) {
    return null;
  }

  const align = element.attrs.align?.toLowerCase() ?? null;
  if (align && !['left', 'center', 'right'].includes(align)) {
    return null;
  }

  const inlineFragment = convertHtmlInlineTokens(tokenizeInlineHtmlFragment(element.innerHtml), [], { strict: true });
  if (!inlineFragment.fullyStructured) {
    return null;
  }

  return [{
    ...createParagraph(inlineFragment.content),
    attrs: {
      ...(align ? { align } : {}),
    },
  }];
}

function normalizeDetailsBodyMarkdown(markdown: string): string {
  return markdown
    .replace(/^\s*\n/, '')
    .replace(/\n\s*$/, '');
}

function parseMarkdownHtmlTree(markdown: string): HastNode | null {
  try {
    return markdownHtmlProcessor.runSync(markdownHtmlProcessor.parse(markdown)) as HastNode;
  } catch {
    return null;
  }
}

function isWhitespaceHastTextNode(node: HastNode | null | undefined): boolean {
  return node?.type === 'text' && !(node.value ?? '').trim();
}

function getNonWhitespaceHastChildren(node: HastNode | null | undefined): HastNode[] {
  return (node?.children ?? []).filter(child => !isWhitespaceHastTextNode(child));
}

function isHastElement(node: HastNode | null | undefined, tagName?: string): boolean {
  return node?.type === 'element' && (!tagName || node.tagName === tagName);
}

function getHastTextContent(node: HastNode | null | undefined): string {
  if (!node) {
    return '';
  }

  if (node.type === 'text') {
    return node.value ?? '';
  }

  return (node.children ?? []).map(child => getHastTextContent(child)).join('');
}

function matchDetailsMarkdownRegion(markdown: string): {
  attrSource: string;
  bodyRaw: string;
} | null {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^<details(\s[^>]*)?>\s*<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)\s*<\/details>$/);
  if (!match) {
    return null;
  }

  return {
    attrSource: match[1] ?? '',
    bodyRaw: match[2] ?? '',
  };
}

function parseDetailsAst(markdown: string): {
  detailsNode: HastNode;
  summaryNode: HastNode;
} | null {
  const root = parseMarkdownHtmlTree(markdown);
  const children = getNonWhitespaceHastChildren(root);

  if (children.length !== 1 || !isHastElement(children[0], 'details')) {
    return null;
  }

  const detailsNode = children[0];
  const detailsChildren = getNonWhitespaceHastChildren(detailsNode);
  const summaryNode = detailsChildren[0];

  if (!isHastElement(summaryNode, 'summary')) {
    return null;
  }

  return {
    detailsNode,
    summaryNode,
  };
}

function isSafeUrlValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized.startsWith('javascript:') && !normalized.startsWith('vbscript:');
}

function hasUnsafeHtmlPatterns(markdown: string): boolean {
  const tokens = tokenizeInlineHtmlFragment(markdown);

  for (const token of tokens) {
    if (token.kind === 'text') {
      continue;
    }

    if (SOURCE_ONLY_HTML_TAGS.has(token.tagName)) {
      return true;
    }

    for (const [name, value] of Object.entries(token.attrs)) {
      if (name.startsWith('on')) {
        return true;
      }

      if ((name === 'href' || name === 'src') && !isSafeUrlValue(value)) {
        return true;
      }
    }
  }

  return false;
}

function convertDetailsSummaryInlineChildren(
  nodes: HastNode[],
  marks: Mark[] = [],
): JSONContent[] | null {
  const content: JSONContent[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      content.push(...createTextNode(node.value ?? '', marks));
      continue;
    }

    if (node.type !== 'element') {
      return null;
    }

    const allowedProperties = node.tagName === 'a' ? ['href', 'title'] : [];
    if (Object.keys(node.properties ?? {}).some(key => !allowedProperties.includes(key))) return null;
    const childNodes = node.children ?? [];

    switch (node.tagName) {
      case 'strong':
      case 'b': {
        const next = convertDetailsSummaryInlineChildren(childNodes, [...marks, { type: 'bold' }]);
        if (!next) {
          return null;
        }
        content.push(...next);
        continue;
      }
      case 'em':
      case 'i': {
        const next = convertDetailsSummaryInlineChildren(childNodes, [...marks, { type: 'italic' }]);
        if (!next) {
          return null;
        }
        content.push(...next);
        continue;
      }
      case 'u': {
        const next = convertDetailsSummaryInlineChildren(childNodes, [...marks, { type: 'underline' }]);
        if (!next) return null;
        content.push(...next);
        continue;
      }
      case 'code': {
        const hasNestedElements = childNodes.some(child => child.type === 'element');
        if (hasNestedElements) {
          return null;
        }

        content.push(...createTextNode(
          getHastTextContent(node),
          [...marks, { type: 'code' }],
        ));
        continue;
      }
      case 'a': {
        const href = typeof node.properties?.href === 'string' ? node.properties.href : '';
        if (!href || !isSafeUrlValue(href)) {
          return null;
        }

        const next = convertDetailsSummaryInlineChildren(childNodes, [
          ...marks,
          { type: 'link', attrs: { href, ...(typeof node.properties?.title === 'string' ? { title: node.properties.title } : {}) } },
        ]);
        if (!next) {
          return null;
        }
        content.push(...next);
        continue;
      }
      case 'span': {
        const next = convertDetailsSummaryInlineChildren(childNodes, marks);
        if (!next) {
          return null;
        }
        content.push(...next);
        continue;
      }
      default:
        return null;
    }
  }

  return content;
}

function convertDetailsMarkdownRegion(markdown: string): JSONContent | null {
  const matchedRegion = matchDetailsMarkdownRegion(markdown);
  if (!matchedRegion) {
    return null;
  }

  const detailsAst = parseDetailsAst(markdown);
  if (!detailsAst) {
    return createRawHtmlBlock(markdown);
  }

  const { attrSource, bodyRaw } = matchedRegion;
  const { summaryNode } = detailsAst;
  if (Object.keys(summaryNode.properties ?? {}).length > 0) return createRenderOnlyBlock(markdown, 'details');
  const attrs = parseHtmlAttributes(attrSource);
  const attrNames = Object.keys(attrs);
  if (attrNames.some(name => name !== 'open')) {
    return null;
  }

  if (hasUnsafeHtmlPatterns(markdown)) {
    return createRawHtmlBlock(markdown);
  }

  const summaryContent = convertDetailsSummaryInlineChildren(summaryNode.children ?? []);
  if (summaryContent && renderInline(summaryContent).trim()) {
    const bodyMarkdown = normalizeDetailsBodyMarkdown(bodyRaw);
    const bodyTree = parseMarkdownTree(bodyMarkdown);
    const bodyContent = convertRootMarkdownChildren(bodyTree.children ?? [], bodyMarkdown);

    return {
      type: 'details',
      attrs: {
        open: Object.prototype.hasOwnProperty.call(attrs, 'open'),
      },
      content: [
        {
          type: 'detailsSummary',
          ...(summaryContent.length > 0 ? { content: summaryContent } : {}),
        },
        {
          type: 'detailsContent',
          content: bodyContent.length > 0 ? bodyContent : [createParagraph()],
        },
      ],
    };
  }

  if (!hasUnsafeHtmlPatterns(bodyRaw)) {
    return createRenderOnlyBlock(markdown, 'details');
  }

  return createRawHtmlBlock(markdown);
}

export function analyzeMarkdownEditability(markdown: string): MarkdownEditabilityAnalysis {
  if (!markdown) {
    return {
      mode: 'lossless',
      canonicalMarkdown: '',
      textEqual: true,
      semanticEqual: true,
      containsRenderOnlyBlocks: false,
      containsRawHtmlBlocks: false,
      containsRawHtmlInlines: false,
      hardIssues: [],
      softIssues: [],
    };
  }

  const hardIssues = new Set<string>();
  const softIssues = new Set<string>();
  const doc = markdownToTiptapDoc(markdown);
  let containsRenderOnlyBlocks = false;
  let containsRawHtmlBlocks = false;
  let containsRawHtmlInlines = false;

  walkTiptapDoc(doc, (node) => {
    if (node.type === 'renderOnlyBlock') {
      containsRenderOnlyBlocks = true;
    }

    if (node.type === 'rawHtmlBlock') {
      containsRawHtmlBlocks = true;
    }

    if (node.type === 'rawHtmlInline') {
      containsRawHtmlInlines = true;
    }
  });

  const canonicalMarkdown = tiptapDocToMarkdown(doc, {
    preserveTrailingNewline: markdown.endsWith('\n'),
  });
  const reparsedCanonicalDoc = markdownToTiptapDoc(canonicalMarkdown);
  const textEqual = canonicalMarkdown === markdown;
  const semanticEqual = JSON.stringify(normalizeTiptapDoc(doc)) ===
    JSON.stringify(normalizeTiptapDoc(reparsedCanonicalDoc));

  if (/^\n+/.test(markdown)) {
    softIssues.add('leadingBlankLines');
  }

  if (/\n{2,}$/.test(markdown)) {
    softIssues.add('multipleTrailingBlankLines');
  }

  if (!textEqual) {
    softIssues.add('roundTripMismatch');
  }

  if (!semanticEqual) {
    hardIssues.add('semanticMismatch');
  }

  const mode: MarkdownEditabilityMode = hardIssues.size > 0
    ? 'unsafe'
    : textEqual
      ? 'lossless'
      : 'canonicalizable';

  return {
    mode,
    canonicalMarkdown,
    textEqual,
    semanticEqual,
    containsRenderOnlyBlocks,
    containsRawHtmlBlocks,
    containsRawHtmlInlines,
    hardIssues: Array.from(hardIssues),
    softIssues: Array.from(softIssues),
  };
}

export function getUnsupportedTiptapMarkdownFeatures(markdown: string): string[] {
  const analysis = analyzeMarkdownEditability(markdown);
  return [...analysis.hardIssues, ...analysis.softIssues];
}

export function canRoundTripMarkdownWithTiptap(markdown: string): boolean {
  return analyzeMarkdownEditability(markdown).mode === 'lossless';
}

// Use the same syntax extensions as the parser. Context-aware escaping belongs
// to the Markdown serializer, including destinations, entities and code padding.
const inlineMarkdownSerializer = unified()
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, {
    emphasis: '*',
    strong: '*',
    resourceLink: true,
    handlers: { break: () => '  \n' },
  });

type InlineContainer = Strong | Emphasis | Delete | MarkdownLink;

function markdownFormattingMarks(node: JSONContent): Mark[] {
  const marks = (node.marks as Mark[] | undefined) ?? [];
  return ['link', 'bold', 'italic', 'strike'].flatMap(type => {
    const mark = marks.find(candidate => candidate.type === type);
    return mark ? [{ type, ...(type === 'link' ? { attrs: {
      href: String(mark.attrs?.href ?? ''),
      title: typeof mark.attrs?.title === 'string' ? mark.attrs.title : null,
    } } : {}) }] : [];
  });
}

function inlineSemanticKey(content: JSONContent[]): string {
  const runs: Array<{ type: string; text?: string; marks: string; attrs?: unknown }> = [];
  content.forEach(node => {
    const marks = [...markdownFormattingMarks(node),
      ...['code', 'underline'].flatMap(type => node.marks?.some(mark => mark.type === type) ? [{ type }] : [])]
      .map(mark => JSON.stringify(mark)).sort().join('|');
    const last = runs.at(-1);
    if (node.type === 'text' && last?.type === 'text' && last.marks === marks) {
      last.text += node.text ?? '';
    } else {
      runs.push({ type: node.type ?? '', ...(node.type === 'text' ? { text: node.text ?? '' } : { attrs: node.attrs }), marks });
    }
  });
  return JSON.stringify(runs);
}

// Markdown delimiters cannot represent every range produced by rich-text edits.
// Use equivalent inline HTML only when the emitted Markdown fails a range check.
// Encode literal syntax and whitespace so Markdown inside HTML stays literal.
function renderInlineSourceHtml(content: JSONContent[]): string {
  return content.map(node => {
    let value: string;
    if (node.type === 'text') {
      value = Array.from(node.text ?? '', character => /[\s&<>"`*_~$[\]\\]/.test(character)
        ? `&#${character.codePointAt(0)};` : character).join('');
    } else if (node.type === 'hardBreak') {
      value = '<br>';
    } else if (node.type === 'markdownImage') {
      value = `<img src="${escapeHtmlText(String(node.attrs?.src ?? ''))}" alt="${escapeHtmlText(String(node.attrs?.alt ?? ''))}"${
        typeof node.attrs?.title === 'string' ? ` title="${escapeHtmlText(node.attrs.title)}"` : ''}>`;
    } else if (node.type === 'inlineMath') {
      value = String(node.attrs?.markdown ?? '');
    } else if (node.type === 'rawHtmlInline') {
      value = String(node.attrs?.html ?? '');
    } else {
      value = renderInlineSourceHtml(node.content ?? []);
    }
    for (const [mark, tag] of [['code', 'code'], ['bold', 'strong'], ['italic', 'em'], ['strike', 'del'], ['underline', 'u']]) {
      if (node.marks?.some(candidate => candidate.type === mark)) value = `<${tag}>${value}</${tag}>`;
    }
    const link = node.marks?.find(mark => mark.type === 'link');
    if (link) {
      const title = typeof link.attrs?.title === 'string' ? ` title="${escapeHtmlText(link.attrs.title)}"` : '';
      value = `<a href="${escapeHtmlText(String(link.attrs?.href ?? ''))}"${title}>${value}</a>`;
    }
    return value;
  }).join('');
}

function renderInline(content: JSONContent[] = []): string {
  const children: PhrasingContent[] = [];
  const formatting = content.map(node => markdownFormattingMarks(node).map(mark => ({
    mark, key: JSON.stringify(mark),
  })));
  const ends: Map<string, number>[] = new Array(content.length);
  for (let index = content.length - 1; index >= 0; index -= 1) {
    ends[index] = new Map(formatting[index].map(({ key }) => [
      key, ends[index + 1]?.get(key) ?? index + 1,
    ]));
  }
  const active: Array<{ key: string; node: InlineContainer }> = [];
  const currentChildren = (): PhrasingContent[] => active.length
    ? active[active.length - 1].node.children as PhrasingContent[] : children;

  content.forEach((node, index) => {
    const next = formatting[index];
    const firstEnded = active.findIndex(entry => !next.some(mark => mark.key === entry.key));
    if (firstEnded >= 0) active.splice(firstEnded);
    // Long-lived ranges are outermost. Closing an outer range also closes
    // its inner ranges; continuing ranges reopen rather than leaking marks.
    next.sort((a, b) => ends[index].get(b.key)! - ends[index].get(a.key)!);
    next.forEach(({ mark, key }) => {
      if (active.some(entry => entry.key === key)) return;
      const wrapper: InlineContainer = mark.type === 'link'
        ? { type: 'link', url: String(mark.attrs?.href ?? ''), title: mark.attrs?.title as string | null, children: [] }
        : { type: mark.type === 'bold' ? 'strong' : mark.type === 'italic' ? 'emphasis' : 'delete', children: [] };
      currentChildren().push(wrapper);
      active.push({ key, node: wrapper });
    });

    let leaf: PhrasingContent;
    switch (node.type) {
      case 'text':
        leaf = { type: node.marks?.some(mark => mark.type === 'code') ? 'inlineCode' : 'text', value: node.text ?? '' };
        break;
      case 'hardBreak':
        leaf = { type: 'break' };
        break;
      case 'inlineMath':
        leaf = { type: 'html', value: String(node.attrs?.markdown ?? '') };
        break;
      case 'rawHtmlInline':
        leaf = { type: 'html', value: String(node.attrs?.html ?? '') };
        break;
      case 'markdownImage':
        leaf = { type: 'image', url: String(node.attrs?.src ?? ''), alt: String(node.attrs?.alt ?? ''),
          title: typeof node.attrs?.title === 'string' ? node.attrs.title : null };
        break;
      default:
        leaf = { type: 'html', value: renderInline(node.content ?? []) };
    }
    const siblings = currentChildren();
    const previous = siblings.at(-1);
    if ((leaf.type === 'text' || leaf.type === 'inlineCode') && previous?.type === leaf.type) {
      (previous as typeof leaf).value += leaf.value;
    } else siblings.push(leaf);
  });
  const tree: Root = { type: 'root', children: [{ type: 'paragraph', children }] };
  const markdown = inlineMarkdownSerializer.stringify(tree).replace(/\n$/, '');
  const parsed = parseMarkdownTree(markdown).children ?? [];
  const recovered = parsed.length === 1 && parsed[0].type === 'paragraph'
    ? convertInlineNodes(parsed[0].children ?? []) : [];
  return inlineSemanticKey(recovered) === inlineSemanticKey(content)
    ? markdown : renderInlineSourceHtml(content);
}

function renderInlineHtml(content: JSONContent[] = []): string {
  return content.map((node: JSONContent) => {
    if (node.type === 'text') {
      const marks = (node.marks as Mark[] | undefined) ?? [];
      let result = escapeHtmlText(node.text ?? '');

      if (marks.some(mark => mark.type === 'code')) {
        result = `<code>${result}</code>`;
      }
      if (marks.some(mark => mark.type === 'bold')) {
        result = `<strong>${result}</strong>`;
      }
      if (marks.some(mark => mark.type === 'italic')) {
        result = `<em>${result}</em>`;
      }
      if (marks.some(mark => mark.type === 'strike')) {
        result = `<del>${result}</del>`;
      }
      if (marks.some(mark => mark.type === 'underline')) result = `<u>${result}</u>`;

      const linkMarks = marks.filter(mark => mark.type === 'link');
      linkMarks.forEach((mark) => {
        const title = typeof mark.attrs?.title === 'string' ? ` title="${escapeHtmlText(mark.attrs.title)}"` : '';
        result = `<a href="${escapeHtmlText(String(mark.attrs?.href ?? ''))}"${title}>${result}</a>`;
      });

      return result;
    }

    if (node.type === 'hardBreak') {
      return '<br>';
    }

    return renderInlineHtml(node.content ?? []);
  }).join('');
}

function parseAlignmentDirective(html: string, state: AlignmentState): boolean {
  const tagPattern = /<\/?div\b[^>]*>/gi;
  if ((html.match(tagPattern) ?? []).some(raw => {
    const token = parseSingleHtmlTagToken(raw);
    return !token || Object.keys(token.attrs).some(name => name !== 'align');
  })) return false;
  let matched = false;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const before = html.slice(cursor, match.index);
    if (before.trim()) {
      return false;
    }

    const token = match[0];
    cursor = match.index + token.length;
    matched = true;

    if (/^<\s*\/\s*div/i.test(token)) {
      state.stack.pop();
      const nextState = state.stack.at(-1) ?? null;
      state.activeAlign = nextState?.align ?? null;
      state.activeGroupId = nextState?.groupId ?? null;
      continue;
    }

    const alignMatch = token.match(/\balign\s*=\s*["']?([a-zA-Z-]+)["']?/i);
    const align = alignMatch?.[1]?.toLowerCase() ?? null;
    const groupId = state.nextGroupId++;
    state.stack.push({ align, groupId });
    state.activeAlign = align;
    state.activeGroupId = groupId;
  }

  return matched && html.slice(cursor).trim().length === 0;
}

function convertRootMarkdownChildren(children: MdastNode[], markdown: string): JSONContent[] {
  const alignmentState: AlignmentState = {
    activeAlign: null,
    activeGroupId: null,
    nextGroupId: 1,
    stack: [],
  };

  const content: JSONContent[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];

    if (child.type === 'html' && child.value && parseAlignmentDirective(child.value, alignmentState)) {
      continue;
    }

    if (child.type === 'html' && child.value) {
      const structuredNodes = convertStructuredHtmlBlock(child.value);
      if (structuredNodes) {
        content.push(...structuredNodes.map(node => withBlockAttrs(
          node,
          alignmentState.activeAlign,
          alignmentState.activeGroupId,
        )));
        continue;
      }

      const rawHtmlRegion = consumeRawHtmlRegion(children, index, markdown);
      if (rawHtmlRegion) {
        const detailsNode = convertDetailsMarkdownRegion(String(rawHtmlRegion.node.attrs?.html ?? ''));
        if (detailsNode) {
          content.push(withBlockAttrs(
            detailsNode,
            alignmentState.activeAlign,
            alignmentState.activeGroupId,
          ));
          index = rawHtmlRegion.nextIndex - 1;
          continue;
        }

        content.push(withBlockAttrs(
          rawHtmlRegion.node,
          alignmentState.activeAlign,
          alignmentState.activeGroupId,
        ));
        index = rawHtmlRegion.nextIndex - 1;
        continue;
      }
    }

    let needsSourceBlock = false;
    walkMdast(child, node => {
      // Container children can host their own source-backed blocks.
      if ((child.type === 'list' || child.type === 'blockquote') &&
          (node.type === 'math' || node.type === 'code')) return;
      if (!NATIVE_MARKDOWN_TYPES.has(node.type ?? '') ||
          (node.type === 'code' && (node.lang?.toLowerCase() === 'mermaid' || node.meta))) {
        needsSourceBlock = true;
      }
    });
    if (needsSourceBlock) {
      const start = getNodeStartOffset(child);
      const end = getNodeEndOffset(child);
      if (start !== null && end !== null) {
        content.push(withBlockAttrs(
          createRenderOnlyBlock(markdown.slice(start, end), child.type ?? 'markdown'),
          alignmentState.activeAlign,
          alignmentState.activeGroupId,
        ));
        continue;
      }
    }

    const converted = convertBlock(child);
    let containsRawInline = false;
    converted.forEach(node => walkTiptapDoc(node, descendant => {
      if (descendant.type === 'rawHtmlInline') containsRawInline = true;
    }));
    const start = getNodeStartOffset(child);
    const end = getNodeEndOffset(child);
    const editableNodes = containsRawInline && start !== null && end !== null
      ? [createRenderOnlyBlock(markdown.slice(start, end), 'html')]
      : converted;
    const nextNodes = editableNodes.map(node => withBlockAttrs(
      node,
      alignmentState.activeAlign,
      alignmentState.activeGroupId,
    ));
    content.push(...nextNodes);
  }

  return content;
}

function normalizeTableCellMarkdown(markdown: string): string {
  return markdown
    .replace(/\n+/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function renderTableRow(row: JSONContent): string {
  const cells = (row.content ?? []).map((cell: JSONContent) => {
    const value = renderInline(cell.content ?? []);
    return normalizeTableCellMarkdown(value);
  });

  return `| ${cells.join(' | ')} |`;
}

function renderTableSeparator(alignments: unknown[], columnCount: number): string {
  const cells = Array.from({ length: columnCount }, (_, index) => {
    const align = typeof alignments[index] === 'string' ? alignments[index] : null;

    switch (align) {
      case 'left':
        return ':---';
      case 'center':
        return ':---:';
      case 'right':
        return '---:';
      default:
        return '---';
    }
  });

  return `| ${cells.join(' | ')} |`;
}

function prefixMarkdownLines(markdown: string, prefix: string): string {
  return markdown
    .split('\n')
    .map((line: string) => (line ? `${prefix}${line}` : line))
    .join('\n');
}

function isEmptyParagraphNode(node: JSONContent | null | undefined): boolean {
  if (node?.type !== 'paragraph') {
    return false;
  }

  const content = node.content ?? [];
  return content.length === 0 || content.every((child: JSONContent) => {
    if (child.type !== 'text') {
      return false;
    }

    return (child.text ?? '').trim().length === 0;
  });
}

function getDetailsChild(
  node: JSONContent,
  type: 'detailsSummary' | 'detailsContent',
): JSONContent | undefined {
  return (node.content ?? []).find((child: JSONContent) => child.type === type);
}

function renderListItem(
  item: JSONContent,
  prefix: string,
  depth: number,
  taskChecked?: boolean,
): string {
  const children = item.content ?? [];
  const indent = '  '.repeat(depth);
  const marker = taskChecked === undefined ? prefix : `- [${taskChecked ? 'x' : ' '}] `;
  const continuationIndent = `${indent}${' '.repeat(marker.length)}`;

  if (children.length === 0) {
    return `${indent}${marker}`;
  }

  const [first, ...rest] = children;
  const firstRendered = first.type === 'paragraph'
    ? renderInline(first.content ?? [])
    : renderBlock(first, 0);

  const lines: string[] = [`${indent}${marker}${firstRendered.replace(/\n/g, `\n${continuationIndent}`)}`];

  rest.forEach((child: JSONContent) => {
    if (child.type === 'paragraph') lines.push('');
    lines.push(prefixMarkdownLines(renderBlock(child, 0), continuationIndent));
  });

  return lines.join('\n');
}

function renderBlock(node: JSONContent, depth = 0): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(node.content ?? []);
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${renderInline(node.content ?? [])}`.trimEnd();
    case 'blockquote': {
      const body = (node.content ?? []).map((child: JSONContent) => renderBlock(child, depth)).join('\n\n');
      return body
        .split('\n')
        .map((line: string) => `> ${line}`)
        .join('\n');
    }
    case 'bulletList':
      return (node.content ?? []).map((item: JSONContent) => renderListItem(item, '- ', depth)).join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? []).map((item: JSONContent, index: number) => renderListItem(item, `${start + index}. `, depth)).join('\n');
    }
    case 'taskList':
      return (node.content ?? []).map((item: JSONContent) => renderListItem(item, '- ', depth, !!item.attrs?.checked)).join('\n');
    case 'codeBlock': {
      const language = String(node.attrs?.language ?? '').trim();
      const text = (node.content ?? [])
        .map((child: JSONContent) => (child.type === 'text' ? child.text ?? '' : renderInline(child.content ?? [])))
        .join('');
      const marker = language.includes('`') ? '~' : '`';
      const runs = text.match(marker === '`' ? /`+/g : /~+/g) ?? [];
      const fence = marker.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'frontmatter':
      return serializeFrontmatterNode(node);
    case 'details': {
      const summaryNode = getDetailsChild(node, 'detailsSummary');
      const detailsContentNode = getDetailsChild(node, 'detailsContent');
      const summary = renderInlineHtml(summaryNode?.content ?? []).trim() || 'Details';
      const bodyBlocks = (detailsContentNode?.content ?? []).filter(
        (child: JSONContent) => !isEmptyParagraphNode(child),
      );
      const body = bodyBlocks.map((child: JSONContent) => renderBlock(child, depth)).join('\n\n');
      const open = node.attrs?.open ? ' open' : '';

      return body
        ? `<details${open}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
        : `<details${open}>\n<summary>${summary}</summary>\n\n</details>`;
    }
    case 'renderOnlyBlock':
      return String(node.attrs?.markdown ?? '');
    case 'rawHtmlBlock':
      return String(node.attrs?.html ?? '');
    case 'markdownTable': {
      const rows = node.content ?? [];
      if (rows.length === 0) {
        return '';
      }

      const headerRow = rows[0];
      const headerCellCount = headerRow.content?.length ?? 0;
      const alignments = Array.isArray(node.attrs?.align) ? node.attrs.align as unknown[] : [];
      const bodyRows = rows.slice(1);

      return [
        renderTableRow(headerRow),
        renderTableSeparator(alignments, headerCellCount),
        ...bodyRows.map(row => renderTableRow(row)),
      ].join('\n');
    }
    default:
      return (node.content ?? []).map((child: JSONContent) => renderBlock(child, depth)).join('\n\n');
  }
}

function wrapAlignedMarkdownBlocks(markdownBlocks: string[], align: string | null): string {
  if (markdownBlocks.length === 0) {
    return '';
  }

  if (!align) {
    return markdownBlocks.join('\n\n');
  }

  return [
    `<div align="${align}">`,
    '',
    markdownBlocks.join('\n\n'),
    '',
    '</div>',
  ].join('\n');
}

export function markdownToTiptapDoc(markdown: string): JSONContent {
  const frontmatter = splitMarkdownFrontmatter(markdown);
  const bodyPrefix = frontmatter ? getLeadingBlankLines(frontmatter.body) : '';
  const markdownBody = frontmatter ? frontmatter.body.slice(bodyPrefix.length) : markdown;
  const tree = parseMarkdownTree(markdownBody);

  const bodyContent = convertRootMarkdownChildren(tree.children ?? [], markdownBody);
  const content = withTopLevelBlockIds([
    ...(frontmatter ? [createFrontmatterBlock(frontmatter, bodyPrefix)] : []),
    ...bodyContent,
  ]);

  return {
    type: 'doc',
    content: content.length > 0 ? content : [createParagraph()],
  };
}

/** Keep conversion failures local to their source region. The global analysis
 * remains strict; a problem in one block must not turn unrelated text into source.
 */
export function markdownToEditableTiptapDoc(markdown: string): JSONContent {
  if (analyzeMarkdownEditability(markdown).mode !== 'unsafe') {
    return markdownToTiptapDoc(markdown);
  }
  const frontmatter = splitMarkdownFrontmatter(markdown);
  const body = frontmatter ? frontmatter.body : markdown;
  const children = parseMarkdownTree(body).children ?? [];
  const content: JSONContent[] = frontmatter
    ? [createFrontmatterBlock(frontmatter, getLeadingBlankLines(body))] : [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    // HTML containers and alignment wrappers are indivisible source regions;
    // splitting them could change the meaning of their descendants.
    const region = consumeRawHtmlRegion(children, index, body);
    const last = region ? region.nextIndex - 1 : index;
    const start = getNodeStartOffset(child);
    const end = getNodeEndOffset(children[last]);
    if (start === null || end === null) {
      throw new Error('Markdown parser omitted source positions');
    }
    const source = body.slice(start, end);
    if (analyzeMarkdownEditability(source).mode === 'unsafe') {
      content.push(createRenderOnlyBlock(source, child.type ?? 'markdown'));
    } else {
      content.push(...(markdownToTiptapDoc(source).content ?? []));
    }
    index = last;
  }
  return { type: 'doc', content: withTopLevelBlockIds(content) };
}

export function tiptapDocToMarkdown(
  doc: JSONContent | null | undefined,
  options: TiptapMarkdownOptions = {},
): string {
  const content = doc?.content ?? [];
  const frontmatterNode = content[0]?.type === 'frontmatter' ? content[0] : null;
  const renderableContent = frontmatterNode ? content.slice(1) : content;
  const chunks: string[] = [];
  let group: string[] = [];
  let groupAlign: string | null = null;
  let groupAlignId: string | null = null;

  const flushGroup = () => {
    if (group.length === 0) {
      return;
    }

    chunks.push(wrapAlignedMarkdownBlocks(group, groupAlign));
    group = [];
    groupAlign = null;
    groupAlignId = null;
  };

  renderableContent.forEach((node: JSONContent) => {
    const rendered = renderBlock(node);
    if (!rendered) {
      return;
    }

    const align = typeof node.attrs?.align === 'string' && node.attrs.align
      ? node.attrs.align
      : null;
    const alignId = node.attrs?.alignGroup !== null && node.attrs?.alignGroup !== undefined
      ? String(node.attrs.alignGroup)
      : null;

    if (group.length === 0) {
      group = [rendered];
      groupAlign = align;
      groupAlignId = alignId;
      return;
    }

    if (groupAlign === align && groupAlignId === alignId) {
      group.push(rendered);
      return;
    }

    flushGroup();
    group = [rendered];
    groupAlign = align;
    groupAlignId = alignId;
  });

  flushGroup();

  const markdown = chunks
    .filter(Boolean)
    .join('\n\n')
    .replace(/<\/div>\n\n<div\b/g, '</div>\n<div');

  const frontmatterRaw = frontmatterNode ? serializeFrontmatterNode(frontmatterNode) : '';
  const frontmatterBodyPrefix = frontmatterNode ? String(frontmatterNode.attrs?.bodyPrefix ?? '') : '';
  const frontmatterEnvelope = `${frontmatterRaw}${frontmatterBodyPrefix}`;
  if (!markdown) {
    if (!frontmatterEnvelope) {
      return '';
    }
    return options.preserveTrailingNewline && !frontmatterEnvelope.endsWith('\n')
      ? `${frontmatterEnvelope}\n`
      : frontmatterEnvelope;
  }

  const combinedMarkdown = `${frontmatterEnvelope}${markdown}`;
  return options.preserveTrailingNewline && !combinedMarkdown.endsWith('\n')
    ? `${combinedMarkdown}\n`
    : combinedMarkdown;
}

export function tiptapDocToTopLevelMarkdownBlocks(
  doc: JSONContent | null | undefined,
): TiptapTopLevelMarkdownBlock[] {
  return (doc?.content ?? [])
    .filter((node: JSONContent) => node.type !== 'frontmatter')
    .map((node: JSONContent) => ({
      blockId: typeof node.attrs?.blockId === 'string' ? node.attrs.blockId : undefined,
      markdown: renderBlock(node).trim(),
    }));
}
