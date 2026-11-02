import { MarkdownContent } from './MarkdownContent';
import { RemoteLogger } from '../../services/RemoteLogger';

const STREAMING_MARKDOWN_CACHE: Map<string, string> = new Map<string, string>();

@ComponentV2
export struct StreamingMarkdownContent {
  @Param text: string = '';
  @Param active: boolean = false;
  @Param streamKey: string = '';
  @Param renderRevision: number = 0;
  @Event onCopyText: (text: string) => void = (_text: string) => {};
  @Event onOpenLink: (reference: string, label: string) => void = (_reference: string, _label: string) => {};
  @Local renderedText: string = '';
  @Local renderedRevision: number = 0;
  private targetText: string = '';
  private timerId: number = 0;
  private frameIntervalMs: number = 40;
  private revealDurationMs: number = 1400;
  private cacheWriteInterval: number = 4;
  private frameCount: number = 0;
  private lastLoggedTargetBucket: number = -1;
  private lastLoggedRenderedBucket: number = -1;

  aboutToAppear(): void {
    this.targetText = this.text;
    this.renderedText = this.initialRenderedText();
    this.logTargetProgress('appear', true);
    this.logRenderedProgress(true);
    if (this.active && this.text.length > 0) {
      this.startTimer();
    }
  }

  aboutToDisappear(): void {
    this.logTargetProgress('disappear', true);
    this.logRenderedProgress(true);
    this.saveRenderedText();
    this.clearTimer();
  }

  build() {
    MarkdownContent({
      text: this.renderedText,
      renderRevision: this.renderedRevision,
      onCopyText: (_body: string) => {
        this.onCopyText(this.text);
      },
      onOpenLink: (reference: string, label: string) => {
        this.onOpenLink(reference, label);
      }
    })
  }

  @Monitor('text', 'active', 'streamKey', 'renderRevision')
  private handleTextChanged(): void {
    this.logTargetProgress(this.active ? 'target' : 'settled', !this.active);
    if (!this.active) {
      this.clearTimer();
      this.targetText = this.text;
      this.renderedText = this.text;
      this.renderedRevision += 1;
      this.logRenderedProgress(true);
      this.saveRenderedText();
      return;
    }
    const cached = this.cachedRenderedText();
    if (cached.length > this.renderedText.length && this.text.startsWith(cached)) {
      this.renderedText = cached;
      this.renderedRevision += 1;
      this.logRenderedProgress(false);
    }
    if (this.text === this.renderedText) {
      this.clearTimer();
      this.targetText = this.text;
      this.saveRenderedText();
      return;
    }
    // The input is already revision-reconciled by the transcript owner. A
    // rewrite or deletion is authoritative, not a stale streaming chunk.
    // Only append-only growth may continue the previous reveal animation.
    if (!this.text.startsWith(this.targetText) || !this.text.startsWith(this.renderedText)) {
      this.clearTimer();
      this.targetText = this.text;
      this.renderedText = this.text;
      this.renderedRevision += 1;
      this.saveRenderedText();
      return;
    }
    this.targetText = this.text;
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timerId !== 0) {
      return;
    }
    this.frameCount = 0;
    this.timerId = setInterval(() => {
      if (this.renderedText.length >= this.targetText.length) {
        this.clearTimer();
        return;
      }
      const remaining = this.targetText.length - this.renderedText.length;
      const totalFrames = Math.max(1, Math.floor(this.revealDurationMs / this.frameIntervalMs));
      const step = Math.max(1, Math.ceil(remaining / totalFrames));
      this.renderedText = this.targetText.slice(0, Math.min(this.targetText.length, this.renderedText.length + step));
      this.renderedRevision += 1;
      this.frameCount += 1;
      this.logRenderedProgress(false);
      if (this.frameCount % this.cacheWriteInterval === 0 || this.renderedText.length >= this.targetText.length) {
        this.saveRenderedText();
      }
    }, this.frameIntervalMs);
  }

  private clearTimer(): void {
    if (this.timerId !== 0) {
      clearInterval(this.timerId);
      this.timerId = 0;
    }
  }

  private initialRenderedText(): string {
    if (!this.active) {
      return this.text;
    }
    const cached = this.cachedRenderedText();
    if (cached.length > 0 && this.text.startsWith(cached)) {
      return cached;
    }
    return '';
  }

  private cachedRenderedText(): string {
    const key = this.normalizedStreamKey();
    if (key.length === 0) {
      return '';
    }
    return STREAMING_MARKDOWN_CACHE.get(key) || '';
  }

  private saveRenderedText(): void {
    const key = this.normalizedStreamKey();
    if (key.length === 0) {
      return;
    }
    STREAMING_MARKDOWN_CACHE.set(key, this.renderedText);
  }

  private normalizedStreamKey(): string {
    return this.streamKey.trim();
  }

  private logTargetProgress(reason: string, force: boolean): void {
    const bucket = Math.floor(this.text.length / 256);
    if (!force && bucket === this.lastLoggedTargetBucket) {
      return;
    }
    this.lastLoggedTargetBucket = bucket;
    RemoteLogger.info(
      `stream markdown ${reason} key=${this.normalizedStreamKey()} target=${this.text.length} ` +
      `rendered=${this.renderedText.length} revision=${this.renderRevision} active=${this.active ? 1 : 0}`
    );
  }

  private logRenderedProgress(force: boolean): void {
    const bucket = Math.floor(this.renderedText.length / 256);
    if (!force && bucket === this.lastLoggedRenderedBucket) {
      return;
    }
    this.lastLoggedRenderedBucket = bucket;
    RemoteLogger.info(
      `stream markdown frame key=${this.normalizedStreamKey()} target=${this.targetText.length} ` +
      `rendered=${this.renderedText.length} frame=${this.frameCount}`
    );
  }

}
