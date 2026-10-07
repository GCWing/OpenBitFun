/**
 * useTabLifecycle Hook
 * Manages tab lifecycle state transitions.
 *
 * State flow:
 * - Single click -> preview (replaces current preview tab)
 * - Double click / edit -> active
 * - Pin action -> pinned
 */

import { useCallback, useEffect } from 'react';
import {
  useCanvasStore,
  useAgentCanvasStore,
  useGitCanvasStore,
  useBottomTerminalCanvasStore,
} from '../stores';
import type { CanvasStoreMode } from '../stores/canvasStore';
import type { EditorGroupId, PanelContent, CreateTabEventDetail } from '../types';
import { TAB_EVENTS } from '../types';
import { openCanvasContent, openContentInBestTarget } from '@/shared/services/workbenchContentService';
import { useI18n } from '@/infrastructure/i18n';
import { drainPendingTabs } from '@/shared/services/pendingTabQueue';
import { confirmDialog, confirmDialogChoice } from '@/infrastructure/confirm-dialog';
import { createLogger } from '@/shared/utils/logger';
import { destroyTerminalSession } from '@/shared/services/destroyTerminalSession';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { canSaveBtwSessionAsFork, discardBtwSession, saveBtwSessionAsFork } from '@/flow_chat/services/BtwSessionLifecycle';
import { getActiveSurfaceScope, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';

const log = createLogger('useTabLifecycle');
interface UseTabLifecycleOptions {
  /** App mode / target canvas */
  mode?: CanvasStoreMode;
  /** Override the external tab creation event for specialized canvases. */
  createTabEventName?: string;
  /** Only the containing host decides whether opening content reveals a panel. */
  onReveal?: () => void;
}

interface UseTabLifecycleReturn {
  /** Open on single click (preview mode) */
  openPreview: (content: PanelContent, groupId?: EditorGroupId) => void;

  /** Open on double click (active mode) */
  openActive: (content: PanelContent, groupId?: EditorGroupId) => void;

  /** Promote to active on content edit */
  onContentEdit: (tabId: string, groupId: EditorGroupId) => void;

  /** Toggle pin/unpin */
  togglePin: (tabId: string, groupId: EditorGroupId) => void;

  /** Dirty check before closing a tab */
  handleCloseWithDirtyCheck: (tabId: string, groupId: EditorGroupId) => Promise<boolean>;

  /** Dirty check before closing all tabs */
  handleCloseAllWithDirtyCheck: (groupId: EditorGroupId) => Promise<boolean>;
}

/**
 * Tab lifecycle management hook.
 */
export const useTabLifecycle = (options: UseTabLifecycleOptions = {}): UseTabLifecycleReturn => {
  const {
    mode = 'agent',
    createTabEventName,
    onReveal,
  } = options;
  const { t } = useI18n('components');
  const canvasStoreApi = mode === 'git' ? useGitCanvasStore
    : mode === 'bottom-terminal' ? useBottomTerminalCanvasStore : useAgentCanvasStore;

  const {
    addTab,
    promoteTab,
    togglePinTab,
    findTabByMetadata,
    switchToTab,
    updateTabContent,
    closeTab,
    activeGroupId,
    layout,
    setSplitMode,
  } = useCanvasStore();

  const isBtwTab = useCallback((tab: { content: PanelContent }) => {
    if (tab.content.type !== 'btw-session') return false;
    const session = flowChatStore.getState().sessions.get(tab.content.data?.childSessionId);
    return session ? session.sessionKind === 'btw' : tab.content.metadata?.discardSessionOnClose === true;
  }, []);

  const confirmBtwClose = useCallback(async (tabs: { title: string; content: PanelContent }[]) => {
    const btwTabs = tabs.filter(isBtwTab);
    if (btwTabs.length === 0) return 'confirm';
    return confirmDialogChoice({
      title: t('tabs.closeBtwTitle'),
      message: t('tabs.confirmCloseBtw'),
      type: 'warning',
      confirmDanger: true,
      confirmText: t('tabs.close'),
      cancelText: t('dialog.confirm.cancel'),
      secondaryActionPlacement: 'start',
      secondaryText: btwTabs.some(tab => canSaveBtwSessionAsFork(tab.content.data.childSessionId))
        ? t('tabs.saveBtwAsFork') : undefined,
    });
  }, [isBtwTab, t]);

  const closeTerminalSession = useCallback(async (tab: { content: PanelContent }): Promise<boolean> => {
    if (tab.content.type !== 'terminal') return true;
    // Workspace terminals outlive their views. Older/specialized tabs retain
    // their explicit process-lifecycle contract.
    if (tab.content.metadata?.terminalCloseBehavior === 'detach') return true;

    const sessionId = tab.content.data?.sessionId;
    if (!sessionId) return true;

    try {
      await destroyTerminalSession(sessionId);
      return true;
    } catch (error) {
      log.error('Failed to close terminal session from tab', { sessionId, error });
      return false;
    }
  }, []);

  /**
   * Open in preview mode (replaces current preview tab).
   */
  const openPreview = useCallback((content: PanelContent, groupId?: EditorGroupId) => {
    const targetGroupId = groupId || activeGroupId;
    
    // Check for existing tab with same content
    if (content.metadata?.duplicateCheckKey) {
      const existing = findTabByMetadata({ duplicateCheckKey: content.metadata.duplicateCheckKey });
      if (existing) {
        // Switch to existing tab
        switchToTab(existing.tab.id, existing.groupId);
        onReveal?.();
        return;
      }
    }
    
    // Add preview tab (auto-replaces current preview tab)
    addTab(content, 'preview', targetGroupId);
    onReveal?.();
  }, [activeGroupId, findTabByMetadata, switchToTab, addTab, onReveal]);

  /**
   * Open directly in active state.
   */
  const openActive = useCallback((content: PanelContent, groupId?: EditorGroupId) => {
    const targetGroupId = groupId || activeGroupId;
    
    // Check for existing tab with same content
    if (content.metadata?.duplicateCheckKey) {
      const existing = findTabByMetadata({ duplicateCheckKey: content.metadata.duplicateCheckKey });
      if (existing) {
        // Switch to existing tab and ensure active state
        switchToTab(existing.tab.id, existing.groupId);
        if (existing.tab.state === 'preview') {
          promoteTab(existing.tab.id, existing.groupId);
        }
        onReveal?.();
        return;
      }
    }
    
    // Add active tab
    addTab(content, 'active', targetGroupId);
    onReveal?.();
  }, [activeGroupId, findTabByMetadata, switchToTab, promoteTab, addTab, onReveal]);

  /**
   * Promote to active on edit.
   */
  const onContentEdit = useCallback((tabId: string, groupId: EditorGroupId) => {
    promoteTab(tabId, groupId);
  }, [promoteTab]);

  /**
   * Toggle pin/unpin.
   */
  const togglePin = useCallback((tabId: string, groupId: EditorGroupId) => {
    togglePinTab(tabId, groupId);
  }, [togglePinTab]);

  /**
   * Dirty check before closing a tab.
   */
  const handleCloseWithDirtyCheck = useCallback(async (tabId: string, groupId: EditorGroupId): Promise<boolean> => {
    const surface = getActiveSurfaceScope();
    const scopeKey = canvasStoreApi.getState().scopeKey;
    const {
      primaryGroup: latestPrimaryGroup,
      secondaryGroup: latestSecondaryGroup,
      tertiaryGroup: latestTertiaryGroup,
    } = canvasStoreApi.getState();
    const group = groupId === 'primary'
      ? latestPrimaryGroup
      : groupId === 'secondary'
        ? latestSecondaryGroup
        : latestTertiaryGroup;
    const tab = group.tabs.find(t => t.id === tabId);

    if (!tab) {
      return true;
    }

    const btwChoice = await confirmBtwClose([tab]);
    if (btwChoice === 'cancel') return false;
    if (!surface.isCurrent() || canvasStoreApi.getState().scopeKey !== scopeKey) return false;

    if (tab.isDirty) {
      const result = await confirmDialog({
        title: t('tabs.unsaved'),
        message: t('tabs.confirmCloseWithDirty', { title: tab.title }),
        type: 'warning',
        confirmDanger: true,
      });

      if (!result) {
        return false;
      }
    }

    if (!surface.isCurrent() || canvasStoreApi.getState().scopeKey !== scopeKey) return false;
    if (isBtwTab(tab)) {
      try {
        const closeBtw = btwChoice === 'secondary' ? saveBtwSessionAsFork : discardBtwSession;
        await closeBtw(tab.content.data.childSessionId);
      } catch (error) {
        if (!isSurfaceChangedError(error)) {
          log.error('Failed to close BTW session from tab', { tabId, btwChoice, error });
          notificationService.error(t(btwChoice === 'secondary' ? 'tabs.saveBtwFailed' : 'tabs.closeBtwFailed'));
        }
        return false;
      }
    }

    if (!await closeTerminalSession(tab)) {
      return false;
    }

    if (!surface.isCurrent() || canvasStoreApi.getState().scopeKey !== scopeKey) return false;
    // Another close can merge editor groups while host cleanup is in flight.
    const state = canvasStoreApi.getState();
    const owner = (['primary', 'secondary', 'tertiary'] as const).find(id =>
      state[`${id}Group`].tabs.some(candidate => candidate.id === tabId));
    if (owner) closeTab(tabId, owner, { forceRemove: tab.content.type === 'terminal' });
    return true;
  }, [canvasStoreApi, closeTab, closeTerminalSession, confirmBtwClose, isBtwTab, t]);

  /**
   * Dirty check before closing all tabs.
   */
  const handleCloseAllWithDirtyCheck = useCallback(async (groupId: EditorGroupId): Promise<boolean> => {
    const surface = getActiveSurfaceScope();
    const scopeKey = canvasStoreApi.getState().scopeKey;
    const {
      primaryGroup: latestPrimaryGroup,
      secondaryGroup: latestSecondaryGroup,
      tertiaryGroup: latestTertiaryGroup,
    } = canvasStoreApi.getState();
    const group = groupId === 'primary'
      ? latestPrimaryGroup
      : groupId === 'secondary'
        ? latestSecondaryGroup
        : latestTertiaryGroup;
    const closableTabs = group.tabs.filter(t => t.state !== 'pinned');
    const dirtyTabs = closableTabs.filter(t => t.isDirty);

    if (dirtyTabs.length > 0) {
      const fileList = dirtyTabs.map(t => `  - ${t.title}`).join('\n');
      const result = await confirmDialog({
        title: t('tabs.unsaved'),
        message: t('tabs.confirmCloseAllWithDirty', { count: dirtyTabs.length, fileList }),
        type: 'warning',
        confirmDanger: true,
        preview: fileList,
      });
      if (!result) return false;
    }

    const btwChoice = await confirmBtwClose(closableTabs);
    if (btwChoice === 'cancel') return false;
    for (const tab of closableTabs) {
      if (!surface.isCurrent() || canvasStoreApi.getState().scopeKey !== scopeKey) return false;
      const state = canvasStoreApi.getState();
      const owner = (['primary', 'secondary', 'tertiary'] as const).find(id =>
        state[`${id}Group`].tabs.some(candidate => candidate.id === tab.id));
      if (!owner) continue;
      if (isBtwTab(tab)) {
        try {
          const sessionId = tab.content.data.childSessionId;
          const closeBtw = btwChoice === 'secondary' && canSaveBtwSessionAsFork(sessionId)
            ? saveBtwSessionAsFork : discardBtwSession;
          await closeBtw(sessionId);
        } catch (error) {
          if (!isSurfaceChangedError(error)) {
            log.error('Failed to close BTW session from tab', { tabId: tab.id, btwChoice, error });
            notificationService.error(t(btwChoice === 'secondary' ? 'tabs.saveBtwFailed' : 'tabs.closeBtwFailed'));
          }
          return false;
        }
      }
      if (!await closeTerminalSession(tab)) return false;
      if (!surface.isCurrent() || canvasStoreApi.getState().scopeKey !== scopeKey) return false;
      const latest = canvasStoreApi.getState();
      const latestOwner = (['primary', 'secondary', 'tertiary'] as const).find(id =>
        latest[`${id}Group`].tabs.some(candidate => candidate.id === tab.id));
      if (latestOwner) closeTab(tab.id, latestOwner, { forceRemove: tab.content.type === 'terminal' });
    }
    return true;
  }, [canvasStoreApi, closeTab, closeTerminalSession, confirmBtwClose, isBtwTab, t]);

  /**
   * Remove tabs when their terminal session is destroyed by any surface.
   */
  useEffect(() => {
    const handleTerminalSessionDestroyed = (event: CustomEvent<{ sessionId: string }>) => {
      const { sessionId } = event.detail ?? {};
      if (sessionId) {
        canvasStoreApi.getState().closeTerminalTabBySessionId(sessionId);
      }
    };
    window.addEventListener('terminal-session-destroyed', handleTerminalSessionDestroyed as EventListener);
    return () => {
      window.removeEventListener('terminal-session-destroyed', handleTerminalSessionDestroyed as EventListener);
    };
  }, [canvasStoreApi]);

  /**
   * Keep terminal tab titles synchronized with session renames.
   */
  useEffect(() => {
    const handleTerminalSessionRenamed = (event: CustomEvent<{ sessionId: string; newName: string }>) => {
      const { sessionId, newName } = event.detail ?? {};
      if (sessionId && newName) {
        canvasStoreApi.getState().renameTerminalTabBySessionId(sessionId, newName);
      }
    };
    window.addEventListener('terminal-session-renamed', handleTerminalSessionRenamed as EventListener);
    return () => {
      window.removeEventListener('terminal-session-renamed', handleTerminalSessionRenamed as EventListener);
    };
  }, [canvasStoreApi]);

  /**
   * Listen for external tab creation events.
   */
  useEffect(() => {
    const eventName = createTabEventName ?? (mode === 'git' ? TAB_EVENTS.GIT_CREATE_TAB
      : mode === 'bottom-terminal' ? TAB_EVENTS.BOTTOM_TERMINAL_CREATE_TAB : TAB_EVENTS.AGENT_CREATE_TAB);

    const handleCreateTab = (event: CustomEvent<CreateTabEventDetail>) => {
      const {
        type,
        title,
        data,
        metadata,
        checkDuplicate,
        duplicateCheckKey,
        replaceExisting,
        targetGroup,
        enableSplitView,
      } = event.detail;

      const content: PanelContent = {
        type,
        title,
        data,
        metadata: { ...metadata, duplicateCheckKey: duplicateCheckKey ?? metadata?.duplicateCheckKey },
      };

      if (mode !== 'bottom-terminal') {
        const openOptions = { resourceKey: duplicateCheckKey, replaceExisting, targetGroup, splitView: enableSplitView };
        if (mode === 'git') openCanvasContent('git', content, openOptions);
        else openContentInBestTarget(content, openOptions);
        return;
      }

      // If split view is enabled, switch to vertical split first (top/bottom)
      if (enableSplitView && layout.splitMode === 'none') {
        setSplitMode('vertical');
      }
      
      // Check duplicates
      if (checkDuplicate && duplicateCheckKey) {
        const existing = findTabByMetadata({ duplicateCheckKey });
        if (existing) {
          const hasJumpInfo = data?.jumpToRange || data?.jumpToLine || data?.jumpToColumn;

          if (replaceExisting || hasJumpInfo) {
            // Update content
            updateTabContent(existing.tab.id, existing.groupId, content);
          }
          
          // Switch to existing tab
          switchToTab(existing.tab.id, existing.groupId);
          
          onReveal?.();
          return;
        }
      }
      
      // Determine target group: use specified group when split enabled, otherwise active group
      const groupId = (enableSplitView && targetGroup) ? targetGroup : (targetGroup || activeGroupId);

      // Open all tabs in active state by default (no preview replacement)
      addTab(content, 'active', groupId);
      
      onReveal?.();
    };

    window.addEventListener(eventName, handleCreateTab as EventListener);

    // Drain any tab events that were enqueued before this listener was
    // registered (happens when the scene was just mounted for the first time).
    if (mode !== 'bottom-terminal') {
      const pendingMode = mode === 'git' ? 'git' : 'agent';
      const pending = drainPendingTabs(pendingMode);
      pending.forEach(detail => handleCreateTab({ detail } as CustomEvent<CreateTabEventDetail>));
    }
    
    return () => {
      window.removeEventListener(eventName, handleCreateTab as EventListener);
    };
  }, [mode, createTabEventName, onReveal, findTabByMetadata, updateTabContent, switchToTab, addTab, activeGroupId, layout.splitMode, setSplitMode]);

  return {
    openPreview,
    openActive,
    onContentEdit,
    togglePin,
    handleCloseWithDirtyCheck,
    handleCloseAllWithDirtyCheck,
  };
};

export default useTabLifecycle;
