export class ConnectSheetStep {
  static readonly Intro: string = 'intro';
  static readonly Account: string = 'account';
}

/**
 * Which step the connect sheet shows. A signed-in phone picks from the
 * account device directory; a signed-out phone is sent to account sign-in.
 * The step follows authentication live, so signing in while the sheet is
 * open moves it to the device list.
 */
export class ConnectSheetLandingPolicy {
  static step(accountAuthenticated: boolean): string {
    return accountAuthenticated ? ConnectSheetStep.Account : ConnectSheetStep.Intro;
  }
}

export class ConnectSheetStatusPolicy {
  static isConnectError(
    connectionState: string,
    isBusy: boolean,
    isConnected: boolean,
    statusText: string,
    failedLabel: string,
    missingParams: string,
    urlRequired: string
  ): boolean {
    if (connectionState === 'failed') {
      return true;
    }
    if (isBusy || isConnected) {
      return false;
    }
    const text = statusText.toLowerCase();
    return text.indexOf('http') >= 0 ||
      text.indexOf('error') >= 0 ||
      text.indexOf('failed') >= 0 ||
      text.indexOf(failedLabel.toLowerCase()) >= 0 ||
      statusText === missingParams ||
      statusText === urlRequired ||
      text.indexOf('rejected') >= 0;
  }

  static failureHintKey(kind: string): string {
    if (kind === 'expired_room') {
      return 'connect.hintExpiredRoom';
    }
    if (kind === 'network') {
      return 'connect.hintNetwork';
    }
    if (kind === 'protected_user') {
      return 'connect.hintProtectedUser';
    }
    if (kind === 'invalid_link') {
      return 'connect.hintInvalidLink';
    }
    return '';
  }
}
