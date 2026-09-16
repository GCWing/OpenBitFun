import { OverflowText } from '../../primitives/OverflowText';
import {
  forwardRef,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  Disc2,
  LoaderCircle,
  Square,
  SquareCheckBig,
} from "lucide-react";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { classNames } from "../../internal/classNames";
import styles from "./AskUser.module.css";

export type AskUserState =
  | "asking"
  | "submitting"
  | "submitted"
  | "completed"
  | "loading"
  | "error"
  | "timeout";

export interface AskUserOption {
  description?: ReactNode;
  label: ReactNode;
  value: string;
}

export interface AskUserCustomOption extends AskUserOption {
  inputLabel?: string;
  placeholder?: string;
}

export interface AskUserQuestion {
  customOption?: AskUserCustomOption;
  id: string;
  options: readonly AskUserOption[];
  prompt: ReactNode;
  selectionMode?: "multiple" | "single";
}

export type AskUserAnswers = Readonly<
  Record<string, readonly string[] | undefined>
>;

export interface AskUserCustomAnswerChangeMeta {
  isComposing: boolean;
}

export interface AskUserProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onChange"> {
  answers?: AskUserAnswers;
  customAnswers?: Readonly<Record<string, string | undefined>>;
  defaultExpanded?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  header?: ReactNode;
  headerTrailing?: ReactNode;
  onAnswersChange?: (questionId: string, values: readonly string[]) => void;
  onCustomAnswerChange?: (
    questionId: string,
    value: string,
    meta: AskUserCustomAnswerChangeMeta,
  ) => void;
  onExpandedChange?: (expanded: boolean) => void;
  onSubmit?: () => void;
  questions: readonly AskUserQuestion[];
  state?: AskUserState;
  statusLabel?: ReactNode;
  submitDisabled?: boolean;
  submitLabel?: ReactNode;
  submitTitle?: string;
  submittingLabel?: ReactNode;
  summaryDetail?: ReactNode;
  summaryLabel?: ReactNode;
}

function OptionControl({
  checked,
  multiple,
}: {
  checked: boolean;
  multiple: boolean;
}) {
  const Icon = multiple
    ? checked ? SquareCheckBig : Square
    : checked ? Disc2 : Circle;

  return (
    <Icon
      aria-hidden="true"
      className={!multiple && checked ? styles.selectedSingleControl : undefined}
    />
  );
}

function StatusIcon({ state }: { state: AskUserState }) {
  if (state === "loading" || state === "submitting") {
    return <LoaderCircle aria-hidden="true" />;
  }
  if (state === "completed" || state === "submitted") {
    return <CircleCheck aria-hidden="true" />;
  }
  return <CircleAlert aria-hidden="true" />;
}

function descriptionTitle(description: ReactNode): string | undefined {
  return typeof description === "string" ? description : undefined;
}

export const AskUser = forwardRef<HTMLDivElement, AskUserProps>(function AskUser({
  answers = {},
  className,
  customAnswers = {},
  defaultExpanded = false,
  disabled = false,
  expanded,
  header,
  headerTrailing,
  onAnswersChange,
  onCustomAnswerChange,
  onExpandedChange,
  onSubmit,
  questions,
  state = "asking",
  statusLabel,
  submitDisabled = false,
  submitLabel,
  submitTitle,
  submittingLabel,
  summaryDetail,
  summaryLabel,
  ...props
}, ref) {
  const instanceId = useId();
  const detailsId = `${instanceId}-details`;
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const composingQuestionsRef = useRef(new Set<string>());
  const hasSummary = summaryLabel !== undefined && summaryLabel !== null;
  const resolvedExpanded = hasSummary
    ? expanded ?? internalExpanded
    : true;
  const interactionDisabled = disabled || state !== "asking";
  const showStatusOnly = state === "loading"
    || state === "error" && questions.length === 0;

  function setExpanded(nextExpanded: boolean) {
    if (expanded === undefined) {
      setInternalExpanded(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  }

  function updateAnswer(
    question: AskUserQuestion,
    value: string,
    checked: boolean,
  ) {
    if (interactionDisabled) return;
    const currentValues = answers[question.id] ?? [];
    const nextValues = question.selectionMode === "multiple"
      ? checked
        ? currentValues.includes(value)
          ? currentValues
          : [...currentValues, value]
        : currentValues.filter((candidate) => candidate !== value)
      : checked ? [value] : [];
    onAnswersChange?.(question.id, nextValues);
  }

  if (showStatusOnly) {
    return (
      <div
        {...props}
        className={classNames(styles.root, styles.statusOnly, className)}
        data-openbitfun-component="ask-user"
        data-openbitfun-part="root"
        data-openbitfun-state={state}
        ref={ref}
        role={state === "error" ? "alert" : "status"}
      >
        <span className={styles.statusIcon} data-openbitfun-part="status-icon">
          <StatusIcon state={state} />
        </span>
        <span className={styles.statusText} data-openbitfun-part="status-label">
          {statusLabel}
        </span>
      </div>
    );
  }

  const showFeedback = (state === "error" || state === "timeout")
    && statusLabel !== undefined
    && statusLabel !== null;
  const showFooter = !hasSummary && (
    submitLabel !== undefined && submitLabel !== null
    || statusLabel !== undefined && statusLabel !== null
  );

  return (
    <div
      {...props}
      className={classNames(styles.root, className)}
      data-openbitfun-component="ask-user"
      data-openbitfun-expanded={resolvedExpanded ? "true" : "false"}
      data-openbitfun-has-summary={hasSummary ? "true" : "false"}
      data-openbitfun-part="root"
      data-openbitfun-state={state}
      data-disabled={disabled ? "true" : "false"}
      ref={ref}
    >
      {hasSummary ? (
        <button data-overflow-trigger
          aria-controls={detailsId}
          aria-expanded={resolvedExpanded}
          className={styles.summaryButton}
          data-openbitfun-part="summary"
          onClick={() => setExpanded(!resolvedExpanded)}
          type="button"
        >
          <span className={styles.summaryLeading}>
            <span className={styles.summaryIcon} data-openbitfun-part="summary-icon">
              <CircleCheck aria-hidden="true" />
            </span>
            <span className={styles.summaryCopy}>
              <span className={styles.summaryLabel} data-openbitfun-part="summary-label">
                {summaryLabel}
              </span>
              {summaryDetail !== undefined && summaryDetail !== null && (
                <>
                  <span aria-hidden="true" className={styles.summaryArrow}>→</span>
                  <OverflowText className={styles.summaryDetail} data-openbitfun-part="summary-detail">
                    {summaryDetail}
                  </OverflowText>
                </>
              )}
            </span>
          </span>
          <span className={styles.summaryAction} data-openbitfun-part="summary-action">
            {resolvedExpanded
              ? <ChevronUp aria-hidden="true" />
              : <ChevronDown aria-hidden="true" />}
          </span>
        </button>
      ) : header !== undefined && header !== null ? (
        <div className={styles.header} data-openbitfun-part="header">
          <OverflowText>{header}</OverflowText>
          {headerTrailing !== undefined && <span className={styles.headerTrailing}>{headerTrailing}</span>}
        </div>
      ) : null}

      <div
        aria-hidden={hasSummary && !resolvedExpanded ? true : undefined}
        className={styles.details}
        data-openbitfun-part="details"
        id={detailsId}
      >
        <div className={styles.detailsInner}>
          <div className={styles.body} data-openbitfun-part="body">
            {questions.map((question, questionIndex) => {
              const multiple = question.selectionMode === "multiple";
              const selectedValues = answers[question.id] ?? [];
              const customOption = question.customOption;
              const customSelected = customOption
                ? selectedValues.includes(customOption.value)
                : false;

              return (
                <fieldset
                  className={styles.question}
                  data-openbitfun-part="question"
                  disabled={interactionDisabled}
                  key={question.id}
                >
                  <legend className={styles.prompt} data-openbitfun-part="prompt">
                    {question.prompt}
                  </legend>
                  <div className={styles.options} data-openbitfun-part="options">
                    {question.options.map((option, optionIndex) => {
                      const optionId = `${instanceId}-${questionIndex}-${optionIndex}`;
                      const selected = selectedValues.includes(option.value);

                      return (
                        <div
                          className={styles.option}
                          data-openbitfun-part="option"
                          data-selected={selected ? "true" : "false"}
                          key={option.value}
                        >
                          <input
                            checked={selected}
                            className={styles.nativeControl}
                            disabled={interactionDisabled}
                            id={optionId}
                            name={`${instanceId}-${questionIndex}`}
                            onChange={(event) => updateAnswer(
                              question,
                              option.value,
                              event.currentTarget.checked,
                            )}
                            type={multiple ? "checkbox" : "radio"}
                            value={option.value}
                          />
                          <label className={styles.optionSelector} htmlFor={optionId}>
                            <span className={styles.controlIcon} data-openbitfun-part="control">
                              <OptionControl checked={selected} multiple={multiple} />
                            </span>
                            <span className={styles.optionContent}>
                              <span className={styles.optionLabel} data-openbitfun-part="label">
                                {option.label}
                              </span>
                              {option.description !== undefined && option.description !== null && (
                                <OverflowText
                                  className={styles.optionDescription}
                                  data-openbitfun-part="description"
                                  title={descriptionTitle(option.description)}
                                >
                                  {option.description}
                                </OverflowText>
                              )}
                            </span>
                          </label>
                        </div>
                      );
                    })}

                    {customOption && (() => {
                      const optionId = `${instanceId}-${questionIndex}-custom`;
                      const inputLabel = customOption.inputLabel
                        ?? (typeof customOption.label === "string"
                          ? customOption.label
                          : undefined);

                      return (
                        <div
                          className={styles.option}
                          data-openbitfun-part="option"
                          data-custom="true"
                          data-selected={customSelected ? "true" : "false"}
                        >
                          <input
                            checked={customSelected}
                            className={styles.nativeControl}
                            disabled={interactionDisabled}
                            id={optionId}
                            name={`${instanceId}-${questionIndex}`}
                            onChange={(event) => updateAnswer(
                              question,
                              customOption.value,
                              event.currentTarget.checked,
                            )}
                            type={multiple ? "checkbox" : "radio"}
                            value={customOption.value}
                          />
                          <label className={styles.optionSelector} htmlFor={optionId}>
                            <span className={styles.controlIcon} data-openbitfun-part="control">
                              <OptionControl checked={customSelected} multiple={multiple} />
                            </span>
                            <span className={styles.optionContent}>
                              <span className={styles.optionLabel} data-openbitfun-part="label">
                                {customOption.label}
                              </span>
                              {!customSelected
                                && customOption.description !== undefined
                                && customOption.description !== null && (
                                  <OverflowText
                                    className={styles.optionDescription}
                                    data-openbitfun-part="description"
                                    title={descriptionTitle(customOption.description)}
                                  >
                                    {customOption.description}
                                  </OverflowText>
                                )}
                            </span>
                          </label>
                          {customSelected && (
                            <span className={styles.customInput} data-openbitfun-part="custom-input">
                              <Input
                                aria-label={inputLabel}
                                autoFocus
                                disabled={interactionDisabled}
                                onChange={(event) => {
                                  onCustomAnswerChange?.(
                                    question.id,
                                    event.currentTarget.value,
                                    {
                                      isComposing: composingQuestionsRef.current.has(question.id)
                                        || (event.nativeEvent as InputEvent).isComposing,
                                    },
                                  );
                                }}
                                onCompositionEnd={(event) => {
                                  onCustomAnswerChange?.(
                                    question.id,
                                    event.currentTarget.value,
                                    { isComposing: true },
                                  );
                                  queueMicrotask(() => {
                                    composingQuestionsRef.current.delete(question.id);
                                  });
                                }}
                                onCompositionStart={() => {
                                  composingQuestionsRef.current.add(question.id);
                                }}
                                placeholder={customOption.placeholder}
                                size="sm"
                                value={customAnswers[question.id] ?? ""}
                              />
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </fieldset>
              );
            })}
          </div>

          {showFeedback && (
            <div
              className={styles.feedback}
              data-openbitfun-part="feedback"
              role={state === "error" ? "alert" : "status"}
            >
              <span className={styles.statusIcon} data-openbitfun-part="status-icon">
                <StatusIcon state={state} />
              </span>
              <span className={styles.statusText} data-openbitfun-part="status-label">
                {statusLabel}
              </span>
            </div>
          )}
        </div>
      </div>

      {showFooter && (
        <div className={styles.footer} data-openbitfun-part="footer">
          {submitLabel !== undefined && submitLabel !== null && (
            <span className={styles.submit} data-openbitfun-part="submit">
              <Button
                disabled={interactionDisabled || submitDisabled}
                leadingIcon={<ArrowUp aria-hidden="true" />}
                loading={state === "submitting"}
                onClick={onSubmit}
                size="sm"
                title={submitTitle}
                variant="primary"
              >
                {state === "submitting" && submittingLabel !== undefined
                  ? submittingLabel
                  : submitLabel}
              </Button>
            </span>
          )}
          {statusLabel !== undefined && statusLabel !== null && (
            <span className={styles.status} data-openbitfun-part="status">
              <span className={styles.statusIcon} data-openbitfun-part="status-icon">
                <StatusIcon state={state} />
              </span>
              <span className={styles.statusText} data-openbitfun-part="status-label">
                {statusLabel}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
});
