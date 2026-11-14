const ATTRIBUTE = "data-openbitfun-focus-visible";
const documents = new WeakMap<Document, { count: number; dispose: () => void }>();

/** Share the browser's focus-visible state without a :has() on every DOM node. */
export function retainScrollbarFocus(ownerDocument: Document): () => void {
  let state = documents.get(ownerDocument);
  if (!state) {
    const root = ownerDocument.documentElement;
    const view = ownerDocument.defaultView;
    const previous = root.getAttribute(ATTRIBUTE);
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      let active = ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const value = String(!!active?.matches(":focus-visible"));
      if (root.getAttribute(ATTRIBUTE) !== value) root.setAttribute(ATTRIBUTE, value);
    };
    const schedule = () => {
      if (frame === undefined && view) frame = view.requestAnimationFrame(update);
    };
    // Focus can change without input; keyboard/pointer modality can change
    // without moving focus. Read after the browser updates its pseudo-state.
    const events = ["focusin", "focusout", "keydown", "keyup", "pointerdown", "pointerup"];
    for (const event of events) ownerDocument.addEventListener(event, schedule, true);
    view?.addEventListener("focus", schedule);
    view?.addEventListener("blur", schedule);
    update();
    state = { count: 0, dispose: () => {
      if (frame !== undefined) view?.cancelAnimationFrame(frame);
      for (const event of events) ownerDocument.removeEventListener(event, schedule, true);
      view?.removeEventListener("focus", schedule);
      view?.removeEventListener("blur", schedule);
      if (previous === null) root.removeAttribute(ATTRIBUTE);
      else root.setAttribute(ATTRIBUTE, previous);
    } };
    documents.set(ownerDocument, state);
  }
  state.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.count === 0) {
      state.dispose();
      documents.delete(ownerDocument);
    }
  };
}
