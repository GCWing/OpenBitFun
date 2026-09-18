/**
 * Session state machine implementation
 */

import {
  SessionExecutionState,
  SessionExecutionEvent,
  ProcessingPhase,
  SessionStateMachine,
  SessionStateMachineContext,
  StateTransition,
} from './types';
import { getNextState, PHASE_TRANSITIONS } from './transitions';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('SessionStateMachine');

function createInitialContext(): SessionStateMachineContext {
  return {
    taskId: null,
    currentDialogTurnId: null,
    currentModelRoundId: null,
    pendingToolConfirmations: new Set(),
    errorMessage: null,
    queuedInput: null,
    processingPhase: null,
    planner: null,
    stats: {
      startTime: null,
      textCharsGenerated: 0,
      toolsExecuted: 0,
    },
    
    version: 0,
    lastUpdateTime: Date.now(),
    backendSyncedAt: null,
    errorRecovery: {
      errorCount: 0,
      lastErrorTime: null,
      errorType: null,
      recoverable: true,
    },
  };
}

export class SessionStateMachineImpl {
  private static readonly MAX_HISTORY_LENGTH = 100;

  private sessionId: string;
  private currentState: SessionExecutionState;
  private context: SessionStateMachineContext;
  private transitionHistory: StateTransition[] = [];
  private listeners: Set<(machine: SessionStateMachine) => void> = new Set();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.currentState = SessionExecutionState.IDLE;
    this.context = createInitialContext();
  }

  getSnapshot(): SessionStateMachine {
    const { pendingToolConfirmations, ...rest } = this.context;
    const clonedRest = structuredClone(rest);
    return {
      sessionId: this.sessionId,
      currentState: this.currentState,
      context: {
        ...clonedRest,
        pendingToolConfirmations: new Set(pendingToolConfirmations),
      },
      transitionHistory: this.transitionHistory.slice(-SessionStateMachineImpl.MAX_HISTORY_LENGTH),
    };
  }

  getCurrentState(): SessionExecutionState {
    return this.currentState;
  }

  getContext(): SessionStateMachineContext {
    return this.context;
  }

  /** Adopt host facts without executing controller-side transition effects. */
  acceptRuntimeStatus(status: {
    state: SessionExecutionState;
    turnId: string | null;
    roundId: string | null;
    phase: ProcessingPhase | null;
    pendingTools: string[];
    error: string | null;
  }): void {
    const pendingTools = new Set(status.pendingTools);
    if (this.currentState === status.state
      && this.context.currentDialogTurnId === status.turnId
      && this.context.currentModelRoundId === status.roundId
      && this.context.processingPhase === status.phase
      && this.context.errorMessage === status.error
      && pendingTools.size === this.context.pendingToolConfirmations.size
      && [...pendingTools].every(id => this.context.pendingToolConfirmations.has(id))) return;
    this.currentState = status.state;
    this.context = { ...this.context, taskId: this.sessionId,
      currentDialogTurnId: status.turnId, currentModelRoundId: status.roundId,
      processingPhase: status.phase, pendingToolConfirmations: pendingTools,
      errorMessage: status.error, version: this.context.version + 1,
      lastUpdateTime: Date.now(), backendSyncedAt: Date.now() };
    this.notifyListeners();
  }

  async transition(
    event: SessionExecutionEvent,
    payload?: any
  ): Promise<boolean> {
    const fromState = this.currentState;
    const toState = getNextState(fromState, event);

    if (!toState) {
      log.warn('Invalid transition', { 
        sessionId: this.sessionId, 
        fromState, 
        event 
      });
      
      this.transitionHistory.push({
        from: fromState,
        event,
        to: fromState,
        timestamp: Date.now(),
        payload,
        success: false,
      });
      
      return false;
    }

    const toolRelatedEvents = [
      SessionExecutionEvent.TOOL_DETECTED,
      SessionExecutionEvent.TOOL_STARTED,
      SessionExecutionEvent.TOOL_COMPLETED,
      SessionExecutionEvent.TOOL_CONFIRMATION_NEEDED,
      SessionExecutionEvent.TOOL_CONFIRMED,
      SessionExecutionEvent.TOOL_REJECTED,
      SessionExecutionEvent.USER_CANCEL,
      SessionExecutionEvent.START,
      SessionExecutionEvent.ERROR_OCCURRED,
      SessionExecutionEvent.RESET,
    ];
    
    if (toolRelatedEvents.includes(event)) {
      log.debug('State transition', { 
        sessionId: this.sessionId, 
        fromState, 
        event, 
        toState,
        payload 
      });
    }

    this.currentState = toState;

    this.context.version += 1;
    this.context.lastUpdateTime = Date.now();

    const processingPhaseBefore = this.context.processingPhase;
    this.updateContext(event, payload);
    const processingPhaseAfter = this.context.processingPhase;

    if (this.transitionHistory.length > SessionStateMachineImpl.MAX_HISTORY_LENGTH * 2) {
      this.transitionHistory = this.transitionHistory.slice(-SessionStateMachineImpl.MAX_HISTORY_LENGTH);
    }

    this.transitionHistory.push({
      from: fromState,
      event,
      to: toState,
      timestamp: Date.now(),
      payload,
      success: true,
    });

    await this.runSideEffects(event, payload);

    // TEXT_CHUNK_RECEIVED is high-frequency: skip notify when phase is unchanged (STREAMING→STREAMING).
    // When phase changes (e.g. THINKING→STREAMING on first chunk), subscribers must update (pet, progress).
    if (event !== SessionExecutionEvent.TEXT_CHUNK_RECEIVED) {
      this.notifyListeners();
    } else if (processingPhaseBefore !== processingPhaseAfter) {
      this.notifyListeners();
    }

    return true;
  }

  private updateContext(event: SessionExecutionEvent, payload?: any) {
    if (
      this.currentState === SessionExecutionState.PROCESSING ||
      this.currentState === SessionExecutionState.FINISHING
    ) {
      const newPhase = PHASE_TRANSITIONS[event];
      const shouldUpdatePhase =
        this.currentState === SessionExecutionState.PROCESSING ||
        event === SessionExecutionEvent.BACKEND_STREAM_COMPLETED;
      // Allow null (e.g. TOOL_COMPLETED clears phase so UI leaves "tool calling" before the next round).
      if (shouldUpdatePhase && newPhase !== undefined) {
        this.context.processingPhase = newPhase;
      }
    } else {
      this.context.processingPhase = null;
    }
    
    switch (event) {
      case SessionExecutionEvent.START:
        this.context.taskId = payload?.taskId || null;
        this.context.currentDialogTurnId = payload?.dialogTurnId || null;
        this.context.processingPhase = PHASE_TRANSITIONS[event];
        this.context.stats.startTime = Date.now();
        this.context.stats.textCharsGenerated = 0;
        this.context.stats.toolsExecuted = 0;
        break;

      case SessionExecutionEvent.MODEL_ROUND_START:
        this.context.currentModelRoundId = payload?.modelRoundId || null;
        break;

      case SessionExecutionEvent.TEXT_CHUNK_RECEIVED:
        if (payload?.content) {
          this.context.stats.textCharsGenerated += payload.content.length;
        }
        break;

      case SessionExecutionEvent.TOOL_CONFIRMATION_NEEDED:
        if (payload?.toolUseId) {
          this.context.pendingToolConfirmations.add(payload.toolUseId);
        }
        break;

      case SessionExecutionEvent.TOOL_CONFIRMED:
      case SessionExecutionEvent.TOOL_REJECTED:
        if (payload?.toolUseId) {
          this.context.pendingToolConfirmations.delete(payload.toolUseId);
        }
        break;

      case SessionExecutionEvent.TOOL_COMPLETED:
        this.context.stats.toolsExecuted++;
        break;

      case SessionExecutionEvent.ERROR_OCCURRED:
        this.context.errorMessage = payload?.error || 'Unknown error';
        this.context.processingPhase = null;
        
        this.context.errorRecovery.errorCount += 1;
        this.context.errorRecovery.lastErrorTime = Date.now();
        this.context.errorRecovery.errorType = payload?.errorType || 'unknown';
        this.context.errorRecovery.recoverable = payload?.recoverable !== false;
        break;

      case SessionExecutionEvent.BACKEND_STREAM_COMPLETED:
        this.context.processingPhase = ProcessingPhase.FINALIZING;
        break;

      case SessionExecutionEvent.USER_CANCEL:
      case SessionExecutionEvent.FINISHING_SETTLED:
      case SessionExecutionEvent.RESET:
        if (this.currentState === SessionExecutionState.IDLE) {
          const queuedInput = this.context.queuedInput;
          const taskId = this.context.taskId;
          const dialogTurnId = this.context.currentDialogTurnId;
          
          this.context = createInitialContext();
          this.context.queuedInput = queuedInput;
          
          if (event === SessionExecutionEvent.USER_CANCEL) {
            if (taskId) {
              this.context.taskId = taskId;
            }
            if (dialogTurnId) {
              this.context.currentDialogTurnId = dialogTurnId;
            }
          }
        }
        break;
    }
  }

  private async runSideEffects(event: SessionExecutionEvent, _payload?: any) {
    const state = this.currentState;

    if (event === SessionExecutionEvent.USER_CANCEL && this.context.taskId && this.context.currentDialogTurnId) {
      const { flowChatStore } = await import('@/flow_chat/store/FlowChatStore');
      const sessionId = this.context.taskId;
      const dialogTurnId = this.context.currentDialogTurnId;
      const { acpClientIdFromAgentType } = await import('@/flow_chat/utils/acpSession');
      const session = flowChatStore.getState().sessions.get(sessionId);
      const acpClientId =
        acpClientIdFromAgentType(session?.config?.agentType) ||
        acpClientIdFromAgentType(session?.mode);
      
      try {
        if (acpClientId) {
          const { ACPClientAPI } = await import('@/infrastructure/api/service-api/ACPClientAPI');
          await ACPClientAPI.cancelDialogTurn({
            sessionId,
            clientId: acpClientId,
            workspaceId: session?.workspaceId || session?.config?.workspaceId,
            workspacePath: session?.workspacePath || session?.config?.workspacePath,
            remoteConnectionId: session?.remoteConnectionId,
            remoteSshHost: session?.remoteSshHost,
          });
        } else {
          const { agentAPI } = await import('@/infrastructure/api/service-api/AgentAPI');
          const { isPeerDeviceModeActive } = await import(
            '@/infrastructure/peer-device/peerModeFlag'
          );
          const goalStatus = session?.threadGoal?.status?.toLowerCase();
          const supportsRecoverableInterruption =
            session?.sessionKind === 'normal'
            && !session.remoteConnectionId
            && !session.remoteSshHost
            && !session.config?.remoteConnectionId
            && !session.config?.remoteSshHost
            && !session.config?.dispatchTarget
            && !session.config?.dispatchJobId
            && goalStatus !== 'active'
            && goalStatus !== 'paused'
            && !isPeerDeviceModeActive();
          if (supportsRecoverableInterruption) {
            await agentAPI.interruptDialogTurn(sessionId, dialogTurnId);
          } else {
            await agentAPI.cancelDialogTurn(sessionId, dialogTurnId);
          }
        }
        log.debug('Backend interruption completed', { sessionId, dialogTurnId, acpClientId });
      } catch (error) {
        log.error('Backend cancellation failed', { sessionId, dialogTurnId, acpClientId, error });
        await this.transition(SessionExecutionEvent.USER_CANCEL_FAILED).catch(transitionError => {
          log.error('Failed to restore processing state after cancellation failure', {
            sessionId,
            dialogTurnId,
            transitionError,
          });
        });
      }
    }

    if (state === SessionExecutionState.IDLE && this.context.planner?.isActive) {
      this.context.planner.isActive = false;
    }
  }

  updatePlanner(todos: any[], isActive: boolean) {
    this.context.planner = {
      todos,
      isActive,
    };
    this.notifyListeners();
  }

  setQueuedInput(input: string | null) {
    this.context.queuedInput = input;
    this.notifyListeners();
  }

  subscribe(listener: (machine: SessionStateMachine) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    const snapshot = this.getSnapshot();
    this.listeners.forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        log.error('Listener error', error);
      }
    });
  }

  reset() {
    this.currentState = SessionExecutionState.IDLE;
    this.context = createInitialContext();
    this.transitionHistory = [];
    this.notifyListeners();
  }
}
