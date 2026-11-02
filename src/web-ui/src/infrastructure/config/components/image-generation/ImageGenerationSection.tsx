import './ImageGenerationSection.scss';
import { Button, Capsule, Card, CardFooter, CardHeader, Combobox, Icon, IconButton, OverflowText, StatusPill, Tooltip } from '@openbitfun/ui';
import { ConfigPageRow, ConfigRetryState } from '../common';
import { useI18n } from '@/infrastructure/i18n';
import type { ReactNode } from 'react';
import ImageGenerationEditor from './ImageGenerationEditor';
import type { ImageGenerationSettings } from './useImageGenerationSettings';
import type { ImageServiceConfig } from '../../types';
import { findImageDialectPreset } from './imageDialects';
import { imageModelLabel } from './imageModels';

type Props = { settings: ImageGenerationSettings };

export function ImageGenerationAcquisitionRow({ settings }: Props) {
  const { t } = useI18n('settings/media');
  const { t: tModels } = useI18n('settings/models');
  return <ConfigPageRow multiline className="openbitfun-model-settings__acquisition-row"
    label={<div className="openbitfun-model-settings__import-row">
      <div className="openbitfun-model-settings__import-heading"><span>{t('acquisition.label')}</span>
        <span className="openbitfun-model-settings__pool-caption">{t('acquisition.description')}</span></div>
      <Button size="sm" leadingIcon={<Icon name="plus" size="sm" />} onClick={settings.openCreate}
        disabled={settings.loading || settings.loadError || settings.saving || Boolean(settings.testingId)} data-testid="image-service-add">{t('acquisition.add')}</Button>
    </div>}>
    {settings.loadError ? <ConfigRetryState message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => void settings.load()} />
      : settings.media.image_services.length > 0 ? <ul className="openbitfun-model-settings__import-summary" aria-label={t('acquisition.label')}>
        {settings.media.image_services.map(service => <li key={service.id} className="openbitfun-model-settings__import-item">
          <Capsule size="sm" action={<Tooltip content={t('actions.delete')}>
            <IconButton className="openbitfun-model-settings__source-pill-delete" size="xs" shape="circle" variant="quiet" tone="danger" icon={<Icon name="delete" size="xs" />}
              aria-label={t('acquisition.remove', { name: service.name || service.model_name })} disabled={settings.saving || Boolean(settings.testingId)}
              onClick={() => void settings.remove(service)} />
          </Tooltip>}>
            <Button size="sm" variant="outline" className="openbitfun-model-settings__source-pill"
              onClick={() => settings.openEdit(service)} disabled={settings.saving || Boolean(settings.testingId)}>{imageModelLabel(service)}</Button>
          </Capsule>
        </li>)}
      </ul> : <span className="openbitfun-model-settings__pool-caption" role="status">
        {settings.loading ? tModels('messages.loading') : t('acquisition.empty')}
      </span>}
  </ConfigPageRow>;
}

export function ImageGenerationDefaultSlot({ settings }: Props) {
  const { t } = useI18n('settings/media');
  const { t: tDefault } = useI18n('settings/default-model');
  const enabled = settings.media.image_services.filter(service => service.enabled);
  const options = [
    ...enabled.map(service => ({ label: imageModelLabel(service), value: service.id })),
    ...settings.configuredModels.map(model => ({ label: `${model.name || model.model_name} · ${model.model_name}`, value: `configured:${model.id}` })),
  ];
  if (settings.selectedId && !options.some(option => option.value === settings.selectedId)) {
    options.push({ label: t('default.unavailable'), value: settings.selectedId });
  }
  return <ConfigPageRow multiline align="center" label={<span className="default-model-config__slot-label-content">
    <span>{tDefault('optional.capabilities.image_generation.label')}</span>
    <Tooltip content={t('default.description')} placement="top" trigger="hover-focus" openOnClick>
      <IconButton size="xs" variant="annotation" aria-label={t('default.description')} icon={<Icon name="info" size="xs" />} />
    </Tooltip>
  </span>}>
    <Combobox size="sm" aria-label={tDefault('optional.capabilities.image_generation.label')} data-testid="image-service-default-select"
      value={settings.selectedId} options={options} placeholder={t('default.placeholder')}
      disabled={settings.loading || settings.loadError || settings.saving || Boolean(settings.testingId) || enabled.length + settings.configuredModels.length === 0}
      onValueChange={value => void settings.selectDefault(String(Array.isArray(value) ? value[0] ?? '' : value))} />
  </ConfigPageRow>;
}

export function ImageGenerationModelCard({ settings, service, actions }: Props & { service: ImageServiceConfig; actions: ReactNode }) {
  const { t } = useI18n('settings/media');
  const label = imageModelLabel(service);
  return <div className="openbitfun-model-settings__pool-item" data-openbitfun-component="model-settings"
    data-openbitfun-part="modelItem" data-openbitfun-state={!service.enabled ? 'disabled' : undefined}
    data-testid="settings-image-model-row" data-model-id={service.id}>
    <Card appearance="subtle" padding="md" gap="sm" className="openbitfun-model-settings__pool-card">
      <CardHeader className="openbitfun-model-settings__pool-card-header" contentAlign="start" title={
        <div className="openbitfun-model-settings__pool-card-title"><OverflowText>{label}</OverflowText>
        </div>} description={
          <div className="openbitfun-model-settings__pool-tags"><StatusPill tone="neutral">{t('title')}</StatusPill>
            {settings.selectedId === service.id && <StatusPill tone="neutral">{t('card.defaultBadge')}</StatusPill>}
          </div>} />
      <CardFooter align="between" className="openbitfun-model-settings__pool-card-footer">
        <OverflowText className="openbitfun-model-settings__pool-card-source">{t(findImageDialectPreset(service.dialect).labelKey)}</OverflowText>
        {actions}
      </CardFooter>
    </Card>
  </div>;
}

export function ImageGenerationDialogs({ settings }: Props) {
  return <ImageGenerationEditor key={settings.scopeEpoch} open={Boolean(settings.editor)} initial={settings.editor?.initial ?? null}
    credentials={settings.credentials} services={settings.media.image_services} onClose={settings.closeEditor} onSubmit={settings.saveService} />;
}
