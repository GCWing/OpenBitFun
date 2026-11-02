export type BrowserPreviewResponse =
  | { status: 'ready'; dataUrl: string }
  | { status: 'unsupported'; reason: string };

interface PreviewOptions {
  capture: (label: string) => Promise<BrowserPreviewResponse>;
  prepare: (dataUrl: string) => Promise<void>;
  onFrame: (dataUrl: string | null) => void;
  onError: (error: unknown) => void;
}

const PREVIEW_INTERVAL_MS = 5000;
const IDLE_PREVIEW_INTERVAL_MS = 30_000;

/** A single in-memory frame; capture work never holds up native show/hide. */
export class BrowserPreviewCache {
  private label = '';
  private generation = 0;
  private visible = false;
  private disposed = false;
  private unsupported = false;
  private inFlight = false;
  private warned = false;
  private lastFrame: string | null = null;
  private lastCaptureAt = 0;
  private intervalMs = PREVIEW_INTERVAL_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PreviewOptions) {}

  setTarget(label: string): void {
    if (this.label === label) return;
    this.label = label;
    this.invalidate();
  }

  invalidate(): void {
    this.generation++;
    this.lastFrame = null;
    this.intervalMs = PREVIEW_INTERVAL_MS;
    this.options.onFrame(null);
    this.clearTimer();
    this.schedule(0);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.clearTimer();
    // Rapid popup/tab toggles should reuse the existing frame rather than
    // repeatedly capturing and decoding the native view.
    if (visible) this.schedule(this.lastFrame === null
      ? 0 : Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - this.lastCaptureAt)));
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.clearTimer();
    this.lastFrame = null;
  }

  resume(): void {
    this.disposed = false;
    this.schedule(0);
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    if (this.disposed || !this.visible || !this.label || this.unsupported || this.inFlight || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.capture(); }, delay);
  }

  private async capture(): Promise<void> {
    const generation = this.generation;
    this.inFlight = true;
    let delay = this.intervalMs;
    try {
      const response = await this.options.capture(this.label);
      if (this.disposed || generation !== this.generation) return;
      if (response.status === 'unsupported') {
        this.unsupported = true;
        this.options.onError(response.reason);
        return;
      }
      this.lastCaptureAt = Date.now();
      if (response.dataUrl === this.lastFrame) {
        this.intervalMs = Math.min(this.intervalMs * 2, IDLE_PREVIEW_INTERVAL_MS);
        this.warned = false;
        delay = this.intervalMs;
        return;
      }
      await this.options.prepare(response.dataUrl);
      if (!this.disposed && generation === this.generation) {
        this.lastFrame = response.dataUrl;
        this.intervalMs = PREVIEW_INTERVAL_MS;
        delay = this.intervalMs;
        this.options.onFrame(response.dataUrl);
        this.warned = false;
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      // Older local hosts may not expose this optional command yet.
      this.unsupported = /unknown command|command.*not found|unsupported/i.test(String(error));
      if (!this.warned) this.options.onError(error);
      this.warned = true;
      this.intervalMs = Math.min(this.intervalMs * 2, IDLE_PREVIEW_INTERVAL_MS);
      delay = this.intervalMs;
    } finally {
      this.inFlight = false;
      this.schedule(generation === this.generation ? delay : 0);
    }
  }
}

export async function prepareBrowserPreview(dataUrl: string): Promise<void> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
}
