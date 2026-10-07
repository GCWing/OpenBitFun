// @vitest-environment jsdom
import React, { act, Component, createRef, forwardRef, Suspense, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyWithRecovery } from './lazyWithRecovery';
import { retryFailedModuleLoads } from './moduleLoader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `errors:${key}` }),
}));
vi.mock('./logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('recoverable lazy views', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const settle = async () => { await act(async () => { await vi.runAllTimersAsync(); }); };

  it('contains a nested import failure, retries with a fresh lazy payload and preserves sibling state', async () => {
    const load = vi.fn().mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'));
    const View = lazyWithRecovery(load);
    function Workspace() {
      const [count, setCount] = useState(0);
      return <><button id="sibling" onClick={() => setCount(count + 1)}>{count}</button><Suspense fallback="pending"><View /></Suspense></>;
    }
    await act(async () => { root.render(<Workspace />); });
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    const sibling = host.querySelector<HTMLButtonElement>('#sibling')!;
    act(() => sibling.click());
    load.mockResolvedValue({ default: () => <p>recovered view</p> });
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'errors:moduleLoad.retry')!;
    await act(async () => retry.click());
    expect(host.textContent).toContain('recovered view');
    expect(host.querySelector('#sibling')).toBe(sibling);
    expect(sibling.textContent).toBe('1');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('recovers failed views after HMR without remounting healthy views, and stops listening after success/unmount', async () => {
    let mounts = 0;
    const healthyLoad = vi.fn(async () => ({ default: function Healthy() {
      useEffect(() => { mounts += 1; }, []);
      return <input defaultValue="draft" />;
    } }));
    const failedLoad = vi.fn().mockRejectedValue(new SyntaxError('Broken module'));
    const Healthy = lazyWithRecovery(healthyLoad);
    const Broken = lazyWithRecovery(failedLoad);
    await act(async () => { root.render(<Suspense fallback="pending"><Healthy /><Broken /></Suspense>); });
    expect(failedLoad).toHaveBeenCalledOnce();
    const input = host.querySelector('input');
    failedLoad.mockResolvedValue({ default: () => <p>fixed by HMR</p> });
    await act(async () => retryFailedModuleLoads());
    expect(host.textContent).toContain('fixed by HMR');
    expect(host.querySelector('input')).toBe(input);
    expect(mounts).toBe(1);
    await act(async () => retryFailedModuleLoads());
    expect(failedLoad).toHaveBeenCalledTimes(2);
    expect(healthyLoad).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    await act(async () => retryFailedModuleLoads());
    expect(failedLoad).toHaveBeenCalledTimes(2);
  });

  it('reopening a failed view does not reuse a rejected lazy component', async () => {
    const load = vi.fn().mockRejectedValue(new SyntaxError('Broken module'));
    const View = lazyWithRecovery(load);
    await act(async () => { root.render(<Suspense fallback="pending"><View /></Suspense>); });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => root.render(null));
    load.mockResolvedValue({ default: () => <p>reopened</p> });
    await act(async () => { root.render(<Suspense fallback="pending"><View /></Suspense>); });
    expect(host.textContent).toBe('reopened');
  });

  it('recovers in StrictMode and releases listeners when a failed view is closed', async () => {
    const load = vi.fn().mockRejectedValue(new SyntaxError('Broken module'));
    const View = lazyWithRecovery(load);
    await act(async () => { root.render(<React.StrictMode><Suspense fallback="pending"><View /></Suspense></React.StrictMode>); });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    load.mockResolvedValue({ default: () => <p>strict recovery</p> });
    await act(async () => retryFailedModuleLoads());
    expect(host.textContent).toBe('strict recovery');

    const failedLoad = vi.fn().mockRejectedValue(new SyntaxError('Still broken'));
    const FailedView = lazyWithRecovery(failedLoad);
    await act(async () => { root.render(<Suspense fallback="pending"><FailedView /></Suspense>); });
    await act(async () => root.render(null));
    await act(async () => retryFailedModuleLoads());
    expect(failedLoad).toHaveBeenCalledOnce();
  });

  it('shares preloading with rendering and forwards component props and refs', async () => {
    const Field = forwardRef<HTMLInputElement, { value: string }>((props, ref) => <input ref={ref} defaultValue={props.value} />);
    const load = vi.fn(async () => ({ default: Field }));
    const View = lazyWithRecovery(load);
    await View.preload();
    const ref = createRef<HTMLInputElement>();
    await act(async () => { root.render(<Suspense fallback="pending"><View value="saved" ref={ref} /></Suspense>); });
    expect(ref.current?.value).toBe('saved');
    expect(load).toHaveBeenCalledOnce();
  });

  it('leaves render exceptions to the owning application boundary, even when their message resembles a fetch error', async () => {
    class OuterBoundary extends Component<React.PropsWithChildren, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? 'render error' : this.props.children; }
    }
    const load = vi.fn(async () => ({ default: () => { throw new TypeError('Failed to fetch dynamically imported module'); } }));
    const View = lazyWithRecovery(load);
    await act(async () => { root.render(<OuterBoundary><Suspense fallback="pending"><View /></Suspense></OuterBoundary>); });
    expect(host.textContent).toBe('render error');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });
});
