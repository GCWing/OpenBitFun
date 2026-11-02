// @vitest-environment jsdom
import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, LOCAL_SURFACE_ID } from '@/infrastructure/peer-device/deviceSurface';
import { RemovedExternalSessions } from './RemovedExternalSessions';

const api = vi.hoisted(() => ({ listRemoved: vi.fn(), restoreRemoved: vi.fn(), refreshWorkspaceSessions: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ExternalSessionImportAPI', () => ({ externalSessionImportAPI: api }));
vi.mock('@/flow_chat/services/FlowChatManager', () => ({ flowChatManager: api }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, loading: _loading, variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: string; size?: string }) => <button {...props}>{children}</button>,
  Alert: ({ message }: { message: ReactNode }) => <div role="alert">{message}</div>,
  LoadingState: () => <div role="status">Loading</div>,
  OverflowText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const removed = { ecosystemId: 'codex', sessionId: 'source', sessionName: 'Removed source', workspaceId: 'owner', workspaceName: 'Original workspace' };
const busy = vi.fn();

describe('removed external source sessions', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.resetAllMocks();
    activateSurface(LOCAL_SURFACE_ID);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    api.listRemoved.mockResolvedValue([removed]);
    api.restoreRemoved.mockResolvedValue(undefined);
    api.refreshWorkspaceSessions.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    activateSurface(LOCAL_SURFACE_ID);
    vi.unstubAllGlobals();
  });
  const render = async (ecosystemId: 'codex' | 'zcode' = 'codex') => {
    await act(async () => root.render(<RemovedExternalSessions ecosystemId={ecosystemId} refreshVersion={0} onBusyChange={busy} />));
  };
  const restore = async () => { await act(async () => container.querySelector('button')!.click()); };

  it('restores only the chosen source in its owning workspace and refreshes its session list', async () => {
    await render();
    expect(api.listRemoved).toHaveBeenCalledExactlyOnceWith('codex');
    expect(container.textContent).toContain('Original workspace');
    expect(api.restoreRemoved).not.toHaveBeenCalled();
    await restore();
    expect(api.restoreRemoved).toHaveBeenCalledExactlyOnceWith('source', 'owner', 'codex');
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledExactlyOnceWith({ id: 'owner' });
    expect(container.textContent).not.toContain('Removed source');
    expect(container.textContent).toContain('sessions.removed.empty');
  });

  it('keeps a failed restore visible and permits retry', async () => {
    api.restoreRemoved.mockRejectedValueOnce(new Error('Disk is read only'));
    await render();
    await restore();
    expect(container.textContent).toContain('Removed source');
    expect(container.textContent).toContain('sessions.removed.restoreFailed');
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
    await restore();
    expect(container.textContent).toContain('sessions.removed.empty');
  });

  it('reports a successful restore separately from a failed navigation refresh', async () => {
    api.refreshWorkspaceSessions.mockRejectedValue(new Error('Offline'));
    await render();
    await restore();
    expect(container.textContent).toContain('sessions.removed.refreshFailed');
    expect(container.textContent).not.toContain('Removed source');
  });

  it('shows an explicit older-host limitation instead of an empty success', async () => {
    api.listRemoved.mockRejectedValue({ code: 'incompatible_version' });
    await render();
    expect(container.textContent).toContain('sessions.removed.unsupportedHost');
    expect(container.textContent).not.toContain('sessions.removed.empty');
  });

  it('does not read either host in Peer mode', async () => {
    activateSurface('peer-removed-test');
    await render();
    expect(api.listRemoved).not.toHaveBeenCalled();
    expect(container.textContent).toContain('sessions.removed.unsupportedSurface');
    expect(container.querySelector('button')).toBeNull();
  });

  it('discards an old source list after the selected ecosystem changes', async () => {
    let resolve!: (entries: unknown[]) => void;
    api.listRemoved.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce([]);
    await render();
    await render('zcode');
    await act(async () => resolve([removed]));
    expect(container.textContent).not.toContain('Removed source');
    expect(container.textContent).toContain('sessions.removed.empty');
  });

  it('does not refresh another device when a restore finishes after a surface switch', async () => {
    let resolve!: () => void;
    api.restoreRemoved.mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
    await render();
    await restore();
    await act(async () => activateSurface('peer-removed-test'));
    await act(async () => resolve());
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
    expect(container.textContent).toContain('sessions.removed.unsupportedSurface');
    expect(container.textContent).not.toContain('Removed source');
  });
});
