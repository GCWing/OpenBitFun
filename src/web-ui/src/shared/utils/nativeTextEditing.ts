/**
 * Native text-editing primitives for `<input>`, `<textarea>` and
 * `contenteditable` hosts that product surfaces drive from outside the owning
 * React tree: context menus, the macOS edit-menu bridge and shortcuts.
 *
 * Every helper tolerates hosts without a selection API
 * (`input[type=email|number]`) and WebViews that deny clipboard reads.
 */
import { readNativeClipboardText } from '@/shared/utils/nativeClipboard';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('NativeTextEditing');

export type NativeEditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
export type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

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

const CONTENT_EDITABLE_HOST_VALUES = new Set(['', 'true', 'plaintext-only']);

export function isMacOSDesktop(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return '__TAURI__' in window
    && typeof navigator.platform === 'string'
    && navigator.platform.toUpperCase().includes('MAC');
}

function runExecCommand(command: string, value?: string): boolean {
  if (typeof document.execCommand !== 'function') {
    return false;
  }

  try {
    return value === undefined
      ? document.execCommand(command)
      : document.execCommand(command, false, value);
  } catch {
    return false;
  }
}

export function isEditableInput(element: Element | null): element is TextInputElement {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return false;
  }

  if (element instanceof HTMLTextAreaElement) {
    return true;
  }

  return !NON_TEXT_INPUT_TYPES.has((element.type || 'text').toLowerCase());
}

export function isContentEditableHost(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || isEditableInput(element)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  const editableAttribute = element.getAttribute('contenteditable');
  return editableAttribute !== null && CONTENT_EDITABLE_HOST_VALUES.has(editableAttribute.toLowerCase());
}

export function isWritableTextInput(element: Element | null): boolean {
  if (isEditableInput(element)) {
    return !element.readOnly && !element.disabled;
  }

  return isContentEditableHost(element);
}

export function isTextInputReadOnly(element: HTMLElement): boolean {
  if (isEditableInput(element)) {
    return element.readOnly || element.disabled;
  }

  return !isContentEditableHost(element);
}

/**
 * Resolve the editable host for a right-clicked node. Inline non-editable
 * islands (`contenteditable="false"` capsules) and nested event targets inside a
 * composer must resolve to the owning editing host.
 */
export function findTextInputHost(target: Element | null): HTMLElement | null {
  let current: HTMLElement | null = target instanceof HTMLElement ? target : null;
  const boundary = current?.ownerDocument.body ?? null;

  while (current && current !== boundary) {
    if (isEditableInput(current)) {
      return current;
    }

    const editableAttribute = current.getAttribute('contenteditable');
    if (editableAttribute !== null && CONTENT_EDITABLE_HOST_VALUES.has(editableAttribute.toLowerCase())) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function selectionInsideElement(element: Element, selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const anchorInside = selection.anchorNode ? element.contains(selection.anchorNode) : false;
  const focusInside = selection.focusNode ? element.contains(selection.focusNode) : false;
  return anchorInside && focusInside;
}

export function hasNativeTextSelection(element: Element | null): boolean {
  if (isEditableInput(element)) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    return start !== null && end !== null && end > start;
  }

  if (!isContentEditableHost(element)) {
    return false;
  }

  const selection = element.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && selectionInsideElement(element, selection);
}

/**
 * Selected text owned by the given host. A document selection that lives outside
 * the host is never reported, so a stale selection cannot leak into its menu.
 */
export function readTextInputSelection(element: Element | null): string {
  if (isEditableInput(element)) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start === null || end === null || end <= start) {
      return '';
    }

    return element.value.slice(start, end);
  }

  if (!isContentEditableHost(element)) {
    return '';
  }

  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selectionInsideElement(element, selection)) {
    return '';
  }

  return selection.toString();
}

/** Selected range of a `contenteditable` host, cloned so it survives menu focus. */
export function readTextInputSelectionRange(element: Element | null): Range | undefined {
  if (!isContentEditableHost(element) || !hasNativeTextSelection(element)) {
    return undefined;
  }

  const selection = element.ownerDocument.getSelection();
  if (!selection) {
    return undefined;
  }

  try {
    return selection.getRangeAt(0).cloneRange();
  } catch {
    return undefined;
  }
}

/**
 * Clipboard text for a paste command. The desktop host reads the system
 * clipboard natively, because the WebView read raises a WebView2 permission
 * prompt on the app origin; other surfaces keep the Web API path.
 */
export async function readClipboardText(): Promise<string | null> {
  const nativeText = await readNativeClipboardText();
  if (nativeText !== null) {
    return nativeText;
  }

  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (error) {
    log.warn('Failed to read clipboard via navigator.clipboard', { error });
  }

  return null;
}

export function insertTextIntoElement(element: Element | null, text: string): boolean {
  if (!text) {
    return false;
  }

  if (isEditableInput(element)) {
    if (element.readOnly || element.disabled) {
      return false;
    }

    element.focus();
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;

    element.setRangeText(text, start, end, 'end');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (!isContentEditableHost(element)) {
    return false;
  }

  element.focus();

  const selection = element.ownerDocument.getSelection();
  if (!selection) {
    return false;
  }

  if (runExecCommand('insertText', text)) {
    return true;
  }

  if (selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = element.ownerDocument.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Remove the current selection, used by cut when the host cannot run `cut`. */
export function clearTextInputSelection(element: Element | null): boolean {
  if (isEditableInput(element)) {
    if (element.readOnly || element.disabled) {
      return false;
    }

    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start === null || end === null || end <= start) {
      return false;
    }

    element.setRangeText('', start, end, 'end');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  if (!isContentEditableHost(element) || !hasNativeTextSelection(element)) {
    return false;
  }

  if (runExecCommand('delete')) {
    return true;
  }

  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Run a native edit action on the host. Editing hosts keep their own undo stack
 * and fire their own `input`/`copy` events, which rich editors depend on.
 */
export function executeNativeEditAction(element: Element | null, action: NativeEditAction): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (action === 'selectAll') {
    element.focus();

    if (isEditableInput(element)) {
      element.select();
      return true;
    }

    if (!isContentEditableHost(element)) {
      return false;
    }

    if (runExecCommand('selectAll')) {
      return true;
    }

    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection();
    if (!selection) {
      return false;
    }

    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  if (!isWritableTextInput(element)) {
    return false;
  }

  element.focus();

  const commandMap: Record<Exclude<NativeEditAction, 'selectAll'>, string> = {
    undo: 'undo',
    redo: 'redo',
    cut: 'cut',
    copy: 'copy',
    paste: 'paste',
  };

  return runExecCommand(commandMap[action]);
}
