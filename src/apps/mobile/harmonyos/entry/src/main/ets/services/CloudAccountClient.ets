import { normalizeAccountRelayUrl, OFFICIAL_RELAY_URL } from './AccountDeviceLink';
import { http } from '@kit.NetworkKit';
import { CloudAccountCrypto } from './CloudAccountCrypto';
import { X25519 } from './X25519';
import { Encoding } from './Encoding';
import { HarmonyRemoteCryptoCipher } from './RemoteCrypto';
import { OhosError } from './OhosError';
import { RemoteLogger } from './RemoteLogger';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { CommandStatusResponse, EncryptedPayload, RemoteCommand } from '../model/RemoteModels';

interface AccountAuthResponse { token: string; user_id: string; }
interface GitHubStart {
  transactionId: string; transactionSecret: string; authorizationUrl: string;
  expiresAt: number; pollIntervalSeconds: number;
}
interface GitHubPollRequest { transactionId: string; transactionSecret: string; }
interface GitHubTokens { accessToken: string; }
interface GitHubPoll { status: string; tokens?: GitHubTokens; }
interface LoginRequest {
  access_token: string; device_id: string; device_name: string; device_kind: string;
  public_key: string; request_id: string;
}
interface PeerPublicKey { public_key: string; }
interface RelayErrorResponse { error?: string; }

interface NetworkRequestFailure { code?: number; }

export class CloudAccountTransportError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`Account transport failed (code=${code}).`);
    this.code = code;
  }
}

export class CloudAccountRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'CloudAccountRequestError';
    this.statusCode = statusCode;
  }
}

export interface CloudAccountSession {
  token: string;
  userId: string;
  masterKey: Uint8Array;
}

/** The live account client plus the session it is currently signed in with. */
export interface CloudAccountBinding {
  client: CloudAccountClient;
  relayUrl: string;
  session: CloudAccountSession;
}

export interface CloudAccountDevice {
  deviceId: string;
  deviceName: string;
  deviceKind?: string;
  online: boolean;
  lastSeenAt?: number;
}

/** A device credential minted for another device, never for this one. */
export interface CloudProvisionedDevice {
  token: string;
  userId: string;
  deviceId: string;
  deviceSecret: Uint8Array;
}

interface ProvisionDeviceRequest {
  public_key: string;
  device_id: string;
  device_name: string;
  device_kind: string;
  request_id: string;
}

interface ProvisionDeviceWire {
  token: string;
  user_id: string;
  device_id: string;
}

interface CloudAccountDeviceWire {
  device_id: string;
  device_name: string;
  device_kind?: string;
  online: boolean;
  last_seen_at?: number;
}

/** Default OpenBitFun cloud relay used by the desktop account flow. */
export const DEFAULT_CLOUD_RELAY_URL: string = OFFICIAL_RELAY_URL;

/** Device kinds the relay accepts; mirrors `relay-service/src/db.rs::DEVICE_KINDS`. */
const DEVICE_KIND_DESKTOP: string = 'desktop';
const DEVICE_KIND_MOBILE: string = 'mobile';
const DEVICE_KIND_WATCH: string = 'watch';

/**
 * Device names our own non-desktop builds register under, lowercased.
 *
 * Only labels we hardcode ourselves belong here: the Android client reports
 * `Build.MODEL` (`android/.../DeviceInstall.kt:27`), an arbitrary string that
 * guessing at would hide desktops as readily as phones.
 *
 * Kept in step with `shared/core-transport/.../CloudAccountClient.kt`, which
 * carries the same list for the Android and iOS clients.
 */
const KNOWN_NON_DESKTOP_DEVICE_NAMES: string[] = ['harmonyos phone', 'harmonyos watch'];

/**
 * Whether a relay device row is a desktop, and so controllable from a phone.
 *
 * A row that reports its kind is taken at its word. A row without one predates
 * the relay learning about kinds, and is judged by two weaker signals: this
 * phone's own row is never a desktop, and neither is one carrying a name our
 * own builds register under. Anything else stays visible — hiding a real
 * desktop would strand the user, while a stale phone row disappears the next
 * time that phone logs in against a relay that stores kinds.
 */
function isDesktopDeviceRow(device: CloudAccountDeviceWire, selfDeviceId: string): boolean {
  const kind = (device.device_kind || '').trim();
  if (kind.length > 0) {
    return kind === DEVICE_KIND_DESKTOP;
  }
  if (selfDeviceId.length > 0 && device.device_id === selfDeviceId) {
    return false;
  }
  const name = (device.device_name || '').trim().toLowerCase();
  return KNOWN_NON_DESKTOP_DEVICE_NAMES.indexOf(name) < 0;
}

/** Client for the current desktop relay account protocol. */
interface DeviceKeyPair { privateKey: Uint8Array; publicKey: Uint8Array; }

export class CloudAccountClient {
  private readonly cipher: HarmonyRemoteCryptoCipher = new HarmonyRemoteCryptoCipher();

  private authorizationGeneration: number = 0;

  cancelAuthorization(): void { this.authorizationGeneration++; }

  async login(relayUrl: string, deviceId: string, openAuthorization: (url: string) => Promise<boolean>, deviceSecret: Uint8Array): Promise<CloudAccountSession> {
    const generation = ++this.authorizationGeneration;
    const startRequest: Record<string, string> = {};
    const start = await this.post<GitHubStart>(relayUrl, '/api/auth/github/start', startRequest);
    if (generation !== this.authorizationGeneration) throw new Error('Sign-in cancelled.');
    if (!start.authorizationUrl.startsWith('https://github.com/login/oauth/authorize?')) {
      throw new Error('Untrusted account authorization URL.');
    }
    if (!await openAuthorization(start.authorizationUrl)) throw new Error('Could not open GitHub sign-in.');
    const deadline = Math.min(start.expiresAt * 1000, Date.now() + 600000);
    while (Date.now() < deadline && generation === this.authorizationGeneration) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(30, Math.max(1, start.pollIntervalSeconds)) * 1000));
      if (generation !== this.authorizationGeneration) break;
      const request: GitHubPollRequest = { transactionId: start.transactionId, transactionSecret: start.transactionSecret };
      const poll = await this.post<GitHubPoll>(relayUrl, '/api/auth/github/poll', request);
      if (generation !== this.authorizationGeneration) break;
      if (poll.status === 'authorized' && poll.tokens?.accessToken) {
        if (deviceSecret.length !== 32) throw new Error('Invalid device identity.');
        const keys: DeviceKeyPair = { privateKey: new Uint8Array(deviceSecret), publicKey: X25519.scalarMultBase(deviceSecret) };
        const body: LoginRequest = {
          access_token: poll.tokens.accessToken, device_id: deviceId, device_name: 'HarmonyOS Phone',
          device_kind: DEVICE_KIND_MOBILE, public_key: Encoding.bytesToBase64(keys.publicKey),
          request_id: Encoding.randomId('').slice(1)
        };
        try {
          const auth = await this.post<AccountAuthResponse>(relayUrl, '/api/auth/login', body);
          if (generation !== this.authorizationGeneration) throw new Error('Sign-in cancelled.');
          if (!auth.token || !auth.user_id) throw new Error('Invalid account identity.');
          return { token: auth.token, userId: auth.user_id, masterKey: keys.privateKey };
        } catch (err) {
          keys.privateKey.fill(0);
          throw OhosError.wrap('GitHub sign-in', err);
        }
      }
      if (poll.status === 'expired' || poll.status === 'denied') break;
    }
    throw new Error('GitHub sign-in expired or was cancelled.');
  }

  async provisionDevice(
    relayUrl: string,
    session: CloudAccountSession,
    deviceId: string,
    deviceName: string,
    requestId: string
  ): Promise<CloudProvisionedDevice> {
    const keys = X25519.generateKeyPair();
    const body: ProvisionDeviceRequest = {
      public_key: Encoding.bytesToBase64(keys.publicKey),
      device_id: deviceId,
      device_name: deviceName,
      device_kind: DEVICE_KIND_WATCH,
      request_id: requestId
    };
    const wire = await this.request<ProvisionDeviceWire>(
      relayUrl, '/api/auth/provision-device', 'POST', body, session.token);
    const token = (wire.token || '').trim();
    const userId = (wire.user_id || '').trim();
    const provisionedDeviceId = (wire.device_id || '').trim();
    if (token.length === 0 || userId !== session.userId || provisionedDeviceId !== deviceId) {
      // A credential naming a different account or device would sign the watch
      // in as somebody else. Refuse rather than pass it on.
      throw new Error('Relay returned a mismatched provisioned device identity.');
    }
    return { token, userId, deviceId: provisionedDeviceId, deviceSecret: keys.privateKey };
  }

  /**
   * The account's controllable devices — desktops only.
   *
   * A relay that stores device kinds already filters this list; the client
   * repeats the judgement so a phone stops listing itself and its peers before
   * that relay is deployed. [selfDeviceId] is this install's own device id.
   */
  async listDevices(
    relayUrl: string,
    session: CloudAccountSession,
    selfDeviceId: string = ''
  ): Promise<CloudAccountDevice[]> {
    const devices = await this.request<CloudAccountDeviceWire[]>(relayUrl, '/api/devices', 'GET', undefined, session.token);
    const desktops = devices.filter((device: CloudAccountDeviceWire): boolean =>
      isDesktopDeviceRow(device, selfDeviceId));
    return desktops.map((device: CloudAccountDeviceWire): CloudAccountDevice => ({
      deviceId: device.device_id,
      deviceName: device.device_name || device.device_id,
      deviceKind: device.device_kind,
      online: device.online,
      lastSeenAt: device.last_seen_at
    }));
  }

  /**
   * [timeoutMs] defaults to the relay's own patience for a device that is slow
   * to answer. A caller with a reason to give up earlier — a handshake, where
   * silence means the desktop is gone rather than busy — passes its own.
   */
  async deviceRpc<T extends CommandStatusResponse>(
    relayUrl: string,
    session: CloudAccountSession,
    targetDeviceId: string,
    command: RemoteCommand,
    timeoutMs: number = 130000
  ): Promise<T> {
    const target = targetDeviceId.trim();
    if (target.length === 0) {
      throw new Error('Remote target device is required.');
    }
    const peer = await this.request<PeerPublicKey>(relayUrl,
      `/api/devices/${encodeURIComponent(target)}/key`, 'GET', undefined, session.token);
    const messageKey = await CloudAccountCrypto.deriveDeviceKey(session.masterKey, Encoding.base64ToBytes(peer.public_key));
    const nonce = Encoding.randomBytes(12);
    const encrypted = await this.cipher.encrypt(
      Encoding.utf8ToBytes(JSON.stringify(command)),
      messageKey,
      nonce
    );
    const body: EncryptedPayload = {
      encrypted_data: Encoding.bytesToBase64(encrypted),
      nonce: Encoding.bytesToBase64(nonce)
    };
    RemoteLogger.info(`device rpc cmd=${command.cmd || 'unknown'} bytes=${body.encrypted_data.length}`);
    const response = await this.request<EncryptedPayload>(
      relayUrl,
      `/api/devices/${encodeURIComponent(target)}/rpc`,
      'POST',
      body,
      session.token,
      timeoutMs
    );
    const plain = await this.cipher.decrypt(
      Encoding.base64ToBytes(response.encrypted_data),
      messageKey,
      Encoding.base64ToBytes(response.nonce)
    );
    const parsed = Encoding.parseJsonObject<T>(Encoding.bytesToUtf8(plain));
    if (parsed.resp === 'error') {
      throw new Error(parsed.message || 'Remote device command failed.');
    }
    return parsed;
  }

  private async post<T>(relayUrl: string, path: string, body: Object): Promise<T> {
    return this.request<T>(relayUrl, path, 'POST', body);
  }

  private async request<T>(
    relayUrl: string,
    path: string,
    method: string,
    body?: Object,
    token: string = '',
    readTimeoutMs: number = 120000
  ): Promise<T> {
    const request = http.createHttp();
    const base = normalizeAccountRelayUrl(relayUrl);
    if (!base) throw new Error('Invalid Relay URL');
    // Timed so the watch has something to be slow relative to. Phone and watch
    // reach the same relay and the same desktop, so a gap between them is the
    // client's own cost and a shared floor is the round trip's.
    const startedAt = Date.now();
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
      if (token.length > 0) headers.Authorization = `Bearer ${token}`;
      const requestOptions: http.HttpRequestOptions = {
        method: method === 'GET' ? http.RequestMethod.GET : method === 'DELETE' ? http.RequestMethod.DELETE : http.RequestMethod.POST,
        header: headers,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 15000,
        readTimeout: readTimeoutMs
      };
      let bodyBytes = 0;
      if (body !== undefined) {
        const encoded = JSON.stringify(body);
        bodyBytes = encoded.length;
        requestOptions.extraData = encoded;
      }
      const response = await request.request(`${base}${path}`, requestOptions);
      const text = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
      // `tls` is cumulative from request start: near zero means the connection
      // was reused, and anything large is a handshake this call paid for alone.
      const timing = response.performanceTiming;
      RemoteLogger.info(`relay ${method} ${path} status=${response.responseCode} elapsed_ms=${Date.now() - startedAt}` +
        ` dns=${Math.round(timing.dnsTiming)} tcp=${Math.round(timing.tcpTiming)}` +
        ` tls=${Math.round(timing.tlsTiming)} ttfb=${Math.round(timing.firstReceiveTiming)}`);
      if (response.responseCode < 200 || response.responseCode >= 300) {
        // The size belongs in the log: a body the relay refuses for being too
        // big is otherwise indistinguishable from one it refuses for auth.
        RemoteLogger.error(`relay request failed ${method} ${path} status=${response.responseCode} bytes=${bodyBytes}`);
        let message = response.responseCode === 413 ? RemoteI18n.t('errors.payloadTooLarge') :
          `Relay request failed (HTTP ${response.responseCode}).`;
        try {
          const error = JSON.parse(text) as RelayErrorResponse;
          if (error.error) message = error.error;
        } catch (_err) {
          // Keep the status-based error when the relay did not return JSON.
        }
        throw new CloudAccountRequestError(message, response.responseCode);
      }
      return JSON.parse(text) as T;
    } catch (err) {
      const code = (err as NetworkRequestFailure).code;
      if (typeof code === 'number') {
        RemoteLogger.warn(`relay transport failed method=${method} path=${path} code=${code}`);
        throw new CloudAccountTransportError(code);
      }
      throw OhosError.wrap('relay request', err);
    } finally {
      request.destroy();
    }
  }
}
