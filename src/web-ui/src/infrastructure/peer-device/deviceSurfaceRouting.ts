/**
 * Device surface event routing.
 *
 * The controller re-emits Peer DeviceEvents under their original event name so
 * every existing listener keeps working. That is only safe while exactly one
 * device is producing product events. Once peers stay attached in the
 * background — so their work keeps running while the UI looks at another
 * device — the same bus carries several agent streams at once.
 *
 * The desktop controller therefore tags every re-emitted peer payload with the
 * device that produced it (`remote_connect_api::PEER_EVENT_SOURCE_KEY`), and
 * this module decides which of those streams the currently rendered surface is
 * allowed to see. Untagged events are local by definition.
 *
 * Only *surface-scoped* events are routed. Control-plane events (account
 * presence, login state, window chrome, updater, …) always pass through.
 */

/** Payload key injected by the controller. Keep in sync with the Rust const. */
export const PEER_EVENT_SOURCE_KEY = '__openbitfunSourceDeviceId';

/** Wrapper key used when a peer payload is not a JSON object. */
export const PEER_EVENT_WRAPPED_PAYLOAD_KEY = '__openbitfunSourcePayload';

/**
 * Product events that belong to one device surface. A superset of the desktop
 * fan-out allowlist (`should_fanout_peer_ui_event` in `remote_connect_api.rs`):
 * it also covers events a host fans out through direct
 * `fanout_peer_device_event` calls (for example `account://settings-applied`
 * and `session_title_generated`) and the projected `agentic://*` stream.
 * Adding a fanned-out event on the Rust side means adding it here too, or
 * local and peer streams interleave in one store.
 */
const SURFACE_SCOPED_EVENTS = new Set<string>([
  'terminal_event',
  'relay://session-gap',
  'relay://session-ready',
  'session-record',
  'session-state',
  'file-system-changed',
  'permission://event',
  'account://settings-applied',
  'ai://model-catalog-updated',
  'session_title_generated',
  'workspace-catalog-changed',
]);

const SURFACE_SCOPED_PREFIXES = ['agentic://', 'backend-event-'];

export function isSurfaceScopedEvent(event: string): boolean {
  if (SURFACE_SCOPED_EVENTS.has(event)) {
    return true;
  }
  return SURFACE_SCOPED_PREFIXES.some(prefix => event.startsWith(prefix));
}

/** `null` means the local device is the rendered surface. */
let activeSurfaceDeviceId: string | null = null;

export function setActiveSurfaceDeviceId(deviceId: string | null): void {
  activeSurfaceDeviceId = deviceId;
}

export function getActiveSurfaceDeviceId(): string | null {
  return activeSurfaceDeviceId;
}

/**
 * Read the source device of an event payload.
 *
 * Returns `null` for payloads produced by the local host — they never carry
 * the tag because the controller only adds it while re-emitting.
 */
export function readSourceDeviceId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const source = (payload as Record<string, unknown>)[PEER_EVENT_SOURCE_KEY];
  return typeof source === 'string' && source.length > 0 ? source : null;
}

/** Strip the routing tag so product consumers see the original payload shape. */
export function unwrapSurfacePayload<T>(payload: T): T {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!(PEER_EVENT_SOURCE_KEY in record)) {
    return payload;
  }
  if (PEER_EVENT_WRAPPED_PAYLOAD_KEY in record) {
    return record[PEER_EVENT_WRAPPED_PAYLOAD_KEY] as T;
  }
  const { [PEER_EVENT_SOURCE_KEY]: _source, ...rest } = record;
  return rest as T;
}

/**
 * Observers see every surface-scoped event, including events from devices the
 * UI is not currently rendering. That is how background device activity (a
 * peer still running a turn) stays visible in the device switcher.
 */
export type SurfaceEventObserver = (
  event: string,
  sourceDeviceId: string | null,
  payload: unknown,
) => void;

const observers = new Set<SurfaceEventObserver>();

export function observeSurfaceEvents(observer: SurfaceEventObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export interface SurfaceEventRoute<T> {
  /** Whether the active surface should receive this event. */
  deliver: boolean;
  /** Payload with the routing tag removed. */
  payload: T;
  /** `null` identifies events produced by this local Runtime Host. */
  sourceDeviceId: string | null;
}

/**
 * Decide whether an incoming event belongs to the rendered surface.
 *
 * Non surface-scoped events always pass. Surface-scoped events are delivered
 * only when their producing device is the one currently rendered.
 */
export function routeSurfaceEvent<T>(event: string, payload: T): SurfaceEventRoute<T> {
  const sourceDeviceId = readSourceDeviceId(payload);

  if (!isSurfaceScopedEvent(event)) {
    return {
      deliver: true,
      payload: unwrapSurfacePayload(payload),
      sourceDeviceId,
    };
  }

  const unwrapped = unwrapSurfacePayload(payload);

  if (observers.size > 0) {
    for (const observer of observers) {
      try {
        observer(event, sourceDeviceId, unwrapped);
      } catch {
        // A misbehaving observer must never drop a product event.
      }
    }
  }

  return {
    deliver: activeSurfaceDeviceId === sourceDeviceId,
    payload: unwrapped,
    sourceDeviceId,
  };
}
