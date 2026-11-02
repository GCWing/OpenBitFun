// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SSHConnectionDialog } from './SSHConnectionDialog';
import { SSHAuthPromptDialog } from './SSHAuthPromptDialog';
import type { SavedConnection, WorkspaceConnectionTarget } from './types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { getDeviceInfo: async () => ({ device_id: 'local', device_name: 'Workstation' }) },
}));
const { sshApi, remote, peerDevice } = vi.hoisted(() => ({
  peerDevice: { value: null as null | { peerMode: { active: boolean; deviceName: string }; capabilities: object | null } },
  sshApi: {
    listSavedConnections: vi.fn(), listSSHConfigHosts: vi.fn(), getSSHConfig: vi.fn(),
    listWslDistributions: vi.fn(), listDockerContainers: vi.fn(), saveConnection: vi.fn(),
  },
  remote: { connect: vi.fn(), clearError: vi.fn(), status: 'disconnected', connectionError: null },
}));
vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string, options?: { host?: string }) => options?.host ? `${key} · ${options.host}` : key;
  return { useI18n: () => ({ t }) };
});
vi.mock('./SSHRemoteContext', () => ({ useSSHRemoteContext: () => remote }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/peer-device/peerDeviceContextState')>(),
  usePeerDeviceModeOptional: () => peerDevice.value,
}));
vi.mock('./sshApi', () => ({ sshApi }));
vi.mock('./pickSshPrivateKeyPath', () => ({ pickSshPrivateKeyPath: vi.fn(), pickSshCertificatePath: vi.fn() }));

// Use the public components: mocking Input and Select conceals their different defaults.
describe('remote workspace form composition', () => {
  let root: Root;
  let host: HTMLDivElement;
  const renderConnection = async (target: WorkspaceConnectionTarget, fixedSource = false) => {
    await act(async () => root.render(<SSHConnectionDialog open initialTargetType={target} fixedSource={fixedSource} onClose={vi.fn()} />));
  };
  const assertFields = (form: Element) => {
    const controls = form.querySelectorAll<HTMLElement>('[data-openbitfun-component="input"], [data-openbitfun-component="select"], [data-openbitfun-component="combobox"], [data-openbitfun-component="number-input"]');
    expect(controls.length).toBeGreaterThan(1);
    for (const control of controls) {
      expect(control.dataset.size).toBe('md');
      const interactive = control.querySelector<HTMLInputElement | HTMLButtonElement>('input, button[role="combobox"]')!;
      expect(interactive.id).not.toBe('');
      expect(form.querySelector(`label[for="${interactive.id}"]`)).not.toBeNull();
    }
  };
  const enterValue = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const fieldControl = (label: string) => document.getElementById(
    [...document.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === label)!.htmlFor,
  )!;
  const enterContainer = async (value: string) => {
    await act(async () => fieldControl('ssh.remote.containerName').click());
    const input = document.querySelector<HTMLInputElement>('[data-openbitfun-component="combobox-popup"] input[role="combobox"]')!;
    enterValue(input, value);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  };


  beforeEach(() => {
    vi.clearAllMocks();
    peerDevice.value = null;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    sshApi.listSavedConnections.mockResolvedValue([]);
    sshApi.listSSHConfigHosts.mockResolvedValue([]);
    sshApi.getSSHConfig.mockResolvedValue({ found: false });
    sshApi.listWslDistributions.mockResolvedValue({ supported: true, distributions: ['Ubuntu'] });
    sshApi.listDockerContainers.mockResolvedValue([{ id: 'dev', name: 'dev', image: 'ubuntu', state: 'running', status: 'Up' }]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(['ssh', 'wsl', 'localDocker', 'remoteDocker', 'containerSshd'] as const)(
    'keeps %s controls and advanced settings on one size and label contract', async target => {
      await renderConnection(target);
      await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]')!.click());
      assertFields(document.querySelector('[data-openbitfun-part="connectionForm"]')!);
    },
  );

  it('keeps manual container entry and its label through discovery and refresh', async () => {
    await renderConnection('localDocker');
    const original = fieldControl('ssh.remote.containerName');
    expect(original.getAttribute('role')).toBe('combobox');
    await enterContainer('custom-before-discovery');
    expect(fieldControl('ssh.remote.containerName').textContent).toContain('custom-before-discovery');
    const discover = document.querySelector<HTMLButtonElement>('button[aria-label="ssh.remote.discoverContainers"]')!;
    await act(async () => discover.click());
    expect(fieldControl('ssh.remote.containerName')).toBe(original);
    expect(original.textContent).toContain('custom-before-discovery');
    expect(original.closest<HTMLElement>('[data-openbitfun-component="combobox"]')?.dataset.size).toBe('md');
    await enterContainer('custom-after-discovery');
    expect(original.textContent).toContain('custom-after-discovery');
    await act(async () => original.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[data-openbitfun-listbox-option]')].find(item => item.textContent?.includes('dev'))!;
    await act(async () => option.click());
    expect(original.textContent).toContain('dev');
    expect(sshApi.listDockerContainers).toHaveBeenCalledTimes(2);
  });

  it('edits a saved connection through an independent native button without starting a connection', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'saved', name: 'Build host', host: 'example.test', port: 22, username: 'dev', authType: { type: 'PrivateKey', keyPath: '/keys/dev' },
    }]);
    await renderConnection('ssh');
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label^="actions.edit"]')!;
    expect(edit.closest('[role="button"]')).toBeNull();
    expect(edit.parentElement?.closest('button')).toBeNull();
    act(() => edit.focus());
    expect(document.activeElement).toBe(edit);
    act(() => edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(remote.connect).not.toHaveBeenCalled();
    await act(async () => edit.click());
    expect((fieldControl('ssh.remote.host') as HTMLInputElement).value).toBe('example.test');
    expect(document.querySelector('[data-openbitfun-component="disclosure"]')?.getAttribute('data-open')).toBe('true');
    expect(remote.connect).not.toHaveBeenCalled();
  });

  it('filters and clears the saved connection search', async () => {
    sshApi.listSavedConnections.mockResolvedValue([
      { id: 'one', name: 'Build host', host: 'build.test', port: 22, username: 'dev', authType: { type: 'Password' } },
      { id: 'two', name: 'Test host', host: 'test.test', port: 22, username: 'dev', authType: { type: 'Password' } },
    ]);
    await renderConnection('ssh');
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.getAttribute('aria-label')).toContain('ssh.remote.savedConnections');
    enterValue(search, 'Build');
    expect(document.querySelectorAll('[data-openbitfun-part="connectionList"] [data-openbitfun-component="capsule"]')).toHaveLength(1);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="actions.clear"]')!.click());
    expect(search.value).toBe('');
    expect(document.querySelectorAll('[data-openbitfun-part="connectionList"] [data-openbitfun-component="capsule"]')).toHaveLength(2);
  });

  it('bounds retry quantities and submits the committed numeric value', async () => {
    await renderConnection('ssh');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]')!.click());
    const retries = fieldControl('ssh.remote.connectAttempts') as HTMLInputElement;
    expect(retries.closest('[data-openbitfun-component="number-input"]')).not.toBeNull();
    act(() => retries.focus());
    enterValue(retries, '99');
    await act(async () => retries.blur());
    expect(retries.value).toBe('5');
    enterValue(fieldControl('ssh.remote.host') as HTMLInputElement, 'example.test');
    enterValue(fieldControl('ssh.remote.username') as HTMLInputElement, 'dev');
    enterValue(fieldControl('ssh.remote.password') as HTMLInputElement, 'secret');
    const connect = [...document.querySelectorAll('button')].find(item => item.textContent === 'ssh.remote.connect')!;
    await act(async () => connect.click());
    expect(remote.connect).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ options: expect.objectContaining({ connectAttempts: 5 }) }), { browseAfterConnect: true });
  });

  it('keeps connection searches compact outside the standard-size connection form', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'saved', name: 'Saved', host: 'example.test', port: 22, username: 'dev', authType: { type: 'Password' },
    }]);
    sshApi.listSSHConfigHosts.mockResolvedValue([{ host: 'dev', hostname: 'example.test', user: 'dev' }]);
    await renderConnection('ssh');
    expect(document.querySelector<HTMLElement>('.ssh-connection-dialog__search')?.dataset.size).toBe('sm');
    expect(document.querySelector('[data-openbitfun-part="connectionForm"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="new"]')!.click());
    expect(document.querySelectorAll('.ssh-connection-dialog__search')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.ssh-connection-dialog__search')?.dataset.size).toBe('sm');
    assertFields(document.querySelector('[data-openbitfun-part="connectionForm"]')!);
  });

  it.each(['password', 'privateKey', 'agent', 'keyboardInteractive'] as const)(
    'keeps the saved-connection %s authentication prompt consistent', async method => {
      await act(async () => root.render(
        <SSHAuthPromptDialog open targetDescription="dev@example.test" defaultAuthMethod={method}
          initialUsername="dev" lockUsername={false} onSubmit={vi.fn()} onCancel={vi.fn()} />,
      ));
      assertFields(document.querySelector('[data-openbitfun-part="authDialog"]')!);
    },
  );

  it('uses a preset selected on the project page once without requiring another selection', async () => {
    const connection: SavedConnection = { id: 'docker-local-dev', name: 'dev', host: 'localhost', port: 22, username: 'docker',
      authType: { type: 'PrivateKey', keyPath: '' }, container: { name: 'dev', local: true, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true } };
    const preset = { kind: 'saved' as const, connection };
    const render = () => root.render(<SSHConnectionDialog open initialTargetType="localDocker" fixedSource initialPreset={preset} onClose={vi.fn()} />);
    await act(async () => render());
    await act(async () => render());
    expect(remote.connect).toHaveBeenCalledOnce();
    expect(remote.connect).toHaveBeenCalledWith(connection.id, expect.objectContaining({ container: connection.container }), { browseAfterConnect: true });
  });

  it.each(['wsl', 'localDocker', 'remoteDocker', 'containerSshd', 'ssh'] as const)(
    'only offers saved profiles compatible with the fixed %s project environment', async target => {
      const profiles: SavedConnection[] = [
        { id: 'ssh', name: 'Legacy SSH', host: 'host.test', port: 22, username: 'dev', authType: { type: 'PrivateKey', keyPath: '/keys/dev' } },
        { id: 'wsl', name: 'Saved WSL', host: 'wsl.invalid', port: 0, username: '', authType: { type: 'PrivateKey', keyPath: '' }, wsl: { distribution: 'Ubuntu' } },
        ...(['localDocker', 'remoteDocker', 'containerSshd'] as const).map(source => ({
          id: source, name: source, host: 'docker.test', port: 22, username: 'dev', authType: { type: 'PrivateKey', keyPath: '/keys/dev' },
          container: { name: 'dev', local: source === 'localDocker', access: source === 'containerSshd' ? 'sshd' : 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
        })),
      ];
      sshApi.listSavedConnections.mockResolvedValue(profiles);
      sshApi.listSSHConfigHosts.mockResolvedValue([{ host: 'config-host', hostname: 'config.test', user: 'dev' }]);
      await renderConnection(target, true);
      expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
      expect(document.querySelector('[data-openbitfun-part="connectionForm"]')).toBeNull();
      expect(document.querySelector('input[type="password"]')).toBeNull();
      expect(document.querySelector('[data-openbitfun-part="sourceSelector"]')).toBeNull();
      const titles = {
        ssh: 'workspaceSource.connectRemoteHostTitle',
        wsl: 'workspaceSource.connectWslTitle · workspaceSource.currentHost',
        localDocker: 'workspaceSource.connectContainerTitle · workspaceSource.currentHost',
        remoteDocker: 'workspaceSource.connectRemoteContainerTitle',
        containerSshd: 'workspaceSource.connectRemoteContainerTitle',
      };
      expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(titles[target]);
      const names = [...document.querySelectorAll('[data-openbitfun-part="connectionList"] button[aria-pressed]')]
        .map(item => item.textContent);
      const expectedNames = target === 'remoteDocker' || target === 'containerSshd' ? ['remoteDocker', 'containerSshd']
        : [target === 'ssh' ? 'Legacy SSH' : target === 'wsl' ? 'Saved WSL' : 'localDocker'];
      expect(names).toEqual(expectedNames);
      if (target === 'wsl' || target === 'localDocker') {
        expect(document.body.textContent).not.toContain('config-host');
        expect(sshApi.listSSHConfigHosts).not.toHaveBeenCalled();
      }
      const profile = profiles.find(item => item.id === target)!;
      const quickConnect = [...document.querySelectorAll<HTMLButtonElement>('[data-openbitfun-part="connectionList"] button[aria-pressed]')]
        .find(item => item.textContent === profile.name)!;
      await act(async () => quickConnect.click());
      expect(remote.connect).not.toHaveBeenCalled();
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(item => item.textContent === 'ssh.remote.connect')!.click());
      const { authType: _authType, ...persisted } = profile;
      expect(remote.connect).toHaveBeenCalledWith(profile.id, expect.objectContaining(persisted), { browseAfterConnect: true });
      expect(remote.connect.mock.calls[0][1]).not.toHaveProperty('location');
      expect(remote.connect.mock.calls[0][1]).not.toHaveProperty('environment');
    },
  );

  it('builds a new remote container on the selected existing SSH host without repeating endpoint or authentication fields', async () => {
    const sshHost: SavedConnection = { id: 'host', name: 'Build host', host: 'build.test', port: 2222, username: 'dev',
      authType: { type: 'PrivateKey', keyPath: '/keys/build' }, proxyJump: 'jump.test' };
    sshApi.listSavedConnections.mockResolvedValue([sshHost]);
    await act(async () => root.render(<SSHConnectionDialog open fixedSource initialTargetType="remoteDocker"
      initialPreset={{ kind: 'new', host: sshHost }} onClose={vi.fn()} />));
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('input[aria-label="workspaceSource.dockerHostAddress"]')).toBeNull();
    expect(document.querySelector('input[aria-label="ssh.remote.username"]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('[aria-label="workspaceSource.sshHost"]')).toBeNull();
    expect(document.querySelector('h2')?.textContent).toContain('Build host');
    expect(sshApi.listDockerContainers).toHaveBeenCalledWith(expect.objectContaining({ id: 'host', host: 'build.test', proxyJump: 'jump.test' }));
    await enterContainer('devbox');
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'ssh.remote.connect')!.click());
    expect(remote.connect).toHaveBeenCalledWith('host-container-devbox', expect.objectContaining({ host: 'build.test', port: 2222, username: 'dev',
      auth: { type: 'PrivateKey', keyPath: '/keys/build' }, proxyJump: 'jump.test', container: expect.objectContaining({ name: 'devbox', local: false }) }), { browseAfterConnect: true });
  });

  it('connects a none-authenticated endpoint without asking for credentials', async () => {
    remote.connect.mockResolvedValue(undefined);
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'saved', name: 'Saved', host: 'saved.test', port: 22, username: 'dev', authType: { type: 'Password' },
    }]);
    await renderConnection('ssh', true);
    const newTab = document.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="new"]')!;
    await act(async () => newTab.click());
    enterValue(fieldControl('ssh.remote.host') as HTMLInputElement, '127.0.0.1');
    enterValue(fieldControl('ssh.remote.username') as HTMLInputElement, 'coder');
    // The default method asks for a password; switching to none must drop it.
    expect(document.querySelector('input[type="password"]')).not.toBeNull();

    await act(async () => fieldControl('ssh.remote.authMethod').click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[data-openbitfun-listbox-option]')]
      .find(item => item.textContent === 'ssh.remote.noAuth')!;
    expect(option).toBeDefined();
    await act(async () => option.click());

    expect(document.body.textContent).toContain('ssh.remote.noAuthHint');
    expect(document.querySelector('input[type="password"]')).toBeNull();

    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')]
      .find(button => button.textContent === 'ssh.remote.connect')!.click());
    expect(remote.connect).toHaveBeenCalledWith(
      'ssh-coder@127.0.0.1',
      expect.objectContaining({
        host: '127.0.0.1',
        username: 'coder',
        auth: { type: 'None' },
      }),
      { browseAfterConnect: true },
    );
  });

  it('offers none authentication on a peer surface only after the host negotiated it', async () => {
    const authOptionLabels = async () => {
      await renderConnection('ssh', true);
      await act(async () => fieldControl('ssh.remote.authMethod').click());
      const labels = [...document.querySelectorAll('[data-openbitfun-listbox-option]')].map(item => item.textContent);
      await act(async () => fieldControl('ssh.remote.authMethod').click());
      return labels;
    };
    peerDevice.value = { peerMode: { active: true, deviceName: 'Older peer' }, capabilities: { sshNoneAuthV1: false } };
    expect(await authOptionLabels()).not.toContain('ssh.remote.noAuth');
    peerDevice.value = { peerMode: { active: true, deviceName: 'Peer' }, capabilities: { sshNoneAuthV1: true } };
    expect(await authOptionLabels()).toContain('ssh.remote.noAuth');
  });

  it('reports a rejected none profile without falling back to a credentials prompt', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'coder', name: 'Coder', host: 'coder.test', port: 22, username: 'coder', authType: { type: 'None' },
    }]);
    remote.connect.mockRejectedValue(new Error('SSH authentication was rejected for user coder'));
    await renderConnection('ssh', true);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-part="connectionList"] button[aria-pressed]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(item => item.textContent === 'ssh.remote.connect')!.click());
    expect(remote.connect).toHaveBeenCalledWith('coder', expect.objectContaining({ auth: { type: 'None' } }), expect.anything());
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).toContain('workspaceSource.connectionFailed');
  });

  it('asks to update an older host instead of showing a generic failure for a none profile', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'coder', name: 'Coder', host: 'coder.test', port: 22, username: 'coder', authType: { type: 'None' },
    }]);
    remote.connect.mockRejectedValue(new Error('ssh_none_auth_v1_unsupported: The connected Peer host does not support it'));
    await renderConnection('ssh', true);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-part="connectionList"] button[aria-pressed]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(item => item.textContent === 'ssh.remote.connect')!.click());
    expect(document.body.textContent).toContain('ssh.remote.noAuthUnsupported');
  });

  it('requires an existing SSH host before configuring a remote container', async () => {
    await renderConnection('remoteDocker', true);
    expect(document.body.textContent).toContain('workspaceSource.existingHostRequired');
    expect(document.querySelector('button[aria-label="ssh.remote.fillForm"]')).toBeNull();
    const connect = [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === 'ssh.remote.connect')!;
    expect(connect.disabled).toBe(true);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('goes directly to missing credentials after a selected connection already failed authentication', async () => {
    const connection: SavedConnection = { id: 'host', name: 'Host', host: 'host.test', port: 22, username: 'dev', authType: { type: 'Password' } };
    await act(async () => root.render(<SSHConnectionDialog open fixedSource initialTargetType="ssh"
      initialPreset={{ kind: 'saved', connection, authenticate: true }} onClose={vi.fn()} />));
    expect(remote.connect).not.toHaveBeenCalled();
    expect(document.querySelector('[data-openbitfun-part="authDialog"]')).not.toBeNull();
    expect(document.querySelector('input[aria-label="ssh.remote.host"]')).toBeNull();
  });

  it.each(['ssh', 'localDocker', 'remoteDocker', 'containerSshd', 'wsl'] as const)(
    'only shows relevant required settings in the secondary %s form', async target => {
      await renderConnection(target, true);
      const labels = () => [...document.querySelectorAll('label')].map(label => label.textContent);
      expect(document.querySelectorAll('[role="radiogroup"]')).toHaveLength(0);
      for (const advanced of ['ssh.remote.dockerPath', 'ssh.remote.containerShell', 'ssh.remote.containerUser',
        'ssh.remote.containerAccess', 'ssh.remote.wslUser', 'ssh.remote.certificatePath', 'ssh.remote.agentFingerprint']) {
        expect(labels()).not.toContain(advanced);
      }
      const usesDocker = target === 'localDocker' || target === 'remoteDocker';
      expect(labels().includes('ssh.remote.containerName')).toBe(usesDocker);
      expect(document.querySelector('[role="group"][aria-label="ssh.remote.wslDistribution"]') !== null).toBe(target === 'wsl');
      expect(labels().includes('ssh.remote.authMethod')).toBe(target !== 'wsl' && target !== 'localDocker' && target !== 'remoteDocker');
      await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]')!.click());
      expect(labels().includes('ssh.remote.dockerPath')).toBe(usesDocker);
      expect(labels().includes('ssh.remote.containerShell')).toBe(usesDocker);
      expect(labels().includes('ssh.remote.wslUser')).toBe(target === 'wsl');
      expect(labels().includes('ssh.remote.proxyJump')).toBe(target !== 'wsl' && target !== 'localDocker' && target !== 'remoteDocker');
    },
  );

  it('preserves a manual connection draft when switching between saved and new views', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'saved', name: 'Saved', host: 'saved.test', port: 22, username: 'dev', authType: { type: 'Password' },
    }]);
    await renderConnection('ssh', true);
    const savedTab = document.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="saved"]')!;
    const newTab = document.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="new"]')!;
    expect(savedTab.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(savedTab.id);
    expect(document.querySelector('[data-openbitfun-part="connectionForm"]')).toBeNull();
    await act(async () => newTab.click());
    enterValue(fieldControl('ssh.remote.host') as HTMLInputElement, 'draft.test');
    enterValue(fieldControl('ssh.remote.username') as HTMLInputElement, 'draft-user');
    await act(async () => savedTab.click());
    expect(document.querySelector('[data-openbitfun-part="connectionForm"]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('.ssh-connection-dialog__actions')!.textContent).not.toContain('ssh.remote.testConnection');
    await act(async () => newTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(newTab.getAttribute('aria-selected')).toBe('true');
    expect((fieldControl('ssh.remote.host') as HTMLInputElement).value).toBe('draft.test');
    expect((fieldControl('ssh.remote.username') as HTMLInputElement).value).toBe('draft-user');
    expect(remote.connect).not.toHaveBeenCalled();
  });

  it.each(['wsl', 'localDocker'] as const)('shows the actual saved %s failure without requesting SSH authentication', async target => {
    const profile: SavedConnection = {
      id: 'saved-native', name: 'Native environment', host: target === 'wsl' ? 'wsl.invalid' : 'local-docker',
      port: target === 'wsl' ? 0 : 22, username: '', authType: { type: 'PrivateKey', keyPath: '' },
      ...(target === 'wsl' ? { wsl: { distribution: 'Ubuntu' } } : {
        container: { name: 'dev', local: true, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
      }),
    };
    sshApi.listSavedConnections.mockResolvedValue([profile]);
    remote.connect.mockRejectedValueOnce(new Error('Host does not support this environment'));
    await renderConnection(target, true);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-part="connectionList"] button[aria-pressed]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(item => item.textContent === 'ssh.remote.connect')!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(target === 'wsl' ? 'ssh.remote.wslUnsupported' : 'workspaceSource.sourceUnsupported');
    expect(document.querySelector('[data-openbitfun-part="authDialog"]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(remote.connect).toHaveBeenCalledOnce();
  });

  it('does not reopen an old SSH credential prompt when returning to configure WSL', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{
      id: 'saved-ssh', name: 'SSH', host: 'host.test', port: 22, username: 'dev', authType: { type: 'Password' },
    }]);
    remote.connect.mockRejectedValueOnce(new Error('Credentials required'));
    await renderConnection('ssh', true);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-openbitfun-part="connectionList"] button[aria-pressed]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(item => item.textContent === 'ssh.remote.connect')!.click());
    expect(document.querySelector('[data-openbitfun-part="authDialog"]')).not.toBeNull();
    expect(document.querySelector('[data-openbitfun-part="authDialog"] [data-openbitfun-component="select"]')).toBeNull();
    await act(async () => root.render(<SSHConnectionDialog open={false} initialTargetType="ssh" fixedSource onClose={vi.fn()} />));
    await renderConnection('wsl', true);
    await act(async () => new Promise(resolve => setTimeout(resolve, 200)));
    expect(document.querySelector('[data-openbitfun-part="authDialog"]')).toBeNull();
    expect(document.querySelector('[role="group"][aria-label="ssh.remote.wslDistribution"]')).not.toBeNull();
  });

  it('opens a separate editor and saves legacy profile identity and workspace without reconnecting', async () => {
    sshApi.listSavedConnections.mockResolvedValue([{ id: 'legacy-profile', name: 'Build host', host: 'host.test', port: 22,
      username: 'dev', authType: { type: 'Password' }, defaultWorkspace: '/srv/existing' }]);
    await renderConnection('ssh', true);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="actions.edit · Build host"]')!.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(remote.connect).not.toHaveBeenCalled();
    enterValue(fieldControl('ssh.remote.connectionName') as HTMLInputElement, 'Renamed host');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === 'actions.save')!.click());
    expect(sshApi.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ id: 'legacy-profile', name: 'Renamed host',
      auth: { type: 'Password', password: '' }, defaultWorkspace: '/srv/existing' }));
    expect(remote.connect).not.toHaveBeenCalled();
  });
});
