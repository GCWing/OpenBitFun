import { describe, expect, it } from 'vitest';
import type { ModelPoolMemberStatus } from '@/infrastructure/api/service-api/ModelPoolAPI';
import { getModelPoolContextBudget } from './modelPoolContextBudget';

describe('execution-host pool budgets', () => {
  it('takes independent minima and keeps temporarily unavailable members', () => {
    const statuses: ModelPoolMemberStatus[] = [
      { modelId: 'small', status: 'available', contextBudget: { contextWindow: 128_000, inputLimit: 110_000 } },
      { modelId: 'large', status: 'cooling_down', contextBudget: { contextWindow: 160_000, inputLimit: 86_000 } },
      { modelId: 'deleted', status: 'missing' },
    ];
    expect(getModelPoolContextBudget(statuses)).toEqual({ contextWindow: 128_000, inputLimit: 86_000 });
    statuses[1].status = 'needs_attention';
    expect(getModelPoolContextBudget(statuses)).toEqual({ contextWindow: 128_000, inputLimit: 86_000 });
  });

  it('does not invent limits before the host returns them', () => {
    expect(getModelPoolContextBudget(undefined)).toBeUndefined();
    expect(getModelPoolContextBudget([])).toBeUndefined();
    expect(getModelPoolContextBudget([{ modelId: 'old-host', status: 'available' }])).toBeUndefined();
  });
});
