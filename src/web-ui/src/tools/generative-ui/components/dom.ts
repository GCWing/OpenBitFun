/** A component's inspection must not read fields owned by a child in a slot. */
export function ownElement<T extends Element = HTMLElement>(root: HTMLElement, selector: string): T | undefined {
  return Array.from(root.querySelectorAll<T>(selector)).find(element => element.closest('[data-gen-ui-node]') === root);
}
