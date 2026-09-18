import {
  forwardRef,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlOption {
  disabled?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  value: string;
}

export interface SegmentedControlProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    "children" | "defaultValue" | "onChange"
  > {
  /** Buttons keep every option in Tab order and leave arrow keys to the owner. */
  interaction?: "radio" | "buttons";
  labelBehavior?: "overflow" | "static";
  defaultValue?: string;
  disabled?: boolean;
  distribution?: "content" | "fill";
  onValueChange?: (value: string) => void;
  options: readonly SegmentedControlOption[];
  size?: "sm" | "md";
  tone?: "accent" | "neutral";
  value?: string;
  variant?: "bar" | "pills";
}

function getFirstEnabledValue(options: readonly SegmentedControlOption[]): string {
  return options.find((option) => !option.disabled)?.value ?? "";
}

function getSelectedValue(
  options: readonly SegmentedControlOption[],
  candidate: string | undefined,
): string {
  const candidateOption = options.find((option) => option.value === candidate);
  return candidateOption && !candidateOption.disabled
    ? candidateOption.value
    : getFirstEnabledValue(options);
}

export const SegmentedControl = forwardRef<HTMLDivElement, SegmentedControlProps>(
  function SegmentedControl({
    className,
    defaultValue,
    interaction = "radio",
    labelBehavior = "overflow",
    disabled = false,
    distribution = "content",
    onValueChange,
    options,
    size = "sm",
    tone = "accent",
    value,
    variant = "bar",
    ...props
  }, ref) {
    const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [uncontrolledValue, setUncontrolledValue] = useState(
      () => defaultValue ?? getFirstEnabledValue(options),
    );
    const selectedValue = getSelectedValue(options, value ?? uncontrolledValue);

    function selectOption(option: SegmentedControlOption) {
      if (disabled || option.disabled || (interaction === "radio" && option.value === selectedValue)) {
        return;
      }
      if (value === undefined) {
        setUncontrolledValue(option.value);
      }
      onValueChange?.(option.value);
    }

    function handleKeyDown(
      event: KeyboardEvent<HTMLButtonElement>,
      currentIndex: number,
    ) {
      const enabledOptions = options
        .map((option, index) => ({ index, option }))
        .filter(({ option }) => !option.disabled);
      if (enabledOptions.length === 0) {
        return;
      }

      const currentEnabledIndex = enabledOptions.findIndex(
        ({ index }) => index === currentIndex,
      );
      const isRtl = event.currentTarget.ownerDocument.defaultView
        ?.getComputedStyle(event.currentTarget).direction === "rtl";
      let target: (typeof enabledOptions)[number] | undefined;

      if (
        event.key === "ArrowRight"
        || event.key === "ArrowLeft"
        || event.key === "ArrowDown"
        || event.key === "ArrowUp"
      ) {
        const movesForward = event.key === "ArrowDown"
          || (event.key === "ArrowRight" ? !isRtl : event.key === "ArrowLeft" && isRtl);
        const offset = movesForward ? 1 : -1;
        const nextIndex = (currentEnabledIndex + offset + enabledOptions.length)
          % enabledOptions.length;
        target = enabledOptions[nextIndex];
      } else if (event.key === "Home") {
        target = enabledOptions[0];
      } else if (event.key === "End") {
        target = enabledOptions[enabledOptions.length - 1];
      } else {
        return;
      }

      if (!target) {
        return;
      }
      event.preventDefault();
      selectOption(target.option);
      segmentRefs.current[target.index]?.focus();
    }

    return (
      <div
        {...props}
        aria-disabled={disabled || undefined}
        className={classNames(styles.root, className)}
        data-openbitfun-component="segmented-control"
        data-openbitfun-part="root"
        data-disabled={disabled ? "true" : "false"}
        data-distribution={distribution}
        data-size={size}
        data-tone={tone}
        data-variant={variant}
        ref={ref}
        role={interaction === "radio" ? "radiogroup" : "group"}
        data-interaction={interaction}
      >
        {options.map((option, index) => {
          const selected = option.value === selectedValue;
          return (
            <button data-overflow-trigger
              aria-checked={interaction === "radio" ? selected : undefined}
              aria-pressed={interaction === "buttons" ? selected : undefined}
              className={styles.segment}
              data-openbitfun-part="segment"
              data-openbitfun-value={option.value}
              disabled={disabled || option.disabled}
              key={option.value}
              onClick={() => selectOption(option)}
              onKeyDown={interaction === "radio" ? (event) => handleKeyDown(event, index) : undefined}
              ref={(node) => {
                segmentRefs.current[index] = node;
              }}
              role={interaction === "radio" ? "radio" : undefined}
              tabIndex={interaction === "buttons" || selected ? 0 : -1}
              type="button"
            >
              {option.icon && (
                <span aria-hidden="true" className={styles.icon} data-openbitfun-icon-slot="true" data-openbitfun-part="icon">
                  {option.icon}
                </span>
              )}
              {labelBehavior === "static"
                ? <span className={styles.label} data-openbitfun-part="label">{option.label}</span>
                : <OverflowText className={styles.label} data-openbitfun-part="label">{option.label}</OverflowText>}
            </button>
          );
        })}
      </div>
    );
  },
);
