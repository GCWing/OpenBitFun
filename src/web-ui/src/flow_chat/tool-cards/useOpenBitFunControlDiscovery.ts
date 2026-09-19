import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import type { ProductControlDiscoveryRequest } from '@/infrastructure/api/service-api/ProductControlAPI';
import type { FlowToolItem } from '../types/flow-chat';
import { ControlDiscoveryError, loadAllOpenBitFunControlResults } from './openBitFunControlDiscovery';
import type { OpenBitFunControlCardModel } from './openBitFunControlCardModel';

interface DiscoveryOrigin {
  source: FlowToolItem['toolResult'];
  toolId: string;
  surfaceId: string;
  request: ProductControlDiscoveryRequest | undefined;
}

interface DiscoveryState {
  origin: DiscoveryOrigin;
  phase: 'loading' | 'loaded' | 'error';
  items?: Record<string, unknown>[];
  error?: 'catalog-changed' | 'load-failed';
}

export function useOpenBitFunControlDiscovery(toolItem: FlowToolItem, model: OpenBitFunControlCardModel, expanded: boolean) {
  const surface = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const source = toolItem.toolResult;
  const [state, setState] = useState<DiscoveryState>();
  const [attempt, setAttempt] = useState(0);
  const request = useMemo<ProductControlDiscoveryRequest | undefined>(() => {
    if (model.action === 'list') return { action: 'list', ...(model.query ? { query: model.query } : {}) };
    if (model.action === 'search' && model.query) return { action: 'search', query: model.query };
    return undefined;
  }, [model.action, model.query]);
  // A device activation alone must never rebind an existing result to another host.
  const origin = useMemo(() => ({ source, toolId: toolItem.id, request, surfaceId: getActiveSurfaceScope().surfaceId }), [source, toolItem.id, request]);
  const needsAll = Boolean(request && model.confirmed && (model.hasMore
    || typeof model.result.cursor === 'number' && model.result.cursor > 0
    || model.totalCount !== undefined && model.totalCount > model.items.length));
  const active = state?.origin === origin ? state : undefined;
  const loaded = active?.phase === 'loaded';
  const onOriginSurface = surface.surfaceId === origin.surfaceId;

  useEffect(() => {
    if (!expanded || !needsAll || !request || loaded || !onOriginSurface) return;
    const controller = new AbortController();
    setState({ origin, phase: 'loading' });
    void loadAllOpenBitFunControlResults(request, model.result, surface, controller.signal)
      .then(items => {
        if (!controller.signal.aborted && surface.isCurrent()) {
          setState({ origin, phase: 'loaded', items });
        }
      })
      .catch(error => {
        if (!controller.signal.aborted && surface.isCurrent()) {
          setState({ origin, phase: 'error',
            error: error instanceof ControlDiscoveryError && error.code === 'catalog-changed' ? 'catalog-changed' : 'load-failed' });
        }
      });
    return () => controller.abort();
  }, [expanded, needsAll, request, loaded, onOriginSurface, origin, model.result, surface, attempt]);

  return {
    items: onOriginSurface && loaded ? active.items! : model.items,
    loading: expanded && needsAll && onOriginSurface && !loaded && active?.phase !== 'error',
    error: needsAll && !onOriginSurface ? 'surface-changed' as const : active?.error,
    retry: () => setAttempt(value => value + 1),
  };
}
