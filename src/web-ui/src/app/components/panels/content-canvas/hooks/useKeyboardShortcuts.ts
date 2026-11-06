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

  const getActiveGroup = useCallback(() => {
    return activeGroupId === 'primary' ? primaryGroup
      : activeGroupId === 'secondary' ? secondaryGroup : tertiaryGroup;
  }, [activeGroupId, primaryGroup, secondaryGroup, tertiaryGroup]);

  const getVisibleTabs = useCallback(() => {
    return getActiveGroup().tabs.filter((t) => !t.isHidden);
  }, [getActiveGroup]);

  // Find in file (Monaco) — only when `data-shortcut-scope="editor"` is innermost
  useShortcut(
    'editor.findInFile',
    { key: 'f', ctrl: true, scope: 'editor', allowInInput: true },
    () => {
      activeEditTargetService.openMonacoFind();
    },
    { enabled, priority: 20, description: 'keyboard.shortcuts.editor.findInFile' }
  );

  // Mission control
  useShortcut(
    'canvas.missionControl',
    CANVAS_OVERVIEW_SHORTCUT,
    () => toggleMissionControl(),
    {
      enabled: enabled && missionControlEnabled,
      priority: 10,
      description: 'keyboard.shortcuts.canvas.missionControl',
    }
  );

  // Horizontal split: mod+\
  useShortcut(
    'canvas.splitHorizontal',
    { key: '\\', ctrl: true, scope: 'canvas' },
    () => setSplitMode(layout.splitMode === 'horizontal' ? 'none' : 'horizontal'),
    { enabled, description: 'keyboard.shortcuts.canvas.splitHorizontal' }
  );

  // Vertical split: mod+Shift+\
  useShortcut(
    'canvas.splitVertical',
    { key: '\\', ctrl: true, shift: true, scope: 'canvas' },
    () => setSplitMode(layout.splitMode === 'vertical' ? 'none' : 'vertical'),
    { enabled, description: 'keyboard.shortcuts.canvas.splitVertical' }
  );

  // Anchor zone: mod+`
  useShortcut(
    'canvas.anchorZone',
    { key: '`', ctrl: true, scope: 'canvas' },
    () => setAnchorPosition(layout.anchorPosition === 'hidden' ? 'bottom' : 'hidden'),
    { enabled, description: 'keyboard.shortcuts.canvas.anchorZone' }
  );

  // Maximize: mod+Shift+M
  useShortcut(
    'canvas.maximize',
    { key: 'M', ctrl: true, shift: true, scope: 'canvas' },
    () => toggleMaximize(),
    { enabled, description: 'keyboard.shortcuts.canvas.maximize' }
  );

  // Close current tab: mod+W
  useTabCloseShortcut(
    'app',
    event => {
      // Keyboard focus can enter a split group without its click handler running.
      const groupElement = event.target instanceof Element
        ? event.target.closest('[data-openbitfun-group], [data-canvas-toolbar-group]') : null;
      const focusedGroup = groupElement?.getAttribute('data-openbitfun-group')
        ?? groupElement?.getAttribute('data-canvas-toolbar-group');
      const groupId = focusedGroup === 'primary' || focusedGroup === 'secondary' || focusedGroup === 'tertiary'
        ? focusedGroup : activeGroupId;
      const activeGroup = groupId === 'primary' ? primaryGroup
        : groupId === 'secondary' ? secondaryGroup : tertiaryGroup;
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
    { enabled, priority: 10, description: 'keyboard.shortcuts.tab.reopenClosed' }
  );

  // Switch to tab by number: mod+1~9
  const switchToTabByIndex = useCallback(
    (index: number) => {
      const tabs = getVisibleTabs();
      const target = index === -1 ? tabs[tabs.length - 1] : tabs[index];
      if (target) switchToTab(target.id, activeGroupId);
    },
    [getVisibleTabs, switchToTab, activeGroupId]
  );

  // allowInInput so Ctrl+1..9 still work while focus is in a Monaco editor
  useShortcut('tab.switch1',    { key: '1', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(0),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch2',    { key: '2', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(1),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch3',    { key: '3', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(2),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch4',    { key: '4', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(3),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch5',    { key: '5', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(4),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch6',    { key: '6', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(5),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch7',    { key: '7', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(6),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switch8',    { key: '8', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(7),  { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
  useShortcut('tab.switchLast', { key: '9', ctrl: true, scope: 'canvas', allowInInput: true }, () => switchToTabByIndex(-1), { enabled, description: 'keyboard.shortcuts.tab.switchMerged' });
};

export default useKeyboardShortcuts;
