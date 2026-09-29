/** Session-owned composition over the shared, controlled SplitView. */
import { ArrowLeftRight, GripHorizontal } from 'lucide-react';
import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { Icon, IconButton, SplitView, Tooltip } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { useApp } from '../../hooks/useApp';
import ChatPane from './ChatPane';
import AuxPane from './AuxPane';
import BottomTerminalPane from './BottomTerminalPane';
import { collapseSessionBottomTerminalPane, expandSessionBottomTerminalPane } from './sessionPanelLayout';
import { useSessionPaneLayout } from './sessionPaneLayoutStore';
import {
  getCachedTerminalPanelPosition, onTerminalPanelPositionChange, refreshTerminalPanelPosition,
} from '@/tools/terminal/services/terminalPanelPreferenceService';
import type { TerminalPanelPosition } from '@/infrastructure/config/types';
import {
  BOTTOM_TERMINAL_PANEL_CONFIG, RIGHT_PANEL_CONFIG, PANEL_COMMON_CONFIG, STORAGE_KEYS,
  getPanelDisplayMode, getModeWidth, getSnappedWidth, getNextMode, savePanelWidth, loadPanelWidth,
} from '../../layout/panelConfig';
import './SessionScene.scss';

const TERMINAL_PANEL_RESIZE_SUSPEND_FALLBACK_MS = 360;

interface SessionSceneProps {
  workspacePath?: string;
  isEntering?: boolean;
  isActive?: boolean;
}

const SessionScene: React.FC<SessionSceneProps> = ({ workspacePath, isEntering = false, isActive = true }) => {
  const { t } = useI18n('flow-chat');
  const { t: tPane } = useI18n('components');
  const { state, updateBottomTerminalPanelHeight } = useApp();
  const pane = useSessionPaneLayout();
  const [isDraggingContent, setIsDraggingContent] = useState(false);
  const [isContentSettling, setIsContentSettling] = useState(false);
  const [isDraggingBottom, setIsDraggingBottom] = useState(false);
  const [isHoveringBottom, setIsHoveringBottom] = useState(false);
  const [isBottomTerminalPanelTransitioning, setIsBottomTerminalPanelTransitioning] = useState(false);
  const [terminalPanelPosition, setTerminalPanelPosition] = useState<TerminalPanelPosition>(getCachedTerminalPanelPosition);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomTerminalPaneElementRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const bottomPanelTransitionTimerRef = useRef<number | null>(null);
  const previousBottomTransitionKeyRef = useRef<string | null>(null);
  const bottomDragCleanupRef = useRef<(() => void) | null>(null);
  const currentBottomHeight = state.layout.bottomTerminalPanelHeight || BOTTOM_TERMINAL_PANEL_CONFIG.COMFORTABLE_DEFAULT;
  const isTerminalDockedBottom = terminalPanelPosition === 'bottom';
  const isContentOnly = pane.mode === 'content-only';
  const isBottomHidden = isContentOnly || state.layout.bottomTerminalPanelCollapsed;
  const isDragging = isDraggingContent || isDraggingBottom;
  const bottomTerminalPanelMode = isBottomHidden ? 'collapsed'
    : getPanelDisplayMode(currentBottomHeight, BOTTOM_TERMINAL_PANEL_CONFIG);

  useEffect(() => {
    const stop = onTerminalPanelPositionChange(setTerminalPanelPosition);
    void refreshTerminalPanelPosition();
    return stop;
  }, []);

  // Heavy content measures only the settled layout, not intermediate drag sizes.
  useLayoutEffect(() => {
    setIsContentSettling(true);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setIsContentSettling(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [pane.mode, pane.contentSide, pane.preferredRightPaneWidth]);

  useLayoutEffect(() => {
    const element = bottomTerminalPaneElementRef.current;
    if (element) element.inert = isBottomHidden || !isActive;
  }, [isBottomHidden, isActive, isTerminalDockedBottom]);

  const stopBottomPanelTransition = useCallback(() => {
    if (bottomPanelTransitionTimerRef.current !== null) window.clearTimeout(bottomPanelTransitionTimerRef.current);
    bottomPanelTransitionTimerRef.current = null;
    setIsBottomTerminalPanelTransitioning(false);
  }, []);

  const startBottomPanelTransition = useCallback(() => {
    if (bottomPanelTransitionTimerRef.current !== null) window.clearTimeout(bottomPanelTransitionTimerRef.current);
    setIsBottomTerminalPanelTransitioning(true);
    bottomPanelTransitionTimerRef.current = window.setTimeout(stopBottomPanelTransition, TERMINAL_PANEL_RESIZE_SUSPEND_FALLBACK_MS);
  }, [stopBottomPanelTransition]);

  const calculateValidBottomHeight = useCallback((height: number): number => {
    const containerHeight = containerRef.current?.offsetHeight ?? 0;
    if (containerHeight <= 0) return height;
    const max = Math.max(0, Math.min(BOTTOM_TERMINAL_PANEL_CONFIG.MAX_WIDTH, containerHeight - PANEL_COMMON_CONFIG.RESIZER_WIDTH - 220));
    return Math.min(max, Math.max(Math.min(BOTTOM_TERMINAL_PANEL_CONFIG.COMPACT_WIDTH, max), height));
  }, []);

  const saveAndUpdateBottomHeight = useCallback((height: number) => {
    updateBottomTerminalPanelHeight(height);
    savePanelWidth(STORAGE_KEYS.BOTTOM_TERMINAL_PANEL_LAST_HEIGHT, height);
  }, [updateBottomTerminalPanelHeight]);

  const handleBottomDoubleClick = useCallback(() => {
    const target = getModeWidth(getNextMode(bottomTerminalPanelMode), BOTTOM_TERMINAL_PANEL_CONFIG);
    saveAndUpdateBottomHeight(calculateValidBottomHeight(target));
  }, [bottomTerminalPanelMode, calculateValidBottomHeight, saveAndUpdateBottomHeight]);

  const handleMouseDownBottomResizer = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;

    const startY = e.clientY;
    const startHeight = currentBottomHeight;
    let lastValidHeight = startHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setIsDraggingBottom(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      lastValidHeight = calculateValidBottomHeight(startHeight + (startY - ev.clientY));
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(() => {
        if (bottomTerminalPaneElementRef.current) {
          bottomTerminalPaneElementRef.current.style.height = `${lastValidHeight}px`;
        }
        animationFrameRef.current = null;
      });
    };

    const cleanup = () => {
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      bottomDragCleanupRef.current = null;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
    function onUp(event: MouseEvent) {
      lastValidHeight = calculateValidBottomHeight(startHeight + (startY - event.clientY));
      cleanup();
      const snapped = getSnappedWidth(lastValidHeight, BOTTOM_TERMINAL_PANEL_CONFIG, false);
      if (snapped !== lastValidHeight) {
        saveAndUpdateBottomHeight(snapped);
      } else {
        updateBottomTerminalPanelHeight(lastValidHeight);
        savePanelWidth(STORAGE_KEYS.BOTTOM_TERMINAL_PANEL_LAST_HEIGHT, lastValidHeight);
      }
      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = requestAnimationFrame(() => {
          animationFrameRef.current = null;
          setIsDraggingBottom(false);
        });
      });
    }

    bottomDragCleanupRef.current = cleanup;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [calculateValidBottomHeight, currentBottomHeight, saveAndUpdateBottomHeight, updateBottomTerminalPanelHeight]);


  const expandBottomTerminalPanel = useCallback(() => {
    const saved = loadPanelWidth(STORAGE_KEYS.BOTTOM_TERMINAL_PANEL_LAST_HEIGHT, BOTTOM_TERMINAL_PANEL_CONFIG.COMFORTABLE_DEFAULT);
    expandSessionBottomTerminalPane(calculateValidBottomHeight(saved));
  }, [calculateValidBottomHeight]);

  useEffect(() => {
    if (!isTerminalDockedBottom) return;
    const validate = () => {
      const valid = calculateValidBottomHeight(currentBottomHeight);
      if (valid !== currentBottomHeight) updateBottomTerminalPanelHeight(valid);
    };
    const frame = requestAnimationFrame(validate);
    window.addEventListener('resize', validate);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', validate); };
  }, [isTerminalDockedBottom, calculateValidBottomHeight, currentBottomHeight, updateBottomTerminalPanelHeight]);

  useEffect(() => () => {
    bottomDragCleanupRef.current?.();
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (bottomPanelTransitionTimerRef.current !== null) window.clearTimeout(bottomPanelTransitionTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const key = `${isBottomHidden}:${currentBottomHeight}:${isTerminalDockedBottom}`;
    const previous = previousBottomTransitionKeyRef.current;
    previousBottomTransitionKeyRef.current = key;
    if (previous !== null && key !== previous && !isDraggingBottom && isTerminalDockedBottom) startBottomPanelTransition();
  }, [isBottomHidden, currentBottomHeight, isTerminalDockedBottom, isDraggingBottom, startBottomPanelTransition]);

  const panelModeLabels = useMemo(() => ({
    collapsed: t('layout.panelMode.collapsed'), compact: t('layout.panelMode.compact'),
    comfortable: t('layout.panelMode.comfortable'), expanded: t('layout.panelMode.expanded'),
  }), [t]);

  return (
    <div ref={containerRef}
      className={[
        'openbitfun-session-scene', isDragging && 'openbitfun-session-scene--dragging',
        isDraggingBottom && 'openbitfun-session-scene--dragging-bottom',
        isTerminalDockedBottom && 'openbitfun-session-scene--terminal-bottom', isEntering && 'layout-entering',
      ].filter(Boolean).join(' ')}
      data-testid="session-scene" data-openbitfun-scene="session" data-openbitfun-part="root"
      data-openbitfun-state={[isDragging && 'dragging', isTerminalDockedBottom && 'terminal-bottom'].filter(Boolean).join(' ') || undefined}
    >
      <div className="openbitfun-session-scene__main-row" data-openbitfun-scene="session" data-openbitfun-part="main">
        <SplitView
          mode={pane.mode === 'chat-only' ? 'primary' : pane.mode === 'content-only' ? 'secondary' : 'split'}
          secondarySide={pane.contentSide}
          rightSize={pane.preferredRightPaneWidth}
          minLeftSize={PANEL_COMMON_CONFIG.MIN_CENTER_WIDTH}
          minRightSize={RIGHT_PANEL_CONFIG.COMPACT_WIDTH}
          maxRightSize={RIGHT_PANEL_CONFIG.MAX_WIDTH}
          defaultRightSize={RIGHT_PANEL_CONFIG.COMFORTABLE_DEFAULT}
          onRightSizeChange={pane.resizeRightPane}
          onResizeStateChange={setIsDraggingContent}
          dividerLabel={tPane('canvas.resizePanes')}
          primaryPaneProps={{ 'aria-label': tPane('canvas.chatPane') }}
          secondaryPaneProps={{ 'aria-label': tPane('canvas.contentPane') }}
          dividerActions={
            <Tooltip content={tPane('canvas.swapPanes')} placement="top">
              <IconButton size="sm" aria-label={tPane('canvas.swapPanes')}
                icon={<Icon glyph={ArrowLeftRight} size="sm" />} onClick={pane.swapPanes} />
            </Tooltip>
          }
          primary={
            <div className="openbitfun-session-scene__chat-pane" data-testid="session-chat-pane"
              data-openbitfun-scene="session" data-openbitfun-part="chat">
              <ChatPane width={0} isFullscreen={false} isSceneActive={isActive && !isContentOnly}
                isDragging={isDragging} workspacePath={workspacePath} showChatInput
                isRightPanelOpen={pane.mode !== 'chat-only'} onToggleRightPanel={pane.toggleContent} />
            </div>
          }
          secondary={
            <div className="openbitfun-session-scene__aux-pane" data-testid="session-aux-pane"
              data-openbitfun-scene="session" data-openbitfun-part="auxiliary">
              <AuxPane workspacePath={workspacePath} isSceneActive={isActive && pane.mode !== 'chat-only'}
                isFullscreen={isContentOnly} onToggleFullscreen={pane.toggleMaximized}
                terminalResizeSuspended={isContentSettling || isDraggingContent} />
            </div>
          }
        />
      </div>
      {isTerminalDockedBottom && <>
        <div
          className={[
            'openbitfun-bottom-pane-resizer', isBottomHidden && 'openbitfun-bottom-pane-resizer--collapsed',
            isDraggingBottom && 'openbitfun-bottom-pane-resizer--dragging', isHoveringBottom && 'openbitfun-bottom-pane-resizer--hovering',
          ].filter(Boolean).join(' ')}
          onMouseDown={handleMouseDownBottomResizer} onDoubleClick={handleBottomDoubleClick}
          onMouseEnter={() => setIsHoveringBottom(true)} onMouseLeave={() => setIsHoveringBottom(false)}
          tabIndex={isBottomHidden ? -1 : 0} role="separator" aria-orientation="horizontal" aria-hidden={isBottomHidden}
          aria-label={t('layout.resizer.terminalBottomAriaLabel')} aria-valuenow={currentBottomHeight}
          aria-valuemin={BOTTOM_TERMINAL_PANEL_CONFIG.COMPACT_WIDTH} aria-valuemax={BOTTOM_TERMINAL_PANEL_CONFIG.MAX_WIDTH}
          title={t('layout.resizer.title', { mode: panelModeLabels[bottomTerminalPanelMode] })}
        >
          <div className="openbitfun-bottom-pane-resizer__line" />
          <div className="openbitfun-bottom-pane-resizer__handle"><GripHorizontal width="16" height="16" className="openbitfun-bottom-pane-resizer__icon" aria-hidden="true" /></div>
        </div>
        <div ref={bottomTerminalPaneElementRef}
          className={[
            'openbitfun-session-scene__bottom-terminal-pane', isBottomHidden && 'openbitfun-session-scene__bottom-terminal-pane--collapsed',
            isDraggingBottom && 'openbitfun-session-scene__bottom-terminal-pane--dragging',
          ].filter(Boolean).join(' ')}
          style={{ height: isBottomHidden ? undefined : `${currentBottomHeight}px` }}
          data-mode={bottomTerminalPanelMode} data-openbitfun-scene="session" data-openbitfun-part="terminal"
          aria-hidden={isBottomHidden}
          onTransitionEnd={event => {
            if (event.currentTarget === event.target && event.propertyName === 'height') stopBottomPanelTransition();
          }}
        >
          <BottomTerminalPane workspacePath={workspacePath} isSceneActive={isActive && !isBottomHidden}
            onExpand={expandBottomTerminalPanel} onCollapse={collapseSessionBottomTerminalPane}
            terminalResizeSuspended={isBottomTerminalPanelTransitioning || isDraggingBottom} />
        </div>
      </>}
    </div>
  );
};

export default SessionScene;
