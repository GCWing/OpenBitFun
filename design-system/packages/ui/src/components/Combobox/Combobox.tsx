import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { Icon } from "../Icon";
import { classNames } from "../../internal/classNames";
import { OverflowText } from "../../primitives/OverflowText";
import { useFieldSurface } from "../../internal/fieldSurface";
import { useAnchoredLayer, type LayerPlacement } from "../../internal/useAnchoredLayer";
import { Portal } from "../../overlay/Portal";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import { useDismissibleLayer } from "../../overlay/useDismissibleLayer";
import { IconButton } from "../IconButton";
import {
  Listbox,
  ListboxEmpty,
  ListboxGroup,
  ListboxOption,
  type ListboxValue,
} from "../Listbox";
import { SearchField } from "../SearchField";
import styles from "./Combobox.module.css";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type ComboboxValue = ListboxValue;
export type ComboboxSize = "sm" | "md" | "lg";
export type ComboboxPlacement = Extract<LayerPlacement, "top" | "bottom">;

export interface ComboboxOption {
  description?: ReactNode;
  disabled?: boolean;
  group?: string;
  label: string;
  leading?: ReactNode;
  metadata?: ReactNode;
  testId?: string;
  value: ComboboxValue;
}

interface PickerCommonProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "defaultValue" | "onChange"> {
  clearable?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  errorMessage?: ReactNode;
  filterOption?: (option: ComboboxOption, query: string) => boolean;
  invalid?: boolean;
  label?: ReactNode;
  loading?: boolean;
  onCreateValue?: (input: string) => ComboboxValue | void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  options?: readonly ComboboxOption[];
  placement?: ComboboxPlacement;
  placeholder?: ReactNode;
  required?: boolean;
  size?: ComboboxSize;
}

export interface ComboboxProps extends PickerCommonProps {
  defaultValue?: ComboboxValue;
  onValueChange?: (value: ComboboxValue) => void;
  value?: ComboboxValue;
}

export interface MultiSelectProps extends PickerCommonProps {
  defaultValue?: readonly ComboboxValue[];
  maxVisibleTags?: number;
  onValueChange?: (value: ComboboxValue[]) => void;
  showSelectAll?: boolean;
  value?: readonly ComboboxValue[];
}

type PickerProps =
  | ({ mode: "single" } & ComboboxProps)
  | ({ mode: "multiple" } & MultiSelectProps);

type NavigationItem =
  | { kind: "all" }
  | { kind: "create"; value: string }
  | { kind: "option"; option: ComboboxOption };

function isImeOwnedKeyboardEvent(event: ReactKeyboardEvent) {
  const nativeEvent = event.nativeEvent as KeyboardEvent;
  return nativeEvent.isComposing || nativeEvent.keyCode === 229;
}

function optionMatches(option: ComboboxOption, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return option.label.toLocaleLowerCase().includes(normalizedQuery)
    || String(option.value).toLocaleLowerCase().includes(normalizedQuery)
    || (typeof option.description === "string"
      && option.description.toLocaleLowerCase().includes(normalizedQuery));
}

function firstEnabledIndex(items: readonly NavigationItem[], direction: 1 | -1) {
  if (items.length === 0) return -1;
  let index = direction === 1 ? 0 : items.length - 1;
  while (index >= 0 && index < items.length) {
    const item = items[index];
    if (item?.kind !== "option" || !item.option.disabled) return index;
    index += direction;
  }
  return -1;
}

const CollectionPicker = forwardRef<HTMLDivElement, PickerProps>(function CollectionPicker(
  pickerProps,
  forwardedRef,
) {
  const { mode } = pickerProps;
  const fieldSurface = useFieldSurface();
  const props = pickerProps as ComboboxProps | MultiSelectProps;
  const {
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    className,
    clearable = false,
    defaultOpen = false,
    disabled = false,
    errorMessage,
    filterOption = optionMatches,
    id: providedId,
    invalid: invalidProp = false,
    label,
    loading = false,
    onCreateValue,
    onOpenChange,
    open,
    options: optionsProp = [],
    placement = "bottom",
    placeholder: placeholderProp,
    required = false,
    size = "md",
    ...rootProps
  } = props;
  delete (rootProps as Record<string, unknown>).defaultValue;
  delete (rootProps as Record<string, unknown>).onValueChange;
  delete (rootProps as Record<string, unknown>).value;
  delete (rootProps as Record<string, unknown>).maxVisibleTags;
  delete (rootProps as Record<string, unknown>).showSelectAll;
  const divProps = rootProps as HTMLAttributes<HTMLDivElement>;

  const designSystem = useDesignSystem();
  const multiple = mode === "multiple";
  const defaultValue = props.defaultValue;
  const controlledValue = props.value;
  const onValueChange = props.onValueChange;
  const maxVisibleTags = multiple
    ? (props as MultiSelectProps).maxVisibleTags ?? 3
    : 0;
  const showSelectAll = multiple
    && ((props as MultiSelectProps).showSelectAll ?? false);
  const placeholder = placeholderProp ?? designSystem.messages.selectPlaceholder;
  const options = optionsProp;
  const generatedId = useId();
  const id = providedId ?? `openbitfun-${multiple ? "multi-select" : "combobox"}-${generatedId}`;
  const labelId = `${id}-label`;
  const listboxId = `${id}-listbox`;
  const errorId = `${id}-error`;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen && !disabled);
  const [uncontrolledValues, setUncontrolledValues] = useState<ComboboxValue[]>(() => {
    if (multiple) {
      const values = defaultValue as readonly ComboboxValue[] | undefined;
      return values ? [...values] : [];
    }
    const value = defaultValue as ComboboxValue | undefined;
    return value === undefined || value === "" ? [] : [value];
  });
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const restoreFocusAfterCloseRef = useRef(false);
  const dismissibleBranches = useMemo(() => [rootRef], []);
  const resolvedOpen = !disabled && (open ?? uncontrolledOpen);
  const selectedValues = useMemo<ComboboxValue[]>(() => {
    if (multiple) {
      const values = controlledValue as readonly ComboboxValue[] | undefined;
      return values ? [...values] : uncontrolledValues;
    }
    const value = controlledValue as ComboboxValue | undefined;
    if (value !== undefined) return value === "" ? [] : [value];
    return uncontrolledValues;
  }, [controlledValue, multiple, uncontrolledValues]);
  const invalid = invalidProp || ariaInvalid === true || ariaInvalid === "true";

  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  const updateOpen = useCallback((nextOpen: boolean) => {
    if (nextOpen === resolvedOpen) return;
    if (open === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open, resolvedOpen]);

  const closeListbox = useCallback((restoreFocus: boolean) => {
    restoreFocusAfterCloseRef.current = restoreFocus;
    updateOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }, [updateOpen]);

  const commitValues = useCallback((nextValues: ComboboxValue[]) => {
    if (controlledValue === undefined) setUncontrolledValues(nextValues);
    if (multiple) {
      (onValueChange as MultiSelectProps["onValueChange"])?.(nextValues);
    } else {
      (onValueChange as ComboboxProps["onValueChange"])?.(nextValues[0] ?? "");
    }
  }, [controlledValue, multiple, onValueChange]);

  const filteredOptions = useMemo(
    () => query.trim()
      ? options.filter((option) => filterOption(option, query))
      : [...options],
    [filterOption, options, query],
  );

  const createCandidate = useMemo(() => {
    const candidate = query.trim();
    if (!onCreateValue || !candidate) return null;
    const normalized = candidate.toLocaleLowerCase();
    const exactMatch = options.some((option) => (
      String(option.value).toLocaleLowerCase() === normalized
      || option.label.toLocaleLowerCase() === normalized
    ));
    return exactMatch ? null : candidate;
  }, [onCreateValue, options, query]);

  const navigationItems = useMemo<NavigationItem[]>(() => {
    const items: NavigationItem[] = [];
    if (showSelectAll && filteredOptions.some((option) => !option.disabled)) {
      items.push({ kind: "all" });
    }
    filteredOptions.forEach((option) => items.push({ kind: "option", option }));
    if (createCandidate) items.push({ kind: "create", value: createCandidate });
    return items;
  }, [createCandidate, filteredOptions, showSelectAll]);

  const optionId = useCallback((index: number) => `${listboxId}-option-${index}`, [listboxId]);

  const moveActive = useCallback((current: number, direction: 1 | -1) => {
    if (navigationItems.length === 0) return -1;
    let index = current;
    for (let count = 0; count < navigationItems.length; count += 1) {
      index += direction;
      if (index < 0) index = navigationItems.length - 1;
      if (index >= navigationItems.length) index = 0;
      const item = navigationItems[index];
      if (item?.kind !== "option" || !item.option.disabled) return index;
    }
    return -1;
  }, [navigationItems]);

  const selectOption = useCallback((option: ComboboxOption) => {
    if (disabled || loading || option.disabled) return;
    if (multiple) {
      commitValues(selectedValues.includes(option.value)
        ? selectedValues.filter((value) => value !== option.value)
        : [...selectedValues, option.value]);
      return;
    }
    commitValues([option.value]);
    closeListbox(true);
  }, [closeListbox, commitValues, disabled, loading, multiple, selectedValues]);

  const submitCreateValue = useCallback((candidate: string) => {
    if (!onCreateValue || disabled || loading) return;
    const createdValue = onCreateValue(candidate);
    if (createdValue === undefined) return;
    if (multiple) {
      if (!selectedValues.includes(createdValue)) {
        commitValues([...selectedValues, createdValue]);
      }
    } else {
      commitValues([createdValue]);
      closeListbox(true);
    }
    setQuery("");
  }, [closeListbox, commitValues, disabled, loading, multiple, onCreateValue, selectedValues]);

  const toggleSelectAll = useCallback(() => {
    if (!multiple || disabled || loading) return;
    const availableValues = filteredOptions
      .filter((option) => !option.disabled)
      .map((option) => option.value);
    const allSelected = availableValues.length > 0
      && availableValues.every((value) => selectedValues.includes(value));
    commitValues(allSelected
      ? selectedValues.filter((value) => !availableValues.includes(value))
      : [...new Set([...selectedValues, ...availableValues])]);
  }, [commitValues, disabled, filteredOptions, loading, multiple, selectedValues]);

  const activateItem = useCallback((index: number) => {
    const item = navigationItems[index];
    if (!item) return;
    if (item.kind === "all") toggleSelectAll();
    else if (item.kind === "create") submitCreateValue(item.value);
    else selectOption(item.option);
  }, [navigationItems, selectOption, submitCreateValue, toggleSelectAll]);

  const openListbox = useCallback((direction: 1 | -1 = 1, keyboard = false) => {
    if (disabled) return;
    restoreFocusAfterCloseRef.current = false;
    setKeyboardOpen(keyboard);
    updateOpen(true);
    if (!keyboard) {
      setActiveIndex(-1);
      return;
    }
    const selectedIndex = navigationItems.findIndex((item) => (
      item.kind === "option"
      && selectedValues.includes(item.option.value)
      && !item.option.disabled
    ));
    setActiveIndex(selectedIndex >= 0
      ? selectedIndex
      : firstEnabledIndex(navigationItems, direction));
  }, [disabled, navigationItems, selectedValues, updateOpen]);

  const handleTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!resolvedOpen) openListbox(event.key === "ArrowDown" ? 1 : -1, true);
      else setActiveIndex((current) => moveActive(current, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" && resolvedOpen) {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(navigationItems, 1));
      return;
    }
    if (event.key === "End" && resolvedOpen) {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(navigationItems, -1));
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!resolvedOpen) openListbox(1, true);
      else if (activeIndex >= 0) activateItem(activeIndex);
    }
  }, [activateItem, activeIndex, disabled, moveActive, navigationItems, openListbox, resolvedOpen]);

  const handleSearchKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && isImeOwnedKeyboardEvent(event)) {
      event.stopPropagation();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) => moveActive(current, event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex(firstEnabledIndex(navigationItems, event.key === "Home" ? 1 : -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (activeIndex >= 0) activateItem(activeIndex);
      else if (createCandidate) submitCreateValue(createCandidate);
      return;
    }
    if (event.key === "Tab") {
      const candidate = query.trim();
      const exactOption = candidate
        ? options.find((option) => (
            String(option.value).toLocaleLowerCase() === candidate.toLocaleLowerCase()
            || option.label.toLocaleLowerCase() === candidate.toLocaleLowerCase()
          ))
        : undefined;
      // Restore the in-flow trigger before native Tab/Shift+Tab traversal.
      // Otherwise removing the focused portal input loses the field's tab position.
      flushSync(() => {
        if (exactOption && !exactOption.disabled) selectOption(exactOption);
        else if (createCandidate) submitCreateValue(createCandidate);
        closeListbox(true);
      });
    }
  }, [activateItem, activeIndex, closeListbox, createCandidate, moveActive, navigationItems, options, query, selectOption, submitCreateValue]);

  useDismissibleLayer({
    branchRefs: dismissibleBranches,
    enabled: resolvedOpen,
    layerRef: popoverRef,
    onDismiss: (reason) => closeListbox(reason === "escape-key"),
    ownerDocument: rootRef.current?.ownerDocument,
  });

  const layout = useAnchoredLayer({
    open: resolvedOpen,
    anchorRef: triggerRef,
    layerRef: popoverRef,
    placement,
    matchWidth: true,
    overlapAnchor: true,
    revision: `${query}:${filteredOptions.length}:${loading}`,
  });

  const positioned = layout !== null;
  useIsomorphicLayoutEffect(() => {
    if (resolvedOpen) {
      if (positioned) searchRef.current?.focus({ preventScroll: true });
    } else if (restoreFocusAfterCloseRef.current) {
      restoreFocusAfterCloseRef.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [positioned, resolvedOpen]);

  useEffect(() => {
    if (!resolvedOpen || activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, optionId, resolvedOpen]);

  const selectedOptions = useMemo<ComboboxOption[]>(() => selectedValues.map((value) => (
    options.find((option) => option.value === value)
      ?? { label: String(value), value }
  )), [options, selectedValues]);
  const hasValue = selectedValues.length > 0;
  const allFilteredSelected = filteredOptions.some((option) => !option.disabled)
    && filteredOptions
      .filter((option) => !option.disabled)
      .every((option) => selectedValues.includes(option.value));
  const groupedOptions = useMemo(() => {
    const ungrouped: ComboboxOption[] = [];
    const groups = new Map<string, ComboboxOption[]>();
    filteredOptions.forEach((option) => {
      if (!option.group) {
        ungrouped.push(option);
        return;
      }
      const group = groups.get(option.group) ?? [];
      group.push(option);
      groups.set(option.group, group);
    });
    return { groups, ungrouped };
  }, [filteredOptions]);

  const renderListboxOption = (option: ComboboxOption) => {
    const navigationIndex = navigationItems.findIndex((item) => (
      item.kind === "option" && item.option === option
    ));
    const selected = selectedValues.includes(option.value);
    return (
      <ListboxOption
        active={activeIndex === navigationIndex}
        aria-label={typeof option.description === "string"
          ? `${option.label}: ${option.description}`
          : option.label}
        description={option.description}
        disabled={option.disabled || loading}
        id={optionId(navigationIndex)}
        indicator={selected ? <Icon name="check-line" /> : null}
        key={`${typeof option.value}:${option.value}`}
        leading={option.leading}
        metadata={option.metadata}
        onClick={() => selectOption(option)}
        onMouseDown={(event) => event.preventDefault()}
        selected={selected}
        value={option.value}
        data-testid={option.testId}
      >
        {option.label}
      </ListboxOption>
    );
  };

  const activeDescendant = resolvedOpen && activeIndex >= 0
    ? optionId(activeIndex)
    : undefined;
  const resolvedTriggerLabel = ariaLabel
    ?? (label || providedId || typeof placeholder !== "string" ? undefined : placeholder);
  const resolvedLabelledBy = ariaLabel
    ? ariaLabelledBy
    : ariaLabelledBy ?? (label ? labelId : undefined);
  const resolvedDescribedBy = [
    ariaDescribedBy,
    errorMessage ? errorId : undefined,
  ].filter(Boolean).join(" ") || undefined;

  const popover = resolvedOpen ? (
    <div
      className={styles.popover}
      data-openbitfun-component={multiple ? "multi-select-popup" : "combobox-popup"}
      data-openbitfun-part="popover"
      data-openbitfun-native-webview-occlusion
      data-keyboard-open={keyboardOpen ? "true" : "false"}
      data-invalid={invalid ? "true" : "false"}
      data-placement={layout?.placement ?? placement}
      data-size={size}
      ref={popoverRef}
      style={layout?.style ?? { position: "fixed", visibility: "hidden" }}
    >
      <div className={styles.search} data-openbitfun-part="search">
        <SearchField
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={resolvedDescribedBy}
          aria-expanded={resolvedOpen}
          aria-label={resolvedTriggerLabel ?? (providedId || resolvedLabelledBy ? undefined : designSystem.messages.searchOptions)}
          aria-labelledby={resolvedLabelledBy}
          aria-required={required || undefined}
          aria-busy={loading || undefined}
          autoComplete="off"
          className={styles.searchField}
          clearLabel={query ? designSystem.messages.clearSelection : undefined}
          id={id}
          invalid={invalid}
          leadingIcon={<Icon name="search" size="sm" />}
          onClear={query
            ? () => {
                setQuery("");
                setActiveIndex(firstEnabledIndex(navigationItems, 1));
              }
            : undefined}
          onKeyDown={handleSearchKeyDown}
          onValueChange={(nextQuery) => {
            setQuery(nextQuery);
            setActiveIndex(-1);
          }}
          placeholder={designSystem.messages.searchOptions}
          ref={searchRef}
          role="combobox"
          size={size}
          value={query}
          variant="embedded"
        />
        <IconButton
          aria-label={designSystem.messages.dialogClose}
          className={styles.collapse}
          data-openbitfun-part="collapse"
          icon={<Icon name="chevron-up" />}
          onClick={() => closeListbox(true)}
          size="xs"
          variant="quiet"
        />
      </div>
      <div aria-hidden="true" className={styles.divider} data-openbitfun-part="divider" />
      <div className={styles.options} data-openbitfun-part="options">
        <Listbox
          aria-label={ariaLabel ?? (typeof label === "string" ? label : "Options")}
          className={styles.listbox}
          focusMode="virtual"
          id={listboxId}
          multiple={multiple}
        >
          {loading && filteredOptions.length === 0 ? (
            <ListboxEmpty className={styles.message}>
              <LoaderCircle aria-hidden="true" className={styles.spinner} />
              <span>{designSystem.messages.loading}</span>
            </ListboxEmpty>
          ) : navigationItems.length === 0 ? (
            <ListboxEmpty>{designSystem.messages.noOptions}</ListboxEmpty>
          ) : (
            <>
              {navigationItems[0]?.kind === "all" && (
                <ListboxOption
                  active={activeIndex === 0}
                  id={optionId(0)}
                  indicator={allFilteredSelected ? <Icon name="check-line" /> : null}
                  onClick={toggleSelectAll}
                  onMouseDown={(event) => event.preventDefault()}
                  selected={allFilteredSelected}
                >
                  {designSystem.messages.selectAll}
                </ListboxOption>
              )}
              {groupedOptions.ungrouped.map(renderListboxOption)}
              {[...groupedOptions.groups].map(([groupLabel, groupOptions]) => (
                <ListboxGroup key={groupLabel} label={groupLabel}>
                  {groupOptions.map(renderListboxOption)}
                </ListboxGroup>
              ))}
              {createCandidate && (() => {
                const createIndex = navigationItems.findIndex((item) => item.kind === "create");
                return (
                  <ListboxOption
                    active={activeIndex === createIndex}
                    id={optionId(createIndex)}
                    leading={<Icon name="plus" />}
                    onClick={() => submitCreateValue(createCandidate)}
                    onMouseDown={(event) => event.preventDefault()}
                    selected={selectedValues.includes(createCandidate)}
                    value={createCandidate}
                  >
                    {designSystem.messages.createValue}: {createCandidate}
                  </ListboxOption>
                );
              })()}
            </>
          )}
        </Listbox>
      </div>
    </div>
  ) : null;

  const singleOption = selectedOptions[0];

  return (
    <div
      {...divProps}
      className={classNames(styles.root, className)}
      data-openbitfun-component={multiple ? "multi-select" : "combobox"}
      data-disabled={disabled ? "true" : "false"}
      data-field-surface={fieldSurface}
      data-invalid={invalid ? "true" : "false"}
      data-open={resolvedOpen ? "true" : "false"}
      data-size={size}
      ref={setRootRef}
    >
      {label !== undefined && label !== null && (
        <label className={styles.visibleLabel} data-openbitfun-part="label" htmlFor={id} id={labelId}>
          {label}
        </label>
      )}
      <div
        aria-hidden={resolvedOpen || undefined}
        className={styles.control}
        data-openbitfun-part="control"
        data-tags={multiple && hasValue ? "true" : "false"}
      >
        {multiple && hasValue && (
          <span className={styles.tags} data-openbitfun-part="tags">
            {selectedOptions.slice(0, Math.max(1, maxVisibleTags)).map((option) => (
              <span className={styles.tag} data-openbitfun-part="tag" key={`${typeof option.value}:${option.value}`}>
                <OverflowText>{option.label}</OverflowText>
                <IconButton
                  aria-label={`${designSystem.messages.clearSelection}: ${option.label}`}
                  disabled={disabled}
                  icon={<Icon name="xmark" />}
                  onClick={(event) => {
                    event.stopPropagation();
                    commitValues(selectedValues.filter((value) => value !== option.value));
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  shape="circle"
                  size="xs"
                  tabIndex={resolvedOpen ? -1 : undefined}
                  variant="quiet"
                />
              </span>
            ))}
            {selectedOptions.length > Math.max(1, maxVisibleTags) && (
              <span className={styles.tag}>+{selectedOptions.length - Math.max(1, maxVisibleTags)}</span>
            )}
          </span>
        )}
        <button data-overflow-trigger
          aria-controls={resolvedOpen ? undefined : listboxId}
          aria-describedby={resolvedDescribedBy}
          aria-expanded={resolvedOpen ? undefined : false}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-label={resolvedTriggerLabel}
          aria-labelledby={resolvedLabelledBy}
          aria-required={required || undefined}
          aria-busy={loading || undefined}
          className={styles.trigger}
          data-openbitfun-part="trigger"
          disabled={disabled}
          id={resolvedOpen ? undefined : id}
          onClick={() => {
            if (resolvedOpen) closeListbox(false);
            else openListbox(1, false);
          }}
          onKeyDown={handleTriggerKeyDown}
          ref={triggerRef}
          role={resolvedOpen ? undefined : "combobox"}
          tabIndex={resolvedOpen ? -1 : undefined}
          type="button"
        >
          <span className={styles.value} data-openbitfun-part="value">
            {!hasValue ? (
              <OverflowText className={styles.placeholder}>{placeholder}</OverflowText>
            ) : multiple ? (
              <OverflowText className={styles.valueLabel}>{selectedOptions.map((option) => option.label).join(", ")}</OverflowText>
            ) : (
              <span className={styles.singleValue}>
                {singleOption?.leading && (
                  <span aria-hidden="true" className={styles.valueLeading} data-openbitfun-icon-slot="true">{singleOption.leading}</span>
                )}
                <OverflowText className={styles.valueLabel}>{singleOption?.label}</OverflowText>
              </span>
            )}
          </span>
        </button>
        {clearable && hasValue && !disabled && (
          <IconButton
            aria-label={designSystem.messages.clearSelection}
            className={styles.clear}
            icon={<Icon name="xmark" />}
            onClick={(event) => {
              event.stopPropagation();
              commitValues([]);
              setQuery("");
            }}
            size="sm"
            tabIndex={resolvedOpen ? -1 : undefined}
            variant="quiet"
          />
        )}
        <span aria-hidden="true" className={styles.indicator} data-openbitfun-icon-slot="true" data-openbitfun-part="indicator">
          <Icon name="chevron-down" />
        </span>
      </div>
      {errorMessage ? (
        <span className={styles.error} data-openbitfun-part="message" id={errorId}>
          {errorMessage}
        </span>
      ) : null}
      {popover && (
        <Portal ownerDocument={triggerRef.current?.ownerDocument} ownerRef={triggerRef} open={resolvedOpen}>
          {popover}
        </Portal>
      )}
    </div>
  );
});

export const Combobox = forwardRef<HTMLDivElement, ComboboxProps>(function Combobox(
  props,
  ref,
) {
  return <CollectionPicker {...props} mode="single" ref={ref} />;
});

export const MultiSelect = forwardRef<HTMLDivElement, MultiSelectProps>(function MultiSelect(
  props,
  ref,
) {
  return <CollectionPicker {...props} mode="multiple" ref={ref} />;
});
