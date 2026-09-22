import {
  Children,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
  type HTMLAttributes,
} from "react";
import { classNames } from "../../internal/classNames";
import { TooltipTriggerContext } from "../../internal/tooltipTriggerContext";
import { Tooltip } from "../../components/Tooltip";
import styles from "./OverflowText.module.css";
import { cancelOverflowMeasurement, scheduleOverflowMeasurement } from "./overflowMeasurementQueue";

const useIsomorphicLayoutEffect = typeof window === "undefined"
  ? useEffect
  : useLayoutEffect;

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

const MARQUEE_MIN_DURATION_MS = 2400;
const MARQUEE_PIXELS_PER_SECOND = 36;

export type OverflowTextBehavior = "fade" | "marquee";

export interface OverflowTextProps extends HTMLAttributes<HTMLElement> {
  /** Preserve paragraph/div semantics when adopting the shared text behavior. */
  as?: "span" | "p" | "div";
  /** Clamp a multiline preview; its full text uses the same hover/focus tooltip. */
  lines?: number;
  /** Plain text defaults to marquee; rich composition defaults to a static fade. */
  behavior?: OverflowTextBehavior;
  /** Single-line resting treatment; multiline clamps keep their existing layout. */
  overflowStyle?: "fade" | "ellipsis";
  /** Interaction-only text ignores virtual active state on itself and its owner. */
  marqueeTrigger?: "interaction-or-active" | "interaction";
  /** Runs an overflowing marquee while its owning control is virtually active. */
  marqueeActive?: boolean;
}

interface OverflowMeasurement {
  distance: number;
  isOverflowing: boolean;
}

export const OverflowText = forwardRef<HTMLElement, OverflowTextProps>(
  function OverflowText({
    as: Tag = "span",
    behavior: requestedBehavior,
    children,
    className,
    lines,
    marqueeActive = false,
    marqueeTrigger = "interaction-or-active",
    overflowStyle = "fade",
    style,
    title,
    ...props
  }, forwardedRef) {
    // Preserve existing rich slot layouts unless their owner explicitly opts in.
    const textOnly = Children.toArray(children).every(
      child => typeof child === "string" || typeof child === "number",
    );
    const behavior = lines ? "fade" : requestedBehavior ?? (textOnly ? "marquee" : "fade");
    const elementRef = useRef<HTMLElement | null>(null);
    const contentRef = useRef<HTMLSpanElement | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);
    const hasExplicitTooltip = useContext(TooltipTriggerContext);
    const [tooltipText, setTooltipText] = useState("");
    const measurementRef = useRef<OverflowMeasurement>({
      distance: 0,
      isOverflowing: false,
    });
    const [measurement, setMeasurement] = useState<OverflowMeasurement>(measurementRef.current);

    const setElementRef = useCallback((element: HTMLElement | null) => {
      elementRef.current = element;
      triggerRef.current = element?.closest<HTMLElement>("[data-overflow-trigger]") ?? element;
      assignRef(forwardedRef, element);
    }, [forwardedRef]);

    const readOverflow = useCallback(() => {
      const element = elementRef.current;
      const content = contentRef.current ?? element;
      if (!element || !content) return;

      const distance = Math.max(0, content.scrollWidth - element.clientWidth);
      // Single-line text has a font-metric-sized content box; only multiline
      // clamps use vertical overflow as a truncation signal. Horizontal
      // measurement still uses the full content width for fade and marquee.
      const hasVerticalClampOverflow = lines !== undefined
        && element.clientHeight > 0
        && element.scrollHeight > element.clientHeight;
      const isOverflowing = element.clientWidth > 0
        && (distance > 0 || hasVerticalClampOverflow);
      const current = measurementRef.current;
      if (current.distance === distance && current.isOverflowing === isOverflowing) return;

      const next = { distance, isOverflowing };
      return () => {
        measurementRef.current = next;
        setMeasurement(next);
      };
    }, [lines]);

    const updateOverflow = useCallback(() => {
      const view = elementRef.current?.ownerDocument.defaultView;
      if (view) scheduleOverflowMeasurement(view, readOverflow);
    }, [readOverflow]);

    const prepareTooltip = useCallback(() => {
      const element = elementRef.current;
      const trigger = triggerRef.current;
      if (!element || !trigger) return false;

      // One tooltip per control, even when its label and metadata both overflow.
      // Nested text slots contribute only their innermost full-text content.
      const slots = trigger === element
        ? [element]
        : Array.from(trigger.querySelectorAll<HTMLElement>('[data-overflow-tooltip="true"]'))
          .filter(slot => slot.closest("[data-overflow-trigger]") === trigger
            && !slot.querySelector('[data-overflow-tooltip="true"]'));
      if (slots[0] !== element) return false;
      const text = slots.map(slot => slot.getAttribute("data-overflow-text") ?? slot.textContent ?? "")
        .filter(Boolean).join("\n");
      if (!text) return false;
      setTooltipText(text);
      return true;
    }, []);

    useIsomorphicLayoutEffect(() => {
      updateOverflow();
      const view = elementRef.current?.ownerDocument.defaultView;
      return () => { if (view) cancelOverflowMeasurement(view, readOverflow); };
    }, [behavior, children, lines, overflowStyle, readOverflow, updateOverflow]);

    useEffect(() => {
      if (measurementRef.current.isOverflowing) prepareTooltip();
    }, [children, title, prepareTooltip]);

    useEffect(() => {
      const element = elementRef.current;
      if (!element) return undefined;

      const resizeObserver = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateOverflow);
      resizeObserver?.observe(element);
      if (contentRef.current) resizeObserver?.observe(contentRef.current);

      const fontSet = element.ownerDocument.fonts;
      fontSet?.addEventListener("loadingdone", updateOverflow);
      // Rich labels may update their own descendants without changing this slot's props.
      const mutationObserver = textOnly || typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => { updateOverflow(); prepareTooltip(); });
      mutationObserver?.observe(element, { childList: true, characterData: true, subtree: true });

      if (!resizeObserver) {
        element.ownerDocument.defaultView?.addEventListener("resize", updateOverflow);
      }

      return () => {
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        fontSet?.removeEventListener("loadingdone", updateOverflow);
        if (!resizeObserver) {
          element.ownerDocument.defaultView?.removeEventListener("resize", updateOverflow);
        }
      };
    }, [behavior, overflowStyle, prepareTooltip, textOnly, updateOverflow]);

    const marqueeDuration = Math.max(
      MARQUEE_MIN_DURATION_MS,
      Math.round((measurement.distance / MARQUEE_PIXELS_PER_SECOND) * 1000),
    );
    const resolvedStyle = {
      ...style,
      ...(lines ? { "--_overflow-text-lines": lines } : {}),
      ...(behavior === "marquee" ? {
          "--_overflow-text-marquee-distance": `${measurement.distance}px`,
          "--_overflow-text-marquee-duration": `${marqueeDuration}ms`,
      } : {}),
    } as CSSProperties;

    const hasOverflowTooltip = measurement.isOverflowing && !hasExplicitTooltip && title !== "";

    return (
      <>
      <Tag
        {...props}
        className={classNames(styles.root, className)}
        data-marquee-active={marqueeActive && marqueeTrigger !== "interaction" ? "true" : undefined}
        data-marquee-trigger={marqueeTrigger}
        data-overflow={measurement.isOverflowing ? "true" : "false"}
        data-overflow-behavior={behavior}
        data-overflow-lines={lines}
        data-overflow-style={lines ? undefined : overflowStyle}
        data-overflow-tooltip={hasOverflowTooltip ? "true" : undefined}
        data-overflow-text={title}
        ref={setElementRef}
        style={resolvedStyle}
        title={hasOverflowTooltip ? undefined : title}
      >
        {behavior === "marquee" || ((textOnly || overflowStyle === "ellipsis") && lines === undefined) ? (
          <span className={styles.content} data-openbitfun-part="content" data-overflow-content="" ref={contentRef}>
            {children}
          </span>
        ) : children}
      </Tag>
      {hasOverflowTooltip && (
        <Tooltip
          active={marqueeActive && marqueeTrigger !== "interaction"}
          content={tooltipText}
          interactive
          onBeforeShow={prepareTooltip}
          trigger="hover-focus"
          triggerRef={triggerRef}
        />
      )}
      </>
    );
  },
);
