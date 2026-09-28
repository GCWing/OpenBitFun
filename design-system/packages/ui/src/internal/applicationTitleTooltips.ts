export interface TitleTooltipTarget {
  element: HTMLElement;
  text: string;
}

interface SuppressedTitle {
  text: string;
  accessibleAttribute?: "aria-label" | "aria-description";
}

const TOOLTIP_OWNER = '[data-openbitfun-tooltip-trigger], [role="tooltip"]';

/**
 * Route legacy HTML titles through the application tooltip while interacting.
 * Only the hovered/focused ancestor chains are observed; no document scan or
 * observer over streaming transcript content is needed. Restore the original
 * attributes on leave, so React and non-React controls retain their own state.
 */
export function subscribeApplicationTitleTooltips(
  ownerDocument: Document,
  onTargetChange: (target: TitleTooltipTarget | null) => void,
): () => void {
  const view = ownerDocument.defaultView;
  if (!view) return () => {};
  const suppressed = new Map<HTMLElement, SuppressedTitle>();
  let hovered: Element | null = null;
  let focused: Element | null = ownerDocument.activeElement;
  let preferFocus = true;

  const asElement = (target: EventTarget | null): Element | null =>
    target instanceof view.Element ? target : null;

  const pathOf = (target: Element | null): HTMLElement[] => {
    const path: HTMLElement[] = [];
    for (let element = target?.isConnected ? target : null; element; element = element.parentElement) {
      if (element instanceof view.HTMLElement) path.push(element);
    }
    return path;
  };

  const restoreAccessibility = (element: HTMLElement, entry: SuppressedTitle) => {
    if (entry.accessibleAttribute && element.getAttribute(entry.accessibleAttribute) === entry.text) {
      element.removeAttribute(entry.accessibleAttribute);
    }
    entry.accessibleAttribute = undefined;
  };

  const restore = (element: HTMLElement, entry: SuppressedTitle) => {
    if (element.getAttribute("title") === "") element.setAttribute("title", entry.text);
    restoreAccessibility(element, entry);
    suppressed.delete(element);
  };

  const suppress = (element: HTMLElement) => {
    // An iframe title names its separate browsing context for assistive technology.
    if (element.localName === "iframe" || !element.hasAttribute("title")) return;
    let entry = suppressed.get(element);
    if (!entry) {
      entry = { text: element.getAttribute("title")! };
      suppressed.set(element, entry);
    }
    if (!entry.text) return;
    if (!entry.accessibleAttribute && !element.hasAttribute("aria-label") && !element.hasAttribute("aria-labelledby")
      && !element.textContent?.trim() && element.matches('button, a, input, [role="button"]')
      && !(element as HTMLInputElement).labels?.length) {
      entry.accessibleAttribute = "aria-label";
    } else if (!entry.accessibleAttribute && !element.hasAttribute("aria-description") && !element.hasAttribute("aria-describedby")) {
      entry.accessibleAttribute = "aria-description";
    }
    if (entry.accessibleAttribute && !element.hasAttribute(entry.accessibleAttribute)) {
      element.setAttribute(entry.accessibleAttribute, entry.text);
    }
    // Empty also blocks native title inheritance from ancestors.
    element.setAttribute("title", "");
  };

  const targetFrom = (path: HTMLElement[]): TitleTooltipTarget | null | undefined => {
    if (path.some(element => element.matches(TOOLTIP_OWNER))) return null;
    for (const element of path) {
      const entry = suppressed.get(element);
      // An authored empty title explicitly opts out of inherited descriptions.
      if (entry) return entry.text ? { element, text: entry.text } : null;
    }
    return undefined;
  };

  const refresh = (records: MutationRecord[] = []) => {
    const changedTitles = new Set([...records, ...observer.takeRecords()]
      .filter(record => record.type === "attributes" && record.attributeName === "title")
      .map(record => record.target));
    observer.disconnect();
    // Read consumer updates before restoring or suppressing another frame.
    for (const [element, entry] of suppressed) {
      if (!changedTitles.has(element) && element.getAttribute("title") === "") continue;
      const text = element.getAttribute("title");
      restoreAccessibility(element, entry);
      if (text === null) suppressed.delete(element);
      else entry.text = text;
    }
    const hoverPath = pathOf(hovered);
    const focusPath = pathOf(focused);
    const active = new Set([...hoverPath, ...focusPath]);
    for (const [element, entry] of suppressed) {
      if (!active.has(element)) restore(element, entry);
    }
    for (const element of active) {
      suppress(element);
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["title", "data-openbitfun-tooltip-trigger"],
        childList: true,
      });
    }
    const primary = targetFrom(preferFocus ? focusPath : hoverPath);
    const secondary = targetFrom(preferFocus ? hoverPath : focusPath);
    onTargetChange(primary === undefined ? secondary ?? null : primary);
  };
  const observer = new view.MutationObserver(refresh);
  const onMouseOver = (event: MouseEvent) => { hovered = asElement(event.target); preferFocus = false; refresh(); };
  const onMouseOut = (event: MouseEvent) => { hovered = asElement(event.relatedTarget); preferFocus = false; refresh(); };
  const onFocusIn = (event: FocusEvent) => { focused = asElement(event.target); preferFocus = true; refresh(); };
  const onFocusOut = (event: FocusEvent) => { focused = asElement(event.relatedTarget); preferFocus = true; refresh(); };
  ownerDocument.addEventListener("mouseover", onMouseOver, true);
  ownerDocument.addEventListener("mouseout", onMouseOut, true);
  ownerDocument.addEventListener("focusin", onFocusIn, true);
  ownerDocument.addEventListener("focusout", onFocusOut, true);
  refresh();

  return () => {
    // Apply a pending React title update before releasing ownership.
    hovered = focused = null;
    refresh();
    observer.disconnect();
    ownerDocument.removeEventListener("mouseover", onMouseOver, true);
    ownerDocument.removeEventListener("mouseout", onMouseOut, true);
    ownerDocument.removeEventListener("focusin", onFocusIn, true);
    ownerDocument.removeEventListener("focusout", onFocusOut, true);
  };
}
