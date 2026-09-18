/**
 * SSH Remote Feature - State Management Hook (Standalone version)
 * This is a simple state management hook without React Context
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { sshApi } from './sshApi';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import type { SSHConnectionConfig, RemoteWorkspace } from './types';
import { isRemoteWorkspace } from '@/shared/types/global-state';

export interface SSHState {
  isConnected: boolean;
  connectionId: string | null;
  connectionConfig: SSHConnectionConfig | null;
  remoteWorkspace: RemoteWorkspace | null;
  error: string | null;
  // UI state
  showConnectionDialog: boolean;
  showFileBrowser: boolean;
}

export function useSSHRemote() {
  const [state, setState] = useState<SSHState>({
    isConnected: false,
    connectionId: null,
    connectionConfig: null,
    remoteWorkspace: null,
    error: null,
    showConnectionDialog: false,
    showFileBrowser: false,
  });

  const { recentWorkspaces, switchWorkspace } = useWorkspaceContext();
  const previousWorkspaceRef = useRef<string | null>(null);

  const checkRemoteWorkspace = useCallback(async () => {
    try {
      const workspace = await sshApi.getWorkspaceInfo();
      if (workspace) {
        setState((prev) => ({
          ...prev,
          isConnected: true,
          remoteWorkspace: workspace,
        }));
      }
    } catch (_error) {
      // Ignore errors on initial check
    }
  }, []);

  // Check for existing remote workspace on mount
  useEffect(() => {
    void checkRemoteWorkspace();
  }, [checkRemoteWorkspace]);

  const connect = useCallback(
    async (connectionId: string, config: SSHConnectionConfig) => {
      setState((prev) => ({
        ...prev,
        isConnected: true,
        connectionId,
        connectionConfig: config,
        error: null,
      }));
    },
    []
  );

  const disconnect = useCallback(async () => {
    const hadRemoteConnection = state.isConnected && state.connectionId;

    if (state.connectionId) {
      try {
        await sshApi.disconnect(state.connectionId);
      } catch (_error) {
        // Ignore disconnect errors
      }
    }

    setState((prev) => ({
      ...prev,
      isConnected: false,
      connectionId: null,
      connectionConfig: null,
      remoteWorkspace: null,
    }));

    // Switch back to the most recent local workspace if we had a remote connection
    if (hadRemoteConnection) {
      try {
        // workspaceKind is the remote predicate; a path prefix is not.
        const localWorkspaces = recentWorkspaces.filter((w) => !isRemoteWorkspace(w));
        if (localWorkspaces.length > 0) {
          await switchWorkspace(localWorkspaces[0]);
        }
      } catch (_error) {
        // Ignore errors when switching workspaces
      }
    }
  }, [state.isConnected, state.connectionId, recentWorkspaces, switchWorkspace]);

  const openWorkspace = useCallback(
    async (remotePath: string) => {
      if (!state.connectionId) {
        throw new Error('Not connected');
      }

      // Save current workspace ID before switching to remote
      if (recentWorkspaces.length > 0) {
        previousWorkspaceRef.current = recentWorkspaces[0].id;
      }

      await sshApi.openWorkspace(state.connectionId, remotePath);
      const config = state.connectionConfig;
      setState((prev) => ({
        ...prev,
        remoteWorkspace: {
          connectionId: state.connectionId!,
          connectionName: config?.name || 'Remote',
          remotePath,
        },
        showFileBrowser: false,
      }));
    },
    [state.connectionId, state.connectionConfig, recentWorkspaces]
  );

  const closeWorkspace = useCallback(async () => {
    // Save previous workspace ID
    const prevWorkspaceId = previousWorkspaceRef.current;

    try {
      await sshApi.closeWorkspace();
    } catch (_error) {
      // Ignore errors
    }
    setState((prev) => ({
      ...prev,
      remoteWorkspace: null,
    }));

    // Switch back to previous local workspace if available
    if (prevWorkspaceId) {
      try {
        const targetWorkspace = recentWorkspaces.find((w) => w.id === prevWorkspaceId);
        if (targetWorkspace && !isRemoteWorkspace(targetWorkspace)) {
          await switchWorkspace(targetWorkspace);
        }
      } catch (_error) {
        // Ignore errors when switching workspaces
      }
    }
  }, [recentWorkspaces, switchWorkspace]);

  const setError = useCallback((error: string | null) => {
    setState((prev) => ({ ...prev, error }));
  }, []);

  const setShowConnectionDialog = useCallback((show: boolean) => {
    setState((prev) => ({ ...prev, showConnectionDialog: show }));
  }, []);

  const setShowFileBrowser = useCallback((show: boolean) => {
    setState((prev) => ({ ...prev, showFileBrowser: show }));
  }, []);

  return {
    ...state,
    connect,
    disconnect,
    openWorkspace,
    closeWorkspace,
    setError,
    setShowConnectionDialog,
    setShowFileBrowser,
  };
}

export default useSSHRemote;
