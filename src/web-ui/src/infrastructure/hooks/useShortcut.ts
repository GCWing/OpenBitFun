
import { useEffect, useRef } from 'react';
import { shortcutManager, type ShortcutCallback } from '@/infrastructure/services/ShortcutManager';
import type { ShortcutConfig } from '@/shared/types/shortcut';

export interface UseShortcutOptions {
  description?: string;
  priority?: number;
  /** Set to false to temporarily disable this shortcut without unregistering. */
  enabled?: boolean;
  /** Restrict this mounted handler to the event's owning surface. */
  when?: (event: KeyboardEvent) => boolean;
}

/**
 * Register a keyboard shortcut via ShortcutManager with automatic cleanup.
 *
 * Uses a stable ref pattern so that changes to `callback` never cause the
 * shortcut to be unregistered and re-registered — only changes to `id` or
 * `config` trigger a re-registration.
 *
 * @param id       Unique shortcut identifier (e.g. 'panel.toggleLeft')
 * @param config   Key + modifiers + scope config
 * @param callback Handler to invoke when the shortcut fires
 * @param options  Optional description, priority, enabled flag
 */
export function useShortcut(
  id: string,
  config: ShortcutConfig,
  callback: ShortcutCallback,
  options: UseShortcutOptions = {}
): void {
  const { description, priority, enabled = true } = options;
  const hasOwnerPredicate = Boolean(options.when);
  const owner = useRef(Symbol(id));
  const whenRef = useRef(options.when);
  whenRef.current = options.when;
  const stableWhen = useRef((event: KeyboardEvent) => whenRef.current?.(event) ?? true);

  // Keep the latest callback in a ref so changes don't trigger re-registration.
  const callbackRef = useRef<ShortcutCallback>(callback);
  callbackRef.current = callback;

  // Stable wrapper that delegates to the current callback ref.
  const stableCallback = useRef<ShortcutCallback>((e) => callbackRef.current(e));

  // Serialize config to a stable string for the dependency array.
  const configKey = JSON.stringify({
    key: config.key,
    ctrl: config.ctrl,
    shift: config.shift,
    alt: config.alt,
    meta: config.meta,
    scope: config.scope,
    allowInInput: config.allowInInput,
    inheritInChildScopes: config.inheritInChildScopes,
  });

  useEffect(() => {
    if (!enabled) return;

    const unregister = shortcutManager.register(id, config, stableCallback.current, {
      description,
      priority,
      owner: hasOwnerPredicate ? owner.current : undefined,
      when: stableWhen.current,
    });

    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, configKey, enabled, description, priority, hasOwnerPredicate]);
}
