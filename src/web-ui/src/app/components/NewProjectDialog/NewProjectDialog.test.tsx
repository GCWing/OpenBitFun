// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from './NewProjectDialog';
import { activateSurface, resetDeviceSurfaceForTest, surfaceIdForDevice } from '@/infrastructure/peer-device/deviceSurface';
import { ProjectDirectoryUnavailableError } from '@/app/utils/projectDraft';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { pickDirectory } = vi.hoisted(() => ({ pickDirectory: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/utils/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/infrastructure/peer-device/pickWorkspaceDirectory', () => ({ pickWorkspaceDirectory: pickDirectory }));

describe('NewProjectDialog composition', () => {
  let root: Root;
  let host: HTMLDivElement;
  const close = vi.fn();
  const confirm = vi.fn();
  const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label)!;
  const choice = (kind: 'assistant' | 'project') => document.querySelector<HTMLButtonElement>(`[data-testid="nav-session-group-add-${kind}"]`)!;
  const nameInput = () => document.querySelector<HTMLInputElement>('input')!;
  const enterName = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput(), value);
    nameInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  const choose = async (kind: 'assistant' | 'project') => { await act(async () => { choice(kind).click(); }); };
  const add = async (path: string) => { pickDirectory.mockResolvedValueOnce(path); await click('actions.add'); };

  beforeEach(() => {
    vi.resetAllMocks();
    confirm.mockResolvedValue(true);
    resetDeviceSurfaceForTest();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); resetDeviceSurfaceForTest(); });
  const render = async (extra = {}) => {
    await act(async () => root.render(<NewProjectDialog isOpen defaultParentPath="/srv" onClose={close} onConfirm={confirm} {...extra} />));
  };

  it('uses the single source folder name when the name is left empty', async () => {
    await render();
    expect(button('newProject.create').disabled).toBe(true);
    await add('/srv/frontend');
    expect(nameInput().value).toBe('');
    expect(nameInput().placeholder).toBe('frontend');
    expect(pickDirectory).toHaveBeenCalledWith({ title: 'newProject.selectSourceFolder', defaultPath: '/srv' });
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: '', folders: [{ path: '/srv/frontend' }] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('adds multiple folders, ignores duplicates, and requires a unified name', async () => {
    await render();
    await add('/srv/frontend');
    await add('/srv/backend');
    await add('/srv/backend/');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(button('newProject.create').disabled).toBe(true);
    enterName(' Product ');
    expect(document.querySelector('.new-project-dialog__save-location')).toBeNull();
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: 'Product', folders: [{ path: '/srv/frontend' }, { path: '/srv/backend' }] });
  });

  it('removes a source and derives the remaining folder name', async () => {
    await render();
    await add('/srv/frontend');
    await add('/srv/backend');
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="newProject.removeFolder"]')!.click());
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(nameInput().placeholder).toBe('backend');
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: '', folders: [{ path: '/srv/backend' }] });
  });

  it('submits an empty project directly without choosing a save location', async () => {
    await render();
    expect(document.querySelector('.new-project-dialog__save-location')).toBeNull();
    enterName('example');
    expect(document.querySelector('.new-project-dialog__save-location')?.textContent).toBe('newProject.emptyProjectHint ~/OpenBitFun/Projects/example');
    await click('newProject.create');
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith({ name: 'example', folders: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it('locks actions during submission and preserves the draft after failure', async () => {
    let reject!: (error: Error) => void;
    confirm.mockReturnValue(new Promise<boolean>((_, fail) => { reject = fail; }));
    await render();
    await add('/srv/frontend');
    await add('/srv/backend');
    enterName('Product');
    await click('newProject.create');
    expect(button('newProject.cancel').disabled).toBe(true);
    expect(button('actions.add').disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);
    await act(async () => { reject(new Error('Host offline')); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host offline');
    expect(document.querySelectorAll('li')).toHaveLength(2);
    expect(nameInput().value).toBe('Product');
    expect(button('newProject.create').disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps remote additions on the same connection without opening local pickers', async () => {
    const remote = { connectionId: 'ssh-1', connectionName: 'Host' };
    const pickRemote = vi.fn().mockResolvedValueOnce({ path: '/srv/a', remote }).mockResolvedValueOnce({ path: '/srv/b', remote });
    await render({ onPickRemoteFolder: pickRemote });
    act(() => {
      const source = document.querySelector('select')!;
      source.value = 'remote';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('actions.add');
    await click('actions.add');
    expect(pickRemote).toHaveBeenLastCalledWith({ path: '/srv/a', remote });
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(document.querySelector('select')!.disabled).toBe(true);
    enterName('Remote product');
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: 'Remote product', folders: [{ path: '/srv/a', remote }, { path: '/srv/b', remote }] });
  });

  it('surfaces selection failures and rejects stale device drafts', async () => {
    await render();
    pickDirectory.mockRejectedValueOnce(new Error('Host unavailable'));
    await click('actions.add');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host unavailable');
    await add('/srv/frontend');
    activateSurface(surfaceIdForDevice('another-host'));
    await click('newProject.create');
    expect(confirm).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('selects only the SSH host for an empty remote project and preserves a cancelled draft', async () => {
    const remote = { connectionId: 'ssh-1', connectionName: 'Host' };
    const pickRemote = vi.fn();
    const selectHost = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(remote);
    await render({ onPickRemoteFolder: pickRemote, onSelectRemoteHost: selectHost });
    act(() => {
      const source = document.querySelector('select')!;
      source.value = 'remote';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    enterName('example');
    await click('newProject.create');
    expect(confirm).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('example');
    await click('newProject.create');
    expect(confirm).toHaveBeenCalledWith({ name: 'example', folders: [], remote });
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(pickRemote).not.toHaveBeenCalled();
  });

  it('explains an unavailable host directory and leaves the name editable', async () => {
    confirm.mockRejectedValue(new ProjectDirectoryUnavailableError());
    await render();
    enterName('example');
    await click('newProject.create');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('newProject.defaultDirectoryUnavailable');
    expect(nameInput().value).toBe('example');
    expect(nameInput().disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('starts at the choice and preserves the project draft when going back', async () => {
    const createAssistant = vi.fn();
    await render({ onCreateAssistant: createAssistant });
    expect(nameInput()).toBeNull();
    expect(choice('assistant')).toBe(document.activeElement);
    expect(document.querySelector('[data-openbitfun-part="footer"]')).toBeNull();
    expect(button('newProject.cancel')).toBeUndefined();
    expect(document.querySelectorAll('[data-openbitfun-component="action-card"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-openbitfun-component="action-card"] button')).toHaveLength(2);
    expect(confirm).not.toHaveBeenCalled();
    await choose('project');
    expect(nameInput()).toBe(document.activeElement);
    enterName('Product');
    await add('/srv/frontend');
    await click('newWorkspace.back');
    expect(choice('assistant')).toBe(document.activeElement);
    expect(createAssistant).not.toHaveBeenCalled();
    await choose('project');
    expect(nameInput().value).toBe('Product');
    expect(document.querySelectorAll('li')).toHaveLength(1);
    await click('newWorkspace.createProject');
    expect(confirm).toHaveBeenCalledWith({ name: 'Product', folders: [{ path: '/srv/frontend' }] });
    expect(createAssistant).not.toHaveBeenCalled();
  });

  it('creates an assistant on a card click and prevents duplicate submissions', async () => {
    let finish!: () => void;
    const createAssistant = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await render({ onCreateAssistant: createAssistant });
    await act(async () => {
      const submit = choice('assistant');
      submit.click();
      submit.click();
    });
    expect(createAssistant).toHaveBeenCalledOnce();
    expect(choice('assistant').disabled).toBe(true);
    expect(choice('project').disabled).toBe(true);
    expect(choice('assistant').getAttribute('aria-busy')).toBe('true');
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('keeps assistant creation failures on the choice for retry', async () => {
    const createAssistant = vi.fn().mockRejectedValueOnce(new Error('Host offline')).mockResolvedValueOnce(undefined);
    await render({ onCreateAssistant: createAssistant });
    await choose('assistant');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Host offline');
    expect(close).not.toHaveBeenCalled();
    expect(choice('assistant').disabled).toBe(false);
    expect(choice('project').disabled).toBe(false);
    await choose('assistant');
    expect(createAssistant).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('resets to the first level after closing and rejects assistant creation on a changed device', async () => {
    const createAssistant = vi.fn();
    await render({ onCreateAssistant: createAssistant });
    await choose('project');
    enterName('Old draft');
    await render({ isOpen: false, onCreateAssistant: createAssistant });
    await render({ onCreateAssistant: createAssistant });
    expect(nameInput()).toBeNull();
    await choose('project');
    expect(nameInput().value).toBe('');
    await click('newWorkspace.back');
    activateSurface(surfaceIdForDevice('another-host'));
    await choose('assistant');
    expect(createAssistant).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
