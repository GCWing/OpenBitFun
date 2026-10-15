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
const answerConfirmation = (confirm: boolean) => act(async () => {
  const label = confirm ? 'nursery.gallery.newAssistant' : 'dialog.confirm.cancel';
  [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find(button => button.textContent === label)!.click();
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
  ])('requires confirmation from the $entry entry', async ({ index, empty }) => {
    if (empty) mocks.workspaces = [];
    await render();
    await clickCreate(index);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('nursery.gallery.createConfirmMessage');
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(useNurseryStore.getState().page).toBe('gallery');
    await answerConfirmation(true);
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect(useNurseryStore.getState()).toMatchObject({ page: 'assistant', activeWorkspaceId: 'new-assistant' });
  });

  it('cancels without creating an assistant and allows retry', async () => {
    await render();
    await clickCreate();
    await answerConfirmation(false);
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(useNurseryStore.getState().page).toBe('gallery');
    await clickCreate();
    await answerConfirmation(true);
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
  });

  it('keeps one confirmation and request when multiple create entries are clicked', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await clickCreate();
    await clickCreate(1);
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    await answerConfirmation(true);
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
    await act(async () => { finish({ id: 'new-assistant' }); });
    expect(useNurseryStore.getState().activeWorkspaceId).toBe('new-assistant');
  });

  it('shows a creation failure and allows another confirmed attempt', async () => {
    mocks.createAssistant.mockRejectedValueOnce(new Error('Host unavailable'));
    await render();
    await clickCreate();
    await answerConfirmation(true);
    expect(mocks.error).toHaveBeenCalledWith('nursery.gallery.createFailed');
    expect(useNurseryStore.getState().page).toBe('gallery');
    await clickCreate();
    expect(mocks.createAssistant).toHaveBeenCalledOnce();
    await answerConfirmation(true);
    expect(mocks.createAssistant).toHaveBeenCalledTimes(2);
    expect(useNurseryStore.getState().activeWorkspaceId).toBe('new-assistant');
  });

  it('abandons confirmation if the device changes before creation', async () => {
    await render();
    await clickCreate();
    await act(async () => { activateSurface('peer-host'); });
    await answerConfirmation(true);
    expect(mocks.createAssistant).not.toHaveBeenCalled();
    expect(useNurseryStore.getState().page).toBe('gallery');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('does not open an assistant created on a previous device surface', async () => {
    let finish!: (workspace: { id: string }) => void;
    mocks.createAssistant.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    await clickCreate();
    await answerConfirmation(true);
    await act(async () => { activateSurface('peer-host'); finish({ id: 'old-assistant' }); });
    expect(useNurseryStore.getState().page).toBe('gallery');
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
