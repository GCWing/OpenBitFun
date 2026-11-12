// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import type * as Monaco from 'monaco-editor';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LatexEditor from './LatexEditor';
import { EditorDocument, EditorDocumentContext } from '../services/EditorDocument';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  supported: true,
  sourceProps: undefined as import('./CodeEditor').CodeEditorProps | undefined,
  insertSnippet: undefined as ((value: string) => void) | undefined,
}));

vi.mock('@openbitfun/ui', async importOriginal => {
  const actual = await importOriginal<typeof import('@openbitfun/ui')>();
  return { ...actual, Select: (props: ComponentProps<typeof actual.Select>) => {
    if (props['aria-label'] === 'editor.latexEditor.insert') mocks.insertSnippet = props.onValueChange;
    return <actual.Select {...props} />;
  } };
});

vi.mock('@/infrastructure/api/service-api/LatexAPI', () => ({
  compileWorkspaceLatex: mocks.invoke,
  supportsLatexPreview: () => mocks.supported,
}));
vi.mock('@/infrastructure/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('./CodeEditor', () => ({
  default: (props: import('./CodeEditor').CodeEditorProps) => {
    mocks.sourceProps = props;
    return <textarea aria-label="Source" />;
  },
}));
vi.mock('../pdf-review/PdfReviewEditor', () => ({
  default: ({ pdfBase64, filePath }: import('./PdfViewer').PdfViewerProps) => <div data-pdf={pdfBase64} data-file={filePath} />,
}));

let container: HTMLDivElement;
let root: Root;
const path = '/project/main.tex';
const origin = { surfaceId: 'local', workspaceId: 'workspace-a' };

function renderEditor(document = new EditorDocument('latex-test', origin, path)) {
  root.render(<EditorDocumentContext.Provider value={document}>
    <LatexEditor filePath={path} />
  </EditorDocumentContext.Provider>);
  return document;
}

function compileButton() {
  const button = [...container.querySelectorAll('button')].find(
    candidate => candidate.textContent === 'editor.latexEditor.compile',
  );
  if (!button) throw new Error('Compile button is missing');
  return button;
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  activateSurface('local');
  mocks.invoke.mockReset();
  mocks.supported = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

it('saves the shared source before compiling and keeps the previous PDF on failure', async () => {
  const doc = new EditorDocument('latex-test', origin, path);
  doc.capture('draft', true, 'old source');
  doc.save = vi.fn(async () => { doc.capture('draft', false); });
  mocks.invoke.mockImplementationOnce(async () => {
    expect(doc.snapshot?.isDirty).toBe(false);
    return { pdfBase64: 'first-build' };
  });
  await act(async () => { renderEditor(doc); });
  await act(async () => { compileButton().click(); });
  await vi.waitFor(() => expect(container.querySelector('[data-pdf]')?.getAttribute('data-pdf')).toBe('first-build'));
  expect(doc.save).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(origin, path, 'pdflatex');

  mocks.invoke.mockRejectedValueOnce(new Error('main.tex:8: Undefined control sequence'));
  await act(async () => { compileButton().click(); });
  expect(container.textContent).toContain('editor.latexEditor.stalePreview');
  expect(container.textContent).toContain('main.tex:8');
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-pdf')).toBe('first-build');
});

it('blocks compile on a failed save or an unsupported host', async () => {
  const doc = new EditorDocument('latex-test', origin, path);
  doc.capture('dirty source', true, 'old source');
  doc.save = vi.fn(async () => undefined);
  await act(async () => { renderEditor(doc); });
  await act(async () => { compileButton().click(); });
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(container.textContent).toContain('editor.latexEditor.saveFailed');

  mocks.supported = false;
  await act(async () => { renderEditor(doc); });
  expect(compileButton().disabled).toBe(true);
});

it('coalesces edits that arrive while auto compilation is running', async () => {
  vi.useFakeTimers();
  let finish!: (result: { pdfBase64: string }) => void;
  mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  mocks.invoke.mockResolvedValue({ pdfBase64: 'newest-build' });
  await act(async () => { renderEditor(); });
  const toggle = container.querySelector<HTMLInputElement>('[role="switch"]')!;
  await act(async () => { toggle.click(); });
  expect(mocks.sourceProps?.autoSave).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    mocks.sourceProps?.onSave?.('revision one');
    mocks.sourceProps?.onContentChange?.('revision two from disk', false);
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ pdfBase64: 'old-build' }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it('independently hides either pane and restores the same source view after both are closed', async () => {
  await act(async () => { renderEditor(); });
  const source = container.querySelector('textarea');
  const toggle = (key: string) => [...container.querySelectorAll('button')].find(button => button.textContent === key)!;
  await act(async () => toggle('editor.latexEditor.source').click());
  expect(container.querySelector('.latex-editor__split')?.getAttribute('data-mode')).toBe('secondary');
  expect(container.querySelector('textarea')).toBe(source);
  expect(mocks.sourceProps?.isActiveTab).toBe(false);
  await act(async () => toggle('editor.latexEditor.preview').click());
  expect(container.querySelector('.latex-editor__body')?.hasAttribute('hidden')).toBe(true);
  expect(container.textContent).toContain('editor.latexEditor.panesClosed');
  await act(async () => toggle('editor.latexEditor.restorePanes').click());
  expect(container.querySelector('.latex-editor__split')?.getAttribute('data-mode')).toBe('split');
  expect(container.querySelector('textarea')).toBe(source);
  expect(mocks.sourceProps?.isActiveTab).toBe(true);
});

it('retains pane preferences when the same document moves between views', async () => {
  const doc = new EditorDocument('layout-retained', origin, path);
  await act(async () => { renderEditor(doc); });
  const close = container.querySelector<HTMLButtonElement>('[aria-label="editor.latexEditor.closeSource"]')!;
  await act(async () => close.click());
  await act(async () => root.render(null));
  await act(async () => { renderEditor(doc); });
  expect(container.querySelector('.latex-editor__split')?.getAttribute('data-mode')).toBe('secondary');
});

it('compiles the declared project entry after saving an included source file', async () => {
  const doc = new EditorDocument('root-project', origin, path);
  doc.capture('% !TeX root = manuscript.tex\n\\section{Introduction}', false);
  mocks.invoke.mockResolvedValueOnce({ pdfBase64: 'project-pdf', log: 'LaTeX compiler warnings' });
  await act(async () => { renderEditor(doc); });
  await act(async () => compileButton().click());
  expect(mocks.invoke).toHaveBeenCalledWith(origin, '/project/manuscript.tex', 'pdflatex');
});

it.each([false, true])('inserts body snippets after the document start without replacing selected preamble: %s', async selectedPreamble => {
  const original = '% !TeX program = pdflatex\n\\documentclass{article}\n\\begin{document}\nExisting text\n\\end{document}';
  let source = original;
  let start = 0;
  let end = selectedPreamble ? original.indexOf('Existing text') : 0;
  const positionAt = (offset: number) => {
    const lines = source.slice(0, offset).split('\n');
    return { lineNumber: lines.length, column: lines[lines.length - 1]!.length + 1 };
  };
  const offsetAt = (position: Monaco.IPosition) => source.split('\n').slice(0, position.lineNumber - 1)
    .reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1;
  const editor = {
    focus: vi.fn(),
    getModel: () => ({ getValue: () => source, getEOL: () => '\n', getOffsetAt: offsetAt, getPositionAt: positionAt }),
    getSelection: () => ({ getStartPosition: () => positionAt(start) }),
    setSelection: (range: Monaco.IRange) => {
      start = offsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
      end = offsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    },
    getContribution: () => ({ insert: (snippet: string) => {
      const content = snippet.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '');
      source = source.slice(0, start) + content + source.slice(end);
    } }),
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  await act(async () => { renderEditor(); });
  await act(async () => { mocks.sourceProps?.onEditorReady?.(editor); });
  await act(async () => mocks.insertSnippet?.('section'));
  expect(source.startsWith('% !TeX program = pdflatex\n\\documentclass{article}')).toBe(true);
  expect(source).toContain('\\begin{document}\n\\section{Title}\n');
  expect(source).toContain('Existing text\n\\end{document}');
});

function mainFileInput() {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="editor.latexEditor.mainFile"]');
  if (!input) throw new Error('Main file input is missing');
  return input;
}
async function typeMainFile(value: string) {
  const input = mainFileInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
  });
}
async function enableAutoCompile() {
  await act(async () => { container.querySelector<HTMLInputElement>('[role="switch"]')!.click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}

it('keeps the build target and review owner until the main-file entry is committed', async () => {
  vi.useFakeTimers();
  mocks.invoke.mockResolvedValue({ pdfBase64: 'build' });
  await act(async () => { renderEditor(); });
  await enableAutoCompile();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => mainFileInput().focus());
  for (const partial of ['c', 'chapters/', 'chapters/paper.tex']) await typeMainFile(partial);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-file')).toBe(path);

  await act(async () => { mainFileInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.invoke).toHaveBeenLastCalledWith(origin, '/project/chapters/paper.tex', 'pdflatex');
  expect(container.querySelector('[data-pdf]')?.getAttribute('data-file')).toBe('/project/chapters/paper.tex');
});

it('restores the committed main file on Escape and commits an edited entry on blur', async () => {
  vi.useFakeTimers();
  mocks.invoke.mockResolvedValue({ pdfBase64: 'build' });
  await act(async () => { renderEditor(); });
  await enableAutoCompile();
  await act(async () => mainFileInput().focus());
  await typeMainFile('draft.tex');
  await act(async () => { mainFileInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(mainFileInput().value).toBe('');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);

  await typeMainFile('appendix.tex');
  await act(async () => mainFileInput().blur());
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(mocks.invoke).toHaveBeenLastCalledWith(origin, '/project/appendix.tex', 'pdflatex');
});
