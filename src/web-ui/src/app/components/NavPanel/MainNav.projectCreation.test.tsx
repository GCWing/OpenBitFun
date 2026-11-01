// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSHContextValue } from '@/features/ssh-remote/SSHRemoteContext';
import { resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import type { WorkspaceSourceOption } from '@/features/ssh-remote/useWorkspaceSourceOptions';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { getDeviceInfo: async () => ({ device_id: 'local', device_name: 'Workstation' }) },
}));
const state = vi.hoisted(() => ({
  remote: {} as SSHContextValue,
  createProject: vi.fn(),
  pickDirectory: vi.fn(),
  options: {} as Record<string, WorkspaceSourceOption[]>,
  activeTabId: 'personal-overview',
}));
const t = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({ useI18n: () => ({ t }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: vi.fn() } }));
vi.mock('@/infrastructure/peer-device/pickWorkspaceDirectory', () => ({ pickWorkspaceDirectory: state.pickDirectory }));
vi.mock('@/infrastructure/api', () => ({ globalAPI: {}, workspaceAPI: {} }));
vi.mock('@/app/services/createProject', () => ({ createProject: state.createProject }));
vi.mock('@/features/ssh-remote/sshApi', () => ({
  sshApi: { listWslDistributions: async () => ({ supported: true, distributions: [] }) },
}));
vi.mock('@/features/ssh-remote/useWorkspaceSourceOptions', () => ({
  workspacePresetHost: (preset?: { kind: string; connection?: unknown }) => preset?.kind === 'saved' ? preset.connection : undefined,
  useWorkspaceSourceOptions: (source: string) => ({ options: state.options[source] || [], loading: false, error: '', refresh: vi.fn() }),
}));
vi.mock('@/app/hooks/useSceneManager', () => ({ useSceneManager: () => ({ openScene: vi.fn() }) }));
vi.mock('@/app/stores/sceneStore', () => ({
  useSceneStore: (select: (value: { activeTabId: string }) => unknown) => select(state),
}));
vi.mock('@/app/scenes/miniapps/hooks/useMiniAppCatalogSync', () => ({ useMiniAppCatalogSync: () => {} }));
vi.mock('@/app/scenes/profile/nurseryStore', () => ({ useNurseryStore: { getState: vi.fn() } }));
vi.mock('@/infrastructure/services/business/workspaceManager', () => ({ workspaceManager: { getState: vi.fn() } }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ currentWorkspace: null, loading: false, openedWorkspacesList: [] }),
}));
vi.mock('@/app/global-search/globalSearchStore', () => ({ openGlobalSearch: vi.fn() }));
vi.mock('@/app/global-search/productActionActivator', () => ({ activateProductAction: vi.fn() }));
vi.mock('@/app/global-search/globalSearchShortcut', () => ({
  getGlobalSearchShortcutLabel: () => 'Ctrl+K',
  splitGlobalSearchShortcutLabel: () => ({ modifier: 'Ctrl', key: 'K' }),
  subscribeGlobalSearchShortcut: () => () => {},
}));
vi.mock('./components/SectionHeader', () => ({ default: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div> }));
vi.mock('./components/StickySectionHeader', () => ({ default: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('./components/WorkspaceSessionGroupingToggle', () => ({ default: () => null }));
vi.mock('./components/WorkspaceSessionFilterMenu', () => ({ default: () => null }));
vi.mock('./sections/workspaces/WorkspaceListSection', () => ({ default: () => null }));
vi.mock('./components/MiniAppShortcuts', () => ({ default: () => <button data-testid="miniapp-shortcut">Notes</button> }));
vi.mock('@/features/ssh-remote', () => ({
  useSSHRemoteContext: () => state.remote,
  SSHConnectionDialog: ({ open, initialTargetType, fixedSource, confirmLabel, onClose, onConnected }: { open: boolean; initialTargetType: string; fixedSource: boolean; confirmLabel: string; onClose: () => void; onConnected: (config: unknown, id: string) => void }) => (
    open ? <div data-testid="connection-dialog" data-target={initialTargetType} data-fixed={fixedSource} data-confirm-label={confirmLabel}><button onClick={onClose}>cancel connection</button><button onClick={() => { onConnected({ id: 'selected-target', name: 'Host', host: 'example.test' }, 'selected-target'); onClose(); }}>finish connection</button></div> : null
  ),
  RemoteFileBrowser: ({ connectionId, onSelect, onCancel }: { connectionId: string; onSelect: (path: string) => void; onCancel: () => void }) => (
    <div data-testid="remote-browser" data-connection={connectionId}>
      <button onClick={() => onSelect('/srv/project')}>select remote folder</button>
      <button onClick={onCancel}>cancel remote folder</button>
    </div>
  ),
}));

import MainNav from './MainNav';
import { useWorkspaceSessionViewStore } from './workspaceSessionView';
import { useMiniAppNavigationStore } from '@/app/scenes/miniapps/miniAppNavigationStore';
import { sidebarPreferences } from '@/app/navigation/sidebarPreferences';

describe('project creation entry points', () => {
  let root: Root;
  let host: HTMLDivElement;
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === label)!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  };
  const render = async () => {
    await act(async () => root.render(<MainNav />));
  };
  const sourceOption = (dimension: number, value: string) => document.querySelectorAll('[role="radiogroup"]')[dimension]
    .querySelector<HTMLButtonElement>(`[data-openbitfun-value="${value}"]`)!;
  const setSource = (target: string, selectInstance = true) => {
    const remote = target !== 'wsl' && target !== 'localDocker';
    act(() => sourceOption(0, remote ? 'other' : 'current').click());
    if (remote && (selectInstance || target === 'remoteDocker')) {
      const host = document.querySelector<HTMLButtonElement>('[data-openbitfun-part="sourceField"] [data-workspace-choice] button[aria-pressed]');
      if (host?.getAttribute('aria-pressed') === 'false') act(() => host.click());
    }
    const environment = document.querySelectorAll('[role="radiogroup"]')[1];
    if (environment) act(() => environment.querySelector<HTMLButtonElement>(`[data-openbitfun-value="${target === 'wsl' ? 'wsl' : target === 'ssh' ? 'system' : 'container'}"]`)!.click());
    if (selectInstance && target !== 'ssh') {
      const option = document.querySelectorAll('[data-openbitfun-part="sourceField"]')[1]?.querySelector<HTMLButtonElement>('[data-workspace-choice] button[aria-pressed]');
      if (option?.getAttribute('aria-pressed') === 'false') act(() => option.click());
    }
  };
  const connect = async () => {
    state.remote = { ...state.remote, connectionId: 'selected-target', showFileBrowser: false };
    await click('finish connection');
    await render();
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    resetDeviceSurfaceForTest();
    useMiniAppNavigationStore.setState({ pinnedAppIdsBySurface: {} });
    state.activeTabId = 'personal-overview';
    sidebarPreferences.setState({ pinnedIds: ['builtin.todos'], storageIssue: null });
    state.createProject.mockResolvedValue(true);
    state.options = {};
    for (const source of ['ssh', 'wsl', 'localDocker', 'remoteDocker']) {
      state.options[source] = [{ id: `fixture-${source}`, label: source, preset: { kind: 'saved', connection: {
        id: `fixture-${source}`, name: 'Host', host: 'example.test', port: 22, username: 'dev', authType: { type: 'PrivateKey', keyPath: '/keys/dev' },
        ...(source === 'wsl' ? { wsl: { distribution: 'Ubuntu' } } : {}),
      } } }];
    }
    // An existing SSH connection must not satisfy a newly requested WSL/Docker source.
    state.remote = {
      isConnected: true, connectionId: 'old-ssh', connectionConfig: { name: 'Host', host: 'example.test' },
      showFileBrowser: false, setShowFileBrowser: vi.fn(value => { state.remote.showFileBrowser = value; }),
      disconnect: vi.fn(),
      connect: vi.fn().mockResolvedValue({ success: true, connectionId: 'selected-target' }),
    } as unknown as SSHContextValue;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await import('../NewProjectDialog');
    await render();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetDeviceSurfaceForTest();
  });

  it('places MiniApp shortcuts immediately after Task Board and gives the selected app its own highlight', async () => {
    state.activeTabId = 'miniapp:notes';
    await act(async () => { useMiniAppNavigationStore.getState().setPinned('local', 'notes', true); });
    await render();
    const topActions = host.querySelector('[data-openbitfun-part="topActions"]')!;
    expect([...topActions.querySelectorAll('button')].map(button => button.getAttribute('data-testid')))
      .toEqual(['nav-personal-overview', 'nav-todos-btn', 'miniapp-shortcut']);
    expect(host.querySelector('[data-testid="nav-personal-overview"]')!.getAttribute('data-openbitfun-state')).toBe('');
  });

  it('highlights a pinned Home child instead of Home, and falls back after unpinning', async () => {
    state.activeTabId = 'agents';
    act(() => sidebarPreferences.getState().setPinned('builtin.agents', true));
    await render();
    expect(host.querySelector('[data-testid="nav-personal-overview"]')!.getAttribute('data-openbitfun-state')).toBe('');
    expect(host.querySelector('[data-testid="nav-builtin.agents"]')!.getAttribute('data-openbitfun-state')).toBe('active');
    act(() => sidebarPreferences.getState().setPinned('builtin.agents', false));
    expect(host.querySelector('[data-testid="nav-personal-overview"]')!.getAttribute('data-openbitfun-state')).toBe('active');
  });

  it.each([true, false])('reveals project groups only after successful creation (success=%s)', async succeeded => {
    useWorkspaceSessionViewStore.getState().setGrouping('all');
    state.createProject.mockResolvedValueOnce(succeeded);
    state.pickDirectory.mockResolvedValueOnce('/srv/project');
    await act(async () => window.dispatchEvent(new Event('nav:new-project')));
    await click('actions.add');
    await click('newProject.create');
    expect(useWorkspaceSessionViewStore.getState().grouping).toBe(succeeded ? 'grouped' : 'all');
  });

  it.each(['sidebar', 'global'] as const)('%s opens the full source picker and adds a WSL folder', async entry => {
    if (entry === 'sidebar') {
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="nav-workspace-add-btn"]')!.click());
      await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="nav-session-group-add-project"]')!.click());
    } else {
      await act(async () => window.dispatchEvent(new Event('nav:new-project')));
      expect(document.querySelector('[data-testid="nav-session-group-add-project"]')).toBeNull();
    }
    expect(sourceOption(1, 'wsl')).not.toBeNull();
    expect(sourceOption(1, 'wsl').disabled).toBe(false);
    setSource('wsl');
    await click('actions.add');
    expect(document.querySelector('[data-testid="connection-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="remote-browser"]')?.getAttribute('data-connection')).toBe('selected-target');
    await click('select remote folder');
    await click(entry === 'sidebar' ? 'newWorkspace.createProject' : 'newProject.create');
    expect(state.createProject).toHaveBeenCalledWith({ name: '', folders: [{
      path: '/srv/project', remote: { connectionId: 'selected-target', connectionName: 'Host', sshHost: 'example.test' },
    }] }, expect.any(Function));
    expect(state.pickDirectory).not.toHaveBeenCalled();
  });

  it.each(['ssh', 'wsl', 'localDocker', 'remoteDocker'])(
    'creates an empty %s project on the newly selected target', async target => {
      await act(async () => window.dispatchEvent(new Event('nav:new-project')));
      setSource(target);
      act(() => {
        const input = document.querySelector('input')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'example');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await click('newProject.create');
      expect(document.querySelector('[data-testid="connection-dialog"]')).toBeNull();
      expect(state.createProject).toHaveBeenCalledWith({ name: 'example', folders: [], remote: {
        connectionId: 'selected-target', connectionName: 'Host', sshHost: 'example.test',
      } }, expect.any(Function));
      expect(document.querySelector('[data-testid="remote-browser"]')).toBeNull();
      expect(state.pickDirectory).not.toHaveBeenCalled();
    },
  );

  it('opens new configuration from the header and preserves the chosen source when it is cancelled', async () => {
    await act(async () => window.dispatchEvent(new Event('nav:new-project')));
    expect(sourceOption(1, 'wsl').disabled).toBe(false);
    setSource('wsl');
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="ssh.remote.newConnection"]')!.click());
    expect(document.querySelector('[data-testid="connection-dialog"]')?.getAttribute('data-target')).toBe('wsl');
    await click('cancel connection');
    expect(sourceOption(1, 'wsl').getAttribute('aria-checked')).toBe('true');
    expect(state.createProject).not.toHaveBeenCalled();
    expect(state.pickDirectory).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="ssh.remote.newConnection"]')!.click());
    await connect();
    expect(document.querySelector('[data-testid="remote-browser"]')).toBeNull();
  });

  it.each(['ssh', 'wsl', 'localDocker'])('opens the directory picker directly for a selected %s instance', async target => {
    const profile = { id: 'selected', name: 'Selected', host: 'host.test', port: 22, username: 'dev', authType: { type: 'PrivateKey' as const, keyPath: '/keys/dev' },
      ...(target === 'wsl' ? { wsl: { distribution: 'Ubuntu' } } : {}),
      ...(target === 'localDocker' ? { container: { name: 'dev', local: true, access: 'auto' as const, dockerPath: 'docker', shell: '/bin/sh', interactive: true } } : {}) };
    state.options[target] = [{ id: 'selected', label: 'Selected', preset: { kind: 'saved', connection: profile } }];
    await act(async () => window.dispatchEvent(new Event('nav:new-project')));
    setSource(target, false);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-workspace-choice="selected"] button[aria-pressed]')!.click());
    expect(state.remote.connect).not.toHaveBeenCalled();
    await click('actions.add');
    expect(state.remote.connect).toHaveBeenCalledWith('selected', expect.objectContaining({ id: 'selected' }), { browseAfterConnect: false });
    expect(document.querySelector('[data-testid="connection-dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="remote-browser"]')?.getAttribute('data-connection')).toBe('selected-target');
    await click('select remote folder');
    await click('actions.add');
    expect(state.remote.connect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="remote-browser"]')?.getAttribute('data-connection')).toBe('selected-target');
    expect(state.pickDirectory).not.toHaveBeenCalled();
  });
});
