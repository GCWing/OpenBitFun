import { Check, Minus } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { classNames } from "../../internal/classNames";
import styles from "./MobileCheckbox.module.css";

export type MobileCheckboxAppearance = "plain" | "surface";

export interface MobileCheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "size" | "type"> {
  appearance?: MobileCheckboxAppearance;
  checked?: boolean;
  defaultChecked?: boolean;
  description?: ReactNode;
  indeterminate?: boolean;
  invalid?: boolean;
  label: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
}

/** A check row. A checkbox in a mobile list is a row, not a box beside a caption: the whole row is
    the target, so the box keeps the web control's geometry and the row supplies the touch size. */
export const MobileCheckbox = forwardRef<HTMLInputElement, MobileCheckboxProps>(
  function MobileCheckbox({
    appearance = "plain",
    checked,
    className,
    defaultChecked,
    description,
    disabled,
    indeterminate = false,
    invalid = false,
    label,
    onChange,
    onCheckedChange,
    ...props
  }, ref) {
    const [uncontrolled, setUncontrolled] = useState(defaultChecked ?? false);
    const inputRef = useRef<HTMLInputElement>(null);
    const controlled = checked !== undefined;
    const resolved = controlled ? checked : uncontrolled;
    /* Focus and press states belong to the hidden input, but the row is what changes. The Lab drives
       the row through a root attribute, so lift that hook off the input onto the label. */
    const previewState = (props as Record<string, unknown>)["data-openbitfun-preview-state"];

    // `indeterminate` has no HTML attribute: it only exists as a DOM property, and it also
    // decides which glyph the box draws, which is why it is mirrored into a data attribute.
    useEffect(() => {
      if (inputRef.current) inputRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    useImperativeHandle(ref, () => inputRef.current!, []);

    function handleChange(event: ChangeEvent<HTMLInputElement>) {
      if (!controlled) setUncontrolled(event.target.checked);
      onChange?.(event);
      onCheckedChange?.(event.target.checked);
    }

    return (
      <label
        className={classNames(styles.root, className)}
        data-appearance={appearance}
        data-checked={resolved ? "true" : "false"}
        data-disabled={disabled ? "true" : "false"}
        data-indeterminate={indeterminate ? "true" : "false"}
        data-invalid={invalid ? "true" : "false"}
        data-openbitfun-component="mobile-checkbox"
        data-openbitfun-preview-state={typeof previewState === "string" ? previewState : undefined}
      >
        <span className={styles.control}>
          <input
            {...props}
            aria-checked={indeterminate ? "mixed" : undefined}
            aria-invalid={invalid || undefined}
            checked={resolved}
            className={styles.input}
            disabled={disabled}
            onChange={handleChange}
            ref={inputRef}
            type="checkbox"
          />
          <span aria-hidden="true" className={styles.box} data-openbitfun-part="box">
            {indeterminate ? <Minus className={styles.icon} /> : <Check className={styles.icon} />}
          </span>
        </span>
        <span className={styles.copy} data-openbitfun-part="copy">
          <span className={styles.label} data-openbitfun-part="label">{label}</span>
          {description !== undefined && description !== null && (
            <span className={styles.description} data-openbitfun-part="description">{description}</span>
          )}
        </span>
      </label>
    );
  },
);
