import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import { deepReviewActionBarAppearanceDescriptor } from '../../deep-review/action-bar/appearance';
import { useReviewActionBarStore } from '../../store/deepReviewActionBarStore';
import { DeepReviewActionBar, ReviewActionBar } from './DeepReviewActionBar';

const sendMessageMock = vi.hoisted(() => vi.fn());
const eventBusEmitMock = vi.hoisted(() => vi.fn());
const confirmWarningMock = vi.hoisted(() => vi.fn());
const continueDeepReviewSessionMock = vi.hoisted(() => vi.fn());
const aggregateReviewerProgressMock = vi.hoisted(() => vi.fn(() => []));
const buildReviewerProgressSummaryMock = vi.hoisted(() => vi.fn(() => null));
const buildErrorAttributionMock = vi.hoisted(() => vi.fn(() => null));
const buildRecoveryPlanMock = vi.hoisted(() => vi.fn(() => ({
  willPreserve: ['ReviewSecurity'],
  willRerun: ['ReviewPerformance'],
  willSkip: [],
  summaryText: '1 completed reviewer will be preserved; 1 reviewer will be rerun',
})));
const controlDeepReviewQueueMock = vi.hoisted(() => vi.fn());
const flowChatSessionsMock = vi.hoisted(() => new Map<string, unknown>());
const prepareReviewLaunchMock = vi.hoisted(() => vi.fn());
const prepareReviewLaunchFromFilesMock = vi.hoisted(() => vi.fn());
const launchPreparedReviewMock = vi.hoisted(() => vi.fn());
const confirmReviewLaunchMock = vi.hoisted(() => vi.fn());
const persistReviewActionStateMock = vi.hoisted(() => vi.fn());
const openBtwSessionInAuxPaneMock = vi.hoisted(() => vi.fn());
const notificationWarningMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/i18n', async (importOriginal) => {
  const { default: errors } = await import('@/locales/zh-CN/errors.json');
  return {
    ...await importOriginal<typeof import('@/infrastructure/i18n')>(),
    useI18n: () => ({
      t: (key: string) => key.replace(/^errors:/, '').split('.').reduce<any>((value, part) => value?.[part], errors) ?? key,
    }),
  };
});

vi.mock('react-i18next', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    initReactI18next: {
      type: '3rdParty',
      init: vi.fn(),
    },
    useTranslation: () => ({
      t: createTestI18nT('flow-chat'),
    }),
  };
});

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Icon: ({ name }: { name: string }) => <span data-openbitfun-component="icon" data-openbitfun-name={name} />,
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Checkbox: ({
    checked,
    disabled,
    indeterminate,
    label,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    indeterminate?: boolean;
    label?: React.ReactNode;
    onChange?: () => void;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked ? 'true' : 'false'}
        checked={checked}
        disabled={disabled}
        readOnly
        onClick={() => {
          if (!disabled) {
            onChange?.();
          }
        }}
      />
      {label}
    </label>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../services/FlowChatManager', () => ({
  flowChatManager: {
    sendMessage: sendMessageMock,
  },
}));

vi.mock('../../services/ReviewService', () => ({
  prepareReviewLaunchFromSlashCommand: prepareReviewLaunchMock,
  prepareReviewLaunchFromSessionFiles: prepareReviewLaunchFromFilesMock,
  launchPreparedReviewSession: launchPreparedReviewMock,
}));

vi.mock('../../components/DeepReviewConsentDialog', () => ({
  useDeepReviewConsent: () => ({
    confirmDeepReviewLaunch: confirmReviewLaunchMock,
    deepReviewConsentDialog: null,
  }),
}));

vi.mock('../../services/ReviewActionBarPersistenceService', () => ({
  persistReviewActionState: (...args: unknown[]) => persistReviewActionStateMock(...args),
}));

vi.mock('../../services/btwSessionPane', () => ({
  openBtwSessionInAuxPane: (...args: unknown[]) => openBtwSessionInAuxPaneMock(...args),
}));

vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({
  agentAPI: {
    controlDeepReviewQueue: controlDeepReviewQueueMock,
  },
}));

vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: () => true,
  isOpenHarmonyRuntime: () => false,
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: {
    emit: eventBusEmitMock,
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmWarning: confirmWarningMock,
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: notificationWarningMock,
  },
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => ({
      sessions: flowChatSessionsMock,
      activeSessionId: null,
    }),
    subscribe: () => () => {},
  },
}));

vi.mock('../../utils/deepReviewExperience', () => ({
  aggregateReviewerProgress: aggregateReviewerProgressMock,
  buildReviewerProgressSummary: buildReviewerProgressSummaryMock,
  extractPartialReviewData: () => null,
  buildErrorAttribution: buildErrorAttributionMock,
  buildRecoveryPlan: buildRecoveryPlanMock,
  evaluateDegradationOptions: () => [],
}));

vi.mock('../../services/DeepReviewContinuationService', () => ({
  continueDeepReviewSession: continueDeepReviewSessionMock,
}));

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

describeWithJsdom('DeepReviewActionBar', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('localStorage', window.localStorage);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    sendMessageMock.mockResolvedValue(undefined);
    prepareReviewLaunchMock.mockResolvedValue({
      mode: 'standard',
      level: 'l1',
      requiresConsent: false,
    });
    prepareReviewLaunchFromFilesMock.mockResolvedValue({
      mode: 'standard',
      level: 'l1',
      requiresConsent: false,
    });
    launchPreparedReviewMock.mockResolvedValue({ childSessionId: 'follow-up-review' });
    confirmReviewLaunchMock.mockResolvedValue(true);
    persistReviewActionStateMock.mockResolvedValue(undefined);
    confirmWarningMock.mockResolvedValue(true);
    eventBusEmitMock.mockReturnValue(false);
    continueDeepReviewSessionMock.mockResolvedValue(undefined);
    buildErrorAttributionMock.mockReturnValue(null);
    aggregateReviewerProgressMock.mockReturnValue([]);
    buildReviewerProgressSummaryMock.mockReturnValue(null);
    flowChatSessionsMock.clear();
    useReviewActionBarStore.getState().reset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    flowChatSessionsMock.clear();
    useReviewActionBarStore.getState().reset();
  });

  it('shows a non-blocking managed coverage summary while Review is running', async () => {
    flowChatSessionsMock.set('managed-review-session', {
      sessionId: 'managed-review-session',
      sessionKind: 'review',
      dialogTurns: [],
      deepReviewRunManifest: {
        managedReviewPlan: {
          version: 1,
          totalFileCount: 500,
          plannedFileCount: 128,
          deferredFileCount: 372,
          maxFilesPerBatch: 40,
          maxBatches: 8,
          maxParallelInstances: 2,
          workerTimeoutSeconds: 120,
        },
      },
    });
    useReviewActionBarStore.getState().showRunningActionBar({
      childSessionId: 'managed-review-session',
      parentSessionId: 'parent-session',
      reviewMode: 'standard',
    });

    await act(async () => {
      root.render(<ReviewActionBar childSessionId="managed-review-session" />);
    });

    expect(container.textContent).toContain('128/500');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('372');
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });

  it('localizes the dialog-start summary while preserving the complete original diagnostic', async () => {
    const store = useReviewActionBarStore.getState();
    store.showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix the provider failure.'],
      },
      phase: 'fix_failed',
    });
    store.updatePhase(
      'fix_failed',
      'Failed to start dialog turn: provider quota exhausted',
      'child-session',
    );

    await act(async () => {
      root.render(<ReviewActionBar childSessionId="child-session" />);
    });

    const displayedError = container.querySelector('.deep-review-action-bar__error-message');
    expect(displayedError?.firstElementChild?.textContent).toBe(
      'Unable to start this action: provider quota exhausted',
    );
    expect(displayedError?.lastElementChild?.textContent).toBe(
      'Failed to start dialog turn: provider quota exhausted',
    );
  });

  it.each([
    [new Error('Failed to start dialog turn: provider quota exhausted'), 'Unable to start this action: provider quota exhausted'],
    [Object.assign(new Error('Network connection was interrupted before Review could start.'), {
      launchErrorMessageKey: 'deepReviewActionBar.launchError.network',
      originalMessage: 'Failed to start dialog turn: provider connection closed',
    }), 'Network connection interrupted. Review failed to start.\nprovider connection closed'],
  ])('shows the same launch error in the header and notification: %s', async (error, message) => {
    const { notificationService } = await import('@/shared/notification-system');
    sendMessageMock.mockRejectedValueOnce(error);
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix the provider failure.'],
      },
      phase: 'review_completed',
    });
    await act(async () => root.render(<ReviewActionBar childSessionId="child-session" />));
    const startFixButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Start fixing'));
    expect(startFixButton).toBeTruthy();
    await act(async () => {
      startFixButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(notificationService.error).toHaveBeenCalledWith(message, { duration: 5000, metadata: { rawError: error.message } });
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('Failed to start dialog turn:');
  });

  it('keeps remediation in progress after submitting a fix turn', async () => {
    flowChatSessionsMock.set('child-session', {
      sessionId: 'child-session',
      sessionKind: 'review',
      dialogTurns: [
        {
          id: 'review-turn-1',
          status: 'completed',
          modelRounds: [],
        },
      ],
    });

    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: {
          recommended_action: 'request_changes',
        },
        issues: [
          {
            severity: 'high',
            title: 'Incorrect branch',
          },
        ],
        remediation_plan: ['Fix the incorrect branch.'],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const startFixButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Start fixing'));

    expect(startFixButton).toBeTruthy();

    await act(async () => {
      startFixButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const state = useReviewActionBarStore.getState();
    expect(state.phase).toBe('fix_running');
    expect(state.minimized).toBe(true);
    expect(state.fixingBaselineTurnId).toBe('review-turn-1');
    expect(container.textContent).toContain('Fix the incorrect branch.');
    expect(container.textContent).toContain('Fixing');
    const itemCheckbox = container.querySelector<HTMLInputElement>(
      '.deep-review-action-bar__remediation-item input[type="checkbox"]',
    );
    expect(itemCheckbox?.disabled).toBe(true);
  });

  it.each([new Error('network timeout: upstream did not respond'), 'network timeout: upstream did not respond'])(
    'localizes remediation failures and retains complete diagnostics: %s', async (failure) => {
      const { notificationService } = await import('@/shared/notification-system');
      sendMessageMock.mockRejectedValueOnce(failure);
      useReviewActionBarStore.getState().showActionBar({
        childSessionId: 'review-session',
        parentSessionId: 'parent-session',
        reviewMode: 'standard',
        reviewData: {
          summary: { recommended_action: 'request_changes' },
          remediation_plan: ['Fix the finding.'],
        },
        phase: 'review_completed',
      });
      await act(async () => root.render(<ReviewActionBar />));
      const button = Array.from(container.querySelectorAll('button'))
        .find(item => item.textContent?.includes('Start fixing'))!;
      await act(async () => button.click());
      const [message, options] = vi.mocked(notificationService.error).mock.calls.at(-1)!;
      expect(message).toMatch(/[\u3400-\u9fff]/);
      expect(message).not.toContain('upstream did not respond');
      expect(options?.metadata?.rawError).toBe('network timeout: upstream did not respond');
      const displayedError = container.querySelector('.deep-review-action-bar__error-message');
      expect(displayedError?.textContent).toContain(message);
      expect(displayedError?.lastElementChild?.textContent).toBe(options?.metadata?.rawError);
      expect(useReviewActionBarStore.getState().phase).toBe('fix_timeout');
    },
  );

  it('uses a separate ReviewFixer agent for standard review remediation', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'review-session',
      parentSessionId: 'parent-session',
      reviewMode: 'standard',
      reviewData: {
        summary: {
          recommended_action: 'request_changes',
        },
        remediation_plan: ['Fix the standard review finding.'],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<ReviewActionBar />);
    });

    const startFixButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Start fixing'));

    expect(startFixButton).toBeTruthy();

    await act(async () => {
      startFixButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [prompt, sessionId, displayMessage, agentType] = sendMessageMock.mock.calls[0];
    expect(prompt).toContain('selected Review findings only');
    expect(prompt).not.toContain('follow-up standard review');
    expect(sessionId).toBe('review-session');
    expect(displayMessage).toBe('Start fixing Review findings');
    expect(agentType).toBe('ReviewFixer');
  });

  it('asks for confirmation before replacing existing chat input text', async () => {
    eventBusEmitMock.mockImplementation((event: string, payload: { getValue?: () => string }) => {
      if (event === 'chat-input:get-state') {
        payload.getValue = () => 'existing draft';
      }
      return true;
    });
    confirmWarningMock.mockResolvedValue(false);

    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const fillButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Fill to input'));
    expect(fillButton).toBeTruthy();

    await act(async () => {
      fillButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(confirmWarningMock).toHaveBeenCalledTimes(1);
    expect(eventBusEmitMock).not.toHaveBeenCalledWith('fill-chat-input', expect.anything());
    expect(useReviewActionBarStore.getState().minimized).toBe(false);
  });

  it('fills chat input and minimizes the action bar when current input is empty', async () => {
    eventBusEmitMock.mockImplementation((event: string, payload: { getValue?: () => string }) => {
      if (event === 'chat-input:get-state') {
        payload.getValue = () => '  ';
      }
      return true;
    });

    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const fillButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Fill to input'));
    expect(fillButton).toBeTruthy();

    await act(async () => {
      fillButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(confirmWarningMock).not.toHaveBeenCalled();
    expect(eventBusEmitMock).toHaveBeenCalledWith('fill-chat-input', expect.objectContaining({
      mode: 'replace',
    }));
    expect(useReviewActionBarStore.getState().minimized).toBe(true);
  });

  it('minimizes action bar when close button is clicked', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1', 'Fix issue 2'],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const closeButton = container.querySelector('.deep-review-action-bar__controls-btn');
    expect(closeButton).toBeTruthy();

    await act(async () => {
      closeButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const state = useReviewActionBarStore.getState();
    expect(state.minimized).toBe(true);
  });

  it('does not show capacity queue controls when there is no queue state', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    expect(container.textContent).not.toContain('Review waiting for capacity');
    expect(Array.from(container.querySelectorAll('button')).some((button) => (
      button.textContent?.includes('Pause waiting')
    ))).toBe(false);
  });

  it('shows compact capacity queue controls and keeps them locally adjustable', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      phase: 'review_completed',
    });
    useReviewActionBarStore.setState({
      capacityQueueState: {
        status: 'queued_for_capacity',
        reason: 'provider_concurrency_limit',
        queuedReviewerCount: 2,
        activeReviewerCount: 1,
        optionalReviewerCount: 1,
        queueElapsedMs: 12_000,
        maxQueueWaitSeconds: 60,
        sessionConcurrencyHigh: true,
      },
    } as Partial<ReturnType<typeof useReviewActionBarStore.getState>>);

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    expect(container.textContent).toContain('Waiting for model capacity');
    expect(container.textContent).toContain('OpenBitFun is waiting for temporary model capacity.');
    expect(container.textContent).toContain('Reason: model concurrency limit');
    expect(container.textContent).toContain('Waited 12s of 1m 0s');
    expect(container.textContent).toContain('Your active session is busy.');
    expect(container.textContent).not.toContain('Run slower next time');
    expect(container.textContent).toContain('Open Review settings');

    const pauseButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Pause waiting'));
    expect(pauseButton).toBeTruthy();

    await act(async () => {
      pauseButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect((useReviewActionBarStore.getState() as unknown as {
      capacityQueueState: { status: string };
    }).capacityQueueState.status).toBe('paused_by_user');
    expect(container.textContent).toContain('Review wait paused');

    const openSettingsButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Open Review settings'));
    expect(openSettingsButton).toBeTruthy();

    await act(async () => {
      openSettingsButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const { useSettingsStore } = await import('@/app/scenes/settings/settingsStore');
    expect(useSettingsStore.getState().activePageId).toBe('ai.execution');
    expect(useSettingsStore.getState().activeViewId).toBeNull();
  });

  it('sends backend queue control actions for event-driven capacity waits', async () => {
    controlDeepReviewQueueMock.mockResolvedValue(undefined);

    useReviewActionBarStore.getState().showCapacityQueueBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      capacityQueueState: {
        toolId: 'task-queue-1',
        subagentType: 'ReviewSecurity',
        dialogTurnId: 'turn-queue-1',
        status: 'queued_for_capacity',
        queuedReviewerCount: 2,
        activeReviewerCount: 1,
        optionalReviewerCount: 1,
        controlMode: 'backend',
        waitingReviewers: [
          {
            toolId: 'task-queue-1',
            subagentType: 'ReviewSecurity',
            displayName: 'Security reviewer',
            status: 'queued_for_capacity',
          },
          {
            toolId: 'task-queue-2',
            subagentType: 'ReviewFrontend',
            displayName: 'Frontend reviewer',
            status: 'queued_for_capacity',
          },
        ],
      },
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const pauseButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Pause waiting'));
    expect(pauseButton).toBeTruthy();

    await act(async () => {
      pauseButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(controlDeepReviewQueueMock).toHaveBeenCalledTimes(2);
    expect(controlDeepReviewQueueMock).toHaveBeenCalledWith({
      sessionId: 'child-session',
      dialogTurnId: 'turn-queue-1',
      toolId: 'task-queue-1',
      action: 'pause',
    });
    expect(controlDeepReviewQueueMock).toHaveBeenCalledWith({
      sessionId: 'child-session',
      dialogTurnId: 'turn-queue-1',
      toolId: 'task-queue-2',
      action: 'pause',
    });
    expect((useReviewActionBarStore.getState() as unknown as {
      capacityQueueState: { status: string };
    }).capacityQueueState.status).toBe('paused_by_user');
  });

  it('shows the backend reason when queue control fails', async () => {
    const { notificationService } = await import('@/shared/notification-system');
    controlDeepReviewQueueMock.mockRejectedValueOnce(new Error('backend queue already closed'));

    useReviewActionBarStore.getState().showCapacityQueueBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      capacityQueueState: {
        toolId: 'task-queue-1',
        subagentType: 'ReviewSecurity',
        dialogTurnId: 'turn-queue-1',
        status: 'queued_for_capacity',
        queuedReviewerCount: 1,
        controlMode: 'backend',
      },
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const pauseButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Pause waiting'));
    expect(pauseButton).toBeTruthy();

    await act(async () => {
      pauseButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(notificationService.error).toHaveBeenCalledWith(
      expect.stringContaining('backend queue already closed'),
    );
    expect(notificationService.error).toHaveBeenCalledWith(
      expect.stringContaining('use Stop to interrupt the review'),
    );
  });

  it('reports partial backend queue control failures without claiming full success', async () => {
    const { notificationService } = await import('@/shared/notification-system');
    controlDeepReviewQueueMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('tool already running'));

    useReviewActionBarStore.getState().showCapacityQueueBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      capacityQueueState: {
        toolId: 'task-queue-1',
        subagentType: 'ReviewSecurity',
        dialogTurnId: 'turn-queue-1',
        status: 'queued_for_capacity',
        queuedReviewerCount: 2,
        controlMode: 'backend',
        waitingReviewers: [
          {
            toolId: 'task-queue-1',
            subagentType: 'ReviewSecurity',
            displayName: 'Security reviewer',
            status: 'queued_for_capacity',
          },
          {
            toolId: 'task-queue-2',
            subagentType: 'ReviewFrontend',
            displayName: 'Frontend reviewer',
            status: 'queued_for_capacity',
          },
        ],
      },
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const pauseButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Pause waiting'));
    expect(pauseButton).toBeTruthy();

    await act(async () => {
      pauseButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(controlDeepReviewQueueMock).toHaveBeenCalledTimes(2);
    expect(notificationService.error).toHaveBeenCalledWith(
      expect.stringContaining('1 of 2 review items failed'),
    );
    expect(notificationService.error).toHaveBeenCalledWith(
      expect.stringContaining('tool already running'),
    );
    expect((useReviewActionBarStore.getState() as unknown as {
      capacityQueueState: { status: string };
    }).capacityQueueState.status).toBe('queued_for_capacity');
  });

  it('starts a structured retry turn for explicit incomplete strict review coverage', async () => {
    flowChatSessionsMock.set('deep-review-session', {
      sessionId: 'deep-review-session',
      sessionKind: 'deep_review',
      deepReviewRunManifest: {
        reviewMode: 'deep',
        workPackets: [
          {
            packetId: 'reviewer:ReviewSecurity:group-1-of-2',
            phase: 'reviewer',
            launchBatch: 0,
            subagentId: 'ReviewSecurity',
            displayName: 'Security reviewer',
            roleName: 'Security reviewer',
            assignedScope: {
              kind: 'review_target',
              targetSource: 'session_files',
              targetResolution: 'resolved',
              targetTags: ['security'],
              fileCount: 2,
              files: ['src/auth.ts', 'src/session.ts'],
              excludedFileCount: 0,
              groupIndex: 1,
              groupCount: 2,
            },
            allowedTools: ['Read', 'GetFileDiff'],
            timeoutSeconds: 300,
            requiredOutputFields: ['summary', 'findings'],
            strategyLevel: 'deep',
            strategyDirective: 'Review security-sensitive changes.',
            model: 'fast-model',
          },
        ],
      },
    });

    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'deep-review-session',
      parentSessionId: 'parent-session',
      reviewMode: 'deep',
      reviewData: {
        review_mode: 'deep',
        summary: { recommended_action: 'request_changes' },
        reviewers: [
          {
            name: 'Security reviewer',
            specialty: 'security',
            status: 'partial_timeout',
            summary: 'Timed out after completing src/session.ts.',
            packet_id: 'reviewer:ReviewSecurity:group-1-of-2',
            covered_files: ['src/session.ts'],
            retry_scope_files: ['src/auth.ts'],
          },
        ],
      },
      phase: 'review_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const retryButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Retry incomplete review work'));
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [prompt, sessionId, displayMessage, agentType] = sendMessageMock.mock.calls[0];
    expect(prompt).toContain('"retry_coverage"');
    expect(prompt).toContain('"source_packet_id": "reviewer:ReviewSecurity:group-1-of-2"');
    expect(prompt).toContain('"retry_scope_files"');
    expect(sessionId).toBe('deep-review-session');
    expect(displayMessage).toContain('Retry 1 incomplete');
    expect(agentType).toBe('DeepReview');
  });

  it('offers an independent follow-up review after remediation completes', async () => {
    flowChatSessionsMock.set('child-session', {
      sessionId: 'child-session',
      sessionKind: 'review',
      workspacePath: 'D:/workspace/project',
      reviewTargetFilePaths: ['src/auth.ts'],
      dialogTurns: [],
    });
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      reviewMode: 'standard',
      phase: 'fix_completed',
    });
    useReviewActionBarStore.getState().setRemediationModifiedFilePaths(
      ['src/helper.ts'],
      'child-session',
    );

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const reviewFixesButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Review fixes'));
    expect(reviewFixesButton).toBeTruthy();

    launchPreparedReviewMock.mockImplementationOnce(async () => {
      flowChatSessionsMock.set('follow-up-review', {
        sessionId: 'follow-up-review',
        sessionKind: 'review',
        workspacePath: 'D:/workspace/project',
        config: { agentType: 'CodeReview' },
        status: 'idle',
        dialogTurns: [{ id: 'follow-up-turn', status: 'completed', modelRounds: [] }],
      });
      return { childSessionId: 'follow-up-review' };
    });

    await act(async () => {
      reviewFixesButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(prepareReviewLaunchFromFilesMock).toHaveBeenCalledWith(
      ['src/auth.ts', 'src/helper.ts'],
      { workspacePath: 'D:/workspace/project' },
    );
    expect(prepareReviewLaunchMock).not.toHaveBeenCalled();
    expect(launchPreparedReviewMock).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: 'parent-session',
      workspacePath: 'D:/workspace/project',
      displayMessage: 'Review the remediation changes',
    }));
    expect(persistReviewActionStateMock).toHaveBeenCalledTimes(2);
    expect(persistReviewActionStateMock.mock.invocationCallOrder[0])
      .toBeLessThan(launchPreparedReviewMock.mock.invocationCallOrder[0]);
    const launchRequestId = launchPreparedReviewMock.mock.calls[0]?.[0]?.requestId;
    const persistedReservation = persistReviewActionStateMock.mock.calls[0]?.[0]
      ?.sessionStates?.['child-session']?.followUpReviewSessionId;
    expect(launchRequestId).toMatch(/^review_follow_up/);
    expect(persistedReservation).toBe(
      `__pending_follow_up_review__:${launchRequestId}`,
    );
    expect(useReviewActionBarStore.getState().getSessionState('child-session')?.followUpReviewSessionId)
      .toBe('follow-up-review');
    const viewReviewButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('View review'));
    expect(viewReviewButton?.disabled).toBe(false);

    await act(async () => {
      viewReviewButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(launchPreparedReviewMock).toHaveBeenCalledTimes(1);
    expect(openBtwSessionInAuxPaneMock).toHaveBeenCalledWith(expect.objectContaining({
      childSessionId: 'follow-up-review',
      parentSessionId: 'parent-session',
    }));
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('surfaces an uncertain follow-up without automatically launching again', async () => {
    flowChatSessionsMock.set('child-session', {
      sessionId: 'child-session',
      sessionKind: 'review',
      workspacePath: 'D:/workspace/project',
      reviewTargetFilePaths: ['src/auth.ts'],
      dialogTurns: [],
    });
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      reviewMode: 'standard',
      phase: 'fix_completed',
    });
    launchPreparedReviewMock.mockResolvedValueOnce({
      childSessionId: 'follow-up-review',
      launchStatus: 'uncertain',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });
    const reviewButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Review fixes'))!;

    await act(async () => {
      reviewButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(launchPreparedReviewMock).toHaveBeenCalledTimes(1);
    expect(useReviewActionBarStore.getState().getSessionState('child-session')?.followUpReviewSessionId)
      .toBe('follow-up-review');
    expect(notificationWarningMock).toHaveBeenCalledWith(
      expect.stringContaining('may already be running'),
      { duration: 8000 },
    );
  });

  it('opens a metadata-only follow-up review without launching a duplicate', async () => {
    flowChatSessionsMock.set('child-session', {
      sessionId: 'child-session',
      sessionKind: 'review',
      workspacePath: 'D:/workspace/project',
      dialogTurns: [],
    });
    flowChatSessionsMock.set('historical-follow-up', {
      sessionId: 'historical-follow-up',
      sessionKind: 'review',
      workspacePath: 'D:/workspace/project',
      status: 'idle',
      config: { agentType: 'CodeReview' },
      dialogTurns: [],
      isHistorical: true,
      historyState: 'metadata-only',
    });
    const store = useReviewActionBarStore.getState();
    store.showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      reviewMode: 'standard',
      phase: 'fix_completed',
    });
    store.setFollowUpReviewSessionId('historical-follow-up', 'child-session');

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });
    const openButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Open review'))!;

    await act(async () => {
      openButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(openBtwSessionInAuxPaneMock).toHaveBeenCalledWith(expect.objectContaining({
      childSessionId: 'historical-follow-up',
      parentSessionId: 'parent-session',
    }));
    expect(launchPreparedReviewMock).not.toHaveBeenCalled();
  });

  it('confirms a newly prepared broader follow-up plan before launching it', async () => {
    const runManifest = {
      reviewMode: 'deep',
      target: { files: [] },
    };
    const prepared = {
      mode: 'strict',
      level: 'l2',
      requiresConsent: true,
      runManifest,
    };
    prepareReviewLaunchMock.mockResolvedValueOnce(prepared);
    flowChatSessionsMock.set('deep-review-session', {
      sessionId: 'deep-review-session',
      sessionKind: 'deep_review',
      workspacePath: 'D:/workspace/project',
      dialogTurns: [],
    });
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'deep-review-session',
      parentSessionId: 'parent-session',
      reviewData: {
        review_mode: 'deep',
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1'],
      },
      reviewMode: 'deep',
      phase: 'fix_completed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const reviewFixesButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Review fixes'));

    await act(async () => {
      reviewFixesButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(confirmReviewLaunchMock).toHaveBeenCalledWith(
      runManifest,
      expect.objectContaining({ sessionConcurrencyGuard: expect.any(Object) }),
    );
    expect(launchPreparedReviewMock).toHaveBeenCalledWith(expect.objectContaining({ prepared }));
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('requires explicit decision confirmation before executing selected decision remediation', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        review_mode: 'deep',
        summary: { recommended_action: 'request_changes' },
        report_sections: {
          remediation_groups: {
            needs_decision: [{
              question: 'Which migration strategy should we use?',
              plan: 'Choose a migration strategy before editing.',
              options: ['Fast path', 'Staged path'],
              tradeoffs: 'Fast path is risky; staged path is safer.',
              recommendation: 1,
            }],
          },
        },
      },
      phase: 'review_completed',
    });
    useReviewActionBarStore.getState().setSelectedRemediationIds(new Set(['remediation-needs_decision-0']));

    const onKeyDown = vi.fn();
    await act(async () => {
      root.render(<div onKeyDown={onKeyDown}><DeepReviewActionBar /></div>);
    });

    const customToggle = container.querySelector<HTMLButtonElement>('.deep-review-action-bar__custom-toggle')!;
    await act(async () => customToggle.click());
    const input = container.querySelector<HTMLTextAreaElement>('textarea[data-openbitfun-product-part="customInput"]')!;
    expect(input.rows).toBe(2);
    expect(input.getAttribute('data-openbitfun-part')).toBe('input');
    expect(input.parentElement?.getAttribute('data-auto-resize')).toBe('false');
    expect(input.parentElement?.getAttribute('data-resize')).toBe('vertical');
    const instructions = 'Keep existing data.\n保留兼容行为。';
    act(() => {
      input.value = instructions;
      Simulate.change(input);
      Simulate.compositionStart(input);
      Simulate.keyDown(input, { key: 'Enter' });
      Simulate.keyDown(input, { key: 'Escape' });
    });
    expect(onKeyDown).not.toHaveBeenCalled();
    act(() => {
      Simulate.compositionEnd(input);
      Simulate.keyDown(input, { key: 'Enter' });
    });
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(sendMessageMock).not.toHaveBeenCalled();

    const legacy: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.review-input', name: 'Review input', version: '1.0.0', mode: 'dark',
      components: { 'deep-review-action-bar': { parts: {
        customInput: { base: { opacity: { kind: 'number', value: 0.6 } } },
      } } },
    };
    const serialized = JSON.stringify(legacy);
    const restored = JSON.parse(serialized) as AppearancePackage;
    const snapshot = new AppearanceCompiler(new AppearanceRegistry()
      .registerComponent(deepReviewActionBarAppearanceDescriptor)).compile(restored, 1);
    expect(JSON.stringify(restored)).toBe(serialized);
    document.documentElement.setAttribute('data-openbitfun-appearance', snapshot.id);
    document.documentElement.setAttribute('data-openbitfun-appearance-revision', String(snapshot.revision));
    const style = document.createElement('style');
    style.textContent = snapshot.cssText;
    document.head.appendChild(style);
    const rule = Array.from(style.sheet!.cssRules).find(candidate =>
      candidate instanceof dom.window.CSSStyleRule && candidate.style.opacity === '0.6',
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();
    expect(document.querySelector(rule!.selectorText)).toBe(input);

    await act(async () => customToggle.click());
    expect(container.querySelector('textarea')).toBeNull();
    await act(async () => customToggle.click());
    expect(container.querySelector('textarea')?.value).toBe(instructions);

    const startFixButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Start fixing'));
    expect(startFixButton).toBeTruthy();

    await act(async () => {
      startFixButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Confirm decision items before fixing');
    expect(container.textContent).toContain('Which migration strategy should we use?');
    expect(container.textContent).toContain('Fast path is risky; staged path is safer.');
    const supplement = container.querySelector<HTMLTextAreaElement>('.deep-review-action-bar__decision-gate-supplement textarea')!;
    expect(supplement.value).toBe(instructions);
    expect(supplement.rows).toBe(2);
    expect(supplement.labels?.[0]?.className).toBe('deep-review-action-bar__decision-gate-supplement');
    const updatedInstructions = `${instructions}\nUse the staged rollout.`;
    act(() => {
      supplement.value = updatedInstructions;
      Simulate.change(supplement);
    });

    const confirmBeforeSelection = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Confirm and start')) as HTMLButtonElement | undefined;
    expect(confirmBeforeSelection?.disabled).toBe(true);

    const stagedPathButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.deep-review-action-bar__decision-gate-option'))
      .find((button) => button.textContent?.includes('Staged path'));
    expect(stagedPathButton).toBeTruthy();
    expect(stagedPathButton?.closest('[data-openbitfun-component="action-card"]')).not.toBeNull();
    expect(container.querySelector('.deep-review-action-bar__decision-gate-options [role="radio"]')).toBeNull();

    await act(async () => {
      stagedPathButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const confirmButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Confirm and start')) as HTMLButtonElement | undefined;
    expect(confirmButton).toBeTruthy();
    expect(confirmButton?.disabled).toBe(false);

    await act(async () => {
      confirmButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [prompt] = sendMessageMock.mock.calls[0];
    expect(prompt).toContain('User chose option 2: Staged path');
    expect(prompt).toContain(updatedInstructions);
    expect(prompt).not.toContain('Recommended option 2: Staged path');
  });

  it('toggles the Other group from partial selection and excludes completed items', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Completed fix', 'Fix issue 1', 'Fix issue 2'],
      },
      phase: 'review_completed',
      completedRemediationIds: new Set(['remediation-0']),
    });
    useReviewActionBarStore.getState().setSelectedRemediationIds(new Set(['remediation-1']));

    await act(async () => {
      root.render(<ReviewActionBar childSessionId="child-session" />);
    });

    const groupCheckbox = container.querySelector<HTMLInputElement>(
      '.deep-review-action-bar__remediation-group-header input[type="checkbox"]',
    )!;
    expect(groupCheckbox.getAttribute('aria-checked')).toBe('mixed');

    await act(async () => { groupCheckbox.click(); });
    expect([...useReviewActionBarStore.getState().selectedRemediationIds].sort())
      .toEqual(['remediation-1', 'remediation-2']);
    expect(groupCheckbox.checked).toBe(true);

    await act(async () => { groupCheckbox.click(); });
    expect(useReviewActionBarStore.getState().selectedRemediationIds.size).toBe(0);
    expect(groupCheckbox.checked).toBe(false);

    await act(async () => { groupCheckbox.click(); });
    expect([...useReviewActionBarStore.getState().selectedRemediationIds].sort())
      .toEqual(['remediation-1', 'remediation-2']);
    expect(groupCheckbox.checked).toBe(true);
  });

  it('marks completed remediation items when fix completes', async () => {
    const store = useReviewActionBarStore.getState();
    store.showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1', 'Fix issue 2'],
      },
      phase: 'review_completed',
    });

    // Select all items
    const items = store.remediationItems;
    for (const item of items) {
      store.toggleRemediation(item.id);
    }

    store.setActiveAction('fix');
    store.updatePhase('fix_running');

    // Simulate fix completion
    store.updatePhase('fix_completed');

    const state = useReviewActionBarStore.getState();
    expect(state.completedRemediationIds.size).toBe(2);
    expect(state.phase).toBe('fix_completed');
    expect(state.fixingRemediationIds.size).toBe(0);
  });

  it('shows completed items as disabled and strikethrough', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1', 'Fix issue 2'],
      },
      phase: 'review_completed',
      completedRemediationIds: new Set(['remediation-0']),
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const completedItem = container.querySelector('.deep-review-action-bar__remediation-item--completed');
    expect(completedItem).toBeTruthy();

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
  });

  it('shows continue fix UI when phase is fix_interrupted', async () => {
    useReviewActionBarStore.getState().showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1', 'Fix issue 2'],
      },
      phase: 'fix_interrupted',
    });

    // Set remaining fix IDs directly on state
    const store = useReviewActionBarStore.getState();
    (store as unknown as { remainingFixIds: string[] }).remainingFixIds = ['remediation-0'];

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const continueButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Recheck and continue'));
    expect(continueButton).toBeTruthy();

    const skipButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Skip remaining'));
    expect(skipButton).toBeTruthy();
  });

  it('skips remaining fixes and returns to review_completed', async () => {
    const store = useReviewActionBarStore.getState();
    store.showActionBar({
      childSessionId: 'child-session',
      parentSessionId: 'parent-session',
      reviewData: {
        summary: { recommended_action: 'request_changes' },
        remediation_plan: ['Fix issue 1', 'Fix issue 2'],
      },
      phase: 'fix_interrupted',
    });

    store.skipRemainingFixes();

    const state = useReviewActionBarStore.getState();
    expect(state.phase).toBe('review_completed');
    expect(state.remainingFixIds).toEqual([]);
    expect(state.activeAction).toBeNull();
  });

  it('keeps Deep Review interruption actions in one row without a standalone retry or recovery toggle', async () => {
    buildErrorAttributionMock.mockReturnValue({
      category: 'network',
      title: 'Network issue',
      severity: 'warning',
      description: 'Please retry later, or check your network and model service status.',
      actions: [
        { code: 'retry', labelKey: 'errors:ai.actions.retry' },
        { code: 'copy_diagnostics', labelKey: 'errors:ai.actions.copyDiagnostics' },
      ],
    });

    useReviewActionBarStore.getState().showInterruptedActionBar({
      childSessionId: 'deep-review-session',
      parentSessionId: 'parent-session',
      interruption: {
        phase: 'resume_failed',
        childSessionId: 'deep-review-session',
        parentSessionId: 'parent-session',
        originalTarget: '/DeepReview review latest commit',
        errorDetail: { category: 'network', rawMessage: 'network timeout' },
        canResume: true,
        recommendedActions: [
          { code: 'retry', labelKey: 'errors:ai.actions.retry' },
          { code: 'switch_model', labelKey: 'errors:ai.actions.switchModel' },
          { code: 'copy_diagnostics', labelKey: 'errors:ai.actions.copyDiagnostics' },
        ],
        reviewers: [
          { reviewer: 'ReviewSecurity', status: 'completed' },
          { reviewer: 'ReviewPerformance', status: 'timed_out' },
        ],
      },
      phase: 'resume_failed',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const buttonTexts = Array.from(container.querySelectorAll('button'))
      .map((button) => button.textContent ?? '');

    expect(buttonTexts.some((text) => text.includes('Continue review'))).toBe(true);
    expect(buttonTexts.some((text) => text.includes('Switch model'))).toBe(true);
    expect(buttonTexts.some((text) => text.includes('Copy troubleshooting summary'))).toBe(true);
    expect(buttonTexts.some((text) => text.includes('Retry'))).toBe(false);
    expect(buttonTexts.some((text) => text.includes('Show recovery plan'))).toBe(false);
    expect(container.querySelectorAll('.deep-review-action-bar__attribution button')).toHaveLength(0);
    expect(container.querySelector('.deep-review-action-bar__attribution-actions')).toBeNull();
    expect(container.textContent).toContain('1 completed review results will be preserved');
    expect(container.textContent).toContain('1 review items will be rerun');
  });

  it('minimizes and hides stale interruption controls after a resume request starts successfully', async () => {
    let resolveContinuation: (() => void) | null = null;
    continueDeepReviewSessionMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveContinuation = resolve;
    }));

    useReviewActionBarStore.getState().showInterruptedActionBar({
      childSessionId: 'deep-review-session',
      parentSessionId: 'parent-session',
      interruption: {
        phase: 'review_interrupted',
        childSessionId: 'deep-review-session',
        parentSessionId: 'parent-session',
        originalTarget: '/DeepReview review latest commit',
        errorDetail: { category: 'network', rawMessage: 'network timeout' },
        canResume: true,
        recommendedActions: [],
        reviewers: [],
      },
    });
    flowChatSessionsMock.set('deep-review-session', {
      sessionId: 'deep-review-session',
      sessionKind: 'deep_review',
      dialogTurns: [],
    });
    aggregateReviewerProgressMock.mockReturnValue([
      { reviewer: 'ReviewSecurity', status: 'completed', displayName: 'Security' },
      { reviewer: 'ReviewPerformance', status: 'completed', displayName: 'Performance' },
      { reviewer: 'ReviewArchitecture', status: 'completed', displayName: 'Architecture' },
      { reviewer: 'ReviewBusinessLogic', status: 'completed', displayName: 'Business Logic' },
      { reviewer: 'ReviewFrontend', status: 'cancelled', displayName: 'Frontend' },
    ]);
    buildReviewerProgressSummaryMock.mockReturnValue({
      completed: 4,
      failed: 0,
      timedOut: 0,
      running: 0,
      skipped: 1,
      unknown: 0,
      handled: 5,
      total: 5,
      text: '5/5 handled',
    });

    await act(async () => {
      root.render(<DeepReviewActionBar />);
    });

    const continueButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Continue review'));
    expect(continueButton).toBeTruthy();

    await act(async () => {
      continueButton!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const state = useReviewActionBarStore.getState();
    expect(continueDeepReviewSessionMock).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('resume_running');
    expect(state.minimized).toBe(true);
    expect(state.activeAction).toBe('resume');
    expect(container.textContent).toContain('Continuing review');
    expect(container.textContent).toContain('4/5 preserved, continuing remaining review');
    expect(container.textContent).not.toContain('4/5 finished');
    expect(container.textContent).not.toContain('Deep review interrupted');
    expect(Array.from(container.querySelectorAll('button'))
      .some((button) => button.textContent?.includes('Continue review'))).toBe(false);
    expect(Array.from(container.querySelectorAll('button'))
      .some((button) => button.textContent?.includes('Copy diagnostics'))).toBe(false);

    await act(async () => {
      resolveContinuation?.();
      await Promise.resolve();
    });
  });
});
