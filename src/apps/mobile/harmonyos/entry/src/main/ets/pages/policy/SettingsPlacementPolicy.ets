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
  UserMessageFullText = 'user_message_full_text'
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
 */
export class SettingsPlacementPolicy {
  static readonly TABLET_MIN_WIDTH: number = 400;
  static readonly TABLET_MAX_WIDTH: number = 520;
  static readonly TABLET_WIDTH_RATIO: number = 0.32;
  static readonly CONNECT_CENTER_WIDTH_RATIO: number = 0.72;
  static readonly LANDSCAPE_WIDTH_RATIO: number = 0.45;
  static readonly SIDE_MAX_HEIGHT: number = 760;
  static readonly SIDE_MIN_HEIGHT: number = 560;
  static readonly SIDE_VERTICAL_MARGIN: number = 80;
  static readonly SESSION_DETAILS_HEIGHT: number = 560;
  static readonly REMOTE_VIEW_SETTINGS_HEIGHT: number = 520;

  static compactBottom(kind: SettingsSheetKind = SettingsSheetKind.Settings): SettingsPlacement {
    return SettingsPlacementPolicy.bottomPlacement(kind);
  }

  static resolve(input: AdaptiveLayoutInput, kind: SettingsSheetKind): SettingsPlacement {
    // Settings and profile are one continuous page. Keep that workflow on a
    // full-width bottom sheet at every width, even when it crosses a fold.
    if (kind === SettingsSheetKind.Settings) {
      return SettingsPlacementPolicy.bottomPlacement(kind);
    }
    if (kind === SettingsSheetKind.Connect &&
      input.isExpandedFoldable &&
      !input.isFolded &&
      SettingsPlacementPolicy.canUseSideSheet(input)) {
      const horizontal = SettingsPlacementPolicy.firstUsableHorizontalCrease(
        input.viewportHeight,
        input.horizontalCreases
      );
      if (input.isHoverOperate && horizontal) {
        return SettingsPlacementPolicy.foldOperatePlacement(input, kind, horizontal);
      }
      return SettingsPlacementPolicy.connectCenterPlacement(input);
    }
    if (input.isHoverOperate) {
      return SettingsPlacementPolicy.hoverPlacement(input, kind);
    }
    if (input.isFolded) {
      return SettingsPlacementPolicy.bottomPlacement(kind);
    }
    return SettingsPlacementPolicy.creaseFreeOrSidePlacement(input, kind);
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

  private static tabletSidePlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind
  ): SettingsPlacement {
    const ratioWidth = Math.round(input.viewportWidth * SettingsPlacementPolicy.TABLET_WIDTH_RATIO);
    const clamped = Math.min(
      SettingsPlacementPolicy.TABLET_MAX_WIDTH,
      Math.max(SettingsPlacementPolicy.TABLET_MIN_WIDTH, ratioWidth)
    );
    const width = Math.min(input.viewportWidth, clamped);
    const height = SettingsPlacementPolicy.kindSideHeight(input.viewportHeight, kind);
    return new SettingsPlacement(SettingsPlacementMode.Side, width, height, 0);
  }

  private static connectCenterPlacement(input: AdaptiveLayoutInput): SettingsPlacement {
    const ratioWidth = Math.round(
      input.viewportWidth * SettingsPlacementPolicy.CONNECT_CENTER_WIDTH_RATIO
    );
    const clamped = Math.min(
      SettingsPlacementPolicy.TABLET_MAX_WIDTH,
      Math.max(SettingsPlacementPolicy.TABLET_MIN_WIDTH, ratioWidth)
    );
    const width = Math.min(input.viewportWidth, clamped);
    const height = SettingsPlacementPolicy.kindSideHeight(
      input.viewportHeight,
      SettingsSheetKind.Connect
    );
    return new SettingsPlacement(SettingsPlacementMode.Center, width, height, 0);
  }

  private static landscapeSidePlacement(
    input: AdaptiveLayoutInput,
    kind: SettingsSheetKind
  ): SettingsPlacement {
    const width = Math.round(input.viewportWidth * SettingsPlacementPolicy.LANDSCAPE_WIDTH_RATIO);
    const height = SettingsPlacementPolicy.kindSideHeight(input.viewportHeight, kind);
    return new SettingsPlacement(SettingsPlacementMode.Side, width, height, 0);
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
    return SettingsPlacementPolicy.creaseFreeOrSidePlacement(input, kind);
  }

  private static creaseFreeOrSidePlacement(
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
    if (SettingsPlacementPolicy.isHeightScarceLandscape(input) &&
      SettingsPlacementPolicy.canUseSideSheet(input)) {
      return SettingsPlacementPolicy.landscapeSidePlacement(input, kind);
    }
    if (SettingsPlacementPolicy.isWideViewport(input) &&
      SettingsPlacementPolicy.canUseSideSheet(input)) {
      return SettingsPlacementPolicy.tabletSidePlacement(input, kind);
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

  private static isHeightScarceLandscape(input: AdaptiveLayoutInput): boolean {
    return input.viewportWidth > input.viewportHeight &&
      input.viewportHeight > 0 &&
      input.viewportHeight < ConversationLayoutPolicy.MD_MIN_WIDTH;
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
