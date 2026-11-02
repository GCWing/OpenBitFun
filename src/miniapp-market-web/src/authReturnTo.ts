const AUTH_RETURN_TO_KEY = 'openbitfun.auth.returnTo';
export const OPENBITFUN_AUTH_CALLBACK = 'openbitfun://auth/callback';

/**
 * The return target is only a wake-up signal. Keep the allowlist exact so a
 * query parameter cannot turn the completion page into an open redirect.
 */
export function parseNativeAuthReturnTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    if (
      target.protocol !== 'openbitfun:' ||
      target.hostname !== 'auth' ||
      target.pathname !== '/callback' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash
    ) return null;
    return OPENBITFUN_AUTH_CALLBACK;
  } catch {
    return null;
  }
}

export function rememberNativeAuthReturnTo(value: string | null): string | null {
  const target = parseNativeAuthReturnTo(value);
  try {
    if (target) sessionStorage.setItem(AUTH_RETURN_TO_KEY, target);
    else sessionStorage.removeItem(AUTH_RETURN_TO_KEY);
  } catch {
    // Private browsing modes may deny sessionStorage. The manual fallback is
    // still available when the marker can be read from the current URL.
  }
  return target;
}

export function takeNativeAuthReturnTo(): string | null {
  try {
    const target = parseNativeAuthReturnTo(sessionStorage.getItem(AUTH_RETURN_TO_KEY));
    sessionStorage.removeItem(AUTH_RETURN_TO_KEY);
    return target;
  } catch {
    return null;
  }
}
