import { ColdStartPresentationState } from '../state/ColdStartPresentationState';
import { MotionPreference } from '../../services/MotionPreference';
import { MobileDesignMotion } from '../../generated/MobileDesignTokens';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { PAGE_BG } from './Theme';

/** Authenticated cold-start cover. The home page stays mounted underneath. */
@ComponentV2
export struct ColdStartHomeTransition {
  @Param geometry: ColdStartPresentationState = new ColdStartPresentationState();
  @Local viewportWidth: number = 0;
  @Local viewportHeight: number = 0;
  @Event onFinished: () => void = () => {};
  @Local progress: number = 0;
  private timer: number = -1;
  private started: number = 0;

  aboutToAppear(): void {
    if (MotionPreference.reduceMotion()) { this.onFinished(); return; }
    this.started = Date.now();
    this.timer = setInterval(() => {
      if (MotionPreference.reduceMotion()) { clearInterval(this.timer); this.onFinished(); return; }
      this.progress = Math.min(1, (Date.now() - this.started) / MobileDesignMotion.coldStartHome);
      if (this.progress >= 1) { clearInterval(this.timer); this.onFinished(); }
    }, 16);
  }
  aboutToDisappear(): void { clearInterval(this.timer); }
  private clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
  private smooth(value: number): number {
    const p = this.clamp(value);
    return p * p * (3 - 2 * p);
  }
  private travel(): number { return this.smooth((this.progress - 0.16) / 0.52); }
  private markSize(): number { return 56 + ((this.geometry.targetSize > 0 ? this.geometry.targetSize : 56) - 56) * this.travel(); }
  private markX(): number {
    const center = this.viewportWidth / 2;
    if (this.geometry.targetSize <= 0) return center - this.markSize() / 2;
    return center + (this.geometry.targetX - this.geometry.originX - center) * this.travel() - this.markSize() / 2;
  }
  private markY(): number {
    const center = this.viewportHeight * 0.53;
    if (this.geometry.targetSize <= 0) return center - this.markSize() / 2;
    return center + (this.geometry.targetY - this.geometry.originY - center) * this.travel()
      - Math.sin(this.travel() * Math.PI) * 9 - this.markSize() / 2;
  }
  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      WelcomeBrandFlow({ markSize: this.markSize(), sweep: true })
        .position({ x: this.markX(), y: this.markY() })
        .opacity(this.clamp(this.progress / 0.13))
    }
      .width('100%').height('100%').backgroundColor(PAGE_BG)
      .onSizeChange((_old: SizeOptions, size: SizeOptions) => {
        this.viewportWidth = Number(size.width);
        this.viewportHeight = Number(size.height);
      })
      .opacity(1 - this.smooth((this.progress - 0.68) / 0.32))
      .hitTestBehavior(HitTestMode.Block).accessibilityLevel('no-hide-descendants')
  }
}
