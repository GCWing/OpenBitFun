/**
 * Product adapter for the public AskUser design-system component.
 *
 * This file owns tool payload parsing, per-surface draft persistence,
 * localization, submission, and FlowChat virtualization coordination.
 * AskUser owns the rendered anatomy, interaction semantics, and styling.
 */

import {
  AskUser,
  type AskUserAnswers,
  type AskUserQuestion,
  type AskUserState,
} from '@openbitfun/ui/flow-chat';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@openbitfun/ui';
import { X } from 'lucide-react';
import { i18nService } from '@/infrastructure/i18n';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import {
  getActiveSurfaceScope,
  isSurfaceChangedError,
  onSurfaceActivated,
} from '@/infrastructure/peer-device/deviceSurface';
import { canSubmitUserQuestionsOnSurface } from '@/infrastructure/peer-device/peerCapabilityResolution';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { createLogger } from '@/shared/utils/logger';
import type { FlowToolItem, ToolCardProps } from '../types/flow-chat';
import {
  askUserQuestionDraftKey,
  askUserQuestionDraftStore,
  createEmptyAskUserQuestionDraft,
  useAskUserQuestionDraftStore,
  type AskUserQuestionSubmissionPhase,
} from '../store/askUserQuestionDraftStore';
import { useToolCardHeightContract } from './useToolCardHeightContract';

const log = createLogger('AskUserQuestionCard');
const OTHER_OPTION_VALUE = 'Other';
const subscribeToSurfaceActivation = (listener: () => void): (() => void) =>
  onSurfaceActivated(() => listener());

interface QuestionOption {
  description: string;
  label: string;
}

interface QuestionData {
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  question: string;
}

type ToolAnswer = string | string[];

function normalizeQuestionsFromParams(input: unknown): QuestionData[] {
  if (!input || typeof input !== 'object') return [];
  const rawQuestions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions.flatMap((candidate): QuestionData[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const rawQuestion = candidate as Record<string, unknown>;
    const rawOptions = Array.isArray(rawQuestion.options)
      ? rawQuestion.options
      : [];
    const options = rawOptions.flatMap((option): QuestionOption[] => {
      if (!option || typeof option !== 'object') return [];
      const rawOption = option as Record<string, unknown>;
      if (typeof rawOption.label !== 'string') return [];
      return [{
        description: typeof rawOption.description === 'string'
          ? rawOption.description
          : '',
        label: rawOption.label,
      }];
    });

    return [{
      header: typeof rawQuestion.header === 'string' ? rawQuestion.header : '',
      multiSelect: Boolean(rawQuestion.multiSelect),
      options,
      question: typeof rawQuestion.question === 'string'
        ? rawQuestion.question
        : '',
    }];
  });
}

function normalizeToolResult(input: unknown): Record<string, unknown> | null {
  if (input === null || input === undefined) return null;
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeToolAnswer(input: unknown): ToolAnswer | undefined {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input.filter((value): value is string => typeof value === 'string');
  }
  return undefined;
}

/** Same source as FileOperationToolCard: partial JSON while streaming, then final toolCall.input. */
function isAwaitingQuestionPayload(
  isParamsStreaming: boolean | undefined,
  status: FlowToolItem['status'],
): boolean {
  if (isParamsStreaming) return true;
  const rawStatus = status as string;
  return status === 'preparing'
    || status === 'streaming'
    || status === 'pending'
    || rawStatus === 'receiving';
}

export const AskUserQuestionCard: React.FC<ToolCardProps> = ({
  toolItem,
  isLastItem,
  sessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const peerDevice = usePeerDeviceModeOptional();
  const activeSurfaceScope = useSyncExternalStore(
    subscribeToSurfaceActivation,
    getActiveSurfaceScope,
    getActiveSurfaceScope,
  );
  const { status, toolCall, toolResult, isParamsStreaming, partialParams } = toolItem;
  const paramsSource = isParamsStreaming ? partialParams || toolCall?.input : toolCall?.input;
  const normalizedResult = useMemo(
    () => normalizeToolResult(toolResult?.result),
    [toolResult?.result],
  );
  const timedOut = normalizedResult?.status === 'timeout';
  const cancelled = status === 'cancelled' || normalizedResult?.status === 'cancelled';
  const rejected = status === 'rejected';
  const failed = status === 'error' || toolResult?.success === false;
  const endedWithoutAnswer = timedOut || cancelled || rejected || failed;
  const finished = status === 'completed' || endedWithoutAnswer;
  const questions = useMemo(
    () => normalizeQuestionsFromParams(paramsSource),
    [paramsSource],
  );
  const awaitingPayload = !finished && isAwaitingQuestionPayload(
    isParamsStreaming,
    status,
  );

  const toolId = toolItem.id ?? toolCall?.id;
  const draftToolId = toolCall?.id || toolId;
  const activeSurfaceId = activeSurfaceScope.surfaceId;
  const canSubmitUserAnswers = canSubmitUserQuestionsOnSurface(
    peerDevice?.peerMode.active === true,
    peerDevice?.currentPeerCapabilities ?? null,
  );
  const canAnswer = !finished && !awaitingPayload && canSubmitUserAnswers;
  const deadline = toolItem.userQuestionWait?.deadlineMs;
  const [interactionAcknowledged, setInteractionAcknowledged] = useState(false);
  const [clockNow, setClockNow] = useState(() => performance.now());
  const showTimer = canAnswer && !interactionAcknowledged
    && !toolItem.userQuestionWait?.interactionStarted && typeof deadline === 'number';
  useEffect(() => {
    setInteractionAcknowledged(false);
  }, [activeSurfaceId, sessionId, toolId]);
  useEffect(() => {
    if (!showTimer || typeof deadline !== 'number') return;
    setClockNow(performance.now());
    const interval = window.setInterval(() => setClockNow(performance.now()), 250);
    return () => window.clearInterval(interval);
  }, [deadline, showTimer]);
  const remainingSeconds = typeof deadline === 'number'
    ? Math.max(0, Math.ceil(((toolItem.userQuestionWait?.monotonicDeadlineMs ?? clockNow) - clockNow) / 1000)) : null;
  const countdown = remainingSeconds === null ? null
    : remainingSeconds === 0 ? t('toolCards.askUser.awaitingTimeoutConfirmation') : `${
    i18nService.formatNumber(Math.floor(remainingSeconds / 60), { useGrouping: false })
  }:${
    i18nService.formatNumber(remainingSeconds % 60, { minimumIntegerDigits: 2, useGrouping: false })
  }`;
  const submissionScope = useRef(0);
  const draftKey = useMemo(
    () => sessionId && draftToolId
      ? askUserQuestionDraftKey(sessionId, draftToolId, activeSurfaceId)
      : null,
    [activeSurfaceId, draftToolId, sessionId],
  );
  useLayoutEffect(() => {
    submissionScope.current += 1;
    return () => { submissionScope.current += 1; };
  }, [draftKey, canAnswer]);
  const storedDraft = useAskUserQuestionDraftStore((state) => (
    draftKey ? state.drafts[draftKey] : undefined
  ));
  const [localDraft, setLocalDraft] = useState(createEmptyAskUserQuestionDraft);
  const draft = storedDraft ?? localDraft;
  const { answers, otherInputs, submissionPhase } = draft;
  const isSubmitting = submissionPhase === 'submitting';
  const isSubmitted = submissionPhase === 'submitted';
  const [submissionFailed, setSubmissionFailed] = useState(false);
  const [interactionFailed, setInteractionFailed] = useState(false);
  const interactionAttempt = useRef<number | null>(null);
  const startInteraction = useCallback(() => {
    if (!canAnswer || !sessionId || interactionAttempt.current === submissionScope.current) return;
    const scope = submissionScope.current;
    if (peerDevice?.peerMode.active && peerDevice.currentPeerCapabilities?.userQuestionInteraction !== true) {
      setInteractionFailed(true);
      return;
    }
    interactionAttempt.current = scope;
    setInteractionFailed(false);
    void toolAPI.startUserQuestionInteraction(toolId, sessionId).then(() => {
      if (submissionScope.current === scope) setInteractionAcknowledged(true);
    }).catch((error) => {
      if (submissionScope.current !== scope) return;
      interactionAttempt.current = null;
      setInteractionFailed(true);
      log.error('Failed to acknowledge user question interaction', { toolId, sessionId, error });
    });
  }, [canAnswer, peerDevice, sessionId, toolId]);
  const handleInteraction = useCallback((event: React.SyntheticEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('input, [data-openbitfun-part="option"], [data-openbitfun-part="custom-option"]')) {
      startInteraction();
    }
  }, [startInteraction]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showCompletedSummary, setShowCompletedSummary] = useState(status === 'completed');
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  useLayoutEffect(() => {
    const shouldCompactCompleted = status === 'completed'
      && isLastItem !== true
      && !showCompletedSummary;

    if (shouldCompactCompleted) {
      applyExpandedState(true, false, (nextExpanded) => {
        setShowCompletedSummary(!nextExpanded);
      });
      return;
    }

    if (status !== 'completed' && showCompletedSummary) {
      setShowCompletedSummary(false);
    }
  }, [applyExpandedState, isLastItem, showCompletedSummary, status]);

  useEffect(() => {
    setSubmissionFailed(false);
    setInteractionFailed(false);
  }, [draftKey]);

  useEffect(() => {
    if (
      draftKey
      && finished
    ) {
      askUserQuestionDraftStore.getState().clearDraft(draftKey);
    }
  }, [draftKey, finished]);

  const setSubmissionPhase = useCallback((phase: AskUserQuestionSubmissionPhase) => {
    if (draftKey) {
      askUserQuestionDraftStore.getState().setSubmissionPhase(draftKey, phase);
      return;
    }
    setLocalDraft((current) => ({
      ...current,
      submissionPhase: phase,
      updatedAt: Date.now(),
    }));
  }, [draftKey]);

  const isAllAnswered = useCallback(() => {
    if (questions.length === 0) return false;

    for (let index = 0; index < questions.length; index += 1) {
      const answer = answers[index];
      if (!answer) return false;
      const otherInput = otherInputs[index]?.trim() || '';
      if (
        Array.isArray(answer)
        && !answer.some((value) => value !== OTHER_OPTION_VALUE || otherInput.length > 0)
      ) return false;
      if (typeof answer === 'string' && answer === '') return false;
      if (answer === OTHER_OPTION_VALUE && otherInput.length === 0) return false;
    }
    return true;
  }, [answers, otherInputs, questions.length]);

  const handleSingleChange = useCallback((questionIndex: number, value: string) => {
    if (draftKey) {
      askUserQuestionDraftStore.getState().setSingleAnswer(draftKey, questionIndex, value);
      return;
    }
    setLocalDraft((current) => ({
      ...current,
      answers: {
        ...current.answers,
        [questionIndex]: value,
      },
      updatedAt: Date.now(),
    }));
  }, [draftKey]);

  const handleMultiChange = useCallback((
    questionIndex: number,
    value: string,
    checked: boolean,
  ) => {
    if (draftKey) {
      askUserQuestionDraftStore.getState().setMultiAnswer(
        draftKey,
        questionIndex,
        value,
        checked,
      );
      return;
    }
    setLocalDraft((current) => {
      const currentAnswer = current.answers[questionIndex];
      const currentValues = Array.isArray(currentAnswer) ? currentAnswer : [];
      const nextValues = checked
        ? currentValues.includes(value) ? currentValues : [...currentValues, value]
        : currentValues.filter((candidate) => candidate !== value);
      return {
        ...current,
        answers: {
          ...current.answers,
          [questionIndex]: nextValues,
        },
        updatedAt: Date.now(),
      };
    });
  }, [draftKey]);

  const handleOtherInputChange = useCallback((
    questionIndex: number,
    value: string,
    preserveOtherSelection = false,
  ) => {
    if (draftKey) {
      askUserQuestionDraftStore.getState().setOtherInput(
        draftKey,
        questionIndex,
        value,
        preserveOtherSelection,
      );
      return;
    }
    setLocalDraft((current) => {
      const isEmpty = value.trim().length === 0;
      const currentAnswer = current.answers[questionIndex];
      let nextAnswers = current.answers;
      if (
        isEmpty
        && !preserveOtherSelection
        && Array.isArray(currentAnswer)
        && currentAnswer.includes(OTHER_OPTION_VALUE)
      ) {
        nextAnswers = {
          ...current.answers,
          [questionIndex]: currentAnswer.filter((answer) => answer !== OTHER_OPTION_VALUE),
        };
      } else if (
        isEmpty
        && !preserveOtherSelection
        && currentAnswer === OTHER_OPTION_VALUE
      ) {
        nextAnswers = { ...current.answers };
        delete nextAnswers[questionIndex];
      }
      return {
        ...current,
        answers: nextAnswers,
        otherInputs: {
          ...current.otherInputs,
          [questionIndex]: isEmpty ? '' : value,
        },
        updatedAt: Date.now(),
      };
    });
  }, [draftKey]);

  const handleSubmit = useCallback(async () => {
    if (!canAnswer || !isAllAnswered() || isSubmitting || isSubmitted) return;
    const scope = submissionScope.current;

    setSubmissionFailed(false);
    setSubmissionPhase('submitting');
    try {
      activeSurfaceScope.assertCurrent('submitUserAnswers');
      const processedAnswers: Record<string, string | string[]> = {};

      for (let index = 0; index < questions.length; index += 1) {
        const answer = answers[index];
        const otherInput = otherInputs[index]?.trim() || '';

        if (Array.isArray(answer)) {
          processedAnswers[String(index)] = answer.flatMap((value) => (
            value === OTHER_OPTION_VALUE
              ? otherInput ? [otherInput] : []
              : [value]
          ));
        } else if (answer === OTHER_OPTION_VALUE) {
          if (otherInput) processedAnswers[String(index)] = otherInput;
        } else {
          processedAnswers[String(index)] = answer;
        }
      }

      await toolAPI.submitUserAnswers(toolId, processedAnswers, sessionId);
      activeSurfaceScope.assertCurrent('submitUserAnswers');
      if (scope !== submissionScope.current) return;
      setSubmissionPhase('submitted');
    } catch (error) {
      if (scope !== submissionScope.current) return;
      setSubmissionPhase('idle');
      if (isSurfaceChangedError(error)) {
        return;
      }
      setSubmissionFailed(true);
      log.error('Failed to submit answers', { toolId, sessionId, error });
    }
  }, [
    activeSurfaceScope,
    answers,
    canAnswer,
    isAllAnswered,
    isSubmitted,
    isSubmitting,
    otherInputs,
    questions.length,
    setSubmissionPhase,
    sessionId,
    toolId,
  ]);

  const resultAnswers = normalizedResult?.answers;

  const getEffectiveAnswer = useCallback((questionIndex: number): ToolAnswer | undefined => {
    const localAnswer = answers[questionIndex];
    if (localAnswer !== undefined) return localAnswer;
    if (
      status === 'completed'
      && resultAnswers
      && typeof resultAnswers === 'object'
      && !Array.isArray(resultAnswers)
    ) {
      return normalizeToolAnswer(
        (resultAnswers as Record<string, unknown>)[String(questionIndex)],
      );
    }
    return undefined;
  }, [answers, resultAnswers, status]);

  const presentation = useMemo(() => {
    const nextAnswers: Record<string, readonly string[]> = {};
    const nextCustomAnswers: Record<string, string> = {};

    questions.forEach((question, questionIndex) => {
      const answer = getEffectiveAnswer(questionIndex);
      const answerValues = Array.isArray(answer)
        ? answer
        : answer === undefined || answer === '' ? [] : [answer];
      const knownValues = new Set(question.options.map((option) => option.label));
      const selectedValues: string[] = [];
      const customValues: string[] = [];

      answerValues.forEach((value) => {
        if (value === OTHER_OPTION_VALUE) {
          selectedValues.push(OTHER_OPTION_VALUE);
        } else if (knownValues.has(value)) {
          selectedValues.push(value);
        } else if (value) {
          if (!selectedValues.includes(OTHER_OPTION_VALUE)) {
            selectedValues.push(OTHER_OPTION_VALUE);
          }
          customValues.push(value);
        }
      });

      nextAnswers[String(questionIndex)] = selectedValues;
      nextCustomAnswers[String(questionIndex)] = otherInputs[questionIndex]
        || customValues.join(', ');
    });

    return {
      answers: nextAnswers as AskUserAnswers,
      customAnswers: nextCustomAnswers,
    };
  }, [getEffectiveAnswer, otherInputs, questions]);

  const designQuestions = useMemo<AskUserQuestion[]>(
    () => questions.map((question, questionIndex) => ({
      customOption: {
        description: t('toolCards.askUser.customInputHint'),
        inputLabel: t('toolCards.askUser.pleaseSpecify'),
        label: t('toolCards.askUser.other'),
        placeholder: t('toolCards.askUser.pleaseSpecify'),
        value: OTHER_OPTION_VALUE,
      },
      id: String(questionIndex),
      options: question.options.map((option) => ({
        description: option.description,
        label: option.label,
        value: option.label,
      })),
      prompt: question.question,
      selectionMode: question.multiSelect ? 'multiple' : 'single',
    })),
    [questions, t],
  );

  const handleAnswersChange = useCallback((
    questionId: string,
    nextValues: readonly string[],
  ) => {
    const questionIndex = Number(questionId);
    const question = questions[questionIndex];
    if (!question || !Number.isInteger(questionIndex)) return;

    if (!question.multiSelect) {
      handleSingleChange(questionIndex, nextValues[0] ?? '');
      return;
    }

    const currentAnswer = answers[questionIndex];
    const currentValues = Array.isArray(currentAnswer) ? currentAnswer : [];
    const changedValue = [...new Set([...currentValues, ...nextValues])]
      .find((value) => currentValues.includes(value) !== nextValues.includes(value));
    if (changedValue !== undefined) {
      handleMultiChange(questionIndex, changedValue, nextValues.includes(changedValue));
    }
  }, [answers, handleMultiChange, handleSingleChange, questions]);

  const getAnswerDisplay = useCallback((questionIndex: number): string => {
    const answer = getEffectiveAnswer(questionIndex);
    const otherInput = otherInputs[questionIndex] || '';
    if (!answer) return '';
    if (Array.isArray(answer)) {
      return answer.map((value) => (
        value === OTHER_OPTION_VALUE ? otherInput || OTHER_OPTION_VALUE : value
      )).join(', ');
    }
    return answer === OTHER_OPTION_VALUE
      ? otherInput || OTHER_OPTION_VALUE
      : String(answer);
  }, [getEffectiveAnswer, otherInputs]);

  const answersSummary = useMemo(
    () => questions.map((question, questionIndex) => {
      const answerText = getAnswerDisplay(questionIndex);
      const label = question.header || question.question;
      return `${label}: ${answerText || t('toolCards.askUser.notAnswered')}`;
    }).join(' | '),
    [getAnswerDisplay, questions, t],
  );

  const responseUnsupported = status !== 'completed' && !canSubmitUserAnswers;
  const statusText = status === 'completed'
    ? t('toolCards.askUser.completed')
    : responseUnsupported
      ? t('toolCards.askUser.unsupportedOnPeer')
      : isSubmitted
        ? t('toolCards.askUser.submittedWaiting')
        : isSubmitting
          ? t('toolCards.askUser.submitting')
          : interactionFailed
            ? t('toolCards.askUser.interactionFailed')
          : submissionFailed
            ? t('toolCards.askUser.submitFailed')
            : t('toolCards.askUser.waitingAnswer');

  if (endedWithoutAnswer) {
    const terminalLabel = timedOut
      ? t('toolCards.askUser.timeout')
      : cancelled
        ? t('toolCards.default.cancelled')
        : rejected
          ? t('toolCards.default.rejected')
          : t('toolCards.default.failed');
    return (
      <AskUser
        data-tool-card-id={toolId ?? ''}
        questions={[]}
        ref={cardRootRef}
        state="error"
        statusLabel={terminalLabel}
      />
    );
  }

  if (awaitingPayload) {
    return (
      <AskUser
        data-tool-card-id={toolId ?? ''}
        questions={[]}
        ref={cardRootRef}
        state="loading"
        statusLabel={t('toolCards.askUser.loadingQuestions')}
      />
    );
  }

  if (questions.length === 0) {
    return (
      <AskUser
        data-tool-card-id={toolId ?? ''}
        questions={[]}
        ref={cardRootRef}
        state="error"
        statusLabel={t('toolCards.askUser.parseError')}
      />
    );
  }

  const componentState: AskUserState = status === 'completed'
    ? 'completed'
    : responseUnsupported
      ? 'error'
      : isSubmitting
        ? 'submitting'
        : isSubmitted
          ? 'submitted'
          : 'asking';
  const showSubmit = componentState === 'asking'
    || componentState === 'submitting'
    || componentState === 'submitted';

  return (
    <AskUser
      answers={presentation.answers}
      aria-label={t('toolCards.askUser.questionsCount', { count: questions.length })}
      customAnswers={presentation.customAnswers}
      data-tool-card-id={toolId ?? ''}
      disabled={!canAnswer}
      expanded={showCompletedSummary ? isExpanded : undefined}
      header={showCompletedSummary
        ? undefined
        : t('toolCards.askUser.questionsCount', { count: questions.length })}
      onClickCapture={handleInteraction}
      headerTrailing={showTimer && !isSubmitted ? (
        <Tooltip content={t('toolCards.askUser.timeoutSettingsHint')} placement="top">
          <Button
            variant="text"
            size="xs"
            labelBehavior="static"
            aria-label={t('toolCards.askUser.cancelCountdown')}
            disabled={!sessionId}
            trailingIcon={<X aria-hidden="true" />}
            onClick={startInteraction}
          >
            <span role="timer">{countdown}</span>
          </Button>
        </Tooltip>
      ) : undefined}
      onFocusCapture={handleInteraction}
      onAnswersChange={handleAnswersChange}
      onCustomAnswerChange={(questionId, value, meta) => {
        handleOtherInputChange(Number(questionId), value, meta.isComposing);
      }}
      onExpandedChange={showCompletedSummary
        ? (nextExpanded) => {
            applyExpandedState(isExpanded, nextExpanded, setIsExpanded);
          }
        : undefined}
      onSubmit={handleSubmit}
      questions={designQuestions}
      ref={cardRootRef}
      state={componentState}
      statusLabel={showCompletedSummary ? undefined : statusText}
      submitDisabled={
        !isAllAnswered()
        || isSubmitted
        || !canAnswer
      }
      submitLabel={showSubmit ? t('toolCards.askUser.submit') : undefined}
      submittingLabel={t('toolCards.askUser.submitting')}
      submitTitle={!isAllAnswered()
        ? t('toolCards.askUser.answerAllBeforeSubmit')
        : undefined}
      summaryDetail={showCompletedSummary ? answersSummary : undefined}
      summaryLabel={showCompletedSummary
        ? t('toolCards.askUser.questionsAnswered', { count: questions.length })
        : undefined}
    />
  );
};
