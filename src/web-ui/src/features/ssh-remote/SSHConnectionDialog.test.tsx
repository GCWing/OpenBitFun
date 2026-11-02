// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSHConnectionDialog } from './SSHConnectionDialog';
import type { WorkspaceConnectionTarget } from './types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/infrastructure/api/service-api/RemoteConnectAPI', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/api/service-api/RemoteConnectAPI')>(),
  remoteConnectAPI: { getDeviceInfo: async () => ({ device_id: 'local', device_name: 'Workstation' }) },
}));

const sshApiMock = vi.hoisted(() => ({
  listSavedConnections: vi.fn(),
  listSSHConfigHosts: vi.fn(),
  getSSHConfig: vi.fn(),
  listWslDistributions: vi.fn(),
  listDockerContainers: vi.fn().mockResolvedValue([]),
}));

const remoteContextMock = vi.hoisted(() => ({
  connect: vi.fn(),
  clearError: vi.fn(),
}));

const authFilePickerMock = vi.hoisted(() => ({
  pickSshPrivateKeyPath: vi.fn(),
  pickSshCertificatePath: vi.fn(),
}));

vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});

vi.mock('./SSHRemoteContext', () => ({
  useSSHRemoteContext: () => ({
    connect: remoteContextMock.connect,
    status: 'disconnected',
    connectionError: null,
    clearError: remoteContextMock.clearError,
  }),
}));

vi.mock('./sshApi', () => ({
  sshApi: sshApiMock,
}));

vi.mock('./pickSshPrivateKeyPath', () => ({
  ...authFilePickerMock,
}));

vi.mock('./SSHAuthPromptDialog', () => ({
  SSHAuthPromptDialog: () => null,
}));

vi.mock('@openbitfun/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Icon: ({ name, ...props }: { name: string } & React.HTMLAttributes<HTMLSpanElement>) => <span data-icon={name} {...props} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  Dialog: ({
    open,
    children,
  }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren<{ separator?: boolean }>) => (
    <footer>{children}</footer>
  ),
  DialogClose: () => <button type="button" aria-label="Close" />,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogHeading: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  Button: ({
    children,
    leadingIcon: _leadingIcon,
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    leadingIcon?: React.ReactNode;
    loading?: boolean;
  }) => <button type="button" {...props}>{children}</button>,
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  Input: ({
    leading,
    trailing,
    size: _size,
    hideNativePasswordReveal: _hideNativePasswordReveal,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    hideNativePasswordReveal?: boolean;
  }) => <label>{leading}<input {...props} />{trailing}</label>,
  Combobox: ({ value, onValueChange, placeholder, 'aria-label': label }: {
    value: string; onValueChange: (value: string) => void; placeholder: string; 'aria-label'?: string;
  }) => <input aria-label={label} placeholder={placeholder} value={value} onChange={event => onValueChange(event.target.value)} />,
  Select: ({
    options,
    value,
    onValueChange,
    'aria-label': label,
  }: {
    'aria-label'?: string;
    options: Array<{ label: string; value: string }>;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ScrollArea: ({ children, scrollbarVisibility, ...props }: React.HTMLAttributes<HTMLDivElement> & { scrollbarVisibility?: string }) => <div data-scrollbar-visibility={scrollbarVisibility} {...props}>{children}</div>,
  FormSection: ({
    children,
    title,
    actions,
    ...props
  }: React.HTMLAttributes<HTMLElement> & { title?: React.ReactNode; actions?: React.ReactNode; headingAs?: string }) => (
    <section {...props}>
      {title}
      {actions}
      {children}
    </section>
  ),
  FieldGroup: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function FieldGroup({ children, ...props }, ref) {
      return <div ref={ref} {...props}>{children}</div>;
    },
  ),
  FieldRow: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  // The real Field associates its label with the child control; the mock
  // mirrors that accessible name via aria-label so queries stay realistic.
  Field: ({
    label,
    labelAction,
    error,
    children,
  }: { label?: React.ReactNode; labelAction?: React.ReactNode; error?: React.ReactNode; children: React.ReactElement }) => (
    <div>
      {labelAction}
      {React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        'aria-label': typeof label === 'string' ? label : undefined,
      })}
      {error}
    </div>
  ),
}));

describe('SSHConnectionDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sshApiMock.listSavedConnections.mockResolvedValue([]);
    sshApiMock.listSSHConfigHosts.mockResolvedValue([]);
    sshApiMock.getSSHConfig.mockResolvedValue({ found: false });
    sshApiMock.listWslDistributions.mockResolvedValue({ supported: true, distributions: ['Ubuntu', 'Debian'] });
    authFilePickerMock.pickSshPrivateKeyPath.mockResolvedValue(null);
    authFilePickerMock.pickSshCertificatePath.mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function renderDialog(onClose = vi.fn(), initialTargetType?: WorkspaceConnectionTarget): Promise<void> {
    await act(async () => {
      root.render(<SSHConnectionDialog open onClose={onClose} initialTargetType={initialTargetType} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function setInputValue(label: string, value: string): void {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function setSelectValue(select: HTMLSelectElement | null, value: string): void {
    expect(select).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, value);
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function sourceOption(dimension: number, value: string): HTMLButtonElement {
    return container.querySelectorAll('[role="radiogroup"]')[dimension]
      .querySelector<HTMLButtonElement>(`[data-openbitfun-value="${value}"]`)!;
  }

  function selectTarget(target: WorkspaceConnectionTarget): void {
    act(() => sourceOption(0, target === 'localDocker' || target === 'wsl' ? 'current' : 'other').click());
    act(() => sourceOption(1, target === 'wsl' ? 'wsl' : target === 'ssh' ? 'system' : 'container').click());
    if (target === 'containerSshd') {
      setSelectValue(container.querySelector('select[aria-label="workspaceSource.containerConnection"]'), target);
    }
  }

  function expectTarget(target: WorkspaceConnectionTarget): void {
    expect(sourceOption(0, target === 'localDocker' || target === 'wsl' ? 'current' : 'other').getAttribute('aria-checked')).toBe('true');
    expect(sourceOption(1, target === 'wsl' ? 'wsl' : target === 'ssh' ? 'system' : 'container').getAttribute('aria-checked')).toBe('true');
    if (target === 'containerSshd' || target === 'remoteDocker') {
      expect(container.querySelector<HTMLSelectElement>('select[aria-label="workspaceSource.containerConnection"]')?.value).toBe(target);
    }
  }

  function openAdvanced(): void {
    const toggle = container.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]')!;
    if (toggle.getAttribute('aria-expanded') !== 'true') act(() => toggle.click());
  }

  function useSavedConnections(): void {
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][data-openbitfun-value="saved"]')!;
    act(() => tab.click());
  }

  function findConnectButton(): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('ssh.remote.connect'));
  }

  it.each(['ssh', 'wsl', 'localDocker', 'remoteDocker', 'containerSshd'] as const)(
    'opens the %s form requested by project creation', async target => {
      await renderDialog(vi.fn(), target);
      expectTarget(target);
      if (target === 'wsl') {
        expect(sshApiMock.listWslDistributions).toHaveBeenCalled();
        expect(container.querySelector('input[aria-label="ssh.remote.host"]')).toBeNull();
      } else if (target === 'localDocker') {
        expect(sshApiMock.listWslDistributions).toHaveBeenCalled();
      } else {
        expect(sshApiMock.listWslDistributions).not.toHaveBeenCalled();
      }
    },
  );

  it('uses the newly requested source after closing a different connection form', async () => {
    const onClose = vi.fn();
    await renderDialog(onClose, 'wsl');
    await act(async () => root.render(<SSHConnectionDialog open={false} onClose={onClose} initialTargetType="wsl" />));
    await renderDialog(onClose, 'localDocker');
    expectTarget('localDocker');
    expect(container.querySelector('input[aria-label="ssh.remote.wslUser"]')).toBeNull();
    expect(container.querySelector('input[placeholder="ssh.remote.containerNamePlaceholder"]')).not.toBeNull();
  });

  it('keeps optional connection fields collapsed for a new connection', async () => {
    await renderDialog();

    const toggle = container.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('input[aria-label="ssh.remote.connectionName"]')).toBeNull();
    expect(container.querySelector('input[aria-label="ssh.remote.proxyJump"]')).toBeNull();

    act(() => {
      toggle?.click();
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('input[aria-label="ssh.remote.connectionName"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="ssh.remote.proxyJump"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="ssh.remote.connectTimeout"]')).not.toBeNull();
  });

  it('uses native select controls inside the dialog', async () => {
    await renderDialog();

    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select'));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((select) => container.contains(select))).toBe(true);
  });

  it('reveals non-default settings when editing an existing connection', async () => {
    sshApiMock.listSavedConnections.mockResolvedValue([
      {
        id: 'ssh-dev@example.test',
        name: 'Development',
        host: 'example.test',
        port: 22,
        username: 'dev',
        authType: { type: 'PrivateKey', keyPath: '/keys/dev' },
        proxyJump: 'jump.example.test',
        options: {
          connectTimeoutSecs: 45,
          authTimeoutSecs: 60,
          authAttempts: 3,
          connectAttempts: 2,
        },
      },
    ]);

    await renderDialog();
    const editButton = container.querySelector<HTMLButtonElement>('button[aria-label^="actions.edit"]');

    act(() => {
      editButton?.click();
    });

    const toggle = container.querySelector<HTMLButtonElement>('[data-openbitfun-component="disclosure"] button[aria-expanded]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.proxyJump"]')?.value
    ).toBe('jump.example.test');
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.connectAttempts"]')?.value
    ).toBe('2');
  });

  it('selects an OpenSSH certificate with the native file picker', async () => {
    authFilePickerMock.pickSshCertificatePath.mockResolvedValue('/keys/dev-cert.pub');
    sshApiMock.listSavedConnections.mockResolvedValue([
      {
        id: 'ssh-dev@example.test',
        name: 'dev@example.test',
        host: 'example.test',
        port: 22,
        username: 'dev',
        authType: { type: 'PrivateKey', keyPath: '/keys/dev' },
      },
    ]);
    await renderDialog();

    const editButton = container.querySelector<HTMLButtonElement>('button[aria-label^="actions.edit"]');
    act(() => {
      editButton?.click();
    });

    openAdvanced();
    const browseCertificate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="ssh.remote.browseCertificate"]'
    );
    expect(browseCertificate).not.toBeNull();
    await act(async () => {
      browseCertificate?.click();
      await Promise.resolve();
    });

    expect(authFilePickerMock.pickSshCertificatePath).toHaveBeenCalledWith({
      title: 'ssh.remote.pickCertificateDialogTitle',
    });
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.certificatePath"]')?.value
    ).toBe('/keys/dev-cert.pub');
  });

  it.each(['22abc', '22.5', '2e2', '', '0', '65536'])(
    'rejects the complete invalid port value %j before connecting', async port => {
      await renderDialog();
      setInputValue('ssh.remote.host', 'example.test');
      setInputValue('ssh.remote.username', 'dev');
      setInputValue('ssh.remote.password', 'secret');
      setInputValue('ssh.remote.port', port);
      await act(async () => findConnectButton()?.click());
      expect(remoteContextMock.connect).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('ssh.remote.portInvalid');
    },
  );

  it('notifies the controlling surface after a successful connection', async () => {
    const onClose = vi.fn();
    remoteContextMock.connect.mockResolvedValue(undefined);
    await renderDialog(onClose);

    setInputValue('ssh.remote.host', 'example.test');
    setInputValue('ssh.remote.username', 'dev');
    setInputValue('ssh.remote.password', 'secret');

    const connectButton = findConnectButton();
    expect(connectButton).not.toBeUndefined();
    await act(async () => {
      connectButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(remoteContextMock.connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        host: 'example.test',
        username: 'dev',
      }),
      { browseAfterConnect: true },
    );
    expect(remoteContextMock.connect.mock.calls[0]?.[1].container).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['remote Docker', 'remoteDocker', false, 'auto'],
    ['local Docker', 'localDocker', true, 'auto'],
    ['container sshd', 'containerSshd', false, 'sshd'],
  ] as const)(
    'builds the expected connection config for %s',
    async (_label, targetType, local, access) => {
      remoteContextMock.connect.mockResolvedValue(undefined);
      if (targetType === 'remoteDocker') sshApiMock.listSavedConnections.mockResolvedValue([{ id: 'ssh-dev@example.test', name: 'Host', host: 'example.test', port: 22, username: 'dev', authType: { type: 'PrivateKey', keyPath: '/keys/dev' } }]);
      await renderDialog();

      selectTarget(targetType);
      const containerNameInput = container.querySelector<HTMLInputElement>(
        'input[placeholder="ssh.remote.containerNamePlaceholder"]',
      );
      if (targetType === 'containerSshd') expect(containerNameInput).toBeNull();
      else {
        expect(containerNameInput).not.toBeNull();
        act(() => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(containerNameInput, 'devbox');
          containerNameInput?.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }

      if (targetType === 'remoteDocker') {
        await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="workspaceSource.sshHost"] button[aria-pressed]')!.click());
        const input = container.querySelector<HTMLInputElement>('input[placeholder="ssh.remote.containerNamePlaceholder"]')!;
        act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'devbox'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      } else if (!local) {
        setInputValue(targetType === 'containerSshd' ? 'workspaceSource.containerAddress' : 'workspaceSource.dockerHostAddress', 'example.test');
        setInputValue('ssh.remote.username', 'dev');
        setInputValue('ssh.remote.password', 'secret');
      }

      const connectButton = findConnectButton();
      expect(connectButton).not.toBeUndefined();
      await act(async () => {
        connectButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const expectedId = local
        ? 'docker-local-devbox'
        : targetType === 'containerSshd' ? 'ssh-dev@example.test-container-example.test' : 'ssh-dev@example.test-container-devbox';
      expect(remoteContextMock.connect).toHaveBeenCalledWith(
        expectedId,
        expect.objectContaining({
          id: expectedId,
          host: local ? 'local-docker' : 'example.test',
          username: local ? 'docker' : 'dev',
          auth: local
            ? { type: 'PrivateKey', keyPath: '' }
            : targetType === 'remoteDocker' ? { type: 'PrivateKey', keyPath: '/keys/dev' } : { type: 'Password', password: 'secret' },
          container: {
            name: targetType === 'containerSshd' ? 'example.test' : 'devbox',
            access,
            local,
            dockerPath: 'docker',
            shell: '/bin/sh',
            user: undefined,
            interactive: true,
          },
        }),
        { browseAfterConnect: true },
      );
    },
  );
  async function selectWsl(): Promise<void> {
    await act(async () => sourceOption(0, 'current').click());
    await act(async () => sourceOption(1, 'wsl').click());
    openAdvanced();
  }

  it('connects to an installed WSL distribution without SSH or Docker credentials', async () => {
    remoteContextMock.connect.mockResolvedValue(undefined);
    await renderDialog();
    await selectWsl();
    expect(container.querySelector('input[aria-label="ssh.remote.host"]')).toBeNull();
    expect(container.querySelector('input[aria-label="ssh.remote.password"]')).toBeNull();
    expect(container.querySelector('input[placeholder="ssh.remote.containerNamePlaceholder"]')).toBeNull();
    setInputValue('ssh.remote.wslUser', 'dev');
    await act(async () => { findConnectButton()?.click(); });
    expect(remoteContextMock.connect).toHaveBeenCalledWith(
      'wsl-Ubuntu@dev',
      expect.objectContaining({ wsl: { distribution: 'Ubuntu', user: 'dev' }, host: 'wsl.invalid', port: 0 }),
      { browseAfterConnect: true },
    );
    expect(remoteContextMock.connect.mock.calls[0]?.[1].container).toBeUndefined();
  });

  it('keeps distinct distribution and user pairs from sharing a connection identity', async () => {
    sshApiMock.listWslDistributions.mockResolvedValue({ supported: true, distributions: ['Ubuntu-dev', 'Ubuntu'] });
    remoteContextMock.connect.mockResolvedValue(undefined);
    await renderDialog();
    await selectWsl();
    setInputValue('ssh.remote.wslUser', 'ops');
    await act(async () => { findConnectButton()?.click(); });
    const distribution = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="ssh.remote.wslDistribution"] button'))
      .find(button => button.textContent === 'Ubuntu')!;
    act(() => distribution.click());
    setInputValue('ssh.remote.wslUser', 'dev-ops');
    await act(async () => { findConnectButton()?.click(); });
    expect(remoteContextMock.connect.mock.calls[0]?.[0]).not.toBe(remoteContextMock.connect.mock.calls[1]?.[0]);
  });

  it.each([
    [{ supported: false, distributions: [] }, 'ssh.remote.wslUnsupported'],
    [{ supported: true, distributions: [] }, 'ssh.remote.wslNoDistributions'],
  ])('gates WSL when discovery returns %j', async (result, hint) => {
    sshApiMock.listWslDistributions.mockResolvedValue(result);
    await renderDialog();
    await selectWsl();
    if (result.supported) expect(container.textContent).toContain(hint);
    else expect(container.textContent).not.toContain(hint);
    expect(findConnectButton()?.disabled).toBe(true);
    expect(remoteContextMock.connect).not.toHaveBeenCalled();
  });

  it('shows a failed discovery and lets the user retry', async () => {
    sshApiMock.listWslDistributions.mockRejectedValueOnce(new Error('wsl.exe unavailable'));
    await renderDialog();
    await selectWsl();
    expect(container.textContent).toContain('ssh.remote.wslDiscoveryFailed');
    expect(findConnectButton()?.disabled).toBe(true);
    expect(sourceOption(1, 'wsl').disabled).toBe(true);
    const refresh = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'workspaceSource.refreshOptions')!;
    await act(async () => refresh.click());
    expect(sourceOption(1, 'wsl').disabled).toBe(false);
    await selectWsl();
    expect(findConnectButton()?.disabled).toBe(false);
  });

  it('retains WSL target and Linux user when editing and quick connecting a saved profile', async () => {
    const wsl = { distribution: 'Debian', user: 'dev' };
    sshApiMock.listSavedConnections.mockResolvedValue([{
      id: 'wsl-Debian@dev', name: 'WSL · Debian · dev', host: 'wsl.invalid', port: 0,
      username: 'dev', authType: { type: 'PrivateKey', keyPath: '' }, wsl,
    }]);
    remoteContextMock.connect.mockResolvedValue(undefined);
    await renderDialog(vi.fn(), 'wsl');
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label^="actions.edit"]')?.click(); });
    expectTarget('wsl');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.wslUser"]')?.value).toBe('dev');
    await act(async () => { Array.from(container.querySelectorAll<HTMLButtonElement>('footer button')).find(button => button.textContent === 'actions.cancel')?.click(); });
    useSavedConnections();
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="connectionList"] button[aria-pressed]')?.click());
    await act(async () => { findConnectButton()?.click(); });
    expect(remoteContextMock.connect).toHaveBeenCalledWith('wsl-Debian@dev', expect.objectContaining({ wsl }), { browseAfterConnect: true });
    selectTarget('ssh');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.host"]')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.port"]')?.value).toBe('22');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="ssh.remote.username"]')?.value).toBe('');
  });

});
