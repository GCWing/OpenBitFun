import pasteboard from '@ohos.pasteboard';
import { OhosError } from './OhosError';

export class ClipboardService {
  async writeText(text: string): Promise<void> {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      await pasteboard.getSystemPasteboard().setData(data);
    } catch (err) {
      throw OhosError.wrap('clipboard write', err);
    }
  }

}
