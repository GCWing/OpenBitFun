// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import CodeEditor from './CodeEditor';
import { EditorDocument, EditorDocumentContext } from '../services/EditorDocument';
import { monacoModelManager } from '../services/MonacoModelManager';
import { setMonacoRuntime } from '../services/monacoRuntime';
import { globalEventBus } from '@/infrastructure/event-bus';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(), read: vi.fn(), metadata: vi.fn(), write: vi.fn(), logError: vi.fn(),
}));
vi.mock('../services/MonacoInitManager', () => ({ monacoInitManager: { initialize: mocks.initialize } }));
vi.mock('../services/editorFileAccess', () => ({
  standaloneEditorFileAccess: () => ({ readFileContent: mocks.read, getFileMetadata: mocks.metadata, writeFileContent: mocks.write }),
}));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: { readWorkspaceFile: mocks.read, getWorkspaceFileMetadata: mocks.metadata, writeWorkspaceFile: mocks.write },
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: { invoke: vi.fn(async () => ({})) } }));
vi.mock('@/infrastructure/appearance/adapters/MonacoAppearanceAdapter', () => ({
  monacoAppearanceAdapter: { attachMonaco: () => 'test' },
}));
vi.mock('../services/ActiveEditTargetService', () => ({
  activeEditTargetService: { bindTarget: () => () => {}, setActiveTarget: vi.fn(), clearActiveTarget: vi.fn() },
  createMonacoEditTarget: () => ({ id: 'test-editor' }),
}));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: { getConfig: async () => null, watch: () => () => {} },
}));
vi.mock('@/infrastructure/event-bus', () => {
  const listeners = new Map<string, Set<(data: unknown) => unknown>>();
  return { globalEventBus: {
    on: (name: string, listener: (data: unknown) => unknown) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    off: (name: string, listener: (data: unknown) => unknown) => listeners.get(name)?.delete(listener),
    emit: async (name: string, data: unknown) => Promise.all([...listeners.get(name) ?? []].map(listener => listener(data))),
  } };
});
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.logError }),
}));
vi.mock('@/shared/utils/debugProbe', () => ({ sendDebugProbe: vi.fn() }));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDialog: async () => true }));
vi.mock('./EditorBreadcrumb', () => ({ EditorBreadcrumb: () => null }));
vi.mock('@openbitfun/ui', () => ({ Button: 'button', LoadingState: 'div' }));
vi.mock('./EditorStatusBar', () => ({
  EditorStatusBar: ({ encoding, onEncodingClick }: { encoding: string; onEncodingClick: React.MouseEventHandler }) => (
    <button data-testid="encoding" onClick={onEncodingClick}>{encoding}</button>
  ),
}));
vi.mock('./StatusBarPopovers', () => ({
  GoToLinePopover: () => null,
  IndentPopover: () => null,
  LanguagePopover: () => null,
  EncodingPopover: ({ onConfirm }: { onConfirm: (encoding: string) => Promise<void> }) => (
    <><button data-testid="utf16" onClick={() => void onConfirm('UTF-16')}>UTF-16</button>
      <button data-testid="latin1" onClick={() => void onConfirm('ISO-8859-1')}>Latin-1</button></>
  ),
}));

const disposable = () => ({ dispose() {} });
const findListeners = new Set<() => void>();
const findState = {
  isRevealed: false, searchString: '', replaceString: '',
  onFindReplaceStateChange(listener: () => void) {
    findListeners.add(listener);
    return { dispose: () => { findListeners.delete(listener); } };
  },
};
class TextModel {
  private version = 1;
  private listeners = new Set<() => void>();
  private options = { tabSize: 2, insertSpaces: true };
  constructor(private value: string, readonly uri: { toString(): string }) {}
  getValue() { return this.value; }
  setValue(value: string) {
    if (value === this.value) return;
    this.value = value;
    this.version++;
    for (const listener of this.listeners) listener();
  }
  getAlternativeVersionId() { return this.version; }
  getLanguageId() { return 'plaintext'; }
  getOptions() { return this.options; }
  updateOptions(options: typeof this.options) { this.options = options; }
  onDidChangeOptions = disposable;
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  dispose() { this.listeners.clear(); }
}

function createRuntime() {
  const models = new Map<string, TextModel>();
  return {
    Uri: { file: (path: string) => ({ toString: () => `file://${path}` }), parse: (path: string) => ({ toString: () => path }) },
    editor: {
      onWillDisposeModel: disposable,
      getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
      createModel: (content: string, _language: string, uri: { toString(): string }) => {
        const model = new TextModel(content, uri);
        models.set(uri.toString(), model);
        return model;
      },
      create: (container: HTMLElement) => ({
        getDomNode: () => container,
        getContribution: () => ({ getState: () => findState }),
        updateOptions() {},
        onDidFocusEditorText: disposable,
        onDidBlurEditorText: disposable,
        onDidChangeModel: disposable,
        onDidChangeCursorPosition: disposable,
        onDidChangeCursorSelection: disposable,
        onMouseDown: disposable,
        onMouseMove: disposable,
        onDidLayoutChange: disposable,
        getPosition: () => ({ lineNumber: 1, column: 1 }),
        setPosition() {},
        saveViewState: () => ({}),
        restoreViewState() {},
        dispose() {},
      }),
    },
    languages: { getLanguages: () => [] },
  } as unknown as typeof Monaco;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Exercise the callback that owns the visible dirty indicator as well as the
// real manager and document snapshot; only Monaco rendering and host IO are fake.
function EditorTab({ session, filePath, onChange, active = true }: {
  session: EditorDocument; filePath: string; onChange?: (content: string) => void; active?: boolean;
}) {
  const [dirty, setDirty] = useState(session.snapshot?.isDirty ?? false);
  return <EditorDocumentContext.Provider value={session}>
    <output data-testid="dirty">{dirty ? 'modified' : 'saved'}</output>
    <CodeEditor filePath={filePath} isActiveTab={active} showBreadcrumb={false} onContentChange={(content, changed) => {
      setDirty(changed);
      onChange?.(content);
    }} />
  </EditorDocumentContext.Provider>;
}

let root: Root;
let container: HTMLDivElement;
let session: EditorDocument;
let serial = 0;
let documents: EditorDocument[];
const path = '/repo/a.txt';
const fileMetadata = { isFile: true, size: 4, modified: 1 };
function model(document = session) { return monacoModelManager.getModel(document.modelKey)!; }
function metadata(document = session) { return monacoModelManager.getModelMetadata(document.modelKey)!; }
async function render(document = session, filePath = path) {
  await act(async () => root.render(<EditorTab session={document} filePath={filePath} />));
  expect(mocks.logError).not.toHaveBeenCalled();
  expect(model(document)).not.toBeNull();
}
async function reloadEncoding(encoding = 'utf16') {
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="encoding"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${encoding}"]`)!.click());
}
function newDocument(filePath = path) {
  const document = new EditorDocument(`sync-${++serial}`, { surfaceId: 'local', workspaceId: 'test-workspace' }, filePath);
  document.capture('disk', false);
  documents.push(document);
  return document;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.clearAllMocks();
  Object.assign(findState, { isRevealed: false, searchString: '', replaceString: '' });
  findListeners.clear();
  activateSurface('local');
  documents = [];
  mocks.read.mockReset().mockResolvedValue('disk');
  mocks.metadata.mockReset().mockResolvedValue(fileMetadata);
  const runtime = createRuntime();
  setMonacoRuntime(runtime);
  mocks.initialize.mockResolvedValue(runtime);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  session = newDocument();
});
afterEach(async () => {
  await act(async () => root.unmount());
  documents.forEach(document => monacoModelManager.releaseDocumentModel(document.modelKey));
  container.remove();
  setMonacoRuntime(null);
  vi.useRealTimers();
});

describe('CodeEditor disk synchronization', () => {
  it('retains find/replace interaction across inactivity and releases only after the query is cleared', async () => {
    await render();
    const originalModel = model();
    const changeFind = async (state: Partial<typeof findState>) => act(async () => {
      Object.assign(findState, state);
      findListeners.forEach(listener => listener());
    });
    await changeFind({ isRevealed: true, searchString: 'workspace' });
    await act(async () => root.render(<EditorTab session={session} filePath={path} active={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(metadata().referenceCount).toBe(1);
    await changeFind({ isRevealed: false });
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(metadata().referenceCount).toBe(1);
    await changeFind({ searchString: '' });
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(metadata().referenceCount).toBe(0);
    expect(model()).toBe(originalModel);
    expect(findListeners.size).toBe(0);
  });

  it('keeps a composing view alive until IME composition ends, even after its tab becomes inactive', async () => {
    await render();
    const originalModel = model();
    const editor = container.querySelector('.code-editor-tool')!;
    await act(async () => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await act(async () => root.render(<EditorTab session={session} filePath={path} active={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(metadata().referenceCount).toBe(1);
    expect(model()).toBe(originalModel);
    await act(async () => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(metadata().referenceCount).toBe(0);
    expect(model()).toBe(originalModel);
  });

  it('sleeps an inactive view while retaining the exact dirty model, and saves before reopening', async () => {
    await render();
    const originalModel = model();
    await act(async () => originalModel.setValue('unsaved edit'));
    await act(async () => root.render(<EditorTab session={session} filePath={path} active={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(metadata().referenceCount).toBe(0);
    expect(model()).toBe(originalModel);
    expect(session.snapshot).toMatchObject({ content: 'unsaved edit', savedContent: 'disk', isDirty: true });
    await act(async () => session.save?.());
    expect(mocks.write).toHaveBeenCalledWith('test-workspace', path, 'unsaved edit');
    expect(session.snapshot?.isDirty).toBe(false);
    await render();
    expect(model()).toBe(originalModel);
    expect(metadata().referenceCount).toBe(1);
    expect(model().getValue()).toBe('unsaved edit');
  });

  it.each(['success', 'failure'])('keeps edits dirty after a delayed metadata %s', async outcome => {
    await render();
    const pendingMetadata = deferred<typeof fileMetadata>();
    mocks.read.mockResolvedValueOnce('decoded');
    mocks.metadata.mockReturnValueOnce(pendingMetadata.promise);
    await reloadEncoding();
    expect(model().getValue()).toBe('decoded');
    expect(metadata().originalContent).toBe('decoded');
    await act(async () => model().setValue('decoded plus user edits'));
    await act(async () => {
      if (outcome === 'success') pendingMetadata.resolve(fileMetadata);
      else pendingMetadata.reject(new Error('offline'));
    });
    expect(metadata().isDirty).toBe(true);
    expect(metadata().originalContent).toBe('decoded');
    expect(session.snapshot).toMatchObject({ content: 'decoded plus user edits', savedContent: 'decoded', isDirty: true });
    expect(container.querySelector('[data-testid="dirty"]')?.textContent).toBe('modified');
    await act(async () => root.render(null));
    await render();
    expect(metadata().isDirty).toBe(true);
  });

  it('discards an encoding read after this view switches to another document', async () => {
    await render();
    const pendingRead = deferred<string>();
    mocks.read.mockReturnValueOnce(pendingRead.promise);
    await reloadEncoding();
    const next = newDocument('/repo/b.txt');
    await render(next, '/repo/b.txt');
    await act(async () => model(next).setValue('B draft'));
    await act(async () => pendingRead.resolve('A decoded'));
    expect(model(next).getValue()).toBe('B draft');
    expect(metadata(next).isDirty).toBe(true);
    expect(model().getValue()).toBe('disk');
    expect(next.snapshot).toMatchObject({ content: 'B draft', savedContent: 'disk', isDirty: true });
  });

  it('keeps the most recent encoding selection when reads finish out of order', async () => {
    await render();
    const older = deferred<string>();
    mocks.read.mockReturnValueOnce(older.promise).mockResolvedValueOnce('Latin-1 decoded');
    await reloadEncoding();
    await reloadEncoding('latin1');
    await act(async () => older.resolve('UTF-16 decoded'));
    expect(model().getValue()).toBe('Latin-1 decoded');
    expect(metadata().originalContent).toBe('Latin-1 decoded');
    expect(container.querySelector('[data-testid="encoding"]')?.textContent).toBe('ISO-8859-1');
  });

  it('does not discard edits made while the encoded content is being read', async () => {
    await render();
    const pendingRead = deferred<string>();
    mocks.read.mockReturnValueOnce(pendingRead.promise);
    await reloadEncoding();
    await act(async () => model().setValue('new draft'));
    await act(async () => pendingRead.resolve('decoded'));
    expect(model().getValue()).toBe('new draft');
    expect(metadata().isDirty).toBe(true);
    expect(container.querySelector('[data-testid="encoding"]')?.textContent).toBe('UTF-8');
  });

  it('ignores an encoding read completed after closing the editor', async () => {
    await render();
    const pendingRead = deferred<string>();
    mocks.read.mockReturnValueOnce(pendingRead.promise);
    await reloadEncoding();
    await act(async () => root.render(null));
    await act(async () => pendingRead.resolve('decoded after close'));
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(session.snapshot).toEqual({ content: 'disk', savedContent: 'disk', isDirty: false });
    await render();
    expect(model().getValue()).toBe('disk');
  });

  it('does not mark a retained document saved when old encoding metadata finishes in another view', async () => {
    await render();
    const pendingMetadata = deferred<typeof fileMetadata>();
    mocks.read.mockResolvedValueOnce('decoded');
    mocks.metadata.mockReturnValueOnce(pendingMetadata.promise);
    await reloadEncoding();
    await act(async () => model().setValue('A draft'));
    const next = newDocument('/repo/b.txt');
    await act(async () => root.render(null));
    await render(next, '/repo/b.txt');
    await act(async () => model(next).setValue('B draft'));
    await act(async () => pendingMetadata.resolve(fileMetadata));
    expect(metadata()).toMatchObject({ originalContent: 'decoded', isDirty: true });
    expect(metadata(next)).toMatchObject({ originalContent: 'disk', isDirty: true });
    expect(model().getValue()).toBe('A draft');
    expect(model(next).getValue()).toBe('B draft');
  });

  it('preserves the origin document when the active device changes during an encoding read', async () => {
    activateSurface('peer-a');
    session = new EditorDocument(`peer-${++serial}`, { surfaceId: 'peer-a', workspaceId: 'peer-workspace' }, path);
    documents.push(session);
    session.capture('peer content', false);
    await render();
    const pendingRead = deferred<string>();
    mocks.read.mockReturnValueOnce(pendingRead.promise);
    await reloadEncoding();
    activateSurface('local');
    await act(async () => pendingRead.resolve('old peer response'));
    expect(model().getValue()).toBe('peer content');
    expect(session.snapshot).toMatchObject({ content: 'peer content', isDirty: false });
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it('persists a disk snapshot before a content callback synchronously removes the view', async () => {
    await act(async () => root.render(<EditorTab session={session} filePath={path} onChange={content => {
      if (content === 'external content') flushSync(() => root.render(null));
    }} />));
    await act(async () => model().setValue('local draft'));
    mocks.read.mockResolvedValueOnce('external content');
    await act(async () => { await globalEventBus.emit('editor:file-changed', { filePath: path }); });
    expect(container.childElementCount).toBe(0);
    expect(session.snapshot).toEqual({ content: 'external content', savedContent: 'external content', isDirty: false });
    await render();
    expect(model().getValue()).toBe('external content');
    expect(metadata().isDirty).toBe(false);
    expect(container.querySelector('[data-testid="dirty"]')?.textContent).toBe('saved');
  });

  it('settles an external reload before remounting and clears the tab indicator', async () => {
    await render();
    await act(async () => model().setValue('local draft'));
    expect(container.querySelector('[data-testid="dirty"]')?.textContent).toBe('modified');
    mocks.read.mockResolvedValueOnce('external content');
    await act(async () => { await globalEventBus.emit('editor:file-changed', { filePath: path }); });
    expect(model().getValue()).toBe('external content');
    expect(metadata()).toMatchObject({ isDirty: false, originalContent: 'external content' });
    expect(session.snapshot).toEqual({ content: 'external content', savedContent: 'external content', isDirty: false });
    expect(container.querySelector('[data-testid="dirty"]')?.textContent).toBe('saved');
    await act(async () => root.render(null));
    await render();
    expect(model().getValue()).toBe('external content');
    expect(metadata().isDirty).toBe(false);
    expect(container.querySelector('[data-testid="dirty"]')?.textContent).toBe('saved');
  });
});
