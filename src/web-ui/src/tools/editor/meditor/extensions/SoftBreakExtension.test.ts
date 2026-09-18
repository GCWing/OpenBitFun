// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { SoftBreakExtension } from './SoftBreakExtension';
import { markdownToTiptapDoc, tiptapDocToMarkdown } from '../utils/tiptapMarkdown';

let editor: Editor | null = null;

function createEditor(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit, SoftBreakExtension],
    content: markdownToTiptapDoc(markdown),
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

describe('SoftBreakExtension', () => {
  it('marks every soft break in a hard-wrapped paragraph', () => {
    const instance = createEditor('alpha line one\nbeta line two\ngamma line three');
    const breaks = instance.view.dom.querySelectorAll('.m-editor-soft-break');

    expect(breaks).toHaveLength(2);
    expect([...breaks].map(node => node.textContent)).toEqual(['\n', '\n']);
  });

  it('marks the whole CRLF line ending, not just the newline', () => {
    const instance = createEditor('alpha line one\r\nbeta line two');
    const breaks = instance.view.dom.querySelectorAll('.m-editor-soft-break');

    expect(breaks).toHaveLength(1);
    expect([...breaks].map(node => node.textContent)).toEqual(['\r\n']);
  });

  it('leaves the document unchanged so the source keeps its wrapping', () => {
    const markdown = 'alpha line one\nbeta line two';
    const instance = createEditor(markdown);

    expect(instance.view.dom.textContent).toBe(markdown);
    expect(tiptapDocToMarkdown(instance.getJSON())).toContain('alpha line one\nbeta line two');
  });

  it('keeps newlines inside code blocks untouched', () => {
    const instance = createEditor('```js\nconst a = 1;\nconst b = 2;\n```');

    expect(instance.view.dom.querySelectorAll('.m-editor-soft-break')).toHaveLength(0);
  });

  it('re-collects soft breaks after the document changes', () => {
    const instance = createEditor('alpha line one\nbeta line two');
    instance.commands.setContent(markdownToTiptapDoc('only one line'));

    expect(instance.view.dom.querySelectorAll('.m-editor-soft-break')).toHaveLength(0);
  });
});
