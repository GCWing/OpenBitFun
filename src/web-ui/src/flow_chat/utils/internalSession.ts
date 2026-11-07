/**
 * A UI projection can present a hidden runtime session as a MiniApp or BTW
 * conversation. Reuse its runtime ownership marker for host reads and updates;
 * presentation kind alone is not the host's visibility contract.
 */
export function shouldIncludeInternalSession(
  session: { sessionKind?: string; agentBackedTransient?: boolean } | undefined,
): boolean {
  return Boolean(session?.sessionKind === 'subagent' || session?.agentBackedTransient);
}
