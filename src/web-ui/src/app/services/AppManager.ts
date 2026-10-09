/**
 * Application manager.
 * Manages global layout and app state across modes.
 */

import {
  IAppManager,
  AppState,
  AppEvent,
  LayoutState,
  AgentConfig,
  ChatSession,
  ChatMessage,
  TabInfo,
  DEFAULT_LAYOUT_STATE,
  DEFAULT_AGENTS
} from '../types';
import { globalEventBus } from '../../infrastructure/event-bus';
import { createLogger } from '@/shared/utils/logger';
import { i18nService } from '@/infrastructure/i18n';
import { loadPanelWidth, savePanelWidth, STORAGE_KEYS } from '../layout/panelConfig';
import {
  createSessionPaneLayoutStore,
  projectLegacySessionPaneLayout,
  sessionPaneLayoutStore,
  type LegacySessionPaneLayout,
  type SessionPaneLayoutStore,
} from '../scenes/session/sessionPaneLayoutStore';

const log = createLogger('AppManager');
type ShellLayout = Omit<LayoutState, keyof LegacySessionPaneLayout>;
type ShellState = Omit<AppState, 'layout'> & { layout: ShellLayout };

export class AppManager implements IAppManager {
  private state: ShellState;
  private readonly paneLayout: SessionPaneLayoutStore;
  private readonly unsubscribePaneLayout: () => void;
  private updatingLayout = false;
  private listeners = new Set<(event: AppEvent) => void>();
  /** Coalesce rapid layout/state updates into one event per animation frame (reduces main-thread churn). */
  private pendingStateNotifyRaf: number | null = null;

  constructor(paneLayout = createSessionPaneLayoutStore()) {
    this.paneLayout = paneLayout;
    // Clear legacy panel state data (run once)
    this.clearPersistedPanelState();
    
    // Initialize state
    const { chatCollapsed: _chat, centerPanelCollapsed: _center, rightPanelCollapsed: _content,
      rightPanelWidth: _width, ...shellDefaults } = DEFAULT_LAYOUT_STATE;
    this.state = {
      layout: { 
        ...shellDefaults,
        leftPanelWidth: typeof window !== 'undefined' && window.innerWidth > 0 
          ? Math.min(300, Math.floor(window.innerWidth * 0.15)) // Left 15%, max 300px
          : 280,
        bottomTerminalPanelHeight: loadPanelWidth(
          STORAGE_KEYS.BOTTOM_TERMINAL_PANEL_LAST_HEIGHT,
          DEFAULT_LAYOUT_STATE.bottomTerminalPanelHeight
        ),
      },
      currentAgent: DEFAULT_AGENTS[0],
      availableAgents: [...DEFAULT_AGENTS],
      chatSessions: [],
      activeChatSession: null,
      extensions: [],
      isLoading: false,
      error: null
    };
    this.unsubscribePaneLayout = this.paneLayout.subscribe(() => {
      if (this.updatingLayout) return;
      this.notifyStateChange();
      this.emitEvent({ type: 'layout:changed', payload: projectLegacySessionPaneLayout(this.paneLayout.getState()) });
    });

    // Set up event listeners
    this.setupEventListeners();
  }

  // State management
  getState(): AppState {
    return {
      ...this.state,
      layout: { ...this.state.layout, ...projectLegacySessionPaneLayout(this.paneLayout.getState()) },
    };
  }

  private updateState(updates: Partial<ShellState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyStateChange();
  }

  updateLayout(layout: Partial<LayoutState>): void {
    const previous = this.getState().layout;
    const { chatCollapsed, centerPanelCollapsed, rightPanelCollapsed, rightPanelWidth, ...shellLayout } = layout;
    this.updatingLayout = true;
    try {
      this.paneLayout.getState().applyLegacyLayout({ chatCollapsed, centerPanelCollapsed, rightPanelCollapsed, rightPanelWidth });
      this.state = { ...this.state, layout: { ...this.state.layout, ...shellLayout } };
    } finally {
      this.updatingLayout = false;
    }
    const next = this.getState().layout;
    if (!Object.keys(next).some(key => previous[key as keyof LayoutState] !== next[key as keyof LayoutState])) return;
    if (typeof layout.bottomTerminalPanelHeight === 'number') {
      savePanelWidth(STORAGE_KEYS.BOTTOM_TERMINAL_PANEL_LAST_HEIGHT, layout.bottomTerminalPanelHeight);
    }

    this.notifyStateChange();
    const paneProjection = projectLegacySessionPaneLayout(this.paneLayout.getState());
    const paneChanged = Object.keys(paneProjection).some(key => (
      previous[key as keyof LegacySessionPaneLayout] !== next[key as keyof LegacySessionPaneLayout]
    ));
    this.emitEvent({
      type: 'layout:changed',
      payload: paneChanged ? { ...layout, ...paneProjection } : layout
    });
  }

  async updateAgentConfig(agentId: string, config: Partial<AgentConfig>): Promise<void> {
    const agentIndex = this.state.availableAgents.findIndex(a => a.id === agentId);
    if (agentIndex === -1) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const updatedAgents = [...this.state.availableAgents];
    const currentAgent = updatedAgents[agentIndex];
    updatedAgents[agentIndex] = {
      ...currentAgent,
      config: { 
        ...currentAgent.config,
        ...config
      } as AgentConfig
    };

    this.updateState({ availableAgents: updatedAgents });

    // Also update currentAgent when it matches
    if (this.state.currentAgent?.id === agentId) {
      this.updateState({ currentAgent: updatedAgents[agentIndex] });
    }

    this.emitEvent({
      type: 'agent:changed',
      payload: updatedAgents[agentIndex]
    });
  }

  // Chat management
  async createChatSession(agentId: string): Promise<ChatSession> {
    const agent = this.state.availableAgents.find(a => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const session: ChatSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: i18nService.t('flow-chat:session.chatWithAgent', { name: agent.name }),
      messages: [],
      agentId,
      createdAt: new Date(),
      updatedAt: new Date(),
      isActive: true
    };

    // Add system message
    if (agent.config?.systemPrompt) {
      session.messages.push({
        id: `msg_${Date.now()}`,
        role: 'system',
        content: agent.config.systemPrompt,
        timestamp: new Date(),
        agentId
      });
    }

    const updatedSessions = [...this.state.chatSessions, session];
    this.updateState({ 
      chatSessions: updatedSessions,
      activeChatSession: session
    });

    this.emitEvent({
      type: 'chat:session:created',
      payload: session
    });

    return session;
  }

  selectChatSession(sessionId: string): void {
    const session = this.state.chatSessions.find(s => s.id === sessionId);
    if (!session) {
      throw new Error(`Chat session not found: ${sessionId}`);
    }

    this.updateState({ activeChatSession: session });

    this.emitEvent({
      type: 'chat:session:selected',
      payload: session
    });
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.state.chatSessions.find(s => s.id === sessionId);
    if (!session) {
      throw new Error(`Chat session not found: ${sessionId}`);
    }

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content,
      timestamp: new Date(),
      agentId: session.agentId
    };

    // Add user message
    const updatedMessages = [...session.messages, userMessage];
    const updatedSession = { 
      ...session, 
      messages: updatedMessages,
      updatedAt: new Date()
    };

    const updatedSessions = this.state.chatSessions.map(s => 
      s.id === sessionId ? updatedSession : s
    );

    this.updateState({ 
      chatSessions: updatedSessions,
      activeChatSession: updatedSession
    });

    this.emitEvent({
      type: 'chat:message:sent',
      payload: { sessionId, message: userMessage }
    });

  }

  // Extension management
  async enableExtension(extensionId: string): Promise<void> {
    const extensionIndex = this.state.extensions.findIndex(e => e.id === extensionId);
    if (extensionIndex === -1) {
      throw new Error(`Extension not found: ${extensionId}`);
    }

    const updatedExtensions = [...this.state.extensions];
    updatedExtensions[extensionIndex] = {
      ...updatedExtensions[extensionIndex],
      isEnabled: true
    };

    this.updateState({ extensions: updatedExtensions });

    this.emitEvent({
      type: 'extension:enabled',
      payload: updatedExtensions[extensionIndex]
    });
  }

  async disableExtension(extensionId: string): Promise<void> {
    const extensionIndex = this.state.extensions.findIndex(e => e.id === extensionId);
    if (extensionIndex === -1) {
      throw new Error(`Extension not found: ${extensionId}`);
    }

    const updatedExtensions = [...this.state.extensions];
    updatedExtensions[extensionIndex] = {
      ...updatedExtensions[extensionIndex],
      isEnabled: false
    };

    this.updateState({ extensions: updatedExtensions });

    this.emitEvent({
      type: 'extension:disabled',
      payload: updatedExtensions[extensionIndex]
    });
  }

  async configureExtension(extensionId: string, config: Record<string, any>): Promise<void> {
    const extensionIndex = this.state.extensions.findIndex(e => e.id === extensionId);
    if (extensionIndex === -1) {
      throw new Error(`Extension not found: ${extensionId}`);
    }

    const updatedExtensions = [...this.state.extensions];
    updatedExtensions[extensionIndex] = {
      ...updatedExtensions[extensionIndex],
      config: { ...updatedExtensions[extensionIndex].config, ...config }
    };

    this.updateState({ extensions: updatedExtensions });
  }

  // Tab management
  openTab(tab: Omit<TabInfo, 'id'>): string {
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newTab: TabInfo = { ...tab, id: tabId };

    const updatedTabs = [...this.state.layout.rightPanelTabs, newTab];
    this.updateLayout({
      rightPanelTabs: updatedTabs,
      rightPanelActiveTabId: tabId,
      rightPanelCollapsed: false // Auto-expand right panel
    });

    this.emitEvent({
      type: 'tab:opened',
      payload: newTab
    });

    return tabId;
  }

  closeTab(tabId: string): void {
    const updatedTabs = this.state.layout.rightPanelTabs.filter(t => t.id !== tabId);
    
    let newActiveTabId = this.state.layout.rightPanelActiveTabId;
    if (newActiveTabId === tabId) {
      newActiveTabId = updatedTabs.length > 0 ? updatedTabs[updatedTabs.length - 1].id : null;
    }

    this.updateLayout({
      rightPanelTabs: updatedTabs,
      rightPanelActiveTabId: newActiveTabId,
      rightPanelCollapsed: updatedTabs.length === 0 // Collapse when no tabs remain
    });

    this.emitEvent({
      type: 'tab:closed',
      payload: { tabId }
    });
  }

  selectTab(tabId: string): void {
    const tab = this.state.layout.rightPanelTabs.find(t => t.id === tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }

    this.updateLayout({
      rightPanelActiveTabId: tabId,
      rightPanelCollapsed: false
    });

    this.emitEvent({
      type: 'tab:selected',
      payload: { tabId }
    });
  }

  // Error handling
  clearError(): void {
    this.updateState({ error: null });
  }

  // Event listeners
  addEventListener(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Private methods
  private emitEvent(event: AppEvent): void {
    this.listeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        log.error('Error in event listener', error);
      }
    });

    // Emit to global event bus
    globalEventBus.emit(`app:${event.type}`, event.payload);
  }

  private notifyStateChange(): void {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      globalEventBus.emit('app:state:changed', this.getState());
      return;
    }
    if (this.pendingStateNotifyRaf != null) {
      return;
    }
    this.pendingStateNotifyRaf = window.requestAnimationFrame(() => {
      this.pendingStateNotifyRaf = null;
      globalEventBus.emit('app:state:changed', this.getState());
    });
  }

  // Clear legacy panel state data
  private clearPersistedPanelState(): void {
    try {
      // Clear AppManager persisted state
      localStorage.removeItem('openbitfun-app-state');
      
      // Clear other potential panel state keys
      localStorage.removeItem('OpenBitFun-left-panel-width');
      localStorage.removeItem('OpenBitFun-left-panel-collapsed');
      localStorage.removeItem('OpenBitFun-right-panel-collapsed');
      localStorage.removeItem('right-panel-collapsed');
      localStorage.removeItem(STORAGE_KEYS.RIGHT_PANEL_WIDTH);
    } catch (error) {
      log.warn('Failed to clear persisted panel state', error);
    }
  }
  
  private setupEventListeners(): void {
    // Listen for global events
    globalEventBus.on('workspace:changed', () => {
      // Reset related state on workspace change
      this.updateState({
        chatSessions: [],
        activeChatSession: null
      });
    });

    // Listen for window resize with debounce
    if (typeof window !== 'undefined') {
      let resizeTimer: NodeJS.Timeout;
      
      const handleResize = () => {
        // Debounce: only run the last call within 200ms
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const windowWidth = window.innerWidth;
          // Left 15%, max 300px
          const newLeftPanelWidth = Math.min(300, Math.max(200, Math.floor(windowWidth * 0.15)));
          // Center 50%
          const newCenterPanelWidth = Math.max(400, Math.floor(windowWidth * 0.50));
          
          this.updateLayout({
            leftPanelWidth: newLeftPanelWidth,
            centerPanelWidth: newCenterPanelWidth
          });
        }, 200);
      };

      window.addEventListener('resize', handleResize);
      
      // Cleanup
      globalEventBus.on('app:shutdown', () => {
        clearTimeout(resizeTimer);
        window.removeEventListener('resize', handleResize);
      });
    }
  }


  // Cleanup resources
  destroy(): void {
    this.unsubscribePaneLayout();
    this.listeners.clear();
  }
}

// Default application manager instance
export const appManager = new AppManager(sessionPaneLayoutStore);
