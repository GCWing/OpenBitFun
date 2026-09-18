/**
 * GitScene — Git scene content. Renders view by activeView from gitSceneStore.
 * Left nav is GitNav (registered in nav-registry). Handles not-repo and loading.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Button, Icon, IconButton, Tooltip } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { useGitSceneStore } from './gitSceneStore';
import { WorkingCopyView, BranchesView, GraphView } from './views';
import { useGitState } from '@/tools/git/hooks';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { LoadingState } from '@openbitfun/ui';
import { globalEventBus } from '@/infrastructure/event-bus';
import { requestGitRepositoryTrust } from '@/shared/services/gitTrustService';
import './GitScene.scss';

interface GitSceneProps {
  workspacePath?: string;
  isActive?: boolean;
}

const GitScene: React.FC<GitSceneProps> = ({
  workspacePath: workspacePathProp,
  isActive = true,
}) => {
  const { workspace } = useCurrentWorkspace();
  const workspacePath = workspacePathProp ?? workspace?.rootPath ?? '';
  const { t } = useTranslation('panels/git');
  const activeView = useGitSceneStore((s) => s.activeView);

  const [forceReset, setForceReset] = useState(false);
  const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    isRepository,
    repositoryTrustRequired,
    isLoading: statusLoading,
    refresh,
  } = useGitState({
    repositoryPath: { workspaceId: workspace?.id ?? '', repositoryPath: workspacePath },
    isActive,
    refreshOnMount: true,
    layers: ['basic', 'status'],
  });

  const [isTrusting, setIsTrusting] = useState(false);

  const repoLoading = statusLoading && !isRepository;
  const handleRefresh = useCallback(
    () => refresh({ force: true, layers: ['basic', 'status'], reason: 'manual' }),
    [refresh]
  );

  useEffect(() => {
    if (repoLoading || statusLoading) {
      loadingTimeoutRef.current = setTimeout(() => {
        setForceReset(true);
        setTimeout(() => {
          setForceReset(false);
          handleRefresh();
        }, 100);
      }, 10000);
    } else {
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }
    }
    return () => {
      if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
    };
  }, [repoLoading, statusLoading, handleRefresh]);

  const handleInitGitRepository = useCallback(() => {
    globalEventBus.emit('fill-chat-input', { content: t('init.chatPrompt') });
  }, [t]);

  // The service owns the confirmation, the grant, and every failure
  // notification; a granted decision only needs the repository state rebuilt.
  const handleTrustRepository = useCallback(async () => {
    if (!workspacePath || isTrusting) return;
    setIsTrusting(true);
    try {
      const trusted = await requestGitRepositoryTrust({ workspaceId: workspace?.id ?? '', repositoryPath: workspacePath }, { userInitiated: true });
      if (trusted) {
        await refresh({ force: true, layers: ['basic', 'status'], reason: 'manual' });
      }
    } finally {
      setIsTrusting(false);
    }
  }, [workspacePath, isTrusting, refresh, workspace?.id]);

  const renderView = useCallback(() => {
    switch (activeView) {
      case 'branches':
        return <BranchesView workspaceId={workspace?.id} workspacePath={workspacePath} />;
      case 'graph':
        return <GraphView workspaceId={workspace?.id} workspacePath={workspacePath} />;
      case 'working-copy':
      default:
        return <WorkingCopyView workspaceId={workspace?.id} workspacePath={workspacePath} isActive={isActive} />;
    }
  }, [activeView, isActive, workspacePath, workspace?.id]);

  if (!isActive) {
    return <div className="openbitfun-git-scene" aria-hidden="true" data-openbitfun-scene="git" data-openbitfun-part="root" data-openbitfun-view="hidden" />;
  }

  // Ownership trust outranks `isRepository`. A repository Git refuses on
  // ownership grounds still *is* one, so the probe reports it as such; gating
  // this view on `!isRepository` made it unreachable exactly where it matters.
  if (!repoLoading && repositoryTrustRequired) {
    return (
      <div className="openbitfun-git-scene openbitfun-git-scene--not-repository" data-openbitfun-scene="git" data-openbitfun-part="root" data-openbitfun-view="trust-required">
        <div className="openbitfun-git-scene__content" data-openbitfun-scene="git" data-openbitfun-part="content">
          <div className="openbitfun-git-scene__init-container" data-openbitfun-scene="git" data-openbitfun-part="empty">
            <div className="openbitfun-git-scene__init-card">
              <div className="openbitfun-git-scene__init-icon">
                <ShieldAlert size={24} />
              </div>
              <div className="openbitfun-git-scene__init-text">
                <h3>{t('trust.title')}</h3>
                <p>{t('trust.required', { path: workspacePath })}</p>
              </div>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<ShieldAlert />}
                onClick={handleTrustRepository}
                disabled={isTrusting}
              >
                {t('trust.confirm')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!repoLoading && !isRepository) {
    return (
      <div className="openbitfun-git-scene openbitfun-git-scene--not-repository" data-openbitfun-scene="git" data-openbitfun-part="root" data-openbitfun-view="not-repository">
        <div className="openbitfun-git-scene__content" data-openbitfun-scene="git" data-openbitfun-part="content">
          <div className="openbitfun-git-scene__init-container" data-openbitfun-scene="git" data-openbitfun-part="empty">
            <div className="openbitfun-git-scene__init-decoration">
              <div className="openbitfun-git-scene__init-line openbitfun-git-scene__init-line--dashed" />
              <div className="openbitfun-git-scene__init-dot" />
              <div className="openbitfun-git-scene__init-line openbitfun-git-scene__init-line--solid" />
            </div>
            <div className="openbitfun-git-scene__init-card">
              <div className="openbitfun-git-scene__init-icon">
                <Icon name="git" size="lg" />
              </div>
              <div className="openbitfun-git-scene__init-text">
                <h3>{t('init.title')}</h3>
                <p>{t('init.notRepository')}</p>
              </div>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Icon name="plus" size="lg" />}
                onClick={handleInitGitRepository}
              >
                {t('init.initButton')}
              </Button>
            </div>
            <div className="openbitfun-git-scene__init-decoration">
              <div className="openbitfun-git-scene__init-line openbitfun-git-scene__init-line--solid" />
              <div className="openbitfun-git-scene__init-dot openbitfun-git-scene__init-dot--muted" />
              <div className="openbitfun-git-scene__init-line openbitfun-git-scene__init-line--dashed" />
            </div>
            <div className="openbitfun-git-scene__init-hint">
              <span>{t('init.hint')}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if ((repoLoading || statusLoading) && !forceReset) {
    return (
      <div className="openbitfun-git-scene openbitfun-git-scene--loading" data-openbitfun-scene="git" data-openbitfun-part="root" data-openbitfun-view="loading">
        <div className="openbitfun-git-scene__content" data-openbitfun-scene="git" data-openbitfun-part="content">
          <div className="openbitfun-git-scene__loading-actions">
            <Tooltip content={t('actions.forceRefresh')}>
              <IconButton
                size="sm"
                aria-label={t('actions.forceRefresh')}
                icon={<Icon name="refresh" size="lg" />}
                onClick={() => {
                  setForceReset(true);
                  setTimeout(() => {
                    setForceReset(false);
                    handleRefresh();
                  }, 100);
                }}
              />
            </Tooltip>
          </div>
          <div className="openbitfun-git-scene__loading-state" data-openbitfun-scene="git" data-openbitfun-part="loading">
            <LoadingState size="md">{t('loading.text')}</LoadingState>
            <p className="openbitfun-git-scene__loading-hint">{t('loading.hint')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="openbitfun-git-scene"
      data-shortcut-scope="git"
      data-openbitfun-scene="git"
      data-openbitfun-part="root"
      data-openbitfun-view="repository"
    >
      {renderView()}
    </div>
  );
};

export default GitScene;
