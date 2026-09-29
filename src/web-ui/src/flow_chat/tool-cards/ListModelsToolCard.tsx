import { useToolCardDisclosure } from '../timeline/readerState';
import React, { useMemo } from 'react';
import { ListModelsToolCard as ListModelsToolCardView } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { ToolCardProps } from '../types/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { getToolCardStatusDescription } from './toolCardStatus';
import { buildListModelsCardModel, formatRuntimeToolValue, runtimeToolNeedsConfirmation } from './runtimeToolCardModel';

export const ListModelsToolCard: React.FC<ToolCardProps> = ({ toolItem, onExpand }) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const [isExpanded, setExpanded] = useToolCardDisclosure('isExpanded');
  const model = useMemo(() => buildListModelsCardModel(toolItem), [toolItem]);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({ toolId: toolItem.id, toolName: 'ListModels' });
  const needsConfirmation = runtimeToolNeedsConfirmation(toolItem, model.status);
  const fallback = model.fallback !== undefined || Boolean(toolItem.toolResult?.resultForAssistant && !model.hasModelList);
  return <div ref={cardRootRef} data-openbitfun-adapter="list-models" data-tool-card-id={toolItem.id}>
    <ListModelsToolCardView status={model.status} action={t('toolCards.listModels.title')}
      summary={model.query || t('toolCards.listModels.models')}
      resultSummary={model.status === 'completed' && model.hasModelList
        ? t('toolCards.listModels.count', { value: formatNumber(model.models.length) }) : undefined}
      statusDescription={getToolCardStatusDescription(needsConfirmation ? 'pending_confirmation' : model.status, t, model.error)}
      models={model.models} modelsLabel={t('toolCards.listModels.models')} modelIdLabel={t('toolCards.listModels.modelId')}
      query={model.query} queryLabel={t('toolCards.listModels.query')}
      emptyContent={model.empty ? (model.query ? t('toolCards.listModels.noMatches') : t('toolCards.listModels.noModels')) : undefined}
      hasResult={fallback}
      resultText={fallback ? (isExpanded ? formatRuntimeToolValue(model.fallback) ?? toolItem.toolResult?.resultForAssistant : '') : undefined}
      error={model.status === 'error' ? model.error ?? t('toolCards.listModels.failed') : undefined}
      requiresConfirmation={needsConfirmation} isExpanded={isExpanded}
      onToggle={() => applyExpandedState(isExpanded, !isExpanded, setExpanded, { onExpand })} />
  </div>;
};
