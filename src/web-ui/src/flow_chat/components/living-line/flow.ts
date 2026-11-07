import type { Point } from './geometry';

type ArcTable = { points: readonly Point[]; lengths: number[]; total: number };

function arcTable(points: readonly Point[]): ArcTable {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return { points, lengths, total: lengths[lengths.length - 1] };
}

function atDistance(table: ArcTable, distance: number): Point {
  let i = 1;
  while (i < table.lengths.length - 1 && table.lengths[i] < distance) i++;
  const span = table.lengths[i] - table.lengths[i - 1];
  const t = span ? (distance - table.lengths[i - 1]) / span : 0;
  const a = table.points[i - 1];
  const b = table.points[i];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function polylineLength(points: readonly Point[]): number {
  return arcTable(points).total;
}

export function approachFlowOpacity(current: number, active: boolean, deltaSeconds: number, fadeSeconds = 0.32): number {
  const amount = 1 - Math.exp(-Math.max(0, deltaSeconds) / Math.max(0.001, fadeSeconds));
  return current + ((active ? 1 : 0) - current) * amount;
}

/** progress moves the hotspot head through the path, then leaves a full hotspot-length gap before re-entering. */
export function sliceFlowHighlight(points: readonly Point[], progress: number, hotspotLength: number): readonly Point[] {
  const table = arcTable(points);
  if (table.total <= 0 || points.length < 2 || hotspotLength <= 0) return [];
  const head = ((progress % 1) + 1) % 1 * (table.total + hotspotLength * 2);
  if (head <= 0 || head >= table.total + hotspotLength) return [];
  const start = Math.max(0, head - hotspotLength);
  const end = Math.min(table.total, head);
  if (end <= start) return [];
  const slice = [atDistance(table, start)];
  for (let i = 1; i < table.lengths.length - 1; i++) {
    if (table.lengths[i] > start && table.lengths[i] < end) slice.push(table.points[i]);
  }
  slice.push(atDistance(table, end));
  return slice;
}
