import { ConversationUiImage, ConversationUiMessage, ConversationUiMessageItem } from '../state/ConversationUiModels';

export class ConversationMessageRenderPolicy {
  /**
   * Desktop attachments reach this device as pixels, never as a readable path,
   * so an image the host could not inline has nothing to draw.
   */
  static hasRenderableImagePixels(image: ConversationUiImage): boolean {
    return (image.data_url || '').trim().length > 0;
  }

  static visibleText(text?: string): string {
    const value = (text || '').trim();
    if (value === '(空消息)' || value === '(empty message)') {
      return '';
    }
    return value;
  }

  static shouldRender(item: ConversationUiMessage): boolean {
    if ((item.role || '').toLowerCase() === 'user') {
      return true;
    }
    if (ConversationMessageRenderPolicy.visibleText(item.text).length > 0) {
      return true;
    }
    if ((item.thinking || '').trim().length > 0) {
      return true;
    }
    if (item.tools && item.tools.length > 0) {
      return true;
    }
    if (ConversationMessageRenderPolicy.hasRenderableItems(item.items || [])) {
      return true;
    }
    if (item.images && item.images.length > 0) {
      return true;
    }
    const status = (item.status || '').toLowerCase();
    return status === 'active' || status === 'failed';
  }

  /**
   * Copy is available only for a settled assistant answer. Streamed text may
   * already be non-empty while the turn is still changing.
   */
  static canCopyAssistant(
    item: ConversationUiMessage,
    isStreaming: boolean,
    isFinalizing: boolean,
    sourceTextLength: number
  ): boolean {
    if ((item.role || '').toLowerCase() === 'user' || isStreaming || isFinalizing || sourceTextLength <= 0) {
      return false;
    }
    const status = (item.status || '').toLowerCase();
    return status === '' || status === 'done' || status === 'completed' ||
      status === 'success' || status === 'sent';
  }

  static hasRenderableItems(items: ConversationUiMessageItem[]): boolean {
    return items.some((entry: ConversationUiMessageItem) => {
      if ((entry.content || '').trim().length > 0 || !!entry.tool) {
        return true;
      }
      return !!entry.subItems && ConversationMessageRenderPolicy.hasRenderableItems(entry.subItems);
    });
  }

}
