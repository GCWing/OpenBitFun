import type { AIModelConfig } from '@/infrastructure/config/types';
import { isOpenCodeApiKeyConfig } from '@/infrastructure/config/components/openCodeApiKeyRouting';

export function canReadSavedOpenCodeQuota(draft: Partial<AIModelConfig>, saved?: AIModelConfig): saved is AIModelConfig & { id: string } {
  return !!saved?.id && isOpenCodeApiKeyConfig(saved) && isOpenCodeApiKeyConfig(draft)
    && draft.id === saved.id && draft.base_url === saved.base_url
    && draft.api_key === saved.api_key
    && JSON.stringify(draft.custom_headers || {}) === JSON.stringify(saved.custom_headers || {});
}
