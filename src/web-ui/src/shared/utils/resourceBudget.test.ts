import { describe, expect, it } from 'vitest';
import { estimateRetainedBytes, ResourceBudget } from './resourceBudget';

describe('application resource budget', () => {
  it('reclaims derived data first and rechecks live protections without exceeding their owner boundary', () => {
    const budget = new ResourceBudget(10, 20);
    const removed: string[] = [];
    let visible = true;
    budget.set({}, { bytes: 12, kind: 'history', lastUsedAt: 0,
      protectedReason: () => visible ? 'visible' : undefined, evict: () => removed.push('visible') });
    budget.set({}, { bytes: 9, kind: 'history', lastUsedAt: 1, evict: () => removed.push('cold') });
    budget.set({}, { bytes: 8, kind: 'derived', lastUsedAt: 2, evict: () => removed.push('derived') });
    budget.trim();
    expect(removed).toEqual(['derived', 'cold']);
    expect(budget.byteSize).toBe(12);
    visible = false;
    budget.trim(true);
    expect(removed).toEqual(['derived', 'cold', 'visible']);
  });

  it('keeps old inactive history warm while the cache remains below budget', () => {
    const budget = new ResourceBudget();
    const key = {};
    let evicted = false;
    budget.set(key, { bytes: 8, kind: 'history', lastUsedAt: 0,
      evict: () => { evicted = true; } });
    budget.trim();
    expect(evicted).toBe(false);
    budget.trim(true);
    expect(evicted).toBe(false);
    expect(budget.byteSize).toBe(8);
  });

  it('accounts shared object references once and tolerates cycles', () => {
    const turn = { content: 'abc' };
    const seen = new Set<object>();
    expect(estimateRetainedBytes(turn, seen)).toBeGreaterThan(6);
    expect(estimateRetainedBytes(turn, seen)).toBe(0);
    const cycle: { self?: object } = {};
    cycle.self = cycle;
    expect(estimateRetainedBytes(cycle)).toBeGreaterThan(0);
  });
});
