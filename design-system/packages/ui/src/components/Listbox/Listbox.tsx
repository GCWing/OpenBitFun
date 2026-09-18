import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type FocusEventHandler,
  type ForwardedRef,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";
import { Icon } from "../Icon";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import { ScrollArea, type ScrollbarVisibility } from "../ScrollArea";
import styles from "./Listbox.module.css";

export type ListboxValue = string | number;

export interface ListboxProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "role"> {
  autoFocusOption?: boolean;
  children: ReactNode;
  focusMode?: "roving" | "virtual";
  multiple?: boolean;
  scrollbarVisibility?: ScrollbarVisibility;
}

export interface ListboxOptionProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "value"> {
  active?: boolean;
  children: ReactNode;
  description?: ReactNode;
  indicator?: ReactNode;
  leading?: ReactNode;
  metadata?: ReactNode;
  selected?: boolean;
  value?: ListboxValue;
}

export interface ListboxGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "role"> {
  children: ReactNode;
  label?: ReactNode;
}

export type ListboxEmptyProps = HTMLAttributes<HTMLDivElement>;

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function getEnabledOptions(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-openbitfun-listbox-option]"),
  ).filter((option) => (
    option.closest('[role="listbox"]') === root
    && !option.disabled
    && option.getAttribute("aria-disabled") !== "true"
  ));
}

function closestListboxOption(target: EventTarget | null) {
  return target && typeof (target as Element).closest === "function"
    ? (target as Element).closest<HTMLButtonElement>("[data-openbitfun-listbox-option]")
    : null;
}

function setFocusedOption(
  options: readonly HTMLButtonElement[],
  index: number,
  focus = true,
) {
  const target = options[index];
  if (!target) return;
  options.forEach((option, optionIndex) => {
    option.tabIndex = optionIndex === index ? 0 : -1;
  });
  if (focus) {
    target.focus();
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
}

export const Listbox = forwardRef<HTMLDivElement, ListboxProps>(function Listbox({
  autoFocusOption = false,
  children,
  className,
  focusMode = "roving",
  multiple = false,
  onFocusCapture,
  onKeyDown,
  scrollbarVisibility = "auto",
  ...props
}, forwardedRef) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasAutoFocusedRef = useRef(false);
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    assignRef(forwardedRef, node);
  }, [forwardedRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const options = getEnabledOptions(root);
    if (focusMode === "virtual") {
      options.forEach(option => { option.tabIndex = -1; });
      return;
    }
    if (options.length === 0) return;
    const selectedIndex = options.findIndex(option => option.getAttribute("aria-selected") === "true");
    const tabbableIndex = options.findIndex(option => option.tabIndex === 0);
    const initialIndex = selectedIndex >= 0 ? selectedIndex : Math.max(tabbableIndex, 0);
    setFocusedOption(options, initialIndex, false);
    if (autoFocusOption && !hasAutoFocusedRef.current) {
      hasAutoFocusedRef.current = true;
      setFocusedOption(options, initialIndex);
    }
  }, [autoFocusOption, children, focusMode]);

  const handleFocusCapture: FocusEventHandler<HTMLDivElement> = (event) => {
    onFocusCapture?.(event);
    if (event.defaultPrevented || focusMode === "virtual") return;
    const target = closestListboxOption(event.target);
    if (!target || !event.currentTarget.contains(target)) return;
    const options = getEnabledOptions(event.currentTarget);
    const index = options.indexOf(target);
    if (index >= 0) setFocusedOption(options, index, false);
  };

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || focusMode === "virtual") return;
    const target = closestListboxOption(event.target);
    if (!target || !event.currentTarget.contains(target)) return;
    const options = getEnabledOptions(event.currentTarget);
    const currentIndex = options.indexOf(target);
    if (currentIndex < 0 || options.length === 0) return;

    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % options.length;
        break;
      case "ArrowUp":
        nextIndex = (currentIndex - 1 + options.length) % options.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = options.length - 1;
        break;
      default:
        if (
          event.key.length === 1
          && !event.altKey
          && !event.ctrlKey
          && !event.metaKey
        ) {
          const query = event.key.toLocaleLowerCase();
          for (let offset = 1; offset <= options.length; offset += 1) {
            const candidateIndex = (currentIndex + offset) % options.length;
            const label = options[candidateIndex]?.textContent?.trim().toLocaleLowerCase() ?? "";
            if (label.startsWith(query)) {
              nextIndex = candidateIndex;
              break;
            }
          }
        }
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      setFocusedOption(options, nextIndex);
    }
  };

  return (
    <div
      {...props}
      aria-multiselectable={multiple || undefined}
      className={classNames(styles.root, className)}
      data-openbitfun-component="listbox"
      data-openbitfun-focus-mode={focusMode}
      data-openbitfun-multiple={multiple ? "true" : "false"}
      onFocusCapture={handleFocusCapture}
      onKeyDown={handleKeyDown}
      ref={setRootRef}
      role="listbox"
    >
      <ScrollArea
        className={styles.viewport}
        orientation="vertical"
        scrollbarVisibility={scrollbarVisibility}
      >
        <div className={styles.list} data-openbitfun-part="list">{children}</div>
      </ScrollArea>
    </div>
  );
});

export const ListboxOption = forwardRef<HTMLButtonElement, ListboxOptionProps>(
  function ListboxOption({
    active = false,
    children,
    className,
    description,
    disabled = false,
    indicator,
    leading,
    metadata,
    selected = false,
    tabIndex = -1,
    title,
    value,
    ...props
  }, ref) {
    return (
      <button data-overflow-trigger
        {...props}
        aria-disabled={disabled || undefined}
        aria-selected={selected}
        className={classNames(styles.option, className)}
        data-active={active ? "true" : "false"}
        data-overflow-active={active ? "true" : undefined}
        data-openbitfun-listbox-option=""
        data-openbitfun-part="option"
        data-selected={selected ? "true" : "false"}
        data-value={value}
        disabled={disabled}
        ref={ref}
        role="option"
        tabIndex={tabIndex}
        title={title}
        type="button"
      >
        {leading !== undefined && leading !== null && (
          <span aria-hidden="true" className={styles.leading} data-openbitfun-icon-slot="true" data-openbitfun-part="leading">
            {leading}
          </span>
        )}
        <span className={styles.content} data-openbitfun-part="content">
          <OverflowText title={title === "" ? "" : undefined} className={styles.label} data-openbitfun-part="label" marqueeActive={active}>{children}</OverflowText>
          {description !== undefined && description !== null && (
            <span className={styles.description} data-openbitfun-part="description">
              {description}
            </span>
          )}
        </span>
        {metadata !== undefined && metadata !== null && (
          <OverflowText title={title === "" ? "" : undefined} className={styles.metadata} data-openbitfun-part="metadata" marqueeActive={active}>{metadata}</OverflowText>
        )}
        <span aria-hidden="true" className={styles.indicator} data-openbitfun-icon-slot="true" data-openbitfun-part="indicator">
          {indicator ?? (selected ? <Icon name="check-line" /> : null)}
        </span>
      </button>
    );
  },
);

export const ListboxGroup = forwardRef<HTMLDivElement, ListboxGroupProps>(
  function ListboxGroup({ children, className, label, ...props }, ref) {
    const generatedLabelId = useId();
    const labelId = label === undefined || label === null ? undefined : generatedLabelId;
    return (
      <div
        {...props}
        aria-labelledby={labelId}
        className={classNames(styles.group, className)}
        data-openbitfun-part="group"
        ref={ref}
        role="group"
      >
        {labelId && (
          <div className={styles.groupLabel} data-openbitfun-part="group-label" id={labelId}>
            {label}
          </div>
        )}
        <div className={styles.groupOptions} data-openbitfun-part="group-options">{children}</div>
      </div>
    );
  },
);

export const ListboxEmpty = forwardRef<HTMLDivElement, ListboxEmptyProps>(
  function ListboxEmpty({ className, ...props }, ref) {
    return (
      <div
        {...props}
        className={classNames(styles.empty, className)}
        data-openbitfun-part="empty"
        ref={ref}
        role="status"
      />
    );
  },
);
