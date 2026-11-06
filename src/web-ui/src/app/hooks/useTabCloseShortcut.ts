import { useRef } from 'react';
import { hasOverlayLayers } from '@openbitfun/ui';
import { useShortcut, type UseShortcutOptions } from '@/infrastructure/hooks/useShortcut';
import type { ShortcutScope } from '@/shared/types/shortcut';
import { isImeOwnedKeyboardEvent } from '@/shared/utils/ime';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('TabCloseShortcut');

/** Share the binding and interaction guards while each surface owns its close lifecycle. */
export function useTabCloseShortcut(
  scope: ShortcutScope,
  close: (event: KeyboardEvent) => void | Promise<unknown>,
  options: UseShortcutOptions = {},
): void {
  const pending = useRef(false);
  useShortcut('tab.close', {
    key: 'w', ctrl: true, scope, allowInInput: true, inheritInChildScopes: true,
  }, event => {
    // Still consume the shortcut while a dialog/IME owns interaction or a close
    // is pending; never let it fall through to closing a different tab/window.
    if (event.repeat || isImeOwnedKeyboardEvent(event) || hasOverlayLayers() || pending.current) return;
    pending.current = true;
    void (async () => {
      try {
        await close(event);
      } catch (error) {
        log.error('Failed to close tab', { scope, error });
      } finally {
        pending.current = false;
      }
    })();
  }, { priority: 10, description: 'keyboard.shortcuts.tab.close', ...options });
}
