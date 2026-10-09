/** Time-based, reversible formation; changing direction never jumps to an endpoint. */
export class VoiceParticleFormation {
  private from: number;
  private target: number;
  private startedAt = 0;
  private duration = 0;
  moving = false;

  constructor(initial: number) { this.from = this.target = Math.max(0, Math.min(1, initial)); }

  sample(time: number, reducedMotion = false): number {
    if (reducedMotion) {
      this.from = this.target;
      this.duration = 0;
      this.moving = false;
      return this.target;
    }
    const progress = !this.duration ? 1 : Math.max(0, Math.min(1, (time - this.startedAt) / this.duration));
    if (progress === 1) this.moving = false;
    return this.from + (this.target - this.from) * (1 - Math.pow(1 - progress, 3));
  }

  setTarget(target: number, time: number) {
    const next = Math.max(0, Math.min(1, target));
    if (next === this.target) return;
    this.from = this.sample(time);
    this.target = next;
    this.startedAt = time;
    this.duration = Math.max(next, this.from) <= 0.16 ? 180 : next > this.from ? 700 : 480;
    this.moving = this.from !== next;
  }
}
