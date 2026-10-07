import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Tool card for GrepSearch text queries.
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { isToolCardVisible } from '../utils/flowItemVisibility';
import { GrepSearchToolCard } from '@openbitfun/ui/flow-chat';
import { projectGrepSearchResults } from '@openbitfun/flow-chat-presentation/search';
import { useToolCardHeightContract } from './useToolCardHeightContract';
export const GrepSearchDisplay: React.FC<ToolCardProps> = ({
  toolItem,
  onExpand
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const status = getToolCardStatus(toolItem);
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id ?? toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const getSearchPattern = (): string => {
    const pattern = toolCall?.input?.pattern || 
                   toolCall?.input?.search_pattern || 
                   toolCall?.input?.query ||
                   toolCall?.input?.text;
    
    if (!pattern) {
      const isEarlyDetection = toolCall?.input?._early_detection === true;
      const isPartialParams = toolCall?.input?._partial_params === true;
      
      if (isEarlyDetection || isPartialParams) {
        return t('toolCards.grepSearch.parsingPattern');
      }
      
      return t('toolCards.grepSearch.parsingPattern');
    }
    
    return pattern;
  };

  const getSearchPath = (): string => {
    return toolCall?.input?.path || t('toolCards.grepSearch.currentDirectory');
  };

  const stats = useMemo(() => {
    if (!toolResult?.result || typeof toolResult.result !== 'object') {
      return { matches: 0, files: 0 };
    }
    
    const fileCount = toolResult.result.file_count || 0;
    const totalMatches = toolResult.result.total_matches || 0;
    
    return {
      matches: totalMatches,
      files: fileCount
    };
  }, [toolResult]);

  const pattern = getSearchPattern();
  const searchPath = getSearchPath();
  const hasDetails = status === 'completed' && stats.matches > 0;
  const hasResultData = typeof toolResult?.result?.total_matches === 'number'
    && Number.isFinite(toolResult.result.total_matches) && toolResult.result.total_matches >= 0;

  const resultBlocks = useMemo(() => {
    if (!hasDetails || !toolResult?.result?.result) return undefined;
    return projectGrepSearchResults(String(toolResult.result.result), {
      outputMode: toolResult.result.output_mode ?? toolCall?.input?.output_mode,
      showLineNumbers: toolCall?.input?.['-n'],
      multiline: toolCall?.input?.multiline,
    });
  }, [hasDetails, toolCall?.input, toolResult?.result]);

  const handleClick = useCallback(() => {
    if (hasDetails) {
      applyExpandedState(isExpanded, !isExpanded, setIsExpanded, {
        onExpand,
      });
    }
  }, [applyExpandedState, hasDetails, isExpanded, onExpand, setIsExpanded]);

  if (!isToolCardVisible(toolItem)) {
    return null;
  }

  return (
    <div ref={cardRootRef} data-openbitfun-adapter="grep-search" data-tool-card-id={toolId ?? ''}>
      <GrepSearchToolCard
        action={t('toolCards.grepSearch.searchText')}
        status={status}
        isExpanded={isExpanded}
        onToggle={hasDetails ? handleClick : undefined}
        summary={pattern}
        resultSummary={status === 'completed' && hasResultData ? t('toolCards.grepSearch.matchesCount', { count: stats.matches }) : undefined}
        statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
        details={hasDetails ? [
          { label: `${t('toolCards.grepSearch.labelPattern')}:`, value: pattern },
          { label: `${t('toolCards.grepSearch.labelPath')}:`, value: searchPath },
          {
            label: `${t('toolCards.grepSearch.labelStats')}:`,
            value: t('toolCards.grepSearch.matchesAndFiles', { matches: stats.matches, files: stats.files }),
          },
        ] : undefined}
        resultBlocks={resultBlocks}
      />
    </div>
  );
};
