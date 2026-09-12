import { MobileDesignGeometry } from '../../generated/MobileDesignTokens';
import { AppShellState } from '../state/AppShellState';
import { ConversationLayoutPolicy } from '../policy/ConversationLayoutPolicy';
import {
  SettingsPlacement,
  SettingsPlacementMode,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import {
  PAGE_BG,
  SCRIM,
  SHELL_SCRIM,
  TRANSPARENT,
} from './Theme';

const WIDE_SHEET_RADIUS: number = 30;

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
        centerY: '50%'
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
        .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
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
      .margin({ bottom: MobileDesignGeometry.loginSheetOuterMargin })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  private SettingsSheetContent() {
    Column() {
      this.settings()
    }
    .width('100%')
    .height(this.compactAccountLogin ? undefined : '100%')
    .borderRadius(this.usesWideSheetChrome(this.settingsPlacement) ? WIDE_SHEET_RADIUS : 0)
    .clip(this.usesWideSheetChrome(this.settingsPlacement))
    .shadow({
      radius: this.usesWideSheetChrome(this.settingsPlacement) ? 30 : 0,
      color: this.usesWideSheetChrome(this.settingsPlacement) ? SHELL_SCRIM : TRANSPARENT,
      offsetY: this.usesWideSheetChrome(this.settingsPlacement) ? 12 : 0
    })
  }

  @Builder
  private ConnectSheetContent() {
    Column() {
      this.connect()
    }
    .width('100%')
    .height('100%')
    .borderRadius(this.usesWideSheetChrome(this.connectPlacement) ? WIDE_SHEET_RADIUS : 0)
    .clip(this.usesWideSheetChrome(this.connectPlacement))
    .shadow({
      radius: this.usesWideSheetChrome(this.connectPlacement) ? 30 : 0,
      color: this.usesWideSheetChrome(this.connectPlacement) ? SHELL_SCRIM : TRANSPARENT,
      offsetY: this.usesWideSheetChrome(this.connectPlacement) ? 12 : 0
    })
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
    const options = AdaptiveSheetOptions.fromPlacement(this.settingsPlacement);
    options.onWillDismiss = (action: DismissSheetAction): void => {
      this.shellState.showSettings = false;
      action.dismiss();
    };
    return options;
  }

  private connectSheetOptions(): SheetOptions {
    return AdaptiveSheetOptions.fromPlacement(this.connectPlacement);
  }

  private usesWideSheetChrome(placement: SettingsPlacement): boolean {
    return placement.mode === SettingsPlacementMode.Side ||
      placement.mode === SettingsPlacementMode.Center;
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
