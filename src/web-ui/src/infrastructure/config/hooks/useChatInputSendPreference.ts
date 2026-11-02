import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { createLogger } from '@/shared/utils/logger';
import { configManager } from '../services/ConfigManager';
import {
  getChatInputSendDuringTurn, normalizeChatInputSendDuringTurn,
  SEND_DURING_TURN_CONFIG_PATH, type ChatInputSendDuringTurn,
} from '../services/ChatInputSendPreference';

const log = createLogger('ChatInputSendPreference');

export function useChatInputSendPreference() {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [snapshot, setSnapshot] = useState<{
    epoch: number; behavior: ChatInputSendDuringTurn | null; error: Error | null;
  }>({
    epoch: scope.epoch,
    behavior: configManager.hasCachedConfig(SEND_DURING_TURN_CONFIG_PATH)
      ? normalizeChatInputSendDuringTurn(configManager.getCachedConfig(SEND_DURING_TURN_CONFIG_PATH)) : null,
    error: null,
  });
  const requestId = useRef(0);
  const reload = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const behavior = await getChatInputSendDuringTurn();
      if (scope.isCurrent() && id === requestId.current) {
        setSnapshot({ epoch: scope.epoch, behavior, error: null });
      }
    } catch (reason) {
      if (scope.isCurrent() && id === requestId.current) {
        log.warn('Failed to load chat input send preference', reason);
        setSnapshot({ epoch: scope.epoch, behavior: null,
          error: reason instanceof Error ? reason : new Error(String(reason)) });
      }
    }
  }, [scope]);

  useEffect(() => {
    void reload();
    const unsubscribe = configManager.watch(SEND_DURING_TURN_CONFIG_PATH, () => void reload());
    return () => { requestId.current += 1; unsubscribe(); };
  }, [reload]);

  return snapshot.epoch === scope.epoch
    ? { behavior: snapshot.behavior, error: snapshot.error, reload }
    : { behavior: null, error: null, reload };
}
