import { PDFDocument } from 'pdf-lib';

/** pdf-lib cannot encrypt; a Standard security handler makes readers decrypt every string and stream. */
export async function encryptedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard', V: 2, R: 3, Length: 128, P: -4 }));
  return pdf.save();
}
