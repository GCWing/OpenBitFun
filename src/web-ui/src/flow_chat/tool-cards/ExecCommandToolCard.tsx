import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { ExecProcessToolCardView } from './ExecProcessToolCardView';
import { buildExecCommandCardModel } from './execProcessToolCardModel';

export const ExecCommandToolCard: React.FC<ToolCardProps> = ({
  toolItem,
  onExpand,
  isLastItem,
  displayContext,
}) => {
  const { t } = useTranslation('flow-chat');
  const model = useMemo(
    () => buildExecCommandCardModel(toolItem, t),
    [t, toolItem],
  );

  return (
    <ExecProcessToolCardView
      toolItem={toolItem}
      model={model}
      onExpand={onExpand}
      isLastItem={isLastItem}
      displayContext={displayContext}
    />
  );
};

export default ExecCommandToolCard;
