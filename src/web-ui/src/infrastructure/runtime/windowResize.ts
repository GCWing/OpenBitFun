import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isMacOSDesktopRuntime } from './environment';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('WindowResize');

/** Controller-owned window geometry must never use the selected peer transport. */
export function subscribeNativeWindowResizeEnd(receive: () => void): () => void {
  if (!isMacOSDesktopRuntime()) return () => {};
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  void listen<{ version: number }>('window://resize-ended', ({ payload }) => {
    if (!disposed && payload?.version === 1) receive();
  }).then(stop => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch(error => log.warn('Native resize completion unavailable; using bounded layout batching', { error }));
  return () => { disposed = true; unlisten?.(); };
}
