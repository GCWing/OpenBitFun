import type { FlowItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';

function sameNarrative(previous: FlowItem, next: FlowItem, singleSettledAttempt: boolean): boolean {
  if ((previous.type !== 'text' && previous.type !== 'thinking') || next.type !== previous.type) return false;
  const sameAttempt = previous.attemptId === next.attemptId && previous.attemptIndex === next.attemptIndex;
  // Native journal reconstruction can omit item-level attempt fields. The
  // settled round must prove there was only one attempt before bridging it.
  const omittedFirstAttempt = singleSettledAttempt && previous.attemptIndex === 1
    && next.attemptIndex == null && !next.attemptId;
  if (!sameAttempt && !omittedFirstAttempt) return false;
  if (!('content' in previous) || typeof previous.content !== 'string'
    || !('content' in next) || typeof next.content !== 'string') return false;
  // Live chunks coalesce blank lines; host records may retain them. A host can
  // also supply a missing suffix, but replacing/retrying prose is a new block.
  const before = previous.content.replace(/\n{3,}/g, '\n\n');
  const after = next.content.replace(/\n{3,}/g, '\n\n');
  return before.length > 0 && after.startsWith(before);
}

/** Presentation aliases for a live-to-durable item-id handoff, scoped to this view. */
export class TimelineItemIdentity {
  private sources = new Map<string, readonly FlowItem[]>();
  private keys = new WeakMap<FlowItem, string>();
  private sections = new WeakMap<FlowItem, Map<number, number>>();

  /** True only when an existing object's alias changed, invalidating cached rows. */
  reconcile(sources: readonly VirtualItem[]): boolean {
    let cachedKeysChanged = false;
    const nextSources = new Map<string, readonly FlowItem[]>();
    for (const source of sources) {
      if (source.type !== 'model-round' && source.type !== 'explore-group') continue;
      const owner = JSON.stringify([source.turnId, source.type,
        source.type === 'model-round' ? source.data.id : source.data.groupId]);
      const items = source.type === 'model-round' ? source.data.items : source.data.allItems;
      const previous = this.sources.get(owner);
      nextSources.set(owner, items);
      if (items === previous) continue;
      const previousById = new Map(previous?.map(item => [item.id, item]));
      const ids = new Set(items.map(item => item.id));
      const singleSettledAttempt = source.type === 'model-round'
        && source.isTurnComplete && source.data.attemptCount === 1;
      // Only a one-to-one, ordered replacement inside the same source can
      // bridge different canonical IDs. Insertions, removals, moved IDs and
      // tool replacements must keep their own identity.
      const handoff = previous?.length === items.length && items.every((item, index) => {
        const before = previous[index];
        return item.id === before.id && item.type === before.type
          || (!ids.has(before.id) && !previousById.has(item.id) && sameNarrative(before, item, singleSettledAttempt));
      });
      items.forEach((item, index) => {
        const before = previousById.get(item.id) ?? (handoff ? previous![index] : undefined);
        const key = before && before.type === item.type ? this.key(before) : this.key(item);
        const nextKey = key !== item.id && ids.has(key) ? item.id : key;
        const cachedKey = this.keys.get(item);
        if (cachedKey !== undefined && cachedKey !== nextKey) cachedKeysChanged = true;
        this.keys.set(item, nextKey);
        const sections = before && this.sections.get(before);
        if (sections) this.sections.set(item, sections);
      });
    }
    // Evicted Turns retain neither their old source bodies nor alias records.
    this.sources = nextSources;
    return cachedKeysChanged;
  }

  key(item: FlowItem): string { return this.keys.get(item) ?? item.id; }

  /** Display coordinates survive coalesced blank lines; bookmarks keep raw offsets. */
  sectionOffsets(item: FlowItem, sections: readonly { start: number }[]): number[] {
    if (!('content' in item) || typeof item.content !== 'string') return sections.map(section => section.start);
    let keys = this.sections.get(item);
    if (!keys) { keys = new Map(); this.sections.set(item, keys); }
    const runs = item.content.matchAll(/\n{3,}/g);
    let run = runs.next(), removed = 0;
    return sections.map(section => {
      while (!run.done && run.value.index + run.value[0].length <= section.start) {
        removed += run.value[0].length - 2;
        run = runs.next();
      }
      const normalized = section.start - removed;
      const offset = keys.get(normalized) ?? section.start;
      keys.set(normalized, offset);
      return offset;
    });
  }
}
