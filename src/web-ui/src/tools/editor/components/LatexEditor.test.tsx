// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LatexEditor from './LatexEditor';
import { EditorDocument, EditorDocumentContext } from '../services/EditorDocument';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  supported: true,
  sourceProps: undefined as import('./CodeEditor').CodeEditorProps | undefined,
}));

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
vi.mock('./PdfViewer', () => ({
  default: ({ pdfBase64 }: import('./PdfViewer').PdfViewerProps) => <div data-pdf={pdfBase64} />,
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
