import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import React, { Suspense, useMemo, useEffect } from 'react';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { WorkspaceKind } from '@/shared/types';
import { Spinner } from '@openbitfun/ui';
import { useMyAgentStore } from '../my-agent/myAgentStore';
import './AssistantScene.scss';

const ProfileScene = lazyWithRecovery(() => import('../profile/ProfileScene'));

const AssistantScene: React.FC = () => {
  const { t } = useI18n('common');
  const selectedAssistantWorkspaceId = useMyAgentStore((s) => s.selectedAssistantWorkspaceId);
  const setSelectedAssistantWorkspaceId = useMyAgentStore((s) => s.setSelectedAssistantWorkspaceId);
  const { currentWorkspace, allAssistantWorkspacesList: assistantWorkspacesList, primaryAssistantWorkspaceId } = useWorkspaceContext();
  const activeAssistantWorkspace =
    currentWorkspace?.workspaceKind === WorkspaceKind.Assistant ? currentWorkspace : null;

  const defaultAssistantWorkspace = useMemo(
    () => assistantWorkspacesList.find((workspace) => workspace.id === primaryAssistantWorkspaceId)
      ?? assistantWorkspacesList.find((workspace) => !workspace.assistantId)
      ?? assistantWorkspacesList[0]
      ?? null,
    [assistantWorkspacesList, primaryAssistantWorkspaceId]
  );

  const selectedAssistantWorkspace = useMemo(() => {
    if (!selectedAssistantWorkspaceId) {
      return null;
    }
    return assistantWorkspacesList.find((workspace) => workspace.id === selectedAssistantWorkspaceId) ?? null;
  }, [assistantWorkspacesList, selectedAssistantWorkspaceId]);

  const resolvedAssistantWorkspace = useMemo(() => {
    if (activeAssistantWorkspace) {
      return activeAssistantWorkspace;
    }
    if (selectedAssistantWorkspace) {
      return selectedAssistantWorkspace;
    }
    return defaultAssistantWorkspace;
  }, [activeAssistantWorkspace, defaultAssistantWorkspace, selectedAssistantWorkspace]);

  useEffect(() => {
    if (activeAssistantWorkspace?.id && activeAssistantWorkspace.id !== selectedAssistantWorkspaceId) {
      setSelectedAssistantWorkspaceId(activeAssistantWorkspace.id);
    }
  }, [activeAssistantWorkspace, selectedAssistantWorkspaceId, setSelectedAssistantWorkspaceId]);

  useEffect(() => {
    const selectedExists = selectedAssistantWorkspaceId
      ? assistantWorkspacesList.some((workspace) => workspace.id === selectedAssistantWorkspaceId)
      : false;

    if (activeAssistantWorkspace?.id) {
      return;
    }

    if (!selectedExists && resolvedAssistantWorkspace?.id !== selectedAssistantWorkspaceId) {
      setSelectedAssistantWorkspaceId(resolvedAssistantWorkspace?.id ?? null);
    }
  }, [
    activeAssistantWorkspace,
    assistantWorkspacesList,
    resolvedAssistantWorkspace,
    selectedAssistantWorkspaceId,
    setSelectedAssistantWorkspaceId,
  ]);

  return (
    <div className="openbitfun-assistant-scene" data-openbitfun-scene="assistant" data-openbitfun-part="root">
      <Suspense
        fallback={(
          <div
            className="openbitfun-assistant-scene__loading"
            data-openbitfun-scene="assistant"
            data-openbitfun-part="loading"
            role="status"
            aria-busy="true"
            aria-label={t('loading.scenes')}
          >
            <Spinner size="md" />
          </div>
        )}
      >
        <ProfileScene
          key={resolvedAssistantWorkspace?.id ?? 'default-assistant-workspace'}
        />
      </Suspense>
    </div>
  );
};

export default AssistantScene;
