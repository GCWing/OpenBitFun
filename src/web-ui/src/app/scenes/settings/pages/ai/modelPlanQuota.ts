import type { AIModelConfig } from '@/infrastructure/config/types';
import type { ModelPlanQuotaProvider } from '@/infrastructure/api/service-api/AIApi';

export function modelPlanQuotaKind(model: Partial<AIModelConfig>): ModelPlanQuotaProvider | null {
  if (model.auth && model.auth.type !== 'api_key') return null;
  try {
    const u = new URL(model.base_url || '');
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash) return null;
    const path = u.pathname.replace(/\/+$/, '');
    if (['api.minimaxi.com', 'api.minimax.io'].includes(u.hostname) && ['', '/v1', '/anthropic'].includes(path)) return 'minimax';
    if (['api.kimi.com', 'api.kimi.ai'].includes(u.hostname) && ['/coding', '/coding/v1'].includes(path)) return 'kimi_code';
    if (['api.stepfun.com', 'api.stepfun.ai'].includes(u.hostname) && ['', '/v1', '/step_plan/v1'].includes(path)) return 'stepfun';
  } catch { /* An incomplete draft has no billing endpoint. */ }
  return null;
}

export function canReadSavedPlanQuota(draft: Partial<AIModelConfig>, saved?: AIModelConfig): saved is AIModelConfig & { id: string } {
  return !!saved?.id && !!modelPlanQuotaKind(saved) && modelPlanQuotaKind(saved) === modelPlanQuotaKind(draft)
    && draft.id === saved.id && draft.base_url === saved.base_url && draft.api_key === saved.api_key
    && JSON.stringify(draft.custom_headers || {}) === JSON.stringify(saved.custom_headers || {})
    && draft.custom_headers_mode === saved.custom_headers_mode;
}
