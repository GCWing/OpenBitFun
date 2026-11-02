import React, { useMemo } from 'react';
import {
  ImageAnalysisToolCard,
  ToolCardDisclosure,
  ToolCardFields,
  ToolCardSection,
  ToolCardText,
  type SemanticToolCardProps,
  type ToolCardField,
} from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { useToolCardDisclosure } from '../timeline/readerState';
import type { ToolCardProps } from '../types/flow-chat';
import { buildBuiltinToolCardModel } from './builtinToolCardModel';
import { getToolCardStatusDescription } from './toolCardStatus';
import { useToolCardHeightContract } from './useToolCardHeightContract';

/**
 * Generated images and request metadata stay inside one collapsible result
 * card. The compact header is the default presentation in the transcript.
 */
export const GenerateImageToolCard: React.FC<ToolCardProps> = ({ toolItem, onExpand }) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const [isExpanded, setExpanded] = useToolCardDisclosure('isExpanded', false);
  const model = useMemo(
    () => buildBuiltinToolCardModel(toolItem, 'generate_image', t, formatNumber),
    [toolItem, t, formatNumber],
  );
  const { cardRootRef, applyExpandedState, dispatchToolCardToggle } = useToolCardHeightContract({
    toolId: toolItem.id,
    toolName: toolItem.toolName,
  });

  const fields: ToolCardField[] = model.fields.map(({ label, value }) => ({ label, value }));
  const metadata = fields.length > 0 || model.sections.length > 0 ? (
    <ToolCardDisclosure
      defaultOpen={false}
      onOpenChange={dispatchToolCardToggle}
      summary={t('toolCards.common.viewDetails')}
    >
      {fields.length > 0 && <ToolCardFields fields={fields} />}
      {model.sections.map(section => (
        <ToolCardSection key={section.key} label={section.label}>
          <ToolCardText variant={section.variant ?? 'prose'}>{section.content}</ToolCardText>
        </ToolCardSection>
      ))}
    </ToolCardDisclosure>
  ) : undefined;
  const media = model.imageSources.length > 0 || metadata ? (
    <div data-generate-image-content>
      {model.imageSources.map((source, index) => (
        <img
          key={`${toolItem.id}-${index}`}
          src={source}
          alt={model.summary ?? model.action}
          loading="lazy"
          onLoad={dispatchToolCardToggle}
        />
      ))}
      {metadata}
    </div>
  ) : undefined;

  const card: SemanticToolCardProps = {
    status: model.status,
    action: model.action,
    attention: model.attention,
    // Keep the full prompt in the closed metadata disclosure instead of the
    // always-visible header summary.
    summary: undefined,
    resultSummary: model.resultSummary,
    outcome: model.outcome,
    emptyContent: model.emptyContent,
    error: model.error,
    media,
    detailsAvailable: Boolean(media || model.rawResult !== undefined),
    isExpanded,
    onToggle: () => applyExpandedState(isExpanded, !isExpanded, setExpanded, { onExpand }),
    statusDescription: getToolCardStatusDescription(model.status, t, model.error),
  };

  return (
    <div
      ref={cardRootRef}
      data-openbitfun-adapter="generate-image"
      data-tool-card-id={toolItem.id}
      data-tool-card-kind="generate-image"
    >
      <ImageAnalysisToolCard {...card} />
    </div>
  );
};
