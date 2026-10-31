// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import type { WorkspaceInfo } from '@/shared/types';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { workspaceIconEditorAppearanceDescriptor } from './appearance';
import WorkspaceIconDialog from './WorkspaceIconDialog';

const mocks = vi.hoisted(() => ({ t: (key: string) => key, save: vi.fn(), prepare: vi.fn(), state: { snapshot: { workspaceId: 'project', icon: { version: 1, revision: 7, mode: 'default', color: 'blue' }, supportedGlyphs: ['default', 'learning', 'design', 'travel', 'music'], imageUnavailable: false, supportsThemedImages: true } } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/infrastructure/appearance', () => ({ useAppearance: () => ({ current: null }) }));
vi.mock('@/infrastructure/workspace-icons/useWorkspaceIcon', () => ({ useWorkspaceIcon: () => mocks.state }));
vi.mock('@/infrastructure/workspace-icons/workspaceIcons', () => ({
  iconColors: ['default', 'blue', 'green'],
  workspaceIconGlyphs: ['default', 'learning', 'design', 'travel', 'music'],
  iconColorStyle: (color: string) => ({ blue: '#3366cc', green: '#339966' }[color] ?? (/^#[\da-f]{6}$/i.test(color) ? color : undefined)),
  saveWorkspaceIcon: mocks.save, invalidateWorkspaceIcons: vi.fn(),
}));
vi.mock('./prepareWorkspaceIcon', () => ({ prepareWorkspaceIcon: mocks.prepare }));
const workspace = { id: 'project', name: 'Project', workspaceKind: 'normal' } as WorkspaceInfo;

vi.mock('@openbitfun/ui', async (importOriginal) => {
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { ...await importOriginal<typeof import('@openbitfun/ui')>(),
    Dialog: Wrapper, DialogBody: Wrapper, DialogFooter: Wrapper, DialogHeader: Wrapper,
    DialogHeading: Wrapper, DialogTitle: Wrapper, DialogClose: () => null };
});

describe('workspace icon editor', () => {
  let root: Root;
  let host: HTMLDivElement;
  const close = vi.fn();
  const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  beforeEach(async () => {
    vi.clearAllMocks(); resetDeviceSurfaceForTest(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.state.snapshot.supportsThemedImages = true;
    mocks.state.snapshot.supportedGlyphs = ['default', 'learning', 'design', 'travel', 'music'];
    mocks.save.mockResolvedValue(mocks.state.snapshot); mocks.prepare.mockResolvedValue('data:image/png;base64,normalized');
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root.render(<WorkspaceIconDialog workspace={workspace} onClose={close} />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  it('registers the editor appearance contract and covers every rendered part', () => {
    const registry = new AppearanceRegistry().registerComponent(workspaceIconEditorAppearanceDescriptor);
    const parts = registry.getComponent('workspace-icon-editor')!.parts.map(part => part.id);
    const elements = host.querySelectorAll('[data-openbitfun-component="workspace-icon-editor"][data-openbitfun-part]');
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) expect(parts).toContain(element.getAttribute('data-openbitfun-part'));
  });
  it('previews color without writing, then saves against the captured revision', async () => {
    const hex = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(hex.value).toBe('#3366CC');
    await click('nav.workspaces.icon.palette.green');
    expect(hex.value).toBe('#339966');
    expect(button('nav.workspaces.icon.palette.green').getAttribute('aria-pressed')).toBe('true');
    expect(mocks.save).not.toHaveBeenCalled();
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'default', color: 'green' });
    expect(close).toHaveBeenCalled();
  });
  it('saves the default color through the palette without a separate reset action', async () => {
    expect(button('nav.workspaces.icon.reset')).toBeUndefined();
    await click('nav.workspaces.icon.palette.default');
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'default', color: 'default' });
  });
  it('previews a built-in project glyph and saves it together with the chosen color', async () => {
    expect(button('nav.workspaces.icon.glyphs.learning')).toBeUndefined();
    await click('nav.workspaces.icon.chooseIcon');
    await click('nav.workspaces.icon.glyphs.learning');
    expect(button('nav.workspaces.icon.glyphs.learning')).toBeUndefined();
    expect(host.querySelectorAll('[data-openbitfun-part="preview"] .lucide-graduation-cap')).toHaveLength(2);
    expect(mocks.save).not.toHaveBeenCalled();
    await click('nav.workspaces.icon.palette.green');
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'default', color: 'green', glyph: 'learning' });
  });
  it('keeps legacy host color editing available while disabling unsupported glyph selection', async () => {
    mocks.state.snapshot.supportsThemedImages = true;
    mocks.state.snapshot.supportedGlyphs = [];
    await act(async () => root.render(<WorkspaceIconDialog workspace={workspace} onClose={close} />));
    await click('nav.workspaces.icon.chooseIcon');
    expect(button('nav.workspaces.icon.glyphs.learning').disabled).toBe(true);
    expect(button('nav.workspaces.icon.palette.green').disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('nav.workspaces.icon.glyphsUnsupported');
  });
  it('uploads normalized bytes without sending the source filename', async () => {
    expect(button('nav.workspaces.icon.default').getAttribute('role')).toBe('radio');
    await act(async () => { Simulate.keyDown(button('nav.workspaces.icon.default'), { key: 'ArrowRight' }); });
    expect(button('nav.workspaces.icon.image').getAttribute('aria-checked')).toBe('true');
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['source'], 'private-project.png', { type: 'image/png' });
    await act(async () => { Simulate.change(input, { target: { files: [file], value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>); });
    expect(mocks.prepare).toHaveBeenCalled();
    expect([...host.querySelectorAll<HTMLImageElement>('[data-openbitfun-part="preview"] img')].map(img => img.src))
      .toEqual(['data:image/png;base64,normalized', 'data:image/png;base64,normalized']);
    expect(button('actions.save').disabled).toBe(false);
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'image', color: 'blue', dataBase64: 'normalized' });
  });
  it('keeps life choices in the popup and saves the selected category', async () => {
    await click('nav.workspaces.icon.chooseIcon');
    expect(button('nav.workspaces.icon.glyphs.travel')).toBeUndefined();
    await click('nav.workspaces.icon.lifeIcons');
    await click('nav.workspaces.icon.glyphs.travel');
    expect(host.querySelectorAll('[data-openbitfun-part="preview"] .lucide-plane')).toHaveLength(2);
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'default', color: 'blue', glyph: 'travel' });
  });
  it('prepares and saves independent theme images and keeps crop settings with their image', async () => {
    mocks.prepare.mockImplementation(async (file: File, _crop: boolean, zoom: number) => `data:image/png;base64,${file.name}-${zoom}`);
    await click('nav.workspaces.icon.image');
    const upload = async (name: string) => {
      await act(async () => { Simulate.change(host.querySelector<HTMLInputElement>('input[type="file"]')!, {
        target: { files: [new File(['source'], name, { type: 'image/png' })], value: '' },
      } as unknown as React.ChangeEvent<HTMLInputElement>); });
    };
    await upload('light');
    await act(async () => { Simulate.change(host.querySelector('input[type="range"]')!, { target: { value: '2' } } as React.ChangeEvent<HTMLInputElement>); });
    await click('nav.workspaces.icon.chooseDarkImage');
    await upload('dark');
    expect(host.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe('1');
    expect([...host.querySelectorAll<HTMLImageElement>('[data-openbitfun-part="preview"] img')].map(img => img.src))
      .toEqual(['data:image/png;base64,light-2', 'data:image/png;base64,dark-1']);
    await click('nav.workspaces.icon.chooseLightImage');
    expect(host.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe('2');
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String),
      { kind: 'image', color: 'blue', dataBase64: 'light-2', darkDataBase64: 'dark-1' });
  });
  it('retains legacy single-image editing and explains why separate dark uploads are disabled', async () => {
    mocks.state.snapshot.supportsThemedImages = false;
    await click('nav.workspaces.icon.image');
    expect(button('nav.workspaces.icon.chooseDarkImage').disabled).toBe(true);
    expect(button('nav.workspaces.icon.chooseImage').disabled).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('nav.workspaces.icon.themedImagesUnsupported');
  });
  it('always uploads the default image from the main button after editing the dark variant', async () => {
    mocks.prepare.mockImplementation(async (file: File) => `data:image/png;base64,${file.name}`);
    await click('nav.workspaces.icon.image');
    const upload = async (name: string) => {
      await act(async () => { Simulate.change(host.querySelector<HTMLInputElement>('input[type="file"]')!, {
        target: { files: [new File(['source'], name, { type: 'image/png' })], value: '' },
      } as unknown as React.ChangeEvent<HTMLInputElement>); });
    };
    await click('nav.workspaces.icon.chooseDarkImage');
    await upload('dark');
    expect(button('nav.workspaces.icon.chooseImage').textContent).toBe('nav.workspaces.icon.chooseImage');
    await click('nav.workspaces.icon.chooseImage');
    await upload('default');
    expect([...host.querySelectorAll<HTMLImageElement>('[data-openbitfun-part="preview"] img')].map(img => img.src))
      .toEqual(['data:image/png;base64,default', 'data:image/png;base64,dark']);
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String),
      { kind: 'image', color: 'blue', dataBase64: 'default', darkDataBase64: 'dark' });
  });
  it('rejects invalid theme images without enabling a partial save', async () => {
    await click('nav.workspaces.icon.image');
    mocks.prepare.mockRejectedValueOnce(new Error('invalidImage'));
    await click('nav.workspaces.icon.chooseDarkImage');
    await act(async () => { Simulate.change(host.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(['bad'], 'bad.png', { type: 'image/png' })], value: '' },
    } as unknown as React.ChangeEvent<HTMLInputElement>); });
    expect(button('actions.save').disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('nav.workspaces.icon.invalidImage');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps the custom picker and editable HEX synchronized and rejects incomplete values', async () => {
    expect(host.querySelector('input[type="color"]')).toBeNull();
    const hex = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    await click('nav.workspaces.icon.customColor');
    const expansion = host.querySelector<HTMLElement>('[data-openbitfun-part="expansion"]:not([hidden])')!;
    expect(expansion.hidden).toBe(false);
    // Opening the editor must not replace a theme preset with its resolved HEX.
    expect(button('nav.workspaces.icon.palette.blue').getAttribute('aria-pressed')).toBe('true');
    const petal = expansion.querySelector<HTMLButtonElement>('[data-openbitfun-part="petal"]')!;
    await act(async () => petal.click());
    const chosenHex = petal.getAttribute('aria-label');
    expect(hex.value).toBe(chosenHex);
    expect(button('nav.workspaces.icon.customColor').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { Simulate.change(hex, { target: { value: '#12' } } as React.ChangeEvent<HTMLInputElement>); });
    expect(hex.getAttribute('aria-invalid')).toBe('true');
    expect(button('actions.save').disabled).toBe(true);
    expect(host.querySelector('[data-openbitfun-component="color-picker"]')?.getAttribute('style')).toContain(chosenHex);
    await act(async () => { Simulate.change(hex, { target: { value: '#abc123' } } as React.ChangeEvent<HTMLInputElement>); });
    expect(hex.value).toBe('#ABC123');
    expect(button('actions.save').disabled).toBe(false);
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'default', color: '#ABC123' });
  });
  it('preserves a preset when its resolved HEX is only focused and blurred', async () => {
    const hex = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => { hex.focus(); hex.blur(); });
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 'project', 7, expect.any(String), { kind: 'default', color: 'blue' });
  });
  it('keeps the main preview and mode switch mounted while popups and modes change', async () => {
    const preview = host.querySelector('[data-openbitfun-part="previewPanel"]');
    const modeSwitch = button('nav.workspaces.icon.default');
    const mainHex = host.querySelector<HTMLInputElement>('input[type="text"]')!;
    await click('nav.workspaces.icon.customColor');
    const pickers = host.querySelectorAll('[data-openbitfun-component="color-picker"]');
    const popup = pickers[pickers.length - 1];
    const popupHex = popup.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => { Simulate.change(popupHex, { target: { value: '#ABC123' } } as React.ChangeEvent<HTMLInputElement>); });
    await act(async () => { popup.querySelector<HTMLButtonElement>('[data-openbitfun-part="swatch"]')!.click(); });
    expect(host.querySelector('[data-openbitfun-part="expansion"]:not([hidden])')).toBeNull();
    expect(mainHex.value).toBe('#ABC123');
    expect(button('nav.workspaces.icon.default')).toBe(modeSwitch);
    await click('nav.workspaces.icon.image');
    expect(host.querySelector('[data-openbitfun-part="previewPanel"]')).toBe(preview);
    expect(button('nav.workspaces.icon.default')).toBe(modeSwitch);
    await click('nav.workspaces.icon.default');
    expect(host.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('#ABC123');
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('closes a stale draft on device switch without writing to the new host', () => {
    act(() => { activateSurface('another-host'); });
    expect(close).toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('keeps the draft and idempotency key when a save fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('offline'));
    await click('actions.save'); expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const requestId = mocks.save.mock.calls[0][3];
    await click('actions.save');
    expect(mocks.save).toHaveBeenCalledTimes(2); expect(mocks.save.mock.calls[1][3]).toBe(requestId);
  });
});
