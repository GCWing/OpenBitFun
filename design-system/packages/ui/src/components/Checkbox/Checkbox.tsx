import { Check as LucideCheck, Minus as LucideMinus } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useRef,
  useImperativeHandle,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import styles from "./Checkbox.module.css";

export type CheckboxSize = "sm" | "md" | "lg";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "size" | "type"> {
  /** Native presentation keeps the browser-drawn control and focus behavior. */
  appearance?: "custom" | "native";
  children?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
  invalid?: boolean;
  label?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  /** Preserve the selection's contrast while preventing user input. */
  readOnly?: boolean;
  size?: CheckboxSize;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({
  appearance = "custom",
  checked,
  children,
  className,
  defaultChecked,
  description,
  disabled = false,
  indeterminate = false,
  invalid = false,
  label,
  onChange,
  onCheckedChange,
  readOnly = false,
  size = "md",
  ...props
}, forwardedRef) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const hasContent = label !== undefined || description !== undefined || children !== undefined;

  return (
    <label
      className={classNames(styles.root, className)}
      data-openbitfun-component="checkbox"
      data-appearance={appearance}
      data-disabled={disabled ? "true" : "false"}
      data-indeterminate={indeterminate ? "true" : "false"}
      data-invalid={invalid ? "true" : "false"}
      data-readonly={readOnly ? "true" : "false"}
      data-size={size}
    >
      <span className={styles.control} data-openbitfun-part="control">
        <input
          {...props}
          aria-invalid={invalid || undefined}
          checked={checked}
          className={styles.input}
          defaultChecked={defaultChecked}
          data-openbitfun-part="input"
          disabled={disabled || readOnly}
          onChange={(event) => {
            onChange?.(event);
            if (!event.defaultPrevented) onCheckedChange?.(event.currentTarget.checked);
          }}
          ref={inputRef}
          type="checkbox"
        />
        {appearance === "custom" && <span aria-hidden="true" className={styles.box} data-openbitfun-part="box">
          <>{indeterminate ? <LucideMinus className={styles.icon} aria-hidden="true" /> : <LucideCheck className={styles.icon} aria-hidden="true" />}</>
        </span>}
      </span>
      {hasContent && (
        <span className={styles.content} data-openbitfun-part="content">
          {label !== undefined && <span className={styles.label}>{label}</span>}
          {description !== undefined && <span className={styles.description}>{description}</span>}
          {children}
        </span>
      )}
    </label>
  );
});
