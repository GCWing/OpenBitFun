import { resolveAssistantName } from '@/shared/utils/assistantName';
import { useCallback, useEffect, useState } from 'react';
import {
  Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader,
  DialogHeading, DialogTitle,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { prepareSessionDraftForCommand } from '@/flow_chat/services/sessionDraftService';
import { sessionBelongsToWorkspaceNavRow } from '@/flow_chat/utils/sessionOrdering';
import { resolveSessionRelationship } from '@/flow_chat/utils/sessionMetadata';
import { notificationService } from '@/shared/notification-system';
import type { WorkspaceInfo } from '@/shared/types';
import SessionsSection from '../sessions/SessionsSection';
import { readAssistantDefaultSession, saveAssistantDefaultSession } from './assistantSessionPreferences';

interface Props {
  workspace: WorkspaceInfo;
  isActive: boolean;
  onClose: () => void;
}

export default function AssistantSessionHistoryDialog({ workspace, isActive, onClose }: Props) {
  const { t } = useI18n('common');
  const [preference, setPreference] = useState<{ supported: boolean; sessionId: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const name = resolveAssistantName(workspace, t('shared:agents.Claw'));

  const loadPreference = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await readAssistantDefaultSession(workspace.id);
      if (scope.isCurrent()) setPreference(result);
    } catch (error) {
      if (scope.isCurrent() && !isSurfaceChangedError(error)) setLoadFailed(true);
    } finally {
      if (scope.isCurrent()) setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => { void loadPreference(); }, [loadPreference]);

  const changeDefault = useCallback(async (sessionId: string | null) => {
    if (loading || saving || loadFailed || !preference?.supported) return;
    const scope = getActiveSurfaceScope();
    setSaving(true);
    try {
      if (sessionId) {
        const session = flowChatStore.getState().sessions.get(sessionId);
        if (!session || !sessionBelongsToWorkspaceNavRow(session, workspace.id)
          || session.isTransient || session.persistedStatus === 'archived'
          || session.sessionKind === 'subagent' || resolveSessionRelationship(session).parentSessionId) {
          throw new Error(t('nav.sessions.defaultUnavailable'));
        }
        // An empty draft must reach the host before persisting its default pointer.
        await prepareSessionDraftForCommand(session);
        scope.assertCurrent('save assistant default session');
      }
      await saveAssistantDefaultSession(workspace.id, sessionId);
      if (scope.isCurrent()) setPreference({ supported: true, sessionId });
    } catch (error) {
      if (scope.isCurrent() && !isSurfaceChangedError(error)) {
        notificationService.error(error instanceof Error ? error.message : t('nav.sessions.defaultSaveFailed'));
      }
    } finally {
      if (scope.isCurrent()) setSaving(false);
    }
  }, [loadFailed, loading, preference?.supported, saving, t, workspace.id]);

  const disabledReason = loading ? t('nav.sessions.loading')
    : loadFailed ? t('nav.sessions.defaultReadFailed')
      : !preference?.supported ? t('nav.sessions.defaultUnsupported') : undefined;

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }} size="md">
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('nav.sessions.assistantHistory', { name })}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody>
        {loadFailed && (
          <Button variant="text" size="sm" onClick={() => { void loadPreference(); }}>
            {t('nav.sessions.defaultReadFailed')}
          </Button>
        )}
        <SessionsSection
          workspaceId={workspace.id}
          workspacePath={workspace.rootPath}
          isActiveWorkspace={isActive}
          layout="flat"
          onSessionOpened={onClose}
          defaultSessionAction={{
            sessionId: preference?.sessionId ?? null,
            disabled: Boolean(disabledReason) || saving,
            disabledReason,
            onChange: sessionId => { void changeDefault(sessionId); },
          }}
        />
      </DialogBody>
      {preference?.sessionId && (
        <DialogFooter>
          <Button variant="text" size="sm" disabled={saving || loading || loadFailed} onClick={() => { void changeDefault(null); }}>
            {t('nav.sessions.clearDefault')}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}
