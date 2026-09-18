// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import WorktreeSettingsPage from './WorktreeSettingsPage';

const getConfigMock = vi.hoisted(() => vi.fn());
const setConfigMock = vi.hoisted(() => vi.fn());
const listProjectsMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());
const onChangedMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const openAgentCompanionSessionMock = vi.hoisted(() => vi.fn());
const refreshWorkspaceSessionsMock = vi.hoisted(() => vi.fn());
const unarchiveSessionMock = vi.hoisted(() => vi.fn());
const confirmWarningMock = vi.hoisted(() => vi.fn());
const notificationSuccessMock = vi.hoisted(() => vi.fn());
const notificationErrorMock = vi.hoisted(() => vi.fn());
const translateMock = vi.hoisted(() => vi.fn(
  (key: string, params?: Record<string, unknown>) => {
    if (key === 'labels.detached') return `detached ${params?.commit}`;
    if (key === 'management.deleted') return `deleted ${params?.path}`;
    return key;
  },
));

vi.mock('@/infrastructure/api', () => ({
  configAPI: {
    getConfig: getConfigMock,
    setConfig: setConfigMock,
  },
  worktreeAPI: {
    listProjects: listProjectsMock,
    remove: removeMock,
    onChanged: onChangedMock,
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: translateMock,
  }),
}));

vi.mock('@/app/services/openAgentCompanionSession', () => ({
  openAgentCompanionSession: openAgentCompanionSessionMock,
}));

vi.mock('@/flow_chat/services/FlowChatManager', () => ({
  flowChatManager: {
    refreshWorkspaceSessions: refreshWorkspaceSessionsMock,
  },
}));

vi.mock('@/infrastructure/api/service-api/SessionAPI', () => ({
  sessionAPI: {
    unarchiveSession: unarchiveSessionMock,
  },
}));

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmWarning: confirmWarningMock,
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    success: notificationSuccessMock,
    error: notificationErrorMock,
  },
}));

vi.mock('@openbitfun/ui', () => ({
  Icon: ({ name, ...props }: { name: string } & React.HTMLAttributes<HTMLSpanElement>) => <span data-icon={name} {...props} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
  ),
  ConfirmDialog: ({ confirmText, message, onConfirm, open, title }: {
    confirmText: string;
    message: React.ReactNode;
    onConfirm: () => void;
    open: boolean;
    title: string;
  }) => open ? (
    <div role="dialog">
      <h2>{title}</h2>
      <div>{message}</div>
      <button type="button" data-testid="confirm-delete" onClick={onConfirm}>
        {confirmText}
      </button>
    </div>
  ) : null,
  IconButton: ({
    'aria-label': ariaLabel,
    children,
    disabled,
    icon,
    onClick,
    title,
  }: {
    'aria-label'?: string;
    children?: React.ReactNode;
    disabled?: boolean;
    icon?: React.ReactNode;
    onClick?: () => void;
    title?: string;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {icon ?? children}
    </button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  NumberInput: ({ disabled, label, onValueChange, value }: {
    disabled?: boolean;
    label?: string;
    onValueChange: (value: number) => void;
    value: number;
  }) => (
    <input
      aria-label={label}
      disabled={disabled}
      type="number"
      value={value}
      onChange={event => onValueChange(Number(event.currentTarget.value))}
    />
  ),
  Switch: ({ checked, disabled, onChange }: {
    checked: boolean;
    disabled?: boolean;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
  }) => (
    <input checked={checked} disabled={disabled} type="checkbox" onChange={onChange} />
  ),
}));

vi.mock('./common', () => ({
  ConfigEmptyState: ({ icon, title, description, ...props }: {
    icon: React.ReactNode;
    title?: React.ReactNode;
    description: React.ReactNode;
    className?: string;
  }) => (
    <div {...props}>
      {icon}
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
  ConfigActionBar: ({
    discardLabel,
    onDiscard,
    onSave,
    saveLabel,
  }: {
    discardLabel?: React.ReactNode;
    onDiscard: () => void;
    onSave: () => void;
    saveLabel?: React.ReactNode;
  }) => (
    <div>
      <button type="button" onClick={onDiscard}>{discardLabel ?? 'discard'}</button>
      <button type="button" onClick={onSave}>{saveLabel ?? 'save'}</button>
    </div>
  ),
  ConfigLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  ConfigMessage: ({ message }: { message: { text: string } | null }) => message ? <div>{message.text}</div> : null,
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
  ConfigRefreshButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>refresh</button>
  ),
  ConfigPageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfigPageHeader: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
  ConfigPageLayout: ({ children }: { children: React.ReactNode }) => (
    <main className="openbitfun-config-page-layout">{children}</main>
  ),
  ConfigPageRow: ({
    children,
    description,
    label,
  }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    label: React.ReactNode;
  }) => (
    <label>
      <span>{label}</span>
      <span>{description}</span>
      {children}
    </label>
  ),
  ConfigPageSection: ({
    children,
    description,
    extra,
    title,
  }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    extra?: React.ReactNode;
    title: string;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {extra}
      {children}
    </section>
  ),
}));

function worktree(overrides: Record<string, unknown> = {}) {
  return {
    worktreeId: 'wt-1',
    projectWorkspacePath: '/repo',
    path: '/managed/OpenBitFun-wt-1',
    head: '0123456789abcdef',
    lifecycle: 'managed',
    isMain: false,
    dirty: false,
    locked: false,
    missing: false,
    hasUnpublishedCommits: false,
    associatedSessionCount: 1,
    runningSessionCount: 0,
    sessions: [{
      sessionId: 'session-1',
      sessionName: 'Ship worktree management',
      status: 'archived',
      archived: true,
    }],
    ...overrides,
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('WorktreeSettingsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
      })),
    });

    getConfigMock.mockResolvedValue({
      rootPath: '/custom/worktrees',
      branchPrefix: 'custom/',
      copyLocalChanges: false,
    });
    setConfigMock.mockResolvedValue(undefined);
    listProjectsMock.mockResolvedValue([{
      projectWorkspaceId: 'workspace-repo',
      projectWorkspacePath: '/repo',
      worktrees: [worktree()],
    }]);
    removeMock.mockResolvedValue({ worktreeId: 'wt-1', removed: true });
    onChangedMock.mockReturnValue(vi.fn());
    openAgentCompanionSessionMock.mockResolvedValue(true);
    refreshWorkspaceSessionsMock.mockResolvedValue(undefined);
    unarchiveSessionMock.mockResolvedValue(undefined);
    confirmWarningMock.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('adds safe auto-delete defaults and renders workspace worktrees with sessions', async () => {
    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const limit = container.querySelector<HTMLInputElement>('input[type="number"]');

    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[1].checked).toBe(true);
    expect(limit?.value).toBe('15');
    expect(container.textContent).toContain('/repo');
    expect(container.textContent).toContain('/managed/OpenBitFun-wt-1');
    expect(container.textContent).toContain('Ship worktree management');
  });

  it('locks untrusted fallback settings after a failed read and supports retry', async () => {
    getConfigMock
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({
        rootPath: '/retried/worktrees',
        branchPrefix: 'retried/',
        copyLocalChanges: true,
      });

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    expect(container.textContent).toContain('settings.loadFailed');
    expect(container.textContent).not.toContain('settings.save');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'settings.retry');
    await act(async () => {
      retryButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getConfigMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLInputElement>('input[value="/retried/worktrees"]'))
      .not.toBeNull();
  });

  it('saves the auto-delete policy with the existing worktree settings', async () => {
    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const limit = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(limit).not.toBeNull();
    await act(async () => {
      if (limit) {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        setValue?.call(limit, '24');
        limit.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    const saveButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('settings.save'));
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });

    expect(setConfigMock).toHaveBeenCalledWith('app.worktrees', {
      rootPath: '/custom/worktrees',
      branchPrefix: 'custom/',
      copyLocalChanges: false,
      autoDeleteEnabled: true,
      autoDeleteLimit: 24,
    });
  });

  it('submits a settings draft only once when save is triggered twice synchronously', async () => {
    const saveRequest = deferred<void>();
    setConfigMock.mockReturnValueOnce(saveRequest.promise);

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const limit = container.querySelector<HTMLInputElement>('input[type="number"]');
    await act(async () => {
      if (!limit) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(limit, '24');
      limit.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('settings.save'));
    act(() => {
      saveButton?.click();
      saveButton?.click();
    });

    expect(setConfigMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      saveRequest.resolve();
      await saveRequest.promise;
      await Promise.resolve();
    });
  });

  it('opens an associated conversation from the worktree row', async () => {
    listProjectsMock.mockResolvedValueOnce([{
      projectWorkspaceId: 'workspace-repo',
      projectWorkspacePath: '/repo',
      worktrees: [worktree({
        sessions: [{
          sessionId: 'session-1',
          sessionName: 'Ship worktree management',
          status: 'active',
          archived: false,
        }],
      })],
    }]);

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const sessionButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Ship worktree management'));
    await act(async () => {
      sessionButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openAgentCompanionSessionMock).toHaveBeenCalledWith('session-1');
    expect(refreshWorkspaceSessionsMock).not.toHaveBeenCalled();
  });

  it('prefers the session workspace ID over the owning project when restoring', async () => {
    listProjectsMock.mockResolvedValueOnce([{
      projectWorkspaceId: 'workspace-repo',
      projectWorkspacePath: '/repo',
      worktrees: [worktree({
        sessions: [{
          workspaceId: 'workspace-worktree',
          sessionId: 'session-1',
          sessionName: 'Ship worktree management',
          status: 'archived',
          archived: true,
        }],
      })],
    }]);

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const sessionButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Ship worktree management'));
    await act(async () => {
      sessionButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(unarchiveSessionMock).toHaveBeenCalledWith('session-1', 'workspace-worktree');
    expect(refreshWorkspaceSessionsMock).toHaveBeenCalledWith({ id: 'workspace-worktree' });
  });

  it('refreshes session metadata before retrying a conversation that is not loaded', async () => {
    openAgentCompanionSessionMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    listProjectsMock.mockResolvedValueOnce([{
      projectWorkspaceId: 'workspace-repo',
      projectWorkspacePath: '/repo',
      worktrees: [worktree({
        sessions: [{
          sessionId: 'session-1',
          sessionName: 'Ship worktree management',
          status: 'active',
          archived: false,
        }],
      })],
    }]);

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const sessionButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Ship worktree management'));
    await act(async () => {
      sessionButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshWorkspaceSessionsMock).toHaveBeenCalledWith({ id: 'workspace-repo' });
    expect(openAgentCompanionSessionMock).toHaveBeenCalledTimes(2);
  });

  it('restores an archived associated conversation before opening it', async () => {
    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const sessionButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Ship worktree management'));
    await act(async () => {
      sessionButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(confirmWarningMock).toHaveBeenCalled();
    expect(unarchiveSessionMock).toHaveBeenCalledWith('session-1', 'workspace-repo');
    expect(refreshWorkspaceSessionsMock).toHaveBeenCalledWith({ id: 'workspace-repo' });
    expect(openAgentCompanionSessionMock).toHaveBeenCalledWith('session-1');
  });

  it('keeps the current list mounted while a background refresh is pending', async () => {
    const refresh = deferred<Array<{
      projectWorkspacePath: string;
      worktrees: ReturnType<typeof worktree>[];
    }>>();

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();
    listProjectsMock.mockReturnValueOnce(refresh.promise);

    const refreshButton = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'refresh');
    act(() => refreshButton?.click());

    const results = container.querySelector('.openbitfun-worktree-settings__results');
    expect(results?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('/managed/OpenBitFun-wt-1');

    await act(async () => {
      refresh.resolve([{
        projectWorkspacePath: '/repo',
        worktrees: [worktree()],
      }]);
      await refresh.promise;
      await Promise.resolve();
    });

    expect(results?.getAttribute('aria-busy')).toBe('false');
    expect(container.textContent).toContain('/managed/OpenBitFun-wt-1');
  });

  it('keeps the settings scroll position while deletion refreshes the list', async () => {
    const refresh = deferred<Array<{
      projectWorkspacePath: string;
      worktrees: ReturnType<typeof worktree>[];
    }>>();

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();
    listProjectsMock.mockReturnValueOnce(refresh.promise);

    const layout = container.querySelector<HTMLElement>('.openbitfun-config-page-layout');
    expect(layout).not.toBeNull();
    if (layout) {
      layout.scrollTop = 420;
    }

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="management.delete.actionLabel"]',
    );
    act(() => deleteButton?.click());
    const confirmButton = container.querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]');
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const results = container.querySelector('.openbitfun-worktree-settings__results');
    expect(results?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.openbitfun-worktree-settings__skeleton')).toBeNull();
    expect(layout?.scrollTop).toBe(420);

    await act(async () => {
      refresh.resolve([]);
      await refresh.promise;
      await Promise.resolve();
    });

    expect(results?.getAttribute('aria-busy')).toBe('false');
    expect(container.textContent).toContain('management.empty.title');
    expect(layout?.scrollTop).toBe(420);
  });

  it('requires confirmation and uses force only when local work would be discarded', async () => {
    listProjectsMock.mockResolvedValueOnce([{
      projectWorkspaceId: 'workspace-repo',
      projectWorkspacePath: '/repo',
      worktrees: [worktree({
        associatedSessionCount: 0,
        dirty: true,
        sessions: [],
      })],
    }]);

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="management.delete.actionLabel"]',
    );
    act(() => deleteButton?.click());

    expect(container.querySelector('[role="dialog"]')?.textContent)
      .toContain('management.delete.forceTitle');

    const confirmButton = container.querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]');
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(removeMock).toHaveBeenCalledWith(
      { projectWorkspaceId: 'workspace-repo', projectWorkspacePath: '/repo' },
      'wt-1',
      expect.any(String),
      true,
    );
  });

  it('allows manual deletion while preserving associated archived sessions', async () => {
    listProjectsMock.mockResolvedValueOnce([{
      projectWorkspaceId: 'workspace-repo',
      projectWorkspacePath: '/repo',
      worktrees: [worktree()],
    }]);

    await act(async () => {
      root.render(<WorktreeSettingsPage />);
    });
    await flushPromises();

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="management.delete.actionLabel"]',
    );
    act(() => deleteButton?.click());

    expect(deleteButton?.disabled).toBe(false);
    expect(container.querySelector('[role="dialog"]')?.textContent)
      .toContain('management.delete.messageWithSessions');

    const confirmButton = container.querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]');
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(removeMock).toHaveBeenCalledWith(
      { projectWorkspaceId: 'workspace-repo', projectWorkspacePath: '/repo' },
      'wt-1',
      expect.any(String),
      false,
    );
  });
});
