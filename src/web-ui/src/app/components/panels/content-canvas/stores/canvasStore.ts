/**
 * Canvas Store - canvas state management.
 * Uses Zustand to manage tabs and layout state.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createContext, useContext } from 'react';
import type {
  CanvasTab,
  EditorGroupId,
  EditorGroupState,
  LayoutState,
  TabState,
  PanelContent,
  ClosedTabRecord,
  SplitMode,
  AnchorPosition,
  DropPosition,
} from '../types';
import {
  createTab,
  createEditorGroupState,
  createLayoutState,
  clampSplitRatio,
  clampAnchorSize,
} from '../types';
import { normalizePath } from '@/shared/utils/pathUtils';

// ==================== Store State Types ====================

interface CanvasStoreState {
  /** Live content scope, committed with scope swaps and excluded from snapshots. */
  scopeKey?: string;
  primaryGroup: EditorGroupState;
  secondaryGroup: EditorGroupState;
  tertiaryGroup: EditorGroupState;
  activeGroupId: EditorGroupId;
  layout: LayoutState;
  isMissionControlOpen: boolean;
  draggingTabId: string | null;
  draggingFromGroupId: EditorGroupId | null;
  closedTabs: ClosedTabRecord[];
  maxClosedTabsHistory: number;
}

interface CanvasStoreActions {
  // ==================== Tab Operations ====================
  
  /** Add tab */
  addTab: (content: PanelContent, state?: TabState, groupId?: EditorGroupId) => void;
  /** Move a view to the workbench without closing its document or process. */
  detachTab: (tabId: string, groupId: EditorGroupId) => void;
  
  /** Close tab; terminal tabs are always removed and cannot be restored. */
  closeTab: (tabId: string, groupId: EditorGroupId, options?: { forceRemove?: boolean }) => void;

  /** Close and remove a tab after its terminal session is destroyed. */
  closeTerminalTabBySessionId: (sessionId: string) => void;

  /** Rename a terminal tab by sessionId. */
  renameTerminalTabBySessionId: (sessionId: string, newName: string) => void;
  
  /** Close all tabs */
  closeAllTabs: (groupId?: EditorGroupId) => void;
  
  /** Switch to tab */
  switchToTab: (tabId: string, groupId: EditorGroupId) => void;
  
  /** Update tab content */
  updateTabContent: (tabId: string, groupId: EditorGroupId, content: PanelContent) => void;
  
  /** Set tab dirty state */
  setTabDirty: (tabId: string, groupId: EditorGroupId, isDirty: boolean) => void;

  /** Mark whether the tab's file is missing on disk (editor-detected) */
  setTabFileDeletedFromDisk: (tabId: string, groupId: EditorGroupId, deleted: boolean) => void;
  
  /** Promote tab state (preview -> active) */
  promoteTab: (tabId: string, groupId: EditorGroupId) => void;
  
  /** Pin/unpin tab */
  togglePinTab: (tabId: string, groupId: EditorGroupId) => void;
  
  /** Find tab by metadata */
  findTabByMetadata: (metadata: Record<string, any>) => { tab: CanvasTab; groupId: EditorGroupId } | null;
  
  /** Reopen recently closed tab */
  reopenClosedTab: () => void;
  
  /** Hide tab (keep state) */
  hideTab: (tabId: string, groupId: EditorGroupId) => void;
  
  /** Show hidden tab */
  showTab: (tabId: string, groupId: EditorGroupId) => void;
  
  // ==================== Drag Operations ====================
  
  /** Start drag */
  startDrag: (tabId: string, groupId: EditorGroupId) => void;
  
  /** End drag */
  endDrag: () => void;
  
  /** Move tab to another group */
  moveTabToGroup: (tabId: string, fromGroupId: EditorGroupId, toGroupId: EditorGroupId, index?: number) => void;
  
  /** Reorder tabs */
  reorderTab: (tabId: string, groupId: EditorGroupId, newIndex: number) => void;
  
  /** Handle drop */
  handleDrop: (tabId: string, fromGroupId: EditorGroupId, toGroupId: EditorGroupId, position?: DropPosition) => void;
  
  // ==================== Layout Operations ====================
  
  /** Set split mode */
  setSplitMode: (mode: SplitMode) => void;
  
  /** Set split ratio */
  setSplitRatio: (ratio: number) => void;

  /** Set secondary split ratio used by grid top row */
  setSplitRatio2: (ratio: number) => void;
  
  /** Set anchor position */
  setAnchorPosition: (position: AnchorPosition) => void;
  
  /** Set anchor size */
  setAnchorSize: (size: number) => void;
  
  /** Toggle maximize */
  toggleMaximize: () => void;
  
  /** Set active editor group */
  setActiveGroup: (groupId: EditorGroupId) => void;
  
  // ==================== Mission Control ====================
  
  /** Open mission control */
  openMissionControl: () => void;
  
  /** Close mission control */
  closeMissionControl: () => void;
  
  /** Toggle mission control */
  toggleMissionControl: () => void;
  
  // ==================== State Management ====================
  
  /** Reset state */
  reset: () => void;
  
  /** Get all tabs */
  getAllTabs: () => CanvasTab[];
}

type CanvasStore = CanvasStoreState & CanvasStoreActions;

// ==================== Initial State ====================

const initialState: CanvasStoreState = {
  scopeKey: undefined,
  primaryGroup: createEditorGroupState(),
  secondaryGroup: createEditorGroupState(),
  tertiaryGroup: createEditorGroupState(),
  activeGroupId: 'primary',
  layout: createLayoutState(),
  isMissionControlOpen: false,
  draggingTabId: null,
  draggingFromGroupId: null,
  closedTabs: [],
  maxClosedTabsHistory: 10,
};

const getGroup = (draft: CanvasStoreState, groupId: EditorGroupId): EditorGroupState => {
  if (groupId === 'primary') return draft.primaryGroup;
  if (groupId === 'secondary') return draft.secondaryGroup;
  return draft.tertiaryGroup;
};

const getVisibleTabs = (group: EditorGroupState) => group.tabs.filter(t => !t.isHidden);
const getVisibleCount = (group: EditorGroupState) => getVisibleTabs(group).length;

const ensureValidActiveTab = (group: EditorGroupState) => {
  const visibleTabs = getVisibleTabs(group);
  if (visibleTabs.length === 0) {
    group.activeTabId = null;
  } else if (group.activeTabId === null || !visibleTabs.find(t => t.id === group.activeTabId)) {
    group.activeTabId = visibleTabs[0]?.id || null;
  }
};

const keepPinnedTabsOnly = (group: EditorGroupState) => {
  group.tabs = group.tabs.filter(tab => tab.state === 'pinned');
  ensureValidActiveTab(group);
};

const getPinnedBoundary = (group: EditorGroupState) => {
  const firstUnpinnedIndex = group.tabs.findIndex(tab => tab.state !== 'pinned');
  return firstUnpinnedIndex === -1 ? group.tabs.length : firstUnpinnedIndex;
};

const insertTabRespectingPinnedBoundary = (group: EditorGroupState, tab: CanvasTab) => {
  const insertIndex = getPinnedBoundary(group);
  group.tabs.splice(insertIndex, 0, tab);
};

// ==================== Store Creation ====================

const createCanvasStoreHook = () => create<CanvasStore>()(
  immer((set, get) => ({
      ...initialState,
      
      // ==================== Tab Operations ====================
      
      addTab: (content, state = 'preview', groupId) => {
        set((draft) => {
          let targetGroupId = groupId || draft.activeGroupId;
          
          // Adjust target group based on splitMode to ensure visibility
          if (draft.layout.splitMode === 'none') {
            // Single-column mode: use primary group only
            targetGroupId = 'primary';
            draft.activeGroupId = 'primary';
          } else if (draft.layout.splitMode === 'horizontal' || draft.layout.splitMode === 'vertical') {
            // Two-column mode: use primary or secondary (not tertiary)
            if (targetGroupId === 'tertiary') {
              targetGroupId = draft.activeGroupId === 'primary' ? 'primary' : 'secondary';
              draft.activeGroupId = targetGroupId;
            }
          }
          // Grid mode: all three groups are allowed
          
          const group = getGroup(draft, targetGroupId);
          
          if (state === 'preview') {
            const previewIndex = group.tabs.findIndex(
              t => t.state === 'preview' && !t.isHidden
            );
            if (previewIndex !== -1) {
              group.tabs.splice(previewIndex, 1);
            }
          }
          
          const newTab = createTab(content, state);
          insertTabRespectingPinnedBoundary(group, newTab);
          group.activeTabId = newTab.id;
          draft.activeGroupId = targetGroupId;
        });
      },
      
      detachTab: (tabId, groupId) => set(draft => {
        const group = getGroup(draft, groupId);
        group.tabs = group.tabs.filter(tab => tab.id !== tabId);
        ensureValidActiveTab(group);
      }),

      closeTab: (tabId, groupId, options) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tabIndex = group.tabs.findIndex(t => t.id === tabId);
          
          if (tabIndex === -1) return;
          
          const tab = group.tabs[tabIndex];
          // Closing a terminal tab must destroy its PTY. Keep the explicit option
          // for callers that already use it, but never hide terminals for reuse.
          const forceRemove = options?.forceRemove === true || tab.content.type === 'terminal';
          
          // Closed processes and temporary side conversations cannot be restored.
          if (!(tab.content.type === 'terminal' && forceRemove) && !tab.content.metadata?.discardSessionOnClose) {
            // Record in close history
            draft.closedTabs.unshift({
              tab: { ...tab },
              closedAt: Date.now(),
              groupId,
              index: tabIndex,
            });
            // Limit history size
            if (draft.closedTabs.length > draft.maxClosedTabsHistory) {
              draft.closedTabs.pop();
            }
          }
          
          // Remove tab
          group.tabs.splice(tabIndex, 1);
          
          // If closing active tab, switch to adjacent tab
          if (group.activeTabId === tabId) {
            const visibleTabs = group.tabs.filter(t => !t.isHidden);
            if (visibleTabs.length > 0) {
              const nextIndex = Math.min(tabIndex, visibleTabs.length - 1);
              group.activeTabId = visibleTabs[nextIndex]?.id || null;
            } else {
              group.activeTabId = null;
            }
          }
          
          // Auto-merge empty editor groups
          const getVisibleCount = (g: EditorGroupState) => g.tabs.filter(t => !t.isHidden).length;
          const getVisibleTabs = (g: EditorGroupState) => g.tabs.filter(t => !t.isHidden);
          
          const pCount = getVisibleCount(draft.primaryGroup);
          const sCount = getVisibleCount(draft.secondaryGroup);
          const tCount = getVisibleCount(draft.tertiaryGroup);
          
          // Helper: ensure activeTabId is valid
          const ensureValidActiveTab = (group: EditorGroupState) => {
            const visibleTabs = getVisibleTabs(group);
            if (visibleTabs.length === 0) {
              group.activeTabId = null;
            } else if (group.activeTabId === null || !visibleTabs.find(t => t.id === group.activeTabId)) {
              // If activeTabId is invalid, use first visible tab
              group.activeTabId = visibleTabs[0]?.id || null;
            }
          };
          
          // Helper: merge tabs from multiple groups into primary
          const mergeGroupsToPrimary = (sourceGroups: EditorGroupId[]) => {
            const allTabs: CanvasTab[] = [];
            let activeTabId: string | null = null;
            
            // Prefer active tab from current active group
            const currentActiveGroupId = draft.activeGroupId;
            if (sourceGroups.includes(currentActiveGroupId)) {
              const currentGroup = getGroup(draft, currentActiveGroupId);
              const visibleTabs = getVisibleTabs(currentGroup);
              if (currentGroup.activeTabId && visibleTabs.find(t => t.id === currentGroup.activeTabId)) {
                activeTabId = currentGroup.activeTabId;
              }
            }
            
            // Collect all visible tabs
            for (const sourceGroupId of sourceGroups) {
              const sourceGroup = getGroup(draft, sourceGroupId);
              const visibleTabs = getVisibleTabs(sourceGroup);
              allTabs.push(...visibleTabs);
              
              // If active tab not chosen, use one from source group if still visible
              if (!activeTabId && sourceGroup.activeTabId && visibleTabs.find(t => t.id === sourceGroup.activeTabId)) {
                activeTabId = sourceGroup.activeTabId;
              }
            }
            
            // Merge into primary group
            draft.primaryGroup.tabs = allTabs;
            draft.primaryGroup.activeTabId = activeTabId || (allTabs.length > 0 ? allTabs[0].id : null);
            
            // Reset other groups
            draft.secondaryGroup = createEditorGroupState();
            draft.tertiaryGroup = createEditorGroupState();
          };
          
          if (draft.layout.splitMode === 'grid') {
            if (tCount === 0 && pCount > 0 && sCount > 0) {
              // Tertiary empty; primary + secondary have tabs -> downgrade to horizontal
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'horizontal';
              if (draft.activeGroupId === 'tertiary') {
                // If tertiary was active, switch to primary (tertiary is empty)
                draft.activeGroupId = 'primary';
                ensureValidActiveTab(draft.primaryGroup);
              }
            } else if (tCount === 0 && (pCount === 0 || sCount === 0)) {
              // Tertiary empty and primary/secondary missing -> merge remaining to primary
              const remainingGroups: EditorGroupId[] = [];
              if (pCount > 0) remainingGroups.push('primary');
              if (sCount > 0) remainingGroups.push('secondary');
              
              if (remainingGroups.length > 0) {
                mergeGroupsToPrimary(remainingGroups);
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
              } else {
                // All groups are empty
                draft.primaryGroup = createEditorGroupState();
                draft.secondaryGroup = createEditorGroupState();
                draft.tertiaryGroup = createEditorGroupState();
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
              }
            } else if (pCount === 0 && sCount === 0 && tCount > 0) {
              // Primary + secondary empty; tertiary has tabs -> merge to primary
              mergeGroupsToPrimary(['tertiary']);
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
            } else if (pCount === 0 && sCount > 0) {
              // Primary empty; secondary and tertiary have tabs
              // Move secondary -> primary (top), tertiary -> secondary (bottom)
              // Because secondary (top-right) and tertiary (bottom) are vertical -> downgrade to vertical
              const sTabs = getVisibleTabs(draft.secondaryGroup);
              const tTabs = getVisibleTabs(draft.tertiaryGroup);
              
              draft.primaryGroup.tabs = sTabs;
              draft.primaryGroup.activeTabId = draft.secondaryGroup.activeTabId && 
                sTabs.find(t => t.id === draft.secondaryGroup.activeTabId) 
                  ? draft.secondaryGroup.activeTabId 
                  : (sTabs[0]?.id || null);
              
              draft.secondaryGroup.tabs = tTabs;
              draft.secondaryGroup.activeTabId = draft.tertiaryGroup.activeTabId && 
                tTabs.find(t => t.id === draft.tertiaryGroup.activeTabId) 
                  ? draft.tertiaryGroup.activeTabId 
                  : (tTabs[0]?.id || null);
              
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'vertical';
              
              // If activeGroupId points to merged group, switch appropriately
              if (draft.activeGroupId === 'secondary') {
                draft.activeGroupId = 'primary';
              } else if (draft.activeGroupId === 'tertiary') {
                draft.activeGroupId = 'secondary';
              }
              // If activeGroupId is already 'primary', keep it
            } else if (sCount === 0 && pCount > 0) {
              // Secondary empty; primary and tertiary have tabs
              // Move tertiary -> secondary
              // Because primary (top-left) and tertiary (bottom) are vertical -> downgrade to vertical
              const tTabs = getVisibleTabs(draft.tertiaryGroup);
              draft.secondaryGroup.tabs = tTabs;
              draft.secondaryGroup.activeTabId = draft.tertiaryGroup.activeTabId && 
                tTabs.find(t => t.id === draft.tertiaryGroup.activeTabId) 
                  ? draft.tertiaryGroup.activeTabId 
                  : (tTabs[0]?.id || null);
              
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'vertical';
              
              // If activeGroupId points to tertiary, switch to secondary
              if (draft.activeGroupId === 'tertiary') {
                draft.activeGroupId = 'secondary';
              }
            }
            
            // Ensure activeTabId is valid for all groups
            ensureValidActiveTab(draft.primaryGroup);
            ensureValidActiveTab(draft.secondaryGroup);
            ensureValidActiveTab(draft.tertiaryGroup);
          } else if (draft.layout.splitMode === 'horizontal' || draft.layout.splitMode === 'vertical') {
            if (sCount === 0 && pCount > 0) {
              // Secondary empty; primary has tabs -> merge to single column
              draft.secondaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
              ensureValidActiveTab(draft.primaryGroup);
            } else if (pCount === 0 && sCount > 0) {
              // Primary empty; secondary has tabs -> merge to primary
              mergeGroupsToPrimary(['secondary']);
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
            } else if (pCount === 0 && sCount === 0) {
              // Both groups are empty
              draft.primaryGroup = createEditorGroupState();
              draft.secondaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
            }
          }
          
          // Final check: ensure activeGroupId points to a group with tabs
          const finalPCount = getVisibleCount(draft.primaryGroup);
          const finalSCount = getVisibleCount(draft.secondaryGroup);
          const finalTCount = getVisibleCount(draft.tertiaryGroup);
          
          if (draft.activeGroupId === 'primary' && finalPCount === 0) {
            // Primary empty; switch to group with tabs
            if (finalSCount > 0) {
              draft.activeGroupId = 'secondary';
            } else if (finalTCount > 0) {
              draft.activeGroupId = 'tertiary';
            }
          } else if (draft.activeGroupId === 'secondary' && finalSCount === 0) {
            // Secondary empty; switch to group with tabs
            if (finalPCount > 0) {
              draft.activeGroupId = 'primary';
            } else if (finalTCount > 0) {
              draft.activeGroupId = 'tertiary';
            }
          } else if (draft.activeGroupId === 'tertiary' && finalTCount === 0) {
            // Tertiary empty; switch to group with tabs
            if (finalPCount > 0) {
              draft.activeGroupId = 'primary';
            } else if (finalSCount > 0) {
              draft.activeGroupId = 'secondary';
            }
          }
        });
      },

      closeTerminalTabBySessionId: (sessionId) => {
        const state = get();
        const result = state.findTabByMetadata({ sessionId });
        if (!result || result.tab.content.type !== 'terminal') return;
        state.closeTab(result.tab.id, result.groupId, { forceRemove: true });
      },

      renameTerminalTabBySessionId: (sessionId, newName) => {
        const result = get().findTabByMetadata({ sessionId });
        if (!result || result.tab.content.type !== 'terminal') return;
        
        set((draft) => {
          const group = getGroup(draft, result.groupId);
          const tab = group.tabs.find(t => t.id === result.tab.id);
          if (tab) {
            tab.title = newName;
            tab.content.title = newName;
            tab.content.data = { ...tab.content.data, sessionName: newName };
          }
        });
      },
      
      closeAllTabs: (groupId) => {
        set((draft) => {
          if (groupId) {
            const group = getGroup(draft, groupId);
            keepPinnedTabsOnly(group);

            const pCount = draft.primaryGroup.tabs.filter(t => !t.isHidden).length;
            const sCount = draft.secondaryGroup.tabs.filter(t => !t.isHidden).length;

            if (draft.layout.splitMode === 'grid') {
              if (groupId === 'tertiary') {
                if (pCount > 0 && sCount > 0) {
                  draft.layout.splitMode = 'horizontal';
                  draft.activeGroupId = 'primary';
                } else if (pCount > 0 || sCount > 0) {
                  draft.primaryGroup = pCount > 0 ? draft.primaryGroup : draft.secondaryGroup;
                  draft.secondaryGroup = createEditorGroupState();
                  draft.tertiaryGroup = createEditorGroupState();
                  draft.layout.splitMode = 'none';
                  draft.activeGroupId = 'primary';
                } else {
                  draft.layout.splitMode = 'none';
                  draft.activeGroupId = 'primary';
                }
              } else {
                // Closing primary or secondary
                const tCount = draft.tertiaryGroup.tabs.filter(t => !t.isHidden).length;
                
                if (groupId === 'primary') {
                  // Closing primary; remaining secondary and/or tertiary
                  if (sCount > 0 && tCount > 0) {
                    // Secondary + tertiary remain -> downgrade to vertical
                    draft.primaryGroup = { ...draft.secondaryGroup };
                    draft.secondaryGroup = { ...draft.tertiaryGroup };
                    draft.tertiaryGroup = createEditorGroupState();
                    draft.layout.splitMode = 'vertical';
                    draft.activeGroupId = 'primary';
                  } else if (sCount > 0) {
                    // Only secondary remains
                    draft.primaryGroup = { ...draft.secondaryGroup };
                    draft.secondaryGroup = createEditorGroupState();
                    draft.tertiaryGroup = createEditorGroupState();
                    draft.layout.splitMode = 'none';
                    draft.activeGroupId = 'primary';
                  } else if (tCount > 0) {
                    // Only tertiary remains
                    draft.primaryGroup = { ...draft.tertiaryGroup };
                    draft.secondaryGroup = createEditorGroupState();
                    draft.tertiaryGroup = createEditorGroupState();
                    draft.layout.splitMode = 'none';
                    draft.activeGroupId = 'primary';
                  } else {
                    // All empty
                    draft.layout.splitMode = 'none';
                    draft.activeGroupId = 'primary';
                  }
                } else if (groupId === 'secondary') {
                  // Closing secondary; remaining primary and/or tertiary
                  if (pCount > 0 && tCount > 0) {
                    // Primary + tertiary remain -> downgrade to vertical
                    draft.secondaryGroup = { ...draft.tertiaryGroup };
                    draft.tertiaryGroup = createEditorGroupState();
                    draft.layout.splitMode = 'vertical';
                    draft.activeGroupId = 'primary';
                  } else if (pCount > 0) {
                    // Only primary remains
                    draft.secondaryGroup = createEditorGroupState();
                    draft.tertiaryGroup = createEditorGroupState();
                    draft.layout.splitMode = 'none';
                    draft.activeGroupId = 'primary';
                  } else if (tCount > 0) {
                    // Only tertiary remains
                    draft.primaryGroup = { ...draft.tertiaryGroup };
                    draft.secondaryGroup = createEditorGroupState();
                    draft.tertiaryGroup = createEditorGroupState();
                    draft.layout.splitMode = 'none';
                    draft.activeGroupId = 'primary';
                  } else {
                    // All empty
                    draft.layout.splitMode = 'none';
                    draft.activeGroupId = 'primary';
                  }
                }
              }
            } else if (draft.layout.splitMode === 'horizontal' || draft.layout.splitMode === 'vertical') {
              // Handle horizontal/vertical split mode
              if (groupId === 'secondary' && pCount > 0) {
                // Close secondary; primary has tabs -> merge to single column
                draft.secondaryGroup = createEditorGroupState();
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
                // Ensure primary has a valid activeTabId
                const visibleTabs = draft.primaryGroup.tabs.filter(t => !t.isHidden);
                if (visibleTabs.length > 0 && (!draft.primaryGroup.activeTabId || !visibleTabs.find(t => t.id === draft.primaryGroup.activeTabId))) {
                  draft.primaryGroup.activeTabId = visibleTabs[0].id;
                }
              } else if (groupId === 'primary' && sCount > 0) {
                // Close primary; secondary has tabs -> move to primary
                draft.primaryGroup = { ...draft.secondaryGroup };
                draft.secondaryGroup = createEditorGroupState();
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
              } else {
                // Both groups empty or closing the only group with tabs
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
              }
            }
          } else {
            keepPinnedTabsOnly(draft.primaryGroup);
            keepPinnedTabsOnly(draft.secondaryGroup);
            keepPinnedTabsOnly(draft.tertiaryGroup);

            const pCount = getVisibleCount(draft.primaryGroup);
            const sCount = getVisibleCount(draft.secondaryGroup);
            const tCount = getVisibleCount(draft.tertiaryGroup);

            if (pCount === 0 && sCount === 0 && tCount === 0) {
              draft.primaryGroup = createEditorGroupState();
              draft.secondaryGroup = createEditorGroupState();
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
            } else if (draft.layout.splitMode === 'grid') {
              if (pCount > 0 && sCount > 0 && tCount > 0) {
                ensureValidActiveTab(draft.primaryGroup);
                ensureValidActiveTab(draft.secondaryGroup);
                ensureValidActiveTab(draft.tertiaryGroup);
              } else {
                const remainingGroups: EditorGroupState[] = [];
                if (pCount > 0) remainingGroups.push(draft.primaryGroup);
                if (sCount > 0) remainingGroups.push(draft.secondaryGroup);
                if (tCount > 0) remainingGroups.push(draft.tertiaryGroup);

                draft.primaryGroup = remainingGroups[0] ? { ...remainingGroups[0] } : createEditorGroupState();
                draft.secondaryGroup = remainingGroups[1] ? { ...remainingGroups[1] } : createEditorGroupState();
                draft.tertiaryGroup = remainingGroups[2] ? { ...remainingGroups[2] } : createEditorGroupState();
                draft.layout.splitMode = remainingGroups.length >= 3 ? 'grid' : remainingGroups.length === 2 ? 'horizontal' : 'none';
                draft.activeGroupId = 'primary';
                ensureValidActiveTab(draft.primaryGroup);
                ensureValidActiveTab(draft.secondaryGroup);
                ensureValidActiveTab(draft.tertiaryGroup);
              }
            } else if (draft.layout.splitMode === 'horizontal' || draft.layout.splitMode === 'vertical') {
              if (pCount > 0 && sCount > 0) {
                ensureValidActiveTab(draft.primaryGroup);
                ensureValidActiveTab(draft.secondaryGroup);
              } else if (pCount > 0) {
                draft.secondaryGroup = createEditorGroupState();
                draft.tertiaryGroup = createEditorGroupState();
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
                ensureValidActiveTab(draft.primaryGroup);
              } else if (sCount > 0) {
                draft.primaryGroup = { ...draft.secondaryGroup };
                draft.secondaryGroup = createEditorGroupState();
                draft.tertiaryGroup = createEditorGroupState();
                draft.layout.splitMode = 'none';
                draft.activeGroupId = 'primary';
                ensureValidActiveTab(draft.primaryGroup);
              }
            } else {
              ensureValidActiveTab(draft.primaryGroup);
              draft.activeGroupId = 'primary';
            }
          }
        });
      },
      
      switchToTab: (tabId, groupId) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (!tab) return;
          
          // Unhide if the tab is hidden
          if (tab.isHidden) {
            tab.isHidden = false;
          }
          
          // Update last accessed time
          tab.lastAccessedAt = Date.now();
          
          group.activeTabId = tabId;
          draft.activeGroupId = groupId;
        });
      },
      
      updateTabContent: (tabId, groupId, content) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (tab) {
            tab.content = content;
            tab.title = content.title || tab.title;
          }
        });
      },
      
      setTabDirty: (tabId, groupId, isDirty) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (tab) {
            tab.isDirty = isDirty;
          }
        });
      },

      setTabFileDeletedFromDisk: (tabId, groupId, deleted) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          if (tab) {
            tab.fileDeletedFromDisk = deleted;
          }
        });
      },
      
      promoteTab: (tabId, groupId) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (tab && tab.state === 'preview') {
            tab.state = 'active';
          }
        });
      },
      
      togglePinTab: (tabId, groupId) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (tab) {
            if (tab.state === 'pinned') {
              tab.state = 'active';
            } else {
              tab.state = 'pinned';
            }

            const tabIndex = group.tabs.findIndex(t => t.id === tabId);
            if (tabIndex !== -1) {
              const [movedTab] = group.tabs.splice(tabIndex, 1);
              insertTabRespectingPinnedBoundary(group, movedTab);
            }
          }
        });
      },
      
      findTabByMetadata: (metadata) => {
        const state = get();
        const groups: { id: EditorGroupId; group: EditorGroupState }[] = [
          { id: 'primary', group: state.primaryGroup },
          { id: 'secondary', group: state.secondaryGroup },
          { id: 'tertiary', group: state.tertiaryGroup },
        ];
        
        for (const { id, group } of groups) {
          const tab = group.tabs.find(t => {
            if (!t.content.metadata) return false;
            return Object.keys(metadata).every(key => {
              const metadataValue = metadata[key];
              const tabValue = t.content.metadata?.[key];
              if (key === 'duplicateCheckKey' && typeof metadataValue === 'string' && typeof tabValue === 'string') {
                return normalizePath(metadataValue) === normalizePath(tabValue);
              }
              return tabValue === metadataValue;
            });
          });
          if (tab) {
            return { tab, groupId: id };
          }
        }
        return null;
      },
      
      reopenClosedTab: () => {
        set((draft) => {
          const record = draft.closedTabs.shift();
          if (record) {
            const group = getGroup(draft, record.groupId);
            
            // Restore tab to its original position
            const insertIndex = Math.min(record.index, group.tabs.length);
            group.tabs.splice(insertIndex, 0, {
              ...record.tab,
              lastAccessedAt: Date.now(),
            });
            group.activeTabId = record.tab.id;
            draft.activeGroupId = record.groupId;
          }
        });
      },
      
      hideTab: (tabId, groupId) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (tab) {
            tab.isHidden = true;
            
            if (group.activeTabId === tabId) {
              const visibleTabs = group.tabs.filter(t => !t.isHidden);
              group.activeTabId = visibleTabs[0]?.id || null;
            }
          }
        });
      },
      
      showTab: (tabId, groupId) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tab = group.tabs.find(t => t.id === tabId);
          
          if (tab) {
            tab.isHidden = false;
            group.activeTabId = tabId;
          }
        });
      },
      
      // ==================== Drag Operations ====================
      
      startDrag: (tabId, groupId) => {
        set((draft) => {
          draft.draggingTabId = tabId;
          draft.draggingFromGroupId = groupId;
        });
      },
      
      endDrag: () => {
        set((draft) => {
          draft.draggingTabId = null;
          draft.draggingFromGroupId = null;
        });
      },
      
      moveTabToGroup: (tabId, fromGroupId, toGroupId, index) => {
        if (fromGroupId === toGroupId) return;
        
        set((draft) => {
          const fromGroup = fromGroupId === 'primary' ? draft.primaryGroup : draft.secondaryGroup;
          const toGroup = toGroupId === 'primary' ? draft.primaryGroup : draft.secondaryGroup;
          
          const tabIndex = fromGroup.tabs.findIndex(t => t.id === tabId);
          if (tabIndex === -1) return;
          
          const [tab] = fromGroup.tabs.splice(tabIndex, 1);
          
          // Add to target group
          const insertIndex = index !== undefined ? Math.min(index, toGroup.tabs.length) : 0;
          toGroup.tabs.splice(insertIndex, 0, tab);
          toGroup.activeTabId = tab.id;
          
          // Update active tab in source group
          if (fromGroup.activeTabId === tabId) {
            const visibleTabs = fromGroup.tabs.filter(t => !t.isHidden);
            fromGroup.activeTabId = visibleTabs[Math.min(tabIndex, visibleTabs.length - 1)]?.id || null;
          }
          
          // If single-column, enable split
          if (draft.layout.splitMode === 'none') {
            draft.layout.splitMode = 'horizontal';
          }
          
          draft.activeGroupId = toGroupId;
        });
      },
      
      reorderTab: (tabId, groupId, newIndex) => {
        set((draft) => {
          const group = getGroup(draft, groupId);
          const tabIndex = group.tabs.findIndex(t => t.id === tabId);
          
          if (tabIndex === -1 || tabIndex === newIndex) return;
          
          const [tab] = group.tabs.splice(tabIndex, 1);
          const pinnedBoundary = getPinnedBoundary(group);
          const targetIndex = tab.state === 'pinned'
            ? Math.max(0, Math.min(newIndex, pinnedBoundary))
            : Math.max(pinnedBoundary, Math.min(newIndex, group.tabs.length));
          group.tabs.splice(targetIndex, 0, tab);
        });
      },
      
      handleDrop: (tabId, fromGroupId, toGroupId, position) => {
        set((draft) => {
          const fromGroup = getGroup(draft, fromGroupId);
          const tabIndex = fromGroup.tabs.findIndex(t => t.id === tabId);
          if (tabIndex === -1) return;

          const [tab] = fromGroup.tabs.splice(tabIndex, 1);

          if (fromGroup.activeTabId === tabId) {
            const visible = fromGroup.tabs.filter(t => !t.isHidden);
            fromGroup.activeTabId = visible[Math.min(tabIndex, visible.length - 1)]?.id || null;
          }

          const { splitMode } = draft.layout;

          if (splitMode === 'none') {
            if (position === 'left' || position === 'right') {
              draft.layout.splitMode = 'horizontal';
              if (position === 'left') {
                draft.secondaryGroup.tabs = [...draft.primaryGroup.tabs];
                draft.secondaryGroup.activeTabId = draft.primaryGroup.activeTabId;
                draft.primaryGroup.tabs = [tab];
                draft.primaryGroup.activeTabId = tab.id;
              } else {
                draft.secondaryGroup.tabs = [tab];
                draft.secondaryGroup.activeTabId = tab.id;
              }
              draft.activeGroupId = position === 'left' ? 'primary' : 'secondary';
            } else if (position === 'top' || position === 'bottom') {
              draft.layout.splitMode = 'vertical';
              if (position === 'top') {
                draft.secondaryGroup.tabs = [...draft.primaryGroup.tabs];
                draft.secondaryGroup.activeTabId = draft.primaryGroup.activeTabId;
                draft.primaryGroup.tabs = [tab];
                draft.primaryGroup.activeTabId = tab.id;
              } else {
                draft.secondaryGroup.tabs = [tab];
                draft.secondaryGroup.activeTabId = tab.id;
              }
              draft.activeGroupId = position === 'top' ? 'primary' : 'secondary';
            }
          } else if (splitMode === 'horizontal') {
            if (position === 'bottom') {
              draft.layout.splitMode = 'grid';
              draft.tertiaryGroup.tabs = [tab];
              draft.tertiaryGroup.activeTabId = tab.id;
              draft.activeGroupId = 'tertiary';
            } else if (position === 'top') {
              draft.layout.splitMode = 'grid';
              draft.tertiaryGroup.tabs = [...draft.primaryGroup.tabs, ...draft.secondaryGroup.tabs];
              draft.tertiaryGroup.activeTabId = draft.primaryGroup.activeTabId || draft.secondaryGroup.activeTabId;
              draft.primaryGroup.tabs = [tab];
              draft.primaryGroup.activeTabId = tab.id;
              draft.secondaryGroup = createEditorGroupState();
              draft.activeGroupId = 'primary';
            } else if (position === 'center') {
              const targetGroup = getGroup(draft, toGroupId);
              targetGroup.tabs.unshift(tab);
              targetGroup.activeTabId = tab.id;
              draft.activeGroupId = toGroupId;
            } else {
              const targetGroupId = position === 'left' ? 'primary' : 'secondary';
              const targetGroup = getGroup(draft, targetGroupId);
              targetGroup.tabs.unshift(tab);
              targetGroup.activeTabId = tab.id;
              draft.activeGroupId = targetGroupId;
            }
          } else if (splitMode === 'vertical') {
            if (position === 'center') {
              const targetGroup = getGroup(draft, toGroupId);
              targetGroup.tabs.unshift(tab);
              targetGroup.activeTabId = tab.id;
              draft.activeGroupId = toGroupId;
            } else {
              const targetGroupId = position === 'top' ? 'primary' : 'secondary';
              const targetGroup = getGroup(draft, targetGroupId);
              targetGroup.tabs.unshift(tab);
              targetGroup.activeTabId = tab.id;
              draft.activeGroupId = targetGroupId;
            }
          } else if (splitMode === 'grid') {
            if (position === 'center') {
              const targetGroup = getGroup(draft, toGroupId);
              targetGroup.tabs.unshift(tab);
              targetGroup.activeTabId = tab.id;
              draft.activeGroupId = toGroupId;
            }
          }

          // Auto-merge empty editor groups
          const getVisibleCount = (g: EditorGroupState) => g.tabs.filter(t => !t.isHidden).length;
          const primaryCount = getVisibleCount(draft.primaryGroup);
          const secondaryCount = getVisibleCount(draft.secondaryGroup);
          const tertiaryCount = getVisibleCount(draft.tertiaryGroup);

          if (draft.layout.splitMode === 'grid') {
            let gridHandled = false;
            
            if (tertiaryCount === 0) {
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'horizontal';
              gridHandled = true;
            }
            if (primaryCount === 0 && secondaryCount === 0) {
              draft.primaryGroup = { ...draft.tertiaryGroup };
              draft.secondaryGroup = createEditorGroupState();
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
              gridHandled = true;
            }
            // FIX: handle primary empty while secondary and tertiary have tabs
            if (primaryCount === 0 && secondaryCount > 0 && tertiaryCount > 0) {
              // Move secondary -> primary (top), tertiary -> secondary (bottom), downgrade to vertical
              // Tabs are dropped to "bottom", so final layout should be vertical
              draft.primaryGroup = { ...draft.secondaryGroup };
              draft.secondaryGroup = { ...draft.tertiaryGroup };
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'vertical';
              // If active group is tertiary, update to secondary
              if (draft.activeGroupId === 'tertiary') {
                draft.activeGroupId = 'secondary';
              }
              gridHandled = true;
            }
            // FIX: handle secondary empty while primary and tertiary have tabs
            if (secondaryCount === 0 && primaryCount > 0 && tertiaryCount > 0) {
              // Move tertiary -> secondary, downgrade to vertical
              // Primary (top-left) and tertiary (bottom) are vertical
              draft.secondaryGroup = { ...draft.tertiaryGroup };
              draft.tertiaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'vertical';
              // If active group is tertiary, update to secondary
              if (draft.activeGroupId === 'tertiary') {
                draft.activeGroupId = 'secondary';
              }
              gridHandled = true;
            }
            
            // If grid handling finished, skip horizontal/vertical checks
            if (gridHandled) {
              return;
            }
          }

          if (draft.layout.splitMode === 'horizontal' || draft.layout.splitMode === 'vertical') {
            if (secondaryCount === 0) {
              draft.secondaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
            } else if (primaryCount === 0) {
              draft.primaryGroup = { ...draft.secondaryGroup };
              draft.secondaryGroup = createEditorGroupState();
              draft.layout.splitMode = 'none';
              draft.activeGroupId = 'primary';
            }
          }
        });
      },
      
      // ==================== Layout Operations ====================
      
      setSplitMode: (mode) => {
        set((draft) => {
          if (mode === 'none' && draft.layout.splitMode !== 'none') {
            const allTabs = [
              ...draft.primaryGroup.tabs,
              ...draft.secondaryGroup.tabs,
              ...draft.tertiaryGroup.tabs,
            ];
            draft.primaryGroup.tabs = allTabs;
            draft.primaryGroup.activeTabId = 
              draft.primaryGroup.activeTabId || 
              draft.secondaryGroup.activeTabId || 
              draft.tertiaryGroup.activeTabId;
            draft.secondaryGroup = createEditorGroupState();
            draft.tertiaryGroup = createEditorGroupState();
            draft.activeGroupId = 'primary';
          }
          draft.layout.splitMode = mode;
        });
      },
      
      setSplitRatio: (ratio) => {
        set((draft) => {
          draft.layout.splitRatio = clampSplitRatio(ratio);
        });
      },

      setSplitRatio2: (ratio) => {
        set((draft) => {
          draft.layout.splitRatio2 = clampSplitRatio(ratio);
        });
      },
      
      setAnchorPosition: (position) => {
        set((draft) => {
          draft.layout.anchorPosition = position;
        });
      },
      
      setAnchorSize: (size) => {
        set((draft) => {
          draft.layout.anchorSize = clampAnchorSize(size);
        });
      },
      
      toggleMaximize: () => {
        set((draft) => {
          draft.layout.isMaximized = !draft.layout.isMaximized;
        });
      },
      
      setActiveGroup: (groupId) => {
        set((draft) => {
          draft.activeGroupId = groupId;
        });
      },
      
      // ==================== Mission Control ====================
      
      openMissionControl: () => {
        set((draft) => {
          draft.isMissionControlOpen = true;
        });
      },
      
      closeMissionControl: () => {
        set((draft) => {
          draft.isMissionControlOpen = false;
        });
      },
      
      toggleMissionControl: () => {
        set((draft) => {
          draft.isMissionControlOpen = !draft.isMissionControlOpen;
        });
      },
      
      // ==================== State Management ====================
      
      reset: () => {
        set(initialState);
      },
      
      getAllTabs: () => {
        const state = get();
        return [
          ...state.primaryGroup.tabs,
          ...state.secondaryGroup.tabs,
          ...state.tertiaryGroup.tabs,
        ];
      },
    }))
);

export type CanvasStoreMode = 'agent' | 'git' | 'bottom-terminal';

/**
 * Selects which canvas store instance is used by the current subtree.
 * Defaults to 'agent' to preserve existing behavior in AI Agent scene.
 */
export const CanvasStoreModeContext = createContext<CanvasStoreMode>('agent');

export const useAgentCanvasStore = createCanvasStoreHook();
export const useGitCanvasStore = createCanvasStoreHook();
export const useBottomTerminalCanvasStore = createCanvasStoreHook();

// ==================== Agent canvas: per-scope snapshots (AuxPane / Session scene) ====================
// The agent canvas is scoped to the active session. Leaving a session saves its canvas under that
// session id and entering another one restores its own tabs, so two sessions never share content.

const AGENT_CANVAS_SNAPSHOT_MAX = 24;
const agentScopeSnapshots = new Map<string, CanvasStoreState>();
const agentSnapshotLruOrder: string[] = [];

function normalizeAgentScopeKey(id: string | null | undefined): string {
  return id ?? '__none__';
}

function extractAgentPersistableState(state: CanvasStore): CanvasStoreState {
  return {
    primaryGroup: state.primaryGroup,
    secondaryGroup: state.secondaryGroup,
    tertiaryGroup: state.tertiaryGroup,
    activeGroupId: state.activeGroupId,
    layout: state.layout,
    isMissionControlOpen: state.isMissionControlOpen,
    draggingTabId: state.draggingTabId,
    draggingFromGroupId: state.draggingFromGroupId,
    closedTabs: state.closedTabs,
    maxClosedTabsHistory: state.maxClosedTabsHistory,
  };
}

function rememberAgentSnapshot(key: string, snapshot: CanvasStoreState): void {
  const clone = structuredClone(snapshot);
  clone.draggingTabId = null;
  clone.draggingFromGroupId = null;
  agentScopeSnapshots.set(key, clone);
  const idx = agentSnapshotLruOrder.indexOf(key);
  if (idx >= 0) agentSnapshotLruOrder.splice(idx, 1);
  agentSnapshotLruOrder.push(key);
  while (agentScopeSnapshots.size > AGENT_CANVAS_SNAPSHOT_MAX) {
    // An open temporary conversation has no sidebar/history recovery path.
    // Retain its small tab snapshot until the user explicitly closes it.
    const evictIndex = agentSnapshotLruOrder.findIndex(scope => {
      const state = agentScopeSnapshots.get(scope);
      return !state || ![state.primaryGroup, state.secondaryGroup, state.tertiaryGroup]
        .some(group => group.tabs.some(tab => tab.content.metadata?.discardSessionOnClose));
    });
    if (evictIndex < 0) break;
    const [evict] = agentSnapshotLruOrder.splice(evictIndex, 1);
    if (!evict) break;
    agentScopeSnapshots.delete(evict);
  }
}

/** Discard all views of an explicitly closed side conversation, including suspended canvases. */
export function removeBtwSessionFromAgentCanvas(sessionId: string): void {
  const ownsSession = (tab: CanvasTab) =>
    tab.content.type === 'btw-session' && tab.content.data?.childSessionId === sessionId;
  const live = useAgentCanvasStore.getState();
  const tabIds = [live.primaryGroup, live.secondaryGroup, live.tertiaryGroup]
    .flatMap(group => group.tabs.filter(ownsSession).map(tab => tab.id));
  for (const tabId of tabIds) {
    const state = useAgentCanvasStore.getState();
    const owner = (['primary', 'secondary', 'tertiary'] as const)
      .find(id => state[`${id}Group`].tabs.some(tab => tab.id === tabId));
    if (owner) {
      const tab = state[`${owner}Group`].tabs.find(tab => tab.id === tabId)!;
      // Legacy tab metadata may predate the explicit discard contract.
      state.updateTabContent(tabId, owner, {
        ...tab.content, metadata: { ...tab.content.metadata, discardSessionOnClose: true },
      });
      state.closeTab(tabId, owner, { forceRemove: true });
    }
  }
  useAgentCanvasStore.setState(state => ({
    closedTabs: state.closedTabs.filter(record => !ownsSession(record.tab)),
  }));
  for (const [scope, snapshot] of agentScopeSnapshots) {
    const groups = [snapshot.primaryGroup, snapshot.secondaryGroup, snapshot.tertiaryGroup];
    if (!groups.some(group => group.tabs.some(ownsSession)) && !snapshot.closedTabs.some(record => ownsSession(record.tab))) continue;
    // Restoring a scope can freeze shared groups through Immer; revise a copy.
    const next = structuredClone(snapshot);
    for (const group of [next.primaryGroup, next.secondaryGroup, next.tertiaryGroup]) {
      group.tabs = group.tabs.filter(tab => !ownsSession(tab));
      if (!group.tabs.some(tab => tab.id === group.activeTabId && !tab.isHidden)) {
        group.activeTabId = group.tabs.find(tab => !tab.isHidden)?.id ?? null;
      }
    }
    next.closedTabs = next.closedTabs.filter(record => !ownsSession(record.tab));
    agentScopeSnapshots.set(scope, next);
  }
}

function applyEmptyAgentCanvas(scopeKey?: string): void {
  useAgentCanvasStore.setState({
    scopeKey,
    primaryGroup: createEditorGroupState(),
    secondaryGroup: createEditorGroupState(),
    tertiaryGroup: createEditorGroupState(),
    activeGroupId: 'primary',
    layout: createLayoutState(),
    isMissionControlOpen: false,
    draggingTabId: null,
    draggingFromGroupId: null,
    closedTabs: [],
    maxClosedTabsHistory: initialState.maxClosedTabsHistory,
  });
}

/** Clear agent canvas snapshots when entering/exiting Peer Device Mode. */
export function clearAgentCanvasForPeerSwitch(): void {
  agentScopeSnapshots.clear();
  agentSnapshotLruOrder.length = 0;
  applyEmptyAgentCanvas();
  useGitCanvasStore.getState().reset();
  useBottomTerminalCanvasStore.getState().reset();
}

/**
 * The store owns its live scope. A later host mount or stale caller cannot
 * overwrite content already committed for the target scope.
 */
export function switchAgentCanvasScope(nextScopeId: string | null | undefined): void {
  const from = useAgentCanvasStore.getState().scopeKey;
  const to = normalizeAgentScopeKey(nextScopeId);

  if (from === to) return;

  const rawNext = agentScopeSnapshots.get(to);
  const nextSnapshotClone = rawNext ? structuredClone(rawNext) : null;

  if (from !== undefined) {
    const current = extractAgentPersistableState(useAgentCanvasStore.getState() as CanvasStore);
    rememberAgentSnapshot(from, current);
  }

  if (nextSnapshotClone) {
    useAgentCanvasStore.setState({
      scopeKey: to,
      primaryGroup: nextSnapshotClone.primaryGroup,
      secondaryGroup: nextSnapshotClone.secondaryGroup,
      tertiaryGroup: nextSnapshotClone.tertiaryGroup,
      activeGroupId: nextSnapshotClone.activeGroupId,
      layout: nextSnapshotClone.layout,
      isMissionControlOpen: false,
      draggingTabId: null,
      draggingFromGroupId: null,
      closedTabs: nextSnapshotClone.closedTabs,
      maxClosedTabsHistory: nextSnapshotClone.maxClosedTabsHistory,
    });
  } else {
    applyEmptyAgentCanvas(to);
  }

}

const selectWholeCanvasStore = (state: CanvasStore) => state;

export function useCanvasStore(): CanvasStore;
export function useCanvasStore<T>(selector: (state: CanvasStore) => T): T;
export function useCanvasStore<T>(selector?: (state: CanvasStore) => T): T | CanvasStore {
  const mode = useContext(CanvasStoreModeContext);
  const resolvedSelector = (selector ?? selectWholeCanvasStore) as (state: CanvasStore) => T | CanvasStore;

  // Keep hook order stable across mode switches by subscribing to each scoped store.
  const agentValue = useAgentCanvasStore(resolvedSelector);
  const gitValue = useGitCanvasStore(resolvedSelector);
  const bottomTerminalValue = useBottomTerminalCanvasStore(resolvedSelector);

  if (mode === 'git') return gitValue;
  if (mode === 'bottom-terminal') return bottomTerminalValue;
  return agentValue;
}

// ==================== Selector Hooks ====================

/**
 * Get tabs for a specific editor group.
 */
export const useGroupTabs = (groupId: EditorGroupId) => {
  return useCanvasStore((state) => 
    groupId === 'primary' ? state.primaryGroup.tabs : state.secondaryGroup.tabs
  );
};

/**
 * Get active tab ID for a specific editor group.
 */
export const useActiveTabId = (groupId: EditorGroupId) => {
  return useCanvasStore((state) => 
    groupId === 'primary' ? state.primaryGroup.activeTabId : state.secondaryGroup.activeTabId
  );
};

/**
 * Get layout state.
 */
export const useLayout = () => {
  return useCanvasStore((state) => state.layout);
};

/**
 * Get drag state.
 */
export const useDragging = () => {
  return useCanvasStore((state) => ({
    draggingTabId: state.draggingTabId,
    draggingFromGroupId: state.draggingFromGroupId,
  }));
};

/** Includes suspended scope snapshots so unmounting a view does not discard its document. */
export function hasRetainedCanvasTab(tabId: string): boolean {
  const states = [useAgentCanvasStore.getState(), useGitCanvasStore.getState(), useBottomTerminalCanvasStore.getState(), ...agentScopeSnapshots.values()];
  return states.some(state => [state.primaryGroup, state.secondaryGroup, state.tertiaryGroup].some(group => group.tabs.some(tab => tab.id === tabId)));
}
