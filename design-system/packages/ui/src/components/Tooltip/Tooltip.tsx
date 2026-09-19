import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { classNames } from "../../internal/classNames";
import { isImeOwnedKeyboardEvent } from "../../internal/ime";
import { TooltipTriggerContext } from "../../internal/tooltipTriggerContext";
import { Portal } from "../../overlay/Portal";
import { useDesignSystem } from "../../overlay/useDesignSystem";
import styles from "./Tooltip.module.css";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";
export type TooltipTrigger = "hover" | "click" | "focus" | "hover-focus";

const DEFAULT_TOOLTIP_DELAY_MS = 450;
const INTERACTIVE_HIDE_DELAY_MS = 400;
/**
 * After a tooltip hides, tooltips shown again within this window skip the
 * open delay so scanning across adjacent triggers feels instant.
 */
const WARM_WINDOW_MS = 300;
let tooltipWarmUntil = 0;
const activeTooltips = new WeakMap<Document, { id: string; hide: () => void }>();

/** Cursor offset when followCursor: right and down so the tooltip never covers the cursor. */
const CURSOR_OFFSET_X = 12;
const CURSOR_OFFSET_Y = 8;
const GAP = 8;
const VIEWPORT_PADDING = 8;

export interface TooltipProps {
  /** Single focusable trigger element the tooltip describes. */
  children?: ReactElement;
  className?: string;
  content: ReactNode;
  /** Open delay in milliseconds. Falls back to the provider value, then 450ms. */
  delay?: number;
  disabled?: boolean;
  /** Position near the mouse cursor instead of the trigger element. */
  followCursor?: boolean;
  /** Keep the tooltip open while hovered so its content can be selected or clicked. */
  interactive?: boolean;
  /** Preferred side of the trigger; flips to the opposite side when space runs out. */
  placement?: TooltipPlacement;
  trigger?: TooltipTrigger;
  /** Bind to an existing control without adding a wrapper or another tab stop. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** Reveal a virtually focused option, for example in an aria-activedescendant listbox. */
  active?: boolean;
  /** Refresh lazy content or decline opening when the trigger no longer needs a tooltip. */
  onBeforeShow?: () => boolean;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as { current: T | null }).current = value;
}

const OPPOSITE_PLACEMENT: Record<TooltipPlacement, TooltipPlacement> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function getAvailableSpace(triggerRect: DOMRect, placement: TooltipPlacement): number {
  switch (placement) {
    case "top":
      return triggerRect.top - VIEWPORT_PADDING;
    case "bottom":
      return window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING;
    case "left":
      return triggerRect.left - VIEWPORT_PADDING;
    case "right":
      return window.innerWidth - triggerRect.right - VIEWPORT_PADDING;
  }
}

function getPositionForPlacement(
  triggerRect: DOMRect,
  tooltipRect: DOMRect,
  placement: TooltipPlacement,
): { top: number; left: number } {
  switch (placement) {
    case "top":
      return {
        top: triggerRect.top - tooltipRect.height - GAP,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case "bottom":
      return {
        top: triggerRect.bottom + GAP,
        left: triggerRect.left + (triggerRect.width - tooltipRect.width) / 2,
      };
    case "left":
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.left - tooltipRect.width - GAP,
      };
    case "right":
      return {
        top: triggerRect.top + (triggerRect.height - tooltipRect.height) / 2,
        left: triggerRect.right + GAP,
      };
  }
}

function determineBestPlacement(
  triggerRect: DOMRect,
  tooltipRect: DOMRect,
  preferredPlacement: TooltipPlacement,
): TooltipPlacement {
  const requiredSpace = preferredPlacement === "top" || preferredPlacement === "bottom"
    ? tooltipRect.height + GAP
    : tooltipRect.width + GAP;

  const preferredSpace = getAvailableSpace(triggerRect, preferredPlacement);
  if (preferredSpace >= requiredSpace) return preferredPlacement;

  const oppositePlacement = OPPOSITE_PLACEMENT[preferredPlacement];
  const oppositeSpace = getAvailableSpace(triggerRect, oppositePlacement);
  if (oppositeSpace >= requiredSpace) return oppositePlacement;

  return oppositeSpace > preferredSpace ? oppositePlacement : preferredPlacement;
}

function applyBoundaryConstraints(
  position: { top: number; left: number },
  tooltipRect: DOMRect,
): { top: number; left: number } {
  let { top, left } = position;

  if (left < VIEWPORT_PADDING) {
    left = VIEWPORT_PADDING;
  } else if (left + tooltipRect.width > window.innerWidth - VIEWPORT_PADDING) {
    left = window.innerWidth - tooltipRect.width - VIEWPORT_PADDING;
  }

  if (top < VIEWPORT_PADDING) {
    top = VIEWPORT_PADDING;
  } else if (top + tooltipRect.height > window.innerHeight - VIEWPORT_PADDING) {
    top = window.innerHeight - tooltipRect.height - VIEWPORT_PADDING;
  }

  return { top, left };
}

interface TooltipLayout {
  top: number;
  left: number;
  placement: TooltipPlacement;
  ready: boolean;
}

export function Tooltip({
  children,
  className,
  content,
  delay,
  disabled = false,
  followCursor = false,
  interactive = false,
  placement = "top",
  trigger = "hover",
  triggerRef: externalTriggerRef,
  active = false,
  onBeforeShow,
}: TooltipProps) {
  const designSystem = useDesignSystem();
  const resolvedDelayMs = delay ?? designSystem.tooltipDelay ?? DEFAULT_TOOLTIP_DELAY_MS;

  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  // Single layout state (position + placement + ready) so one recalculation
  // commits at most one re-render.
  const [layout, setLayout] = useState<TooltipLayout>({
    top: 0,
    left: 0,
    placement,
    ready: false,
  });
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number } | null>(null);
  const internalTriggerRef = useRef<HTMLElement | null>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestMousePositionRef = useRef<{ x: number; y: number } | null>(null);
  const recalcFrameRef = useRef<number | null>(null);
  const instantRef = useRef(false);
  const hideCurrentRef = useRef<() => void>(() => {});

  const calculatePosition = useCallback(() => {
    if (!tooltipRef.current) return;

    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    if (followCursor && mousePosition) {
      const raw = {
        top: mousePosition.y + CURSOR_OFFSET_Y,
        left: mousePosition.x + CURSOR_OFFSET_X,
      };
      const pos = applyBoundaryConstraints(raw, tooltipRect);
      setLayout({ top: pos.top, left: pos.left, placement: "bottom", ready: true });
      return;
    }

    if (!triggerRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const bestPlacement = determineBestPlacement(triggerRect, tooltipRect, placement);
    const pos = applyBoundaryConstraints(
      getPositionForPlacement(triggerRect, tooltipRect, bestPlacement),
      tooltipRect,
    );

    setLayout({ top: pos.top, left: pos.left, placement: bestPlacement, ready: true });
  }, [placement, followCursor, mousePosition]);

  // rAF-merged recalculation for scroll/resize storms: at most one
  // getBoundingClientRect pass per frame.
  const scheduleCalculatePosition = useCallback(() => {
    if (recalcFrameRef.current !== null) return;
    recalcFrameRef.current = requestAnimationFrame(() => {
      recalcFrameRef.current = null;
      calculatePosition();
    });
  }, [calculatePosition]);

  const showTooltip = useCallback((event?: Pick<MouseEvent, "clientX" | "clientY">) => {
    if (disabled) return;
    const element = triggerRef.current;
    if (!element || element.closest('[hidden], [aria-hidden="true"]')) return;
    if (onBeforeShow && !onBeforeShow()) return;
    if (showTimeoutRef.current) clearTimeout(showTimeoutRef.current);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (followCursor && event) {
      latestMousePositionRef.current = { x: event.clientX, y: event.clientY };
    }
    const openDelay = (trigger === "hover" || trigger === "hover-focus") && Date.now() < tooltipWarmUntil
      ? 0
      : resolvedDelayMs;
    instantRef.current = openDelay === 0;
    showTimeoutRef.current = setTimeout(() => {
      showTimeoutRef.current = null;
      if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return;
      if (onBeforeShow && !onBeforeShow()) return;
      const previous = activeTooltips.get(element.ownerDocument);
      if (previous && previous.id !== tooltipId) previous.hide();
      activeTooltips.set(element.ownerDocument, { id: tooltipId, hide: () => hideCurrentRef.current() });
      if (followCursor) {
        setMousePosition(latestMousePositionRef.current);
      }
      setLayout((prev) => (prev.ready ? { ...prev, ready: false } : prev));
      setVisible(true);
    }, openDelay);
  }, [disabled, followCursor, onBeforeShow, resolvedDelayMs, tooltipId, trigger, triggerRef]);

  const hideTooltip = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (visible) {
      tooltipWarmUntil = Date.now() + WARM_WINDOW_MS;
    }
    const ownerDocument = triggerRef.current?.ownerDocument;
    if (ownerDocument && activeTooltips.get(ownerDocument)?.id === tooltipId) activeTooltips.delete(ownerDocument);
    setVisible(false);
    setLayout((prev) => (prev.ready ? { ...prev, ready: false } : prev));
    if (followCursor) {
      latestMousePositionRef.current = null;
      setMousePosition(null);
    }
  }, [followCursor, tooltipId, triggerRef, visible]);

  useEffect(() => { hideCurrentRef.current = hideTooltip; }, [hideTooltip]);

  const scheduleHideTooltip = useCallback(() => {
    if (!interactive || !visible) {
      hideTooltip();
      return;
    }

    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      hideTimeoutRef.current = null;
      hideTooltip();
    }, INTERACTIVE_HIDE_DELAY_MS);
  }, [hideTooltip, interactive, visible]);

  useEffect(() => {
    setLayout((prev) => (prev.placement === placement ? prev : { ...prev, placement }));
  }, [placement]);

  // When the tooltip becomes disabled (e.g. the parent opens a menu that
  // covers the trigger), cancel any pending show timer and force-hide so a
  // tooltip cannot appear or linger above the new overlay.
  useEffect(() => {
    if (disabled) hideTooltip();
  }, [disabled, hideTooltip]);

  useEffect(() => {
    if (!visible) return;

    scheduleCalculatePosition();
    if (!followCursor) {
      window.addEventListener("scroll", scheduleCalculatePosition, { capture: true, passive: true });
    }
    window.addEventListener("resize", scheduleCalculatePosition, { passive: true });
    return () => {
      if (!followCursor) {
        window.removeEventListener("scroll", scheduleCalculatePosition, { capture: true });
      }
      window.removeEventListener("resize", scheduleCalculatePosition);
      if (recalcFrameRef.current !== null) {
        cancelAnimationFrame(recalcFrameRef.current);
        recalcFrameRef.current = null;
      }
    };
  }, [visible, followCursor, scheduleCalculatePosition]);

  useEffect(() => {
    const ownerDocument = triggerRef.current?.ownerDocument;
    return () => {
      if (showTimeoutRef.current) clearTimeout(showTimeoutRef.current);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (ownerDocument && activeTooltips.get(ownerDocument)?.id === tooltipId) activeTooltips.delete(ownerDocument);
    };
  }, [tooltipId, triggerRef]);

  // Delegated text slots use the owning button/row for hover and keyboard focus.
  // Keep the actual label in place so this also works inside portalled listboxes.
  useEffect(() => {
    const element = externalTriggerRef?.current;
    if (!element) return;
    const onEnter = (event: MouseEvent) => {
      if (trigger === "hover" || trigger === "hover-focus") showTooltip(event);
    };
    const onLeave = (event: MouseEvent) => {
      // React can deliver the portal's mouse-enter before this native
      // mouse-leave. Do not restart the hide timer when entering the tooltip.
      if (interactive && event.relatedTarget instanceof Node
        && tooltipRef.current?.contains(event.relatedTarget)) return;
      if (trigger === "hover-focus" && element.contains(element.ownerDocument.activeElement)) return;
      if (trigger === "hover" || trigger === "hover-focus") scheduleHideTooltip();
    };
    const onFocus = () => {
      if (trigger === "focus" || trigger === "hover-focus") showTooltip();
    };
    const onBlur = (event: FocusEvent) => {
      if (event.relatedTarget && element.contains(event.relatedTarget as Node)) return;
      if (trigger === "focus" || trigger === "hover-focus") hideTooltip();
    };
    const onClick = () => {
      if (trigger === "click" && !visible) showTooltip();
      else hideTooltip();
    };
    element.addEventListener("mouseenter", onEnter);
    element.addEventListener("mouseleave", onLeave);
    element.addEventListener("focusin", onFocus);
    element.addEventListener("focusout", onBlur);
    element.addEventListener("click", onClick);
    return () => {
      element.removeEventListener("mouseenter", onEnter);
      element.removeEventListener("mouseleave", onLeave);
      element.removeEventListener("focusin", onFocus);
      element.removeEventListener("focusout", onBlur);
      element.removeEventListener("click", onClick);
    };
  }, [externalTriggerRef, hideTooltip, interactive, scheduleHideTooltip, showTooltip, trigger, visible]);

  // A measured text slot can mount after focus has already reached its owner.
  // Only replay focus/virtual activation on a transition, not on visibility updates.
  const activationRef = useRef(false);
  useEffect(() => {
    const element = triggerRef.current;
    const activated = !disabled && (active || Boolean(externalTriggerRef
      && element?.contains(element.ownerDocument.activeElement)));
    if (activated === activationRef.current) return;
    activationRef.current = activated;
    if (activated) showTooltip();
    else hideTooltip();
  }, [active, disabled, externalTriggerRef, hideTooltip, showTooltip, triggerRef]);

  useEffect(() => {
    const ownerDocument = triggerRef.current?.ownerDocument;
    const cancelPendingShow = (event: KeyboardEvent) => {
      // A delayed tooltip has no painted layer yet. Cancel its timer without
      // consuming Escape or dismissing any surface owned by the coordinator.
      if (event.key !== "Escape" || isImeOwnedKeyboardEvent(event) || showTimeoutRef.current === null) return;
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    };
    ownerDocument?.addEventListener("keydown", cancelPendingShow, true);
    return () => ownerDocument?.removeEventListener("keydown", cancelPendingShow, true);
  }, [triggerRef]);

  const childProps = (children?.props ?? {}) as Record<string, unknown>;
  const childRef = (children as (ReactElement & { ref?: Ref<HTMLElement> }) | undefined)?.ref;

  const handleTriggerRef = useCallback((node: HTMLElement | null) => {
    internalTriggerRef.current = node;
    assignRef(childRef, node);
  }, [childRef]);

  const handleMouseEnter = (event: ReactMouseEvent) => {
    if (trigger === "hover" || trigger === "hover-focus") showTooltip(event);
    (childProps.onMouseEnter as ((event: ReactMouseEvent) => void) | undefined)?.(event);
  };

  const handleMouseLeave = (event: ReactMouseEvent) => {
    if (trigger === "hover" || (trigger === "hover-focus" && !event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement))) scheduleHideTooltip();
    (childProps.onMouseLeave as ((event: ReactMouseEvent) => void) | undefined)?.(event);
  };

  const handleMouseMove = (event: ReactMouseEvent) => {
    if (followCursor && !visible) {
      latestMousePositionRef.current = { x: event.clientX, y: event.clientY };
    }
    (childProps.onMouseMove as ((event: ReactMouseEvent) => void) | undefined)?.(event);
  };

  const handleClick = (event: ReactMouseEvent) => {
    // Always cancel any pending show timer so a click before the tooltip
    // appears cannot surface a stale tooltip after the trigger is covered
    // by a menu or backdrop (which prevents the natural mouseleave).
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
    if (visible) {
      hideTooltip();
    } else if (trigger === "click") {
      showTooltip();
    }
    (childProps.onClick as ((event: ReactMouseEvent) => void) | undefined)?.(event);
  };

  const handleFocus = (event: ReactFocusEvent) => {
    if (trigger === "focus" || trigger === "hover-focus") showTooltip();
    (childProps.onFocus as ((event: ReactFocusEvent) => void) | undefined)?.(event);
  };

  const handleBlur = (event: ReactFocusEvent) => {
    if (trigger === "focus" || trigger === "hover-focus") hideTooltip();
    (childProps.onBlur as ((event: ReactFocusEvent) => void) | undefined)?.(event);
  };

  const isShown = visible && layout.ready;

  useEffect(() => {
    const element = externalTriggerRef?.current;
    if (!element || !isShown) return;
    const descriptions = new Set(element.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean));
    descriptions.add(tooltipId);
    element.setAttribute("aria-describedby", [...descriptions].join(" "));
    return () => {
      const remaining = element.getAttribute("aria-describedby")?.split(/\s+/).filter(id => id && id !== tooltipId) ?? [];
      if (remaining.length) element.setAttribute("aria-describedby", remaining.join(" "));
      else element.removeAttribute("aria-describedby");
    };
  }, [externalTriggerRef, isShown, tooltipId]);

  const triggerElement = children ? cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: handleTriggerRef,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onMouseMove: followCursor ? handleMouseMove : childProps.onMouseMove,
    onClick: handleClick,
    onFocus: handleFocus,
    onBlur: handleBlur,
    "aria-describedby": isShown
      ? [childProps["aria-describedby"], tooltipId].filter(Boolean).join(" ")
      : childProps["aria-describedby"],
  } as Record<string, unknown>) : null;

  return (
    <>
      <TooltipTriggerContext.Provider value={!disabled}>
        {triggerElement}
      </TooltipTriggerContext.Provider>
      {visible && (
        <Portal ownerDocument={triggerRef.current?.ownerDocument} ownerRef={triggerRef} passive
          surfaceRef={tooltipRef} onDismiss={hideTooltip}>
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          data-openbitfun-native-webview-occlusion
          className={classNames(styles.root, className)}
          data-openbitfun-component="tooltip"
          data-openbitfun-placement={layout.placement}
          data-openbitfun-interactive={interactive ? "true" : "false"}
          data-openbitfun-state={isShown ? "visible" : undefined}
          data-instant={instantRef.current || undefined}
          // Portal clicks still bubble through the React tree to the owning control.
          onClick={(event) => event.stopPropagation()}
          onMouseEnter={interactive ? () => {
            if (hideTimeoutRef.current) {
              clearTimeout(hideTimeoutRef.current);
              hideTimeoutRef.current = null;
            }
          } : undefined}
          onMouseLeave={interactive ? scheduleHideTooltip : undefined}
          style={{
            top: `${layout.top}px`,
            left: `${layout.left}px`,
          }}
        >
          {!followCursor && (
            <div className={styles.arrow} data-openbitfun-part="arrow" aria-hidden="true" />
          )}
          <div className={styles.content} data-openbitfun-part="content">
            <div className={styles.body} data-openbitfun-part="body">{content}</div>
          </div>
        </div>
        </Portal>
      )}
    </>
  );
}
