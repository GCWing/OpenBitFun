// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { EditorDocument, EditorDocumentContext } from '../services/EditorDocument';
import PdfReviewEditor from './PdfReviewEditor';
import { getPdfReviewSession } from './PdfReviewSession';
import { parsePdfReview, type PdfReviewAnnotation } from './pdfReview';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));
vi.mock('../components/PdfViewer', () => ({ default: () => <div data-pdf-viewer /> }));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing review control: ${selector}`);
  await act(async () => button.click());
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
