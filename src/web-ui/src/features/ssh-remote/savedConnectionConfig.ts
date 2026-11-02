import type { SavedConnection, SSHConnectionConfig } from './types';

/** Secrets stay in the host credential store; an empty password requests hydration. */
export function savedConnectionConfig(connection: SavedConnection): SSHConnectionConfig {
  const { authType, lastConnected: _lastConnected, ...config } = connection;
  return { ...config, auth: authType.type === 'Password' ? { type: 'Password', password: '' }
    : authType.type === 'KeyboardInteractive' ? { type: 'KeyboardInteractive', responses: [] } : authType };
}
