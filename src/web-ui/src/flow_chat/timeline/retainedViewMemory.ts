import type { FlowChatReaderState } from './readerState';

/**
 * What a transcript view leaves behind when it unmounts, for its next mount.
 *
 * Switching sessions remounts the whole transcript, and a remount starts from
 * estimates: rows reserve guessed heights, the projection rebuilds its keys,
 * and the opening reveal spends commits replacing guesses with measurements it
 * already had. A view takes its entry back while it is mounted and returns it
 * on unmount, so the memory only ever holds views nobody is showing, and only
 * the few most recently left.
 *
 * Keys are the view's reader store, which is already scoped by surface epoch,
 * viewport and session. Only derived, rebuildable data belongs here: never
 * follow, anchor or viewport ownership, which every mount must start fresh.
 */
export class RetainedViewMemory<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  /** Read without claiming, for a render that may not commit. */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Claim the entry for a mounted view, so it does not count against capacity. */
  take(key: K): V | undefined {
    const value = this.entries.get(key);
    this.entries.delete(key);
    return value;
  }

  /** Return a view's state on unmount, dropping the least recently left view. */
  put(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as K);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** About three: the session just left, and the one or two before it. */
export const MAX_RETAINED_SESSION_VIEWS = 3;

/**
 * Measured row sizes of recently left transcripts, by the view's reader store.
 *
 * Switching sessions remounts this list, and with it the virtualizer's size
 * cache. A reopened session reserves what its rows last measured instead of
 * estimates, so the opening reveal has nothing to correct for rows that did not
 * change. Follow, anchor and viewport ownership are not retained: they belong
 * to the mount. Keys come from the retained projection in
 * `useConversationTimeline`, so view-local aliases still match.
 */
export const retainedTranscriptRowSizes = new RetainedViewMemory<FlowChatReaderState, Map<string, number>>(
  MAX_RETAINED_SESSION_VIEWS,
);
