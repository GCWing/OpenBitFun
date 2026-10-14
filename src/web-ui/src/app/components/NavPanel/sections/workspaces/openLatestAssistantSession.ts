import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import type { Session } from '@/flow_chat/types/flow-chat';
import type { WorkspaceInfo } from '@/shared/types';
import { readAssistantDefaultSession } from './assistantSessionPreferences';

/** Read the owning host before choosing a session, including after a cold start. */
export async function openLatestAssistantSession(
  workspace: WorkspaceInfo,
  activateWorkspace: (workspaceId: string) => void | Promise<unknown>,
  onDefaultUnavailable?: () => void,
): Promise<void> {
  const scope = getActiveSurfaceScope();
  const isMainSession = (session: Session) => (
    sessionBelongsToWorkspaceNavRow(session, workspace.id)
    && !session.isTransient
    && session.persistedStatus !== 'archived'
    && session.sessionKind !== 'subagent'
    && !resolveSessionRelationship(session).parentSessionId
  );
  const preference = await readAssistantDefaultSession(workspace.id);
  scope.assertCurrent('read assistant entry session');
  if (preference.sessionId) {
    const loaded = await flowChatStore.ensurePersistedSessionMetadata(preference.sessionId, workspace.id);
    scope.assertCurrent('load assistant default session');
    const preferred = flowChatStore.getState().sessions.get(preference.sessionId);
    if (loaded && preferred && isMainSession(preferred)) {
      flowChatStore.clearSessionUnreadCompletion(preferred.sessionId);
      await openMainSession(preferred.sessionId, {
        workspaceId: workspace.id, activateWorkspace, isCurrent: scope.isCurrent,
      });
      return;
    }
    // Preserve the pointer; unavailable history is not permission to erase a preference.
    onDefaultUnavailable?.();
  }
  const persistedActivity = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await flowChatStore.loadSessionMetadataPage(
      workspace.id, 1, cursor, 'assistant_nav_latest',
    );
    scope.assertCurrent('openLatestAssistantSession');
    for (const metadata of page.sessions) {
      persistedActivity.set(metadata.sessionId, metadata.lastActiveAt);
    }
    // A page includes children; an orphaned child must not become the entry session.
    if (page.sessions.some(metadata => {
      const session = flowChatStore.getState().sessions.get(metadata.sessionId);
      return session && isMainSession(session);
    })) break;
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);

  const activity = (session: Session) => Math.max(
    session.lastActiveAt ?? session.createdAt,
    persistedActivity.get(session.sessionId) ?? 0,
  );
  const latest = Array.from(flowChatStore.getState().sessions.values())
    .filter(isMainSession)
    .sort((a, b) => activity(b) - activity(a) || b.createdAt - a.createdAt)[0];
  const sessionId = latest?.sessionId ?? await flowChatManager.createChatDraft(
    flowChatSessionConfigForWorkspace(workspace), 'Claw',
  );
  scope.assertCurrent('openLatestAssistantSession');
  flowChatStore.clearSessionUnreadCompletion(sessionId);
  await openMainSession(sessionId, {
    workspaceId: workspace.id,
    activateWorkspace,
    isCurrent: scope.isCurrent,
  });
}
