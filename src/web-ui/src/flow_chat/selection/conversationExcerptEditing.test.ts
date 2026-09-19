// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { useContextStore } from '@/shared/stores/contextStore';
import type { ConversationExcerptContext, FileContext } from '@/shared/types/context';
import { formatConversationExcerpt, withConversationExcerptFallback } from '@/shared/utils/conversationExcerpt';
import { pendingQueueManager } from '../services/flow-chat-manager/PendingQueueModule';
import { sessionComposerStore } from '../store/sessionComposerStore';
import type { QueuedMessage } from '../types/flow-chat';
import { withConversationExcerpts } from '../utils/composerPresentation';
import { conversationExcerptDialogTarget, reviseQueuedExcerpt } from './conversationExcerptEditing';

const state = vi.hoisted(() => ({ sessions: new Map<string, unknown>() }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: { getState: () => state } }));

const excerpt: ConversationExcerptContext = {
  id: 'annotation', type: 'conversation-excerpt', timestamp: 1, annotationNumber: 2,
  source: { surfaceId: 'local', sessionId: 'main', sessionName: 'Source' },
  fragments: [{ turnId: 'turn', text: 'quote', start: 0, end: 5, prefix: '', suffix: '' }],
  comment: 'Original comment',
};
const file: FileContext = { id: 'file', type: 'file', timestamp: 1, filePath: '/workspace/file.ts', fileName: 'file.ts' };
function editableTarget(note = excerpt) {
  const target = conversationExcerptDialogTarget(note, 'source');
  expect(target.mode).toBe('edit');
  if (target.mode !== 'edit') throw new Error('Expected a pending annotation editor');
  return target;
}
function queued(note = excerpt): QueuedMessage {
  const other = { ...excerpt, id: 'other', annotationNumber: 3, comment: 'Other comment' };
  return {
    id: 'queued', sessionId: 'main', status: 'queued', retryCount: 0, timestamp: 1,
    content: withConversationExcerptFallback('Expanded file and paste content\n  retain whitespace', [note, other]),
    displayMessage: withConversationExcerptFallback('Question', [note, other]),
    composerDraft: { value: 'Question', contexts: [file, note, other], pendingLargePastes: { paste: 'Retain large paste' } },
    imageContexts: [{ id: 'image', type: 'image' }], imageDisplayData: [{ id: 'image', name: 'photo.png' }],
    userMessageMetadata: { extra: 'Retain metadata', composerPresentation: withConversationExcerpts(null, [note, other], 'Question') },
  };
}

beforeEach(() => {
  activateSurface('local');
  useContextStore.getState().clearContexts();
  sessionComposerStore.setState({ drafts: {} });
  state.sessions.clear();
  state.sessions.set('main', { sessionId: 'main', dialogTurns: [] });
  state.sessions.set('side', { sessionId: 'side', parentSessionId: 'main', sessionKind: 'btw', dialogTurns: [] });
});
afterEach(() => {
  pendingQueueManager.clearSurface('local');
  pendingQueueManager.clearSurface('peer');
  activateSurface('local');
});

describe('annotation editor ownership', () => {
  it('edits the latest visible annotation and its pending drafts without changing IDs or other attachments', () => {
    sessionComposerStore.getState().setContexts('main', [file, excerpt]);
    sessionComposerStore.getState().setContexts('side', [excerpt]);
    sessionComposerStore.getState().setValue('main', 'Keep my question');
    useContextStore.getState().replaceContexts([file, { ...excerpt, comment: 'Latest visible comment' }]);
    const target = editableTarget();
    expect(target.excerpt.comment).toBe('Latest visible comment');
    expect(target.save('  Revised  ')).toBe('saved');
    const revised = { ...excerpt, comment: 'Revised' };
    expect(useContextStore.getState().contexts).toEqual([file, revised]);
    expect(sessionComposerStore.getState().getDraft('main')).toMatchObject({ value: 'Keep my question', contexts: [file, revised] });
    expect(sessionComposerStore.getState().getDraft('side').contexts).toEqual([revised]);
  });

  it('updates the queued prompt, fallback, draft and presentation together while preserving expanded context and images', () => {
    const original = pendingQueueManager.enqueue(queued());
    const target = editableTarget();
    expect(target.save('  Revised  ')).toBe('saved');
    const result = pendingQueueManager.list('main')[0];
    const revised = { ...excerpt, comment: 'Revised' };
    expect(result.content).toBe(original.content.replace(formatConversationExcerpt(excerpt), formatConversationExcerpt(revised)));
    expect(result.displayMessage).toBe(original.displayMessage!.replace(formatConversationExcerpt(excerpt), formatConversationExcerpt(revised)));
    expect(result.composerDraft).toEqual({ ...original.composerDraft, contexts: [file, revised, original.composerDraft!.contexts[2]] });
    expect(result.userMessageMetadata).toEqual({ ...original.userMessageMetadata,
      composerPresentation: withConversationExcerpts(null, [revised, original.composerDraft!.contexts[2]], 'Question'),
    });
    expect(result).toMatchObject({ id: original.id, timestamp: original.timestamp, status: original.status, retryCount: original.retryCount });
    expect(result.imageContexts).toBe(original.imageContexts);
    expect(result.imageDisplayData).toBe(original.imageDisplayData);
    expect(original.content).toContain('Original comment');
  });

  it('removes an annotation from its visible and stored drafts without changing other input', () => {
    const other = { ...excerpt, id: 'other', annotationNumber: 3 };
    sessionComposerStore.getState().setContexts('main', [file, excerpt, other]);
    sessionComposerStore.getState().setContexts('side', [excerpt]);
    sessionComposerStore.getState().setValue('main', 'Keep my question');
    useContextStore.getState().replaceContexts([file, excerpt, other]);
    const target = editableTarget();
    expect(target.remove()).toBe('removed');
    expect(useContextStore.getState().contexts).toEqual([file, other]);
    expect(sessionComposerStore.getState().getDraft('main')).toMatchObject({ value: 'Keep my question', contexts: [file, other] });
    expect(sessionComposerStore.getState().getDraft('side').contexts).toEqual([]);
    expect(target.remove()).toBe('unavailable');
    expect(target.save('Do not restore')).toBe('unavailable');
  });

  it('removes queued annotations from the actual prompt, fallback and attachments together', () => {
    const original = pendingQueueManager.enqueue(queued());
    sessionComposerStore.getState().setContexts('side', [excerpt]);
    const target = editableTarget();
    expect(target.remove()).toBe('removed');
    const result = pendingQueueManager.list('main')[0];
    const other = original.composerDraft!.contexts[2];
    expect(result.content).toBe(original.content.replace(formatConversationExcerpt(excerpt), ''));
    expect(result.displayMessage).toBe(original.displayMessage!.replace(formatConversationExcerpt(excerpt), ''));
    expect(result.composerDraft).toEqual({ ...original.composerDraft, contexts: [file, other] });
    expect(result.userMessageMetadata).toEqual({ ...original.userMessageMetadata,
      composerPresentation: withConversationExcerpts(null, [other], 'Question'),
    });
    expect(result).toMatchObject({ id: original.id, timestamp: original.timestamp, status: original.status, retryCount: original.retryCount });
    expect(result.imageContexts).toBe(original.imageContexts);
    expect(result.imageDisplayData).toBe(original.imageDisplayData);
    expect(sessionComposerStore.getState().getDraft('side').contexts).toEqual([]);
    expect(original.content).toContain('Original comment');
  });

  it('supports older unnumbered queue records with presentation metadata and no composer draft', () => {
    const legacy = { ...excerpt, annotationNumber: undefined };
    const original = queued(legacy);
    delete original.composerDraft;
    const result = reviseQueuedExcerpt(original, legacy, 'Legacy revision');
    expect(result?.content).toContain(formatConversationExcerpt({ ...legacy, comment: 'Legacy revision' }));
    expect(result?.composerDraft).toBeUndefined();
    expect(result?.userMessageMetadata).toMatchObject({ composerPresentation: { segments: expect.arrayContaining([
      expect.objectContaining({ kind: 'context', context: { ...legacy, comment: 'Legacy revision' } }),
    ]) } });
    const removed = reviseQueuedExcerpt(original, legacy, null);
    expect(removed?.content).not.toContain(formatConversationExcerpt(legacy));
    expect(removed?.composerDraft).toBeUndefined();
    expect(removed?.userMessageMetadata).toEqual({ ...original.userMessageMetadata,
      composerPresentation: withConversationExcerpts(null, [queued().composerDraft!.contexts[2]], 'Question'),
    });
  });

  it.each(['unsupported legacy prompt', `${formatConversationExcerpt(excerpt)}\n${formatConversationExcerpt(excerpt)}`])(
    'retains a queue payload whose original annotation cannot be replaced uniquely (%#)', content => {
      const original = pendingQueueManager.enqueue({ ...queued(), content });
      expect(editableTarget().save('Revision')).toBe('queue-unavailable');
      sessionComposerStore.getState().setContexts('side', [excerpt]);
      expect(editableTarget().remove()).toBe('queue-unavailable');
      expect(sessionComposerStore.getState().getDraft('side').contexts).toEqual([excerpt]);
      expect(pendingQueueManager.list('main')[0]).toBe(original);
    },
  );

  it('does not edit an in-flight queue or recreate a removed pending annotation', () => {
    const queuedMessage = pendingQueueManager.enqueue(queued());
    const target = editableTarget();
    pendingQueueManager.setStatus('main', queuedMessage.id, 'sending');
    expect(conversationExcerptDialogTarget(excerpt, 'source').mode).toBe('view');
    expect(target.save('Too late')).toBe('queue-unavailable');
    expect(target.remove()).toBe('queue-unavailable');
    expect(pendingQueueManager.list('main')[0].content).toBe(queuedMessage.content);
    pendingQueueManager.consumeNext('main');
    expect(target.save('Too late')).toBe('unavailable');
    expect(target.remove()).toBe('unavailable');
    expect(conversationExcerptDialogTarget(excerpt, 'source').mode).toBe('view');
    expect(sessionComposerStore.getState().getDraft('main').contexts).toEqual([]);
  });

  it('isolates equal annotation IDs across devices and rejects editors from an earlier activation', () => {
    const peerExcerpt = { ...excerpt, source: { ...excerpt.source, surfaceId: 'peer' } };
    sessionComposerStore.getState().setContexts('main', [excerpt], 'local');
    sessionComposerStore.getState().setContexts('main', [peerExcerpt], 'peer');
    const local = editableTarget();
    activateSurface('peer');
    expect(local.isCurrent()).toBe(false);
    expect(local.save('Wrong device')).toBe('unavailable');
    expect(local.remove()).toBe('unavailable');
    const peer = editableTarget(peerExcerpt);
    expect(peer.save('Peer revision')).toBe('saved');
    expect(sessionComposerStore.getState().getDraft('main', 'peer').contexts).toEqual([{ ...peerExcerpt, comment: 'Peer revision' }]);
    expect(sessionComposerStore.getState().getDraft('main', 'local').contexts).toEqual([excerpt]);
    activateSurface('peer');
    expect(peer.save('Old activation')).toBe('unavailable');
    expect(peer.remove()).toBe('unavailable');
  });

  it('exposes no edit capability for sent snapshots, including ones that also appear in pending drafts', () => {
    const history = { sessionId: 'main', dialogTurns: [{ userMessage: {
      content: formatConversationExcerpt(excerpt), metadata: { composerPresentation: withConversationExcerpts(null, [excerpt]) },
    } }] };
    state.sessions.set('main', history);
    const snapshot = structuredClone(history);
    const source = conversationExcerptDialogTarget(excerpt, 'source');
    expect(source.mode).toBe('view');
    expect('save' in source).toBe(false);
    const draft = { ...excerpt, comment: 'Unsent draft' };
    sessionComposerStore.getState().setContexts('main', [draft]);
    useContextStore.getState().replaceContexts([draft]);
    const target = conversationExcerptDialogTarget(excerpt, 'sent');
    expect(target.mode).toBe('view');
    expect(target.excerpt).toBe(excerpt);
    expect('save' in target).toBe(false);
    expect('remove' in target).toBe(false);
    expect(useContextStore.getState().contexts).toEqual([draft]);
    expect(history).toEqual(snapshot);
  });
});
