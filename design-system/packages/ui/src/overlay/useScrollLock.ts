import { useEffect } from "react";

const SCROLL_LOCK = Symbol.for("openbitfun.overlay-scroll-lock.v1");
interface ScrollLockState { count: number; previousOverflow: string }

export function useScrollLock(active: boolean, ownerDocument?: Document | null): void {
  useEffect(() => {
    if (!active) return;
    const documentOwner = ownerDocument
      ?? (typeof document === "undefined" ? null : document);
    if (!documentOwner) return;

    // Separate public entry bundles must not restore overflow while another
    // bundle still owns a modal in this same document.
    const sharedDocument = documentOwner as Document & { [SCROLL_LOCK]?: ScrollLockState };
    if (!sharedDocument[SCROLL_LOCK]) {
      Object.defineProperty(sharedDocument, SCROLL_LOCK, { value: { count: 0, previousOverflow: "" } });
    }
    const state = sharedDocument[SCROLL_LOCK]!;
    if (state.count === 0) {
      state.previousOverflow = documentOwner.body.style.overflow;
      documentOwner.body.style.overflow = "hidden";
    }
    state.count += 1;

    return () => {
      state.count = Math.max(0, state.count - 1);
      if (state.count === 0) documentOwner.body.style.overflow = state.previousOverflow;
    };
  }, [active, ownerDocument]);
}
