import type { EditorDocument } from '../services/EditorDocument';
import { isFileMissingFromMetadata, isLikelyFileNotFoundError } from '@/shared/utils/fsErrorUtils';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { uploadBytesToHost } from '@/infrastructure/files/controllerFiles';
import { annotatedPdfPath, decodePdfBytes, emptyPdfReview, exportReviewedPdf, parsePdfReview,
  pdfBytesHash, reviewSidecarPath, type PdfReviewAnnotation, type PdfReviewData } from './pdfReview';

export class PdfReviewExportConflict extends Error {
  constructor(readonly path: string, readonly expectedHash: string) { super('The PDF destination already exists or has changed.'); }
}
/** Another writer changed the review file; unsaved notes wait for an explicit choice. */
export class PdfReviewConflictError extends Error {
  constructor() {
    super('The review file changed on the workspace host. Existing notes have been preserved.');
    this.name = 'PdfReviewConflictError';
  }
}
// Both execution hosts report a failed compare-and-swap with this prefix; nothing was written.
const isWriteConflict = (error: unknown) => String(error).includes('FILE_CONFLICT');
export interface PdfReviewSnapshot {
  data: PdfReviewData;
  loaded: boolean;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  /** Writes pause until the user keeps local notes or reloads the host file. */
  conflict: boolean;
  error?: string;
  canUndo: boolean;
  canRedo: boolean;
}
/** One owner per EditorDocument; hiding a pane never loses history or pending writes. */
export class PdfReviewSession {
  private snapshot: PdfReviewSnapshot = {
    data: emptyPdfReview(), loaded: false, readOnly: false, dirty: false, saving: false, conflict: false, canUndo: false, canRedo: false,
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
    // Sessions outlive their pane, including ones for an abandoned main-file path. Save All
    // owes a write only for notes changed here, so an unused path cannot block it.
    document.registerSaveParticipant(`pdf-review:${sourcePath}`,
      () => (this.snapshot.dirty || this.writing ? this.save() : Promise.resolve()));
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
  /**
   * The review keeps the fingerprint of the build its notes were placed on. Edits and
   * PDF saves never move it; only this confirmation clears the recompiled-layout warning.
   */
  confirmCurrentLayout() {
    if (!this.snapshot.loaded || this.blocked || !this.document.isCurrent() || !this.currentFingerprint
      || this.snapshot.data.fingerprint === this.currentFingerprint) return;
    this.revision++;
    this.publish({ data: { ...this.snapshot.data, fingerprint: this.currentFingerprint }, dirty: true, error: undefined });
    void this.save().catch(() => undefined);
  }
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
    if (this.snapshot.conflict) throw new PdfReviewConflictError();
    if (this.writing) return this.writing;
    if (!this.snapshot.dirty) return;
    this.writing = (async () => {
      try {
        this.publish({ saving: true, error: undefined });
        // A lost response can follow a successful write. Reconcile only that
        // known attempt before retrying; unrelated changes become a conflict.
        if (this.lastAttemptedContent !== undefined) {
          const disk = await this.readSidecar();
          if (disk.content === this.lastAttemptedContent) this.expectedHash = disk.hash;
          else if (disk.hash !== this.expectedHash) throw this.enterConflict();
          this.lastAttemptedContent = undefined;
        }
        while (this.snapshot.dirty) {
          const revision = this.revision;
          // The first notes are placed on the current build; later builds need confirmCurrentLayout.
          const data = { ...this.snapshot.data, fingerprint: this.snapshot.data.fingerprint || this.currentFingerprint };
          const content = JSON.stringify(data, null, 2) + '\n';
          this.lastAttemptedContent = content;
          try {
            await this.document.invoke('write_file_content', { request: {
              filePath: reviewSidecarPath(this.sourcePath), content, expectedHash: this.expectedHash,
            } });
          } catch (error) {
            if (!isWriteConflict(error)) throw error;
            this.lastAttemptedContent = undefined;
            throw this.enterConflict();
          }
          this.expectedHash = await pdfBytesHash(new TextEncoder().encode(content));
          this.lastAttemptedContent = undefined;
          this.publish({ dirty: this.revision !== revision, data: { ...this.snapshot.data, fingerprint: data.fingerprint } });
        }
      } catch (error) {
        if (!(error instanceof PdfReviewConflictError)) this.publish({ error: String(error) });
        throw error;
      } finally {
        this.writing = undefined;
        this.publish({ saving: false });
      }
    })();
    return this.writing;
  }
  /** Explicitly replace the changed review file with the notes held in this window. */
  async keepLocalChanges(): Promise<void> {
    if (!this.snapshot.conflict || !this.document.isCurrent()) return;
    const disk = await this.readSidecar();
    this.expectedHash = disk.hash;
    this.lastAttemptedContent = undefined;
    this.revision++;
    this.publish({ conflict: false, dirty: true, error: undefined });
    await this.save();
  }
  /** Explicitly load the changed review file; Undo restores the notes it replaced. */
  async reloadFromHost(): Promise<void> {
    if (!this.snapshot.conflict || !this.document.isCurrent()) return;
    const disk = await this.readSidecar();
    const data = disk.content === undefined ? emptyPdfReview() : parsePdfReview(disk.content);
    this.past.push(this.snapshot.data.annotations);
    this.future = [];
    this.expectedHash = disk.hash;
    this.lastAttemptedContent = undefined;
    this.revision++;
    this.publish({ data, dirty: false, conflict: false, error: undefined });
  }
  private enterConflict(): PdfReviewConflictError {
    this.publish({ conflict: true });
    return new PdfReviewConflictError();
  }
  private async readSidecar(): Promise<{ content?: string; hash: string }> {
    try {
      const content = await this.document.files.readFileContent(reviewSidecarPath(this.sourcePath));
      return { content, hash: await pdfBytesHash(new TextEncoder().encode(content)) };
    } catch (error) {
      if (isLikelyFileNotFoundError(error)) return { hash: '' };
      throw error;
    }
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
