import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Compact tool card for web_search.
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { isToolCardVisible } from '../utils/flowItemVisibility';
import { systemAPI } from '../../infrastructure/api';
import { WebSearchToolCard } from '@openbitfun/ui/flow-chat';
import { createLogger } from '@/shared/utils/logger';
import { useToolCardHeightContract } from './useToolCardHeightContract';

const log = createLogger('WebSearchCard');

export const WebSearchCard: React.FC<ToolCardProps> = ({
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

  const getSearchTerm = () => {
    const searchTerm = toolCall?.input?.search_term || toolCall?.input?.query;
    
    if (!searchTerm) {
      return t('toolCards.webSearch.parsingSearchTerm');
    }
    
    return searchTerm;
  };

  const searchResults = useMemo(() => {
    if (!toolResult?.result) return null;
    
    const result = toolResult.result;
    
    if (result.results && Array.isArray(result.results)) {
      return {
        results: result.results,
        summary: result.summary || result.content,
        total: result.results.length
      };
    }
    
    if (result.content) {
      return {
        results: [],
        summary: result.content,
        total: 0
      };
    }
    
    return null;
  }, [toolResult]);

  const handleOpenLink = async (url: string) => {
    if (url && url !== '#') {
      try {
        await systemAPI.openExternal(url);
      } catch (error) {
        log.error('Failed to open external URL', { url, error });
      }
    }
  };

  const searchTerm = getSearchTerm();
  const hasResultCount = Array.isArray(toolResult?.result?.results);
  const hasResults = searchResults && searchResults.results.length > 0;
  const hasSummary = !hasResults && searchResults && searchResults.summary;
  const isExpandable = status === 'completed' && (hasResults || hasSummary);

  const handleClick = useCallback(() => {
    if (isExpandable) {
      applyExpandedState(isExpanded, !isExpanded, setIsExpanded, {
        onExpand,
      });
    }
  }, [applyExpandedState, isExpandable, isExpanded, onExpand, setIsExpanded]);

  if (!isToolCardVisible(toolItem)) {
    return null;
  }

  return (
    <div ref={cardRootRef} data-openbitfun-adapter="web-search" data-tool-card-id={toolId ?? ''}>
      <WebSearchToolCard
        action={t('toolCards.webSearch.action')}
        status={status}
        isExpanded={isExpanded}
        onToggle={isExpandable ? handleClick : undefined}
        summary={searchTerm}
        resultSummary={status === 'completed' && hasResultCount
          ? t('toolCards.webSearch.resultsCount', { count: searchResults?.total ?? 0 }) : undefined}
        statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
        results={hasResults ? searchResults?.results.map((result: any, index: number) => ({
          description: result.snippet,
          icon: 'link' as const,
          key: `${result.url || result.title}-${index}`,
          onOpen: result.url ? () => void handleOpenLink(result.url) : undefined,
          title: result.title || t('toolCards.webSearch.noTitle'),
          url: result.url,
        })) : undefined}
        resultText={hasSummary ? String(searchResults!.summary) : undefined}
      />
    </div>
  );
};
