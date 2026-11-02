/**
 * The lightweight menu a truncated user bubble opens on a long press.
 *
 * Items are resolved as data rather than drawn inline, so an entry arrives as one
 * more item plus its action instead of another branch in the bubble's layout. The
 * rollback entry is the second of them: the same entry the short bubble and the
 * full-text panel hang off the system selection menu, reached here through the
 * menu the truncated bubble opens instead of that system menu.
 *
 * Labels stay as keys so this policy owns no copy and no locale.
 */
export enum UserMessageMenuAction {
  /** Copies the whole message, not the truncated preview. */
  CopyFullText = 'copy_full_text',
  /** Opens the staged rollback on this message. */
  RollbackToMessage = 'rollback_to_message'
}

export class UserMessageMenuItem {
  readonly action: UserMessageMenuAction;
  /** Dotted i18n key, resolved by the bubble at render time. */
  readonly labelKey: string;

  constructor(action: UserMessageMenuAction, labelKey: string) {
    this.action = action;
    this.labelKey = labelKey;
  }
}

export class UserMessageMenuPolicy {
  static items(): UserMessageMenuItem[] {
    return [
      new UserMessageMenuItem(UserMessageMenuAction.CopyFullText, 'chat.copyFullText'),
      new UserMessageMenuItem(UserMessageMenuAction.RollbackToMessage, 'chat.rollbackItem')
    ];
  }
}
