import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { ExecProcessToolCardView } from './ExecProcessToolCardView';
import { buildExecControlCardModel } from './execProcessToolCardModel';
import { useCurrentToolSessionParticipant } from './useToolSessionParticipant';

export const ExecControlToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  sessionId,
  onExpand,
  isLastItem,
}) => {
  const { t } = useTranslation('flow-chat');
  const source = useCurrentToolSessionParticipant(sessionId, t);
  const model = useMemo(
    () => {
      const model = buildExecControlCardModel(toolItem, t);
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

export default ExecControlToolCard;
