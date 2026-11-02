import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { ExecProcessToolCardView } from './ExecProcessToolCardView';
import { buildWriteStdinCardModel } from './execProcessToolCardModel';
import { useCurrentToolSessionParticipant } from './useToolSessionParticipant';

export const WriteStdinToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  onExpand,
  isLastItem,
  sessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const source = useCurrentToolSessionParticipant(sessionId, t);
  const model = useMemo(
    () => {
      const model = buildWriteStdinCardModel(toolItem, t);
      return { ...model, interaction: model.interaction ? { ...model.interaction, source } : undefined };
    },
    [t, toolItem, source],
  );

  return (
    <ExecProcessToolCardView
      toolItem={toolItem}
      model={model}
      onExpand={onExpand}
      isLastItem={isLastItem}
    />
  );
};

export default WriteStdinToolCard;
