// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  copyImageToClipboard: vi.fn(),
  showContextMenu: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  i18nService: { t: (key: string) => key },
}));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/shared/notification-system', () => ({
  notificationService: { success: mocks.success, error: mocks.error },
}));
vi.mock('@/shared/context-menu-system/core/ContextMenuController', () => ({
  contextMenuController: { show: mocks.showContextMenu },
}));
vi.mock('@/shared/utils/imageClipboard', async importOriginal => ({
  ...await importOriginal<typeof import('@/shared/utils/imageClipboard')>(),
  copyImageToClipboard: mocks.copyImageToClipboard,
}));

import { CrossOriginImageError } from '@/shared/utils/imageClipboard';
import type { MenuItem } from '@/shared/context-menu-system/types';
import { ImageLightbox } from './ImageLightbox';

const INLINE_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const REMOTE_IMAGE = 'https://images.example.com/cat.png';

function copyButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.image-lightbox-copy');
}

function copyIconName(): string | null | undefined {
  return copyButton()?.querySelector('[data-openbitfun-component="icon"]')?.getAttribute('data-openbitfun-name');
}

function lightboxImage(): HTMLImageElement {
  return document.querySelector<HTMLImageElement>('.image-lightbox img')!;
}

function openContextMenu(): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 });
  act(() => {
    lightboxImage().dispatchEvent(event);
  });
  return event;
}

describe('ImageLightbox copy action', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.copyImageToClipboard.mockReset().mockResolvedValue(undefined);
    mocks.showContextMenu.mockReset();
    mocks.success.mockReset();
    mocks.error.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (source: string) => {
    act(() => {
      root.render(<ImageLightbox image={{ source }} onClose={() => undefined} />);
    });
  };

  it('copies a readable image from the chrome button with design-system icons', async () => {
    render(INLINE_PNG);

    expect(copyButton()?.getAttribute('aria-label')).toBe('imageLightbox.copy');
    expect(copyIconName()).toBe('duplicate');

    await act(async () => {
      copyButton()!.click();
    });

    expect(mocks.copyImageToClipboard).toHaveBeenCalledWith(INLINE_PNG);
    expect(mocks.success).toHaveBeenCalledWith('imageLightbox.copySuccess', expect.anything());
    expect(copyIconName()).toBe('check-line');
  });

  it('does not offer copying an image served by another origin', () => {
    render(REMOTE_IMAGE);

    expect(lightboxImage().getAttribute('src')).toBe(REMOTE_IMAGE);
    expect(copyButton()).toBeNull();
    const event = openContextMenu();
    expect(mocks.showContextMenu).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('names the cross-origin reason instead of a generic failure', async () => {
    render(INLINE_PNG);
    const event = openContextMenu();

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.showContextMenu).toHaveBeenCalledTimes(1);
    const [, items] = mocks.showContextMenu.mock.calls[0] as [unknown, MenuItem[]];
    expect(items.map(item => item.label)).toEqual(['imageLightbox.copy']);

    mocks.copyImageToClipboard.mockRejectedValueOnce(new CrossOriginImageError());
    await act(async () => {
      items[0].onClick?.(undefined as never);
    });
    expect(mocks.error).toHaveBeenLastCalledWith('imageLightbox.copyCrossOrigin', expect.anything());

    mocks.copyImageToClipboard.mockRejectedValueOnce(new Error('NotAllowedError'));
    await act(async () => {
      items[0].onClick?.(undefined as never);
    });
    expect(mocks.error).toHaveBeenLastCalledWith('imageLightbox.copyFailed', expect.anything());
  });
});
