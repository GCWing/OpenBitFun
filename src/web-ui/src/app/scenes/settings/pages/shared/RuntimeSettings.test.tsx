// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceControlSettingsPage from '../tools/DeviceControlSettingsPage';
import ExecutionSettingsPage from '../ai/ExecutionSettingsPage';
import WorkspaceSearchSection from '../development/WorkspaceSearchSection';

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, '__TAURI__', { configurable: true, value: {} });
  return {
    invoke: vi.fn(), setConfig: vi.fn(), setEnabled: vi.fn(), getConfig: vi.fn(), error: vi.fn(),
    t: (key: string) => key,
    workspace: null as { workspaceKind: string } | null,
  };
});
vi.mock('@/infrastructure/config/hooks', () => ({ useAIExperienceSettings: () => ({ settings: { enable_workspace_search: true }, isLoading: false, error: null, reload: vi.fn() }) }));
vi.mock('@/infrastructure/api', () => ({ globalAPI: {}, workspaceAPI: {} }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({ useCurrentWorkspace: () => ({ workspace: mocks.workspace }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { formatNumber: String },
  useI18n: () => ({ t: mocks.t }),
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: mocks.invoke } }));
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: { getSystemInfo: async () => ({ platform: 'macos' }) } }));
vi.mock('../../../../../infrastructure/config/services/ConfigManager', () => ({ configManager: { hasCachedConfig: () => false, getCachedConfig: () => undefined,
  getConfig: mocks.getConfig, getOptionalConfig: async () => true, setConfig: mocks.setConfig,
} }));
vi.mock('../../../../../infrastructure/config/hooks/useComputerUseEnabled', () => ({ useComputerUseEnabled: () => ({ computerUseEnabled: false, setComputerUseEnabled: mocks.setEnabled }) }));
vi.mock('../../../../../infrastructure/config/services/AIExperienceConfigService', () => ({ aiExperienceConfigService: { getCachedSettings: () => null, getSettingsAsync: async () => ({ enable_workspace_search: true }) } }));
vi.mock('../../../../../infrastructure/config/services/AgentCompanionPetService', () => ({ DEFAULT_AGENT_COMPANION_PET: 'default' }));
vi.mock('../../../../../infrastructure/config/services/PermissionConfigService', async (original) => ({
  ...await original<typeof import('../../../../../infrastructure/config/services/PermissionConfigService')>(),
  permissionConfigService: { getConfig: async () => ({}) },
}));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => null }));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: vi.fn() }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({}), notificationService: { dismiss: vi.fn(), success: vi.fn(), error: mocks.error, info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../../../../infrastructure/config/components/GlobalPermissionRulesDialog', () => ({ GlobalPermissionRulesDialog: () => null }));
vi.mock('../ai/SessionTitleSection', () => ({ default: () => null }));
vi.mock('../ai/DefaultHarnessSection', () => ({ default: () => <div>default-harness-config</div> }));
vi.mock('../ai/ReviewCapacitySection', () => ({ default: () => null }));
vi.mock('../ai/ToolJsonRepairSection', () => ({ default: () => null }));
vi.mock('@openbitfun/ui', async (original) => ({
  ...await original<typeof import('@openbitfun/ui')>(),
  Select: ({ value, options, disabled, onValueChange }: { value: string; options: Array<{ value: string; label: string }>; disabled: boolean; onValueChange?: (value: string) => void }) => (
    <select value={value} disabled={disabled} onChange={event => onValueChange?.(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  ),
}));

const readyStatus = { cdpAvailable: false, defaultCdpSupported: true, defaultCdpEnabled: true, browserReady: true, browserKind: 'Chrome', browserVersion: '146', pageCount: 3 };
let status = { ...readyStatus };
let container: HTMLDivElement;
let root: Root;
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(el => el.textContent === label || el.getAttribute('aria-label') === label)!;
const render = async () => { await act(async () => root.render(<DeviceControlSettingsPage />)); };

beforeEach(() => {
  mocks.workspace = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  status = { ...readyStatus };
  mocks.getConfig.mockReset().mockResolvedValue(null);
  mocks.setConfig.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'computer_use_get_status') return { computerUseEnabled: false, accessibilityGranted: true, screenCaptureGranted: false, platformNote: null };
    if (command === 'browser_control_get_status') return { ...status };
    if (command === 'browser_control_list_browsers') return { options: [{ value: 'default', label: 'Default browser', installed: true }] };
    return { success: true, status: 'connected', browserKind: 'Chrome' };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

describe('Tool execution concurrency settings', () => {
  const concurrencyInput = (label: string) => Array.from(container.querySelectorAll('[data-openbitfun-part="row"]'))
    .find(row => row.textContent?.includes(label))!.querySelector('input')!;

  async function editAndBlur(input: HTMLInputElement, value: string) {
    await act(async () => input.focus());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.blur());
  }

  it.each([
    ['config.subagentMaxConcurrency', 'ai.subagent_max_concurrency', '50', 32],
    ['config.swarmMaxConcurrency', 'ai.swarm_max_concurrency', '100', 64],
    ['config.subagentMaxConcurrency', 'ai.subagent_max_concurrency', '20', 20],
    ['config.subagentMaxConcurrency', 'ai.subagent_max_concurrency', '5.5', 6],
    ['config.swarmMaxConcurrency', 'ai.swarm_max_concurrency', '0', 1],
  ])('saves a supported integer for %s when entering %s / %s', async (label, path, draft, expected) => {
    await act(async () => root.render(<ExecutionSettingsPage />));
    const input = concurrencyInput(label);
    await editAndBlur(input, draft);
    expect(mocks.setConfig).toHaveBeenCalledWith(path, expected);
    expect(input.value).toBe(String(expected));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('preserves an existing value outside the current save range until it is edited', async () => {
    mocks.getConfig.mockImplementation(async (path: string) => path === 'ai.subagent_max_concurrency' ? 50 : null);
    await act(async () => root.render(<ExecutionSettingsPage />));
    expect(concurrencyInput('config.subagentMaxConcurrency').value).toBe('50');
    expect(mocks.setConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['config.subagentMaxConcurrency', 5],
    ['config.swarmMaxConcurrency', 16],
  ])('restores the saved value and exposes the host error for %s', async (label, previous) => {
    mocks.setConfig.mockRejectedValue(new Error('Host rejected the concurrency setting'));
    await act(async () => root.render(<ExecutionSettingsPage />));
    const input = concurrencyInput(label);
    await editAndBlur(input, '20');
    expect(input.value).toBe(String(previous));
    expect(mocks.error).toHaveBeenCalledWith('messages.saveFailed: Host rejected the concurrency setting');
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Browser and desktop control settings', () => {
  it('keeps detailed host permissions in the standard compact settings rows', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === 'computer_use_get_status'
      ? { computerUseEnabled: true, accessibilityGranted: true, screenCaptureGranted: true,
        platformNote: 'Accessibility is available.', permissions: { process_id: 1234,
          executable: '/private/runtime', permissions: [{ kind: 'input_monitoring', state: 'granted' }] } }
      : original(command, ...args));
    await render();
    for (const label of ['computerUse.enable', 'computerUse.accessibility', 'computerUse.screenCapture']) {
      expect(Array.from(container.querySelectorAll('[data-openbitfun-part="row"]'))
        .some(row => row.textContent?.includes(label))).toBe(true);
    }
    expect(container.textContent).not.toContain('computerSharing');
    expect(container.textContent).not.toContain('/private/runtime');
    expect(container.textContent).not.toContain('input_monitoring');
    expect(button('computerUse.openSettings')).toBeUndefined();
    expect(container.textContent).not.toContain('computerUse.platformNotes.macos');
    expect(mocks.invoke.mock.calls.filter(([name]) => String(name).startsWith('computer_use_share'))).toHaveLength(0);
  });

  it('offers system setup only for the missing permission without selecting an app', async () => {
    await render();
    const setup = button('computerUse.openSettings');
    expect(setup.closest('[data-openbitfun-part="row"]')?.textContent).toContain('computerUse.screenCapture');
    expect(Array.from(container.querySelectorAll('button')).filter(el => el.textContent === 'computerUse.openSettings')).toHaveLength(1);
    await act(async () => setup.click());
    expect(mocks.invoke).toHaveBeenCalledWith('computer_use_open_system_settings', { request: { pane: 'screen_capture' } });
    expect(mocks.invoke).not.toHaveBeenCalledWith('computer_use_request_permission', expect.anything());
  });

  it('registers the missing OS permission from the same setup button on capable hosts', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => command === 'computer_use_get_status'
      ? { computerUseEnabled: true, accessibilityGranted: true, screenCaptureGranted: false,
        permissions: { permissions: [{ kind: 'screen_recording', requestable: true }] } }
      : command === 'computer_use_request_permission' ? { current_granted: false }
        : original(command, ...args));
    await render();
    expect(mocks.invoke).not.toHaveBeenCalledWith('computer_use_request_permission', expect.anything());
    await act(async () => button('computerUse.openSettings').click());
    expect(mocks.invoke).toHaveBeenCalledWith('computer_use_request_permission', { request: { kind: 'screen_recording' } });
    expect(mocks.invoke).toHaveBeenCalledWith('computer_use_open_system_settings', { request: { pane: 'screen_capture' } });
    expect(mocks.invoke.mock.calls.filter(([name]) => String(name).startsWith('computer_use_share'))).toHaveLength(0);
  });
  it('localizes the browser choice and puts the single connect action next to connection status', async () => {
    await render();
    expect(container.querySelector('option')?.textContent).toBe('browserControl.defaultBrowser');
    const connect = button('browserControl.connect');
    expect(connect.closest('[data-openbitfun-part="row"]')?.textContent).toContain('browserControl.status');
    expect(container.textContent).toContain('browserControl.readyNotConnected');
    expect(Array.from(container.querySelectorAll('button')).filter(el => el.textContent === 'browserControl.connect')).toHaveLength(1);
    await act(async () => connect.click());
    expect(mocks.invoke).toHaveBeenCalledWith('browser_control_enable_default_cdp', expect.anything());
  });

  it('uses the existing launch path when the browser cannot reuse its current profile', async () => {
    status.defaultCdpSupported = false;
    await render();
    await act(async () => button('browserControl.connect').click());
    expect(mocks.invoke).toHaveBeenCalledWith('browser_control_launch', { request: { port: 9222 } });
    expect(mocks.invoke).not.toHaveBeenCalledWith('browser_control_enable_default_cdp', expect.anything());
  });

  it.each([false, true])('revokes previous browser access before saving a new choice (disconnect fails: %s)', async (fails) => {
    const original = mocks.invoke.getMockImplementation()!;
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (command: string, ...args: unknown[]) => {
      if (command === 'browser_control_list_browsers') return { options: [
        { value: 'default', label: 'Default browser', installed: true },
        { value: 'edge', label: 'Edge', installed: true },
      ] };
      if (command === 'browser_control_disconnect') {
        order.push('disconnect');
        if (fails) throw new Error('Disconnect failed');
      }
      return original(command, ...args);
    });
    mocks.setConfig.mockImplementation(async () => { order.push('save'); });
    await render();
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'edge';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(order).toEqual(fails ? ['disconnect'] : ['disconnect', 'save']);
    if (fails) {
      expect(mocks.setConfig).not.toHaveBeenCalled();
      expect(select.value).toBe('default');
    } else {
      expect(mocks.setConfig).toHaveBeenCalledWith('ai.browser_control_preferred_browser', 'edge');
    }
  });

  it('keeps the selected browser visible while connected and disconnects through the existing command', async () => {
    status.cdpAvailable = true;
    await render();
    expect(container.querySelector('select')?.disabled).toBe(true);
    expect(container.textContent).toContain('browserControl.connected');
    expect(container.textContent).toContain('Chrome · 3');
    await act(async () => button('browserControl.disconnect').click());
    expect(mocks.invoke).toHaveBeenCalledWith('browser_control_disconnect', expect.anything());
  });

  it('does not show stale connected status as current after a refresh fails', async () => {
    status.cdpAvailable = true;
    await render();
    mocks.invoke.mockRejectedValue(new Error('Host is offline'));
    await act(async () => button('browserControl.refreshStatus').click());
    const connectionRow = button('browserControl.disconnect').closest('[data-openbitfun-part="row"]');
    expect(connectionRow?.textContent).toContain('browserControl.statusUnavailable');
    expect(connectionRow?.textContent).not.toContain('browserControl.connected');
    expect(button('browserControl.disconnect').disabled).toBe(true);
    expect(button('browserControl.refreshStatus').disabled).toBe(false);
  });

  it('retains an explicit unsupported state when a CLI peer rejects control commands', async () => {
    mocks.invoke.mockRejectedValue(new Error('Command is not supported on CLI peer host'));
    await render();
    expect(container.textContent).toContain('computerUse.peerUnsupported');
    expect(container.textContent).toContain('browserControl.peerUnsupported');
    expect(container.querySelector('select')).toBeNull();
  });
});


describe('Flashgrep settings availability', () => {
  it.each(['normal', 'remote'])('only exposes indexing for local workspaces (%s)', async (workspaceKind) => {
    mocks.workspace = { workspaceKind };
    await act(async () => root.render(<WorkspaceSearchSection />));
    expect(container.textContent?.includes('features.workspaceSearch.enable')).toBe(workspaceKind === 'normal');
  });
});
