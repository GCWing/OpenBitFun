/** Presentation rules for account-independent sidebar entry and navigation. */
export type SidebarChatAction = 'assistant' | 'choose-harness' | 'code';

export class SidebarConnectionActionPolicy {
  /** Match mobile-web: assistant chat, supported harness chooser, or legacy code chat. */
  static chatAction(workspaceKind: string, supportsHarnessProfiles: boolean): SidebarChatAction {
    if (workspaceKind === 'assistant') return 'assistant';
    return supportsHarnessProfiles ? 'choose-harness' : 'code';
  }

  static canCreateSession(connectionState: string, isBusy: boolean): boolean {
    return connectionState === 'connected' && !isBusy;
  }

  /**
   * Account identity is optional once a remote control target exists. A legacy
   * QR room persisted by an older version therefore still unlocks the same chat/settings shell as an account device,
   * including while that remembered target is temporarily reconnecting.
   */
  static shouldShowPrimaryNavigation(
    accountUserId: string,
    controlTargetType: string,
    connectionState: string
  ): boolean {
    return accountUserId.trim().length > 0 ||
      controlTargetType === 'room' ||
      controlTargetType === 'account_device' ||
      connectionState === 'connected' ||
      connectionState === 'reconnecting';
  }
}
