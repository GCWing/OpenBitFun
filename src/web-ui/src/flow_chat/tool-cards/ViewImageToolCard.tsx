import { useToolCardDisclosure } from '../timeline/readerState';
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { ViewImageToolCard as ViewImageToolCardView } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

interface ViewImageResult {
  path: string | null;
  width: number | null;
  height: number | null;
}

function parseResult(result: unknown): ViewImageResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { path: null, width: null, height: null };
  }

  const value = result as Record<string, unknown>;
  return {
    path: typeof value.path === 'string' && value.path.trim() ? value.path : null,
    width: typeof value.width === 'number' && value.width > 0 ? value.width : null,
    height: typeof value.height === 'number' && value.height > 0 ? value.height : null,
  };
}

function imageSource(toolItem: ToolCardProps['toolItem']): string | null {
  const attachment = toolItem.toolResult?.imageAttachments?.[0];
  if (!attachment) return null;

  const mimeType = attachment.mime_type?.toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) || !attachment.data_base64) return null;

  return `data:${mimeType};base64,${attachment.data_base64}`;
}

function fileName(path: string | null): string {
  if (!path) return 'view_image';
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export const ViewImageToolCard: React.FC<ToolCardProps> = ({ toolItem, onExpand }) => {
  const { t } = useI18n('flow-chat');
  const status = getToolCardStatus(toolItem);
  const result = useMemo(() => parseResult(toolItem.toolResult?.result), [toolItem.toolResult?.result]);
  const source = useMemo(() => imageSource(toolItem), [toolItem]);
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const toolId = toolItem.id ?? toolItem.toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  useEffect(() => {
    setImageFailed(false);
  }, [source]);

  const handleToggle = () => {
    if (!source) return;
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded, { onExpand });
  };

  const path = result.path
    ?? (typeof toolItem.toolCall?.input?.path === 'string' ? toolItem.toolCall.input.path : null);
  const title = fileName(path);
  const imageCount = toolItem.toolResult?.imageAttachments?.length;
  return (
    <div data-openbitfun-adapter="view-image" ref={cardRootRef} data-tool-card-id={toolId ?? ''}>
      <ViewImageToolCardView
        status={status}
        isExpanded={isExpanded}
        onToggle={source ? handleToggle : undefined}
        alt={title}
        source={source ?? undefined}
        width={result.width ?? undefined}
        height={result.height ?? undefined}
        action={t('toolCards.viewImage.title')}
        statusText={path ? title : undefined}
        resultSummary={status === 'completed' && imageCount && imageCount > 1
          ? t('toolCards.viewImage.imagesCount', { count: imageCount }) : undefined}
        statusDescription={getToolCardStatusDescription(status, t, toolItem.toolResult?.error)}
        previewLabel={t('toolCards.common.viewDetails')}
        imageFailed={imageFailed}
        errorText={t('toolCards.default.failed')}
        onImageError={() => setImageFailed(true)}
        onOpenPreview={(event) => {
          event.stopPropagation();
          setIsLightboxOpen(true);
        }}
        lightboxOpen={isLightboxOpen}
        lightboxTitle={title}
        onLightboxClose={() => setIsLightboxOpen(false)}
      />
    </div>
  );
};
