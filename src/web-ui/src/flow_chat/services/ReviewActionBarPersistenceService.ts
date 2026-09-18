/**
 * Review Action Bar persistence service.
 *
 * Persists review action bar state to session metadata via the backend API,
 * aligning with the existing session persistence architecture.
 */

import { createLogger } from '@/shared/utils/logger';
import { sessionAPI } from '@/infrastructure/api/service-api/SessionAPI';
import { flowChatStore } from '../store/FlowChatStore';
import { buildSessionMetadata } from '../utils/sessionMetadata';
import type { ReviewActionBarState } from '../store/deepReviewActionBarStore';
import type { ReviewActionPersistedState, SessionMetadata } from '@/shared/types/session-history';
import { requireSessionWorkspaceId } from '../utils/sessionWorkspace';

const log = createLogger('ReviewActionBarPersistence');

export async function persistReviewActionState(state: ReviewActionBarState): Promise<void> {
  if (!state.childSessionId) return;

  const session = flowChatStore.getState().sessions.get(state.childSessionId);
  if (!session) return;
  const workspaceId = requireSessionWorkspaceId(session);

  const stateReviewTargetFilePaths = state.reviewTargetFilePaths ?? [];
  const remediationModifiedFilePaths = state.remediationModifiedFilePaths ?? [];
  const reviewTargetFilePaths = stateReviewTargetFilePaths.length > 0
    ? stateReviewTargetFilePaths
    : session.reviewTargetFilePaths
      ?? session.deepReviewRunManifest?.target.files
        .filter((file) => !file.excluded)
        .map((file) => file.normalizedPath)
      ?? [];

  const payload: ReviewActionPersistedState = {
    version: 1,
    phase: state.phase,
    completedRemediationIds: [...state.completedRemediationIds],
    ...(state.fixingRemediationIds.size > 0
      ? { fixingRemediationIds: [...state.fixingRemediationIds] }
      : {}),
    minimized: state.minimized,
    customInstructions: state.customInstructions,
    ...(state.followUpReviewSessionId
      ? { followUpReviewSessionId: state.followUpReviewSessionId }
      : {}),
    ...(reviewTargetFilePaths.length > 0
      ? { reviewTargetFilePaths }
      : {}),
    ...(remediationModifiedFilePaths.length > 0
      ? { remediationModifiedFilePaths }
      : {}),
    ...(state.remediationScopeRequiresWorkspaceFallback
      ? { remediationScopeRequiresWorkspaceFallback: true }
      : {}),
    ...(state.fixingBaselineTurnId
      ? { fixingBaselineTurnId: state.fixingBaselineTurnId }
      : {}),
    persistedAt: Date.now(),
  };

  try {
    let existingMetadata: SessionMetadata | null = null;
    try {
      existingMetadata = await sessionAPI.loadSessionMetadata(
        state.childSessionId,
        workspaceId
      );
    } catch (error) {
      log.warn('Failed to load session metadata before persisting review action state', {
        sessionId: state.childSessionId,
        error,
      });
    }

    const metadata = {
      ...(existingMetadata ?? buildSessionMetadata(session, null)),
      reviewActionState: payload,
    };

    await sessionAPI.saveSessionMetadata(
      metadata,
      workspaceId,
      ['reviewActionState']
    );
  } catch (error) {
    log.warn('Failed to persist review action state', { sessionId: state.childSessionId, error });
    throw error;
  }
}

export async function clearPersistedReviewState(sessionId: string, workspaceId: string): Promise<void> {
  try {
    const existingMetadata = await sessionAPI.loadSessionMetadata(sessionId, workspaceId);
    if (!existingMetadata) return;

    const metadata = { ...existingMetadata };
    delete metadata.reviewActionState;

    await sessionAPI.saveSessionMetadata(
      metadata,
      workspaceId,
      ['reviewActionState']
    );
  } catch (error) {
    log.warn('Failed to clear persisted review action state', { sessionId, error });
  }
}

export async function loadPersistedReviewState(
  sessionId: string,
  workspaceId: string
): Promise<ReviewActionPersistedState | null> {
  try {
    const metadata = await sessionAPI.loadSessionMetadata(
      sessionId,
      workspaceId
    );
    return metadata?.reviewActionState ?? null;
  } catch (error) {
    log.warn('Failed to load persisted review action state', { sessionId, error });
    return null;
  }
}
