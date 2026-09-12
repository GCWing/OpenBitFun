import { util } from '@kit.ArkTS';
import { fileIo as fs } from '@kit.CoreFileKit';
import { MiniAppBridgeParams, MiniAppHost, MiniAppSummary } from '../model/MiniAppModels';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { ClipboardService } from './ClipboardService';

interface BuiltinMiniAppLocale { name: string; description: string; }
interface BuiltinMiniAppEntry { id: string; locales: Record<string, BuiltinMiniAppLocale>; }
interface MiniAppFileError { code?: number; }

/** Only these product-selected bundles may access the local bridge. */
export const BUILTIN_MINIAPP_IDS: string[] = ['builtin-gomoku', 'builtin-regex-playground', 'builtin-daily-divination'];

export class BuiltinMiniAppHost implements MiniAppHost {
  private readonly context: () => Context;
  // Serialize mutations and reads so close/reopen cannot overtake a pending save.
  private storageQueue: Promise<Object | null> = Promise.resolve(null);

  constructor(context: () => Context) { this.context = context; }

  private assertApp(appId: string): void {
    if (!BUILTIN_MINIAPP_IDS.includes(appId)) throw new Error(RemoteI18n.t('miniapp.unsupported'));
  }

  private async resource(name: string): Promise<string> {
    const bytes = await this.context().resourceManager.getRawFileContent(`miniapps/${name}`);
    return util.TextDecoder.create('utf-8').decodeWithStream(bytes);
  }

  async list(locale: string): Promise<MiniAppSummary[]> {
    const catalog = JSON.parse(await this.resource('catalog.json')) as BuiltinMiniAppEntry[];
    return catalog.map((entry: BuiltinMiniAppEntry): MiniAppSummary => {
      this.assertApp(entry.id);
      const copy = entry.locales[locale] || entry.locales['en-US'];
      return { id: entry.id, name: copy.name, description: copy.description };
    });
  }

  async document(appId: string): Promise<string> {
    this.assertApp(appId);
    return this.resource(`${appId}.html`);
  }

  async call(appId: string, method: string, params: MiniAppBridgeParams): Promise<Object | null> {
    this.assertApp(appId);
    if (method === 'clipboard.writeText' && typeof params.text === 'string') {
      await new ClipboardService().writeText(params.text);
      return null;
    }
    if ((method !== 'storage.get' && method !== 'storage.set') || typeof params.key !== 'string' ||
      !this.allowedKey(appId, params.key)) throw new Error(RemoteI18n.t('miniapp.unsupported'));
    const operation = this.storageQueue.then((): Promise<Object | null> => this.storage(appId, method, params));
    this.storageQueue = operation.catch((): null => null);
    return operation;
  }

  private allowedKey(appId: string, key: string): boolean {
    return (appId === 'builtin-gomoku' && key === 'stats') ||
      (appId === 'builtin-regex-playground' && key === 'regex-state') ||
      (appId === 'builtin-daily-divination' && key === 'lastReading');
  }

  private async storage(appId: string, method: string, params: MiniAppBridgeParams): Promise<Object | null> {
    // Stable path across bundle upgrades. Never remove unreadable records.
    const directory = `${this.context().filesDir}/miniapps`;
    const path = `${directory}/${appId}-${params.key}.json`;
    if (method === 'storage.get') {
      try {
        return JSON.parse(await fs.readText(path)) as Object | null;
      } catch (error) {
        if ((error as MiniAppFileError).code === 13900002) return null; // ENOENT only
        throw new Error(String(error));
      }
    }
    await fs.mkdir(directory, true);
    const file = await fs.open(`${path}.tmp`, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      await fs.write(file.fd, JSON.stringify(params.value === undefined ? null : params.value));
      await fs.fsync(file.fd);
    } finally {
      await fs.close(file);
    }
    await fs.rename(`${path}.tmp`, path);
    return null;
  }
}
