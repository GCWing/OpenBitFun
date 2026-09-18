import { useState, useCallback, useRef, useEffect } from 'react';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import { snapshotAPI } from '@/infrastructure/api/service-api/SnapshotAPI';
import { stateMachineManager } from '../state-machine';
import { 
  FlowChatState, 
  FlowChatActions, 
  Session, 
  SessionConfig, 
  DialogTurn, 
  ModelRound,
  AnyFlowItem,
  FlowItem,
  FlowTextItem
} from '../types/flow-chat';
import { flowChatStore } from '../store/FlowChatStore';
import { isProjectedSessionEmpty } from '../utils/flowChatTurnIdentity';
import { flowChatManager } from '../services/FlowChatManager';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { generateTempTitle } from '../utils/titleUtils';
import { createLogger } from '@/shared/utils/logger';
import { flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';

const log = createLogger('useFlowChat');

export const useFlowChat = () => {
  const { workspacePath, workspace } = useCurrentWorkspace();
  const [state, setState] = useState<FlowChatState>(flowChatStore.getState());
  const processingLock = useRef<boolean>(false);

  useEffect(() => {
    const unsubscribe = flowChatStore.subscribe((newState) => {
      setState(newState);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    unlisten = agentAPI.onSessionTitleGenerated((event) => {
      flowChatStore.updateSessionTitle(
        event.sessionId,
        event.title,
        'generated'
      );
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // Create a session using Agentic API v2.
  const createSession = useCallback(async (config?: Partial<SessionConfig>): Promise<string> => {
    if (!workspacePath) throw new Error('Workspace path is required to create a session');
    return flowChatManager.createChatSession({
      ...config,
      ...(workspace ? flowChatSessionConfigForWorkspace(workspace) : { workspacePath }),
      workspaceId: workspace?.id ?? config?.workspaceId,
    }, config?.agentType);
  }, [workspacePath, workspace]);

  const switchSession = useCallback(async (sessionId: string) => {
    try {
      await flowChatManager.switchChatSession(sessionId);
    } catch (error) {
      log.error('Failed to switch session', { sessionId, error });
    }
  }, []);

  const getActiveSession = useCallback((): Session | null => {
    const currentState = flowChatStore.getState();
    const session = flowChatStore.getActiveSession();
    if (!session) {
      log.warn('No active session', { activeSessionId: currentState.activeSessionId });
    }
    return session;
  }, []);

  const getLatestDialogTurn = useCallback((sessionId?: string): DialogTurn | null => {
    const currentState = flowChatStore.getState();
    const targetSessionId = sessionId || currentState.activeSessionId;
    if (!targetSessionId) return null;
    
    const session = currentState.sessions.get(targetSessionId);
    if (!session || session.dialogTurns.length === 0) return null;
    
    return session.dialogTurns[session.dialogTurns.length - 1];
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await flowChatStore.deleteSession(sessionId);
    } catch (error) {
      log.error('Failed to delete session', { sessionId, error });
    }
  }, []);

  const startDialogTurn = useCallback((content: string, sessionId?: string, predefinedDialogTurnId?: string): string => {
    const targetSessionId = sessionId || state.activeSessionId;
    if (!targetSessionId) return '';

    const dialogTurnId = predefinedDialogTurnId || `turn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const session = flowChatStore.getState().sessions.get(targetSessionId);
    if (session?.dialogTurns.some(turn => turn.id === dialogTurnId)) {
      return dialogTurnId;
    }
    
    const dialogTurn: DialogTurn = {
      id: dialogTurnId,
      sessionId: targetSessionId,
      userMessage: {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        content: content,
        timestamp: Date.now()
      },
      modelRounds: [],
      status: 'pending',
      startTime: Date.now()
    };

    const isFirstMessage =
      session && isProjectedSessionEmpty(session) && session.titleStatus !== 'generated';
    
    flowChatStore.addDialogTurn(targetSessionId, dialogTurn);

    if (isFirstMessage) {
      const tempTitle = generateTempTitle(content, 20);
      flowChatStore.updateSessionTitle(targetSessionId, tempTitle, 'generating');
    }

    return dialogTurnId;
  }, [state.activeSessionId]);

  const completeDialogTurn = useCallback((dialogTurnId: string, sessionId?: string) => {
    const targetSessionId = sessionId || state.activeSessionId;
    if (!targetSessionId) return;

    flowChatStore.updateDialogTurn(targetSessionId, dialogTurnId, (turn) => ({
      ...turn,
      status: 'completed' as const,
      endTime: Date.now()
    }));
  }, [state.activeSessionId]);

  const startModelRound = useCallback((dialogTurnId: string, modelRoundId: string, roundIndex: number) => {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    const session = flowChatStore.getState().sessions.get(activeSessionId);
    if (!session) return;
    
    const dialogTurn = session.dialogTurns.find(turn => turn.id === dialogTurnId);
    if (!dialogTurn) {
      log.warn('Dialog turn not found', { dialogTurnId, sessionId: activeSessionId });
      return;
    }

    if (dialogTurn.modelRounds.some(round => round.id === modelRoundId)) {
      return;
    }

    const newModelRound: ModelRound = {
      id: modelRoundId,
      index: roundIndex,
      items: [],
      isStreaming: true,
      isComplete: false,
      status: 'streaming',
      startTime: Date.now()
    };

    flowChatStore.updateDialogTurn(activeSessionId, dialogTurnId, (turn) => {
      // Complete the previous streaming round if needed.
      const updatedModelRounds = turn.modelRounds.map((round, index) => {
        if (index === turn.modelRounds.length - 1 && round.isStreaming) {
          return {
            ...round,
            isStreaming: false,
            isComplete: true,
            status: 'completed' as const,
            endTime: Date.now()
          };
        }
        return round;
      });
      
      return {
        ...turn,
        modelRounds: [...updatedModelRounds, newModelRound],
        status: 'processing' as const
      };
    });
  }, [state.activeSessionId]);

  const endModelRound = useCallback((dialogTurnId: string, modelRoundId: string, status: string) => {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    flowChatStore.updateModelRound(activeSessionId, dialogTurnId, modelRoundId, (round) => ({
      ...round,
      isStreaming: false,
      isComplete: true,
      status: status as any,
      endTime: Date.now(),
      items: round.items.map((item: any) => 
        item.type === 'text' ? { ...item as FlowTextItem, isStreaming: false } : item
      )
    }));
  }, [state.activeSessionId]);

  const addModelRoundItem = useCallback((dialogTurnId: string, item: AnyFlowItem, modelRoundId?: string) => {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    flowChatStore.addModelRoundItem(activeSessionId, dialogTurnId, item, modelRoundId);
  }, [state.activeSessionId]);

  const updateModelRoundItem = useCallback((dialogTurnId: string, itemId: string, updates: Partial<FlowItem>) => {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    flowChatStore.updateModelRoundItem(activeSessionId, dialogTurnId, itemId, updates);
  }, [state.activeSessionId]);

  const restoreDialogTurn = useCallback((_dialogTurnId: string, _sessionId?: string) => {
    log.warn('restoreDialogTurn is temporarily disabled');
    return false;
  }, []);

  const updateAnyRoundItem = useCallback((dialogTurnId: string, itemId: string, updates: Partial<FlowItem>) => {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    flowChatStore.updateModelRoundItem(activeSessionId, dialogTurnId, itemId, updates);
  }, [state.activeSessionId]);

  const setError = useCallback((error: string | null, sessionId?: string) => {
    const targetSessionId = sessionId || state.activeSessionId;
    if (!targetSessionId) return;

    flowChatStore.setError(targetSessionId, error);
  }, [state.activeSessionId]);

  const setTaskId = useCallback((taskId: string | null) => {
    const sessionId = flowChatStore.getState().activeSessionId;
    if (sessionId) {
      // taskId is managed by the state machine.
      const machine = stateMachineManager.get(sessionId);
      if (machine) {
        machine.getContext().taskId = taskId;
      }
    }
  }, []);

  const sendMessage = useCallback(async (_message: string, _sessionId?: string): Promise<void> => {
    const targetSessionId = _sessionId || state.activeSessionId;
    if (!targetSessionId) return;

    const machine = stateMachineManager.get(targetSessionId);
    const isProcessing = machine ? !['idle', 'completed', 'error'].includes(machine.getCurrentState()) : false;
    
    if (processingLock.current || isProcessing) {
      return;
    }

    processingLock.current = true;
  }, [state.activeSessionId]);

  const endMessageProcessing = useCallback(() => {
    processingLock.current = false;
  }, []);

  const confirmTool = useCallback((_toolId: string) => {
  }, []);

  const rejectTool = useCallback((_toolId: string) => {
  }, []);

  const clearSession = useCallback((sessionId?: string) => {
    const targetSessionId = sessionId || state.activeSessionId;
    if (!targetSessionId) return;

    flowChatStore.clearSession(targetSessionId);
  }, [state.activeSessionId]);

  const retryLastMessage = useCallback(() => {
    const currentSession = getActiveSession();
    if (!currentSession || currentSession.dialogTurns.length === 0) return;

    const lastDialogTurn = currentSession.dialogTurns[currentSession.dialogTurns.length - 1];
    sendMessage(lastDialogTurn.userMessage.content);
  }, [getActiveSession, sendMessage]);

  const recordTurnSnapshot = useCallback(async (
    sessionId: string,
    turnIndex: number,
    modifiedFiles: string[]
  ) => {
    try {
      const workspaceId = state.sessions.get(sessionId)?.workspaceId;
      await snapshotAPI.recordTurnSnapshot(sessionId, turnIndex, modifiedFiles, workspaceId);
      log.debug('Turn snapshot recorded', { sessionId, turnIndex, fileCount: modifiedFiles.length });
    } catch (error) {
      log.error('Failed to record turn snapshot', { sessionId, turnIndex, error });
    }
  }, [state.sessions]);

  const actions: FlowChatActions = {
    sendMessage,
    createSession,
    switchSession,
    confirmTool,
    rejectTool,
    clearSession,
    deleteSession,
    retryLastMessage
  };

  return {
    state,
    actions,
    // Internal helpers for components.
    startDialogTurn,
    completeDialogTurn,
    addModelRoundItem,
    updateModelRoundItem,
    updateAnyRoundItem,
    restoreDialogTurn,
    startModelRound,
    endModelRound,
    setError,
    setTaskId,
    recordTurnSnapshot,
    getActiveSession,
    getLatestDialogTurn,
    endMessageProcessing
  };
};

export default useFlowChat;
