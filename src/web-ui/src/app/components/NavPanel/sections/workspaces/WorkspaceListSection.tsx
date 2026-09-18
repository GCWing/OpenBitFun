import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { notificationService } from '@/shared/notification-system';
import WorkspaceItem from './WorkspaceItem';
import SessionsSection, { type WorkspaceSessionScope } from '../sessions/SessionsSection';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';
import {
  isWorkspaceBackedSessionGroupActive,
  projectWorkspaceBackedSessionGroups,
  type SessionNavigationScope,
} from '../../sessionNavigationProjection';
import './WorkspaceListSection.scss';

interface WorkspaceListSectionProps {
  variant: SessionNavigationScope;
}

type WorkspaceDragPosition = 'before' | 'after';

interface WorkspaceDragPayload {
  workspaceId: string;
  variant: SessionNavigationScope;
}

const WORKSPACE_DRAG_MIME_TYPE = 'application/x-openbitfun-workspace';
const WORKSPACE_DROP_SETTLE_MS = 160;
const WORKSPACE_DROP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';


const WorkspaceListSection: React.FC<WorkspaceListSectionProps> = ({ variant }) => {
  const { t } = useI18n('common');
  const {
    openedWorkspacesList,
    normalWorkspacesList,
    assistantWorkspacesList,
    activeWorkspaceId,
    reorderOpenedWorkspacesInSection,
  } = useWorkspaceContext();
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    position: WorkspaceDragPosition;
  } | null>(null);
  const grouping = useWorkspaceSessionViewStore(state => state.grouping);

  // Refs for values that must be read inside event handlers without stale closures
  const draggedWorkspaceIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ workspaceId: string; position: WorkspaceDragPosition } | null>(null);
  const workspaceRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingDropRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const dropAnimationsRef = useRef<Map<string, Animation>>(new Map());

  const sectionWorkspaces = variant === 'all'
    ? openedWorkspacesList
    : variant === 'assistants'
      ? assistantWorkspacesList
      : normalWorkspacesList;
  const sessionGroups = useMemo(() => {
    return projectWorkspaceBackedSessionGroups(sectionWorkspaces, variant);
  }, [sectionWorkspaces, variant]);
  const workspaces = useMemo(
    () => sessionGroups.map(group => group.workspace),
    [sessionGroups],
  );
  const activeWorkspace = openedWorkspacesList.find(workspace => workspace.id === activeWorkspaceId);
  const emptyLabel = variant === 'assistants'
    ? t('nav.workspaces.emptyAssistants')
    : variant === 'projects'
      ? t('nav.workspaces.emptyProjects')
      : t('nav.workspaces.emptySessionGroups');
  const workspaceScopes = useMemo<WorkspaceSessionScope[]>(() => (
    variant !== 'assistants'
      ? workspaces.map(workspace => ({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        }))
      : []
  ), [variant, workspaces]);

  const workspaceSignature = sessionGroups.map(group => group.groupId).join(':');

  useEffect(() => () => {
    dropAnimationsRef.current.forEach(animation => animation.cancel());
    dropAnimationsRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    const previousRects = pendingDropRectsRef.current;
    if (!previousRects) return;
    pendingDropRectsRef.current = null;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    for (const [workspaceId, element] of workspaceRowRefs.current) {
      const previousRect = previousRects.get(workspaceId);
      if (!previousRect) continue;
      const currentRect = element.getBoundingClientRect();
      const deltaY = previousRect.top - currentRect.top;
      if (Math.abs(deltaY) < 0.5) continue;

      dropAnimationsRef.current.get(workspaceId)?.cancel();
      const animation = element.animate(
        [
          { transform: `translateY(${deltaY}px)` },
          { transform: 'translateY(0)' },
        ],
        { duration: WORKSPACE_DROP_SETTLE_MS, easing: WORKSPACE_DROP_EASING },
      );
      dropAnimationsRef.current.set(workspaceId, animation);
      animation.addEventListener('finish', () => {
        if (dropAnimationsRef.current.get(workspaceId) === animation) {
          dropAnimationsRef.current.delete(workspaceId);
        }
      }, { once: true });
    }
  }, [workspaceSignature]);

  const handleDragStart = useCallback((workspaceId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    const payload: WorkspaceDragPayload = { workspaceId, variant };
    const serializedPayload = JSON.stringify(payload);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(WORKSPACE_DRAG_MIME_TYPE, serializedPayload);
    event.dataTransfer.setData('text/plain', serializedPayload);
    draggedWorkspaceIdRef.current = workspaceId;
    setDraggedWorkspaceId(workspaceId);
  }, [variant]);

  const handleDragEnd = useCallback(() => {
    draggedWorkspaceIdRef.current = null;
    dropTargetRef.current = null;
    setDraggedWorkspaceId(null);
    setDropTarget(null);
  }, []);

  const handleDragOver = useCallback((workspaceId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    // Browsers block reading dataTransfer data during dragover for security.
    // Check event.dataTransfer.types instead — it IS readable during dragover.
    const isWorkspaceDrag = event.dataTransfer.types.includes(WORKSPACE_DRAG_MIME_TYPE);
    const currentDraggedId = draggedWorkspaceIdRef.current;

    if (!isWorkspaceDrag || !currentDraggedId || currentDraggedId === workspaceId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    // Measure only the workspace card, not the wrapper that includes the drop-line.
    const itemEl = event.currentTarget.querySelector<HTMLElement>(
      '.openbitfun-nav-panel__workspace-item'
    );
    const rect = itemEl
      ? itemEl.getBoundingClientRect()
      : event.currentTarget.getBoundingClientRect();

    const position: WorkspaceDragPosition = event.clientY >= rect.top + rect.height / 2
      ? 'after'
      : 'before';

    setDropTarget(current => {
      if (current?.workspaceId === workspaceId && current.position === position) {
        return current;
      }
      const next = { workspaceId, position };
      dropTargetRef.current = next;
      return next;
    });
  }, []); // Intentionally empty: reads from refs, not closed-over state

  const handleDragLeave = useCallback((workspaceId: string) => (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropTarget(current => {
        if (current?.workspaceId !== workspaceId) return current;
        dropTargetRef.current = null;
        return null;
      });
    }
  }, []);

  const handleDrop = useCallback((workspaceId: string) => async (event: React.DragEvent<HTMLDivElement>) => {
    // On drop, reading dataTransfer data IS allowed.
    const payloadText =
      event.dataTransfer.getData(WORKSPACE_DRAG_MIME_TYPE) ||
      event.dataTransfer.getData('text/plain');

    if (!payloadText) return;

    let payload: WorkspaceDragPayload;
    try {
      payload = JSON.parse(payloadText) as WorkspaceDragPayload;
    } catch {
      return;
    }

    if (!payload.workspaceId || payload.variant !== variant) return;

    event.preventDefault();
    event.stopPropagation();

    // Reuse the position already determined by dragover — avoid recalculating
    // on the wrapper whose height may have changed due to the drop-line element.
    const position =
      dropTargetRef.current?.workspaceId === workspaceId
        ? dropTargetRef.current.position
        : 'after';

    draggedWorkspaceIdRef.current = null;
    dropTargetRef.current = null;
    setDropTarget(null);
    pendingDropRectsRef.current = new Map(
      Array.from(workspaceRowRefs.current, ([id, element]) => (
        [id, element.getBoundingClientRect()] as const
      )),
    );

    try {
      await reorderOpenedWorkspacesInSection(variant, payload.workspaceId, workspaceId, position);
    } catch (error) {
      pendingDropRectsRef.current = null;
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.reorderFailed'),
        { duration: 4000 }
      );
    } finally {
      setDraggedWorkspaceId(null);
    }
  }, [reorderOpenedWorkspacesInSection, t, variant]);

  return (
    <div data-openbitfun-component="workspace-list-section" data-openbitfun-part="root" data-openbitfun-state={draggedWorkspaceId ? 'dragging' : undefined}
      className={`openbitfun-nav-panel__workspace-list${draggedWorkspaceId ? ' is-dragging' : ''}`}
      data-testid="nav-workspace-list"
      data-workspace-list={variant}
    >
      {variant !== 'assistants' && grouping === 'all' && workspaces.length > 0 ? (
        <div className="openbitfun-nav-panel__workspace-all-sessions" data-testid="nav-workspace-all-sessions">
          <SessionsSection
            workspaceScopes={workspaceScopes}
            isVisible
            layout="flat"
            useWorkspaceViewPreferences
          />
        </div>
      ) : workspaces.length === 0 ? (
        <div
          data-openbitfun-component="workspace-list-section"
          data-openbitfun-part="empty"
          className="openbitfun-nav-panel__workspace-list-empty"
          data-testid="nav-workspace-list-empty"
          data-workspace-list={variant}
        >
          {emptyLabel}
        </div>
      ) : (
        sessionGroups.map(group => {
          const workspace = group.workspace;
          return (
            <div
              data-openbitfun-component="workspace-list-section"
              data-openbitfun-part="item"
              data-openbitfun-state={workspace.id === activeWorkspaceId ? 'selected' : undefined}
              key={workspace.id}
              ref={(element) => {
                if (element) workspaceRowRefs.current.set(workspace.id, element);
                else workspaceRowRefs.current.delete(workspace.id);
              }}
              className={[
                'openbitfun-nav-panel__workspace-drop-target',
                draggedWorkspaceId && draggedWorkspaceId !== workspace.id && 'is-drag-active',
                dropTarget?.workspaceId === workspace.id && 'is-drop-target',
                dropTarget?.workspaceId === workspace.id && dropTarget.position === 'before' && 'is-before',
                dropTarget?.workspaceId === workspace.id && dropTarget.position === 'after' && 'is-after',
              ].filter(Boolean).join(' ')}
              data-testid="nav-workspace-drop-target"
              data-workspace-id={workspace.id}
              data-workspace-list={variant}
              data-session-group-kind={group.kind}
              onDragOver={handleDragOver(workspace.id)}
              onDragLeave={handleDragLeave(workspace.id)}
              onDrop={(event) => { void handleDrop(workspace.id)(event); }}
            >
              <WorkspaceItem
                workspace={workspace}
                isActive={isWorkspaceBackedSessionGroupActive(workspace, activeWorkspace)}
                isSingle={workspaces.length === 1}
                draggable={workspaces.length > 1}
                isDragging={draggedWorkspaceId === workspace.id}
                onDragStart={handleDragStart(workspace.id)}
                onDragEnd={handleDragEnd}
              />
              {dropTarget?.workspaceId === workspace.id ? (
                <div data-openbitfun-component="workspace-list-section" data-openbitfun-part="dropLine" className="openbitfun-nav-panel__workspace-drop-line" aria-hidden="true" />
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
};

export default WorkspaceListSection;
