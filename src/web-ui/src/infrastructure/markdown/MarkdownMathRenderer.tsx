import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkAutolinkBoundaries } from './remarkAutolinkBoundaries';
import { remarkStreamingTableLinks } from './remarkStreamingTableLinks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize';
import type { Pluggable } from 'unified';
import 'katex/dist/katex.min.css';
import { rehypeSourceRange, type MarkdownSourceRange } from './rehypeSourceRange';

interface MarkdownMathRendererProps {
  markdownContent: string;
  isStreaming?: boolean;
  components: Components;
  sanitizeSchema: RehypeSanitizeOptions;
  remarkAutolinkComputerFileLinks: Pluggable;
  urlTransform: (value: string) => string;
  sourceRange?: MarkdownSourceRange;
  inline?: boolean;
}

export const MarkdownMathRenderer: React.FC<MarkdownMathRendererProps> = ({
  markdownContent,
  isStreaming = false,
  components,
  sanitizeSchema,
  remarkAutolinkComputerFileLinks,
  urlTransform,
  sourceRange,
  inline = false,
}) => {
  const content = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, [remarkStreamingTableLinks, { isStreaming }], remarkAutolinkBoundaries, remarkAutolinkComputerFileLinks]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], [rehypeSourceRange, sourceRange], rehypeKatex]}
      urlTransform={urlTransform}
      components={components}
    >
      {markdownContent}
    </ReactMarkdown>
  );
  return inline
    ? <span data-openbitfun-component="markdown" data-openbitfun-part="math">{content}</span>
    : <div data-openbitfun-component="markdown" data-openbitfun-part="math">{content}</div>;
};

export default MarkdownMathRenderer;
