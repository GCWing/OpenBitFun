import { useId, useState, useSyncExternalStore } from 'react';
import { Button, Icon, MenuItem, MenuList, OverflowText } from '@openbitfun/ui';
import { TriangleAlert, Wallet } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import type { AIModelConfig } from '../types';
import { compareModelCosts, getModelBilling, isModelBillingCurrent } from '../services/modelBilling';
import { ModelBillingDetails } from './ModelBillingDetails';
import './ModelBilling.scss';

interface Props {
  primary?: AIModelConfig;
  fast?: AIModelConfig;
  selected?: AIModelConfig;
  disabled?: boolean;
  compact?: boolean;
  secondaryRole?: 'fast' | 'economy';
  onSaved: () => void;
}

export function ModelBillingSummary({ primary, fast, selected, disabled, compact = false, secondaryRole = 'fast', onSaved }: Props) {
  const { t, formatNumber } = useI18n('settings/models');
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const [editing, setEditing] = useState<{ model: AIModelConfig; epoch: number } | null>(null);
  const comparison = compareModelCosts(primary, fast);
  const economy = secondaryRole === 'economy';
  const compactStatus = comparison.status === 'fastHigher' ? t(economy ? 'billing.compactEconomyHigher' : 'billing.compactHigher')
    : comparison.status === 'currency' ? t('billing.compactCurrency')
      : comparison.status === 'comparable' ? t('billing.compactComparable') : t('billing.compactUnknown');
  const models = [...new Map([primary, fast, selected].filter((m): m is AIModelConfig => Boolean(m?.id)).map(m => [m.id, m])).values()];
  const label = (model: AIModelConfig) => {
    const billing = getModelBilling(model);
    if (!billing) return t('billing.unknown');
    if (!isModelBillingCurrent(model, billing)) return t('billing.reviewRequired');
    if (billing.kind === 'subscription') return t('billing.subscription');
    if (billing.kind === 'api') return t('billing.api');
    return t('billing.unknown');
  };
  return <div className="model-billing" data-compact={compact} data-comparison={comparison.status} data-testid="model-billing-summary" data-openbitfun-component="model-billing" data-openbitfun-part="root">
    {compact ? <MenuList><MenuItem data-testid="model-billing-toggle" aria-label={t('billing.details')} aria-describedby={summaryId}
      aria-expanded={expanded} onClick={() => setExpanded(!expanded)} labelBehavior="static"
      leading={<Icon glyph={comparison.status === 'fastHigher' ? TriangleAlert : Wallet} />}
      metadata={<Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />}>
      <span className="model-billing__compact-summary" data-openbitfun-component="model-billing" data-openbitfun-part="compactSummary">
        <span>{t('billing.title')}</span><span id={summaryId} className="model-billing__compact-status" role="status">{compactStatus}</span>
      </span>
    </MenuItem></MenuList> : <div className="model-billing__heading"><strong>{t('billing.title')}</strong>
      <Button data-testid="model-billing-toggle" size="sm" variant="text" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t('billing.details')}</Button>
    </div>}
    {(!compact || expanded) && <><p className={comparison.status === 'fastHigher' ? 'model-billing__warning' : 'model-billing__hint'} role="status">
      {comparison.status === 'fastHigher' ? t(economy ? 'billing.economyHigher' : 'billing.fastHigher')
        : comparison.status === 'currency' ? t('billing.currencyMismatch')
          : comparison.status === 'comparable' ? t('billing.comparable') : t(economy ? 'billing.economyIncomplete' : 'billing.incomplete')}
    </p>
    {comparison.status !== 'unknown' && comparison.status !== 'currency' && <p className="model-billing__hint">
      {t(economy ? 'billing.economyEstimate' : 'billing.estimate', {
        primary: `${comparison.currency} ${formatNumber(comparison.primaryCost, { maximumFractionDigits: 6 })}`,
        fast: `${comparison.currency} ${formatNumber(comparison.fastCost, { maximumFractionDigits: 6 })}`,
      })}
    </p>}</>}
    {expanded && <div className="model-billing__details">
      {models.map(model => <div className="model-billing__row" key={model.id}>
        <span className="model-billing__identity"><OverflowText>{model.model_name}</OverflowText><small>{model.name} · {label(model)}</small></span>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => setEditing({ model, epoch: scope.epoch })}>{t('billing.edit')}</Button>
      </div>)}
      <p className="model-billing__hint">{t('billing.noPolicy')}</p>
      {models.some(model => model.auth?.type === 'subscription_pool' || model.channel_routing) && <p className="model-billing__hint">{t('billing.routingScopeHint')}</p>}
    </div>}
    {editing?.epoch === scope.epoch && <ModelBillingDetails key={editing.model.id} model={editing.model} onClose={() => setEditing(null)} onSaved={onSaved} />}
  </div>;
}
