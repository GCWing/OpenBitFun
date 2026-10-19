import { AdaptiveLayoutInput } from './AdaptiveLayoutInput';
import {
  ConversationLayoutCrease,
  ConversationLayoutHorizontalCrease,
  ConversationLayoutPolicy
} from './ConversationLayoutPolicy';

export enum SettingsPlacementMode {
  Bottom = 'bottom',
  Center = 'center',
  Side = 'side',
  FoldOperate = 'fold_operate'
}

export enum SettingsSheetKind {
  Settings = 'settings',
  Connect = 'connect',
  SessionDetails = 'session_details',
  RemoteViewSettings = 'remote_view_settings',
  /**
   * The conversation's full-text panel. It is content rather than settings, but
   * it is placed by the same contract: an overlay sheet that must land inside a
   * foldable's leaf, and inside the operate half of a half-folded screen.
   */
  UserMessageFullText = 'user_message_full_text',
  /**
   * The workspace tools panel — the drawer's own full-height overlay, which the
   * sidebar opens over itself. It is placed by the same contract as the rest:
   * inside a leaf, inside an operate half, and in the middle of a wide window.
   */
  WorkspaceTools = 'workspace_tools'
}

export class SettingsPlacement {
  readonly mode: SettingsPlacementMode;
  readonly width: number;
  readonly height: number;
  readonly maxHeight: number;

  constructor(
    mode: SettingsPlacementMode,
    width: number,
    height: number,
    maxHeight: number
  ) {
    this.mode = mode;
    this.width = width;
    this.height = height;
    this.maxHeight = maxHeight;
  }
}

/**
 * Overlay-sheet placement from fold posture and creases, not a width boolean.
 * Does not import ArkUI types; callers assemble SheetOptions.
 *
 * Three answers, in this order, because the first two are about the hardware and
 * the last is about the window:
 *
 *   a half-folded screen's operate half, and a folded screen's own leaf, keep the
 *   sheet where the hardware leaves room for it — a centered dialog across a
 *   physical fold, or a side sheet in a leaf that is already narrow, is worse
 *   than the bottom sheet those postures have always had;
 *
 *   an expanded screen with a usable vertical crease keeps the sheet inside one
 *   leaf, which is the same decision read from the crease instead of the width;
 *
 *   every other wide window gets a centered dialog. It used to get a side sheet
 *   (docked to the trailing edge, the height of the window less its margin) or,
 *   for Settings and profile, a full-width bottom sheet at every width — a
 *   "bottom of the page" band on a screen whose page is not the whole window.
 *   A wide window is a dialog-sized one: the sheet is the width the design
 *   clamps it to and sits in the middle, with the page visible around it.
 */
export class SettingsPlacementPolicy {
  static readonly TABLET_MIN_WIDTH: number = 400;
  static readonly TABLET_MAX_WIDTH: number = 520;
  static readonly TABLET_WIDTH_RATIO: number = 0.32;
  static readonly SIDE_MAX_HEIGHT: number = 760;
  static readonly SIDE_MIN_HEIGHT: number = 560;
  static readonly SIDE_VERTICAL_MARGIN: number = 80;
  /** The gap a centered dialog keeps from the window's top and bottom edges. */
  static readonly CENTER_VERTICAL_MARGIN: number = 40;
  static readonly SESSION_DETAILS_HEIGHT: number = 560;
  static readonly REMOTE_VIEW_SETTINGS_HEIGHT: number = 520;
  /** The session action list: a short sheet wherever it is placed. */
  static readonly SESSION_ACTION_HEIGHT: number = 300;

  static compactBottom(kind: SettingsSheetKind = SettingsSheetKind.Settings): SettingsPlacement {
    return SettingsPlacementPolicy.bottomPlacement(kind);
  }

  static resolve(input: AdaptiveLayoutInput, kind: SettingsSheetKind): SettingsPlacement {
    if (input.isHoverOperate) {
      return SettingsPlacementPolicy.hoverPlacement(input, kind);
    }
    if (input.isFolded) {
      return SettingsPlacementPolicy.bottomPlacement(kind);
    }
    const usableCreases = SettingsPlacementPolicy.usableVerticalCreases(
      input.viewportWidth,
      input.verticalCreases
    );
    if (usableCreases.length > 0 && SettingsPlacementPolicy.canUseSideSheet(input)) {
      return SettingsPlacementPolicy.creaseSidePlacement(input, kind, usableCreases);
    }
    if (SettingsPlacementPolicy.isWideViewport(input) &&
      SettingsPlacementPolicy.canUseSideSheet(input)) {
      return SettingsPlacementPolicy.centerPlacement(input, kind);
    }
    return SettingsPlacementPolicy.bottomPlacement(kind);
  }

  /**
   * An overlay inside a surface that has already resolved its own placement.
   *
   * The session action list is not placed in its own right: it opens from the
   * session list, and a fold postures it exactly as it postures that list. What
   * is its own is its height — and its host's answer on a wide window, which is
   * the same centered dialog every other overlay gets. Everywhere else it keeps
   * the bottom sheet it has always been, because a leaf or an operate half is
   * not a place to widen a sheet the host deliberately kept narrow.
   */
  static hostedOverlay(host: SettingsPlacement, height: number): SettingsPlacement {
    if (host.mode !== SettingsPlacementMode.Center) {
      return new SettingsPlacement(SettingsPlacementMode.Bottom, 0, height, 0);
    }
    const bounded = host.height > 0 ? Math.min(height, host.height) : height;
    return new SettingsPlacement(SettingsPlacementMode.Center, host.width, bounded, 0);
  }

  /**
   * ArkUI SheetType.SIDE docks to the trailing edge: right in LTR, left in RTL.
   * There is no left/right switch on SheetOptions.
   */
  static sheetLeft(
    placement: SettingsPlacement,
    viewportWidth: number,
    isRtl: boolean = false
  ): number {
    if (placement.mode !== SettingsPlacementMode.Side || placement.width <= 0 || viewportWidth <= 0) {
      return 0;
    }
    return isRtl ? 0 : Math.max(0, viewportWidth - placement.width);
  }

  static sheetIntersectsVerticalCrease(
    placement: SettingsPlacement,
    crease: ConversationLayoutCrease,
    viewportWidth: number,
    isRtl: boolean = false
  ): boolean {
    if (placement.mode !== SettingsPlacementMode.Side || placement.width <= 0 || viewportWidth <= 0) {
      return false;
    }
    const sheetLeft = SettingsPlacementPolicy.sheetLeft(placement, viewportWidth, isRtl);
    const sheetRight = sheetLeft + placement.width;
    const creaseRight = crease.left + crease.width;
    return sheetLeft < creaseRight && sheetRight > crease.left;
  }

  private static creaseSidePlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind,
    usableCreases: ConversationLayoutCrease[]
  ): SettingsPlacement {
    const crease = input.isRtl ?
      usableCreases[0] : usableCreases[usableCreases.length - 1];
    const width = input.isRtl ?
      Math.max(0, crease.left) :
      Math.max(0, input.viewportWidth - crease.left - crease.width);
    const height = SettingsPlacementPolicy.kindSideHeight(input.viewportHeight, kind);
    return new SettingsPlacement(SettingsPlacementMode.Side, width, height, 0);
  }

  /**
   * The wide window's answer: the design's dialog width, in the middle.
   *
   * The width is the same clamp the side sheet used — a ratio of the window,
   * held between 400 and 520 vp — because that is the width the design gives
   * these sheets; only where it sits changed. The height is the kind's own, held
   * inside the window it is centered in: a dialog that cannot fit its window is
   * not centered in anything.
   */
  private static centerPlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind
  ): SettingsPlacement {
    const ratioWidth = Math.round(input.viewportWidth * SettingsPlacementPolicy.TABLET_WIDTH_RATIO);
    const clamped = Math.min(
      SettingsPlacementPolicy.TABLET_MAX_WIDTH,
      Math.max(SettingsPlacementPolicy.TABLET_MIN_WIDTH, ratioWidth)
    );
    const width = Math.min(input.viewportWidth, clamped);
    const height = SettingsPlacementPolicy.kindCenterHeight(input.viewportHeight, kind);
    return new SettingsPlacement(SettingsPlacementMode.Center, width, height, 0);
  }

  private static kindCenterHeight(viewportHeight: number, kind: SettingsSheetKind): number {
    const computed = SettingsPlacementPolicy.kindSideHeight(viewportHeight, kind);
    if (viewportHeight <= 0) {
      return computed;
    }
    const available = Math.max(
      0,
      viewportHeight - 2 * SettingsPlacementPolicy.CENTER_VERTICAL_MARGIN
    );
    return Math.min(computed, available);
  }

  private static hoverPlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind
  ): SettingsPlacement {
    const horizontal = SettingsPlacementPolicy.firstUsableHorizontalCrease(
      input.viewportHeight,
      input.horizontalCreases
    );
    if (horizontal) {
      return SettingsPlacementPolicy.foldOperatePlacement(input, kind, horizontal);
    }
    return SettingsPlacementPolicy.creaseFreeOrCenterPlacement(input, kind);
  }

  /**
   * A half-folded screen whose crease is not a usable horizontal one.
   *
   * Its posture is still about the hardware, so the vertical crease — when there
   * is one — keeps deciding: the sheet lands inside a leaf rather than across the
   * fold. With neither crease to answer to, the window's width decides, which is
   * the same answer an unfolded screen gets.
   */
  private static creaseFreeOrCenterPlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind
  ): SettingsPlacement {
    const usableCreases = SettingsPlacementPolicy.usableVerticalCreases(
      input.viewportWidth,
      input.verticalCreases
    );
    if (usableCreases.length > 0 && SettingsPlacementPolicy.canUseSideSheet(input)) {
      return SettingsPlacementPolicy.creaseSidePlacement(input, kind, usableCreases);
    }
    if (SettingsPlacementPolicy.isWideViewport(input) &&
      SettingsPlacementPolicy.canUseSideSheet(input)) {
      return SettingsPlacementPolicy.centerPlacement(input, kind);
    }
    return SettingsPlacementPolicy.bottomPlacement(kind);
  }

  private static foldOperatePlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind,
    crease: ConversationLayoutHorizontalCrease
  ): SettingsPlacement {
    const maxHeight = Math.max(0, input.viewportHeight - crease.top - crease.height);
    const height = SettingsPlacementPolicy.kindOperateHeight(maxHeight, kind);
    return new SettingsPlacement(SettingsPlacementMode.FoldOperate, 0, height, maxHeight);
  }

  private static bottomPlacement(kind: SettingsSheetKind): SettingsPlacement {
    const height = kind === SettingsSheetKind.RemoteViewSettings ?
      SettingsPlacementPolicy.REMOTE_VIEW_SETTINGS_HEIGHT : 0;
    return new SettingsPlacement(SettingsPlacementMode.Bottom, 0, height, 0);
  }

  private static kindSideHeight(viewportHeight: number, kind: SettingsSheetKind): number {
    const computed = SettingsPlacementPolicy.sideHeight(viewportHeight);
    if (kind === SettingsSheetKind.SessionDetails) {
      return Math.min(SettingsPlacementPolicy.SESSION_DETAILS_HEIGHT, computed);
    }
    if (kind === SettingsSheetKind.RemoteViewSettings) {
      return Math.min(SettingsPlacementPolicy.REMOTE_VIEW_SETTINGS_HEIGHT, computed);
    }
    return computed;
  }

  private static kindOperateHeight(maxHeight: number, kind: SettingsSheetKind): number {
    if (kind === SettingsSheetKind.RemoteViewSettings) {
      return Math.min(SettingsPlacementPolicy.REMOTE_VIEW_SETTINGS_HEIGHT, maxHeight);
    }
    if (kind === SettingsSheetKind.SessionDetails) {
      return Math.min(SettingsPlacementPolicy.SESSION_DETAILS_HEIGHT, maxHeight);
    }
    return maxHeight;
  }

  private static sideHeight(viewportHeight: number): number {
    if (viewportHeight <= 0) {
      return SettingsPlacementPolicy.SIDE_MAX_HEIGHT;
    }
    return Math.min(
      SettingsPlacementPolicy.SIDE_MAX_HEIGHT,
      Math.max(
        SettingsPlacementPolicy.SIDE_MIN_HEIGHT,
        Math.round(viewportHeight - SettingsPlacementPolicy.SIDE_VERTICAL_MARGIN)
      )
    );
  }

  private static canUseSideSheet(input: AdaptiveLayoutInput): boolean {
    return input.viewportWidth >= ConversationLayoutPolicy.MD_MIN_WIDTH;
  }

  private static isWideViewport(input: AdaptiveLayoutInput): boolean {
    return input.wideLayoutMatched ||
      input.viewportWidth >= ConversationLayoutPolicy.MD_MIN_WIDTH;
  }

  private static usableVerticalCreases(
    viewportWidth: number,
    creases: ConversationLayoutCrease[]
  ): ConversationLayoutCrease[] {
    return creases
      .filter((crease: ConversationLayoutCrease): boolean => {
        return crease.left > 0 &&
          crease.width >= 0 &&
          crease.left + crease.width < viewportWidth;
      })
      .sort((left: ConversationLayoutCrease, right: ConversationLayoutCrease): number => {
        return left.left - right.left;
      });
  }

  private static firstUsableHorizontalCrease(
    viewportHeight: number,
    creases: ConversationLayoutHorizontalCrease[]
  ): ConversationLayoutHorizontalCrease | undefined {
    const usable = creases
      .filter((crease: ConversationLayoutHorizontalCrease): boolean => {
        return crease.top > 0 &&
          crease.height >= 0 &&
          crease.top + crease.height < viewportHeight;
      })
      .sort((left: ConversationLayoutHorizontalCrease, right: ConversationLayoutHorizontalCrease): number => {
        return left.top - right.top;
      });
    return usable.length > 0 ? usable[0] : undefined;
  }
}
