import type { SessionMetadataPage } from '@/infrastructure/api/service-api/SessionAPI';

/** Workspace ownership and source filtering need the entire metadata catalog,
 * including older hosts without scoped totals. No turns load. */
export async function loadWorkspaceSessionSourcePages(
  loadPage: (cursor?: string) => Promise<SessionMetadataPage>,
  isCurrent: () => boolean,
): Promise<string[]> {
  const warnings = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | undefined;
  while (isCurrent()) {
    const page = await loadPage(cursor);
    if (!isCurrent()) return [];
    for (const warning of page.discoveryWarnings ?? []) warnings.add(warning);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
    if (!cursor || visited.has(cursor)) throw new Error('Session metadata pagination did not advance');
    visited.add(cursor);
  }
  return [...warnings];
}
