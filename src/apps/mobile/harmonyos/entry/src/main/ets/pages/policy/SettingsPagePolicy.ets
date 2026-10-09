export type SettingsPage = 'settings' | 'login';

/**
 * Settings is a single page: account, current control, remote permission mode,
 * general preferences, devices and about sit on it inline. Only a signed-out
 * account request leaves that page for the separate login step.
 */
export class SettingsPagePolicy {
  static resolve(accountRequested: boolean, authenticated: boolean): SettingsPage {
    return accountRequested && !authenticated ? 'login' : 'settings';
  }
}
