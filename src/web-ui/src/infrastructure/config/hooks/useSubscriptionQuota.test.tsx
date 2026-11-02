// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useSubscriptionQuota } from './useSubscriptionQuota';
const query = vi.hoisted(() => vi.fn());
const modelQuery = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/api/service-api/AIApi', () => ({ aiApi: { getSubscriptionAccountQuota: query, getModelProviderQuota: modelQuery } }));

let root: Root;
let container: HTMLDivElement;
function Probe({ supported = true, active = true, accountId = 'zcode', modelId, forceOnActivate = false }: { supported?: boolean; active?: boolean; accountId?: string; modelId?: string; forceOnActivate?: boolean }) {
  const observation = useSubscriptionQuota(modelId ? 'opencode' : 'zcode', accountId, active, supported, 'fixture-account', 0, modelId, forceOnActivate);
  return <button data-loading={observation.loading} data-failed={observation.failed} data-host-unsupported={observation.unsupportedHost}
    onClick={() => void observation.refresh()}>{observation.value?.plan || 'empty'}</button>;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDeviceSurfaceForTest(); query.mockReset(); modelQuery.mockReset();
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); resetDeviceSurfaceForTest(); vi.useRealTimers(); });

it('drops a late local response after activating a peer, including a reconnect to the same device', async () => {
  let completeLocal!: (value: unknown) => void;
  let completePeer!: (value: unknown) => void;
  query.mockImplementationOnce(() => new Promise(resolve => { completeLocal = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { completePeer = resolve; }))
    .mockResolvedValue({ account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'reconnected', windows: [] });
  await act(async () => root.render(<Probe />));
  await act(async () => { activateSurface('peer-a'); });
  await act(async () => { completeLocal({ account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'local secret balance', windows: [] }); });
  expect(container.textContent).toBe('empty');
  await act(async () => { completePeer({ account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'peer balance', windows: [] }); });
  expect(container.textContent).toBe('peer balance');
  await act(async () => { activateSurface('peer-a'); });
  expect(container.textContent).toBe('reconnected');
});

it('does not query unsupported hosts or hidden panels, and rejects another slot in a response', async () => {
  await act(async () => root.render(<Probe supported={false} />));
  expect(query).not.toHaveBeenCalled();
  expect(container.querySelector('button')?.dataset.hostUnsupported).toBe('true');
  await act(async () => root.render(<Probe active={false} />));
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValue({ account_id: 'another-account', provider: 'zcode', state: 'known', plan: 'wrong account', windows: [] });
  await act(async () => root.render(<Probe accountId="selected-slot" />));
  expect(query).toHaveBeenCalledWith('zcode', 'selected-slot', false);
  expect(container.textContent).toBe('empty');
  expect(container.querySelector('button')?.dataset.failed).toBe('true');
});

it('retains a successful observation on refresh failure without claiming it was updated', async () => {
  query.mockResolvedValueOnce({ account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'last successful plan', windows: [], observed_at: 1000 })
    .mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Probe />));
  await act(async () => container.querySelector('button')!.click());
  expect(query).toHaveBeenLastCalledWith('zcode', 'zcode', true);
  expect(container.textContent).toBe('last successful plan');
  expect(container.querySelector('button')?.dataset.failed).toBe('true');
});

it.each(['local', 'peer-a'])('forces a fresh account observation on every panel opening on %s', async surface => {
  activateSurface(surface);
  query.mockResolvedValueOnce({ account_id: 'selected-slot', provider: 'zcode', state: 'known', plan: 'first observation', windows: [] })
    .mockResolvedValueOnce({ account_id: 'selected-slot', provider: 'zcode', state: 'known', plan: 'fresh observation', windows: [] });
  await act(async () => root.render(<Probe accountId="selected-slot" active={false} forceOnActivate />));
  expect(query).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe accountId="selected-slot" forceOnActivate />));
  expect(query).toHaveBeenLastCalledWith('zcode', 'selected-slot', true);
  expect(container.textContent).toBe('first observation');
  await act(async () => root.render(<Probe accountId="selected-slot" active={false} forceOnActivate />));
  expect(query).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Probe accountId="selected-slot" forceOnActivate />));
  expect(query).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenLastCalledWith('zcode', 'selected-slot', true);
  expect(container.textContent).toBe('fresh observation');
});

it('retains the last observation when a refresh returns a provider HTTP failure state', async () => {
  query.mockResolvedValueOnce({ account_id: 'zcode', provider: 'zcode', state: 'known', plan: 'observed plan', windows: [], observed_at: 1000 })
    .mockResolvedValueOnce({ account_id: 'zcode', provider: 'zcode', state: 'query_failed', error: 'opencode_key_rejected', windows: [] });
  await act(async () => root.render(<Probe />));
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toBe('observed plan');
  expect(container.querySelector('button')?.dataset.failed).toBe('true');
});

it('uses only the saved model ID for Go billing and never resolves a provider-default account', async () => {
  modelQuery.mockResolvedValue({ account_id: 'model:go', provider: 'opencode', state: 'known', plan: 'Go plan', windows: [] });
  await act(async () => root.render(<Probe modelId="go" accountId="model:go" />));
  expect(modelQuery).toHaveBeenCalledExactlyOnceWith('go');
  expect(query).not.toHaveBeenCalled();
  expect(container.textContent).toBe('Go plan');
});
