import { act, useState, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextLoadGroup, ExploreGroup, FlowGroup, type FlowGroupProps } from '@openbitfun/ui/flow-chat';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['flow-group', FlowGroup], ['explore-group', ExploreGroup], ['context-load-group', ContextLoadGroup],
] as const)('%s shares collection anatomy and retains controlled disclosure', (component, Component) => {
  const View = Component as ComponentType<FlowGroupProps>;
  act(() => root.render(<View expanded={false} summary="Collected 2" itemCount={2}><span>Native details</span></View>));
  const node = container.querySelector(`[data-openbitfun-component="${component}"][data-flow-group]`)!;
  expect(node.getAttribute('data-item-count')).toBe('2');
  expect(container.textContent).not.toContain('Native details');
  act(() => root.render(<View expanded summary="Collected 2" itemCount={2}><span>Native details</span></View>));
  expect(container.querySelector('[data-flow-group]')).toBe(node);
  expect(container.textContent).toContain('Native details');
  for (const part of ['root', 'header', 'summary', 'contentWrapper', 'content']) {
    expect(container.querySelector(`[data-openbitfun-part="${part}"]`)?.getAttribute('data-openbitfun-component')).toBe(component);
  }
  expect(node.classList.contains('explore-region--bounded')).toBe(false);
  expect(container.querySelector('[data-openbitfun-part="content"]')?.hasAttribute('data-openbitfun-edge-fade')).toBe(false);
  act(() => root.render(<View expanded={false} summary="Collected 2" itemCount={2}><span>Native details</span></View>));
  expect(container.querySelector('[data-openbitfun-part="contentWrapper"]')?.hasAttribute('inert')).toBe(true);
  act(() => vi.advanceTimersByTime(400));
  expect(container.textContent).not.toContain('Native details');
});

it('supports keyboard disclosure while leaving state with the host', () => {
  const change = vi.fn();
  act(() => root.render(<FlowGroup expanded={false} summary="Operations" summaryDescription="Two completed operations" onExpandedChange={change} />));
  const header = container.querySelector<HTMLElement>('[data-openbitfun-part="header"]')!;
  expect(header.getAttribute('aria-label')).toBe('Two completed operations');
  expect(document.getElementById(header.getAttribute('aria-controls')!)).not.toBeNull();
  for (const key of ['Enter', ' ']) act(() => header.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  expect(change.mock.calls).toEqual([[true], [true]]);
  expect(header.getAttribute('aria-expanded')).toBe('false');
});

it('shares one file identity and keeps open-file independent from revision disclosure', () => {
  const toggle = vi.fn();
  const open = vi.fn();
  const render = (expanded: boolean, count = 3) => act(() => root.render(<FlowGroup
    expanded={expanded} itemCount={count} summary="3 edits" summaryDescription="/remote/src/App.tsx, 3 edits"
    onExpandedChange={toggle} fileRevision={{ path: '/remote/src/App.tsx', label: 'App.tsx', countLabel: '3 edits: ',
      expandedLabel: 'File edits: ',
      changeSummary: { additions: 18, deletions: 6, label: '18 lines added, 6 lines removed' },
      openFile: { label: 'Open file', onPress: open } }}><button>Revision details</button></FlowGroup>));
  render(false);
  const header = container.querySelector('[data-openbitfun-part="header"]');
  const disclosure = container.querySelector<HTMLButtonElement>('[aria-expanded]')!;
  expect(disclosure.tagName).toBe('BUTTON');
  expect(disclosure.getAttribute('aria-label')).toContain('/remote/src/App.tsx');
  expect(container.querySelectorAll('[data-layer]')).toHaveLength(2);
  expect(container.querySelector('[data-openbitfun-part="summary"]')?.textContent).toBe('3 edits: App.tsx');
  expect(header?.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+18');
  expect(header?.querySelector('[data-openbitfun-change="removed"]')?.textContent).toBe('-6');
  const openButton = container.querySelector<HTMLButtonElement>('[aria-label="Open file"]')!;
  act(() => openButton.click());
  expect(open).toHaveBeenCalledOnce();
  expect(toggle).not.toHaveBeenCalled();
  act(() => disclosure.click());
  expect(toggle).toHaveBeenCalledWith(true);
  render(true);
  expect(container.querySelector('[data-openbitfun-part="header"]')).toBe(header);
  expect(header?.querySelector('[data-openbitfun-part="summary"]')?.textContent).toBe('File edits: App.tsx');
  expect(header?.querySelector('[data-openbitfun-part="changeSummary"]')).toBeNull();
  expect(header?.querySelector('[aria-label="Open file"]')).toBe(openButton);
  expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('Revision details');
  expect(container.querySelector('[data-file-revisions]')).not.toBeNull();
  expect(container.querySelector('.explore-region--bounded')).toBeNull();
  render(false, 2);
  expect(header?.querySelector('[data-openbitfun-part="summary"]')?.textContent).toBe('3 edits: App.tsx');
  expect(header?.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+18');
  expect(container.querySelectorAll('[data-layer]')).toHaveLength(1);
  expect(container.querySelector('[data-openbitfun-part="contentWrapper"]')?.hasAttribute('inert')).toBe(true);
});

function BrowserHarness({ expanded = true, toggle, initialQuery = '' }: {
  expanded?: boolean; toggle?: (expanded: boolean) => void; initialQuery?: string;
}) {
  const [tool, setTool] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState(initialQuery);
  return <FlowGroup expanded={expanded} summary="Explore" onExpandedChange={toggle} browser={{
    query, onQueryChange: setQuery, searchLabel: 'Search group', clearSearchLabel: 'Clear search',
    filterLabel: 'Filter tools and status',
    tools: { label: 'Tools', value: tool, onValueChange: setTool,
      options: [{ value: 'all', label: 'All tools', count: '2' }, { value: 'Read', label: 'Read', count: '2' }] },
    status: { label: 'Status', value: status, onValueChange: setStatus,
      options: [{ value: 'all', label: 'All statuses' }, { value: 'active', label: 'Active', count: '1' }] },
    filtering: Boolean(query) || tool !== 'all' || status !== 'all', empty: false, emptyLabel: 'No matches', resultLabel: '2 matches',
    resetLabel: 'Reset filters', onReset: () => { setQuery(''); setTool('all'); setStatus('all'); },
  }}><button>Native card</button></FlowGroup>;
}

function clickButton(label: string) {
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
}

function pickFilter(category: string, value: string) {
  clickButton('Filter tools and status');
  act(() => document.querySelector<HTMLButtonElement>(`[data-menu-id="${category}"]`)!.click());
  act(() => document.querySelector<HTMLButtonElement>(`[data-menu-id="${category}:${value}"]`)!.click());
}

it('keeps independent menu filtering and standard search alongside the disclosure', () => {
  const toggle = vi.fn();
  act(() => root.render(<BrowserHarness toggle={toggle} />));
  const controls = container.querySelector('[data-openbitfun-part="controls"]')!;
  const header = container.querySelector('[data-openbitfun-part="header"]')!;
  const body = container.querySelector('[data-openbitfun-part="contentWrapper"]')!;
  expect(header.parentElement).toBe(controls.parentElement);
  expect(header.contains(controls)).toBe(false);
  expect(body.contains(controls)).toBe(false);
  expect(controls.querySelector('input')).not.toBeNull();
  expect(document.activeElement).not.toBe(controls.querySelector('input'));
  expect(controls.querySelector('[role="radiogroup"]')).toBeNull();
  pickFilter('tools', 'Read');
  const input = controls.querySelector<HTMLInputElement>('input')!;
  act(() => input.focus());
  expect(document.activeElement).toBe(input);
  expect(controls.querySelector('[role="radiogroup"]')).toBeNull();
  expect(controls.querySelector('[data-openbitfun-component="search-field"]')?.getAttribute('data-variant')).toBe('default');
  expect(controls.querySelector('button[aria-label="Search group"]')).toBeNull();
  expect(controls.querySelector('button[aria-label="Close search"]')).toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Composition owns Escape until the input method has finished.
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  expect(input.value).toBe('needle');
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(input.value).toBe('');
  clickButton('Filter tools and status');
  act(() => document.querySelector<HTMLButtonElement>('[data-menu-id="reset"]')!.click());
  expect(document.activeElement).toBe(input);
  expect(controls.querySelector('.explore-region__filter-status')).toBeNull();
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(input);
  expect(controls.querySelector('input')).toBe(input);
  expect(controls.querySelector('button[aria-label="Clear search"]')).toBeNull();
  expect(controls.querySelector('button[aria-label="Filter tools and status"]')?.getAttribute('aria-pressed')).toBe('false');
  expect(toggle).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Native card');
});

it('offers tool and status filters in the shared menu and releases it on collapse', () => {
  const toggle = vi.fn();
  act(() => root.render(<BrowserHarness toggle={toggle} />));
  const filter = container.querySelector<HTMLButtonElement>('button[aria-label="Filter tools and status"]')!;
  expect(filter.closest('[data-openbitfun-component="search-field"]')).toBe(
    container.querySelector('[data-openbitfun-component="search-field"]'),
  );
  for (const [category, value] of [['status', 'active'], ['tools', 'Read']]) {
    clickButton('Filter tools and status');
    const categoryButton = document.querySelector<HTMLButtonElement>(`[data-menu-id="${category}"]`)!;
    act(() => {
      categoryButton.focus();
      categoryButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const option = document.querySelector<HTMLButtonElement>(`[data-menu-id="${category}:${value}"]`)!;
    expect(option.getAttribute('role')).toBe('menuitemradio');
    act(() => option.click());
    expect(option.getAttribute('aria-checked')).toBe('true');
    expect(filter.getAttribute('aria-expanded')).toBe('false');
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(filter);
  }
  expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  clickButton('Filter tools and status');
  act(() => document.querySelector<HTMLButtonElement>('[data-menu-id="reset"]')!.click());
  expect(filter.getAttribute('aria-pressed')).toBe('false');
  expect(document.activeElement).toBe(container.querySelector('input'));
  expect(toggle).not.toHaveBeenCalled();
  clickButton('Filter tools and status');
  act(() => root.render(<BrowserHarness expanded={false} toggle={toggle} />));
  expect(container.querySelector('[data-openbitfun-part="controls"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('restores a retained query without taking focus from the transcript', () => {
  act(() => root.render(<BrowserHarness initialQuery="retained" />));
  const input = container.querySelector<HTMLInputElement>('input')!;
  expect(input.value).toBe('retained');
  expect(document.activeElement).not.toBe(input);
  clickButton('Clear search');
  expect(input.value).toBe('');
  expect(container.querySelector('input')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(container.querySelector('button[aria-label="Clear search"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Close search"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('consumes explicit feedback without replaying on mount, count changes, or remount', () => {
  const animate = vi.fn(() => ({ cancel() {}, finished: new Promise<void>(() => {}) }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 10, top: 10, left: 0, bottom: 42, right: 200, width: 200, height: 32, toJSON() {} });
  vi.stubGlobal('Animation', class {});
  const originalAnimate = Element.prototype.animate;
  Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
  const receipt = () => { let claimed = false; return { claim: () => { if (claimed) return false; claimed = true; return true; } }; };
  const initial = receipt();
  const next = receipt();
  try {
    act(() => root.render(<FlowGroup expanded={false} summary="Operations" itemCount={1} receiveFeedback={initial} />));
    act(() => root.render(<FlowGroup expanded={false} summary="Operations" itemCount={2} receiveFeedback={initial} />));
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(<FlowGroup expanded={false} summary="Operations" itemCount={3} receiveFeedback={next} />));
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => root.render(<FlowGroup key="remounted" expanded={false} summary="Operations" receiveFeedback={next} />));
    expect(animate).toHaveBeenCalledTimes(1);
  } finally { Element.prototype.animate = originalAnimate; }
});
