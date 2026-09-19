import React, { useEffect, useMemo, useState } from 'react';
import { Button, Icon, OverflowText } from '@openbitfun/ui';
import {
  AmbientToolCard, AmbientToolCardHeader, ProminentToolCard, ProminentToolCardSummary, ToolCardStatusSlot,
} from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { ToolCardProps } from '../types/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { useOpenBitFunControlDiscovery } from './useOpenBitFunControlDiscovery';
import {
  buildOpenBitFunControlCardModel, controlDescription, controlTitle, isOpenBitFunControlDiscovery,
} from './openBitFunControlCardModel';
import './OpenBitFunControlToolCard.scss';

export const OpenBitFunControlToolCard: React.FC<ToolCardProps> = ({ toolItem, onExpand }) => {
  const { t, currentLanguage, formatNumber } = useI18n('flow-chat');
  const [isExpanded, setExpanded] = useState(false);
  const [localCapability, setLocalCapability] = useState<unknown>();
  const model = useMemo(() => buildOpenBitFunControlCardModel(toolItem, currentLanguage, localCapability),
    [toolItem, currentLanguage, localCapability]);
  const discovery = useOpenBitFunControlDiscovery(toolItem, model, isExpanded);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId: toolItem.id, toolName: toolItem.toolName,
  });

  useEffect(() => {
    if (!model.capabilityId) return;
    let active = true;
    // Reuse the product catalog for labels only, and keep it out of the initial chat bundle.
    void import('@/app/global-search/interactiveCapabilityCatalog').then(({ getInteractiveCapability }) => {
      if (active) setLocalCapability(getInteractiveCapability(model.capabilityId!));
    }).catch(() => {
      // Older/remote capabilities and unavailable label chunks remain readable by their IDs.
      if (active) setLocalCapability(undefined);
    });
    return () => { active = false; };
  }, [model.capabilityId]);

  const actionLabels = {
    list: t('toolCards.openBitFunControl.actions.list'),
    search: t('toolCards.openBitFunControl.actions.search'),
    get: t('toolCards.openBitFunControl.actions.get'),
    open: t('toolCards.openBitFunControl.actions.open'),
    execute: t('toolCards.openBitFunControl.actions.execute'),
    configure: t('toolCards.openBitFunControl.actions.configure'),
  };
  const actionLabel = model.action ? actionLabels[model.action] : t('toolCards.openBitFunControl.actions.unknown');
  const valueText = (value: unknown): string => {
    if (value === undefined) return t('toolCards.openBitFunControl.noValue');
    if (value === null) return t('toolCards.openBitFunControl.nullValue');
    if (typeof value === 'boolean') return value ? t('toolCards.openBitFunControl.trueValue') : t('toolCards.openBitFunControl.falseValue');
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'string') return value || t('toolCards.openBitFunControl.emptyValue');
    return JSON.stringify(value, null, 2);
  };
  const waitingForApproval = model.status === 'pending_confirmation' || Boolean(
    toolItem.requiresConfirmation && !toolItem.userConfirmed
    && !['completed', 'error', 'cancelled', 'rejected'].includes(model.status),
  );
  const summary = [actionLabel, model.query ?? model.target].filter(Boolean).join(' · ');
  const icon = <Icon name="settings" size="sm" />;
  const statusIcon = (model.status === 'completed' && !model.confirmed) || waitingForApproval
    ? icon
    : <ToolCardStatusSlot status={model.status === 'confirmed' ? 'preparing' : model.status} toolIcon={icon} />;
  const fields = [
    model.target && { label: t('toolCards.openBitFunControl.target'), value: model.target },
    model.query && { label: t('toolCards.openBitFunControl.query'), value: model.query },
    model.action === 'configure' && model.requestedValue !== undefined && {
      label: t('toolCards.openBitFunControl.requestedValue'), value: valueText(model.requestedValue),
    },
    model.confirmed && model.effectiveValue !== undefined && {
      label: t('toolCards.openBitFunControl.effectiveValue'), value: valueText(model.effectiveValue),
    },
    ...model.currentValues.map(item => ({ label: item.label, value: valueText(item.value) })),
  ].filter((field): field is { label: string; value: string } => Boolean(field));
  const description = controlDescription(model.capability, currentLanguage);
  const hasDiscoveryResults = model.confirmed && (model.action === 'list' || model.action === 'search');
  const hasAvailabilityNotice = model.action === 'get' && Boolean(model.availability) && model.availability !== 'available';
  const hasDetails = Boolean(model.failed || description || fields.length || hasAvailabilityNotice || model.syncPending || hasDiscoveryResults);
  const toggle = () => applyExpandedState(isExpanded, !isExpanded, setExpanded, { onExpand });
  const details = (
    <div className="openbitfun-control-card__details" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="details">
      {model.failed && <p className="openbitfun-control-card__error" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="error">{model.error || t('toolCards.default.failed')}</p>}
      {description && <p className="openbitfun-control-card__description" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="description">{description}</p>}
      {fields.length > 0 && <dl className="openbitfun-control-card__fields" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="fields">
        {fields.map((field, index) => <div className="openbitfun-control-card__field" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="field" key={index}>
          <dt data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="label">{field.label}</dt>
          <dd data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="value">{field.value}</dd>
        </div>)}
      </dl>}
      {hasAvailabilityNotice && (
        <p className="openbitfun-control-card__notice" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="notice">
          {t('toolCards.openBitFunControl.controlUnavailable')}{model.availabilityReason && ` · ${model.availabilityReason}`}
        </p>
      )}
      {model.syncPending && <p className="openbitfun-control-card__notice" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="notice">
        {t('toolCards.openBitFunControl.syncPendingDetails')}{model.syncReason && ` · ${model.syncReason}`}
      </p>}
      {hasDiscoveryResults && (
        <div className="openbitfun-control-card__results" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="results">
          {discovery.items.length === 0 ? (!discovery.loading && !discovery.error && <p data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="description">{t('toolCards.openBitFunControl.noResults')}</p>) : (
            <ul className="openbitfun-control-card__list" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="list">
              {discovery.items.map((item, index) => <li className="openbitfun-control-card__result" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="result" key={index} data-overflow-trigger>
                <OverflowText>{controlTitle(item, currentLanguage) ?? String(item.capabilityId ?? item.id ?? '')}</OverflowText>
                {controlDescription(item, currentLanguage) && <p data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="description">{controlDescription(item, currentLanguage)}</p>}
              </li>)}
            </ul>
          )}
          {discovery.loading && <p role="status" className="openbitfun-control-card__description" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="description">
            {t('toolCards.openBitFunControl.loadingAll')}
          </p>}
          {discovery.error && <>
            <p role="status" className="openbitfun-control-card__notice" data-openbitfun-component="openbitfun-control-tool-card" data-openbitfun-part="notice">
              {discovery.error === 'catalog-changed' ? t('toolCards.openBitFunControl.catalogChanged')
                : discovery.error === 'surface-changed' ? t('toolCards.openBitFunControl.sourceDeviceRequired')
                  : t('toolCards.openBitFunControl.loadAllFailed')}
            </p>
            {discovery.error === 'load-failed' && <Button variant="text" size="sm" onClick={discovery.retry}>
              {t('toolCards.openBitFunControl.retryLoad')}
            </Button>}
          </>}
        </div>
      )}
    </div>
  );
  const common = {
    'data-openbitfun-tool-card': 'openbitfun-control',
    status: model.status,
    isExpanded: isExpanded && hasDetails,
    expandedContent: hasDetails ? details : undefined,
  };

  return <div ref={cardRootRef} data-openbitfun-adapter="openbitfun-control" data-tool-card-id={toolItem.id}>
    {isOpenBitFunControlDiscovery(model.input) ? (
      <AmbientToolCard {...common} onClick={hasDetails ? toggle : undefined}
        header={<AmbientToolCardHeader action={t('toolCards.openBitFunControl.title')} content={summary}
          icon={statusIcon} />} />
    ) : (
      <ProminentToolCard {...common} allowExpandedWhenFailed onToggle={hasDetails ? toggle : undefined} requiresConfirmation={waitingForApproval}
        summary={<ProminentToolCardSummary action={t('toolCards.openBitFunControl.title')} content={summary}
          icon={statusIcon} />} />
    )}
  </div>;
};
