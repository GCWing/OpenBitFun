/**
 * Handles streamed text chunks and thinking content.
 */

import type { FlowChatContext, FlowTextItem } from './types';
import { clearRuntimeStatus } from './RuntimeStatusModule';
import { isAcpFlowSession } from '../../utils/acpSession';
import {
  clearRuntimeStatusState,
  resetRuntimeStatuses,
} from '../../store/runtimeStatusStore';

function resolveAttemptStreamKey(roundId: string, attemptId?: string, attemptIndex?: number): string {
  if (typeof attemptId === 'string' && attemptId.length > 0) {
    return attemptId;
  }
  if (typeof attemptIndex === 'number' && Number.isFinite(attemptIndex)) {
    return `${roundId}:attempt:${attemptIndex}`;
  }
  return roundId;
}

function activeTextHasLaterRoundItem(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string,
  textItemId: string
): boolean {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  if (!session || !isAcpFlowSession(session)) {
    return false;
  }

  const turn = session?.dialogTurns.find(candidate => candidate.id === turnId);
  const round = turn?.modelRounds.find(candidate => candidate.id === roundId);
  if (!round) return false;

  const textItemIndex = round.items.findIndex(item => item.id === textItemId);
  if (textItemIndex === -1) return false;

  return round.items.slice(textItemIndex + 1).some(item => item.type !== 'text');
}

function closeActiveTextSegment(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  streamKey: string,
  textItemId: string
): void {
  context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, textItemId, {
    isStreaming: false,
    status: 'completed',
  } as any);

  context.contentBuffers.get(sessionId)?.delete(streamKey);
  context.activeTextItems.get(sessionId)?.delete(streamKey);
}

function isRoundClosed(round: { isStreaming?: boolean; isComplete?: boolean; status?: string } | undefined): boolean {
  if (!round) {
    return false;
  }

  return round.isStreaming === false || round.isComplete === true || round.status === 'completed';
}

function findRound(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string
): import('../../types/flow-chat').ModelRound | undefined {
  const session = context.flowChatStore.getState().sessions.get(sessionId);
  const turn = session?.dialogTurns.find(candidate => candidate.id === turnId);
  return turn?.modelRounds.find(candidate => candidate.id === roundId);
}

/**
 * Process a normal text chunk without notifying the store.
 */
export function processNormalTextChunkInternal(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string,
  text: string,
  attemptId?: string,
  attemptIndex?: number,
): void {
  clearRuntimeStatus(context, sessionId, turnId, { roundId });

  if (!context.contentBuffers.has(sessionId)) {
    context.contentBuffers.set(sessionId, new Map());
  }
  if (!context.activeTextItems.has(sessionId)) {
    context.activeTextItems.set(sessionId, new Map());
  }
  
  const sessionContentBuffer = context.contentBuffers.get(sessionId)!;
  const sessionActiveTextItems = context.activeTextItems.get(sessionId)!;
  const streamKey = resolveAttemptStreamKey(roundId, attemptId, attemptIndex);

  const activeTextItemId = sessionActiveTextItems.get(streamKey);
  const round = findRound(context, sessionId, turnId, roundId);
  if (
    activeTextItemId &&
    activeTextHasLaterRoundItem(context, sessionId, turnId, roundId, activeTextItemId)
  ) {
    closeActiveTextSegment(context, sessionId, turnId, streamKey, activeTextItemId);
  }

  let textItemId = sessionActiveTextItems.get(streamKey);
  let recoveredExistingContent = '';
  if (!textItemId) {
    const reusableTextItem = [...(round?.items ?? [])]
      .reverse()
      .find((item): item is FlowTextItem =>
        item.type === 'text' &&
        item.attemptId === attemptId &&
        item.attemptIndex === attemptIndex &&
        (item.isStreaming || isRoundClosed(round))
      );

    if (reusableTextItem) {
      textItemId = reusableTextItem.id;
      recoveredExistingContent = reusableTextItem.content || '';
      sessionActiveTextItems.set(streamKey, textItemId);
      if (!sessionContentBuffer.has(streamKey) && recoveredExistingContent) {
        sessionContentBuffer.set(streamKey, recoveredExistingContent);
      }
    }
  }

  // Coalesce excessive newlines while appending.
  const currentContent = sessionContentBuffer.get(streamKey) || recoveredExistingContent;
  const cleanedContent = (currentContent + text).replace(/\n{3,}/g, '\n\n');
  sessionContentBuffer.set(streamKey, cleanedContent);

  if (!textItemId) {
    textItemId = `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const textItem: FlowTextItem = {
      id: textItemId,
      type: 'text',
      content: cleanedContent,
      isStreaming: true,
      isMarkdown: true,
      timestamp: Date.now(),
      status: 'streaming',
      attemptId,
      attemptIndex,
    };
    
    context.flowChatStore.addModelRoundItemSilent(sessionId, turnId, textItem, roundId);
    sessionActiveTextItems.set(streamKey, textItemId);
  } else {
    context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, textItemId, {
      content: cleanedContent,
      isStreaming: true,
      isMarkdown: true,
      timestamp: Date.now(),
      attemptId,
      attemptIndex,
    } as any);
  }
}

/**
 * Process thinking chunks without notifying the store.
 */
export function processThinkingChunkInternal(
  context: FlowChatContext,
  sessionId: string,
  turnId: string,
  roundId: string,
  text: string,
  isThinkingEnd = false,
  attemptId?: string,
  attemptIndex?: number,
  reasoningKind?: 'reasoning' | 'summary',
): void {
  clearRuntimeStatus(context, sessionId, turnId, { roundId });

  if (!context.contentBuffers.has(sessionId)) {
    context.contentBuffers.set(sessionId, new Map());
  }
  if (!context.activeTextItems.has(sessionId)) {
    context.activeTextItems.set(sessionId, new Map());
  }
  
  const sessionContentBuffer = context.contentBuffers.get(sessionId)!;
  const sessionActiveTextItems = context.activeTextItems.get(sessionId)!;
  const streamKey = resolveAttemptStreamKey(roundId, attemptId, attemptIndex);

  // Store thinking content under a separate key.
  const thinkingKey = `thinking_${reasoningKind ?? 'none'}_${streamKey}`;
  const round = findRound(context, sessionId, turnId, roundId);

  let thinkingItemId = sessionActiveTextItems.get(thinkingKey);
  let recoveredExistingContent = '';
  if (!thinkingItemId) {
    const reusableThinkingItem = [...(round?.items ?? [])]
      .reverse()
      .find((item): item is import('../../types/flow-chat').FlowThinkingItem =>
        item.type === 'thinking' &&
        item.attemptId === attemptId &&
        item.attemptIndex === attemptIndex &&
        item.reasoningKind === reasoningKind &&
        (item.isStreaming || isRoundClosed(round))
      );

    if (reusableThinkingItem) {
      thinkingItemId = reusableThinkingItem.id;
      recoveredExistingContent = reusableThinkingItem.content || '';
      sessionActiveTextItems.set(thinkingKey, thinkingItemId);
      if (!sessionContentBuffer.has(thinkingKey) && recoveredExistingContent) {
        sessionContentBuffer.set(thinkingKey, recoveredExistingContent);
      }
    }
  }

  const currentContent = sessionContentBuffer.get(thinkingKey) || recoveredExistingContent;
  const cleanedContent = (currentContent + text).replace(/\n{3,}/g, '\n\n');
  sessionContentBuffer.set(thinkingKey, cleanedContent);
  
  if (!thinkingItemId) {
    thinkingItemId = `thinking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const thinkingItem: import('../../types/flow-chat').FlowThinkingItem = {
      id: thinkingItemId,
      type: 'thinking',
      content: cleanedContent,
      reasoningKind,
      isStreaming: !isThinkingEnd,
      isCollapsed: isThinkingEnd,
      timestamp: Date.now(),
      status: isThinkingEnd ? 'completed' : 'streaming',
      attemptId,
      attemptIndex,
    };
    
    context.flowChatStore.addModelRoundItemSilent(sessionId, turnId, thinkingItem, roundId);
    sessionActiveTextItems.set(thinkingKey, thinkingItemId);
    
    if (isThinkingEnd) {
      sessionContentBuffer.delete(thinkingKey);
      sessionActiveTextItems.delete(thinkingKey);
    }
    } else {
      if (isThinkingEnd) {
        context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, thinkingItemId, {
          content: cleanedContent,
          reasoningKind,
          isStreaming: false,
        isCollapsed: true,
        status: 'completed',
        timestamp: Date.now(),
        attemptId,
        attemptIndex,
      } as any);
      
      sessionContentBuffer.delete(thinkingKey);
      sessionActiveTextItems.delete(thinkingKey);
      } else {
        context.flowChatStore.updateModelRoundItemSilent(sessionId, turnId, thinkingItemId, {
          content: cleanedContent,
          reasoningKind,
          isStreaming: true,
          isCollapsed: false,
          status: 'streaming',
          timestamp: Date.now(),
          attemptId,
          attemptIndex,
        } as any);
      }
    }
  }

/**
 * Finalize streaming state for active text items.
 */
export function completeActiveTextItems(
  context: FlowChatContext,
  sessionId: string,
  turnId: string
): void {
  const sessionActiveTextItems = context.activeTextItems.get(sessionId);
  if (sessionActiveTextItems && sessionActiveTextItems.size > 0) {
    const itemsToComplete = Array.from(sessionActiveTextItems.entries());
    const batchUpdates = itemsToComplete
      .map(([_streamKey, itemId]) => ({
        itemId,
        changes: {
          isStreaming: false,
          status: 'completed' as const
        }
      }));
    
    if (batchUpdates.length > 0) {
      context.flowChatStore.batchUpdateModelRoundItems(sessionId, turnId, batchUpdates);
    }

    // A finalized segment must release its accumulated text together with its
    // item registration. Keeping the buffer made the next chunk of the same
    // stream key create a second item seeded with everything already painted
    // (issue 2778). The item stays the source of truth for its own content, so
    // a genuine late chunk still continues it through the reuse path.
    const sessionContentBuffer = context.contentBuffers.get(sessionId);
    if (sessionContentBuffer) {
      for (const [streamKey] of itemsToComplete) {
        sessionContentBuffer.delete(streamKey);
      }
    }
    
    sessionActiveTextItems.clear();
  }
}

/**
 * Clean up session buffers.
 */
export function cleanupSessionBuffers(context: FlowChatContext, sessionId: string): void {
  const batcherSize = context.eventBatcher.getBufferSize();
  if (batcherSize > 0) {
    context.eventBatcher.clear();
  }

  const pendingCompletion = context.pendingTurnCompletions.get(sessionId);
  if (pendingCompletion) {
    if (pendingCompletion.timer) {
      clearTimeout(pendingCompletion.timer);
    }
    context.pendingTurnCompletions.delete(sessionId);
  }
  
  const contentBuffer = context.contentBuffers.get(sessionId);
  if (contentBuffer) {
    context.contentBuffers.delete(sessionId);
  }
  
  const activeItems = context.activeTextItems.get(sessionId);
  if (activeItems) {
    context.activeTextItems.delete(sessionId);
  }

  for (const [key, timer] of context.runtimeStatusTimers.entries()) {
    if (key.startsWith(`${sessionId}:`)) {
      clearTimeout(timer);
      context.runtimeStatusTimers.delete(key);
    }
  }
  clearRuntimeStatusState({ sessionId });

  // P1-11: Drop terminal-event dedup keys belonging to this session so the
  // set does not grow unbounded across the lifetime of the app.
  const prefix = `${sessionId}:`;
  for (const key of context.handledTerminalTurnEvents) {
    if (key.startsWith(prefix)) {
      context.handledTerminalTurnEvents.delete(key);
    }
  }
}

/**
 * Clear all buffers and transient state.
 */
export function clearAllBuffers(context: FlowChatContext): void {
  for (const pendingCompletion of context.pendingTurnCompletions.values()) {
    if (pendingCompletion.timer) {
      clearTimeout(pendingCompletion.timer);
    }
  }
  context.pendingTurnCompletions.clear();

  context.contentBuffers.clear();
  context.activeTextItems.clear();

  for (const timer of context.runtimeStatusTimers.values()) {
    clearTimeout(timer);
  }
  context.runtimeStatusTimers.clear();
  resetRuntimeStatuses();
  
  for (const timer of context.saveDebouncers.values()) {
    clearTimeout(timer);
  }
  context.saveDebouncers.clear();
  context.lastSaveTimestamps.clear();
  context.lastSaveHashes.clear();
  context.turnSavePending.clear();
  context.turnSaveInFlight.clear();
  context.handledTerminalTurnEvents.clear();
}
