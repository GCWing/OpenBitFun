import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { configManager } from '../services/ConfigManager';

export const AUTO_SHOW_SELECTION_TOOLBAR_CONFIG_PATH = 'app.flow_chat.auto_show_selection_toolbar';
const log = createLogger('SelectionToolbarPreference');

/** Null means no trusted preference has loaded for the current device yet. */
export function useSelectionToolbarPreference() {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [snapshot, setSnapshot] = useState<{ epoch: number; enabled: boolean | null; error: Error | null }>({
    epoch: scope.epoch, enabled: null, error: null,
  });
  const requestId = useRef(0);
  const reload = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const value = await configManager.getOptionalConfig<boolean>(AUTO_SHOW_SELECTION_TOOLBAR_CONFIG_PATH);
      if (scope.isCurrent() && id === requestId.current) {
        setSnapshot({ epoch: scope.epoch, enabled: value !== false, error: null });
      }
    } catch (reason) {
      if (scope.isCurrent() && id === requestId.current) {
        log.warn('Failed to load selection toolbar preference', reason);
        setSnapshot({
          epoch: scope.epoch, enabled: null,
          error: reason instanceof Error ? reason : new Error(String(reason)),
        });
      }
    }
  }, [scope]);

  useEffect(() => {
    void reload();
    const unsubscribe = configManager.watch(AUTO_SHOW_SELECTION_TOOLBAR_CONFIG_PATH, () => void reload());
    return () => { requestId.current += 1; unsubscribe(); };
  }, [reload]);

  return snapshot.epoch === scope.epoch
    ? { enabled: snapshot.enabled, error: snapshot.error, reload }
    : { enabled: null, error: null, reload };
}
