import { HarnessProfileMenu } from './HarnessProfileMenu';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, INK, LINE, PAGE_BG, PAGE_BG_FADE, SHADOW_FAINT, SHADOW_SUBTLE, SOFT, SUBTLE, TRANSPARENT } from './Theme';
import { SidebarToggleButton } from './SidebarToggleButton';
import { SidebarGlyph } from './SidebarGlyphs';
import { SidebarConnectionActionPolicy } from '../policy/SidebarConnectionActionPolicy';

/** Device and workspace navigation shared by compact and wide controllers. */
@ComponentV2
export struct AppSidebar {
  @Param connectionState: string = 'idle';
  @Param isBusy: boolean = false;
  @Param workspaceKind: string = 'normal';
  @Param workspacePath: string = '';
  @Param controlTargetDeviceId: string = '';
  @Param supportsHarnessProfiles: boolean = false;
  @Local showCreateMenu: boolean = false;
  @Param accountUserId: string = '';
  @Param controlTargetType: string = 'none';
  @Param showCollapseButton: boolean = false;
  @Param showViewSettingsButton: boolean = false;
  @Param showWorkspaceSection: boolean = false;
  @Event onClose: () => void = () => {};
  @Event onOpenMiniApps: () => void = () => {};
  @Event onNewChat: (agentType: string) => void = (_agentType: string) => {};
  @Event onEnterCode: () => void = () => {};
  @Event onScanDesktop: () => void = () => {};
  @Event onCollapse: () => void = () => {};
  @Event onOpenViewSettings: () => void = () => {};
  @Event onSearchQueryChange: (query: string) => void = (_query: string) => {};
  @Event onOpenSettings: () => void = () => {};
  @Event onOpenAccount: () => void = () => {};
  @Local showSearch: boolean = false;
  @Local sessionSearchQuery: string = '';
  /**
   * The authenticated device/workspace section.
   *
   * It is a slot rather than a component this file constructs because the
   * sidebar has no business knowing about remote state; the host wires it.
   */
  @BuilderParam contentSlot: () => void = this.EmptySlot;

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
                  .fontColor(INK)
                Blank()
              }.width('100%').alignItems(VerticalAlign.Center)
            }
            .width('100%').height(48).padding({ left: 4, right: 8 })
            .backgroundColor(TRANSPARENT).borderRadius(12)
            .margin({ top: 16, bottom: 16 }).stateEffect(true)
            .accessibilityText(RemoteI18n.t('miniapp.title'))
            .onClick(() => this.onOpenMiniApps())
            if (this.showWorkspaceSection) {
              this.contentSlot()
            }
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
          .padding({ bottom: this.usesCompactFooter() ? 84 : 120 })
        }
        .width('100%')
        .height('100%')
        .align(Alignment.TopStart)
        .scrollable(ScrollDirection.Vertical)
        .scrollBar(BarState.Off)

        // Pre-connection actions form a conventional footer and retain a fade.
        // Once either account or QR access unlocks the workspace, navigation
        // uses two floating controls and the scroll stays visible behind them.
        if (!this.shouldShowPrimaryNavigation()) {
          Column()
            .width('100%')
            .height(this.usesCompactFooter() ? 92 : 120)
            .hitTestBehavior(HitTestMode.None)
            .linearGradient({
              angle: 180,
              colors: [[PAGE_BG_FADE, 0.0], [PAGE_BG, 0.62]]
            })
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
    .padding({ left: 20, right: 20, top: 4, bottom: 16 })
    .backgroundColor(PAGE_BG)
  }

  @Builder
  private EmptySlot() {
  }

  @Builder
  private PrimaryNavigationHeader() {
    Row() {
      Text('OpenBitFun')
        .fontSize(MobileDesignTypography.headlineMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
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
        .backgroundColor(CARD)
        .border({ width: 0.5, color: LINE })
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
    .height(50)
    .alignItems(VerticalAlign.Center)

    if (this.showSearch) {
      TextInput({ placeholder: RemoteI18n.t('sidebar.searchPlaceholder'), text: this.sessionSearchQuery })
        .width('100%')
        .height(42)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontColor(INK)
        .placeholderColor(SUBTLE)
        .padding(0)
        .backgroundColor(SOFT)
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
          .fontColor([INK])
          .width(24)
          .height(24)
        Text(RemoteI18n.t('sidebar.devices'))
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
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
    Row() {
      Button() {
        Row({ space: 8 }) {
          SidebarGlyph({ kind: 'edit' })
          Text(RemoteI18n.t('sidebar.newChat'))
            .fontSize(MobileDesignTypography.titleMedium.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
        }
      }
      .width(98)
      .height(44)
      .padding(0)
      .backgroundColor(CARD)
      .border({ width: 0.5, color: LINE })
      .borderRadius(22)
      .shadow({ radius: 24, color: SHADOW_SUBTLE, offsetY: 7 })
      .enabled(SidebarConnectionActionPolicy.canCreateSession(this.connectionState, this.isBusy))
      .opacity(SidebarConnectionActionPolicy.canCreateSession(this.connectionState, this.isBusy) ? 1 : 0.45)
      .accessibilityText(RemoteI18n.t('sidebar.newChat'))
      .stateEffect(true)
      .bindPopup(this.showCreateMenu, {
        builder: () => { this.CreateModeMenu() },
        placement: Placement.Top,
        popupColor: TRANSPARENT,
        enableArrow: false,
        autoCancel: true,
        mask: false,
        targetSpace: 6,
        onStateChange: (event) => {
          if (!event.isVisible) this.showCreateMenu = false;
        }
      })
      .onClick(() => { this.requestChat(); })

      Blank()

      Button() {
        SidebarGlyph({ kind: 'settings' })
      }
        .width(44)
        .height(44)
        .padding(0)
        .backgroundColor(CARD)
        .borderRadius(22)
        .shadow({ radius: 24, color: SHADOW_SUBTLE, offsetY: 7 })
        .stateEffect(true)
        .onClick(() => {
          this.onOpenSettings();
        })
    }
    .width('100%')
    .height(56)
    .padding({ left: 12 })
    .alignItems(VerticalAlign.Center)
    .zIndex(2)
  }

  @Builder
  private SignedOutFooter() {
    Column({ space: 8 }) {
      if (SidebarConnectionActionPolicy.shouldShowScan(this.connectionState)) {
        Button() {
          Text(RemoteI18n.t('sidebar.scanToConnect'))
            .fontSize(MobileDesignTypography.bodyMedium.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Clip })
        }
          .width('100%')
          .height(48)
          .padding(0)
          .backgroundColor(CARD)
          .border({ width: 1, color: LINE })
          .borderRadius(16)
          .onClick(() => {
            this.onScanDesktop();
          })
      }

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
      .zIndex(2)
  }

  @Monitor('controlTargetDeviceId', 'workspacePath', 'workspaceKind', 'connectionState', 'isBusy', 'supportsHarnessProfiles')
  private closeStaleCreateMenu(): void {
    this.showCreateMenu = false;
  }

  private requestChat(): void {
    if (!SidebarConnectionActionPolicy.canCreateSession(this.connectionState, this.isBusy)) return;
    const action = SidebarConnectionActionPolicy.chatAction(this.workspaceKind, this.supportsHarnessProfiles);
    if (action === 'choose-harness') {
      this.showCreateMenu = !this.showCreateMenu;
      return;
    }
    this.onNewChat(action === 'assistant' ? 'claw' : 'code');
  }

  @Builder
  private CreateModeMenu() {
    HarnessProfileMenu({
      onSelect: (agentType: string) => {
        this.showCreateMenu = false;
        if (SidebarConnectionActionPolicy.canCreateSession(this.connectionState, this.isBusy)) {
          this.onNewChat(agentType);
        }
      }
    })
  }

  private shouldShowPrimaryNavigation(): boolean {
    return SidebarConnectionActionPolicy.shouldShowPrimaryNavigation(
      this.accountUserId,
      this.controlTargetType,
      this.connectionState
    );
  }

  private usesCompactFooter(): boolean {
    return this.shouldShowPrimaryNavigation() ||
      !SidebarConnectionActionPolicy.shouldShowScan(this.connectionState);
  }
}
