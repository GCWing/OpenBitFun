import { Check as LucideCheck } from 'lucide-react';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { MobileButton, MobileCard, MobileTextField } from '@openbitfun/ui/mobile';
import { useI18n } from '../i18n';
import { messages } from '../i18n/messages';
import type { RemoteToolStatus } from '../services/RemoteSessionManager';
import { describeChatError, isUnknownOutcomeFailure } from '../services/chatErrorPresentation';
import { InteractionVerifyContext, MailboxQuestionOwnerContext } from './InteractionVerification';

export const QuestionInteractionContext = createContext<((toolId: string) => Promise<void>) | null>(null);

interface ChatAskQuestionCardProps {
  onAnswer: (toolId: string, answers: Record<string, unknown>) => Promise<void>;
  tool: RemoteToolStatus;
  /** The interaction mailbox owns a question it lists; transcript copies defer to it. */
  owner?: 'mailbox' | 'transcript';
}

interface QuestionOption {
  description?: string;
  label: string;
}

interface Question {
  hasBuiltInOther: boolean;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
  question?: string;
}

function getMessageByPath(source: unknown, path: string): string | null {
  const segments = path.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : null;
}

const otherOptionLabels = new Set([
  'other',
  ...Object.values(messages)
    .map((localeMessages) => getMessageByPath(localeMessages, 'common.other'))
    .filter((label): label is string => !!label)
    .map((label) => label.trim().toLowerCase()),
]);

function isOtherOption(label: string | undefined): boolean {
  return otherOptionLabels.has((label || '').trim().toLowerCase());
}

export default function ChatAskQuestionCard({ onAnswer, tool, owner = 'transcript' }: ChatAskQuestionCardProps) {
  const { t, language } = useI18n();
  const onInteraction = useContext(QuestionInteractionContext);
  const verify = useContext(InteractionVerifyContext);
  const mailboxQuestions = useContext(MailboxQuestionOwnerContext);
  // `checking`: the answer's reply was lost and the host is asked again.
  // `unconfirmed`: still pending after that check; the answer can be resent.
  const [outcome, setOutcome] = useState<'idle' | 'checking' | 'unconfirmed' | 'failed'>('idle');
  const [failureText, setFailureText] = useState('');
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const interactionStarted = useRef(false);
  const startInteraction = () => {
    if (!onInteraction || interactionStarted.current) return;
    interactionStarted.current = true;
    void onInteraction(tool.id).catch(() => { interactionStarted.current = false; });
  };
  const questions = (tool.tool_input?.questions || []) as Array<Omit<Question, 'hasBuiltInOther'>>;
  const [selected, setSelected] = useState<Record<number, string | string[]>>({});
  const [customTexts, setCustomTexts] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const normalizedQuestions = useMemo<Question[]>(() => questions.map((question) => {
    const options = Array.isArray(question.options) ? question.options : [];
    return {
      ...question,
      hasBuiltInOther: options.some((option) => isOtherOption(option?.label)),
      options,
    };
  }), [questions]);

  if (normalizedQuestions.length === 0) return null;
  if (owner === 'transcript' && mailboxQuestions.has(tool.id)) return null;

  const handleSelect = (questionIndex: number, label: string, multiple: boolean) => {
    startInteraction();
    setSelected((current) => {
      if (multiple) {
        const values = (current[questionIndex] as string[] | undefined) || [];
        return {
          ...current,
          [questionIndex]: values.includes(label)
            ? values.filter((value) => value !== label)
            : [...values, label],
        };
      }
      return { ...current, [questionIndex]: current[questionIndex] === label ? undefined! : label };
    });
  };

  const allAnswered = normalizedQuestions.every((question, index) => {
    const answer = selected[index];
    const hasSelection = question.multiSelect ? Array.isArray(answer) && answer.length > 0 : !!answer;
    if (!hasSelection) return false;
    const needsCustomText = Array.isArray(answer)
      ? answer.some((value) => isOtherOption(value))
      : isOtherOption(answer);
    return !needsCustomText || !!(customTexts[index] || '').trim();
  });

  const handleSubmit = async () => {
    if (!allAnswered || submitting || submitted) return;
    const answers: Record<string, unknown> = {};
    normalizedQuestions.forEach((_question, index) => {
      const answer = selected[index];
      const customText = (customTexts[index] || '').trim();
      if (Array.isArray(answer)) {
        answers[String(index)] = answer.map((value) => isOtherOption(value) ? (customText || value) : value);
      } else if (isOtherOption(answer)) {
        answers[String(index)] = customText || answer;
      } else {
        answers[String(index)] = answer ?? '';
      }
    });
    setSubmitting(true);
    setOutcome('idle');
    try {
      await onAnswer(tool.id, answers);
      if (mountedRef.current) setSubmitted(true);
    } catch (error) {
      if (!mountedRef.current) return;
      if (isUnknownOutcomeFailure(error)) {
        // The host may have taken the answer. Ask it again; an answered
        // question leaves this view, a pending one can be answered again.
        setOutcome('checking');
        try { await verify?.(); } catch { /* the check itself is best effort */ }
        if (mountedRef.current) setOutcome('unconfirmed');
      } else {
        setFailureText(describeChatError(error, t));
        setOutcome('failed');
        void verify?.().catch(() => {});
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };
  const busy = submitting || outcome === 'checking';

  const pluralSuffix = language === 'en-US' && questions.length !== 1 ? 's' : '';

  return (
    <MobileCard padding="none" className="chat-ask-card">
      <div className="chat-ask-card__header">
        <span className="chat-ask-card__count">{t('chat.askQuestionCount', { count: questions.length, suffix: pluralSuffix })}</span>
        {!submitted && !busy && <span className="chat-ask-card__waiting">{t('chat.waiting')}</span>}
      </div>
      {normalizedQuestions.map((question, questionIndex) => {
        const answer = selected[questionIndex];
        const otherSelected = Array.isArray(answer)
          ? answer.some((value) => isOtherOption(value))
          : isOtherOption(answer);
        return (
          <div key={questionIndex} className="chat-ask-card__question">
            <div className="chat-ask-card__question-header">
              <span className="chat-ask-card__tag">{question.header}</span>
              <span className="chat-ask-card__question-text">{question.question}</span>
            </div>
            <div className="chat-ask-card__options">
              {question.options.map((option, optionIndex) => {
                const optionSelected = question.multiSelect
                  ? (selected[questionIndex] as string[] || []).includes(option.label)
                  : selected[questionIndex] === option.label;
                return (
                  <MobileButton
                    appearance="secondary"
                    className={`chat-ask-card__option ${optionSelected ? 'is-selected' : ''}`}
                    disabled={submitted || busy}
                    key={optionIndex}
                    onClick={() => handleSelect(questionIndex, option.label, !!question.multiSelect)}
                  >
                    <span className={`chat-ask-card__radio ${question.multiSelect ? 'chat-ask-card__radio--multi' : ''}`}>
                      {optionSelected && <LucideCheck width="8" height="8" aria-hidden="true" />}
                    </span>
                    <span className="chat-ask-card__option-label">{option.label}</span>
                    {option.description && <span className="chat-ask-card__option-desc">{option.description}</span>}
                  </MobileButton>
                );
              })}
              {!question.hasBuiltInOther && (
                <MobileButton
                  appearance="secondary"
                  className={`chat-ask-card__option ${otherSelected ? 'is-selected' : ''}`}
                  disabled={submitted || busy}
                  onClick={() => handleSelect(questionIndex, 'Other', !!question.multiSelect)}
                >
                  <span className={`chat-ask-card__radio ${question.multiSelect ? 'chat-ask-card__radio--multi' : ''}`}>
                    {otherSelected && <LucideCheck width="8" height="8" aria-hidden="true" />}
                  </span>
                  <span className="chat-ask-card__option-label">{t('common.other')}</span>
                  <span className="chat-ask-card__option-desc">{t('common.customTextInput')}</span>
                </MobileButton>
              )}
              {otherSelected && (
                <MobileTextField
                  appearance="surface"
                  disabled={submitted || busy}
                  className="chat-ask-card__custom-input"
                  onFocus={startInteraction}
                  onClick={startInteraction}
                  onChange={(event) => setCustomTexts((current) => ({ ...current, [questionIndex]: event.target.value }))}
                  placeholder={t('common.typeYourAnswer')}
                  value={customTexts[questionIndex] || ''}
                />
              )}
            </div>
          </div>
        );
      })}
      {outcome === 'checking' && <p className="chat-ask-card__outcome" role="status">{t('chat.answerChecking')}</p>}
      {outcome === 'unconfirmed' && <p className="chat-ask-card__outcome chat-ask-card__outcome--error" role="alert">{t('chat.answerUnconfirmed')}</p>}
      {outcome === 'failed' && <p className="chat-ask-card__outcome chat-ask-card__outcome--error" role="alert">{t('chat.answerFailed')} {failureText}</p>}
      <MobileButton appearance="primary" block className="chat-ask-card__submit chat-ask-card__submit--bottom" disabled={!allAnswered || submitted || busy} onClick={() => void handleSubmit()}>
        <LucideCheck width="12" height="12" aria-hidden="true" />
        {submitted
          ? t('common.submitted')
          : busy
            ? t('common.submitting')
            : outcome === 'unconfirmed' || outcome === 'failed' ? t('chat.retryAnswer') : t('common.submit')}
      </MobileButton>
    </MobileCard>
  );
}
