/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import GenUILibrarySection from './GenUILibrarySection';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const ports = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), watch: vi.fn(), changed: undefined as undefined | (() => void) }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: ports.read } }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  setConfig: ports.save,
  watch: (_path: string, changed: () => void) => { ports.changed = changed; return ports.watch; },
} }));

let container: HTMLDivElement, root: Root;
const mount = () => act(async () => root.render(<GenUILibrarySection />));
const select = async (value: string) => act(async () => {
  const input = container.querySelector('select')!;
  input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  ports.read.mockReset().mockResolvedValue('openui'); ports.save.mockReset().mockResolvedValue(undefined); ports.watch.mockReset();
  activateSurface('local');
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); activateSurface('local'); });

it('selects a collection without rendering a demo preview', async () => {
  await mount();
  expect(container.querySelector('[data-gen-ui-app]')).toBeNull();
  expect(container.querySelector('.gen-ui-library-preview')).toBeNull();
  expect(container.querySelector('[data-openbitfun-part="profile"]')).toBeNull();
  expect(container.querySelector('[data-openbitfun-part="designSpec"]')).toBeNull();
  await select('openbitfun');
  expect(ports.save).toHaveBeenCalledExactlyOnceWith('ai.generative_ui_library', 'openbitfun');
});
it('locks unavailable settings and preserves unknown future selections', async () => {
  ports.read.mockRejectedValueOnce(new Error('Unsupported host'));
  await mount();
  expect(container.textContent).toContain('Unsupported host');
  expect(container.querySelector('select')).toBeNull(); expect(ports.save).not.toHaveBeenCalled();
  ports.read.mockResolvedValue('future.collection');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('select')?.value).toBe('future.collection');
  expect(container.querySelector('[data-gen-ui-app]')).toBeNull(); expect(ports.save).not.toHaveBeenCalled();
});
it('keeps the committed selection and exposes save failures', async () => {
  ports.save.mockRejectedValueOnce(new Error('Offline'));
  await mount(); await select('openbitfun');
  expect(container.textContent).toContain('Offline');
  expect(container.querySelector('select')?.value).toBe('openui');
  expect(container.querySelector('[data-gen-ui-app]')).toBeNull();
});
it('discards stale reads after an acknowledged selection', async () => {
  await mount();
  const stale = deferred<string>(); ports.read.mockReturnValueOnce(stale.promise);
  await act(async () => ports.changed!());
  await select('openbitfun');
  await act(async () => stale.resolve('openui'));
  expect(container.querySelector('select')?.value).toBe('openbitfun');
});
it('cannot replace a new device selection with an old device save', async () => {
  await mount();
  const pending = deferred<void>(); ports.save.mockReturnValueOnce(pending.promise);
  await select('openbitfun');
  ports.read.mockResolvedValue('openbitfun');
  await act(async () => activateSurface('peer-test'));
  await act(async () => pending.resolve());
  expect(container.querySelector('select')?.value).toBe('openbitfun');
  expect(container.querySelector('[data-gen-ui-app]')).toBeNull();
});
it('cannot hydrate an old device read after a switch', async () => {
  const pending = deferred<string>(); ports.read.mockReturnValueOnce(pending.promise);
  await mount(); ports.read.mockResolvedValue('openbitfun');
  await act(async () => activateSurface('peer-test'));
  await act(async () => pending.resolve('openbitfun'));
  expect(container.querySelector('select')?.value).toBe('openbitfun');
});
