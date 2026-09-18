import { describe, expect, it } from 'vitest';
import { controlConversationTranscript, controlTranscriptStartIndex } from './controlConversationTranscript';
import type { DialogTurn } from '../../types/flow-chat';
import type { VoiceConversationTranscript } from './voiceConversationLedger';

const scope = { surfaceId: 'local', sessionId: 'control' };
const live = (id = 'voice-1'): VoiceConversationTranscript => ({
  target: { ...scope, kind: 'control', workspacePath: '/control' },
  exchanges: [{ id, startedAt: 20, user: 'Same words', assistant: 'Reply' }],
});
const turn = (id: string, voiceTaskId?: string): DialogTurn => ({
  id, sessionId: 'control', startTime: 20, status: 'completed', modelRounds: [],
  userMessage: { id: `${id}-user`, timestamp: 20, content: 'Same words', metadata: { voiceTaskId } },
});

describe('control conversation transcript projection', () => {
  it('replaces a persisted voice preview by its stable exchange identity', () => {
    const preview = controlConversationTranscript(scope, [], live());
    const saved = controlConversationTranscript(scope, [turn('voice-1')], live());
    expect(preview.map(row => row.id)).toEqual(saved.map(row => row.id));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toHaveProperty('turn');
  });
  it('hands a delegated exchange to the native task without repeating the user message', () => {
    const result = controlConversationTranscript(scope, [turn('native-turn', 'voice-1')], live());
    expect(result.map(row => row.id)).toEqual(['voice-1']);
    expect(result[0]).toHaveProperty('turn.id', 'native-turn');
  });
  it('retains repeated utterances with different identities and orders previews with history', () => {
    const old = { ...turn('old'), startTime: 10 };
    expect(controlConversationTranscript(scope, [old], live()).map(row => row.id)).toEqual(['old', 'voice-1']);
  });
  it('does not mix the same session id from another device or another conversation', () => {
    expect(controlConversationTranscript({ ...scope, surfaceId: 'peer' }, [], live())).toEqual([]);
    expect(controlConversationTranscript({ ...scope, sessionId: 'other' }, [], live())).toEqual([]);
  });
  it('keeps the oldest visible record when new messages arrive or older history is loaded', () => {
    const turns = Array.from({ length: 60 }, (_, index) => ({ ...turn(`turn-${index}`), startTime: index }));
    const initial = controlConversationTranscript(scope, turns, null);
    const first = initial[controlTranscriptStartIndex(initial, null, 40)].id;
    expect(first).toBe('turn-20');

    const withNewMessage = controlConversationTranscript(scope, [...turns, { ...turn('new'), startTime: 60 }], null);
    expect(withNewMessage.slice(controlTranscriptStartIndex(withNewMessage, first, 40)).map(row => row.id))
      .toEqual([...initial.slice(20).map(row => row.id), 'new']);

    const withOlderHistory = controlConversationTranscript(scope, [{ ...turn('older'), startTime: -1 }, ...turns], null);
    expect(withOlderHistory[controlTranscriptStartIndex(withOlderHistory, first, 40)].id).toBe(first);
    expect(controlTranscriptStartIndex([], first, 40)).toBe(0);
  });
});
