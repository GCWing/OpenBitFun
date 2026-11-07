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

  const round = (id: string, content: string, status = 'completed') => ({
    id, status, isStreaming: status === 'streaming', isComplete: status === 'completed',
    items: [{ id: `${id}-text`, type: 'text', content }],
  });

  it.each(['cancelled', 'error'])('counts the completed prefix before a %s round in a resumed turn', status => {
    const content = 'x'.repeat(1024 * 1024);
    const turn = { id: 'resumed', modelRounds: [
      round('first', content), round('interrupted', 'partial', status),
      round('resumed', 'continued'), round('tail', 'streaming', 'streaming'),
    ] };
    const bytes = estimateRetainedBytes(turn);
    expect(bytes).toBeGreaterThan(content.length * 2);
    expect(estimateRetainedBytes(turn)).toBe(bytes);
  });

  it('accounts immutable updates to an interior completed round', () => {
    const rounds = ['first', 'middle', 'last', 'tail'].map(id => round(id, '', id === 'tail' ? 'streaming' : 'completed'));
    const turn = { id: 'updated', modelRounds: rounds };
    const before = estimateRetainedBytes(turn);
    const content = 'x'.repeat(1024 * 1024);
    const updated = { ...turn, modelRounds: rounds.map((value, index) => index === 1
      ? { ...value, items: [{ ...value.items[0], content }] } : value) };
    expect(estimateRetainedBytes(updated) - before).toBe(content.length * 2);
  });

  it('counts shared completed-round contents once even after separate measurements', () => {
    const shared = { content: 'x'.repeat(4096) };
    const completed = { ...round('shared', ''), items: [shared] };
    const first = estimateRetainedBytes({ shared, completed });
    estimateRetainedBytes(completed);
    expect(estimateRetainedBytes({ shared, completed })).toBe(first);
    expect(estimateRetainedBytes({ completed, shared })).toBe(first);
    const seen = new Set<object>();
    estimateRetainedBytes(completed, seen);
    expect(estimateRetainedBytes(shared, seen)).toBe(0);
  });
});
