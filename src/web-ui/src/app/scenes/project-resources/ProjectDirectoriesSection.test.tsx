/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { ProjectDirectoriesSection } from './ProjectDirectoriesSection';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({
  t: (key: string, options?: { name?: string }) => options?.name ? `${key}:${options.name}` : key,
}) }));
const workspace: WorkspaceInfo = { id: 'project', name: 'Project', rootPath: '/repo', workspaceKind: WorkspaceKind.Normal,
  workspaceType: WorkspaceType.SingleProject, languages: [], tags: [], openedAt: '', lastAccessed: '',
  relatedPaths: Array.from({ length: 4 }, (_, index) => ({ path: `/related/${index}`, description: `Directory ${index}` })) };
const browse = vi.fn();
const manage = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const reveal = vi.fn();
let container: HTMLDivElement;
let root: Root;
let width: number;
const resizeListeners = new Set<() => void>();
const track = () => container.querySelector<HTMLUListElement>('.project-resource-cards__track')!;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const previous = () => button('directories.scrollPrevious');
const next = () => button('directories.scrollNext');
const render = async (target = workspace, fileAccess = true, canReveal = true) => act(async () => root.render(
  <ProjectDirectoriesSection workspace={target} fileAccess={fileAccess} onBrowse={browse} onManage={manage}
    onAdd={add} onRemove={remove} removingPath={null} canReveal={canReveal} onReveal={reveal} revealingPath={null} error={null} />));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  width = 632;
  resizeListeners.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { resizeListeners.add(callback); }
    observe() {}
    disconnect() { resizeListeners.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return this.classList.contains('project-resource-cards__track') ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function () {
    return this.classList.contains('project-resource-cards__track')
      ? this.querySelectorAll('.project-resource-cards__cell').length * 256 + (this.querySelector('.project-resource-cards__add') ? 120 : 0) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function () {
    return this.parentElement?.classList.contains('project-resource-cards__track') ? Array.from(this.parentElement.children).indexOf(this) * 256 : 0;
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the primary directory first and routes browsing and related-directory editing separately', async () => {
  await render();
  expect(track().querySelectorAll('.project-resource-cards__cell')).toHaveLength(5);
  expect(track().firstElementChild?.textContent).toContain('/repodirectories.primary');
  await act(async () => button('directories.openDirectory:Project')!.click());
  expect(browse).toHaveBeenCalledOnce();
  await act(async () => button('directories.editDirectory:0')!.click());
  expect(manage).toHaveBeenCalledOnce();
  expect(button('directories.removeDirectory:Project')).toBeNull();
  const revealButton = button('directories.revealDirectory:Project')!;
  expect(revealButton.getAttribute('data-openbitfun-variant')).toBe('glass');
  expect(revealButton.getAttribute('data-openbitfun-shape')).toBe('circle');
  await act(async () => revealButton.click());
  await act(async () => button('directories.revealDirectory:0')!.click());
  expect(reveal.mock.calls).toEqual([['/repo'], ['/related/0']]);
  expect(browse).toHaveBeenCalledOnce();
  expect(manage).toHaveBeenCalledOnce();
  const deleteButton = button('directories.removeDirectory:0')!;
  expect(deleteButton.getAttribute('data-openbitfun-variant')).toBe('glass');
  expect(deleteButton.getAttribute('data-openbitfun-shape')).toBe('circle');
  await act(async () => deleteButton.click());
  expect(remove).toHaveBeenCalledExactlyOnceWith('/related/0');
  expect(manage).toHaveBeenCalledOnce();
  expect(container.querySelector('.project-resource-cards__add')).toBeNull();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.project-resources__section-actions button')]
    .find(button => button.textContent === 'directories.add')!.click());
  expect(add).toHaveBeenCalledOnce();
  await render(workspace, false);
  expect(button('directories.openDirectory:Project')?.disabled).toBe(true);
  expect(button('directories.editDirectory:0')?.disabled).toBe(false);
  await render(workspace, true, false);
  expect(button('directories.revealDirectory:Project')?.disabled).toBe(true);
  expect(button('directories.revealDirectory:0')?.disabled).toBe(true);
  expect(button('directories.editDirectory:0')?.disabled).toBe(false);
});

it('supports bounded card navigation, keyboard and reduced motion, and updates overflow when resized or edited', async () => {
  await render();
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    track().scrollLeft = options.left ?? 0;
    track().dispatchEvent(new Event('scroll'));
  });
  track().scrollTo = scrollTo;
  expect(previous()?.disabled).toBe(true);
  expect(next()?.getAttribute('aria-controls')).toBe(track().id);
  await act(async () => next()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 256, behavior: 'smooth' });
  await act(async () => next()!.click());
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 512, behavior: 'auto' });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  await act(async () => next()!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 648, behavior: 'auto' });
  expect(next()?.disabled).toBe(true);
  await act(async () => { width = 0; resizeListeners.forEach(callback => callback()); });
  expect(next()).toBeNull();
  await act(async () => { width = 632; resizeListeners.forEach(callback => callback()); });
  expect(previous()?.disabled).toBe(false);
  await render({ ...workspace, relatedPaths: [] });
  expect(track().scrollLeft).toBe(0);
  expect(next()).toBeNull();
  expect(container.querySelector('.project-resource-cards__add button')?.textContent).toBe('directories.add');
  expect(container.querySelector('.project-resources__section-actions')?.textContent).not.toContain('directories.add');
});

it('preserves POSIX names on remote hosts and reads Windows separators only for local paths', async () => {
  await render({ ...workspace, workspaceKind: WorkspaceKind.Remote, connectionId: 'ssh-a', relatedPaths: [{ path: '/srv/docs\\reference' }] });
  expect(track().children[1].querySelector('.project-resource-cards__name')?.textContent).toBe('docs\\reference');
  await render({ ...workspace, relatedPaths: [{ path: 'C:\\repo\\reference' }] });
  expect(track().children[1].querySelector('.project-resource-cards__name')?.textContent).toBe('reference');
});
