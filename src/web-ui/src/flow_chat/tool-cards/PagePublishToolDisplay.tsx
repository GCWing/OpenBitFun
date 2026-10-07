import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * PagePublish tool card — shows publish slug / version / URLs.
 */
import React, { useCallback, useMemo } from 'react';
import { IconButton, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';

import type { ToolCardProps } from '../types/flow-chat';
import { PagePublishToolCard } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { pageAPI } from '@/infrastructure/api/service-api/PageAPI';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { notificationService } from '@/shared/notification-system';

async function openPage(slug: string, knownGeneration?: string, versionId?: string) {
  if (!slug) return;
  const generation = knownGeneration || (await pageAPI.listPages())
    .find((page) => page.slug === slug)?.generation;
  if (generation == null) throw new Error('Page no longer exists');
  const link = await pageAPI.createOpenLink(slug, generation, versionId);
  await systemAPI.openExternal(link.open_url);
}

export const PagePublishDisplay: React.FC<ToolCardProps> = ({ toolItem }) => {
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
    if (isParamsStreaming) return '';
    return (toolResult?.result?.version_id as string | undefined) || '';
  }, [isParamsStreaming, toolResult?.result]);
  const generation = toolResult?.result?.generation as string | undefined;

  const urlPath =
    (toolResult?.result?.url as string | undefined) ||
    (toolResult?.result?.url_path as string | undefined);
  const previewPath =
    (toolResult?.result?.preview_url as string | undefined) ||
    (toolResult?.result?.preview_url_path as string | undefined);
  const deployed = toolResult?.result?.deployed === true;
  const hasPreview = toolResult?.result?.deployed === false || Boolean(previewPath);
  const success = toolResult?.success === true;
  const isLoading = status === 'running' || status === 'streaming' || status === 'preparing';
  const isFailed =
    status === 'error' ||
    (status === 'completed' && toolResult != null && toolResult.success === false);

  const hasExpandableDetails =
    isFailed || (status === 'completed' && success && Boolean(slug || versionId));

  const toggleExpanded = useCallback(() => {
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, setIsExpanded]);

  const getErrorMessage = () => {
    if (toolResult && 'error' in toolResult && toolResult.error) {
      return String(toolResult.error);
    }
    return t('toolCards.pagePublish.publishFailed');
  };

  const commandText = useMemo(() => {
    if (isLoading) {
      return slug || t('toolCards.pagePublish.publishingShort');
    }
    return slug || t('toolCards.pagePublish.untitled');
  }, [isLoading, slug, t]);

  const fields = success ? [
    slug ? { label: `${t('toolCards.pagePublish.labelSlug')}:`, value: slug } : null,
    versionId ? { label: `${t('toolCards.pagePublish.labelVersion')}:`, value: versionId } : null,
    deployed && urlPath ? { label: `${t('toolCards.pagePublish.labelPath')}:`, value: urlPath } : null,
    !deployed && previewPath ? { label: `${t('toolCards.pagePublish.labelPreview')}:`, value: previewPath } : null,
  ].filter((field): field is NonNullable<typeof field> => Boolean(field)) : [];

  return (
    <div
      ref={cardRootRef}
      data-openbitfun-adapter="page-publish"
      data-testid="chat-page-publish-card"
      data-tool-card-id={toolId ?? ''}
      data-status={status}
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <PagePublishToolCard
        status={isFailed ? 'error' : status}
        isExpanded={isExpanded}
        onToggle={hasExpandableDetails ? toggleExpanded : undefined}
        action={status === 'completed' && success
          ? deployed ? t('toolCards.pagePublish.publishedTitle')
            : hasPreview ? t('toolCards.pagePublish.previewTitle') : t('toolCards.pagePublish.title')
          : t('toolCards.pagePublish.title')}
        preview={status === 'completed' && success && !deployed && hasPreview}
        subject={commandText}
        statusLabel={status === 'cancelled' ? t('toolCards.default.cancelled')
          : status === 'rejected' ? t('toolCards.default.rejected')
            : isFailed ? t('toolCards.default.failed') : undefined}
        version={versionId || undefined}
        loading={isLoading}
        fields={fields}
        error={isFailed ? getErrorMessage() : undefined}
        actions={success && !isFailed && status === 'completed' && slug ? (
          <>
            {deployed && urlPath && (
              <IconButton
                type="button"
                variant="quiet"
                size="sm"
                icon={<Icon name="arrow-up-right" size="sm" />}
                aria-label={t('toolCards.pagePublish.openProduction')}
                title={t('toolCards.pagePublish.openProduction')}
                data-testid="chat-page-publish-open-prod-btn"
                onClick={() => void openPage(slug, generation).catch(() => {
                  notificationService.error(t('toolCards.pagePublish.openFailed'));
                })}
              />
            )}
            {previewPath && versionId && (
              <IconButton
                type="button"
                variant="quiet"
                size="sm"
                icon={<Icon name="eye" size="sm" />}
                aria-label={t('toolCards.pagePublish.openPreview')}
                title={t('toolCards.pagePublish.openPreview')}
                data-testid="chat-page-publish-open-preview-btn"
                onClick={() => void openPage(slug, generation, versionId).catch(() => {
                  notificationService.error(t('toolCards.pagePublish.openFailed'));
                })}
              />
            )}
          </>
        ) : undefined}
      />
    </div>
  );
};
