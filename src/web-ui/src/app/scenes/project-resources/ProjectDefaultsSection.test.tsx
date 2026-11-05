/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { activateSurface, getActiveSurfaceScope, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { WorkspaceKind, WorkspaceType, type WorkspaceInfo } from '@/shared/types';
import { ProjectDefaultsSection } from './ProjectDefaultsSection';

const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), models: vi.fn(), modes: vi.fn() }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), i18nService: { t: (key: string) => key } }));
vi.mock('@/infrastructure/config/services/ProjectDefaultsService', () => ({ readProjectDefaults: mocks.read, saveProjectDefault: mocks.save }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: mocks.models } }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: { getAvailableModes: mocks.modes } }));
vi.mock('@openbitfun/ui', async original => {
  const ui = await original<typeof import('@openbitfun/ui')>();
  const Picker = ({ value, options, disabled, onValueChange, 'aria-label': label }: any) => <select aria-label={label}
    value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>
    {options.map((option: any) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>;
  return { ...ui, Combobox: Picker, Select: Picker };
});
const workspace: WorkspaceInfo = { id: 'ssh-project', name: 'SSH project', rootPath: '/srv/project',
  workspaceKind: WorkspaceKind.Remote, workspaceType: WorkspaceType.SingleProject, languages: [], tags: [], openedAt: '', lastAccessed: '' };
let container: HTMLDivElement;
let root: Root;
const picker = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="defaults.${label}"]`)!;
const render = async () => { await act(async () => root.render(<ProjectDefaultsSection workspace={workspace} scope={getActiveSurfaceScope()} isActive />)); };
const change = async (label: string, value: string) => { await act(async () => {
  const select = picker(label); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
}); };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDeviceSurfaceForTest(); vi.clearAllMocks();
  mocks.read.mockResolvedValue({ supported: true, defaults: { primary_model: 'project-main', fast_model: 'project-fast', mode: 'Ultimate' } });
  mocks.models.mockResolvedValue([
    { id: 'project-main', model_name: 'Main', enabled: true, capabilities: ['text_chat'] },
    { id: 'project-fast', model_name: 'Fast', enabled: true, capabilities: ['text_chat'] },
    { id: 'disabled', enabled: false }, { id: 'speech', enabled: true, capabilities: ['speech_recognition'] },
  ]);
  mocks.modes.mockResolvedValue([{ id: 'Standard', name: 'Standard' }, { id: 'Ultimate', name: 'Ultimate' }, { id: 'Claw', name: 'Claw' }]);
  mocks.save.mockResolvedValue({ primary_model: 'project-main', fast_model: null, mode: 'Ultimate' });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); resetDeviceSurfaceForTest(); });

it('reads the browsed SSH project, filters models and saves each override independently', async () => {
  await render();
  expect(mocks.read).toHaveBeenCalledWith('ssh-project');
  expect(mocks.modes).toHaveBeenCalledWith({ workspaceId: 'ssh-project' });
  expect(picker('primary_model').value).toBe('project-main');
  expect(picker('fast_model').value).toBe('project-fast');
  expect(picker('mode').value).toBe('Ultimate');
  expect(container.querySelector('[data-openbitfun-component="card"]')).toBeNull();
  expect(container.querySelector('.project-resources__default-fields')?.querySelectorAll('select')).toHaveLength(3);
  expect([...picker('primary_model').options].map(option => option.value)).toEqual(['', 'project-main', 'project-fast']);
  expect([...picker('mode').options].map(option => option.value)).toEqual(['', 'Standard', 'Ultimate']);
  await change('fast_model', '');
  expect(mocks.save).toHaveBeenCalledWith('ssh-project', 'fast_model', '');
  expect(picker('fast_model').value).toBe('');
  expect(picker('primary_model').value).toBe('project-main');
  expect(container.textContent).toContain('defaults.saved');
});

it('keeps saved values and permits retry after a rejected save', async () => {
  mocks.save.mockRejectedValueOnce(new Error('offline'));
  await render(); await change('fast_model', '');
  expect(picker('fast_model').value).toBe('project-fast');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('defaults.saveFailed');
  await change('fast_model', '');
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(picker('fast_model').value).toBe('');
});

it('disables old-host settings without writing global configuration', async () => {
  mocks.read.mockResolvedValue({ supported: false, defaults: {} });
  await render();
  expect([...container.querySelectorAll('select')].every(select => select.disabled)).toBe(true);
  expect(container.textContent).toContain('defaults.unsupported');
  expect(mocks.save).not.toHaveBeenCalled();
});

it('keeps a stale peer completion from painting a successful save', async () => {
  activateSurface('peer:first');
  let finish!: (value: unknown) => void;
  mocks.save.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(); await change('fast_model', '');
  await act(async () => { activateSurface('peer:second'); finish({ fast_model: null }); });
  expect(container.textContent).not.toContain('defaults.saved');
  expect(picker('fast_model').value).toBe('project-fast');
});

it('exposes a retry after loading fails instead of showing global values as project defaults', async () => {
  mocks.read.mockRejectedValueOnce(new Error('offline'));
  await render();
  expect(container.textContent).toContain('defaults.loadFailed');
  expect(picker('mode').disabled).toBe(true);
  await act(async () => { container.querySelector<HTMLButtonElement>('button')!.click(); });
  expect(picker('mode').value).toBe('Ultimate');
});
