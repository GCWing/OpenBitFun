import { DEFAULT_RPC_TIMEOUT_MS } from './RpcPolicy';
/** Shared account connection. Protocol reference: Happy apiSocket/RpcHandlerManager. */
import { io, type Socket } from 'socket.io-client';
import { RpcPayload } from './RpcPayload';

/** Encrypted `DeviceEvent` forwarded by the Relay from another account device.
 * The Relay sees only ciphertext; the owner decrypts with the pairwise key. */
export interface DeviceEventEnvelope {
  sourceDeviceId: string;
  encrypted_data: string;
  nonce: string;
}
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'closed';
export interface RealtimeOptions {
  url: string;
  token: string;
  machineId?: string;
}

/** One owner per account. Reconnect reauthenticates and signals catch-up; it
 * does not retransmit mutations whose outcome is unknown. */
export class AccountRealtime {
  private readonly socket: Socket;
  private readonly payloads: RpcPayload;
  private epoch = 0;
  private closed = false;
  private readonly deviceEvents = new Set<(envelope: DeviceEventEnvelope) => void>();
  private readonly reconnects = new Set<() => void>();
  private readonly directoryChanges = new Set<() => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private status: ConnectionStatus = 'connecting';

  constructor(options: RealtimeOptions) {
    this.payloads = new RpcPayload(options.url, options.token);
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid Relay URL');
    }
    const path = `${url.pathname.replace(/\/$/, '')}/v1/updates`;
    this.socket = io(url.origin, {
      path, transports: ['websocket'], forceNew: true, autoConnect: false,
      auth: { token: options.token, clientType: options.machineId ? 'machine-scoped' : 'user-scoped',
        ...(options.machineId ? { machineId: options.machineId } : {}) },
      reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000,
      randomizationFactor: 0.5, timeout: 15000,
    });
    this.socket.on('auth-ok', () => {
      if (this.closed) return;
      this.epoch++;
      this.setStatus('connected');
      for (const listener of this.reconnects) listener();
    });
    this.socket.on('disconnect', () => {
      this.epoch++;
      if (!this.closed) this.setStatus('disconnected');
    });
    this.socket.on('connect_error', () => {
      if (!this.closed) this.setStatus('disconnected');
    });
    this.socket.on('ephemeral', (event: unknown) => {
      if (this.closed || !event || typeof event !== 'object') return;
      const type = (event as { type?: unknown }).type;
      if (type === 'device-presence') {
        for (const listener of this.directoryChanges) listener();
      } else if (type === 'device-event') {
        const envelope = parseDeviceEvent(event);
        if (envelope) for (const listener of this.deviceEvents) listener(envelope);
      }
    });
    // Relay-stored session updates ('update') are retired. An older relay may
    // still emit them; they carry nothing this client reads.
    this.socket.connect();
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener); listener(this.status);
    return () => { this.statusListeners.delete(listener); };
  }
  onReconnect(listener: () => void): () => void {
    this.reconnects.add(listener);
    return () => { this.reconnects.delete(listener); };
  }
  onDeviceDirectoryChanged(listener: () => void): () => void {
    this.directoryChanges.add(listener);
    return () => { this.directoryChanges.delete(listener); };
  }
  onDeviceEvent(listener: (envelope: DeviceEventEnvelope) => void): () => void {
    this.deviceEvents.add(listener);
    return () => { this.deviceEvents.delete(listener); };
  }
  private async ready(): Promise<void> {
    if (this.closed) throw new Error('Relay is closed');
    if (this.socket.connected && this.status === 'connected') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Relay connection timed out; request was not submitted')); }, 15000);
      const listener = (status: ConnectionStatus) => {
        if (status === 'connected' || status === 'closed') {
          clearTimeout(timer); stop();
          if (status === 'connected') resolve(); else reject(new Error('Relay is closed'));
        }
      };
      const stop = () => { this.statusListeners.delete(listener); };
      this.statusListeners.add(listener);
      listener(this.status);
    });
  }
  async call<T>(deviceId: string, encryptedParams: unknown, options: { timeoutMs?: number; beforeSend?: () => void } = {}): Promise<T> {
    if (this.closed) throw new Error('Relay is closed; request was not submitted');
      await this.ready();
      options.beforeSend?.();
      const epoch = this.epoch;
      const params = await this.payloads.uploadIfLarge(encryptedParams);
      options.beforeSend?.();
      if (this.closed || this.epoch !== epoch || this.status !== 'connected') {
        throw new Error('Relay connection changed; request was not submitted');
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid RPC timeout');
      const response = await this.socket.timeout(timeoutMs).emitWithAck('rpc-call', {
        method: `${deviceId}:invoke`, params, timeoutMs,
      });
      if (this.closed || this.epoch !== epoch) throw new Error('Relay connection changed; delivery outcome is unknown');
      if (!response || response.ok !== true) throw new Error(response?.error ?? 'Relay RPC failed');
      const result = await this.payloads.resolve(response.result);
      options.beforeSend?.();
      if (this.closed || this.epoch !== epoch) throw new Error('Relay connection changed; delivery outcome is unknown');
      return result as T;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.epoch++;
    this.payloads.close();
    this.socket.disconnect();
    this.socket.removeAllListeners();
    this.setStatus('closed');
    this.statusListeners.clear(); this.reconnects.clear(); this.deviceEvents.clear(); this.directoryChanges.clear();
  }
}

function parseDeviceEvent(value: object): DeviceEventEnvelope | null {
  const event = value as { sourceDeviceId?: unknown; params?: { encrypted_data?: unknown; nonce?: unknown } };
  if (typeof event.sourceDeviceId !== 'string' || !event.params || typeof event.params !== 'object'
    || typeof event.params.encrypted_data !== 'string' || typeof event.params.nonce !== 'string') return null;
  return { sourceDeviceId: event.sourceDeviceId, encrypted_data: event.params.encrypted_data, nonce: event.params.nonce };
}
