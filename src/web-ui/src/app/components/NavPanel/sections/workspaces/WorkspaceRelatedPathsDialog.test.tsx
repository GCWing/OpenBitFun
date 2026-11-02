// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '@/shared/types';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import WorkspaceRelatedPathsDialog from './WorkspaceRelatedPathsDialog';

const mocks = vi.hoisted(() => ({ references: vi.fn(), update: vi.fn(), pick: vi.fn(), serverInfo: vi.fn(), browser: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => [key, ...Object.values(values ?? {})].join(' ') }),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ updateWorkspaceRelatedPaths: mocks.update }),
}));
vi.mock('@/infrastructure/api/service-api/ExternalSourcesAPI', () => ({
  externalSourcesAPI: { getWorkspaceReferences: mocks.references },
}));
vi.mock('@/infrastructure/peer-device/pickWorkspaceDirectory', () => ({ pickWorkspaceDirectory: mocks.pick }));
vi.mock('@/features/ssh-remote/sshApi', () => ({ sshApi: { getServerInfo: mocks.serverInfo } }));
vi.mock('@/features/ssh-remote/RemoteFileBrowser', () => ({ default: (props: unknown) => { mocks.browser(props); return null; } }));
vi.mock('@openbitfun/ui', async (importOriginal) => {
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    ...await importOriginal<typeof import('@openbitfun/ui')>(),
    Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
    DialogBody: Wrapper, DialogFooter: Wrapper, DialogHeader: Wrapper, DialogHeading: Wrapper, DialogTitle: Wrapper, DialogDescription: Wrapper,
    DialogClose: () => null,
  };
});

describe('related directory dialog', () => {
  let root: Root;
  let container: HTMLDivElement;
  const workspace = { id: 'workspace-1', name: 'Project', rootPath: '/project', workspaceKind: 'normal', relatedPaths: [] } as unknown as WorkspaceInfo;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.references.mockReset();
    mocks.update.mockReset();
    mocks.pick.mockReset();
    mocks.browser.mockClear();
    mocks.serverInfo.mockReset().mockResolvedValue({ homeDir: '/home/project' });
    resetDeviceSurfaceForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    resetDeviceSurfaceForTest();
  });

  it('reveals loaded diagnostics without refetching or modifying related paths', async () => {
    mocks.references.mockResolvedValue({ references: [], diagnostics: [{ code: 'source.unavailable' }] });
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen onClose={() => undefined} />));
    expect(mocks.references).toHaveBeenCalledExactlyOnceWith('workspace-1');
    const details = container.querySelector<HTMLDetailsElement>('details[data-openbitfun-component="disclosure"]')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    const diagnostic = details.querySelector('li')!;
    expect(diagnostic.textContent).toBe('source.unavailable');
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(false);
    expect(details.querySelector('li')).toBe(diagnostic);
    expect(mocks.references).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('omits the external section when there are no references or diagnostics', async () => {
    mocks.references.mockResolvedValue({ references: [], diagnostics: [] });
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen onClose={() => undefined} />));
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).not.toContain('nav.workspaces.relatedPaths.dialog.externalHeading');
    const primary = container.querySelector('[role="table"] > .workspace-related-paths-dialog__row')!;
    expect(primary.textContent).toContain('Project');
    expect(primary.textContent).toContain('/project');
    expect(primary.textContent).toContain('nav.workspaces.relatedPaths.dialog.primaryDirectory');
    expect(primary.querySelector('button')).toBeNull();
  });

  it('opens a standalone add form and saves alongside existing directories without loading the table', async () => {
    mocks.references.mockResolvedValue({ references: [], diagnostics: [] });
    mocks.update.mockResolvedValue(undefined);
    const existing = { path: '/reference', description: 'Keep this directory' };
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={{ ...workspace, relatedPaths: [existing] }}
      isOpen initialAdd onClose={() => undefined} />));
    const input = container.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('');
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[role="table"]')).toBeNull();
    expect(mocks.references).not.toHaveBeenCalled();
    const save = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(save.disabled).toBe(true);
    act(() => { input.value = '/new-directory'; Simulate.change(input); });
    await act(async () => save.click());
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('workspace-1', [existing, { path: '/new-directory' }]);
  });

  it('stages additions from a separate child dialog and leaves the table unchanged on cancel', async () => {
    mocks.references.mockResolvedValue({ references: [], diagnostics: [] });
    mocks.update.mockResolvedValue(undefined);
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen onClose={() => undefined} />));
    const add = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'nav.workspaces.relatedPaths.dialog.add')!;
    await act(async () => add().click());
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(container.querySelector('[role="table"] input')).toBeNull();
    const child = () => [...container.querySelectorAll('[role="dialog"]')].at(-1)!;
    await act(async () => [...child().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'actions.cancel')!.click());
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="table"] .workspace-related-paths-dialog__row')).toHaveLength(1);
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => add().click());
    const input = child().querySelector('input')!;
    act(() => { input.value = '/new'; Simulate.change(input); });
    await act(async () => child().querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="table"]')?.textContent).toContain('/new');
    expect(container.querySelector('[role="table"] input')).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'actions.save')!.click());
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('workspace-1', [{ path: '/new' }]);
  });

  it('keeps the add form and existing directories after a failed save, then retries', async () => {
    const close = vi.fn();
    mocks.update.mockRejectedValueOnce(new Error('Host unavailable')).mockResolvedValue(undefined);
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen initialAdd onClose={close} />));
    const input = container.querySelector('input')!;
    act(() => { input.value = '/retry'; Simulate.change(input); });
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(container.textContent).toContain('Host unavailable');
    expect(input.value).toBe('/retry');
    expect(close).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses the owning SSH connection for the independent directory picker', async () => {
    mocks.update.mockResolvedValue(undefined);
    const remote = { ...workspace, workspaceKind: 'remote', connectionId: 'ssh-owner' } as WorkspaceInfo;
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={remote} isOpen initialAdd onClose={() => undefined} />));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'actions.select')!.click());
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(mocks.browser).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'ssh-owner', initialPath: '/project', homePath: '/home/project' }));
    await act(async () => mocks.browser.mock.lastCall![0].onSelect('/srv/reference'));
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('workspace-1', [{ path: '/srv/reference' }]);
  });

  it('ignores a picker result after switching devices', async () => {
    let select!: (path: string) => void;
    mocks.pick.mockReturnValue(new Promise(resolve => { select = resolve; }));
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen initialAdd onClose={() => undefined} />));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'actions.select')!.click());
    await act(async () => activateSurface('peer:other'));
    await act(async () => select('/old-device/directory'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps external rows read-only and only persists directory removal on Save', async () => {
    mocks.references.mockResolvedValue({ references: [
      { stableKey: 'visible', alias: 'reference', path: '/external/reference', description: 'External reference',
        origin: 'external', sourceDisplayName: 'OpenCode', hidden: false },
      { stableKey: 'hidden', alias: 'hidden', path: '/external/hidden', origin: 'external', hidden: true },
    ], diagnostics: [] });
    mocks.update.mockResolvedValue(undefined);
    await act(async () => root.render(<WorkspaceRelatedPathsDialog
      workspace={{ ...workspace, relatedPaths: [{ path: '/related' }] }} isOpen onClose={() => undefined} />));
    const external = container.querySelector('[role="table"][aria-label="nav.workspaces.relatedPaths.dialog.externalHeading"]')!;
    expect(external.textContent).toContain('/external/reference');
    expect(external.textContent).not.toContain('/external/hidden');
    expect(external.querySelector('button')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="newProject.removeFolder related"]')!.click());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector('[role="table"]')?.textContent).not.toContain('/related');
    expect(external.textContent).toContain('/external/reference');
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'actions.save')!;
    await act(async () => save.click());
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('workspace-1', []);
  });

  it('keeps failed discovery visible instead of presenting it as an empty result', async () => {
    mocks.references.mockRejectedValue(new Error('Source unavailable'));
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen onClose={() => undefined} />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('nav.workspaces.relatedPaths.messages.externalLoadFailed');
    expect(container.textContent).toContain('nav.workspaces.relatedPaths.dialog.externalHeading');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('edits and saves a description through the actual shared Textarea', async () => {
    mocks.references.mockResolvedValue({ references: [], diagnostics: [] });
    mocks.update.mockResolvedValue(undefined);
    const onClose = vi.fn();
    await act(async () => root.render(
      <WorkspaceRelatedPathsDialog
        workspace={{ ...workspace, relatedPaths: [{ path: '/project/reference', description: 'Reference implementation' }] }}
        isOpen
        onClose={onClose}
      />,
    ));
    expect(container.querySelector('textarea')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="actions.edit"]')!.click());
    const field = container.querySelector('[data-openbitfun-component="textarea"]')!;
    expect(container.querySelector('[role="table"] > .workspace-related-paths-dialog__row')?.textContent).toContain('Project');
    const input = field.querySelector('textarea')!;
    expect(field.getAttribute('data-layout')).toBe('fill');
    expect(field.getAttribute('data-resize')).toBe('none');
    expect(input.value).toBe('Reference implementation');
    const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'actions.save')!;
    expect(save.disabled).toBe(true);
    act(() => {
      input.value = 'Reference implementation\nKeep this directory available for comparison.';
      Simulate.change(input);
    });
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith('workspace-1', [{
      path: '/project/reference',
      description: 'Reference implementation\nKeep this directory available for comparison.',
    }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
