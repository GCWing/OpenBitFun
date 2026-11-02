// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@/infrastructure/api';
import TodoItemRow from './TodoItemRow';
import { formatJobTargetLabel } from '../todoPresentation';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/infrastructure/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    formatDate: (date: Date) => date.toISOString(),
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactElement }) => children,
}));

const job: CronJob = {
  id: 'cron_test',
  name: 'Review changes',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload: { text: 'Review the latest changes' },
  enabled: true,
  target: {
    kind: 'workspace',
    workspace: { workspacePath: '/workspace/openbitfun' },
    launch: { agentType: 'Standard' },
  },
  createdAtMs: 0,
  configUpdatedAtMs: 0,
  updatedAtMs: 0,
  state: {
    consecutiveFailures: 0,
    coalescedRunCount: 0,
  },
};

describe('TodoItemRow actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses accessible icon actions and keeps their callbacks isolated from the row', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    act(() => {
      root.render(
        <TodoItemRow
          job={job}
          atMs={null}
          nowMs={0}
          workspaces={[]}
          statusLabel="Paused"
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleEnabled={vi.fn()}
        />,
      );
    });

    const editButton = container.querySelector<HTMLButtonElement>('button[aria-label="actions.edit"]');
    const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="actions.delete"]');

    expect(editButton?.dataset.openbitfunComponent).toBe('icon-button');
    expect(editButton?.dataset.size).toBe('sm');
    expect(deleteButton?.dataset.openbitfunTone).toBe('danger');

    act(() => editButton?.click());
    expect(onEdit).toHaveBeenCalledTimes(1);

    act(() => deleteButton?.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

it('localizes built-in target labels without changing persisted agent IDs', () => {
  const translate = (key: string, params?: Record<string, unknown>) => key === 'shared:agents.Standard' ? '标准' : `${params?.agentType}`;
  expect(formatJobTargetLabel(job, translate)).toBe('标准');
  expect(job.target.kind === 'workspace' && job.target.launch.agentType).toBe('Standard');
});
