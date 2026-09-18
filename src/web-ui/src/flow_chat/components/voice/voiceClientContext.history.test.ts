import { describe, expect, it, vi } from 'vitest';
import { buildVoiceClientContext, MAX_VOICE_CONTEXT_BYTES } from './voiceClientContext';

const fixture = vi.hoisted(() => ({ sessions: new Map() }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ FlowChatManager: { getInstance: () => ({ getFlowChatState: () => ({ sessions: fixture.sessions }) }) } }));
vi.mock('@/flow_chat/state-machine', () => ({ stateMachineManager: { getCurrentState: () => 'idle' } }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: { getState: () => ({ openedWorkspaces: new Map() }) } }));
vi.mock('@/app/stores/sceneStore', () => ({ selectActiveSceneId: () => 'session', useSceneStore: { getState: () => ({ openTabs: [] }) } }));

describe('voice context public history budget', () => {
  it('fits full UTF-8 JSON and keeps the latest bound conversation rather than unrelated text', () => {
    const turn = (user: string, assistant: string) => ({ userMessage: { content: user }, modelRounds: [{ items: [{ type: 'text', content: assistant }, { type: 'thinking', content: 'private reasoning' }] }], status: 'completed' });
    fixture.sessions.set('bound', { sessionId: 'bound', config: {}, lastActiveAt: 1, dialogTurns: Array.from({ length: 20 }, (_, index) => turn('中文😀'.repeat(2000), `${'reply'.repeat(1000)}last-${index}`)) });
    fixture.sessions.set('unrelated', { sessionId: 'unrelated', config: {}, lastActiveAt: 0, dialogTurns: [turn('unrelated secret', 'private other answer')] });
    const snapshot = buildVoiceClientContext(null, { kind: 'control', surfaceId: 'local', sessionId: 'bound', workspacePath: '/control' });
    const json = JSON.stringify(snapshot);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_VOICE_CONTEXT_BYTES);
    expect(JSON.parse(json).voice_call_target.session_id).toBe('bound');
    expect(snapshot.voice_call_target?.history_truncated).toBe(true);
    expect(json).toContain('last-19');
    expect(json).not.toContain('private reasoning');
    expect(json).not.toContain('unrelated secret');
  });
});
