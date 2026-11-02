import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, UrlTransform } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';

export interface MarkdownMathContentProps {
  content: string;
  components: Components;
  urlTransform: UrlTransform;
}

/**
 * KaTeX-enabled Markdown renderer. It is imported lazily so chats without math
 * do not download the KaTeX runtime; the base renderer stays in ChatMarkdown.
 */
export const MarkdownMathContent: React.FC<MarkdownMathContentProps> = ({
  content,
  components,
  urlTransform,
}) => (
  <ReactMarkdown
    components={components}
    rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
    remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
    urlTransform={urlTransform}
  >
    {content}
  </ReactMarkdown>
);

export default MarkdownMathContent;
