import { observeHostQueue, type HostDialogQueue } from '../../../../shared/dialog-queue/HostDialogQueue';

const EMPTY: ReadonlySet<string> = new Set();
/** Mounted transcript leases: a queue row hides only while a transcript projects it. */
class HostQueuePresentation {
  private leases = new Map<object, readonly string[]>();
  private hidden: ReadonlySet<string> = EMPTY;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.hidden;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  set(owner: object, ids: readonly string[]) {
    if (ids.length) this.leases.set(owner, ids); else this.leases.delete(owner);
    const next = new Set([...this.leases.values()].flat());
    if (next.size === this.hidden.size && [...next].every(id => this.hidden.has(id))) return;
    this.hidden = next.size ? next : EMPTY;
    this.listeners.forEach(listener => listener());
  }
}
const stores = new WeakMap<HostDialogQueue, HostQueuePresentation>();
export function hostQueuePresentation(queue: HostDialogQueue) {
  let store = stores.get(queue);
  if (!store) { store = new HostQueuePresentation(); stores.set(queue, store); }
  return store;
}

const observers = new WeakMap<HostDialogQueue, { count: number; stop: () => void }>();
/** Composer and transcript share one observer; closing both never cancels host work. */
export function observePresentedHostQueue(queue: HostDialogQueue): () => void {
  let observer = observers.get(queue);
  if (!observer) {
    observer = { count: 0, stop: observeHostQueue(queue) };
    observers.set(queue, observer);
  }
  observer.count++;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (--observer.count === 0) { observer.stop(); observers.delete(queue); }
  };
}
