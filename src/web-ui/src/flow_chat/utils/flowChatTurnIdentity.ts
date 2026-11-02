import type {
  LocalCommandMetadata,
  SessionTurnCatalog,
} from '@/shared/types/session-history';
import type {
  DialogTurn,
  DialogTurnIdentity,
  LocalTurnIndex,
  Session,
  SessionHistoryViewState,
  StorageTurnIndex,
  TurnOrdinal,
} from '../types/flow-chat';

type TurnIdentitySession = Pick<
  Session,
  'sessionId' | 'dialogTurns' | 'isPartial' | 'totalTurnCount' | 'turnCatalog'
>;

export function asLocalTurnIndex(value: number): LocalTurnIndex {
  return value as LocalTurnIndex;
}

export function asTurnOrdinal(value: number): TurnOrdinal {
  return value as TurnOrdinal;
}

export function asStorageTurnIndex(value: number): StorageTurnIndex {
  return value as StorageTurnIndex;
}

export function isProvisionalUsageReportTurn(turn: DialogTurn): boolean {
  const metadata = turn.userMessage?.metadata as LocalCommandMetadata | undefined;
  return metadata?.localCommandKind === 'usage_report'
    && metadata.usageReportProvisional === true;
}

export function canonicalSessionTurns(
  session: Pick<TurnIdentitySession, 'dialogTurns'>,
): DialogTurn[] {
  return session.dialogTurns.filter(turn => !isProvisionalUsageReportTurn(turn));
}

/** Maintenance and local commands do not replace a user execution's result. */
export function lastUserDialogTurn(session: Pick<Session, 'dialogTurns'> | undefined): DialogTurn | undefined {
  const turns = session?.dialogTurns;
  if (!turns) return undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn.kind || turn.kind === 'user_dialog') return turn;
  }
  return undefined;
}

export function validSessionTurnCatalog(session: TurnIdentitySession) {
  return session.turnCatalog?.sessionId === session.sessionId
    ? session.turnCatalog
    : undefined;
}

export interface MaterializedSessionTurnIdentity {
  turn?: DialogTurn;
  catalog?: SessionTurnCatalog;
  ordinal?: TurnOrdinal;
  storageTurnIndex?: StorageTurnIndex;
}

/**
 * Resolve a stable Turn identity from either the canonical live tail or an
 * already-materialized history window. A catalog-only result remains valid
 * if the rendered range was pruned while a confirmation dialog was open.
 */
export function resolveMaterializedSessionTurnIdentity(
  session: TurnIdentitySession,
  historyView: Pick<SessionHistoryViewState, 'catalog' | 'loadedRanges'> | undefined,
  turnId: string,
): MaterializedSessionTurnIdentity | undefined {
  const canonicalTurn = session.dialogTurns.find(candidate => candidate.id === turnId);
  const materializedRange = canonicalTurn
    ? undefined
    : historyView?.loadedRanges.find(range =>
      range.turns.some(candidate => candidate.id === turnId));
  const materializedTurnIndex = materializedRange?.turns.findIndex(
    candidate => candidate.id === turnId,
  ) ?? -1;
  const turn = canonicalTurn
    ?? (materializedTurnIndex >= 0 ? materializedRange?.turns[materializedTurnIndex] : undefined);
  const catalogs = [validSessionTurnCatalog(session), historyView?.catalog]
    .filter((catalog): catalog is SessionTurnCatalog => catalog?.sessionId === session.sessionId);
  const catalog = catalogs.find(candidate => candidate.entries.some(entry => entry.turnId === turnId));
  const entry = catalog?.entries.find(candidate => candidate.turnId === turnId);
  if (!turn && !entry) {
    return undefined;
  }
  const directStorageTurnIndex = turn?.storageTurnIndex ?? turn?.backendTurnIndex;
  return {
    turn,
    catalog,
    ordinal: entry
      ? asTurnOrdinal(entry.ordinal)
      : materializedRange && materializedTurnIndex >= 0
        ? asTurnOrdinal(materializedRange.startOrdinal + materializedTurnIndex)
        : undefined,
    storageTurnIndex: directStorageTurnIndex !== undefined
      ? asStorageTurnIndex(directStorageTurnIndex)
      : entry
        ? asStorageTurnIndex(entry.storageTurnIndex)
        : undefined,
  };
}

export function projectedSessionTurnCount(session: TurnIdentitySession): number {
  const persistedTurnCount = canonicalSessionTurns(session).length;
  return Math.max(
    session.totalTurnCount ?? 0,
    validSessionTurnCatalog(session)?.totalTurnCount ?? 0,
    persistedTurnCount,
  );
}

/** True only when the complete projected Session has no persisted Turn. */
export function isProjectedSessionEmpty(session: TurnIdentitySession): boolean {
  return projectedSessionTurnCount(session) === 0;
}

/** First runtime Turn, including the optimistic Turn already appended locally. */
export function isProjectedFirstRuntimeTurn(session: TurnIdentitySession): boolean {
  return projectedSessionTurnCount(session) <= 1;
}

export function resolveStorageTurnIndex(
  session: TurnIdentitySession,
  turnOrId: DialogTurn | string,
): StorageTurnIndex | undefined {
  const turn = typeof turnOrId === 'string'
    ? session.dialogTurns.find(candidate => candidate.id === turnOrId)
    : turnOrId;
  const directStorageIndex = turn?.storageTurnIndex ?? turn?.backendTurnIndex;
  if (directStorageIndex !== undefined) {
    return asStorageTurnIndex(directStorageIndex);
  }

  const turnId = typeof turnOrId === 'string' ? turnOrId : turnOrId.id;
  const catalogEntry = validSessionTurnCatalog(session)?.entries.find(
    entry => entry.turnId === turnId,
  );
  return catalogEntry
    ? asStorageTurnIndex(catalogEntry.storageTurnIndex)
    : undefined;
}

/**
 * Storage slot for the next Turn of a Session the frontend persists itself.
 *
 * The local runtime hands out that slot through `DialogTurnStarted`, but an
 * ACP agent runs outside it: nothing on the backend counts those Turns, so the
 * projection allocates the slot from what it already knows. Returns undefined
 * when the Session has persisted Turns none of which are projected yet —
 * guessing there would overwrite history.
 */
export function nextStorageTurnIndex(
  session: TurnIdentitySession,
): StorageTurnIndex | undefined {
  let highest = -1;
  for (const turn of session.dialogTurns) {
    const storageIndex = turn.storageTurnIndex ?? turn.backendTurnIndex;
    if (typeof storageIndex === 'number') {
      highest = Math.max(highest, storageIndex);
    }
  }
  for (const entry of validSessionTurnCatalog(session)?.entries ?? []) {
    highest = Math.max(highest, entry.storageTurnIndex);
  }

  if (highest < 0 && projectedSessionTurnCount(session) > 0) {
    return undefined;
  }
  return asStorageTurnIndex(highest + 1);
}

function buildCatalogOrdinalMaps(session: TurnIdentitySession): {
  ordinalByTurnId: Map<string, TurnOrdinal>;
  ordinalByStorageIndex: Map<number, TurnOrdinal>;
} {
  const ordinalByTurnId = new Map<string, TurnOrdinal>();
  const ordinalByStorageIndex = new Map<number, TurnOrdinal>();
  for (const entry of validSessionTurnCatalog(session)?.entries ?? []) {
    const ordinal = asTurnOrdinal(entry.ordinal);
    if (entry.turnId) {
      ordinalByTurnId.set(entry.turnId, ordinal);
    }
    ordinalByStorageIndex.set(entry.storageTurnIndex, ordinal);
  }
  return { ordinalByTurnId, ordinalByStorageIndex };
}

export function createTurnOrdinalResolver(
  session: TurnIdentitySession,
): (localIndex: LocalTurnIndex | number) => TurnOrdinal | undefined {
  const { ordinalByTurnId, ordinalByStorageIndex } = buildCatalogOrdinalMaps(session);
  const canonicalTurns = canonicalSessionTurns(session);
  const fallbackStartOrdinal = session.isPartial === true
    ? Math.max(0, projectedSessionTurnCount(session) - canonicalTurns.length)
    : 0;
  const fallbackOrdinalByTurnId = new Map<string, TurnOrdinal>();
  canonicalTurns.forEach((turn, index) => {
    fallbackOrdinalByTurnId.set(turn.id, asTurnOrdinal(fallbackStartOrdinal + index));
  });

  return (localIndex): TurnOrdinal | undefined => {
    const turn = session.dialogTurns[localIndex];
    if (!turn || isProvisionalUsageReportTurn(turn)) {
      return undefined;
    }

    const storageTurnIndex = resolveStorageTurnIndex(session, turn);
    return ordinalByTurnId.get(turn.id)
      ?? (storageTurnIndex !== undefined
        ? ordinalByStorageIndex.get(storageTurnIndex)
        : undefined)
      ?? fallbackOrdinalByTurnId.get(turn.id);
  };
}

export function resolveTurnOrdinal(
  session: TurnIdentitySession,
  turnOrId: DialogTurn | string,
): TurnOrdinal | undefined {
  const turnId = typeof turnOrId === 'string' ? turnOrId : turnOrId.id;
  const localIndex = session.dialogTurns.findIndex(turn => turn.id === turnId);
  if (localIndex < 0) {
    const catalogEntry = validSessionTurnCatalog(session)?.entries.find(
      entry => entry.turnId === turnId,
    );
    return catalogEntry ? asTurnOrdinal(catalogEntry.ordinal) : undefined;
  }
  return createTurnOrdinalResolver(session)(asLocalTurnIndex(localIndex));
}

export function resolveDialogTurnIdentity(
  session: TurnIdentitySession,
  turnOrId: DialogTurn | string,
): DialogTurnIdentity | undefined {
  const ordinal = resolveTurnOrdinal(session, turnOrId);
  if (ordinal === undefined) {
    return undefined;
  }
  const storageTurnIndex = resolveStorageTurnIndex(session, turnOrId);
  return {
    ordinal,
    storageTurnIndex,
    state: storageTurnIndex === undefined ? 'optimistic' : 'persisted',
  };
}
