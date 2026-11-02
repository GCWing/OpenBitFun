
export * from './types';

export {
  calculateTurnHash,
  debouncedSaveDialogTurn,
  immediateSaveDialogTurn,
  cleanupSaveState,
  saveDialogTurnToDisk,
  saveAllInProgressTurns,
  convertDialogTurnToBackendFormat,
  updateSessionMetadata,
  touchSessionActivity
} from './PersistenceModule';

export {
  processNormalTextChunkInternal,
  processThinkingChunkInternal,
  completeActiveTextItems,
  cleanupSessionBuffers,
  clearAllBuffers
} from './TextChunkModule';

export {
  processToolEvent,
  processToolParamsPartialInternal,
  processToolProgressInternal,
  handleToolExecutionProgress
} from './ToolEventModule';

export {
  getModelMaxTokens,
  resolveAgentTypeForSessionCreation,
  createChatSession,
  hydrateSessionHistoryForDetail,
  preloadHistoricalSessionForOpen,
  switchChatSession,
  deleteChatSession,
  archiveChatSession,
  renameChatSessionTitle,
  reloadSessionTitle,
  forkChatSession,
  duplicateChatSession,
} from './SessionModule';

export {
  sendMessage,
  cancelCurrentTask,
  cancelSessionTask,
  markCurrentTurnItemsAsCancelled,
  drainPendingQueue,
  installPendingQueueDrainListener,
  inFlightSubmissionCount,
  waitForInFlightSubmissions
} from './MessageModule';

export { pendingQueueManager } from './PendingQueueModule';
export type { EnqueueInput, PendingQueueListener } from './PendingQueueModule';

export {
  shouldProcessEvent,
  mapBackendStateToFrontend,
  initializeEventListeners,
  processBatchedEvents,
  projectDialogTurnRecovered,
} from './EventHandlerModule';

export {
  addDialogTurn,
  addImageAnalysisPhase,
  updateImageAnalysisResults,
  updateImageAnalysisItem
} from './ImageAnalysisModule';
