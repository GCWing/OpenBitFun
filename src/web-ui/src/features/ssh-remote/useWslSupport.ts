import { useEffect, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { sshApi } from './sshApi';
import { workspaceSourceErrorKey } from './workspaceSourceError';

type WslSupport = 'checking' | 'supported' | 'unsupported' | 'unavailable';

/** Probe the active runtime through the transport; the controller OS is irrelevant. */
export function useWslSupport(enabled: boolean) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [result, setResult] = useState<{ scope: typeof scope; status: WslSupport }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setResult({ scope, status: 'checking' });
    void sshApi.listWslDistributions().then(data => {
      if (!cancelled && scope.isCurrent()) setResult({ scope, status: data.supported ? 'supported' : 'unsupported' });
    }).catch(error => {
      if (!cancelled && scope.isCurrent()) setResult({ scope, status:
        workspaceSourceErrorKey('wsl', error) === 'ssh.remote.wslUnsupported' ? 'unsupported' : 'unavailable' });
    });
    return () => { cancelled = true; };
  }, [enabled, scope, attempt]);
  return { status: enabled && result?.scope === scope ? result.status : 'checking' as WslSupport,
    retry: () => setAttempt(value => value + 1) };
}
