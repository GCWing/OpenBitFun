import {
  forwardRef,
  useState,
  type ChangeEvent,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileRadioGroup.module.css";

export type MobileRadioGroupAppearance = "plain" | "surface";

export interface MobileRadioOption {
  description?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  leading?: ReactNode;
  value: string;
}

export interface MobileRadioGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  appearance?: MobileRadioGroupAppearance;
  defaultValue?: string;
  name: string;
  onValueChange?: (value: string) => void;
  options: readonly MobileRadioOption[];
  value?: string;
}

/** A single-choice list. The options share one input name, so the platform keeps arrow-key
    navigation; the group is a radiogroup rather than a menu of buttons. */
export const MobileRadioGroup = forwardRef<HTMLDivElement, MobileRadioGroupProps>(
  function MobileRadioGroup({
    appearance = "plain",
    className,
    defaultValue,
    name,
    onValueChange,
    options,
    value,
    ...props
  }, ref) {
    const [uncontrolled, setUncontrolled] = useState(defaultValue);
    const controlled = value !== undefined;
    const selected = controlled ? value : uncontrolled;

    function handleChange(event: ChangeEvent<HTMLInputElement>) {
      if (!controlled) setUncontrolled(event.target.value);
      onValueChange?.(event.target.value);
    }

    return (
      <div
        {...props}
        className={classNames(styles.root, className)}
        data-appearance={appearance}
        data-openbitfun-component="mobile-radio-group"
        ref={ref}
        role="radiogroup"
      >
        {options.map(option => {
          const checked = selected === option.value;
          const disabled = option.disabled ?? false;
          return (
            <label
              className={styles.option}
              data-checked={checked ? "true" : "false"}
              data-disabled={disabled ? "true" : "false"}
              data-openbitfun-part="option"
              key={option.value}
            >
              <span className={styles.control}>
                <input
                  checked={checked}
                  className={styles.input}
                  disabled={disabled}
                  name={name}
                  onChange={handleChange}
                  type="radio"
                  value={option.value}
                />
                <span aria-hidden="true" className={styles.circle} data-openbitfun-part="circle">
                  <span className={styles.dot} data-openbitfun-part="dot" />
                </span>
              </span>
              <span className={styles.copy} data-openbitfun-part="copy">
                <span className={styles.label} data-openbitfun-part="label">{option.label}</span>
                {option.description !== undefined && option.description !== null && (
                  <span className={styles.description} data-openbitfun-part="description">{option.description}</span>
                )}
              </span>
              {option.leading !== undefined && option.leading !== null && (
                <span className={styles.leading} data-openbitfun-part="leading">{option.leading}</span>
              )}
            </label>
          );
        })}
      </div>
    );
  },
);
