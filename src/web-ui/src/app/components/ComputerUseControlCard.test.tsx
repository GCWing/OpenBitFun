// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComputerUseControlCard } from './ComputerUseControlCard';
import type { ComputerUseControlPreview, ComputerUseControlSnapshot } from '@/infrastructure/api/service-api/ComputerUseControlAPI';

const mocks = vi.hoisted(() => ({ status: vi.fn(), stop: vi.fn(), preview: vi.fn(),
  observeShare: vi.fn(), permissions: vi.fn(), targets: vi.fn(),
  scope: { epoch: 1, isCurrent: () => true }, listeners: new Set<() => void>(), t: (key: string) => key }));
vi.mock('@/infrastructure/api/service-api/ComputerUseControlAPI', async original => ({
  ...await original<object>(), computerUseControlAPI: mocks,
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({
  getActiveSurfaceScope: () => mocks.scope,
  onSurfaceActivated: (fn: () => void) => { mocks.listeners.add(fn); return () => mocks.listeners.delete(fn); },
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Card: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  OverlayLayer: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  OverflowText: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  Select: () => <select />,
}));
vi.mock('@/infrastructure/api/service-api/ApiClient', () => ({ api: {} }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const active = (target: string, generation = 4): ComputerUseControlSnapshot => ({
  supported: true, generation, owner: 'session', mode: 'background', state: 'active', target,
  action: null, sequence: 1, reason: null, pointer: null, capabilities: [],
});
const frame = (target = 'Window A', generation = 4): ComputerUseControlPreview => ({
  generation, target, image_base64: 'AA==', mime_type: 'image/png', width: 100, height: 100,
  origin_x: 0, origin_y: 0, span_width: 100, span_height: 100,
});
const button = (key: string) => [...container.querySelectorAll('button')].find(b => b.textContent === key)!;
beforeEach(() => {
  vi.useFakeTimers(); mocks.status.mockReset(); mocks.stop.mockReset(); mocks.preview.mockReset();
  mocks.observeShare.mockReset(); mocks.permissions.mockReset().mockResolvedValue({});
  mocks.targets.mockReset().mockResolvedValue([]);
  mocks.scope = { epoch: 1, isCurrent: () => mocks.scope.epoch === 1 };
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('stops the generation the user saw, then removes the card', async () => {
  mocks.status.mockResolvedValue(active('Window A'));
  mocks.stop.mockResolvedValue({ ...active('Window A', 5), state: 'stopped' });
  await act(async () => root.render(<ComputerUseControlCard />));
  const stop = [...container.querySelectorAll('button')].find(b => b.textContent === 'computerControl.stop')!;
  await act(async () => stop.click());
  expect(mocks.stop).toHaveBeenCalledWith(4);
  expect(container.textContent).not.toContain('computerControl.title');
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'computerControl.stop')).toBe(false);
});

it('discards an old device response when the surface changes with a read in flight', async () => {
  let resolveOld!: (value: ComputerUseControlSnapshot) => void;
  mocks.status.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValue(active('Peer B'));
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => {
    mocks.scope = { epoch: 2, isCurrent: () => mocks.scope.epoch === 2 };
    mocks.listeners.forEach(fn => fn());
  });
  await act(async () => resolveOld(active('Local secret')));
  expect(container.textContent).toContain('Peer B');
  expect(container.textContent).not.toContain('Local secret');
  expect(mocks.stop).not.toHaveBeenCalled();
});


it('does not restore active control from a read started before Stop completed', async () => {
  let resolveRead!: (value: ComputerUseControlSnapshot) => void;
  mocks.status.mockResolvedValueOnce(active('Window A'))
    .mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
  mocks.stop.mockResolvedValue({ ...active('Window A', 5), state: 'stopped' });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => vi.advanceTimersByTime(1000));
  const stop = [...container.querySelectorAll('button')].find(b => b.textContent === 'computerControl.stop')!;
  await act(async () => stop.click());
  await act(async () => resolveRead(active('Window A')));
  expect(container.textContent).not.toContain('computerControl.title');
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'computerControl.stop')).toBe(false);
});

it('renders a retained click even when the instantaneous pointer is already up', async () => {
  mocks.status.mockResolvedValue({ ...active('Window A'), pointer: {
    x: 80, y: 70, click: false, sequence: 9,
    last_click: { x: 25, y: 50, sequence: 8, occurred_at_ms: 1 },
  } });
  mocks.preview.mockResolvedValue({ generation: 4, target: 'Window A', image_base64: 'AA==', mime_type: 'image/png',
    width: 100, height: 100, origin_x: 0, origin_y: 0, span_width: 100, span_height: 100 });
  await act(async () => root.render(<ComputerUseControlCard />));
  const ring = container.querySelector<HTMLElement>('[data-openbitfun-part="click"]');
  expect(ring?.style.left).toBe('25%');
  expect(ring?.style.top).toBe('50%');
  await act(async () => vi.advanceTimersByTime(300));
  expect(container.querySelector('[data-openbitfun-part="click"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-openbitfun-part="click"]')).toBeNull();
});


it('does not show a preview from a different target in the same session', async () => {
  mocks.status.mockResolvedValue(active('Window A'));
  mocks.preview.mockResolvedValue({ generation: 4, target: 'Window B', image_base64: 'AA==', mime_type: 'image/png',
    width: 100, height: 100, origin_x: 0, origin_y: 0, span_width: 100, span_height: 100 });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('computerControl.previewUnavailable');
});


it('keeps the session arrow after click feedback expires and clears it on stop', async () => {
  mocks.status.mockResolvedValue({ ...active('Window A'), pointer: {
    x: 40, y: 60, click: false, sequence: 10,
  } });
  mocks.preview.mockResolvedValue({ generation: 4, target: 'Window A', image_base64: 'AA==', mime_type: 'image/png',
    width: 100, height: 100, origin_x: 0, origin_y: 0, span_width: 100, span_height: 100 });
  mocks.stop.mockResolvedValue({ ...active('Window A', 5), state: 'stopped' });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => vi.advanceTimersByTime(1000));
  await act(async () => vi.advanceTimersByTime(2000));
  const arrow = container.querySelector<HTMLElement>('[data-openbitfun-part="pointer"]');
  expect(arrow?.querySelector('svg path')).not.toBeNull();
  expect(arrow?.classList.contains('computer-control-card__pointer--physical')).toBe(true);
  expect(arrow?.style.transform).toContain('translate3d(115.2px,115.2px,0)');
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'computerControl.stop')!.click());
  expect(container.querySelector('[data-openbitfun-part="pointer"]')).toBeNull();
});


it('removes the old target pointer while waiting for the new target preview', async () => {
  mocks.status.mockResolvedValue({ ...active('Window A'), pointer: { x: 40, y: 60, click: false, sequence: 10 } });
  mocks.preview.mockResolvedValue({ generation: 4, target: 'Window A', image_base64: 'AA==', mime_type: 'image/png',
    width: 100, height: 100, origin_x: 0, origin_y: 0, span_width: 100, span_height: 100 });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-openbitfun-part="pointer"]')).not.toBeNull();
  mocks.status.mockResolvedValue(active('Window B'));
  mocks.preview.mockReturnValue(new Promise(() => {}));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-openbitfun-part="pointer"]')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
});

it('discards a preview from an earlier visit to the same target', async () => {
  mocks.status.mockResolvedValue({ ...active('Window A'), target_revision: 3 });
  mocks.preview.mockResolvedValue({ generation: 4, target: 'Window A', target_revision: 1,
    image_base64: 'AA==', mime_type: 'image/png', width: 100, height: 100,
    origin_x: 0, origin_y: 0, span_width: 100, span_height: 100 });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('computerControl.previewUnavailable');
});

it.each(['absent', 'rejected', 'wrong-target', 'stale-revision', 'invalid-image'])(
  'keeps live control status and Stop available when the preview is %s', async kind => {
    mocks.status.mockResolvedValue({ ...active('Window A'), target_revision: 2 });
    const frame = { generation: 4, target: 'Window A', target_revision: 2,
      image_base64: 'AA==', mime_type: 'image/png', width: 100, height: 100 };
    if (kind === 'rejected') mocks.preview.mockRejectedValue(new Error('Capture unavailable'));
    else mocks.preview.mockResolvedValue(kind === 'absent' ? null : {
      ...frame,
      ...(kind === 'wrong-target' ? { target: 'Window B' } : {}),
      ...(kind === 'stale-revision' ? { target_revision: 1 } : {}),
      ...(kind === 'invalid-image' ? { width: 0 } : {}),
    });
    mocks.stop.mockResolvedValue({ ...active('Window A', 5), state: 'stopped' });
    await act(async () => root.render(<ComputerUseControlCard />));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('computerControl.previewUnavailable');
    expect(container.textContent).toContain('computerControl.background');
    expect(container.textContent).not.toContain('computerControl.unavailable');
    await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'computerControl.stop')!.click());
    expect(mocks.stop).toHaveBeenCalledWith(4);
    expect(container.textContent).not.toContain('computerControl.title');
  },
);

it('still reports a failed status read as unavailable and permits Stop', async () => {
  mocks.status.mockResolvedValueOnce(active('Window A')).mockRejectedValue(new Error('Host unavailable'));
  mocks.stop.mockResolvedValue({ ...active('Window A', 5), state: 'stopped' });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).toContain('computerControl.unavailable');
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent === 'computerControl.stop')!.click());
  expect(mocks.stop).toHaveBeenCalledWith(4);
});
it('shows the preview by default and hides the card when control ends externally', async () => {
  mocks.status.mockResolvedValue(active('Window A'));
  mocks.preview.mockResolvedValue({ generation: 4, target: 'Window A', image_base64: 'AA==', mime_type: 'image/png',
    width: 100, height: 100 });
  await act(async () => root.render(<ComputerUseControlCard />));
  expect(container.querySelector('img')).not.toBeNull();
  expect(container.textContent).toContain('computerControl.hidePreview');
  mocks.status.mockResolvedValue({ ...active('Window A'), state: 'stopped', reason: 'task_cancelled' });
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).not.toContain('computerControl.title');
  expect(container.textContent).not.toContain('task_cancelled');
});

it.each(['idle', 'stopped'])('does not show an existing %s session on mount', async state => {
  mocks.status.mockResolvedValue({ ...active('Window A'), state });
  await act(async () => root.render(<ComputerUseControlCard />));
  expect(container.querySelector('.computer-control-card')).toBeNull();
  expect(mocks.preview).not.toHaveBeenCalled();
});

it('keeps manual collapse for the current control and fetches a new generation immediately', async () => {
  mocks.status.mockResolvedValue(active('Window A'));
  mocks.preview.mockResolvedValue(frame());
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => button('computerControl.hidePreview').click());
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('img')).toBeNull();
  expect(mocks.preview).toHaveBeenCalledTimes(1);
  await act(async () => button('computerControl.showPreview').click());
  expect(container.querySelector('img')).not.toBeNull();
  await act(async () => button('computerControl.hidePreview').click());

  mocks.status.mockResolvedValue(active('Window B', 6));
  mocks.preview.mockResolvedValue(frame('Window B', 6));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(mocks.preview).toHaveBeenLastCalledWith(6);
  expect(container.querySelector('img')).not.toBeNull();
  expect(button('computerControl.hidePreview').getAttribute('aria-expanded')).toBe('true');
});

it('defaults to expanded on another device even when its generation matches the collapsed session', async () => {
  mocks.status.mockResolvedValue(active('Local A'));
  mocks.preview.mockResolvedValue(frame('Local A'));
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => button('computerControl.hidePreview').click());
  mocks.status.mockResolvedValue(active('Peer B'));
  mocks.preview.mockResolvedValue(frame('Peer B'));
  await act(async () => {
    mocks.scope = { epoch: 2, isCurrent: () => mocks.scope.epoch === 2 };
    mocks.listeners.forEach(fn => fn());
  });
  expect(container.textContent).toContain('Peer B');
  expect(container.textContent).not.toContain('Local A');
  expect(container.querySelector('img')).not.toBeNull();
  expect(mocks.preview).toHaveBeenCalledTimes(2);
});

it('discards a pending preview from the previous device', async () => {
  let resolveOld!: (value: ComputerUseControlPreview) => void;
  mocks.status.mockResolvedValue(active('Same target'));
  mocks.preview.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValue({ ...frame('Same target'), image_base64: 'bmV3' });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => {
    mocks.scope = { epoch: 2, isCurrent: () => mocks.scope.epoch === 2 };
    mocks.listeners.forEach(fn => fn());
  });
  await act(async () => resolveOld(frame('Same target')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,bmV3');
});

it('does not restore a stopped card when its pending preview arrives', async () => {
  let resolvePreview!: (value: ComputerUseControlPreview) => void;
  mocks.status.mockResolvedValue(active('Window A'));
  mocks.preview.mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
  mocks.stop.mockResolvedValue({ ...active('Window A', 5), state: 'stopped' });
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => button('computerControl.stop').click());
  await act(async () => resolvePreview(frame()));
  expect(container.querySelector('.computer-control-card')).toBeNull();
});

it('retains the card and Stop action when stopping fails', async () => {
  mocks.status.mockResolvedValue(active('Window A'));
  mocks.preview.mockResolvedValue(frame());
  mocks.stop.mockRejectedValue(new Error('Host unavailable'));
  await act(async () => root.render(<ComputerUseControlCard />));
  await act(async () => button('computerControl.stop').click());
  expect(container.textContent).toContain('computerControl.unavailable');
  expect(button('computerControl.stop').disabled).toBe(false);
});

it.each(['starting', 'awaiting_share'])('keeps the %s card available for Stop', async state => {
  mocks.status.mockResolvedValue({ ...active('Window A'), state });
  await act(async () => root.render(<ComputerUseControlCard />));
  expect(button('computerControl.stop')).toBeDefined();
  expect(mocks.preview).not.toHaveBeenCalled();
});

it('opens an existing shared preview by default and stops observing after the session ends', async () => {
  const shared: ComputerUseControlSnapshot = { ...active('Window A'), target_revision: 1, mode: 'observe',
    sharing: { phase: 'shared', requested_mode: 'observe', target_label: 'Window A', control_enabled: false, authorization_revision: 0 } };
  mocks.status.mockResolvedValue(shared);
  mocks.observeShare.mockResolvedValue({ control: shared, tree: null, frame: {
    ...frame(), screenshot_id: 'frame', content: { left: 0, top: 0, width: 100, height: 100 }, bounds: null,
  } });
  await act(async () => root.render(<ComputerUseControlCard />));
  expect(container.querySelector('img')).not.toBeNull();
  expect(mocks.observeShare).toHaveBeenCalledExactlyOnceWith(shared);
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ ...shared, generation: 5, state: 'stopped' });
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.querySelector('.computer-control-card')).toBeNull();
  const calls = mocks.observeShare.mock.calls.length;
  await act(async () => vi.advanceTimersByTime(1000));
  expect(mocks.observeShare).toHaveBeenCalledTimes(calls);
});
