/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CronJob } from '@/infrastructure/api/service-api/CronAPI';
import type { SkillInfo } from '@/infrastructure/config/types';
import type { OverviewAgent } from '../personal-overview/overviewData';
import { ProjectResourceMetrics } from './ProjectResourceMetrics';

vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
type Data = React.ComponentProps<typeof ProjectResourceMetrics>['data'];
let root: Root;
let container: HTMLDivElement;
let data: Data;
const navigate = vi.fn();
const render = async () => act(async () => root.render(<ProjectResourceMetrics data={data} onNavigate={navigate} />));
const value = (id: string) => container.querySelector(`[data-metric="${id}"] .project-resources__metric-value`)?.textContent;
const job: CronJob = { id: 'job', name: 'Check', enabled: true, schedule: { kind: 'every', everyMs: 3600000 },
  payload: { text: 'Check project' }, target: { kind: 'workspace', workspace: { workspaceId: 'owned' }, launch: { agentType: 'Standard' } },
  createdAtMs: 1, updatedAtMs: 1, configUpdatedAtMs: 1, state: { consecutiveFailures: 0, coalescedRunCount: 0 } };
const agent: OverviewAgent = { id: 'agent', key: 'agent', name: 'Agent', description: '', kind: 'agent', source: 'project', toolCount: 0 };
const skill: SkillInfo = { key: 'skill', name: 'Skill', description: '', path: '/owned/skill', level: 'project', sourceSlot: 'openbitfun', dirName: 'skill', isBuiltin: false };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  data = { git: { status: 'ready', data: null }, sessionCount: { status: 'ready', data: { count: 0, partial: false } },
    jobs: { status: 'ready', data: [] }, agents: { status: 'ready', data: [] },
    skills: { status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: true } }, refresh: vi.fn() };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('keeps unavailable Git distinct from a clean repository', async () => {
  await render();
  expect(value('changes')).toBe('—');
  expect(container.textContent).toContain('metrics.noRepository');
  data = { ...data, git: { status: 'failed', error: 'Host offline' } };
  await render();
  expect(value('changes')).toBe('—');
  expect(container.textContent).toContain('Host offline');
  expect(container.textContent).not.toContain('metrics.noRepository');
});

it('keeps zero conversations, incomplete discovery and an unavailable count distinct', async () => {
  await render();
  expect(value('sessions')).toBe('0');
  data = { ...data, sessionCount: { status: 'ready', data: { count: 87, partial: true } } };
  await render();
  expect(value('sessions')).toBe('87');
  expect(container.querySelector('[data-metric="sessions"]')?.textContent).toContain('metrics.sessionsIncomplete');
  data = { ...data, sessionCount: { status: 'failed', error: 'Session host offline' } };
  await render();
  expect(value('sessions')).toBe('—');
  expect(container.textContent).toContain('Session host offline');
});

it('counts project resources consistently with their lists and excludes personal and built-in capabilities', async () => {
  data = { ...data, jobs: { status: 'ready', data: [job, { ...job, id: 'paused', enabled: false }] },
    agents: { status: 'ready', data: [{ ...agent, path: '/owned/agent' }, { ...agent, source: 'user', path: undefined }, { ...agent, source: 'builtin', path: undefined }] },
    skills: { status: 'ready', data: { skills: [skill, { ...skill, level: 'user' }, { ...skill, isBuiltin: true }], diagnostics: [], diagnosticsAvailable: true } } };
  await render();
  expect(container.querySelectorAll('[data-metric]')).toHaveLength(5);
  expect(container.querySelector('[data-metric="environment"]')).toBeNull();
  expect(value('jobs')).toBe('2');
  expect(value('agents')).toBe('1');
  expect(value('skills')).toBe('1');
});

it('keeps loading, failed and incomplete resource counts distinct from zero', async () => {
  data = { ...data, jobs: { status: 'loading' }, agents: { status: 'failed', error: 'Agent host offline' },
    skills: { status: 'ready', data: { skills: [], diagnostics: [], diagnosticsAvailable: false } } };
  await render();
  expect(value('jobs')).toBe('—');
  expect(value('agents')).toBe('—');
  expect(value('skills')).toBe('0');
  expect(container.querySelector('[data-metric="skills"]')?.textContent).toContain('metrics.resourcesIncomplete');
  expect(container.textContent).toContain('Agent host offline');
  expect(container.querySelector('dl')?.getAttribute('aria-busy')).toBe('true');
});

it('routes each new metric to its corresponding section, including empty resources', async () => {
  await render();
  for (const target of ['jobs', 'agents', 'skills']) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-metric="${target}"] button`)!.click());
    expect(navigate).toHaveBeenLastCalledWith(target);
  }
});
