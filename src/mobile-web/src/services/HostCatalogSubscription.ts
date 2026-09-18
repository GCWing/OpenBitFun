import { InvalidationSync } from '../../../shared/relay-transport/InvalidationSync';
import { HOST_CATALOG_ID, type HostStreamOptions, type SessionStreamHandle } from '../../../shared/relay-transport/HostStream';

export interface HostCatalogSource {
  subscribeSessionStream(
    id: string,
    callbacks: Pick<HostStreamOptions, 'onEvent' | 'onError' | 'onCaughtUp' | 'onResumed' | 'onGap'>,
  ): Promise<SessionStreamHandle>;
}

/** One observer per selected runtime; revisions are invalidations, not clocks. */
export function subscribeHostCatalog(
  source: HostCatalogSource,
  read: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  let stopped = false;
  let stream: SessionStreamHandle | undefined;
  let dirty = true;
  let connecting = false;
  const sync = new InvalidationSync(read);
  const fail = (error: unknown) => { if (!stopped) onError(error); };
  const refresh = () => {
    connect();
    return sync.invalidate().catch(fail);
  };
  const connect = () => {
    if (stopped || connecting || stream) return;
    connecting = true;
    void source.subscribeSessionStream(HOST_CATALOG_ID, {
      onEvent: (event) => { if (!stopped && event.event === 'host-catalog-changed') dirty = true; },
      onError: fail,
      onCaughtUp: () => {
        if (stopped || !dirty) return;
        dirty = false;
        void refresh();
      },
      onResumed: () => { if (!stopped) dirty = true; },
      // A host restart replays the catalog stream from scratch; the list is
      // re-read from the host rather than trusted from memory.
      onGap: () => { if (!stopped) dirty = true; },
    }).then((value) => {
      if (stopped) value.close();
      else stream = value;
    }).catch(fail).finally(() => { connecting = false; });
  };
  connect();
  return {
    refresh,
    close() { stopped = true; dirty = false; sync.stop(); stream?.close(); },
  };
}
