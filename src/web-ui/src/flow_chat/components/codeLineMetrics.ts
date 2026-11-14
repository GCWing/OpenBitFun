/**
 * Resolve the source line box to pixels before feeding it to the virtualizer.
 *
 * `line-height` is a unitless design token (`1.52` in the code role). The
 * computed style keeps that value unitless, while the virtualizer's offsets
 * are pixels. Treating the result of `parseFloat` as pixels makes every later
 * decoration row drift farther from the native text row.
 */
export function readLineHeight(source: HTMLElement): number | null {
  const computed = getComputedStyle(source);
  const rawLineHeight = computed.lineHeight.trim();
  const value = Number.parseFloat(rawLineHeight);
  if (!Number.isFinite(value) || value <= 0) return null;

  if (rawLineHeight.endsWith('px')) return value;

  const fontSize = Number.parseFloat(computed.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? value * fontSize : null;
}

export function getVisibleCodeLineCount(splitLineCount: number, hasTrailingNewline: boolean): number {
  return Math.max(1, splitLineCount - (hasTrailingNewline ? 1 : 0));
}
