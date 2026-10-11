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
import { FlowChatReaderState } from '../timeline/readerState';
import { useTimelineInteraction } from '../timeline/useTimelineInteraction';

const sendFollowUp = vi.hoisted(() => vi.fn());
vi.mock('../services/FlowChatManager', () => ({
  FlowChatManager: { getInstance: () => ({ sendMessage: sendFollowUp }) },
}));

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
    sendFollowUp.mockReset().mockResolvedValue(undefined);
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

  it('pages through questions, retains answers on Back, and submits only from the last step', async () => {
    let acknowledgeSubmission!: () => void;
    vi.mocked(toolAPI.submitUserAnswers).mockReturnValueOnce(new Promise<void>((resolve) => {
      acknowledgeSubmission = resolve;
    }));
    const tool = questionTool('pending_confirmation');
    tool.toolCall.input = {
      questions: [
        { question: 'Which database?', options: [{ label: 'PostgreSQL' }], multiSelect: false },
        { question: 'What should the update cover?', options: [{ label: 'Milestones' }, { label: 'Open risks' }], multiSelect: true },
        { question: 'Anything else?', options: [{ label: 'Nothing else' }], multiSelect: false },
      ],
    };
    const takeReading = vi.fn();
    const reader = new FlowChatReaderState();
    function Transcript() {
      const ref = React.useRef<HTMLDivElement>(null);
      useTimelineInteraction(ref, reader, () => true, undefined, takeReading);
      return <div ref={ref}><div className="virtual-item-wrapper" data-virtual-item-key="question">
        <AskUserQuestionCard toolItem={tool} config={config} sessionId="session-a" isLastItem />
      </div></div>;
    }
    const renderCard = () => root.render(<Transcript />);
    const next = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="next"] button')!;
    const back = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="back"] button')!;
    const choose = async (value: string) => {
      await act(async () => container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click());
    };

    act(renderCard);
    expect(container.querySelectorAll('fieldset')).toHaveLength(1);
    expect(container.querySelector('progress')?.value).toBe(1);
    expect(back()).toBeNull();
    expect(next().disabled).toBe(true);
    expect(container.querySelector('[data-openbitfun-part="submit"]')).toBeNull();

    await choose('PostgreSQL');
    expect(next().disabled).toBe(false);
    act(() => next().click());
    expect(container.querySelector('progress')?.value).toBe(2);
    expect(document.activeElement).toBe(container.querySelector('legend'));
    expect(container.querySelectorAll('[data-openbitfun-component="checkbox"]')).toHaveLength(3);
    await choose('Milestones');
    await choose('Open risks');
    act(() => back().click());
    expect(container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked).toBe(true);
    act(() => next().click());
    expect(container.querySelector<HTMLInputElement>('input[value="Milestones"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[value="Open risks"]')?.checked).toBe(true);
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();

    act(() => next().click());
    expect(container.querySelector('progress')?.value).toBe(3);
    expect(next()).toBeNull();
    await choose('Other');
    const customInput = container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')!;
    const submit = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')!;
    expect(submit().disabled).toBe(true);
    act(() => setInputValue(customInput, 'Send a follow-up'));
    act(() => back().click());
    act(() => next().click());
    expect(container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')?.value).toBe('Send a follow-up');
    expect(submit().disabled).toBe(false);
    act(() => submit().click());
    expect(container.querySelector('[data-openbitfun-part="answers"]')).toBeNull();
    expect(submit().disabled).toBe(true);
    await act(async () => acknowledgeSubmission());
    expect(toolAPI.submitUserAnswers).toHaveBeenCalledExactlyOnceWith(
      tool.id,
      { 0: 'PostgreSQL', 1: ['Milestones', 'Open risks'], 2: 'Send a follow-up' },
      'session-a',
    );
    const answeredContent = () => Array.from(container.querySelectorAll('[data-openbitfun-part="answer-pair"]'))
      .map((pair) => ({
        question: pair.querySelector('dt')?.textContent,
        answers: Array.from(pair.querySelectorAll('[data-openbitfun-part="answer-value"]')).map((answer) => answer.textContent),
      }));
    const expectedContent = [
      { question: 'Which database?', answers: ['PostgreSQL'] },
      { question: 'What should the update cover?', answers: ['Milestones', 'Open risks'] },
      { question: 'Anything else?', answers: ['Send a follow-up'] },
    ];
    expect(answeredContent()).toEqual(expectedContent);
    expect(container.querySelector('input, button, progress, svg')).toBeNull();
    // Answering, question navigation and custom-answer autofocus continue the
    // live conversation; they must not turn its viewport into a history reader.
    expect(takeReading).not.toHaveBeenCalled();
    act(() => root.render(null));
    act(renderCard);
    expect(answeredContent()).toEqual(expectedContent);
    expect(container.querySelector('input, button, progress, svg')).toBeNull();
  });

  it('resumes at an unanswered question after remount and requires nonblank custom text before Next', async () => {
    const tool = questionTool('pending_confirmation');
    tool.toolCall.input = {
      questions: [
        { question: 'Which database?', options: [{ label: 'PostgreSQL' }] },
        { question: 'Which region?', options: [{ label: 'Asia' }] },
      ],
    };
    const renderCard = () => root.render(
      <AskUserQuestionCard toolItem={tool} config={config} sessionId="session-a" isLastItem />,
    );
    const next = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="next"] button')!;
    act(renderCard);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="Other"]')!.click());
    expect(next().disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')!;
    act(() => setInputValue(input, '   '));
    expect(next().disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')!.click());
    act(() => next().click());
    act(() => root.render(null));
    act(renderCard);
    expect(container.querySelector('legend')?.textContent).toBe('Which region?');
    expect(container.querySelector('progress')?.value).toBe(2);
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
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

  it('shows the question and answer immediately on completion, including at the conversation tail', () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('[data-openbitfun-part="body"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="answers"]')).toBeNull();

    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('completed')}
          config={config}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('[data-openbitfun-part="answered-question"]')?.textContent).toBe('Which database?');
    expect(container.querySelector('[data-openbitfun-part="answer"]')?.textContent).toBe('PostgreSQL');
    expect(container.querySelector('input, button, progress, svg')).toBeNull();

    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('completed')}
          config={config}
          isLastItem={false}
        />,
      );
    });
    expect(container.textContent).toBe('Which database?PostgreSQL');
    expect(container.querySelector('input, button, progress, svg')).toBeNull();
  });

  it('restores answer text from a serialized completed result without showing unselected choices', () => {
    const tool = questionTool('completed', true);
    tool.toolResult = { success: true, result: JSON.stringify({ answers: { 0: ['PostgreSQL', 'Custom\ndatabase'] } }) };
    act(() => root.render(<AskUserQuestionCard toolItem={tool} config={config} sessionId="session-a" />));
    expect(container.querySelector('[data-openbitfun-part="answered-question"]')?.textContent).toBe('Which database?');
    expect(Array.from(container.querySelectorAll('[data-openbitfun-part="answer-value"]')).map((answer) => answer.textContent))
      .toEqual(['PostgreSQL', 'Custom\ndatabase']);
    expect(container.querySelector('input, button, progress, svg')).toBeNull();
    expect(container.textContent).not.toContain('toolCards.askUser.other');
    expect(container.textContent).not.toContain('Use PostgreSQL');
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

  it.each([
    { sessionId: 'session-a', multiSelect: false },
    { sessionId: undefined, multiSelect: false },
    { sessionId: 'session-a', multiSelect: true },
    { sessionId: undefined, multiSelect: true },
  ])('retains Other selection and input focus after clearing text ($sessionId, multiple=$multiSelect)', async ({ sessionId, multiSelect }) => {
    act(() => root.render(
      <AskUserQuestionCard
        toolItem={questionTool('pending_confirmation', multiSelect)}
        config={config}
        sessionId={sessionId}
      />,
    ));
    await act(async () => container.querySelector<HTMLInputElement>('input[value="Other"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')!;
    expect(document.activeElement).toBe(input);
    act(() => setInputValue(input, 'Custom database'));

    for (const value of ['', '   ']) {
      act(() => setInputValue(input, value));
      expect(container.querySelector('[data-openbitfun-part="custom-input"] input')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(container.querySelector<HTMLInputElement>('input[value="Other"]')?.checked).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')?.disabled).toBe(true);
    }

    act(() => setInputValue(input, 'New database'));
    expect(input.value).toBe('New database');
    expect(document.activeElement).toBe(input);
    expect(container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')?.disabled).toBe(false);
  });

  it('keeps a blank multi-select Other answer selected and omits it from submission', async () => {
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

    expect(container.querySelector<HTMLInputElement>('input[value="Other"]')?.checked).toBe(true);
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
    ['completed', 'timeout', 'toolCards.askUser.skippedAnswer'],
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

  it.each(['cancelled', 'completed'] as const)('lets a cancelled %s call reopen every received question without allowing answers', (status) => {
    const item = questionTool('running');
    item.toolCall.input.questions.push({
      header: 'Region',
      question: 'Which region?',
      multiSelect: true,
      options: [{ label: 'Asia', description: 'Use the Asia region' }],
    });
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    const cancelledItem = {
      ...item,
      status,
      isParamsStreaming: true,
      partialParams: item.toolCall.input,
      ...(status === 'completed' ? {
        toolResult: { success: true, result: JSON.stringify({ status: 'cancelled' }) },
      } : {}),
    };
    const renderCancelledCard = () => root.render(
      <AskUserQuestionCard toolItem={cancelledItem} config={config} sessionId="session-a" />,
    );
    const expand = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="disclosure"]')!.click();

    act(renderCancelledCard);
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('toolCards.default.cancelled');
    act(expand);
    expect(Array.from(container.querySelectorAll('legend'), (legend) => legend.textContent))
      .toEqual(['Which database?', 'Which region?']);
    expect(container.textContent).toContain('Use PostgreSQL');
    expect(container.textContent).toContain('Use the Asia region');
    expect(container.textContent).toContain('toolCards.default.cancelled');
    expect(container.querySelector('[data-openbitfun-part="submit"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="next"]')).toBeNull();
    container.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      expect(input.disabled).toBe(true);
      act(() => input.click());
      expect(input.checked).toBe(false);
    });
    expect(toolAPI.startUserQuestionInteraction).not.toHaveBeenCalled();
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
    expect(sendFollowUp).not.toHaveBeenCalled();
    expect(askUserQuestionDraftStore.getState().drafts).toEqual({});

    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="collapse"]')!.click());
    expect(container.querySelector('input')).toBeNull();
    act(() => root.render(null));
    act(renderCancelledCard);
    act(expand);
    expect(container.querySelectorAll('fieldset')).toHaveLength(2);
  });

  it('keeps an empty cancelled call as a notice without a disclosure', () => {
    const item = questionTool('cancelled');
    item.toolCall.input = {};
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    expect(container.textContent).toContain('toolCards.default.cancelled');
    expect(container.querySelector('button, input')).toBeNull();
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
    expect(container.textContent).toContain('toolCards.askUser.skippedAnswer');
    expect(container.querySelector('[data-openbitfun-part="submit"]')).toBeNull();
    expect(askUserQuestionDraftStore.getState().drafts).toEqual({});
  });

  it('reopens a skipped questionnaire and sends actual answers once as an owning-session follow-up', async () => {
    let accept!: () => void;
    sendFollowUp.mockReturnValueOnce(new Promise<void>(resolve => { accept = resolve; }));
    const item = questionTool('completed');
    item.toolResult = { success: true, result: { status: 'timeout' } };
    item.toolCall.input = { questions: [
      { question: 'Which database?', options: [{ label: 'PostgreSQL' }] },
      { question: 'Which regions?', multiSelect: true, options: [{ label: 'Asia' }] },
    ] };
    const renderCard = () => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="owner-session" />);
    act(renderCard);
    const expand = () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="disclosure"]')!.click();
    expect(container.querySelector('[data-openbitfun-part="header-icon"]')?.getAttribute('data-openbitfun-name')).toBe('message-circle-question');
    act(expand);
    expect(container.querySelector('[data-openbitfun-part="header-icon"]')?.getAttribute('data-openbitfun-name')).toBe('message-circle-question');
    expect(document.activeElement).toBe(container.querySelector('legend'));
    act(() => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="next"] button')!.click());
    act(() => container.querySelector<HTMLInputElement>('input[value="Asia"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('input[value="Other"]')!.click());
    act(() => setInputValue(container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')!, '  Europe  '));
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="collapse"]')!.click());
    expect(container.querySelector('input')).toBeNull();
    act(() => askUserQuestionDraftStore.getState().reconcilePendingTools(LOCAL_SURFACE_ID, 'owner-session', []));
    act(expand);
    expect(container.querySelector<HTMLInputElement>('[data-openbitfun-part="custom-input"] input')?.value).toBe('  Europe  ');
    const submit = container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')!;
    act(() => { submit.click(); submit.click(); });
    expect(sendFollowUp).toHaveBeenCalledExactlyOnceWith(
      'Which database?\nPostgreSQL\n\nWhich regions?\nAsia\nEurope',
      'owner-session',
      'Which database?\nPostgreSQL\n\nWhich regions?\nAsia\nEurope',
      undefined, undefined, { sendImmediately: true },
    );
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
    expect(toolAPI.startUserQuestionInteraction).not.toHaveBeenCalled();
    // Virtualization can unmount the card before the host acknowledges it.
    act(() => root.render(null));
    await act(async () => accept());
    act(renderCard);
    expect(container.querySelectorAll('[data-openbitfun-part="answer-pair"]')).toHaveLength(2);
    expect(container.textContent).toContain('Europe');
    expect(container.querySelector('input, button, progress')).toBeNull();
  });

  it('keeps a failed follow-up editable and retries with the saved answer', async () => {
    sendFollowUp.mockRejectedValueOnce(new Error('offline'));
    const item = questionTool('completed');
    item.toolResult = { success: true, result: { status: 'timeout' } };
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="session-a" />));
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="disclosure"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')!.click());
    expect(container.textContent).toContain('toolCards.askUser.submitFailed');
    expect(container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')!.click());
    expect(sendFollowUp).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-openbitfun-part="answer-value"]')?.textContent).toBe('PostgreSQL');
  });

  it('isolates a skipped follow-up from another device surface while the send is in flight', async () => {
    let accept!: () => void;
    sendFollowUp.mockReturnValueOnce(new Promise<void>(resolve => { accept = resolve; }));
    const item = questionTool('completed');
    item.toolResult = { success: true, result: { status: 'timeout' } };
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} sessionId="same-session" />));
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="disclosure"]')!.click());
    act(() => container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="submit"] button')!.click());
    act(() => activateSurface('other-peer'));
    await act(async () => accept());
    expect(container.querySelector('[data-openbitfun-part="answers"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-openbitfun-part="disclosure"]')!.click());
    expect(container.querySelector<HTMLInputElement>('input[value="PostgreSQL"]')?.checked).toBe(false);
    expect(sendFollowUp).toHaveBeenCalledTimes(1);
    expect(toolAPI.submitUserAnswers).not.toHaveBeenCalled();
  });

  it('does not fall back to the active session for a skipped card without an owning session', () => {
    const item = questionTool('completed');
    item.toolResult = { success: true, result: { status: 'timeout' } };
    act(() => root.render(<AskUserQuestionCard toolItem={item} config={config} />));
    expect(container.querySelector('button, input')).toBeNull();
    expect(container.querySelector('[role="status"] [data-openbitfun-name="circle-arrow-right"]')).not.toBeNull();
    expect(sendFollowUp).not.toHaveBeenCalled();
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
