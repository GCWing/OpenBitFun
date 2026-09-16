import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type InputHTMLAttributes,
  type KeyboardEventHandler,
} from "react";
import { classNames } from "../../internal/classNames";
import { useFieldSurface } from "../../internal/fieldSurface";
import { isImeOwnedKeyboardEvent } from "../../internal/ime";
import styles from "./NumberInput.module.css";

export interface NumberInputProps extends Pick<InputHTMLAttributes<HTMLInputElement>, "id" | "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid" | "required"> {
  className?: string;
  decrementLabel?: string;
  disabled?: boolean;
  disableWheel?: boolean;
  draggable?: boolean;
  /** Formats the unfocused value; editing and callbacks remain numeric. */
  formatValue?: (value: number) => string;
  incrementLabel?: string;
  label?: string;
  max?: number;
  min?: number;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onValueChange: (value: number) => void;
  onFocus?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  precision?: number;
  showButtons?: boolean;
  size?: "sm" | "md" | "lg";
  step?: number;
  unit?: string;
  value: number;
  variant?: "default" | "compact" | "stepper";
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput({
  className,
  decrementLabel = "Decrease value",
  disabled = false,
  disableWheel = false,
  formatValue,
  incrementLabel = "Increase value",
  label,
  max = Number.POSITIVE_INFINITY,
  min = Number.NEGATIVE_INFINITY,
  onBlur,
  onValueChange,
  onFocus,
  onKeyDown,
  precision = 0,
  showButtons = true,
  size = "md",
  step = 1,
  unit,
  value,
  variant = "default",
  id,
  required,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}, ref) {
  const fieldSurface = useFieldSurface();
  const format = useCallback((next: number) => precision > 0 ? next.toFixed(precision) : String(Math.round(next)), [precision]);
  const clamp = useCallback((next: number) => Math.min(max, Math.max(min, next)), [max, min]);
  const [draft, setDraft] = useState(() => format(value));
  const [editing, setEditing] = useState(false);
  const compositionActiveRef = useRef(false);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => { if (!editing) setDraft(format(value)); }, [editing, format, value]);

  const commit = useCallback(() => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed);
      if (next !== value) onValueChange(next);
      setDraft(format(next));
    } else {
      setDraft(format(value));
    }
    setEditing(false);
  }, [clamp, draft, format, onValueChange, value]);
  const changeBy = (amount: number) => {
    const next = clamp(value + amount);
    if (next !== value) onValueChange(next);
  };
  return (
    <span className={classNames(styles.root, className)} data-openbitfun-component="number-input" data-disabled={disabled ? "true" : "false"} data-field-surface={fieldSurface} data-size={size} data-variant={variant}>
      {label && <span className={styles.label} data-openbitfun-part="label">{label}</span>}
      <span
        className={styles.control}
        data-openbitfun-part="control"
        onWheel={(event) => {
          if (disabled || disableWheel || document.activeElement !== event.currentTarget.querySelector("input")) return;
          event.preventDefault();
          changeBy(event.deltaY < 0 ? step : -step);
        }}
      >
        <input
          id={id}
          required={required}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-label={ariaLabel ?? label}
          className={styles.input}
          data-openbitfun-part="input"
          disabled={disabled}
          inputMode="decimal"
          onBlur={(event) => {
            onBlur?.(event);
            if (!event.defaultPrevented && !skipBlurCommitRef.current) commit();
            skipBlurCommitRef.current = false;
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onCompositionEnd={(event) => {
            compositionActiveRef.current = false;
          }}
          onCompositionStart={(event) => {
            compositionActiveRef.current = true;
          }}
          onFocus={(event) => {
            if (formatValue) setDraft(format(value));
            setEditing(true);
            onFocus?.(event);
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if ((event.key === "Enter" || event.key === "Escape") && isImeOwnedKeyboardEvent(event, compositionActiveRef.current)) { event.stopPropagation(); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); changeBy(step); }
            if (event.key === "ArrowDown") { event.preventDefault(); changeBy(-step); }
            if (event.key === "Enter") { event.currentTarget.blur(); }
            if (event.key === "Escape") { skipBlurCommitRef.current = true; setDraft(format(value)); setEditing(false); event.currentTarget.blur(); }
          }}
          ref={ref}
          type="text"
          value={!editing && formatValue ? formatValue(value) : draft}
        />
        {unit && <span className={styles.unit} data-openbitfun-part="unit">{unit}</span>}
        {showButtons && variant !== "compact" && (
          <span className={styles.buttons} data-openbitfun-part="buttons">
            <button aria-label={decrementLabel} disabled={disabled || value <= min} onClick={() => changeBy(-step)} tabIndex={-1} type="button">−</button>
            <button aria-label={incrementLabel} disabled={disabled || value >= max} onClick={() => changeBy(step)} tabIndex={-1} type="button">+</button>
          </span>
        )}
      </span>
    </span>
  );
});
