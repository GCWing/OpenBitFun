import type { EditorDocument } from '../services/EditorDocument';
import { isFileMissingFromMetadata, isLikelyFileNotFoundError } from '@/shared/utils/fsErrorUtils';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { uploadBytesToHost } from '@/infrastructure/files/controllerFiles';
import { annotatedPdfPath, decodePdfBytes, emptyPdfReview, exportReviewedPdf, parsePdfReview,
  pdfBytesHash, reviewSidecarPath, type PdfReviewAnnotation, type PdfReviewData } from './pdfReview';

export class PdfReviewExportConflict extends Error {
  constructor(readonly path: string, readonly expectedHash: string) { super('The PDF destination already exists or has changed.'); }
}
export interface PdfReviewSnapshot {
  data: PdfReviewData;
  loaded: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  error?: string;
  canUndo: boolean;
  canRedo: boolean;
}
/** One owner per EditorDocument; hiding a pane never loses history or pending writes. */
export class PdfReviewSession {
  private snapshot: PdfReviewSnapshot = {
    data: emptyPdfReview(), loaded: false, readOnly: false, dirty: false, saving: false, canUndo: false, canRedo: false,
  };
  private listeners = new Set<() => void>();
  private past: PdfReviewAnnotation[][] = [];
  private future: PdfReviewAnnotation[][] = [];
  private expectedHash = '';
  private lastAttemptedContent?: string;
  private revision = 0;
  private loading?: Promise<void>;
  private writing?: Promise<void>;
  private blocked = false;
  private currentFingerprint = '';
  private exportedHash?: string;
  constructor(readonly document: EditorDocument, readonly sourcePath: string) {
    document.registerSaveParticipant(`pdf-review:${sourcePath}`, () => this.save());
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = () => this.snapshot;
  private publish(patch: Partial<PdfReviewSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch, canUndo: this.past.length > 0, canRedo: this.future.length > 0 };
    for (const listener of this.listeners) listener();
  }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const path = reviewSidecarPath(this.sourcePath);
        const metadata = await this.document.files.getFileMetadata(path);
        if (!isFileMissingFromMetadata(metadata)) {
          const text = await this.document.files.readFileContent(path);
          const data = parsePdfReview(text);
          this.expectedHash = await pdfBytesHash(new TextEncoder().encode(text));
          this.publish({ data });
        }
        this.publish({ loaded: true });
      } catch (error) {
        if (isLikelyFileNotFoundError(error)) this.publish({ loaded: true });
        else {
          this.blocked = true;
          this.publish({ loaded: true, readOnly: true, error: String(error) });
        }
      }
    })();
  }
  retry(): Promise<void> {
    if (!this.blocked) return this.save();
    this.loading = undefined;
    this.blocked = false;
    this.publish({ loaded: false, readOnly: false, error: undefined });
    return this.load();
  }
  importEmbedded(data: PdfReviewData) {
    if (this.expectedHash || this.snapshot.dirty || this.snapshot.data.annotations.length || this.blocked) return;
    this.publish({ data });
  }
  setFingerprint(fingerprint: string) { this.currentFingerprint = fingerprint; }
  replace(annotations: PdfReviewAnnotation[]) {
    if (!this.snapshot.loaded || this.blocked || !this.document.isCurrent()) return;
    this.past.push(this.snapshot.data.annotations);
    this.future = [];
    this.apply(annotations);
  }
  private apply(annotations: PdfReviewAnnotation[]) {
    this.revision++;
    this.publish({ data: { ...this.snapshot.data, annotations }, dirty: true, error: undefined });
    void this.save().catch(() => undefined);
  }
  undo() {
    if (this.blocked || !this.document.isCurrent()) return;
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.snapshot.data.annotations);
    this.apply(previous);
  }
  redo() {
    if (this.blocked || !this.document.isCurrent()) return;
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot.data.annotations);
    this.apply(next);
  }
  async save(): Promise<void> {
    await this.load();
    if (this.blocked) throw new Error(this.snapshot.error);
    if (this.writing) return this.writing;
    if (!this.snapshot.dirty) return;
    this.writing = (async () => {
      try {
        this.publish({ saving: true, error: undefined });
        // A lost response can follow a successful write. Reconcile only that
        // known attempt before retrying; unrelated changes remain conflicts.
        if (this.lastAttemptedContent !== undefined) {
          let existing = '';
          try { existing = await this.document.files.readFileContent(reviewSidecarPath(this.sourcePath)); }
          catch (failure) { if (!isLikelyFileNotFoundError(failure)) throw failure; }
          const hash = existing ? await pdfBytesHash(new TextEncoder().encode(existing)) : '';
          if (existing === this.lastAttemptedContent) this.expectedHash = hash;
          else if (hash !== this.expectedHash) throw new Error('The review file changed on the workspace host. Existing notes have been preserved.');
          this.lastAttemptedContent = undefined;
        }
        while (this.snapshot.dirty) {
          const revision = this.revision;
          const data = { ...this.snapshot.data, fingerprint: this.currentFingerprint || this.snapshot.data.fingerprint };
          const content = JSON.stringify(data, null, 2) + '\n';
          this.lastAttemptedContent = content;
          await this.document.invoke('write_file_content', { request: {
            filePath: reviewSidecarPath(this.sourcePath), content, expectedHash: this.expectedHash,
          } });
          this.expectedHash = await pdfBytesHash(new TextEncoder().encode(content));
          this.lastAttemptedContent = undefined;
          this.publish({ dirty: this.revision !== revision, data: { ...this.snapshot.data, fingerprint: data.fingerprint } });
        }
      } catch (error) {
        this.publish({ error: String(error) });
        throw error;
      } finally {
        this.writing = undefined;
        this.publish({ saving: false });
      }
    })();
    return this.writing;
  }
  async exportPdf(base: Uint8Array): Promise<{ bytes: Uint8Array; path: string }> {
    await this.load();
    if (this.blocked) throw new Error(this.snapshot.error);
    const bytes = await exportReviewedPdf(base, this.snapshot.data);
    return { bytes, path: annotatedPdfPath(this.sourcePath) };
  }
  async observePdfBytes(bytes: Uint8Array): Promise<void> {
    if (this.exportedHash === undefined && annotatedPdfPath(this.sourcePath) === this.sourcePath) this.exportedHash = await pdfBytesHash(bytes);
  }
  async savePdf(base: Uint8Array, overwriteHash?: string): Promise<string> {
    const scope = getActiveSurfaceScope();
    if (this.currentFingerprint && this.snapshot.data.annotations.length
      && this.snapshot.data.fingerprint !== this.currentFingerprint && !this.blocked) {
      this.revision++;
      this.publish({ dirty: true, data: { ...this.snapshot.data, fingerprint: this.currentFingerprint } });
    }
    await this.save();
    if (!this.document.isCurrent() || !this.document.scope.workspaceId) throw new Error('The PDF workspace is unavailable.');
    const { bytes, path } = await this.exportPdf(base);
    scope.assertCurrent('save annotated PDF');
    let expectedHash = '';
    try {
      const metadata = await this.document.files.getFileMetadata(path);
      if (!isFileMissingFromMetadata(metadata)) {
        expectedHash = await pdfBytesHash(decodePdfBytes(await this.document.files.readFileContent(path, 'base64')));
      }
    } catch (error) {
      if (!isLikelyFileNotFoundError(error)) throw error;
    }
    const approvedHash = overwriteHash ?? this.exportedHash ?? '';
    if (expectedHash !== approvedHash) throw new PdfReviewExportConflict(path, expectedHash);
    await uploadBytesToHost({ bytes, path, workspaceId: this.document.scope.workspaceId, expectedHash,
      assertCurrent: () => scope.assertCurrent('save annotated PDF') });
    this.exportedHash = await pdfBytesHash(bytes);
    return path;
  }
}
const sessions = new WeakMap<EditorDocument, Map<string, PdfReviewSession>>();
export function getPdfReviewSession(document: EditorDocument, path: string): PdfReviewSession {
  let owned = sessions.get(document);
  if (!owned) { owned = new Map(); sessions.set(document, owned); }
  let session = owned.get(path);
  if (!session) { session = new PdfReviewSession(document, path); owned.set(path, session); }
  return session;
}
