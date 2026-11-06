/**
 * useKeyboardShortcuts Hook
 *
 * Registers canvas-level keyboard shortcuts via ShortcutManager.
 * Canvas shortcuts follow DOM scope. Close also follows the workbench's focused
 * pane when focus returns to the document body after a tab is removed.
 */

import { useCallback, useContext } from 'react';
import { CANVAS_OVERVIEW_SHORTCUT } from '@/shared/constants/shortcuts';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';
import { activeEditTargetService } from '@/tools/editor/services/ActiveEditTargetService';
import { CanvasStoreModeContext, useCanvasStore } from '../stores';
import { useTabCloseShortcut } from '@/app/hooks/useTabCloseShortcut';
import { useSceneStore } from '@/app/stores/sceneStore';
import type { EditorGroupId } from '../types';

interface UseKeyboardShortcutsOptions {
  enabled?: boolean;
  missionControlEnabled?: boolean;
  handleCloseWithDirtyCheck?: (tabId: string, groupId: EditorGroupId) => Promise<boolean>;
  onReveal?: () => void;
}

export const useKeyboardShortcuts = (options: UseKeyboardShortcutsOptions = {}) => {
  const mode = useContext(CanvasStoreModeContext);
  const {
    enabled = true,
    missionControlEnabled = true,
    handleCloseWithDirtyCheck,
    onReveal,
  } = options;

  const {
    primaryGroup,
    secondaryGroup,
    tertiaryGroup,
    activeGroupId,
    layout,
    closeTab,
    switchToTab,
    reopenClosedTab,
    closedTabs,
    setSplitMode,
    setAnchorPosition,
    toggleMaximize,
    toggleMissionControl,
  } = useCanvasStore();

  const ownsCanvasEvent = useCallback((event: KeyboardEvent) => event.target instanceof Element
    && event.target.closest('[data-canvas-mode]')?.getAttribute('data-canvas-mode') === mode, [mode]);
  const canvasShortcutOptions = { enabled, when: ownsCanvasEvent };

  const getFocusedGroupId = useCallback((event: KeyboardEvent): EditorGroupId => {
    // Keyboard focus can enter a split group without its click handler running.
    const groupElement = event.target instanceof Element
      ? event.target.closest('[data-openbitfun-group], [data-canvas-toolbar-group]') : null;
    const focusedGroup = groupElement?.getAttribute('data-openbitfun-group')
      ?? groupElement?.getAttribute('data-canvas-toolbar-group');
    return focusedGroup === 'primary' || focusedGroup === 'secondary' || focusedGroup === 'tertiary'
      ? focusedGroup : activeGroupId;
  }, [activeGroupId]);

  const getActiveGroup = useCallback((event: KeyboardEvent) => {
    const groupId = getFocusedGroupId(event);
    return groupId === 'primary' ? primaryGroup
      : groupId === 'secondary' ? secondaryGroup : tertiaryGroup;
  }, [getFocusedGroupId, primaryGroup, secondaryGroup, tertiaryGroup]);

  const getVisibleTabs = useCallback((event: KeyboardEvent) => {
    return getActiveGroup(event).tabs.filter((t) => !t.isHidden);
  }, [getActiveGroup]);

  // Find in file (Monaco) — only when `data-shortcut-scope="editor"` is innermost
  useShortcut(
    'editor.findInFile',
    { key: 'f', ctrl: true, scope: 'editor', allowInInput: true },
    () => {
      activeEditTargetService.openMonacoFind();
    },
    {
      enabled, priority: 20, description: 'keyboard.shortcuts.editor.findInFile',
      // Main document editors share the active edit target service. Canvas
      // instances must nevertheless survive another canvas unmounting.
      when: event => event.target instanceof Element
        && (!event.target.closest('[data-canvas-mode]') || ownsCanvasEvent(event)),
    }
  );

  // Mission control
  useShortcut(
    'canvas.missionControl',
    CANVAS_OVERVIEW_SHORTCUT,
    () => toggleMissionControl(),
    {
      enabled: enabled && missionControlEnabled,
      when: ownsCanvasEvent,
      priority: 10,
      description: 'keyboard.shortcuts.canvas.missionControl',
    }
  );

  // Horizontal split: mod+\
  useShortcut(
    'canvas.splitHorizontal',
    { key: '\\', ctrl: true, scope: 'canvas' },
    () => setSplitMode(layout.splitMode === 'horizontal' ? 'none' : 'horizontal'),
    { ...canvasShortcutOptions, description: 'keyboard.shortcuts.canvas.splitHorizontal' }
  );

  // Vertical split: mod+Shift+\
  useShortcut(
    'canvas.splitVertical',
    { key: '\\', ctrl: true, shift: true, scope: 'canvas' },
    () => setSplitMode(layout.splitMode === 'vertical' ? 'none' : 'vertical'),
    { ...canvasShortcutOptions, description: 'keyboard.shortcuts.canvas.splitVertical' }
  );

  // Anchor zone: mod+`
  useShortcut(
    'canvas.anchorZone',
    { key: '`', ctrl: true, scope: 'canvas' },
    () => setAnchorPosition(layout.anchorPosition === 'hidden' ? 'bottom' : 'hidden'),
    { ...canvasShortcutOptions, description: 'keyboard.shortcuts.canvas.anchorZone' }
  );

  // Maximize: mod+Shift+M
  useShortcut(
    'canvas.maximize',
    { key: 'M', ctrl: true, shift: true, scope: 'canvas' },
    () => toggleMaximize(),
    { ...canvasShortcutOptions, description: 'keyboard.shortcuts.canvas.maximize' }
  );

  // Close current tab: mod+W
  useTabCloseShortcut(
    'app',
    event => {
      const groupId = getFocusedGroupId(event);
      const activeGroup = getActiveGroup(event);
      if (!activeGroup.activeTabId) return;
      if (handleCloseWithDirtyCheck) {
        return handleCloseWithDirtyCheck(activeGroup.activeTabId, groupId);
      } else {
        closeTab(activeGroup.activeTabId, groupId);
      }
    },
    {
      enabled,
      priority: 20,
      when: event => {
        const target = event.target instanceof Element ? event.target : null;
        const owner = target?.closest('[data-canvas-mode]')?.getAttribute('data-canvas-mode');
        if (owner) return owner === mode;
        // Explicit editor/chat/terminal scope always wins over remembered pane focus.
        if (target?.closest('[data-shortcut-scope], [data-openbitfun-component="scene-bar"]')) return false;
        const scene = useSceneStore.getState();
        return mode === 'agent' && scene.paneSelections[scene.focusedPane].kind === 'canvas';
      },
    }
  );

  // Reopen closed tab: mod+Shift+T
  useShortcut(
    'tab.reopenClosed',
    { key: 'T', ctrl: true, shift: true, scope: 'canvas', allowInInput: true },
    () => {
      if (closedTabs.length === 0) return;
      reopenClosedTab();
      onReveal?.();
    },
    { ...canvasShortcutOptions, priority: 10, description: 'keyboard.shortcuts.tab.reopenClosed' }
  );

  // Switch to tab by number: mod+1~9
  const switchToTabByIndex = useCallback(
    (event: KeyboardEvent, index: number) => {
      const tabs = getVisibleTabs(event);
      const target = index === -1 ? tabs[tabs.length - 1] : tabs[index];
      if (target) switchToTab(target.id, getFocusedGroupId(event));
    },
    [getVisibleTabs, switchToTab, getFocusedGroupId]
  );

  // allowInInput so Ctrl+1..9 still work while focus is in a Monaco editor
  useShortcut('tab.switch1',    { key: '1', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 0),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch2',    { key: '2', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 1),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch3',    { key: '3', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 2),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch4',    { key: '4', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 3),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch5',    { key: '5', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 4),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch6',    { key: '6', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 5),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch7',    { key: '7', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 6),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch8',    { key: '8', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, 7),  { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switchLast', { key: '9', ctrl: true, scope: 'canvas', allowInInput: true }, event => switchToTabByIndex(event, -1), { ...canvasShortcutOptions, description: 'keyboard.shortcuts.tab.switchMerged' });
};

export default useKeyboardShortcuts;
