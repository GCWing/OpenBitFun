/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import WorkspaceProjectPermissionsDialog, { WorkspaceProjectPermissionsPanel } from './WorkspaceProjectPermissionsDialog';

const mocks = vi.hoisted(() => ({
  grants: vi.fn(), rules: vi.fn(), save: vi.fn(), remove: vi.fn(), clear: vi.fn(), confirm: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatDate: String, formatNumber: String }) }));
vi.mock('@/infrastructure/api/service-api/PermissionAPI', () => ({ permissionAPI: {
  listProjectGrants: mocks.grants, getProjectRules: mocks.rules, saveProjectRules: mocks.save,
  removeProjectGrant: mocks.remove, clearProjectGrants: mocks.clear,
} }));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: mocks.confirm }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { success: mocks.success, error: mocks.error } }));

const workspace: WorkspaceInfo = { id: 'owned', name: 'Owned project', rootPath: '/owned',
  workspaceKind: WorkspaceKind.Normal, workspaceType: WorkspaceType.SingleProject,
  languages: [], tags: [], openedAt: '', lastAccessed: '' };
const rule = { action: 'read', resource: 'src/*', effect: 'ask' };
const grant = { projectId: 'owned', action: 'read', resource: 'docs/*', createdAtMs: 1 };
let container: HTMLDivElement;
let root: Root;
const render = async (isActive = true, refreshKey = 0, target = workspace) => {
  await act(async () => root.render(<WorkspaceProjectPermissionsPanel workspace={target} isActive={isActive} refreshKey={refreshKey} />));
};
const resource = () => document.querySelector<HTMLInputElement>('input[aria-label="projectPermissions.resource"]')!;
const editResource = (value: string) => act(() => {
  const input = resource();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (label: string, parent: ParentNode = document.body) => [...parent.querySelectorAll<HTMLButtonElement>('button')]
  .find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
const click = async (label: string) => act(async () => { button(label).click(); });
const openList = async () => act(async () => container.querySelector<HTMLButtonElement>('.project-resource-summary__pane--action')!.click());
const editRule = async () => click('projectPermissions.editAuthorization');

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.resetAllMocks();
  mocks.grants.mockResolvedValue([grant]);
  mocks.rules.mockResolvedValue({ rules: [rule], revision: 'v1' });
  mocks.save.mockImplementation(async (_workspaceId, rules) => ({ rules, revision: 'v2' }));
  mocks.confirm.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); resetDeviceSurfaceForTest(); });

it('combines both sources in the summary and saves edited rules with the owning project and revision', async () => {
  await render();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.rules).toHaveBeenCalledExactlyOnceWith('owned');
  expect(container.querySelector('.project-resource-summary__value')?.textContent).toBe('2');
  expect(container.querySelector('[title^="projectPermissions.grantsTitle"]')).not.toBeNull();
  expect(container.querySelector('[title^="projectPermissions.rulesTitle"]')).not.toBeNull();
  await openList();
  expect(document.querySelectorAll('[role="table"] > .workspace-project-permissions-dialog__row')).toHaveLength(2);
  await editRule();
  editResource('tests/*');
  expect(mocks.save).not.toHaveBeenCalled();
  await click('projectPermissions.saveRules');
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith('owned', [{ ...rule, resource: 'tests/*' }], 'v1');
  expect(button('projectPermissions.saveRules')).toBeUndefined();
  await editRule();
  editResource('lib/*');
  await click('projectPermissions.saveRules');
  expect(mocks.save).toHaveBeenLastCalledWith('owned', [{ ...rule, resource: 'lib/*' }], 'v2');
});

it('preserves unsaved rules through refresh and tab reactivation, then supports discard and reload', async () => {
  await render();
  await openList();
  await editRule();
  editResource('draft/*');
  mocks.rules.mockResolvedValue({ rules: [{ ...rule, resource: 'external/*' }], revision: 'external' });
  await render(true, 1);
  await render(false, 1);
  await render(true, 1);
  await openList();
  expect(resource().value).toBe('draft/*');
  expect(mocks.rules).toHaveBeenCalledTimes(1);
  await click('projectPermissions.cancel');
  await editRule();
  expect(resource().value).toBe('src/*');
  await render(true, 2);
  await editRule();
  expect(resource().value).toBe('external/*');
});

it('shows retryable host failures instead of empty rules while retaining readable grants', async () => {
  mocks.rules.mockRejectedValue(new Error('Host does not support project rules'));
  await render();
  expect(container.textContent).toContain('Host does not support project rules');
  expect(container.textContent).toContain('docs/*');
  expect(container.textContent).not.toContain('projectPermissions.rulesEmpty');
  expect(button('projectPermissions.addAuthorization').disabled).toBe(true);
  mocks.rules.mockResolvedValue({ rules: [rule], revision: 'v1' });
  await click('common:retry');
  await openList();
  await editRule();
  expect(resource().value).toBe('src/*');
  expect(container.textContent).not.toContain('Host does not support project rules');
});

it('revokes grants only in the owning project and reloads their state', async () => {
  await render();
  mocks.grants.mockResolvedValue([]);
  await openList();
  await click('projectPermissions.removeGrant');
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('owned', grant);
  expect(document.querySelector('[role="table"]')?.textContent).not.toContain('docs/*');
  expect(container.querySelector('.project-resource-summary__value')?.textContent).toBe('1');
});

it('does not apply confirmation from a previous device and ignores its delayed reads', async () => {
  let finishRules!: (value: unknown) => void;
  let confirm!: (value: boolean) => void;
  mocks.rules.mockReturnValueOnce(new Promise(resolve => { finishRules = resolve; }));
  await render();
  // Wait for the first read to settle before opening a mutation confirmation.
  await act(async () => finishRules({ rules: [rule], revision: 'v1' }));
  mocks.confirm.mockReturnValueOnce(new Promise(resolve => { confirm = resolve; }));
  await openList();
  await click('projectPermissions.removeGrant');
  mocks.rules.mockReturnValueOnce(new Promise(resolve => { finishRules = resolve; }));
  await render(true, 1);
  mocks.rules.mockResolvedValue({ rules: [{ ...rule, resource: 'peer/*' }], revision: 'peer' });
  await act(async () => activateSurface('peer:other'));
  await act(async () => {
    confirm(true);
    finishRules({ rules: [{ ...rule, resource: 'old-private/*' }], revision: 'old' });
  });
  expect(mocks.remove).not.toHaveBeenCalled();
  await openList();
  await editRule();
  expect(resource().value).toBe('peer/*');
});

it('keeps the draft and revision intact after a conflicting save', async () => {
  await render();
  mocks.save.mockRejectedValue(new Error('Rules changed outside OpenBitFun'));
  await openList();
  await editRule();
  editResource('draft/*');
  await click('projectPermissions.saveRules');
  expect(resource().value).toBe('draft/*');
  expect(mocks.error).toHaveBeenCalledWith('projectPermissions.rulesConflict');
  expect(button('projectPermissions.saveRules').disabled).toBe(false);
});

it('does not fetch hidden panels or carry drafts across projects', async () => {
  await render(false);
  expect(mocks.rules).not.toHaveBeenCalled();
  await render();
  await openList();
  await editRule();
  editResource('private/*');
  await render(true, 0, { ...workspace, id: 'other', rootPath: '/other' });
  await openList();
  await editRule();
  expect(resource().value).toBe('src/*');
  expect(mocks.rules).toHaveBeenLastCalledWith('other');
  expect(button('projectPermissions.saveRules')).toBeUndefined();
});

it('keeps the direct dialog entry compatible with the shared list editor', async () => {
  await act(async () => root.render(<WorkspaceProjectPermissionsDialog workspace={workspace} isOpen onClose={vi.fn()} />));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Owned project');
  expect(dialog.textContent).toContain('projectPermissions.grantsTitle');
  await editRule();
  expect(dialog.querySelector('input')?.value).toBe('src/*');
});

it('opens a separate creation dialog from the empty action and saves only the completed authorization', async () => {
  mocks.grants.mockResolvedValue([]);
  mocks.rules.mockResolvedValue({ rules: [], revision: 'empty' });
  await render();
  const pane = container.querySelector('.project-resource-summary__pane:not(button)')!;
  expect(pane.querySelector('.project-resource-summary__title')).toBeNull();
  expect(pane.textContent).toBe('projectPermissions.addAuthorization');
  expect(container.querySelector('.workspace-project-permissions-dialog__heading button')).toBeNull();
  await act(async () => pane.querySelector<HTMLButtonElement>('button')!.click());
  expect(resource().value).toBe('');
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('[role="table"]')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled();
  const action = document.querySelector<HTMLSelectElement>('select[aria-label="projectPermissions.action"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(action, 'bash');
    action.dispatchEvent(new Event('change', { bubbles: true }));
  });
  editResource('pnpm test');
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith('owned', [{ action: 'bash', resource: 'pnpm test', effect: 'allow' }], 'empty');
  expect(container.querySelector('.project-resource-summary__value')?.textContent).toBe('1');
  expect(container.querySelector('.project-resource-summary__empty')).toBeNull();
  expect(container.querySelector('.workspace-project-permissions-dialog__heading button')?.textContent).toBe('projectPermissions.addAuthorization');
});


it('cancels standalone addition without changing saved permissions and retains input after a failure', async () => {
  await render();
  await click('projectPermissions.addAuthorization');
  editResource('discarded/*');
  await click('projectPermissions.cancel');
  expect(mocks.save).not.toHaveBeenCalled();
  expect(container.querySelector('.project-resource-summary__value')?.textContent).toBe('2');
  await click('projectPermissions.addAuthorization');
  expect(resource().value).toBe('');
  await fillNewPermission('new/*');
  mocks.save.mockRejectedValueOnce(new Error('Host offline'));
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(resource().value).toBe('new/*');
  expect(document.body.textContent).toContain('projectPermissions.rulesSaveFailed');
  expect(document.querySelector('[role="table"]')).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(mocks.save).toHaveBeenLastCalledWith('owned', [rule, { action: 'read', resource: 'new/*', effect: 'allow' }], 'v1');
});

it('stages a completed addition from the list without inserting a blank rule or saving other drafts', async () => {
  await render();
  await openList();
  const list = document.querySelector('[role="dialog"]')!;
  await act(async () => button('projectPermissions.addAuthorization', list).click());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  expect(list.querySelectorAll('[data-openbitfun-part="rule"]')).toHaveLength(1);
  await fillNewPermission('staged/*');
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(mocks.save).not.toHaveBeenCalled();
  expect(list.querySelectorAll('[data-openbitfun-part="rule"]')).toHaveLength(2);
  await click('projectPermissions.saveRules');
  expect(mocks.save).toHaveBeenLastCalledWith('owned', [rule, { action: 'read', resource: 'staged/*', effect: 'allow' }], 'v1');
});

async function fillNewPermission(value: string) {
  const action = document.querySelector<HTMLSelectElement>('select[aria-label="projectPermissions.action"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(action, 'read');
    action.dispatchEvent(new Event('change', { bubbles: true }));
  });
  editResource(value);
}
