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
import { pageAPI } from '@/infrastructure/api/service-api/PageAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { notificationService } from '@/shared/notification-system';

async function openPage(slug: string, knownGeneration?: string) {
  if (!slug) return;
  const generation = knownGeneration || (await pageAPI.listPages())
    .find((page) => page.slug === slug)?.generation;
  if (generation == null) throw new Error('Page no longer exists');
  const link = await pageAPI.createOpenLink(slug, generation);
  await systemAPI.openExternal(link.open_url);
}

export const PageDeployDisplay: React.FC<ToolCardProps> = ({ toolItem }) => {
  const { t } = useTranslation('flow-chat');
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
            title={t('toolCards.pageDeploy.openProduction')}
            data-testid="chat-page-deploy-open-btn"
            onClick={() => void openPage(slug, generation).catch(() => {
              notificationService.error(t('toolCards.pageDeploy.openFailed'));
            })}
          />
        ) : undefined}
      />
    </div>
  );
};
