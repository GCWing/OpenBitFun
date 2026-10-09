// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import AcpAgentsConfigPage, { type AcpAgentsConfigHandle } from './AcpAgentsConfig';
import {
  discardAndContinueSettingsNavigation,
  getSettingsDraftSnapshot,
  requestSettingsNavigation,
  resetSettingsDraftRegistryForTests,
} from '@/infrastructure/config/settingsDraftRegistry';

const AcpAgentsConfig = () => <AcpAgentsConfigPage navigationRequestId={0} />;

const loadJsonConfigMock = vi.hoisted(() => vi.fn());
const getClientsMock = vi.hoisted(() => vi.fn());
const probeClientRequirementsMock = vi.hoisted(() => vi.fn());
const saveJsonConfigMock = vi.hoisted(() => vi.fn());
const installClientCliMock = vi.hoisted(() => vi.fn());
const predownloadClientAdapterMock = vi.hoisted(() => vi.fn());
const listSavedConnectionsMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const notifyInfoMock = vi.hoisted(() => vi.fn());
const notifySuccessMock = vi.hoisted(() => vi.fn());
const translate = (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
  options?.defaultValue ?? _key
);

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: translate,
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  ConfirmDialog: ({
    cancelText,
    confirmText,
    message,
    onConfirm,
    onOpenChange,
    onSecondary,
    open,
    secondaryText,
    title,
  }: {
    cancelText?: string;
    confirmText: string;
    message: React.ReactNode;
    onConfirm: () => void;
    onOpenChange: (open: false) => void;
    onSecondary?: () => void;
    open: boolean;
    secondaryText?: string;
    title: string;
  }) => open ? (
    <div role="dialog">
      <h2>{title}</h2>
      <div>{message}</div>
      <button type="button" data-testid="confirm-install" onClick={onConfirm}>
        {confirmText}
      </button>
      {onSecondary ? <button type="button" onClick={onSecondary}>{secondaryText}</button> : null}
      {cancelText ? <button type="button" onClick={() => onOpenChange(false)}>{cancelText}</button> : null}
    </div>
  ) : null,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Button: ({
    children,
    disabled,
    isLoading,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    isLoading?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled || isLoading} onClick={onClick}>
      {children}
    </button>
  ),
  IconButton: ({
    children,
    disabled,
    isLoading,
    onClick,
    tooltip: _tooltip,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children: React.ReactNode;
    isLoading?: boolean;
    tooltip?: React.ReactNode;
  }) => (
    <button type="button" disabled={disabled || isLoading} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Input: ({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    placeholder?: string;
  }) => <input value={value} onChange={onChange} placeholder={placeholder} />,
  TabGroup: ({
    items,
    onValueChange,
    value,
  }: {
    items: Array<{ label: React.ReactNode; value: string }>;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <div role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  Textarea: React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
    (props, ref) => <textarea ref={ref} {...props} />,
  ),
}));

vi.mock('./common', () => ({
  formatStandaloneUiText: (text: string) => text.replace(/[。.]$/, ''),
  ConfigRefreshButton: ({ tooltip, onClick }: { tooltip: string; onClick: () => void }) => (
    <button type="button" aria-label={tooltip} onClick={onClick}>{tooltip}</button>
  ),
  ConfigLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  ConfigMessage: ({ message }: { message: { text: string } | null }) => (
    message ? <div>{message.text}</div> : null
  ),
  ConfigRetryState: ({ message, onRetry, retryLabel }: {
    message: string;
    onRetry: () => void;
    retryLabel: string;
  }) => (
    <div>
      <span>{message}</span>
      <button type="button" onClick={onRetry}>{retryLabel}</button>
    </div>
  ),
  ConfigPageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfigPageHeader: ({ title, subtitle, extra }: {
    title: string;
    subtitle: string;
    extra?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {extra}
    </header>
  ),
  ConfigPageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  ConfigPageSectionStack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfigPageSection: ({
    children,
    title,
    description,
    extra,
  }: {
    children: React.ReactNode;
    title: string;
    description?: string;
    extra?: React.ReactNode;
  }) => (
    <section>
      <div>
        <h2>{title}</h2>
        {extra}
      </div>
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ),
}));

vi.mock('../../api/service-api/ACPClientAPI', () => ({
  ACPClientAPI: {
    loadJsonConfig: loadJsonConfigMock,
    getClients: getClientsMock,
    probeClientRequirements: probeClientRequirementsMock,
    installClientCli: installClientCliMock,
    predownloadClientAdapter: predownloadClientAdapterMock,
    saveJsonConfig: saveJsonConfigMock,
  },
}));

vi.mock('../../api/service-api/SystemAPI', () => ({
  systemAPI: {
    openExternal: vi.fn(),
  },
}));

vi.mock('@/features/ssh-remote/sshApi', () => ({
  sshApi: {
    listSavedConnections: listSavedConnectionsMock,
  },
}));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({
    error: notifyErrorMock,
    info: notifyInfoMock,
    success: notifySuccessMock,
  }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

async function openView(container: HTMLElement, label: string): Promise<void> {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    .find(button => button.textContent === label);
  expect(tab).toBeTruthy();
  await act(async () => {
    tab?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectPermission(container: HTMLElement, value: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-openbitfun-part="confirmation"] button[role="combobox"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  expect(options.map(option => option.dataset.value)).toEqual(['ask', 'allow_once']);
  const selected = options.find(option => option.dataset.value === value);
  expect(selected).toBeTruthy();
  await act(async () => selected!.click());
}

describe('AcpAgentsConfig', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    loadJsonConfigMock.mockResolvedValue(JSON.stringify({
      acpClients: {
        opencode: {
          name: 'opencode',
          command: 'opencode',
          args: ['acp'],
          env: {},
          enabled: true,
          readonly: false,
          permissionMode: 'ask',
        },
      },
    }));
    getClientsMock.mockResolvedValue([{
      id: 'opencode',
      name: 'opencode',
      command: 'opencode',
      args: ['acp'],
      enabled: true,
      readonly: false,
      permissionMode: 'ask',
      status: 'configured',
      sessionCount: 0,
      toolName: 'acp__opencode__prompt',
    }]);
    listSavedConnectionsMock.mockResolvedValue([]);
    probeClientRequirementsMock.mockResolvedValue([]);
    saveJsonConfigMock.mockImplementation(async () => {
      window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
    });
    installClientCliMock.mockResolvedValue(undefined);
    predownloadClientAdapterMock.mockResolvedValue(undefined);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    container?.remove();
    resetSettingsDraftRegistryForTests();
    vi.clearAllMocks();
  });

  it('closes a clean dialog without saving configuration', async () => {
    const manager = React.createRef<AcpAgentsConfigHandle>();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<AcpAgentsConfigPage ref={manager} presentation="dialog" onClose={onClose} />);
    });

    act(() => manager.current?.requestClose());

    expect(onClose).toHaveBeenCalledOnce();
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it('retains dialog edits on cancel or failed save, and closes only after a successful save', async () => {
    const manager = React.createRef<AcpAgentsConfigHandle>();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<AcpAgentsConfigPage ref={manager} presentation="dialog" clientIds={['opencode']} onClose={onClose} />);
    });
    await selectPermission(container, 'allow_once');
    act(() => manager.current?.requestClose());
    expect(onClose).not.toHaveBeenCalled();

    const guardButton = (label: string) => Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === label)!;
    await act(async () => guardButton('settings:changeGuard.keepEditing').click());
    expect(container.textContent).not.toContain('settings:changeGuard.title');
    expect(onClose).not.toHaveBeenCalled();

    act(() => manager.current?.requestClose());
    saveJsonConfigMock.mockRejectedValueOnce(new Error('Save failed'));
    await act(async () => guardButton('settings:changeGuard.saveAndLeave').click());
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('settings:changeGuard.title');
    expect(notifyErrorMock).toHaveBeenCalled();

    await act(async () => guardButton('settings:changeGuard.saveAndLeave').click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(JSON.parse(saveJsonConfigMock.mock.calls[1][0]).acpClients.opencode.permissionMode).toBe('allow_once');
  });

  it('discards dialog edits only after the user chooses to leave without saving', async () => {
    const manager = React.createRef<AcpAgentsConfigHandle>();
    const onClose = vi.fn();
    await act(async () => {
      root.render(<AcpAgentsConfigPage ref={manager} presentation="dialog" clientIds={['opencode']} onClose={onClose} />);
    });
    await selectPermission(container, 'allow_once');
    act(() => manager.current?.requestClose());

    const discard = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'settings:changeGuard.discardAndLeave')!;
    await act(async () => discard.click());

    expect(onClose).toHaveBeenCalledOnce();
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ask', 'ask'],
    ['allow_once', 'allow_once'],
  ])('loads and saves permission mode %s as %s with only supported choices', async (storedMode, expectedMode) => {
    loadJsonConfigMock.mockResolvedValue(JSON.stringify({
      acpClients: {
        opencode: { command: 'opencode', args: ['acp'], permissionMode: storedMode },
      },
    }));

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    expect(container.textContent).not.toContain('permissionMode.legacyRejectWarning');
    await selectPermission(container, expectedMode);
    expect(saveJsonConfigMock).not.toHaveBeenCalled();

    await openView(container, 'views.json');
    const editor = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        ?.call(editor, `${editor.value}\n`);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'actions.saveJson');
    expect(saveButton?.disabled).toBe(false);
    await act(async () => {
      saveButton!.click();
    });

    const savedConfig = JSON.parse(saveJsonConfigMock.mock.calls[0][0]);
    expect(savedConfig.acpClients.opencode).toMatchObject({
      command: 'opencode', args: ['acp'], permissionMode: expectedMode,
    });
  });

  it.each([
    ['local', true],
    ['ssh', true],
    ['json', true],
    ['local', false],
  ])('explicitly applies a legacy permission from %s (wrapped config: %s)', async (view, wrapped) => {
    const legacyClient = {
      command: 'opencode', args: ['acp'], env: { ACP_TEST: 'preserved' }, permissionMode: 'reject_once',
    };
    const otherClient = { command: 'custom-agent', args: [], permissionMode: 'allow_once' };
    const acpClients = { opencode: legacyClient, custom: otherClient };
    loadJsonConfigMock.mockResolvedValue(JSON.stringify(wrapped ? { acpClients } : acpClients));
    saveJsonConfigMock.mockImplementation(async (rawConfig: string) => {
      loadJsonConfigMock.mockResolvedValue(rawConfig);
      window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
    });

    await act(async () => root.render(<AcpAgentsConfig />));
    expect(container.querySelector('[data-openbitfun-part="confirmation"]')?.textContent)
      .toContain('permissionMode.ask');
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('permissionMode.legacyRejectWarning');
    expect(saveJsonConfigMock).not.toHaveBeenCalled();

    // The real Select does not emit a change when Ask is already selected.
    await selectPermission(container, 'ask');
    expect(Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'actions.save')).toBeUndefined();
    if (view !== 'local') await openView(container, `views.${view}`);
    expect(saveJsonConfigMock).not.toHaveBeenCalled();

    const applyButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'permissionMode.saveAndApply');
    expect(applyButton?.disabled).toBe(false);
    await act(async () => applyButton!.click());

    expect(saveJsonConfigMock).toHaveBeenCalledTimes(1);
    const savedConfig = JSON.parse(saveJsonConfigMock.mock.calls[0][0]);
    expect(savedConfig.acpClients.opencode).toMatchObject({ ...legacyClient, permissionMode: 'ask' });
    expect(savedConfig.acpClients.custom).toMatchObject(otherClient);
    expect(container.textContent).not.toContain('permissionMode.legacyRejectWarning');
    expect(container.textContent).not.toContain('permissionMode.saveAndApply');

    await act(async () => {
      window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
    });
    expect(container.textContent).not.toContain('permissionMode.legacyRejectWarning');
    expect(saveJsonConfigMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the migration action after a failed save and applies the current selection on retry', async () => {
    loadJsonConfigMock.mockResolvedValue(JSON.stringify({
      acpClients: { opencode: { command: 'opencode', permissionMode: 'reject_once' } },
    }));
    saveJsonConfigMock.mockRejectedValueOnce(new Error('Save failed'));
    await act(async () => root.render(<AcpAgentsConfig />));
    await selectPermission(container, 'allow_once');
    const applyButton = () => Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'permissionMode.saveAndApply');

    await act(async () => applyButton()!.click());
    expect(notifyErrorMock).toHaveBeenCalledWith('Save failed', expect.anything());
    expect(container.textContent).toContain('permissionMode.legacyRejectWarning');
    expect(applyButton()?.disabled).toBe(false);

    await act(async () => applyButton()!.click());
    expect(saveJsonConfigMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(saveJsonConfigMock.mock.calls[1][0]).acpClients.opencode.permissionMode)
      .toBe('allow_once');
    expect(container.textContent).not.toContain('permissionMode.legacyRejectWarning');
  });

  it('limits an embedded ecosystem view to its own clients and hides the aggregate JSON editor', async () => {
    await act(async () => root.render(<AcpAgentsConfigPage clientIds={['codex']} />));
    expect(container.textContent).toContain('Codex');
    expect(container.textContent).not.toContain('Claude Code');
    expect(container.textContent).not.toContain('OpenCode');
    expect(container.textContent).not.toContain('views.json');
  });

  it('probes requirements when opened and does not treat missing probe data as invalid config', async () => {
    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadJsonConfigMock).toHaveBeenCalledTimes(1);
    expect(getClientsMock).toHaveBeenCalledTimes(1);
    expect(probeClientRequirementsMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('registry.configInvalid');
  });

  it('omits the redundant CLI capability column from local agent rows', async () => {
    probeClientRequirementsMock.mockResolvedValue([{
      id: 'opencode',
      tool: { name: 'opencode', installed: false },
      runnable: false,
      notes: [],
    }]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const row = Array.from(
      container.querySelectorAll('.openbitfun-acp-agents__registry-row'),
    ).find(candidate => candidate.querySelector('.openbitfun-acp-agents__registry-name')
      ?.textContent === 'opencode');
    expect(row).toBeTruthy();

    const status = row?.querySelector(
      '[data-openbitfun-component="status-pill"][data-openbitfun-state="not_installed"]',
    );

    expect(row?.querySelector('[data-openbitfun-part="capabilities"]')).toBeNull();
    expect(row?.querySelectorAll('[data-openbitfun-component="status-pill"]')).toHaveLength(1);
    expect(status?.getAttribute('data-tone')).toBe('neutral');
  });

  it('keeps page help and agent detection with their owning surfaces', async () => {
    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('header')?.textContent).toContain('actions.learnMore');
    expect(container.querySelector('header')?.textContent).not.toContain('registry.description');
    const registryHeading = Array.from(container.querySelectorAll('h3'))
      .find(heading => heading.textContent === 'registry.title');
    const registrySection = registryHeading?.closest('section');
    expect(registrySection?.textContent).toContain('actions.refresh');
    expect(registrySection?.textContent).toContain('presets.opencode.description');
    expect(registrySection?.textContent).toContain('registry.description');
    expect(registrySection?.textContent).not.toContain('Native ACP coding agent');
  });

  it('separates local agents, SSH hosts, and advanced JSON into focused views', async () => {
    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('registry.title');
    expect(container.textContent).not.toContain('remote.title');
    expect(container.textContent).not.toContain('security.secretWarning');

    await openView(container, 'views.ssh');
    expect(container.textContent).toContain('remote.title');
    expect(container.textContent).not.toContain('registry.title');

    await openView(container, 'views.json');
    expect(container.textContent).toContain('json.title');
    expect(container.textContent).toContain('security.secretWarning');
    expect(container.textContent).not.toContain('registry.title');
    expect(container.textContent).not.toContain('remote.title');
  });

  it('registers advanced JSON changes with the shared settings navigation guard', async () => {
    await act(async () => {
      root.render(<AcpAgentsConfigPage navigationRequestId={0} settingsDraftEnabled />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await openView(container, 'views.json');
    const editor = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(editor).not.toBeNull();

    await act(async () => {
      if (!editor) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(editor, `${editor.value}\n`);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const commit = vi.fn();
    expect(requestSettingsNavigation(
      { pageId: 'tools.external-agents', viewId: 'json' },
      { kind: 'settings', pageId: 'tools.external-agents', viewId: 'local' },
      commit,
    )).toBe(false);
    expect(getSettingsDraftSnapshot().pendingNavigation?.resourceLabels).toEqual([
      'json.title',
    ]);

    await act(async () => {
      await discardAndContinueSettingsNavigation();
      await Promise.resolve();
    });

    expect(commit).toHaveBeenCalledOnce();
    expect(getSettingsDraftSnapshot().pendingNavigation).toBeNull();
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it('keeps the ecosystem compatibility fallback guard without registering a Settings draft', async () => {
    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await openView(container, 'views.json');
    const editor = container.querySelector<HTMLTextAreaElement>('textarea');
    expect(editor).not.toBeNull();
    await act(async () => {
      if (!editor) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        editor,
        `${editor.value}\n`,
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const commit = vi.fn();
    expect(requestSettingsNavigation(
      { pageId: 'tools.external-agents', viewId: 'json' },
      { kind: 'settings', pageId: 'tools.external-agents', viewId: 'local' },
      commit,
    )).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(getSettingsDraftSnapshot().resources).toHaveLength(0);

    const beforeUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await openView(container, 'views.local');
    expect(container.textContent).toContain('json.discardTitle');
    expect(container.textContent).toContain('json.title');

    const discardButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-install"]',
    );
    await act(async () => {
      discardButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('registry.title');
    expect(container.textContent).not.toContain('json.title');
    expect(saveJsonConfigMock).not.toHaveBeenCalled();
  });

  it('renders saved remote servers as global agent rows without override controls', async () => {
    listSavedConnectionsMock.mockResolvedValue([{
      id: 'huawei-server',
      name: 'huawei-server',
      host: '119.8.182.138',
      port: 22,
      username: 'ssh-root',
      authType: { type: 'Password' },
    }]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('huawei-server');
    await openView(container, 'views.ssh');

    expect(container.textContent).toContain('huawei-server');
    expect(container.textContent).toContain('ssh-root@119.8.182.138');
    expect(container.textContent).toContain('remote.refreshDetection');
    expect(container.textContent).not.toContain('remote.env');
    expect(probeClientRequirementsMock).toHaveBeenCalledWith({
      remoteConnectionId: 'huawei-server',
      force: undefined,
    });
  });

  it('hides a saved remote server without deleting its SSH connection', async () => {
    listSavedConnectionsMock.mockResolvedValue([{
      id: 'huawei-server',
      name: 'Huawei Server',
      host: '119.8.182.138',
      port: 22,
      username: 'ssh-root',
      authType: { type: 'Password' },
    }]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await openView(container, 'views.ssh');

    const hideButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="remote.hideConnection"]'
    );
    expect(hideButton).not.toBeNull();

    await act(async () => {
      hideButton?.click();
      await Promise.resolve();
    });

    expect(listSavedConnectionsMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Huawei Server');
    expect(JSON.parse(localStorage.getItem('openbitfun:settings:acp-agents:hidden-remote-connections:v1') || '[]'))
      .toEqual(['huawei-server']);
    expect(container.textContent).toContain('remote.showHiddenConnections');
  });

  it('restores a hidden remote server from the hidden list', async () => {
    localStorage.setItem(
      'openbitfun:settings:acp-agents:hidden-remote-connections:v1',
      JSON.stringify(['huawei-server'])
    );
    listSavedConnectionsMock.mockResolvedValue([{
      id: 'huawei-server',
      name: 'Huawei Server',
      host: '119.8.182.138',
      port: 22,
      username: 'ssh-root',
      authType: { type: 'Password' },
    }]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await openView(container, 'views.ssh');

    const showHiddenButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('remote.showHiddenConnections'));
    expect(showHiddenButton).not.toBeUndefined();

    await act(async () => {
      showHiddenButton?.click();
      await Promise.resolve();
    });

    const restoreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="remote.restoreConnection"]'
    );
    expect(restoreButton).not.toBeNull();

    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(localStorage.getItem('openbitfun:settings:acp-agents:hidden-remote-connections:v1'))
      .toBe('[]');
    expect(container.textContent).toContain('Huawei Server');
  });

  it('does not probe hidden remote servers until they are restored', async () => {
    localStorage.setItem(
      'openbitfun:settings:acp-agents:hidden-remote-connections:v1',
      JSON.stringify(['huawei-server'])
    );
    listSavedConnectionsMock.mockResolvedValue([{
      id: 'huawei-server',
      name: 'Huawei Server',
      host: '119.8.182.138',
      port: 22,
      username: 'ssh-root',
      authType: { type: 'Password' },
    }]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await openView(container, 'views.ssh');

    expect(probeClientRequirementsMock).not.toHaveBeenCalledWith({
      remoteConnectionId: 'huawei-server',
      force: undefined,
    });
  });

  it('configures a preset adapter when the CLI is ready but the ACP layer is missing', async () => {
    probeClientRequirementsMock.mockResolvedValue([
      {
        id: 'opencode',
        tool: { name: 'opencode', installed: true },
        runnable: true,
        notes: [],
      },
      {
        id: 'claude-code',
        tool: { name: 'claude', installed: true },
        adapter: { name: '@agentclientprotocol/claude-agent-acp', installed: false },
        runnable: false,
        notes: [],
      },
      {
        id: 'codex',
        tool: { name: 'codex', installed: true },
        adapter: { name: '@agentclientprotocol/codex-acp', installed: false },
        runnable: false,
        notes: [],
      },
    ]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const refreshButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.refresh'));
    expect(refreshButtons.length).toBeGreaterThan(0);

    await act(async () => {
      refreshButtons[0].click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const configureButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.configureAcp'));
    expect(configureButtons.length).toBeGreaterThan(0);

    await act(async () => {
      configureButtons[configureButtons.length - 1].click();
      await Promise.resolve();
    });

    expect(predownloadClientAdapterMock).toHaveBeenCalledWith({
      clientId: 'codex',
    });
  });

  it('keeps enabled agents stable when adding another preset', async () => {
    const healthyProbes = [
      {
        id: 'opencode',
        tool: { name: 'opencode', installed: true },
        runnable: true,
        notes: [],
      },
      {
        id: 'claude-code',
        tool: { name: 'claude', installed: true },
        adapter: { name: '@agentclientprotocol/claude-agent-acp', installed: true },
        runnable: true,
        notes: [],
      },
      {
        id: 'codex',
        tool: { name: 'codex', installed: true },
        runnable: true,
        notes: [],
      },
    ];
    probeClientRequirementsMock.mockResolvedValue(healthyProbes);
    saveJsonConfigMock.mockImplementation(async () => {
      window.dispatchEvent(new Event('openbitfun:acp-clients-changed'));
      loadJsonConfigMock.mockResolvedValue(JSON.stringify({
        acpClients: {
          opencode: {
            name: 'opencode',
            command: 'opencode',
            args: ['acp'],
            env: {},
            enabled: true,
            readonly: false,
            permissionMode: 'ask',
          },
          'claude-code': {
            name: 'Claude Code',
            command: 'npx',
            args: ['--yes', '@agentclientprotocol/claude-agent-acp@latest'],
            env: {},
            enabled: true,
            readonly: false,
            permissionMode: 'ask',
          },
          codex: {
            name: 'Codex',
            command: 'npx',
            args: ['--yes', '@agentclientprotocol/codex-acp@latest'],
            env: {},
            enabled: true,
            readonly: false,
            permissionMode: 'ask',
          },
        },
      }));
    });

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('registry.enabled');

    const addButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.add'));
    expect(addButtons.length).toBeGreaterThan(0);

    await act(async () => {
      addButtons[addButtons.length - 1].click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveJsonConfigMock).toHaveBeenCalled();
    expect(container.textContent).toContain('registry.enabled');
    expect(container.textContent).not.toContain('registry.cliMissing');
    expect(container.textContent).not.toContain('registry.configInvalid');
  });

  it('labels self-managed missing CLIs as config-only before adding', async () => {
    probeClientRequirementsMock.mockResolvedValue([
      {
        id: 'opencode',
        tool: { name: 'opencode', installed: true },
        runnable: true,
        notes: [],
      },
      {
        id: 'omp',
        tool: { name: 'omp', installed: false },
        runnable: false,
        notes: ['omp is not available on PATH'],
      },
    ]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const addConfigButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.addConfig'));
    expect(addConfigButtons.length).toBeGreaterThan(0);

    await act(async () => {
      addConfigButtons[0].click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(installClientCliMock).not.toHaveBeenCalled();
    expect(saveJsonConfigMock).toHaveBeenCalledWith(expect.stringContaining('"omp"'));
    expect(notifySuccessMock).toHaveBeenCalledWith('notifications.configAddedManualCliRequired');
  });

  it('offers the one-click installer for DeepSeek Harness and launches the bundled profile', async () => {
    probeClientRequirementsMock.mockResolvedValue([
      {
        id: 'dsh',
        tool: { name: 'dsh', installed: false },
        runnable: false,
        notes: ['dsh is not available on PATH'],
      },
    ]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('DeepSeek Harness');
    // Unlike omp, the harness is a plain npm global, so OpenBitFun installs it.
    // The bridge is not a separate adapter — it ships inside OpenBitFun.
    expect(container.textContent).not.toContain('registry.adapterMissing');

    const installButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.installCli'));
    expect(installButtons.length).toBeGreaterThan(0);

    await act(async () => {
      installButtons[0].click();
      await Promise.resolve();
    });
    const confirmInstall = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-install"]',
    );
    expect(confirmInstall).not.toBeNull();
    await act(async () => {
      confirmInstall?.click();
      await Promise.resolve();
    });

    expect(installClientCliMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'dsh' }),
    );
  });

  it('adds DeepSeek Harness as a launch of the profile OpenBitFun materializes', async () => {
    probeClientRequirementsMock.mockResolvedValue([
      {
        id: 'dsh',
        tool: { name: 'dsh', installed: true, version: '0.1.0-rc.6' },
        runnable: true,
        notes: [],
      },
    ]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Address the harness row by name: row order is whatever the saved config
    // and the preset list happen to produce, so "the last add button" belongs
    // to some other agent as often as not.
    const harnessRow = Array.from(
      container.querySelectorAll('.openbitfun-acp-agents__registry-row'),
    ).find(row => row.querySelector('.openbitfun-acp-agents__registry-name')
      ?.textContent === 'DeepSeek Harness');
    expect(harnessRow).toBeTruthy();

    const addButton = Array.from(harnessRow!.querySelectorAll('button'))
      .find(button => button.textContent?.includes('actions.add'));
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The command has to name the profile OpenBitFun materializes; a bare `dsh`
    // would drop the user into the harness's own default composition, which
    // does not speak ACP at all.
    expect(saveJsonConfigMock).toHaveBeenCalledWith(expect.stringContaining('openbitfun-acp'));
  });

  it('does not downgrade enabled agents on transient probe timeouts during refresh', async () => {
    probeClientRequirementsMock
      .mockResolvedValueOnce([
        {
          id: 'opencode',
          tool: { name: 'opencode', installed: true },
          runnable: true,
          notes: [],
        },
        {
          id: 'claude-code',
          tool: { name: 'claude', installed: true },
          adapter: { name: '@agentclientprotocol/claude-agent-acp', installed: true },
          runnable: true,
          notes: [],
        },
        {
          id: 'codex',
          tool: { name: 'codex', installed: true },
          runnable: true,
          notes: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'opencode',
          tool: {
            name: 'opencode',
            installed: false,
            error: 'Timed out while checking command',
          },
          runnable: false,
          notes: [],
        },
        {
          id: 'claude-code',
          tool: { name: 'claude', installed: true },
          adapter: { name: '@agentclientprotocol/claude-agent-acp', installed: true },
          runnable: true,
          notes: [],
        },
        {
          id: 'codex',
          tool: { name: 'codex', installed: true },
          runnable: true,
          notes: [],
        },
      ]);

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const refreshButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.refresh'));
    expect(refreshButtons.length).toBeGreaterThan(0);

    await act(async () => {
      refreshButtons[0].click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('registry.enabled');
    expect(container.textContent).not.toContain('registry.cliMissing');
  });

  it('installs a missing remote preset CLI on that remote server', async () => {
    listSavedConnectionsMock.mockResolvedValue([{
      id: 'huawei-server',
      name: 'huawei-server',
      host: '119.8.182.138',
      port: 22,
      username: 'ssh-root',
      authType: { type: 'Password' },
    }]);
    probeClientRequirementsMock.mockImplementation((options?: { remoteConnectionId?: string }) => {
      if (options?.remoteConnectionId === 'huawei-server') {
        return Promise.resolve([
          {
            id: 'opencode',
            tool: { name: 'opencode', installed: true },
            runnable: true,
            notes: [],
          },
          {
            id: 'claude-code',
            tool: { name: 'claude', installed: true },
            runnable: true,
            notes: [],
          },
          {
            id: 'codex',
            tool: { name: 'codex', installed: false },
            runnable: false,
            notes: [],
          },
        ]);
      }
      return Promise.resolve([]);
    });

    await act(async () => {
      root.render(<AcpAgentsConfig />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await openView(container, 'views.ssh');

    const installButtons = Array.from(container.querySelectorAll('button'))
      .filter(button => button.textContent?.includes('actions.installCli'));
    expect(installButtons.length).toBeGreaterThan(0);

    await act(async () => {
      installButtons[installButtons.length - 1].click();
      await Promise.resolve();
    });
    const confirmInstall = container.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-install"]',
    );
    expect(confirmInstall).not.toBeNull();
    await act(async () => {
      confirmInstall?.click();
      await Promise.resolve();
    });

    expect(installClientCliMock).toHaveBeenCalledWith({
      clientId: 'codex',
      remoteConnectionId: 'huawei-server',
    });
  });
});
