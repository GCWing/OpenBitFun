// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInstaller, type UseInstallerReturn } from './useInstaller';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('../i18n', () => ({ default: { changeLanguage: vi.fn(), t: (key: string) => key } }));
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let current: UseInstallerReturn;
function Probe() { current = useInstaller(); return null; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_launch_context') return { previewOnly: false, mode: 'install' };
    if (command === 'get_initial_install_path') return 'D:\\OpenBitFun';
    if (command === 'get_existing_installation') return { detected: false };
    if (command === 'validate_install_path') return { installPath: 'D:\\OpenBitFun' };
    return undefined;
  });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('serializes rapid install clicks and reports a launch failure without reinstalling on retry', async () => {
  const installing = deferred<{ isUpdate: boolean; cleanupPending: boolean }>();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_existing_installation') return { detected: true, mainBinaryPresent: true, installLocation: 'D:\\OpenBitFun' };
    if (command === 'validate_install_path') return { installPath: 'D:\\OpenBitFun' };
    if (command === 'start_installation') return installing.promise;
    if (command === 'launch_application') throw new Error('Launch denied');
  });
  act(() => current.setOptions(prev => ({ ...prev, launchAfterInstall: true })));
  let first!: Promise<void>;
  await act(async () => { first = current.install(); await current.install(); });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'start_installation')).toHaveLength(1);
  act(() => current.closeInstaller());
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'close_installer')).toBe(false);
  await act(async () => { installing.resolve({ isUpdate: true, cleanupPending: false }); await first; });
  expect(current.error).toBe('Launch denied');
  expect(current.installationCompleted).toBe(true);
  await act(async () => current.retryInstall());
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'start_installation')).toHaveLength(1);
});

it('ignores stale disk responses and surfaces a failed query', async () => {
  const old = deferred<{ availableGb: number }>();
  const latest = deferred<{ availableGb: number }>();
  mocks.invoke.mockImplementation((command: string, args: { path: string }) => command === 'get_disk_space'
    ? (args.path === 'old' ? old.promise : latest.promise) : Promise.resolve());
  let first!: Promise<void>; let second!: Promise<void>;
  act(() => { first = current.refreshDiskSpace('old'); second = current.refreshDiskSpace('new'); });
  await act(async () => { latest.reject('Disk query failed'); await second; });
  await act(async () => { old.resolve({ availableGb: 100 }); await first; });
  expect(current.diskSpace).toBeNull();
  expect(current.error).toBe('Disk query failed');
});

it('waits for real uninstall completion and keeps a failure visible', async () => {
  const removing = deferred<null>();
  mocks.invoke.mockImplementation((command: string) => command === 'uninstall' ? removing.promise : Promise.resolve());
  let operation!: Promise<void>;
  await act(async () => { operation = current.startUninstall(); await current.startUninstall(); });
  expect(current.isUninstalling).toBe(true);
  expect(current.uninstallCompleted).toBe(false);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'uninstall')).toHaveLength(1);
  await act(async () => { removing.reject('File is occupied'); await operation; });
  expect(current.uninstallError).toBe('File is occupied');
  expect(current.uninstallCompleted).toBe(false);
  expect(current.isUninstalling).toBe(false);
});

it('keeps immediate install failures visible after normalizing a path and ignores earlier disk-query failures', async () => {
  const disk = deferred<null>();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'get_disk_space') return disk.promise;
    if (command === 'get_existing_installation') return { detected: false };
    if (command === 'validate_install_path') return { installPath: 'D:\\Other\\OpenBitFun' };
    if (command === 'start_installation') throw 'Another maintenance process is already running';
  });
  let query!: Promise<void>;
  act(() => { query = current.refreshDiskSpace('old'); });
  await act(async () => current.install());
  await act(async () => { disk.reject('stale disk error'); await query; });
  expect(current.error).toBe('Another maintenance process is already running');
  expect(current.options.installPath).toBe('D:\\Other\\OpenBitFun');
});
