import { forwardRef, useCallback, useEffect, useRef, type HTMLAttributes } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./ScrollArea.module.css";

export type ScrollAreaOrientation = "vertical" | "horizontal" | "both";
export type ScrollbarVisibility = "auto" | "hover" | "always" | "hidden";
export type ScrollAreaEdgeFade = "none" | "vertical";
export type ScrollAreaOverscrollBehaviorY = "auto" | "contain";

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  "data-openbitfun-component"?: string;
  "data-openbitfun-part"?: string;
  orientation?: ScrollAreaOrientation;
  /** Fade only the vertical edges with more content beyond the viewport. */
  edgeFade?: ScrollAreaEdgeFade;
  /** Let vertical scrolling continue to an ancestor when this viewport reaches an edge. */
  overscrollBehaviorY?: ScrollAreaOverscrollBehaviorY;
  /** Auto preserves track space; hover also removes idle mouse tracks. Touch remains visible. */
  scrollbarVisibility?: ScrollbarVisibility;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  function ScrollArea({
    className,
    "data-openbitfun-component": component = "scroll-area",
    "data-openbitfun-part": part = "viewport",
    edgeFade = "none",
    orientation = "vertical",
    overscrollBehaviorY = "contain",
    scrollbarVisibility = "auto",
    ...props
  }, ref) {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const setViewportRef = useCallback((viewport: HTMLDivElement | null) => {
      viewportRef.current = viewport;
      if (typeof ref === "function") ref(viewport);
      else if (ref) ref.current = viewport;
    }, [ref]);

    useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport || edgeFade !== "vertical" || orientation === "horizontal") return;

      let previousMeasurement = "";
      const updateEdges = () => {
        const { clientHeight, clientWidth, offsetHeight, offsetWidth, scrollHeight, scrollTop } = viewport;
        const overflow = clientHeight > 0 && scrollHeight - clientHeight > 1;
        const top = overflow && scrollTop > 1;
        const bottom = overflow && scrollTop < scrollHeight - clientHeight - 1;
        const inlineGutter = Math.max(0, offsetWidth - clientWidth);
        const blockGutter = Math.max(0, offsetHeight - clientHeight);
        const measurement = `${top}:${bottom}:${inlineGutter}:${blockGutter}`;
        if (measurement === previousMeasurement) return;
        previousMeasurement = measurement;
        viewport.dataset.openbitfunFadeTop = String(top);
        viewport.dataset.openbitfunFadeBottom = String(bottom);
        viewport.style.setProperty("--_scroll-area-inline-gutter", `${inlineGutter}px`);
        viewport.style.setProperty("--_scroll-area-block-gutter", `${blockGutter}px`);
      };

      // Observe the viewport and its content, including a virtualizer's spacer.
      // Attribute changes written above are deliberately outside the observer.
      const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateEdges);
      const observed = new Set<Element>();
      const observeContent = () => {
        const current = new Set<Element>([viewport, ...viewport.children]);
        for (const element of observed) {
          if (!current.has(element)) {
            resizeObserver?.unobserve(element);
            observed.delete(element);
          }
        }
        for (const element of current) {
          if (!observed.has(element)) {
            resizeObserver?.observe(element);
            observed.add(element);
          }
        }
        updateEdges();
      };
      const mutationObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(observeContent);
      mutationObserver?.observe(viewport, { childList: true, characterData: true, subtree: true });
      viewport.addEventListener("scroll", updateEdges, { passive: true });
      const view = viewport.ownerDocument.defaultView;
      view?.addEventListener("resize", updateEdges);
      observeContent();

      return () => {
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
        viewport.removeEventListener("scroll", updateEdges);
        view?.removeEventListener("resize", updateEdges);
        delete viewport.dataset.openbitfunFadeTop;
        delete viewport.dataset.openbitfunFadeBottom;
        viewport.style.removeProperty("--_scroll-area-inline-gutter");
        viewport.style.removeProperty("--_scroll-area-block-gutter");
      };
    }, [edgeFade, orientation]);

    return (
      <div
        {...props}
        className={classNames(styles.root, className)}
        data-openbitfun-component={component}
        data-openbitfun-edge-fade={edgeFade}
        data-openbitfun-orientation={orientation}
        data-openbitfun-overscroll-behavior-y={overscrollBehaviorY}
        data-openbitfun-part={part}
        data-openbitfun-scrollbar-visibility={scrollbarVisibility}
        ref={setViewportRef}
      />
    );
  },
);
