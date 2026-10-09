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

/**
 * Platform window adapter for surfaces that need to draw behind system bars.
 *
 * The shell's immersive layout itself is the ability's decision — `EntryAbility`
 * lays the window out full-screen — and it is what makes the insets below the
 * app's own to reserve rather than the framework's.
 */
export class WindowSystemBarService {
  /**
   * Reads the insets once and re-reads them on every avoid-area change — folding,
   * rotation and the soft keyboard all move the avoid areas without recreating
   * the page, and a stale number either clips the composer or leaves the
   * transcript reserving space nothing is drawn in.
   *
   * The returned function unregisters the listener. This is the app's one window
   * read: every surface reaches it through `WindowInsetsBinding`, which shares a
   * single subscription (`InsetsBroadcast`) instead of opening one per component.
   */
  static async observeInsets(context: Context, onChange: WindowInsetListener): Promise<WindowInsetSubscription> {
    // Swapped for the real release as soon as the window is in hand. Until then
    // there is nothing on the window to take back, so the placeholder is what a
    // failure before `on` registered ends up calling.
    let detach: WindowInsetSubscription = (): void => {};
    try {
      const appWindow = await window.getLastWindow(context);
      const read: () => void = (): void => { onChange(WindowSystemBarService.insetsOf(appWindow)); };
      const onAvoidAreaChange: (data: window.AvoidAreaOptions) => void = (_data: window.AvoidAreaOptions): void => {
        read();
      };
      // `listening` records whether `on` actually took. The release takes back
      // exactly the listener this call put on and never one it did not: the
      // failure path below runs after `on` may or may not have registered, and
      // releasing blind would detach a callback that is not ours.
      let listening = false;
      detach = (): void => {
        if (!listening) {
          return;
        }
        listening = false;
        appWindow.off('avoidAreaChange', onAvoidAreaChange);
      };
      appWindow.on('avoidAreaChange', onAvoidAreaChange);
      listening = true;
      read();
      return detach;
    } catch (err) {
      // A window that cannot hand over its avoid areas must not stop the page
      // rendering, so this still falls back to zero insets — but it is not the
      // silent no-op it used to be. The listener registered above is released
      // first: leaving it on would keep the window alive past every unmount, and
      // leaving the shared broadcast at zero would let every later avoid-area
      // change throw inside the system's own callback with nobody watching, so
      // the whole app would lay itself out against zero insets for the rest of
      // the process with nothing in the log to say why.
      detach();
      RemoteLogger.error(
        `window insets read failed, falling back to zero insets: ${err instanceof Error ? err.message : String(err)}`
      );
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
    //
    // `TYPE_SYSTEM_GESTURE` is deliberately not read here, and that is a decision
    // rather than an oversight. It is the region a system return gesture can be
    // started from; the official immersive-layout sample reads it beside the
    // areas above. This app registers the omission as an open follow-up instead
    // of merging it now: the bottom of that region is already covered by the
    // navigation indicator here, and reserving its side part unconditionally
    // would move every full-width band inward on a gesture-navigation device
    // with no measured overlap to justify it. Merge it in the day a swiped edge
    // is observed to swallow a control.
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
 * The window's one avoid-area subscription, shared by every binding.
 *
 * The four numbers are a fact about one window, not about one component. While
 * each of the 14+ bindings opened its own `getLastWindow` and its own
 * `avoidAreaChange` listener, the app held one subscription per mounted surface,
 * and those surfaces disagreed with each other for as long as each one's
 * asynchronous window call took to resolve: a page that mounted just after a
 * rotation could lay itself out from the previous numbers while its neighbour
 * already had the new ones.
 *
 * This is reference-counted instead. The first subscriber opens the one window
 * listener, the last release closes it, and every binding in between is a
 * callback on this object. A new subscriber is handed the current value as it
 * registers, so a surface that mounts after the last change still starts from
 * real numbers rather than from zeroes.
 *
 * The values it broadcasts are px, the unit the window reports. Each binding
 * converts them with its own `UIContext`, because two windows on one device need
 * not share a scale.
 */
class InsetsBroadcast {
  private listeners: WindowInsetListener[] = [];
  private current: WindowInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  private subscription?: WindowInsetSubscription;
  private opened: boolean = false;
  /**
   * Bumped by every open and every close, so a window read that resolves late
   * can tell whether it still belongs to the current subscription.
   */
  private generation: number = 0;

  /**
   * Registers one listener and returns its release.
   *
   * Registration is synchronous — the shared window call happens inside `open`
   * and is not awaited here — so a component that unmounts immediately after
   * binding has nothing in flight to leak: it releases a listener that is
   * already in the list, and the shared subscription is torn down by that same
   * release if it was the last one.
   */
  subscribe(context: Context, listener: WindowInsetListener): WindowInsetSubscription {
    this.listeners.push(listener);
    if (this.listeners.length === 1) {
      this.open(context);
    }
    listener(this.current);
    return (): void => {
      this.release(listener);
    };
  }

  private release(listener: WindowInsetListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
    if (this.listeners.length === 0) {
      this.close();
    }
  }

  private open(context: Context): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    this.generation += 1;
    const generation = this.generation;
    RemoteLogger.info('window insets subscription opened');
    void WindowSystemBarService.observeInsets(context, (insets: WindowInsets): void => {
      // observeInsets publishes before its promise resolves, including its
      // zero-inset failure fallback. Reject stale data before touching the
      // shared cache or listeners; the cleanup guard below runs too late.
      if (generation !== this.generation || this.listeners.length === 0) {
        return;
      }
      this.current = insets;
      for (const listener of this.listeners) {
        listener(insets);
      }
    }).then((subscription: WindowInsetSubscription): void => {
      // The last subscriber can be gone, or a later open can already own the
      // window, before this read resolves. Either way this subscription has no
      // one left to serve, so it is handed straight back instead of being kept.
      if (generation !== this.generation || this.listeners.length === 0) {
        subscription();
        return;
      }
      this.subscription = subscription;
    });
  }

  private close(): void {
    this.opened = false;
    this.generation += 1;
    if (this.subscription) {
      this.subscription();
      this.subscription = undefined;
      RemoteLogger.info('window insets subscription closed');
    }
  }
}

/** The process-wide instance every `WindowInsetsBinding` registers with. */
const sharedInsetsBroadcast: InsetsBroadcast = new InsetsBroadcast();

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
 * They mount and unmount independently, so the binding holds a registration on
 * the app's one shared subscription rather than leaving each page to juggle a
 * window listener of its own, and it holds vp because padding, margins and radii
 * in this app are vp.
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
    // Registering is synchronous and immediately delivers the current value, so
    // this surface is laid out from real numbers as soon as it mounts and is
    // releasable the moment it goes. The callback still checks `disposed`
    // because the broadcast can deliver a change across an unmount.
    const callback: WindowInsetListener = (insets: WindowInsets): void => {
      if (this.disposed) {
        return;
      }
      this.top = uiContext.px2vp(insets.top);
      this.bottom = uiContext.px2vp(insets.bottom);
      this.left = uiContext.px2vp(insets.left);
      this.right = uiContext.px2vp(insets.right);
      RemoteLogger.info(`window insets top=${this.top} bottom=${this.bottom} left=${this.left} right=${this.right}`);
    };
    // A binding that is bound twice replaces its own registration instead of
    // leaving the previous one behind on the shared subscription.
    const previous = this.subscription;
    this.subscription = sharedInsetsBroadcast.subscribe(context, callback);
    if (previous) {
      previous();
    }
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
