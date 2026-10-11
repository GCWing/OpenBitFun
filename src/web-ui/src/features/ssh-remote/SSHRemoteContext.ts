import { createContext, useContext } from 'react';
import type { SSHConnectionConfig, RemoteWorkspace } from './types';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SSHContextValue {
  status: ConnectionStatus;
  isConnected: boolean;
  isConnecting: boolean;
  connectionId: string | null;
  connectionConfig: SSHConnectionConfig | null;
  remoteWorkspace: RemoteWorkspace | null;
  connectionError: string | null;
  workspaceStatuses: Record<string, ConnectionStatus>;
  showConnectionDialog: boolean;
  showFileBrowser: boolean;
  error: string | null;
  remoteFileBrowserInitialPath: string;
  connect: (
    connectionId: string,
    config: SSHConnectionConfig,
    options?: { browseAfterConnect?: boolean }
  ) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Resolves `false` when the user keeps an existing connection binding. */
  openWorkspace: (path: string) => Promise<boolean>;
  closeWorkspace: () => Promise<void>;
  setShowConnectionDialog: (show: boolean) => void;
  setShowFileBrowser: (show: boolean) => void;
  clearError: () => void;
}

export const SSHContext = createContext<SSHContextValue | null>(null);

export const useSSHRemoteContext = () => {
  const context = useContext(SSHContext);
  if (!context) {
    throw new Error('useSSHRemoteContext must be used within SSHRemoteProvider');
  }
  return context;
};
