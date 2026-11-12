// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { EditorDocument, EditorDocumentContext } from '../services/EditorDocument';
import PdfReviewEditor from './PdfReviewEditor';
import { getPdfReviewSession } from './PdfReviewSession';
import { parsePdfReview, type PdfReviewAnnotation } from './pdfReview';
import { encryptedPdf } from './pdfReview.test-support';

const viewer = vi.hoisted(() => ({ pdf: undefined as unknown }));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));
vi.mock('../components/PdfViewer', async () => {
  const { useEffect } = await import('react');
  return { default: ({ onDocumentLoaded }: { onDocumentLoaded?: (pdf: unknown) => void }) => {
    useEffect(() => { if (viewer.pdf) onDocumentLoaded?.(viewer.pdf); }, []);
    return <div data-pdf-viewer />;
  } };
});

let container: HTMLDivElement;
let root: Root;
let document: EditorDocument;
const path = '/paper/main.tex';
const note = (id: string): PdfReviewAnnotation => ({
  id, kind: 'note', page: 1, rect: [20, 30, 40, 50], color: 'yellow',
  createdAt: '2026-11-11T03:00:00.000Z',
  comments: [{ id: `${id}-comment`, body: `Original ${id}`, createdAt: '2026-11-11T03:00:00.000Z' }],
});

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('crypto', webcrypto);
  activateSurface('local');
  container = globalThis.document.createElement('div');
  globalThis.document.body.append(container);
  root = createRoot(container);
  document = new EditorDocument('review-comments', { surfaceId: 'local', workspaceId: 'workspace-a' }, path);
  vi.spyOn(document.files, 'getFileMetadata').mockRejectedValue(new Error('ENOENT: no such file'));
  vi.spyOn(document, 'invoke').mockResolvedValue(undefined);
  const session = getPdfReviewSession(document, path);
  await session.load();
  session.replace([note('first'), note('second')]);
  await session.save();
  await act(async () => root.render(<EditorDocumentContext.Provider value={document}>
    <PdfReviewEditor filePath={path} />
  </EditorDocumentContext.Provider>));
  await click('[aria-label="editor.pdfReview.comments"]');
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  viewer.pdf = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing review control: ${selector}`);
  await act(async () => button.click());
}
function buttonWithText(text: string) {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  if (!button) throw new Error(`Missing review control: ${text}`);
  return button;
}
/** Asynchronous PDF inspection and host writes settle outside the triggering event. */
async function waitUntil(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(condition()).toBe(true);
}
async function openLoadedPdf(bytes: Uint8Array, fingerprint = 'compiled-b') {
  viewer.pdf = { fingerprints: [fingerprint], getData: async () => bytes.slice() };
  await act(async () => root.render(null));
  await act(async () => root.render(<EditorDocumentContext.Provider value={document}>
    <PdfReviewEditor filePath={path} />
  </EditorDocumentContext.Provider>));
}
const thread = (index: number) => `.pdf-review-editor__thread:nth-child(${index})`;
async function writeDraft(value: string) {
  const field = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const comments = (index: number) => getPdfReviewSession(document, path).getSnapshot().data.annotations[index]!.comments;

it('retains a reply and an edited comment when reselecting the same thread', async () => {
  await click(`${thread(1)} .pdf-review-editor__thread-title`);
  await writeDraft('Reply under review');
  await click(`${thread(1)} .pdf-review-editor__thread-title`);
  expect(container.querySelector('textarea')?.value).toBe('Reply under review');
  await act(async () => document.saveAll());
  expect(comments(0).map(comment => comment.body)).toEqual(['Original first', 'Reply under review']);

  await click(`${thread(1)} [aria-label="editor.pdfReview.editComment"]`);
  await writeDraft('Revised original comment');
  await click(`${thread(1)} .pdf-review-editor__thread-title`);
  expect(container.querySelector('textarea')?.value).toBe('Revised original comment');
  await act(async () => document.saveAll());
  expect(comments(0).map(comment => comment.body)).toEqual(['Revised original comment', 'Reply under review']);
});

it('commits the previous thread draft before selecting another thread', async () => {
  await click(`${thread(1)} .pdf-review-editor__thread-title`);
  await writeDraft('Reply to the first note');
  await click(`${thread(2)} .pdf-review-editor__thread-title`);
  expect(comments(0).map(comment => comment.body)).toEqual(['Original first', 'Reply to the first note']);
  expect(container.querySelector('textarea')?.value).toBe('');
  await writeDraft('Reply to the second note');
  await act(async () => document.saveAll());
  expect(comments(1).map(comment => comment.body)).toEqual(['Original second', 'Reply to the second note']);
});

it('starts a new reply after leaving an empty comment edit on another thread', async () => {
  await click(`${thread(1)} [aria-label="editor.pdfReview.editComment"]`);
  await writeDraft('');
  await click(`${thread(2)} .pdf-review-editor__thread-title`);
  await writeDraft('Reply after an empty edit');
  await act(async () => document.saveAll());
  expect(comments(0).map(comment => comment.body)).toEqual(['Original first']);
  expect(comments(1).map(comment => comment.body)).toEqual(['Original second', 'Reply after an empty edit']);
});

it('commits pending replies and edits before editing a different comment in the same thread', async () => {
  await click(`${thread(1)} .pdf-review-editor__thread-title`);
  await writeDraft('Reply before editing');
  await click(`${thread(1)} [aria-label="editor.pdfReview.editComment"]`);
  expect(comments(0).map(comment => comment.body)).toEqual(['Original first', 'Reply before editing']);
  await writeDraft('Updated first comment');
  await click(`${thread(1)} .pdf-review-editor__comment:nth-child(3) [aria-label="editor.pdfReview.editComment"]`);
  expect(comments(0)[0]!.body).toBe('Updated first comment');
  await writeDraft('Updated second comment');
  await act(async () => document.saveAll());
  expect(comments(0).map(comment => comment.body)).toEqual(['Updated first comment', 'Updated second comment']);
});

it('preserves an in-progress edit when its edit control is clicked again', async () => {
  await click(`${thread(1)} [aria-label="editor.pdfReview.editComment"]`);
  await writeDraft('In-progress revision');
  await click(`${thread(1)} [aria-label="editor.pdfReview.editComment"]`);
  expect(container.querySelector('textarea')?.value).toBe('In-progress revision');
  await act(async () => document.saveAll());
  expect(comments(0)[0]!.body).toBe('In-progress revision');
});

it('keeps a collapsed comment draft and includes it in document Save All', async () => {
  await click(`${thread(1)} .pdf-review-editor__thread-title`);
  await writeDraft('Pending reply while the comments are closed');
  await click('[aria-label="editor.pdfReview.closeComments"]');
  expect(container.querySelector('textarea')).toBeNull();
  await click('[aria-label="editor.pdfReview.comments"]');
  expect(container.querySelector('textarea')?.value).toBe('Pending reply while the comments are closed');
  await click('[aria-label="editor.pdfReview.closeComments"]');
  await act(async () => document.saveAll());
  const writes = vi.mocked(document.invoke).mock.calls;
  const content = writes[writes.length - 1]![1].request.content as string;
  expect(parsePdfReview(content).annotations[0]!.comments.at(-1)?.body).toBe('Pending reply while the comments are closed');
});

it('keeps an encrypted PDF reviewable without offering a broken annotated copy', async () => {
  await openLoadedPdf(await encryptedPdf());
  await waitUntil(() => container.textContent?.includes('editor.pdfReview.encrypted') ?? false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(buttonWithText('editor.pdfReview.savePdf').disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="editor.pdfReview.export"]')?.disabled).toBe(true);
});

it('keeps the recompiled-layout notice until the user confirms the positions', async () => {
  const session = getPdfReviewSession(document, path);
  session.setFingerprint('compiled-a');
  session.replace([...session.getSnapshot().data.annotations, note('third')]);
  await session.save();
  const pdf = await PDFDocument.create(); pdf.addPage();
  await openLoadedPdf(await pdf.save(), 'compiled-b');
  await waitUntil(() => container.textContent?.includes('editor.pdfReview.recompiled') ?? false);
  await act(async () => buttonWithText('editor.pdfReview.confirmLayout').click());
  await waitUntil(() => !container.textContent?.includes('editor.pdfReview.recompiled'));
  expect(session.getSnapshot().data.fingerprint).toBe('compiled-b');
});

it('asks which notes to keep after the review file changes on the host', async () => {
  const session = getPdfReviewSession(document, path);
  const theirs = JSON.stringify({ version: 1, fingerprint: '', annotations: [note('theirs')] }, null, 2) + '\n';
  vi.spyOn(document.files, 'readFileContent').mockResolvedValue(theirs);
  vi.mocked(document.invoke).mockRejectedValueOnce(new Error('FILE_CONFLICT: File changed after it was read; refresh before saving'));
  await act(async () => {
    session.replace([note('mine')]);
    await session.save().catch(() => undefined);
  });
  expect(container.textContent).toContain('editor.pdfReview.conflict');
  expect(container.textContent).not.toContain('editor.common.retry');
  await act(async () => buttonWithText('editor.pdfReview.keepMine').click());
  await waitUntil(() => !container.textContent?.includes('editor.pdfReview.conflict'));
  const writes = vi.mocked(document.invoke).mock.calls;
  expect(parsePdfReview(writes.at(-1)![1].request.content as string).annotations.map(item => item.id)).toEqual(['mine']);
});

it('does not fail document Save All for an unreadable review file without edits', async () => {
  const blocked = new EditorDocument('review-blocked', { surfaceId: 'local', workspaceId: 'workspace-a' }, path);
  vi.spyOn(blocked.files, 'getFileMetadata').mockRejectedValue(new Error('Permission denied'));
  const write = vi.spyOn(blocked, 'invoke').mockResolvedValue(undefined);
  await act(async () => root.render(<EditorDocumentContext.Provider value={blocked}>
    <PdfReviewEditor filePath={path} />
  </EditorDocumentContext.Provider>));
  await act(async () => { await getPdfReviewSession(blocked, path).load(); });
  expect(getPdfReviewSession(blocked, path).getSnapshot().readOnly).toBe(true);
  await expect(blocked.saveAll()).resolves.toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});
