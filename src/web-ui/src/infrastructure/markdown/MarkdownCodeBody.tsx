import { useEffect, useRef, type ReactNode } from 'react';

/** Paint one hovered line without adding a DOM node for every source line. */
export function MarkdownCodeBody({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);

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
      {children}
    </div>
  );
}
