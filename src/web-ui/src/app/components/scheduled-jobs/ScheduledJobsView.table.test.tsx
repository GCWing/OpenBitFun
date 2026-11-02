/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import type { CronJob } from '@/infrastructure/api/service-api/CronAPI';
import ScheduledJobsView from './ScheduledJobsView';
import ScheduledJobsModal from './ScheduledJobsModal';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), confirm: vi.fn(), error: vi.fn(),
  modes: vi.fn(), t: (key: string) => key, state: { sessions: new Map() },
}));
vi.mock('@/infrastructure/api', () => ({ cronAPI: { listJobs: mocks.list, createJob: mocks.create, updateJob: mocks.update, deleteJob: mocks.remove } }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getAvailableModes: mocks.modes } }));
vi.mock('@/infrastructure/i18n', () => ({ i18nService: { t: mocks.t }, useI18n: () => ({ t: mocks.t, formatDate: String, formatNumber: String, currentLanguage: 'en-US' }) }));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({ flowChatStore: { getState: () => mocks.state, subscribe: () => () => undefined } }));
vi.mock('@/infrastructure/peer-device/peerDeviceContextState', () => ({ usePeerDeviceModeOptional: () => null }));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: mocks.confirm }));
vi.mock('@/shared/notification-system/services/NotificationService', () => ({ notificationService: { error: mocks.error } }));

const job: CronJob = { id: 'job-a', name: 'Daily checks', enabled: true,
  schedule: { kind: 'every', everyMs: 3600000 }, payload: { text: 'Check the build' },
  target: { kind: 'workspace', workspace: { workspaceId: 'owned', workspacePath: '/owned' }, launch: { agentType: 'Standard' } },
  createdAtMs: 1, configUpdatedAtMs: 1, updatedAtMs: 1, state: { consecutiveFailures: 0, coalescedRunCount: 0, nextRunAtMs: 10000 } };
let host: HTMLDivElement;
let root: Root;
const render = async (initialCreate = false) => act(async () => root.render(<ScheduledJobsView workspaceId="owned" targetKind="workspace"
  listTargetKind="workspace" listPresentation="table" initialCreate={initialCreate} />));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
const changeText = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([job]); mocks.modes.mockResolvedValue([]);
  mocks.create.mockResolvedValue(job); mocks.update.mockResolvedValue(job); mocks.remove.mockResolvedValue(true); mocks.confirm.mockResolvedValue(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); resetDeviceSurfaceForTest(); });

it('uses the counted project scope and retains editing and enabled controls in the table', async () => {
  await render();
  expect(mocks.list).toHaveBeenCalledWith({ workspaceId: 'owned', targetKind: 'workspace', sessionId: undefined });
  expect(host.querySelector('[role="table"]')?.textContent).toContain('Daily checks');
  await act(async () => button('nav.scheduledJobs.actions.edit').click());
  changeText(host.querySelector<HTMLInputElement>('input[placeholder="nav.scheduledJobs.placeholders.name"]')!, 'Updated checks');
  expect(mocks.update).not.toHaveBeenCalled();
  await act(async () => button('nav.scheduledJobs.actions.save').click());
  expect(mocks.update).toHaveBeenCalledWith('job-a', expect.objectContaining({ name: 'Updated checks', target: {
    kind: 'workspace', workspace: { workspaceId: 'owned' }, launch: { agentType: 'Standard' },
  } }));
  await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="nav.scheduledJobs.actions.toggleEnabled"]')!.click());
  expect(mocks.update).toHaveBeenLastCalledWith('job-a', { enabled: false });
});

it('opens a standalone creation dialog without loading the table and saves to the owning project', async () => {
  const close = vi.fn();
  await act(async () => root.render(<ScheduledJobsModal isOpen onClose={close} workspaceId="owned" targetKind="workspace"
    listTargetKind="workspace" listPresentation="table" initialCreate />));
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('[role="table"]')).toBeNull();
  expect(document.querySelector('[data-openbitfun-part="editor"]')).toBeNull();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  await fillNewTask();
  await act(async () => button('nav.scheduledJobs.actions.create').click());
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'New checks', schedule: { kind: 'every', everyMs: 3600000 },
    payload: { text: 'Run the project checks' }, target: { kind: 'workspace', workspace: { workspaceId: 'owned' }, launch: { agentType: 'Standard' } } }));
  expect(close).toHaveBeenCalledOnce();
});

it('opens creation above the task list and cancels without changing its rows', async () => {
  await act(async () => root.render(<ScheduledJobsModal isOpen onClose={vi.fn()} workspaceId="owned" targetKind="workspace" listPresentation="table" />));
  await act(async () => button('nav.scheduledJobs.actions.newJob').click());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  expect(document.querySelector('[role="table"]')?.textContent).toContain('Daily checks');
  expect(document.querySelector('[role="table"] textarea')).toBeNull();
  await fillNewTask();
  await act(async () => button('nav.scheduledJobs.actions.cancel').click());
  expect(mocks.create).not.toHaveBeenCalled();
  expect(document.querySelector('[role="table"]')?.textContent).toContain('Daily checks');
});

it.each(['at', 'every', 'cron'] as const)('associates the %s schedule labels with controls and submits the form', async kind => {
  const close = vi.fn();
  await act(async () => root.render(<ScheduledJobsView workspaceId="owned" targetKind="workspace" creationOnly onCreationClose={close} />));
  const form = document.querySelector<HTMLFormElement>('form')!;
  const fieldControl = (name: string) => [...form.querySelectorAll('label')]
    .find(label => label.textContent === `nav.scheduledJobs.fields.${name}`)!.control!;
  const name = fieldControl('name') as HTMLInputElement;
  expect(document.activeElement).toBe(name);
  expect(fieldControl('prompt')).toBeInstanceOf(HTMLTextAreaElement);
  expect(fieldControl('agentType').getAttribute('role')).toBe('combobox');
  const schedule = document.querySelector<HTMLOptionElement>('select option[value="every"]')!.parentElement as HTMLSelectElement;
  await act(async () => { schedule.value = kind; schedule.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(fieldControl('scheduleKind').getAttribute('role')).toBe('combobox');
  changeText(name, 'Labeled task');
  changeText(fieldControl('prompt') as HTMLTextAreaElement, 'Run checks');
  if (kind === 'at') {
    expect(fieldControl('at')).toBeInstanceOf(HTMLInputElement);
    changeText(fieldControl('at') as HTMLInputElement, '12/31/2030 09:30');
  } else if (kind === 'every') {
    expect(fieldControl('everyMs')).toBeInstanceOf(HTMLInputElement);
    expect(fieldControl('anchorMs')).toBeInstanceOf(HTMLInputElement);
    changeText(fieldControl('everyMs') as HTMLInputElement, '2');
  } else {
    const expression = fieldControl('cronExpr') as HTMLInputElement;
    changeText(expression, '0 8 * * *');
    expect(document.getElementById(expression.getAttribute('aria-describedby')!)?.textContent).toBe('nav.scheduledJobs.hints.cronExpr');
    expect(fieldControl('timezone')).toBeInstanceOf(HTMLInputElement);
  }
  const enabled = fieldControl('enabled') as HTMLInputElement;
  expect(enabled.checked).toBe(true);
  await act(async () => enabled.click());
  expect(enabled.checked).toBe(false);
  await act(async () => form.requestSubmit());
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'Labeled task', enabled: false,
    schedule: expect.objectContaining({ kind }), payload: { text: 'Run checks' },
    target: { kind: 'workspace', workspace: { workspaceId: 'owned' }, launch: { agentType: 'Standard' } } }));
  expect(close).toHaveBeenCalledOnce();
});

it('preserves the creation draft on failure and ignores a save completed on another surface', async () => {
  const close = vi.fn();
  await act(async () => root.render(<ScheduledJobsView workspaceId="owned" targetKind="workspace" creationOnly onCreationClose={close} />));
  await fillNewTask();
  mocks.create.mockRejectedValueOnce(new Error('Host unavailable'));
  await act(async () => button('nav.scheduledJobs.actions.create').click());
  expect(document.querySelector<HTMLInputElement>('input[placeholder="nav.scheduledJobs.placeholders.name"]')!.value).toBe('New checks');
  expect(close).not.toHaveBeenCalled();
  let resolve!: (job: CronJob) => void;
  mocks.create.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => button('nav.scheduledJobs.actions.create').click());
  expect(button('nav.scheduledJobs.actions.cancel').disabled).toBe(true);
  expect([...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>('form input, form textarea, form button, form select')]
    .every(control => control.disabled)).toBe(true);
  await act(async () => activateSurface('peer:other'));
  await act(async () => resolve(job));
  expect(close).not.toHaveBeenCalled();
});

async function fillNewTask() {
  changeText(document.querySelector<HTMLInputElement>('input[placeholder="nav.scheduledJobs.placeholders.name"]')!, 'New checks');
  changeText(document.querySelector<HTMLTextAreaElement>('textarea')!, 'Run the project checks');
  const schedule = document.querySelector<HTMLOptionElement>('select option[value="every"]')!.parentElement as HTMLSelectElement;
  await act(async () => { schedule.value = 'every'; schedule.dispatchEvent(new Event('change', { bubbles: true })); });
}

it('keeps a host load failure visible and allows retry without showing an empty success', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Host unavailable'));
  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('nav.scheduledJobs.messages.loadFailed');
  expect(host.textContent).not.toContain('nav.scheduledJobs.empty.workspaceTitle');
  await act(async () => button('retry').click());
  expect(host.querySelector('[role="table"]')?.textContent).toContain('Daily checks');
});

it('discards delayed delete confirmation after a device switch or closing the list', async () => {
  let confirm!: (value: boolean) => void;
  mocks.confirm.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
  await render();
  await act(async () => button('nav.scheduledJobs.actions.delete').click());
  await act(async () => activateSurface('peer:other'));
  await act(async () => confirm(true));
  expect(mocks.remove).not.toHaveBeenCalled();
  await act(async () => root.render(<ScheduledJobsView key="other" workspaceId="owned" targetKind="workspace" listPresentation="table" />));
  mocks.confirm.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
  await act(async () => button('nav.scheduledJobs.actions.delete').click());
  await act(async () => root.render(null));
  await act(async () => confirm(true));
  expect(mocks.remove).not.toHaveBeenCalled();
});
