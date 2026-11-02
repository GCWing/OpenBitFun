import { useSyncExternalStore } from 'react';
import { Button, Empty, Icon, OverflowText } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import { useWorkspaceResourceState } from '@/app/scenes/workspace-resources/workspaceResourceState';
import { useCanvasStore } from '@/app/components/panels/content-canvas';
import { isCanvasTabVisibleForSession } from '@/app/components/panels/content-canvas/types';
import type { ContentResourceScope } from '@/shared/types/contentResource';
import { expandSessionAuxPane } from './sessionPanelLayout';

export function AuxPaneEmptyState({ workspacePath, sessionId }: { workspacePath?: string; sessionId: string | null }) {
  const { t } = useI18n('components');
  const { workspace, workspaceName } = useCurrentWorkspace();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const target = workspace && (!workspacePath || workspace.rootPath === workspacePath) ? workspace : null;
  const canOpen = Boolean(target && (target.workspaceKind !== 'remote' || target.connectionId));
  const lastClosed = useCanvasStore(state => state.closedTabs[0]);
  const canvasScopeKey = useCanvasStore(state => state.scopeKey);
  const reopenClosedTab = useCanvasStore(state => state.reopenClosedTab);
  const lastScope = lastClosed?.tab.content.metadata?.resourceScope as ContentResourceScope | undefined;
  const canReopen = Boolean(lastClosed && canvasScopeKey === (sessionId || '__none__')
    && isCanvasTabVisibleForSession(lastClosed.tab, sessionId)
    && lastScope?.surfaceId === scope.surfaceId && lastScope.workspaceId === target?.id);
  const browseFiles = () => {
    if (!canOpen || !target || !scope.isCurrent()) return;
    useWorkspaceResourceState.getState().updateLayout(scope.key('workspace-resources', target.id), { filesCollapsed: false, fileView: 'tree' });
    useNavSceneStore.getState().openWorkspaceResources(target.id);
  };
  const createTerminal = () => {
    if (!canOpen || !target || !scope.isCurrent()) return;
    window.dispatchEvent(new CustomEvent('terminal-create-requested', { detail: {
      surfaceId: scope.surfaceId,
      resourceScope: { surfaceId: scope.surfaceId, workspaceId: target.id, workspacePath: target.rootPath, remoteConnectionId: target.connectionId },
    } }));
  };
  return <div className="openbitfun-aux-pane__empty-state" data-openbitfun-component="aux-pane" data-openbitfun-part="emptyState">
    <Empty className="openbitfun-aux-pane__empty-content" imageSize="lg" icon={<Icon name="playing-cards-fan" />}
      title={<OverflowText>{(target && workspaceName) || t('canvas.empty.title')}</OverflowText>}
      description={canOpen ? undefined : t(target ? 'canvas.empty.workspaceUnavailable' : 'canvas.empty.selectWorkspace')}
      actions={<div className="openbitfun-aux-pane__empty-actions">
        <Button size="sm" variant="outline" disabled={!canOpen} onClick={browseFiles}>{t('canvas.empty.browseFiles')}</Button>
        <Button size="sm" variant="outline" disabled={!canOpen} onClick={createTerminal}>{t('canvas.empty.newTerminal')}</Button>
        {canReopen && <Button size="sm" variant="outline" onClick={() => {
          if (!scope.isCurrent()) return;
          reopenClosedTab();
          expandSessionAuxPane();
        }}>{t('canvas.empty.reopen', { title: lastClosed!.tab.title })}</Button>}
      </div>} />
  </div>;
}
