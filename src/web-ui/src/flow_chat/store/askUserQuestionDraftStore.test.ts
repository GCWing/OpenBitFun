import { beforeEach, describe, expect, it } from 'vitest';

import {
  LOCAL_SURFACE_ID,
  activateSurface,
} from '@/infrastructure/peer-device/deviceSurface';
import {
  askUserQuestionDraftKey,
  askUserQuestionFollowUpDraftKey,
  askUserQuestionDraftStore,
} from './askUserQuestionDraftStore';

describe('askUserQuestionDraftStore', () => {
  beforeEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    askUserQuestionDraftStore.setState({ drafts: {} });
  });

  it('keeps answers and custom input isolated by session and tool call', () => {
    const sessionATool1 = askUserQuestionDraftKey('session-a', 'tool-1');
    const sessionATool2 = askUserQuestionDraftKey('session-a', 'tool-2');
    const sessionBTool1 = askUserQuestionDraftKey('session-b', 'tool-1');
    const store = askUserQuestionDraftStore.getState();

    store.setSingleAnswer(sessionATool1, 0, 'PostgreSQL');
    store.setMultiAnswer(sessionATool1, 1, 'TypeScript', true);
    store.setMultiAnswer(sessionATool1, 1, 'Rust', true);
    store.setOtherInput(sessionATool1, 2, 'Custom answer');
    store.setSingleAnswer(sessionATool2, 0, 'SQLite');
    store.setSingleAnswer(sessionBTool1, 0, 'MySQL');

    expect(askUserQuestionDraftStore.getState().drafts[sessionATool1]).toMatchObject({
      answers: {
        0: 'PostgreSQL',
        1: ['TypeScript', 'Rust'],
      },
      otherInputs: { 2: 'Custom answer' },
    });
    expect(askUserQuestionDraftStore.getState().drafts[sessionATool2].answers[0]).toBe('SQLite');
    expect(askUserQuestionDraftStore.getState().drafts[sessionBTool1].answers[0]).toBe('MySQL');
  });

  it('keeps equal session and tool ids isolated across device surfaces', () => {
    const localKey = askUserQuestionDraftKey('same-session', 'same-tool');
    askUserQuestionDraftStore.getState().setSingleAnswer(localKey, 0, 'Local answer');

    activateSurface('peer-b');
    const peerKey = askUserQuestionDraftKey('same-session', 'same-tool');
    askUserQuestionDraftStore.getState().setSingleAnswer(peerKey, 0, 'Peer answer');

    expect(peerKey).not.toBe(localKey);
    expect(askUserQuestionDraftStore.getState().drafts[localKey].answers[0]).toBe('Local answer');
    expect(askUserQuestionDraftStore.getState().drafts[peerKey].answers[0]).toBe('Peer answer');
  });

  it('preserves pending drafts and removes tools absent from an authoritative mailbox', () => {
    const retainedKey = askUserQuestionDraftKey('session-a', 'tool-retained');
    const removedKey = askUserQuestionDraftKey('session-a', 'tool-removed');
    const otherSessionKey = askUserQuestionDraftKey('session-b', 'tool-removed');
    const store = askUserQuestionDraftStore.getState();
    store.setSingleAnswer(retainedKey, 0, 'Keep');
    store.setSingleAnswer(removedKey, 0, 'Remove');
    store.setSingleAnswer(otherSessionKey, 0, 'Other session');

    store.reconcilePendingTools(LOCAL_SURFACE_ID, 'session-a', ['tool-retained']);

    expect(askUserQuestionDraftStore.getState().drafts[retainedKey]).toBeDefined();
    expect(askUserQuestionDraftStore.getState().drafts[removedKey]).toBeUndefined();
    expect(askUserQuestionDraftStore.getState().drafts[otherSessionKey]).toBeDefined();
  });

  it('retains follow-up drafts through mailbox reconciliation and removes them with their session', () => {
    const pending = askUserQuestionDraftKey('session-a', 'tool-1');
    const followUp = askUserQuestionFollowUpDraftKey('session-a', 'tool-1');
    const peerFollowUp = askUserQuestionFollowUpDraftKey('session-a', 'tool-1', 'peer-a');
    const store = askUserQuestionDraftStore.getState();
    store.setSingleAnswer(pending, 0, 'Old pending answer');
    store.setSingleAnswer(followUp, 0, 'Follow-up answer');
    store.setSingleAnswer(peerFollowUp, 0, 'Peer answer');
    store.reconcilePendingTools(LOCAL_SURFACE_ID, 'session-a', []);
    expect(askUserQuestionDraftStore.getState().drafts[pending]).toBeUndefined();
    expect(askUserQuestionDraftStore.getState().drafts[followUp].answers[0]).toBe('Follow-up answer');
    store.removeSessionDrafts(['session-a']);
    expect(askUserQuestionDraftStore.getState().drafts[followUp]).toBeUndefined();
    expect(askUserQuestionDraftStore.getState().drafts[peerFollowUp]).toBeDefined();
    store.removeSurfaceDrafts('peer-a');
    expect(askUserQuestionDraftStore.getState().drafts).toEqual({});
  });

  it('keeps submission phase across remounts without recreating a cleared draft', () => {
    const key = askUserQuestionDraftKey('session-a', 'tool-1');
    const store = askUserQuestionDraftStore.getState();
    store.setSingleAnswer(key, 0, 'PostgreSQL');
    store.setSubmissionPhase(key, 'submitting');
    expect(askUserQuestionDraftStore.getState().drafts[key].submissionPhase).toBe('submitting');

    store.clearDraft(key);
    store.setSubmissionPhase(key, 'submitted');
    expect(askUserQuestionDraftStore.getState().drafts[key]).toBeUndefined();
  });

  it('removes the Other marker when custom input becomes blank', () => {
    const multiKey = askUserQuestionDraftKey('session-a', 'tool-multi');
    const singleKey = askUserQuestionDraftKey('session-a', 'tool-single');
    const store = askUserQuestionDraftStore.getState();

    store.setMultiAnswer(multiKey, 0, 'PostgreSQL', true);
    store.setMultiAnswer(multiKey, 0, 'Other', true);
    store.setOtherInput(multiKey, 0, 'Custom database');
    store.setOtherInput(multiKey, 0, '   ');

    store.setSingleAnswer(singleKey, 0, 'Other');
    store.setOtherInput(singleKey, 0, 'Custom database');
    store.setOtherInput(singleKey, 0, '');

    expect(askUserQuestionDraftStore.getState().drafts[multiKey]).toMatchObject({
      answers: { 0: ['PostgreSQL'] },
      otherInputs: { 0: '' },
    });
    expect(askUserQuestionDraftStore.getState().drafts[singleKey]).toMatchObject({
      answers: {},
      otherInputs: { 0: '' },
    });
  });

  it('preserves the Other marker for transient blank IME composition values', () => {
    const key = askUserQuestionDraftKey('session-a', 'tool-ime');
    const store = askUserQuestionDraftStore.getState();

    store.setSingleAnswer(key, 0, 'Other');
    store.setOtherInput(key, 0, '', true);

    expect(askUserQuestionDraftStore.getState().drafts[key]).toMatchObject({
      answers: { 0: 'Other' },
      otherInputs: { 0: '' },
    });
  });

  it('cleans up deleted sessions and discarded surfaces without disturbing others', () => {
    const removedSessionKey = askUserQuestionDraftKey('session-a', 'tool-a');
    const retainedSessionKey = askUserQuestionDraftKey('session-b', 'tool-b');
    let store = askUserQuestionDraftStore.getState();
    store.setSingleAnswer(removedSessionKey, 0, 'Remove session');
    store.setSingleAnswer(retainedSessionKey, 0, 'Keep session');

    activateSurface('peer-b');
    const peerKey = askUserQuestionDraftKey('session-a', 'tool-a');
    askUserQuestionDraftStore.getState().setSingleAnswer(peerKey, 0, 'Remove peer');

    activateSurface(LOCAL_SURFACE_ID);
    store = askUserQuestionDraftStore.getState();
    store.removeSessionDrafts(['session-a']);
    expect(askUserQuestionDraftStore.getState().drafts[removedSessionKey]).toBeUndefined();
    expect(askUserQuestionDraftStore.getState().drafts[retainedSessionKey]).toBeDefined();
    expect(askUserQuestionDraftStore.getState().drafts[peerKey]).toBeDefined();

    store.removeSurfaceDrafts('peer-b');
    expect(askUserQuestionDraftStore.getState().drafts[peerKey]).toBeUndefined();
    expect(askUserQuestionDraftStore.getState().drafts[retainedSessionKey]).toBeDefined();
  });
});
