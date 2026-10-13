/**
 * Manual (drag-and-drop) session order: the ordering maths and the storage scope
 * key only.
 *
 * The left navigation moves a row and reports the resulting list of ids; the
 * session-view preference module persists that list per scope. Keeping both sides
 * on plain id arrays means the sidebar and the preference store agree on what an
 * order is without sharing storage code.
 */

export type SessionOrderingMode = 'updated' | 'status' | 'created' | 'name' | 'manual';

/** `workspace:<workspaceId>` for one workspace list, `all` for the aggregate list. */
export type ManualOrderScopeKey = string;

const AGGREGATE_SCOPE_KEY: ManualOrderScopeKey = 'all';

/**
 * Storage scope a session list writes its drag order to. A missing workspace id
 * addresses the aggregate view, which is the only list that spans workspaces.
 */
export function manualOrderScopeKey(scope: { workspaceId?: string | null }): ManualOrderScopeKey {
  const workspaceId = scope.workspaceId;
  return typeof workspaceId === 'string' && workspaceId.length > 0
    ? `workspace:${workspaceId}`
    : AGGREGATE_SCOPE_KEY;
}

/** An order never holds the same session twice: the first occurrence wins. */
function dedupeIds(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), max);
}

/**
 * Move `sessionId` to `targetIndex`, clamped to the positions the result can
 * actually hold. An id that is not listed yet is inserted at the clamped index
 * instead of being dropped. Always returns a fresh array, so the caller can write
 * the result back without touching the array it passed in.
 */
export function moveSessionInOrder(
  order: readonly string[],
  sessionId: string,
  targetIndex: number,
): string[] {
  const unique = dedupeIds(order);
  const currentIndex = unique.indexOf(sessionId);
  if (currentIndex < 0) {
    const insertIndex = clampIndex(targetIndex, unique.length);
    return [...unique.slice(0, insertIndex), sessionId, ...unique.slice(insertIndex)];
  }

  const moved = unique.slice();
  moved.splice(currentIndex, 1);
  moved.splice(clampIndex(targetIndex, moved.length), 0, sessionId);
  return moved;
}

/**
 * Drop ids that are no longer present and de-duplicate, keeping the relative
 * order of the rest. Runs after sessions were deleted or archived so the stored
 * order cannot grow without bound.
 */
export function reconcileManualOrder(
  order: readonly string[],
  presentIds: readonly string[],
): string[] {
  const present = new Set(presentIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of order) {
    if (seen.has(id) || !present.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Apply the stored order to a list of items. Items that the order does not know
 * come first and keep their incoming relative order, so a session created after
 * the last drag is visible at the top instead of being pushed to the bottom.
 * Ordered ids that no item matches are skipped.
 */
export function orderSessionsManually<T>(
  items: readonly T[],
  order: readonly string[],
  idOf: (item: T) => string,
): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });

  const unlisted: T[] = [];
  const listed: { item: T; rank: number }[] = [];
  for (const item of items) {
    const itemRank = rank.get(idOf(item));
    if (itemRank === undefined) unlisted.push(item);
    else listed.push({ item, rank: itemRank });
  }

  listed.sort((left, right) => left.rank - right.rank);
  return [...unlisted, ...listed.map(entry => entry.item)];
}
