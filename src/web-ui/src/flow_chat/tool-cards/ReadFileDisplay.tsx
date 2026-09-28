/**
 * Compact display for the read_file tool.
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { isToolCardVisible } from '../utils/flowItemVisibility';
import { ReadFileToolCard } from '@openbitfun/ui/flow-chat';
import { i18nService } from '@/infrastructure/i18n';

export const ReadFileDisplay: React.FC<ToolCardProps> = React.memo(({
  toolItem,
  onOpenInEditor,
}) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult, requiresConfirmation, userConfirmed } = toolItem;
  const status = getToolCardStatus(toolItem);

  const filePath = useMemo(() => {
    const path = toolCall?.input?.file_path || toolCall?.input?.target_file || toolCall?.input?.path;
    
    if (!path) {
      const isEarlyDetection = toolCall?.input?._early_detection === true;
      const isPartialParams = toolCall?.input?._partial_params === true;
      
      if (isEarlyDetection || isPartialParams) {
        return t('toolCards.readFile.parsingParams');
      }
      
      return t('toolCards.readFile.parsingParams');
    }
    
    return path;
  }, [t, toolCall?.input]);

  const handleOpenInEditor = () => {
    if (filePath !== t('toolCards.readFile.noFileSpecified') && filePath !== t('toolCards.readFile.parsingParams')) {
      onOpenInEditor?.(filePath);
    }
  };

  const fileName = useMemo(() => {
    if (!filePath || filePath === t('toolCards.readFile.noFileSpecified') || filePath === t('toolCards.readFile.parsingParams')) {
      return filePath || t('toolCards.readFile.noFileSpecified');
    }
    return filePath.split(/[/\\]/).pop() || filePath;
  }, [filePath, t]);

  const permissionTargetPath = useMemo(() => {
    const rawInput = toolItem.acpPermission?.toolCall?.rawInput as Record<string, unknown> | undefined;
    const acpFilePath =
      typeof rawInput?.filepath === 'string' && rawInput.filepath.trim().length > 0
        ? rawInput.filepath
        : typeof rawInput?.filePath === 'string' && rawInput.filePath.trim().length > 0
          ? rawInput.filePath
          : typeof rawInput?.parentDir === 'string' && rawInput.parentDir.trim().length > 0
            ? rawInput.parentDir
            : null;

    if (acpFilePath) {
      return acpFilePath;
    }

    return filePath;
  }, [filePath, toolItem.acpPermission?.toolCall?.rawInput]);

  const lineRange = useMemo(() => {
    // Keep legacy `start_line` so older persisted tool calls still render.
    const offset = toolCall?.input?.offset ?? toolCall?.input?.start_line;
    const tail = toolCall?.input?.tail === true;
    const limit = toolCall?.input?.limit;
    
    if (tail && limit !== undefined) {
      return t('toolCards.readFile.tailLines', { count: limit, formattedCount: i18nService.formatNumber(limit) });
    }

    if (offset !== undefined || limit !== undefined) {
      const startLine = offset || 1;
      const endLine = limit ? startLine + limit - 1 : undefined;
      
      if (endLine) {
        return t('toolCards.readFile.lineRange', { start: i18nService.formatNumber(startLine), end: i18nService.formatNumber(endLine) });
      } else if (startLine > 1) {
        return t('toolCards.readFile.fromLine', { start: i18nService.formatNumber(startLine) });
      }
    }
    
    return null;
  }, [t, toolCall?.input?.offset, toolCall?.input?.start_line, toolCall?.input?.tail, toolCall?.input?.limit]);

  const canOpenFile = status === 'completed' && Boolean(onOpenInEditor) && filePath !== t('toolCards.readFile.noFileSpecified') && filePath !== t('toolCards.readFile.parsingParams');
  const showConfirmationActions = Boolean(
    requiresConfirmation &&
    !userConfirmed &&
    status !== 'completed' &&
    status !== 'cancelled' &&
    status !== 'rejected' &&
    status !== 'error'
  );

  if (!isToolCardVisible(toolItem)) {
    return null;
  }

  const requestingPermission = showConfirmationActions || status === 'pending_confirmation';
  const subject = requestingPermission ? permissionTargetPath : fileName;

  return (
    <ReadFileToolCard
      accessibleLabel={`${t('toolCards.readFile.readFile')}: ${filePath}${lineRange ? ` · ${lineRange}` : ''}`}
      title={filePath}
      action={t(requestingPermission ? 'toolCards.readFile.permissionRequest' : 'toolCards.readFile.readFile')}
      content={`${subject}${lineRange ? ` · ${lineRange}` : ''}`}
      statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
      status={status}
      interactive={canOpenFile}
      onOpen={canOpenFile ? handleOpenInEditor : undefined}
    />
  );
});
