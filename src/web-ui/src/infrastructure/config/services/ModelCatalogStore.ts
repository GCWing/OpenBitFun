import { aiApi, type AIModelCatalog } from '@/infrastructure/api/service-api/AIApi';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { configManager } from './ConfigManager';

const log = createLogger('ModelCatalogStore');
type Snapshot = { catalog: AIModelCatalog | null; status: 'loading' | 'ready' | 'error' };
const EMPTY: Snapshot = { catalog: null, status: 'loading' };

/** One catalog projection per device activation. Refreshes keep the last good
 * projection usable; a config/catalog event during a read schedules another
 * read so an older response cannot consume a newer invalidation.
 */
export function createModelCatalogStore() {
  let epoch = -1;
  let snapshot = EMPTY;
  let revision = 0;
  let pending: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const getSnapshot = () => epoch === getActiveSurfaceScope().epoch ? snapshot : EMPTY;

  const refresh = (): Promise<void> => {
    const scope = getActiveSurfaceScope();
    if (epoch !== scope.epoch) {
      epoch = scope.epoch;
      snapshot = EMPTY;
      pending = undefined;
    }
    revision += 1;
    if (pending) return pending;
    const read = async () => {
      do {
        const requestedRevision = revision;
        try {
          scope.assertCurrent('load model catalog');
          const catalog = await aiApi.getModelCatalog();
          if (!scope.isCurrent()) return;
          if (requestedRevision !== revision) continue;
          snapshot = { catalog, status: 'ready' };
        } catch (error) {
          if (!scope.isCurrent()) return;
          if (requestedRevision !== revision) continue;
          snapshot = { catalog: snapshot.catalog, status: snapshot.catalog ? 'ready' : 'error' };
          log.warn('Failed to refresh model catalog', { error });
        }
        notify();
        return;
      } while (scope.isCurrent());
    };
    // Publish the promise before calling any loader that can emit events.
    const promise = Promise.resolve().then(read).finally(() => {
      if (pending === promise) pending = undefined;
    });
    pending = promise;
    return promise;
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!stop) {
      const offCatalog = aiApi.onModelCatalogUpdated(() => { void refresh(); });
      const offConfig = configManager.onConfigChange(path => {
        if (!path || path === 'ai' || ['ai.models', 'ai.default_models'].some(
          owned => path === owned || path.startsWith(`${owned}.`),
        )) void refresh();
      });
      const offSurface = onSurfaceActivated(() => {
        void refresh();
        notify();
      });
      stop = () => { offCatalog(); offConfig(); offSurface(); };
      void refresh();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size) { stop?.(); stop = undefined; }
    };
  };
  return { subscribe, getSnapshot, refresh };
}

export const modelCatalogStore = createModelCatalogStore();
