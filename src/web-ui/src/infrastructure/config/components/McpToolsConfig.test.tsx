// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import McpToolsConfig from './McpToolsConfig';
import { globalEventBus } from '@/infrastructure/event-bus';
import { MCP_CONFIG_CHANGED } from '@/infrastructure/mcp/configEvents';

const peerState = vi.hoisted(() => ({ active: true }));
const runtimeState = vi.hoisted(() => ({ desktop: true }));
const getServersMock = vi.hoisted(() => vi.fn());
const loadJsonConfigMock = vi.hoisted(() => vi.fn());
const saveJsonConfigMock = vi.hoisted(() => vi.fn());
const initializeServersMock = vi.hoisted(() => vi.fn());
const startServerMock = vi.hoisted(() => vi.fn());
const restartServerMock = vi.hoisted(() => vi.fn());
const startRemoteOAuthMock = vi.hoisted(() => vi.fn());
const getRemoteOAuthSessionMock = vi.hoisted(() => vi.fn());
const cancelRemoteOAuthMock = vi.hoisted(() => vi.fn());
const deleteServerMock = vi.hoisted(() => vi.fn());
const confirmDangerMock = vi.hoisted(() => vi.fn());
const openExternalMock = vi.hoisted(() => vi.fn());
const notificationMocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: (value: number) => String(value) }),
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({
  usePeerDeviceModeOptional: () => ({
    peerMode: peerState.active
      ? { active: true, deviceId: 'remote-device', deviceName: 'Remote device' }
      : { active: false },
  }),
}));
vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: () => runtimeState.desktop,
}));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => notificationMocks,
}));
vi.mock('@/infrastructure/confirm-dialog', async () => {
  const actual = await vi.importActual<typeof import('@/infrastructure/confirm-dialog')>(
    '@/infrastructure/confirm-dialog',
  );
  return { ...actual, confirmDanger: confirmDangerMock };
});
vi.mock('../../api/service-api/MCPAPI', () => ({
  MCPAPI: {
    getServers: getServersMock,
    loadMCPJsonConfig: loadJsonConfigMock,
    saveMCPJsonConfig: saveJsonConfigMock,
    initializeServers: initializeServersMock,
    startServer: startServerMock,
    restartServer: restartServerMock,
    startRemoteOAuth: startRemoteOAuthMock,
    getRemoteOAuthSession: getRemoteOAuthSessionMock,
    cancelRemoteOAuth: cancelRemoteOAuthMock,
    deleteServer: deleteServerMock,
  },
}));
vi.mock('../../api/service-api/SystemAPI', () => ({
  systemAPI: { openExternal: openExternalMock },
}));
vi.mock('./ExternalMcpOverview', () => ({
  default: () => <div data-testid="external-mcp-overview" />,
}));

describe('McpToolsConfig remote behavior', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    peerState.active = true;
    runtimeState.desktop = true;
    getServersMock.mockReset().mockResolvedValue([]);
    loadJsonConfigMock.mockReset().mockResolvedValue({
      jsonConfig: '{"mcpServers":{}}',
      fingerprint: 'sha256:test',
    });
    saveJsonConfigMock.mockReset().mockResolvedValue({ runtimeApplied: true });
    initializeServersMock.mockReset().mockResolvedValue(undefined);
    startServerMock.mockReset().mockResolvedValue(undefined);
    restartServerMock.mockReset().mockResolvedValue(undefined);
    startRemoteOAuthMock.mockReset().mockResolvedValue({
      serverId: 'notion',
      status: 'awaitingBrowser',
      authorizationUrl: 'https://mcp.notion.test/authorize',
      redirectUri: 'http://127.0.0.1:31337/callback',
      message: 'Authorization started',
    });
    getRemoteOAuthSessionMock.mockReset().mockResolvedValue(null);
    cancelRemoteOAuthMock.mockReset().mockResolvedValue(undefined);
    openExternalMock.mockReset().mockResolvedValue(undefined);
    deleteServerMock.mockReset().mockResolvedValue(undefined);
    confirmDangerMock.mockReset().mockResolvedValue(true);
    notificationMocks.success.mockReset();
    notificationMocks.warning.mockReset();
    notificationMocks.error.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('does not call desktop MCP management APIs during a remote connection', async () => {
    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getServersMock).not.toHaveBeenCalled();
    expect(loadJsonConfigMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('section.serverList.remoteUnavailable');

    peerState.active = false;
    runtimeState.desktop = false;
    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
    });

    expect(getServersMock).not.toHaveBeenCalled();
    expect(loadJsonConfigMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('section.serverList.desktopUnavailable');

    runtimeState.desktop = true;
    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
    });

    expect(getServersMock).toHaveBeenCalledTimes(1);
    expect(loadJsonConfigMock).toHaveBeenCalledTimes(1);
  });

  async function changeField(field: string, value: string) {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(`input[data-mcp-field="${field}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function changeTextarea(testId: string, value: string) {
    await act(async () => {
      const input = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('adds a disabled server through the form against the original snapshot', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]')!.click());
    await changeField('name', 'Team Docs');
    await changeField('url', 'https://example.test/mcp');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(saveJsonConfigMock).toHaveBeenCalledTimes(1);
    expect(saveJsonConfigMock.mock.calls[0][1]).toBe('sha256:test');
    expect(JSON.parse(saveJsonConfigMock.mock.calls[0][0]).mcpServers['team-docs']).toMatchObject({
      name: 'Team Docs', url: 'https://example.test/mcp', transport: 'streamable-http', enabled: false,
    });
    expect(startServerMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="mcp-form-save"]')).toBeNull();
  });

  it('keeps a form draft and its fingerprint when another surface changes configuration', async () => {
    peerState.active = false;
    saveJsonConfigMock.mockRejectedValue(new Error('User MCP configuration changed before write'));
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]')!.click());
    await changeField('name', 'My draft');
    await changeField('url', 'https://example.test/mcp');
    await act(async () => { globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }); });
    expect(loadJsonConfigMock).toHaveBeenCalledTimes(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(saveJsonConfigMock.mock.calls[0][1]).toBe('sha256:test');
    expect(document.querySelector<HTMLInputElement>('[data-mcp-field="name"]')!.value).toBe('My draft');
    expect(document.body.textContent).toContain('visual.saveFailed');
    expect(notificationMocks.success).not.toHaveBeenCalled();
  });

  it('opens advanced JSON from an unfinished form and saves a new server disabled', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-switch-editor"]')!.click());
    expect(document.querySelector('[data-testid="mcp-server-json"]')).not.toBeNull();
    await changeField('id', 'advanced-service');
    await changeTextarea('mcp-server-json', '{"command":"server","enabled":true,"future":{"preserve":true}}');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(JSON.parse(saveJsonConfigMock.mock.calls[0][0]).mcpServers['advanced-service']).toEqual({
      command: 'server', enabled: false, future: { preserve: true },
    });
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it('preserves JSON-only fields and hidden credentials after returning to the form', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]')!.click());
    await changeField('name', 'New service');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-switch-editor"]')!.click());
    await changeField('id', 'custom-service');
    await changeTextarea('mcp-server-json', '{"command":"server","env":{"KEY":"secret"},"enabled":true,"future":[1,2]}');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-switch-editor"]')!.click());
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    await changeField('name', 'Updated name');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(JSON.parse(saveJsonConfigMock.mock.calls[0][0]).mcpServers['custom-service']).toEqual({
      name: 'Updated name', command: 'server', env: { KEY: 'secret' }, enabled: false, future: [1, 2],
    });
  });

  it('retains advanced fields when collapsed and reopens them to focus a validation error', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]')!.click());
    await changeField('name', 'Docs');
    await changeField('url', 'https://example.test/mcp');
    const advanced = document.querySelector('.mcp-config-editor__advanced')!;
    const trigger = advanced.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const region = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(region.hasAttribute('inert')).toBe(true);
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);
    await changeField('startupSeconds', '0');
    await act(async () => trigger.click());
    const timeout = document.querySelector<HTMLInputElement>('[data-mcp-field="startupSeconds"]')!;
    expect(timeout.value).toBe('0');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    vi.useFakeTimers();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    await act(async () => vi.advanceTimersByTime(20));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(timeout);
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it('edits one service without changing another server, unknown fields, or its identity', async () => {
    peerState.active = false;
    const entry = { command: 'original', env: { SECRET: 'keep' }, future: { preserve: true } };
    loadJsonConfigMock.mockResolvedValue({ jsonConfig: JSON.stringify({ mcpServers: { native: entry, other: { command: 'other' } } }), fingerprint: 'sha256:edit' });
    getServersMock.mockResolvedValue([{ id: 'native', name: 'native', status: 'Stopped', serverType: 'local', transport: 'stdio', enabled: true, autoStart: false, startSupported: true }]);
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-edit-server"]')!.click());
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
    await changeField('name', 'New display name');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(JSON.parse(saveJsonConfigMock.mock.calls[0][0])).toEqual({ mcpServers: {
      native: { ...entry, name: 'New display name' }, other: { command: 'other' },
    } });
  });

  it('imports only previewed selections and does not start imported programs', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-import-config"]')!.click());
    await act(async () => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-testid="mcp-import-input"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '{"mcpServers":{"tools":{"command":"npx","args":["example"],"enabled":true}}}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-import-preview"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(JSON.parse(saveJsonConfigMock.mock.calls[0][0]).mcpServers.tools.enabled).toBe(false);
    expect(startServerMock).not.toHaveBeenCalled();
  });

  it('clears an import conflict after changing the target ID without overwriting the existing service', async () => {
    peerState.active = false;
    loadJsonConfigMock.mockResolvedValue({
      jsonConfig: '{"mcpServers":{"docs":{"command":"original"}}}', fingerprint: 'sha256:import',
    });
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-import-config"]')!.click());
    await changeTextarea('mcp-import-input', '{"mcpServers":{"docs":{"command":"new"}}}');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-import-preview"]')!.click());
    await act(async () => document.querySelector<HTMLInputElement>('.mcp-config-editor input[type="checkbox"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
    expect(document.querySelector('.mcp-config-editor [role="alert"]')?.textContent).toBe('visual.errors.idConflict');
    await changeField('id', 'separate-docs');
    expect(document.querySelector('.mcp-config-editor [role="alert"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mcp-form-save"]')!.click());
    expect(JSON.parse(saveJsonConfigMock.mock.calls[0][0]).mcpServers).toEqual({
      docs: { command: 'original' }, 'separate-docs': { command: 'new', enabled: false },
    });
  });

  it('retains pasted import content when reading a file fails', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-import-config"]')!.click());
    const pasted = '{"mcpServers":{"docs":{"command":"server"}}}';
    await changeTextarea('mcp-import-input', pasted);
    const file = new File([''], 'unreadable.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: () => Promise.reject(new Error('Read failed')) });
    await act(async () => {
      const picker = document.querySelector<HTMLInputElement>('.mcp-config-editor input[type="file"]')!;
      Object.defineProperty(picker, 'files', { value: [file] });
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="mcp-import-input"]')!.value).toBe(pasted);
    expect(document.querySelector('.mcp-config-editor [role="alert"]')?.textContent).toBe('visual.fileReadFailed');
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it('drops the local form when the controlled device changes', async () => {
    peerState.active = false;
    await act(async () => root.render(<McpToolsConfig />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]')!.click());
    await changeField('name', 'Local draft');
    peerState.active = true;
    await act(async () => root.render(<McpToolsConfig />));
    expect(document.querySelector('[data-testid="mcp-form-save"]')).toBeNull();
    expect(container.textContent).toContain('section.serverList.remoteUnavailable');
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it('ignores a desktop MCP load that finishes after switching to a remote connection', async () => {
    let resolveServers: ((servers: Array<Record<string, unknown>>) => void) | undefined;
    getServersMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveServers = resolve;
    }));
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
    });
    peerState.active = true;
    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveServers?.([{
        id: 'local-test',
        name: 'Local test server',
        status: 'Stopped',
        serverType: 'local',
        transport: 'stdio',
        enabled: true,
        autoStart: false,
        startSupported: true,
      }]);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Local test server');
    expect(container.textContent).toContain('section.serverList.remoteUnavailable');
  });

  it('updates an already mounted list after external import and undo without a remount', async () => {
    peerState.active = false;
    await act(async () => { root.render(<McpToolsConfig />); });
    getServersMock.mockResolvedValue([{ id: 'imported', name: 'Imported docs', status: 'Stopped', serverType: 'local', transport: 'stdio', enabled: false, autoStart: false, startSupported: true }]);
    await act(async () => { globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }); });
    expect(container.textContent).toContain('Imported docs');
    getServersMock.mockResolvedValue([]);
    await act(async () => { globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }); });
    expect(container.textContent).not.toContain('Imported docs');
    expect(getServersMock).toHaveBeenCalledTimes(3);
    await act(async () => { globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'peer-device' }); });
    expect(getServersMock).toHaveBeenCalledTimes(3);
  });

  it('keeps unsaved JSON and its original fingerprint when another page changes MCP', async () => {
    peerState.active = false;
    await act(async () => { root.render(<McpToolsConfig />); });
    await act(async () => { (container.querySelector('[aria-label="actions.jsonConfig"]') as HTMLButtonElement).click(); });
    const textarea = container.querySelector('textarea')!;
    const draft = '{"mcpServers":{"draft":{"command":"docs"}}}';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, draft);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    loadJsonConfigMock.mockResolvedValue({ jsonConfig: '{"mcpServers":{"other":{"command":"other"}}}', fingerprint: 'new' });
    await act(async () => { globalEventBus.emit(MCP_CONFIG_CHANGED, { surfaceId: 'local' }); });
    expect(textarea.value).toBe(draft);
    expect(loadJsonConfigMock).toHaveBeenCalledTimes(1);
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'actions.saveConfig')!.click(); });
    expect(saveJsonConfigMock).toHaveBeenCalledWith(draft, 'sha256:test');
  });

  it('shows a retryable failure instead of an empty native MCP list', async () => {
    getServersMock.mockRejectedValueOnce(new Error('load failed'));
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('section.serverList.loadFailed');
    const retry = container.querySelector('[aria-label="actions.refresh"]') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getServersMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('section.serverList.loadFailed');
  });

  it.each(['Failed', 'Reconnecting'])('keeps %s server cards stable while polling and observes recovery', async (status) => {
    vi.useFakeTimers();
    peerState.active = false;
    const server = {
      id: 'auto-start',
      name: 'Auto-start server',
      status,
      serverType: 'local',
      transport: 'stdio',
      enabled: true,
      autoStart: true,
      commandAvailable: true,
      startSupported: true,
    };
    let resolveServers!: (servers: typeof server[]) => void;
    getServersMock.mockImplementation(() => new Promise((resolve) => {
      resolveServers = resolve;
    }));

    await act(async () => root.render(<McpToolsConfig />));
    expect(container.textContent).toContain('loading');
    await act(async () => resolveServers([server]));
    const card = container.querySelector('[data-testid="mcp-server-item"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain(`status.${status.toLowerCase()}`);

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(getServersMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="mcp-server-item"]')).toBe(card);
    expect(container.textContent).not.toContain('loading');
    expect(card?.textContent).toContain(`status.${status.toLowerCase()}`);

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(getServersMock).toHaveBeenCalledTimes(2);
    await act(async () => resolveServers([{ ...server, status: 'Connected' }]));
    expect(container.querySelector('[data-testid="mcp-server-item"]')).toBe(card);
    expect(card?.textContent).toContain('status.connected');
    expect(container.textContent).not.toContain('loading');
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(getServersMock).toHaveBeenCalledTimes(2);
  });

  it('retains stale data and its warning until a background refresh succeeds', async () => {
    vi.useFakeTimers();
    peerState.active = false;
    const server = {
      id: 'auto-start',
      name: 'Auto-start server',
      status: 'Failed',
      serverType: 'local',
      transport: 'stdio',
      enabled: true,
      autoStart: true,
      commandAvailable: true,
      startSupported: true,
    };
    let resolveRefresh!: (servers: typeof server[]) => void;
    getServersMock
      .mockResolvedValueOnce([server])
      .mockRejectedValueOnce(new Error('MCP status temporarily unavailable'))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRefresh = resolve;
      }));

    await act(async () => root.render(<McpToolsConfig />));
    const card = container.querySelector('[data-testid="mcp-server-item"]');
    expect(card).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toContain('external.status.stale');

    const retry = container.querySelector<HTMLButtonElement>('[aria-label="actions.refresh"]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());
    expect(getServersMock).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('external.status.stale');
    expect(container.textContent).not.toContain('loading');
    expect(container.querySelector('[data-testid="mcp-server-item"]')).toBe(card);

    await act(async () => resolveRefresh([{ ...server, status: 'Connected' }]));
    expect(container.textContent).not.toContain('external.status.stale');
    expect(card?.textContent).toContain('status.connected');
  });

  it('does not replace an unreadable MCP config with example JSON', async () => {
    loadJsonConfigMock.mockRejectedValueOnce(new Error('config unavailable'));
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const openEditor = container.querySelector(
      '[aria-label="actions.jsonConfig"]',
    ) as HTMLButtonElement;
    await act(async () => openEditor.click());

    expect(container.textContent).toContain('jsonEditor.loadFailed');
    expect(container.querySelector('.openbitfun-mcp-tools__json-textarea')).toBeNull();
    expect(container.textContent).not.toContain('example-server');

    const retry = container.querySelector('[aria-label="actions.refresh"]') as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadJsonConfigMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('jsonEditor.loadFailed');
    expect(container.querySelector('.openbitfun-mcp-tools__json-textarea')).not.toBeNull();
  });

  it('saves the JSON editor against the fingerprint that was loaded with it', async () => {
    peerState.active = false;
    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      (container.querySelector('[aria-label="actions.jsonConfig"]') as HTMLButtonElement).click();
    });
    const textarea = container.querySelector(
      '.openbitfun-mcp-tools__json-textarea textarea',
    ) as HTMLTextAreaElement;
    const editedJson = '{\n  "mcpServers": {}\n}';
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setValue?.call(textarea, editedJson);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'actions.saveConfig',
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveJsonConfigMock).toHaveBeenCalledWith(editedJson, 'sha256:test');
    expect(initializeServersMock).not.toHaveBeenCalled();
  });

  it('clears a persisted draft and reloads its fingerprint when runtime application fails', async () => {
    peerState.active = false;
    saveJsonConfigMock.mockResolvedValue({ runtimeApplied: false });
    await act(async () => { root.render(<McpToolsConfig />); });
    await act(async () => {
      (container.querySelector('[data-testid="mcp-json-toggle"]') as HTMLButtonElement).click();
    });
    const editedJson = '{"mcpServers":{"offline":{"url":"http://127.0.0.1:9999/mcp"}}}';
    await act(async () => {
      const textarea = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, editedJson);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    loadJsonConfigMock.mockResolvedValue({ jsonConfig: editedJson, fingerprint: 'sha256:saved' });
    await act(async () => {
      (container.querySelector('[data-testid="mcp-json-save"]') as HTMLButtonElement).click();
    });
    expect(notificationMocks.error).not.toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalled();
    expect(notificationMocks.warning).toHaveBeenCalledWith('messages.partialStartFailed', expect.anything());
    expect(loadJsonConfigMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('textarea')).toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="mcp-json-toggle"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('textarea')!.value).toBe(editedJson);
    expect((container.querySelector('[data-testid="mcp-json-save"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      const textarea = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, editedJson + '\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="mcp-json-save"]') as HTMLButtonElement).click();
    });
    expect(saveJsonConfigMock).toHaveBeenLastCalledWith(editedJson + '\n', 'sha256:saved');
  });

  it('retains the editor and draft when persistence fails', async () => {
    peerState.active = false;
    saveJsonConfigMock.mockRejectedValue(new Error('Failed to save config: permission denied'));
    await act(async () => { root.render(<McpToolsConfig />); });
    await act(async () => {
      (container.querySelector('[data-testid="mcp-json-toggle"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      const textarea = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '{"mcpServers":{}}\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="mcp-json-save"]') as HTMLButtonElement).click();
    });
    expect(notificationMocks.error).toHaveBeenCalled();
    expect(notificationMocks.warning).not.toHaveBeenCalled();
    expect(notificationMocks.success).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')!.value).toBe('{"mcpServers":{}}\n');
    expect(loadJsonConfigMock).toHaveBeenCalledTimes(1);
  });

  it('offers start rather than stop for an uninitialized server', async () => {
    getServersMock.mockResolvedValueOnce([{
      id: 'local-test',
      name: 'Local test server',
      status: 'Uninitialized',
      serverType: 'local',
      transport: 'stdio',
      enabled: true,
      autoStart: false,
      commandAvailable: true,
      startSupported: true,
    }]);
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="actions.start"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="actions.stop"]')).toBeNull();
  });

  it('coalesces repeated clicks while a start is pending and ignores completion after capability loss', async () => {
    let resolveStart: (() => void) | undefined;
    startServerMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveStart = resolve;
    }));
    getServersMock.mockResolvedValueOnce([{
      id: 'local-test',
      name: 'Local test server',
      status: 'Stopped',
      serverType: 'local',
      transport: 'stdio',
      enabled: true,
      autoStart: false,
      commandAvailable: true,
      startSupported: true,
    }]);
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const startButton = Array.from(container.querySelectorAll('button')).find((button) => (
      button.getAttribute('aria-label') === 'actions.start'
      || button.getAttribute('title') === 'actions.start'
    ));
    expect(startButton).toBeDefined();
    await act(async () => {
      startButton?.click();
      startButton?.click();
      await Promise.resolve();
    });
    expect(startServerMock).toHaveBeenCalledTimes(1);
    expect((startButton as HTMLButtonElement).disabled).toBe(true);
    peerState.active = true;
    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveStart?.();
      await Promise.resolve();
    });

    expect(notificationMocks.success).not.toHaveBeenCalled();
    expect(notificationMocks.error).not.toHaveBeenCalled();
    expect(getServersMock).toHaveBeenCalledTimes(1);
  });

  it.each(['start', 'restart'])('respects disabled OAuth when a failed remote server is asked to %s', async (action) => {
    peerState.active = false;
    getServersMock.mockResolvedValue([{
      id: 'public-remote',
      name: 'Public remote MCP',
      status: 'Failed',
      serverType: 'Remote',
      transport: 'streamable-http',
      enabled: true,
      autoStart: false,
      authConfigured: false,
      oauthEnabled: false,
      startSupported: true,
    }]);
    const actionMock = action === 'start' ? startServerMock : restartServerMock;
    await act(async () => root.render(<McpToolsConfig />));
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="mcp-server-${action}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());

    expect(actionMock).toHaveBeenCalledWith('public-remote');
    expect(startRemoteOAuthMock).not.toHaveBeenCalled();
    expect(getRemoteOAuthSessionMock).not.toHaveBeenCalled();
    expect(openExternalMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-openbitfun-part="authEditor"]')).toBeNull();

    // A genuine authentication error may offer manual credentials, but must
    // still never start OAuth or render its controls when explicitly disabled.
    actionMock.mockRejectedValueOnce(new Error('status code: 401 Unauthorized'));
    await act(async () => button?.click());
    expect(document.querySelector('[data-openbitfun-part="authEditor"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('modal.remoteOAuthDescription');
    expect(document.body.textContent).not.toContain('actions.startRemoteOAuth');
    expect(startRemoteOAuthMock).not.toHaveBeenCalled();
    expect(getRemoteOAuthSessionMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains the auth dialog through its exit and supports reopening (OAuth: %s)', async (oauthEnabled) => {
    vi.useFakeTimers();
    peerState.active = false;
    getServersMock.mockResolvedValue([{
      id: 'notion',
      name: 'Notion',
      status: 'Failed',
      serverType: 'Remote',
      transport: 'streamable-http',
      url: 'https://mcp.notion.test/mcp',
      enabled: true,
      autoStart: false,
      authConfigured: false,
      oauthEnabled,
      startSupported: true,
    }]);
    startServerMock.mockRejectedValue(new Error('status code: 401 Unauthorized'));
    await act(async () => root.render(<McpToolsConfig />));
    const start = container.querySelector<HTMLButtonElement>('[data-testid="mcp-server-start"]')!;
    await act(async () => start.click());
    const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const editor = surface.querySelector('[data-openbitfun-part="authEditor"]');
    const contents = surface.textContent;
    expect(editor).not.toBeNull();
    if (oauthEnabled) {
      expect(contents).toContain('modal.remoteOAuthRedirectUri');
      expect(contents).toContain('modal.remoteOAuthStatus');
    }

    await act(async () => surface.querySelector<HTMLButtonElement>('[data-openbitfun-part="close"]')!.click());
    expect(surface.dataset.state).toBe('exiting');
    expect(surface.getAttribute('aria-hidden')).toBe('true');
    expect(surface.querySelector('[data-openbitfun-part="authEditor"]')).toBe(editor);
    expect(surface.textContent).toBe(contents);
    expect(cancelRemoteOAuthMock).toHaveBeenCalledTimes(oauthEnabled ? 1 : 0);
    // Retained status must not leave the server's start action disabled.
    expect(start.disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(90));
    await act(async () => start.click());
    expect(surface.dataset.state).toBe('open');
    await act(async () => vi.advanceTimersByTime(180));
    expect(document.querySelector('[role="dialog"]')).toBe(surface);

    await act(async () => surface.querySelector<HTMLButtonElement>('[data-openbitfun-part="close"]')!.click());
    await act(async () => vi.advanceTimersByTime(179));
    expect(surface.isConnected).toBe(true);
    expect(surface.textContent).toBe(contents);
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('starts OAuth directly for an unauthorized remote server without reporting a start failure', async () => {
    getServersMock.mockResolvedValueOnce([{
      id: 'notion',
      name: 'Notion',
      status: 'Uninitialized',
      serverType: 'Remote',
      transport: 'streamable-http',
      enabled: true,
      autoStart: false,
      authConfigured: false,
      oauthEnabled: true,
      startSupported: true,
    }]);
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const startButton = container.querySelector<HTMLButtonElement>('[data-testid="mcp-server-start"]');
    await act(async () => {
      startButton?.click();
      startButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startServerMock).not.toHaveBeenCalled();
    expect(startRemoteOAuthMock).toHaveBeenCalledTimes(1);
    expect(startRemoteOAuthMock).toHaveBeenCalledWith({ serverId: 'notion' });
    expect(openExternalMock).toHaveBeenCalledWith('https://mcp.notion.test/authorize');
    expect(getRemoteOAuthSessionMock).not.toHaveBeenCalled();
    expect(notificationMocks.error).not.toHaveBeenCalled();
    expect(document.querySelector('[data-openbitfun-part="authEditor"]')).not.toBeNull();
  });

  it('reauthorizes after an auth handshake challenge without reporting a start failure', async () => {
    startServerMock.mockRejectedValueOnce(new Error(
      'Handshake failed: Auth required, when send initialize request',
    ));
    getServersMock.mockResolvedValueOnce([{
      id: 'notion',
      name: 'Notion',
      status: 'NeedsAuth',
      serverType: 'Remote',
      transport: 'streamable-http',
      enabled: true,
      autoStart: false,
      authConfigured: true,
      oauthEnabled: true,
      startSupported: true,
    }]);
    peerState.active = false;

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const startButton = container.querySelector<HTMLButtonElement>('[data-testid="mcp-server-start"]');
    await act(async () => {
      startButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(startServerMock).toHaveBeenCalledWith('notion');
    expect(startRemoteOAuthMock).toHaveBeenCalledWith({ serverId: 'notion' });
    expect(notificationMocks.error).not.toHaveBeenCalled();
    expect(document.querySelector('[data-openbitfun-part="authEditor"]')).not.toBeNull();
  });

  it('deletes a server after confirmation and reloads the list', async () => {
    peerState.active = false;
    const server = {
      id: 'local-test',
      name: 'Local test server',
      status: 'Stopped',
      serverType: 'local',
      transport: 'stdio',
      enabled: true,
      autoStart: false,
      commandAvailable: true,
      startSupported: true,
    };
    getServersMock
      .mockResolvedValueOnce([server])
      .mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<McpToolsConfig />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const deleteButton = container.querySelector<HTMLButtonElement>('[aria-label="actions.delete"]');
    expect(deleteButton).not.toBeNull();
    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirmDangerMock).toHaveBeenCalledWith(
      'actions.delete',
      'messages.deleteConfirm',
      { confirmText: 'actions.delete', cancelText: 'actions.cancel' },
    );
    expect(deleteServerMock).toHaveBeenCalledWith({ serverId: 'local-test' });
    expect(getServersMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Local test server');
  });
});
