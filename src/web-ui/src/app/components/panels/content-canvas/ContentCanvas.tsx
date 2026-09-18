/**
 * ContentCanvas main container component.
 * Shared content surface. The containing scene or panel owns its layout.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { EditorArea } from './editor-area';
import { AnchorZone } from './anchor-zone';
import { MissionControl } from './mission-control';
import { EmptyState } from './empty-state';
import { useCanvasStore } from './stores';
import { useTabLifecycle, useKeyboardShortcuts } from './hooks';
import type { AnchorPosition } from './types';
import type { CanvasStoreMode } from './stores/canvasStore';
import { selectActiveBtwSessionTab, type BtwSessionPanelData } from '@/flow_chat/services/btwSessionPane';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { isSamePath } from '@/shared/utils/pathUtils';
import './ContentCanvas.scss';
export interface ContentCanvasProps {
  /** Workspace path */
  workspacePath?: string;
  /** App mode */
  mode?: CanvasStoreMode;
  /** Whether the containing scene is currently visible */
  isSceneActive?: boolean;
  /** Interaction callback */
  onInteraction?: (itemId: string, userInput: string) => Promise<void>;
  /** Before-close callback */
  onBeforeClose?: (content: any) => Promise<boolean>;
  /** Disable transfer and host-close controls for embedded hosts. */
  disablePopOut?: boolean;
  /** Override the event this canvas listens to for creating tabs. */
  createTabEventName?: string;
  /** Reveal this host after an explicit content-open request. */
  onReveal?: () => void;
  /** Close the containing panel, when this host is collapsible. */
  onCollapsePanel?: () => void;
  /** Suspend terminal fit/PTY resize while the hosting panel is animating. */
  terminalResizeSuspended?: boolean;
  /** Whether this host exposes Mission Control. */
  missionControlEnabled?: boolean;
  /** Host-provided content for the no-tabs state. */
  emptyState?: React.ReactNode;
}

export const ContentCanvas: React.FC<ContentCanvasProps> = ({
  workspacePath,
  mode = 'agent',
  isSceneActive = true,
  onInteraction,
  disablePopOut = false,
  createTabEventName,
  onReveal,
  onCollapsePanel,
  terminalResizeSuspended = false,
  missionControlEnabled = true,
  emptyState,
}) => {
  // Store state — fine-grained selectors so unrelated store changes
  // (drag state, closed-tab history, ...) do not re-render the whole canvas.
  const primaryGroup = useCanvasStore(state => state.primaryGroup);
  const secondaryGroup = useCanvasStore(state => state.secondaryGroup);
  const tertiaryGroup = useCanvasStore(state => state.tertiaryGroup);
  const layout = useCanvasStore(state => state.layout);
  const isMissionControlOpen = useCanvasStore(state => state.isMissionControlOpen);
  const setAnchorPosition = useCanvasStore(state => state.setAnchorPosition);
  const setAnchorSize = useCanvasStore(state => state.setAnchorSize);
  const closeMissionControl = useCanvasStore(state => state.closeMissionControl);
  const openMissionControl = useCanvasStore(state => state.openMissionControl);
  const activeBtwSessionTab = useCanvasStore(state => selectActiveBtwSessionTab(state as any));
  const activeBtwSessionData = activeBtwSessionTab?.content.data as BtwSessionPanelData | undefined;
  const { workspace: currentWorkspace } = useCurrentWorkspace();
  const currentWorkspaceId = currentWorkspace?.id;
  const lastSyncedBtwTabIdRef = useRef<string | null>(null);
  // Initialize hooks
  const { handleCloseWithDirtyCheck, handleCloseAllWithDirtyCheck } = useTabLifecycle({
    mode,
    createTabEventName,
    onReveal,
  });
  useKeyboardShortcuts({
    enabled: isSceneActive,
    missionControlEnabled,
    handleCloseWithDirtyCheck,
    onReveal,
  });

  useEffect(() => {
    if (mode !== 'agent' || !activeBtwSessionTab?.id || !activeBtwSessionData?.parentSessionId) {
      lastSyncedBtwTabIdRef.current = null;
      return;
    }

    if (lastSyncedBtwTabIdRef.current === activeBtwSessionTab.id) {
      return;
    }

    // Only sync when the BTW session belongs to the current workspace,
    // preventing the wrong session from opening when switching workspaces.
    // Workspace ID is the identity; the path check only serves tabs restored
    // from a canvas snapshot written before tabs recorded a workspace ID.
    const btwWorkspaceId = activeBtwSessionData.workspaceId;
    const btwProjectWorkspaceId = activeBtwSessionData.projectWorkspaceId;
    const btwWorkspacePath = activeBtwSessionData.workspacePath;
    const belongsToCurrentWorkspace = btwWorkspaceId
      ? !currentWorkspaceId
        || btwWorkspaceId === currentWorkspaceId
        || btwProjectWorkspaceId === currentWorkspaceId
      : !(workspacePath && btwWorkspacePath && !isSamePath(workspacePath, btwWorkspacePath));
    if (!belongsToCurrentWorkspace) {
      lastSyncedBtwTabIdRef.current = activeBtwSessionTab.id;
      return;
    }

    lastSyncedBtwTabIdRef.current = activeBtwSessionTab.id;
    void openMainSession(activeBtwSessionData.parentSessionId);
  }, [
    activeBtwSessionData?.parentSessionId,
    activeBtwSessionData?.projectWorkspaceId,
    activeBtwSessionData?.workspaceId,
    activeBtwSessionData?.workspacePath,
    activeBtwSessionTab?.id,
    currentWorkspaceId,
    mode,
    workspacePath,
  ]);

  // Keep the editor area mounted for legacy hidden terminal tabs restored from
  // an older canvas snapshot. New terminal closes destroy and remove the tab.
  const hasRenderableTabs = useMemo(() => {
    const groups = [primaryGroup, secondaryGroup, tertiaryGroup];
    return groups.some(group =>
      group.tabs.some(tab => !tab.isHidden || tab.content.type === 'terminal')
    );
  }, [primaryGroup, secondaryGroup, tertiaryGroup]);

  // Handle anchor close
  const handleAnchorClose = useCallback(() => {
    setAnchorPosition('hidden');
  }, [setAnchorPosition]);

  // Handle anchor position change
  const handleAnchorPositionChange = useCallback((position: AnchorPosition) => {
    setAnchorPosition(position);
  }, [setAnchorPosition]);

  // Handle anchor size change
  const handleAnchorSizeChange = useCallback((size: number) => {
    setAnchorSize(size);
  }, [setAnchorSize]);

  // Handle mission control open
  const handleOpenMissionControl = useCallback(() => {
    openMissionControl();
  }, [openMissionControl]);

  // Handle mission control close
  const handleCloseMissionControl = useCallback(() => {
    closeMissionControl();
  }, [closeMissionControl]);

  // Render content
  const renderContent = () => {
    // Show empty state when there are no visible tabs and no terminal keep-alive tabs.
    if (!hasRenderableTabs) {
      return (
        <EmptyState onClose={disablePopOut ? undefined : onCollapsePanel}>
          {emptyState}
        </EmptyState>
      );
    }

    return (
      <div data-openbitfun-component="content-canvas" data-openbitfun-part="main" className="canvas-content-canvas__main">
        {/* Editor area */}
        <div className="canvas-content-canvas__editor" data-openbitfun-component="content-canvas" data-openbitfun-part="editor">
          <EditorArea
            workspacePath={workspacePath}
            isSceneActive={isSceneActive}
            onOpenMissionControl={missionControlEnabled ? handleOpenMissionControl : undefined}
            onInteraction={onInteraction}
            onTabCloseWithDirtyCheck={handleCloseWithDirtyCheck}
            onTabCloseAllWithDirtyCheck={handleCloseAllWithDirtyCheck}
            disablePopOut={disablePopOut}
            terminalResizeSuspended={terminalResizeSuspended}
          />
        </div>

        {/* Anchor area */}
        {layout.anchorPosition !== 'hidden' && (
          <AnchorZone
            position={layout.anchorPosition}
            size={layout.anchorSize}
            onSizeChange={handleAnchorSizeChange}
            onPositionChange={handleAnchorPositionChange}
            onClose={handleAnchorClose}
          >
            {/* Anchor content (e.g., terminal) renders here */}
            <div className="canvas-content-canvas__anchor-content" data-openbitfun-component="content-canvas" data-openbitfun-part="anchorContent">
            </div>
          </AnchorZone>
        )}
      </div>
    );
  };

  return (
    <div data-openbitfun-component="content-canvas" data-openbitfun-part="root"
      className={`canvas-content-canvas ${layout.isMaximized ? 'is-maximized' : ''}`}
      data-canvas-mode={mode}
      data-openbitfun-mode={mode}
      data-openbitfun-state={layout.isMaximized ? 'maximized' : ''}
      data-shortcut-scope="canvas"
    >
      {/* Main content */}
      {renderContent()}

      {/* Mission control overlay */}
      {missionControlEnabled && (
        <MissionControl
          isOpen={isMissionControlOpen}
          onClose={handleCloseMissionControl}
          handleCloseWithDirtyCheck={handleCloseWithDirtyCheck}
        />
      )}
    </div>
  );
};
ContentCanvas.displayName = 'ContentCanvas';

export default ContentCanvas;
