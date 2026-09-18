import { useEffect } from 'react';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useI18n } from '@/infrastructure/i18n';
import { sessionComposerStore } from '@/flow_chat/store/sessionComposerStore';
import { isProjectedSessionEmpty } from '@/flow_chat/utils/flowChatTurnIdentity';
import type { Session } from '@/flow_chat/types/flow-chat';
import { sessionWorkspaceId } from '@/flow_chat/utils/sessionWorkspace';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('AssistantBootstrap');

/** Offer bootstrap as an editable draft. Only the composer may submit it. */
export function useAssistantBootstrap(
  session: Session | undefined,
  onDraftReady: (value: string) => void,
): void {
  const { t } = useI18n('common');
  const scope = getActiveSurfaceScope();
  const sessionId = session?.sessionId;
  // The session's workspace ID owns the read; the root is only used to build
  // the BOOTSTRAP.md path inside it.
  const workspaceId = sessionWorkspaceId(session);
  const workspacePath = session?.workspacePath;
  const isEmptyClaw = session?.mode?.toLowerCase() === 'claw'
    && isProjectedSessionEmpty(session)
    && !session.lastSubmittedMode
    && !session.config.dispatchTarget
    && !session.config.dispatchJobId;

  useEffect(() => {
    if (!isEmptyClaw || !sessionId || !workspaceId || !workspacePath) return;
    const composer = sessionComposerStore.getState();
    const draft = composer.getDraft(sessionId);
    // An edited or explicitly cleared draft belongs to the user, including on reopen.
    if (draft.updatedAt || draft.value || draft.contexts.length) return;

    let cancelled = false;
    const requestScope = getActiveSurfaceScope();
    const bootstrapPath = `${workspacePath.replace(/[\\/]+$/, '')}/BOOTSTRAP.md`;
    void workspaceAPI.readWorkspaceFile(workspaceId, bootstrapPath).then(() => {
      if (cancelled || !requestScope.isCurrent()) return;
      const latest = sessionComposerStore.getState().getDraft(sessionId);
      if (latest.updatedAt !== draft.updatedAt || latest.value || latest.contexts.length) return;
      onDraftReady(t('nav.sessions.assistantBootstrapDraft'));
    }).catch(error => {
      if (cancelled || !requestScope.isCurrent()) return;
      // Completed assistants no longer have BOOTSTRAP.md. Other failures remain diagnosable.
      const message = error instanceof Error ? error.message : String(error);
      if (!/does not exist|no such file|not found/i.test(message)) {
        log.warn('Failed to prepare assistant bootstrap draft', { sessionId, workspaceId, error });
      }
    });
    return () => { cancelled = true; };
  }, [isEmptyClaw, onDraftReady, scope.epoch, sessionId, t, workspaceId, workspacePath]);
}
