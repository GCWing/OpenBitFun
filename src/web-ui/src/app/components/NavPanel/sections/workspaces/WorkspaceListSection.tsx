import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { getActiveSurfaceId, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import WorkspaceItem from './WorkspaceItem';
import { remoteWorkspaceBadges } from './remoteWorkspaceBadge';
import SessionViewTransition from './SessionViewTransition';
import SessionsSection, { type WorkspaceSessionScope } from '../sessions/SessionsSection';
import { useWorkspaceSessionViewStore } from '../../workspaceSessionView';
import {
  isWorkspaceBackedSessionGroupActive,
  isWorkspaceBackedSessionGroupSelected,
  projectWorkspaceBackedSessionGroups,
  type SessionNavigationScope,
  type WorkspaceBackedSessionGroup,
} from '../../sessionNavigationProjection';
import './WorkspaceListSection.scss';

interface WorkspaceListSectionProps {
  variant: SessionNavigationScope;
  scrollRootRef?: React.RefObject<HTMLElement | null>;
}

type WorkspaceDragPosition = 'before' | 'after';

interface WorkspaceDragPayload {
  workspaceId: string;
  variant: SessionNavigationScope;
}

const WORKSPACE_DRAG_MIME_TYPE = 'application/x-openbitfun-workspace';
const WORKSPACE_DROP_SETTLE_MS = 160;
const WORKSPACE_DROP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * WorkspaceListSection — the session section's group list.
 *
 * Projects and assistants are both workspace-backed, but they are not peers in
 * navigation: the assistant identity is pinned above the workspace list and
 * never joins the workspace order (see `pinnedGroups`).
 */

const WorkspaceListSection: React.FC<WorkspaceListSectionProps> = ({ variant, scrollRootRef }) => {
  const { t } = useI18n('common');
  const {
    openedWorkspacesList,
    normalWorkspacesList,
    assistantWorkspacesList,
    activeWorkspaceId,
    reorderOpenedWorkspacesInSection,
  } = useWorkspaceContext();
  // Remote badges are compared across every opened workspace so equal compact labels expand.
  const remoteBadges = useMemo(() => remoteWorkspaceBadges(openedWorkspacesList), [openedWorkspacesList]);
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    position: WorkspaceDragPosition;
  } | null>(null);
  const grouping = useWorkspaceSessionViewStore(state => state.grouping);
  const activeTab = useSceneStore(state => state.openTabs.find(tab => tab.id === state.activeTabId));
  const contentScope = useContentResourceStore(state => (
    activeTab?.contentId ? state.resources[activeTab.contentId]?.scope : undefined
  ));
  const surfaceId = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceId, getActiveSurfaceId);
  const collapseAllRequestId = useWorkspaceSessionViewStore(state => state.collapseAllRequestId);
  const [projectDisclosure, setProjectDisclosure] = useState<{
    requestId: number;
    values: Record<string, boolean>;
  }>({ requestId: collapseAllRequestId, values: {} });

  // Refs for values that must be read inside event handlers without stale closures
  const draggedWorkspaceIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<{ workspaceId: string; position: WorkspaceDragPosition } | null>(null);
  const pendingDragEndRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      ? sessionGroups.filter(group => group.kind === 'project').map(({ workspace }) => ({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        }))
      : []
  ), [variant, sessionGroups]);
  /**
   * The assistant is a product-level identity, not one workspace among many. It
   * is pinned above the workspace list and stays out of the workspace order, so
   * the persisted and draggable order only ever describes project workspaces.
   *
   * A hidden, deleted, or never-created assistant has no opened workspace and
   * therefore produces no pinned row: the pin appears and disappears with the
   * assistant itself, and the workspace list is untouched either way.
   */
  const pinnedGroups = variant === 'all'
    ? sessionGroups.filter(group => group.kind === 'assistant')
    : [];
  const reorderableGroups = variant === 'all'
    ? sessionGroups.filter(group => group.kind === 'project')
    : sessionGroups;
  // The flat view folds every project session into one aggregate list, so only
  // the pinned assistant rows stay above it.
  const visibleReorderableGroups = grouping === 'all' && variant !== 'assistants'
    ? []
    : reorderableGroups;
  const canReorderGroups = visibleReorderableGroups.length > 1;
  const canContinueDrag = draggedWorkspaceId !== null && canReorderGroups
    && visibleReorderableGroups.some(group => group.workspace.id === draggedWorkspaceId);
  /**
   * Pinned assistants sit outside the drag order, so a project drag rewrites
   * project positions only and leaves the assistant's stored slot untouched.
   */
  const reorderSection = variant === 'all' ? 'projects' : variant;

  const workspaceSignature = sessionGroups.map(group => group.groupId).join(':');

  const resetDragState = useCallback(() => {
    clearTimeout(pendingDragEndRef.current);
    pendingDragEndRef.current = undefined;
    draggedWorkspaceIdRef.current = null;
    dropTargetRef.current = null;
    setDraggedWorkspaceId(null);
    setDropTarget(null);
  }, []);

  // A retained list can lose its native source without receiving dragend.
  // Device identity matters even when the new surface has identical workspace IDs.
  useLayoutEffect(() => {
    resetDragState();
    pendingDropRectsRef.current = null;
  }, [grouping, surfaceId, variant, resetDragState]);

  useLayoutEffect(() => {
    if (draggedWorkspaceId && !canContinueDrag) {
      resetDragState();
    }
  }, [canContinueDrag, draggedWorkspaceId, resetDragState]);

  useEffect(() => {
    if (!draggedWorkspaceId) return;

    const handleWindowDrop = () => {
      // Capture sees drops that other targets stop from bubbling. Let React's
      // target handler read the source and before/after slot before clearing them.
      clearTimeout(pendingDragEndRef.current);
      pendingDragEndRef.current = setTimeout(resetDragState, 0);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetDragState();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') resetDragState();
    };
    const handleMove = (event: MouseEvent) => {
      if (event.buttons === 0) resetDragState();
    };
    // HTML dragging itself emits pointercancel at startup; it is not an end
    // signal. Releases and resumed input recover a missed native dragend instead.
    const endEvents = ['dragend', 'mouseup', 'pointerup', 'mousedown', 'pointerdown'] as const;
    endEvents.forEach(type => window.addEventListener(type, resetDragState, true));
    window.addEventListener('drop', handleWindowDrop, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('mousemove', handleMove, true);
    window.addEventListener('pointermove', handleMove, true);
    window.addEventListener('blur', resetDragState);
    window.addEventListener('pagehide', resetDragState);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearTimeout(pendingDragEndRef.current);
      pendingDragEndRef.current = undefined;
      endEvents.forEach(type => window.removeEventListener(type, resetDragState, true));
      window.removeEventListener('drop', handleWindowDrop, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('mousemove', handleMove, true);
      window.removeEventListener('pointermove', handleMove, true);
      window.removeEventListener('blur', resetDragState);
      window.removeEventListener('pagehide', resetDragState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [draggedWorkspaceId, resetDragState]);

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
    resetDragState();
    draggedWorkspaceIdRef.current = workspaceId;
    setDraggedWorkspaceId(workspaceId);
  }, [variant, resetDragState]);

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
    const sourceWorkspaceId = draggedWorkspaceIdRef.current;
    const position = dropTargetRef.current?.workspaceId === workspaceId
      ? dropTargetRef.current.position
      : 'after';
    // A drop ends the gesture, including malformed or rejected payloads. Saving
    // the order must not keep feedback alive or later clear a newer gesture.
    resetDragState();
    if (!sourceWorkspaceId) return;

    // On drop, reading dataTransfer data IS allowed.
    const payloadText =
      event.dataTransfer.getData(WORKSPACE_DRAG_MIME_TYPE) ||
      event.dataTransfer.getData('text/plain');

    if (!payloadText) return;

    let payload: WorkspaceDragPayload | null;
    try {
      payload = JSON.parse(payloadText) as WorkspaceDragPayload | null;
    } catch {
      return;
    }

    if (!payload || payload.workspaceId !== sourceWorkspaceId || payload.variant !== variant
      || sourceWorkspaceId === workspaceId) return;

    event.preventDefault();
    event.stopPropagation();

    // Keep the slot measured by dragover, before the drop line changed layout.
    pendingDropRectsRef.current = new Map(
      Array.from(workspaceRowRefs.current, ([id, element]) => (
        [id, element.getBoundingClientRect()] as const
      )),
    );

    try {
      await reorderOpenedWorkspacesInSection(reorderSection, payload.workspaceId, workspaceId, position);
    } catch (error) {
      pendingDropRectsRef.current = null;
      notificationService.error(
        error instanceof Error ? error.message : t('nav.workspaces.reorderFailed'),
        { duration: 4000 }
      );
    }
  }, [reorderOpenedWorkspacesInSection, reorderSection, resetDragState, t, variant]);

  /**
   * One session-group row. Pinned assistants and project workspaces share the
   * same box, but only project rows join the drag group: an assistant row never
   * becomes a drop target, so dropping a project near it cannot reorder it.
   */
  const renderGroupRow = (group: WorkspaceBackedSessionGroup, pinned: boolean) => {
    const workspace = group.workspace;
    const disclosureKey = JSON.stringify([surfaceId, workspace.id]);
    const sessionsCollapsed = (projectDisclosure.requestId === collapseAllRequestId
      ? projectDisclosure.values[disclosureKey] : undefined) ?? (collapseAllRequestId > 0);
    const isActive = isWorkspaceBackedSessionGroupActive(workspace, activeWorkspace);
    const isSelected = isWorkspaceBackedSessionGroupSelected(workspace, {
      activeTab, contentScope, surfaceId, activeWorkspaceId,
    });
    const draggable = !pinned && canReorderGroups;
    return (
      <div
        data-openbitfun-component="workspace-list-section"
        data-openbitfun-part="item"
        data-openbitfun-state={isSelected ? 'selected' : undefined}
        key={workspace.id}
        ref={pinned ? undefined : (element) => {
          if (element) workspaceRowRefs.current.set(workspace.id, element);
          else workspaceRowRefs.current.delete(workspace.id);
        }}
        className={[
          'openbitfun-nav-panel__workspace-drop-target',
          draggable && draggedWorkspaceId && draggedWorkspaceId !== workspace.id && 'is-drag-active',
          dropTarget?.workspaceId === workspace.id && 'is-drop-target',
          dropTarget?.workspaceId === workspace.id && dropTarget.position === 'before' && 'is-before',
          dropTarget?.workspaceId === workspace.id && dropTarget.position === 'after' && 'is-after',
        ].filter(Boolean).join(' ')}
        data-testid={pinned ? 'nav-workspace-pinned-item' : 'nav-workspace-drop-target'}
        data-workspace-id={workspace.id}
        data-workspace-list={variant}
        data-session-group-kind={group.kind}
        data-session-group-pinned={pinned ? 'true' : undefined}
        onDragOver={draggable ? handleDragOver(workspace.id) : undefined}
        onDragLeave={draggable ? handleDragLeave(workspace.id) : undefined}
        onDrop={draggable ? (event) => { void handleDrop(workspace.id)(event); } : undefined}
      >
        <WorkspaceItem
          workspace={workspace}
          remoteBadge={remoteBadges.get(workspace.id)}
          isActive={isActive}
          isSelected={isSelected}
          isSingle={!draggable}
          draggable={draggable}
          isDragging={draggedWorkspaceId === workspace.id}
          onDragStart={draggable ? handleDragStart(workspace.id) : undefined}
          onDragEnd={draggable ? resetDragState : undefined}
          sessionsCollapsed={group.kind === 'project' ? sessionsCollapsed : undefined}
          onSessionsCollapsedChange={group.kind === 'project' ? collapsed => {
            setProjectDisclosure(current => ({
              requestId: collapseAllRequestId,
              values: {
                ...(current.requestId === collapseAllRequestId ? current.values : {}),
                [disclosureKey]: collapsed,
              },
            }));
          } : undefined}
        />
        {dropTarget?.workspaceId === workspace.id ? (
          <div data-openbitfun-component="workspace-list-section" data-openbitfun-part="dropLine" className="openbitfun-nav-panel__workspace-drop-line" aria-hidden="true" />
        ) : null}
      </div>
    );
  };

  return (
    <div data-openbitfun-component="workspace-list-section" data-openbitfun-part="root" data-openbitfun-state={draggedWorkspaceId ? 'dragging' : undefined}
      className={`openbitfun-nav-panel__workspace-list${draggedWorkspaceId ? ' is-dragging' : ''}`}
      data-testid="nav-workspace-list"
      data-workspace-list={variant}
    >
      {workspaces.length === 0 ? (
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
        <>
          {pinnedGroups.map(group => renderGroupRow(group, true))}
          {(reorderableGroups.length > 0 || workspaceScopes.length > 0) && (
            <SessionViewTransition grouping={grouping} surfaceId={surfaceId} scrollRootRef={scrollRootRef}>
              {visibleReorderableGroups.map(group => renderGroupRow(group, false))}
              {grouping === 'all' && workspaceScopes.length > 0 && (
                <div className="openbitfun-nav-panel__workspace-all-sessions" data-testid="nav-workspace-all-sessions">
                  <SessionsSection
                    workspaceScopes={workspaceScopes}
                    isVisible
                    layout="flat"
                    useWorkspaceViewPreferences
                  />
                </div>
              )}
            </SessionViewTransition>
          )}
        </>
      )}
    </div>
  );
};

export default WorkspaceListSection;
