/**
 * Skill tool display — compact row (same pattern as Read file).
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { OverflowText } from '@openbitfun/ui';
import {
  SkillToolCard,
  type FlowChatToolStatus,
} from '@openbitfun/ui/flow-chat';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export const SkillDisplay: React.FC<ToolCardProps> = React.memo(({ toolItem }) => {
  const { t } = useTranslation('flow-chat');
  const { toolCall, toolResult } = toolItem;
  const status = getToolCardStatus(toolItem);

  const loadedSkillName = useMemo(() => {
    if (!toolResult?.result) return null;
    const result = toolResult.result as Record<string, unknown>;
    return nonEmptyString(result.skill_name)
      || nonEmptyString(result.name)
      || t('toolCards.skill.unknownSkill');
  }, [toolResult?.result, t]);

  const commandName =
    (toolCall?.input?.command as string | undefined) ||
    (toolCall?.input?.skill_name as string | undefined) ||
    t('toolCards.skill.unknown');

  const displayName = status === 'completed' && loadedSkillName ? loadedSkillName : commandName;
  const isLoading = ['preparing', 'running', 'streaming', 'receiving'].includes(status);
  const progressMessage = isLoading
    ? nonEmptyString((toolItem as typeof toolItem & { _progressMessage?: unknown })._progressMessage)
    : undefined;
  const result = toolResult?.result as Record<string, unknown> | undefined;
  const resourceNote = status === 'completed'
    ? result?.resource_availability === 'markdown_only'
      ? t('toolCards.skill.markdownOnlyResources')
      : result?.resource_availability === 'remote_package'
        ? t('toolCards.skill.remotePackageResources')
        : undefined
    : undefined;
  const detail = progressMessage ?? resourceNote;

  return (
    <SkillToolCard
      status={status as FlowChatToolStatus}
      action={t('toolCards.skill.action')}
      summary={displayName}
      statusDescription={detail ?? getToolCardStatusDescription(status, t, toolResult?.error)}
      extra={detail ? (
        <span role={progressMessage ? 'status' : 'note'}><OverflowText>{detail}</OverflowText></span>
      ) : undefined}
    />
  );
});
