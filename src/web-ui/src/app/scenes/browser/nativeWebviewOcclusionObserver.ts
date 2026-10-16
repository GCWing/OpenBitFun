import { NATIVE_WEBVIEW_OCCLUSION_SELECTOR } from './nativeWebviewVisibility';

type Listener = () => void;

class OcclusionObserver {
  private readonly listeners = new Map<HTMLElement, Set<Listener>>();
  private readonly overlays = new Set<Element>();
  private readonly mutations: MutationObserver;
  private readonly sizes: ResizeObserver;

  constructor(private readonly doc: Document, private readonly onDispose: Listener) {
    this.mutations = new MutationObserver(records => this.handleMutations(records));
    this.sizes = new ResizeObserver(() => this.update());
    this.start();
    doc.addEventListener('visibilitychange', this.handleVisibility);
    doc.addEventListener('scroll', this.handleGeometryEvent, true);
    doc.addEventListener('transitionend', this.handleGeometryEvent, true);
    doc.addEventListener('animationend', this.handleGeometryEvent, true);
    doc.defaultView?.addEventListener('resize', this.update);
  }

  subscribe(viewport: HTMLElement, update: Listener): Listener {
    let listeners = this.listeners.get(viewport);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(viewport, listeners);
      if (!this.doc.hidden) this.sizes.observe(viewport);
    }
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      if (listeners.size === 0) {
        this.listeners.delete(viewport);
        if (!this.overlays.has(viewport)) this.sizes.unobserve(viewport);
      }
      if (this.listeners.size === 0) this.dispose();
    };
  }

  private start(): void {
    if (this.doc.hidden) return;
    this.overlays.clear();
    for (const overlay of this.doc.querySelectorAll(NATIVE_WEBVIEW_OCCLUSION_SELECTOR)) {
      this.addOverlay(overlay);
    }
    for (const viewport of this.listeners.keys()) this.sizes.observe(viewport);
    this.mutations.observe(this.doc.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: [
        'style', 'class', 'hidden', 'data-state', 'data-openbitfun-state',
        'data-openbitfun-native-webview-occlusion', 'data-openbitfun-component',
        'data-openbitfun-part', 'data-openbitfun-product-component', 'data-openbitfun-product-part',
      ],
    });
  }

  private addOverlay(element: Element): void {
    if (this.overlays.has(element)) return;
    this.overlays.add(element);
    this.sizes.observe(element);
  }

  private removeOverlay(element: Element): boolean {
    if (!this.overlays.delete(element)) return false;
    if (!this.listeners.has(element as HTMLElement)) this.sizes.unobserve(element);
    return true;
  }

  private affectsGeometry(target: Node): boolean {
    for (const overlay of this.overlays) if (target.contains(overlay)) return true;
    for (const viewport of this.listeners.keys()) if (target.contains(viewport)) return true;
    return false;
  }

  private handleMutations(records: MutationRecord[]): void {
    let relevant = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target as Element;
        relevant ||= this.affectsGeometry(target);
        if (target.matches(NATIVE_WEBVIEW_OCCLUSION_SELECTOR)) {
          this.addOverlay(target);
          relevant = true;
        } else if (this.removeOverlay(target)) {
          relevant = true;
        }
        continue;
      }
      // A change inside a browser/overlay ancestor can move its rectangle.
      // Chat messages and unrelated animated descendants do not require a read.
      relevant ||= this.affectsGeometry(record.target);
      for (const node of record.removedNodes) {
        for (const overlay of this.overlays) {
          if (node.contains(overlay)) {
            this.removeOverlay(overlay);
            relevant = true;
          }
        }
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(NATIVE_WEBVIEW_OCCLUSION_SELECTOR)) {
          this.addOverlay(node);
          relevant = true;
        }
        // Inspect only the inserted subtree, never rescan the entire document.
        if (node.childElementCount > 0) {
          for (const overlay of node.querySelectorAll(NATIVE_WEBVIEW_OCCLUSION_SELECTOR)) {
            this.addOverlay(overlay);
            relevant = true;
          }
        }
      }
    }
    // Run before the next paint so a newly mounted popup cannot sit behind a
    // native child view for an extra animation frame.
    if (relevant) this.update();
  }

  private update = (): void => {
    if (this.doc.hidden) return;
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener();
  };

  private handleGeometryEvent = (event: Event): void => {
    if (event.target instanceof Node && this.affectsGeometry(event.target)) this.update();
  };

  private handleVisibility = (): void => {
    this.mutations.disconnect();
    this.sizes.disconnect();
    this.overlays.clear();
    this.start();
    this.update();
  };

  private dispose(): void {
    this.mutations.disconnect();
    this.sizes.disconnect();
    this.overlays.clear();
    this.doc.removeEventListener('visibilitychange', this.handleVisibility);
    this.doc.removeEventListener('scroll', this.handleGeometryEvent, true);
    this.doc.removeEventListener('transitionend', this.handleGeometryEvent, true);
    this.doc.removeEventListener('animationend', this.handleGeometryEvent, true);
    this.doc.defaultView?.removeEventListener('resize', this.update);
    this.onDispose();
  }
}

const observers = new WeakMap<Document, OcclusionObserver>();

/** One observer per document, owned only by visible browser surfaces. */
export function observeNativeWebviewOcclusion(viewport: HTMLElement, update: Listener): Listener {
  const doc = viewport.ownerDocument;
  let observer = observers.get(doc);
  if (!observer) {
    observer = new OcclusionObserver(doc, () => observers.delete(doc));
    observers.set(doc, observer);
  }
  return observer.subscribe(viewport, update);
}
