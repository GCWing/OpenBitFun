import type { PhrasingContent, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parser = unified().use(remarkParse);

function inlineText(node: PhrasingContent): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'break') return ' ';
  if ('children' in node) return node.children.map(inlineText).join('');
  return '';
}

function firstParagraph(nodes: readonly RootContent[]): string {
  for (const node of nodes) {
    if (node.type === 'paragraph') {
      const text = node.children.map(inlineText).join('').replace(/\s+/g, ' ').trim();
      if (text) return text;
    } else if (node.type === 'list') {
      for (const item of node.children) {
        const text = firstParagraph(item.children);
        if (text) return text;
      }
    } else if (node.type === 'blockquote') {
      const text = firstParagraph(node.children);
      if (text) return text;
    }
  }
  return '';
}

/** Use authored prose without version headings, badges, code blocks, or executable markup. */
export function getUpdateIntroduction(notes: string | null | undefined): string {
  return notes?.trim() ? firstParagraph(parser.parse(notes).children) : '';
}
