/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import MiniAppInstalledCard from './MiniAppInstalledCard';

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, currentLanguage: 'en-US' }),
}));

const app = { id: 'notes', name: 'Notes', description: 'Notes app', icon: 'box' } as MiniAppMeta;
const openDetails = vi.fn();
const launch = vi.fn();
const addToSystem = vi.fn();
const remove = vi.fn();
let root: Root;
let container: HTMLDivElement;
const more = () => container.querySelector<HTMLButtonElement>('[aria-label="presentation.moreActions"]')!;
const start = () => container.querySelector<HTMLButtonElement>('[aria-label="card.start"]')!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]:not([aria-hidden="true"])');
const item = (id: string) => menu()!.querySelector<HTMLButtonElement>(`[data-menu-id="${id}"]`)!;
const render = (systemAppSupported = true, busy = false) => act(async () => {
  root.render(<MiniAppInstalledCard app={app} itemKey="local:notes" statuses={[]}
    onOpenDetails={openDetails} onLaunch={launch} onAddToSystem={addToSystem} onDelete={remove}
    systemAppSupported={systemAppSupported} busy={busy} />);
});
const openMenu = () => act(async () => { more().click(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  addToSystem.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('installed MiniApp card actions', () => {
  it('opens a menu without deleting the app or opening its details', async () => {
    await render();
    expect(container.querySelector('[aria-label="card.delete"]')).toBeNull();
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
    await openMenu();
    expect(more().getAttribute('aria-expanded')).toBe('true');
    expect(menu()!.id).toBe(more().getAttribute('aria-controls'));
    expect(item('install').textContent).toBe('presentation.install');
    expect(item('delete').textContent).toBe('card.delete');
    expect(openDetails).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { item('delete').click(); });
    expect(remove).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('dispatches system installation separately from launch and deletion', async () => {
    await render();
    await openMenu();
    await act(async () => { item('install').click(); });
    expect(addToSystem).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(openDetails).not.toHaveBeenCalled();
  });

  it('keeps deletion available while explaining unsupported system installation', async () => {
    await render(false);
    await openMenu();
    expect(item('install').disabled).toBe(true);
    expect(menu()!.getAttribute('aria-description')).toBe('presentation.unsupported');
    await act(async () => { item('install').click(); });
    expect(addToSystem).not.toHaveBeenCalled();
    expect(item('delete').disabled).toBe(false);
    await act(async () => { item('delete').click(); });
    expect(remove).toHaveBeenCalledOnce();
  });

  it('prevents competing actions until system installation completes', async () => {
    let finish!: () => void;
    addToSystem.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    await render();
    await openMenu();
    await act(async () => { item('install').click(); });
    expect(more().disabled).toBe(true);
    expect(start().disabled).toBe(true);
    await act(async () => { more().click(); start().click(); });
    expect(menu()).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(more().disabled).toBe(false);
    expect(start().disabled).toBe(false);
  });

  it('closes with Escape and restores focus to the more button', async () => {
    await render();
    await openMenu();
    await act(async () => {
      menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(more());
    expect(remove).not.toHaveBeenCalled();
  });
});
