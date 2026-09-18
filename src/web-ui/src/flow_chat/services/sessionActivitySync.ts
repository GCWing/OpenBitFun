/** Shared request coordinator. One queue per app, never one timer per row. */
export interface ActivityTarget {
  sessionId: string;
  workspaceId: string;
}

export class SessionActivitySync {
  private pending = new Map<string, ActivityTarget>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;
  private generation = 0;

  constructor(private readonly read: (targets: ActivityTarget[]) => Promise<void>) {}

  request(target: ActivityTarget): void {
    if (this.disposed) return;
    this.pending.set(target.sessionId, target);
    if (!this.timer && !this.running) this.timer = setTimeout(() => { void this.flush(); }, 100);
  }

  clear(): void {
    this.generation += 1;
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void { this.disposed = true; this.clear(); }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.disposed || this.running) return;
    this.running = true;
    const generation = this.generation;
    const scopes = new Map<string, ActivityTarget[]>();
    for (const target of this.pending.values()) {
      const key = target.workspaceId;
      const group = scopes.get(key) ?? [];
      group.push(target);
      scopes.set(key, group);
    }
    this.pending.clear();
    const batches: ActivityTarget[][] = [];
    for (const group of scopes.values()) {
      for (let offset = 0; offset < group.length; offset += 128) batches.push(group.slice(offset, offset + 128));
    }
    const worker = async () => {
      while (!this.disposed && generation === this.generation) {
        const batch = batches.shift();
        if (!batch) return;
        await this.read(batch);
      }
    };
    try { await Promise.all([worker(), worker()]); }
    finally {
      this.running = false;
      if (!this.disposed && this.pending.size && !this.timer) {
        this.timer = setTimeout(() => { void this.flush(); }, 100);
      }
    }
  }
}
