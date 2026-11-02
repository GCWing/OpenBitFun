import type { DialogTurn, Session } from '../types/flow-chat';
import { createAbsoluteSessionTurnIndexResolver } from '../utils/flowChatTurnOrdinal';
import type { SessionTurnCatalog } from '@/shared/types/session-history';

export type TrajectoryKind = 'user' | 'model' | 'tool';
export interface TrajectoryNode {
  id: string;
  turnId: string;
  turnOrdinal: number;
  kind: TrajectoryKind;
  roundId?: string | null;
  focusItemId?: string | null;
  label: string;
  preview: string;
  status: string;
  timestamp: number;
  durationMs?: number | null;
  matched: boolean;
  matchField?: 'content' | 'name' | 'parameters' | 'result' | null;
}
export type TrajectoryPage = {
  status: 'ready'; catalogRevision: string; startOrdinal: number; endOrdinalExclusive: number;
  totalTurnCount: number; nodes: TrajectoryNode[]; nextNodeOffset: number | null;
} | { status: 'catalog' | 'stale' | 'not-found'; catalog: SessionTurnCatalog };

export const trajectoryNodeKey = (node: TrajectoryNode): string => JSON.stringify([node.turnId, node.kind, node.id]);
const preview = (value: string) => value.slice(0, 160);
const contains = (value: string | undefined, query: string) => !!query && !!value?.toLowerCase().includes(query);
/** Search values without serializing large tool output or image attachments. */
export function trajectoryValueMatches(value: unknown, query: string): boolean {
  if (!query || value === undefined || value === null) return false;
  if (typeof value === 'string') return contains(value, query);
  if (Array.isArray(value)) return value.some(item => trajectoryValueMatches(item, query));
  if (typeof value === 'object') return Object.entries(value).some(([key, child]) => contains(key, query) || trajectoryValueMatches(child, query));
  return contains(String(value), query);
}

export function projectTrajectoryTurn(turn: DialogTurn, ordinal: number, search = ''): TrajectoryNode[] {
  if (turn.kind === 'local_command') return [];
  const query = search.trim().toLowerCase();
  const base = { turnId: turn.id, turnOrdinal: ordinal };
  const nodes: TrajectoryNode[] = [{ ...base, kind: 'user', id: turn.userMessage.id,
    label: '', preview: preview(turn.userMessage.content), timestamp: turn.userMessage.timestamp,
    status: 'completed', matched: contains(turn.userMessage.content, query), matchField: 'content' }];
  for (const round of turn.modelRounds) {
    const texts = round.items.filter(item => item.type === 'text' || item.type === 'thinking');
    const hit = texts.find(item => contains(item.content, query));
    const preferred = texts.find(item => item.type === 'text' && item.content.trim()) ?? texts[0];
    const label = round.effectiveModelName ?? round.modelConfigId ?? '';
    nodes.push({ ...base, kind: 'model', id: round.id, roundId: round.id,
      focusItemId: hit?.id ?? preferred?.id ?? round.items.find(item => item.type === 'tool')?.id, label, preview: preview(hit?.content ?? preferred?.content ?? ''),
      timestamp: round.startTime, durationMs: round.durationMs, status: round.status,
      matched: !!hit || contains(label, query), matchField: hit ? 'content' : null });
    for (const item of round.items) {
      if (item.type === 'user-steering') {
        nodes.push({ ...base, kind: 'user', id: item.id, roundId: round.id, focusItemId: `user_steering_${item.steeringId}`,
          label: '', preview: preview(item.content), timestamp: item.timestamp, status: item.status,
          matched: contains(item.content, query), matchField: 'content' });
      }
      if (item.type !== 'tool') continue;
      const matchField = contains(item.toolName, query) ? 'name'
        : trajectoryValueMatches(item.toolCall.input, query) ? 'parameters'
        : trajectoryValueMatches(item.toolResult?.result, query) || contains(item.toolResult?.resultForAssistant, query)
          || contains(item.toolResult?.error, query) ? 'result' : null;
      nodes.push({ ...base, kind: 'tool', id: item.id, roundId: round.id, focusItemId: item.id,
        label: item.toolName, preview: '', timestamp: item.startTime ?? item.timestamp,
        durationMs: item.durationMs ?? item.toolResult?.duration_ms, status: item.status,
        matched: matchField !== null, matchField });
    }
  }
  return nodes;
}

export type TrajectoryProjectionCache = WeakMap<DialogTurn, { ordinal: number; query: string; nodes: TrajectoryNode[] }>;
export function projectLoadedTrajectory(session: Session, query: string, cache?: TrajectoryProjectionCache): TrajectoryNode[] {
  const ordinalForIndex = createAbsoluteSessionTurnIndexResolver(session);
  return session.dialogTurns.flatMap((turn, index) => {
    const ordinal = ordinalForIndex(index) - 1;
    const previous = cache?.get(turn);
    if (previous?.ordinal === ordinal && previous.query === query) return previous.nodes;
    const nodes = projectTrajectoryTurn(turn, ordinal, query);
    cache?.set(turn, { ordinal, query, nodes });
    return nodes;
  });
}

/** Loaded authoritative Turns replace persisted summaries, including removed attempts. */
export function mergeTrajectoryNodes(history: readonly TrajectoryNode[], live: readonly TrajectoryNode[]): TrajectoryNode[] {
  const liveTurns = new Set(live.map(node => node.turnId));
  const ordinals = new Map(history.map(node => [node.turnId, node.turnOrdinal]));
  const positioned = live.map(node => {
    const ordinal = ordinals.get(node.turnId);
    return ordinal === undefined || ordinal === node.turnOrdinal ? node : { ...node, turnOrdinal: ordinal };
  });
  return [...history.filter(node => !liveTurns.has(node.turnId)), ...positioned]
    .sort((a, b) => a.turnOrdinal - b.turnOrdinal);
}
