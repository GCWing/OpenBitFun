import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { openAgentCanvasTabForSession, updateAgentCanvasTabsForSession } from '@/app/components/panels/content-canvas/stores/canvasStore';
import type { Session } from '../types/flow-chat';
import type { TrajectoryNode } from './trajectoryModel';

export const TRAJECTORY_NAVIGATE_EVENT = 'flowchat:trajectory-navigate';
export interface TrajectoryPanelData { viewId: string; sessionId: string; surfaceId: string; node: TrajectoryNode; query: string }
export function openTrajectoryPanel(session: Session, node: TrajectoryNode, query: string, title: string, viewId: string): void {
  const surface = getActiveSurfaceScope();
  openAgentCanvasTabForSession(session.sessionId, {
    type: 'session-trajectory', title,
    data: { sessionId: session.sessionId, surfaceId: surface.surfaceId, node, query, viewId } satisfies TrajectoryPanelData,
    metadata: { duplicateCheckKey: `session-trajectory:${surface.surfaceId}:${session.sessionId}`,
      sessionId: session.sessionId, contentRole: 'session-trajectory', resourceScope: {
        surfaceId: surface.surfaceId, workspaceId: session.workspaceId, workspacePath: session.workspacePath,
      } },
  });
  window.dispatchEvent(new CustomEvent('expand-right-panel'));
}

export function showTrajectoryRange(session: Session, range: import('./trajectoryRange').TrajectoryRangeSummary | null, title: string, activate: boolean, viewId: string): void {
  const surface = getActiveSurfaceScope();
  const update = (content: import('@/shared/types/panelContent').PanelContent) => {
    if (content.type !== 'session-trajectory' || !content.data?.range || content.data.sessionId !== session.sessionId || content.data.surfaceId !== surface.surfaceId) return undefined;
    return range ? { ...content, data: { sessionId: session.sessionId, surfaceId: surface.surfaceId, range, viewId } }
      : { ...content, data: { sessionId: session.sessionId, surfaceId: surface.surfaceId, node: content.data.range.start, query: '', viewId } };
  };
  if (!activate || !range) {
    updateAgentCanvasTabsForSession(session.sessionId, update);
    const resources = useContentResourceStore.getState();
    for (const resource of Object.values(resources.resources)) {
      if (resource.scope.surfaceId !== surface.surfaceId) continue;
      const next = update(resource.content); if (next) resources.update(resource.id, { content: next });
    }
    return;
  }
  openAgentCanvasTabForSession(session.sessionId, { type: 'session-trajectory', title,
    data: { sessionId: session.sessionId, surfaceId: surface.surfaceId, range, viewId },
    metadata: { duplicateCheckKey: `session-trajectory:${surface.surfaceId}:${session.sessionId}`,
      sessionId: session.sessionId, contentRole: 'session-trajectory', resourceScope: {
        surfaceId: surface.surfaceId, workspaceId: session.workspaceId, workspacePath: session.workspacePath,
      } },
  });
  window.dispatchEvent(new CustomEvent('expand-right-panel'));
}
