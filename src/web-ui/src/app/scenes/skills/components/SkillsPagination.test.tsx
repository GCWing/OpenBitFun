// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInfo } from '@/infrastructure/config/types';
import { SkillsPagination } from './SkillsPagination';
import { skillPageNumbers, useSkillsPagination } from '../hooks/useSkillsPagination';

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({
    formatNumber: String,
    t: (key: string, values: Record<string, string> = {}) => {
      const labels: Record<string, string> = {
        'pagination.label': 'Installed skills pages',
        'pagination.page': 'Page {{page}}',
        'pagination.range': '{{start}}–{{end}} of {{total}} skills',
        'pagination.rangeMore': '{{start}}–{{end}} · {{total}} skills loaded',
        'market.pagination.prev': 'Previous page',
        'market.pagination.next': 'Next page',
        'market.pagination.info': '{{current}} / {{total}}',
      };
      return (labels[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name]);
    },
  }),
}));

const skills = Array.from({ length: 101 }, (_, index) => ({
  key: `skill-${index + 1}`, name: `Skill ${index + 1}`,
  description: '', level: 'user', path: `/skills/${index + 1}`,
} as SkillInfo));

function Harness({ items, scope = 'workspace-a', ready = true, pageSize = 10 }: {
  items: SkillInfo[];
  scope?: string;
  ready?: boolean;
  pageSize?: number;
}) {
  const pagination = useSkillsPagination(items, scope, ready, pageSize);
  return (
    <>
      <div id="skills-installed-list" role="list">
        {pagination.skills.map(skill => <span role="listitem" key={skill.key}>{skill.name}</span>)}
      </div>
      {ready && <SkillsPagination pagination={pagination} listId="skills-installed-list" total={items.length} onPageChange={pagination.goToPage} />}
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
const render = (items: SkillInfo[], scope?: string, ready?: boolean, pageSize?: number) => act(async () => {
  root.render(<Harness items={items} scope={scope} ready={ready} pageSize={pageSize} />);
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const click = (label: string) => act(async () => { button(label)?.click(); });
const visibleNames = () => Array.from(container.querySelectorAll('[role="listitem"]'), item => item.textContent);

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

describe('Installed skills pagination', () => {
  it('shows ten items and makes every item reachable without duplicates', async () => {
    await render(skills.slice(0, 21));
    const seen = visibleNames();
    expect(seen).toHaveLength(10);
    expect(button('Previous page')?.disabled).toBe(true);
    expect(button('Page 1')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('1–10 of 21 skills');
    await click('Next page');
    seen.push(...visibleNames());
    expect(button('Page 2')?.getAttribute('aria-current')).toBe('page');
    await click('Next page');
    seen.push(...visibleNames());
    expect(seen).toEqual(skills.slice(0, 21).map(skill => skill.name));
    expect(button('Next page')?.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('21–21 of 21 skills');
    await click('Previous page');
    expect(visibleNames()[0]).toBe('Skill 11');
  });

  it.each([0, 1, 10])('hides navigation for %i items', async count => {
    await render(skills.slice(0, count));
    expect(container.querySelector('nav')).toBeNull();
    expect(visibleNames()).toHaveLength(count);
  });

  it('resets to the first page of new filtered results, even when the page remains in range', async () => {
    await render(skills);
    await click('Page 3');
    await render(skills.slice(30, 90), 'workspace-a:search-or-filter');
    expect(visibleNames()[0]).toBe('Skill 31');
    expect(button('Page 1')?.getAttribute('aria-current')).toBe('page');
  });

  it('preserves the page during refresh and clamps a deleted last page permanently', async () => {
    await render(skills.slice(0, 21));
    await click('Page 3');
    await render([], 'workspace-a', false);
    expect(visibleNames()).toEqual([]);
    await render(skills.slice(0, 21));
    expect(visibleNames()).toEqual(['Skill 21']);
    await render(skills.slice(0, 20));
    expect(button('Page 2')?.getAttribute('aria-current')).toBe('page');
    await render(skills.slice(0, 21));
    expect(button('Page 2')?.getAttribute('aria-current')).toBe('page');
  });

  it('resets across host or workspace changes before the next catalog arrives', async () => {
    await render(skills);
    await click('Page 4');
    await render([], 'remote-workspace-b', false);
    await render(skills, 'remote-workspace-b');
    expect(visibleNames()[0]).toBe('Skill 1');
    expect(button('Page 1')?.getAttribute('aria-current')).toBe('page');
  });

  it('keeps the current content visible when the window changes page capacity', async () => {
    await render(skills);
    await click('Page 3');
    expect(visibleNames()[0]).toBe('Skill 21');

    await render(skills, 'workspace-a', true, 6);
    expect(visibleNames()).toHaveLength(6);
    expect(visibleNames()).toContain('Skill 21');
    expect(button('Page 4')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('19–24 of 101 skills');

    await render(skills, 'workspace-a', true, 10);
    expect(visibleNames()).toContain('Skill 19');
    expect(button('Page 2')?.getAttribute('aria-current')).toBe('page');
  });

  it('keeps the final item reachable after a resize during catalog refresh', async () => {
    await render(skills);
    await click('Page 11');
    await render([], 'workspace-a', false, 3);
    await render(skills, 'workspace-a', true, 3);
    expect(visibleNames()).toEqual(['Skill 100', 'Skill 101']);
    expect(button('Next page')?.disabled).toBe(true);
  });

  it('keeps the last page directly reachable with non-interactive gaps', async () => {
    await render(skills);
    await click('Page 11');
    expect(visibleNames()).toEqual(['Skill 101']);
    expect(button('Page 1')).not.toBeNull();
    expect(container.querySelector('.skills-pagination__gap')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows loaded market counts, targets the market list, and blocks navigation during a request', async () => {
    const onPageChange = vi.fn();
    const props = {
      pagination: { page: 2, totalPages: 5, start: 7, end: 12 },
      listId: 'skills-market-list', total: 20, hasMore: true, onPageChange,
    };
    await act(async () => root.render(<SkillsPagination {...props} loading />));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('7–12 · 20 skills loaded');
    expect(container.querySelector('nav')?.getAttribute('aria-busy')).toBe('true');
    expect([...container.querySelectorAll('button')].every(control => control.disabled)).toBe(true);
    expect(button('Next page')?.getAttribute('aria-controls')).toBe('skills-market-list');
    await click('Next page');
    expect(onPageChange).not.toHaveBeenCalled();
    await act(async () => root.render(<SkillsPagination {...props} />));
    await click('Next page');
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('bounds the page number window at both ends and in a large catalog', () => {
    expect(skillPageNumbers(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(skillPageNumbers(1, 100)).toEqual([1, 2, 3, 4, 5, 'end-gap', 100]);
    expect(skillPageNumbers(50, 100)).toEqual([1, 'start-gap', 49, 50, 51, 'end-gap', 100]);
    expect(skillPageNumbers(100, 100)).toEqual([1, 'start-gap', 96, 97, 98, 99, 100]);
  });
});
