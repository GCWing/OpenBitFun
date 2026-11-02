import { trajectoryNodeKey, type TrajectoryNode } from './trajectoryModel';

export interface TrajectoryRange { anchor: string; focus: string }
export interface TrajectoryRangeSummary {
  start: TrajectoryNode; end: TrajectoryNode;
  counts: { user: number; model: number; tool: number; errors: number };
  modelMs?: number; toolMs?: number;
}
/** Endpoints use stable identities so loading older pages cannot move a range. */
export function resolveTrajectoryRange(nodes: readonly TrajectoryNode[], range: TrajectoryRange | null): [number, number] | null {
  if (!range) return null;
  const anchor = nodes.findIndex(node => trajectoryNodeKey(node) === range.anchor);
  const focus = nodes.findIndex(node => trajectoryNodeKey(node) === range.focus);
  return anchor < 0 || focus < 0 ? null : [Math.min(anchor, focus), Math.max(anchor, focus)];
}
export function summarizeTrajectoryRange(nodes: readonly TrajectoryNode[], bounds: [number, number]): TrajectoryRangeSummary {
  const selected = nodes.slice(bounds[0], bounds[1] + 1);
  const sum = (kind: 'model' | 'tool') => {
    const values = selected.filter(node => node.kind === kind);
    return values.length && values.every(node => typeof node.durationMs === 'number')
      ? values.reduce((sum, node) => sum + node.durationMs!, 0) : undefined;
  };
  return { start: selected[0], end: selected[selected.length - 1],
    counts: { user: selected.filter(node => node.kind === 'user').length,
      model: selected.filter(node => node.kind === 'model').length, tool: selected.filter(node => node.kind === 'tool').length,
      errors: selected.filter(node => node.status === 'error').length }, modelMs: sum('model'), toolMs: sum('tool') };
}
