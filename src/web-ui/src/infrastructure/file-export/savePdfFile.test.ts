// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { savePdfFile } from './savePdfFile';
const mocks = vi.hoisted(() => ({ native: false, save: vi.fn(), write: vi.fn() }));
vi.mock('@/infrastructure/runtime', () => ({ supportsNativeWindowControls: () => mocks.native }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: mocks.write }));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });
it('saves exact PDF bytes to the path chosen on the viewing device', async () => {
  mocks.native = true; mocks.save.mockResolvedValue('/chosen/review.pdf');
  const bytes = new Uint8Array([37, 80, 68, 70]);
  expect(await savePdfFile('review.pdf', bytes, 'Export')).toBe(true);
  expect(mocks.write).toHaveBeenCalledWith('/chosen/review.pdf', bytes);
});
it('treats a cancelled native picker as cancellation without writing', async () => {
  mocks.native = true; mocks.save.mockResolvedValue(null);
  expect(await savePdfFile('review.pdf', new Uint8Array(), 'Export')).toBe(false);
  expect(mocks.write).not.toHaveBeenCalled();
});
