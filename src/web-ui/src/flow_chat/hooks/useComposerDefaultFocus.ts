import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isTextInput(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return !element.disabled;
  }

  if (element instanceof HTMLInputElement) {
    return !element.disabled
      && !element.readOnly
      && !NON_TEXT_INPUT_TYPES.has((element.type || 'text').toLowerCase());
  }

  return element.isContentEditable;
}

function isRendered(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) {
    return false;
  }

  return element.getClientRects().length > 0;
}

function hasVisibleTextInputFocus(): boolean {
  return isTextInput(document.activeElement) && isRendered(document.activeElement);
}

function hasBlockingModal(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

function hasTranscriptSelection(): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode?.isConnected) return false;
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest('[data-flowchat-selection-root]'));
}

function isTextEntryKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey) {
    return false;
  }

  const usesAltGraph = event.getModifierState?.('AltGraph') ?? false;
  if ((event.ctrlKey || event.altKey) && !usesAltGraph) {
    return false;
  }

  return event.key.length === 1
    || event.key === 'Dead'
    || event.key === 'Process'
    || event.keyCode === 229;
}

interface UseComposerDefaultFocusOptions {
  editorRef: RefObject<HTMLElement | null>;
  sessionId: string | null;
  isSceneActive: boolean;
}

export function useComposerDefaultFocus({
  editorRef,
  sessionId,
  isSceneActive,
}: UseComposerDefaultFocusOptions): void {
  const sessionIdRef = useRef(sessionId);
  const sceneActiveRef = useRef(isSceneActive);
  const pendingFrameRef = useRef<number | null>(null);
  sessionIdRef.current = sessionId;
  sceneActiveRef.current = isSceneActive;

  const focusComposerIfUnowned = useCallback(() => {
    if (!sceneActiveRef.current || !sessionIdRef.current) {
      return;
    }

    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current);
    }

    pendingFrameRef.current = window.requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      const editor = editorRef.current;

      if (
        !editor
        || !sceneActiveRef.current
        || !sessionIdRef.current
        || document.activeElement === editor
        || hasVisibleTextInputFocus()
        || hasBlockingModal()
        || hasTranscriptSelection()
      ) {
        return;
      }

      editor.focus({ preventScroll: true });
    });
  }, [editorRef]);

  useLayoutEffect(() => {
    focusComposerIfUnowned();
  }, [focusComposerIfUnowned, isSceneActive, sessionId]);

  useEffect(() => {
    window.addEventListener('focus', focusComposerIfUnowned);
    return () => {
      window.removeEventListener('focus', focusComposerIfUnowned);
      if (pendingFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
    };
  }, [focusComposerIfUnowned]);

  useEffect(() => {
    const focusComposerForTextEntry = (event: KeyboardEvent) => {
      if (
        !sceneActiveRef.current
        || !sessionIdRef.current
        || !isTextEntryKey(event)
        || hasBlockingModal()
      ) {
        return;
      }

      const editor = editorRef.current;
      if (
        !editor
        || !editor.isConnected
        || editor.getAttribute('contenteditable') === 'false'
        || editor.getAttribute('aria-disabled') === 'true'
        || document.activeElement === editor
        || hasVisibleTextInputFocus()
      ) {
        return;
      }

      // Focus synchronously and leave the event untouched. The browser can then
      // apply this same keystroke (including IME/dead-key input) to the composer.
      editor.focus({ preventScroll: true });
    };

    document.addEventListener('keydown', focusComposerForTextEntry, true);
    return () => {
      document.removeEventListener('keydown', focusComposerForTextEntry, true);
    };
  }, [editorRef]);
}
