// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemorySettingsSection from './MemorySettingsSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getConfigMock = vi.hoisted(() => vi.fn());
const updateConfigMock = vi.hoisted(() => vi.fn());
const resetConfigMock = vi.hoisted(() => vi.fn());
const getMemoryStatusMock = vi.hoisted(() => vi.fn());
const runMemoryPipelineNowMock = vi.hoisted(() => vi.fn());
const clearMemoryStage1FailuresMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const notifyInfoMock = vi.hoisted(() => vi.fn());
const notifySuccessMock = vi.hoisted(() => vi.fn());
const translateMock = vi.hoisted(() => vi.fn(
  (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
  ),
));
const formatNumberMock = vi.hoisted(() => vi.fn((value: number) => `n${value}`));
const formatDateMock = vi.hoisted(() => vi.fn(() => 'DATE'));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: translateMock,
    formatNumber: formatNumberMock,
    formatDate: formatDateMock,
  }),
  i18nService: {
    t: translateMock,
    formatNumber: formatNumberMock,
    formatDate: formatDateMock,
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({
    error: notifyErrorMock,
    info: notifyInfoMock,
    success: notifySuccessMock,
  }),
}));

vi.mock('@openbitfun/ui', () => ({
  Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
    leadingIcon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    loading?: boolean;
    size?: string;
    variant?: string;
  }>(({
    children,
    leadingIcon: _leadingIcon,
    trailingIcon: _trailingIcon,
    loading: _loading,
    size: _size,
    variant: _variant,
    ...props
  }, ref) => <button ref={ref} type="button" {...props}>{children}</button>),
  ConfirmDialog: ({
    open,
    onConfirm,
    message,
    confirmText,
    title,
  }: {
    open?: boolean;
    onConfirm?: () => void;
    message?: React.ReactNode;
    confirmText?: string;
    title?: React.ReactNode;
  }) => (
    open ? (
      <div data-testid="confirm-dialog" data-title={typeof title === 'string' ? title : undefined}>
        <span data-testid="confirm-dialog-message">{message}</span>
        <button type="button" data-testid="confirm-dialog-confirm" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null
  ),
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  IconButton: ({
    icon,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: React.ReactNode;
    variant?: string;
    size?: string;
  }) => <button type="button" {...props}>{icon ?? children}</button>,
  MenuPopover: () => null,
  NumberInput: ({
    value,
    onValueChange,
    min,
    max,
    unit: _unit,
    size: _size,
    disabled,
  }: {
    value: number;
    onValueChange: (value: number) => void;
    min?: number;
    max?: number;
    unit?: string;
    size?: string;
    disabled?: boolean;
  }) => (
    <input
      data-testid="number-input"
      type="number"
      value={String(value)}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(event) => onValueChange(Number(event.target.value))}
    />
  ),
  Select: ({
    value,
    options,
    onValueChange: _onValueChange,
    size: _size,
    disabled,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onValueChange?: (value: string) => void;
    size?: string;
    disabled?: boolean;
  }) => (
    <select value={value} disabled={disabled} onChange={() => undefined}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
  StatusPill: ({
    children,
    tone,
    leading: _leading,
    emphasis: _emphasis,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & {
    tone?: string;
    emphasis?: boolean;
    leading?: React.ReactNode;
  }) => <span data-testid="status-pill" data-tone={tone} {...props}>{children}</span>,
  Switch: ({
    checked,
    disabled,
    onChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} {...props} />
  ),
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

const createCommonMock = vi.hoisted(() => () => ({
  ConfigLoadingState: ({ label }: { label: string }) => <div data-testid="loading-state">{label}</div>,
  ConfigMessage: ({ message }: { message: { type: string; text: string } | null }) => (
    message
      ? <div data-testid="inline-message" data-message-type={message.type}>{message.text}</div>
      : null
  ),
  ConfigRetryState: ({ message, retryLabel, onRetry }: {
    message: string;
    retryLabel: string;
    onRetry: () => void;
  }) => (
    <div data-testid="retry-state">
      <span>{message}</span>
      <button type="button" onClick={onRetry}>{retryLabel}</button>
    </div>
  ),
  ConfigPageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfigPageHeader: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header><h1>{title}</h1><p>{subtitle}</p></header>
  ),
  ConfigPageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  ConfigPageRow: ({ children, description, label }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    label: React.ReactNode;
  }) => (
    <div data-testid="row" data-label={typeof label === 'string' ? label : undefined}>
      <strong>{label}</strong>
      <span>{description}</span>
      {children}
    </div>
  ),
  ConfigPageSection: ({ children, description, descriptionLayout: _descriptionLayout, extra, title, ...props }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    descriptionLayout?: string;
    extra?: React.ReactNode;
    title: string;
  } & React.HTMLAttributes<HTMLElement>) => (
    <section {...props}><h2>{title}</h2>{description}{extra}{children}</section>
  ),
  ConfigPageSectionStack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/infrastructure/config/components/common', createCommonMock);
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    getMemoryStatus: getMemoryStatusMock,
    runMemoryPipelineNow: runMemoryPipelineNowMock,
    clearMemoryStage1Failures: clearMemoryStage1FailuresMock,
    getMemoryPaths: vi.fn(),
    resetMemory: vi.fn(),
  },
}));

vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: { revealInExplorer: vi.fn() },
}));

vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: {
    hasCachedConfig: () => false,
    getCachedConfig: () => undefined,
    getConfig: getConfigMock,
    updateConfig: updateConfigMock,
    resetConfig: resetConfigMock,
  },
}));

const PHASE2_LAST_ERROR = 'consolidation timeout after 1200s {\n"error":{"type":"timeout","code":"request_timeout"}}';
const RAW_PROVIDER_ERROR = '403 Forbidden {\n"error":{"message":"The model is not available in your region, request id req_0123456789abcdef0123456789abcdef","type":"permission_error","code":"model_unavailable"}}';

const READY_STATUS = {
  generateMemories: true,
  useMemories: false,
  memoryRootDir: 'D:/host/openbitfun/memories',
  stage1OutputCount: 7,
  stage1PendingPromotionCount: 2,
  stage1Failed: [
    {
      sessionId: '0194f5a6-89ab-7cde-8123-456789abcdef',
      lastError: 'provider unavailable',
      retryExhausted: true,
      failedAtUnixSecs: 1_700_000_000,
    },
    {
      sessionId: '0194f5a6-89ab-7cde-8123-456789abcdea',
      lastError: RAW_PROVIDER_ERROR,
      retryExhausted: true,
      failedAtUnixSecs: null,
    },
  ],
  phase2Status: 'error',
  phase2LastFinishedAtUnixSecs: 1_700_000_000,
  phase2LastError: PHASE2_LAST_ERROR,
  files: { memoryIndexBytes: 128, memorySummaryBytes: null, rolloutSummaryCount: 3 },
};

async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve();
    }
  });
}

function rowByLabel(container: HTMLElement, label: string): HTMLElement | null {
  return container.querySelector(`[data-label="${label}"]`);
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement | null {
  return rowByLabel(container, label)?.querySelector('input') ?? null;
}

function runNowButton(container: HTMLElement): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'status.actions.runNow',
  ) ?? null;
}

function memoryToggle(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('[data-testid="memories-enabled-toggle"]');
}

function phase2LastErrorBlock(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="memories-status-phase2-last-error"]');
}

function failedSessionList(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="memories-status-stage1-failed"]');
}

function failedSessionEntries(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-testid="memories-status-stage1-failed-entry"]'));
}

function clearFailuresButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('[data-testid="memories-clear-failed-btn"]');
}

function confirmDialogConfirmButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('[data-testid="confirm-dialog-confirm"]');
}

async function expandAdvanced(container: HTMLElement) {
  const toggle = container.querySelector('[aria-label="actions.expandAdvanced"]');
  expect(toggle).not.toBeNull();
  await act(async () => {
    (toggle as HTMLButtonElement).click();
  });
  await flush();
}

describe('Memory settings section truthfulness', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    getConfigMock.mockImplementation(async (path: string) => {
      if (path === 'ai.models') {
        return [];
      }
      return {};
    });
    updateConfigMock.mockImplementation(
      async (_path: string, reducer: (current: unknown) => unknown) => reducer({}),
    );
    resetConfigMock.mockResolvedValue(undefined);
    getMemoryStatusMock.mockResolvedValue(READY_STATUS);
    runMemoryPipelineNowMock.mockResolvedValue({ started: true });
    clearMemoryStage1FailuresMock.mockResolvedValue({ clearedCount: 2, stage1Failed: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('opens read-only and keeps host values the UI would otherwise rewrite', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models'
        ? []
        : { max_rollout_age_days: 14, max_unused_days: 7, max_rollouts_per_startup: 2 }
    ));

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();
    await expandAdvanced(container);

    expect(inputByLabel(container, 'fields.maxRolloutAgeDays.label')?.value).toBe('14');
    expect(inputByLabel(container, 'fields.maxUnusedDays.label')?.value).toBe('7');
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('refuses a retention of zero, which would delete every unused memory', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();
    await expandAdvanced(container);

    const retention = inputByLabel(container, 'fields.maxUnusedDays.label');
    expect(retention?.value).toBe('30');
    expect(retention?.getAttribute('min')).toBe('1');
    expect(inputByLabel(container, 'fields.maxRolloutAgeDays.label')?.getAttribute('min')).toBe('0');
  });

  it('mirrors the backend defaults when the host stores only non-default keys', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    expect(memoryToggle(container)?.checked).toBe(false);

    await expandAdvanced(container);
    expect(inputByLabel(container, 'fields.maxRolloutsPerStartup.label')?.value).toBe('2');
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('shows an unavailable state instead of fallback values when the settings read fails', async () => {
    getConfigMock.mockImplementation(async (path: string) => {
      if (path === 'ai.models') {
        return [];
      }
      throw new Error('config backend offline');
    });

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    expect(container.querySelector('[data-testid="retry-state"]')?.textContent)
      .toContain('messages.loadFailedLocked');

    // No setting may be rendered from the local default object, because the host
    // state was never read: the backend only persists non-default keys.
    expect(memoryToggle(container)).toBeNull();
    expect(container.querySelector('[data-testid="number-input"]')).toBeNull();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('reports the host pipeline state in the status card', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    expect(rowByLabel(container, 'status.fields.storedOutputs')?.textContent).toContain('n7');
    expect(rowByLabel(container, 'status.fields.pendingPromotion')?.textContent).toContain('n2');
    expect(rowByLabel(container, 'status.fields.phase2')?.textContent).toContain('shared:statuses.failed');
    expect(rowByLabel(container, 'status.fields.phase2')?.textContent).toContain('DATE');
    expect(phase2LastErrorBlock(container)?.textContent)
      .toContain('consolidation timeout after 1200s');
    expect(rowByLabel(container, 'status.fields.rolloutSummaries')?.textContent).toContain('n3');
    // A `null` byte count is unknown, not zero.
    expect(rowByLabel(container, 'status.fields.memorySummary')?.textContent).toContain('status.unknown');

    const failedList = failedSessionList(container);
    expect(failedList?.textContent).toContain('0194f5a6');
    expect(failedList?.textContent).toContain('provider unavailable');
    expect(failedList?.textContent).toContain('status.failed.retryExhausted');
  });

  it('renders the consolidation error as a tinted, clamped block with the full text on title', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    const errorBlock = phase2LastErrorBlock(container);
    expect(errorBlock).not.toBeNull();
    // A dedicated tinted block instead of a bare inline span at body size.
    expect(errorBlock?.classList.contains('openbitfun-memory-settings__error-detail')).toBe(true);

    const visibleText = errorBlock?.querySelector('.openbitfun-memory-settings__error-detail-text');
    expect(visibleText).not.toBeNull();
    // The provider payload tail is dropped from the visible line...
    expect(visibleText?.textContent).toBe('consolidation timeout after 1200s');
    expect(visibleText?.textContent).not.toContain('{"error');
    expect(visibleText?.textContent).not.toContain('request_timeout');
    // ...and the whole message stays reachable through `title`.
    expect(visibleText?.getAttribute('title')).toBe(PHASE2_LAST_ERROR);
  });

  it('condenses a very long consolidation error instead of printing it in full', async () => {
    const longError = `provider failure ${'x'.repeat(400)}`;
    getMemoryStatusMock.mockResolvedValue({ ...READY_STATUS, phase2LastError: longError });

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    const visibleText = phase2LastErrorBlock(container)
      ?.querySelector('.openbitfun-memory-settings__error-detail-text');
    const text = visibleText?.textContent ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(121);
    expect(text.endsWith('…')).toBe(true);
    expect(visibleText?.getAttribute('title')).toBe(longError);
  });

  it('renders each failed session as a compact entry with a one-line error summary', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    const entries = failedSessionEntries(container);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      // Every entry is the same tinted block as the pipeline error, not one
      // undifferentiated inline run.
      expect(entry.classList.contains('openbitfun-memory-settings__failure-entry')).toBe(true);
    }

    const summary = entries[1].querySelector('[data-testid="memories-status-stage1-failed-error"]');
    // The raw provider JSON body is not printed verbatim, the sentence in front
    // of it is, and the whole message stays on `title`.
    expect(summary?.textContent).toBe('403 Forbidden');
    expect(summary?.textContent).not.toContain('model_unavailable');
    expect(summary?.textContent).not.toContain('{"error');
    expect(summary?.getAttribute('title')).toBe(RAW_PROVIDER_ERROR);

    // The retry-exhausted marker is a design-system status pill, not bare text.
    expect(entries[0].querySelector('[data-testid="status-pill"]')?.getAttribute('data-tone'))
      .toBe('danger');
    expect(entries[0].querySelector('.openbitfun-memory-settings__failure-session')?.textContent)
      .toBe('0194f5a6…');
  });

  it('shows the failure age so a stale failure is answerable at a glance', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    const entries = failedSessionEntries(container);
    // The host reported a timestamp: it is rendered through the shared i18n
    // date helper, not with a raw epoch number.
    expect(entries[0].querySelector('[data-testid="memories-status-stage1-failed-at"]')?.textContent)
      .toBe('status.failed.failedAt:{"time":"DATE"}');

    // A host that stored no timestamp renders no age instead of a guessed date.
    expect(entries[1].querySelector('[data-testid="memories-status-stage1-failed-at"]')).toBeNull();
  });

  it('clears failed extraction records only after the confirm action', async () => {
    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    const clearButton = clearFailuresButton(container);
    expect(clearButton).not.toBeNull();

    await act(async () => {
      clearButton?.click();
    });
    await flush();

    // Opening the confirmation must not call the host on its own.
    expect(clearMemoryStage1FailuresMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="confirm-dialog-message"]')?.textContent)
      .toBe('status.failed.clearConfirm');

    await act(async () => {
      confirmDialogConfirmButton(container)?.click();
    });
    await flush();

    expect(clearMemoryStage1FailuresMock).toHaveBeenCalledTimes(1);
    expect(notifySuccessMock).toHaveBeenCalledWith('status.failed.cleared:{"count":2}');
    // The status card is re-read from the host instead of being patched locally.
    expect(getMemoryStatusMock).toHaveBeenCalledTimes(2);
  });

  it('reports a failed clear instead of claiming the records were removed', async () => {
    clearMemoryStage1FailuresMock.mockRejectedValue(new Error('host unreachable'));

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    await act(async () => {
      clearFailuresButton(container)?.click();
    });
    await flush();
    await act(async () => {
      confirmDialogConfirmButton(container)?.click();
    });
    await flush();

    expect(notifyErrorMock).toHaveBeenCalledWith('host unreachable');
    expect(notifySuccessMock).not.toHaveBeenCalled();
  });

  it('offers the clear action only when a session actually failed', async () => {
    getMemoryStatusMock.mockResolvedValue({ ...READY_STATUS, stage1Failed: [] });

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    expect(clearFailuresButton(container)).toBeNull();
    expect(failedSessionList(container)).toBeNull();
    expect(container.textContent).toContain('status.failed.none');
  });

  it('does not fabricate pipeline numbers when the status read fails', async () => {
    getMemoryStatusMock.mockRejectedValue(new Error('host unreachable'));

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    const alerts = Array.from(container.querySelectorAll('[data-testid="inline-message"]'))
      .map((element) => element.textContent ?? '');
    expect(alerts.some((text) => text.includes('host unreachable'))).toBe(true);
    expect(rowByLabel(container, 'status.fields.storedOutputs')).toBeNull();
    expect(clearFailuresButton(container)).toBeNull();
    expect(runNowButton(container)?.disabled).toBe(true);
  });

  it('disables the run-now button while automatic generation is off', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models' ? [] : { generate_memories: false }
    ));
    // The status payload disagrees on purpose: run-now follows the config this
    // page manages, not the status fetch.
    getMemoryStatusMock.mockResolvedValue({ ...READY_STATUS, generateMemories: true });

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    expect(runNowButton(container)?.disabled).toBe(true);
    expect(runMemoryPipelineNowMock).not.toHaveBeenCalled();
  });

  it('keeps run-now usable when the status read fails but generation is enabled', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models' ? [] : { generate_memories: true }
    ));
    getMemoryStatusMock.mockRejectedValue(new Error('host unreachable'));

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    // The status card reports its own failure...
    const alerts = Array.from(container.querySelectorAll('[data-testid="inline-message"]'))
      .map((element) => element.textContent ?? '');
    expect(alerts.some((text) => text.includes('host unreachable'))).toBe(true);

    // ...without turning the page's own run action into a dead end.
    expect(runNowButton(container)?.disabled).toBe(false);

    await act(async () => {
      runNowButton(container)?.click();
    });
    await flush();

    expect(runMemoryPipelineNowMock).toHaveBeenCalledTimes(1);
  });

  it('triggers the pipeline and keeps the button disabled while the run is in flight', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models' ? [] : { generate_memories: true }
    ));

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    expect(runNowButton(container)?.disabled).toBe(false);

    await act(async () => {
      runNowButton(container)?.click();
    });
    await flush();

    expect(runMemoryPipelineNowMock).toHaveBeenCalledTimes(1);
    expect(notifySuccessMock).toHaveBeenCalledWith('status.messages.pipelineStarted');
    expect(runNowButton(container)?.disabled).toBe(true);
  });

  it('reports a skipped trigger instead of claiming the pipeline started', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models' ? [] : { generate_memories: true }
    ));
    runMemoryPipelineNowMock.mockResolvedValue({ started: false });

    await act(async () => root.render(<MemorySettingsSection />));
    await flush();

    await act(async () => {
      runNowButton(container)?.click();
    });
    await flush();

    expect(notifyInfoMock).toHaveBeenCalledWith('status.messages.pipelineDisabled');
    expect(notifySuccessMock).not.toHaveBeenCalled();
    expect(runNowButton(container)?.disabled).toBe(false);
  });
});
