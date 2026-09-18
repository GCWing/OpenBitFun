import { HostSessionCallbacks, HostSessionStream } from './HostSessionStream';
import { CloudAccountClient, CloudAccountSession } from './CloudAccountClient';
import { CommandStatusResponse, RemoteCommand } from '../model/RemoteModels';

/** Interactive directory rows must fail fast enough to leave a usable retry. */
export const INTERACTIVE_DIRECTORY_TIMEOUT_MS: number = 15000;

export interface RemoteCommandTransport {
  send<T extends CommandStatusResponse>(command: RemoteCommand, timeoutMs?: number): Promise<T>;
  subscribeSession?(logicalId: string, callbacks: HostSessionCallbacks): HostSessionStream;
  reset(): void;
}

export class AccountDeviceCommandTransport implements RemoteCommandTransport {
  private streams: Set<HostSessionStream> = new Set();
  private readonly client: CloudAccountClient;
  private readonly relayUrl: string;
  private readonly session: CloudAccountSession;
  private readonly targetDeviceId: string;

  constructor(
    client: CloudAccountClient,
    relayUrl: string,
    session: CloudAccountSession,
    targetDeviceId: string
  ) {
    this.client = client;
    this.relayUrl = relayUrl;
    this.session = session;
    this.targetDeviceId = targetDeviceId;
  }

  /**
   * The default is the relay's read timeout, not the room transport's 30 s: an
   * account command crosses one more hop and the desktop may be waking a cold
   * process. It was previously ignored outright, so a caller asking for a
   * shorter deadline silently got two minutes — which is the whole wait a
   * failed device switch used to cost.
   */
  async send<T extends CommandStatusResponse>(command: RemoteCommand, timeoutMs: number = 130000): Promise<T> {
    return this.client.deviceRpc<T>(this.relayUrl, this.session, this.targetDeviceId, command, timeoutMs);
  }

  subscribeSession(logicalId: string, callbacks: HostSessionCallbacks): HostSessionStream {
    this.streams.forEach((existing: HostSessionStream) => { if (existing.isClosed()) this.streams.delete(existing); });
    const stream = this.client.subscribeSession(this.relayUrl, this.session, this.targetDeviceId, logicalId, callbacks);
    this.streams.add(stream);
    return stream;
  }

  reset(): void {
    this.streams.forEach((stream: HostSessionStream) => stream.close());
    this.streams.clear();
    // Account credentials are owned by CloudAccountSessionStore, not by this transport.
  }
}
