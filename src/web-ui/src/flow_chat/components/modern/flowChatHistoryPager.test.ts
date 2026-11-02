import { describe, expect, it } from 'vitest';
import { FlowChatHistoryPager } from './flowChatHistoryPager';

function setup() {
  const pager = new FlowChatHistoryPager();
  pager.commitLayout('tail', { before: 'turn-40', after: 'turn-46' });
  return pager;
}

describe('FlowChatHistoryPager', () => {
  it('acknowledges an already-projected legacy result without a prepare callback', () => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.readerIntent('before');
    pager.finish(ticket, 'applied');
    expect(pager.begin('before')).toBeNull();
    pager.commitLayout('tail', { before: 'turn-40', after: 'turn-46' });
    expect(pager.begin('before')).not.toBeNull();
  });

  it('uses the same request/layout/demand policy for newer history', () => {
    const pager = setup();
    const ticket = pager.begin('after')!;
    pager.prepareCommit(ticket);
    pager.readerIntent('after');
    pager.finish(ticket, 'applied');
    pager.commitLayout('40:54', { before: 'turn-40', after: 'turn-54' });
    expect(pager.begin('after')).not.toBeNull();
  });

  it.each(['layout-first', 'result-first'] as const)('waits for both result and layout (%s)', order => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.prepareCommit(ticket);
    pager.readerIntent('before');
    const commit = () => pager.commitLayout('38:46', { before: 'turn-38', after: 'turn-46' });
    if (order === 'layout-first') commit();
    else pager.finish(ticket, 'applied');
    expect(pager.begin('before')).toBeNull();
    if (order === 'layout-first') pager.finish(ticket, 'applied');
    else commit();
    expect(pager.begin('before')).not.toBeNull();
  });

  it('pages twice across tail -> history without ever reaching the physical boundary', () => {
    const pager = setup();
    const first = pager.begin('before')!;
    pager.prepareCommit(first);
    pager.finish(first, 'applied');
    pager.commitLayout('38:46', { before: 'turn-38', after: 'turn-46' });
    pager.observeProximity(new Set(['before']));
    expect(pager.begin('before')).toBeNull();
    pager.readerIntent('before');
    const second = pager.begin('before')!;
    expect(second.id).not.toBe(first.id);
    pager.prepareCommit(second);
    pager.commitLayout('30:46', { before: 'turn-30', after: 'turn-46' });
    pager.finish(second, 'applied');
    expect(pager.begin('before')).toBeNull();
  });

  it('coalesces ongoing reader demand and never converts repeated layout into demand', () => {
    const pager = setup();
    const first = pager.begin('before')!;
    for (let i = 0; i < 10; i++) pager.readerIntent('before');
    pager.prepareCommit(first);
    pager.commitLayout('38:46', { before: 'turn-38', after: 'turn-46' });
    pager.finish(first, 'applied');
    const second = pager.begin('before')!;
    pager.prepareCommit(second);
    pager.finish(second, 'applied');
    for (let i = 0; i < 10; i++) {
      pager.commitLayout('30:46', { before: 'turn-30', after: 'turn-46' });
      pager.observeProximity(new Set(['before']));
      expect(pager.begin('before')).toBeNull();
    }
  });

  it('accepts fresh top-edge intent when the short page cannot scroll', () => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.prepareCommit(ticket);
    pager.finish(ticket, 'applied');
    pager.commitLayout('38:46', { before: 'turn-38', after: 'turn-46' });
    pager.readerIntent('before');
    expect(pager.begin('before')).not.toBeNull();
  });

  it('drops queued demand when the reader reverses or the new boundary is far away', () => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.readerIntent('before');
    pager.readerIntent('after');
    expect(pager.snapshot('before').demand).toBe(false);
    pager.readerIntent('before');
    pager.prepareCommit(ticket);
    pager.finish(ticket, 'applied');
    pager.commitLayout('30:46', { before: 'turn-30', after: 'turn-46' });
    pager.observeProximity(new Set());
    expect(pager.begin('before')).toBeNull();
    pager.readerIntent('before');
    pager.observeProximity(new Set(['before']));
    expect(pager.begin('before')).not.toBeNull();
  });

  it.each(['applied', 'exhausted', 'not-ready', 'cancelled'] as const)('ignores stale %s after navigation', result => {
    const pager = setup();
    const old = pager.begin('before')!;
    pager.reset();
    pager.commitLayout('10:18', { before: 'turn-10', after: 'turn-18' });
    const current = pager.begin('before')!;
    expect(pager.prepareCommit(old)).toBe(false);
    expect(pager.finish(old, result)).toBe(false);
    expect(pager.snapshot('before').requestId).toBe(current.id);
  });

  it('invalidates an unprepared fetch when a different presentation commits', () => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.commitLayout('10:18', { before: 'turn-10', after: 'turn-18' });
    expect(pager.prepareCommit(ticket)).toBe(false);
    expect(pager.finish(ticket, 'exhausted')).toBe(false);
    expect(pager.begin('before')).not.toBeNull();
  });

  it('does not cancel an older-page fetch when live output extends the other end', () => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.commitLayout('40:47', { before: 'turn-40', after: 'turn-47' });
    expect(pager.begin('before')).toBeNull();
    expect(pager.prepareCommit(ticket)).toBe(true);
    pager.commitLayout('32:47', { before: 'turn-32', after: 'turn-47' });
    expect(pager.finish(ticket, 'applied')).toBe(true);
  });

  it('keeps exhaustion scoped to the boundary that answered', () => {
    const pager = setup();
    pager.finish(pager.begin('before')!, 'exhausted');
    pager.readerIntent('before');
    expect(pager.begin('before')).toBeNull();
    pager.commitLayout('10:18', { before: 'turn-10', after: 'turn-18' });
    expect(pager.begin('before')).not.toBeNull();
  });

  it.each(['not-ready', 'cancelled'] as const)('does not retry %s on passive evaluations', result => {
    const pager = setup();
    const ticket = pager.begin('before')!;
    pager.readerIntent('before');
    pager.finish(ticket, result);
    expect(pager.begin('before')).toBeNull();
    pager.readerIntent('before');
    expect(pager.begin('before')).not.toBeNull();
  });
});
