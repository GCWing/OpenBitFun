import { resolveLegacySessionWorkspace } from '@/infrastructure/api/service-api/legacyWorkspaceCompatibility';
/**
 * SSH Remote Feature - React Context Provider
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createLogger } from '@/shared/utils/logger';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { WorkspaceKind } from '@/shared/types/global-state';
import type { SSHConnectionConfig, RemoteWorkspace } from './types';
import { sshApi } from './sshApi';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { ACPClientAPI } from '@/infrastructure/api/service-api/ACPClientAPI';
import { normalizeRemoteWorkspacePath } from '@/shared/utils/pathUtils';
import { notificationService } from '@/shared/notification-system';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import {
  SSHContext,
  type ConnectionStatus,
  type SSHContextValue,
} from './SSHRemoteContext';
import {
  REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS,
  reconnectUntilDeadline,
  remoteReconnectTimeoutSeconds,
} from './remoteWorkspaceReconnect';

const log = createLogger('SSHRemoteProvider');
const pendingAcpCapabilityRefreshes = new Set<string>();
const RECONNECT_TIMEOUT_SECONDS = remoteReconnectTimeoutSeconds();

function refreshRemoteAcpCapabilities(connectionId: string): void {
  const normalized = connectionId.trim();
  if (!normalized || pendingAcpCapabilityRefreshes.has(normalized)) {
    return;
  }

  pendingAcpCapabilityRefreshes.add(normalized);
  void ACPClientAPI.probeClientRequirements({
    force: true,
    remoteConnectionId: normalized,
  })
    .catch(error => {
      log.warn('Failed to refresh remote ACP capabilities', { connectionId: normalized, error });
    })
    .finally(() => {
      pendingAcpCapabilityRefreshes.delete(normalized);
    });
}

/**
 * Close the workspace record behind a provider-level remote workspace. Records
 * are named by workspace ID; a remote workspace without one is a stale
 * provider projection and is left untouched (loudly) rather than guessed by
 * connection ID.
 */
async function removeRemoteWorkspaceRecord(remoteWorkspace: RemoteWorkspace): Promise<void> {
  if (!remoteWorkspace.workspaceId) {
    log.warn('Remote workspace has no workspace ID; skipping record removal', {
      connectionId: remoteWorkspace.connectionId,
    });
    return;
  }
  try {
    await workspaceManager.removeRemoteWorkspace(remoteWorkspace.workspaceId);
  } catch (error) {
    log.warn('Failed to remove remote workspace record', {
      workspaceId: remoteWorkspace.workspaceId,
      error,
    });
  }
}

function getActiveRemoteWorkspaceForConnection(connectionId: string): RemoteWorkspace | null {
  const normalizedConnectionId = connectionId.trim();
  if (!normalizedConnectionId) {
    return null;
  }

  const state = workspaceManager.getState();
  const activeWorkspace = state.activeWorkspaceId
    ? state.openedWorkspaces.get(state.activeWorkspaceId)
    : null;

  if (
    !activeWorkspace ||
    activeWorkspace.workspaceKind !== WorkspaceKind.Remote ||
    (activeWorkspace.connectionId ?? '').trim() !== normalizedConnectionId
  ) {
    return null;
  }

  return {
    workspaceId: activeWorkspace.id,
    connectionId: normalizedConnectionId,
    connectionName: activeWorkspace.connectionName?.trim() || 'Remote',
    remotePath: normalizeRemoteWorkspacePath(activeWorkspace.rootPath),
    sshHost: activeWorkspace.sshHost?.trim() || undefined,
  };
}

/**
 * Two reconnect entries describe the same workspace when their workspace IDs
 * match. Only pre-ID cache entries (no ID on either side) fall back to the
 * legacy connection + remote path comparison.
 */
function sameRemoteWorkspace(left: RemoteWorkspace, right: RemoteWorkspace): boolean {
  if (left.workspaceId || right.workspaceId) {
    return left.workspaceId === right.workspaceId;
  }
  return (
    left.connectionId === right.connectionId &&
    normalizeRemoteWorkspacePath(left.remotePath) === normalizeRemoteWorkspacePath(right.remotePath)
  );
}

/** After parallel reconnects: prefer the user's active remote workspace, else last in sidebar order (matches legacy serial last-write). */
function pickGlobalRemoteAfterReconnect(
  connected: Array<{ workspace: RemoteWorkspace; connectionId: string }>,
  orderedList: RemoteWorkspace[]
): { workspace: RemoteWorkspace; connectionId: string } | null {
  if (connected.length === 0) return null;
  const st = workspaceManager.getState();
  const aid = st.activeWorkspaceId;
  if (aid) {
    const aw = st.openedWorkspaces.get(aid);
    if (aw && aw.workspaceKind === WorkspaceKind.Remote && aw.connectionId) {
      const active: RemoteWorkspace = {
        workspaceId: aw.id,
        connectionId: aw.connectionId,
        connectionName: aw.connectionName?.trim() || 'Remote',
        remotePath: normalizeRemoteWorkspacePath(aw.rootPath),
      };
      const hit = connected.find(c => sameRemoteWorkspace(c.workspace, active));
      if (hit) return hit;
    }
  }
  for (let i = orderedList.length - 1; i >= 0; i--) {
    const ws = orderedList[i];
    const hit = connected.find(c => sameRemoteWorkspace(c.workspace, ws));
    if (hit) return hit;
  }
  return connected[connected.length - 1] ?? null;
}

interface SSHRemoteProviderProps {
  children: React.ReactNode;
}

export const SSHRemoteProvider: React.FC<SSHRemoteProviderProps> = ({ children }) => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionConfig, setConnectionConfig] = useState<SSHConnectionConfig | null>(null);
  const [remoteWorkspace, setRemoteWorkspace] = useState<RemoteWorkspace | null>(null);
  const [showConnectionDialog, setShowConnectionDialog] = useState(false);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  /** Fallback only when home cannot be resolved (never use literal `~` for SFTP). */
  const [remoteFileBrowserInitialPath, setRemoteFileBrowserInitialPath] = useState('/tmp');
  // Per-workspace connection statuses (keyed by connectionId)
  const [workspaceStatuses, setWorkspaceStatuses] = useState<Record<string, ConnectionStatus>>({});
  const heartbeatInterval = useRef<number | null>(null);
  const workspaceStatusTimeouts = useRef<Map<string, number>>(new Map());
  const workspaceStatusesRef = useRef<Record<string, ConnectionStatus>>({});
  const remoteWorkspaceRef = useRef<RemoteWorkspace | null>(null);
  const startHeartbeatRef = useRef<(connId: string) => void>(() => {});
  const checkRemoteWorkspaceRef = useRef<() => Promise<void>>(async () => {});
  const checkRemoteWorkspaceInFlightRef = useRef(false);
  const reconnectByConnectionRef = useRef(new Map<
    string,
    Promise<false | { connectionId: string; connectionName: string; sshHost?: string }>
  >());

  workspaceStatusesRef.current = workspaceStatuses;
  remoteWorkspaceRef.current = remoteWorkspace;

  const setWorkspaceStatus = useCallback((connId: string, st: ConnectionStatus) => {
    const existingTimeout = workspaceStatusTimeouts.current.get(connId);
    if (existingTimeout !== undefined) {
      window.clearTimeout(existingTimeout);
      workspaceStatusTimeouts.current.delete(connId);
    }

    if (st === 'connecting') {
      const timeoutId = window.setTimeout(() => {
        workspaceStatusTimeouts.current.delete(connId);

        // Peer Device Mode: the peer owns SSH connections. Never run the
        // controller-side timeout removal — it would route removal invokes to
        // the peer and delete its workspaces.
        if (isPeerDeviceModeActive()) {
          setWorkspaceStatuses(prev =>
            prev[connId] === 'connecting' ? { ...prev, [connId]: 'connected' } : prev
          );
          return;
        }

        if (workspaceStatusesRef.current[connId] !== 'connecting') {
          return;
        }

        setWorkspaceStatuses(prev => {
          if (prev[connId] !== 'connecting') {
            return prev;
          }
          return { ...prev, [connId]: 'error' };
        });

        const openedRemoteWorkspaces: RemoteWorkspace[] = Array.from(workspaceManager.getState().openedWorkspaces.values())
          .filter(workspace =>
            workspace.workspaceKind === WorkspaceKind.Remote &&
            (workspace.connectionId ?? '').trim() === connId
          )
          .map(workspace => ({
            workspaceId: workspace.id,
            connectionId: connId,
            connectionName: workspace.connectionName?.trim() || 'Remote',
            remotePath: normalizeRemoteWorkspacePath(workspace.rootPath),
            sshHost: workspace.sshHost?.trim() || undefined,
          }));

        const activeRemoteWorkspace = remoteWorkspaceRef.current;
        if (
          activeRemoteWorkspace &&
          activeRemoteWorkspace.connectionId === connId &&
          !openedRemoteWorkspaces.some(workspace => sameRemoteWorkspace(workspace, activeRemoteWorkspace))
        ) {
          openedRemoteWorkspaces.push(activeRemoteWorkspace);
        }

        const pathList = openedRemoteWorkspaces
          .map(workspace => normalizeRemoteWorkspacePath(workspace.remotePath))
          .filter(Boolean)
          .join(', ');

        notificationService.error(
          pathList
            ? `Remote workspace connection timed out after ${RECONNECT_TIMEOUT_SECONDS} seconds. The saved workspace was kept for retry: ${pathList}`
            : `Remote workspace connection timed out after ${RECONNECT_TIMEOUT_SECONDS} seconds. The saved workspace was kept for retry.`,
          { duration: 8000 }
        );
      }, REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS);

      workspaceStatusTimeouts.current.set(connId, timeoutId);
    }

    setWorkspaceStatuses(prev => ({ ...prev, [connId]: st }));
  }, []);

  const reportRemoteWorkspaceReconnectFailure = useCallback((workspace: RemoteWorkspace) => {
    if (isPeerDeviceModeActive()) {
      return;
    }
    const path = normalizeRemoteWorkspacePath(workspace.remotePath);
    notificationService.error(
      `Remote workspace could not reconnect within ${RECONNECT_TIMEOUT_SECONDS} seconds. It remains saved for retry: ${path}`,
      { duration: 8000 }
    );
  }, []);

  const reportRemoteWorkspaceRestoreDeferred = useCallback((
    workspace: RemoteWorkspace,
    reason: 'missing-connection' | 'missing-password'
  ) => {
    if (isPeerDeviceModeActive()) {
      return;
    }
    const path = normalizeRemoteWorkspacePath(workspace.remotePath);
    notificationService.warning(
      reason === 'missing-password'
        ? `Remote workspace was kept. Re-enter its SSH password to reconnect: ${path}`
        : `Remote workspace was kept, but its saved SSH connection is unavailable: ${path}`,
      { duration: 8000 }
    );
  }, []);

  // Cleanup heartbeat on unmount
  useEffect(() => {
    const statusTimeouts = workspaceStatusTimeouts.current;
    return () => {
      if (heartbeatInterval.current) {
        clearInterval(heartbeatInterval.current);
      }
      for (const timeoutId of statusTimeouts.values()) {
        window.clearTimeout(timeoutId);
      }
      statusTimeouts.clear();
    };
  }, []);

  // Try to reconnect a single remote workspace until the reconnect budget expires.
  // Fast connection failures must keep retrying inside the budget; only then remove.
  const tryReconnectWithRetry = useCallback(async (
    workspace: RemoteWorkspace,
    timeoutMs: number = REMOTE_WORKSPACE_RECONNECT_TIMEOUT_MS
  ): Promise<false | { workspace: RemoteWorkspace; connectionId: string }> => {
    const connectionKey = workspace.connectionId.trim();
    let reconnect = reconnectByConnectionRef.current.get(connectionKey);

    if (!reconnect) {
      log.info('tryReconnectWithRetry: starting connection restore', {
        connectionId: connectionKey,
        timeoutMs,
      });
      reconnect = (async () => {
        const savedConnections = await sshApi.listSavedConnections();
        const savedConn = savedConnections.find(c => c.id === connectionKey);

        if (!savedConn) {
          log.warn('No saved connection found for workspace', { connectionId: connectionKey });
          return false;
        }

        // Determine auth method from tagged enum (password uses empty string; backend fills from vault)
        let authMethod: SSHConnectionConfig['auth'];
        if (savedConn.authType.type === 'PrivateKey') {
          authMethod = {
            type: 'PrivateKey',
            keyPath: savedConn.authType.keyPath,
            certificatePath: savedConn.authType.certificatePath,
          };
        } else if (savedConn.authType.type === 'Agent') {
          authMethod = {
            type: 'Agent',
            keyFingerprint: savedConn.authType.keyFingerprint,
            fallbackKeyPath: savedConn.authType.fallbackKeyPath,
          };
        } else if (savedConn.authType.type === 'KeyboardInteractive') {
          return false;
        } else {
          // Caller must only invoke password reconnect when vault has a password (see checkRemoteWorkspace).
          authMethod = { type: 'Password', password: '' };
        }

        const reconnectConfig: SSHConnectionConfig = {
          id: savedConn.id,
          name: savedConn.name,
          host: savedConn.host,
          port: savedConn.port,
          username: savedConn.username,
          auth: authMethod,
          defaultWorkspace: savedConn.defaultWorkspace,
          proxyJump: savedConn.proxyJump,
          container: savedConn.container,
          wsl: savedConn.wsl,
          options: savedConn.options,
        };

        const result = await reconnectUntilDeadline({
          totalTimeoutMs: timeoutMs,
          attempt: async (attemptTimeoutMs, attempt) => {
            if (isPeerDeviceModeActive()) {
              // Abort controller-side reconnects: connecting now would open an SSH
              // session on the peer with controller-local credentials.
              throw new Error('Peer device mode activated');
            }
            log.info(`Attempting to reconnect (attempt ${attempt})`, {
              connectionId: connectionKey,
              host: reconnectConfig.host,
              attemptTimeoutMs,
            });

            const connectWithTimeout = async (): Promise<{ connectionId: string }> => {
              const connectionResult = await sshApi.connect(reconnectConfig);
              if (!connectionResult.success || !connectionResult.connectionId) {
                throw new Error(connectionResult.error || 'Connection failed');
              }
              return { connectionId: connectionResult.connectionId };
            };

            let timeoutId: number | undefined;
            try {
              const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = window.setTimeout(
                  () => reject(new Error('Connection timeout')),
                  attemptTimeoutMs
                );
              });
              return await Promise.race([connectWithTimeout(), timeoutPromise]);
            } catch (err) {
              log.warn(`Reconnect attempt ${attempt} failed`, {
                connectionId: connectionKey,
                error: err,
              });
              throw err;
            } finally {
              if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
              }
            }
          },
        });

        if (result === false) {
          return false;
        }
        return {
          connectionId: result.connectionId,
          connectionName: savedConn.name,
          sshHost: reconnectConfig.host?.trim() || workspace.sshHost?.trim() || undefined,
        };
      })();
      reconnectByConnectionRef.current.set(connectionKey, reconnect);
      const clearReconnect = () => {
        if (reconnectByConnectionRef.current.get(connectionKey) === reconnect) {
          reconnectByConnectionRef.current.delete(connectionKey);
        }
      };
      void reconnect.then(clearReconnect, clearReconnect);
    } else {
      log.debug('Joining in-flight remote connection restore', { connectionId: connectionKey });
    }

    const result = await reconnect;
    if (result === false) {
      return false;
    }

    // A connection can own several opened workspace roots. Connect once, then
    // register every caller's path against the shared live transport.
    await sshApi.openWorkspace(result.connectionId, workspace.remotePath);
    const reconnectedWorkspace: RemoteWorkspace = {
      connectionId: result.connectionId,
      connectionName: result.connectionName,
      remotePath: workspace.remotePath,
      sshHost: result.sshHost,
    };
    log.info('Successfully reconnected to remote workspace', {
      originalConnectionId: workspace.connectionId,
      newConnectionId: result.connectionId,
      remotePath: workspace.remotePath,
    });
    return { workspace: reconnectedWorkspace, connectionId: result.connectionId };
  }, []);

  const statusRef = useRef<ConnectionStatus>(status);
  statusRef.current = status;

  const handleConnectionLost = useCallback((connId: string) => {
    log.warn('Remote connection lost, attempting auto-reconnect...');
    setStatus('error');
    setWorkspaceStatus(connId, 'error');
    setConnectionError('Connection lost. Attempting to reconnect...');
    setIsConnected(false);
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    }
    // Attempt auto-reconnect in background
    void checkRemoteWorkspaceRef.current();
  }, [setWorkspaceStatus]);

  const startHeartbeat = useCallback((connId: string) => {
    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
    }

    // Peer Device Mode routes product invokes to the peer; controller-local SSH
    // heartbeats must not flood HostInvoke with unrelated connection checks.
    if (isPeerDeviceModeActive()) {
      heartbeatInterval.current = null;
      return;
    }

    heartbeatInterval.current = window.setInterval(async () => {
      try {
        const connected = await sshApi.isConnected(connId);
        if (!connected && statusRef.current === 'connected') {
          handleConnectionLost(connId);
        }
      } catch {
        // Ignore heartbeat errors
      }
    }, 30000);
  }, [handleConnectionLost]);
  startHeartbeatRef.current = startHeartbeat;

  const checkRemoteWorkspace = useCallback(async () => {
    if (isPeerDeviceModeActive()) {
      log.info('checkRemoteWorkspace: skipped while peer device mode is active');
      return;
    }
    if (checkRemoteWorkspaceInFlightRef.current) {
      log.debug('checkRemoteWorkspace: skipped because startup restore is already in progress');
      return;
    }
    checkRemoteWorkspaceInFlightRef.current = true;
    try {
      // ── Collect all remote workspaces to reconnect ──────────────────────
      const wmState0 = workspaceManager.getState();
      const allWorkspaces = Array.from(wmState0.openedWorkspaces.values());
      const openedRemote = allWorkspaces.filter(
        ws => ws.workspaceKind === WorkspaceKind.Remote && ws.connectionId
      );

      // Also check legacy single-workspace persisted in app_state.
      // Startup normally receives this in the workspace snapshot, so avoid a
      // second early invoke unless the snapshot was unavailable.
      let legacyWorkspace: RemoteWorkspace | null = null;
      const startupLegacyWorkspace = workspaceManager.consumeStartupLegacyRemoteWorkspaceSnapshot();
      if (startupLegacyWorkspace.available) {
        legacyWorkspace = startupLegacyWorkspace.workspace;
      } else {
        try {
          legacyWorkspace = await sshApi.getWorkspaceInfo();
        } catch {
          // Ignore
        }
      }

      // Opened workspaces are keyed by workspace ID. Only the pre-ID legacy
      // snapshot still uses connection + path, and it is dropped when an
      // ID-owned record already covers the same checkout.
      const toReconnect = new Map<string, RemoteWorkspace>();

      for (const ws of openedRemote) {
        if (!ws.connectionId) continue;
        toReconnect.set(ws.id, {
          workspaceId: ws.id,
          connectionId: ws.connectionId,
          connectionName: ws.connectionName || 'Remote',
          remotePath: normalizeRemoteWorkspacePath(ws.rootPath),
          sshHost: ws.sshHost?.trim() || undefined,
        });
      }

      // Add legacy workspace if it isn't already covered
      if (legacyWorkspace?.connectionId) {
        const leg = normalizeRemoteWorkspacePath(legacyWorkspace.remotePath);
        const legacyRecord = resolveLegacySessionWorkspace({
          workspaceId: legacyWorkspace.workspaceId, workspacePath: leg,
          remoteConnectionId: legacyWorkspace.connectionId, remoteSshHost: legacyWorkspace.sshHost,
        }, openedRemote);
        const k = legacyRecord?.id ?? legacyWorkspace.workspaceId ?? `legacy\n${legacyWorkspace.connectionId}\n${leg}`;
        if (!toReconnect.has(k)) {
          toReconnect.set(k, { ...legacyWorkspace, workspaceId: legacyRecord?.id ?? legacyWorkspace.workspaceId, remotePath: leg });
        }
      }

      if (toReconnect.size === 0) {
        log.info('checkRemoteWorkspace: no remote workspaces to reconnect');
        return;
      }

      log.info(`checkRemoteWorkspace: found ${toReconnect.size} remote workspace(s)`);

      const reconnectList = Array.from(toReconnect.values());
      const savedConnectionsList = await sshApi.listSavedConnections();

      const skipPasswordAutoReconnect = new Set<string>();
      const missingSavedConnections = new Set<string>();
      for (const ws of reconnectList) {
        const sc = savedConnectionsList.find(c => c.id === ws.connectionId);
        if (!sc) {
          missingSavedConnections.add(ws.connectionId);
          continue;
        }
        if (sc?.authType.type === 'Password') {
          let hasVault = false;
          try {
            hasVault = await sshApi.hasStoredPassword(sc.id);
          } catch {
            hasVault = false;
          }
          if (!hasVault) {
            skipPasswordAutoReconnect.add(ws.connectionId);
          }
        } else if (sc?.authType.type === 'KeyboardInteractive') {
          // Interactive responses are intentionally never persisted.
          skipPasswordAutoReconnect.add(ws.connectionId);
        }
      }

      const initialStatuses: Record<string, ConnectionStatus> = {};
      for (const [, ws] of toReconnect) {
        initialStatuses[ws.connectionId] =
          skipPasswordAutoReconnect.has(ws.connectionId) ||
          missingSavedConnections.has(ws.connectionId)
          ? 'error'
          : 'connecting';
      }
      // A background check is not a reconnect. Keep the last observed state
      // while the probe is pending, including when session selection checks
      // every opened workspace again.
      setWorkspaceStatuses(prev => ({ ...initialStatuses, ...prev }));

      type ConnectedEntry = { workspace: RemoteWorkspace; connectionId: string };
      const results = await Promise.all(
        reconnectList.map(async workspace => {
          // Upgrade-only restore of pre-ID SSH workspace cache entries.
          const openedRecord = resolveLegacySessionWorkspace({
            workspaceId: workspace.workspaceId, workspacePath: workspace.remotePath,
            remoteConnectionId: workspace.connectionId, remoteSshHost: workspace.sshHost,
          }, openedRemote);

          const alreadyConnected = await sshApi.isConnected(workspace.connectionId).catch(() => false);

          if (alreadyConnected) {
            log.info('Remote workspace already connected', { connectionId: workspace.connectionId });
            await sshApi.openWorkspace(workspace.connectionId, workspace.remotePath).catch(() => {});
            setWorkspaceStatus(workspace.connectionId, 'connected');
            refreshRemoteAcpCapabilities(workspace.connectionId);

            const record = openedRecord ?? await workspaceManager.openRemoteWorkspace(workspace);
            workspace.workspaceId = record.id;
            void flowChatStore.initializeFromDisk(record.id, 'ssh_remote_auto_restore_existing').catch(() => {});

            return { ok: true as const, connected: { workspace, connectionId: workspace.connectionId } };
          }

          if (missingSavedConnections.has(workspace.connectionId)) {
            log.info('Deferring remote workspace restore because its saved connection is unavailable', {
              connectionId: workspace.connectionId,
              remotePath: workspace.remotePath,
            });
            setWorkspaceStatus(workspace.connectionId, 'error');
            reportRemoteWorkspaceRestoreDeferred(workspace, 'missing-connection');
            return { ok: false as const };
          }

          if (skipPasswordAutoReconnect.has(workspace.connectionId)) {
            log.info('Deferring auto-reconnect: password auth but no stored password', {
              connectionId: workspace.connectionId,
            });
            setWorkspaceStatus(workspace.connectionId, 'error');
            reportRemoteWorkspaceRestoreDeferred(workspace, 'missing-password');
            return { ok: false as const };
          }

          log.info('Remote workspace disconnected, attempting auto-reconnect', {
            connectionId: workspace.connectionId,
            remotePath: workspace.remotePath,
          });
          setWorkspaceStatuses(prev => ({ ...prev, [workspace.connectionId]: 'connecting' }));
          const result = await tryReconnectWithRetry(workspace);

          if (result !== false) {
            log.info('Reconnection successful', { newConnectionId: result.connectionId });
            setWorkspaceStatus(result.workspace.connectionId, 'connected');
            refreshRemoteAcpCapabilities(result.connectionId);

            const record = openedRecord ?? await workspaceManager.openRemoteWorkspace(result.workspace);
            result.workspace.workspaceId = record.id;
            void flowChatStore.initializeFromDisk(record.id, 'ssh_remote_auto_restore_reconnected').catch(() => {});

            return {
              ok: true as const,
              connected: { workspace: result.workspace, connectionId: result.connectionId },
            };
          }

          const savedConn = savedConnectionsList.find(c => c.id === workspace.connectionId);
          log.warn('Auto-reconnect failed', {
            connectionId: workspace.connectionId,
            auth: savedConn?.authType.type,
          });
          setWorkspaceStatus(workspace.connectionId, 'error');
          reportRemoteWorkspaceReconnectFailure(workspace);
          return { ok: false as const };
        })
      );

      const connectedEntries: ConnectedEntry[] = results
        .filter((r): r is { ok: true; connected: ConnectedEntry } => r.ok)
        .map(r => r.connected);

      const chosen = pickGlobalRemoteAfterReconnect(connectedEntries, reconnectList);
      if (chosen) {
        setIsConnected(true);
        setConnectionId(chosen.connectionId);
        setRemoteWorkspace(chosen.workspace);
        startHeartbeatRef.current(chosen.connectionId);
      }
    } catch (e) {
      log.error('checkRemoteWorkspace failed', e);
    } finally {
      checkRemoteWorkspaceInFlightRef.current = false;
    }
  }, [
    reportRemoteWorkspaceReconnectFailure,
    reportRemoteWorkspaceRestoreDeferred,
    setWorkspaceStatus,
    tryReconnectWithRetry,
  ]);
  checkRemoteWorkspaceRef.current = checkRemoteWorkspace;

  // Wait for workspace manager to finish loading, then check remote workspaces
  useEffect(() => {
    const state = workspaceManager.getState();
    if (!state.loading) {
      void checkRemoteWorkspace();
      return;
    }

    const unsubscribe = workspaceManager.addEventListener(event => {
      if (event.type === 'workspace:loading' && !event.loading) {
        unsubscribe();
        void checkRemoteWorkspace();
      }
    });

    return unsubscribe;
  }, [checkRemoteWorkspace]);

  // Pause controller SSH heartbeats / reconnect while Peer Device Mode is active.
  useEffect(() => {
    const onPeerModeChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      if (detail?.active === true) {
        if (heartbeatInterval.current) {
          clearInterval(heartbeatInterval.current);
          heartbeatInterval.current = null;
        }
        // Cancel pending controller-side reconnect timeouts; the peer owns the
        // SSH lifecycle now, so these must never fire their removal path.
        for (const timeoutId of workspaceStatusTimeouts.current.values()) {
          window.clearTimeout(timeoutId);
        }
        workspaceStatusTimeouts.current.clear();
        log.info('Paused SSH heartbeat while peer device mode is active');
      }
    };
    window.addEventListener('peer-mode:changed', onPeerModeChanged);
    return () => window.removeEventListener('peer-mode:changed', onPeerModeChanged);
  }, []);

  useEffect(() => {
    return workspaceManager.addEventListener(event => {
      const workspace =
        'workspace' in event && event.workspace?.workspaceKind === WorkspaceKind.Remote
          ? event.workspace
          : null;
      if (!workspace) {
        return;
      }
      const connId = workspace.connectionId?.trim();
      if (!connId) {
        return;
      }
      if (isPeerDeviceModeActive()) {
        // Peer Device Mode: the peer owns the SSH connection lifecycle. Mirror
        // its opened remote workspaces as connected and never run the
        // controller-side reconnect/timeout removal path — those invokes route
        // to the peer and would delete the peer's workspace.
        if (workspaceStatusesRef.current[connId] !== 'connected') {
          setWorkspaceStatus(connId, 'connected');
        }
        return;
      }
      if (!workspaceStatusesRef.current[connId]) {
        setWorkspaceStatus(connId, 'connecting');
      }
      void checkRemoteWorkspaceRef.current();
    });
  }, [setWorkspaceStatus]);

  const connect = useCallback(async (
    _connId: string,
    config: SSHConnectionConfig,
    options?: { browseAfterConnect?: boolean }
  ) => {
    log.debug('SSH connect called', { host: config.host });
    setStatus('connecting');
    setIsConnecting(true);
    setConnectionError(null);
    setError(null);

    try {
      const result = await sshApi.connect(config);
      log.debug('SSH connect result', { success: result.success, connectionId: result.connectionId, error: result.error });

      if (result.success && result.connectionId) {
        log.info('SSH connection successful', { connectionId: result.connectionId });
        refreshRemoteAcpCapabilities(result.connectionId);
        let home = result.serverInfo?.homeDir?.trim();
        if (!home && result.connectionId) {
          try {
            const info = await sshApi.getServerInfo(result.connectionId);
            home = info?.homeDir?.trim();
          } catch {
            /* non-desktop or probe skipped */
          }
        }
        const activeRemoteWorkspace = getActiveRemoteWorkspaceForConnection(result.connectionId);
        const homePath =
          home && home.length > 0 ? normalizeRemoteWorkspacePath(home) : '/tmp';

        if (options?.browseAfterConnect) {
          if (activeRemoteWorkspace) {
            setRemoteWorkspace(activeRemoteWorkspace);
            setWorkspaceStatus(result.connectionId, 'connected');
          } else {
            setRemoteWorkspace(null);
          }
          setRemoteFileBrowserInitialPath(homePath);
          setShowFileBrowser(true);
        } else if (activeRemoteWorkspace) {
          try {
            await sshApi.openWorkspace(result.connectionId, activeRemoteWorkspace.remotePath);
            setRemoteWorkspace(activeRemoteWorkspace);
            setRemoteFileBrowserInitialPath(activeRemoteWorkspace.remotePath);
            setWorkspaceStatus(result.connectionId, 'connected');
            setShowFileBrowser(false);
          } catch (error) {
            log.warn('Failed to reactivate active remote workspace after connect', {
              connectionId: result.connectionId,
              remotePath: activeRemoteWorkspace.remotePath,
              error,
            });
            setRemoteWorkspace(null);
            setRemoteFileBrowserInitialPath(homePath);
            setShowFileBrowser(true);
          }
        } else {
          setRemoteWorkspace(null);
          setRemoteFileBrowserInitialPath(homePath);
          setShowFileBrowser(true);
        }
        setStatus('connected');
        setIsConnected(true);
        setConnectionId(result.connectionId);
        setConnectionConfig(config);
        setShowConnectionDialog(false);
        startHeartbeat(result.connectionId);
      } else {
        log.warn('SSH connection failed', { error: result.error });
        setStatus('error');
        const errorMsg = result.error || 'Connection failed';
        setConnectionError(errorMsg);
        throw new Error(errorMsg);
      }
    } catch (e) {
      log.error('SSH connection exception', e);
      if (e instanceof Error) {
        setStatus('error');
        setConnectionError(e.message);
        throw e;
      }
      const errorMsg = e instanceof Error ? e.message : 'Connection failed';
      setStatus('error');
      setConnectionError(errorMsg);
      throw new Error(errorMsg);
    } finally {
      setIsConnecting(false);
    }
  }, [setWorkspaceStatus, startHeartbeat]);

  const disconnect = useCallback(async () => {
    const currentRemoteWorkspace = remoteWorkspace;
    const currentConnectionId = connectionId;

    if (heartbeatInterval.current) {
      clearInterval(heartbeatInterval.current);
      heartbeatInterval.current = null;
    }

    if (currentConnectionId) {
      try {
        await sshApi.disconnect(currentConnectionId);
      } catch {
        // Ignore disconnect errors
      }
    }
    setStatus('disconnected');
    setConnectionId(null);
    setConnectionConfig(null);
    setRemoteWorkspace(null);
    setIsConnected(false);
    setShowFileBrowser(false);
    setRemoteFileBrowserInitialPath('/tmp');

    if (currentRemoteWorkspace) {
      setWorkspaceStatus(currentRemoteWorkspace.connectionId, 'disconnected');
      await removeRemoteWorkspaceRecord(currentRemoteWorkspace);
    }
  }, [connectionId, remoteWorkspace, setWorkspaceStatus]);

  const openWorkspace = useCallback(async (pingPath: string) => {
    if (!connectionId) {
      throw new Error('Not connected');
    }
    const connName = connectionConfig?.name || 'Remote';
    const remotePath = normalizeRemoteWorkspacePath(pingPath);
    await sshApi.openWorkspace(connectionId, remotePath);
    const remoteWs: RemoteWorkspace = {
      connectionId,
      connectionName: connName,
      remotePath,
      sshHost: connectionConfig?.host?.trim() || undefined,
    };
    setRemoteWorkspace(remoteWs);
    setShowFileBrowser(false);
    setWorkspaceStatus(connectionId, 'connected');

    const record = await workspaceManager.openRemoteWorkspace(remoteWs);
    // The opened record is the identity; keep it on the provider state so
    // close/disconnect can name the exact workspace instead of its connection.
    setRemoteWorkspace(current =>
      current && sameRemoteWorkspace(current, remoteWs) ? { ...current, workspaceId: record.id } : current
    );
  }, [connectionId, connectionConfig, setWorkspaceStatus]);

  const closeWorkspace = useCallback(async () => {
    const currentRemoteWorkspace = remoteWorkspace;

    try {
      await sshApi.closeWorkspace();
    } catch {
      // Ignore errors
    }
    setRemoteWorkspace(null);
    setShowFileBrowser(true);

    if (currentRemoteWorkspace) {
      setWorkspaceStatus(currentRemoteWorkspace.connectionId, 'disconnected');
      await removeRemoteWorkspaceRecord(currentRemoteWorkspace);
    }
  }, [remoteWorkspace, setWorkspaceStatus]);

  const clearError = useCallback(() => {
    setError(null);
    setConnectionError(null);
  }, []);

  const value: SSHContextValue = {
    status,
    isConnected,
    isConnecting,
    connectionId,
    connectionConfig,
    remoteWorkspace,
    connectionError,
    workspaceStatuses,
    showConnectionDialog,
    showFileBrowser,
    error,
    remoteFileBrowserInitialPath,
    connect,
    disconnect,
    openWorkspace,
    closeWorkspace,
    setShowConnectionDialog,
    setShowFileBrowser,
    clearError,
  };

  return <SSHContext.Provider value={value}>{children}</SSHContext.Provider>;
};

export default SSHRemoteProvider;
