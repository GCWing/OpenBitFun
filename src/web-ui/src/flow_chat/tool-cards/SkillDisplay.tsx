/**
 * Skill tool display — compact row (same pattern as Read file).
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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

  return (
    <SkillToolCard
      status={status as FlowChatToolStatus}
      action={t('toolCards.skill.action')}
      summary={displayName}
      statusDescription={getToolCardStatusDescription(status, t, toolResult?.error)}
    />
  );
});
