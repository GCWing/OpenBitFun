// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DesignSystemProvider } from '@openbitfun/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionResult, RemoteConnectStatus } from '@/infrastructure/api/service-api/RemoteConnectAPI';
import { remoteConnectStatusSource } from '@/infrastructure/remote-connect/remoteConnectStatus';
import DeviceStatusControl from '../NavPanel/components/DeviceStatusControl';
import { RemoteConnectDialog } from './RemoteConnectDialog';
import { setRemoteConnectDisclaimerAgreed } from './remoteConnectDisclaimerStorage';

const boundary = vi.hoisted(() => ({
  backend: null as RemoteConnectStatus | null,
  hasWorkspace: true,
  loggedIn: true,
  getStatus: vi.fn(),
  startConnection: vi.fn(),
  stopConnection: vi.fn(),
  stopBot: vi.fn(),
  getFormState: vi.fn(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  jobs: {},
  copyText: vi.fn(),
  t: (key: string, values?: { count?: number; number?: number }) =>
    values?.count !== undefined ? `${key}:${values.count}` : values?.number !== undefined ? `${key}:${values.number}` : key,
}));

vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: {
    getStatus: boundary.getStatus,
    startConnection: boundary.startConnection,
    stopConnection: boundary.stopConnection,
    stopBot: boundary.stopBot,
    getFormState: boundary.getFormState,
    setFormState: vi.fn().mockResolvedValue(undefined),
    getLanNetworkInfo: vi.fn().mockResolvedValue({ local_ip: '192.168.1.2', available_ips: [{ ip: '192.168.1.2', interface_name: 'en0' }] }),
    getDeviceInfo: vi.fn().mockResolvedValue({ device_id: 'desktop', device_name: 'Workstation', mac_address: '' }),
    accountGetCredentialHint: vi.fn().mockResolvedValue({ username: 'sora', relay_url: 'https://relay.example.test/remote/a' }),
  },
}));
vi.mock('@/shared/utils/textSelection', () => ({ copyTextToClipboard: boundary.copyText }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    listen: (name: string, listener: (payload: unknown) => void) => {
      if (!boundary.listeners.has(name)) boundary.listeners.set(name, new Set());
      boundary.listeners.get(name)!.add(listener);
      return () => { boundary.listeners.get(name)?.delete(listener); };
    },
  },
}));
vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: boundary.t, currentLanguage: 'en-US', formatNumber: String }),
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: boundary.t, currentLanguage: 'en-US', formatNumber: String }),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ hasWorkspace: boundary.hasWorkspace }) }));
vi.mock('@/infrastructure/account/useAccountLoginState', () => ({
  useAccountLoginState: () => ({ loggedIn: boundary.loggedIn, deviceName: 'Workstation' }),
}));
vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({ getAppearanceOverlayHost: () => document.body }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => null }));
vi.mock('@/features/dispatch/dispatchJobStore', () => ({ useDispatchJobStore: (select: (value: unknown) => unknown) => select({ jobs: boundary.jobs }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }) }));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmWarning: vi.fn().mockResolvedValue(true) }));
vi.mock('./AccountPanel', () => ({ AccountPanel: () => null }));

const relayA = 'https://remote.openbitfun.com/v/1.0.2';

function status(overrides: Partial<RemoteConnectStatus> = {}): RemoteConnectStatus {
  return {
    relay_connected: false, relay_url: null, active_method: null, clients: [],
    bot_connected: 'Weixin (desktop-bot)', bot_verbose_mode: false,
    ...overrides,
  };
}

function invitation(relay = relayA): ConnectionResult {
  return {
    method: relay === relayA ? 'openbitfun_server' : { lan: { ip: '192.168.1.2' } },
    qr_data: null, qr_svg: null,
    qr_url: `${relay}/#/pair?did=desktop`,
    bot_pairing_code: null, bot_link: null, pairing_state: 'waiting_for_scan',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function Harness({ initialGroup }: { initialGroup?: 'network' | 'bot' }) {
  const [open, setOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  return <DesignSystemProvider portalHost={document.body}>
    <button data-testid="reopen-remote-connect" onClick={() => setOpen(true)}>Open connections</button>
    <DeviceStatusControl open={sidebarOpen} onOpenChange={setSidebarOpen} onManageDevices={() => setOpen(true)} />
    <RemoteConnectDialog isOpen={open} onClose={() => setOpen(false)} initialGroup={initialGroup} />
  </DesignSystemProvider>;
}

let root: Root;
let container: HTMLDivElement;
let mounted: boolean;

function element(selector: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
}
const dialog = () => element('[data-openbitfun-component="remote-connect-dialog"][data-openbitfun-part="root"]');
const overviewNetwork = () => element('[data-openbitfun-part="overviewAction"][data-openbitfun-group="network"]');
const cardStatus = () => (document.querySelector('[data-openbitfun-part="pairingCard"] [role="status"]') ?? element('[data-openbitfun-part="connections"] [role="status"]')).textContent;
const attachedMobile = () => document.querySelector('[data-testid="nav-footer-device-status"] [data-openbitfun-device-kind="mobile"]');
const attachedBot = () => document.querySelector('[data-testid="nav-footer-device-status"] [data-openbitfun-device-kind="message-app"]');

async function click(target: HTMLElement) { await act(async () => { target.click(); }); }
async function clickText(key: string) {
  const button = Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.trim() === key);
  expect(button, key).toBeDefined();
  await click(button!);
}
async function tick(ms = 2000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function render(initialGroup?: 'network' | 'bot') { await act(async () => { root.render(<Harness initialGroup={initialGroup} />); }); }
async function openNetwork() { await click(overviewNetwork()); }
async function generateInvitation() {
  await openNetwork();
  await click(element('#remote-connect-network-tab-openbitfun_server'));
  await clickText('remoteConnect.showConnectionCode');
}
async function closeDialog() {
  const close = document.querySelector<HTMLElement>('.openbitfun-remote-connect-dialog__header button');
  expect(close).not.toBeNull();
  await click(close!);
  await tick(300);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  boundary.listeners.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  setRemoteConnectDisclaimerAgreed();
  boundary.hasWorkspace = true;
  boundary.loggedIn = true;
  boundary.copyText.mockResolvedValue(true);
  boundary.backend = status();
  boundary.getStatus.mockImplementation(async () => ({ ...boundary.backend! }));
  boundary.getFormState.mockResolvedValue({});
  boundary.startConnection.mockImplementation(async (method: string) => {
    const relay = method === 'lan' ? 'http://192.168.1.2:9700' : relayA;
    const result = invitation(relay);
    boundary.backend = status({ ...boundary.backend!, relay_connected: true, relay_url: relay, active_method: result.method });
    return result;
  });
  boundary.stopConnection.mockImplementation(async () => {
    boundary.backend = status({ bot_connected: boundary.backend!.bot_connected });
  });
  boundary.stopBot.mockImplementation(async () => { boundary.backend = { ...boundary.backend!, bot_connected: null }; });
  remoteConnectStatusSource.invalidate();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(async () => {
  if (mounted) await act(async () => { root.unmount(); });
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Remote Connect shared status through the real dialog and sidebar', () => {
  it.each([undefined, 'network', 'bot'] as const)('requires GitHub identity for the %s entry', async group => {
    boundary.loggedIn = false;
    await render(group);
    expect(document.querySelector('#remote-connect-access-title')).toBeNull();
    expect(document.querySelector('#remote-connect-network-tabpanel')).toBeNull();
    expect(document.querySelector('#remote-connect-bot-tabpanel')).toBeNull();
    expect(boundary.startConnection).not.toHaveBeenCalled();
  });

  it('closes connection setup on account logout', async () => {
    await render('network');
    expect(element('#remote-connect-network-tabpanel')).toBeDefined();
    boundary.loggedIn = false;
    await render('network');
    expect(document.querySelector('#remote-connect-network-tabpanel')).toBeNull();
  });

  it.each([
    ['openbitfun_server', relayA], ['lan', 'http://192.168.1.2:9700'],
  ] as const)('uses identical connection, QR, presence and disconnect actions for %s', async (method, relay) => {
    await render('network');
    await click(element(`#remote-connect-network-tab-${method}`));
    await clickText('remoteConnect.showConnectionCode');
    await tick();
    expect(boundary.startConnection).toHaveBeenCalledWith(method, method === 'lan' ? '192.168.1.2' : undefined);
    expect(dialog().textContent).toContain(invitation(relay).qr_url);
    expect(cardStatus()).toBe('remoteConnect.stateWaiting');
    expect(element('[data-openbitfun-part="connections"]').textContent).not.toContain('remoteConnect.noConnectedClients');
    expect(attachedMobile()).toBeNull();
    expect(dialog().textContent).not.toContain('remoteConnect.accountConnectedHint');
    boundary.backend = { ...boundary.backend!, clients: [{ id: 'phone', name: 'Safari · iOS' }, { id: 'browser', name: 'Chrome' }] };
    await tick();
    expect(element('[data-openbitfun-part="connections"]').querySelectorAll('li')).toHaveLength(2);
    expect(cardStatus()).toBe('remoteConnect.stateConnected');
    expect(dialog().textContent).toContain('remoteConnect.accountConnectedHint');
    expect(attachedMobile()).not.toBeNull();
    await click(element('button[aria-label="remoteConnect.copyUrl"]'));
    expect(boundary.copyText).toHaveBeenCalledWith(invitation(relay).qr_url);
    await clickText('remoteConnect.cancelInvitation');
    expect(document.querySelector('[data-openbitfun-part="pairingCard"]')).toBeNull();
    expect(boundary.stopConnection).not.toHaveBeenCalled();
    expect(attachedMobile()).not.toBeNull();
    await clickText('remoteConnect.disconnect');
    expect(boundary.stopConnection).toHaveBeenCalledOnce();
    expect(boundary.stopBot).not.toHaveBeenCalled();
    expect(attachedMobile()).toBeNull();
    expect(attachedBot()).not.toBeNull();
  });

  it('retains the Relay route across overview navigation and closing the dialog', async () => {
    await render();
    await generateInvitation();
    boundary.backend = { ...boundary.backend!, clients: [{ id: 'phone', name: 'Safari' }] };
    await tick();
    await clickText('remoteConnect.backToOverview');
    expect(overviewNetwork().textContent).toContain('remoteConnect.stateConnected');
    expect(boundary.stopConnection).not.toHaveBeenCalled();
    await closeDialog();
    expect(attachedMobile()).not.toBeNull();
    await click(element('[data-testid="reopen-remote-connect"]'));
    await openNetwork();
    await click(element('#remote-connect-network-tab-openbitfun_server'));
    expect(cardStatus()).toBe('remoteConnect.stateConnected');
    await clickText('remoteConnect.showConnectionCode');
    expect(boundary.startConnection).toHaveBeenCalledTimes(2);
  });

  it('keeps an invitation through disconnect and reconnect while presence follows the live route', async () => {
    await render();
    await generateInvitation();
    for (const connected of [true, false, true]) {
      boundary.backend = { ...boundary.backend!, relay_connected: connected, clients: [{ id: 'phone', name: 'Safari' }] };
      await tick();
      expect(cardStatus()).toBe(connected ? 'remoteConnect.stateConnected' : 'remoteConnect.stateWaiting');
      expect(dialog().textContent).toContain(invitation().qr_url);
      expect(Boolean(attachedMobile())).toBe(connected);
    }
  });

  it('allows account connection without a selected workspace', async () => {
    boundary.hasWorkspace = false;
    await render();
    expect((overviewNetwork() as HTMLButtonElement).disabled).toBe(false);
    await generateInvitation();
    await tick();
    expect(cardStatus()).toBe('remoteConnect.stateWaiting');
  });

  it('preserves a selected method when the initial status read finishes late', async () => {
    const pending = deferred<RemoteConnectStatus>();
    boundary.getStatus.mockReturnValueOnce(pending.promise);
    await render('network');
    await click(element('#remote-connect-network-tab-lan'));
    boundary.backend = status({ relay_connected: true, relay_url: relayA, active_method: 'openbitfun_server' });
    await act(async () => { pending.resolve(boundary.backend!); });
    expect(element('#remote-connect-network-tab-lan').getAttribute('aria-selected')).toBe('true');
    expect(boundary.startConnection).not.toHaveBeenCalled();
  });

  it('reports failed reads without erasing a QR or claiming disconnection', async () => {
    await render();
    await generateInvitation();
    await tick();
    boundary.getStatus.mockRejectedValueOnce(new Error('status unavailable'));
    await tick();
    expect(cardStatus()).toBe('remoteConnect.statusUnavailable');
    expect(dialog().textContent).toContain(invitation().qr_url);
    await tick();
    expect(cardStatus()).toBe('remoteConnect.stateWaiting');
    expect(boundary.stopConnection).not.toHaveBeenCalled();
  });

  it('cleans up a connection that finishes after the dialog closes', async () => {
    const pending = deferred<ConnectionResult>();
    boundary.startConnection.mockReturnValueOnce(pending.promise);
    await render();
    await generateInvitation();
    await closeDialog();
    await act(async () => {
      boundary.backend = status({ relay_connected: true, relay_url: relayA, active_method: 'openbitfun_server' });
      pending.resolve(invitation());
    });
    expect(boundary.stopConnection).toHaveBeenCalledOnce();
    expect(boundary.backend!.relay_connected).toBe(false);
    expect(document.querySelector('[data-openbitfun-part="pairingCard"]')).toBeNull();
  });

  it('fences stale connected replies when an explicit disconnect wins', async () => {
    const connected = status({ relay_connected: true, relay_url: relayA, active_method: 'openbitfun_server', clients: [{ id: 'phone', name: 'Safari' }] });
    boundary.backend = connected;
    await render('network');
    const before = deferred<RemoteConnectStatus>();
    const during = deferred<RemoteConnectStatus>();
    boundary.getStatus.mockReturnValueOnce(before.promise).mockReturnValueOnce(during.promise);
    await tick();
    const stop = deferred<void>();
    boundary.stopConnection.mockImplementationOnce(async () => { await stop.promise; boundary.backend = status(); });
    await clickText('remoteConnect.disconnect');
    await tick();
    await act(async () => { stop.resolve(); });
    await act(async () => { during.resolve(connected); before.resolve(connected); });
    expect(attachedMobile()).toBeNull();
    expect(dialog().textContent).not.toContain('remoteConnect.disconnect');
    expect(boundary.stopConnection).toHaveBeenCalledOnce();
  });
});
