/** Stable structural record contract; extra runtime fields survive spread/materialization. */
export interface TextItemData { id: string; orderIndex?: number; }
export interface ThinkingItemData { id: string; orderIndex?: number; }
export interface ToolItemData { id: string; orderIndex?: number; }
export interface ModelRoundData { id: string; turnId: string; roundIndex: number; textItems: TextItemData[]; thinkingItems?: ThinkingItemData[]; toolItems: ToolItemData[]; }
export interface DialogTurnData { turnId: string; sessionId: string; modelRounds: ModelRoundData[]; }

export interface SessionRecordUpsert {
  sessionId: string;
  id: string;
  revision: number;
  deleted?: false;
  turn: Omit<DialogTurnData, 'modelRounds'>;
  round?: Omit<ModelRoundData, 'textItems' | 'thinkingItems' | 'toolItems'>;
  item?: { type: 'text'; data: TextItemData }
    | { type: 'thinking'; data: ThinkingItemData }
    | { type: 'tool'; data: ToolItemData };
}
export type SessionRecord = SessionRecordUpsert | { sessionId: string; id: string; revision: number; deleted: true };
export interface SessionRecordChange { turnId: string; turn: DialogTurnData | null; }

type Versioned<T> = { revision: number; value: T };
type RoundEntry = {
  header: Versioned<NonNullable<SessionRecordUpsert['round']>>;
  items: Map<string, Versioned<NonNullable<SessionRecordUpsert['item']>>>;
};
type TurnEntry = {
  header: Versioned<SessionRecordUpsert['turn']>;
  rounds: Map<string, RoundEntry>;
};

/**
 * Live and fetched records enter the same reducer, as in Happy's message map.
 * Runtime revisions also make newest-first history safe for mutable blocks.
 * This instance belongs to one (device surface, session), never a global ID.
 */
export class SessionRecordReplica {
  private readonly records = new Map<string, number>();
  private readonly turns = new Map<string, TurnEntry>();
  private readonly deleted = new Map<string, number>();

  constructor(readonly sessionId: string) {}

  apply(record: SessionRecord): SessionRecordChange | null {
    const turnId = this.ingest(record);
    return turnId === null ? null : this.snapshot(turnId);
  }

  /**
   * Reduce one record and report the turn it changed, without materializing it.
   * Materializing is O(items in turn), so a consumer replaying a long turn one
   * record at a time ingests them all and then takes one snapshot per turn.
   */
  ingest(record: SessionRecord): string | null {
    if (record.sessionId !== this.sessionId || (!record.deleted && record.turn.sessionId !== this.sessionId)) {
      throw new Error('Session record belongs to another session');
    }
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
      throw new Error('Invalid session record revision');
    }
    if ((this.records.get(record.id) ?? 0) >= record.revision) return null;
    if (record.deleted) {
      if (!/^(turn|round|item)\/.+/.test(record.id)) throw new Error('Invalid session record identity');
      this.records.set(record.id, record.revision);
      this.deleted.set(record.id, record.revision);
      for (const [turnId, turn] of this.turns) {
        if (record.id === `turn/${turnId}` || [...turn.rounds.entries()].some(([roundId, round]) => (
          record.id === `round/${roundId}` || [...round.items.keys()].some(itemId => record.id === `item/${itemId}`)
        ))) return turnId;
      }
      return record.id.startsWith('turn/') ? record.id.slice(5) : null;
    }
    const turnId = record.turn.turnId;
    if (!turnId || (record.round && record.round.turnId !== turnId) || (record.item && !record.round)) {
      throw new Error('Invalid session record ancestry');
    }
    const expectedId = record.item ? `item/${record.item.data.id}`
      : record.round ? `round/${record.round.id}` : `turn/${turnId}`;
    if (record.id !== expectedId) throw new Error('Invalid session record identity');

    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { header: { revision: record.revision, value: record.turn }, rounds: new Map() };
      this.turns.set(turnId, turn);
    } else if (record.revision > turn.header.revision) {
      turn.header = { revision: record.revision, value: record.turn };
    }
    if (record.round) {
      let round = turn.rounds.get(record.round.id);
      if (!round) {
        round = { header: { revision: record.revision, value: record.round }, items: new Map() };
        turn.rounds.set(record.round.id, round);
      } else if (record.revision > round.header.revision) {
        round.header = { revision: record.revision, value: record.round };
      }
      if (record.item) {
        const existing = round.items.get(record.item.data.id);
        if (!existing || existing.revision < record.revision) {
          round.items.set(record.item.data.id, { revision: record.revision, value: record.item });
        }
      }
    }
    this.records.set(record.id, record.revision);
    return turnId;
  }

  /** The turn's current state; `turn` is null once it was tombstoned or never seen. */
  snapshot(turnId: string): SessionRecordChange {
    const turn = this.turns.get(turnId);
    return { turnId, turn: !turn || turn.header.revision <= (this.deleted.get(`turn/${turnId}`) ?? 0)
      ? null : this.materialize(turnId, turn) };
  }

  private materialize(turnId: string, turn: TurnEntry): DialogTurnData {
    const turnFence = this.deleted.get(`turn/${turnId}`) ?? 0;
    return {
      ...turn.header.value,
      modelRounds: [...turn.rounds.values()].filter(round => round.header.revision > Math.max(turnFence, this.deleted.get(`round/${round.header.value.id}`) ?? 0)).map(round => {
        const roundFence = Math.max(turnFence, this.deleted.get(`round/${round.header.value.id}`) ?? 0);
        const result: ModelRoundData = { ...round.header.value, textItems: [], thinkingItems: [], toolItems: [] };
        for (const { value: item, revision } of round.items.values()) {
          if (revision <= Math.max(roundFence, this.deleted.get(`item/${item.data.id}`) ?? 0)) continue;
          if (item.type === 'text') result.textItems.push(item.data);
          else if (item.type === 'thinking') result.thinkingItems!.push(item.data);
          else result.toolItems.push(item.data);
        }
        const order = (a: { orderIndex?: number }, b: { orderIndex?: number }): number => (a.orderIndex ?? 0) - (b.orderIndex ?? 0);
        result.textItems.sort(order);
        result.thinkingItems!.sort(order);
        result.toolItems.sort(order);
        return result;
      }).sort((a, b) => a.roundIndex - b.roundIndex),
    };
  }
}
