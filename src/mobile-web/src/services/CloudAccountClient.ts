import { toB64 } from './E2EEncryption';
import { x25519 } from '@noble/curves/ed25519.js';

import { pairingRelayUrl } from './pairingLink';
export interface CloudAccountSession { token: string; userId: string; masterKey: Uint8Array; }
interface RelayErrorResponse { error?: string; retry_after_secs?: number; }
export class CloudAccountRequestError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'CloudAccountRequestError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never reached the relay, or its answer never came back. */
export class CloudAccountTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudAccountTransportError';
  }
}

/**
 * Whether a failed sign-in poll should be tried again inside the window.
 *
 * Retry what the next tick could plausibly get past: a transport failure, and
 * a relay that is rate limiting or briefly unavailable. Stop for anything the
 * relay meant — a rejected transaction stays rejected however long the browser
 * keeps asking.
 *
 * Kept in step with `harmonyos/.../CloudAccountClient.ets` and
 * `shared/core-feature/.../AccountStore.kt`, which carry the same decision.
 */
export function retryableAuthorizationPollError(error: unknown): boolean {
  if (error instanceof CloudAccountTransportError) return true;
  if (error instanceof CloudAccountRequestError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  return false;
}

export function generateRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function requestJson<T>(
  relayUrl: string,
  path: string,
  body: object,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(`${relayUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: T | RelayErrorResponse | null = null;
    try {
      parsed = text ? JSON.parse(text) as T | RelayErrorResponse : null;
    } catch {
      // Use the HTTP status below when a proxy returned a non-JSON body.
    }
    if (!response.ok) {
      const relayError = parsed as RelayErrorResponse | null;
      throw new CloudAccountRequestError(
        relayError?.error || `Relay request failed (HTTP ${response.status}).`,
        response.status,
        typeof relayError?.retry_after_secs === 'number'
          ? relayError.retry_after_secs
          : null,
      );
    }
    if (!parsed) throw new CloudAccountTransportError('Relay returned an empty account response.');
    return parsed as T;
  } catch (error: unknown) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new CloudAccountTransportError('Account request timed out.');
    }
    // fetch() rejects with a TypeError for every connection-level failure:
    // offline, DNS, TLS, a dropped socket mid-body.
    if (error instanceof TypeError) {
      throw new CloudAccountTransportError('Could not reach the account service.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}


interface AuthStart {
  transactionId: string; transactionSecret: string; authorizationUrl: string;
  expiresAt: number; pollIntervalSeconds: number;
}

/** GitHub identity authorizes a separately keyed browser controller. */
export class CloudAccountClient {
  private readonly relayUrl: string;
  constructor(relayUrl: string) {
    const endpoint = pairingRelayUrl(relayUrl);
    if (!endpoint) throw new Error('Invalid Relay URL');
    this.relayUrl = endpoint;
  }
  async authorize(popup: Window, signal: AbortSignal): Promise<string> {
    const start = await requestJson<AuthStart>(this.relayUrl, '/api/auth/github/start?methods=all', {});
    const url = new URL(start.authorizationUrl);
    if (!((url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize') || (url.origin === 'https://auth.openbitfun.com' && url.pathname === '/sign-in')) || url.username || url.password) {
      throw new Error('Untrusted account authorization URL.');
    }
    if (url.origin === 'https://auth.openbitfun.com') url.searchParams.set('locale', (typeof document === 'undefined' ? 'en-US' : document.documentElement.lang || 'en-US'));
    if (signal.aborted) throw new Error('Sign-in cancelled.');
    popup.location.href = url.href;
    let lastTransient: Error | null = null;
    while (!signal.aborted && Date.now() < start.expiresAt * 1000) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(30, Math.max(1, start.pollIntervalSeconds)) * 1000));
      if (signal.aborted) break;
      let result: { status: string; tokens?: { accessToken: string } };
      try {
        result = await requestJson<{ status: string; tokens?: { accessToken: string } }>(
          this.relayUrl, '/api/auth/github/poll', {
            transactionId: start.transactionId, transactionSecret: start.transactionSecret,
          },
        );
      } catch (cause) {
        // The poll window spans the minutes the user spends in the popup, which
        // on a phone browser is exactly when the tab is backgrounded, the radio
        // sleeps, or the network hops. Ending the sign-in on the first hiccup
        // would send them back to the start for something the next tick fixes
        // by itself, so only a refusal the relay actually means stops the loop.
        if (!retryableAuthorizationPollError(cause)) throw cause;
        lastTransient = cause as Error;
        continue;
      }
      lastTransient = null;
      if (result.status === 'authorized' && result.tokens?.accessToken) return result.tokens.accessToken;
      if (result.status === 'expired' || result.status === 'denied') break;
    }
    // A window that ran out while every poll was failing is a network problem,
    // not a rejected sign-in: report the one the user can act on.
    if (!signal.aborted && lastTransient) throw lastTransient;
    throw new Error(signal.aborted ? 'Sign-in cancelled.' : 'Sign-in expired. Try again.');
  }

  async login(accessToken: string, deviceId: string, browserPrivateKey: Uint8Array): Promise<CloudAccountSession> {
    if (browserPrivateKey.length !== 32) throw new Error('Stored device identity is invalid.');
    // The browser store commits one identity before any login request. Never
    // generate a new key here: concurrent tabs must register the same key.
    const keys = { privateKey: browserPrivateKey.slice(), publicKey: x25519.getPublicKey(browserPrivateKey) };
    try {
      const auth = await requestJson<{ token: string; user_id: string }>(this.relayUrl, '/api/auth/login', {
        access_token: accessToken, device_id: deviceId, device_name: 'Mobile Browser',
        device_kind: 'mobile', public_key: toB64(keys.publicKey), request_id: generateRequestId(),
      });
      if (!auth.token?.trim() || !auth.user_id?.trim()) throw new Error('Invalid account identity.');
      return { token: auth.token, userId: auth.user_id, masterKey: keys.privateKey };
    } catch (error) {
      keys.privateKey.fill(0);
      throw error;
    }
  }

  /** Revoke only this browser token; the desktop's account remains connected. */
  async logout(token: string): Promise<void> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${this.relayUrl}/api/auth/logout`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!response.ok && response.status !== 401) throw new Error(`Sign-out failed: HTTP ${response.status}`);
    } finally { window.clearTimeout(timer); }
  }
}
