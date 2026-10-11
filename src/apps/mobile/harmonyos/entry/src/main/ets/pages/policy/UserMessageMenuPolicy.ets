/**
 * The lightweight menu a truncated user bubble opens on a long press.
 *
 * Items are resolved as data rather than drawn inline: the menu is the entry
 * point session rollback will be added to, and a list the bubble iterates is
 * what lets that arrive as one more entry plus a capability check, without
 * touching the bubble's layout. Labels stay as keys so this policy owns no copy
 * and no locale.
 */
export enum UserMessageMenuAction {
  /** Copies the whole message, not the truncated preview. */
  CopyFullText = 'copy_full_text'
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
      new UserMessageMenuItem(UserMessageMenuAction.CopyFullText, 'chat.copyFullText')
    ];
  }
}
