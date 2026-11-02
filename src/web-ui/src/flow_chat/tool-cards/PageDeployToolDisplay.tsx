import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * PageDeploy tool card — shows deploy slug / version result.
 */
import React, { useCallback, useMemo } from 'react';
import { IconButton, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';

import type { ToolCardProps } from '../types/flow-chat';
import { PageDeployToolCard } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { usePageToolOpen } from './usePageToolOpen';

export const PageDeployDisplay: React.FC<ToolCardProps> = ({ toolItem, sessionId }) => {
  const { t } = useTranslation('flow-chat');
  const { canOpen, openPage, unavailableReason } = usePageToolOpen(sessionId);
  const { status, toolResult, partialParams, isParamsStreaming, toolCall } = toolItem;
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');

  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const slug = useMemo(() => {
    if (isParamsStreaming) return (partialParams?.slug as string | undefined) || '';
    return (
      (toolCall?.input as Record<string, unknown> | undefined)?.slug as string | undefined
    ) || '';
  }, [isParamsStreaming, partialParams, toolCall?.input]);

  const versionId = useMemo(() => {
    if (isParamsStreaming) return (partialParams?.version_id as string | undefined) || '';
    return (
      (toolCall?.input as Record<string, unknown> | undefined)?.version_id as
        | string
        | undefined
    ) || '';
  }, [isParamsStreaming, partialParams, toolCall?.input]);

  const deployedVersion =
    (toolResult?.result?.deployed_version_id as string | undefined) || versionId;
  const generation = toolResult?.result?.generation as string | undefined;
  const urlPath =
    (toolResult?.result?.url as string | undefined) ||
    (toolResult?.result?.url_path as string | undefined);
  const success = toolResult?.success === true;
  const isLoading = status === 'running' || status === 'streaming' || status === 'preparing';
  const isFailed =
    status === 'error' ||
    (status === 'completed' && toolResult != null && toolResult.success === false);

  const hasExpandableDetails =
    isFailed || (status === 'completed' && success && Boolean(slug || deployedVersion));

  const toggleExpanded = useCallback(() => {
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, setIsExpanded]);

  const getErrorMessage = () => {
    if (toolResult && 'error' in toolResult && toolResult.error) {
      return String(toolResult.error);
    }
    return t('toolCards.pageDeploy.deployFailed');
  };

  const commandText = useMemo(() => {
    if (isLoading) {
      return slug || t('toolCards.pageDeploy.deployingShort');
    }
    return slug || t('toolCards.pageDeploy.untitled');
  }, [isLoading, slug, t]);

  const fields = success ? [
    slug ? { label: `${t('toolCards.pageDeploy.labelSlug')}:`, value: slug } : null,
    deployedVersion ? { label: `${t('toolCards.pageDeploy.labelVersion')}:`, value: deployedVersion } : null,
    urlPath ? { label: `${t('toolCards.pageDeploy.labelPath')}:`, value: urlPath } : null,
  ].filter((field): field is NonNullable<typeof field> => Boolean(field)) : [];

  return (
    <div
      ref={cardRootRef}
      data-openbitfun-adapter="page-deploy"
      data-testid="chat-page-deploy-card"
      data-tool-card-id={toolId ?? ''}
      data-status={status}
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <PageDeployToolCard
        status={isFailed ? 'error' : status}
        isExpanded={isExpanded}
        onToggle={hasExpandableDetails ? toggleExpanded : undefined}
        action={status === 'completed' && success
          ? t('toolCards.pageDeploy.deployedTitle') : t('toolCards.pageDeploy.title')}
        subject={commandText}
        statusLabel={status === 'cancelled' ? t('toolCards.default.cancelled')
          : status === 'rejected' ? t('toolCards.default.rejected')
            : isFailed ? t('toolCards.default.failed') : undefined}
        version={deployedVersion || undefined}
        loading={isLoading}
        fields={fields}
        error={isFailed ? getErrorMessage() : undefined}
        actions={success && !isFailed && status === 'completed' && slug && urlPath ? (
          <IconButton
            type="button"
            variant="quiet"
            size="sm"
            icon={<Icon name="arrow-up-right" size="sm" />}
            aria-label={t('toolCards.pageDeploy.openProduction')}
            disabled={!canOpen}
            title={!canOpen ? unavailableReason : t('toolCards.pageDeploy.openProduction')}
            data-testid="chat-page-deploy-open-btn"
            onClick={() => void openPage(slug, generation)}
          />
        ) : undefined}
      />
    </div>
  );
};
