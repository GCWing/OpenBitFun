import { InvalidationSync } from '../../../shared/relay-transport/InvalidationSync';
import { HOST_CATALOG_ID, type HostStreamOptions, type SessionStreamHandle } from '../../../shared/relay-transport/HostStream';

export interface HostCatalogSource {
  subscribeSessionStream(
    id: string,
    callbacks: Pick<HostStreamOptions, 'onEvent' | 'onError' | 'onCaughtUp' | 'onResumed' | 'onGap'>,
  ): Promise<SessionStreamHandle>;
  /** Relay reconnects, page resume, browser online and host-online changes. */
  onRecoverySignal?(listener: () => void): () => void;
}

const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30000;

/** One observer per selected runtime; revisions are invalidations, not clocks.
 *
 * A failed subscribe is retried with backoff, and at once on a recovery
 * signal; a reader whose reads keep failing is replaced on the same signals.
 * `onHealthy` reports every completed catch-up so callers can clear the error
 * they showed for this subscription. */
export function subscribeHostCatalog(
  source: HostCatalogSource,
  read: () => Promise<void>,
  onError: (error: unknown) => void,
  onHealthy?: () => void,
) {
  let stopped = false;
  let stream: SessionStreamHandle | undefined;
  let dirty = true;
  let connecting = false;
  let stalled = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_INITIAL_MS;
  const sync = new InvalidationSync(read);
  const fail = (error: unknown) => { if (!stopped) onError(error); };
  const clearRetry = () => { if (retry !== null) { clearTimeout(retry); retry = null; } };
  const refresh = () => {
    connect();
    return sync.invalidate().catch(fail);
  };
  const scheduleRetry = () => {
    if (stopped || retry !== null) return;
    retry = setTimeout(() => { retry = null; connect(); }, retryDelay);
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  };
  const connect = () => {
    if (stopped || connecting || stream) return;
    clearRetry();
    connecting = true;
    void source.subscribeSessionStream(HOST_CATALOG_ID, {
      onEvent: (event) => { if (!stopped && event.event === 'host-catalog-changed') dirty = true; },
      onError: (error) => { if (!stopped) { stalled = true; fail(error); } },
      onCaughtUp: () => {
        if (stopped) return;
        stalled = false;
        retryDelay = RETRY_INITIAL_MS;
        onHealthy?.();
        if (!dirty) return;
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
    }).catch((error) => {
      fail(error);
      scheduleRetry();
    }).finally(() => { connecting = false; });
  };
  const recover = () => {
    if (stopped || connecting) return;
    if (stream && !stalled) return;
    clearRetry();
    retryDelay = RETRY_INITIAL_MS;
    if (stream) { stream.close(); stream = undefined; }
    stalled = false;
    // Whatever changed while the reader was down is read again.
    dirty = true;
    connect();
  };
  const stopSignals = source.onRecoverySignal?.(recover) ?? (() => {});
  connect();
  return {
    refresh,
    close() { stopped = true; dirty = false; clearRetry(); stopSignals(); sync.stop(); stream?.close(); },
  };
}
