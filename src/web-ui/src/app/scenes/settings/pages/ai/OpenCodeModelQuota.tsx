import { useMemo } from 'react';
import { Button } from '@openbitfun/ui';
import { ConfigPageRow } from '@/infrastructure/config/components/common';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { isOpenCodeApiKeyConfig, isOpenCodeZenApiKeyConfig, openCodeApiKey } from '@/infrastructure/config/components/openCodeApiKeyRouting';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { useI18n } from '@/infrastructure/i18n';
import { SubscriptionQuotaPanel } from './SubscriptionQuotaPanel';

let observationEpoch = 0;

export function canReadSavedOpenCodeQuota(draft: Partial<AIModelConfig>, saved?: AIModelConfig): saved is AIModelConfig & { id: string } {
  return !!saved?.id && isOpenCodeApiKeyConfig(saved) && isOpenCodeApiKeyConfig(draft)
    && draft.id === saved.id && draft.base_url === saved.base_url
    && draft.api_key === saved.api_key
    && JSON.stringify(draft.custom_headers || {}) === JSON.stringify(saved.custom_headers || {});
}

export function OpenCodeModelQuota({ draft, saved, active, supported }: {
  draft: Partial<AIModelConfig>; saved?: AIModelConfig; active: boolean; supported: boolean;
}) {
  const { t } = useI18n('settings/models');
  // An opaque presentation epoch, never a credential value in state or DOM.
  const identity = useMemo(() => `model-quota-${++observationEpoch}`, [saved?.api_key, saved?.base_url, saved?.auth, saved?.custom_headers]);
  if (!isOpenCodeApiKeyConfig(draft)) return null;
  const zen = isOpenCodeZenApiKeyConfig(draft);
  if (!zen && canReadSavedOpenCodeQuota(draft, saved)) {
    return <SubscriptionQuotaPanel provider="opencode" accountId={`model:${saved.id}`} modelId={saved.id}
      identity={identity} active={active} supported={supported} compact />;
  }
  return <ConfigPageRow label={t('quota.title')} description={t(zen
    ? openCodeApiKey(draft) === 'public' ? 'quota.opencodePublic' : 'quota.opencodeBalanceUnavailable'
    : 'quota.saveBeforeQuery')} align="center" wide>
    <Button size="xs" variant="text" onClick={() => void systemAPI.openExternal('https://opencode.ai/console')}>
      {t('quota.openConsole')}
    </Button>
  </ConfigPageRow>;
}
