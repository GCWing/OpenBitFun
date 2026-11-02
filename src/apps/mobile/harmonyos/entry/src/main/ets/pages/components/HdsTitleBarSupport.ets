/**
 * The wiring between the top chrome and the platform's HDS title bar.
 *
 * The compact conversation route hands its header to the platform: the band's
 * title and its menu trigger are `HdsNavDestination.titleBar` content, the return
 * control is the platform's own, and the band's gradient blur and immersive
 * material are its style. This file is the one place that asks the two questions
 * behind that handover and turns the answers into platform values:
 *
 * 1. *What can this device name?* — `HdsTitleBarSupport.decide()`, which resolves
 *    the pure policy (`resolveHdsTitleBar`) against the facts
 *    `HdsTitleBarMaterialService` read. The policy answers in its own names; the
 *    three guarded methods below are where a platform enum member is named, and
 *    each of them names a 23+ member only inside its own gate. Below API 23 the
 *    blur type stays `GRADIENT_BLUR` and the material effect is not attached at
 *    all, which is the one degradation that cannot be wrong: a member that does
 *    not exist on the device is not a value the platform can ignore.
 *
 * 2. *What does the band paint?* — the theme's own colours, never a literal. Both
 *    styles are always configured, and they differ in exactly one place: the
 *    background floor is transparent while the content is at the top and the
 *    page's overlay colour once the transcript has scrolled under the band. That
 *    is the gradient blur's two ends, and because every colour here is a
 *    `$r('app.color.*')` resource the platform's own colour inversion can act on
 *    it (the plan's note: `colorInvert` follows resource-set colours only).
 *
 * The two controls are the platform's, not the app's. The back control is
 * `HdsNavDestination`'s own — this file configures no `backIcon` at all, so the
 * platform draws its own glyph in its own circular chip — and the menu trigger is
 * the system four-dot symbol, which is the one glyph the platform sizes itself
 * (`HdsNavigationIconOptions.icon` is an `IconType`, and the modifier that carries
 * a symbol into that slot comes from `SystemSymbolIcon`, the one leaf that names
 * the platform's own symbol value). The app's own bitmaps are a 38x59 return glyph
 * and a 64x19 overflow glyph, and a square platform icon slot renders the second
 * one as a dark blob: an asset that carries its own aspect ratio belongs on a
 * surface the app sizes, not in a slot the platform sizes.
 *
 * Who reads it: `AppRootPresentation` builds the conversation route's band from
 * `options()`, and the immersive preview's title bar scenario builds the same
 * options for its fixture, so the fixture cannot drift from production.
 */

import {
  hdsMaterial,
  ScrollEffectType,
  SystemMaterialParams,
  TitleBarStyleOptions,
  HdsNavigationTitleBarOptions,
  HdsNavigationTitleBarStyle
} from '@kit.UIDesignKit';
import {
  HdsTitleBarDecision,
  HdsTitleBarPolicy,
  HdsTitleBarScene,
  resolveHdsTitleBar
} from '../policy/HdsTitleBarPolicy';
import { ConversationHeaderPresentation } from '../policy/ConversationHeaderPolicy';
import { HdsTitleBarMaterialService, HdsTitleBarSnapshot } from '../../services/HdsTitleBarMaterialService';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CONVERSATION_HEADER_MENU_ANCHOR_ID } from './ConversationHeaderMenu';
import { SystemSymbolIcon } from './SystemSymbolIcon';
import { INK, MUTED, PAGE_BG_OVERLAY, TRANSPARENT } from './Theme';

/**
 * What one band says and what its one control does.
 *
 * The content is the caller's — only the call site knows which conversation is
 * open — while the style is this file's, so the tier table has one consumer per
 * platform value rather than one per call site.
 *
 * There is no `backIcon` here because the band owns no back control: the platform
 * draws its own, and the tap reaches the call site's `.onBackPressed`. There is no
 * `showBack` either, because the platform's control is not optional either way:
 * the destination shows it and both call sites call `hideBackButton(false)`.
 */
export interface HdsTitleBarContentParams {
  /** The band's title: the session's name, or the surface's fallback. */
  mainTitle: string;
  /** The band's second line; empty for a surface that has none. */
  subTitle: string;
  /** The menu trigger's accessibility label. */
  menuLabel: string;
  /**
   * The id the anchored menu is opened against: the platform hands this to the
   * trigger's own node, and the conversation opens its menu with it.
   */
  menuAnchorId: string;
  onMenu: () => void;
}

/**
 * What the band's control does, which is the only part a call site owns.
 *
 * The text is the conversation header's own projection, so both the app root and
 * the preview resolve it through `ConversationHeaderPolicy` and the band cannot
 * say something the content area disagrees with.
 */
export interface HdsTitleBarHooks {
  onMenu: () => void;
}

export class HdsTitleBarSupport {
  /** This device's title bar tier, read once per call site build. */
  static decide(scene: HdsTitleBarScene): HdsTitleBarDecision {
    const snapshot: HdsTitleBarSnapshot = HdsTitleBarMaterialService.snapshot();
    return resolveHdsTitleBar(scene, {
      apiLevel: snapshot.apiLevel,
      immersiveMaterialSupported: snapshot.immersiveMaterialSupported
    });
  }

  /**
   * The conversation band's content, assembled once for every call site.
   *
   * The title and the subtitle are the header's own projection and the menu
   * label is the app's existing one, so the app root and the immersive
   * preview's title bar scenario cannot describe the same band differently: the
   * preview imports this method rather than restating what a band is made of.
   *
   * What is *not* here is as deliberate as what is: the band's two glyphs belong
   * to the platform, so no call site can hand it an asset of its own — which is
   * exactly how the 64x19 overflow bitmap ended up in a 24vp square slot.
   */
  static conversationParams(
    presentation: ConversationHeaderPresentation,
    hooks: HdsTitleBarHooks
  ): HdsTitleBarContentParams {
    return {
      // The policy answers with the title the session carries and the key to fall
      // back to when it has none, because a policy may not hold translated text.
      mainTitle: presentation.title.length > 0 ? presentation.title : RemoteI18n.t(presentation.fallbackKey),
      subTitle: presentation.subtitle,
      menuLabel: RemoteI18n.t('sidebar.more'),
      menuAnchorId: CONVERSATION_HEADER_MENU_ANCHOR_ID,
      onMenu: hooks.onMenu
    };
  }

  /** The band's content and style, ready for `titleBar()`. */
  static options(params: HdsTitleBarContentParams): HdsNavigationTitleBarOptions {
    return {
      // The band avoids the system area itself: it is laid out below the status bar
      // strip instead of being painted over it.
      //
      // The app runs its window full-screen, so without this the platform draws the
      // band from the top of the window and its own content — the title, the back
      // control, the menu — lands on the status bar's clock and indicators, which is
      // what every device this was measured on showed. The pair of options this
      // belongs to reads as: `avoidLayoutSafeArea` "whether the title bar actively
      // avoids the safe area", `enableComponentSafeArea` "whether the title bar is
      // set as a component-level safe area". The second one is about the band
      // absorbing the area into its own padding, and it was measured inert in this
      // window (the band's content stayed on the strip), so the one that matches the
      // posture is this one: the band yields the strip and the page keeps it.
      //
      // The strip the band yields is not free space: the pane below still has to
      // start below the band, so it reserves the strip as well as the band
      // (`HdsTitleBarPolicy.reservedBandHeight`), from the one measurement point.
      //
      // Not gated by capability: the option starts at 6.0.0(20) and the app's
      // compatibleSdkVersion is 6.0.1(21), so every device the app supports names it.
      avoidLayoutSafeArea: true,
      content: {
        title: {
          mainTitle: params.mainTitle,
          subTitle: params.subTitle
        },
        // No `backIcon` block: the platform's own control is the only one this
        // band can show, and it is reached by leaving the block out, not by
        // leaving `icon` out of it (`HdsNavigationIconOptions.icon` is optional
        // and an unconfigured one draws an empty slot). The tap arrives at the
        // destination's `.onBackPressed`, which both call sites register, so the
        // platform's own glyph and its own action stay one control.
        menu: {
          value: [{
            content: {
              // The system four-dot grid, not the app's 64x19 overflow bitmap:
              // the slot is the platform's (24vp square by default) and it owns
              // the glyph's size, so a wide three-dot asset cannot survive it.
              // `SystemSymbolIcon` is the one import of the platform's own symbol
              // value — the modifier is the whole configuration, with no `width`,
              // `height` or `fontSize` on it, because HDS sizes its own slot.
              icon: SystemSymbolIcon.modifier($r('sys.symbol.square_grid_2x2')),
              label: params.menuLabel,
              isEnabled: true,
              // The id, not the trigger: the conversation opens its own menu
              // anchored here, so the menu's rows stay where its state lives.
              componentId: params.menuAnchorId,
              action: (): void => {
                params.onMenu();
              }
            }
          }]
        }
      },
      style: HdsTitleBarSupport.style(HdsTitleBarSupport.decide(HdsTitleBarScene.Conversation))
    };
  }

  /**
   * The band's style for one decision.
   *
   * The material effect is attached only where the gate allows it, and the two
   * styles are always both configured: `originalStyle` is the band at rest,
   * `scrollEffectStyle` is the band with the transcript underneath it.
   */
  static style(decision: HdsTitleBarDecision): TitleBarStyleOptions {
    const style: TitleBarStyleOptions = {
      scrollEffectOpts: {
        enableScrollEffect: true,
        scrollEffectType: HdsTitleBarSupport.scrollEffectType(decision)
      },
      originalStyle: HdsTitleBarSupport.barStyle(false),
      scrollEffectStyle: HdsTitleBarSupport.barStyle(true)
    };
    const material: SystemMaterialParams | undefined = HdsTitleBarSupport.systemMaterial(decision);
    if (material !== undefined) {
      style.systemMaterialEffect = material;
    }
    return style;
  }

  /**
   * The blur type, with the 23+ member named only inside the gate.
   *
   * This method and `systemMaterial` are the whole reason the policy answers in
   * its own vocabulary: outside them, no file in this app names an
   * `IMMERSIVE_GRADIENT_BLUR` or a `hdsMaterial` member, so a device below API 23
   * cannot reach one by any path.
   */
  static scrollEffectType(decision: HdsTitleBarDecision): ScrollEffectType {
    if (!decision.immersiveBlur) {
      return ScrollEffectType.GRADIENT_BLUR;
    }
    return decision.scrollEffectType === HdsTitleBarPolicy.IMMERSIVE_GRADIENT_BLUR ?
      ScrollEffectType.IMMERSIVE_GRADIENT_BLUR : ScrollEffectType.GRADIENT_BLUR;
  }

  /**
   * The band's material, or `undefined` where the field must not be attached.
   *
   * `undefined` is the whole 23+ contract here, the same way it is for the
   * immersive material on a floating surface: the level is read from the policy —
   * `ADAPTIVE` only where the device reports the IMMERSIVE type, `SMOOTH`
   * everywhere else — and the type is the system's own adaptive one, which is
   * what the platform recommends for a component it renders itself.
   */
  static systemMaterial(decision: HdsTitleBarDecision): SystemMaterialParams | undefined {
    if (!decision.materialAttached) {
      return undefined;
    }
    return {
      materialType: HdsTitleBarSupport.materialTypeFor(decision),
      materialLevel: HdsTitleBarSupport.materialLevelFor(decision)
    };
  }

  private static materialTypeFor(decision: HdsTitleBarDecision): hdsMaterial.MaterialType {
    return decision.materialType === HdsTitleBarPolicy.MATERIAL_TYPE_ADAPTIVE ?
      hdsMaterial.MaterialType.ADAPTIVE : hdsMaterial.MaterialType.NONE;
  }

  private static materialLevelFor(decision: HdsTitleBarDecision): hdsMaterial.MaterialLevel {
    return decision.materialLevel === HdsTitleBarPolicy.MATERIAL_LEVEL_ADAPTIVE ?
      hdsMaterial.MaterialLevel.ADAPTIVE : hdsMaterial.MaterialLevel.SMOOTH;
  }

  /**
   * One end of the gradient: the band at rest, or the band with content under it.
   *
   * `TRANSPARENT` at the top is what lets the page's own background show through
   * while there is nothing to blur, and `PAGE_BG_OVERLAY` is the floor the theme
   * already uses for a band a transcript scrolls under — a partial-alpha page
   * colour under the blur, not a replacement for it, so the title stays legible
   * on a build or a device where the blur does not land.
   *
   * The floor, the two text lines and the platform's own return glyph's ink are
   * the whole of it. The two controls keep the platform's own chip — no
   * `menuStyle` and no `backIconStyle.backgroundColor` — because the chip is what
   * the platform draws and the app has no business recolouring it.
   *
   * The back control's *ink* is the one thing the platform cannot answer for here.
   * `HdsNavigationIconItemStyle.iconColor` defaults to the immersive pair: while
   * the floor is `TRANSPARENT` (the band at rest, over the page the app leaves
   * open) the platform paints the default glyph in `sys.color.icon_on_primary` —
   * a light, appearance-independent colour — on a chip whose fill *does* follow the
   * appearance. Measured on the phone: at rest in the light appearance the chip's
   * interior is uniformly white (luminance min 243), so the platform's own arrow
   * was invisible and the only way out of a conversation looked like an empty
   * circle; once the transcript is under the band the same glyph is drawn dark and
   * legible. The floor stays transparent — that is the immersive band, and the user
   * owns it — so the ink is stated here, from the theme, and only for the return
   * glyph: the menu trigger is a symbol modifier and already carries the theme's
   * ink, which is why it never needed this.
   */
  private static barStyle(scrolledUnder: boolean): HdsNavigationTitleBarStyle {
    return {
      backgroundStyle: {
        backgroundColor: scrolledUnder ? PAGE_BG_OVERLAY : TRANSPARENT
      },
      contentStyle: {
        titleStyle: {
          mainTitleColor: INK,
          subTitleColor: MUTED
        },
        backIconStyle: {
          iconColor: INK
        }
      }
    };
  }
}
