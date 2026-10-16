// AppKit encodes navigation/function keys as U+F700–U+F747. They are key
// identifiers, not text. Keep the rest of the private-use area (e.g. Apple's
// logo), Unicode joiners, direction marks, variation selectors and whitespace.
// eslint-disable-next-line no-control-regex -- Deliberate keyboard control ranges.
const KEYBOARD_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uF700-\uF747]/g;

export function stripKeyboardControlCharacters(text: string): string {
  return text.replace(KEYBOARD_CONTROL_CHARACTERS, '');
}

type TextField = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number']);

function editableTarget(event: Event): HTMLElement | null {
  const target = event.composedPath()[0] as HTMLElement | undefined;
  if (!target || target.nodeType !== 1) return null;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const field = target as TextField;
    if (field.disabled || field.readOnly) return null;
    if (field.tagName === 'INPUT' && !TEXT_INPUT_TYPES.has(field.type)) return null;
    return field;
  }
  const editable = target.closest<HTMLElement>('[contenteditable]');
  return editable && editable.getAttribute('contenteditable') !== 'false' ? editable : null;
}

function repairTextField(field: TextField): boolean {
  const original = field.value;
  const cleaned = stripKeyboardControlCharacters(original);
  if (cleaned === original) return false;
  const { selectionStart, selectionEnd, selectionDirection } = field;
  const view = field.ownerDocument.defaultView!;
  const prototype = field.tagName === 'INPUT' ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
  // Bypass React's per-element value tracker so the original input event still
  // delivers the cleaned value to controlled onChange/onValueChange handlers.
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, cleaned);
  if (selectionStart !== null && selectionEnd !== null) {
    field.setSelectionRange(
      stripKeyboardControlCharacters(original.slice(0, selectionStart)).length,
      stripKeyboardControlCharacters(original.slice(0, selectionEnd)).length,
      selectionDirection ?? undefined,
    );
  }
  return true;
}

function repairEditable(target: HTMLElement): boolean {
  // These editors own a separate model/terminal protocol. Never rewrite their
  // hidden input buffers or DOM behind their backs; cancellable insertions are
  // still guarded below, while keydown and terminal escape sequences stay theirs.
  if (target.closest('.monaco-editor, .xterm, .ProseMirror')) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    return repairTextField(target as TextField);
  }
  const walker = target.ownerDocument.createTreeWalker(target, 4 /* SHOW_TEXT */);
  let changed = false;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.parentElement?.closest('[contenteditable="false"]')) continue;
    const matches = Array.from(node.data.matchAll(KEYBOARD_CONTROL_CHARACTERS));
    // Editing Text in place keeps both selection endpoints and inline capsules
    // intact. Replacing textContent would reset the caret to the node's start.
    for (const match of matches.reverse()) {
      node.deleteData(match.index!, match[0].length);
      changed = true;
    }
  }
  return changed;
}

/** Install once at each web surface's entry, before mounting React/portals. */
export function installTextInputGuard(owner: Document): () => void {
  const composing = new WeakSet<HTMLElement>();
  const beforeInput = (event: Event) => {
    const target = editableTarget(event);
    const input = event as InputEvent;
    if (!target || input.isComposing || composing.has(target)) return;
    if (event.type !== 'textInput' && !input.inputType?.startsWith('insert')) return;
    // Cancel pure key payloads before they can replace a selection or enter undo
    // history. Mixed paste/replacement text is repaired on input without losing
    // its valid text. Use native beforeinput; React 18 synthesizes a different event.
    if (input.data && stripKeyboardControlCharacters(input.data) === '') {
      event.preventDefault();
    }
  };
  const onInput = (event: Event) => {
    const target = editableTarget(event);
    if (target && !(event as InputEvent).isComposing && !composing.has(target)) {
      repairEditable(target);
    }
  };
  const compositionStart = (event: Event) => {
    const target = editableTarget(event);
    if (target) composing.add(target);
  };
  const compositionEnd = (event: Event) => {
    const target = editableTarget(event);
    if (!target) return;
    composing.delete(target);
    if (repairEditable(target)) {
      // Some engines send the final input before compositionend. Notify owners
      // after their compositionend handlers have finished even on that ordering.
      queueMicrotask(() => {
        if (target.isConnected) {
          target.dispatchEvent(new owner.defaultView!.InputEvent('input', {
            bubbles: true, composed: true, inputType: 'insertText', data: null,
          }));
        }
      });
    }
  };
  const listeners = {
    beforeinput: beforeInput, textInput: beforeInput, input: onInput,
    compositionstart: compositionStart, compositionend: compositionEnd,
  };
  for (const [type, handler] of Object.entries(listeners)) owner.addEventListener(type, handler, true);
  return () => {
    for (const [type, handler] of Object.entries(listeners)) owner.removeEventListener(type, handler, true);
  };
}
