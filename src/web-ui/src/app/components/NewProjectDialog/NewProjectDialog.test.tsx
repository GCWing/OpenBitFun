// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from './NewProjectDialog';
import { activateSurface, resetDeviceSurfaceForTest, surfaceIdForDevice } from '@/infrastructure/peer-device/deviceSurface';
import { AssistantProjectFolderError, ProjectDirectoryUnavailableError } from '@/app/utils/projectDraft';
import { globalAPI, type WorkspaceInfo } from '@/infrastructure/api/service-api/GlobalAPI';
import type { WorkspaceSourceOption } from '@/features/ssh-remote/useWorkspaceSourceOptions';
import { PeerDeviceContext, type PeerDeviceContextValue } from '@/infrastructure/peer-device/peerDeviceContextState';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { getDeviceInfo: async () => ({ device_id: 'local', device_name: 'Workstation', device_os: 'macOS' }) },
}));
const wslSupport = vi.hoisted(() => ({ supported: true }));
vi.mock('@/features/ssh-remote/sshApi', () => ({ sshApi: { listWslDistributions: async () => ({ supported: wslSupport.supported, distributions: [] }) } }));
const { pickDirectory, sourceOptions, optionsBySource } = vi.hoisted(() => ({ pickDirectory: vi.fn(), sourceOptions: [] as WorkspaceSourceOption[], optionsBySource: {} as Record<string, WorkspaceSourceOption[]> }));
vi.mock('@/features/ssh-remote/useWorkspaceSourceOptions', () => ({
  useWorkspaceSourceOptions: (source: string) => ({ options: optionsBySource[source] || [], loading: false, error: '', refresh: vi.fn() }),
  workspacePresetHost: (preset?: { kind: string; connection?: unknown }) => preset?.kind === 'saved' ? preset.connection : undefined,
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string, options?: { name?: string }) =>
  key === 'workspaceSource.namedHost' ? `${key} · ${options?.name}` : key }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/infrastructure/peer-device/pickWorkspaceDirectory', () => ({ pickWorkspaceDirectory: pickDirectory }));

describe('NewProjectDialog composition', () => {
  let root: Root;
  let host: HTMLDivElement;
  const close = vi.fn();
  const confirm = vi.fn();
  const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label)!;
  const choice = (kind: 'assistant' | 'project') => document.querySelector<HTMLButtonElement>(`[data-testid="nav-session-group-add-${kind}"]`)!;
  const nameInput = () => document.querySelector<HTMLInputElement>('input')!;
  const enterName = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput(), value);
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  const choose = async (kind: 'assistant' | 'project') => { await act(async () => { choice(kind).click(); }); };
  const add = async (path: string) => { pickDirectory.mockResolvedValueOnce(path); await click('actions.add'); };
  const sourceOption = (dimension: number, value: string) => document.querySelectorAll('[role="radiogroup"]')[dimension]
    .querySelector<HTMLButtonElement>(`[data-openbitfun-value="${value}"]`)!;
  const selectSource = (target: string, selectInstance = true) => {
    const remote = target !== 'wsl' && target !== 'localDocker' && target !== 'host';
    act(() => sourceOption(0, remote ? 'other' : 'current').click());
    if (remote && (selectInstance || target === 'remoteDocker')) {
      const host = document.querySelector<HTMLButtonElement>('[data-openbitfun-part="sourceField"] [data-workspace-choice] button[aria-pressed]');
      if (host?.getAttribute('aria-pressed') === 'false') act(() => host.click());
    }
    const environment = document.querySelectorAll('[role="radiogroup"]')[1];
    if (environment) act(() => environment.querySelector<HTMLButtonElement>(`[data-openbitfun-value="${target === 'wsl' ? 'wsl' : target === 'host' || target === 'ssh' ? 'system' : 'container'}"]`)!.click());
    if (selectInstance && target !== 'host' && target !== 'ssh') {
      const option = document.querySelectorAll('[data-openbitfun-part="sourceField"]')[1]?.querySelector<HTMLButtonElement>('[data-workspace-choice] button[aria-pressed]');
      if (option?.getAttribute('aria-pressed') === 'false') act(() => option.click());
    }
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(globalAPI, 'getRecentWorkspaces').mockResolvedValue([]);
    wslSupport.supported = true;
    sourceOptions.length = 0;
    for (const key of Object.keys(optionsBySource)) delete optionsBySource[key];
    for (const source of ['ssh', 'wsl', 'localDocker', 'remoteDocker']) {
      optionsBySource[source] = [{ id: `fixture-${source}`, label: source, preset: { kind: 'saved', connection: {
        id: `fixture-${source}`, name: source, host: 'host.test', port: 22, username: 'dev', authType: { type: 'PrivateKey', keyPath: '/keys/dev' },
      } } }];
    }
    confirm.mockResolvedValue(true);
    resetDeviceSurfaceForTest();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); resetDeviceSurfaceForTest(); });
  const render = async (extra = {}) => {
    await act(async () => root.render(<NewProjectDialog isOpen defaultParentPath="/srv" onClose={close} onConfirm={confirm} {...extra} />));
  };

  it('disables WSL before selection when the active host does not support it', async () => {
    wslSupport.supported = false;
    const onSelectRemoteHost = vi.fn();
    await render({ onPickRemoteFolder: vi.fn(), onSelectRemoteHost });
    expect(sourceOption(1, 'wsl').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('ssh.remote.wslUnsupported');
    act(() => sourceOption(1, 'wsl').click());
    expect(sourceOption(1, 'system').getAttribute('aria-checked')).toBe('true');
    expect(onSelectRemoteHost).not.toHaveBeenCalled();
  });

  it('uses the single source folder name when the name is left empty', async () => {
    await render();
    expect(button('newProject.create').disabled).toBe(true);
    await add('/srv/frontend');
    expect(nameInput().value).toBe('');
    expect(nameInput().placeholder).toBe('frontend');
    expect(pickDirectory).toHaveBeenCalledWith({ title: 'newProject.selectSourceFolder', defaultPath: '/srv' });
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: '', folders: [{ path: '/srv/frontend' }] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('adds multiple folders, ignores duplicates, and requires a unified name', async () => {
    await render();
    await add('/srv/frontend');
    await add('/srv/backend');
    await add('/srv/backend/');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(button('newProject.create').disabled).toBe(true);
    enterName(' Product ');
    expect(document.querySelector('.new-project-dialog__save-location')).toBeNull();
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: 'Product', folders: [{ path: '/srv/frontend' }, { path: '/srv/backend' }] });
  });

  it('removes a source and derives the remaining folder name', async () => {
    await render();
    await add('/srv/frontend');
    await add('/srv/backend');
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="newProject.removeFolder"]')!.click());
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(nameInput().placeholder).toBe('backend');
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: '', folders: [{ path: '/srv/backend' }] });
  });

  it('submits an empty project directly without choosing a save location', async () => {
    await render();
    expect(document.querySelector('.new-project-dialog__save-location')).toBeNull();
    enterName('example');
    expect(document.querySelector('.new-project-dialog__save-location')?.textContent).toBe('newProject.emptyProjectHint ~/OpenBitFun/Projects/example');
    await click('newProject.create');
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith({ name: 'example', folders: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('locks actions during submission and preserves the draft after failure', async () => {
    let reject!: (error: Error) => void;
    confirm.mockReturnValue(new Promise<boolean>((_, fail) => { reject = fail; }));
    await render();
    await add('/srv/frontend');
    await add('/srv/backend');
    enterName('Product');
    await click('newProject.create');
    expect(button('newProject.cancel').disabled).toBe(true);
    expect(button('actions.add').disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);
    await act(async () => { reject(new Error('Host offline')); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host offline');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(nameInput().value).toBe('Product');
    expect(button('newProject.create').disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['ssh', 'wsl', 'localDocker', 'remoteDocker'])(
    'keeps %s additions on the same connection without opening local pickers', async target => {
      const remote = { connectionId: 'ssh-1', connectionName: 'Host' };
      const pickRemote = vi.fn().mockResolvedValueOnce({ path: '/srv/a', remote }).mockResolvedValueOnce({ path: '/srv/b', remote });
      await render({ onPickRemoteFolder: pickRemote });
      expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(2);
      selectSource(target);
      await click('actions.add');
      await click('actions.add');
      expect(pickRemote).toHaveBeenNthCalledWith(1, target, undefined, expect.anything());
      expect(pickRemote).toHaveBeenLastCalledWith(target, { path: '/srv/a', remote });
      expect(pickDirectory).not.toHaveBeenCalled();
      expect([...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].every(option => option.disabled)).toBe(true);
      enterName('Remote product');
      await click('newProject.create');
      expect(confirm).toHaveBeenCalledWith({ name: 'Remote product', folders: [{ path: '/srv/a', remote }, { path: '/srv/b', remote }] });
    },
  );

  it.each(['ssh', 'wsl', 'localDocker', 'remoteDocker'] as const)('passes the selected %s capsule to the folder picker without asking for it again', async target => {
    const preset = { kind: 'saved' as const, connection: {
      id: 'selected', name: 'Selected environment', host: 'host', port: 22, username: 'dev', authType: { type: 'PrivateKey' as const, keyPath: '' },
    } };
    sourceOptions.push({ id: 'selected', label: 'Selected environment', preset });
    optionsBySource[target] = sourceOptions;
    const pickRemote = vi.fn().mockResolvedValue(null);
    await render({ onPickRemoteFolder: pickRemote });
    selectSource(target, false);
    const dimension = document.querySelectorAll('[data-openbitfun-part="sourceField"]')[target === 'ssh' ? 0 : 1];
    expect(dimension.querySelector('[data-openbitfun-component="capsule"]')).not.toBeNull();
    await act(async () => dimension.querySelector<HTMLButtonElement>('[data-workspace-choice="selected"] button[aria-pressed]')!.click());
    expect(dimension.querySelector('[aria-pressed="true"]')?.textContent).toBe('Selected environment');
    await click('actions.add');
    expect(pickRemote).toHaveBeenCalledWith(target, undefined, preset);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('keeps the remote host choices visible when container is selected before changing location', async () => {
    optionsBySource.ssh = [{ id: 'host', label: 'Build host', preset: { kind: 'sshConfig', entry: { host: 'build', hostname: 'build.test', user: 'dev' } } }];
    await render({ onPickRemoteFolder: vi.fn(), onSelectRemoteHost: vi.fn().mockResolvedValue(null) });
    act(() => sourceOption(1, 'container').click());
    act(() => sourceOption(0, 'other').click());
    const row = document.querySelectorAll('[data-openbitfun-part="sourceField"]')[0];
    const hostButton = row.querySelector<HTMLButtonElement>('[data-workspace-choice="host"] button[aria-pressed]')!;
    expect(hostButton).not.toBeNull();
    expect(hostButton.getAttribute('aria-pressed')).toBe('false');
    expect(hostButton.getAttribute('data-openbitfun-variant')).toBe('outline');
    expect(hostButton.querySelector('[data-openbitfun-part="leading-icon"]')).toBeNull();
    await act(async () => hostButton.click());
    expect(hostButton.getAttribute('data-openbitfun-variant')).toBe('fill');
    expect(sourceOption(1, 'container').getAttribute('aria-checked')).toBe('true');
    const header = row.querySelector('.workspace-source-selector__heading')!;
    expect(header.querySelector('button[aria-label="ssh.remote.newConnection"]')).not.toBeNull();
    expect(header.querySelector('button[aria-label="workspaceSource.refreshOptions"]')).not.toBeNull();
  });

  it('opens an editor from the capsule action without selecting or connecting the option', async () => {
    const option: WorkspaceSourceOption = { id: 'host', label: 'Build host', preset: { kind: 'sshConfig', entry: { host: 'build' } } };
    optionsBySource.ssh = [option];
    const selectHost = vi.fn().mockResolvedValue(null);
    const pick = vi.fn();
    await render({ onPickRemoteFolder: pick, onSelectRemoteHost: selectHost });
    selectSource('ssh', false);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="actions.edit · Build host"]')!.click());
    expect(selectHost).toHaveBeenCalledWith('ssh', { ...option.preset, edit: true });
    expect(document.querySelector('[data-workspace-choice="host"] button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false');
    expect(pick).not.toHaveBeenCalled();
  });

  const recentWorkspace = (id: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
    id, name: id, rootPath: `/work/${id}`, workspaceKind: 'normal', workspaceType: 'singleProject',
    languages: [], tags: [], openedAt: '2026-01-01', lastAccessed: '2026-01-01', ...extra,
  });

  it('shows five newest unique host workspaces as capsules and adds the chosen folder without browsing', async () => {
    vi.mocked(globalAPI.getRecentWorkspaces).mockResolvedValue([
      recentWorkspace('old'),
      ...Array.from({ length: 6 }, (_, index) => recentWorkspace(`project-${index}`, { lastAccessed: `2026-02-0${index + 1}` })),
      recentWorkspace('duplicate', { rootPath: '/work/project-5/', lastAccessed: '2026-01-01' }),
      recentWorkspace('assistant', { workspaceKind: 'assistant' }),
      recentWorkspace('remote', { workspaceKind: 'remote' }),
      recentWorkspace('container', { connectionId: 'docker' }),
      recentWorkspace('ssh', { sshHost: 'build.test' }),
    ]);
    await render({ onPickRemoteFolder: vi.fn() });
    const row = document.querySelector('[data-openbitfun-part="sourceField"]')!;
    expect([...row.querySelectorAll('[data-workspace-choice]')].map(item => item.getAttribute('data-workspace-choice')))
      .toEqual(['project-5', 'project-4', 'project-3', 'project-2', 'project-1']);
    expect(row.querySelector('.workspace-source-selector__device')).toBeNull();
    await click('project-5');
    expect(pickDirectory).not.toHaveBeenCalled();
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: '', folders: [{ path: '/work/project-5' }] });
  });

  it('ignores recent workspaces returned after switching devices', async () => {
    let resolve!: (workspaces: WorkspaceInfo[]) => void;
    vi.mocked(globalAPI.getRecentWorkspaces).mockReturnValue(new Promise(done => { resolve = done; }));
    await render({ onPickRemoteFolder: vi.fn() });
    activateSurface(surfaceIdForDevice('peer'));
    await act(async () => resolve([recentWorkspace('controller-private')]));
    expect(document.querySelector('[data-workspace-choice="controller-private"]')).toBeNull();
  });

  it('does not repeat the device name below the current-computer header', async () => {
    await render({ onPickRemoteFolder: vi.fn() });
    const row = document.querySelectorAll('[data-openbitfun-part="sourceField"]')[0];
    expect(row.querySelector('.workspace-source-selector__device')).toBeNull();
    expect(row.querySelector('.workspace-source-selector__heading')?.textContent).not.toContain('Workstation');
    expect(document.body.textContent).not.toContain('workspaceSource.currentHostHint');
    expect(document.body.textContent).not.toContain('newProject.sourceFoldersHint');
  });

  it('deselects a capsule on its second click and clears a dependent container and ready connection', async () => {
    const hostPreset = { kind: 'saved' as const, connection: { id: 'host', name: 'Build host', host: 'host.test', port: 22, username: 'dev', authType: { type: 'PrivateKey' as const, keyPath: '/keys/dev' } } };
    const containerPreset = { kind: 'saved' as const, connection: { ...hostPreset.connection, id: 'container', name: 'devbox' } };
    optionsBySource.ssh = [{ id: 'host', label: 'Build host', preset: hostPreset }];
    optionsBySource.remoteDocker = [{ id: 'container', label: 'devbox', preset: containerPreset }];
    const pick = vi.fn().mockResolvedValue(null);
    await render({ onPickRemoteFolder: pick, onSelectRemoteHost: vi.fn().mockResolvedValue(null) });
    act(() => sourceOption(1, 'container').click());
    act(() => sourceOption(0, 'other').click());
    const capsule = (id: string) => document.querySelector<HTMLButtonElement>(`[data-workspace-choice="${id}"] button[aria-pressed]`)!;
    await act(async () => capsule('host').click());
    await act(async () => capsule('container').click());
    expect(capsule('container').getAttribute('aria-pressed')).toBe('true');
    await act(async () => capsule('container').click());
    expect(capsule('container').getAttribute('aria-pressed')).toBe('false');
    await act(async () => capsule('container').click());
    await act(async () => capsule('host').click());
    expect(capsule('host').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('[data-workspace-choice="container"]')).toBeNull();
    expect(button('actions.add').disabled).toBe(true);
    expect(capsule('host').querySelector('[data-openbitfun-part="leading-icon"]')).toBeNull();
    expect(pick).not.toHaveBeenCalled();
  });

  it('requires a selected host for the new remote-container action and forwards that host to its dialog', async () => {
    const connection = { id: 'host', name: 'Build host', host: 'host.test', port: 22, username: 'dev', authType: { type: 'PrivateKey' as const, keyPath: '/keys/dev' } };
    optionsBySource.ssh = [{ id: 'host', label: 'Build host', preset: { kind: 'saved', connection } }];
    const configure = vi.fn().mockResolvedValue(null);
    await render({ onPickRemoteFolder: vi.fn(), onSelectRemoteHost: configure });
    act(() => sourceOption(1, 'container').click());
    act(() => sourceOption(0, 'other').click());
    expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-workspace-choice="host"] button[aria-pressed]')!.click());
    const newContainer = document.querySelectorAll('[data-openbitfun-part="sourceField"]')[1].querySelector<HTMLButtonElement>('button[aria-label="ssh.remote.newConnection"]')!;
    expect(newContainer.disabled).toBe(false);
    await act(async () => newContainer.click());
    expect(configure).toHaveBeenCalledWith('remoteDocker', { kind: 'new', host: connection });
  });

  it('opens new configuration from the header icon and reuses its connection when adding a folder', async () => {
    const remote = { connectionId: 'new-wsl', connectionName: 'Ubuntu' };
    const selectHost = vi.fn().mockResolvedValue(remote);
    const pick = vi.fn().mockResolvedValue(null);
    await render({ onPickRemoteFolder: pick, onSelectRemoteHost: selectHost });
    selectSource('wsl');
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="ssh.remote.newConnection"]')!.click());
    expect(selectHost).toHaveBeenCalledWith('wsl', { kind: 'new' });
    await click('actions.add');
    expect(pick).toHaveBeenCalledWith('wsl', { path: '', remote });
  });

  it('surfaces selection failures and rejects stale device drafts', async () => {
    await render();
    pickDirectory.mockRejectedValueOnce(new Error('Host unavailable'));
    await click('actions.add');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host unavailable');
    await add('/srv/frontend');
    activateSurface(surfaceIdForDevice('another-host'));
    await click('newProject.create');
    expect(confirm).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each(['ssh', 'wsl', 'localDocker', 'remoteDocker'])(
    'selects the %s target for an empty project and preserves a cancelled draft', async target => {
      const remote = { connectionId: 'ssh-1', connectionName: 'Host' };
      const pickRemote = vi.fn();
      const selectHost = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(remote);
      await render({ onPickRemoteFolder: pickRemote, onSelectRemoteHost: selectHost });
      selectSource(target);
      enterName('example');
      await click('newProject.create');
      expect(selectHost).toHaveBeenCalledWith(target, expect.anything());
      expect(confirm).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(nameInput().value).toBe('example');
      await click('newProject.create');
      expect(confirm).toHaveBeenCalledWith({ name: 'example', folders: [], remote });
      expect(pickDirectory).not.toHaveBeenCalled();
      expect(pickRemote).not.toHaveBeenCalled();
    },
  );

  it('keeps an unsupported WSL target explicit without falling back to host folders', async () => {
    const pickRemote = vi.fn().mockRejectedValue(new Error('wsl_workspaces_v1_unsupported'));
    await render({ onPickRemoteFolder: pickRemote });
    selectSource('wsl');
    await click('actions.add');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('wsl_workspaces_v1_unsupported');
    expect(sourceOption(1, 'wsl').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelectorAll('li')).toHaveLength(0);
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('hides environments until a remote host is selected and disables source folders until an instance is selected', async () => {
    await render({ onPickRemoteFolder: vi.fn(), onSelectRemoteHost: vi.fn() });
    act(() => sourceOption(1, 'container').click());
    expect(button('actions.add').disabled).toBe(true);
    expect(document.querySelector('[data-openbitfun-part="pathSelector"]')?.getAttribute('aria-disabled')).toBe('true');
    act(() => sourceOption(0, 'other').click());
    expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
    expect(button('actions.add').disabled).toBe(true);
    act(() => document.querySelector<HTMLButtonElement>('[data-workspace-choice="fixture-ssh"] button[aria-pressed]')!.click());
    expect(sourceOption(1, 'container').getAttribute('aria-checked')).toBe('true');
    expect(sourceOption(1, 'wsl').disabled).toBe(true);
    expect(button('actions.add').disabled).toBe(true);
    act(() => document.querySelector<HTMLButtonElement>('[data-workspace-choice="fixture-remoteDocker"] button[aria-pressed]')!.click());
    expect(button('actions.add').disabled).toBe(false);
    act(() => document.querySelector<HTMLButtonElement>('[data-workspace-choice="fixture-remoteDocker"] button[aria-pressed]')!.click());
    expect(button('actions.add').disabled).toBe(true);
    act(() => document.querySelector<HTMLButtonElement>('[data-workspace-choice="fixture-ssh"] button[aria-pressed]')!.click());
    expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
    expect(button('actions.add').disabled).toBe(true);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('unlocks both dimensions after removing the last selected folder', async () => {
    const pickRemote = vi.fn().mockResolvedValue({ path: '/work', remote: { connectionId: 'container', connectionName: 'Dev' } });
    await render({ onPickRemoteFolder: pickRemote });
    selectSource('remoteDocker');
    await click('actions.add');
    expect(sourceOption(0, 'other').disabled).toBe(true);
    expect(sourceOption(1, 'container').disabled).toBe(true);
    expect(document.body.textContent).toContain('workspaceSource.foldersLockedHint');
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="newProject.removeFolder"]')!.click());
    expect(sourceOption(0, 'other').disabled).toBe(false);
    expect(sourceOption(1, 'container').disabled).toBe(false);
    expect(sourceOption(1, 'container').getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).not.toContain('workspaceSource.foldersLockedHint');
  });

  it('names the executing peer host without changing folder routing to the controller', async () => {
    const peer = { peerMode: { active: true, deviceId: 'peer', deviceName: 'Build Station' } } as PeerDeviceContextValue;
    activateSurface(surfaceIdForDevice('peer'));
    await act(async () => root.render(
      <PeerDeviceContext.Provider value={peer}>
        <NewProjectDialog isOpen onClose={close} onConfirm={confirm} onPickRemoteFolder={vi.fn()} />
      </PeerDeviceContext.Provider>,
    ));
    expect(sourceOption(0, 'current').textContent).toBe('workspaceSource.currentHost');
    expect(document.querySelector('.workspace-source-selector__device')?.textContent).toBe('Build Station');
    await add('/peer/work');
    expect(pickDirectory).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('explains an assistant source conflict and keeps the folder removable for retry', async () => {
    confirm.mockRejectedValueOnce(new AssistantProjectFolderError());
    await render();
    await add('/srv/assistant');
    await click('newProject.create');
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('newProject.assistantFolderUnavailable');
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="newProject.removeFolder"]')!.click());
    enterName('example');
    await click('newProject.create');
    expect(confirm).toHaveBeenLastCalledWith({ name: 'example', folders: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('explains an unavailable host directory and leaves the name editable', async () => {
    confirm.mockRejectedValue(new ProjectDirectoryUnavailableError());
    await render();
    enterName('example');
    await click('newProject.create');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('newProject.defaultDirectoryUnavailable');
    expect(nameInput().value).toBe('example');
    expect(nameInput().disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('starts at the choice and preserves the project draft when going back', async () => {
    const createAssistant = vi.fn();
    await render({ onCreateAssistant: createAssistant });
    expect(nameInput()).toBeNull();
    expect(choice('assistant')).toBe(document.activeElement);
    expect(document.querySelector('[data-openbitfun-part="footer"]')).toBeNull();
    expect(button('newProject.cancel')).toBeUndefined();
    expect(document.querySelectorAll('[data-openbitfun-component="action-card"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-openbitfun-component="action-card"] button')).toHaveLength(2);
    expect(confirm).not.toHaveBeenCalled();
    await choose('project');
    expect(nameInput()).toBe(document.activeElement);
    enterName('Product');
    await add('/srv/frontend');
    await click('newWorkspace.back');
    expect(choice('assistant')).toBe(document.activeElement);
    expect(createAssistant).not.toHaveBeenCalled();
    await choose('project');
    expect(nameInput().value).toBe('Product');
    expect(document.querySelectorAll('li')).toHaveLength(1);
    await click('newWorkspace.createProject');
    expect(confirm).toHaveBeenCalledWith({ name: 'Product', folders: [{ path: '/srv/frontend' }] });
    expect(createAssistant).not.toHaveBeenCalled();
  });

  it('creates an assistant on a card click and prevents duplicate submissions', async () => {
    let finish!: () => void;
    const createAssistant = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await render({ onCreateAssistant: createAssistant });
    await act(async () => {
      const submit = choice('assistant');
      submit.click();
      submit.click();
    });
    expect(createAssistant).toHaveBeenCalledOnce();
    expect(choice('assistant').disabled).toBe(true);
    expect(choice('project').disabled).toBe(true);
    expect(choice('assistant').getAttribute('aria-busy')).toBe('true');
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('keeps assistant creation failures on the choice for retry', async () => {
    const createAssistant = vi.fn().mockRejectedValueOnce(new Error('Host offline')).mockResolvedValueOnce(undefined);
    await render({ onCreateAssistant: createAssistant });
    await choose('assistant');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host offline');
    expect(close).not.toHaveBeenCalled();
    expect(choice('assistant').disabled).toBe(false);
    expect(choice('project').disabled).toBe(false);
    await choose('assistant');
    expect(createAssistant).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('resets to the first level after closing and rejects assistant creation on a changed device', async () => {
    const createAssistant = vi.fn();
    await render({ onCreateAssistant: createAssistant });
    await choose('project');
    enterName('Old draft');
    await render({ isOpen: false, onCreateAssistant: createAssistant });
    await render({ onCreateAssistant: createAssistant });
    expect(nameInput()).toBeNull();
    await choose('project');
    expect(nameInput().value).toBe('');
    await click('newWorkspace.back');
    activateSurface(surfaceIdForDevice('another-host'));
    await choose('assistant');
    expect(createAssistant).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
