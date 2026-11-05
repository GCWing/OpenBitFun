import { BoundedResourceCache } from '@/shared/utils/BoundedResourceCache';
import { markdownSections } from '@/infrastructure/markdown/markdownSections';
import type { FlowItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';

const occurrences = new BoundedResourceCache<FlowItem, { query: string; counts: Map<number, number> }>(2 * 1024 * 1024, 64);

/** Canonical search counts whole messages; the DOM counts only this section.
 * Store counts at section boundaries, not one entry per matching character. */
export function localizeMarkdownMatch<T extends { flowItemId?: string; occurrenceIndex: number }>(
  row: VirtualItem, query: string, match: T,
): T | undefined {
  const section = row.timeline?.markdownSection;
  if (!section || row.type !== 'model-round') return match;
  const member = row.data.items.find(item => item.id === match.flowItemId);
  if (member?.type !== 'text') return match;
  const folded = query.trim().toLowerCase();
  if (!folded) return undefined;
  let cached = occurrences.get(member);
  if (cached?.query !== folded) {
    const source = member.content.toLowerCase(), counts = new Map<number, number>();
    const boundaries = [...markdownSections(member.content).map(part => part.start), member.content.length];
    let count = 0, at = source.indexOf(folded), raw = 0, offset = 0;
    for (const boundary of boundaries) {
      // Case folding can change UTF-16 length (for example, İ). Compare in the
      // folded coordinate space without treating it as a raw source offset.
      offset += member.content.slice(raw, boundary).toLowerCase().length;
      raw = boundary;
      while (at >= 0 && at < offset) { count++; at = source.indexOf(folded, at + folded.length); }
      counts.set(boundary, count);
    }
    cached = { query: folded, counts };
    occurrences.set(member, cached, member.content.length * 2 + counts.size * 32 + folded.length * 2);
  }
  const first = cached.counts.get(section.start) ?? 0;
  const end = cached.counts.get(section.end) ?? first;
  return match.occurrenceIndex >= first && match.occurrenceIndex < end
    ? { ...match, occurrenceIndex: match.occurrenceIndex - first } : undefined;
}
