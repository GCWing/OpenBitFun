/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MiniAppLibraryRow from './MiniAppLibraryRow';
import { MiniAppLaunchActions } from './MiniAppLaunchActions';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

let root: Root;
let container: HTMLDivElement;
const openTab = vi.fn();
const openWindow = vi.fn();
const marketAction = vi.fn();
const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!;
const render = (action: 'open' | 'update' | 'get' = 'open', windowSupported = true, busy = false) => act(async () => {
  root.render(<MiniAppLibraryRow
    itemKey="local:notes" action={action} actionLabel={action} category="productivity"
    description="Notes" detailsLabel="Details" name="Notes" showcaseAlt="Notes" showcaseFallbackLabel="Preview"
    statuses={[]} version="1" onOpenDetails={() => undefined} onPrimaryAction={marketAction}
    launchActions={action !== 'get' ? <MiniAppLaunchActions onOpenTab={openTab} onOpenWindow={openWindow}
      windowSupported={windowSupported} busy={busy} /> : undefined}
  />);
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MiniApp launch card', () => {
  it('offers both destinations before launch and dispatches each choice independently', async () => {
    await render();
    expect(button('presentation.openTab')).toBeDefined();
    expect(button('presentation.openWindow')).toBeDefined();
    expect(button('open')).toBeUndefined();
    act(() => button('presentation.openTab').click());
    expect(openTab).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
    act(() => button('presentation.openWindow').click());
    expect(openWindow).toHaveBeenCalledOnce();
    expect(marketAction).not.toHaveBeenCalled();
  });

  it('keeps both launch choices available alongside an optional update', async () => {
    await render('update');
    expect(button('presentation.openTab')).toBeDefined();
    expect(button('presentation.openWindow')).toBeDefined();
    act(() => button('update').click());
    expect(marketAction).toHaveBeenCalledOnce();
    expect(openTab).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('keeps uninstalled apps on the get action', async () => {
    await render('get');
    expect(button('presentation.openTab')).toBeUndefined();
    expect(button('presentation.openWindow')).toBeUndefined();
    act(() => button('get').click());
    expect(marketAction).toHaveBeenCalledOnce();
  });

  it('disables unavailable native launches but preserves the in-app choice', async () => {
    await render('open', false);
    expect(button('presentation.openWindow').disabled).toBe(true);
    expect(button('presentation.openTab').disabled).toBe(false);
    act(() => button('presentation.openWindow').click());
    expect(openWindow).not.toHaveBeenCalled();
    await render('open', true, true);
    expect(button('presentation.openWindow').disabled).toBe(true);
    expect(button('presentation.openTab').disabled).toBe(true);
  });
});
