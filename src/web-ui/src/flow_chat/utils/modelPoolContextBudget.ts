import type { ModelPoolContextBudget, ModelPoolMemberStatus } from '@/infrastructure/api/service-api/ModelPoolAPI';

/** Aggregate host-resolved limits, including members in cooldown or offline. */
export function getModelPoolContextBudget(statuses?: ModelPoolMemberStatus[]): ModelPoolContextBudget | undefined {
  return statuses?.reduce<ModelPoolContextBudget | undefined>((budget, member) => {
    const next = member.contextBudget;
    if (!next) return budget;
    return budget ? {
      contextWindow: Math.min(budget.contextWindow, next.contextWindow),
      inputLimit: Math.min(budget.inputLimit, next.inputLimit),
    } : next;
  }, undefined);
}
