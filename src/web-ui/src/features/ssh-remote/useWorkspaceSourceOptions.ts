import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { sshApi } from './sshApi';
import { workspaceSourceErrorKey } from './workspaceSourceError';
import { createLogger } from '@/shared/utils/logger';
const log = createLogger('WorkspaceSourceOptions');
import { sameWorkspaceSource, savedConnectionTarget, type WorkspaceSource } from './workspaceSource';
import type { SavedConnection, SSHConfigEntry, SSHConnectionConfig } from './types';
import { DEFAULT_SSH_PORT, type SshEndpoint } from './sshConnectionId';
import { resolveNewSshConnectionId } from './resolveSshConnectionId';

export type WorkspaceConnectionPreset = (
  | { kind: 'new'; host?: SavedConnection }
  | { kind: 'saved'; connection: SavedConnection }
  /** `connectionId` is resolved against the host's saved profiles; without it the dialog decides. */
  | { kind: 'sshConfig'; entry: SSHConfigEntry; connectionId?: string }) & { edit?: boolean; authenticate?: boolean; credentialConnectionId?: string };

export interface WorkspaceSourceOption {
  id: string;
  label: string;
  description?: string;
  preset: WorkspaceConnectionPreset;
}

const sshConfigEndpoint = (entry: SSHConfigEntry): SshEndpoint => ({
  host: entry.hostname || entry.host, port: entry.port || DEFAULT_SSH_PORT, username: entry.user || '',
});

/** Connectable profile of a preset; an `sshConfig` entry whose id is unresolved has none. */
export function workspacePresetHost(preset?: WorkspaceConnectionPreset): SavedConnection | undefined {
  if (preset?.kind === 'saved') return preset.connection;
  if (preset?.kind !== 'sshConfig' || !preset.connectionId) return undefined;
  const { entry } = preset;
  return {
    ...sshConfigEndpoint(entry), id: preset.connectionId, name: entry.host,
    authType: entry.identityFile ? { type: 'PrivateKey', keyPath: entry.identityFile, certificatePath: entry.certificateFile }
      : entry.agent ? { type: 'Agent' } : { type: 'Password' },
    proxyJump: entry.proxyJump,
  };
}

function presetEndpoint(preset: WorkspaceConnectionPreset) {
  if (preset.kind === 'saved') return preset.connection;
  return preset.kind === 'sshConfig' ? { ...sshConfigEndpoint(preset.entry), proxyJump: preset.entry.proxyJump } : undefined;
}

function hostDiscoveryConfig(host: SavedConnection, credentialConnectionId?: string): SSHConnectionConfig {
  const { authType, ...config } = host;
  return { ...config, id: credentialConnectionId || config.id, container: { name: 'discovery', local: false, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
    auth: authType.type === 'Password' ? { type: 'Password', password: '' }
    : authType.type === 'KeyboardInteractive' ? { type: 'KeyboardInteractive', responses: [] } : authType };
}

export function useWorkspaceSourceOptions(source: WorkspaceSource, enabled: boolean, hostPreset?: WorkspaceConnectionPreset) {
  const { t } = useI18n('common');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [options, setOptions] = useState<WorkspaceSourceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const optionsOwner = useRef<{ source: WorkspaceSource; scope: typeof scope; hostId?: string }>();

  useEffect(() => {
    const host = workspacePresetHost(hostPreset);
    const previousOwner = optionsOwner.current;
    if (!enabled || previousOwner?.scope !== scope || previousOwner?.source !== source || previousOwner?.hostId !== host?.id) setOptions([]);
    optionsOwner.current = { source, scope, hostId: host?.id };
    setError('');
    if (!enabled || source === 'host') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const discovery = source === 'wsl' ? sshApi.listWslDistributions()
      : source === 'localDocker' ? sshApi.listDockerContainers({
        id: 'docker-local-discovery', name: 'Docker', host: 'localhost', port: 22,
        username: 'docker', auth: { type: 'PrivateKey', keyPath: '' },
        container: { name: 'discovery', local: true, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
      })
      : source === 'remoteDocker' && host ? sshApi.listDockerContainers(hostDiscoveryConfig(host, hostPreset?.credentialConnectionId))
      : source === 'ssh' ? sshApi.listSSHConfigHosts() : Promise.resolve(null);
    void Promise.allSettled([sshApi.listSavedConnections(), discovery]).then(async ([saved, detected]) => {
      if (cancelled || !scope.isCurrent()) return;
      const connections = saved.status === 'fulfilled' ? saved.value.filter(connection => sameWorkspaceSource(savedConnectionTarget(connection), source)
        && (source !== 'remoteDocker' || (host && connection.host === host.host && connection.port === host.port && connection.username === host.username))) : [];
      const result: WorkspaceSourceOption[] = connections.map(connection => ({
        id: connection.id, label: connection.name,
        description: connection.wsl?.distribution || connection.container?.name || `${connection.username}@${connection.host}:${connection.port}`,
        preset: { kind: 'saved', connection },
      }));
      if (source === 'ssh' && saved.status === 'fulfilled') {
        for (const connection of saved.value) {
          if (!connection.container || connection.container.local || connection.wsl) continue;
          if (result.some(option => {
            const host = presetEndpoint(option.preset);
            return host?.host === connection.host && host.port === connection.port && host.username === connection.username && host.proxyJump === connection.proxyJump;
          })) continue;
          const id = `workspace-host-${encodeURIComponent(connection.id)}`;
          result.push({ id, label: `${connection.username}@${connection.host}`, description: `${connection.host}:${connection.port}`,
            preset: { kind: 'saved', credentialConnectionId: connection.id, connection: { ...connection, id,
              name: `${connection.username}@${connection.host}`, container: undefined, defaultWorkspace: undefined } } });
        }
      }
      const failures = [saved, detected].filter(item => item.status === 'rejected')
        .map(item => {
          const reason = (item as PromiseRejectedResult).reason;
          log.warn('Failed to load workspace source options', { source, error: reason });
          return t(workspaceSourceErrorKey(source, reason));
        });
      if (detected.status === 'fulfilled') {
        if (source === 'wsl') {
          const data = detected.value as Awaited<ReturnType<typeof sshApi.listWslDistributions>>;
          if (!data.supported) failures.push(t('ssh.remote.wslUnsupported'));
          else for (const distribution of data.distributions) {
            if (connections.some(connection => connection.wsl?.distribution === distribution && !connection.wsl.user)) continue;
            const id = `wsl-${encodeURIComponent(distribution)}@`;
            result.push({ id, label: distribution, preset: { kind: 'saved', connection: {
              id, name: `WSL · ${distribution}`, host: 'wsl.invalid', port: 0, username: '',
              authType: { type: 'PrivateKey', keyPath: '' }, wsl: { distribution },
            } } });
          }
        } else if (source === 'localDocker' || (source === 'remoteDocker' && host)) {
          for (const container of detected.value as Awaited<ReturnType<typeof sshApi.listDockerContainers>>) {
            if (connections.some(connection => connection.container?.name === container.name)) continue;
            const id = host ? `${host.id}-container-${container.name}` : `docker-local-${container.name}`;
            result.push({ id, label: container.name, description: `${container.image} · ${container.state}`, preset: { kind: 'saved', connection: {
              ...(host || { host: 'localhost', port: 22, username: 'docker', authType: { type: 'PrivateKey' as const, keyPath: '' } }),
              id, name: container.name,
              container: { name: container.name, local: !host, access: 'auto', dockerPath: 'docker', shell: '/bin/sh', interactive: true },
            } } });
          }
        } else if (source === 'ssh') {
          for (const entry of detected.value as SSHConfigEntry[]) {
            const endpoint = sshConfigEndpoint(entry);
            if (connections.some(connection => connection.host === endpoint.host && connection.port === endpoint.port && connection.username === endpoint.username)) continue;
            // Without the saved profiles any id could overwrite one, so the dialog resolves it on connect.
            const resolved = saved.status === 'fulfilled'
              ? await resolveNewSshConnectionId(endpoint, connection => !connection.container && !connection.wsl, saved.value)
              : undefined;
            if (cancelled || !scope.isCurrent()) return;
            result.push({ id: `ssh-config:${entry.host}`, label: entry.host,
              description: `${endpoint.username}@${endpoint.host}:${endpoint.port}`,
              preset: { kind: 'sshConfig', entry, ...(resolved && 'id' in resolved ? { connectionId: resolved.id } : {}) } });
          }
        }
      }
      setOptions(result);
      setError([...new Set(failures)].join('\n'));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [source, enabled, revision, scope, t, hostPreset]);

  return { options, loading, error, refresh: () => setRevision(value => value + 1) };
}
