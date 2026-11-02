import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import {
  ACCENT,
  CARD,
  CONTENT_ON_ACTION,
  INK,
  LINE,
  MUTED,
  PAGE_BG,
  SHADOW_SUBTLE,
  SOFT,
  TRANSPARENT,
} from './Theme';
import { CompactMenuButton } from './CompactMenuButton';
import { NavigationBackButton } from './NavigationBackButton';
import { SidebarToggleButton } from './SidebarToggleButton';
import { ImmersiveSurfaceSupport } from './ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';

const HEADER_ACTION_SURFACE_SIZE: number = 42;

/**
 * The overflow trigger's glyph size, in vp.
 *
 * The platform's own title-bar chip puts the system four-dot symbol in a 24vp
 * slot, and this is the same symbol for the same action on the self-drawn band,
 * so it keeps that size inside the app's larger 42vp circle: the two postures
 * show one trigger at one optical weight.
 */
const HEADER_ACTION_GLYPH_SIZE: number = 24;

@ComponentV2
export struct ConversationHeader {
  @Param title: string = '';
  @Param subtitle: string = '';
  @Param titleFallback: string = '';
  @Param allowRename: boolean = false;
  @Param showActions: boolean = false;
  @Param showSidebarButton: boolean = true;
  @Param showBackButton: boolean = false;
  /**
   * Set when something behind the header is meant to show through — a
   * conversation whose transcript scrolls underneath it. The caller owns the
   * fill and the blur in that case; painting an opaque page colour here would
   * cover both.
   */
  @Param translucent: boolean = false;
  /**
   * Set where the platform's title bar owns the top edge of the page.
   *
   * Then this header is not a header at all: the bar carries the title, the back
   * control and the menu, and what is left here is the one thing the platform has
   * no control for — the session's rename row, which opens in the content area
   * under the bar. The row band, its leading control and its own overflow control
   * are all suppressed rather than drawn under a bar that already shows them.
   */
  @Param platformBar: boolean = false;
  /**
   * How many times something outside this header asked for the rename row.
   *
   * The row is the header's own, and where the platform draws the chrome the
   * request arrives from the title bar's menu, which is a different component:
   * a counter is the whole handover, so the second request opens the row again
   * while an unrelated rebuild does not.
   */
  @Param renameRequest: number = 0;
  @Param showSidebarRestoreButton: boolean = false;
  @Param showActionsMenu: boolean = false;
  @BuilderParam actionsMenu: () => void = this.EmptyBuilder;
  @Event onOpenSidebar: () => void = () => {};
  @Event onRestoreSidebar: () => void = () => {};
  @Event onBack: () => void = () => {};
  @Event onOpenActions: () => void = () => {};
  @Event onActionsMenuStateChange: (visible: boolean) => void = (_visible: boolean) => {};
  @Event onRenameSession: (title: string) => void = (_title: string) => {};
  @Local showTitleEditor: boolean = false;
  @Local renameTitle: string = '';

  /**
   * The rename row was asked for by whoever owns the menu.
   *
   * A request is not a state: the row closes when its own save or cancel is used
   * and stays closed until the next request, so the counter is compared against
   * the header's own memory of it rather than mirrored into a boolean.
   */
  @Monitor('renameRequest')
  onRenameRequested(): void {
    if (this.platformBar && this.allowRename) {
      this.renameTitle = this.title;
      this.showTitleEditor = true;
    }
  }

  build() {
    Column() {
      if (!this.platformBar) {
        this.HeaderRow()
      }
      if (this.showTitleEditor) {
        this.TitleEditor()
      }
    }
    .width('100%')
    .backgroundColor((this.translucent || this.platformBar) ? TRANSPARENT : PAGE_BG)
  }

  @Builder
  private HeaderRow() {
    Row({ space: 8 }) {
      this.LeadingControl()
      this.TitleBlock()
      this.TrailingControl()
    }
    .width('100%')
    .height(MobileDesignGeometry.conversationHeaderHeight)
    .alignItems(VerticalAlign.Center)
    .padding({
      left: MobileDesignGeometry.contentGutter,
      right: MobileDesignGeometry.contentGutter,
      top: 8,
      bottom: 8
    })
    .backgroundColor(this.translucent ? TRANSPARENT : PAGE_BG)
  }

  @Builder
  private TitleBlock() {
    Column({ space: 3 }) {
      Text(this.resolvedTitle())
        .fontSize(this.hasSubtitle() ? MobileDesignTypography.conversationHeaderTitle.size :
          MobileDesignTypography.titleMedium.size)
        .lineHeight(this.hasSubtitle() ? MobileDesignTypography.conversationHeaderTitle.lineHeight :
          MobileDesignTypography.titleMedium.lineHeight)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .textAlign(TextAlign.Center)
        .onClick(() => {
          if (!this.allowRename) {
            return;
          }
          this.renameTitle = this.title;
          this.showTitleEditor = true;
        })
      if (this.hasSubtitle()) {
        Text(this.subtitle)
          .fontSize(MobileDesignTypography.labelMedium.size)
          .lineHeight(MobileDesignTypography.labelMedium.lineHeight)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .textAlign(TextAlign.Center)
      }
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  private LeadingControl() {
    if (this.showSidebarRestoreButton) {
      SidebarToggleButton({
        restore: true,
        controlSize: MobileDesignGeometry.controlTouchSize,
        onToggle: this.onRestoreSidebar
      })
    } else if (this.showBackButton) {
      NavigationBackButton({
        controlSize: MobileDesignGeometry.controlTouchSize,
        onBack: (): void => {
          this.onBack();
        }
      })
    } else if (this.showSidebarButton) {
      CompactMenuButton({
        controlSize: MobileDesignGeometry.controlTouchSize,
        onOpen: () => {
          this.onOpenSidebar();
        }
      })
    } else {
      Blank()
        .width(MobileDesignGeometry.controlTouchSize)
        .height(MobileDesignGeometry.controlTouchSize)
    }
  }

  @Builder
  private TrailingControl() {
    if (this.showActions) {
      Button() {
        Stack({ alignContent: Alignment.Center }) {
          // The same four-dot system symbol the compact band's trigger carries, so
          // one action has one glyph on both postures. The glyph is sized by
          // `fontSize` alone: a `SymbolGlyph` forced to a width by
          // `.width()`/`.height()` draws its ink left-anchored in the forced box
          // rather than scaling, and HDS's own slot puts this symbol in 24vp.
          SymbolGlyph($r('sys.symbol.square_grid_2x2'))
            .fontSize(HEADER_ACTION_GLYPH_SIZE)
            .fontColor([INK])
        }
        .width(HEADER_ACTION_SURFACE_SIZE)
        .height(HEADER_ACTION_SURFACE_SIZE)
        .backgroundColor(CARD)
        .borderRadius(HEADER_ACTION_SURFACE_SIZE / 2)
        .shadow({ radius: 30, color: SHADOW_SUBTLE, offsetY: 7 })
        .hitTestBehavior(HitTestMode.None)
      }
      .width(MobileDesignGeometry.controlTouchSize)
      .height(MobileDesignGeometry.controlTouchSize)
      .padding(0)
      .backgroundColor(TRANSPARENT)
      .borderRadius(MobileDesignGeometry.controlTouchSize / 2)
      .stateEffect(true)
      .accessibilityText(RemoteI18n.t('sidebar.more'))
      .bindPopup(this.showActionsMenu, ImmersiveSurfaceSupport.popupOptions(ImmersiveSurfaceScene.FLOATING_MENU, {
        builder: () => {
          this.actionsMenu();
        },
        placement: Placement.BottomRight,
        popupColor: TRANSPARENT,
        enableArrow: false,
        autoCancel: true,
        mask: false,
        targetSpace: 8,
        onStateChange: (event) => {
          this.onActionsMenuStateChange(event.isVisible);
        }
      }))
      .onClick(() => {
        this.showTitleEditor = false;
        this.onOpenActions();
      })
    } else {
      Blank()
        .width(MobileDesignGeometry.controlTouchSize)
        .height(MobileDesignGeometry.controlTouchSize)
    }
  }

  @Builder
  private TitleEditor() {
    Row({ space: 8 }) {
      TextInput({ placeholder: RemoteI18n.t('chat.sessionTitle'), text: this.renameTitle })
        .layoutWeight(1)
        .height(42)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .backgroundColor(CARD)
        .borderRadius(14)
        .padding({ left: 12, right: 12 })
        .border({ width: 1, color: LINE })
        .defaultFocus(false)
        .onChange((value: string) => {
          this.renameTitle = value;
        })
      Text(RemoteI18n.t('common.save'))
        .width(52)
        .height(42)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(CONTENT_ON_ACTION)
        .textAlign(TextAlign.Center)
        .backgroundColor(this.renameTitle.trim().length > 0 ? ACCENT : SOFT)
        .borderRadius(14)
        .onClick(() => {
          if (this.renameTitle.trim().length > 0) {
            this.onRenameSession(this.renameTitle.trim());
            this.showTitleEditor = false;
          }
        })
      Text(RemoteI18n.t('common.cancel'))
        .width(52)
        .height(42)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(INK)
        .textAlign(TextAlign.Center)
        .backgroundColor(SOFT)
        .borderRadius(14)
        .onClick(() => {
          this.showTitleEditor = false;
        })
    }
    .width('100%')
    .padding({
      left: MobileDesignGeometry.contentGutter,
      right: MobileDesignGeometry.contentGutter,
      top: 10,
      bottom: 8
    })
    .backgroundColor(PAGE_BG)
  }

  private resolvedTitle(): string {
    if (this.title.length > 0) {
      return this.title;
    }
    return this.titleFallback;
  }

  private hasSubtitle(): boolean {
    return this.subtitle.length > 0;
  }

  @Builder
  private EmptyBuilder() {
  }
}
