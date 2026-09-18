import { useEffect, useState } from 'react';

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
  const [commands, setCommands] = useState<AcpAvailableCommand[]>([]);

  const sessionId = acpSession?.sessionId ?? null;
  const clientId = acpSession?.clientId ?? null;
  const workspaceId = acpSession?.workspaceId;
  const workspacePath = acpSession?.workspacePath;
  const remoteConnectionId = acpSession?.remoteConnectionId;
  const remoteSshHost = acpSession?.remoteSshHost;

  useEffect(() => {
    setCommands([]);
  }, [sessionId]);

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
        if (!cancelled) setCommands(list);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, clientId, workspaceId, workspacePath, remoteConnectionId, remoteSshHost]);

  useEffect(() => {
    if (!sessionId || !clientId) return;

    return ACPClientAPI.onAvailableCommandsUpdated((event) => {
      if (event.sessionId === sessionId && event.clientId === clientId) {
        setCommands(event.commands);
      }
    });
  }, [sessionId, clientId]);

  return { commands };
}
