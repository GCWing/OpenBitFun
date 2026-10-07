import type { DialogTurn, FlowChatState, FlowItem, ModelRound, Session } from '../types/flow-chat';

export interface SubagentProjectionTarget {
  parentSessionId?: string;
  parentToolIds: Set<string>;
  directSubagentSessionId?: string;
  directSubagentDialogTurnId?: string;
}

export interface SubagentProjectionState {
  session: Session | null;
  turn: DialogTurn | null;
  round: ModelRound | null;
  items: FlowItem[];
  isRunning: boolean;
}

export interface SubagentProjectionOptions {
  itemsMode?: 'full-turn' | 'last-round';
}

const ACTIVE_TURN_STATUSES = new Set<DialogTurn['status']>([
  'pending',
  'image_analyzing',
  'processing',
  'finishing',
  'cancelling',
]);

export type SubagentExecutionStatus = 'running' | 'completed' | 'error' | 'cancelled';

export function deriveSubagentExecutionStatus(
  turn: DialogTurn | null | undefined,
): SubagentExecutionStatus | null {
  if (!turn) {
    return null;
  }
  if (ACTIVE_TURN_STATUSES.has(turn.status) || turn.modelRounds?.some(round => round.isStreaming)) {
    return 'running';
  }
  switch (turn.status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function isActiveTurn(turn: DialogTurn | null | undefined): boolean {
  if (!turn) {
    return false;
  }

  return deriveSubagentExecutionStatus(turn) === 'running';
}

function flattenTurnItems(turn: DialogTurn | null): FlowItem[] {
  if (!turn) {
    return [];
  }

  return turn.modelRounds.flatMap(round => round.items);
}

function pickProjectedRound(turn: DialogTurn | null): ModelRound | null {
  if (!turn || turn.modelRounds.length === 0) {
    return null;
  }

  return turn.modelRounds[turn.modelRounds.length - 1] ?? null;
}

function flattenRoundItems(round: ModelRound | null): FlowItem[] {
  if (!round) {
    return [];
  }

  return round.items;
}

function pickProjectedTurn(session: Session | null, directDialogTurnId?: string): DialogTurn | null {
  if (!session || session.dialogTurns.length === 0) {
    return null;
  }

  if (directDialogTurnId) {
    const directTurn = session.dialogTurns.find(turn => turn.id === directDialogTurnId);
    if (directTurn) {
      return directTurn;
    }
  }

  for (let index = session.dialogTurns.length - 1; index >= 0; index -= 1) {
    const turn = session.dialogTurns[index];
    if (isActiveTurn(turn)) {
      return turn;
    }
  }

  return session.dialogTurns[session.dialogTurns.length - 1] ?? null;
}

function rankSession(session: Session): number {
  return session.lastActiveAt || session.updatedAt || session.createdAt || 0;
}

export function findProjectedSession(
  state: Pick<FlowChatState, 'sessions'>,
  target: SubagentProjectionTarget,
): Session | null {
  const { directSubagentSessionId, parentSessionId, parentToolIds } = target;

  if (directSubagentSessionId) {
    const directSession = state.sessions.get(directSubagentSessionId);
    if (directSession) {
      return directSession;
    }
  }

  if (!parentSessionId || parentToolIds.size === 0) {
    return null;
  }

  let bestMatch: Session | null = null;

  for (const session of state.sessions.values()) {
    if (session.sessionKind !== 'subagent') {
      continue;
    }
    if (session.parentSessionId !== parentSessionId) {
      continue;
    }
    if (!session.parentToolCallId || !parentToolIds.has(session.parentToolCallId)) {
      continue;
    }

    if (!bestMatch) {
      bestMatch = session;
      continue;
    }

    const bestTurn = pickProjectedTurn(bestMatch);
    const nextTurn = pickProjectedTurn(session);
    const bestIsActive = isActiveTurn(bestTurn);
    const nextIsActive = isActiveTurn(nextTurn);

    if (nextIsActive && !bestIsActive) {
      bestMatch = session;
      continue;
    }
    if (nextIsActive === bestIsActive && rankSession(session) > rankSession(bestMatch)) {
      bestMatch = session;
    }
  }

  return bestMatch;
}

export function getSubagentProjectionState(
  state: FlowChatState,
  target: SubagentProjectionTarget,
  options: SubagentProjectionOptions = {},
): SubagentProjectionState {
  const session = findProjectedSession(state, target);
  const turn = pickProjectedTurn(session, target.directSubagentDialogTurnId);
  const round = pickProjectedRound(turn);
  const itemsMode = options.itemsMode ?? 'full-turn';
  const items = itemsMode === 'last-round'
    ? flattenRoundItems(round)
    : flattenTurnItems(turn);

  return {
    session,
    turn,
    round,
    items,
    isRunning: isActiveTurn(turn),
  };
}
