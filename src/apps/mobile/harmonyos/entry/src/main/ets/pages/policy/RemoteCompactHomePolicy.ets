/**
 * Compact Remote Home is conversation chrome, not a session list.
 *
 * The sidebar may keep a cached list after the desktop drops so the user can
 * still see what the phone already knows. Compact home must not treat that
 * cache as a live link: "pick a session" only belongs on a connected desktop.
 */
export class RemoteCompactHomePolicy {
  static shouldShowWelcomeHome(controlTargetType: string, connectionState: string, signedIn: boolean = false): boolean {
    return !signedIn && controlTargetType === 'none' && connectionState !== 'connected';
  }

  static shouldShowConnectHome(connectionState: string): boolean {
    return connectionState !== 'connected';
  }

  static headerSubtitle(connectionState: string, desktopName: string): string {
    if (RemoteCompactHomePolicy.shouldShowConnectHome(connectionState)) {
      return '';
    }
    return desktopName;
  }
}
