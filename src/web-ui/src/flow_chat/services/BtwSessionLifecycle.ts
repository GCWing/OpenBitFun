import { agentAPI, sessionAPI } from '@/infrastructure/api';
import { removeBtwSessionFromAgentCanvas } from '@/app/components/panels/content-canvas/stores/canvasStore';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { askUserQuestionDraftStore } from '../store/askUserQuestionDraftStore';
import { flowChatStore } from '../store/FlowChatStore';
import { sessionComposerStore } from '../store/sessionComposerStore';
import { requireSessionOwningWorkspaceId } from '../utils/sessionOrdering';
import { isBtwSessionDraft } from '../utils/modelSelectionTarget';
import { flowChatManager } from './FlowChatManager';
import { pendingQueueManager } from './flow-chat-manager/PendingQueueModule';
import { closeBtwSessionAfterSubmissions } from './btwSessionSubmission';

export { trackBtwSessionSubmission } from './btwSessionSubmission';

// Keep the saved identity when cleanup fails so retrying never forks twice.
const savedForks = new Map<string, string>();

export function canSaveBtwSessionAsFork(sessionId: string): boolean {
  const session = flowChatStore.getState().sessions.get(sessionId);
  return session?.sessionKind === 'btw' && Boolean(
    session.dialogTurns.length || session.btwOrigin?.requestId || session.isHistorical,
  );
}

function releaseBtwSession(sessionId: string): void {
  const removedIds = new Set([sessionId, ...flowChatManager.discardLocalSession(sessionId)]);
  removedIds.forEach(id => pendingQueueManager.clear(id));
  sessionComposerStore.getState().removeDrafts(removedIds);
  askUserQuestionDraftStore.getState().removeSessionDrafts(removedIds);
  removeBtwSessionFromAgentCanvas(sessionId);
  savedForks.delete(getActiveSurfaceScope().key('btw-saved-fork', sessionId));
}

/** Save an independent durable fork before releasing the temporary conversation. */
export function saveBtwSessionAsFork(sessionId: string): Promise<void> {
  const scope = getActiveSurfaceScope();
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session || session.sessionKind !== 'btw') return Promise.resolve();

  return closeBtwSessionAfterSubmissions(sessionId, async () => {
    scope.assertCurrent('save BTW session as fork');
    const cancellation = await agentAPI.cancelSession(sessionId);
    scope.assertCurrent('fork BTW session');
    const latest = flowChatStore.getState().sessions.get(sessionId) ?? session;
    const workspaceId = requireSessionOwningWorkspaceId(latest);
    const key = scope.key('btw-saved-fork', sessionId);
    let forkId = savedForks.get(key);
    if (!forkId) {
      if (latest.isHistorical && latest.dialogTurns.length === 0) {
        await flowChatStore.loadSessionHistory(sessionId);
        scope.assertCurrent('load legacy BTW for fork');
      }
      const sourceTurn = flowChatStore.getState().sessions.get(sessionId)?.dialogTurns.at(-1);
      const sourceTurnId = cancellation.dialogTurnId || sourceTurn?.id;
      if (!sourceTurnId) throw new Error('BTW session has no submitted question to save');
      const fork = await sessionAPI.forkSession(sessionId, sourceTurnId, workspaceId);
      // The host has saved the fork even if the controller switches before ACK.
      savedForks.set(key, fork.sessionId);
      scope.assertCurrent('publish saved BTW fork');
      forkId = fork.sessionId;
    }
    if (!await flowChatStore.ensurePersistedSessionMetadata(forkId, workspaceId)) {
      throw new Error('Saved BTW fork metadata is unavailable');
    }
    scope.assertCurrent('close saved BTW session');
    const composer = sessionComposerStore.getState();
    const draft = composer.getDraft(sessionId);
    composer.setValue(forkId, draft.value);
    composer.setContexts(forkId, draft.contexts);
    composer.setPendingLargePastes(forkId, draft.pendingLargePastes);
    await agentAPI.deleteSession(sessionId, workspaceId);
    scope.assertCurrent('release saved BTW session state');
    releaseBtwSession(sessionId);
  });
}

/** Explicit tab closure owns runtime deletion; view unmounts never call this. */
export function discardBtwSession(sessionId: string): Promise<void> {
  const scope = getActiveSurfaceScope();
  const session = flowChatStore.getState().sessions.get(sessionId);
  if (!session || session.sessionKind !== 'btw') return Promise.resolve();

  return closeBtwSessionAfterSubmissions(sessionId, async () => {
    scope.assertCurrent('close BTW session');
    const latest = flowChatStore.getState().sessions.get(sessionId) ?? session;
    // An empty side draft has no host session yet. A request ID also covers
    // forks whose acknowledgement failed after the host accepted them.
    if (!isBtwSessionDraft(latest) || latest.btwOrigin?.requestId) {
      await agentAPI.cancelSession(sessionId);
      scope.assertCurrent('delete BTW session');
      await agentAPI.deleteSession(sessionId, requireSessionOwningWorkspaceId(latest));
      scope.assertCurrent('release BTW session state');
    }
    releaseBtwSession(sessionId);
  });
}
