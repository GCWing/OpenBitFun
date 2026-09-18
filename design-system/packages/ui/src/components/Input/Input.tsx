import {
  forwardRef,
  useRef,
  type ChangeEventHandler,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import { useFieldSurface } from "../../internal/fieldSurface";
import { isImeOwnedKeyboardEvent } from "../../internal/ime";
import styles from "./Input.module.css";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "size"> {
  className?: string;
  /** Hide the browser reveal button when the caller provides a visibility control. */
  hideNativePasswordReveal?: boolean;
  invalid?: boolean;
  leading?: ReactNode;
  onValueChange?: (value: string) => void;
  size?: "sm" | "md" | "lg";
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  "aria-invalid": ariaInvalid,
  className,
  disabled,
  hideNativePasswordReveal = false,
  invalid = false,
  leading,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onValueChange,
  size = "sm",
  trailing,
  type = "text",
  ...props
}, ref) {
  const compositionActiveRef = useRef(false);
  const fieldSurface = useFieldSurface();
  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    onChange?.(event);
    onValueChange?.(event.currentTarget.value);
  };
  const resolvedAriaInvalid = invalid ? true : ariaInvalid;
  const isInvalid = resolvedAriaInvalid !== undefined
    && resolvedAriaInvalid !== false
    && resolvedAriaInvalid !== "false";

  return (
    <span
      className={classNames(styles.field, className)}
      data-openbitfun-component="input"
      data-disabled={disabled ? "true" : "false"}
      data-field-surface={fieldSurface}
      data-invalid={isInvalid ? "true" : "false"}
      data-size={size}
    >
      {leading !== undefined && leading !== null && (
        <span className={styles.leading} data-openbitfun-icon-slot="true" data-openbitfun-part="leading">{leading}</span>
      )}
      <input
        {...props}
        aria-invalid={resolvedAriaInvalid}
        className={styles.input}
        data-hide-native-password-reveal={hideNativePasswordReveal ? "true" : undefined}
        disabled={disabled}
        onChange={handleChange}
        onCompositionEnd={(event) => {
          compositionActiveRef.current = false;
          onCompositionEnd?.(event);
        }}
        onCompositionStart={(event) => {
          compositionActiveRef.current = true;
          onCompositionStart?.(event);
        }}
        onKeyDown={(event) => {
          if (
            (event.key === "Enter" || event.key === "Escape")
            && isImeOwnedKeyboardEvent(event, compositionActiveRef.current)
          ) {
            event.stopPropagation();
            return;
          }
          onKeyDown?.(event);
        }}
        ref={ref}
        type={type}
      />
      {trailing !== undefined && trailing !== null && (
        <span className={styles.trailing} data-openbitfun-icon-slot="true" data-openbitfun-part="trailing">{trailing}</span>
      )}
    </span>
  );
});
