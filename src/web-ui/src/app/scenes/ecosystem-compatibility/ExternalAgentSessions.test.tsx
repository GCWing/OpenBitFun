// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), setConfig: vi.fn(), epoch: 0 }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: mocks }));
vi.mock('./RemovedExternalSessions', () => ({ RemovedExternalSessions: () => null }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: { setConfig: mocks.setConfig } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, values?: Record<string, unknown>) => values ? key + ':' + JSON.stringify(values) : key,
}) }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => {
  const epoch = mocks.epoch;
  return { isCurrent: () => epoch === mocks.epoch };
} }));
vi.mock('@openbitfun/ui', () => ({
  Switch: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} type="checkbox" />,
  Alert: ({ message }: { message: React.ReactNode }) => <div role="alert">{message}</div>,
}));
import ExternalAgentSessions from './ExternalAgentSessions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('external session automatic discovery toggle', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.epoch = 0;
    mocks.getConfig.mockResolvedValue({});
    mocks.setConfig.mockResolvedValue(undefined);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const toggle = () => container.querySelector<HTMLInputElement>('input')!;
  const render = async (ecosystemId: 'codex' | 'zcode' = 'codex', key = 'host') => {
    await act(async () => root.render(<ExternalAgentSessions key={key} ecosystemId={ecosystemId} />));
  };

  it('only exposes the host-owned opt-in switch and saves the selected source', async () => {
    await render();
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(mocks.getConfig).toHaveBeenCalledWith('app.external_session_discovery', { skipRetryOnNotFound: true });
    await act(async () => toggle().click());
    expect(mocks.setConfig).toHaveBeenCalledWith('app.external_session_discovery.codex', true);
    expect(toggle().checked).toBe(true);
  });

  it('keeps source switches independent and lets the user disable discovery', async () => {
    mocks.getConfig.mockResolvedValue({ codex: false, zcode: true });
    await render('zcode');
    expect(toggle().checked).toBe(true);
    await act(async () => toggle().click());
    expect(mocks.setConfig).toHaveBeenCalledWith('app.external_session_discovery.zcode', false);
    expect(toggle().checked).toBe(false);
  });

  it('keeps the confirmed preference after a failed save and supports retry', async () => {
    mocks.setConfig.mockRejectedValueOnce(new Error('Offline'));
    await render();
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect(container.textContent).toContain('sessions.autoDiscovery.saveFailed');
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('explicitly disables unsupported older hosts instead of storing a local flag', async () => {
    mocks.getConfig.mockResolvedValue(undefined);
    await render();
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).toContain('sessions.autoDiscovery.unsupported');
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });

  it('surfaces unreadable settings without enabling the switch', async () => {
    mocks.getConfig.mockRejectedValue(new Error('Offline'));
    await render();
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).toContain('sessions.autoDiscovery.loadFailed');
  });

  it('ignores an old source read after selection changes', async () => {
    const first = deferred<Record<string, boolean>>();
    mocks.getConfig.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ zcode: false });
    await render('codex');
    await render('zcode');
    await act(async () => first.resolve({ codex: true, zcode: true }));
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
  });

  it('does not project a save from the previous device onto the newly selected host', async () => {
    const save = deferred<void>();
    mocks.setConfig.mockReturnValueOnce(save.promise);
    await render();
    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);
    mocks.epoch += 1;
    await render('codex', 'peer');
    await act(async () => save.resolve());
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(mocks.setConfig).toHaveBeenCalledTimes(1);
  });
});
