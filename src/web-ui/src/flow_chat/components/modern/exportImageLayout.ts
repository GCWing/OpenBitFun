/** Read the initiating transcript column, not the full chat pane (or a hidden
 * sibling session). Its inherited variables include pane-local typography. */
export function readExportImageLayout(turnId: string, trigger: HTMLElement | null) {
  const triggerRow = trigger?.closest<HTMLElement>('.virtual-item-wrapper');
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.virtual-item-wrapper'));
  const column = [triggerRow, ...rows].find(row => (
    row?.dataset.turnId === turnId && row.getBoundingClientRect().width > 0
  ));
  const source = column ?? document.documentElement;
  const computedStyle = getComputedStyle(source);
  const variables: Record<string, string> = {};
  for (const name of Array.from(computedStyle)) {
    if (name.startsWith('--')) {
      const value = computedStyle.getPropertyValue(name).trim();
      if (value) variables[name] = value;
    }
  }
  return { width: column?.getBoundingClientRect().width, variables };
}
