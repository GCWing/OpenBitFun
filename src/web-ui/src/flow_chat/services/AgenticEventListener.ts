/**
 * Agentic event listener
 * Listens to backend agentic:// events and dispatches them to the frontend
 * 
 * Architecture:
 * - Uses unified agentAPI (based on ApiClient) for event listening
 * - ApiClient internally uses TransportAdapter, supporting multiple platforms
 */

import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import type {
  TextChunkEvent,
  ToolEvent,
  AgenticEvent,
  SubagentSessionLinkedEvent,
  SessionTitleGeneratedEvent,
  PromptSuggestionEvent,
  SessionModelFallbackAppliedEvent,
  SessionReasoningPresetAutoClearedEvent,
  ImageAnalysisEvent,
  ModelRoundStartedEvent,
  ModelRoundCompletedEvent,
  ModelRoundAttemptSupersededEvent,
  UserSteeringInjectedEvent,
  DeepReviewQueueStateChangedEvent,
  AcpContextUsageUpdatedEvent,
  OpenBuiltInBrowserEvent,
  InterruptedDialogTurnEvent,
} from '@/infrastructure/api/service-api/AgentAPI';
import { createLogger } from '@/shared/utils/logger';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

/** Remote transcript content has one owner: the canonical session records.
 * Tool approval events carry interaction facts, not transcript replacements. */
function acceptsSurfaceEvent(eventName: string, payload: { toolEvent?: { event_type?: string } }): boolean {
  if (getActiveSurfaceId() === 'local') return true;
  if (eventName === 'agentic://text-chunk') return false;
  if (eventName !== 'agentic://tool-event') return true;
  return ['ConfirmationNeeded', 'Confirmed', 'Rejected', 'Cancelled']
    .includes(payload.toolEvent?.event_type ?? '');
}

type UnlistenFn = () => void;

const logger = createLogger('AgenticEventListener');

function normalizeSessionModelFallbackEvent(
  event: SessionModelFallbackAppliedEvent,
): SessionModelFallbackAppliedEvent {
  return event.newModelId === 'auto' || event.newModelId === 'default'
    ? { ...event, newModelId: 'primary' }
    : event;
}

export interface AgenticEventCallbacks {
  onSessionCreated?: (event: AgenticEvent) => void;
  onSessionDeleted?: (event: AgenticEvent) => void;
  onSessionStateChanged?: (event: AgenticEvent) => void;
  onSessionHistoryChanged?: (event: AgenticEvent) => void;
  onImageAnalysisStarted?: (event: ImageAnalysisEvent) => void;
  onImageAnalysisCompleted?: (event: ImageAnalysisEvent) => void;
  onDialogTurnStarted?: (event: AgenticEvent) => void;
  onModelRoundStarted?: (event: ModelRoundStartedEvent) => void;
  onModelRoundCompleted?: (event: ModelRoundCompletedEvent) => void;
  onModelRoundAttemptSuperseded?: (event: ModelRoundAttemptSupersededEvent) => void;
  onTextChunk?: (event: TextChunkEvent) => void;
  onToolEvent?: (event: ToolEvent) => void;
  onSubagentSessionLinked?: (event: SubagentSessionLinkedEvent) => void;
  onDeepReviewQueueStateChanged?: (event: DeepReviewQueueStateChangedEvent) => void;
  onDialogTurnCompleted?: (event: AgenticEvent) => void;
  onDialogTurnFailed?: (event: AgenticEvent) => void;
  onDialogTurnCancelled?: (event: AgenticEvent) => void;
  onDialogTurnInterrupted?: (event: InterruptedDialogTurnEvent) => void;
  onDialogTurnRecovered?: (event: InterruptedDialogTurnEvent) => void;
  onTokenUsageUpdated?: (event: AgenticEvent) => void;
  onAcpContextUsageUpdated?: (event: AcpContextUsageUpdatedEvent) => void;
  onContextCompressionStarted?: (event: AgenticEvent) => void;
  onContextCompressionCompleted?: (event: AgenticEvent) => void;
  onContextCompressionFailed?: (event: AgenticEvent) => void;
  onThreadGoalUpdated?: (event: { sessionId: string; goal?: Record<string, unknown> | null }) => void;
  onOpenBuiltInBrowser?: (event: OpenBuiltInBrowserEvent) => void;
  onSessionTitleGenerated?: (event: SessionTitleGeneratedEvent) => void;
  onPromptSuggestion?: (event: PromptSuggestionEvent) => void;
  onSessionModelFallbackApplied?: (event: SessionModelFallbackAppliedEvent) => void;
  onSessionReasoningPresetAutoCleared?: (
    event: SessionReasoningPresetAutoClearedEvent
  ) => void;
  onUserSteeringInjected?: (event: UserSteeringInjectedEvent) => void;
}

export class AgenticEventListener {
  private unlistenFunctions: UnlistenFn[] = [];
  private isListening = false;
  private callbacks: AgenticEventCallbacks | null = null;

  async startListening(callbacks: AgenticEventCallbacks): Promise<void> {
    if (this.isListening) {
      logger.warn('Event listener already running');
      return;
    }

    logger.info('Starting Agentic event listener');

    try {
      this.callbacks = callbacks;
      if (callbacks.onSessionCreated) {
        const unlisten = agentAPI.onSessionCreated((event) => {
          logger.debug('Session created:', event);
          callbacks.onSessionCreated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionDeleted) {
        const unlisten = agentAPI.onSessionDeleted((event) => {
          logger.debug('Session deleted:', event);
          callbacks.onSessionDeleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionStateChanged) {
        const unlisten = agentAPI.onSessionStateChanged((event) => {
          logger.debug('Session state changed:', event);
          callbacks.onSessionStateChanged?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionHistoryChanged) {
        const unlisten = agentAPI.onSessionHistoryChanged((event) => {
          logger.debug('Session history changed:', event);
          callbacks.onSessionHistoryChanged?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onImageAnalysisStarted) {
        const unlisten = agentAPI.onImageAnalysisStarted((event) => {
          logger.debug('Image analysis started:', event);
          callbacks.onImageAnalysisStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onImageAnalysisCompleted) {
        const unlisten = agentAPI.onImageAnalysisCompleted((event) => {
          logger.debug('Image analysis completed:', event);
          callbacks.onImageAnalysisCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnStarted) {
        const unlisten = agentAPI.onDialogTurnStarted((event) => {
          logger.debug('Dialog turn started:', event);
          callbacks.onDialogTurnStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onModelRoundStarted) {
        const unlisten = agentAPI.onModelRoundStarted((event) => {
          logger.debug('Model round started:', event);
          callbacks.onModelRoundStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onModelRoundCompleted) {
        const unlisten = agentAPI.onModelRoundCompleted((event) => {
          logger.debug('Model round completed:', event);
          callbacks.onModelRoundCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onModelRoundAttemptSuperseded) {
        const unlisten = agentAPI.onModelRoundAttemptSuperseded((event) => {
          logger.debug('Model round attempt superseded:', event);
          callbacks.onModelRoundAttemptSuperseded?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onTextChunk) {
        const unlisten = agentAPI.onTextChunk((event) => {
          if (!acceptsSurfaceEvent('agentic://text-chunk', {})) return;
          callbacks.onTextChunk?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onToolEvent) {
        const unlisten = agentAPI.onToolEvent((event) => {
          if (!acceptsSurfaceEvent('agentic://tool-event', event)) return;
          callbacks.onToolEvent?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSubagentSessionLinked) {
        const unlisten = agentAPI.onSubagentSessionLinked((event) => {
          logger.debug('Subagent session linked:', event);
          callbacks.onSubagentSessionLinked?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDeepReviewQueueStateChanged) {
        const unlisten = agentAPI.onDeepReviewQueueStateChanged((event) => {
          logger.debug('Deep Review queue state changed:', event);
          callbacks.onDeepReviewQueueStateChanged?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnCompleted) {
        const unlisten = agentAPI.onDialogTurnCompleted((event) => {
          logger.debug('Dialog turn completed:', event);
          callbacks.onDialogTurnCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnFailed) {
        const unlisten = agentAPI.onDialogTurnFailed((event) => {
          logger.error('Dialog turn failed:', event);
          callbacks.onDialogTurnFailed?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnCancelled) {
        const unlisten = agentAPI.onDialogTurnCancelled((event) => {
          logger.debug('Dialog turn cancelled:', event);
          callbacks.onDialogTurnCancelled?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnInterrupted) {
        const unlisten = agentAPI.onDialogTurnInterrupted((event) => {
          logger.debug('Dialog turn interrupted:', event);
          callbacks.onDialogTurnInterrupted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onDialogTurnRecovered) {
        const unlisten = agentAPI.onDialogTurnRecovered((event) => {
          logger.debug('Dialog turn recovered:', event);
          callbacks.onDialogTurnRecovered?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onTokenUsageUpdated) {
        const unlisten = agentAPI.onTokenUsageUpdated((event) => {
          logger.debug('Token usage updated:', event);
          callbacks.onTokenUsageUpdated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onAcpContextUsageUpdated) {
        const unlisten = agentAPI.onAcpContextUsageUpdated((event) => {
          logger.debug('ACP context usage updated:', event);
          callbacks.onAcpContextUsageUpdated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onContextCompressionStarted) {
        const unlisten = agentAPI.onContextCompressionStarted((event) => {
          logger.debug('Context compression started:', event);
          callbacks.onContextCompressionStarted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onContextCompressionCompleted) {
        const unlisten = agentAPI.onContextCompressionCompleted((event) => {
          logger.debug('Context compression completed:', event);
          callbacks.onContextCompressionCompleted?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onContextCompressionFailed) {
        const unlisten = agentAPI.onContextCompressionFailed((event) => {
          logger.error('Context compression failed:', event);
          callbacks.onContextCompressionFailed?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onThreadGoalUpdated) {
        const unlisten = agentAPI.onThreadGoalUpdated((event) => {
          logger.debug('Thread goal updated:', event);
          callbacks.onThreadGoalUpdated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onOpenBuiltInBrowser) {
        const unlisten = agentAPI.onOpenBuiltInBrowser((event) => {
          logger.debug('Open built-in browser requested:', event);
          callbacks.onOpenBuiltInBrowser?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionTitleGenerated) {
        const unlisten = agentAPI.onSessionTitleGenerated((event) => {
          logger.debug('Session title generated:', event);
          callbacks.onSessionTitleGenerated?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onPromptSuggestion) {
        const unlisten = agentAPI.onPromptSuggestion((event) => {
          logger.debug('Prompt suggestion received:', { sessionId: event.sessionId });
          callbacks.onPromptSuggestion?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onUserSteeringInjected) {
        const unlisten = agentAPI.onUserSteeringInjected((event) => {
          logger.debug('User steering injected:', event);
          callbacks.onUserSteeringInjected?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionModelFallbackApplied) {
        const unlisten = agentAPI.onSessionModelFallbackApplied((event) => {
          logger.debug('Session model fallback applied', event);
          callbacks.onSessionModelFallbackApplied?.(
            normalizeSessionModelFallbackEvent(event),
          );
        });
        this.unlistenFunctions.push(unlisten);
      }

      if (callbacks.onSessionReasoningPresetAutoCleared) {
        const unlisten = agentAPI.onSessionReasoningPresetAutoCleared((event) => {
          logger.debug('Session reasoning preset auto-cleared', event);
          callbacks.onSessionReasoningPresetAutoCleared?.(event);
        });
        this.unlistenFunctions.push(unlisten);
      }

      this.isListening = true;
      logger.info(`Registered ${this.unlistenFunctions.length} event listeners`);
    } catch (error) {
      logger.error('Failed to register event listeners:', error);
      await this.stopListening();
      throw error;
    }
  }

  /**
   * Feed a durable event obtained through another transport into the same
   * handlers as live `agentic://*` events. Dispatch observers use this instead
   * of creating a second transcript reducer.
   *
   * `false` means the normal listener is not ready; callers must retain their
   * cursor and retry rather than dropping the event.
   */
  dispatchExternal(eventName: string, payload: Record<string, unknown>): boolean {
    const callbacks = this.callbacks;
    if (!callbacks) {
      return false;
    }

    if (!acceptsSurfaceEvent(eventName, payload)) return true;
    switch (eventName) {
      case 'agentic://session-created':
        callbacks.onSessionCreated?.(payload as AgenticEvent);
        break;
      case 'agentic://session-deleted':
        callbacks.onSessionDeleted?.(payload as AgenticEvent);
        break;
      case 'agentic://session-state-changed':
        callbacks.onSessionStateChanged?.(payload as AgenticEvent);
        break;
      case 'agentic://session-history-changed':
        callbacks.onSessionHistoryChanged?.(payload as AgenticEvent);
        break;
      case 'agentic://image-analysis-started':
        callbacks.onImageAnalysisStarted?.(payload as unknown as ImageAnalysisEvent);
        break;
      case 'agentic://image-analysis-completed':
        callbacks.onImageAnalysisCompleted?.(payload as unknown as ImageAnalysisEvent);
        break;
      case 'agentic://dialog-turn-started':
        callbacks.onDialogTurnStarted?.(payload as AgenticEvent);
        break;
      case 'agentic://model-round-started':
        callbacks.onModelRoundStarted?.(payload as unknown as ModelRoundStartedEvent);
        break;
      case 'agentic://model-round-completed':
        callbacks.onModelRoundCompleted?.(payload as unknown as ModelRoundCompletedEvent);
        break;
      case 'agentic://model-round-attempt-superseded':
        callbacks.onModelRoundAttemptSuperseded?.(
          payload as unknown as ModelRoundAttemptSupersededEvent,
        );
        break;
      case 'agentic://text-chunk':
        callbacks.onTextChunk?.(payload as unknown as TextChunkEvent);
        break;
      case 'agentic://tool-event':
        callbacks.onToolEvent?.(payload as unknown as ToolEvent);
        break;
      case 'agentic://subagent-session-linked':
        callbacks.onSubagentSessionLinked?.(payload as unknown as SubagentSessionLinkedEvent);
        break;
      case 'agentic://deep-review-queue-state-changed':
        callbacks.onDeepReviewQueueStateChanged?.(
          payload as unknown as DeepReviewQueueStateChangedEvent,
        );
        break;
      case 'agentic://dialog-turn-completed':
        callbacks.onDialogTurnCompleted?.(payload as AgenticEvent);
        break;
      case 'agentic://dialog-turn-failed':
        callbacks.onDialogTurnFailed?.(payload as AgenticEvent);
        break;
      case 'agentic://dialog-turn-cancelled':
        callbacks.onDialogTurnCancelled?.(payload as AgenticEvent);
        break;
      case 'agentic://dialog-turn-interrupted':
        callbacks.onDialogTurnInterrupted?.(payload as unknown as InterruptedDialogTurnEvent);
        break;
      case 'agentic://dialog-turn-recovered':
        callbacks.onDialogTurnRecovered?.(payload as unknown as InterruptedDialogTurnEvent);
        break;
      case 'agentic://token-usage-updated':
        callbacks.onTokenUsageUpdated?.(payload as AgenticEvent);
        break;
      case 'agentic://acp-context-usage-updated':
        callbacks.onAcpContextUsageUpdated?.(payload as unknown as AcpContextUsageUpdatedEvent);
        break;
      case 'agentic://context-compression-started':
        callbacks.onContextCompressionStarted?.(payload as AgenticEvent);
        break;
      case 'agentic://context-compression-completed':
        callbacks.onContextCompressionCompleted?.(payload as AgenticEvent);
        break;
      case 'agentic://context-compression-failed':
        callbacks.onContextCompressionFailed?.(payload as AgenticEvent);
        break;
      case 'agentic://thread-goal-updated':
        callbacks.onThreadGoalUpdated?.(
          payload as { sessionId: string; goal?: Record<string, unknown> | null },
        );
        break;
      case 'agentic://open-built-in-browser':
        callbacks.onOpenBuiltInBrowser?.(payload as unknown as OpenBuiltInBrowserEvent);
        break;
      case 'session_title_generated':
        callbacks.onSessionTitleGenerated?.(payload as unknown as SessionTitleGeneratedEvent);
        break;
      case 'agentic://prompt-suggestion':
        callbacks.onPromptSuggestion?.(payload as unknown as PromptSuggestionEvent);
        break;
      // Upgrade-only event-name alias for older Peer/Dispatch targets.
      case 'agentic://session-model-auto-migrated':
      case 'agentic://session-model-fallback-applied':
        callbacks.onSessionModelFallbackApplied?.(
          normalizeSessionModelFallbackEvent(
            payload as unknown as SessionModelFallbackAppliedEvent,
          ),
        );
        break;
      case 'agentic://session-reasoning-preset-auto-cleared':
        callbacks.onSessionReasoningPresetAutoCleared?.(
          payload as unknown as SessionReasoningPresetAutoClearedEvent,
        );
        break;
      case 'agentic://user-steering-injected':
        callbacks.onUserSteeringInjected?.(payload as unknown as UserSteeringInjectedEvent);
        break;
      default:
        logger.debug('Ignoring unsupported external agentic event', { eventName });
        break;
    }
    return true;
  }

  async stopListening(): Promise<void> {
    if (!this.isListening) {
      return;
    }

    logger.info('Stopping Agentic event listener');

    for (const unlisten of this.unlistenFunctions) {
      try {
        unlisten();
      } catch (error) {
        logger.error('Failed to unlisten:', error);
      }
    }

    this.unlistenFunctions = [];
    this.isListening = false;
    this.callbacks = null;
    logger.info('Stopped all event listeners');
  }

  getIsListening(): boolean {
    return this.isListening;
  }
}

export const agenticEventListener = new AgenticEventListener();
