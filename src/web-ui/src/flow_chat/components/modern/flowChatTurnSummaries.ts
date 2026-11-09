import type { SessionTurnCatalog } from '@/shared/types/session-history';
import type { DialogTurn, Session } from '../../types/flow-chat';
import { createTurnOrdinalResolver, isProvisionalUsageReportTurn, validSessionTurnCatalog } from '../../utils/flowChatTurnIdentity';

export interface FlowChatTurnSummary {
  turnId: string;
  turnIndex: number;
  storageTurnIndex?: number;
}

interface TurnIdentity {
  id: string;
  storageTurnIndex?: number;
  provisional: boolean;
  excludedFromRendered: boolean;
}

function matchesTurn(identity: TurnIdentity, turn: DialogTurn): boolean {
  return identity.id === turn.id
    && identity.storageTurnIndex === (turn.storageTurnIndex ?? turn.backendTurnIndex)
    && identity.provisional === isProvisionalUsageReportTurn(turn)
    && identity.excludedFromRendered === (turn.userMessage?.metadata?.usageReportProvisional === true);
}

function turnIdentity(turn: DialogTurn): TurnIdentity {
  return {
    id: turn.id,
    storageTurnIndex: turn.storageTurnIndex ?? turn.backendTurnIndex,
    provisional: isProvisionalUsageReportTurn(turn),
    excludedFromRendered: turn.userMessage?.metadata?.usageReportProvisional === true,
  };
}

function matchesTurns(identities: TurnIdentity[], turns: DialogTurn[]): boolean {
  return identities.length === turns.length && identities.every((identity, index) => matchesTurn(identity, turns[index]));
}

type CatalogIdentity = Pick<SessionTurnCatalog['entries'][number], 'turnId' | 'ordinal' | 'storageTurnIndex'>;

interface SessionIdentity {
  sessionId: string;
  isPartial: boolean;
  totalTurnCount: number | undefined;
  catalogTotalTurnCount: number | undefined;
  turns: TurnIdentity[];
  catalog: CatalogIdentity[];
}

interface TurnSummaries {
  turnSummaries: FlowChatTurnSummary[];
  renderedTurnSummaries: FlowChatTurnSummary[];
  absoluteRenderedTurnSummaries: FlowChatTurnSummary[];
}

/** One reader's scalar metadata only; never retain streamed bodies or Sessions. */
export function createFlowChatTurnSummaryProjector() {
  let identity: SessionIdentity | undefined;
  let renderedIdentities: TurnIdentity[] = [];
  let renderedStartOrdinal: number | undefined;
  let ordinalById = new Map<string, number | undefined>();
  let result: TurnSummaries = {
    turnSummaries: [], renderedTurnSummaries: [], absoluteRenderedTurnSummaries: [],
  };

  return (session: Session | null | undefined, renderedTurns: DialogTurn[], startOrdinal?: number): TurnSummaries => {
    const catalog = session ? validSessionTurnCatalog(session) : undefined;
    const entries = catalog?.entries ?? [];
    // Text flushes replace Sessions and Turn arrays. Compare their small
    // identity fields without allocating summaries or rebuilding ordinal maps.
    const sessionChanged = session ? !identity
      || identity.sessionId !== session.sessionId
      || identity.isPartial !== (session.isPartial === true)
      || identity.totalTurnCount !== session.totalTurnCount
      || identity.catalogTotalTurnCount !== catalog?.totalTurnCount
      || !matchesTurns(identity.turns, session.dialogTurns)
      || identity.catalog.length !== entries.length
      || !identity.catalog.every((entry, index) => entry.turnId === entries[index].turnId
        && entry.ordinal === entries[index].ordinal
        && entry.storageTurnIndex === entries[index].storageTurnIndex)
      : identity !== undefined;
    let turnSummaries = result.turnSummaries;
    if (sessionChanged) {
      identity = session ? {
        sessionId: session.sessionId,
        isPartial: session.isPartial === true,
        totalTurnCount: session.totalTurnCount,
        catalogTotalTurnCount: catalog?.totalTurnCount,
        turns: session.dialogTurns.map(turnIdentity),
        catalog: entries.map(({ turnId, ordinal, storageTurnIndex }) => ({ turnId, ordinal, storageTurnIndex })),
      } : undefined;
      ordinalById = new Map();
      // Catalog-only history uses the first matching entry, just as the
      // single-Turn resolver does. Loaded identities take precedence below.
      for (const entry of entries) {
        if (entry.turnId !== undefined && !ordinalById.has(entry.turnId)) {
          ordinalById.set(entry.turnId, entry.ordinal);
        }
      }
      if (session) {
        const resolveOrdinal = createTurnOrdinalResolver(session);
        const seen = new Set<string>();
        session.dialogTurns.forEach((turn, index) => {
          if (seen.has(turn.id)) return;
          seen.add(turn.id);
          ordinalById.set(turn.id, resolveOrdinal(index));
        });
      }
      turnSummaries = [];
      for (const turn of identity?.turns ?? []) {
        if (turn.provisional) continue;
        turnSummaries.push({
          turnId: turn.id,
          turnIndex: (ordinalById.get(turn.id) ?? turnSummaries.length) + 1,
          storageTurnIndex: turn.storageTurnIndex,
        });
      }
    }

    const renderedChanged = !matchesTurns(renderedIdentities, renderedTurns);
    let renderedTurnSummaries = result.renderedTurnSummaries;
    if (renderedChanged) {
      renderedIdentities = renderedTurns.map(turnIdentity);
      renderedTurnSummaries = [];
      for (const turn of renderedIdentities) {
        if (turn.excludedFromRendered) continue;
        renderedTurnSummaries.push({
          turnId: turn.id,
          turnIndex: renderedTurnSummaries.length + 1,
          storageTurnIndex: turn.storageTurnIndex,
        });
      }
    }
    if (sessionChanged || renderedChanged || renderedStartOrdinal !== startOrdinal) {
      renderedStartOrdinal = startOrdinal;
      result = {
        turnSummaries,
        renderedTurnSummaries,
        absoluteRenderedTurnSummaries: renderedTurnSummaries.map((turn, index) => ({
          ...turn,
          turnIndex: startOrdinal !== undefined ? startOrdinal + index + 1
            : (ordinalById.get(turn.turnId) ?? turn.turnIndex - 1) + 1,
        })),
      };
    }
    return result;
  };
}
