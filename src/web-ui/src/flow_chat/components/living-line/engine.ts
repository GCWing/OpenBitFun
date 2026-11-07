import { GEOMETRY, MARK_RADIUS, TRANSITION_SPRING, type LivingState, type Point } from './geometry';

type MutablePoint = { x: number; y: number };

export class LivingLineEngine {
  private current: MutablePoint[];
  private target: MutablePoint[];
  private velocity: MutablePoint[];
  private markRadius = 0;
  private markTarget = 0;
  private markVelocity = 0;
  private state: LivingState = 'idle';
  private reducedMotion = false;
  private readonly start: Point;
  private readonly end: Point;

  constructor(
    private readonly stiffness = TRANSITION_SPRING.stiffness,
    private readonly damping = TRANSITION_SPRING.damping,
  ) {
    this.current = GEOMETRY.idle.map(p => ({ ...p }));
    this.target = this.current.map(p => ({ ...p }));
    this.velocity = this.current.map(() => ({ x: 0, y: 0 }));
    this.start = { ...this.current[0] };
    this.end = { ...this.current[this.current.length - 1] };
  }

  getState(): LivingState { return this.state; }
  getPoints(): readonly Point[] { return this.current.map(p => ({ ...p })); }
  getMarkRadius(): number { return this.markRadius; }
  get settled(): boolean {
    return this.markRadius === this.markTarget && this.current.every((p, i) => Math.abs(p.x - this.target[i].x) < 0.05 && Math.abs(p.y - this.target[i].y) < 0.05);
  }

  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    if (enabled) this.snapToTarget();
  }

  setState(state: LivingState): void {
    this.state = state;
    this.target = GEOMETRY[state].map(p => ({ ...p }));
    this.target[0] = { ...this.start };
    this.target[this.target.length - 1] = { ...this.end };
    this.markTarget = MARK_RADIUS[state];
    if (this.reducedMotion) this.snapToTarget();
  }

  step(deltaSeconds: number): readonly Point[] {
    if (this.reducedMotion || !this.current.length) return this.getPoints();
    const dt = Math.min(Math.max(deltaSeconds, 0), 1 / 30);
    for (let i = 1; i < this.current.length - 1; i++) {
      for (const axis of ['x', 'y'] as const) {
        const acceleration = this.stiffness * (this.target[i][axis] - this.current[i][axis]) - this.damping * this.velocity[i][axis];
        this.velocity[i][axis] += acceleration * dt;
        this.current[i][axis] += this.velocity[i][axis] * dt;
      }
    }
    const markAcceleration = this.stiffness * (this.markTarget - this.markRadius) - this.damping * this.markVelocity;
    this.markVelocity += markAcceleration * dt;
    const previousRadius = this.markRadius;
    this.markRadius = Math.max(0, this.markRadius + this.markVelocity * dt);
    if ((previousRadius - this.markTarget) * (this.markRadius - this.markTarget) <= 0 || (Math.abs(this.markRadius - this.markTarget) < 0.01 && Math.abs(this.markVelocity) < 0.02)) {
      this.markRadius = this.markTarget;
      this.markVelocity = 0;
    }
    this.current[0] = { ...this.start };
    this.current[this.current.length - 1] = { ...this.end };
    return this.getPoints();
  }

  private snapToTarget(): void {
    this.current = this.target.map(p => ({ ...p }));
    this.velocity = this.current.map(() => ({ x: 0, y: 0 }));
    this.markRadius = this.markTarget;
    this.markVelocity = 0;
  }
}
