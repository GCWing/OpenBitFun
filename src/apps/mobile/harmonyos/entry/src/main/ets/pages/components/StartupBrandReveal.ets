import { MotionPreference } from '../../services/MotionPreference';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { MobileDesignMotion, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { PAGE_BG, INK } from './Theme';

/** Native rendering of the mobile startup_brand_reveal motion contract. */
@ComponentV2
export struct StartupBrandReveal {
  @Event onFinished: () => void = () => {};
  @Local progress: number = 0;
  @Local stageScale: number = 1;
  private readonly letters: string[] = ['O', 'p', 'e', 'n', 'B', 'ı', 't', 'F', 'u', 'n'];
  private readonly widths: number[] = [30, 25, 24, 25, 28, 10, 16, 24, 25, 25];
  private timer: number = -1;
  private started: number = 0;

  aboutToAppear(): void {
    if (MotionPreference.reduceMotion()) { this.onFinished(); return; }
    this.started = Date.now();
    this.timer = setInterval(() => {
      this.progress = Math.min(1, (Date.now() - this.started) / MobileDesignMotion.startupBrand);
      if (this.progress >= 1) { clearInterval(this.timer); this.onFinished(); }
    }, 16);
  }
  aboutToDisappear(): void { clearInterval(this.timer); }
  private clamp(x: number): number { return Math.max(0, Math.min(1, x)); }
  private smooth(x: number): number { const v = this.clamp(x); return v * v * (3 - 2 * v); }
  private ease(x: number): number { return 1 - Math.pow(1 - this.clamp(x), 3); }
  private time(): number { return Math.min(this.progress / 0.65 * 0.9, 0.9); }
  private settle(): number { return this.smooth((this.progress - 0.66) / 0.19); }
  private start(index: number): number { return 0.19 + index * 0.048; }
  private x(index: number): number {
    let x = 24;
    for (let i = 0; i < index; i++) x += this.widths[i];
    return x;
  }
  private reveal(index: number): number { return this.ease((this.time() - this.start(index)) / 0.05); }
  private bounce(index: number): number {
    const p = this.clamp((this.time() - this.start(index)) / 0.085);
    return Math.sin(p * Math.PI) * Math.pow(1 - p, 0.65);
  }
  private dot(): number[] {
    const t = this.time();
    let x = 9;
    let y = 110;
    let sx = 1;
    let sy = 1;
    for (let i = 0; i < 10; i++) {
      const end = this.start(i);
      const begin = i === 0 ? end - 0.065 : this.start(i - 1);
      const from = i === 0 ? 9 : this.x(i) + 10;
      const to = this.x(i + 1) + 10;
      if (t >= end) { x = to; continue; }
      if (t >= begin) {
        const step = this.clamp((t - begin) / (end - begin));
        const hop = this.clamp((step - 0.16) / 0.84);
        const squash = Math.sin(this.clamp(step / 0.16) * Math.PI);
        x = from + (to - from) * this.smooth(hop);
        y -= 4 * hop * (1 - hop) * (i === 0 ? 20 : 15);
        sx = 1 + 0.2 * squash; sy = 1 - 0.18 * squash;
      }
      break;
    }
    if (t >= 0.70) {
      const flight = this.clamp((t - 0.70) / 0.16);
      const travel = this.smooth(flight);
      x += (this.x(5) + 5 - x) * travel;
      y = 110 - 15 * travel - Math.sin(Math.PI * flight) * 44;
      sx = 1 + (7.35 / 9 - 1) * travel; sy = sx;
      if (t > 0.86 && t < 0.9) y -= Math.sin((t - 0.86) / 0.04 * Math.PI) * 2;
    }
    return [x, y + 42 * this.settle(), sx, sy];
  }
  private markScale(): number {
    const p = this.clamp((this.progress - 0.66) / 0.19) - 1;
    return 0.65 + 0.35 * (1 + 2.2 * p * p * p + 1.2 * p * p);
  }
  private halo(): number { return Math.sin(this.clamp((this.time() - 0.86) / 0.04) * Math.PI); }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      Stack({ alignContent: Alignment.TopStart }) {
        WelcomeBrandFlow({ markSize: 156, sweep: true })
          .position({ x: 62, y: -34 }).scale({ x: this.markScale(), y: this.markScale() })
          .opacity(this.ease((this.progress - 0.66) / 0.19))
        ForEach(this.letters, (letter: string, index: number) => {
          Text(letter).fontSize(MobileDesignTypography.brandWordmark.size).fontWeight(FontWeight.Medium).fontColor(INK)
            .width(this.widths[index]).height(56).textAlign(TextAlign.Center)
            .position({ x: this.x(index), y: 82 + 42 * this.settle() })
            .opacity(this.reveal(index))
            .translate({ y: 7 * (1 - this.reveal(index)) - 8 * this.bounce(index) })
            .rotate({ angle: (index % 2 === 0 ? -1 : 1) * this.bounce(index) * 6 })
        }, (_letter: string, index: number) => `${index}`)
        Circle().width(22).height(22).fill($r('app.color.brand_dot'))
          .position({ x: this.dot()[0] - 11, y: this.dot()[1] - 11 }).opacity(this.halo() * 0.16)
        Circle().width(9).height(9).fill($r('app.color.brand_dot'))
          .position({ x: this.dot()[0] - 4.5, y: this.dot()[1] - 4.5 })
          .scale({ x: this.dot()[2], y: this.dot()[3] }).opacity(this.ease(this.time() / 0.12))
      }.width(280).height(240).scale({ x: this.stageScale, y: this.stageScale })
    }
    .width('100%').height('100%').backgroundColor(PAGE_BG)
    .onSizeChange((_oldSize: SizeOptions, size: SizeOptions) => {
      this.stageScale = Math.min(1, Math.max(0.1, (Number(size.width) - 32) / 280));
    })
    .opacity(1 - this.smooth((this.progress - 0.97) / 0.03))
    .hitTestBehavior(HitTestMode.Block).accessibilityLevel('no-hide-descendants')
  }
}
