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
  override apply(record: SessionRecord): SessionRecordChange | null {
    return super.apply(record) as SessionRecordChange | null;
  }
  override snapshot(turnId: string): SessionRecordChange {
    return super.snapshot(turnId) as SessionRecordChange;
  }
}
