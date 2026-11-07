// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogRenderer, useConfirmDialogStore } from '@/infrastructure/confirm-dialog';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { useNurseryStore } from '../nurseryStore';
import NurseryGallery from './NurseryGallery';

const mocks = vi.hoisted(() => ({
  createAssistant: vi.fn(),
  error: vi.fn(),
  workspaces: [{ id: 'existing-assistant' }],
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    allAssistantWorkspacesList: mocks.workspaces,
    openedWorkspaces: new Set(),
    assistantWorkspaces: mocks.workspaces,
    primaryAssistantWorkspaceId: 'existing-assistant',
    createAssistantWorkspace: mocks.createAssistant,
    loading: false,
  }),
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('./AssistantCard', () => ({ default: () => null }));

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => {
  root.render(<><NurseryGallery /><ConfirmDialogRenderer /></>);
});
const clickCreate = (index = 0) => act(async () => {
  [...container.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => button.textContent === 'nursery.gallery.newAssistant')[index].click();
});

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  resetDeviceSurfaceForTest();
  useConfirmDialogStore.setState({ isOpen: false, options: null, resolve: null });
  useNurseryStore.setState(useNurseryStore.getInitialState(), true);
  mocks.workspaces = [{ id: 'existing-assistant' }];
  mocks.createAssistant.mockReset().mockResolvedValue({ id: 'new-assistant' });
  mocks.error.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { useConfirmDialogStore.getState().cancel(); });
  act(() => root.unmount());
  container.remove();
  resetDeviceSurfaceForTest();
  vi.unstubAllGlobals();
});

describe('assistant gallery creation', () => {
  it.each([
    { entry: 'header', index: 0, empty: false },
    { entry: 'create card', index: 1, empty: false },
    { entry: 'empty state', index: 1, empty: true },
  ])('creates directly from the $entry entry', async ({ index, empty }) => {
    if (empty) mocks.workspaces = [];
    await render();
    await clickCreate(index);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect(useNurseryStore.getState()).toMatchObject({ page: 'assistant', activeWorkspaceId: 'new-assistant' });
  });

  it('keeps one request when multiple create entries are clicked', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    const entries = [...container.querySelectorAll<HTMLButtonElement>('button')];
    await act(async () => { entries[0].click(); entries[1].click(); entries[0].click(); });
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect(entries.every(button => button.disabled)).toBe(true);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => { finish({ id: 'new-assistant' }); });
    expect(useNurseryStore.getState().activeWorkspaceId).toBe('new-assistant');
  });

  it('shows a creation failure and allows retry', async () => {
    mocks.createAssistant.mockRejectedValueOnce(new Error('Host unavailable'));
    await render();
    await clickCreate();
    expect(mocks.error).toHaveBeenCalledWith('nursery.gallery.createFailed');
    expect(useNurseryStore.getState().page).toBe('gallery');
    await clickCreate();
    expect(mocks.createAssistant).toHaveBeenCalledTimes(2);
    expect(useNurseryStore.getState().activeWorkspaceId).toBe('new-assistant');
  });

  it('ignores a creation failure after the device changes', async () => {
    let fail!: (error: Error) => void;
    mocks.createAssistant.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    await render();
    await clickCreate();
    await act(async () => { activateSurface('peer-host'); fail(new Error('Old host unavailable')); });
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect(useNurseryStore.getState().page).toBe('gallery');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('does not open an assistant created on a previous device surface', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await clickCreate();
    await act(async () => { activateSurface('peer-host'); finish({ id: 'old-assistant' }); });
    expect(useNurseryStore.getState().page).toBe('gallery');
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
