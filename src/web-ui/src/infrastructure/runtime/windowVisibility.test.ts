// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeCurrentWindowVisibility } from './windowVisibility';

const mocks = vi.hoisted(() => ({
  native: true,
  isVisible: vi.fn(async () => true),
  isMinimized: vi.fn(async () => false),
  onResized: vi.fn(),
  onFocusChanged: vi.fn(),
}));
vi.mock('./environment', () => ({ supportsNativeWindowControls: () => mocks.native }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks }));
let resize: () => void;
let focus: () => void;
let cleanup: (() => void)[];
let stopResize: ReturnType<typeof vi.fn>;
let stopFocus: ReturnType<typeof vi.fn>;
const error = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = true;
  mocks.isVisible.mockResolvedValue(true);
  mocks.isMinimized.mockResolvedValue(false);
  stopResize = vi.fn();
  stopFocus = vi.fn();
  mocks.onResized.mockImplementation(async callback => { resize = callback; return stopResize; });
  mocks.onFocusChanged.mockImplementation(async callback => { focus = callback; return stopFocus; });
  cleanup = [];
});
afterEach(() => { cleanup.forEach(stop => stop()); vi.restoreAllMocks(); });
function observe() {
  const changed = vi.fn();
  cleanup.push(observeCurrentWindowVisibility(changed, error));
  return changed;
}
async function settle() { for (let step = 0; step < 30; step++) await Promise.resolve(); }

it('pauses on native minimization even when the document remains visible and resumes on restore', async () => {
  const changed = observe();
  expect(changed).toHaveBeenLastCalledWith(false);
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  mocks.isMinimized.mockResolvedValue(true);
  resize();
  await settle();
  expect(document.visibilityState).toBe('visible');
  expect(changed).toHaveBeenLastCalledWith(false);
  mocks.isMinimized.mockResolvedValue(false);
  resize();
  await settle();
  expect(changed).toHaveBeenLastCalledWith(true);
  expect(changed).toHaveBeenCalledTimes(4);
});

it('shares subscriptions and native reads across cached panels without treating blur as hidden', async () => {
  const first = observe();
  const second = observe();
  await vi.waitFor(() => expect(second).toHaveBeenLastCalledWith(true));
  expect(mocks.onResized).toHaveBeenCalledOnce();
  expect(mocks.onFocusChanged).toHaveBeenCalledOnce();
  expect(mocks.isMinimized).toHaveBeenCalledOnce();
  focus();
  await settle();
  expect(first).toHaveBeenCalledTimes(2);
  cleanup[0]();
  expect(stopResize).not.toHaveBeenCalled();
  cleanup[1]();
  expect(stopResize).toHaveBeenCalledOnce();
  expect(stopFocus).toHaveBeenCalledOnce();
  cleanup = [];
});

it('discards stale snapshots and serializes a burst of native events', async () => {
  const changed = observe();
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
  let finish!: (minimized: boolean) => void;
  mocks.isMinimized.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  resize();
  resize();
  focus();
  expect(mocks.isMinimized).toHaveBeenCalledTimes(2);
  finish(true);
  await settle();
  expect(mocks.isMinimized).toHaveBeenCalledTimes(3);
  expect(changed).toHaveBeenCalledTimes(2);
});

it('removes listeners that finish registering after the last subscriber leaves', async () => {
  let finish!: (stop: () => void) => void;
  mocks.onResized.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const changed = observe();
  await vi.waitFor(() => expect(mocks.onResized).toHaveBeenCalledOnce());
  cleanup[0]();
  cleanup = [];
  finish(stopResize);
  await settle();
  expect(stopResize).toHaveBeenCalledOnce();
  expect(mocks.onFocusChanged).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(1);
});

it('uses document visibility on web without invoking native APIs', async () => {
  mocks.native = false;
  const changed = observe();
  expect(changed).toHaveBeenLastCalledWith(true);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(changed).toHaveBeenLastCalledWith(false);
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(changed).toHaveBeenLastCalledWith(true);
  expect(mocks.onResized).not.toHaveBeenCalled();
});

it('keeps native hidden state through document visibility changes and recovers from read failure', async () => {
  mocks.isMinimized.mockResolvedValue(true);
  const changed = observe();
  await vi.waitFor(() => expect(mocks.isMinimized).toHaveBeenCalledOnce());
  await settle();
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  expect(changed).toHaveBeenCalledTimes(1);
  mocks.isMinimized.mockRejectedValueOnce(new Error('Transient window query failure'));
  resize();
  await settle();
  expect(error).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenLastCalledWith(false);
  mocks.isMinimized.mockResolvedValue(false);
  focus();
  await settle();
  expect(changed).toHaveBeenLastCalledWith(true);
});
