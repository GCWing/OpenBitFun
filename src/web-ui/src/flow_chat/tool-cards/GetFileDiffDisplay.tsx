import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Display component for the GetFileDiff tool.
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { FileDiffToolCard } from '@openbitfun/ui/flow-chat';
import { InlineDiffPreview } from '../components/InlineDiffPreview';
import { createLogger } from '@/shared/utils/logger';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { i18nService } from '@/infrastructure/i18n';

const log = createLogger('GetFileDiffDisplay');

interface GetFileDiffResult {
  file_path?: string;
  diff_type?: 'baseline' | 'git' | 'full';
  diff_format?: string;
  diff_content?: string;
  original_content?: string;
  modified_content?: string;
  git_ref?: string;
  stats?: {
    additions?: number;
    deletions?: number;
    total_lines?: number;
  };
  message?: string;
}

export const GetFileDiffDisplay: React.FC<ToolCardProps> = React.memo(({
  toolItem,
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, status } = toolItem;
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const resultData = useMemo((): GetFileDiffResult | null => {
    if (!toolResult?.result) return null;
    
    try {
      if (typeof toolResult.result === 'string') {
        return JSON.parse(toolResult.result);
      }
      return toolResult.result as GetFileDiffResult;
    } catch (e) {
      log.error('Failed to parse GetFileDiff result', e);
      return null;
    }
  }, [toolResult]);

  const filePath = useMemo(() => {
    if (resultData?.file_path) {
      return resultData.file_path;
    }
    const path = toolCall?.input?.file_path;
    
    if (!path) {
      const isEarlyDetection = toolCall?.input?._early_detection === true;
      const isPartialParams = toolCall?.input?._partial_params === true;
      
      if (isEarlyDetection || isPartialParams) {
        return t('toolCards.readFile.parsingParams');
      }
      
      return t('toolCards.readFile.parsingParams');
    }
    
    return path;
  }, [toolCall?.input, resultData, t]);

  const fileName = useMemo(() => {
    if (!filePath || filePath === t('toolCards.readFile.parsingParams')) {
      return filePath || '';
    }
    return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
  }, [filePath, t]);

  const stats = useMemo(() => {
    return resultData?.stats || null;
  }, [resultData]);

  const hasDiffContent = useMemo(() => {
    return resultData && (resultData.original_content || resultData.modified_content || resultData.diff_content);
  }, [resultData]);

  const toggleExpanded = useCallback(() => {
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, setIsExpanded]);

  const handleCardClick = useCallback(() => {
    if (status === 'error' || (hasDiffContent && status === 'completed')) {
      toggleExpanded();
    }
  }, [hasDiffContent, status, toggleExpanded]);

  const isFailed = status === 'error';

  const getActionText = () => {
    if (isFailed) {
      return t('toolCards.getFileDiff.failed');
    }
    if (status === 'running' || status === 'streaming') {
      return t('toolCards.getFileDiff.gettingDiff');
    }
    if (status === 'pending' || status === 'preparing') {
      return t('toolCards.getFileDiff.preparing');
    }
    return t('toolCards.getFileDiff.diffFile');
  };

  const inlinePreview = resultData?.original_content !== undefined && resultData.modified_content !== undefined
    ? (
        <InlineDiffPreview
          originalContent={resultData.original_content}
          modifiedContent={resultData.modified_content}
          filePath={filePath}
          maxHeight={400}
          showLineNumbers={true}
          lineNumberMode="single"
          showPrefix={false}
          contextLines={-1}
        />
      )
    : undefined;
  const textPreview = resultData?.diff_type === 'full' && resultData.modified_content
    ? resultData.modified_content
    : resultData?.diff_content;
  const showChangeSummary =
    !isFailed &&
    status === 'completed' &&
    (stats?.additions !== undefined || stats?.deletions !== undefined);
  const formattedAdditions = i18nService.formatNumber(stats?.additions ?? 0);
  const formattedDeletions = i18nService.formatNumber(stats?.deletions ?? 0);

  return (
    <div data-openbitfun-adapter="get-file-diff" ref={cardRootRef} data-tool-card-id={toolId ?? ''}>
      <FileDiffToolCard
        data-diff-type={resultData?.diff_type}
        status={status}
        isExpanded={isExpanded}
        onToggle={isFailed || (hasDiffContent && status === 'completed') ? handleCardClick : undefined}
        action={`${getActionText()}:`}
        path={filePath}
        pathLabel={fileName}
        changeSummary={showChangeSummary ? {
          additions: formattedAdditions,
          deletions: formattedDeletions,
          label: t('toolCards.file.changeSummary', {
            additions: formattedAdditions,
            deletions: formattedDeletions,
          }),
        } : undefined}
        loading={status === 'running' || status === 'streaming' || status === 'preparing'}
        message={resultData?.message}
        preview={inlinePreview}
        textPreview={textPreview}
        error={isFailed ? toolResult?.error || t('toolCards.getFileDiff.failed') : undefined}
      />
    </div>
  );
});
