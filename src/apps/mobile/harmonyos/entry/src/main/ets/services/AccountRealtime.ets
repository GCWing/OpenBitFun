import { webSocket } from '@kit.NetworkKit';
import { RpcPayload } from './RpcPayload';
import { EncryptedPayload } from '../model/RemoteModels';
import { normalizeAccountRelayUrl } from './AccountDeviceLink';

interface EngineOpen { sid: string; pingInterval: number; pingTimeout: number; }
interface Auth { token: string; clientType: string; }
interface RpcCall { method: string; params: Object; timeoutMs: number; }
interface RpcResult { ok: boolean; result?: Object; error?: string; }
interface PendingCall {
  resolve: (value: Object) => void;
  reject: (error: Error) => void;
  timer: number;
}
interface ReadyWaiter { resolve: () => void; reject: (error: Error) => void; timer: number; }

/** JSON/base64 profile of Happy's Engine.IO v4 / Socket.IO v5 transport.
 * Large content uses HTTP, so binary attachments are not part of this profile.
 * The account owner, not pages or pollers, owns heartbeat and reconnection. */
export class AccountRealtime {
  private socket?: webSocket.WebSocket;
  private epoch: number = 0;
  private connected: boolean = false;
  private closed: boolean = false;
  private nextAck: number = 0;
  private retryDelay: number = 1000;
  private reconnectTimer: number = -1;
  private idleTimer: number = -1;
  private idleMs: number = 15000;
  private opened: boolean = false;
  private pending: Map<number, PendingCall> = new Map();
  private waiters: Set<ReadyWaiter> = new Set();
  private updateListeners: Set<(event: string, data: Object) => void> = new Set();
  private reconnectListeners: Set<() => void> = new Set();
  private relayUrl: string;
  private token: string;
  private payloads: RpcPayload;

  constructor(relayUrl: string, token: string) {
    const base = normalizeAccountRelayUrl(relayUrl);
    if (!base) throw new Error('Invalid Relay URL');
    this.relayUrl = base;
    this.token = token;
    this.payloads = new RpcPayload(base, token);
    this.open();
  }

  onUpdate(listener: (event: string, data: Object) => void): () => void {
    this.updateListeners.add(listener);
    return () => { this.updateListeners.delete(listener); };
  }
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => { this.reconnectListeners.delete(listener); };
  }

  async call(target: string, params: EncryptedPayload, timeoutMs: number): Promise<EncryptedPayload> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid RPC timeout');
    if (this.closed) throw new Error('Relay is closed; request was not submitted');
    await this.ready();
    const socket = this.socket;
    const epoch = this.epoch;
    if (!socket || !this.connected || this.closed) throw new Error('Relay disconnected; request was not submitted');
    const wireParams = await this.payloads.uploadIfLarge(params);
    if (this.closed || !this.connected || this.epoch !== epoch) throw new Error('Relay connection changed; request was not submitted');
    const id = this.nextAck++;
    const call: RpcCall = { method: `${target}:invoke`, params: wireParams, timeoutMs: timeoutMs };
    const data = `42${id}${JSON.stringify(['rpc-call', call])}`;
    const reply = await new Promise<Object>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RPC acknowledgement timed out; delivery outcome is unknown'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      socket.send(data).then((sent: boolean) => {
        if (!sent) this.fail(epoch, false);
      }).catch(() => { this.fail(epoch, false); });
    });
    const result = await this.payloads.resolve(reply);
    if (this.closed || this.epoch !== epoch) throw new Error('Relay connection changed; delivery outcome is unknown');
    return result as EncryptedPayload;
  }

  private ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Relay is closed'));
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve: resolve, reject: reject, timer: -1 };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error('Relay connection timed out; request was not submitted'));
      }, 15000);
      this.waiters.add(waiter);
    });
  }

  private open(): void {
    if (this.closed) return;
    const socket = webSocket.createWebSocket();
    const epoch = ++this.epoch;
    this.socket = socket;
    this.opened = false;
    this.idleMs = 15000;
    this.armIdle(epoch);
    socket.on('message', (error, data: string | ArrayBuffer) => {
      if (epoch !== this.epoch || this.closed) return;
      if (error || typeof data !== 'string' || data.length > 256 * 1024) { this.fail(epoch, false); return; }
      try { this.receive(socket, epoch, data); } catch (_) { this.fail(epoch, false); }
    });
    socket.on('close', () => { this.fail(epoch, false); });
    socket.on('error', () => { this.fail(epoch, false); });
    const url = this.relayUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    socket.connect(`${url}/v1/updates/?EIO=4&transport=websocket`)
      .then((success: boolean) => { if (!success) this.fail(epoch, false); })
      .catch(() => { this.fail(epoch, false); });
  }

  private write(socket: webSocket.WebSocket, epoch: number, frame: string): void {
    socket.send(frame).then((sent: boolean) => { if (!sent) this.fail(epoch, false); })
      .catch(() => { this.fail(epoch, false); });
  }

  private receive(socket: webSocket.WebSocket, epoch: number, frame: string): void {
    this.armIdle(epoch);
    if (frame.startsWith('0')) {
      if (this.opened) throw new Error('Duplicate Engine.IO handshake');
      const open = JSON.parse(frame.substring(1)) as EngineOpen;
      if (!open.sid || !Number.isFinite(open.pingInterval) || !Number.isFinite(open.pingTimeout)
        || open.pingInterval <= 0 || open.pingTimeout <= 0) throw new Error('Invalid Engine.IO heartbeat');
      this.opened = true;
      this.idleMs = open.pingInterval + open.pingTimeout;
      this.armIdle(epoch);
      const auth: Auth = { token: this.token, clientType: 'user-scoped' };
      this.write(socket, epoch, `40${JSON.stringify(auth)}`);
    } else if (frame.startsWith('2')) {
      this.write(socket, epoch, `3${frame.substring(1)}`);
    } else if (frame.startsWith('40')) {
      if (!this.opened) throw new Error('Missing Engine.IO handshake');
    } else if (frame.startsWith('44')) {
      this.fail(epoch, true);
    } else if (frame === '1' || frame === '41') {
      this.fail(epoch, false);
    } else if (frame.startsWith('43')) {
      const bracket = frame.indexOf('[', 2);
      const ack = frame.substring(2, bracket);
      if (bracket < 3 || !/^\d+$/.test(ack)) throw new Error('Invalid Socket.IO acknowledgement');
      const id = Number(ack);
      const result = JSON.parse(frame.substring(bracket)) as RpcResult[];
      if (result.length !== 1) throw new Error('Invalid Socket.IO acknowledgement payload');
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (result[0].ok && result[0].result) pending.resolve(result[0].result!);
      else pending.reject(new Error(result[0].error || 'Relay RPC rejected'));
    } else if (frame.startsWith('42[')) {
      const parts = JSON.parse(frame.substring(2)) as Object[];
      if (parts.length < 2 || typeof parts[0] !== 'string') throw new Error('Invalid Socket.IO event');
      const name = parts[0] as string;
      if (name === 'auth-ok') {
      this.connected = true;
      this.retryDelay = 1000;
      this.waiters.forEach((waiter: ReadyWaiter) => { clearTimeout(waiter.timer); waiter.resolve(); });
      this.waiters.clear();
      this.reconnectListeners.forEach((listener: () => void) => { listener(); });
      }
      // Relay-stored session updates ('update') are retired; an older relay may
      // still emit them and no listener reads their body. Presence and
      // encrypted device events (stream hints) arrive as 'ephemeral'.
      if (name === 'ephemeral') {
        this.updateListeners.forEach((listener: (event: string, data: Object) => void) => { listener(name, parts[1]); });
      }
    } else {
      throw new Error('Unsupported Socket.IO packet');
    }
  }

  private armIdle(epoch: number): void {
    if (this.idleTimer >= 0) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.fail(epoch, false); }, this.idleMs);
  }

  private fail(epoch: number, fatal: boolean): void {
    if (epoch !== this.epoch) return;
    this.epoch++;
    this.connected = false;
    if (this.idleTimer >= 0) clearTimeout(this.idleTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) { socket.off('message'); socket.off('close'); socket.off('error'); socket.close().catch(() => {}); }
    this.pending.forEach((call: PendingCall) => {
      clearTimeout(call.timer);
      call.reject(new Error('Relay connection lost; delivery outcome is unknown'));
    });
    this.pending.clear();
    if (fatal) this.closed = true;
    if (this.closed) {
      this.waiters.forEach((waiter: ReadyWaiter) => { clearTimeout(waiter.timer); waiter.reject(new Error('Relay authentication ended')); });
      this.waiters.clear();
      return;
    }
    this.reconnectTimer = setTimeout(() => { this.open(); }, this.retryDelay * (0.5 + Math.random()));
    this.retryDelay = Math.min(5000, this.retryDelay * 2);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.payloads.close();
    if (this.reconnectTimer >= 0) clearTimeout(this.reconnectTimer);
    this.fail(this.epoch, true);
    this.updateListeners.clear(); this.reconnectListeners.clear();
  }
}
