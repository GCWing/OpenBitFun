import { expect, it, vi } from 'vitest';
import { claimBrowserPresentation } from './retainedBrowserPresentation';

it('drains in-flight native calls before a new panel presents the page and ignores stale cleanup', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const old = claimBrowserPresentation('retained-page');
  const pending = old.run(async () => {
    calls.push('old-start');
    await new Promise<void>(resolve => { finish = resolve; });
    calls.push('old-finish');
  });
  await Promise.resolve();
  await Promise.resolve();
  const next = claimBrowserPresentation('retained-page');
  const present = next.run(async () => { calls.push('new-show'); });
  const staleHide = vi.fn(async () => {});
  const cleanup = old.run(staleHide);
  old.release();
  expect(next.isCurrent()).toBe(true);
  finish();
  await Promise.all([pending, present, cleanup]);
  expect(calls).toEqual(['old-start', 'old-finish', 'new-show']);
  expect(staleHide).not.toHaveBeenCalled();
  next.release();
});

it('keeps different session pages independent when one native call is pending', async () => {
  let finish!: () => void;
  const a = claimBrowserPresentation('independent-a');
  const b = claimBrowserPresentation('independent-b');
  const pending = a.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const showB = vi.fn(async () => {});
  await b.run(showB);
  expect(showB).toHaveBeenCalledOnce();
  finish();
  await pending;
  a.release();
  b.release();
});
