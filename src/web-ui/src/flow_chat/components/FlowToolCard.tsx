/**
 * Streaming tool card component.
 * Renders a dedicated card based on tool type.
 */

import React from 'react';
import { FlowChatCardReaderProvider } from '../timeline/readerState';
import { ToolCapsulePresentationProvider } from '@openbitfun/ui/flow-chat';
import { getToolCardComponent } from '../tool-cards';
import { getToolItemCardConfig, isToolCapsule } from '../tool-cards/toolCardMetadata';
import { getToolCapsuleSummary, toolCapsuleStateKey } from '../tool-cards/toolCapsuleModel';
import { ToolCapsuleRecord } from '../tool-cards/ToolCapsuleRecord';
import { useToolCardHeightContract } from '../tool-cards/useToolCardHeightContract';
import type { FlowToolItem, ToolCardDisplayContext, ToolRejectOptions } from '../types/flow-chat';
import { createLogger } from '@/shared/utils/logger';
import { FlowToolCardErrorBoundary } from './FlowToolCardErrorBoundary';
import { useI18n } from '@/infrastructure/i18n';
import { getToolInterruptionNote } from '../utils/toolInterruption';
import { ToolApprovalBar } from './ToolApprovalBar';
import { projectEffectiveToolItem } from '../utils/toolInvocationIdentity';
import { isToolCardVisible } from '../utils/flowItemVisibility';
import { useFlowChatContext, useFlowChatVolatileContext } from './modern/FlowChatContext';
import './FlowToolCard.scss';

const log = createLogger('FlowToolCard');

interface FlowToolCardProps {
  toolItem: FlowToolItem;
  onConfirm?: (toolId: string, permissionOptionId?: string, approve?: boolean) => void;
  onReject?: (toolId: string, options?: ToolRejectOptions) => void;
  onOpenInEditor?: (filePath: string) => void;
  onOpenInPanel?: (panelType: string, data: any) => void;
  onExpand?: (toolId: string) => void;
  sessionId?: string;
  turnId?: string;
  className?: string;
  displayContext?: ToolCardDisplayContext;
  isLastItem?: boolean;
  /** Set by transcript composition only when execution timing supports a shared row. */
  parallel?: boolean;
}

export const FlowToolCard: React.FC<FlowToolCardProps> = React.memo(({
  toolItem,
  onConfirm,
  onReject,
  onOpenInEditor,
  onOpenInPanel,
  onExpand,
  sessionId,
  turnId,
  className = '',
  displayContext = 'default',
  isLastItem,
  parallel = false,
}) => {
  const { t, formatNumber } = useI18n('flow-chat');
  const projectedToolItem = projectEffectiveToolItem(toolItem);
  const effectiveToolItem = isToolCapsule(projectedToolItem.toolName)
    && projectedToolItem.status === 'completed' && projectedToolItem.toolResult?.success === false
    ? { ...projectedToolItem, status: 'error' as const } : projectedToolItem;
  const { pendingPermissionToolCallIds, expandedToolCapsules } = useFlowChatVolatileContext();
  const { onToolCapsuleExpandedChange } = useFlowChatContext();
  const [localExpanded, setLocalExpanded] = React.useState(false);
  const capsuleKey = toolCapsuleStateKey(sessionId, turnId, toolItem.id);
  const capsuleExpanded = expandedToolCapsules && onToolCapsuleExpandedChange
    ? expandedToolCapsules.has(capsuleKey) : localExpanded;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({ toolId: toolItem.id, toolName: effectiveToolItem.toolName });
  const config = getToolItemCardConfig(effectiveToolItem);
  const CardComponent = getToolCardComponent(effectiveToolItem.toolName);
  const interruptionNote = getToolInterruptionNote(effectiveToolItem, t);
  const cardHandlesInterruptionNote = effectiveToolItem.toolName === 'Task';
  const toolCardTestId =
    effectiveToolItem.toolName === 'ExecCommand'
      ? 'chat-shell-tool-card'
      : effectiveToolItem.toolName === 'WebFetch'
        ? 'chat-browser-tool-card'
        : undefined;
  const permissionPending =
    effectiveToolItem.status === 'pending_confirmation' ||
    (effectiveToolItem.requiresConfirmation === true && !effectiveToolItem.userConfirmed && !['completed', 'error', 'cancelled', 'rejected'].includes(effectiveToolItem.status)) ||
    pendingPermissionToolCallIds?.has(toolItem.toolCall.id) === true;
  const capsuleEligible = isToolCapsule(effectiveToolItem.toolName) && !permissionPending;
  const staticAgentWaitCapsule = capsuleEligible && effectiveToolItem.toolName === 'AgentWait';

  const handleConfirm = React.useCallback((permissionOptionId?: string, approve?: boolean) => {
    log.debug('handleConfirm called', {
      toolId: toolItem.id,
      toolName: effectiveToolItem.toolName,
      hasPermissionOption: Boolean(permissionOptionId),
      approve
    });
    onConfirm?.(toolItem.id, permissionOptionId, approve);
  }, [effectiveToolItem.toolName, toolItem.id, onConfirm]);

  const handleReject = React.useCallback((options?: ToolRejectOptions) => {
    onReject?.(toolItem.id, options);
  }, [toolItem.id, onReject]);

  const handleExpand = React.useCallback(() => {
    onExpand?.(toolItem.id);
  }, [toolItem.id, onExpand]);

  const handleCapsuleExpandedChange = React.useCallback((expanded: boolean) => {
    applyExpandedState(capsuleExpanded, expanded, next => {
      if (onToolCapsuleExpandedChange) onToolCapsuleExpandedChange(capsuleKey, next);
      else setLocalExpanded(next);
    }, { onExpand: handleExpand });
  }, [applyExpandedState, capsuleExpanded, capsuleKey, handleExpand, onToolCapsuleExpandedChange]);

  const capsuleSummary = capsuleEligible ? getToolCapsuleSummary(effectiveToolItem, t) : undefined;
  const countLabel = capsuleSummary?.resultCount !== undefined ? formatNumber(capsuleSummary.resultCount) : undefined;
  const capsule = capsuleSummary ? {
    ...capsuleSummary,
    countLabel,
    description: countLabel === undefined ? capsuleSummary.description : `${capsuleSummary.description} · ${t('toolCapsule.resultCount', { value: countLabel })}`,
    status: effectiveToolItem.status,
    expanded: staticAgentWaitCapsule ? false : capsuleExpanded,
    onExpandedChange: handleCapsuleExpandedChange,
    fallbackContent: staticAgentWaitCapsule ? undefined : <ToolCapsuleRecord item={effectiveToolItem} />,
  } : undefined;

  if (!isToolCardVisible(effectiveToolItem)) return null;

  return (
    <div
      ref={cardRootRef}
      className={`flow-tool-card-wrapper ${permissionPending ? 'flow-tool-card-wrapper--permission-pending' : ''} ${className}`.trim()}
      data-openbitfun-component="flow-tool-card"
      data-openbitfun-part="root"
      data-openbitfun-state={permissionPending ? 'permission-pending' : undefined}
      data-thinking-handoff-priority={permissionPending || effectiveToolItem.status === 'error'
        || effectiveToolItem.toolResult?.success === false ? 'immediate' : undefined}
      data-testid={toolCardTestId}
      data-tool-name={effectiveToolItem.toolName}
      data-tool-card-id={toolItem.id}
      data-tool-capsule={capsuleEligible ? 'true' : undefined}
      data-capsule-expanded={capsuleEligible ? String(staticAgentWaitCapsule ? false : capsuleExpanded) : undefined}
      data-capsule-parallel={capsuleEligible && !staticAgentWaitCapsule && parallel ? 'true' : undefined}
      data-capsule-row={capsuleEligible && !staticAgentWaitCapsule && !capsuleExpanded && !interruptionNote && !['error', 'cancelled', 'rejected'].includes(effectiveToolItem.status) ? 'true' : undefined}
      data-openbitfun-attention={config.attention}
      data-openbitfun-presentation={config.presentation}
    >
      <FlowChatCardReaderProvider itemKey={capsuleKey}>
      <FlowToolCardErrorBoundary
        toolItem={effectiveToolItem}
        displayName={config.displayName}
        sessionId={sessionId}
      >
        <ToolCapsulePresentationProvider value={capsule}>
          <CardComponent
            toolItem={effectiveToolItem}
            config={config}
            interruptionNote={interruptionNote}
            onOpenInEditor={onOpenInEditor}
            onOpenInPanel={onOpenInPanel}
            onExpand={handleExpand}
            sessionId={sessionId}
            displayContext={displayContext}
            isLastItem={isLastItem}
          />
        </ToolCapsulePresentationProvider>
      </FlowToolCardErrorBoundary>
      <ToolApprovalBar
        toolItem={effectiveToolItem}
        onConfirm={handleConfirm}
        onReject={handleReject}
      />
      </FlowChatCardReaderProvider>
      {interruptionNote && !cardHandlesInterruptionNote && (
        <div
          className="flow-tool-card-note"
          data-openbitfun-component="flow-tool-card"
          data-openbitfun-part="note"
          role="note"
        >
          {interruptionNote}
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Compare streaming parameters and progress messages to avoid stale renders.
  const prevProgress = (prevProps.toolItem as any)._progressMessage;
  const nextProgress = (nextProps.toolItem as any)._progressMessage;
  const prevProgressLogs = (prevProps.toolItem as any)._progressLogs;
  const nextProgressLogs = (nextProps.toolItem as any)._progressLogs;
  
  return (
    prevProps.toolItem.id === nextProps.toolItem.id &&
    prevProps.toolItem.toolName === nextProps.toolItem.toolName &&
    prevProps.toolItem.toolCall === nextProps.toolItem.toolCall &&
    prevProps.sessionId === nextProps.sessionId &&
    prevProps.turnId === nextProps.turnId &&
    prevProps.className === nextProps.className &&
    prevProps.onConfirm === nextProps.onConfirm &&
    prevProps.onReject === nextProps.onReject &&
    prevProps.onOpenInEditor === nextProps.onOpenInEditor &&
    prevProps.onOpenInPanel === nextProps.onOpenInPanel &&
    prevProps.onExpand === nextProps.onExpand &&
    prevProps.toolItem.status === nextProps.toolItem.status &&
    prevProps.toolItem.interruptionReason === nextProps.toolItem.interruptionReason &&
    prevProps.toolItem.terminalSessionId === nextProps.toolItem.terminalSessionId &&
    prevProps.toolItem.userConfirmed === nextProps.toolItem.userConfirmed &&
    prevProps.toolItem.requiresConfirmation === nextProps.toolItem.requiresConfirmation &&
    prevProps.toolItem.acpPermission === nextProps.toolItem.acpPermission &&
    prevProps.toolItem.isParamsStreaming === nextProps.toolItem.isParamsStreaming &&
    prevProps.toolItem.subagentSessionId === nextProps.toolItem.subagentSessionId &&
    prevProps.toolItem.subagentDialogTurnId === nextProps.toolItem.subagentDialogTurnId &&
    prevProps.toolItem.subagentModelId === nextProps.toolItem.subagentModelId &&
    prevProps.toolItem.subagentModelDisplayName === nextProps.toolItem.subagentModelDisplayName &&
    prevProps.displayContext === nextProps.displayContext &&
    prevProps.isLastItem === nextProps.isLastItem &&
    prevProps.parallel === nextProps.parallel &&
    prevProgress === nextProgress &&
    prevProgressLogs === nextProgressLogs &&
    prevProps.toolItem.partialParams === nextProps.toolItem.partialParams &&
    prevProps.toolItem.toolResult === nextProps.toolItem.toolResult
  );
});
