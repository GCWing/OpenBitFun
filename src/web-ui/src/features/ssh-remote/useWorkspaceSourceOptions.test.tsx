// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceSourceOptions, workspacePresetHost, type WorkspaceConnectionPreset } from './useWorkspaceSourceOptions';
import type { WorkspaceSource } from './workspaceSource';
import { activateSurface, resetDeviceSurfaceForTest, surfaceIdForDevice } from '@/infrastructure/peer-device/deviceSurface';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ listSavedConnections: vi.fn(), listSSHConfigHosts: vi.fn(), listWslDistributions: vi.fn(), listDockerContainers: vi.fn() }));
vi.mock('./sshApi', () => ({ sshApi: api }));
vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
let result: ReturnType<typeof useWorkspaceSourceOptions>;
function Fixture({ source, hostPreset }: { source: WorkspaceSource; hostPreset?: WorkspaceConnectionPreset }) {
  result = useWorkspaceSourceOptions(source, true, hostPreset);
  return <div>{result.options.map(option => option.label).join(',')}{result.error}</div>;
}
let root: Root;
let host: HTMLDivElement;
const render = async (source: WorkspaceSource) => { await act(async () => root.render(<Fixture source={source} />)); };
beforeEach(() => {
  vi.resetAllMocks(); resetDeviceSurfaceForTest();
  api.listSavedConnections.mockResolvedValue([]);
  api.listSSHConfigHosts.mockResolvedValue([]);
  api.listWslDistributions.mockResolvedValue({ supported: true, distributions: ['Ubuntu'] });
  api.listDockerContainers.mockResolvedValue([{ id: 'dev-id', name: 'dev', image: 'ubuntu', state: 'running' }]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); resetDeviceSurfaceForTest(); });

it.each(['wsl', 'localDocker'] as const)('merges saved and detected %s choices without duplicate instances', async source => {
  api.listSavedConnections.mockResolvedValue([{
    id: 'existing', name: 'My environment', host: 'localhost', port: 22, username: '', authType: { type: 'PrivateKey', keyPath: '' },
    ...(source === 'wsl' ? { wsl: { distribution: 'Ubuntu' } } : { container: { name: 'dev', local: true } }),
  }]);
  await render(source);
  expect(result.options.map(option => option.id)).toEqual(['existing']);
  expect(api.listSSHConfigHosts).not.toHaveBeenCalled();
});

it('constructs native presets using the existing connection identities and profile fields', async () => {
  await render('wsl');
  expect(result.options[0].preset).toMatchObject({ kind: 'saved', connection: { id: 'wsl-Ubuntu@', host: 'wsl.invalid', port: 0, wsl: { distribution: 'Ubuntu' } } });
  await render('localDocker');
  expect(result.options[0].preset).toMatchObject({ kind: 'saved', connection: { id: 'docker-local-dev', container: { name: 'dev', local: true } } });
});

it('retains configured choices and surfaces unsupported discovery without local fallback', async () => {
  api.listSavedConnections.mockResolvedValue([{ id: 'saved', name: 'Saved WSL', wsl: { distribution: 'Ubuntu' } }]);
  api.listWslDistributions.mockRejectedValue(new Error('wsl_workspaces_v1_unsupported'));
  await render('wsl');
  expect(result.options.map(option => option.id)).toEqual(['saved']);
  expect(result.error).toBe('ssh.remote.wslUnsupported');
  expect(api.listDockerContainers).not.toHaveBeenCalled();
});

it('never discovers controller containers for a remote container source', async () => {
  await render('remoteDocker');
  expect(api.listSavedConnections).toHaveBeenCalledOnce();
  expect(api.listDockerContainers).not.toHaveBeenCalled();
  expect(api.listWslDistributions).not.toHaveBeenCalled();
});

it('projects a host from a legacy container-only profile without overwriting the original connection or credential identity', async () => {
  const container = { name: 'legacy', local: false, access: 'sshd', dockerPath: 'docker', shell: '/bin/sh', interactive: true };
  const legacy = { id: 'legacy-container', name: 'Legacy container', host: 'old.test', port: 2222, username: 'dev', authType: { type: 'Password' }, container };
  api.listSavedConnections.mockResolvedValue([legacy]);
  await render('ssh');
  expect(result.options).toHaveLength(1);
  const host = result.options[0].preset;
  expect(host).toMatchObject({ kind: 'saved', credentialConnectionId: 'legacy-container', connection: { host: 'old.test', port: 2222, container: undefined } });
  if (host.kind !== 'saved') throw new Error('Expected a host projection');
  expect(host.connection.id).not.toBe(legacy.id);
  expect(legacy.container).toBe(container);
  await act(async () => root.render(<Fixture source="remoteDocker" hostPreset={host} />));
  expect(api.listDockerContainers).toHaveBeenLastCalledWith(expect.objectContaining({ id: legacy.id, host: 'old.test' }));
  expect(result.options.some(option => option.id === legacy.id)).toBe(true);
});

it('retains selected options while a refresh is pending', async () => {
  await render('wsl');
  let finish!: (data: { supported: boolean; distributions: string[] }) => void;
  api.listWslDistributions.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => result.refresh());
  expect(result.loading).toBe(true);
  expect(result.options[0].label).toBe('Ubuntu');
  await act(async () => finish({ supported: true, distributions: ['Debian'] }));
  expect(result.options[0].label).toBe('Debian');
});

it('discovers containers on the selected remote host with its vault identity and ignores a late previous host', async () => {
  const preset = (id: string): WorkspaceConnectionPreset => ({ kind: 'saved', connection: {
    id, name: id, host: `${id}.test`, port: 22, username: 'dev', authType: { type: 'Password' },
  } });
  let resolveOld!: (containers: Array<{ id: string; name: string; image: string; state: string }>) => void;
  api.listDockerContainers.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => root.render(<Fixture source="remoteDocker" hostPreset={preset('one')} />));
  expect(api.listDockerContainers).toHaveBeenCalledWith(expect.objectContaining({ id: 'one', host: 'one.test',
    container: expect.objectContaining({ local: false }), auth: { type: 'Password', password: '' } }));
  await act(async () => root.render(<Fixture source="remoteDocker" hostPreset={preset('two')} />));
  expect(result.options[0].preset).toMatchObject({ kind: 'saved', connection: { host: 'two.test', container: { name: 'dev', local: false } } });
  await act(async () => resolveOld([{ id: 'old', name: 'old-container', image: 'ubuntu', state: 'running' }]));
  expect(result.options.map(option => option.label)).toEqual(['dev']);
});

it('discards late discovery after a device switch', async () => {
  let resolveOld!: (data: { supported: boolean; distributions: string[] }) => void;
  api.listWslDistributions.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  await render('wsl');
  await act(async () => activateSurface(surfaceIdForDevice('peer')));
  expect(result.options.map(option => option.label)).toEqual(['Ubuntu']);
  await act(async () => resolveOld({ supported: true, distributions: ['Old machine'] }));
  expect(result.options.map(option => option.label)).toEqual(['Ubuntu']);
});

it('resolves ~/.ssh/config ids against saved profiles so another port is never overwritten', async () => {
  // Saved profile on port 2201 under the port-less legacy id; config entry for port 22.
  api.listSavedConnections.mockResolvedValue([{
    id: 'ssh-root@cluster', name: 'Node 1', host: 'cluster', port: 2201, username: 'root', authType: { type: 'Agent' },
  }]);
  api.listSSHConfigHosts.mockResolvedValue([{ host: 'cluster-main', hostname: 'cluster', port: 22, user: 'root', agent: true }]);
  await render('ssh');
  const preset = result.options.find(option => option.id === 'ssh-config:cluster-main')?.preset;
  expect(preset).toMatchObject({ kind: 'sshConfig', connectionId: 'ssh-root@cluster#22' });
  expect(workspacePresetHost(preset)?.id).toBe('ssh-root@cluster#22');
});

it('routes ~/.ssh/config entries to the dialog when saved profiles cannot be listed', async () => {
  api.listSavedConnections.mockRejectedValue(new Error('offline'));
  api.listSSHConfigHosts.mockResolvedValue([{ host: 'cluster-main', hostname: 'cluster', port: 22, user: 'root', agent: true }]);
  await render('ssh');
  const preset = result.options.find(option => option.id === 'ssh-config:cluster-main')?.preset;
  expect(preset).toMatchObject({ kind: 'sshConfig' });
  expect(preset && 'connectionId' in preset ? preset.connectionId : undefined).toBeUndefined();
  // No connectable profile: the caller opens the connection dialog instead of a one-click connect.
  expect(workspacePresetHost(preset)).toBeUndefined();
});
