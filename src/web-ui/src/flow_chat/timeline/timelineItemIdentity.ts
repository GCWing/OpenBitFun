import type { FlowItem } from '../types/flow-chat';
import type { VirtualItem } from '../types/flow-chat-projection';

function sameNarrative(previous: FlowItem, next: FlowItem): boolean {
  if ((previous.type !== 'text' && previous.type !== 'thinking') || next.type !== previous.type) return false;
  if (previous.attemptId !== next.attemptId || previous.attemptIndex !== next.attemptIndex) return false;
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
      // Only a one-to-one, ordered replacement inside the same source can
      // bridge different canonical IDs. Insertions, removals, moved IDs and
      // tool replacements must keep their own identity.
      const handoff = previous?.length === items.length && items.every((item, index) => {
        const before = previous[index];
        return item.id === before.id && item.type === before.type
          || (!ids.has(before.id) && !previousById.has(item.id) && sameNarrative(before, item));
      });
      items.forEach((item, index) => {
        const before = previousById.get(item.id) ?? (handoff ? previous![index] : undefined);
        const key = before && before.type === item.type ? this.key(before) : this.key(item);
        const nextKey = key !== item.id && ids.has(key) ? item.id : key;
        const cachedKey = this.keys.get(item);
        if (cachedKey !== undefined && cachedKey !== nextKey) cachedKeysChanged = true;
        this.keys.set(item, nextKey);
      });
    }
    // Evicted Turns retain neither their old source bodies nor alias records.
    this.sources = nextSources;
    return cachedKeysChanged;
  }

  key(item: FlowItem): string { return this.keys.get(item) ?? item.id; }
}
