import { MessageCopyScope } from '../actions/ConversationIntent';

/**
 * What one assistant copy entry writes.
 *
 * Separate from the clipboard scope because the action names the entry and the
 * scope names the payload the clipboard owner receives: today the three entries
 * map one to one, and this list is the only place that pairs them.
 */
export enum AssistantMessageCopyAction {
  RichText = 'copy_rich_text',
  Markdown = 'copy_markdown',
  PlainText = 'copy_plain_text'
}

export class AssistantMessageCopyMenuItem {
  readonly action: AssistantMessageCopyAction;
  /** The clipboard scope this entry copies with. */
  readonly scope: MessageCopyScope;
  /** Dotted i18n key, resolved by the action row at render time. */
  readonly labelKey: string;

  constructor(action: AssistantMessageCopyAction, scope: MessageCopyScope, labelKey: string) {
    this.action = action;
    this.scope = scope;
    this.labelKey = labelKey;
  }
}

/**
 * The lightweight menu an assistant message's copy affordance opens.
 *
 * Items are resolved as data rather than drawn inline, so the menu's contents
 * stay assertable without a device and a further export scope can arrive as one
 * more entry. Every entry copies the same message body through a different
 * clipboard scope: the row that renders it derives the plain rendering for
 * `Plain` and passes the Markdown source unchanged for the other two. Labels
 * stay as keys so this policy owns no copy and no locale.
 */
export class AssistantMessageCopyMenuPolicy {
  static items(): AssistantMessageCopyMenuItem[] {
    return [
      new AssistantMessageCopyMenuItem(
        AssistantMessageCopyAction.RichText,
        MessageCopyScope.Rich,
        'chat.copyRich'
      ),
      new AssistantMessageCopyMenuItem(
        AssistantMessageCopyAction.Markdown,
        MessageCopyScope.Markdown,
        'chat.copyMarkdown'
      ),
      new AssistantMessageCopyMenuItem(
        AssistantMessageCopyAction.PlainText,
        MessageCopyScope.Plain,
        'chat.copyPlain'
      )
    ];
  }
}
