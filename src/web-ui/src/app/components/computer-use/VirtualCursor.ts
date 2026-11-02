/** Port of computer-use-rust/src/cursor.rs, in preview-local CSS pixels.
 * Visual convergence is never an input acknowledgement. No native input lives here.
 * Fixed 240 Hz integration preserves behavior across renderer frame rates.
 */
export interface CursorPoint { x: number; y: number }
export interface CursorVisual {
  opacity: number; scaleX: number; scaleY: number; rotation: number;
  axisRotation: number; axisScale: number; blur: number;
}
const TAU = 2 * Math.PI;
const STEP = 1 / 240;
const REST = -44;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const add = (a: CursorPoint, b: CursorPoint): CursorPoint => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: CursorPoint, b: CursorPoint): CursorPoint => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: CursorPoint, n: number): CursorPoint => ({ x: a.x * n, y: a.y * n });
const distance = (a: CursorPoint, b: CursorPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: CursorPoint) => Math.hypot(a.x, a.y) < 0.001 ? { x: 1, y: 0 } : mul(a, 1 / Math.hypot(a.x, a.y));
const click = () => ({ x: Math.sin(REST * Math.PI / 180), y: -Math.cos(REST * Math.PI / 180) });
const angleDelta = (from: number, to: number, period: number) => {
  const delta = (to - from) % period;
  return delta > period / 2 ? delta - period : delta < -period / 2 ? delta + period : delta;
};
class Spring {
  target: number; velocity = 0; force = 0;
  constructor(public value: number, public response: number, public damping: number, target = value) { this.target = target; }
  snap(value: number) { this.value = this.target = value; this.velocity = this.force = 0; }
  angleTarget(angle: number) { this.target = this.value + angleDelta(this.value, angle, 360); }
  atRest() { return Math.max(Math.abs(this.velocity), Math.abs(this.force)) <= 0.06
    && (this.target === 0 || Math.abs(this.target - this.value) <= Math.abs(this.target * 0.01)); }
  settled() { return this.value === this.target && this.atRest(); }
  step() {
    const stiffness = Math.min((TAU / Math.max(this.response, 0.001)) ** 2, 1 / (2 * STEP * STEP));
    const friction = 2 * this.damping * Math.sqrt(stiffness);
    const halfVelocity = this.velocity + this.force * STEP / 2;
    this.value += halfVelocity * STEP;
    this.force = (this.target - this.value) * stiffness - halfVelocity * friction;
    this.velocity = halfVelocity + this.force * STEP / 2;
    if (this.atRest()) this.value = this.target;
  }
}
class Viewport {
  constructor(public width: number, public height: number) {
    if (![width, height].every(v => Number.isFinite(v) && v > 0 && v <= 3.4028234663852886e38)) {
      throw new Error('invalid_cursor_geometry');
    }
  }
  clamp(p: CursorPoint) { return { x: clamp(p.x, 0, this.width), y: clamp(p.y, 0, this.height) }; }
  initial() { return this.clamp({ x: Math.round(this.width * 0.58), y: Math.round(this.height * 0.55) }); }
  inside(p: CursorPoint) { return p.x >= 20 && p.x <= this.width - 20 && p.y >= 20 && p.y <= this.height - 20; }
}
interface Segment { control1: CursorPoint; control2: CursorPoint; end: CursorPoint }
function cubic(start: CursorPoint, segment: Segment, t: number): [CursorPoint, CursorPoint] {
  const u = 1 - t;
  return [add(add(add(mul(start, u ** 3), mul(segment.control1, 3 * u * u * t)),
    mul(segment.control2, 3 * u * t * t)), mul(segment.end, t ** 3)),
  add(add(mul(sub(segment.control1, start), 3 * u * u), mul(sub(segment.control2, segment.control1), 6 * u * t)),
    mul(sub(segment.end, segment.control2), 3 * t * t))];
}
class Curve {
  constructor(public start: CursorPoint, public segments: Segment[]) {}
  end() { return this.segments[this.segments.length - 1].end; }
  arc() { return this.segments.length === 2; }
  at(progress: number) {
    progress = clamp(progress, 0, 1);
    const scaled = progress * this.segments.length;
    const index = progress === 1 ? this.segments.length - 1 : Math.floor(scaled);
    return cubic(index === 0 ? this.start : this.segments[index - 1].end, this.segments[index], progress === 1 ? 1 : scaled % 1);
  }
  measure(viewport?: Viewport) {
    const result = { length: 0, energy: 0, maxTurn: 0, totalTurn: 0, inBounds: !viewport || viewport.inside(this.start) };
    let previous = this.start, start = this.start;
    let previousAngle: number | undefined;
    for (const segment of this.segments) {
      for (let sample = 1; sample <= 24; sample++) {
        const [point] = cubic(start, segment, sample / 24);
        const delta = sub(point, previous), length = distance(point, previous);
        result.length += length;
        result.inBounds &&= !viewport || viewport.inside(point);
        if (length > 0.01) {
          const angle = Math.atan2(delta.y, delta.x);
          if (previousAngle !== undefined) {
            const turn = angleDelta(previousAngle, angle, TAU);
            result.energy += turn * turn; result.maxTurn = Math.max(result.maxTurn, Math.abs(turn)); result.totalTurn += Math.abs(turn);
          }
          previousAngle = angle;
        }
        previous = point;
      }
      start = segment.end;
    }
    return result;
  }
  opposition() {
    const d = unit(sub(this.end(), this.start)), c = click();
    return clamp((-(d.x * c.x + d.y * c.y) - 0.08) / 0.92, 0, 1);
  }
  score(m: ReturnType<Curve['measure']>) {
    const excess = Math.max(m.length / Math.max(distance(this.start, this.end()), 1) - 1, 0);
    return m.length + excess * 320 + m.energy * 140 + m.maxTurn * 180 + m.totalTurn * 18 + this.opposition() * 90 + (this.arc() ? 45 : 0);
  }
  response() {
    const m = this.measure(), excess = Math.max(m.length / Math.max(distance(this.start, this.end()), 1) - 1, 0);
    const length = clamp((m.length - 180) / 760, 0, 1);
    const curvature = clamp(clamp(excess / 0.55, 0, 1) * 0.42 + clamp(m.totalTurn / (Math.PI * 1.4), 0, 1) * 0.38
      + clamp(m.energy / 1.25, 0, 1) * 0.2, 0, 1);
    const duration = 0.42 + length * 0.22 + curvature * 0.12 + this.opposition() * 0.28 + (this.arc() ? 0.04 : 0);
    return clamp(duration * 0.7 * (this.arc() ? 0.9 : 1), 0.12, 2.2);
  }
}
function clipHandle(v: Viewport, p: CursorPoint, d: CursorPoint, length: number) {
  if (d.x < 0) length = Math.min(length, p.x / -d.x);
  if (d.x > 0) length = Math.min(length, (v.width - p.x) / d.x);
  if (d.y < 0) length = Math.min(length, p.y / -d.y);
  if (d.y > 0) length = Math.min(length, (v.height - p.y) / d.y);
  return add(p, mul(d, Math.max(length, 0)));
}
function chooseCurve(v: Viewport, start: CursorPoint, end: CursorPoint) {
  const length = distance(start, end), c = click(), direction = unit(sub(end, start));
  const startLength = clamp(Math.min(length * 0.41960295031576633, length * 0.9), 48, 640);
  const endLength = clamp(Math.min(length * 0.15, length * 0.9), 48, 640);
  const control1 = clipHandle(v, start, c, startLength), control2 = clipHandle(v, end, mul(c, -1), endLength);
  const candidates = [new Curve(start, [{ control1, control2, end }]), new Curve(start, [{
    control1: clipHandle(v, start, c, startLength * 0.65), control2: clipHandle(v, end, mul(c, -1), endLength * 0.65), end,
  }])];
  const perpendicular = { x: -direction.y, y: direction.x };
  const normal = mul(perpendicular, perpendicular.x * c.x + perpendicular.y * c.y >= 0 ? 1 : -1);
  const midpoint = mul(add(start, end), 0.5);
  const arcSize = clamp(length * 0.2765523188064277, 50, 520), arcFlow = clamp(length * 0.5783555327868779, 38, 440);
  for (const ds of [0.55, 0.8, 1.05]) for (const fs of [0.65, 1, 1.35]) for (const side of [1, -1]) {
    const arc = add(add(midpoint, mul(normal, side * arcSize * ds)), mul(c, startLength * 0.16));
    const handle = mul(direction, arcFlow * fs);
    candidates.push(new Curve(start, [{ control1, control2: sub(arc, handle), end: arc }, { control1: add(arc, handle), control2, end }]));
  }
  let best = candidates[0], bestInside: Curve | undefined, score = Infinity, insideScore = Infinity;
  for (const candidate of candidates) {
    const measured = candidate.measure(v), nextScore = candidate.score(measured);
    if (nextScore < score) { best = candidate; score = nextScore; }
    if (measured.inBounds && nextScore < insideScore) { bestInside = candidate; insideScore = nextScore; }
  }
  return bestInside ?? best;
}
type Motion = { kind: 'scoot'; start: CursorPoint; end: CursorPoint; axis: number; rotation: number; progress: Spring }
  | { kind: 'bezier'; curve: Curve; progress: Spring };
export class VirtualCursor {
  private viewport: Viewport; private destination: CursorPoint; private x: Spring; private y: Spring;
  private rotation = new Spring(REST, 0.12, 0.9); private axis = new Spring(0, 0.12, 0.9);
  private scootRotation = new Spring(0, 0.055, 0.82); private scootStretch = new Spring(1, 0.12, 0.86);
  private stretch = new Spring(1, 0.2, 0.85); private opacity = new Spring(0, 0.42, 0.86);
  private motion?: Motion; private lastSequence?: number; private activeSequence?: number; private arrival?: number;
  private remainder = 0; private elapsed = 0; private thinkStarted?: number;
  constructor(width: number, height: number) {
    this.viewport = new Viewport(width, height); this.destination = this.viewport.initial();
    this.x = new Spring(this.destination.x, 0.19, 0.9); this.y = new Spring(this.destination.y, 0.19, 0.9);
  }
  moveTo(point: CursorPoint, sequence: number, animate = true) {
    if (![point.x, point.y].every(Number.isFinite)) throw new Error('invalid_cursor_geometry');
    if (!Number.isSafeInteger(sequence) || sequence < 0 || (this.lastSequence !== undefined && sequence <= this.lastSequence)) throw new Error('stale_cursor_sequence');
    point = this.viewport.clamp(point);
    this.lastSequence = this.activeSequence = sequence; this.arrival = undefined; this.destination = point;
    this.opacity.target = 1; this.thinkStarted = undefined;
    const start = this.position(), first = this.opacity.value <= 0.001;
    if (!animate || first || distance(start, point) < 0.5) {
      if (first) this.opacity.snap(1);
      this.snapPosition(point); this.motion = undefined; this.arrive();
    } else if (distance(start, point) <= 196) {
      const d = unit(sub(point, start)); this.x.response = this.y.response = 0.19;
      this.x.target = point.x; this.y.target = point.y;
      this.motion = { kind: 'scoot', start, end: point, axis: Math.atan2(d.y, d.x) * 180 / Math.PI,
        rotation: clamp(d.x * 0.75 - d.y * 0.62, -1, 1) * 70, progress: new Spring(0, 0.19, 0.94, 1) };
    } else {
      const curve = chooseCurve(this.viewport, start, point), response = curve.response();
      this.x.response = this.y.response = clamp(response * 0.18, 0.035, 0.12);
      this.motion = { kind: 'bezier', curve, progress: new Spring(0, response, 0.9, 1) };
    }
  }
  advance(dt: number) {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('invalid_cursor_time');
    this.remainder += dt > 1 ? 1 / 60 : dt;
    while (this.remainder + Number.EPSILON >= STEP) { this.remainder = Math.max(this.remainder - STEP, 0); this.elapsed += STEP; this.step(); }
  }
  private step() {
    const previous = this.position(); let done = false, completionRotation = REST;
    const m = this.motion;
    if (m?.kind === 'scoot') {
      m.progress.step(); this.x.target = m.end.x; this.y.target = m.end.y;
      this.rotation.angleTarget(REST); this.axis.angleTarget(m.axis); this.stretch.target = 1;
      this.x.step(); this.y.step(); this.rotation.step(); this.axis.step();
      const axis = sub(m.end, m.start), length = axis.x * axis.x + axis.y * axis.y, moved = sub(this.position(), m.start);
      const fraction = length < 0.001 ? 1 : clamp((moved.x * axis.x + moved.y * axis.y) / length, 0, 1);
      this.scootStretch.target = 1 - Math.sin(fraction * Math.PI) * 0.15;
      this.scootRotation.target = m.rotation * Math.sin(fraction * Math.PI);
      done = fraction >= 0.999 && Math.abs(m.progress.velocity) < 0.01;
    } else if (m?.kind === 'bezier') {
      m.progress.step(); const fraction = clamp(m.progress.value, 0, 1), [p, tangent] = m.curve.at(fraction);
      this.x.target = p.x; this.y.target = p.y;
      this.rotation.angleTarget(Math.hypot(tangent.x, tangent.y) < 0.001 ? REST : Math.atan2(tangent.y, tangent.x) * 180 / Math.PI + 90);
      this.axis.angleTarget(0); this.scootStretch.target = 1; this.scootRotation.target = 0;
      this.x.step(); this.y.step(); this.rotation.step(); this.axis.step();
      this.stretch.target = clamp(1 - distance(previous, this.position()) / STEP / 5500, 0.65, 1);
      done = fraction >= 0.999 && Math.abs(m.progress.velocity) < 0.01;
      const endTangent = m.curve.at(1)[1];
      completionRotation = Math.hypot(endTangent.x, endTangent.y) < 0.001 ? REST : Math.atan2(endTangent.y, endTangent.x) * 180 / Math.PI + 90;
    } else { this.stretch.target = this.scootStretch.target = 1; this.scootRotation.target = 0; }
    if (done && distance(this.position(), this.destination) <= 0.85 && Math.abs(this.x.velocity) <= 12 && Math.abs(this.y.velocity) <= 12) {
      this.x.snap(this.destination.x); this.y.snap(this.destination.y); this.rotation.snap(completionRotation);
      this.axis.snap(0); this.scootRotation.snap(0); this.scootStretch.snap(1); this.stretch.snap(1);
      this.motion = undefined; this.thinkStarted = this.elapsed; this.arrive();
    }
    this.opacity.step(); this.stretch.step(); this.scootStretch.step(); this.scootRotation.step();
    if (this.thinkStarted !== undefined && this.elapsed - this.thinkStarted >= 1.41) this.thinkStarted = undefined;
  }
  private snapPosition(p: CursorPoint) {
    this.x.snap(p.x); this.y.snap(p.y); this.rotation.snap(REST); this.axis.snap(0);
    this.scootRotation.snap(0); this.scootStretch.snap(1); this.stretch.snap(1);
  }
  private arrive() { if (this.activeSequence !== undefined) { this.arrival = this.activeSequence; this.activeSequence = undefined; } }
  hide() {
    this.destination = this.position(); this.snapPosition(this.destination); this.motion = undefined;
    this.activeSequence = this.arrival = this.thinkStarted = undefined; this.opacity.target = 0; this.remainder = 0;
  }
  reset() { this.hide(); this.opacity.snap(0); this.destination = this.viewport.initial(); this.snapPosition(this.destination); }
  resize(width: number, height: number) {
    const viewport = new Viewport(width, height);
    if (width !== this.viewport.width || height !== this.viewport.height) { this.viewport = viewport; this.reset(); }
  }
  position(): CursorPoint { return { x: this.x.value, y: this.y.value }; }
  target(): CursorPoint { return { ...this.destination }; }
  takeArrival() { const arrival = this.arrival; this.arrival = undefined; return arrival; }
  needsAnimation() { return !!this.motion || this.thinkStarted !== undefined ||
    [this.x, this.y, this.rotation, this.axis, this.scootRotation, this.scootStretch, this.stretch, this.opacity].some(s => !s.settled()); }
  visual(): CursorVisual {
    const opacity = clamp(this.opacity.value, 0, 1), scale = 0.4 + 0.6 * opacity;
    const elapsed = this.thinkStarted === undefined ? 0 : this.elapsed - this.thinkStarted;
    const idle = Math.sin(elapsed / 0.66 * TAU) * Math.sin(clamp(elapsed / 1.41, 0, 1) * Math.PI) * 12.5;
    return { opacity, scaleX: this.stretch.value * scale, scaleY: scale,
      rotation: ((this.rotation.value + idle + this.scootRotation.value) % 360 + 360) % 360,
      axisRotation: this.axis.value, axisScale: clamp(this.scootStretch.value, 0, 1), blur: 5 * (1 - opacity) };
  }
}
