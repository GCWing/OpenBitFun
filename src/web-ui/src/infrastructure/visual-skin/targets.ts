/** One ownership rule for decoration CSS and projection diagnostics. */
const OWNER_SELECTOR = '[data-openbitfun-component],[data-openbitfun-product-component],[data-openbitfun-scene],[data-openbitfun-surface]';
export const SKIN_NODE_ATTRIBUTE = 'data-openbitfun-skin-node';
const nodeIds = new WeakMap<Element, string>();
let nextNodeId = 0;

export function ownedParts(owner: Element, part: string): Element[] {
  const selector = `:is([data-openbitfun-part="${part}"],[data-openbitfun-product-part="${part}"])`;
  const implicitRoot = part === 'root' && !owner.hasAttribute('data-openbitfun-part') && !owner.hasAttribute('data-openbitfun-product-part');
  return [owner, ...owner.querySelectorAll(selector)].filter(node =>
    node.getAttribute('data-openbitfun-paint-layer') !== 'none' &&
    (node.matches(selector) || (node === owner && implicitRoot)) && (node === owner || node.closest(OWNER_SELECTOR) === owner));
}

/** A part inherits interaction state only within its own component boundary. */
export function partStateAnchors(owner: Element, node: Element): Element[] {
  const anchors: Element[] = [];
  for (let current: Element | null = node; current; current = current.parentElement) {
    if (current === owner || current.hasAttribute('data-openbitfun-part') || current.hasAttribute('data-openbitfun-product-part')) anchors.push(current);
    if (current === owner) break;
    // A tab/menu row owns its own pointer/focus/selection state. Hovering the
    // surrounding group must not paint every sibling control as hovered.
    if (current.matches('button,input,select,textarea,a[href],[role="tab"],[role="option"],[role="menuitem"],[role="button"]')) break;
  }
  return anchors;
}

export function skinNodeSelector(node: Element): string {
  let id = nodeIds.get(node);
  if (!id) { id = String(nextNodeId++); nodeIds.set(node, id); }
  if (node.getAttribute(SKIN_NODE_ATTRIBUTE) !== id) node.setAttribute(SKIN_NODE_ATTRIBUTE, id);
  return `[${SKIN_NODE_ATTRIBUTE}="${id}"]`;
}
