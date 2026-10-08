import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignTypography, MobileDesignGeometry as G } from '../../generated/MobileDesignTokens';
import { MotionPreference } from '../../services/MotionPreference';
import { WindowInsetsBinding, WindowSystemBarService } from '../../services/WindowSystemBarService';
import { WelcomeBrandFlow } from './WelcomeBrandFlow';
import { INK, PAGE_BG, WELCOME_PAGE_BG, MUTED, TRANSPARENT } from './Theme';

/**
 * A welcome composition with the C staggered-slide phrase timeline.
 *
 * The window layout mode is not this page's business any more: it used to switch
 * the whole shell in and out of full-screen as the compact welcome page came and
 * went, which left every other page — the chat page above all — laid out without
 * it. The shell runs immersive for every page now, and this page only reserves
 * the status bar for its own header.
 */
@ComponentV2
export struct WelcomeHome {
  @Param signedIn: boolean = false;
  @Event onLogin: () => void = () => {};
  @Event onMiniApps: () => void = () => {};
  @Local elapsed: number = 0;
  @Local pageHeight: number = 700;
  @Local pageWidth: number = 390;
  @Local topInset: number = 0;
  // The dock paints into the strip (expandSafeArea carries its background to
  // the screen edge), so its buttons read the strip: the design's own clearance
  // where it is already taller than the indicator, the indicator's height
  // where it is not.
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  private timer: number = -1;
  private started: number = 0;

  aboutToAppear(): void {
    this.readTopInset();
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.stop();
    this.insets.unbind();
  }

  private readTopInset(): void {
    const context = this.getUIContext().getHostContext();
    if (!context) {
      return;
    }
    void WindowSystemBarService.topSystemInsetPx(context).then((topInsetPx: number): void => {
      this.topInset = this.getUIContext().px2vp(topInsetPx);
    });
  }

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
          Column() {
            Column() { this.Hero() }
              .justifyContent(FlexAlign.Center).width('100%')
              .layoutWeight(1)
              .constraintSize({ minHeight: 300 })
              .padding({ bottom: 24 })
            this.Actions()
          }.width('100%').height(Math.max(0,
            this.pageHeight - this.topInset - G.welcomeHeaderHeight))
        }
      }.width('100%')
    }.width('100%').height('100%').scrollBar(BarState.Off).backgroundColor(WELCOME_PAGE_BG)
      .padding({ top: this.topInset })
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
      this.Action()
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
        bottom: this.wide() ? 0 : this.insets.bottomPadding(G.welcomeDockBottom) })
      .backgroundColor(this.wide() ? TRANSPARENT : $r('app.color.welcome_dock'))
      // The dock's fill reaches the bottom edge of the screen. The cutout is a
      // separate avoid area from the system bars, so it is claimed here too.
      //
      // Only the bottom edge is named, and deliberately so. The cutout reaches a
      // side edge only while the window is wide — a landscape phone is ~790vp and
      // a landscape foldable is wider still — and at 600vp this page already
      // swaps the dock for its `wide()` composition, where the dock is a centred
      // column capped at 400vp with no fill of its own and the hero's own
      // background carries the page. So the compact composition this fill belongs
      // to is exactly the composition in which the side strips are 0, and a
      // `START`/`END` claim here could never take effect: it would name edges
      // whose safe-area boundary this column does not sit on.
      .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT], [SafeAreaEdge.BOTTOM])
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
  private Action() {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 10 }) {
        Text(RemoteI18n.t(this.signedIn ? 'home.connectComputer' : 'home.welcome_login'))
          .fontSize(MobileDesignTypography.labelMedium.size).fontWeight(FontWeight.Medium).fontColor(this.wide() ? PAGE_BG : $r('app.color.welcome_button_label'))
      }.justifyContent(FlexAlign.Center)
    }.width('100%').height(G.welcomeButtonHeight).borderRadius(28)
    .backgroundColor(this.wide() ? INK : $r('app.color.welcome_button')).onClick(this.onLogin)
  }
}
