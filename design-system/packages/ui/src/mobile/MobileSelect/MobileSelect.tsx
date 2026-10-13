import { ChevronDown } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import { MobileChoiceSheet } from "../MobileChoiceSheet";
import styles from "./MobileSelect.module.css";

export type MobileSelectAppearance = "soft" | "surface";

export interface MobileSelectOption {
  description?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  leading?: ReactNode;
  value: string;
}

export interface MobileSelectProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "disabled" | "onChange" | "value"> {
  appearance?: MobileSelectAppearance;
  cancelLabel?: ReactNode;
  defaultOpen?: boolean;
  defaultValue?: string;
  description?: ReactNode;
  disabled?: boolean;
  emptyContent?: ReactNode;
  invalid?: boolean;
  label?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (value: string) => void;
  open?: boolean;
  options: readonly MobileSelectOption[];
  placeholder?: ReactNode;
  sheetTitle: ReactNode;
  value?: string;
}

/** A choice field. Mobile has no room for a popup listbox, so the field opens the choice sheet the
    rest of the mobile set already uses; the selected option is read from the field's own text. */
export function MobileSelect({
  appearance = "soft",
  cancelLabel,
  className,
  defaultValue,
  defaultOpen = false,
  description,
  disabled = false,
  emptyContent,
  invalid = false,
  label,
  onOpenChange,
  onValueChange,
  open: controlledOpen,
  options,
  placeholder,
  sheetTitle,
  value,
  ...props
}: MobileSelectProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen && !disabled);
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const controlled = value !== undefined;
  const selected = controlled ? value : uncontrolled;
  const selectedOption = options.find(option => option.value === selected);
  /* The sheet is the component's open state, so it follows the same controlled trio as the web
     Select: `open` wins, `defaultOpen` seeds the uncontrolled case, and both report changes. */
  const open = disabled ? false : controlledOpen ?? uncontrolledOpen;

  function setSheetOpen(next: boolean) {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  function select(next: string) {
    if (!controlled) setUncontrolled(next);
    onValueChange?.(next);
    setSheetOpen(false);
  }

  return (
    <div
      className={classNames(styles.root, className)}
      data-appearance={appearance}
      data-disabled={disabled ? "true" : "false"}
      data-invalid={invalid ? "true" : "false"}
      data-open={open ? "true" : "false"}
      data-openbitfun-component="mobile-select"
    >
      {label !== undefined && label !== null && (
        <span className={styles.copy} data-openbitfun-part="copy">
          <span className={styles.label} data-openbitfun-part="label">{label}</span>
          {description !== undefined && description !== null && (
            <span className={styles.description} data-openbitfun-part="description">{description}</span>
          )}
        </span>
      )}
      <button
        {...props}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-invalid={invalid || undefined}
        className={styles.field}
        data-openbitfun-part="field"
        disabled={disabled}
        onClick={() => setSheetOpen(true)}
        type="button"
      >
        <span className={styles.value} data-openbitfun-part="value" data-placeholder={selectedOption ? "false" : "true"}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown aria-hidden="true" className={styles.chevron} />
      </button>
      <MobileChoiceSheet
        cancelLabel={cancelLabel}
        emptyContent={emptyContent}
        onOpenChange={next => { if (!next) setSheetOpen(false); }}
        onSelect={select}
        open={open}
        options={options}
        selectedValue={selected}
        title={sheetTitle}
      />
    </div>
  );
}
