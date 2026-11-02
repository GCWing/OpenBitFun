/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountPanel } from './AccountPanel';
import { useUpdateInstallStore } from '@/infrastructure/update/updateInstallStore';
const mocks = vi.hoisted(() => ({
  identity: { resolved: true, status: 'signed-in', me: { user: { githubId: 42, login: 'alice' } } } as { resolved: boolean; status: string; me: { user: { githubId: number; login: string } } | null },
  reopenSignIn: vi.fn(),
  getDeviceInfo: vi.fn(), accountStatus: vi.fn(), accountLogin: vi.fn(),
  accountRelayCapabilities: vi.fn(), accountUpdateDevice: vi.fn(),
  accountConnectDevices: vi.fn(), accountListDevices: vi.fn(),
  checkForUpdates: vi.fn(), installUpdate: vi.fn(),
  peerMode: { active: false } as { active: boolean },
  switchToDevice: vi.fn(), switchToLocal: vi.fn(),
  t: (key: string) => key,
}));
const presenceListeners = vi.hoisted(() => [] as Array<(payload: { devices: Array<Record<string, unknown>> }) => void>);
vi.mock('@/infrastructure/account-identity', () => ({ useAccountIdentity: () => mocks.identity, accountIdentityService: { reopenSignIn: mocks.reopenSignIn } }));
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({ ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(), remoteConnectAPI: mocks }));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({
  api: {
    listen: (_event: string, handler: (payload: { devices: Array<Record<string, unknown>> }) => void) => {
      presenceListeners.push(handler);
      return () => {};
    },
  },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t, formatRelativeTime: () => '' }) }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceMode: () => ({
    peerMode: mocks.peerMode,
    switchToDevice: mocks.switchToDevice,
    switchToLocal: mocks.switchToLocal,
  }),
}));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: { checkForUpdates: mocks.checkForUpdates, installUpdate: mocks.installUpdate },
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: vi.fn() }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ success: vi.fn() }) }));
vi.mock('@openbitfun/ui', () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Button = ({ children, onClick, disabled }: { children?: React.ReactNode; onClick?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button>;
  const IconButton = ({ 'aria-label': ariaLabel, onClick, disabled }: { 'aria-label'?: string; onClick?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean }) => <button aria-label={ariaLabel} onClick={onClick} disabled={disabled} />;
  const Input = ({ value, onChange, onKeyDown, placeholder, 'aria-label': ariaLabel }: { value?: string; onChange?: React.ChangeEventHandler<HTMLInputElement>; onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>; placeholder?: string; 'aria-label'?: string }) => (
    <input aria-label={ariaLabel} onChange={onChange} onKeyDown={onKeyDown} placeholder={placeholder} value={value} />
  );
  return { Avatar: ({ src, alt }: { src?: string; alt?: string }) => <img src={src} alt={alt} />, OverflowText: Box, Alert: ({ message }: { message: string }) => <div>{message}</div>, Button, Icon: () => null, IconButton, Input, ScrollArea: Box, StatusPill: Box };
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  mocks.identity = { resolved: true, status: 'signed-in', me: { user: { githubId: 42, login: 'alice' } } };
  mocks.peerMode = { active: false };
  mocks.getDeviceInfo.mockResolvedValueOnce({ device_id: 'local', device_name: 'My computer' })
    .mockImplementation(() => new Promise(() => {}));
  // A second initialization is deliberately held so the regression fails
  // deterministically instead of creating an unbounded render loop.
  mocks.accountStatus.mockResolvedValueOnce({ logged_in: true, user_id: '42' })
    .mockImplementation(() => new Promise(() => {}));
  mocks.accountRelayCapabilities.mockResolvedValue([]);
  mocks.accountConnectDevices.mockResolvedValue([{ device_id: 'local', device_name: 'My computer' }]);
  mocks.accountListDevices.mockResolvedValue([{ device_id: 'local', device_name: 'My computer', online: true }]);
  // Discovery is initialized up front so an explicit check never starts a version read.
  useUpdateInstallStore.setState({
    initialized: true, currentVersion: '1.0.0', availableUpdate: null, checkStatus: 'idle',
    checkError: null, detailsOpen: false, notice: null, error: null, version: null,
  });
  presenceListeners.length = 0;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('keeps initialization alive when the local device ID arrives', async () => {
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(mocks.accountStatus).toHaveBeenCalledTimes(1);
  expect(mocks.accountConnectDevices).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('My computer');
  expect(container.textContent).not.toContain('accountLogin.loadingDevices');
  expect(mocks.accountListDevices).toHaveBeenCalledTimes(1);
});

it('loads the device snapshot and retains it across a normal rerender', async () => {
  mocks.getDeviceInfo.mockResolvedValue({ device_id: 'local', device_name: 'My computer' });
  mocks.accountListDevices.mockResolvedValue([{ device_id: 'local', device_name: 'My computer', online: true }]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(mocks.accountStatus).toHaveBeenCalledTimes(1);
  expect(mocks.accountListDevices).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('My computer');
  expect(container.textContent).not.toContain('accountLogin.loadingDevices');
});
it('ignores a late device connection after shared identity signs out', async () => {
  let resolve!: (devices: Array<{ device_id: string; device_name: string }>) => void;
  mocks.accountConnectDevices.mockReturnValue(new Promise(res => { resolve = res; }));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  mocks.identity = { resolved: true, status: 'signed-out', me: null };
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  await act(async () => { resolve([{ device_id: 'old', device_name: 'Old account device' }]); });
  expect(container.textContent).not.toContain('Old account device');
  expect(container.textContent).toContain('accountLogin.login');
  expect(mocks.accountListDevices).not.toHaveBeenCalled();
});

it('fences a late snapshot when switching accounts', async () => {
  let resolve!: (devices: Array<{ device_id: string; device_name: string; online: boolean }>) => void;
  mocks.accountListDevices.mockReturnValueOnce(new Promise(res => { resolve = res; }));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  mocks.identity = { resolved: true, status: 'signed-in', me: { user: { githubId: 7, login: 'bob' } } };
  mocks.accountStatus.mockResolvedValue({ logged_in: true, user_id: '7' });
  mocks.accountConnectDevices.mockResolvedValue([]);
  mocks.accountListDevices.mockResolvedValue([{ device_id: 'new', device_name: 'New account device', online: true }]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  await act(async () => { resolve([{ device_id: 'old', device_name: 'Old account device', online: true }]); });
  expect(container.textContent).toContain('New account device');
  expect(container.textContent).not.toContain('Old account device');
});
it('shows a connection failure while retaining the signed-in account', async () => {
  mocks.accountStatus.mockReset().mockRejectedValue(new Error('network unavailable'));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('alice');
  expect(container.textContent).toContain('accountLogin.retryConnect');
  expect(container.textContent).not.toContain('accountLogin.loadingDevices');
});

it('explains a retired Relay version and offers an update instead of the raw error', async () => {
  vi.stubGlobal('__TAURI__', {});
  mocks.accountStatus.mockReset().mockRejectedValue(
    Object.assign(new Error('List devices failed: HTTP 410'), { status: 410 }),
  );
  mocks.checkForUpdates.mockResolvedValue({ updateAvailable: true, currentVersion: '1.0.0', latestVersion: '2.0.0', releaseNotes: null, releaseDate: null });
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  // The actionable sentence replaces the raw transport detail and HTTP status.
  expect(container.textContent).toContain('accountLogin.relayFailureVersionRetired');
  expect(container.textContent).not.toContain('List devices failed');
  expect(container.textContent).not.toContain('410');
  // The retired version can only be fixed by updating, never by retrying here.
  const updateButton = Array.from(container.querySelectorAll('button')).find(node => node.textContent === 'update.checkForUpdates');
  expect(updateButton).toBeDefined();
  await act(async () => { updateButton!.click(); });
  // Discovery and the dialog stay in the shared update store, which the shell renders.
  expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
  expect(useUpdateInstallStore.getState()).toMatchObject({ checkStatus: 'available', detailsOpen: true });
});

it('does not offer an update check in a runtime that cannot install updates', async () => {
  mocks.accountStatus.mockReset().mockRejectedValue(
    Object.assign(new Error('List devices failed: HTTP 410'), { status: 410 }),
  );
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('accountLogin.relayFailureVersionRetired');
  expect(container.textContent).not.toContain('update.checkForUpdates');
  // Without a banner action the section heading still offers a way forward.
  const retryButtons = Array.from(container.querySelectorAll('button'))
    .filter(node => node.textContent === 'accountLogin.retryConnect');
  expect(retryButtons).toHaveLength(1);
});

it('offers a retry when the Relay is temporarily unavailable', async () => {
  mocks.accountStatus.mockReset().mockRejectedValue(
    Object.assign(new Error('List devices failed: HTTP 502'), { status: 502 }),
  );
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('accountLogin.relayFailureUnavailable');
  expect(container.textContent).not.toContain('502');
  const retryButtons = Array.from(container.querySelectorAll('button'))
    .filter(node => node.textContent === 'accountLogin.retryConnect');
  expect(retryButtons).toHaveLength(1);
  expect(retryButtons[0]!.closest('[data-openbitfun-part="error"]')).not.toBeNull();
});

async function retryConnection() {
  const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent === 'accountLogin.retryConnect');
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
}
it('retries a failed connection without asking for GitHub authorization again', async () => {
  mocks.accountStatus.mockResolvedValue({ logged_in: true, user_id: '42' });
  mocks.accountConnectDevices.mockRejectedValueOnce(new Error('socket failure'));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  await retryConnection();
  expect(container.textContent).toContain('My computer');
  expect(container.textContent).not.toContain('accountLogin.loadingDevices');
  expect(mocks.accountLogin).not.toHaveBeenCalled();
});
it('allows the new account to retry while an old recovery is still pending', async () => {
  let finishOld!: (devices: Array<{ device_id: string; device_name: string }>) => void;
  mocks.accountStatus.mockResolvedValue({ logged_in: true, user_id: '42' });
  mocks.accountConnectDevices.mockRejectedValueOnce(new Error('socket failure'))
    .mockReturnValueOnce(new Promise(res => { finishOld = res; }));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  await retryConnection();
  mocks.identity = { resolved: true, status: 'signed-in', me: { user: { githubId: 7, login: 'bob' } } };
  mocks.accountStatus.mockResolvedValue({ logged_in: true, user_id: '7' });
  mocks.accountConnectDevices.mockRejectedValueOnce(new Error('socket failure'))
    .mockResolvedValueOnce([{ device_id: 'new', device_name: 'New account device' }]);
  mocks.accountListDevices.mockResolvedValue([{ device_id: 'new', device_name: 'New account device', online: true }]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  await retryConnection();
  expect(container.textContent).toContain('New account device');
  await act(async () => { finishOld([{ device_id: 'old', device_name: 'Old account device' }]); });
  expect(container.textContent).not.toContain('Old account device');
  expect(mocks.accountConnectDevices).toHaveBeenCalledTimes(4);
});

it('adopts the account-bound local device ID without reconnecting', async () => {
  let finishInfo!: (info: { device_id: string }) => void;
  mocks.getDeviceInfo.mockReset().mockResolvedValueOnce({ device_id: 'before-auth' })
    .mockReturnValueOnce(new Promise(resolve => { finishInfo = resolve; }));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).not.toContain('accountLogin.thisDevice');
  await act(async () => { finishInfo({ device_id: 'local' }); });
  expect(container.textContent).toContain('accountLogin.thisDevice');
  expect(mocks.accountConnectDevices).toHaveBeenCalledTimes(1);
  expect(mocks.accountStatus).toHaveBeenCalledTimes(1);
});

it('finishes loading an empty device list', async () => {
  mocks.accountConnectDevices.mockResolvedValue([]);
  mocks.accountListDevices.mockResolvedValue([]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).not.toContain('accountLogin.loadingDevices');
  expect(mocks.accountListDevices).toHaveBeenCalledTimes(1);
});

it('does not restart polling when a recovery snapshot finishes after logout', async () => {
  vi.useFakeTimers();
  try {
    let finishSnapshot!: (devices: []) => void;
    mocks.accountStatus.mockResolvedValue({ logged_in: true, user_id: '42' });
    mocks.accountConnectDevices.mockRejectedValueOnce(new Error('socket failure'));
    mocks.accountListDevices.mockReturnValueOnce(new Promise(resolve => { finishSnapshot = resolve; }));
    await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
    await retryConnection();
    mocks.identity = { resolved: true, status: 'signed-out', me: null };
    await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
    await act(async () => { finishSnapshot([]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.accountListDevices).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('accountLogin.login');
  } finally {
    vi.useRealTimers();
  }
});

it('ignores pre-auth device information that arrives after the adopted ID', async () => {
  let finishOldInfo!: (info: { device_id: string }) => void;
  mocks.getDeviceInfo.mockReset()
    .mockReturnValueOnce(new Promise(resolve => { finishOldInfo = resolve; }))
    .mockResolvedValueOnce({ device_id: 'local' });
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('accountLogin.thisDevice');
  await act(async () => { finishOldInfo({ device_id: 'before-auth' }); });
  expect(container.textContent).toContain('accountLogin.thisDevice');
  expect(mocks.accountConnectDevices).toHaveBeenCalledTimes(1);
});

it('lets a pending login reopen its external sign-in page', async () => {
  mocks.identity = { resolved: true, status: 'authorizing', me: null };
  mocks.accountStatus.mockResolvedValue({ logged_in: false });
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  const reopen = [...container.querySelectorAll('button')].find(button => button.textContent === 'accountLogin.reopen');
  expect(reopen).toBeDefined();
  expect(reopen!.disabled).toBe(false);
  await act(async () => { reopen!.click(); });
  expect(mocks.reopenSignIn).toHaveBeenCalledOnce();
});

it('shows explicit old Relay capability state before any mutation', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue([]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('accountLogin.deviceAliasUnsupported');
  expect(mocks.accountUpdateDevice).not.toHaveBeenCalled();
});
it('accepts the negotiated alias capability and displays only alias plus metadata', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  mocks.accountListDevices.mockResolvedValue([{ device_id: 'local', device_name: 'technical', device_alias: 'Studio', device_model: 'Model', device_os: 'Linux', online: true }]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).not.toContain('accountLogin.deviceAliasUnsupported');
  expect(container.textContent).not.toContain('technical');
  expect(container.textContent).toContain('Studio');
  expect(container.textContent).toContain('Model');
});
it('marks each row with the system it reported, a server for a CLI host, and the neutral mark when it is unknown', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  mocks.accountListDevices.mockResolvedValue([
    { device_id: 'win', device_name: 'lwb_winpc', device_os: 'Windows 11', device_kind: 'desktop', online: true },
    { device_id: 'mac', device_name: 'lwb_macbook', device_os: 'macOS 15.7.3', device_kind: 'desktop', online: true },
    { device_id: 'srv', device_name: 'lwb_server', device_os: 'Linux', device_kind: 'cli', online: true },
    { device_id: 'legacy', device_name: 'lwb_legacy', online: true },
  ]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });

  const rowFor = (name: string) => Array.from(
    container.querySelectorAll('[data-openbitfun-part="deviceCard"]'),
  ).find(row => row.textContent?.includes(name));

  expect(rowFor('lwb_winpc')?.querySelector('[data-system]')?.getAttribute('data-system')).toBe('windows');
  expect(rowFor('lwb_macbook')?.querySelector('[data-system]')?.getAttribute('data-system')).toBe('macos');
  // A CLI host has no system silhouette to draw, whatever machine it runs on.
  expect(rowFor('lwb_server')?.querySelector('[data-system]')?.getAttribute('data-system')).toBe('server');
  // No system reported: this list keeps the neutral mark it always drew.
  expect(rowFor('lwb_legacy')?.querySelector('[data-system]')).toBeNull();
  expect(rowFor('lwb_legacy')?.querySelector('svg')).not.toBeNull();
});

it('keeps the unsupported notice hidden while the capability answer is pending', async () => {
  // An unanswered capability read used to render as an unsupported relay, which
  // flashed the notice on every panel entry while `/api/info` was in flight.
  mocks.accountRelayCapabilities.mockImplementation(() => new Promise(() => {}));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('My computer');
  expect(container.textContent).not.toContain('accountLogin.deviceAliasUnsupported');
});
it('keeps the unsupported notice hidden when the capability read fails', async () => {
  // Relay reachability owns its own banner; a transport error is not evidence
  // that the relay lacks the capability.
  mocks.accountRelayCapabilities.mockRejectedValue(new Error('network down'));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).not.toContain('accountLogin.deviceAliasUnsupported');
});

/** Emit a presence signal to every listener the panel registered for this epoch. */
async function emitPresence(devices: Array<Record<string, unknown>>) {
  expect(presenceListeners.length).toBeGreaterThan(0);
  await act(async () => { for (const listener of [...presenceListeners]) listener({ devices }); });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function openAliasEditor() {
  const edit = container.querySelector<HTMLButtonElement>('button[aria-label="accountLogin.editDeviceAlias"]');
  expect(edit).not.toBeNull();
  await act(async () => { edit!.click(); });
  const input = container.querySelector<HTMLInputElement>('input[aria-label="accountLogin.deviceAlias"]');
  expect(input).not.toBeNull();
  return input!;
}

it('replaces the device name in place instead of showing two names', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.querySelector('.account-panel__device-name')).not.toBeNull();
  const input = await openAliasEditor();
  // The editor occupies the name's slot; the technical name is not repeated.
  expect(input.value).toBe('');
  expect(container.querySelector('.account-panel__device-name')).toBeNull();
  expect(container.querySelector('.account-panel__device-badge')).toBeNull();
  expect(container.textContent).not.toContain('My computer');
  // Losing the row must not lose the device's status or hardware line.
  expect(container.querySelector('.account-panel__device-meta')).not.toBeNull();
});

it('saves an edited alias from the device row with Enter', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  const input = await openAliasEditor();
  await act(async () => { setInputValue(input, '  Studio  '); });
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(mocks.accountUpdateDevice).toHaveBeenCalledWith('local', 'Studio');
});

it('clears an alias when the row editor is saved empty', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  mocks.accountListDevices.mockResolvedValue([{ device_id: 'local', device_name: 'My computer', device_alias: 'Studio', online: true }]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  const input = await openAliasEditor();
  await act(async () => { setInputValue(input, '   '); });
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(mocks.accountUpdateDevice).toHaveBeenCalledWith('local', null);
});

it('closes the row editor on Escape without renaming', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  const input = await openAliasEditor();
  await act(async () => { setInputValue(input, 'Studio'); });
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(container.querySelector('input[aria-label="accountLogin.deviceAlias"]')).toBeNull();
  expect(mocks.accountUpdateDevice).not.toHaveBeenCalled();
});

it('never renders a device offline from an empty presence signal', async () => {
  // The desktop emits an empty presence list when its own routing socket drops.
  // Holding the follow-up snapshot open reproduces the window in which the
  // directory still reports the device online.
  mocks.accountListDevices.mockReset()
    .mockResolvedValueOnce([{ device_id: 'local', device_name: 'My computer', device_model: 'Model', online: true, last_seen_at: 1_700_000_000 }])
    .mockImplementation(() => new Promise(() => {}));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).toContain('accountLogin.online');
  await emitPresence([]);
  expect(container.textContent).toContain('accountLogin.online');
  expect(container.textContent).not.toContain('accountLogin.lastSeen');
  expect(container.textContent).toContain('Model');
});

it('merges presence metadata without clearing fields an older relay omits', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  mocks.accountListDevices.mockReset()
    .mockResolvedValueOnce([{ device_id: 'local', device_name: 'My computer', device_model: 'Model', device_os: 'Linux', online: true }])
    .mockImplementation(() => new Promise(() => {}));
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.textContent).not.toContain('Studio');
  await emitPresence([{ device_id: 'local', device_name: 'My computer', device_alias: 'Studio' }]);
  expect(container.textContent).toContain('Studio');
  expect(container.textContent).toContain('Model');
  expect(container.textContent).toContain('Linux');
  expect(container.textContent).toContain('accountLogin.online');
});

it('keeps an incompatible device listed with a reason and never targets it', async () => {
  mocks.accountRelayCapabilities.mockResolvedValue(['device_alias_v1']);
  mocks.accountConnectDevices.mockResolvedValue([]);
  mocks.getDeviceInfo.mockReset().mockResolvedValue({ device_id: 'local' });
  mocks.accountListDevices.mockResolvedValue([
    { device_id: 'local', device_name: 'My computer', online: true },
    { device_id: 'peer', device_name: 'Old build', online: true, compatible: false, device_client_version: '0.9.0' },
  ]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  // The device stays visible; the reason mentions the peer version.
  expect(container.textContent).toContain('Old build');
  expect(container.textContent).toContain('accountLogin.deviceClientIncompatibleWithVersion');
  // No control target: the peer never becomes a peer-mode switch button.
  expect(container.querySelector('button[aria-label="accountLogin.openDevice"]')).toBeNull();
  expect(mocks.switchToDevice).not.toHaveBeenCalled();
  // Alias editing is a plain directory operation and stays available on both rows.
  expect(container.querySelectorAll('button[aria-label="accountLogin.editDeviceAlias"]').length).toBe(2);
});

it('still allows switching to a device whose compatibility flag is absent', async () => {
  mocks.accountConnectDevices.mockResolvedValue([]);
  mocks.getDeviceInfo.mockReset().mockResolvedValue({ device_id: 'local' });
  mocks.switchToDevice.mockResolvedValue('activated');
  mocks.accountListDevices.mockResolvedValue([
    { device_id: 'local', device_name: 'My computer', online: true },
    { device_id: 'peer', device_name: 'Peer build', online: true },
  ]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  const peer = container.querySelector<HTMLButtonElement>('button[aria-label="accountLogin.openDevice"]');
  expect(peer).not.toBeNull();
  await act(async () => { peer!.click(); });
  expect(mocks.switchToDevice).toHaveBeenCalledWith('peer', 'Peer build');
});

it('groups the account and its devices into titled sections with fixed row columns', async () => {
  mocks.accountConnectDevices.mockResolvedValue([]);
  mocks.getDeviceInfo.mockReset().mockResolvedValue({ device_id: 'local' });
  mocks.accountListDevices.mockResolvedValue([
    { device_id: 'local', device_name: 'My computer', online: true },
    { device_id: 'peer', device_name: 'Peer build', online: false },
  ]);
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  const titles = Array.from(container.querySelectorAll('.account-panel__section-title')).map(node => node.textContent);
  expect(titles).toEqual(['accountLogin.accountSectionTitle', 'accountLogin.linkedDevices']);
  const statuses = Array.from(container.querySelectorAll('.account-panel__device-status'))
    .map(node => node.getAttribute('data-openbitfun-state'));
  expect(statuses).toEqual(['online', 'offline']);
  for (const row of container.querySelectorAll('[data-openbitfun-part="deviceCard"]')) {
    const children = Array.from(row.children).map(node => node.className);
    expect(children).toEqual([
      'account-panel__device-select',
      'account-panel__device-actions',
      'account-panel__device-chevron',
    ]);
  }
});

it('shows the sign-in action inside the account section when signed out', async () => {
  mocks.identity = { resolved: true, status: 'signed-out', me: null };
  mocks.accountStatus.mockReset().mockResolvedValue({ logged_in: false });
  await act(async () => { root.render(<AccountPanel onCloseDialog={() => {}} />); });
  expect(container.querySelector('.account-panel__section-title')?.textContent).toBe('accountLogin.accountSectionTitle');
  expect(container.querySelector('[data-openbitfun-part="form"]')?.textContent).toContain('accountLogin.login');
});
