import { useFieldAccessibility } from "../Field/FieldAccessibility";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type TextareaHTMLAttributes,
} from "react";
import { classNames } from "../../internal/classNames";
import { useFieldSurface } from "../../internal/fieldSurface";
import { isImeOwnedKeyboardEvent } from "../../internal/ime";
import styles from "./Textarea.module.css";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  autoResize?: boolean;
  className?: string;
  errorMessage?: string;
  font?: "mono" | "sans";
  hint?: string;
  invalid?: boolean;
  label?: string;
  layout?: "auto" | "fill";
  onValueChange?: (value: string) => void;
  resize?: "none" | "vertical";
  showCount?: boolean;
  variant?: "default" | "filled" | "outlined";
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  autoResize = false,
  className,
  errorMessage,
  font = "sans",
  hint,
  id,
  invalid = false,
  label,
  layout = "auto",
  maxLength,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onValueChange,
  required,
  resize = "vertical",
  showCount = false,
  value,
  variant = "default",
  ...props
}, ref) {
  const generatedId = useId();
  const fieldSurface = useFieldSurface();
  const resolvedId = id ?? `${generatedId}-textarea`;
  const supportId = `${generatedId}-support`;
  const compositionActiveRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uncontrolledCount, setUncontrolledCount] = useState(() => String(props.defaultValue ?? "").length);
  const count = value === undefined ? uncontrolledCount : String(value).length;
  const resolvedInvalid = invalid || (ariaInvalid !== undefined && ariaInvalid !== false && ariaInvalid !== "false");
  const hasSupport = Boolean((resolvedInvalid && errorMessage) || (!resolvedInvalid && hint) || showCount);

  const fieldAccessibility = useFieldAccessibility({
    ...props,
    "aria-describedby": [ariaDescribedBy, hasSupport ? supportId : undefined].filter(Boolean).join(" "),
  }, Boolean(label));

  const resizeToContent = useCallback((node: HTMLTextAreaElement) => {
    if (!autoResize) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [autoResize]);

  useImperativeHandle(ref, () => textareaRef.current as HTMLTextAreaElement);

  useIsomorphicLayoutEffect(() => {
    if (textareaRef.current) resizeToContent(textareaRef.current);
  }, [resizeToContent, value]);

  const handleChange: ChangeEventHandler<HTMLTextAreaElement> = (event) => {
    setUncontrolledCount(event.currentTarget.value.length);
    resizeToContent(event.currentTarget);
    onChange?.(event);
    onValueChange?.(event.currentTarget.value);
  };

  return (
    <span
      className={classNames(styles.root, className)}
      data-auto-resize={autoResize ? "true" : "false"}
      data-openbitfun-component="textarea"
      data-field-surface={fieldSurface}
      data-font={font}
      data-invalid={resolvedInvalid ? "true" : "false"}
      data-layout={layout}
      data-resize={resize}
      data-variant={variant}
    >
      {label && (
        <label className={styles.label} data-openbitfun-part="label" htmlFor={resolvedId}>
          {label}
          {required && (
            <span aria-hidden="true" className={styles.required} data-openbitfun-part="required">
              *
            </span>
          )}
        </label>
      )}
      <textarea
        {...props}
        {...fieldAccessibility}
        aria-invalid={resolvedInvalid || undefined}
        className={styles.textarea}
        data-openbitfun-part="input"
        id={resolvedId}
        maxLength={maxLength}
        onChange={handleChange}
        onCompositionEnd={(event) => { compositionActiveRef.current = false; onCompositionEnd?.(event); }}
        onCompositionStart={(event) => { compositionActiveRef.current = true; onCompositionStart?.(event); }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === "Escape") && isImeOwnedKeyboardEvent(event, compositionActiveRef.current)) {
            event.stopPropagation();
            return;
          }
          onKeyDown?.(event);
        }}
        ref={textareaRef}
        required={required}
        value={value}
      />
      {hasSupport && (
        <span className={styles.support} data-openbitfun-part="support" id={supportId}>
          <span className={resolvedInvalid ? styles.error : styles.hint} data-openbitfun-part="message">{resolvedInvalid ? errorMessage : hint}</span>
          {showCount && <span className={styles.count} data-openbitfun-part="count">{count}{maxLength ? ` / ${maxLength}` : ""}</span>}
        </span>
      )}
    </span>
  );
});
