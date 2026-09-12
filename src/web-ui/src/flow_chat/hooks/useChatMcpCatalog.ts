import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChatMcpUnavailableError, getChatMcpCatalog,
  type ChatMcpCatalog, type ChatMcpCatalogRequest,
} from '@/infrastructure/api/service-api/ChatMcpAPI';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useChatMcpCatalog');
type Snapshot = {
  key: string;
  catalog?: ChatMcpCatalog;
  loading: boolean;
  failed: boolean;
  unavailable?: 'remoteWorkspace' | 'unsupportedHost';
};

export function useChatMcpCatalog({ enabled, surfaceEpoch, ...request }: ChatMcpCatalogRequest & {
  enabled: boolean;
  surfaceEpoch: number;
}) {
  const { modeId, workspacePath, remoteConnectionId } = request;
  const key = JSON.stringify([surfaceEpoch, modeId, workspacePath ?? null, remoteConnectionId ?? null]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const id = ++requestId.current;
    let cancelled = false;
    setSnapshot({ key, loading: true, failed: false });
    void getChatMcpCatalog({ modeId, workspacePath, remoteConnectionId })
      .then(catalog => {
        if (!cancelled && id === requestId.current) setSnapshot({ key, catalog, loading: false, failed: false });
      })
      .catch(error => {
        if (cancelled || id !== requestId.current) return;
        if (error instanceof ChatMcpUnavailableError) {
          setSnapshot({ key, loading: false, failed: false, unavailable: error.reason });
        } else {
          log.error('Failed to load MCP chat catalog', { error, modeId });
          setSnapshot({ key, loading: false, failed: true });
        }
      });
    return () => { cancelled = true; };
  }, [enabled, key, modeId, workspacePath, remoteConnectionId, revision]);

  const current = snapshot?.key === key && enabled ? snapshot : undefined;
  return {
    catalog: current?.catalog,
    loading: enabled && (current?.loading ?? true),
    failed: current?.failed ?? false,
    unavailable: current?.unavailable,
    refresh: useCallback(() => setRevision(value => value + 1), []),
  };
}
