/**
 * WorkspaceBody — main workspace container.
 *
 * Left-right layout:
 *   .nav-area   (300px default, flex-column)
 *     NavBar        (45px — back/forward + drag + WindowControls)
 *     NavPanel      (flex:1 — navigation sidebar)
 *   .scene-area (flex:1, flex-column)
 *     SceneTopBar   (scene tabs + active-scene chrome + WindowControls)
 *     SceneViewport (flex:1 — active scene content)
 */

import React, { useId, useRef, useState } from 'react';
import { useCurrentWorkspace } from '../../infrastructure/contexts/WorkspaceContext';
import { NavBar } from '../components/NavBar';
import NavPanel from '../components/NavPanel/NavPanel';
import { SceneChromeProvider } from '../components/SceneTopBar';
import WorkbenchLayout from '../workbench/WorkbenchLayout';
import { SceneViewport } from '../scenes';
import TerminalActionBridge from '../scenes/terminal/TerminalActionBridge';
import { useApp } from '../hooks/useApp';
import { selectActiveSceneId, useSceneStore } from '../stores/sceneStore';
import { useI18n } from '@/infrastructure/i18n';
import { useNavResize } from './useNavResize';
import './WorkspaceBody.scss';

const NAV_DEFAULT_WIDTH = 300;
const NAV_MIN_WIDTH = 216;
const NAV_MAX_WIDTH = 480;
const COLLAPSE_THRESHOLD = 64;

interface WorkspaceBodyProps {
  className?: string;
  isEntering?: boolean;
  isExiting?: boolean;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
  isMaximized?: boolean;
  sceneOverlay?: React.ReactNode;
}

const WorkspaceBody: React.FC<WorkspaceBodyProps> = ({
  className = '',
  isEntering = false,
  isExiting = false,
  onMinimize,
  onMaximize,
  onClose,
  isMaximized = false,
  sceneOverlay,
}) => {
  const { t } = useI18n('components');
  const navId = useId();
  const { workspace: currentWorkspace } = useCurrentWorkspace();
  const { state, toggleLeftPanel } = useApp();
  const activeSceneId = useSceneStore(selectActiveSceneId);
  const isNavCollapsed = state.layout.leftPanelCollapsed;
  const [navWidth, setNavWidth] = useState(NAV_DEFAULT_WIDTH);
  const navAreaRef = useRef<HTMLDivElement>(null);
  const navDividerRef = useRef<HTMLDivElement>(null);
  const navGripRef = useRef<SVGPathElement>(null);
  const navResize = useNavResize({
    areaRef: navAreaRef,
    dividerRef: navDividerRef,
    gripRef: navGripRef,
    width: navWidth,
    minWidth: NAV_MIN_WIDTH,
    maxWidth: NAV_MAX_WIDTH,
    collapseThreshold: COLLAPSE_THRESHOLD,
    collapsed: isNavCollapsed,
    onWidthChange: setNavWidth,
    onCollapse: toggleLeftPanel,
  });

  return (
    <div
      className={`openbitfun-workspace-body${isEntering ? ' is-entering' : ''}${isExiting ? ' is-exiting' : ''} ${className}`}
      data-openbitfun-scene="workbench"
      data-openbitfun-part="workspace"
      data-openbitfun-state={isNavCollapsed ? 'collapsed' : undefined}
    >
      <div
        className="openbitfun-workspace-body__material"
        data-openbitfun-scene="workbench"
        data-openbitfun-part="workspaceMaterial"
        data-openbitfun-theme-scope="chrome"
        aria-hidden="true"
      />
      {isNavCollapsed && (
        <div className="openbitfun-workspace-body__collapsed-nav" data-openbitfun-scene="workbench" data-openbitfun-part="collapsedNav">
          <NavBar isCollapsed onExpandNav={toggleLeftPanel} onMaximize={onMaximize} />
        </div>
      )}

      {/* Left: nav history bar + navigation sidebar — always rendered for slide animation */}
      <div
        id={navId}
        ref={navAreaRef}
        className={`openbitfun-workspace-body__nav-area${isNavCollapsed ? ' is-collapsed' : ''}`}
        style={isNavCollapsed ? undefined : { '--nav-width': `${navWidth}px` } as React.CSSProperties}
        data-openbitfun-scene="workbench"
        data-openbitfun-part="navArea"
        data-openbitfun-theme-scope="chrome"
        data-openbitfun-state={isNavCollapsed ? 'collapsed' : undefined}
      >
        <NavBar onExpandNav={toggleLeftPanel} onMaximize={onMaximize} />
        <NavPanel className="openbitfun-workspace-body__nav-panel" />
        <div data-openbitfun-creation-slot="sidebar-footer" />
      </div>

      <TerminalActionBridge />

      {/* Resize divider — placed at workspace-body level to avoid overflow:hidden clipping */}
      {!isNavCollapsed && (
        <div
          ref={navDividerRef}
          className="openbitfun-workspace-body__nav-divider"
          style={{ '--nav-width': `${navWidth}px` } as React.CSSProperties}
          {...navResize}
          role="separator"
          tabIndex={0}
          aria-label={t('canvas.resizePanes')}
          aria-orientation="vertical"
          aria-controls={navId}
          aria-valuemin={NAV_MIN_WIDTH}
          aria-valuemax={NAV_MAX_WIDTH}
          aria-valuenow={navWidth}
          data-openbitfun-scene="workbench"
          data-openbitfun-part="navDivider"
          data-openbitfun-theme-scope="chrome"
        >
          <svg className="openbitfun-workspace-body__nav-grip" viewBox="0 0 48 120" aria-hidden="true" focusable="false">
            <path ref={navGripRef} d="M 24 44 L 24 76" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}

      {/* Right: visual scene surface + any shell-level overlay */}
      <div className="openbitfun-workspace-body__scene-area" data-openbitfun-scene="workbench" data-openbitfun-part="sceneArea">
        <div
          className="openbitfun-workspace-body__scene-surface"
          data-openbitfun-scene="workbench"
          data-openbitfun-part="sceneSurface"
        >
          <SceneChromeProvider activeSceneId={activeSceneId}>
            <div data-openbitfun-creation-slot="scene-header" />
            <WorkbenchLayout
              workspacePath={currentWorkspace?.rootPath}
              onMinimize={onMinimize}
              onMaximize={onMaximize}
              onClose={onClose}
              isMaximized={isMaximized}
            >
              <SceneViewport paned
                workspacePath={currentWorkspace?.rootPath}
                isEntering={isEntering}
              />
            </WorkbenchLayout>
            <div data-openbitfun-creation-slot="scene-footer" />
          </SceneChromeProvider>
        </div>
        {sceneOverlay}
      </div>
    </div>
  );
};

export default WorkspaceBody;
