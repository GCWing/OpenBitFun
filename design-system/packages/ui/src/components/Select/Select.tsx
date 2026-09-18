import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEventHandler,
  type FocusEventHandler,
  type ForwardedRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import { useFieldSurface } from "../../internal/fieldSurface";
import { useAnchoredLayer, type LayerPlacement } from "../../internal/useAnchoredLayer";
import { Portal } from "../../overlay/Portal";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import { useDismissibleLayer } from "../../overlay/useDismissibleLayer";
import { Icon } from "../Icon";
import {
  Listbox,
  ListboxEmpty,
  ListboxGroup,
  ListboxOption,
} from "../Listbox";
import styles from "./Select.module.css";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type SelectValue = string | number;
export type SelectSize = "sm" | "md" | "lg";
export type SelectPlacement = Extract<LayerPlacement, "top" | "bottom">;

export interface SelectOption {
  disabled?: boolean;
  group?: string;
  label: string;
  testAttributes?: Record<`data-${string}`, string | number | boolean | undefined>;
  testId?: string;
  value: SelectValue;
}

export interface SelectProps
  extends Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "children" | "defaultValue" | "onChange" | "size" | "value"
  > {
  defaultOpen?: boolean;
  defaultValue?: SelectValue;
  invalid?: boolean;
  leading?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  onValueChange?: (value: SelectValue) => void;
  open?: boolean;
  options: readonly SelectOption[];
  placement?: SelectPlacement;
  placeholder?: string;
  size?: SelectSize;
  value?: SelectValue;
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function toNativeValue(value: SelectValue | undefined) {
  return value === undefined ? "" : String(value);
}

function valuesMatch(left: SelectValue | undefined, right: SelectValue | undefined) {
  if (left === undefined || right === undefined) return left === right;
  return String(left) === String(right);
}

function initialValue(
  options: readonly SelectOption[],
  defaultValue: SelectValue | undefined,
  placeholder: string | undefined,
) {
  if (defaultValue !== undefined) return defaultValue;
  return placeholder === undefined ? options[0]?.value : undefined;
}

function groupOptions(options: readonly SelectOption[]) {
  const groups = new Map<string, SelectOption[]>();
  const ungrouped: SelectOption[] = [];

  for (const option of options) {
    if (!option.group) {
      ungrouped.push(option);
      continue;
    }
    const group = groups.get(option.group) ?? [];
    group.push(option);
    groups.set(option.group, group);
  }

  return { groups, ungrouped };
}

function renderNativeOption(option: SelectOption) {
  return (
    <option
      data-testid={option.testId}
      disabled={option.disabled}
      key={`${typeof option.value}:${option.value}`}
      value={String(option.value)}
      {...option.testAttributes}
    >
      {option.label}
    </option>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-required": ariaRequired,
  autoFocus = false,
  className,
  defaultOpen = false,
  defaultValue,
  disabled = false,
  id: providedId,
  invalid = false,
  leading,
  onBlur,
  onFocus,
  onOpenChange,
  onValueChange,
  open,
  options,
  placement = "bottom",
  placeholder,
  required = false,
  size = "md",
  style,
  tabIndex,
  title,
  value,
  ...nativeProps
}, forwardedRef) {
  const designSystem = useDesignSystem();
  const fieldSurface = useFieldSurface();
  const generatedId = useId();
  const id = providedId ?? `openbitfun-select-${generatedId}`;
  const listboxId = `${id}-listbox`;
  const nativeId = `${id}-native`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nativeRef = useRef<HTMLSelectElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const restoreFocusAfterCloseRef = useRef(false);
  const dismissibleBranches = useMemo(() => [rootRef], []);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen && !disabled);
  const [uncontrolledValue, setUncontrolledValue] = useState<SelectValue | undefined>(() => (
    initialValue(options, defaultValue, placeholder)
  ));
  const resolvedOpen = !disabled && (open ?? uncontrolledOpen);
  const resolvedValue = value !== undefined ? value : uncontrolledValue;
  const resolvedInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  const selectedOption = options.find((option) => valuesMatch(option.value, resolvedValue));
  const { groups, ungrouped } = useMemo(() => groupOptions(options), [options]);
  const previewState = (nativeProps as Record<string, unknown>)["data-openbitfun-preview-state"];

  const setNativeRef = useCallback((node: HTMLSelectElement | null) => {
    nativeRef.current = node;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  const updateOpen = useCallback((nextOpen: boolean) => {
    if (nextOpen === resolvedOpen) return;
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open, resolvedOpen]);

  const closeListbox = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) restoreFocusAfterCloseRef.current = true;
    updateOpen(false);
  }, [updateOpen]);

  useIsomorphicLayoutEffect(() => {
    if (resolvedOpen || !restoreFocusAfterCloseRef.current) return;
    restoreFocusAfterCloseRef.current = false;
    if (triggerRef.current?.isConnected) triggerRef.current.focus();
  }, [resolvedOpen]);

  const commitOption = useCallback((option: SelectOption, restoreFocus: boolean) => {
    if (disabled || option.disabled) return;
    if (!valuesMatch(option.value, resolvedValue)) {
      if (value === undefined) setUncontrolledValue(option.value);
      onValueChange?.(option.value);
    }
    closeListbox(restoreFocus);
  }, [closeListbox, disabled, onValueChange, resolvedValue, value]);

  const handleNativeChange: ChangeEventHandler<HTMLSelectElement> = (event) => {
    const option = options.find((candidate) => (
      String(candidate.value) === event.currentTarget.value
    ));
    if (option) commitOption(option, false);
  };

  const handleNativeFocus: FocusEventHandler<HTMLSelectElement> = (event) => {
    onFocus?.(event);
    if (!event.defaultPrevented) triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (resolvedOpen) {
        const enabledOptions = Array.from(
          popoverRef.current?.querySelectorAll<HTMLButtonElement>(
            "[data-openbitfun-listbox-option]:not(:disabled)",
          ) ?? [],
        );
        const selectedIndex = enabledOptions.findIndex((option) => (
          option.getAttribute("aria-selected") === "true"
        ));
        const fallbackIndex = event.key === "ArrowUp" ? enabledOptions.length - 1 : 0;
        enabledOptions[selectedIndex >= 0 ? selectedIndex : fallbackIndex]?.focus();
        return;
      }
      updateOpen(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (resolvedOpen) closeListbox(true);
      else updateOpen(true);
      return;
    }
    if (!resolvedOpen && (event.key === "Home" || event.key === "End")) {
      const enabledOptions = options.filter((option) => !option.disabled);
      const option = event.key === "Home"
        ? enabledOptions[0]
        : enabledOptions[enabledOptions.length - 1];
      if (option) {
        event.preventDefault();
        commitOption(option, false);
      }
      return;
    }
    if (
      !resolvedOpen
      && event.key.length === 1
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
    ) {
      const enabledOptions = options.filter((option) => !option.disabled);
      const currentIndex = enabledOptions.findIndex((option) => (
        valuesMatch(option.value, resolvedValue)
      ));
      const query = event.key.toLocaleLowerCase();
      for (let offset = 1; offset <= enabledOptions.length; offset += 1) {
        const option = enabledOptions[(currentIndex + offset) % enabledOptions.length];
        if (option?.label.trim().toLocaleLowerCase().startsWith(query)) {
          event.preventDefault();
          commitOption(option, false);
          break;
        }
      }
    }
  };

  const handleListboxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      closeListbox(true);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-openbitfun-listbox-option]")
      : null;
    if (!target || target.disabled) return;
    event.preventDefault();
    target.click();
  };

  useDismissibleLayer({
    branchRefs: dismissibleBranches,
    enabled: resolvedOpen,
    layerRef: popoverRef,
    onDismiss: (reason) => closeListbox(reason === "escape-key"),
    ownerDocument: triggerRef.current?.ownerDocument,
  });

  const layout = useAnchoredLayer({
    anchorRef: triggerRef,
    layerRef: popoverRef,
    matchWidth: true,
    open: resolvedOpen,
    overlapAnchor: true,
    placement,
    revision: options.length,
  });

  useEffect(() => {
    if (value !== undefined) return;
    if (options.some((option) => valuesMatch(option.value, uncontrolledValue))) return;
    const nextValue = initialValue(options, defaultValue, placeholder);
    if (!valuesMatch(nextValue, uncontrolledValue)) setUncontrolledValue(nextValue);
  }, [defaultValue, options, placeholder, uncontrolledValue, value]);

  useEffect(() => {
    const select = nativeRef.current;
    const form = select?.form;
    if (!form || value !== undefined) return;
    const handleReset = () => {
      setUncontrolledValue(initialValue(options, defaultValue, placeholder));
      updateOpen(false);
    };
    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [defaultValue, options, placeholder, updateOpen, value]);

  const renderListboxOption = (option: SelectOption) => (
    <ListboxOption
      {...option.testAttributes}
      aria-label={option.label}
      data-testid={option.testId}
      disabled={option.disabled}
      key={`${typeof option.value}:${option.value}`}
      onClick={() => commitOption(option, true)}
      selected={valuesMatch(option.value, resolvedValue)}
      value={option.value}
    >
      {option.label}
    </ListboxOption>
  );

  const renderTriggerContent = () => (
    <>
      {leading !== undefined && leading !== null && (
        <span aria-hidden="true" className={styles.leading} data-openbitfun-icon-slot="true" data-openbitfun-part="leading">
          {leading}
        </span>
      )}
      <OverflowText
        className={selectedOption ? styles.value : styles.placeholder}
        data-openbitfun-part="value"
      >
        {selectedOption?.label ?? placeholder}
      </OverflowText>
      <span aria-hidden="true" className={styles.indicator} data-openbitfun-icon-slot="true" data-openbitfun-part="indicator">
        <Icon name="chevron-down" size="sm" />
      </span>
    </>
  );

  const popup = resolvedOpen ? (
    <div
      className={styles.popover}
      data-openbitfun-component="select-popup"
      data-openbitfun-part="popover"
      data-openbitfun-native-webview-occlusion
      data-invalid={resolvedInvalid ? "true" : "false"}
      data-placement={layout?.placement ?? placement}
      data-size={size}
      ref={popoverRef}
      style={layout?.style ?? { position: "fixed", visibility: "hidden" }}
    >
      <button
        data-overflow-trigger
        aria-controls={listboxId}
        aria-describedby={ariaDescribedBy}
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-invalid={invalid ? true : ariaInvalid}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={required || ariaRequired || undefined}
        className={classNames(styles.trigger, styles.popoverHeader)}
        data-openbitfun-part="header"
        data-openbitfun-preview-state={typeof previewState === "string" ? previewState : undefined}
        id={id}
        onClick={() => closeListbox(true)}
        onKeyDown={handleTriggerKeyDown}
        role="combobox"
        title={title}
        type="button"
      >
        {renderTriggerContent()}
      </button>
      <div aria-hidden="true" className={styles.divider} data-openbitfun-part="divider" />
      <div className={styles.options} data-openbitfun-part="options">
        <Listbox
          aria-label={ariaLabel}
          aria-labelledby={ariaLabel ? undefined : ariaLabelledBy ?? id}
          autoFocusOption
          className={styles.listbox}
          id={listboxId}
          onKeyDown={handleListboxKeyDown}
        >
          {options.length === 0 ? (
            <ListboxEmpty>{designSystem.messages.noOptions}</ListboxEmpty>
          ) : (
            <>
              {ungrouped.map(renderListboxOption)}
              {[...groups].map(([label, groupedOptions]) => (
                <ListboxGroup key={label} label={label}>
                  {groupedOptions.map(renderListboxOption)}
                </ListboxGroup>
              ))}
            </>
          )}
        </Listbox>
      </div>
    </div>
  ) : null;

  return (
    <span
      className={classNames(styles.root, className)}
      data-openbitfun-component="select"
      data-disabled={disabled ? "true" : "false"}
      data-field-surface={fieldSurface}
      data-has-leading={leading !== undefined && leading !== null ? "true" : "false"}
      data-invalid={resolvedInvalid ? "true" : "false"}
      data-open={resolvedOpen ? "true" : "false"}
      data-placement={layout?.placement ?? placement}
      data-size={size}
      ref={rootRef}
    >
      <select
        {...nativeProps}
        aria-describedby={ariaDescribedBy}
        aria-hidden="true"
        aria-invalid={invalid ? true : ariaInvalid}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={required || ariaRequired || undefined}
        className={styles.native}
        disabled={disabled}
        id={nativeId}
        onBlur={onBlur}
        onChange={handleNativeChange}
        onFocus={handleNativeFocus}
        ref={setNativeRef}
        required={required}
        tabIndex={-1}
        value={toNativeValue(resolvedValue)}
      >
        {placeholder !== undefined && (
          <option disabled value="">{placeholder}</option>
        )}
        {ungrouped.map(renderNativeOption)}
        {[...groups].map(([label, groupedOptions]) => (
          <optgroup key={label} label={label}>{groupedOptions.map(renderNativeOption)}</optgroup>
        ))}
      </select>
      <button data-overflow-trigger
        aria-controls={resolvedOpen ? undefined : listboxId}
        aria-describedby={ariaDescribedBy}
        aria-expanded={resolvedOpen ? undefined : false}
        aria-hidden={resolvedOpen || undefined}
        aria-haspopup="listbox"
        aria-invalid={invalid ? true : ariaInvalid}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={required || ariaRequired || undefined}
        autoFocus={!resolvedOpen && autoFocus}
        className={styles.trigger}
        data-openbitfun-part="trigger"
        data-openbitfun-preview-state={typeof previewState === "string" ? previewState : undefined}
        disabled={disabled}
        id={resolvedOpen ? undefined : id}
        onClick={() => updateOpen(true)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        role={resolvedOpen ? undefined : "combobox"}
        style={style}
        tabIndex={resolvedOpen ? -1 : tabIndex}
        title={title}
        type="button"
      >
        {/* Keep the in-flow anchor intact while its portalled header is visible. */}
        {renderTriggerContent()}
      </button>
      {popup && (
        <Portal ownerDocument={triggerRef.current?.ownerDocument}>
          {popup}
        </Portal>
      )}
    </span>
  );
});
