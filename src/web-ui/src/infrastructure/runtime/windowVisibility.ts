import { supportsNativeWindowControls } from './environment';

type Subscriber = { changed: (visible: boolean) => void; error: (error: unknown) => void };
type Observation = { visible: boolean; subscribers: Set<Subscriber>; dispose: () => void };
let observation: Observation | undefined;

function startObservation(state: Observation): () => void {
  let disposed = false;
  let revision = 0;
  let reading = false;
  let refreshNative: (() => void) | undefined;
  const unlisten: (() => void)[] = [];
  const publish = (visible: boolean) => {
    if (disposed || state.visible === visible) return;
    state.visible = visible;
    state.subscribers.forEach(subscriber => subscriber.changed(visible));
  };
  const reportError = (error: unknown) => {
    if (!disposed) state.subscribers.forEach(subscriber => subscriber.error(error));
  };
  const documentVisible = () => document.visibilityState !== 'hidden';
  const onDocumentVisibility = () => {
    if (!documentVisible()) publish(false);
    if (refreshNative) refreshNative();
    else if (!supportsNativeWindowControls()) publish(documentVisible());
  };
  document.addEventListener('visibilitychange', onDocumentVisibility);

  if (supportsNativeWindowControls()) {
    void (async () => {
      // Window state belongs to this controller even when product commands use a peer.
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      if (disposed) return;
      const nativeWindow = getCurrentWindow();
      refreshNative = () => {
        revision++;
        if (reading || disposed) return;
        reading = true;
        void (async () => {
          try {
            let readRevision: number;
            do {
              readRevision = revision;
              try {
                const [visible, minimized] = await Promise.all([
                  nativeWindow.isVisible(), nativeWindow.isMinimized(),
                ]);
                // A newer resize/focus event invalidates an in-flight snapshot.
                if (readRevision === revision) publish(visible && !minimized && documentVisible());
              } catch (error) {
                reportError(error);
              }
            } while (!disposed && readRevision !== revision);
          } finally {
            reading = false;
          }
        })();
      };
      // Native resize events still arrive when WebView2 retains its DOM bounds
      // and document.visibilityState stays 'visible' during minimization.
      for (const register of [
        () => nativeWindow.onResized(() => refreshNative?.()),
        () => nativeWindow.onFocusChanged(() => refreshNative?.()),
      ]) {
        const stop = await register();
        if (disposed) { stop(); return; }
        unlisten.push(stop);
      }
      refreshNative();
    })().catch(reportError);
  }

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onDocumentVisibility);
    unlisten.forEach(stop => stop());
  };
}

/** One event-driven native subscription shared by all cached browser panels. No polling. */
export function observeCurrentWindowVisibility(
  changed: Subscriber['changed'],
  error: Subscriber['error'],
): () => void {
  const existing = observation;
  const state = existing ?? {
    // Keep native child views hidden until the initial host snapshot is known.
    visible: !supportsNativeWindowControls() && document.visibilityState !== 'hidden',
    subscribers: new Set<Subscriber>(),
    dispose: () => {},
  };
  observation = state;
  const subscriber = { changed, error };
  state.subscribers.add(subscriber);
  changed(state.visible);
  if (!existing) state.dispose = startObservation(state);
  return () => {
    state.subscribers.delete(subscriber);
    if (state.subscribers.size === 0) {
      state.dispose();
      if (observation === state) observation = undefined;
    }
  };
}
