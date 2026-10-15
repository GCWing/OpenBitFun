/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolGroupPicker, ToolGroupSummary } from './ToolGroupPicker';

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: vi.fn() }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: vi.fn(), success: vi.fn() }) }));

const tools = [
  { name: 'Read', description: 'Read files', is_readonly: true },
  { name: 'Write', description: 'Write files', is_readonly: false },
  { name: 'ExecCommand', description: 'Run commands', is_readonly: false },
];
const userGroups = [{ id: 'my-tools', name: 'My tools', toolNames: ['Read', 'Write'] }];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('flat tool presentation', () => {
  it('shows each selected tool once without category headings', () => {
    act(() => root.render(
      <ToolGroupSummary grouped={false} tools={tools} userGroups={userGroups} selectedToolNames={['Read', 'Write']} />,
    ));
    expect(container.querySelectorAll('h4')).toHaveLength(0);
    expect([...container.querySelectorAll('[data-openbitfun-component="status-pill"]')].map(node => node.textContent))
      .toEqual(['Read', 'Write']);
  });

  it('deduplicates overlapping groups while preserving existing selections on edit', () => {
    const onSelectionChange = vi.fn();
    act(() => root.render(
      <ToolGroupPicker
        grouped={false}
        tools={tools}
        userGroups={userGroups}
        selectedToolNames={['Read', 'unavailable_existing_tool']}
        onSelectionChange={onSelectionChange}
        onSaveUserGroups={vi.fn()}
      />,
    ));
    expect(container.querySelectorAll('h4')).toHaveLength(0);
    expect(container.textContent).not.toContain('agentsOverview.toolGroups.manageGroups');
    const controls = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(controls).toHaveLength(3);
    const write = controls.find(control => control.getAttribute('aria-label')?.startsWith('Write'))!;
    act(() => write.click());
    expect(onSelectionChange).toHaveBeenCalledWith(['Read', 'unavailable_existing_tool', 'Write']);
  });

  it('retains grouped presentation for existing consumers by default', () => {
    act(() => root.render(
      <ToolGroupSummary tools={tools} userGroups={userGroups} selectedToolNames={['Read', 'ExecCommand']} />,
    ));
    expect([...container.querySelectorAll('h4')].map(node => node.textContent))
      .toEqual(['My tools', 'agentsOverview.toolGroups.commands']);
  });
});
