import pasteboard from '@ohos.pasteboard';
import { OhosError } from './OhosError';

/**
 * One pasteboard record as it will be written: a MIME flavor and its payload.
 *
 * The list order is the contract, not an implementation detail — the first
 * record is the flavor the pasteboard treats as primary, so plain text has to
 * come first for receivers that cannot read html.
 */
export interface ClipboardRecordSpec {
  mimeType: string;
  value: string;
}

/**
 * Rich clipboard payload construction, kept free of the pasteboard kit so the
 * record types and their order stay unit-testable on the host runner.
 */
export class ClipboardRichPayload {
  static readonly MIMETYPE_TEXT_PLAIN: string = 'text/plain';
  static readonly MIMETYPE_TEXT_HTML: string = 'text/html';

  /**
   * Markdown source as the plain flavor plus its rendered html as a second
   * flavor: html-capable receivers paste formatted content, everything else
   * pastes the markdown source.
   *
   * An empty html adds no record at all, which makes that case identical to a
   * plain write. An empty plain keeps its primary slot so the html flavor can
   * never become the only thing a receiver can read.
   */
  static build(plainText: string, html: string): ClipboardRecordSpec[] {
    const specs: ClipboardRecordSpec[] = [
      { mimeType: ClipboardRichPayload.MIMETYPE_TEXT_PLAIN, value: plainText },
    ];
    if (html.length > 0) {
      specs.push({ mimeType: ClipboardRichPayload.MIMETYPE_TEXT_HTML, value: html });
    }
    return specs;
  }
}

export class ClipboardService {
  async writeText(text: string): Promise<void> {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      await pasteboard.getSystemPasteboard().setData(data);
    } catch (err) {
      throw OhosError.wrap('clipboard write', err);
    }
  }

  /**
   * Writes both flavors in one operation: the markdown source as the primary
   * plain record and the rendered html as an additional record. Use `writeText`
   * for a plain-only copy.
   */
  async copyRich(plainText: string, html: string): Promise<void> {
    try {
      const specs = ClipboardRichPayload.build(plainText, html);
      const primary = specs[0];
      const data = pasteboard.createData(primary.mimeType, primary.value);
      for (let index = 1; index < specs.length; index += 1) {
        const spec = specs[index];
        data.addRecord(pasteboard.createRecord(spec.mimeType, spec.value));
      }
      await pasteboard.getSystemPasteboard().setData(data);
    } catch (err) {
      throw OhosError.wrap('clipboard rich write', err);
    }
  }
}
