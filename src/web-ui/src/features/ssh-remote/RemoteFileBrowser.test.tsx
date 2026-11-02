// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteFileBrowser } from './RemoteFileBrowser';
import type { RemoteFileEntry } from './types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  readDir: vi.fn<(connectionId: string, path: string) => Promise<RemoteFileEntry[]>>(),
  rename: vi.fn(async () => undefined),
  downloadToLocalPath: vi.fn(),
  cancelTransfer: vi.fn(async () => undefined),
}));
vi.mock('./sshApi', () => ({ sshApi: api }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => '/downloads/old.txt') }));

const fileEntry: RemoteFileEntry = {
  name: 'old.txt', path: '/srv/project/old.txt', isDir: false, isFile: true, isSymlink: false,
};
const linkEntry: RemoteFileEntry = {
  name: 'linked project', path: '/srv/project/linked project', isDir: false, isFile: false, isSymlink: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.readDir.mockReset().mockResolvedValue([fileEntry]);
});

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
    expect(document.activeElement).toBe(input);
    expect(dialog.querySelector(`label[for="${input.id}"]`)?.textContent).toContain('ssh.remote.name');
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

describe('remote directory link navigation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onSelect = vi.fn();
  const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.remote-file-browser__row')]
    .find(node => node.querySelector('.remote-file-browser__name')?.textContent === name)!;
  const openButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.textContent === 'ssh.remote.openWorkspace')!;
  const currentPath = () => document.querySelector('.remote-file-browser__footer-hint')?.textContent;
  const render = async (connectionId = 'ssh-host', initialPath = '/srv/project') => {
    await act(async () => root.render(
      <RemoteFileBrowser connectionId={connectionId} initialPath={initialPath} selectDirectoriesOnly onSelect={onSelect} onCancel={() => undefined} />,
    ));
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('names the modal and exposes directory navigation to the keyboard', async () => {
    api.readDir.mockResolvedValueOnce([fileEntry, linkEntry]).mockResolvedValueOnce([]);
    await render();
    const dialog = document.querySelector<HTMLElement>('.remote-file-browser[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('ssh.remote.selectWorkspace');
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.remote-file-browser__entry-button')];
    expect(buttons).toHaveLength(3);
    act(() => buttons[0].focus());
    act(() => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(buttons[1]);
    act(() => buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement).toBe(buttons.at(-1));
    act(() => buttons.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[1].click());
    expect(api.readDir).toHaveBeenLastCalledWith('ssh-host', linkEntry.path);
    expect(api.readDir).toHaveBeenCalledTimes(2);
  });

  it('opens entry actions with Shift+F10 within the owning modal', async () => {
    await render();
    const file = row(fileEntry.name).querySelector<HTMLButtonElement>('.remote-file-browser__entry-button')!;
    act(() => file.focus());
    await act(async () => file.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })));
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'ssh.remote.rename')!;
    expect(rename).toBeDefined();
    await act(async () => rename.click());
    const input = document.querySelector<HTMLInputElement>('.remote-file-browser__dialog input')!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(fileEntry.name);
  });

  it('provides a keyboard-focusable path editor with an accessible name', async () => {
    await render();
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="ssh.remote.clickToEditPath"]')!;
    act(() => edit.focus());
    expect(document.activeElement).toBe(edit);
    await act(async () => edit.click());
    expect(document.querySelector<HTMLInputElement>('input[aria-label="peerDirectoryPicker.path"]')?.value).toBe('/srv/project');
  });

  it.each(['click', 'double click', 'context menu'])('opens a directory symlink through %s and preserves its POSIX path', async (action) => {
    api.readDir.mockResolvedValueOnce([fileEntry, linkEntry]).mockResolvedValueOnce([]);
    await render();
    expect(row(linkEntry.name).querySelector('.remote-file-browser__entry-icon--link')).not.toBeNull();
    await act(async () => {
      if (action === 'click') row(linkEntry.name).click();
      else if (action === 'double click') Simulate.doubleClick(row(linkEntry.name));
      else row(linkEntry.name).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    if (action === 'context menu') {
      const open = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(node => node.textContent === 'actions.open')!;
      await act(async () => open.click());
    }
    expect(api.readDir).toHaveBeenNthCalledWith(2, 'ssh-host', linkEntry.path);
    expect(api.readDir).toHaveBeenCalledTimes(2);
    expect(currentPath()).toBe(linkEntry.path);
    expect(openButton().disabled).toBe(false);
    act(() => openButton().click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(linkEntry.path);

    await act(async () => row('..').click());
    expect(api.readDir).toHaveBeenLastCalledWith('ssh-host', '/srv/project');
    expect(currentPath()).toBe('/srv/project');
  });

  it.each([
    ['file link', new Error('Not a directory')],
    ['broken link', 'No such file'],
    ['inaccessible link', new Error('Permission denied')],
    ['cyclic link', new Error('Too many levels of symbolic links')],
  ])('keeps the parent listing and error for a %s, and retries the same remote path', async (_kind, error) => {
    api.readDir.mockResolvedValueOnce([linkEntry]).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await render();
    await act(async () => row(linkEntry.name).click());
    expect(openButton().disabled).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(currentPath()).toBe('/srv/project');
    expect(row(linkEntry.name)).toBeDefined();
    expect(document.querySelector('.remote-file-browser__error')?.textContent)
      .toContain(error instanceof Error ? error.message : error);
    expect(document.querySelector('.remote-file-browser__empty')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    api.readDir.mockResolvedValueOnce([]);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="actions.retry"]')!.click());
    expect(api.readDir).toHaveBeenLastCalledWith('ssh-host', linkEntry.path);
    expect(currentPath()).toBe(linkEntry.path);
  });

  it('does not select an unvalidated initial directory or call a failed load empty', async () => {
    api.readDir.mockRejectedValue('Permission denied');
    await render();
    expect(openButton().disabled).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(openButton().disabled).toBe(true);
    expect(document.querySelector('.remote-file-browser__empty')).toBeNull();
    act(() => openButton().click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores a late link response after navigating home', async () => {
    let resolveLink!: (entries: RemoteFileEntry[]) => void;
    api.readDir.mockResolvedValueOnce([linkEntry])
      .mockImplementationOnce(() => new Promise(resolve => { resolveLink = resolve; }))
      .mockResolvedValueOnce([fileEntry]);
    await render();
    await act(async () => row(linkEntry.name).click());
    expect(openButton().disabled).toBe(true);
    act(() => openButton().click());
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="ssh.remote.homeFolder"]')!.click());
    await act(async () => resolveLink([]));
    expect(currentPath()).toBe('/srv/project');
    expect(row(fileEntry.name)).toBeDefined();
    act(() => openButton().click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('/srv/project');
  });

  it('discards an old connection response when the host changes', async () => {
    let resolveLink!: (entries: RemoteFileEntry[]) => void;
    api.readDir.mockResolvedValueOnce([linkEntry])
      .mockImplementationOnce(() => new Promise(resolve => { resolveLink = resolve; }))
      .mockResolvedValueOnce([fileEntry]);
    await render();
    await act(async () => row(linkEntry.name).click());
    await render('other-host');
    await act(async () => resolveLink([]));
    expect(api.readDir).toHaveBeenLastCalledWith('other-host', '/srv/project');
    expect(currentPath()).toBe('/srv/project');
    expect(row(fileEntry.name)).toBeDefined();
  });
});
