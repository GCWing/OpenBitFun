// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualSkinConfigSection } from './VisualSkinConfigSection';

const activateMock = vi.hoisted(() => vi.fn());
const previewMock = vi.hoisted(() => vi.fn());
const cancelPreviewMock = vi.hoisted(() => vi.fn());
const importMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());
const watchProjectionMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const skinState = vi.hoisted(() => ({
  invalidRecords: [] as { key: IDBValidKey; error: string }[],
  projection: null as import('@/infrastructure/visual-skin').VisualSkinProjectionReport | null,
  skins: [
    {
      id: 'sample.skin',
      name: 'Sample Skin',
      description: 'Reference image style',
      version: '1.0.0',
      author: 'AI',
    },
  ],
  activeSkinId: 'sample.skin' as string | null,
  previewSkinId: null as string | null,
  initialized: true,
  status: 'ready' as const,
  error: undefined as string | undefined,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('@/infrastructure/visual-skin', () => ({
  useVisualSkin: () => ({
    ...skinState,
    watchProjection: watchProjectionMock,
    importPackage: importMock,
    activate: activateMock,
    preview: previewMock,
    cancelPreview: cancelPreviewMock,
    remove: removeMock,
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement;
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<VisualSkinConfigSection />));
}
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null; container.remove(); } });

describe('VisualSkinConfigSection', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateMock.mockReset();
    previewMock.mockReset();
    cancelPreviewMock.mockReset();
    importMock.mockReset();
    removeMock.mockReset();
    watchProjectionMock.mockClear();
    skinState.skins = [{
      id: 'sample.skin',
      name: 'Sample Skin',
      description: 'Reference image style',
      version: '1.0.0',
      author: 'AI',
    }];
    skinState.invalidRecords = [];
    skinState.projection = null;
    skinState.activeSkinId = 'sample.skin';
    skinState.previewSkinId = null;
    skinState.error = undefined;
  });

  it('renders imported skin preview and active state', () => {
    const html = renderToStaticMarkup(<VisualSkinConfigSection />);
    expect(html).toContain('data-testid="visual-skin-gallery"');
    expect(html).toContain('data-skin-id="sample.skin"');
    expect(html).toContain('skin.active');
    expect(html).toContain('visual-skin-import');
    expect(html).toContain('visual-skin-preview-sample.skin');
  });

  it('renders an empty state when no imported skins exist', () => {
    skinState.skins = [];
    skinState.activeSkinId = null;
    const html = renderToStaticMarkup(<VisualSkinConfigSection />);
    expect(html).toContain('data-testid="visual-skin-empty"');
  });
  it('distinguishes the saved skin from a temporary preview and keeps every card action reachable', async () => {
    skinState.skins.push({ id: 'other.skin', name: 'Other skin', description: 'A long reference description', version: '2', author: 'Artist' });
    skinState.previewSkinId = 'other.skin';
    await mount();
    expect(container.querySelector('[data-testid="visual-skin-status-sample.skin"]')?.textContent).toBe('skin.active');
    expect(container.querySelector('[data-testid="visual-skin-status-other.skin"]')?.textContent).toBe('skin.previewing');
    expect((container.querySelector('[data-testid="visual-skin-activate-sample.skin"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => (container.querySelector('[data-testid="visual-skin-preview-other.skin"]') as HTMLButtonElement).click());
    expect(cancelPreviewMock).toHaveBeenCalledTimes(1);
    await act(async () => (container.querySelector('[data-testid="visual-skin-activate-other.skin"]') as HTMLButtonElement).click());
    expect(activateMock).toHaveBeenCalledWith('other.skin');
    await act(async () => (container.querySelector('[data-testid="visual-skin-remove-other.skin"]') as HTMLButtonElement).click());
    expect(removeMock).toHaveBeenCalledWith('other.skin');
  });
  it('shows a bad record key and reason and allows explicit removal', async () => {
    skinState.invalidRecords = [{ key: 'broken-key', error: 'Stored metadata is invalid' }];
    await mount();
    const card = container.querySelector('[data-testid="visual-skin-invalid-record"]')!;
    expect(card.textContent).toContain('broken-key');
    expect(card.textContent).toContain('Stored metadata is invalid');
    expect(removeMock).not.toHaveBeenCalled();
    await act(async () => (card.querySelector('button') as HTMLButtonElement).click());
    expect(removeMock).toHaveBeenCalledWith('broken-key');
    expect(container.querySelector('[data-skin-id="sample.skin"]')).not.toBeNull();
  });

  it.each(['activate', 'preview', 'cancelPreview', 'remove'] as const)('handles %s rejection and shows its error in settings', async action => {
    skinState.activeSkinId = null;
    if (action === 'cancelPreview') skinState.previewSkinId = 'sample.skin';
    const mock = action === 'activate' ? activateMock : action === 'preview' ? previewMock : action === 'remove' ? removeMock : cancelPreviewMock;
    mock.mockRejectedValueOnce(new Error('Operation write failed'));
    await mount();
    const id = action === 'activate' ? 'visual-skin-activate-sample.skin' : action === 'remove' ? 'visual-skin-remove-sample.skin' : 'visual-skin-preview-sample.skin';
    await act(async () => (container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click());
    expect(mock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Operation write failed');
    expect((container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['active', 'preview'] as const)('keeps developer projection data out of %s skin cards without subscribing to live diagnostics', async state => {
    if (state === 'preview') {
      skinState.activeSkinId = null;
      skinState.previewSkinId = 'sample.skin';
    }
    skinState.projection = { mode: 'light', baseMode: 'light', projected: 0, inactive: 1, unresolved: 1, unsupported: 0, entries: [
      { path: 'modes.dark.tokens.color.content.primary', status: 'inactive', message: 'Not selected in light' },
      { path: 'components[0].slots.leading-icon', status: 'unresolved', message: 'Part is not mounted' },
    ] };
    await mount();
    expect(container.textContent).toContain('Sample Skin');
    expect(container.textContent).toContain(state === 'active' ? 'skin.active' : 'skin.cancelPreview');
    expect(container.textContent).not.toContain('skin.coverage');
    expect(container.textContent).not.toContain('modes.dark.tokens.color.content.primary');
    expect(container.textContent).not.toContain('Part is not mounted');
    expect(container.querySelector('details, [data-projection-status], [role="alert"]')).toBeNull();
    expect(watchProjectionMock).not.toHaveBeenCalled();
  });

  it('keeps runtime failures visible independently of developer diagnostics', async () => {
    skinState.error = 'Unable to open visual skin storage';
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(skinState.error);
    expect(watchProjectionMock).not.toHaveBeenCalled();
  });

});
