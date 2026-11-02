import { useState } from 'react';
import { Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Field, Input, Select } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { configManager } from '../services/ConfigManager';
import type { AIModelConfig } from '../types';
import { subscriptionProviderOf } from './modelRouting';
import { MODEL_BILLING_KEY, getModelBilling, isModelBillingCurrent, modelBillingBinding, updateModelBilling, type ModelBilling, type ModelBillingKind } from '../services/modelBilling';
import './ModelBilling.scss';

interface Props {
  model: AIModelConfig;
  onClose: () => void;
  onSaved: () => void;
}

/** A user-entered quote for this configuration. No account or rate inference. */
export function ModelBillingDetails({ model, onClose, onSaved }: Props) {
  const { t, formatDate } = useI18n('settings/models');
  const [scope] = useState(getActiveSurfaceScope);
  const [original] = useState(model);
  const [saved] = useState(() => getModelBilling(model));
  const unsupported = original.metadata?.[MODEL_BILLING_KEY] != null && !saved;
  const [kind, setKind] = useState<ModelBillingKind>(saved?.kind ?? 'unknown');
  const [currency, setCurrency] = useState<'CNY' | 'USD'>(saved?.currency ?? 'CNY');
  const [input, setInput] = useState(saved?.input?.toString() ?? '');
  const [output, setOutput] = useState(saved?.output?.toString() ?? '');
  const [cacheRead, setCacheRead] = useState(saved?.cacheRead?.toString() ?? '');
  const [source, setSource] = useState(saved?.source ?? '');
  const [account, setAccount] = useState(saved?.account ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const invalidRate = (value: string) => value.trim() !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0);
  const invalid = kind === 'api' && [input, output, cacheRead].some(invalidRate);
  const readRate = (value: string) => value.trim() === '' ? undefined : Number(value);
  const save = async () => {
    if (saving || invalid || unsupported || !scope.isCurrent()) return;
    setSaving(true);
    setError(false);
    const billing: ModelBilling = {
      version: 1, kind, currency, source: source.trim(), account: account.trim(),
      ...(kind === 'api' ? { input: readRate(input), output: readRate(output), cacheRead: readRate(cacheRead) } : {}),
      updatedAt: new Date().toISOString(), binding: modelBillingBinding(original),
    };
    try {
      await configManager.updateConfig<AIModelConfig[]>('ai.models', models => updateModelBilling(models, original, billing));
      if (!scope.isCurrent()) return;
      onSaved();
      onClose();
    } catch {
      if (scope.isCurrent()) setError(true);
    } finally {
      if (scope.isCurrent()) setSaving(false);
    }
  };
  const priceField = (label: string, value: string, change: (value: string) => void) => (
    <Field label={label} controlWidth="fill">
      <Input type="number" min="0" step="any" size="sm" value={value} onValueChange={change}
        disabled={saving} invalid={invalidRate(value)} placeholder={t('billing.unknown')} />
    </Field>
  );
  return <Dialog open size="md" closeOnEscape={!saving} closeOnPointerOutside={false} onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogHeader><DialogHeading><DialogTitle>{t('billing.details')}</DialogTitle></DialogHeading><DialogClose disabled={saving} /></DialogHeader>
    <DialogBody>
      <div className="model-billing__editor" data-testid="model-billing-editor" data-openbitfun-component="model-billing" data-openbitfun-part="editor">
        <div className="model-billing__identity">
          <strong className="model-billing__model-title">{model.model_name} · {model.name}</strong>
          <p className="model-billing__hint">{t('billing.quoteHint')}</p>
          {(model.auth?.type === 'subscription_pool' || model.channel_routing) && <p className="model-billing__hint">{t('billing.routingScopeHint')}</p>}
        </div>
        {unsupported && <p className="model-billing__warning" role="alert">{t('billing.unsupported')}</p>}
        {saved && !isModelBillingCurrent(model, saved) && <p className="model-billing__warning" role="status">{t('billing.stale')}</p>}
        <Field label={t('billing.method')} controlWidth="fill"
          description={subscriptionProviderOf(model.auth) ? t('billing.subscriptionAuthHint') : t('billing.apiAuthHint')}>
          <Select aria-label={t('billing.method')} size="sm" value={kind} disabled={saving || unsupported} onValueChange={value => setKind(value as ModelBillingKind)} options={[
            { value: 'unknown', label: t('billing.unknown') },
            { value: 'api', label: t('billing.api') },
            { value: 'subscription', label: t('billing.subscription') },
          ]} />
        </Field>
        <Field label={t('billing.account')} controlWidth="fill">
          <Input size="sm" value={account} disabled={saving} onValueChange={setAccount} placeholder={t('billing.accountPlaceholder')} maxLength={120} />
        </Field>
        {kind === 'api' && <>
          <Field label={t('billing.currency')} description={t('billing.rateUnit')} controlWidth="fill">
            <Select aria-label={t('billing.currency')} size="sm" value={currency} disabled={saving} onValueChange={value => setCurrency(value as 'CNY' | 'USD')}
              options={[{ value: 'CNY', label: 'CNY' }, { value: 'USD', label: 'USD' }]} />
          </Field>
          {priceField(t('billing.input'), input, setInput)}
          {priceField(t('billing.output'), output, setOutput)}
          {priceField(t('billing.cacheRead'), cacheRead, setCacheRead)}
        </>}
        {kind === 'subscription' && <p className="model-billing__hint">{t('billing.quotaUnknown')}</p>}
        <Field label={t('billing.source')} controlWidth="fill">
          <Input size="sm" value={source} disabled={saving} onValueChange={setSource} maxLength={500} placeholder={t('billing.sourcePlaceholder')} />
        </Field>
        {saved && <p className="model-billing__hint">{t('billing.updated', { date: formatDate(new Date(saved.updatedAt)) })}</p>}
        {error && <p role="alert" className="model-billing__warning">{t('billing.saveFailed')}</p>}
      </div>
    </DialogBody>
    <DialogFooter separator>
      <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>{t('billing.cancel')}</Button>
      <Button size="sm" variant="primary" loading={saving} disabled={invalid || unsupported || !scope.isCurrent()} onClick={() => void save()}>{t('billing.save')}</Button>
    </DialogFooter>
  </Dialog>;
}
