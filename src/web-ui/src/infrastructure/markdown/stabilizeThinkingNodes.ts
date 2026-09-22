import type { ParsedNode } from 'stream-markdown-parser';

// Parser output is an acyclic tree of plain records and arrays. Compare the
// complete tree: identical raw Markdown can resolve to different links/images
// when a later reference definition arrives. Unknown non-plain values are not
// reusable unless they already share identity.
function sameParsedValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (previous === null || next === null || typeof previous !== 'object' || typeof next !== 'object') return false;
  if (Array.isArray(previous)) {
    return Array.isArray(next) && previous.length === next.length
      && previous.every((value, index) => sameParsedValue(value, next[index]));
  }
  if (Array.isArray(next)) return false;
  const prototype = Object.getPrototypeOf(previous);
  if (prototype !== Object.getPrototypeOf(next) || (prototype !== Object.prototype && prototype !== null)) return false;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(after, key) && sameParsedValue(before[key], after[key]));
}

/** Preserve settled block identities even when the parser falls back to fresh ASTs. */
export function stabilizeThinkingNodes(next: ParsedNode[], previous: ParsedNode[]): ParsedNode[] {
  if (!previous.length) return next;
  let unchanged = next.length === previous.length;
  const stabilized = next.map((node, index) => {
    const old = previous[index];
    // Quickly reject the growing tail before walking its children.
    if (old && old.type === node.type && old.raw === node.raw && sameParsedValue(old, node)) return old;
    unchanged = false;
    return node;
  });
  return unchanged ? previous : stabilized;
}
