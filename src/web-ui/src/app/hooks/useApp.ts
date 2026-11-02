/**
 * Application hook.
 * Provides unified app state management and actions.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  UseAppReturn,
  AppState,
  AgentConfig,
  ChatSession,
  TabInfo,
  PanelType
} from '../types';
import { appManager } from '../services/AppManager';
import { sessionPaneLayoutStore } from '../scenes/session/sessionPaneLayoutStore';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('useApp');

export const useApp = (): UseAppReturn => {
  const [state, setState] = useState<AppState>(appManager.getState());

  // Listen for app state changes
  useEffect(() => {
    const unsubscribe = appManager.addEventListener(() => {
      // Update state on each event
      setState(appManager.getState());
    });

    // Sync state on initialization
    setState(appManager.getState());

    return unsubscribe;
  }, []);

  // Layout actions
  const toggleLeftPanel = useCallback(() => {
    appManager.updateLayout({
      leftPanelCollapsed: !state.layout.leftPanelCollapsed
    });
  }, [state.layout.leftPanelCollapsed]);

  const toggleRightPanel = useCallback(() => {
    sessionPaneLayoutStore.getState().toggleContent();
  }, []);

  const toggleBottomTerminalPanel = useCallback(() => {
    appManager.updateLayout({
      bottomTerminalPanelCollapsed: !state.layout.bottomTerminalPanelCollapsed
    });
  }, [state.layout.bottomTerminalPanelCollapsed]);

  const toggleChatPanel = useCallback(() => {
    sessionPaneLayoutStore.getState().toggleMaximized();
  }, []);

  const switchLeftPanelTab = useCallback((tab: PanelType) => {
    appManager.updateLayout({
      leftPanelActiveTab: tab,
      leftPanelCollapsed: false // Auto-expand panel when switching tabs
    });
  }, []);

  const updateLeftPanelWidth = useCallback((width: number) => {
    // Clamp width: minimum 50px, no upper bound
    const MIN_WIDTH = 50;
    const clampedWidth = Math.max(MIN_WIDTH, width);
    
    appManager.updateLayout({
      leftPanelWidth: clampedWidth
    });
  }, []);

  const updateCenterPanelWidth = useCallback((width: number) => {
    // Clamp width: minimum 400px
    const MIN_WIDTH = 400;
    const clampedWidth = Math.max(MIN_WIDTH, width);
    
    appManager.updateLayout({
      centerPanelWidth: clampedWidth
    });
  }, []);

  const updateRightPanelWidth = useCallback((width: number) => {
    sessionPaneLayoutStore.getState().resizeRightPane(width);
  }, []);

  const updateBottomTerminalPanelHeight = useCallback((height: number) => {
    const MIN_HEIGHT = 120;
    const MAX_HEIGHT = 640;
    const clampedHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));

    appManager.updateLayout({
      bottomTerminalPanelHeight: clampedHeight
    });
  }, []);

  const toggleCenterPanel = useCallback(() => {
    sessionPaneLayoutStore.getState().toggleMaximized();
  }, []);

  const updateAgentConfig = useCallback(async (agentId: string, config: Partial<AgentConfig>): Promise<void> => {
    try {
      await appManager.updateAgentConfig(agentId, config);
    } catch (error) {
      log.error('Failed to update agent config', error);
      throw error;
    }
  }, []);

  // Chat actions
  const createChatSession = useCallback(async (agentId: string): Promise<ChatSession> => {
    try {
      return await appManager.createChatSession(agentId);
    } catch (error) {
      log.error('Failed to create chat session', error);
      throw error;
    }
  }, []);

  const selectChatSession = useCallback((sessionId: string) => {
    try {
      appManager.selectChatSession(sessionId);
    } catch (error) {
      log.error('Failed to select chat session', error);
    }
  }, []);

  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (!state.activeChatSession) {
      // Create a new session if there is no active session
      if (state.currentAgent) {
        const session = await createChatSession(state.currentAgent.id);
        await appManager.sendMessage(session.id, content);
      } else {
        throw new Error('No active agent or chat session');
      }
    } else {
      try {
        await appManager.sendMessage(state.activeChatSession.id, content);
      } catch (error) {
        log.error('Failed to send message', error);
        throw error;
      }
    }
  }, [state.activeChatSession, state.currentAgent, createChatSession]);

  // Extension actions
  const enableExtension = useCallback(async (extensionId: string): Promise<void> => {
    try {
      await appManager.enableExtension(extensionId);
    } catch (error) {
      log.error('Failed to enable extension', error);
      throw error;
    }
  }, []);

  const disableExtension = useCallback(async (extensionId: string): Promise<void> => {
    try {
      await appManager.disableExtension(extensionId);
    } catch (error) {
      log.error('Failed to disable extension', error);
      throw error;
    }
  }, []);

  // Tab actions
  const openTab = useCallback((tab: Omit<TabInfo, 'id'>): string => {
    try {
      return appManager.openTab(tab);
    } catch (error) {
      log.error('Failed to open tab', error);
      throw error;
    }
  }, []);

  const closeTab = useCallback((tabId: string) => {
    try {
      appManager.closeTab(tabId);
    } catch (error) {
      log.error('Failed to close tab', error);
    }
  }, []);

  const selectTab = useCallback((tabId: string) => {
    try {
      appManager.selectTab(tabId);
    } catch (error) {
      log.error('Failed to select tab', error);
    }
  }, []);

  // Utility actions
  const clearError = useCallback(() => {
    appManager.clearError();
  }, []);

  return {
    // State
    state,

    // Layout actions
    toggleLeftPanel,
    toggleCenterPanel,
    toggleRightPanel,
    toggleBottomTerminalPanel,
    toggleChatPanel,
    switchLeftPanelTab,
    updateLeftPanelWidth,
    updateCenterPanelWidth,
    updateRightPanelWidth,
    updateBottomTerminalPanelHeight,

    updateAgentConfig,

    // Chat actions
    createChatSession,
    selectChatSession,
    sendMessage,

    // Extension actions
    enableExtension,
    disableExtension,

    // Tab actions
    openTab,
    closeTab,
    selectTab,

    // Utility actions
    clearError
  };
};

// Layout helper hook
export const useLayout = () => {
  const { state, toggleLeftPanel, toggleRightPanel, toggleBottomTerminalPanel, toggleChatPanel, switchLeftPanelTab, updateLeftPanelWidth } = useApp();
  
  return {
    layout: state.layout,
    toggleLeftPanel,
    toggleRightPanel,
    toggleBottomTerminalPanel,
    toggleChatPanel,
    switchLeftPanelTab,
    updateLeftPanelWidth
  };
};

// Chat helper hook
export const useChat = () => {
  const { state, createChatSession, selectChatSession, sendMessage } = useApp();
  
  return {
    sessions: state.chatSessions,
    activeSession: state.activeChatSession,
    currentAgent: state.currentAgent,
    createSession: createChatSession,
    selectSession: selectChatSession,
    sendMessage
  };
};

// Tab helper hook
export const useTabs = () => {
  const { state, openTab, closeTab, selectTab } = useApp();
  
  return {
    tabs: state.layout.rightPanelTabs,
    activeTabId: state.layout.rightPanelActiveTabId,
    openTab,
    closeTab,
    selectTab
  };
};
