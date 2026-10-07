// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import ReviewCapacitySection from '@/app/scenes/settings/pages/ai/ReviewCapacitySection';

const loadDefaultReviewTeamMock = vi.hoisted(() => vi.fn());
const saveDefaultReviewTeamConcurrencyPolicyMock = vi.hoisted(() => vi.fn());
const notifySuccessMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());
const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => true));
const translateMock = vi.hoisted(() => (key: string, params?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    title: 'Review',
    subtitle: 'Review chooses the right depth for each request without exposing reviewer orchestration.',
    'desktopOnly.title': 'Desktop only',
    'desktopOnly.description': 'Review settings are available in the desktop app.',
    'error.title': 'Review settings unavailable',
    'error.retry': 'Retry',
    'capacity.title': 'Capacity',
    'capacity.description': 'Limit parallel Review work so cost and latency stay predictable.',
    'capacity.maxParallelReviewers.label': 'Parallel checks',
    'capacity.maxParallelReviewers.description': 'Choose whether checks and large-review batches run one or two at a time.',
    'capacity.maxQueueWaitSeconds.label': 'Queue wait',
    'capacity.maxQueueWaitSeconds.description': 'Maximum time Review waits for capacity.',
    'shared:features.deepReview': 'Review',
    'messages.saved': 'Saved',
    'messages.loadFailed': 'Failed to load Review settings.',
    'messages.saveFailed': 'Failed to save Review settings.',
    loading: 'Loading review settings',
  };
  if (key in translations) return translations[key];
  return key;
});

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: translateMock,
  }),
}));

vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
  ),
  NumberInput: ({
    disabled,
    value,
    onValueChange,
  }: {
    disabled?: boolean;
    value: number;
    onValueChange: (value: number) => void;
  }) => (
    <input
      type="number"
      disabled={disabled}
      value={value}
      onChange={(event) => onValueChange(Number(event.currentTarget.value))}
    />
  ),
}));

vi.mock('../../../../../infrastructure/config/components/common', () => ({
  ConfigLoadingState: ({ label }: { label: string }) => <div>{label}</div>,
  ConfigPageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConfigPageHeader: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
  ConfigPageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  ConfigPageRow: ({
    children,
    description,
    label,
  }: {
    children: React.ReactNode;
    description: string;
    label: string;
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
    title,
    titleSuffix,
  }: {
    children: React.ReactNode;
    description?: string;
    title: string;
    titleSuffix?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {titleSuffix}
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ),
}));

vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspacePath: 'D:/workspace/project' }),
}));

vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({
    success: notifySuccessMock,
    error: notifyErrorMock,
  }),
}));

vi.mock('@/shared/services/reviewTeamService', () => ({
  loadDefaultReviewTeam: loadDefaultReviewTeamMock,
  saveDefaultReviewTeamConcurrencyPolicy: saveDefaultReviewTeamConcurrencyPolicyMock,
}));

function createReviewTeam() {
  const coreMember = {
    id: 'member-logic',
    subagentId: 'ReviewBusinessLogic',
    displayName: 'Logic Reviewer',
    roleName: 'Business Logic Reviewer',
    definitionKey: 'businessLogic',
    source: 'core',
    locked: true,
    model: 'fast',
    strategyLevel: 'normal',
    strategyOverride: 'inherit',
    strategySource: 'team',
  };
  const extraMember = {
    id: 'member-extra',
    subagentId: 'ReviewDocs',
    displayName: 'Docs Reviewer',
    roleName: 'Documentation Reviewer',
    source: 'extra',
    locked: false,
    model: 'fast',
    strategyLevel: 'normal',
    strategyOverride: 'inherit',
    strategySource: 'team',
  };

  return {
    id: 'default-review-team',
    name: 'Strict Review Coverage',
    description: 'Strict review coverage.',
    warning: 'Review may take longer.',
    strategyLevel: 'normal',
    memberStrategyOverrides: {},
    executionPolicy: {},
    concurrencyPolicy: {
      maxParallelInstances: 2,
      maxQueueWaitSeconds: 300,
      providerCapacityQueueEnabled: true,
      autoRetryEnabled: true,
      autoRetryElapsedGuardSeconds: 120,
    },
    members: [coreMember, extraMember],
    coreMembers: [coreMember],
    extraMembers: [extraMember],
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ReviewCapacitySection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    isTauriRuntimeMock.mockReturnValue(true);

    loadDefaultReviewTeamMock.mockResolvedValue(createReviewTeam());
    saveDefaultReviewTeamConcurrencyPolicyMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('exposes only Review capacity controls inside the execution page', async () => {
    await act(async () => {
      root.render(<ReviewCapacitySection />);
    });
    await flushPromises();

    expect(container.textContent).toContain('Review');
    expect(container.textContent).not.toContain('Review workflow');
    expect(container.textContent).not.toContain('Review depth');
    expect(container.textContent).toContain('Capacity');
    expect(container.textContent).not.toContain('DeepReview');
    expect(container.textContent).not.toContain('Sub-Agent');
    expect(container.textContent).not.toContain('members.title');
    expect(container.textContent).not.toContain('extra.title');
    expect(container.textContent).not.toContain('team management');
    expect(container.textContent).not.toContain('orchestration controls');
  });

  it('renders an inline loading state without creating a standalone page', async () => {
    let resolveLoad: ((team: ReturnType<typeof createReviewTeam>) => void) | undefined;
    loadDefaultReviewTeamMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );

    await act(async () => {
      root.render(<ReviewCapacitySection />);
      await Promise.resolve();
    });

    expect(container.querySelector('main')).toBeNull();
    expect(container.textContent).toContain('Loading review settings');

    await act(async () => {
      resolveLoad?.(createReviewTeam());
      await Promise.resolve();
    });
  });

  it('shows an honest read-only boundary outside the desktop runtime', async () => {
    isTauriRuntimeMock.mockReturnValue(false);

    await act(async () => {
      root.render(<ReviewCapacitySection />);
    });
    await flushPromises();

    expect(container.textContent).toContain('Desktop only');
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(loadDefaultReviewTeamMock).not.toHaveBeenCalled();
  });

  it('shows a recoverable error state when desktop settings fail to load', async () => {
    loadDefaultReviewTeamMock.mockRejectedValueOnce(new Error('Temporary failure'));

    await act(async () => {
      root.render(<ReviewCapacitySection />);
    });
    await flushPromises();

    expect(container.textContent).toContain('Review settings unavailable');
    expect(container.textContent).toContain('Temporary failure');
    expect(container.textContent).toContain('Retry');
    expect(container.textContent).not.toContain('Loading review settings');

    loadDefaultReviewTeamMock.mockResolvedValueOnce(createReviewTeam());
    const retryButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry'))!;
    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Capacity');
  });

  it('saves capacity changes without exposing an ineffective depth selector', async () => {
    await act(async () => {
      root.render(<ReviewCapacitySection />);
    });
    await flushPromises();

    const numberInputs = Array.from(container.querySelectorAll('input[type="number"]'));
    expect(numberInputs).toHaveLength(2);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(numberInputs[0], '1');
      numberInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(saveDefaultReviewTeamConcurrencyPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxParallelInstances: 1 }),
    );
  });

  it('restores the last confirmed value when saving capacity fails', async () => {
    saveDefaultReviewTeamConcurrencyPolicyMock.mockRejectedValueOnce(
      new Error('Save failed'),
    );
    await act(async () => {
      root.render(<ReviewCapacitySection />);
    });
    await flushPromises();

    const parallelInput = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(parallelInput.value).toBe('2');

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(parallelInput, '4');
      parallelInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(parallelInput.value).toBe('2');
    expect(notifyErrorMock).toHaveBeenCalledWith('Save failed');
  });

  it('serializes capacity saves by locking both inputs', async () => {
    let resolveSave: (() => void) | undefined;
    saveDefaultReviewTeamConcurrencyPolicyMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    await act(async () => {
      root.render(<ReviewCapacitySection />);
    });
    await flushPromises();

    const numberInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    );
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(numberInputs[0], '4');
      numberInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(numberInputs.every((input) => input.disabled)).toBe(true);
    expect(saveDefaultReviewTeamConcurrencyPolicyMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });
    expect(numberInputs.every((input) => !input.disabled)).toBe(true);
  });
});
