import type { SessionPermissionModeRequest } from '@/infrastructure/api/service-api/AgentAPI';
import type { Session } from '../types/flow-chat';
import { shouldIncludeInternalModelSession } from './modelSelectionTarget';
import { sessionOwningWorkspaceId } from './sessionOrdering';
import { sessionProjectWorkspacePath } from './sessionWorkspace';

/** Reads and both permission mutations must address the same runtime session. */
export function sessionPermissionModeScope(session: Session | undefined): Pick<
  SessionPermissionModeRequest,
  'workspaceId' | 'workspacePath' | 'remoteConnectionId' | 'remoteSshHost' | 'includeInternal'
> {
  return {
    workspaceId: session && sessionOwningWorkspaceId(session),
    workspacePath: session && sessionProjectWorkspacePath(session),
    remoteConnectionId: session?.remoteConnectionId,
    remoteSshHost: session?.remoteSshHost,
    // MiniApp and other agent-backed transient views use hidden host sessions,
    // just like the model selector. Their existence is not a missing-record gap.
    includeInternal: shouldIncludeInternalModelSession(session),
  };
}

type PermissionModeSessionState = Pick<
  Session,
  'dialogTurns' | 'historyState' | 'isHistorical' | 'persistedTurnCount'
>;

/**
 * A newly reserved local session can have a UI projection before its host
 * directory exists. A missing host record is expected only while that empty
 * session is still in its initial local state.
 */
export function canTreatMissingPermissionModeAsDefault(
  session: PermissionModeSessionState | undefined,
): boolean {
  return Boolean(
    session
      && session.isHistorical !== true
      && session.historyState === 'new'
      && session.dialogTurns.length === 0
      && session.persistedTurnCount == null,
  );
}

/** Recognize the host error emitted when the session directory is not present yet. */
export function isSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session not found/i.test(message);
}
