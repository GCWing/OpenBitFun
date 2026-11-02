// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInputImagePreview } from './ChatInputImagePreview';
import type { ImageContext } from '@/types/context';
const scope = vi.hoisted(() => ({ epoch: 1 }));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceScope: () => scope }));

const { readFileContent } = vi.hoisted(() => ({ readFileContent: vi.fn() }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({ workspaceAPI: { readFileContent } }));
vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (_key: string, values: { message: string }) => `Load failed: ${values.message}` }),
  i18nService: { t: (key: string) => key },
}));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

const image = { id: 'image', imageName: 'Photo.png', imagePath: '/Lark images/Photo.png', mimeType: 'image/png' } as ImageContext;

describe('ChatInputImagePreview', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    scope.epoch = 1;
    readFileContent.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };


  it('reads path-only dropped screenshots through the host transport', async () => {
    readFileContent.mockResolvedValue('aW1hZ2U=');
    await render(<ChatInputImagePreview image={image} surfaceEpoch={1} />);
    const thumbnail = container.querySelector('img')!;
    expect(readFileContent).toHaveBeenCalledWith(image.imagePath, 'base64');
    expect(thumbnail.getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=');
  });

  it('uses embedded clipboard data without reading a host file', async () => {
    await render(<ChatInputImagePreview image={{ ...image, dataUrl: 'data:image/png;base64,AA==' }} surfaceEpoch={1} />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(readFileContent).not.toHaveBeenCalled();
  });

  it('displays read failures without falling back to controller-local URLs', async () => {
    readFileContent.mockRejectedValue(new Error('Host offline'));
    await render(<ChatInputImagePreview image={image} surfaceEpoch={1} />);
    expect(container.querySelector('[role=img]')!.getAttribute('aria-label')).toContain('Host offline');
    expect(container.querySelector('img')).toBeNull();
    expect(readFileContent).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale image read after the attachment changes', async () => {
    let finishOld!: (content: string) => void;
    readFileContent.mockImplementationOnce(() => new Promise<string>(resolve => { finishOld = resolve; }));
    readFileContent.mockResolvedValueOnce('NEW');
    await render(<ChatInputImagePreview image={image} surfaceEpoch={1} />);
    await render(<ChatInputImagePreview image={{ ...image, imagePath: '/new.png' }} surfaceEpoch={1} />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,NEW');
    await act(async () => { finishOld('OLD'); });
    expect(container.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,NEW');
  });

  it('previews the resolved image and closes the overlay on demand', async () => {
    await render(<ChatInputImagePreview image={{ ...image, dataUrl: 'data:image/png;base64,AA==' }} surfaceEpoch={1} />);
    const trigger = container.querySelector<HTMLButtonElement>('.openbitfun-chat-input__image-chip-preview')!;
    expect(trigger.getAttribute('aria-label')).toBe('components:imageLightbox.label');
    expect(document.querySelector('.image-lightbox')).toBeNull();

    act(() => { trigger.click(); });

    const overlay = document.querySelector<HTMLElement>('.image-lightbox');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AA==');

    act(() => { document.querySelector<HTMLButtonElement>('.image-lightbox-close')!.click(); });

    expect(document.querySelector('.image-lightbox')).toBeNull();
  });

  it('keeps the chip thumbnail but opens the original clipboard image', async () => {
    const original = 'data:image/png;base64,ORIGINAL';
    const thumbnail = 'data:image/jpeg;base64,THUMBNAIL';
    await render(<ChatInputImagePreview image={{ ...image, dataUrl: original, thumbnailUrl: thumbnail }} surfaceEpoch={1} />);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(thumbnail);

    act(() => { container.querySelector<HTMLButtonElement>('button')!.click(); });

    expect(document.querySelector('.image-lightbox img')!.getAttribute('src')).toBe(original);
    expect(readFileContent).not.toHaveBeenCalled();
  });

  it('loads a host original on demand when the attachment already has a thumbnail', async () => {
    const thumbnail = 'data:image/jpeg;base64,THUMBNAIL';
    readFileContent.mockResolvedValue('ORIGINAL');
    await render(<ChatInputImagePreview image={{ ...image, thumbnailUrl: thumbnail }} surfaceEpoch={1} />);
    expect(readFileContent).not.toHaveBeenCalled();
    expect(container.querySelector('img')!.getAttribute('src')).toBe(thumbnail);

    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });

    expect(readFileContent).toHaveBeenCalledWith(image.imagePath, 'base64');
    expect(document.querySelector('.image-lightbox img')!.getAttribute('src')).toBe('data:image/png;base64,ORIGINAL');
    expect(container.querySelector('img')!.getAttribute('src')).toBe(thumbnail);

    act(() => { document.querySelector<HTMLButtonElement>('.image-lightbox-close')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(readFileContent).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.image-lightbox img')!.getAttribute('src')).toBe('data:image/png;base64,ORIGINAL');
  });

  it('ignores a pending preview read after the attachment changes', async () => {
    let finishOld!: (content: string) => void;
    readFileContent.mockImplementationOnce(() => new Promise<string>(resolve => { finishOld = resolve; }));
    await render(<ChatInputImagePreview image={{ ...image, thumbnailUrl: 'data:image/jpeg;base64,THUMBNAIL' }} surfaceEpoch={1} />);
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(document.querySelector('.image-lightbox')).toBeNull();

    await render(<ChatInputImagePreview image={{ ...image, id: 'new-image', dataUrl: 'data:image/png;base64,NEW' }} surfaceEpoch={1} />);
    await act(async () => { finishOld('OLD'); });
    expect(document.querySelector('.image-lightbox')).toBeNull();
    act(() => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(document.querySelector('.image-lightbox img')!.getAttribute('src')).toBe('data:image/png;base64,NEW');
  });

  it('closes an open original preview when the device surface changes', async () => {
    const clipboard = { ...image, dataUrl: 'data:image/png;base64,ORIGINAL' };
    await render(<ChatInputImagePreview image={clipboard} surfaceEpoch={1} />);
    act(() => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(document.querySelector('.image-lightbox')).not.toBeNull();
    scope.epoch = 2;
    await render(<ChatInputImagePreview image={clipboard} surfaceEpoch={2} />);
    expect(document.querySelector('.image-lightbox')).toBeNull();
  });

  it('reports a failed original read instead of presenting a thumbnail as the original', async () => {
    readFileContent.mockRejectedValue(new Error('Host offline'));
    await render(<ChatInputImagePreview image={{ ...image, thumbnailUrl: 'data:image/jpeg;base64,THUMBNAIL' }} surfaceEpoch={1} />);
    await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(document.querySelector('.image-lightbox')).toBeNull();
    expect(container.querySelector('[role=img]')!.getAttribute('aria-label')).toContain('Host offline');
  });
});
