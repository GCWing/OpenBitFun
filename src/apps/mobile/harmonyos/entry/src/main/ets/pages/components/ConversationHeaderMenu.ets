import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { ConversationHeaderMenuItem } from '../policy/ConversationHeaderPolicy';
import { ImmersiveSurfaceSupport } from './ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';
import { INK, LINE, MUTED, SHADOW_SUBTLE, SOFT, TRANSPARENT } from './Theme';

/**
 * The node id the conversation's more-menu is anchored to.
 *
 * Two files have to agree on one string: whatever draws the platform title bar
 * hands it to `HdsNavigationIconOptions.componentId`, and the conversation opens
 * the menu against that id with `promptAction.openMenu`. It lives here, with the
 * menu it opens, so the two cannot drift into a menu that never appears.
 */
export const CONVERSATION_HEADER_MENU_ANCHOR_ID: string = 'conversation-header-menu';

/** The menu's own width in vp, and its row height in vp. */
const MENU_WIDTH: number = 292;
const MENU_ROW_HEIGHT: number = 48;

/**
 * What one open of the menu says and what a chosen row does.
 *
 * The object a `ComponentContent` is built from: `promptAction.openMenu` takes
 * the node plus one argument, so the rows and the selection callback travel as a
 * single value rather than through any state the menu could subscribe to.
 */
export class ConversationHeaderMenuParams {
  items: ConversationHeaderMenuItem[] = [];
  sectionLabel: string = '';
  onSelect: (id: string) => void = (_id: string) => {};

  constructor(
    items: ConversationHeaderMenuItem[],
    sectionLabel: string,
    onSelect: (id: string) => void
  ) {
    this.items = items;
    this.sectionLabel = sectionLabel;
    this.onSelect = onSelect;
  }
}

/**
 * The conversation's own menu: rename, the session actions, and the running
 * task's stop.
 *
 * Two chrome owners present it. Where the conversation still draws its own
 * header — the wide pane, and the design preview — the popover bubble is
 * invisible (`popupColor: TRANSPARENT` plus the floating-menu material) and this
 * root paints the card, which is the token floor when no material is drawn.
 * Where the platform title bar owns the top edge, the menu is opened with
 * `promptAction.openMenu` against the bar's own icon, and then the platform's
 * menu bubble carries the background and this root must paint nothing at all:
 * two backgrounds on one bubble is the sheet-chrome mistake in another place.
 */
@ComponentV2
export struct ConversationHeaderMenu {
  @Param items: ConversationHeaderMenuItem[] = [];
  @Param sectionLabel: string = '';
  /** True only where this root is the bubble; false under the platform's menu. */
  @Param paintsOwnCard: boolean = true;
  @Event onSelect: (id: string) => void = (_id: string) => {};

  build() {
    Column() {
      Text(this.sectionLabel)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(MUTED)
        .width('100%')
        .height(28)
        .padding({ left: 8 })
      ForEach(this.items, (item: ConversationHeaderMenuItem) => {
        // One root per item: the group separator belongs to the row it precedes
        // rather than to the list, so the diff key stays the row's own id.
        Column() {
          if (item.startsGroup) {
            Divider().strokeWidth(1).color(LINE).margin({ top: 8, bottom: 8 })
          }
          this.MenuItem(item)
        }
        .width('100%')
      }, (item: ConversationHeaderMenuItem) => item.id)
    }
    .width(MENU_WIDTH)
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .backgroundColor(this.paintsOwnCard ?
      ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.FLOATING_MENU) : TRANSPARENT)
    .border(this.menuBorder())
    .borderRadius(16)
    .shadow(this.menuShadow())
    .transition(TransitionEffect.translate({ x: 8, y: -8 })
      .combine(TransitionEffect.opacity(0))
      .animation({ duration: 180, curve: Curve.EaseOut }))
  }

  private menuBorder(): BorderOptions {
    if (!this.paintsOwnCard) {
      return { width: 0, color: TRANSPARENT };
    }
    return ImmersiveSurfaceSupport.surfaceBorder(ImmersiveSurfaceScene.FLOATING_MENU, { width: 0.5 });
  }

  private menuShadow(): ShadowOptions {
    if (!this.paintsOwnCard) {
      return { radius: 0, color: TRANSPARENT };
    }
    return ImmersiveSurfaceSupport.surfaceShadow(ImmersiveSurfaceScene.FLOATING_MENU,
      { radius: 18, color: SHADOW_SUBTLE, offsetY: 7 });
  }

  @Builder
  private MenuItem(item: ConversationHeaderMenuItem) {
    Row({ space: 10 }) {
      this.MenuIcon(item.icon)
      Text(RemoteI18n.t(item.labelKey))
        .fontSize(MobileDesignTypography.titleSmall.size)
        .fontColor(INK)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .height(MENU_ROW_HEIGHT)
    .padding({ left: 8, right: 8 })
    .borderRadius(10)
    .backgroundColor(item.selected ? SOFT : TRANSPARENT)
    .onClick(() => {
      this.onSelect(item.id);
    })
  }

  /**
   * The row's glyph, named by the item rather than carried as a resource.
   *
   * A policy may not hold a `$r()` — it is a pure file that runs on the host too
   * — so the item names its icon and the one place that draws it maps the name.
   * An unmapped name falls back to the gear, which is the row shape the platform
   * already shows for an action with no glyph of its own.
   */
  @Builder
  private MenuIcon(icon: string) {
    if (icon === 'remote_actions_rename') {
      SymbolGlyph($r('sys.symbol.square_and_pencil')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_link') {
      SymbolGlyph($r('sys.symbol.link')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_check') {
      SymbolGlyph($r('sys.symbol.checkmark_circle')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_folder') {
      SymbolGlyph($r('sys.symbol.folder')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_cloud') {
      SymbolGlyph($r('sys.symbol.cloud')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else {
      SymbolGlyph($r('sys.symbol.gearshape')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    }
  }
}

/**
 * The menu as a `ComponentContent` builder.
 *
 * `promptAction.openMenu` takes a node built from a global `@Builder` function,
 * which cannot be a struct's own method — a member builder handed across a call
 * belongs to the struct it came from, which is the crash the drawer's session
 * menu already paid for. So the rows live in `ConversationHeaderMenu` and this
 * function is the one shape the platform API accepts: one parameter object in,
 * the same component out, with the material left to the platform's bubble.
 */
@Builder
export function conversationHeaderMenuBuilder(params: ConversationHeaderMenuParams) {
  ConversationHeaderMenu({
    items: params.items,
    sectionLabel: params.sectionLabel,
    paintsOwnCard: false,
    onSelect: params.onSelect
  })
}
