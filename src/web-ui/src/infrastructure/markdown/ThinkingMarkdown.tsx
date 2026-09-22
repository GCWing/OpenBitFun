import React, { createContext, memo, useContext, useId, useLayoutEffect, useMemo, useRef } from 'react';
import type { Components } from 'react-markdown';
import { renderNode, type CustomComponentMap, type NodeComponentProps, type RenderContext } from 'markstream-react';
import { getMarkdown, parseMarkdownToStructure, type BaseNode, type ParsedNode } from 'stream-markdown-parser';
import { stabilizeThinkingNodes } from './stabilizeThinkingNodes';

interface ThinkingMarkdownProps {
  content: string;
  isStreaming: boolean;
  isDark: boolean;
  components: Components;
  urlTransform: (value: string, key?: string) => string;
  renderFragment: (content: string, inline: boolean, math: boolean) => React.ReactNode;
  /** Changes to resource ownership must refresh memoized blocks even without new text. */
  environment?: object;
}

type ProductRenderers = Pick<ThinkingMarkdownProps, 'components' | 'urlTransform' | 'renderFragment'>;
const ProductContext = createContext<ProductRenderers | null>(null);

// This is a presentation adapter for the library's AST, not a second parser.
interface ProductNode extends BaseNode {
  children?: ParsedNode[];
  content?: string;
  language?: string;
  level?: number;
  ordered?: boolean;
  start?: number;
  items?: ParsedNode[];
  header?: ProductNode;
  rows?: ProductNode[];
  cells?: ProductNode[];
  align?: string;
  href?: string;
  src?: string;
  alt?: string;
  title?: string | null;
  checked?: boolean;
  id?: string;
}

type ThinkingContext = RenderContext & { insideLink?: boolean };

function ProductNodeRenderer({ node: sourceNode, ctx, indexKey }: NodeComponentProps<ParsedNode>) {
  const product = useContext(ProductContext)!;
  const node = sourceNode as ProductNode;
  const context = ctx as ThinkingContext;
  const key = String(indexKey);
  const children = (nodes = node.children, childContext = context) =>
    nodes?.map((child, index) => renderNode(child, `${key}-${index}`, childContext));
  const element = (tag: keyof React.JSX.IntrinsicElements, props: Record<string, unknown> = {}, body?: React.ReactNode) => {
    const Component = (product.components[tag] || tag) as React.ElementType;
    return React.createElement(Component, props, body);
  };

  switch (node.type) {
    case 'text':
    case 'text_special': {
      const content = node.content ?? '';
      if (context.insideLink) return content;
      // Match the existing internal-link autolinker without reparsing the paragraph.
      const parts = content.split(/((?:computer:\/\/|file:\/\/|openbitfun-canvas:\/\/)[^\s<>()]+)/g);
      return parts.map((part, index) => index % 2
        ? element('a', { key: index, href: product.urlTransform(part, 'href') }, part)
        : part);
    }
    case 'paragraph':
      // Parser 1.2.16 retains file links but rejects POSIX file:// image tokens.
      // Keep those rare fragments on the existing image-capable safe pipeline.
      return hasFileImage(node.raw)
        ? product.renderFragment(node.raw, false, false)
        : element('p', {}, children());
    case 'heading': return element(`h${Math.min(6, Math.max(1, node.level ?? 1))}` as 'h1', {}, children());
    case 'blockquote': return element('blockquote', {}, children());
    case 'strong': return element('strong', {}, children());
    case 'emphasis': return element('em', {}, children());
    case 'strikethrough': return element('del', {}, children());
    case 'inline': return children();
    case 'inline_code': return element('code', {}, node.code ?? '');
    case 'code_block': {
      // An explicit language keeps even a one-line unlabelled fence a block.
      // The shared renderer strips one final newline, as supplied by react-markdown.
      const code = node.code ?? '';
      return element('code', { className: `language-${node.language || 'text'}` }, code.endsWith('\n') ? code : `${code}\n`);
    }
    case 'link': {
      const body = children(node.children, { ...context, insideLink: true });
      const href = product.urlTransform(node.href ?? '', 'href');
      return node.loading || !href ? <>{body}</> : element('a', { href, title: node.title }, body);
    }
    case 'image': return element('img', { src: product.urlTransform(node.src ?? '', 'src'), alt: node.alt, title: node.title });
    case 'list': return element(node.ordered ? 'ol' : 'ul', { start: node.ordered ? node.start : undefined }, children(node.items));
    case 'list_item': return element('li', {}, children());
    case 'table': {
      const row = (value: ProductNode, rowIndex: number, header: boolean) => element('tr', { key: rowIndex },
        value.cells?.map((cell, column) => element(header ? 'th' : 'td', { key: column, align: cell.align },
          hasFileImage(cell.raw) ? product.renderFragment(cell.raw, true, false)
            : cell.children?.map((child, index) => renderNode(child, `${key}-${rowIndex}-${column}-${index}`, context)))));
      return element('table', {}, <>
        <thead>{node.header && row(node.header, -1, true)}</thead>
        <tbody>{node.rows?.map((value, index) => row(value, index, false))}</tbody>
      </>);
    }
    case 'hardbreak': return <br />;
    case 'softbreak': return '\n';
    case 'thematic_break': return <hr />;
    case 'checkbox':
    case 'checkbox_input': return <input type="checkbox" checked={node.checked} disabled readOnly />;
    case 'label_open':
    case 'label_close': return null;
    case 'html_inline':
    case 'html_block': return product.renderFragment(node.content ?? node.raw, node.type === 'html_inline', false);
    case 'math_inline': return product.renderFragment(`$${node.content ?? ''}$`, true, true);
    case 'math_block': return product.renderFragment(`$$\n${node.content ?? ''}\n$$`, false, true);
    case 'footnote_reference': return <sup><a href={`#${context.indexKey}-fn-${node.id}`}>{node.id}</a></sup>;
    case 'footnote': return <div id={`${context.indexKey}-fn-${node.id}`}>{children()}</div>;
    case 'footnote_anchor': return null;
    default: return node.raw;
  }
}

function hasFileImage(source: string): boolean {
  return source.includes('![') && /file:/i.test(source);
}

const customComponents: CustomComponentMap = Object.fromEntries([
  'text', 'text_special', 'paragraph', 'heading', 'blockquote', 'strong', 'emphasis',
  'strikethrough', 'inline', 'inline_code', 'code_block', 'link', 'image', 'list', 'list_item',
  'table', 'hardbreak', 'softbreak', 'thematic_break', 'checkbox', 'checkbox_input',
  'label_open', 'label_close', 'html_inline', 'html_block', 'math_inline', 'math_block',
  'footnote', 'footnote_reference', 'footnote_anchor',
  'reference', 'highlight', 'insert', 'subscript', 'superscript', 'emoji',
  // Keep specialized code languages on the same lightweight source path.
  'mermaid', 'd2', 'infographic',
].map(type => [type, ProductNodeRenderer]));

const ThinkingBlock = memo(function ThinkingBlock({ node, index, context }: {
  node: ParsedNode;
  index: number;
  context: RenderContext;
}) {
  return renderNode(node, `${context.indexKey}-${index}`, context);
});

export default function ThinkingMarkdown({ content, isStreaming, isDark, components, urlTransform, renderFragment, environment }: ThinkingMarkdownProps) {
  const id = useId();
  const parser = useMemo(() => getMarkdown(id, {
    enableContainers: false,
    enableFixIndentedCodeBlock: false,
    markdownItOptions: { typographer: false },
  }), [id]);
  const committedNodes = useRef<ParsedNode[]>([]);
  const nodes = useMemo(() => {
    const parsed = parseMarkdownToStructure(content, parser, {
      final: !isStreaming, streamParse: 'auto', reuseStableTopLevelNodes: true,
    });
    return stabilizeThinkingNodes(parsed, committedNodes.current);
  }, [content, isStreaming, parser]);
  // Only retain the last committed tree; an abandoned render must not publish
  // its cache. Resource/theme/final-state updates still flow through contexts.
  useLayoutEffect(() => { committedNodes.current = nodes; }, [nodes]);
  const context = useMemo<RenderContext>(() => ({
    indexKey: id, final: !isStreaming, isDark, customComponents,
    // Thinking performance invariant: never enable arrival fading or syntax
    // highlighting here, including completed/remounted thinking. Full-document
    // reveal scans and bulk code highlighting caused long-stream/completion stalls.
    // Keep code fences on the product's lightweight source renderer.
    typewriter: false, fade: false, showTooltips: false, renderCodeBlocksAsPre: true, events: {},
  }), [id, isStreaming, isDark]);
  const product = useMemo(() => ({ components, urlTransform, renderFragment, environment }), [components, urlTransform, renderFragment, environment]);

  // Use Markstream's public node renderer directly: no extra wrapper, scheduler,
  // viewport virtualization, CSS theme, or global custom-component registrations.
  // The parser owns incremental parsing; adapter stabilization lets memo skip
  // settled blocks even when the parser cannot reuse its structured nodes.
  return <ProductContext.Provider value={product}>
    {nodes.map((node, index) => <ThinkingBlock key={index} node={node} index={index} context={context} />)}
  </ProductContext.Provider>;
}
