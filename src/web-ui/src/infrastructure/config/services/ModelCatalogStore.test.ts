import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { aiApi, type AIModelCatalog } from '@/infrastructure/api/service-api/AIApi';
import { configManager } from './ConfigManager';
import { createModelCatalogStore } from './ModelCatalogStore';

vi.mock('@/infrastructure/api/service-api/AIApi', () => ({ aiApi: {
  getModelCatalog: vi.fn(), onModelCatalogUpdated: vi.fn(() => () => {}),
} }));
vi.mock('./ConfigManager', () => ({ configManager: {
  onConfigChange: vi.fn(() => () => {}),
} }));
const catalog = (version: number): AIModelCatalog => ({ version, models: [] });
const deferred = () => {
  let resolve!: (value: AIModelCatalog) => void;
  const promise = new Promise<AIModelCatalog>(done => { resolve = done; });
  return { promise, resolve };
};
describe('shared model catalog', () => {
  beforeEach(() => { activateSurface('local'); vi.clearAllMocks(); });

  it('shares concurrent selectors, retains warm data on errors, and ignores preference writes', async () => {
    vi.mocked(aiApi.getModelCatalog).mockResolvedValue(catalog(1));
    const store = createModelCatalogStore();
    const offA = store.subscribe(vi.fn());
    const offB = store.subscribe(vi.fn());
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    expect(aiApi.getModelCatalog).toHaveBeenCalledTimes(1);
    vi.mocked(configManager.onConfigChange).mock.calls[0][0]('ai.agent_model_defaults.mode');
    expect(aiApi.getModelCatalog).toHaveBeenCalledTimes(1);
    vi.mocked(aiApi.getModelCatalog).mockRejectedValueOnce(new Error('offline'));
    await store.refresh();
    expect(store.getSnapshot()).toEqual({ catalog: catalog(1), status: 'ready' });
    offA(); offB();
  });

  it('replays an invalidation arriving during a read and discards the superseded result', async () => {
    const first = deferred();
    vi.mocked(aiApi.getModelCatalog).mockReturnValueOnce(first.promise).mockResolvedValue(catalog(2));
    const store = createModelCatalogStore();
    const off = store.subscribe(vi.fn());
    await Promise.resolve();
    vi.mocked(configManager.onConfigChange).mock.calls[0][0]('ai.models');
    first.resolve(catalog(1));
    await vi.waitFor(() => expect(store.getSnapshot().catalog?.version).toBe(2));
    expect(aiApi.getModelCatalog).toHaveBeenCalledTimes(2);
    off();
  });

  it('never publishes an old host response on a new activation', async () => {
    const old = deferred();
    vi.mocked(aiApi.getModelCatalog).mockReturnValueOnce(old.promise).mockResolvedValue(catalog(2));
    const store = createModelCatalogStore();
    const off = store.subscribe(vi.fn());
    await Promise.resolve();
    activateSurface('peer');
    expect(store.getSnapshot().catalog).toBeNull();
    await vi.waitFor(() => expect(store.getSnapshot().catalog?.version).toBe(2));
    old.resolve(catalog(1));
    await Promise.resolve();
    expect(store.getSnapshot().catalog?.version).toBe(2);
    off();
  });
});
