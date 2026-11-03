import { SessionRecordReplica as SharedReplica } from '../../../../shared/relay-transport/SessionRecordReplica';
import type { DialogTurnData, ModelRoundData, TextItemData, ThinkingItemData, ToolItemData } from '@/shared/types/session-history';
export interface SessionRecordUpsert {
  sessionId: string; id: string; revision: number; deleted?: false;
  turn: Omit<DialogTurnData, 'modelRounds'>;
  round?: Omit<ModelRoundData, 'textItems' | 'thinkingItems' | 'toolItems'>;
  item?: {type:'text';data:TextItemData}|{type:'thinking';data:ThinkingItemData}|{type:'tool';data:ToolItemData};
}
export type SessionRecord = SessionRecordUpsert | {sessionId:string;id:string;revision:number;deleted:true};
export interface SessionRecordChange {turnId:string;turn:DialogTurnData|null}
/** Web UI presentation types wrap the shared lossless record reducer. */
export class SessionRecordReplica extends SharedReplica {
  // A rollback ACK is authoritative even before its stream reset/tombstones
  // arrive. Keep that fence with this replica, never with a global Session ID
  // or an invented record revision. A new host epoch creates a fresh replica.
  private readonly retiredTurns = new Set<string>();
  private readonly tombstonedTurns = new Set<string>();

  retireTurns(turnIds: readonly string[]): void {
    turnIds.forEach(turnId => {
      // The stream's tombstone may beat the RPC receipt.
      if (!this.tombstonedTurns.has(turnId)) this.retiredTurns.add(turnId);
    });
  }

  override ingest(record: SessionRecord): string | null {
    if (
      !record.deleted && record.sessionId === this.sessionId
      && record.turn.sessionId === this.sessionId && this.retiredTurns.has(record.turn.turnId)
    ) return null;
    const turnId = super.ingest(record);
    if (record.deleted && turnId !== null && record.id === `turn/${turnId}`
      && super.snapshot(turnId).turn === null) {
      // Once the host supplies a real tombstone its revision owns the fence.
      // Newer authoritative upserts (redo) may then restore the same identity.
      this.retiredTurns.delete(turnId);
      this.tombstonedTurns.add(turnId);
    } else if (turnId !== null && this.tombstonedTurns.has(turnId)
      && super.snapshot(turnId).turn !== null) {
      this.tombstonedTurns.delete(turnId);
    }
    return turnId;
  }

  override apply(record: SessionRecord): SessionRecordChange | null {
    return super.apply(record) as SessionRecordChange | null;
  }
  override snapshot(turnId: string): SessionRecordChange {
    if (this.retiredTurns.has(turnId)) return { turnId, turn: null };
    return super.snapshot(turnId) as SessionRecordChange;
  }
}
