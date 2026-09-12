interface AccountLoginFailure { code?: number; statusCode?: number; }

/** Present structured failures without exposing SDK messages or response bodies. */
export class AccountLoginErrorPolicy {
  static messageKey(error: Object): string {
    const failure = error as AccountLoginFailure;
    if (failure.code === 2300028) return 'account.errorTimeout';
    if (failure.code === 2300060 || failure.code === 2300035) return 'account.errorSecureConnection';
    if (failure.code !== undefined) return 'account.errorNetwork';
    if (failure.statusCode === 429) return 'account.errorRateLimited';
    return 'remote.settings.accountLoginFailed';
  }
}
