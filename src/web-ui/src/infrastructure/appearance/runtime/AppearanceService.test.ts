import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppearancePackageParser } from '../schema/AppearancePackageParser';
import { MemoryAppearanceStorage } from '../storage/AppearanceStorage';
import type { AppearanceCommittedEvent, AppearanceSyncPort } from '../sync/AppearanceSync';
import type {
  AppearanceMarketOrigin,
  AppearancePackage,
  ResolvedAppearance,
  StoredAppearancePackage,
} from '../types';
import { APPEARANCE_SCHEMA_VERSION } from '../types';
import type { AppearanceRuntime } from './AppearanceRuntime';
import { AppearanceService } from './AppearanceService';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const configMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  controllerInvoke: vi.fn(),
  desktop: false,
}));

vi.mock('@/infrastructure/runtime', () => ({ isTauriRuntime: () => configMocks.desktop }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: configMocks.controllerInvoke }));

vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({
  configAPI: configMocks,
}));

function resolved(pkg: AppearancePackage, revision: number): ResolvedAppearance {
  return {
    revision,
    id: pkg.id,
    name: pkg.name,
    version: pkg.version,
    mode: pkg.mode,
    globals: {},
    materials: {},
    components: {},
    scenes: {},
    renderers: {},
    assets: {},
    diagnostics: [],
    cssText: '',
  };
}

function createService() {
  let revision = 0;
  let snapshot: ResolvedAppearance | null = null;
  const runtime = {
    preflight: vi.fn((pkg: AppearancePackage) => resolved(pkg, revision + 1)),
    initialize: vi.fn(async (pkg: AppearancePackage) => {
      snapshot = resolved(pkg, ++revision);
      return snapshot;
    }),
    applyPackage: vi.fn(async (pkg: AppearancePackage) => {
      snapshot = resolved(pkg, ++revision);
      return snapshot;
    }),
    getSnapshot: vi.fn(() => snapshot),
    dispose: vi.fn(async () => undefined),
  } as unknown as AppearanceRuntime;
  const parser = {} as AppearancePackageParser;
  const storage = new MemoryAppearanceStorage();
  return {
    runtime,
    storage,
    service: new AppearanceService(runtime, parser, storage),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MemoryAppearanceSyncPort implements AppearanceSyncPort {
  private readonly listeners = new Set<(event: AppearanceCommittedEvent) => void>();

  publish(event: AppearanceCommittedEvent): void {
    this.listeners.forEach(listener => listener(event));
  }

  subscribe(listener: (event: AppearanceCommittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('AppearanceService', () => {
  beforeEach(() => {
    configMocks.getConfig.mockReset();
    configMocks.setConfig.mockReset();
    configMocks.setConfig.mockResolvedValue(undefined);
    configMocks.controllerInvoke.mockReset();
    configMocks.desktop = false;
    activateSurface('local');
    delete globalThis.__OPENBITFUN_BOOTSTRAP_APPEARANCE_ID__;
    delete globalThis.__OPENBITFUN_BOOTSTRAP_APPEARANCE_SELECTION__;
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    activateSurface('local');
    vi.unstubAllGlobals();
    delete globalThis.__OPENBITFUN_BOOTSTRAP_APPEARANCE_ID__;
    delete globalThis.__OPENBITFUN_BOOTSTRAP_APPEARANCE_SELECTION__;
  });

  it('uses and consumes the desktop bootstrap selection before reading config', async () => {
    globalThis.__OPENBITFUN_BOOTSTRAP_APPEARANCE_ID__ = 'openbitfun-dark';
    globalThis.__OPENBITFUN_BOOTSTRAP_APPEARANCE_SELECTION__ = 'openbitfun-dark';
    const { runtime, service } = createService();

    await service.initialize();

    expect(configMocks.getConfig).not.toHaveBeenCalled();
    expect(runtime.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openbitfun-dark' }),
      {},
    );
    expect(service.getSnapshot()).toMatchObject({
      initialized: true,
      selectedAppearanceId: 'openbitfun-dark',
      resolvedAppearanceId: 'openbitfun-dark',
    });
    expect(Object.prototype.hasOwnProperty.call(globalThis, '__OPENBITFUN_BOOTSTRAP_APPEARANCE_ID__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(globalThis, '__OPENBITFUN_BOOTSTRAP_APPEARANCE_SELECTION__')).toBe(false);
  });

  it('persists explicit selections through appearance.selection', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const { service } = createService();
    await service.initialize();

    await service.select('openbitfun-dark');

    expect(configMocks.setConfig).toHaveBeenCalledWith('appearance.selection', 'openbitfun-dark');
    expect(service.getSnapshot()).toMatchObject({
      selectedAppearanceId: 'openbitfun-dark',
      resolvedAppearanceId: 'openbitfun-dark',
    });
  });

  it.each(['openbitfun-light', 'openbitfun-dark', 'system', 'sample.local'])(
    'keeps the local appearance %s after peer switches and window focus', async selection => {
      configMocks.desktop = true;
      configMocks.getConfig.mockResolvedValue('openbitfun-light'); // The peer's setting must never win.
      configMocks.controllerInvoke.mockResolvedValue(selection);
      let focusListener: (() => void) | undefined;
      let systemListener: (() => void) | undefined;
      const media = {
        matches: false,
        addEventListener: vi.fn((_type: string, listener: () => void) => { systemListener = listener; }),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('window', {
        matchMedia: () => media,
        addEventListener: (type: string, listener: () => void) => { if (type === 'focus') focusListener = listener; },
        removeEventListener: vi.fn(),
      });
      const { service, storage } = createService();
      if (selection === 'sample.local') {
        await storage.put({
          manifest: { schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
            id: selection, name: 'Local skin', version: '1.0.0', mode: 'dark' },
          archive: new ArrayBuffer(1), archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
          assets: {}, importedAt: '2026-08-01T00:00:00.000Z',
        });
      }
      await service.initialize();
      for (const surface of ['peer-a', 'peer-b', 'local']) {
        activateSurface(surface);
        focusListener?.();
        await service.reconcilePersistedState();
        expect(service.getSnapshot().selectedAppearanceId).toBe(selection);
      }
      if (selection === 'system') {
        media.matches = true;
        systemListener?.();
        await vi.waitFor(() => expect(service.getSnapshot().resolvedAppearanceId).toBe('openbitfun-dark'));
      }
      expect(configMocks.getConfig).not.toHaveBeenCalled();
      expect(configMocks.setConfig).not.toHaveBeenCalled();
      expect(configMocks.controllerInvoke).toHaveBeenCalledWith('get_config', {
        request: { path: 'appearance.selection', skipRetryOnNotFound: true },
      });
      await service.dispose();
    },
  );

  it('saves a theme on the controller even when the device changes during persistence', async () => {
    configMocks.desktop = true;
    const pending = deferred<void>();
    configMocks.controllerInvoke.mockImplementation((command: string) => command === 'get_config'
      ? Promise.resolve('openbitfun-dark') : pending.promise);
    const { service } = createService();
    await service.initialize();
    activateSurface('peer-a');
    const write = service.select('openbitfun-light');
    await vi.waitFor(() => expect(configMocks.controllerInvoke).toHaveBeenCalledWith('set_config', {
      request: { path: 'appearance.selection', value: 'openbitfun-light' },
    }));
    activateSurface('peer-b');
    pending.resolve();
    await write;
    expect(service.getSnapshot().selectedAppearanceId).toBe('openbitfun-light');
    expect(configMocks.setConfig).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('rolls a failed peer-mode theme save back on the controller without writing peer config', async () => {
    configMocks.desktop = true;
    configMocks.controllerInvoke.mockResolvedValueOnce('openbitfun-dark')
      .mockRejectedValueOnce(new Error('Local settings are read-only'))
      .mockResolvedValueOnce(undefined);
    const { service } = createService();
    await service.initialize();
    activateSurface('peer-a');
    await expect(service.select('openbitfun-light')).rejects.toThrow('Local settings are read-only');
    expect(service.getSnapshot().selectedAppearanceId).toBe('openbitfun-dark');
    expect(configMocks.controllerInvoke).toHaveBeenLastCalledWith('set_config', {
      request: { path: 'appearance.selection', value: 'openbitfun-dark' },
    });
    expect(configMocks.setConfig).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('reads an older local config without appearance.selection without rewriting it', async () => {
    configMocks.desktop = true;
    configMocks.controllerInvoke.mockRejectedValue(new Error("Config path not found: 'appearance.selection'"));
    const { service } = createService();
    activateSurface('peer-a');
    await service.initialize();
    expect(service.getSnapshot().selectedAppearanceId).toBe('system');
    expect(configMocks.controllerInvoke).toHaveBeenCalledTimes(1);
    expect(configMocks.getConfig).not.toHaveBeenCalled();
    expect(configMocks.setConfig).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('reports a pending selection after its runtime apply while persistence is in flight', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const pendingWrite = deferred<void>();
    configMocks.setConfig.mockReturnValueOnce(pendingWrite.promise);
    const { service } = createService();
    await service.initialize();

    const selection = service.select('openbitfun-dark');
    await vi.waitFor(() => expect(configMocks.setConfig).toHaveBeenCalledOnce());

    expect(service.getSnapshot()).toMatchObject({
      status: 'applying',
      selectedAppearanceId: 'system',
      pendingSelectionId: 'openbitfun-dark',
    });
    expect(service.hasAppliedPendingSelection('openbitfun-dark')).toBe(true);
    expect(service.hasAppliedPendingSelection('openbitfun-light')).toBe(false);

    pendingWrite.resolve(undefined);
    await selection;
    expect(service.hasAppliedPendingSelection('openbitfun-dark')).toBe(false);
  });

  it('reconciles externally persisted selections without writing them again', async () => {
    configMocks.getConfig.mockResolvedValueOnce('system').mockResolvedValueOnce('openbitfun-dark');
    const { service } = createService();
    await service.initialize();

    await service.reconcilePersistedState();

    expect(configMocks.setConfig).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      selectedAppearanceId: 'openbitfun-dark',
      resolvedAppearanceId: 'openbitfun-dark',
    });
  });

  it('falls back locally without overwriting an unavailable configured package', async () => {
    configMocks.getConfig.mockResolvedValue('missing-appearance');
    const { runtime, service } = createService();

    await service.initialize();

    expect(configMocks.setConfig).not.toHaveBeenCalled();
    expect(runtime.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openbitfun-light' }),
      {},
    );
    expect(service.getSnapshot()).toMatchObject({
      selectedAppearanceId: 'system',
      persistedSelectionId: 'missing-appearance',
      unavailableSelectionId: 'missing-appearance',
      resolvedAppearanceId: 'openbitfun-light',
      status: 'degraded',
    });
  });

  it('rehydrates a shared selection when its device-local package becomes available', async () => {
    configMocks.getConfig.mockResolvedValue('market.shared');
    const storage = new MemoryAppearanceStorage();
    const stored: StoredAppearancePackage = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'market.shared', name: 'Shared',
        version: '1.0.0', mode: 'dark',
      },
      archive: new ArrayBuffer(4),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-03T00:00:00.000Z',
    };
    const { runtime } = createService();
    const parser = { parse: vi.fn(async () => stored) } as unknown as AppearancePackageParser;
    const service = new AppearanceService(runtime, parser, storage);

    await service.initialize();
    expect(service.getSnapshot()).toMatchObject({
      status: 'degraded',
      selectedAppearanceId: 'system',
    });

    await service.importPackage(new ArrayBuffer(4));

    expect(configMocks.setConfig).not.toHaveBeenCalled();
    expect(runtime.applyPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'market.shared' }),
      {},
    );
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      persistedSelectionId: 'market.shared',
      selectedAppearanceId: 'market.shared',
      resolvedAppearanceId: 'market.shared',
    });
    expect(service.getSnapshot().unavailableSelectionId).toBeUndefined();
  });

  it('stores market provenance and marks a later manual replacement as a local override', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const storage = new MemoryAppearanceStorage();
    const first: StoredAppearancePackage = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'market.theme', name: 'Market Theme',
        version: '1.0.0', mode: 'dark',
      },
      archive: new ArrayBuffer(4),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-03T00:00:00.000Z',
    };
    const replacement: StoredAppearancePackage = {
      ...first,
      manifest: { ...first.manifest, version: '1.0.1' },
      importedAt: '2026-08-03T01:00:00.000Z',
    };
    const parser = {
      parse: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(replacement),
    } as unknown as AppearancePackageParser;
    const { runtime } = createService();
    const service = new AppearanceService(runtime, parser, storage);
    const origin: AppearanceMarketOrigin = {
      listingId: 'listing-1',
      slug: 'market-theme',
      releaseId: 'release-1',
      releaseNumber: 1,
      packageId: 'market.theme',
      packageVersion: '1.0.0',
      packageSha256: 'a'.repeat(64),
    };
    await service.initialize();

    await service.importPackage(new ArrayBuffer(4), { marketOrigin: origin });
    expect(await storage.get('market.theme')).toMatchObject({
      marketOrigin: origin,
      localOverride: false,
    });

    await service.importPackage(new ArrayBuffer(4));
    expect(await storage.get('market.theme')).toMatchObject({
      marketOrigin: origin,
      localOverride: true,
    });
    expect(service.getSnapshot().appearances.find(item => item.id === 'market.theme')).toMatchObject({
      marketOrigin: origin,
      localOverride: true,
    });
  });

  it('rejects a downloaded package that does not match reviewed market identity', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const storage = new MemoryAppearanceStorage();
    const parsed: StoredAppearancePackage = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'unexpected.theme', name: 'Unexpected',
        version: '1.0.0', mode: 'dark',
      },
      archive: new ArrayBuffer(4),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-03T00:00:00.000Z',
    };
    const parser = { parse: vi.fn(async () => parsed) } as unknown as AppearancePackageParser;
    const { runtime } = createService();
    const service = new AppearanceService(runtime, parser, storage);
    await service.initialize();

    await expect(service.importPackage(new ArrayBuffer(4), {
      marketOrigin: {
        listingId: 'listing-1', slug: 'reviewed-theme', releaseId: 'release-1',
        releaseNumber: 1, packageId: 'reviewed.theme', packageVersion: '1.0.0',
        packageSha256: 'b'.repeat(64),
      },
    })).rejects.toThrow('does not match the reviewed package');
    expect(await storage.get('unexpected.theme')).toBeNull();
  });

  it('rejects a stored noncanonical archive without parsing or rewriting it', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const storage = new MemoryAppearanceStorage();
    const unsupportedArchive = new Uint8Array([1, 1, 1]).buffer;
    const importedAt = '2026-08-03T00:00:00.000Z';
    const unsupported = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: 1, id: 'unsupported.saved', name: 'Unsupported Saved',
        version: '1.0.0', mode: 'dark',
        renderers: {
          'css-tokens': {
            version: 1,
            settings: { tokens: { '--openbitfun-appearance-token-color-bg-primary': '#101820' } },
          },
        },
      },
      archive: unsupportedArchive,
      assets: {},
      importedAt,
    } as unknown as StoredAppearancePackage;
    await storage.put(unsupported);
    const parser = { parse: vi.fn() } as unknown as AppearancePackageParser;
    const { runtime } = createService();
    const service = new AppearanceService(runtime, parser, storage);

    await service.initialize();

    await expect(service.exportPackage('unsupported.saved'))
      .rejects.toThrow('uses an unsupported schema and must be imported again');
    expect(parser.parse).not.toHaveBeenCalled();
    expect(await storage.get('unsupported.saved')).toEqual(unsupported);
  });

  it('rolls the runtime back when selection persistence fails', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const { runtime, service } = createService();
    await service.initialize();
    configMocks.setConfig.mockRejectedValueOnce(new Error('config unavailable'));

    await expect(service.select('openbitfun-dark')).rejects.toThrow('config unavailable');

    expect(runtime.applyPackage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'openbitfun-dark' }),
      {},
    );
    expect(runtime.applyPackage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'openbitfun-light' }),
      {},
    );
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      selectedAppearanceId: 'system',
      resolvedAppearanceId: 'openbitfun-light',
    });
  });

  it('serializes rapid selections and commits the last intent', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const firstWrite = deferred<void>();
    configMocks.setConfig
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    const { runtime, service } = createService();
    await service.initialize();

    const first = service.select('openbitfun-dark');
    const second = service.select('openbitfun-light');
    await vi.waitFor(() => expect(configMocks.setConfig).toHaveBeenCalledTimes(1));
    expect(runtime.applyPackage).toHaveBeenCalledTimes(1);

    firstWrite.resolve(undefined);
    await Promise.all([first, second]);

    expect(configMocks.setConfig.mock.calls).toEqual([
      ['appearance.selection', 'openbitfun-dark'],
      ['appearance.selection', 'openbitfun-light'],
    ]);
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      selectedAppearanceId: 'openbitfun-light',
      resolvedAppearanceId: 'openbitfun-light',
    });
  });

  it('loads explicit previews and falls back to the package background asset', async () => {
    const { service } = createService();
    const storage = new MemoryAppearanceStorage();
    const previewBytes = new Uint8Array([1, 2, 3]).buffer;
    const backgroundBytes = new Uint8Array([4, 5, 6]).buffer;
    const packageBase = {
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      importedAt: '2026-07-29T00:00:00.000Z',
    };
    await storage.put({
      ...packageBase,
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'explicit.preview', name: 'Explicit',
        version: '1.0.0', mode: 'light', preview: { kind: 'asset', assetId: 'hero' },
      },
      assets: { hero: { mimeType: 'image/webp', bytes: previewBytes, width: 16, height: 9 } },
    });
    await storage.put({
      ...packageBase,
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'fallback.preview', name: 'Fallback',
        version: '1.0.0', mode: 'light',
      },
      assets: { background: { mimeType: 'image/png', bytes: backgroundBytes, width: 16, height: 9 } },
    });
    const previewService = new AppearanceService({} as AppearanceRuntime, {} as AppearancePackageParser, storage);

    expect((await previewService.getPreviewAsset('explicit.preview'))?.bytes).toBe(previewBytes);
    expect((await previewService.getPreviewAsset('fallback.preview'))?.bytes).toBe(backgroundBytes);
    expect(await service.getPreviewAsset('missing')).toBeNull();
  });

  it('skips video assets when selecting an implicit preview', async () => {
    const storage = new MemoryAppearanceStorage();
    const videoBytes = new Uint8Array([1, 2, 3]).buffer;
    const posterBytes = new Uint8Array([4, 5, 6]).buffer;
    await storage.put({
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      importedAt: '2026-07-29T00:00:00.000Z',
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'video.preview', name: 'Video',
        version: '1.0.0', mode: 'dark',
      },
      assets: {
        motion: { mimeType: 'video/webm', bytes: videoBytes, width: 1920, height: 1080, durationSeconds: 10 },
        poster: { mimeType: 'image/webp', bytes: posterBytes, width: 1920, height: 1080 },
      },
    });
    const previewService = new AppearanceService({} as AppearanceRuntime, {} as AppearancePackageParser, storage);

    expect((await previewService.getPreviewAsset('video.preview'))?.bytes).toBe(posterBytes);
  });

  it('synchronizes committed selections without persisting them twice', async () => {
    configMocks.getConfig.mockResolvedValue('system');
    const syncPort = new MemoryAppearanceSyncPort();
    const storage = new MemoryAppearanceStorage();
    const createSyncedService = () => {
      let revision = 0;
      const runtime = {
        preflight: vi.fn((pkg: AppearancePackage) => resolved(pkg, revision + 1)),
        initialize: vi.fn(async (pkg: AppearancePackage) => resolved(pkg, ++revision)),
        applyPackage: vi.fn(async (pkg: AppearancePackage) => resolved(pkg, ++revision)),
        getSnapshot: vi.fn(() => null),
        dispose: vi.fn(async () => undefined),
      } as unknown as AppearanceRuntime;
      return new AppearanceService(runtime, {} as AppearancePackageParser, storage, syncPort);
    };
    const first = createSyncedService();
    const second = createSyncedService();
    await Promise.all([first.initialize(), second.initialize()]);

    await first.select('openbitfun-dark');
    await vi.waitFor(() => {
      expect(second.getSnapshot().selectedAppearanceId).toBe('openbitfun-dark');
    });

    expect(configMocks.setConfig).toHaveBeenCalledTimes(1);
    expect(second.getSnapshot()).toMatchObject({
      status: 'ready',
      resolvedAppearanceId: 'openbitfun-dark',
    });
  });

  it('rehydrates an unavailable shared selection across windows after package import', async () => {
    configMocks.getConfig.mockResolvedValue('shared.market-theme');
    const syncPort = new MemoryAppearanceSyncPort();
    const storage = new MemoryAppearanceStorage();
    const stored: StoredAppearancePackage = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'shared.market-theme',
        name: 'Shared Market Theme', version: '1.0.0', mode: 'dark',
      },
      archive: new ArrayBuffer(4),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-03T00:00:00.000Z',
    };
    const createWindowService = (parser: AppearancePackageParser) => {
      let revision = 0;
      const runtime = {
        preflight: vi.fn((pkg: AppearancePackage) => resolved(pkg, revision + 1)),
        initialize: vi.fn(async (pkg: AppearancePackage) => resolved(pkg, ++revision)),
        applyPackage: vi.fn(async (pkg: AppearancePackage) => resolved(pkg, ++revision)),
        getSnapshot: vi.fn(() => null),
        dispose: vi.fn(async () => undefined),
      } as unknown as AppearanceRuntime;
      return new AppearanceService(runtime, parser, storage, syncPort);
    };
    const first = createWindowService({
      parse: vi.fn(async () => stored),
    } as unknown as AppearancePackageParser);
    const second = createWindowService({} as AppearancePackageParser);
    await Promise.all([first.initialize(), second.initialize()]);

    expect(second.getSnapshot()).toMatchObject({
      selectedAppearanceId: 'system',
      persistedSelectionId: 'shared.market-theme',
      unavailableSelectionId: 'shared.market-theme',
    });

    await first.importPackage(new ArrayBuffer(4));
    await vi.waitFor(() => expect(second.getSnapshot().selectedAppearanceId)
      .toBe('shared.market-theme'));

    expect(second.getSnapshot()).toMatchObject({
      status: 'ready',
      persistedSelectionId: 'shared.market-theme',
      resolvedAppearanceId: 'shared.market-theme',
    });
    expect(second.getSnapshot().unavailableSelectionId).toBeUndefined();
    expect(configMocks.setConfig).not.toHaveBeenCalled();
  });

  it('keeps the previous active package when replacing storage fails', async () => {
    const storage = new MemoryAppearanceStorage();
    const oldPackage = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'sample.active', name: 'Old',
        version: '1.0.0', mode: 'dark',
      } as AppearancePackage,
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-07-29T00:00:00.000Z',
    };
    const newPackage = {
      ...oldPackage,
      manifest: { ...oldPackage.manifest, name: 'New', version: '2.0.0' },
      archive: new ArrayBuffer(2),
      importedAt: '2026-07-30T00:00:00.000Z',
    };
    await storage.put(oldPackage);
    configMocks.getConfig.mockResolvedValue('sample.active');
    const runtime = {
      preflight: vi.fn((pkg: AppearancePackage) => resolved(pkg, 1)),
      initialize: vi.fn(async (pkg: AppearancePackage) => resolved(pkg, 1)),
      applyPackage: vi.fn(async (pkg: AppearancePackage) => resolved(pkg, 2)),
      getSnapshot: vi.fn(() => null),
      dispose: vi.fn(async () => undefined),
    } as unknown as AppearanceRuntime;
    const parser = { parse: vi.fn(async () => newPackage) } as unknown as AppearancePackageParser;
    const service = new AppearanceService(runtime, parser, storage);
    await service.initialize();
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(service.importPackage(new ArrayBuffer(3))).rejects.toThrow('storage unavailable');

    expect((await storage.get('sample.active'))?.manifest.version).toBe('1.0.0');
    expect(runtime.applyPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'sample.active', version: '1.0.0' }),
      {},
    );
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      selectedAppearanceId: 'sample.active',
    });
  });

  it('restores a deleted package when catalog refresh fails', async () => {
    const storage = new MemoryAppearanceStorage();
    const stored = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'sample.saved', name: 'Saved',
        version: '1.0.0', mode: 'dark',
      } as AppearancePackage,
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-07-29T00:00:00.000Z',
    };
    await storage.put(stored);
    configMocks.getConfig.mockResolvedValue('system');
    const { runtime } = createService();
    const service = new AppearanceService(runtime, {} as AppearancePackageParser, storage);
    await service.initialize();
    vi.spyOn(storage, 'listCatalog').mockRejectedValueOnce(new Error('catalog unavailable'));

    await expect(service.deletePackage('sample.saved')).rejects.toThrow('catalog unavailable');

    expect(await storage.get('sample.saved')).toEqual(stored);
    expect(configMocks.setConfig).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      selectedAppearanceId: 'system',
    });
  });

  it('restores package, selection, and runtime when active deletion cannot persist', async () => {
    const storage = new MemoryAppearanceStorage();
    const stored = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'sample.active-delete', name: 'Active',
        version: '1.0.0', mode: 'dark',
      } as AppearancePackage,
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-07-29T00:00:00.000Z',
    };
    await storage.put(stored);
    configMocks.getConfig.mockResolvedValue('sample.active-delete');
    const { runtime } = createService();
    const service = new AppearanceService(runtime, {} as AppearancePackageParser, storage);
    await service.initialize();
    configMocks.setConfig
      .mockRejectedValueOnce(new Error('config unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(service.deletePackage('sample.active-delete')).rejects.toThrow('config unavailable');

    expect(await storage.get('sample.active-delete')).toEqual(stored);
    expect(configMocks.setConfig.mock.calls).toEqual([
      ['appearance.selection', 'system'],
      ['appearance.selection', 'sample.active-delete'],
    ]);
    expect(runtime.applyPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'sample.active-delete' }),
      {},
    );
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      selectedAppearanceId: 'sample.active-delete',
      resolvedAppearanceId: 'sample.active-delete',
    });
  });

  it('reports the actual runtime when active deletion rollback is incomplete', async () => {
    const storage = new MemoryAppearanceStorage();
    const stored = {
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'sample.degraded-delete', name: 'Degraded',
        version: '1.0.0', mode: 'dark',
      } as AppearancePackage,
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-07-29T00:00:00.000Z',
    };
    await storage.put(stored);
    configMocks.getConfig.mockResolvedValue('sample.degraded-delete');
    let runtimeSnapshot = resolved(stored.manifest, 1);
    const runtime = {
      preflight: vi.fn((pkg: AppearancePackage) => resolved(pkg, 2)),
      initialize: vi.fn(async () => runtimeSnapshot),
      applyPackage: vi.fn()
        .mockImplementationOnce(async (pkg: AppearancePackage) => {
          runtimeSnapshot = resolved(pkg, 2);
          return runtimeSnapshot;
        })
        .mockRejectedValueOnce(new Error('runtime rollback unavailable')),
      getSnapshot: vi.fn(() => runtimeSnapshot),
      dispose: vi.fn(async () => undefined),
    } as unknown as AppearanceRuntime;
    const service = new AppearanceService(runtime, {} as AppearancePackageParser, storage);
    await service.initialize();
    configMocks.setConfig
      .mockRejectedValueOnce(new Error('config unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(service.deletePackage('sample.degraded-delete')).rejects.toThrow('config unavailable');

    expect(await storage.get('sample.degraded-delete')).toEqual(stored);
    expect(service.getSnapshot()).toMatchObject({
      status: 'degraded',
      selectedAppearanceId: 'system',
      resolvedAppearanceId: 'openbitfun-light',
      current: expect.objectContaining({ id: 'openbitfun-light' }),
    });
  });

  it('reconciles a missed selection event when the window regains focus', async () => {
    let focusListener: (() => void) | undefined;
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'focus') focusListener = listener;
      }),
      removeEventListener: vi.fn(),
    });
    configMocks.getConfig.mockResolvedValueOnce('system').mockResolvedValueOnce('openbitfun-dark');
    const { service } = createService();
    await service.initialize();

    focusListener?.();
    await vi.waitFor(() => {
      expect(service.getSnapshot().selectedAppearanceId).toBe('openbitfun-dark');
    });

    expect(configMocks.setConfig).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      resolvedAppearanceId: 'openbitfun-dark',
    });
  });

  it('does not reapply an unchanged imported appearance when the window regains focus', async () => {
    let focusListener: (() => void) | undefined;
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'focus') focusListener = listener;
      }),
      removeEventListener: vi.fn(),
    });
    configMocks.getConfig.mockResolvedValue('sample.dynamic');
    const { runtime, service, storage } = createService();
    await storage.put({
      manifest: {
        schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'sample.dynamic', name: 'Dynamic',
        version: '1.0.0', mode: 'dark',
      },
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-01T00:00:00.000Z',
    });
    await service.initialize();

    focusListener?.();
    await vi.waitFor(() => expect(configMocks.getConfig).toHaveBeenCalledTimes(2));

    expect(runtime.applyPackage).not.toHaveBeenCalled();
    expect(service.getSnapshot().current?.revision).toBe(1);
  });

  it('reapplies an imported appearance when its stored revision changes', async () => {
    let focusListener: (() => void) | undefined;
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === 'focus') focusListener = listener;
      }),
      removeEventListener: vi.fn(),
    });
    configMocks.getConfig.mockResolvedValue('sample.dynamic');
    const { runtime, service, storage } = createService();
    const manifest: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION, id: 'sample.dynamic', name: 'Dynamic',
      version: '1.0.0', mode: 'dark',
    };
    await storage.put({
      manifest,
      archive: new ArrayBuffer(1),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-01T00:00:00.000Z',
    });
    await service.initialize();
    await storage.put({
      manifest: { ...manifest, name: 'Dynamic Updated' },
      archive: new ArrayBuffer(2),
      archiveSchemaVersion: APPEARANCE_SCHEMA_VERSION,
      assets: {},
      importedAt: '2026-08-02T00:00:00.000Z',
    });

    focusListener?.();
    await vi.waitFor(() => expect(runtime.applyPackage).toHaveBeenCalledTimes(1));

    expect(service.getSnapshot()).toMatchObject({
      status: 'ready',
      current: expect.objectContaining({ name: 'Dynamic Updated', revision: 2 }),
    });
  });
});
