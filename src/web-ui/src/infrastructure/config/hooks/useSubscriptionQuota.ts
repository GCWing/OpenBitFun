import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { aiApi, type SubscriptionQuotaSnapshot } from '@/infrastructure/api/service-api/AIApi';
import { isNotAvailableError } from '@/infrastructure/api/errors/TauriCommandError';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import type { SubscriptionProvider } from '../types';

interface Observation {
  key: string;
  loading: boolean;
  value: SubscriptionQuotaSnapshot | null;
  failed: boolean;
  unsupportedHost: boolean;
}

/** Host/activation/account-scoped observations; never reuse a controller's balance on a peer. */
export function useSubscriptionQuota(provider: SubscriptionProvider, accountId: string, active: boolean, supported: boolean, identity: string, refreshVersion = 0, modelId?: string) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const key = scope.key('subscription-quota', provider, accountId, identity);
  const [observation, setObservation] = useState<Observation>({ key, loading: false, value: null, failed: false, unsupportedHost: !supported });
  const generation = useRef(0);
  const pending = useRef(false);
  const last = useRef<SubscriptionQuotaSnapshot | null>(null);
  const load = useCallback(async (force = false) => {
    if (!active || !supported || !scope.isCurrent() || pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setObservation(previous => ({ key, value: previous.key === key ? previous.value : null, loading: true, failed: false, unsupportedHost: false }));
    try {
      const value = modelId ? await aiApi.getModelProviderQuota(modelId) : await aiApi.getSubscriptionAccountQuota(provider, accountId, force);
      if (!scope.isCurrent() || request !== generation.current) return;
      if (value.account_id !== accountId || value.provider !== provider) throw new Error('Quota account identity did not match the requested account');
      last.current = value;
      setObservation(previous => ({ key, loading: false,
        value: value.state === 'query_failed' && previous.key === key && previous.value
          ? { ...previous.value, state: value.state, error: value.error } : value,
        failed: value.state === 'query_failed', unsupportedHost: false }));
    } catch (error) {
      if (!scope.isCurrent() || request !== generation.current) return;
      setObservation(previous => ({ key, loading: false, value: previous.key === key ? previous.value : null, failed: true, unsupportedHost: isNotAvailableError(error) }));
    } finally {
      if (request === generation.current) pending.current = false;
    }
  }, [active, supported, scope, key, provider, accountId, modelId]);

  useEffect(() => {
    last.current = null;
    pending.current = false;
    if (active && supported) void load(refreshVersion > 0);
    return () => { generation.current += 1; pending.current = false; };
  }, [active, supported, load, refreshVersion]);

  useEffect(() => {
    if (!active || !supported) return;
    const refreshVisible = () => {
      if (document.visibilityState !== 'hidden' && last.current?.state !== 'unsupported') void load();
    };
    const timer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [active, supported, load]);

  const current = observation.key === key ? observation : { key, loading: active && supported, value: null, failed: false, unsupportedHost: !supported };
  return { ...current, unsupportedHost: !supported || current.unsupportedHost, refresh: () => load(true) };
}
