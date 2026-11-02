import {
  accountIdentityAPI,
  type DesktopAuthStart,
  type MarketMe,
} from '@/infrastructure/api/service-api/AccountIdentityAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';

export type AccountIdentityStatus = 'loading' | 'signed-out' | 'signed-in' | 'authorizing';

export interface AccountIdentitySnapshot {
  resolved: boolean;
  status: AccountIdentityStatus;
  me: MarketMe | null;
  lastError?: AccountIdentityError;
}

export type AccountIdentityErrorCode = 'cancelled' | 'expired' | 'failed';

export class AccountIdentityError extends Error {
  constructor(
    public readonly code: AccountIdentityErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AccountIdentityError';
  }
}

export interface AccountIdentityApi {
  me(): Promise<MarketMe | null>;
  authStart(): Promise<DesktopAuthStart>;
  authPoll(transaction: DesktopAuthStart): Promise<'pending' | 'authorized' | 'expired'>;
  logout(): Promise<void>;
  onAccountChanged?(handler: () => void): () => void;
}

export interface AccountIdentityChangedEvent {
  kind: 'identity-changed';
  eventId: string;
  sourceId: string;
}

export interface AccountIdentitySyncPort {
  publish(event: AccountIdentityChangedEvent): void | Promise<void>;
  subscribe(listener: (event: AccountIdentityChangedEvent) => void): () => void;
  dispose?(): void;
}

const noopSyncPort: AccountIdentitySyncPort = {
  publish: () => undefined,
  subscribe: () => () => undefined,
};

function isAccountIdentityChangedEvent(value: unknown): value is AccountIdentityChangedEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.kind === 'identity-changed'
    && typeof event.eventId === 'string'
    && typeof event.sourceId === 'string';
}

class BroadcastAccountIdentitySyncPort implements AccountIdentitySyncPort {
  private readonly listeners = new Set<(event: AccountIdentityChangedEvent) => void>();

  constructor(private readonly channel: BroadcastChannel) {
    channel.addEventListener('message', this.handleMessage);
  }

  publish(event: AccountIdentityChangedEvent): void {
    this.channel.postMessage(event);
  }

  subscribe(listener: (event: AccountIdentityChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.channel.removeEventListener('message', this.handleMessage);
    this.channel.close();
    this.listeners.clear();
  }

  private readonly handleMessage = (message: MessageEvent<unknown>): void => {
    const event = message.data;
    if (!isAccountIdentityChangedEvent(event)) return;
    this.listeners.forEach(listener => listener(event));
  };
}

export function createAccountIdentitySyncPort(): AccountIdentitySyncPort {
  if (typeof BroadcastChannel === 'undefined') return noopSyncPort;
  try {
    return new BroadcastAccountIdentitySyncPort(new BroadcastChannel('openbitfun-account-identity'));
  } catch {
    return noopSyncPort;
  }
}

export interface AccountIdentityServiceDependencies {
  api: AccountIdentityApi;
  openExternal(url: string): Promise<void>;
  syncPort: AccountIdentitySyncPort;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  sourceId: string;
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const defaultDependencies = (): AccountIdentityServiceDependencies => ({
  api: accountIdentityAPI,
  openExternal: url => systemAPI.openExternal(url),
  syncPort: createAccountIdentitySyncPort(),
  now: () => Date.now(),
  sleep: milliseconds => new Promise(resolve => globalThis.setTimeout(resolve, milliseconds)),
  sourceId: createId(),
});

export class AccountIdentityService {
  private snapshot: AccountIdentitySnapshot = Object.freeze({
    resolved: false,
    status: 'loading',
    me: null,
  });
  private readonly listeners = new Set<(snapshot: AccountIdentitySnapshot) => void>();
  private initializePromise: Promise<void> | null = null;
  private refreshPromise: Promise<MarketMe | null> | null = null;
  private authPromise: Promise<MarketMe> | null = null;
  private authorizationUrl: string | null = null;
  private authGeneration = 0;
  private identityGeneration = 0;
  private stopSync: (() => void) | null = null;
  private stopNativeAccountEvents: (() => void) | null = null;
  private observingHost = false;

  constructor(private readonly dependencies: AccountIdentityServiceDependencies = defaultDependencies()) {}

  getSnapshot(): AccountIdentitySnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: AccountIdentitySnapshot) => void): () => void {
    this.listeners.add(listener);
    void this.initialize();
    return () => this.listeners.delete(listener);
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.stopSync = this.dependencies.syncPort.subscribe(event => {
      if (event.sourceId === this.dependencies.sourceId) return;
      void this.refresh(false).catch(() => undefined);
    });
    this.stopNativeAccountEvents = this.dependencies.api.onAccountChanged?.(() => {
      void this.refresh(false).catch(() => undefined);
    }) ?? null;
    this.attachHostObservation();
    const generation = this.identityGeneration;
    this.initializePromise = this.refresh()
      .then(() => undefined)
      .catch(error => {
        if (generation !== this.identityGeneration) return;
        this.setSnapshot({
          resolved: true,
          status: 'signed-out',
          me: null,
          lastError: asAccountIdentityError(error),
        });
      });
    return this.initializePromise;
  }

  refresh(broadcastChange = true): Promise<MarketMe | null> {
    if (this.refreshPromise) return this.refreshPromise;
    const previous = this.snapshot;
    const generation = this.identityGeneration;
    const operation = this.dependencies.api.me()
      .then(me => {
        if (generation !== this.identityGeneration) return this.snapshot.me;
        this.setSnapshot({
          resolved: true,
          status: me ? 'signed-in' : this.snapshot.status === 'authorizing'
            ? 'authorizing'
            : 'signed-out',
          me,
        });
        if (broadcastChange
          && previous.resolved
          && identityKey(previous.me) !== identityKey(me)) {
          void this.publishIdentityChanged();
        }
        return me;
      })
      .finally(() => {
        if (this.refreshPromise === operation) this.refreshPromise = null;
      });
    this.refreshPromise = operation;
    return operation;
  }

  signIn(): Promise<MarketMe> {
    if (this.snapshot.me) return Promise.resolve(this.snapshot.me);
    if (this.authPromise) return this.authPromise;

    this.invalidateRefresh();
    const generation = ++this.authGeneration;
    this.setSnapshot({
      ...this.snapshot,
      resolved: true,
      status: 'authorizing',
      lastError: undefined,
    });
    const operation = this.runSignIn(generation)
      .catch(error => {
        const failure = asAccountIdentityError(error);
        if (generation === this.authGeneration) {
          this.setSnapshot({
            resolved: true,
            status: this.snapshot.me ? 'signed-in' : 'signed-out',
            me: this.snapshot.me,
            lastError: failure.code === 'cancelled' ? undefined : failure,
          });
        }
        throw failure;
      })
      .finally(() => {
        if (this.authPromise === operation) {
          this.authPromise = null;
          this.authorizationUrl = null;
        }
      });
    this.authPromise = operation;
    return operation;
  }

  cancelSignIn(): void {
    if (this.snapshot.status !== 'authorizing') return;
    this.authGeneration += 1;
    this.authPromise = null;
    this.authorizationUrl = null;
    this.invalidateRefresh();
    this.setSnapshot({
      resolved: true,
      status: this.snapshot.me ? 'signed-in' : 'signed-out',
      me: this.snapshot.me,
    });
  }

  private async openAuthorizationPage(url: string): Promise<void> {
    const page = new URL(url);
    // A fragment is not part of the HTTP cache key. Give each browser opening
    // a fresh URL so previously cached sign-in HTML cannot constrain the form.
    if (page.origin === 'https://auth.openbitfun.com') {
      page.searchParams.set('_auth', createId());
    }
    await this.dependencies.openExternal(page.href);
  }

  async reopenSignIn(): Promise<void> {
    // The OS browser opener cannot observe external tab closure. Keep a visible
    // recovery action while polling instead of permanently disabling sign-in.
    if (this.snapshot.status === 'authorizing' && this.authorizationUrl) {
      await this.openAuthorizationPage(this.authorizationUrl);
    }
  }

  async logout(): Promise<void> {
    this.cancelSignIn();
    this.invalidateRefresh();
    await this.dependencies.api.logout();
    this.invalidateRefresh();
    this.setSnapshot({ resolved: true, status: 'signed-out', me: null });
    await this.publishIdentityChanged();
  }

  dispose(): void {
    this.authGeneration += 1;
    this.authPromise = null;
    this.authorizationUrl = null;
    this.invalidateRefresh();
    this.stopSync?.();
    this.stopSync = null;
    this.stopNativeAccountEvents?.();
    this.stopNativeAccountEvents = null;
    this.dependencies.syncPort.dispose?.();
    this.detachHostObservation();
    this.listeners.clear();
  }

  private async runSignIn(generation: number): Promise<MarketMe> {
    const transaction = await this.dependencies.api.authStart();
    this.ensureCurrentAuth(generation);
    const authorizationUrl = new URL(transaction.authorizationUrl);
    if (authorizationUrl.origin === 'https://auth.openbitfun.com' && typeof document !== 'undefined') {
      authorizationUrl.searchParams.set('locale', document.documentElement.lang || 'en-US');
    }
    this.authorizationUrl = authorizationUrl.href;
    await this.openAuthorizationPage(this.authorizationUrl);
    const deadline = transaction.expiresAt * 1000;
    while (this.dependencies.now() < deadline) {
      await this.dependencies.sleep(Math.max(1, transaction.pollIntervalSeconds) * 1000);
      this.ensureCurrentAuth(generation);
      const status = await this.dependencies.api.authPoll(transaction);
      this.ensureCurrentAuth(generation);
      if (status === 'expired') break;
      if (status !== 'authorized') continue;

      const me = await this.dependencies.api.me();
      this.ensureCurrentAuth(generation);
      if (!me) {
        throw new AccountIdentityError('failed', 'OpenBitFun authorized sign-in but returned no account.');
      }
      this.invalidateRefresh();
      this.setSnapshot({ resolved: true, status: 'signed-in', me });
      await this.publishIdentityChanged();
      return me;
    }
    throw new AccountIdentityError('expired', 'The account sign-in request expired.');
  }

  private invalidateRefresh(): void {
    this.identityGeneration += 1;
    this.refreshPromise = null;
  }

  private ensureCurrentAuth(generation: number): void {
    if (generation !== this.authGeneration) {
      throw new AccountIdentityError('cancelled', 'The account sign-in request was cancelled.');
    }
  }

  private async publishIdentityChanged(): Promise<void> {
    await this.dependencies.syncPort.publish({
      kind: 'identity-changed',
      eventId: createId(),
      sourceId: this.dependencies.sourceId,
    });
  }

  private setSnapshot(snapshot: AccountIdentitySnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    this.listeners.forEach(listener => listener(this.snapshot));
  }

  private readonly handleHostFocus = (): void => {
    void this.refresh().catch(() => undefined);
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      this.handleHostFocus();
    }
  };

  private attachHostObservation(): void {
    if (this.observingHost) return;
    this.observingHost = true;
    if (typeof window !== 'undefined') window.addEventListener('focus', this.handleHostFocus);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private detachHostObservation(): void {
    if (!this.observingHost) return;
    this.observingHost = false;
    if (typeof window !== 'undefined') window.removeEventListener('focus', this.handleHostFocus);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }
}

function asAccountIdentityError(error: unknown): AccountIdentityError {
  if (error instanceof AccountIdentityError) return error;
  return new AccountIdentityError(
    'failed',
    error instanceof Error ? error.message : String(error),
    error,
  );
}

function identityKey(me: MarketMe | null): string {
  return me ? `${me.user.accountId || me.user.githubId}:${me.user.login}` : '';
}

export const accountIdentityService = new AccountIdentityService();
