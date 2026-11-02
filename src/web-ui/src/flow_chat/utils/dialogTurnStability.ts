import type {
  DialogTurn,
  AnyFlowItem,
  FlowTextItem,
  FlowThinkingItem,
  FlowToolItem,
  ModelRound,
} from '../types/flow-chat';

const TRANSIENT_TURN_STATUSES = new Set(['pending', 'processing', 'finishing', 'image_analyzing', 'cancelling', 'inprogress']);
const TRANSIENT_ROUND_STATUSES = new Set(['pending', 'streaming', 'pending_confirmation']);
const TERMINAL_ROUND_STATUSES = new Set(['completed', 'cancelled', 'rejected', 'error']);
const TRANSIENT_TOOL_STATUSES = new Set([
  'pending',
  'preparing',
  'streaming',
  'running',
  'receiving',
  'starting',
  'analyzing',
  'pending_confirmation',
  'confirmed',
]);
const TERMINAL_TOOL_STATUSES = new Set(['completed', 'cancelled', 'rejected', 'error']);
const TERMINAL_ITEM_STATUSES = new Set(['completed', 'cancelled', 'rejected', 'error']);
const STABLE_ITEM_STATUSES = new Set(['completed', 'cancelled', 'rejected', 'error']);

type SettleInterruptedDialogTurnOptions = {
  interruptionReason?: FlowToolItem['interruptionReason'];
};

export type TerminalDialogTurnStatus = Extract<
  DialogTurn['status'],
  'completed' | 'cancelled' | 'error'
>;

export function isTransientToolStatus(status: unknown): boolean {
  return typeof status === 'string' && TRANSIENT_TOOL_STATUSES.has(status);
}

export function isTransientTurnStatus(status: unknown): boolean {
  return typeof status === 'string' && TRANSIENT_TURN_STATUSES.has(status);
}

export function normalizeRecoveredTurnFinishReason(
  status: unknown,
  finishReason: unknown,
): string | undefined {
  if (typeof finishReason === 'string' && finishReason.trim()) {
    return finishReason;
  }

  return isTransientTurnStatus(status) ? 'interrupted' : undefined;
}

function isTerminalTurnStatus(status: DialogTurn['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'error';
}

function getTurnFallbackStatus(turn: Pick<DialogTurn, 'error'>): DialogTurn['status'] {
  return turn.error ? 'error' : 'cancelled';
}

export function normalizeRecoveredTurnStatus(
  status: unknown,
  turn: Pick<DialogTurn, 'error'>,
): DialogTurn['status'] {
  if (status === 'completed' || status === 'cancelled' || status === 'error') {
    return status;
  }

  if (isTransientTurnStatus(status)) {
    return getTurnFallbackStatus(turn);
  }

  return getTurnFallbackStatus(turn);
}

export function normalizeRecoveredRoundStatus(
  status: unknown,
  parentTurnStatus: DialogTurn['status'],
): ModelRound['status'] {
  if (status === 'completed' || status === 'cancelled' || status === 'rejected' || status === 'error') {
    return status;
  }

  if (typeof status === 'string' && (TRANSIENT_ROUND_STATUSES.has(status) || TERMINAL_ROUND_STATUSES.has(status))) {
    if (parentTurnStatus === 'completed' || parentTurnStatus === 'error' || parentTurnStatus === 'cancelled') {
      return parentTurnStatus;
    }
  }

  return parentTurnStatus === 'completed' ? 'completed' : parentTurnStatus === 'error' ? 'error' : 'cancelled';
}

export function normalizeRecoveredTextStatus(
  status: unknown,
  parentTurnStatus: DialogTurn['status'],
): FlowTextItem['status'] {
  if (status === 'completed' || status === 'cancelled' || status === 'rejected' || status === 'error') {
    return status;
  }

  if (parentTurnStatus === 'completed') {
    return 'completed';
  }

  if (parentTurnStatus === 'error') {
    return 'error';
  }

  return 'cancelled';
}

export function normalizeRecoveredThinkingStatus(
  status: unknown,
  parentTurnStatus: DialogTurn['status'],
): FlowThinkingItem['status'] {
  if (status === 'completed' || status === 'cancelled' || status === 'rejected' || status === 'error') {
    return status;
  }

  if (parentTurnStatus === 'completed') {
    return 'completed';
  }

  if (parentTurnStatus === 'error') {
    return 'error';
  }

  return 'cancelled';
}

export function normalizeRecoveredToolStatus(
  status: unknown,
  parentTurnStatus: DialogTurn['status'],
  toolResult?: Pick<NonNullable<FlowToolItem['toolResult']>, 'success' | 'error'> | null,
): FlowToolItem['status'] {
  if (status === 'completed' || status === 'cancelled' || status === 'rejected' || status === 'error') {
    return status;
  }

  if (parentTurnStatus === 'cancelled') {
    return 'cancelled';
  }

  if (parentTurnStatus === 'error') {
    return toolResult?.success === false && toolResult.error ? 'error' : 'cancelled';
  }

  if (parentTurnStatus === 'completed') {
    if (toolResult?.success === false) {
      return 'error';
    }
    return 'completed';
  }

  if (typeof status === 'string' && (TRANSIENT_TOOL_STATUSES.has(status) || TERMINAL_TOOL_STATUSES.has(status))) {
    return 'cancelled';
  }

  if (toolResult?.success === false) {
    return 'error';
  }

  return 'cancelled';
}

function settleInterruptedItem(
  item: AnyFlowItem,
  finalTurnStatus: DialogTurn['status'],
  settledAt: number,
  options?: SettleInterruptedDialogTurnOptions,
): AnyFlowItem {
  if (item.type === 'text') {
    const nextStatus = TERMINAL_ITEM_STATUSES.has(item.status)
      ? item.status
      : normalizeRecoveredTextStatus(item.status, finalTurnStatus);
    return {
      ...item,
      status: nextStatus,
      isStreaming: false,
    };
  }

  if (item.type === 'thinking') {
    const nextStatus = TERMINAL_ITEM_STATUSES.has(item.status)
      ? item.status
      : normalizeRecoveredThinkingStatus(item.status, finalTurnStatus);
    return {
      ...item,
      status: nextStatus,
      isStreaming: false,
      isCollapsed: true,
    };
  }

  if (item.type === 'tool') {
    const wasTransient = isTransientToolStatus(item.status);
    const nextStatus = normalizeRecoveredToolStatus(
      item.status,
      finalTurnStatus,
      item.toolResult,
    );
    return {
      ...item,
      status: nextStatus,
      interruptionReason:
        options?.interruptionReason === 'app_restart' && wasTransient && nextStatus === 'cancelled'
          ? 'app_restart'
          : item.interruptionReason,
      isParamsStreaming: false,
      endTime: item.endTime ?? settledAt,
    };
  }

  return item;
}

export function settleInterruptedDialogTurn(
  dialogTurn: DialogTurn,
  settledAt: number,
  options?: SettleInterruptedDialogTurnOptions,
): DialogTurn {
  const finalTurnStatus = normalizeRecoveredTurnStatus(dialogTurn.status, dialogTurn);

  if (
    isTerminalTurnStatus(dialogTurn.status) &&
    dialogTurn.modelRounds.every(round =>
      TERMINAL_ROUND_STATUSES.has(round.status) &&
      round.items.every(item => STABLE_ITEM_STATUSES.has(item.status))
    )
  ) {
    return dialogTurn;
  }

  const settledTurn = {
    ...dialogTurn,
    status: finalTurnStatus,
    endTime: dialogTurn.endTime ?? settledAt,
    modelRounds: dialogTurn.modelRounds.map(round => {
      const finalRoundStatus = normalizeRecoveredRoundStatus(round.status, finalTurnStatus);
      const nextItems = round.items.map(item =>
        settleInterruptedItem(item, finalTurnStatus, settledAt, options),
      );
      const nextAttempts = round.attempts?.map(attempt => ({
        ...attempt,
        items: attempt.items.map(item =>
          settleInterruptedItem(item, finalTurnStatus, settledAt, options),
        ),
      }));

      return {
        ...round,
        status: finalRoundStatus,
        isStreaming: false,
        isComplete: true,
        endTime: round.endTime ?? settledAt,
        items: nextItems,
        attempts: nextAttempts,
      };
    }),
  };

  return settledTurn;
}

/**
 * Settle a live turn from an authoritative terminal snapshot. If a terminal
 * agent event already settled the turn, preserve that event-owned outcome and
 * return the original object once all nested content is stable.
 */
export function settleDialogTurnToTerminalStatus(
  dialogTurn: DialogTurn,
  requestedStatus: TerminalDialogTurnStatus,
  settledAt: number,
  error?: string,
  options?: { preserveTerminalOutcome?: boolean },
): DialogTurn {
  const alreadyTerminal = options?.preserveTerminalOutcome !== false
    && isTerminalTurnStatus(dialogTurn.status);
  const finalTurnStatus = alreadyTerminal ? dialogTurn.status : requestedStatus;
  const normalizedError = error?.trim() || undefined;
  const nextError = finalTurnStatus === 'error'
    ? normalizedError || dialogTurn.error
    : dialogTurn.error;
  const stableContent = dialogTurn.modelRounds.every(round =>
    !round.isStreaming && round.isComplete &&
    TERMINAL_ROUND_STATUSES.has(round.status) &&
    round.items.every(isStableTerminalItem) &&
    (round.attempts ?? []).every(attempt =>
      attempt.status !== 'streaming' &&
      attempt.items.every(isStableTerminalItem)
    )
  );

  if (
    alreadyTerminal &&
    stableContent &&
    dialogTurn.endTime !== undefined &&
    nextError === dialogTurn.error
  ) {
    return dialogTurn;
  }

  const attemptStatus = finalTurnStatus === 'completed'
    ? 'completed' as const
    : finalTurnStatus === 'error'
      ? 'failed' as const
      : 'cancelled' as const;
  const modelRounds = dialogTurn.modelRounds.map(round => {
    const finalRoundStatus = normalizeRecoveredRoundStatus(round.status, finalTurnStatus);
    return {
      ...round,
      status: finalRoundStatus,
      isStreaming: false,
      isComplete: true,
      endTime: round.endTime ?? settledAt,
      items: round.items.map(item =>
        settleInterruptedItem(item, finalTurnStatus, settledAt),
      ),
      attempts: round.attempts?.map(attempt => ({
        ...attempt,
        status: attempt.status === 'streaming' ? attemptStatus : attempt.status,
        items: attempt.items.map(item =>
          settleInterruptedItem(item, finalTurnStatus, settledAt),
        ),
      })),
    };
  });

  return {
    ...dialogTurn,
    status: finalTurnStatus,
    success: alreadyTerminal
      ? dialogTurn.success
      : finalTurnStatus === 'completed'
        ? true
        : finalTurnStatus === 'error'
          ? false
          : dialogTurn.success,
    error: nextError,
    endTime: dialogTurn.endTime ?? settledAt,
    modelRounds,
  };
}

function isStableTerminalItem(item: AnyFlowItem): boolean {
  if (!STABLE_ITEM_STATUSES.has(item.status)) return false;
  if (item.type === 'text' || item.type === 'thinking') return !item.isStreaming;
  if (item.type === 'tool') return !item.isParamsStreaming;
  return true;
}
