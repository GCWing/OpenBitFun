// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input, Textarea } from '@openbitfun/ui';
import { installTextInputGuard, stripKeyboardControlCharacters } from '../../../../shared/text-input/textInputGuard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function inputEvent(target: HTMLElement, type: string, data: string | null, options: InputEventInit = {}) {
  const event = new InputEvent(type, {
    bubbles: true, cancelable: true, inputType: 'insertText', data, ...options,
  });
  target.dispatchEvent(event);
  return event;
}

describe('document text input guard', () => {
  let removeGuard: () => void;
  let root: Root | undefined;

  beforeEach(() => { removeGuard = installTextInputGuard(document); });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    removeGuard();
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  function field(tag: 'input' | 'textarea' | 'div') {
    const element = document.createElement(tag);
    if (tag === 'div') element.setAttribute('contenteditable', 'true');
    document.body.append(element);
    return element;
  }

  it.each(['input', 'textarea', 'div'] as const)('blocks native function-key text in %s without consuming navigation', tag => {
    const target = field(tag);
    for (const data of ['\uF700', '\uF701', '\uF702', '\uF703', '\uF704', '\uF729', '\uF72B', '\uF747', '\u001B', '\u0008', '\u007F']) {
      expect(inputEvent(target, 'beforeinput', data).defaultPrevented).toBe(true);
      expect(inputEvent(target, 'textInput', data, { inputType: '' }).defaultPrevented).toBe(true);
    }
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Tab', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('preserves normal text, IME text, emoji, Unicode formatting and non-key private-use glyphs', () => {
    const text = '中文\t\n\r café e\u0301 👩‍💻 👨‍👩‍👧‍👦 می\u200Cروم \u200E\u200F\u2060\uFEFF\u2028\u2029\u00AD \uE000\uF8FF';
    const target = field('textarea');
    expect(stripKeyboardControlCharacters(text)).toBe(text);
    expect(inputEvent(target, 'beforeinput', text).defaultPrevented).toBe(false);
    expect(inputEvent(target, 'beforeinput', null, { inputType: 'deleteContentBackward' }).defaultPrevented).toBe(false);
    expect(inputEvent(target, 'beforeinput', '\n', { inputType: 'insertLineBreak' }).defaultPrevented).toBe(false);
  });

  it.each(['input', 'textarea'] as const)('repairs non-cancellable/mixed input before %s observers, preserving backward selection', tag => {
    const target = field(tag) as HTMLInputElement | HTMLTextAreaElement;
    target.value = 'a\uF700bc\u001Bd';
    target.setSelectionRange(2, 5, 'backward');
    const observed: string[] = [];
    target.addEventListener('input', () => observed.push(target.value));
    inputEvent(target, 'input', null, { cancelable: false, inputType: 'insertFromPaste' });
    expect(observed).toEqual(['abcd']);
    expect([target.selectionStart, target.selectionEnd, target.selectionDirection]).toEqual([1, 3, 'backward']);
  });

  it('keeps rich text nodes, capsules, and both selection endpoints when repairing a mixed paste', () => {
    const editor = field('div');
    editor.innerHTML = '<b>a\uF700bc</b><span contenteditable="false">capsule\uF700</span><i>d\uF703ef</i>';
    const first = editor.querySelector('b')!.firstChild!;
    const last = editor.querySelector('i')!.firstChild!;
    const capsule = editor.querySelector('span');
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(last, 3, first, 2);
    inputEvent(editor, 'input', 'a\uF700b', { inputType: 'insertFromPaste', cancelable: false });
    expect(first.textContent).toBe('abc');
    expect(last.textContent).toBe('def');
    expect(editor.querySelector('span')).toBe(capsule);
    expect(capsule!.textContent).toBe('capsule\uF700');
    expect(selection.anchorNode).toBe(last);
    expect(selection.anchorOffset).toBe(2);
    expect(selection.focusNode).toBe(first);
    expect(selection.focusOffset).toBe(1);
  });

  it('does not interrupt composition and repairs its final value even when final input precedes compositionend', async () => {
    const target = field('textarea') as HTMLTextAreaElement;
    target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(inputEvent(target, 'beforeinput', '\uF700', { isComposing: true }).defaultPrevented).toBe(false);
    target.value = '中文\uF700';
    inputEvent(target, 'input', '中文\uF700', { isComposing: true });
    inputEvent(target, 'input', '中文\uF700');
    expect(target.value).toBe('中文\uF700');
    const observed = vi.fn();
    target.addEventListener('input', () => observed(target.value));
    target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文\uF700' }));
    await Promise.resolve();
    expect(target.value).toBe('中文');
    expect(observed).toHaveBeenCalledWith('中文');
  });

  it.each(['.xterm', '.monaco-editor', '.ProseMirror'])('leaves %s model buffers and protocol data under their own control', selector => {
    const owner = document.createElement('div');
    owner.className = selector.slice(1);
    const target = document.createElement('textarea');
    owner.append(target);
    document.body.append(owner);
    target.value = '\u001B[A';
    inputEvent(target, 'input', '\u001B[A');
    expect(target.value).toBe('\u001B[A');
    expect(inputEvent(target, 'beforeinput', '\uF700').defaultPrevented).toBe(true);
  });

  it('supports dynamically mounted and portalled controlled design-system fields', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    function Harness() {
      const [text, setText] = useState('old');
      return <><Input value={text} onValueChange={setText} />{createPortal(<Textarea value={text} onValueChange={setText} />, document.body)}<output>{text}</output></>;
    }
    act(() => root!.render(<Harness />));
    const input = container.querySelector('input')!;
    const textarea = document.querySelector('textarea')!;
    for (const [target, prototype, value] of [[input, HTMLInputElement.prototype, 'first'], [textarea, HTMLTextAreaElement.prototype, 'second']] as const) {
      act(() => {
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, `${value}\uF700 text`);
        inputEvent(target, 'input', `${value}\uF700 text`);
      });
      expect(input.value).toBe(`${value} text`);
      expect(textarea.value).toBe(`${value} text`);
      expect(container.querySelector('output')!.textContent).toBe(`${value} text`);
    }
  });

  it('does not mutate readonly fields or non-editable content and removes its listeners', () => {
    const readonly = field('input') as HTMLInputElement;
    readonly.readOnly = true;
    readonly.value = '\uF700';
    inputEvent(readonly, 'input', '\uF700');
    expect(readonly.value).toBe('\uF700');
    const target = field('div');
    target.setAttribute('contenteditable', 'false');
    expect(inputEvent(target, 'beforeinput', '\uF700').defaultPrevented).toBe(false);
    target.setAttribute('contenteditable', 'true');
    removeGuard();
    expect(inputEvent(target, 'beforeinput', '\uF700').defaultPrevented).toBe(false);
  });
});
