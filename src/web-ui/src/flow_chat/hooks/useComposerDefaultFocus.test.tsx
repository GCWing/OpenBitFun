// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerDefaultFocus } from './useComposerDefaultFocus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ProbeProps {
  sessionId: string | null;
  isSceneActive: boolean;
}

function Probe({ sessionId, isSceneActive }: ProbeProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  useComposerDefaultFocus({ editorRef, sessionId, isSceneActive });

  return <div ref={editorRef} contentEditable tabIndex={0} data-testid="composer" />;
}

function markRendered(element: HTMLElement): void {
  vi.spyOn(element, 'getClientRects').mockReturnValue([
    { width: 100, height: 20 } as DOMRect,
  ] as unknown as DOMRectList);
}

describe('useComposerDefaultFocus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderProbe(props: ProbeProps): HTMLDivElement {
    act(() => root.render(<Probe {...props} />));
    return container.querySelector('[data-testid="composer"]') as HTMLDivElement;
  }

  function pressKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => document.body.dispatchEvent(event));
    return event;
  }

  it('focuses the composer when the active session has no input owner', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });

    expect(document.activeElement).toBe(composer);
  });

  it('does not focus an inactive scene', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: false });

    expect(document.activeElement).not.toBe(composer);
  });

  it('preserves a visible text input selected by the user', () => {
    const alternateInput = document.createElement('textarea');
    document.body.appendChild(alternateInput);
    markRendered(alternateInput);
    alternateInput.focus();

    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    act(() => window.dispatchEvent(new FocusEvent('focus')));

    expect(document.activeElement).toBe(alternateInput);
    expect(document.activeElement).not.toBe(composer);
  });

  it('focuses the composer when the previous input owner is no longer rendered', () => {
    const hiddenInput = document.createElement('textarea');
    hiddenInput.hidden = true;
    document.body.appendChild(hiddenInput);
    hiddenInput.focus();

    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });

    expect(document.activeElement).toBe(composer);
  });

  it('focuses the composer on window activation when only a button was focused', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    act(() => window.dispatchEvent(new FocusEvent('focus')));

    expect(document.activeElement).toBe(composer);
  });

  it('preserves transcript selection on window restore, but still accepts explicit typing', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    composer.blur();
    const transcript = document.createElement('div');
    transcript.setAttribute('data-flowchat-selection-root', 'session-a');
    transcript.textContent = 'Recorded response selected by the reader';
    document.body.append(transcript);
    const range = document.createRange(); range.selectNodeContents(transcript);
    document.getSelection()!.addRange(range);
    const focus = vi.spyOn(composer, 'focus');
    act(() => window.dispatchEvent(new FocusEvent('focus')));
    expect(focus).not.toHaveBeenCalled();
    expect(document.getSelection()?.toString()).toBe(transcript.textContent);
    pressKey('a');
    expect(document.activeElement).toBe(composer);
  });

  it('does not refocus the composer when it already owns focus', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    const focusSpy = vi.spyOn(composer, 'focus');

    act(() => {
      window.dispatchEvent(new FocusEvent('focus'));
      window.dispatchEvent(new FocusEvent('focus'));
    });

    expect(document.activeElement).toBe(composer);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('does not move focus behind a modal dialog', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();

    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    pressKey('a');

    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(composer);
  });

  it('moves focus to the composer for a printable character without consuming it', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    const event = pressKey('a');

    expect(document.activeElement).toBe(composer);
    expect(event.defaultPrevented).toBe(false);
  });

  it('moves focus to the composer for Space without consuming it', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    const event = pressKey(' ');

    expect(document.activeElement).toBe(composer);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(['Dead', 'Process'])('focuses the composer for %s text entry', key => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    pressKey(key);

    expect(document.activeElement).toBe(composer);
  });

  it('does not steal keyboard shortcuts or navigation keys', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    const button = document.createElement('button');
    document.body.appendChild(button);

    for (const [key, init] of [
      ['k', { ctrlKey: true }],
      ['k', { metaKey: true }],
      ['k', { altKey: true }],
      ['Enter', {}],
      ['ArrowDown', {}],
    ] satisfies Array<[string, KeyboardEventInit]>) {
      button.focus();
      pressKey(key, init);
      expect(document.activeElement).toBe(button);
      expect(document.activeElement).not.toBe(composer);
    }
  });

  it('preserves another visible text input while typing', () => {
    const alternateInput = document.createElement('textarea');
    document.body.appendChild(alternateInput);
    markRendered(alternateInput);
    alternateInput.focus();

    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: true });
    pressKey('a');

    expect(document.activeElement).toBe(alternateInput);
    expect(document.activeElement).not.toBe(composer);
  });

  it('does not focus an inactive scene while typing', () => {
    const composer = renderProbe({ sessionId: 'session-a', isSceneActive: false });

    pressKey('a');

    expect(document.activeElement).not.toBe(composer);
  });
});
