import {
  Children, createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type Key, type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FieldSurfaceContext } from "../internal/fieldSurface";
import { LayerStackContext } from "../providers/DesignSystemProvider.context";
import { getOverlayLayerStack, type OverlayLayerStack } from "./LayerStack";
import { useDesignSystem } from "./useDesignSystem";
import { useDismissibleLayer } from "./useDismissibleLayer";
import { useFocusScope } from "./useFocusScope";
import { useScrollLock } from "./useScrollLock";
import type { OverlayDismissReason, OverlayPortalContainer, OverlayPortalTarget } from "./types";
import styles from "./Portal.module.css";

const ParentLayerContext = createContext<{ id: symbol; stack: OverlayLayerStack } | null>(null);

/** A neutral, document-owned host. It never transforms viewport coordinates. */
export function getOverlayHost(ownerDocument: Document): HTMLDivElement {
  const existing = ownerDocument.querySelector<HTMLDivElement>('[data-openbitfun-overlay-host="true"]');
  if (existing) return existing;
  const host = ownerDocument.createElement("div");
  host.setAttribute("data-openbitfun-overlay-host", "true");
  Object.assign(host.style, {
    position: "fixed", inset: "0", zIndex: "var(--openbitfun-layer-overlay-host)", pointerEvents: "none",
  });
  ownerDocument.body.appendChild(host);
  return host;
}

export function resolvePortalTarget(
  target: OverlayPortalTarget | undefined, fallbackDocument?: Document | null,
): OverlayPortalContainer | null {
  const resolved = typeof target === "function" ? target() : target;
  if (resolved && resolved !== resolved.ownerDocument?.body) return resolved;
  const ownerDocument = resolved?.ownerDocument ?? fallbackDocument
    ?? (typeof document === "undefined" ? null : document);
  return ownerDocument ? getOverlayHost(ownerDocument) : null;
}

export interface PortalProps {
  children: ReactNode;
  ownerDocument?: Document | null;
  target?: OverlayPortalTarget;
  /** Keep mounted while exiting; logical closure immediately disables dismissal. */
  open?: boolean;
  modal?: boolean;
  preventScroll?: boolean;
  /** Background notices wait for the current modal before first presentation. */
  passive?: boolean;
  /** Portalled siblings can declare the trigger that owns their interaction. */
  ownerRef?: RefObject<HTMLElement | null>;
  surfaceRef?: RefObject<HTMLElement | null>;
  onDismiss?: (reason: OverlayDismissReason) => void;
  dismissOnEscape?: boolean;
  dismissOnPointerOutside?: boolean;
}

interface LayerPlacementProps {
  /** Only neutral layout ancestors may surround an inline layer. */
  inline?: boolean;
}

function PresentedPortal({
  children, container, open = true, modal = false, passive = false, ownerRef, surfaceRef,
  onDismiss, dismissOnEscape = true, dismissOnPointerOutside = false, inline, preventScroll = true,
}: PortalProps & LayerPlacementProps & { container: OverlayPortalContainer }) {
  const stack = getOverlayLayerStack(container.ownerDocument);
  const inherited = useContext(ParentLayerContext);
  const parentId = inherited?.stack === stack ? inherited.id : undefined;
  useSyncExternalStore(stack.subscribe, stack.getSnapshot, stack.getSnapshot);
  // Observe the completed commit before admitting background UI. A modal and
  // notice may be requested together, in either JSX order.
  const [committed, setCommitted] = useState(!passive);
  useLayoutEffect(() => { setCommitted(true); }, []);
  const admitted = useRef(false);
  const mayPresent = committed && (!passive || stack.canPresent(parentId
    ?? stack.getLayerForElement(ownerRef?.current ?? null)?.id));
  useLayoutEffect(() => { if (mayPresent) admitted.current = true; }, [mayPresent]);
  if (!admitted.current && !mayPresent) return null;
  return <LayerMount {...{ children, container, open, modal, passive, parentId, stack, surfaceRef,
    onDismiss, dismissOnEscape, dismissOnPointerOutside, inline, preventScroll, ownerRef }} />;
}

function LayerMount({
  children, container, open = true, modal = false, passive = false, parentId, stack, surfaceRef,
  onDismiss, dismissOnEscape, dismissOnPointerOutside, inline, preventScroll, ownerRef,
}: PortalProps & LayerPlacementProps & { container: OverlayPortalContainer; parentId?: symbol; stack: OverlayLayerStack }) {
  const [ticket] = useState(() => ({
    id: Symbol("openbitfun-overlay"), sequence: stack.reserveSequence(),
    // Capture before modal registration makes the background inert. Keep the
    // original return target through StrictMode's effect replay.
    activationFocus: container.ownerDocument.activeElement as HTMLElement | null,
  }));
  const slotRef = useRef<HTMLDivElement>(null);
  const ownerOpen = stack.hasOpenAncestors(ticket.id);
  const initial = useRef({ open, modal, passive });
  useLayoutEffect(() => {
    const element = slotRef.current;
    if (!element) return;
    return stack.registerLayer({ ...ticket, element, parentId, ownerElement: () => ownerRef?.current ?? null, ...initial.current });
  }, [ownerRef, parentId, stack, ticket]);
  useLayoutEffect(() => { stack.updateLayer(ticket.id, { open, modal, passive }); }, [modal, open, passive, stack, ticket]);
  useDismissibleLayer({
    enabled: open && Boolean(onDismiss), layerRef: surfaceRef ?? slotRef,
    branchRefs: ownerRef ? [ownerRef] : undefined,
    onDismiss: reason => onDismiss?.(reason), dismissOnEscape, dismissOnPointerOutside,
    ownerDocument: container.ownerDocument,
  });
  useFocusScope({
    active: open && modal && ownerOpen && Boolean(surfaceRef),
    containerRef: surfaceRef ?? slotRef,
    ownerDocument: container.ownerDocument,
  });
  useScrollLock(modal && ownerOpen && Boolean(preventScroll), container.ownerDocument);
  const content = (
    <LayerStackContext.Provider value={stack}>
      <ParentLayerContext.Provider value={{ id: ticket.id, stack }}>
        <FieldSurfaceContext.Provider value="default">
          <div ref={slotRef} className={inline ? styles.inlineLayer : styles.layer} data-openbitfun-overlay-layer=""
            data-openbitfun-overlay-modal={modal || undefined} {...(!open ? { inert: "" } : {})}>
            {children}
          </div>
        </FieldSurfaceContext.Provider>
      </ParentLayerContext.Provider>
    </LayerStackContext.Provider>
  );
  return inline ? content : createPortal(content, container);
}

/** Layout-only portal: its children must each own an OverlayLayer. */
export function OverlayRegion({ children, target, ownerDocument }: Pick<PortalProps, "children" | "target" | "ownerDocument">) {
  const designSystem = useDesignSystem();
  const container = resolvePortalTarget(target === undefined ? designSystem.portalHost : target, ownerDocument);
  return container ? createPortal(children, container) : null;
}

/** Independent paint order inside a neutral, non-stacking layout/scroll region. */
export function OverlayLayer({ children, ownerDocument, ...options }: Omit<PortalProps, "target">) {
  const designSystem = useDesignSystem();
  const container = resolvePortalTarget(designSystem.portalHost, ownerDocument);
  return container ? <PresentedPortal {...options} container={container} inline>{children}</PresentedPortal> : null;
}

export function Portal({ children, target, ownerDocument, ...options }: PortalProps) {
  const designSystem = useDesignSystem();
  const container = resolvePortalTarget(target === undefined ? designSystem.portalHost : target, ownerDocument);
  return container && Children.toArray(children).length > 0
    ? <PresentedPortal {...options} container={container}>{children}</PresentedPortal> : null;
}

/** JSX-equivalent bridge for callers that compose a portal as an expression. */
export function createOverlayPortal(children: ReactNode, target?: OverlayPortalTarget, key?: Key | null, options?: Omit<PortalProps, "children" | "target">) {
  return <Portal key={key} target={target} {...options}>{children}</Portal>;
}
