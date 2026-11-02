import { Minus, Plus } from "lucide-react";
import { useState, type ChangeEvent, type HTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileStepper.module.css";

export interface MobileStepperProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  decrementLabel: string;
  description?: ReactNode;
  disabled?: boolean;
  incrementLabel: string;
  invalid?: boolean;
  label?: ReactNode;
  max?: number;
  min?: number;
  onValueChange?: (value: number) => void;
  step?: number;
  unit?: ReactNode;
  value?: number;
}

/** The mobile form of a number input: a value that is usually nudged, so the two ends are buttons
    and the middle stays typable. Bounds disable the buttons rather than rejecting the tap. */
export function MobileStepper({
  className,
  decrementLabel,
  description,
  disabled = false,
  incrementLabel,
  invalid = false,
  label,
  max,
  min,
  onValueChange,
  step = 1,
  unit,
  value,
  ...props
}: MobileStepperProps) {
  const [uncontrolled, setUncontrolled] = useState(min ?? 0);
  const controlled = value !== undefined;
  const current = controlled ? value : uncontrolled;

  function commit(next: number) {
    const bounded = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next));
    if (!controlled) setUncontrolled(bounded);
    onValueChange?.(bounded);
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const parsed = Number(event.target.value);
    if (Number.isFinite(parsed)) commit(parsed);
  }

  const atMin = min !== undefined && current <= min;
  const atMax = max !== undefined && current >= max;

  return (
    <div
      {...props}
      className={classNames(styles.root, className)}
      data-disabled={disabled ? "true" : "false"}
      data-invalid={invalid ? "true" : "false"}
      data-openbitfun-component="mobile-stepper"
    >
      {(label !== undefined && label !== null) && (
        <span className={styles.copy} data-openbitfun-part="copy">
          <span className={styles.label} data-openbitfun-part="label">{label}</span>
          {description !== undefined && description !== null && (
            <span className={styles.description} data-openbitfun-part="description">{description}</span>
          )}
        </span>
      )}
      <span className={styles.control} data-openbitfun-part="control">
        <button
          aria-label={decrementLabel}
          className={styles.button}
          data-openbitfun-part="decrement"
          disabled={disabled || atMin}
          onClick={() => commit(current - step)}
          type="button"
        >
          <Minus aria-hidden="true" />
        </button>
        <span className={styles.value}>
          <input
            aria-invalid={invalid || undefined}
            aria-valuemax={max}
            aria-valuemin={min}
            aria-valuenow={current}
            className={styles.input}
            data-openbitfun-part="value"
            disabled={disabled}
            inputMode="numeric"
            onChange={handleInput}
            role="spinbutton"
            type="text"
            value={current}
          />
          {unit !== undefined && unit !== null && (
            <span className={styles.unit} data-openbitfun-part="unit">{unit}</span>
          )}
        </span>
        <button
          aria-label={incrementLabel}
          className={styles.button}
          data-openbitfun-part="increment"
          disabled={disabled || atMax}
          onClick={() => commit(current + step)}
          type="button"
        >
          <Plus aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
