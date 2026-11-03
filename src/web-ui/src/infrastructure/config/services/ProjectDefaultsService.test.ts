import { beforeEach, expect, it, vi } from 'vitest';
import { parseProjectDefaults, readProjectDefaults, saveProjectDefault } from './ProjectDefaultsService';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: mocks.get } }));
vi.mock('./ConfigManager', () => ({ configManager: { updateConfig: mocks.update } }));
beforeEach(() => { vi.clearAllMocks(); resetDeviceSurfaceForTest(); });

it('keeps old hosts on their global defaults and rejects malformed values', async () => {
  mocks.get.mockResolvedValue(undefined);
  await expect(readProjectDefaults('project')).resolves.toEqual({ supported: false, defaults: {} });
  expect(() => parseProjectDefaults({ project: { fast_model: 3 } })).toThrow();
});

it('updates only the selected project field and preserves unknown fields', async () => {
  const current = { a: { primary_model: 'main', future: { keep: true } }, b: { mode: 'Creative' } };
  mocks.update.mockImplementation(async (_path, update) => update(current));
  await expect(saveProjectDefault('a', 'fast_model', 'fast')).resolves.toEqual({ ...current.a, fast_model: 'fast' });
  expect(current.b).toEqual({ mode: 'Creative' });
  await expect(saveProjectDefault('a', 'primary_model', '')).resolves.toEqual({ ...current.a, primary_model: null });
});

it('rejects a read completed on a different device surface', async () => {
  let finish!: (value: unknown) => void;
  mocks.get.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = readProjectDefaults('same-id');
  activateSurface('peer:new-device');
  finish({ 'same-id': { mode: 'Ultimate' } });
  await expect(pending).rejects.toThrow();
});
