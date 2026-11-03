import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { requestGenUIRepair } from './genUIRepair';
import { genUIContentKey } from './genUIState';
import type { GenUIVerification } from './genUIVerification';
import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
const fixture = vi.hoisted(() => ({
  projection: { app: { schemaVersion: 2, id: 'app', title: 'Original', template: 'openbitfun.app', libraryId: 'openbitfun.composable.v1', libraryRevision: 2, designSpec: { id: 'openbitfun.desktop.v1', revision: 1 }, source: { kind: 'openui-lang', content: 'root = Col([])' }, state: {} }, appState: { completed: false }, isStreaming: false },
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/flow_chat/utils/generativeWidgetProjection', () => ({ findGenerativeWidgetProjection: () => fixture.projection }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => ({}) } }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: { sendMessage: fixture.sendMessage } }));
const origin = { type: 'tool-call', toolName: 'GenerativeUI', surfaceId: 'local', sessionId: 'source-session', turnId: 'turn', toolItemId: 'item', toolCallId: 'call', scope: { surfaceId: 'local' } } as GenerativeWidgetOrigin;
const report = (): GenUIVerification => ({ definitionKey: genUIContentKey(fixture.projection.app), state: { completed: true }, preflight: 'passed', render: 'failed', interaction: 'unverified', persistence: 'unverified', reopen: 'unverified', issues: [{ path: 'source', code: 'render', severity: 'error', message: 'Missing source content' }] });
describe('explicit GenUI repair', () => {
  beforeEach(() => { resetDeviceSurfaceForTest(); fixture.sendMessage.mockClear(); fixture.projection.isStreaming = false; });
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
