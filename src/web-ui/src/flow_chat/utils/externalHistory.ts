import type { SessionCustomMetadata } from '@/shared/types/session-history';
import type { Session } from '../types/flow-chat';
import type { SessionPermissionModeResponse } from '@/infrastructure/api/service-api/AgentAPI';

/** Source views have no runtime permissions; selection is applied to the first branch. */
export async function readComposerPermissionMode(
  session: Pick<Session, 'externalHistory' | 'externalContinuationPermissionMode'> | undefined,
  readNative: () => Promise<SessionPermissionModeResponse>,
): Promise<SessionPermissionModeResponse> {
  return session?.externalHistory?.mode === 'follow'
    ? { mode: session.externalContinuationPermissionMode ?? null }
    : readNative();
}

export function externalHistoryFromMetadata(metadata?: SessionCustomMetadata): Session['externalHistory'] {
  if (metadata?.externalHistoryMode !== 'follow' || metadata.externalHistoryPending !== true) return undefined;
  return {
    mode: 'follow',
    contentVersion: metadata.externalContentVersion,
    sourceStatus: metadata.externalSourceStatus,
    incomplete: metadata.externalSourceIncomplete,
    observedFingerprint: metadata.externalObservedFingerprint,
    materializedObservation: metadata.externalMaterializedObservation,
  };
}

export function viewedExternalHistoryVersion(session?: Session): string | undefined {
  const version = session?.dialogTurns.at(-1)?.userMessage.metadata?.externalContentVersion;
  return typeof version === 'string' ? version : undefined;
}

export function viewedExternalForkTurn(session: Session): string | undefined {
  if (session.historyState !== 'ready' || !viewedExternalHistoryVersion(session)) return undefined;
  const last = session.dialogTurns.at(-1);
  const catalogTail = session.turnCatalog?.entries.at(-1)?.turnId;
  // A paged older window is not the displayed source's continuation boundary.
  if (catalogTail && last?.id !== catalogTail) return undefined;
  return last?.id;
}
