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

// Streaming state: the last computed source and its sections. During streaming the
// source only grows, so the settled prefix (all sections except the last, still
// growing one) can be reused by strict reference identity (`===`).
let lastSource = '';
let lastSections: readonly MarkdownSection[] = [];
// Cached line-start offsets for `lastSource`, so growing chunks never re-scan
// the whole document to rebuild the offset table.
let lastOffsets: number[] = [0];
// Cached top-level block start offsets (absolute) for `lastSource`.
let lastStarts: number[] = [];
// Cached "unsafe" verdict (references/footnotes/raw HTML) for `lastSource`.
let lastUnsafe = false;

const LINE_ENDINGS = /\r\n|\r|\n/g;
const UNSAFE_INLINE = /<|\]\s*\[|\[\^/;

function isUnsafeToken(token: { type: string; content?: string }): boolean {
  return token.type.startsWith('html') || token.type.startsWith('footnote')
    // Inline HTML/reference definitions may bind beyond a top-level block.
    || (token.type === 'inline' && UNSAFE_INLINE.test(token.content ?? ''));
}

/** Block tokenization only (~linear), never inline parsing or a second renderer.
 * Actual sections still use the product's remark/rehype/sanitizer pipeline.
 * Documents with cross-block references/raw HTML stay together. */
export function markdownSections(source: string): readonly MarkdownSection[] {
  if (source.length < SECTION_CHARS) return [{ start: 0, end: source.length }];
  const cached = cache.get(source);
  if (cached) return cached;
  const started = isStartupRenderTraceEnabled() ? performance.now() : undefined;

  // Fast path: streaming append. The previous source is a strict prefix of the
  // new one, so the settled prefix sections and their boundaries are unchanged.
  const streaming = lastSource.length > 0 && source.length > lastSource.length
    && source.startsWith(lastSource);
  const baseLength = streaming ? lastSource.length : 0;

  const normalized = source.replace(/\r\n?|\0/g, match => match === '\0' ? '\uFFFD' : '\n');
  const tokens: Parameters<typeof parser.block.parse>[3] = [];
  const environment: Record<string, unknown> = {};
  parser.block.parse(normalized, parser, environment, tokens);

  let sections: readonly MarkdownSection[];
  let unsafe = false;
  for (const token of tokens) {
    if (isUnsafeToken(token)) { unsafe = true; break; }
  }
  if (unsafe || environment.references || environment.footnotes) {
    sections = [{ start: 0, end: source.length }];
  } else {
    // Rebuild line-start offsets, reusing the cached prefix when streaming.
    let offsets: number[];
    if (streaming) {
      offsets = lastOffsets;
      // Drop offsets that fall beyond the previous source length (none should,
      // but keep the invariant exact), then scan only the appended tail.
      while (offsets.length > 1 && offsets[offsets.length - 1] > baseLength) offsets.pop();
      LINE_ENDINGS.lastIndex = baseLength;
      let match: RegExpExecArray | null;
      while ((match = LINE_ENDINGS.exec(source))) offsets.push(match.index + match[0].length);
    } else {
      offsets = [0];
      LINE_ENDINGS.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = LINE_ENDINGS.exec(source))) offsets.push(match.index + match[0].length);
    }

    // Collect absolute top-level block starts, reusing the settled prefix.
    const starts: number[] = streaming ? lastStarts.slice() : [];
    const reuseStarts = streaming ? lastStarts.length : 0;
    let index = 0;
    for (const token of tokens) {
      if (token.level === 0 && token.map && token.nesting !== -1) {
        const line = token.map[0];
        const absolute = offsets[line];
        if (absolute !== undefined) {
          if (index >= reuseStarts) starts.push(absolute);
          index++;
        }
      }
    }

    // Build boundaries; reuse settled prefix section objects by identity.
    const boundaries: number[] = [0];
    for (const start of starts) {
      if (start - boundaries[boundaries.length - 1] >= SECTION_CHARS) boundaries.push(start);
    }
    const next: MarkdownSection[] = [];
    const reusable = streaming ? lastSections : [];
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1] ?? source.length;
      const prev = reusable[i];
      if (prev && prev.start === start && prev.end === end) {
        next.push(prev);
      } else if (prev && prev.start === start && i === boundaries.length - 1) {
        // Active/growing tail: mutate in place to preserve object identity.
        prev.end = end;
        next.push(prev);
      } else {
        next.push({ start, end });
      }
    }
    sections = next;

    lastOffsets = offsets;
    lastStarts = starts;
  }

  lastSource = source;
  lastSections = sections;
  lastUnsafe = unsafe;

  cache.set(source, sections, source.length * 2 + sections.length * 32);
  if (started !== undefined) startupTrace.markPhase('flowchat_markdown_sections', {
    durationMs: performance.now() - started, contentLength: source.length, sections: sections.length,
  });
  return sections;
}
