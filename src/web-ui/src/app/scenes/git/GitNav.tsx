/**
 * GitNav — scene-specific left-side navigation for the Git scene.
 *
 * Layout: header (title) + repo status (branch, sync) + nav items (working-copy, history, branches, graph).
 */

import React, { useCallback } from 'react';
import { OverflowText,
  Icon,
  IconButton,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelHeader,
  NavigationPanelItem,
  Tooltip,
} from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { Layers2 } from 'lucide-react';
import { useGitSceneStore, type GitSceneView } from './gitSceneStore';
import { useGitState } from '../../../tools/git/hooks';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';

import './GitNav.scss';

const NAV_ITEMS: { id: GitSceneView; icon?: React.ElementType; labelKey: string }[] = [
  { id: 'working-copy', labelKey: 'tabs.changes' },
  { id: 'branches', icon: Layers2, labelKey: 'tabs.branches' },
  { id: 'graph', icon: Layers2, labelKey: 'tabs.branchGraph' },
];

const GitNav: React.FC = () => {
  const { workspace } = useCurrentWorkspace();
  const workspacePath = workspace?.rootPath ?? '';
  const { t } = useTranslation('panels/git');
  const activeView = useGitSceneStore((s) => s.activeView);
  const setActiveView = useGitSceneStore((s) => s.setActiveView);

  const {
    isRepository,
    currentBranch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    refresh,
  } = useGitState({
    repositoryPath: { workspaceId: workspace?.id ?? '', repositoryPath: workspacePath },
    isActive: true,
    refreshOnMount: true,
    layers: ['basic', 'status'],
  });

  const changeCount = (staged?.length ?? 0) + (unstaged?.length ?? 0) + (untracked?.length ?? 0);
  const branchCount = 0; // Will be filled when branches view loads; optional badge

  const handleViewClick = useCallback(
    (view: GitSceneView) => {
      setActiveView(view);
    },
    [setActiveView]
  );

  return (
    <NavigationPanel
      data-openbitfun-component="git-nav"
      data-openbitfun-part="root"
      className="openbitfun-git-scene-nav"
    >
      <NavigationPanelHeader className="openbitfun-git-nav__panel-header">
        <div className="openbitfun-git-scene-nav__header" data-openbitfun-component="git-nav" data-openbitfun-part="header">
          <OverflowText className="openbitfun-git-scene-nav__title" data-openbitfun-component="git-nav" data-openbitfun-part="title">{t('title')}</OverflowText>
        </div>
      </NavigationPanelHeader>
      <NavigationPanelBody>
        <NavigationPanelContent className="openbitfun-git-nav__panel-content">
          {isRepository && (
            <div className="openbitfun-git-scene-nav__status" data-openbitfun-component="git-nav" data-openbitfun-part="status">
          <div className="openbitfun-git-scene-nav__branch-row">
            <Icon name="git" size="xs" aria-hidden />
            <OverflowText className="openbitfun-git-scene-nav__branch-name" title={currentBranch ?? undefined}>
              {currentBranch ?? t('common.unknown')}
            </OverflowText>
          </div>
          {(ahead > 0 || behind > 0) && (
            <div className="openbitfun-git-scene-nav__sync-badges">
              {ahead > 0 && (
                <span title={t('status.ahead')}>
                  <Icon name="arrow-up" size="2xs" /> {ahead}
                </span>
              )}
              {behind > 0 && (
                <span title={t('status.behind')}>
                  <Icon name="arrow-down" size="lg" style={{ width: 10, height: 10 }} /> {behind}
                </span>
              )}
            </div>
          )}
        <div className="openbitfun-git-scene-nav__actions-row" data-openbitfun-component="git-nav" data-openbitfun-part="actions">
            <Tooltip content={t('actions.refresh')}>
              <IconButton
                size="sm"
                aria-label={t('actions.refresh')}
                icon={<Icon name="refresh" size="lg" />}
                onClick={() => refresh({ force: true })}
              />
            </Tooltip>
          </div>
            </div>
          )}

          {NAV_ITEMS.map(({ id, icon: ItemIcon, labelKey }) => (
            <NavigationPanelItem
          key={id}
          className={['openbitfun-git-scene-nav__item', activeView === id && 'is-active'].filter(Boolean).join(' ')}
          selected={activeView === id}
          leading={id === 'working-copy'
            ? <Icon name="git" size="sm" />
            : ItemIcon ? <ItemIcon size={14} aria-hidden /> : undefined}
          metadata={
            id === 'working-copy' && changeCount > 0 ? (
              <span className="openbitfun-git-scene-nav__item-badge">({changeCount})</span>
            ) : id === 'branches' && branchCount > 0 ? (
              <span className="openbitfun-git-scene-nav__item-badge">({branchCount})</span>
            ) : undefined
          }
          onClick={() => handleViewClick(id)}
        >
          {t(labelKey)}
            </NavigationPanelItem>
          ))}
        </NavigationPanelContent>
      </NavigationPanelBody>
    </NavigationPanel>
  );
};

export default GitNav;
