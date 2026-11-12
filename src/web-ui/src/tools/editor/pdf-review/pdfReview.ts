/** Portable review data. Coordinates use unrotated PDF user space, never screen pixels. */
export type PdfReviewTool = 'select' | 'highlight' | 'note' | 'ink';
export type PdfReviewColor = 'yellow' | 'green' | 'blue' | 'pink';
export type PdfRect = [number, number, number, number];
export interface PdfReviewComment { id: string; body: string; createdAt: string }
export interface PdfReviewAnnotation {
  id: string;
  kind: Exclude<PdfReviewTool, 'select'>;
  page: number;
  rect: PdfRect;
  color: PdfReviewColor;
  quote?: string;
  quads?: number[];
  strokes?: number[][];
  comments: PdfReviewComment[];
  resolved?: boolean;
  createdAt: string;
  [key: string]: unknown;
}
export interface PdfReviewData {
  version: 1;
  fingerprint: string;
  annotations: PdfReviewAnnotation[];
  [key: string]: unknown;
}
/** These are document ink values, independent of the application theme. */
export const PDF_REVIEW_INK: Record<PdfReviewColor, [number, number, number]> = {
  yellow: [1, 0.82, 0.16], green: [0.27, 0.7, 0.36], blue: [0.22, 0.52, 0.95], pink: [0.91, 0.34, 0.55],
};
export const emptyPdfReview = (): PdfReviewData => ({ version: 1, fingerprint: '', annotations: [] });
export function parsePdfReview(text: string): PdfReviewData {
  const data = JSON.parse(text) as PdfReviewData;
  if (data?.version !== 1 || typeof data.fingerprint !== 'string' || !Array.isArray(data.annotations)) {
    throw new Error('Unsupported PDF review format. The existing file has been preserved.');
  }
  const ids = new Set<string>();
  for (const item of data.annotations) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id)
      || !['highlight', 'note', 'ink'].includes(item.kind) || !Number.isSafeInteger(item.page) || item.page < 1
      || !Array.isArray(item.rect) || item.rect.length !== 4 || !item.rect.every(Number.isFinite)
      || !Object.prototype.hasOwnProperty.call(PDF_REVIEW_INK, item.color) || typeof item.createdAt !== 'string' || !Array.isArray(item.comments)
      || (item.quote !== undefined && typeof item.quote !== 'string')
      || item.comments.some(comment => !comment || typeof comment.id !== 'string'
        || typeof comment.body !== 'string' || typeof comment.createdAt !== 'string')
      || (item.quads !== undefined && (!Array.isArray(item.quads) || item.quads.length % 8 !== 0 || !item.quads.every(Number.isFinite)))
      || (item.strokes !== undefined && (!Array.isArray(item.strokes)
        || item.strokes.some(stroke => !Array.isArray(stroke) || stroke.length < 4 || stroke.length % 2 !== 0 || !stroke.every(Number.isFinite))))) {
      throw new Error('Invalid PDF review data. The existing file has been preserved.');
    }
    ids.add(item.id);
  }
  return data;
}
export function pdfBounds(points: number[]): PdfRect {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export function reviewSidecarPath(path: string): string { return `${path}.openbitfun-review.json`; }
export function annotatedPdfPath(path: string): string { return path.replace(/\.(tex|pdf)$/i, '').replace(/\.annotated$/i, '') + '.annotated.pdf'; }
export function decodePdfBytes(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}
export async function pdfBytesHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** pdf-lib can neither decrypt existing strings nor encrypt the objects it adds. */
export class PdfReviewEncryptedError extends Error {
  constructor() {
    super('An annotated copy cannot be written into an encrypted PDF.');
    this.name = 'PdfReviewEncryptedError';
  }
}
export interface PdfReviewSource {
  /** Viewing and sidecar notes still work; only annotated copies are unavailable. */
  encrypted: boolean;
  embedded?: { data: PdfReviewData; bytes: Uint8Array };
}
// Our exports are never encrypted. pdf-lib keeps the original /Encrypt entry when it
// saves, so readers would "decrypt" every string it adds into garbage.
async function loadPdf(bytes: Uint8Array) {
  const lib = await import('pdf-lib');
  return { lib, pdf: await lib.PDFDocument.load(bytes, { ignoreEncryption: true }) };
}

/** Write standard editable PDF annotations, including Unicode popup comments and replies. */
export async function exportReviewedPdf(base: Uint8Array, review: PdfReviewData): Promise<Uint8Array> {
  const { lib: { PDFName, PDFHexString }, pdf } = await loadPdf(base);
  if (pdf.isEncrypted) throw new PdfReviewEncryptedError();
  const pages = pdf.getPages();
  if (review.annotations.some(annotation => annotation.page > pages.length)) {
    throw new Error('Some review pages no longer exist. Reposition or remove those annotations before exporting.');
  }
  const context = pdf.context;
  removeOwnedAnnotations(pdf, PDFName);
  pdf.catalog.set(PDFName.of('OpenBitFunReview'), PDFHexString.fromText(JSON.stringify(review)));
  for (const annotation of review.annotations) {
    const page = pages[annotation.page - 1]!;
    const comments = annotation.comments;
    const first = comments[0];
    const common = {
      Type: 'Annot', P: page.ref, Rect: annotation.rect,
      OpenBitFunReviewId: PDFHexString.fromText(annotation.id),
      C: PDF_REVIEW_INK[annotation.color], F: 4,
      NM: PDFHexString.fromText(annotation.id),
      T: PDFHexString.fromText('OpenBitFun'),
      Contents: PDFHexString.fromText(first?.body || annotation.quote || ''),
      CreationDate: PDFHexString.fromText('D:' + annotation.createdAt.replace(/[-:TZ.]/g, '').slice(0, 14) + 'Z'),
    };
    const dictionary = context.obj(annotation.kind === 'highlight'
      ? { ...common, Subtype: 'Highlight', QuadPoints: annotation.quads ?? [], CA: 0.4 }
      : annotation.kind === 'ink'
        ? { ...common, Subtype: 'Ink', InkList: annotation.strokes ?? [], BS: { W: 2, S: 'S' } }
        : { ...common, Subtype: 'Text', Name: 'Comment', Open: false });
    if (annotation.resolved) dictionary.set(PDFName.of('State'), PDFHexString.fromText('Accepted'));
    const reference = context.register(dictionary);
    page.node.addAnnot(reference);
    for (const comment of comments.slice(1)) {
      page.node.addAnnot(context.register(context.obj({
        ...common, Subtype: 'Text', Name: 'Comment', IRT: reference, RT: 'R',
        NM: PDFHexString.fromText(comment.id), Contents: PDFHexString.fromText(comment.body),
        CreationDate: PDFHexString.fromText('D:' + comment.createdAt.replace(/[-:TZ.]/g, '').slice(0, 14) + 'Z'),
      })));
    }
  }
  return pdf.save();
}

/** Embedded review state allows a saved PDF to reopen with editable threads. */
export async function readEmbeddedPdfReview(bytes: Uint8Array): Promise<PdfReviewData | undefined> {
  const { lib: { PDFName, PDFHexString }, pdf } = await loadPdf(bytes);
  if (pdf.isEncrypted) return undefined;
  const value = pdf.catalog.get(PDFName.of('OpenBitFunReview'));
  if (value === undefined) return undefined;
  const text = pdf.context.lookup(value, PDFHexString).decodeText();
  return parsePdfReview(text);
}

function removeOwnedAnnotations(pdf: import('pdf-lib').PDFDocument, PDFName: typeof import('pdf-lib').PDFName) {
  for (const page of pdf.getPages()) {
    const existing = page.node.Annots();
    if (!existing) continue;
    for (let index = existing.size() - 1; index >= 0; index--) {
      const entry = pdf.context.lookup(existing.get(index));
      if (entry && 'has' in entry && typeof entry.has === 'function' && entry.has(PDFName.of('OpenBitFunReviewId'))) existing.remove(index);
    }
  }
}
/**
 * Inspect an opened PDF once. An embedded review comes back with our saved appearances
 * removed, so deletes and recoloring are visible immediately during overlay editing.
 */
export async function readPdfReviewSource(bytes: Uint8Array): Promise<PdfReviewSource> {
  const { lib: { PDFName, PDFHexString }, pdf } = await loadPdf(bytes);
  if (pdf.isEncrypted) return { encrypted: true };
  const value = pdf.catalog.get(PDFName.of('OpenBitFunReview'));
  if (value === undefined) return { encrypted: false };
  const data = parsePdfReview(pdf.context.lookup(value, PDFHexString).decodeText());
  removeOwnedAnnotations(pdf, PDFName);
  pdf.catalog.delete(PDFName.of('OpenBitFunReview'));
  return { encrypted: false, embedded: { data, bytes: await pdf.save() } };
}
export function encodePdfBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
