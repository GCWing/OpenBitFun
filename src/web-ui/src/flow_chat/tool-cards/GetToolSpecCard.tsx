import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { GetToolSpecToolCard } from '@openbitfun/ui/flow-chat';

interface ParsedGetToolSpecResult {
  toolName: string;
}

function parseGetToolSpecResult(toolItem: ToolCardProps['toolItem']): ParsedGetToolSpecResult | null {
  const result = toolItem.toolResult?.result;
  const toolName = result?.tool_name || toolItem.toolCall?.input?.tool_name || '';

  if (!toolName && !result) {
    return null;
  }

  return {
    toolName,
  };
}

export const GetToolSpecCard: React.FC<ToolCardProps> = ({ toolItem }) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const status = getToolCardStatus(toolItem);
  const toolId = toolItem.id ?? toolCall?.id;

  const parsedResult = useMemo(() => parseGetToolSpecResult(toolItem), [toolItem]);
  const targetToolName = parsedResult?.toolName || toolCall?.input?.tool_name || t('toolCards.getToolSpec.unknownTool');
  const errorMessage = toolResult?.error || t('toolCards.getToolSpec.readFailed');

  return (
    <GetToolSpecToolCard
      action={t('toolCards.getToolSpec.title')}
      data-tool-card-id={toolId ?? ''}
      status={status}
      summary={targetToolName}
      statusDescription={getToolCardStatusDescription(status, t, errorMessage)}
    />
  );
};
