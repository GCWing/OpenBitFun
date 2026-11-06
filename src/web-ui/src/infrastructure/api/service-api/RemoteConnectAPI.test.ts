import { beforeEach, expect, it, vi } from 'vitest';
import { remoteConnectAPI } from './RemoteConnectAPI';

const fixture = vi.hoisted(() => ({ request: vi.fn(), wait: vi.fn() }));
vi.mock('../adapters', () => ({ getTransportAdapter: () => ({ request: fixture.request }) }));
vi.mock('./ApiClient', () => ({ api: { waitForListenerRegistrations: fixture.wait } }));
beforeEach(() => { vi.resetAllMocks(); fixture.request.mockResolvedValue('subscription'); });

it('waits for event registration before a subscription can replay cached history', async () => {
  let registered!: () => void;
  fixture.wait.mockReturnValue(new Promise<void>(resolve => { registered = resolve; }));
  const opening = remoteConnectAPI.subscribeSession('peer', 'session');
  await Promise.resolve();
  expect(fixture.request).not.toHaveBeenCalled();
  registered();
  await expect(opening).resolves.toBe('subscription');
  expect(fixture.request).toHaveBeenCalledWith('account_subscribe_session', {
    request: { target_device_id: 'peer', session_id: 'session' },
  });
});

it('does not allocate a subscription if listener registration fails', async () => {
  fixture.wait.mockRejectedValue(new Error('Event listener unavailable'));
  await expect(remoteConnectAPI.subscribeSession('peer', 'session')).rejects.toThrow('Event listener unavailable');
  expect(fixture.request).not.toHaveBeenCalled();
});
