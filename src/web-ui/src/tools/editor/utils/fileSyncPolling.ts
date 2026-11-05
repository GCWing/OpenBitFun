import { isPeerDeviceModeActive, PEER_MODE_FILE_SYNC_POLL_MS } from '@/infrastructure/peer-device/peerModeFlag';

/** Keep direct workspace synchronization responsive, including SSH/container files. */
export function editorFileSyncPollInterval(): number {
  return isPeerDeviceModeActive() ? PEER_MODE_FILE_SYNC_POLL_MS : 1000;
}

export function startEditorFileSyncPolling(tick: () => void, offsetMs: number): () => void {
  let stopped = false;
  let timeoutId: number | undefined;
  let intervalId: number | undefined;
  const clearTimers = () => {
    window.clearTimeout(timeoutId);
    window.clearInterval(intervalId);
  };
  const schedule = (warmup: boolean) => {
    clearTimers();
    if (stopped || document.visibilityState !== 'visible') return;
    const startInterval = () => {
      if (!stopped) intervalId = window.setInterval(tick, editorFileSyncPollInterval() + offsetMs);
    };
    if (warmup) {
      timeoutId = window.setTimeout(() => {
        tick();
        startInterval();
      }, 250 + offsetMs);
    } else {
      startInterval();
    }
  };
  const onPeerModeChanged = () => schedule(false);
  const onFocus = () => {
    if (document.visibilityState === 'visible') tick();
  };
  const onVisibilityChanged = () => {
    onFocus();
    schedule(false);
  };
  schedule(true);
  window.addEventListener('peer-mode:changed', onPeerModeChanged);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibilityChanged);
  return () => {
    stopped = true;
    clearTimers();
    window.removeEventListener('peer-mode:changed', onPeerModeChanged);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChanged);
  };
}
