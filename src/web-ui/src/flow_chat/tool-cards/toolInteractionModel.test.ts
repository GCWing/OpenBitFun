import { describe, expect, it } from 'vitest';
import type { FlowToolItem, Session } from '../types/flow-chat';
import { readInteractionInput, readToolRecord, resolveInteractionAgentSessionId } from './toolInteractionModel';

const item = (overrides: Partial<FlowToolItem> = {}): FlowToolItem => ({
  id: 'send', type: 'tool', toolName: 'AgentSendInput', status: 'completed', timestamp: 1,
  toolCall: { id: 'send', input: { agent_id: 'maintainer', prompt: 'Continue' } }, ...overrides,
});
const parent = (items: FlowToolItem[]) => ({ dialogTurns: [{ modelRounds: [{ items }] }] }) as Pick<Session, 'dialogTurns'>;

describe('tool interaction history projection', () => {
  it('reads JSON records without requiring new persisted fields and tolerates malformed legacy data', () => {
    const payload = { agent_id: 'maintainer', prompt: 'Keep whitespace\n' };
    expect(readToolRecord(JSON.stringify(payload))).toEqual(payload);
    expect(readToolRecord(JSON.stringify(readToolRecord(JSON.stringify(payload))))).toEqual(payload);
    for (const value of [null, undefined, '', '[1]', 'false', '{']) expect(readToolRecord(value)).toEqual({});
  });

  it('uses deferred streaming parameters without losing the known recipient', () => {
    expect(readInteractionInput(item({ isParamsStreaming: true,
      partialParams: { tool_name: 'AgentSendInput', args: { prompt: 'Keep working' } },
    }))).toEqual({ agent_id: 'maintainer', prompt: 'Keep working' });
  });

  it('resolves only an explicit matching agent link in the current parent history', () => {
    const launch = item({ id: 'launch', toolName: 'AgentSpawn', subagentSessionId: 'remote-child' });
    const unrelated = item({ id: 'other', toolName: 'AgentSpawn', subagentSessionId: 'different-child',
      toolCall: { id: 'other', input: { agent_id: 'triage' } } });
    expect(resolveInteractionAgentSessionId(item(), parent([launch, unrelated]))).toBe('remote-child');
    expect(resolveInteractionAgentSessionId(item(), parent([unrelated]))).toBe('');
    expect(resolveInteractionAgentSessionId(item())).toBe('');
  });

  it('keeps direct links authoritative when replaying old or not-yet-hydrated sessions', () => {
    expect(resolveInteractionAgentSessionId(item({ subagentSessionId: 'recorded-child' }))).toBe('recorded-child');
    expect(resolveInteractionAgentSessionId(item({ toolResult: {
      success: true, result: JSON.stringify({ session_id: 'historical-child' }),
    } }))).toBe('historical-child');
  });

  it('does not borrow the identity of a later relaunch with the same agent alias', () => {
    const send = item();
    const first = item({ id: 'first-launch', toolName: 'AgentSpawn', subagentSessionId: 'first-child' });
    const later = item({ id: 'later-launch', toolName: 'AgentSpawn', subagentSessionId: 'later-child' });
    expect(resolveInteractionAgentSessionId(send, parent([first, send, later]))).toBe('first-child');
  });

  it('does not attach an unlinked relaunch or its messages to a previous child', () => {
    const first = item({ id: 'first-launch', toolName: 'AgentSpawn', subagentSessionId: 'first-child' });
    const relaunch = item({ id: 'new-launch', toolName: 'AgentSpawn' });
    const send = item();
    const history = parent([first, relaunch, send]);
    expect(resolveInteractionAgentSessionId(relaunch, history)).toBe('');
    expect(resolveInteractionAgentSessionId(send, history)).toBe('');
  });
});
