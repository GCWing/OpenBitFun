import {
  openHostStream, parseStreamHint, parseStreamPage,
  type HostStreamOptions, type SessionStreamHandle, type StreamHint, type StreamReadRequest,
} from '../../../shared/relay-transport/HostStream';
/** Account directory plus the shared Socket.IO encrypted RPC transport. */
import { AccountRealtime, type DeviceEventEnvelope } from '../../../shared/relay-transport/AccountRealtime';
import { deriveDeviceMessageKey, encrypt, decrypt, fromB64 } from './E2EEncryption';
import { normalizeRelayUrl } from './pairingLink';

export interface AccountIdentity {
  token: string;
  masterKey: Uint8Array;
  userId: string;
  deviceId: string;
}
interface AccountIdentitySnapshot extends AccountIdentity { generation: number; }
export type AccountOwnerChange = {
  kind: 'initial' | 'replacement' | 'unavailable';
  epoch: number;
  userId: string | null;
};
export type ControlTargetSnapshot = Readonly<{ deviceId: string | null; epoch: number }>;
export class AccountIdentityChangedError extends Error {
  constructor() { super('Account identity changed'); this.name = 'AccountIdentityChangedError'; }
}
export function isAccountIdentityChangedError(value: unknown): value is AccountIdentityChangedError {
  return value instanceof AccountIdentityChangedError;
}
const RELAY_HTTP_MAX_ATTEMPTS = 5;
const RELAY_HTTP_RETRY_BASE_DELAY_MS = 300;
const RELAY_HTTP_RETRY_BUDGET_MS = 120_000;
const TRANSIENT_RELAY_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
type RelayRequestOptions = { retryable?: boolean; timeoutMs?: number };

export class RelayHttpClient {
  private readonly relayUrl: string;
  private realtime: AccountRealtime | null = null;
  private identity: AccountIdentitySnapshot | null = null;
  private identityGeneration = 0;
  private accountEpochValue = 0;
  private directoryListeners = new Set<() => void>();
  private ownerListeners = new Set<(change: AccountOwnerChange) => void>();
  private authorizationExpiredListeners = new Set<(token: string) => void>();
  private targetDeviceIdValue: string | null = null;
  private controlTargetEpochValue = 0;
  private controlTargetListeners = new Set<(snapshot: ControlTargetSnapshot) => void>();
  private deviceMessageKeys = new Map<string, { expires: number; key: Promise<Uint8Array> }>();
  private streamHintListeners = new Set<(hint: StreamHint) => void>();

  constructor(relayUrl: string, identity: AccountIdentity) {
    const endpoint = normalizeRelayUrl(relayUrl);
    if (!endpoint) throw new Error('Invalid Relay URL');
    this.relayUrl = endpoint;
    this.setAccountIdentity(identity);
  }

  setAccountIdentity(identity: AccountIdentity): void {
    if (!identity.token.trim() || !identity.userId.trim() || !identity.deviceId.trim() || identity.masterKey.length !== 32) {
      throw new Error('Relay returned an invalid account identity.');
    }
    const kind = this.identity ? 'replacement' : 'initial';
    this.realtime?.close();
    this.realtime = null;
    this.identity?.masterKey.fill(0);
    this.identity = { ...identity, masterKey: identity.masterKey.slice(), generation: ++this.identityGeneration };
    this.realtime = new AccountRealtime({ url: this.relayUrl, token: identity.token });
    const notifyDirectory = () => { for (const listener of this.directoryListeners) listener(); };
    this.realtime.onDeviceDirectoryChanged(notifyDirectory);
    this.realtime.onReconnect(notifyDirectory);
    this.realtime.onDeviceEvent(envelope => { void this.receiveDeviceEvent(envelope); });
    this.accountEpochValue += 1;
    this.deviceMessageKeys.clear();
    this.setTargetDeviceId(null);
    for (const listener of this.ownerListeners) listener({ kind, epoch: this.accountEpochValue, userId: identity.userId });
  }

  resetConnectionIdentity(): void {
    this.realtime?.close();
    this.realtime = null;
    this.identity?.masterKey.fill(0);
    this.identity = null;
    this.identityGeneration += 1;
    this.accountEpochValue += 1;
    this.deviceMessageKeys.clear();
    this.setTargetDeviceId(null);
    for (const listener of this.ownerListeners) listener({ kind: 'unavailable', epoch: this.accountEpochValue, userId: null });
  }

  onDeviceDirectoryChanged(listener: () => void): () => void {
    this.directoryListeners.add(listener);
    return () => { this.directoryListeners.delete(listener); };
  }

  onAccountOwnerChange(listener: (change: AccountOwnerChange) => void, options?: { emitCurrent?: boolean }): () => void {
    this.ownerListeners.add(listener);
    if (options?.emitCurrent && this.identity) listener({ kind: 'initial', epoch: this.accountEpochValue, userId: this.identity.userId });
    return () => this.ownerListeners.delete(listener);
  }
  onAuthorizationExpired(listener: (token: string) => void): () => void {
    this.authorizationExpiredListeners.add(listener);
    return () => this.authorizationExpiredListeners.delete(listener);
  }
  get hasAccountIdentity(): boolean { return this.identity !== null; }
  get accountEpoch(): number { return this.accountEpochValue; }
  get accountUserId(): string | null { return this.identity?.userId ?? null; }
  get controllerDeviceId(): string | null { return this.identity?.deviceId ?? null; }
  get targetDeviceId(): string | null { return this.targetDeviceIdValue; }
  get controlTargetEpoch(): number { return this.controlTargetEpochValue; }
  setTargetDeviceId(deviceId: string | null): void {
    this.targetDeviceIdValue = deviceId;
    this.controlTargetEpochValue += 1;
    const snapshot = this.getControlTargetSnapshot();
    for (const listener of this.controlTargetListeners) listener(snapshot);
  }
  getControlTargetSnapshot(): ControlTargetSnapshot {
    return { deviceId: this.targetDeviceIdValue, epoch: this.controlTargetEpochValue };
  }
  isControlTargetCurrent(snapshot: ControlTargetSnapshot): boolean { return snapshot.epoch === this.controlTargetEpochValue; }
  onControlTargetChange(listener: (snapshot: ControlTargetSnapshot) => void): () => void {
    this.controlTargetListeners.add(listener);
    return () => this.controlTargetListeners.delete(listener);
  }

  /** Stream hints decrypted from the controlled host; only its device is trusted. */
  onStreamHint(listener: (hint: StreamHint) => void): () => void {
    this.streamHintListeners.add(listener);
    return () => { this.streamHintListeners.delete(listener); };
  }

  /** Decrypt a forwarded `DeviceEvent`. Only the selected control target is a
   * hint source; events from any other device are dropped before key lookup. */
  private async receiveDeviceEvent(envelope: DeviceEventEnvelope): Promise<void> {
    const identity = this.identity;
    const target = this.getControlTargetSnapshot();
    if (!identity || envelope.sourceDeviceId !== target.deviceId) return;
    try {
      const messageKey = await this.deviceMessageKey(identity, envelope.sourceDeviceId);
      if (this.identity !== identity || !this.isControlTargetCurrent(target)) return;
      const plaintext = JSON.parse(await decrypt(messageKey, envelope.encrypted_data, envelope.nonce)) as { cmd?: unknown; event?: unknown; payload?: unknown };
      if (plaintext?.cmd !== 'device_event' || typeof plaintext.event !== 'string') return;
      const hint = parseStreamHint(envelope.sourceDeviceId, plaintext.event, plaintext.payload);
      if (hint) for (const listener of this.streamHintListeners) listener(hint);
    } catch (error) {
      console.warn('[RelayHttpClient] device event ignored', error);
    }
  }

  /** Read one host-owned stream (session records, terminal output hints, host
   * catalog) directly from the selected control target. Nothing is cached. */
  async subscribeHostStream(streamId: string, callbacks: Pick<HostStreamOptions, 'onEvent' | 'onError' | 'onCaughtUp' | 'onHistoryState' | 'onResumed' | 'onGap'>): Promise<SessionStreamHandle> {
    const identity = this.identity;
    const connection = this.realtime;
    const target = this.getControlTargetSnapshot();
    if (!identity || !connection || !target.deviceId) throw new Error('No controlled runtime is selected');
    const deviceId = target.deviceId;
    let disposed = false;
    let stop: SessionStreamHandle | undefined;
    const current = () => !disposed && this.identity === identity && this.isControlTargetCurrent(target);
    const dispose = () => { disposed = true; stop?.close(); unbindTarget(); unbindOwner(); };
    const unbindTarget = this.onControlTargetChange(dispose);
    const unbindOwner = this.onAccountOwnerChange(dispose);
    const transport = {
      readStream: async (request: StreamReadRequest) => {
        if (!current()) throw new AccountIdentityChangedError();
        return parseStreamPage(await this.sendDeviceRpc(deviceId, { cmd: 'read_stream', ...request }, { retryable: true, timeoutMs: 30_000 }));
      },
      unsubscribeStream: async (id: string) => {
        // Best effort: the host also drops the lease when this device goes
        // offline or stops renewing.
        if (this.identity !== identity) return;
        await this.sendDeviceRpc(deviceId, { cmd: 'unsubscribe_stream', stream_id: id }, { retryable: true, timeoutMs: 10_000 });
      },
    };
    const signals = {
      onHint: (listener: (hint: StreamHint) => void) => this.onStreamHint(listener),
      onReconnect: (listener: () => void) => connection.onReconnect(listener),
    };
    try {
      stop = await openHostStream({ transport, signals, target: deviceId, streamId,
        onEvent: event => { if (current()) callbacks.onEvent(event); },
        onError: error => { if (current()) callbacks.onError(error); },
        onCaughtUp: () => { if (current()) callbacks.onCaughtUp?.(); },
        onHistoryState: state => { if (current()) callbacks.onHistoryState?.(state); },
        onResumed: () => { if (current()) callbacks.onResumed?.(); },
        onGap: reason => { if (current()) callbacks.onGap?.(reason); },
      });
      if (!current()) dispose();
      return { close: dispose, wake: () => { if (current()) stop?.wake(); }, loadOlder: () => current() && stop ? stop.loadOlder() : Promise.resolve() };
    } catch (error) { dispose(); throw error; }
  }

  private async fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      // Keep the deadline active until the full body has been received.
      // `fetch()` resolves after response headers, so returning that Response
      // directly would let a stalled body wait forever outside the timeout.
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error: unknown) {
      if ((error as { name?: string })?.name === 'AbortError') {
        throw new Error('Request timed out');
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async fetchWithRetry(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
    assertCurrent: () => void = () => {},
  ): Promise<Response> {
    let lastError: unknown = null;
    const deadlineMs = Date.now() + RELAY_HTTP_RETRY_BUDGET_MS;
    for (let attempt = 1; attempt <= RELAY_HTTP_MAX_ATTEMPTS; attempt += 1) {
      assertCurrent();
      try {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          throw lastError ?? new Error('Relay request retry budget exceeded');
        }
        const response = await this.fetchWithTimeout(
          input,
          init,
          Math.min(timeoutMs, remainingMs),
        );
        if (
          TRANSIENT_RELAY_STATUSES.has(response.status)
          && attempt < RELAY_HTTP_MAX_ATTEMPTS
        ) {
          lastError = new Error(`Relay returned HTTP ${response.status}`);
          void response.body?.cancel();
        } else {
          return response;
        }
      } catch (error) {
        lastError = error;
        if (attempt === RELAY_HTTP_MAX_ATTEMPTS) throw error;
      }
      const delayMs = RELAY_HTTP_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      if (Date.now() + delayMs >= deadlineMs) {
        throw lastError ?? new Error('Relay request retry budget exceeded');
      }
      await new Promise(resolve => window.setTimeout(resolve, delayMs));
    }
    throw lastError;
  }

  async listDevices(): Promise<Array<{ device_id: string; device_name: string; online: boolean }>> {
    return this.withAccount(async (identity) => {
      const resp = await this.fetchWithRetry(`${this.relayUrl}/api/devices`, {
        headers: { 'Authorization': `Bearer ${identity.token}` },
      }, 20_000, () => {
        if (identity.generation !== this.identityGeneration) throw new AccountIdentityChangedError();
      });
      if (!resp.ok) {
        const err = new Error(`List devices failed: HTTP ${resp.status}`) as Error & {
          status?: number;
        };
        err.status = resp.status;
        throw err;
      }
      return resp.json();
    });
  }

  /** Send a command encrypted with the two account devices' X25519 key agreement. */
  async sendDeviceRpc<T = any>(
    targetDeviceId: string,
    command: object,
    options: RelayRequestOptions = {},
  ): Promise<T> {
    const targetEpoch = this.controlTargetEpochValue;
    return this.withAccount(async (identity) => {
      const messageKey = await this.deviceMessageKey(identity, targetDeviceId);
      const plaintext = JSON.stringify(command);
      const { data: encData, nonce: encNonce } = await encrypt(
        messageKey,
        plaintext,
      );

      if (identity.generation !== this.identityGeneration || targetEpoch !== this.controlTargetEpochValue) {
        throw new AccountIdentityChangedError();
      }
      const timeoutMs = options.timeoutMs ?? (options.retryable ? 20_000 : 130_000);
      const connection = this.realtime;
      if (!connection) throw new AccountIdentityChangedError();
      const data = await connection.call<{ encrypted_data: string; nonce: string }>(targetDeviceId,
        { encrypted_data: encData, nonce: encNonce }, {
          timeoutMs,
          beforeSend: () => {
            if (identity.generation !== this.identityGeneration || targetEpoch !== this.controlTargetEpochValue) {
              throw new AccountIdentityChangedError();
            }
          },
        });
      if (identity.generation !== this.identityGeneration || targetEpoch !== this.controlTargetEpochValue) {
        throw new AccountIdentityChangedError();
      }
      const decrypted = await decrypt(
        messageKey,
        data.encrypted_data,
        data.nonce,
      );
      const parsed = JSON.parse(decrypted);
      if (parsed?.resp === 'error') {
        throw new Error(parsed.message || 'Remote error');
      }
      return parsed as T;
    }).catch((error) => {
      this.deviceMessageKeys.clear();
      throw error;
    });
  }

  /** Pairwise X25519-derived message key for one account device, cached briefly. */
  private deviceMessageKey(identity: AccountIdentitySnapshot, targetDeviceId: string): Promise<Uint8Array> {
    const cacheId = `${identity.generation}:${targetDeviceId}`;
    let cached = this.deviceMessageKeys.get(cacheId);
    if (!cached || cached.expires < Date.now()) {
      const key = (async () => {
        const response = await this.fetchWithTimeout(
          `${this.relayUrl}/api/devices/${encodeURIComponent(targetDeviceId)}/key`,
          { headers: { Authorization: `Bearer ${identity.token}` } }, 20_000,
        );
        if (!response.ok) {
          const error = new Error(`Device key unavailable: HTTP ${response.status}`) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
        const peer = await response.json();
        if (peer.device_id !== targetDeviceId) throw new Error('Relay returned a different device identity.');
        return deriveDeviceMessageKey(identity.masterKey, fromB64(peer.public_key));
      })();
      cached = { expires: Date.now() + 60_000, key };
      this.deviceMessageKeys.set(cacheId, cached);
      key.catch(() => { if (this.deviceMessageKeys.get(cacheId) === cached) this.deviceMessageKeys.delete(cacheId); });
    }
    return cached.key;
  }

  private async withAccount<T>(operation: (identity: AccountIdentitySnapshot) => Promise<T>): Promise<T> {
    const identity = this.identity;
    if (!identity) throw new Error('Sign in to continue');
    try {
      const result = await operation(identity);
      if (this.identity !== identity) throw new AccountIdentityChangedError();
      return result;
    } catch (error) {
      if (this.identity !== identity) throw new AccountIdentityChangedError();
      // Only a transport-level HTTP 401 invalidates account proof. An encrypted
      // remote tool error containing "401" must never sign the browser out.
      if ((error as { status?: number })?.status === 401) {
        for (const listener of this.authorizationExpiredListeners) listener(identity.token);
      }
      throw error;
    }
  }
}
