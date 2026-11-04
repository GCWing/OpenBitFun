import { useEffect, useState, useSyncExternalStore } from 'react';
import type { GenerativeWidgetProjection } from '@/flow_chat/utils/generativeWidgetProjection';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

const path = 'ai.generative_ui_library';

/** Settings are a loading hint only. Completed apps and declared stream identity
 * always own their profile; a controller must never use another device's hint. */
export function useGenUIPhoneLoading(projection: GenerativeWidgetProjection | null) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const needsHint = Boolean(projection?.isStreaming && !projection.libraryId
    && projection.origin.surfaceId === scope.surfaceId);
  const [snapshot, setSnapshot] = useState<{ epoch: number; value?: string }>();
  const cached = configManager.hasCachedConfig(path);
  const ready = cached || snapshot?.epoch === scope.epoch;
  const profile = cached ? configManager.getCachedConfig<string>(path) : snapshot?.epoch === scope.epoch ? snapshot.value : undefined;

  useEffect(() => {
    if (!needsHint) return;
    let active = true;
    let request = 0;
    const load = async () => {
      const id = ++request;
      try {
        const value = await configManager.getConfig<string>(path);
        if (active && scope.isCurrent() && id === request) setSnapshot({ epoch: scope.epoch, value });
      } catch {
        // ConfigManager reports read failures. Unknown settings cannot opt a
        // document into Harmony; native stream identity may still arrive.
        if (active && scope.isCurrent() && id === request) setSnapshot({ epoch: scope.epoch });
      }
    };
    if (!cached) void load();
    const unwatch = configManager.watch(path, () => void load());
    return () => { active = false; unwatch(); };
  }, [needsHint, scope, cached]);

  return {
    phone: Boolean(projection?.isStreaming && (
      projection.libraryId?.includes('.harmony.')
      || (needsHint && profile === 'harmony')
    )),
    pending: needsHint && !ready,
  };
}
