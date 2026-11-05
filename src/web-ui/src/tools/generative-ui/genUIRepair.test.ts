/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { requestGenUIRepair } from './genUIRepair';
import { genUIContentKey } from './genUIState';
import type { GenUIVerification } from './genUIVerification';
import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
const fixture = vi.hoisted(() => ({
  projection: { app: { schemaVersion: 2, id: 'app', title: 'Original', template: 'openbitfun.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2, designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, source: { kind: 'openui-lang', content: 'root = Col([])' }, state: {} }, appState: { completed: false }, isStreaming: false },
  sendMessage: vi.fn().mockResolvedValue(undefined),
  supported: true,
  refresh: vi.fn().mockResolvedValue({ items: [], activeTurnId: 'running-turn' }),
  submit: vi.fn().mockResolvedValue(undefined),
  state: { activeSessionId: 'source-session', sessions: new Map([['source-session', { mode: 'Standard' }]]) },
}));
vi.mock('@/flow_chat/utils/generativeWidgetProjection', () => ({ findGenerativeWidgetProjection: () => fixture.projection }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => fixture.state } }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: { sendMessage: fixture.sendMessage } }));
vi.mock('@/flow_chat/services/hostDialogQueue', () => ({
  hostQueueSupported: () => fixture.supported,
  hostDialogQueue: () => ({ refresh: fixture.refresh, submit: fixture.submit }),
}));
const origin = { type: 'tool-call', toolName: 'GenerativeUI', surfaceId: 'local', sessionId: 'source-session', turnId: 'turn', toolItemId: 'item', toolCallId: 'call', scope: { surfaceId: 'local' } } as GenerativeWidgetOrigin;
const report = (): GenUIVerification => ({ definitionKey: genUIContentKey(fixture.projection.app), state: { completed: true }, preflight: 'passed', render: 'failed', interaction: 'unverified', persistence: 'unverified', reopen: 'unverified', issues: [{ path: 'source', code: 'render', severity: 'error', message: 'Missing source content' }] });
describe('explicit GenUI repair', () => {
  beforeEach(() => { resetDeviceSurfaceForTest(); fixture.sendMessage.mockClear(); fixture.projection.isStreaming = false;
    fixture.state.activeSessionId = 'source-session'; fixture.supported = true;
    fixture.submit.mockClear(); fixture.refresh.mockReset().mockResolvedValue({ items: [], activeTurnId: 'running-turn' }); });
  it('targets the source session with the complete description, state and actual diagnostics', async () => {
    await requestGenUIRepair(origin, report());
    const [message, target] = fixture.sendMessage.mock.calls[0];
    expect(target).toBe('source-session');
    const payload = JSON.parse(message.split('\n').at(-1));
    expect(payload.definition).toEqual(fixture.projection.app);
    expect(payload.app_state).toEqual({ completed: true });
    expect(payload.saved_app_state).toEqual(fixture.projection.appState);
    expect(payload.verification).toMatchObject({ render: 'failed', reopen: 'unverified' });
    expect(message).toContain('do not remove functionality');
    expect(fixture.sendMessage.mock.calls[0][5]).toMatchObject({ userMessageMetadata: { genUIHostRepair: true } });
  });
  it('queues host evidence during a running turn with a stable id and host metadata', async () => {
    const automatic = { turnId: 'repair-slot', chainId: 'chain', attempt: 1 };
    await requestGenUIRepair(origin, report(), automatic);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.submit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { genUIHostRepair: true, genUIRepair: { chainId: 'chain', attempt: 1 } },
    }), undefined, 'repair-slot');
    fixture.refresh.mockResolvedValueOnce({ items: [{ turnId: 'repair-slot' }] });
    await requestGenUIRepair(origin, report(), automatic);
    expect(fixture.submit).toHaveBeenCalledTimes(1);
  });
  it('refuses unsupported queues and detects navigation during the host read', async () => {
    const automatic = { turnId: 'repair-slot', chainId: 'chain', attempt: 1 };
    fixture.supported = false;
    await expect(requestGenUIRepair(origin, report(), automatic)).rejects.toThrow('host-owned dialog queue');
    fixture.supported = true;
    fixture.refresh.mockImplementationOnce(async () => {
      fixture.state.activeSessionId = 'another';
      return { items: [] };
    });
    await expect(requestGenUIRepair(origin, report(), automatic)).rejects.toThrow('no longer active');
    expect(fixture.submit).not.toHaveBeenCalled();
  });
  it('rejects stale definitions, streaming sources and switched devices', async () => {
    await expect(requestGenUIRepair(origin, { ...report(), definitionKey: 'stale' })).rejects.toThrow('source changed');
    fixture.projection.isStreaming = true;
    await expect(requestGenUIRepair(origin, report())).rejects.toThrow('source changed');
    activateSurface('peer');
    await expect(requestGenUIRepair(origin, report())).rejects.toThrow('device surface');
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });
});
