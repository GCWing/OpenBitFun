import { useToolCardDisclosure } from '../timeline/readerState';
/**
 * Tool card for GlobSearch file matching.
 */

import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { isToolCardVisible } from '../utils/flowItemVisibility';
import { GlobSearchToolCard } from '@openbitfun/ui/flow-chat';
import { basenamePath } from "@/shared/utils/pathUtils";
import { useToolCardHeightContract } from './useToolCardHeightContract';
export const GlobSearchDisplay: React.FC<ToolCardProps> = ({
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
                   toolCall?.input?.glob_pattern || 
                   toolCall?.input?.file_pattern;
    
    if (!pattern) {
      const isEarlyDetection = toolCall?.input?._early_detection === true;
      const isPartialParams = toolCall?.input?._partial_params === true;
      
      if (isEarlyDetection || isPartialParams) {
        return t('toolCards.globSearch.parsingPattern');
      }
      
      return t('toolCards.globSearch.parsingPattern');
    }
    
    return pattern;
  };

  const getSearchPath = (): string => {
    return toolCall?.input?.path || toolCall?.input?.target_directory || t('toolCards.globSearch.currentDirectory');
  };

  const files = useMemo(() => {
    if (!toolResult?.result) return [];
    
    const parsedResult = toolResult.result;
    
    if (Array.isArray(parsedResult)) {
      return parsedResult;
    }
    if (parsedResult.files && Array.isArray(parsedResult.files)) {
      return parsedResult.files;
    }
    if (parsedResult.matches && Array.isArray(parsedResult.matches)) {
      return parsedResult.matches;
    }
    
    return [];
  }, [toolResult]);

  const stats = useMemo(() => {
    if (files.length === 0) return { files: 0, directories: 0 };
    
    let fileCount = 0;
    let dirCount = 0;
    
    files.forEach((file: any) => {
      const fileName = typeof file === 'string' ? file : (file.name || file.path || '');
      if (fileName.includes('/') && fileName.endsWith('/')) {
        dirCount++;
      } else {
        fileCount++;
      }
    });
    
    return {
      files: fileCount,
      directories: dirCount
    };
  }, [files]);

  const pattern = getSearchPattern();
  const searchPath = getSearchPath();
  const hasDetails = status === 'completed' && files.length > 0;
  const hasResultData = Array.isArray(toolResult?.result)
    || Array.isArray(toolResult?.result?.files) || Array.isArray(toolResult?.result?.matches);

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
    <div ref={cardRootRef} data-openbitfun-adapter="glob-search" data-tool-card-id={toolId ?? ''}>
      <GlobSearchToolCard
        action={t('toolCards.globSearch.searchFile')}
        status={status}
        isExpanded={isExpanded}
        onToggle={hasDetails ? handleClick : undefined}
        summary={pattern}
        resultSummary={status === 'completed' && hasResultData ? t('toolCards.globSearch.filesCount', { count: stats.files }) : undefined}
        statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
        details={hasDetails ? [
          { label: `${t('toolCards.globSearch.labelPattern')}:`, value: pattern },
          { label: `${t('toolCards.globSearch.labelPath')}:`, value: searchPath },
          {
            label: `${t('toolCards.globSearch.labelStats')}:`,
            value: stats.directories > 0
              ? t('toolCards.globSearch.filesAndDirs', { files: stats.files, directories: stats.directories })
              : t('toolCards.globSearch.filesCount', { count: stats.files }),
          },
        ] : undefined}
        results={hasDetails ? files.slice(0, 50).map((file: any, index: number) => {
          const fileName = typeof file === 'string' ? file : (file.name || file.path || '');
          const normalizedPath = fileName.replace(/\\/g, '/').replace(/\/$/, '');
          const basename = basenamePath(normalizedPath);
          const parent = normalizedPath.slice(0, Math.max(0, normalizedPath.length - basename.length)).replace(/\/$/, '');
          return {
            icon: fileName.endsWith('/') ? 'directory' as const : 'file' as const,
            key: `${fileName}-${index}`,
            title: basename || fileName,
            description: parent || undefined,
          };
        }) : undefined}
        moreResultsLabel={files.length > 50
          ? t('toolCards.globSearch.moreFiles', { count: files.length - 50 })
          : undefined}
      />
    </div>
  );
};
