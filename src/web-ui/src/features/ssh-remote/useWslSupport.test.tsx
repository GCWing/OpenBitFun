// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useWslSupport } from './useWslSupport';
const list = vi.hoisted(() => vi.fn());
vi.mock('./sshApi', () => ({ sshApi: { listWslDistributions: list } }));
let result: ReturnType<typeof useWslSupport>;
function Fixture() { result = useWslSupport(true); return <div>{result.status}</div>; }
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  resetDeviceSurfaceForTest(); list.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetDeviceSurfaceForTest(); });
it('probes each active host and discards stale support from the previous host', async () => {
  list.mockResolvedValueOnce({ supported: false });
  await act(async () => root.render(<Fixture />));
  expect(result.status).toBe('unsupported');
  let finish!: (value: unknown) => void;
  list.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => activateSurface('windows-peer'));
  expect(result.status).toBe('checking');
  list.mockResolvedValueOnce({ supported: true });
  await act(async () => activateSurface('other-peer'));
  expect(result.status).toBe('supported');
  await act(async () => finish({ supported: false }));
  expect(result.status).toBe('supported');
  expect(list).toHaveBeenCalledTimes(3);
});
it('offers retry for a failed probe and treats a legacy host capability error as unsupported', async () => {
  list.mockRejectedValueOnce(new Error('Host offline'));
  await act(async () => root.render(<Fixture />));
  expect(result.status).toBe('unavailable');
  list.mockResolvedValueOnce({ supported: true });
  await act(async () => result.retry());
  expect(result.status).toBe('supported');
  list.mockRejectedValueOnce(new Error('wsl_workspaces_v1_unsupported'));
  await act(async () => activateSurface('legacy-peer'));
  expect(result.status).toBe('unsupported');
});
