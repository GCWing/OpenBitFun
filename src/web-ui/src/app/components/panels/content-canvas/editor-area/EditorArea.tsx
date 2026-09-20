import React, { useRef, useCallback } from 'react';
import { EditorGroup } from './EditorGroup';
import { SplitHandle } from './SplitHandle';
import { useCanvasStore } from '../stores';
import type { 
  EditorGroupId, 
  TabDragPayload, 
  DropPosition,
  PanelContent,
} from '../types';
import './EditorArea.scss';
export interface EditorAreaProps {
  activeSessionId?: string | null;
  workspacePath?: string;
  isSceneActive?: boolean;
  onOpenMissionControl?: () => void;
  onInteraction?: (itemId: string, userInput: string) => Promise<void>;
  onTabCloseWithDirtyCheck?: (tabId: string, groupId: EditorGroupId) => Promise<boolean>;
  onTabCloseAllWithDirtyCheck?: (groupId: EditorGroupId) => Promise<boolean>;
  disablePopOut?: boolean;
  terminalResizeSuspended?: boolean;
}

export const EditorArea: React.FC<EditorAreaProps> = ({
  activeSessionId,
  workspacePath,
  isSceneActive = true,
  onOpenMissionControl,
  onInteraction,
  onTabCloseWithDirtyCheck,
  onTabCloseAllWithDirtyCheck,
  disablePopOut = false,
  terminalResizeSuspended = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const topRowRef = useRef<HTMLDivElement>(null);

  // Fine-grained selectors: subscribe to each slice/action individually so
  // unrelated store changes do not re-render the editor area.
  const primaryGroup = useCanvasStore(state => state.primaryGroup);
  const secondaryGroup = useCanvasStore(state => state.secondaryGroup);
  const tertiaryGroup = useCanvasStore(state => state.tertiaryGroup);
  const activeGroupId = useCanvasStore(state => state.activeGroupId);
  const layout = useCanvasStore(state => state.layout);
  const draggingTabId = useCanvasStore(state => state.draggingTabId);
  const draggingFromGroupId = useCanvasStore(state => state.draggingFromGroupId);
  const switchToTab = useCanvasStore(state => state.switchToTab);
  const closeTab = useCanvasStore(state => state.closeTab);
  const closeAllTabs = useCanvasStore(state => state.closeAllTabs);
  const promoteTab = useCanvasStore(state => state.promoteTab);
  const togglePinTab = useCanvasStore(state => state.togglePinTab);
  const startDrag = useCanvasStore(state => state.startDrag);
  const endDrag = useCanvasStore(state => state.endDrag);
  const reorderTab = useCanvasStore(state => state.reorderTab);
  const handleDrop = useCanvasStore(state => state.handleDrop);
  const setSplitRatio = useCanvasStore(state => state.setSplitRatio);
  const setSplitRatio2 = useCanvasStore(state => state.setSplitRatio2);
  const setActiveGroup = useCanvasStore(state => state.setActiveGroup);
  const updateTabContent = useCanvasStore(state => state.updateTabContent);
  const setTabDirty = useCanvasStore(state => state.setTabDirty);
  const setTabFileDeletedFromDisk = useCanvasStore(state => state.setTabFileDeletedFromDisk);

  const handleTabClick = useCallback((groupId: EditorGroupId) => (tabId: string) => {
    switchToTab(tabId, groupId);
  }, [switchToTab]);

  const handleTabDoubleClick = useCallback((groupId: EditorGroupId) => (tabId: string) => {
    promoteTab(tabId, groupId);
  }, [promoteTab]);

  const handleTabClose = useCallback((groupId: EditorGroupId) => async (tabId: string) => {
    if (onTabCloseWithDirtyCheck) {
      await onTabCloseWithDirtyCheck(tabId, groupId);
      return;
    }
    closeTab(tabId, groupId);
  }, [closeTab, onTabCloseWithDirtyCheck]);

  const handleCloseAllTabs = useCallback((groupId: EditorGroupId) => async () => {
    if (onTabCloseAllWithDirtyCheck) {
      await onTabCloseAllWithDirtyCheck(groupId);
      return;
    }
    closeAllTabs(groupId);
  }, [closeAllTabs, onTabCloseAllWithDirtyCheck]);

  const handleTabPin = useCallback((groupId: EditorGroupId) => (tabId: string) => {
    togglePinTab(tabId, groupId);
  }, [togglePinTab]);

  const handleDragStart = useCallback((payload: TabDragPayload) => {
    startDrag(payload.tabId, payload.sourceGroupId);
  }, [startDrag]);

  const handleDragEnd = useCallback(() => {
    endDrag();
  }, [endDrag]);

  const handleReorderTab = useCallback((groupId: EditorGroupId) => (tabId: string, newIndex: number) => {
    reorderTab(tabId, groupId, newIndex);
  }, [reorderTab]);

  const handleDropOnGroup = useCallback((groupId: EditorGroupId) => (position: DropPosition) => {
    if (draggingTabId && draggingFromGroupId) {
      handleDrop(draggingTabId, draggingFromGroupId, groupId, position);
      endDrag();
    }
  }, [draggingTabId, draggingFromGroupId, handleDrop, endDrag]);

  const handleGroupFocus = useCallback((groupId: EditorGroupId) => () => {
    setActiveGroup(groupId);
  }, [setActiveGroup]);

  const handleContentChange = useCallback((groupId: EditorGroupId) => (tabId: string, content: PanelContent) => {
    updateTabContent(tabId, groupId, content);
  }, [updateTabContent]);

  const handleDirtyStateChange = useCallback((groupId: EditorGroupId) => (tabId: string, isDirty: boolean) => {
    setTabDirty(tabId, groupId, isDirty);
  }, [setTabDirty]);

  const handleTabFileDeletedFromDiskChange = useCallback(
    (groupId: EditorGroupId) => (tabId: string, missing: boolean) => {
      setTabFileDeletedFromDisk(tabId, groupId, missing);
    },
    [setTabFileDeletedFromDisk]
  );

  const renderEditorGroup = (groupId: EditorGroupId, group: typeof primaryGroup) => (
    <EditorGroup
      groupId={groupId}
      activeSessionId={activeSessionId}
      group={group}
      isActive={activeGroupId === groupId}
      isSceneActive={isSceneActive}
      draggingTabId={draggingTabId}
      draggingFromGroupId={draggingFromGroupId}
      splitMode={layout.splitMode}
      workspacePath={workspacePath}
      onTabClick={handleTabClick(groupId)}
      onTabDoubleClick={handleTabDoubleClick(groupId)}
      onTabClose={handleTabClose(groupId)}
      onTabPin={handleTabPin(groupId)}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onReorderTab={handleReorderTab(groupId)}
      onDrop={handleDropOnGroup(groupId)}
      onGroupFocus={handleGroupFocus(groupId)}
      onContentChange={handleContentChange(groupId)}
      onDirtyStateChange={handleDirtyStateChange(groupId)}
      onTabFileDeletedFromDiskChange={handleTabFileDeletedFromDiskChange(groupId)}
      onOpenMissionControl={groupId === 'primary' ? onOpenMissionControl : undefined}
      onCloseAllTabs={handleCloseAllTabs(groupId)}
      onInteraction={onInteraction}
      disablePopOut={disablePopOut}
      terminalResizeSuspended={terminalResizeSuspended}
    />
  );

  const { splitMode, splitRatio, splitRatio2 } = layout;

  if (splitMode === 'none') {
    return (
      <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="root" data-openbitfun-layout="none" ref={containerRef} className="canvas-editor-area">
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="primary" className="canvas-editor-area__primary">
          {renderEditorGroup('primary', primaryGroup)}
        </div>
      </div>
    );
  }

  if (splitMode === 'horizontal') {
    return (
      <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="root" data-openbitfun-layout="horizontal" ref={containerRef} className="canvas-editor-area is-split is-horizontal">
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="primary" className="canvas-editor-area__primary" style={{ width: `${splitRatio * 100}%` }}>
          {renderEditorGroup('primary', primaryGroup)}
        </div>
        <SplitHandle
          direction="horizontal"
          ratio={splitRatio}
          onRatioChange={setSplitRatio}
          containerRef={containerRef}
        />
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="secondary" className="canvas-editor-area__secondary" style={{ width: `${(1 - splitRatio) * 100}%` }}>
          {renderEditorGroup('secondary', secondaryGroup)}
        </div>
      </div>
    );
  }

  if (splitMode === 'vertical') {
    return (
      <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="root" data-openbitfun-layout="vertical" ref={containerRef} className="canvas-editor-area is-split is-vertical">
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="primary" className="canvas-editor-area__primary" style={{ height: `${splitRatio * 100}%` }}>
          {renderEditorGroup('primary', primaryGroup)}
        </div>
        <SplitHandle
          direction="vertical"
          ratio={splitRatio}
          onRatioChange={setSplitRatio}
          containerRef={containerRef}
        />
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="secondary" className="canvas-editor-area__secondary" style={{ height: `${(1 - splitRatio) * 100}%` }}>
          {renderEditorGroup('secondary', secondaryGroup)}
        </div>
      </div>
    );
  }

  if (splitMode === 'grid') {
    return (
      <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="root" data-openbitfun-layout="grid" ref={containerRef} className="canvas-editor-area is-grid">
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="topRow" ref={topRowRef} className="canvas-editor-area__top-row" style={{ flex: `0 0 calc(${splitRatio * 100}% - 2px)` }}>
          <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="primary" className="canvas-editor-area__primary" style={{ flex: `0 0 calc(${splitRatio2 * 100}% - 2px)` }}>
            {renderEditorGroup('primary', primaryGroup)}
          </div>
          <SplitHandle
            direction="horizontal"
            ratio={splitRatio2}
            onRatioChange={setSplitRatio2}
            containerRef={topRowRef}
          />
          <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="secondary" className="canvas-editor-area__secondary" style={{ flex: 1, minWidth: 0 }}>
            {renderEditorGroup('secondary', secondaryGroup)}
          </div>
        </div>
        <SplitHandle
          direction="vertical"
          ratio={splitRatio}
          onRatioChange={setSplitRatio}
          containerRef={containerRef}
        />
        <div data-openbitfun-component="canvas-editor-area" data-openbitfun-part="tertiary" className="canvas-editor-area__tertiary" style={{ flex: 1, minHeight: 0 }}>
          {renderEditorGroup('tertiary', tertiaryGroup)}
        </div>
      </div>
    );
  }

  return null;
};

EditorArea.displayName = 'EditorArea';

export default EditorArea;
