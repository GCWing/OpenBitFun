// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo } from '@/shared/types';
import WorkspaceRelatedPathsDialog from './WorkspaceRelatedPathsDialog';

const mocks = vi.hoisted(() => ({ references: vi.fn(), update: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({ updateWorkspaceRelatedPaths: mocks.update }),
}));
vi.mock('@/infrastructure/api/service-api/ExternalSourcesAPI', () => ({
  externalSourcesAPI: { getWorkspaceReferences: mocks.references },
}));
vi.mock('@/features/ssh-remote/sshApi', () => ({ sshApi: {} }));
vi.mock('@/features/ssh-remote/RemoteFileBrowser', () => ({ default: () => null }));
vi.mock('@openbitfun/ui', async (importOriginal) => {
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return {
    Disclosure: (await importOriginal<typeof import('@openbitfun/ui')>()).Disclosure,
    Textarea: (await importOriginal<typeof import('@openbitfun/ui')>()).Textarea,
    Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
    DialogBody: Wrapper, DialogFooter: Wrapper, DialogHeader: Wrapper, DialogHeading: Wrapper, DialogTitle: Wrapper,
    DialogClose: () => null, Icon: () => null, Input: () => null,
    Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button disabled={disabled} onClick={onClick}>{children}</button>,
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
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

  it('omits diagnostics when the current workspace has none', async () => {
    mocks.references.mockResolvedValue({ references: [], diagnostics: [] });
    await act(async () => root.render(<WorkspaceRelatedPathsDialog workspace={workspace} isOpen onClose={() => undefined} />));
    expect(container.querySelector('details')).toBeNull();
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
    const field = container.querySelector('[data-openbitfun-component="textarea"]')!;
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
