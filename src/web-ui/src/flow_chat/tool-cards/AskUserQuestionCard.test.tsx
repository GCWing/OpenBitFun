// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import {
  LOCAL_SURFACE_ID,
  activateSurface,
} from '@/infrastructure/peer-device/deviceSurface';
import { PeerDeviceContext } from '@/infrastructure/peer-device/peerDeviceContextState';
import { askUserQuestionDraftStore } from '../store/askUserQuestionDraftStore';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options?.count === undefined ? key : `${key}:${String(options.count)}`
    ),
  }),
}));

vi.mock('@/infrastructure/api/service-api/ToolAPI', () => ({
  toolAPI: {
    submitUserAnswers: vi.fn(),
    startUserQuestionInteraction: vi.fn(),
  },
}));

import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { AskUserQuestionCard } from './AskUserQuestionCard';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const config: ToolCardConfig = {
  toolName: 'AskUserQuestion',
  displayName: 'Ask User',
  icon: 'Q',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
};

function questionTool(
  status: FlowToolItem['status'],
  multiSelect = false,
): FlowToolItem {
  return {
    id: 'question-tool-1',
    type: 'tool',
    toolName: 'AskUserQuestion',
    timestamp: 1,
    status,
    toolCall: {
      id: 'question-call-1',
      input: {
        questions: [{
          header: 'Database',
          question: 'Which database?',
          multiSelect,
          options: [{
            label: 'PostgreSQL',
            description: 'Use PostgreSQL',
          }],
        }],
      },
    },
    ...(status === 'completed'
      ? {
          toolResult: {
            success: true,
            result: {
              answers: {
                0: 'PostgreSQL',
              },
            },
          },
        }
      : {}),
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AskUserQuestionCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    activateSurface(LOCAL_SURFACE_ID);
    askUserQuestionDraftStore.setState({ drafts: {} });
    vi.mocked(toolAPI.startUserQuestionInteraction).mockReset();
    vi.mocked(toolAPI.startUserQuestionInteraction).mockResolvedValue(undefined);
    vi.mocked(toolAPI.submitUserAnswers).mockReset();
    vi.mocked(toolAPI.submitUserAnswers).mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses the host deadline across remounts and supports unlimited waits', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date', 'performance'] });
    vi.setSystemTime(1000000);
    const tool = questionTool('waiting');
    tool.userQuestionWait = { deadlineMs: Date.now() + 180000, monotonicDeadlineMs: performance.now() + 180000, interactionStarted: false };
    const render = () => act(() => root.render(
      <AskUserQuestionCard toolItem={tool} config={config} sessionId="timer-session" />,
    ));
    try {
      render();
      expect(container.querySelector('[role="timer"]')?.textContent).toBe('3:00');
      act(() => vi.advanceTimersByTime(65000));
      expect(container.querySelector('[role="timer"]')?.textContent).toBe('1:55');
      vi.setSystemTime(Date.now() + 86400000);
      act(() => vi.advanceTimersByTime(1000));
      expect(container.querySelector('[role="timer"]')?.textContent).toBe('1:54');
      act(() => root.render(null));
      render();
      expect(container.querySelector('[role="timer"]')?.textContent).toBe('1:54');
      act(() => vi.advanceTimersByTime(114000));
      expect(container.querySelector('[role="timer"]')?.textContent)
        .toBe('toolCards.askUser.awaitingTimeoutConfirmation');
      expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
      tool.userQuestionWait.deadlineMs = null;
      render();
      expect(container.querySelector('[role="timer"]')).toBeNull();
      expect(container.querySelector('button[aria-label="toolCards.askUser.cancelCountdown"]')).toBeNull();
      tool.userQuestionWait.interactionStarted = true;
      render();
      expect(container.querySelector('[role="timer"]')).toBeNull();
      tool.userQuestionWait.interactionStarted = false;
      delete tool.userQuestionWait.deadlineMs;
      render();
      expect(container.querySelector('[role="timer"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the countdown only after host acknowledgement and deduplicates clicks', async () => {
    let acknowledge!: () => void;
    vi.mocked(toolAPI.startUserQuestionInteraction).mockReturnValue(new Promise<void>(resolve => { acknowledge = resolve; }));
    const tool = questionTool('waiting');
    tool.userQuestionWait = { deadlineMs: Date.now() + 180000, monotonicDeadlineMs: performance.now() + 180000, interactionStarted: false };
    act(() => root.render(<AskUserQuestionCard toolItem={tool} config={config} sessionId="timer-session" />));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="toolCards.askUser.cancelCountdown"]')!;
    expect(button.querySelector('[role="timer"]')).not.toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    act(() => button.focus());
    expect(toolAPI.startUserQuestionInteraction).not.toHaveBeenCalled();
    act(() => { button.click(); button.click(); });
    expect(toolAPI.startUserQuestionInteraction).toHaveBeenCalledExactlyOnceWith(tool.id, 'timer-session');
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
    await act(async () => acknowledge());
    expect(container.querySelector('[role="timer"]')).toBeNull();
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
  });

  it('keeps the countdown available for retry when cancellation fails', async () => {
    vi.mocked(toolAPI.startUserQuestionInteraction).mockRejectedValueOnce(new Error('offline'));
    const tool = questionTool('waiting');
    tool.userQuestionWait = { deadlineMs: Date.now() + 180000, monotonicDeadlineMs: performance.now() + 180000, interactionStarted: false };
    act(() => root.render(<AskUserQuestionCard toolItem={tool} config={config} sessionId="timer-session" />));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="toolCards.askUser.cancelCountdown"]')!;
    await act(async () => button.click());
    expect(container.querySelector('[role="timer"]')).not.toBeNull();
    await act(async () => button.click());
    expect(toolAPI.startUserQuestionInteraction).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="timer"]')).toBeNull();
  });

  it('keeps a just-completed tail question visible until newer content arrives', () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('[data-openbitfun-component="ask-user"] [data-openbitfun-part="body"]')).not.toBeNull();
    expect(container.querySelector('button[data-openbitfun-part="summary"]')).toBeNull();

    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('completed')}
          config={config}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('[data-openbitfun-component="ask-user"] [data-openbitfun-part="body"]')).not.toBeNull();
    expect(container.querySelector('button[data-openbitfun-part="summary"]')).toBeNull();

    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('completed')}
          config={config}
          isLastItem={false}
        />,
      );
    });
    expect(container.querySelector('button[data-openbitfun-part="summary"]')).not.toBeNull();
  });

  it('restores an unsubmitted answer after the session card is remounted', () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    });

    const radio = container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]');
    expect(radio).not.toBeNull();
    act(() => radio?.click());
    expect(radio?.checked).toBe(true);

    act(() => root.render(null));
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-b"
          isLastItem
        />,
      );
    });
    expect(
      container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked,
    ).toBe(false);

    act(() => root.render(null));
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    });
    expect(
      container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked,
    ).toBe(true);
  });

  it('switches to the draft owned by the newly activated device surface', () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    });

    const localRadio = container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]');
    act(() => localRadio?.click());
    expect(localRadio?.checked).toBe(true);

    act(() => {
      activateSurface('peer-device-b');
    });

    expect(
      container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked,
    ).toBe(false);
  });

  it('explains why an older CLI peer cannot answer instead of exposing a dead form', () => {
    activateSurface('peer-cli');
    act(() => {
      root.render(
        <PeerDeviceContext.Provider value={{
          peerMode: { active: true, deviceId: 'peer-cli', deviceName: 'CLI' },
          attachments: [],
          currentPeerCapabilities: {
            idempotentDialogSubmit: true,
            targetedSessionRollback: true,
            tokenUsageStatistics: true,
            miniAppAgentContextFilesV1: false,
            cancelTool: false,
            toolCatalog: false,
            userQuestionResponse: null,
            hostKind: 'cli',
          },
          switchToDevice: vi.fn(),
          switchToLocal: vi.fn(),
          disconnectDevice: vi.fn(),
          disconnectAllDevices: vi.fn(),
        }}>
          <AskUserQuestionCard
            toolItem={questionTool('pending_confirmation')}
            config={config}
            sessionId="session-a"
            isLastItem
          />
        </PeerDeviceContext.Provider>,
      );
    });

    expect(container.querySelector('[data-openbitfun-component="ask-user"]')?.getAttribute('data-openbitfun-state'))
      .toBe('error');
    expect(container.querySelector('[data-openbitfun-part="status-label"]')?.textContent)
      .toBe('toolCards.askUser.unsupportedOnPeer');
    expect(container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.disabled)
      .toBe(true);
  });

  it('restores an unsubmitted custom input after the card is remounted', () => {
    const renderCard = () => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    };

    act(renderCard);
    const otherRadio = container.querySelector<HTMLInputElement>('input[value="Other"]');
    expect(otherRadio).not.toBeNull();
    act(() => otherRadio?.click());

    const customInput = container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input');
    expect(customInput).not.toBeNull();
    act(() => {
      if (customInput) {
        setInputValue(customInput, 'CockroachDB');
      }
    });
    expect(customInput?.value).toBe('CockroachDB');

    act(() => root.render(null));
    act(renderCard);

    expect(container.querySelector<HTMLInputElement>('input[value="Other"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')?.value).toBe('CockroachDB');
  });

  it('keeps the custom input mounted and focused during Chinese IME composition', () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    });

    const otherRadio = container.querySelector<HTMLInputElement>('input[value="Other"]');
    act(() => otherRadio?.click());

    const customInput = container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input');
    expect(customInput).not.toBeNull();
    act(() => {
      customInput?.focus();
      customInput?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      if (customInput) {
        setInputValue(customInput, 'n');
        setInputValue(customInput, '');
      }
    });

    expect(container.querySelector('[data-openbitfun-part="custom-input"] input')).toBe(customInput);
    expect(document.activeElement).toBe(customInput);
    expect(container.querySelector<HTMLInputElement>('input[value="Other"]')?.checked).toBe(true);

    act(() => {
      if (customInput) {
        setInputValue(customInput, '你');
        customInput.dispatchEvent(new CompositionEvent('compositionend', {
          bubbles: true,
          data: '你',
        }));
      }
    });

    expect(container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')?.value).toBe('你');
    expect(document.activeElement).toBe(customInput);
  });

  it('deselects a blank multi-select Other answer and omits it from submission', async () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation', true)}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    });

    const databaseCheckbox = container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]');
    const otherCheckbox = container.querySelector<HTMLInputElement>('input[value="Other"]');
    act(() => {
      databaseCheckbox?.click();
      otherCheckbox?.click();
    });

    const customInput = container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input');
    expect(customInput).not.toBeNull();
    act(() => {
      if (customInput) {
        setInputValue(customInput, 'Custom database');
        setInputValue(customInput, '');
      }
    });

    expect(container.querySelector<HTMLInputElement>('input[value="Other"]')?.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked).toBe(true);

    const submitButton = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button');
    expect(submitButton?.disabled).toBe(false);
    await act(async () => submitButton?.click());

    expect(toolAPI.submitUserAnswers).toHaveBeenCalledWith(
      'question-tool-1',
      { 0: ['PostgreSQL'] },
      'session-a',
    );
  });

  it('keeps the form retryable and reports a failed response submission', async () => {
    vi.mocked(toolAPI.submitUserAnswers).mockRejectedValueOnce(new Error('peer unavailable'));
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          sessionId="session-a"
          isLastItem
        />,
      );
    });

    act(() => {
      container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click();
    });
    const submitButton = container.querySelector<HTMLButtonElement>(
      '[data-openbitfun-part="submit"] button',
    );
    await act(async () => submitButton?.click());

    expect(container.querySelector('[data-openbitfun-part="status-label"]')?.textContent)
      .toBe('toolCards.askUser.submitFailed');
    expect(submitButton?.disabled).toBe(false);
  });
  it.each([
    ['cancelled', undefined, 'toolCards.default.cancelled'],
    ['rejected', undefined, 'toolCards.default.rejected'],
    ['error', undefined, 'toolCards.default.failed'],
    ['completed', 'cancelled', 'toolCards.default.cancelled'],
    ['completed', 'timeout', 'toolCards.askUser.timeout'],
  ] as const)('renders %s/%s as a terminal notice, even with stale streaming params', (status, resultStatus, label) => {
    const item = questionTool(status);
    item.isParamsStreaming = true;
    item.partialParams = item.toolCall.input;
    if (resultStatus) item.toolResult = { success: true, result: { status: resultStatus } };
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain('toolCards.askUser.waitingAnswer');
    expect(container.textContent).not.toContain('questionsAnswered');
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="submit"]')).toBeNull();
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
  });

  it('shows only the live question form beside an obsolete retry', async () => {
    const old = questionTool('cancelled');
    old.interruptionReason = 'retry_superseded';
    const live = questionTool('running');
    live.id = 'live-tool';
    live.toolCall = { ...live.toolCall, id: 'live-tool' };
    act(() => root.render(<>
      <AskUserQuestionCard toolItem={old} config={config} sessionId="session-a" />
      <AskUserQuestionCard toolItem={live} config={config} sessionId="session-a" />
    </>));
    expect(container.querySelectorAll('[data-openbitfun-part="submit"]')).toHaveLength(1);
    act(() => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')?.click());
    expect(toolAPI.submitUserAnswers).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toolAPI.submitUserAnswers).mock.calls[0][0]).toBe('live-tool');
  });

  it('does not render partial questions as a disabled form and uses final parameters after streaming', () => {
    const item = questionTool('preparing');
    item.isParamsStreaming = true;
    item.partialParams = item.toolCall.input;
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    expect(container.textContent).toContain('toolCards.askUser.loadingQuestions');
    expect(container.querySelector('input')).toBeNull();
    const final = { ...item, status: 'running' as const, isParamsStreaming: false,
      toolCall: { ...item.toolCall, input: { questions: [{ ...item.toolCall.input.questions[0], question: 'Final question' }] } } };
    act(() => root.render(<AskUserQuestionCard toolItem={final} config={config} sessionId="session-a" />));
    expect(container.textContent).toContain('Final question');
    expect(container.textContent).not.toContain('Which database?');
    expect(container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.disabled).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('does not revive a draft when an in-flight submission settles after timeout: %s', async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    vi.mocked(toolAPI.submitUserAnswers).mockImplementationOnce(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
    const item = questionTool('running');
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    act(() => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')?.click());
    const timedOut = { ...item, status: 'completed' as const, toolResult: { success: true, result: { status: 'timeout' } } };
    act(() => root.render(<AskUserQuestionCard toolItem={timedOut} config={config} sessionId="session-a" />));
    await act(async () => { if (outcome === 'resolve') resolve(); else reject(new Error('expired question')); });
    expect(container.textContent).toContain('toolCards.askUser.timeout');
    expect(container.querySelector('[data-openbitfun-part="submit"]')).toBeNull();
    expect(askUserQuestionDraftStore.getState().drafts).toEqual({});
  });

  it.each(['preparing', 'streaming', 'pending'] as const)('does not offer answers before a %s call starts executing', (status) => {
    const item = questionTool(status);
    item.isParamsStreaming = false;
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    expect(container.textContent).toContain('toolCards.askUser.loadingQuestions');
    expect(container.querySelector('[data-openbitfun-part="submit"]')).toBeNull();
  });

  it('acknowledges the first option click once without submitting answers', async () => {
    act(() => root.render(<AskUserQuestionCard toolItem={questionTool('running')} config={config} sessionId="session-a" />));
    expect(toolAPI.startUserQuestionInteraction).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    expect(toolAPI.startUserQuestionInteraction).toHaveBeenCalledExactlyOnceWith('question-tool-1', 'session-a');
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
  });

  it('acknowledges input focus without requiring any text or selection', async () => {
    act(() => root.render(<AskUserQuestionCard toolItem={questionTool('running')} config={config} sessionId="session-a" />));
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.focus());
    expect(toolAPI.startUserQuestionInteraction).toHaveBeenCalledExactlyOnceWith('question-tool-1', 'session-a');
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
  });

  it('reports a failed activity acknowledgement and retries on the next interaction', async () => {
    vi.mocked(toolAPI.startUserQuestionInteraction).mockRejectedValueOnce(new Error('host unavailable'));
    act(() => root.render(<AskUserQuestionCard toolItem={questionTool('running')} config={config} sessionId="session-a" />));
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    expect(container.textContent).toContain('toolCards.askUser.interactionFailed');
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    expect(toolAPI.startUserQuestionInteraction).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('toolCards.askUser.interactionFailed');
  });

  it('keeps legacy peer answers working and explicitly reports unsupported timeout cancellation', async () => {
    act(() => root.render(
      <PeerDeviceContext.Provider value={{
        peerMode: { active: true, deviceId: 'legacy-peer', deviceName: 'Legacy' },
        attachments: [],
        currentPeerCapabilities: {
          idempotentDialogSubmit: true, targetedSessionRollback: true, tokenUsageStatistics: true,
          miniAppAgentContextFilesV1: false, cancelTool: false, toolCatalog: false,
          userQuestionResponse: true, hostKind: 'desktop',
        },
        switchToDevice: vi.fn(), switchToLocal: vi.fn(), disconnectDevice: vi.fn(), disconnectAllDevices: vi.fn(),
      }}>
        <AskUserQuestionCard toolItem={questionTool('running')} config={config} sessionId="session-a" />
      </PeerDeviceContext.Provider>,
    ));
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.click());
    expect(toolAPI.startUserQuestionInteraction).not.toHaveBeenCalled();
    expect(container.textContent).toContain('toolCards.askUser.interactionFailed');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')?.click());
    expect(toolAPI.submitUserAnswers).toHaveBeenCalledTimes(1);
  });

});
