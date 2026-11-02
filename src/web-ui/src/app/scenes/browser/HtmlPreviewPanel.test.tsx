// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import HtmlPreviewPanel from './HtmlPreviewPanel';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({ create: vi.fn(), release: vi.fn() }));
vi.mock('@/infrastructure/api/htmlPreviewApi', () => ({ htmlPreviewApi: mocks }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@openbitfun/ui', () => ({ LoadingState: ({ children }: React.PropsWithChildren) => <span>{children}</span> }));
vi.mock('./BrowserPanel', () => ({ default: ({ initialUrl }: { initialUrl: string }) => <div data-preview-url={initialUrl} /> }));

let root: Root;
let host: HTMLDivElement;
const props = { filePath: '/repo/dist/index.html', workspaceId: 'same-id', isActive: true };
const preview = (id: string) => ({ sessionId: id, url: `http://127.0.0.1/${id}` });
const mount = async (next = props) => { await act(async () => { root.render(<HtmlPreviewPanel {...next} />); }); };
const currentUrl = () => host.querySelector('[data-preview-url]')?.getAttribute('data-preview-url');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  activateSurface('local');
  mocks.create.mockReset().mockResolvedValue(preview('local'));
  mocks.release.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('recreates a preview on a device switch even when workspace and path are identical', async () => {
  await mount();
  expect(currentUrl()).toBe(preview('local').url);
  mocks.create.mockResolvedValueOnce(preview('peer'));
  await act(async () => { activateSurface('peer'); });
  expect(mocks.release).toHaveBeenCalledWith('local');
  expect(currentUrl()).toBe(preview('peer').url);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('discards and releases a delayed result after switching to another device', async () => {
  let resolve!: (value: ReturnType<typeof preview>) => void;
  mocks.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount();
  mocks.create.mockResolvedValueOnce(preview('peer'));
  await act(async () => { activateSurface('peer'); });
  await act(async () => { resolve(preview('stale')); });
  expect(currentUrl()).toBe(preview('peer').url);
  expect(mocks.release).toHaveBeenCalledWith('stale');
});

it('does not recreate or release the gateway just because the tab is hidden', async () => {
  await mount();
  await mount({ ...props, isActive: false });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.release).not.toHaveBeenCalled();
});

it('replaces stale content with the failure from the selected peer', async () => {
  await mount();
  mocks.create.mockRejectedValueOnce(new Error('Update the controlled device'));
  await act(async () => { activateSurface('old-peer'); });
  expect(currentUrl()).toBeUndefined();
  expect(host.textContent).toContain('Update the controlled device');
  expect(mocks.release).toHaveBeenCalledWith('local');
});

it('releases a late creation after its panel is closed', async () => {
  let resolve!: (value: ReturnType<typeof preview>) => void;
  mocks.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount();
  await act(async () => { root.render(null); });
  await act(async () => { resolve(preview('closed')); });
  expect(mocks.release).toHaveBeenCalledWith('closed');
  expect(currentUrl()).toBeUndefined();
});
