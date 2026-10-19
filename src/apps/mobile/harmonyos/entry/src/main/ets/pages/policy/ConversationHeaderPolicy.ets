import { ChatSurface } from '../state/ChatSurface';

export class ConversationHeaderPresentation {
  title: string = '';
  subtitle: string = '';
  fallbackKey: string = 'app.title';
  allowRename: boolean = false;
  showActions: boolean = false;

  constructor(
    title: string,
    subtitle: string,
    fallbackKey: string,
    allowRename: boolean,
    showActions: boolean
  ) {
    this.title = title;
    this.subtitle = subtitle;
    this.fallbackKey = fallbackKey;
    this.allowRename = allowRename;
    this.showActions = showActions;
  }
}

/** Every action the conversation header's menu can offer. */
export enum ConversationHeaderMenuAction {
  /** Rename the open session; opens the editor row in the content area. */
  Rename = 'rename',
  Pin = 'pin',
  UploadedFiles = 'uploaded_files',
  Archive = 'archive',
  Delete = 'delete',
  Stop = 'stop'
}

/**
 * One row of the conversation header's menu, as data.
 *
 * Data rather than a call site, because two chromes render the same menu: the
 * conversation's own header popover where it still draws one, and the platform
 * title bar's anchored menu where it does not. Only the renderer differs — the
 * rows, their order, their grouping and the key each one is labelled with are
 * decided once, here, so the two can never offer different actions.
 *
 * `icon` is a name from the menu's own small vocabulary (`ConversationHeaderMenu`
 * maps it to a platform glyph): a policy is a pure file that also runs on the
 * host, so it may hold neither `$r()` nor a `Resource`.
 */
export class ConversationHeaderMenuItem {
  readonly id: string;
  readonly labelKey: string;
  readonly icon: string;
  /** True for the one row that is a state rather than an action — the pin. */
  readonly selected: boolean;
  /** True where a separator is drawn above this row, so groups read as groups. */
  readonly startsGroup: boolean;

  constructor(
    id: string,
    labelKey: string,
    icon: string,
    selected: boolean = false,
    startsGroup: boolean = false
  ) {
    this.id = id;
    this.labelKey = labelKey;
    this.icon = icon;
    this.selected = selected;
    this.startsGroup = startsGroup;
  }
}

/**
 * One header contract for local and remote chat.
 * View supplies i18n for fallbackKey; this policy only decides structure.
 */
export class ConversationHeaderPolicy {
  static readonly REMOTE_BRAND: string = 'OpenBitFun';

  static present(
    surface: ChatSurface,
    sessionTitle: string,
    desktopName: string,
    workspaceBranch: string,
    hasTimeline: boolean
  ): ConversationHeaderPresentation {
    if (surface === ChatSurface.Remote) {
      return new ConversationHeaderPresentation(
        sessionTitle,
        ConversationHeaderPolicy.remoteSubtitle(desktopName, workspaceBranch),
        'chat.remoteSession',
        true,
        true
      );
    }
    return new ConversationHeaderPresentation(
      sessionTitle,
      '',
      'app.title',
      false,
      hasTimeline
    );
  }

  static remoteSubtitle(desktopName: string, workspaceBranch: string): string {
    if (desktopName.length > 0) {
      return desktopName;
    }
    return workspaceBranch.length > 0 ?
      `${ConversationHeaderPolicy.REMOTE_BRAND} · ${workspaceBranch}` :
      ConversationHeaderPolicy.REMOTE_BRAND;
  }

  /**
   * The rows the conversation's menu offers for one surface and one session.
   *
   * Rename leads, because it is the entry the header's own title used to carry:
   * the title is the platform's text now and a title tap is not a control the
   * platform has, so the session's name is changed from the menu instead. The
   * rest is what this menu has always offered — pin, the uploaded-file list and
   * the session lifecycle on a local chat; the uploaded-file list and the running
   * task's stop on a remote one, where the session's lifecycle lives in the
   * drawer's own row menu.
   */
  static menu(
    surface: ChatSurface,
    isPinned: boolean,
    canStop: boolean,
    connected: boolean
  ): ConversationHeaderMenuItem[] {
    const items: ConversationHeaderMenuItem[] = [];
    if (surface === ChatSurface.Remote) {
      items.push(new ConversationHeaderMenuItem(
        ConversationHeaderMenuAction.Rename,
        'chat.rename',
        'remote_actions_rename'
      ));
      items.push(new ConversationHeaderMenuItem(
        ConversationHeaderMenuAction.UploadedFiles,
        'chat.uploadedFiles',
        'remote_actions_cloud'
      ));
      if (canStop && connected) {
        items.push(new ConversationHeaderMenuItem(
          ConversationHeaderMenuAction.Stop,
          'chat.stop',
          'remote_actions_settings',
          false,
          true
        ));
      }
      return items;
    }
    items.push(new ConversationHeaderMenuItem(
      ConversationHeaderMenuAction.Pin,
      isPinned ? 'chat.unpin' : 'chat.pin',
      'remote_actions_check',
      isPinned
    ));
    items.push(new ConversationHeaderMenuItem(
      ConversationHeaderMenuAction.UploadedFiles,
      'chat.uploadedFiles',
      'remote_actions_cloud'
    ));
    items.push(new ConversationHeaderMenuItem(
      ConversationHeaderMenuAction.Archive,
      'sidebar.archive',
      'remote_actions_folder',
      false,
      true
    ));
    items.push(new ConversationHeaderMenuItem(
      ConversationHeaderMenuAction.Delete,
      'common.delete',
      'remote_actions_settings'
    ));
    return items;
  }
}
