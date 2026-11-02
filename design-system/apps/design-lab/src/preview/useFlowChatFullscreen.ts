import { useEffect, useRef, useState } from 'react';
import { useDismissibleLayer } from '@openbitfun/ui';

/** Expand the existing tree so drafts, disclosure and portal ownership survive. */
export function useFlowChatFullscreen() {
  const pageRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const nativeOwner = useRef<HTMLElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  function releaseNativeFullscreen() {
    const owner = nativeOwner.current;
    nativeOwner.current = null;
    if (owner && owner.ownerDocument.fullscreenElement === owner) {
      void owner.ownerDocument.exitFullscreen().catch(() => {});
    }
  }

  function exitFullscreen() {
    active.current = false;
    setFullscreen(false);
    releaseNativeFullscreen();
    buttonRef.current?.focus({ preventScroll: true });
  }

  async function enterFullscreen() {
    active.current = true;
    setFullscreen(true);
    const ownerDocument = pageRef.current?.ownerDocument;
    if (!ownerDocument) return;
    const target = ownerDocument.documentElement;
    if (!target.requestFullscreen || ownerDocument.fullscreenElement) return;

    try {
      // Fullscreen the document, including the design system's portal surfaces.
      // Embedded hosts that deny this API still get the same full-window layout.
      await target.requestFullscreen();
      if (ownerDocument.fullscreenElement !== target) return;
      if (active.current) nativeOwner.current = target;
      else await ownerDocument.exitFullscreen();
    } catch {
      // The in-page layout remains available without native fullscreen support.
    }
  }

  useDismissibleLayer({
    enabled: fullscreen,
    layerRef: pageRef,
    dismissOnPointerOutside: false,
    onDismiss: exitFullscreen,
  });

  useEffect(() => {
    const ownerDocument = pageRef.current?.ownerDocument;
    if (!ownerDocument) return;
    const onFullscreenChange = () => {
      if (nativeOwner.current && ownerDocument.fullscreenElement !== nativeOwner.current) {
        exitFullscreen();
      }
    };
    ownerDocument.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      active.current = false;
      ownerDocument.removeEventListener('fullscreenchange', onFullscreenChange);
      releaseNativeFullscreen();
    };
  }, []);

  return { pageRef, buttonRef, fullscreen, toggleFullscreen: fullscreen ? exitFullscreen : enterFullscreen };
}
