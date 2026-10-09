import { createContext } from "react";

/** An explicit tooltip owns this subtree; text slots should not open another one. */
export const TooltipTriggerContext = createContext(false);

/** A legacy title fallback must yield to authored tooltips, not claim their trigger. */
export const TitleTooltipContext = createContext(false);

const triggerOwners = new WeakMap<HTMLElement, { count: number; previous: string | null }>();

/** Multiple overflowing text slots can share the same owning control. */
export function registerTooltipTrigger(element: HTMLElement): () => void {
  let owner = triggerOwners.get(element);
  if (!owner) {
    owner = { count: 0, previous: element.getAttribute("data-openbitfun-tooltip-trigger") };
    triggerOwners.set(element, owner);
    element.setAttribute("data-openbitfun-tooltip-trigger", "true");
  }
  owner.count++;
  return () => {
    if (--owner.count > 0) return;
    triggerOwners.delete(element);
    if (owner.previous === null) element.removeAttribute("data-openbitfun-tooltip-trigger");
    else element.setAttribute("data-openbitfun-tooltip-trigger", owner.previous);
  };
}
