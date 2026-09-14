// @vitest-environment jsdom
import React, { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownEditor from './MarkdownEditor';
import type { DocumentSnapshot } from '../services/EditorDocument';

const documentMock = vi.hoisted(() => ({
  enabled: false,
  session: {
    id: 'markdown-load-test',
    snapshot: undefined as DocumentSnapshot | undefined,
    files: { readFileContent: vi.fn(), getFileMetadata: vi.fn() },
    isCurrent: vi.fn(() => true),
    capture: vi.fn(),
  },
}));
vi.mock('../services/EditorDocument', () => ({
  useEditorDocument: () => documentMock.enabled ? documentMock.session : null,
}));

vi.mock('../meditor', () => ({
  MEditor: forwardRef((props: { value?: string; mode?: string }, ref) => {
    useImperativeHandle(ref, () => ({
      destroy: vi.fn(),
      markSaved: vi.fn(),
      setInitialContent: vi.fn(),
    }));
    return <div data-testid="markdown-body" data-mode={props.mode} />;
  }),
}));

vi.mock('./CodeEditor', () => ({
  default: () => <div data-testid="code-editor" />,
}));

vi.mock('../meditor/utils/tiptapMarkdown', () => ({
  analyzeMarkdownEditability: (raw: string) => ({
    canonicalMarkdown: raw,
    containsRawHtmlInlines: false,
    containsRenderOnlyBlocks: false,
    mode: 'safe',
  }),
}));

const messages: Record<string, string> = {
  'editor.markdownEditor.copiedMarkdown': 'Copied Markdown',
  'editor.markdownEditor.copyMarkdown': 'Copy Markdown',
  'editor.markdownEditor.notice.sourcePreviewFallback': 'IR fallback warning',
};

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: { defaultValue?: string }) => messages[key] ?? options?.defaultValue ?? key,
  }),
}));

vi.mock('@/infrastructure/appearance', () => ({
  useAppearance: () => ({ current: { mode: 'dark' } }),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('@/shared/utils/debugProbe', () => ({
  sendDebugProbe: vi.fn(),
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: {
    emit: vi.fn(),
    on: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@/infrastructure/confirm-dialog', () => ({
  confirmDialog: vi.fn(),
}));

describe('MarkdownEditor', () => {
  it('renders a compact copy action in the toolbar', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor initialContent="# Deep Review\n\nReady." />,
    );

    expect(html).toContain('aria-label="Copy Markdown"');
    expect(html).toContain('data-openbitfun-component="toolbar"');
    expect(html).toContain('data-openbitfun-component="icon-button"');
  });

  it('opens Mermaid documents in rich text mode', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor initialContent="```mermaid\ngraph TD\n  A-->B\n```" />,
    );

    expect(html).toContain('data-mode="ir"');
  });

  it('offers only rich text and source modes', () => {
    const html = renderToStaticMarkup(
      <MarkdownEditor initialContent="# Ordinary Markdown" />,
    );

    expect(html).toContain('editor.markdownEditor.richText');
    expect(html).toContain('editor.markdownEditor.source');
    expect(html).not.toContain('editor.markdownEditor.preview');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
  });
});

describe('MarkdownEditor file load recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  const filePath = '/external/home/123.md';
  const read = documentMock.session.files.readFileContent;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    documentMock.enabled = true;
    documentMock.session.snapshot = undefined;
    documentMock.session.isCurrent.mockReturnValue(true);
    // Unexpected reads stay pending so a regression fails instead of hanging.
    read.mockReset().mockImplementation(() => new Promise<string>(() => {}));
    documentMock.session.files.getFileMetadata.mockReset().mockRejectedValue(new Error('File does not exist'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    documentMock.enabled = false;
    vi.useRealTimers();
  });

  it('keeps a missing file error stable through rerenders and disk polling', async () => {
    read.mockRejectedValueOnce(new Error('File does not exist'));
    const reportMissing = vi.fn();
    await act(async () => root.render(<MarkdownEditor filePath={filePath} onFileMissingFromDiskChange={reportMissing} />));
    expect(read).toHaveBeenCalledTimes(1);
    expect(reportMissing).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain('editor.common.fileNotFound');
    expect(container.textContent).not.toContain('editor.markdownEditor.loadingFile');

    await act(async () => root.render(<MarkdownEditor filePath={filePath} onFileMissingFromDiskChange={vi.fn()} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('editor.common.retry');
  });

  it('retries once on tab reactivation and keeps subsequent failures stable', async () => {
    read.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<MarkdownEditor filePath={filePath} />));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<MarkdownEditor filePath={filePath} isActiveTab={false} />));
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<MarkdownEditor filePath={filePath} isActiveTab />));
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('editor.common.loadFailed');
  });

  it('allows manual retry to recover when the file becomes readable', async () => {
    read.mockRejectedValueOnce(new Error('File does not exist'));
    const reportMissing = vi.fn();
    await act(async () => root.render(<MarkdownEditor filePath={filePath} onFileMissingFromDiskChange={reportMissing} />));
    read.mockResolvedValueOnce('# Recovered');
    documentMock.session.files.getFileMetadata.mockResolvedValue({ isFile: true });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(read).toHaveBeenCalledTimes(2);
    expect(reportMissing).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('[data-testid="markdown-body"]')).not.toBeNull();
    expect(container.textContent).not.toContain('editor.common.retry');
  });

  it('does not retry on an inactive device', async () => {
    read.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<MarkdownEditor filePath={filePath} />));
    await act(async () => root.render(<MarkdownEditor filePath={filePath} isActiveTab={false} />));
    documentMock.session.isCurrent.mockReturnValue(false);
    await act(async () => root.render(<MarkdownEditor filePath={filePath} isActiveTab />));
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('editor.common.loadFailed');
  });
});
