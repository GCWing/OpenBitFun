type View = { active: boolean; lastActiveAt: number; suspend: () => void };

/** A small warm view set. Document/model owners outlive every entry here. */
export class EditorViewResidency {
  private views = new Map<object, View>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly warmViews = 3, readonly idleMs = 30_000) {}

  update(key: object, active: boolean, suspend: () => void): void {
    const previous = this.views.get(key);
    this.views.set(key, { active, suspend,
      lastActiveAt: active || previous?.active || !previous ? Date.now() : previous.lastActiveAt });
    this.trim();
  }

  delete(key: object): void { this.views.delete(key); this.schedule(); }

  trim(now = Date.now()): void {
    const inactive = [...this.views.entries()].filter(([, view]) => !view.active)
      .sort(([, a], [, b]) => b.lastActiveAt - a.lastActiveAt);
    inactive.forEach(([key, view], index) => {
      if (index >= this.warmViews || now - view.lastActiveAt >= this.idleMs) {
        this.views.delete(key);
        view.suspend();
      }
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const deadlines = [...this.views.values()].filter(view => !view.active)
      .map(view => view.lastActiveAt + this.idleMs);
    if (deadlines.length) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.trim();
    }, Math.max(1, Math.min(...deadlines) - Date.now()));
  }
}

export const editorViewResidency = new EditorViewResidency();
