/**
 * Compact Remote Home is conversation chrome, not a session list.
 *
 * The sidebar may keep a cached list after the desktop drops so the user can
 * still see what the phone already knows. Compact home must not treat that
 * cache as a live link: "pick a session" only belongs on a connected desktop.
 */
export class RemoteCompactHomePolicy {
  static shouldShowInitialLoading(connectionState: string, sessionCount: number, loadingHome: boolean): boolean {
    // Recovery keeps the existing surface, including an already empty home.
    if (sessionCount > 0 || connectionState === 'reconnecting') return false;
    return loadingHome || connectionState === 'parsing' || connectionState === 'pairing';
  }

  static shouldShowRecentSessions(connected: boolean, sessionCount: number): boolean {
    return connected || sessionCount > 0;
  }

  static shouldShowWelcomeHome(controlTargetType: string, connectionState: string, signedIn: boolean = false): boolean {
    return !signedIn && controlTargetType === 'none' && connectionState !== 'connected';
  }

  static shouldShowConnectHome(connectionState: string): boolean {
    return connectionState !== 'connected';
  }

  static headerSubtitle(connectionState: string, desktopName: string): string {
    // Recovery retains the selected device context; health belongs in the sidebar.
    if (connectionState !== 'connected' && connectionState !== 'reconnecting') {
      return '';
    }
    return desktopName;
  }
}
