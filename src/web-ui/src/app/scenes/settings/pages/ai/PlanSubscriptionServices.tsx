import { Button } from '@openbitfun/ui';
import type { AIModelConfig } from '@/infrastructure/config/types';
import type { ModelPlanQuotaProvider } from '@/infrastructure/api/service-api/AIApi';
import { ConfigPageRow } from '@/infrastructure/config/components/common';
import { getProviderGroupKey, getProviderDisplayName } from '@/infrastructure/config/services/modelConfigs';
import { useI18n } from '@/infrastructure/i18n';
import { modelPlanQuotaKind } from './modelPlanQuota';
import { isPlanSubscriptionModel, PLAN_SUBSCRIPTION_SERVICES } from './planSubscriptions';
import { SubscriptionServiceGroup } from './SubscriptionServiceGroup';

export function PlanSubscriptionServices({ models, busy, onImport, onEdit }: {
  models: AIModelConfig[]; busy: boolean;
  onImport: (kind: ModelPlanQuotaProvider) => void; onEdit: (model: AIModelConfig) => void;
}) {
  const { t } = useI18n('settings/models');
  return <>{PLAN_SUBSCRIPTION_SERVICES.map(kind => {
    const connections = new Map<string, AIModelConfig>();
    for (const model of models) {
      const key = getProviderGroupKey(model);
      if (!connections.has(key) && isPlanSubscriptionModel(model) && modelPlanQuotaKind(model) === kind) connections.set(key, model);
    }
    return <SubscriptionServiceGroup key={kind} title={t(`subscriptionAuth.planServices.${kind}.name`)}
      description={t(`subscriptionAuth.planServices.${kind}.description`)} action={t('subscriptionAuth.import')}
      busy={busy} onAdd={() => onImport(kind)}>
      <div data-testid={`settings-plan-subscription-${kind}`}>
        {[...connections].map(([id, model]) => <ConfigPageRow key={id} label={getProviderDisplayName(model)} align="center">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onEdit(model)}>{t('actions.edit')}</Button>
        </ConfigPageRow>)}
      </div>
    </SubscriptionServiceGroup>;
  })}</>;
}
