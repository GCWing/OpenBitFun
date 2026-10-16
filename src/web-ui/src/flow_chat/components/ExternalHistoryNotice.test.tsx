// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import type { Session } from '../types/flow-chat';
import { ExternalHistoryNotice } from './ExternalHistoryNotice';

const api = vi.hoisted(() => ({ restore: vi.fn(), metadata: vi.fn(), load: vi.fn(), ensure: vi.fn(), open: vi.fn(), listRemoved: vi.fn(), restoreRemoved: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ExternalSessionImportAPI', () => ({ externalSessionImportAPI: api }));
vi.mock('@/infrastructure/api', () => ({ agentAPI: { restoreSessionView: api.restore }, sessionAPI: { loadSessionMetadata: api.metadata } }));
vi.mock('../store/FlowChatStore', () => ({ flowChatStore: { loadSessionHistory: api.load, ensurePersistedSessionMetadata: api.ensure } }));
vi.mock('../services/sessionActivation', () => ({ openMainSession: api.open }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled: boolean }) =>
    <button disabled={disabled} onClick={onClick}>{children}</button>,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = () => ({
  sessionId: 'source', workspaceId: 'workspace', config: {}, historyState: 'ready',
  importedSource: 'codex', externalHistory: { mode: 'follow', contentVersion: 'viewed' }, dialogTurns: [],
} as unknown as Session);
const branch = () => ({ ...source(), sessionId: 'branch', externalHistory: undefined,
  externalBranchOf: { sessionId: 'source', ecosystemId: 'codex', sourceSessionId: 'original', contentVersion: 'viewed' } });

describe('ExternalHistoryNotice', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    activateSurface(LOCAL_SURFACE_ID);
    api.ensure.mockResolvedValue(true);
    api.listRemoved.mockResolvedValue([]);
    api.restoreRemoved.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    activateSurface(LOCAL_SURFACE_ID);
  });
  const render = async (session: Session = source(), active = true) => {
    await act(async () => { root.render(<ExternalHistoryNotice session={session} active={active} />); });
  };

  it.each(['source', 'branch'])('never refreshes the %s on render, visibility changes, activation or elapsed time', async kind => {
    const session = kind === 'source' ? source() : branch();
    await render(session);
    await render(session, false);
    await render(session, true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(api.restore).not.toHaveBeenCalled();
    expect(api.metadata).not.toHaveBeenCalled();
    expect(api.load).not.toHaveBeenCalled();
    expect(api.ensure).not.toHaveBeenCalled();
    if (kind === 'source') expect(container.querySelector('button')).toBeNull();
  });

  it('opens a branch source only when explicitly requested', async () => {
    await render(branch());
    expect(container.textContent).toContain('externalHistory.branchHint');
    await act(async () => { container.querySelector('button')!.click(); });
    expect(api.open).toHaveBeenCalledExactlyOnceWith('source', { workspaceId: 'workspace' });
    expect(api.restore).not.toHaveBeenCalled();
  });

  it.each(['device', 'inactive', 'different-session'])('discards a source open after %s changes', async change => {
    let resolve!: (found: boolean) => void;
    api.ensure.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
    await render(branch());
    await act(async () => { container.querySelector('button')!.click(); });
    if (change === 'device') await act(async () => { activateSurface('peer-source-test'); });
    if (change === 'inactive') await render(branch(), false);
    if (change === 'different-session') await render({ ...branch(), sessionId: 'another' });
    await act(async () => { resolve(true); });
    expect(api.open).not.toHaveBeenCalled();
  });

  it('explicitly gates source following on a peer without reading either host', async () => {
    activateSurface('peer-source-test');
    await render(branch());
    expect(container.textContent).toContain('externalHistory.unsupportedSurface');
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(api.ensure).not.toHaveBeenCalled();
  });

  it('allows retry after reactivation and ignores the previous activation response', async () => {
    let resolve!: (found: boolean) => void;
    api.ensure.mockReturnValueOnce(new Promise<boolean>(done => { resolve = done; }));
    await render(branch());
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('button')!.disabled).toBe(true);
    await render(branch(), false);
    await render(branch());
    expect(container.querySelector('button')!.disabled).toBe(false);
    await act(async () => container.querySelector('button')!.click());
    expect(api.open).toHaveBeenCalledTimes(1);
    await act(async () => resolve(true));
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')!.disabled).toBe(false);
  });

  it('shows unavailable cached history without retrying the source', async () => {
    const session = source();
    session.externalHistory!.sourceStatus = 'unavailable';
    await render(session);
    expect(container.textContent).toContain('externalHistory.unavailable');
    expect(api.restore).not.toHaveBeenCalled();
  });

  it('explains a removed source and restores it only after an explicit second click', async () => {
    api.ensure.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    api.listRemoved.mockResolvedValue([{ ecosystemId: 'codex', sessionId: 'source', workspaceId: 'workspace' }]);
    await render(branch());
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('externalHistory.removed');
    expect(container.querySelector('button')!.textContent).toBe('externalHistory.restoreSource');
    expect(api.restoreRemoved).not.toHaveBeenCalled();
    expect(api.open).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(api.restoreRemoved).toHaveBeenCalledExactlyOnceWith('source', 'workspace', 'codex');
    expect(api.open).toHaveBeenCalledExactlyOnceWith('source', { workspaceId: 'workspace' });
    expect(api.restore).not.toHaveBeenCalled();
  });

  it('reports a missing source without presenting the branch as a cached source view', async () => {
    api.ensure.mockResolvedValue(false);
    await render(branch());
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('externalHistory.sourceMissing');
    expect(container.textContent).not.toContain('externalHistory.unavailable');
    expect(api.open).not.toHaveBeenCalled();
  });

  it('keeps an explicit restore available after a failure', async () => {
    api.ensure.mockResolvedValue(false);
    api.listRemoved.mockResolvedValue([{ ecosystemId: 'codex', sessionId: 'source', workspaceId: 'workspace' }]);
    api.restoreRemoved.mockRejectedValueOnce(new Error('Read only filesystem'));
    await render(branch());
    await act(async () => container.querySelector('button')!.click());
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('externalHistory.restoreFailed');
    expect(container.querySelector('button')!.disabled).toBe(false);
    expect(api.open).not.toHaveBeenCalled();
  });
});
