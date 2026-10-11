/**
 * DOM probe helpers.
 *
 * The embedded WebDriver returns a non-W3C "no such element" payload body for
 * `findElement`, and WebdriverIO's element `isExisting()` never settles on that
 * response. Any wait whose predicate is `!element.isExisting()` therefore keeps
 * polling until it is killed by the test timeout instead of resolving.
 *
 * Every probe here runs one synchronous script in the webview and reads the DOM
 * directly, so a missing element is an ordinary `false`/`0`, and one poll costs a
 * single round trip.
 */
import { browser } from '@wdio/globals';

export interface ElementProbe {
  /** Number of matching nodes. */
  count: number;
  /** Matching nodes that occupy layout space and are not hidden. */
  visibleCount: number;
  /** `disabled` of the first match, or `null` when it has no such property. */
  disabled: boolean | null;
  /** `innerText` of the first match, or `null` when nothing matched. */
  text: string | null;
  /** `innerText` of every match, in document order. */
  texts: string[];
  /** `data-openbitfun-status` of every match, in document order. */
  statuses: string[];
  /** `data-openbitfun-state` of every match, in document order. */
  states: string[];
}

const EMPTY_PROBE: ElementProbe = {
  count: 0,
  visibleCount: 0,
  disabled: null,
  text: null,
  texts: [],
  statuses: [],
  states: [],
};

/**
 * Read count, visibility, text, and state attributes of `selector` in one call.
 *
 * The visibility test uses the same criteria a user would notice: the element
 * occupies layout space and is neither `display: none` nor `visibility: hidden`.
 * Opacity is ignored on purpose, because the app's switches keep their real
 * `<input>` at `opacity: 0` behind a visible track.
 */
export async function probeSelector(selector: string): Promise<ElementProbe> {
  const probe = await browser.execute((sel: string) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const first = nodes[0] as (HTMLElement & { disabled?: boolean }) | undefined;
    return {
      count: nodes.length,
      visibleCount: nodes.filter(isVisible).length,
      disabled: first && 'disabled' in first ? Boolean(first.disabled) : null,
      text: first ? first.innerText ?? first.textContent ?? '' : null,
      texts: nodes.map(node => (node as HTMLElement).innerText ?? node.textContent ?? ''),
      statuses: nodes.map(node => node.getAttribute('data-openbitfun-status') ?? ''),
      states: nodes.map(node => node.getAttribute('data-openbitfun-state') ?? ''),
    };
  }, selector);

  return (probe as ElementProbe) ?? EMPTY_PROBE;
}

export async function domCount(selector: string): Promise<number> {
  return (await probeSelector(selector)).count;
}

export async function domExists(selector: string): Promise<boolean> {
  return (await domCount(selector)) > 0;
}

export async function domVisibleExists(selector: string): Promise<boolean> {
  return (await probeSelector(selector)).visibleCount > 0;
}

export async function domText(selector: string): Promise<string | null> {
  return (await probeSelector(selector)).text;
}

export async function domTexts(selector: string): Promise<string[]> {
  return (await probeSelector(selector)).texts;
}

/**
 * True when a click target is usable: it is visible, exists, and is not
 * disabled. Buttons rendered disabled still occupy layout space, so the
 * `disabled` flag is what separates "clickable" from "rendered but inert".
 */
export async function domClickable(selector: string): Promise<boolean> {
  const probe = await probeSelector(selector);
  return probe.visibleCount > 0 && probe.disabled !== true;
}

/**
 * Click the first match through the DOM instead of a WebDriver pointer action.
 *
 * Nav affordances that only appear on hover (and buttons a layout pass leaves at
 * zero size) are still real, mounted elements, and React answers a dispatched
 * click on them. This is the fallback when a WebDriver click cannot land.
 *
 * @returns true when an element was found and clicked.
 */
export async function domClick(selector: string): Promise<boolean> {
  const clicked = await browser.execute((sel: string) => {
    const element = document.querySelector(sel) as HTMLElement | null;
    if (!element) {
      return false;
    }
    element.scrollIntoView({ block: 'center' });
    element.click();
    return true;
  }, selector);

  return clicked === true;
}

export default {
  probeSelector,
  domCount,
  domExists,
  domVisibleExists,
  domText,
  domTexts,
  domClickable,
  domClick,
};
