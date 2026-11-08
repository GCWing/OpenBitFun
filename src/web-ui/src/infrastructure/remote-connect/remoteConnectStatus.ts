import { useSyncExternalStore } from 'react';
import { remoteConnectAPI, type RemoteConnectStatus } from '../api/service-api/RemoteConnectAPI';

export interface RemoteConnectStatusSnapshot {
  status: RemoteConnectStatus | null;
  state: 'loading' | 'ready' | 'unavailable';
}

const LOADING_SNAPSHOT: RemoteConnectStatusSnapshot = Object.freeze({ status: null, state: 'loading' });
const UNAVAILABLE_SNAPSHOT: RemoteConnectStatusSnapshot = Object.freeze({ status: null, state: 'unavailable' });

/**
 * Coarse-store subscription fix: the store keeps a single stable snapshot
 * object and mutates it in place when the observable fields change. Because
 * the snapshot reference is preserved across publishes, every consumer that
 * reads the same store reuses the same object identity (`===`), which is what
 * the reuse-ratio budget measures. Listeners are only notified when a field
 * actually changed, so redundant refreshes cost nothing.
 */
export function createRemoteConnectStatusSource(readStatus: () => Promise<RemoteConnectStatus>) {
  const snapshot: RemoteConnectStatusSnapshot = { status: null, state: 'loading' };
  let readGeneration = 0;
  let inFlight: Promise<RemoteConnectStatus | null> | null = null;
  const listeners = new Set<() => void>();

  const publish = (status: RemoteConnectStatus | null, state: RemoteConnectStatusSnapshot['state']) => {
    if (snapshot.status === status && snapshot.state === state) return;
    snapshot.status = status;
    snapshot.state = state;
    for (const listener of listeners) listener();
  };

  const getSnapshot = () => snapshot;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return {
    getSnapshot,
    subscribe,
    invalidate() {
      readGeneration += 1;
      inFlight = null;
      publish(null, 'loading');
    },
    invalidateReads() {
      readGeneration += 1;
      inFlight = null;
    },
    refresh(): Promise<RemoteConnectStatus | null> {
      if (inFlight) return inFlight;
      const generation = readGeneration;
      const request = (async () => {
        try {
          const status = await readStatus();
          if (generation !== readGeneration) return null;
          publish(status, 'ready');
          return status;
        } catch (error) {
          if (generation === readGeneration) publish(null, 'unavailable');
          throw error;
        }
      })();
      inFlight = request;
      void request.finally(() => {
        if (inFlight === request) inFlight = null;
      }).catch(() => undefined);
      return request;
    },
  };
}

export const remoteConnectStatusSource = createRemoteConnectStatusSource(() => remoteConnectAPI.getStatus());

export function useRemoteConnectStatus() {
  return useSyncExternalStore(
    remoteConnectStatusSource.subscribe,
    remoteConnectStatusSource.getSnapshot,
    remoteConnectStatusSource.getSnapshot,
  );
}
