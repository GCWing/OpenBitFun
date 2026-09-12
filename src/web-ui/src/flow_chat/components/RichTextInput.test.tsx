import React, { act, createRef, forwardRef, useImperativeHandle, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import RichTextInput, { type RichTextInputElement } from './RichTextInput';
import type { ContextItem } from '../../shared/types/context';
import { createMcpPromptReference } from '../utils/mcpPromptReference';
import { composerPresentationToEditorText, parseComposerPresentation } from '../utils/composerPresentation';

type HarnessHandle = {
  setValue: (value: string) => void;
};

const emptyContexts: ContextItem[] = [];

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const ControlledHarness = forwardRef<HarnessHandle>(function ControlledHarness(_, ref) {
  const [value, setValue] = useState('hello');

  useImperativeHandle(ref, () => ({
    setValue,
  }), []);

  return (
    <RichTextInput
      value={value}
      onChange={(nextValue) => setValue(nextValue)}
      contexts={emptyContexts}
      onRemoveContext={() => {}}
    />
  );
});

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

describeWithJsdom('RichTextInput external sync', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
    });

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('Text', window.Text);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
    vi.stubGlobal('HTMLSpanElement', window.HTMLSpanElement);
    vi.stubGlobal('DocumentFragment', window.DocumentFragment);
    vi.stubGlobal('Range', window.Range);
    vi.stubGlobal('Selection', window.Selection);
    vi.stubGlobal('NodeFilter', window.NodeFilter);
    vi.stubGlobal('Event', window.Event);
    vi.stubGlobal('CustomEvent', window.CustomEvent);
    vi.stubGlobal('InputEvent', window.InputEvent);
    vi.stubGlobal('getSelection', window.getSelection.bind(window));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(window.HTMLElement.prototype, {
      attachEvent: () => {},
      detachEvent: () => {},
    });

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
    (window.document as Document & { execCommand?: typeof document.execCommand }).execCommand = (
      command,
      _showUi,
      value,
    ) => {
      if (command !== 'insertText') {
        return false;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return false;
      }

      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(String(value ?? ''));
      range.insertNode(textNode);

      const nextRange = document.createRange();
      nextRange.setStart(textNode, textNode.textContent?.length ?? 0);
      nextRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(nextRange);
      return true;
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
  });

  async function renderHarness(ref: React.RefObject<HarnessHandle>) {
    await act(async () => {
      root.render(<ControlledHarness ref={ref} />);
    });

    const editor = container.querySelector('.rich-text-input');
    expect(editor).toBeInstanceOf(HTMLDivElement);
    return editor as HTMLDivElement;
  }

  function paste(
    editor: HTMLDivElement,
    options: { items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>; types?: string[]; text?: string },
  ) {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: options.items ?? [],
        types: options.types ?? [],
        getData: (type: string) => type === 'text/plain' ? options.text ?? '' : '',
      },
    });
    editor.dispatchEvent(event);
  }

  function setCaret(editor: HTMLDivElement, offset: number) {
    const selection = window.getSelection();
    const range = document.createRange();
    const textNode = (editor.firstChild as Text | null) ?? document.createTextNode('');

    if (!editor.firstChild) {
      editor.appendChild(textNode);
    }

    range.setStart(textNode, offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function updateEditorText(editor: HTMLDivElement, text: string, offset = text.length) {
    await act(async () => {
      editor.textContent = text;
      setCaret(editor, offset);
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }

  it('routes images and non-image files through one path-aware clipboard intake', async () => {
    const onPasteFiles = vi.fn();
    const imageFile = { name: 'image.png', type: 'image/png' } as File;
    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={() => {}}
          onPasteFiles={onPasteFiles}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />,
      );
    });
    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    const imagePaste = vi.fn();
    editor.addEventListener('imagePaste', imagePaste);

    paste(editor, {
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => imageFile },
        { kind: 'file', type: 'application/pdf', getAsFile: () => null },
      ],
      types: ['Files'],
    });

    expect(imagePaste).not.toHaveBeenCalled();
    expect(onPasteFiles).toHaveBeenCalledWith({
      fallbackImages: [imageFile],
      hasNonImageFiles: true,
    });
  });

  it('routes one or multiple non-image files without falling back to text', async () => {
    const onPasteFiles = vi.fn();
    const onLargePaste = vi.fn();
    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={() => {}}
          onPasteFiles={onPasteFiles}
          onLargePaste={onLargePaste}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />,
      );
    });
    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    paste(editor, {
      items: [
        { kind: 'file', type: 'application/pdf', getAsFile: () => null },
        { kind: 'file', type: 'text/csv', getAsFile: () => null },
      ],
      types: ['Files', 'text/plain'],
      text: 'file names must not be inserted',
    });

    expect(onPasteFiles).toHaveBeenCalledWith({
      fallbackImages: [],
      hasNonImageFiles: true,
    });
    expect(onLargePaste).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('');
  });

  it('keeps plain text and large text paste behavior', async () => {
    const onLargePaste = vi.fn((text: string) => text.length > 10 ? '[Pasted Content]' : null);
    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={() => {}}
          onLargePaste={onLargePaste}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />,
      );
    });
    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    setCaret(editor, 0);
    paste(editor, { types: ['text/plain'], text: 'short' });
    expect(editor.textContent).toContain('short');

    setCaret(editor, editor.firstChild?.textContent?.length ?? 0);
    paste(editor, { types: ['text/plain'], text: 'long text content' });
    expect(editor.querySelector('[data-large-paste-placeholder]')).toBeTruthy();
  });

  it('keeps the existing DOM node when parent echoes local input', async () => {
    const harnessRef = createRef<HarnessHandle>();
    const editor = await renderHarness(harnessRef);

    expect(editor.textContent).toBe('hello');
    const originalTextNode = editor.firstChild;
    expect(originalTextNode).toBeInstanceOf(Text);

    await act(async () => {
      (originalTextNode as Text).textContent = 'hello!';
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    expect(editor.textContent).toBe('hello!');
    expect(editor.firstChild).toBe(originalTextNode);
  });

  it('preserves trailing spaces emitted by user input', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input');
    expect(editor).toBeInstanceOf(HTMLDivElement);

    await updateEditorText(editor as HTMLDivElement, '/b ');

    expect(onChange).toHaveBeenLastCalledWith('/b ', emptyContexts);
  });

  it('replaces the DOM node when value changes externally', async () => {
    const harnessRef = createRef<HarnessHandle>();
    const editor = await renderHarness(harnessRef);

    const originalTextNode = editor.firstChild;
    expect(originalTextNode).toBeInstanceOf(Text);

    await act(async () => {
      harnessRef.current?.setValue('server rewrite');
    });

    expect(editor.textContent).toBe('server rewrite');
    expect(editor.firstChild).not.toBe(originalTextNode);
  });

  it('shows the declared skill name while keeping its exact source token', async () => {
    await act(async () => root.render(<RichTextInput
      value="[$project::codex::nested/folder]"
      skillReferenceNames={{ 'project::codex::nested/folder': 'Declared skill name' }}
      onChange={() => {}} contexts={emptyContexts} onRemoveContext={() => {}}
    />));
    const pill = container.querySelector<HTMLElement>('[data-inline-token-type="skill-ref"]');
    expect(pill?.dataset.tagFormat).toBe('[$project::codex::nested/folder]');
    expect(pill?.textContent).toContain('Declared skill name');
    expect(pill?.title).toBe('');
  });

  it('renders externally inserted skill tokens as inline pills' , async () => {
    const harnessRef = createRef<HarnessHandle>();
    const editor = await renderHarness(harnessRef);

    await act(async () => {
      harnessRef.current?.setValue('Use [$pdf] please');
    });

    const skillPill = editor.querySelector(
      '[data-inline-token-type="skill-ref"]',
    ) as HTMLElement | null;
    expect(skillPill).toBeTruthy();
    expect(skillPill?.getAttribute('data-tag-format')).toBe('[$pdf]');
    expect(skillPill?.querySelector('[data-openbitfun-component="icon"][data-openbitfun-name="extension"]')).toBeTruthy();
    expect(editor.textContent).toContain('pdf');
  });

  it('renders Review with the same capsule anatomy as a Plan skill reference', async () => {
    const harnessRef = createRef<HarnessHandle>();
    const editor = await renderHarness(harnessRef);

    await act(async () => {
      harnessRef.current?.setValue('[[openbitfun-additional-mode:review]]');
    });

    const reviewPill = editor.querySelector(
      '[data-inline-token-type="additional-mode-ref"]',
    ) as HTMLElement | null;
    expect(reviewPill).toBeTruthy();
    expect(reviewPill?.classList.contains('rich-text-tag-pill--skill-ref')).toBe(true);
    expect(reviewPill?.getAttribute('data-openbitfun-context-type')).toBe('additional-mode-reference');
    expect(reviewPill?.querySelector('[data-openbitfun-component="icon"][data-openbitfun-name="extension"]')).toBeTruthy();
    expect(reviewPill?.textContent).toContain('Review');
  });

  it('removes a context capsule with one Backspace from its trailing separator', async () => {
    const fileContext: ContextItem = {
      id: 'external-file-1',
      type: 'file',
      filePath: '/tmp/report.pdf',
      fileName: 'report.pdf',
      timestamp: 1,
    };
    const inputRef = createRef<RichTextInputElement>();
    const onRemoveContext = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          ref={inputRef}
          value=""
          onChange={() => {}}
          contexts={[fileContext]}
          onRemoveContext={onRemoveContext}
        />
      );
    });
    await act(async () => {
      inputRef.current?.insertTag?.(fileContext);
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    const tag = editor.querySelector('[data-context-id="external-file-1"]');
    const separator = tag?.nextSibling;
    expect(separator?.textContent).toBe(' ');
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(separator!, 1);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    await act(async () => {
      editor.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onRemoveContext).toHaveBeenCalledOnce();
    expect(onRemoveContext).toHaveBeenCalledWith(fileContext.id);
  });

  it('treats equivalent text and editor boundaries as one caret on Backspace', async () => {
    const fileContext: ContextItem = {
      id: 'external-file-equivalent-caret',
      type: 'file',
      filePath: '/tmp/equivalent-caret.pdf',
      fileName: 'equivalent-caret.pdf',
      timestamp: 1,
    };
    const inputRef = createRef<RichTextInputElement>();
    const onRemoveContext = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          ref={inputRef}
          value=""
          onChange={() => {}}
          contexts={[fileContext]}
          onRemoveContext={onRemoveContext}
        />
      );
    });
    await act(async () => {
      inputRef.current?.insertTag?.(fileContext);
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    const separator = editor.querySelector('[data-context-id="external-file-equivalent-caret"]')?.nextSibling;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(separator!, 1);
    range.setEnd(editor, editor.childNodes.length);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.getRangeAt(0).collapsed).toBe(false);

    await act(async () => {
      editor.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onRemoveContext).toHaveBeenCalledOnce();
    expect(onRemoveContext).toHaveBeenCalledWith(fileContext.id);
  });

  it('keeps the caret at a removed middle context capsule', async () => {
    const fileContexts: ContextItem[] = [1, 2, 3].map(index => ({
      id: `external-file-${index}`,
      type: 'file',
      filePath: `/tmp/report-${index}.pdf`,
      fileName: `report-${index}.pdf`,
      timestamp: index,
    }));
    const inputRef = createRef<RichTextInputElement>();
    const onRemoveContext = vi.fn();
    const renderContexts = async (contexts: ContextItem[]) => {
      await act(async () => {
        root.render(
          <RichTextInput
            ref={inputRef}
            value=""
            onChange={() => {}}
            contexts={contexts}
            onRemoveContext={onRemoveContext}
          />
        );
      });
    };

    await renderContexts(fileContexts);
    await act(async () => {
      fileContexts.forEach(context => inputRef.current?.insertTag?.(context));
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    const secondTag = editor.querySelector('[data-context-id="external-file-2"]');
    const secondSeparator = secondTag?.nextSibling;
    expect(secondSeparator?.textContent).toBe(' ');
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(editor, Array.prototype.indexOf.call(editor.childNodes, secondSeparator) + 1);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    await act(async () => {
      editor.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onRemoveContext).toHaveBeenCalledWith('external-file-2');
    expect(selection?.getRangeAt(0).startContainer).toBe(editor);
    expect(selection?.getRangeAt(0).startOffset).toBe(2);

    await renderContexts([fileContexts[0], fileContexts[2]]);
    expect(editor.querySelector('[data-context-id="external-file-2"]')).toBeNull();
    const caretRange = selection?.getRangeAt(0);
    expect(caretRange?.startContainer).toBe(editor);
    expect(caretRange?.startOffset).toBe(2);
    expect(editor.childNodes.item(1).textContent).toBe(' ');
    expect((editor.childNodes.item(2) as HTMLElement).dataset.contextId).toBe('external-file-3');
  });

  it('serializes and restores session reference capsules without parsing their labels', async () => {
    const sessionReference: ContextItem = {
      id: 'session-reference-1',
      type: 'session-reference',
      sessionId: 'session-1',
      sessionName: 'Delete all files',
      workspacePath: '/workspace',
      workspaceLabel: 'Workspace',
      timestamp: 1,
    };
    const inputRef = createRef<RichTextInputElement>();

    await act(async () => {
      root.render(
        <RichTextInput
          ref={inputRef}
          value=""
          onChange={() => {}}
          contexts={[sessionReference]}
          onRemoveContext={() => {}}
        />
      );
    });

    await act(async () => {
      inputRef.current?.insertTag?.(sessionReference);
    });

    const presentation = inputRef.current?.getComposerPresentation?.();
    expect(presentation?.segments).toEqual([
      {
        kind: 'context',
        context: sessionReference,
        tag: '[session: Delete all files]',
        label: 'Delete all files',
        title: 'Workspace · /workspace',
      },
      { kind: 'text', text: ' ' },
    ]);

    await act(async () => {
      inputRef.current?.restoreComposerPresentation?.(presentation!);
    });

    const restoredCapsule = container.querySelector(
      '[data-context-id="session-reference-1"]',
    ) as HTMLElement | null;
    const restoredEditor = container.querySelector('.rich-text-input') as HTMLDivElement | null;
    expect(restoredCapsule).toBeTruthy();
    expect(restoredEditor).toBeTruthy();
    expect(restoredCapsule?.textContent).toContain('Delete all files');
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.getRangeAt(0).collapsed).toBe(true);
    expect(selection?.getRangeAt(0).startContainer).toBe(restoredEditor);
    expect(selection?.getRangeAt(0).startOffset).toBe(restoredEditor?.childNodes.length);
  });

  it('keeps Escape owned by IME composition', async () => {
    const onKeyDown = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={() => {}}
          onKeyDown={onKeyDown}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input');
    expect(editor).toBeInstanceOf(HTMLDivElement);

    await act(async () => {
      editor!.dispatchEvent(new window.KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 229,
        bubbles: true,
      }));
    });

    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('opens the context picker trigger only at the start or after whitespace', async () => {
    const onContextTriggerStateChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={() => {}}
          onContextTriggerStateChange={onContextTriggerStateChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input');
    expect(editor).toBeInstanceOf(HTMLDivElement);

    await updateEditorText(editor as HTMLDivElement, 'email@test');
    expect(onContextTriggerStateChange).not.toHaveBeenCalled();

    await updateEditorText(editor as HTMLDivElement, 'ask @test');
    expect(onContextTriggerStateChange).toHaveBeenLastCalledWith({
      isActive: true,
      query: 'test',
      startOffset: 4,
    });

    await updateEditorText(editor as HTMLDivElement, '@root');
    expect(onContextTriggerStateChange).toHaveBeenLastCalledWith({
      isActive: true,
      query: 'root',
      startOffset: 0,
    });
  });

  it('reports inline skill triggers for $ and middle-of-text /', async () => {
    const onInlineTriggerStateChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={() => {}}
          onInlineTriggerStateChange={onInlineTriggerStateChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input');
    expect(editor).toBeInstanceOf(HTMLDivElement);

    await updateEditorText(editor as HTMLDivElement, '$pdf');
    expect(onInlineTriggerStateChange).toHaveBeenLastCalledWith({
      isActive: true,
      trigger: '$',
      query: 'pdf',
      startOffset: 0,
    });

    await updateEditorText(editor as HTMLDivElement, 'please /pdf');
    expect(onInlineTriggerStateChange).toHaveBeenLastCalledWith({
      isActive: true,
      trigger: '/',
      query: 'pdf',
      startOffset: 7,
    });
  });

  it('can replace an active context trigger with a skill token', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="@pdf"
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as RichTextInputElement | null;
    expect(editor).toBeTruthy();

    setCaret(editor!, '@pdf'.length);
    await act(async () => {
      editor!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    await act(async () => {
      editor?.replaceActiveContextTrigger?.('[$pdf]');
    });

    expect(onChange).toHaveBeenLastCalledWith('[$pdf]', emptyContexts);
    expect(editor?.querySelector('.rich-text-tag-pill--skill-ref')).toBeTruthy();
    expect(editor?.textContent).not.toContain('@pdf');
  });

  it('can remove an active context trigger before opening a non-text action', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="@"
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as RichTextInputElement | null;
    expect(editor).toBeTruthy();

    setCaret(editor!, 1);
    await act(async () => {
      editor!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    await act(async () => {
      editor?.replaceActiveContextTrigger?.('');
    });

    expect(onChange).toHaveBeenLastCalledWith('', emptyContexts);
    expect(editor?.textContent).toBe('');
  });

  it('replaces @ with an MCP service capsule while sending the exact reference', async () => {
    const onChange = vi.fn();
    const reference = createMcpPromptReference({ serverName: 'Docs', serverId: 'docs-private-id' });
    await act(async () => root.render(
      <RichTextInput value="Please use @docs" onChange={onChange} contexts={emptyContexts} onRemoveContext={() => {}} />,
    ));
    const editor = container.querySelector('.rich-text-input') as RichTextInputElement;
    setCaret(editor, 'Please use @docs'.length);
    await act(async () => editor.dispatchEvent(new window.Event('input', { bubbles: true })));
    await act(async () => editor.replaceActiveContextTrigger?.(reference));
    expect(onChange).toHaveBeenLastCalledWith(`Please use ${reference}`, emptyContexts);
    const capsule = editor.querySelector<HTMLElement>('[data-inline-token-type="mcp-ref"]');
    expect(capsule?.querySelector('[data-openbitfun-part="tagText"]')?.textContent).toBe('Docs');
    expect(capsule?.querySelector('[data-openbitfun-part="tagBadge"] svg')).not.toBeNull();
    expect(capsule?.getAttribute('contenteditable')).toBe('false');
    expect(capsule?.dataset.tagFormat).toBe(reference);
    expect(editor.textContent).not.toContain('server:');
    expect(editor.textContent).not.toContain('docs-private-id');
    expect(editor.textContent).not.toContain('@docs');
  });

  it('restores MCP capsules from legacy plain-text drafts and preserves the text presentation shape', async () => {
    const first = createMcpPromptReference({ serverName: 'Docs', serverId: 'one' });
    const second = createMcpPromptReference({ serverName: 'Docs', serverId: 'two' });
    const value = `Compare ${first} with ${second} please.`;
    const inputRef = createRef<RichTextInputElement>();
    await act(async () => root.render(<RichTextInput ref={inputRef} value={value} onChange={() => {}} contexts={emptyContexts} onRemoveContext={() => {}} />));
    const presentation = inputRef.current!.getComposerPresentation!()!;
    expect(presentation.segments).toEqual([{ kind: 'text', text: value }]);
    expect(parseComposerPresentation(presentation)).toEqual(presentation);
    expect(composerPresentationToEditorText(presentation)).toBe(value);
    await act(async () => {
      inputRef.current!.replaceChildren();
      inputRef.current!.restoreComposerPresentation!(presentation);
    });
    const pills = inputRef.current!.querySelectorAll<HTMLElement>('[data-inline-token-type="mcp-ref"]');
    expect(Array.from(pills, pill => pill.dataset.tagFormat)).toEqual([first, second]);
    expect(inputRef.current!.textContent).toBe('Compare Docs× with Docs× please.');
  });

  it.each(['remove-button', 'Backspace'])('removes an MCP capsule atomically with %s', async method => {
    const onChange = vi.fn();
    const reference = createMcpPromptReference({ serverName: 'Docs', serverId: 'docs' });
    await act(async () => root.render(<RichTextInput value={`before ${reference}`} onChange={onChange} contexts={emptyContexts} onRemoveContext={() => {}} />));
    const editor = container.querySelector('.rich-text-input') as RichTextInputElement;
    await act(async () => {
      if (method === 'remove-button') {
        editor.querySelector<HTMLButtonElement>('[data-inline-token-type="mcp-ref"] button')!.click();
      } else {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
      }
    });
    expect(editor.querySelector('[data-inline-token-type="mcp-ref"]')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith('before', emptyContexts);
  });

  it('can replace an active inline trigger with a skill token', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="$pdf"
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as (HTMLDivElement & {
      replaceActiveInlineTrigger?: (replacementText: string) => void;
    }) | null;
    expect(editor).toBeTruthy();

    setCaret(editor!, '$pdf'.length);
    await act(async () => {
      editor!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    await act(async () => {
      editor?.replaceActiveInlineTrigger?.('[$pdf]');
    });

    expect(onChange).toHaveBeenCalledWith('[$pdf]', emptyContexts);
    const skillPill = editor?.querySelector('.rich-text-tag-pill--skill-ref');
    expect(skillPill).toBeTruthy();
    expect(skillPill?.querySelector('[data-openbitfun-component="icon"][data-openbitfun-name="extension"]')).toBeTruthy();
    expect(skillPill?.nextSibling?.textContent).toBe(' ');
    const selection = window.getSelection();
    expect(selection?.anchorNode).toBe(editor);
    expect(selection?.anchorOffset).toBeGreaterThan(Array.from(editor?.childNodes ?? []).indexOf(skillPill as ChildNode));
  });

  it('can close an active inline trigger imperatively', async () => {
    const onInlineTriggerStateChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="$pdf"
          onChange={() => {}}
          onInlineTriggerStateChange={onInlineTriggerStateChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as (HTMLDivElement & {
      closeInlineTrigger?: () => void;
    }) | null;
    expect(editor).toBeTruthy();

    setCaret(editor!, '$pdf'.length);
    await act(async () => {
      editor!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    await act(async () => {
      editor?.closeInlineTrigger?.();
    });

    expect(onInlineTriggerStateChange).toHaveBeenLastCalledWith({
      isActive: false,
      trigger: null,
      query: '',
      startOffset: 0,
    });
  });

  it('can append an inline skill token at the end with trailing space', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="hello"
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as (HTMLDivElement & {
      appendInlineTokenAtEnd?: (token: string) => void;
    }) | null;
    expect(editor).toBeTruthy();

    await act(async () => {
      editor?.appendInlineTokenAtEnd?.('[$pdf]');
    });

    expect(onChange).toHaveBeenCalledWith('hello [$pdf]', emptyContexts);
    const skillPill = editor?.querySelector('.rich-text-tag-pill--skill-ref');
    expect(skillPill).toBeTruthy();
    expect(skillPill?.previousSibling?.textContent).toBe(' ');
    expect(skillPill?.nextSibling?.textContent).toBe(' ');
  });

  it('can append the Review reference through the same inline-token interaction', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="hello"
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as RichTextInputElement | null;
    expect(editor).toBeTruthy();

    await act(async () => {
      editor?.appendInlineTokenAtEnd?.('[[openbitfun-additional-mode:review]]');
    });

    expect(onChange).toHaveBeenCalledWith(
      'hello [[openbitfun-additional-mode:review]]',
      emptyContexts,
    );
    expect(editor?.querySelector('.rich-text-tag-pill--additional-mode-ref')).toBeTruthy();
  });

  it('clears placeholder br before appending the first inline skill token', async () => {
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={onChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as (HTMLDivElement & {
      appendInlineTokenAtEnd?: (token: string) => void;
    }) | null;
    expect(editor).toBeTruthy();

    editor!.innerHTML = '<br>';

    await act(async () => {
      editor?.appendInlineTokenAtEnd?.('[$pdf]');
    });

    expect(onChange).toHaveBeenCalledWith('[$pdf]', emptyContexts);
    expect(editor?.querySelector('br')).toBeFalsy();
    expect(editor?.firstChild).toBe(editor?.querySelector('.rich-text-tag-pill--skill-ref'));
  });

  it('inserts a separating space when opening the context picker from a mid-word caret', async () => {
    const onContextTriggerStateChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value="hello"
          onChange={() => {}}
          onContextTriggerStateChange={onContextTriggerStateChange}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input');
    expect(editor).toBeInstanceOf(HTMLDivElement);

    setCaret(editor as HTMLDivElement, 'hello'.length);

    await act(async () => {
      ((editor as HTMLDivElement) as RichTextInputElement).openContextPicker?.();
    });

    expect(editor?.textContent).toBe('hello @');
    expect(onContextTriggerStateChange).toHaveBeenLastCalledWith({
      isActive: true,
      query: '',
      startOffset: 6,
    });
  });

  it('renders a semantic large-paste capsule without leaking its controls into input text', async () => {
    const placeholder = '[Pasted Content 1001 chars]';
    const onChange = vi.fn();

    await act(async () => {
      root.render(
        <RichTextInput
          value={`before ${placeholder} after`}
          onChange={onChange}
          pendingLargePastes={{ [placeholder]: 'x'.repeat(1001) }}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    const capsule = editor.querySelector('[data-large-paste-placeholder]') as HTMLElement | null;
    expect(capsule).toBeTruthy();
    expect(capsule?.getAttribute('contenteditable')).toBe('false');
    expect(capsule?.getAttribute('role')).toBe('button');

    await act(async () => {
      editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith(`before ${placeholder} after`, emptyContexts);
  });

  it('lets users view, copy, cancel, edit, save, and remove a large paste', async () => {
    const placeholder = '[Pasted Content 1001 chars]';
    const updatedPlaceholder = '[Pasted Content 1002 chars]';
    const originalText = 'a'.repeat(1001);
    const editedText = `${originalText}b`;
    const onChange = vi.fn();
    const onUpdateLargePaste = vi.fn(() => updatedPlaceholder);
    const onRemoveLargePaste = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await act(async () => {
      root.render(
        <RichTextInput
          value={placeholder}
          onChange={onChange}
          pendingLargePastes={{ [placeholder]: originalText }}
          onUpdateLargePaste={onUpdateLargePaste}
          onRemoveLargePaste={onRemoveLargePaste}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    const getCapsule = () => editor.querySelector('[data-large-paste-placeholder]') as HTMLElement;
    await act(async () => {
      getCapsule().click();
    });

    let textarea = document.body.querySelector(
      '.rich-text-large-paste-dialog__textarea textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe(originalText);

    const dialog = textarea.closest('[role="dialog"]') as HTMLElement;
    const dialogButtons = Array.from(dialog.querySelectorAll('button'));
    const [copyButton, cancelButton, saveButton] = dialogButtons.slice(-3);
    await act(async () => {
      copyButton?.click();
    });
    expect(writeText).toHaveBeenCalledWith(originalText);

    await act(async () => {
      Simulate.change(textarea, { target: { value: editedText } } as never);
    });
    await act(async () => {
      cancelButton?.click();
    });
    await act(async () => {
      getCapsule().click();
    });
    textarea = document.body.querySelector(
      '.rich-text-large-paste-dialog__textarea textarea',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe(originalText);

    await act(async () => {
      Simulate.change(textarea, { target: { value: editedText } } as never);
    });
    await act(async () => {
      saveButton?.click();
    });

    expect(onUpdateLargePaste).toHaveBeenCalledWith(placeholder, editedText);
    expect(getCapsule().dataset.largePastePlaceholder).toBe(updatedPlaceholder);
    expect(onChange).toHaveBeenLastCalledWith(updatedPlaceholder, emptyContexts);

    const removeButton = getCapsule().querySelector('button');
    await act(async () => {
      removeButton?.click();
    });
    expect(onRemoveLargePaste).toHaveBeenCalledWith(updatedPlaceholder);
    expect(editor.querySelector('[data-large-paste-placeholder]')).toBeNull();
  });

  it('inserts Unicode large pastes as capsules at the caret', async () => {
    const text = '文😀'.repeat(501);
    const placeholder = '[Pasted Content 1002 chars]';
    const onChange = vi.fn();
    const onLargePaste = vi.fn(() => placeholder);

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={onChange}
          onLargePaste={onLargePaste}
          pendingLargePastes={{ [placeholder]: text }}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    setCaret(editor, 0);
    const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [],
        getData: (type: string) => type === 'text/plain' ? text : '',
      },
    });
    await act(async () => {
      editor.dispatchEvent(pasteEvent);
    });

    expect(onLargePaste).toHaveBeenCalledWith(text);
    expect(editor.querySelector('[data-large-paste-placeholder]')).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith(placeholder, emptyContexts);
    const selection = window.getSelection();
    expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(selection?.anchorNode?.textContent).toBe('\u200B');
    expect(selection?.anchorOffset).toBe(1);
  });

  it('keeps the caret visually anchored after consecutive large-paste capsules', async () => {
    const text = 'x'.repeat(1001);
    const placeholders = [
      '[Pasted Content 1001 chars]',
      '[Pasted Content 1001 chars] #2',
      '[Pasted Content 1001 chars] #3',
    ];
    const onChange = vi.fn();
    let pasteIndex = 0;
    const onLargePaste = vi.fn(() => placeholders[pasteIndex++] ?? null);

    await act(async () => {
      root.render(
        <RichTextInput
          value=""
          onChange={onChange}
          onLargePaste={onLargePaste}
          contexts={emptyContexts}
          onRemoveContext={() => {}}
        />
      );
    });

    const editor = container.querySelector('.rich-text-input') as HTMLDivElement;
    setCaret(editor, 0);
    const dispatchPaste = async () => {
      const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          items: [],
          getData: (type: string) => type === 'text/plain' ? text : '',
        },
      });
      await act(async () => {
        editor.dispatchEvent(pasteEvent);
      });
    };

    await dispatchPaste();
    await dispatchPaste();
    await dispatchPaste();

    expect(editor.querySelectorAll('[data-large-paste-placeholder]')).toHaveLength(3);
    expect(onChange).toHaveBeenLastCalledWith(placeholders.join(''), emptyContexts);
    const selection = window.getSelection();
    expect(selection?.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
    expect(selection?.anchorNode?.textContent).toBe('\u200B');
    expect(selection?.anchorOffset).toBe(1);

    const pressBackspace = async () => {
      await act(async () => {
        editor.dispatchEvent(new window.KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        }));
      });
    };
    await pressBackspace();
    expect(editor.querySelectorAll('[data-large-paste-placeholder]')).toHaveLength(2);
    expect(selection?.anchorNode?.previousSibling).toBe(
      editor.querySelector('[data-large-paste-placeholder]:nth-of-type(2)'),
    );
    expect(selection?.anchorOffset).toBe(1);

    await pressBackspace();
    expect(editor.querySelectorAll('[data-large-paste-placeholder]')).toHaveLength(1);
    expect(selection?.anchorNode?.previousSibling).toBe(
      editor.querySelector('[data-large-paste-placeholder]'),
    );
    expect(selection?.anchorOffset).toBe(1);
  });

  it('closes an open large-paste editor when the surface-scoped source changes', async () => {
    const placeholder = '[Pasted Content 1001 chars]';
    const renderInput = (text: string) => (
      <RichTextInput
        value={placeholder}
        onChange={() => {}}
        pendingLargePastes={{ [placeholder]: text }}
        contexts={emptyContexts}
        onRemoveContext={() => {}}
      />
    );

    await act(async () => {
      root.render(renderInput('surface-a'));
    });
    const capsule = container.querySelector('[data-large-paste-placeholder]') as HTMLElement;
    await act(async () => {
      capsule.click();
    });
    expect(document.body.querySelector('textarea')).toBeTruthy();

    await act(async () => {
      root.render(renderInput('surface-b'));
    });
    expect(document.body.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
  });
});
