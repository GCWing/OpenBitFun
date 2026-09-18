// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerDirectoryBrowser } from './PeerDirectoryBrowser';

const mocks = vi.hoisted(() => ({
  getSystemInfo: vi.fn(),
  getDirectoryChildren: vi.fn(),
  t: (key: string) => key,
}));
/** The peer host browses its own filesystem: an explicit empty connection means host-local IO. */
const HOST_LOCAL_CONNECTION = '';
vi.mock('@/infrastructure/api/service-api/SystemAPI', () => ({ systemAPI: mocks }));
vi.mock('@/infrastructure/api', () => ({ workspaceAPI: mocks }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/infrastructure/appearance/runtime/AppearanceOverlayHost', () => ({
  getAppearanceOverlayHost: () => document.body,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('PeerDirectoryBrowser', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;
  const input = () => document.querySelector('input')!;
  const select = () => Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent === 'peerDirectoryPicker.select')!;
  const render = async (initialPath?: string) => {
    await act(async () => root.render(
      <PeerDirectoryBrowser title="Choose directory" initialPath={initialPath} onSelect={onSelect} onCancel={vi.fn()} />,
    ));
  };
  const typePath = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const key = async (value: string, isComposing = false) => {
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', {
      key: value, bubbles: true, isComposing,
    })));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemInfo.mockResolvedValue({ platform: 'linux', arch: 'x86_64', homeDir: '/home/peer' });
    mocks.getDirectoryChildren.mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ['linux', '/home/remote-user'],
    ['macos', '/Users/remote-user'],
    ['windows', 'D:\\Users\\remote-user'],
  ])('starts at the %s peer home without guessing a root', async (platform, homeDir) => {
    mocks.getSystemInfo.mockResolvedValue({ platform, homeDir });
    await render();
    expect(mocks.getDirectoryChildren).toHaveBeenCalledExactlyOnceWith(homeDir, HOST_LOCAL_CONNECTION);
    expect(input().value).toBe(homeDir);
    await act(async () => select().click());
    expect(onSelect).toHaveBeenCalledWith(homeDir);
  });

  it('preserves an explicit initial path but Home goes to the peer user directory', async () => {
    await render('/projects/existing');
    expect(mocks.getSystemInfo).not.toHaveBeenCalled();
    expect(input().value).toBe('/projects/existing');
    await act(async () => document.querySelector<HTMLButtonElement>('[title="peerDirectoryPicker.home"]')!.click());
    expect(input().value).toBe('/home/peer');
  });

  it('keeps the same full-width input mounted through focus, typing, Enter and blur', async () => {
    await render();
    const original = input();
    const field = original.parentElement!;
    expect(field.classList.contains('peer-directory-browser__path-input-field')).toBe(true);
    await act(async () => original.focus());
    await typePath('/projects/new');
    expect(select().disabled).toBe(true);
    await key('Enter');
    await act(async () => original.blur());
    expect(input()).toBe(original);
    expect(input().parentElement).toBe(field);
    expect(mocks.getDirectoryChildren.mock.calls).toEqual([
      ['/home/peer', HOST_LOCAL_CONNECTION],
      ['/projects/new', HOST_LOCAL_CONNECTION],
    ]);
    expect(select().disabled).toBe(false);
  });

  it('leaves IME Enter/Escape to composition and restores the path on ordinary Escape', async () => {
    await render();
    await typePath('/draft');
    await key('Enter', true);
    await key('Escape', true);
    expect(input().value).toBe('/draft');
    expect(mocks.getDirectoryChildren).toHaveBeenCalledTimes(1);
    await key('Escape');
    expect(input().value).toBe('/home/peer');
  });

  it('lets an older peer recover through manual input when homeDir is absent', async () => {
    mocks.getSystemInfo.mockResolvedValue({ platform: 'windows', arch: 'x86_64' });
    await render();
    expect(document.body.textContent).toContain('peerDirectoryPicker.homeUnavailable');
    expect(mocks.getDirectoryChildren).not.toHaveBeenCalled();
    expect(select().disabled).toBe(true);
    await typePath('E:\\Projects');
    await key('Enter');
    expect(input().value).toBe('E:\\Projects');
    expect(select().disabled).toBe(false);
  });

  it('shows home lookup failures without falling back to a controller path', async () => {
    mocks.getSystemInfo.mockRejectedValue(new Error('Peer offline'));
    await render();
    expect(document.body.textContent).toContain('Peer offline');
    expect(mocks.getDirectoryChildren).not.toHaveBeenCalled();
    expect(select().disabled).toBe(true);
  });

  it('does not confirm a stale selection after navigation fails', async () => {
    await render();
    mocks.getDirectoryChildren.mockRejectedValueOnce(new Error('Permission denied'));
    await typePath('/restricted');
    await key('Enter');
    expect(document.body.textContent).toContain('Permission denied');
    expect(select().disabled).toBe(true);
    await act(async () => select().click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores a slow home response after the user navigates manually', async () => {
    let resolveHome!: (info: { homeDir: string }) => void;
    mocks.getSystemInfo.mockReturnValue(new Promise((resolve) => { resolveHome = resolve; }));
    await render();
    await typePath('/manual');
    await key('Enter');
    await act(async () => resolveHome({ homeDir: '/home/late' }));
    expect(input().value).toBe('/manual');
    expect(mocks.getDirectoryChildren).toHaveBeenCalledExactlyOnceWith('/manual', HOST_LOCAL_CONNECTION);
  });
});
