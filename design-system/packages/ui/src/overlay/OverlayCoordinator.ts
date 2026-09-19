import { isImeOwnedKeyboardEvent } from "../internal/ime";
import type { OverlayDismissReason, OverlayLayerScope } from "./types";

export interface OverlayLayerDescriptor {
  id: symbol;
  onDismiss: (reason: OverlayDismissReason) => void;
  scope?: OverlayLayerScope;
  element?: () => HTMLElement | null;
  containsTarget?: (target: Node) => boolean;
  dismissOnEscape?: boolean;
  dismissOnPointerOutside?: boolean;
}

export interface OverlayLayerRegistration {
  id: symbol;
  sequence: number;
  element: HTMLElement;
  parentId?: symbol;
  ownerElement?: () => HTMLElement | null;
  activationFocus?: HTMLElement | null;
  open: boolean;
  modal: boolean;
  passive: boolean;
}

export interface OverlayFocusRegistration {
  id: symbol;
  element: HTMLElement;
  autoFocus: boolean;
  trapFocus: boolean;
  restoreFocus: boolean;
  initialFocus?: HTMLElement | null;
  previousFocus: HTMLElement | null;
}

export type OverlayInteractionType = "keydown" | "mousedown" | "pointerdown";
interface OverlayInteraction {
  id: symbol;
  type: OverlayInteractionType;
  element: () => HTMLElement | null;
  listener: (event: Event) => void;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function focusableElements(container: HTMLElement, tabbable = false): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => !element.closest('[inert],[hidden],[aria-hidden="true"]') && (!tabbable || element.tabIndex >= 0));
}

/** Document-local ownership shared by paint, dismissal and modal focus. */
export class OverlayLayerStack {
  private layers = new Map<symbol, OverlayLayerRegistration>();
  private dismissibles = new Map<symbol, OverlayLayerDescriptor & { sequence: number }>();
  private focusScopes = new Map<symbol, OverlayFocusRegistration>();
  private interactions = new Map<symbol, OverlayInteraction>();
  private listeners = new Set<() => void>();
  private hiddenElements = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();
  private version = 0;
  private sequence = 0;
  private listening = false;
  private redirectingFocus = false;
  private pointerGesture?: { target: EventTarget | null; top?: OverlayLayerRegistration };
  private pendingFocusRestores: Array<{ scope: OverlayFocusRegistration; layer?: OverlayLayerRegistration }> = [];

  constructor(readonly ownerDocument?: Document) {}

  // Tickets do not publish state. A committed opening retains its ticket
  // through strict effect replay, content updates and the exit animation.
  reserveSequence(): number { return ++this.sequence; }

  registerLayer(layer: OverlayLayerRegistration): () => void {
    this.layers.set(layer.id, layer);
    this.changed();
    return () => {
      if (this.layers.get(layer.id) !== layer) return;
      this.layers.delete(layer.id);
      this.changed();
    };
  }

  updateLayer(id: symbol, values: Pick<OverlayLayerRegistration, "open" | "modal" | "passive">): void {
    const layer = this.layers.get(id);
    if (!layer || (layer.open === values.open && layer.modal === values.modal && layer.passive === values.passive)) return;
    if (!layer.open && values.open) {
      layer.sequence = this.reserveSequence();
      layer.activationFocus = this.ownerDocument?.activeElement as HTMLElement | null;
    }
    Object.assign(layer, values);
    this.changed();
  }

  getLayerForElement(element: Node | null): OverlayLayerRegistration | undefined {
    if (!element) return undefined;
    return [...this.layers.values()].filter(layer => layer.element.contains(element))
      .sort((a, b) => a.element.contains(b.element) ? 1 : b.element.contains(a.element) ? -1 : b.sequence - a.sequence)[0];
  }

  private parentOf(layer: OverlayLayerRegistration): symbol | undefined {
    // Resolve after refs attach, then retain ownership through parent teardown.
    layer.parentId ??= this.getLayerForElement(layer.ownerElement?.() ?? null)?.id;
    return layer.parentId;
  }

  isDescendant(id: symbol | undefined, ancestor: symbol): boolean {
    const visited = new Set<symbol>();
    while (id && !visited.has(id)) {
      if (id === ancestor) return true;
      visited.add(id);
      const layer = this.layers.get(id);
      id = layer && this.parentOf(layer);
    }
    return false;
  }

  hasModal(): boolean { return Boolean(this.topModal()); }
  hasOpenAncestors(id: symbol): boolean {
    const layer = this.layers.get(id);
    return !layer || this.ancestorsOpen(layer);
  }
  canPresent(parentId?: symbol): boolean {
    const modal = this.topModal();
    return !modal || this.isDescendant(parentId, modal.id);
  }

  register(descriptor: OverlayLayerDescriptor): () => void {
    const registered = Object.assign(descriptor, { sequence: this.reserveSequence() });
    this.dismissibles.set(descriptor.id, registered);
    this.changed();
    return () => {
      if (this.dismissibles.get(descriptor.id) !== registered) return;
      this.dismissibles.delete(descriptor.id);
      this.changed();
    };
  }
  isTopLayer(id: symbol): boolean { return this.topDismissible()?.id === id; }
  dismissTop(scope?: OverlayLayerScope): boolean {
    const layer = this.topDismissible(scope);
    if (!layer) return false;
    layer.onDismiss("programmatic");
    return true;
  }
  dismissAll(): boolean {
    const layers = this.orderedDismissibles();
    layers.reverse().forEach(layer => layer.onDismiss("programmatic"));
    return layers.length > 0;
  }
  hasLayers(scope?: OverlayLayerScope): boolean {
    const dismissibles = this.orderedDismissibles();
    return scope ? dismissibles.some(layer => layer.scope === scope)
      : [...this.layers.values()].some(layer => (layer.open || layer.modal) && !layer.passive && this.ancestorsOpen(layer))
        || dismissibles.length > 0;
  }

  registerFocusScope(scope: OverlayFocusRegistration): () => void {
    const owner = this.getLayerForElement(scope.element);
    if (owner?.modal && owner.activationFocus !== undefined) scope.previousFocus = owner.activationFocus;
    this.focusScopes.set(scope.id, scope);
    if (scope.autoFocus && this.topFocusScope()?.id === scope.id) this.focusFirst(scope);
    return () => {
      const wasTop = this.topFocusScope(true)?.id === scope.id;
      const layer = this.getLayerForElement(scope.element);
      this.focusScopes.delete(scope.id);
      if (!wasTop || !scope.restoreFocus) return;
      this.pendingFocusRestores.push({ scope, layer });
      this.restoreFocus();
    };
  }

  private restoreFocus(): void {
    for (let index = this.pendingFocusRestores.length - 1; index >= 0; index -= 1) {
      const restore = this.pendingFocusRestores[index];
      if (!restore) continue;
      const { scope, layer } = restore;
      // A modal's exit remains a barrier. Restore only after it releases inert.
      if (layer?.modal && this.layers.has(layer.id)) continue;
      const nextScope = this.topFocusScope();
      const nextLayer = nextScope && this.getLayerForElement(nextScope.element);
      if (nextLayer && layer && nextLayer.sequence > layer.sequence) continue;
      const target = scope.previousFocus;
      if (target?.isConnected && !target.closest('[inert],[hidden],[aria-hidden="true"]')
        && (!nextScope?.trapFocus || this.inFocusDomain(target, nextScope))) {
        this.pendingFocusRestores.splice(index, 1);
        target.focus({ preventScroll: true });
        return;
      }
      if (this.topModal()) continue;
      this.pendingFocusRestores.splice(index, 1);
      if (nextScope) this.focusFirst(nextScope);
    }
  }

  registerInteraction(interaction: OverlayInteraction): () => void {
    this.interactions.set(interaction.id, interaction);
    this.changed();
    return () => { this.interactions.delete(interaction.id); this.changed(); };
  }

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): number => this.version;

  private orderedLayers(): OverlayLayerRegistration[] {
    const activation = (layer: OverlayLayerRegistration, visited = new Set<symbol>()): number => {
      if (visited.has(layer.id)) return layer.sequence;
      visited.add(layer.id);
      const parentId = this.parentOf(layer);
      const parent = parentId && this.layers.get(parentId);
      return parent ? Math.max(layer.sequence, activation(parent, visited)) : layer.sequence;
    };
    const pending = [...this.layers.values()].sort((a, b) => activation(a) - activation(b) || a.sequence - b.sequence);
    const result: OverlayLayerRegistration[] = [];
    const visited = new Set<symbol>();
    const visit = (layer: OverlayLayerRegistration) => {
      if (visited.has(layer.id)) return;
      visited.add(layer.id);
      const parentId = this.parentOf(layer);
      const parent = parentId && this.layers.get(parentId);
      if (parent) visit(parent);
      result.push(layer);
    };
    pending.forEach(visit);
    return result;
  }
  private topModal(): OverlayLayerRegistration | undefined {
    return this.orderedLayers().reverse().find(layer => layer.modal && this.ancestorsOpen(layer));
  }
  private ancestorsOpen(layer: OverlayLayerRegistration): boolean {
    let parentId = this.parentOf(layer);
    const visited = new Set([layer.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = this.layers.get(parentId);
      if (!parent?.open) return false;
      parentId = this.parentOf(parent);
    }
    return !parentId;
  }
  private isAvailable(layer: OverlayLayerRegistration): boolean {
    if (!layer.open || !this.ancestorsOpen(layer)) return false;
    const modal = this.topModal();
    return !modal || this.isDescendant(layer.id, modal.id);
  }
  private orderedDismissibles() {
    const order = this.orderedLayers();
    return [...this.dismissibles.values()].filter(descriptor => {
      const element = descriptor.element?.();
      if (descriptor.element && !element?.isConnected) return false;
      const layer = this.getLayerForElement(element ?? null);
      return layer ? this.isAvailable(layer) : !this.topModal();
    }).sort((a, b) => {
      const first = this.getLayerForElement(a.element?.() ?? null);
      const second = this.getLayerForElement(b.element?.() ?? null);
      return (first ? order.indexOf(first) : -1) - (second ? order.indexOf(second) : -1) || a.sequence - b.sequence;
    });
  }
  private interactionTop(target?: Node | null): OverlayLayerRegistration | undefined {
    return this.orderedLayers().reverse().find(layer => this.isAvailable(layer)
      && (!layer.passive || layer.element.contains(target ?? this.ownerDocument?.activeElement ?? null)));
  }
  private topDismissible(scope?: OverlayLayerScope, visualTop = this.interactionTop()) {
    const candidates = this.orderedDismissibles().filter(descriptor => scope
      ? descriptor.scope === scope
      : !visualTop || this.getLayerForElement(descriptor.element?.() ?? null) === visualTop);
    const candidate = candidates[candidates.length - 1];
    if (!candidate || scope) return candidate;
    const candidateLayer = this.getLayerForElement(candidate.element?.() ?? null);
    // An undismissible child or a focused notice must not close a lower surface.
    if (visualTop && visualTop !== candidateLayer) return undefined;
    return candidate;
  }
  private topFocusScope(includeExiting = false): OverlayFocusRegistration | undefined {
    const order = this.orderedLayers();
    const scopes = [...this.focusScopes.values()].filter(scope => {
      const layer = this.getLayerForElement(scope.element);
      return layer ? (includeExiting || this.isAvailable(layer)) : !this.topModal();
    }).sort((a, b) => order.indexOf(this.getLayerForElement(a.element)!) - order.indexOf(this.getLayerForElement(b.element)!));
    return scopes[scopes.length - 1];
  }
  private trappingScope(): OverlayFocusRegistration | undefined {
    const modal = this.topModal();
    return [...this.focusScopes.values()].reverse().find(scope => {
      const layer = this.getLayerForElement(scope.element);
      return scope.trapFocus && (layer ? this.isAvailable(layer) : !modal)
        && (!modal || layer?.id === modal.id);
    });
  }
  private inFocusDomain(target: Node, scope: OverlayFocusRegistration): boolean {
    if (scope.element.contains(target)) return true;
    const owner = this.getLayerForElement(scope.element);
    const targetLayer = this.getLayerForElement(target);
    return Boolean(owner && targetLayer && this.isAvailable(targetLayer) && this.isDescendant(targetLayer.id, owner.id));
  }
  private focusFirst(scope: OverlayFocusRegistration): void {
    (scope.initialFocus ?? focusableElements(scope.element)[0] ?? scope.element).focus({ preventScroll: true });
  }

  private routeInteraction(type: OverlayInteractionType, event: Event, top = this.interactionTop(event.target as Node | null)): void {
    const layers = this.orderedLayers();
    const candidates = [...this.interactions.values()].filter(interaction => {
      if (interaction.type !== type) return false;
      const layer = this.getLayerForElement(interaction.element());
      return layer ? this.isAvailable(layer) && (!top || this.isDescendant(top.id, layer.id))
        : !top && Boolean(interaction.element()) && !this.hasModal();
    }).sort((a, b) => layers.indexOf(this.getLayerForElement(a.element())!) - layers.indexOf(this.getLayerForElement(b.element())!));
    const owner = this.getLayerForElement(candidates[candidates.length - 1]?.element() ?? null);
    for (const candidate of candidates) {
      if (event.defaultPrevented) break;
      if (this.getLayerForElement(candidate.element()) === owner) candidate.listener(event);
    }
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isImeOwnedKeyboardEvent(event)) return;
    const top = this.interactionTop(event.target as Node | null);
    const descriptor = this.topDismissible(undefined, top);
    if (event.key === "Escape" && descriptor) {
      if (descriptor.dismissOnEscape === false) return;
      event.preventDefault(); event.stopPropagation();
      descriptor.onDismiss("escape-key");
      return;
    }
    this.routeInteraction("keydown", event, top);
    if (event.defaultPrevented) return;
    if (event.key === "Tab") {
      const scope = this.trappingScope();
      if (!scope) return;
      const owner = this.getLayerForElement(scope.element);
      const elements = focusableElements(scope.element, true);
      if (owner) this.orderedLayers().filter(layer => layer.id !== owner.id && this.isAvailable(layer)
        && this.isDescendant(layer.id, owner.id)).forEach(layer => elements.push(...focusableElements(layer.element, true)));
      const first = elements[0], last = elements[elements.length - 1], active = this.ownerDocument?.activeElement;
      if (!first || !active || !this.inFocusDomain(active, scope)) {
        event.preventDefault(); (first ?? scope.element).focus();
      } else if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    }
  };
  private handleKeyDownCapture = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || isImeOwnedKeyboardEvent(event)) return;
    const target = event.target as Node | null;
    const top = this.interactionTop(target);
    if (!top || this.getLayerForElement(target) === top) return;
    // Focus can remain in an older card/trigger after a pointer-opened menu.
    // Let only the visual top consume Escape; a lower React handler must not
    // get an opportunity to dismiss its own card first.
    this.handleKeyDown(event);
    event.preventDefault();
    event.stopPropagation();
  };
  private handlePointerDown = (event: PointerEvent) => {
    const top = this.interactionTop(event.target as Node | null);
    this.pointerGesture = { target: event.target, top };
    const descriptor = this.topDismissible(undefined, top);
    if (!descriptor) this.routeInteraction("pointerdown", event, top);
    if (event.defaultPrevented) return;
    if (!descriptor || descriptor.dismissOnPointerOutside === false) return;
    const target = event.target as Node | null;
    if (!target?.nodeType || descriptor.element?.()?.contains(target) || descriptor.containsTarget?.(target)) return;
    const owner = this.getLayerForElement(descriptor.element?.() ?? null);
    const targetLayer = this.getLayerForElement(target);
    if (owner && targetLayer && targetLayer.id !== owner.id && this.isDescendant(targetLayer.id, owner.id)) return;
    descriptor.onDismiss("pointer-outside");
  };
  private handleMouseDown = (event: MouseEvent) => {
    const gesture = this.pointerGesture;
    this.pointerGesture = undefined;
    if (gesture?.target === event.target && gesture.top) {
      // pointerdown may already have closed the top layer. Its compatibility
      // mouse event must not dismiss the next surface in the same gesture.
      if (this.layers.has(gesture.top.id) && this.isAvailable(gesture.top)) {
        this.routeInteraction("mousedown", event, gesture.top);
      }
      return;
    }
    this.routeInteraction("mousedown", event);
  };
  private handleFocusIn = (event: FocusEvent) => {
    const scope = this.trappingScope(), target = event.target as Node | null;
    if (this.redirectingFocus || !scope || !target?.nodeType || this.inFocusDomain(target, scope)) return;
    this.redirectingFocus = true;
    this.focusFirst(this.topFocusScope() ?? scope);
    this.redirectingFocus = false;
  };

  private reconcileInert(): void {
    const modal = this.topModal(), hidden = new Set<HTMLElement>();
    if (modal && this.ownerDocument?.defaultView) {
      const HTMLElementType = this.ownerDocument.defaultView.HTMLElement;
      const allowed = this.orderedLayers().filter(layer => this.isDescendant(layer.id, modal.id)).map(layer => layer.element);
      const visit = (parent: Element) => Array.from(parent.children).forEach(child => {
        if (!(child instanceof HTMLElementType) || allowed.includes(child)) return;
        if (allowed.some(element => child.contains(element))) visit(child);
        else hidden.add(child);
      });
      visit(this.ownerDocument.body);
    }
    for (const [element, previous] of this.hiddenElements) {
      if (hidden.has(element)) continue;
      element.toggleAttribute("inert", previous.inert);
      if (previous.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", previous.ariaHidden);
      this.hiddenElements.delete(element);
    }
    hidden.forEach(element => {
      if (!this.hiddenElements.has(element)) this.hiddenElements.set(element, {
        inert: element.hasAttribute("inert"), ariaHidden: element.getAttribute("aria-hidden"),
      });
      element.setAttribute("inert", ""); element.setAttribute("aria-hidden", "true");
    });
  }
  private changed(): void {
    this.orderedLayers().forEach((layer, index) => {
      layer.element.style.zIndex = String(index + 1);
      layer.element.dataset.openbitfunOverlayState = layer.open ? "open" : "exiting";
      layer.element.hidden = !this.ancestorsOpen(layer);
      layer.element.style.pointerEvents = layer.modal && !layer.open ? "auto" : "none";
    });
    this.reconcileInert();
    this.layers.forEach(layer => { if (!layer.open) layer.element.setAttribute("inert", ""); });
    this.restoreFocus();
    const shouldListen = this.layers.size + this.dismissibles.size + this.interactions.size > 0;
    if (this.ownerDocument && shouldListen !== this.listening) {
      this.listening = shouldListen;
      const operation = shouldListen ? "addEventListener" : "removeEventListener";
      this.ownerDocument[operation]("keydown", this.handleKeyDownCapture as EventListener, true);
      // Local menu/input keyboard behavior runs before the document fallback.
      this.ownerDocument[operation]("keydown", this.handleKeyDown as EventListener);
      this.ownerDocument[operation]("pointerdown", this.handlePointerDown as EventListener, true);
      this.ownerDocument[operation]("mousedown", this.handleMouseDown as EventListener, true);
      this.ownerDocument[operation]("focusin", this.handleFocusIn as EventListener, true);
    }
    this.version += 1;
    this.listeners.forEach(listener => listener());
  }
}

// Root UI and the separately built mobile entry can coexist in a document.
// A document-owned symbol keeps their module instances on the same coordinator.
const DOCUMENT_STACK = Symbol.for("openbitfun.overlay-coordinator.v1");
const serverStack = new OverlayLayerStack();
export function getOverlayLayerStack(ownerDocument?: Document | null): OverlayLayerStack {
  if (!ownerDocument) return serverStack;
  const documentOwner = ownerDocument as Document & { [DOCUMENT_STACK]?: OverlayLayerStack };
  if (!documentOwner[DOCUMENT_STACK]) {
    Object.defineProperty(documentOwner, DOCUMENT_STACK, { value: new OverlayLayerStack(ownerDocument) });
  }
  return documentOwner[DOCUMENT_STACK]!;
}
