import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '@/shared/utils/logger';
import { isMacOSDesktopRuntime } from './environment';

export type NativeFullscreenPhase = 'entering' | 'fullscreen' | 'exiting' | 'windowed';
export interface NativeFullscreenChrome {
  phase: NativeFullscreenPhase;
  transitionId?: number;
  acknowledgePaint?: () => Promise<void>;
}

const log = createLogger('FullscreenChrome');
const handoffEvent = 'window://fullscreen-chrome-handoff';

/** Window-local presentation transport, independent of peer/session routing. */
export function subscribeNativeFullscreenChrome(
  onPhase: (chrome: NativeFullscreenChrome) => void,
): () => void {
  if (!isMacOSDesktopRuntime()) return () => {};
  const clientId = crypto.randomUUID();
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  void listen<NativeFullscreenPhase | {
    phase: NativeFullscreenPhase;
    transitionId: number;
    requiresAck: boolean;
  }>('window://fullscreen-chrome', ({ payload }) => {
    if (disposed) return;
    // Editable frontends can still be paired with an older desktop host.
    if (typeof payload === 'string') {
      onPhase({ phase: payload });
      return;
    }
    onPhase({
      phase: payload.phase,
      transitionId: payload.transitionId,
      acknowledgePaint: payload.requiresAck ? () => emitTo('main', handoffEvent, {
        kind: 'settled', clientId, transitionId: payload.transitionId,
      }) : undefined,
    });
  }).then(async stop => {
    if (disposed) { stop(); return; }
    unlisten = stop;
    // Negotiate only AFTER the callback is listening. Older hosts ignore this.
    await emitTo('main', handoffEvent, { kind: 'ready', clientId });
  }).catch(error => log.error('Failed to subscribe to native window chrome', { error }));

  return () => {
    disposed = true;
    unlisten?.();
    if (unlisten) {
      void emitTo('main', handoffEvent, { kind: 'unready', clientId })
        .catch(error => log.warn('Failed to release native window chrome', { error }));
    }
  };
}
