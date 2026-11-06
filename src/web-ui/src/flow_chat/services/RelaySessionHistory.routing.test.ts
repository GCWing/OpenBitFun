import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { setActiveSurfaceDeviceId } from '@/infrastructure/peer-device/deviceSurfaceRouting';
import { TauriTransportAdapter } from '@/infrastructure/api/adapters/tauri-adapter';
import { prewarmRelaySessionHistory, RelaySessionHistory } from './RelaySessionHistory';

const native = vi.hoisted(() => ({
  registrations: [] as string[],
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  subscribe: vi.fn(async (..._args: unknown[]) => 'warm-subscription'), unsubscribe: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
  native.registrations.push(event);
  native.handlers.set(event, handler);
  return () => native.handlers.delete(event);
}) }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async () => {
  const { TauriTransportAdapter } = await import('@/infrastructure/api/adapters/tauri-adapter');
  const adapter = new TauriTransportAdapter();
  return { remoteConnectAPI: {
    onSessionRecord: (callback: (value: unknown) => void) => adapter.listen('session-record', callback),
    onSessionGap: (callback: (value: unknown) => void) => adapter.listen('relay://session-gap', callback),
    onSessionReady: (callback: (value: unknown) => void) => adapter.listen('relay://session-ready', callback),
    onSessionSyncError: (callback: (value: unknown) => void) => adapter.listen('account://session-sync-error', callback),
    onSessionInteractionChanged: (callback: (value: unknown) => void) => adapter.listen('session-interaction-changed', callback),
    subscribeSession: (...args: unknown[]) => native.subscribe(...args),
    unsubscribeSession: native.unsubscribe,
    loadOlderSession: vi.fn(),
  } };
});

beforeEach(() => {
  vi.useFakeTimers();
  native.subscribe.mockClear(); native.unsubscribe.mockClear(); native.registrations.length = 0;
  activateSurface('local'); setActiveSurfaceDeviceId(null);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); activateSurface('local'); setActiveSurfaceDeviceId(null); });

it.each([true, false])('adopts only the target stream when records arrive before device commit: %s', async beforeCommit => {
  const oldView = vi.fn();
  const nativeAdapter = new TauriTransportAdapter();
  const unlistenOld = nativeAdapter.listen('session-record', oldView);
  prewarmRelaySessionHistory('peer', 'session');
  await Promise.resolve();
  const emit = (name: string, source: string, payload: Record<string, unknown>) => {
    native.handlers.get(name)?.({ payload: { ...payload, __openbitfunSourceDeviceId: source } });
  };
  if (!beforeCommit) { activateSurface('peer'); setActiveSurfaceDeviceId('peer'); }
  emit('session-record', 'other-peer', { sessionId: 'session', id: 'wrong-device' });
  emit('relay://session-ready', 'other-peer', { sessionId: 'session', hasMore: true, cursor: 999, oldestSeq: 999 });
  emit('session-record', 'peer', { sessionId: 'other-session', id: 'wrong-session' });
  emit('session-record', 'peer', { sessionId: 'session', id: 'first-record' });
  emit('relay://session-ready', 'peer', { sessionId: 'session', hasMore: false, cursor: 1, oldestSeq: 1 });
  if (beforeCommit) {
    expect(oldView).not.toHaveBeenCalled();
    activateSurface('peer'); setActiveSurfaceDeviceId('peer');
  }
  unlistenOld();
  const apply = vi.fn(); const ready = vi.fn();
  const history = new RelaySessionHistory('session', apply, ready, vi.fn());
  let outcome: unknown;
  const opening = history.open().then(() => { outcome = 'ready'; }, error => { outcome = error.name; });
  await vi.advanceTimersByTimeAsync(15_001);
  await opening;
  history.close();
  await nativeAdapter.disconnect();
  expect(outcome).toBe('ready');
  expect(apply.mock.calls).toEqual([[{ sessionId: 'session', id: 'first-record' }]]);
  expect(ready).toHaveBeenCalledOnce();
  expect(ready.mock.calls[0][0].cursor).toBe(1);
  expect(native.registrations.filter(name => name === 'session-record')).toHaveLength(1);
  expect(native.registrations.filter(name => name === 'relay://session-ready')).toHaveLength(1);
  expect(native.subscribe).toHaveBeenCalledOnce();
  expect(native.unsubscribe).toHaveBeenCalledWith('warm-subscription');
});
