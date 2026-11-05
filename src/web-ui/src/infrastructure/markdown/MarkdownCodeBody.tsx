import { useEffect, useRef, useState, type ReactNode } from 'react';

// One intersection observer for a document, not one per fence. Source text
// stays in normal flow; only syntax decoration is collected outside the view.
const visibilityReaders = new Map<Element, (visible: boolean) => void>();
let visibilityObserver: IntersectionObserver | undefined;

function observeCode(element: Element, notify: (visible: boolean) => void) {
  if (typeof IntersectionObserver === 'undefined') { notify(true); return () => {}; }
  visibilityObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) visibilityReaders.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: '600px 0px' });
  visibilityReaders.set(element, notify);
  visibilityObserver.observe(element);
  return () => {
    visibilityReaders.delete(element);
    visibilityObserver?.unobserve(element);
    if (!visibilityReaders.size) { visibilityObserver?.disconnect(); visibilityObserver = undefined; }
  };
}

/** Paint one hovered line without adding a DOM node for every source line. */
export function MarkdownCodeBody({ children, deferHighlighting = false }: {
  children: ReactNode | ((visible: boolean) => ReactNode);
  deferHighlighting?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!deferHighlighting);

  useEffect(() => {
    if (!deferHighlighting || !bodyRef.current) { setVisible(true); return; }
    const body = bodyRef.current;
    const document = body.ownerDocument;
    let inView = false;
    const update = () => {
      // Replacing selected token nodes would destroy the native selection.
      const selection = document.getSelection();
      const selected = selection && !selection.isCollapsed && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        .some(range => range.intersectsNode(body));
      if (!selected) setVisible(inView);
    };
    const stop = observeCode(body, next => { inView = next; update(); });
    document.addEventListener('selectionchange', update);
    return () => { stop(); document.removeEventListener('selectionchange', update); };
  }, [deferHighlighting]);

  useEffect(() => {
    const body = bodyRef.current;
    const view = body?.ownerDocument.defaultView;
    if (!body || !view) return;

    let pointer: { x: number; y: number } | null = null;
    let frame: number | null = null;

    const paint = () => {
      frame = null;
      if (!pointer) return;
      const code = body.querySelector<HTMLElement>('pre > code');
      if (!code) return;

      const bodyRect = body.getBoundingClientRect();
      const codeRect = code.getBoundingClientRect();
      const lineHeight = Number.parseFloat(view.getComputedStyle(code).lineHeight);
      const offsetY = pointer.y - codeRect.top;
      if (!Number.isFinite(lineHeight) || lineHeight <= 0
        || pointer.x < bodyRect.left || pointer.x >= bodyRect.right
        || pointer.y < bodyRect.top || pointer.y >= bodyRect.bottom
        || offsetY < 0 || offsetY >= codeRect.height) {
        body.removeAttribute('data-code-line-hover');
        return;
      }

      const top = codeRect.top - bodyRect.top + body.scrollTop
        + Math.floor(offsetY / lineHeight) * lineHeight;
      body.style.setProperty('--markdown-code-hover-top', `${top}px`);
      body.style.setProperty('--markdown-code-hover-height', `${lineHeight}px`);
      body.setAttribute('data-code-line-hover', '');
    };

    const schedulePaint = () => {
      if (frame === null) frame = view.requestAnimationFrame(paint);
    };

    const clear = () => {
      pointer = null;
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      body.removeAttribute('data-code-line-hover');
      body.style.removeProperty('--markdown-code-hover-top');
      body.style.removeProperty('--markdown-code-hover-height');
      view.removeEventListener('scroll', schedulePaint, true);
      view.removeEventListener('resize', schedulePaint);
      view.removeEventListener('blur', clear);
    };

    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        clear();
        return;
      }
      if (!pointer) {
        // Recalculate when the conversation scrolls under a stationary pointer.
        view.addEventListener('scroll', schedulePaint, { capture: true, passive: true });
        view.addEventListener('resize', schedulePaint);
        view.addEventListener('blur', clear);
      }
      pointer = { x: event.clientX, y: event.clientY };
      schedulePaint();
    };

    body.addEventListener('pointermove', move);
    body.addEventListener('pointerleave', clear);
    body.addEventListener('pointercancel', clear);
    return () => {
      clear();
      body.removeEventListener('pointermove', move);
      body.removeEventListener('pointerleave', clear);
      body.removeEventListener('pointercancel', clear);
    };
  }, []);

  return (
    <div ref={bodyRef} className="code-block-body" data-openbitfun-component="markdown" data-openbitfun-part="codeBody">
      {typeof children === 'function' ? children(visible) : children}
    </div>
  );
}
