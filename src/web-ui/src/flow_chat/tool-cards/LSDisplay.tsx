import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Display component for the LS tool.
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { isToolCardVisible } from '../utils/flowItemVisibility';
import { DirectoryListToolCard } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
interface LSEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified_time: string;
}

export const LSDisplay: React.FC<ToolCardProps> = ({
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

  const getDirectoryPath = (): string => {
    const path = toolCall?.input?.path;
    
    if (!path) {
      const isEarlyDetection = toolCall?.input?._early_detection === true;
      const isPartialParams = toolCall?.input?._partial_params === true;
      
      if (isEarlyDetection || isPartialParams) {
        return t('toolCards.ls.parsingPath');
      }
      
      return t('toolCards.ls.parsingPath');
    }
    
    return path;
  };

  const entries = useMemo((): LSEntry[] => {
    if (!toolResult?.result) return [];
    
    const parsedResult = toolResult.result;
    
    if (parsedResult.entries && Array.isArray(parsedResult.entries)) {
      return parsedResult.entries;
    }
    
    return [];
  }, [toolResult]);

  const stats = useMemo(() => {
    if (entries.length === 0) return { files: 0, directories: 0, total: 0 };
    
    let fileCount = 0;
    let dirCount = 0;
    
    entries.forEach((entry: LSEntry) => {
      if (entry.is_dir) {
        dirCount++;
      } else {
        fileCount++;
      }
    });
    
    return {
      files: fileCount,
      directories: dirCount,
      total: entries.length
    };
  }, [entries]);

  const directoryPath = getDirectoryPath();
  const hasDetails = status === 'completed' && entries.length > 0;
  const hasResultData = Array.isArray(toolResult?.result?.entries);

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
    <div ref={cardRootRef} data-openbitfun-adapter="directory-list" data-tool-card-id={toolId ?? ''}>
      <DirectoryListToolCard
        action={t('toolCards.ls.listDirectory')}
        status={status}
        isExpanded={isExpanded}
        onToggle={hasDetails ? handleClick : undefined}
        summary={directoryPath}
        resultSummary={status === 'completed' && hasResultData ? t('toolCards.ls.entriesCount', { count: stats.total }) : undefined}
        statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
        details={hasDetails ? [
          { label: `${t('toolCards.ls.labelPath')}:`, value: directoryPath },
          {
            label: `${t('toolCards.ls.labelStats')}:`,
            value: stats.directories > 0
              ? t('toolCards.ls.filesAndDirs', { files: stats.files, directories: stats.directories })
              : t('toolCards.ls.filesCount', { count: stats.files }),
          },
          { label: `${t('toolCards.ls.labelSort')}:`, value: t('toolCards.ls.sortByModifiedTime') },
        ] : undefined}
        results={hasDetails ? entries.slice(0, 50).map((entry, index) => ({
          icon: entry.is_dir ? 'directory' as const : 'file' as const,
          key: `${entry.path || entry.name}-${index}`,
          meta: entry.modified_time,
          title: entry.name,
        })) : undefined}
        moreResultsLabel={entries.length > 50
          ? t('toolCards.ls.moreEntries', { count: entries.length - 50 })
          : undefined}
      />
    </div>
  );
};
