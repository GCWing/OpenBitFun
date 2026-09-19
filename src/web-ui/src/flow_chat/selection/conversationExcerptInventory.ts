import type { ConversationExcerptContext } from '@/shared/types/context';
import { surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { excerptNumber, isConversationExcerpt } from '@/shared/utils/conversationExcerpt';
import type { QueuedMessage, Session } from '../types/flow-chat';
import type { SessionComposerDraft } from '../store/sessionComposerStore';
import { composerPresentationContexts, parseComposerPresentation } from '../utils/composerPresentation';

const metadataCache = new WeakMap<object, readonly ConversationExcerptContext[]>();
const turnsCache = new WeakMap<Session['dialogTurns'], readonly ConversationExcerptContext[]>();
const EMPTY: readonly ConversationExcerptContext[] = [];

function metadataExcerpts(metadata: Record<string, unknown> | undefined): readonly ConversationExcerptContext[] {
  if (!metadata) return EMPTY;
  const cached = metadataCache.get(metadata);
  if (cached) return cached;
  const presentation = parseComposerPresentation(metadata.composerPresentation);
  const result = presentation ? composerPresentationContexts(presentation).filter(isConversationExcerpt) : EMPTY;
  metadataCache.set(metadata, result);
  return result;
}

/** Sent snapshots retain their numbers for history and subsequent annotation numbering. */
export function sessionConversationExcerpts(session: Session): readonly ConversationExcerptContext[] {
  const cached = turnsCache.get(session.dialogTurns);
  if (cached) return cached;
  const excerpts = session.dialogTurns.flatMap(turn => metadataExcerpts(turn.userMessage?.metadata));
  turnsCache.set(session.dialogTurns, excerpts);
  return excerpts;
}

export function excerptSessionFamily(sessions: ReadonlyMap<string, Session>, sessionId: string): Session[] {
  const session = sessions.get(sessionId);
  const parentId = session?.parentSessionId ?? sessionId;
  return [...sessions.values()].filter(item => item.sessionId === parentId || item.parentSessionId === parentId);
}

export function queuedConversationExcerpts(messages: readonly QueuedMessage[]): ConversationExcerptContext[] {
  return messages.flatMap(message => [
    ...metadataExcerpts(message.userMessageMetadata),
    ...(message.composerDraft?.contexts.filter(isConversationExcerpt) ?? []),
  ]);
}

export type ConversationExcerptSourceIndex = ReadonlyMap<string, readonly ConversationExcerptContext[]>;
export const EMPTY_SOURCE_INDEX: ConversationExcerptSourceIndex = new Map();
const EMPTY_QUEUE: readonly QueuedMessage[] = [];

/**
 * Shared annotation projection, separate from either transcript renderer. Panes
 * consume only their own source index; parent streaming keeps that snapshot stable.
 * Only drafts and queued messages own source marks. Sent snapshots are consumed
 * annotations and must not recreate marks when history is loaded or streamed.
 */
export function createConversationExcerptInventory() {
  let previousDrafts: Readonly<Record<string, SessionComposerDraft>> | undefined;
  let previousQueue = EMPTY_QUEUE;
  let bySource = new Map<string, ConversationExcerptSourceIndex>();
  return (drafts: Readonly<Record<string, SessionComposerDraft>>, queue = EMPTY_QUEUE) => {
    if (drafts === previousDrafts
      && queue.length === previousQueue.length && queue.every((item, i) => item === previousQueue[i])) return bySource;
    previousDrafts = drafts;
    previousQueue = queue;
    const records = new Map<string, ConversationExcerptContext>();
    const add = (excerpt: ConversationExcerptContext) => {
      records.set(surfaceScopedKey(excerpt.source.surfaceId, excerpt.id), excerpt);
    };
    queuedConversationExcerpts(queue).forEach(add);
    Object.values(drafts).forEach(draft => draft.contexts.filter(isConversationExcerpt).forEach(add));
    const next = new Map<string, Map<string, ConversationExcerptContext[]>>();
    for (const excerpt of [...records.values()].sort((a, b) =>
      (excerptNumber(a) ?? Number.MAX_SAFE_INTEGER) - (excerptNumber(b) ?? Number.MAX_SAFE_INTEGER)
      || a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
      const key = surfaceScopedKey(excerpt.source.surfaceId, excerpt.source.sessionId);
      let turns = next.get(key);
      if (!turns) { turns = new Map(); next.set(key, turns); }
      for (const turnId of new Set(excerpt.fragments.map(fragment => fragment.turnId))) {
        const items = turns.get(turnId) ?? [];
        items.push(excerpt);
        turns.set(turnId, items);
      }
    }
    const stable = new Map<string, ConversationExcerptSourceIndex>();
    next.forEach((turns, key) => {
      const previous = bySource.get(key);
      const entries = new Map<string, readonly ConversationExcerptContext[]>();
      turns.forEach((excerpts, turnId) => {
        const old = previous?.get(turnId);
        entries.set(turnId, old?.length === excerpts.length && old.every((excerpt, i) => excerpt === excerpts[i]) ? old : excerpts);
      });
      stable.set(key, previous?.size === entries.size && [...entries].every(([turnId, excerpts]) => previous.get(turnId) === excerpts)
        ? previous : entries);
    });
    bySource = stable;
    return bySource;
  };
}
