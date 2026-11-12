import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFHexString, PDFArray } from 'pdf-lib';
import { exportReviewedPdf, PdfReviewEncryptedError, readEmbeddedPdfReview, readPdfReviewSource,
  parsePdfReview, type PdfReviewAnnotation } from './pdfReview';
import { encryptedPdf } from './pdfReview.test-support';

export function note(id = 'note-1'): PdfReviewAnnotation {
  return { id, kind: 'note', page: 1, rect: [20, 30, 40, 50], color: 'yellow',
    createdAt: '2026-11-11T03:00:00.000Z', comments: [{ id: 'comment-1', body: '检查公式 ΔE = mc²', createdAt: '2026-11-11T03:00:00.000Z' }] };
}


describe('portable PDF review data', () => {
  it('retains unknown additive fields and accepts a record without the optional resolution state', () => {
    const data = { version: 1, fingerprint: 'original', futureSetting: 7, annotations: [{ ...note(), futureField: 'keep' }] };
    expect(parsePdfReview(JSON.stringify(data))).toEqual(data);
  });
  it.each([
    '{broken', JSON.stringify({ version: 2, annotations: [] }),
    JSON.stringify({ version: 1, fingerprint: '', annotations: [{ ...note(), rect: [0, 1] }] }),
    JSON.stringify({ version: 1, fingerprint: '', annotations: [note(), note()] }),
  ])('rejects unsupported data without manufacturing an empty replacement', value => {
    expect(() => parsePdfReview(value)).toThrow();
  });
  it.each(['__proto__', 'constructor', 'toString'])('rejects inherited color keys such as %s', color => {
    const data = { version: 1, fingerprint: '', annotations: [{ ...note(), color }] };
    expect(() => parsePdfReview(JSON.stringify(data))).toThrow('Invalid PDF review data');
  });
  it.each([null, 7, true, [], { unexpected: 'object' }])('rejects a malformed quote before it reaches the renderer', quote => {
    const data = { version: 1, fingerprint: '', annotations: [{ ...note(), quote }] };
    expect(() => parsePdfReview(JSON.stringify(data))).toThrow('Invalid PDF review data');
  });
  it.each(['yellow', 'green', 'blue', 'pink'])('retains a valid %s annotation and its quoted text', color => {
    const data = { version: 1, fingerprint: '', annotations: [{ ...note(), color, quote: '公式 ΔE = mc²' }] };
    expect(parsePdfReview(JSON.stringify(data))).toEqual(data);
  });
  it('exports editable annotations and Unicode replies while retaining existing PDF annotations', async () => {
    const original = await PDFDocument.create();
    const page = original.addPage([400, 600]);
    page.drawText('A paper with an equation');
    page.node.addAnnot(original.context.register(original.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [1, 2, 3, 4], Contents: PDFHexString.fromText('Existing note') })));
    const first = note();
    first.comments.push({ id: 'reply-2', body: '复核后保留这一版。', createdAt: first.createdAt });
    const highlight: PdfReviewAnnotation = { ...note('highlight-1'), kind: 'highlight', quads: [10, 100, 90, 100, 10, 80, 90, 80] };
    const ink: PdfReviewAnnotation = { ...note('ink-1'), kind: 'ink', strokes: [[20, 40, 80, 90]] };
    const bytes = await exportReviewedPdf(await original.save(), { version: 1, fingerprint: 'first', annotations: [first, highlight, ink] });
    const reopened = await PDFDocument.load(bytes);
    const annotations = reopened.getPage(0).node.Annots()!;
    expect(annotations.size()).toBe(5);
    const dictionaries = annotations.asArray().map(value => reopened.context.lookup(value, PDFDict));
    expect(dictionaries.map(value => value.get(PDFName.of('Subtype'))?.toString())).toEqual(['/Text', '/Text', '/Text', '/Highlight', '/Ink']);
    expect(dictionaries[1]!.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('检查公式 ΔE = mc²');
    expect(dictionaries[2]!.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('复核后保留这一版。');
    expect(dictionaries[2]!.get(PDFName.of('IRT'))).toEqual(annotations.get(1));
    expect(dictionaries[3]!.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map(value => Number(value.toString()))).toEqual(highlight.quads);
  });
  it('refuses to silently drop annotations whose pages were removed by a recompile', async () => {
    const original = await PDFDocument.create(); original.addPage();
    await expect(exportReviewedPdf(await original.save(), { version: 1, fingerprint: '', annotations: [{ ...note(), page: 2 }] })).rejects.toThrow('no longer exist');
  });
  it('reopens saved threads for editing and replaces rather than duplicates saved annotations', async () => {
    const original = await PDFDocument.create(); original.addPage();
    const review = { version: 1 as const, fingerprint: 'original', annotations: [note()] };
    const saved = await exportReviewedPdf(await original.save(), review);
    expect(await readEmbeddedPdfReview(saved)).toEqual(review);
    const opened = (await readPdfReviewSource(saved)).embedded;
    expect(opened?.data).toEqual(review);
    expect((await PDFDocument.load(opened!.bytes)).getPage(0).node.Annots()?.size()).toBe(0);
    const revised = await exportReviewedPdf(saved, { ...review, annotations: [] });
    expect((await PDFDocument.load(revised)).getPage(0).node.Annots()?.size()).toBe(0);
    const savedAgain = await exportReviewedPdf(saved, review);
    expect((await PDFDocument.load(savedAgain)).getPage(0).node.Annots()?.size()).toBe(1);
    expect(await readPdfReviewSource(await original.save())).toEqual({ encrypted: false });
  });
  it('opens an encrypted PDF as having no embedded review instead of failing', async () => {
    const bytes = await encryptedPdf();
    await expect(readEmbeddedPdfReview(bytes)).resolves.toBeUndefined();
    await expect(readPdfReviewSource(bytes)).resolves.toEqual({ encrypted: true });
  });
  it('refuses to write unencrypted annotation strings into an encrypted PDF', async () => {
    await expect(exportReviewedPdf(await encryptedPdf(), { version: 1, fingerprint: '', annotations: [note()] }))
      .rejects.toBeInstanceOf(PdfReviewEncryptedError);
  });

});
