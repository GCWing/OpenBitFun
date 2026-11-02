import React, { useCallback } from 'react';
import { Toolbar, ToolbarSeparator } from '@openbitfun/ui';
import { WindowControls } from '@/app/components/WindowControls';
import { startNativeWindowDragging, supportsNativeWindowDragging } from '@/infrastructure/runtime';
import { createLogger } from '@/shared/utils/logger';
import { useSceneStore } from '../../stores/sceneStore';
import type { SceneTabId } from '../SceneBar/types';
import SceneBar from '../SceneBar/SceneBar';
import { SceneChromeHost } from './SceneChrome';
import './SceneTopBar.scss';

const log = createLogger('SceneTopBar');

const INTERACTIVE_SELECTOR =
  'button, input, textarea, select, a, [role="button"], [role="tab"], [role="menu"], [contenteditable]:not([contenteditable="false"]), [draggable="true"], .window-controls';

function blocksWindowChromeInteraction(
  event: React.MouseEvent<HTMLDivElement>,
): boolean {
  const target = event.target;
  if (event.defaultPrevented || !(target instanceof Element) || !event.currentTarget.contains(target)) {
    return true;
  }

  // The whole tab, including item padding, belongs to tab interaction.
  if (target.closest('[data-openbitfun-component="tab-group"] [data-openbitfun-part="item"]')) {
    return true;
  }
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

interface SceneTopBarProps {
  className?: string;
  panelOpen?: boolean;
  panelMaximized?: boolean;
  mainTabs?: React.ReactNode;
  columnClassName?: string;
  mainSceneId?: SceneTabId | null;
  panelTabs?: React.ReactNode;
  panelToggle?: React.ReactNode;
  tabDragActive?: boolean;
  tabDropTarget?: 'leading' | 'trailing' | null;
  onTabDragOver?: (event: React.DragEvent<HTMLDivElement>, side: 'leading' | 'trailing') => void;
  onTabDragLeave?: React.DragEventHandler<HTMLDivElement>;
  onMainDragOver?: React.DragEventHandler<HTMLDivElement>;
  onMainDrop?: React.DragEventHandler<HTMLDivElement>;
  onPanelDragOver?: React.DragEventHandler<HTMLDivElement>;
  onPanelDrop?: React.DragEventHandler<HTMLDivElement>;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
  isMaximized?: boolean;
}

const SceneTopBar: React.FC<SceneTopBarProps> = ({
  className = '',
  panelOpen = false,
  panelMaximized = false,
  mainTabs, mainSceneId, columnClassName,
  panelTabs,
  panelToggle,
  tabDragActive = false,
  tabDropTarget,
  onTabDragOver,
  onTabDragLeave,
  onMainDragOver,
  onMainDrop,
  onPanelDragOver,
  onPanelDrop,
  onMinimize,
  onMaximize,
  onClose,
  isMaximized = false,
}) => {
  const hasTabs = useSceneStore(state => state.openTabs.length > 0);
  const canDragWindow = supportsNativeWindowDragging();
  const hasWindowControls = Boolean(onMinimize && onMaximize && onClose);
  const isLeadingTarget = (event: React.DragEvent<HTMLDivElement>) =>
    event.target instanceof Node && event.currentTarget
      .querySelector(':scope > [data-openbitfun-part="leading"]')?.contains(event.target);

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canDragWindow || event.button !== 0 || event.detail > 1) return;
    if (blocksWindowChromeInteraction(event)) return;

    void startNativeWindowDragging().catch(error => {
      log.debug('startDragging failed', { error });
    });
  }, [canDragWindow]);

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canDragWindow || event.button !== 0 || blocksWindowChromeInteraction(event)) return;
    onMaximize?.();
  }, [canDragWindow, onMaximize]);

  return (
    <Toolbar
      bordered={hasTabs || panelOpen}
      className={`openbitfun-scene-top-bar ${panelOpen && !panelMaximized ? columnClassName ?? '' : ''} ${className}`.trim()}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onDragOverCapture={event => onTabDragOver?.(event, isLeadingTarget(event) ? 'leading' : 'trailing')}
      onDragLeave={onTabDragLeave}
      onDragOver={event => (isLeadingTarget(event) ? onMainDragOver : onPanelDragOver)?.(event)}
      onDrop={event => (isLeadingTarget(event) ? onMainDrop : onPanelDrop)?.(event)}
      data-openbitfun-scene="workbench"
      data-openbitfun-part="topBar"
      data-panel-open={panelOpen}
      data-panel-maximized={panelMaximized || undefined}
      data-tab-drag-active={tabDragActive || undefined}
      data-tab-drop-target={tabDragActive ? tabDropTarget ?? undefined : undefined}
      leading={panelMaximized ? undefined : <>
        {mainTabs ?? <SceneBar showDropHint={false} />}
        <SceneChromeHost sceneId={mainSceneId}
          className="openbitfun-scene-top-bar__actions"
          data-openbitfun-scene="workbench"
          data-openbitfun-part="sceneActions"
        />
      </>}
      size="md"
      trailing={<>
        {panelToggle && !panelMaximized && <ToolbarSeparator className="openbitfun-scene-top-bar__panel-divider" />}
        <div className="openbitfun-scene-top-bar__panel-region">
          {panelOpen && <div className="openbitfun-scene-top-bar__panel-tabs">
            {panelTabs}
          </div>}
          {panelToggle}
        </div>
        {hasWindowControls ? (
          <>
            <ToolbarSeparator className="openbitfun-scene-top-bar__actions-divider" />
            <div
              className="openbitfun-scene-top-bar__window-controls"
              data-openbitfun-component="scene-bar"
              data-openbitfun-part="controls"
            >
              <WindowControls
                onMinimize={onMinimize!}
                onToggleMaximize={onMaximize!}
                onClose={onClose!}
                maximized={isMaximized}
              />
            </div>
          </>
        ) : null}
      </>}
    />
  );
};

export default SceneTopBar;
