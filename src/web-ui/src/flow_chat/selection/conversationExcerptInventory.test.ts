import { describe, expect, it } from 'vitest';
import { surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import type { ConversationExcerptContext } from '@/shared/types/context';
import type { SessionComposerDraft } from '../store/sessionComposerStore';
import type { QueuedMessage, Session } from '../types/flow-chat';
import { withConversationExcerpts } from '../utils/composerPresentation';
import { createConversationExcerptInventory, sessionConversationExcerpts } from './conversationExcerptInventory';

const excerpt: ConversationExcerptContext = {
  id: 'annotation', type: 'conversation-excerpt', timestamp: 1, annotationNumber: 1,
  source: { surfaceId: 'local', sessionId: 'source', sessionName: 'Source' },
  fragments: [{ turnId: 'turn', flowItemId: 'text', text: 'quote', start: 0, end: 5, prefix: '', suffix: '' }],
  comment: 'Comment',
};
function session(sessionId: string, excerpts: ConversationExcerptContext[] = []): Session {
  return { sessionId, dialogTurns: excerpts.length ? [{ id: 'sent', userMessage: {
    id: 'sent-message', content: 'Question', timestamp: 2,
    metadata: { composerPresentation: withConversationExcerpts(null, excerpts, 'Question') },
  }, modelRounds: [] }] : [] } as unknown as Session;
}
function draft(contexts: ConversationExcerptContext[]): SessionComposerDraft {
  return { contexts, value: '', pendingLargePastes: {}, updatedAt: 1 };
}
const sourceKey = surfaceScopedKey('local', 'source');
const draftKey = surfaceScopedKey('local', 'destination');

describe('shared annotation source inventory', () => {
  it('keeps queued marks until their message is sent or removed', () => {
    const read = createConversationExcerptInventory();
    const queued: QueuedMessage = {
      id: 'queued', sessionId: 'destination', content: 'Question', timestamp: 1, status: 'queued', retryCount: 0,
      userMessageMetadata: { composerPresentation: withConversationExcerpts(null, [excerpt], 'Question') },
      composerDraft: { value: 'Question', contexts: [excerpt], pendingLargePastes: {} },
    };
    const snapshot = read({}, [queued]).get(sourceKey);
    expect(snapshot?.get('turn')).toEqual([excerpt]);
    expect(read({}, [{ ...queued, status: 'sending' }]).get(sourceKey)).toBe(snapshot);
    expect(read({}, []).has(sourceKey)).toBe(false);
    expect(read({}, [{ ...queued, status: 'failed' }]).get(sourceKey)?.get('turn')).toEqual([excerpt]);
    expect(read({}, []).has(sourceKey)).toBe(false);
  });

  it('consumes draft markers on send while preserving sent snapshots for history and numbering', () => {
    const read = createConversationExcerptInventory();
    expect(read({ [draftKey]: draft([excerpt]) }).get(sourceKey)?.get('turn')).toEqual([excerpt]);
    const sent = session('destination', [excerpt]);
    expect(sessionConversationExcerpts(sent)).toEqual([excerpt]);
    expect(read({ [draftKey]: draft([]) }).has(sourceKey)).toBe(false);
    expect(createConversationExcerptInventory()({}).has(sourceKey)).toBe(false);
    const revised = { ...excerpt, comment: 'Revised' };
    expect(read({ [draftKey]: draft([revised]) }).get(sourceKey)?.get('turn')).toEqual([revised]);
    expect(read({}).has(sourceKey)).toBe(false);
    expect(sessionConversationExcerpts(sent)).toEqual([excerpt]);
  });

  it('indexes by source device and session instead of the destination transcript', () => {
    const read = createConversationExcerptInventory();
    const peer = { ...excerpt, source: { ...excerpt.source, surfaceId: 'peer' } };
    const child = { ...excerpt, id: 'child', source: { ...excerpt.source, sessionId: 'child' } };
    const index = read({
      [draftKey]: draft([excerpt, child]),
      [surfaceScopedKey('peer', 'destination')]: draft([peer]),
    });
    expect(index.get(sourceKey)?.get('turn')).toEqual([excerpt]);
    expect(index.get(surfaceScopedKey('peer', 'source'))?.get('turn')).toEqual([peer]);
    expect(index.get(surfaceScopedKey('local', 'child'))?.get('turn')).toEqual([child]);
    expect(index.has(surfaceScopedKey('local', 'destination'))).toBe(false);
  });

  it('preserves source snapshots during unrelated draft typing and consumes only submitted annotations', () => {
    const read = createConversationExcerptInventory();
    const other = { ...excerpt, id: 'other', source: { ...excerpt.source, sessionId: 'side' } };
    const otherKey = surfaceScopedKey('local', 'side');
    const drafts = { [draftKey]: draft([excerpt]), [otherKey]: draft([other]) };
    const first = read(drafts);
    expect(read({ ...drafts, [otherKey]: { ...drafts[otherKey], value: 'Typing' } }).get(sourceKey)).toBe(first.get(sourceKey));
    const remaining = read({ [otherKey]: drafts[otherKey] });
    expect(remaining.has(sourceKey)).toBe(false);
    expect(remaining.get(otherKey)).toBe(first.get(otherKey));
  });
});
