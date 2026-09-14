import { ResourceFileContext } from '@/infrastructure/api/ResourceFileContext';
/**
 * EditorGroup component.
 * A single editor group with tab bar and content area.
 */

import React, { useCallback, useMemo, useRef, useEffect, useLayoutEffect, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { TabBar } from '../tab-bar';
import { DropZone } from './DropZone';
import FlexiblePanel from '../../base/FlexiblePanel';
import { captureContentScope } from '@/shared/services/workbenchContentService';
import { popOutCanvasTab } from '@/app/workbench/canvasTabTransfer';
import { EditorDocumentContext, getEditorDocument, releaseEditorDocument } from '@/tools/editor/services/EditorDocument';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { CanvasStoreModeContext } from '../stores';
import { hasRetainedCanvasTab } from '../stores/canvasStore';
import {
  getInteractionMotion,
  isReducedMotionPreferred,
  type InteractionMotion,
} from '@/shared/utils/motionPreference';
import type { 
  EditorGroupId, 
  EditorGroupState, 
  TabDragPayload,
  DropPosition,
  PanelContent,
  SplitMode,
} from '../types';
import './EditorGroup.scss';

function CanvasContentView({ documentId, ...props }: React.ComponentProps<typeof FlexiblePanel> & { documentId: string }) {
  const resourceScope = props.content?.metadata?.resourceScope;
  const resourceWorkspacePath = props.content?.data?.workspacePath ?? props.workspacePath;
  const remoteConnectionId = props.content?.data?.remoteConnectionId;
  const filePath = props.content?.data?.filePath;
  const documentSession = useMemo(() => getEditorDocument(
    documentId,
    resourceScope ?? captureContentScope({ workspacePath: resourceWorkspacePath, remoteConnectionId }),
    filePath,
  ), [documentId, filePath, remoteConnectionId, resourceScope, resourceWorkspacePath]);
  useEffect(() => () => {
    if (!hasRetainedCanvasTab(documentId.slice('canvas:'.length))
      && !Object.values(useContentResourceStore.getState().resources).some(resource => resource.documentId === documentId)) {
      releaseEditorDocument(documentId);
    }
  }, [documentId]);
  return <EditorDocumentContext.Provider value={documentSession}><ResourceFileContext.Provider value={documentSession}><FlexiblePanel {...props}
    onFileMissingFromDiskChange={missing => props.onFileMissingFromDiskChange?.(
      documentSession.isFileDeletedFromDisk(filePath, missing),
    )} /></ResourceFileContext.Provider></EditorDocumentContext.Provider>;
}

export interface EditorGroupProps {
  groupId: EditorGroupId;
  group: EditorGroupState;
  isActive: boolean;
  isSceneActive?: boolean;
  draggingTabId: string | null;
  draggingFromGroupId: EditorGroupId | null;
  splitMode: SplitMode;
  workspacePath?: string;
  onTabClick: (tabId: string) => void;
  onTabDoubleClick: (tabId: string) => void;
  onTabClose: (tabId: string) => Promise<void> | void;
  onTabPin: (tabId: string) => void;
  onDragStart: (payload: TabDragPayload) => void;
  onDragEnd: () => void;
  onReorderTab: (tabId: string, newIndex: number) => void;
  onDrop: (position: DropPosition) => void;
  onGroupFocus: () => void;
  onContentChange: (tabId: string, content: PanelContent) => void;
  onDirtyStateChange: (tabId: string, isDirty: boolean) => void;
  onTabFileDeletedFromDiskChange?: (tabId: string, missing: boolean) => void;
  onOpenMissionControl?: () => void;
  onCloseAllTabs?: () => Promise<void> | void;
  onInteraction?: (itemId: string, userInput: string) => Promise<void>;
  disablePopOut?: boolean;
  terminalResizeSuspended?: boolean;
}

export const EditorGroup: React.FC<EditorGroupProps> = ({
  groupId,
  group,
  isActive,
  isSceneActive = true,
  draggingTabId,
  draggingFromGroupId,
  splitMode,
  workspacePath,
  onTabClick,
  onTabDoubleClick,
  onTabClose,
  onTabPin,
  onDragStart,
  onDragEnd,
  onReorderTab,
  onDrop,
  onGroupFocus,
  onContentChange,
  onDirtyStateChange,
  onTabFileDeletedFromDiskChange,
  onOpenMissionControl,
  onCloseAllTabs,
  onInteraction,
  disablePopOut = false,
  terminalResizeSuspended = false,
}) => {
  const { t } = useTranslation('components');
  const mode = useContext(CanvasStoreModeContext);
  const visibleTabs = useMemo(() => group.tabs.filter(t => !t.isHidden), [group.tabs]);
  const activeTabContentRef = useRef<HTMLDivElement | null>(null);
  const activeTabAnimationRef = useRef<Animation | null>(null);
  const previousActiveTabIdRef = useRef(group.activeTabId);
  const tabTransitionIntentRef = useRef<{
    motion: InteractionMotion;
    tabId: string;
  } | null>(null);
  const isKeepAliveTerminalTab = useCallback((tab: EditorGroupState['tabs'][number]) =>
    tab.content.type === 'terminal',
  []);
  
  // Cache recently visited tabs (max 5) for instant switching
  const cachedTabsRef = useRef<Set<string>>(new Set());
  
  // Update cache: keep active tab and 4 most recent tabs
  useEffect(() => {
    // Remove closed tabs
    const validTabIds = new Set(
      group.tabs
        .filter(t => !t.isHidden || isKeepAliveTerminalTab(t))
        .map(t => t.id)
    );
    cachedTabsRef.current = new Set(
      Array.from(cachedTabsRef.current).filter(id => validTabIds.has(id))
    );
    
    // Add active tab
    if (group.activeTabId && validTabIds.has(group.activeTabId)) {
      cachedTabsRef.current.add(group.activeTabId);
      
      // If cache exceeds 5, keep active and 4 most recent
      if (cachedTabsRef.current.size > 5) {
        const sortedTabs = [...group.tabs]
          .filter(t => !t.isHidden && t.id !== group.activeTabId)
          .sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0))
          .slice(0, 4)
          .map(t => t.id);
        
        cachedTabsRef.current = new Set([group.activeTabId, ...sortedTabs]);
      }
    }
  }, [group.activeTabId, group.tabs, isKeepAliveTerminalTab]);
  
  // Tabs to render (active + cached). Hidden terminal tabs stay mounted so
  // reopening a terminal reuses the xterm buffer instead of replaying history.
  // Child-session tabs retain only their lightweight wrapper; that wrapper
  // unmounts its transcript while inactive and owns reading state until close.
  const tabsToRender = useMemo(() => {
    const result = group.tabs.filter(t => 
      (!t.isHidden && (t.content.type === 'btw-session' || t.id === group.activeTabId || cachedTabsRef.current.has(t.id))) ||
      (t.isHidden && isKeepAliveTerminalTab(t))
    );
    return result;
  }, [group.tabs, group.activeTabId, isKeepAliveTerminalTab]);

  const handleContentChange = useCallback((content: PanelContent | null) => {
    if (content && group.activeTabId) {
      onContentChange(group.activeTabId, content);
    }
  }, [group.activeTabId, onContentChange]);

  const handleDirtyStateChange = useCallback((isDirty: boolean) => {
    if (group.activeTabId) {
      onDirtyStateChange(group.activeTabId, isDirty);
    }
  }, [group.activeTabId, onDirtyStateChange]);

  const handleTabPopOut = useCallback((tabId: string) => {
    popOutCanvasTab(mode, tabId, groupId, { workspacePath });
  }, [mode, groupId, workspacePath]);

  const handleVisibleTabClick = useCallback((tabId: string) => {
    tabTransitionIntentRef.current = {
      motion: getInteractionMotion(),
      tabId,
    };
    onTabClick(tabId);
  }, [onTabClick]);

  useLayoutEffect(() => {
    const previousTabId = previousActiveTabIdRef.current;
    previousActiveTabIdRef.current = group.activeTabId;
    if (!previousTabId || !group.activeTabId || previousTabId === group.activeTabId) {
      return;
    }

    const intent = tabTransitionIntentRef.current;
    const motion = intent?.tabId === group.activeTabId
      ? intent.motion
      : getInteractionMotion();
    tabTransitionIntentRef.current = null;
    if (motion !== 'pointer' || !activeTabContentRef.current) return;

    activeTabAnimationRef.current?.cancel();
    const reducedMotion = isReducedMotionPreferred();
    activeTabAnimationRef.current = activeTabContentRef.current.animate(
      reducedMotion
        ? [{ opacity: 0.82 }, { opacity: 1 }]
        : [
            { opacity: 0.72, transform: 'translate3d(0, 4px, 0) scale(0.997)' },
            { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
          ],
      {
        duration: reducedMotion ? 100 : 150,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
    );

    return () => {
      activeTabAnimationRef.current?.cancel();
      activeTabAnimationRef.current = null;
    };
  }, [group.activeTabId]);

  const isDragging = draggingTabId !== null;

  return (
    <div data-openbitfun-component="canvas-editor-group" data-openbitfun-part="root" data-openbitfun-group={groupId} data-openbitfun-state={isActive ? 'active' : ''}
      className={`canvas-editor-group ${isActive ? 'is-active' : ''}`}
      onClick={onGroupFocus}
    >
      {/* Tab bar */}
      <TabBar
        tabs={group.tabs}
        groupId={groupId}
        activeTabId={group.activeTabId}
        isActiveGroup={isActive}
        onTabClick={handleVisibleTabClick}
        onTabDoubleClick={onTabDoubleClick}
        onTabClose={onTabClose}
        onTabPin={onTabPin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        draggingTabId={draggingTabId}
        onReorderTab={onReorderTab}
        onOpenMissionControl={onOpenMissionControl}
        onCloseAllTabs={onCloseAllTabs}
        onTabPopOut={disablePopOut ? undefined : handleTabPopOut}
      />

      <DropZone
        groupId={groupId}
        isDragging={isDragging}
        draggingFromGroupId={draggingFromGroupId}
        splitMode={splitMode}
        onDrop={onDrop}
      >
        <div data-openbitfun-component="canvas-editor-group" data-openbitfun-part="content" className="canvas-editor-group__content">
          {/* Render cached tabs (active shown, others hidden) for instant switching */}
          {tabsToRender.length > 0 ? (
            tabsToRender.map((tab) => (
              <div
                key={tab.id}
                ref={group.activeTabId === tab.id ? activeTabContentRef : undefined}
                data-openbitfun-component="canvas-editor-group"
                data-openbitfun-part="tabContent"
                className="canvas-editor-group__tab-content"
                style={{ display: group.activeTabId === tab.id ? 'flex' : 'none' }}
              >
                <CanvasContentView
                  documentId={`canvas:${tab.id}`}
                  content={tab.content as any}
                  isActive={isSceneActive && group.activeTabId === tab.id}
                  onContentChange={group.activeTabId === tab.id ? handleContentChange : undefined}
                  onDirtyStateChange={group.activeTabId === tab.id ? handleDirtyStateChange : undefined}
                  onFileMissingFromDiskChange={
                    onTabFileDeletedFromDiskChange
                      ? (missing) => onTabFileDeletedFromDiskChange(tab.id, missing)
                      : undefined
                  }
                  onInteraction={onInteraction}
                  workspacePath={workspacePath}
                  terminalResizeSuspended={terminalResizeSuspended}
                />
              </div>
            ))
          ) : visibleTabs.length === 0 ? (
            <div data-openbitfun-component="canvas-editor-group" data-openbitfun-part="empty" className="canvas-editor-group__empty">
              <div data-openbitfun-component="canvas-editor-group" data-openbitfun-part="emptyContent" className="canvas-editor-group__empty-content">
                <span>{t('canvas.dragTabHere')}</span>
              </div>
            </div>
          ) : null}
        </div>
      </DropZone>
    </div>
  );
};

EditorGroup.displayName = 'EditorGroup';

export default EditorGroup;
