import React, { useCallback } from 'react';
import { useToolCardDisclosure } from '../timeline/readerState';
import { useTranslation } from 'react-i18next';
import { ExecProcessPresentation, type ExecProcessCardModel } from '@openbitfun/flow-chat-presentation/exec';
import type { FlowToolItem, ToolCardDisplayContext } from '../types/flow-chat';
import { LazyTerminalOutputRenderer } from '@/tools/terminal/components/LazyTerminalOutputRenderer';
import { ToolCardCopyAction } from './ToolCardCopyAction';
import { ToolTimeoutIndicator } from './ToolTimeoutIndicator';
import { useCopyTextAction } from '../hooks/useCopyTextAction';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { getToolItemCardConfig } from './toolCardMetadata';
import { useFlowChatContext } from '../components/modern/FlowChatContext';

export type { ExecProcessCardModel } from '@openbitfun/flow-chat-presentation/exec';
interface ExecProcessToolCardViewProps {
  toolItem: FlowToolItem;
  model: ExecProcessCardModel;
  onExpand?: () => void;
  isLastItem?: boolean;
  displayContext?: ToolCardDisplayContext;
}

/** Host actions stay here; all card projection and disclosure live in the shared presenter. */
export const ExecProcessToolCardView: React.FC<ExecProcessToolCardViewProps> = ({
  toolItem,
  model,
  onExpand,
  displayContext,
}) => {
  const { t } = useTranslation('flow-chat');
  const [expanded, setExpanded] = useToolCardDisclosure('output');
  const { activeSessionOverride } = useFlowChatContext();
  const isSubagentSurface = displayContext === 'subagent-projection'
    || activeSessionOverride?.sessionKind === 'subagent';
  const { cardRootRef, dispatchToolCardToggle } = useToolCardHeightContract({
    toolId: toolItem.id,
    toolName: toolItem.toolName,
  });
  const onExpandedChange = useCallback((expanded: boolean) => {
    setExpanded(expanded);
    dispatchToolCardToggle();
    if (expanded) onExpand?.();
  }, [dispatchToolCardToggle, onExpand, setExpanded]);
  const { copied, copy } = useCopyTextAction({
    getText: () => model.copyText,
    successMessage: t('toolCards.execProcess.primaryCopied'),
    failureMessage: t('toolCards.execProcess.copyPrimaryFailed'),
    showSuccessNotification: false,
  });

  return (
    <ExecProcessPresentation
      expanded={expanded}
      toolItem={toolItem}
      model={model}
      attention={getToolItemCardConfig(toolItem).attention}
      // Embedded output remains compact while it streams; the presentation
      // still owns the explicit expand action and completion lifecycle.
      initialExpanded={isSubagentSurface ? false : undefined}
      t={t}
      rootRef={cardRootRef}
      onExpandedChange={onExpandedChange}
      primaryCopied={copied}
      onCopyPrimary={copy}
      renderOutput={({ ref, ...props }) => <LazyTerminalOutputRenderer {...props} ref={ref} />}
      renderOutputAction={(getText) => (
        <ToolCardCopyAction
          getText={getText}
          disabled={!getText().trim()}
          tooltip={t('toolCards.execProcess.copyOutput')}
          copiedTooltip={t('toolCards.execProcess.outputCopied')}
          successMessage={t('toolCards.execProcess.outputCopied')}
          failureMessage={t('toolCards.execProcess.copyOutputFailed')}
          ariaLabel={t('toolCards.execProcess.copyOutput')}
          showSuccessNotification={false}
        />
      )}
      renderStatus={(props) => <ToolTimeoutIndicator {...props} showIcon={false} />}
    />
  );
};

export default ExecProcessToolCardView;
