import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ArrowLeftRight, Maximize2, Minimize2 } from 'lucide-react';
import { Icon, IconButton, SplitView, SplitViewSurface, ToolbarGroup, Tooltip, type SplitViewHeaderGeometry } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import SceneBar from '../components/SceneBar/SceneBar';
import { getSceneViewId } from '../components/SceneBar/types';
import { SceneChromeHost } from '../components/SceneTopBar/SceneChrome';
import { useSceneStore } from '../stores/sceneStore';
import { dropSceneTab, isSceneTabDrag } from './sceneTabTransfer';
import { dropSessionTabOnWorkbench, isSessionTabDrag } from './canvasTabTransfer';
import { observeTabDragLifecycle } from './tabDragLifecycle';
import { selectedScene, type WorkbenchPane } from './scenePaneModel';
import { SceneTopBar } from '../components/SceneTopBar';
import { CanvasToolbarHost, CanvasToolbarProvider } from '../components/panels/content-canvas/CanvasToolbar';
import AuxPane from '../scenes/session/AuxPane';
import { useWorkbenchPaneLayout } from './workbenchPaneLayoutStore';
import { PANEL_COMMON_CONFIG, RIGHT_PANEL_CONFIG } from '../layout/panelConfig';
import './WorkbenchLayout.scss';

type WorkbenchLayoutProps = React.ComponentProps<typeof SceneTopBar> & {
  workspacePath?: string;
  children: React.ReactNode;
};

/** The shell owns both content regions and their chrome, independently of scenes. */
export default function WorkbenchLayout({ workspacePath, children, ...windowProps }: WorkbenchLayoutProps) {
  const pane = useWorkbenchPaneLayout();
  const { t } = useI18n('components');
  const { t: tCommon } = useI18n('common');
  const [resizing, setResizing] = useState(false);
  const [settling, setSettling] = useState(false);
  const [offeredTab, setOfferedTab] = useState(false);
  const [dropTarget, setDropTarget] = useState<'leading' | 'trailing' | null>(null);
  const panelOpen = pane.mode !== 'chat-only';
  const panelMaximized = pane.mode === 'content-only';
  const selections = useSceneStore(state => state.paneSelections);
  const hasSecondaryScenes = useSceneStore(state => state.openTabs.some(tab => tab.pane === 'secondary'));
  const canvasPane = useSceneStore(state => state.canvasPane);
  const canvasActive = selections[canvasPane].kind === 'canvas';
  const canvasVisible = canvasActive && (canvasPane === 'primary' ? !panelMaximized : panelOpen);
  const leadingPane: WorkbenchPane = pane.contentSide === 'left' && panelOpen && !panelMaximized ? 'secondary' : 'primary';
  const trailingPane: WorkbenchPane = leadingPane === 'primary' ? 'secondary' : 'primary';
  const accepts = (data: DataTransfer) => isSceneTabDrag(data) || isSessionTabDrag(data);
  useEffect(() => {
    const offer = (event: DragEvent) => setOfferedTab(Boolean(event.dataTransfer && accepts(event.dataTransfer)));
    const clear = () => { setOfferedTab(false); setDropTarget(null); };
    const stopDragListener = observeTabDragLifecycle(offer, clear);
    const stop = onSurfaceActivated(clear);
    return () => {
      stopDragListener();
      stop();
    };
  }, []);
  useLayoutEffect(() => {
    setSettling(true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setSettling(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [pane.mode, pane.contentSide, pane.displayMode, pane.preferredRightPaneWidth, pane.preferredOverlayWidth]);
  const panelLabel = tCommon(panelOpen ? 'header.collapseRightPanel' : 'header.expandRightPanel');
  const maximizeLabel = t(pane.mode === 'content-only' ? 'canvas.restorePanel' : 'canvas.maximizePanel');
  const dropOnPane = (event: React.DragEvent, location: WorkbenchPane) => {
    if (!accepts(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (isSceneTabDrag(event.dataTransfer)) void dropSceneTab(event.dataTransfer, location);
    else dropSessionTabOnWorkbench(event.dataTransfer, undefined, location);
  };

  const renderTabs = (location: WorkbenchPane) => <div className="openbitfun-workbench-layout__pane-tabs"
    data-openbitfun-scene="workbench" data-openbitfun-part="paneTabs">
    {(location === 'primary' || hasSecondaryScenes) && <SceneBar pane={location} showDropHint={false} />}
    {location === canvasPane && <div className="openbitfun-workbench-layout__canvas-tabs" data-openbitfun-scene="workbench" data-openbitfun-part="canvasTabs" data-shortcut-scope="canvas"
      onPointerDownCapture={() => useSceneStore.getState().selectCanvas()}
      onFocusCapture={() => useSceneStore.getState().selectCanvas()}>
      <CanvasToolbarHost />
    </div>}
  </div>;
  const header = (geometry: SplitViewHeaderGeometry) => <SceneTopBar {...windowProps} columnClassName={geometry.columnClassName}
      panelOpen={panelOpen}
      panelMaximized={panelMaximized}
      mainTabs={renderTabs(leadingPane)}
      mainSceneId={selectedScene(selections[leadingPane]) ? getSceneViewId(selectedScene(selections[leadingPane])!) : null}
      tabDragActive={offeredTab}
      tabDropTarget={dropTarget}
      onTabDragOver={(event, side) => {
        if (!accepts(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOfferedTab(true);
        setDropTarget(side);
      }}
      onTabDragLeave={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
      }}
      onMainDragOver={event => {
        if (!accepts(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onMainDrop={event => dropOnPane(event, leadingPane)}
      panelTabs={<>
        {panelOpen && renderTabs(trailingPane)}
        {panelOpen && <SceneChromeHost className="openbitfun-scene-top-bar__actions" sceneId={selectedScene(selections[trailingPane]) ? getSceneViewId(selectedScene(selections[trailingPane])!) : null} />}
      </>}
      onPanelDragOver={event => {
        if (!accepts(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onPanelDrop={event => dropOnPane(event, trailingPane)}
      panelToggle={<ToolbarGroup gap="sm">
        {panelOpen && <Tooltip content={maximizeLabel}>
          <IconButton size="xs" aria-label={maximizeLabel} aria-pressed={pane.mode === 'content-only'}
            data-testid="workbench-maximize-panel" icon={<Icon glyph={pane.mode === 'content-only' ? Minimize2 : Maximize2} size="sm" />}
            onClick={pane.toggleMaximized} />
        </Tooltip>}
        <Tooltip content={panelLabel}>
          <IconButton size="xs" aria-label={panelLabel} aria-pressed={panelOpen}
            data-testid="workbench-toggle-panel" icon={<Icon name="sidebar-right" size="sm" />}
            onClick={pane.toggleContent} />
        </Tooltip>
      </ToolbarGroup>}
    />;
  return <CanvasToolbarProvider>
    <div className="openbitfun-workbench-layout__body" data-openbitfun-scene="workbench" data-openbitfun-part="contentLayout">
      <SplitView header={header}
        mode={pane.mode === 'chat-only' ? 'primary' : pane.mode === 'content-only' ? 'secondary' : 'split'}
        layout={pane.displayMode} secondarySide={pane.contentSide}
        rightSize={pane.displayMode === 'overlay' ? pane.preferredOverlayWidth : pane.preferredRightPaneWidth}
        minLeftSize={PANEL_COMMON_CONFIG.MIN_CENTER_WIDTH}
        minRightSize={RIGHT_PANEL_CONFIG.COMPACT_WIDTH} maxRightSize={RIGHT_PANEL_CONFIG.MAX_WIDTH}
        defaultRightSize={RIGHT_PANEL_CONFIG.COMFORTABLE_DEFAULT}
        onRightSizeChange={pane.displayMode === 'overlay' ? pane.resizeOverlay : pane.resizeRightPane}
        onResizeStateChange={setResizing} dividerLabel={t('canvas.resizePanes')}
        dividerActions={<Tooltip content={t('canvas.swapPanes')} placement="top">
          <IconButton size="sm" aria-label={t('canvas.swapPanes')}
            icon={<Icon glyph={ArrowLeftRight} size="sm" />} onClick={pane.swapPanes} />
        </Tooltip>}
        surfaces={<>{children}<SplitViewSurface pane={canvasPane} active={canvasActive}
          aria-label={t('canvas.contentPane')} data-shortcut-scope="canvas"
          onPointerDownCapture={() => useSceneStore.getState().focusPane(canvasPane)}
          onFocusCapture={() => useSceneStore.getState().focusPane(canvasPane)}>
          {/* Keep the skin address while the canvas moves between stable surface slots. */}
          <div className="openbitfun-workbench-layout__auxiliary" data-openbitfun-scene="session" data-openbitfun-part="auxiliary">
            <AuxPane workspacePath={workspacePath} externalToolbar isSceneActive={canvasVisible}
              terminalResizeSuspended={resizing || settling} />
          </div>
        </SplitViewSurface></>}
      />
    </div>
  </CanvasToolbarProvider>;
}
