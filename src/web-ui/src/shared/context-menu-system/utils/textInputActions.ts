/**
 * Menu-side helpers for text fields: they restore the editing state captured
 * when the context menu opened and produce platform-correct shortcut hints.
 */
import type { TextInputContext } from '../types/context.types';
import { isContentEditableHost, isEditableInput } from '@/shared/utils/nativeTextEditing';

function usesMetaKeyPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(platform);
}

/** Shortcut hint for primary-modifier edit actions (`⌘C` on macOS, `Ctrl+C` elsewhere). */
export function textEditShortcut(key: 'A' | 'C' | 'V' | 'X'): string {
  return usesMetaKeyPlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

function restoreContentEditableSelection(element: HTMLElement, range: Range | undefined): void {
  if (!range) {
    return;
  }

  try {
    if (!element.contains(range.commonAncestorContainer)) {
      return;
    }

    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // A re-render between menu open and click can invalidate the saved range.
  }
}

/**
 * Focus the editable host and restore the selection it owned when the menu
 * opened, because opening the menu moves focus away from the field.
 */
export function focusTextInputTarget(context: TextInputContext): HTMLElement | null {
  const { element } = context;
  if (!element?.isConnected) {
    return null;
  }

  element.focus();

  if (isEditableInput(element)) {
    const { selectionStart, selectionEnd } = context;
    if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
      try {
        element.setSelectionRange(selectionStart, selectionEnd);
      } catch {
        // `input[type=email|number]` does not expose the selection API.
      }
    }

    return element;
  }

  restoreContentEditableSelection(element, context.savedSelectionRange);
  return element;
}

/**
 * Deliver pasted text as a native `paste` event so rich editors keep their own
 * paste semantics (inline token capsules, large-paste handling). Returns false
 * when the host did not consume the event, so the caller can insert plainly.
 */
export function dispatchPasteIntoTextInput(element: HTMLElement, text: string): boolean {
  if (!isContentEditableHost(element) || !text) {
    return false;
  }

  if (typeof ClipboardEvent !== 'function' || typeof DataTransfer !== 'function') {
    return false;
  }

  try {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true,
    });

    if (!event.clipboardData) {
      return false;
    }

    return !element.dispatchEvent(event);
  } catch {
    return false;
  }
}
