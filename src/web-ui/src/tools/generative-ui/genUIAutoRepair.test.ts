/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import type { GenerativeWidgetOrigin } from '@/flow_chat/utils/generativeWidgetProjection';
import type { GenUIVerification } from './genUIVerification';
import { requestGenUIAutoRepair } from './genUIAutoRepair';

const fixture = vi.hoisted(() => ({
  repair: vi.fn().mockResolvedValue(undefined),
  state: { activeSessionId: 'session', sessions: new Map<string, any>() },
}));
vi.mock('./genUIRepair', () => ({ requestGenUIRepair: fixture.repair }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => fixture.state } }));
const origin = { surfaceId: 'local', sessionId: 'session', turnId: 'turn', toolCallId: 'call' } as GenerativeWidgetOrigin;
const report = (definitionKey = 'version-1'): GenUIVerification => ({
  appId: 'app', definitionKey, state: {}, preflight: 'passed', render: 'failed',
  interaction: 'unverified', persistence: 'unverified', reopen: 'unverified', issues: [],
  diagnostics: [{ source: 'parser', code: 'parse-failed', message: 'No statements parsed' }],
});
beforeEach(() => {
  resetDeviceSurfaceForTest();
  localStorage.clear();
  fixture.repair.mockReset().mockResolvedValue(undefined);
  fixture.state.activeSessionId = 'session';
  fixture.state.sessions.clear();
});
describe('automatic GenUI repair admission', () => {
  it('persists error deduplication and caps distinct failed revisions at two attempts', async () => {
    expect(await requestGenUIAutoRepair(origin, report())).toBe(true);
    expect(await requestGenUIAutoRepair(origin, report())).toBe(false);
    expect(await requestGenUIAutoRepair(origin, report('version-2'))).toBe(true);
    expect(await requestGenUIAutoRepair(origin, report('version-3'))).toBe(false);
    expect(fixture.repair).toHaveBeenCalledTimes(2);
    const [, , first] = fixture.repair.mock.calls[0];
    expect(first).toMatchObject({ attempt: 1 });
    expect(fixture.repair.mock.calls[1][2]).toMatchObject({ chainId: first.chainId, attempt: 2 });
  });

  it.each(['unresolved-reference', 'missing-required', 'null-required'] as const)('repairs %s while the remaining controls stay usable', async code => {
    const degraded: GenUIVerification = { ...report(), render: 'passed', diagnostics: [{ source: 'parser', code, message: 'Missing content', statementId: 'detail' }] };
    expect(await requestGenUIAutoRepair(origin, { ...degraded, render: 'unverified' })).toBe(false);
    expect(await requestGenUIAutoRepair(origin, degraded)).toBe(true);
    expect(await requestGenUIAutoRepair(origin, degraded)).toBe(false);
  });

  it('does not reset the limit when a repair produces a different application id or another device renders it', async () => {
    await requestGenUIAutoRepair(origin, report());
    const chainId = fixture.repair.mock.calls[0][2].chainId;
    fixture.state.sessions.set('session', { dialogTurns: [{ id: 'turn', userMessage: {
      metadata: { genUIRepair: { chainId, attempt: 2 } },
    } }] });
    activateSurface('peer');
    expect(await requestGenUIAutoRepair({ ...origin, surfaceId: 'peer' }, { ...report('replacement'), appId: 'new-app' })).toBe(false);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
  });

  it('uses the same host queue slot on two controller surfaces', async () => {
    await requestGenUIAutoRepair(origin, report());
    const first = fixture.repair.mock.calls[0][2];
    activateSurface('peer');
    await requestGenUIAutoRepair({ ...origin, surfaceId: 'peer' }, report());
    expect(fixture.repair.mock.calls[1][2].turnId).toBe(first.turnId);
  });

  it('ignores nonfatal, inactive, and switched-surface reports', async () => {
    expect(await requestGenUIAutoRepair(origin, { ...report(), diagnostics: [{ source: 'query', code: 'tool-error', message: 'Offline' }] })).toBe(false);
    fixture.state.activeSessionId = 'another';
    expect(await requestGenUIAutoRepair(origin, report())).toBe(false);
    fixture.state.activeSessionId = 'session';
    activateSurface('peer');
    expect(await requestGenUIAutoRepair(origin, report())).toBe(false);
    expect(fixture.repair).not.toHaveBeenCalled();
  });

  it('does not silently resubmit after ambiguous transport failure or concurrent reports', async () => {
    fixture.repair.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(requestGenUIAutoRepair(origin, report())).rejects.toThrow('Disconnected');
    expect(await requestGenUIAutoRepair(origin, report())).toBe(false);
    expect(fixture.repair).toHaveBeenCalledTimes(1);
  });
});
