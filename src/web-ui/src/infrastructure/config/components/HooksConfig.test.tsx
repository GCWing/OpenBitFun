// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HooksConfig from './HooksConfig';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getConfigMock = vi.hoisted(() => vi.fn());
const setConfigMock = vi.hoisted(() => vi.fn());
const getSnapshotMock = vi.hoisted(() => vi.fn());
const planImportMock = vi.hoisted(() => vi.fn());
const applyImportMock = vi.hoisted(() => vi.fn());
const mutateImportMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const notifySuccessMock = vi.hoisted(() => vi.fn());
const translateMock = vi.hoisted(() => vi.fn(
  (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${Object.values(params).join(':')}` : key
  ),
));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: translateMock }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
  ),
  Icon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
  ConfirmDialog: ({ confirmText, open, message, onConfirm, title }: {
    confirmText?: string;
    open: boolean;
    message: React.ReactNode;
    onConfirm: () => void;
    title: string;
  }) => (open ? (
    <div role="dialog" aria-label={title}>
      {message}
      <button type="button" onClick={onConfirm}>{confirmText}</button>
    </div>
  ) : null),
  Switch: ({ checked, disabled, onChange }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
  ),
  Dialog: ({ children, open, 'aria-label': ariaLabel }: {
    children: React.ReactNode;
    open: boolean;
    'aria-label'?: string;
  }) => (open ? <div role="dialog" aria-label={ariaLabel}>{children}</div> : null),
  DialogBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogClose: () => <button type="button" aria-label="Close" />,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogHeading: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

vi.mock('./common', () => ({
  ConfigLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  ConfigPageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfigPageHeader: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header><h1>{title}</h1><p>{subtitle}</p></header>
  ),
  ConfigPageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  ConfigPageRow: ({ children, description, label }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    label: React.ReactNode;
  }) => <div><strong>{label}</strong><span>{description}</span>{children}</div>,
  ConfigPageSection: ({ children, description, extra, title }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    extra?: React.ReactNode;
    title: string;
  }) => <section><h2>{title}</h2>{description}{extra}{children}</section>,
}));

// Hook import requests carry the workspace ID; the path is only displayed.
const WORKSPACE_ID = 'workspace-1';

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({
    workspace: { id: 'workspace-1', workspaceKind: 'normal', rootPath: 'D:/workspace/project' },
    workspacePath: 'D:/workspace/project',
  }),
}));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ error: notifyErrorMock, success: notifySuccessMock }),
}));

vi.mock('../services/ConfigManager', () => ({
  configManager: { getConfig: getConfigMock, setConfig: setConfigMock },
}));

vi.mock('@/infrastructure/api/service-api/ExternalHooksAPI', () => ({
  externalHooksAPI: {
    getImportSnapshot: getSnapshotMock,
    planImport: planImportMock,
    applyImport: applyImportMock,
    mutateImport: mutateImportMock,
  },
}));

vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({
  systemAPI: { openExternal: vi.fn() },
}));

const source = {
  key: { providerId: 'claude-code.hooks', sourceId: 'project-settings' },
  ecosystemId: 'claude-code',
  displayName: 'Claude Code project Hooks',
  sourceKind: 'settings',
  scope: 'project',
  locationHint: '.claude/settings.json',
  health: 'available',
  contentVersion: 'v1',
  diagnostics: [],
};

const catalog = {
  schemaVersion: 1,
  discoveryPending: false,
  providers: [],
  sources: [source],
  entries: [],
  staleProviderIds: [],
  failedProviderIds: [],
  diagnostics: [],
};

const snapshot = {
  schemaVersion: 1,
  revision: 'sha256:revision-1',
  catalog,
  imports: [],
  diagnostics: [],
};

const plan = {
  schemaVersion: 1,
  source,
  disposition: 'update',
  behaviorVersion: 'sha256:behavior',
  handlers: [{
    stableKey: 'pre-tool-use-0',
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'python D:/managed/hooks/check.py',
    timeoutSeconds: 30,
    dependencies: [{ kind: 'managed', relativePath: 'hooks/check.py' }],
  }],
  skipped: [{ reasonCode: 'unsupported_event', count: 1 }],
  planFingerprint: 'sha256:plan-1',
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('HooksConfig imported Hook management', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue({ enabled: true, project_hooks_enabled: true });
    setConfigMock.mockResolvedValue(undefined);
    getSnapshotMock.mockResolvedValue(snapshot);
    planImportMock.mockResolvedValue(plan);
    applyImportMock.mockResolvedValue({
      schemaVersion: 1,
      outcome: { kind: 'applied', snapshot: { ...snapshot, revision: 'sha256:revision-2' } },
    });
    mutateImportMock.mockResolvedValue(snapshot);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('reuses Hook owners without rendering a second page shell when embedded', async () => {
    await act(async () => root.render(<HooksConfig embedded />));
    await flush();

    expect(getConfigMock).toHaveBeenCalledWith('app.hooks');
    expect(getSnapshotMock).toHaveBeenCalledWith(WORKSPACE_ID, false);
    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toContain('activation.title');
  });

  it('keeps unimported external discoveries out of native Hook management', async () => {
    const externalSources = ['pi', 'deepseek-harness'].map((ecosystemId) => ({
      ...source,
      key: { providerId: `${ecosystemId}.hooks`, sourceId: 'extension' },
      ecosystemId,
      displayName: `${ecosystemId} extension`,
      locationHint: `${ecosystemId}/extension.ts`,
      sourceKind: 'plugin_file',
    }));
    getSnapshotMock.mockResolvedValue({
      ...snapshot,
      catalog: {
        ...catalog,
        sources: externalSources,
        entries: externalSources.map((item) => ({
          stableKey: `${item.ecosystemId}:hook`, source: item.key,
          nativeEvent: item.ecosystemId === 'pi' ? 'tool_call' : 'PreToolUse',
          handlerKind: 'function', projectionStatus: 'native_only',
          nativeActivation: 'unknown', matcher: { kind: 'dynamic' }, contentVersion: 'v1',
        })),
      },
    });
    await act(async () => root.render(<HooksConfig embedded />));
    await flush();
    expect(container.textContent).not.toContain('tool_call');
    expect(container.textContent).not.toContain('PreToolUse');
    expect(container.textContent).not.toContain('discovery.title');
    expect(container.textContent).not.toContain('imports.review');
    expect(planImportMock).not.toHaveBeenCalled();
    expect(applyImportMock).not.toHaveBeenCalled();
  });

  it('explains the empty imported Hooks state instead of leaving an empty row', async () => {
    getSnapshotMock.mockResolvedValue({
      ...snapshot,
      catalog: { ...catalog, sources: [] },
    });

    await act(async () => root.render(<HooksConfig embedded />));
    await flush();

    const empty = container.querySelector('[data-hooks-empty="true"]');
    expect(empty?.textContent).toContain('imports.empty');
  });

  it('reviews exact commands before updating a previously imported Hook', async () => {
    getSnapshotMock.mockResolvedValue({ ...snapshot, imports: [{ importId: 'managed-1', source, enabled: true, behaviorVersion: 'old', state: 'update_available' }] });
    await act(async () => root.render(<HooksConfig />));
    await flush();

    expect(getConfigMock).toHaveBeenCalledTimes(1);
    expect(getSnapshotMock).toHaveBeenCalledWith(WORKSPACE_ID, false);
    const review = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'imports.update')!;
    await act(async () => review.click());
    await flush();

    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('python D:/managed/hooks/check.py');
    expect(dialog.textContent).toContain('unsupported_event');
    expect(dialog.textContent).not.toContain('sha256:plan-1');

    const confirm = Array.from(dialog.querySelectorAll('button'))
      .find((button) => button.textContent === 'imports.confirmUpdate')!;
    await act(async () => confirm.click());
    await flush();
    expect(applyImportMock).toHaveBeenCalledWith(WORKSPACE_ID, plan);
  });

  it('keeps a stale replacement plan open and never applies it implicitly', async () => {
    getSnapshotMock.mockResolvedValue({ ...snapshot, imports: [{ importId: 'managed-1', source, enabled: true, behaviorVersion: 'old', state: 'update_available' }] });
    const refreshedPlan = {
      ...plan,
      handlers: [{ ...plan.handlers[0], command: 'python D:/managed/hooks/check-v2.py' }],
      planFingerprint: 'sha256:plan-2',
    };
    applyImportMock.mockResolvedValue({
      schemaVersion: 1,
      outcome: { kind: 'stale', refreshedPlan },
    });
    await act(async () => root.render(<HooksConfig />));
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.update')!.click();
    });
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.confirmUpdate')!.click();
    });
    await flush();

    expect(container.textContent).toContain('python D:/managed/hooks/check-v2.py');
    expect(container.textContent).toContain('imports.stale');
    expect(applyImportMock).toHaveBeenCalledTimes(1);
  });

  it('removes only after a source-preservation confirmation', async () => {
    getSnapshotMock.mockResolvedValue({
      ...snapshot,
      imports: [{
        importId: 'managed-1',
        source,
        enabled: true,
        behaviorVersion: 'sha256:behavior',
        state: 'current',
      }],
    });
    await act(async () => root.render(<HooksConfig />));
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.remove')!.click();
    });
    expect(container.textContent).toContain('imports.removeSourceUntouched');
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.removeConfirm')!.click();
    });
    await flush();
    expect(mutateImportMock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'sha256:revision-1',
      { kind: 'remove', importId: 'managed-1' },
    );
  });

  it('refreshes stale mutation state without replaying the action', async () => {
    const imported = {
      ...snapshot,
      imports: [{
        importId: 'managed-1',
        source,
        enabled: false,
        behaviorVersion: 'sha256:behavior',
        state: 'current',
      }],
    };
    const refreshed = { ...imported, revision: 'sha256:revision-2' };
    getSnapshotMock.mockReset();
    getSnapshotMock.mockResolvedValueOnce(imported).mockResolvedValueOnce(refreshed);
    mutateImportMock.mockRejectedValue({ code: 'stale_revision' });
    await act(async () => root.render(<HooksConfig />));
    await flush();

    const importedSwitch = Array.from(container.querySelectorAll('input')).at(-1)!;
    await act(async () => importedSwitch.click());
    await flush();

    expect(mutateImportMock).toHaveBeenCalledTimes(1);
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
    expect(notifyErrorMock).toHaveBeenCalledWith('imports.stateChanged');
  });

  it('keeps a disabled import disabled after review and reports the authoritative state', async () => {
    const disabledImport = {
      importId: 'managed-1',
      source,
      enabled: false,
      behaviorVersion: 'sha256:behavior',
      state: 'update_available',
    };
    const imported = { ...snapshot, imports: [disabledImport] };
    getSnapshotMock.mockResolvedValue(imported);
    planImportMock.mockResolvedValue({ ...plan, disposition: 'update' });
    applyImportMock.mockResolvedValue({
      schemaVersion: 1,
      outcome: {
        kind: 'applied',
        snapshot: { ...imported, revision: 'sha256:revision-2' },
      },
    });

    await act(async () => root.render(<HooksConfig />));
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.update')!.click();
    });
    await flush();

    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('imports.confirmUpdate');
    await act(async () => {
      Array.from(dialog.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.confirmUpdate')!.click();
    });
    await flush();

    expect(notifySuccessMock).toHaveBeenCalledWith('imports.appliedDisabled');
  });

  it('does not claim an imported source will run while the master switch is off', async () => {
    getSnapshotMock.mockResolvedValue({ ...snapshot, imports: [{ importId: 'managed-1', source, enabled: true, behaviorVersion: 'old', state: 'update_available' }] });
    getConfigMock.mockResolvedValue({ enabled: false, project_hooks_enabled: false });
    applyImportMock.mockResolvedValue({
      schemaVersion: 1,
      outcome: {
        kind: 'applied',
        snapshot: {
          ...snapshot,
          revision: 'sha256:revision-2',
          imports: [{
            importId: 'managed-1',
            source,
            enabled: true,
            behaviorVersion: 'sha256:behavior',
            state: 'current',
          }],
        },
      },
    });

    await act(async () => root.render(<HooksConfig />));
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.update')!.click();
    });
    await flush();
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'imports.confirmUpdate')!.click();
    });
    await flush();

    expect(notifySuccessMock).toHaveBeenCalledWith('imports.appliedMasterDisabled');
  });
});
