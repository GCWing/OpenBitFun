import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionAPI, type SessionDiscoveryDiagnostic, type SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';
import { getActiveSurfaceId, getActiveSurfaceScope, surfaceScopedKey } from '@/infrastructure/peer-device/deviceSurface';
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

/** Refreshes sources once per reveal or settings change. Host-owned scans
 * survive view cancellation; completion is awaited without polling. */
export function useWorkspaceSessionDiscovery(
  workspaceIds: readonly string[],
  visible: boolean,
  onCompleted: (workspaceId: string, page: SessionMetadataPage) => void,
) {
  const [states, setStates] = useState<Record<string, DiscoveryState>>({});
  const statesRef = useRef(states);
  const [refreshFailures, setRefreshFailures] = useState<ReadonlySet<string>>(new Set());
  const [retryVersion, setRetryVersion] = useState(0);
  const [settingsVersions, setSettingsVersions] = useState<Record<string, number>>({});
  const appliedSettingsVersions = useRef(new Map<string, number>());
  const appliedRevealVersions = useRef(new Map<string, number>());
  const revealVersion = useRef(0);
  const observedCatalogs = useRef(new Map<string, SessionMetadataPage>());
  const [enabledSources, setEnabledSources] = useState<ReadonlySet<string>>();
  const enabledSourcesRef = useRef<ReadonlySet<string>>();
  const settingsRequestRef = useRef(0);
  const scopeKey = JSON.stringify(workspaceIds);
  const scopedWorkspaceIds = useMemo(() => JSON.parse(scopeKey) as string[], [scopeKey]);
  const surfaceId = getActiveSurfaceId();
  const surfaceEpoch = getActiveSurfaceScope().epoch;
  const settingsVersion = settingsVersions[surfaceId] ?? 0;
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
    observedCatalogs.current.set(surfaceScopedKey(surfaceId, surfaceEpoch, workspaceId), {
      ...page, sessions: [], activities: undefined,
    });
    const key = surfaceScopedKey(surfaceId, surfaceEpoch, workspaceId);
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
    // Any metadata read can observe a host scan completing.
    // Reload from the first cursor so imports inserted ahead of a running page
    // traversal cannot be omitted from a source filter or aggregate projection.
    if (!next.pending && (previous?.pending || refresh)) onCompleted(workspaceId, page);
  }, [onCompleted, surfaceEpoch, surfaceId]);
  const pendingKey = JSON.stringify(workspaceIds.filter(id => states[surfaceScopedKey(surfaceId, surfaceEpoch, id)]?.pending));
  const observedWorkspaceKey = JSON.stringify(scopedWorkspaceIds.filter(workspaceId => (
    observedCatalogs.current.has(surfaceScopedKey(surfaceId, surfaceEpoch, workspaceId))
  )));
  const observedWorkspaceIds = useMemo(() => JSON.parse(observedWorkspaceKey) as string[], [observedWorkspaceKey]);
  const warnings = useMemo(() => [...new Set(scopedWorkspaceIds.flatMap(id => states[surfaceScopedKey(surfaceId, surfaceEpoch, id)]?.warnings ?? []))], [states, scopedWorkspaceIds, surfaceEpoch, surfaceId]);
  const diagnostics = useMemo(() => {
    const unique = new Map<string, SessionDiscoveryDiagnostic>();
    for (const id of scopedWorkspaceIds) {
      for (const diagnostic of states[surfaceScopedKey(surfaceId, surfaceEpoch, id)]?.diagnostics ?? []) {
        unique.set(`${diagnostic.ecosystemId}:${diagnostic.code}`, diagnostic);
      }
    }
    return [...unique.values()].sort((left, right) => (
      left.ecosystemId.localeCompare(right.ecosystemId) || left.code.localeCompare(right.code)
    ));
  }, [scopedWorkspaceIds, states, surfaceEpoch, surfaceId]);

  useEffect(() => {
    publishEnabledSources(undefined);
    loadEnabledSources();
    return () => { settingsRequestRef.current += 1; };
  }, [loadEnabledSources, publishEnabledSources, surfaceEpoch, surfaceId]);

  useEffect(() => {
    const scope = getActiveSurfaceScope();
    return configManager.onConfigChange((path, _oldValue, newValue) => {
      if (!scope.isCurrent()) return;
      if (path === 'app' || path === DISCOVERY_CONFIG_PATH || path.startsWith(`${DISCOVERY_CONFIG_PATH}.`)) {
        setSettingsVersions(versions => ({ ...versions, [surfaceId]: (versions[surfaceId] ?? 0) + 1 }));
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
    });
  }, [loadEnabledSources, publishEnabledSources, surfaceEpoch, surfaceId]);

  useEffect(() => {
    if (visible) revealVersion.current += 1;
  }, [surfaceEpoch, visible]);

  useEffect(() => {
    if (!visible || enabledSources === undefined || !scopedWorkspaceIds.length) return;
    const scope = getActiveSurfaceScope();
    const reveal = revealVersion.current;
    const versionKey = (workspaceId: string) => surfaceScopedKey(surfaceId, surfaceEpoch, workspaceId);
    const targets = scopedWorkspaceIds.filter(workspaceId => {
      const key = versionKey(workspaceId);
      const previous = observedCatalogs.current.get(key);
      const settingsChanged = (appliedSettingsVersions.current.get(key) ?? 0) < settingsVersion;
      const revealed = enabledSources?.size && previous
        && (appliedRevealVersions.current.get(key) ?? 0) < reveal;
      return settingsChanged || revealed || previous?.discoveryPending;
    });
    if (!targets.length) return;
    let cancelled = false;
    const current = () => !cancelled && scope.isCurrent();
    setRefreshFailures(previous => {
      const next = new Set(previous);
      for (const workspaceId of targets) next.delete(versionKey(workspaceId));
      return next;
    });
    void Promise.allSettled(targets.map(async workspaceId => {
      const key = versionKey(workspaceId);
      const previous = observedCatalogs.current.get(key);
      const settingsChanged = (appliedSettingsVersions.current.get(key) ?? 0) < settingsVersion;
      // One reveal owns one request. The host waits for its scan using a
      // completion notification; neither progress nor new sessions are polled.
      const page = await sessionAPI.listSessionsPage({
        workspaceId, limit: 1, query: previous?.catalogQuery, refreshExternalDiscovery: true,
      });
      if (!current()) return;
      if (!page.discoveryRefreshed || page.discoveryPending) {
        throw new Error('This host does not support completing external session discovery in one request; update OpenBitFun on the host');
      }
      appliedSettingsVersions.current.set(key, settingsVersion);
      appliedRevealVersions.current.set(key, reveal);
      const changed = previous?.catalogRevision && page.catalogRevision
        ? previous.catalogRevision !== page.catalogRevision
        : previous !== undefined && previous.totalTopLevelCount !== page.totalTopLevelCount;
      observe(workspaceId, page, settingsChanged || previous?.discoveryPending === true || changed);
    })).then(results => {
      if (!current()) return;
      const failedKeys = targets.filter((_, index) => results[index].status === 'rejected').map(versionKey);
      if (failedKeys.length) {
        log.warn('Failed to refresh external session discovery', { workspaceIds: targets });
        setRefreshFailures(previous => new Set([...previous, ...failedKeys]));
      }
    });
    return () => { cancelled = true; };
  }, [enabledSources, observe, observedWorkspaceIds, pendingKey, retryVersion, scopedWorkspaceIds,
    settingsVersion, surfaceEpoch, surfaceId, visible]);

  return {
    observe,
    pending: pendingKey !== '[]',
    warnings,
    diagnostics,
    enabledSources,
    failed: scopedWorkspaceIds.some(workspaceId => (
      refreshFailures.has(surfaceScopedKey(surfaceId, surfaceEpoch, workspaceId))
    )),
    retry: () => setRetryVersion(value => value + 1),
  };
}
