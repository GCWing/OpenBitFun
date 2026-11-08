import { isStartupRenderTraceEnabled, startupTrace } from '@/shared/utils/startupTrace';
import { getMarkdown } from 'stream-markdown-parser';
import { BoundedResourceCache } from '@/shared/utils/BoundedResourceCache';

export interface MarkdownSection { start: number; end: number }
// Render/measurement budget, never a content limit. A semantic block can exceed
// it: splitting a list, fence, table or HTML document would change its meaning.
const SECTION_CHARS = 3000;
const cache = new BoundedResourceCache<string, readonly MarkdownSection[]>(2 * 1024 * 1024, 64);
const parser = getMarkdown('flowchat-section-boundaries', {
  enableContainers: false, enableFixIndentedCodeBlock: false,
  markdownItOptions: { typographer: false },
});

/** Block tokenization only (~linear), never inline parsing or a second renderer.
 * Actual sections still use the product's remark/rehype/sanitizer pipeline.
 * Documents with cross-block references/raw HTML stay together. */
export function markdownSections(source: string): readonly MarkdownSection[] {
  const whole = () => [{ start: 0, end: source.length }];
  if (source.length < SECTION_CHARS) return whole();
  const cached = cache.get(source);
  if (cached) return cached;
  const started = isStartupRenderTraceEnabled() ? performance.now() : undefined;
  const normalized = source.replace(/\r\n?|\0/g, match => match === '\0' ? '\uFFFD' : '\n');
  const tokens: Parameters<typeof parser.block.parse>[3] = [];
  const environment: Record<string, unknown> = {};
  parser.block.parse(normalized, parser, environment, tokens);
  let sections = whole();
  if (!environment.references && !environment.footnotes
    && !tokens.some(token => token.type.startsWith('html') || token.type.startsWith('footnote')
      // Inline HTML/reference definitions may bind beyond a top-level block.
      || (token.type === 'inline' && /<|\]\s*\[|\[\^/.test(token.content)))) {
    const offsets = [0];
    const endings = /\r\n|\r|\n/g;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(source))) offsets.push(match.index + match[0].length);
    const starts = tokens.filter(token => token.level === 0 && token.map && token.nesting !== -1)
      .map(token => offsets[token.map![0]]).filter((value): value is number => value !== undefined);
    const boundaries = [0];
    // Streaming coalesces blank lines; journal records retain the original
    // source. Budget in the same coordinates while returning exact raw ranges.
    const blankRuns = source.matchAll(/\n{3,}/g);
    let blankRun = blankRuns.next(), removed = 0, normalizedBoundary = 0;
    for (const start of starts) {
      while (!blankRun.done && blankRun.value.index + blankRun.value[0].length <= start) {
        removed += blankRun.value[0].length - 2;
        blankRun = blankRuns.next();
      }
      const normalizedStart = start - removed;
      if (normalizedStart - normalizedBoundary >= SECTION_CHARS) {
        boundaries.push(start);
        normalizedBoundary = normalizedStart;
      }
    }
    sections = boundaries.map((start, index) => ({ start, end: boundaries[index + 1] ?? source.length }));
  }
  cache.set(source, sections, source.length * 2 + sections.length * 32);
  if (started !== undefined) startupTrace.markPhase('flowchat_markdown_sections', {
    durationMs: performance.now() - started, contentLength: source.length, sections: sections.length,
  });
  return sections;
}
