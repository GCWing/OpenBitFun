import { Context } from '@kit.AbilityKit';
import { UIContext, window } from '@kit.ArkUI';
import { RemoteLogger } from './RemoteLogger';

/**
 * The strip one avoid area claims along each edge of the window, in px.
 */
export interface AvoidEdges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How much of the window the app has to keep clear of its own content, in px.
 *
 * Every number is read rather than assumed. The shell runs in immersive layout,
 * so the page draws from the edges of the window: the status bar is the app's
 * own top inset to reserve, the bottom strip is the navigation indicator until
 * the soft keyboard takes its place, and the sides are the camera cutout once
 * the device has rotated it onto one of them.
 */
export interface WindowInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The four edge widths one avoid area reports, in px. */
export function avoidEdgesOf(area: window.AvoidArea): AvoidEdges {
  return {
    top: area.topRect.height,
    bottom: area.bottomRect.height,
    left: area.leftRect.width,
    right: area.rightRect.width
  };
}

/**
 * Merges the avoid areas that share an edge into the strip that edge needs.
 *
 * More than one area can claim the same edge — the status bar and a landscape
 * camera cutout both touch the top, the navigation indicator and a reverse
 * cutout both touch the bottom — and they are overlapping regions of one window
 * rather than strips stacked on top of each other, so an edge is the widest
 * claim among them and never their sum. The official `handleCutoutAvoidArea`
 * sample merges the same way, one `Math.max` per edge.
 *
 * Pure, four numbers in and four numbers out, so the merge is assertable
 * without a window; `insetsOf` keeps only the reading and the keyboard rule.
 */
export function mergeAvoidEdges(areas: AvoidEdges[]): AvoidEdges {
  let top = 0;
  let bottom = 0;
  let left = 0;
  let right = 0;
  for (const area of areas) {
    top = Math.max(top, area.top);
    bottom = Math.max(bottom, area.bottom);
    left = Math.max(left, area.left);
    right = Math.max(right, area.right);
  }
  return { top: top, bottom: bottom, left: left, right: right };
}

/** One read of the insets, plus the listener that keeps them current. */
export type WindowInsetListener = (insets: WindowInsets) => void;
export type WindowInsetSubscription = () => void;

/** Platform window adapter for surfaces that need to draw behind system bars. */
export class WindowSystemBarService {
  /**
   * Immersive layout for the whole shell, not one page: the transcript has to be
   * able to reach the bottom edge of the screen, which only exists in the page
   * area once the window stops reserving the navigation-bar strip.
   *
   * Immersive layout also moves the page's own origin to the top of the window,
   * so every page that draws chrome against an edge reads the insets below
   * instead of assuming the framework avoided the bars for it.
   */
  static async setLayoutFullScreen(context: Context, enabled: boolean): Promise<void> {
    try {
      const appWindow = await window.getLastWindow(context);
      await appWindow.setWindowLayoutFullScreen(enabled);
    } catch (_err) {
      // Window layout is best effort and must not block page rendering.
    }
  }

  static async topSystemInsetPx(context: Context): Promise<number> {
    try {
      const appWindow = await window.getLastWindow(context);
      return appWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height;
    } catch (_err) {
      return 0;
    }
  }

  /**
   * Reads the insets once and re-reads them on every avoid-area change — folding,
   * rotation and the soft keyboard all move the avoid areas without recreating
   * the page, and a stale number either clips the composer or leaves the
   * transcript reserving space nothing is drawn in.
   *
   * The returned function unregisters the listener.
   */
  static async observeInsets(context: Context, onChange: WindowInsetListener): Promise<WindowInsetSubscription> {
    try {
      const appWindow = await window.getLastWindow(context);
      const read: () => void = (): void => { onChange(WindowSystemBarService.insetsOf(appWindow)); };
      const onAvoidAreaChange: (data: window.AvoidAreaOptions) => void = (_data: window.AvoidAreaOptions): void => {
        read();
      };
      const subscription: WindowInsetSubscription = (): void => {
        appWindow.off('avoidAreaChange', onAvoidAreaChange);
      };
      appWindow.on('avoidAreaChange', onAvoidAreaChange);
      read();
      return subscription;
    } catch (_err) {
      onChange({ top: 0, bottom: 0, left: 0, right: 0 });
      return (): void => {};
    }
  }

  private static avoidEdges(appWindow: window.Window, type: window.AvoidAreaType): AvoidEdges {
    return avoidEdgesOf(appWindow.getWindowAvoidArea(type));
  }

  private static insetsOf(appWindow: window.Window): WindowInsets {
    // The camera cutout is an avoid area of its own, and only because the module
    // declares `avoid_cutout` (see module.json5). Rotating the device moves it
    // from the top edge to a side one, which is why it is merged here with the
    // system and navigation areas instead of being left to the top strip.
    const merged = mergeAvoidEdges([
      WindowSystemBarService.avoidEdges(appWindow, window.AvoidAreaType.TYPE_SYSTEM),
      WindowSystemBarService.avoidEdges(appWindow, window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR),
      WindowSystemBarService.avoidEdges(appWindow, window.AvoidAreaType.TYPE_CUTOUT)
    ]);
    // The keyboard covers the navigation indicator while it is up, and
    // `KeyboardAvoidMode.RESIZE` has already lifted the page above it, so the
    // bottom strip belongs to the keyboard for as long as it is visible.
    const keyboardVisible =
      appWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_KEYBOARD).bottomRect.height > 0;
    return {
      top: merged.top,
      bottom: keyboardVisible ? 0 : merged.bottom,
      left: merged.left,
      right: merged.right
    };
  }
}

/**
 * One component's live view of the window insets, in vp.
 *
 * The shell is immersive, so every surface that puts chrome against a screen
 * edge reads these numbers instead of assuming the framework reserved the strip
 * for it: the chat page's fade fills the bottom edge, and the interactive rows
 * of every other page — drawers, sheets, covers, galleries — keep clear of it.
 * The sides are part of the same model: they are the camera cutout, which a
 * rotated device moves onto one of them, so a full-width band reserves them
 * before its own design spacing rather than assuming the page starts clear.
 * They mount and unmount independently, so the binding owns the subscription
 * rather than leaving each page to juggle one, and it holds vp because padding,
 * margins and radii in this app are vp.
 */
@ObservedV2
export class WindowInsetsBinding {
  @Trace top: number = 0;
  @Trace bottom: number = 0;
  @Trace left: number = 0;
  @Trace right: number = 0;
  private subscription?: WindowInsetSubscription;
  private disposed: boolean = false;

  bind(uiContext: UIContext, context: Context): void {
    this.disposed = false;
    void WindowSystemBarService.observeInsets(context, (insets: WindowInsets): void => {
      if (this.disposed) {
        return;
      }
      this.top = uiContext.px2vp(insets.top);
      this.bottom = uiContext.px2vp(insets.bottom);
      this.left = uiContext.px2vp(insets.left);
      this.right = uiContext.px2vp(insets.right);
      RemoteLogger.info(`window insets top=${this.top} bottom=${this.bottom} left=${this.left} right=${this.right}`);
    }).then((subscription: WindowInsetSubscription): void => {
      // The page can disappear before the window call resolves; releasing here
      // keeps a listener from outliving the component that asked for it.
      if (this.disposed) {
        subscription();
        return;
      }
      this.subscription = subscription;
    });
  }

  unbind(): void {
    this.disposed = true;
    if (this.subscription) {
      this.subscription();
      this.subscription = undefined;
    }
  }

  /**
   * The padding a bottom-anchored content layer needs: the design's own spacing
   * where it already clears the strip, and the strip itself where it does not.
   * The strip is a device fact, so a page never hard-codes it.
   */
  bottomPadding(designSpacing: number): number {
    return Math.max(designSpacing, this.bottom);
  }

  /**
   * The padding a side-anchored content layer needs. Split by side rather than
   * exposed as one pair because a cutout only ever lands on one of them: the
   * left strip stays 0 while the right one carries the camera, and padding both
   * by the wider value would push the content of a full-width band off-centre.
   */
  leftPadding(designSpacing: number): number {
    return Math.max(designSpacing, this.left);
  }

  rightPadding(designSpacing: number): number {
    return Math.max(designSpacing, this.right);
  }

  /**
   * The clearance both sides need for a control that has to stay centred — a
   * glyph, a pill, an icon whose own box is what the user sees. Reserving the
   * wider strip on both sides is what keeps it on the window's centre line; a
   * full-width band wants `leftPadding`/`rightPadding` instead, so its own
   * design spacing is only ever raised on the side the device actually claims.
   */
  sidePadding(designSpacing: number): number {
    return Math.max(designSpacing, Math.max(this.left, this.right));
  }

  /**
   * The tail spacer a scrolling surface appends after its last row: the strip
   * itself plus the design's own breathing. The viewport then runs to the
   * screen edge — rows roll under the navigation indicator while they are
   * still moving — while the last row still comes to rest above the bar.
   * Padding on the scrolling container cannot do that: it shrinks the viewport
   * and leaves a band of bare page colour under the bar instead.
   */
  tailSpacing(designSpacing: number): number {
    return this.bottom + designSpacing;
  }
}
