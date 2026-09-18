import { ChatMessage, ChatMessageItemResponse, RemoteToolStatusResponse, ImageAttachment } from '../model/RemoteModels';
import { HostSessionEvent } from './HostSessionStream';

interface UserMetadata { original_text?: string; images?: ImageAttachment[]; }
interface UserRecord { id: string; content: string; timestamp: number; metadata?: Object; }
interface TurnRecord { turnId: string; turnIndex: number; sessionId: string; timestamp: number; userMessage: UserRecord; status: string; error?: string; kind?: string; }
interface RoundRecord { id: string; turnId: string; roundIndex: number; timestamp: number; status: string; }
interface ToolCall { id: string; input: Object; }
interface ToolResult { result: Object; success: boolean; error?: string; durationMs?: number; }
interface ItemData {
  id: string; content?: string; timestamp?: number; orderIndex?: number;
  status?: string; isStreaming?: boolean; isSubagentItem?: boolean; parentTaskToolId?: string; subagentSessionId?: string;
  attemptId?: string; attemptIndex?: number; interruptionReason?: string;
  toolName?: string; toolCall?: ToolCall; toolResult?: ToolResult; startTime?: number; durationMs?: number;
}
interface ItemRecord { type: string; data: ItemData; }
export interface SessionRecord { sessionId: string; id: string; revision: number; deleted?: boolean; turn?: TurnRecord; round?: RoundRecord; item?: ItemRecord; }
interface StoredTurn { revision: number; data?: TurnRecord; authoritative?: boolean; }
interface StoredRound { revision: number; data?: RoundRecord; }
interface StoredItem { revision: number; turnId: string; roundId: string; data: ItemRecord; }

/** Lossless record storage follows Happy's stable-id message reduction. Mobile
 * presentation adapts the existing persisted turn schema; it does not define a
 * second wire DTO or overwrite newer parent state with an older child record. */
export class DurableSessionReducer {
  private records: Map<string, SessionRecord> = new Map();
  private tombstones: Map<string, number> = new Map();
  private turns: Map<string, StoredTurn> = new Map();
  private rounds: Map<string, StoredRound> = new Map();
  private items: Map<string, StoredItem> = new Map();
  apply(event: HostSessionEvent): boolean {
    if (event.event !== 'session-record') return false;
    const record = event.payload as SessionRecord;
    if (record.sessionId !== event.session_id || !record.id || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('Invalid session record identity');
    const previous = this.records.get(record.id);
    if (previous && previous.revision >= record.revision) return false;
    if (record.deleted) {
      if (!/^(turn|round|item)\/.+/.test(record.id)) throw new Error('Invalid session tombstone identity');
      this.records.set(record.id, record);
      this.tombstones.set(record.id, record.revision);
      if (record.id.startsWith('turn/')) {
        const id = record.id.slice(5); const previousTurn = this.turns.get(id);
        if (!previousTurn || previousTurn.revision < record.revision) this.turns.set(id, { revision: record.revision });
      } else if (record.id.startsWith('round/')) {
        const id = record.id.slice(6); const previousRound = this.rounds.get(id);
        if (!previousRound || previousRound.revision < record.revision) this.rounds.set(id, { revision: record.revision });
      } else if (record.id.startsWith('item/')) this.items.delete(record.id.slice(5));
      else throw new Error('Unknown session tombstone kind');
      return true;
    }
    const data = record.turn;
    if (!data || data.sessionId !== event.session_id) throw new Error('Session turn identity mismatch');
    const expectedId = record.item ? `item/${record.item.data.id}` : record.round ? `round/${record.round.id}` : `turn/${data.turnId}`;
    if (record.id !== expectedId) throw new Error('Session record key mismatch');
    if (record.round && record.round.turnId !== data.turnId) throw new Error('Session round parent mismatch');
    if (record.item && !record.round) throw new Error('Session item is missing its round');
    this.records.set(record.id, record);
    const turn = this.turns.get(data.turnId);
    // A round or item record repeats its parent turn so a partial page still
    // reads, but that copy is a header, not the turn's own state: the turn
    // record is what the user message and its attachment pixels come from, so a
    // header fills a turn it has never seen and never overwrites one.
    const header = !!record.round;
    if (!turn || (turn.revision < record.revision && !(header && turn.authoritative)))
      this.turns.set(data.turnId, { revision: record.revision, data: data, authoritative: !header });
    if (record.round) {
      const round = this.rounds.get(record.round.id);
      if (!round || round.revision < record.revision) this.rounds.set(record.round.id, { revision: record.revision, data: record.round });
    }
    if (record.item && record.round) {
      const item = this.items.get(record.item.data.id);
      if (!item || item.revision < record.revision) this.items.set(record.item.data.id,
        { revision: record.revision, turnId: data.turnId, roundId: record.round.id, data: record.item });
    }
    return true;
  }
  messages(): ChatMessage[] {
    const result: ChatMessage[] = [];
    const turns = Array.from(this.turns.values()).filter((turn: StoredTurn) => !!turn.data).sort((a: StoredTurn, b: StoredTurn) => (a.data?.turnIndex || 0) - (b.data?.turnIndex || 0));
    // Grouping the items under their turn once keeps a rebuild linear in the
    // session's length. Scanning the whole item map again for every turn made a
    // long session pay for its own length twice over, on the thread that draws
    // it, which is where the scrolling went.
    const byTurn: Map<string, StoredItem[]> = new Map<string, StoredItem[]>();
    this.items.forEach((item: StoredItem) => {
      const bucket = byTurn.get(item.turnId);
      if (bucket) bucket.push(item); else byTurn.set(item.turnId, [item]);
    });
    for (const stored of turns) {
      const turn = stored.data;
      if (!turn) continue;
      if (turn.kind === 'local_command') continue;
      const metadata = turn.userMessage.metadata as UserMetadata | undefined;
      const userText = metadata?.original_text || turn.userMessage.content;
      if (userText.length > 0 || (metadata?.images?.length || 0) > 0) result.push({ id: turn.userMessage.id, turnId: turn.turnId,
        role: 'user', text: userText, images: metadata?.images, status: 'sent', timestamp: new Date(turn.userMessage.timestamp).toISOString() });
      const turnFence = this.tombstones.get(`turn/${turn.turnId}`) ?? 0;
      const entries = (byTurn.get(turn.turnId) ?? []).filter((item: StoredItem) => {
        const round = this.rounds.get(item.roundId);
        const roundFence = Math.max(turnFence, this.tombstones.get(`round/${item.roundId}`) ?? 0);
        return !!round?.data && round.revision > roundFence &&
          item.revision > Math.max(roundFence, this.tombstones.get(`item/${item.data.data.id}`) ?? 0);
      })
        .sort((a: StoredItem, b: StoredItem) => {
          const roundA = this.rounds.get(a.roundId)?.data?.roundIndex || 0;
          const roundB = this.rounds.get(b.roundId)?.data?.roundIndex || 0;
          return roundA - roundB || (a.data.data.orderIndex ?? a.data.data.timestamp ?? 0) -
            (b.data.data.orderIndex ?? b.data.data.timestamp ?? 0) || a.data.data.id.localeCompare(b.data.data.id);
        });
      const items: ChatMessageItemResponse[] = [];
      const tools: RemoteToolStatusResponse[] = [];
      for (const entry of entries) {
        const data = entry.data.data;
        if (data.status === 'superseded' || data.status === 'retry_superseded') continue;
        const round = this.rounds.get(entry.roundId)?.data?.roundIndex || 0;
        const item: ChatMessageItemResponse = { type: entry.data.type, content: data.content, round_index: round, is_subagent: data.isSubagentItem === true || !!data.subagentSessionId };
        if (entry.data.type === 'tool') {
          const tool: RemoteToolStatusResponse = { id: data.toolCall?.id || data.id, name: data.toolName, status: data.status || (data.toolResult ? (data.toolResult.success ? 'completed' : 'failed') : 'running'),
            tool_input: data.toolCall?.input, tool_output: data.toolResult?.result,
            duration_ms: data.durationMs ?? data.toolResult?.durationMs, error_preview: data.toolResult?.error, start_ms: data.startTime };
          item.tool = tool; tools.push(tool);
        }
        items.push(item);
      }
      const status = turn.status === 'inprogress' ? 'active' : turn.status === 'error' ? 'failed' : turn.status;
      result.push({ id: `assistant-${turn.turnId}`, turnId: turn.turnId, role: 'assistant', status: status,
        text: items.filter((item: ChatMessageItemResponse) => item.type === 'text' && !item.is_subagent).map((item: ChatMessageItemResponse) => item.content || '').join(''),
        thinking: items.filter((item: ChatMessageItemResponse) => item.type === 'thinking' && !item.is_subagent).map((item: ChatMessageItemResponse) => item.content || '').join(''),
        tools: tools, items: items, timestamp: new Date(turn.timestamp).toISOString(), error: turn.error, renderVersion: stored.revision });
    }
    return result;
  }
}
