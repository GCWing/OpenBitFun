import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionDiscoveryDiagnostic, SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceId, getActiveSurfaceScope, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { createLogger } from '@/shared/utils/logger';
import { EXTERNAL_SESSION_NAMES, isExternalSessionEcosystem } from '@/shared/types/external-session';

const log = createLogger('WorkspaceSessionDiscovery');
interface DiscoveryState {
  pending: boolean;
  warnings: string[];
  diagnostics: SessionDiscoveryDiagnostic[];
}

const DISCOVERY_CONFIG_PATH = 'app.external_session_discovery';

function parseEnabledSources(value: unknown): ReadonlySet<string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const settings = value as Record<string, unknown>;
  return new Set(Object.keys(EXTERNAL_SESSION_NAMES).filter(source => settings[source] === true));
}

/** Watches only host-advertised in-progress work. Imports remain on the host
 * when this observer is hidden, unmounted, disconnected or switched to a peer. */
export function useWorkspaceSessionDiscovery(
  workspaceIds: readonly string[],
  visible: boolean,
  onCompleted: (workspaceId: string, page: SessionMetadataPage) => void,
) {
  const [states, setStates] = useState<Record<string, DiscoveryState>>({});
  const statesRef = useRef(states);
  const [failed, setFailed] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [enabledSources, setEnabledSources] = useState<ReadonlySet<string>>();
  const enabledSourcesRef = useRef<ReadonlySet<string>>();
  const settingsRequestRef = useRef(0);
  const scopeKey = JSON.stringify(workspaceIds);
  const scopedWorkspaceIds = useMemo(() => JSON.parse(scopeKey) as string[], [scopeKey]);
  const surfaceId = getActiveSurfaceId();
  const publishEnabledSources = useCallback((next: ReadonlySet<string> | undefined) => {
    enabledSourcesRef.current = next;
    setEnabledSources(next);
  }, []);
  const loadEnabledSources = useCallback(() => {
    const request = ++settingsRequestRef.current;
    const scope = getActiveSurfaceScope();
    void configManager.getOptionalConfig<Record<string, boolean>>(DISCOVERY_CONFIG_PATH)
      .then(settings => {
        if (request !== settingsRequestRef.current || !scope.isCurrent()) return;
        publishEnabledSources(parseEnabledSources(settings));
      })
      .catch(() => {
        if (request === settingsRequestRef.current && scope.isCurrent()) publishEnabledSources(undefined);
      });
  }, [publishEnabledSources]);
  const observe = useCallback((workspaceId: string, page: SessionMetadataPage, refresh = false) => {
    const key = surfaceScopedKey(surfaceId, workspaceId);
    const next = {
      pending: page.discoveryPending === true,
      warnings: page.discoveryWarnings ?? [],
      diagnostics: page.discoveryDiagnostics ?? [],
    };
    const previous = statesRef.current[key];
    if (previous?.pending !== next.pending
      || JSON.stringify(previous.warnings) !== JSON.stringify(next.warnings)
      || JSON.stringify(previous.diagnostics) !== JSON.stringify(next.diagnostics)) {
      statesRef.current = { ...statesRef.current, [key]: next };
      setStates(statesRef.current);
    }
    // Any metadata read may observe completion before the polling request does.
    // Reload from the first cursor so imports inserted ahead of a running page
    // traversal cannot be omitted from a source filter or aggregate projection.
    if (!next.pending && (previous?.pending || refresh)) onCompleted(workspaceId, page);
  }, [onCompleted, surfaceId]);
  const pendingKey = JSON.stringify(workspaceIds.filter(id => states[surfaceScopedKey(surfaceId, id)]?.pending));
  const warnings = useMemo(() => [...new Set(scopedWorkspaceIds.flatMap(id => states[surfaceScopedKey(surfaceId, id)]?.warnings ?? []))], [states, scopedWorkspaceIds, surfaceId]);
  const diagnostics = useMemo(() => {
    const unique = new Map<string, SessionDiscoveryDiagnostic>();
    for (const id of scopedWorkspaceIds) {
      for (const diagnostic of states[surfaceScopedKey(surfaceId, id)]?.diagnostics ?? []) {
        unique.set(`${diagnostic.ecosystemId}:${diagnostic.code}`, diagnostic);
      }
    }
    return [...unique.values()].sort((left, right) => (
      left.ecosystemId.localeCompare(right.ecosystemId) || left.code.localeCompare(right.code)
    ));
  }, [scopedWorkspaceIds, states, surfaceId]);

  useEffect(() => {
    publishEnabledSources(undefined);
    loadEnabledSources();
    return () => { settingsRequestRef.current += 1; };
  }, [loadEnabledSources, publishEnabledSources, surfaceId]);

  useEffect(() => configManager.onConfigChange((path, _oldValue, newValue) => {
    if (path === 'app' || path === DISCOVERY_CONFIG_PATH || path.startsWith(`${DISCOVERY_CONFIG_PATH}.`)) {
      setSettingsVersion(version => version + 1);
      const source = path.slice(`${DISCOVERY_CONFIG_PATH}.`.length);
      const current = enabledSourcesRef.current;
      if (isExternalSessionEcosystem(source) && typeof newValue === 'boolean' && current !== undefined) {
        settingsRequestRef.current += 1;
        const next = new Set(current);
        if (newValue) next.add(source);
        else next.delete(source);
        publishEnabledSources(next);
      } else {
        loadEnabledSources();
      }
    }
  }), [loadEnabledSources, publishEnabledSources]);

  useEffect(() => {
    if (!settingsVersion || !visible || scopedWorkspaceIds.length === 0) return;
    const scope = getActiveSurfaceScope();
    let cancelled = false;
    const current = () => !cancelled && scope.isCurrent();
    // Saving the switch must wake already-mounted workspace rows. A completed
    // page from before the save cannot satisfy this read through the store cache.
    void Promise.allSettled(scopedWorkspaceIds.map(async workspaceId => {
      const page = await flowChatStore.loadSessionMetadataPage(workspaceId, 5, undefined, 'sessions_nav_discovery_settings', { fresh: true });
      if (current()) observe(workspaceId, page, true);
    })).then(results => {
      if (current() && results.some(result => result.status === 'rejected')) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [observe, retryVersion, scopedWorkspaceIds, settingsVersion, visible]);

  useEffect(() => {
    const pendingIds = JSON.parse(pendingKey) as string[];
    setFailed(false);
    if (!visible || pendingIds.length === 0) return;
    const scope = getActiveSurfaceScope();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !cancelled && scope.isCurrent();
    const refresh = async () => {
      if (!current()) return;
      const results = await Promise.allSettled(pendingIds.map(async workspaceId => {
        const page = await flowChatStore.loadSessionMetadataPage(workspaceId, 5, undefined, 'sessions_nav_discovery');
        if (!current()) return;
        observe(workspaceId, page);
      }));
      if (!current()) return;
      const errors = results.filter(result => result.status === 'rejected');
      if (errors.length) {
        log.warn('Failed to refresh external session discovery', { errors });
        setFailed(true);
        return;
      }
      timer = setTimeout(() => void refresh(), 1500);
    };
    timer = setTimeout(() => void refresh(), 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [observe, pendingKey, retryVersion, visible]);

  return {
    observe,
    pending: pendingKey !== '[]',
    warnings,
    diagnostics,
    enabledSources,
    failed,
    retry: () => setRetryVersion(value => value + 1),
  };
}
