// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FlowGroupRenderer } from './FlowGroupRenderer';
import { useReportTypewriterReveal } from '../../hooks/typewriterRevealGateContext';
import type { FlowGroupData, FlowGroupCategory } from '../../grouping/types';
import type { FlowTextItem, FlowThinkingItem, FlowToolItem } from '../../types/flow-chat';
import { requestDeferredContentItem } from '@openbitfun/flow-chat-presentation/deferred-content';

const state = vi.hoisted(() => ({ choices: new Map<string, boolean>(), permissions: new Set<string>(), revealing: false }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
vi.mock('./FlowChatContext', () => ({
  useFlowChatContext: () => ({ sessionId: 'session', onExpandGroup: (id: string) => state.choices.set(id, true) }),
  useFlowChatVolatileContext: () => ({ groupStates: state.choices, pendingPermissionToolCallIds: state.permissions }),
}));
vi.mock('../FlowToolCard', () => ({ FlowToolCard: ({ toolItem }: { toolItem: FlowToolItem }) => {
  const [expanded, setExpanded] = React.useState(false);
  return <div data-call={toolItem.id}><button onClick={() => setExpanded(!expanded)}>{toolItem.status}</button>
    {expanded && <span data-detail={toolItem.id}>Output</span>}</div>;
} }));
vi.mock('../../tool-cards/ModelThinkingDisplay', () => ({
  ModelThinkingDisplay: ({ thinkingItem, withinGroup, hidden, forceExpanded }: {
    thinkingItem: FlowThinkingItem; withinGroup: boolean; hidden?: boolean; forceExpanded?: boolean;
  }) => {
    useReportTypewriterReveal(thinkingItem.id, state.revealing);
    return <div hidden={hidden} data-parent-scroll={withinGroup} data-forced={forceExpanded}>{thinkingItem.content}</div>;
  },
}));
vi.mock('../FlowTextBlock', () => ({ FlowTextBlock: ({ textItem }: { textItem: FlowTextItem }) => {
  useReportTypewriterReveal(textItem.id, state.revealing);
  return <div>{textItem.content}</div>;
} }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  state.choices.clear();
  state.permissions.clear();
  state.revealing = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function group(phase: FlowGroupData['phase'], category: FlowGroupCategory = 'explore', running = false): FlowGroupData {
  return { category, groupId: 'group', rounds: [], phase, needsAttention: false,
    isGroupStreaming: running, isLastGroupInTurn: true, wasCutByCritical: false,
    stats: { readCount: 1, searchCount: 0, commandCount: 0 },
    allItems: [{ id: 'call', type: 'tool', toolName: 'Read', timestamp: 1, status: running ? 'running' : 'completed',
      toolCall: { id: 'call', input: {} } } as FlowToolItem] };
}

it.each(['explore', 'context', 'interface'] as const)('%s stays open through each completion and closes once at the group boundary', category => {
  const render = (data: FlowGroupData) => act(() => root.render(<FlowGroupRenderer turnId="turn" data={data} />));
  render(group('collecting', category, true));
  const node = container.querySelector('[data-flow-group]')!;
  const call = container.querySelector('[data-call="call"]');
  expect(node.getAttribute('data-expanded')).toBe('true');
  expect(node.classList.contains('explore-region--bounded')).toBe(false);
  expect(container.querySelector('[data-openbitfun-edge-fade]')).toBeNull();
  render(group('collecting', category));
  expect(container.querySelector('[data-call="call"]')).toBe(call);
  expect(node.getAttribute('data-expanded')).toBe('true');
  render(group('settling', category, true));
  expect(node.getAttribute('data-expanded')).toBe('true');
  render(group('settled', category));
  expect(container.querySelector('[data-flow-group]')).toBe(node);
  expect(node.getAttribute('data-expanded')).toBe('false');
  // Closing retains the same natural-height body until disclosure finishes.
  expect(container.querySelector('[data-call="call"]')).toBe(call);
  expect(node.classList.contains('explore-region--bounded')).toBe(false);
  act(() => vi.advanceTimersByTime(400));
  expect(container.querySelector('[data-call]')).toBeNull();
});

it.each(['thinking', 'text'] as const)('waits for collected %s to finish revealing before closing abnormal results', type => {
  const render = (phase: FlowGroupData['phase']) => {
    const data = group(phase);
    data.needsAttention = true;
    data.allItems.push({ id: 'thought', type, content: 'Finishing', timestamp: 1,
      status: 'completed', isStreaming: false, isCollapsed: false } as FlowThinkingItem | FlowTextItem);
    act(() => root.render(<FlowGroupRenderer turnId="turn" data={data} />));
  };
  state.revealing = true;
  render('collecting');
  render('settled');
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('true');
  if (type === 'thinking') expect(container.querySelector('[data-parent-scroll]')?.getAttribute('data-parent-scroll')).toBe('true');
  state.revealing = false;
  render('settled');
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('false');
});

it('honors explicit disclosure while settled abnormal results default to collapsed', () => {
  for (const [phase, choice, expected] of [['collecting', false, 'false'], ['settled', true, 'true']] as const) {
    state.choices.set('group', choice);
    act(() => root.render(<FlowGroupRenderer turnId="turn" data={group(phase)} />));
    expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe(expected);
  }
  state.choices.clear();
  act(() => root.render(<FlowGroupRenderer turnId="turn" data={{ ...group('settled'), needsAttention: true }} />));
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('false');
  state.choices.set('group', true);
  act(() => root.render(<FlowGroupRenderer turnId="turn" data={{ ...group('settled'), needsAttention: true }} />));
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('true');
  state.choices.set('group', false);
  act(() => root.render(<FlowGroupRenderer turnId="turn" data={{ ...group('settled'), needsAttention: true }} />));
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('false');
});

it.each(['explore', 'context', 'interface'] as const)('%s bounds opening work for 1000 tools and reveals a distant source directly', category => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const data = group('settled', category);
  data.allItems = Array.from({ length: 1000 }, (_, index) => ({ ...data.allItems[0], id: `call-${index}` }));
  const render = () => act(() => root.render(<FlowGroupRenderer turnId="turn" data={{ ...data }} />));
  render();
  expect(container.querySelectorAll('[data-call]')).toHaveLength(0);
  state.choices.set('group', true);
  render();
  expect(container.querySelectorAll('[data-call]')).toHaveLength(32);
  const first = container.querySelector('[data-call="call-0"]');
  act(() => { expect(requestDeferredContentItem(container, 'call-990')).toBe(true); });
  expect(container.querySelector('[data-call="call-990"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-call]').length).toBeLessThanOrEqual(48);
  expect(container.querySelector('[data-call="call-0"]')).toBe(first);
});

it('mounts the live tail and preserves it through completion without mounting the full group', () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const data = group('collecting');
  data.allItems = Array.from({ length: 1000 }, (_, index) => ({ ...data.allItems[0], id: `call-${index}` }));
  data.allItems[400] = { ...data.allItems[400], status: 'running' };
  const render = (next: FlowGroupData) => act(() => root.render(<FlowGroupRenderer turnId="turn" data={next} />));
  render(data);
  const active = container.querySelector('[data-call="call-400"]');
  const tail = container.querySelector('[data-call="call-999"]');
  expect(active).not.toBeNull();
  expect(tail).not.toBeNull();
  expect(container.querySelector('[data-call="call-0"]')).toBeNull();
  expect(container.querySelectorAll('[data-call]').length).toBeLessThanOrEqual(48);
  render({ ...data, allItems: data.allItems.map(item => ({ ...item, status: 'completed' })) });
  expect(container.querySelector('[data-call="call-400"]')).toBe(active);
  expect(container.querySelector('[data-call="call-999"]')).toBe(tail);
});

function selectFilter(label: string, value: string) {
  const category = label === 'groupBrowser.toolsLabel' ? 'tools' : 'status';
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="groupBrowser.filters"]')!.click());
  act(() => document.querySelector<HTMLButtonElement>(`[data-menu-id="${category}"]`)!.click());
  act(() => document.querySelector<HTMLButtonElement>(`[data-menu-id="${category}:${value}"]`)!.click());
}
function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function visibleCalls() {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-call]'))
    .filter(element => !element.closest('[hidden]')).map(element => element.dataset.call);
}

it.each(['focus', 'wheel', 'search', 'filter'] as const)('%s interaction does not prevent a live group from closing when finished', interaction => {
  const render = (data: FlowGroupData) => act(() => root.render(<FlowGroupRenderer turnId="turn" data={data} />));
  render(group('collecting', 'explore', true));
  if (interaction === 'focus') act(() => container.querySelector<HTMLButtonElement>('[data-call] button')!.focus());
  else if (interaction === 'wheel') act(() => container.querySelector('[data-openbitfun-part="content"]')!
    .dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true })));
  else if (interaction === 'search') search('Read');
  else selectFilter('groupBrowser.toolsLabel', 'Read');
  render(group('collecting'));
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('true');
  render(group('settled'));
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('false');
});

it('only shows browsing controls when expanded and retains card state across combined filters', () => {
  const data = group('settled');
  data.allItems.push({ ...data.allItems[0], id: 'grep', toolName: 'Grep', status: 'running',
    toolCall: { id: 'grep', input: { path: 'src/target.ts' } } } as FlowToolItem);
  const render = () => act(() => root.render(<FlowGroupRenderer turnId="turn" data={{ ...data }} />));
  render();
  expect(container.querySelector('input[type="search"]')).toBeNull();
  expect(container.querySelector('.explore-region__summary')!.textContent).not.toContain('groupBrowser.tools');
  state.choices.set('group', true);
  render();
  expect(container.querySelector('input[type="search"]')).not.toBeNull();
  expect(document.activeElement).not.toBe(container.querySelector('input[type="search"]'));
  const call = container.querySelector('[data-call="call"]')!;
  act(() => call.querySelector('button')!.click());
  const detail = container.querySelector('[data-detail="call"]');
  selectFilter('groupBrowser.toolsLabel', 'Grep');
  selectFilter('groupBrowser.statusLabel', 'active');
  search('target.ts');
  expect(visibleCalls()).toEqual(['grep']);
  search('not-found');
  expect(visibleCalls()).toEqual([]);
  expect(container.querySelector('.explore-region__empty')?.textContent).toBe('groupBrowser.empty');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="groupBrowser.filters"]')!.click());
  act(() => document.querySelector<HTMLButtonElement>('[data-menu-id="reset"]')!.click());
  expect(visibleCalls()).toEqual(['call', 'grep']);
  expect(container.querySelector('[data-detail="call"]')).toBe(detail);
  expect(container.querySelector('[data-call="call"]')).toBe(call);
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('');
});

it('searches deferred source data while keeping mounts bounded and clears filters for global navigation', () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  state.choices.set('group', true);
  const data = group('settled');
  data.allItems = Array.from({ length: 1000 }, (_, index) => ({ ...data.allItems[0], id: `call-${index}`,
    toolCall: { id: `call-${index}`, input: { path: index === 990 ? '/target.ts' : '/ordinary.ts' } } } as FlowToolItem));
  act(() => root.render(<FlowGroupRenderer turnId="turn" data={data} />));
  const first = container.querySelector('[data-call="call-0"]');
  search('target.ts');
  expect(visibleCalls()).toEqual(['call-990']);
  expect(container.querySelectorAll('[data-call]').length).toBeLessThanOrEqual(48);
  expect(container.querySelector('[data-call="call-0"]')).toBe(first);
  act(() => { expect(requestDeferredContentItem(container, 'call-800')).toBe(true); });
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('');
  expect(visibleCalls()).toContain('call-800');
  expect(container.querySelectorAll('[data-call]').length).toBeLessThanOrEqual(64);
});

it('only explicitly matched thoughts are expanded and pending permissions remain available', () => {
  const data = group('collecting');
  data.allItems.push({ id: 'thought', type: 'thinking', content: 'reasoning needle', timestamp: 1,
    status: 'completed', isStreaming: false, isCollapsed: false } as FlowThinkingItem);
  state.permissions.add('call');
  const render = (next: FlowGroupData) => act(() => root.render(<FlowGroupRenderer turnId="turn" data={next} />));
  render(data);
  expect(container.querySelector('[data-parent-scroll]')?.getAttribute('data-forced')).toBe('false');
  search('reasoning needle');
  expect(container.querySelector('[data-parent-scroll]')?.getAttribute('data-forced')).toBe('true');
  expect(visibleCalls()).toEqual(['call']);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('groupBrowser.pinned');
  search('not-found');
  expect(container.querySelector('[data-parent-scroll]')?.hasAttribute('hidden')).toBe(true);
  expect(visibleCalls()).toEqual(['call']);
  render({ ...data, phase: 'settled' });
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('true');
  state.permissions.clear();
  render({ ...data, phase: 'settled' });
  expect(container.querySelector('[data-flow-group]')?.getAttribute('data-expanded')).toBe('false');
});
