// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../types/flow-chat';
import type { TrajectoryNode } from './trajectoryModel';
const mocks = vi.hoisted(() => ({ nodes: [] as TrajectoryNode[], select: vi.fn(), clearSelection: vi.fn(), range: vi.fn(), close: vi.fn(), query: vi.fn(), searchState: vi.fn() }));
vi.mock('./useTrajectory', () => ({ useTrajectory: () => ({ nodes: mocks.nodes, complete: true, supported: true, loading: false, error: false, retry: vi.fn() }) }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: (value: number) => String(value) }) }));
vi.mock('@openbitfun/ui', async () => {
  const { forwardRef } = await import('react');
  return {
    Button: ({ children, variant: _v, size: _s, ...props }: any) => <button {...props}>{children}</button>,
    IconButton: ({ icon, size: _s, ...props }: any) => <button {...props}>{icon}</button>, Icon: () => null,
    SearchField: forwardRef<HTMLInputElement, any>((props, ref) => <input ref={ref} {...props} />),
    Stack: ({ children }: any) => <div>{children}</div>, StatusPill: ({ children }: any) => <span>{children}</span>,
    Tooltip: ({ children }: any) => children,
  };
});
import { TrajectoryExplorer, type TrajectoryExplorerRef } from './TrajectoryExplorer';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
let explorer: ReturnType<typeof createRef<TrajectoryExplorerRef>>;
beforeEach(() => {
  explorer = createRef<TrajectoryExplorerRef>();
  mocks.nodes = Array.from({ length: 10000 }, (_, i) => ({ id: `${i}`, turnId: `${Math.floor(i / 3)}`, turnOrdinal: Math.floor(i / 3),
    kind: (['user', 'model', 'tool'] as const)[i % 3], label: '', preview: '', status: 'completed', timestamp: i, matched: i % 2 === 0 }));
  mocks.select.mockReset().mockResolvedValue(true); mocks.range.mockReset(); mocks.clearSelection.mockReset();
  mocks.close.mockReset(); mocks.query.mockReset(); mocks.searchState.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.setPointerCapture = () => {}; HTMLElement.prototype.hasPointerCapture = () => true; HTMLElement.prototype.releasePointerCapture = () => {};
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(searchInput = '') { await act(async () => root.render(<TrajectoryExplorer ref={explorer} session={{ sessionId: 's' } as Session} searchInput={searchInput}
  onSelect={mocks.select} onClose={mocks.close} onRangeChange={mocks.range} onQueryChange={mocks.query} onSearchStateChange={mocks.searchState} onClearSelection={mocks.clearSelection} />));
  const rail = container.querySelector('[role="listbox"]') as HTMLElement;
  Object.defineProperty(rail, 'clientHeight', { configurable: true, value: 60 });
  rail.getBoundingClientRect = () => ({ left: 0, right: 400, width: 400, top: 0, bottom: 72, height: 72, x: 0, y: 0, toJSON: () => ({}) });
}
function pointer(target: Element, type: string, x: number, pointerType = 'mouse', y = 30) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event);
}
describe('trajectory rail', () => {
  it('tracks the pointer across lanes and horizontal scrolling without selecting or opening details', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]') as HTMLElement;
    const line = container.querySelector('.trajectory__reference-line') as HTMLElement;
    expect(line.hidden).toBe(true);
    await act(async () => pointer(rail, 'pointermove', 35));
    expect(line.hidden).toBe(false);
    expect(line.style.transform).toBe('translateX(35px)');
    // The mouse is in the model lane; the reference line hits the tool below it.
    expect(container.querySelector('[data-reference-hit="true"]')?.getAttribute('data-kind')).toBe('tool');
    expect(container.querySelector('[data-reference-hit="true"]')?.getAttribute('aria-posinset')).toBe('3');
    await act(async () => { rail.scrollLeft = 1400; rail.dispatchEvent(new Event('scroll')); });
    expect(line.style.transform).toBe('translateX(1435px)');
    expect(container.querySelector('[data-reference-hit="true"]')?.getAttribute('aria-posinset')).toBe('120');
    await act(async () => pointer(rail, 'pointermove', 50, 'mouse', 50));
    expect(line.style.transform).toBe('translateX(1450px)');
    expect(container.querySelectorAll('[data-reference-hit="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-reference-hit="true"]')?.getAttribute('aria-posinset')).toBe('121');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.range).not.toHaveBeenCalled();
    await act(async () => pointer(rail, 'pointerout', 420));
    expect(line.hidden).toBe(true);
    expect(container.querySelector('[data-reference-hit="true"]')).toBeNull();
  });
  it('hides the reference line for touch, cancellation and the scrollbar', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    const line = container.querySelector('.trajectory__reference-line') as HTMLElement;
    await act(async () => pointer(rail, 'pointermove', 35));
    await act(async () => pointer(rail, 'pointermove', 35, 'touch'));
    expect(line.hidden).toBe(true);
    await act(async () => pointer(rail, 'pointermove', 35));
    await act(async () => pointer(rail, 'pointercancel', 35));
    expect(line.hidden).toBe(true);
    await act(async () => pointer(rail, 'pointermove', 35, 'mouse', 65));
    expect(line.hidden).toBe(true);
  });
  it('bounds mounted nodes for a long session while retaining the complete horizontal extent', async () => {
    await mount(); expect(container.querySelectorAll('[role="option"]').length).toBeLessThan(100);
    expect((container.querySelector('.trajectory__track') as HTMLElement).style.width).toBe('120000px');
  });
  it('drag-selects a range, exposes keyboard handles and reports the inclusive event counts', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 2); pointer(rail, 'pointermove', 35); pointer(rail, 'pointerup', 35); });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.range).toHaveBeenCalledWith(expect.objectContaining({ counts: { user: 1, model: 1, tool: 1, errors: 0 } }), true);
    const end = container.querySelector('[aria-label="trajectory.rangeEnd"]')!;
    await act(async () => end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(end.getAttribute('aria-valuenow')).toBe('4');
  });
  it('dismisses a range on an outside click after the clicked control receives its action', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 2); pointer(rail, 'pointermove', 35); pointer(rail, 'pointerup', 35); });
    const outside = document.createElement('button'); document.body.append(outside);
    const action = vi.fn(() => expect(container.querySelector('.trajectory__range')).not.toBeNull());
    outside.addEventListener('click', action);
    try {
      mocks.range.mockClear();
      await act(async () => outside.click());
      expect(action).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.trajectory__range')).toBeNull();
      expect(mocks.range).toHaveBeenCalledExactlyOnceWith(null, false);
      expect(mocks.select).not.toHaveBeenCalled();
    } finally { outside.remove(); }
  });
  it('replaces a range with a single-node selection while preserving range handle interactions', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 2); pointer(rail, 'pointermove', 35); pointer(rail, 'pointerup', 35); });
    const handle = container.querySelector('[data-range-edge="end"]')!;
    await act(async () => { pointer(handle, 'pointerdown', 35); pointer(handle, 'pointerup', 35); });
    expect(container.querySelector('.trajectory__range')).not.toBeNull();
    expect(mocks.select).not.toHaveBeenCalled();
    await act(async () => { pointer(rail, 'pointerdown', 50); pointer(rail, 'pointerup', 50); });
    expect(container.querySelector('.trajectory__range')).toBeNull();
    expect(mocks.range).toHaveBeenLastCalledWith(null, false);
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ node: mocks.nodes[4] }));
  });
  it('a click selects a node without creating a range and keyboard movement alone does not navigate', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 18); pointer(rail, 'pointerup', 18); });
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ node: mocks.nodes[1] }));
    mocks.select.mockClear();
    await act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it('retains node selection after leaving, waiting and scrolling, until a blank click clears it', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => { pointer(rail, 'pointerdown', 18); pointer(rail, 'pointerup', 18); });
    await act(async () => { pointer(rail, 'pointerout', 420); rail.blur(); rail.dispatchEvent(new Event('scroll')); });
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('aria-posinset')).toBe('2');
    const control = document.createElement('button'); const blank = document.createElement('div');
    document.body.append(control, blank);
    try {
      act(() => control.click());
      expect(container.querySelector('[aria-selected="true"]')).not.toBeNull();
      act(() => blank.click());
      expect(container.querySelector('[aria-selected="true"]')).toBeNull();
      expect(mocks.clearSelection).toHaveBeenCalledTimes(1);
      expect(mocks.close).not.toHaveBeenCalled();
    } finally { control.remove(); blank.remove(); }
  });
  it('clears selection in trailing rail whitespace without selecting the last node or focusing the first', async () => {
    mocks.nodes = mocks.nodes.slice(0, 3);
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 18); pointer(rail, 'pointerup', 18); });
    mocks.select.mockClear();
    await act(async () => { pointer(rail, 'pointerdown', 80); pointer(rail, 'pointerup', 80); });
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
    expect(container.querySelector('[data-focused="true"]')).toBeNull();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.clearSelection).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('omits the title row, duplicate search controls and event count from the trajectory', async () => {
    await mount();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('.trajectory__toolbar')).toBeNull();
    expect(container.querySelector('.trajectory__summary')).toBeNull();
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(container.querySelector('.trajectory__status')).toBeNull();
  });
  it('drives search navigation and counts from controls hosted in the top bar', async () => {
    vi.useFakeTimers();
    await mount('needle');
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(mocks.query).toHaveBeenLastCalledWith('needle');
    await act(async () => explorer.current?.next());
    expect(mocks.select).toHaveBeenLastCalledWith({ node: mocks.nodes[0], query: 'needle' });
    expect(mocks.searchState).toHaveBeenLastCalledWith({ count: 5000, current: 1 });
    await act(async () => explorer.current?.next());
    expect(mocks.select).toHaveBeenLastCalledWith({ node: mocks.nodes[2], query: 'needle' });
    await act(async () => explorer.current?.previous());
    expect(mocks.select).toHaveBeenLastCalledWith({ node: mocks.nodes[0], query: 'needle' });
  });
  it('keeps top-bar search navigation inside the selected range', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 2); pointer(rail, 'pointermove', 35); pointer(rail, 'pointerup', 35); });
    await act(async () => explorer.current?.next());
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ node: mocks.nodes[0] }));
    await act(async () => explorer.current?.next());
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ node: mocks.nodes[2] }));
    expect(container.querySelector('.trajectory__range')).not.toBeNull();
    expect(mocks.searchState).toHaveBeenLastCalledWith({ count: 2, current: 2 });
  });
  it('keeps the trajectory and top search open after an outside blank click', async () => {
    await mount();
    const search = document.createElement('div'); search.setAttribute('role', 'search');
    search.innerHTML = '<input /><span>Search results</span>';
    const blank = document.createElement('div'); document.body.append(search, blank);
    try {
      await act(async () => { search.querySelector('input')!.click(); search.querySelector('span')!.click(); });
      expect(mocks.close).not.toHaveBeenCalled();
      await act(async () => blank.click());
      expect(mocks.close).not.toHaveBeenCalled();
    } finally { search.remove(); blank.remove(); }
  });
  it('keyboard preview keeps the selected node until activation', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => { pointer(rail, 'pointerdown', 18); pointer(rail, 'pointerup', 18); });
    mocks.select.mockClear();
    await act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('aria-posinset')).toBe('2');
    expect(container.querySelector('[data-focused="true"]')?.getAttribute('aria-posinset')).toBe('3');
    await act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ node: mocks.nodes[2] }));
  });
  it('keeps the committed selection while another node is resolving or cannot be located', async () => {
    await mount(); const rail = container.querySelector('[role="listbox"]')!;
    await act(async () => { pointer(rail, 'pointerdown', 18); pointer(rail, 'pointerup', 18); });
    let finish!: (located: boolean) => void;
    mocks.select.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { pointer(rail, 'pointerdown', 35); pointer(rail, 'pointerup', 35); });
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('aria-posinset')).toBe('2');
    await act(async () => finish(false));
    expect(container.querySelector('[aria-selected="true"]')?.getAttribute('aria-posinset')).toBe('2');
    expect(container.querySelector('.trajectory__status')?.textContent).toContain('trajectory.locateFailed');
  });
});
