// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceExchange } from './controlConversation';

const fixture = vi.hoisted(() => ({
  invoke: vi.fn(), ensure: vi.fn(), history: vi.fn(), addSession: vi.fn(), sessions: new Map(),
  desktop: true, capablePeer: false, resetCapablePeer: false,
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: fixture.invoke } }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { ensureCoordinatorSession: fixture.ensure } }));
vi.mock('@/infrastructure/peer-device/PeerConnectionManager', () => ({ peerConnectionManager: {
  get: () => ({ getState: () => ({ capabilities: { controlConversationV1: fixture.capablePeer, controlConversationResetV1: fixture.resetCapablePeer } }) }),
} }));
vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => fixture.desktop }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: {
  getState: () => ({ sessions: fixture.sessions }), loadSessionHistory: fixture.history,
  addExternalSession: fixture.addSession,
} }));
vi.mock('../session-drivers/resolve', () => ({ resolveSessionDriverId: () => 'local' }));

const exchange: VoiceExchange = {
  surfaceId: 'local', sessionId: 'conversation', workspaceId: 'workspace-remote',
  exchangeId: 'exchange-1', userText: 'Remember blue', assistantText: 'Okay',
};
const key = (request: VoiceExchange) => 'openbitfun-voice-exchange:'
  + JSON.stringify([request.surfaceId, request.sessionId, request.exchangeId]);

describe('voice history recovery', () => {
  let service: typeof import('./controlConversation');
  let activateSurface: typeof import('@/infrastructure/peer-device/deviceSurface')['activateSurface'];

  beforeEach(async () => {
    vi.resetModules(); vi.resetAllMocks(); localStorage.clear(); fixture.sessions.clear();
    fixture.desktop = true; fixture.capablePeer = false; fixture.resetCapablePeer = false;
    fixture.addSession.mockImplementation((sessionId: string) => fixture.sessions.set(sessionId, { dialogTurns: [] }));
    service = await import('./controlConversation');
    ({ activateSurface } = await import('@/infrastructure/peer-device/deviceSurface'));
    activateSurface('local');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requires the desktop adapter or a peer that advertises the history contract', async () => {
    expect(service.supportsControlConversation()).toBe(true);
    fixture.desktop = false;
    await expect(service.ensureControlConversation()).rejects.toThrow('not available on the web server');
    expect(fixture.invoke).not.toHaveBeenCalled();
    activateSurface('peer');
    expect(service.supportsControlConversation()).toBe(false);
    fixture.capablePeer = true;
    expect(service.supportsControlConversation()).toBe(true);
  });

  it('does not require browser storage or host calls for ordinary text', async () => {
    vi.stubGlobal('localStorage', undefined);
    expect(service.hasPendingVoiceExchanges('conversation')).toBe(false);
    await service.replayVoiceExchanges('conversation');
    expect(fixture.ensure).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it('requires explicit reset support on a peer instead of probing an older host', async () => {
    activateSurface('peer'); fixture.capablePeer = true;
    expect(service.supportsNewControlConversation()).toBe(false);
    await expect(service.createControlConversation('old')).rejects.toThrow('Update the target host');
    expect(fixture.invoke).not.toHaveBeenCalled();
    fixture.resetCapablePeer = true;
    fixture.invoke.mockResolvedValue({ sessionId: 'new', workspaceId: 'workspace-control', workspacePath: '/peer/control' });
    await service.createControlConversation('old');
    expect(fixture.invoke).toHaveBeenCalledWith('create_control_conversation', { request: { expectedSessionId: 'old' } });
    expect(fixture.addSession).toHaveBeenCalledWith('new', 'OpenBitFun', 'OpenBitFun', '/peer/control',
      { isTransient: true, agentBackedTransient: true, workspaceId: 'workspace-control' });
    expect(fixture.history).toHaveBeenCalledWith('new', { includeInternal: true });
  });

  it('rejects a host that reports the control conversation without its workspace identity', async () => {
    fixture.invoke.mockResolvedValue({ sessionId: 'legacy', workspacePath: '/control' });
    await expect(service.ensureControlConversation()).rejects.toThrow('did not report the control conversation workspace');
    expect(fixture.addSession).not.toHaveBeenCalled();
    expect(fixture.history).not.toHaveBeenCalled();
  });

  it('serializes initial selection and reset, retains old records, and reuses the in-flight selection', async () => {
    let finishInitial!: (value: unknown) => void;
    fixture.invoke.mockImplementationOnce(() => new Promise(resolve => { finishInitial = resolve; }))
      .mockResolvedValueOnce({ sessionId: 'new', workspaceId: 'workspace-control', workspacePath: '/control' });
    const initial = service.ensureControlConversation();
    const created = service.createControlConversation('old');
    const reopened = service.ensureControlConversation();
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
    expect(reopened).toBe(created);
    finishInitial({ sessionId: 'old', workspaceId: 'workspace-control', workspacePath: '/control' });
    await initial;
    expect(await created).toEqual({ sessionId: 'new', workspaceId: 'workspace-control', workspacePath: '/control' });
    expect(fixture.sessions.has('old')).toBe(true);
    expect(fixture.sessions.has('new')).toBe(true);
    expect(fixture.invoke.mock.calls.map(call => call[0])).toEqual(['ensure_control_conversation', 'create_control_conversation']);
  });

  it('does not hydrate a new conversation into a different device after an in-flight switch', async () => {
    let complete!: (value: unknown) => void;
    fixture.invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const created = service.createControlConversation('old');
    activateSurface('peer');
    complete({ sessionId: 'new', workspaceId: 'workspace-control', workspacePath: '/local/control' });
    await expect(created).rejects.toThrow();
    expect(fixture.addSession).not.toHaveBeenCalled();
    expect(fixture.history).not.toHaveBeenCalled();
  });

  it('restores the original workspace route and removes history only after host acknowledgement', async () => {
    fixture.sessions.set(exchange.sessionId, { dialogTurns: [] });
    fixture.invoke.mockRejectedValueOnce(new Error('offline'));
    service.stageVoiceExchange(exchange);
    await expect(service.replayVoiceExchanges(exchange.sessionId)).rejects.toThrow('awaiting recovery');
    expect(localStorage.getItem(key(exchange))).not.toBeNull();
    expect(service.hasPendingVoiceExchanges(exchange.sessionId)).toBe(true);
    await service.replayVoiceExchanges(exchange.sessionId);
    expect(fixture.ensure).toHaveBeenCalledWith({ sessionId: exchange.sessionId,
      workspaceId: exchange.workspaceId, includeInternal: true });
    expect(fixture.invoke).toHaveBeenLastCalledWith('record_voice_exchange', { request: {
      sessionId: exchange.sessionId, exchangeId: exchange.exchangeId,
      userText: exchange.userText, assistantText: exchange.assistantText,
    } });
    expect(localStorage.getItem(key(exchange))).toBeNull();
    expect(service.hasPendingVoiceExchanges(exchange.sessionId)).toBe(false);
    expect(fixture.history).toHaveBeenCalledOnce();
  });

  it('upgrades a path-only record from an older build through its loaded conversation', async () => {
    const { workspaceId: _current, ...legacy } = exchange;
    localStorage.setItem(key(exchange), JSON.stringify({ ...legacy, workspacePath: '/remote/project', remoteConnectionId: 'ssh-1' }));
    await expect(service.replayVoiceExchanges(exchange.sessionId)).rejects.toThrow('awaiting recovery');
    expect(localStorage.getItem(key(exchange))).not.toBeNull();
    expect(fixture.ensure).not.toHaveBeenCalled();
    fixture.sessions.set(exchange.sessionId, { dialogTurns: [], workspaceId: 'workspace-remote' });
    await service.replayVoiceExchanges(exchange.sessionId);
    expect(fixture.ensure).toHaveBeenCalledWith({ sessionId: exchange.sessionId, workspaceId: 'workspace-remote', includeInternal: true });
    expect(localStorage.getItem(key(exchange))).toBeNull();
  });

  it('does not replay a same-id session on another device', async () => {
    service.stageVoiceExchange(exchange);
    activateSurface('peer');
    expect(service.hasPendingVoiceExchanges(exchange.sessionId)).toBe(false);
    await service.replayVoiceExchanges();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(key(exchange))).not.toBeNull();
  });

  it('retains malformed history while allowing other valid conversations to recover', async () => {
    localStorage.setItem(key(exchange), JSON.stringify({ ...exchange, surfaceId: 'other-device' }));
    const valid = { ...exchange, sessionId: 'valid-conversation' };
    service.stageVoiceExchange(valid);
    await expect(service.replayVoiceExchanges()).rejects.toThrow('awaiting recovery');
    expect(localStorage.getItem(key(exchange))).not.toBeNull();
    expect(localStorage.getItem(key(valid))).toBeNull();
    expect(fixture.invoke).toHaveBeenCalledOnce();
    await expect(service.replayVoiceExchanges(exchange.sessionId)).rejects.toThrow('awaiting recovery');
    await service.replayVoiceExchanges('unrelated-text-session');
  });

  it('keeps pending history while the conversation is running', async () => {
    fixture.sessions.set(exchange.sessionId, { dialogTurns: [{ status: 'processing' }] });
    service.stageVoiceExchange(exchange);
    await service.replayVoiceExchanges(exchange.sessionId);
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(service.hasPendingVoiceExchanges(exchange.sessionId)).toBe(true);
  });
});
