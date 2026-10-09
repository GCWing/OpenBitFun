import { SidebarToolsFooter } from './SidebarToolsFooter';
import { SavedRuntimeConnection } from '../../model/RemoteModels';
import { WorkspaceToolsIntent } from '../state/WorkspaceToolsState';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  CARD,
  INK,
  SHADOW_FAINT,
  SIDEBAR_BG,
  SIDEBAR_BG_FADE,
  SIDEBAR_HOVER,
  SIDEBAR_INK,
  SIDEBAR_LINE,
  SIDEBAR_RAISED,
  SIDEBAR_SUBTLE,
  TRANSPARENT,
} from './Theme';
import { SidebarToggleButton } from './SidebarToggleButton';
import { SidebarGlyph } from './SidebarGlyphs';
import { SidebarConnectionActionPolicy } from '../policy/SidebarConnectionActionPolicy';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

/** Device and workspace navigation shared by compact and wide controllers. */
@ComponentV2
export struct AppSidebar {
  @Param connectionState: string = 'idle';
  @Param isBusy: boolean = false;
  @Param workspaceKind: string = 'normal';
  @Param workspacePath: string = '';
  @Param controlTargetDeviceId: string = '';
  @Param supportsHarnessProfiles: boolean = false;
  @Param toolLocations: SavedRuntimeConnection[] = [];
  @Event onWorkspaceTools: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  @Param accountUserId: string = '';
  @Param controlTargetType: string = 'none';
  @Param showCollapseButton: boolean = false;
  @Param showViewSettingsButton: boolean = false;
  @Param showWorkspaceSection: boolean = false;
  @Event onClose: () => void = () => {};
  @Event onOpenMiniApps: () => void = () => {};
  @Event onNewChat: (agentType: string) => void = (_agentType: string) => {};
  @Event onEnterCode: () => void = () => {};
  @Event onCollapse: () => void = () => {};
  @Event onOpenViewSettings: () => void = () => {};
  @Event onSearchQueryChange: (query: string) => void = (_query: string) => {};
  @Event onOpenSettings: () => void = () => {};
  @Event onOpenAccount: () => void = () => {};
  @Local showSearch: boolean = false;
  @Local sessionSearchQuery: string = '';
  /**
   * The window's own insets, in vp. The panel's fill runs to its bottom edge —
   * the screen edge for the compact drawer — and the session rows scroll under
   * the navigation indicator, so the strip is the list's own business now. The
   * floating footer keeps its distance from that edge itself, which is what
   * keeps the buttons above the bar while the rows run under it. The panel's top
   * edge is the screen edge too, so the status bar strip is the panel's own
   * padding rather than a band the framework reserved for it.
   */
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  /**
   * The authenticated device/workspace section.
   *
   * It is a slot rather than a component this file constructs because the
   * sidebar has no business knowing about remote state; the host wires it.
   */
  @BuilderParam contentSlot: () => void = this.EmptySlot;

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }

  build() {
    this.SidebarContent()
  }

  @Builder
  private SidebarContent() {
    Column() {
      if (this.shouldShowPrimaryNavigation()) {
        this.PrimaryNavigationHeader()
      } else {
        this.SignedOutHeader()
      }

      Stack({ alignContent: Alignment.Bottom }) {
        // Device sections own their remote workspace and session rows.
        Scroll() {
          Column() {
            Button({ type: ButtonType.Normal }) {
              Row({ space: 14 }) {
                Stack({ alignContent: Alignment.Center }) {
                  SidebarGlyph({ kind: 'apps' })
                }.width(24).height(24)
                Text(RemoteI18n.t('miniapp.title'))
                  .fontSize(MobileDesignTypography.bodyLarge.size)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(SIDEBAR_INK)
                Blank()
              }.width('100%').alignItems(VerticalAlign.Center)
            }
            .width('100%').height(48).padding({ left: 4, right: 8 })
            .backgroundColor(TRANSPARENT).borderRadius(12)
            .margin({ top: 4, bottom: 8 }).stateEffect(true)
            .accessibilityText(RemoteI18n.t('miniapp.title'))
            .onClick(() => this.onOpenMiniApps())
            if (this.showWorkspaceSection) {
              this.contentSlot()
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ bottom: this.scrollTailPadding() })
        }
        .width('100%')
        .height('100%')
        .align(Alignment.TopStart)
        .scrollable(ScrollDirection.Vertical)
        .scrollBar(BarState.Off)

        // Pre-connection actions form a conventional footer and retain a fade.
        // Once either account or QR access unlocks the workspace, navigation
        // uses two floating controls and the scroll stays visible behind them.
        // The fade stops above the navigation bar with the controls it serves,
        // so the rows it does not cover stay readable in the strip below it.
        if (!this.shouldShowPrimaryNavigation()) {
          Column()
            .width('100%')
            .height(this.usesCompactFooter() ? 92 : 120)
            .hitTestBehavior(HitTestMode.None)
            .linearGradient({
              angle: 180,
              colors: [[SIDEBAR_BG_FADE, 0.0], [SIDEBAR_BG, 0.62]]
            })
            .margin({ bottom: this.footerBottomPadding() })
        }

        if (this.shouldShowPrimaryNavigation()) {
          this.PrimaryNavigationFooter()
        } else {
          this.SignedOutFooter()
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    // The panel's fill runs to its own bottom edge — the screen edge for the
    // compact drawer, the wide master pane's card edge in the wide host — and
    // the session rows are content that scrolls under the navigation indicator.
    // The footer, its fade and the list's tail are what keep the strip clear,
    // each against the edge this panel actually has.
    //
    // The panel's top edge is the screen edge in both hosts, so its own first
    // row is what has to keep clear of the status bar: the fill still reaches
    // the top of the window, and the title, the search field and the session
    // rows start below the strip.
    //
    // Its side edges are the screen's too, and a rotated device moves the camera
    // cutout onto one of them: the wider of the design's gutter and the cutout
    // is what the panel reserves, so the 20 the design asks for survives on a
    // device that claims no side strip at all.
    .padding({ left: this.insets.leftPadding(20), right: this.insets.rightPadding(20), top: this.insets.top })
    .backgroundColor(SIDEBAR_BG)
  }

  @Builder
  private EmptySlot() {
  }

  @Builder
  private PrimaryNavigationHeader() {
    Row() {
      Text(RemoteI18n.t('app.title'))
        .fontSize(MobileDesignTypography.headlineMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(SIDEBAR_INK)
      Blank()
      // Right-aligned so the search and collapse controls keep the same
      // position whether or not the source-specific view-settings entry shows.
      Row({ space: 6 }) {
        if (this.showViewSettingsButton) {
          Button() {
            SidebarGlyph({ kind: 'session_more' })
          }
          .width(MobileDesignGeometry.controlTouchSize)
          .height(MobileDesignGeometry.controlTouchSize)
          .padding(0)
          .backgroundColor(TRANSPARENT)
          .borderRadius(12)
          .stateEffect(true)
          .accessibilityText(RemoteI18n.t('remote.actions'))
          .onClick(() => {
            this.onOpenViewSettings();
          })
        }

        Button() {
          SidebarGlyph({ kind: 'search' })
        }
        .width(44)
        .height(44)
        .padding(0)
        .backgroundColor(SIDEBAR_RAISED)
        .border({ width: 0.5, color: SIDEBAR_LINE })
        .borderRadius(22)
        .shadow({ radius: 18, color: SHADOW_FAINT, offsetY: 5 })
        .stateEffect(true)
        .accessibilityText(RemoteI18n.t('common.search'))
        .onClick(() => {
          this.showSearch = !this.showSearch;
          if (!this.showSearch) {
            this.updateSearchQuery('');
          }
        })

        if (this.showCollapseButton) {
          SidebarToggleButton({
            controlSize: MobileDesignGeometry.controlTouchSize,
            onToggle: this.onCollapse
          })
        }
      }
    }
    .width('100%')
    .height(MobileDesignGeometry.conversationHeaderHeight)
    .alignItems(VerticalAlign.Center)

    if (this.showSearch) {
      TextInput({ placeholder: RemoteI18n.t('sidebar.searchPlaceholder'), text: this.sessionSearchQuery })
        .width('100%')
        .height(42)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontColor(SIDEBAR_INK)
        .placeholderColor(SIDEBAR_SUBTLE)
        .padding(0)
        .backgroundColor(SIDEBAR_HOVER)
        .borderRadius(8)
        .margin({ top: 12 })
        .onChange((value: string) => {
          this.updateSearchQuery(value);
        })
    }
  }

  private updateSearchQuery(value: string): void {
    this.sessionSearchQuery = value;
    this.onSearchQueryChange(value);
  }

  @Builder
  private SignedOutHeader() {
    Row() {
      Row({ space: 14 }) {
        SymbolGlyph($r('sys.symbol.desktop'))
          .fontSize(23)
          .fontColor([SIDEBAR_INK])
          .width(24)
          .height(24)
        Text(RemoteI18n.t('sidebar.devices'))
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(SIDEBAR_INK)
      }
      .layoutWeight(1)
      .height(50)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onEnterCode();
      })

      if (this.showCollapseButton) {
        SidebarToggleButton({
          controlSize: MobileDesignGeometry.controlTouchSize,
          onToggle: this.onCollapse
        })
      }
    }
    .width('100%')
    .height(50)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  private PrimaryNavigationFooter() {
    SidebarToolsFooter({
      toolsEnabled: this.connectionState === 'connected',
      onOpenTools: () => this.requestDeviceTools(),
      onOpenSettings: () => this.onOpenSettings()
    })
      .margin({ bottom: this.footerBottomPadding() })
  }

  @Builder
  private SignedOutFooter() {
    Column({ space: 8 }) {
      Button() {
        Text(RemoteI18n.t('sidebar.signInOpenBitFunAccount'))
          .fontSize(MobileDesignTypography.bodyMedium.size)
          .fontWeight(FontWeight.Bold)
          .fontColor(CARD)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Clip })
      }
        .width('100%')
        .height(48)
        .padding(0)
        .backgroundColor(INK)
        .borderRadius(16)
        .onClick(() => {
          this.onOpenAccount();
        })
    }
      .width('100%')
      .margin({ bottom: this.footerBottomPadding() })
      .zIndex(2)
  }

  private requestDeviceTools(): void {
    if (this.connectionState !== 'connected') return;
    this.onWorkspaceTools({ type: 'open-device', deviceId: this.controlTargetDeviceId, connectionId: '', tab: 0 });
  }

  private shouldShowPrimaryNavigation(): boolean {
    return SidebarConnectionActionPolicy.shouldShowPrimaryNavigation(
      this.accountUserId,
      this.controlTargetType,
      this.connectionState
    );
  }

  private usesCompactFooter(): boolean {
    return this.shouldShowPrimaryNavigation() || this.connectionState === 'connected';
  }

  /**
   * The distance the floating footer and its fade keep from the panel's own
   * bottom edge: the design's spacing where the strip is already clear of it,
   * the strip itself where it is not. In the compact drawer that edge is the
   * screen edge, so the buttons sit directly above the navigation bar; in the
   * wide master pane the edge is the floating card's, and the same number
   * keeps the buttons clear of the bar there too.
   */
  private footerBottomPadding(): number {
    return this.insets.bottomPadding(16);
  }

  /**
   * The session list's tail spacer: the floating footer's clearance plus the
   * strip. The rows roll under the footer and the navigation indicator while
   * they are moving, and the last row still rests above the bar.
   */
  private scrollTailPadding(): number {
    return (this.usesCompactFooter() ? 84 : 120) + this.insets.bottom;
  }
}
