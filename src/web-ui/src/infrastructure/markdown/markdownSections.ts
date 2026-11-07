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

interface SettledPrefixRecord {
  source: string;
  boundaries: number[];
  extendable: boolean;
}

let lastRecord: SettledPrefixRecord | undefined;

function computeRawBoundaries(source: string): { boundaries: number[]; extendable: boolean } {
  const normalized = source.replace(/\r\n?|\0/g, match => match === '\0' ? '\uFFFD' : '\n');
  const tokens: Parameters<typeof parser.block.parse>[3] = [];
  const environment: Record<string, unknown> = {};
  parser.block.parse(normalized, parser, environment, tokens);
  if (environment.references || environment.footnotes
    || tokens.some(token => token.type.startsWith('html') || token.type.startsWith('footnote')
      // Inline HTML/reference definitions may bind beyond a top-level block.
      || (token.type === 'inline' && /<|\]\s*\[|\[\^/.test(token.content)))) {
    return { boundaries: [0], extendable: false };
  }
  const offsets = [0];
  const endings = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = endings.exec(source))) offsets.push(match.index + match[0].length);
  const starts = tokens.filter(token => token.level === 0 && token.map && token.nesting !== -1)
    .map(token => offsets[token.map![0]]).filter((value): value is number => value !== undefined);
  const boundaries = [0];
  for (const start of starts) {
    if (start - boundaries[boundaries.length - 1] >= SECTION_CHARS) boundaries.push(start);
  }
  return { boundaries, extendable: true };
}

/** Block tokenization only (~linear), never inline parsing or a second renderer.
 * Actual sections still use the product's remark/rehype/sanitizer pipeline.
 * Documents with cross-block references/raw HTML stay together. */
export function markdownSections(source: string): readonly MarkdownSection[] {
  const whole = () => [{ start: 0, end: source.length }];
  if (source.length < SECTION_CHARS) return whole();
  const cached = cache.get(source);
  if (cached) return cached;
  const started = isStartupRenderTraceEnabled() ? performance.now() : undefined;

  let boundaries: number[];
  let extendable = true;

  // Streaming prefix optimization: if source strictly starts with lastRecord.source
  // and the settled prefix has frozen closed boundaries, avoid re-parsing the settled head.
  const prevRecord = lastRecord && source.startsWith(lastRecord.source) ? lastRecord : undefined;
  if (prevRecord && prevRecord.extendable && prevRecord.boundaries.length > 1) {
    const frozenBoundaries = prevRecord.boundaries.slice(0, -1);
    const tailOffset = frozenBoundaries[frozenBoundaries.length - 1];
    const tailSource = source.slice(tailOffset);
    if (tailSource.length < SECTION_CHARS) {
      // Fast path: the tail has not accumulated enough characters to form another section boundary,
      // so no new boundary can exist beyond the current frozen ones!
      boundaries = frozenBoundaries;
    } else {
      const tailResult = computeRawBoundaries(tailSource);
      if (tailResult.extendable) {
        boundaries = frozenBoundaries.concat(tailResult.boundaries.slice(1).map(b => b + tailOffset));
      } else {
        extendable = false;
        boundaries = [0];
      }
    }
  } else {
    const raw = computeRawBoundaries(source);
    boundaries = raw.boundaries;
    extendable = raw.extendable;
  }

  const prevSections = prevRecord ? cache.get(prevRecord.source) : undefined;
  const sections: readonly MarkdownSection[] = extendable
    ? boundaries.map((start, index) => {
        const end = boundaries[index + 1] ?? source.length;
        // Reuse immutable closed section instances from previous stream frame
        const reused = prevSections?.find(s => s.start === start && s.end === end);
        return reused ?? { start, end };
      })
    : whole();

  lastRecord = { source, boundaries, extendable };
  cache.set(source, sections, source.length * 2 + sections.length * 32);
  if (started !== undefined) startupTrace.markPhase('flowchat_markdown_sections', {
    durationMs: performance.now() - started, contentLength: source.length, sections: sections.length,
  });
  return sections;
}

