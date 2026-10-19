import { MobileDesignGeometry } from '../../generated/MobileDesignTokens';
import { AppShellState } from '../state/AppShellState';
import { ConversationLayoutPolicy } from '../policy/ConversationLayoutPolicy';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import { ImmersiveSurfaceSupport } from './ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';
import {
  PAGE_BG,
  SCRIM,
  SHELL_SCRIM,
  SIDEBAR_BG,
  TRANSPARENT,
} from './Theme';

@ComponentV2
export struct AppShell {
  @Param shellState: AppShellState = new AppShellState();
  @Param useWideLayout: boolean = false;
  @Param allowSidebar: boolean = true;
  @Param compactAccountLogin: boolean = false;
  @Param settingsPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Settings);
  @Param connectPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Connect);
  @BuilderParam content: () => void = this.EmptyBuilder;
  @BuilderParam sidebar: () => void = this.EmptyBuilder;
  @BuilderParam settings: () => void = this.EmptyBuilder;
  @BuilderParam connect: () => void = this.EmptyBuilder;
  @Event onCloseSidebar: () => void = () => {};
  @Local shellWidth: number = 440;

  build() {
    Stack({ alignContent: Alignment.Start }) {
      Column().width(0).height(0)
        .bindContentCover(this.shellState.showSettings && this.compactAccountLogin,
          this.CompactLoginCover(), {
            backgroundColor: TRANSPARENT,
            modalTransition: ModalTransition.NONE,
            enableSafeArea: true,
            onWillDismiss: (action: DismissContentCoverAction): void => {
              this.shellState.showSettings = false;
              action.dismiss();
            }
          })

      // The open drawer's fill is a floor under the whole shell, not a panel
      // the width of the sidebar. The content card's rounded corners have to
      // curve onto something: when the fill stopped at the card's left edge
      // they curved onto the page white instead, so a square-cornered grey
      // block sat against a rounded card with a white wedge between them.
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor(SIDEBAR_BG)
        // The cutout is an avoid area of its own, so the floor claims it too: a
        // notch the framework would otherwise leave bare has to end up under the
        // same fill the rest of the window is. The floor is the window itself —
        // full width and full height — so it names all four edges.
        // `expandSafeArea` is per edge and takes effect only where this
        // component's boundary meets that edge's safe-area boundary, so claiming
        // the top strip with `TOP` says nothing about the side strip a rotated
        // cutout lands on: without `START`/`END` the fill stops at the inset and
        // the page colour shows beside it.
        .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
          [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
        .hitTestBehavior(HitTestMode.None)
        .opacity((this.allowSidebar && this.shellState.showSidebar) ? 1 : 0)
        // Matched to the content card rather than to the sidebar panel: the
        // card must never finish moving before the floor it curves onto has
        // finished fading, in either direction.
        .animation({
          duration: (this.allowSidebar && this.shellState.showSidebar) ? 320 : 250,
          curve: Curve.EaseOut
        })

      Column() {
        // The drawer is a compact affordance. Wide layouts put the same session
        // list in the master pane instead, and this copy stayed mounted behind
        // an opacity of 0 — invisible, but rebuilt on every selection change,
        // which on a tablet doubled the cost of switching sessions. Compact
        // keeps it mounted so opening and closing still cross-fades.
        if (!this.useWideLayout || (this.allowSidebar && this.shellState.showSidebar)) {
          this.sidebar()
        }
      }
      .width(this.sidebarWidth())
      .height('100%')
      .alignItems(HorizontalAlign.Start)
      .opacity((this.allowSidebar && this.shellState.showSidebar) ? 1 : 0)
      .translate({ x: (this.allowSidebar && this.shellState.showSidebar) ? '0%' : '-10%' })
      .animation({
        duration: (this.allowSidebar && this.shellState.showSidebar) ? 300 : 220,
        curve: Curve.EaseOut
      })

      Stack({ alignContent: Alignment.Start }) {
        Column() {
          this.content()
        }
        .width('100%')
        .height('100%')
        .bindSheet($$this.shellState.showConnectSheet, this.ConnectSheetContent(), this.connectSheetOptions())

        if ((this.allowSidebar && this.shellState.showSidebar)) {
          Column() {
          }
          .width('100%')
          .height('100%')
          .backgroundColor(PAGE_BG)
          .opacity(0.62)
          .transition(TransitionEffect.opacity(0)
            .animation({ duration: 210, curve: Curve.EaseOut }))
          .onClick(() => {
            this.onCloseSidebar();
          })
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor(PAGE_BG)
      .borderRadius((this.allowSidebar && this.shellState.showSidebar) ? 28 : 0)
      .clip(true)
      .shadow({
        radius: (this.allowSidebar && this.shellState.showSidebar) ? 34 : 0,
        color: (this.allowSidebar && this.shellState.showSidebar) ? SHELL_SCRIM : TRANSPARENT,
        offsetX: (this.allowSidebar && this.shellState.showSidebar) ? -10 : 0
      })
      .blur((this.allowSidebar && this.shellState.showSidebar) ? 1.1 : 0)
      .scale({
        x: (this.allowSidebar && this.shellState.showSidebar) ? 0.985 : 1,
        y: (this.allowSidebar && this.shellState.showSidebar) ? 0.992 : 1,
        centerX: '0%',
        centerY: MobileDesignGeometry.conversationHeaderHeight / 2
      })
      .translate({ x: (this.allowSidebar && this.shellState.showSidebar) ? this.sidebarWidth() : 0 })
      .animation({
        duration: (this.allowSidebar && this.shellState.showSidebar) ? 320 : 250,
        curve: Curve.EaseOut
      })
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.shellWidth = this.areaLength(newArea.width);
    })
    .bindSheet(this.shellState.showSettings && !this.compactAccountLogin,
      this.SettingsSheetContent(), this.settingsSheetOptions())

  }

  @Builder
  private CompactLoginCover() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column().width('100%').height('100%').backgroundColor(SCRIM)
        // The scrim is the cover's own background over the whole shell, so a bare
        // notch would read as a hole in the dimming: it claims the cutout too.
        // Like the floor it is the whole shell, so it names the same four edges:
        // a rotated cutout sits on a side edge, and the scrim has to reach it or
        // the dimming has a hole in it.
        .expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT],
          [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END])
        .onClick(() => { this.shellState.showSettings = false; })
      Scroll() {
        Column() { this.settings() }
          .width('100%')
      }
      .width(Math.min(MobileDesignGeometry.loginSheetMaxWidth,
        this.shellWidth - 2 * MobileDesignGeometry.loginSheetOuterMargin))
      .scrollBar(BarState.Off)
      .backgroundColor(PAGE_BG)
      .borderRadius(MobileDesignGeometry.sheetTopRadius)
      .clip(true)
      // The cover is bound with `enableSafeArea: true`, so the framework already
      // ends its page above the navigation bar and this stays the design's own
      // float above that edge.
      .margin({ bottom: MobileDesignGeometry.loginSheetOuterMargin })
    }
    .width('100%')
    .height('100%')
  }

  /**
   * The Settings sheet's content, wrapped so the shell owns what the sheet shows.
   *
   * The wrapper carries no chrome of its own any more: the sheet is the
   * platform's, so its background, its rounded corners and its shadow are the
   * platform's too. What is left is the geometry the shell decided — the sheet's
   * own box, full width and full height.
   */
  @Builder
  private SettingsSheetContent() {
    Column() {
      this.settings()
    }
    .width('100%')
    .height(this.compactAccountLogin ? undefined : '100%')
  }

  @Builder
  private ConnectSheetContent() {
    Column() {
      this.connect()
    }
    .width('100%')
    .height('100%')
  }

  private sidebarWidth(): number {
    if (this.shellWidth <= 0) {
      return 280;
    }
    if (this.shellWidth < ConversationLayoutPolicy.MD_MIN_WIDTH) {
      return Math.min(280, Math.max(220, Math.round(this.shellWidth * 0.68)));
    }
    return Math.min(420, Math.max(280, Math.round(this.shellWidth * 0.35)));
  }

  private settingsSheetOptions(): SheetOptions {
    const options = AdaptiveSheetOptions.fromPlacement(
      this.settingsPlacement,
      RemoteI18n.t('settings.title')
    );
    options.onWillDismiss = (action: DismissSheetAction): void => {
      this.shellState.showSettings = false;
      action.dismiss();
    };
    return ImmersiveSurfaceSupport.sheetOptions(ImmersiveSurfaceScene.MODAL_SHEET, options);
  }

  private connectSheetOptions(): SheetOptions {
    const options = AdaptiveSheetOptions.fromPlacement(
      this.connectPlacement,
      RemoteI18n.t('connect.chooseConnectionTitle')
    );
    // The platform title bar's close icon, the scrim and the swipe down are the
    // connect sheet's whole way out now that its own header is gone, and all three
    // reach this: the state is reset here the way the settings sheet resets its
    // own, so a dismissed sheet is a closed one however it was dismissed.
    options.onWillDismiss = (action: DismissSheetAction): void => {
      this.shellState.showConnectSheet = false;
      action.dismiss();
    };
    return ImmersiveSurfaceSupport.sheetOptions(ImmersiveSurfaceScene.MODAL_SHEET, options);
  }

  private areaLength(value: Object): number {
    const parsed = Number.parseFloat(`${value}`);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  @Builder
  EmptyBuilder() {
    Column() {
    }
  }
}
