import { MiniAppActions, MiniAppBridgeReply, MiniAppBridgeRequest, MiniAppHost } from '../../model/MiniAppModels';
import { MiniAppDocument } from '../../services/MiniAppDocument';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MiniAppState } from '../state/MiniAppState';

export class MiniAppViewModel {
  readonly state: MiniAppState = new MiniAppState();
  private generation: number = 0;
  private readonly host: MiniAppHost;
  readonly actions: MiniAppActions = {
    open: (): void => { void this.open(); },
    close: (): void => this.close(),
    back: (): void => { void this.open(); },
    refresh: (): void => { void this.open(); },
    select: (id: string): void => { void this.select(id); },
    request: (raw: string, revision: number): Promise<string> => this.request(raw, revision)
  };

  constructor(host: MiniAppHost) { this.host = host; }

  close(): void {
    this.generation += 1;
    this.state.visible = false;
    this.state.loading = false;
    this.state.document = '';
    this.state.appId = '';
  }

  async open(): Promise<void> {
    const generation = ++this.generation;
    this.state.visible = true;
    this.state.document = '';
    this.state.appId = '';
    this.state.name = '';
    this.state.apps = [];
    this.state.error = '';
    this.state.loading = true;
    try {
      const apps = await this.host.list(RemoteI18n.language());
      if (generation === this.generation) this.state.apps = apps;
    } catch (error) {
      if (generation === this.generation) this.state.error = String(error);
    } finally {
      if (generation === this.generation) this.state.loading = false;
    }
  }

  async select(id: string): Promise<void> {
    const app = this.state.apps.find((entry) => entry.id === id);
    if (!this.state.visible || !app) return;
    const generation = ++this.generation;
    this.state.loading = true;
    this.state.document = '';
    this.state.appId = '';
    this.state.error = '';
    try {
      const html = await this.host.document(id);
      if (generation !== this.generation) return;
      if (!html) throw new Error(RemoteI18n.t('miniapp.invalidPage'));
      this.state.appId = id;
      this.state.name = app.name;
      this.state.document = MiniAppDocument.build(html, RemoteI18n.language());
      this.state.revision += 1;
    } catch (error) {
      if (generation === this.generation) this.state.error = String(error);
    } finally {
      if (generation === this.generation) this.state.loading = false;
    }
  }

  async request(raw: string, revision: number = this.state.revision): Promise<string> {
    const generation = this.generation;
    let id: string = '';
    try {
      const rpc = JSON.parse(raw) as MiniAppBridgeRequest;
      id = rpc.id;
      if (revision !== this.state.revision || typeof id !== 'string' || !rpc.params || !this.state.visible || !this.state.appId ||
        !['storage.get', 'storage.set', 'clipboard.writeText'].includes(rpc.method)) {
        throw new Error(RemoteI18n.t('miniapp.unsupported'));
      }
      const result = await this.host.call(this.state.appId, rpc.method, rpc.params);
      if (generation !== this.generation) throw new Error(RemoteI18n.t('miniapp.closed'));
      const reply: MiniAppBridgeReply = { jsonrpc: '2.0', id, result };
      return JSON.stringify(reply);
    } catch (error) {
      const reply: MiniAppBridgeReply = { jsonrpc: '2.0', id, error: { message: String(error) } };
      return JSON.stringify(reply);
    }
  }
}
