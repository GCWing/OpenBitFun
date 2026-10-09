import type { SessionPermissionMode } from '@/infrastructure/api/service-api/AgentAPI';

/** Controller-owned preparation. The view reserves its future host session ID. */
export interface SessionDraft {
  workspaceId: string;
  phase: 'editing' | 'creating' | 'ready' | 'submitting';
  permissionMode?: SessionPermissionMode | null;
  /** Stable across retries, including an ambiguous first-turn acknowledgement. */
  turnId: string;
}

export function isUnmaterializedSessionDraft(session: { draft?: SessionDraft } | undefined): boolean {
  return !!session?.draft && (session.draft.phase === 'editing' || session.draft.phase === 'creating');
}
