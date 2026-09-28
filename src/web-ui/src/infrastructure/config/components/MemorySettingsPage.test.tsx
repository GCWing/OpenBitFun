// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemorySettingsPage from './MemorySettingsPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const getConfigMock = vi.hoisted(() => vi.fn());
const updateConfigMock = vi.hoisted(() => vi.fn());
const resetConfigMock = vi.hoisted(() => vi.fn());
const getMemoryStatusMock = vi.hoisted(() => vi.fn());
const runMemoryPipelineNowMock = vi.hoisted(() => vi.fn());
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
  ConfirmDialog: () => null,
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
  ConfigPageSection: ({ children, description, extra, title, ...props }: {
    children: React.ReactNode;
    description?: React.ReactNode;
    extra?: React.ReactNode;
    title: string;
  } & React.HTMLAttributes<HTMLElement>) => (
    <section {...props}><h2>{title}</h2>{description}{extra}{children}</section>
  ),
}));

vi.mock('./common', createCommonMock);
vi.mock('@/infrastructure/config/components/common', createCommonMock);
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    getMemoryStatus: getMemoryStatusMock,
    runMemoryPipelineNow: runMemoryPipelineNowMock,
    getMemoryPaths: vi.fn(),
    resetMemory: vi.fn(),
  },
}));

vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: { revealInExplorer: vi.fn() },
}));

vi.mock('../services/ConfigManager', () => ({
  configManager: {
    getConfig: getConfigMock,
    updateConfig: updateConfigMock,
    resetConfig: resetConfigMock,
  },
}));

const READY_STATUS = {
  generateMemories: true,
  useMemories: false,
  memoryRootDir: 'D:/host/openbitfun/memories',
  stage1OutputCount: 7,
  stage1PendingPromotionCount: 2,
  stage1Failed: [
    { sessionId: '0194f5a6-89ab-7cde-8123-456789abcdef', lastError: 'provider unavailable', retryExhausted: true },
  ],
  phase2Status: 'error',
  phase2LastFinishedAtUnixSecs: 1_700_000_000,
  phase2LastError: 'consolidation failed',
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

async function expandAdvanced(container: HTMLElement) {
  const toggle = container.querySelector('[aria-label="actions.expandAdvanced"]');
  expect(toggle).not.toBeNull();
  await act(async () => {
    (toggle as HTMLButtonElement).click();
  });
  await flush();
}

describe('MemorySettingsPage truthfulness', () => {
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

    await act(async () => root.render(<MemorySettingsPage />));
    await flush();
    await expandAdvanced(container);

    expect(inputByLabel(container, 'fields.maxRolloutAgeDays.label')?.value).toBe('14');
    expect(inputByLabel(container, 'fields.maxUnusedDays.label')?.value).toBe('7');
    expect(updateConfigMock).not.toHaveBeenCalled();
  });

  it('refuses a retention of zero, which would delete every unused memory', async () => {
    await act(async () => root.render(<MemorySettingsPage />));
    await flush();
    await expandAdvanced(container);

    const retention = inputByLabel(container, 'fields.maxUnusedDays.label');
    expect(retention?.value).toBe('30');
    expect(retention?.getAttribute('min')).toBe('1');
    expect(inputByLabel(container, 'fields.maxRolloutAgeDays.label')?.getAttribute('min')).toBe('0');
  });

  it('mirrors the backend defaults when the host stores only non-default keys', async () => {
    await act(async () => root.render(<MemorySettingsPage />));
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

    await act(async () => root.render(<MemorySettingsPage />));
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
    await act(async () => root.render(<MemorySettingsPage />));
    await flush();

    expect(rowByLabel(container, 'status.fields.storedOutputs')?.textContent).toContain('n7');
    expect(rowByLabel(container, 'status.fields.pendingPromotion')?.textContent).toContain('n2');
    expect(rowByLabel(container, 'status.fields.phase2')?.textContent).toContain('shared:statuses.failed');
    expect(rowByLabel(container, 'status.fields.phase2')?.textContent).toContain('DATE');
    expect(rowByLabel(container, 'status.fields.phase2LastError')?.textContent)
      .toContain('consolidation failed');
    expect(rowByLabel(container, 'status.fields.rolloutSummaries')?.textContent).toContain('n3');
    // A `null` byte count is unknown, not zero.
    expect(rowByLabel(container, 'status.fields.memorySummary')?.textContent).toContain('status.unknown');
    expect(rowByLabel(container, 'status.failed.title')?.textContent).toContain('0194f5a6');
    expect(rowByLabel(container, 'status.failed.title')?.textContent).toContain('provider unavailable');
    expect(rowByLabel(container, 'status.failed.title')?.textContent).toContain('status.failed.retryExhausted');
  });

  it('does not fabricate pipeline numbers when the status read fails', async () => {
    getMemoryStatusMock.mockRejectedValue(new Error('host unreachable'));

    await act(async () => root.render(<MemorySettingsPage />));
    await flush();

    const alerts = Array.from(container.querySelectorAll('[data-testid="inline-message"]'))
      .map((element) => element.textContent ?? '');
    expect(alerts.some((text) => text.includes('host unreachable'))).toBe(true);
    expect(rowByLabel(container, 'status.fields.storedOutputs')).toBeNull();
    expect(runNowButton(container)?.disabled).toBe(true);
  });

  it('disables the run-now button while automatic generation is off', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models' ? [] : { generate_memories: false }
    ));
    // The status payload disagrees on purpose: run-now follows the config this
    // page manages, not the status fetch.
    getMemoryStatusMock.mockResolvedValue({ ...READY_STATUS, generateMemories: true });

    await act(async () => root.render(<MemorySettingsPage />));
    await flush();

    expect(runNowButton(container)?.disabled).toBe(true);
    expect(runMemoryPipelineNowMock).not.toHaveBeenCalled();
  });

  it('keeps run-now usable when the status read fails but generation is enabled', async () => {
    getConfigMock.mockImplementation(async (path: string) => (
      path === 'ai.models' ? [] : { generate_memories: true }
    ));
    getMemoryStatusMock.mockRejectedValue(new Error('host unreachable'));

    await act(async () => root.render(<MemorySettingsPage />));
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

    await act(async () => root.render(<MemorySettingsPage />));
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

    await act(async () => root.render(<MemorySettingsPage />));
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
