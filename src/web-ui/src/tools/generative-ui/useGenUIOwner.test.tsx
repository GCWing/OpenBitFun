// @vitest-environment jsdom
import { StrictMode, type ReactNode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenUIOwner } from './useGenUIOwner';
import type { GenUIOwnerRevision } from './genUIOwner';
import examples from '../../../../shared/generative-ui/examples.json';
import type { GenUIAppDefinition } from './genUITypes';
const mocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock('./genUIOwner', () => ({ accessGenUIOwner: mocks.access }));
const app = examples.ledger as GenUIAppDefinition;
const origin = { type: 'tool-call', toolName: 'GenerativeUI', surfaceId: 'local', sessionId: 'session', scope: { surfaceId: 'local', workspaceId: 'workspace' } } as const;
const revision = (id: string, state = { amount: 0 }): GenUIOwnerRevision => ({ revision: id, app, state, evidence: {} });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const roots: Root[] = [];
function renderHook<P, R>(hook: (props: P) => R, options?: { initialProps: P; wrapper?: (props: { children: ReactNode }) => ReactNode }) {
  const root = createRoot(document.createElement('div')); roots.push(root);
  const result = { current: undefined as R };
  function Probe({ value }: { value: P }) { result.current = hook(value); return null; }
  const rerender = (value: P) => act(() => { const node = <Probe value={value} />; root.render(options?.wrapper ? options.wrapper({ children: node }) : node); });
  rerender(options?.initialProps as P);
  return { result, rerender };
}
async function waitFor(assertion: () => void) { await act(async () => { await Promise.resolve(); }); assertion(); }
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); });
describe('source-bound GenUI owner', () => {
  beforeEach(() => mocks.access.mockReset());
  it('survives StrictMode remount and rejects an earlier load after switching sources', async () => {
    mocks.access.mockResolvedValue(revision('r1'));
    const hook = renderHook(({ sessionId }) => useGenUIOwner({ ...origin, sessionId }, app, 'r0'), { initialProps: { sessionId: 'first' }, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const old = deferred<GenUIOwnerRevision>();
    mocks.access.mockReturnValueOnce(old.promise);
    hook.rerender({ sessionId: 'second' });
    mocks.access.mockResolvedValue(revision('r3', { amount: 3 }));
    hook.rerender({ sessionId: 'third' });
    await waitFor(() => expect(hook.result.current.state).toEqual({ amount: 3 }));
    await act(async () => { old.resolve(revision('r2', { amount: 2 })); });
    expect(hook.result.current.state).toEqual({ amount: 3 });
    expect(hook.result.current.error).toBeUndefined();
  });
  it('serializes CAS writes without rehydrating acknowledged snapshots over new edits', async () => {
    mocks.access.mockResolvedValueOnce(revision('r1'));
    const hook = renderHook(() => useGenUIOwner(origin, app, 'r0'));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const first = deferred<GenUIOwnerRevision>();
    mocks.access.mockReturnValueOnce(first.promise).mockResolvedValueOnce(revision('r3', { amount: 3 }));
    let saved!: Promise<void>; let later!: Promise<void>;
    act(() => { saved = hook.result.current.save({ amount: 2 }); later = hook.result.current.save({ amount: 3 }); });
    await waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(2));
    await act(async () => { first.resolve(revision('r2', { amount: 2 })); await saved; await later; });
    expect(mocks.access.mock.calls[2][2]).toEqual({ revision: 'r2', state: { amount: 3 } });
    expect(hook.result.current.state).toEqual({ amount: 0 });
    mocks.access.mockResolvedValueOnce(revision('r3', { amount: 3 }));
    await act(async () => { await hook.result.current.reload(); });
    expect(hook.result.current.state).toEqual({ amount: 3 });
  });
  it('does not adopt a newer application revision from an idempotent save response', async () => {
    mocks.access.mockResolvedValueOnce(revision('r1'));
    const hook = renderHook(() => useGenUIOwner(origin, app, 'r0'));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    mocks.access.mockResolvedValueOnce({ ...revision('r2'), app: { ...app, title: 'New application' } });
    await expect(hook.result.current.save({ amount: 0 })).rejects.toThrow('newer application');
    mocks.access.mockResolvedValueOnce(revision('r3', { amount: 1 }));
    await act(async () => { await hook.result.current.save({ amount: 1 }); });
    expect(mocks.access.mock.lastCall?.[2].revision).toBe('r1');
  });
});
