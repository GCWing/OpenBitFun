// @vitest-environment jsdom

import React, { act, createRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { EditorInstance } from '../types'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
}))

vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="block-renderer">{content}</div>,
}))

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { MEditor, MEditorErrorBoundary } from './MEditor'

function UnsupportedMarkdownRenderer(): never {
  throw new SyntaxError('Invalid regular expression: invalid group specifier name')
}

describe('MEditorErrorBoundary', () => {
  let container: HTMLDivElement
  let root: Root
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.logError.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    consoleError.mockRestore()
  })

  it('keeps the original markdown visible when the rich editor cannot render', () => {
    act(() => {
      root.render(
        <MEditorErrorBoundary
          editorProps={{ value: '# Recovery plan', readonly: true }}
          forwardedRef={null}
        >
          <UnsupportedMarkdownRenderer />
        </MEditorErrorBoundary>
      )
    })

    const fallback = container.querySelector<HTMLTextAreaElement>(
      '[data-openbitfun-component="m-editor"][data-m-editor-fallback="true"] textarea'
    )
    expect(fallback?.value).toBe('# Recovery plan')
    expect(fallback?.readOnly).toBe(true)
    expect(mocks.logError).toHaveBeenCalledWith(
      'Markdown editor render failed, showing source fallback',
      expect.objectContaining({
        message: 'Invalid regular expression: invalid group specifier name',
      })
    )
  })

  const sourceMarkdown = '# Before\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nAfter';

  function getEditor(): Editor {
    return (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
  }

  async function renderEditor(markdown = sourceMarkdown, readonly = false) {
    const ref = createRef<EditorInstance>();
    const onDirtyChange = vi.fn();
    const onSave = vi.fn();
    let setDocumentValue: (value: string) => void;
    function Document() {
      const [value, setValue] = useState(markdown);
      setDocumentValue = setValue;
      const [mode, setMode] = useState<'ir' | 'edit'>('ir');
      const [locked, setLocked] = useState(readonly);
      return <>
        <button id="readonly" onClick={() => setLocked(!locked)}>Toggle readonly</button>
        <button id="reload" onClick={() => setValue('# Reloaded')}>Reload</button>
        <button id="mode" onClick={() => setMode(mode === 'ir' ? 'edit' : 'ir')}>Switch</button>
        <MEditor ref={ref} value={value} onChange={setValue} onDirtyChange={onDirtyChange}
          onSave={onSave} mode={mode} readonly={locked} />
      </>;
    }
    await act(async () => root.render(<Document />));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    return { ref, onDirtyChange, onSave, setDocumentValue: (next: string) => setDocumentValue(next) };
  }

  it.each([
    sourceMarkdown,
    '# Before\n\n<div data-custom="yes">HTML</div>\n\nAfter',
    '# Before\n\nMix <span data-x="1">inline</span> HTML.\n\nAfter',
    '# Before\n\nFootnote[^a].\n\n[^a]: Definition\n\nAfter',
    '# Before\n\n$$\nx^2\n$$\n\nAfter',
  ])('keeps surrounding paragraphs editable and special content in source-backed blocks: %s', async markdown => {
    await renderEditor(markdown);
    expect(container.querySelector('.m-editor-mode-ir')).not.toBeNull();
    expect(container.querySelector('.m-editor-mode-split, .m-editor-mode-preview')).toBeNull();
    expect(getEditor().isEditable).toBe(true);
    expect(getEditor().getJSON().content?.[0].type).toBe('heading');
    expect(getEditor().getJSON().content?.at(-1)?.type).toBe('paragraph');
    expect(container.querySelector('.m-editor-source-block-action')).not.toBeNull();
  });

  it('edits a native block beside partially bold strikethrough without opening document source', async () => {
    const markdown = '# Report\n\n- ~~**Remaining**: implementation and tests~~ **Done**\n\nOrdinary text.';
    const { ref, onSave } = await renderEditor(markdown);
    expect(getEditor().getJSON().content?.map(node => node.type)).toEqual(['heading', 'bulletList', 'paragraph']);
    expect(container.querySelector('.m-editor-source-block-action')).toBeNull();
    expect(ref.current?.getValue()).toBe(markdown);
    act(() => {
      getEditor().commands.setTextSelection(getEditor().state.doc.content.size - 1);
      getEditor().commands.insertContent(' Added.');
    });
    expect(ref.current?.getValue()).toBe(`${markdown} Added.`);
    act(() => container.querySelector('.tiptap')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }),
    ));
    expect(onSave).toHaveBeenLastCalledWith(`${markdown} Added.`);
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(markdown);
    act(() => { ref.current?.redo?.(); });
    expect(ref.current?.getValue()).toBe(`${markdown} Added.`);
  });

  it('navigates and highlights a rich-text block without editing the imported Markdown', async () => {
    const markdown = '# Title\n\n[badge](https://example.com?a=1&b=2)\n\n## Target\n\nWrapped\nparagraph.';
    const scrollIntoView = vi.fn();
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { ref, onDirtyChange } = await renderEditor(markdown);
      const editor = getEditor();
      const originalDocument = editor.state.doc;
      const updates = vi.fn();
      editor.on('update', updates);
      const target = container.querySelector('h2')!;
      let targetPosition = -1;
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === 'heading' && node.attrs.level === 2) targetPosition = offset + 1;
      });
      onDirtyChange.mockClear();
      act(() => ref.current?.scrollToLine?.(5, true));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      expect(target.classList.contains('m-editor-tiptap-block-highlighted')).toBe(true);
      expect(scrollIntoView).toHaveBeenCalled();
      expect(editor.state.doc.eq(originalDocument)).toBe(true);
      expect(updates).not.toHaveBeenCalled();
      expect(ref.current?.getValue()).toBe(markdown);
      expect(ref.current?.isDirty).toBe(false);
      expect(onDirtyChange).not.toHaveBeenCalledWith(true);
      expect(editor.state.selection.from).toBe(targetPosition);
      expect(editor.isFocused).toBe(true);
      act(() => ref.current?.scrollToLine?.(1, false));
      expect(container.querySelector('.m-editor-tiptap-block-highlighted')).toBeNull();
      expect(editor.state.selection.from).toBe(1);
      act(() => ref.current?.scrollToLine?.(5, true));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
      expect(container.querySelector('.m-editor-tiptap-block-highlighted')).toBeNull();
      expect(editor.state.selection.from).toBe(targetPosition);
      expect(editor.state.doc.eq(originalDocument)).toBe(true);
      expect(updates).not.toHaveBeenCalled();
      expect(ref.current?.getValue()).toBe(markdown);
      expect(ref.current?.isDirty).toBe(false);
      expect(editor.can().undo()).toBe(false);
    } finally {
      HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
    }
  });

  it('retains link metadata, literal syntax and code spaces across edits, save, undo and reload', async () => {
    const markdown = '# Before\n\n[label](<https://example.com/a b> "a & title")\n\n\\# literal\n\n``  padded  ``\n\nAfter';
    const { ref, onSave, setDocumentValue } = await renderEditor(markdown);
    const assertContent = () => {
      expect(container.querySelector('.m-editor-source-block-action')).toBeNull();
      expect(container.querySelector('a')?.getAttribute('title')).toBe('a & title');
      expect(container.querySelector('code')?.textContent).toBe(' padded ');
      expect(getEditor().getJSON().content?.map(n => n.type)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
    };
    assertContent();
    act(() => {
      getEditor().commands.setTextSelection(getEditor().state.doc.content.size - 1);
      getEditor().commands.insertContent(' updated');
    });
    const saved = ref.current!.getValue();
    expect(saved).toContain('"a & title"');
    expect(saved).toContain('\\# literal');
    act(() => container.querySelector('.tiptap')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(saved);
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(markdown);
    act(() => { ref.current?.redo?.(); });
    expect(ref.current?.getValue()).toBe(saved);
    await act(async () => setDocumentValue('# Other document'));
    await act(async () => setDocumentValue(saved));
    assertContent();
    expect(getEditor().getText()).toContain('After updated');
  });

  it('preserves the built-in underline mark after editing and reloading', async () => {
    const { ref, setDocumentValue } = await renderEditor('Before <u>underlined</u> after.');
    expect(container.querySelector('u')?.textContent).toBe('underlined');
    act(() => {
      getEditor().commands.setTextSelection(getEditor().state.doc.content.size - 1);
      getEditor().commands.insertContent(' updated');
    });
    const saved = ref.current!.getValue();
    await act(async () => setDocumentValue('# Other document'));
    await act(async () => setDocumentValue(saved));
    expect(container.querySelector('u')?.textContent).toBe('underlined');
    expect(getEditor().getJSON().content?.[0].type).toBe('paragraph');
    expect(getEditor().getText()).toBe('Before underlined after. updated');
  });

  it('limits a source-backed fallback to its block when editing and saving neighbors', async () => {
    const block = 'Text <b><strong>nested</strong></b> after.';
    const markdown = '# Before\n\n'+block+'\n\nAfter';
    const { ref } = await renderEditor(markdown);
    expect(getEditor().getJSON().content?.map(n => n.type)).toEqual(['heading', 'renderOnlyBlock', 'paragraph']);
    act(() => {
      getEditor().commands.setTextSelection(getEditor().state.doc.content.size - 1);
      getEditor().commands.insertContent(' updated');
    });
    expect(ref.current?.getValue()).toBe(markdown+' updated');
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(markdown);
  });

  it('edits an embedded block, saves with the document shortcut, and supports undo/redo', async () => {
    const { ref, onDirtyChange, onSave } = await renderEditor();
    const action = container.querySelector<HTMLButtonElement>('.m-editor-source-block-action')!;
    expect(container.querySelector<HTMLElement>('.m-editor-embed-toolbar')?.hidden).toBe(true);
    act(() => container.querySelector<HTMLElement>('[data-testid="md-embed-preview"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('.m-editor-render-only-block__textarea')!;
    expect(textarea.closest('[data-editing]')?.getAttribute('data-editing')).toBe('true');
    act(() => {
      textarea.value = 'graph TD\n  A-->C';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ref.current?.getValue()).toContain('A-->C');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    act(() => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(sourceMarkdown.replace('A-->B', 'A-->C'));
    act(() => action.click());
    expect(textarea.closest('[data-editing]')?.getAttribute('data-editing')).toBe('false');
    expect(container.querySelector('[data-testid="block-renderer"]')?.textContent).toContain('A-->C');
    expect(container.querySelector<HTMLElement>('.m-editor-embed-toolbar')?.hidden).toBe(true);
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(sourceMarkdown);
    act(() => { ref.current?.redo?.(); });
    expect(ref.current?.getValue()).toContain('A-->C');
  });

  it('edits inline math without replacing the surrounding paragraph', async () => {
    const { ref } = await renderEditor('Before $x^2$ after.');
    expect(getEditor().getJSON().content?.[0].type).toBe('paragraph');
    const preview = container.querySelector<HTMLElement>('.m-editor-inline-math__preview')!;
    act(() => preview.click());
    const source = container.querySelector<HTMLTextAreaElement>('.m-editor-inline-math__textarea')!;
    expect(source.value).toBe('x^2');
    act(() => {
      source.value = 'y^2';
      source.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ref.current?.getValue()).toBe('Before $y^2$ after.');
    act(() => document.body.dispatchEvent(new Event('click', { bubbles: true })));
    expect(preview.closest('[data-editing]')?.getAttribute('data-editing')).toBe('false');
  });

  it('completes a final embed with the keyboard and creates an editable following paragraph', async () => {
    const { ref } = await renderEditor('$$\nx^2\n$$');
    act(() => container.querySelector<HTMLElement>('[data-testid="md-embed-preview"]')!.click());
    const source = container.querySelector<HTMLTextAreaElement>('[data-testid="md-embed-source"]')!;
    expect(source.value).toBe('x^2');
    act(() => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    expect(getEditor().state.selection.$from.parent.type.name).toBe('paragraph');
    act(() => { getEditor().commands.insertContent('Following text'); });
    expect(ref.current?.getValue()).toContain('$$\nx^2\n$$\n\nFollowing text');
  });

  it('preserves dirty state through source/rich text switches', async () => {
    const { ref, onDirtyChange } = await renderEditor('# Original');
    act(() => getEditor().commands.insertContentAt(1, 'Changed '));
    const edited = ref.current?.getValue();
    expect(ref.current?.isDirty).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('#mode')!.click());
    expect(container.querySelector('textarea')?.value).toBe(edited);
    await act(async () => container.querySelector<HTMLButtonElement>('#mode')!.click());
    expect(ref.current?.getValue()).toBe(edited);
    expect(ref.current?.isDirty).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('reports the first edit after an external reload', async () => {
    const { ref, onDirtyChange } = await renderEditor('# Original');
    // The document owner supplies new content and explicitly marks its disk baseline.
    await act(async () => container.querySelector<HTMLButtonElement>('#reload')!.click());
    act(() => { ref.current?.setInitialContent?.('# Reloaded'); });
    act(() => getEditor().commands.insertContentAt(1, 'First '));
    expect(ref.current?.getValue()).toBe('# First Reloaded');
    expect(ref.current?.isDirty).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it.each([
    '# Undo test\n\n* item\n',
    '#  Undo test\n\n\nText\n\n',
    '# Undo test\r\n\r\nText\r\n',
    '# Undo test\n\n__bold__ and _italic_\n',
  ])('restores the exact imported source and clean state after undo: %s', async raw => {
    const { ref, onDirtyChange } = await renderEditor(raw);
    act(() => getEditor().commands.insertContentAt(1, 'Changed '));
    const edited = ref.current!.getValue();
    expect(ref.current?.isDirty).toBe(true);
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(raw);
    expect(ref.current?.isDirty).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    act(() => { ref.current?.redo?.(); });
    expect(ref.current?.getValue()).toBe(edited);
    expect(ref.current?.isDirty).toBe(true);
  });

  it('compares undo and redo with the latest successful save', async () => {
    const raw = '# Undo test\n\n* item\n';
    const { ref } = await renderEditor(raw);
    act(() => getEditor().commands.insertContentAt(1, 'Changed '));
    const saved = ref.current!.getValue();
    act(() => { ref.current?.markSaved?.(); });
    expect(ref.current?.isDirty).toBe(false);
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(raw);
    expect(ref.current?.isDirty).toBe(true);
    act(() => { ref.current?.redo?.(); });
    expect(ref.current?.getValue()).toBe(saved);
    expect(ref.current?.isDirty).toBe(false);
  });

  it('stays dirty after partial undo and clears only after all content changes are undone', async () => {
    const raw = '# Undo test\n\n* item\n';
    const { ref } = await renderEditor(raw);
    act(() => getEditor().commands.insertContentAt(1, 'First '));
    const firstEdit = ref.current!.getValue();
    act(() => {
      const editor = getEditor();
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'paragraph', content: [{ type: 'text', text: 'New block' }],
      });
    });
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(firstEdit);
    expect(ref.current?.isDirty).toBe(true);
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(raw);
    expect(ref.current?.isDirty).toBe(false);
  });

  it('preserves source-only changes through rich editing and undo', async () => {
    const raw = '# Undo test\n\n- item\n';
    const changed = '# Undo test\n\n* item\n\n';
    const { ref, setDocumentValue } = await renderEditor(raw);
    act(() => container.querySelector<HTMLButtonElement>('#mode')!.click());
    act(() => { setDocumentValue(changed); });
    await act(async () => container.querySelector<HTMLButtonElement>('#mode')!.click());
    expect(ref.current?.isDirty).toBe(true);
    act(() => getEditor().commands.insertContentAt(1, 'Changed '));
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(changed);
    expect(ref.current?.isDirty).toBe(true);
    act(() => { ref.current?.markSaved?.(); });
    act(() => getEditor().commands.insertContentAt(1, 'Again '));
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(changed);
    expect(ref.current?.isDirty).toBe(false);
  });

  it('replaces the source snapshot when disk content is reloaded', async () => {
    const raw = '#  Reloaded\n\n* item\n\n';
    const { ref, setDocumentValue } = await renderEditor('# Original');
    act(() => { setDocumentValue(raw); ref.current?.setInitialContent?.(raw); });
    act(() => getEditor().commands.insertContentAt(1, 'Changed '));
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toBe(raw);
    expect(ref.current?.isDirty).toBe(false);
  });

  it.each([
    '**Token** and *emphasis* with `code`.',
    '> Token',
    '- Token\n- Another item',
    '1. Token\n2. Another item',
    '- [ ] Token\n- [x] Done',
    '| Header |\n| --- |\n| Token |',
    '```typescript\nconst Token = 1;\n```',
    '<details>\n<summary>Title</summary>\n\nToken\n\n</details>',
    '[Token](https://example.com)',
  ])('edits native rich text without turning the document into an embed: %s', async markdown => {
    const { ref } = await renderEditor(markdown);
    let position = -1;
    getEditor().state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes('Token')) position = pos + node.text.indexOf('Token');
    });
    expect(position).toBeGreaterThanOrEqual(0);
    act(() => getEditor().commands.insertContentAt(position, 'Updated '));
    expect(ref.current?.getValue()).toContain('Updated Token');
    expect(ref.current?.isDirty).toBe(true);
    expect(container.querySelector('.m-editor-mode-preview, .m-editor-mode-split')).toBeNull();
  });

  it('edits image attributes in place and includes them in document saves', async () => {
    const { ref, onSave } = await renderEditor('Before ![Original](https://example.com/photo.png) after.');
    act(() => container.querySelector<HTMLElement>('.m-editor-image img')!.click());
    const fields = container.querySelector('.m-editor-image-fields')!;
    expect(fields.hasAttribute('hidden')).toBe(false);
    const alt = fields.querySelectorAll('input')[1];
    act(() => {
      alt.value = 'Updated description';
      alt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ref.current?.getValue()).toBe('Before ![Updated description](https://example.com/photo.png) after.');
    act(() => alt.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true })));
    expect(onSave).toHaveBeenLastCalledWith(ref.current?.getValue());
    act(() => { ref.current?.undo?.(); });
    expect(ref.current?.getValue()).toContain('![Original]');
  });

  it('edits frontmatter without losing its delimiters or surrounding content', async () => {
    const { ref } = await renderEditor('---\ntitle: Original\n---\n\n# Body');
    act(() => container.querySelector<HTMLElement>('.m-editor-frontmatter [data-testid="md-embed-preview"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('.m-editor-frontmatter__textarea')!;
    act(() => {
      textarea.value = 'title: Updated';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ref.current?.getValue()).toBe('---\ntitle: Updated\n---\n\n# Body');
  });

  it('keeps the document editable if its renderer fails', async () => {
    const onChange = vi.fn();
    act(() => root.render(
      <MEditorErrorBoundary editorProps={{ value: '# Recoverable', onChange }} forwardedRef={null}>
        <UnsupportedMarkdownRenderer />
      </MEditorErrorBoundary>,
    ));
    const textarea = container.querySelector('textarea')!;
    expect(textarea.readOnly).toBe(false);
  });

  it('does not rewrite or dirty a document just by opening it or changing permissions', async () => {
    const raw = '#  Original\n\nText\n\n';
    const { ref } = await renderEditor(raw);
    expect(ref.current?.getValue()).toBe(raw);
    expect(ref.current?.isDirty).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('#readonly')!.click());
    expect(ref.current?.getValue()).toBe(raw);
    expect(ref.current?.isDirty).toBe(false);
  });

  it('updates embedded block permissions when the document becomes readonly', async () => {
    await renderEditor();
    await act(async () => container.querySelector<HTMLButtonElement>('#readonly')!.click());
    expect(getEditor().isEditable).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('.m-editor-source-block-action')?.hidden).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('.m-editor-render-only-block__textarea')?.readOnly).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('#readonly')!.click());
    expect(container.querySelector<HTMLButtonElement>('.m-editor-source-block-action')?.hidden).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('.m-editor-render-only-block__textarea')?.readOnly).toBe(false);
  });

  it('honors explicit readonly documents without enabling embedded edits', async () => {
    await renderEditor(sourceMarkdown, true);
    expect(getEditor().isEditable).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('.m-editor-source-block-action')?.hidden).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>('.m-editor-render-only-block__textarea')?.readOnly).toBe(true);
  });

})

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
  useI18n: () => ({
    t: (key: string) => key === 'editor.markdownEditor.notice.sourcePreviewFallback'
      ? 'IR fallback warning'
      : key,
  }),
}))
