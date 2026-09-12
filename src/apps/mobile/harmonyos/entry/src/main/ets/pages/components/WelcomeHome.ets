import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignTypography, MobileDesignGeometry as G } from '../../generated/MobileDesignTokens';
import { MotionPreference } from '../../services/MotionPreference';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { INK, PAGE_BG, SOFT, MUTED, TRANSPARENT } from './Theme';

/** A welcome composition with the C staggered-slide phrase timeline. */
@ComponentV2
export struct WelcomeHome {
  @Param signedIn: boolean = false;
  @Event onLogin: () => void = () => {};
  @Event onScan: () => void = () => {};
  @Event onMiniApps: () => void = () => {};
  @Local elapsed: number = 0;
  @Local pageHeight: number = 700;
  @Local pageWidth: number = 390;
  private timer: number = -1;
  private started: number = 0;

  aboutToDisappear(): void { this.stop(); }
  private stop(): void { if (this.timer >= 0) clearInterval(this.timer); this.timer = -1; }
  private play(): void {
    this.stop();
    if (MotionPreference.reduceMotion()) { this.elapsed = 2700; return; }
    this.started = Date.now();
    this.timer = setInterval(() => { this.elapsed = Date.now() - this.started; }, 16);
  }
  private phrases(): string[] {
    return ['OpenBitFun', RemoteI18n.t('home.welcome_work'), RemoteI18n.t('home.welcome_play'), RemoteI18n.t('home.welcome_yours')];
  }
  private duration(word: string): number { return 250 + word.length * 185 + (word === 'OpenBitFun' ? 600 : 0) + 1800 + 650; }
  private phraseIndex(): number {
    const words = this.phrases();
    let total = 0;
    for (const word of words) total += this.duration(word);
    let time = this.elapsed % total;
    for (let i = 0; i < words.length; i++) { if (time < this.duration(words[i])) return i; time -= this.duration(words[i]); }
    return 0;
  }
  private word(): string { return this.phrases()[this.phraseIndex()]; }
  private time(): number {
    const words = this.phrases();
    let total = 0;
    for (const word of words) total += this.duration(word);
    let time = this.elapsed % total;
    for (let i = 0; i < this.phraseIndex(); i++) time -= this.duration(words[i]);
    return time;
  }
  private clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
  private progress(index: number): number { return this.clamp((this.time() - 180 - index * 55) / 800); }
  private exitProgress(): number { return this.clamp((this.time() - this.duration(this.word()) + 650) / 650); }
  private bump(index: number): number { const p = this.progress(index); return Math.sin(p * Math.PI) * (1-p); }
  private glyphOffset(index: number): number {
    return Math.pow(1-this.progress(index), 3) * 38 - this.bump(index) * 5 - Math.pow(this.exitProgress(), 2) * 30;
  }

  private wide(): boolean { return this.pageWidth >= 600; }
  private landscape(): boolean {
    return this.pageWidth >= 840 && this.pageWidth / Math.max(1, this.pageHeight) >= 1.2;
  }

  build() {
    Scroll() {
      Column() {
        Row() {
          ForEach('OpenBitFun'.split(''), (letter: string) => { this.Glyph(letter, G.welcomeHeaderWordSize); })
        }.width('100%').height(G.welcomeHeaderHeight)
          .padding({ left: this.wide() ? 40 : G.welcomeGutter, right: G.welcomeGutter })
        if (this.landscape()) {
          Row({ space: 48 }) {
            Column() { this.Hero() }.layoutWeight(1)
            Column() { this.Actions() }.layoutWeight(1)
          }.width('100%').constraintSize({ maxWidth: 1000,
            minHeight: Math.max(400, this.pageHeight - G.welcomeHeaderHeight) })
            .padding({ left: 40, right: 40, bottom: 48 })
            .alignItems(VerticalAlign.Center)
        } else if (this.wide()) {
          Column() {
            this.Hero()
            this.Actions()
          }.width('100%').constraintSize({ minHeight: Math.max(540, this.pageHeight - G.welcomeHeaderHeight) })
            .justifyContent(FlexAlign.Center).padding({ bottom: 64 })
        } else {
          Column() { this.Hero() }
            .justifyContent(FlexAlign.Center).width('100%')
            .height(Math.max(300, this.pageHeight - G.welcomeHeaderHeight - 228))
            .padding({ bottom: 24 })
          this.Actions()
        }
      }.width('100%')
    }.width('100%').height('100%').scrollBar(BarState.Off).backgroundColor(PAGE_BG)
      .onSizeChange((_old: SizeOptions, size: SizeOptions) => {
        this.pageHeight = Number(size.height);
        this.pageWidth = Number(size.width);
      })
      .onVisibleAreaChange([0], (visible: boolean) => { if (visible) this.play(); else this.stop(); })
  }

  @Builder
  private Hero() {
    Column({ space: this.wide() ? 16 : 20 }) {
      WelcomeBrandFlow({ markSize: this.landscape() ? 216 : this.wide() ? 184 : 156, sweep: true })
      Row() {
        ForEach(this.word().split(''), (letter: string, index: number) => {
          Stack() { this.Glyph(letter, this.word().length > 12 ? 25 : 30); }
            .opacity(this.clamp(this.progress(index)*3)*(1-this.exitProgress()))
            .translate({ x: this.glyphOffset(index) })
            .scale({ x: 1+this.bump(index)*0.045, y: 1+this.bump(index)*0.045 })
        }, (letter: string, index: number) => `${this.phraseIndex()}-${index}-${letter}`)
      }.height(48).accessibilityLevel('no-hide-descendants')
    }.width('100%').margin({ bottom: this.wide() ? 32 : 0 })
  }

  @Builder
  private Actions() {
    Column({ space: G.welcomeButtonGap }) {
      this.Action(false)
      this.Action(true)
      Button({ type: ButtonType.Normal }) {
        Row({ space: 5 }) {
          Text(RemoteI18n.t('home.exploreMiniApps')).fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor(this.wide() ? MUTED : $r('app.color.welcome_secondary'))
          SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor([this.wide() ? MUTED : $r('app.color.welcome_secondary')])
        }
      }.height(44).width('100%').backgroundColor(TRANSPARENT).onClick(this.onMiniApps)
    }.width('100%').constraintSize({ maxWidth: this.wide() ? 400 : G.welcomeMaxWidth })
      .padding({ left: G.welcomeGutter, right: G.welcomeGutter, top: this.wide() ? 0 : G.welcomeGutter,
        bottom: this.wide() ? 0 : G.welcomeDockBottom })
      .backgroundColor(this.wide() ? TRANSPARENT : $r('app.color.welcome_dock'))
      .borderRadius({ topLeft: G.welcomeDockRadius, topRight: G.welcomeDockRadius })
  }
  @Builder
  private Glyph(letter: string, size: number) {
    if (letter === 'i') {
      Stack({ alignContent: Alignment.Top }) {
        Text('ı').fontSize(size).fontWeight(FontWeight.Medium).fontColor(INK)
        Circle().width(size*0.14).height(size*0.14).fill($r('app.color.brand_dot')).translate({ y: size*0.25 })
      }
    } else {
      Text(letter).fontSize(size).fontWeight(FontWeight.Medium).fontColor(INK)
    }
  }

  @Builder
  private Action(scan: boolean) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 10 }) {
        if (scan) { Image($r('app.media.welcome_scan')).width(20).height(20) }
        Text(RemoteI18n.t(scan ? 'home.welcome_scan' :
          (this.signedIn ? 'home.connectComputer' : 'home.welcome_login'))).fontSize(MobileDesignTypography.labelMedium.size).fontWeight(FontWeight.Medium).fontColor(this.wide() ? (scan ? INK : PAGE_BG) : $r('app.color.welcome_button_label'))
      }.justifyContent(FlexAlign.Center)
    }.width('100%').height(G.welcomeButtonHeight).borderRadius(28)
    .backgroundColor(this.wide() ? (scan ? SOFT : INK) : $r('app.color.welcome_button')).onClick(() => { if(scan) this.onScan(); else this.onLogin(); })
  }
}
