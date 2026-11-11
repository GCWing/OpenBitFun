// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorDocument } from '../services/EditorDocument';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { PdfReviewSession, PdfReviewExportConflict } from './PdfReviewSession';
import { PDFDocument } from 'pdf-lib';
export function note(id = 'note-1'): PdfReviewAnnotation {
  return { id, kind: 'note', page: 1, rect: [20, 30, 40, 50], color: 'yellow',
    createdAt: '2026-11-11T03:00:00.000Z', comments: [{ id: 'comment-1', body: '检查公式 ΔE = mc²', createdAt: '2026-11-11T03:00:00.000Z' }] };
}

import { parsePdfReview, pdfBytesHash, type PdfReviewAnnotation } from './pdfReview';

const upload = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/files/controllerFiles', () => ({ uploadBytesToHost: upload }));

beforeEach(() => { upload.mockReset().mockResolvedValue(undefined); vi.stubGlobal('crypto', webcrypto); activateSurface('local'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); activateSurface('local'); });
function createSession() {
  const document = new EditorDocument('review', { surfaceId: 'local', workspaceId: 'workspace-a' }, '/paper/main.tex');
  vi.spyOn(document.files, 'getFileMetadata').mockRejectedValue(new Error('ENOENT: no such file'));
  const write = vi.spyOn(document, 'invoke').mockResolvedValue(undefined);
  return { document, session: new PdfReviewSession(document, '/paper/main.tex'), write };
}
it('serializes overlapping saves and waits for the newest revision with compare-and-swap hashes', async () => {
  const { session, write } = createSession();
  await session.load();
  let finish!: () => void;
  write.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  session.replace([note('first')]);
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  session.replace([note('first'), note('second')]);
  finish();
  await session.save();
  expect(write).toHaveBeenCalledTimes(2);
  const firstRequest = write.mock.calls[0]![1].request;
  const secondRequest = write.mock.calls[1]![1].request;
  expect(firstRequest.expectedHash).toBe('');
  expect(secondRequest.expectedHash).toBe(await pdfBytesHash(new TextEncoder().encode(firstRequest.content as string)));
  expect(parsePdfReview(secondRequest.content as string).annotations).toHaveLength(2);
  expect(session.getSnapshot()).toMatchObject({ dirty: false, saving: false });
});
it('keeps an unreadable sidecar intact and prevents replacing it with a blank review', async () => {
  const { document, session, write } = createSession();
  vi.mocked(document.files.getFileMetadata).mockResolvedValue({ isFile: true, isDir: false, path: '', size: 10, modified: 1 });
  vi.spyOn(document.files, 'readFileContent').mockResolvedValue('{ damaged');
  await session.load();
  session.replace([note()]);
  await expect(session.save()).rejects.toThrow();
  expect(session.getSnapshot()).toMatchObject({ readOnly: true, loaded: true });
  expect(write).not.toHaveBeenCalled();
});
it('reopens persisted annotations and preserves undo/redo through subsequent saves', async () => {
  const first = createSession(); await first.session.load();
  first.session.setFingerprint('compiled-a');
  first.session.replace([note()]); await first.session.save();
  const saved = first.write.mock.calls[0]![1].request.content as string;
  const reopened = createSession();
  vi.mocked(reopened.document.files.getFileMetadata).mockResolvedValue({ isFile: true, isDir: false, path: '', size: saved.length, modified: 1 });
  vi.spyOn(reopened.document.files, 'readFileContent').mockResolvedValue(saved);
  await reopened.session.load();
  expect(reopened.session.getSnapshot().data.annotations).toEqual([note()]);
  reopened.session.replace([]); await reopened.session.save();
  reopened.session.undo(); await reopened.session.save();
  expect(reopened.session.getSnapshot().data.annotations).toHaveLength(1);
  reopened.session.redo(); await reopened.session.save();
  expect(reopened.session.getSnapshot().data.annotations).toHaveLength(0);
});
it('keeps failed writes dirty and does not enqueue saves on a different device', async () => {
  const { session, write } = createSession(); await session.load();
  write.mockRejectedValue(new Error('The file changed on the workspace host'));
  session.replace([note()]);
  await expect(session.save()).rejects.toThrow('file changed');
  expect(session.getSnapshot().dirty).toBe(true);
  const calls = write.mock.calls.length;
  activateSurface('peer-b');
  session.replace([]);
  expect(session.getSnapshot().data.annotations).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(calls);
});
it('participates in document Save All even when there is no source editor', async () => {
  const { document, session, write } = createSession(); await session.load();
  session.replace([note()]); await document.saveAll();
  expect(write).toHaveBeenCalled(); expect(session.getSnapshot().dirty).toBe(false);
});

it('recovers an acknowledged-on-host write after losing its response without overwriting another version', async () => {
  const { document, session, write } = createSession(); await session.load();
  let disk = '';
  vi.spyOn(document.files, 'readFileContent').mockImplementation(async () => disk);
  write.mockImplementationOnce(async (_command, args) => { disk = args.request.content as string; throw new Error('Connection lost after write'); });
  session.replace([note()]);
  await expect(session.save()).rejects.toThrow('Connection lost');
  await session.save();
  expect(session.getSnapshot().dirty).toBe(false);
  expect(write.mock.calls[1]![1].request.expectedHash).toBe(await pdfBytesHash(new TextEncoder().encode(disk)));
});

it('requires an exact approved version before replacing a pre-existing annotated PDF', async () => {
  const { document, session } = createSession(); await session.load();
  const original = await PDFDocument.create(); original.addPage();
  const bytes = await original.save();
  vi.mocked(document.files.getFileMetadata).mockResolvedValue({ path: '', size: bytes.length, modified: 1, isFile: true, isDir: false });
  vi.spyOn(document.files, 'readFileContent').mockResolvedValue(Buffer.from(bytes).toString('base64'));
  await expect(session.savePdf(bytes)).rejects.toBeInstanceOf(PdfReviewExportConflict);
  expect(upload).not.toHaveBeenCalled();
  const expectedHash = await pdfBytesHash(bytes);
  await session.savePdf(bytes, expectedHash);
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({ path: '/paper/main.annotated.pdf', workspaceId: 'workspace-a', expectedHash }));
});
