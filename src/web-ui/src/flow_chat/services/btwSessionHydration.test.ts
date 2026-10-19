import { describe, expect, it } from 'vitest';
import { createBtwSessionHydrationTracker } from './btwSessionHydration';

/** A pane that can start loads, i.e. it knows the child and its parent. */
const canLoad = { canStartAttempt: true } as const;

describe('createBtwSessionHydrationTracker', () => {
  it('does nothing for a pane without a child session tab', () => {
    const tracker = createBtwSessionHydrationTracker();

    expect(tracker.observe({ hasRecord: false, ...canLoad }))
      .toEqual({ status: 'idle', shouldAttempt: false });
  });

  it('leaves a recorded child session alone', () => {
    const tracker = createBtwSessionHydrationTracker();

    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'idle', shouldAttempt: false });
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'idle', shouldAttempt: false });
  });

  it('attempts exactly one load for a mounted child tab whose record is missing', () => {
    const tracker = createBtwSessionHydrationTracker();

    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: true });
    // Re-renders, store notifications, and tab activations keep observing.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: false });
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: false });
  });

  it('reports unavailable once the attempt settled instead of looping', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });

    tracker.settle('child', 'failed');

    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
  });

  it('keeps the recovery state for a shell the failed attempt left behind', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });
    tracker.settle('child', 'failed');

    // `ensureBtwSessionAvailable` recreates a record before it hydrates it, so a
    // failure leaves a record with no turns. That is not a healed pane.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
  });

  it('stays in flight while the heal creates its record mid-attempt', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });

    // The record appears before the history finishes loading: keep the loading
    // state instead of flashing the shell's empty transcript.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: false });
    tracker.settle('child', 'loaded');
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'idle', shouldAttempt: false });
  });

  it('keeps the recovery offered when the record is gone after a successful load', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });

    // The record was removed again while its history was loading: no attempt may
    // be armed here, or the pane would show a load that nothing started.
    tracker.settle('child', 'loaded');

    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
  });

  it('re-arms when the record came back through a successful load', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });
    tracker.settle('child', 'loaded');

    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'idle', shouldAttempt: false });
    // The record disappeared again: that is a new absence, so it may load once more.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: true });
  });

  it('starts a fresh attempt when the tab switches to another child session', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });
    tracker.settle('child', 'failed');

    expect(tracker.observe({ childSessionId: 'other-child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: true });
  });

  it('retries a shell record once for an explicit retry request', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });
    tracker.settle('child', 'failed');
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }).shouldAttempt).toBe(false);

    tracker.rearm('child');

    // A failed heal leaves a shell, so a retry must load even though a record exists.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: true });
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, ...canLoad }).shouldAttempt).toBe(false);
  });

  it('ignores a settle that belongs to a superseded child session', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });

    tracker.settle('other-child', 'failed');

    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }).status).toBe('loading');
    tracker.settle('child', 'failed');
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }).status).toBe('unavailable');
  });

  it('never arms a load for a tab that cannot start one', () => {
    const tracker = createBtwSessionHydrationTracker();

    // The MiniApp customize chat renders the pane with a child id and no parent,
    // so no record can be recreated. The pane must explain that, not load forever.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, canStartAttempt: false }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, canStartAttempt: false }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
  });

  it('keeps a record it can show when the tab cannot start loads', () => {
    const tracker = createBtwSessionHydrationTracker();

    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, canStartAttempt: false }))
      .toEqual({ status: 'idle', shouldAttempt: false });
    // A retry request cannot load anything either: the pane stays usable.
    tracker.rearm('child');
    expect(tracker.observe({ childSessionId: 'child', hasRecord: true, canStartAttempt: false }))
      .toEqual({ status: 'idle', shouldAttempt: false });
  });

  it('clears an armed attempt when the pane loses the parent it needs', () => {
    const tracker = createBtwSessionHydrationTracker();
    tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad });

    // The parent went away mid-flight: nothing the caller can settle remains, so
    // the pane must not stay on a load forever.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, canStartAttempt: false }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });

    tracker.settle('child', 'loaded');
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, canStartAttempt: false }))
      .toEqual({ status: 'unavailable', shouldAttempt: false });
    // Nothing was left in flight, so regaining a parent arms exactly one attempt.
    expect(tracker.observe({ childSessionId: 'child', hasRecord: false, ...canLoad }))
      .toEqual({ status: 'loading', shouldAttempt: true });
  });
});
