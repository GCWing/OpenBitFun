// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { expect, it, vi } from 'vitest';
import { RemoteFileBrowser } from './RemoteFileBrowser';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  readDir: vi.fn(async () => [{ name: 'old.txt', path: '/srv/project/old.txt', isDir: false }]),
  rename: vi.fn(async () => undefined),
  downloadToLocalPath: vi.fn(),
  cancelTransfer: vi.fn(async () => undefined),
}));
vi.mock('./sshApi', () => ({ sshApi: api }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => '/downloads/old.txt') }));

it('renames a remote file once and keeps IME and outside clicks from dismissing the dialog', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RemoteFileBrowser connectionId="ssh-host" initialPath="/srv/project" onSelect={() => undefined} onCancel={() => undefined} />));
    const row = [...document.querySelectorAll<HTMLElement>('.remote-file-browser__row')].find(node => node.textContent?.includes('old.txt'))!;
    act(() => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 90 })));
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'ssh.remote.rename')!;
    await act(async () => rename.click());
    const dialog = document.querySelector<HTMLElement>('.remote-file-browser__dialog')!;
    expect(dialog.getAttribute('data-openbitfun-component')).toBe('dialog');
    const input = dialog.querySelector('input')!;
    expect(input.value).toBe('old.txt');
    act(() => {
      input.value = 'new.txt';
      Simulate.change(input);
      Simulate.compositionStart(input);
      Simulate.keyDown(input, { key: 'Escape' });
      Simulate.keyDown(input, { key: 'Enter' });
    });
    expect(dialog.isConnected).toBe(true);
    expect(api.rename).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(dialog.isConnected).toBe(true);
    await act(async () => {
      Simulate.compositionEnd(input);
      Simulate.keyDown(input, { key: 'Enter' });
    });
    expect(api.rename).toHaveBeenCalledExactlyOnceWith('ssh-host', '/srv/project/old.txt', '/srv/project/new.txt');
    expect(dialog.isConnected).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('stops a browser download using the id of its in-flight command', async () => {
  Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true });
  let finishDownload!: () => void;
  api.downloadToLocalPath.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finishDownload = resolve;
  }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RemoteFileBrowser connectionId="ssh-host" initialPath="/srv/project" onSelect={() => undefined} onCancel={() => undefined} />));
    const row = [...document.querySelectorAll<HTMLElement>('.remote-file-browser__row')].find(node => node.textContent?.includes('old.txt'))!;
    act(() => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const download = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'ssh.remote.download')!;
    await act(async () => download.click());

    const transferId = api.downloadToLocalPath.mock.calls[0]?.[4];
    expect(transferId).toEqual(expect.any(String));
    const stop = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'actions.cancel')!;
    await act(async () => stop.click());
    expect(api.cancelTransfer).toHaveBeenCalledExactlyOnceWith(transferId);
    expect(api.downloadToLocalPath.mock.calls[0]?.[5]()).toBe(true);
    await act(async () => finishDownload());
  } finally {
    act(() => root.unmount());
    container.remove();
    delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  }
});
