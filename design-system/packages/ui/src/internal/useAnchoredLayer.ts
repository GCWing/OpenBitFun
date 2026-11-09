import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type LayerPlacement = "top" | "bottom" | "left" | "right";
/** Cross-axis edge shared with the anchor for top/bottom placement; logical, so RTL mirrors it. */
export type LayerAlign = "start" | "end";
export type PortalTarget = Element | DocumentFragment | (() => Element | DocumentFragment | null) | null;

/** Default portals stay inside the nearest theme scope; hosts may supply an overlay root. */
export function resolveLayerPortal(target: PortalTarget | undefined, anchor: HTMLElement | null) {
  if (typeof target === "function") return target();
  return target ?? anchor?.closest("[data-openbitfun-design-system-root]") ?? anchor?.ownerDocument.body ?? null;
}

export function useAnchoredLayer({ open, anchorRef, layerRef, placement = "bottom", align = "start", matchWidth = false, overlapAnchor = false, revision, point, fallbackRect }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  layerRef: RefObject<HTMLElement | null>;
  placement?: LayerPlacement;
  align?: LayerAlign;
  /** Match the anchor exactly, or use its width as the layer's minimum. */
  matchWidth?: boolean | "minimum";
  /** Position the layer over the anchor when the layer visually replaces it. */
  overlapAnchor?: boolean;
  revision?: unknown;
  point?: { x: number; y: number };
  /** Keep the action's origin when a menu item disappears before the layer mounts. */
  fallbackRect?: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;
}) {
  const [layout, setLayout] = useState<{ style: CSSProperties; placement: LayerPlacement } | null>(null);
  const measuredContentWidth = useRef(0);
  useIsomorphicLayoutEffect(() => {
    if (!open) { measuredContentWidth.current = 0; setLayout(null); return; }
    const anchor = anchorRef.current;
    const layer = layerRef.current;
    const view = layer?.ownerDocument.defaultView;
    if (!layer || !view || (!anchor && !point && !fallbackRect)) return;
    const update = () => {
      const padding = 8;
      const resolvedGap = point ? 0 : 4;
      const rect = point
        ? { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 }
        : anchor?.isConnected ? anchor.getBoundingClientRect() : fallbackRect ?? anchor!.getBoundingClientRect();
      const viewport = view.visualViewport;
      const vx = viewport?.offsetLeft ?? 0;
      const vy = viewport?.offsetTop ?? 0;
      const vw = viewport?.width ?? view.innerWidth;
      const vh = viewport?.height ?? view.innerHeight;
      const maxWidth = Math.max(0, vw - padding * 2);
      const anchorWidth = Math.min(rect.width, maxWidth);
      const width = matchWidth === true ? anchorWidth : undefined;
      const minWidth = matchWidth === "minimum"
        ? Math.min(Math.max(anchorWidth, measuredContentWidth.current), maxWidth)
        : undefined;
      layer.style.maxWidth = `${maxWidth}px`;
      if (width !== undefined) layer.style.width = `${width}px`;
      if (minWidth !== undefined) layer.style.minWidth = `${minWidth}px`;
      const box = layer.getBoundingClientRect();
      // Filtering can remove the widest item. Keep the open surface stable.
      if (matchWidth === "minimum") {
        measuredContentWidth.current = Math.max(measuredContentWidth.current, box.width);
      }
      const horizontal = placement === "left" || placement === "right";
      const before = horizontal ? rect.left - vx : rect.top - vy;
      const after = horizontal ? vx + vw - rect.right : vy + vh - rect.bottom;
      const anchorExtent = horizontal ? rect.width : rect.height;
      const overlapExtent = overlapAnchor ? anchorExtent : -resolvedGap;
      const beforeCapacity = before + overlapExtent;
      const afterCapacity = after + overlapExtent;
      const needs = (horizontal ? box.width : box.height) + padding;
      const preferBefore = placement === "top" || placement === "left";
      const useBefore = preferBefore
        ? beforeCapacity >= needs || beforeCapacity > afterCapacity
        : afterCapacity < needs && beforeCapacity > afterCapacity;
      const side: LayerPlacement = horizontal ? (useBefore ? "left" : "right") : (useBefore ? "top" : "bottom");
      const maxHeight = horizontal
        ? vh - padding * 2
        : Math.max(0, (useBefore ? beforeCapacity : afterCapacity) - padding);
      const height = Math.min(box.height, maxHeight);
      const left = horizontal
        ? overlapAnchor
          ? (useBefore ? rect.right - box.width : rect.left)
          : (useBefore ? rect.left - box.width - resolvedGap : rect.right + resolvedGap)
        : alignToRight(align, view.getComputedStyle(layer).direction === "rtl")
          ? rect.right - box.width
          : rect.left;
      const top = horizontal
        ? rect.top
        : overlapAnchor
          ? (useBefore ? rect.bottom - height : rect.top)
          : (useBefore ? rect.top - height - resolvedGap : rect.bottom + resolvedGap);
      const style: CSSProperties = {
        position: "fixed", width, minWidth, maxWidth, maxHeight,
        left: Math.max(vx + padding, Math.min(left, vx + vw - box.width - padding)),
        top: Math.max(vy + padding, Math.min(top, vy + vh - height - padding)),
      };
      setLayout(previous => JSON.stringify(previous) === JSON.stringify({ style, placement: side }) ? previous : { style, placement: side });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (anchor) observer?.observe(anchor);
    observer?.observe(layer);
    view.addEventListener("resize", update);
    view.addEventListener("scroll", update, true);
    view.visualViewport?.addEventListener("resize", update);
    view.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer?.disconnect();
      view.removeEventListener("resize", update);
      view.removeEventListener("scroll", update, true);
      view.visualViewport?.removeEventListener("resize", update);
      view.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, anchorRef, layerRef, placement, align, matchWidth, overlapAnchor, revision, point?.x, point?.y, fallbackRect]);
  return layout;
}

function alignToRight(align: LayerAlign, rtl: boolean) {
  return (align === "end") !== rtl;
}
