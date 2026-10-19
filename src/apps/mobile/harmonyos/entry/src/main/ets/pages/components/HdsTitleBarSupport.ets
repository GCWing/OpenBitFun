/**
 * The wiring between the top chrome and the platform's HDS title bar.
 *
 * The compact conversation route hands its header to the platform: the band's
 * title, its back control and its menu are `HdsNavDestination.titleBar` content,
 * and the band's gradient blur and immersive material are its style. This file is
 * the one place that asks the two questions behind that handover and turns the
 * answers into platform values:
 *
 * 1. *What can this device name?* — `HdsTitleBarPolicy.decide()` against the facts
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
import { CARD, INK, MUTED, PAGE_BG_OVERLAY, TRANSPARENT } from './Theme';

/**
 * What one band says and what its controls do.
 *
 * The content is the caller's — only the call site knows which conversation is
 * open and which chrome owns the drawer — while the style is this file's, so the
 * tier table has one consumer per platform value rather than one per call site.
 */
export interface HdsTitleBarContentParams {
  /** The band's title: the session's name, or the surface's fallback. */
  mainTitle: string;
  /** The band's second line; empty for a surface that has none. */
  subTitle: string;
  /** True where this band is the top of a pushed page and shows a back control. */
  showBack: boolean;
  /** The back control's image — the app's approved return asset. */
  backIcon: ResourceStr;
  /** The back control's accessibility label. */
  backLabel: string;
  /** The menu trigger's image — the app's approved overflow asset. */
  menuIcon: ResourceStr;
  /** The menu trigger's accessibility label. */
  menuLabel: string;
  /**
   * The id the anchored menu is opened against: the platform hands this to the
   * trigger's own node, and the conversation opens its menu with it.
   */
  menuAnchorId: string;
  onBack: () => void;
  onMenu: () => void;
}

/**
 * What the band's two controls do, which is the only part a call site owns.
 *
 * The text is the conversation header's own projection, so both the app root and
 * the preview resolve it through `ConversationHeaderPolicy` and the band cannot
 * say something the content area disagrees with.
 */
export interface HdsTitleBarHooks {
  /** True where this band is the top of a pushed page and shows a back control. */
  showBack: boolean;
  onBack: () => void;
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
   * The title and the subtitle are the header's own projection and every asset
   * and label is the app's existing one, so the app root and the immersive
   * preview's title bar scenario cannot describe the same band differently: the
   * preview imports this method rather than restating what a band is made of.
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
      showBack: hooks.showBack,
      backIcon: $r('app.media.remote_ref_back'),
      backLabel: RemoteI18n.t('common.back'),
      menuIcon: $r('app.media.remote_ref_more'),
      menuLabel: RemoteI18n.t('sidebar.more'),
      menuAnchorId: CONVERSATION_HEADER_MENU_ANCHOR_ID,
      onBack: hooks.onBack,
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
        // The platform's own back control, carrying the app's asset: a pushed
        // conversation leaves for the home screen, which is where the drawer is.
        backIcon: {
          icon: params.backIcon,
          label: params.backLabel,
          isEnabled: params.showBack,
          action: (): void => {
            params.onBack();
          }
        },
        menu: {
          value: [{
            content: {
              icon: params.menuIcon,
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
        // The two controls keep the card chrome the conversation's own header
        // drew them with; the colour is a theme resource, so the platform's
        // inversion follows the appearance like every other surface here.
        menuStyle: {
          backgroundColor: CARD,
          iconColor: INK
        },
        backIconStyle: {
          backgroundColor: CARD,
          iconColor: INK
        }
      }
    };
  }
}
