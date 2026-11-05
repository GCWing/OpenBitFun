import type { GenUIHtmlFrameReport } from './GenUIHtmlDocument';

/** Geometry checks require a live browser layout engine. Zero geometry is
 * unsupported evidence, never a pass (including jsdom). */
/**
 * Validate metrics collected by a host-owned probe inside an opaque HTML
 * document. The parent cannot read an opaque-origin frame directly, so the
 * probe reports only bounded geometry and visibility facts; this function
 * turns those facts into the same design-spec diagnostics as component DOM.
 */
export function inspectGenUIHtmlFrame(report: GenUIHtmlFrameReport, specification?: { viewport: { mode: string; width?: number; height?: number }; shell: { statusBarHeight?: number; contentInsets: { top: number; right: number; bottom: number; left: number } }; acceptance: { checks: string[] } }): string[] {
  const issues: string[] = [];
  const finite = ['viewportWidth', 'viewportHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight', 'visibleElementCount'] as const;
  if (finite.some(key => !Number.isFinite(report[key]))) return ['HTML document inspection returned invalid geometry'];
  if (report.viewportWidth <= 0 || report.viewportHeight <= 0 || report.clientWidth <= 0 || report.clientHeight <= 0) issues.push('HTML document did not produce measurable content geometry');
  if (report.visibleElementCount <= 0 || !report.contentBounds) issues.push('HTML document has no visible rendered content');
  if (specification?.acceptance.checks.includes('no-horizontal-overflow') && report.scrollWidth > report.clientWidth + 1) issues.push('HTML document overflows horizontally inside the target viewport');
  if (specification?.acceptance.checks.includes('content-boundary') && report.contentBounds) {
    const { left, right, top, bottom } = report.contentBounds;
    const insets = specification.shell.contentInsets;
    const expectedWidth = specification.viewport.mode === 'fixed' && specification.viewport.width
      ? specification.viewport.width - insets.left - insets.right
      : report.clientWidth;
    const expectedHeight = specification.viewport.mode === 'fixed' && specification.viewport.height
      ? specification.viewport.height - (specification.shell.statusBarHeight ?? 0) - insets.top - insets.bottom
      : report.clientHeight;
    if (left < -1 || right > report.clientWidth + 1) issues.push('HTML document content exceeds the iframe width');
    if (top < -1 || (Number.isFinite(expectedHeight) && bottom > expectedHeight + 1 && report.scrollHeight <= report.clientHeight + 1)) issues.push('HTML document content exceeds the target screen bounds');
    if (specification.viewport.mode === 'fixed' && Math.abs(report.clientWidth - expectedWidth) > 1) issues.push(`HTML document content viewport is ${Math.round(report.clientWidth)}px; expected ${Math.round(expectedWidth)}px`);
  }
  return issues;
}

export function inspectGenUILayout(container: HTMLElement, specification?: { viewport: { mode: string; width?: number; height?: number }; shell: { kind: string; statusBarHeight?: number; hostOwnedParts: string[]; forbiddenContentSelectors?: string[]; contentInsets: { top: number; right: number; bottom: number; left: number } }; acceptance: { checks: string[] } }): string[] {
  const viewport = container.matches('[data-gen-ui-viewport]') ? container : container.querySelector<HTMLElement>('[data-gen-ui-viewport]') ?? container;
  const bounds = viewport.getBoundingClientRect();
  if (!viewport.isConnected || bounds.width <= 0 || bounds.height <= 0) return ['Host layout engine did not produce measurable candidate geometry'];
  const issues: string[] = [];
  const hostStyle = viewport.ownerDocument.defaultView!.getComputedStyle(viewport);
  for (const token of ['--openbitfun-control-height-md', '--openbitfun-type-body-md-font-size', '--openbitfun-radius-md']) {
    if (!hostStyle.getPropertyValue(token).trim()) issues.push('Host design-system token is unavailable: ' + token);
  }
  if (viewport.scrollWidth > viewport.clientWidth + 1) issues.push('Candidate overflows the host width');
  const screenContent = viewport.querySelector<HTMLElement>('[data-gen-ui-content]');
  if (screenContent && specification?.acceptance.checks.includes('no-horizontal-overflow') && screenContent.scrollWidth > screenContent.clientWidth + 1) issues.push('Screen content overflows horizontally inside the target viewport');
  if (specification?.viewport.mode === 'fixed') {
    if (Math.round(bounds.width) !== specification.viewport.width) issues.push(`Viewport width is ${Math.round(bounds.width)}px; expected ${specification.viewport.width}px`);
    if (Math.round(bounds.height) !== specification.viewport.height) issues.push(`Viewport height is ${Math.round(bounds.height)}px; expected ${specification.viewport.height}px`);
  }
  if (specification?.acceptance.checks.includes('host-shell')) {
    const shell = viewport.closest<HTMLElement>('[data-gen-ui-host-shell]');
    if (!shell || shell.dataset.genUiHostShell !== specification.shell.kind) issues.push('Required host shell is missing: ' + specification.shell.kind);
    else for (const part of specification.shell.hostOwnedParts) if (shell.dataset.genUiHostPart !== part && !shell.querySelector(`[data-gen-ui-host-part="${part}"]`)) issues.push('Host shell part is missing: ' + part);
    const statusBar = shell?.querySelector<HTMLElement>('[data-gen-ui-host-part="status-bar"]');
    if (statusBar && Math.round(statusBar.getBoundingClientRect().height) !== specification.shell.statusBarHeight) issues.push(`Host status bar is not ${specification.shell.statusBarHeight}px high`);
  }
  if (screenContent && specification?.acceptance.checks.includes('host-shell-duplication')) {
    for (const selector of specification.shell.forbiddenContentSelectors ?? []) {
      try { if (screenContent.querySelector(selector)) issues.push('Generated screen content duplicates host-owned shell part: ' + selector); }
      catch { issues.push('Invalid host-owned content selector in UI specification: ' + selector); }
    }
  }
  const insets = specification?.shell.contentInsets;
  const inner = { left: bounds.left + (insets?.left ?? 0), right: bounds.right - (insets?.right ?? 0), top: bounds.top + (specification?.shell.statusBarHeight ?? 0) + (insets?.top ?? 0), bottom: bounds.bottom - (insets?.bottom ?? 0) };
  for (const node of viewport.querySelectorAll<HTMLElement>('[data-gen-ui-node]')) {
    // Empty layout/repeated containers are legitimate empty states. Inspect
    // actual content and controls; an empty list need not manufacture pixels.
    if (!node.textContent?.trim() && !node.querySelector('input,select,button,img,svg,canvas')) continue;
    const rect = node.getBoundingClientRect();
    const style = node.ownerDocument.defaultView!.getComputedStyle(node);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') issues.push(node.dataset.genUiNode + ': rendered node is not visible');
    else if (rect.left < inner.left - 1 || rect.right > inner.right + 1) issues.push(node.dataset.genUiNode + ': rendered node exceeds design-spec content bounds');
  }
  if (screenContent && specification?.acceptance.checks.includes('content-boundary')) {
    const content = screenContent;
    const contentStyle = content.ownerDocument.defaultView!.getComputedStyle(content);
    const left = parseFloat(contentStyle.paddingLeft) || 0;
    const right = parseFloat(contentStyle.paddingRight) || 0;
    // clientWidth excludes a classic vertical scrollbar. Comparing the
    // resulting inner widths therefore rejects a valid phone screen whenever
    // the generated content is taller than the fixed viewport. The contract
    // owns the inset values; node bounds and overflow checks above own the
    // usable width.
    if (Math.abs(left - specification.shell.contentInsets.left) > 1 || Math.abs(right - specification.shell.contentInsets.right) > 1) issues.push(`Screen content must use ${specification.shell.contentInsets.left}px left and ${specification.shell.contentInsets.right}px right insets`);
  }
  return issues;
}
