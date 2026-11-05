import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

import {
  ACPClientAPI,
  type AcpAvailableCommand,
} from '@/infrastructure/api/service-api/ACPClientAPI';
import type { AcpSessionRef } from '../utils/acpSession';

export function filterSlashCommands(
  commands: AcpAvailableCommand[],
  query: string,
): AcpAvailableCommand[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return commands;

  return commands.filter(
    (command) =>
      command.name.toLowerCase().includes(q) ||
      command.description.toLowerCase().includes(q),
  );
}

export function useAcpSlashCommands(
  acpSession: AcpSessionRef | null,
): { commands: AcpAvailableCommand[] } {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);

  const sessionId = acpSession?.sessionId ?? null;
  const clientId = acpSession?.clientId ?? null;
  const workspaceId = acpSession?.workspaceId;
  const workspacePath = acpSession?.workspacePath;
  const remoteConnectionId = acpSession?.remoteConnectionId;
  const remoteSshHost = acpSession?.remoteSshHost;
  const identity = scope.key(scope.epoch, sessionId, clientId, workspaceId, workspacePath, remoteConnectionId, remoteSshHost);
  const [snapshot, setSnapshot] = useState<{ identity: string; commands: AcpAvailableCommand[] }>({ identity, commands: [] });

  useEffect(() => {
    setSnapshot({ identity, commands: [] });
  }, [identity]);

  useEffect(() => {
    if (!sessionId || !clientId) return;

    let cancelled = false;
    ACPClientAPI.getSessionCommands({
      sessionId,
      clientId,
      workspaceId,
      workspacePath,
      remoteConnectionId,
      remoteSshHost,
    })
      .then((list) => {
        if (!cancelled && scope.isCurrent()) setSnapshot({ identity, commands: list });
      })
      .catch(() => {
        if (!cancelled && scope.isCurrent()) setSnapshot({ identity, commands: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, clientId, workspaceId, workspacePath, remoteConnectionId, remoteSshHost, identity, scope]);

  useEffect(() => {
    if (!sessionId || !clientId) return;

    return ACPClientAPI.onAvailableCommandsUpdated((event) => {
      if (scope.isCurrent() && event.sessionId === sessionId && event.clientId === clientId) {
        setSnapshot({ identity, commands: event.commands });
      }
    });
  }, [sessionId, clientId, identity, scope]);

  return { commands: snapshot.identity === identity ? snapshot.commands : [] };
}
