import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';

type ReaderValue = boolean | number | string;
type Listener = () => void;

/** Small view facts only. Never put payloads, React nodes, DOM or requests here. */
export class FlowChatReaderState {
  private values = new Map<string, ReaderValue>();
  private listeners = new Map<string, Set<Listener>>();
  private projectionListeners = new Set<Listener>();
  private revision = 0;
  private groupHolds = new Map<string, Set<string>>();
  private reveals = new Map<string, Set<string>>();

  reportReveal(turn: string, block: string) {
    const owners = this.reveals.get(turn) ?? new Set<string>();
    owners.add(block);
    this.reveals.set(turn, owners);
    this.set(`reveal:${turn}`, true);
    return () => {
      owners.delete(block);
      if (!owners.size) { this.reveals.delete(turn); this.set(`reveal:${turn}`, false); }
    };
  }

  isGroupHeld(id: string) { return Boolean(this.groupHolds.get(id)?.size); }
  holdGroup(id: string, owner: string): () => void {
    const owners = this.groupHolds.get(id) ?? new Set();
    owners.add(owner);
    this.groupHolds.set(id, owners);
    this.notifyProjection();
    return () => {
      if (!owners.delete(owner)) return;
      if (!owners.size) this.groupHolds.delete(id);
      this.notifyProjection();
    };
  }
  private notifyProjection() {
    this.revision++;
    this.projectionListeners.forEach(listener => listener());
  }

  get<T extends ReaderValue>(key: string, fallback: T): T {
    return (this.values.get(key) ?? fallback) as T;
  }
  has(key: string) { return this.values.has(key); }
  set<T extends ReaderValue>(key: string, value: T): void {
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    this.listeners.get(key)?.forEach(listener => listener());
    if (key.startsWith('group:')) {
      this.notifyProjection();
    }
  }
  subscribe = (key: string, listener: Listener) => {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  };
  subscribeProjection = (listener: Listener) => {
    this.projectionListeners.add(listener);
    return () => { this.projectionListeners.delete(listener); };
  };
  getProjectionRevision = () => this.revision;
}

// Session switching preserves choices without retaining the session. Active views
// hold their own store; the bounded registry only owns inactive view snapshots.
const views = new Map<string, FlowChatReaderState>();
const MAX_REMEMBERED_VIEWS = 24;
export function getFlowChatReaderState(scope: string): FlowChatReaderState {
  const store = views.get(scope) ?? new FlowChatReaderState();
  views.delete(scope);
  views.set(scope, store);
  while (views.size > MAX_REMEMBERED_VIEWS) views.delete(views.keys().next().value!);
  return store;
}

const ReaderContext = createContext<FlowChatReaderState | null>(null);
export const useFlowChatReaderStore = () => useContext(ReaderContext);
const ItemContext = createContext('');
export function FlowChatReaderProvider({ store, children }: { store: FlowChatReaderState; children: ReactNode }) {
  return <ReaderContext.Provider value={store}>{children}</ReaderContext.Provider>;
}
export function FlowChatCardReaderProvider({ itemKey, children }: { itemKey: string; children: ReactNode }) {
  return <ItemContext.Provider value={itemKey}>{children}</ItemContext.Provider>;
}

/** Reader choices survive viewport recycling; execution/completion never resets them. */
export function useFlowChatReaderValue<T extends ReaderValue>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(ReaderContext);
  const [fallback] = useState(() => new FlowChatReaderState());
  const store = context ?? fallback;
  const seed = useRef({ store, key, initial });
  if (seed.current.key !== key || seed.current.store !== store) seed.current = { store, key, initial };
  const initialValue = seed.current.initial;
  useLayoutEffect(() => {
    if (!store.has(key)) store.set(key, initialValue);
  }, [store, key, initialValue]);
  const subscribe = useCallback((listener: Listener) => store.subscribe(key, listener), [store, key]);
  const read = useCallback(() => store.get(key, initialValue), [store, key, initialValue]);
  const value = useSyncExternalStore(subscribe, read, read);
  const set = useCallback<Dispatch<SetStateAction<T>>>(next => {
    store.set(key, typeof next === 'function' ? next(store.get(key, initialValue)) : next);
  }, [store, key, initialValue]);
  return [value, set];
}

export function useToolCardValue<T extends ReaderValue>(slot: string, initial: T) {
  const item = useContext(ItemContext);
  return useFlowChatReaderValue(`card:${item}:${slot}`, initial);
}

export function useToolCardDisclosure(slot = 'details', initial = false) {
  return useToolCardValue(slot, initial);
}

export function useFlowChatReaderScope(scope: string) {
  return useMemo(() => getFlowChatReaderState(scope), [scope]);
}

/** Footer and group lifecycles observe the same visual completion across rows. */
export function useTimelineReveal(turn: string, block: string, revealing: boolean) {
  const reader = useFlowChatReaderStore();
  useLayoutEffect(() => {
    if (revealing) return reader?.reportReveal(turn, block);
  }, [reader, turn, block, revealing]);
  return useFlowChatReaderValue(`reveal:${turn}`, false)[0];
}
