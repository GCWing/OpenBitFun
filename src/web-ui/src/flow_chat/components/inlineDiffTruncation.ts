const MAX_LINES = 500;
const MAX_CHARS = 50_000;

/** Bounded preview only; the owning card retains full source for the editor. */
export function truncateForDiff(original: string, modified: string) {
  const originalLines = original ? original.split('\n') : [];
  const modifiedLines = modified ? modified.split('\n') : [];
  if (originalLines.length + modifiedLines.length <= MAX_LINES && original.length + modified.length <= MAX_CHARS) {
    return { originalContent: original, modifiedContent: modified, truncated: false, omittedLines: 0 as number | null };
  }
  const slice = (lines: string[]) => {
    const halfLines = MAX_LINES / 4;
    const dropped = Math.max(0, lines.length - 2 * halfLines);
    const text = dropped ? [...lines.slice(0, halfLines), '', `... truncated ${dropped} lines ...`, '', ...lines.slice(-halfLines)].join('\n')
      : lines.join('\n');
    if (text.length <= MAX_CHARS / 2) return { text, dropped, partial: false };
    const marker = '\n…\n';
    const halfChars = Math.floor((MAX_CHARS / 2 - marker.length) / 2);
    // Retain both ends even for a single minified line; never silently discard
    // the tail a line-only budget deliberately retained.
    return { text: text.slice(0, halfChars) + marker + text.slice(-halfChars), dropped, partial: true };
  };
  const a = slice(originalLines), b = slice(modifiedLines);
  return { originalContent: a.text, modifiedContent: b.text, truncated: true,
    omittedLines: a.partial || b.partial ? null : a.dropped + b.dropped };
}
