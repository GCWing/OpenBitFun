/**
 * Process-local admission state for a user-triggered context compaction.
 *
 * The Desktop command has a bounded transport timeout while the maintenance
 * turn can keep running. Keep this state outside React/session projections so
 * a surface switch does not make a still-running compaction submit-able again.
 */

const pendingManualCompactions = new Map<string, string | undefined>();

export function markManualCompactionPending(sessionId: string, turnId?: string): void {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return;

  if (turnId || !pendingManualCompactions.has(normalizedSessionId)) {
    pendingManualCompactions.set(normalizedSessionId, turnId);
  }
}

export function isManualCompactionPending(sessionId: string): boolean {
  return pendingManualCompactions.has(sessionId.trim());
}

/** Settle only the matching turn when the backend supplies an identity. */
export function settleManualCompaction(sessionId: string, turnId?: string): void {
  const normalizedSessionId = sessionId.trim();
  const pendingTurnId = pendingManualCompactions.get(normalizedSessionId);
  if (!pendingManualCompactions.has(normalizedSessionId)) return;
  if (turnId && pendingTurnId && turnId !== pendingTurnId) return;
  pendingManualCompactions.delete(normalizedSessionId);
}

export function clearManualCompaction(sessionId: string): void {
  pendingManualCompactions.delete(sessionId.trim());
}

/** Test-only reset; no product code should clear another session's state. */
export function resetManualCompactionStateForTest(): void {
  pendingManualCompactions.clear();
}
