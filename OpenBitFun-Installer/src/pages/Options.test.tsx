// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Options } from './Options';
import { ThemeSetup } from './ThemeSetup';
import { WindowControls } from '../components/WindowControls';
import { invoke } from '@tauri-apps/api/core';
import type { InstallOptions } from '../types/installer';

const mocks = vi.hoisted(() => ({ minimize: vi.fn(), close: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks }));

const initial: InstallOptions = {
  installPath: 'D:\\OpenBitFun', desktopShortcut: false, startMenu: true,
  launchAfterInstall: false, appLanguage: 'en-US', themePreference: 'system', modelConfig: null,
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it('updates an install option once per label or native input click and keeps the path editable', async () => {
  const changed = vi.fn();
  const clearError = vi.fn();
  const refreshDiskSpace = vi.fn().mockResolvedValue(undefined);
  function Page() {
    const [options, setOptions] = useState(initial);
    return <Options options={options} setOptions={value => { changed(value); setOptions(value); }}
      diskSpace={null} error={null} refreshDiskSpace={refreshDiskSpace}
      existingInstall={null} onLaunchRegisteredUninstaller={vi.fn()} onBack={vi.fn()}
      onInstall={vi.fn()} isInstalling={false} clearInstallError={clearError} />;
  }
  await act(async () => root.render(<Page />));
  const label = container.querySelector<HTMLLabelElement>('[data-openbitfun-component="checkbox"]')!;
  const checkbox = label.querySelector('input')!;
  expect(checkbox.checked).toBe(false);
  act(() => label.click());
  expect(checkbox.checked).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  act(() => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
  act(() => checkbox.focus());
  expect(document.activeElement).toBe(checkbox);
  expect(checkbox.tabIndex).toBe(0);

  const path = container.querySelector<HTMLInputElement>('[data-openbitfun-component="input"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(path, 'D:\\Apps\\OpenBitFun');
    path.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(path.value).toBe('D:\\Apps\\OpenBitFun');
  expect(clearError).toHaveBeenCalledTimes(1);
  expect(refreshDiskSpace).toHaveBeenLastCalledWith('D:\\Apps\\OpenBitFun');
});

it('keeps path and install/navigation actions disabled during installation', async () => {
  const install = vi.fn();
  await act(async () => root.render(<Options options={initial} setOptions={vi.fn()}
    diskSpace={null} error={null} refreshDiskSpace={vi.fn()} existingInstall={null}
    onLaunchRegisteredUninstaller={vi.fn()} onBack={vi.fn()} onInstall={install}
    isInstalling clearInstallError={vi.fn()} />));
  expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.disabled).toBe(true);
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons).toHaveLength(3);
  for (const button of buttons) {
    expect(button.disabled).toBe(true);
    expect(button.dataset.openbitfunComponent).toBe('button');
    act(() => button.click());
  }
  expect(install).not.toHaveBeenCalled();
});

it('connects launch-after-install on the theme page and preserves window control handlers', async () => {
  const changed = vi.fn();
  await act(async () => root.render(<><ThemeSetup options={initial} setOptions={changed}
    onLaunch={vi.fn()} onClose={vi.fn()} /><WindowControls /></>));
  const label = container.querySelector<HTMLLabelElement>('[data-openbitfun-component="checkbox"]')!;
  act(() => label.click());
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0](initial).launchAfterInstall).toBe(true);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-component="icon-button"]')];
  act(() => buttons[0].click());
  act(() => buttons[1].click());
  expect(mocks.minimize).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('keeps the theme page open and shows the error if saving preferences fails', async () => {
  vi.mocked(invoke).mockRejectedValueOnce('Preferences are read-only');
  const close = vi.fn(); const launch = vi.fn();
  await act(async () => root.render(<ThemeSetup options={initial} setOptions={vi.fn()} onLaunch={launch} onClose={close} />));
  const finish = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('complete.finish'))!;
  await act(async () => finish.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Preferences are read-only');
  expect(close).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
});

it('keeps installation scope and directory coherent while resolving a machine path, and reports resolution failures', async () => {
  let reject!: (error: string) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
  const changed = vi.fn(); const install = vi.fn();
  await act(async () => root.render(<Options options={initial} setOptions={changed} diskSpace={null} error={null}
    refreshDiskSpace={vi.fn()} existingInstall={null} onLaunchRegisteredUninstaller={vi.fn()}
    onBack={vi.fn()} onInstall={install} isInstalling={false} clearInstallError={vi.fn()} />));
  const labels = [...container.querySelectorAll<HTMLLabelElement>('[data-openbitfun-component="checkbox"]')];
  const scope = labels.find(label => label.textContent?.includes('options.allUsers'))!;
  act(() => scope.click());
  expect(changed).not.toHaveBeenCalled();
  const installButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'options.install')!;
  expect(installButton.disabled).toBe(true);
  await act(async () => { reject('Cannot locate Program Files'); });
  expect(changed).not.toHaveBeenCalled();
  expect(container.textContent).toContain('errors.maintenance.failed');
  expect(install).not.toHaveBeenCalled();
});
