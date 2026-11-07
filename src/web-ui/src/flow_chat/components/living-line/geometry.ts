export type Point = Readonly<{ x: number; y: number }>;
export type LivingState = 'idle' | 'working' | 'question' | 'error';
type FlatPoint = { x: number; y: number };

// Path data is transcribed from the locally approved v0.4 SVG masters; cubic curves are flattened only for animation.
export const SOURCE_PATHS: Record<LivingState, string> = {
  idle: 'M60.5,84L195.5,84',
  working: 'M60.5,84L76,84L83,80L90,84L103,84L109,89L116,58L123,95L130,84L148,84L159,79L170,84L195.5,84',
  question: 'M60.5,84C81.60009765625,84,102.7001953125,84,123.7998046875,84C123.7998046875,81,123.7998046875,78,123.7998046875,75C123.7998046875,69,127.2998046875,66,132.89990234375,63C138.5,60,141.2998046875,57,141.2998046875,53.25C141.2998046875,47.25,135.7001953125,42.75,128.7001953125,42.75C121,42.75,115.39990234375,47.25,115.39990234375,54C115.39990234375,55.5,115.39990234375,57,115.39990234375,57C113.2998046875,57,110.5,57,108.39990234375,57C108.39990234375,56.25,108.39990234375,54.75,108.39990234375,54C108.39990234375,42.75,116.7998046875,35.25,128.7001953125,35.25C140.60009765625,35.25,149,42.75,149,53.25C149,61.5,144.7998046875,66,137.7998046875,69.75C133.60009765625,72,132.2001953125,74.25,132.2001953125,77.25C132.2001953125,79.5,132.2001953125,81.75,132.2001953125,84C153.2998046875,84,174.39990234375,84,195.5,84',
  error: 'M60.5,84C81.40009765625,84,102.3001953125,84,123.2001953125,84C123.2001953125,72,122.2998046875,61,121.7001953125,51C121.10009765625,44,122.2998046875,36,128,36C133.7001953125,36,134.89990234375,44,134.2998046875,51C133.7001953125,61,132.7998046875,72,132.7998046875,84C153.7001953125,84,174.60009765625,84,195.5,84',
};

function flattenPath(path: string): FlatPoint[] {
  const tokens = path.match(/[MLC]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const points: FlatPoint[] = [];
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M' || command === 'L') {
      points.push({ x: Number(tokens[i++]), y: Number(tokens[i++]) });
      continue;
    }
    if (command !== 'C') throw new Error(`Unsupported LivingLine path command: ${command}`);
    const p0 = points[points.length - 1];
    const p1 = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
    const p2 = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
    const p3 = { x: Number(tokens[i++]), y: Number(tokens[i++]) };
    if (!p0) throw new Error('LivingLine cubic segment has no start point');
    for (let step = 1; step <= 12; step++) {
      const t = step / 12;
      const u = 1 - t;
      points.push({
        x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
        y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
      });
    }
  }
  return points;
}

function arcTable(points: readonly Point[]) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return { points, lengths, total: lengths[lengths.length - 1] };
}

const tables = Object.fromEntries(Object.entries(SOURCE_PATHS).map(([state, path]) => [state, arcTable(flattenPath(path))])) as Record<LivingState, ReturnType<typeof arcTable>>;
const landmarks = [...new Set([
  ...Array.from({ length: 129 }, (_, i) => i / 128),
  ...Object.values(tables).flatMap(({ lengths, total }) => lengths.map(length => length / total)),
])].sort((a, b) => a - b);

function atLength(table: ReturnType<typeof arcTable>, fraction: number): Point {
  const distance = fraction * table.total;
  let i = 1;
  while (i < table.lengths.length - 1 && table.lengths[i] < distance) i++;
  const span = table.lengths[i] - table.lengths[i - 1];
  const t = span ? (distance - table.lengths[i - 1]) / span : 0;
  const a = table.points[i - 1];
  const b = table.points[i];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export const GEOMETRY: Record<LivingState, readonly Point[]> = {
  idle: landmarks.map(fraction => atLength(tables.idle, fraction)),
  working: landmarks.map(fraction => atLength(tables.working, fraction)),
  question: landmarks.map(fraction => atLength(tables.question, fraction)),
  error: landmarks.map(fraction => atLength(tables.error, fraction)),
};
export const WIDTH = 256;
export const HEIGHT = 144;
// At the 216px product frame this retains the original 288/256 artwork scale.
// Only the straight side regions shrink; the central glyphs keep their size.
export const VIEW_BOX = '32 29 192 85.33333333333333';
export const MARK = { cx: 128, cy: 106, questionRadius: 4.2, errorRadius: 4.8, strokeWidth: 3.2 } as const;
export const TRANSITION_SPRING = { stiffness: 66.7, damping: 16 } as const;
export const MARK_RADIUS: Record<LivingState, number> = { idle: 0, working: 0, question: MARK.questionRadius, error: MARK.errorRadius };

export function toPolyline(points: readonly Point[]): string {
  return points.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ');
}

export type IdleWaveMode = Readonly<{ cycles: number; amplitude: number; secondCycles: number; secondAmplitude: number; secondOpacity: number }>;
export const IDLE_WAVE_MODES: readonly IdleWaveMode[] = [
  { cycles: 1.6, amplitude: 10, secondCycles: 0, secondAmplitude: 0, secondOpacity: 0 },
  { cycles: 2.4, amplitude: 12, secondCycles: 1.65, secondAmplitude: 4.8, secondOpacity: 0.24 },
  { cycles: 3, amplitude: 9.5, secondCycles: 2.1, secondAmplitude: 4, secondOpacity: 0.18 },
];

export function idleWaveLines(points: readonly Point[], phase: number, mode: IdleWaveMode, splitProgress = 0): Point[][] {
  const startX = points[0]?.x ?? 0;
  const spanX = (points.at(-1)?.x ?? startX) - startX || 1;
  const makeWave = (cycles: number, amplitude: number, offset: number, speed: number) => points.map(point => {
    const u = (point.x - startX) / spanX;
    const envelope = Math.sin(Math.PI * u) ** 1.2;
    return { x: point.x, y: point.y + envelope * amplitude * Math.sin(u * cycles * Math.PI * 2 + phase * speed + offset) };
  });
  const primary = makeWave(mode.cycles, mode.amplitude, 0, 1);
  if (splitProgress > 0) {
    return [primary, ...[
      makeWave(mode.cycles * 1.12, mode.amplitude * 0.82, 2.15, -0.82),
      makeWave(mode.cycles * 1.43, mode.amplitude * 0.94, 4.1, 0.68),
    ].map(target => target.map((point, index) => ({
      x: point.x,
      y: primary[index].y + (point.y - primary[index].y) * splitProgress,
    })))];
  }
  return mode.secondOpacity <= 0.001 ? [primary] : [primary, makeWave(mode.secondCycles, mode.secondAmplitude, 1.3, -0.82)];
}

export function workingCoreStrokeWidth(splitProgress: number, lineWidth = 3.2): number {
  const split = Math.min(1, Math.max(0, splitProgress));
  return lineWidth * 0.56 + (lineWidth - lineWidth * 0.56) * (1 - split);
}

export function workingHoverLines(points: readonly Point[], phase: number, split = 1): Point[][] {
  return [-1, 0, 1].map((lane, laneIndex) => points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return { ...point };
    const wave = Math.sin(index * 1.37 + phase + laneIndex * 2.05);
    return { x: point.x, y: point.y + split * (lane * (6.5 + Math.abs(wave) * 2) + wave * 2.4) };
  }));
}
